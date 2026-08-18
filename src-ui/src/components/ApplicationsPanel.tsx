import type { AppAudioSession, VirtualDeviceSnapshot } from "../types"
import "./ApplicationsPanel.css"

interface ApplicationsPanelProps {
  sessions: AppAudioSession[]
  virtualDevices: VirtualDeviceSnapshot[]
  onAddDestination: (deviceId: string, sourceId: string) => void
  onRemoveDestination: (deviceId: string, sourceId: string) => void
  onGain: (deviceId: string, sourceId: string, gain: number) => void
  onMute: (deviceId: string, sourceId: string, muted: boolean) => void
  onCreateDevice: () => void
}

// Must match the "app:<pid>:<process_name>" shape process_audio::
// parse_app_source_id expects on the Rust side.
export function appSourceId(session: AppAudioSession): string {
  return `app:${session.pid}:${session.process_name}`
}

export function ApplicationsPanel({
  sessions,
  virtualDevices,
  onAddDestination,
  onRemoveDestination,
  onGain,
  onMute,
  onCreateDevice,
}: ApplicationsPanelProps) {
  return (
    <div className="applications-panel">
      <div className="routing-column-header">
        <div>
          <h3>Applications</h3>
          <span className="routing-column-subtitle">
            {sessions.length} app{sessions.length === 1 ? "" : "s"} currently playing audio · route each one to
            any virtual device as a destination
          </span>
        </div>
      </div>

      {virtualDevices.length === 0 && (
        <div className="applications-empty">
          <p className="routing-empty">Create a virtual device first, then route applications to it here.</p>
          <button className="btn btn-primary" onClick={onCreateDevice}>
            Create your first virtual device
          </button>
        </div>
      )}

      <div className="app-session-list">
        {sessions.map((session) => {
          const sourceId = appSourceId(session)
          return (
            <div key={sourceId} className="app-session-card">
              <div className="app-session-header">
                <span className="app-session-name" title={session.process_name}>
                  {session.display_name}
                </span>
                <span className="app-session-meta">
                  {session.process_name} · pid {session.pid}
                </span>
              </div>
              <div className="app-destination-list">
                {virtualDevices.map((device) => {
                  const source = device.sources.find((s) => s.id === sourceId)
                  const routed = !!source
                  return (
                    <div key={device.id} className={`app-destination-chip ${routed ? "routed" : ""}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={routed}
                          onChange={(e) =>
                            e.target.checked
                              ? onAddDestination(device.id, sourceId)
                              : onRemoveDestination(device.id, sourceId)
                          }
                        />
                        {device.name}
                      </label>
                      {routed && source && (
                        <div className="app-destination-controls">
                          <button
                            className={`btn-mute ${source.muted ? "muted" : ""}`}
                            onClick={() => onMute(device.id, sourceId, !source.muted)}
                          >
                            {source.muted ? "Muted" : "Mute"}
                          </button>
                          <input
                            type="range"
                            min={0}
                            max={2}
                            step={0.01}
                            value={source.gain}
                            disabled={source.muted}
                            onChange={(e) => onGain(device.id, sourceId, Number(e.target.value))}
                          />
                          <span className="gain-label">{Math.round(source.gain * 100)}%</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {sessions.length === 0 && (
          <p className="routing-empty">No applications are currently playing audio</p>
        )}
      </div>
    </div>
  )
}
