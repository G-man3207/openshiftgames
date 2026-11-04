#!/usr/bin/env node
/**
 * OpenShift Games — visual QA + responsive regression harness.
 *
 * Captures the start page at five viewports, walks its sections, captures every
 * major in-game UI state at 1600x900, and records console/page errors, layout
 * overflow and cheap text-collision checks. Writes screenshots, report.json and
 * summary.md so round-to-round comparisons are mechanical.
 *
 * The repo stays dependency-free: puppeteer-core is loaded from an out-of-repo
 * install (same pattern as scripts/browser-test.mjs). Prepare once with:
 *   mkdir -p /tmp/verify-tools && cd /tmp/verify-tools && npm init -y && npm i puppeteer-core@23
 * (or point PUPPETEER_CORE_DIR at any directory containing node_modules/puppeteer-core)
 *
 * Usage:
 *   node scripts/visual-qa.mjs [--out=.taste-skill/qa/round-1]
 *                              [--only=start,game,responsive]
 *                              [--strict] [--headful]
 *
 *   --out=<dir>   output directory (relative to the repo root; default
 *                 .taste-skill/qa/<YYYYMMDD-HHMMSS>/)
 *   --only=…      comma-separated subset of {start,game,responsive}; default all
 *   --strict      also exit non-zero when a UI state check fails (missing panel,
 *                 missing selector, ...). By default the exit code tracks hard
 *                 problems only: console errors, page errors, horizontal overflow
 *                 and clipped non-scrollable content.
 *   --headful     show the browser (debugging only)
 *
 * Exit code 0 = no hard problems, 1 = at least one hard problem, 2 = setup error.
 * Runtime budget: ~2-3 minutes (SwiftShader WebGL, 5 viewports + 14 game states).
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const HEADFUL = args.includes('--headful');
const STRICT = args.includes('--strict');
const ONLY = ((args.find((a) => a.startsWith('--only=')) || '').slice(7))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT_ARG = (args.find((a) => a.startsWith('--out=')) || '').slice(6);
const should = (phase) => ONLY.length === 0 || ONLY.includes(phase);
for (const phase of ONLY) {
  if (!['start', 'game', 'responsive'].includes(phase)) {
    console.error(`Unknown --only phase "${phase}". Use start,game,responsive.`);
    process.exit(2);
  }
}

const iso = new Date().toISOString();
const STAMP = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
const OUT = OUT_ARG ? resolve(ROOT, OUT_ARG) : join(ROOT, '.taste-skill', 'qa', STAMP);
const SHOTS_DIR = join(OUT, 'shots');
const relOut = (abs) => relative(ROOT, abs).replace(/\\/g, '/');

const PUPPETEER_DIR = process.env.PUPPETEER_CORE_DIR || '/tmp/verify-tools';
const require = createRequire(join(PUPPETEER_DIR, 'package.json'));
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (err) {
  console.error(`Cannot load puppeteer-core from ${PUPPETEER_DIR}. See header instructions.`);
  process.exit(2);
}
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (!existsSync(CHROME)) {
  console.error(`Chrome binary not found at ${CHROME}. Set CHROME_BIN.`);
  process.exit(2);
}

// Start-page viewport matrix. Names are used in screenshot file names.
const VIEWPORTS = [
  { name: '1600x900', width: 1600, height: 900 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
];
const GAME_VIEWPORT = { width: 1600, height: 900 };

// ── Static server (same contract as scripts/browser-test.mjs) ─────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file = decodeURIComponent(url.pathname);
    if (file === '/') file = '/index.html';
    if (file === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (file === '/draw') file = '/draw.html';
    const full = join(ROOT, file);
    if (!full.startsWith(ROOT) || !existsSync(full)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const data = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      // The app is edited between rounds; never let Chrome cache a stale shell.
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

await mkdir(SHOTS_DIR, { recursive: true });

// ── App provenance (which revision / which uncommitted files this run saw) ─
function gitInfo() {
  const rev = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  const dirty = (status.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(\?\?|\s*[A-Z!]{1,2})\s+/, ''))
    .filter((f) => !f.startsWith('.taste-skill/') && !f.startsWith('docs/'));
  return {
    head: (rev.stdout || '').trim() || 'unknown',
    dirtyFiles: dirty.slice(0, 40),
    dirtyCount: dirty.length,
  };
}
const APP = gitInfo();
const APP_VERSION = (() => {
  try {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<title>([^<]*)<\/title>/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
})();

// ── Bookkeeping ────────────────────────────────────────────────────────────
const startedAt = new Date();
const checks = []; // {state, name, pass, detail}
const warnings = [];
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const screenshots = [];
const pageCrashes = [];
let currentState = 'setup';
// Renderer crashes under SwiftShader produce rejected promises from an aborted
// evaluate. A harness must report them, not die on them mid-run.
process.on('unhandledRejection', (reason) => {
  const text = String(reason?.message || reason);
  warnings.push({ state: currentState, name: 'unhandled rejection (recovered)', detail: text.slice(0, 400) });
  console.error(`\n  WARN  unhandled rejection during "${currentState}": ${text.slice(0, 220)}`);
});

function state(name) {
  currentState = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 68 - name.length))}`);
}
function check(name, pass, detail) {
  const row = { state: currentState, name, pass: Boolean(pass), detail: detail === undefined ? undefined : String(detail).slice(0, 600) };
  checks.push(row);
  const mark = row.pass ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${row.detail !== undefined && !row.pass ? ` — ${row.detail}` : ''}`);
  return row.pass;
}
function warn(name, detail) {
  const row = { state: currentState, name, detail: detail === undefined ? undefined : String(detail).slice(0, 600) };
  warnings.push(row);
  console.log(`  WARN  ${name}${row.detail ? ` — ${row.detail}` : ''}`);
}
function isIgnorableConsole(text) {
  return (
    /favicon/i.test(text) ||
    /Failed to load resource.*(api\.github\.com|github\.com)/i.test(text) ||
    /Failed to load resource.*(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/i.test(text) ||
    /net::ERR_(FAILED|ABORTED|NAME_NOT_RESOLVED|BLOCKED_BY_CLIENT)/i.test(text) ||
    /cdn\.tailwindcss\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(text) ||
    /WebGL|GPU stall|Third-party cookie|Download the React DevTools/i.test(text) ||
    /The resource .* was preloaded using link preload/i.test(text) ||
    /Failed to load resource: the server responded with a status of 403/i.test(text)
  );
}
function isIgnorableRequest(url, errorText) {
  return (
    /favicon\.ico/i.test(url) ||
    /(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|api\.github\.com|github\.com)/i.test(url) ||
    /net::ERR_(FAILED|ABORTED|NAME_NOT_RESOLVED|BLOCKED_BY_CLIENT)/i.test(errorText || '')
  );
}

// ── Browser ────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--disable-gpu-watchdog',
    '--disable-renderer-backgrounding',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const CHROME_VERSION = await browser.version();
const page = await browser.newPage();
await page.setViewport({ ...GAME_VIEWPORT, deviceScaleFactor: 1 });
const navigations = [];
page.on('framenavigated', (frame) => {
  if (frame !== page.mainFrame()) return;
  const row = { state: currentState, url: frame.url(), at: Date.now() };
  navigations.push(row);
  if (navigations.length > 60) navigations.shift();
});
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
page.on('console', (msg) => {
  const text = msg.text();
  const type = msg.type();
  if (type === 'error') {
    if (!isIgnorableConsole(text)) {
      const loc = msg.location?.() || {};
      consoleErrors.push({ state: currentState, text, url: loc.url || '', line: loc.lineNumber });
    }
  } else if (type === 'warning') {
    if (!isIgnorableConsole(text)) consoleWarnings.push({ state: currentState, text });
  }
});
page.on('pageerror', (err) => pageErrors.push({ state: currentState, text: String(err).slice(0, 800) }));
page.on('error', (err) => {
  pageCrashes.push({ state: currentState, text: String(err?.message || err).slice(0, 400) });
  console.error(`\n  WARN  page/renderer crashed during "${currentState}"`);
});
async function recoverPage() {
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(800);
    return true;
  } catch {
    return false;
  }
}
page.on('requestfailed', (req) => {
  const url = req.url();
  const errText = req.failure()?.errorText || '';
  if (!isIgnorableRequest(url, errText)) {
    warnings.push({ state: currentState, name: 'request failed', detail: `${url} ${errText}`.slice(0, 400) });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 12000, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* page may be navigating */
    }
    await sleep(interval);
  }
  return false;
}
const evaluate = (fn, ...a) => page.evaluate(fn, ...a);
async function goto(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(400);
}
async function shot(name, opts = {}) {
  const rel = `shots/${name}.png`;
  try {
    const screenshotOpts = { path: join(OUT, rel), fullPage: Boolean(opts.fullPage), optimizeForSpeed: true };
    if (opts.clipHeight) {
      // Capture beyond the viewport once the fixed overlay has been expanded.
      const vp = page.viewport();
      screenshotOpts.captureBeyondViewport = true;
      screenshotOpts.clip = { x: 0, y: 0, width: vp.width, height: Math.min(opts.clipHeight, 14000) };
    }
    await page.screenshot(screenshotOpts);
    screenshots.push({ name, path: `${relOut(OUT)}/${rel}`, fullPage: Boolean(opts.fullPage), state: currentState });
    return `${relOut(OUT)}/${rel}`;
  } catch (err) {
    warn(`screenshot failed: ${name}`, err.message);
    return null;
  }
}
async function elementShot(selector, name) {
  const el = await page.$(selector);
  if (!el) {
    warn(`element screenshot missing: ${selector}`, name);
    return null;
  }
  const rel = `shots/${name}.png`;
  try {
    await el.screenshot({ path: join(OUT, rel), optimizeForSpeed: true });
    screenshots.push({ name, path: `${relOut(OUT)}/${rel}`, state: currentState, element: selector });
    return `${relOut(OUT)}/${rel}`;
  } catch (err) {
    warn(`element screenshot failed: ${selector}`, err.message);
    return null;
  }
}

// ── Generic page probes (serialised into the browser) ─────────────────────
/** Scroll/overflow/rect/clipping/overlap scan for the current document. */
async function probeLayout(rootSelector) {
  return evaluate((rootSel) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const doc = document.documentElement;
    const root = (rootSel && document.querySelector(rootSel)) || document.body;
    const describe = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        tag: el.id ? `${tag}#${el.id}` : `${tag}.${String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`.slice(0, 80),
        text: text.slice(0, 90),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        position: cs.position,
        interactive: Boolean(el.closest('a,button,input,select,textarea,summary,[role="button"],[role="link"],[tabindex]')),
      };
    };
    const isVisible = (el) => {
      if (!el || el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // Accessibility skip links are parked far off-canvas until focused
    // (`left:-9999px`), which is correct, not an overflow bug.
    const offCanvasByDesign = (el, r) => {
      const parked = r.right < -1000 || r.left > vw + 1000;
      if (parked) return Boolean(el.matches?.('a[href^="#"]') || el.getAttribute('aria-hidden') === 'true');
      // Slide-in drawers / bottom docks are parked off the viewport with a
      // CSS transform while hidden (inspector translate-x-full, incident
      // panel, terminal translate-y). That is the closed state, not overflow.
      const fullyOutside = r.right <= 2 || r.left >= vw - 2 || r.bottom <= 2 || r.top >= vh - 2;
      if (!fullyOutside) return false;
      let node = el;
      for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
        if (node === document.documentElement) break;
        const cs = getComputedStyle(node);
        if (cs.transform && cs.transform !== 'none') return true;
        if (node.getAttribute?.('aria-hidden') === 'true') return true;
      }
      return false;
    };
    const canScrollTo = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        const scrollable = /(auto|scroll|overlay)/.test(cs.overflowY);
        if (scrollable && node.scrollHeight > node.clientHeight + 2) return true;
        node = node.parentElement;
      }
      return doc.scrollHeight > doc.clientHeight + 2 || /(auto|scroll)/.test(getComputedStyle(document.body).overflowY);
    };
    const pageScrollable = doc.scrollHeight > vh + 2 || /(auto|scroll|overlay)/.test(getComputedStyle(document.body).overflowY) || /(auto|scroll|overlay)/.test(getComputedStyle(doc).overflowY);

    const all = [...root.querySelectorAll('*')].slice(0, 2500);
    // Horizontal overflow candidates: visible fixed/absolute elements that cross
    // a viewport edge. Decorative glows are recorded as info; anything with text
    // or interaction is a failure candidate.
    const overflowCandidates = [];
    const ignoredOffCanvas = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (offCanvasByDesign(el, r)) {
        if (ignoredOffCanvas.length < 6) ignoredOffCanvas.push(describe(el));
        continue;
      }
      const overRight = r.right > vw + 2;
      const overLeft = r.left < -2;
      if (!overRight && !overLeft) continue;
      const info = describe(el);
      info.overflow = overRight ? `right +${Math.round(r.right - vw)}px` : `left ${Math.round(r.left)}px`;
      info.decorative = !info.interactive && (!info.text || el.getAttribute('aria-hidden') === 'true');
      overflowCandidates.push(info);
    }
    // Text-bearing elements that cross the viewport edge (regardless of position).
    const textOverflow = [];
    const textCandidates = [...root.querySelectorAll('a,button,h1,h2,h3,h4,h5,p,li,label,input,select,textarea,summary,code,[role="button"],[role="link"],[tabindex]')].slice(0, 600);
    for (const el of textCandidates) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (offCanvasByDesign(el, r)) continue;
      if (r.right > vw + 2 || r.left < -2) textOverflow.push(describe(el));
    }
    // Clipped content: below/above the fold while nothing can scroll to reveal it.
    const clipped = [];
    if (!pageScrollable) {
      for (const el of textCandidates) {
        if (!isVisible(el)) continue;
        if (canScrollTo(el)) continue;
        const r = el.getBoundingClientRect();
        if (offCanvasByDesign(el, r)) continue;
        if (r.bottom > vh + 2 || r.top < -2) {
          const info = describe(el);
          info.clip = r.bottom > vh + 2 ? `bottom +${Math.round(r.bottom - vh)}px` : `top ${Math.round(r.top)}px`;
          clipped.push(info);
        }
      }
    }
    // Cheap text collision check on per-line text rects. Element bounding boxes
    // of inline elements spanning several lines produce false positives, so use
    // Range.getClientRects() and only compare line boxes from different subtrees.
    const leafText = [];
    for (const el of all) {
      if (leafText.length >= 140) break;
      if (!isVisible(el)) continue;
      if (el.closest('svg') || el.closest('canvas') || el.closest('[aria-hidden="true"]')) continue;
      const hasDirectText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!hasDirectText) continue;
      let rects = [];
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        rects = [...range.getClientRects()].filter((r) => r.width > 4 && r.height > 4).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, area: r.width * r.height }));
      } catch {
        continue;
      }
      if (rects.length === 0) continue;
      leafText.push({ el, rects });
    }
    const overlaps = [];
    for (let i = 0; i < leafText.length && overlaps.length < 10; i += 1) {
      for (let j = i + 1; j < leafText.length && overlaps.length < 10; j += 1) {
        const a = leafText[i];
        const b = leafText[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        let hit = null;
        for (const ra of a.rects) {
          for (const rb of b.rects) {
            const iw = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const ih = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (iw <= 0 || ih <= 0) continue;
            const ratio = (iw * ih) / Math.min(ra.area, rb.area);
            if (ratio > 0.6) { hit = Number(ratio.toFixed(2)); break; }
          }
          if (hit !== null) break;
        }
        if (hit !== null) overlaps.push({ a: describe(a.el), b: describe(b.el), ratio: hit });
      }
    }
    // Scroll container that owns the start page content, if any.
    let scroller = null;
    for (const el of [root, doc, document.body, ...all]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      const delta = el.scrollHeight - el.clientHeight;
      if (delta > 4) {
        scroller = { tag: describe(el).tag, id: el.id || '', scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, delta };
        break;
      }
    }
    const watchIds = ['metrics-dashboard', 'inspector-panel', 'incident-panel', 'command-bar', 'minimap', 'resource-palette', 'objectives-panel', 'hud', 'view-toolbar', 'pause-overlay', 'desktop-notice', 'tutorial-overlay'];
    const duplicateDomIds = watchIds
      .map((id) => ({ id, count: document.querySelectorAll(`#${id}`).length }))
      .filter((entry) => entry.count > 1);
    return {
      viewport: { width: vw, height: vh },
      duplicateDomIds,
      scrollWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth || 0),
      scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight || 0),
      pageScrollable,
      scroller,
      horizontalOverflow: Math.max(doc.scrollWidth, document.body?.scrollWidth || 0) - vw,
      overflowCandidates: overflowCandidates.slice(0, 20),
      ignoredOffCanvas,
      textOverflow: textOverflow.slice(0, 20),
      clipped: clipped.slice(0, 20),
      overlaps,
      textElementsChecked: textCandidates.filter(isVisible).length,
    };
  }, rootSelector || null);
}

/** Capture the whole start page. Document-scrolling pages use fullPage; pages
 *  that scroll inside a fixed overlay (e.g. #main-menu.sp) are expanded
 *  temporarily and captured with an oversized clip. Styles are always restored. */
async function fullPageCapture(name, rootSelector, rootHeight) {
  try {
    if (rootSelector) {
      const expanded = await evaluate((rootSel) => {
        const el = document.querySelector(rootSel);
        if (!el) return null;
        const height = Math.max(el.scrollHeight, el.clientHeight);
        if (height > 14000 || height < innerHeight + 4) return { skip: true, height };
        const prev = { height: el.style.height, maxHeight: el.style.maxHeight, overflowY: el.style.overflowY };
        el.style.height = `${height}px`;
        el.style.maxHeight = 'none';
        el.style.overflowY = 'visible';
        return { skip: false, height, prev };
      }, rootSelector);
      if (expanded && !expanded.skip) {
        await sleep(250);
        const rel = await shot(name, { clipHeight: expanded.height });
        await evaluate((rootSel, prev) => {
          const el = document.querySelector(rootSel);
          if (!el) return;
          el.style.height = prev.height;
          el.style.maxHeight = prev.maxHeight;
          el.style.overflowY = prev.overflowY;
          el.scrollTop = 0;
        }, rootSelector, expanded.prev);
        await sleep(150);
        return { shot: rel, strategy: 'expanded-overlay-clip', height: expanded.height };
      }
      // Fall through to document-scrolling capture when the root did not expand.
    }
    const docInfo = await evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight }));
    if (docInfo.scrollHeight > docInfo.innerHeight + 4) {
      return { shot: await shot(name, { fullPage: true }), strategy: 'document-fullpage', height: docInfo.scrollHeight };
    }
    return { shot: null, strategy: 'not-scrollable', height: rootHeight || docInfo.innerHeight };
  } catch (err) {
    warn(`full-page capture failed: ${name}`, err.message);
    return { shot: null, strategy: 'error', error: err.message };
  }
}

/** Scroll the start page to each detected section heading/block; returns descriptors. */
async function startSectionsInfo(rootSelector) {
  return evaluate((rootSel) => {
    const root = (rootSel && document.querySelector(rootSel)) || document.body;
    const isVisible = (el) => {
      if (!el || el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const slug = (el) => {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const ident = el.id || (String(el.className || '').split(/\s+/).filter(Boolean)[0] || el.tagName);
      return (ident || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    };
    let nodes = [...root.querySelectorAll('h1,h2,h3,h4,[data-section]')].filter(isVisible);
    let source = 'headings';
    if (nodes.length === 0) {
      // Fallback for one-page layouts without semantic headings: walk the start
      // page's own top-level blocks so before/after rounds are still comparable.
      nodes = [...root.children].filter((el) => isVisible(el) && el.getBoundingClientRect().height > 20);
      source = 'blocks';
    }
    // Drop nodes that are ancestors/descendants of an earlier candidate.
    const picked = [];
    for (const el of nodes) {
      if (picked.some((p) => p === el || p.contains(el) || el.contains(p))) continue;
      picked.push(el);
    }
    return {
      source,
      count: picked.length,
      items: picked.slice(0, 8).map((el, i) => ({
        index: i,
        slug: slug(el),
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      })),
    };
  }, rootSelector || null);
}

/** Scroll to one start-page section by index; returns the resulting rect. */
async function scrollToStartSection(index) {
  return evaluate((idx) => {
    const root = document.querySelector('#main-menu') || document.querySelector('[data-start-page]') || document.body;
    const isVisible = (el) => {
      if (!el || el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    let nodes = [...root.querySelectorAll('h1,h2,h3,h4,[data-section]')].filter(isVisible);
    if (nodes.length === 0) nodes = [...root.children].filter((el) => isVisible(el) && el.getBoundingClientRect().height > 20);
    const picked = [];
    for (const el of nodes) {
      if (picked.some((p) => p === el || p.contains(el) || el.contains(p))) continue;
      picked.push(el);
    }
    const el = picked[idx];
    if (!el) return null;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch {
      el.scrollIntoView();
    }
    // Belt and braces: some engines map 'instant' through the CSS smooth rule.
    const scroller = el.closest('#main-menu') || document.scrollingElement;
    if (scroller) {
      const r = el.getBoundingClientRect();
      scroller.scrollTop = Math.max(0, scroller.scrollTop + r.top - Math.round((innerHeight - r.height) / 2));
    }
    const r = el.getBoundingClientRect();
    return {
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      scrollY: Math.round(window.scrollY),
    };
  }, index);
}

async function startPageRootSelector() {
  return evaluate(() => {
    for (const sel of ['#main-menu', '[data-start-page]', '.start-page', 'main']) {
      const el = document.querySelector(sel);
      if (el && !el.classList.contains('hidden')) return sel;
    }
    return '';
  });
}

// ── Navigation helpers ─────────────────────────────────────────────────────
async function bootMenu() {
  await goto('/');
  const ready = await waitFor(
    () =>
      evaluate(() => {
        const menu = document.querySelector('#main-menu');
        if (menu) return !menu.classList.contains('hidden');
        return Boolean(window.game?.app?.engine);
      }),
    20000,
  );
  await sleep(900);
  return ready;
}
async function launchUrl(mode, opts = {}) {
  const params = new URLSearchParams({ mode, ...(opts.level ? { level: String(opts.level) } : {}), ...(opts.challenge ? { challenge: String(opts.challenge) } : {}) });
  if (opts.tutorial0 !== false) params.set('tutorial', '0');
  await goto(`/?${params}`);
  return waitFor(() => evaluate(() => !!window.game?.app?.modeInstance), 20000);
}
async function closeOverlays() {
  try {
    await evaluate(() => {
      const app = window.game?.app;
      app?.examPrepUI?.hide?.();
      app?.manifestPanel?.hide?.();
      app?.inspector?.hide?.();
      app?.contextMenu?.hide?.();
      app?.metrics?.hide?.();
      app?.incidentPanel?.hide?.();
      app?.commandBar?.hide?.();
      app?.hud?.settingsPanel?.hide?.();
      app?.pauseUI?.hide?.();
      for (const id of ['settings-panel', 'achievements-panel', 'stats-panel', 'modal-level-complete', 'modal-game-over', 'level-select', 'challenge-select', 'pause-overlay']) {
        document.getElementById(id)?.classList.remove('active');
      }
      for (const id of ['tutorial-overlay', 'level-tutorial-overlay', 'name-prompt-overlay', 'route-target-overlay', 'selector-picker-overlay', 'ingress-path-overlay', 'scale-modal', 'edit-dialog']) {
        document.getElementById(id)?.remove();
      }
      document.activeElement?.blur?.();
    });
  } catch {
    /* page may be navigating */
  }
  await sleep(120);
}
async function pressKey(key) {
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press(key);
}

/** Record layout checks for the current page state. Failures are reported but
 *  only make the run exit non-zero for the hard criteria (see header). */
async function layoutChecks(label, rootSelector, opts = {}) {
  const probe = await probeLayout(rootSelector);
  const tag = label ? `${label}: ` : '';
  check(`${tag}no horizontal document overflow`, probe.horizontalOverflow <= 2, `scrollWidth=${probe.scrollWidth} vw=${probe.viewport.width} (+${probe.horizontalOverflow})`);
  const failTextOverflow = probe.textOverflow;
  check(`${tag}no text element crosses the viewport edge`, failTextOverflow.length === 0, JSON.stringify(failTextOverflow.slice(0, 3)));
  const failDecorative = probe.overflowCandidates.filter((el) => !el.decorative);
  check(`${tag}no fixed/absolute text or control crosses the viewport edge`, failDecorative.length === 0, JSON.stringify(failDecorative.slice(0, 3)));
  const decorative = probe.overflowCandidates.filter((el) => el.decorative);
  if (decorative.length > 0) warn(`${tag}decorative fixed/absolute element(s) extend past viewport`, JSON.stringify(decorative.slice(0, 3)));
  if ((probe.ignoredOffCanvas || []).length > 0) warn(`${tag}off-canvas accessibility skip link(s) ignored`, JSON.stringify(probe.ignoredOffCanvas.slice(0, 2)));
  if (opts.checkClipped !== false) {
    check(`${tag}no clipped content when the page cannot scroll`, probe.clipped.length === 0, JSON.stringify(probe.clipped.slice(0, 3)));
  }
  if (probe.overlaps.length > 0) warn(`${tag}possible text overlap (${probe.overlaps.length})`, JSON.stringify(probe.overlaps.slice(0, 3)));
  return probe;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1 — start page: viewport matrix, screenshots, section walk, layout
// ═══════════════════════════════════════════════════════════════════════════
const startReport = { viewports: [], sectionsSource: null, sectionsCount: 0 };
const responsiveReport = { viewports: [] };
const gameReport = { states: [] };
const duplicateIds = [];
let fatal = null;

try {
if (should('start') || should('responsive')) {
  state('start page');
  for (const vp of VIEWPORTS) {
    state(`start ${vp.name}`);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    const ready = await bootMenu();
    const title = await evaluate(() => document.title);
    const rootSelector = await startPageRootSelector();
    if (!ready) warn(`start page did not reach a ready state at ${vp.name}`);
    if (!rootSelector) warn(`no start page root (#main-menu / [data-start-page]) at ${vp.name}`);
    await evaluate(() => window.scrollTo(0, 0));
    await sleep(200);

    const viewportShot = should('start') ? await shot(`start-${vp.name}-viewport`) : null;
    const sections = should('start') ? await startSectionsInfo(rootSelector) : { source: null, count: 0, items: [] };
    if (sections.source === null) {
      // Measurement-only mode: still read section metadata without screenshots.
      sections.source = (await startSectionsInfo(rootSelector)).source;
      sections.count = (await startSectionsInfo(rootSelector)).count;
    }
    if (!startReport.sectionsSource && sections.source) {
      startReport.sectionsSource = sections.source;
      startReport.sectionsCount = sections.count;
    }
    const probeBefore = await layoutChecks(`start ${vp.name}`, rootSelector, { checkClipped: true });
    const viewport = {
      viewport: vp.name,
      width: vp.width,
      height: vp.height,
      ready,
      title,
      rootSelector,
      scrollWidth: probeBefore.scrollWidth,
      scrollHeight: probeBefore.scrollHeight,
      horizontalOverflow: probeBefore.horizontalOverflow,
      pageScrollable: probeBefore.pageScrollable,
      scroller: probeBefore.scroller,
      sections: sections.items,
      sectionsSource: sections.source,
      shots: { viewport: viewportShot },
      textOverflow: probeBefore.textOverflow,
      decorativeOverflow: probeBefore.overflowCandidates.filter((el) => el.decorative),
      clipped: probeBefore.clipped,
      overlaps: probeBefore.overlaps,
    };

    if (should('start')) {
      // Full page: document-scrolling pages use fullPage; pages that scroll
      // inside a fixed overlay (the current #main-menu.sp layout) are expanded
      // temporarily and captured with an oversized clip. Restored afterwards.
      const full = await fullPageCapture(`start-${vp.name}-full`, rootSelector, probeBefore.scrollHeight);
      viewport.shots.fullPage = full.shot;
      viewport.fullPageStrategy = full.strategy;
      viewport.fullPageHeight = full.height;
      // Walk the page sections and capture each one. Heading-based layouts are
      // walked at every viewport; the block fallback for one-page layouts is
      // only walked at desktop + mobile so the run stays inside its time budget.
      // Detailed per-section walk at the primary desktop viewport (all sections)
      // and a short mobile walk; the full-page capture above already contains
      // every section at the other viewports. screenshots are the slow part of
      // this harness under SwiftShader (~3s each), so the budget is deliberate.
      viewport.sectionShots = [];
      const walkSections = vp.width === 1600 || vp.width === 390;
      const sectionBudget = vp.width === 1600 ? 8 : 3;
      // Smooth scrolling makes every scrollIntoView slow; the walk only needs
      // the final position, so switch the scroller to instant while walking.
      await evaluate((rootSel) => {
        const el = (rootSel && document.querySelector(rootSel)) || document.scrollingElement;
        if (!el) return;
        window.__qaScrollBehavior = el.style.scrollBehavior;
        el.style.scrollBehavior = 'auto';
      }, rootSelector);
      for (let i = 0; walkSections && i < Math.min(sections.count, sectionBudget); i += 1) {
        if (i > 0) await sleep(100);
        const info = await scrollToStartSection(i);
        if (!info) break;
        await sleep(200);
        const shotPath = await shot(`start-${vp.name}-section-${String(i + 1).padStart(2, '0')}-${sections.items[i]?.slug || 'section'}`);
        viewport.sectionShots.push({ ...info, shot: shotPath });
      }
      await evaluate((rootSel) => {
        const el = (rootSel && document.querySelector(rootSel)) || document.scrollingElement;
        if (el && window.__qaScrollBehavior !== undefined) el.style.scrollBehavior = window.__qaScrollBehavior;
        if (el) el.scrollTop = 0;
        window.scrollTo(0, 0);
      }, rootSelector);
      await sleep(150);
    }
    startReport.viewports.push(viewport);
    responsiveReport.viewports.push({
      viewport: vp.name,
      width: vp.width,
      height: vp.height,
      horizontalOverflow: probeBefore.horizontalOverflow,
      scrollWidth: probeBefore.scrollWidth,
      pageScrollable: probeBefore.pageScrollable,
      scroller: probeBefore.scroller,
      textOverflowCount: probeBefore.textOverflow.length,
      clippedCount: probeBefore.clipped.length,
      overlapCount: probeBefore.overlaps.length,
      decorativeOverflowCount: probeBefore.overflowCandidates.filter((el) => el.decorative).length,
    });
  }
  await page.setViewport({ ...GAME_VIEWPORT, deviceScaleFactor: 1 });
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — in-game states at 1600x900
// ═══════════════════════════════════════════════════════════════════════════
async function captureState(name, fn) {
  state(name);
  const stateStart = Date.now();
  const row = { name, shot: null, checks: [], probe: null, durationMs: 0, warnings: [], url: page.url() };
  try {
    const extra = await fn();
    if (extra && typeof extra === 'object') Object.assign(row, extra);
  } catch (err) {
    warn(`${name}: state capture threw`, err?.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err));
  }
  row.url = page.url();
  try {
    row.shot = await shot(`game-${name}`);
  } catch (err) {
    warn(`${name}: screenshot failed`, err.message);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      row.probe = await probeLayout(null);
      layoutChecks(`game ${name}`, null, { checkClipped: false });
      row.checks = checks.filter((c) => c.state === currentState);
      break;
    } catch (err) {
      if (attempt === 0) {
        await sleep(350);
        continue;
      }
      warn(`${name}: layout probe failed (last url ${page.url()})`, err.message);
      if (/Execution context was destroyed|Target closed|Page crashed|Session closed/i.test(err.message)) {
        const recovered = await recoverPage();
        warn(`${name}: page context was destroyed — ${recovered ? 'reloaded to menu' : 'recovery failed'}`, err.message);
      }
      row.checks = checks.filter((c) => c.state === currentState);
    }
  }
  row.durationMs = Date.now() - stateStart;
  gameReport.states.push(row);
  return row;
}

if (should('game')) {
  // ── level select ────────────────────────────────────────────────────────
  await captureState('level-select', async () => {
    await bootMenu();
    await evaluate(() => {
      const btn = document.querySelector('[data-mode="campaign"], #btn-campaign');
      if (btn) btn.click();
      else window.game?.app?.startMode?.('campaign');
    });
    const open = await waitFor(() => evaluate(() => document.getElementById('level-select')?.classList.contains('active') === true), 6000);
    check('level select overlay opens', open);
    if (open) await sleep(350);
    const info = await evaluate(() => ({
      title: document.querySelector('#level-select h2')?.textContent?.trim() || '',
      cards: document.querySelectorAll('#level-select .level-card, #level-grid .level-card').length,
      locked: document.querySelectorAll('#level-select .level-card.locked, #level-grid .level-card.locked').length,
    }));
    check('level select renders level cards', info.cards >= 20, JSON.stringify(info));
    check('level select shows locked levels', info.locked >= 1, JSON.stringify(info));
    return info;
  });

  // ── challenge select ────────────────────────────────────────────────────
  await captureState('challenge-select', async () => {
    await bootMenu();
    await evaluate(() => {
      const btn = document.querySelector('[data-mode="challenge"], #btn-challenge');
      if (btn) btn.click();
      else window.game?.app?.startMode?.('challenge');
    });
    const open = await waitFor(() => evaluate(() => document.getElementById('challenge-select')?.classList.contains('active') === true), 6000);
    check('challenge select overlay opens', open);
    if (open) await sleep(350);
    const info = await evaluate(() => ({
      cards: document.querySelectorAll('#challenge-select .challenge-card, #challenge-grid .challenge-card').length,
      title: document.querySelector('#challenge-select h2')?.textContent?.trim() || '',
    }));
    check('challenge select renders lab cards', info.cards >= 12, JSON.stringify(info));
    return info;
  });

  // ── campaign level 1 with intro modal ───────────────────────────────────
  await captureState('campaign-level1-intro', async () => {
    await goto('/?mode=campaign&level=1');
    const started = await waitFor(() => evaluate(() => !!window.game?.app?.modeInstance), 20000);
    check('campaign level 1 starts', started);
    await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 6000);
    await sleep(600);
    const info = await evaluate(() => ({
      intro: !!document.getElementById('tutorial-overlay'),
      coach: !!document.querySelector('.coach-card-wrap'),
      levelTitle: document.querySelector('#obj-panel-title')?.textContent?.trim() || '',
      objectives: [...document.querySelectorAll('#obj-list > *')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
      objectiveCount: document.querySelectorAll('#obj-list > *').length,
      hintButton: document.getElementById('btn-show-hint')?.textContent?.trim() || '',
      objectivesPanel: (() => {
        const el = document.getElementById('objectives-panel');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight, display: getComputedStyle(el).display };
      })(),
    }));
    check('help modal shown on first campaign level start', info.intro, JSON.stringify(info));
    check('coach marks do not overlap the help modal', !info.coach, JSON.stringify(info));
    check('objectives panel visible during intro', Boolean(info.objectivesPanel && info.objectivesPanel.display !== 'none'), JSON.stringify(info.objectivesPanel));
    check('objectives panel inside viewport', Boolean(info.objectivesPanel && info.objectivesPanel.right <= info.objectivesPanel.vw && info.objectivesPanel.bottom <= info.objectivesPanel.vh), JSON.stringify(info.objectivesPanel));
    check('level 1 objectives listed', info.objectiveCount >= 4, JSON.stringify(info.objectives));
    check('hint button available', /hint/i.test(info.hintButton), info.hintButton);
    return info;
  });

  // ── campaign level 1 after dismissing the intro (coach marks) ───────────
  await captureState('campaign-level1-after-intro', async () => {
    const started = await evaluate(() => !!window.game?.app?.modeInstance);
    if (!started) await goto('/?mode=campaign&level=1');
    await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 6000);
    await evaluate(() => document.getElementById('tutorial-start')?.click());
    const coach = await waitFor(() => evaluate(() => !!document.querySelector('.coach-card-wrap')), 8000);
    check('coach marks appear after dismissing the intro', coach);
    await sleep(400);
    const info = await evaluate(() => {
      const el = document.querySelector('.coach-card-wrap');
      const r = el?.getBoundingClientRect();
      return {
        coach: !!el,
        coachText: el?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 220) || '',
        coachRect: r ? { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight } : null,
        terminalOpen: window.game?.app?.commandBar?.visible === true,
      };
    });
    check('coach card stays inside the viewport', Boolean(info.coachRect && info.coachRect.right <= info.coachRect.vw && info.coachRect.bottom <= info.coachRect.vh), JSON.stringify(info.coachRect));
    check('coach card text present', info.coachText.length > 20, info.coachText);
    return info;
  });

  // ── campaign level 1 running state (tutorial skipped) ───────────────────
  await captureState('campaign-level1', async () => {
    await goto('/?mode=campaign&level=1&tutorial=0');
    const started = await waitFor(() => evaluate(() => !!window.game?.app?.modeInstance), 20000);
    check('campaign level 1 starts with ?tutorial=0', started);
    await sleep(1600);
    await closeOverlays();
    const info = await evaluate(() => ({
      mode: window.game?.app?.currentMode,
      level: window.game?.app?.modeInstance?.currentLevel,
      title: document.querySelector('#obj-panel-title')?.textContent?.trim() || '',
      desc: document.getElementById('obj-panel-desc')?.textContent?.trim().slice(0, 240) || '',
      objectives: [...document.querySelectorAll('#obj-list > *')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
      objectiveDone: document.querySelectorAll('#obj-list .is-done, #obj-list .done, #obj-list .completed, #obj-list [data-done="true"]').length,
      currentUser: window.game?.engine?.currentUser || window.game?.cluster?.currentUser || null,
      terminalHint: document.querySelector('#menu-hints')?.innerText || '',
    }));
    check('campaign mode active', info.mode === 'campaign', JSON.stringify(info.mode));
    check('level 1 is the active level', info.level === 1, JSON.stringify(info.level));
    check('level 1 objective copy visible', info.objectives.length >= 4, JSON.stringify(info.objectives));
    return info;
  });

  // ── sandbox ─────────────────────────────────────────────────────────────
  await captureState('sandbox', async () => {
    const ok = await launchUrl('sandbox', { tutorial0: true });
    check('sandbox starts', ok);
    await sleep(1800);
    await closeOverlays();
    const info = await evaluate(() => ({
      mode: window.game?.app?.currentMode,
      palette: document.querySelectorAll('#resource-palette .palette-item').length,
      paletteVisible: (() => {
        const el = document.getElementById('resource-palette');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      })(),
      toolbar: !!document.getElementById('view-toolbar'),
      hud: !!document.getElementById('hud'),
      canvas: !!document.getElementById('game-canvas'),
      webglError: !!document.getElementById('webgl-error'),
      meshCount: window.game?.app?.renderer?.resourceMeshes?.size ?? 0,
      resourceCount: window.game?.cluster?.getAllResources?.().length ?? 0,
    }));
    check('sandbox mode active', info.mode === 'sandbox', JSON.stringify(info.mode));
    check('resource palette visible', info.paletteVisible && info.palette > 0, JSON.stringify({ palette: info.palette }));
    check('3D renderer drew the cluster', info.meshCount > 0, `meshes=${info.meshCount} resources=${info.resourceCount}`);
    check('WebGL error overlay absent', !info.webglError);
    return info;
  });

  // ── palette element close-up ─────────────────────────────────────────────
  await captureState('palette', async () => {
    const el = await page.$('#resource-palette');
    let shotPath = null;
    if (el) shotPath = await elementShot('#resource-palette', 'game-palette-element');
    else warn('palette element not found for close-up');
    const info = await evaluate(() => ({
      sections: document.querySelectorAll('#resource-palette .palette-section').length,
      items: document.querySelectorAll('#resource-palette .palette-item').length,
    }));
    check('palette has resource items', info.items > 0, JSON.stringify(info));
    const bounds = await evaluate(() => {
      const el = document.getElementById('resource-palette');
      const r = el?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight } : null;
    });
    check('palette inside viewport', Boolean(bounds && bounds.x >= -2 && bounds.right <= bounds.vw && bounds.bottom <= bounds.vh), JSON.stringify(bounds));
    return { ...info, elementShot: shotPath, bounds };
  });

  // ── terminal open with output ────────────────────────────────────────────
  await captureState('terminal', async () => {
    await launchUrl('sandbox', { tutorial0: true });
    await waitFor(() => evaluate(() => !!window.game?.app?.commandBar), 15000);
    await sleep(1200);
    await closeOverlays();
    await pressKey('/');
    const open = await waitFor(() => evaluate(() => window.game?.app?.commandBar?.visible === true), 5000);
    check('terminal opens with the "/" shortcut', open);
    let output = '';
    if (open) {
      // Real keyboard input (suggestions + Enter), matching what a user does.
      try {
        await page.type('#cmd-input', 'oc get pods', { delay: 12 });
        await page.keyboard.press('Enter');
        await sleep(600);
      } catch (err) {
        warn('terminal typing failed, falling back to executeCommand', err.message);
        await evaluate(() => window.game?.app?.commandBar?.executeCommand?.('oc get pods'));
      }
      const info = await evaluate(() => ({
        visible: window.game?.app?.commandBar?.visible === true,
        input: document.getElementById('cmd-input')?.value || '',
        output: (document.getElementById('cmd-output')?.innerText || '').slice(0, 800),
        suggestions: document.querySelectorAll('#cmd-suggestions li, #cmd-suggestions .suggestion').length,
      }));
      output = info.output;
      check('terminal shows command output', info.output.trim().length > 0, info.output.slice(0, 160));
      return info;
    }
    return {};
  });

  // ── inspector ────────────────────────────────────────────────────────────
  await captureState('inspector', async () => {
    await launchUrl('sandbox', { tutorial0: true });
    await waitFor(() => evaluate(() => !!window.game?.app?.inspector), 15000);
    await sleep(1200);
    await closeOverlays();
    const picked = await evaluate(() => {
      const cluster = window.game?.cluster;
      const resource = cluster?.getByKind?.('Deployment')?.[0] || cluster?.getByKind?.('Project')?.[0] || cluster?.getAllResources?.()[0];
      if (!resource) return null;
      window.game.engine.emit('resource:selected', { uid: resource.uid });
      return { kind: resource.kind, name: resource.metadata?.name };
    });
    const visible = await waitFor(() => evaluate(() => window.game?.app?.inspector?.visible === true), 6000);
    check('inspector opens on resource selection', visible, JSON.stringify(picked));
    await sleep(450);
    if (visible) {
      const tabs = await page.$$('#inspector-tabs [data-tab], #inspector-panel [data-tab]');
      if (tabs.length > 1) await tabs[1].click();
      await sleep(300);
    }
    const info = await evaluate(() => ({
      visible: window.game?.app?.inspector?.visible === true,
      name: document.getElementById('inspector-name')?.textContent?.trim() || '',
      tabs: document.querySelectorAll('#inspector-tabs [data-tab]').length,
      body: (document.getElementById('inspector-body')?.innerText || '').slice(0, 300),
      bounds: (() => {
        const el = document.getElementById('inspector-panel');
        const r = el?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight } : null;
      })(),
    }));
    check('inspector renders the selected resource', info.visible && (info.body.length > 0 || info.name.length > 0), JSON.stringify(info).slice(0, 300));
    check('inspector panel inside the viewport', Boolean(info.bounds && info.bounds.right <= info.bounds.vw + 2 && info.bounds.bottom <= info.bounds.vh + 2), JSON.stringify(info.bounds));
    return info;
  });

  // ── files / manifests panel ──────────────────────────────────────────────
  await captureState('files', async () => {
    await launchUrl('sandbox', { tutorial0: true });
    await waitFor(() => evaluate(() => !!window.game?.app?.manifestPanel || !!window.game?.app?.showFiles), 15000);
    await sleep(1000);
    let visible = await evaluate(() => window.game?.manifestPanel?.visible === true);
    if (!visible) {
      await evaluate(() => {
        const btn = document.getElementById('btn-manifests');
        if (btn) btn.click();
        else window.game?.app?.showFiles?.();
      });
      visible = await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 10000);
    }
    check('files/manifests panel opens', visible);
    // The panel builds its file tree on refresh(); give it a moment and wait
    // for the real DOM instead of sampling a half-rendered panel.
    await waitFor(
      () => evaluate(() => {
        const panel = document.querySelector('[data-testid="manifest-panel"]');
        return Boolean(panel && (panel.querySelectorAll('[data-testid="manifest-file"]').length > 0 || (panel.innerText || '').trim().length > 40));
      }),
      6000,
    );
    await sleep(250);
    const info = await evaluate(() => {
      const panel = document.querySelector('[data-testid="manifest-panel"]');
      return {
        visible: window.game?.app?.manifestPanel?.visible === true,
        root: !!panel,
        files: document.querySelectorAll('[data-testid="manifest-file"]').length,
        treeText: (panel?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        editor: !!document.querySelector('[data-testid="manifest-editor"]'),
        currentFile: document.querySelector('[data-testid="manifest-current-file"]')?.textContent?.trim() || '',
        applyButton: !!document.querySelector('[data-action="apply"], #manifest-apply'),
      };
    });
    check('manifest file tree populated', info.treeText.length > 0 || info.files > 0, JSON.stringify(info).slice(0, 400));
    check('manifest editor present', info.editor);
    return info;
  });

  // ── exam prep overlay ────────────────────────────────────────────────────
  await captureState('exam-prep', async () => {
    await bootMenu();
    await evaluate(() => {
      const btn = document.getElementById('menu-exam-prep');
      if (btn) btn.click();
      else window.game?.app?.showExamPrep?.();
    });
    const visible = await waitFor(() => evaluate(() => window.game?.examPrepUI?.visible === true || document.getElementById('exam-prep-overlay')?.classList.contains('active') === true), 10000);
    check('EX280 Prep overlay opens', visible);
    await sleep(600);
    const info = await evaluate(() => ({
      active: document.getElementById('exam-prep-overlay')?.classList.contains('active') === true,
      groups: document.querySelectorAll('#exam-prep-overlay .ep-group').length,
      bullets: document.querySelectorAll('#exam-prep-overlay .ep-bullet').length,
      tabs: document.querySelectorAll('#exam-prep-overlay [data-action="tab"]').length,
    }));
    check('EX280 Prep shows objective tracker', info.groups >= 9 && info.bullets >= 55, JSON.stringify(info));
    return info;
  });

  // ── pause (Space) + help (H) + settings ─────────────────────────────────
  await captureState('pause', async () => {
    await launchUrl('sandbox', { tutorial0: true });
    await waitFor(() => evaluate(() => !!window.game?.app?.modeInstance), 20000);
    await sleep(1500);
    await closeOverlays();
    await pressKey('Space');
    await sleep(350);
    const info = await evaluate(() => ({
      engineState: window.game?.gameEngine?.state || window.game?.engine?.state || null,
      pauseOverlay: document.getElementById('pause-overlay')?.classList.contains('active') === true,
      pauseResume: !!document.getElementById('pause-resume'),
      hudPausedBadge: /paused/i.test(document.getElementById('hud')?.innerText || ''),
    }));
    check('Space pauses the simulation', info.engineState === 'paused', JSON.stringify(info));
    check('pause state is visible to the user', info.pauseOverlay || info.hudPausedBadge, JSON.stringify(info));
    return info;
  });

  await captureState('pause-overlay', async () => {
    const hasOverlay = await evaluate(() => !!document.getElementById('pause-overlay'));
    if (!hasOverlay) {
      warn('pause overlay (#pause-overlay) not implemented yet — skipping dedicated capture');
      return { skipped: true };
    }
    const already = await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === true);
    if (already) await evaluate(() => document.getElementById('pause-resume')?.click());
    await sleep(250);
    await pressKey('Escape');
    await sleep(450);
    const info = await evaluate(() => ({
      active: document.getElementById('pause-overlay')?.classList.contains('active') === true,
      buttons: document.querySelectorAll('#pause-overlay button').length,
      text: (document.getElementById('pause-overlay')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
    check('pause overlay active after Esc/Space', info.active, JSON.stringify(info));
    return info;
  });

  await captureState('settings', async () => {
    await pressKey('Space'); // make sure the sim is running, not paused
    await sleep(200);
    await evaluate(() => window.game?.app?.hud?.settingsPanel?.show?.());
    const visible = await waitFor(() => evaluate(() => window.game?.app?.hud?.settingsPanel?.visible === true), 5000);
    check('in-game settings panel opens', visible);
    await sleep(300);
    const info = await evaluate(() => ({
      visible: window.game?.app?.hud?.settingsPanel?.visible === true,
      panel: !!document.querySelector('#ingame-settings-panel, [data-testid="settings-panel"]'),
      controls: document.querySelectorAll('#ingame-settings-panel [data-action], #ingame-settings-panel [data-testid]').length,
    }));
    check('settings panel has controls', info.controls >= 5, JSON.stringify(info));
    return info;
  });

  await captureState('help', async () => {
    await closeOverlays();
    const opened = await evaluate(() => {
      const app = window.game?.app;
      if (app?.showTutorial) {
        app.showTutorial('sandbox');
        return true;
      }
      return false;
    });
    if (!opened) await pressKey('h');
    const visible = await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 6000);
    check('help overlay opens ("H")', visible);
    await sleep(300);
    return {};
  });

  // ── metrics dashboard ────────────────────────────────────────────────────
  await captureState('metrics', async () => {
    await evaluate(() => {
      const el = document.getElementById('tutorial-overlay');
      el?.remove();
    });
    await pressKey('m');
    await sleep(500);
    let visible = await evaluate(() => window.game?.app?.metrics?.visible === true);
    if (!visible) {
      await evaluate(() => window.game?.app?.metrics?.show?.());
      visible = await waitFor(() => evaluate(() => window.game?.app?.metrics?.visible === true), 5000);
    }
    check('metrics dashboard opens ("M")', visible);
    await sleep(500);
    const info = await evaluate(() => {
      const all = [...document.querySelectorAll('#metrics-dashboard')];
      const visibleEl = all.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < innerHeight - 4 && r.bottom > 4;
      }) || all[0];
      const r = visibleEl?.getBoundingClientRect();
      return {
        visible: window.game?.app?.metrics?.visible === true,
        instances: all.length,
        canvases: document.querySelectorAll('#metrics-dashboard canvas').length,
        bounds: r ? { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight } : null,
      };
    });
    check('metrics dashboard renders charts', info.canvases >= 4, JSON.stringify(info));
    check('metrics dashboard inside viewport', Boolean(info.bounds && info.bounds.right <= info.bounds.vw + 2 && info.bounds.bottom <= info.bounds.vh + 2), JSON.stringify(info.bounds));
    return info;
  });

  await page.setViewport({ ...GAME_VIEWPORT, deviceScaleFactor: 1 });
  await closeOverlays();
}
} catch (err) {
  fatal = { message: String(err?.message || err), stack: String(err?.stack || err).slice(0, 2000), state: currentState };
  console.error(`\nHARNESS FAILURE during "${currentState}": ${fatal.message}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════════════════
const finishedAt = new Date();
const durationSeconds = Math.round((finishedAt - startedAt) / 100) / 10;
const failures = checks.filter((c) => !c.pass);

// Hard problems drive the exit code (see header); missing UI states are only
// fatal with --strict so the harness can still report a partly-broken app.
const hardProblems = [];
if (consoleErrors.length > 0) hardProblems.push(`${consoleErrors.length} console error(s)`);
if (pageErrors.length > 0) hardProblems.push(`${pageErrors.length} page error(s)`);
if (pageCrashes.length > 0) hardProblems.push(`${pageCrashes.length} renderer page crash(es)`);
for (const vp of responsiveReport.viewports) {
  if (vp.horizontalOverflow > 2) hardProblems.push(`horizontal overflow at ${vp.viewport} (+${vp.horizontalOverflow}px)`);
}
if (fatal) hardProblems.push(`harness failure: ${fatal.message}`);
const clipped = startReport.viewports.flatMap((vp) => (vp.clipped || []).map((c) => ({ viewport: vp.viewport, ...c })));
if (clipped.length > 0) hardProblems.push(`${clipped.length} clipped element(s) on a non-scrollable page`);
if (STRICT && failures.length > 0) hardProblems.push(`${failures.length} failed state check(s) (--strict)`);

const report = {
  generatedAt: finishedAt.toISOString(),
  startedAt: startedAt.toISOString(),
  durationSeconds,
  baseUrl: BASE,
  outputDir: relOut(OUT),
  command: `node scripts/visual-qa.mjs${OUT_ARG ? ` --out=${OUT_ARG}` : ''}${ONLY.length ? ` --only=${ONLY.join(',')}` : ''}${STRICT ? ' --strict' : ''}`,
  environment: {
    node: process.version,
    chrome: CHROME_VERSION,
    puppeteerCore: PUPPETEER_DIR,
    headless: !HEADFUL,
    chromeBinary: CHROME,
  },
  app: { ...APP, title: APP_VERSION },
  options: { only: ONLY.length ? ONLY : ['start', 'game', 'responsive'], strict: STRICT },
  summary: {
    checks: checks.length,
    passed: checks.filter((c) => c.pass).length,
    failed: failures.length,
    warnings: warnings.length,
    consoleErrors: consoleErrors.length,
    consoleWarnings: consoleWarnings.length,
    pageErrors: pageErrors.length,
    screenshots: screenshots.length,
    hardProblems: hardProblems.length,
    fatal: Boolean(fatal),
    exitCode: fatal ? 2 : hardProblems.length ? 1 : 0,
  },
  responsive: responsiveReport,
  start: startReport,
  game: gameReport,
  checks,
  failures,
  warnings,
  consoleErrors,
  consoleWarnings,
  pageErrors,
  pageCrashes,
  duplicateIds: (() => {
    const seen = new Map();
    for (const stateRow of gameReport.states) {
      for (const dup of stateRow.probe?.duplicateDomIds || []) {
        const key = dup.id;
        if (!seen.has(key)) seen.set(key, { id: key, count: dup.count, state: stateRow.name });
      }
    }
    return [...seen.values()];
  })(),
  screenshots,
  hardProblems,
  fatal,
  navigations,
};
await writeFile(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

// ── summary.md ─────────────────────────────────────────────────────────────
const table = (rows) => ['| Item | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
const stateRows = gameReport.states.map((s) => {
  const failed = (s.checks || []).filter((c) => c.state === s.name && !c.pass).length;
  return `| ${s.name} | ${s.shot ? `[\`${s.shot.split('/').pop()}\`](${s.shot})` : '—'} | ${(s.checks || []).length - failed}/${(s.checks || []).length} | ${s.probe ? (s.probe.horizontalOverflow > 2 ? `**+${s.probe.horizontalOverflow}px**` : 'ok') : '—'} | ${s.durationMs} ms |`;
});
const vpRows = startReport.viewports.map((v) => {
  const sections = v.sections?.length || 0;
  const shotLink = v.shots?.viewport ? `[\`${v.shots.viewport.split('/').pop()}\`](${v.shots.viewport})` : '—';
  const fullLink = v.shots?.fullPage ? `[\`${v.shots.fullPage.split('/').pop()}\`](${v.shots.fullPage})` : `not scrollable (${v.fullPageStrategy || '—'})`;
  return `| ${v.viewport} | ${shotLink} | ${fullLink} | ${v.horizontalOverflow > 2 ? `**+${v.horizontalOverflow}px**` : 'ok'} | ${v.scrollHeight} | ${sections} (${v.sectionsSource || '—'}) | ${(v.sectionShots || []).length} |`;
});
const md = [
  `# Visual QA — ${STAMP}`,
  '',
  `**Command:** \`${report.command}\``,
  `**App:** \`${APP.head}\`${APP.dirtyCount ? ` + ${APP.dirtyCount} uncommitted file(s)` : ' (clean)'}`,
  `**Duration:** ${durationSeconds}s · **Exit:** ${hardProblems.length ? '1 (hard problem)' : '0'}`,
  '',
  `## Verdict: ${hardProblems.length ? 'FAIL' : 'PASS'}`,
  hardProblems.length ? ['', ...hardProblems.map((p) => `- ${p}`), ''].join('\n') : '',
  table([
    ['Checks', `${report.summary.passed} passed / ${report.summary.failed} failed / ${report.summary.checks} total`],
    ['Console errors', String(consoleErrors.length)],
    ['Console warnings', String(consoleWarnings.length)],
    ['Page errors', String(pageErrors.length)],
    ['Warnings', String(warnings.length)],
    ['Screenshots', `${screenshots.length} → \`${relOut(SHOTS_DIR)}/\``],
  ]),
  '',
  '## Start page viewports',
  '',
  '| Viewport | Viewport shot | Full-page shot | H-overflow | Scroll height | Sections | Section shots |',
  '|---|---|---|---|---|---|---|',
  ...vpRows,
  '',
  '## Game states (1600x900)',
  '',
  '| State | Screenshot | Checks | H-overflow | Time |',
  '|---|---|---|---|---|',
  ...stateRows,
  '',
  '## Console / page errors',
  '',
  consoleErrors.length || pageErrors.length || pageCrashes.length
    ? [...consoleErrors.map((e) => `- **[console/${e.state}]** ${e.text.slice(0, 300)}`), ...pageErrors.map((e) => `- **[pageerror/${e.state}]** ${e.text.slice(0, 300)}`), ...pageCrashes.map((e) => `- **[renderer-crash/${e.state}]** ${e.text.slice(0, 300)}`)].join('\n')
    : 'None.',
  '',
  '## Failed checks',
  '',
  failures.length ? failures.map((f) => `- **[${f.state}]** ${f.name}${f.detail ? ` — \`${f.detail.slice(0, 240)}\`` : ''}`).join('\n') : 'None.',
  '',
  '## Duplicate DOM ids',
  '',
  (() => {
    const seen = new Map();
    for (const stateRow of gameReport.states) for (const dup of stateRow.probe?.duplicateDomIds || []) if (!seen.has(dup.id)) seen.set(dup.id, { id: dup.id, count: dup.count, state: stateRow.name });
    const rows = [...seen.values()];
    return rows.length ? rows.map((d) => `- \`#${d.id}\` appears ${d.count}× in the DOM (first seen in ${d.state})`).join('\n') : 'None.';
  })(),
  '',
  '## Warnings',
  '',
  warnings.length ? warnings.map((w) => `- **[${w.state}]** ${w.name}${w.detail ? ` — ${w.detail.slice(0, 240)}` : ''}`).join('\n') : 'None.',
  '',
  '## Artifacts',
  '',
  `- \`${relOut(OUT)}/report.json\` (full machine-readable results)`,
  `- \`${relOut(SHOTS_DIR)}/\` (${screenshots.length} PNGs)`,
  '',
].join('\n');
await writeFile(join(OUT, 'summary.md'), md);

// ── Console output ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(74)}`);
console.log(`Visual QA: ${report.summary.passed} passed, ${report.summary.failed} failed, ${warnings.length} warnings`);
console.log(`Console errors: ${consoleErrors.length} · page errors: ${pageErrors.length} · screenshots: ${screenshots.length}`);
console.log(`Output: ${relOut(OUT)}/report.json · ${relOut(OUT)}/summary.md`);
if (hardProblems.length) {
  console.log(`HARD PROBLEMS (${hardProblems.length}):`);
  for (const p of hardProblems) console.log(`  - ${p}`);
}
console.log(`Verdict: ${hardProblems.length ? (fatal ? 'HARNESS FAILURE' : 'FAIL') : 'PASS'} (${durationSeconds}s)`);
console.log(`${'─'.repeat(74)}`);

await browser.close();
server.close();
process.exit(fatal ? 2 : hardProblems.length ? 1 : 0);
