// ============================================================
// VSM4 ต่อกะ (Shift Handover) — Cloudflare Worker + D1
// ที่เก็บข้อความส่งต่อกะแบบ "ข้ามเครื่อง" (ทุกอุปกรณ์เห็นตรงกัน)
// แยกจาก Worker หลักของ VSM4 (vsm4-api) โดยสิ้นเชิง
//
// Endpoints (CORS เปิดหมด):
//   GET  /list[?since=ISO]  → คืน entries ต่อกะทั้งหมด (รวม tombstone deleted=1)
//   POST /put               → upsert 1 entry ต่อกะ (LWW ตาม updated_at)
//   POST /bulk              → upsert หลาย entry ต่อกะ (flush คิว offline)
//   GET  /wipin/list[?since=ISO] → WIP IN 1.5 (งานรับเข้าจาก VSM2) ทั้งหมด
//   POST /wipin/put         → upsert 1 entry WIP IN 1.5 (LWW)
//   POST /wipin/bulk        → upsert หลาย entry WIP IN 1.5 (flush คิว offline)
//
// wipin entry = {id,vsm,valve,lot,qty,byId,byName,ts,deleted,updatedAt}
//
// entry = {id,type('machine'|'induction'),cat('broken'|'note'),text,byId,byName,ts,editedAt,
//          task,done,doneBy,doneByName,doneAt,deleted,updatedAt}
//   • cat = หมวด: broken=เครื่องเสีย/ค้าง · note=ข้อมูลทั่วไป (แบ่ง 3 คอลัมน์ฝั่ง UI)
//   • task = "ข้อ checklist" (v3.7): สร้างจาก builder ทีละข้อเท่านั้น — โน้ตเก่า task=0 ไม่มี checkbox
//   • done = สถานะติ๊กของข้อ checklist: กะถัดไปติ๊กเมื่อทำแล้ว (0/1 + ใคร/เมื่อไหร่)
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
  task INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0, done_by TEXT, done_by_name TEXT, done_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`;

// WIP IN 1.5 — งานที่รับเข้าจาก VSM2 มารอผลิตที่ Process แรก (แยกตารางจาก handover)
const SCHEMA_WIPIN = `CREATE TABLE IF NOT EXISTS wipin (
  id TEXT PRIMARY KEY, vsm TEXT, valve TEXT NOT NULL, lot TEXT, qty INTEGER NOT NULL DEFAULT 0,
  by_id TEXT, by_name TEXT, ts TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`;

let _ready = false;
async function ensure(env) {
  if (_ready) return;
  await env.DB.prepare(SCHEMA).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_handover_updated ON handover(updated_at)').run(); } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE handover ADD COLUMN cat TEXT NOT NULL DEFAULT 'note'").run(); } catch (e) {}  // ตารางเดิม → เพิ่มคอลัมน์ (มีแล้ว throw → ข้าม)
  // checklist "ข้อมูลทั่วไป" (v3.7) — ตารางเดิม → เพิ่มคอลัมน์ task/done (มีแล้ว throw → ข้าม)
  try { await env.DB.prepare("ALTER TABLE handover ADD COLUMN task INTEGER NOT NULL DEFAULT 0").run(); } catch (e) {}
  try { await env.DB.prepare("ALTER TABLE handover ADD COLUMN done INTEGER NOT NULL DEFAULT 0").run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE handover ADD COLUMN done_by TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE handover ADD COLUMN done_by_name TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE handover ADD COLUMN done_at TEXT').run(); } catch (e) {}
  // v3.14 (2026-07-16): แยกบอร์ดต่อกะตาม VSM เด็ดขาด (บั๊ก: VSM1 ลงต่อกะไปโผล่ VSM4)
  //   เดิม Worker ไม่เก็บ vsm → ทุกเครื่องเดาจากรหัสพนักงาน (byId) → คนที่ไม่อยู่ในแผนที่ตกไป vsm4
  try { await env.DB.prepare('ALTER TABLE handover ADD COLUMN vsm TEXT').run(); } catch (e) {}
  // seq = ลำดับข้อ checklist ที่ผู้ใช้สลับเอง — เดิมไม่เก็บ ลำดับรีเซ็ตข้ามเครื่อง
  try { await env.DB.prepare('ALTER TABLE handover ADD COLUMN seq INTEGER').run(); } catch (e) {}
  await env.DB.prepare(SCHEMA_WIPIN).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wipin_updated ON wipin(updated_at)').run(); } catch (e) {}
  // note = เหตุผลที่บันทึกรับเข้าเกินแผน/ซ้ำ (P1-18)
  try { await env.DB.prepare('ALTER TABLE wipin ADD COLUMN note TEXT').run(); } catch (e) {}
  _ready = true;
}

const rowToEntry = (r) => ({
  id: r.id, type: r.type, cat: r.cat === 'broken' ? 'broken' : 'note', text: r.text,
  byId: r.by_id || '', byName: r.by_name || '',
  vsm: r.vsm || '',
  seq: (r.seq === null || r.seq === undefined) ? undefined : Number(r.seq),
  ts: r.ts, editedAt: r.edited_at || null,
  task: r.task ? 1 : 0,
  done: r.done ? 1 : 0, doneBy: r.done_by || '', doneByName: r.done_by_name || '', doneAt: r.done_at || null,
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
    vsm: String(b.vsm || '').slice(0, 16),
    seq: (b.seq === null || b.seq === undefined || isNaN(Number(b.seq))) ? null : Number(b.seq),
    ts: String(b.ts || now),
    editedAt: b.editedAt ? String(b.editedAt) : null,
    task: b.task ? 1 : 0,
    done: b.done ? 1 : 0,
    doneBy: String(b.doneBy || '').slice(0, 80),
    doneByName: String(b.doneByName || '').slice(0, 120),
    doneAt: b.doneAt ? String(b.doneAt) : null,
    deleted: b.deleted ? 1 : 0,
    updatedAt: String(b.updatedAt || now),
  };
}
// upsert ที่เขียนทับเฉพาะเมื่อ payload ใหม่กว่า (LWW) — retry/บันทึกซ้ำไม่ทำให้ค่าเก่าทับใหม่
const UPSERT = `INSERT INTO handover (id,type,cat,text,by_id,by_name,vsm,seq,ts,edited_at,task,done,done_by,done_by_name,done_at,deleted,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    type=excluded.type, cat=excluded.cat, text=excluded.text, by_id=excluded.by_id, by_name=excluded.by_name,
    vsm=CASE WHEN excluded.vsm<>'' THEN excluded.vsm ELSE handover.vsm END,
    seq=COALESCE(excluded.seq, handover.seq),
    ts=excluded.ts, edited_at=excluded.edited_at,
    task=excluded.task, done=excluded.done, done_by=excluded.done_by, done_by_name=excluded.done_by_name, done_at=excluded.done_at,
    deleted=excluded.deleted, updated_at=excluded.updated_at
  WHERE excluded.updated_at >= handover.updated_at`;
const hoBind = (stmt, e) => stmt.bind(e.id, e.type, e.cat, e.text, e.byId, e.byName, e.vsm, e.seq, e.ts, e.editedAt,
  e.task, e.done, e.doneBy, e.doneByName, e.doneAt, e.deleted, e.updatedAt);

// ── WIP IN 1.5 helpers (pattern เดียวกับ handover: LWW upsert + soft delete) ──
const wipinRowToEntry = (r) => ({
  id: r.id, vsm: r.vsm || '', valve: r.valve || '', lot: r.lot || '', qty: Number(r.qty) || 0,
  byId: r.by_id || '', byName: r.by_name || '', note: r.note || '',
  ts: r.ts, deleted: r.deleted ? 1 : 0, updatedAt: r.updated_at,
});
function normWipin(b) {
  b = b || {};
  const now = new Date().toISOString();
  return {
    id: String(b.id || '').slice(0, 64),
    vsm: String(b.vsm || '').slice(0, 16),
    valve: String(b.valve == null ? '' : b.valve).slice(0, 120),
    lot: String(b.lot == null ? '' : b.lot).slice(0, 120),
    qty: Math.max(0, Math.round(Number(b.qty) || 0)),
    byId: String(b.byId || '').slice(0, 80),
    byName: String(b.byName || '').slice(0, 120),
    note: String(b.note == null ? '' : b.note).slice(0, 500),
    ts: String(b.ts || now),
    deleted: b.deleted ? 1 : 0,
    updatedAt: String(b.updatedAt || now),
  };
}
const UPSERT_WIPIN = `INSERT INTO wipin (id,vsm,valve,lot,qty,by_id,by_name,note,ts,deleted,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    vsm=excluded.vsm, valve=excluded.valve, lot=excluded.lot, qty=excluded.qty,
    by_id=excluded.by_id, by_name=excluded.by_name, note=excluded.note, ts=excluded.ts,
    deleted=excluded.deleted, updated_at=excluded.updated_at
  WHERE excluded.updated_at >= wipin.updated_at`;
const wipinBind = (stmt, e) => stmt.bind(e.id, e.vsm, e.valve, e.lot, e.qty, e.byId, e.byName, e.note, e.ts, e.deleted, e.updatedAt);

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
        let q = 'SELECT id,type,cat,text,by_id,by_name,vsm,seq,ts,edited_at,task,done,done_by,done_by_name,done_at,deleted,updated_at FROM handover';
        const binds = [];
        if (since) { q += ' WHERE updated_at > ?'; binds.push(since); }
        q += ' ORDER BY ts DESC LIMIT 1000';
        const { results } = await env.DB.prepare(q).bind(...binds).all();
        return J({ ok: true, entries: (results || []).map(rowToEntry), now: new Date().toISOString() });
      }

      if (req.method === 'POST' && p === '/put') {
        const e = normEntry(await req.json().catch(() => ({})));
        if (!e.id) return J({ ok: false, error: 'id required' }, 400);
        await hoBind(env.DB.prepare(UPSERT), e).run();
        return J({ ok: true });
      }

      if (req.method === 'POST' && p === '/bulk') {
        const body = await req.json().catch(() => ({}));
        const arr = Array.isArray(body.entries) ? body.entries : [];
        const stmt = env.DB.prepare(UPSERT);
        const batch = arr.filter((x) => x && x.id).map((x) => hoBind(stmt, normEntry(x)));
        if (batch.length) await env.DB.batch(batch);
        return J({ ok: true, n: batch.length });
      }

      // ── WIP IN 1.5 endpoints ──
      if (req.method === 'GET' && p === '/wipin/list') {
        const since = url.searchParams.get('since');
        let q = 'SELECT id,vsm,valve,lot,qty,by_id,by_name,note,ts,deleted,updated_at FROM wipin';
        const binds = [];
        if (since) { q += ' WHERE updated_at > ?'; binds.push(since); }
        q += ' ORDER BY ts DESC LIMIT 5000';
        const { results } = await env.DB.prepare(q).bind(...binds).all();
        return J({ ok: true, entries: (results || []).map(wipinRowToEntry), now: new Date().toISOString() });
      }

      if (req.method === 'POST' && p === '/wipin/put') {
        const e = normWipin(await req.json().catch(() => ({})));
        if (!e.id) return J({ ok: false, error: 'id required' }, 400);
        await wipinBind(env.DB.prepare(UPSERT_WIPIN), e).run();
        return J({ ok: true });
      }

      if (req.method === 'POST' && p === '/wipin/bulk') {
        const body = await req.json().catch(() => ({}));
        const arr = Array.isArray(body.entries) ? body.entries : [];
        const stmt = env.DB.prepare(UPSERT_WIPIN);
        const batch = arr.filter((x) => x && x.id).map((x) => wipinBind(stmt, normWipin(x)));
        if (batch.length) await env.DB.batch(batch);
        return J({ ok: true, n: batch.length });
      }

      return J({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return J({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
};
