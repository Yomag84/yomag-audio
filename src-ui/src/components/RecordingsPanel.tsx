import { useMemo, useState } from "react"
import type { RecordingSummary } from "../types"
import "./RecordingsPanel.css"

interface RecordingsPanelProps {
  recordings: RecordingSummary[]
  loading: boolean
  onRefresh: () => void
  onOpen: (session: RecordingSummary) => void
  onDelete: (sessionId: string) => void
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function RecordingsPanel({ recordings, loading, onRefresh, onOpen, onDelete }: RecordingsPanelProps) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recordings
    return recordings.filter(
      (r) => r.name.toLowerCase().includes(q) || r.device_name.toLowerCase().includes(q)
    )
  }, [recordings, query])

  return (
    <div className="recordings-panel">
      <div className="routing-column-header">
        <div>
          <h3>Recordings</h3>
          <span className="routing-column-subtitle">
            {recordings.length} recording{recordings.length === 1 ? "" : "s"} · one track per source, ready to
            edit as a multitrack session
          </span>
        </div>
        <div className="add-control">
          <input
            className="recordings-search"
            type="text"
            placeholder="Search recordings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn-icon" onClick={onRefresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {loading && <p className="routing-empty">Loading…</p>}

      {!loading && filtered.length === 0 && (
        <p className="routing-empty">
          {recordings.length === 0
            ? "No recordings yet — hit Record from the Routing view to capture your first take."
            : "No recordings match your search."}
        </p>
      )}

      <div className="recordings-grid">
        {filtered.map((session) => (
          <div key={session.session_id} className="recording-card" onClick={() => onOpen(session)}>
            <div className="recording-card-waveform" aria-hidden="true">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <polyline
                  points="0,12 4,6 8,18 12,4 16,16 20,9 24,14 28,3 32,19 36,10 40,7 44,15 48,5 52,17 56,11 60,8 64,13 68,4 72,18 76,9 80,14 84,6 88,16 92,10 96,12 100,12"
                />
              </svg>
            </div>
            <div className="recording-card-body">
              <div className="recording-card-title">{session.name}</div>
              <div className="recording-card-meta">
                {session.device_name} · {formatDuration(session.duration_ms)} · {session.track_count} track
                {session.track_count === 1 ? "" : "s"}
              </div>
              <div className="recording-card-date">{formatDate(session.created_at_ms)}</div>
            </div>
            <button
              className="chip-remove recording-card-delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(session.session_id)
              }}
              title="Delete recording"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
