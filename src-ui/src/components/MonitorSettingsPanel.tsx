import { useEffect, useState } from "react"
import type { EqBand, MonitorInfo } from "../types"
import "./MonitorSettingsPanel.css"

interface MonitorSettingsPanelProps {
  monitor: MonitorInfo
  onSetBufferMs: (ms: number) => void
  onSetDelayMs: (ms: number) => void
  onSetEq: (bands: EqBand[]) => void
}

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onCommit: (value: number) => void
}

// Commits on blur/Enter rather than on every keystroke: buffer/delay
// changes restart the monitor's stream (a brief audible glitch), so firing
// on every intermediate value while typing would glitch repeatedly instead
// of once when the user's actually done editing.
function NumberField({ label, value, min, max, step, unit, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (Number.isFinite(parsed)) {
      onCommit(Math.min(max, Math.max(min, parsed)))
    } else {
      setDraft(String(value))
    }
  }

  return (
    <label className="monitor-setting-field">
      <span>{label}</span>
      <div className="monitor-setting-input">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          }}
        />
        <span className="monitor-setting-unit">{unit}</span>
      </div>
    </label>
  )
}

const DEFAULT_BAND: EqBand = { freq_hz: 1000, gain_db: 0, q: 1 }

export function MonitorSettingsPanel({ monitor, onSetBufferMs, onSetDelayMs, onSetEq }: MonitorSettingsPanelProps) {
  const updateBand = (index: number, patch: Partial<EqBand>) => {
    onSetEq(monitor.eq_bands.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }

  const addBand = () => onSetEq([...monitor.eq_bands, { ...DEFAULT_BAND }])
  const removeBand = (index: number) => onSetEq(monitor.eq_bands.filter((_, i) => i !== index))

  return (
    <div className="monitor-settings">
      <div className="monitor-settings-row">
        <NumberField
          label="Buffer"
          value={monitor.buffer_ms}
          min={5}
          max={250}
          unit="ms"
          onCommit={onSetBufferMs}
        />
        <NumberField
          label="Delay"
          value={monitor.delay_ms}
          min={0}
          max={500}
          unit="ms"
          onCommit={onSetDelayMs}
        />
      </div>

      <div className="monitor-eq">
        <div className="monitor-eq-header">
          <span>EQ bands</span>
          <button type="button" className="btn-icon" onClick={addBand} title="Add a parametric band">
            +
          </button>
        </div>
        {monitor.eq_bands.length === 0 && <p className="routing-empty">Flat (no bands)</p>}
        {monitor.eq_bands.map((band, i) => (
          <div key={i} className="eq-band-row">
            <input
              type="number"
              className="eq-band-freq"
              value={band.freq_hz}
              min={20}
              max={20000}
              step={10}
              onChange={(e) => updateBand(i, { freq_hz: Number(e.target.value) })}
              title="Center frequency"
            />
            <span className="eq-band-unit">Hz</span>
            <input
              type="range"
              className="eq-band-gain"
              min={-24}
              max={24}
              step={0.5}
              value={band.gain_db}
              onChange={(e) => updateBand(i, { gain_db: Number(e.target.value) })}
              title="Gain"
            />
            <span className="eq-band-gain-label">
              {band.gain_db > 0 ? "+" : ""}
              {band.gain_db.toFixed(1)}dB
            </span>
            <input
              type="number"
              className="eq-band-q"
              value={band.q}
              min={0.1}
              max={18}
              step={0.1}
              onChange={(e) => updateBand(i, { q: Number(e.target.value) })}
              title="Q (bandwidth)"
            />
            <span className="eq-band-unit">Q</span>
            <button type="button" className="chip-remove" onClick={() => removeBand(i)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
