import { useMemo } from "react"
import type { AudioDeviceInfo, EngineInfo, VirtualDeviceSnapshot } from "../types"
import type { Update } from "../lib/updater"
import "./SettingsDialog.css"

interface SettingsDialogProps {
  onClose: () => void
  physicalDevices: AudioDeviceInfo[]
  virtualDevices: VirtualDeviceSnapshot[]
  engineInfo: EngineInfo | null
  onSetMonitorBufferMs: (deviceId: string, monitorName: string, ms: number) => void
  onSetMonitorDelayMs: (deviceId: string, monitorName: string, ms: number) => void
  onSetMonitorExclusive: (deviceId: string, monitorName: string, exclusive: boolean) => void
  autoUpdateEnabled: boolean
  onSetAutoUpdateEnabled: (enabled: boolean) => void
  updateStatus: "idle" | "checking" | "downloading" | "up-to-date" | "error"
  updateInfo: Update | null
  onCheckForUpdates: () => void
  onInstallUpdateNow: (update: Update) => void
}

export function SettingsDialog({
  onClose,
  physicalDevices,
  virtualDevices,
  engineInfo,
  onSetMonitorBufferMs,
  onSetMonitorDelayMs,
  onSetMonitorExclusive,
  autoUpdateEnabled,
  onSetAutoUpdateEnabled,
  updateStatus,
  updateInfo,
  onCheckForUpdates,
  onInstallUpdateNow,
}: SettingsDialogProps) {
  // A physical device counts as "in use" if it's wired in as a source
  // (matched by id, which is the device name for real inputs) or a monitor
  // (matched by name) on any virtual device - the closest equivalent here
  // to VoiceMeeter's per-strip ON/OFF status, since YomagAudio has no
  // fixed-size bus of hardware slots to read status off of directly.
  const usedNames = useMemo(() => {
    const used = new Set<string>()
    for (const device of virtualDevices) {
      for (const source of device.sources) used.add(source.id)
      for (const monitor of device.monitors) used.add(monitor.name)
    }
    return used
  }, [virtualDevices])

  const monitorRows = useMemo(
    () =>
      virtualDevices.flatMap((device) =>
        device.monitors.map((monitor) => ({ device, monitor }))
      ),
    [virtualDevices]
  )

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>System Settings</h2>
          <button className="chip-remove" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <section className="settings-section">
          <h3>Updates</h3>
          <div className="settings-kv">
            <div>
              <span>Automatically install updates</span>
              <span>
                <input
                  type="checkbox"
                  checked={autoUpdateEnabled}
                  onChange={(e) => onSetAutoUpdateEnabled(e.target.checked)}
                  title="When off, a found update waits for you to click Install & Restart instead of installing itself"
                />
              </span>
            </div>
            <div>
              <span>Status</span>
              <span>
                {updateStatus === "checking" && "Checking…"}
                {updateStatus === "downloading" && "Downloading…"}
                {updateStatus === "up-to-date" && "Up to date"}
                {updateStatus === "error" && "Check failed"}
                {updateStatus === "idle" && updateInfo && `Update available: v${updateInfo.version}`}
                {updateStatus === "idle" && !updateInfo && "Up to date"}
              </span>
            </div>
            <div>
              <span></span>
              <span>
                {updateInfo && updateStatus === "idle" ? (
                  <button className="btn btn-primary" onClick={() => onInstallUpdateNow(updateInfo)}>
                    Install &amp; Restart
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary"
                    onClick={onCheckForUpdates}
                    disabled={updateStatus === "checking" || updateStatus === "downloading"}
                  >
                    Check for Updates
                  </button>
                )}
              </span>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>Audio Devices</h3>
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Default</th>
                  <th>Sample Rate</th>
                  <th>Channels</th>
                </tr>
              </thead>
              <tbody>
                {physicalDevices.map((d) => (
                  <tr key={`${d.is_input ? "in" : "out"}:${d.name}`}>
                    <td className="settings-name-cell" title={d.name}>
                      {d.name}
                    </td>
                    <td>{d.is_input ? "Input" : "Output"}</td>
                    <td>
                      <span className={`status-pill ${usedNames.has(d.name) ? "on" : "off"}`}>
                        {usedNames.has(d.name) ? "ON" : "OFF"}
                      </span>
                    </td>
                    <td>{d.is_default ? "Default" : ""}</td>
                    <td>{d.sample_rate ? `${d.sample_rate} Hz` : "—"}</td>
                    <td>{d.channels ?? "—"}</td>
                  </tr>
                ))}
                {physicalDevices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="routing-empty">
                      No devices found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="settings-section">
          <h3>Engine</h3>
          <div className="settings-kv">
            <div>
              <span>Internal Mix Sample Rate</span>
              <span>{engineInfo ? `${engineInfo.internal_sample_rate} Hz` : "…"}</span>
            </div>
            <div>
              <span>Mixer Tick Period</span>
              <span>{engineInfo ? `${engineInfo.mix_tick_period_ms} ms` : "…"}</span>
            </div>
            <div>
              <span>High-Resolution Timer</span>
              <span>Enabled</span>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>Monitor Buffering</h3>
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Virtual Device</th>
                  <th>Monitor</th>
                  <th>Exclusive</th>
                  <th>Buffer (ms)</th>
                  <th>Delay (ms)</th>
                </tr>
              </thead>
              <tbody>
                {monitorRows.map(({ device, monitor }) => (
                  <tr key={`${device.id}::${monitor.name}`}>
                    <td>{device.name}</td>
                    <td className="settings-name-cell" title={monitor.name}>
                      {monitor.name}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={monitor.exclusive}
                        onChange={(e) => onSetMonitorExclusive(device.id, monitor.name, e.target.checked)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={5}
                        max={250}
                        className="settings-number"
                        value={monitor.buffer_ms}
                        onChange={(e) => onSetMonitorBufferMs(device.id, monitor.name, Number(e.target.value))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        className="settings-number"
                        value={monitor.delay_ms}
                        onChange={(e) => onSetMonitorDelayMs(device.id, monitor.name, Number(e.target.value))}
                      />
                    </td>
                  </tr>
                ))}
                {monitorRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="routing-empty">
                      No monitors configured yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
