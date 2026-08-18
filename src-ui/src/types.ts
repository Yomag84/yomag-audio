export interface AudioDeviceInfo {
  name: string
  is_default: boolean
  is_input: boolean
  sample_rate: number | null
  channels: number | null
}

export interface InternalDeviceGuess {
  microphone: AudioDeviceInfo | null
  speaker: AudioDeviceInfo | null
}

export interface EngineInfo {
  internal_sample_rate: number
  mix_tick_period_ms: number
}

export interface SourceInfo {
  id: string
  channels: number
  gain: number
  muted: boolean
}

export interface Connection {
  source_id: string
  source_channel: number
  output_channel: number
  gain: number
}

export interface EqBand {
  freq_hz: number
  gain_db: number
  q: number
}

export interface MonitorInfo {
  name: string
  channels: number
  channel_map: (number | null)[]
  exclusive: boolean
  buffer_ms: number
  delay_ms: number
  eq_bands: EqBand[]
}

export interface VirtualDeviceSnapshot {
  id: string
  name: string
  enabled: boolean
  output_channels: number
  sources: SourceInfo[]
  connections: Connection[]
  monitors: MonitorInfo[]
  is_published: boolean
}

export interface AppAudioSession {
  pid: number
  process_name: string
  display_name: string
  volume: number
  muted: boolean
}

export interface PeerDeviceInfo {
  device_id: string
  device_name: string
}

export interface PeerSnapshot {
  peer_id: string
  name: string
  addr: string
  published: PeerDeviceInfo[]
}

export interface StreamStats {
  underruns: number
  overruns: number
  buffered_ms: number
}

export interface DeviceLevels {
  source_levels: Record<string, number[]>
  output_levels: number[]
  source_stats: Record<string, StreamStats>
  monitor_stats: Record<string, StreamStats>
}

export type LevelsEvent = Record<string, DeviceLevels>

// --- Recording / editing -----------------------------------------------
// Mirrors src-tauri/src/audio/recording.rs 1:1.

export interface TrackManifest {
  source_id: string
  file: string
  channels: number
  sample_rate: number
  duration_frames: number
}

export interface RecordingManifest {
  session_id: string
  device_id: string
  device_name: string
  name: string
  created_at_ms: number
  tracks: TrackManifest[]
}

export interface RecordingSummary {
  session_id: string
  name: string
  device_name: string
  created_at_ms: number
  duration_ms: number
  track_count: number
}

export interface Clip {
  id: string
  source_start_frame: number
  length_frames: number
  timeline_start_frame: number
}

export interface TrackProject {
  source_id: string
  gain: number
  /** Stereo balance, -1 (full left) .. 1 (full right), 0 = center. */
  pan: number
  muted: boolean
  solo: boolean
  eq_bands: EqBand[]
  clips: Clip[]
}

export interface RecordingProject {
  session_id: string
  tracks: TrackProject[]
}
