import { useRef } from "react"
import "./Knob.css"

interface KnobProps {
  value: number
  min: number
  max: number
  color: string
  label?: string
  onChange: (value: number) => void
}

/** Vertical px of drag needed to sweep the full min..max range. */
const DRAG_SENSITIVITY_PX = 120

/**
 * A small rotary control: drag up/down to change value (the standard
 * plugin-UI gesture for a knob, since an actual rotational drag is fiddly
 * with a mouse), double-click to reset to center. Used for pan in the
 * Mixer view - gain stays a vertical fader, matching the reference
 * mixer-strip layout where pan is a small dial above a long fader.
 */
export function Knob({ value, min, max, color, label, onChange }: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null)
  const center = (min + max) / 2

  const ratio = (value - min) / (max - min)
  const angle = -135 + ratio * 270

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startValue: value }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const deltaRatio = (drag.startY - e.clientY) / DRAG_SENSITIVITY_PX
    onChange(Math.min(max, Math.max(min, drag.startValue + deltaRatio * (max - min))))
  }

  const handlePointerUp = () => {
    dragRef.current = null
  }

  return (
    <div className="knob-wrap">
      <div
        className="knob"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => onChange(center)}
        title="Drag up/down to adjust, double-click to reset"
      >
        <div className="knob-dial" style={{ transform: `rotate(${angle}deg)`, borderColor: color }}>
          <div className="knob-pointer" style={{ background: color }} />
        </div>
      </div>
      {label && <span className="knob-label">{label}</span>}
    </div>
  )
}
