import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import type { AudioDeviceInfo, Connection, EqBand, StreamStats, VirtualDeviceSnapshot } from "../types"
import { MonitorSettingsPanel } from "./MonitorSettingsPanel"
import "./RoutingPanel.css"

interface RoutingPanelProps {
  device: VirtualDeviceSnapshot
  availableSourcesToAdd: AudioDeviceInfo[]
  availableMonitorsToAdd: AudioDeviceInfo[]
  sourceLevels: Record<string, number[]>
  outputLevels: number[]
  sourceStats: Record<string, StreamStats>
  monitorStats: Record<string, StreamStats>
  showMonitors: boolean
  onToggleShowMonitors: () => void
  onAddSource: (sourceId: string) => void
  onRemoveSource: (sourceId: string) => void
  onSourceGain: (sourceId: string, gain: number) => void
  onSourceMute: (sourceId: string, muted: boolean) => void
  onToggleConnection: (sourceId: string, sourceChannel: number, outputChannel: number) => void
  onAddOutputPair: () => void
  onAddMonitor: (monitorName: string) => void
  onRemoveMonitor: (monitorName: string) => void
  onSetMonitorChannel: (monitorName: string, monitorChannel: number, outputChannel: number) => void
  onClearMonitorChannel: (monitorName: string, monitorChannel: number) => void
  onSetMonitorExclusive: (monitorName: string, exclusive: boolean) => void
  onSetMonitorBufferMs: (monitorName: string, ms: number) => void
  onSetMonitorDelayMs: (monitorName: string, ms: number) => void
  onSetMonitorEq: (monitorName: string, bands: EqBand[]) => void
}

type PendingSelection =
  | { kind: "source"; sourceId: string; channel: number }
  | { kind: "output"; channel: number }

function levelToWidth(peak: number | undefined): number {
  const v = peak ?? 0
  const db = v > 0 ? 20 * Math.log10(v) : -60
  const clamped = Math.max(-60, Math.min(0, db))
  return ((clamped + 60) / 60) * 100
}

function meterFillStyle(peak: number | undefined): CSSProperties {
  return { transform: `scaleX(${levelToWidth(peak) / 100})` }
}

function channelLabel(index: number): string {
  if (index === 0) return "L"
  if (index === 1) return "R"
  return String(index + 1)
}

function StatsBadge({ stats }: { stats: StreamStats | undefined }) {
  if (!stats) return null
  const hasIssue = stats.underruns > 0 || stats.overruns > 0
  return (
    <span
      className={`stats-badge ${hasIssue ? "warn" : ""}`}
      title={`buffered ${stats.buffered_ms.toFixed(1)}ms · ${stats.underruns} underruns · ${stats.overruns} overruns`}
    >
      {stats.buffered_ms.toFixed(0)}ms{hasIssue ? ` · ${stats.underruns}u/${stats.overruns}o` : ""}
    </span>
  )
}

export function RoutingPanel({
  device,
  availableSourcesToAdd,
  availableMonitorsToAdd,
  sourceLevels,
  outputLevels,
  sourceStats,
  monitorStats,
  showMonitors,
  onToggleShowMonitors,
  onAddSource,
  onRemoveSource,
  onSourceGain,
  onSourceMute,
  onToggleConnection,
  onAddOutputPair,
  onAddMonitor,
  onRemoveMonitor,
  onSetMonitorChannel,
  onClearMonitorChannel,
  onSetMonitorExclusive,
  onSetMonitorBufferMs,
  onSetMonitorDelayMs,
  onSetMonitorEq,
}: RoutingPanelProps) {
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [sourceToAdd, setSourceToAdd] = useState("")
  const [monitorToAdd, setMonitorToAdd] = useState("")
  const [paths, setPaths] = useState<{ key: string; d: string }[]>([])

  const containerRef = useRef<HTMLDivElement>(null)
  const sourceDotRefs = useRef(new Map<string, HTMLElement>())
  const outputInDotRefs = useRef(new Map<number, HTMLElement>())
  const outputOutDotRefs = useRef(new Map<number, HTMLElement>())
  const monitorDotRefs = useRef(new Map<string, HTMLElement>())

  const connectionKey = (c: Connection) => `conn::${c.source_id}::${c.source_channel}::${c.output_channel}`

  const outputChannelPairs = useMemo(() => {
    const pairs: number[][] = []
    for (let i = 0; i < device.output_channels; i += 2) {
      pairs.push(i + 1 < device.output_channels ? [i, i + 1] : [i])
    }
    return pairs
  }, [device.output_channels])

  useLayoutEffect(() => {
    const recompute = () => {
      const container = containerRef.current
      if (!container) return
      const bounds = container.getBoundingClientRect()
      const centerOf = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2 - bounds.left, y: r.top + r.height / 2 - bounds.top }
      }
      const bezier = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
        const midX = (p1.x + p2.x) / 2
        return `M ${p1.x} ${p1.y} C ${midX} ${p1.y}, ${midX} ${p2.y}, ${p2.x} ${p2.y}`
      }

      const next: { key: string; d: string }[] = []
      for (const conn of device.connections) {
        const sourceEl = sourceDotRefs.current.get(`${conn.source_id}::${conn.source_channel}`)
        const outputEl = outputInDotRefs.current.get(conn.output_channel)
        if (!sourceEl || !outputEl) continue
        next.push({ key: connectionKey(conn), d: bezier(centerOf(sourceEl), centerOf(outputEl)) })
      }

      if (showMonitors) {
        for (const monitor of device.monitors) {
          monitor.channel_map.forEach((outputChannel, monitorChannel) => {
            if (outputChannel === null) return
            const outputEl = outputOutDotRefs.current.get(outputChannel)
            const monitorEl = monitorDotRefs.current.get(`${monitor.name}::${monitorChannel}`)
            if (!outputEl || !monitorEl) return
            next.push({
              key: `mon::${monitor.name}::${monitorChannel}`,
              d: bezier(centerOf(outputEl), centerOf(monitorEl)),
            })
          })
        }
      }

      setPaths(next)
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener("resize", recompute)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", recompute)
    }
  }, [device.connections, device.sources, device.output_channels, device.monitors, showMonitors])

  const handleSourceDotClick = (sourceId: string, channel: number) => {
    if (pending?.kind === "source" && pending.sourceId === sourceId && pending.channel === channel) {
      setPending(null)
      return
    }
    setPending({ kind: "source", sourceId, channel })
  }

  const handleOutputInDotClick = (outputChannel: number) => {
    if (pending?.kind === "source") {
      onToggleConnection(pending.sourceId, pending.channel, outputChannel)
      setPending(null)
    }
  }

  const handleOutputOutDotClick = (outputChannel: number) => {
    if (pending?.kind === "output" && pending.channel === outputChannel) {
      setPending(null)
      return
    }
    setPending({ kind: "output", channel: outputChannel })
  }

  const handleMonitorDotClick = (monitorName: string, monitorChannel: number) => {
    if (pending?.kind === "output") {
      onSetMonitorChannel(monitorName, monitorChannel, pending.channel)
      setPending(null)
      return
    }
    if (pending) return
    const monitor = device.monitors.find((m) => m.name === monitorName)
    const current = monitor?.channel_map[monitorChannel]
    if (current !== null && current !== undefined) {
      onClearMonitorChannel(monitorName, monitorChannel)
    }
  }

  return (
    <div className="routing-panel">
      <div className="routing-columns" ref={containerRef}>
        <svg className="cable-svg">
          {paths.map((p) => (
            <path key={p.key} d={p.d} className="cable-path" />
          ))}
        </svg>

        <section className="routing-column sources-column">
          <div className="routing-column-header">
            <div>
              <h3>Sources</h3>
              <span className="routing-column-subtitle">{device.sources.length} sources</span>
            </div>
            <div className="add-control">
              <select value={sourceToAdd} onChange={(e) => setSourceToAdd(e.target.value)}>
                <option value="">Add source…</option>
                {availableSourcesToAdd.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                className="btn-icon"
                disabled={!sourceToAdd}
                onClick={() => {
                  onAddSource(sourceToAdd)
                  setSourceToAdd("")
                }}
              >
                +
              </button>
            </div>
          </div>

          <div className="routing-card-list">
            {device.sources.map((source) => (
              <div key={source.id} className="routing-card">
                <div className="routing-card-header">
                  <span className="routing-card-name" title={source.id}>
                    {source.id}
                  </span>
                  <StatsBadge stats={sourceStats[source.id]} />
                  <button className="chip-remove" onClick={() => onRemoveSource(source.id)}>
                    ×
                  </button>
                </div>
                <div className="channel-rows">
                  {Array.from({ length: source.channels }).map((_, ch) => {
                    const isPending = pending?.kind === "source" && pending.sourceId === source.id && pending.channel === ch
                    return (
                      <div key={ch} className="channel-row">
                        <span className="channel-label">{ch + 1} ({channelLabel(ch)})</span>
                        <div className="mini-meter">
                          <div
                            className="mini-meter-fill"
                            style={meterFillStyle(sourceLevels[source.id]?.[ch])}
                          />
                        </div>
                        <button
                          className={`channel-dot ${isPending ? "pending" : ""}`}
                          ref={(el) => {
                            if (el) sourceDotRefs.current.set(`${source.id}::${ch}`, el)
                            else sourceDotRefs.current.delete(`${source.id}::${ch}`)
                          }}
                          onClick={() => handleSourceDotClick(source.id, ch)}
                        />
                      </div>
                    )
                  })}
                </div>
                <div className="routing-card-footer">
                  <button
                    className={`btn-mute ${source.muted ? "muted" : ""}`}
                    onClick={() => onSourceMute(source.id, !source.muted)}
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
                    onChange={(e) => onSourceGain(source.id, Number(e.target.value))}
                  />
                  <span className="gain-label">{Math.round(source.gain * 100)}%</span>
                </div>
              </div>
            ))}
            {device.sources.length === 0 && <p className="routing-empty">No sources yet</p>}
          </div>
        </section>

        <section className="routing-column output-column">
          <div className="routing-column-header">
            <div>
              <h3>Output Channels</h3>
              <span className="routing-column-subtitle">{device.output_channels} channels</span>
            </div>
            <button className="btn-icon" onClick={onAddOutputPair} title="Add a channel pair">
              +
            </button>
          </div>

          <div className="routing-card-list">
            {outputChannelPairs.map((pair, i) => (
              <div key={i} className="routing-card">
                <div className="routing-card-header">
                  <span className="routing-card-name">
                    {pair.length === 2 ? `Channels ${pair[0] + 1} & ${pair[1] + 1}` : `Channel ${pair[0] + 1}`}
                  </span>
                </div>
                <div className="channel-rows">
                  {pair.map((ch) => {
                    const isPending = pending?.kind === "output" && pending.channel === ch
                    return (
                      <div key={ch} className="channel-row">
                        <button
                          className={`channel-dot dot-in ${pending?.kind === "source" ? "connectable" : ""}`}
                          title="Connect a source here"
                          ref={(el) => {
                            if (el) outputInDotRefs.current.set(ch, el)
                            else outputInDotRefs.current.delete(ch)
                          }}
                          onClick={() => handleOutputInDotClick(ch)}
                        />
                        <span className="channel-label">
                          Channel {ch + 1} ({channelLabel(ch)})
                        </span>
                        <div className="mini-meter">
                          <div
                            className="mini-meter-fill"
                            style={meterFillStyle(outputLevels[ch])}
                          />
                        </div>
                        <button
                          className={`channel-dot dot-out ${isPending ? "pending" : "connectable"}`}
                          title="Route this channel to a monitor"
                          ref={(el) => {
                            if (el) outputOutDotRefs.current.set(ch, el)
                            else outputOutDotRefs.current.delete(ch)
                          }}
                          onClick={() => handleOutputOutDotClick(ch)}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {showMonitors && (
          <section className="routing-column monitors-column">
            <div className="routing-column-header">
              <div>
                <h3>Monitors</h3>
                <span className="routing-column-subtitle">{device.monitors.length} devices</span>
              </div>
              <div className="add-control">
                <select value={monitorToAdd} onChange={(e) => setMonitorToAdd(e.target.value)}>
                  <option value="">Add monitor…</option>
                  {availableMonitorsToAdd.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-icon"
                  disabled={!monitorToAdd}
                  onClick={() => {
                    onAddMonitor(monitorToAdd)
                    setMonitorToAdd("")
                  }}
                >
                  +
                </button>
              </div>
            </div>
            <div className="routing-card-list">
              {device.monitors.map((monitor) => (
                <div key={monitor.name} className="routing-card">
                  <div className="routing-card-header">
                    <span className="routing-card-name" title={monitor.name}>
                      {monitor.name}
                    </span>
                    <StatsBadge stats={monitorStats[monitor.name]} />
                    <button className="chip-remove" onClick={() => onRemoveMonitor(monitor.name)}>
                      ×
                    </button>
                  </div>
                  <label
                    className="exclusive-toggle"
                    title="Open this device via WASAPI exclusive mode to reach its true channel count (e.g. a 16-channel virtual cable Windows is defaulting to fewer channels), at the cost of taking it away from every other app while active."
                  >
                    <input
                      type="checkbox"
                      checked={monitor.exclusive}
                      onChange={(e) => onSetMonitorExclusive(monitor.name, e.target.checked)}
                    />
                    Exclusive mode ({monitor.channels}ch)
                  </label>
                  <MonitorSettingsPanel
                    monitor={monitor}
                    onSetBufferMs={(ms) => onSetMonitorBufferMs(monitor.name, ms)}
                    onSetDelayMs={(ms) => onSetMonitorDelayMs(monitor.name, ms)}
                    onSetEq={(bands) => onSetMonitorEq(monitor.name, bands)}
                  />
                  <div className="channel-rows">
                    {monitor.channel_map.map((sourceOutputChannel, mc) => {
                      const connected = sourceOutputChannel !== null
                      return (
                        <div key={mc} className="channel-row">
                          <button
                            className={`channel-dot ${connected ? "connected" : ""}`}
                            title={connected ? "Click to disconnect" : "Click an output channel, then this dot, to connect"}
                            ref={(el) => {
                              const key = `${monitor.name}::${mc}`
                              if (el) monitorDotRefs.current.set(key, el)
                              else monitorDotRefs.current.delete(key)
                            }}
                            onClick={() => handleMonitorDotClick(monitor.name, mc)}
                          />
                          <span className="channel-label">
                            {mc + 1} ({channelLabel(mc)})
                          </span>
                          <div className="mini-meter">
                            <div
                              className="mini-meter-fill"
                              style={meterFillStyle(connected ? outputLevels[sourceOutputChannel] : 0)}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {device.monitors.length === 0 && <p className="routing-empty">Not monitoring anywhere</p>}
            </div>
          </section>
        )}
      </div>

      <div className="routing-panel-footer">
        {pending && (
          <span className="pending-hint">
            {pending.kind === "source"
              ? "Click an output channel to connect, or click the source dot again to cancel."
              : "Click a monitor channel to route it, or click the output dot again to cancel."}
          </span>
        )}
        <button className="btn btn-secondary show-monitors-toggle" onClick={onToggleShowMonitors}>
          {showMonitors ? "Hide Monitors" : "Show Monitors"}
        </button>
      </div>
    </div>
  )
}
