import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Sidebar } from "./components/Sidebar"
import { RoutingPanel } from "./components/RoutingPanel"
import { NetworkPanel } from "./components/NetworkPanel"
import { ApplicationsPanel } from "./components/ApplicationsPanel"
import { SettingsDialog } from "./components/SettingsDialog"
import { useDeviceLevels } from "./hooks/useDeviceLevels"
import type {
  AppAudioSession,
  AudioDeviceInfo,
  EngineInfo,
  EqBand,
  InternalDeviceGuess,
  PeerSnapshot,
  VirtualDeviceSnapshot,
} from "./types"
import "./App.css"

type View = "routing" | "applications" | "network"

function App() {
  const [view, setView] = useState<View>("routing")
  const [physicalDevices, setPhysicalDevices] = useState<AudioDeviceInfo[]>([])
  const [virtualDevices, setVirtualDevices] = useState<VirtualDeviceSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMonitors, setShowMonitors] = useState(false)
  const [hasSavedProfile, setHasSavedProfile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null)
  const [systemEndpoints, setSystemEndpoints] = useState<string[]>([])
  const [peers, setPeers] = useState<PeerSnapshot[]>([])
  const [appSessions, setAppSessions] = useState<AppAudioSession[]>([])
  const selectedIdRef = useRef<string | null>(null)

  const levels = useDeviceLevels()

  const refreshPhysicalDevices = useCallback(async () => {
    try {
      setPhysicalDevices(await invoke<AudioDeviceInfo[]>("list_devices"))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const refreshVirtualDevices = useCallback(async () => {
    try {
      const result = await invoke<VirtualDeviceSnapshot[]>("list_virtual_devices")
      setVirtualDevices(result)
      setSelectedId((current) => current ?? result[0]?.id ?? null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    refreshPhysicalDevices()
    refreshVirtualDevices()
    invoke<boolean>("has_saved_profile")
      .then(setHasSavedProfile)
      .catch((err) => setError(String(err)))
  }, [refreshPhysicalDevices, refreshVirtualDevices])

  useEffect(() => {
    // First-run convenience only: skip entirely if there's a saved profile
    // or any virtual device already exists, so this can never clobber
    // something the user set up or loaded themselves. Failures are
    // swallowed rather than shown as an error - not finding a "built-in"
    // mic/speaker (e.g. a desktop with only USB/Bluetooth audio) is a
    // normal outcome, not something to alarm a first-time user with.
    ;(async () => {
      try {
        const [hasSaved, existingDevices] = await Promise.all([
          invoke<boolean>("has_saved_profile"),
          invoke<VirtualDeviceSnapshot[]>("list_virtual_devices"),
        ])
        if (hasSaved || existingDevices.length > 0) return

        const guess = await invoke<InternalDeviceGuess>("guess_internal_devices")
        if (!guess.microphone || !guess.speaker) return

        const deviceId = await invoke<string>("create_virtual_device", {
          name: "Internal Mic + Speaker",
        })
        await invoke("add_device_source", { deviceId, sourceId: guess.microphone.name })
        await invoke("add_monitor", { deviceId, monitorName: guess.speaker.name })

        // New devices default to 2 output channels (see VirtualDevice::new)
        // and start disabled - wiring channels straight through leaves the
        // user one explicit "Enable" click away from live mic-to-speaker
        // audio rather than surprising them with it immediately, which
        // matters here since an internal mic sitting next to an internal
        // speaker is a real acoustic-feedback risk.
        const channelCount = Math.min(guess.microphone.channels ?? 1, 2)
        for (let channel = 0; channel < channelCount; channel += 1) {
          await invoke("set_connection", {
            deviceId,
            sourceId: guess.microphone.name,
            sourceChannel: channel,
            outputChannel: channel,
            gain: 1.0,
          })
          await invoke("set_monitor_channel", {
            deviceId,
            monitorName: guess.speaker.name,
            monitorChannel: channel,
            outputChannel: channel,
          })
        }

        await refreshVirtualDevices()
        setSelectedId(deviceId)
      } catch {
        // Best-effort onboarding convenience - silently skip on any failure.
      }
    })()
    // Runs once on mount only - see the comment above for why this can't
    // re-trigger later without risking clobbering user changes.
  }, [])

  const refreshSystemEndpoints = useCallback(async () => {
    try {
      setSystemEndpoints(await invoke<string[]>("list_system_endpoints"))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const refreshPeers = useCallback(async () => {
    try {
      setPeers(await invoke<PeerSnapshot[]>("list_peers"))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    if (view !== "network") return
    refreshSystemEndpoints()
    refreshPeers()
    const interval = setInterval(refreshPeers, 3000)
    return () => clearInterval(interval)
  }, [view, refreshSystemEndpoints, refreshPeers])

  const refreshAppSessions = useCallback(async () => {
    try {
      setAppSessions(await invoke<AppAudioSession[]>("list_audio_sessions"))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    if (view !== "applications") return
    refreshAppSessions()
    // Each call spawns a dedicated OS thread and does a full COM session
    // enumeration (see list_app_sessions) - real background work that
    // competes with the real-time mixer/capture threads for scheduling.
    // Apps don't start/stop playing audio often enough to need this
    // faster than every few seconds.
    const interval = setInterval(refreshAppSessions, 4000)
    return () => clearInterval(interval)
  }, [view, refreshAppSessions])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    if (!showSettings) return
    refreshPhysicalDevices()
    invoke<EngineInfo>("get_engine_info")
      .then(setEngineInfo)
      .catch((err) => setError(String(err)))
  }, [showSettings, refreshPhysicalDevices])

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null)
      try {
        await fn()
        await refreshVirtualDevices()
      } catch (err) {
        setError(String(err))
      }
    },
    [refreshVirtualDevices]
  )

  const handleCreate = () =>
    run(async () => {
      const id = await invoke<string>("create_virtual_device", { name: "New Virtual Device" })
      setSelectedId(id)
    })

  const handleDelete = (id: string) =>
    run(async () => {
      await invoke("delete_virtual_device", { deviceId: id })
      setSelectedId((current) => (current === id ? null : current))
    })

  const handleRename = (id: string, name: string) =>
    run(() => invoke("rename_virtual_device", { deviceId: id, name }))

  const handleToggleEnabled = (id: string, enabled: boolean) =>
    run(() => invoke("set_device_enabled", { deviceId: id, enabled }))

  const handleAddOutputPair = (id: string, currentChannels: number) =>
    run(() => invoke("set_device_output_channels", { deviceId: id, count: currentChannels + 2 }))

  const handleAddSource = (id: string, sourceId: string) =>
    run(() => invoke("add_device_source", { deviceId: id, sourceId }))

  const handleRemoveSource = (id: string, sourceId: string) =>
    run(() => invoke("remove_device_source", { deviceId: id, sourceId }))

  const handleSourceGain = (id: string, sourceId: string, gain: number) =>
    run(() => invoke("set_device_source_gain", { deviceId: id, sourceId, gain }))

  const handleSourceMute = (id: string, sourceId: string, muted: boolean) =>
    run(() => invoke("set_device_source_muted", { deviceId: id, sourceId, muted }))

  const handleToggleConnection = (
    id: string,
    sourceId: string,
    sourceChannel: number,
    outputChannel: number,
    alreadyConnected: boolean
  ) =>
    run(() =>
      alreadyConnected
        ? invoke("remove_connection", { deviceId: id, sourceId, sourceChannel, outputChannel })
        : invoke("set_connection", { deviceId: id, sourceId, sourceChannel, outputChannel, gain: 1.0 })
    )

  const handleAddMonitor = (id: string, monitorName: string) =>
    run(() => invoke("add_monitor", { deviceId: id, monitorName }))

  const handleRemoveMonitor = (id: string, monitorName: string) =>
    run(() => invoke("remove_monitor", { deviceId: id, monitorName }))

  const handleSetMonitorChannel = (
    id: string,
    monitorName: string,
    monitorChannel: number,
    outputChannel: number
  ) =>
    run(() =>
      invoke("set_monitor_channel", { deviceId: id, monitorName, monitorChannel, outputChannel })
    )

  const handleClearMonitorChannel = (id: string, monitorName: string, monitorChannel: number) =>
    run(() => invoke("clear_monitor_channel", { deviceId: id, monitorName, monitorChannel }))

  const handleSetMonitorExclusive = (id: string, monitorName: string, exclusive: boolean) =>
    run(() => invoke("set_monitor_exclusive", { deviceId: id, monitorName, exclusive }))

  const handleSetMonitorBufferMs = (id: string, monitorName: string, ms: number) =>
    run(() => invoke("set_monitor_buffer_ms", { deviceId: id, monitorName, ms }))

  const handleSetMonitorDelayMs = (id: string, monitorName: string, ms: number) =>
    run(() => invoke("set_monitor_delay_ms", { deviceId: id, monitorName, ms }))

  const handleSetMonitorEq = (id: string, monitorName: string, bands: EqBand[]) =>
    run(() => invoke("set_monitor_eq", { deviceId: id, monitorName, bands }))

  const handleTogglePublished = (id: string, published: boolean) =>
    run(() => invoke("set_device_published", { deviceId: id, published }))

  const handleCreateSystemEndpoint = async (name: string) => {
    setError(null)
    try {
      await invoke("create_system_endpoint", { name })
      await refreshSystemEndpoints()
    } catch (err) {
      setError(String(err))
    }
  }

  const handleRemoveSystemEndpoint = async (instanceId: string) => {
    setError(null)
    try {
      await invoke("remove_system_endpoint", { instanceId })
      await refreshSystemEndpoints()
    } catch (err) {
      setError(String(err))
    }
  }

  const handleAddNetworkSource = (deviceId: string, peerId: string, remoteDeviceId: string) =>
    run(() => invoke("add_network_source", { deviceId, peerId, remoteDeviceId }))

  const handleSaveProfile = async () => {
    setError(null)
    try {
      await invoke("save_profile")
      setHasSavedProfile(true)
    } catch (err) {
      setError(String(err))
    }
  }

  const handleLoadProfile = async () => {
    setBusy(true)
    setError(null)
    try {
      await invoke("load_profile")
      await refreshVirtualDevices()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Registered once: the window menu bar (see main.rs) doesn't know app
    // state, so every item besides Quit just forwards a "menu://" event
    // for the frontend to act on. selectedIdRef sidesteps the stale-
    // closure problem for delete-device since this effect never re-runs.
    const unlistenPromises = [
      listen("menu://new-device", () => handleCreate()),
      listen("menu://save-profile", () => handleSaveProfile()),
      listen("menu://load-profile", () => handleLoadProfile()),
      listen("menu://refresh-devices", () => refreshPhysicalDevices()),
      listen("menu://delete-device", () => {
        const id = selectedIdRef.current
        if (id) handleDelete(id)
      }),
      listen("menu://view-routing", () => setView("routing")),
      listen("menu://view-applications", () => setView("applications")),
      listen("menu://view-network", () => setView("network")),
      listen("menu://about", () => setShowAbout(true)),
      listen("menu://settings", () => setShowSettings(true)),
    ]
    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()))
    }
  }, [])

  const selectedDevice = virtualDevices.find((d) => d.id === selectedId) ?? null
  const inputDevices = useMemo(() => physicalDevices.filter((d) => d.is_input), [physicalDevices])
  const outputDevices = useMemo(() => physicalDevices.filter((d) => !d.is_input), [physicalDevices])

  const availableSourcesToAdd = useMemo(() => {
    if (!selectedDevice) return []
    const used = new Set(selectedDevice.sources.map((s) => s.id))
    return inputDevices.filter((d) => !used.has(d.name))
  }, [selectedDevice, inputDevices])

  const availableMonitorsToAdd = useMemo(() => {
    if (!selectedDevice) return []
    const used = new Set(selectedDevice.monitors.map((m) => m.name))
    return outputDevices.filter((d) => !used.has(d.name))
  }, [selectedDevice, outputDevices])

  const deviceLevels = selectedId ? levels[selectedId] : undefined

  return (
    <div className="app">
      <header className="header">
        <h1>YomagAudio</h1>
        <p>A transit system for your audio</p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <nav className="view-tabs">
        <div className="view-tabs-group">
          <button className={view === "routing" ? "active" : ""} onClick={() => setView("routing")}>
            Routing
          </button>
          <button className={view === "applications" ? "active" : ""} onClick={() => setView("applications")}>
            Applications
          </button>
          <button className={view === "network" ? "active" : ""} onClick={() => setView("network")}>
            Network
          </button>
        </div>
        <button className="settings-tab-button" onClick={() => setShowSettings(true)} title="System Settings">
          ⚙ Settings
        </button>
      </nav>

      {view === "applications" && (
        <div className="workspace">
          <main className="main">
            <ApplicationsPanel
              sessions={appSessions}
              virtualDevices={virtualDevices}
              onAddDestination={(deviceId, sourceId) => handleAddSource(deviceId, sourceId)}
              onRemoveDestination={(deviceId, sourceId) => handleRemoveSource(deviceId, sourceId)}
              onGain={(deviceId, sourceId, gain) => handleSourceGain(deviceId, sourceId, gain)}
              onMute={(deviceId, sourceId, muted) => handleSourceMute(deviceId, sourceId, muted)}
              onCreateDevice={handleCreate}
            />
          </main>
        </div>
      )}

      {view === "network" && (
        <div className="workspace">
          <main className="main">
            <NetworkPanel
              systemEndpoints={systemEndpoints}
              peers={peers}
              virtualDevices={virtualDevices}
              onCreateSystemEndpoint={handleCreateSystemEndpoint}
              onRemoveSystemEndpoint={handleRemoveSystemEndpoint}
              onTogglePublish={handleTogglePublished}
              onAddNetworkSource={handleAddNetworkSource}
              onRemoveNetworkSource={handleRemoveSource}
            />
          </main>
        </div>
      )}

      {view === "routing" && (
      <div className="workspace">
        <Sidebar
          devices={virtualDevices}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onToggleEnabled={handleToggleEnabled}
          onRename={handleRename}
        />

        <main className="main">
          {selectedDevice ? (
            <>
              <div className="main-toolbar">
                <h2>{selectedDevice.name}</h2>
                <div className="main-toolbar-actions">
                  <label className="publish-toggle" title="Broadcast this device's mix to other YomagAudio instances on the LAN">
                    <input
                      type="checkbox"
                      checked={selectedDevice.is_published}
                      disabled={!selectedDevice.enabled}
                      onChange={(e) => handleTogglePublished(selectedDevice.id, e.target.checked)}
                    />
                    Publish to Network
                  </label>
                  <button className="btn btn-secondary" onClick={refreshPhysicalDevices}>
                    Refresh Devices
                  </button>
                  <button className="btn btn-secondary" onClick={handleSaveProfile}>
                    Save Profile
                  </button>
                  <button className="btn btn-secondary" onClick={handleLoadProfile} disabled={busy || !hasSavedProfile}>
                    Load Profile
                  </button>
                </div>
              </div>

              <RoutingPanel
                device={selectedDevice}
                availableSourcesToAdd={availableSourcesToAdd}
                availableMonitorsToAdd={availableMonitorsToAdd}
                sourceLevels={deviceLevels?.source_levels ?? {}}
                outputLevels={deviceLevels?.output_levels ?? []}
                sourceStats={deviceLevels?.source_stats ?? {}}
                monitorStats={deviceLevels?.monitor_stats ?? {}}
                showMonitors={showMonitors}
                onToggleShowMonitors={() => setShowMonitors((v) => !v)}
                onAddSource={(sourceId) => handleAddSource(selectedDevice.id, sourceId)}
                onRemoveSource={(sourceId) => handleRemoveSource(selectedDevice.id, sourceId)}
                onSourceGain={(sourceId, gain) => handleSourceGain(selectedDevice.id, sourceId, gain)}
                onSourceMute={(sourceId, muted) => handleSourceMute(selectedDevice.id, sourceId, muted)}
                onToggleConnection={(sourceId, sourceChannel, outputChannel) => {
                  const already = selectedDevice.connections.some(
                    (c) =>
                      c.source_id === sourceId &&
                      c.source_channel === sourceChannel &&
                      c.output_channel === outputChannel
                  )
                  handleToggleConnection(selectedDevice.id, sourceId, sourceChannel, outputChannel, already)
                }}
                onAddOutputPair={() => handleAddOutputPair(selectedDevice.id, selectedDevice.output_channels)}
                onAddMonitor={(name) => handleAddMonitor(selectedDevice.id, name)}
                onRemoveMonitor={(name) => handleRemoveMonitor(selectedDevice.id, name)}
                onSetMonitorChannel={(monitorName, monitorChannel, outputChannel) =>
                  handleSetMonitorChannel(selectedDevice.id, monitorName, monitorChannel, outputChannel)
                }
                onClearMonitorChannel={(monitorName, monitorChannel) =>
                  handleClearMonitorChannel(selectedDevice.id, monitorName, monitorChannel)
                }
                onSetMonitorExclusive={(monitorName, exclusive) =>
                  handleSetMonitorExclusive(selectedDevice.id, monitorName, exclusive)
                }
                onSetMonitorBufferMs={(monitorName, ms) =>
                  handleSetMonitorBufferMs(selectedDevice.id, monitorName, ms)
                }
                onSetMonitorDelayMs={(monitorName, ms) =>
                  handleSetMonitorDelayMs(selectedDevice.id, monitorName, ms)
                }
                onSetMonitorEq={(monitorName, bands) =>
                  handleSetMonitorEq(selectedDevice.id, monitorName, bands)
                }
              />
            </>
          ) : (
            <div className="empty-state">
              <p>No virtual device selected.</p>
              <button className="btn btn-primary" onClick={handleCreate}>
                Create your first virtual device
              </button>
            </div>
          )}
        </main>
      </div>
      )}

      <footer className="footer">
        <p>YomagAudio &middot; GPL-3.0 License</p>
      </footer>

      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          physicalDevices={physicalDevices}
          virtualDevices={virtualDevices}
          engineInfo={engineInfo}
          onSetMonitorBufferMs={handleSetMonitorBufferMs}
          onSetMonitorDelayMs={handleSetMonitorDelayMs}
          onSetMonitorExclusive={handleSetMonitorExclusive}
        />
      )}

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>YomagAudio</h2>
            <p>A transit system for your audio</p>
            <p className="about-meta">Version 0.1.0 &middot; GPL-3.0 License</p>
            <button className="btn btn-primary" onClick={() => setShowAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
