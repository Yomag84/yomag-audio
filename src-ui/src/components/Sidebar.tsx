import { useState } from "react"
import type { AppAudioSession, AudioDeviceInfo, LevelsEvent, VirtualDeviceSnapshot } from "../types"
import { ContextMenu, useContextMenu, type ContextMenuEntry } from "./ContextMenu"
import { availableInputDevices, availableMonitorDevices, availableVirtualDeviceSources } from "../lib/availability"
import {
  buildAddMonitorSubmenu,
  buildAddSourceSubmenu,
  buildOutputChannelSubmenu,
  OUTPUT_CHANNEL_PRESETS,
} from "../lib/deviceContextMenu"
import "./Sidebar.css"

interface SidebarProps {
  devices: VirtualDeviceSnapshot[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: (outputChannels: number) => void
  onDelete: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onRename: (id: string, name: string) => void
  inputDevices: AudioDeviceInfo[]
  outputDevices: AudioDeviceInfo[]
  appSessions: AppAudioSession[]
  levels: LevelsEvent
  onAddSource: (deviceId: string, sourceId: string) => void
  onAddApplicationSource: (deviceId: string, session: AppAudioSession) => void
  onAddVirtualDeviceSource: (deviceId: string, sourceDeviceId: string) => void
  onAddMonitor: (deviceId: string, monitorName: string) => void
  onSetOutputChannels: (deviceId: string, count: number) => void
}

export function Sidebar({
  devices,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  onToggleEnabled,
  onRename,
  inputDevices,
  outputDevices,
  appSessions,
  levels,
  onAddSource,
  onAddApplicationSource,
  onAddVirtualDeviceSource,
  onAddMonitor,
  onSetOutputChannels,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")
  const { menu, open: openContextMenu, close: closeContextMenu } = useContextMenu()

  const startRename = (device: VirtualDeviceSnapshot) => {
    setEditingId(device.id)
    setEditingName(device.name)
  }

  const commitRename = () => {
    if (editingId && editingName.trim()) {
      onRename(editingId, editingName.trim())
    }
    setEditingId(null)
  }

  const buildDeviceMenu = (device: VirtualDeviceSnapshot): ContextMenuEntry[] => [
    { label: "Rename Device", onSelect: () => startRename(device) },
    {
      label: device.enabled ? "Disable Device" : "Enable Device",
      onSelect: () => onToggleEnabled(device.id, !device.enabled),
    },
    { type: "separator" },
    {
      label: "Add Source",
      submenu: buildAddSourceSubmenu({
        devices: availableInputDevices(device, inputDevices),
        appSessions,
        virtualDevices: availableVirtualDeviceSources(device, devices, levels),
        onAddDevice: (name) => onAddSource(device.id, name),
        onAddApplication: (session) => onAddApplicationSource(device.id, session),
        onAddVirtualDevice: (sourceDeviceId) => onAddVirtualDeviceSource(device.id, sourceDeviceId),
      }),
    },
    {
      label: "Set Output Channels",
      submenu: buildOutputChannelSubmenu(device.output_channels, (count) => onSetOutputChannels(device.id, count)),
    },
    {
      label: "Add Monitor",
      submenu: buildAddMonitorSubmenu(availableMonitorDevices(device, outputDevices), (name) =>
        onAddMonitor(device.id, name)
      ),
    },
    { type: "separator" },
    { label: "Delete Device", danger: true, onSelect: () => onDelete(device.id) },
  ]

  return (
    <aside className="sidebar">
      <ContextMenu menu={menu} onClose={closeContextMenu} />
      <div className="sidebar-header">Devices</div>

      <div className="sidebar-list">
        {devices.map((device) => (
          <div
            key={device.id}
            className={`sidebar-item ${selectedId === device.id ? "selected" : ""}`}
            onClick={() => onSelect(device.id)}
            onContextMenu={(e) => {
              onSelect(device.id)
              openContextMenu(e, buildDeviceMenu(device))
            }}
          >
            <div className="sidebar-item-top">
              {editingId === device.id ? (
                <input
                  className="sidebar-rename-input"
                  autoFocus
                  value={editingName}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                />
              ) : (
                <span
                  className="sidebar-item-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRename(device)
                  }}
                >
                  {device.name}
                </span>
              )}
              <label className="toggle" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={device.enabled}
                  onChange={(e) => onToggleEnabled(device.id, e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
            <div className="sidebar-item-summary">
              {device.sources.length} source{device.sources.length === 1 ? "" : "s"}
              {" · "}
              {device.output_channels} ch
              {device.monitors.length > 0 && ` · ${device.monitors.length} monitor${device.monitors.length === 1 ? "" : "s"}`}
            </div>
          </div>
        ))}
        {devices.length === 0 && <p className="sidebar-empty">No virtual devices yet</p>}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-create-group" role="group" aria-label="New virtual device channel count">
          <span className="sidebar-create-label">New:</span>
          {OUTPUT_CHANNEL_PRESETS.map((count) => (
            <button
              key={count}
              className="btn-preset"
              onClick={() => onCreate(count)}
              title={`Create a new ${count}-channel virtual device`}
            >
              {count}
            </button>
          ))}
        </div>
        <button
          className="btn-icon"
          onClick={() => selectedId && onDelete(selectedId)}
          disabled={!selectedId}
          title="Delete selected device"
        >
          −
        </button>
      </div>
    </aside>
  )
}
