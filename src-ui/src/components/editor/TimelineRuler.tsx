import { useMemo } from "react"
import "./TimelineRuler.css"

interface TimelineRulerProps {
  /** Total arrangement length, in frames - the ruler is sized to at least
   * this (plus a little trailing room), matching every track's own
   * ClipCanvas width so tick marks line up with the waveforms below. */
  durationFrames: number
  sampleRate: number
  pixelsPerSecond: number
  playheadFrame: number
  onSeek: (frame: number) => void
}

/** Candidate tick spacings, in seconds - the widest one that still leaves
 * at least MIN_LABEL_SPACING_PX between labels at the current zoom wins,
 * so labels never crowd together at high zoom and never sit sparse at low
 * zoom. */
const NICE_INTERVALS_SEC = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900]
const MIN_LABEL_SPACING_PX = 64
const TRAILING_PADDING_PX = 80
// Matches ClipCanvas's own minimum (which in turn matches TrackLane.css's
// fixed sticky-header width) so the ruler is never narrower than a track
// row and the two never scroll out of alignment.
const MIN_WIDTH_PX = 700

function pickIntervalSeconds(pixelsPerSecond: number): number {
  for (const interval of NICE_INTERVALS_SEC) {
    if (interval * pixelsPerSecond >= MIN_LABEL_SPACING_PX) return interval
  }
  return NICE_INTERVALS_SEC[NICE_INTERVALS_SEC.length - 1]
}

function formatTickLabel(seconds: number, interval: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds - minutes * 60
  const secsLabel = interval < 1 ? secs.toFixed(1).padStart(4, "0") : Math.round(secs).toString().padStart(2, "0")
  return `${minutes}:${secsLabel}`
}

/**
 * Zoomable timeline ruler shown above the track lanes: tick marks at a
 * zoom-appropriate spacing, click-to-seek anywhere along it, and its own
 * copy of the playhead line so the current position is visible even when
 * scrolled away from any particular track's canvas.
 */
export function TimelineRuler({
  durationFrames,
  sampleRate,
  pixelsPerSecond,
  playheadFrame,
  onSeek,
}: TimelineRulerProps) {
  const interval = pickIntervalSeconds(pixelsPerSecond)
  const totalSeconds = durationFrames / sampleRate
  const widthPx = Math.max(MIN_WIDTH_PX, Math.round(totalSeconds * pixelsPerSecond) + TRAILING_PADDING_PX)

  const ticks = useMemo(() => {
    const visibleSeconds = widthPx / pixelsPerSecond
    const tickCount = Math.ceil(visibleSeconds / interval) + 1
    const list: { seconds: number; x: number }[] = []
    for (let i = 0; i <= tickCount; i++) {
      const seconds = i * interval
      list.push({ seconds, x: seconds * pixelsPerSecond })
    }
    return list
  }, [widthPx, pixelsPerSecond, interval])

  const playheadX = (playheadFrame / sampleRate) * pixelsPerSecond

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const seconds = Math.max(0, x / pixelsPerSecond)
    onSeek(Math.round(seconds * sampleRate))
  }

  return (
    <div className="timeline-ruler" style={{ width: widthPx }} onClick={handleClick} title="Click to seek">
      {ticks.map((t) => (
        <div key={t.seconds} className="timeline-ruler-tick" style={{ left: t.x }}>
          <span className="timeline-ruler-tick-line" />
          <span className="timeline-ruler-tick-label">{formatTickLabel(t.seconds, interval)}</span>
        </div>
      ))}
      <div className="timeline-ruler-playhead" style={{ left: playheadX }} />
    </div>
  )
}
