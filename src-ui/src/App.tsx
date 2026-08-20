import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-shell"
import { Sidebar } from "./components/Sidebar"
import { RoutingPanel } from "./components/RoutingPanel"
import { NetworkPanel } from "./components/NetworkPanel"
import { ApplicationsPanel, appSourceId } from "./components/ApplicationsPanel"
import { SettingsDialog } from "./components/SettingsDialog"
import { RecordingsPanel } from "./components/RecordingsPanel"
import { RecordingDetailModal } from "./components/RecordingDetailModal"
import { AboutDialog } from "./components/AboutDialog"
import { DocumentationModal } from "./components/DocumentationModal"
import { EditorPage } from "./components/editor/EditorPage"
import { useDeviceLevels } from "./hooks/useDeviceLevels"
import { availableInputDevices, availableMonitorDevices, availableVirtualDeviceSources } from "./lib/availability"
import { DISCORD_URL, DOCS_ISSUES_URL, DOCS_SPONSOR_URL } from "./lib/links"
import type {
  AppAudioSession,
  AudioDeviceInfo,
  EngineInfo,
  EqBand,
  InternalDeviceGuess,
  PeerSnapshot,
  RecordingSummary,
  VirtualDeviceSnapshot,
} from "./types"
import "./App.css"

type View = "routing" | "applications" | "network" | "recordings" | "editor"
type Theme = "light" | "dark"

const THEME_STORAGE_KEY = "yomag-theme"

function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === "light" || stored === "dark") return stored
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function App() {
  const [view, setView] = useState<View>("routing")
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [physicalDevices, setPhysicalDevices] = useState<AudioDeviceInfo[]>([])
  const [virtualDevices, setVirtualDevices] = useState<VirtualDeviceSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMonitors, setShowMonitors] = useState(false)
  const [hasSavedProfile, setHasSavedProfile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showDocumentation, setShowDocumentation] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null)
  const [systemEndpoints, setSystemEndpoints] = useState<string[]>([])
  const [peers, setPeers] = useState<PeerSnapshot[]>([])
  const [appSessions, setAppSessions] = useState<AppAudioSession[]>([])
  const [deviceMeters, setDeviceMeters] = useState<Record<string, number>>({})
  const [recordings, setRecordings] = useState<RecordingSummary[]>([])
  const [recordingsLoading, setRecordingsLoading] = useState(false)
  const [detailSession, setDetailSession] = useState<RecordingSummary | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [activeRecordingDeviceId, setActiveRecordingDeviceId] = useState<string | null>(null)
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null)
  const [recordingElapsedLabel, setRecordingElapsedLabel] = useState("0:00")
  const selectedIdRef = useRef<string | null>(null)

  const levels = useDeviceLevels()

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

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
    // Also needed on the Routing view now: the unified "Add Source" picker
    // (see SourcePicker) lists running applications alongside devices and
    // other virtual devices.
    if (view !== "applications" && view !== "routing") return
    refreshAppSessions()
    // Each call spawns a dedicated OS thread and does a full COM session
    // enumeration (see list_app_sessions) - real background work that
    // competes with the real-time mixer/capture threads for scheduling.
    // Apps don't start/stop playing audio often enough to need this
    // faster than every few seconds.
    const interval = setInterval(refreshAppSessions, 4000)
    return () => clearInterval(interval)
  }, [view, refreshAppSessions])

  const refreshDeviceMeters = useCallback(async () => {
    try {
      setDeviceMeters(await invoke<Record<string, number>>("list_device_meters"))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    // Powers the source picker's device meters - only worth polling while
    // the Routing view (the only place that picker appears) is open.
    if (view !== "routing") return
    refreshDeviceMeters()
    const interval = setInterval(refreshDeviceMeters, 1000)
    return () => clearInterval(interval)
  }, [view, refreshDeviceMeters])

  const refreshRecordings = useCallback(async () => {
    setRecordingsLoading(true)
    try {
      setRecordings(await invoke<RecordingSummary[]>("list_recordings"))
    } catch (err) {
      setError(String(err))
    } finally {
      setRecordingsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (view !== "recordings") return
    refreshRecordings()
  }, [view, refreshRecordings])

  useEffect(() => {
    if (recordingStartedAt === null) return
    const update = () => {
      const totalSeconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000))
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      setRecordingElapsedLabel(`${minutes}:${seconds.toString().padStart(2, "0")}`)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [recordingStartedAt])

  const handleStartRecording = async () => {
    if (!selectedDevice) return
    setError(null)
    try {
      await invoke<string>("start_recording", { deviceId: selectedDevice.id, name: null })
      setActiveRecordingDeviceId(selectedDevice.id)
      setRecordingStartedAt(Date.now())
    } catch (err) {
      setError(String(err))
    }
  }

  const handleStopRecording = async () => {
    if (!activeRecordingDeviceId) return
    setError(null)
    try {
      const summary = await invoke<RecordingSummary>("stop_recording", { deviceId: activeRecordingDeviceId })
      setActiveRecordingDeviceId(null)
      setRecordingStartedAt(null)
      setView("recordings")
      await refreshRecordings()
      setDetailSession(summary)
    } catch (err) {
      setError(String(err))
    }
  }

  const handleRenameRecording = async (sessionId: string, name: string) => {
    setError(null)
    try {
      await invoke("rename_recording", { sessionId, newName: name })
      await refreshRecordings()
      setDetailSession((current) => (current?.session_id === sessionId ? { ...current, name } : current))
    } catch (err) {
      setError(String(err))
    }
  }

  const handleDeleteRecording = async (sessionId: string) => {
    setError(null)
    try {
      await invoke("delete_recording", { sessionId })
      await refreshRecordings()
      setDetailSession((current) => (current?.session_id === sessionId ? null : current))
    } catch (err) {
      setError(String(err))
    }
  }

  const handleOpenEditor = (sessionId: string) => {
    setDetailSession(null)
    setEditingSessionId(sessionId)
    setView("editor")
  }

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

  const handleCreate = (outputChannels: number = 2) =>
    run(async () => {
      const id = await invoke<string>("create_virtual_device", { name: "New Virtual Device" })
      // New devices default to 2 output channels (see VirtualDevice::new) -
      // only make the extra round-trip when a wider preset was requested.
      if (outputChannels !== 2) {
        await invoke("set_device_output_channels", { deviceId: id, count: outputChannels })
      }
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

  const handleSetOutputChannels = (id: string, count: number) =>
    run(() => invoke("set_device_output_channels", { deviceId: id, count }))

  const handleAddSource = (id: string, sourceId: string) =>
    run(() => invoke("add_device_source", { deviceId: id, sourceId }))

  const handleAddApplicationSource = (id: string, session: AppAudioSession) =>
    handleAddSource(id, appSourceId(session))

  const handleAddVirtualDeviceSource = (id: string, sourceDeviceId: string) =>
    run(() => invoke("add_virtual_device_source", { deviceId: id, sourceDeviceId }))

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

  /** One-click "send audio to Zoom/Teams/WhatsApp/…" flow: Windows has no
   * API to inject audio directly into another process, so the only real
   * mechanism is the same one VB-Cable/Voicemeeter use - create a virtual
   * microphone via the kernel driver, route this device's mix onto it, and
   * have the user pick it as their input device inside the target app's
   * own settings. This composes create_system_endpoint + add_monitor +
   * set_monitor_channel (mirroring App.tsx's own first-run mic/speaker
   * wiring) into that one step, then hands the monitor name back so the
   * caller can tell the user exactly what to select. */
  const handleQuickRouteToApp = async (appLabel: string, targetDeviceId: string): Promise<string | null> => {
    setError(null)
    const monitorName = `YomagAudio for ${appLabel}`
    try {
      await invoke("create_system_endpoint", { name: monitorName })
      await refreshSystemEndpoints()
      await invoke("add_monitor", { deviceId: targetDeviceId, monitorName })
      const device = virtualDevices.find((d) => d.id === targetDeviceId)
      const channelCount = Math.min(device?.output_channels ?? 2, 2)
      for (let channel = 0; channel < channelCount; channel += 1) {
        await invoke("set_monitor_channel", {
          deviceId: targetDeviceId,
          monitorName,
          monitorChannel: channel,
          outputChannel: channel,
        })
      }
      await refreshVirtualDevices()
      return monitorName
    } catch (err) {
      setError(String(err))
      return null
    }
  }

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
      listen("menu://documentation", () => setShowDocumentation(true)),
      listen("menu://report-issue", () => open(DOCS_ISSUES_URL)),
      listen("menu://discord", () => open(DISCORD_URL)),
      listen("menu://sponsor", () => open(DOCS_SPONSOR_URL)),
      listen("menu://settings", () => setShowSettings(true)),
    ]
    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()))
    }
  }, [])

  const selectedDevice = virtualDevices.find((d) => d.id === selectedId) ?? null
  const inputDevices = useMemo(() => physicalDevices.filter((d) => d.is_input), [physicalDevices])
  const outputDevices = useMemo(() => physicalDevices.filter((d) => !d.is_input), [physicalDevices])

  const availableSourcesToAdd = useMemo(
    () => (selectedDevice ? availableInputDevices(selectedDevice, inputDevices) : []),
    [selectedDevice, inputDevices]
  )

  const availableMonitorsToAdd = useMemo(
    () => (selectedDevice ? availableMonitorDevices(selectedDevice, outputDevices) : []),
    [selectedDevice, outputDevices]
  )

  const availableVirtualDeviceSourcesToAdd = useMemo(
    () => (selectedDevice ? availableVirtualDeviceSources(selectedDevice, virtualDevices, levels) : []),
    [selectedDevice, virtualDevices, levels]
  )

  const deviceLevels = selectedId ? levels[selectedId] : undefined

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <span className="header-logo" aria-hidden="true">
            <img src="/app-icon.png" alt="" width="24" height="24" />
          </span>
          <div className="header-titles">
            <h1>YomagAudio</h1>
            <p>A transit system for your audio</p>
          </div>
        </div>
        <div className="theme-toggle" role="radiogroup" aria-label="Theme">
          <button
            type="button"
            role="radio"
            aria-checked={theme === "light"}
            className={`theme-toggle-option ${theme === "light" ? "active" : ""}`}
            title="Light theme"
            onClick={() => setTheme("light")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="4.5" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="12" y1="1.5" x2="12" y2="4.5" />
                <line x1="12" y1="19.5" x2="12" y2="22.5" />
                <line x1="1.5" y1="12" x2="4.5" y2="12" />
                <line x1="19.5" y1="12" x2="22.5" y2="12" />
                <line x1="4.4" y1="4.4" x2="6.5" y2="6.5" />
                <line x1="17.5" y1="17.5" x2="19.6" y2="19.6" />
                <line x1="4.4" y1="19.6" x2="6.5" y2="17.5" />
                <line x1="17.5" y1="6.5" x2="19.6" y2="4.4" />
              </g>
            </svg>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === "dark"}
            className={`theme-toggle-option ${theme === "dark" ? "active" : ""}`}
            title="Dark theme"
            onClick={() => setTheme("dark")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M20.5 14.5A9 9 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
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
          <button className={view === "recordings" ? "active" : ""} onClick={() => setView("recordings")}>
            Recordings
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
              onCreateDevice={() => handleCreate()}
            />
          </main>
        </div>
      )}

      {view === "recordings" && (
        <div className="workspace">
          <main className="main">
            <RecordingsPanel
              recordings={recordings}
              loading={recordingsLoading}
              onRefresh={refreshRecordings}
              onOpen={setDetailSession}
              onDelete={handleDeleteRecording}
            />
          </main>
        </div>
      )}

      {view === "editor" && editingSessionId && (
        <EditorPage
          sessionId={editingSessionId}
          onExit={() => {
            setEditingSessionId(null)
            setView("recordings")
          }}
        />
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
              onQuickRouteToApp={handleQuickRouteToApp}
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
          inputDevices={inputDevices}
          outputDevices={outputDevices}
          appSessions={appSessions}
          levels={levels}
          onAddSource={handleAddSource}
          onAddApplicationSource={handleAddApplicationSource}
          onAddVirtualDeviceSource={handleAddVirtualDeviceSource}
          onAddMonitor={handleAddMonitor}
          onSetOutputChannels={handleSetOutputChannels}
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
                  {activeRecordingDeviceId === selectedDevice.id ? (
                    <button className="btn btn-record recording" onClick={handleStopRecording}>
                      <span className="record-dot" aria-hidden="true" />
                      Stop ({recordingElapsedLabel})
                    </button>
                  ) : (
                    <button
                      className="btn btn-record"
                      onClick={handleStartRecording}
                      disabled={activeRecordingDeviceId !== null || selectedDevice.sources.length === 0}
                      title={
                        selectedDevice.sources.length === 0
                          ? "Add a source to this device before recording"
                          : "Record every current source of this device to its own track"
                      }
                    >
                      <span className="record-dot" aria-hidden="true" />
                      Record
                    </button>
                  )}
                </div>
              </div>

              <RoutingPanel
                device={selectedDevice}
                availableSourcesToAdd={availableSourcesToAdd}
                availableMonitorsToAdd={availableMonitorsToAdd}
                availableVirtualDeviceSourcesToAdd={availableVirtualDeviceSourcesToAdd}
                appSessions={appSessions}
                deviceMeters={deviceMeters}
                sourceLevels={deviceLevels?.source_levels ?? {}}
                outputLevels={deviceLevels?.output_levels ?? []}
                sourceStats={deviceLevels?.source_stats ?? {}}
                monitorStats={deviceLevels?.monitor_stats ?? {}}
                showMonitors={showMonitors}
                onToggleShowMonitors={() => setShowMonitors((v) => !v)}
                onAddSource={(sourceId) => handleAddSource(selectedDevice.id, sourceId)}
                onAddApplicationSource={(session) => handleAddApplicationSource(selectedDevice.id, session)}
                onAddVirtualDeviceSource={(sourceDeviceId) =>
                  handleAddVirtualDeviceSource(selectedDevice.id, sourceDeviceId)
                }
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
                onSetOutputChannels={(count) => handleSetOutputChannels(selectedDevice.id, count)}
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
              <button className="btn btn-primary" onClick={() => handleCreate()}>
                Create your first virtual device
              </button>
            </div>
          )}
        </main>
      </div>
      )}

      <footer className="footer">
        <p>YomagAudio &middot; GPL-3.0 License</p>
        <div className="footer-links">
          <button onClick={() => setShowDocumentation(true)}>Documentation</button>
          <button onClick={() => open(DISCORD_URL)}>Discord</button>
          <button className="footer-sponsor-link" onClick={() => open(DOCS_SPONSOR_URL)}>
            ❤ Sponsor
          </button>
        </div>
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

      {detailSession && (
        <RecordingDetailModal
          key={detailSession.session_id}
          session={detailSession}
          onClose={() => setDetailSession(null)}
          onRename={handleRenameRecording}
          onDelete={handleDeleteRecording}
          onOpenEditor={handleOpenEditor}
        />
      )}

      {showAbout && (
        <AboutDialog
          onClose={() => setShowAbout(false)}
          onOpenDocumentation={() => {
            setShowAbout(false)
            setShowDocumentation(true)
          }}
        />
      )}

      {showDocumentation && <DocumentationModal onClose={() => setShowDocumentation(false)} />}
    </div>
  )
}

export default App
