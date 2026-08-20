import type { CSSProperties } from "react"

/** Converts a linear 0..1 peak into a 0..100 meter-fill percentage on a
 * -60..0dB scale, matching how every level meter in the app (routing
 * cards, the source picker) reads a peak value. */
export function levelToWidth(peak: number | undefined): number {
  const v = peak ?? 0
  const db = v > 0 ? 20 * Math.log10(v) : -60
  const clamped = Math.max(-60, Math.min(0, db))
  return ((clamped + 60) / 60) * 100
}

export function meterFillStyle(peak: number | undefined): CSSProperties {
  return { transform: `scaleX(${levelToWidth(peak) / 100})` }
}
