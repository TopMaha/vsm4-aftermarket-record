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

// ============================================================
// MAIN ROUTER
// ============================================================
export default {
  async fetch(request, env) {
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

      // employees
      if (path === '/api/employees'        && m === 'GET')  return ok({ employees: await getEmployees(env) });
      if (path === '/api/employees'        && m === 'POST') return ok(await upsertEmployee(env, await readJson(request)));
      if (path === '/api/employees/delete' && m === 'POST') return ok(await deleteEmployee(env, await readJson(request)));

      // kpi
      if (path === '/api/kpi'        && m === 'GET')  return ok({ records: await getKpiRecords(env, url.searchParams) });
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
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* มีคอลัมน์แล้ว → ข้าม */ }
  }
  _schemaReady = true;
}

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
  if (params.get('from'))   { conds.push('timestamp >= ?');      args.push(params.get('from')); }
  if (params.get('to'))     { conds.push('timestamp <= ?');      args.push(params.get('to') + 'T23:59:59'); }
  if (params.get('proc'))   { conds.push('current_process = ?'); args.push(params.get('proc')); }
  if (params.get('status')) { conds.push('status = ?');          args.push(params.get('status')); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(parseInt(params.get('limit') || '1000', 10), 5000);
  const sql = `SELECT * FROM production_records ${where} ORDER BY timestamp DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return (results || []).map(rowToRecord);
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
  };
}

/* upsert 1 แถว production record — id เดิมของ client ถูก "คงไว้" (idempotent)
   ส่งซ้ำ (retry/offline flush) = ทับแถวเดิม ไม่เกิด record ซ้ำใน DB อีก */
const PROD_UPSERT_SQL = `
  INSERT INTO production_records (record_id, timestamp, valve_no, lot, quantity, current_process, completed_processes, status, operator, note, machine_id, zone, vsm)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(record_id) DO UPDATE SET
    timestamp=excluded.timestamp, valve_no=excluded.valve_no, lot=excluded.lot,
    quantity=excluded.quantity, current_process=excluded.current_process,
    completed_processes=excluded.completed_processes, status=excluded.status,
    operator=excluded.operator, note=excluded.note,
    machine_id=excluded.machine_id, zone=excluded.zone, vsm=excluded.vsm`;
function prodBind(stmt, r, id) {
  return stmt.bind(
    id,
    r.timestamp || new Date().toISOString(),
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
    String(r.vsm || '')
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
  return { updated };
}

async function deleteRecord(env, body) {
  if (!body.recordId && !body.record_id) throw new Error('recordId required');
  const r = await env.DB.prepare('DELETE FROM production_records WHERE record_id = ?').bind(body.recordId || body.record_id).run();
  return { deleted: r.meta?.changes || 0 };
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

// ============================================================
// EMPLOYEES
// ============================================================
async function getEmployees(env) {
  const { results } = await env.DB.prepare(
    'SELECT emp_id AS id, name FROM employees ORDER BY emp_id'
  ).all();
  return results || [];
}

async function upsertEmployee(env, body) {
  const id   = String(body.id || body.emp_id || '').trim();
  if (!id) throw new Error('emp id required');
  const name = String(body.name || '').trim();
  await env.DB.prepare(`
    INSERT INTO employees (emp_id, name, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(emp_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
  `).bind(id, name).run();
  return { employee: { id, name } };
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
  const limit = Math.min(parseInt(params.get('limit') || '500', 10), 5000);
  const sql = `SELECT * FROM kpi_records ${where} ORDER BY saved_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return results || [];
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
  return { updated };
}

async function deleteKpiRecords(env, body) {
  const ids = body.ids || (body.record_id ? [body.record_id] : []);
  if (!ids.length) throw new Error('ids required');
  const stmt = env.DB.prepare('DELETE FROM kpi_records WHERE record_id = ?');
  const r = await env.DB.batch(ids.map(id => stmt.bind(id)));
  return { deleted: r.reduce((s, x) => s + (x.meta?.changes || 0), 0) };
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

