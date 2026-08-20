import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { convertFileSrc } from "@tauri-apps/api/core"
import { EditorEngine } from "../../lib/editorEngine"
import { bucketFramesForZoom, computePeaks, type PeakData } from "../../lib/waveform"
import { colorForTrack } from "../../lib/trackColors"
import type { Clip, EffectReturn, EqBand, RecordingManifest, RecordingProject, TrackProject } from "../../types"
import { TransportBar } from "./TransportBar"
import { TrackLane } from "./TrackLane"
import { EffectsRack } from "./EffectsRack"
import { MixerView } from "./MixerView"
import { LevelsPanel } from "./LevelsPanel"
import { TempoSyncPanel } from "./TempoSyncPanel"
import { EffectReturnsPanel } from "./EffectReturnsPanel"
import { TimelineRuler } from "./TimelineRuler"
import "./EditorPage.css"

/** How far ahead of the playhead to keep scrolled into view before nudging
 * the viewport forward again - re-centering on every single frame update
 * would make the timeline visibly judder during playback, so this only
 * scrolls once the playhead gets within this many pixels of the right
 * edge, then jumps it back out to FOLLOW_TARGET_RATIO. */
const FOLLOW_EDGE_MARGIN_PX = 60
/** Where across the visible width to park the playhead each time
 * follow-scroll does act - just left of center reads as "the played
 * material trails behind, upcoming material is still visible ahead". */
const FOLLOW_TARGET_RATIO = 0.35

let nextReturnSuffix = 1
function newReturnId(): string {
  nextReturnSuffix += 1
  return `return-${Date.now()}-${nextReturnSuffix}`
}

interface EditorPageProps {
  sessionId: string
  onExit: () => void
}

type EditorTab = "main" | "mixer"

interface LoadedTrackData {
  buffer: AudioBuffer
  durationFrames: number
}

function formatTime(frame: number, sampleRate: number): string {
  const totalSeconds = Math.max(0, frame / sampleRate)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const tenths = Math.floor((totalSeconds % 1) * 10)
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`
}

/**
 * Full-page multitrack editor for one recording session. Loads every
 * track's WAV once via the asset protocol, decodes it, and drives a
 * shared EditorEngine for live preview - Rust is only called again for
 * saving the edit list and for the final render_mixdown export.
 */
export function EditorPage({ sessionId, onExit }: EditorPageProps) {
  const [manifest, setManifest] = useState<RecordingManifest | null>(null)
  const [project, setProject] = useState<RecordingProject | null>(null)
  const [loadedTracks, setLoadedTracks] = useState<Map<string, LoadedTrackData>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<EditorTab>("main")
  const [playing, setPlaying] = useState(false)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [zoom, setZoom] = useState(80)
  const [selectedClipByTrack, setSelectedClipByTrack] = useState<Record<string, string | null>>({})
  const [openFxTrackId, setOpenFxTrackId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exportingTrackId, setExportingTrackId] = useState<string | null>(null)
  const [inputPeak, setInputPeak] = useState(0)
  const [outputPeak, setOutputPeak] = useState(0)
  const [outputGain, setOutputGainState] = useState(1)
  // Whether the click plays during preview - deliberately not part of the
  // saved project: it's a monitoring preference for this editing session,
  // not a fact about the recording, the same way a DAW's metronome on/off
  // is usually a global toggle rather than per-project data.
  const [metronomeEnabled, setMetronomeEnabled] = useState(false)
  // On by default: a fresh edit session should track playback without the
  // user having to discover the toggle first. Turning it off is for
  // deliberately scrubbing/inspecting elsewhere in the timeline while
  // something plays, without the view yanking back every few seconds.
  const [followPlayhead, setFollowPlayhead] = useState(true)

  const ctxRef = useRef<AudioContext | null>(null)
  const engineRef = useRef<EditorEngine | null>(null)
  const animationRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [loadedManifest, loadedProject] = await Promise.all([
          invoke<RecordingManifest>("get_recording_manifest", { sessionId }),
          invoke<RecordingProject>("load_recording_project", { sessionId }),
        ])
        if (cancelled) return

        const sampleRate = loadedManifest.tracks[0]?.sample_rate ?? 48000
        const audioCtx = new AudioContext({ sampleRate })
        const engine = new EditorEngine(audioCtx, sampleRate)
        ctxRef.current = audioCtx
        engineRef.current = engine

        // Return busses must exist before any track tries to wire a send
        // into one - loadTrack (below) reads each track's `sends` map and
        // silently no-ops on a send whose target bus doesn't exist yet.
        engine.syncReturns(loadedProject.effect_returns)
        engine.setTempo(loadedProject.tempo_bpm)
        engine.setOutputGain(outputGain)

        const nextLoaded = new Map<string, LoadedTrackData>()
        for (const trackManifest of loadedManifest.tracks) {
          const absolutePath = await invoke<string>("recording_file_path", {
            sessionId,
            relativeFile: trackManifest.file,
          })
          const response = await fetch(convertFileSrc(absolutePath))
          if (!response.ok) {
            throw new Error(`Failed to load "${trackManifest.file}" (${response.status})`)
          }
          const arrayBuffer = await response.arrayBuffer()
          const buffer = await audioCtx.decodeAudioData(arrayBuffer)
          if (cancelled) return

          const trackProject = loadedProject.tracks.find((t) => t.source_id === trackManifest.source_id)
          if (trackProject) engine.loadTrack(trackManifest.source_id, buffer, trackProject)

          nextLoaded.set(trackManifest.source_id, { buffer, durationFrames: buffer.length })
        }

        if (cancelled) return
        setManifest(loadedManifest)
        setProject(loadedProject)
        setLoadedTracks(nextLoaded)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
      engineRef.current?.dispose()
      ctxRef.current?.close()
    }
    // Loads once for this session id - App.tsx only ever swaps sessions
    // via a full exit/re-entry, never in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const sampleRate = manifest?.tracks[0]?.sample_rate ?? 48000

  const peaksByTrack = useMemo(() => {
    const map = new Map<string, PeakData>()
    for (const [id, data] of loadedTracks) {
      map.set(id, computePeaks(data.buffer, bucketFramesForZoom(data.buffer.sampleRate, zoom)))
    }
    return map
  }, [loadedTracks, zoom])

  const totalFrames = useMemo(() => {
    if (!project) return 0
    let max = 0
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        max = Math.max(max, clip.timeline_start_frame + clip.length_frames)
      }
    }
    return max
  }, [project])

  /** Scrolls the shared timeline viewport (see .editor-tracks) so `frame`
   * is visible, either only once it's about to run off the right edge
   * (the default, continuous-follow behavior during playback) or
   * unconditionally (`force: true`, for an explicit seek action - clicking
   * the ruler, typing a position - which should always jump the view
   * immediately regardless of the Follow Playhead toggle). */
  const scrollToPlayhead = useCallback(
    (frame: number, options?: { force?: boolean }) => {
      const container = scrollRef.current
      if (!container) return
      const playheadX = (frame / sampleRate) * zoom
      const viewLeft = container.scrollLeft
      const viewWidth = container.clientWidth
      const viewRight = viewLeft + viewWidth
      const needsScroll = options?.force || playheadX < viewLeft || playheadX > viewRight - FOLLOW_EDGE_MARGIN_PX
      if (!needsScroll) return
      container.scrollLeft = Math.max(0, playheadX - viewWidth * FOLLOW_TARGET_RATIO)
    },
    [sampleRate, zoom]
  )

  const drawLoop = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const frame = engine.currentFrame()
    setInputPeak(engine.getInputPeak())
    setOutputPeak(engine.getOutputPeak())
    // The engine's clock keeps advancing for as long as playback has been
    // running, with no notion of "the arrangement ended" - once the
    // playhead reaches the last frame of actual content, park it there
    // and stop, instead of letting it run on into empty space past every
    // clip's end.
    if (totalFrames > 0 && frame >= totalFrames) {
      engine.pause()
      engine.seek(totalFrames)
      setPlaying(false)
      setPlayheadFrame(totalFrames)
      setInputPeak(0)
      setOutputPeak(0)
      return
    }
    setPlayheadFrame(frame)
    if (followPlayhead) scrollToPlayhead(frame)
    if (engine.isPlaying()) {
      animationRef.current = requestAnimationFrame(drawLoop)
    }
  }, [totalFrames, followPlayhead, scrollToPlayhead])

  const handlePlayPause = () => {
    const engine = engineRef.current
    if (!engine) return
    if (engine.isPlaying()) {
      engine.pause()
      setPlaying(false)
      setInputPeak(0)
      setOutputPeak(0)
    } else {
      const from = engine.currentFrame() >= totalFrames ? 0 : engine.currentFrame()
      engine.play(from)
      setPlaying(true)
      animationRef.current = requestAnimationFrame(drawLoop)
    }
  }

  const handleStop = () => {
    engineRef.current?.stop()
    setPlaying(false)
    setPlayheadFrame(0)
    setInputPeak(0)
    setOutputPeak(0)
  }

  const handleSeek = (frame: number) => {
    const clamped = Math.min(Math.max(0, frame), totalFrames)
    engineRef.current?.seek(clamped)
    setPlayheadFrame(clamped)
    scrollToPlayhead(clamped, { force: true })
  }

  /** "Start from" - jump to an exact position typed as seconds, the manual
   * counterpart to clicking somewhere on the ruler or a waveform. */
  const handleManualSeekSeconds = (seconds: number) => {
    handleSeek(Math.round(Math.max(0, seconds) * sampleRate))
  }

  const updateTrack = (sourceId: string, patch: Partial<TrackProject>) => {
    setProject((current) => {
      if (!current) return current
      return { ...current, tracks: current.tracks.map((t) => (t.source_id === sourceId ? { ...t, ...patch } : t)) }
    })
    setDirty(true)
  }

  const handleClipsChange = (sourceId: string, clips: Clip[]) => {
    updateTrack(sourceId, { clips })
    engineRef.current?.setClips(sourceId, clips)
  }

  const handleGainChange = (sourceId: string, gain: number) => {
    updateTrack(sourceId, { gain })
    engineRef.current?.setTrackGain(sourceId, gain)
  }

  const handlePanChange = (sourceId: string, pan: number) => {
    updateTrack(sourceId, { pan })
    engineRef.current?.setTrackPan(sourceId, pan)
  }

  const handleSendChange = (sourceId: string, returnId: string, amount: number) => {
    setProject((current) => {
      if (!current) return current
      return {
        ...current,
        tracks: current.tracks.map((t) =>
          t.source_id === sourceId ? { ...t, sends: { ...t.sends, [returnId]: amount } } : t
        ),
      }
    })
    setDirty(true)
    engineRef.current?.setTrackSend(sourceId, returnId, amount)
  }

  const handleOutputGainChange = (value: number) => {
    setOutputGainState(value)
    engineRef.current?.setOutputGain(value)
  }

  const handleTempoChange = (bpm: number) => {
    const clamped = Math.min(300, Math.max(20, bpm))
    setProject((current) => (current ? { ...current, tempo_bpm: clamped } : current))
    setDirty(true)
    engineRef.current?.setTempo(clamped)
  }

  const handleMetronomeToggle = (enabled: boolean) => {
    setMetronomeEnabled(enabled)
    engineRef.current?.setMetronomeEnabled(enabled)
  }

  // All three return-list mutators compute the next `effect_returns` array
  // *inside* the setProject updater (capturing it into an outer variable)
  // rather than reading the `project` closure directly, so the engine sync
  // below is never based on a stale snapshot even if calls land in the
  // same tick.
  const handleAddReturn = () => {
    let nextReturns: EffectReturn[] = []
    setProject((current) => {
      if (!current) return current
      const newReturn: EffectReturn = {
        id: newReturnId(),
        name: `Delay ${current.effect_returns.length + 1}`,
        enabled: true,
        delay_ms: 350,
        feedback: 0.35,
        mix: 0.3,
      }
      nextReturns = [...current.effect_returns, newReturn]
      return { ...current, effect_returns: nextReturns }
    })
    setDirty(true)
    engineRef.current?.syncReturns(nextReturns)
  }

  const handleUpdateReturn = (id: string, patch: Partial<EffectReturn>) => {
    let nextReturns: EffectReturn[] = []
    setProject((current) => {
      if (!current) return current
      nextReturns = current.effect_returns.map((r) => (r.id === id ? { ...r, ...patch } : r))
      return { ...current, effect_returns: nextReturns }
    })
    setDirty(true)
    engineRef.current?.syncReturns(nextReturns)
  }

  const handleRemoveReturn = (id: string) => {
    let nextReturns: EffectReturn[] = []
    setProject((current) => {
      if (!current) return current
      nextReturns = current.effect_returns.filter((r) => r.id !== id)
      // A track's `sends` entry for a now-deleted return is just an inert
      // orphaned key at that point (syncReturns below tears down the live
      // send node and MixerView never renders a knob for a return that
      // isn't in `effect_returns`) - left as-is rather than scrubbed from
      // every track, since it costs nothing and a deleted return's id is
      // never reused (newReturnId always mints a fresh one).
      return { ...current, effect_returns: nextReturns }
    })
    setDirty(true)
    engineRef.current?.syncReturns(nextReturns)
  }

  const toggleFx = (sourceId: string) => {
    setOpenFxTrackId((current) => (current === sourceId ? null : sourceId))
  }

  const handleMuteToggle = (sourceId: string) => {
    const track = project?.tracks.find((t) => t.source_id === sourceId)
    if (!track) return
    updateTrack(sourceId, { muted: !track.muted })
    engineRef.current?.setTrackMuted(sourceId, !track.muted)
  }

  const handleSoloToggle = (sourceId: string) => {
    const track = project?.tracks.find((t) => t.source_id === sourceId)
    if (!track) return
    updateTrack(sourceId, { solo: !track.solo })
    engineRef.current?.setTrackSolo(sourceId, !track.solo)
  }

  const handleEqChange = (sourceId: string, bands: EqBand[]) => {
    updateTrack(sourceId, { eq_bands: bands })
    engineRef.current?.setTrackEq(sourceId, bands)
  }

  const handleSplit = (sourceId: string) => {
    const track = project?.tracks.find((t) => t.source_id === sourceId)
    if (!track) return
    const clip = track.clips.find(
      (c) => playheadFrame > c.timeline_start_frame && playheadFrame < c.timeline_start_frame + c.length_frames
    )
    if (!clip) return
    const offset = playheadFrame - clip.timeline_start_frame
    const first: Clip = { ...clip, length_frames: offset }
    const second: Clip = {
      ...clip,
      id: `${clip.id}-split-${Date.now()}`,
      source_start_frame: clip.source_start_frame + offset,
      length_frames: clip.length_frames - offset,
      timeline_start_frame: clip.timeline_start_frame + offset,
    }
    handleClipsChange(
      sourceId,
      track.clips.flatMap((c) => (c.id === clip.id ? [first, second] : [c]))
    )
  }

  const handleDeleteSelectedClip = (sourceId: string) => {
    const track = project?.tracks.find((t) => t.source_id === sourceId)
    const selectedId = selectedClipByTrack[sourceId]
    if (!track || !selectedId) return
    handleClipsChange(sourceId, track.clips.filter((c) => c.id !== selectedId))
    setSelectedClipByTrack((current) => ({ ...current, [sourceId]: null }))
  }

  const handleSave = async () => {
    if (!project) return
    setSaving(true)
    setError(null)
    try {
      await invoke("save_recording_project", { sessionId, project })
      setDirty(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    if (!project) return
    setExporting(true)
    setError(null)
    setExportMessage(null)
    try {
      if (dirty) {
        await invoke("save_recording_project", { sessionId, project })
        setDirty(false)
      }
      const outputName = await invoke<string>("render_mixdown", {
        sessionId,
        project,
        outputName: manifest?.name ?? "mixdown",
      })
      setExportMessage(`Exported to mixdown/${outputName}`)
    } catch (err) {
      setError(String(err))
    } finally {
      setExporting(false)
    }
  }

  /** "Save Track" - exports just one track's own edit list (clips, gain,
   * pan, EQ) to its own WAV, ignoring mute/solo and Effect Return sends
   * (see recording::render_track's doc comment) - a clean single stem,
   * not a preview of what the current mix sounds like. */
  const handleExportTrack = async (sourceId: string) => {
    if (!project) return
    setExportingTrackId(sourceId)
    setError(null)
    setExportMessage(null)
    try {
      if (dirty) {
        await invoke("save_recording_project", { sessionId, project })
        setDirty(false)
      }
      const outputName = await invoke<string>("render_track_export", {
        sessionId,
        project,
        trackSourceId: sourceId,
        outputName: sourceId,
      })
      setExportMessage(`Saved track to mixdown/${outputName}`)
    } catch (err) {
      setError(String(err))
    } finally {
      setExportingTrackId(null)
    }
  }

  if (loading) {
    return (
      <div className="editor-page">
        <p className="routing-empty">Loading session…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="editor-page">
        <div className="error-banner">{error}</div>
        <button className="btn btn-secondary" onClick={onExit}>
          Back to Recordings
        </button>
      </div>
    )
  }

  return (
    <div className="editor-page">
      <TransportBar
        playing={playing}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        positionLabel={`${formatTime(playheadFrame, sampleRate)} / ${formatTime(totalFrames, sampleRate)}`}
        zoom={zoom}
        onZoomChange={setZoom}
        saving={saving}
        exporting={exporting}
        dirty={dirty}
        onSave={handleSave}
        onExport={handleExport}
        onExit={onExit}
        onManualSeekSeconds={handleManualSeekSeconds}
        followPlayhead={followPlayhead}
        onToggleFollowPlayhead={() => setFollowPlayhead((v) => !v)}
      />

      <div className="console-row">
        <LevelsPanel
          inputPeak={inputPeak}
          outputPeak={outputPeak}
          outputGain={outputGain}
          onOutputGainChange={handleOutputGainChange}
        />
        <TempoSyncPanel
          tempoBpm={project?.tempo_bpm ?? 120}
          metronomeEnabled={metronomeEnabled}
          onTempoChange={handleTempoChange}
          onMetronomeToggle={handleMetronomeToggle}
        />
        <EffectReturnsPanel
          returns={project?.effect_returns ?? []}
          onAdd={handleAddReturn}
          onUpdate={handleUpdateReturn}
          onRemove={handleRemoveReturn}
        />
      </div>

      <nav className="editor-tabs">
        <button className={activeTab === "main" ? "active" : ""} onClick={() => setActiveTab("main")}>
          Main
        </button>
        <button className={activeTab === "mixer" ? "active" : ""} onClick={() => setActiveTab("mixer")}>
          Mixer
        </button>
      </nav>

      {exportMessage && <div className="editor-export-message">{exportMessage}</div>}

      {activeTab === "main" && (
        <div className="editor-tracks" ref={scrollRef}>
          <TimelineRuler
            durationFrames={totalFrames}
            sampleRate={sampleRate}
            pixelsPerSecond={zoom}
            playheadFrame={playheadFrame}
            onSeek={handleSeek}
          />
          {project?.tracks.map((track) => {
            const loaded = loadedTracks.get(track.source_id)
            const peaks = peaksByTrack.get(track.source_id)
            if (!loaded || !peaks) return null
            return (
              <div key={track.source_id} className="editor-track-row">
                <TrackLane
                  label={track.source_id}
                  color={colorForTrack(track.source_id)}
                  track={track}
                  peaks={peaks}
                  sourceDurationFrames={loaded.durationFrames}
                  timelineDurationFrames={totalFrames}
                  sampleRate={sampleRate}
                  pixelsPerSecond={zoom}
                  playheadFrame={playheadFrame}
                  selectedClipId={selectedClipByTrack[track.source_id] ?? null}
                  fxOpen={openFxTrackId === track.source_id}
                  onSelectClip={(clipId) =>
                    setSelectedClipByTrack((current) => ({ ...current, [track.source_id]: clipId }))
                  }
                  onSeek={handleSeek}
                  onClipsChange={(clips) => handleClipsChange(track.source_id, clips)}
                  onGainChange={(gain) => handleGainChange(track.source_id, gain)}
                  onMuteToggle={() => handleMuteToggle(track.source_id)}
                  onSoloToggle={() => handleSoloToggle(track.source_id)}
                  onSplit={() => handleSplit(track.source_id)}
                  onDeleteSelectedClip={() => handleDeleteSelectedClip(track.source_id)}
                  onOpenFx={() => toggleFx(track.source_id)}
                  onExportTrack={() => handleExportTrack(track.source_id)}
                  exporting={exportingTrackId === track.source_id}
                />
                {openFxTrackId === track.source_id && (
                  <EffectsRack
                    bands={track.eq_bands}
                    onChange={(bands) => handleEqChange(track.source_id, bands)}
                    onClose={() => setOpenFxTrackId(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {activeTab === "mixer" && (
        <MixerView
          tracks={project?.tracks ?? []}
          returns={project?.effect_returns ?? []}
          onGainChange={handleGainChange}
          onPanChange={handlePanChange}
          onMuteToggle={handleMuteToggle}
          onSoloToggle={handleSoloToggle}
          onEqChange={handleEqChange}
          onSendChange={handleSendChange}
          openFxTrackId={openFxTrackId}
          onToggleFx={toggleFx}
          onExportTrack={handleExportTrack}
          exportingTrackId={exportingTrackId}
        />
      )}
    </div>
  )
}
