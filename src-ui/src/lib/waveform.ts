export interface PeakData {
  min: Float32Array
  max: Float32Array
  bucketFrames: number
}

/**
 * Downsamples a decoded AudioBuffer into (min, max) pairs, one pair per
 * `bucketFrames`-wide window, so drawing a waveform is cheap regardless of
 * zoom level or clip length. Meant to be computed once per (track, zoom)
 * and cached by the caller (see TrackLane).
 */
export function computePeaks(buffer: AudioBuffer, bucketFrames: number): PeakData {
  const channelCount = buffer.numberOfChannels
  const length = buffer.length
  const bucketCount = Math.max(1, Math.ceil(length / bucketFrames))
  const min = new Float32Array(bucketCount)
  const max = new Float32Array(bucketCount)

  const channelData: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) {
    channelData.push(buffer.getChannelData(c))
  }

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * bucketFrames
    const end = Math.min(length, start + bucketFrames)
    let bucketMin = 0
    let bucketMax = 0
    for (let frame = start; frame < end; frame++) {
      // Take the loudest channel at this frame rather than averaging -
      // a transient on just one channel should still read as loud.
      let sample = 0
      for (let c = 0; c < channelCount; c++) {
        const v = channelData[c][frame]
        if (Math.abs(v) > Math.abs(sample)) sample = v
      }
      if (sample < bucketMin) bucketMin = sample
      if (sample > bucketMax) bucketMax = sample
    }
    min[bucket] = bucketMin
    max[bucket] = bucketMax
  }

  return { min, max, bucketFrames }
}

/** Picks a bucket size (in frames) that keeps peak computation and canvas
 * drawing cheap at a given horizontal zoom (pixels per second of audio). */
export function bucketFramesForZoom(sampleRate: number, pixelsPerSecond: number): number {
  const framesPerPixel = sampleRate / Math.max(1, pixelsPerSecond)
  return Math.max(1, Math.round(framesPerPixel))
}

/** Draws precomputed peaks into a canvas 2D context sized `width`x`height`. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: PeakData,
  width: number,
  height: number,
  color: string
): void {
  ctx.clearRect(0, 0, width, height)
  const bucketCount = peaks.min.length
  if (bucketCount === 0) return
  const midY = height / 2
  ctx.fillStyle = color
  ctx.beginPath()
  for (let x = 0; x < width; x++) {
    const bucket = Math.min(bucketCount - 1, Math.floor((x / width) * bucketCount))
    const lo = peaks.min[bucket]
    const hi = peaks.max[bucket]
    const yTop = midY - hi * midY
    const yBottom = midY - lo * midY
    ctx.rect(x, yTop, 1, Math.max(1, yBottom - yTop))
  }
  ctx.fill()
}

/**
 * Sums multiple tracks' peaks into one combined overview, for the
 * Recordings detail modal's single waveform display only - never used by
 * the multitrack editor, which always renders one lane per track.
 */
export function combinePeaks(all: PeakData[]): PeakData {
  const bucketCount = all.reduce((max, p) => Math.max(max, p.min.length), 0)
  const min = new Float32Array(bucketCount)
  const max = new Float32Array(bucketCount)
  for (const peaks of all) {
    for (let i = 0; i < peaks.min.length; i++) {
      min[i] += peaks.min[i]
      max[i] += peaks.max[i]
    }
  }
  // Summed tracks can exceed +/-1 the same way summed audio can - this is
  // a visual overview only, so just clamp back into range.
  for (let i = 0; i < bucketCount; i++) {
    min[i] = Math.max(-1, min[i])
    max[i] = Math.min(1, max[i])
  }
  return { min, max, bucketFrames: all[0]?.bucketFrames ?? 1 }
}
