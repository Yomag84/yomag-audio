import type { AudioDeviceInfo, LevelsEvent, VirtualDeviceSnapshot } from "../types"
import type { VirtualDeviceSourceOption } from "../components/SourcePicker"

const VDEV_SOURCE_PREFIX = "vdev:"

/** Best-effort client-side mirror of the Rust side's cycle guard (see
 * `Router::would_create_cycle`) - purely to keep an obviously-cyclic device
 * out of a picker/menu's list in the first place; the backend is still the
 * authority that actually rejects the request if this misses anything. */
export function wouldCreateVdevCycle(
  devices: VirtualDeviceSnapshot[],
  targetId: string,
  candidateSourceId: string
): boolean {
  const byId = new Map(devices.map((d) => [d.id, d]))
  const stack = [candidateSourceId]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === targetId) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const source of byId.get(current)?.sources ?? []) {
      if (source.id.startsWith(VDEV_SOURCE_PREFIX)) {
        stack.push(source.id.slice(VDEV_SOURCE_PREFIX.length))
      }
    }
  }
  return false
}

export function peakLevel(channels: number[] | undefined): number {
  return channels && channels.length > 0 ? Math.max(...channels) : 0
}

/** Physical input devices `device` doesn't already have as a source. */
export function availableInputDevices(
  device: VirtualDeviceSnapshot,
  inputDevices: AudioDeviceInfo[]
): AudioDeviceInfo[] {
  const used = new Set(device.sources.map((s) => s.id))
  return inputDevices.filter((d) => !used.has(d.name))
}

/** Physical output devices `device` isn't already monitoring to. */
export function availableMonitorDevices(
  device: VirtualDeviceSnapshot,
  outputDevices: AudioDeviceInfo[]
): AudioDeviceInfo[] {
  const used = new Set(device.monitors.map((m) => m.name))
  return outputDevices.filter((d) => !used.has(d.name))
}

/** Other virtual devices `device` could take on as a nested source, with
 * an already-a-source or would-create-a-loop candidate filtered out. */
export function availableVirtualDeviceSources(
  device: VirtualDeviceSnapshot,
  allDevices: VirtualDeviceSnapshot[],
  levels: LevelsEvent
): VirtualDeviceSourceOption[] {
  const used = new Set(device.sources.map((s) => s.id))
  return allDevices
    .filter((d) => d.id !== device.id)
    .filter((d) => !used.has(`${VDEV_SOURCE_PREFIX}${d.id}`))
    .filter((d) => !wouldCreateVdevCycle(allDevices, device.id, d.id))
    .map((d) => ({ id: d.id, name: d.name, level: peakLevel(levels[d.id]?.output_levels) }))
}
