/* ============================================================
   VSM4 Service Worker — ★ v3.81 (2026-10-15)
   เป้า: "เปิดซ้ำ ≤ 1 วิ" + เปิดแอปได้แม้ไม่มีเน็ต
   • หน้าแอป (index.html) = ส่งจาก cache ทันที แล้วเช็คของใหม่จากเว็บเบื้องหลัง (stale-while-revalidate)
       มีรุ่นใหม่ → เก็บลง cache + บอกหน้าเว็บ (แถบ "🆕 มีเวอร์ชันใหม่ — แตะเพื่อโหลด")
       เปิดครั้งถัดไป = ได้รุ่นใหม่เอง · ยังไม่มี cache (ครั้งแรก) = โหลดจากเว็บตามปกติ
   • ฟอนต์ Google + ไลบรารี Excel/กล้อง (URL ผูกเวอร์ชันตายตัว) = cache-first
   • อย่างอื่นทั้งหมด (API ของ Worker ฯลฯ) = ไม่แตะเลย ปล่อยผ่านตามปกติ
   ทางหนีไฟ: เปิด ...?nosw=1 → หน้าเว็บถอน SW + ล้าง cache นี้ให้ (ดูสคริปต์ใน index.html)
   ❗เปลี่ยนวิธีทำงานของไฟล์นี้ = ขยับ SHELL/RUNTIME version ด้วย (activate จะลบ cache รุ่นเก่า)
   ============================================================ */
const SHELL   = 'vsm4-shell-v1';     // หน้าแอป
const RUNTIME = 'vsm4-static-v1';    // ฟอนต์ / ไลบรารีจาก CDN
const SCOPE   = new URL(self.registration.scope);

// หน้าแอปเท่านั้น (ราก scope หรือ index.html) — ไฟล์อื่นในโฟลเดอร์ (indexV0.9.html, backups/…) ไม่ยุ่ง
const isAppPage = url => url.origin === SCOPE.origin
  && (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html');
const isStatic = url =>
  url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'
  || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/xlsx@0.18.5/'))
  || (url.hostname === 'unpkg.com' && url.pathname.startsWith('/html5-qrcode@2.3.8/'));

self.addEventListener('install', e => {
  // เก็บหน้าแอปที่เพิ่งโหลดไว้ทันที (ส่วนใหญ่ได้จาก HTTP cache ของเบราว์เซอร์ ไม่ต้องโหลดซ้ำ)
  e.waitUntil(caches.open(SHELL).then(c => c.add(new Request(SCOPE.href, { cache: 'default' }))).catch(() => {}).then(() => self.skipWaiting()));
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
  if (isStatic(url)) { e.respondWith(cacheFirst(req)); return; }
});

async function appPage(e) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(SCOPE.href);
  if (!cached) {                                   // ครั้งแรก = จากเว็บตามปกติ แล้วเก็บไว้
    const res = await fetch(e.request);
    if (res && res.ok) e.waitUntil(cache.put(SCOPE.href, res.clone()).catch(() => {}));
    return res;
  }
  // ส่งของใน cache ทันที · เช็ครุ่นใหม่เบื้องหลัง (ใช้สำเนา — ตัวที่ส่งให้หน้าเว็บถูกอ่านไปแล้ว อ่านซ้ำไม่ได้)
  e.waitUntil(revalidate(cache, cached.clone(), e.resultingClientId));
  return cached;
}
async function revalidate(cache, cached, newClientId) {
  try {
    const res = await fetch(new Request(SCOPE.href, { cache: 'no-cache' }));   // ถามเว็บว่ามีของใหม่ไหม (ไม่เปลี่ยน = 304 เบา ๆ)
    if (!res || !res.ok) return;
    const [a, b] = await Promise.all([res.clone().text(), cached.text()]);
    if (a === b) return;
    await cache.put(SCOPE.href, res);
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'vsm4-update' });
    /* หน้าที่กำลังเปิดอยู่ (คนที่ทำให้เจอรุ่นใหม่) อาจยังสร้างไม่เสร็จตอนเช็คเสร็จ (เน็ตเร็ว) → matchAll ยังไม่เห็น
       รอหน้านั้นพร้อมแล้วค่อยบอก (สูงสุด ~15 วิ) — ข้อความที่ส่งก่อนหน้าโหลดเสร็จ เบราว์เซอร์เก็บคิวไว้ให้เอง */
    for (let i = 0; newClientId && i < 30; i++) {
      const c = await self.clients.get(newClientId);
      if (c) { c.postMessage({ type: 'vsm4-update' }); break; }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) { /* ออฟไลน์ = ใช้ของใน cache ต่อ */ }
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
