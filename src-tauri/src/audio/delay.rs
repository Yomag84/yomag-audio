// Simple feedback delay ("echo") effect for the multitrack editor's Effect
// Return busses (see recording::render_mixdown) - not used by the live
// routing engine, which has no delay/reverb-style send effects today.
pub struct FeedbackDelay {
    pub delay_ms: f32,
    pub feedback: f32,
    pub mix: f32,
}

impl FeedbackDelay {
    /// Applies the delay to `buffer` (interleaved, `channels` channels) in
    /// place, replacing it with the *wet* signal only: `y[n] = x[n-D] +
    /// feedback*y[n-D]` for n >= D, silence before the first repeat. A
    /// return bus (see render_mixdown) is entirely wet by definition - the
    /// dry signal already reached the master mix via each track's own
    /// gain/pan path - so this deliberately does *not* include the
    /// undelayed input anywhere in its output, only the delayed repeats:
    /// the first at full strength, each one after decayed by another
    /// `feedback`.
    pub fn process(&self, buffer: &mut [f32], channels: usize, sample_rate: u32) {
        let channels = channels.max(1);
        let delay_samples = ((self.delay_ms.max(0.0) / 1000.0) * sample_rate as f32).round() as usize;
        let feedback = self.feedback.clamp(0.0, 0.95);

        if delay_samples == 0 {
            // No valid repeat distance - a 0ms "echo" isn't a meaningful
            // effect, so the wet output is silence rather than an instant
            // (and musically meaningless) copy of the dry input.
            for sample in buffer.iter_mut() {
                *sample = 0.0;
            }
        } else {
            let frame_count = buffer.len() / channels;
            // y[n] = x[n-D] + feedback*y[n-D] needs the *original* dry
            // input at n-D even after this same loop has already
            // overwritten buffer[n-D] with y[n-D] - hence the separate
            // `dry` snapshot rather than reading buffer in place for both
            // terms of the recursion.
            let dry: Vec<f32> = buffer.to_vec();
            for sample in buffer.iter_mut() {
                *sample = 0.0;
            }
            for frame in delay_samples..frame_count {
                for ch in 0..channels {
                    let idx = frame * channels + ch;
                    let src_idx = (frame - delay_samples) * channels + ch;
                    buffer[idx] = dry[src_idx] + feedback * buffer[src_idx];
                }
            }
        }

        let mix = self.mix.clamp(0.0, 1.0);
        for sample in buffer.iter_mut() {
            *sample *= mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_impulse_produces_repeats_at_multiples_of_the_delay_with_no_dry_passthrough() {
        const SAMPLE_RATE: u32 = 1000; // 1 sample = 1ms, easy to reason about
        let mut buffer = vec![0f32; 50]; // mono, 50 frames
        buffer[0] = 1.0;

        let delay = FeedbackDelay { delay_ms: 10.0, feedback: 0.5, mix: 1.0 };
        delay.process(&mut buffer, 1, SAMPLE_RATE);

        assert_eq!(buffer[0], 0.0, "wet output must not include the undelayed dry impulse");
        assert!((buffer[10] - 1.0).abs() < 1e-6, "first repeat at 10ms should be the full input, got {}", buffer[10]);
        assert!((buffer[20] - 0.5).abs() < 1e-6, "second repeat should be feedback^1, got {}", buffer[20]);
        assert!((buffer[30] - 0.25).abs() < 1e-6, "third repeat should be feedback^2, got {}", buffer[30]);
        for i in 0..50 {
            if i != 10 && i != 20 && i != 30 && i != 40 {
                assert_eq!(buffer[i], 0.0, "no energy should appear off the repeat grid, got {} at {}", buffer[i], i);
            }
        }
    }

    #[test]
    fn zero_delay_produces_silence_rather_than_a_dry_passthrough() {
        let mut buffer = vec![0.4f32; 20];
        let delay = FeedbackDelay { delay_ms: 0.0, feedback: 0.9, mix: 1.0 };
        delay.process(&mut buffer, 2, 48_000);
        for &s in &buffer {
            assert_eq!(s, 0.0, "a 0ms delay has no valid repeat distance, so the wet output should be silence");
        }
    }

    #[test]
    fn mix_scales_the_first_tap_even_with_zero_feedback() {
        // feedback=0 means "no repeats beyond the first" (a single slap-
        // back echo), not "no output at all" - the first tap is always the
        // full (mix-scaled) input, only *further* repeats depend on
        // feedback.
        let mut buffer = vec![1.0f32; 5];
        let delay = FeedbackDelay { delay_ms: 2.0, feedback: 0.0, mix: 0.25 };
        delay.process(&mut buffer, 1, 1000);
        assert_eq!(buffer[0], 0.0);
        assert_eq!(buffer[1], 0.0);
        assert!((buffer[2] - 0.25).abs() < 1e-6, "expected mix-scaled first tap, got {}", buffer[2]);
        assert!((buffer[3] - 0.25).abs() < 1e-6);
        assert!((buffer[4] - 0.25).abs() < 1e-6);
    }
}
