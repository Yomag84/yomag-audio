import { useState } from "react"
import type { PeerSnapshot, VirtualDeviceSnapshot } from "../types"
import "./NetworkPanel.css"

interface NetworkPanelProps {
  systemEndpoints: string[]
  peers: PeerSnapshot[]
  virtualDevices: VirtualDeviceSnapshot[]
  onCreateSystemEndpoint: (name: string) => void
  onRemoveSystemEndpoint: (instanceId: string) => void
  onTogglePublish: (deviceId: string, published: boolean) => void
  onAddNetworkSource: (deviceId: string, peerId: string, remoteDeviceId: string) => void
  onRemoveNetworkSource: (deviceId: string, sourceId: string) => void
  onQuickRouteToApp: (appLabel: string, targetDeviceId: string) => Promise<string | null>
}

// Common apps people want to send audio into as a "microphone" - Windows
// has no way to push audio into another process directly, so this is just
// a friendly shortcut for the standard virtual-cable workflow: create a
// virtual mic named for the app, route this device's mix onto it, then
// pick that mic in the app's own audio settings.
const QUICK_ROUTE_APPS = [
  "Zoom",
  "Microsoft Teams",
  "WhatsApp Desktop",
  "Discord",
  "Skype",
  "Google Meet",
  "Slack",
] as const

// Must match the "net:<peer_id>:<remote_device_id>" shape engine.rs's
// add_network_source builds its source id from.
function networkSourceId(peerId: string, remoteDeviceId: string): string {
  return `net:${peerId}:${remoteDeviceId}`
}

export function NetworkPanel({
  systemEndpoints,
  peers,
  virtualDevices,
  onCreateSystemEndpoint,
  onRemoveSystemEndpoint,
  onTogglePublish,
  onAddNetworkSource,
  onRemoveNetworkSource,
  onQuickRouteToApp,
}: NetworkPanelProps) {
  const [newEndpointName, setNewEndpointName] = useState("")
  const [routeTargetId, setRouteTargetId] = useState("")
  const [creatingApp, setCreatingApp] = useState<string | null>(null)
  const [routedApps, setRoutedApps] = useState<Record<string, string>>({})

  const routeTarget = virtualDevices.find((d) => d.id === routeTargetId) ?? virtualDevices[0] ?? null

  const handleQuickRoute = async (appLabel: string) => {
    if (!routeTarget || creatingApp) return
    setCreatingApp(appLabel)
    const monitorName = await onQuickRouteToApp(appLabel, routeTarget.id)
    setCreatingApp(null)
    if (monitorName) {
      setRoutedApps((current) => ({ ...current, [appLabel]: monitorName }))
    }
  }

  return (
    <div className="network-page">
      <section className="network-section">
        <div className="routing-column-header">
          <div>
            <h3>Send Audio to Applications</h3>
            <span className="routing-column-subtitle">
              Route a virtual device's mix into Zoom, Teams, WhatsApp, or any other app as a
              microphone input
            </span>
          </div>
        </div>
        <p className="network-hint">
          Windows has no way to push audio directly into another app - the standard workaround
          (the same one VB-Cable and Voicemeeter use) is a virtual microphone: click an app below
          to create one and route the selected device's mix onto it, then open that app's own
          audio/microphone settings and pick it from the device list. Requires the YomagAudio
          driver to be installed and this app running as Administrator.
        </p>
        <div className="network-add-row">
          <select value={routeTarget?.id ?? ""} onChange={(e) => setRouteTargetId(e.target.value)}>
            {virtualDevices.length === 0 && <option value="">Create a virtual device first</option>}
            {virtualDevices.map((d) => (
              <option key={d.id} value={d.id}>
                Route: {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="quick-route-grid">
          {QUICK_ROUTE_APPS.map((appLabel) => {
            const routedName = routedApps[appLabel]
            return (
              <div key={appLabel} className="quick-route-item">
                <button
                  className="btn btn-secondary"
                  disabled={!routeTarget || creatingApp !== null || !!routedName}
                  onClick={() => handleQuickRoute(appLabel)}
                >
                  {creatingApp === appLabel ? "Creating…" : routedName ? `✓ ${appLabel}` : appLabel}
                </button>
                {routedName && (
                  <span className="quick-route-hint">
                    In {appLabel}, set microphone to "{routedName}"
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="network-section">
        <div className="routing-column-header">
          <div>
            <h3>Send to Network</h3>
            <span className="routing-column-subtitle">
              Publish a virtual device's mix so other YomagAudio instances on the LAN can receive it
            </span>
          </div>
        </div>
        <ul className="network-list">
          {virtualDevices.map((device) => (
            <li key={device.id} className="network-item">
              <span className="network-item-name">{device.name}</span>
              <label
                className="publish-toggle"
                title={
                  device.enabled
                    ? "Broadcast this device's mix to other YomagAudio instances on the LAN"
                    : "Enable the device first"
                }
              >
                <input
                  type="checkbox"
                  checked={device.is_published}
                  disabled={!device.enabled}
                  onChange={(e) => onTogglePublish(device.id, e.target.checked)}
                />
                Publish
              </label>
            </li>
          ))}
          {virtualDevices.length === 0 && <p className="routing-empty">Create a virtual device first</p>}
        </ul>
      </section>

      <section className="network-section">
        <div className="routing-column-header">
          <div>
            <h3>Receive from Peers</h3>
            <span className="routing-column-subtitle">
              Pull another instance's published device in as a source on any of your virtual devices
            </span>
          </div>
        </div>
        <ul className="network-list">
          {peers.map((peer) => (
            <li key={peer.peer_id} className="network-item network-peer">
              <div className="network-peer-header">
                <span className="network-item-name">{peer.name}</span>
                <span className="network-peer-addr">{peer.addr}</span>
              </div>
              {peer.published.length === 0 ? (
                <p className="routing-empty">Not publishing anything</p>
              ) : (
                <div className="network-published-list">
                  {peer.published.map((d) => {
                    const sourceId = networkSourceId(peer.peer_id, d.device_id)
                    return (
                      <div key={d.device_id} className="network-published-item">
                        <span className="network-item-name">{d.device_name}</span>
                        <div className="app-destination-list">
                          {virtualDevices.map((device) => {
                            const routed = device.sources.some((s) => s.id === sourceId)
                            return (
                              <div
                                key={device.id}
                                className={`app-destination-chip ${routed ? "routed" : ""}`}
                              >
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={routed}
                                    onChange={(e) =>
                                      e.target.checked
                                        ? onAddNetworkSource(device.id, peer.peer_id, d.device_id)
                                        : onRemoveNetworkSource(device.id, sourceId)
                                    }
                                  />
                                  {device.name}
                                </label>
                              </div>
                            )
                          })}
                          {virtualDevices.length === 0 && (
                            <span className="routing-empty">Create a virtual device first</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          ))}
          {peers.length === 0 && <p className="routing-empty">No peers found on this network yet</p>}
        </ul>
      </section>

      <section className="network-section">
        <div className="routing-column-header">
          <div>
            <h3>Custom Virtual Devices</h3>
            <span className="routing-column-subtitle">
              The same mechanism as "Send Audio to Applications" above, with a name of your
              choosing - for an app not in that list, or a device meant for network endpoints
              rather than routing sound out
            </span>
          </div>
        </div>
        <div className="network-add-row">
          <input
            type="text"
            placeholder="Device name…"
            value={newEndpointName}
            onChange={(e) => setNewEndpointName(e.target.value)}
          />
          <button
            className="btn btn-secondary"
            disabled={!newEndpointName.trim()}
            onClick={() => {
              onCreateSystemEndpoint(newEndpointName.trim())
              setNewEndpointName("")
            }}
          >
            Create
          </button>
        </div>
        <p className="network-hint">
          Requires Administrator privileges and the YomagAudio driver to already be installed and signed on this
          machine.
        </p>
        <ul className="network-list">
          {systemEndpoints.map((id) => (
            <li key={id} className="network-item">
              <span className="network-item-name" title={id}>
                {id}
              </span>
              <button className="chip-remove" onClick={() => onRemoveSystemEndpoint(id)}>
                ×
              </button>
            </li>
          ))}
          {systemEndpoints.length === 0 && <p className="routing-empty">None created yet</p>}
        </ul>
      </section>
    </div>
  )
}
