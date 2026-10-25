/* =====================================================================
 * DeepGuard — Application Controller
 * ===================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SESSION = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());

  /* ================================================================
   * Theme
   * ================================================================ */
  $('theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const nowDark = !root.classList.contains('dark');
    root.classList.toggle('dark', nowDark);
    try { localStorage.setItem('dg-theme', nowDark ? 'dark' : 'light'); } catch (e) {}
    // Repaint canvases that depend on theme colours
    if (lastAudio) { drawSpectrum(lastAudio.spectrum); drawWave(lastAudio.waveform); }
    if (videoTimeline.length) drawTimeline();
  });

  /* ================================================================
   * Toasts
   * ================================================================ */
  function toast(msg, icon = 'circle-info') {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<i class="fas fa-${icon}"></i><span></span>`;
    el.querySelector('span').textContent = msg;
    $('toast-stack').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  /* ================================================================
   * Tabs
   * ================================================================ */
  const PANELS = ['live', 'video', 'audio'];
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) =>
        b.classList.toggle('tab-active', b.dataset.tab === target),
      );
      PANELS.forEach((p) => $('panel-' + p).classList.toggle('hidden', p !== target));
      if (target !== 'live' && streaming) stopStream();
      if (target === 'audio' && lastAudio) {
        requestAnimationFrame(() => { drawSpectrum(lastAudio.spectrum); drawWave(lastAudio.waveform); });
      }
      if (target === 'video' && videoTimeline.length) requestAnimationFrame(drawTimeline);
    });
  });

  /* ================================================================
   * Threat meter rendering
   * ================================================================ */
  const VERDICT = {
    authentic:   { color: '#10b981', ring: '#10b981', label: 'Likely Authentic',  icon: 'shield-check' },
    suspicious:  { color: '#f59e0b', ring: '#f59e0b', label: 'Suspicious',        icon: 'triangle-exclamation' },
    manipulated: { color: '#ef4444', ring: '#ef4444', label: 'Likely Manipulated', icon: 'shield-virus' },
  };

  function scoreColor(score) {
    if (score >= 65) return VERDICT.manipulated.color;
    if (score >= 35) return VERDICT.suspicious.color;
    return VERDICT.authentic.color;
  }

  function renderMeter(hostId, result) {
    const host = $(hostId);
    if (!result) {
      host.innerHTML = `<div class="py-8 text-center text-sm text-slate-400 dark:text-slate-600">
          <i class="fas fa-gauge-simple-high text-2xl mb-2 block opacity-40"></i>Awaiting analysis
        </div>`;
      return;
    }
    const v = VERDICT[result.label];
    const score = result.threat_score;
    const R = 52, C = 2 * Math.PI * R;
    const offset = C * (1 - score / 100);

    host.innerHTML = `
      <div class="flex flex-col items-center py-2">
        <div class="relative w-[132px] h-[132px]">
          <svg viewBox="0 0 132 132" class="meter-ring w-full h-full">
            <circle cx="66" cy="66" r="${R}" fill="none" stroke="currentColor"
                    class="text-slate-200 dark:text-white/10" stroke-width="10"/>
            <circle cx="66" cy="66" r="${R}" fill="none" stroke="${v.ring}" stroke-width="10"
                    stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${offset}"/>
          </svg>
          <div class="absolute inset-0 grid place-items-center">
            <div class="text-center leading-none">
              <div class="text-3xl font-extrabold tabular-nums" style="color:${v.color}">${score.toFixed(0)}</div>
              <div class="text-[10px] font-bold tracking-widest text-slate-400 dark:text-slate-500 mt-1">/ 100</div>
            </div>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold"
             style="background:${v.color}1a;color:${v.color}">
          <i class="fas fa-${v.icon}"></i>${v.label}
        </div>
        <div class="mt-3 w-full">
          <div class="flex justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1">
            <span>Model confidence</span><span class="tabular-nums font-semibold">${(result.confidence * 100).toFixed(0)}%</span>
          </div>
          <div class="progress-track"><div class="progress-bar" style="width:${result.confidence * 100}%"></div></div>
        </div>
        <p class="mt-3 text-[11.5px] leading-relaxed text-slate-600 dark:text-slate-400">${escapeHtml(result.summary)}</p>
      </div>`;
  }

  function renderSignals(hostId, signals) {
    const host = $(hostId);
    if (!signals || !signals.length) {
      host.innerHTML = `<p class="text-sm text-slate-400 dark:text-slate-600 col-span-full">No signals extracted yet.</p>`;
      return;
    }
    host.innerHTML = signals
      .map((s) => {
        const pct = (s.value * 100).toFixed(0);
        const col = s.value >= 0.65 ? '#ef4444' : s.value >= 0.35 ? '#f59e0b' : '#10b981';
        return `
        <div class="sig-row group" title="${escapeHtml(s.description || '')}">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-medium truncate">${escapeHtml(s.name)}</span>
            <i class="fas fa-circle-question text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 transition"></i>
          </div>
          <span class="text-[11px] font-mono tabular-nums font-semibold" style="color:${col}">${pct}%</span>
          <div class="sig-track"><div class="sig-fill" style="width:${pct}%;background:${col}"></div></div>
        </div>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  /* ================================================================
   * API
   * ================================================================ */
  async function analyze(mode, signals, meta, persist) {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, signals, meta, persist: !!persist }),
    });
    if (!res.ok) throw new Error('Analysis failed (' + res.status + ')');
    return res.json();
  }

  /* ================================================================
   * LIVE WEBCAM  — backpressure-managed inference loop
   * ================================================================ */
  const webcam = $('webcam');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');

  let stream = null;
  let streaming = false;
  let analyzer = null;
  let rafId = null;
  let inFlight = false;          // single-flight gate (backpressure)
  let lastDispatch = 0;
  let framesAnalyzed = 0;
  let framesDropped = 0;
  let lastResult = null;
  let lastRawSignals = null;
  let smoothScore = 0;
  let lastBox = null;
  let fpsWindow = [];
  let sessionStart = 0;

  const TARGET_INTERVAL = 100; // ~10 analyses/sec ceiling

  $('cam-start').addEventListener('click', startStream);
  $('cam-stop').addEventListener('click', stopStream);
  $('cam-save').addEventListener('click', saveLiveSession);

  async function startStream() {
    if (streaming) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      toast('Camera access denied or unavailable', 'triangle-exclamation');
      return;
    }
    webcam.srcObject = stream;
    await webcam.play().catch(() => {});

    streaming = true;
    analyzer = new DGForensics.VideoAnalyzer();
    framesAnalyzed = 0; framesDropped = 0; lastResult = null;
    smoothScore = 0; lastBox = null; fpsWindow = [];
    sessionStart = performance.now();

    $('cam-placeholder').classList.add('hidden');
    $('live-badge').classList.remove('hidden');
    $('fps-badge').classList.remove('hidden');
    $('live-pulse').classList.remove('hidden');
    $('cam-start').disabled = true;
    $('cam-stop').disabled = false;
    $('cam-save').disabled = false;

    sizeOverlay();
    loop();
    toast('Live forensic stream started', 'video');
  }

  function stopStream() {
    if (!streaming) return;
    streaming = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    webcam.srcObject = null;

    $('cam-placeholder').classList.remove('hidden');
    $('live-badge').classList.add('hidden');
    $('fps-badge').classList.add('hidden');
    $('live-pulse').classList.add('hidden');
    $('cam-start').disabled = false;
    $('cam-stop').disabled = true;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    toast('Stream stopped', 'circle-stop');
  }

  function sizeOverlay() {
    const r = $('video-stage').getBoundingClientRect();
    overlay.width = r.width;
    overlay.height = r.height;
  }
  window.addEventListener('resize', () => { if (streaming) sizeOverlay(); });

  /**
   * Main loop. Demonstrates the backpressure strategy:
   *  - rAF drives the render cadence (smooth overlay at display rate)
   *  - inference is rate-limited to TARGET_INTERVAL
   *  - a single-flight gate drops frames while a request is in flight,
   *    so the stream never queues up or stalls.
   */
  function loop() {
    if (!streaming) return;
    rafId = requestAnimationFrame(loop);

    const now = performance.now();
    fpsWindow.push(now);
    while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();

    drawOverlay();
    updateTelemetry();

    if (webcam.readyState < 2) return;

    if (now - lastDispatch < TARGET_INTERVAL) return;
    if (inFlight) { framesDropped++; return; }   // backpressure: drop, don't queue

    lastDispatch = now;
    inFlight = true;

    let extracted = null;
    try {
      extracted = analyzer.analyze(webcam);
    } catch (e) {
      inFlight = false;
      return;
    }
    if (!extracted) { inFlight = false; return; }

    lastBox = extracted.box;
    lastRawSignals = extracted.signals;

    analyze('live', extracted.signals, { session_id: SESSION }, false)
      .then((r) => {
        lastResult = r;
        framesAnalyzed++;
        // Exponential smoothing keeps the meter readable at 10 Hz
        smoothScore = smoothScore === 0 ? r.threat_score : smoothScore * 0.72 + r.threat_score * 0.28;
        renderMeter('live-meter', { ...r, threat_score: smoothScore });
        renderSignals('live-signals', r.signals);
      })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  }

  function drawOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!$('boxes-toggle').checked || !lastBox) return;

    const W = overlay.width, H = overlay.height;
    // Correct for object-fit: cover letterboxing
    const vw = webcam.videoWidth || 16, vh = webcam.videoHeight || 9;
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;

    const x = ox + lastBox.x * dw;
    const y = oy + lastBox.y * dh;
    const w = lastBox.w * dw;
    const h = lastBox.h * dh;

    const score = smoothScore;
    const col = scoreColor(score);

    octx.save();
    octx.strokeStyle = col;
    octx.lineWidth = 2.5;
    octx.shadowColor = col;
    octx.shadowBlur = 12;

    // Corner brackets
    const L = Math.min(w, h) * 0.22;
    const corners = [
      [x, y, 1, 1], [x + w, y, -1, 1],
      [x, y + h, 1, -1], [x + w, y + h, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      octx.beginPath();
      octx.moveTo(cx + sx * L, cy);
      octx.lineTo(cx, cy);
      octx.lineTo(cx, cy + sy * L);
      octx.stroke();
    }

    // Label
    octx.shadowBlur = 0;
    const label = `${VERDICT[score >= 65 ? 'manipulated' : score >= 35 ? 'suspicious' : 'authentic'].label}  ${score.toFixed(0)}`;
    octx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    const tw = octx.measureText(label).width + 16;
    const ly = Math.max(0, y - 26);
    octx.fillStyle = col;
    octx.beginPath();
    if (octx.roundRect) octx.roundRect(x, ly, tw, 22, 6); else octx.rect(x, ly, tw, 22);
    octx.fill();
    octx.fillStyle = '#fff';
    octx.fillText(label, x + 8, ly + 15);
    octx.restore();
  }

  function updateTelemetry() {
    const fps = fpsWindow.length;
    $('fps-badge').textContent = `${fps} fps · ${framesAnalyzed} analysed`;
    const elapsed = ((performance.now() - sessionStart) / 1000) || 0;
    const rate = elapsed > 0 ? (framesAnalyzed / elapsed).toFixed(1) : '0.0';
    const total = framesAnalyzed + framesDropped;
    const dropPct = total ? ((framesDropped / total) * 100).toFixed(0) : '0';

    $('live-telemetry').innerHTML = `
      ${telRow('Render rate', fps + ' fps')}
      ${telRow('Inference rate', rate + ' /s')}
      ${telRow('Frames analysed', String(framesAnalyzed))}
      ${telRow('Frames dropped (backpressure)', framesDropped + ' · ' + dropPct + '%')}
      ${telRow('Session duration', elapsed.toFixed(0) + 's')}
      ${telRow('Face region', lastBox ? (lastBox.found ? 'Locked' : 'Estimated') : '—')}`;
  }

  function telRow(k, v) {
    return `<div class="flex justify-between gap-3">
        <dt class="text-slate-500 dark:text-slate-400">${k}</dt>
        <dd class="font-mono tabular-nums font-semibold">${escapeHtml(v)}</dd>
      </div>`;
  }

  async function saveLiveSession() {
    if (!lastRawSignals) { toast('Nothing to save yet', 'triangle-exclamation'); return; }
    try {
      await analyze('live', lastRawSignals, {
        session_id: SESSION,
        source_name: 'Webcam Stream',
        duration_ms: Math.round(performance.now() - sessionStart),
        frames_analyzed: framesAnalyzed,
      }, true);
      toast('Session saved to history', 'floppy-disk');
      refreshHistory();
    } catch (e) {
      toast('Could not save session', 'triangle-exclamation');
    }
  }

  /* ================================================================
   * VIDEO FILE DETECTION
   * ================================================================ */
  const vidPlayer = $('vid-player');
  const vidOverlay = $('vid-overlay');
  const vctx = vidOverlay.getContext('2d');
  let videoTimeline = [];
  let videoFile = null;
  let videoBoxes = [];

  $('vid-pick').addEventListener('click', () => $('vid-input').click());
  $('vid-input').addEventListener('change', (e) => loadVideo(e.target.files[0]));
  $('vid-reset').addEventListener('click', resetVideo);
  $('vid-analyze').addEventListener('click', runVideoAnalysis);

  const vdrop = $('video-drop');
  ['dragover', 'dragenter'].forEach((ev) =>
    vdrop.addEventListener(ev, (e) => { e.preventDefault(); vdrop.classList.add('ring-2', 'ring-cyan-400'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    vdrop.addEventListener(ev, (e) => { e.preventDefault(); vdrop.classList.remove('ring-2', 'ring-cyan-400'); }),
  );
  vdrop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) loadVideo(f);
    else toast('Please drop a video file', 'triangle-exclamation');
  });

  function loadVideo(file) {
    if (!file) return;
    videoFile = file;
    vidPlayer.src = URL.createObjectURL(file);
    vidPlayer.classList.remove('hidden');
    $('vid-placeholder').classList.add('hidden');
    $('vid-analyze').disabled = false;
    $('vid-reset').disabled = false;
    $('vid-filename').textContent = file.name;
    videoTimeline = []; videoBoxes = [];
    renderMeter('video-meter', null);
    renderSignals('video-signals', null);
    drawTimeline();
  }

  function resetVideo() {
    videoFile = null;
    vidPlayer.pause();
    vidPlayer.removeAttribute('src');
    vidPlayer.load();
    vidPlayer.classList.add('hidden');
    $('vid-placeholder').classList.remove('hidden');
    $('vid-analyze').disabled = true;
    $('vid-reset').disabled = true;
    $('vid-filename').textContent = '';
    $('vid-progress-wrap').classList.add('hidden');
    videoTimeline = []; videoBoxes = [];
    vctx.clearRect(0, 0, vidOverlay.width, vidOverlay.height);
    renderMeter('video-meter', null);
    renderSignals('video-signals', null);
    drawTimeline();
  }

  async function runVideoAnalysis() {
    if (!videoFile) return;
    const btn = $('vid-analyze');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner spin mr-2"></i>Analyzing…';
    $('vid-progress-wrap').classList.remove('hidden');
    videoTimeline = []; videoBoxes = [];

    try {
      await waitMeta(vidPlayer);
      const dur = vidPlayer.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('Unreadable duration');

      const SAMPLES = Math.min(40, Math.max(12, Math.floor(dur * 2)));
      const an = new DGForensics.VideoAnalyzer();
      const accum = {};
      let counted = 0;

      for (let i = 0; i < SAMPLES; i++) {
        const t = (dur * (i + 0.5)) / SAMPLES;
        await seekTo(vidPlayer, t);
        const ex = an.analyze(vidPlayer);
        if (!ex) continue;

        // Accumulate raw signals for the whole-file verdict
        for (const [k, v] of Object.entries(ex.signals)) {
          if (!Number.isFinite(v)) continue;
          (accum[k] = accum[k] || []).push(v);
        }
        counted++;

        // Per-frame score for the timeline
        const fr = await analyze('video', ex.signals, { session_id: SESSION }, false);
        videoTimeline.push({ t, score: fr.threat_score });
        videoBoxes.push({ t, box: ex.box, score: fr.threat_score });

        const pct = ((i + 1) / SAMPLES) * 100;
        $('vid-progress').style.width = pct + '%';
        $('vid-progress-text').textContent =
          `Sampling frame ${i + 1}/${SAMPLES} · t=${t.toFixed(2)}s`;
        drawTimeline();
      }

      if (!counted) throw new Error('No analysable frames');

      // Median-aggregate each signal across sampled frames (robust to outliers)
      const agg = {};
      for (const [k, arr] of Object.entries(accum)) {
        agg[k] = DGForensics.utils.percentile(arr, 50);
      }

      const result = await analyze(
        'video',
        agg,
        {
          session_id: SESSION,
          source_name: videoFile.name,
          duration_ms: Math.round(dur * 1000),
          frames_analyzed: counted,
        },
        true,
      );

      renderMeter('video-meter', result);
      renderSignals('video-signals', result.signals);
      $('vid-progress-text').textContent = `Analysed ${counted} frames across ${dur.toFixed(1)}s`;
      drawTimeline();
      attachVideoOverlay();
      refreshHistory();
      toast('Video analysis complete', 'circle-check');
    } catch (e) {
      toast('Video analysis failed: ' + e.message, 'triangle-exclamation');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magnifying-glass-chart mr-2"></i>Analyze Video';
    }
  }

  function waitMeta(v) {
    return v.readyState >= 1
      ? Promise.resolve()
      : new Promise((res, rej) => {
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', () => rej(new Error('Cannot decode video')), { once: true });
          setTimeout(() => rej(new Error('Video load timeout')), 15000);
        });
  }

  function seekTo(v, t) {
    return new Promise((res) => {
      let done = false;
      const ok = () => { if (!done) { done = true; setTimeout(res, 30); } };
      v.addEventListener('seeked', ok, { once: true });
      v.currentTime = t;
      setTimeout(ok, 1200);
    });
  }

  /** Live bounding box while scrubbing the analysed video. */
  function attachVideoOverlay() {
    const draw = () => {
      const r = vidPlayer.getBoundingClientRect();
      vidOverlay.width = r.width; vidOverlay.height = r.height;
      vctx.clearRect(0, 0, vidOverlay.width, vidOverlay.height);
      if (!videoBoxes.length) return;

      const t = vidPlayer.currentTime;
      let best = videoBoxes[0];
      for (const b of videoBoxes) if (Math.abs(b.t - t) < Math.abs(best.t - t)) best = b;

      const vw = vidPlayer.videoWidth || 16, vh = vidPlayer.videoHeight || 9;
      const W = vidOverlay.width, H = vidOverlay.height;
      const scale = Math.min(W / vw, H / vh);     // object-contain
      const dw = vw * scale, dh = vh * scale;
      const ox = (W - dw) / 2, oy = (H - dh) / 2;

      const x = ox + best.box.x * dw, y = oy + best.box.y * dh;
      const w = best.box.w * dw, h = best.box.h * dh;
      const col = scoreColor(best.score);

      vctx.save();
      vctx.strokeStyle = col; vctx.lineWidth = 2; vctx.shadowColor = col; vctx.shadowBlur = 10;
      const L = Math.min(w, h) * 0.22;
      for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        vctx.beginPath();
        vctx.moveTo(cx + sx * L, cy); vctx.lineTo(cx, cy); vctx.lineTo(cx, cy + sy * L);
        vctx.stroke();
      }
      vctx.shadowBlur = 0;
      vctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      const lbl = best.score.toFixed(0);
      vctx.fillStyle = col;
      const bw = vctx.measureText(lbl).width + 12;
      const ly = Math.max(0, y - 22);
      vctx.beginPath();
      if (vctx.roundRect) vctx.roundRect(x, ly, bw, 18, 5); else vctx.rect(x, ly, bw, 18);
      vctx.fill();
      vctx.fillStyle = '#fff';
      vctx.fillText(lbl, x + 6, ly + 13);
      vctx.restore();
    };
    vidPlayer.addEventListener('timeupdate', draw);
    vidPlayer.addEventListener('seeked', draw);
    vidPlayer.addEventListener('loadeddata', draw);
    window.addEventListener('resize', draw);
    draw();
  }

  function drawTimeline() {
    const cv = $('vid-timeline');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = 90;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dark = document.documentElement.classList.contains('dark');
    const grid = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';

    // Threshold bands
    ctx.fillStyle = dark ? 'rgba(239,68,68,.07)' : 'rgba(239,68,68,.06)';
    ctx.fillRect(0, 0, w, h * 0.35);
    ctx.fillStyle = dark ? 'rgba(245,158,11,.06)' : 'rgba(245,158,11,.05)';
    ctx.fillRect(0, h * 0.35, w, h * 0.3);

    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    if (!videoTimeline.length) {
      ctx.fillStyle = dark ? 'rgba(148,163,184,.5)' : 'rgba(100,116,139,.6)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('No timeline data', 8, h / 2);
      return;
    }

    const pts = videoTimeline.map((p, i) => ({
      x: videoTimeline.length === 1 ? w / 2 : (i / (videoTimeline.length - 1)) * w,
      y: h - (p.score / 100) * h,
      score: p.score,
    }));

    // Area fill
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(34,211,238,.35)');
    g.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, h);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, h);
    ctx.closePath();
    ctx.fillStyle = g; ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.stroke();

    // Points
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = scoreColor(p.score);
      ctx.fill();
    });
  }

  /* ================================================================
   * AUDIO FILE DETECTION
   * ================================================================ */
  let audioFile = null;
  let lastAudio = null;
  let audioEl = null;

  $('aud-pick').addEventListener('click', () => $('aud-input').click());
  $('aud-input').addEventListener('change', (e) => loadAudio(e.target.files[0]));
  $('aud-reset').addEventListener('click', resetAudio);
  $('aud-analyze').addEventListener('click', runAudioAnalysis);
  $('aud-play').addEventListener('click', toggleAudio);

  const adrop = $('audio-drop');
  ['dragover', 'dragenter'].forEach((ev) =>
    adrop.addEventListener(ev, (e) => { e.preventDefault(); adrop.classList.add('ring-2', 'ring-cyan-400'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    adrop.addEventListener(ev, (e) => { e.preventDefault(); adrop.classList.remove('ring-2', 'ring-cyan-400'); }),
  );
  adrop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f && (f.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(f.name))) loadAudio(f);
    else toast('Please drop an audio file', 'triangle-exclamation');
  });

  function loadAudio(file) {
    if (!file) return;
    audioFile = file;
    if (audioEl) { audioEl.pause(); audioEl = null; }
    audioEl = new Audio(URL.createObjectURL(file));
    audioEl.addEventListener('ended', () => {
      $('aud-play').innerHTML = '<i class="fas fa-play mr-2"></i>Play';
    });
    $('aud-placeholder').classList.add('hidden');
    $('aud-analyze').disabled = false;
    $('aud-reset').disabled = false;
    $('aud-play').disabled = false;
    $('aud-filename').textContent = file.name;
    lastAudio = null;
    renderMeter('audio-meter', null);
    renderSignals('audio-signals', null);
    drawSpectrum(null);
    drawWave(null);
  }

  function resetAudio() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
    audioFile = null; lastAudio = null;
    $('aud-placeholder').classList.remove('hidden');
    $('aud-analyze').disabled = true;
    $('aud-reset').disabled = true;
    $('aud-play').disabled = true;
    $('aud-filename').textContent = '';
    $('aud-progress-wrap').classList.add('hidden');
    $('aud-play').innerHTML = '<i class="fas fa-play mr-2"></i>Play';
    renderMeter('audio-meter', null);
    renderSignals('audio-signals', null);
    drawSpectrum(null);
    drawWave(null);
  }

  function toggleAudio() {
    if (!audioEl) return;
    if (audioEl.paused) {
      audioEl.play();
      $('aud-play').innerHTML = '<i class="fas fa-pause mr-2"></i>Pause';
    } else {
      audioEl.pause();
      $('aud-play').innerHTML = '<i class="fas fa-play mr-2"></i>Play';
    }
  }

  async function runAudioAnalysis() {
    if (!audioFile) return;
    const btn = $('aud-analyze');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner spin mr-2"></i>Analyzing…';
    $('aud-progress-wrap').classList.remove('hidden');
    $('aud-progress').style.width = '5%';
    $('aud-progress-text').textContent = 'Decoding audio…';

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const arr = await audioFile.arrayBuffer();
      const buf = await ac.decodeAudioData(arr);
      ac.close();

      $('aud-progress-text').textContent = 'Extracting forensic signals…';
      await new Promise((r) => setTimeout(r, 30)); // let UI paint

      const extracted = DGForensics.analyzeAudioBuffer(buf, (p) => {
        $('aud-progress').style.width = (10 + p * 80).toFixed(0) + '%';
      });
      if (!extracted) throw new Error('Audio too short to analyse');

      $('aud-progress').style.width = '95%';
      const result = await analyze(
        'audio',
        extracted.signals,
        {
          session_id: SESSION,
          source_name: audioFile.name,
          duration_ms: extracted.meta.duration_ms,
          frames_analyzed: extracted.meta.frames_analyzed,
        },
        true,
      );

      lastAudio = extracted;
      renderMeter('audio-meter', result);
      renderSignals('audio-signals', result.signals);
      drawSpectrum(extracted.spectrum);
      drawWave(extracted.waveform);
      $('aud-progress').style.width = '100%';
      $('aud-progress-text').textContent =
        `${(extracted.meta.duration_ms / 1000).toFixed(1)}s · ${extracted.meta.sample_rate} Hz · ` +
        `${extracted.meta.voiced_frames} voiced frames · mean F0 ${extracted.meta.mean_f0} Hz`;
      refreshHistory();
      toast('Audio analysis complete', 'circle-check');
    } catch (e) {
      toast('Audio analysis failed: ' + e.message, 'triangle-exclamation');
      $('aud-progress-text').textContent = '';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magnifying-glass-chart mr-2"></i>Analyze Audio';
    }
  }

  function drawWave(wave) {
    const cv = $('aud-wave');
    const host = $('audio-drop').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = host.width * dpr; cv.height = host.height * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, host.width, host.height);
    if (!wave) return;

    const w = host.width, h = host.height, mid = h / 2;
    const bw = w / wave.length;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#22d3ee');
    g.addColorStop(0.5, '#0891b2');
    g.addColorStop(1, '#22d3ee');
    ctx.fillStyle = g;
    wave.forEach((v, i) => {
      const bh = Math.max(1, v * h * 0.8);
      ctx.fillRect(i * bw, mid - bh / 2, Math.max(0.6, bw * 0.7), bh);
    });
  }

  function drawSpectrum(spec) {
    const cv = $('aud-spectrum');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = 110;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dark = document.documentElement.classList.contains('dark');
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
    for (let i = 0; i <= 4; i++) {
      const y = (h * i) / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    if (!spec || !spec.length) {
      ctx.fillStyle = dark ? 'rgba(148,163,184,.5)' : 'rgba(100,116,139,.6)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('No spectrum data', 8, h / 2);
      return;
    }

    const maxV = Math.max(...spec) || 1;
    const logv = spec.map((v) => Math.log10(1 + (v / maxV) * 9)); // 0..1 log-ish
    const bw = w / logv.length;

    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(34,211,238,.15)');
    g.addColorStop(1, 'rgba(34,211,238,.75)');

    ctx.beginPath();
    ctx.moveTo(0, h);
    logv.forEach((v, i) => ctx.lineTo(i * bw, h - v * h * 0.92));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = g; ctx.fill();

    ctx.beginPath();
    logv.forEach((v, i) => (i ? ctx.lineTo(i * bw, h - v * h * 0.92) : ctx.moveTo(0, h - v * h * 0.92)));
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5; ctx.stroke();

    // Axis hint
    ctx.fillStyle = dark ? 'rgba(148,163,184,.7)' : 'rgba(100,116,139,.8)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('0', 2, h - 2);
    ctx.fillText('Nyquist', w - 42, h - 2);
  }

  /* ================================================================
   * HISTORY
   * ================================================================ */
  let historyFilter = '';

  $('history-btn').addEventListener('click', openHistory);
  $('history-close').addEventListener('click', closeHistory);
  $('history-backdrop').addEventListener('click', closeHistory);
  $('history-clear').addEventListener('click', async () => {
    if (!confirm('Clear all detection history?')) return;
    await fetch('/api/history', { method: 'DELETE' });
    refreshHistory();
    toast('History cleared', 'trash');
  });

  document.querySelectorAll('.hist-filter').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.hist-filter').forEach((x) => x.classList.remove('filter-active'));
      b.classList.add('filter-active');
      historyFilter = b.dataset.filter;
      refreshHistory();
    });
  });

  function openHistory() {
    $('history-backdrop').classList.remove('hidden');
    $('history-panel').classList.remove('translate-x-full');
    refreshHistory();
  }
  function closeHistory() {
    $('history-backdrop').classList.add('hidden');
    $('history-panel').classList.add('translate-x-full');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHistory();
  });

  async function refreshHistory() {
    try {
      const [listRes, statRes] = await Promise.all([
        fetch('/api/history?limit=100' + (historyFilter ? '&mode=' + historyFilter : '')),
        fetch('/api/history/stats'),
      ]);
      const { items } = await listRes.json();
      const stats = await statRes.json();

      $('history-count').textContent = stats.total;
      $('history-count').classList.toggle('hidden', !stats.total);

      $('history-stats').innerHTML = [
        ['Total', stats.total, 'text-slate-600 dark:text-slate-300'],
        ['Authentic', stats.authentic, 'text-emerald-600 dark:text-emerald-400'],
        ['Suspicious', stats.suspicious, 'text-amber-600 dark:text-amber-400'],
        ['Flagged', stats.manipulated, 'text-red-600 dark:text-red-400'],
      ]
        .map(
          ([k, v, cls]) => `<div class="bg-white dark:bg-ink-900 px-2 py-3 text-center">
              <div class="text-lg font-extrabold tabular-nums ${cls}">${v}</div>
              <div class="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">${k}</div>
            </div>`,
        )
        .join('');

      renderHistoryList(items);
    } catch (e) {
      $('history-list').innerHTML =
        `<p class="text-sm text-slate-400 text-center py-8">Could not load history.</p>`;
    }
  }

  function renderHistoryList(items) {
    const host = $('history-list');
    if (!items.length) {
      host.innerHTML = `<div class="text-center py-12">
          <i class="fas fa-inbox text-3xl text-slate-300 dark:text-slate-700 mb-3 block"></i>
          <p class="text-sm text-slate-400 dark:text-slate-500">No scans recorded yet</p>
        </div>`;
      return;
    }

    const MODE = {
      live:  { icon: 'video', label: 'Live' },
      video: { icon: 'film', label: 'Video' },
      audio: { icon: 'wave-square', label: 'Audio' },
    };

    host.innerHTML = items
      .map((it) => {
        const v = VERDICT[it.label] || VERDICT.authentic;
        const m = MODE[it.mode] || MODE.video;
        const when = new Date((it.created_at || '').replace(' ', 'T') + 'Z');
        const whenStr = isNaN(when) ? it.created_at : when.toLocaleString();
        const topSignals = (it.signals || [])
          .slice(0, 3)
          .map((s) => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-400">
              ${escapeHtml(s.name)} ${(s.value * 100).toFixed(0)}%</span>`)
          .join('');

        return `
        <div class="rounded-xl border border-slate-200 dark:border-white/10 p-3.5 hover:border-cyan-400/50 transition">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-lg grid place-items-center shrink-0" style="background:${v.color}1a">
              <i class="fas fa-${m.icon}" style="color:${v.color}"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold truncate">${escapeHtml(it.source_name || 'Untitled')}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 shrink-0">${m.label}</span>
              </div>
              <div class="flex items-center gap-2 mt-1">
                <span class="text-xs font-bold" style="color:${v.color}">${v.label}</span>
                <span class="text-xs font-mono tabular-nums text-slate-400">${it.threat_score.toFixed(1)}/100</span>
              </div>
              <div class="flex flex-wrap gap-1 mt-2">${topSignals}</div>
              <div class="flex items-center justify-between mt-2">
                <span class="text-[10.5px] text-slate-400 dark:text-slate-500">
                  ${whenStr}${it.frames_analyzed ? ' · ' + it.frames_analyzed + ' frames' : ''}
                </span>
                <button data-del="${it.id}" class="text-slate-300 hover:text-red-500 transition px-1" title="Delete">
                  <i class="fas fa-trash-can text-[11px]"></i>
                </button>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join('');

    host.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await fetch('/api/history/' + b.dataset.del, { method: 'DELETE' });
        refreshHistory();
      }),
    );
  }

  /* ================================================================
   * Boot
   * ================================================================ */
  renderMeter('live-meter', null);
  renderMeter('video-meter', null);
  renderMeter('audio-meter', null);
  renderSignals('live-signals', null);
  renderSignals('video-signals', null);
  renderSignals('audio-signals', null);
  updateTelemetry();
  drawTimeline();
  refreshHistory();

  window.addEventListener('beforeunload', () => { if (streaming) stopStream(); });
})();
