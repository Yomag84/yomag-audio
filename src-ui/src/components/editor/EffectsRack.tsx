import type { EqBand } from "../../types"
import "./EffectsRack.css"

interface EffectsRackProps {
  bands: EqBand[]
  onChange: (bands: EqBand[]) => void
  onClose: () => void
}

const DEFAULT_BAND: EqBand = { freq_hz: 1000, gain_db: 0, q: 1 }

/**
 * Per-track parametric EQ popover. Edits here drive both the live Web
 * Audio preview (via EditorEngine's native BiquadFilterNodes) and, once
 * saved, the authoritative offline render - see recording::render_mixdown.
 */
export function EffectsRack({ bands, onChange, onClose }: EffectsRackProps) {
  const updateBand = (index: number, patch: Partial<EqBand>) => {
    onChange(bands.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }
  const addBand = () => onChange([...bands, { ...DEFAULT_BAND }])
  const removeBand = (index: number) => onChange(bands.filter((_, i) => i !== index))

  return (
    <div className="effects-rack">
      <div className="effects-rack-header">
        <span>Parametric EQ</span>
        <button className="chip-remove" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {bands.length === 0 && <p className="routing-empty">Flat (no bands)</p>}
      {bands.map((band, i) => (
        <div key={i} className="effects-rack-band">
          <input
            type="number"
            className="effects-rack-freq"
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
            className="effects-rack-gain"
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
            className="effects-rack-q"
            value={band.q}
            min={0.1}
            max={18}
            step={0.1}
            onChange={(e) => updateBand(i, { q: Number(e.target.value) })}
            title="Q (bandwidth)"
          />
          <span className="eq-band-unit">Q</span>
          <button className="chip-remove" onClick={() => removeBand(i)}>
            ×
          </button>
        </div>
      ))}
      <button className="btn btn-secondary" onClick={addBand}>
        + Add band
      </button>
    </div>
  )
}
