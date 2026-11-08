// Whisper log-mel features for Smart Turn v3.
//
// Matches transformers' WhisperFeatureExtractor(chunk_length=8, do_normalize=True)
// after the Smart Turn step "keep the last 8 s, zero-pad at the START":
// n_fft 400, hop 160, periodic Hann window, center=True with REFLECT padding,
// 201 power bins, last STFT frame dropped (800 frames), 80 Slaney mel filters
// over 0..8000 Hz with Slaney normalisation, log10 clamp 1e-10, max-8 floor,
// (x + 4) / 4. Output is Float32Array row-major [mel][frame].
//
// The FFT is Bluestein over a radix-2 core so the non-power-of-two n_fft=400
// costs about two 1024-point FFTs per frame.

export const SAMPLE_RATE = 16000;
export const SAMPLE_COUNT = 128000;
export const N_FFT = 400;
export const HOP_LENGTH = 160;
export const N_MELS = 80;
export const N_FREQUENCY_BINS = N_FFT / 2 + 1;
export const N_FRAMES = 800;

// --- mel scale (Slaney / librosa) ------------------------------------------

const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
// librosa / transformers slaney scale: logstep = log(6.4) / 27.
const LOG_STEP = Math.log(6.4) / 27;

export function hertzToMelSlaney(hz) {
  if (hz >= MIN_LOG_HZ) return MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
  return (3 * hz) / 200;
}

export function melToHertzSlaney(mel) {
  if (mel >= MIN_LOG_MEL) return MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));
  return (200 * mel) / 3;
}

export function melFrequencies(count, minHz, maxHz) {
  const low = hertzToMelSlaney(minHz);
  const high = hertzToMelSlaney(maxHz);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = melToHertzSlaney(low + ((high - low) * i) / (count - 1));
  }
  return out;
}

// mel_filter_bank(num_frequency_bins=201, num_mel_filters=80, min_frequency=0,
// max_frequency=8000, sampling_rate=16000, norm='slaney', mel_scale='slaney').
let cachedFilters = null;
export function melFilterBank() {
  if (cachedFilters) return cachedFilters;
  const melHz = melFrequencies(N_MELS + 2, 0, SAMPLE_RATE / 2);
  const fftFreqs = new Float64Array(N_FREQUENCY_BINS);
  for (let i = 0; i < N_FREQUENCY_BINS; i += 1) {
    fftFreqs[i] = (i * (SAMPLE_RATE / 2)) / (N_FREQUENCY_BINS - 1);
  }
  const filters = new Float64Array(N_MELS * N_FREQUENCY_BINS);
  for (let m = 0; m < N_MELS; m += 1) {
    const lowerDiff = melHz[m + 1] - melHz[m];
    const upperDiff = melHz[m + 2] - melHz[m + 1];
    const enorm = 2 / (melHz[m + 2] - melHz[m]);
    for (let k = 0; k < N_FREQUENCY_BINS; k += 1) {
      const lower = (fftFreqs[k] - melHz[m]) / lowerDiff;
      const upper = (melHz[m + 2] - fftFreqs[k]) / upperDiff;
      const value = Math.max(0, Math.min(lower, upper));
      filters[m * N_FREQUENCY_BINS + k] = value * enorm;
    }
  }
  cachedFilters = filters;
  return filters;
}

// --- radix-2 FFT with a Bluestein wrapper for arbitrary lengths -------------

const fftPlans = new Map();
function fftPlan(size) {
  const cached = fftPlans.get(size);
  if (cached) return cached;
  const levels = Math.round(Math.log2(size));
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let r = 0;
    for (let b = 0; b < levels; b += 1) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  const plan = { size, levels, rev, cos, sin };
  fftPlans.set(size, plan);
  return plan;
}

export function fftInPlace(re, im, inverse = false) {
  const { size, rev, cos, sin } = fftPlan(re.length);
  for (let i = 0; i < size; i += 1) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const step = size / len;
    for (let base = 0; base < size; base += len) {
      for (let j = 0, k = 0; j < half; j += 1, k += step) {
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = base + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < size; i += 1) {
      re[i] /= size;
      im[i] /= size;
    }
  }
}

// Bluestein: exact DFT of length n using a power-of-two circular convolution.
// W^(nk) = exp(-i*pi*n^2/n) * exp(-i*pi*k^2/n) * exp(i*pi*(n-k)^2/n).
export function createBluestein(n) {
  let size = 1;
  while (size < 2 * n - 1) size <<= 1;
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    // Reduce k^2 mod 2n first: exp(i*pi*k^2/n) has period 2n in k^2.
    const phase = (Math.PI * (((k * k) % (2 * n)) + 2 * n)) / n;
    chirpRe[k] = Math.cos(phase);
    chirpIm[k] = Math.sin(phase);
  }
  const bre = new Float64Array(size);
  const bim = new Float64Array(size);
  bre[0] = chirpRe[0];
  bim[0] = chirpIm[0];
  for (let m = 1; m < n; m += 1) {
    bre[m] = chirpRe[m];
    bim[m] = chirpIm[m];
    bre[size - m] = chirpRe[m];
    bim[size - m] = chirpIm[m];
  }
  fftInPlace(bre, bim, false);
  const are = new Float64Array(size);
  const aim = new Float64Array(size);
  return {
    length: n,
    transform(inputRe, inputIm, outRe, outIm) {
      for (let i = 0; i < n; i += 1) {
        const r = inputRe[i];
        const im = inputIm ? inputIm[i] : 0;
        // multiply by conj(chirp[i])
        are[i] = r * chirpRe[i] + im * chirpIm[i];
        aim[i] = im * chirpRe[i] - r * chirpIm[i];
      }
      are.fill(0, n);
      aim.fill(0, n);
      fftInPlace(are, aim, false);
      for (let i = 0; i < size; i += 1) {
        const r = are[i] * bre[i] - aim[i] * bim[i];
        const im = are[i] * bim[i] + aim[i] * bre[i];
        are[i] = r;
        aim[i] = im;
      }
      fftInPlace(are, aim, true);
      for (let k = 0; k < n; k += 1) {
        outRe[k] = are[k] * chirpRe[k] + aim[k] * chirpIm[k];
        outIm[k] = aim[k] * chirpRe[k] - are[k] * chirpIm[k];
      }
      return { re: outRe, im: outIm };
    },
  };
}

const bluesteinCache = new Map();
function bluestein(n) {
  let plan = bluesteinCache.get(n);
  if (!plan) {
    plan = createBluestein(n);
    bluesteinCache.set(n, plan);
  }
  return plan;
}

export function periodicHannWindow(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return out;
}

// torch.stft(center=True, pad_mode='reflect') pads n_fft/2 on both sides.
export function reflectPad(samples, pad) {
  const n = samples.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i += 1) out[pad + i] = samples[i];
  for (let j = 0; j < pad; j += 1) out[j] = samples[pad - j];
  for (let k = 0; k < pad; k += 1) out[pad + n + k] = samples[n - 2 - k];
  return out;
}

function lastSamples(samples, count) {
  const out = new Float64Array(count);
  if (!samples || samples.length === 0) return out;
  const take = Math.min(samples.length, count);
  const offset = count - take;
  for (let i = 0; i < take; i += 1) out[offset + i] = samples[samples.length - take + i];
  return out;
}

// Power spectrum rows [bin][frame] for the 800 kept frames.
export function powerSpectrogram(waveform) {
  const window = periodicHannWindow(N_FFT);
  const padded = reflectPad(waveform, N_FFT / 2);
  const plan = bluestein(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const outRe = new Float64Array(N_FFT);
  const outIm = new Float64Array(N_FFT);
  const power = new Float64Array(N_FREQUENCY_BINS * N_FRAMES);
  for (let frame = 0; frame < N_FRAMES; frame += 1) {
    const start = frame * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i += 1) {
      re[i] = padded[start + i] * window[i];
      im[i] = 0;
    }
    plan.transform(re, im, outRe, outIm);
    for (let bin = 0; bin < N_FREQUENCY_BINS; bin += 1) {
      power[bin * N_FRAMES + frame] = outRe[bin] * outRe[bin] + outIm[bin] * outIm[bin];
    }
  }
  return power;
}

export function logMelSpectrogram(power) {
  const filters = melFilterBank();
  const mel = new Float64Array(N_MELS * N_FRAMES);
  for (let m = 0; m < N_MELS; m += 1) {
    const filterOffset = m * N_FREQUENCY_BINS;
    const melOffset = m * N_FRAMES;
    for (let frame = 0; frame < N_FRAMES; frame += 1) {
      let sum = 0;
      for (let k = 0; k < N_FREQUENCY_BINS; k += 1) {
        sum += filters[filterOffset + k] * power[k * N_FRAMES + frame];
      }
      mel[melOffset + frame] = sum;
    }
  }
  const log = new Float64Array(mel.length);
  let peak = -Infinity;
  for (let i = 0; i < mel.length; i += 1) {
    const value = Math.log10(Math.max(mel[i], 1e-10));
    log[i] = value;
    if (value > peak) peak = value;
  }
  const floor = peak - 8;
  for (let i = 0; i < log.length; i += 1) {
    log[i] = (Math.max(log[i], floor) + 4) / 4;
  }
  return log;
}

export function normalizeWaveform(waveform) {
  const n = waveform.length;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += waveform[i];
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i += 1) {
    const d = waveform[i] - mean;
    squares += d * d;
  }
  const std = Math.sqrt(squares / n + 1e-7);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (waveform[i] - mean) / std;
  return out;
}

// samples16k: recent 16 kHz mono float samples (any length). Returns the
// Float32Array of shape [80, 800] row-major [mel][frame].
export function extractWhisperFeatures(samples16k) {
  const padded = lastSamples(samples16k, SAMPLE_COUNT);
  const normalized = normalizeWaveform(padded);
  const logMel = logMelSpectrogram(powerSpectrogram(normalized));
  const out = new Float32Array(logMel.length);
  for (let i = 0; i < logMel.length; i += 1) out[i] = logMel[i];
  return out;
}
