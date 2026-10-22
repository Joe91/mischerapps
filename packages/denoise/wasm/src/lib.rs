//! Plain C-ABI exports around DeepFilterNet3 for `WebAssembly.instantiate` without JS glue.
//! One instance processes one channel at 48 kHz: JS writes up to `df_capacity()` samples (a
//! multiple of the hop size) to `df_buffer()`, calls `df_process(n)` and reads the result back
//! from the same buffer. The output is delayed by `df_delay()` samples.

use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

const HOPS_PER_CALL: usize = 100;

// Inference never draws random numbers; a fixed xorshift keeps tract's random operators linkable.
fn fill_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    let mut x: u32 = 0x9e37_79b9;
    for b in buf {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    Ok(())
}
getrandom::register_custom_getrandom!(fill_random);

pub struct Df {
    model: DfTract,
    buf: Vec<f32>,
    out: Vec<f32>,
}

/// Creates a model with the attenuation limit in dB (100 = no limit).
/// The thresholds are those of the `deep-filter` command line tool.
#[no_mangle]
pub extern "C" fn df_new(atten_lim_db: f32) -> *mut Df {
    let rp = RuntimeParams::default_with_ch(1)
        .with_atten_lim(atten_lim_db)
        .with_thresholds(-15., 35., 35.);
    let model = DfTract::new(DfParams::default(), &rp).expect("DeepFilterNet init");
    let n = model.hop_size * HOPS_PER_CALL;
    Box::into_raw(Box::new(Df { model, buf: vec![0.; n], out: vec![0.; n] }))
}

#[no_mangle]
pub extern "C" fn df_free(df: *mut Df) {
    if !df.is_null() {
        drop(unsafe { Box::from_raw(df) });
    }
}

#[no_mangle]
pub extern "C" fn df_sample_rate(df: *mut Df) -> usize {
    unsafe { &*df }.model.sr
}

#[no_mangle]
pub extern "C" fn df_hop_size(df: *mut Df) -> usize {
    unsafe { &*df }.model.hop_size
}

/// Latency of STFT and model lookahead in samples.
#[no_mangle]
pub extern "C" fn df_delay(df: *mut Df) -> usize {
    let m = &unsafe { &*df }.model;
    m.fft_size - m.hop_size + m.lookahead * m.hop_size
}

#[no_mangle]
pub extern "C" fn df_capacity(df: *mut Df) -> usize {
    unsafe { &*df }.buf.len()
}

#[no_mangle]
pub extern "C" fn df_buffer(df: *mut Df) -> *mut f32 {
    unsafe { &mut *df }.buf.as_mut_ptr()
}

/// Processes the first `n` samples of the buffer in place; `n` must be a multiple of the hop size.
#[no_mangle]
pub extern "C" fn df_process(df: *mut Df, n: usize) {
    let df = unsafe { &mut *df };
    let hop = df.model.hop_size;
    assert!(n % hop == 0 && n <= df.buf.len());
    for i in (0..n).step_by(hop) {
        let input = ArrayView2::from_shape((1, hop), &df.buf[i..i + hop]).unwrap();
        let output = ArrayViewMut2::from_shape((1, hop), &mut df.out[i..i + hop]).unwrap();
        df.model.process(input, output).expect("DeepFilterNet process");
    }
    df.buf[..n].copy_from_slice(&df.out[..n]);
}
