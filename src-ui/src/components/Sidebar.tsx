import { useState } from "react"
import type { VirtualDeviceSnapshot } from "../types"
import "./Sidebar.css"

interface SidebarProps {
  devices: VirtualDeviceSnapshot[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onRename: (id: string, name: string) => void
}

export function Sidebar({
  devices,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  onToggleEnabled,
  onRename,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState("")

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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">Devices</div>

      <div className="sidebar-list">
        {devices.map((device) => (
          <div
            key={device.id}
            className={`sidebar-item ${selectedId === device.id ? "selected" : ""}`}
            onClick={() => onSelect(device.id)}
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
        <button className="btn-icon" onClick={onCreate} title="New Virtual Device">
          +
        </button>
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
