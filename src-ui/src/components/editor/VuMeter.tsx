import { useEffect, useRef, useState } from "react"
import "./VuMeter.css"

interface VuMeterProps {
  /** Linear peak, 0..1. */
  peak: number
  label: string
}

const MIN_DB = -50
const MAX_DB = 3
const NEEDLE_MIN_DEG = -50
const NEEDLE_MAX_DEG = 50
/** How long a clip (>=0dB) keeps the peak lamp lit after the last time it
 * happened, so a brief transient is still visible rather than blinking for
 * a single frame. */
const PEAK_HOLD_MS = 1200

function peakToDb(peak: number): number {
  return peak > 0 ? 20 * Math.log10(peak) : MIN_DB
}

function dbToAngle(db: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db))
  const ratio = (clamped - MIN_DB) / (MAX_DB - MIN_DB)
  return NEEDLE_MIN_DEG + ratio * (NEEDLE_MAX_DEG - NEEDLE_MIN_DEG)
}

/**
 * An analog-style VU dial: a swept needle plus a clip lamp that latches on
 * briefly (see PEAK_HOLD_MS) instead of flickering for a single frame.
 * `peak` is expected to be polled at animation-frame rate by the caller
 * (see EditorPage's meter loop) and passed straight through - the needle's
 * own CSS transition (see VuMeter.css) supplies the ballistic "swing"
 * rather than this component smoothing the value itself.
 */
export function VuMeter({ peak, label }: VuMeterProps) {
  const [peakLit, setPeakLit] = useState(false)
  const clearTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (peak < 0.99) return
    setPeakLit(true)
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current)
    clearTimerRef.current = window.setTimeout(() => setPeakLit(false), PEAK_HOLD_MS)
  }, [peak])

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current)
    }
  }, [])

  const angle = dbToAngle(peakToDb(peak))

  return (
    <div className="vu-meter">
      <div className="vu-meter-face">
        <svg viewBox="0 0 120 78" className="vu-meter-scale">
          <path d="M 10 70 A 50 50 0 0 1 110 70" className="vu-meter-arc" />
          <path d="M 92 40 A 50 50 0 0 1 110 70" className="vu-meter-arc-red" />
        </svg>
        <div className="vu-meter-needle" style={{ transform: `rotate(${angle}deg)` }} />
        <div className="vu-meter-pivot" />
        <span className="vu-meter-label">{label}</span>
      </div>
      <div className={`vu-meter-peak-lamp ${peakLit ? "lit" : ""}`}>PEAK</div>
    </div>
  )
}
