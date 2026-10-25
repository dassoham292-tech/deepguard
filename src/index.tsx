import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  fuse,
  VIDEO_SIGNALS,
  AUDIO_SIGNALS,
  describeSignals,
  type SignalVector,
} from './lib/forensics';
import { page } from './page';

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors());

/* ------------------------------------------------------------------ *
 * Schema bootstrap (idempotent — keeps preview envs self-healing)
 * ------------------------------------------------------------------ */
let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        label TEXT NOT NULL,
        threat_score REAL NOT NULL,
        confidence REAL NOT NULL,
        source_name TEXT,
        duration_ms INTEGER DEFAULT 0,
        frames_analyzed INTEGER DEFAULT 0,
        signals_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    )
    .run();
  await db
    .prepare('CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at DESC)')
    .run();
  schemaReady = true;
}

/* ------------------------------------------------------------------ *
 * Analysis endpoints
 * ------------------------------------------------------------------ */

/**
 * POST /api/analyze
 * Body: { mode, signals: {...}, meta?: {...}, persist?: boolean }
 * Fuses a forensic signal vector into a calibrated threat score.
 */
app.post('/api/analyze', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const mode = String(body?.mode ?? '');
  if (!['live', 'video', 'audio'].includes(mode)) {
    return c.json({ error: 'mode must be one of: live, video, audio' }, 400);
  }

  const signals: SignalVector = body?.signals ?? {};
  if (typeof signals !== 'object' || Array.isArray(signals)) {
    return c.json({ error: 'signals must be an object of numeric measurements' }, 400);
  }

  const specs = mode === 'audio' ? AUDIO_SIGNALS : VIDEO_SIGNALS;
  const result = fuse(signals, specs);

  // Optional persistence (live mode streams too fast to log every frame;
  // the client only persists session summaries).
  if (body?.persist) {
    try {
      await ensureSchema(c.env.DB);
      await c.env.DB.prepare(
        `INSERT INTO scans
          (session_id, mode, label, threat_score, confidence,
           source_name, duration_ms, frames_analyzed, signals_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          String(body?.meta?.session_id ?? crypto.randomUUID()),
          mode,
          result.label,
          result.threat_score,
          result.confidence,
          String(body?.meta?.source_name ?? 'Unknown'),
          Number(body?.meta?.duration_ms ?? 0) | 0,
          Number(body?.meta?.frames_analyzed ?? 0) | 0,
          JSON.stringify(result.signals),
        )
        .run();
    } catch (e: any) {
      // Never fail the analysis because logging failed.
      return c.json({ ...result, persisted: false, persist_error: String(e?.message ?? e) });
    }
    return c.json({ ...result, persisted: true });
  }

  return c.json({ ...result, persisted: false });
});

/** Signal catalogue — powers the "how it works" panels. */
app.get('/api/signals/:kind', (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'video' && kind !== 'audio') {
    return c.json({ error: 'kind must be video or audio' }, 400);
  }
  return c.json({ kind, signals: describeSignals(kind) });
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

app.get('/api/history', async (c) => {
  try {
    await ensureSchema(c.env.DB);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const mode = c.req.query('mode');

    const stmt =
      mode && ['live', 'video', 'audio'].includes(mode)
        ? c.env.DB.prepare(
            'SELECT * FROM scans WHERE mode = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          ).bind(mode, limit)
        : c.env.DB.prepare(
            'SELECT * FROM scans ORDER BY created_at DESC, id DESC LIMIT ?',
          ).bind(limit);

    const { results } = await stmt.all();
    return c.json({
      items: (results ?? []).map((r: any) => ({
        ...r,
        signals: safeParse(r.signals_json),
      })),
    });
  } catch (e: any) {
    return c.json({ items: [], error: String(e?.message ?? e) }, 200);
  }
});

app.get('/api/history/stats', async (c) => {
  try {
    await ensureSchema(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN label='manipulated' THEN 1 ELSE 0 END) AS manipulated,
         SUM(CASE WHEN label='suspicious'  THEN 1 ELSE 0 END) AS suspicious,
         SUM(CASE WHEN label='authentic'   THEN 1 ELSE 0 END) AS authentic,
         AVG(threat_score) AS avg_score
       FROM scans`,
    ).all();
    const r: any = results?.[0] ?? {};
    return c.json({
      total: Number(r.total ?? 0),
      manipulated: Number(r.manipulated ?? 0),
      suspicious: Number(r.suspicious ?? 0),
      authentic: Number(r.authentic ?? 0),
      avg_score: r.avg_score == null ? 0 : Math.round(Number(r.avg_score) * 10) / 10,
    });
  } catch {
    return c.json({ total: 0, manipulated: 0, suspicious: 0, authentic: 0, avg_score: 0 });
  }
});

app.delete('/api/history/:id', async (c) => {
  try {
    await ensureSchema(c.env.DB);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400);
    await c.env.DB.prepare('DELETE FROM scans WHERE id = ?').bind(id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

app.delete('/api/history', async (c) => {
  try {
    await ensureSchema(c.env.DB);
    await c.env.DB.prepare('DELETE FROM scans').run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'DeepGuard', version: '1.0.0' }));

function safeParse(s: unknown) {
  if (typeof s !== 'string') return [];
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * App shell
 * ------------------------------------------------------------------ */
app.get('/', (c) => c.html(page));

export default app;
