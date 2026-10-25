/**
 * DeepGuard — Forensic Score Fusion Engine
 * ----------------------------------------
 * Runs at the edge. Receives raw forensic signal vectors extracted
 * client-side (WebGL / Canvas / WebAudio DSP) and fuses them into a
 * single calibrated threat score using a logistic ensemble.
 *
 * Design note: heavy per-pixel / per-sample extraction happens in the
 * browser (zero upload latency, privacy-preserving). The edge performs
 * weighting, calibration, temporal smoothing and persistence.
 */

export type SignalVector = Record<string, number>;

export interface SignalDetail {
  key: string;
  name: string;
  value: number;        // normalised 0..1 contribution to "manipulated"
  weight: number;
  description: string;
}

export interface FusionResult {
  threat_score: number;        // 0..100
  confidence: number;          // 0..1
  label: 'authentic' | 'suspicious' | 'manipulated';
  signals: SignalDetail[];
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Signal definitions
 * ------------------------------------------------------------------ */

interface SignalSpec {
  name: string;
  weight: number;
  description: string;
  /** Maps a raw measurement to 0..1 "manipulation likelihood". */
  normalise: (raw: number) => number;
}

/** Piecewise-linear ramp: below lo => 0, above hi => 1. */
const ramp = (lo: number, hi: number) => (raw: number) => {
  if (!Number.isFinite(raw)) return 0;
  if (hi === lo) return raw >= hi ? 1 : 0;
  return clamp01((raw - lo) / (hi - lo));
};

/** Inverse ramp: above hi => 0, below lo => 1. */
const invRamp = (lo: number, hi: number) => (raw: number) => {
  if (!Number.isFinite(raw)) return 0;
  if (hi === lo) return raw <= lo ? 1 : 0;
  return clamp01(1 - (raw - lo) / (hi - lo));
};

/** Band: penalises deviation away from an expected natural range. */
const band = (lo: number, hi: number, tol: number) => (raw: number) => {
  if (!Number.isFinite(raw)) return 0;
  if (raw >= lo && raw <= hi) return 0;
  const d = raw < lo ? lo - raw : raw - hi;
  return clamp01(d / tol);
};

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/* ---------------------------- VIDEO ------------------------------- */

export const VIDEO_SIGNALS: Record<string, SignalSpec> = {
  noise_residual: {
    name: 'Sensor Noise Residual',
    weight: 0.22,
    description:
      'Real camera sensors imprint a consistent high-frequency noise fingerprint (PRNU). GAN-synthesised faces are denoised by the generator, leaving an abnormally clean residual.',
    normalise: invRamp(0.012, 0.06),
  },
  spectral_peak: {
    name: 'GAN Spectral Artifacts',
    weight: 0.2,
    description:
      'Transposed-convolution upsampling in generators leaves periodic checkerboard peaks in the 2D frequency spectrum, absent in optical captures.',
    normalise: ramp(0.1, 0.55),
  },
  blend_seam: {
    name: 'Face Blend Boundary',
    weight: 0.18,
    description:
      'Face-swap pipelines composite a generated face onto the original head, producing a gradient discontinuity around the mask border.',
    normalise: ramp(0.08, 0.45),
  },
  temporal_flicker: {
    name: 'Temporal Incoherence',
    weight: 0.16,
    description:
      'Frame-by-frame generation lacks inter-frame consistency, causing texture flicker in the face region that is uncorrelated with head motion.',
    normalise: ramp(0.06, 0.4),
  },
  blink_anomaly: {
    name: 'Blink Rate Anomaly',
    weight: 0.09,
    description:
      'Natural humans blink 10–24 times/minute. Training sets under-represent closed eyes, so synthetic faces blink rarely or unnaturally often.',
    normalise: band(8, 28, 14),
  },
  color_coherence: {
    name: 'Chromatic Coherence',
    weight: 0.08,
    description:
      'Mismatch between the colour-temperature distribution of the face region versus the surrounding scene indicates compositing.',
    normalise: ramp(0.1, 0.5),
  },
  edge_sharpness: {
    name: 'Edge Sharpness Disparity',
    weight: 0.07,
    description:
      'Generated regions are often resampled, making facial edges measurably softer than background edges captured at native resolution.',
    normalise: ramp(0.12, 0.55),
  },
};

/* ---------------------------- AUDIO ------------------------------- */

export const AUDIO_SIGNALS: Record<string, SignalSpec> = {
  hf_rolloff: {
    name: 'Spectral Roll-off Cliff',
    weight: 0.22,
    description:
      'Neural vocoders (HiFi-GAN, WaveNet) synthesise at limited bandwidth, producing an abrupt energy cliff near 8–11 kHz that natural voices do not have.',
    normalise: ramp(0.15, 0.6),
  },
  jitter: {
    name: 'Pitch Jitter (F0 Stability)',
    weight: 0.2,
    description:
      'Human vocal folds are biomechanically imperfect, giving roughly 0.2–2% cycle-to-cycle pitch variation. Cloned voices are pathologically stable.',
    // Clinical "local jitter" for healthy voices ≈ 0.002–0.02.
    // Vocoder output typically < 0.001.
    normalise: invRamp(0.0012, 0.006),
  },
  shimmer: {
    name: 'Amplitude Shimmer',
    weight: 0.15,
    description:
      'Natural speech has micro-variations in cycle amplitude. Over-smoothed TTS output lacks this stochastic texture.',
    // Clinical "local shimmer" for healthy voices ≈ 0.02–0.10.
    normalise: invRamp(0.006, 0.022),
  },
  hnr: {
    name: 'Harmonic-to-Noise Ratio',
    weight: 0.15,
    description:
      'Real voices carry breath turbulence between harmonics. Synthetic voices show an unnaturally high HNR (too pure).',
    // Natural speech 15–30 dB; clean studio capture can reach ~38 dB.
    // Only penalise clearly non-physiological purity.
    normalise: ramp(30, 48),
  },
  noise_floor: {
    name: 'Room Tone / Noise Floor',
    weight: 0.12,
    description:
      'Genuine microphone captures include ambient room tone and electronic self-noise. Fully synthetic audio has a digitally silent floor.',
    // Real mic captures rarely fall below ~-75 dBFS between phonemes;
    // pure synthesis approaches numerical silence (< -90 dBFS).
    normalise: invRamp(-88, -70),
  },
  formant_var: {
    name: 'Formant Trajectory Variance',
    weight: 0.09,
    description:
      'Vocal-tract resonances shift organically during articulation. Concatenative and neural TTS produce overly smooth formant paths.',
    // Spectral-centroid stdev (normalised units) — articulated speech
    // moves the centroid far more than a steady synthetic timbre.
    normalise: invRamp(0.008, 0.035),
  },
  phase_coherence: {
    name: 'Phase Coherence',
    weight: 0.07,
    description:
      'Griffin-Lim and similar phase-reconstruction stages leave characteristically coherent phase relationships across harmonics.',
    normalise: ramp(0.2, 0.7),
  },
};

/* ------------------------------------------------------------------ *
 * Fusion
 * ------------------------------------------------------------------ */

/** Logistic squashing centred so that weighted evidence ~0.5 => ~50. */
function logistic(x: number, k = 9, mid = 0.47): number {
  return 1 / (1 + Math.exp(-k * (x - mid)));
}

export function fuse(
  raw: SignalVector,
  specs: Record<string, SignalSpec>,
): FusionResult {
  const signals: SignalDetail[] = [];
  let weighted = 0;
  let totalWeight = 0;
  let present = 0;

  for (const [key, spec] of Object.entries(specs)) {
    const rawVal = raw[key];
    if (rawVal === undefined || rawVal === null || !Number.isFinite(rawVal)) {
      continue;
    }
    const value = clamp01(spec.normalise(rawVal));
    signals.push({
      key,
      name: spec.name,
      value,
      weight: spec.weight,
      description: spec.description,
    });
    weighted += value * spec.weight;
    totalWeight += spec.weight;
    present++;
  }

  if (totalWeight === 0) {
    return {
      threat_score: 0,
      confidence: 0,
      label: 'authentic',
      signals: [],
      summary: 'No analysable signal was extracted from the media.',
    };
  }

  const evidence = weighted / totalWeight;
  const score = logistic(evidence) * 100;

  // Confidence grows with signal coverage and with agreement between signals.
  const coverage = totalWeight / Object.values(specs).reduce((a, s) => a + s.weight, 0);
  const mean = signals.reduce((a, s) => a + s.value, 0) / signals.length;
  const variance =
    signals.reduce((a, s) => a + (s.value - mean) ** 2, 0) / signals.length;
  const agreement = clamp01(1 - variance * 3);
  const confidence = clamp01(0.35 + 0.4 * coverage + 0.25 * agreement);

  const label: FusionResult['label'] =
    score >= 65 ? 'manipulated' : score >= 35 ? 'suspicious' : 'authentic';

  signals.sort((a, b) => b.value * b.weight - a.value * a.weight);

  return {
    threat_score: round(score, 1),
    confidence: round(confidence, 3),
    label,
    signals,
    summary: buildSummary(label, score, signals, present),
  };
}

function buildSummary(
  label: FusionResult['label'],
  score: number,
  signals: SignalDetail[],
  present: number,
): string {
  const top = signals.filter((s) => s.value > 0.45).slice(0, 3);
  const names = top.map((s) => s.name).join(', ');

  if (label === 'manipulated') {
    return `Strong evidence of synthetic manipulation (${score.toFixed(
      1,
    )}/100) across ${present} forensic signals. Dominant indicators: ${
      names || 'distributed across multiple weak signals'
    }.`;
  }
  if (label === 'suspicious') {
    return `Ambiguous result (${score.toFixed(
      1,
    )}/100). Some forensic markers deviate from natural-capture baselines${
      names ? `, notably: ${names}` : ''
    }. Treat as inconclusive and corroborate out-of-band.`;
  }
  return `Consistent with authentic capture (${score.toFixed(
    1,
  )}/100). ${present} forensic signals fall within natural-capture baselines.`;
}

export function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Exposes the signal catalogue to the UI for documentation panels. */
export function describeSignals(kind: 'video' | 'audio') {
  const specs = kind === 'video' ? VIDEO_SIGNALS : AUDIO_SIGNALS;
  return Object.entries(specs).map(([key, s]) => ({
    key,
    name: s.name,
    weight: s.weight,
    description: s.description,
  }));
}
