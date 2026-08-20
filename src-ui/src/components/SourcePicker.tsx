import { useEffect, useRef, useState } from "react"
import type { AppAudioSession, AudioDeviceInfo } from "../types"
import { appSourceId } from "./ApplicationsPanel"
import { meterFillStyle } from "../lib/meter"
import "./SourcePicker.css"

export interface VirtualDeviceSourceOption {
  id: string
  name: string
  level: number
}

interface SourcePickerProps {
  devices: AudioDeviceInfo[]
  deviceMeters: Record<string, number>
  appSessions: AppAudioSession[]
  virtualDevices: VirtualDeviceSourceOption[]
  onAddDevice: (name: string) => void
  onAddApplication: (session: AppAudioSession) => void
  onAddVirtualDevice: (deviceId: string) => void
}

/** Unified "Add Source" browser: physical input devices, running
 * applications, and other virtual devices (for nesting one device's mix
 * into another), each row showing a live level meter so you can see what's
 * actually making sound before wiring it in. */
export function SourcePicker({
  devices,
  deviceMeters,
  appSessions,
  virtualDevices,
  onAddDevice,
  onAddApplication,
  onAddVirtualDevice,
}: SourcePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open])

  const isEmpty = devices.length === 0 && appSessions.length === 0 && virtualDevices.length === 0

  return (
    <div className="source-picker" ref={containerRef}>
      <button className="btn-icon" onClick={() => setOpen((v) => !v)} title="Add a source">
        +
      </button>
      {open && (
        <div className="source-picker-popover">
          {isEmpty && <p className="source-picker-empty">Nothing available to add right now</p>}

          {devices.length > 0 && (
            <section className="source-picker-group">
              <h4>Devices</h4>
              {devices.map((d) => (
                <button
                  key={d.name}
                  className="source-picker-row"
                  onClick={() => {
                    onAddDevice(d.name)
                    setOpen(false)
                  }}
                >
                  <span className="source-picker-row-name" title={d.name}>
                    {d.name}
                  </span>
                  <span className="source-picker-meter">
                    <span className="source-picker-meter-fill" style={meterFillStyle(deviceMeters[d.name])} />
                  </span>
                </button>
              ))}
            </section>
          )}

          {appSessions.length > 0 && (
            <section className="source-picker-group">
              <h4>Applications</h4>
              {appSessions.map((session) => (
                <button
                  key={appSourceId(session)}
                  className="source-picker-row"
                  onClick={() => {
                    onAddApplication(session)
                    setOpen(false)
                  }}
                >
                  <span className="source-picker-row-name" title={session.process_name}>
                    {session.display_name}
                  </span>
                  <span className="source-picker-meter">
                    <span className="source-picker-meter-fill" style={meterFillStyle(session.level)} />
                  </span>
                </button>
              ))}
            </section>
          )}

          {virtualDevices.length > 0 && (
            <section className="source-picker-group">
              <h4>Virtual Devices</h4>
              {virtualDevices.map((vd) => (
                <button
                  key={vd.id}
                  className="source-picker-row"
                  onClick={() => {
                    onAddVirtualDevice(vd.id)
                    setOpen(false)
                  }}
                >
                  <span className="source-picker-row-name" title={vd.name}>
                    {vd.name}
                  </span>
                  <span className="source-picker-meter">
                    <span className="source-picker-meter-fill" style={meterFillStyle(vd.level)} />
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
