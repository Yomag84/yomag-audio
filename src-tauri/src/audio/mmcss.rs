use std::cell::Cell;
use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;

thread_local! {
    static PROMOTED: Cell<bool> = const { Cell::new(false) };
}

/// Registers the calling OS thread with MMCSS under the "Pro Audio" task,
/// which raises its scheduling priority above normal user threads - the
/// same mechanism real-time audio apps (DAWs, WASAPI clients) use to avoid
/// buffer underruns from being preempted by unrelated system activity. Also
/// enables FTZ/DAZ on this thread (see `enable_flush_to_zero_denormals`) -
/// both are "make this thread fit to do real-time audio math" setup, so
/// every real-time thread in this codebase calls this one function instead
/// of remembering to do each separately.
///
/// Idempotent per-thread: cpal's audio callback runs repeatedly on the same
/// dedicated OS thread for the life of a stream, so this only needs to (and
/// should only) run once per thread, on the first callback invocation.
/// Deliberately does not un-register on stream stop: the registration is
/// automatically released when the thread exits, and these threads' lifetime
/// already matches their stream's.
pub fn promote_current_thread_to_pro_audio() {
    PROMOTED.with(|promoted| {
        if promoted.get() {
            return;
        }
        promoted.set(true);

        enable_flush_to_zero_denormals();

        let mut task_index: u32 = 0;
        // Safety: TaskName points at a valid, null-terminated wide string
        // for the duration of this call; TaskIndex is a valid out-pointer.
        let result = unsafe {
            AvSetMmThreadCharacteristicsW(windows::core::w!("Pro Audio"), &mut task_index)
        };
        if let Err(err) = result {
            tracing::warn!(%err, "Failed to promote audio thread to Pro Audio MMCSS class");
        }
    });
}

/// Sets FTZ (flush-to-zero) and DAZ (denormals-are-zero) in this thread's
/// MXCSR register. Any recursive filter's feedback state (the parametric
/// EQ's biquads carry `x1/x2/y1/y2` across calls) or a signal simply
/// decaying toward silence readily produces true denormal floats, and x86
/// hardware takes a microcode slow path - often 10-100x normal latency -
/// for every arithmetic op on one, instead of the single-cycle fast path.
/// On a thread with a 5ms real-time budget that's easily enough to blow the
/// deadline on every quiet passage, which shows up as continuous
/// gritty/grainy noise ("sand") rather than occasional clicks, and is
/// otherwise invisible - the math stays correct, just slow. MXCSR is
/// per-thread state, so this has to run on every thread that touches audio
/// math, not once at process startup.
#[cfg(target_arch = "x86_64")]
fn enable_flush_to_zero_denormals() {
    // std::arch::x86_64::{_mm_getcsr, _mm_setcsr} do exactly this but are
    // deprecated in favor of raw stmxcsr/ldmxcsr - the intrinsics don't
    // give LLVM a hard ordering guarantee against surrounding code, which
    // matters here since this only needs to run once and must actually
    // take effect before any audio math follows it.
    use std::arch::asm;
    const FLUSH_TO_ZERO: u32 = 1 << 15;
    const DENORMALS_ARE_ZERO: u32 = 1 << 6;
    unsafe {
        let mut mxcsr: u32 = 0;
        asm!("stmxcsr [{0}]", in(reg) &mut mxcsr, options(nostack, preserves_flags));
        mxcsr |= FLUSH_TO_ZERO | DENORMALS_ARE_ZERO;
        asm!("ldmxcsr [{0}]", in(reg) &mxcsr, options(nostack, readonly, preserves_flags));
    }
}

#[cfg(not(target_arch = "x86_64"))]
fn enable_flush_to_zero_denormals() {}

#[cfg(all(test, target_arch = "x86_64"))]
mod tests {
    use super::*;
    use std::hint::black_box;

    #[test]
    fn denormal_product_is_nonzero_by_default() {
        // Control: on a fresh test thread (MXCSR is per-thread, so this
        // doesn't see whatever other tests below set), a normal-times-
        // normal multiplication that mathematically underflows into
        // subnormal range keeps its true nonzero value under default FPU
        // behavior. black_box on every operand blocks the compiler from
        // constant-folding this to whatever IEEE says regardless of the
        // runtime MXCSR this test actually exercises.
        let product = black_box(f32::MIN_POSITIVE) * black_box(0.5f32);
        assert_ne!(product, 0.0, "sanity check: this product is a true nonzero subnormal");
    }

    #[test]
    fn enabling_flush_to_zero_sets_mxcsr_bits() {
        enable_flush_to_zero_denormals();
        let mut mxcsr: u32 = 0;
        unsafe {
            std::arch::asm!("stmxcsr [{0}]", in(reg) &mut mxcsr, options(nostack, preserves_flags));
        }
        assert_ne!(mxcsr & (1 << 15), 0, "FTZ bit should be set");
        assert_ne!(mxcsr & (1 << 6), 0, "DAZ bit should be set");
    }

    #[test]
    fn flush_to_zero_flushes_denormal_products_to_exact_zero() {
        enable_flush_to_zero_denormals();
        let product = black_box(f32::MIN_POSITIVE) * black_box(0.5f32);
        assert_eq!(product, 0.0, "a subnormal product should flush to exact zero once FTZ is enabled");
    }
}
