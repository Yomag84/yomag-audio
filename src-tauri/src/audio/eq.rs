use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

/// One parametric peaking band: boosts or cuts frequencies around `freq_hz`,
/// `q` wide, by `gain_db`. An RBJ Audio EQ Cookbook peaking biquad - the
/// standard formula for this, rather than something bespoke.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EqBand {
    pub freq_hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

#[derive(Clone, Copy)]
struct BiquadCoeffs {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl BiquadCoeffs {
    fn peaking(band: &EqBand, sample_rate: f32) -> Self {
        let a = 10f32.powf(band.gain_db / 40.0);
        let w0 = 2.0 * PI * band.freq_hz.clamp(1.0, sample_rate * 0.49) / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let q = band.q.max(0.01);
        let alpha = sin_w0 / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
}

/// Direct Form I state for one band on one channel: the last two input and
/// output samples. Coefficients live separately in `MultibandEq::coeffs`
/// since every channel of a monitor shares the same band settings - only
/// this history is per channel.
#[derive(Default, Clone, Copy)]
struct BiquadState {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadState {
    fn process(&mut self, c: &BiquadCoeffs, x0: f32) -> f32 {
        let y0 = c.b0 * x0 + c.b1 * self.x1 + c.b2 * self.x2 - c.a1 * self.y1 - c.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x0;
        self.y2 = self.y1;
        self.y1 = y0;
        y0
    }
}

/// A cascade of parametric bands applied per channel, right before a
/// monitor's samples reach hardware. Lives inside that monitor's own audio
/// callback closure and is driven by whatever `EqBand` list the UI last set
/// (see `process`) - it rebuilds its coefficients/state only when that list,
/// the channel count, or the sample rate actually changed since last call.
pub struct MultibandEq {
    applied_bands: Vec<EqBand>,
    applied_rate: u32,
    coeffs: Vec<BiquadCoeffs>,
    /// state[channel][band]
    state: Vec<Vec<BiquadState>>,
}

impl MultibandEq {
    pub fn new() -> Self {
        Self {
            applied_bands: Vec::new(),
            applied_rate: 0,
            coeffs: Vec::new(),
            state: Vec::new(),
        }
    }

    fn sync(&mut self, bands: &[EqBand], channels: usize, sample_rate: u32) {
        let channels_changed = self.state.len() != channels.max(1);
        if !channels_changed && self.applied_rate == sample_rate && self.applied_bands == bands {
            return;
        }

        self.coeffs = bands
            .iter()
            .map(|b| BiquadCoeffs::peaking(b, sample_rate as f32))
            .collect();
        self.state = vec![vec![BiquadState::default(); bands.len()]; channels.max(1)];
        self.applied_bands = bands.to_vec();
        self.applied_rate = sample_rate;
    }

    /// Filters `buffer` (interleaved, `channels`-wide frames) in place
    /// against the current `bands`. An empty `bands` list is a no-op, so
    /// monitors with no EQ configured pay nothing beyond this check.
    pub fn process(&mut self, buffer: &mut [f32], channels: usize, sample_rate: u32, bands: &[EqBand]) {
        if bands.is_empty() && self.applied_bands.is_empty() {
            return;
        }
        self.sync(bands, channels, sample_rate);
        if self.coeffs.is_empty() {
            return;
        }

        for frame in buffer.chunks_mut(channels.max(1)) {
            for (c, sample) in frame.iter_mut().enumerate() {
                let Some(channel_state) = self.state.get_mut(c) else {
                    continue;
                };
                let mut x = *sample;
                for (band_state, coeffs) in channel_state.iter_mut().zip(&self.coeffs) {
                    x = band_state.process(coeffs, x);
                }
                *sample = x;
            }
        }
    }
}
