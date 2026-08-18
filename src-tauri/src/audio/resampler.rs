/// Streaming Catmull-Rom (4-point cubic Hermite) sample-rate converter, used
/// to bridge every mismatched clock in the pipeline (a mic's native rate to
/// the internal 48kHz mix, the internal mix to a monitor's native rate).
/// Plain linear interpolation was tried first and measurably degraded
/// clarity - it has poor stopband rejection, so it aliases high-frequency
/// content into audible noise/dullness on anything but pure tones. Cubic
/// interpolation costs little extra CPU and is the standard real-time
/// compromise between linear and full windowed-sinc resampling (which needs
/// fixed-size chunks and doesn't fit cpal's variable-length callbacks).
pub struct LinearResampler {
    channels: usize,
    ratio: f64, // input frames consumed per output frame
    pos: f64,   // fractional frame position within `pending`
    /// Raw input frames carried over from the previous call: always at
    /// least the one true-history frame behind `pos`, so the next call's
    /// interpolation never has to fabricate a value at a callback boundary.
    pending: Vec<f32>,
}

/// The Catmull-Rom kernel evaluated at position `idx + frac` needs samples
/// at idx-1, idx, idx+1, idx+2 - one frame of backward context, two of
/// forward context.
const FORWARD_REACH: usize = 2;

impl LinearResampler {
    pub fn new(input_rate: u32, output_rate: u32, channels: usize) -> Self {
        Self {
            channels,
            ratio: input_rate as f64 / output_rate as f64,
            pos: 0.0,
            pending: Vec::new(),
        }
    }

    /// Consumes one callback's worth of interleaved input frames and appends
    /// the resampled interleaved output frames to `out`. State (fractional
    /// position + trailing raw frames) carries across calls, so there's
    /// neither a click/gap nor any dropped source audio at callback
    /// boundaries - a few frames' worth of source audio that don't yet have
    /// enough forward context are simply held over to the next call instead
    /// of being interpolated early with fabricated neighbors.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let channels = self.channels;
        if channels == 0 || input.is_empty() {
            return;
        }

        let mut combined = std::mem::take(&mut self.pending);
        combined.extend_from_slice(input);
        let frame_count = combined.len() / channels;
        if frame_count == 0 {
            return;
        }

        let frame_at = |idx: isize, c: usize| -> f32 {
            let clamped = idx.clamp(0, frame_count as isize - 1) as usize;
            combined[clamped * channels + c]
        };

        while (self.pos.floor() as isize) + (FORWARD_REACH as isize) < (frame_count as isize) {
            let idx = self.pos.floor() as isize;
            let frac = (self.pos - idx as f64) as f32;
            for c in 0..channels {
                let p0 = frame_at(idx - 1, c);
                let p1 = frame_at(idx, c);
                let p2 = frame_at(idx + 1, c);
                let p3 = frame_at(idx + 2, c);
                out.push(catmull_rom(p0, p1, p2, p3, frac));
            }
            self.pos += self.ratio;
        }

        // Keep one true-history frame behind the resume point so idx-1 is
        // always real audio, never a clamped/fabricated edge value.
        let resume_idx = self.pos.floor() as usize;
        let keep_from = resume_idx.saturating_sub(1).min(frame_count.saturating_sub(1));
        self.pos -= keep_from as f64;
        self.pending = combined[keep_from * channels..].to_vec();
    }
}

fn catmull_rom(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_signal_is_preserved() {
        let mut resampler = LinearResampler::new(44_100, 48_000, 1);
        let input = vec![0.5f32; 4410]; // 100ms at 44.1kHz, mono
        let mut out = Vec::new();
        resampler.process(&input, &mut out);

        assert!(!out.is_empty());
        for &sample in &out {
            assert!(
                (sample - 0.5).abs() < 1e-4,
                "sample drifted from constant input: {sample}"
            );
        }
    }

    #[test]
    fn output_length_matches_rate_ratio() {
        // Realistic usage: fed in small streaming chunks, not one giant
        // block - exercises the pending/carryover path across many calls.
        let mut resampler = LinearResampler::new(44_100, 48_000, 2);
        let total_frames = 44_100;
        let chunk_frames = 256;
        let mut out = Vec::new();
        let mut produced = 0usize;
        let mut fed = 0usize;
        while fed < total_frames {
            let this_chunk = chunk_frames.min(total_frames - fed);
            let block = vec![0.0f32; this_chunk * 2];
            out.clear();
            resampler.process(&block, &mut out);
            produced += out.len() / 2;
            fed += this_chunk;
        }

        let expected_frames = (total_frames as f64 * 48_000.0 / 44_100.0).round() as usize;
        assert!(
            (produced as i64 - expected_frames as i64).abs() <= 8,
            "expected ~{expected_frames} frames across streamed chunks, got {produced}"
        );
    }

    #[test]
    fn upsampling_and_downsampling_do_not_panic_across_many_callbacks() {
        let mut up = LinearResampler::new(44_100, 48_000, 1);
        let mut down = LinearResampler::new(48_000, 44_100, 1);
        let mut out = Vec::new();
        let mut out2 = Vec::new();
        for i in 0..50 {
            let block: Vec<f32> = (0..256)
                .map(|n| ((i * 256 + n) as f32 * 0.01).sin())
                .collect();
            out.clear();
            up.process(&block, &mut out);
            out2.clear();
            down.process(&out, &mut out2);
            for &s in &out2 {
                assert!(s.is_finite());
            }
        }
    }
}
