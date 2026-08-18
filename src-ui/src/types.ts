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
