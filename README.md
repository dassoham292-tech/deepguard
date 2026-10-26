# DeepGuard — Real-Time Streaming Media Forensics & Deepfake Detection

## Project Overview

- **Name**: DeepGuard
- **Goal**: Detect deepfakes and voice-cloning in live and recorded media, moving beyond slow "record-then-upload" workflows to continuous, real-time forensic analysis.
- **Core idea**: Forensic signals are extracted **in the browser** at ~10 Hz and fused into a calibrated threat score at the **edge** — so an active social-engineering attack can be flagged while it is happening.

## Features

| Section | What it does |
|---|---|
| **Live Webcam Detection** | Continuous frame-by-frame forensic analysis with a live Threat Meter, bounding boxes over the detected face region, and pipeline telemetry (render rate, inference rate, frames dropped). |
| **Video Detection** | Upload/drop a video → adaptive frame sampling → per-frame threat timeline + aggregated verdict + scrub-synced bounding boxes. |
| **Audio Detection** | Upload/drop audio → full DSP pass (F0 tracking, jitter, shimmer, HNR, roll-off) → verdict + waveform + average magnitude spectrum. |
| **Dashboard** | Three tabs (Live / Video / Audio), each with its own threat meter and signal breakdown. |
| **History** | Slide-out drawer with all recent scans, per-mode filters, summary stats, and per-entry delete. Persisted in Cloudflare D1. |
| **Dark / Light mode** | Theme toggle persisted to `localStorage`, applied pre-paint to avoid flash. Canvases repaint on theme change. |

## ⚠️ Architectural Note — Deviation From the Original Spec

The original proposal specified **FastAPI + WebSockets + PyTorch/ONNX + Redis Pub/Sub**. That stack **cannot run on Cloudflare Pages/Workers** (no Python runtime, no persistent socket server, no native binaries, 10–30 ms CPU budget per request).

**The pipeline was therefore inverted rather than dropped:**

| Original design | This implementation |
|---|---|
| Browser streams raw chunks to server | Browser **extracts forensic signals locally** (Canvas 2D + WebAudio DSP) |
| PyTorch/ONNX inference on server | Signal extraction in JS; **logistic ensemble fusion** at the edge |
| WebSocket continuous ingest | `fetch` at a rate-limited ~10 Hz cadence |
| Redis Pub/Sub + background threads for backpressure | **Single-flight gate + frame dropping** in the rAF loop |

**What this preserves:** the central engineering challenge — *latency and backpressure management*. The render loop runs at display rate while inference is rate-limited and **drops frames instead of queueing** when a request is in flight, so the stream never stalls. Drop rate is shown live in the telemetry panel.

**Bonus:** raw media never leaves the device, so this is privacy-preserving by construction.

**What this is not:** a trained neural deepfake detector. See *Detection Limits* below.

## URLs

- **Local dev**: http://localhost:3000
- **Production**: not yet deployed
- **GitHub**: see repository this code was pushed to

## API Reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Dashboard SPA |
| `POST` | `/api/analyze` | Fuse a signal vector → threat score. Body: `{ mode: 'live'\|'video'\|'audio', signals: {...}, meta?: {...}, persist?: bool }` |
| `GET` | `/api/signals/:kind` | Signal catalogue (`video` \| `audio`) with weights and descriptions |
| `GET` | `/api/history?limit=&mode=` | Recent scans |
| `GET` | `/api/history/stats` | Aggregate counts + average score |
| `DELETE` | `/api/history/:id` | Delete one scan |
| `DELETE` | `/api/history` | Clear all history |
| `GET` | `/api/health` | Health probe |

## Forensic Signals

### Video (7 signals)
`noise_residual` (sensor PRNU) · `spectral_peak` (GAN upsampling artifacts) · `blend_seam` (face-swap mask boundary) · `temporal_flicker` (inter-frame incoherence) · `blink_anomaly` (blink-rate deviation) · `color_coherence` (face-vs-scene colour temperature) · `edge_sharpness` (face-vs-background sharpness disparity)

### Audio (7 signals)
`hf_rolloff` (vocoder bandwidth cliff) · `jitter` (cycle-to-cycle F0 instability) · `shimmer` (cycle amplitude variation) · `hnr` (harmonic-to-noise ratio) · `noise_floor` (room tone presence) · `formant_var` (formant trajectory variance) · `phase_coherence` (phase-reconstruction signature)

Scores fuse via a weighted logistic ensemble → **0–100**, thresholded as `<35` authentic · `35–65` suspicious · `≥65` manipulated. Confidence scales with signal coverage and inter-signal agreement.

## Validation Performed

The DSP engine was tested against synthetic reference signals with **known ground-truth properties** (phase-accumulated FM for correct instantaneous frequency):

| Measurement | Natural ref | Cloned ref | Verdict |
|---|---|---|---|
| Mean F0 | 120 Hz ✅ | 120 Hz ✅ | tracker accurate |
| Jitter | 0.0080 | 0.0000 | separated |
| Shimmer | 0.0234 | 0.0018 | separated |
| HNR | 38 dB | 54 dB | separated |
| Noise floor | −63 dBFS | −96 dBFS | separated |
| HF roll-off | 0.21 | 0.84 | separated |
| **Fused score** | **4.6 → authentic** | **98.5 → manipulated** | ✅ |

Four real bugs were found and fixed during this validation:
1. **F0 octave errors** — loose sub-harmonic acceptance picked wrong periods (read 178 Hz for a 120 Hz signal). Fixed by restricting correction to true sub-multiples (/2, /3) at ≥95% correlation.
2. **Quantised F0 → fake jitter** — integer-lag-only search fabricated instability. Fixed with parabolic peak interpolation.
3. **Fabricated shimmer** — one peak per frame was corrupted by burst-boundary alignment. Fixed by measuring cycle-to-cycle variation *within* each frame.
4. **Blind noise floor** — percentile over 2048-sample analysis frames smeared over speech micro-pauses. Fixed with 256-sample window scanning.

Thresholds were then recalibrated against clinical voice-science norms, which eliminated a false positive (natural audio had scored 84.8).

## ⚠️ Detection Limits — Please Read

DeepGuard uses **classical signal forensics**, not a trained deepfake classifier. This has real consequences:

- **Not validated on real deepfakes.** Verified against synthetic reference signals with known properties, *not* against FaceForensics++, DFDC, ASVspoof or real generator output. True accuracy on real-world fakes is **unmeasured**.
- **Compression confounds video signals.** Heavy re-encoding (video calls, social platforms) strips sensor noise and softens edges — the same markers used for detection. Expect false positives on low-bitrate footage.
- **Skin-tone face detection is approximate.** The YCbCr gate is lighting-sensitive and biases across skin tones; it falls back to a centred region when segmentation fails. Bounding boxes are indicative, not precise.
- **Audio signals assume clean speech.** Music, heavy background noise, or aggressive codecs (low-bitrate MP3 already rolls off HF) can mimic synthesis markers.
- **Thresholds are literature-derived, not learned.** They encode published natural-capture ranges, not fitted decision boundaries.
- **Modern high-quality generators may pass.** Current diffusion/vocoder systems increasingly reproduce noise and micro-variation.

**Treat output as a triage signal, never as proof.** Corroborate out-of-band (call back on a known number, use a shared secret) before acting.

## Data Architecture

- **Storage**: Cloudflare D1 (SQLite) — single `scans` table
- **Columns**: `session_id`, `mode`, `label`, `threat_score`, `confidence`, `source_name`, `duration_ms`, `frames_analyzed`, `signals_json`, `created_at`
- **Privacy**: only numeric signal vectors and metadata are stored; **no media is uploaded or retained**
- **Schema**: `migrations/0001_initial_schema.sql`, plus idempotent bootstrap in `src/index.tsx` for self-healing previews

## User Guide

1. **Live**: open *Live Webcam* → **Start Stream** → grant camera permission. The meter updates ~10×/sec; toggle bounding boxes; **Save to History** stores a session summary.
2. **Video**: open *Video Detection* → choose/drop a file → **Analyze Video**. Watch the timeline build, then scrub to see per-frame boxes.
3. **Audio**: open *Audio Detection* → choose/drop a file → **Analyze Audio**. Review the verdict, spectrum, and signal breakdown.
4. **History**: click **History** (top-right) for past scans, filters and stats.
5. **Theme**: sun/moon icon toggles dark/light.

Hover any signal name to see what it measures and why it matters.

## Local Development

```bash
npm install
npm run build
npx wrangler d1 migrations apply webapp-production --local
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

PM2 helpers: `pm2 logs deepguard --nostream` · `pm2 restart deepguard` · `pm2 delete deepguard`

> **Note**: `wrangler.jsonc` has a placeholder `database_id`. Before deploying, run `npx wrangler d1 create webapp-production` and paste the real ID.

## Tech Stack

- **Backend**: Hono on Cloudflare Workers/Pages
- **Storage**: Cloudflare D1
- **Frontend**: Vanilla JS + Tailwind (CDN) + Font Awesome, Canvas 2D for all visualisation
- **DSP**: hand-written radix-2 FFT, normalised autocorrelation F0 tracker with parabolic interpolation
- **Build/Process**: Vite + Wrangler, PM2

## Not Yet Implemented

- Trained ML model (ONNX via WASM/WebGPU) to replace heuristic fusion
- Live **microphone** analysis during webcam streaming (audio tab is file-only)
- Benchmarking against public deepfake datasets with reported precision/recall
- Proper face landmark detection (replacing the skin-tone heuristic)
- Export of scan reports (PDF/JSON); multi-face tracking

## Recommended Next Steps

1. **Benchmark against real datasets** (FaceForensics++, DFDC, ASVspoof) and publish measured accuracy — the single highest-value step.
2. **Ship a small ONNX model** via `onnxruntime-web` (WASM/WebGPU) and blend with heuristics.
3. **Replace skin-tone detection** with MediaPipe Face Detector to remove lighting/skin-tone bias.
4. **Add live mic analysis** so a video call is scored on both channels simultaneously.
5. **Compression-aware calibration** — estimate bitrate and relax noise/edge thresholds accordingly.

## Deployment

- **Platform**: Cloudflare Pages
- **Status**: ❌ Not deployed (runs locally; deploy requires a real D1 `database_id`)
- **Last Updated**: 2026-10-26
