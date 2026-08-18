import type { Clip, EqBand, TrackProject } from "../types"

interface LoadedTrack {
  buffer: AudioBuffer
  gainNode: GainNode
  eqNodes: BiquadFilterNode[]
  pannerNode: StereoPannerNode
  project: TrackProject
  activeSources: AudioBufferSourceNode[]
}

/**
 * Web Audio-backed multitrack playback engine for the editor. Live
 * preview/scrub/mute/solo/gain/EQ all run here, entirely client-side -
 * the Rust backend is only ever invoked for the final destructive
 * "render mixdown" step (see recording::render_mixdown), which reruns the
 * same edit list offline with the app's real EQ/limiter DSP so the
 * exported file matches the app's own sound, not this preview's
 * approximation via native BiquadFilterNodes.
 *
 * Scheduling never tracks elapsed time manually: every `play()` re-anchors
 * to the AudioContext's own clock and creates fresh AudioBufferSourceNodes
 * for every clip overlapping the play point, since a source node can only
 * ever be started once. This is the standard Web Audio scheduling pattern
 * and avoids drift across pause/seek/loop.
 */
export class EditorEngine {
  private ctx: AudioContext
  private sampleRate: number
  private tracks = new Map<string, LoadedTrack>()
  private masterGain: GainNode
  private playing = false
  private anchorContextTime = 0
  private anchorFrame = 0

  constructor(ctx: AudioContext, sampleRate: number) {
    this.ctx = ctx
    this.sampleRate = sampleRate
    this.masterGain = ctx.createGain()
    this.masterGain.connect(ctx.destination)
  }

  loadTrack(trackId: string, buffer: AudioBuffer, project: TrackProject): void {
    const wasPlaying = this.playing
    const resumeFrame = this.currentFrame()
    this.unloadTrack(trackId)

    const gainNode = this.ctx.createGain()
    const pannerNode = this.ctx.createStereoPanner()
    pannerNode.pan.value = project.pan
    const eqNodes = project.eq_bands.map((band) => this.makeFilter(band))
    this.chain(gainNode, eqNodes, pannerNode)

    const track: LoadedTrack = { buffer, gainNode, eqNodes, pannerNode, project, activeSources: [] }
    this.tracks.set(trackId, track)
    this.applyGainNode(track)

    // A track loaded while already playing needs its own clips scheduled
    // immediately, not just on the next manual play() - re-anchoring here
    // covers both "first tracks loading in" and "one track added later".
    if (wasPlaying) {
      this.play(resumeFrame)
    }
  }

  unloadTrack(trackId: string): void {
    const existing = this.tracks.get(trackId)
    if (!existing) return
    this.stopTrackSources(existing)
    existing.gainNode.disconnect()
    for (const node of existing.eqNodes) node.disconnect()
    existing.pannerNode.disconnect()
    this.tracks.delete(trackId)
  }

  setTrackGain(trackId: string, gain: number): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.project = { ...track.project, gain }
    this.applyGainNode(track)
  }

  setTrackPan(trackId: string, pan: number): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.pannerNode.pan.value = pan
    track.project = { ...track.project, pan }
  }

  setTrackMuted(trackId: string, muted: boolean): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.project = { ...track.project, muted }
    this.applySoloAndMute()
  }

  setTrackSolo(trackId: string, solo: boolean): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.project = { ...track.project, solo }
    this.applySoloAndMute()
  }

  setTrackEq(trackId: string, bands: EqBand[]): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.gainNode.disconnect()
    for (const node of track.eqNodes) node.disconnect()
    const eqNodes = bands.map((band) => this.makeFilter(band))
    this.chain(track.gainNode, eqNodes, track.pannerNode)
    track.eqNodes = eqNodes
    track.project = { ...track.project, eq_bands: bands }
  }

  setClips(trackId: string, clips: Clip[]): void {
    const track = this.tracks.get(trackId)
    if (!track) return
    track.project = { ...track.project, clips }
    if (this.playing) {
      this.play(this.currentFrame())
    }
  }

  getProject(trackId: string): TrackProject | undefined {
    return this.tracks.get(trackId)?.project
  }

  currentFrame(): number {
    if (!this.playing) return this.anchorFrame
    const elapsedSeconds = this.ctx.currentTime - this.anchorContextTime
    return this.anchorFrame + Math.round(elapsedSeconds * this.sampleRate)
  }

  isPlaying(): boolean {
    return this.playing
  }

  play(fromFrame: number): void {
    this.stopAllSources()
    this.anchorFrame = Math.max(0, fromFrame)
    this.anchorContextTime = this.ctx.currentTime
    this.playing = true

    for (const track of this.tracks.values()) {
      for (const clip of track.project.clips) {
        const clipEndFrame = clip.timeline_start_frame + clip.length_frames
        if (clipEndFrame <= this.anchorFrame) continue

        const sourceOffsetFrames = Math.max(0, this.anchorFrame - clip.timeline_start_frame)
        const durationFrames = clip.length_frames - sourceOffsetFrames
        if (durationFrames <= 0) continue

        const startDelaySeconds = Math.max(0, (clip.timeline_start_frame - this.anchorFrame) / this.sampleRate)
        const sourceOffsetSeconds = (clip.source_start_frame + sourceOffsetFrames) / this.sampleRate
        const durationSeconds = durationFrames / this.sampleRate

        const node = this.ctx.createBufferSource()
        node.buffer = track.buffer
        node.connect(track.gainNode)
        node.start(this.anchorContextTime + startDelaySeconds, sourceOffsetSeconds, durationSeconds)
        track.activeSources.push(node)
      }
    }
  }

  pause(): void {
    this.anchorFrame = this.currentFrame()
    this.playing = false
    this.stopAllSources()
  }

  stop(): void {
    this.anchorFrame = 0
    this.playing = false
    this.stopAllSources()
  }

  seek(frame: number): void {
    if (this.playing) {
      this.play(frame)
    } else {
      this.anchorFrame = Math.max(0, frame)
    }
  }

  dispose(): void {
    this.stop()
    for (const trackId of [...this.tracks.keys()]) {
      this.unloadTrack(trackId)
    }
    this.masterGain.disconnect()
  }

  private makeFilter(band: EqBand): BiquadFilterNode {
    const filter = this.ctx.createBiquadFilter()
    filter.type = "peaking"
    filter.frequency.value = band.freq_hz
    filter.gain.value = band.gain_db
    filter.Q.value = band.q
    return filter
  }

  private chain(from: AudioNode, eqNodes: BiquadFilterNode[], panner: StereoPannerNode): void {
    let last: AudioNode = from
    for (const node of eqNodes) {
      last.connect(node)
      last = node
    }
    last.connect(panner)
    panner.connect(this.masterGain)
  }

  private applyGainNode(track: LoadedTrack): void {
    const anySolo = [...this.tracks.values()].some((t) => t.project.solo)
    const effectiveMuted = track.project.muted || (anySolo && !track.project.solo)
    track.gainNode.gain.value = effectiveMuted ? 0 : track.project.gain
  }

  private applySoloAndMute(): void {
    for (const track of this.tracks.values()) {
      this.applyGainNode(track)
    }
  }

  private stopTrackSources(track: LoadedTrack): void {
    for (const src of track.activeSources) {
      try {
        src.stop()
      } catch {
        // Already stopped/ended - fine to ignore.
      }
    }
    track.activeSources = []
  }

  private stopAllSources(): void {
    for (const track of this.tracks.values()) {
      this.stopTrackSources(track)
    }
  }
}
