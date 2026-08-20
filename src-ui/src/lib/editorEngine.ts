import type { Clip, EffectReturn, EqBand, TrackProject } from "../types"

interface LoadedTrack {
  buffer: AudioBuffer
  gainNode: GainNode
  eqNodes: BiquadFilterNode[]
  pannerNode: StereoPannerNode
  project: TrackProject
  activeSources: AudioBufferSourceNode[]
}

/** One Effect Return's live nodes: a shared delay line every sending
 * track's signal is summed into (Web Audio sums multiple connections into
 * one node automatically), feeding back into itself for repeats and out
 * through `wet` into the master bus - the live-preview equivalent of
 * `FeedbackDelay` in src-tauri/src/audio/recording.rs, built from native
 * nodes instead of an offline buffer pass. */
interface ReturnBus {
  delay: DelayNode
  feedback: GainNode
  wet: GainNode
}

const METRONOME_SCHEDULE_AHEAD_SEC = 0.15
const METRONOME_LOOKAHEAD_INTERVAL_MS = 50
const ANALYSER_FFT_SIZE = 512

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
  /** Every track's panner and every return bus's wet output converge here
   * before the master fader - the single point the "Input" VU meter taps,
   * mirroring how a real console's input meters read the summed bus before
   * the master fader rather than each channel individually. */
  private preMasterBus: GainNode
  private masterGain: GainNode
  private inputAnalyser: AnalyserNode
  private outputAnalyser: AnalyserNode
  private inputAnalyserBuf: Float32Array<ArrayBuffer>
  private outputAnalyserBuf: Float32Array<ArrayBuffer>
  private returns = new Map<string, ReturnBus>()
  /** trackId -> returnId -> that track's send-level GainNode into the
   * return's shared delay input. */
  private sendGains = new Map<string, Map<string, GainNode>>()
  private playing = false
  private anchorContextTime = 0
  private anchorFrame = 0

  private tempoBpm = 120
  private metronomeEnabled = false
  private metronomeTimer: number | null = null
  private nextClickBeatIndex = 0

  constructor(ctx: AudioContext, sampleRate: number) {
    this.ctx = ctx
    this.sampleRate = sampleRate

    this.preMasterBus = ctx.createGain()
    this.masterGain = ctx.createGain()
    this.preMasterBus.connect(this.masterGain)
    this.masterGain.connect(ctx.destination)

    this.inputAnalyser = ctx.createAnalyser()
    this.inputAnalyser.fftSize = ANALYSER_FFT_SIZE
    this.outputAnalyser = ctx.createAnalyser()
    this.outputAnalyser.fftSize = ANALYSER_FFT_SIZE
    this.preMasterBus.connect(this.inputAnalyser)
    this.masterGain.connect(this.outputAnalyser)
    this.inputAnalyserBuf = new Float32Array(this.inputAnalyser.fftSize)
    this.outputAnalyserBuf = new Float32Array(this.outputAnalyser.fftSize)
  }

  // --- Master bus: output fader + VU meters --------------------------

  setOutputGain(value: number): void {
    this.masterGain.gain.value = Math.max(0, value)
  }

  getOutputGain(): number {
    return this.masterGain.gain.value
  }

  /** Peak (0..1) of everything before the master fader - "Input" on the
   * Levels panel. */
  getInputPeak(): number {
    return this.readPeak(this.inputAnalyser, this.inputAnalyserBuf)
  }

  /** Peak (0..1) of the final mix after the master fader - "Output" on the
   * Levels panel and what actually reaches the speakers. */
  getOutputPeak(): number {
    return this.readPeak(this.outputAnalyser, this.outputAnalyserBuf)
  }

  private readPeak(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
    analyser.getFloatTimeDomainData(buf)
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      const abs = Math.abs(buf[i])
      if (abs > peak) peak = abs
    }
    return peak
  }

  // --- Effect Returns (aux send/return busses) ------------------------

  /** Reconciles the live return busses to match `effectReturns` - adds new
   * ones, updates existing ones' delay/feedback/mix/enabled, and tears
   * down any no longer present. Call whenever the project's return list
   * changes; per-return parameter tweaks can also call `upsertReturn`
   * directly via this same method (cheap - it's just node property writes
   * for an already-existing bus, not a graph rebuild). */
  syncReturns(effectReturns: EffectReturn[]): void {
    const activeIds = new Set(effectReturns.map((r) => r.id))
    for (const id of [...this.returns.keys()]) {
      if (!activeIds.has(id)) this.removeReturn(id)
    }
    for (const effectReturn of effectReturns) {
      this.upsertReturn(effectReturn)
    }
  }

  private upsertReturn(effectReturn: EffectReturn): void {
    let bus = this.returns.get(effectReturn.id)
    if (!bus) {
      const delay = this.ctx.createDelay(5.0)
      const feedback = this.ctx.createGain()
      const wet = this.ctx.createGain()
      delay.connect(feedback)
      feedback.connect(delay)
      delay.connect(wet)
      wet.connect(this.preMasterBus)
      bus = { delay, feedback, wet }
      this.returns.set(effectReturn.id, bus)
    }
    bus.delay.delayTime.value = Math.max(0, effectReturn.delay_ms) / 1000
    bus.feedback.gain.value = Math.min(0.95, Math.max(0, effectReturn.feedback))
    // Bypass via the wet gain rather than disconnecting: a disabled return
    // still exists as a valid send target (tracks keep their send-level
    // knob position), it just contributes silence until re-enabled.
    bus.wet.gain.value = effectReturn.enabled ? Math.min(1, Math.max(0, effectReturn.mix)) : 0
  }

  private removeReturn(id: string): void {
    const bus = this.returns.get(id)
    if (!bus) return
    bus.delay.disconnect()
    bus.feedback.disconnect()
    bus.wet.disconnect()
    this.returns.delete(id)
    for (const perTrack of this.sendGains.values()) {
      const g = perTrack.get(id)
      if (g) {
        g.disconnect()
        perTrack.delete(id)
      }
    }
  }

  /** Sets `trackId`'s send level (0..1) into `returnId`'s delay input,
   * creating the send's GainNode on first use. A no-op if the track or
   * return doesn't exist (e.g. called while a track is still loading). */
  setTrackSend(trackId: string, returnId: string, amount: number): void {
    const track = this.tracks.get(trackId)
    const bus = this.returns.get(returnId)
    if (!track || !bus) return

    let perTrack = this.sendGains.get(trackId)
    if (!perTrack) {
      perTrack = new Map()
      this.sendGains.set(trackId, perTrack)
    }
    let sendGain = perTrack.get(returnId)
    if (!sendGain) {
      sendGain = this.ctx.createGain()
      // Tapped post-pan (the end of the track's own processing chain,
      // mirroring the "post-gain, post-EQ" tap point render_mixdown's
      // Rust side sends from) rather than pre-fader - a muted/soloed-out
      // track's gain node already reads 0, so its send silences along
      // with its dry signal for free.
      track.pannerNode.connect(sendGain)
      sendGain.connect(bus.delay)
      perTrack.set(returnId, sendGain)
    }
    sendGain.gain.value = Math.min(1, Math.max(0, amount))
  }

  // --- Metronome --------------------------------------------------------

  setTempo(bpm: number): void {
    this.tempoBpm = Math.min(300, Math.max(20, bpm))
  }

  setMetronomeEnabled(enabled: boolean): void {
    this.metronomeEnabled = enabled
    this.restartMetronomeIfEnabled()
  }

  /** Always stop-then-start rather than a "start if not already running"
   * guard: `play()` calls this on every seek-while-playing too, and a stale
   * scheduler left over from before the seek would keep ticking against
   * the *old* anchor point, sounding clicks at the wrong position relative
   * to the new playhead. */
  private restartMetronomeIfEnabled(): void {
    this.stopMetronomeScheduler()
    if (this.metronomeEnabled && this.playing) {
      this.startMetronomeScheduler()
    }
  }

  private startMetronomeScheduler(): void {
    const beatDurationSec = 60 / this.tempoBpm
    const nowSec = this.currentFrame() / this.sampleRate
    this.nextClickBeatIndex = Math.ceil(nowSec / beatDurationSec)
    this.scheduleMetronomeTicks()
    this.metronomeTimer = window.setInterval(() => this.scheduleMetronomeTicks(), METRONOME_LOOKAHEAD_INTERVAL_MS)
  }

  private stopMetronomeScheduler(): void {
    if (this.metronomeTimer !== null) {
      window.clearInterval(this.metronomeTimer)
      this.metronomeTimer = null
    }
  }

  /** Standard Web Audio lookahead-scheduler pattern (see Chris Wilson's "A
   * Tale of Two Clocks"): a JS timer wakes up periodically, but every click
   * it schedules gets a precise AudioContext time via `osc.start(time)`,
   * so playback timing is sample-accurate regardless of JS timer jitter -
   * the timer only decides *when to schedule*, never *when to sound*. */
  private scheduleMetronomeTicks(): void {
    const beatDurationSec = 60 / this.tempoBpm
    const nowSec = this.currentFrame() / this.sampleRate
    const scheduleUntilSec = nowSec + METRONOME_SCHEDULE_AHEAD_SEC

    let idx = this.nextClickBeatIndex
    while (idx * beatDurationSec <= scheduleUntilSec) {
      const beatTimeSec = idx * beatDurationSec
      const contextTime = this.anchorContextTime + (beatTimeSec - this.anchorFrame / this.sampleRate)
      if (contextTime >= this.ctx.currentTime) {
        this.playClick(contextTime, idx % 4 === 0)
      }
      idx += 1
    }
    this.nextClickBeatIndex = idx
  }

  /** A short synthesized click - deliberately connected straight to
   * `ctx.destination`, bypassing the master fader/analysers entirely: a
   * metronome is a monitoring aid, not part of the mix, so it should
   * neither move the Output VU meter nor be affected by the Output fader. */
  private playClick(time: number, accent: boolean): void {
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.frequency.value = accent ? 1500 : 1000
    gain.gain.setValueAtTime(0.4, time)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    osc.connect(gain)
    gain.connect(this.ctx.destination)
    osc.start(time)
    osc.stop(time + 0.06)
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
    for (const [returnId, amount] of Object.entries(project.sends)) {
      this.setTrackSend(trackId, returnId, amount)
    }

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

    const perTrack = this.sendGains.get(trackId)
    if (perTrack) {
      for (const g of perTrack.values()) g.disconnect()
      this.sendGains.delete(trackId)
    }
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

    this.restartMetronomeIfEnabled()
  }

  pause(): void {
    this.anchorFrame = this.currentFrame()
    this.playing = false
    this.stopAllSources()
    this.stopMetronomeScheduler()
  }

  stop(): void {
    this.anchorFrame = 0
    this.playing = false
    this.stopAllSources()
    this.stopMetronomeScheduler()
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
    for (const id of [...this.returns.keys()]) {
      this.removeReturn(id)
    }
    this.preMasterBus.disconnect()
    this.masterGain.disconnect()
    this.inputAnalyser.disconnect()
    this.outputAnalyser.disconnect()
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
    panner.connect(this.preMasterBus)
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
