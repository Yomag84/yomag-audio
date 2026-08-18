import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { convertFileSrc } from "@tauri-apps/api/core"
import { EditorEngine } from "../lib/editorEngine"
import { bucketFramesForZoom, combinePeaks, computePeaks, drawWaveform, type PeakData } from "../lib/waveform"
import type { RecordingManifest, RecordingProject, RecordingSummary } from "../types"
import { formatDuration } from "./RecordingsPanel"
import "./RecordingDetailModal.css"

interface RecordingDetailModalProps {
  session: RecordingSummary
  onClose: () => void
  onRename: (sessionId: string, name: string) => void
  onDelete: (sessionId: string) => void
  onOpenEditor: (sessionId: string) => void
}

async function loadTrackBuffer(ctx: AudioContext, sessionId: string, relativeFile: string): Promise<AudioBuffer> {
  const absolutePath = await invoke<string>("recording_file_path", { sessionId, relativeFile })
  const response = await fetch(convertFileSrc(absolutePath))
  if (!response.ok) {
    throw new Error(`Failed to load "${relativeFile}" (${response.status})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return ctx.decodeAudioData(arrayBuffer)
}

export function RecordingDetailModal({ session, onClose, onRename, onDelete, onOpenEditor }: RecordingDetailModalProps) {
  const [manifest, setManifest] = useState<RecordingManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [editingName, setEditingName] = useState(session.name)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const engineRef = useRef<EditorEngine | null>(null)
  const peaksRef = useRef<PeakData | null>(null)
  const animationRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [loadedManifest, project] = await Promise.all([
          invoke<RecordingManifest>("get_recording_manifest", { sessionId: session.session_id }),
          invoke<RecordingProject>("load_recording_project", { sessionId: session.session_id }),
        ])
        if (cancelled) return

        const audioCtx = new AudioContext({ sampleRate: loadedManifest.tracks[0]?.sample_rate ?? 48000 })
        const engine = new EditorEngine(audioCtx, audioCtx.sampleRate)
        ctxRef.current = audioCtx
        engineRef.current = engine

        const allPeaks: PeakData[] = []
        let longest = 0
        for (const track of loadedManifest.tracks) {
          const buffer = await loadTrackBuffer(audioCtx, session.session_id, track.file)
          if (cancelled) return
          const trackProject = project.tracks.find((t) => t.source_id === track.source_id)
          if (trackProject) engine.loadTrack(track.source_id, buffer, trackProject)
          longest = Math.max(longest, buffer.length)
          allPeaks.push(computePeaks(buffer, bucketFramesForZoom(buffer.sampleRate, 60)))
        }

        if (cancelled) return
        peaksRef.current = allPeaks.length > 0 ? combinePeaks(allPeaks) : null
        setTotalFrames(longest)
        setManifest(loadedManifest)
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
    // Runs once per mounted modal instance (keyed by session.session_id at
    // the call site) - reloading tracks on every render would tear down
    // and rebuild the whole audio graph for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const drawFrame = () => {
    const canvas = canvasRef.current
    const peaks = peaksRef.current
    const engine = engineRef.current
    if (!canvas || !peaks || !engine) return
    const ctx2d = canvas.getContext("2d")
    if (!ctx2d) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    // Canvas can't resolve CSS custom properties directly, so read the
    // already-computed value - this keeps the waveform color in sync
    // with the light/dark theme's --accent2 token instead of hardcoding it.
    const accent2 = getComputedStyle(canvas).getPropertyValue("--accent2").trim() || "#0f9b8e"
    drawWaveform(ctx2d, peaks, width, height, accent2)

    const rawFrame = engine.currentFrame()
    // Same fix as the multitrack editor: the engine's clock has no notion
    // of "the recording ended", so without this the playhead keeps
    // advancing past the last real frame of audio instead of stopping there.
    const pastEnd = totalFrames > 0 && rawFrame >= totalFrames
    const frame = pastEnd ? totalFrames : rawFrame
    setPlayheadFrame(frame)
    if (totalFrames > 0) {
      const x = Math.min(width, (frame / totalFrames) * width)
      ctx2d.strokeStyle = "rgba(255,255,255,0.7)"
      ctx2d.lineWidth = 1
      ctx2d.beginPath()
      ctx2d.moveTo(x, 0)
      ctx2d.lineTo(x, height)
      ctx2d.stroke()
    }

    if (pastEnd) {
      engine.pause()
      engine.seek(totalFrames)
      setPlaying(false)
      return
    }

    if (engine.isPlaying()) {
      animationRef.current = requestAnimationFrame(drawFrame)
    }
  }

  useEffect(() => {
    drawFrame()
    // Redraw once tracks finish loading, and again on manual seeks - the
    // rAF loop above (started from handlePlayPause) covers the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, playheadFrame])

  const handlePlayPause = () => {
    const engine = engineRef.current
    if (!engine) return
    if (engine.isPlaying()) {
      engine.pause()
      setPlaying(false)
    } else {
      // Loop back to the start once playback has run off the end.
      const from = engine.currentFrame() >= totalFrames ? 0 : engine.currentFrame()
      engine.play(from)
      setPlaying(true)
      animationRef.current = requestAnimationFrame(drawFrame)
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current
    const canvas = canvasRef.current
    if (!engine || !canvas || totalFrames === 0) return
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    engine.seek(Math.round(ratio * totalFrames))
    setPlayheadFrame(engine.currentFrame())
    drawFrame()
  }

  const trackCount = manifest?.tracks.length ?? session.track_count

  const timeLabel = useMemo(() => {
    if (totalFrames === 0 || !manifest) return null
    const sampleRate = manifest.tracks[0]?.sample_rate ?? 48000
    return `${formatDuration((playheadFrame / sampleRate) * 1000)} / ${formatDuration(session.duration_ms)}`
  }, [playheadFrame, totalFrames, manifest, session.duration_ms])

  return (
    <div className="recording-detail-overlay" onClick={onClose}>
      <div className="recording-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <input
            className="recording-detail-name"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => {
              if (editingName.trim() && editingName !== session.name) {
                onRename(session.session_id, editingName.trim())
              }
            }}
          />
          <button className="chip-remove" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="recording-detail-meta">
          {session.device_name} · {trackCount} track{trackCount === 1 ? "" : "s"} ·{" "}
          {new Date(session.created_at_ms).toLocaleString()}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {loading && !error && <p className="routing-empty">Loading tracks…</p>}

        {!loading && !error && (
          <>
            <canvas className="recording-detail-canvas" ref={canvasRef} onClick={handleSeek} />
            <div className="recording-detail-transport">
              <button className="btn btn-primary" onClick={handlePlayPause}>
                {playing ? "Pause" : "Play"}
              </button>
              <span className="recording-detail-time">{timeLabel}</span>
            </div>
          </>
        )}

        <div className="recording-detail-actions">
          <button className="btn btn-secondary" onClick={() => onDelete(session.session_id)}>
            Delete
          </button>
          <button className="btn btn-primary" onClick={() => onOpenEditor(session.session_id)}>
            Open in Editor
          </button>
        </div>
      </div>
    </div>
  )
}
