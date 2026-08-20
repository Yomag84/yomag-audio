import type { ContextMenuEntry } from "../components/ContextMenu"
import type { VirtualDeviceSourceOption } from "../components/SourcePicker"
import type { AppAudioSession, AudioDeviceInfo } from "../types"

/** Canonical output-channel presets, used by the sidebar's "New device"
 * buttons, the routing panel's "Output Channels" header, and every
 * "Set Output Channels" context menu built here - one list so the three
 * never drift out of sync. */
export const OUTPUT_CHANNEL_PRESETS = [2, 8, 16, 32] as const

interface AddSourceMenuOptions {
  devices: AudioDeviceInfo[]
  appSessions: AppAudioSession[]
  virtualDevices: VirtualDeviceSourceOption[]
  onAddDevice: (name: string) => void
  onAddApplication: (session: AppAudioSession) => void
  onAddVirtualDevice: (deviceId: string) => void
}

/** Flat "Add Source" submenu spanning all three source categories (see
 * SourcePicker for the equivalent grouped popover) - grouped visually with
 * separators rather than nested sub-submenus, since a menu three levels
 * deep is more fragile to use than a single scrollable flat list. */
export function buildAddSourceSubmenu(opts: AddSourceMenuOptions): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = []

  opts.devices.forEach((d) => items.push({ label: d.name, hint: "device", onSelect: () => opts.onAddDevice(d.name) }))

  if (items.length > 0 && opts.appSessions.length > 0) items.push({ type: "separator" })
  opts.appSessions.forEach((s) =>
    items.push({ label: s.display_name, hint: "app", onSelect: () => opts.onAddApplication(s) })
  )

  if (items.length > 0 && opts.virtualDevices.length > 0) items.push({ type: "separator" })
  opts.virtualDevices.forEach((vd) =>
    items.push({ label: vd.name, hint: "virtual", onSelect: () => opts.onAddVirtualDevice(vd.id) })
  )

  return items
}

export function buildOutputChannelSubmenu(
  currentCount: number,
  onSet: (count: number) => void
): ContextMenuEntry[] {
  return OUTPUT_CHANNEL_PRESETS.map((count) => ({
    label: `${count} channels`,
    checked: currentCount === count,
    onSelect: () => onSet(count),
  }))
}

export function buildAddMonitorSubmenu(
  devices: AudioDeviceInfo[],
  onAdd: (name: string) => void
): ContextMenuEntry[] {
  return devices.map((d) => ({ label: d.name, onSelect: () => onAdd(d.name) }))
}
