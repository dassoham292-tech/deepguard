/* =====================================================================
 * DeepGuard — Client-Side Forensic Extraction Engine
 * =====================================================================
 * All heavy signal extraction runs here, in the browser:
 *   - Video: sensor-noise residual, FFT periodicity, blend seams,
 *            temporal flicker, edge-sharpness disparity, chroma coherence
 *   - Audio: spectral roll-off, F0 jitter, shimmer, HNR, noise floor,
 *            formant-trajectory variance, phase coherence
 *
 * Only the resulting numeric vectors are sent to the edge for fusion.
 * Raw media never leaves the device.
 * ===================================================================== */

(function (global) {
  'use strict';

  /* ================================================================
   * Small numeric helpers
   * ================================================================ */
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    const i = clamp(Math.floor((p / 100) * (s.length - 1)), 0, s.length - 1);
    return s[i];
  }

  /* ================================================================
   * FFT — iterative radix-2 Cooley–Tukey
   * ================================================================ */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k],         ui = im[i + k];
          const vr0 = re[i + k + len / 2], vi0 = im[i + k + len / 2];
          const vr = vr0 * cr - vi0 * ci;
          const vi = vr0 * ci + vi0 * cr;
          re[i + k] = ur + vr;  im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function magnitudeSpectrum(samples) {
    let n = 1;
    while (n * 2 <= samples.length) n *= 2;
    if (n < 64) return null;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Hann window
      re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    fft(re, im);
    const half = n / 2;
    const mag = new Float64Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  /* ================================================================
   * VIDEO FORENSICS
   * ================================================================ */

  const WORK = 256; // analysis resolution (square-ish, fast and consistent)

  function makeWorkCanvas() {
    const c = document.createElement('canvas');
    c.width = WORK; c.height = WORK;
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  }

  /** Luma plane from RGBA ImageData. */
  function luma(data, w, h) {
    const y = new Float64Array(w * h);
    for (let i = 0, p = 0; i < y.length; i++, p += 4) {
      y[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return y;
  }

  /**
   * Locate the dominant face-like region using chroma-based skin
   * segmentation (YCbCr gating) + connected bounding box.
   * Falls back to a centred region when segmentation is inconclusive.
   */
  function locateFace(data, w, h) {
    const colSum = new Float64Array(w);
    const rowSum = new Float64Array(h);
    let count = 0;

    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const p = (yy * w + xx) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        // Standard skin-tone gate
        if (Y > 45 && Cb > 85 && Cb < 135 && Cr > 132 && Cr < 180 && r > g && r > b) {
          colSum[xx]++; rowSum[yy]++; count++;
        }
      }
    }

    const minPixels = w * h * 0.015;
    if (count < minPixels) {
      // Fallback: centred portrait region
      return { x: w * 0.28, y: h * 0.18, w: w * 0.44, h: h * 0.56, found: false, coverage: count / (w * h) };
    }

    const span = (sums, limit) => {
      const peak = Math.max(...sums);
      const thr = peak * 0.22;
      let lo = 0, hi = limit - 1;
      while (lo < limit && sums[lo] < thr) lo++;
      while (hi > lo && sums[hi] < thr) hi--;
      return [lo, hi];
    };

    const [x0, x1] = span(colSum, w);
    const [y0, y1] = span(rowSum, h);
    const bw = Math.max(16, x1 - x0), bh = Math.max(16, y1 - y0);

    return { x: x0, y: y0, w: bw, h: bh, found: true, coverage: count / (w * h) };
  }

  /** Mean |high-pass| energy — proxy for sensor noise residual (PRNU). */
  function noiseResidual(Y, w, h, box) {
    const x0 = Math.max(1, Math.floor(box.x)), x1 = Math.min(w - 2, Math.floor(box.x + box.w));
    const y0 = Math.max(1, Math.floor(box.y)), y1 = Math.min(h - 2, Math.floor(box.y + box.h));
    let acc = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = yy * w + xx;
        // 3x3 Laplacian-of-Gaussian style high-pass
        const hp =
          8 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w] -
          Y[i - w - 1] - Y[i - w + 1] - Y[i + w - 1] - Y[i + w + 1];
        acc += Math.abs(hp);
        n++;
      }
    }
    if (!n) return 0.03;
    // Normalise into a ~0..0.1 band comparable to the server ramp
    return clamp(acc / n / 255 / 8, 0, 1);
  }

  /**
   * GAN upsampling artifacts: look for periodic peaks in the 1D
   * spectrum of row/column luma signals (checkerboard signature).
   */
  function spectralPeakiness(Y, w, h, box) {
    const cy = Math.floor(clamp(box.y + box.h / 2, 0, h - 1));
    const cx = Math.floor(clamp(box.x + box.w / 2, 0, w - 1));

    const row = [], col = [];
    for (let xx = 0; xx < w; xx++) row.push(Y[cy * w + xx]);
    for (let yy = 0; yy < h; yy++) col.push(Y[yy * w + cx]);

    let score = 0, used = 0;
    for (const sig of [row, col]) {
      const m = magnitudeSpectrum(sig);
      if (!m) continue;
      // Inspect upper half of the band, where upsampling peaks live
      const start = Math.floor(m.length * 0.45);
      const tail = Array.from(m.slice(start));
      if (tail.length < 8) continue;
      const med = percentile(tail, 50) || 1e-6;
      const peak = percentile(tail, 98);
      // Peak-to-median ratio: high => periodic artifact present
      score += clamp((peak / med - 2.2) / 9, 0, 1);
      used++;
    }
    return used ? score / used : 0;
  }

  /** Gradient discontinuity along the face-box boundary. */
  function blendSeam(Y, w, h, box) {
    const samples = [];
    const probe = (x, y, dx, dy) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 2 || yi < 2 || xi > w - 3 || yi > h - 3) return;
      const i = yi * w + xi;
      const inner = Y[i - dy * w - dx];
      const outer = Y[i + dy * w + dx];
      const mid = Y[i];
      // Second derivative across the boundary
      samples.push(Math.abs(inner + outer - 2 * mid));
    };

    const steps = 48;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      probe(box.x + box.w * t, box.y, 0, 2);               // top
      probe(box.x + box.w * t, box.y + box.h, 0, 2);        // bottom
      probe(box.x, box.y + box.h * t, 2, 0);                // left
      probe(box.x + box.w, box.y + box.h * t, 2, 0);        // right
    }
    if (!samples.length) return 0;
    // Compare boundary 2nd-derivative energy against interior baseline
    const boundary = percentile(samples, 80);
    return clamp(boundary / 90, 0, 1);
  }

  /** Laplacian variance inside face vs outside — sharpness disparity. */
  function edgeDisparity(Y, w, h, box) {
    const lap = (i) => 4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w];
    const inside = [], outside = [];
    for (let yy = 2; yy < h - 2; yy += 2) {
      for (let xx = 2; xx < w - 2; xx += 2) {
        const i = yy * w + xx;
        const v = lap(i) ** 2;
        const isIn = xx >= box.x && xx <= box.x + box.w && yy >= box.y && yy <= box.y + box.h;
        (isIn ? inside : outside).push(v);
      }
    }
    if (inside.length < 10 || outside.length < 10) return 0;
    const vi = mean(inside), vo = mean(outside);
    if (vo < 1e-6) return 0;
    // Face notably softer than background => resampled/generated
    const ratio = vi / vo;
    return clamp((1 - ratio) / 0.75, 0, 1);
  }

  /** Colour-temperature mismatch between face region and scene. */
  function chromaCoherence(data, w, h, box) {
    const acc = (x0, y0, x1, y1, skipBox) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 2) {
        for (let xx = x0; xx < x1; xx += 2) {
          if (skipBox && xx >= box.x && xx <= box.x + box.w && yy >= box.y && yy <= box.y + box.h) continue;
          const p = (yy * w + xx) * 4;
          r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : null;
    };

    const face = acc(
      Math.max(0, Math.floor(box.x)), Math.max(0, Math.floor(box.y)),
      Math.min(w, Math.floor(box.x + box.w)), Math.min(h, Math.floor(box.y + box.h)),
      false,
    );
    const scene = acc(0, 0, w, h, true);
    if (!face || !scene) return 0;

    // Compare R/B ratio (colour temperature proxy), normalised by luma
    const temp = (c) => (c[0] + 1) / (c[2] + 1);
    const d = Math.abs(temp(face) - temp(scene));
    return clamp(d / 0.6, 0, 1);
  }

  /**
   * Stateful video analyser — maintains temporal history so flicker and
   * blink-rate signals can be computed across frames.
   */
  class VideoAnalyzer {
    constructor() {
      const { canvas, ctx } = makeWorkCanvas();
      this.canvas = canvas;
      this.ctx = ctx;
      this.reset();
    }

    reset() {
      this.prevFaceLuma = null;
      this.flickerHist = [];
      this.eyeHist = [];
      this.blinkTimes = [];
      this.startedAt = performance.now();
      this.frames = 0;
    }

    /** Analyse one frame from a <video> (or any drawable source). */
    analyze(source) {
      const sw = source.videoWidth || source.width;
      const sh = source.videoHeight || source.height;
      if (!sw || !sh) return null;

      this.ctx.drawImage(source, 0, 0, WORK, WORK);
      const img = this.ctx.getImageData(0, 0, WORK, WORK);
      const data = img.data;
      const Y = luma(data, WORK, WORK);
      const box = locateFace(data, WORK, WORK);

      const signals = {
        noise_residual: noiseResidual(Y, WORK, WORK, box),
        spectral_peak: spectralPeakiness(Y, WORK, WORK, box),
        blend_seam: blendSeam(Y, WORK, WORK, box),
        edge_sharpness: edgeDisparity(Y, WORK, WORK, box),
        color_coherence: chromaCoherence(data, WORK, WORK, box),
      };

      /* ---- temporal: flicker + blink ---- */
      const faceLuma = this.#faceVector(Y, box);
      if (this.prevFaceLuma && this.prevFaceLuma.length === faceLuma.length) {
        let diff = 0;
        for (let i = 0; i < faceLuma.length; i++) {
          diff += Math.abs(faceLuma[i] - this.prevFaceLuma[i]);
        }
        diff /= faceLuma.length * 255;
        this.flickerHist.push(diff);
        if (this.flickerHist.length > 90) this.flickerHist.shift();
      }
      this.prevFaceLuma = faceLuma;

      if (this.flickerHist.length >= 5) {
        // Texture flicker = variability of inter-frame change
        signals.temporal_flicker = clamp(stdev(this.flickerHist) * 14, 0, 1);
      }

      const blink = this.#blinkRate(Y, box);
      if (blink !== null) signals.blink_anomaly = blink;

      this.frames++;
      return { signals, box: this.#scaleBox(box, sw, sh), raw_box: box };
    }

    /** Downsampled luma grid of the face region (motion-robust). */
    #faceVector(Y, box) {
      const G = 12;
      const v = new Float64Array(G * G);
      for (let gy = 0; gy < G; gy++) {
        for (let gx = 0; gx < G; gx++) {
          const xx = Math.floor(clamp(box.x + (box.w * (gx + 0.5)) / G, 0, WORK - 1));
          const yy = Math.floor(clamp(box.y + (box.h * (gy + 0.5)) / G, 0, WORK - 1));
          v[gy * G + gx] = Y[yy * WORK + xx];
        }
      }
      return v;
    }

    /**
     * Blink detection: track mean luma in the upper-face eye band.
     * Eyelid closure produces a short dip. Returns a deviation score
     * from the natural 8–28 blinks/min range, or null while warming up.
     */
    #blinkRate(Y, box) {
      const ex0 = Math.floor(clamp(box.x + box.w * 0.18, 0, WORK - 1));
      const ex1 = Math.floor(clamp(box.x + box.w * 0.82, 0, WORK - 1));
      const ey0 = Math.floor(clamp(box.y + box.h * 0.22, 0, WORK - 1));
      const ey1 = Math.floor(clamp(box.y + box.h * 0.46, 0, WORK - 1));
      let acc = 0, n = 0;
      for (let yy = ey0; yy < ey1; yy++) {
        for (let xx = ex0; xx < ex1; xx++) { acc += Y[yy * WORK + xx]; n++; }
      }
      if (!n) return null;
      const m = acc / n;
      this.eyeHist.push({ v: m, t: performance.now() });
      if (this.eyeHist.length > 150) this.eyeHist.shift();
      if (this.eyeHist.length < 30) return null;

      const vals = this.eyeHist.map((e) => e.v);
      const base = percentile(vals, 60);
      const sd = stdev(vals) || 1;

      // Detect a fresh dip (closure) with refractory period
      const last = this.eyeHist[this.eyeHist.length - 1];
      if (last.v < base - 1.15 * sd) {
        const prev = this.blinkTimes[this.blinkTimes.length - 1];
        if (!prev || last.t - prev > 220) this.blinkTimes.push(last.t);
      }
      this.blinkTimes = this.blinkTimes.filter((t) => last.t - t < 60000);

      const elapsedMin = (performance.now() - this.startedAt) / 60000;
      if (elapsedMin < 0.12) return null; // need ~7s before rate is meaningful
      return this.blinkTimes.length / elapsedMin; // raw rate; server bands it
    }

    #scaleBox(box, sw, sh) {
      return {
        x: box.x / WORK, y: box.y / WORK,
        w: box.w / WORK, h: box.h / WORK,
        found: box.found,
      };
    }
  }

  /* ================================================================
   * AUDIO FORENSICS
   * ================================================================ */

  /**
   * Normalised autocorrelation F0 estimate with parabolic peak
   * interpolation. Integer-lag-only search quantises badly at low
   * periods (e.g. 16 kHz / lag 133 ≈ 0.9 Hz steps), which manifests as
   * spurious jitter; sub-lag interpolation removes that artifact.
   */
  function estimateF0(frame, sr) {
    const minLag = Math.floor(sr / 400); // 400 Hz ceiling
    const maxLag = Math.floor(sr / 70);  // 70 Hz floor
    if (frame.length < maxLag * 2) return 0;

    // Correlation window spans many pitch periods (frame.length - maxLag),
    // not just maxLag samples — a short window gives noisy, unstable peaks.
    const W = frame.length - maxLag;
    if (W < maxLag) return 0;

    let energy0 = 0;
    for (let i = 0; i < W; i++) energy0 += frame[i] * frame[i];
    if (energy0 < 1e-9) return 0;

    const nac = new Float64Array(maxLag + 2);
    let best = -1, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, e = 0;
      for (let i = 0; i < W; i++) {
        corr += frame[i] * frame[i + lag];
        e += frame[i + lag] * frame[i + lag];
      }
      const norm = corr / (Math.sqrt(energy0 * e) + 1e-12);
      nac[lag] = norm;
      if (norm > best) { best = norm; bestLag = lag; }
    }
    if (best < 0.3 || !bestLag) return 0;

    // Octave correction: only consider true sub-multiples of the winning
    // lag (period/2, /3), and require them to be nearly as strong. A loose
    // "any shorter lag" rule picks spurious sub-harmonics on harmonic-rich
    // signals and inflates the apparent F0.
    for (const div of [2, 3]) {
      const cand = Math.round(bestLag / div);
      if (cand < minLag) continue;
      if (nac[cand] >= best * 0.95) { bestLag = cand; best = nac[cand]; break; }
    }

    // Parabolic interpolation around the peak for sub-sample precision
    const ym = nac[bestLag - 1] || 0;
    const y0 = nac[bestLag];
    const yp = nac[bestLag + 1] || 0;
    const denom = ym - 2 * y0 + yp;
    const delta = denom !== 0 ? clamp((0.5 * (ym - yp)) / denom, -1, 1) : 0;

    const refined = bestLag + delta;
    return refined > 0 ? sr / refined : 0;
  }

  /**
   * Noise-floor estimate from fine-grained short windows. Speech always
   * contains micro-pauses between phonemes; sampling at analysis-frame
   * resolution (2048) smears over them, so we scan 256-sample windows
   * and take a low percentile.
   */
  function noiseFloorDb(ch) {
    const W = 256;
    const windows = [];
    const step = Math.max(W, Math.floor(ch.length / 4000) * W || W);
    for (let off = 0; off + W <= ch.length; off += step) {
      let e = 0;
      for (let i = 0; i < W; i++) e += ch[off + i] * ch[off + i];
      windows.push(Math.sqrt(e / W));
    }
    if (!windows.length) return -60;
    const q = percentile(windows, 3);
    return 20 * Math.log10(Math.max(q, 1e-7));
  }

  function analyzeAudioBuffer(buf, onProgress) {
    const sr = buf.sampleRate;
    const ch = buf.getChannelData(0);
    const N = ch.length;

    const frameLen = 2048;
    const hop = 1024;
    const maxFrames = Math.floor((N - frameLen) / hop);
    if (maxFrames < 4) return null;

    // Cap work for very long files: sample up to ~700 frames evenly
    const targetFrames = Math.min(maxFrames, 700);
    const stride = Math.max(1, Math.floor(maxFrames / targetFrames));

    const f0s = [];
    const peaks = [];
    const frameRms = [];
    const centroids = [];
    const rolloffs = [];
    let spectrumAccum = null;
    let spectrumCount = 0;
    let harmonicRatioAcc = 0, harmonicRatioN = 0;
    let phaseAcc = 0, phaseN = 0;

    for (let fi = 0, done = 0; fi < maxFrames; fi += stride, done++) {
      const off = fi * hop;
      const frame = ch.subarray(off, off + frameLen);

      // RMS
      let e = 0;
      for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
      const rms = Math.sqrt(e / frame.length);
      frameRms.push(rms);

      if (rms > 0.008) {
        const f0 = estimateF0(frame, sr);
        if (f0 > 0) {
          f0s.push(f0);
          // Cycle-to-cycle amplitude variation measured WITHIN this frame.
          // Comparing one peak per frame instead would be corrupted by
          // frame/burst-boundary alignment and fabricate shimmer.
          const period = Math.floor(sr / f0);
          if (period >= 8) {
            const cyclePeaks = [];
            for (let c = 0; (c + 1) * period <= frame.length; c++) {
              let pk = 0;
              for (let i = c * period; i < (c + 1) * period; i++) {
                const v = Math.abs(frame[i]);
                if (v > pk) pk = v;
              }
              cyclePeaks.push(pk);
            }
            if (cyclePeaks.length >= 3) {
              const m = mean(cyclePeaks);
              if (m > 1e-6) {
                let acc = 0;
                for (let i = 1; i < cyclePeaks.length; i++) {
                  acc += Math.abs(cyclePeaks[i] - cyclePeaks[i - 1]);
                }
                peaks.push(acc / (cyclePeaks.length - 1) / m);
              }
            }
          }
        }

        const mag = magnitudeSpectrum(frame);
        if (mag) {
          if (!spectrumAccum) spectrumAccum = new Float64Array(mag.length);
          for (let i = 0; i < mag.length; i++) spectrumAccum[i] += mag[i];
          spectrumCount++;

          // spectral centroid
          let num = 0, den = 0;
          for (let i = 0; i < mag.length; i++) { num += i * mag[i]; den += mag[i]; }
          if (den > 0) centroids.push(num / den / mag.length);

          // 95% roll-off point (as fraction of Nyquist)
          const total = den;
          let run = 0, ro = mag.length - 1;
          for (let i = 0; i < mag.length; i++) {
            run += mag[i];
            if (run >= total * 0.95) { ro = i; break; }
          }
          rolloffs.push(ro / mag.length);

          // Harmonic-to-noise proxy: energy at harmonic bins vs between
          if (f0 > 0) {
            const binHz = sr / 2 / mag.length;
            let harm = 0, noise = 0;
            for (let k = 1; k <= 12; k++) {
              const hb = Math.round((f0 * k) / binHz);
              if (hb >= mag.length - 2) break;
              harm += mag[hb] ** 2;
              const nb = Math.round((f0 * (k + 0.5)) / binHz);
              if (nb < mag.length) noise += mag[nb] ** 2;
            }
            if (noise > 1e-12 && harm > 0) {
              harmonicRatioAcc += 10 * Math.log10(harm / noise);
              harmonicRatioN++;
            }
          }

          // Phase coherence proxy: smoothness of the magnitude envelope
          // in the mid band (vocoder output is unusually regular).
          let smooth = 0, sn = 0;
          const a = Math.floor(mag.length * 0.1), b = Math.floor(mag.length * 0.5);
          for (let i = a + 1; i < b - 1; i++) {
            const d2 = Math.abs(mag[i - 1] + mag[i + 1] - 2 * mag[i]);
            smooth += d2 / (mag[i] + 1e-9);
            sn++;
          }
          if (sn) { phaseAcc += clamp(1 - smooth / sn / 2, 0, 1); phaseN++; }
        }
      }

      if (onProgress && done % 25 === 0) onProgress(fi / maxFrames);
    }

    /* ---- derive signals ---- */
    const signals = {};

    // Spectral roll-off cliff: how far below Nyquist the energy stops
    if (rolloffs.length) {
      const ro = percentile(rolloffs, 75);
      signals.hf_rolloff = clamp(1 - ro / 0.9, 0, 1);
    }

    // Jitter: median relative |ΔF0| between consecutive voiced frames.
    // The median (not mean) rejects large jumps caused by intonation
    // changes and voiced/unvoiced boundaries, isolating micro-instability.
    if (f0s.length > 8) {
      const m = mean(f0s);
      if (m > 0) {
        const diffs = [];
        for (let i = 1; i < f0s.length; i++) {
          // Ignore octave-scale transitions between separate utterances
          const rel = Math.abs(f0s[i] - f0s[i - 1]) / m;
          if (rel < 0.35) diffs.push(rel);
        }
        signals.jitter = diffs.length ? percentile(diffs, 50) : 0;
      }
    }

    // Shimmer: median of the per-frame intra-frame cycle variation
    if (peaks.length > 4) signals.shimmer = percentile(peaks, 50);

    // HNR in dB
    if (harmonicRatioN) signals.hnr = harmonicRatioAcc / harmonicRatioN;

    // Noise floor in dBFS measured over fine-grained windows
    signals.noise_floor = noiseFloorDb(ch);

    // Formant-trajectory variance via spectral-centroid movement
    if (centroids.length > 8) signals.formant_var = stdev(centroids);

    if (phaseN) signals.phase_coherence = phaseAcc / phaseN;

    // Average spectrum for the visualiser
    let spectrum = null;
    if (spectrumAccum && spectrumCount) {
      spectrum = Array.from(spectrumAccum.slice(0, 256)).map((v) => v / spectrumCount);
    }

    return {
      signals,
      meta: {
        sample_rate: sr,
        duration_ms: Math.round((N / sr) * 1000),
        frames_analyzed: f0s.length,
        voiced_frames: f0s.length,
        mean_f0: f0s.length ? Math.round(mean(f0s)) : 0,
      },
      spectrum,
      waveform: downsampleWave(ch, 900),
    };
  }

  function downsampleWave(ch, buckets) {
    const out = new Array(buckets).fill(0);
    const block = Math.floor(ch.length / buckets) || 1;
    for (let i = 0; i < buckets; i++) {
      let pk = 0;
      const s = i * block;
      for (let j = 0; j < block && s + j < ch.length; j += 4) {
        const v = Math.abs(ch[s + j]);
        if (v > pk) pk = v;
      }
      out[i] = pk;
    }
    return out;
  }

  /* ================================================================
   * Export
   * ================================================================ */
  global.DGForensics = {
    VideoAnalyzer,
    analyzeAudioBuffer,
    utils: { mean, stdev, percentile, clamp, magnitudeSpectrum },
  };
})(window);
