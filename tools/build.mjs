/* ============================================================
   Deploy-time build (v3.92) — runs in .github/workflows/static.yml, output = _site/ (what GitHub Pages serves)
   index.html stays the ONE file people edit (works as-is when opened directly or served by the Worker).
   Only the published copy is transformed:
     1. main inline <script> (~2.4 MB, mostly Thai comments) → assets/app.<hash>.js, minified (−45% gzip)
        • requested right after the first frame is painted → the lock card / skeleton shows before 1.3 MB of JS
          is compiled and run (the old inline script had to finish before anything could paint)
        • off-main-thread streaming compile + V8 code cache on repeat visits (inline scripts get neither)
        • HTML shrinks to ~50 KB gzip
        • hashed name = cache forever; the Service Worker pre-caches it (sw.js)
     2. inline <style> minified (stays inline: no extra round trip before first paint)
     3. HTML comments stripped (markup only; script/style untouched)
     4. sw.js stamped with the build hash → every deploy installs a new Service Worker that pre-caches the new pair
   Safety: fails (no deploy) if minification renames any top-level function/variable — inline onclick="…"
           handlers and the other inline scripts use them by name.
   Local check:  npm ci && npm run build   → serve _site/ with any static server
   ============================================================ */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '_site');
const kb = n => (n / 1024).toFixed(1) + ' KB';
const sizes = buf => `${kb(buf.length)} · gzip ${kb(zlib.gzipSync(buf, { level: 9 }).length)}`;
const fail = msg => { console.error('✗ build: ' + msg); process.exit(1); };
const reEsc = s => s.replace(/[$]/g, '\\$');

// 1) publish the same files the old "upload whole repo" step did (tracked files), minus build tooling
fs.rmSync(OUT, { recursive: true, force: true });
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);
const NOT_PUBLISHED = /^(\.github\/|tools\/|package(-lock)?\.json$|\.gitignore$)/;
for (const f of tracked) {
  if (NOT_PUBLISHED.test(f)) continue;
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// 1b) v3.97 3D floor map: floor3d/floor3d.js is a separate ES module (imported only when the 3D view opens)
//     → bundled WITH Three.js (npm devDependency, tree-shaken) into ONE minified file served from our own domain
//       (unbuilt index.html loads Three.js from jsDelivr via the import map — 7 files, 2 origins; on slow 4G that cost
//        an extra connection + a chain of imports) · the npm version must equal the import-map version (checked here)
//     → its hash is stamped into the main script (F3D_VER) so the URL changes every version
//       (?v=<hash> = the Service Worker can cache it forever, one version at a time; F3D_VER set = "bundled" for the app)
let f3dHash = '';
const f3dOut = path.join(OUT, 'floor3d', 'floor3d.js');
if (fs.existsSync(f3dOut)) {
  const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mapVer = (srcHtml.match(/npm\/three@([\d.]+)\/build\/three\.module/) || [])[1];
  const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'three', 'package.json'), 'utf8')).version;
  if (!mapVer || mapVer !== pkgVer) fail(`three version mismatch: import map ${mapVer} vs npm ${pkgVer} (keep both the same)`);
  const r = await esbuild.build({ entryPoints: [f3dOut], bundle: true, format: 'esm', minify: true, write: false, charset: 'utf8',
    legalComments: 'eof', logLevel: 'silent', absWorkingDir: ROOT, nodePaths: [path.join(ROOT, 'node_modules')] });
  for (const w of r.warnings) console.warn('  esbuild floor3d:', w.text);
  const code = r.outputFiles[0].text;
  if (/from\s*["']three/.test(code)) fail('floor3d bundle still imports "three" (bundling failed)');
  fs.writeFileSync(f3dOut, code);
  f3dHash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 10);
}

// 2) index.html
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const before = Buffer.from(html);

// 2a) the main app script = the largest attribute-less inline <script>
let main = null;
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) if (!main || m[1].length > main[1].length) main = m;
if (!main || main[1].length < 500000) fail('main inline <script> not found');
let src = main[1];
if (f3dHash) {
  const ph = "const F3D_VER = '__F3D_VER__';";
  if (src.split(ph).length !== 2) fail('F3D_VER placeholder not found exactly once (floor3d/floor3d.js would never be cache-busted)');
  src = src.replace(ph, `const F3D_VER = '${f3dHash}';`);
}
// v3.93: a function's source pasted into HTML (onclick="(${fn.toString()})(…)") breaks once minified — esbuild
// rewrites '…' as "…", which closes the attribute early (every autocomplete died this way in v3.92)
const fnSrcInHtml = src.match(/\(\$\{[^}]*\.toString\(\)\}\)\(/);
if (fnSrcInHtml) fail('function source embedded in HTML (breaks after minify): ' + fnSrcInHtml[0]);
const js = await esbuild.transform(src, { loader: 'js', minify: true, charset: 'utf8', legalComments: 'none', logLevel: 'silent' });
for (const w of js.warnings) console.warn('  esbuild:', w.text);
// top-level names must survive (called from inline handlers / other inline scripts / templates)
const missing = [];
for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
  if (!new RegExp('function\\s*\\*?\\s*' + reEsc(m[1]) + '\\s*\\(').test(js.code)) missing.push(m[1]);
}
for (const m of src.matchAll(/^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)) {
  if (!new RegExp('(^|[^\\w$.])' + reEsc(m[1]) + '\\s*[=;,]').test(js.code)) missing.push(m[1]);
}
if (missing.length) fail('top-level names renamed/dropped by minifier: ' + missing.slice(0, 20).join(', '));
const hash = crypto.createHash('sha256').update(js.code).digest('hex').slice(0, 10);
const appName = `assets/app.${hash}.js`;
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(OUT, appName), js.code);

// 2b) loader in the old script's place (end of <body>): request the app script once the first contentful
//     paint has happened (PerformanceObserver 'paint') — the lock card / skeleton is on screen first and the
//     50 KB page gets the whole 4G link before the 370 KB script starts competing for it.
//     Fallbacks: no paint-timing support → after the first animation frame; 1.5 s timer (background tab).
//     A dynamically added script runs as soon as it arrives — the app code copes with running after
//     DOMContentLoaded (see _onReady / warnFull in index.html). Load failure → red bar with retry.
const loader = `<script>
(function () {
  var done = 0;
  function go() {
    if (done) return; done = 1;
    var s = document.createElement('script');
    s.src = '${appName}';
    s.onerror = function () {
      var b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#DC2626;color:#fff;font:700 14px/1.4 system-ui,sans-serif;padding:14px;text-align:center;cursor:pointer';
      b.textContent = '⚠️ โหลดแอปไม่สำเร็จ (เน็ต?) — แตะเพื่อลองใหม่';
      b.onclick = function () { location.reload(); };
      document.body.appendChild(b);
    };
    document.body.appendChild(s);
  }
  try {
    new PerformanceObserver(function (list, obs) {
      if (list.getEntries().some(function (e) { return e.name === 'first-contentful-paint'; })) { obs.disconnect(); setTimeout(go, 0); }
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { requestAnimationFrame(function () { setTimeout(go, 0); }); }
  setTimeout(go, 1500);
})();
</script>`;
html = html.slice(0, main.index) + loader + html.slice(main.index + main[0].length);

// 2c) minify the inline CSS
const sm = html.match(/<style>([\s\S]*?)<\/style>/);
if (!sm) fail('<style> not found');
const css = await esbuild.transform(sm[1], { loader: 'css', minify: true, charset: 'utf8', logLevel: 'silent' });
for (const w of css.warnings) console.warn('  esbuild css:', w.text);
html = html.replace(sm[0], () => `<style>${css.code.trim()}</style>`);

// 2d) strip HTML comments outside <script>/<style>/<noscript>
html = html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>)/)
  .map((part, i) => (i % 2 ? part : part.replace(/<!--[\s\S]*?-->/g, '')))
  .join('');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 3) sw.js: stamp the build → every deploy is a new Service Worker version, whose install pre-caches the new
//    page + app script together (and lets Chrome build the V8 code cache for it right away)
const swPath = path.join(OUT, 'sw.js');
fs.writeFileSync(swPath, `/* build ${hash} */\n` + fs.readFileSync(swPath, 'utf8'));

const after = Buffer.from(html), app = Buffer.from(js.code);
console.log('index.html  before', sizes(before));
console.log('index.html  after ', sizes(after));
console.log(appName.padEnd(26), sizes(app), `(source ${kb(Buffer.byteLength(src))})`);
if (f3dHash) console.log(`floor3d/floor3d.js?v=${f3dHash}`.padEnd(26), sizes(fs.readFileSync(f3dOut)));
console.log('✓ _site ready —', tracked.length, 'tracked files scanned');
