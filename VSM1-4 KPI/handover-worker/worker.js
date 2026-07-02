// ============================================================
// VSM4 ต่อกะ (Shift Handover) — Cloudflare Worker + D1
// ที่เก็บข้อความส่งต่อกะแบบ "ข้ามเครื่อง" (ทุกอุปกรณ์เห็นตรงกัน)
// แยกจาก Worker หลักของ VSM4 (vsm4-api) โดยสิ้นเชิง
//
// Endpoints (CORS เปิดหมด):
//   GET  /list[?since=ISO]  → คืน entries ทั้งหมด (รวม tombstone deleted=1)
//   POST /put               → upsert 1 entry (LWW ตาม updated_at)
//   POST /bulk              → upsert หลาย entry (flush คิว offline)
//
// entry = {id,type('machine'|'induction'),cat('broken'|'note'),text,byId,byName,ts,editedAt,deleted,updatedAt}
//   • cat = หมวด: broken=เครื่องเสีย/ค้าง · note=ข้อมูลทั่วไป (แบ่ง 3 คอลัมน์ฝั่ง UI)
//   • id สร้างฝั่ง client → upsert idempotent (retry ปลอดภัย)
//   • ลบ = soft delete (deleted=1) กัน entry ฟื้นจาก race
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const SCHEMA = `CREATE TABLE IF NOT EXISTS handover (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, cat TEXT NOT NULL DEFAULT 'note', text TEXT NOT NULL,
  by_id TEXT, by_name TEXT, ts TEXT NOT NULL, edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`;

let _ready = false;
async function ensure(env) {
  if (_ready) return;
  await env.DB.prepare(SCHEMA).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_handover_updated ON handover(updated_at)').run(); } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE handover ADD COLUMN cat TEXT NOT NULL DEFAULT 'note'").run(); } catch (e) {}  // ตารางเดิม → เพิ่มคอลัมน์ (มีแล้ว throw → ข้าม)
  _ready = true;
}

const rowToEntry = (r) => ({
  id: r.id, type: r.type, cat: r.cat === 'broken' ? 'broken' : 'note', text: r.text,
  byId: r.by_id || '', byName: r.by_name || '',
  ts: r.ts, editedAt: r.edited_at || null,
  deleted: r.deleted ? 1 : 0, updatedAt: r.updated_at,
});
function normEntry(b) {
  b = b || {};
  const now = new Date().toISOString();
  return {
    id: String(b.id || '').slice(0, 64),
    type: b.type === 'induction' ? 'induction' : 'machine',
    cat: b.cat === 'broken' ? 'broken' : 'note',
    text: String(b.text == null ? '' : b.text).slice(0, 4000),
    byId: String(b.byId || '').slice(0, 80),
    byName: String(b.byName || '').slice(0, 120),
    ts: String(b.ts || now),
    editedAt: b.editedAt ? String(b.editedAt) : null,
    deleted: b.deleted ? 1 : 0,
    updatedAt: String(b.updatedAt || now),
  };
}
// upsert ที่เขียนทับเฉพาะเมื่อ payload ใหม่กว่า (LWW) — retry/บันทึกซ้ำไม่ทำให้ค่าเก่าทับใหม่
const UPSERT = `INSERT INTO handover (id,type,cat,text,by_id,by_name,ts,edited_at,deleted,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    type=excluded.type, cat=excluded.cat, text=excluded.text, by_id=excluded.by_id, by_name=excluded.by_name,
    ts=excluded.ts, edited_at=excluded.edited_at, deleted=excluded.deleted, updated_at=excluded.updated_at
  WHERE excluded.updated_at >= handover.updated_at`;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (!env.DB) return J({ ok: false, error: 'D1 binding missing' }, 500);
      await ensure(env);

      if (req.method === 'GET' && (p === '/' || p === '/list')) {
        const since = url.searchParams.get('since');
        let q = 'SELECT id,type,cat,text,by_id,by_name,ts,edited_at,deleted,updated_at FROM handover';
        const binds = [];
        if (since) { q += ' WHERE updated_at > ?'; binds.push(since); }
        q += ' ORDER BY ts DESC LIMIT 1000';
        const { results } = await env.DB.prepare(q).bind(...binds).all();
        return J({ ok: true, entries: (results || []).map(rowToEntry), now: new Date().toISOString() });
      }

      if (req.method === 'POST' && p === '/put') {
        const e = normEntry(await req.json().catch(() => ({})));
        if (!e.id) return J({ ok: false, error: 'id required' }, 400);
        await env.DB.prepare(UPSERT).bind(e.id, e.type, e.cat, e.text, e.byId, e.byName, e.ts, e.editedAt, e.deleted, e.updatedAt).run();
        return J({ ok: true });
      }

      if (req.method === 'POST' && p === '/bulk') {
        const body = await req.json().catch(() => ({}));
        const arr = Array.isArray(body.entries) ? body.entries : [];
        const stmt = env.DB.prepare(UPSERT);
        const batch = arr.filter((x) => x && x.id).map((x) => {
          const e = normEntry(x);
          return stmt.bind(e.id, e.type, e.cat, e.text, e.byId, e.byName, e.ts, e.editedAt, e.deleted, e.updatedAt);
        });
        if (batch.length) await env.DB.batch(batch);
        return J({ ok: true, n: batch.length });
      }

      return J({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return J({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
};
