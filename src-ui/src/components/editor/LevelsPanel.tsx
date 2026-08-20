import { VuMeter } from "./VuMeter"
import "./LevelsPanel.css"

interface LevelsPanelProps {
  inputPeak: number
  outputPeak: number
  outputGain: number
  onOutputGainChange: (value: number) => void
}

/** "Levels" console panel: Input meter (read-only - there's no live input
 * during offline editing, only the summed track signal before the master
 * fader) and Output meter + fader (the one control that actually changes
 * what you hear on export preview). */
export function LevelsPanel({ inputPeak, outputPeak, outputGain, onOutputGainChange }: LevelsPanelProps) {
  return (
    <div className="console-panel levels-panel">
      <h4>Levels</h4>
      <div className="levels-meters">
        <VuMeter peak={inputPeak} label="INPUT" />
        <VuMeter peak={outputPeak} label="OUTPUT" />
      </div>
      <div className="levels-output-row">
        <span className="levels-output-label">Output</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={outputGain}
          onChange={(e) => onOutputGainChange(Number(e.target.value))}
        />
        <span className="levels-output-value">{Math.round(outputGain * 100)}%</span>
      </div>
    </div>
  )
}
