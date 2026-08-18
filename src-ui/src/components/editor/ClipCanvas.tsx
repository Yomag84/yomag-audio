import { useEffect, useRef } from "react"
import type { Clip } from "../../types"
import { drawWaveform, type PeakData } from "../../lib/waveform"

interface ClipCanvasProps {
  clips: Clip[]
  peaks: PeakData
  sourceDurationFrames: number
  sampleRate: number
  pixelsPerSecond: number
  playheadFrame: number
  selectedClipId: string | null
  color: string
  onClipsChange: (clips: Clip[]) => void
  onSelectClip: (clipId: string | null) => void
  onSeek: (frame: number) => void
}

type DragMode = "move" | "trim-left" | "trim-right"

interface DragState {
  mode: DragMode
  clipId: string
  startX: number
  startClip: Clip
}

const EDGE_HIT_PX = 6

/** Slices a peaks array down to just the [startFrame, startFrame+lengthFrames) range, in its own bucket space. */
function slicePeaks(peaks: PeakData, startFrame: number, lengthFrames: number): PeakData {
  const startBucket = Math.max(0, Math.floor(startFrame / peaks.bucketFrames))
  const endBucket = Math.max(startBucket + 1, Math.ceil((startFrame + lengthFrames) / peaks.bucketFrames))
  return {
    min: peaks.min.slice(startBucket, endBucket),
    max: peaks.max.slice(startBucket, endBucket),
    bucketFrames: peaks.bucketFrames,
  }
}

/**
 * One track's clip timeline: renders each clip's waveform slice at its
 * timeline position and handles click-to-seek, click-to-select, drag body
 * to move, and drag an edge (within EDGE_HIT_PX) to trim. All edits are
 * expressed as a brand-new `Clip[]` handed to `onClipsChange` - this
 * component never mutates a clip in place, matching EditorPage's
 * "Clip[] is the single source of truth" rule.
 */
export function ClipCanvas({
  clips,
  peaks,
  sourceDurationFrames,
  sampleRate,
  pixelsPerSecond,
  playheadFrame,
  selectedClipId,
  color,
  onClipsChange,
  onSelectClip,
  onSeek,
}: ClipCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)

  const framesPerPixel = sampleRate / pixelsPerSecond
  const frameToX = (frame: number) => frame / framesPerPixel
  const xToFrame = (x: number) => Math.max(0, Math.round(x * framesPerPixel))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    ctx.clearRect(0, 0, width, height)

    for (const clip of clips) {
      const x0 = frameToX(clip.timeline_start_frame)
      const w = Math.max(1, frameToX(clip.length_frames))
      const slice = slicePeaks(peaks, clip.source_start_frame, clip.length_frames)

      ctx.save()
      ctx.translate(x0, 0)
      drawWaveform(ctx, slice, w, height, color)
      ctx.restore()

      ctx.strokeStyle = clip.id === selectedClipId ? "#ffffff" : "rgba(255,255,255,0.35)"
      ctx.lineWidth = clip.id === selectedClipId ? 2 : 1
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, w - 1), height - 1)
    }

    const playheadX = frameToX(playheadFrame)
    ctx.strokeStyle = "rgba(255,255,255,0.85)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(playheadX, 0)
    ctx.lineTo(playheadX, height)
    ctx.stroke()
  }, [clips, peaks, playheadFrame, selectedClipId, pixelsPerSecond, sampleRate, color])

  const hitTest = (x: number): { clip: Clip; mode: DragMode } | null => {
    for (const clip of clips) {
      const x0 = frameToX(clip.timeline_start_frame)
      const x1 = x0 + frameToX(clip.length_frames)
      if (x < x0 - EDGE_HIT_PX || x > x1 + EDGE_HIT_PX) continue
      if (Math.abs(x - x0) <= EDGE_HIT_PX) return { clip, mode: "trim-left" }
      if (Math.abs(x - x1) <= EDGE_HIT_PX) return { clip, mode: "trim-right" }
      if (x >= x0 && x <= x1) return { clip, mode: "move" }
    }
    return null
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const hit = hitTest(x)
    if (!hit) {
      onSelectClip(null)
      onSeek(xToFrame(x))
      return
    }
    onSelectClip(hit.clip.id)
    dragRef.current = { mode: hit.mode, clipId: hit.clip.id, startX: x, startClip: { ...hit.clip } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const deltaFrames = xToFrame(x) - xToFrame(drag.startX)

    const next = clips.map((c) => {
      if (c.id !== drag.clipId) return c
      if (drag.mode === "move") {
        return { ...c, timeline_start_frame: Math.max(0, drag.startClip.timeline_start_frame + deltaFrames) }
      }
      if (drag.mode === "trim-left") {
        const clampedDelta = Math.max(
          -drag.startClip.source_start_frame,
          Math.min(drag.startClip.length_frames - 1, deltaFrames)
        )
        return {
          ...c,
          source_start_frame: drag.startClip.source_start_frame + clampedDelta,
          length_frames: drag.startClip.length_frames - clampedDelta,
          timeline_start_frame: Math.max(0, drag.startClip.timeline_start_frame + clampedDelta),
        }
      }
      // trim-right
      const maxLength = sourceDurationFrames - drag.startClip.source_start_frame
      return {
        ...c,
        length_frames: Math.max(1, Math.min(maxLength, drag.startClip.length_frames + deltaFrames)),
      }
    })
    onClipsChange(next)
  }

  const handlePointerUp = () => {
    dragRef.current = null
  }

  return (
    <canvas
      ref={canvasRef}
      className="clip-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  )
}
