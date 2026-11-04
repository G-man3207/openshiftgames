#!/usr/bin/env node
/**
 * OpenShift Games — browser smoke/E2E verification harness.
 *
 * The repo stays dependency-free: this script loads puppeteer-core from an
 * out-of-repo install. Prepare once with:
 *   mkdir -p /tmp/verify-tools && cd /tmp/verify-tools && npm init -y && npm i puppeteer-core@23
 * (or point PUPPETEER_CORE_DIR at any directory containing node_modules/puppeteer-core)
 *
 * Usage:
 *   node scripts/browser-test.mjs [--only=menu,tutorial,sandbox,cli,files,ui,campaign,challenges,exam,draw,responsive,regressions,shots]
 *                                [--no-shots] [--headful]
 *
 * Serves the repo on a random localhost port, drives headless Chrome with
 * SwiftShader WebGL at 1600x900, runs the EX280 conversion acceptance suite,
 * writes screenshots + docs/verification-report.json. Exit code 0 = pass.
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs', 'screenshots');
const args = process.argv.slice(2);
const HEADFUL = args.includes('--headful');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const NO_SHOTS = args.includes('--no-shots');
const VIEWPORT = { width: 1600, height: 900 };

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

// ── Static server ──────────────────────────────────────────────────────────
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
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ── Bookkeeping ────────────────────────────────────────────────────────────
const passes = [];
const failures = [];
const warnings = [];
const consoleErrors = [];
const pageErrors = [];
const sections = {};
let currentSection = 'setup';

function sectionLabel(name) {
  if (!sections[name]) sections[name] = { passes: 0, failures: 0, warnings: 0 };
  return sections[name];
}
function section(name) {
  currentSection = name;
  console.log(`\n── ${name.toUpperCase()} ${'─'.repeat(Math.max(0, 66 - name.length))}`);
}
function pass(name) {
  passes.push({ section: currentSection, name });
  sectionLabel(currentSection).passes += 1;
  console.log(`  PASS  ${name}`);
}
function fail(name, detail) {
  failures.push({ section: currentSection, name, detail: detail === undefined ? undefined : String(detail) });
  sectionLabel(currentSection).failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
}
function warn(name, detail) {
  warnings.push({ section: currentSection, name, detail: detail === undefined ? undefined : String(detail) });
  sectionLabel(currentSection).warnings += 1;
  console.log(`  WARN  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
}
function assert(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}
function shouldRun(name) {
  return ONLY.length === 0 || ONLY.includes(name);
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
    /Failed to load resource: the server responded with a status of 403/i.test(text) // optional GitHub stars API (rate-limited)
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
    '--window-size=1600,900',
    '--hide-scrollbars',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});
const page = await browser.newPage();
await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (!isIgnorableConsole(text)) consoleErrors.push({ section: currentSection, text });
});
page.on('pageerror', (err) => pageErrors.push({ section: currentSection, text: String(err) }));
page.on('requestfailed', (req) => {
  const url = req.url();
  const errText = req.failure()?.errorText || '';
  if (!isIgnorableRequest(url, errText)) {
    warnings.push({ section: currentSection, name: 'request failed', detail: `${url} ${errText}` });
    sectionLabel(currentSection).warnings += 1;
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
async function shot(name, fullPage = false) {
  if (NO_SHOTS) return null;
  await mkdir(SHOTS, { recursive: true });
  const path = join(SHOTS, name);
  await page.screenshot({ path, fullPage });
  console.log(`  SHOT  docs/screenshots/${name}`);
  return `docs/screenshots/${name}`;
}
async function evaluate(fn, ...args) {
  return page.evaluate(fn, ...args);
}

// ── Navigation helpers ─────────────────────────────────────────────────────
async function goto(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(400);
}
async function bootMenu() {
  if (!page.url().startsWith(BASE)) await goto('/');
  await waitFor(() => evaluate(() => !!window.game?.app?.engine), 20000);
  await waitFor(() => evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === false), 8000);
  await sleep(700);
  await closeOverlays();
}
async function bootSandbox() {
  await goto('/?mode=sandbox&tutorial=0');
  const ok = await waitFor(
    () => evaluate(() => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance),
    20000,
  );
  await sleep(2000);
  await closeOverlays();
  return ok;
}
async function bootCampaign(level = 1) {
  await goto(`/?mode=campaign&level=${level}&tutorial=0`);
  const ok = await waitFor(() => evaluate(() => !!window.game?.app?.modeInstance?.getStatus), 20000);
  await sleep(1500);
  await closeOverlays();
  return ok;
}
async function launch(mode, id) {
  await evaluate(
    (m, i) => {
      const app = window.game.app;
      if (m === 'campaign') {
        const progress = window.game?.scoringEngine?.progress;
        if (progress?.campaignProgress) {
          for (let n = 1; n < (i || 1); n += 1) {
            if (!progress.campaignProgress[n]?.completed) progress.campaignProgress[n] = { completed: true, stars: 3 };
          }
        }
      }
      app.launchGame(m, i);
    },
    mode,
    id,
  );
  const ok = await waitFor(
    () =>
      evaluate(
        (m, i) => {
          const mode = window.game?.app?.modeInstance;
          if (!mode) return false;
          if (m === 'campaign') return mode.currentLevel === i;
          if (m === 'challenge') return mode.currentChallenge === i;
          return true;
        },
        mode,
        id,
      ),
    12000,
  );
  await sleep(1200);
  return ok;
}
async function returnToMenu() {
  await evaluate(() => window.game?.app?.returnToMenu?.());
  await waitFor(() => evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === false), 6000);
  await sleep(400);
}
async function closeOverlays() {
  try {
    await evaluate(() => {
      const app = window.game?.app;
      // Dismiss the "How to play" level-intro modal too. bootMenu() navigates to
      // `/` (no ?tutorial=0), so launchGame() re-opens it for every level and it
      // registers the `tutorial` clock-pause reason; leaving it up makes later
      // pause/resume assertions read a run that is still legitimately paused.
      app?.hideTutorial?.();
      app?.examPrepUI?.hide?.();
      app?.manifestPanel?.hide?.();
      app?.inspector?.hide?.();
      app?.contextMenu?.hide?.();
      app?.metrics?.hide?.();
      app?.hud?.settingsPanel?.hide?.();
      for (const id of ['settings-panel', 'achievements-panel', 'stats-panel', 'modal-level-complete', 'modal-game-over']) {
        document.getElementById(id)?.classList.remove('active');
      }
      for (const id of ['name-prompt-overlay', 'route-target-overlay', 'selector-picker-overlay', 'ingress-path-overlay', 'scale-modal', 'edit-dialog']) {
        document.getElementById(id)?.remove();
      }
      window.game?.renderer?.deselectAll?.();
      document.activeElement?.blur?.();
    });
  } catch {
    /* page may be navigating/closed */
  }
}
async function ensureManifestEngine() {
  const ready = await waitFor(() => evaluate(() => !!window.game?.manifestEngine), 3000);
  if (ready) return true;
  await evaluate(() => document.getElementById('btn-manifests')?.click());
  return waitFor(() => evaluate(() => !!window.game?.manifestEngine), 8000);
}
async function openFilesPanel() {
  const ready = await ensureManifestEngine();
  if (!ready) return false;
  const visible = await evaluate(() => window.game?.manifestPanel?.visible === true);
  if (!visible) {
    await evaluate(() => window.game?.app?.showFiles?.());
    await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 6000);
  }
  return evaluate(() => window.game?.manifestPanel?.visible === true);
}
async function openExamPrep() {
  const ready = await waitFor(() => evaluate(() => !!window.game?.examPrepUI), 8000);
  if (!ready) return false;
  await evaluate(() => window.game?.app?.showExamPrep?.());
  await waitFor(() => evaluate(() => window.game?.examPrepUI?.visible === true), 5000);
  return evaluate(() => window.game?.examPrepUI?.visible === true);
}

// ── Command helpers ────────────────────────────────────────────────────────
async function runCmd(raw, wait = 100) {
  const result = await evaluate((command) => {
    try {
      const bar = window.game?.app?.commandBar;
      if (!bar) return { error: true, message: 'no command bar', baseCommand: '' };
      const out = bar.executeCommand(command);
      return {
        error: Boolean(out?.error),
        message: String(out?.message ?? ''),
        baseCommand: String(out?.baseCommand ?? ''),
        normalized: String(out?.normalized ?? ''),
      };
    } catch (err) {
      return { error: true, message: `THROW ${err?.message || err}`, baseCommand: '' };
    }
  }, raw);
  await sleep(wait);
  if (/internal command failure|THROW |is not a function|TypeError|ReferenceError/i.test(result.message)) {
    fail(`cli internal error: ${raw}`, result.message.slice(0, 400));
  }
  return result;
}
async function expectCmd(name, raw, expectation, options = {}) {
  const result = await runCmd(raw, options.wait ?? 120);
  if (result.error) {
    if (options.mayFail) warn(name, result.message.slice(0, 240));
    else fail(name, `command failed: ${result.message.slice(0, 320)}`);
    return result;
  }
  const ok =
    typeof expectation === 'function'
      ? expectation(result)
      : expectation instanceof RegExp
        ? expectation.test(result.message)
        : true;
  if (ok) pass(name);
  else fail(name, `unexpected output: ${result.message.replace(/\n/g, ' ⏎ ').slice(0, 340)}`);
  return result;
}
async function expectCmdError(name, raw, expectation, options = {}) {
  const result = await runCmd(raw, options.wait ?? 120);
  if (!result.error) {
    fail(name, `expected an error, got success: ${result.message.slice(0, 240)}`);
    return result;
  }
  const ok = expectation instanceof RegExp ? expectation.test(result.message) : true;
  if (ok) pass(name);
  else fail(name, `unexpected error: ${result.message.slice(0, 300)}`);
  return result;
}
async function expectNonEmpty(name, raw, options = {}) {
  const result = await runCmd(raw, options.wait ?? 120);
  if (result.error) fail(name, `command failed: ${result.message.slice(0, 320)}`);
  else if (result.message.trim()) pass(name);
  else fail(name, 'command returned empty output');
  return result;
}
async function findResource(kind, name, namespace) {
  return evaluate(
    ({ kind, name, namespace }) => {
      const cluster = window.game?.cluster;
      if (!cluster?.getByKind) return null;
      const resources = cluster.getByKind(kind) || [];
      const match = resources.find(
        (r) => r?.metadata?.name === name && (namespace === undefined || (r?.metadata?.namespace || '') === namespace),
      );
      if (!match) return null;
      return {
        kind: match.kind,
        name: match.metadata?.name,
        namespace: match.metadata?.namespace || '',
        apiVersion: match.apiVersion,
        uid: match.uid || match.metadata?.uid,
        phase: match.status?.phase || match.phase || null,
        spec: match.spec ? JSON.parse(JSON.stringify(match.spec)) : null,
        status: match.status ? JSON.parse(JSON.stringify(match.status)) : null,
      };
    },
    { kind, name, namespace },
  );
}
/** Advance the fixed-step simulation by `seconds` of game time without waiting
 * for wall-clock time to pass. Used to reach controller/exponential timings
 * (FailedCreate retry throttling, OLM install steps, image-pull back-off)
 * deterministically instead of inflating the suite runtime with long sleeps. */
async function advanceSimulation(seconds) {
  return evaluate((secs) => {
    const sim = window.game?.gameEngine?.simulation;
    if (!sim || typeof sim.tick !== 'function') return false;
    const steps = Math.ceil(secs / 0.05);
    for (let i = 0; i < steps; i += 1) sim.tick(0.05);
    return true;
  }, seconds);
}
/** Split an oc/helm tabwriter table into header + data rows (3+ space columns). */
function parseTable(message) {
  const lines = String(message ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return {
    header: lines[0] || '',
    rows: lines.slice(1).map((line) => line.split(/\s{3,}/).map((cell) => cell.trim())),
  };
}

// ── Run wrapper ────────────────────────────────────────────────────────────
async function runSection(name, fn) {
  if (!shouldRun(name)) return;
  section(name);
  try {
    await fn();
  } catch (err) {
    fail(`${name}: harness exception`, err?.stack ? err.stack.split('\n').slice(0, 6).join('\n') : String(err));
  }
}

const startedAt = new Date();
const shotsTaken = [];

// ═══════════════════════════════════════════════════════════════════════════
// 1. MENU / BRANDING / META
// ═══════════════════════════════════════════════════════════════════════════
await runSection('menu', async () => {
  await bootMenu();
  const menu = await evaluate(() => ({
    title: document.title,
    menuVisible: !document.getElementById('main-menu')?.classList.contains('hidden'),
    logo: document.querySelector('.menu-logo')?.textContent?.trim() || '',
    subtitle: document.querySelector('.menu-subtitle')?.textContent?.trim() || '',
    modes: [...document.querySelectorAll('.menu-btn[data-mode]')].map((b) => b.dataset.mode),
    hasExamPrep: !!document.getElementById('menu-exam-prep'),
    drawHref: document.querySelector('a[href="/draw"]')?.getAttribute('href') || '',
    footer: document.querySelector('.menu-attribution')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogUrl: document.querySelector('meta[property="og:url"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    twitterCard: document.querySelector('meta[name="twitter:card"]')?.content || '',
    repoHref: document.querySelector('#github-badge')?.getAttribute('href') || '',
    importmap: document.querySelector('script[type="importmap"]')?.textContent || '',
  }));
  assert(menu.title === 'OpenShift Games — Learn OpenShift by Playing (EX280)', 'menu: exact page title', menu.title);
  assert(menu.menuVisible, 'menu: main menu visible');
  assert(menu.logo === 'OpenShift Games', 'menu: OpenShift Games logo', menu.logo);
  assert(/OpenShift 4\.22 Cluster Simulation · Built for EX280/.test(menu.subtitle), 'menu: OpenShift 4.22 / EX280 subtitle', menu.subtitle);
  for (const mode of ['campaign', 'chaos', 'sandbox', 'challenge']) {
    assert(menu.modes.includes(mode), `menu: ${mode} mode button`);
  }
  assert(menu.hasExamPrep, 'menu: EX280 Prep button exists');
  assert(menu.drawHref === '/draw', 'menu: OpenShift Draw link is /draw', menu.drawHref);
  assert(
    /Built for EX280/i.test(menu.footer) && /K8s Games by Rohit/i.test(menu.footer) && /Apache-2\.0/i.test(menu.footer) && /trademark of Red Hat/i.test(menu.footer),
    'menu: required attribution footer',
    menu.footer,
  );
  assert(/Learn Red Hat OpenShift by playing/.test(menu.description), 'menu: meta description');
  assert(menu.ogUrl === 'https://shifting.pro', 'menu: og:url');
  assert(menu.ogImage === 'https://shifting.pro/og-image.png', 'menu: og:image');
  assert(menu.twitterCard === 'summary_large_image', 'menu: twitter card');
  assert(/github\.com\/G-man3207\/openshiftgames/.test(menu.repoHref), 'menu: GitHub badge points to standalone repo', menu.repoHref);
  assert(/three@0\.152\.0/.test(menu.importmap), 'menu: Three.js importmap pinned to 0.152.0');
  assert(!/K8s Games|Kubernetes Cluster Simulation/i.test(menu.logo), 'menu: no legacy branding in logo');
  const shotPath = await shot('menu.png');
  if (shotPath) shotsTaken.push(shotPath);

  await evaluate(() => document.getElementById('btn-settings')?.click());
  await sleep(250);
  assert(await evaluate(() => document.getElementById('settings-panel')?.classList.contains('active') === true), 'menu: settings modal opens');
  await evaluate(() => document.getElementById('settings-close')?.click());
  await evaluate(() => document.getElementById('btn-achievements')?.click());
  await sleep(400);
  assert(await evaluate(() => document.getElementById('achievements-panel')?.classList.contains('active') === true), 'menu: achievements modal opens');
  const achievementCount = await evaluate(() => document.querySelectorAll('#achievements-grid .achievement-card, #achievements-grid > *').length);
  assert(achievementCount >= 35, 'menu: achievements grid populated', `got ${achievementCount}`);
  await evaluate(() => document.getElementById('achievements-close')?.click());
  await evaluate(() => document.getElementById('btn-stats')?.click());
  await sleep(300);
  assert(await evaluate(() => document.getElementById('stats-panel')?.classList.contains('active') === true), 'menu: stats modal opens');
  await evaluate(() => document.getElementById('stats-close')?.click());
  await closeOverlays();
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. RESPONSIVE SANITY
// ═══════════════════════════════════════════════════════════════════════════
await runSection('responsive', async () => {
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await sleep(400);
  const small = await evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    menuVisible: !document.getElementById('main-menu')?.classList.contains('hidden'),
  }));
  assert(small.width === 1280 && small.height === 720, 'responsive: 1280x720 viewport applied', `${small.width}x${small.height}`);
  assert(small.menuVisible, 'responsive: menu visible at 1280x720');
  assert(small.scrollWidth <= small.width + 2, 'responsive: no horizontal overflow at 1280x720', `scrollWidth=${small.scrollWidth}`);
  await bootSandbox();
  const smallSandbox = await evaluate(() => ({
    palette: document.querySelectorAll('#resource-palette .palette-item').length,
    toolbar: !!document.getElementById('view-toolbar'),
    hud: !!document.getElementById('hud'),
    scrollWidth: document.documentElement.scrollWidth,
    canvas: !!document.getElementById('game-canvas'),
  }));
  assert(smallSandbox.palette === 37, 'responsive: 37 palette kinds at 1280x720', `got ${smallSandbox.palette}`);
  assert(smallSandbox.toolbar && smallSandbox.hud && smallSandbox.canvas, 'responsive: game shell visible at 1280x720');
  assert(smallSandbox.scrollWidth <= 1282, 'responsive: no horizontal overflow in sandbox at 1280x720', `scrollWidth=${smallSandbox.scrollWidth}`);
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
  await sleep(500);
  assert(await evaluate(() => window.innerWidth === 1600 && window.innerHeight === 900), 'responsive: restored 1600x900');
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. EX280 PREP OVERLAY + QUICK LAB LAUNCH
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 3b. LEVEL TUTORIAL: sequencing + stable coach-card positioning
// ═══════════════════════════════════════════════════════════════════════════
await runSection('tutorial', async () => {
  await goto('/?mode=campaign&level=1');
  await waitFor(() => evaluate(() => !!window.game?.app?.modeInstance?.getStatus), 20000);
  await sleep(1200);

  const initial = await evaluate(() => ({
    intro: !!document.getElementById('tutorial-overlay'),
    coach: !!document.querySelector('.coach-card-wrap'),
  }));
  assert(initial.intro, 'tutorial: help modal shown on level start');
  assert(!initial.coach, 'tutorial: coach card does not overlap the help modal', JSON.stringify(initial));

  await page.click('#tutorial-start');
  const coachReady = await waitFor(
    () => evaluate(() => !document.getElementById('tutorial-overlay') && !!document.querySelector('.coach-card-wrap')),
    8000,
  );
  assert(coachReady, 'tutorial: coach marks start after the help modal is dismissed');

  const rect = () => evaluate(() => {
    const el = document.querySelector('.coach-card-wrap');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.right), bottom: Math.round(b.bottom), vw: innerWidth, vh: innerHeight };
  });

  const xSeen = [];
  let last = null;
  for (let stepIndex = 0; stepIndex < 2; stepIndex += 1) {
    const btn = await page.$('#coach-next');
    if (!btn) break;
    await btn.click();
    const samples = [];
    for (let t = 0; t < 6; t += 1) {
      await sleep(70);
      samples.push(await rect());
    }
    await sleep(300);
    const after = await rect();
    if (after) xSeen.push(after.x, ...samples.filter(Boolean).map((r) => r.x));
    last = after;
    assert(
      samples.filter(Boolean).length > 0 && samples.filter(Boolean).every((r) => r.right <= r.vw && r.bottom <= r.vh),
      `tutorial: step ${stepIndex + 1} card stays inside the viewport`,
      JSON.stringify(samples.filter(Boolean).slice(0, 3)),
    );
  }
  const uniqueX = [...new Set(xSeen)];
  assert(uniqueX.length <= 1, 'tutorial: coach card x-position stable across Next clicks (no left/right jump)', JSON.stringify(uniqueX));
  assert(!!last, 'tutorial: coach card still visible during the steps');

  // Reopening help while coach marks are active must render above them and stay dismissible.
  await page.keyboard.press('h');
  const helpOpen = await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 5000);
  assert(helpOpen, 'tutorial: H opens help while coach marks are active');
  await page.click('#tutorial-start');
  const helpedClosed = await waitFor(() => evaluate(() => !document.getElementById('tutorial-overlay')), 5000);
  const coachStillThere = await evaluate(() => !!document.querySelector('.coach-card-wrap'));
  assert(helpedClosed && coachStillThere, 'tutorial: closing help restores the coach card without duplicates');

  await evaluate(() => document.getElementById('coach-skip')?.click());
  const skipped = await waitFor(() => evaluate(() => !document.querySelector('.coach-card-wrap')), 4000);
  assert(skipped, 'tutorial: skip clears the coach card');

  // Regression: the help modal covers a live run. Opening it must freeze the
  // campaign clock + simulation, and closing it must resume exactly once.
  await page.keyboard.press('h');
  const helpForClock = await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 5000);
  assert(helpForClock, 'tutorial: H reopens help for the clock check');
  await sleep(400);
  const clockOpen = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(await evaluate(() => window.game.gameEngine.state === 'paused'), 'tutorial: opening help pauses the simulation');
  await sleep(2000);
  const clockHeld = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(clockHeld === clockOpen, 'tutorial: campaign clock frozen while help is open', `${clockOpen} -> ${clockHeld}`);
  await page.keyboard.press('Escape');
  const escClosedHelp = await waitFor(() => evaluate(() => !document.getElementById('tutorial-overlay')), 5000);
  assert(escClosedHelp, 'tutorial: Esc closes the help modal');
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') !== true),
    'tutorial: Esc closes help instead of opening the pause overlay behind it',
  );
  assert(await evaluate(() => window.game.gameEngine.state === 'running'), 'tutorial: closing help resumes the simulation');
  await sleep(1300);
  const clockResumed = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(clockResumed > clockHeld, 'tutorial: campaign clock runs again after help closes', `${clockHeld} -> ${clockResumed}`);
  await closeOverlays();
});

await runSection('exam', async () => {
  await bootMenu();
  const opened = await openExamPrep();
  assert(opened, 'exam: EX280 Prep overlay opens');
  const prep = await evaluate(() => {
    const overlay = document.getElementById('exam-prep-overlay') || document.querySelector('[data-testid="exam-prep"]');
    const text = overlay?.innerText || '';
    return {
      overlay: !!overlay,
      active: overlay?.classList.contains('active') === true,
      groups: overlay?.querySelectorAll('.ep-group').length || 0,
      bullets: overlay?.querySelectorAll('.ep-bullet').length || 0,
      tabs: overlay?.querySelectorAll('[data-action="tab"]').length || 0,
      labs: overlay?.querySelectorAll('.ep-lab-card').length || 0,
      cheatGroups: overlay?.querySelectorAll('.ep-cheat-group').length || 0,
      copyButtons: overlay?.querySelectorAll('[data-action="copy-command"]').length || 0,
      hasSearch: !!overlay?.querySelector('#ep-objective-search'),
      hasReadiness: !!overlay?.querySelector('#ep-readiness'),
      progressText: overlay?.querySelector('#ep-progress-label')?.textContent?.trim() || '',
      readiness: overlay?.querySelector('#ep-readiness')?.textContent?.trim() || '',
      progressBar: overlay?.querySelector('#ep-progress-fill')?.getBoundingClientRect().width || 0,
      title: overlay?.querySelector('h2')?.textContent?.trim() || '',
      hasOfficialGroups: /Manage OpenShift Container Platform/i.test(text) && /Declarative Resource Management/i.test(text) && /Configure application security/i.test(text),
      examCode: overlay?.querySelector('[data-testid="exam-facts-code"]')?.textContent?.trim() || '',
    };
  });
  assert(prep.overlay && prep.active, 'exam: overlay is active');
  assert(prep.groups === 9, 'exam: 9 official objective groups', `got ${prep.groups}`);
  assert(prep.bullets === 55, 'exam: 55 official objective bullets', `got ${prep.bullets}`);
  assert(prep.tabs === 4, 'exam: 4 sections/tabs', `got ${prep.tabs}`);
  assert(prep.labs >= 8 && prep.labs <= 10, 'exam: 8-10 quick labs', `got ${prep.labs}`);
  assert(prep.cheatGroups >= 8, 'exam: cheat sheet groups', `got ${prep.cheatGroups}`);
  assert(prep.copyButtons > 0, 'exam: command copy buttons', `got ${prep.copyButtons}`);
  assert(prep.hasSearch, 'exam: objective search present');
  assert(prep.hasReadiness, 'exam: readiness verdict present');
  assert(/\d+ \/ 55/.test(prep.progressText), 'exam: progress bar reads X/55', prep.progressText);
  assert(prep.hasOfficialGroups, 'exam: official EX280 groups rendered');
  assert(/Red Hat Certified System Administrator in OpenShift|Red Hat Certified Specialist in OpenShift Administration/.test(prep.title), 'exam: official exam name shown', prep.title);
  await shot('exam-prep.png');
  shotsTaken.push('docs/screenshots/exam-prep.png');

  const beforeSearch = prep.bullets;
  await evaluate(() => {
    const input = document.querySelector('#ep-objective-search');
    input.value = 'kustomize';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const afterSearch = await evaluate(() => document.querySelectorAll('#ep-objectives-list .ep-bullet').length);
  assert(afterSearch > 0 && afterSearch < beforeSearch, 'exam: objective search filters bullets', `${afterSearch} of ${beforeSearch}`);
  await evaluate(() => {
    const input = document.querySelector('#ep-objective-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await evaluate(() => document.querySelector('[data-action="tab"][data-tab="cheatsheet"]')?.click());
  await sleep(250);
  const cheatVisible = await evaluate(() => {
    const panel = document.querySelector('[data-tab-panel="cheatsheet"]');
    return !!panel && getComputedStyle(panel).display !== 'none' && panel.querySelectorAll('.ep-cheat-group').length >= 8;
  });
  assert(cheatVisible, 'exam: cheat sheet tab renders');
  const copied = await evaluate(() => {
    window.__copiedCommand = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text) => {
            window.__copiedCommand = text;
            return Promise.resolve();
          },
        },
      });
    } catch {
      /* ignore */
    }
    const btn = document.querySelector('[data-action="copy-command"]');
    btn?.click();
    return window.__copiedCommand || btn?.dataset?.command || '';
  });
  await sleep(150);
  assert(/(^|\s)oc\s/.test(copied), 'exam: copy command button works', copied.slice(0, 120));
  await evaluate(() => document.querySelector('[data-action="tab"][data-tab="facts"]')?.click());
  await sleep(250);
  const facts = await evaluate(() => ({
    visible: getComputedStyle(document.querySelector('[data-tab-panel="facts"]')).display !== 'none',
    code: document.querySelector('[data-testid="exam-facts-code"]')?.textContent?.trim() || '',
    text: document.querySelector('[data-tab-panel="facts"]')?.innerText || '',
  }));
  assert(facts.visible && facts.code === 'EX280V422' && /3/.test(facts.text), 'exam: exam facts tab shows EX280V422 / 3h', facts.code);
  await evaluate(() => document.querySelector('[data-action="tab"][data-tab="quicklabs"]')?.click());
  await sleep(250);

  await evaluate(() => document.querySelector('.ep-lab-card [data-action="launch-lab"], .ep-lab-card button')?.click());
  const labLaunched = await waitFor(() => evaluate(() => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance), 10000);
  const labState = await evaluate(() => ({
    overlay: document.getElementById('exam-prep-overlay')?.classList.contains('active') === true,
    mode: window.game?.app?.currentMode,
    modeInstance: window.game?.app?.modeInstance?.constructor?.name,
  }));
  assert(labLaunched && labState.mode === 'sandbox', 'exam: quick lab launches Sandbox', JSON.stringify(labState));
  assert(!labState.overlay, 'exam: overlay closes on quick lab launch');
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SANDBOX SEED / PALETTE / HUD / SCREENSHOT
// ═══════════════════════════════════════════════════════════════════════════
await runSection('sandbox', async () => {
  const ok = await bootSandbox();
  assert(ok, 'sandbox: Sandbox mode starts');
  await ensureManifestEngine();
  const state = await evaluate(() => {
    const app = window.game.app;
    const cluster = window.game.cluster;
    const palette = [...document.querySelectorAll('#resource-palette .palette-item')].map((el) => el.dataset.resource);
    const resources = cluster.getAllResources?.() || [];
    const byKind = {};
    for (const resource of resources) byKind[resource.kind] = (byKind[resource.kind] || 0) + 1;
    return {
      resourceCount: resources.length,
      meshCount: app.renderer?.resourceMeshes?.size ?? 0,
      palette,
      projects: cluster.getByKind?.('Project')?.length || 0,
      clusterOperators: cluster.getByKind?.('ClusterOperator')?.length || 0,
      nodes: cluster.getByKind?.('Node')?.length || 0,
      sccs: cluster.getByKind?.('SecurityContextConstraints')?.length || 0,
      imageStreams: byKind.ImageStream || 0,
      hudLogo: document.querySelector('[data-testid="hud-logo"]')?.textContent?.trim() || '',
      hudMode: document.querySelector('[data-testid="hud-mode"]')?.textContent?.trim() || '',
      toolbar: !!document.getElementById('view-toolbar'),
      webglError: !!document.getElementById('webgl-error'),
      currentMode: app.currentMode,
    };
  });
  // The seeded platform baseline grew when the real OCP 4.22 default SCC set
  // (14 objects) replaced the old 4-object approximation, and again when the
  // OLM software catalog (PackageManifests + global-operators OperatorGroup)
  // and the default self-provisioner RBAC objects were seeded.
  assert(state.resourceCount >= 45 && state.resourceCount <= 75, 'sandbox: seeded platform resources', `got ${state.resourceCount}`);
  assert(state.meshCount >= 45 && Math.abs(state.meshCount - state.resourceCount) <= 2, 'sandbox: one mesh per seeded resource', `${state.meshCount} meshes / ${state.resourceCount} resources`);
  assert(state.palette.length === 37, 'sandbox: palette has 37 placeable kinds', `got ${state.palette.length}`);
  for (const kind of ['Project', 'Route', 'BuildConfig', 'ImageStream', 'Template', 'Subscription', 'SecurityContextConstraints', 'User', 'Group', 'IPAddressPool', 'L2Advertisement']) {
    assert(state.palette.includes(kind), `sandbox: palette kind ${kind}`);
  }
  assert(state.projects >= 10, 'sandbox: OpenShift default Projects seeded', `got ${state.projects}`);
  assert(state.clusterOperators === 13, 'sandbox: 13 ClusterOperators seeded', `got ${state.clusterOperators}`);
  assert(state.nodes >= 3, 'sandbox: default Nodes seeded', `got ${state.nodes}`);
  assert(state.sccs >= 4, 'sandbox: default SCCs seeded', `got ${state.sccs}`);
  assert(state.imageStreams >= 3, 'sandbox: default ImageStreams seeded', `got ${state.imageStreams}`);
  assert(state.hudLogo === 'OpenShift Games', 'sandbox: HUD logo is OpenShift Games', state.hudLogo);
  assert(/OpenShift 4\.22/.test(state.hudMode), 'sandbox: HUD mode label is OpenShift 4.22', state.hudMode);
  assert(!/K8s Games|Kubernetes Cluster Simulation/i.test(state.hudLogo), 'sandbox: no legacy branding in HUD');
  assert(state.toolbar, 'sandbox: toolbar visible');
  assert(!state.webglError, 'sandbox: WebGL renderer initialised');
  await evaluate(() => window.game.app.autoAlignResources?.());
  await sleep(1200);
  const sandboxShot = await shot('sandbox.png');
  if (sandboxShot) shotsTaken.push(sandboxShot);
  await page.screenshot({ path: join(ROOT, 'screenshot.png') });
  console.log('  SHOT  screenshot.png (1600x900 hero)');
  shotsTaken.push('screenshot.png');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. FILES / MANIFEST PANEL
// ═══════════════════════════════════════════════════════════════════════════
await runSection('files', async () => {
  if (!(await evaluate(() => window.game?.app?.currentMode === 'sandbox'))) await bootSandbox();
  const opened = await openFilesPanel();
  assert(opened, 'files: Files panel opens from #btn-manifests');
  const files = await evaluate(() => {
    const engine = window.game.manifestEngine;
    return {
      count: engine?.listFiles?.().length || 0,
      names: engine?.listFiles?.() || [],
      tree: document.querySelectorAll('[data-testid="manifest-file"]').length,
      editor: !!document.querySelector('[data-testid="manifest-editor"]'),
      buttons: {
        apply: !!document.querySelector('[data-testid="manifest-apply"]'),
        kustomize: !!document.querySelector('[data-testid="manifest-apply-kustomize"]'),
        save: !!document.querySelector('[data-testid="manifest-save"]'),
      },
      visible: window.game.manifestPanel?.visible === true,
    };
  });
  assert(files.count >= 19, 'files: default manifest files seeded', `got ${files.count}`);
  assert(files.tree >= 19, 'files: file tree lists the default files', `got ${files.tree}`);
  assert(files.editor && files.buttons.apply && files.buttons.kustomize && files.buttons.save, 'files: editor and Apply -f/-k buttons present');
  for (const expected of ['manifests/deployment.yaml', 'kustomize/overlays/prod/kustomization.yaml', 'templates/webapp-template.yaml', 'helm/webapp/Chart.yaml', 'htpasswd']) {
    assert(files.names.includes(expected), `files: default file ${expected}`);
  }
  const filesShot = await shot('files-panel.png');
  if (filesShot) shotsTaken.push(filesShot);

  await evaluate(() => {
    document.querySelector('[data-testid="manifest-file"][data-path="manifests/deployment.yaml"]')?.click();
  });
  await sleep(250);
  await evaluate(() => document.querySelector('[data-testid="manifest-apply"]')?.click());
  await sleep(900);
  const applyResult = await evaluate(() => ({
    hasDeployment: window.game.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'webapp') || false,
    resultText: document.querySelector('[data-testid="manifest-result"]')?.textContent || '',
    errorText: document.querySelector('[data-testid="manifest-error"]')?.textContent || '',
  }));
  assert(applyResult.hasDeployment, 'files: Apply -f creates Deployment/webapp', applyResult.errorText.slice(0, 200));
  assert(/created|configured|apply complete/i.test(applyResult.resultText), 'files: Apply -f shows result output', applyResult.resultText.slice(0, 200));

  await evaluate(() => {
    document.querySelector('[data-testid="manifest-file"][data-path="kustomize/overlays/prod/kustomization.yaml"]')?.click();
  });
  await sleep(250);
  await evaluate(() => document.querySelector('[data-testid="manifest-apply-kustomize"]')?.click());
  await sleep(1000);
  const kustomizeResult = await evaluate(() => ({
    hasProd: window.game.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'prod-webapp') || false,
    applied: window.game.manifestEngine?.hasAppliedKustomize?.('kustomize/overlays/prod') ?? null,
    resultText: document.querySelector('[data-testid="manifest-result"]')?.textContent || '',
    errorText: document.querySelector('[data-testid="manifest-error"]')?.textContent || '',
  }));
  assert(kustomizeResult.hasProd, 'files: Apply -k creates Deployment/prod-webapp', kustomizeResult.errorText.slice(0, 200));
  assert(kustomizeResult.applied !== false, 'files: Apply -k records the prod overlay');
  await evaluate(() => window.game.manifestPanel?.hide?.());

  // Regression: Files is a full-screen surface. It pauses the simulation while
  // open, and its own Esc handler closes it (no pause card) and resumes once.
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesReopened = await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 5000);
  assert(filesReopened, 'files: F reopens the panel for the pause check');
  assert(await evaluate(() => window.game.gameEngine.state === 'paused'), 'files: opening the panel pauses the simulation');
  // #20 QA: the pause must be visible, not silent.
  const pausedChip = await evaluate(() => {
    const chip = document.getElementById('hud-paused');
    const rect = chip?.getBoundingClientRect();
    return {
      hidden: chip?.hidden,
      reason: document.getElementById('hud-paused-reason')?.textContent,
      aria: chip?.getAttribute('aria-label'),
      rect: rect ? { x: Math.round(rect.x), right: Math.round(rect.right), y: Math.round(rect.y) } : null,
    };
  });
  assert(pausedChip.hidden === false, 'files: HUD shows a visible paused indicator', JSON.stringify(pausedChip));
  assert(pausedChip.reason === 'Files open', 'files: paused indicator names the Files reason', JSON.stringify(pausedChip));
  assert(/Simulation paused: Files open/.test(pausedChip.aria || ''), 'files: paused indicator is announced accessibly', pausedChip.aria);
  assert(
    pausedChip.rect && pausedChip.rect.x >= 0 && pausedChip.rect.right <= 1600 && pausedChip.rect.y < 60,
    'files: paused indicator stays inside the HUD bar',
    JSON.stringify(pausedChip.rect),
  );
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const filesClosedByEsc = await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === false), 5000);
  assert(filesClosedByEsc, 'files: Esc closes the panel');
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') !== true),
    'files: Esc closing Files does not open the pause overlay',
  );
  await sleep(350);
  assert(await evaluate(() => window.game.gameEngine.state === 'running'), 'files: closing the panel resumes the simulation');
  assert(
    await evaluate(() => document.getElementById('hud-paused')?.hidden === true),
    'files: paused indicator clears when the run resumes',
  );

  // #20 QA: `vim file` opens the Files panel too — the pause must be equally visible.
  const vimResult = await evaluate(() => window.game.app.commandBar.executeCommand('vim manifests/deployment.yaml'));
  await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 5000);
  await sleep(450);
  const vimChip = await evaluate(() => ({
    hidden: document.getElementById('hud-paused')?.hidden,
    reason: document.getElementById('hud-paused-reason')?.textContent,
    panel: window.game.manifestPanel?.visible === true,
  }));
  assert(vimChip.panel, 'files: vim opens the Files panel', JSON.stringify({ vimResult: vimResult?.message }));
  assert(vimChip.hidden === false && vimChip.reason === 'Files open', 'files: vim-triggered Files open shows the paused indicator', JSON.stringify(vimChip));
  await evaluate(() => window.game.manifestPanel?.hide?.());
  await sleep(350);
  assert(
    await evaluate(() => document.getElementById('hud-paused')?.hidden === true),
    'files: paused indicator clears after the vim-triggered panel closes',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CLI / oc COMMAND SUITE (incl. HTPasswd + login)
// ═══════════════════════════════════════════════════════════════════════════
await runSection('cli', async () => {
  if (!(await evaluate(() => window.game?.app?.currentMode === 'sandbox'))) await bootSandbox();
  await ensureManifestEngine();
  // Headless SwiftShader renders slowly; run controllers faster so the 5-8s
  // OpenShift controller timings complete within a reasonable wall-clock test.
  await evaluate(() => {
    window.game?.gameEngine?.resume?.();
    window.game?.gameEngine?.setTimeScale?.(4);
    window.game?.gameEngine?.simulation?.setBuildFailureRate?.(0);
  });
  await sleep(250);
  const project = 'ex280-demo';

  await expectCmd('cli: oc whoami', 'oc whoami', /kubeadmin|admin/i);
  await expectCmd('cli: oc get nodes', 'oc get nodes', /Ready/);
  await expectCmd('cli: oc get clusteroperators', 'oc get clusteroperators', /authentication|dns|ingress|VERSION/i);
  await expectCmd('cli: oc get clusterversion', 'oc get clusterversion', /4\.22\.0/);
  await expectCmd('cli: oc new-project', `oc new-project ${project} --description="EX280 lab"`, /Now using project|created/i);
  await expectCmd('cli: oc project', `oc project ${project}`, /Now using project/i);
  await expectCmd('cli: oc create deployment', `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${project}`, /deployment\.apps\/web created/i);
  await expectCmd('cli: oc expose svc creates Route', `oc expose svc/web -n ${project}`, /route.*(exposed|created)/i);
  await expectCmd('cli: oc get routes', `oc get routes -n ${project}`, /web/);
  await expectCmd('cli: oc set env', `oc set env deployment/web APP_ENV=dev -n ${project}`, /updated|environment/i);
  await expectCmd('cli: oc set image', `oc set image deployment/web origin-hello-openshift=quay.io/openshift/origin-hello-openshift:v1.1 -n ${project}`, /image updated|updated/i);
  await expectCmd('cli: oc set resources', `oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi -n ${project}`, /resource requirements updated|updated/i);
  await expectCmd('cli: oc create configmap', `oc create configmap app-config --from-literal=APP_ENV=dev -n ${project}`, /configmap\/app-config created/i);
  await expectCmd('cli: oc create secret', `oc create secret generic app-secret --from-literal=password=s3cret -n ${project}`, /secret\/app-secret created/i);

  // CLI fidelity: a namespaced request against a nonexistent project must fail
  // like a real API server instead of rendering an empty table/list.
  await expectCmdError('cli: get pods in missing namespace → NotFound', 'oc get pods -n does-not-exist', /Error from server \(NotFound\): namespaces "does-not-exist" not found/);
  await expectCmdError('cli: get multiple kinds in missing namespace → NotFound', 'oc get deployments,services -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: get all in missing namespace → NotFound', 'oc get all -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: get events in missing namespace → NotFound', 'oc get events -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: get -o yaml in missing namespace → NotFound', 'oc get pods -n does-not-exist -o yaml', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: describe in missing namespace → NotFound', 'oc describe pod nope -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: delete in missing namespace → NotFound', 'oc delete pod nope -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: delete --all in missing namespace → NotFound', 'oc delete pods --all -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: create in missing namespace → NotFound', 'oc create deployment nope --image=quay.io/openshift/origin-hello-openshift:latest -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: apply -f in missing namespace → NotFound', 'oc apply -f manifests/deployment.yaml -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmdError('cli: status in missing namespace → NotFound', 'oc status -n does-not-exist', /namespaces "does-not-exist" not found/);
  await expectCmd('cli: get -A ignores a missing -n namespace', 'oc get pods --all-namespaces -n does-not-exist', /No resources found|NAME/);
  await expectCmd('cli: cluster-scoped get ignores -n', 'oc get nodes -n does-not-exist', /Ready/);
  const projectNotFound = await runCmd('oc project does-not-exist', 120);
  assert(
    projectNotFound.error && /A project named "does-not-exist" does not exist/.test(projectNotFound.message),
    'cli: oc project reports a sensible project-not-found error',
    projectNotFound.message.slice(0, 200),
  );
  const rawVersion = await runCmd('oc get --raw /version', 120);
  assert(
    !rawVersion.error &&
      /"gitVersion": "v4\.22\.0"/.test(rawVersion.message) &&
      /"kubernetesVersion": "v1\.35\.2"/.test(rawVersion.message) &&
      /"platform": "linux\/amd64"/.test(rawVersion.message),
    'cli: oc get --raw /version returns server version JSON',
    rawVersion.message.slice(0, 200),
  );

  // CLI fidelity: `-n` on apply/create/replace -f re-targets every object
  // (like oc's EnforceNamespace), including multi-document files, manifest
  // metadata.namespace and `-f -` stdin; no `-n` keeps using the current project.
  await expectCmd('cli: apply -f -n retargets to project', 'oc apply -f manifests/deployment.yaml -n openshift', /created|configured|unchanged/i);
  const retargetedDeploy = await findResource('Deployment', 'webapp', 'openshift');
  assert(!!retargetedDeploy, 'cli: apply -f -n puts Deployment/webapp in the -n project');
  await expectCmd('cli: create -f -n retargets to project', 'oc create -f manifests/service.yaml -n openshift', /created|configured|unchanged/i);
  const retargetedService = await findResource('Service', 'webapp', 'openshift');
  assert(!!retargetedService, 'cli: create -f -n puts Service/webapp in the -n project');
  await expectCmd('cli: replace -f -n retargets to project', 'oc replace -f manifests/deployment.yaml -n openshift', /replaced|configured|created/i);
  await evaluate(() => {
    window.game?.manifestEngine?.writeFile?.(
      'manifests/fidelity-multi.yaml',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fidelity-multi-cm\n  namespace: openshift-operators\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: fidelity-multi-secret\n',
    );
  });
  await expectCmd('cli: apply multi-doc -f -n overrides manifest namespaces', 'oc apply -f manifests/fidelity-multi.yaml -n openshift', /created|configured|unchanged/i);
  const multiCm = await findResource('ConfigMap', 'fidelity-multi-cm', 'openshift');
  const multiSecret = await findResource('Secret', 'fidelity-multi-secret', 'openshift');
  assert(!!multiCm && !!multiSecret, 'cli: multi-doc apply -f -n overrides manifest metadata.namespace');
  await expectCmd('cli: process | apply -f - -n retargets stdin objects', 'oc process -f templates/webapp-template.yaml -p APP_NAME=retarget-demo | oc apply -f - -n openshift', /created|configured|unchanged/i);
  const retargetedStdin = await findResource('Deployment', 'retarget-demo', 'openshift');
  assert(!!retargetedStdin, 'cli: apply -f - -n puts stdin objects in the -n project');
  await expectCmdError('cli: new-app in missing namespace → NotFound', 'oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=missing-ns-app -n does-not-exist', /Error from server \(NotFound\): namespaces "does-not-exist" not found/);
  await expectCmdError('cli: expose in missing namespace → NotFound', 'oc expose svc/web -n does-not-exist', /Error from server \(NotFound\): namespaces "does-not-exist" not found/);

  const podReady = await waitFor(async () => {
    return evaluate((ns) => {
      const pods = window.game.cluster.getByKind?.('Pod') || [];
      return pods.some((p) => (p.metadata?.namespace || '') === ns && (p.status?.phase || p.phase) === 'Running');
    }, project);
  }, 20000);
  const podName = await evaluate((ns) => {
    const pods = window.game.cluster.getByKind?.('Pod') || [];
    return pods.find((p) => (p.metadata?.namespace || '') === ns && (p.status?.phase || p.phase) === 'Running')?.metadata?.name || null;
  }, project);
  assert(podReady && podName, 'cli: Deployment controller creates a Running Pod', `pod=${podName}`);
  if (podName) await expectNonEmpty('cli: oc logs', `oc logs ${podName} -n ${project}`);
  await expectCmd('cli: oc describe deployment', `oc describe deployment/web -n ${project}`, /Name:|Deployment/i);
  await expectCmd('cli: oc rollout status', `oc rollout status deployment/web -n ${project}`, /deployment|rollout/i);

  // #26: real oc only prints the container-defaulting hint for MULTI-container
  // pods; a single-container pod's exec/rsh must run the command in silence.
  const execSingle = await runCmd(`oc exec ${podName} -n ${project} -- whoami`);
  assert(
    !execSingle.error && !/Defaulting container name|Use 'oc describe pod/.test(execSingle.message),
    'cli: exec single-container pod prints no container-defaulting hint',
    execSingle.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );
  const rshSingle = await runCmd(`oc rsh ${podName} -n ${project} hostname`);
  assert(
    !rshSingle.error && !/Defaulting container name|Use 'oc describe pod/.test(rshSingle.message),
    'cli: rsh single-container pod prints no container-defaulting hint',
    rshSingle.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );
  const multiPod = `apiVersion: v1
kind: Pod
metadata:
  name: multi
  namespace: ${project}
  labels:
    app: multi
spec:
  containers:
    - name: first
      image: quay.io/openshift/origin-hello-openshift:latest
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits: { cpu: 200m, memory: 128Mi }
    - name: second
      image: quay.io/openshift/origin-hello-openshift:latest
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits: { cpu: 200m, memory: 128Mi }
`;
  await evaluate((text) => window.game.manifestEngine.writeFile('qa/multi-pod.yaml', text), multiPod);
  await expectCmd('cli: create multi-container Pod', 'oc apply -f qa/multi-pod.yaml -n ex280-demo', /pod\/multi created|created|configured/i);
  await waitFor(() => evaluate(() => {
    const pod = window.game.cluster.getByName?.('Pod', 'multi', 'ex280-demo');
    return pod?.status?.phase === 'Running' && (pod.status.containerStatuses || []).every((status) => status.ready);
  }), 10000);
  const execMulti = await runCmd(`oc exec pod/multi -n ${project} -- hostname`);
  assert(
    !execMulti.error
      && /Defaulting container name to "first"/.test(execMulti.message)
      && /Use 'oc describe pod\/multi -n ex280-demo'/.test(execMulti.message),
    'cli: exec multi-container pod still prints the container-defaulting hint',
    execMulti.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );
  const execMultiNamed = await runCmd(`oc exec pod/multi -n ${project} -c second -- hostname`);
  assert(
    !execMultiNamed.error && !/Defaulting container name/.test(execMultiNamed.message),
    'cli: exec -c suppresses the container-defaulting hint',
    execMultiNamed.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );

  // #26: sed must exist in the shell and work inside `oc ... | sed ...` pipes.
  const describePodOne = await runCmd(`oc describe pod ${podName} -n ${project}`);
  const describeHead = describePodOne.message.trim().split('\n').slice(0, 5).join('\n');
  const sedHead = await runCmd(`oc describe pod ${podName} -n ${project} | sed -n '1,5p'`);
  assert(
    !sedHead.error && sedHead.message.trim() === describeHead,
    'cli: describe | sed -n \'1,5p\' echoes the first 5 lines',
    sedHead.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );
  const sedUnquoted = await runCmd(`oc describe pod ${podName} -n ${project} | sed -n 1,40p`);
  assert(
    !sedUnquoted.error && sedUnquoted.message.trim() === describePodOne.message.trim().split('\n').slice(0, 40).join('\n'),
    'cli: describe | sed -n 1,40p (unquoted) works in a pipe',
    sedUnquoted.message.replace(/\n/g, ' ⏎ ').slice(0, 240),
  );
  const sedSub = await runCmd(`echo 'foo bar foo' | sed 's/foo/baz/'`);
  assert(!sedSub.error && sedSub.message.trim() === 'baz bar foo', 'cli: sed s/// substitutes in a pipe', sedSub.message.slice(0, 120));

  // #20 QA: nginx:latest under restricted-v2 is ADMITTED (SCC admission only
  // sees the pod spec, not the image USER), then the container crash-loops with
  // the real nginx permission-denied log. Only a spec that EXPLICITLY requests
  // root/privileged is rejected with RS FailedCreate. The documented anyuid
  // service-account fix path makes it run (#25).

  const nginxProject = 'nginx-lab';
  await expectCmd('cli: create nginx-lab project', `oc new-project ${nginxProject}`, /Now using project|created/i);
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  await expectCmd(
    'cli: nginx:latest deployment is admitted under restricted-v2',
    `oc create deployment ngx --image=nginx:latest -n ${nginxProject}`,
    /deployment\.apps\/ngx created/i,
  );
  const readNginxLab = () => evaluate((ns) => {
    const cluster = window.game.cluster;
    const deployment = cluster.getByName?.('Deployment', 'ngx', ns);
    const replicaSets = deployment ? (cluster.getChildren?.(deployment.uid) || []).filter((child) => child.kind === 'ReplicaSet') : [];
    const pods = (cluster.getByKindAndNamespace?.('Pod', ns) || []).filter((pod) => /^ngx-/.test(pod.metadata?.name || ''));
    return {
      podCount: pods.length,
      pods: pods.map((pod) => {
        const status = (pod.status?.containerStatuses || [])[0] || {};
        return {
          name: pod.metadata.name,
          phase: pod.status?.phase,
          scc: pod.metadata.annotations?.['openshift.io/scc'] || null,
          waiting: status.state?.waiting?.reason || null,
          ready: status.ready === true,
          restarts: status.restartCount || 0,
          lastTerminated: status.lastState?.terminated?.exitCode ?? null,
        };
      }),
      rsConditions: replicaSets.flatMap((set) => set.status?.conditions || []).map((condition) => `${condition.type}=${condition.status}/${condition.reason}`),
      deployConditions: (deployment?.status?.conditions || []).map((condition) => `${condition.type}=${condition.status}/${condition.reason}`),
      availableReplicas: deployment?.status?.availableReplicas ?? null,
    };
  }, nginxProject);
  const nginxAdmitted = await waitFor(async () => {
    const state = await readNginxLab();
    return state.podCount === 1 && !state.rsConditions.some((line) => /ReplicaFailure=True/.test(line));
  }, 30000);
  let nginxState = await readNginxLab();
  assert(
    nginxAdmitted,
    'cli: nginx:latest pod is ADMITTED (pod exists, no RS FailedCreate)',
    JSON.stringify({ pods: nginxState.podCount, rsConditions: nginxState.rsConditions }),
  );
  assert(
    nginxState.pods[0]?.scc === 'restricted-v2',
    'cli: admitted nginx pod runs under scc=restricted-v2',
    JSON.stringify(nginxState.pods.map((pod) => pod.scc)),
  );
  await waitFor(async () => {
    const state = await readNginxLab();
    return state.pods.some((pod) => pod.waiting === 'CrashLoopBackOff' && pod.restarts > 0);
  }, 30000);
  nginxState = await readNginxLab();
  assert(
    nginxState.pods.some((pod) => pod.waiting === 'CrashLoopBackOff' && pod.restarts > 0),
    'cli: nginx pod crash-loops (CrashLoopBackOff, restarts > 0)',
    JSON.stringify(nginxState.pods),
  );
  assert(
    nginxState.pods.some((pod) => pod.phase === 'Running'),
    'cli: crash-looping nginx pod stays Running (admission did not reject it)',
    JSON.stringify(nginxState.pods.map((pod) => pod.phase)),
  );
  assert(
    nginxState.pods.some((pod) => pod.lastTerminated === 1),
    'cli: nginx container lastState records the crash (exit code 1)',
    JSON.stringify(nginxState.pods.map((pod) => pod.lastTerminated)),
  );
  await expectCmd('cli: oc get pods shows CrashLoopBackOff', `oc get pods -n ${nginxProject}`, /ngx-[a-z0-9-]+\s+0\/1\s+CrashLoopBackOff\s+[1-9]/);
  await expectCmd(
    'cli: nginx crash log is the permission-denied emerge',
    `oc logs deployment/ngx -n ${nginxProject}`,
    /mkdir\(\).*(client_temp).*Permission denied/,
  );
  await expectCmd(
    'cli: nginx deployment reports Available False MinimumReplicasUnavailable',
    `oc describe deployment/ngx -n ${nginxProject}`,
    /Available\s+False\s+MinimumReplicasUnavailable/,
  );

  // An explicitly requested root user is still rejected at admission: the
  // ReplicaSet reports FailedCreate and NO Pod object is created.
  const rootDeployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ngx-root
  namespace: ${nginxProject}
  labels:
    app: ngx-root
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ngx-root
  template:
    metadata:
      labels:
        app: ngx-root
    spec:
      containers:
        - name: main
          image: nginx:latest
          securityContext:
            runAsUser: 0
`;
  await evaluate((text) => window.game.manifestEngine.writeFile('qa/root-deploy.yaml', text), rootDeployment);
  await expectCmd(
    'cli: apply explicit runAsUser:0 deployment',
    'oc apply -f qa/root-deploy.yaml',
    /deployment\.apps\/ngx-root created|created|configured/i,
  );
  const readRootFailure = () => evaluate((ns) => {
    const cluster = window.game.cluster;
    const deployment = cluster.getByName?.('Deployment', 'ngx-root', ns);
    const replicaSets = deployment ? (cluster.getChildren?.(deployment.uid) || []).filter((child) => child.kind === 'ReplicaSet') : [];
    return {
      messages: replicaSets.flatMap((set) => (
        (set.status?.conditions || [])
          .filter((condition) => condition.type === 'ReplicaFailure')
          .map((condition) => `${condition.reason}:${condition.message}`)
      )),
      pods: (cluster.getByKindAndNamespace?.('Pod', ns) || []).filter((pod) => pod.metadata?.labels?.app === 'ngx-root').length,
    };
  }, nginxProject);
  const rootDenied = await waitFor(async () => {
    const state = await readRootFailure();
    return state.messages.length > 0 && state.pods === 0;
  }, 20000);
  const rootState = await readRootFailure();
  assert(rootDenied, 'cli: explicit runAsUser:0 still gets RS FailedCreate with no Pod', JSON.stringify(rootState));
  assert(
    rootState.messages.some((line) => /unable to validate against any security context constraint/.test(line)),
    'cli: explicit root denial message is the SCC one',
    JSON.stringify(rootState.messages),
  );

  // #26: real oc aggregates repeated FailedCreate retries into ONE Event row
  // with a `(xN over …)` LAST SEEN suffix. Advance game time past the 10s retry
  // throttle so the burst is deterministic instead of waiting ~2 wall-clock min.
  await advanceSimulation(150);
  const failedCreateRetries = await evaluate((ns) => (
    window.game.gameEngine.simulation.getEvents({ namespace: ns, reason: 'FailedCreate' }) || []
  ).length, nginxProject);
  assert(failedCreateRetries >= 10, 'cli: explicit violation generated >= 10 FailedCreate retries', `got ${failedCreateRetries}`);
  const failedCreateEvents = await expectCmd(
    'cli: events --field-selector reason=FailedCreate',
    `oc get events --field-selector reason=FailedCreate -n ${nginxProject}`,
    /FailedCreate/,
  );
  const failedCreateTable = parseTable(failedCreateEvents.message);
  const failedCreateRows = failedCreateTable.rows.filter((row) => row[2] === 'FailedCreate');
  assert(
    /^LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE$/.test(failedCreateTable.header),
    'cli: events table keeps LAST SEEN/TYPE/REASON/OBJECT/MESSAGE header',
    failedCreateTable.header,
  );
  assert(
    failedCreateRows.length === 1,
    'cli: FailedCreate retries aggregate into exactly one row',
    `${failedCreateRows.length}: ${JSON.stringify(failedCreateRows)}`,
  );
  const aggregateCell = failedCreateRows[0]?.[0] || '';
  const aggregateCount = aggregateCell.match(/\(x(\d+) over [^)]+\)/);
  assert(
    Boolean(aggregateCount) && Number(aggregateCount[1]) >= 10,
    'cli: aggregated FailedCreate row carries (xN over …) with N >= 10',
    aggregateCell,
  );

  // The documented anyuid fix path: dedicated SA + SCC grant + deployment SA.
  await expectCmd('cli: create nginx-sa', `oc create sa nginx-sa -n ${nginxProject}`, /serviceaccount\/nginx-sa created/i);
  await expectCmd('cli: grant anyuid to nginx-sa', `oc adm policy add-scc-to-user anyuid -z nginx-sa -n ${nginxProject}`, /added|anyuid/i);
  await expectCmd(
    'cli: point ngx at nginx-sa',
    `oc set serviceaccount deployment/ngx nginx-sa -n ${nginxProject}`,
    /serviceaccount|updated/i,
  );
  const nginxFixed = await waitFor(async () => {
    const state = await readNginxLab();
    return state.podCount === 1
      && state.pods[0].scc === 'anyuid'
      && state.pods[0].phase === 'Running'
      && state.pods[0].ready === true
      && state.availableReplicas >= 1;
  }, 45000);
  nginxState = await readNginxLab();
  assert(nginxFixed, 'cli: anyuid service-account fix path leaves exactly one Running/Ready pod', JSON.stringify(nginxState));
  assert(
    nginxState.pods[0]?.scc === 'anyuid',
    'cli: fixed nginx pod runs under scc=anyuid',
    JSON.stringify(nginxState.pods.map((pod) => pod.scc)),
  );
  assert(
    nginxState.deployConditions.includes('Available=True/MinimumReplicasAvailable'),
    'cli: fixed nginx deployment reports Available True MinimumReplicasAvailable',
    JSON.stringify(nginxState.deployConditions),
  );
  await expectCmd('cli: oc get deployment ngx shows 1/1 ready', `oc get deployment ngx -n ${nginxProject}`, /1\/1/);
  const routeAdmittedEarly = await waitFor(() => evaluate((ns) => {
    const route = (window.game.cluster.getByKind?.('Route') || []).find((r) => r.metadata?.name === 'web' && r.metadata?.namespace === ns);
    return !!route?.status?.ingress?.[0]?.conditions?.some((c) => c.type === 'Admitted' && c.status === 'True');
  }, project), 25000);
  const routeEarly = await findResource('Route', 'web', project);
  assert(routeAdmittedEarly, 'cli: Route/web is Admitted by the router', JSON.stringify(routeEarly?.status?.ingress?.[0]?.conditions || null));

  await expectCmd('cli: oc apply -f manifest', 'oc apply -f manifests/deployment.yaml', /created|configured|unchanged/i);
  // The prod overlay targets the webapp-prod project (`namespace: webapp-prod`
  // in the kustomization). A real API server rejects a namespaced apply into a
  // non-existent project, so make sure it exists first — the files section may
  // already have applied the same overlay when both sections run together.
  const overlayProjectExists = await evaluate(
    () => (window.game.cluster.getByKind?.('Project') || []).some((p) => p.metadata?.name === 'webapp-prod'),
  );
  if (overlayProjectExists) {
    await expectCmd('cli: switch to the overlay project', 'oc project webapp-prod', /Now using project/i);
  } else {
    await expectCmd('cli: pre-create the overlay project', 'oc new-project webapp-prod', /Now using project|created/i);
  }
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  await expectCmd('cli: oc apply -k prod overlay', 'oc apply -k kustomize/overlays/prod', /created|configured|unchanged/i);
  await expectCmd('cli: oc process | oc apply', 'oc process -f templates/webapp-template.yaml -p APP_NAME=demo | oc apply -f -', /created|configured|unchanged/i);
  await expectCmd('cli: oc new-app image', `oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=api -n ${project}`, /created|Success|deployment/i);
  await expectCmd('cli: oc process --parameters', 'oc process -f templates/webapp-template.yaml --parameters', /APP_NAME|NAME/i);
  await expectCmd('cli: helm install', 'helm install webapp helm/webapp', /NAME:|deployed/i);
  await expectCmd('cli: helm list', 'helm list', /webapp/);
  await expectCmd('cli: helm uninstall', 'helm uninstall webapp', /uninstalled|release/i);

  // #24: Helm 3 history/rollback semantics — only the latest revision is
  // `deployed`, older revisions are `superseded`, a rollback re-deploys the
  // target revision's CHART (no repo prefix, real APP VERSION) and install
  // output has no CHART: line.
  const helmProject = 'helm-lab';
  await expectCmd('cli: create helm-lab project', `oc new-project ${helmProject}`, /Now using project|created/i);
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  await expectCmd(
    'cli: helm repo add bitnami',
    'helm repo add bitnami https://charts.bitnami.com/bitnami',
    /has been added to your repositories/i,
  );
  const helmInstall = await expectCmd(
    'cli: helm install bitnami/nginx 15.0.0',
    `helm install web bitnami/nginx --version 15.0.0 -n ${helmProject}`,
    /^NAME: web$/m,
  );
  assert(
    !/^CHART:/m.test(helmInstall.message)
      && /^LAST DEPLOYED: [A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/m.test(helmInstall.message)
      && new RegExp(`^NAMESPACE: ${helmProject}$`, 'm').test(helmInstall.message)
      && /^STATUS: deployed$/m.test(helmInstall.message)
      && /^REVISION: 1$/m.test(helmInstall.message)
      && /^TEST SUITE: None$/m.test(helmInstall.message),
    'cli: helm install output has the real shape (no CHART: line)',
    helmInstall.message.replace(/\n/g, ' ⏎ ').slice(0, 320),
  );
  const helmUpgrade = await expectCmd(
    'cli: helm upgrade bitnami/nginx 15.1.0',
    `helm upgrade web bitnami/nginx --version 15.1.0 -n ${helmProject}`,
    /^REVISION: 2$/m,
  );
  assert(!/^CHART:/m.test(helmUpgrade.message), 'cli: helm upgrade output has no CHART: line', helmUpgrade.message.replace(/\n/g, ' ⏎ ').slice(0, 240));
  await expectCmd('cli: helm rollback web 1', `helm rollback web 1 -n ${helmProject}`, /Rollback was a success/i);
  const historyRun = await expectCmd(
    'cli: helm history header',
    `helm history web -n ${helmProject}`,
    /REVISION.*UPDATED.*STATUS.*CHART.*APP VERSION.*DESCRIPTION/,
  );
  const historyTable = parseTable(historyRun.message);
  const historyRow = (index) => historyTable.rows[index] || [];
  assert(historyTable.rows.length === 3, 'cli: helm history has exactly 3 revisions', JSON.stringify(historyTable.rows));
  assert(
    historyRow(0)[2] === 'superseded' && historyRow(0)[3] === 'nginx-15.0.0' && historyRow(0)[4] === '1.25.3' && historyRow(0)[5] === 'Install complete',
    'cli: helm history rev 1 is superseded nginx-15.0.0 1.25.3 Install complete',
    JSON.stringify(historyRow(0)),
  );
  assert(
    historyRow(1)[2] === 'superseded' && historyRow(1)[3] === 'nginx-15.1.0' && historyRow(1)[4] === '1.25.3' && historyRow(1)[5] === 'Upgrade complete',
    'cli: helm history rev 2 is superseded nginx-15.1.0 1.25.3 Upgrade complete',
    JSON.stringify(historyRow(1)),
  );
  assert(
    historyRow(2)[2] === 'deployed' && historyRow(2)[3] === 'nginx-15.0.0' && historyRow(2)[4] === '1.25.3' && historyRow(2)[5] === 'Rollback to 1',
    'cli: helm history rev 3 is deployed nginx-15.0.0 Rollback to 1 (rollback re-deploys rev 1 chart)',
    JSON.stringify(historyRow(2)),
  );
  assert(
    historyTable.rows.filter((row) => row[2] === 'deployed').length === 1,
    'cli: only the latest helm history revision is deployed',
    JSON.stringify(historyTable.rows.map((row) => `${row[0]}:${row[2]}`)),
  );
  assert(
    historyTable.rows.every((row) => !String(row[3] || '').includes('bitnami/')),
    'cli: helm history CHART column has no repo prefix',
    JSON.stringify(historyTable.rows.map((row) => row[3])),
  );
  const rolledBackYaml = await runCmd(`oc get deployment web -n ${helmProject} -o yaml`);
  assert(
    !rolledBackYaml.error && /helm\.sh\/chart: nginx-15\.0\.0/.test(rolledBackYaml.message),
    'cli: helm rollback re-applies the revision 1 chart to the workload',
    rolledBackYaml.message.replace(/\n/g, ' ⏎ ').slice(0, 400),
  );
  const helmListRun = await runCmd(`helm list -n ${helmProject}`);
  const helmListRows = parseTable(helmListRun.message).rows;
  assert(
    helmListRows.length === 1 && helmListRows[0][5] === 'nginx-15.0.0' && helmListRows[0][6] === '1.25.3',
    'cli: helm list CHART/APP VERSION match the deployed revision',
    JSON.stringify(helmListRows),
  );

  // #26: image-pull failures must match failure tokens INSIDE the tag, not only
  // as a prefix (`:v9-nope` earns ImagePullBackOff), and recovering to :latest
  // must pull normally again.
  const pullProject = 'pull-lab';
  const pullImage = 'quay.io/openshift/origin-hello-openshift';
  await expectCmd('cli: create pull-lab project', `oc new-project ${pullProject}`, /Now using project|created/i);
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  const pullDeployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: pullapp
  namespace: ${pullProject}
  labels:
    app: pullapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pullapp
  template:
    metadata:
      labels:
        app: pullapp
    spec:
      containers:
        - name: main
          image: ${pullImage}:latest
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
`;
  await evaluate((text) => window.game.manifestEngine.writeFile('qa/pullapp.yaml', text), pullDeployment);
  await expectCmd('cli: apply pullapp deployment', 'oc apply -f qa/pullapp.yaml', /deployment\.apps\/pullapp created|created|configured/i);
  const readPullLab = () => evaluate(() => {
    const cluster = window.game.cluster;
    const deployment = cluster.getByName?.('Deployment', 'pullapp', 'pull-lab');
    const pods = (cluster.getByKindAndNamespace?.('Pod', 'pull-lab') || []).filter((pod) => pod.metadata?.labels?.app === 'pullapp');
    return {
      availableReplicas: deployment?.status?.availableReplicas ?? 0,
      pods: pods.map((pod) => ({
        phase: pod.status?.phase,
        image: pod.spec?.containers?.[0]?.image || '',
        waiting: (pod.status?.containerStatuses || [])[0]?.state?.waiting?.reason || null,
      })),
    };
  });
  const baselinePulled = await waitFor(async () => {
    const state = await readPullLab();
    return state.availableReplicas >= 1 && state.pods.some((pod) => pod.phase === 'Running' && /:latest$/.test(pod.image));
  }, 30000);
  assert(baselinePulled, 'cli: :latest image pulls and the Deployment becomes available', JSON.stringify(await readPullLab()));
  await expectCmd(
    'cli: oc set image to :v9-nope',
    `oc set image deployment/pullapp main=${pullImage}:v9-nope -n ${pullProject}`,
    /image updated|updated/i,
  );
  await advanceSimulation(20);
  const notPullable = await waitFor(async () => {
    const state = await readPullLab();
    return state.pods.some((pod) => /ImagePullBackOff|ErrImagePull/.test(pod.waiting || '') && /v9-nope/.test(pod.image));
  }, 20000);
  const pullState = await readPullLab();
  assert(
    notPullable,
    'cli: :v9-nope (failure token inside the tag) is ImagePullBackOff',
    JSON.stringify(pullState.pods),
  );
  await expectCmd('cli: oc get pods shows ImagePullBackOff', `oc get pods -n ${pullProject}`, /ImagePullBackOff/);
  await expectCmd(
    'cli: recover pullapp to :latest',
    `oc set image deployment/pullapp main=${pullImage}:latest -n ${pullProject}`,
    /image updated|updated/i,
  );
  await advanceSimulation(30);
  const pullRecovered = await waitFor(async () => {
    const state = await readPullLab();
    return state.pods.some((pod) => pod.phase === 'Running' && /:latest$/.test(pod.image));
  }, 20000);
  assert(pullRecovered, 'cli: :latest pulls again after the image-pull failure (recovery)', JSON.stringify((await readPullLab()).pods));

  await expectCmd('cli: oc create user', 'oc create user bob --full-name="Bob User"', /user.*bob.*created/i);
  await expectCmd('cli: oc create group', 'oc create group devs', /group.*created/i);
  await expectCmd('cli: oc adm groups add-users', 'oc adm groups add-users devs bob', /added|bob/i);
  await expectCmd('cli: oc adm policy add-role-to-user', `oc adm policy add-role-to-user edit bob -n ${project}`, /added|role/i);
  await expectCmd('cli: oc adm policy add-scc-to-user', `oc adm policy add-scc-to-user anyuid -z default -n ${project}`, /added|securitycontextconstraints/i);
  await expectCmd('cli: oc auth can-i', `oc auth can-i create pods -n ${project}`, /yes/i);
  await expectCmd('cli: oc auth can-i --as', `oc auth can-i create pods --as=bob -n ${project}`, /yes/i);
  await expectCmd('cli: oc create quota', `oc create quota demo-quota --hard=pods=20,requests.cpu=4 -n ${project}`, /resourcequota\/demo-quota created/i);
  await expectCmd('cli: oc create limitrange', `oc create limitrange demo-limit --default=cpu=500m,memory=512Mi -n ${project}`, /limitrange\/demo-limit created/i);
  await expectCmd('cli: oc get quota', `oc get quota -n ${project}`, /demo-quota/);
  await expectCmd('cli: oc get limitrange', `oc get limitrange -n ${project}`, /demo-limit/);
  await expectCmd('cli: oc create clusterquota', 'oc create clusterquota team-quota --project-label-selector=team=dev --hard=pods=10', /clusterresourcequota.*created/i);
  await expectCmd('cli: oc get clusterquota', 'oc get clusterquota', /team-quota/);
  await expectCmd('cli: oc get users', 'oc get users', /bob/);
  await expectCmd('cli: oc get groups', 'oc get groups', /devs/);
  await expectCmd('cli: oc get scc', 'oc get scc', /anyuid/);

  await expectCmd('cli: oc create sa', `oc create sa api-sa -n ${project}`, /serviceaccount\/api-sa created/i);
  await expectCmd('cli: oc set serviceaccount', `oc set serviceaccount deployment/web api-sa -n ${project}`, /service account updated|updated/i);
  await expectCmd('cli: add-role-to-user -z', `oc adm policy add-role-to-user view -z api-sa -n ${project}`, /added|view/i);
  await expectCmd('cli: oc auth can-i --as=serviceaccount', `oc auth can-i get pods --as=system:serviceaccount:${project}:api-sa -n ${project}`, /yes/i);

  await expectCmd('cli: oc create route edge', `oc create route edge edge-route --service=web --hostname=edge.example.com -n ${project}`, /route.*exposed|created/i);
  await expectCmd('cli: oc get route edge', `oc get route edge-route -n ${project}`, /edge-route/);
  await expectCmd('cli: oc describe route', `oc describe route web -n ${project}`, /Name:|Admitted|Host/i);
  await expectCmd('cli: oc get route -o yaml', `oc get route web -n ${project} -o yaml`, /apiVersion: route\.openshift\.io\/v1/);

  await expectCmd('cli: oc get all', `oc get all -n ${project}`, /service|deployment/i);
  await expectCmd('cli: oc status', 'oc status', /In project|svc\/|deployment/i);
  await expectCmd('cli: oc projects', 'oc projects', /ex280-demo|default/);
  await expectCmd('cli: oc explain', 'oc explain deployment', /KIND:|Deployment/i);
  await expectCmd('cli: oc api-resources', 'oc api-resources', /buildconfig|route|APIVERSION/i);
  await expectCmd('cli: oc get events', `oc get events -n ${project}`, /LAST SEEN|Normal|Warning|No resources/i);
  await expectCmd('cli: oc adm top nodes', 'oc adm top nodes', /NAME|CPU/i);
  await expectCmd('cli: oc adm top pods', `oc adm top pods -n ${project}`, /NAME|CPU|No resources/i);
  await expectCmd('cli: oc adm must-gather', 'oc adm must-gather', /must-gather|Gathering/i);
  await expectCmd('cli: oc edit opens Files editor', `oc edit deployment/web -n ${project}`, /manifest editor|Files panel|Opening/i);
  await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 5000);
  assert(await evaluate(() => window.game?.manifestPanel?.visible === true), 'cli: oc edit opens the manifest editor');
  await evaluate(() => window.game.manifestPanel?.hide?.());

  // HTPasswd + OAuth + login flow (only if the Manifest/GameEngine APIs exist).
  const authApis = await evaluate(() => ({
    manifest: !!window.game?.manifestEngine,
    login: typeof window.game?.gameEngine?.login === 'function',
    configure: typeof window.game?.gameEngine?.configureHTPasswdProvider === 'function',
  }));
  if (authApis.manifest && authApis.login && authApis.configure) {
    // Before any identity provider is configured: an unknown user must fail like
    // a real authentication attempt (401 wording) and name the configuration gap
    // instead of the old misleading "HTPasswd … not configured" auth error.
    const unknownLogin = await runCmd('oc login -u wrong-user', 150);
    assert(
      unknownLogin.error &&
        /Login failed \(401 Unauthorized\)/.test(unknownLogin.message) &&
        /is not known to the configured identity provider/.test(unknownLogin.message) &&
        !/HTPasswd identity provider is not configured/.test(unknownLogin.message),
      'auth: unknown user is rejected as an auth failure',
      unknownLogin.message.slice(0, 240),
    );
    const whoamiAfterUnknown = await runCmd('oc whoami', 100);
    assert(/^kubeadmin/im.test(whoamiAfterUnknown.message), 'auth: failed login leaves the session unchanged', whoamiAfterUnknown.message.slice(0, 120));
    await expectCmd('auth: admin login works without an IdP', 'oc login -u admin', /Login successful/i);
    await expectCmd('auth: oc whoami admin', 'oc whoami', /^admin/im);
    await expectCmd('auth: login back as kubeadmin', 'oc login -u kubeadmin', /Login successful/i);
    await expectCmd('auth: htpasswd creates alice', 'htpasswd -c htpasswd alice Passw0rd', () => true);
    // #26: htpasswd must print the real messages and honour -c/-b/-D semantics.
    const htpasswdCreate = await runCmd('htpasswd -c -B -b /tmp/h u1 pw');
    assert(
      !htpasswdCreate.error && htpasswdCreate.message.trim() === 'Adding password for user u1',
      'cli: htpasswd -c -B -b prints Adding password for user u1',
      JSON.stringify(htpasswdCreate.message),
    );
    const htpasswdFile = await evaluate(() => window.game.manifestEngine.readFile('/tmp/h'));
    assert(
      typeof htpasswdFile === 'string' && /^u1:\$2y\$/.test(htpasswdFile),
      'cli: htpasswd writes a bcrypt $2y$ entry',
      JSON.stringify(htpasswdFile),
    );
    const htpasswdUpdate = await runCmd('htpasswd -B -b /tmp/h u1 pw2');
    assert(
      !htpasswdUpdate.error && htpasswdUpdate.message.trim() === 'Updating password for user u1',
      'cli: htpasswd updates print Updating password for user u1',
      JSON.stringify(htpasswdUpdate.message),
    );
    const htpasswdAdd = await runCmd('htpasswd -b /tmp/h u2 pw');
    assert(!htpasswdAdd.error && htpasswdAdd.message.trim() === 'Adding password for user u2', 'cli: htpasswd adds a second user', JSON.stringify(htpasswdAdd.message));
    const htpasswdDelete = await runCmd('htpasswd -D /tmp/h u2');
    assert(
      !htpasswdDelete.error && htpasswdDelete.message.trim() === 'Deleting password for user u2',
      'cli: htpasswd -D prints Deleting password for user u2',
      JSON.stringify(htpasswdDelete.message),
    );
    const htpasswdMissing = await runCmd('htpasswd -D /tmp/h u2');
    assert(
      !htpasswdMissing.error && htpasswdMissing.message.trim() === 'User u2 not found',
      'cli: htpasswd -D on a missing user prints User u2 not found',
      JSON.stringify(htpasswdMissing.message),
    );
    const htpasswdNoCreate = await runCmd('htpasswd -b /tmp/does-not-exist u3 pw');
    assert(
      htpasswdNoCreate.error && /cannot modify file \/tmp\/does-not-exist; use '-c' to create it/.test(htpasswdNoCreate.message),
      "cli: htpasswd without -c on a missing file errors like real htpasswd",
      htpasswdNoCreate.message,
    );
    await expectCmd('auth: create htpasswd secret', 'oc create secret generic htpasswd-secret --from-file=htpasswd -n openshift-config', /secret\/htpasswd-secret created|configured/i);
    const oauth = await evaluate(() => window.game.gameEngine.configureHTPasswdProvider({ secretName: 'htpasswd-secret' }));
    assert(oauth?.success === true, 'auth: OAuth HTPasswd provider configured', JSON.stringify(oauth));
    const authReady = await waitFor(() => evaluate(() => window.game?.gameEngine?.authProvider?.ready === true), 20000);
    assert(authReady, 'auth: HTPasswd provider becomes ready');
    await expectCmd('auth: oc login as alice', 'oc login -u alice -p Passw0rd', /logged in|Login successful/i, { wait: 300 });
    await expectCmd('auth: oc whoami alice', 'oc whoami', /^alice/im);
    await expectCmdError('auth: wrong password rejected', 'oc login -u alice -p wrong-password', /Login failed|401|incorrect/i);
    const whoamiAfterWrongPassword = await runCmd('oc whoami', 100);
    assert(/^alice/im.test(whoamiAfterWrongPassword.message), 'auth: wrong password leaves the session unchanged', whoamiAfterWrongPassword.message.slice(0, 120));
    const authState = await evaluate(() => ({
      currentUser: window.game?.gameEngine?.currentUser,
      user: !!window.game?.cluster?.getUser?.('alice'),
      identity: (window.game?.cluster?.getByKind?.('Identity') || []).some((i) => /alice/.test(i.metadata?.name || '')),
    }));
    assert(authState.user, 'auth: User alice exists after login');
    assert(authState.identity, 'auth: Identity alice auto-created');
    await expectCmd('auth: logout', 'oc logout', /logged .* out|logged out/i);
    await expectCmd('auth: login back as kubeadmin', 'oc login -u kubeadmin', /logged in|Login successful/i);
  } else {
    warn('auth: HTPasswd/login flow skipped', 'ManifestEngine or auth APIs unavailable');
  }

  // BuildConfig → Build → ImageStream semantics (the example applies into the current project).
  await expectCmd('cli: apply BuildConfig', 'oc apply -f examples/buildconfig.yaml', /created|configured|unchanged/i);
  // The ConfigChange trigger auto-starts the first build; wait for it before testing oc start-build
  // (a second start while a Serial build is running would be rejected, as on a real cluster).
  await waitFor(async () => evaluate(() => {
    const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
    return builds.length > 0 && builds.every((b) => ['Complete', 'Failed'].includes(b.status?.phase || b.phase));
  }), 45000);
  await expectCmd('cli: oc start-build', `oc start-build webapp -n ${project}`, /started|build/i, { wait: 700 });
  const buildReached = await waitFor(async () => {
    return evaluate(() => {
      const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
      return builds.some((b) => ['Complete', 'Failed'].includes(b.status?.phase || b.phase));
    });
  }, 30000);
  let buildState = await evaluate(() => {
    const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
    return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
  });
  if (!buildReached || !buildState.some((b) => b.phase === 'Complete')) {
    // The simulator has a small random build-failure rate; retry once before failing.
    await expectCmd('cli: oc start-build retry', `oc start-build webapp -n ${project}`, /started|build/i, { wait: 700 });
    await waitFor(async () => {
      return evaluate(() => {
        const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
        return builds.some((b) => (b.status?.phase || b.phase) === 'Complete');
      });
    }, 30000);
    buildState = await evaluate(() => {
      const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
      return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
    });
  }
  assert(buildState.some((b) => b.phase === 'Complete'), 'cli: Build reaches phase Complete', JSON.stringify(buildState));
  await expectCmd('cli: oc get builds', `oc get builds -n ${project}`, /NAME|webapp|Complete/i);
  const imageStream = await findResource('ImageStream', 'webapp', project);
  assert(!!imageStream, 'cli: Build output ImageStream exists');
  if (imageStream) {
    const tags = await evaluate(() => {
      const is = (window.game.cluster.getByKind?.('ImageStream') || []).find((r) => r.metadata?.name === 'webapp' && r.metadata?.namespace === 'ex280-demo');
      return (is?.status?.tags || []).map((t) => t.tag || t.name);
    });
    assert(tags.length > 0, 'cli: ImageStream has an imported tag', JSON.stringify(tags));
  }

  // Subscription semantics.
  await expectCmd('cli: oc apply subscription', 'oc apply -f examples/subscription.yaml', /created|configured|unchanged/i);
  const subReady = await waitFor(async () => {
    return evaluate(() => {
      window.game?.gameEngine?.resume?.();
      const subs = window.game.cluster.getByKind?.('Subscription') || [];
      const sub = subs.find((s) => s.metadata.name === 'ansible-automation-platform-operator');
      return !!sub && ['Succeeded', 'Failed'].includes(sub.status?.phase || sub.phase);
    });
  }, 45000);
  const subscription = await findResource('Subscription', 'ansible-automation-platform-operator', 'openshift-operators');
  const subPhase = subscription?.status?.phase || subscription?.phase;
  assert(subReady && subPhase === 'Succeeded', 'cli: Subscription reaches phase Succeeded', JSON.stringify(subPhase));
  await expectCmd('cli: oc get subs', 'oc get subs -n openshift-operators', /ansible-automation-platform-operator/i);
  await expectCmd('cli: oc get csv', 'oc get csv -n openshift-operators', /ansible-automation-platform-operator|NAME/i);
  await expectCmd('cli: oc delete subscription', 'oc delete subscription ansible-automation-platform-operator -n openshift-operators', /deleted/i);

  // #26: OLM resolves per namespace/OperatorGroup. An unresolvable package makes
  // EVERY Subscription in that namespace report ResolutionFailed, with no
  // CSV/InstallPlan; a namespace with only a resolvable Subscription installs.
  const writeOperatorGroup = (namespace) => evaluate(({ ns }) => window.game.manifestEngine.writeFile(`qa/og-${ns}.yaml`, `apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: ${ns}-og
  namespace: ${ns}
spec:
  targetNamespaces:
    - ${ns}
`), { ns: namespace });
  const writeSubscriptionFile = (namespace, name, pkg) => evaluate(({ ns, subName, packageName }) => window.game.manifestEngine.writeFile(`qa/sub-${ns}-${subName}.yaml`, `apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ${subName}
  namespace: ${ns}
spec:
  channel: stable
  name: ${packageName}
  source: redhat-operators
  sourceNamespace: openshift-marketplace
`), { ns: namespace, subName: name, packageName: pkg });
  const readOlmNamespace = (namespace) => evaluate((ns) => {
    const cluster = window.game.cluster;
    const subs = cluster.getByKindAndNamespace?.('Subscription', ns) || [];
    return {
      subs: subs.map((sub) => ({
        name: sub.metadata.name,
        phase: sub.status?.phase,
        reason: sub.status?.reason,
        conditions: (sub.status?.conditions || []).map((condition) => `${condition.type}=${condition.status}/${condition.reason}`),
      })),
      csvs: (cluster.getByKindAndNamespace?.('ClusterServiceVersion', ns) || []).map((csv) => `${csv.metadata.name}:${csv.status?.phase}`),
      installPlans: (cluster.getByKindAndNamespace?.('InstallPlan', ns) || []).map((plan) => plan.metadata.name),
    };
  }, namespace);
  const olmBrokenProject = 'olm-lab';
  await expectCmd('cli: create olm-lab project', `oc new-project ${olmBrokenProject}`, /Now using project|created/i);
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  await writeOperatorGroup(olmBrokenProject);
  await writeSubscriptionFile(olmBrokenProject, 'healthy-sub', 'metallb-operator');
  await writeSubscriptionFile(olmBrokenProject, 'bogus-sub', 'bogus-operator');
  // Apply the OperatorGroup and BOTH Subscriptions in one synchronous pass so the
  // namespace is resolved as a unit (like a user applying the manifests together):
  // the unresolvable package means nothing is installed in the namespace.
  const olmBrokenApply = await evaluate((ns) => {
    const bar = window.game.app.commandBar;
    const outputs = [
      bar.executeCommand(`oc apply -f qa/og-${ns}.yaml`),
      bar.executeCommand(`oc apply -f qa/sub-${ns}-healthy-sub.yaml`),
      bar.executeCommand(`oc apply -f qa/sub-${ns}-bogus-sub.yaml`),
    ];
    return { errors: outputs.filter((output) => output?.error).length, messages: outputs.map((output) => String(output?.message || '').split('\n')[0]) };
  }, olmBrokenProject);
  assert(olmBrokenApply.errors === 0, 'cli: olm-lab OperatorGroup + a healthy and an unknown-package Subscription applied', JSON.stringify(olmBrokenApply.messages));
  // Let OLM resolve the namespace; the failure then applies to both Subscriptions
  // and the namespace installs nothing (no phantom CSV/InstallPlan).
  await advanceSimulation(30);
  const olmNamespaceBroken = await waitFor(async () => {
    const state = await readOlmNamespace(olmBrokenProject);
    return state.subs.length === 2
      && state.subs.every((sub) => sub.conditions.some((line) => /ResolutionFailed=True\//.test(line)))
      && state.csvs.length === 0
      && state.installPlans.length === 0;
  }, 30000);
  const olmBrokenState = await readOlmNamespace(olmBrokenProject);
  assert(
    olmNamespaceBroken,
    'cli: both Subscriptions in a namespace report ResolutionFailed ConstraintsNotSatisfiable',
    JSON.stringify(olmBrokenState),
  );
  assert(
    olmBrokenState.subs.every((sub) => /ConstraintsNotSatisfiable/.test(sub.conditions.join(' '))),
    'cli: ResolutionFailed reason is ConstraintsNotSatisfiable for every Subscription',
    JSON.stringify(olmBrokenState.subs.map((sub) => sub.reason)),
  );
  assert(
    olmBrokenState.csvs.length === 0 && olmBrokenState.installPlans.length === 0,
    'cli: an unresolvable namespace creates no CSV/InstallPlan',
    JSON.stringify({ csvs: olmBrokenState.csvs, installPlans: olmBrokenState.installPlans }),
  );
  await expectCmd(
    'cli: oc describe subscription shows the namespace resolution failure',
    `oc describe subscription healthy-sub -n ${olmBrokenProject}`,
    /ResolutionFailed/,
  );
  const olmHealthyProject = 'olm-ok';
  await expectCmd('cli: create olm-ok project', `oc new-project ${olmHealthyProject}`, /Now using project|created/i);
  await expectCmd('cli: switch back to the demo project', `oc project ${project}`, /Now using project/i);
  await writeOperatorGroup(olmHealthyProject);
  await expectCmd('cli: apply olm-ok OperatorGroup', `oc apply -f qa/og-${olmHealthyProject}.yaml`, /operatorgroup.*created|created|configured/i);
  await writeSubscriptionFile(olmHealthyProject, 'metallb-operator', 'metallb-operator');
  await expectCmd(
    'cli: healthy single-Subscription namespace created',
    `oc apply -f qa/sub-${olmHealthyProject}-metallb-operator.yaml`,
    /subscription.*created|created|configured/i,
  );
  await advanceSimulation(60);
  const olmHealthy = await waitFor(async () => {
    const state = await readOlmNamespace(olmHealthyProject);
    return state.subs.length === 1
      && /Succeeded/.test(state.subs[0].phase || '')
      && state.csvs.some((row) => /metallb-operator.*:Succeeded/.test(row));
  }, 30000);
  const olmHealthyState = await readOlmNamespace(olmHealthyProject);
  assert(olmHealthy, 'cli: a healthy single-Subscription namespace still reaches CSV Succeeded', JSON.stringify(olmHealthyState));
  assert(
    olmHealthyState.subs.every((sub) => !sub.conditions.some((line) => /ResolutionFailed=True/.test(line))),
    'cli: healthy Subscription has no ResolutionFailed condition',
    JSON.stringify(olmHealthyState.subs),
  );

  await expectCmd('cli: oc create job', `oc create job hello --image=busybox -- echo hi -n ${project}`, /job\.batch\/hello created/i);
  await expectCmd('cli: oc create cronjob', `oc create cronjob hello-cron --image=busybox --schedule="*/1 * * * *" -n ${project}`, /cronjob\.batch\/hello-cron created/i);
  await expectCmd('cli: oc get jobs', `oc get jobs -n ${project}`, /hello/);
  await expectCmd('cli: oc get cronjobs', `oc get cronjobs -n ${project}`, /hello-cron/);
  const nodeName = await evaluate(() => window.game.cluster.getByKind?.('Node')?.[0]?.metadata?.name || 'sandbox-node-1');
  await expectCmd('cli: oc adm cordon', `oc adm cordon ${nodeName}`, /cordoned|node/i);
  await expectCmd('cli: oc adm uncordon', `oc adm uncordon ${nodeName}`, /uncordoned|node/i);

  // Semantic assertions on the mutated model.
  const deployment = await findResource('Deployment', 'web', project);
  assert(deployment && deployment.spec?.template?.spec?.containers?.[0]?.image === 'quay.io/openshift/origin-hello-openshift:v1.1', 'cli: oc set image persists in Deployment spec', JSON.stringify(deployment?.spec?.template?.spec?.containers?.[0]?.image));
  const env = deployment?.spec?.template?.spec?.containers?.[0]?.env || [];
  assert(env.some((e) => e.name === 'APP_ENV' && e.value === 'dev'), 'cli: oc set env persists in Deployment spec');
  const resources = deployment?.spec?.template?.spec?.containers?.[0]?.resources;
  assert(resources?.limits?.cpu === '500m' && resources?.requests?.cpu === '100m', 'cli: oc set resources persists in Deployment spec', JSON.stringify(resources));
  const cm = await findResource('ConfigMap', 'app-config', project);
  const secret = await findResource('Secret', 'app-secret', project);
  assert(!!cm, 'cli: ConfigMap app-config exists');
  assert(!!secret, 'cli: Secret app-secret exists');
  const user = await findResource('User', 'bob');
  const group = await findResource('Group', 'devs');
  assert(!!user, 'cli: User bob exists');
  assert(!!group, 'cli: Group devs exists');
  // OCP 4.x grants `use securitycontextconstraints/<name>` through a
  // (Cluster)RoleBinding to ClusterRole `system:openshift:scc:<name>`; the SCC
  // object's own users/groups lists are legacy 3.x data and stay untouched.
  // Accept the cluster helper when available, the binding form, or (for
  // backwards compatibility) the legacy users list.
  const sccGrant = await evaluate(({ project: ns }) => {
    const cluster = window.game?.cluster;
    const saUser = `system:serviceaccount:${ns}:default`;
    try {
      if (typeof cluster?.getSCCGrantSubjects === 'function') {
        const subjects = cluster.getSCCGrantSubjects('anyuid') || [];
        if (subjects.includes(saUser)) return { granted: true, via: 'helper', subjects };
      }
      const bindings = [
        ...(cluster?.getByKind?.('ClusterRoleBinding') || []),
        ...(cluster?.getByKind?.('RoleBinding') || []),
      ];
      for (const binding of bindings) {
        const roleRef = binding.spec?.roleRef || {};
        if (roleRef.name !== 'system:openshift:scc:anyuid') continue;
        if (binding.kind === 'RoleBinding' && (binding.metadata?.namespace || '') !== ns) continue;
        const subjectOk = (binding.spec?.subjects || []).some(
          (subject) => subject.kind === 'ServiceAccount'
            && subject.name === 'default'
            && (subject.namespace || binding.metadata?.namespace || ns) === ns,
        );
        if (subjectOk) return { granted: true, via: 'binding', binding: binding.metadata?.name };
      }
      const scc = (cluster?.getByKind?.('SecurityContextConstraints') || [])
        .find((entry) => entry.metadata?.name === 'anyuid');
      const legacyUsers = scc?.spec?.users || [];
      return { granted: legacyUsers.includes(saUser), via: 'legacy', subjects: legacyUsers };
    } catch (err) {
      return { granted: false, via: 'error', error: String(err?.message || err) };
    }
  }, { project });
  assert(sccGrant.granted, 'cli: add-scc-to-user grants anyuid', JSON.stringify(sccGrant));
  const quota = await findResource('ResourceQuota', 'demo-quota', project);
  const limitRange = await findResource('LimitRange', 'demo-limit', project);
  assert(!!quota, 'cli: ResourceQuota demo-quota exists');
  assert(!!limitRange, 'cli: LimitRange demo-limit exists');
  const crq = await findResource('ClusterResourceQuota', 'team-quota');
  assert(!!crq, 'cli: ClusterResourceQuota team-quota exists');
  const buildFinal = await evaluate(() => {
    const builds = (window.game.cluster.getByKind?.('Build') || []).filter((b) => (b.metadata?.namespace || '') === 'ex280-demo');
    return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
  });
  const buildEverComplete = (buildState || []).some((b) => b.phase === 'Complete')
    || buildFinal.some((b) => b.phase === 'Complete');
  assert(buildEverComplete, 'cli: at least one Build is Complete', JSON.stringify(buildFinal.length ? buildFinal : buildState));
  const subs = await findResource('Subscription', 'ansible-automation-platform-operator', 'openshift-operators');
  assert(!subs, 'cli: deleting the Subscription removes it');
  await evaluate(() => window.game?.gameEngine?.setTimeScale?.(1));
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. UI SURFACES: INSPECTOR / CONTEXT MENU / METRICS / SETTINGS / KEYS
// ═══════════════════════════════════════════════════════════════════════════
await runSection('ui', async () => {
  if (!(await evaluate(() => window.game?.app?.currentMode === 'sandbox'))) await bootSandbox();
  let service = await findResource('Service', 'web', 'ex280-demo');
  let route = await findResource('Route', 'web', 'ex280-demo');
  if (!service || !route) {
    await runCmd('oc new-project ex280-demo', 200);
    await runCmd('oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ex280-demo', 200);
    await runCmd('oc expose svc/web -n ex280-demo', 200);
    await runCmd('oc apply -f examples/buildconfig.yaml', 200);
    await sleep(1500);
    service = await findResource('Service', 'web', 'ex280-demo');
    route = await findResource('Route', 'web', 'ex280-demo');
  }
  let buildConfig = await findResource('BuildConfig', 'webapp', 'ex280-demo');
  if (!buildConfig) {
    await runCmd('oc apply -f examples/buildconfig.yaml', 200);
    buildConfig = await findResource('BuildConfig', 'webapp', 'ex280-demo');
  }
  const target = route || service;
  assert(!!target, 'ui: route/service available for inspector');

  if (target) {
    await evaluate((uid) => window.game.engine.emit('resource:selected', { uid }), target.uid);
    await sleep(500);
    const inspector = await evaluate(() => ({
      visible: window.game?.app?.inspector?.visible === true,
      name: document.getElementById('inspector-name')?.textContent?.trim() || '',
      tabs: document.querySelectorAll('#inspector-tabs [data-tab]').length,
    }));
    assert(inspector.visible, 'ui: inspector opens on resource select');
    assert(inspector.name === 'web', 'ui: inspector shows selected resource name', inspector.name);
    assert(inspector.tabs === 4, 'ui: inspector has 4 tabs', `got ${inspector.tabs}`);
    await evaluate(() => document.querySelector('#inspector-tabs [data-tab="yaml"]')?.click());
    await sleep(250);
    const inspectorYaml = await evaluate(() => document.getElementById('inspector-body')?.innerText || '');
    assert(/apiVersion/.test(inspectorYaml), 'ui: inspector YAML tab renders apiVersion', inspectorYaml.slice(0, 160));
    await evaluate(() => document.querySelector('#inspector-tabs [data-tab="describe"]')?.click());
    await sleep(250);
    const inspectorDescribe = await evaluate(() => document.getElementById('inspector-body')?.innerText || '');
    assert(/Name:|Namespace:|Status:|Host|Route/.test(inspectorDescribe), 'ui: inspector Describe tab renders', inspectorDescribe.slice(0, 160));
    await evaluate(() => window.game.app.inspector.hide());
  }

  if (service) {
    await evaluate((uid) => window.game.engine.emit('resource:contextmenu', { uid, x: 600, y: 400 }), service.uid);
    await sleep(350);
    const ctx = await evaluate(() => ({
      visible: window.game?.app?.contextMenu?.visible === true,
      text: document.getElementById('context-menu')?.innerText || '',
      hasExpose: !!document.querySelector('[data-testid="context-menu-expose"]'),
      hasEdit: !!document.querySelector('[data-testid="context-menu-edit-yaml"]'),
      hasDelete: !!document.querySelector('[data-testid="context-menu-delete"]'),
    }));
    assert(ctx.visible && ctx.hasExpose && ctx.hasEdit && ctx.hasDelete, 'ui: context menu exposes OpenShift actions', JSON.stringify(ctx));
    assert(/Expose Service.*Route/i.test(ctx.text), 'ui: context menu uses Expose Service → Route wording');
    await evaluate(() => window.game.app.contextMenu.hide());
  }
  if (buildConfig) {
    await evaluate((uid) => window.game.engine.emit('resource:contextmenu', { uid, x: 600, y: 400 }), buildConfig.uid);
    await sleep(300);
    const buildCtx = await evaluate(() => ({
      visible: window.game?.app?.contextMenu?.visible === true,
      hasStartBuild: !!document.querySelector('[data-testid="context-menu-start-build"]'),
      text: document.getElementById('context-menu')?.innerText || '',
    }));
    assert(buildCtx.visible && buildCtx.hasStartBuild, 'ui: BuildConfig context menu offers Start Build', buildCtx.text.slice(0, 200));
    await evaluate(() => window.game.app.contextMenu.hide());
  }

  await evaluate(() => window.game.app.metrics.show());
  await sleep(400);
  const metrics = await evaluate(() => ({
    visible: window.game?.app?.metrics?.visible === true,
    canvases: document.querySelectorAll('#metrics-dashboard canvas').length,
  }));
  assert(metrics.visible && metrics.canvases >= 4, 'ui: metrics dashboard opens with 4 charts', JSON.stringify(metrics));
  await evaluate(() => window.game.app.metrics.hide());

  await evaluate(() => window.game.app.hud.settingsPanel.show());
  await sleep(350);
  const settings = await evaluate(() => ({
    visible: window.game?.app?.hud?.settingsPanel?.visible === true,
    panel: !!document.getElementById('ingame-settings-panel'),
    testId: !!document.querySelector('[data-testid="settings-panel"]'),
    controls: document.querySelectorAll('#ingame-settings-panel [data-action], #ingame-settings-panel [data-testid]').length,
  }));
  assert(settings.visible && settings.panel && settings.testId, 'ui: in-game settings opens');
  assert(settings.controls >= 5, 'ui: settings has controls', `got ${settings.controls}`);
  await evaluate(() => window.game.app.hud.settingsPanel.hide());

  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('/');
  await sleep(350);
  assert(await evaluate(() => window.game?.app?.commandBar?.visible === true), 'ui: "/" opens the oc terminal');
  await page.keyboard.press('Escape');
  await sleep(250);
  assert(await evaluate(() => window.game?.app?.commandBar?.visible === false), 'ui: Esc closes the oc terminal');
  // Both the CommandBar and the shell listen for Escape; depending on listener
  // order the shell may also return to the menu. Re-enter Sandbox so the M and
  // Space shortcut assertions always run against a live game session.
  if (await evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === false)) {
    await bootSandbox();
  }
  await evaluate(() => document.activeElement?.blur?.());

  await page.keyboard.press('m');
  await sleep(350);
  assert(await evaluate(() => window.game?.app?.metrics?.visible === true), 'ui: M opens metrics');
  await page.keyboard.press('m');
  await sleep(200);
  await evaluate(() => document.activeElement?.blur?.());

  await page.keyboard.press('Space');
  await sleep(300);
  assert(await evaluate(() => window.game?.gameEngine?.state === 'paused'), 'ui: Space pauses the simulation');
  await page.keyboard.press('Space');
  await sleep(300);
  assert(await evaluate(() => window.game?.gameEngine?.state === 'running'), 'ui: Space resumes the simulation');
  await evaluate(() => document.activeElement?.blur?.());

  // gamefeel: Esc now opens the pause overlay (never discards the run).
  // Clear any overlay a previous assertion may have left half-open (Esc semantics
  // are "close topmost first"), then poll for the pause card under software WebGL.
  await closeOverlays();
  // Eliminate the race: a modal that is still finishing its close can swallow the
  // first Escape. Wait until nothing modal is open before pressing.
  const anyModalOpen = () => evaluate(() => {
    const active = (id) => document.getElementById(id)?.classList.contains('active') === true;
    return Boolean(
      document.getElementById('tutorial-overlay')
        || active('pause-overlay')
        || active('settings-panel')
        || active('achievements-panel')
        || active('stats-panel')
        || active('modal-level-complete')
        || active('modal-game-over')
        || window.game?.examPrepUI?.visible === true
        || window.game?.manifestPanel?.visible === true
        || window.game?.app?.inspector?.visible === true
        || window.game?.app?.contextMenu?.visible === true
        || window.game?.app?.metrics?.visible === true
        || window.game?.app?.hud?.settingsPanel?.visible === true,
    );
  });
  const pauseOverlayActive = () => evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === true);
  await waitFor(async () => !(await anyModalOpen()), 3000, 100);
  await evaluate(() => document.activeElement?.blur?.());
  await sleep(250);
  await page.keyboard.press('Escape');
  let pauseOpened = await waitFor(() => pauseOverlayActive(), 1500);
  if (!pauseOpened) {
    // Under load a slow repaint can lose the first bounded wait; allow exactly one
    // retry, and only when the first Escape did not open the card AND nothing is
    // open any more (a lingering overlay consumed it). Escape must never discard
    // the run — if it did, the card would not open and the main menu would show.
    if (await pauseOverlayActive()) pauseOpened = true;
    else if (!(await anyModalOpen())) {
      await page.keyboard.press('Escape');
      pauseOpened = await waitFor(() => pauseOverlayActive(), 6000);
    }
  }
  assert(pauseOpened, 'ui: Esc opens the pause overlay instead of discarding the run');
  const runNotDiscarded = await waitFor(
    () => evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === true),
    4000,
  );
  assert(runNotDiscarded, 'ui: Esc pause keeps the run (main menu stays hidden)');
  await evaluate(() => document.getElementById('pause-resume')?.click());
  await waitFor(() => evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === false), 4000);
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === false),
    'ui: pause Resume returns to the run',
  );

  // Regression: Esc while the help modal is open closes help first (and resumes
  // the sim) instead of opening the pause card behind it. Blur first: a hidden
  // resume button must not keep focus (the H shortcut targets the page body).
  await evaluate(() => document.activeElement?.blur?.());
  await sleep(250);
  await page.keyboard.press('h');
  const helpOpenAgain = await waitFor(() => evaluate(() => !!document.getElementById('tutorial-overlay')), 6000);
  assert(helpOpenAgain, 'ui: H opens help from a live sandbox');
  const helpPaused = await waitFor(() => evaluate(() => window.game.gameEngine.state === 'paused'), 4000);
  assert(helpPaused, 'ui: help modal pauses the sandbox simulation');
  await page.keyboard.press('Escape');
  const helpClosedByEsc = await waitFor(() => evaluate(() => !document.getElementById('tutorial-overlay')), 5000);
  assert(helpClosedByEsc, 'ui: Esc closes the help modal');
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') !== true),
    'ui: help-dismissing Esc does not open the pause overlay',
  );
  assert(await evaluate(() => window.game.gameEngine.state === 'running'), 'ui: closing help resumes the sandbox simulation');

  // Regression: EX280 Prep is a full-screen surface — it pauses the sim while
  // open and a single Esc closes it and resumes without double-resuming.
  const prepOpened = await openExamPrep();
  assert(prepOpened, 'ui: EX280 Prep opens from a live sandbox');
  assert(await evaluate(() => window.game.gameEngine.state === 'paused'), 'ui: EX280 Prep pauses the simulation');
  await page.keyboard.press('Escape');
  const prepClosed = await waitFor(() => evaluate(() => window.game.examPrepUI?.visible === false), 5000);
  assert(prepClosed, 'ui: Esc closes EX280 Prep');
  await sleep(300);
  assert(await evaluate(() => window.game.gameEngine.state === 'running'), 'ui: closing EX280 Prep resumes the simulation');
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CAMPAIGN LEVELS 1-20 + LEVEL 1 OBJECTIVE COMPLETION
// ═══════════════════════════════════════════════════════════════════════════
const REQUIRED_LEVEL_TITLES = [
  'Your First Project', 'Query, Format, Filter', 'Logs, Events & Health', 'Declarative Manifests',
  'Kustomize Base', 'Kustomize Overlays', 'Secrets & ConfigMaps', 'Templates & Helm',
  'Images, Builds & Image Streams', 'Rolling Updates & Rollbacks', 'Services & Routes',
  'Non-HTTP & Load Balancer', 'HTPasswd & Users', 'Groups & RBAC',
  'Quotas, LimitRanges & Templates', 'Service Accounts & API Access', 'SCC & Privileged Apps',
  'Operators', 'Jobs & CronJobs', 'EX280 Final: Production Platform',
];
await runSection('campaign', async () => {
  await bootCampaign(1);
  await closeOverlays();
  const first = await evaluate(() => {
    const mode = window.game.app.modeInstance;
    const panel = document.getElementById('objectives-panel');
    return {
      level: mode?.currentLevel,
      title: mode?.currentLevelDef?.title,
      objectives: mode?.objectiveProgress?.length || 0,
      panelDisplay: panel ? getComputedStyle(panel).display : 'none',
      panelRows: document.querySelectorAll('#obj-list > *').length,
      hasStatus: typeof mode?.getStatus === 'function',
      statusObjectives: mode?.getStatus?.()?.objectives?.length || 0,
    };
  });
  assert(first.level === 1 && first.title === 'Your First Project', 'campaign: level 1 starts', JSON.stringify(first));
  assert(first.objectives >= 2, 'campaign: level 1 objectives populated', `got ${first.objectives}`);
  assert(first.hasStatus && first.statusObjectives >= 2, 'campaign: level 1 getStatus() works');
  assert(first.panelDisplay !== 'none' && first.panelRows >= 2, 'campaign: objectives panel visible/populated', JSON.stringify(first));
  await evaluate(() => document.getElementById('coach-skip')?.click());
  await sleep(350);
  const levelShot = await shot('campaign-level-1.png');
  if (levelShot) shotsTaken.push(levelShot);

  // Regression: Files & Manifests freezes the campaign clock while open and
  // resumes it when Esc closes the panel (without opening the pause card).
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesForClock = await waitFor(() => evaluate(() => window.game?.app?.manifestPanel?.visible === true), 8000);
  assert(filesForClock, 'campaign: Files panel opens from F');
  await sleep(400);
  const filesClockOpen = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(await evaluate(() => window.game.gameEngine.state === 'paused'), 'campaign: Files panel pauses the simulation');
  await sleep(2000);
  const filesClockHeld = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(filesClockHeld === filesClockOpen, 'campaign: campaign clock frozen while Files is open', `${filesClockOpen} -> ${filesClockHeld}`);
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const filesClockClosed = await waitFor(() => evaluate(() => window.game?.app?.manifestPanel?.visible === false), 5000);
  assert(filesClockClosed, 'campaign: Esc closes the Files panel');
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') !== true),
    'campaign: closing Files does not open the pause overlay',
  );
  assert(await evaluate(() => window.game.gameEngine.state === 'running'), 'campaign: closing Files resumes the simulation');
  await sleep(1300);
  const filesClockRunning = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(filesClockRunning > filesClockHeld, 'campaign: campaign clock runs again after Files closes', `${filesClockHeld} -> ${filesClockRunning}`);

  await expectCmd('campaign L1: oc login', 'oc login -u kubeadmin', /logged in|Login successful|kubeadmin/i);
  await expectCmd('campaign L1: create project', 'oc new-project first-project', /Now using project/i);
  // L1 uses the supported non-root image: nginx:latest is ADMITTED under
  // restricted-v2 but then crash-loops on /var/cache/nginx (permission denied) —
  // see the nginx runtime regression in the CLI section.
  await expectCmd('campaign L1: run Pod', 'oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest -n first-project', /pod.*created/i);
  await expectCmd('campaign L1: create Deployment', 'oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest -n first-project', /deployment.*created/i);
  const completed = await waitFor(() => evaluate(() => {
    const status = window.game?.app?.modeInstance?.getStatus?.();
    return status?.state === 'completed' || (status?.objectives?.length && status.objectives.every((o) => o.completed));
  }), 12000);
  const levelStatus = await evaluate(() => {
    const status = window.game.app.modeInstance?.getStatus?.();
    return {
      state: status?.state,
      objectives: (status?.objectives || []).map((o) => ({ type: o.type, label: o.label, completed: o.completed, current: o.current, target: o.target })),
      percentage: status?.completionPercentage,
    };
  });
  assert(completed && levelStatus.objectives.length >= 2 && levelStatus.objectives.every((o) => o.completed), 'campaign: level 1 objectives flip to complete', JSON.stringify(levelStatus));
  await closeOverlays();

  for (let id = 1; id <= 20; id += 1) {
    if (id !== 1) {
      const ok = await launch('campaign', id);
      assert(ok, `campaign: level ${id} starts`);
    }
    await sleep(350);
    const info = await evaluate(() => {
      const app = window.game.app;
      const mode = app.modeInstance;
      const panel = document.getElementById('objectives-panel');
      const status = mode?.getStatus?.();
      return {
        level: mode?.currentLevel,
        title: mode?.currentLevelDef?.title,
        objectives: (mode?.objectiveProgress || []).length,
        panelDisplay: panel ? getComputedStyle(panel).display : 'none',
        panelRows: document.querySelectorAll('#obj-list > *').length,
        statusObjectives: (status?.objectives || []).length,
        hasStatus: typeof mode?.getStatus === 'function',
      };
    });
    assert(info.level === id, `campaign: level ${id} currentLevel`, JSON.stringify(info));
    assert(info.title === REQUIRED_LEVEL_TITLES[id - 1], `campaign: level ${id} title`, info.title);
    assert(info.objectives >= 2, `campaign: level ${id} objectives populated`, `got ${info.objectives}`);
    assert(info.hasStatus && info.statusObjectives >= 2, `campaign: level ${id} getStatus works`);
    assert(info.panelDisplay !== 'none' && info.panelRows >= 2, `campaign: level ${id} objectives panel populated`, JSON.stringify(info));
    await closeOverlays();
  }
  // #22 non-regression for campaign gates: the uptime/clusterHealth activation
  // baselines must stay meaningful. L3's clusterHealth objective must not
  // complete before its triggerTime incident, must stay incomplete while it is
  // active, and must complete after the incident is resolved. L20's resolve
  // objectives must stay incomplete until both scheduled incidents resolve.
  const campaignGateStatus = () => evaluate(() => {
    const mode = window.game.app.modeInstance;
    const engine = window.game.incidentEngine;
    return {
      state: mode.state,
      objectives: mode.objectiveProgress.map((objective) => ({
        type: objective.type,
        label: objective.label,
        completed: objective.completed,
        current: objective.current,
        target: objective.target,
      })),
      health: engine.getClusterHealth(),
      activeIncidents: engine.getActiveIncidents().length,
      activationCount: engine.activationCount,
    };
  });
  const objectiveOfType = (status, type) => status.objectives.find((objective) => objective.type === type);
  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  assert(await launch('campaign', 3), 'campaign gates: level 3 starts');
  await closeOverlays();
  const l3Start = await campaignGateStatus();
  assert(objectiveOfType(l3Start, 'clusterHealth') !== undefined, 'campaign gates: level 3 has a clusterHealth objective');
  assert(
    objectiveOfType(l3Start, 'clusterHealth')?.completed === false,
    'campaign gates: L3 clusterHealth is incomplete before the incident fires',
    JSON.stringify({ health: l3Start.health, active: l3Start.activeIncidents }),
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(6));
  const l3IncidentFired = await waitFor(
    () => evaluate(() => window.game.incidentEngine.activationCount >= 1 && window.game.incidentEngine.getActiveIncidents().length >= 1),
    40000,
  );
  assert(l3IncidentFired, 'campaign gates: L3 triggerTime incident fires');
  const l3Active = await campaignGateStatus();
  assert(
    objectiveOfType(l3Active, 'clusterHealth')?.completed === false && l3Active.activeIncidents >= 1,
    'campaign gates: L3 clusterHealth stays incomplete while the incident is active',
    JSON.stringify({ completed: objectiveOfType(l3Active, 'clusterHealth')?.completed, active: l3Active.activeIncidents }),
  );
  await evaluate(() => {
    const engine = window.game.incidentEngine;
    for (const incident of engine.getActiveIncidents()) engine.resolveIncident(incident.id, 'qa-gate');
  });
  const l3Restored = await waitFor(
    async () => objectiveOfType(await campaignGateStatus(), 'clusterHealth')?.completed === true,
    30000,
  );
  const l3After = await campaignGateStatus();
  assert(l3Restored, 'campaign gates: L3 clusterHealth completes after the incident is resolved', JSON.stringify(objectiveOfType(l3After, 'clusterHealth')));
  assert(
    l3After.activeIncidents === 0 && l3After.health >= 90,
    'campaign gates: L3 cluster health is restored to >= 90',
    JSON.stringify({ health: l3After.health, active: l3After.activeIncidents }),
  );

  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  assert(await launch('campaign', 20), 'campaign gates: level 20 starts');
  await closeOverlays();
  const l20Resolve = (status) => status.objectives.filter((objective) => objective.type === 'resolve');
  const l20Start = await campaignGateStatus();
  assert(
    l20Resolve(l20Start).length >= 2 && l20Resolve(l20Start).every((objective) => !objective.completed),
    'campaign gates: L20 resolve objectives are incomplete at level start',
    JSON.stringify(l20Resolve(l20Start)),
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(10));
  const l20IncidentsFired = await waitFor(() => evaluate(() => window.game.incidentEngine.activationCount >= 2), 90000);
  assert(l20IncidentsFired, 'campaign gates: L20 scheduled incidents fire');
  const l20Active = await campaignGateStatus();
  assert(
    l20Active.activeIncidents >= 1 && l20Resolve(l20Active).every((objective) => !objective.completed),
    'campaign gates: L20 resolve objectives stay incomplete while the incidents are active',
    JSON.stringify({ active: l20Active.activeIncidents, resolve: l20Resolve(l20Active) }),
  );
  await evaluate(() => {
    const engine = window.game.incidentEngine;
    for (const incident of engine.getActiveIncidents()) engine.resolveIncident(incident.id, 'qa-gate');
  });
  const l20Resolved = await waitFor(async () => l20Resolve(await campaignGateStatus()).every((objective) => objective.completed), 30000);
  assert(
    l20Resolved,
    'campaign gates: L20 resolve objectives tick only after both incidents are resolved',
    JSON.stringify(l20Resolve(await campaignGateStatus())),
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. TIMED CHALLENGES 1-12
// ═══════════════════════════════════════════════════════════════════════════
const REQUIRED_CHALLENGE_TITLES = [
  'Three-Tier App', 'Fix CrashLoopBackOff', 'Route with Edge TLS', 'Kustomize Prod Overlay',
  'Build & Deploy from Source', 'Quota Guardrail', 'RBAC for a New Teammate',
  'SCC for a Privileged Workload', 'Network Isolation', 'Install an Operator',
  'HTPasswd Onboarding', 'EX280 Speed Run',
];
await runSection('challenges', async () => {
  await bootMenu();
  for (let id = 1; id <= 12; id += 1) {
    const ok = await launch('challenge', id);
    await sleep(400);
    const info = await evaluate(() => {
      const mode = window.game.app.modeInstance;
      const panel = document.getElementById('objectives-panel');
      const status = mode?.getStatus?.();
      return {
        challenge: mode?.currentChallenge,
        title: mode?.currentChallengeDef?.title,
        objectives: (mode?.objectiveProgress || []).length,
        panelDisplay: panel ? getComputedStyle(panel).display : 'none',
        panelRows: document.querySelectorAll('#obj-list > *').length,
        statusObjectives: (status?.objectives || []).length,
        timeRemaining: status?.timeRemaining,
      };
    });
    assert(ok, `challenges: challenge ${id} starts`);
    assert(info.challenge === id, `challenges: challenge ${id} currentChallenge`, JSON.stringify(info));
    assert(info.title === REQUIRED_CHALLENGE_TITLES[id - 1], `challenges: challenge ${id} title`, info.title);
    assert(info.objectives >= 1, `challenges: challenge ${id} objectives populated`, `got ${info.objectives}`);
    assert(info.panelDisplay !== 'none' && info.panelRows >= 1, `challenges: challenge ${id} objectives panel populated`, JSON.stringify(info));
    assert(info.statusObjectives >= 1, `challenges: challenge ${id} getStatus works`);
    await closeOverlays();
  }

  // Regression: the timed-lab countdown is frozen while Files is open.
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesForChallenge = await waitFor(() => evaluate(() => window.game?.app?.manifestPanel?.visible === true), 8000);
  assert(filesForChallenge, 'challenges: Files panel opens from F');
  await sleep(400);
  const challengeClockOpen = await evaluate(() => window.game.app.modeInstance.getStatus().timeRemaining);
  assert(await evaluate(() => window.game.gameEngine.state === 'paused'), 'challenges: Files panel pauses the simulation');
  await sleep(2000);
  const challengeClockHeld = await evaluate(() => window.game.app.modeInstance.getStatus().timeRemaining);
  assert(challengeClockHeld === challengeClockOpen, 'challenges: timeRemaining frozen while Files is open', `${challengeClockOpen} -> ${challengeClockHeld}`);
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const challengeFilesClosed = await waitFor(() => evaluate(() => window.game?.app?.manifestPanel?.visible === false), 5000);
  assert(challengeFilesClosed, 'challenges: Esc closes the Files panel');
  // Under software WebGL the RAF-driven countdown can be slow to resume, so poll
  // instead of relying on a single fixed sleep.
  let challengeClockRunning = challengeClockHeld;
  const clockResumed = await waitFor(async () => {
    challengeClockRunning = await evaluate(() => window.game.app.modeInstance.getStatus().timeRemaining);
    return challengeClockRunning < challengeClockHeld;
  }, 8000, 250);
  assert(clockResumed, 'challenges: countdown runs again after Files closes', `${challengeClockHeld} -> ${challengeClockRunning}`);

  // ── #22/#23: Timed lab 02 end-to-end + diagnostics fidelity ──────────────
  // The triggerTime:0 CrashLoopBackOff preload used to be counted by the uptime
  // baseline, soft-locking "Restore cluster health to at least 90%". Completing
  // the lab through the real CLI (investigate -> fix image -> rollout) must tick
  // all 4 objectives. The same run guards the #23 diagnostics: live image and
  // real Node in `describe pod`, no openshiftgames* internals leaking, a real
  // Pod Template / NewReplicaSet / conditions in `describe deployment`, correctly
  // scheduled crash-looping pods, and a 3D status that is not stuck "Pending".
  assert(await launch('challenge', 2), 'challenges: timed lab 02 starts');
  await evaluate(() => {
    window.game?.gameEngine?.resume?.();
    window.game?.gameEngine?.setTimeScale?.(4);
    window.game?.gameEngine?.simulation?.setBuildFailureRate?.(0);
  });
  await closeOverlays();
  const labStatus = () => evaluate(() => {
    const mode = window.game.app.modeInstance;
    const engine = window.game.incidentEngine;
    const status = mode.getStatus();
    return {
      challenge: mode.currentChallenge,
      state: status.state,
      timeRemaining: status.timeRemaining,
      objectives: status.objectives.map((objective) => ({
        type: objective.type,
        completed: objective.completed,
        current: objective.current,
        target: objective.target,
      })),
      health: engine.getClusterHealth(),
      activeIncidents: engine.getActiveIncidents().length,
      activationCount: engine.activationCount,
    };
  });
  const labObjective = (status, type) => status.objectives.find((objective) => objective.type === type);
  const labPlaying = await waitFor(async () => (await labStatus()).state === 'playing', 20000);
  assert(labPlaying, 'challenges: timed lab 02 is playing');
  const labCrashLoopActive = await waitFor(async () => {
    const status = await labStatus();
    return status.activeIncidents >= 1 && status.activationCount >= 1;
  }, 30000);
  const labBefore = await labStatus();
  assert(labCrashLoopActive, 'challenges: lab 02 CrashLoopBackOff incident is active', JSON.stringify(labBefore));
  assert(
    labBefore.activationCount >= 1 && labObjective(labBefore, 'uptime')?.completed === false,
    'challenges: lab 02 uptime objective is incomplete while the triggerTime:0 incident is active',
    JSON.stringify({ activationCount: labBefore.activationCount, uptime: labObjective(labBefore, 'uptime'), health: labBefore.health }),
  );
  const labIncident = await evaluate(() => {
    const engine = window.game.incidentEngine;
    const active = engine.getActiveIncidents();
    if (!active.length) return null;
    const details = engine.getIncidentDetails(active[0].id);
    return details ? { id: details.id, targetPod: details.targetPod, name: details.name } : null;
  });
  assert(Boolean(labIncident?.targetPod), 'challenges: lab 02 incident exposes a real crash-looping target Pod', JSON.stringify(labIncident));
  const labTargetPod = labIncident?.targetPod || '';

  // #23 (a): scheduling root cause — preloaded/damaged pods must be bound to a
  // real Node, including the `oc get pods -o wide` NODE column.
  const labScheduling = await evaluate(() => {
    const nodes = new Set((window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name));
    const pods = (window.game.cluster.getByKindAndNamespace?.('Pod', 'default') || [])
      .filter((pod) => pod.metadata?.labels?.app === 'payment-service');
    return {
      nodes: [...nodes],
      pods: pods.map((pod) => ({ name: pod.metadata.name, nodeName: pod.spec?.nodeName || null, onRealNode: nodes.has(pod.spec?.nodeName) })),
    };
  });
  assert(
    labScheduling.pods.length >= 3 && labScheduling.pods.every((pod) => pod.onRealNode),
    'challenges: lab 02 crash-looping pods are bound to a real Node (spec.nodeName)',
    JSON.stringify(labScheduling),
  );
  const labWide = await runCmd('oc get pods -l app=payment-service -o wide -n default');
  const labWideRows = labWide.message.split('\n').map((line) => line.trim()).filter((line) => /^payment-service-/.test(line));
  assert(
    labWideRows.length >= 3 && labWideRows.every((line) => labScheduling.nodes.some((node) => line.split(/\s+/).includes(node))),
    'challenges: oc get pods -o wide shows a real NODE column (not <none>)',
    JSON.stringify(labWideRows.map((line) => line.slice(0, 180))),
  );

  // #23 (b): describe pod shows the live image + real Node and leaks nothing.
  const labLogs = await runCmd('oc logs deployment/payment-service --previous -n default');
  assert(
    !labLogs.error && /invalid configuration|exit code 1|FATAL/i.test(labLogs.message),
    'challenges: lab 02 previous logs show the crash output',
    labLogs.message.replace(/\n/g, ' ⏎ ').slice(0, 300),
  );
  const labDescribePod = await runCmd(`oc describe pod ${labTargetPod} -n default`);
  const labLiveImage = await runCmd(`oc get pod ${labTargetPod} -n default -o jsonpath={.spec.containers[0].image}`);
  const labDescribeImage = (labDescribePod.message.match(/^\s*Image:\s+(.+)$/m) || [])[1] || '';
  assert(
    !labDescribePod.error
      && labDescribeImage.trim() === labLiveImage.message.trim()
      && labDescribeImage.trim() === 'quay.io/example/payments:v2-bad-config',
    '#23: describe pod Image matches the live spec image',
    `${labDescribeImage} vs ${labLiveImage.message}`,
  );
  const labNodeLine = labDescribePod.message.match(/^Node:\s+(\S+)\/(\S+)$/m) || [];
  assert(
    Boolean(labNodeLine[1]) && labNodeLine[1] !== '<none>' && labNodeLine[2] !== '<none>',
    '#23: describe pod shows a real Node (not <none>/<none>)',
    labNodeLine[0],
  );
  assert(
    !/openshiftgames/i.test(labDescribePod.message),
    '#23: describe pod hides simulator-internal annotations',
    (labDescribePod.message.match(/Annotations:.*$/m) || [])[0],
  );
  const labPodYaml = await runCmd(`oc get pod ${labTargetPod} -n default -o yaml`);
  const labPodListYaml = await runCmd('oc get pods -l app=payment-service -n default -o yaml');
  assert(!/openshiftgames/i.test(labPodYaml.message), '#23: oc get pod -o yaml hides simulator-internal annotations');
  assert(!/openshiftgames/i.test(labPodListYaml.message), '#23: oc get pods -o yaml hides simulator-internal annotations');

  // #23 (c): describe deployment has a real Pod Template, NewReplicaSet and the
  // status-derived conditions (not the old always-healthy ones).
  const labDeployDescribe = await runCmd('oc describe deployment payment-service -n default');
  assert(
    /^Pod Template:/m.test(labDeployDescribe.message) && /^\s+Containers:/m.test(labDeployDescribe.message),
    '#23: describe deployment includes a real Pod Template section',
    labDeployDescribe.message.slice(0, 400),
  );
  assert(
    /Image:\s+quay\.io\/example\/payments:v2-bad-config/.test(labDeployDescribe.message),
    '#23: describe deployment Pod Template shows the container image',
    labDeployDescribe.message.slice(0, 600),
  );
  const labNewReplicaSet = (labDeployDescribe.message.match(/^NewReplicaSet:\s+(.+)$/m) || [])[1] || '';
  assert(
    /^payment-service-[a-z0-9]+ \(\d+\/\d+ replicas created\)$/.test(labNewReplicaSet.trim()),
    '#23: describe deployment shows NewReplicaSet <hash> (3/3 replicas created)',
    labNewReplicaSet,
  );
  assert(
    /Available\s+False\s+MinimumReplicasUnavailable/.test(labDeployDescribe.message),
    '#23: describe deployment reports Available False MinimumReplicasUnavailable while crash-looping',
    labDeployDescribe.message.split('\n').filter((line) => /Available|Progressing/.test(line)).join(' | '),
  );
  assert(
    !/openshiftgames/i.test(labDeployDescribe.message),
    '#23: describe deployment hides simulator-internal annotations',
    (labDeployDescribe.message.match(/Annotations:.*$/m) || [])[0],
  );
  const labDeployYaml = await runCmd('oc get deployment payment-service -n default -o yaml');
  assert(!/openshiftgames/i.test(labDeployYaml.message), '#23: oc get deployment -o yaml hides simulator-internal internals');
  const labBrokenVisual = await evaluate(async () => {
    const { visualStatusFor, isAttentionStatus } = await import('/js/rendering/ResourceStatus.js');
    const deployment = window.game.cluster.getByName('Deployment', 'payment-service', 'default');
    const visual = visualStatusFor(deployment, null);
    return { visual, attention: isAttentionStatus(visual) };
  });
  assert(
    labBrokenVisual.visual !== 'Pending' && labBrokenVisual.attention === true,
    '#23: failing Deployment status is not Pending and carries an attention status',
    JSON.stringify(labBrokenVisual),
  );

  // Investigate, then fix the workload with the documented `oc set image`.
  await expectCmd('challenges: lab 02 investigate logs', 'oc logs deployment/payment-service --previous -n default', /invalid configuration|exit code 1|FATAL/i);
  await expectCmd('challenges: lab 02 investigate describe', `oc describe pod ${labTargetPod} -n default`, /payment-service/);
  const labInvestigated = await waitFor(async () => labObjective(await labStatus(), 'investigate')?.completed === true, 15000);
  assert(labInvestigated, 'challenges: lab 02 investigate objective ticks after logs/describe');
  await expectCmd(
    'challenges: lab 02 fix image',
    'oc set image deployment/payment-service main=quay.io/openshift/origin-hello-openshift:latest -n default',
    /image updated|updated/i,
  );
  const labCompleted = await waitFor(async () => (await labStatus()).state === 'completed', 60000);
  const labAfter = await labStatus();
  assert(
    labCompleted,
    '#22: timed lab 02 completes after the documented image fix',
    JSON.stringify({ state: labAfter.state, timeRemaining: labAfter.timeRemaining }),
  );
  assert(
    labAfter.objectives.length === 4 && labAfter.objectives.every((objective) => objective.completed),
    '#22: timed lab 02 reaches 4/4 objectives complete',
    JSON.stringify(labAfter.objectives),
  );
  const labUptime = labObjective(labAfter, 'uptime');
  assert(
    labUptime?.completed === true && labUptime.current >= 90,
    '#22: "Restore cluster health to at least 90%" ticks after the fix (triggerTime:0 baseline)',
    JSON.stringify(labUptime),
  );
  assert(
    labAfter.activeIncidents === 0 && labAfter.health >= 90,
    '#22: lab 02 incident cleared and cluster health >= 90',
    JSON.stringify({ active: labAfter.activeIncidents, health: labAfter.health }),
  );
  await waitFor(() => evaluate(() => (window.game.cluster.getByName('Deployment', 'payment-service', 'default')?.status?.readyReplicas || 0) >= 3), 15000);
  const labDeploymentState = await evaluate(() => {
    const deployment = window.game.cluster.getByName('Deployment', 'payment-service', 'default');
    const nodes = new Set((window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name));
    const pods = (window.game.cluster.getByKindAndNamespace?.('Pod', 'default') || [])
      .filter((pod) => pod.metadata?.labels?.app === 'payment-service')
      .map((pod) => ({ phase: pod.status?.phase, onRealNode: nodes.has(pod.spec?.nodeName) }));
    return {
      readyReplicas: deployment?.status?.readyReplicas ?? 0,
      availableReplicas: deployment?.status?.availableReplicas ?? 0,
      pods,
    };
  });
  assert(
    labDeploymentState.readyReplicas >= 3
      && labDeploymentState.pods.length >= 3
      && labDeploymentState.pods.every((pod) => pod.phase === 'Running' && pod.onRealNode),
    '#22: payment-service rolls out 3/3 Ready on real Nodes',
    JSON.stringify(labDeploymentState),
  );
  const labHealthyDescribe = await runCmd('oc describe deployment payment-service -n default');
  assert(
    /Available\s+True\s+MinimumReplicasAvailable/.test(labHealthyDescribe.message),
    '#23: recovered Deployment reports Available True MinimumReplicasAvailable',
    labHealthyDescribe.message.split('\n').filter((line) => /Available/.test(line)).join(' | '),
  );
  const labHealthyVisual = await evaluate(async () => {
    const { visualStatusFor, isAttentionStatus } = await import('/js/rendering/ResourceStatus.js');
    const deployment = window.game.cluster.getByName('Deployment', 'payment-service', 'default');
    const visual = visualStatusFor(deployment, null);
    return { visual, attention: isAttentionStatus(visual) };
  });
  assert(
    labHealthyVisual.visual === 'Running' && labHealthyVisual.attention === false,
    '#23: healthy Deployment status reads Running with no attention suffix',
    JSON.stringify(labHealthyVisual),
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  await closeOverlays();
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. EXTERNAL-REVIEW FOLLOW-UP (real project templates, password rotation, role flags)
// ═══════════════════════════════════════════════════════════════════════════
await runSection('followup', async () => {
  await bootSandbox();
  await openFilesPanel();
  await evaluate(() => window.game.manifestPanel?.hide?.());
  await sleep(300);

  // oc create role/clusterrole must honour --verb/--resource (not registry defaults).
  await expectCmd('followup: oc create role --verb/--resource', 'oc create role podread --verb=get,list --resource=pods -n default', /role\.rbac\.authorization\.k8s\.io\/podread created/);
  const roleRules = await evaluate(() => window.game.cluster.getByKind('Role').find((r) => r.metadata.name === 'podread')?.spec?.rules);
  assert(
    JSON.stringify(roleRules) === JSON.stringify([{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }]),
    'followup: role rules exactly match the requested flags',
    JSON.stringify(roleRules),
  );
  await expectCmd('followup: bind the new role', 'oc adm policy add-role-to-user podread alice -n default', /added|configured/i);
  await expectCmd('followup: role rules feed oc auth can-i (allow)', 'oc auth can-i get pods --as=alice -n default', /yes/i);
  await expectCmd('followup: role rules feed oc auth can-i (deny)', 'oc auth can-i delete pods --as=alice -n default', /no/i);

  // Dry-run Secret output must be API-shaped and pipe into replace -f -.
  const drySecret = await runCmd('oc create secret generic follow-secret --from-literal=a=b --dry-run=client -o yaml -n default');
  assert(
    !drySecret.error && /^type:/m.test(drySecret.message) && /^data:/m.test(drySecret.message) && !/^spec:/m.test(drySecret.message),
    'followup: dry-run secret YAML is API-shaped',
    drySecret.message.slice(0, 180),
  );
  await expectCmd('followup: dry-run | replace -f - pipeline', 'oc create secret generic follow-secret2 --from-literal=a=b --dry-run=client -o yaml -n default | oc replace -f -', /created|configured/);

  // Real project-template flow: no stored template on a fresh cluster, generate one.
  await expectCmd('followup: fresh cluster has no project template', 'oc get templates -n openshift-config', /No resources found/i);
  const bootstrap = await runCmd('oc adm create-bootstrap-project-template -o yaml');
  assert(
    !bootstrap.error && /kind: Template/.test(bootstrap.message) && /PROJECT_REQUESTING_USER/.test(bootstrap.message) && /RoleBinding/.test(bootstrap.message),
    'followup: create-bootstrap-project-template emits the canonical template',
    bootstrap.message.slice(0, 200),
  );

  // HTPasswd password rotation: extract -> htpasswd -bB -> set data -> rollout -> login.
  await expectCmd('followup: htpasswd file', 'htpasswd -c -B -b users.htpasswd rotate-user Passw0rd1', () => true);
  await expectCmd('followup: htpasswd secret', 'oc create secret generic htpasswd-secret --from-file=htpasswd=users.htpasswd -n openshift-config', /created|configured/);
  await evaluate(() => window.game.gameEngine.configureHTPasswdProvider({ secretName: 'htpasswd-secret' }));
  await evaluate(() => { const sim = window.game.gameEngine.simulation; for (let i = 0; i < 160; i += 1) sim.tick(0.05); });
  await waitFor(() => evaluate(() => window.game?.gameEngine?.authProvider?.ready === true), 8000);
  await expectCmd('followup: baseline login', 'oc login -u rotate-user -p Passw0rd1', /Login successful|logged in/i, { wait: 300 });
  await evaluate(() => window.game.app.commandBar.executeCommand('oc login -u kubeadmin'));
  await expectCmd('followup: oc extract secret to virtual FS', 'oc extract secret/htpasswd-secret -n openshift-config --to /tmp --confirm', /tmp\/htpasswd/);
  await expectCmd('followup: rotate password in extracted file', "htpasswd -bB /tmp/htpasswd rotate-user 'NewPassw0rd!'", () => true);
  await expectCmd('followup: oc set data secret updates the secret', 'oc set data secret/htpasswd-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd', /data updated/i);
  await evaluate(() => { const sim = window.game.gameEngine.simulation; for (let i = 0; i < 160; i += 1) sim.tick(0.05); });
  await expectCmdError('followup: old password rejected after rotation', 'oc login -u rotate-user -p Passw0rd1', /Login failed|401/i);
  await expectCmd('followup: new password accepted after rotation', 'oc login -u rotate-user -p NewPassw0rd!', /Login successful|logged in/i);
  await evaluate(() => window.game.app.commandBar.executeCommand('oc login -u kubeadmin'));

  // project.config singleton + new project inheriting the configured template.
  await expectCmd('followup: project.config get', 'oc get project.config.openshift.io/cluster', /NAME|cluster/i);
  await expectCmd(
    'followup: project.config patch projectRequestTemplate',
    'oc patch project.config.openshift.io/cluster --type=merge -p \'{"spec":{"projectRequestTemplate":{"name":"project-request"}}}\'',
    /patched/i,
  );
  const customTemplate = `apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: project-request
  namespace: openshift-config
parameters:
  - name: PROJECT_NAME
    required: true
  - name: PROJECT_ADMIN_USER
objects:
  - apiVersion: project.openshift.io/v1
    kind: Project
    metadata:
      name: \${PROJECT_NAME}
  - apiVersion: networking.k8s.io/v1
    kind: NetworkPolicy
    metadata:
      name: default-deny
      namespace: \${PROJECT_NAME}
    spec:
      podSelector: {}
      policyTypes: [Ingress, Egress]
`;
  await evaluate((text) => window.game.manifestEngine.writeFile('followup-template.yaml', text), customTemplate);
  await expectCmd('followup: create custom project template', 'oc create -f followup-template.yaml -n openshift-config', /created|configured/);
  await expectCmd('followup: new-project uses the configured template', 'oc new-project followup-check', /Now using project|created/i);
  const templateInheritance = await evaluate(() => ({
    networkPolicy: window.game.cluster.getByKind('NetworkPolicy').some((n) => n.metadata.name === 'default-deny' && n.metadata.namespace === 'followup-check'),
    adminBinding: window.game.cluster.getByKind('RoleBinding').some((r) => r.metadata.name === 'admin' && r.metadata.namespace === 'followup-check'),
  }));
  assert(templateInheritance.networkPolicy, 'followup: new project inherits template objects', JSON.stringify(templateInheritance));
  assert(templateInheritance.adminBinding, 'followup: new project grants the requester admin', JSON.stringify(templateInheritance));

  // oc edit explains the real $EDITOR (vi/vim) difference.
  await expectCmd('followup: create deployment for edit note', 'oc create deployment editnote --image=quay.io/openshift/origin-hello-openshift:latest -n followup-check', /created/i);
  await expectCmd('followup: oc edit mentions $EDITOR / vi', 'oc edit deployment/editnote -n followup-check', /(vi\b|vim|\$EDITOR)/i);
  await expectCmd('followup: oc edit project.config opens editor', 'oc edit project.config.openshift.io/cluster', /manifest editor/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10b. REGRESSIONS (cluster map collapse; restart auto-align)
// ═══════════════════════════════════════════════════════════════════════════
// These two are user-reported bugs that the per-feature sections above do not
// cover:
//   1. The cluster map's first collapse click used to hide only the canvas and
//      leave the fixed-height empty card behind; only a later expand/collapse
//      cycle shrank it. The first click must collapse the card immediately.
//   2. Restarting a level rebuilds the cluster from scratch, and that rebuild
//      used to skip the post-launch layout step, stacking 50+ seeded resources
//      at one random point. Restart (and next level) must auto-align exactly
//      like a fresh launch — no manual Auto Align required.
await runSection('regressions', async () => {
  // ── 1. Cluster map collapses on the first click ──────────────────────────
  await bootSandbox();
  const minimap = () =>
    evaluate(() => {
      const container = document.getElementById('minimap');
      if (!container) return { missing: true };
      const card = container.querySelector(':scope > div');
      const canvas = document.getElementById('minimap-canvas');
      const toggle = document.getElementById('minimap-toggle');
      const rect = container.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();
      return {
        containerBottom: rect.bottom,
        containerRight: rect.right,
        cardH: cardRect?.height,
        canvasDisplay: canvas ? getComputedStyle(canvas).display : 'missing',
        toggleText: toggle?.textContent,
        ariaExpanded: toggle?.getAttribute('aria-expanded'),
        ids: document.querySelectorAll('#minimap-toggle').length,
      };
    });

  const expanded = await minimap();
  assert(!expanded.missing && expanded.cardH > 120, 'regressions: cluster map starts expanded', JSON.stringify(expanded));
  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const collapsedFirst = await minimap();
  assert(
    collapsedFirst.canvasDisplay === 'none' && collapsedFirst.cardH > 16 && collapsedFirst.cardH < 60,
    'regressions: first collapse click shrinks the cluster map immediately',
    JSON.stringify(collapsedFirst),
  );
  assert(
    collapsedFirst.toggleText === '+' && collapsedFirst.ariaExpanded === 'false',
    'regressions: collapse click updates the cluster map toggle state',
    JSON.stringify({ text: collapsedFirst.toggleText, ariaExpanded: collapsedFirst.ariaExpanded }),
  );
  assert(
    Math.abs(collapsedFirst.containerBottom - expanded.containerBottom) < 1 &&
      Math.abs(collapsedFirst.containerRight - expanded.containerRight) < 1,
    'regressions: collapsed cluster map stays anchored bottom-right',
    JSON.stringify({ before: [expanded.containerBottom, expanded.containerRight], after: [collapsedFirst.containerBottom, collapsedFirst.containerRight] }),
  );
  assert(collapsedFirst.ids === 1, 'regressions: cluster map keeps a single toggle', `got ${collapsedFirst.ids}`);
  const minimapCollapsedShot = await shot('regressions-minimap-collapsed.png');
  if (minimapCollapsedShot) shotsTaken.push(minimapCollapsedShot);

  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const expandedAgain = await minimap();
  assert(
    expandedAgain.canvasDisplay === 'block' && expandedAgain.cardH > 120 && expandedAgain.toggleText === '-' && expandedAgain.ariaExpanded === 'true',
    'regressions: cluster map expands again with the canvas visible',
    JSON.stringify(expandedAgain),
  );
  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const collapsedSecond = await minimap();
  assert(
    collapsedSecond.cardH > 16 && collapsedSecond.cardH < 60,
    'regressions: second collapse still shrinks the cluster map',
    JSON.stringify(collapsedSecond),
  );

  // ── 1b. Incident drawer: single panel, engine-truth count, no overlap ─────
  // #1: a level change/retry used to append a second #incident-panel whose
  // frozen HTML showed "0 active"; the drawer also covered the mission card and
  // the bottom view toolbar.
  await evaluate(() => window.game.app.launchGame('sandbox'));
  await waitFor(
    () => evaluate(() => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance),
    12000,
  );
  await sleep(1800);
  const panelCount = await evaluate(() => document.querySelectorAll('#incident-panel').length);
  assert(panelCount === 1, 'regressions: relaunch keeps a single incident panel', `got ${panelCount}`);
  await evaluate(() => document.activeElement?.blur?.());
  await evaluate(() => document.getElementById('hud-alerts')?.click());
  // Wait until the drawer slide + mission-card/toolbar shift have settled
  // (SwiftShader load can stretch the 240ms transitions).
  await waitFor(() => evaluate(() => {
    const panel = document.querySelector('#incident-panel');
    const objectives = document.querySelector('#objectives-panel');
    const toolbar = document.querySelector('#view-toolbar');
    if (!panel || !panel.classList.contains('is-open')) return false;
    const pr = panel.getBoundingClientRect();
    if (pr.x < -1) return false;
    if (innerWidth > 900) {
      return objectives.getBoundingClientRect().x >= pr.right && toolbar.getBoundingClientRect().x >= pr.right;
    }
    return getComputedStyle(objectives).display === 'none';
  }), 8000);
  await sleep(150);
  const drawer = await evaluate(() => {
    const panel = document.querySelector('#incident-panel');
    const objectives = document.querySelector('#objectives-panel');
    const toolbar = document.querySelector('#view-toolbar');
    const p = panel.getBoundingClientRect();
    const o = objectives.getBoundingClientRect();
    const t = toolbar.getBoundingClientRect();
    return {
      open: panel.classList.contains('is-open'),
      bodyClass: document.body.classList.contains('side-panel-left-open'),
      bell: document.getElementById('hud-alerts')?.getAttribute('aria-expanded'),
      headerCount: document.querySelector('#incident-count')?.textContent,
      engineCount: String(window.game.incidentEngine.getActiveIncidents().length),
      empty: /No active incidents/.test(document.querySelector('#incident-list')?.textContent || ''),
      panelRight: Math.round(p.right),
      objectivesLeft: Math.round(o.left),
      objectivesDisplay: getComputedStyle(objectives).display,
      toolbarLeft: Math.round(t.left),
      viewport: innerWidth,
    };
  });
  assert(
    drawer.open && drawer.bodyClass && drawer.bell === 'true',
    'regressions: incidents drawer opens with shared state + HUD aria',
    JSON.stringify(drawer),
  );
  assert(
    drawer.headerCount === drawer.engineCount && (Number(drawer.engineCount) > 0 || drawer.empty),
    'regressions: incidents drawer header matches the engine count',
    JSON.stringify(drawer),
  );
  if (drawer.viewport > 900) {
    assert(
      drawer.toolbarLeft >= drawer.panelRight,
      'regressions: incidents drawer no longer covers the view toolbar',
      JSON.stringify(drawer),
    );
    // Sandbox has no mission checklist (the panel is display:none there); the
    // mission-card shift is asserted in campaign mode below.
    if (drawer.objectivesDisplay !== 'none') {
      assert(
        drawer.objectivesLeft >= drawer.panelRight,
        'regressions: incidents drawer no longer covers the mission card',
        JSON.stringify(drawer),
      );
    }
  } else {
    assert(drawer.objectivesDisplay === 'none', 'regressions: narrow viewport stacks drawer over mission card', JSON.stringify(drawer));
  }
  await page.keyboard.press('Escape');
  await sleep(450);
  const drawerClosed = await evaluate(() => ({
    open: document.querySelector('#incident-panel')?.classList.contains('is-open'),
    bodyClass: document.body.classList.contains('side-panel-left-open'),
    bell: document.getElementById('hud-alerts')?.getAttribute('aria-expanded'),
  }));
  assert(
    drawerClosed.open === false && drawerClosed.bodyClass === false && drawerClosed.bell === 'false',
    'regressions: Esc closes the incidents drawer and clears its layout state',
    JSON.stringify(drawerClosed),
  );

  // ── 2. Restart level auto-aligns the rebuilt cluster ─────────────────────
  const readScene = () =>
    evaluate(() => {
      const app = window.game?.app;
      const renderer = app?.renderer;
      if (!renderer?.camera) return null;
      const positions = [];
      for (const group of renderer.resourceMeshes.values()) {
        positions.push([
          Math.round(group.position.x * 100) / 100,
          Math.round(group.position.y * 100) / 100,
          Math.round(group.position.z * 100) / 100,
        ]);
      }
      positions.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
      const counts = new Map();
      for (const position of positions) {
        const key = position.join(',');
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return {
        count: positions.length,
        unique: counts.size,
        // Controller-created children (ReplicaSet/Pods) can legitimately share a
        // spawn slot on a genuine fresh launch; the restart bug stacked 50+ seeds.
        maxShared: Math.max(0, ...counts.values()),
        signature: positions.map((p) => p.join(',')).join('|'),
        camera: [
          Math.round(renderer.camera.position.x * 100) / 100,
          Math.round(renderer.camera.position.y * 100) / 100,
          Math.round(renderer.camera.position.z * 100) / 100,
        ],
        menuMode: Boolean(renderer.menuMode),
      };
    });
  const cameraDistance = (a, b) => Math.hypot((a?.[0] ?? 0) - (b?.[0] ?? 0), (a?.[1] ?? 0) - (b?.[1] ?? 0), (a?.[2] ?? 0) - (b?.[2] ?? 0));

  await bootCampaign(1);
  await sleep(1800); // let the launch layout + camera fit finish
  const launchScene = await readScene();
  assert(
    launchScene && launchScene.count > 20 && launchScene.unique === launchScene.count && !launchScene.menuMode,
    'regressions: fresh campaign level starts auto-aligned',
    JSON.stringify({ count: launchScene?.count, unique: launchScene?.unique }),
  );

  // The incidents drawer must not cover the campaign mission card or the view
  // toolbar on wide viewports (GitHub QA screenshot + the follow-up toolbar bug).
  await evaluate(() => window.game.app.incidentPanel?.show?.());
  await waitFor(() => evaluate(() => {
    const panel = document.querySelector('#incident-panel');
    const objectives = document.querySelector('#objectives-panel');
    const toolbar = document.querySelector('#view-toolbar');
    if (!panel || !panel.classList.contains('is-open')) return false;
    const pr = panel.getBoundingClientRect();
    return pr.x >= -1
      && objectives.getBoundingClientRect().x >= pr.right
      && toolbar.getBoundingClientRect().x >= pr.right;
  }), 8000);
  await sleep(150);
  const campaignDrawer = await evaluate(() => {
    const panel = document.querySelector('#incident-panel').getBoundingClientRect();
    const objectives = document.querySelector('#objectives-panel');
    const or = objectives.getBoundingClientRect();
    const toolbar = document.querySelector('#view-toolbar').getBoundingClientRect();
    return {
      panelRight: Math.round(panel.right),
      objectivesLeft: Math.round(or.x),
      objectivesDisplay: getComputedStyle(objectives).display,
      toolbarLeft: Math.round(toolbar.x),
      bodyClass: document.body.classList.contains('side-panel-left-open'),
    };
  });
  assert(
    campaignDrawer.objectivesDisplay !== 'none'
      && campaignDrawer.objectivesLeft >= campaignDrawer.panelRight
      && campaignDrawer.toolbarLeft >= campaignDrawer.panelRight
      && campaignDrawer.bodyClass,
    'regressions: incidents drawer leaves the campaign mission card and toolbar visible',
    JSON.stringify(campaignDrawer),
  );
  await page.keyboard.press('Escape');
  await waitFor(() => evaluate(() => document.body.classList.contains('side-panel-left-open') === false), 5000);
  await sleep(200);

  // Drive the real pause-card button, not the internal method.
  await evaluate(() => window.game.app.showPause());
  await sleep(400);
  assert(
    await evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === true),
    'regressions: pause card opens before restart',
  );
  await evaluate(() => document.getElementById('pause-restart')?.click());
  await sleep(3200); // 600ms layout + 820ms camera fit with headroom
  const restartScene = await readScene();
  const stableScene = await readScene();
  assert(restartScene?.count === launchScene?.count, 'regressions: restart keeps every cluster resource rendered', `${launchScene?.count} -> ${restartScene?.count}`);
  assert(
    restartScene && restartScene.unique === restartScene.count,
    'regressions: restart auto-aligns the rebuilt cluster (no stacked resources)',
    JSON.stringify({ count: restartScene?.count, unique: restartScene?.unique }),
  );
  assert(
    restartScene?.signature === launchScene?.signature,
    'regressions: restarted layout matches the fresh-launch layout',
    `camera delta ${cameraDistance(restartScene?.camera, launchScene?.camera)}`,
  );
  assert(
    cameraDistance(restartScene?.camera, launchScene?.camera) < 2,
    'regressions: restart refits the camera to the fresh-launch view',
    JSON.stringify({ launch: launchScene?.camera, restart: restartScene?.camera }),
  );
  assert(stableScene?.signature === restartScene?.signature, 'regressions: restarted layout settles and stays put');
  const restartShot = await shot('regressions-campaign-restart.png');
  if (restartShot) shotsTaken.push(restartShot);

  // ── 3. "Next Level" uses the same post-launch layout ─────────────────────
  await evaluate(() => {
    const app = window.game.app;
    app.scoringEngine.progress.campaignProgress[1] = { completed: true, stars: 3 };
    document.getElementById('level-complete-next')?.click();
  });
  const level2Started = await waitFor(() => evaluate(() => window.game.app.modeInstance?.currentLevel === 2), 10000);
  assert(level2Started, 'regressions: next level starts from the level-complete action');
  await sleep(2200); // let the next level's layout + camera fit finish
  const level2Scene = await readScene();
  assert(
    level2Scene && level2Scene.count > 20 && level2Scene.maxShared <= 4,
    'regressions: next level starts auto-aligned (no stacked pile)',
    JSON.stringify({ count: level2Scene?.count, unique: level2Scene?.unique, maxShared: level2Scene?.maxShared }),
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. DRAW PAGE
// ═══════════════════════════════════════════════════════════════════════════
await runSection('draw', async () => {
  await goto('/draw');
  const loaded = await waitFor(() => evaluate(() => !!window.openshiftDraw && document.querySelectorAll('#resource-palette .palette-item').length > 0), 20000);
  assert(loaded, 'draw: page loads with palette');
  await sleep(1000);
  const draw = await evaluate(() => {
    const palette = [...document.querySelectorAll('#resource-palette .palette-item')].map((el) => el.dataset.resource);
    return {
      title: document.title,
      palette,
      unique: new Set(palette).size,
      watermark: document.getElementById('draw-watermark')?.innerText || '',
      route: palette.includes('Route'),
      project: palette.includes('Project'),
      buildConfig: palette.includes('BuildConfig'),
      hasApp: !!window.openshiftDraw,
    };
  });
  assert(/OpenShift Draw/.test(draw.title), 'draw: OpenShift Draw title', draw.title);
  assert(draw.palette.length === 37 && draw.unique === 37, 'draw: palette has 37 unique kinds', `got ${draw.palette.length}/${draw.unique}`);
  assert(draw.route && draw.project && draw.buildConfig, 'draw: Route/Project/BuildConfig in palette');
  assert(/OpenShift Games/.test(draw.watermark) && /\/draw/.test(draw.watermark), 'draw: OpenShift Games /draw watermark', draw.watermark);
  assert(draw.hasApp, 'draw: app instance exposed');

  const yaml = await evaluate(async () => {
    const app = window.openshiftDraw;
    const placements = [
      ['Project', 0.34, 0.58],
      ['Route', 0.46, 0.47],
      ['BuildConfig', 0.58, 0.56],
    ];
    for (const [kind, fx, fy] of placements) {
      app.placeResource(kind, Math.floor(window.innerWidth * fx), Math.floor(window.innerHeight * fy));
    }
    await new Promise((r) => setTimeout(r, 500));
    app.autoLayout?.();
    await new Promise((r) => setTimeout(r, 1000));
    let blob = null;
    const origCreate = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => {
      blob = b;
      return 'blob:verify';
    };
    HTMLAnchorElement.prototype.click = function () {};
    try {
      app.exportYAML();
    } finally {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    }
    return blob ? await blob.text() : '';
  });
  assert(/apiVersion:\s*route\.openshift\.io\/v1/.test(yaml), 'draw: YAML export uses Route route.openshift.io/v1');
  assert(/apiVersion:\s*build\.openshift\.io\/v1/.test(yaml), 'draw: YAML export uses BuildConfig build.openshift.io/v1');
  assert(/apiVersion:\s*project\.openshift\.io\/v1/.test(yaml), 'draw: YAML export uses Project project.openshift.io/v1');
  assert(/kind:\s*Route/.test(yaml) && /kind:\s*BuildConfig/.test(yaml) && /kind:\s*Project/.test(yaml), 'draw: YAML export includes Route/BuildConfig/Project');
  await sleep(500);
  const drawShot = await shot('draw.png');
  if (drawShot) shotsTaken.push(drawShot);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. FINAL ARTIFACTS (hero + OG image)
// ═══════════════════════════════════════════════════════════════════════════
await runSection('shots', async () => {
  if (NO_SHOTS) return;
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
  await bootSandbox();
  await sleep(1500);
  await evaluate(() => window.game.app.autoAlignResources?.());
  await sleep(1000);
  await page.screenshot({ path: join(ROOT, 'screenshot.png') });
  console.log('  SHOT  screenshot.png (1600x900 hero)');
  shotsTaken.push('screenshot.png');

  const ogPage = await browser.newPage();
  await ogPage.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  ogPage.on('pageerror', (err) => pageErrors.push({ section: 'shots', text: `og-image: ${err}` }));
  await ogPage.goto(`${BASE}/og-image.html`, { waitUntil: 'networkidle2', timeout: 30000 });
  await ogPage.evaluate(() => (document.fonts?.ready || Promise.resolve()));
  await sleep(800);
  await ogPage.screenshot({ path: join(ROOT, 'og-image.png') });
  await ogPage.close();
  console.log('  SHOT  og-image.png (1200x630)');
  shotsTaken.push('og-image.png');
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
const uniqueConsole = [...new Map(consoleErrors.map((e) => [`${e.section}:${e.text}`, e])).values()];
const uniquePageErrors = [...new Map(pageErrors.map((e) => [`${e.section}:${e.text}`, e])).values()];
if (uniquePageErrors.length) {
  fail('console: uncaught page errors', uniquePageErrors.slice(0, 8).map((e) => `[${e.section}] ${e.text}`).join('\n'));
} else {
  pass('console: no uncaught page errors');
}
if (uniqueConsole.length) {
  fail('console: unexpected console errors', uniqueConsole.slice(0, 8).map((e) => `[${e.section}] ${e.text}`).join('\n'));
} else {
  pass('console: no unexpected console errors');
}

function imageInfo(rel) {
  try {
    const buf = readFileSync(join(ROOT, rel));
    return { path: rel, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  } catch {
    return null;
  }
}
const artifacts = {
  screenshot: imageInfo('screenshot.png'),
  ogImage: imageInfo('og-image.png'),
  screenshots: [...new Set(shotsTaken)].map((rel) => imageInfo(rel)).filter(Boolean),
};
if (!NO_SHOTS) {
  assert(artifacts.screenshot?.width === 1600 && artifacts.screenshot?.height === 900, 'shots: screenshot.png is 1600x900', JSON.stringify(artifacts.screenshot));
  assert(artifacts.ogImage?.width === 1200 && artifacts.ogImage?.height === 630, 'shots: og-image.png is 1200x630', JSON.stringify(artifacts.ogImage));
  for (const name of ['menu', 'sandbox', 'campaign-level-1', 'exam-prep', 'files-panel', 'draw']) {
    const rel = `docs/screenshots/${name}.png`;
    if (ONLY.length > 0 && !shotsTaken.includes(rel)) continue; // subset runs don't take every shot
    const info = artifacts.screenshots.find((s) => s.path === rel) || imageInfo(rel);
    assert(!!info && info.width === 1600 && info.height === 900, `shots: ${rel} (1600x900)`, JSON.stringify(info));
  }
}

let chromeVersion = 'unknown';
try {
  chromeVersion = await browser.version();
} catch {
  /* ignore */
}
await browser.close();
server.close();

const summary = {
  passes: passes.length,
  failures: failures.length,
  warnings: warnings.length,
  consoleErrors: uniqueConsole.length,
  pageErrors: uniquePageErrors.length,
};
const goNoGo = failures.length === 0 ? 'GO' : 'NO-GO';
const report = {
  timestamp: new Date().toISOString(),
  environment: {
    node: process.version,
    chrome: chromeVersion,
    baseUrl: BASE,
    viewport: VIEWPORT,
    puppeteerCore: PUPPETEER_DIR,
    startedAt: startedAt.toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
  },
  summary,
  goNoGo,
  sections,
  failures,
  warnings,
  consoleErrors: uniqueConsole,
  pageErrors: uniquePageErrors,
  artifacts,
  passes,
};
await mkdir(join(ROOT, 'docs'), { recursive: true });
await writeFile(join(ROOT, 'docs', 'verification-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('\n' + '─'.repeat(74));
console.log(`Browser tests: ${summary.passes} passed, ${summary.failures} failed, ${summary.warnings} warnings`);
if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings) console.log(`  - [${w.section}] ${w.name}${w.detail ? `: ${String(w.detail).slice(0, 300)}` : ''}`);
}
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - [${f.section}] ${f.name}${f.detail ? `\n      ${String(f.detail).replace(/\n/g, '\n      ')}` : ''}`);
}
console.log('─'.repeat(74));
console.log(`Report: docs/verification-report.json · verdict: ${goNoGo}`);
process.exit(failures.length ? 1 : 0);
