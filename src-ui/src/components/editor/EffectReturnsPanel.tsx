import { useState } from "react"
import type { EffectReturn } from "../../types"
import "./EffectReturnsPanel.css"

interface EffectReturnsPanelProps {
  returns: EffectReturn[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<EffectReturn>) => void
  onRemove: (id: string) => void
}

/**
 * "Effect Returns" console panel: shared send/return busses every track's
 * Mixer strip gets a send knob into (see MixerView) - the classic "aux
 * return" mixing model. Delay is the only effect type today (see
 * src-tauri/src/audio/delay.rs); Enable bypasses a return without losing
 * its settings or any track's send-knob position, Edit expands its
 * delay/feedback/mix controls in place, Delete removes it entirely
 * (clearing every track's send to it).
 */
export function EffectReturnsPanel({ returns, onAdd, onUpdate, onRemove }: EffectReturnsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="console-panel effect-returns-panel">
      <div className="effect-returns-header">
        <h4>Effect Returns</h4>
        <button className="btn-icon" onClick={onAdd} title="Add a Delay return">
          +
        </button>
      </div>
      <div className="effect-returns-list">
        {returns.map((r) => (
          <div key={r.id} className="effect-return-row">
            <div className="effect-return-summary">
              <button
                className={`effect-return-enable ${r.enabled ? "active" : ""}`}
                onClick={() => onUpdate(r.id, { enabled: !r.enabled })}
                title={r.enabled ? "Disable this return" : "Enable this return"}
              >
                {r.enabled ? "●" : "○"}
              </button>
              <span className="effect-return-name" title={r.name}>
                {r.name}
              </span>
              <button
                className={`effect-return-edit ${expandedId === r.id ? "active" : ""}`}
                onClick={() => setExpandedId((cur) => (cur === r.id ? null : r.id))}
              >
                Edit
              </button>
              <button className="effect-return-delete" onClick={() => onRemove(r.id)} title="Delete this return">
                ×
              </button>
            </div>
            {expandedId === r.id && (
              <div className="effect-return-controls">
                <label>
                  <span>Delay</span>
                  <input
                    type="range"
                    min={10}
                    max={1500}
                    step={5}
                    value={r.delay_ms}
                    onChange={(e) => onUpdate(r.id, { delay_ms: Number(e.target.value) })}
                  />
                  <span className="effect-return-value">{Math.round(r.delay_ms)}ms</span>
                </label>
                <label>
                  <span>Feedback</span>
                  <input
                    type="range"
                    min={0}
                    max={0.95}
                    step={0.01}
                    value={r.feedback}
                    onChange={(e) => onUpdate(r.id, { feedback: Number(e.target.value) })}
                  />
                  <span className="effect-return-value">{Math.round(r.feedback * 100)}%</span>
                </label>
                <label>
                  <span>Mix</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={r.mix}
                    onChange={(e) => onUpdate(r.id, { mix: Number(e.target.value) })}
                  />
                  <span className="effect-return-value">{Math.round(r.mix * 100)}%</span>
                </label>
              </div>
            )}
          </div>
        ))}
        {returns.length === 0 && <p className="effect-returns-empty">No returns yet - click + to add a Delay</p>}
      </div>
    </div>
  )
}
