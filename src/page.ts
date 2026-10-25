export const page = /* html */ `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepGuard — Real-Time Streaming Media Forensics</title>
<meta name="description" content="Real-time deepfake and voice-clone detection for live streams, video and audio.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%2322d3ee' d='M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm-1.2 15.2L7 12.4l1.4-1.4 2.4 2.4 5-5L17.2 10l-6.4 6.2Z'/%3E%3C/svg%3E">
<script>
  // Apply theme before paint to avoid flash.
  (function () {
    try {
      var t = localStorage.getItem('dg-theme');
      if (t === 'light') document.documentElement.classList.remove('dark');
      else document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
</script>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          ink: { 950: '#070a12', 900: '#0b101c', 850: '#111827', 800: '#161f33' },
          accent: { DEFAULT: '#22d3ee', glow: '#06b6d4' },
        },
        fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
      },
    },
  };
</script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="/static/style.css" rel="stylesheet">
</head>
<body class="bg-slate-100 dark:bg-ink-950 text-slate-800 dark:text-slate-200 min-h-screen antialiased transition-colors">

<!-- ================= HEADER ================= -->
<header id="app-header" class="sticky top-0 z-40 backdrop-blur-xl bg-white/80 dark:bg-ink-900/80 border-b border-slate-200 dark:border-white/10">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
    <div class="flex items-center gap-3 min-w-0">
      <div class="relative shrink-0">
        <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 grid place-items-center shadow-lg shadow-cyan-500/25">
          <i class="fas fa-shield-halved text-white text-sm"></i>
        </div>
        <span id="live-pulse" class="hidden absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 ring-2 ring-white dark:ring-ink-900 animate-pulse"></span>
      </div>
      <div class="min-w-0">
        <h1 class="font-bold tracking-tight leading-none truncate">DeepGuard</h1>
        <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-none mt-1 truncate">Streaming Media Forensics</p>
      </div>
    </div>

    <nav class="ml-auto flex items-center gap-1.5">
      <button id="history-btn" class="btn-ghost" title="Detection history">
        <i class="fas fa-clock-rotate-left"></i>
        <span class="hidden sm:inline ml-2">History</span>
        <span id="history-count" class="ml-2 hidden text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"></span>
      </button>
      <button id="theme-btn" class="btn-ghost" title="Toggle dark / light mode">
        <i class="fas fa-moon dark:hidden"></i>
        <i class="fas fa-sun hidden dark:inline"></i>
      </button>
    </nav>
  </div>
</header>

<main class="max-w-7xl mx-auto px-4 sm:px-6 py-6">

  <!-- ================= TABS ================= -->
  <nav id="tab-bar" role="tablist" aria-label="Detection modes"
       class="grid grid-cols-3 gap-2 p-1.5 rounded-2xl bg-white dark:bg-ink-900 border border-slate-200 dark:border-white/10 shadow-sm mb-6">
    <button role="tab" data-tab="live" class="tab-btn tab-active">
      <i class="fas fa-video"></i>
      <span>Live Webcam</span>
    </button>
    <button role="tab" data-tab="video" class="tab-btn">
      <i class="fas fa-film"></i>
      <span>Video Detection</span>
    </button>
    <button role="tab" data-tab="audio" class="tab-btn">
      <i class="fas fa-wave-square"></i>
      <span>Audio Detection</span>
    </button>
  </nav>

  <!-- ================= LIVE WEBCAM ================= -->
  <section id="panel-live" role="tabpanel" class="tab-panel">
    <div class="grid lg:grid-cols-[1.6fr_1fr] gap-5">

      <article class="card p-0 overflow-hidden">
        <div class="relative bg-black aspect-video" id="video-stage">
          <video id="webcam" class="w-full h-full object-cover" playsinline muted></video>
          <canvas id="overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>

          <div id="cam-placeholder" class="absolute inset-0 grid place-items-center text-center px-6">
            <div>
              <i class="fas fa-video-slash text-4xl text-slate-600 mb-3"></i>
              <p class="text-slate-400 text-sm">Camera is off</p>
              <p class="text-slate-600 text-xs mt-1">Start the stream to begin real-time forensic analysis</p>
            </div>
          </div>

          <div id="live-badge" class="hidden absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1 rounded-full bg-red-600/90 backdrop-blur text-white text-[11px] font-bold tracking-wide">
            <span class="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span> LIVE
          </div>

          <div id="fps-badge" class="hidden absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur text-cyan-300 text-[11px] font-mono"></div>
        </div>

        <div class="p-4 flex flex-wrap items-center gap-2 border-t border-slate-200 dark:border-white/10">
          <button id="cam-start" class="btn-primary">
            <i class="fas fa-play mr-2"></i>Start Stream
          </button>
          <button id="cam-stop" class="btn-ghost" disabled>
            <i class="fas fa-stop mr-2"></i>Stop
          </button>
          <button id="cam-save" class="btn-ghost" disabled>
            <i class="fas fa-floppy-disk mr-2"></i>Save to History
          </button>
          <label class="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">
            <input id="boxes-toggle" type="checkbox" checked class="accent-cyan-500 w-4 h-4">
            Bounding boxes
          </label>
        </div>
      </article>

      <aside class="space-y-5">
        <div class="card p-5">
          <h3 class="section-label">Live Threat Meter</h3>
          <div id="live-meter"></div>
        </div>
        <div class="card p-5">
          <h3 class="section-label">Pipeline Telemetry</h3>
          <dl id="live-telemetry" class="text-sm space-y-2.5"></dl>
        </div>
      </aside>
    </div>

    <div class="card p-5 mt-5">
      <h3 class="section-label">Forensic Signal Breakdown</h3>
      <div id="live-signals" class="grid sm:grid-cols-2 gap-x-6 gap-y-3 mt-3"></div>
    </div>
  </section>

  <!-- ================= VIDEO ================= -->
  <section id="panel-video" role="tabpanel" class="tab-panel hidden">
    <div class="grid lg:grid-cols-[1.6fr_1fr] gap-5">
      <article class="card p-0 overflow-hidden">
        <div id="video-drop" class="relative bg-black aspect-video grid place-items-center">
          <video id="vid-player" class="w-full h-full object-contain hidden" playsinline controls></video>
          <canvas id="vid-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
          <div id="vid-placeholder" class="text-center px-6">
            <i class="fas fa-cloud-arrow-up text-4xl text-slate-600 mb-3"></i>
            <p class="text-slate-300 text-sm font-medium">Drop a video file here</p>
            <p class="text-slate-600 text-xs mt-1">MP4, WebM, MOV — analysed locally, never uploaded</p>
            <button id="vid-pick" class="btn-primary mt-4"><i class="fas fa-folder-open mr-2"></i>Choose Video</button>
          </div>
          <input id="vid-input" type="file" accept="video/*" class="hidden">
        </div>
        <div class="p-4 flex flex-wrap items-center gap-2 border-t border-slate-200 dark:border-white/10">
          <button id="vid-analyze" class="btn-primary" disabled><i class="fas fa-magnifying-glass-chart mr-2"></i>Analyze Video</button>
          <button id="vid-reset" class="btn-ghost" disabled><i class="fas fa-rotate-left mr-2"></i>Reset</button>
          <span id="vid-filename" class="ml-auto text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-[50%]"></span>
        </div>
        <div id="vid-progress-wrap" class="hidden px-4 pb-4">
          <div class="progress-track"><div id="vid-progress" class="progress-bar"></div></div>
          <p id="vid-progress-text" class="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 font-mono"></p>
        </div>
      </article>

      <aside class="space-y-5">
        <div class="card p-5">
          <h3 class="section-label">Verdict</h3>
          <div id="video-meter"></div>
        </div>
        <div class="card p-5">
          <h3 class="section-label">Frame Timeline</h3>
          <canvas id="vid-timeline" height="90" class="w-full mt-2"></canvas>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-2">Per-frame threat score across the sampled timeline.</p>
        </div>
      </aside>
    </div>

    <div class="card p-5 mt-5">
      <h3 class="section-label">Forensic Signal Breakdown</h3>
      <div id="video-signals" class="grid sm:grid-cols-2 gap-x-6 gap-y-3 mt-3"></div>
    </div>
  </section>

  <!-- ================= AUDIO ================= -->
  <section id="panel-audio" role="tabpanel" class="tab-panel hidden">
    <div class="grid lg:grid-cols-[1.6fr_1fr] gap-5">
      <article class="card p-0 overflow-hidden">
        <div id="audio-drop" class="relative bg-slate-900 dark:bg-black h-64 grid place-items-center">
          <canvas id="aud-wave" class="absolute inset-0 w-full h-full"></canvas>
          <div id="aud-placeholder" class="text-center px-6 relative">
            <i class="fas fa-microphone-lines text-4xl text-slate-600 mb-3"></i>
            <p class="text-slate-300 text-sm font-medium">Drop an audio file here</p>
            <p class="text-slate-600 text-xs mt-1">WAV, MP3, M4A, OGG — analysed locally, never uploaded</p>
            <button id="aud-pick" class="btn-primary mt-4"><i class="fas fa-folder-open mr-2"></i>Choose Audio</button>
          </div>
          <input id="aud-input" type="file" accept="audio/*" class="hidden">
        </div>
        <div class="p-4 flex flex-wrap items-center gap-2 border-t border-slate-200 dark:border-white/10">
          <button id="aud-analyze" class="btn-primary" disabled><i class="fas fa-magnifying-glass-chart mr-2"></i>Analyze Audio</button>
          <button id="aud-play" class="btn-ghost" disabled><i class="fas fa-play mr-2"></i>Play</button>
          <button id="aud-reset" class="btn-ghost" disabled><i class="fas fa-rotate-left mr-2"></i>Reset</button>
          <span id="aud-filename" class="ml-auto text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-[50%]"></span>
        </div>
        <div id="aud-progress-wrap" class="hidden px-4 pb-4">
          <div class="progress-track"><div id="aud-progress" class="progress-bar"></div></div>
          <p id="aud-progress-text" class="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 font-mono"></p>
        </div>
      </article>

      <aside class="space-y-5">
        <div class="card p-5">
          <h3 class="section-label">Verdict</h3>
          <div id="audio-meter"></div>
        </div>
        <div class="card p-5">
          <h3 class="section-label">Spectral Profile</h3>
          <canvas id="aud-spectrum" height="110" class="w-full mt-2"></canvas>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-2">Average magnitude spectrum. A sharp cliff in the upper band suggests vocoder synthesis.</p>
        </div>
      </aside>
    </div>

    <div class="card p-5 mt-5">
      <h3 class="section-label">Forensic Signal Breakdown</h3>
      <div id="audio-signals" class="grid sm:grid-cols-2 gap-x-6 gap-y-3 mt-3"></div>
    </div>
  </section>

  <footer class="mt-10 text-center text-xs text-slate-500 dark:text-slate-500 space-y-1">
    <p><i class="fas fa-lock mr-1"></i> Media is processed entirely in your browser. Only numeric forensic signals reach the server.</p>
    <p class="text-slate-400 dark:text-slate-600">DeepGuard is a research/educational forensics tool — results are probabilistic, not legal proof.</p>
  </footer>
</main>

<!-- ================= HISTORY DRAWER ================= -->
<div id="history-backdrop" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 hidden"></div>
<aside id="history-panel"
       class="fixed top-0 right-0 h-full w-full sm:w-[460px] bg-white dark:bg-ink-900 border-l border-slate-200 dark:border-white/10 z-[60] translate-x-full transition-transform duration-300 flex flex-col">
  <div class="h-16 px-5 flex items-center justify-between border-b border-slate-200 dark:border-white/10 shrink-0">
    <h2 class="font-bold flex items-center gap-2"><i class="fas fa-clock-rotate-left text-cyan-500"></i> Detection History</h2>
    <div class="flex items-center gap-1">
      <button id="history-clear" class="btn-ghost text-xs" title="Clear all"><i class="fas fa-trash"></i></button>
      <button id="history-close" class="btn-ghost" title="Close"><i class="fas fa-xmark"></i></button>
    </div>
  </div>
  <div id="history-stats" class="grid grid-cols-4 gap-px bg-slate-200 dark:bg-white/10 shrink-0"></div>
  <div class="px-5 py-3 flex gap-1.5 border-b border-slate-200 dark:border-white/10 shrink-0">
    <button class="hist-filter filter-active" data-filter="">All</button>
    <button class="hist-filter" data-filter="live">Live</button>
    <button class="hist-filter" data-filter="video">Video</button>
    <button class="hist-filter" data-filter="audio">Audio</button>
  </div>
  <div id="history-list" class="flex-1 overflow-y-auto p-4 space-y-3"></div>
</aside>

<div id="toast-stack" class="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] space-y-2 pointer-events-none"></div>

<script src="/static/forensics-client.js"></script>
<script src="/static/app.js"></script>
</body>
</html>`;
