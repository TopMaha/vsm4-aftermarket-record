/* ============================================================
   VSM4 Service Worker — ★ v3.81 (2026-10-15) · ★ v3.92 (2026-10-21) app shell = หน้า + ไฟล์สคริปต์แอป
   เป้า: "เปิดซ้ำ ≤ 1 วิ" + เปิดแอปได้แม้ไม่มีเน็ต
   • หน้าแอป (index.html) = ส่งจาก cache ทันที แล้วเช็คของใหม่จากเว็บเบื้องหลัง (stale-while-revalidate)
       มีรุ่นใหม่ → โหลดไฟล์ assets/* ที่หน้าใหม่ใช้ให้ครบก่อน → ค่อยเก็บหน้าใหม่ + บอกหน้าเว็บ
       (แถบ "🆕 มีเวอร์ชันใหม่ — แตะเพื่อโหลด") · เปิดครั้งถัดไป = ได้รุ่นใหม่เอง
       ⇒ หน้าใน cache กับสคริปต์ที่มันเรียกตรงกันเสมอ (ไม่มีทางได้หน้าใหม่ + สคริปต์เก่า/หาย)
   • assets/app.<hash>.js (สร้างตอน deploy โดย tools/build.mjs) = ชื่อผูก hash ไม่มีวันเปลี่ยนเนื้อ → cache-first
       เก็บตั้งแต่ตอน install → Chrome ทำ code cache ของ V8 ไว้ให้ทันที (เปิดรอบหน้าไม่ต้องแปลงสคริปต์ใหม่)
       รุ่นเก่าที่หน้าใน cache ไม่ได้ใช้แล้ว ลบทิ้งตอนเก็บรุ่นใหม่
   • ฟอนต์ Google + ไลบรารี Excel/กล้อง/Three.js (URL ผูกเวอร์ชันตายตัว) = cache-first
   • ★ v3.97 ผัง 3D: floor3d/floor3d.js?v=<hash ที่ build ประทับ> = cache-first ตามรุ่น (เก็บรุ่นล่าสุดรุ่นเดียว)
       → เปิดโหมด 3D ครั้งแรกตอนมีเน็ตแล้ว ครั้งต่อไปเปิดได้แม้ออฟไลน์
   • อย่างอื่นทั้งหมด (API ของ Worker ฯลฯ) = ไม่แตะเลย ปล่อยผ่านตามปกติ
   ทางหนีไฟ: เปิด ...?nosw=1 → หน้าเว็บถอน SW + ล้าง cache นี้ให้ (ดูสคริปต์ใน index.html)
   ❗เปลี่ยนวิธีทำงานของไฟล์นี้ = ขยับ SHELL/RUNTIME version ด้วย (activate จะลบ cache รุ่นเก่า)
     (v3.92 คงชื่อ SHELL เดิมโดยตั้งใจ: หน้าเก่าใน cache เป็นแบบสคริปต์ในตัว ใช้ต่อได้ครบ → อัปเกรดแล้วยังเปิดจาก cache ได้ทันที)
   ============================================================ */
const SHELL   = 'vsm4-shell-v1';     // หน้าแอป + assets/* ที่หน้านั้นใช้
const RUNTIME = 'vsm4-static-v1';    // ฟอนต์ / ไลบรารีจาก CDN
const SCOPE   = new URL(self.registration.scope);

// หน้าแอปเท่านั้น (ราก scope หรือ index.html) — ไฟล์อื่นในโฟลเดอร์ (indexV0.9.html, backups/…) ไม่ยุ่ง
const isAppPage = url => url.origin === SCOPE.origin
  && (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html');
const isAsset = url => url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname + 'assets/');
const isStatic = url =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'
  || (url.hostname === 'cdn.jsdelivr.net' && (url.pathname.startsWith('/npm/xlsx@0.18.5/') || url.pathname.startsWith('/npm/three@0.186.1/')))
  || (url.hostname === 'unpkg.com' && url.pathname.startsWith('/html5-qrcode@2.3.8/'));
// ผัง 3D รุ่นที่ build ประทับ hash แล้วเท่านั้น (สำเนาที่ยังไม่ build ใช้ ?v=<เวลา> → ไม่เก็บ ได้ไฟล์ล่าสุดเสมอ)
const isF3d = url => url.origin === SCOPE.origin && url.pathname === SCOPE.pathname + 'floor3d/floor3d.js' && /^\?v=[0-9a-f]{10}$/.test(url.search);
// assets ที่หน้า HTML เรียกใช้ (src="assets/…" / href="assets/…") → URL เต็ม
const assetsOf = html => [...new Set([...html.matchAll(/(?:src|href)="(assets\/[^"?#]+)"/g)].map(m => new URL(m[1], SCOPE).href))];

self.addEventListener('install', e => {
  // เก็บหน้าแอป + สคริปต์ที่หน้านั้นใช้ไว้ทันที (ส่วนใหญ่ได้จาก HTTP cache ของเบราว์เซอร์ ไม่ต้องโหลดซ้ำ)
  e.waitUntil(refreshShell('default').catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, RUNTIME]);
    for (const k of await caches.keys()) if (k.startsWith('vsm4-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && isAppPage(url)) { e.respondWith(appPage(e)); return; }
  if (isAsset(url)) { e.respondWith(assetFirst(req)); return; }
  if (isF3d(url)) { e.respondWith(f3dFirst(req)); return; }
  if (isStatic(url)) { e.respondWith(cacheFirst(req)); return; }
});

async function appPage(e) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(SCOPE.href);
  if (!cached) {                                   // ครั้งแรก = จากเว็บตามปกติ แล้วเก็บไว้ (พร้อมสคริปต์ที่หน้าใช้)
    const res = await fetch(e.request);
    if (res && res.ok) e.waitUntil(storeShell(cache, res.clone(), null).catch(() => {}));
    return res;
  }
  // ส่งของใน cache ทันที · เช็ครุ่นใหม่เบื้องหลัง
  e.waitUntil(refreshShell('no-cache', e.resultingClientId).catch(() => {}));
  return cached;
}
/* ถามเว็บว่าหน้าแอปเปลี่ยนไหม (ไม่เปลี่ยน = 304 เบา ๆ) → เปลี่ยน = เก็บ assets ใหม่ให้ครบก่อน แล้วค่อยเก็บหน้าใหม่ + บอกหน้าเว็บ */
async function refreshShell(mode, newClientId) {
  const cache = await caches.open(SHELL);
  const res = await fetch(new Request(SCOPE.href, { cache: mode }));
  if (!res || !res.ok) return;
  const old = await cache.match(SCOPE.href);
  const changed = await storeShell(cache, res, old);
  if (!changed || !old) return;                    // ไม่มีอะไรใหม่ / ครั้งแรก (ไม่ต้องเตือน)
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'vsm4-update' });
  /* หน้าที่กำลังเปิดอยู่ (คนที่ทำให้เจอรุ่นใหม่) อาจยังสร้างไม่เสร็จตอนเช็คเสร็จ (เน็ตเร็ว) → matchAll ยังไม่เห็น
     รอหน้านั้นพร้อมแล้วค่อยบอก (สูงสุด ~15 วิ) — ข้อความที่ส่งก่อนหน้าโหลดเสร็จ เบราว์เซอร์เก็บคิวไว้ให้เอง */
  for (let i = 0; newClientId && i < 30; i++) {
    const c = await self.clients.get(newClientId);
    if (c) { c.postMessage({ type: 'vsm4-update' }); break; }
    await new Promise(r => setTimeout(r, 500));
  }
}
// คืน true = เก็บหน้าใหม่แล้ว · assets โหลดไม่ครบ = ไม่เก็บอะไรเลย (คงคู่เดิมไว้ ลองใหม่รอบหน้า)
async function storeShell(cache, res, old) {
  const html = await res.clone().text();
  if (old && html === await old.clone().text()) return false;
  const want = assetsOf(html);
  for (const u of want) {
    if (await cache.match(u)) continue;
    const a = await fetch(u);
    if (!a || !a.ok) throw new Error('asset ' + u);
    await cache.put(u, a);
  }
  await cache.put(SCOPE.href, res);
  for (const k of await cache.keys()) if (isAsset(new URL(k.url)) && !want.includes(k.url)) await cache.delete(k);
  return true;
}
async function assetFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req.url.split('?')[0], res.clone()).catch(() => {});
  return res;
}
async function f3dFirst(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) {
    const copy = res.clone();
    (async () => {
      for (const k of await cache.keys()) if (k.url !== req.url && isF3d(new URL(k.url))) await cache.delete(k);
      await cache.put(req, copy);
    })().catch(() => {});
  }
  return res;
}
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // เก็บเฉพาะคำตอบแบบ CORS (opaque ถูกนับโควตาพองหลาย MB ต่อไฟล์) — CSS ฟอนต์ที่โหลดแบบ no-cors ใช้ HTTP cache ตามเดิม
  if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}
