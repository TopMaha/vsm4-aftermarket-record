/**
 * VSM4 Unified Backend — Cloudflare Worker + D1
 * รวม KPI VSM4 + AFTERMARKET Production Tracker
 *
 * Endpoints (ทั้งหมดเป็น JSON):
 *   GET  /api/ping            → health-check
 *   GET  /api/init            → master data ทั้งหมด (valves, machines, employees, targets)
 *
 *   GET  /api/valves                 → รายการ valves ทั้งหมด
 *   POST /api/valves                 → upsert valve  body: {valve_no, customer, description, processes:[]}
 *   POST /api/valves/bulk            → bulk upsert  body: {valves:[...]}
 *   POST /api/valves/delete          → ลบ           body: {valve_no}
 *
 *   GET  /api/records?valve=&lot=&from=&to=&proc=&status=
 *                                    → production records (filter ได้)
 *   POST /api/records                → เพิ่ม         body: {valve_no, lot, quantity, ...}
 *   POST /api/records/bulk           → เพิ่มหลายๆ    body: {records:[...]}
 *   POST /api/records/update         → แก้ไข         body: {record_id, ...}
 *   POST /api/records/delete         → ลบ            body: {record_id}
 *
 *   GET  /api/machines               → เครื่องจักร group by zone
 *   POST /api/machines               → upsert
 *   POST /api/machines/delete
 *
 *   GET  /api/employees              → พนักงาน
 *   POST /api/employees              → upsert
 *   POST /api/employees/delete
 *
 *   GET  /api/kpi?from=&to=&zone=&machine=&emp=&valve=&shift=
 *   POST /api/kpi                    → บันทึก KPI หลายรายการ body:{records:[...]}
 *   POST /api/kpi/update
 *   POST /api/kpi/delete             → body:{ids:[...]}
 *
 *   GET  /api/targets                → KPI targets
 *   POST /api/targets                → set targets    body:{oae,dle,pplh,pdac,scrap}
 *
 *   GET  /api/stats?from=&to=        → aggregate dashboard counts
 *
 * Deploy:
 *   1) Cloudflare Dashboard → Workers & Pages → Create → Worker → Paste this file
 *   2) Settings → Variables → D1 Database Bindings → Add:
 *        Variable name: DB     Database: kpi-vsm4-db
 *   3) Deploy → Copy URL (xxx.workers.dev) → paste in app Settings
 */

import indexHtml from './index.html';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age':       '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const err = (message, status = 400) =>
  json({ ok: false, error: String(message) }, status);

const ok = (data = {}) => json({ ok: true, ...data });

const newId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error('Invalid JSON body');
  }
}

// เสิร์ฟผลลัพธ์ผ่าน edge cache (caches.default) TTL วินาที — ลดภาระ D1 เมื่อหลายเครื่อง poll พร้อมกัน
// key ยึดจาก origin + tag (ไม่พึ่ง query) · cache พลาด/ใช้ไม่ได้ → fallback สร้างผลสดเสมอ (ไม่พัง endpoint)
async function servedCached(ctx, url, tag, ttlSec, build) {
  try {
    const cache = caches.default;
    const key = new Request(`${url.origin}/__cache/${tag}`);
    const hit = await cache.match(key);
    if (hit) return hit;
    const resp = await build();
    const out = new Response(resp.body, resp);
    out.headers.set('Cache-Control', `public, max-age=${ttlSec}`);
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, out.clone()));
    else await cache.put(key, out.clone());
    return out;
  } catch (e) {
    return await build();
  }
}

// ============================================================
// MAIN ROUTER
// ============================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const m    = request.method;

    try {
      await ensureSchema(env);   // migration คอลัมน์ใหม่ (ครั้งเดียวต่อ isolate — ALTER มีอยู่แล้ว = ข้าม)

      // เสิร์ฟ index.html ที่ root (สำหรับมือถือ + camera access ที่ต้อง HTTPS)
      if (path === '' || path === '/' || path === '/index.html' || path === '/app') {
        return new Response(indexHtml, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            'X-Frame-Options': 'SAMEORIGIN',
          }
        });
      }

      // health
      if (path === '/api/ping' || path === '/api')
        return ok({ message: 'VSM4 Unified API', time: new Date().toISOString() });

      // init: bundle all master data
      if (path === '/api/init')           return ok(await getInit(env));

      // valves
      if (path === '/api/valves'        && m === 'GET')  return ok({ valves: await getValves(env) });
      if (path === '/api/valves'        && m === 'POST') return ok(await upsertValve(env, await readJson(request)));
      if (path === '/api/valves/bulk'   && m === 'POST') return ok(await bulkUpsertValves(env, await readJson(request)));
      if (path === '/api/valves/delete' && m === 'POST') return ok(await deleteValve(env, await readJson(request)));

      // production records
      if (path === '/api/records'         && m === 'GET')  return ok({ records: await getRecords(env, url.searchParams) });
      if (path === '/api/records'         && m === 'POST') return ok(await addRecord(env, await readJson(request)));
      if (path === '/api/records/bulk'    && m === 'POST') return ok(await bulkAddRecords(env, await readJson(request)));
      if (path === '/api/records/update'  && m === 'POST') return ok(await updateRecord(env, await readJson(request)));
      if (path === '/api/records/delete'  && m === 'POST') return ok(await deleteRecord(env, await readJson(request)));

      // machines
      if (path === '/api/machines'        && m === 'GET')  return ok(await getMachinesGrouped(env));
      if (path === '/api/machines'        && m === 'POST') return ok(await upsertMachine(env, await readJson(request)));
      if (path === '/api/machines/delete' && m === 'POST') return ok(await deleteMachine(env, await readJson(request)));
      if (path === '/api/machines/rename' && m === 'POST') return ok(await renameMachine(env, await readJson(request)));

      // employees
      if (path === '/api/employees'        && m === 'GET')  return ok({ employees: await getEmployees(env) });
      if (path === '/api/employees'        && m === 'POST') return ok(await upsertEmployee(env, await readJson(request)));
      if (path === '/api/employees/delete' && m === 'POST') return ok(await deleteEmployee(env, await readJson(request)));

      // kpi
      if (path === '/api/kpi'          && m === 'GET')  return ok({ records: await getKpiRecords(env, url.searchParams) });
      // produced set = full-table DISTINCT scan · หลายเครื่อง poll ทุก 60 วิ → cache ที่ edge 60 วิ กันสแกน D1 ซ้ำ
      if (path === '/api/kpi/produced' && m === 'GET')  return await servedCached(ctx, url, 'produced-v1', 60,
                                                                async () => ok({ pairs: await getProducedJobs(env) }));
      // ★ 2026-08-04 — ตรวจ/ซ่อมความสอดคล้อง kpi_records ↔ production_records
      if (path === '/api/reconcile'  && m === 'GET')  return ok(await reconcileReport(env, url.searchParams));
      if (path === '/api/reconcile'  && m === 'POST') return ok(await reconcileApply(env, await readJson(request)));
      if (path === '/api/kpi'        && m === 'POST') return ok(await addKpiRecords(env, await readJson(request)));
      if (path === '/api/kpi/update' && m === 'POST') return ok(await updateKpiRecord(env, await readJson(request)));
      if (path === '/api/kpi/delete' && m === 'POST') return ok(await deleteKpiRecords(env, await readJson(request)));

      // targets
      if (path === '/api/targets' && m === 'GET')  return ok({ targets: await getTargets(env) });
      if (path === '/api/targets' && m === 'POST') return ok(await setTargets(env, await readJson(request)));

      // stats
      if (path === '/api/stats') return ok(await getStats(env, url.searchParams));

      // production plans
      if (path === '/api/plans'        && m === 'GET')  return ok({ plans: await getPlans(env, url.searchParams) });
      if (path === '/api/plans'        && m === 'POST') return ok(await upsertPlan(env, await readJson(request)));
      if (path === '/api/plans/bulk'   && m === 'POST') return ok(await bulkUpsertPlans(env, await readJson(request)));
      if (path === '/api/plans/update' && m === 'POST') return ok(await upsertPlan(env, await readJson(request)));
      if (path === '/api/plans/delete' && m === 'POST') return ok(await deletePlan(env, await readJson(request)));

      // valve IDs (1 valve มีหลาย ID)
      if (path === '/api/ids'          && m === 'GET')  return ok({ ids: await getIds(env, url.searchParams) });
      if (path === '/api/ids'          && m === 'POST') return ok(await upsertId(env, await readJson(request)));
      if (path === '/api/ids/bulk'     && m === 'POST') return ok(await bulkUpsertIds(env, await readJson(request)));
      if (path === '/api/ids/delete'   && m === 'POST') return ok(await deleteId(env, await readJson(request)));
      if (path === '/api/ids/lookup'   && m === 'GET')  return ok(await lookupId(env, url.searchParams));

      return err('Unknown endpoint: ' + path, 404);
    } catch (e) {
      return err(e?.message || e, 500);
    }
  },
};

// ============================================================
// SCHEMA MIGRATION (2026-07-16)
//   production_records: + machine_id / zone / vsm — เดิม client ส่งมาแต่ Worker ทิ้ง
//   → WIP IN 1.5 / WIP OUT ไม่มีเครื่องจักรโชว์หลัง sync ข้ามเครื่อง (บั๊ก P0-7)
//   ALTER ซ้ำจะ throw "duplicate column" → try/catch ข้ามได้ปลอดภัย
// ============================================================
let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  for (const sql of [
    'ALTER TABLE production_records ADD COLUMN machine_id TEXT',
    'ALTER TABLE production_records ADD COLUMN zone TEXT',
    'ALTER TABLE production_records ADD COLUMN vsm TEXT',
    // ★ 2026-08-02: พนักงานเก็บสาย VSM ไว้ในฐานข้อมูล — เดิมไม่มีคอลัมน์นี้
    //   → คนที่ admin เพิ่มใหม่ผูก VSM ได้เฉพาะเครื่องที่เพิ่ม (localStorage) เครื่องอื่นเห็นเป็น VSM4
    'ALTER TABLE employees ADD COLUMN vsm TEXT',
    /* ★ 2026-08-04 — ผูก production_records ↔ kpi_records ให้เป็นข้อมูลชุดเดียวกัน
       บั๊กที่แก้ (ตรวจพบจากข้อมูลจริง 9,813 แถว ช่วง 1 ก.ค.–4 ส.ค. 2026):
         ① timestamp ของ prod = "เวลาที่กดบันทึก" ส่วน KPI = "วันผลิตจริง" (shift_date)
            → เข้ากะดึกแล้วบันทึกตอนเช้า = คนละวันทันที · 48.8% ของคู่ที่จับคู่ได้ วันไม่ตรงกัน
            → หน้าติดตามงานโชว์ 30 ก.ค. แต่หน้าประวัติอยู่ 29 ก.ค. (เคส G-2077/VV6031A1)
         ② ลบ KPI จากหน้าประวัติ → prod record ค้างเป็นผี (พบ 170 แถว)
         ③ แก้ valve/lot/ยอด ที่ฝั่งใดฝั่งหนึ่ง อีกฝั่งไม่ตาม (valve 0.7% · ยอด 2.3%)
       ทางแก้: เก็บ shift_date/shift_type ลง prod ตรง ๆ + kpi_record_id เป็นคีย์เชื่อมจริง
       (เดิมผูกกันด้วยข้อความใน note "auto-linked KPI <zone>/<mc>" ซึ่งผู้ใช้แก้ทับได้) */
    'ALTER TABLE production_records ADD COLUMN shift_date TEXT',
    'ALTER TABLE production_records ADD COLUMN shift_type TEXT',
    'ALTER TABLE production_records ADD COLUMN kpi_record_id TEXT',
    'CREATE INDEX IF NOT EXISTS idx_prod_kpi_rid ON production_records(kpi_record_id)',
    'CREATE INDEX IF NOT EXISTS idx_prod_shift_date ON production_records(shift_date)',
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* มีคอลัมน์แล้ว → ข้าม */ }
  }
  _schemaReady = true;
}

/* "วันผลิตจริง" ของ production record — ใช้ตัวเดียวกันทั้ง query และรายงาน
   มี shift_date (แถวใหม่/ซ่อมแล้ว) → ใช้เลย · ไม่มี (แถวเก่า) → แปลง timestamp UTC เป็นวันที่ไทย
   ❗ต้อง +7 ชม. ก่อนตัด: 2026-07-29T23:58Z = 30 ก.ค. 06:58 ตามเวลาไทย ถ้าตัดดิบ ๆ จะได้ 29 ผิดวัน */
const PROD_DATE_SQL = "COALESCE(NULLIF(shift_date,''), substr(datetime(timestamp,'+7 hours'),1,10))";

// ============================================================
// INIT
// ============================================================
async function getInit(env) {
  const [valves, machines, employees, targets, ids] = await Promise.all([
    getValves(env),
    getMachinesGrouped(env),
    getEmployees(env),
    getTargets(env),
    getIds(env, new URLSearchParams()),
  ]);
  return {
    version: 'unified-v2',
    server_time: new Date().toISOString(),
    valves, machines: machines.machines, employees, targets, ids,
  };
}

// ============================================================
// VALVES
// ============================================================
async function getValves(env) {
  const { results } = await env.DB.prepare(
    'SELECT valve_no, customer, description, processes, barcode_id FROM valves ORDER BY valve_no'
  ).all();
  return (results || []).map(r => ({
    valveNo:     r.valve_no,
    customer:    r.customer || 'Other',
    description: r.description || '',
    processes:   (r.processes || '').split(',').map(s => s.trim()).filter(Boolean),
    barcode_id:  r.barcode_id || '',
  }));
}

async function upsertValve(env, body) {
  const valveNo  = String(body.valveNo || body.valve_no || '').trim();
  if (!valveNo) throw new Error('valveNo is required');
  const customer = String(body.customer || 'Other');
  const desc     = String(body.description || '');
  const procs    = Array.isArray(body.processes) ? body.processes.join(',') : String(body.processes || '');
  const bc       = String(body.barcode_id || body.barcodeId || '');
  const now      = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO valves (valve_no, customer, description, processes, barcode_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(valve_no) DO UPDATE SET
      customer    = excluded.customer,
      description = excluded.description,
      processes   = excluded.processes,
      barcode_id  = excluded.barcode_id,
      updated_at  = excluded.updated_at
  `).bind(valveNo, customer, desc, procs, bc, now).run();

  return { valve: { valveNo, customer, description: desc, processes: procs.split(',').filter(Boolean), barcode_id: bc } };
}

async function bulkUpsertValves(env, body) {
  const list = body.valves || [];
  const now  = new Date().toISOString();
  const stmt = env.DB.prepare(`
    INSERT INTO valves (valve_no, customer, description, processes, barcode_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(valve_no) DO UPDATE SET
      customer=excluded.customer, description=excluded.description,
      processes=excluded.processes, barcode_id=excluded.barcode_id,
      updated_at=excluded.updated_at
  `);
  const batch = list.map(v => stmt.bind(
    String(v.valveNo || v.valve_no || '').trim(),
    String(v.customer || 'Other'),
    String(v.description || ''),
    Array.isArray(v.processes) ? v.processes.join(',') : String(v.processes || ''),
    String(v.barcode_id || v.barcodeId || ''),
    now
  )).filter(s => s);
  if (batch.length) await env.DB.batch(batch);
  return { count: batch.length };
}

async function deleteValve(env, body) {
  const valveNo = String(body.valveNo || body.valve_no || '').trim();
  if (!valveNo) throw new Error('valveNo is required');
  const r = await env.DB.prepare('DELETE FROM valves WHERE valve_no = ?').bind(valveNo).run();
  return { deleted: r.meta?.changes || 0 };
}

// ============================================================
// PRODUCTION RECORDS
// ============================================================
async function getRecords(env, params) {
  const conds = [];
  const args  = [];
  if (params.get('valve'))  { conds.push('valve_no = ?');        args.push(params.get('valve')); }
  if (params.get('lot'))    { conds.push('lot = ?');             args.push(params.get('lot')); }
  // ★ 2026-08-04: กรองด้วย "วันผลิตจริง" ไม่ใช่เวลาที่กดบันทึก — ให้ตรงกับ /api/kpi ที่ใช้ shift_date
  //   เดิมกรอง timestamp ดิบ → งานกะดึกที่บันทึกตอนเช้าตกไปอยู่คนละวันกับ KPI ของตัวเอง
  if (params.get('from'))   { conds.push(`${PROD_DATE_SQL} >= ?`); args.push(String(params.get('from')).slice(0, 10)); }
  if (params.get('to'))     { conds.push(`${PROD_DATE_SQL} <= ?`); args.push(String(params.get('to')).slice(0, 10)); }
  if (params.get('proc'))   { conds.push('current_process = ?'); args.push(params.get('proc')); }
  if (params.get('status')) { conds.push('status = ?');          args.push(params.get('status')); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  // เช่นเดียวกับ /api/kpi: ถ้ามีช่วง from+to → คืนครบทั้งช่วง (เดิม cap 1000/5000 ตัดงานเก่าทิ้ง)
  const RECS_MAX = 50000;
  const hasRange = params.get('from') && params.get('to');
  const dflt = hasRange ? RECS_MAX : 1000;
  const limit = Math.min(parseInt(params.get('limit') || String(dflt), 10), RECS_MAX);
  const sql = `SELECT * FROM production_records ${where} ORDER BY timestamp DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return await _resolveShiftDates(env, results || []);
}

/* ★ 2026-08-04 (รอบ 2) — เติม "วันทำงาน" ให้แถวที่ยังไม่ได้ซ่อม โดยดูจาก KPI ตอนอ่าน

   ปัญหา: แถวเก่ายังไม่มี shift_date (ยังไม่ได้กด 🔧 ซ่อม) → เดิม fallback ไปใช้ timestamp
   แปลงเป็นวันไทย ซึ่ง "เดา" และเดาผิดเมื่อเป็นกะดึก — หน้าติดตามงานจึงยังโชว์ 30 ก.ค.
   ทั้งที่หน้าประวัติเป็น 29 ก.ค. (เคส VV6031A1 · 580 ชิ้น)

   แก้: อ่าน shift_date ตัวจริงจาก kpi_records ที่ saved_at ตรงกับ timestamp ของแถวนั้น
   (ตอนบันทึก client เขียนทั้งสองตารางด้วยตัวแปร now ตัวเดียวกัน → ตรงกันเป๊ะระดับ ms)
   ⇒ หน้าจอถูกต้องทันทีโดยไม่ต้องรอกดซ่อม · ปุ่มซ่อมเหลือหน้าที่ "เขียนลง D1 ให้ถาวร"
   แถวที่หา KPI ไม่เจอจริง ๆ (แถวผี) จะยังไม่มี kpi_record_id → ติดป้าย ⚠️ ตามเดิม ถูกต้องแล้ว */
async function _resolveShiftDates(env, rows) {
  const need = rows.filter(r => !String(r.shift_date || '').trim() && r.timestamp);
  if (!need.length) return rows.map(rowToRecord);
  const stamps = [...new Set(need.map(r => r.timestamp))];
  const found = new Map();   // saved_at → [{machine_id, opr, shift_date, shift_type}]
  for (let i = 0; i < stamps.length; i += 100) {        // ซอย IN(...) กันเกินเพดานตัวแปรของ D1
    const chunk = stamps.slice(i, i + 100);
    const { results } = await env.DB.prepare(
      `SELECT record_id, saved_at, machine_id, opr, shift_date, record_date, shift_type
         FROM kpi_records WHERE saved_at IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const k of results || []) {
      if (!found.has(k.saved_at)) found.set(k.saved_at, []);
      found.get(k.saved_at).push(k);
    }
  }
  /* จับคู่ทีละ "ชุดบันทึก" และ consume KPI ที่ถูกจองแล้ว
     ❗ห้าม fallback แบบหยิบตัวแรกในชุดมาผูก id — เคยทำให้ prod G-2077/580 (แถวผี)
       ไปเกาะ KPI ของ G-2076/575 คนละแถวกัน = ป้ายแถวผีหาย + cascade จะไปลบผิดตัว
     แยกให้ชัด 2 ระดับ:
       exact (เครื่อง+ยอดตรง) → เชื่อถือได้ → ใส่ทั้งวันที่และ kpi_record_id
       ทั้งชุดวันเดียวกัน      → เชื่อได้แค่ "วันที่" → ใส่วันที่อย่างเดียว ไม่ผูก id (ยังเป็นแถวผี) */
  const byTs = new Map();
  for (const r of need) {
    if (!byTs.has(r.timestamp)) byTs.set(r.timestamp, []);
    byTs.get(r.timestamp).push(r);
  }
  const claim = new Map();   // prod record_id → { k, exact }
  for (const [ts, ps] of byTs) {
    const all = found.get(ts) || [];
    if (!all.length) continue;
    const pool = all.slice();
    for (const p of ps) {    // รอบ 1 — จับคู่แน่นอน แล้วตัดออกจาก pool กันสองแถวแย่ง KPI ตัวเดียวกัน
      const i = pool.findIndex(k => String(k.machine_id || '') === String(p.machine_id || '')
                                 && Math.round(+k.opr || 0) === Math.round(+p.quantity || 0));
      if (i >= 0) claim.set(p.record_id, { k: pool.splice(i, 1)[0], exact: true });
    }
    const days = new Set(all.map(k => k.shift_date || k.record_date || '').filter(Boolean));
    if (days.size !== 1) continue;   // ชุดคร่อม 2 วัน → เดาไม่ได้ ปล่อยให้ปุ่มซ่อมจัดการ
    for (const p of ps) {            // รอบ 2 — ที่เหลือ เอาแค่วันที่ (ทั้งชุดวันเดียวกันอยู่แล้ว)
      if (!claim.has(p.record_id)) claim.set(p.record_id, { k: all[0], exact: false });
    }
  }
  return rows.map(r => {
    const rec = rowToRecord(r);
    if (String(r.shift_date || '').trim()) return rec;
    const c = claim.get(r.record_id);
    if (!c) return rec;                                 // ไม่มี KPI คู่ = แถวผี → ติดป้าย 👻
    const sd = c.k.shift_date || c.k.record_date || '';
    if (sd) { rec.shift_date = sd; rec.shift_type = c.k.shift_type || ''; }
    if (c.exact) {
      // ผูกให้ตอนอ่าน — ป้าย 👻 จะได้เหลือเฉพาะ "หา KPI คู่ไม่เจอจริง ๆ" ไม่ใช่ "ยังไม่ได้กดซ่อม"
      rec.kpi_record_id  = c.k.record_id || '';
      rec.kpi_link_stored = false;   // ยังไม่ถาวรใน D1 — cascade ต้องอาศัย prod_ids จาก client
    }
    return rec;
  });
}

function rowToRecord(r) {
  return {
    recordId:           r.record_id,
    record_id:          r.record_id,          // ให้ client ใช้ key เดียวกับตอนบันทึก (แก้ไข/ลบตรง id เดิมได้)
    timestamp:          r.timestamp,
    valveNo:            r.valve_no,
    lot:                r.lot || '',
    quantity:           Number(r.quantity || 0),
    currentProcess:     r.current_process || '',
    completedProcesses: (r.completed_processes || '').split(',').map(s => s.trim()).filter(Boolean),
    status:             r.status || '',
    operator:           r.operator || '',
    note:               r.note || '',
    machine_id:         r.machine_id || '',   // เครื่องจักรที่ผลิต (โชว์ใน WIP IN/OUT)
    zone:               r.zone || '',         // ให้ vsmOf แยก VSM ได้หลัง sync
    vsm:                r.vsm || '',
    // ★ 2026-08-04 — วันผลิตจริง + คีย์เชื่อมไป kpi_records
    //   shift_date ว่าง (แถวเก่ายังไม่ซ่อม) → คำนวณจาก timestamp เป็นเวลาไทยให้ client ใช้ได้ทันที
    shift_date:         r.shift_date || _thDate(r.timestamp),
    shift_type:         r.shift_type || '',
    kpi_record_id:      r.kpi_record_id || '',
    kpi_link_stored:    !!String(r.kpi_record_id || '').trim(),   // คีย์เชื่อมถูกเขียนลง D1 แล้วหรือยัง
  };
}

/* timestamp UTC → วันที่ตามเวลาไทย (YYYY-MM-DD) */
function _thDate(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
}

/* upsert 1 แถว production record — id เดิมของ client ถูก "คงไว้" (idempotent)
   ส่งซ้ำ (retry/offline flush) = ทับแถวเดิม ไม่เกิด record ซ้ำใน DB อีก */
const PROD_UPSERT_SQL = `
  INSERT INTO production_records (record_id, timestamp, valve_no, lot, quantity, current_process, completed_processes, status, operator, note, machine_id, zone, vsm, shift_date, shift_type, kpi_record_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(record_id) DO UPDATE SET
    timestamp=excluded.timestamp, valve_no=excluded.valve_no, lot=excluded.lot,
    quantity=excluded.quantity, current_process=excluded.current_process,
    completed_processes=excluded.completed_processes, status=excluded.status,
    operator=excluded.operator, note=excluded.note,
    machine_id=excluded.machine_id, zone=excluded.zone, vsm=excluded.vsm,
    shift_date=excluded.shift_date, shift_type=excluded.shift_type,
    -- ส่งมาว่าง = ไม่รู้จัก (client รุ่นเก่า) → คงคีย์เชื่อมเดิมไว้ ห้ามล้างทิ้ง
    kpi_record_id=COALESCE(NULLIF(excluded.kpi_record_id,''), production_records.kpi_record_id)`;
function prodBind(stmt, r, id) {
  const ts = r.timestamp || new Date().toISOString();
  return stmt.bind(
    id,
    ts,
    String(r.valveNo || r.valve_no || ''),
    String(r.lot || ''),
    Number(r.quantity || 0),
    String(r.currentProcess || r.current_process || ''),
    Array.isArray(r.completedProcesses) ? r.completedProcesses.join(',') : String(r.completedProcesses || r.completed_processes || ''),
    String(r.status || 'In Progress'),
    String(r.operator || ''),
    String(r.note || ''),
    String(r.machine_id || r.machineId || ''),
    String(r.zone || ''),
    String(r.vsm || ''),
    // client รุ่นเก่าไม่ส่ง shift_date มา → อนุมานจาก timestamp เป็นเวลาไทย ดีกว่าปล่อยว่าง
    String(r.shift_date || r.record_date || _thDate(ts)),
    String(r.shift_type || ''),
    String(r.kpi_record_id || '')
  );
}

async function addRecord(env, body) {
  // ❗เดิม: สร้าง id ใหม่เสมอ → id ฝั่ง client กับ DB ไม่ตรงกัน (ลบ/แก้ไขไม่เจอแถว + retry เกิดซ้ำ)
  // ใหม่: ใช้ id ที่ client ส่งมา (idempotency key) — ไม่มีค่อยสร้างให้
  const id = String(body.record_id || body.recordId || '').trim() || newId('R');
  await prodBind(env.DB.prepare(PROD_UPSERT_SQL), body, id).run();
  return { id };
}

async function bulkAddRecords(env, body) {
  const list = body.records || [];
  const stmt = env.DB.prepare(PROD_UPSERT_SQL);
  const ids = [];
  const batch = list.map(r => {
    const id = String(r.record_id || r.recordId || '').trim() || newId('R');
    ids.push(id);
    return prodBind(stmt, r, id);
  });
  if (batch.length) await env.DB.batch(batch);
  return { count: batch.length, ids };
}

async function updateRecord(env, body) {
  if (!body.recordId && !body.record_id) throw new Error('recordId required');
  const id   = body.recordId || body.record_id;
  const sets = [];
  const args = [];
  const map  = {
    lot: 'lot', quantity: 'quantity', currentProcess: 'current_process',
    status: 'status', operator: 'operator', note: 'note',
    valveNo: 'valve_no', machine_id: 'machine_id', zone: 'zone', vsm: 'vsm',
    shift_date: 'shift_date', shift_type: 'shift_type',
  };
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) { sets.push(`${col} = ?`); args.push(body[k]); }
  }
  // client รุ่นใหม่ส่ง snake_case ด้วย — รับทั้งสองแบบ (camel ชนะถ้าส่งมาคู่)
  if (body.valve_no !== undefined && body.valveNo === undefined) { sets.push('valve_no = ?'); args.push(body.valve_no); }
  if (body.current_process !== undefined && body.currentProcess === undefined) { sets.push('current_process = ?'); args.push(body.current_process); }
  if (body.completedProcesses !== undefined) {
    sets.push('completed_processes = ?');
    args.push(Array.isArray(body.completedProcesses) ? body.completedProcesses.join(',') : String(body.completedProcesses));
  }
  if (!sets.length) return { updated: 0 };
  args.push(id);
  const r = await env.DB.prepare(`UPDATE production_records SET ${sets.join(', ')} WHERE record_id = ?`).bind(...args).run();
  let updated = r.meta?.changes || 0;
  // ไม่พบแถว (id เก่าจากยุค Worker สร้าง id ใหม่เอง) + มีข้อมูลพอ → insert แทน เพื่อไม่ให้การแก้ไขหายเงียบ
  if (!updated && (body.valveNo || body.valve_no)) {
    await prodBind(env.DB.prepare(PROD_UPSERT_SQL), body, id).run();
    updated = 1;
  }
  // ★ 2026-08-04 — แก้ prod แล้วดัน valve/lot/ยอด/process กลับไปที่ KPI ที่ผูกกันอยู่ด้วย
  //   เดิมแก้ฝั่งเดียว → หน้าประวัติกับหน้าติดตามงานพูดคนละเรื่อง (valve ต่าง 0.7% · ยอดต่าง 2.3%)
  const kpiSynced = await syncKpiFromProd(env, id, body);
  return { updated, kpi_synced: kpiSynced };
}

/* prod → KPI: อัปเดตเฉพาะฟิลด์ที่เป็น "ข้อเท็จจริงเดียวกัน" ของทั้งสองตาราง
   ไม่แตะ OAE/DLE/target/CT — พวกนั้นเป็นของ KPI ล้วน คำนวณจากเวลาทำงาน ไม่ใช่จากใบผลิต
   ⚠️ ยอด (opr) ไม่ sync อัตโนมัติเมื่อ KPI 1 แถวแตกเป็นหลาย prod (หลาย process) — ยอดจะซ้ำ */
async function syncKpiFromProd(env, prodId, body) {
  const row = await env.DB.prepare('SELECT kpi_record_id FROM production_records WHERE record_id = ?')
    .bind(prodId).first();
  const kid = row?.kpi_record_id;
  if (!kid) return 0;
  const sets = [], args = [];
  const put = (col, v) => { if (v !== undefined && v !== null) { sets.push(`${col} = ?`); args.push(v); } };
  put('valve_no',     body.valveNo ?? body.valve_no);
  put('lot',          body.lot);
  put('last_process', body.currentProcess ?? body.current_process);
  put('operator',     body.operator);
  put('shift_date',   body.shift_date);
  put('record_date',  body.shift_date);
  // ยอด: sync ได้เฉพาะตอน KPI แถวนี้ผูกกับ prod แถวเดียว (ไม่ได้แตกหลาย process) ไม่งั้นยอดจะเพี้ยน
  if (body.quantity !== undefined) {
    const c = await env.DB.prepare('SELECT COUNT(*) n FROM production_records WHERE kpi_record_id = ?').bind(kid).first();
    if ((c?.n || 0) <= 1) put('opr', Number(body.quantity || 0));
  }
  if (!sets.length) return 0;
  args.push(kid);
  const r = await env.DB.prepare(`UPDATE kpi_records SET ${sets.join(', ')} WHERE record_id = ?`).bind(...args).run();
  return r.meta?.changes || 0;
}

async function deleteRecord(env, body) {
  if (!body.recordId && !body.record_id) throw new Error('recordId required');
  const id = body.recordId || body.record_id;
  // ★ 2026-08-04 — ลบ prod แล้วลบ KPI ที่ผูกกันด้วย "เฉพาะเมื่อเป็นคู่ 1:1"
  //   KPI 1 แถวที่แตกเป็นหลาย process ยังมี prod แถวอื่นอ้างอยู่ → ลบ KPI ทิ้งจะทำยอดหายทั้งก้อน
  /* ⚠️ ต้องสั่งมาชัดเจน (cascade:true) เท่านั้นจึงจะลบ KPI ตาม — ค่าเริ่มต้นคือ "ไม่ลบ"
     เพราะมีโค้ดหลายที่ในอดีตใช้ท่า "ลบก่อนแล้ว insert ใหม่" เพื่อ *แก้ไข* ข้อมูล
     ถ้า cascade ทำงานเองอัตโนมัติ ท่าเหล่านั้นจะทำ KPI (พร้อม OAE/DLE) หายเงียบ ๆ
     ตอนนี้แก้ client ให้เลิกใช้ท่านั้นหมดแล้ว แต่กันไว้อีกชั้นกันพลาดในอนาคต */
  let kpiDeleted = 0;
  const row = await env.DB.prepare('SELECT kpi_record_id FROM production_records WHERE record_id = ?').bind(id).first();
  const kid = body.cascade === true ? row?.kpi_record_id : null;
  const r = await env.DB.prepare('DELETE FROM production_records WHERE record_id = ?').bind(id).run();
  if (kid) {
    const left = await env.DB.prepare('SELECT COUNT(*) n FROM production_records WHERE kpi_record_id = ?').bind(kid).first();
    if ((left?.n || 0) === 0) {
      const k = await env.DB.prepare('DELETE FROM kpi_records WHERE record_id = ?').bind(kid).run();
      kpiDeleted = k.meta?.changes || 0;
    }
  }
  return { deleted: r.meta?.changes || 0, kpi_deleted: kpiDeleted };
}

// ============================================================
// MACHINES
// ============================================================
async function getMachines(env) {
  const { results } = await env.DB.prepare(
    'SELECT zone, machine_id, target, man_std FROM machines ORDER BY zone, machine_id'
  ).all();
  return results || [];
}

async function getMachinesGrouped(env) {
  const list = await getMachines(env);
  const out  = { ZONE1: [], ZONE2: [], ZONE3: [] };
  for (const r of list) {
    if (!out[r.zone]) out[r.zone] = [];
    out[r.zone].push({ id: r.machine_id, target: Number(r.target) || 0, man_std: Number(r.man_std) || 0 });
  }
  return { machines: out };
}

async function upsertMachine(env, body) {
  const zone   = String(body.zone || '').trim();
  const id     = String(body.id || body.machine_id || '').trim();
  if (!zone || !id) throw new Error('zone and id required');
  const target = Number(body.target) || 0;
  const std    = Number(body.man_std) || 0;
  await env.DB.prepare(`
    INSERT INTO machines (zone, machine_id, target, man_std, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(zone, machine_id) DO UPDATE SET
      target=excluded.target, man_std=excluded.man_std, updated_at=excluded.updated_at
  `).bind(zone, id, target, std).run();
  return { machine: { zone, id, target, man_std: std } };
}

async function deleteMachine(env, body) {
  const zone = String(body.zone || '').trim();
  const id   = String(body.id || body.machine_id || '').trim();
  const r = await env.DB.prepare('DELETE FROM machines WHERE zone = ? AND machine_id = ?').bind(zone, id).run();
  return { deleted: r.meta?.changes || 0 };
}

/* เปลี่ยน "รหัสเครื่อง" ถึงฐานข้อมูลจริง — machines + kpi_records + production_records
   body: { from, to, zone? }
   ⚠️ zone จำเป็นเมื่อรหัสเดิมซ้ำอยู่หลายโซน (เช่น G-2018 อยู่ทั้ง ZJ/ZK) — ไม่ส่ง = เปลี่ยนทุกโซน
   idempotent: รันซ้ำได้ (รอบสองจะไม่เจอแถวเดิม → changes = 0)                            */
/* หาโซนทั้งหมดที่ใช้รหัสเครื่องนี้อยู่ (ดูครบทั้ง 3 ตาราง) — ใช้เป็นด่านกันเปลี่ยนผิดตัว */
async function zonesUsingMachine(env, id) {
  const zones = new Set();
  for (const t of ['machines', 'kpi_records', 'production_records']) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT zone FROM ${t} WHERE machine_id = ? AND zone IS NOT NULL AND zone <> ''`
      ).bind(id).all();
      for (const r of (results || [])) zones.add(r.zone);
    } catch (e) { /* ตารางไม่มีคอลัมน์ zone → ข้าม */ }
  }
  return [...zones].sort();
}

async function renameMachine(env, body) {
  const from = String(body.from || '').trim();
  const to   = String(body.to   || '').trim();
  const zone = String(body.zone || '').trim();
  if (!from || !to) throw new Error('from/to required');
  if (from === to) return { from, to, zone, machines: 0, kpi: 0, prod: 0 };

  /* ★★ ด่านกัน "เปลี่ยนผิดตัว" — บังคับระบุ zone เสมอ ★★
     บทเรียนจริง (2026-08-02): เดิมด่านนี้ปฏิเสธเฉพาะตอนรหัส "ยังอยู่ >1 โซน"
     แต่พอเปลี่ยนชื่อฝั่ง ZK ไปแล้ว G-2018 เหลือโซนเดียว ด่านเลยปล่อยผ่าน
     → เรียกโดยไม่ใส่ zone กวาด G-2018@ZJ ไป 40 KPI + 17 prod (กู้คืนแล้ว)
     ระบบนี้เครื่องสังกัดโซนเสมอ (machines PK = zone+machine_id) จึงไม่มีเหตุผลที่จะ
     เปลี่ยนชื่อข้ามทุกโซน — บังคับ zone ไปเลย ตัดความเสี่ยงทั้งคลาสนี้ทิ้ง */
  if (!zone) {
    const zs = await zonesUsingMachine(env, from);
    throw new Error(
      `ต้องระบุ zone เสมอ — "${from}" พบในโซน: ${zs.length ? zs.join(', ') : '(ไม่พบ)'} · ` +
      `รหัสเครื่องซ้ำกันได้หลายไลน์ ถ้าไม่ระบุโซนจะเปลี่ยนชื่อของไลน์อื่นไปด้วย`);
  }
  const zonesUsed = await zonesUsingMachine(env, from);
  if (zonesUsed.length && !zonesUsed.includes(zone)) {
    throw new Error(`ไม่พบ "${from}" ในโซน ${zone} (พบที่: ${zonesUsed.join(', ')})`);
  }

  const zc   = ' AND zone = ?';
  const args = [to, from, zone];
  /* preview:true = ดูว่าจะกระทบกี่แถว โดยไม่แก้อะไรเลย — ให้ตรวจก่อนลงมือได้เสมอ */
  if (body.preview) {
    const cnt = async (t) => {
      try {
        const r = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM ${t} WHERE machine_id = ?${zc}`).bind(from, zone).first();
        return r?.n || 0;
      } catch (e) { return 0; }
    };
    return { preview: true, from, to, zone, zones_found: zonesUsed,
             machines: await cnt('machines'), kpi: await cnt('kpi_records'), prod: await cnt('production_records') };
  }
  const run = async (sql, a) => {
    try { const r = await env.DB.prepare(sql).bind(...a).run(); return r.meta?.changes || 0; }
    catch (e) { return 0; }   // ตารางไม่มีคอลัมน์ / ชนคีย์ซ้ำ → ข้าม ไม่ให้ทั้งคำขอพัง
  };
  // OR REPLACE = ถ้ามีแถวชื่อใหม่อยู่แล้ว (seed สร้างไว้) ให้ทับ ไม่ใช่ error คีย์ซ้ำ
  const machines = await run(`UPDATE OR REPLACE machines SET machine_id = ? WHERE machine_id = ?${zc}`, args);
  const kpi      = await run(`UPDATE kpi_records SET machine_id = ? WHERE machine_id = ?${zc}`, args);
  const prod     = await run(`UPDATE production_records SET machine_id = ? WHERE machine_id = ?${zc}`, args);
  return { from, to, zone, machines, kpi, prod, zones_found: zonesUsed };
}

// ============================================================
// EMPLOYEES
// ============================================================
async function getEmployees(env) {
  // คอลัมน์ vsm เพิ่มทีหลัง (ensureSchema) — DB เก่าที่ ALTER ยังไม่ผ่านจะ error → fallback แบบไม่มี vsm
  try {
    const { results } = await env.DB.prepare(
      'SELECT emp_id AS id, name, vsm FROM employees ORDER BY emp_id'
    ).all();
    return results || [];
  } catch (e) {
    const { results } = await env.DB.prepare(
      'SELECT emp_id AS id, name FROM employees ORDER BY emp_id'
    ).all();
    return results || [];
  }
}

const VSM_OK = new Set(['vsm1', 'vsm2', 'vsm3', 'vsm4']);

async function upsertEmployee(env, body) {
  const id   = String(body.id || body.emp_id || '').trim();
  if (!id) throw new Error('emp id required');
  const name = String(body.name || '').trim();
  const raw  = String(body.vsm || '').trim().toLowerCase();
  const vsm  = VSM_OK.has(raw) ? raw : null;      // คีย์เพี้ยน (เช่น 'vsm12') → เก็บ null ดีกว่าเก็บค่าที่ระบบอ่านไม่ออก
  try {
    await env.DB.prepare(`
      INSERT INTO employees (emp_id, name, vsm, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(emp_id) DO UPDATE SET
        name=excluded.name,
        vsm=COALESCE(excluded.vsm, employees.vsm),   -- ไม่ส่ง vsm มา = ไม่ล้างค่าเดิม
        updated_at=excluded.updated_at
    `).bind(id, name, vsm).run();
    return { employee: { id, name, vsm } };
  } catch (e) {
    await env.DB.prepare(`
      INSERT INTO employees (emp_id, name, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(emp_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `).bind(id, name).run();
    return { employee: { id, name } };
  }
}

async function deleteEmployee(env, body) {
  const id = String(body.id || body.emp_id || '').trim();
  const r = await env.DB.prepare('DELETE FROM employees WHERE emp_id = ?').bind(id).run();
  return { deleted: r.meta?.changes || 0 };
}

// ============================================================
// KPI RECORDS
// ============================================================
const KPI_COLS = [
  'record_id','saved_at','record_date','shift_date','shift_type',
  'zone','zone_label','machine_id','emp_id','emp_name','shift_ids','shifts',
  'opr','target','scrap','ct','wt','man_std','man_used',
  'oae','dle','pplh','pdac_val','pdac_pass','scrap_rate','opr_pdac',
  'operator','shift_detail','valve_no','lot','last_process'
];

async function getKpiRecords(env, params) {
  const conds = [];
  const args  = [];
  if (params.get('from'))    { conds.push('COALESCE(shift_date, record_date) >= ?'); args.push(params.get('from')); }
  if (params.get('to'))      { conds.push('COALESCE(shift_date, record_date) <= ?'); args.push(params.get('to')); }
  if (params.get('zone'))    { conds.push('zone = ?');                                args.push(params.get('zone')); }
  if (params.get('shift'))   { conds.push('shift_type = ?');                          args.push(params.get('shift')); }
  if (params.get('machine')) { conds.push('LOWER(machine_id) LIKE ?');                args.push('%' + params.get('machine').toLowerCase() + '%'); }
  if (params.get('emp'))     { conds.push('(LOWER(emp_id) LIKE ? OR LOWER(shift_ids) LIKE ?)'); const e = '%' + params.get('emp').toLowerCase() + '%'; args.push(e, e); }
  if (params.get('valve'))   { conds.push('LOWER(valve_no) LIKE ?');                  args.push('%' + params.get('valve').toLowerCase() + '%'); }
  if (params.get('lot'))     { conds.push('LOWER(lot) LIKE ?');                       args.push('%' + params.get('lot').toLowerCase() + '%'); }
  if (params.get('status') === 'pass') conds.push("pdac_pass = 'PASS'");
  if (params.get('status') === 'fail') conds.push("pdac_pass = 'FAIL'");

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  // ❗เดิม: default 500 / max 5000 + ORDER BY saved_at DESC → query ตามช่วงวันกว้างถูกตัดเหลือ
  //   "500 แถวล่าสุด" (≈1.5 วันสุดท้าย) เงียบ ๆ → ยอดรวมราย process / dashboard ต่ำกว่าจริง ~20-25 เท่า
  // ใหม่: ถ้ามีช่วง from+to → คืน "ครบทั้งช่วง" (default = เพดานสูง) · ไม่มีช่วง (ดึงล่าสุด) → คง 500 ตามเดิม
  const KPI_MAX = 50000;
  const hasRange = params.get('from') && params.get('to');
  const dflt = hasRange ? KPI_MAX : 500;
  const limit = Math.min(parseInt(params.get('limit') || String(dflt), 10), KPI_MAX);
  const sql = `SELECT * FROM kpi_records ${where} ORDER BY saved_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return results || [];
}

// เซ็ต (valve_no, lot) ที่ "เคยผลิตแล้ว" ทั้งหมด (distinct · ทุกช่วงเวลา) — payload เบา (2 คอลัมน์)
// ใช้ฝั่ง client เช็คว่างาน WIP IN เริ่มผลิตหรือยัง โดยไม่ต้องโหลด record เต็มย้อนหลังหลายเดือน
// (เดิม client อ่านจาก cache ที่ถูกตัดเหลือ ~5000 แถวล่าสุด → งานเก่าหา record ไม่เจอ ค้างเป็น "รอผลิต")
async function getProducedJobs(env) {
  const sql = `SELECT DISTINCT valve_no, lot FROM kpi_records WHERE valve_no IS NOT NULL AND valve_no <> ''`;
  const { results } = await env.DB.prepare(sql).all();
  return (results || []).map(r => [r.valve_no, r.lot || '']);
}

async function addKpiRecords(env, body) {
  const records = body.records || [];
  if (!records.length) throw new Error('no records provided');
  const now = new Date().toISOString();
  const placeholders = KPI_COLS.map(() => '?').join(',');
  // ❗เดิม: Worker สร้าง record_id ใหม่ทับของ client เสมอ → (1) id ฝั่ง client ไม่ตรง DB
  //   ทำให้ ลบ/แก้ไข จากหน้าประวัติไม่มีผลจริงใน D1 (WHERE record_id ไม่เจอแถว)
  //   (2) ส่งซ้ำ (retry/offline flush ตอนเน็ตสะดุด) = แถวใหม่อีกชุด → บันทึกซ้ำ (double records)
  // ใหม่: ใช้ id ของ client เป็น idempotency key + ON CONFLICT ทับแถวเดิม → ส่งซ้ำกี่ครั้งก็ได้ 1 แถว
  const upsertSet = KPI_COLS.filter(c => c !== 'record_id').map(c => `${c}=excluded.${c}`).join(', ');
  const stmt = env.DB.prepare(
    `INSERT INTO kpi_records (${KPI_COLS.join(',')}) VALUES (${placeholders})
     ON CONFLICT(record_id) DO UPDATE SET ${upsertSet}`);
  const ids = [];
  const batch = records.map((r, i) => {
    const id = String(r.record_id || r.recordId || '').trim()
            || `K-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2,6)}`;
    ids.push(id);
    const row = {
      ...r,
      record_id: id,
      saved_at: r.saved_at || now,
      shifts: typeof r.shifts === 'string' ? r.shifts : JSON.stringify(r.shifts || []),
    };
    return stmt.bind(...KPI_COLS.map(c => {
      const v = row[c];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  });
  await env.DB.batch(batch);
  return { count: batch.length, ids };
}

async function updateKpiRecord(env, body) {
  const id = body.record_id || body.recordId;
  if (!id) throw new Error('record_id required');
  const sets = [];
  const args = [];
  for (const c of KPI_COLS) {
    if (c === 'record_id') continue;
    if (body[c] !== undefined) {
      sets.push(`${c} = ?`);
      const v = body[c];
      args.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return { updated: 0 };
  args.push(id);
  const r = await env.DB.prepare(`UPDATE kpi_records SET ${sets.join(', ')} WHERE record_id = ?`).bind(...args).run();
  let updated = r.meta?.changes || 0;
  // ไม่พบแถว (id เก่าที่ Worker เคยสร้างใหม่เอง — local id ไม่ตรง DB) + ข้อมูลครบพอ →
  // insert เป็นแถวใหม่ด้วย id นี้แทน (upsert) เพื่อไม่ให้การแก้ไขหายเงียบ
  if (!updated && body.record_date && body.zone && body.machine_id) {
    await addKpiRecords(env, { records: [{ ...body, record_id: id }] });
    updated = 1;
  }
  // ★ 2026-08-04 — แก้ KPI ที่หน้าประวัติ → prod record ที่ผูกกันต้องตามไปด้วย
  //   นี่คือต้นเหตุหลักที่หน้าติดตามงานโชว์ valve/lot/ยอด เก่าค้าง ทั้งที่ประวัติแก้ไปแล้ว
  const prodSynced = await syncProdFromKpi(env, id, body, body.prod_ids || []);
  return { updated, prod_synced: prodSynced };
}

/* KPI → prod: ดันฟิลด์ที่ใช้ร่วมกันลงทุก prod record ที่ kpi_record_id = id
   ยอด (quantity) ดันเฉพาะคู่ 1:1 — ถ้า KPI แถวเดียวแตกเป็นหลาย process การเขียนยอดทับทุกแถว = นับซ้ำ */
async function syncProdFromKpi(env, kpiId, body, prodIds = []) {
  const sets = [], args = [];
  const put = (col, v) => { if (v !== undefined && v !== null) { sets.push(`${col} = ?`); args.push(v); } };
  put('valve_no',   body.valve_no);
  put('lot',        body.lot);
  put('operator',   body.operator);
  put('machine_id', body.machine_id);
  put('zone',       body.zone);
  put('shift_date', body.shift_date || body.record_date);
  put('shift_type', body.shift_type);
  const pids = (prodIds || []).filter(Boolean);
  if (body.quantity !== undefined || body.opr !== undefined || body.last_process !== undefined) {
    const c = await env.DB.prepare('SELECT COUNT(*) n FROM production_records WHERE kpi_record_id = ?').bind(kpiId).first();
    const n = Math.max(c?.n || 0, pids.length);   // แถวที่ยังไม่ซ่อมนับจาก id ที่ client ส่งมาแทน
    if (n <= 1) {
      if (body.opr !== undefined) put('quantity', Number(body.opr || 0));
      if (body.last_process !== undefined) put('current_process', body.last_process);
    }
  }
  if (!sets.length) return 0;
  const setSql = sets.join(', ');
  let changed = 0;
  const r = await env.DB.prepare(`UPDATE production_records SET ${setSql} WHERE kpi_record_id = ?`)
    .bind(...args, kpiId).run();
  changed += r.meta?.changes || 0;
  /* แถวที่ยังไม่ได้กดซ่อม คอลัมน์ kpi_record_id ยังว่าง → WHERE ด้านบนไม่โดน
     ใช้ prod_ids ที่ client ผูกไว้แทน + ถือโอกาสเขียนคีย์เชื่อมให้ถาวรไปเลย */
  if (pids.length) {
    const st = env.DB.prepare(
      `UPDATE production_records SET ${setSql}, kpi_record_id = ? WHERE record_id = ? AND (kpi_record_id IS NULL OR kpi_record_id = '')`);
    for (let i = 0; i < pids.length; i += 200) {
      const res = await env.DB.batch(pids.slice(i, i + 200).map(p => st.bind(...args, kpiId, p)));
      changed += res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
    }
  }
  return changed;
}

async function deleteKpiRecords(env, body) {
  const ids = body.ids || (body.record_id ? [body.record_id] : []);
  if (!ids.length) throw new Error('ids required');
  const stmt = env.DB.prepare('DELETE FROM kpi_records WHERE record_id = ?');
  const r = await env.DB.batch(ids.map(id => stmt.bind(id)));
  // ★ 2026-08-04 — ลบ KPI แล้วต้องลบ prod ที่ผูกกันด้วย ไม่งั้นเหลือเป็น "แถวผี"
  //   ที่หน้าติดตามงานยังโชว์ยอดอยู่ ทั้งที่หน้าประวัติลบไปแล้ว (พบค้างอยู่ 170 แถว)
  const pstmt = env.DB.prepare('DELETE FROM production_records WHERE kpi_record_id = ?');
  const pr = await env.DB.batch(ids.map(id => pstmt.bind(id)));
  let prodDeleted = pr.reduce((s, x) => s + (x.meta?.changes || 0), 0);
  /* ★ ข้อมูลที่ยังไม่ได้กดซ่อม คอลัมน์ kpi_record_id ยังว่างใน D1 → WHERE ด้านบนหาไม่เจอ
     client จึงส่ง prod_ids ที่มันผูกไว้ (ผูกตอนอ่าน) มาให้ลบตรง id — ไม่งั้นเครื่องที่กดลบ
     เห็นหายไปแล้ว แต่เครื่องอื่นยังเห็นยอดค้างอยู่ใน D1 (กลายเป็นแถวผีตัวใหม่) */
  const pids = (body.prod_ids || []).filter(Boolean);
  if (pids.length) {
    const dstmt = env.DB.prepare('DELETE FROM production_records WHERE record_id = ?');
    for (let i = 0; i < pids.length; i += 200) {
      const res = await env.DB.batch(pids.slice(i, i + 200).map(p => dstmt.bind(p)));
      prodDeleted += res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
    }
  }
  return {
    deleted:      r.reduce((s, x) => s + (x.meta?.changes || 0), 0),
    prod_deleted: prodDeleted,
  };
}

/* ============================================================
   RECONCILE — ตรวจ/ซ่อมความสอดคล้อง kpi_records ↔ production_records  (2026-08-04)

   ข้อมูลที่บันทึกก่อนวันนี้ไม่มี kpi_record_id/shift_date → ต้องซ่อมย้อนหลัง
   สายสัมพันธ์ที่ใช้จับคู่: prod.timestamp === kpi.saved_at
     ตอนบันทึก client ใช้ตัวแปร `now` ตัวเดียวกันเขียนลงทั้งสองตาราง (index.html ~12921)
     → ค่าตรงกันเป๊ะระดับมิลลิวินาที ใช้เป็นคีย์ย้อนรอย "ชุดบันทึกเดียวกัน" ได้แม่นยำ
   ภายในชุดเดียวกันจับคู่ต่อด้วย valve+lot+เครื่อง+ยอด → ถ้ายังเหลือค่อยไล่ตามลำดับที่เหลือ
   ============================================================ */
const _rcNorm = s => String(s || '').trim().toUpperCase().replace(/\$/g, 'S');

/* จับคู่ prod ↔ kpi ภายในชุดบันทึกเดียวกัน — คืน [[prodRow, kpiRow|null], ...] */
function _rcPair(prods, kpis) {
  const left = kpis.slice(), out = [];
  const exact = p => left.findIndex(k =>
    _rcNorm(k.valve_no) === _rcNorm(p.valve_no) && _rcNorm(k.lot) === _rcNorm(p.lot) &&
    _rcNorm(k.machine_id) === _rcNorm(p.machine_id) && Math.round(+k.opr || 0) === Math.round(+p.quantity || 0));
  const loose = p => left.findIndex(k =>
    _rcNorm(k.machine_id) === _rcNorm(p.machine_id) && Math.round(+k.opr || 0) === Math.round(+p.quantity || 0));
  const rest  = [];
  for (const p of prods) {
    let i = exact(p);
    if (i < 0) i = loose(p);
    if (i < 0) { rest.push(p); continue; }
    out.push([p, left.splice(i, 1)[0]]);
  }
  // ที่เหลือ = ฝั่งใดฝั่งหนึ่งถูกแก้ไปแล้ว (valve/lot/ยอด ไม่ตรง) — จับคู่ตามลำดับที่เหลือ
  for (const p of rest) out.push([p, left.length ? left.shift() : null]);
  return out;
}

async function _rcLoad(env, from, to) {
  const f = String(from || '2000-01-01').slice(0, 10), t = String(to || '2999-12-31').slice(0, 10);
  const { results: prods } = await env.DB.prepare(
    `SELECT record_id, timestamp, valve_no, lot, quantity, current_process, machine_id, shift_date, kpi_record_id, note, operator
     FROM production_records WHERE ${PROD_DATE_SQL} BETWEEN ? AND ?`).bind(f, t).all();
  // ดึง KPI กว้างกว่า 2 วันทั้งสองด้าน — งานกะดึกถูกบันทึกข้ามวัน ชุดบันทึกจึงคร่อมขอบช่วงได้
  const wf = _rcShift(f, -2), wt = _rcShift(t, 2);
  const { results: kpis } = await env.DB.prepare(
    `SELECT record_id, saved_at, shift_date, record_date, shift_type, valve_no, lot, opr, last_process, machine_id
     FROM kpi_records WHERE COALESCE(shift_date, record_date) BETWEEN ? AND ?`).bind(wf, wt).all();
  return { prods: prods || [], kpis: kpis || [] };
}
function _rcShift(d, days) {
  const t = new Date(d + 'T00:00:00Z');
  return new Date(t.getTime() + days * 864e5).toISOString().slice(0, 10);
}

/* วิเคราะห์ทั้งช่วง — ใช้ร่วมกันทั้งโหมดรายงานและโหมดซ่อม */
async function _rcAnalyze(env, from, to) {
  const { prods, kpis } = await _rcLoad(env, from, to);
  const byBatch = new Map();
  for (const k of kpis) {
    const b = String(k.saved_at || ''); if (!b) continue;
    if (!byBatch.has(b)) byBatch.set(b, []);
    byBatch.get(b).push(k);
  }
  const pByBatch = new Map();
  for (const p of prods) {
    const b = String(p.timestamp || ''); if (!b) continue;
    if (!pByBatch.has(b)) pByBatch.set(b, []);
    pByBatch.get(b).push(p);
  }
  const fixes = [], ghosts = [];
  let dateWrong = 0, noLink = 0, fieldDiff = 0, mcMissing = 0, dateByRule = 0, dateOdd = 0;
  for (const [b, ps] of pByBatch) {
    const ks = byBatch.get(b);
    if (!ks || !ks.length) { for (const p of ps) ghosts.push(p); continue; }
    for (const [p, k] of _rcPair(ps, ks)) {
      if (!k) { ghosts.push(p); continue; }
      const sd = k.shift_date || k.record_date || '';
      /* ⚠️ ต้องเทียบกับ "วันที่ที่หน้าจอแสดงอยู่ตอนนี้จริง ๆ" ไม่ใช่คอลัมน์ shift_date ดิบ
         แถวเก่ายังไม่ถูกซ่อม คอลัมน์จะว่าง แต่หน้าจอ fallback ไปใช้ timestamp แปลงเป็นวันไทยอยู่แล้ว
         ถ้านับแถวว่างเป็น "วันผิด" ทั้งหมด ตัวเลขจะพองเกินจริง (11,488 ทั้งที่ผิดจริง ~4,400) */
      const effective = p.shift_date || _thDate(p.timestamp);
      // valve/lot ต่างกันจริง — เทียบเฉพาะตอนที่ทั้งสองฝั่งมีค่า (ฝั่งว่าง = ข้อมูลขาด ไม่ใช่ขัดแย้ง)
      if ((k.valve_no && p.valve_no && _rcNorm(k.valve_no) !== _rcNorm(p.valve_no)) ||
          (k.lot && p.lot && _rcNorm(k.lot) !== _rcNorm(p.lot))) fieldDiff++;
      if (k.machine_id && !String(p.machine_id || '').trim()) mcMissing++;
      /* ★ ต่างวันกัน ≠ ข้อมูลผิด — ต้องแยกให้ชัด ไม่งั้นอ่านรายงานแล้วตกใจเปล่า
         กติกา "วันทำงาน" ของโรงงาน (index.html `_resolveShift`):
           08:00–19:59 = กะกลางวัน → วันทำงาน = วันที่เริ่มงาน
           20:00–23:59 = กะกลางคืน → วันทำงาน = วันที่เริ่มงาน
           00:00–07:59 = กะกลางคืน → วันทำงาน = "วันก่อนหน้า" (หางกะดึกของเมื่อวาน)
         ⇒ กะดึกที่ลงตอนเช้า หรือกะที่ลงย้อนหลัง จะมีวันผลิต < วันที่กดบันทึกเสมอ = ถูกต้อง
         ตรวจข้อมูลจริงทั้งปี 2026 (5,304 แถวที่ต่างกัน): เข้ากติกา 5,304 · ผิดปกติ 0
         สิ่งเดียวที่ผิดจริงคือ "วันผลิตอยู่หลังวันกดบันทึก" ซึ่งเป็นไปไม่ได้ */
      if (sd && sd !== effective) {
        dateWrong++;
        if (new Date(effective) > new Date(sd)) dateByRule++;   // ลงทีหลัง/กะดึก = ปกติ
        else dateOdd++;                                          // วันผลิตอยู่อนาคตของวันบันทึก = ต้องดู
      }
      if (!p.kpi_record_id) noLink++;
      if (!p.kpi_record_id || (sd && p.shift_date !== sd)) {
        fixes.push({ id: p.record_id, kid: k.record_id, sd, st: k.shift_type || '', mc: k.machine_id || '' });
      }
    }
  }
  return { prods, kpis, fixes, ghosts, stats: { prod_rows: prods.length, kpi_rows: kpis.length,
           need_link: noLink, field_diff: fieldDiff, machine_missing: mcMissing,
           date_mismatch: dateWrong,          // หน้าติดตามงานแสดงคนละวันกับประวัติ
           date_by_rule: dateByRule,          // ↳ กะดึก/ลงย้อนหลัง = ถูกตามกติกา ไม่ใช่ข้อมูลผิด
           date_odd: dateOdd,                 // ↳ วันผลิตอยู่หลังวันกดบันทึก = ผิดปกติจริง
           ghosts: ghosts.length } };
}

/* แถวผีมาจาก 2 ทางที่ผลต่างกันมาก — ต้องแยกให้เห็นก่อนตัดสินใจลบ
   'kpi-deleted' : note = auto-linked KPI → เคยมี KPI แล้วถูกลบข้างเดียว = ผีจริง ลบได้
   'standalone'  : ลงตรงที่ยอดผลิต ไม่เคยมี KPI มาแต่แรก = ข้อมูลถูกต้องของมัน ห้ามลบ */
const _rcOrigin = g => /auto-linked KPI/i.test(String(g.note || '')) ? 'kpi-deleted' : 'standalone';

async function reconcileReport(env, params) {
  const from = params.get('from'), to = params.get('to');
  const a = await _rcAnalyze(env, from, to);
  const orphaned = a.ghosts.filter(g => _rcOrigin(g) === 'kpi-deleted').length;
  return {
    range: { from: from || null, to: to || null },
    ...a.stats,
    will_fix: a.fixes.length,
    ghosts_kpi_deleted: orphaned,                    // เคยมี KPI แล้วถูกลบ → ลบทิ้งได้
    ghosts_standalone:  a.ghosts.length - orphaned,  // ไม่เคยมี KPI → ห้ามลบ
    // ตัวอย่างแถวผีให้ดูก่อนตัดสินใจลบ — ไม่ลบอะไรทั้งสิ้นในโหมดรายงาน
    ghost_sample: a.ghosts.slice(0, 100).map(g => ({
      record_id: g.record_id, timestamp: g.timestamp, machine_id: g.machine_id,
      valve_no: g.valve_no, lot: g.lot, quantity: g.quantity, process: g.current_process,
      origin: _rcOrigin(g), operator: g.operator || '',
    })),
  };
}

async function reconcileApply(env, body) {
  const a = await _rcAnalyze(env, body.from, body.to);
  let linked = 0;
  // เติม kpi_record_id + shift_date/shift_type ให้แถวเก่า — ทีละ 200 กันเกินเพดาน batch ของ D1
  // machine_id เติมเฉพาะแถวที่ว่างอยู่ (COALESCE) — ห้ามเขียนทับของเดิมที่ถูกต้องแล้ว
  const stmt = env.DB.prepare(
    `UPDATE production_records
        SET kpi_record_id = ?, shift_date = ?, shift_type = ?,
            machine_id = COALESCE(NULLIF(machine_id,''), ?)
      WHERE record_id = ?`);
  for (let i = 0; i < a.fixes.length; i += 200) {
    const chunk = a.fixes.slice(i, i + 200);
    const res = await env.DB.batch(chunk.map(f => stmt.bind(f.kid, f.sd, f.st, f.mc || '', f.id)));
    linked += res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
  }
  // แถวผี (ไม่มี KPI คู่) — ลบเฉพาะเมื่อสั่งมาชัดเจนเท่านั้น ไม่ลบเองโดยอัตโนมัติ
  //   และลบเฉพาะแถวที่ "เคยมี KPI แล้วถูกลบ" เท่านั้น — แถวที่ลงตรงที่ยอดผลิตเป็นข้อมูลถูกต้องของมัน
  let ghostDeleted = 0;
  const delable = a.ghosts.filter(g => _rcOrigin(g) === 'kpi-deleted');
  if (body.deleteGhosts === true && delable.length) {
    const dstmt = env.DB.prepare('DELETE FROM production_records WHERE record_id = ?');
    for (let i = 0; i < delable.length; i += 200) {
      const res = await env.DB.batch(delable.slice(i, i + 200).map(g => dstmt.bind(g.record_id)));
      ghostDeleted += res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
    }
  }
  return { ...a.stats, linked, ghost_deleted: ghostDeleted,
           ghosts_left: a.ghosts.length - ghostDeleted,
           ghosts_kpi_deleted: delable.length, ghosts_standalone: a.ghosts.length - delable.length };
}

// ============================================================
// TARGETS
// ============================================================
async function getTargets(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM targets').all();
  const out = {};
  for (const r of results || []) out[r.key] = Number(r.value);
  return out;
}

async function setTargets(env, body) {
  const stmt = env.DB.prepare(`
    INSERT INTO targets (key, value, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  const batch = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v === 'number' || (!isNaN(parseFloat(v)) && v !== null)) {
      batch.push(stmt.bind(String(k), Number(v)));
    }
  }
  if (batch.length) await env.DB.batch(batch);
  return { updated: batch.length };
}

// ============================================================
// PRODUCTION PLANS
// ============================================================
async function getPlans(env, params) {
  const conds = [];
  const args  = [];
  if (params.get('from'))   { conds.push('plan_date >= ?'); args.push(params.get('from')); }
  if (params.get('to'))     { conds.push('plan_date <= ?'); args.push(params.get('to')); }
  if (params.get('status')) { conds.push('status = ?');    args.push(params.get('status')); }
  if (params.get('valve'))  { conds.push('LOWER(valve_no) LIKE ?'); args.push('%' + params.get('valve').toLowerCase() + '%'); }
  if (params.get('lot'))    { conds.push('LOWER(lot) LIKE ?');      args.push('%' + params.get('lot').toLowerCase() + '%'); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(parseInt(params.get('limit') || '2000', 10), 10000);
  const sql = `SELECT * FROM production_plans ${where} ORDER BY plan_date ASC, created_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return results || [];
}

async function upsertPlan(env, body) {
  const planId = body.plan_id || body.planId || newId('P');
  const valve  = String(body.valve_no || body.valveNo || '').trim();
  if (!valve) throw new Error('valve_no required');
  const lot    = String(body.lot || '');
  const date   = String(body.plan_date || body.planDate || '');
  const qty    = Number(body.quantity || 0);
  const status = String(body.status || 'planned');
  const note   = String(body.note || '');
  const by     = String(body.created_by || body.createdBy || '');
  const now    = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO production_plans (plan_id, valve_no, lot, plan_date, quantity, status, note, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      valve_no=excluded.valve_no, lot=excluded.lot, plan_date=excluded.plan_date,
      quantity=excluded.quantity, status=excluded.status, note=excluded.note,
      updated_at=excluded.updated_at
  `).bind(planId, valve, lot, date, qty, status, note, by, now).run();
  return { plan_id: planId };
}

async function bulkUpsertPlans(env, body) {
  const list = body.plans || [];
  const now  = new Date().toISOString();
  const stmt = env.DB.prepare(`
    INSERT INTO production_plans (plan_id, valve_no, lot, plan_date, quantity, status, note, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      valve_no=excluded.valve_no, lot=excluded.lot, plan_date=excluded.plan_date,
      quantity=excluded.quantity, status=excluded.status, note=excluded.note,
      updated_at=excluded.updated_at
  `);
  const ids = [];
  const batch = list.map(p => {
    const id = p.plan_id || p.planId || newId('P');
    ids.push(id);
    return stmt.bind(
      id,
      String(p.valve_no || p.valveNo || '').trim(),
      String(p.lot || ''),
      String(p.plan_date || p.planDate || ''),
      Number(p.quantity || 0),
      String(p.status || 'planned'),
      String(p.note || ''),
      String(p.created_by || p.createdBy || ''),
      now
    );
  });
  if (batch.length) await env.DB.batch(batch);
  return { count: batch.length, ids };
}

async function deletePlan(env, body) {
  const id = body.plan_id || body.planId;
  if (!id) throw new Error('plan_id required');
  const r = await env.DB.prepare('DELETE FROM production_plans WHERE plan_id = ?').bind(id).run();
  return { deleted: r.meta?.changes || 0 };
}

// ============================================================
// VALVE IDS (1 valve มีหลาย ID — สแกนบาร์โค้ดจะ lookup ID → valve+lot)
// ============================================================
async function getIds(env, params) {
  const conds = [];
  const args  = [];
  if (params.get('valve')) { conds.push('valve_no = ?'); args.push(params.get('valve')); }
  if (params.get('lot'))   { conds.push('lot = ?');      args.push(params.get('lot')); }
  if (params.get('q')) {
    conds.push('(id_code LIKE ? OR valve_no LIKE ? OR lot LIKE ?)');
    const q = '%' + params.get('q') + '%';
    args.push(q, q, q);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(parseInt(params.get('limit') || '5000', 10), 50000);
  const sql = `SELECT id_code, valve_no, lot, note, updated_at FROM valve_ids ${where} ORDER BY valve_no, lot, id_code LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return results || [];
}

async function lookupId(env, params) {
  const id = String(params.get('id') || '').trim();
  if (!id) return { found: false, error: 'id required' };
  const r = await env.DB.prepare(
    'SELECT id_code, valve_no, lot, note FROM valve_ids WHERE id_code = ? LIMIT 1'
  ).bind(id).first();
  if (!r) return { found: false, id_code: id };
  return { found: true, ...r };
}

async function upsertId(env, body) {
  const id    = String(body.id_code || body.id || '').trim();
  const valve = String(body.valve_no || body.valveNo || '').trim();
  if (!id)    throw new Error('id_code required');
  if (!valve) throw new Error('valve_no required');
  const lot  = String(body.lot || '');
  const note = String(body.note || '');
  const now  = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO valve_ids (id_code, valve_no, lot, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id_code) DO UPDATE SET
      valve_no=excluded.valve_no, lot=excluded.lot, note=excluded.note, updated_at=excluded.updated_at
  `).bind(id, valve, lot, note, now).run();
  return { id_code: id, valve_no: valve, lot, note };
}

async function bulkUpsertIds(env, body) {
  const list = body.ids || [];
  const now  = new Date().toISOString();
  const stmt = env.DB.prepare(`
    INSERT INTO valve_ids (id_code, valve_no, lot, note, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id_code) DO UPDATE SET
      valve_no=excluded.valve_no, lot=excluded.lot, note=excluded.note, updated_at=excluded.updated_at
  `);
  const batch = [];
  const skipped = [];
  for (const r of list) {
    const id    = String(r.id_code || r.id || '').trim();
    const valve = String(r.valve_no || r.valveNo || '').trim();
    if (!id || !valve) { skipped.push(r); continue; }
    batch.push(stmt.bind(id, valve, String(r.lot || ''), String(r.note || ''), now));
  }
  if (batch.length) await env.DB.batch(batch);
  return { count: batch.length, skipped: skipped.length };
}

async function deleteId(env, body) {
  const ids = body.ids || (body.id_code ? [body.id_code] : (body.id ? [body.id] : []));
  if (!ids.length) throw new Error('id_code(s) required');
  const stmt = env.DB.prepare('DELETE FROM valve_ids WHERE id_code = ?');
  const r = await env.DB.batch(ids.map(x => stmt.bind(String(x))));
  return { deleted: r.reduce((s, x) => s + (x.meta?.changes || 0), 0) };
}

// ============================================================
// STATS (Dashboard aggregates)
// ============================================================
async function getStats(env, params) {
  const from = params.get('from') || '1900-01-01';
  const to   = (params.get('to')   || '2999-12-31') + 'T23:59:59';

  // ดึงข้อมูลทั้งหมดใน range
  const records = (await env.DB.prepare(
    'SELECT valve_no, lot, quantity, current_process, status FROM production_records WHERE timestamp BETWEEN ? AND ?'
  ).bind(from, to).all()).results || [];

  const valves = (await env.DB.prepare('SELECT valve_no, customer, processes FROM valves').all()).results || [];
  const vMap = {};
  for (const v of valves) {
    vMap[v.valve_no] = {
      customer: v.customer || 'Other',
      procs:    (v.processes || '').split(',').map(s => s.trim()).filter(Boolean),
    };
  }

  let doneQty = 0, wipQty = 0;
  const byCustomer = {};       // {Customer: {done, wip}}
  const byProcess  = {};       // {Process: qty}

  // หา latest record per (valve_no, lot)
  const latest = {};
  for (const r of records) {
    const key = `${r.valve_no}::${r.lot || ''}`;
    if (!latest[key]) latest[key] = r;     // assume already sorted by timestamp DESC? not — group by max qty as proxy
    else if ((r.quantity || 0) > (latest[key].quantity || 0)) latest[key] = r;
  }

  for (const r of Object.values(latest)) {
    const cust  = vMap[r.valve_no]?.customer || 'Other';
    const procs = vMap[r.valve_no]?.procs || [];
    const lastProc = procs[procs.length - 1] || '';
    const qty = Number(r.quantity || 0);
    byCustomer[cust] = byCustomer[cust] || { done: 0, wip: 0 };
    if (r.status === 'Completed' || r.current_process === lastProc) {
      doneQty += qty; byCustomer[cust].done += qty;
    } else {
      wipQty  += qty; byCustomer[cust].wip  += qty;
      const p = r.current_process || '';
      if (p) byProcess[p] = (byProcess[p] || 0) + qty;
    }
  }

  return {
    range:        { from: params.get('from') || '', to: params.get('to') || '' },
    total_done:   doneQty,
    total_wip:    wipQty,
    by_customer:  byCustomer,
    by_process:   byProcess,
    record_count: records.length,
  };
}

