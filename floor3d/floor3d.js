/* ============================================================
   ★ v3.97 (2026-10-27) ผังโรงงาน 3D — โหมด 3D ของการ์ด "ตรวจสอบสถานะเครื่องจักร"
   • index.html โหลดไฟล์นี้ด้วย import() ตอนเปิดโหมด 3D ครั้งแรกเท่านั้น (ปิด flag = ไม่โหลดเลย)
     Three.js 0.186.1 จาก jsDelivr ผ่าน import map ใน <head> · Service Worker เก็บไว้ใช้ออฟไลน์
   • ไม่อ่าน state ของแอปเอง — index.html ส่ง "ชุดข้อมูล" (_f3dPayload) ที่ทำจาก _iotData ตัวเดียวกับผัง 2D
     → สถานะ / OAE / TOP ปัญหา / SOS / ตัวเลข ตรงกับผัง 2D และการ์ด Dashboard เสมอ · ไม่มีข้อมูลสมมติ
   • วางเครื่องตามพิกัดผัง 2D 1:1 (px ของผัง = หน่วยโลก · x → X · y → Z) ไม่จัดผังใหม่
   • ประหยัดเครื่อง (Android ระดับกลาง):
       - วาดเฉพาะตอนลาก/มี animation · หยุดเมื่อซ่อนแท็บหรือการ์ดพ้นจอ · DPR ≤ 2 (เครื่องอ่อน ≤ 1.5)
       - เครื่องทั้งผังรวมเป็น mesh ก้อนเดียว (สีต่อจุดยอด) → ทั้งฉาก ~15 draw call · เงาวาดใหม่เฉพาะตอนฉากเปลี่ยน
       - ป้าย / หมุด TOP / SOS เป็น DOM (CSS2D) + CSS animation → กระพริบ/ลอยได้โดยไม่ต้องวาด WebGL ซ้ำ
   ============================================================ */
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// สีชุดเดียวกับแอป (ผัง 2D: เขียว #16a34a · ส้ม #ea580c · ปิด = เทาเข้ม) — สีที่ไม่ใช่สถานะเลี่ยงเขียว/ส้ม/แดงทั้งหมด
const COL = {
  bg: 0xD9E3F0, floor: 0xF2F6FB, floorSide: 0xC5D3E6, grid: 0xDDE6F1, aisle: 0xE7EDF6, line: 0xF2C21B,
  good: 0x16A34A, warn: 0xEA580C, off: 0x4B5563, pend: 0xCBD5E1,
  lampGood: 0x4ADE80, lampWarn: 0xFB923C, lampOff: 0x1F2937, lampSos: 0xEF4444, lampPend: 0xE2E8F0,
  body: 0xF8FAFC, bodyOff: 0x9CA3AF, blue: 0x1A56DB, blueOff: 0x64748B, steel: 0xCBD5E1, steelOff: 0x6B7280,
  dark: 0x475569, glass: 0xBFDBFE, glassOff: 0x94A3B8, scr: 0x1E293B,
  lineLb: 0xFDE047, wood: 0xC69C63, kraft: 0xDDBE8E, cart: 0x1E40AF, steelProp: 0x94A3B8,
  vest: 0x1E3A8A, helmet: 0xFBBF24, sel: 0x1A56DB,
};
const F = 1000;                                   // ความสูง frustum ที่ zoom = 1 (หน่วยโลก)
const R = 3000;                                   // ระยะกล้อง — ortho ไม่มีผลกับขนาด แค่กันตัด near/far
// มุมเริ่ม (+ ปุ่ม ⊙) = มองตรงจากด้านล่างของผัง 2D (ซ้าย-ขวาตรงกับผัง 2D) เอียง 40° จากแนวดิ่ง (เงย ~50°)
//   ★ v4.04 ผู้ใช้ 29/10 ส่งรูปมุมนี้ "มองง่ายดี" — เดิม { theta: .55, phi: .98 } = เฉียงจากมุมล่างขวา (เงย ~34°)
const VIEW0 = { theta: 0, phi: 0.7 };
const TOPV = { theta: 0, phi: 0.0008 };           // มุมบน = หันเหมือนผัง 2D ทุกประการ
const ZOOM_STEP = 1.45;
let _hinted = false;                              // คำแนะนำวิธีใช้ (นิ้ว/แตะ) โชว์ครั้งเดียวต่อการเปิดแอป

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
/* geometry ต้นแบบตามขนาด (ปัดทีละ 0.25 หน่วย — มองไม่เห็นความต่าง) → เครื่องขนาดเดียวกันใช้ต้นแบบร่วม แล้ว clone
   วัดจริง: สร้าง RoundedBoxGeometry ใหม่ทุกชิ้น (คำนวณ UV ทุกจุด) = เวลาส่วนใหญ่ของการสร้างฉาก · ไม่ใช้ texture → ตัด UV ทิ้ง */
const _geo = new Map();
const q4 = v => Math.round(v * 4) / 4;
// คืนสำเนาแบบ BufferGeometry เปล่า (position/normal/index) — ❗ห้ามใช้ .clone(): ของ RoundedBoxGeometry/Cylinder
//   จะสร้าง geometry ค่าตั้งต้นใหม่ทั้งชุด (คำนวณ UV ทุกจุด) ก่อน copy = ช้าเท่าสร้างใหม่ (วัดแล้วช้ากว่าเดิม 2 เท่า)
function cachedGeo(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); g.deleteAttribute('uv'); _geo.set(key, g); }
  const c = new THREE.BufferGeometry();
  c.setAttribute('position', new THREE.BufferAttribute(g.attributes.position.array.slice(), 3));
  c.setAttribute('normal', new THREE.BufferAttribute(g.attributes.normal.array.slice(), 3));
  if (g.index) c.setIndex(new THREE.BufferAttribute(g.index.array.slice(), 1));
  return c;
}
function rbox(w, h, d, r, seg) {
  w = q4(w); h = q4(h); d = q4(d);
  const rr = q4(clamp(r, 0.02, Math.max(0.02, Math.min(w, h, d) / 2 - 0.02)));
  return cachedGeo(`b${w}|${h}|${d}|${rr}|${seg || 2}`, () => new RoundedBoxGeometry(w, h, d, seg || 2, Math.max(0.02, Math.min(rr, Math.min(w, h, d) / 2 - 0.02))));
}
const cyl = (r1, r2, h, n, t0, tl) => cachedGeo(`c${q4(r1)}|${q4(r2)}|${q4(h)}|${n}|${t0 || 0}|${tl || 0}`, () => new THREE.CylinderGeometry(q4(r1), q4(r2), q4(h), n, 1, false, t0 || 0, tl || Math.PI * 2));
const box = (w, h, d) => cachedGeo(`x${q4(w)}|${q4(h)}|${q4(d)}`, () => new THREE.BoxGeometry(q4(w), q4(h), q4(d)));
function clearGeoCache() { for (const g of _geo.values()) g.dispose(); _geo.clear(); }
// G/L/H/W/N = ทรงเฉพาะ · อื่น ๆ (D/F/C/Q/สถานี QC) = กล่องทั่วไป
function kindOf(id) {
  const m = /^([A-Z]+)-?\d/.exec(String(id || '').trim().toUpperCase());
  const p = m ? m[1] : '';
  return p.length === 1 && 'GLHWN'.includes(p) ? p : 'X';
}
const fmtNum = (v, f, x) => {
  if (v == null || !isFinite(v)) return '—';
  if (f === 'pct') return ((x && x.cap ? Math.min(v, 1) : v) * 100).toFixed(2) + '%';
  if (f === 'frac') return Math.round(v).toLocaleString() + '/' + Math.round(x.of || 0).toLocaleString();
  return Math.round(v).toLocaleString();
};

/* ── CSS ของ HUD (ฉีดครั้งเดียวตอนโหลดโมดูล — ผู้ใช้ที่ไม่เปิด 3D ไม่ได้ CSS ชุดนี้) ── */
const CSS = `
.f3d{position:absolute;inset:0;overflow:hidden;border-radius:inherit;background:#D9E3F0;touch-action:none;-webkit-user-select:none;user-select:none;isolation:isolate;font-family:'Sarabun',system-ui,sans-serif;color:#0F172A}
.f3d-cv{position:absolute;inset:0;width:100%!important;height:100%!important;display:block;outline:none;cursor:grab}
.f3d-cv:active{cursor:grabbing}
.f3d-lbl{position:absolute!important;inset:0;pointer-events:none;z-index:1}
.f3d-lbl>div{will-change:transform}
.f3d-ml{display:none;font:700 10px/1.15 'Courier New',monospace;color:#0F172A;background:rgba(255,255,255,.9);border:1px solid rgba(148,163,184,.75);border-radius:5px;padding:1px 4px 2px;white-space:nowrap;text-align:center;box-shadow:0 1px 3px rgba(15,23,42,.12)}
.f3d.lv1 .f3d-ml{display:block}
.f3d-ml .v{display:none;font-size:9.5px;font-weight:900;color:#1E3A8A}
.f3d.lv2.jl .f3d-ml .v{display:block}
.f3d-ml .pp{font-family:'Sarabun',system-ui,sans-serif;font-size:9px;font-weight:800;color:#1E3A8A;margin-left:3px}
.f3d-ml.off{background:rgba(229,231,235,.95);color:#374151}
.f3d-ml.pend{background:rgba(255,255,255,.75);color:#64748B;border-style:dashed}
.f3d-ml.sel{background:#1A56DB;color:#fff;border-color:#1A56DB}
.f3d-ml.sel .v,.f3d-ml.sel .pp{color:#DBEAFE}
.f3d-ml.dim{opacity:.35}
.f3d-ll{display:none;font:900 10px/1 'Courier New',monospace;color:#111827;background:rgba(253,224,71,.95);border:1px solid #CA8A04;border-radius:4px;padding:2px 5px;white-space:nowrap}
.f3d.lv1 .f3d-ll{display:block}
.f3d-zs{pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.96);border-radius:10px;border:1.5px solid var(--zc);box-shadow:0 4px 14px rgba(30,58,138,.18);padding:3px 8px 4px;font-size:10.5px;font-weight:800;line-height:1.3;white-space:nowrap}
.f3d-zs .zt{display:flex;align-items:center;gap:5px}
.f3d-zs .zt i{width:9px;height:9px;border-radius:3px;background:var(--zc);flex:0 0 auto}
.f3d-zs .zo{font-variant-numeric:tabular-nums;margin-left:4px}
.f3d-zs .zo.good{color:#15803D}.f3d-zs .zo.warn{color:#C2410C}.f3d-zs .zo.none{color:#94A3B8}
.f3d-zs .zv{display:none;font-weight:700;color:#334155;font-size:10px}
.f3d-zs .zp{display:none;font-weight:800;color:#64748B;font-size:9.5px}
.f3d.lz .f3d-zs .zv,.f3d.lz .f3d-zs .zp.on{display:block}
.f3d-zs .zs-f{display:none}.f3d.lz .f3d-zs .zs-s{display:none}.f3d.lz .f3d-zs .zs-f{display:inline}
.f3d-zs b{font-variant-numeric:tabular-nums}
.f3d-pin{padding-bottom:17px}
.f3d-pin .pn{display:flex;flex-direction:column;align-items:center;animation:f3dBob 2.6s ease-in-out infinite}
.f3d-pin b{min-width:22px;height:22px;border-radius:11px;background:#DC2626;border:2px solid #fff;box-shadow:0 2px 7px rgba(220,38,38,.5);color:#fff;font:900 12px/18px Arial,sans-serif;text-align:center;padding:0 3px}
.f3d-pin i{width:2.5px;height:13px;background:linear-gradient(#DC2626,rgba(220,38,38,.25));margin-top:-1px}
.f3d-pin.dim{opacity:.3}
@keyframes f3dBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
.f3d-sos{width:0;height:0}
.f3d-sos .ry{position:absolute;left:0;top:0;transform:scaleY(var(--sy,.6))}
.f3d-sos .r{position:absolute;left:0;top:0;width:var(--d,40px);height:var(--d,40px);margin:calc(var(--d,40px)/-2) 0 0 calc(var(--d,40px)/-2);border-radius:50%;border:3px solid #EF4444;box-shadow:0 0 10px rgba(239,68,68,.6);animation:f3dPulse 1.6s ease-out infinite}
.f3d-sos .r.r2{animation-delay:.8s}
@keyframes f3dPulse{0%{opacity:.95;transform:scale(.45)}100%{opacity:0;transform:scale(1.3)}}
.f3d-lmp{width:16px;height:16px;border-radius:50%;background:radial-gradient(circle,#fff 0,#FCA5A5 22%,rgba(239,68,68,.85) 42%,rgba(239,68,68,0) 70%);animation:f3dBlink 1s steps(2,jump-none) infinite}
@keyframes f3dBlink{0%{opacity:1}100%{opacity:.08}}
.f3d-top{position:absolute;left:8px;right:8px;top:8px;z-index:3;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.f3d-row{display:flex;gap:6px;align-items:center;min-width:0}
.f3d-chips,.f3d-watch{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;pointer-events:auto;touch-action:pan-x;min-width:0}
.f3d-chips::-webkit-scrollbar,.f3d-watch::-webkit-scrollbar{display:none}
.f3d-q{position:relative;flex:0 0 auto;pointer-events:auto}
.f3d-q input{width:112px;height:30px;border-radius:9px;border:1.5px solid #BFDBFE;background:rgba(255,255,255,.97);padding:0 8px;font:700 12px 'Sarabun',system-ui,sans-serif;color:#0F172A;outline:none;text-transform:uppercase}
.f3d-q input::placeholder{text-transform:none;color:#94A3B8;font-weight:600}
.f3d-q input:focus{border-color:#1A56DB;box-shadow:0 0 0 3px rgba(26,86,219,.16)}
.f3d-sug{position:absolute;top:34px;left:0;min-width:150px;max-height:200px;overflow:auto;background:#fff;border:1px solid #CBD5E1;border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.2);z-index:8;display:none;touch-action:pan-y}
.f3d-sug.on{display:block}
.f3d-sug button{display:flex;width:100%;gap:6px;align-items:center;border:0;background:none;padding:8px 10px;font:800 12.5px 'Courier New',monospace;color:#0F172A;cursor:pointer;text-align:left}
.f3d-sug button:hover,.f3d-sug button:focus{background:#EBF4FF;outline:none}
.f3d-sug .no{padding:9px 10px;font-size:12px;color:#64748B;font-weight:700}
.f3d-c{flex:0 0 auto;height:30px;border-radius:999px;border:1.5px solid #E2E8F0;background:rgba(255,255,255,.95);padding:0 10px;font:800 11.5px 'Sarabun',system-ui,sans-serif;color:#334155;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
.f3d-c .n{font-size:10px;font-weight:900;color:#64748B}
.f3d-c.on{background:#1A56DB;border-color:#1A56DB;color:#fff}.f3d-c.on .n{color:#DBEAFE}
.f3d-c:disabled{opacity:.45;cursor:default}
.f3d-b{pointer-events:auto;width:36px;height:36px;border-radius:10px;border:1.5px solid #DBEAFE;background:rgba(255,255,255,.96);color:#1E3A8A;font:900 16px/1 'Sarabun',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(30,58,138,.16);cursor:pointer;padding:0;direction:ltr}
.f3d-b:active{transform:scale(.94)}
.f3d-b.on{background:#1A56DB;border-color:#1A56DB;color:#fff}
.f3d-bot{position:absolute;left:8px;right:8px;bottom:8px;z-index:3;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.f3d-w{flex:0 0 auto;height:34px;border-radius:10px;background:rgba(255,255,255,.96);border:1.5px solid #E2E8F0;display:flex;align-items:center;gap:6px;padding:0 9px 0 5px;font:800 11.5px 'Sarabun',system-ui,sans-serif;color:#0F172A;cursor:pointer;white-space:nowrap;box-shadow:0 1px 4px rgba(30,58,138,.12)}
.f3d-w .ic{min-width:21px;height:21px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font:900 11px/1 Arial,sans-serif;color:#fff;background:#DC2626;padding:0 3px}
.f3d-w.warn .ic{background:#EA580C}.f3d-w.off .ic{background:#4B5563}
.f3d-w .m{font-family:'Courier New',monospace;font-weight:900}
.f3d-w .x{font-size:10.5px;color:#64748B;font-weight:800}
.f3d-w .s{font-size:12px}
.f3d-w.hd{background:#0F172A;border-color:#0F172A;color:#fff;cursor:default}
.f3d-ban{position:absolute;left:50%;z-index:4;transform:translateX(-50%);display:none;align-items:center;gap:8px;max-width:calc(100% - 100px);background:rgba(15,23,42,.88);color:#fff;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:800;box-shadow:0 4px 14px rgba(15,23,42,.25);pointer-events:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f3d-ban.on{display:flex}
.f3d-ban.pend{background:rgba(255,255,255,.96);color:#334155;border:1.5px dashed #94A3B8}
.f3d-ban button{border:0;border-radius:999px;background:#fff;color:#1E3A8A;font:900 11px 'Sarabun',system-ui,sans-serif;padding:3px 10px;cursor:pointer}
.f3d-tl{display:none;pointer-events:auto;align-items:center;gap:6px;background:rgba(255,255,255,.97);border:1.5px solid #BFDBFE;border-radius:12px;padding:5px 8px;box-shadow:0 2px 8px rgba(30,58,138,.15);touch-action:pan-x}
.f3d-tl.on{display:flex}
.f3d-tl input[type=range]{flex:1 1 auto;min-width:60px;accent-color:#1A56DB;height:28px}
.f3d-tl .t{font-size:12px;font-weight:900;color:#1E3A8A;white-space:nowrap;min-width:76px;text-align:center;font-variant-numeric:tabular-nums}
.f3d-tl .f3d-b{width:32px;height:32px;font-size:14px;box-shadow:none}
.f3d-stats{position:absolute;left:8px;bottom:56px;z-index:4;max-width:calc(100% - 64px);background:rgba(15,23,42,.88);color:#E2E8F0;border-radius:10px;padding:6px 8px;font:600 10px/1.45 ui-monospace,Menlo,Consolas,monospace;pointer-events:auto;touch-action:manipulation}
.f3d-stats pre{margin:0;white-space:pre-wrap;font:inherit}
.f3d-stats .sb{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}
.f3d-stats button{border:0;border-radius:7px;background:#334155;color:#fff;font:800 11px 'Sarabun',system-ui,sans-serif;padding:4px 9px;cursor:pointer}
.f3d-hint{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);z-index:4;background:rgba(15,23,42,.85);color:#fff;font-size:11.5px;font-weight:700;padding:6px 12px;border-radius:999px;white-space:nowrap;pointer-events:none;transition:opacity .6s;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}
.f3d-hint.out{opacity:0}
.f3d-sheet{position:absolute;left:0;right:0;bottom:0;z-index:6;max-height:66%;background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -10px 30px rgba(15,23,42,.24);transform:translateY(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column;pointer-events:auto}
.f3d-sheet.on{transform:none}
.f3d-sheet.drag{transition:none}
.f3d-sh-grip{height:20px;flex:0 0 auto;display:flex;justify-content:center;align-items:center;cursor:grab;touch-action:none}
.f3d-sh-grip::before{content:'';width:44px;height:5px;border-radius:9px;background:#CBD5E1}
.f3d-sh-x{position:absolute;top:8px;right:10px;width:32px;height:32px;border-radius:9px;border:1px solid #E2E8F0;background:#F8FAFC;font-size:15px;font-weight:900;color:#334155;cursor:pointer;z-index:1}
.f3d-sh-bd{overflow:auto;padding:0 14px 14px;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain}
.f3d-load{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;gap:8px;background:#D9E3F0;color:#1E3A8A;font-weight:800;font-size:13px;transition:opacity .35s}
.f3d.ready .f3d-load{opacity:0;pointer-events:none}
.f3d-fade{position:absolute;inset:0;z-index:2;background:#D9E3F0;opacity:0;pointer-events:none;transition:opacity .25s}
.f3d-fade.on{opacity:1}
@media (prefers-reduced-motion:reduce){.f3d-pin .pn,.f3d-sos .r,.f3d-lmp{animation:none}.f3d-sheet{transition:none}}
`;
function injectCss() {
  if (document.getElementById('f3dCss')) return;
  const s = document.createElement('style'); s.id = 'f3dCss'; s.textContent = CSS; document.head.appendChild(s);
}

/* ── รวม geometry หลายชิ้นเป็นก้อนเดียว + จำช่วงจุดยอดของแต่ละชิ้น (ไว้เปลี่ยนสีทีหลัง) ── */
function mergeParts(list) {
  let nv = 0, ni = 0;
  for (const p of list) { const n = p.g.attributes.position.count; nv += n; ni += p.g.index ? p.g.index.count : n; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const p of list) {
    const g = p.g, n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    p.start = vo; p.count = n;
    if (g.index) { const a = g.index.array; for (let k = 0; k < a.length; k++) idx[io++] = a[k] + vo; }
    else for (let k = 0; k < n; k++) idx[io++] = vo + k;
    vo += n;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const ca = new THREE.BufferAttribute(col, 3); ca.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('color', ca);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}
// ชิ้นส่วนคงที่ (พื้นโซน/ทางเดิน/ของประกอบฉาก) — สีฝังตอนรวม ไม่เปลี่ยนอีก
function mergeStatic(list) {
  const geo = mergeParts(list);
  const arr = geo.attributes.color.array, c = new THREE.Color();
  for (const p of list) { c.set(p.c); for (let i = p.start * 3, e = (p.start + p.count) * 3; i < e; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; } }
  return freeAfterUpload(geo, ['position', 'normal', 'color']);
}
/* ส่งขึ้น GPU แล้วไม่ต้องเก็บสำเนาใน JS (ไม่ได้ raycast mesh — แตะเครื่องใช้กล่อง AABB เอง · bounding sphere คิดไว้ก่อนแล้ว)
   ❗สีของเครื่อง (color ของ mesh เครื่อง) ห้ามปล่อย — ต้องเขียนใหม่ตอนสถานะเปลี่ยน */
function freeArray() { this.array = null; }
function freeAfterUpload(geo, names) {
  for (const n of names) if (geo.attributes[n]) geo.attributes[n].onUpload(freeArray);
  if (geo.index) geo.index.onUpload(freeArray);
  return geo;
}
function roundRectShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
// แผ่นเรียบบนพื้น (ShapeGeometry วางแนว XZ) — ต้นแบบตามขนาด แล้ว clone
function flatRR(w, d, r, y) {
  const g = cachedGeo(`f${q4(w)}|${q4(d)}|${r}`, () => { const s = new THREE.ShapeGeometry(roundRectShape(q4(w), q4(d), r), 3); s.rotateX(-Math.PI / 2); return s; });
  g.translate(0, y, 0); return g;
}

/* ── โมเดลเครื่องจักร (สร้างจากโค้ด ไม่ใช้ไฟล์ .glb) ──
   กรอบของเครื่อง: แกนยาว = x · หน้าเครื่อง = +z · พื้น y = 0 → หมุน/ย้ายไปตำแหน่งจริงทีหลัง
   role: st = สีสถานะ (แผ่นฐาน + แผงบน) · lamp = ไฟสถานะ · body/blue/steel/glass/scr/dark = สีประจำชิ้น */
function machineParts(L, S, kind) {
  const out = [];
  let ymax = 0;
  const add = (g, x, y, z, role) => { g.translate(x, y, z); g.computeBoundingBox(); ymax = Math.max(ymax, g.boundingBox.max.y); out.push({ g, role }); return g; };
  const s = clamp(S, 12, 60);
  const BH = 2.4;
  add(rbox(L - 1.2, BH, S - 1.2, Math.min(3, S * .12), 1), 0, BH / 2, 0, 'st');
  const pad = clamp(S * .12, 1.5, 4.5);
  const cabL = clamp(L * .2, 4.5, 16), cabS = clamp(S * .55, 4.5, 20);
  const bodyL = Math.max(4, L - pad * 2 - cabL - 1.2), bodyS = Math.max(4, S - pad * 2);
  const Hb = clamp(s * ({ G: .62, L: .42, H: .55, W: .85, N: .5, X: .6 }[kind]), 7, 30);
  const ub = -L / 2 + pad + bodyL / 2, uc = L / 2 - pad - cabL / 2;
  const top = BH + Hb;
  add(rbox(bodyL, Hb, bodyS, Math.min(3.2, Math.min(bodyL, bodyS, Hb) * .18), 2), ub, BH + Hb / 2, 0, 'body');
  add(rbox(Math.max(2, bodyL - 2.4), 1.4, Math.max(2, bodyS - 2.4), .6, 1), ub, top + .5, 0, 'st');            // แผงบน
  const Hc = Math.max(8, Hb * 1.08), cz = (bodyS - cabS) / 2;
  add(rbox(cabL, Hc, cabS, Math.min(1.6, cabL * .2), 1), uc, BH + Hc / 2, cz, 'blue');                            // ตู้คอนโทรล
  add(box(cabL * .62, Hc * .3, .5), uc, BH + Hc * .66, cz + cabS / 2 + .2, 'scr');            // จอตู้
  if (kind === 'G') {                                   // เจียร: ฝาครอบหินเจียรครึ่งวงกลม + หัวมอเตอร์
    const rg = clamp(bodyS * .34, 2.5, 10), gd = cyl(rg, rg, bodyS * .62, 14, Math.PI / 2, Math.PI);
    gd.rotateX(Math.PI / 2);
    add(gd, ub - bodyL * .14, top + .3, 0, 'steel');
    add(rbox(Math.max(2.5, bodyL * .22), rg * .9, bodyS * .42, .8, 1), ub + bodyL * .22, top + rg * .45, -bodyS * .12, 'body');
  } else if (kind === 'L') {                            // กลึง: แท่นยาว + หัวเครื่อง + หัวจับ + ท้ายแท่น
    const hsL = Math.max(3, bodyL * .24), hsH = Hb * .9;
    add(rbox(hsL, hsH, bodyS * .82, .8, 1), ub - bodyL / 2 + hsL / 2, top + hsH / 2, 0, 'body');
    const cr = clamp(Math.min(bodyS * .22, hsH * .45), 1.5, 6), ch = cyl(cr, cr, 2.6, 14);
    ch.rotateZ(Math.PI / 2);
    add(ch, ub - bodyL / 2 + hsL + 1.3, top + hsH * .5, 0, 'dark');
    add(rbox(Math.max(2, bodyL * .1), hsH * .55, bodyS * .5, .5, 1), ub + bodyL / 2 - Math.max(2, bodyL * .1) / 2 - .4, top + hsH * .275, 0, 'steel');
  } else if (kind === 'H') {                            // induction: หอขดลวดสูง
    const tr = clamp(Math.min(bodyL, bodyS) * .2, 2, 7), th = Hb * 1.15, tx = ub + bodyL * .12;
    add(cyl(tr, tr, th, 14), tx, top + th / 2, 0, 'body');
    const coil = cachedGeo(`t${q4(tr)}`, () => new THREE.TorusGeometry(q4(tr) * 1.4, q4(tr) * .32, 6, 18)); coil.rotateX(Math.PI / 2);
    add(coil, tx, top + th * .5, 0, 'blue');
    add(cyl(tr * 1.12, tr * 1.12, 1.6, 14), tx, top + th + .8, 0, 'blue');
  } else if (kind === 'W') {                            // ตู้ปิดมีหน้าต่าง
    add(box(bodyL * .55, Hb * .42, .5), ub, BH + Hb * .55, bodyS / 2 + .2, 'glass');
  } else if (kind === 'N') {                            // ลูกกลิ้ง 2 ลูก
    const rr = clamp(bodyS * .14, 1.2, 4);
    for (const v of [-bodyS * .22, bodyS * .22]) { const c = cyl(rr, rr, bodyL * .82, 12); c.rotateZ(Math.PI / 2); add(c, ub, top + rr * .85, v, 'dark'); }
  } else {
    add(box(bodyL * .42, Hb * .3, .5), ub, BH + Hb * .6, bodyS / 2 + .2, 'glass');
  }
  // ไฟสถานะ (เสา + โคม) มุมหลังซ้ายของตัวเครื่อง
  const ph = clamp(s * .3, 5, 11), lr = clamp(s * .055, 1.1, 2.2);
  const px = ub - bodyL / 2 + lr + .8, pz = -bodyS / 2 + lr + .8;
  add(cyl(.55, .55, ph, 6), px, top + ph / 2, pz, 'steel');
  add(cyl(lr, lr, lr * 1.8, 12), px, top + ph + lr * .9, pz, 'lamp');
  return { parts: out, ymax, lamp: new THREE.Vector3(px, top + ph + lr * 1.8 + 1.5, pz) };
}

/* ── สีตามบทบาทชิ้นส่วน × สถานะ (เก็บเป็น cache — สร้าง Color ครั้งเดียวต่อชุด) ── */
const _rc = new Map();
function roleColors(st, sos, dim) {
  const key = st + (sos ? 's' : '') + (dim ? 'd' : '');
  let o = _rc.get(key);
  if (o) return o;
  const off = st === 'off', pend = st === 'pend';
  const hex = {
    st: st === 'good' ? COL.good : st === 'warn' ? COL.warn : off ? COL.off : COL.pend,
    lamp: sos ? COL.lampSos : st === 'good' ? COL.lampGood : st === 'warn' ? COL.lampWarn : pend ? COL.lampPend : COL.lampOff,
    body: off ? COL.bodyOff : COL.body,
    blue: off ? COL.blueOff : pend ? COL.steel : COL.blue,
    steel: off ? COL.steelOff : COL.steel,
    glass: off ? COL.glassOff : COL.glass,
    scr: off ? 0x111827 : COL.scr,
    dark: off ? 0x374151 : COL.dark,
  };
  o = {};
  const dc = new THREE.Color(COL.floor);
  for (const k in hex) { const c = new THREE.Color(hex[k]); if (dim) c.lerp(dc, .72); o[k] = c; }
  _rc.set(key, o);
  return o;
}

export function create(host, opts = {}) {
  injectCss();
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;
  // มือถือ (นิ้วสัมผัส + จอเล็ก): ความละเอียดเริ่ม 1.5 เท่า (แทน 2) · เงา 1024 (หน่วยความจำกราฟิก 4 MB แทน 16 MB)
  //   วัดบนมือถือจำลอง (CPU ช้า 4 เท่า + GPU รุ่นเล็ก): ลากผังที่ 2 เท่า ≈ 30 fps
  const phone = matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 820;
  const DPR_KEY = 'vsm4_3d_dpr', dprCap = Math.min(window.devicePixelRatio || 1, 2);
  const dprBase = Math.min(dprCap, lowEnd ? 1.25 : phone ? 1.5 : 2);
  let dpr = (() => { let v = 0; try { v = +localStorage.getItem(DPR_KEY); } catch (e) {} return v >= 1 && v <= 2 ? Math.min(v, dprCap) : dprBase; })();
  // ⚡ โหมดประหยัด (เครื่องอ่อนมาก): ไม่มีเงา + วัสดุเบา (Lambert) — เปิดเองเมื่อความละเอียดต่ำสุดแล้วยังช้า · จำค่าในเครื่อง
  const LITE_KEY = 'vsm4_3d_lite';
  let lite = (() => { try { return localStorage.getItem(LITE_KEY) === '1'; } catch (e) { return false; } })();
  const root = el('div', 'f3d');
  root.innerHTML = `<canvas class="f3d-cv"></canvas><div class="f3d-lbl"></div><div class="f3d-fade"></div>
    <div class="f3d-top"><div class="f3d-row"><div class="f3d-q"><input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"><div class="f3d-sug"></div></div><div class="f3d-chips"></div></div></div>
    <div class="f3d-ban"></div>
    <div class="f3d-bot"><div class="f3d-tl"></div><div class="f3d-watch"></div></div>
    <div class="f3d-sheet" aria-hidden="true"><div class="f3d-sh-grip"></div><button type="button" class="f3d-sh-x" aria-label="close">✕</button><div class="f3d-sh-bd"></div></div>
    <div class="f3d-load"><span class="spinner"></span><span class="t"></span></div>`;
  host.appendChild(root);
  const $ = s => root.querySelector(s);
  const canvas = $('.f3d-cv'), lblLayer = $('.f3d-lbl'), chipsEl = $('.f3d-chips'), qIn = $('.f3d-q input'), sugEl = $('.f3d-sug');
  const banEl = $('.f3d-ban'), tlEl = $('.f3d-tl'), watchEl = $('.f3d-watch'), sheetEl = $('.f3d-sheet'), sheetBd = $('.f3d-sh-bd');
  const topEl = $('.f3d-top'), botEl = $('.f3d-bot'), fadeEl = $('.f3d-fade');
  let S = opts.S || {};
  $('.f3d-load .t').textContent = S.building || 'Loading 3D…';

  /* ── renderer / scene / camera ── */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = !lite;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;               // ฉากนิ่ง → วาดเงาใหม่เฉพาะตอนฉากเปลี่ยน
  renderer.setClearColor(COL.bg, 1);
  // ไม่ดึง log ของ shader ทุกครั้ง (ทำให้ต้องรอ compile จบแบบ sync ~200 ms ตอนเปิด) · shader ชุดนี้ตรวจแล้วว่า compile ผ่าน
  renderer.debug.checkShaderErrors = false;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
  const labels = new CSS2DRenderer({ element: lblLayer });
  labels.sortObjects = false;                          // ไม่ต้องเรียง z ทุกเฟรม (ป้ายไม่ค่อยทับกัน · หมุด/โซนอยู่บนสุดด้วย CSS)
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = .14;
  controls.zoomToCursor = true;
  controls.minPolarAngle = 0; controls.maxPolarAngle = 1.36;     // ≥ 12° เหนือพื้นเสมอ (กันกล้องมุดพื้น)
  controls.rotateSpeed = .6; controls.zoomSpeed = 1.15;

  // แสง: ฟ้า (hemisphere) อ่อนลง + แดดเฉียงแรงขึ้น → ด้านข้างเครื่องมีมิติ + เงานุ่มบนพื้นเห็นชัด (ไม่มี tone mapping — สีสถานะตรงตามค่า)
  const hemi = new THREE.HemisphereLight(0xFFFFFF, 0x9DB0CC, 1.55);
  const sun = new THREE.DirectionalLight(0xFFFFFF, 2.5);
  sun.castShadow = !lite;
  const smap = lowEnd || phone ? 1024 : 2048;
  sun.shadow.mapSize.set(smap, smap);
  sun.shadow.radius = 3; sun.shadow.bias = -0.0006; sun.shadow.normalBias = .6;
  scene.add(hemi, sun, sun.target);

  const mats = {
    std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .62, metalness: 0 }),
    lam: new THREE.MeshLambertMaterial({ vertexColors: true }),
    lamp: new THREE.MeshBasicMaterial({ vertexColors: true }),
    ghost: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: .3, depthWrite: false }),
    ghostLamp: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .3, depthWrite: false }),
    flat: new THREE.MeshLambertMaterial({ vertexColors: true }),
    floor: new THREE.MeshLambertMaterial({ color: COL.floor }),
    floorSide: new THREE.MeshLambertMaterial({ color: COL.floorSide }),
    grid: new THREE.LineBasicMaterial({ color: COL.grid, transparent: true, opacity: .9 }),
    vest: new THREE.MeshLambertMaterial({ color: COL.vest }),
    helmet: new THREE.MeshLambertMaterial({ color: COL.helmet }),
    sel: new THREE.MeshBasicMaterial({ color: COL.sel, transparent: true, opacity: .85, depthWrite: false }),
  };

  /* ── สถานะภายใน ── */
  let P = null, Plive = null;                 // ชุดข้อมูลที่แสดงอยู่ / ชุดสดจากแอป (โหมดย้อนดูใช้ P คนละชุด)
  let layoutKey = '';
  let lay = null;                             // ของที่ผูกกับ layout (สร้างใหม่เมื่อสลับสาย)
  let machines = [], byId = new Map(), lines = [], lineById = new Map();
  const mm = { solid: null, solidLamp: null, ghost: null, ghostLamp: null };
  let people = [], pplMesh = null, headMesh = null;
  let filter = 'all', selId = '', sheetOpen = false;
  let size = { w: 0, h: 0 }, sized = false, live = false, fitted = false, disposed = false;
  let camAuto = false;                        // กล้องยังอยู่มุมเริ่มที่จัดให้ (ยังไม่ลาก/ซูม/บินไปเครื่อง) → กรอบเปลี่ยนขนาดแล้วจัดใหม่ได้
  let raf = 0, shadowDirty = true, tw = null, lv = -1, lzOn = null;
  const colorAnim = new Set();
  const dirty = new Map();                    // mesh → [min, max] ช่วงจุดยอดที่สีเปลี่ยน
  let tl = null;                              // โหมดย้อนดูทีละกะ
  // ★ v3.99 ป้ายชื่อ (ป้ายโซน + ป้ายไลน์ + เลขเครื่อง) ซ่อนได้จากปุ่ม 📛 ป้ายชื่อ ของการ์ด (ผู้ใช้ 28/10: ป้ายเยอะเกิน)
  //   ซ่อนแล้วยังเห็น: หมุด TOP · SOS · ป้ายของเครื่องที่แตะเลือก
  let showLbl = opts.labels !== false;
  let isoView = { theta: VIEW0.theta, phi: VIEW0.phi };
  const lim = { minX: -500, maxX: 500, minZ: -500, maxZ: 500 };
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s3 = new THREE.Vector3();

  /* ── render loop (วาดเฉพาะเมื่อจำเป็น) ── */
  let building = false;                        // กำลังสร้างฉากเป็นช่วง ๆ (buildLayout) → ยังไม่วาด
  function kick() { if (!raf && live && sized && !disposed && !compiling && !building) raf = requestAnimationFrame(frame); }
  // เปิดครั้งแรก: compile shader แบบไม่บล็อกหน้าจอ (KHR_parallel_shader_compile) ก่อนวาดเฟรมแรก — ระหว่างนี้ขึ้น "กำลังสร้างผัง 3D…"
  let compiling = false, compiled = false;
  function warmShaders() {
    if (compiled || compiling || !renderer.compileAsync) return;
    compiling = true;
    const done = () => { if (!compiling) return; compiling = false; compiled = true; kick(); };
    renderer.compileAsync(scene, camera).catch(() => {}).finally(done);
    setTimeout(done, 4000);                       // กันไดรเวอร์บางรุ่นตอบช้า/ไม่ตอบ → วาดต่อเลย
  }
  /* ความละเอียดปรับเอง: ระหว่างวาดต่อเนื่อง (ลาก/บิน/animation) วัดช่วงห่างเฟรม 45 เฟรม
     ช้ากว่า ~38 fps → ลดทีละ 0.25 (ต่ำสุด 1) · เร็วมาก (< 9 ms = จอ 120 Hz มีที่เหลือ) → เพิ่มคืน · จำค่าไว้ในเครื่องนี้ */
  let lastFT = 0, dprTry = null, liteTry = null, cpuBound = false;
  const fts = [];
  const setDpr = v => { dpr = v; renderer.setPixelRatio(dpr); renderer.setSize(size.w, size.h, false); try { localStorage.setItem(DPR_KEY, String(dpr)); } catch (e) {} };
  function litMat() { return lite || lowEnd ? mats.lam : mats.std; }
  // เปิด/ปิดโหมดประหยัด — เปลี่ยนเงา = shader ต้อง compile ใหม่ (ครั้งเดียว)
  function setLite(on) {
    if (lite === on) return;
    lite = on;
    renderer.shadowMap.enabled = !on; sun.castShadow = !on;
    if (mm.solid) mm.solid.material = litMat();
    for (const k in mats) mats[k].needsUpdate = true;
    shadowDirty = true;
    try { if (on) localStorage.setItem(LITE_KEY, '1'); else localStorage.removeItem(LITE_KEY); } catch (e) {}
    if (statsEl) statsTick(performance.now(), true);
    kick();
  }
  function trackFrame(now) {
    if (lastFT && now - lastFT < 120) fts.push(now - lastFT);
    lastFT = now;
    if (fts.length < 45) return;
    const s = fts.slice().sort((a, b) => a - b), med = s[s.length >> 1];
    fts.length = 0;
    // ลดความละเอียด/เปิดโหมดประหยัดไปรอบก่อน — เร็วขึ้นจริงไหม · ไม่ (ช้าที่ CPU ไม่ใช่การ์ดจอ: วัดบนมือถือจำลองลดถึง 1 เท่าแล้วยัง 33 ms)
    //   → คืนคุณภาพ + เลิกลดในรอบนี้ (ลดไปก็เบลอ/ไม่มีเงาเปล่า ๆ)
    if (dprTry) { if (med > dprTry.med * .85) { setDpr(dprTry.from); cpuBound = true; } dprTry = null; return; }
    if (liteTry) { if (med > liteTry.med * .85) { setLite(false); cpuBound = true; } liteTry = null; return; }
    // ลื่น 60 fps แล้ว (< 15 ms) แต่ต่ำกว่าค่าตั้งต้นของเครื่อง = เคยลดเพราะช่วงเครื่องยุ่ง → คืนทีละขั้น
    const up = (med < 15 && dpr < dprBase) || (med < 9 && dpr < dprCap);
    if (med > 26 && !cpuBound) {
      if (dpr > 1) { dprTry = { from: dpr, med }; setDpr(Math.max(1, dpr - .25)); }
      else if (!lite) { liteTry = { med }; setLite(true); }                       // ความละเอียดต่ำสุดแล้วยังช้า → โหมดประหยัด
    } else if (up) setDpr(Math.min(dprCap, dpr + .25));
  }
  // หลังปล่อยนิ้ว: ตัดแรงเฉื่อยตอนที่ภาพขยับน้อยกว่า ~0.1 px/เฟรม (เดิมวาดต่ออีก 1–2 วิ จนค่าเล็กระดับ 1e-6 = เปลืองแบต)
  const _pp = new THREE.Vector3(), _pt = new THREE.Vector3();
  let _pz = 1, dragging = false;
  controls.addEventListener('start', () => { dragging = true; camAuto = false; });
  controls.addEventListener('end', () => { dragging = false; });
  /* 📊 ตัววัดความลื่นบนเครื่องจริง (?fps=1) — ให้คนในโรงงานกด 📋 คัดลอกตัวเลข + รุ่นเครื่องส่งกลับมาได้ */
  const t0Create = performance.now();
  let statsEl = null, statsLast = 0, statsIdleT = 0, statsPrevT = 0, firstFrameMs = 0, lastBuildMs = 0, gpuName = '';
  const statsIv = [], statsCpu = [];
  if (opts.fps) {
    statsEl = el('div', 'f3d-stats', '<pre></pre><div class="sb"><button type="button" data-s="copy">📋 คัดลอก</button><button type="button" data-s="lite"></button></div>');
    root.appendChild(statsEl);
    statsEl.addEventListener('click', e => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      if (b.dataset.s === 'lite') { cpuBound = false; liteTry = null; setLite(!lite); return; }
      const t = statsEl.querySelector('pre').textContent + '\n' + navigator.userAgent + '\nscreen ' + screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1);
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => flash(S.copied || 'Copied'), () => flash(S.copyFail || 'Copy failed'));
    });
    try { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); gpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) {}
  }
  function statsTick(now, force, fromIdle) {
    if (!statsEl) return;
    // ทุกเฟรมเลื่อนเวลา "นิ่ง" ออกไป → หยุดวาด 0.7 วิ = ขึ้นว่านิ่ง (อัปเดตตัวเลขแค่ทุก 0.5 วิ)
    if (!fromIdle) { clearTimeout(statsIdleT); statsIdleT = setTimeout(() => statsTick(performance.now(), true, true), 700); }
    if (!force && now - statsLast < 500) return;
    statsLast = now;
    const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
    const iv = statsIv.slice().sort((a, b) => a - b), cpu = statsCpu.slice().sort((a, b) => a - b), med = q(iv, .5);
    statsIv.length = 0; statsCpu.length = 0;
    const c = renderer.domElement, gl = renderer.getContext(), samples = gl.getContextAttributes().antialias ? 4 : 1, ri = renderer.info.render;
    let geo = 0;
    scene.traverse(o => { const g = o.geometry; if (!g) return; for (const k in g.attributes) { const a = g.attributes[k]; geo += a.array ? a.array.byteLength : a.count * a.itemSize * 4; } if (g.index) geo += g.index.array ? g.index.array.byteLength : g.index.count * 4; });
    const px = c.width * c.height, gpuMB = (px * 4 * 2 + px * samples * 8 + (lite ? 0 : smap * smap * 4) + geo) / 1048576;
    statsEl.querySelector('pre').textContent =
      (iv.length ? `fps ${Math.round(1000 / med)} · เฟรมกลาง ${med.toFixed(0)} ms · p95 ${q(iv, .95).toFixed(0)} ms · CPU ${q(cpu, .5).toFixed(1)} ms` : 'นิ่ง — ไม่วาดเลย (0 fps)') + '\n' +
      `ความละเอียด ${dpr}x (${c.width}×${c.height}) · เงา ${lite ? 'ปิด' : smap} · ประหยัด ${lite ? 'เปิด' : 'ปิด'}${cpuBound ? ' · ช้าที่ CPU' : ''}\n` +
      `${ri.calls} draw · ${(ri.triangles / 1000).toFixed(0)}k tri · GPU ~${gpuMB.toFixed(0)} MB · เห็นผังหลังเข้าจอ ${firstFrameMs ? (firstFrameMs / 1000).toFixed(2) + ' วิ' : '…'} · สร้างฉาก ${(lastBuildMs / 1000).toFixed(2)} วิ` +
      (gpuName ? '\nGPU: ' + gpuName.slice(0, 70) : '');
    statsEl.querySelector('[data-s="lite"]').textContent = lite ? '⚡ ปิดโหมดประหยัด' : '⚡ เปิดโหมดประหยัด';
    if (fromIdle && iv.length) statsIdleT = setTimeout(() => statsTick(performance.now(), true, true), 700);   // ยังมีเฟรมค้างในรอบนี้ → อีกรอบถึงขึ้น "นิ่ง"
  }
  function frame(now) {
    raf = 0;
    if (disposed) return;
    const c0 = performance.now();
    let more = false;
    if (tw) more = stepTween(now);
    else if (controls.update()) {
      const mv = Math.max(camera.position.distanceTo(_pp), controls.target.distanceTo(_pt)) * camera.zoom * size.h / F;
      if (!dragging && mv < .1 && Math.abs(camera.zoom - _pz) < _pz * 2e-4) resetDamping(); else more = true;
    }
    _pp.copy(camera.position); _pt.copy(controls.target); _pz = camera.zoom;
    trackFrame(now);
    clampPan();
    if (colorAnim.size && stepColors(now)) more = true;
    if (people.some(q => q.s !== q.s1) && stepPeople(now)) more = true;
    updateLevels();
    declutterLabels(now, more);
    flushDirty();
    if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
    renderer.render(scene, camera);
    labels.render(scene, camera);
    declutterZones(more);
    if (!root.classList.contains('ready')) {
      root.classList.add('ready');
      firstFrameMs = performance.now() - (t0Visible || t0Create);
      if (!_hinted && S.hint) { _hinted = true; flash(S.hint); }
    }
    if (statsEl) {
      statsCpu.push(performance.now() - c0);
      if (statsPrevT && now - statsPrevT < 120) statsIv.push(now - statsPrevT);
      statsPrevT = now;
      statsTick(now);
    }
    if (more) kick();
  }
  controls.addEventListener('change', kick);
  function clampPan() {
    const t = controls.target;
    const x = clamp(t.x, lim.minX, lim.maxX), z = clamp(t.z, lim.minZ, lim.maxZ), y = clamp(t.y, 0, 60);
    if (x !== t.x || z !== t.z || y !== t.y) { camera.position.x += x - t.x; camera.position.y += y - t.y; camera.position.z += z - t.z; t.set(x, y, z); }
  }

  /* ── ขนาด / มองเห็น ── */
  function measure() {
    const w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) { sized = false; return; }
    sized = true;
    if (w !== size.w || h !== size.h) {
      size = { w, h };
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      const a = w / h;
      camera.left = -F * a / 2; camera.right = F * a / 2; camera.top = F / 2; camera.bottom = -F / 2;
      camera.updateProjectionMatrix();
      layoutHud();
      // ★ v4.04 ยังไม่ได้ขยับกล้องเอง → จัดมุมเริ่มให้พอดีกรอบใหม่ (เช่นกดเต็มจอบนทีวี · เดิมคงซูมเดิม = ผังล้นซ้าย-ขวา ต้องกด ⊙ เอง)
      if (lay && fitted && camAuto) resetView(false);
    }
    if (lay && !fitted) { resetView(false); fitted = true; }
    if (pendingFly && lay) flyPending();
  }
  // วัดขนาด/วาดเฉพาะตอนมองเห็นจริง (การ์ดอยู่นอกจอ = content-visibility ข้ามไว้ อ่านขนาดตอนนั้น = บังคับจัด layout ทั้งการ์ด)
  let ioVis = false, t0Visible = 0;            // t0Visible = ครั้งแรกที่กรอบเข้าจอ (ฉากสร้างล่วงหน้าได้ — นับเวลา "เห็นผัง" จากตรงนี้)
  const ro = new ResizeObserver(() => { if (live) { measure(); kick(); } });
  ro.observe(root);
  const io = new IntersectionObserver(es => {
    ioVis = es[es.length - 1].isIntersecting;
    live = ioVis && !document.hidden;
    if (live && !t0Visible) t0Visible = performance.now();
    if (live) { measure(); layoutHud(); kick(); }
  }, { rootMargin: '60px' });
  io.observe(root);
  function onVis() { live = ioVis && !document.hidden; if (live) { measure(); kick(); } }
  document.addEventListener('visibilitychange', onVis);
  // GPU คืนหน่วยความจำ (แท็บค้างนาน/เครื่องแรมน้อย) → ให้แอปกลับ 2D · ตอนเราปิดเอง (dispose → forceContextLoss) ไม่นับ
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (!disposed && opts.onFail) opts.onFail('lost'); });

  /* ── ชั้น HUD ──
     ★ v3.99 (ผู้ใช้ 28/10: "เยอะเกินไป") เอาแถบ KPI ด้านบน + ปุ่มด้านขวาออก
       ซูม / รีเซ็ตมุมมอง = ปุ่ม − ⊙ + ของการ์ด (zoom / resetView) · หมุน / เอียง = นิ้ว 2 นิ้ว / เมาส์ขวา · รีเฟรช = ปุ่มบนหัวแอป
       ย้อนดูทีละกะ (toggleTimeline) / บันทึกภาพ PNG (savePng · snapshot) ไม่มีปุ่มแล้ว — โค้ดยังอยู่ ถ้าจะใส่กลับในเมนู */
  function hudTitles() {
    qIn.placeholder = S.search || '';
    $('.f3d-sh-x').setAttribute('aria-label', S.close || 'close');
  }
  // แถบแจ้ง (รอข้อมูลจบกะ / ย้อนดู) อยู่ล่างกลาง เหนือแถบ "ต้องดู" — ด้านบนเป็นที่ของป้ายโซน (เดิมทับกัน)
  function layoutHud() {
    hudTop = topEl.offsetHeight + 14;
    banEl.style.bottom = (botEl.offsetHeight + 14) + 'px';
  }

  /* ── สร้างฉากตาม layout ── */
  function clearLayout() {
    closeSheet(true);
    if (!lay) return;
    for (const o of lay.objs) { scene.remove(o); o.geometry && o.geometry.dispose(); }
    for (const o of lay.css) scene.remove(o);
    for (const k in mm) if (mm[k]) { scene.remove(mm[k]); mm[k].geometry.dispose(); mm[k] = null; }
    for (const m of machines) { for (const p of m.parts) p.g.dispose(); if (m.label && m.label.parent) m.label.parent.remove(m.label); }
    for (const o of lay.dyn || []) scene.remove(o);
    if (pplMesh) { scene.remove(pplMesh, headMesh); pplMesh.geometry.dispose(); headMesh.geometry.dispose(); pplMesh = headMesh = null; }
    if (lay.sel) { scene.remove(lay.sel); lay.sel.geometry.dispose(); }
    machines = []; byId = new Map(); lines = []; lineById = new Map(); people = []; colorAnim.clear(); dirty.clear();
    lay = null;
  }
  /* สร้างฉากเป็นช่วง ๆ คืนจังหวะให้หน้าจอระหว่างช่วง (วัดบนมือถือจำลอง CPU ช้า 4 เท่า: เดิมก้อนเดียว 0.8–1.2 วิ = จอค้าง)
     tok เปลี่ยน (สลับสายซ้อน/ปิด 3D) ระหว่างสร้าง = หยุดทันทีที่จุดพัก · คืน false = ถูกยกเลิก */
  const yieldMain = () => new Promise(r => (window.scheduler && scheduler.yield ? scheduler.yield().then(r) : setTimeout(r, 0)));
  async function buildLayout(p, tok) {
    const alive = () => tok === relayTok && !disposed;
    clearLayout();
    layoutKey = p.layoutKey;
    const boxes = (p.boxes || []).filter(b => b.w >= 2 && b.h >= 2), lbs = p.lines || [];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const b of [...boxes, ...lbs]) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    if (!(x1 > x0)) { x0 = 0; y0 = 0; x1 = 100; y1 = 100; }
    const ox = (x0 + x1) / 2, oz = (y0 + y1) / 2, W = x1 - x0, D = y1 - y0, M = 40;
    const toW = (x, y) => [x - ox, y - oz];
    lay = { objs: [], css: [], ox, oz, W, D, M, x0: x0 - ox, z0: y0 - oz, x1: x1 - ox, z1: y1 - oz, zones: new Map(), sel: null };
    const keep = o => { scene.add(o); lay.objs.push(o); return o; };
    const keepCss = o => { scene.add(o); lay.css.push(o); return o; };
    const fw = W + M * 2, fd = D + M * 2;
    // พื้นโรงงาน: แผ่นหนาขอบเข้ม + เส้นตาราง
    const fl = keep(new THREE.Mesh(new THREE.BoxGeometry(fw, 6, fd), [mats.floorSide, mats.floorSide, mats.floor, mats.floorSide, mats.floorSide, mats.floorSide]));
    fl.position.y = -3; fl.receiveShadow = true;
    // เส้นตาราง: ผัง VSM4 = ตามช่องของผัง 2D (35 px) · ผังอื่น = 40 px นับจากมุมผัง
    const gd = p.grid || {}, gx = gd.x || 40, gz = gd.y || 40, gp = [];
    const gox = (gd.ox != null ? gd.ox : x0) - ox, goz = (gd.oy != null ? gd.oy : y0) - oz;
    for (let x = gox - Math.floor((gox + fw / 2) / gx) * gx; x <= fw / 2; x += gx) gp.push(x, .04, -fd / 2, x, .04, fd / 2);
    for (let z = goz - Math.floor((goz + fd / 2) / gz) * gz; z <= fd / 2; z += gz) gp.push(-fw / 2, .04, z, fw / 2, .04, z);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    keep(new THREE.LineSegments(gg, mats.grid));
    // ตารางช่องว่าง (ช่อง 4px) — ใช้หาทางเดิน / มุมวางของ / ฝั่งที่คนยืน
    const C = 4, gx0 = -fw / 2, gz0 = -fd / 2, nx = Math.ceil(fw / C), nz = Math.ceil(fd / C), occ = new Uint8Array(nx * nz);
    const mark = (ax, az, bx, bz, pad) => {
      const i0 = clamp(Math.floor((ax - pad - gx0) / C), 0, nx - 1), i1 = clamp(Math.ceil((bx + pad - gx0) / C), 0, nx);
      const j0 = clamp(Math.floor((az - pad - gz0) / C), 0, nz - 1), j1 = clamp(Math.ceil((bz + pad - gz0) / C), 0, nz);
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) occ[j * nx + i] = 1;
    };
    for (const b of [...boxes, ...lbs]) { const [ax, az] = toW(b.x, b.y); mark(ax, az, ax + b.w, az + b.h, 3); }
    const free = (x, z) => { const i = Math.floor((x - gx0) / C), j = Math.floor((z - gz0) / C); return i >= 0 && j >= 0 && i < nx && j < nz && !occ[j * nx + i]; };
    lay.free = free;
    // พื้นโซน: แผ่นสีอ่อนใต้เครื่องแต่ละเครื่อง (ขยายขอบ → เครื่องที่ติดกันรวมเป็นผืนเดียว) · เครื่องที่ admin ย้ายโซนก็ได้สีโซนจริงของมัน
    const zc = new Map((p.zones || []).map((z, i) => [z.key, { ...z, i }]));
    const pads = [];
    for (const b of boxes) {
      const z = zc.get(b.zone); if (!z) continue;
      const [ax, az] = toW(b.x, b.y), g = flatRR(b.w + 8, b.h + 8, 5, .06 + z.i * .012);
      g.translate(ax + b.w / 2, 0, az + b.h / 2);
      pads.push({ g, c: new THREE.Color(z.color).lerp(new THREE.Color(COL.floor), .76).getHex() });
      const q = lay.zones.get(z.key) || { key: z.key, x0: 1e9, z0: 1e9, x1: -1e9, z1: -1e9, ymax: 0, n: 0 };
      q.x0 = Math.min(q.x0, ax); q.z0 = Math.min(q.z0, az); q.x1 = Math.max(q.x1, ax + b.w); q.z1 = Math.max(q.z1, az + b.h); q.n++;
      lay.zones.set(z.key, q);
    }
    // ทางเดินเหลือง: หาแถบว่างยาว ๆ จากผังจริง (ไม่มีข้อมูลทางเดิน → ไม่วาดเส้นในพื้นที่ที่มีเครื่อง)
    const aisles = findAisles(occ, nx, nz, C, gx0, gz0);
    const aisleParts = [];
    for (const a of aisles) {
      const w = a.x1 - a.x0, d = a.z1 - a.z0, cx = (a.x0 + a.x1) / 2, czz = (a.z0 + a.z1) / 2;
      const surf = new THREE.PlaneGeometry(w - 2, d - 2); surf.rotateX(-Math.PI / 2); surf.translate(cx, .03, czz);
      aisleParts.push({ g: surf, c: COL.aisle });
      const lw = 1.4, vert = d > w;
      for (const sgn of [-1, 1]) {
        const g = vert ? new THREE.PlaneGeometry(lw, d - 3) : new THREE.PlaneGeometry(w - 3, lw);
        g.rotateX(-Math.PI / 2);
        g.translate(vert ? cx + sgn * (w / 2 - 2.2) : cx, .14, vert ? czz : czz + sgn * (d / 2 - 2.2));
        aisleParts.push({ g, c: COL.line });
      }
    }
    if (pads.length || aisleParts.length) {
      const all = [...aisleParts, ...pads];
      const fm = keep(new THREE.Mesh(mergeStatic(all), mats.flat)); fm.receiveShadow = true;
      for (const q of all) q.g.dispose();
    }
    await yieldMain(); if (!alive()) return false;
    // เครื่องจักร (พักทุก 12 เครื่อง)
    const mt = new THREE.Matrix4(), mr = new THREE.Matrix4();
    for (let bi = 0; bi < boxes.length; bi++) {
      if (bi && bi % 12 === 0) { await yieldMain(); if (!alive()) return false; }
      const b = boxes[bi];
      const [ax, az] = toW(b.x, b.y), cx = ax + b.w / 2, czz = az + b.h / 2, alongX = b.w >= b.h;
      const kind = kindOf(b.id), L = alongX ? b.w : b.h, Sh = alongX ? b.h : b.w;
      const mp = machineParts(L, Sh, kind);
      mr.makeRotationY(alongX ? 0 : Math.PI / 2); mt.makeTranslation(cx, 0, czz).multiply(mr);
      for (const q of mp.parts) q.g.applyMatrix4(mt);
      const m = {
        id: b.id, b, kind, cx, cz: czz, w: b.w, d: b.h, ymax: mp.ymax, parts: mp.parts, zone: b.zone || '',
        lamp: mp.lamp.applyMatrix4(mt), aabb: new THREE.Box3(new THREE.Vector3(ax, 0, az), new THREE.Vector3(ax + b.w, mp.ymax, az + b.h)),
        cls: 'solid', d0: null, cur: null, from: null, to: null, t0: 0, label: null, spots: null,
      };
      machines.push(m);
      if (!byId.has(b.id)) byId.set(b.id, m);
    }
    await yieldMain(); if (!alive()) return false;
    // ป้ายไลน์สีเหลือง (VSM3)
    if (lbs.length) {
      const lp = [];
      for (const lb of lbs) {
        const [ax, az] = toW(lb.x, lb.y), g = rbox(lb.w, 1.8, lb.h, 1.2, 1); g.translate(ax + lb.w / 2, .9, az + lb.h / 2);
        lp.push({ g, c: COL.lineLb });
        const e = el('div', 'f3d-ll', esc(lb.id)), o = new CSS2DObject(e); o.position.set(ax + lb.w / 2, 2.5, az + lb.h / 2);
        keepCss(o);
        const L = { id: lb.id, name: lb.name || lb.id, cx: ax + lb.w / 2, cz: az + lb.h / 2, w: lb.w, d: lb.h, ymax: 2,
          aabb: new THREE.Box3(new THREE.Vector3(ax, 0, az), new THREE.Vector3(ax + lb.w, 4, az + lb.h)), el: e };
        lines.push(L); lineById.set(lb.id, L);
      }
      const lm = keep(new THREE.Mesh(mergeStatic(lp), mats.flat)); lm.castShadow = true; lm.receiveShadow = true;
      for (const q of lp) q.g.dispose();
    }
    buildProps(keep, free, fw, fd);
    // คน: InstancedMesh 2 ชิ้น (ตัว + หมวก) — จองไว้ 3 คนต่อเครื่อง
    const cap = Math.max(1, machines.length * 3);
    const bodyG = new THREE.CapsuleGeometry(2.1, 5.6, 3, 8); bodyG.translate(0, 2.1 + 2.8, 0);
    const headG = new THREE.SphereGeometry(2.05, 10, 8); headG.translate(0, 5.6 + 4.2 + 1.7, 0);
    pplMesh = new THREE.InstancedMesh(bodyG, mats.vest, cap); headMesh = new THREE.InstancedMesh(headG, mats.helmet, cap);
    for (const im of [pplMesh, headMesh]) { im.count = 0; im.castShadow = true; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(im); }
    for (const m of machines) m.spots = personSpots(m, free);
    const mins = machines.map(m => Math.min(m.w, m.d)).sort((a, b) => a - b);
    lay.md = mins.length ? mins[Math.floor(mins.length / 2)] : 30;     // ขนาดเครื่องกลาง ๆ ของผัง → ใช้ตัดสินว่าซูมพอให้ขึ้นป้ายหรือยัง
    // ป้ายเลขเครื่อง (CSS2D) — สร้างไว้แต่ยังไม่ใส่ฉาก · declutterLabels() เลือกใส่เฉพาะป้ายที่ควรเห็น (DOM มีแค่ป้ายที่โชว์จริง)
    const seen = new Set();
    for (const m of machines) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const e = el('div', 'f3d-ml'); const o = new CSS2DObject(e); o.center.set(.5, 1); o.position.set(m.cx, m.ymax + 2, m.cz);
      m.label = o; m.lel = e; m.lblOn = false; m.lblDirty = true;
    }
    // ป้ายโซน
    for (const [k, q] of lay.zones) {
      const z = zc.get(k), e = el('div', 'f3d-zs');
      e.style.setProperty('--zc', z.color);
      e.addEventListener('click', ev => { ev.stopPropagation(); focusZone(k); });
      let ym = 0; for (const m of machines) if (m.zone === k) ym = Math.max(ym, m.ymax);
      const o = new CSS2DObject(e); o.center.set(.5, 1); o.position.set((q.x0 + q.x1) / 2, ym + 16, q.z0);
      keepCss(o); q.el = e; q.obj = o;
    }
    // แสง + เงา ให้พอดีผัง
    const span = Math.max(fw, fd);
    sun.position.set(-span * .5, span * .75, span * .42); sun.target.position.set(0, 0, 0);
    const sc = sun.shadow.camera; sc.left = -span * .62; sc.right = span * .62; sc.top = span * .62; sc.bottom = -span * .62; sc.near = 1; sc.far = span * 3; sc.updateProjectionMatrix();
    lim.minX = lay.x0 - M; lim.maxX = lay.x1 + M; lim.minZ = lay.z0 - M; lim.maxZ = lay.z1 + M;
    shadowDirty = true; fitted = false; lv = -1; lzOn = null;
    await yieldMain();
    return alive();
  }

  // แถบว่างยาว ๆ แนวตั้ง/แนวนอน (ช่องว่างกว้าง ≥ 16px ยาว ≥ 30% ของผัง) = ทางเดิน
  function findAisles(occ, nx, nz, C, gx0, gz0) {
    const out = [];
    const scan = (vert) => {
      const nA = vert ? nx : nz, nB = vert ? nz : nx, at = (a, b) => (vert ? occ[b * nx + a] : occ[a * nx + b]);
      const minLen = Math.max(12, Math.floor(nB * .3)), minW = 4, rects = [];
      const runsOf = a => { const r = []; let s = -1; for (let b = 0; b <= nB; b++) { const f = b < nB && !at(a, b); if (f && s < 0) s = b; else if (!f && s >= 0) { if (b - s >= minLen) r.push([s, b]); s = -1; } } return r; };
      const isFree = (a, s, e) => { for (let b = s; b < e; b++) if (at(a, b)) return false; return true; };
      for (let a = 0; a < nA; a++) for (const [s, e] of runsOf(a)) {
        if (a > 0 && isFree(a - 1, s, e)) continue;                 // เริ่มที่ขอบซ้าย/บนของแถบเท่านั้น
        let k = a; while (k + 1 < nA && isFree(k + 1, s, e)) k++;
        const w = k - a + 1;
        if (w >= minW && w <= nA * .45) rects.push({ a0: a, a1: k + 1, b0: s, b1: e, area: w * (e - s) });
      }
      rects.sort((p, q) => q.area - p.area);
      const keep = [];
      for (const r of rects) {
        if (keep.some(q => ovl(r, q) > .3 * Math.min(area(r), area(q)))) continue;
        keep.push(r); if (keep.length >= 8) break;
      }
      for (const r of keep) {
        const a0 = gx0, b0 = gz0;
        out.push(vert ? { x0: a0 + r.a0 * C, x1: a0 + r.a1 * C, z0: b0 + r.b0 * C, z1: b0 + r.b1 * C }
                      : { x0: a0 + r.b0 * C, x1: a0 + r.b1 * C, z0: b0 + r.a0 * C, z1: b0 + r.a1 * C });
      }
    };
    const area = r => (r.a1 - r.a0) * (r.b1 - r.b0);
    const ovl = (p, q) => Math.max(0, Math.min(p.a1, q.a1) - Math.max(p.a0, q.a0)) * Math.max(0, Math.min(p.b1, q.b1) - Math.max(p.b0, q.b0));
    scan(true); scan(false);
    return out;
  }
  // ของประกอบฉาก (ตกแต่งเท่านั้น ไม่ใช่ข้อมูล): พาเลทกล่องที่มุมพื้น · รถเข็นกลางขอบ — วางเฉพาะที่ว่างจริง
  function buildProps(keep, free, fw, fd) {
    const parts = [];
    const spots = [[-1, -1, 'p'], [1, -1, 'p'], [-1, 1, 'p'], [1, 1, 'p'], [0, -1, 'c'], [0, 1, 'c'], [-1, 0, 'c'], [1, 0, 'c']];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [sx, sz, t] of spots) {
      const x = sx * (fw / 2 - 17), z = sz * (fd / 2 - 15);
      let ok = true;
      for (let dx = -14; dx <= 14 && ok; dx += 7) for (let dz = -12; dz <= 12; dz += 6) if (!free(x + dx, z + dz)) { ok = false; break; }
      if (!ok) continue;
      if (t === 'p') {
        const g = rbox(22, 2.2, 18, .5, 1); g.translate(x, 1.1, z); parts.push({ g, c: COL.wood });
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) { const bx = (i % 2 ? 5.2 : -5.2), bz = (i < 2 ? -4 : 4), h = 6 + rnd() * 3, bg = rbox(9.6, h, 7.6, .6, 1); bg.translate(x + bx, 2.2 + h / 2, z + bz); parts.push({ g: bg, c: i % 2 ? COL.kraft : 0xD2AE7A }); }
      } else {
        const g = rbox(20, 2.6, 12, .8, 1); g.translate(x, 3.6, z); parts.push({ g, c: COL.cart });
        for (const [wx, wz] of [[-8, -4.5], [8, -4.5], [-8, 4.5], [8, 4.5]]) { const wg = new THREE.CylinderGeometry(1.3, 1.3, 1, 8); wg.rotateX(Math.PI / 2); wg.translate(x + wx, 1.3, z + wz); parts.push({ g: wg, c: COL.dark }); }
        const hg = new THREE.BoxGeometry(1, 11, 12); hg.translate(x + 10.5, 7.5, z); parts.push({ g: hg, c: COL.steelProp });
        const bg = rbox(12, 6, 9, .6, 1); bg.translate(x - 2, 7.9, z); parts.push({ g: bg, c: COL.kraft });
      }
    }
    if (!parts.length) return;
    const pm = keep(new THREE.Mesh(mergeStatic(parts), mats.flat)); pm.castShadow = true; pm.receiveShadow = true;
    for (const q of parts) q.g.dispose();
  }
  // จุดยืนของคน: ฝั่งของเครื่องที่ว่างที่สุด (ทางเดิน) — ไม่มีฝั่งว่าง = ยืนบนขอบฐานด้านหน้า
  function personSpots(m, free) {
    const hw = m.w / 2, hd = m.d / 2, off = 4.6;
    const sides = [
      { nx: 0, nz: 1, len: m.w }, { nx: 0, nz: -1, len: m.w }, { nx: 1, nz: 0, len: m.d }, { nx: -1, nz: 0, len: m.d },
    ];
    let best = null, bs = -1;
    for (const sd of sides) {
      let sc = 0;
      for (let k = -2; k <= 2; k++) {
        const t = (k / 5) * sd.len;
        const x = m.cx + (sd.nx ? sd.nx * (hw + off) : t), z = m.cz + (sd.nz ? sd.nz * (hd + off) : t);
        if (free(x, z)) sc++;
      }
      if (sd.nz === 1) sc += .5;                                   // เท่ากัน = เลือกด้านหน้า (เห็นจากกล้องตั้งต้น)
      if (sc > bs) { bs = sc; best = sd; }
    }
    const inside = bs < 2;
    const sp = [];
    for (let k = 0; k < 3; k++) {
      const t = (k === 0 ? 0 : k === 1 ? -1 : 1) * Math.min(5.2, best.len / 3.2);
      const o = inside ? -2.4 : off;
      sp.push(new THREE.Vector3(
        m.cx + (best.nx ? best.nx * (hw + o) : t), inside ? 2.4 : 0, m.cz + (best.nz ? best.nz * (hd + o) : t)));
    }
    return sp;
  }

  /* ── mesh ของเครื่อง: รวมเป็นก้อนตามกลุ่ม (ทึบ / โปร่งแสง = รอข้อมูล) × (ผิวปกติ / ไฟสถานะ) ── */
  function rebuildMachineMeshes() {
    for (const k in mm) if (mm[k]) { scene.remove(mm[k]); mm[k].geometry.dispose(); mm[k] = null; }
    const L = { solid: [], solidLamp: [], ghost: [], ghostLamp: [] };
    for (const m of machines) for (const p of m.parts) L[m.cls + (p.role === 'lamp' ? 'Lamp' : '')].push(p);
    const mk = { solid: litMat(), solidLamp: mats.lamp, ghost: mats.ghost, ghostLamp: mats.ghostLamp };
    for (const k in L) {
      if (!L[k].length) continue;
      const mesh = new THREE.Mesh(freeAfterUpload(mergeParts(L[k]), ['position', 'normal']), mk[k]);
      if (k === 'solid') { mesh.castShadow = true; mesh.receiveShadow = true; }
      if (k === 'ghost' || k === 'ghostLamp') mesh.renderOrder = 2;
      for (const p of L[k]) p.mesh = mesh;
      scene.add(mesh); mm[k] = mesh;
    }
    for (const m of machines) paintMachine(m);
    shadowDirty = true;
  }
  function paintMachine(m) {
    const cs = m.cur;
    for (const p of m.parts) {
      const c = cs[p.role]; if (!c || !p.mesh) continue;
      const arr = p.mesh.geometry.attributes.color.array;
      for (let i = p.start * 3, e = (p.start + p.count) * 3; i < e; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
      const d = dirty.get(p.mesh);
      if (d) { d[0] = Math.min(d[0], p.start); d[1] = Math.max(d[1], p.start + p.count); } else dirty.set(p.mesh, [p.start, p.start + p.count]);
    }
  }
  function flushDirty() {
    for (const [mesh, [a, b]] of dirty) {
      const at = mesh.geometry.attributes.color;
      at.clearUpdateRanges(); at.addUpdateRange(a * 3, (b - a) * 3); at.needsUpdate = true;
    }
    dirty.clear();
  }
  function cloneCols(o) { const r = {}; for (const k in o) r[k] = o[k].clone(); return r; }
  function setColors(m, target, animate) {
    if (!m.cur) { m.cur = cloneCols(target); paintMachine(m); return; }
    if (!animate) { for (const k in target) m.cur[k].copy(target[k]); paintMachine(m); colorAnim.delete(m); return; }
    m.from = cloneCols(m.cur); m.to = target; m.t0 = performance.now(); colorAnim.add(m);
  }
  function stepColors(now) {
    for (const m of colorAnim) {
      const k = clamp((now - m.t0) / 520, 0, 1), e = ease(k);
      for (const r in m.to) m.cur[r].lerpColors(m.from[r], m.to[r], e);
      paintMachine(m);
      if (k >= 1) colorAnim.delete(m);
    }
    return colorAnim.size > 0;
  }

  /* ── คน (ตามรหัสพนักงานไม่ซ้ำใน record ของเครื่อง · สูงสุด 3 ตัว) ── */
  function setPeople(animate) {
    const want = new Map();
    for (const m of machines) {
      if (m !== byId.get(m.id)) continue;
      const d = P.mc[m.id]; const n = d && d.ppl ? Math.min(3, d.ppl.length) : 0;
      for (let k = 0; k < n; k++) want.set(m.id + '#' + k, m.spots[k]);
    }
    const now = performance.now();
    for (const q of people) {
      if (want.has(q.key)) { q.pos.copy(want.get(q.key)); q.s0 = q.s; q.s1 = 1; q.t0 = now; want.delete(q.key); }
      else if (q.s1 !== 0) { q.s0 = q.s; q.s1 = 0; q.t0 = now; }
    }
    for (const [key, pos] of want) people.push({ key, pos: pos.clone(), s: animate ? 0 : 1, s0: 0, s1: 1, t0: now });
    if (!animate) { people = people.filter(q => q.s1 > 0); for (const q of people) q.s = q.s1; }
    writePeople();
    shadowDirty = true;
  }
  function stepPeople(now) {
    let more = false;
    for (const q of people) {
      const k = clamp((now - q.t0) / 480, 0, 1);
      q.s = lerp(q.s0, q.s1, easeOut(k));
      if (k < 1) more = true; else q.s = q.s1;
    }
    if (!more) people = people.filter(q => q.s1 > 0);
    writePeople();
    shadowDirty = true;
    return more;
  }
  function writePeople() {
    if (!pplMesh) return;
    let n = 0;
    for (const q of people) {
      if (n >= pplMesh.instanceMatrix.count) break;
      const s = Math.max(.0001, q.s);
      _m4.compose(q.pos, _q, _s3.set(s, s, s));
      pplMesh.setMatrixAt(n, _m4); headMesh.setMatrixAt(n, _m4); n++;
    }
    pplMesh.count = headMesh.count = n;
    pplMesh.instanceMatrix.needsUpdate = headMesh.instanceMatrix.needsUpdate = true;
  }

  /* ── ใส่ข้อมูลชุดใหม่ (วันที่/กะ/ภาษา/ย้อนดู) ── */
  function applyData(p, animate) {
    if (building) return;                         // ฉากยังสร้างไม่ครบ (ป้ายโซน/เครื่องยังมาไม่หมด) — ชุดล่าสุดใส่ให้ตอนสร้างเสร็จ
    P = p; S = p.S || S;
    root.classList.toggle('jl', !!p.jobLbl);
    let clsChanged = !mm.solid && !mm.ghost;
    for (const m of machines) {
      const d = p.mc[m.id] || { st: 'off' };
      const cls = d.st === 'pend' ? 'ghost' : 'solid';
      if (cls !== m.cls) { m.cls = cls; clsChanged = true; m.cur = null; }
      m.data = d;
    }
    for (const m of machines) {
      const d = m.data, dim = filter !== 'all' && !matchFilter(d, m.id);
      setColors(m, roleColors(d.st, !!d.sos, dim), animate && !!m.cur);
    }
    if (clsChanged) rebuildMachineMeshes();
    setPeople(animate);
    renderOverlays();
    applyLblVis();
    renderChips();
    renderWatch();
    renderBanner();
    hudTitles();
    if (sheetOpen && selId) openSheet(selId, true);
    kick();
  }
  function matchFilter(d, id) {
    switch (filter) {
      case 'top': return !!(d.top || (d.ln && P.lineTop && P.lineTop[d.ln]));
      case 'warn': return d.st === 'warn';
      case 'off': return d.st === 'off';
      case 'sos': return !!d.sos;
      case 'pend': return d.st === 'pend';
      default: return true;
    }
  }
  // ป้ายเครื่อง / หมุด TOP / SOS / ป้ายโซน / ป้ายไลน์
  function renderOverlays() {
    for (const o of lay.dyn || []) scene.remove(o);
    lay.dyn = []; lay.sos = [];
    const addCss = (e, x, y, z, cy) => { const o = new CSS2DObject(e); o.center.set(.5, cy == null ? .5 : cy); o.position.set(x, y, z); scene.add(o); lay.dyn.push(o); return o; };
    for (const m of machines) {
      if (!m.label) continue;
      const d = m.data, dim = filter !== 'all' && !matchFilter(d, m.id);
      m.lblDirty = true;
      if (m.lblOn) paintLabel(m);                 // ป้ายที่โชว์อยู่ = เขียนใหม่ทันที · ที่เหลือเขียนตอนได้โชว์
      if (d.top) { const e = el('div', 'f3d-pin' + (dim ? ' dim' : ''), `<div class="pn"><b>${d.top}</b><i></i></div>`); addCss(e, m.cx, m.ymax + 3, m.cz, 1); }
      if (d.sos) {
        const e = el('div', 'f3d-sos', '<div class="ry"><div class="r"></div><div class="r r2"></div></div>'); e._m = m;
        addCss(e, m.cx, .6, m.cz); lay.sos.push(e);
        addCss(el('div', 'f3d-lmp'), m.lamp.x, m.lamp.y, m.lamp.z);
      }
    }
    for (const L of lines) {
      const rk = P.lineTop && P.lineTop[L.id];
      if (rk) { const e = el('div', 'f3d-pin', `<div class="pn"><b>${rk}</b><i></i></div>`); addCss(e, L.cx, 6, L.cz, 1); }
    }
    for (const [k, q] of lay.zones) {
      const z = (P.zk || {})[k] || {}, zn = (P.zones || []).find(x => x.key === k) || {};
      const oc = z.oae == null ? 'none' : z.oae >= .75 ? 'good' : 'warn';
      const full = zn.label || k, short = zn.short || full;
      q.el.innerHTML = `<div class="zt"><i></i><span class="zs-s">${esc(short)}</span><span class="zs-f">${esc(full)}</span><span class="zo ${oc}">${z.oae == null ? '—' : (z.oae * 100).toFixed(1) + '%'}</span></div>
        <div class="zv">${esc(S.on || 'On')} <b>${z.on || 0}/${z.n || q.n}</b> · <b>${Math.round(z.opr || 0).toLocaleString()}</b>/${Math.round(z.tgt || 0).toLocaleString()} · 👷 <b>${z.ppl || 0}</b></div>
        <div class="zp${z.pend ? ' on' : ''}">⏳ ${esc((S.pendN || '{n}').replace('{n}', z.pend || 0))}</div>`;
    }
    lv = -1; lzOn = null; zMeasure = true; lblForce = true;
  }
  function paintLabel(m) {
    const d = m.data || {}, dim = filter !== 'all' && !matchFilter(d, m.id);
    const pp = d.ppl && d.ppl.length > 3 ? `<span class="pp">👷${d.ppl.length}</span>` : '';
    const pre = d.st === 'pend' ? '⏳ ' : '';
    m.lel.className = 'f3d-ml' + (d.st === 'off' ? ' off' : d.st === 'pend' ? ' pend' : '') + (m.id === selId ? ' sel' : '') + (dim ? ' dim' : '');
    m.lel.innerHTML = `<b>${pre}${esc(m.id)}</b>${pp}${d.valve ? `<span class="v">${esc(d.valve)}${d.more ? ` +${d.more}` : ''}</span>` : ''}`;
    // ขนาดป้ายโดยประมาณ (Courier New ตัวหนา 10px ≈ 6 px/ตัว) — ไม่วัดจาก DOM = ไม่บังคับ layout
    const idW = (m.id.length + (pre ? 2 : 0)) * 6.1 + 12 + (pp ? 22 : 0), vW = d.valve ? (d.valve.length + (d.more ? 3 : 0)) * 5.8 + 12 : 0;
    m.lw = Math.max(idW, vW); m.lblDirty = false;
  }
  /* ── ป้ายเลขเครื่องไม่ให้รก (ผู้ใช้ 27/10: ป้ายเยอะเกิน อาจทำให้เปิดช้า) ──
     เลือกโชว์ตามลำดับความสำคัญ: เลือกอยู่ → TOP → SOS → OAE<75% → ปกติ → ปิดเครื่อง (⏳ รอข้อมูล = เฉพาะซูมใกล้ / กรอง / แตะเลือก)
     ป้ายที่จะทับป้ายอื่นหรือป้ายโซนบนจอ = ไม่โชว์ · จำกัดจำนวน (มือถือ 24 · จอใหญ่ 60) · นอกจอ = ไม่โชว์
     ป้ายที่ไม่โชว์ถูกถอดออกจากฉาก → DOM มีแค่ป้ายที่เห็นจริง (เดิมขยับป้ายทุกใบทุกเฟรมตอนลาก) */
  let lblKey = '', lblT = 0, lblForce = true;
  function declutterLabels(now, moving) {
    if (!lay || !sized) return;
    if (lv < 1) {
      if (machines.some(m => m.lblOn)) for (const m of machines) if (m.lblOn) { scene.remove(m.label); m.lblOn = false; }
      return;
    }
    const t = controls.target, key = `${camera.zoom.toFixed(3)}|${t.x.toFixed(1)}|${t.z.toFixed(1)}|${camera.position.x.toFixed(0)}|${camera.position.z.toFixed(0)}|${size.w}x${size.h}`;
    if (!lblForce && key === lblKey) return;
    if (!lblForce && moving && now - lblT < 110) return;                  // ระหว่างลาก/ซูม: คิดใหม่ไม่ถี่กว่า ~9 ครั้ง/วินาที
    lblKey = key; lblT = now; lblForce = false; lblZSig = zSig;
    const W = size.w, H = size.h, jl = root.classList.contains('jl'), cand = [];
    const near = lay.md * camera.zoom * size.h / F >= 90;              // ซูมใกล้มาก (เครื่องกว้าง ≥ 90 px บนจอ)
    for (const m of machines) {
      if (!m.label) continue;
      const d = m.data || {};
      let pr = m.id === selId ? 0 : d.top ? 1 : d.sos ? 2 : d.st === 'warn' ? 3 : d.st === 'good' ? 4 : d.st === 'off' ? 5 : 6;
      if (!showLbl && pr) continue;                                    // 📛 ซ่อนป้ายชื่อ: เหลือแค่เครื่องที่แตะเลือก
      if (filter !== 'all') { if (!matchFilter(d, m.id) && pr) continue; if (pr) pr = 2.5; }
      if (pr === 6 && !near) continue;                                  // ⏳ รอข้อมูล: ไม่มีตัวเลขให้ดู → ขึ้นป้ายเฉพาะซูมใกล้มาก / กรอง ⏳ / แตะเลือก
      _v.set(m.cx, m.ymax + 2, m.cz).project(camera);
      if (_v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.15) continue;
      const x = (_v.x + 1) / 2 * W, y = (1 - _v.y) / 2 * H;
      cand.push({ m, pr, x, y, dc: Math.abs(x - W / 2) + Math.abs(y - H / 2) });
    }
    cand.sort((a, b) => a.pr - b.pr || a.dc - b.dc);
    const max = W < 480 ? 24 : 60, keep = new Set(), C = 48, cells = new Map();
    const put = r => { for (let i = Math.floor(r[0] / C); i <= Math.floor(r[2] / C); i++) for (let j = Math.floor(r[1] / C); j <= Math.floor(r[3] / C); j++) { const k = (i + 500) * 4000 + j + 500; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(r); } };
    const hits = r => { for (let i = Math.floor(r[0] / C); i <= Math.floor(r[2] / C); i++) for (let j = Math.floor(r[1] / C); j <= Math.floor(r[3] / C); j++) { const a = cells.get((i + 500) * 4000 + j + 500); if (a) for (const q of a) if (q[0] < r[2] && q[2] > r[0] && q[1] < r[3] && q[3] > r[1]) return true; } return false; };
    for (const z of zoneRects) put(z);
    for (const c of cand) {
      if (keep.size >= max && c.pr > 0) break;
      if (c.m.lblDirty || !c.m.lw) paintLabel(c.m);
      const h = lv >= 2 && jl && c.m.data && c.m.data.valve ? 28 : 16, w = c.m.lw;
      const r = [c.x - w / 2 - 2, c.y - h - 2, c.x + w / 2 + 2, c.y + 1];
      if (c.pr > 0 && hits(r)) continue;
      keep.add(c.m); put(r);
    }
    for (const m of machines) {
      if (!m.label) continue;
      const on = keep.has(m);
      if (on && !m.lblOn) { if (m.lblDirty) paintLabel(m); scene.add(m.label); m.lblOn = true; }
      else if (!on && m.lblOn) { scene.remove(m.label); m.lblOn = false; }
    }
  }
  // ป้ายโซนทับกันบนจอ (ซูมออก/จอแคบ) → ดันป้ายที่ซ้อนขึ้นด้านบน · ขนาดป้ายวัดครั้งเดียวต่อการเปลี่ยนเนื้อหา (ไม่บังคับ layout ทุกเฟรม)
  let zMeasure = true, zoneRects = [], hudTop = 0;   // zoneRects = กรอบป้ายโซนบนจอ (ป้ายเครื่องห้ามทับ) · hudTop = ขอบล่างแถบ HUD บน
  // ★ v3.99 ป้ายเครื่องคิดตำแหน่ง "ก่อน" วัดป้ายโซนในเฟรมเดียวกัน → เฟรมแรกหลังสร้างฉาก/เปิดป้าย ยังไม่รู้กรอบป้ายโซน = ป้ายเครื่องทับป้ายโซนค้างไว้
  //   ถ้ากรอบป้ายโซนเปลี่ยนจากที่ป้ายเครื่องใช้ล่าสุด และกล้องนิ่งแล้ว → คิดป้ายเครื่องใหม่อีก 1 เฟรม (ระหว่างลากไม่บังคับ — คงจังหวะ ~9 ครั้ง/วิ เดิม)
  let zSig = '', lblZSig = '';
  function declutterZones(moving) {
    if (!lay || !lay.zones.size || !showLbl) { zoneRects = []; zSig = ''; return; }
    const zs = [...lay.zones.values()].filter(q => q.el);
    if (zMeasure) { for (const q of zs) { q.ew = q.el.offsetWidth; q.eh = q.el.offsetHeight; } zMeasure = false; }
    const items = zs.map(q => { _v.copy(q.obj.position).project(camera); return { q, x: (_v.x + 1) / 2 * size.w, y: (1 - _v.y) / 2 * size.h, w: q.ew || 80, h: q.eh || 22 }; });
    items.sort((a, b) => b.y - a.y);
    const placed = [];
    for (const it of items) {
      let top = it.y - it.h;
      for (let k = 0; k < 4; k++) {
        const hit = placed.find(p => Math.abs(p.x - it.x) < (p.w + it.w) / 2 + 4 && top < p.bottom + 3 && top + it.h > p.top - 3);
        if (!hit) break;
        top = hit.top - it.h - 4;
        if (top < hudTop) top = hit.bottom + 4;    // ดันขึ้นแล้วจะไปอยู่ใต้แถบ KPI/ตัวกรอง → ดันลงแทน
      }
      const off = Math.round(top - (it.y - it.h));
      if (it.q.mt !== off) { it.q.mt = off; it.q.el.style.marginTop = off ? off + 'px' : ''; }
      placed.push({ x: it.x, w: it.w, top, bottom: top + it.h });
    }
    zoneRects = placed.map(p => [p.x - p.w / 2 - 2, p.top - 2, p.x + p.w / 2 + 2, p.bottom + 2]);
    zSig = zoneRects.map(r => r.map(v => Math.round(v / 4)).join(',')).join('|');
    if (!moving && lv >= 1 && zSig !== lblZSig) { lblForce = true; kick(); }
  }
  // 📛 ป้ายชื่อเปิด/ปิด: ป้ายโซน + ป้ายไลน์ (lay.css) ซ่อนด้วย visible = CSS2DRenderer ไม่ขยับป้ายที่ซ่อน · เลขเครื่องดูที่ declutterLabels
  function applyLblVis() {
    if (!lay) return;
    for (const o of lay.css) o.visible = showLbl;
    zMeasure = true; lblForce = true;
  }
  // ระดับป้ายตามซูม: 0 = ไม่มีป้าย · 1 = เลขเครื่อง · 2 = + เบอร์วาล์ว (เมื่อเปิด 🏷️ เบอร์ในกล่อง)
  function updateLevels() {
    if (!lay || !sized) return;
    const ppu = camera.zoom * size.h / F;
    const px = lay.md * ppu;
    const nl = px >= 52 ? 2 : px >= 28 ? 1 : 0;
    if (nl !== lv) {
      lv = nl; lblForce = true;
      root.classList.toggle('lv1', lv >= 1); root.classList.toggle('lv2', lv >= 2);
    }
    const lz = ppu >= .62;
    if (lz !== lzOn) { lzOn = lz; root.classList.toggle('lz', lz); zMeasure = true; }
    // วง SOS บนพื้น: เส้นผ่านศูนย์กลางตามขนาดเครื่องบนจอ · แบนตามมุมเงย
    // เขียน style เฉพาะตอนค่าเปลี่ยน (เดิมเขียนทุกเฟรม = ให้เบราว์เซอร์คำนวณ style ใหม่ทุกเฟรมตอนลาก)
    const sy = Math.max(.08, Math.cos(controls.getPolarAngle ? controls.getPolarAngle() : VIEW0.phi)).toFixed(2);
    for (const e of lay.sos || []) {
      const m = e._m, dd = Math.max(22, Math.max(m.w, m.d) * 1.25 * ppu).toFixed(0) + 'px';
      if (e._d !== dd) { e._d = dd; e.style.setProperty('--d', dd); }
      if (e._sy !== sy) { e._sy = sy; e.style.setProperty('--sy', sy); }
    }
  }

  /* ── ตัวกรองสถานะ + ค้นหาเลขเครื่อง ── */
  function counts() {
    const c = { all: 0, top: 0, warn: 0, off: 0, sos: 0, pend: 0 };
    const seen = new Set();
    for (const m of machines) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const d = m.data || {}; c.all++;
      if (d.st === 'warn') c.warn++; else if (d.st === 'off') c.off++; else if (d.st === 'pend') c.pend++;
      if (d.sos) c.sos++;
      if (d.top) c.top++;
    }
    for (const L of lines) if (P.lineTop && P.lineTop[L.id]) c.top++;
    return c;
  }
  function renderChips() {
    const c = counts(), F_ = S.filters || {};
    const defs = [['all', '🏭'], ['top', '🔥'], ['warn', '🟠'], ['off', '⚫'], ['sos', '🆘'], ['pend', '⏳']];
    if (filter !== 'all' && !c[filter]) filter = 'all';
    chipsEl.innerHTML = defs.filter(([k]) => k === 'all' || c[k] || filter === k).map(([k, ic]) =>
      `<button type="button" class="f3d-c${filter === k ? ' on' : ''}" data-f="${k}">${ic} ${esc(F_[k] || k)} <span class="n">${c[k]}</span></button>`).join('');
  }
  chipsEl.addEventListener('click', e => {
    const b = e.target.closest('.f3d-c'); if (!b) return;
    const f = b.dataset.f; filter = (filter === f && f !== 'all') ? 'all' : f;
    applyData(P, true);
  });
  function sugList(q) {
    q = q.trim().toUpperCase(); if (!q) return [];
    const ids = [...new Set(machines.map(m => m.id))].concat(lines.map(L => L.id));
    const hit = ids.filter(id => id.toUpperCase().includes(q));
    hit.sort((a, b) => (a.toUpperCase().indexOf(q) - b.toUpperCase().indexOf(q)) || a.localeCompare(b));
    return hit.slice(0, 8);
  }
  qIn.addEventListener('input', () => {
    const l = sugList(qIn.value);
    sugEl.innerHTML = l.length ? l.map(id => `<button type="button" data-id="${esc(id)}">${esc(id)}</button>`).join('') : (qIn.value.trim() ? `<div class="no">${esc(S.noMatch || '—')}</div>` : '');
    sugEl.classList.toggle('on', !!qIn.value.trim());
  });
  qIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const l = sugList(qIn.value); if (l.length) pickSug(l[0]); }
    else if (e.key === 'Escape') { qIn.value = ''; sugEl.classList.remove('on'); qIn.blur(); }
  });
  qIn.addEventListener('blur', () => setTimeout(() => sugEl.classList.remove('on'), 180));
  sugEl.addEventListener('pointerdown', e => e.preventDefault());       // แตะรายการไม่ทำให้ช่องเสียโฟกัสก่อนเลือก
  sugEl.addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) pickSug(b.dataset.id); });
  function pickSug(id) { qIn.value = id; sugEl.classList.remove('on'); qIn.blur(); focus(id, { sheet: true }); }

  /* ── แถบล่าง: เครื่องที่ต้องดู (TOP ปัญหา → OAE < 75% → ปิดเครื่อง) ── */
  function renderWatch() {
    const items = [];
    for (const L of lines) { const rk = P.lineTop && P.lineTop[L.id]; if (rk) items.push({ id: L.id, cls: '', ic: rk, x: S.line || '', ord: rk }); }
    const seen = new Set();
    for (const m of machines) {
      if (seen.has(m.id)) continue; seen.add(m.id);
      const d = m.data || {};
      if (d.top) items.push({ id: m.id, cls: '', ic: d.top, x: d.oae == null ? '' : (d.oae * 100).toFixed(1) + '%', ord: d.top, sos: d.sos });
    }
    const rest = [];
    for (const m of machines) {
      if (!seen.delete(m.id)) continue;
      const d = m.data || {};
      if (d.top) continue;
      if (d.st === 'warn') rest.push({ id: m.id, cls: 'warn', ic: '!', x: d.oae == null ? '' : (d.oae * 100).toFixed(1) + '%', ord: 100 + (d.oae || 0), sos: d.sos });
      else if (d.st === 'off') rest.push({ id: m.id, cls: 'off', ic: '■', x: S.offShort || 'off', ord: 1000 });
    }
    items.sort((a, b) => a.ord - b.ord); rest.sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id));
    const all = items.concat(rest).slice(0, 40);
    watchEl.style.display = all.length ? '' : 'none';
    watchEl.innerHTML = all.length ? `<div class="f3d-w hd">⚠ ${esc(S.watch || '')} ${all.length}</div>` + all.map(it =>
      `<button type="button" class="f3d-w ${it.cls}" data-id="${esc(it.id)}"><span class="ic">${it.ic}</span><span class="m">${esc(it.id)}</span>${it.x ? `<span class="x">${esc(it.x)}</span>` : ''}${it.sos ? '<span class="s">🆘</span>' : ''}</button>`).join('') : '';
    requestAnimationFrame(layoutHud);
  }
  watchEl.addEventListener('click', e => { const b = e.target.closest('.f3d-w[data-id]'); if (b) focus(b.dataset.id, { sheet: true }); });

  function renderBanner() {
    let html = '', pend = false;
    if (tl) html = `🕘 ${esc(S.tlMode || '')} ${esc(tl.steps[tl.i].label)} <button type="button" data-b="tl">${esc(S.back || 'Back')}</button>`;
    else if (P.pend && P.pend.all) { html = `⏳ ${esc(P.pend.open ? (S.pendAll || '') : (S.noData || ''))}`; pend = true; }
    banEl.innerHTML = html; banEl.classList.toggle('on', !!html); banEl.classList.toggle('pend', pend);
  }
  banEl.addEventListener('click', e => { if (e.target.closest('[data-b="tl"]')) closeTimeline(); });

  /* ── แตะเครื่อง → ไฮไลต์ + กล้องเลื่อนไปโฟกัส + bottom sheet ── */
  let down = null;
  // capture = ทำงานก่อนตัวควบคุมกล้อง → แตะระหว่างกล้องกำลังบินให้หยุดบินแล้วลากต่อได้ทันที
  canvas.addEventListener('pointerdown', e => {
    if (e.isPrimary) down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, multi: false };
    else if (down) down.multi = true;
    if (tw) { tw = null; controls.enabled = true; resetDamping(); }
    if (document.activeElement === qIn) qIn.blur();
  }, true);
  canvas.addEventListener('pointerup', e => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y, ok = !down.multi && dx * dx + dy * dy < 64 && performance.now() - down.t < 600;
    down = null;
    if (ok) pickAt(e.clientX, e.clientY);
  });
  function pickAt(x, y) {
    const r = canvas.getBoundingClientRect();
    _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    let best = null, bd = Infinity;
    for (const m of [...machines, ...lines]) {
      const h = _ray.ray.intersectBox(m.aabb, _v);
      if (h) { const d = h.distanceTo(_ray.ray.origin); if (d < bd) { bd = d; best = m; } }
    }
    if (best) focus(best.id, { sheet: true });
    else closeSheet();
  }
  function setSelRing(m) {
    if (lay.sel) { scene.remove(lay.sel); lay.sel.geometry.dispose(); lay.sel = null; }
    if (!m) return;
    const o = roundRectShape(m.w + 9, m.d + 9, 6), hole = roundRectShape(m.w + 4, m.d + 4, 4);
    o.holes.push(hole);
    const g = new THREE.ShapeGeometry(o, 3); g.rotateX(-Math.PI / 2); g.translate(m.cx, .3, m.cz);
    lay.sel = new THREE.Mesh(g, mats.sel); lay.sel.renderOrder = 3; scene.add(lay.sel);
  }
  // o.sheet = true → เปิด bottom sheet ด้วย · ไม่ใส่ = บินไปหา + ไฮไลต์อย่างเดียว (เช่นกดจากแถบ TOP ปัญหาด้านบนการ์ด)
  function focus(id, o = {}) {
    if (!lay) return;
    const m = byId.get(id) || lineById.get(id);
    if (!m) return;
    selId = id; lblForce = true;
    setSelRing(m);
    for (const x of machines) if (x.lel) x.lel.classList.toggle('sel', x.id === id);
    if (o.sheet) openSheet(id); else hideSheet();
    flyTo(m);
    kick();
  }
  function focusZone(k) {
    const q = lay && lay.zones.get(k); if (!q) return;
    closeSheet();
    fitBox(new THREE.Box3(new THREE.Vector3(q.x0 - 10, 0, q.z0 - 10), new THREE.Vector3(q.x1 + 10, 30, q.z1 + 10)), true);
  }
  function openSheet(id, keep) {
    const html = opts.sheet ? opts.sheet(id, P) : '';
    if (!html) { hideSheet(); return; }
    sheetBd.innerHTML = html;
    if (!keep) sheetBd.scrollTop = 0;
    sheetEl.classList.add('on'); sheetEl.setAttribute('aria-hidden', 'false');
    sheetOpen = true;
  }
  function hideSheet() {
    if (!sheetOpen) return;
    sheetEl.classList.remove('on'); sheetEl.setAttribute('aria-hidden', 'true');
    sheetOpen = false;
  }
  function closeSheet(silent) {                 // ปิด sheet + เลิกไฮไลต์
    hideSheet();
    if (selId) { for (const x of machines) if (x.lel) x.lel.classList.remove('sel'); selId = ''; if (lay) setSelRing(null); }
    if (!silent) kick();
  }
  $('.f3d-sh-x').addEventListener('click', () => closeSheet());
  sheetBd.addEventListener('click', e => {
    const b = e.target.closest('[data-f3d-act]'); if (!b) return;
    if (opts.onAction) opts.onAction(b.dataset.f3dAct, b.dataset.id || selId);
  });
  { // ลากแถบจับลงเพื่อปิด
    const grip = $('.f3d-sh-grip'); let g0 = null;
    grip.addEventListener('pointerdown', e => { g0 = { y: e.clientY }; grip.setPointerCapture(e.pointerId); sheetEl.classList.add('drag'); });
    grip.addEventListener('pointermove', e => { if (!g0) return; const dy = Math.max(0, e.clientY - g0.y); sheetEl.style.transform = `translateY(${dy}px)`; g0.dy = dy; });
    const end = () => { if (!g0) return; sheetEl.classList.remove('drag'); sheetEl.style.transform = ''; if ((g0.dy || 0) > 60) closeSheet(); g0 = null; };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen) { e.stopPropagation(); closeSheet(); } });

  /* ── กล้อง ── */
  function sphNow() { const s = new THREE.Spherical().setFromVector3(_v.copy(camera.position).sub(controls.target)); return s; }
  function setView(target, theta, phi, z) {
    controls.target.copy(target);
    camera.position.setFromSpherical(new THREE.Spherical(R, phi, theta)).add(target);
    camera.zoom = z; camera.updateProjectionMatrix(); camera.lookAt(target);
  }
  function resetDamping() {
    if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0);
    if (controls._panOffset) controls._panOffset.set(0, 0, 0);
    if ('_scale' in controls) controls._scale = 1;
  }
  function tweenTo(to, ms) {
    camAuto = false;                           // บิน/ซูม/หมุนตามที่สั่ง → ไม่ใช่มุมเริ่มแล้ว (resetView ตั้งกลับเอง)
    const s = sphNow();
    let dth = to.theta - s.theta; dth = ((dth + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    resetDamping();
    tw = { f: { t: controls.target.clone(), z: camera.zoom, th: s.theta, ph: s.phi }, to: { t: to.target.clone(), z: to.zoom, th: s.theta + dth, ph: to.phi }, t0: performance.now(), ms: ms || 650 };
    controls.enabled = false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) tw.ms = 1;
    kick();
  }
  function stepTween(now) {
    const k = clamp((now - tw.t0) / tw.ms, 0, 1), e = ease(k), f = tw.f, t = tw.to;
    setView(_v2.lerpVectors(f.t, t.t, e), lerp(f.th, t.th, e), lerp(f.ph, t.ph, e), f.z * Math.pow(t.z / f.z, e));
    if (k >= 1) { tw = null; controls.enabled = true; controls.update(); return true; }
    return true;
  }
  // หา zoom + จุดเล็งที่ทำให้กล่องพอดีพื้นที่ว่างระหว่างแถบ HUD (มุมกล้องที่กำหนด) · dim = ขนาด/ขอบเอง (ภาพ PNG)
  function fitFor(box, theta, phi, padExtra, dim) {
    const W = dim ? dim.w : size.w, H = dim ? dim.h : size.h, a = W / H;
    const c = box.getCenter(new THREE.Vector3());
    const pos = new THREE.Vector3().setFromSpherical(new THREE.Spherical(R, phi, theta)).add(c);
    const rot = new THREE.Matrix4().lookAt(pos, c, camera.up);
    const right = new THREE.Vector3().setFromMatrixColumn(rot, 0), up = new THREE.Vector3().setFromMatrixColumn(rot, 1);
    let hx = 1, hy = 1;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      hx = Math.max(hx, Math.abs(_v.dot(right))); hy = Math.max(hy, Math.abs(_v.dot(up)));
    }
    // จอแคบ (มือถือแนวตั้ง): ผังกว้างกว่าจอ → ล้นขอบเล็กน้อย (ลากดูต่อเอง) แทนการย่อจนเครื่องเล็กเกิน
    const narrow = !dim && isNarrow();
    const pt = dim ? dim.t : topEl.offsetHeight + 16 + (padExtra || 0), pb = dim ? dim.b : botEl.offsetHeight + 16;
    const pl = dim ? dim.l : narrow ? 4 : 12, pr = dim ? dim.r : narrow ? 4 : 12;
    const aw = Math.max(60, W - pl - pr), ah = Math.max(60, H - pt - pb);
    const z = Math.min((F * a / 2) * (aw / W) / hx, (F / 2) * (ah / H) / hy) * (narrow ? 1.12 : 1);
    const wpp = F / (z * H), dx = (pl + aw / 2) - W / 2, dy = (pt + ah / 2) - H / 2;
    const target = c.clone().addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp);
    return { target: toFloor(target, theta, phi), zoom: z };
  }
  // เลื่อนจุดเล็งไปตามแนวสายตาจนแตะพื้น (y = 0) — ภาพ ortho เหมือนเดิมทุกพิกเซล แต่ซูมตามนิ้ว/เมาส์แม่นขึ้น
  function toFloor(t, theta, phi) {
    const c = Math.max(.15, Math.cos(phi)), k = t.y / c;
    return t.set(t.x - Math.sin(phi) * Math.sin(theta) * k, 0, t.z - Math.sin(phi) * Math.cos(theta) * k);
  }
  // กรอบมือถือแนวตั้ง (แคบ + สูงกว่ากว้าง) · ★ v4.04 เดิมดูแค่ความกว้าง < 480 → คอลัมน์ผังบนทีวีเต็มจอ (~450×395
  //   ตอนลากเส้นแบ่งให้ฝั่งต่อกะกว้าง — ขนาดเดียวกับรูปที่ผู้ใช้ส่ง) ถูกนับเป็นมือถือ = ซูมเกิน ผังล้นซ้าย-ขวา
  function isNarrow() { return size.w < 480 && size.h > size.w; }
  function planBox(mx) { mx = mx || 0; return new THREE.Box3(new THREE.Vector3(lay.x0 - mx, 0, lay.z0), new THREE.Vector3(lay.x1 + mx, 24, lay.z1)); }
  function resetView(anim) {
    if (!lay || !sized) return;
    // ★ v4.04 กรอบซ้าย-ขวา = พื้นทั้งแผ่น (รวมขอบ + ของวางมุม) เหมือนรูปที่ผู้ใช้ส่ง (ทีวีเต็มจอ ผังชนขอบซ้าย-ขวา)
    //   จอกว้างที่ความสูงเป็นตัวจำกัด = ขนาดเครื่องเท่าเดิม · มือถือแนวตั้ง = พอดีเครื่องเหมือนเดิม (ไม่ย่อเครื่องลงอีก)
    const f = fitFor(planBox(isNarrow() ? 0 : lay.M), VIEW0.theta, VIEW0.phi, lay.zones.size ? 34 : 0);   // + ที่ว่างให้ป้ายโซนที่ลอยเหนือขอบผัง
    controls.minZoom = f.zoom * .55; controls.maxZoom = f.zoom * 14;
    isoView = { ...VIEW0 };
    if (anim) tweenTo({ target: f.target, zoom: f.zoom, theta: VIEW0.theta, phi: VIEW0.phi }, 700);
    else { tw = null; controls.enabled = true; resetDamping(); setView(f.target, VIEW0.theta, VIEW0.phi, f.zoom); controls.update(); kick(); }
    camAuto = true;
  }
  function fitBox(box, anim) {
    const s = sphNow(), f = fitFor(box, s.theta, s.phi, 34);
    const z = clamp(f.zoom, controls.minZoom, controls.maxZoom);
    tweenTo({ target: f.target, zoom: z, theta: s.theta, phi: s.phi }, anim ? 700 : 1);
  }
  let pendingFly = '';                         // สั่งบินตอนกรอบยังไม่มีขนาด (เช่นเพิ่งกางผังบนมือถือ) → บินหลังวัดขนาดได้
  function flyPending() { const m = byId.get(pendingFly) || lineById.get(pendingFly); pendingFly = ''; if (m) flyTo(m); }
  function flyTo(m) {
    if (!sized || !fitted) { pendingFly = m.id; return; }
    pendingFly = '';
    const W = size.w, H = size.h, s = sphNow();
    const zWant = (Math.min(W, H) * .3 / Math.max(m.w, m.d)) * F / H;
    const z = clamp(Math.max(camera.zoom, zWant), controls.minZoom, controls.maxZoom);
    const sheetH = sheetOpen ? Math.min(H * .66, sheetEl.offsetHeight || H * .5) : 0;
    const pt = topEl.offsetHeight + 12, pb = Math.max(botEl.offsetHeight + 12, sheetH + 8);
    const cy = pt + Math.max(40, H - pt - pb) / 2, dy = cy - H / 2;
    const rot = new THREE.Matrix4().lookAt(camera.position, controls.target, camera.up);
    const up = new THREE.Vector3().setFromMatrixColumn(rot, 1);
    const wpp = F / (z * H);
    const target = new THREE.Vector3(m.cx, Math.min(m.ymax, 20) / 2, m.cz).addScaledVector(up, dy * wpp);
    tweenTo({ target: toFloor(target, s.theta, s.phi), zoom: z, theta: s.theta, phi: s.phi }, 650);
  }
  function zoom(dir) {
    if (!lay) return;
    if (!dir) { resetView(true); return; }
    const s = sphNow();
    tweenTo({ target: controls.target, zoom: clamp(camera.zoom * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), controls.minZoom, controls.maxZoom), theta: s.theta, phi: s.phi }, 320);
  }
  function rotate90() { const s = sphNow(); tweenTo({ target: controls.target, zoom: camera.zoom, theta: s.theta + Math.PI / 2, phi: s.phi }, 600); }
  function topView() {
    const s = sphNow(), isTop = s.phi < .05;
    if (!isTop) isoView = { theta: s.theta, phi: s.phi };
    const v = isTop ? isoView : TOPV;
    tweenTo({ target: controls.target, zoom: camera.zoom, theta: v.theta, phi: v.phi }, 650);
  }

  /* ── ย้อนดูทีละกะ / บันทึกภาพ (ไม่มีปุ่มตั้งแต่ v3.99 — ดูหมายเหตุที่ชั้น HUD) ── */
  function toggleTimeline() { if (tl) closeTimeline(); else openTimeline(); }
  function openTimeline() {
    const info = opts.timeline ? opts.timeline() : null;
    if (!info || !info.steps || !info.steps.length) { flash(S.tlNone || ''); return; }
    tl = { steps: info.steps, i: clamp(info.cur == null ? info.steps.length - 1 : info.cur, 0, info.steps.length - 1), timer: 0 };
    const T = S.tl || {};
    tlEl.innerHTML = `<button type="button" class="f3d-b" data-t="prev" aria-label="${esc(T.prev || '')}">◀</button>
      <button type="button" class="f3d-b" data-t="play" aria-label="${esc(T.play || '')}">▶</button>
      <button type="button" class="f3d-b" data-t="next" aria-label="${esc(T.next || '')}">▶|</button>
      <input type="range" min="0" max="${tl.steps.length - 1}" step="1" value="${tl.i}" aria-label="${esc(T.slider || '')}">
      <span class="t"></span><button type="button" class="f3d-b" data-t="x" aria-label="${esc(S.close || '')}">✕</button>`;
    tlEl.classList.add('on');
    tlGo(tl.i);
    requestAnimationFrame(layoutHud);
  }
  function tlGo(i) {
    if (!tl) return;
    tl.i = clamp(i, 0, tl.steps.length - 1);
    const st = tl.steps[tl.i], p = opts.payloadAt ? opts.payloadAt(st) : null;
    tlEl.querySelector('input').value = tl.i;
    tlEl.querySelector('.t').textContent = st.label;
    if (p && p.layoutKey === layoutKey) applyData(p, true);
  }
  function tlPlay(on) {
    if (!tl) return;
    clearInterval(tl.timer); tl.timer = 0;
    const b = tlEl.querySelector('[data-t="play"]');
    if (on) {
      if (tl.i >= tl.steps.length - 1) tlGo(0);
      tl.timer = setInterval(() => { if (!tl) return; if (tl.i >= tl.steps.length - 1) { tlPlay(false); return; } tlGo(tl.i + 1); }, 1400);
    }
    if (b) b.textContent = on ? '⏸' : '▶';
  }
  tlEl.addEventListener('click', e => {
    const b = e.target.closest('[data-t]'); if (!b || !tl) return;
    const t = b.dataset.t;
    if (t === 'prev') { tlPlay(false); tlGo(tl.i - 1); }
    else if (t === 'next') { tlPlay(false); tlGo(tl.i + 1); }
    else if (t === 'play') tlPlay(!tl.timer);
    else if (t === 'x') closeTimeline();
  });
  tlEl.addEventListener('input', e => { if (e.target.matches('input[type=range]')) { tlPlay(false); tlGo(+e.target.value); } });
  function closeTimeline() {
    if (!tl) return;
    tlPlay(false); tl = null;
    tlEl.classList.remove('on'); tlEl.innerHTML = '';
    if (Plive) applyData(Plive, true);
    requestAnimationFrame(layoutHud);
  }
  function flash(msg) {
    if (!msg) return;
    const h = el('div', 'f3d-hint', esc(msg)); root.appendChild(h);
    // แถบแจ้งโชว์อยู่ (ล่างกลาง) → ข้อความลอยเหนือแถบ ไม่ทับกัน
    if (banEl.classList.contains('on')) h.style.bottom = Math.max(58, botEl.offsetHeight + 14 + banEl.offsetHeight + 8) + 'px';
    setTimeout(() => h.classList.add('out'), 2600); setTimeout(() => h.remove(), 3300);
  }
  async function savePng() {
    try {
      const blob = await snapshot();
      if (blob && opts.onPng) opts.onPng(blob, P);
    } catch (e) { flash(S.pngFail || String(e && e.message || e)); }
  }
  /* ภาพผังสำหรับรายงาน: ขนาดตายตัว 1600×1000 (ไม่ขึ้นกับขนาดจอมือถือ) · ทั้งผังในมุมกล้องปัจจุบัน
     = ภาพ WebGL + ป้ายโซน/หมุด/SOS/เลขเครื่อง/คำอธิบายสี (วาดลง canvas เอง — ป้าย DOM ไม่ติดมากับภาพ WebGL) */
  async function snapshot() {
    if (!sized || !P || !lay || building) throw new Error('not ready');
    const meta = opts.pngMeta ? opts.pngMeta(P) : { title: '', sub: '' };
    const W = 1600, H = 1000, head = 74, foot = 40;
    const s = sphNow(), cam = camera.clone();
    cam.left = -F * (W / H) / 2; cam.right = F * (W / H) / 2; cam.top = F / 2; cam.bottom = -F / 2;
    const f = fitFor(planBox(), s.theta, s.phi, 0, { w: W, h: H, t: 64, b: 24, l: 28, r: 28 });
    cam.position.setFromSpherical(new THREE.Spherical(R, s.phi, s.theta)).add(f.target);
    cam.zoom = f.zoom; cam.updateProjectionMatrix(); cam.lookAt(f.target); cam.updateMatrixWorld();
    flushDirty();
    if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
    const pr0 = renderer.getPixelRatio();
    renderer.setPixelRatio(1); renderer.setSize(W, H, false);
    renderer.render(scene, cam);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H + head + foot;
    const g = cv.getContext('2d');
    g.drawImage(renderer.domElement, 0, head, W, H);
    renderer.setPixelRatio(pr0); renderer.setSize(size.w, size.h, false); kick();       // คืนขนาดจอทันที (ยังไม่มีเฟรมไหนแสดงระหว่างนี้)
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, head); g.fillRect(0, head + H, W, foot);
    const font = (w, px) => `${w} ${px}px Sarabun, system-ui, sans-serif`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#1E3A8A'; g.font = font(800, 26); g.fillText(meta.title || '', 24, 34);
    g.fillStyle = '#475569'; g.font = font(700, 17); g.fillText(meta.sub || '', 24, 60);
    const kp = (P.kpi || []).slice(0, 5).map(k => `${k.l} ${fmtNum(k.v, k.f, k)}`).join('    ');
    g.textAlign = 'right'; g.fillStyle = '#0F172A'; g.font = font(800, 18); g.fillText(kp, W - 24, 34);
    g.fillStyle = '#64748B'; g.font = font(700, 14); g.fillText(new Date().toLocaleString(S.locale || 'th-TH'), W - 24, 60); g.textAlign = 'left';
    const lg = S.legend || {}, items = [['#16A34A', lg.good], ['#EA580C', lg.warn], ['#4B5563', lg.off], ['#CBD5E1', lg.pend], ['#DC2626', lg.top], ['#EF4444', lg.sos]];
    let lx = 24; g.font = font(700, 15);
    for (const [c, t] of items) { if (!t) continue; g.fillStyle = c; g.fillRect(lx, head + H + 13, 14, 14); g.fillStyle = '#334155'; g.fillText(t, lx + 20, head + H + 26); lx += 20 + g.measureText(t).width + 26; }
    const proj = (x, y, z) => { _v.set(x, y, z).project(cam); return [(_v.x + 1) / 2 * W, (1 - _v.y) / 2 * H + head]; };
    const ppu = cam.zoom * H / F;
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    g.save(); g.beginPath(); g.rect(0, head, W, H); g.clip();
    for (const m of machines) {
      const d = m.data || {};
      if (d.sos) { const [x, y] = proj(m.cx, .6, m.cz), r = Math.max(12, Math.max(m.w, m.d) * .62 * ppu); g.strokeStyle = '#EF4444'; g.lineWidth = 3; g.beginPath(); g.ellipse(x, y, r, r * Math.max(.1, Math.cos(s.phi)), 0, 0, Math.PI * 2); g.stroke(); }
    }
    if (lay.md * ppu >= 22) {                          // เลขเครื่อง — เมื่อเครื่องในภาพใหญ่พอ · ไม่ให้ทับกัน (สำคัญก่อน: TOP → SOS → <75% → ปกติ → ปิด → รอข้อมูล)
      const fs = clamp(lay.md * ppu * .34, 9, 13), taken = [];
      g.font = `700 ${fs}px "Courier New", monospace`; g.textAlign = 'center';
      const rank = d => (d.top ? 1 : d.sos ? 2 : d.st === 'warn' ? 3 : d.st === 'good' ? 4 : d.st === 'off' ? 5 : 6);
      const list = machines.filter(m => m.label).sort((a, b) => rank(a.data || {}) - rank(b.data || {}));
      for (const m of list) {
        const [x, y] = proj(m.cx, m.ymax + 2, m.cz), t = m.id, w = g.measureText(t).width + 8;
        const r = [x - w / 2 - 2, y - fs - 7, x + w / 2 + 2, y];
        if (taken.some(q => q[0] < r[2] && q[2] > r[0] && q[1] < r[3] && q[3] > r[1])) continue;
        taken.push(r);
        g.fillStyle = m.data && m.data.st === 'off' ? 'rgba(229,231,235,.95)' : 'rgba(255,255,255,.92)'; rr(x - w / 2, y - fs - 5, w, fs + 4, 4); g.fill();
        g.fillStyle = '#0F172A'; g.fillText(t, x, y - 4);
      }
      g.textAlign = 'left';
    }
    const pin = (x, y, n) => { g.fillStyle = '#DC2626'; g.fillRect(x - 1.2, y - 13, 2.4, 13); g.beginPath(); g.arc(x, y - 22, 11, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.fillStyle = '#fff'; g.font = '900 12px Arial, sans-serif'; g.textAlign = 'center'; g.fillText(String(n), x, y - 18); g.textAlign = 'left'; };
    for (const [k, q] of lay.zones) {
      const z = (P.zk || {})[k] || {}, zn = (P.zones || []).find(x => x.key === k) || {};
      const [x, y] = proj((q.x0 + q.x1) / 2, q.obj.position.y, q.z0);
      const t = `${zn.label || k}  ${z.oae == null ? '—' : (z.oae * 100).toFixed(1) + '%'}`;
      const t2 = `${S.on || 'On'} ${z.on || 0}/${z.n || q.n} · ${Math.round(z.opr || 0).toLocaleString()}/${Math.round(z.tgt || 0).toLocaleString()} · 👷 ${z.ppl || 0}`;
      g.font = font(800, 14); const w = Math.max(g.measureText(t).width, (g.font = font(700, 12.5), g.measureText(t2).width)) + 32;
      g.fillStyle = 'rgba(255,255,255,.96)'; rr(x - w / 2, y - 44, w, 40, 10); g.fill(); g.strokeStyle = zn.color || '#64748B'; g.lineWidth = 2; g.stroke();
      g.fillStyle = zn.color || '#64748B'; rr(x - w / 2 + 10, y - 36, 10, 10, 3); g.fill();
      g.fillStyle = '#0F172A'; g.font = font(800, 14); g.fillText(t, x - w / 2 + 26, y - 27);
      g.fillStyle = '#475569'; g.font = font(700, 12.5); g.fillText(t2, x - w / 2 + 12, y - 11);
    }
    // หมุด TOP วาดท้ายสุด = อยู่บนป้ายโซนเสมอ (เหมือนบนจอ)
    for (const m of machines) if (m.data && m.data.top && m === byId.get(m.id)) { const [x, y] = proj(m.cx, m.ymax + 3, m.cz); pin(x, y - 17, m.data.top); }
    for (const L of lines) { const rk = P.lineTop && P.lineTop[L.id]; if (rk) { const [x, y] = proj(L.cx, 6, L.cz); pin(x, y, rk); } }
    g.restore();
    return await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
  }

  /* ── API ── */
  // สลับสาย (layout เปลี่ยน) = ฉากจาง → สร้างฉากใหม่ → พอดีจอ · ข้อมูลเปลี่ยน (วันที่/กะ) = สี/คนเปลี่ยนแบบ animation
  let relayTok = 0;
  function update(p, o = {}) {
    if (disposed || !p) return;
    Plive = p;
    if (p.layoutKey !== layoutKey || !lay) {
      if (tl) { tlPlay(false); tl = null; tlEl.classList.remove('on'); tlEl.innerHTML = ''; }
      const had = !!lay, tok = ++relayTok;
      const go = async () => {
        if (tok !== relayTok || disposed) return;
        filter = 'all'; qIn.value = '';
        building = true;
        const tb = performance.now();
        const ok = await buildLayout(Plive, tok);
        if (!ok) return;                          // มีการสลับสายใหม่ทับ → งานชุดใหม่ทำต่อเอง
        building = false;
        applyData(Plive, false);                  // Plive = ชุดล่าสุด (ข้อมูลที่มาระหว่างสร้างฉากก็ได้ใช้)
        lastBuildMs = performance.now() - tb;
        if (sized) { resetView(false); fitted = true; if (pendingFly) flyPending(); }
        warmShaders();
        if (had) setTimeout(() => fadeEl.classList.remove('on'), 60);
        kick();
      };
      layoutKey = p.layoutKey;
      if (had) { fadeEl.classList.add('on'); setTimeout(go, 200); } else go();
      return;
    }
    if (building) return;                         // กำลังสร้างฉาก → ข้อมูลเก็บใน Plive ไว้ใช้ตอนสร้างเสร็จ
    if (tl) return;                               // โหมดย้อนดู: คงภาพกะที่เลือกไว้ · ข้อมูลสดเก็บใน Plive ใช้ตอนกด "กลับ"
    applyData(p, o.animate !== false);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf); clearTimeout(statsIdleT);
    if (tl) clearInterval(tl.timer);
    io.disconnect(); ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    controls.dispose();
    clearLayout();
    clearGeoCache();
    for (const k in mats) mats[k].dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) {}
    root.remove();
  }
  measure();
  // ตรวจสอบจาก DevTools — ❗ห้ามใส่ THREE (ทั้ง namespace) ตรงนี้: build รวม Three.js เป็นไฟล์เดียวจะตัดส่วนที่ไม่ใช้ทิ้งไม่ได้ (807 KB)
  root._dbg = { renderer, scene, camera, sun, controls, mats, Vector3: THREE.Vector3, get machines() { return machines; },
    get flags() { return { building, compiling, compiled, live, ioVis, sized, raf, fitted, dpr, lay: !!lay, layoutKey }; } };
  return {
    update, focus, focusZone, zoom, resetView: () => resetView(true), rotate90, topView, dispose, snapshot,
    setStrings(s) { S = s || S; hudTitles(); },
    setLabels(on) { showLbl = !!on; applyLblVis(); kick(); },
    resize() { measure(); kick(); },
    get root() { return root; },
  };
}
