-- DeepGuard detection history
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,                -- 'live' | 'video' | 'audio'
  label TEXT NOT NULL,               -- 'authentic' | 'suspicious' | 'manipulated'
  threat_score REAL NOT NULL,        -- 0..100 fused score
  confidence REAL NOT NULL,          -- 0..1 model confidence
  source_name TEXT,                  -- filename or 'Webcam Stream'
  duration_ms INTEGER DEFAULT 0,
  frames_analyzed INTEGER DEFAULT 0,
  signals_json TEXT,                 -- per-signal breakdown
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_mode ON scans(mode);
CREATE INDEX IF NOT EXISTS idx_scans_session ON scans(session_id);
