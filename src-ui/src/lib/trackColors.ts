// Deterministic per-track color, so a track's waveform and its mixer
// channel strip always agree, and so lanes are visually distinguishable
// the way every reference multitrack UI colors its tracks - without
// needing to store a color choice anywhere.
const PALETTE = [
  "#4fb3a9", // teal
  "#e08a4a", // amber
  "#7c6af2", // violet
  "#5aa8e0", // sky blue
  "#c26fde", // magenta
  "#e0574a", // coral
  "#6bc46d", // green
  "#e0c34a", // gold
]

export function colorForTrack(sourceId: string): string {
  let hash = 0
  for (let i = 0; i < sourceId.length; i++) {
    hash = (hash * 31 + sourceId.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}
