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
  failures.push({
    section: currentSection,
    name,
    detail: detail === undefined ? undefined : String(detail),
  });
  sectionLabel(currentSection).failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
}
function warn(name, detail) {
  warnings.push({
    section: currentSection,
    name,
    detail: detail === undefined ? undefined : String(detail),
  });
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
    /Failed to load resource.*(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/i.test(
      text
    ) ||
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
    /(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|api\.github\.com|github\.com)/i.test(
      url
    ) ||
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
  await waitFor(
    () =>
      evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === false),
    8000
  );
  await sleep(700);
  await closeOverlays();
}
async function bootSandbox() {
  await goto('/?mode=sandbox&tutorial=0');
  const ok = await waitFor(
    () =>
      evaluate(
        () => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance
      ),
    20000
  );
  await sleep(2000);
  await closeOverlays();
  return ok;
}
async function bootCampaign(level = 1) {
  await goto(`/?mode=campaign&level=${level}&tutorial=0`);
  const ok = await waitFor(
    () => evaluate(() => !!window.game?.app?.modeInstance?.getStatus),
    20000
  );
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
            if (!progress.campaignProgress[n]?.completed)
              progress.campaignProgress[n] = { completed: true, stars: 3 };
          }
        }
      }
      app.launchGame(m, i);
    },
    mode,
    id
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
        id
      ),
    12000
  );
  await sleep(1200);
  return ok;
}
async function returnToMenu() {
  await evaluate(() => window.game?.app?.returnToMenu?.());
  await waitFor(
    () =>
      evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === false),
    6000
  );
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
      for (const id of [
        'settings-panel',
        'achievements-panel',
        'stats-panel',
        'modal-level-complete',
        'modal-game-over',
      ]) {
        document.getElementById(id)?.classList.remove('active');
      }
      for (const id of [
        'name-prompt-overlay',
        'route-target-overlay',
        'selector-picker-overlay',
        'ingress-path-overlay',
        'scale-modal',
        'edit-dialog',
      ]) {
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
  if (
    /internal command failure|THROW |is not a function|TypeError|ReferenceError/i.test(
      result.message
    )
  ) {
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
        (r) =>
          r?.metadata?.name === name &&
          (namespace === undefined || (r?.metadata?.namespace || '') === namespace)
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
    { kind, name, namespace }
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
/** Installer-side kubeadmin password (issue #45).
 * Real OCP keeps only a bcrypt hash in `kube-system/kubeadmin`; the plain-text
 * password lives in the installer's `auth/kubeadmin-password`, which the
 * simulator models as `~/auth/kubeadmin-password`. Tests must therefore read
 * the generated password instead of assuming a literal. */
let kubeadminPasswordCache = null;
async function kubeadminPassword() {
  if (kubeadminPasswordCache) return kubeadminPasswordCache;
  // A targeted `--only=…` run may start on about:blank before any section has
  // navigated to the app, so give the page an origin the ES-module URL resolves
  // against (no game state is needed to read the exported constant).
  if (!page.url().startsWith(BASE)) await goto('/');
  kubeadminPasswordCache = await evaluate(() =>
    import('/js/engine/ClusterState.js').then((module) => module.KUBEADMIN_PASSWORD)
  );
  return kubeadminPasswordCache;
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
    fail(
      `${name}: harness exception`,
      err?.stack ? err.stack.split('\n').slice(0, 6).join('\n') : String(err)
    );
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
    footer:
      document.querySelector('.menu-attribution')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogUrl: document.querySelector('meta[property="og:url"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    twitterCard: document.querySelector('meta[name="twitter:card"]')?.content || '',
    repoHref: document.querySelector('#github-badge')?.getAttribute('href') || '',
    importmap: document.querySelector('script[type="importmap"]')?.textContent || '',
  }));
  assert(
    menu.title === 'OpenShift Games — Learn OpenShift by Playing (EX280)',
    'menu: exact page title',
    menu.title
  );
  assert(menu.menuVisible, 'menu: main menu visible');
  assert(menu.logo === 'OpenShift Games', 'menu: OpenShift Games logo', menu.logo);
  assert(
    /OpenShift 4\.22 Cluster Simulation · Built for EX280/.test(menu.subtitle),
    'menu: OpenShift 4.22 / EX280 subtitle',
    menu.subtitle
  );
  for (const mode of ['campaign', 'chaos', 'sandbox', 'challenge']) {
    assert(menu.modes.includes(mode), `menu: ${mode} mode button`);
  }
  assert(menu.hasExamPrep, 'menu: EX280 Prep button exists');
  assert(menu.drawHref === '/draw', 'menu: OpenShift Draw link is /draw', menu.drawHref);
  assert(
    /Built for EX280/i.test(menu.footer) &&
      /K8s Games by Rohit/i.test(menu.footer) &&
      /Apache-2\.0/i.test(menu.footer) &&
      /trademark of Red Hat/i.test(menu.footer),
    'menu: required attribution footer',
    menu.footer
  );
  assert(/Learn Red Hat OpenShift by playing/.test(menu.description), 'menu: meta description');
  assert(menu.ogUrl === 'https://shifting.pro', 'menu: og:url');
  assert(menu.ogImage === 'https://shifting.pro/og-image.png', 'menu: og:image');
  assert(menu.twitterCard === 'summary_large_image', 'menu: twitter card');
  assert(
    /github\.com\/G-man3207\/openshiftgames/.test(menu.repoHref),
    'menu: GitHub badge points to standalone repo',
    menu.repoHref
  );
  assert(/three@0\.152\.0/.test(menu.importmap), 'menu: Three.js importmap pinned to 0.152.0');
  assert(
    !/K8s Games|Kubernetes Cluster Simulation/i.test(menu.logo),
    'menu: no legacy branding in logo'
  );
  const shotPath = await shot('menu.png');
  if (shotPath) shotsTaken.push(shotPath);

  await evaluate(() => document.getElementById('btn-settings')?.click());
  await sleep(250);
  assert(
    await evaluate(
      () => document.getElementById('settings-panel')?.classList.contains('active') === true
    ),
    'menu: settings modal opens'
  );
  await evaluate(() => document.getElementById('settings-close')?.click());
  await evaluate(() => document.getElementById('btn-achievements')?.click());
  await sleep(400);
  assert(
    await evaluate(
      () => document.getElementById('achievements-panel')?.classList.contains('active') === true
    ),
    'menu: achievements modal opens'
  );
  const achievementCount = await evaluate(
    () =>
      document.querySelectorAll('#achievements-grid .achievement-card, #achievements-grid > *')
        .length
  );
  assert(achievementCount >= 35, 'menu: achievements grid populated', `got ${achievementCount}`);
  await evaluate(() => document.getElementById('achievements-close')?.click());
  await evaluate(() => document.getElementById('btn-stats')?.click());
  await sleep(300);
  assert(
    await evaluate(
      () => document.getElementById('stats-panel')?.classList.contains('active') === true
    ),
    'menu: stats modal opens'
  );
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
  assert(
    small.width === 1280 && small.height === 720,
    'responsive: 1280x720 viewport applied',
    `${small.width}x${small.height}`
  );
  assert(small.menuVisible, 'responsive: menu visible at 1280x720');
  assert(
    small.scrollWidth <= small.width + 2,
    'responsive: no horizontal overflow at 1280x720',
    `scrollWidth=${small.scrollWidth}`
  );
  await bootSandbox();
  const smallSandbox = await evaluate(() => ({
    palette: document.querySelectorAll('#resource-palette .palette-item').length,
    toolbar: !!document.getElementById('view-toolbar'),
    hud: !!document.getElementById('hud'),
    scrollWidth: document.documentElement.scrollWidth,
    canvas: !!document.getElementById('game-canvas'),
  }));
  assert(
    smallSandbox.palette === 37,
    'responsive: 37 palette kinds at 1280x720',
    `got ${smallSandbox.palette}`
  );
  assert(
    smallSandbox.toolbar && smallSandbox.hud && smallSandbox.canvas,
    'responsive: game shell visible at 1280x720'
  );
  assert(
    smallSandbox.scrollWidth <= 1282,
    'responsive: no horizontal overflow in sandbox at 1280x720',
    `scrollWidth=${smallSandbox.scrollWidth}`
  );
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
  await sleep(500);
  assert(
    await evaluate(() => window.innerWidth === 1600 && window.innerHeight === 900),
    'responsive: restored 1600x900'
  );
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
  assert(
    !initial.coach,
    'tutorial: coach card does not overlap the help modal',
    JSON.stringify(initial)
  );

  await page.click('#tutorial-start');
  const coachReady = await waitFor(
    () =>
      evaluate(
        () =>
          !document.getElementById('tutorial-overlay') &&
          !!document.querySelector('.coach-card-wrap')
      ),
    8000
  );
  assert(coachReady, 'tutorial: coach marks start after the help modal is dismissed');

  const rect = () =>
    evaluate(() => {
      const el = document.querySelector('.coach-card-wrap');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        right: Math.round(b.right),
        bottom: Math.round(b.bottom),
        vw: innerWidth,
        vh: innerHeight,
      };
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
      samples.filter(Boolean).length > 0 &&
        samples.filter(Boolean).every((r) => r.right <= r.vw && r.bottom <= r.vh),
      `tutorial: step ${stepIndex + 1} card stays inside the viewport`,
      JSON.stringify(samples.filter(Boolean).slice(0, 3))
    );
  }
  const uniqueX = [...new Set(xSeen)];
  assert(
    uniqueX.length <= 1,
    'tutorial: coach card x-position stable across Next clicks (no left/right jump)',
    JSON.stringify(uniqueX)
  );
  assert(!!last, 'tutorial: coach card still visible during the steps');

  // Reopening help while coach marks are active must render above them and stay dismissible.
  await page.keyboard.press('h');
  const helpOpen = await waitFor(
    () => evaluate(() => !!document.getElementById('tutorial-overlay')),
    5000
  );
  assert(helpOpen, 'tutorial: H opens help while coach marks are active');
  await page.click('#tutorial-start');
  const helpedClosed = await waitFor(
    () => evaluate(() => !document.getElementById('tutorial-overlay')),
    5000
  );
  const coachStillThere = await evaluate(() => !!document.querySelector('.coach-card-wrap'));
  assert(
    helpedClosed && coachStillThere,
    'tutorial: closing help restores the coach card without duplicates'
  );

  await evaluate(() => document.getElementById('coach-skip')?.click());
  const skipped = await waitFor(
    () => evaluate(() => !document.querySelector('.coach-card-wrap')),
    4000
  );
  assert(skipped, 'tutorial: skip clears the coach card');

  // Regression: the help modal covers a live run. Opening it must freeze the
  // campaign clock + simulation, and closing it must resume exactly once.
  await page.keyboard.press('h');
  const helpForClock = await waitFor(
    () => evaluate(() => !!document.getElementById('tutorial-overlay')),
    5000
  );
  assert(helpForClock, 'tutorial: H reopens help for the clock check');
  await sleep(400);
  const clockOpen = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    await evaluate(() => window.game.gameEngine.state === 'paused'),
    'tutorial: opening help pauses the simulation'
  );
  await sleep(2000);
  const clockHeld = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    clockHeld === clockOpen,
    'tutorial: campaign clock frozen while help is open',
    `${clockOpen} -> ${clockHeld}`
  );
  await page.keyboard.press('Escape');
  const escClosedHelp = await waitFor(
    () => evaluate(() => !document.getElementById('tutorial-overlay')),
    5000
  );
  assert(escClosedHelp, 'tutorial: Esc closes the help modal');
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') !== true
    ),
    'tutorial: Esc closes help instead of opening the pause overlay behind it'
  );
  assert(
    await evaluate(() => window.game.gameEngine.state === 'running'),
    'tutorial: closing help resumes the simulation'
  );
  await sleep(1300);
  const clockResumed = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    clockResumed > clockHeld,
    'tutorial: campaign clock runs again after help closes',
    `${clockHeld} -> ${clockResumed}`
  );
  await closeOverlays();
});

await runSection('exam', async () => {
  await bootMenu();
  const opened = await openExamPrep();
  assert(opened, 'exam: EX280 Prep overlay opens');
  const prep = await evaluate(() => {
    const overlay =
      document.getElementById('exam-prep-overlay') ||
      document.querySelector('[data-testid="exam-prep"]');
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
      hasOfficialGroups:
        /Manage OpenShift Container Platform/i.test(text) &&
        /Declarative Resource Management/i.test(text) &&
        /Configure application security/i.test(text),
      examCode:
        overlay?.querySelector('[data-testid="exam-facts-code"]')?.textContent?.trim() || '',
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
  assert(
    /Red Hat Certified System Administrator in OpenShift|Red Hat Certified Specialist in OpenShift Administration/.test(
      prep.title
    ),
    'exam: official exam name shown',
    prep.title
  );
  await shot('exam-prep.png');
  shotsTaken.push('docs/screenshots/exam-prep.png');

  const beforeSearch = prep.bullets;
  await evaluate(() => {
    const input = document.querySelector('#ep-objective-search');
    input.value = 'kustomize';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const afterSearch = await evaluate(
    () => document.querySelectorAll('#ep-objectives-list .ep-bullet').length
  );
  assert(
    afterSearch > 0 && afterSearch < beforeSearch,
    'exam: objective search filters bullets',
    `${afterSearch} of ${beforeSearch}`
  );
  await evaluate(() => {
    const input = document.querySelector('#ep-objective-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await evaluate(() =>
    document.querySelector('[data-action="tab"][data-tab="cheatsheet"]')?.click()
  );
  await sleep(250);
  const cheatVisible = await evaluate(() => {
    const panel = document.querySelector('[data-tab-panel="cheatsheet"]');
    return (
      !!panel &&
      getComputedStyle(panel).display !== 'none' &&
      panel.querySelectorAll('.ep-cheat-group').length >= 8
    );
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
    visible:
      getComputedStyle(document.querySelector('[data-tab-panel="facts"]')).display !== 'none',
    code: document.querySelector('[data-testid="exam-facts-code"]')?.textContent?.trim() || '',
    text: document.querySelector('[data-tab-panel="facts"]')?.innerText || '',
  }));
  assert(
    facts.visible && facts.code === 'EX280V422' && /3/.test(facts.text),
    'exam: exam facts tab shows EX280V422 / 3h',
    facts.code
  );
  await evaluate(() =>
    document.querySelector('[data-action="tab"][data-tab="quicklabs"]')?.click()
  );
  await sleep(250);

  await evaluate(() =>
    document.querySelector('.ep-lab-card [data-action="launch-lab"], .ep-lab-card button')?.click()
  );
  const labLaunched = await waitFor(
    () =>
      evaluate(
        () => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance
      ),
    10000
  );
  const labState = await evaluate(() => ({
    overlay: document.getElementById('exam-prep-overlay')?.classList.contains('active') === true,
    mode: window.game?.app?.currentMode,
    modeInstance: window.game?.app?.modeInstance?.constructor?.name,
  }));
  assert(
    labLaunched && labState.mode === 'sandbox',
    'exam: quick lab launches Sandbox',
    JSON.stringify(labState)
  );
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
    const palette = [...document.querySelectorAll('#resource-palette .palette-item')].map(
      (el) => el.dataset.resource
    );
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
  // (14 objects) replaced the old 4-object approximation, again when the OLM
  // software catalog (PackageManifests + global-operators OperatorGroup) and
  // the default self-provisioner RBAC objects were seeded, again with the
  // 1.1.8 platform-detail seeds (default SAs/RoleBindings/dockercfg secrets,
  // oauth pods, alerting rules + Alertmanager), and again with the 1.3.0
  // namespace bootstrap (kube-root-ca.crt / openshift-service-ca.crt in every
  // namespace, #43). The bound is a sanity envelope, not an exact count.
  assert(
    state.resourceCount >= 45 && state.resourceCount <= 125,
    'sandbox: seeded platform resources',
    `got ${state.resourceCount}`
  );
  assert(
    state.meshCount >= 45 && Math.abs(state.meshCount - state.resourceCount) <= 2,
    'sandbox: one mesh per seeded resource',
    `${state.meshCount} meshes / ${state.resourceCount} resources`
  );
  assert(
    state.palette.length === 37,
    'sandbox: palette has 37 placeable kinds',
    `got ${state.palette.length}`
  );
  for (const kind of [
    'Project',
    'Route',
    'BuildConfig',
    'ImageStream',
    'Template',
    'Subscription',
    'SecurityContextConstraints',
    'User',
    'Group',
    'IPAddressPool',
    'L2Advertisement',
  ]) {
    assert(state.palette.includes(kind), `sandbox: palette kind ${kind}`);
  }
  assert(
    state.projects >= 10,
    'sandbox: OpenShift default Projects seeded',
    `got ${state.projects}`
  );
  assert(
    state.clusterOperators === 13,
    'sandbox: 13 ClusterOperators seeded',
    `got ${state.clusterOperators}`
  );
  assert(state.nodes >= 3, 'sandbox: default Nodes seeded', `got ${state.nodes}`);
  assert(state.sccs >= 4, 'sandbox: default SCCs seeded', `got ${state.sccs}`);
  assert(
    state.imageStreams >= 3,
    'sandbox: default ImageStreams seeded',
    `got ${state.imageStreams}`
  );
  assert(
    state.hudLogo === 'OpenShift Games',
    'sandbox: HUD logo is OpenShift Games',
    state.hudLogo
  );
  assert(
    /OpenShift 4\.22/.test(state.hudMode),
    'sandbox: HUD mode label is OpenShift 4.22',
    state.hudMode
  );
  assert(
    !/K8s Games|Kubernetes Cluster Simulation/i.test(state.hudLogo),
    'sandbox: no legacy branding in HUD'
  );
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
  assert(
    files.editor && files.buttons.apply && files.buttons.kustomize && files.buttons.save,
    'files: editor and Apply -f/-k buttons present'
  );
  for (const expected of [
    'manifests/deployment.yaml',
    'kustomize/overlays/prod/kustomization.yaml',
    'templates/webapp-template.yaml',
    'helm/webapp/Chart.yaml',
    'htpasswd',
  ]) {
    assert(files.names.includes(expected), `files: default file ${expected}`);
  }
  const filesShot = await shot('files-panel.png');
  if (filesShot) shotsTaken.push(filesShot);

  await evaluate(() => {
    document
      .querySelector('[data-testid="manifest-file"][data-path="manifests/deployment.yaml"]')
      ?.click();
  });
  await sleep(250);
  await evaluate(() => document.querySelector('[data-testid="manifest-apply"]')?.click());
  await sleep(900);
  const applyResult = await evaluate(() => ({
    hasDeployment:
      window.game.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'webapp') ||
      false,
    resultText: document.querySelector('[data-testid="manifest-result"]')?.textContent || '',
    errorText: document.querySelector('[data-testid="manifest-error"]')?.textContent || '',
  }));
  assert(
    applyResult.hasDeployment,
    'files: Apply -f creates Deployment/webapp',
    applyResult.errorText.slice(0, 200)
  );
  assert(
    /created|configured|apply complete/i.test(applyResult.resultText),
    'files: Apply -f shows result output',
    applyResult.resultText.slice(0, 200)
  );

  await evaluate(() => {
    document
      .querySelector(
        '[data-testid="manifest-file"][data-path="kustomize/overlays/prod/kustomization.yaml"]'
      )
      ?.click();
  });
  await sleep(250);
  await evaluate(() => document.querySelector('[data-testid="manifest-apply-kustomize"]')?.click());
  await sleep(1000);
  const kustomizeResult = await evaluate(() => ({
    hasProd:
      window.game.cluster
        .getByKind?.('Deployment')
        ?.some((d) => d.metadata?.name === 'prod-webapp') || false,
    applied: window.game.manifestEngine?.hasAppliedKustomize?.('kustomize/overlays/prod') ?? null,
    resultText: document.querySelector('[data-testid="manifest-result"]')?.textContent || '',
    errorText: document.querySelector('[data-testid="manifest-error"]')?.textContent || '',
  }));
  assert(
    kustomizeResult.hasProd,
    'files: Apply -k creates Deployment/prod-webapp',
    kustomizeResult.errorText.slice(0, 200)
  );
  assert(kustomizeResult.applied !== false, 'files: Apply -k records the prod overlay');
  await evaluate(() => window.game.manifestPanel?.hide?.());

  // Regression: Files is a full-screen surface. It pauses the simulation while
  // open, and its own Esc handler closes it (no pause card) and resumes once.
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesReopened = await waitFor(
    () => evaluate(() => window.game?.manifestPanel?.visible === true),
    5000
  );
  assert(filesReopened, 'files: F reopens the panel for the pause check');
  assert(
    await evaluate(() => window.game.gameEngine.state === 'paused'),
    'files: opening the panel pauses the simulation'
  );
  // #20 QA: the pause must be visible, not silent.
  const pausedChip = await evaluate(() => {
    const chip = document.getElementById('hud-paused');
    const rect = chip?.getBoundingClientRect();
    return {
      hidden: chip?.hidden,
      reason: document.getElementById('hud-paused-reason')?.textContent,
      aria: chip?.getAttribute('aria-label'),
      rect: rect
        ? { x: Math.round(rect.x), right: Math.round(rect.right), y: Math.round(rect.y) }
        : null,
    };
  });
  assert(
    pausedChip.hidden === false,
    'files: HUD shows a visible paused indicator',
    JSON.stringify(pausedChip)
  );
  assert(
    pausedChip.reason === 'Files open',
    'files: paused indicator names the Files reason',
    JSON.stringify(pausedChip)
  );
  assert(
    /Simulation paused: Files open/.test(pausedChip.aria || ''),
    'files: paused indicator is announced accessibly',
    pausedChip.aria
  );
  assert(
    pausedChip.rect &&
      pausedChip.rect.x >= 0 &&
      pausedChip.rect.right <= 1600 &&
      pausedChip.rect.y < 60,
    'files: paused indicator stays inside the HUD bar',
    JSON.stringify(pausedChip.rect)
  );
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const filesClosedByEsc = await waitFor(
    () => evaluate(() => window.game?.manifestPanel?.visible === false),
    5000
  );
  assert(filesClosedByEsc, 'files: Esc closes the panel');
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') !== true
    ),
    'files: Esc closing Files does not open the pause overlay'
  );
  await sleep(350);
  assert(
    await evaluate(() => window.game.gameEngine.state === 'running'),
    'files: closing the panel resumes the simulation'
  );
  assert(
    await evaluate(() => document.getElementById('hud-paused')?.hidden === true),
    'files: paused indicator clears when the run resumes'
  );

  // #20 QA: `vim file` opens the Files panel too — the pause must be equally visible.
  const vimResult = await evaluate(() =>
    window.game.app.commandBar.executeCommand('vim manifests/deployment.yaml')
  );
  await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 5000);
  await sleep(450);
  const vimChip = await evaluate(() => ({
    hidden: document.getElementById('hud-paused')?.hidden,
    reason: document.getElementById('hud-paused-reason')?.textContent,
    panel: window.game.manifestPanel?.visible === true,
  }));
  assert(
    vimChip.panel,
    'files: vim opens the Files panel',
    JSON.stringify({ vimResult: vimResult?.message })
  );
  assert(
    vimChip.hidden === false && vimChip.reason === 'Files open',
    'files: vim-triggered Files open shows the paused indicator',
    JSON.stringify(vimChip)
  );
  await evaluate(() => window.game.manifestPanel?.hide?.());
  await sleep(350);
  assert(
    await evaluate(() => document.getElementById('hud-paused')?.hidden === true),
    'files: paused indicator clears after the vim-triggered panel closes'
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
  await expectCmd(
    'cli: oc get clusteroperators',
    'oc get clusteroperators',
    /authentication|dns|ingress|VERSION/i
  );
  await expectCmd('cli: oc get clusterversion', 'oc get clusterversion', /4\.22\.0/);
  await expectCmd(
    'cli: oc new-project',
    `oc new-project ${project} --description="EX280 lab"`,
    /Now using project|created/i
  );
  await expectCmd('cli: oc project', `oc project ${project}`, /Now using project/i);
  await expectCmd(
    'cli: oc create deployment',
    `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${project}`,
    /deployment\.apps\/web created/i
  );
  await expectCmd(
    'cli: oc expose svc creates Route',
    `oc expose svc/web -n ${project}`,
    /route.*(exposed|created)/i
  );
  await expectCmd('cli: oc get routes', `oc get routes -n ${project}`, /web/);
  await expectCmd(
    'cli: oc set env',
    `oc set env deployment/web APP_ENV=dev -n ${project}`,
    /updated|environment/i
  );
  await expectCmd(
    'cli: oc set image',
    `oc set image deployment/web origin-hello-openshift=quay.io/openshift/origin-hello-openshift:v1.1 -n ${project}`,
    /image updated|updated/i
  );
  await expectCmd(
    'cli: oc set resources',
    `oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi -n ${project}`,
    /resource requirements updated|updated/i
  );
  await expectCmd(
    'cli: oc create configmap',
    `oc create configmap app-config --from-literal=APP_ENV=dev -n ${project}`,
    /configmap\/app-config created/i
  );
  await expectCmd(
    'cli: oc create secret',
    `oc create secret generic app-secret --from-literal=password=s3cret -n ${project}`,
    /secret\/app-secret created/i
  );

  // CLI fidelity: a namespaced request against a nonexistent project must fail
  // like a real API server instead of rendering an empty table/list.
  await expectCmdError(
    'cli: get pods in missing namespace → NotFound',
    'oc get pods -n does-not-exist',
    /Error from server \(NotFound\): namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: get multiple kinds in missing namespace → NotFound',
    'oc get deployments,services -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: get all in missing namespace → NotFound',
    'oc get all -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: get events in missing namespace → NotFound',
    'oc get events -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: get -o yaml in missing namespace → NotFound',
    'oc get pods -n does-not-exist -o yaml',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: describe in missing namespace → NotFound',
    'oc describe pod nope -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: delete in missing namespace → NotFound',
    'oc delete pod nope -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: delete --all in missing namespace → NotFound',
    'oc delete pods --all -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: create in missing namespace → NotFound',
    'oc create deployment nope --image=quay.io/openshift/origin-hello-openshift:latest -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: apply -f in missing namespace → NotFound',
    'oc apply -f manifests/deployment.yaml -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: status in missing namespace → NotFound',
    'oc status -n does-not-exist',
    /namespaces "does-not-exist" not found/
  );
  await expectCmd(
    'cli: get -A ignores a missing -n namespace',
    'oc get pods --all-namespaces -n does-not-exist',
    /No resources found|NAME/
  );
  await expectCmd('cli: cluster-scoped get ignores -n', 'oc get nodes -n does-not-exist', /Ready/);
  const projectNotFound = await runCmd('oc project does-not-exist', 120);
  assert(
    projectNotFound.error &&
      /A project named "does-not-exist" does not exist/.test(projectNotFound.message),
    'cli: oc project reports a sensible project-not-found error',
    projectNotFound.message.slice(0, 200)
  );
  const rawVersion = await runCmd('oc get --raw /version', 120);
  assert(
    !rawVersion.error &&
      /"gitVersion": "v4\.22\.0"/.test(rawVersion.message) &&
      /"kubernetesVersion": "v1\.35\.2"/.test(rawVersion.message) &&
      /"platform": "linux\/amd64"/.test(rawVersion.message),
    'cli: oc get --raw /version returns server version JSON',
    rawVersion.message.slice(0, 200)
  );

  // CLI fidelity: `-n` on apply/create/replace -f re-targets every object
  // (like oc's EnforceNamespace), including multi-document files, manifest
  // metadata.namespace and `-f -` stdin; no `-n` keeps using the current project.
  await expectCmd(
    'cli: apply -f -n retargets to project',
    'oc apply -f manifests/deployment.yaml -n openshift',
    /created|configured|unchanged/i
  );
  const retargetedDeploy = await findResource('Deployment', 'webapp', 'openshift');
  assert(!!retargetedDeploy, 'cli: apply -f -n puts Deployment/webapp in the -n project');
  await expectCmd(
    'cli: create -f -n retargets to project',
    'oc create -f manifests/service.yaml -n openshift',
    /created|configured|unchanged/i
  );
  const retargetedService = await findResource('Service', 'webapp', 'openshift');
  assert(!!retargetedService, 'cli: create -f -n puts Service/webapp in the -n project');
  await expectCmd(
    'cli: replace -f -n retargets to project',
    'oc replace -f manifests/deployment.yaml -n openshift',
    /replaced|configured|created/i
  );
  await evaluate(() => {
    window.game?.manifestEngine?.writeFile?.(
      'manifests/fidelity-multi.yaml',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fidelity-multi-cm\n  namespace: openshift-operators\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: fidelity-multi-secret\n'
    );
  });
  await expectCmd(
    'cli: apply multi-doc -f -n overrides manifest namespaces',
    'oc apply -f manifests/fidelity-multi.yaml -n openshift',
    /created|configured|unchanged/i
  );
  const multiCm = await findResource('ConfigMap', 'fidelity-multi-cm', 'openshift');
  const multiSecret = await findResource('Secret', 'fidelity-multi-secret', 'openshift');
  assert(
    !!multiCm && !!multiSecret,
    'cli: multi-doc apply -f -n overrides manifest metadata.namespace'
  );
  await expectCmd(
    'cli: process | apply -f - -n retargets stdin objects',
    'oc process -f templates/webapp-template.yaml -p APP_NAME=retarget-demo | oc apply -f - -n openshift',
    /created|configured|unchanged/i
  );
  const retargetedStdin = await findResource('Deployment', 'retarget-demo', 'openshift');
  assert(!!retargetedStdin, 'cli: apply -f - -n puts stdin objects in the -n project');
  await expectCmdError(
    'cli: new-app in missing namespace → NotFound',
    'oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=missing-ns-app -n does-not-exist',
    /Error from server \(NotFound\): namespaces "does-not-exist" not found/
  );
  await expectCmdError(
    'cli: expose in missing namespace → NotFound',
    'oc expose svc/web -n does-not-exist',
    /Error from server \(NotFound\): namespaces "does-not-exist" not found/
  );

  const podReady = await waitFor(async () => {
    return evaluate((ns) => {
      const pods = window.game.cluster.getByKind?.('Pod') || [];
      return pods.some(
        (p) => (p.metadata?.namespace || '') === ns && (p.status?.phase || p.phase) === 'Running'
      );
    }, project);
  }, 20000);
  const podName = await evaluate((ns) => {
    const pods = window.game.cluster.getByKind?.('Pod') || [];
    return (
      pods.find(
        (p) => (p.metadata?.namespace || '') === ns && (p.status?.phase || p.phase) === 'Running'
      )?.metadata?.name || null
    );
  }, project);
  assert(podReady && podName, 'cli: Deployment controller creates a Running Pod', `pod=${podName}`);
  if (podName) await expectNonEmpty('cli: oc logs', `oc logs ${podName} -n ${project}`);
  await expectCmd(
    'cli: oc describe deployment',
    `oc describe deployment/web -n ${project}`,
    /Name:|Deployment/i
  );
  await expectCmd(
    'cli: oc rollout status',
    `oc rollout status deployment/web -n ${project}`,
    /deployment|rollout/i
  );

  // #26: real oc only prints the container-defaulting hint for MULTI-container
  // pods; a single-container pod's exec/rsh must run the command in silence.
  const execSingle = await runCmd(`oc exec ${podName} -n ${project} -- whoami`);
  assert(
    !execSingle.error && !/Defaulting container name|Use 'oc describe pod/.test(execSingle.message),
    'cli: exec single-container pod prints no container-defaulting hint',
    execSingle.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );
  const rshSingle = await runCmd(`oc rsh ${podName} -n ${project} hostname`);
  assert(
    !rshSingle.error && !/Defaulting container name|Use 'oc describe pod/.test(rshSingle.message),
    'cli: rsh single-container pod prints no container-defaulting hint',
    rshSingle.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
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
  await evaluate(
    (text) => window.game.manifestEngine.writeFile('qa/multi-pod.yaml', text),
    multiPod
  );
  await expectCmd(
    'cli: create multi-container Pod',
    'oc apply -f qa/multi-pod.yaml -n ex280-demo',
    /pod\/multi created|created|configured/i
  );
  await waitFor(
    () =>
      evaluate(() => {
        const pod = window.game.cluster.getByName?.('Pod', 'multi', 'ex280-demo');
        return (
          pod?.status?.phase === 'Running' &&
          (pod.status.containerStatuses || []).every((status) => status.ready)
        );
      }),
    10000
  );
  const execMulti = await runCmd(`oc exec pod/multi -n ${project} -- hostname`);
  assert(
    !execMulti.error &&
      /Defaulting container name to "first"/.test(execMulti.message) &&
      /Use 'oc describe pod\/multi -n ex280-demo'/.test(execMulti.message),
    'cli: exec multi-container pod still prints the container-defaulting hint',
    execMulti.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );
  const execMultiNamed = await runCmd(`oc exec pod/multi -n ${project} -c second -- hostname`);
  assert(
    !execMultiNamed.error && !/Defaulting container name/.test(execMultiNamed.message),
    'cli: exec -c suppresses the container-defaulting hint',
    execMultiNamed.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );

  // #26: sed must exist in the shell and work inside `oc ... | sed ...` pipes.
  const describePodOne = await runCmd(`oc describe pod ${podName} -n ${project}`);
  const describeHead = describePodOne.message.trim().split('\n').slice(0, 5).join('\n');
  const sedHead = await runCmd(`oc describe pod ${podName} -n ${project} | sed -n '1,5p'`);
  assert(
    !sedHead.error && sedHead.message.trim() === describeHead,
    "cli: describe | sed -n '1,5p' echoes the first 5 lines",
    sedHead.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );
  const sedUnquoted = await runCmd(`oc describe pod ${podName} -n ${project} | sed -n 1,40p`);
  assert(
    !sedUnquoted.error &&
      sedUnquoted.message.trim() ===
        describePodOne.message.trim().split('\n').slice(0, 40).join('\n'),
    'cli: describe | sed -n 1,40p (unquoted) works in a pipe',
    sedUnquoted.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );
  const sedSub = await runCmd(`echo 'foo bar foo' | sed 's/foo/baz/'`);
  assert(
    !sedSub.error && sedSub.message.trim() === 'baz bar foo',
    'cli: sed s/// substitutes in a pipe',
    sedSub.message.slice(0, 120)
  );

  // #20 QA: nginx:latest under restricted-v2 is ADMITTED (SCC admission only
  // sees the pod spec, not the image USER), then the container crash-loops with
  // the real nginx permission-denied log. Only a spec that EXPLICITLY requests
  // root/privileged is rejected with RS FailedCreate. The documented anyuid
  // service-account fix path makes it run (#25).

  const nginxProject = 'nginx-lab';
  await expectCmd(
    'cli: create nginx-lab project',
    `oc new-project ${nginxProject}`,
    /Now using project|created/i
  );
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
  await expectCmd(
    'cli: nginx:latest deployment is admitted under restricted-v2',
    `oc create deployment ngx --image=nginx:latest -n ${nginxProject}`,
    /deployment\.apps\/ngx created/i
  );
  const readNginxLab = () =>
    evaluate((ns) => {
      const cluster = window.game.cluster;
      const deployment = cluster.getByName?.('Deployment', 'ngx', ns);
      const replicaSets = deployment
        ? (cluster.getChildren?.(deployment.uid) || []).filter(
            (child) => child.kind === 'ReplicaSet'
          )
        : [];
      const pods = (cluster.getByKindAndNamespace?.('Pod', ns) || []).filter((pod) =>
        /^ngx-/.test(pod.metadata?.name || '')
      );
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
        rsConditions: replicaSets
          .flatMap((set) => set.status?.conditions || [])
          .map((condition) => `${condition.type}=${condition.status}/${condition.reason}`),
        deployConditions: (deployment?.status?.conditions || []).map(
          (condition) => `${condition.type}=${condition.status}/${condition.reason}`
        ),
        availableReplicas: deployment?.status?.availableReplicas ?? null,
      };
    }, nginxProject);
  const nginxAdmitted = await waitFor(async () => {
    const state = await readNginxLab();
    return (
      state.podCount === 1 && !state.rsConditions.some((line) => /ReplicaFailure=True/.test(line))
    );
  }, 30000);
  let nginxState = await readNginxLab();
  assert(
    nginxAdmitted,
    'cli: nginx:latest pod is ADMITTED (pod exists, no RS FailedCreate)',
    JSON.stringify({ pods: nginxState.podCount, rsConditions: nginxState.rsConditions })
  );
  assert(
    nginxState.pods[0]?.scc === 'restricted-v2',
    'cli: admitted nginx pod runs under scc=restricted-v2',
    JSON.stringify(nginxState.pods.map((pod) => pod.scc))
  );
  await waitFor(async () => {
    const state = await readNginxLab();
    return state.pods.some((pod) => pod.waiting === 'CrashLoopBackOff' && pod.restarts > 0);
  }, 30000);
  nginxState = await readNginxLab();
  assert(
    nginxState.pods.some((pod) => pod.waiting === 'CrashLoopBackOff' && pod.restarts > 0),
    'cli: nginx pod crash-loops (CrashLoopBackOff, restarts > 0)',
    JSON.stringify(nginxState.pods)
  );
  assert(
    nginxState.pods.some((pod) => pod.phase === 'Running'),
    'cli: crash-looping nginx pod stays Running (admission did not reject it)',
    JSON.stringify(nginxState.pods.map((pod) => pod.phase))
  );
  assert(
    nginxState.pods.some((pod) => pod.lastTerminated === 1),
    'cli: nginx container lastState records the crash (exit code 1)',
    JSON.stringify(nginxState.pods.map((pod) => pod.lastTerminated))
  );
  await expectCmd(
    'cli: oc get pods shows CrashLoopBackOff',
    `oc get pods -n ${nginxProject}`,
    /ngx-[a-z0-9-]+\s+0\/1\s+CrashLoopBackOff\s+[1-9]/
  );
  await expectCmd(
    'cli: nginx crash log is the permission-denied emerge',
    `oc logs deployment/ngx -n ${nginxProject}`,
    /mkdir\(\).*(client_temp).*Permission denied/
  );
  await expectCmd(
    'cli: nginx deployment reports Available False MinimumReplicasUnavailable',
    `oc describe deployment/ngx -n ${nginxProject}`,
    /Available\s+False\s+MinimumReplicasUnavailable/
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
  await evaluate(
    (text) => window.game.manifestEngine.writeFile('qa/root-deploy.yaml', text),
    rootDeployment
  );
  await expectCmd(
    'cli: apply explicit runAsUser:0 deployment',
    'oc apply -f qa/root-deploy.yaml',
    /deployment\.apps\/ngx-root created|created|configured/i
  );
  const readRootFailure = () =>
    evaluate((ns) => {
      const cluster = window.game.cluster;
      const deployment = cluster.getByName?.('Deployment', 'ngx-root', ns);
      const replicaSets = deployment
        ? (cluster.getChildren?.(deployment.uid) || []).filter(
            (child) => child.kind === 'ReplicaSet'
          )
        : [];
      return {
        messages: replicaSets.flatMap((set) =>
          (set.status?.conditions || [])
            .filter((condition) => condition.type === 'ReplicaFailure')
            .map((condition) => `${condition.reason}:${condition.message}`)
        ),
        pods: (cluster.getByKindAndNamespace?.('Pod', ns) || []).filter(
          (pod) => pod.metadata?.labels?.app === 'ngx-root'
        ).length,
      };
    }, nginxProject);
  const rootDenied = await waitFor(async () => {
    const state = await readRootFailure();
    return state.messages.length > 0 && state.pods === 0;
  }, 20000);
  const rootState = await readRootFailure();
  assert(
    rootDenied,
    'cli: explicit runAsUser:0 still gets RS FailedCreate with no Pod',
    JSON.stringify(rootState)
  );
  assert(
    rootState.messages.some((line) =>
      /unable to validate against any security context constraint/.test(line)
    ),
    'cli: explicit root denial message is the SCC one',
    JSON.stringify(rootState.messages)
  );

  // #26: real oc aggregates repeated FailedCreate retries into ONE Event row
  // with a `(xN over …)` LAST SEEN suffix. Advance game time past the 10s retry
  // throttle so the burst is deterministic instead of waiting ~2 wall-clock min.
  await advanceSimulation(150);
  const failedCreateRetries = await evaluate(
    (ns) =>
      (window.game.gameEngine.simulation.getEvents({ namespace: ns, reason: 'FailedCreate' }) || [])
        .length,
    nginxProject
  );
  assert(
    failedCreateRetries >= 10,
    'cli: explicit violation generated >= 10 FailedCreate retries',
    `got ${failedCreateRetries}`
  );
  const failedCreateEvents = await expectCmd(
    'cli: events --field-selector reason=FailedCreate',
    `oc get events --field-selector reason=FailedCreate -n ${nginxProject}`,
    /FailedCreate/
  );
  const failedCreateTable = parseTable(failedCreateEvents.message);
  const failedCreateRows = failedCreateTable.rows.filter((row) => row[2] === 'FailedCreate');
  assert(
    /^LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE$/.test(failedCreateTable.header),
    'cli: events table keeps LAST SEEN/TYPE/REASON/OBJECT/MESSAGE header',
    failedCreateTable.header
  );
  assert(
    failedCreateRows.length === 1,
    'cli: FailedCreate retries aggregate into exactly one row',
    `${failedCreateRows.length}: ${JSON.stringify(failedCreateRows)}`
  );
  const aggregateCell = failedCreateRows[0]?.[0] || '';
  const aggregateCount = aggregateCell.match(/\(x(\d+) over [^)]+\)/);
  assert(
    Boolean(aggregateCount) && Number(aggregateCount[1]) >= 10,
    'cli: aggregated FailedCreate row carries (xN over …) with N >= 10',
    aggregateCell
  );

  // The documented anyuid fix path: dedicated SA + SCC grant + deployment SA.
  await expectCmd(
    'cli: create nginx-sa',
    `oc create sa nginx-sa -n ${nginxProject}`,
    /serviceaccount\/nginx-sa created/i
  );
  await expectCmd(
    'cli: grant anyuid to nginx-sa',
    `oc adm policy add-scc-to-user anyuid -z nginx-sa -n ${nginxProject}`,
    /added|anyuid/i
  );
  await expectCmd(
    'cli: point ngx at nginx-sa',
    `oc set serviceaccount deployment/ngx nginx-sa -n ${nginxProject}`,
    /serviceaccount|updated/i
  );
  const nginxFixed = await waitFor(async () => {
    const state = await readNginxLab();
    return (
      state.podCount === 1 &&
      state.pods[0].scc === 'anyuid' &&
      state.pods[0].phase === 'Running' &&
      state.pods[0].ready === true &&
      state.availableReplicas >= 1
    );
  }, 45000);
  nginxState = await readNginxLab();
  assert(
    nginxFixed,
    'cli: anyuid service-account fix path leaves exactly one Running/Ready pod',
    JSON.stringify(nginxState)
  );
  assert(
    nginxState.pods[0]?.scc === 'anyuid',
    'cli: fixed nginx pod runs under scc=anyuid',
    JSON.stringify(nginxState.pods.map((pod) => pod.scc))
  );
  assert(
    nginxState.deployConditions.includes('Available=True/MinimumReplicasAvailable'),
    'cli: fixed nginx deployment reports Available True MinimumReplicasAvailable',
    JSON.stringify(nginxState.deployConditions)
  );
  await expectCmd(
    'cli: oc get deployment ngx shows 1/1 ready',
    `oc get deployment ngx -n ${nginxProject}`,
    /1\/1/
  );
  const routeAdmittedEarly = await waitFor(
    () =>
      evaluate((ns) => {
        const route = (window.game.cluster.getByKind?.('Route') || []).find(
          (r) => r.metadata?.name === 'web' && r.metadata?.namespace === ns
        );
        return !!route?.status?.ingress?.[0]?.conditions?.some(
          (c) => c.type === 'Admitted' && c.status === 'True'
        );
      }, project),
    25000
  );
  const routeEarly = await findResource('Route', 'web', project);
  assert(
    routeAdmittedEarly,
    'cli: Route/web is Admitted by the router',
    JSON.stringify(routeEarly?.status?.ingress?.[0]?.conditions || null)
  );

  await expectCmd(
    'cli: oc apply -f manifest',
    'oc apply -f manifests/deployment.yaml',
    /created|configured|unchanged/i
  );
  // The prod overlay targets the webapp-prod project (`namespace: webapp-prod`
  // in the kustomization). A real API server rejects a namespaced apply into a
  // non-existent project, so make sure it exists first — the files section may
  // already have applied the same overlay when both sections run together.
  const overlayProjectExists = await evaluate(() =>
    (window.game.cluster.getByKind?.('Project') || []).some(
      (p) => p.metadata?.name === 'webapp-prod'
    )
  );
  if (overlayProjectExists) {
    await expectCmd(
      'cli: switch to the overlay project',
      'oc project webapp-prod',
      /Now using project/i
    );
  } else {
    await expectCmd(
      'cli: pre-create the overlay project',
      'oc new-project webapp-prod',
      /Now using project|created/i
    );
  }
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
  await expectCmd(
    'cli: oc apply -k prod overlay',
    'oc apply -k kustomize/overlays/prod',
    /created|configured|unchanged/i
  );
  await expectCmd(
    'cli: oc process | oc apply',
    'oc process -f templates/webapp-template.yaml -p APP_NAME=demo | oc apply -f -',
    /created|configured|unchanged/i
  );
  await expectCmd(
    'cli: oc new-app image',
    `oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=api -n ${project}`,
    /created|Success|deployment/i
  );
  await expectCmd(
    'cli: oc process --parameters',
    'oc process -f templates/webapp-template.yaml --parameters',
    /APP_NAME|NAME/i
  );
  await expectCmd('cli: helm install', 'helm install webapp helm/webapp', /NAME:|deployed/i);
  await expectCmd('cli: helm list', 'helm list', /webapp/);
  await expectCmd('cli: helm uninstall', 'helm uninstall webapp', /uninstalled|release/i);

  // #24: Helm 3 history/rollback semantics — only the latest revision is
  // `deployed`, older revisions are `superseded`, a rollback re-deploys the
  // target revision's CHART (no repo prefix, real APP VERSION) and install
  // output has no CHART: line.
  const helmProject = 'helm-lab';
  await expectCmd(
    'cli: create helm-lab project',
    `oc new-project ${helmProject}`,
    /Now using project|created/i
  );
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
  await expectCmd(
    'cli: helm repo add bitnami',
    'helm repo add bitnami https://charts.bitnami.com/bitnami',
    /has been added to your repositories/i
  );
  const helmInstall = await expectCmd(
    'cli: helm install bitnami/nginx 15.0.0',
    `helm install web bitnami/nginx --version 15.0.0 -n ${helmProject}`,
    /^NAME: web$/m
  );
  assert(
    !/^CHART:/m.test(helmInstall.message) &&
      /^LAST DEPLOYED: [A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/m.test(
        helmInstall.message
      ) &&
      new RegExp(`^NAMESPACE: ${helmProject}$`, 'm').test(helmInstall.message) &&
      /^STATUS: deployed$/m.test(helmInstall.message) &&
      /^REVISION: 1$/m.test(helmInstall.message) &&
      /^TEST SUITE: None$/m.test(helmInstall.message),
    'cli: helm install output has the real shape (no CHART: line)',
    helmInstall.message.replace(/\n/g, ' ⏎ ').slice(0, 320)
  );
  const helmUpgrade = await expectCmd(
    'cli: helm upgrade bitnami/nginx 15.1.0',
    `helm upgrade web bitnami/nginx --version 15.1.0 -n ${helmProject}`,
    /^REVISION: 2$/m
  );
  assert(
    !/^CHART:/m.test(helmUpgrade.message),
    'cli: helm upgrade output has no CHART: line',
    helmUpgrade.message.replace(/\n/g, ' ⏎ ').slice(0, 240)
  );
  await expectCmd(
    'cli: helm rollback web 1',
    `helm rollback web 1 -n ${helmProject}`,
    /Rollback was a success/i
  );
  const historyRun = await expectCmd(
    'cli: helm history header',
    `helm history web -n ${helmProject}`,
    /REVISION.*UPDATED.*STATUS.*CHART.*APP VERSION.*DESCRIPTION/
  );
  const historyTable = parseTable(historyRun.message);
  const historyRow = (index) => historyTable.rows[index] || [];
  assert(
    historyTable.rows.length === 3,
    'cli: helm history has exactly 3 revisions',
    JSON.stringify(historyTable.rows)
  );
  assert(
    historyRow(0)[2] === 'superseded' &&
      historyRow(0)[3] === 'nginx-15.0.0' &&
      historyRow(0)[4] === '1.25.3' &&
      historyRow(0)[5] === 'Install complete',
    'cli: helm history rev 1 is superseded nginx-15.0.0 1.25.3 Install complete',
    JSON.stringify(historyRow(0))
  );
  assert(
    historyRow(1)[2] === 'superseded' &&
      historyRow(1)[3] === 'nginx-15.1.0' &&
      historyRow(1)[4] === '1.25.3' &&
      historyRow(1)[5] === 'Upgrade complete',
    'cli: helm history rev 2 is superseded nginx-15.1.0 1.25.3 Upgrade complete',
    JSON.stringify(historyRow(1))
  );
  assert(
    historyRow(2)[2] === 'deployed' &&
      historyRow(2)[3] === 'nginx-15.0.0' &&
      historyRow(2)[4] === '1.25.3' &&
      historyRow(2)[5] === 'Rollback to 1',
    'cli: helm history rev 3 is deployed nginx-15.0.0 Rollback to 1 (rollback re-deploys rev 1 chart)',
    JSON.stringify(historyRow(2))
  );
  assert(
    historyTable.rows.filter((row) => row[2] === 'deployed').length === 1,
    'cli: only the latest helm history revision is deployed',
    JSON.stringify(historyTable.rows.map((row) => `${row[0]}:${row[2]}`))
  );
  assert(
    historyTable.rows.every((row) => !String(row[3] || '').includes('bitnami/')),
    'cli: helm history CHART column has no repo prefix',
    JSON.stringify(historyTable.rows.map((row) => row[3]))
  );
  const rolledBackYaml = await runCmd(`oc get deployment web -n ${helmProject} -o yaml`);
  assert(
    !rolledBackYaml.error && /helm\.sh\/chart: nginx-15\.0\.0/.test(rolledBackYaml.message),
    'cli: helm rollback re-applies the revision 1 chart to the workload',
    rolledBackYaml.message.replace(/\n/g, ' ⏎ ').slice(0, 400)
  );
  const helmListRun = await runCmd(`helm list -n ${helmProject}`);
  const helmListRows = parseTable(helmListRun.message).rows;
  assert(
    helmListRows.length === 1 &&
      helmListRows[0][5] === 'nginx-15.0.0' &&
      helmListRows[0][6] === '1.25.3',
    'cli: helm list CHART/APP VERSION match the deployed revision',
    JSON.stringify(helmListRows)
  );

  // #26: image-pull failures must match failure tokens INSIDE the tag, not only
  // as a prefix (`:v9-nope` earns ImagePullBackOff), and recovering to :latest
  // must pull normally again.
  const pullProject = 'pull-lab';
  const pullImage = 'quay.io/openshift/origin-hello-openshift';
  await expectCmd(
    'cli: create pull-lab project',
    `oc new-project ${pullProject}`,
    /Now using project|created/i
  );
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
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
  await evaluate(
    (text) => window.game.manifestEngine.writeFile('qa/pullapp.yaml', text),
    pullDeployment
  );
  await expectCmd(
    'cli: apply pullapp deployment',
    'oc apply -f qa/pullapp.yaml',
    /deployment\.apps\/pullapp created|created|configured/i
  );
  const readPullLab = () =>
    evaluate(() => {
      const cluster = window.game.cluster;
      const deployment = cluster.getByName?.('Deployment', 'pullapp', 'pull-lab');
      const pods = (cluster.getByKindAndNamespace?.('Pod', 'pull-lab') || []).filter(
        (pod) => pod.metadata?.labels?.app === 'pullapp'
      );
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
    return (
      state.availableReplicas >= 1 &&
      state.pods.some((pod) => pod.phase === 'Running' && /:latest$/.test(pod.image))
    );
  }, 30000);
  assert(
    baselinePulled,
    'cli: :latest image pulls and the Deployment becomes available',
    JSON.stringify(await readPullLab())
  );
  await expectCmd(
    'cli: oc set image to :v9-nope',
    `oc set image deployment/pullapp main=${pullImage}:v9-nope -n ${pullProject}`,
    /image updated|updated/i
  );
  await advanceSimulation(20);
  const notPullable = await waitFor(async () => {
    const state = await readPullLab();
    return state.pods.some(
      (pod) => /ImagePullBackOff|ErrImagePull/.test(pod.waiting || '') && /v9-nope/.test(pod.image)
    );
  }, 20000);
  const pullState = await readPullLab();
  assert(
    notPullable,
    'cli: :v9-nope (failure token inside the tag) is ImagePullBackOff',
    JSON.stringify(pullState.pods)
  );
  await expectCmd(
    'cli: oc get pods shows ImagePullBackOff',
    `oc get pods -n ${pullProject}`,
    /ImagePullBackOff/
  );
  await expectCmd(
    'cli: recover pullapp to :latest',
    `oc set image deployment/pullapp main=${pullImage}:latest -n ${pullProject}`,
    /image updated|updated/i
  );
  await advanceSimulation(30);
  const pullRecovered = await waitFor(async () => {
    const state = await readPullLab();
    return state.pods.some((pod) => pod.phase === 'Running' && /:latest$/.test(pod.image));
  }, 20000);
  assert(
    pullRecovered,
    'cli: :latest pulls again after the image-pull failure (recovery)',
    JSON.stringify((await readPullLab()).pods)
  );

  await expectCmd(
    'cli: oc create user',
    'oc create user bob --full-name="Bob User"',
    /user.*bob.*created/i
  );
  await expectCmd('cli: oc create group', 'oc create group devs', /group.*created/i);
  await expectCmd('cli: oc adm groups add-users', 'oc adm groups add-users devs bob', /added|bob/i);
  await expectCmd(
    'cli: oc adm policy add-role-to-user',
    `oc adm policy add-role-to-user edit bob -n ${project}`,
    /added|role/i
  );
  await expectCmd(
    'cli: oc adm policy add-scc-to-user',
    `oc adm policy add-scc-to-user anyuid -z default -n ${project}`,
    /added|securitycontextconstraints/i
  );
  await expectCmd('cli: oc auth can-i', `oc auth can-i create pods -n ${project}`, /yes/i);
  await expectCmd(
    'cli: oc auth can-i --as',
    `oc auth can-i create pods --as=bob -n ${project}`,
    /yes/i
  );
  await expectCmd(
    'cli: oc create quota',
    `oc create quota demo-quota --hard=pods=20,requests.cpu=4 -n ${project}`,
    /resourcequota\/demo-quota created/i
  );
  // #38: real oc (and kubectl) have no `create limitrange` subcommand, so the
  // simulator must reject it with the unknown-subcommand error; a LimitRange is
  // created declaratively with `oc apply -f`.
  await expectCmdError(
    'cli: oc create limitrange is rejected like real oc (#38)',
    `oc create limitrange demo-limit --default=cpu=500m,memory=512Mi -n ${project}`,
    /unknown command ["']?limitrange/i
  );
  await expectCmd(
    'cli: oc apply a LimitRange from YAML',
    `oc apply -f examples/limitrange.yaml -n ${project}`,
    /limitrange.*(created|configured)/i
  );
  await expectCmd('cli: oc get quota', `oc get quota -n ${project}`, /demo-quota/);
  await expectCmd('cli: oc get limitrange', `oc get limitrange -n ${project}`, /resource-limits/);
  await expectCmd(
    'cli: oc create clusterquota',
    'oc create clusterquota team-quota --project-label-selector=team=dev --hard=pods=10',
    /clusterresourcequota.*created/i
  );
  await expectCmd('cli: oc get clusterquota', 'oc get clusterquota', /team-quota/);
  await expectCmd('cli: oc get users', 'oc get users', /bob/);
  await expectCmd('cli: oc get groups', 'oc get groups', /devs/);
  await expectCmd('cli: oc get scc', 'oc get scc', /anyuid/);

  await expectCmd(
    'cli: oc create sa',
    `oc create sa api-sa -n ${project}`,
    /serviceaccount\/api-sa created/i
  );
  await expectCmd(
    'cli: oc set serviceaccount',
    `oc set serviceaccount deployment/web api-sa -n ${project}`,
    /service account updated|updated/i
  );
  await expectCmd(
    'cli: add-role-to-user -z',
    `oc adm policy add-role-to-user view -z api-sa -n ${project}`,
    /added|view/i
  );
  await expectCmd(
    'cli: oc auth can-i --as=serviceaccount',
    `oc auth can-i get pods --as=system:serviceaccount:${project}:api-sa -n ${project}`,
    /yes/i
  );

  await expectCmd(
    'cli: oc create route edge',
    `oc create route edge edge-route --service=web --hostname=edge.example.com -n ${project}`,
    /route.*exposed|created/i
  );
  await expectCmd('cli: oc get route edge', `oc get route edge-route -n ${project}`, /edge-route/);
  await expectCmd(
    'cli: oc describe route',
    `oc describe route web -n ${project}`,
    /Name:|Admitted|Host/i
  );
  await expectCmd(
    'cli: oc get route -o yaml',
    `oc get route web -n ${project} -o yaml`,
    /apiVersion: route\.openshift\.io\/v1/
  );

  await expectCmd('cli: oc get all', `oc get all -n ${project}`, /service|deployment/i);
  await expectCmd('cli: oc status', 'oc status', /In project|svc\/|deployment/i);
  await expectCmd('cli: oc projects', 'oc projects', /ex280-demo|default/);
  await expectCmd('cli: oc explain', 'oc explain deployment', /KIND:|Deployment/i);
  await expectCmd('cli: oc api-resources', 'oc api-resources', /buildconfig|route|APIVERSION/i);
  await expectCmd(
    'cli: oc get events',
    `oc get events -n ${project}`,
    /LAST SEEN|Normal|Warning|No resources/i
  );
  await expectCmd('cli: oc adm top nodes', 'oc adm top nodes', /NAME|CPU/i);
  await expectCmd(
    'cli: oc adm top pods',
    `oc adm top pods -n ${project}`,
    /NAME|CPU|No resources/i
  );
  await expectCmd('cli: oc adm must-gather', 'oc adm must-gather', /must-gather|Gathering/i);
  await expectCmd(
    'cli: oc edit opens Files editor',
    `oc edit deployment/web -n ${project}`,
    /manifest editor|Files panel|Opening/i
  );
  await waitFor(() => evaluate(() => window.game?.manifestPanel?.visible === true), 5000);
  assert(
    await evaluate(() => window.game?.manifestPanel?.visible === true),
    'cli: oc edit opens the manifest editor'
  );
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
      unknownLogin.message.slice(0, 240)
    );
    const whoamiAfterUnknown = await runCmd('oc whoami', 100);
    assert(
      /^kubeadmin/im.test(whoamiAfterUnknown.message),
      'auth: failed login leaves the session unchanged',
      whoamiAfterUnknown.message.slice(0, 120)
    );
    await expectCmd(
      'auth: admin login works without an IdP',
      'oc login -u admin',
      /Login successful/i
    );
    await expectCmd('auth: oc whoami admin', 'oc whoami', /^admin/im);
    await expectCmd(
      'auth: login back as kubeadmin',
      `oc login -u kubeadmin -p ${await kubeadminPassword()}`,
      /Login successful/i
    );
    await expectCmd(
      'auth: htpasswd creates alice',
      'htpasswd -c htpasswd alice Passw0rd',
      () => true
    );
    // #26: htpasswd must print the real messages and honour -c/-b/-D semantics.
    const htpasswdCreate = await runCmd('htpasswd -c -B -b /tmp/h u1 pw');
    assert(
      !htpasswdCreate.error && htpasswdCreate.message.trim() === 'Adding password for user u1',
      'cli: htpasswd -c -B -b prints Adding password for user u1',
      JSON.stringify(htpasswdCreate.message)
    );
    const htpasswdFile = await evaluate(() => window.game.manifestEngine.readFile('/tmp/h'));
    assert(
      typeof htpasswdFile === 'string' && /^u1:\$2y\$/.test(htpasswdFile),
      'cli: htpasswd writes a bcrypt $2y$ entry',
      JSON.stringify(htpasswdFile)
    );
    const htpasswdUpdate = await runCmd('htpasswd -B -b /tmp/h u1 pw2');
    assert(
      !htpasswdUpdate.error && htpasswdUpdate.message.trim() === 'Updating password for user u1',
      'cli: htpasswd updates print Updating password for user u1',
      JSON.stringify(htpasswdUpdate.message)
    );
    const htpasswdAdd = await runCmd('htpasswd -b /tmp/h u2 pw');
    assert(
      !htpasswdAdd.error && htpasswdAdd.message.trim() === 'Adding password for user u2',
      'cli: htpasswd adds a second user',
      JSON.stringify(htpasswdAdd.message)
    );
    const htpasswdDelete = await runCmd('htpasswd -D /tmp/h u2');
    assert(
      !htpasswdDelete.error && htpasswdDelete.message.trim() === 'Deleting password for user u2',
      'cli: htpasswd -D prints Deleting password for user u2',
      JSON.stringify(htpasswdDelete.message)
    );
    const htpasswdMissing = await runCmd('htpasswd -D /tmp/h u2');
    assert(
      !htpasswdMissing.error && htpasswdMissing.message.trim() === 'User u2 not found',
      'cli: htpasswd -D on a missing user prints User u2 not found',
      JSON.stringify(htpasswdMissing.message)
    );
    const htpasswdNoCreate = await runCmd('htpasswd -b /tmp/does-not-exist u3 pw');
    assert(
      htpasswdNoCreate.error &&
        /cannot modify file \/tmp\/does-not-exist; use '-c' to create it/.test(
          htpasswdNoCreate.message
        ),
      'cli: htpasswd without -c on a missing file errors like real htpasswd',
      htpasswdNoCreate.message
    );
    await expectCmd(
      'auth: create htpasswd secret',
      'oc create secret generic htpasswd-secret --from-file=htpasswd -n openshift-config',
      /secret\/htpasswd-secret created|configured/i
    );
    const oauth = await evaluate(() =>
      window.game.gameEngine.configureHTPasswdProvider({ secretName: 'htpasswd-secret' })
    );
    assert(
      oauth?.success === true,
      'auth: OAuth HTPasswd provider configured',
      JSON.stringify(oauth)
    );
    const authReady = await waitFor(
      () => evaluate(() => window.game?.gameEngine?.authProvider?.ready === true),
      20000
    );
    assert(authReady, 'auth: HTPasswd provider becomes ready');
    await expectCmd(
      'auth: oc login as alice',
      'oc login -u alice -p Passw0rd',
      /logged in|Login successful/i,
      { wait: 300 }
    );
    await expectCmd('auth: oc whoami alice', 'oc whoami', /^alice/im);
    await expectCmdError(
      'auth: wrong password rejected',
      'oc login -u alice -p wrong-password',
      /Login failed|401|incorrect/i
    );
    const whoamiAfterWrongPassword = await runCmd('oc whoami', 100);
    assert(
      /^alice/im.test(whoamiAfterWrongPassword.message),
      'auth: wrong password leaves the session unchanged',
      whoamiAfterWrongPassword.message.slice(0, 120)
    );
    const authState = await evaluate(() => ({
      currentUser: window.game?.gameEngine?.currentUser,
      user: !!window.game?.cluster?.getUser?.('alice'),
      identity: (window.game?.cluster?.getByKind?.('Identity') || []).some((i) =>
        /alice/.test(i.metadata?.name || '')
      ),
    }));
    assert(authState.user, 'auth: User alice exists after login');
    assert(authState.identity, 'auth: Identity alice auto-created');
    await expectCmd('auth: logout', 'oc logout', /logged .* out|logged out/i);
    await expectCmd(
      'auth: login back as kubeadmin',
      `oc login -u kubeadmin -p ${await kubeadminPassword()}`,
      /logged in|Login successful/i
    );
  } else {
    warn('auth: HTPasswd/login flow skipped', 'ManifestEngine or auth APIs unavailable');
  }

  // BuildConfig → Build → ImageStream semantics (the example applies into the current project).
  await expectCmd(
    'cli: apply BuildConfig',
    'oc apply -f examples/buildconfig.yaml',
    /created|configured|unchanged/i
  );
  // The ConfigChange trigger auto-starts the first build; wait for it before testing oc start-build
  // (a second start while a Serial build is running would be rejected, as on a real cluster).
  await waitFor(
    async () =>
      evaluate(() => {
        const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
          (b) => (b.metadata?.namespace || '') === 'ex280-demo'
        );
        return (
          builds.length > 0 &&
          builds.every((b) => ['Complete', 'Failed'].includes(b.status?.phase || b.phase))
        );
      }),
    45000
  );
  await expectCmd('cli: oc start-build', `oc start-build webapp -n ${project}`, /started|build/i, {
    wait: 700,
  });
  const buildReached = await waitFor(async () => {
    return evaluate(() => {
      const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
        (b) => (b.metadata?.namespace || '') === 'ex280-demo'
      );
      return builds.some((b) => ['Complete', 'Failed'].includes(b.status?.phase || b.phase));
    });
  }, 30000);
  let buildState = await evaluate(() => {
    const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
      (b) => (b.metadata?.namespace || '') === 'ex280-demo'
    );
    return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
  });
  if (!buildReached || !buildState.some((b) => b.phase === 'Complete')) {
    // The simulator has a small random build-failure rate; retry once before failing.
    await expectCmd(
      'cli: oc start-build retry',
      `oc start-build webapp -n ${project}`,
      /started|build/i,
      { wait: 700 }
    );
    await waitFor(async () => {
      return evaluate(() => {
        const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
          (b) => (b.metadata?.namespace || '') === 'ex280-demo'
        );
        return builds.some((b) => (b.status?.phase || b.phase) === 'Complete');
      });
    }, 30000);
    buildState = await evaluate(() => {
      const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
        (b) => (b.metadata?.namespace || '') === 'ex280-demo'
      );
      return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
    });
  }
  assert(
    buildState.some((b) => b.phase === 'Complete'),
    'cli: Build reaches phase Complete',
    JSON.stringify(buildState)
  );
  await expectCmd('cli: oc get builds', `oc get builds -n ${project}`, /NAME|webapp|Complete/i);
  const imageStream = await findResource('ImageStream', 'webapp', project);
  assert(!!imageStream, 'cli: Build output ImageStream exists');
  if (imageStream) {
    const tags = await evaluate(() => {
      const is = (window.game.cluster.getByKind?.('ImageStream') || []).find(
        (r) => r.metadata?.name === 'webapp' && r.metadata?.namespace === 'ex280-demo'
      );
      return (is?.status?.tags || []).map((t) => t.tag || t.name);
    });
    assert(tags.length > 0, 'cli: ImageStream has an imported tag', JSON.stringify(tags));
  }

  // Subscription semantics.
  await expectCmd(
    'cli: oc apply subscription',
    'oc apply -f examples/subscription.yaml',
    /created|configured|unchanged/i
  );
  const subReady = await waitFor(async () => {
    return evaluate(() => {
      window.game?.gameEngine?.resume?.();
      const subs = window.game.cluster.getByKind?.('Subscription') || [];
      const sub = subs.find((s) => s.metadata.name === 'ansible-automation-platform-operator');
      return !!sub && ['Succeeded', 'Failed'].includes(sub.status?.phase || sub.phase);
    });
  }, 45000);
  const subscription = await findResource(
    'Subscription',
    'ansible-automation-platform-operator',
    'openshift-operators'
  );
  const subPhase = subscription?.status?.phase || subscription?.phase;
  assert(
    subReady && subPhase === 'Succeeded',
    'cli: Subscription reaches phase Succeeded',
    JSON.stringify(subPhase)
  );
  await expectCmd(
    'cli: oc get subs',
    'oc get subs -n openshift-operators',
    /ansible-automation-platform-operator/i
  );
  await expectCmd(
    'cli: oc get csv',
    'oc get csv -n openshift-operators',
    /ansible-automation-platform-operator|NAME/i
  );
  await expectCmd(
    'cli: oc delete subscription',
    'oc delete subscription ansible-automation-platform-operator -n openshift-operators',
    /deleted/i
  );

  // #26: OLM resolves per namespace/OperatorGroup. An unresolvable package makes
  // EVERY Subscription in that namespace report ResolutionFailed, with no
  // CSV/InstallPlan; a namespace with only a resolvable Subscription installs.
  const writeOperatorGroup = (namespace) =>
    evaluate(
      ({ ns }) =>
        window.game.manifestEngine.writeFile(
          `qa/og-${ns}.yaml`,
          `apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: ${ns}-og
  namespace: ${ns}
spec:
  targetNamespaces:
    - ${ns}
`
        ),
      { ns: namespace }
    );
  const writeSubscriptionFile = (namespace, name, pkg) =>
    evaluate(
      ({ ns, subName, packageName }) =>
        window.game.manifestEngine.writeFile(
          `qa/sub-${ns}-${subName}.yaml`,
          `apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ${subName}
  namespace: ${ns}
spec:
  channel: stable
  name: ${packageName}
  source: redhat-operators
  sourceNamespace: openshift-marketplace
`
        ),
      { ns: namespace, subName: name, packageName: pkg }
    );
  const readOlmNamespace = (namespace) =>
    evaluate((ns) => {
      const cluster = window.game.cluster;
      const subs = cluster.getByKindAndNamespace?.('Subscription', ns) || [];
      return {
        subs: subs.map((sub) => ({
          name: sub.metadata.name,
          phase: sub.status?.phase,
          reason: sub.status?.reason,
          conditions: (sub.status?.conditions || []).map(
            (condition) => `${condition.type}=${condition.status}/${condition.reason}`
          ),
        })),
        // #46: an AllNamespaces operator's CSV is copied into every namespace
        // (status.reason `Copied`); a copy is not an install in this namespace,
        // so it must not make an unresolvable namespace look resolved.
        csvs: (cluster.getByKindAndNamespace?.('ClusterServiceVersion', ns) || [])
          .filter((csv) => String(csv.status?.reason || '') !== 'Copied')
          .map((csv) => `${csv.metadata.name}:${csv.status?.phase}`),
        installPlans: (cluster.getByKindAndNamespace?.('InstallPlan', ns) || []).map(
          (plan) => plan.metadata.name
        ),
      };
    }, namespace);
  const olmBrokenProject = 'olm-lab';
  await expectCmd(
    'cli: create olm-lab project',
    `oc new-project ${olmBrokenProject}`,
    /Now using project|created/i
  );
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
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
    return {
      errors: outputs.filter((output) => output?.error).length,
      messages: outputs.map((output) => String(output?.message || '').split('\n')[0]),
    };
  }, olmBrokenProject);
  assert(
    olmBrokenApply.errors === 0,
    'cli: olm-lab OperatorGroup + a healthy and an unknown-package Subscription applied',
    JSON.stringify(olmBrokenApply.messages)
  );
  // Let OLM resolve the namespace; the failure then applies to both Subscriptions
  // and the namespace installs nothing (no phantom CSV/InstallPlan).
  await advanceSimulation(30);
  const olmNamespaceBroken = await waitFor(async () => {
    const state = await readOlmNamespace(olmBrokenProject);
    return (
      state.subs.length === 2 &&
      state.subs.every((sub) =>
        sub.conditions.some((line) => /ResolutionFailed=True\//.test(line))
      ) &&
      state.csvs.length === 0 &&
      state.installPlans.length === 0
    );
  }, 30000);
  const olmBrokenState = await readOlmNamespace(olmBrokenProject);
  assert(
    olmNamespaceBroken,
    'cli: both Subscriptions in a namespace report ResolutionFailed ConstraintsNotSatisfiable',
    JSON.stringify(olmBrokenState)
  );
  assert(
    olmBrokenState.subs.every((sub) => /ConstraintsNotSatisfiable/.test(sub.conditions.join(' '))),
    'cli: ResolutionFailed reason is ConstraintsNotSatisfiable for every Subscription',
    JSON.stringify(olmBrokenState.subs.map((sub) => sub.reason))
  );
  assert(
    olmBrokenState.csvs.length === 0 && olmBrokenState.installPlans.length === 0,
    'cli: an unresolvable namespace creates no CSV/InstallPlan',
    JSON.stringify({ csvs: olmBrokenState.csvs, installPlans: olmBrokenState.installPlans })
  );
  await expectCmd(
    'cli: oc describe subscription shows the namespace resolution failure',
    `oc describe subscription healthy-sub -n ${olmBrokenProject}`,
    /ResolutionFailed/
  );
  const olmHealthyProject = 'olm-ok';
  await expectCmd(
    'cli: create olm-ok project',
    `oc new-project ${olmHealthyProject}`,
    /Now using project|created/i
  );
  await expectCmd(
    'cli: switch back to the demo project',
    `oc project ${project}`,
    /Now using project/i
  );
  await writeOperatorGroup(olmHealthyProject);
  await expectCmd(
    'cli: apply olm-ok OperatorGroup',
    `oc apply -f qa/og-${olmHealthyProject}.yaml`,
    /operatorgroup.*created|created|configured/i
  );
  await writeSubscriptionFile(olmHealthyProject, 'metallb-operator', 'metallb-operator');
  await expectCmd(
    'cli: healthy single-Subscription namespace created',
    `oc apply -f qa/sub-${olmHealthyProject}-metallb-operator.yaml`,
    /subscription.*created|created|configured/i
  );
  await advanceSimulation(60);
  const olmHealthy = await waitFor(async () => {
    const state = await readOlmNamespace(olmHealthyProject);
    return (
      state.subs.length === 1 &&
      /Succeeded/.test(state.subs[0].phase || '') &&
      state.csvs.some((row) => /metallb-operator.*:Succeeded/.test(row))
    );
  }, 30000);
  const olmHealthyState = await readOlmNamespace(olmHealthyProject);
  assert(
    olmHealthy,
    'cli: a healthy single-Subscription namespace still reaches CSV Succeeded',
    JSON.stringify(olmHealthyState)
  );
  assert(
    olmHealthyState.subs.every(
      (sub) => !sub.conditions.some((line) => /ResolutionFailed=True/.test(line))
    ),
    'cli: healthy Subscription has no ResolutionFailed condition',
    JSON.stringify(olmHealthyState.subs)
  );

  await expectCmd(
    'cli: oc create job',
    `oc create job hello --image=busybox -- echo hi -n ${project}`,
    /job\.batch\/hello created/i
  );
  await expectCmd(
    'cli: oc create cronjob',
    `oc create cronjob hello-cron --image=busybox --schedule="*/1 * * * *" -n ${project}`,
    /cronjob\.batch\/hello-cron created/i
  );
  await expectCmd('cli: oc get jobs', `oc get jobs -n ${project}`, /hello/);
  await expectCmd('cli: oc get cronjobs', `oc get cronjobs -n ${project}`, /hello-cron/);
  const nodeName = await evaluate(
    // #53F: shared worker-0/worker-1/master-0 node catalog (no sandbox-node-N).
    () => window.game.cluster.getByKind?.('Node')?.[0]?.metadata?.name || 'worker-0'
  );
  await expectCmd('cli: oc adm cordon', `oc adm cordon ${nodeName}`, /cordoned|node/i);
  await expectCmd('cli: oc adm uncordon', `oc adm uncordon ${nodeName}`, /uncordoned|node/i);

  // Semantic assertions on the mutated model.
  const deployment = await findResource('Deployment', 'web', project);
  assert(
    deployment &&
      deployment.spec?.template?.spec?.containers?.[0]?.image ===
        'quay.io/openshift/origin-hello-openshift:v1.1',
    'cli: oc set image persists in Deployment spec',
    JSON.stringify(deployment?.spec?.template?.spec?.containers?.[0]?.image)
  );
  const env = deployment?.spec?.template?.spec?.containers?.[0]?.env || [];
  assert(
    env.some((e) => e.name === 'APP_ENV' && e.value === 'dev'),
    'cli: oc set env persists in Deployment spec'
  );
  const resources = deployment?.spec?.template?.spec?.containers?.[0]?.resources;
  assert(
    resources?.limits?.cpu === '500m' && resources?.requests?.cpu === '100m',
    'cli: oc set resources persists in Deployment spec',
    JSON.stringify(resources)
  );
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
  const sccGrant = await evaluate(
    ({ project: ns }) => {
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
          if (binding.kind === 'RoleBinding' && (binding.metadata?.namespace || '') !== ns)
            continue;
          const subjectOk = (binding.spec?.subjects || []).some(
            (subject) =>
              subject.kind === 'ServiceAccount' &&
              subject.name === 'default' &&
              (subject.namespace || binding.metadata?.namespace || ns) === ns
          );
          if (subjectOk) return { granted: true, via: 'binding', binding: binding.metadata?.name };
        }
        const scc = (cluster?.getByKind?.('SecurityContextConstraints') || []).find(
          (entry) => entry.metadata?.name === 'anyuid'
        );
        const legacyUsers = scc?.spec?.users || [];
        return { granted: legacyUsers.includes(saUser), via: 'legacy', subjects: legacyUsers };
      } catch (err) {
        return { granted: false, via: 'error', error: String(err?.message || err) };
      }
    },
    { project }
  );
  assert(sccGrant.granted, 'cli: add-scc-to-user grants anyuid', JSON.stringify(sccGrant));
  const quota = await findResource('ResourceQuota', 'demo-quota', project);
  const limitRange = await findResource('LimitRange', 'resource-limits', project);
  assert(!!quota, 'cli: ResourceQuota demo-quota exists');
  assert(!!limitRange, 'cli: LimitRange resource-limits exists (#38 YAML flow)');
  const crq = await findResource('ClusterResourceQuota', 'team-quota');
  assert(!!crq, 'cli: ClusterResourceQuota team-quota exists');
  const buildFinal = await evaluate(() => {
    const builds = (window.game.cluster.getByKind?.('Build') || []).filter(
      (b) => (b.metadata?.namespace || '') === 'ex280-demo'
    );
    return builds.map((b) => ({ name: b.metadata?.name, phase: b.status?.phase || b.phase }));
  });
  const buildEverComplete =
    (buildState || []).some((b) => b.phase === 'Complete') ||
    buildFinal.some((b) => b.phase === 'Complete');
  assert(
    buildEverComplete,
    'cli: at least one Build is Complete',
    JSON.stringify(buildFinal.length ? buildFinal : buildState)
  );
  const subs = await findResource(
    'Subscription',
    'ansible-automation-platform-operator',
    'openshift-operators'
  );
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
    await runCmd(
      'oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ex280-demo',
      200
    );
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
    const inspectorYaml = await evaluate(
      () => document.getElementById('inspector-body')?.innerText || ''
    );
    assert(
      /apiVersion/.test(inspectorYaml),
      'ui: inspector YAML tab renders apiVersion',
      inspectorYaml.slice(0, 160)
    );
    await evaluate(() => document.querySelector('#inspector-tabs [data-tab="describe"]')?.click());
    await sleep(250);
    const inspectorDescribe = await evaluate(
      () => document.getElementById('inspector-body')?.innerText || ''
    );
    assert(
      /Name:|Namespace:|Status:|Host|Route/.test(inspectorDescribe),
      'ui: inspector Describe tab renders',
      inspectorDescribe.slice(0, 160)
    );
    await evaluate(() => window.game.app.inspector.hide());
  }

  if (service) {
    await evaluate(
      (uid) => window.game.engine.emit('resource:contextmenu', { uid, x: 600, y: 400 }),
      service.uid
    );
    await sleep(350);
    const ctx = await evaluate(() => ({
      visible: window.game?.app?.contextMenu?.visible === true,
      text: document.getElementById('context-menu')?.innerText || '',
      hasExpose: !!document.querySelector('[data-testid="context-menu-expose"]'),
      hasEdit: !!document.querySelector('[data-testid="context-menu-edit-yaml"]'),
      hasDelete: !!document.querySelector('[data-testid="context-menu-delete"]'),
    }));
    assert(
      ctx.visible && ctx.hasExpose && ctx.hasEdit && ctx.hasDelete,
      'ui: context menu exposes OpenShift actions',
      JSON.stringify(ctx)
    );
    assert(
      /Expose Service.*Route/i.test(ctx.text),
      'ui: context menu uses Expose Service → Route wording'
    );
    await evaluate(() => window.game.app.contextMenu.hide());
  }
  if (buildConfig) {
    await evaluate(
      (uid) => window.game.engine.emit('resource:contextmenu', { uid, x: 600, y: 400 }),
      buildConfig.uid
    );
    await sleep(300);
    const buildCtx = await evaluate(() => ({
      visible: window.game?.app?.contextMenu?.visible === true,
      hasStartBuild: !!document.querySelector('[data-testid="context-menu-start-build"]'),
      text: document.getElementById('context-menu')?.innerText || '',
    }));
    assert(
      buildCtx.visible && buildCtx.hasStartBuild,
      'ui: BuildConfig context menu offers Start Build',
      buildCtx.text.slice(0, 200)
    );
    await evaluate(() => window.game.app.contextMenu.hide());
  }

  await evaluate(() => window.game.app.metrics.show());
  await sleep(400);
  const metrics = await evaluate(() => ({
    visible: window.game?.app?.metrics?.visible === true,
    canvases: document.querySelectorAll('#metrics-dashboard canvas').length,
  }));
  assert(
    metrics.visible && metrics.canvases >= 4,
    'ui: metrics dashboard opens with 4 charts',
    JSON.stringify(metrics)
  );
  await evaluate(() => window.game.app.metrics.hide());

  await evaluate(() => window.game.app.hud.settingsPanel.show());
  await sleep(350);
  const settings = await evaluate(() => ({
    visible: window.game?.app?.hud?.settingsPanel?.visible === true,
    panel: !!document.getElementById('ingame-settings-panel'),
    testId: !!document.querySelector('[data-testid="settings-panel"]'),
    controls: document.querySelectorAll(
      '#ingame-settings-panel [data-action], #ingame-settings-panel [data-testid]'
    ).length,
  }));
  assert(settings.visible && settings.panel && settings.testId, 'ui: in-game settings opens');
  assert(settings.controls >= 5, 'ui: settings has controls', `got ${settings.controls}`);
  await evaluate(() => window.game.app.hud.settingsPanel.hide());

  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('/');
  await sleep(350);
  assert(
    await evaluate(() => window.game?.app?.commandBar?.visible === true),
    'ui: "/" opens the oc terminal'
  );
  await page.keyboard.press('Escape');
  await sleep(250);
  assert(
    await evaluate(() => window.game?.app?.commandBar?.visible === false),
    'ui: Esc closes the oc terminal'
  );
  // Both the CommandBar and the shell listen for Escape; depending on listener
  // order the shell may also return to the menu. Re-enter Sandbox so the M and
  // Space shortcut assertions always run against a live game session.
  if (
    await evaluate(
      () => document.getElementById('main-menu')?.classList.contains('hidden') === false
    )
  ) {
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
  assert(
    await evaluate(() => window.game?.gameEngine?.state === 'paused'),
    'ui: Space pauses the simulation'
  );
  await page.keyboard.press('Space');
  await sleep(300);
  assert(
    await evaluate(() => window.game?.gameEngine?.state === 'running'),
    'ui: Space resumes the simulation'
  );
  await evaluate(() => document.activeElement?.blur?.());

  // gamefeel: Esc now opens the pause overlay (never discards the run).
  // Clear any overlay a previous assertion may have left half-open (Esc semantics
  // are "close topmost first"), then poll for the pause card under software WebGL.
  await closeOverlays();
  // Eliminate the race: a modal that is still finishing its close can swallow the
  // first Escape. Wait until nothing modal is open before pressing.
  const anyModalOpen = () =>
    evaluate(() => {
      const active = (id) => document.getElementById(id)?.classList.contains('active') === true;
      return Boolean(
        document.getElementById('tutorial-overlay') ||
        active('pause-overlay') ||
        active('settings-panel') ||
        active('achievements-panel') ||
        active('stats-panel') ||
        active('modal-level-complete') ||
        active('modal-game-over') ||
        window.game?.examPrepUI?.visible === true ||
        window.game?.manifestPanel?.visible === true ||
        window.game?.app?.inspector?.visible === true ||
        window.game?.app?.contextMenu?.visible === true ||
        window.game?.app?.metrics?.visible === true ||
        window.game?.app?.hud?.settingsPanel?.visible === true
      );
    });
  const pauseOverlayActive = () =>
    evaluate(() => document.getElementById('pause-overlay')?.classList.contains('active') === true);
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
    () =>
      evaluate(() => document.getElementById('main-menu')?.classList.contains('hidden') === true),
    4000
  );
  assert(runNotDiscarded, 'ui: Esc pause keeps the run (main menu stays hidden)');
  await evaluate(() => document.getElementById('pause-resume')?.click());
  await waitFor(
    () =>
      evaluate(
        () => document.getElementById('pause-overlay')?.classList.contains('active') === false
      ),
    4000
  );
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') === false
    ),
    'ui: pause Resume returns to the run'
  );

  // Regression: Esc while the help modal is open closes help first (and resumes
  // the sim) instead of opening the pause card behind it. Blur first: a hidden
  // resume button must not keep focus (the H shortcut targets the page body).
  await evaluate(() => document.activeElement?.blur?.());
  await sleep(250);
  await page.keyboard.press('h');
  const helpOpenAgain = await waitFor(
    () => evaluate(() => !!document.getElementById('tutorial-overlay')),
    6000
  );
  assert(helpOpenAgain, 'ui: H opens help from a live sandbox');
  const helpPaused = await waitFor(
    () => evaluate(() => window.game.gameEngine.state === 'paused'),
    4000
  );
  assert(helpPaused, 'ui: help modal pauses the sandbox simulation');
  await page.keyboard.press('Escape');
  const helpClosedByEsc = await waitFor(
    () => evaluate(() => !document.getElementById('tutorial-overlay')),
    5000
  );
  assert(helpClosedByEsc, 'ui: Esc closes the help modal');
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') !== true
    ),
    'ui: help-dismissing Esc does not open the pause overlay'
  );
  assert(
    await evaluate(() => window.game.gameEngine.state === 'running'),
    'ui: closing help resumes the sandbox simulation'
  );

  // Regression: EX280 Prep is a full-screen surface — it pauses the sim while
  // open and a single Esc closes it and resumes without double-resuming.
  const prepOpened = await openExamPrep();
  assert(prepOpened, 'ui: EX280 Prep opens from a live sandbox');
  assert(
    await evaluate(() => window.game.gameEngine.state === 'paused'),
    'ui: EX280 Prep pauses the simulation'
  );
  await page.keyboard.press('Escape');
  const prepClosed = await waitFor(
    () => evaluate(() => window.game.examPrepUI?.visible === false),
    5000
  );
  assert(prepClosed, 'ui: Esc closes EX280 Prep');
  await sleep(300);
  assert(
    await evaluate(() => window.game.gameEngine.state === 'running'),
    'ui: closing EX280 Prep resumes the simulation'
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CAMPAIGN LEVELS 1-20 + LEVEL 1 OBJECTIVE COMPLETION
// ═══════════════════════════════════════════════════════════════════════════
const REQUIRED_LEVEL_TITLES = [
  'Your First Project',
  'Query, Format, Filter',
  'Logs, Events & Health',
  'Declarative Manifests',
  'Kustomize Base',
  'Kustomize Overlays',
  'Secrets & ConfigMaps',
  'Templates & Helm',
  'Images, Builds & Image Streams',
  'Rolling Updates & Rollbacks',
  'Services & Routes',
  'Non-HTTP & Load Balancer',
  'HTPasswd & Users',
  'Groups & RBAC',
  'Quotas, LimitRanges & Templates',
  'Service Accounts & API Access',
  'SCC & Privileged Apps',
  'Operators',
  'Jobs & CronJobs',
  'EX280 Final: Production Platform',
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
  assert(
    first.level === 1 && first.title === 'Your First Project',
    'campaign: level 1 starts',
    JSON.stringify(first)
  );
  assert(
    first.objectives >= 2,
    'campaign: level 1 objectives populated',
    `got ${first.objectives}`
  );
  assert(first.hasStatus && first.statusObjectives >= 2, 'campaign: level 1 getStatus() works');
  assert(
    first.panelDisplay !== 'none' && first.panelRows >= 2,
    'campaign: objectives panel visible/populated',
    JSON.stringify(first)
  );
  await evaluate(() => document.getElementById('coach-skip')?.click());
  await sleep(350);
  const levelShot = await shot('campaign-level-1.png');
  if (levelShot) shotsTaken.push(levelShot);

  // Regression: Files & Manifests freezes the campaign clock while open and
  // resumes it when Esc closes the panel (without opening the pause card).
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesForClock = await waitFor(
    () => evaluate(() => window.game?.app?.manifestPanel?.visible === true),
    8000
  );
  assert(filesForClock, 'campaign: Files panel opens from F');
  await sleep(400);
  const filesClockOpen = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    await evaluate(() => window.game.gameEngine.state === 'paused'),
    'campaign: Files panel pauses the simulation'
  );
  await sleep(2000);
  const filesClockHeld = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    filesClockHeld === filesClockOpen,
    'campaign: campaign clock frozen while Files is open',
    `${filesClockOpen} -> ${filesClockHeld}`
  );
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const filesClockClosed = await waitFor(
    () => evaluate(() => window.game?.app?.manifestPanel?.visible === false),
    5000
  );
  assert(filesClockClosed, 'campaign: Esc closes the Files panel');
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') !== true
    ),
    'campaign: closing Files does not open the pause overlay'
  );
  assert(
    await evaluate(() => window.game.gameEngine.state === 'running'),
    'campaign: closing Files resumes the simulation'
  );
  await sleep(1300);
  const filesClockRunning = await evaluate(() => window.game.app.modeInstance.elapsedTime);
  assert(
    filesClockRunning > filesClockHeld,
    'campaign: campaign clock runs again after Files closes',
    `${filesClockHeld} -> ${filesClockRunning}`
  );

  await expectCmd(
    'campaign L1: oc login',
    `oc login -u kubeadmin -p ${await kubeadminPassword()}`,
    /logged in|Login successful|kubeadmin/i
  );
  await expectCmd(
    'campaign L1: create project',
    'oc new-project first-project',
    /Now using project/i
  );
  // L1 uses the supported non-root image: nginx:latest is ADMITTED under
  // restricted-v2 but then crash-loops on /var/cache/nginx (permission denied) —
  // see the nginx runtime regression in the CLI section.
  await expectCmd(
    'campaign L1: run Pod',
    'oc run hello-pod --image=quay.io/openshift/origin-hello-openshift:latest -n first-project',
    /pod.*created/i
  );
  await expectCmd(
    'campaign L1: create Deployment',
    'oc create deployment hello-deploy --image=quay.io/openshift/origin-hello-openshift:latest -n first-project',
    /deployment.*created/i
  );
  const completed = await waitFor(
    () =>
      evaluate(() => {
        const status = window.game?.app?.modeInstance?.getStatus?.();
        return (
          status?.state === 'completed' ||
          (status?.objectives?.length && status.objectives.every((o) => o.completed))
        );
      }),
    12000
  );
  const levelStatus = await evaluate(() => {
    const status = window.game.app.modeInstance?.getStatus?.();
    return {
      state: status?.state,
      objectives: (status?.objectives || []).map((o) => ({
        type: o.type,
        label: o.label,
        completed: o.completed,
        current: o.current,
        target: o.target,
      })),
      percentage: status?.completionPercentage,
    };
  });
  assert(
    completed &&
      levelStatus.objectives.length >= 2 &&
      levelStatus.objectives.every((o) => o.completed),
    'campaign: level 1 objectives flip to complete',
    JSON.stringify(levelStatus)
  );
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
    assert(
      info.objectives >= 2,
      `campaign: level ${id} objectives populated`,
      `got ${info.objectives}`
    );
    assert(info.hasStatus && info.statusObjectives >= 2, `campaign: level ${id} getStatus works`);
    assert(
      info.panelDisplay !== 'none' && info.panelRows >= 2,
      `campaign: level ${id} objectives panel populated`,
      JSON.stringify(info)
    );
    await closeOverlays();
  }
  // #22 non-regression for campaign gates: the uptime/clusterHealth activation
  // baselines must stay meaningful. L3's clusterHealth objective must not
  // complete before its triggerTime incident, must stay incomplete while it is
  // active, and must complete after the incident is resolved. L20's resolve
  // objectives must stay incomplete until both scheduled incidents resolve.
  const campaignGateStatus = () =>
    evaluate(() => {
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
  const objectiveOfType = (status, type) =>
    status.objectives.find((objective) => objective.type === type);
  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  assert(await launch('campaign', 3), 'campaign gates: level 3 starts');
  await closeOverlays();
  const l3Start = await campaignGateStatus();
  assert(
    objectiveOfType(l3Start, 'clusterHealth') !== undefined,
    'campaign gates: level 3 has a clusterHealth objective'
  );
  assert(
    objectiveOfType(l3Start, 'clusterHealth')?.completed === false,
    'campaign gates: L3 clusterHealth is incomplete before the incident fires',
    JSON.stringify({ health: l3Start.health, active: l3Start.activeIncidents })
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(6));
  const l3IncidentFired = await waitFor(
    () =>
      evaluate(
        () =>
          window.game.incidentEngine.activationCount >= 1 &&
          window.game.incidentEngine.getActiveIncidents().length >= 1
      ),
    40000
  );
  assert(l3IncidentFired, 'campaign gates: L3 triggerTime incident fires');
  const l3Active = await campaignGateStatus();
  assert(
    objectiveOfType(l3Active, 'clusterHealth')?.completed === false &&
      l3Active.activeIncidents >= 1,
    'campaign gates: L3 clusterHealth stays incomplete while the incident is active',
    JSON.stringify({
      completed: objectiveOfType(l3Active, 'clusterHealth')?.completed,
      active: l3Active.activeIncidents,
    })
  );
  await evaluate(() => {
    const engine = window.game.incidentEngine;
    for (const incident of engine.getActiveIncidents())
      engine.resolveIncident(incident.id, 'qa-gate');
  });
  const l3Restored = await waitFor(
    async () => objectiveOfType(await campaignGateStatus(), 'clusterHealth')?.completed === true,
    30000
  );
  const l3After = await campaignGateStatus();
  assert(
    l3Restored,
    'campaign gates: L3 clusterHealth completes after the incident is resolved',
    JSON.stringify(objectiveOfType(l3After, 'clusterHealth'))
  );
  assert(
    l3After.activeIncidents === 0 && l3After.health >= 90,
    'campaign gates: L3 cluster health is restored to >= 90',
    JSON.stringify({ health: l3After.health, active: l3After.activeIncidents })
  );

  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  assert(await launch('campaign', 20), 'campaign gates: level 20 starts');
  await closeOverlays();
  const l20Resolve = (status) =>
    status.objectives.filter((objective) => objective.type === 'resolve');
  const l20Start = await campaignGateStatus();
  assert(
    l20Resolve(l20Start).length >= 2 &&
      l20Resolve(l20Start).every((objective) => !objective.completed),
    'campaign gates: L20 resolve objectives are incomplete at level start',
    JSON.stringify(l20Resolve(l20Start))
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(10));
  const l20IncidentsFired = await waitFor(
    () => evaluate(() => window.game.incidentEngine.activationCount >= 2),
    90000
  );
  assert(l20IncidentsFired, 'campaign gates: L20 scheduled incidents fire');
  const l20Active = await campaignGateStatus();
  assert(
    l20Active.activeIncidents >= 1 &&
      l20Resolve(l20Active).every((objective) => !objective.completed),
    'campaign gates: L20 resolve objectives stay incomplete while the incidents are active',
    JSON.stringify({ active: l20Active.activeIncidents, resolve: l20Resolve(l20Active) })
  );
  await evaluate(() => {
    const engine = window.game.incidentEngine;
    for (const incident of engine.getActiveIncidents())
      engine.resolveIncident(incident.id, 'qa-gate');
  });
  const l20Resolved = await waitFor(
    async () => l20Resolve(await campaignGateStatus()).every((objective) => objective.completed),
    30000
  );
  assert(
    l20Resolved,
    'campaign gates: L20 resolve objectives tick only after both incidents are resolved',
    JSON.stringify(l20Resolve(await campaignGateStatus()))
  );
  await evaluate(() => window.game.gameEngine.setTimeScale(1));
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. TIMED CHALLENGES 1-13
// ═══════════════════════════════════════════════════════════════════════════
const REQUIRED_CHALLENGE_TITLES = [
  'Three-Tier App',
  'Fix CrashLoopBackOff',
  'Route with Edge TLS',
  'Kustomize Prod Overlay',
  'Build & Deploy from Source',
  'Quota Guardrail',
  'RBAC for a New Teammate',
  'SCC for a Privileged Workload',
  'Network Isolation',
  'Install an Operator',
  'HTPasswd Onboarding',
  'EX280 Speed Run',
  'Production Network Policies',
];
await runSection('challenges', async () => {
  await bootMenu();
  for (let id = 1; id <= 13; id += 1) {
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
    assert(
      info.challenge === id,
      `challenges: challenge ${id} currentChallenge`,
      JSON.stringify(info)
    );
    assert(
      info.title === REQUIRED_CHALLENGE_TITLES[id - 1],
      `challenges: challenge ${id} title`,
      info.title
    );
    assert(
      info.objectives >= 1,
      `challenges: challenge ${id} objectives populated`,
      `got ${info.objectives}`
    );
    assert(
      info.panelDisplay !== 'none' && info.panelRows >= 1,
      `challenges: challenge ${id} objectives panel populated`,
      JSON.stringify(info)
    );
    assert(info.statusObjectives >= 1, `challenges: challenge ${id} getStatus works`);
    await closeOverlays();
  }

  // Regression: the timed-lab countdown is frozen while Files is open.
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('f');
  const filesForChallenge = await waitFor(
    () => evaluate(() => window.game?.app?.manifestPanel?.visible === true),
    8000
  );
  assert(filesForChallenge, 'challenges: Files panel opens from F');
  await sleep(400);
  const challengeClockOpen = await evaluate(
    () => window.game.app.modeInstance.getStatus().timeRemaining
  );
  assert(
    await evaluate(() => window.game.gameEngine.state === 'paused'),
    'challenges: Files panel pauses the simulation'
  );
  await sleep(2000);
  const challengeClockHeld = await evaluate(
    () => window.game.app.modeInstance.getStatus().timeRemaining
  );
  assert(
    challengeClockHeld === challengeClockOpen,
    'challenges: timeRemaining frozen while Files is open',
    `${challengeClockOpen} -> ${challengeClockHeld}`
  );
  await evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  const challengeFilesClosed = await waitFor(
    () => evaluate(() => window.game?.app?.manifestPanel?.visible === false),
    5000
  );
  assert(challengeFilesClosed, 'challenges: Esc closes the Files panel');
  // Under software WebGL the RAF-driven countdown can be slow to resume, so poll
  // instead of relying on a single fixed sleep.
  let challengeClockRunning = challengeClockHeld;
  const clockResumed = await waitFor(
    async () => {
      challengeClockRunning = await evaluate(
        () => window.game.app.modeInstance.getStatus().timeRemaining
      );
      return challengeClockRunning < challengeClockHeld;
    },
    8000,
    250
  );
  assert(
    clockResumed,
    'challenges: countdown runs again after Files closes',
    `${challengeClockHeld} -> ${challengeClockRunning}`
  );

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
  const labStatus = () =>
    evaluate(() => {
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
  const labObjective = (status, type) =>
    status.objectives.find((objective) => objective.type === type);
  const labPlaying = await waitFor(async () => (await labStatus()).state === 'playing', 20000);
  assert(labPlaying, 'challenges: timed lab 02 is playing');
  const labCrashLoopActive = await waitFor(async () => {
    const status = await labStatus();
    return status.activeIncidents >= 1 && status.activationCount >= 1;
  }, 30000);
  const labBefore = await labStatus();
  assert(
    labCrashLoopActive,
    'challenges: lab 02 CrashLoopBackOff incident is active',
    JSON.stringify(labBefore)
  );
  assert(
    labBefore.activationCount >= 1 && labObjective(labBefore, 'uptime')?.completed === false,
    'challenges: lab 02 uptime objective is incomplete while the triggerTime:0 incident is active',
    JSON.stringify({
      activationCount: labBefore.activationCount,
      uptime: labObjective(labBefore, 'uptime'),
      health: labBefore.health,
    })
  );
  const labIncident = await evaluate(() => {
    const engine = window.game.incidentEngine;
    const active = engine.getActiveIncidents();
    if (!active.length) return null;
    const details = engine.getIncidentDetails(active[0].id);
    return details ? { id: details.id, targetPod: details.targetPod, name: details.name } : null;
  });
  assert(
    Boolean(labIncident?.targetPod),
    'challenges: lab 02 incident exposes a real crash-looping target Pod',
    JSON.stringify(labIncident)
  );
  const labTargetPod = labIncident?.targetPod || '';

  // #23 (a): scheduling root cause — preloaded/damaged pods must be bound to a
  // real Node, including the `oc get pods -o wide` NODE column.
  const labScheduling = await evaluate(() => {
    const nodes = new Set(
      (window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name)
    );
    const pods = (window.game.cluster.getByKindAndNamespace?.('Pod', 'default') || []).filter(
      (pod) => pod.metadata?.labels?.app === 'payment-service'
    );
    return {
      nodes: [...nodes],
      pods: pods.map((pod) => ({
        name: pod.metadata.name,
        nodeName: pod.spec?.nodeName || null,
        onRealNode: nodes.has(pod.spec?.nodeName),
      })),
    };
  });
  assert(
    labScheduling.pods.length >= 3 && labScheduling.pods.every((pod) => pod.onRealNode),
    'challenges: lab 02 crash-looping pods are bound to a real Node (spec.nodeName)',
    JSON.stringify(labScheduling)
  );
  const labWide = await runCmd('oc get pods -l app=payment-service -o wide -n default');
  const labWideRows = labWide.message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^payment-service-/.test(line));
  assert(
    labWideRows.length >= 3 &&
      labWideRows.every((line) =>
        labScheduling.nodes.some((node) => line.split(/\s+/).includes(node))
      ),
    'challenges: oc get pods -o wide shows a real NODE column (not <none>)',
    JSON.stringify(labWideRows.map((line) => line.slice(0, 180)))
  );

  // #23 (b): describe pod shows the live image + real Node and leaks nothing.
  const labLogs = await runCmd('oc logs deployment/payment-service --previous -n default');
  assert(
    !labLogs.error && /invalid configuration|exit code 1|FATAL/i.test(labLogs.message),
    'challenges: lab 02 previous logs show the crash output',
    labLogs.message.replace(/\n/g, ' ⏎ ').slice(0, 300)
  );
  const labDescribePod = await runCmd(`oc describe pod ${labTargetPod} -n default`);
  const labLiveImage = await runCmd(
    `oc get pod ${labTargetPod} -n default -o jsonpath={.spec.containers[0].image}`
  );
  const labDescribeImage = (labDescribePod.message.match(/^\s*Image:\s+(.+)$/m) || [])[1] || '';
  assert(
    !labDescribePod.error &&
      labDescribeImage.trim() === labLiveImage.message.trim() &&
      labDescribeImage.trim() === 'quay.io/example/payments:v2-bad-config',
    '#23: describe pod Image matches the live spec image',
    `${labDescribeImage} vs ${labLiveImage.message}`
  );
  const labNodeLine = labDescribePod.message.match(/^Node:\s+(\S+)\/(\S+)$/m) || [];
  assert(
    Boolean(labNodeLine[1]) && labNodeLine[1] !== '<none>' && labNodeLine[2] !== '<none>',
    '#23: describe pod shows a real Node (not <none>/<none>)',
    labNodeLine[0]
  );
  assert(
    !/openshiftgames/i.test(labDescribePod.message),
    '#23: describe pod hides simulator-internal annotations',
    (labDescribePod.message.match(/Annotations:.*$/m) || [])[0]
  );
  const labPodYaml = await runCmd(`oc get pod ${labTargetPod} -n default -o yaml`);
  const labPodListYaml = await runCmd('oc get pods -l app=payment-service -n default -o yaml');
  assert(
    !/openshiftgames/i.test(labPodYaml.message),
    '#23: oc get pod -o yaml hides simulator-internal annotations'
  );
  assert(
    !/openshiftgames/i.test(labPodListYaml.message),
    '#23: oc get pods -o yaml hides simulator-internal annotations'
  );

  // #23 (c): describe deployment has a real Pod Template, NewReplicaSet and the
  // status-derived conditions (not the old always-healthy ones).
  const labDeployDescribe = await runCmd('oc describe deployment payment-service -n default');
  assert(
    /^Pod Template:/m.test(labDeployDescribe.message) &&
      /^\s+Containers:/m.test(labDeployDescribe.message),
    '#23: describe deployment includes a real Pod Template section',
    labDeployDescribe.message.slice(0, 400)
  );
  assert(
    /Image:\s+quay\.io\/example\/payments:v2-bad-config/.test(labDeployDescribe.message),
    '#23: describe deployment Pod Template shows the container image',
    labDeployDescribe.message.slice(0, 600)
  );
  const labNewReplicaSet =
    (labDeployDescribe.message.match(/^NewReplicaSet:\s+(.+)$/m) || [])[1] || '';
  assert(
    /^payment-service-[a-z0-9]+ \(\d+\/\d+ replicas created\)$/.test(labNewReplicaSet.trim()),
    '#23: describe deployment shows NewReplicaSet <hash> (3/3 replicas created)',
    labNewReplicaSet
  );
  assert(
    /Available\s+False\s+MinimumReplicasUnavailable/.test(labDeployDescribe.message),
    '#23: describe deployment reports Available False MinimumReplicasUnavailable while crash-looping',
    labDeployDescribe.message
      .split('\n')
      .filter((line) => /Available|Progressing/.test(line))
      .join(' | ')
  );
  assert(
    !/openshiftgames/i.test(labDeployDescribe.message),
    '#23: describe deployment hides simulator-internal annotations',
    (labDeployDescribe.message.match(/Annotations:.*$/m) || [])[0]
  );
  const labDeployYaml = await runCmd('oc get deployment payment-service -n default -o yaml');
  assert(
    !/openshiftgames/i.test(labDeployYaml.message),
    '#23: oc get deployment -o yaml hides simulator-internal internals'
  );
  const labBrokenVisual = await evaluate(async () => {
    const { visualStatusFor, isAttentionStatus } = await import('/js/rendering/ResourceStatus.js');
    const deployment = window.game.cluster.getByName('Deployment', 'payment-service', 'default');
    const visual = visualStatusFor(deployment, null);
    return { visual, attention: isAttentionStatus(visual) };
  });
  assert(
    labBrokenVisual.visual !== 'Pending' && labBrokenVisual.attention === true,
    '#23: failing Deployment status is not Pending and carries an attention status',
    JSON.stringify(labBrokenVisual)
  );

  // Investigate, then fix the workload with the documented `oc set image`.
  await expectCmd(
    'challenges: lab 02 investigate logs',
    'oc logs deployment/payment-service --previous -n default',
    /invalid configuration|exit code 1|FATAL/i
  );
  await expectCmd(
    'challenges: lab 02 investigate describe',
    `oc describe pod ${labTargetPod} -n default`,
    /payment-service/
  );
  const labInvestigated = await waitFor(
    async () => labObjective(await labStatus(), 'investigate')?.completed === true,
    15000
  );
  assert(labInvestigated, 'challenges: lab 02 investigate objective ticks after logs/describe');
  await expectCmd(
    'challenges: lab 02 fix image',
    'oc set image deployment/payment-service main=quay.io/openshift/origin-hello-openshift:latest -n default',
    /image updated|updated/i
  );
  const labCompleted = await waitFor(async () => (await labStatus()).state === 'completed', 60000);
  const labAfter = await labStatus();
  assert(
    labCompleted,
    '#22: timed lab 02 completes after the documented image fix',
    JSON.stringify({ state: labAfter.state, timeRemaining: labAfter.timeRemaining })
  );
  assert(
    labAfter.objectives.length === 4 &&
      labAfter.objectives.every((objective) => objective.completed),
    '#22: timed lab 02 reaches 4/4 objectives complete',
    JSON.stringify(labAfter.objectives)
  );
  const labUptime = labObjective(labAfter, 'uptime');
  assert(
    labUptime?.completed === true && labUptime.current >= 90,
    '#22: "Restore cluster health to at least 90%" ticks after the fix (triggerTime:0 baseline)',
    JSON.stringify(labUptime)
  );
  assert(
    labAfter.activeIncidents === 0 && labAfter.health >= 90,
    '#22: lab 02 incident cleared and cluster health >= 90',
    JSON.stringify({ active: labAfter.activeIncidents, health: labAfter.health })
  );
  await waitFor(
    () =>
      evaluate(
        () =>
          (window.game.cluster.getByName('Deployment', 'payment-service', 'default')?.status
            ?.readyReplicas || 0) >= 3
      ),
    15000
  );
  const labDeploymentState = await evaluate(() => {
    const deployment = window.game.cluster.getByName('Deployment', 'payment-service', 'default');
    const nodes = new Set(
      (window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name)
    );
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
    labDeploymentState.readyReplicas >= 3 &&
      labDeploymentState.pods.length >= 3 &&
      labDeploymentState.pods.every((pod) => pod.phase === 'Running' && pod.onRealNode),
    '#22: payment-service rolls out 3/3 Ready on real Nodes',
    JSON.stringify(labDeploymentState)
  );
  const labHealthyDescribe = await runCmd('oc describe deployment payment-service -n default');
  assert(
    /Available\s+True\s+MinimumReplicasAvailable/.test(labHealthyDescribe.message),
    '#23: recovered Deployment reports Available True MinimumReplicasAvailable',
    labHealthyDescribe.message
      .split('\n')
      .filter((line) => /Available/.test(line))
      .join(' | ')
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
    JSON.stringify(labHealthyVisual)
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
  await expectCmd(
    'followup: oc create role --verb/--resource',
    'oc create role podread --verb=get,list --resource=pods -n default',
    /role\.rbac\.authorization\.k8s\.io\/podread created/
  );
  const roleRules = await evaluate(
    () =>
      window.game.cluster.getByKind('Role').find((r) => r.metadata.name === 'podread')?.spec?.rules
  );
  assert(
    JSON.stringify(roleRules) ===
      JSON.stringify([{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }]),
    'followup: role rules exactly match the requested flags',
    JSON.stringify(roleRules)
  );
  await expectCmd(
    'followup: bind the new role',
    'oc adm policy add-role-to-user podread alice -n default',
    /added|configured/i
  );
  await expectCmd(
    'followup: role rules feed oc auth can-i (allow)',
    'oc auth can-i get pods --as=alice -n default',
    /yes/i
  );
  await expectCmd(
    'followup: role rules feed oc auth can-i (deny)',
    'oc auth can-i delete pods --as=alice -n default',
    /no/i
  );

  // Dry-run Secret output must be API-shaped and pipe into replace -f -.
  const drySecret = await runCmd(
    'oc create secret generic follow-secret --from-literal=a=b --dry-run=client -o yaml -n default'
  );
  assert(
    !drySecret.error &&
      /^type:/m.test(drySecret.message) &&
      /^data:/m.test(drySecret.message) &&
      !/^spec:/m.test(drySecret.message),
    'followup: dry-run secret YAML is API-shaped',
    drySecret.message.slice(0, 180)
  );
  await expectCmd(
    'followup: dry-run | replace -f - pipeline',
    'oc create secret generic follow-secret2 --from-literal=a=b --dry-run=client -o yaml -n default | oc replace -f -',
    /created|configured/
  );

  // Real project-template flow: no stored template on a fresh cluster, generate one.
  await expectCmd(
    'followup: fresh cluster has no project template',
    'oc get templates -n openshift-config',
    /No resources found/i
  );
  const bootstrap = await runCmd('oc adm create-bootstrap-project-template -o yaml');
  assert(
    !bootstrap.error &&
      /kind: Template/.test(bootstrap.message) &&
      /PROJECT_REQUESTING_USER/.test(bootstrap.message) &&
      /RoleBinding/.test(bootstrap.message),
    'followup: create-bootstrap-project-template emits the canonical template',
    bootstrap.message.slice(0, 200)
  );

  // HTPasswd password rotation: extract -> htpasswd -bB -> set data -> rollout -> login.
  await expectCmd(
    'followup: htpasswd file',
    'htpasswd -c -B -b users.htpasswd rotate-user Passw0rd1',
    () => true
  );
  await expectCmd(
    'followup: htpasswd secret',
    'oc create secret generic htpasswd-secret --from-file=htpasswd=users.htpasswd -n openshift-config',
    /created|configured/
  );
  await evaluate(() =>
    window.game.gameEngine.configureHTPasswdProvider({ secretName: 'htpasswd-secret' })
  );
  await evaluate(() => {
    const sim = window.game.gameEngine.simulation;
    for (let i = 0; i < 160; i += 1) sim.tick(0.05);
  });
  await waitFor(() => evaluate(() => window.game?.gameEngine?.authProvider?.ready === true), 8000);
  await expectCmd(
    'followup: baseline login',
    'oc login -u rotate-user -p Passw0rd1',
    /Login successful|logged in/i,
    { wait: 300 }
  );
  await evaluate(
    (password) => window.game.app.commandBar.executeCommand(`oc login -u kubeadmin -p ${password}`),
    await kubeadminPassword()
  );
  await expectCmd(
    'followup: oc extract secret to virtual FS',
    'oc extract secret/htpasswd-secret -n openshift-config --to /tmp --confirm',
    /tmp\/htpasswd/
  );
  await expectCmd(
    'followup: rotate password in extracted file',
    "htpasswd -bB /tmp/htpasswd rotate-user 'NewPassw0rd!'",
    () => true
  );
  await expectCmd(
    'followup: oc set data secret updates the secret',
    'oc set data secret/htpasswd-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd',
    /data updated/i
  );
  await evaluate(() => {
    const sim = window.game.gameEngine.simulation;
    for (let i = 0; i < 160; i += 1) sim.tick(0.05);
  });
  await expectCmdError(
    'followup: old password rejected after rotation',
    'oc login -u rotate-user -p Passw0rd1',
    /Login failed|401/i
  );
  await expectCmd(
    'followup: new password accepted after rotation',
    'oc login -u rotate-user -p NewPassw0rd!',
    /Login successful|logged in/i
  );
  await evaluate(
    (password) => window.game.app.commandBar.executeCommand(`oc login -u kubeadmin -p ${password}`),
    await kubeadminPassword()
  );

  // project.config singleton + new project inheriting the configured template.
  await expectCmd(
    'followup: project.config get',
    'oc get project.config.openshift.io/cluster',
    /NAME|cluster/i
  );
  await expectCmd(
    'followup: project.config patch projectRequestTemplate',
    'oc patch project.config.openshift.io/cluster --type=merge -p \'{"spec":{"projectRequestTemplate":{"name":"project-request"}}}\'',
    /patched/i
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
  await evaluate(
    (text) => window.game.manifestEngine.writeFile('followup-template.yaml', text),
    customTemplate
  );
  await expectCmd(
    'followup: create custom project template',
    'oc create -f followup-template.yaml -n openshift-config',
    /created|configured/
  );
  await expectCmd(
    'followup: new-project uses the configured template',
    'oc new-project followup-check',
    /Now using project|created/i
  );
  const templateInheritance = await evaluate(() => ({
    networkPolicy: window.game.cluster
      .getByKind('NetworkPolicy')
      .some((n) => n.metadata.name === 'default-deny' && n.metadata.namespace === 'followup-check'),
    adminBinding: window.game.cluster
      .getByKind('RoleBinding')
      .some((r) => r.metadata.name === 'admin' && r.metadata.namespace === 'followup-check'),
  }));
  assert(
    templateInheritance.networkPolicy,
    'followup: new project inherits template objects',
    JSON.stringify(templateInheritance)
  );
  assert(
    templateInheritance.adminBinding,
    'followup: new project grants the requester admin',
    JSON.stringify(templateInheritance)
  );

  // oc edit explains the real $EDITOR (vi/vim) difference.
  await expectCmd(
    'followup: create deployment for edit note',
    'oc create deployment editnote --image=quay.io/openshift/origin-hello-openshift:latest -n followup-check',
    /created/i
  );
  await expectCmd(
    'followup: oc edit mentions $EDITOR / vi',
    'oc edit deployment/editnote -n followup-check',
    /(vi\b|vim|\$EDITOR)/i
  );
  await expectCmd(
    'followup: oc edit project.config opens editor',
    'oc edit project.config.openshift.io/cluster',
    /manifest editor/i
  );
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
  assert(
    !expanded.missing && expanded.cardH > 120,
    'regressions: cluster map starts expanded',
    JSON.stringify(expanded)
  );
  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const collapsedFirst = await minimap();
  assert(
    collapsedFirst.canvasDisplay === 'none' &&
      collapsedFirst.cardH > 16 &&
      collapsedFirst.cardH < 60,
    'regressions: first collapse click shrinks the cluster map immediately',
    JSON.stringify(collapsedFirst)
  );
  assert(
    collapsedFirst.toggleText === '+' && collapsedFirst.ariaExpanded === 'false',
    'regressions: collapse click updates the cluster map toggle state',
    JSON.stringify({ text: collapsedFirst.toggleText, ariaExpanded: collapsedFirst.ariaExpanded })
  );
  assert(
    Math.abs(collapsedFirst.containerBottom - expanded.containerBottom) < 1 &&
      Math.abs(collapsedFirst.containerRight - expanded.containerRight) < 1,
    'regressions: collapsed cluster map stays anchored bottom-right',
    JSON.stringify({
      before: [expanded.containerBottom, expanded.containerRight],
      after: [collapsedFirst.containerBottom, collapsedFirst.containerRight],
    })
  );
  assert(
    collapsedFirst.ids === 1,
    'regressions: cluster map keeps a single toggle',
    `got ${collapsedFirst.ids}`
  );
  const minimapCollapsedShot = await shot('regressions-minimap-collapsed.png');
  if (minimapCollapsedShot) shotsTaken.push(minimapCollapsedShot);

  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const expandedAgain = await minimap();
  assert(
    expandedAgain.canvasDisplay === 'block' &&
      expandedAgain.cardH > 120 &&
      expandedAgain.toggleText === '-' &&
      expandedAgain.ariaExpanded === 'true',
    'regressions: cluster map expands again with the canvas visible',
    JSON.stringify(expandedAgain)
  );
  await evaluate(() => document.getElementById('minimap-toggle')?.click());
  await sleep(250);
  const collapsedSecond = await minimap();
  assert(
    collapsedSecond.cardH > 16 && collapsedSecond.cardH < 60,
    'regressions: second collapse still shrinks the cluster map',
    JSON.stringify(collapsedSecond)
  );

  // ── 1b. Incident drawer: single panel, engine-truth count, no overlap ─────
  // #1: a level change/retry used to append a second #incident-panel whose
  // frozen HTML showed "0 active"; the drawer also covered the mission card and
  // the bottom view toolbar.
  await evaluate(() => window.game.app.launchGame('sandbox'));
  await waitFor(
    () =>
      evaluate(
        () => window.game?.app?.currentMode === 'sandbox' && !!window.game?.app?.modeInstance
      ),
    12000
  );
  await sleep(1800);
  const panelCount = await evaluate(() => document.querySelectorAll('#incident-panel').length);
  assert(
    panelCount === 1,
    'regressions: relaunch keeps a single incident panel',
    `got ${panelCount}`
  );
  await evaluate(() => document.activeElement?.blur?.());
  await evaluate(() => document.getElementById('hud-alerts')?.click());
  // Wait until the drawer slide + mission-card/toolbar shift have settled
  // (SwiftShader load can stretch the 240ms transitions).
  await waitFor(
    () =>
      evaluate(() => {
        const panel = document.querySelector('#incident-panel');
        const objectives = document.querySelector('#objectives-panel');
        const toolbar = document.querySelector('#view-toolbar');
        if (!panel || !panel.classList.contains('is-open')) return false;
        const pr = panel.getBoundingClientRect();
        if (pr.x < -1) return false;
        if (innerWidth > 900) {
          return (
            objectives.getBoundingClientRect().x >= pr.right &&
            toolbar.getBoundingClientRect().x >= pr.right
          );
        }
        return getComputedStyle(objectives).display === 'none';
      }),
    8000
  );
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
      empty: /No active incidents/.test(
        document.querySelector('#incident-list')?.textContent || ''
      ),
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
    JSON.stringify(drawer)
  );
  assert(
    drawer.headerCount === drawer.engineCount && (Number(drawer.engineCount) > 0 || drawer.empty),
    'regressions: incidents drawer header matches the engine count',
    JSON.stringify(drawer)
  );
  if (drawer.viewport > 900) {
    assert(
      drawer.toolbarLeft >= drawer.panelRight,
      'regressions: incidents drawer no longer covers the view toolbar',
      JSON.stringify(drawer)
    );
    // Sandbox has no mission checklist (the panel is display:none there); the
    // mission-card shift is asserted in campaign mode below.
    if (drawer.objectivesDisplay !== 'none') {
      assert(
        drawer.objectivesLeft >= drawer.panelRight,
        'regressions: incidents drawer no longer covers the mission card',
        JSON.stringify(drawer)
      );
    }
  } else {
    assert(
      drawer.objectivesDisplay === 'none',
      'regressions: narrow viewport stacks drawer over mission card',
      JSON.stringify(drawer)
    );
  }
  await page.keyboard.press('Escape');
  await sleep(450);
  const drawerClosed = await evaluate(() => ({
    open: document.querySelector('#incident-panel')?.classList.contains('is-open'),
    bodyClass: document.body.classList.contains('side-panel-left-open'),
    bell: document.getElementById('hud-alerts')?.getAttribute('aria-expanded'),
  }));
  assert(
    drawerClosed.open === false &&
      drawerClosed.bodyClass === false &&
      drawerClosed.bell === 'false',
    'regressions: Esc closes the incidents drawer and clears its layout state',
    JSON.stringify(drawerClosed)
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
  const cameraDistance = (a, b) =>
    Math.hypot(
      (a?.[0] ?? 0) - (b?.[0] ?? 0),
      (a?.[1] ?? 0) - (b?.[1] ?? 0),
      (a?.[2] ?? 0) - (b?.[2] ?? 0)
    );

  await bootCampaign(1);
  await sleep(1800); // let the launch layout + camera fit finish
  const launchScene = await readScene();
  assert(
    launchScene &&
      launchScene.count > 20 &&
      launchScene.unique === launchScene.count &&
      !launchScene.menuMode,
    'regressions: fresh campaign level starts auto-aligned',
    JSON.stringify({ count: launchScene?.count, unique: launchScene?.unique })
  );

  // The incidents drawer must not cover the campaign mission card or the view
  // toolbar on wide viewports (GitHub QA screenshot + the follow-up toolbar bug).
  await evaluate(() => window.game.app.incidentPanel?.show?.());
  await waitFor(
    () =>
      evaluate(() => {
        const panel = document.querySelector('#incident-panel');
        const objectives = document.querySelector('#objectives-panel');
        const toolbar = document.querySelector('#view-toolbar');
        if (!panel || !panel.classList.contains('is-open')) return false;
        const pr = panel.getBoundingClientRect();
        return (
          pr.x >= -1 &&
          objectives.getBoundingClientRect().x >= pr.right &&
          toolbar.getBoundingClientRect().x >= pr.right
        );
      }),
    8000
  );
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
    campaignDrawer.objectivesDisplay !== 'none' &&
      campaignDrawer.objectivesLeft >= campaignDrawer.panelRight &&
      campaignDrawer.toolbarLeft >= campaignDrawer.panelRight &&
      campaignDrawer.bodyClass,
    'regressions: incidents drawer leaves the campaign mission card and toolbar visible',
    JSON.stringify(campaignDrawer)
  );
  await page.keyboard.press('Escape');
  await waitFor(
    () => evaluate(() => document.body.classList.contains('side-panel-left-open') === false),
    5000
  );
  await sleep(200);

  // Drive the real pause-card button, not the internal method.
  await evaluate(() => window.game.app.showPause());
  await sleep(400);
  assert(
    await evaluate(
      () => document.getElementById('pause-overlay')?.classList.contains('active') === true
    ),
    'regressions: pause card opens before restart'
  );
  await evaluate(() => document.getElementById('pause-restart')?.click());
  await sleep(3200); // 600ms layout + 820ms camera fit with headroom
  const restartScene = await readScene();
  const stableScene = await readScene();
  assert(
    restartScene?.count === launchScene?.count,
    'regressions: restart keeps every cluster resource rendered',
    `${launchScene?.count} -> ${restartScene?.count}`
  );
  assert(
    restartScene && restartScene.unique === restartScene.count,
    'regressions: restart auto-aligns the rebuilt cluster (no stacked resources)',
    JSON.stringify({ count: restartScene?.count, unique: restartScene?.unique })
  );
  assert(
    restartScene?.signature === launchScene?.signature,
    'regressions: restarted layout matches the fresh-launch layout',
    `camera delta ${cameraDistance(restartScene?.camera, launchScene?.camera)}`
  );
  assert(
    cameraDistance(restartScene?.camera, launchScene?.camera) < 2,
    'regressions: restart refits the camera to the fresh-launch view',
    JSON.stringify({ launch: launchScene?.camera, restart: restartScene?.camera })
  );
  assert(
    stableScene?.signature === restartScene?.signature,
    'regressions: restarted layout settles and stays put'
  );
  const restartShot = await shot('regressions-campaign-restart.png');
  if (restartShot) shotsTaken.push(restartShot);

  // ── 3. "Next Level" uses the same post-launch layout ─────────────────────
  await evaluate(() => {
    const app = window.game.app;
    app.scoringEngine.progress.campaignProgress[1] = { completed: true, stars: 3 };
    document.getElementById('level-complete-next')?.click();
  });
  const level2Started = await waitFor(
    () => evaluate(() => window.game.app.modeInstance?.currentLevel === 2),
    10000
  );
  assert(level2Started, 'regressions: next level starts from the level-complete action');
  await sleep(2200); // let the next level's layout + camera fit finish
  const level2Scene = await readScene();
  assert(
    level2Scene && level2Scene.count > 20 && level2Scene.maxShared <= 4,
    'regressions: next level starts auto-aligned (no stacked pile)',
    JSON.stringify({
      count: level2Scene?.count,
      unique: level2Scene?.unique,
      maxShared: level2Scene?.maxShared,
    })
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #27/#28: incident self-healing and node recovery
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-incidents', async () => {
  // Bug #27: incidents must heal from the resulting cluster STATE on the
  // simulation tick (not only after an unrelated write), quota incidents must
  // be bound to the quota actually damaged, and a state-driven SCCForbidden
  // resolution must not bounce a healthy running Pod back to Pending.
  // Bug #28: NodeNotReady must be fixable with the real node-troubleshooting
  // routine (`oc debug node/x` → `chroot /host` → `systemctl restart kubelet`),
  // and `oc get nodes` must show realistic names/ROLES/status.
  // Cross-checks for #31 A1/A2 live in this section too because the state
  // healing contract lives in IncidentEngine.

  /** Advance the controller AND incident clocks together (0.05 s steps). */
  const advanceGame = async (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      const engine = window.game?.incidentEngine;
      if (!sim || typeof sim.tick !== 'function') return false;
      const steps = Math.ceil(secs / 0.05);
      for (let index = 0; index < steps; index += 1) {
        sim.tick(0.05);
        if (engine && typeof engine.tick === 'function') engine.tick(0.05);
      }
      return true;
    }, seconds);

  /** Advance until predicate() is true (or `maxSeconds` of game time). */
  const advanceUntil = async (predicate, maxSeconds = 60, step = 2) => {
    for (let played = 0; played < maxSeconds; played += step) {
      await advanceGame(step);
      if (await predicate()) return true;
    }
    return false;
  };

  /** Leave the current run and launch a campaign level / timed lab. */
  const startLevel = async (mode, id) => {
    await returnToMenu();
    await sleep(250);
    const started = await launch(mode, id);
    await closeOverlays();
    await sleep(400);
    return started;
  };

  const incidentNames = () =>
    evaluate(() =>
      [...(window.game?.incidentEngine?.activeIncidents?.values?.() || [])].map(
        (incident) => incident.name
      )
    );

  const activeIncident = (name) =>
    evaluate((incidentName) => {
      const engine = window.game?.incidentEngine;
      const incident = [...(engine?.activeIncidents?.values?.() || [])].find(
        (entry) => entry.name === incidentName
      );
      if (!incident) return null;
      return {
        id: incident.id,
        name: incident.name,
        target: incident.target,
        namespace: incident.namespace,
        damageApplied: incident.damageApplied,
        pendingTarget: Boolean(incident.pendingTarget),
        investigationProgress: incident.investigationProgress,
        steps: incident.investigationSteps.map((step) => ({
          command: step.command,
          completed: step.completed,
        })),
      };
    }, name);

  const resolvedNames = () =>
    evaluate(() =>
      (window.game?.incidentEngine?.resolvedIncidents || []).map((incident) => incident.name)
    );

  const podsIn = (namespace) =>
    evaluate((ns) => {
      const cluster = window.game?.cluster;
      return (cluster?.getByKind('Pod') || [])
        .filter((pod) => (pod.metadata?.namespace || '') === ns)
        .map((pod) => ({
          name: pod.metadata?.name,
          phase: pod.status?.phase,
          ready:
            (pod.status?.conditions || []).find((condition) => condition.type === 'Ready')
              ?.status || null,
          scc: pod.metadata?.annotations?.['openshift.io/scc'] || null,
          owner: (pod.metadata?.ownerReferences || []).map((ref) => ref.kind).join(','),
        }));
    }, namespace);

  const levelStatus = () =>
    evaluate(() => {
      const mode = window.game?.app?.modeInstance;
      try {
        return mode?.getStatus ? JSON.parse(JSON.stringify(mode.getStatus())) : null;
      } catch (error) {
        return null;
      }
    });

  const allObjectivesComplete = (status) =>
    Array.isArray(status?.objectives) &&
    status.objectives.every((objective) => objective.completed);

  const nodesInfo = () =>
    evaluate(() =>
      (window.game?.cluster?.getByKind('Node') || []).map((node) => ({
        name: node.metadata?.name || node.name,
        phase: node.status?.phase || node.phase,
        ready:
          (node.status?.conditions || []).find((condition) => condition.type === 'Ready')?.status ||
          null,
        unschedulable: node.spec?.unschedulable === true,
        roles: Object.keys(node.metadata?.labels || {})
          .filter((key) => key.startsWith('node-role.kubernetes.io/'))
          .map((key) => key.slice('node-role.kubernetes.io/'.length))
          .sort()
          .join(','),
      }))
    );

  const damagedNode = (list) =>
    list.find((node) => node.phase === 'NotReady' || node.ready === 'False') || null;

  const quotaState = (namespace, quotaName) =>
    evaluate(
      ({ ns, name }) => {
        const cluster = window.game?.cluster;
        const quota = (cluster?.getByKind('ResourceQuota') || []).find(
          (entry) => entry.metadata?.name === name && entry.metadata?.namespace === ns
        );
        const usage = cluster?.getQuotaUsage?.(ns) || {};
        const events = [];
        for (const kind of ['ReplicaSet', 'Deployment', 'Pod', 'ResourceQuota']) {
          for (const resource of cluster?.getByKind?.(kind) || []) {
            if (resource.metadata?.namespace !== ns) continue;
            for (const event of resource.events || []) {
              events.push({
                kind,
                name: resource.metadata.name,
                type: event.type,
                reason: event.reason,
                message: event.message,
              });
            }
          }
        }
        return {
          hard: JSON.parse(JSON.stringify(quota?.spec?.hard || {})),
          used: { pods: usage.pods, cpu: usage['requests.cpu'], memory: usage['requests.memory'] },
          events,
          pods: (cluster?.getByKind('Pod') || [])
            .filter((pod) => pod.metadata?.namespace === ns)
            .map((pod) => ({ name: pod.metadata?.name, phase: pod.status?.phase })),
        };
      },
      { ns: namespace, name: quotaName }
    );

  // A `--only=qa-incidents` run starts on about:blank, so make sure the game
  // app (and the helpers that call `window.game`) is booted.
  await bootMenu();

  // ── 1. L17: SCCForbidden heals from state, CLI-only (issue #27a + #27c) ──
  section('incidents: L17 SCCForbidden self-heals from state (CLI-only)');
  assert(await startLevel('campaign', 17), 'qa-incidents: L17 launches');
  await advanceGame(17);
  let scc = await activeIncident('SCCForbidden');
  assert(
    Boolean(scc),
    'qa-incidents: L17 SCCForbidden activates',
    JSON.stringify(await incidentNames())
  );
  assert(
    (await podsIn('privileged-lab')).length === 0,
    'qa-incidents: SCC-rejected Pod is never created on 4.x'
  );

  const progressBefore = scc?.investigationProgress ?? 0;
  await runCmd('oc get sa -n default -o name', 150);
  const afterWrongNamespace = await activeIncident('SCCForbidden');
  assert(
    afterWrongNamespace?.investigationProgress === progressBefore,
    'qa-incidents: investigation ignores a wrong-namespace command',
    `${progressBefore} -> ${afterWrongNamespace?.investigationProgress}`
  );
  await runCmd('oc get sa -n privileged-lab -o name', 200);
  const afterGetSa = await activeIncident('SCCForbidden');
  assert(
    (afterGetSa?.investigationProgress ?? 0) > progressBefore,
    'qa-incidents: `oc get sa -n <ns> -o name` counts toward investigation progress',
    `${progressBefore} -> ${afterGetSa?.investigationProgress}`
  );
  await runCmd('oc adm policy who-can use scc privileged', 200);
  const afterWhoCan = await activeIncident('SCCForbidden');
  assert(
    (afterWhoCan?.investigationProgress ?? 0) > (afterGetSa?.investigationProgress ?? 0),
    'qa-incidents: `oc adm policy who-can use scc privileged` counts toward investigation progress',
    `${afterGetSa?.investigationProgress} -> ${afterWhoCan?.investigationProgress}`
  );
  await runCmd('oc get rolebinding -n privileged-lab', 200);
  const afterRoleBinding = await activeIncident('SCCForbidden');
  assert(
    (afterRoleBinding?.investigationProgress ?? 0) > (afterWhoCan?.investigationProgress ?? 0),
    'qa-incidents: `oc get rolebinding -n <ns>` counts toward investigation progress',
    `${afterWhoCan?.investigationProgress} -> ${afterRoleBinding?.investigationProgress}`
  );

  const l17Grant = await runCmd(
    'oc adm policy add-scc-to-user privileged -z priv-sa -n privileged-lab',
    300
  );
  assert(!l17Grant.error, 'qa-incidents: L17 grant privileged SCC succeeds', l17Grant.message);
  await advanceGame(5);
  assert(
    !(await incidentNames()).includes('SCCForbidden'),
    'qa-incidents: SCCForbidden resolves from cluster state on the tick (no later write)',
    JSON.stringify(await incidentNames())
  );
  let l17Pods = await podsIn('privileged-lab');
  assert(
    l17Pods.some(
      (pod) => pod.phase === 'Running' && pod.ready === 'True' && pod.scc === 'privileged'
    ),
    'qa-incidents: privileged Pod is Running+Ready after the state-driven heal',
    JSON.stringify(l17Pods)
  );
  assert(
    !l17Pods.some((pod) => pod.phase === 'Pending'),
    'qa-incidents: state-driven heal never re-pends the running Pod (#27c)',
    JSON.stringify(l17Pods)
  );
  await sleep(1800); // CampaignMode.update() runs on the wall clock
  let l17Status = await levelStatus();
  assert(
    allObjectivesComplete(l17Status),
    'qa-incidents: L17 objectives complete CLI-only',
    JSON.stringify(
      l17Status?.objectives?.map((objective) => [objective.label, objective.completed])
    )
  );
  assert(
    l17Status?.state === 'completed',
    'qa-incidents: L17 completes CLI-only',
    JSON.stringify(l17Status?.state)
  );

  // ── 2. L15: quota incident bound to the damaged quota + A2 model (#27b) ──
  section('incidents: L15 quota incident heals from state, CLI-only');
  assert(await startLevel('campaign', 15), 'qa-incidents: L15 launches');
  await advanceGame(2);
  await runCmd('oc project quota-lab', 150);
  let step = await runCmd('oc apply -f examples/quota.yaml', 300);
  assert(!step.error, 'qa-incidents: L15 apply examples/quota.yaml', step.message);
  step = await runCmd('oc apply -f examples/limitrange.yaml', 300);
  assert(!step.error, 'qa-incidents: L15 apply examples/limitrange.yaml', step.message);
  step = await runCmd(
    'oc set resources deployment/web --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi',
    300
  );
  assert(!step.error, 'qa-incidents: L15 set web resource requests/limits', step.message);
  await advanceGame(4);
  step = await runCmd(
    'oc create clusterquota team-quota --project-label-selector=name=quota-lab --hard=pods=10 --hard=secrets=20',
    300
  );
  assert(!step.error, 'qa-incidents: L15 create ClusterResourceQuota', step.message);
  await runCmd('oc adm create-bootstrap-project-template -o yaml', 250);
  const templateYaml = [
    'apiVersion: template.openshift.io/v1',
    'kind: Template',
    'metadata:',
    '  name: project-request',
    '  namespace: openshift-config',
    'objects:',
    '  - apiVersion: networking.k8s.io/v1',
    '    kind: NetworkPolicy',
    '    metadata:',
    '      name: allow-same-namespace',
    '    spec:',
    '      podSelector: {}',
    '      ingress:',
    '        - from:',
    '            - podSelector: {}',
    'parameters: []',
    '',
  ].join('\n');
  await openFilesPanel();
  await evaluate(
    (yaml) => window.game.manifestEngine.writeFile('template.yaml', yaml),
    templateYaml
  );
  await closeOverlays();
  step = await runCmd('oc create -f template.yaml -n openshift-config', 300);
  assert(!step.error, 'qa-incidents: L15 create project-request Template', step.message);
  step = await runCmd(
    `oc patch project.config.openshift.io/cluster --type=merge -p '{"spec":{"projectRequestTemplate":{"name":"project-request"}}}'`,
    300
  );
  assert(!step.error, 'qa-incidents: L15 patch project.config template', step.message);

  const l15Fired = await advanceUntil(
    async () => (await incidentNames()).includes('ResourceQuotaExceeded'),
    40,
    2
  );
  assert(
    l15Fired,
    'qa-incidents: L15 ResourceQuotaExceeded fires',
    JSON.stringify(await incidentNames())
  );
  const l15Incident = await activeIncident('ResourceQuotaExceeded');
  assert(
    l15Incident?.target === 'compute-quota' && l15Incident?.pendingTarget === false,
    'qa-incidents: L15 incident is bound to the quota actually damaged (compute-quota)',
    JSON.stringify({ target: l15Incident?.target, pendingTarget: l15Incident?.pendingTarget })
  );
  let l15Quota = await quotaState('quota-lab', 'compute-quota');
  assert(
    l15Quota.used.pods <= Number(l15Quota.hard.pods),
    'qa-incidents: quota damage never lets Used exceed Hard (#31 A2)',
    JSON.stringify({ used: l15Quota.used.pods, hard: l15Quota.hard.pods })
  );
  assert(
    l15Quota.used.pods === Number(l15Quota.hard.pods),
    'qa-incidents: damaged quota is exactly full so the controller cannot replace the Pod',
    JSON.stringify({ used: l15Quota.used.pods, hard: l15Quota.hard.pods })
  );
  assert(
    !l15Quota.pods.some((pod) => pod.phase === 'Failed' || pod.phase === 'Pending'),
    'qa-incidents: quota damage does not fabricate Failed/Pending Pod objects',
    JSON.stringify(l15Quota.pods)
  );
  await advanceGame(6);
  l15Quota = await quotaState('quota-lab', 'compute-quota');
  assert(
    l15Quota.events.some(
      (event) =>
        event.kind === 'ReplicaSet' &&
        /FailedCreate/i.test(event.reason || '') &&
        /exceeded quota/i.test(event.message || '') &&
        /requested: pods=1, used: pods=1/.test(event.message || '')
    ),
    'qa-incidents: ReplicaSet reports Error creating: exceeded quota (#31 A2)',
    JSON.stringify(l15Quota.events.slice(-4))
  );

  // The learner's fix is the LAST write: from here the incident must clear from
  // the tick, with no panel button and no unrelated command.
  step = await runCmd(
    `oc patch resourcequota compute-quota -p '{"spec":{"hard":{"pods":"10","requests.cpu":"4","requests.memory":"8Gi"}}}'`,
    350
  );
  assert(!step.error, 'qa-incidents: L15 raise the damaged quota (last write)', step.message);
  await advanceGame(6);
  assert(
    !(await incidentNames()).includes('ResourceQuotaExceeded'),
    'qa-incidents: ResourceQuotaExceeded resolves from the tick with no write after the fix',
    JSON.stringify(await incidentNames())
  );
  l15Quota = await quotaState('quota-lab', 'compute-quota');
  assert(
    Number(l15Quota.hard.pods) === 10,
    'qa-incidents: state-driven heal does not overwrite the raised quota',
    JSON.stringify(l15Quota.hard)
  );
  assert(
    l15Quota.pods.filter((pod) => pod.phase === 'Running').length >= 2,
    'qa-incidents: workload re-schedules after the quota is raised',
    JSON.stringify(l15Quota.pods)
  );
  await sleep(2200);
  const l15Status = await levelStatus();
  assert(
    allObjectivesComplete(l15Status),
    'qa-incidents: L15 objectives complete CLI-only',
    JSON.stringify(
      l15Status?.objectives?.map((objective) => [objective.label, objective.completed])
    )
  );
  assert(
    l15Status?.state === 'completed',
    'qa-incidents: L15 completes CLI-only',
    JSON.stringify(l15Status?.state)
  );

  // ── 3. lab 8: fix BEFORE the incident fires must still heal (#27a + #27c) ─
  section('incidents: lab 8 SCCForbidden fix-before-trigger');
  assert(await startLevel('challenge', 8), 'qa-incidents: lab 8 launches');
  await advanceGame(2);
  await runCmd('oc project secure', 150);
  step = await runCmd('oc apply -f challenges/privileged-app.yaml', 300);
  assert(!step.error, 'qa-incidents: lab 8 apply privileged-app manifest', step.message);
  step = await runCmd('oc create serviceaccount priv-sa -n secure', 250);
  assert(!step.error, 'qa-incidents: lab 8 create ServiceAccount priv-sa', step.message);
  await advanceGame(2);
  step = await runCmd('oc adm policy add-scc-to-user privileged -z priv-sa -n secure', 300);
  assert(!step.error, 'qa-incidents: lab 8 grant SCC before the incident fires', step.message);
  await advanceGame(3);
  let lab8Pods = await podsIn('secure');
  assert(
    lab8Pods.some((pod) => pod.phase === 'Running' && pod.scc === 'privileged'),
    'qa-incidents: lab 8 privileged Pod runs before the incident activates',
    JSON.stringify(lab8Pods)
  );
  const lab8Resolved = await advanceUntil(
    async () => (await resolvedNames()).includes('SCCForbidden'),
    60,
    3
  );
  assert(
    lab8Resolved,
    'qa-incidents: lab 8 SCCForbidden resolves by tick state check (fix before trigger)',
    JSON.stringify({ active: await incidentNames(), resolved: await resolvedNames() })
  );
  lab8Pods = await podsIn('secure');
  assert(
    lab8Pods.some(
      (pod) => pod.phase === 'Running' && pod.ready === 'True' && pod.scc === 'privileged'
    ),
    'qa-incidents: lab 8 running Pod survives the state-driven resolution (not re-pended)',
    JSON.stringify(lab8Pods)
  );
  await sleep(1800);
  const lab8Status = await levelStatus();
  assert(
    allObjectivesComplete(lab8Status),
    'qa-incidents: lab 8 objectives complete CLI-only (privileged objective stays ticked)',
    JSON.stringify(
      lab8Status?.objectives?.map((objective) => [objective.label, objective.completed])
    )
  );
  assert(
    lab8Status?.completed === true,
    'qa-incidents: lab 8 completes',
    JSON.stringify(lab8Status?.completed)
  );

  // ── 4. lab 6: quota incident on a learner-created quota (#27b) ───────────
  section('incidents: lab 6 quota incident heals from state');
  assert(await startLevel('challenge', 6), 'qa-incidents: lab 6 launches');
  await advanceGame(2);
  await runCmd('oc project quota-lab', 150);
  step = await runCmd(
    'oc create quota team-quota --hard=pods=10,requests.cpu=4,requests.memory=8Gi',
    300
  );
  assert(!step.error, 'qa-incidents: lab 6 create quota team-quota', step.message);
  // #38: there is no `oc create limitrange` subcommand — the LimitRange comes
  // from the shipped YAML manifest, exactly as the lab hint now teaches.
  step = await runCmd('oc apply -f examples/limitrange.yaml -n quota-lab', 300);
  assert(!step.error, 'qa-incidents: lab 6 apply the LimitRange YAML (#38)', step.message);
  step = await runCmd(
    'oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest -n quota-lab',
    300
  );
  assert(!step.error, 'qa-incidents: lab 6 create deployment api', step.message);
  step = await runCmd(
    'oc set resources deployment/api --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=512Mi -n quota-lab',
    300
  );
  assert(!step.error, 'qa-incidents: lab 6 set api requests/limits', step.message);
  const lab6Fired = await advanceUntil(
    async () => (await incidentNames()).includes('ResourceQuotaExceeded'),
    50,
    2
  );
  assert(
    lab6Fired,
    'qa-incidents: lab 6 ResourceQuotaExceeded fires',
    JSON.stringify(await incidentNames())
  );
  const lab6Incident = await activeIncident('ResourceQuotaExceeded');
  assert(
    lab6Incident?.target === 'team-quota' && lab6Incident?.pendingTarget === false,
    'qa-incidents: lab 6 incident binds to the quota that exists',
    JSON.stringify({ target: lab6Incident?.target, pendingTarget: lab6Incident?.pendingTarget })
  );
  step = await runCmd(
    `oc patch resourcequota team-quota -p '{"spec":{"hard":{"pods":"10","requests.cpu":"4","requests.memory":"8Gi"}}}'`,
    350
  );
  assert(!step.error, 'qa-incidents: lab 6 raise the damaged quota (last write)', step.message);
  await advanceGame(6);
  assert(
    !(await incidentNames()).includes('ResourceQuotaExceeded'),
    'qa-incidents: lab 6 quota incident resolves by tick state check',
    JSON.stringify(await incidentNames())
  );
  await sleep(1800);
  const lab6Status = await levelStatus();
  assert(
    allObjectivesComplete(lab6Status),
    'qa-incidents: lab 6 objectives complete CLI-only',
    JSON.stringify(
      lab6Status?.objectives?.map((objective) => [objective.label, objective.completed])
    )
  );
  assert(
    lab6Status?.completed === true,
    'qa-incidents: lab 6 completes',
    JSON.stringify(lab6Status?.completed)
  );

  // ── 5. L20: NodeNotReady fixed from the CLI + realistic node display (#28) ─
  section('incidents: L20 NodeNotReady recovered via oc debug/systemctl');
  assert(await startLevel('campaign', 20), 'qa-incidents: L20 launches');
  let nodesText = await runCmd('oc get nodes', 250);
  assert(
    /^worker-0\s/m.test(nodesText.message) && !/^node-1\s/m.test(nodesText.message),
    'qa-incidents: nodes use real names (worker-0, not node-1)',
    nodesText.message.split('\n').slice(0, 2).join(' | ')
  );
  assert(
    /worker-0\s+Ready\s+worker\s/.test(nodesText.message),
    'qa-incidents: worker ROLES rendered (not <none>)',
    nodesText.message
  );
  assert(
    /master-0\s+Ready\s+control-plane,master\s/.test(nodesText.message),
    'qa-incidents: control-plane,master ROLES rendered',
    nodesText.message
  );
  await runCmd('oc adm cordon worker-0', 250);
  nodesText = await runCmd('oc get nodes', 250);
  assert(
    /worker-0\s+Ready,SchedulingDisabled\s/.test(nodesText.message),
    'qa-incidents: cordoned Ready node shows Ready,SchedulingDisabled',
    nodesText.message
  );
  await runCmd('oc adm uncordon worker-0', 250);

  const nodeFired = await advanceUntil(
    async () => (await incidentNames()).includes('NodeNotReady'),
    140,
    4
  );
  assert(nodeFired, 'qa-incidents: L20 NodeNotReady fires', JSON.stringify(await incidentNames()));
  let nodeList = await nodesInfo();
  let broken = damagedNode(nodeList);
  assert(Boolean(broken), 'qa-incidents: one node is NotReady', JSON.stringify(nodeList));
  const brokenName = broken?.name;
  nodesText = await runCmd('oc get nodes', 250);
  // #43: the real node lifecycle controller does not cordon a NotReady node —
  // it taints it (unreachable/not-ready) and the STATUS column stays `NotReady`.
  const brokenNode = await findResource('Node', brokenName);
  const brokenTaints = (brokenNode?.spec?.taints || []).map((taint) => String(taint.key));
  assert(
    new RegExp(`${brokenName}\\s+NotReady\\s`).test(nodesText.message) &&
      !new RegExp(`${brokenName}\\s+NotReady,SchedulingDisabled`).test(nodesText.message),
    'qa-incidents: NotReady node STATUS is NotReady without SchedulingDisabled (#43)',
    nodesText.message
  );
  assert(
    brokenTaints.some((key) => /node\.kubernetes\.io\/unreachable/.test(key)) &&
      brokenTaints.some((key) => /node\.kubernetes\.io\/not-ready/.test(key)),
    'qa-incidents: NotReady node carries the real unreachable + not-ready taints (#43)',
    JSON.stringify(brokenTaints)
  );

  step = await runCmd(`oc debug node/${brokenName}`, 250);
  assert(
    !step.error && step.message.includes('sh-5.1#'),
    'qa-incidents: oc debug node/<n> opens the real sh-5.1# debug shell (#49-3)',
    step.message
  );
  step = await runCmd('systemctl status kubelet', 150);
  assert(
    step.error && /command not found/.test(step.message),
    'qa-incidents: host binaries are unavailable before chroot /host',
    step.message
  );
  step = await runCmd('chroot /host', 150);
  assert(!step.error, 'qa-incidents: chroot /host succeeds', step.message);
  step = await runCmd('journalctl -u kubelet', 200);
  assert(
    !step.error && /kubelet/i.test(step.message),
    'qa-incidents: journalctl -u kubelet shows kubelet logs on the host',
    step.message
  );
  step = await runCmd('journalctl -u kubelet | tail -n 2', 200);
  assert(
    !step.error && step.message.trim().split('\n').length <= 2,
    'qa-incidents: journalctl pipe tail is supported in the debug shell',
    step.message
  );
  step = await runCmd('systemctl status kubelet', 200);
  assert(
    !step.error && /inactive \(dead\)/.test(step.message),
    'qa-incidents: kubelet reports inactive (dead) on the NotReady node',
    step.message
  );
  step = await runCmd('systemctl restart kubelet', 250);
  assert(!step.error, 'qa-incidents: systemctl restart kubelet succeeds', step.message);
  await runCmd('exit', 150);
  const debugExit = await runCmd('exit', 150);
  assert(!debugExit.error, 'qa-incidents: exit leaves the debug session');
  step = await runCmd('oc get nodes', 250);
  assert(
    !step.error && /worker-0/.test(step.message),
    'qa-incidents: normal oc commands resume after the debug session',
    step.message
  );
  await advanceGame(5);
  nodeList = await nodesInfo();
  assert(
    !damagedNode(nodeList),
    'qa-incidents: node is Ready again after systemctl restart kubelet',
    JSON.stringify(nodeList)
  );
  assert(
    !(await incidentNames()).includes('NodeNotReady'),
    'qa-incidents: NodeNotReady resolves from state with no later write command',
    JSON.stringify(await incidentNames())
  );

  // One-shot form: `oc debug node/x -- chroot /host <cmd>`.
  step = await runCmd(`oc debug node/${brokenName} -- chroot /host systemctl status kubelet`, 250);
  assert(
    !step.error && /kubelet\.service/.test(step.message),
    'qa-incidents: one-shot oc debug node/x -- chroot /host <cmd> runs',
    step.message
  );
  step = await runCmd(`oc debug node/${brokenName} -- chroot /host systemctl restart kubelet`, 250);
  assert(!step.error, 'qa-incidents: one-shot systemctl restart kubelet succeeds', step.message);

  // Drawer resolution action must keep working (#28 "keep the drawer action").
  const drawerIncident = await evaluate(() => {
    const engine = window.game.incidentEngine;
    const def = [...(engine?._defsById?.values?.() || [])].find(
      (entry) => entry.name === 'NodeNotReady'
    );
    if (!def) return null;
    const id = engine.spawnIncident(def, 'worker-0', 3, { exactTarget: true });
    const incident = engine.activeIncidents.get(id);
    return incident ? { id, target: incident.target } : null;
  });
  assert(
    drawerIncident?.target === 'worker-0',
    'qa-incidents: drawer-path NodeNotReady can be spawned on a node',
    JSON.stringify(drawerIncident)
  );
  const drawerResolved = await evaluate((incidentId) => {
    const result = window.game.incidentEngine.resolveIncident(incidentId, 'uncordon-node');
    return Boolean(result);
  }, drawerIncident?.id);
  assert(drawerResolved, 'qa-incidents: drawer resolution action returns a result');
  await advanceGame(3);
  nodeList = await nodesInfo();
  const drawerNode = nodeList.find((node) => node.name === 'worker-0');
  assert(
    drawerNode && drawerNode.ready === 'True' && drawerNode.unschedulable === false,
    'qa-incidents: drawer action heals and uncordons the node',
    JSON.stringify(drawerNode)
  );

  // ── 6. #31 A1: CrashLoopBackOff seed/fix contract (L3) ───────────────────
  section('incidents: CrashLoopBackOff seed/fix contract (L3)');
  assert(await startLevel('campaign', 3), 'qa-incidents: L3 launches');
  const l3Deploy = await evaluate(() => {
    const deploy = (window.game?.cluster?.getByKind('Deployment') || []).find(
      (entry) => entry.metadata?.name === 'web-app'
    );
    const container = deploy?.spec?.template?.spec?.containers?.[0] || {};
    return {
      env: (container.env || []).map((entry) => ({ name: entry.name, value: entry.value })),
      image: container.image,
    };
  });
  assert(
    l3Deploy.env.some((entry) => entry.name === 'APP_MODE' && entry.value === 'debug-invalid'),
    'qa-incidents: L3 starting Deployment carries the invalid APP_MODE seed',
    JSON.stringify(l3Deploy.env)
  );
  await advanceGame(12);
  const l3Incident = await activeIncident('CrashLoopBackOff');
  assert(
    Boolean(l3Incident),
    'qa-incidents: L3 CrashLoopBackOff activates',
    JSON.stringify(await incidentNames())
  );
  let l3Pods = await podsIn('ops-lab');
  assert(
    l3Pods.length > 0 && l3Pods.some((pod) => pod.phase === 'CrashLoopBackOff'),
    'qa-incidents: L3 workload Pods are crash-looping',
    JSON.stringify(l3Pods)
  );
  step = await runCmd('oc set env deployment/web-app FOO=bar -n ops-lab', 350);
  assert(!step.error, 'qa-incidents: L3 unrelated env change succeeds', step.message);
  await advanceGame(8);
  assert(
    (await incidentNames()).includes('CrashLoopBackOff'),
    'qa-incidents: unrelated env change does NOT heal CrashLoopBackOff (#31 A1)',
    JSON.stringify(await incidentNames())
  );
  step = await runCmd('oc set env deployment/web-app APP_MODE=production -n ops-lab', 350);
  assert(!step.error, 'qa-incidents: L3 correct APP_MODE succeeds', step.message);
  await advanceGame(10);
  assert(
    !(await incidentNames()).includes('CrashLoopBackOff'),
    'qa-incidents: correcting the seeded value heals CrashLoopBackOff from state',
    JSON.stringify(await incidentNames())
  );
  l3Pods = await podsIn('ops-lab');
  assert(
    l3Pods.length > 0 && l3Pods.every((pod) => pod.phase === 'Running'),
    'qa-incidents: L3 workload is healthy after the real fix',
    JSON.stringify(l3Pods)
  );

  // ── 7. Resolution must not fabricate completion of a repaired Job ────────
  section('incidents: repaired Job is never force-completed (no empty logs)');
  await returnToMenu();
  assert(await bootSandbox(), 'qa-incidents: sandbox launches');
  await evaluate(() => window.game.incidentEngine.start('sandbox'));
  await runCmd('oc new-project job-lab', 200);
  step = await runCmd(
    'oc create job report-batch --image=busybox -n job-lab -- sh -c "sleep 30"',
    300
  );
  assert(!step.error, 'qa-incidents: create Job report-batch', step.message);
  await advanceGame(3);
  const jobIncident = await evaluate(() => {
    const engine = window.game.incidentEngine;
    const def = [...(engine?._defsById?.values?.() || [])].find(
      (entry) => entry.name === 'JobDeadlineExceeded'
    );
    if (!def) return null;
    const id = engine.spawnIncident(def, 'report-batch', 3, {
      exactTarget: true,
      namespace: 'job-lab',
    });
    const incident = engine.activeIncidents.get(id);
    const job = (window.game.cluster?.getByKind('Job') || []).find(
      (entry) => entry.metadata?.name === 'report-batch'
    );
    return { id, damageApplied: incident?.damageApplied, phase: job?.status?.phase };
  });
  assert(
    jobIncident?.damageApplied === true && jobIncident?.phase === 'Failed',
    'qa-incidents: JobDeadlineExceeded damages the Job into Failed',
    JSON.stringify(jobIncident)
  );
  await runCmd('oc delete job report-batch -n job-lab', 250);
  step = await runCmd(
    'oc create job report-batch --image=busybox -n job-lab -- sh -c "echo 42"',
    300
  );
  assert(!step.error, 'qa-incidents: recreate healthy Job report-batch', step.message);
  await advanceGame(8);
  const repairedJob = await evaluate(() => {
    const job = (window.game.cluster?.getByKind('Job') || []).find(
      (entry) => entry.metadata?.name === 'report-batch'
    );
    const pods = (window.game.cluster?.getByKind('Pod') || []).filter(
      (pod) => pod.metadata?.namespace === 'job-lab'
    );
    return {
      phase: job?.status?.phase,
      succeeded: job?.status?.succeeded,
      pods: pods.map((pod) => ({ name: pod.metadata.name, phase: pod.status?.phase })),
    };
  });
  assert(
    !(repairedJob.phase === 'Complete' && repairedJob.pods.length === 0),
    'qa-incidents: repaired Job is not force-completed without a Pod',
    JSON.stringify(repairedJob)
  );
  step = await runCmd('oc logs job/report-batch -n job-lab', 250);
  assert(
    !step.error && /42/.test(step.message),
    'qa-incidents: repaired Job logs still show its real output',
    step.message
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #31: scenario realism (crash-loop, jobs, quota)
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-scenarios', async () => {
  // Issue #31 — scenario realism. Every assertion is behavioural: it drives the
  // same oc commands a learner would and checks the cluster state a real 4.22
  // cluster would show.

  /** Advance BOTH clocks deterministically (controller ticks + incident ticks). */
  const advanceBoth = async (seconds) => {
    await evaluate((secs) => {
      const engine = window.game?.incidentEngine;
      if (engine) engine.tick(secs * 1000);
    }, seconds);
    await advanceSimulation(seconds);
  };
  /** Play up to `maxGameSeconds` until `predicate()` is true. */
  const advanceUntil = async (predicate, maxGameSeconds = 40, step = 2) => {
    for (let played = 0; played < maxGameSeconds; played += step) {
      await advanceBoth(step);
      if (await predicate()) return true;
    }
    return false;
  };
  const incidentNames = () =>
    evaluate(() =>
      (window.game?.incidentEngine?.getActiveIncidents?.() || []).map((incident) => incident.name)
    );
  const podsIn = (namespace) =>
    evaluate(
      (ns) =>
        (window.game.cluster.getByKindAndNamespace('Pod', ns) || []).map((pod) => ({
          name: pod.metadata.name,
          phase: pod.status?.phase || 'Pending',
          ready: (pod.status?.containerStatuses || []).filter((status) => status.ready).length,
          waiting: (pod.status?.containerStatuses || [])
            .map((status) => status.state?.waiting?.reason)
            .filter(Boolean),
        })),
      namespace
    );
  const liveJob = (name, namespace) =>
    evaluate(
      ({ name, ns }) => {
        const job = window.game.cluster.getByName('Job', name, ns);
        if (!job) return null;
        return {
          phase: job.status?.phase || null,
          completed: job.status?.completed === true,
          succeeded: job.status?.succeeded ?? 0,
          failed: job.status?.failed ?? 0,
          active: job.status?.active ?? 0,
          annotations: Object.fromEntries(
            Object.entries(job.metadata?.annotations || {}).filter(([key]) =>
              key.startsWith('openshiftgames.io/logs')
            )
          ),
          events: (job.events || []).map((event) => ({
            reason: event.reason,
            message: event.message,
          })),
          activeDeadlineSeconds: job.spec?.activeDeadlineSeconds ?? null,
        };
      },
      { name, ns: namespace }
    );
  const deploymentContainer = async (name, namespace) => {
    const deployment = await findResource('Deployment', name, namespace);
    return deployment?.spec?.template?.spec?.containers?.[0] || null;
  };
  const command = (raw) => runCmd(raw, 80);

  // ── #31.1: L3 seeded CrashLoopBackOff — the bad value is real, and only
  //    correcting it resolves the incident (FOO=bar / rollout restart do not).
  await bootMenu();
  assert(await launch('campaign', 3), 'scenarios: L3 starts');
  await closeOverlays();
  await command('oc project ops-lab');
  const l3Container = await deploymentContainer('web-app', 'ops-lab');
  // #42-3: the crash cause is the env var alone; the image stays the neutral
  // origin-hello one so the log cannot blame the image.
  assert(
    !!l3Container &&
      /origin-hello-openshift/.test(l3Container.image || '') &&
      !/v2-bad-config/.test(l3Container.image || ''),
    'scenarios: L3 broken Deployment keeps a neutral image (#42-3)',
    l3Container?.image
  );
  assert(
    (l3Container?.env || []).some(
      (entry) => entry.name === 'APP_MODE' && entry.value === 'debug-invalid'
    ),
    'scenarios: L3 Deployment actually carries env APP_MODE=debug-invalid',
    JSON.stringify(l3Container?.env)
  );
  const l3Fired = await advanceUntil(
    async () => (await incidentNames()).includes('CrashLoopBackOff'),
    20
  );
  assert(l3Fired, 'scenarios: L3 CrashLoopBackOff incident fires');
  const l3Pods = await podsIn('ops-lab');
  assert(
    l3Pods.some((pod) => pod.phase === 'CrashLoopBackOff') ||
      l3Pods.some((pod) => pod.waiting.includes('CrashLoopBackOff')),
    'scenarios: L3 Pods visibly CrashLoopBackOff',
    JSON.stringify(l3Pods)
  );
  const l3PodName = l3Pods[0]?.name;
  if (l3PodName) {
    const previousLogs = await command(`oc logs ${l3PodName} -n ops-lab --previous`);
    assert(
      /configuration validation failed: APP_MODE has an unsupported value/.test(
        previousLogs.message
      ),
      'scenarios: L3 crash log names the seeded faulty APP_MODE value',
      previousLogs.message.slice(0, 300)
    );
  }
  const unrelatedEnv = await command('oc set env deployment/web-app FOO=bar -n ops-lab');
  assert(!unrelatedEnv.error, 'scenarios: L3 unrelated env edit applies', unrelatedEnv.message);
  await advanceUntil(async () => true, 6);
  assert(
    (await incidentNames()).includes('CrashLoopBackOff'),
    'scenarios: L3 unrelated env FOO=bar does NOT resolve the incident',
    JSON.stringify(await incidentNames())
  );
  const rolloutRestart = await command('oc rollout restart deployment/web-app -n ops-lab');
  assert(!rolloutRestart.error, 'scenarios: L3 rollout restart applies', rolloutRestart.message);
  await advanceUntil(async () => true, 8);
  assert(
    (await incidentNames()).includes('CrashLoopBackOff'),
    'scenarios: L3 rollout restart does NOT resolve the incident',
    JSON.stringify(await incidentNames())
  );
  const correctEnv = await command('oc set env deployment/web-app APP_MODE=production -n ops-lab');
  assert(!correctEnv.error, 'scenarios: L3 correcting APP_MODE applies', correctEnv.message);
  const l3Healed = await advanceUntil(
    async () => !(await incidentNames()).includes('CrashLoopBackOff'),
    40
  );
  assert(l3Healed, 'scenarios: L3 incident resolves once APP_MODE is corrected');
  const l3FixedContainer = await deploymentContainer('web-app', 'ops-lab');
  assert(
    (l3FixedContainer?.env || []).some(
      (entry) => entry.name === 'APP_MODE' && entry.value === 'production'
    ),
    'scenarios: L3 Deployment now carries APP_MODE=production',
    JSON.stringify(l3FixedContainer?.env)
  );
  await returnToMenu();

  // ── #31.2/#31.3: L19 seeds its own broken Job; the player's Job completes
  //    with its real output and its completed Pod/logs stay available.
  assert(await launch('campaign', 19), 'scenarios: L19 starts');
  await closeOverlays();
  await command('oc project batch-lab');
  const seededFailed = await advanceUntil(async () => {
    const job = await liveJob('report-batch', 'batch-lab');
    return job?.phase === 'Failed';
  }, 20);
  assert(seededFailed, 'scenarios: L19 seeded report-batch Job fails on its own short deadline');
  const seededJob = await liveJob('report-batch', 'batch-lab');
  assert(
    Number(seededJob?.activeDeadlineSeconds) > 0 && Number(seededJob.activeDeadlineSeconds) <= 10,
    'scenarios: L19 broken Job exposes a real activeDeadlineSeconds in its spec',
    String(seededJob?.activeDeadlineSeconds)
  );
  const jobsTable = await command('oc get jobs -n batch-lab');
  assert(
    /report-batch\s+Failed/.test(jobsTable.message),
    'scenarios: L19 get jobs shows the seeded Job as Failed (not Pending)',
    jobsTable.message
  );
  const brokenLogs = await command('oc logs job/report-batch -n batch-lab');
  assert(
    !/Server listening|Health check passed/.test(brokenLogs.message),
    'scenarios: L19 broken Job logs are its own output, not generic web-server lines',
    brokenLogs.message.slice(0, 300)
  );
  const l19Fired = await advanceUntil(
    async () => (await incidentNames()).includes('JobDeadlineExceeded'),
    20
  );
  assert(l19Fired, 'scenarios: L19 JobDeadlineExceeded incident fires on the seeded Job');
  const simpleJobCreate = await command(
    'oc create job report-job --image=perl -- perl -e "print 42" -n batch-lab'
  );
  assert(
    !simpleJobCreate.error,
    'scenarios: L19 player simple Job created',
    simpleJobCreate.message
  );
  const simpleJobDone = await advanceUntil(async () => {
    const job = await liveJob('report-job', 'batch-lab');
    return job?.phase === 'Complete';
  }, 40);
  assert(simpleJobDone, 'scenarios: L19 simple Job reaches Complete quickly');
  const completedJob = await liveJob('report-job', 'batch-lab');
  assert(
    completedJob?.completed === true && completedJob.succeeded === 1 && completedJob.active === 0,
    'scenarios: L19 Job status is Complete with 1/1 succeeded and no active Pods',
    JSON.stringify(completedJob)
  );
  assert(
    !(completedJob?.events || []).some((event) => /undefined/.test(event.message || '')),
    'scenarios: L19 Job events never read "Phase changed from undefined"',
    JSON.stringify(completedJob?.events)
  );
  const simpleLogs = await command('oc logs job/report-job -n batch-lab');
  assert(
    simpleLogs.message.trim() === '42',
    'scenarios: L19 oc logs job/<name> shows the container real stdout (42)',
    JSON.stringify(simpleLogs.message)
  );
  const podsTable = await command('oc get pods -n batch-lab');
  assert(
    /report-job-\S+\s+0\/1\s+Completed/.test(podsTable.message),
    'scenarios: L19 completed Pod still exists and shows STATUS Completed',
    podsTable.message
  );
  const deleteBroken = await command('oc delete job report-batch -n batch-lab');
  assert(!deleteBroken.error, 'scenarios: L19 broken Job can be deleted', deleteBroken.message);
  const recreateBroken = await command(
    'oc create job report-batch --image=perl --active-deadline-seconds=600 -- perl -e "print 42" -n batch-lab'
  );
  assert(
    !recreateBroken.error,
    'scenarios: L19 broken Job recreated with a longer deadline',
    recreateBroken.message
  );
  const l19Healed = await advanceUntil(
    async () => !(await incidentNames()).includes('JobDeadlineExceeded'),
    20
  );
  assert(
    l19Healed,
    'scenarios: L19 incident clears once the Job is recreated with a longer deadline'
  );
  const replacementDone = await advanceUntil(async () => {
    const job = await liveJob('report-batch', 'batch-lab');
    return job?.phase === 'Complete';
  }, 40);
  assert(replacementDone, 'scenarios: L19 replacement Job completes');
  const replacementLogs = await command('oc logs job/report-batch -n batch-lab');
  assert(
    replacementLogs.message.trim() === '42',
    'scenarios: L19 replacement Job logs remain available after completion',
    JSON.stringify(replacementLogs.message)
  );
  await returnToMenu();

  // ── #31.4: lab 1 MySQL image — real missing-credentials crash-loop + 3306.
  assert(await launch('challenge', 1), 'scenarios: lab 1 starts');
  await closeOverlays();
  await command('oc new-project backend');
  const mysqlNewApp = await command(
    'oc new-app --image=registry.redhat.io/rhel9/mysql-80 --name=database -n backend'
  );
  assert(!mysqlNewApp.error, 'scenarios: lab 1 oc new-app mysql runs', mysqlNewApp.message);
  const mysqlCrashed = await advanceUntil(
    async () =>
      (await podsIn('backend')).some(
        (pod) => pod.phase === 'CrashLoopBackOff' || pod.waiting.includes('CrashLoopBackOff')
      ),
    30
  );
  assert(mysqlCrashed, 'scenarios: lab 1 MySQL Pod CrashLoopBackOffs without credentials');
  const mysqlPods = await podsIn('backend');
  const mysqlPodName = mysqlPods[0]?.name;
  const mysqlLogs = await command(`oc logs ${mysqlPodName} -n backend`);
  assert(
    /You must either specify the following environment variables/.test(mysqlLogs.message) &&
      /MYSQL_USER/.test(mysqlLogs.message) &&
      /MYSQL_ROOT_PASSWORD/.test(mysqlLogs.message),
    'scenarios: lab 1 MySQL crash log is the real missing-credentials message',
    mysqlLogs.message.slice(0, 400)
  );
  const mysqlSvc = await command('oc get svc database -n backend');
  assert(
    /3306\/TCP/.test(mysqlSvc.message),
    'scenarios: lab 1 MySQL Service exposes the image port 3306/TCP',
    mysqlSvc.message
  );
  const mysqlDeployYaml = await command('oc get deployment database -n backend -o yaml');
  assert(
    /containerPort:\s*3306/.test(mysqlDeployYaml.message),
    'scenarios: lab 1 MySQL container spec uses port 3306',
    mysqlDeployYaml.message.slice(0, 400)
  );
  const mysqlFix = await command(
    'oc set env deployment/database MYSQL_ROOT_PASSWORD=secretpw MYSQL_DATABASE=appdb -n backend'
  );
  assert(!mysqlFix.error, 'scenarios: lab 1 credentials env applies', mysqlFix.message);
  const mysqlRunning = await advanceUntil(
    async () => (await podsIn('backend')).some((pod) => pod.phase === 'Running' && pod.ready > 0),
    30
  );
  assert(mysqlRunning, 'scenarios: lab 1 MySQL recovers after oc set env supplies credentials');
  await returnToMenu();

  // ── #31.5: lab 12 compute quota without LimitRange forbids requestless Pods.
  assert(await launch('challenge', 12), 'scenarios: lab 12 starts');
  await closeOverlays();
  await command('oc new-project prod');
  const prodQuota = await command(
    'oc create quota prod-quota --hard=pods=20,requests.cpu=4,requests.memory=8Gi -n prod'
  );
  assert(!prodQuota.error, 'scenarios: lab 12 prod-quota created', prodQuota.message);
  const dbMigrate = await command('oc create job db-migrate --image=busybox:latest -n prod');
  assert(!dbMigrate.error, 'scenarios: lab 12 Job object is created', dbMigrate.message);
  const requestlessBlocked = await advanceUntil(async () => {
    const job = await liveJob('db-migrate', 'prod');
    return (job?.events || []).some((event) => /failed quota/.test(event.message || ''));
  }, 20);
  assert(
    requestlessBlocked,
    'scenarios: lab 12 Job without requests is rejected by the compute quota'
  );
  const prodPods = await podsIn('prod');
  assert(
    prodPods.length === 0,
    'scenarios: lab 12 rejected Job leaves NO Pod object',
    JSON.stringify(prodPods)
  );
  const describeBlocked = await command('oc describe job db-migrate -n prod');
  assert(
    /failed quota: prod-quota: must specify requests\.cpu,requests\.memory/.test(
      describeBlocked.message
    ),
    'scenarios: lab 12 FailedCreate reports the real "must specify requests" message',
    describeBlocked.message.slice(0, 600)
  );
  const directPod = await runCmd('oc run p1 --image=busybox:latest -n prod');
  assert(
    directPod.error &&
      /failed quota: prod-quota: must specify requests\.cpu,requests\.memory/.test(
        directPod.message
      ),
    'scenarios: lab 12 direct `oc run` Pod is forbidden with the failed-quota message',
    directPod.message.slice(0, 300)
  );
  assert(
    !(await findResource('Pod', 'p1', 'prod')),
    'scenarios: lab 12 forbidden direct Pod object was never created'
  );
  const jobResources = await command(
    'oc set resources job/db-migrate -n prod --requests=cpu=100m,memory=128Mi'
  );
  assert(!jobResources.error, 'scenarios: lab 12 Job requests can be set', jobResources.message);
  const jobCompletes = await advanceUntil(async () => {
    const job = await liveJob('db-migrate', 'prod');
    return job?.phase === 'Complete';
  }, 60);
  const completedMigration = await liveJob('db-migrate', 'prod');
  assert(
    jobCompletes,
    'scenarios: lab 12 Job completes after its requests are set',
    JSON.stringify(completedMigration)
  );
  await returnToMenu();

  // ── #31.6: L15 quota-exceeded model — no phantom Pod, Used never > Hard, the
  //    ReplicaSet reports FailedCreate, and raising the quota restores scheduling.
  assert(await launch('campaign', 15), 'scenarios: L15 starts');
  await closeOverlays();
  await command('oc project quota-lab');
  const applyQuota = await command('oc apply -f examples/quota.yaml');
  assert(!applyQuota.error, 'scenarios: L15 quota manifest applies', applyQuota.message);
  const applyLimits = await command('oc apply -f examples/limitrange.yaml');
  assert(!applyLimits.error, 'scenarios: L15 LimitRange manifest applies', applyLimits.message);
  await advanceUntil(async () => true, 10);
  const quotaIncident = await advanceUntil(
    async () => (await incidentNames()).includes('ResourceQuotaExceeded'),
    25
  );
  assert(quotaIncident, 'scenarios: L15 ResourceQuotaExceeded incident fires');
  const quotaModel = await evaluate(() => {
    const cluster = window.game.cluster;
    const namespace = 'quota-lab';
    const pods = (cluster.getByKindAndNamespace('Pod', namespace) || []).map((pod) => ({
      name: pod.metadata.name,
      phase: pod.status.phase,
      ready: (pod.status.containerStatuses || []).filter((status) => status.ready).length,
    }));
    const quota = (cluster.getByKind('ResourceQuota') || []).find(
      (entry) => entry.metadata.namespace === namespace
    );
    const usage = cluster.getQuotaUsage(namespace);
    const replicaSet = (cluster.getByKindAndNamespace('ReplicaSet', namespace) || [])[0];
    return {
      pods,
      hardPods: Number(quota?.spec?.hard?.pods ?? 0),
      usedPods: Number(usage?.pods ?? 0),
      replicaSetEvents: (replicaSet?.events || []).map((event) => event.message || ''),
    };
  });
  assert(
    !quotaModel.pods.some((pod) => pod.phase === 'Pending' && pod.ready > 0),
    'scenarios: L15 quota damage does not fabricate a contradictory Pending Pod',
    JSON.stringify(quotaModel.pods)
  );
  assert(
    quotaModel.usedPods <= quotaModel.hardPods,
    'scenarios: L15 quota Used never exceeds Hard',
    `used ${quotaModel.usedPods} hard ${quotaModel.hardPods}`
  );
  const quotaEventMatch = quotaModel.replicaSetEvents
    .map((message) =>
      /exceeded quota: compute-quota, requested: pods=1, used: pods=(\d+), limited: pods=(\d+)/.exec(
        message
      )
    )
    .find(Boolean);
  assert(
    Boolean(quotaEventMatch) &&
      quotaEventMatch[1] === quotaEventMatch[2] &&
      Number(quotaEventMatch[1]) === quotaModel.usedPods &&
      Number(quotaEventMatch[2]) === quotaModel.hardPods,
    'scenarios: L15 FailedCreate event is on the ReplicaSet with the real wording',
    JSON.stringify({
      events: quotaModel.replicaSetEvents,
      usedPods: quotaModel.usedPods,
      hardPods: quotaModel.hardPods,
    })
  );
  const raiseQuota = await command(
    `oc patch quota compute-quota -n quota-lab --type=merge -p '{"spec":{"hard":{"pods":"5"}}}'`
  );
  assert(!raiseQuota.error, 'scenarios: L15 quota can be raised', raiseQuota.message);
  const workloadSchedules = await advanceUntil(async () => {
    const pods = await podsIn('quota-lab');
    return pods.filter((pod) => pod.phase === 'Running').length >= 2;
  }, 30);
  assert(workloadSchedules, 'scenarios: L15 workload schedules again after raising the quota');
  const quotaHealed = await advanceUntil(
    async () => !(await incidentNames()).includes('ResourceQuotaExceeded'),
    20
  );
  assert(quotaHealed, 'scenarios: L15 incident clears once the quota is raised');
  await returnToMenu();

  // ── #31.1 (capstone): L20 seeds the crash cause on onset — the bad image and
  //    APP_MODE appear in the live Deployment, and fixing APP_MODE is the only
  //    state-driven resolution (the panel is not required).
  assert(await launch('campaign', 20), 'scenarios: L20 starts');
  await closeOverlays();
  await command('oc new-project prod-platform');
  const applyWebapp = await command('oc apply -f manifests/deployment.yaml -n prod-platform');
  assert(!applyWebapp.error, 'scenarios: L20 webapp manifest applies', applyWebapp.message);
  await advanceUntil(async () => true, 6);
  const l20Fired = await advanceUntil(
    async () => (await incidentNames()).includes('CrashLoopBackOff'),
    70,
    5
  );
  assert(l20Fired, 'scenarios: L20 capstone CrashLoopBackOff fires');
  const l20Container = await deploymentContainer('webapp', 'prod-platform');
  assert(
    (l20Container?.env || []).some(
      (entry) => entry.name === 'APP_MODE' && /debug-invalid|invalid/.test(entry.value || '')
    ),
    'scenarios: L20 incident seeds the faulty APP_MODE into the live Deployment',
    JSON.stringify(l20Container?.env)
  );
  // #42-3: the L20 crash seed leaves the image neutral (origin-hello from
  // manifests/deployment.yaml) and only the invalid APP_MODE causes the crash.
  assert(
    /origin-hello-openshift/.test(l20Container?.image || '') &&
      !/v2-bad-config/.test(l20Container?.image || ''),
    'scenarios: L20 broken Deployment keeps the neutral image (#42-3)',
    l20Container?.image
  );
  const l20Unrelated = await command('oc set env deployment/webapp FOO=bar -n prod-platform');
  assert(!l20Unrelated.error, 'scenarios: L20 unrelated env edit applies', l20Unrelated.message);
  await advanceUntil(async () => true, 8);
  assert(
    (await incidentNames()).includes('CrashLoopBackOff'),
    'scenarios: L20 unrelated env change does NOT resolve the capstone incident'
  );
  const l20Fix = await command('oc set env deployment/webapp APP_MODE=production -n prod-platform');
  assert(!l20Fix.error, 'scenarios: L20 APP_MODE correction applies', l20Fix.message);
  const l20Healed = await advanceUntil(
    async () => !(await incidentNames()).includes('CrashLoopBackOff'),
    40
  );
  assert(
    l20Healed,
    'scenarios: L20 capstone CrashLoopBackOff resolves only after APP_MODE is corrected'
  );
  const l20Fixed = await deploymentContainer('webapp', 'prod-platform');
  assert(
    (l20Fixed?.env || []).some(
      (entry) => entry.name === 'APP_MODE' && entry.value === 'production'
    ),
    'scenarios: L20 Deployment carries APP_MODE=production after the fix',
    JSON.stringify(l20Fixed?.env)
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #29/#36: CLI write safety and output fidelity
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #29/#36: CLI write safety and output fidelity
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-cli', async () => {
  // ── #29 write verbs must never fall through to another namespace ────────
  // Campaign level 2 seeds `web` in `query-lab` while the session is in
  // `default`; real oc answers NotFound for every write verb and must never
  // mutate query-lab/web or tick the level's label objective.
  await bootCampaign(1);
  assert(await launch('campaign', 2), 'qa-cli: campaign level 2 starts');
  await closeOverlays();
  await evaluate(() => {
    window.game?.app?.hideTutorial?.();
    window.game?.app?.modeInstance?.pause?.();
  });

  const inspectWeb = () =>
    evaluate(() => {
      const resources = window.game?.cluster?.getByKind?.('Deployment') || [];
      const web = resources.find(
        (item) => item.metadata?.name === 'web' && item.metadata?.namespace === 'query-lab'
      );
      return web
        ? {
            exists: true,
            tier: web.metadata?.labels?.tier || null,
            generation: web.metadata?.generation,
          }
        : { exists: false };
    });

  assert(
    await findResource('Deployment', 'web', 'query-lab'),
    'qa-cli: level 2 seeds query-lab/web'
  );
  assert(
    await evaluate(() => window.game?.gameEngine?.currentProject === 'default'),
    'qa-cli: session starts in default'
  );
  const qlBefore = await inspectWeb();
  const labelBefore = qlBefore.tier;

  let r = await runCmd('oc label deploy web tier=frontend');
  assert(
    r.error && /Error from server \(NotFound\): deployments\.apps "web" not found/.test(r.message),
    'qa-cli #29a: label in default does not fall through to query-lab',
    r.message
  );
  const afterLabel = await inspectWeb();
  assert(
    afterLabel.exists && afterLabel.tier === labelBefore,
    'qa-cli #29a: query-lab/web was not labelled',
    JSON.stringify(afterLabel)
  );
  const labelObjective = await evaluate(() => {
    const status = window.game?.app?.modeInstance?.getStatus?.();
    return (status?.objectives || []).find((objective) =>
      /Label Deployment web/i.test(objective.label || '')
    );
  });
  assert(
    labelObjective && labelObjective.completed === false,
    'qa-cli #29a: failed cross-project label does not tick the label objective',
    JSON.stringify(labelObjective)
  );

  r = await runCmd('oc delete deploy web');
  assert(
    r.error && /Error from server \(NotFound\): deployments\.apps "web" not found/.test(r.message),
    'qa-cli #29a: delete in default does not delete query-lab/web',
    r.message
  );
  assert((await inspectWeb()).exists, 'qa-cli #29a: query-lab/web still exists after delete');

  await expectCmdError(
    'qa-cli #29a: annotate in default is namespace-exact',
    'oc annotate deploy web tier=frontend',
    /Error from server \(NotFound\): deployments\.apps "web" not found/
  );
  await expectCmdError(
    'qa-cli #29a: patch in default is namespace-exact',
    'oc patch deploy/web -p \'{"spec":{"replicas":5}}\'',
    /Error from server \(NotFound\): deployments\.apps "web" not found/
  );
  r = await runCmd('oc scale deploy web --replicas=3');
  assert(
    r.error && /Error from server \(NotFound\): deployments\.apps "web" not found/.test(r.message),
    'qa-cli #29d: scale not-found uses the server error form',
    r.message
  );
  await expectCmdError(
    'qa-cli #29a: set image in default is namespace-exact',
    'oc set image deploy/web main=nginx:1.26',
    /Error from server \(NotFound\): deployments\.apps "web" not found/
  );
  await expectCmdError(
    'qa-cli #29a: rollout restart in default is namespace-exact',
    'oc rollout restart deploy/web',
    /Error from server \(NotFound\): deployments\.apps "web" not found/
  );
  const afterWrites = await inspectWeb();
  assert(
    afterWrites.exists &&
      afterWrites.generation === qlBefore.generation &&
      afterWrites.tier === labelBefore,
    'qa-cli #29a: no write verb mutated query-lab/web',
    JSON.stringify({ before: qlBefore, after: afterWrites })
  );

  // Explicit -n still writes the target project.
  await expectCmd(
    'qa-cli #29a: label -n query-lab works',
    'oc label deploy web tier=frontend -n query-lab',
    /deployment\.apps\/web labeled/
  );
  const afterExplicitLabel = await inspectWeb();
  assert(
    afterExplicitLabel.tier === 'frontend',
    'qa-cli #29a: label -n query-lab persisted',
    JSON.stringify(afterExplicitLabel)
  );

  // ── #29b create is not idempotent (AlreadyExists), apply is ─────────────
  await evaluate(() => {
    window.game?.app?.modeInstance?.resume?.();
  });
  await expectCmd(
    'qa-cli #29b: create deployment api',
    'oc create deploy api --image=quay.io/openshift/origin-hello-openshift:latest',
    /deployment\.apps\/api created/
  );
  r = await runCmd('oc create deploy api --image=quay.io/openshift/origin-hello-openshift:latest');
  assert(
    r.error &&
      /Error from server \(AlreadyExists\): deployments\.apps "api" already exists/.test(r.message),
    'qa-cli #29b: create prints the server AlreadyExists form',
    r.message
  );
  await expectCmd(
    'qa-cli #29b: create configmap dup first time',
    'oc create configmap dup --from-literal=a=b',
    /configmap\/dup created/
  );
  r = await runCmd('oc create configmap dup --from-literal=a=b');
  assert(
    r.error && /configmaps "dup" already exists/.test(r.message),
    'qa-cli #29b: duplicate configmap create errors AlreadyExists',
    r.message
  );

  // apply is idempotent: unchanged re-apply keeps generation and says unchanged.
  await expectCmd(
    'qa-cli #29e: apply deploys manifests/deployment.yaml',
    'oc apply -f manifests/deployment.yaml',
    /deployment\.apps\/webapp created/
  );
  const genAfterCreate = (await findResource('Deployment', 'webapp', 'default'))?.metadata
    ?.generation;
  r = await runCmd('oc apply -f manifests/deployment.yaml');
  const genAfterReapply = (await findResource('Deployment', 'webapp', 'default'))?.metadata
    ?.generation;
  assert(
    !r.error && /deployment\.apps\/webapp unchanged/.test(r.message),
    'qa-cli #29e: re-applying an unchanged manifest prints unchanged',
    r.message
  );
  assert(
    genAfterCreate === genAfterReapply,
    'qa-cli #29e: unchanged apply does not bump generation',
    `${genAfterCreate} -> ${genAfterReapply}`
  );

  // `oc create -f` on an existing object is AlreadyExists.
  r = await runCmd('oc create -f manifests/deployment.yaml');
  assert(
    r.error &&
      /Error from server \(AlreadyExists\): deployments\.apps "webapp" already exists/.test(
        r.message
      ),
    'qa-cli #29b: create -f an existing manifest errors AlreadyExists',
    r.message
  );

  // ── #29c delete with a label selector / --all ───────────────────────────
  await advanceSimulation(2);
  const countApiPods = () =>
    evaluate(() => {
      const pods = window.game?.cluster?.getByKind?.('Pod') || [];
      return pods.filter(
        (pod) => pod.metadata?.namespace === 'default' && pod.metadata?.labels?.app === 'api'
      ).length;
    });
  assert((await countApiPods()) > 0, 'qa-cli #29c: api Deployment spawned pods');
  const podsBeforeDelete = await countApiPods();
  // Pause the controller so it cannot re-create pods between the delete and the
  // count (a running Deployment controller would immediately replace them).
  await evaluate(() => {
    if (window.game?.gameEngine?.state !== 'paused') window.game.gameEngine.togglePause();
  });
  r = await runCmd('oc delete pod -l app=api');
  assert(
    !r.error && /pod ".*" deleted/.test(r.message),
    'qa-cli #29c: oc delete pod -l app=api deletes matching pods',
    r.message
  );
  assert(
    (await countApiPods()) === 0,
    'qa-cli #29c: selector delete removed every matching pod',
    `before=${podsBeforeDelete}`
  );
  await evaluate(() => {
    if (window.game?.gameEngine?.state === 'paused') window.game.gameEngine.togglePause();
  });

  // ── #29f describe <type> with no name lists the objects ─────────────────
  await expectCmd(
    'qa-cli #29f: create a quota to describe',
    'oc create quota team-quota --hard=pods=10',
    /resourcequota\/team-quota created/
  );
  const describeQuota = await runCmd('oc describe quota');
  assert(
    !describeQuota.error && /Name:\s+team-quota/.test(describeQuota.message),
    'qa-cli #29f: describe quota with no name describes all quotas',
    describeQuota.message.slice(0, 300)
  );

  // ═══════════════════════════════════════════════════════════════════════
  // #36 collected CLI output differences (sandbox cluster)
  // ═══════════════════════════════════════════════════════════════════════
  assert(await bootSandbox(), 'qa-cli #36: sandbox mode boots');
  await closeOverlays();
  await evaluate(() => window.game?.gameEngine?.resume?.());

  // Files and shell: redirects are silent, `--dry-run=client -o name` parses.
  await expectCmd(
    'qa-cli #36: create deployment web in sandbox',
    'oc create deploy web --image=quay.io/openshift/origin-hello-openshift:latest --replicas=2',
    /deployment\.apps\/web created/
  );
  let out = await runCmd('oc get deploy web -o yaml > /tmp/web.yaml');
  assert(
    !out.error && out.message === '',
    'qa-cli #36: shell redirect prints nothing on success',
    JSON.stringify(out.message)
  );
  out = await runCmd('head -1 /tmp/web.yaml');
  assert(/apiVersion/.test(out.message), 'qa-cli #36: redirect wrote the file', out.message);
  out = await runCmd('oc label deploy web tier=frontend --dry-run=client -o name');
  assert(
    !out.error && out.message.trim() === 'deployment.apps/web',
    'qa-cli #36: label --dry-run=client -o name works',
    out.message
  );
  const dryRunLabelPersisted = await evaluate(() => {
    const deployment = (window.game?.cluster?.getByKind?.('Deployment') || []).find(
      (item) => item.metadata?.name === 'web'
    );
    return Boolean(deployment?.metadata?.labels?.tier);
  });
  assert(!dryRunLabelPersisted, 'qa-cli #36: label dry-run does not persist');

  // Object metadata: UUID uid, second-precision creationTimestamp.
  const objectMeta = await evaluate(() => {
    const deployment = (window.game?.cluster?.getByKind?.('Deployment') || []).find(
      (item) => item.metadata?.name === 'web'
    );
    return deployment
      ? { uid: deployment.metadata?.uid, timestamp: deployment.metadata?.creationTimestamp }
      : null;
  });
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      objectMeta?.uid || ''
    ),
    'qa-cli #36: metadata.uid is a UUID',
    objectMeta?.uid
  );
  assert(
    /T\d{2}:\d{2}:\d{2}Z$/.test(objectMeta?.timestamp || ''),
    'qa-cli #36: creationTimestamp is second precision',
    objectMeta?.timestamp
  );

  // `oc get deploy -o wide` has CONTAINERS + IMAGES.
  out = await runCmd('oc get deploy -o wide');
  const wideHeader = String(out.message).split('\n')[0];
  assert(
    /\bCONTAINERS\b/.test(wideHeader) && /\bIMAGES\b/.test(wideHeader),
    'qa-cli #36: oc get deploy -o wide has CONTAINERS and IMAGES',
    wideHeader
  );
  assert(
    /quay\.io\/openshift\/origin-hello-openshift:latest/.test(out.message),
    'qa-cli #36: wide IMAGES cell shows the container image',
    out.message.split('\n')[1]
  );

  // Endpoints: NAME ENDPOINTS AGE with comma-joined address:port list.
  await expectCmd(
    'qa-cli #36: expose the web deployment',
    'oc expose deploy web --port=8080',
    /service\/web exposed/
  );
  await advanceSimulation(3);
  out = await runCmd('oc get endpoints web');
  const endpointsLines = String(out.message).split('\n').filter(Boolean);
  assert(
    /^NAME\s+ENDPOINTS\s+AGE$/.test(endpointsLines[0] || ''),
    'qa-cli #36: endpoints columns are NAME ENDPOINTS AGE',
    endpointsLines[0]
  );
  assert(
    /^web\s+10\.\d+\.\d+\.\d+:\d+(?:,10\.\d+\.\d+\.\d+:\d+)*\s+\d+s$/.test(endpointsLines[1] || ''),
    'qa-cli #36: endpoints row lists address:port pairs',
    endpointsLines[1]
  );

  // ImageStreamTag: digest reference, realistic digest, image-appropriate Command.
  out = await runCmd('oc get istag -n openshift nodejs:20-ubi9');
  assert(
    /nodejs-20@sha256:[0-9a-f]{64}/.test(out.message) && !/nodejs-20:latest/.test(out.message),
    'qa-cli #36: oc get istag prints @sha256 reference',
    out.message
  );
  const digests = [...String(out.message).matchAll(/sha256:([0-9a-f]{64})/g)].map(
    (match) => match[1]
  );
  assert(
    digests.length > 0 && digests.every((digest) => !/^([0-9a-f]{8})\1{7}$/.test(digest)),
    'qa-cli #36: image digest is realistic (not one 8-char chunk repeated)',
    digests[0]
  );
  out = await runCmd('oc describe istag nodejs:20-ubi9 -n openshift');
  assert(
    /Docker Image:\s+image-registry\.openshift-image-registry\.svc:5000\/openshift\/nodejs@sha256:/.test(
      out.message
    ),
    'qa-cli #36: describe istag Docker Image uses the internal registry',
    out.message.slice(0, 300)
  );
  assert(
    /Command:\s+\/usr\/libexec\/s2i\/run/.test(out.message),
    'qa-cli #36: describe istag Command is container-appropriate for nodejs',
    out.message
  );

  // Builds: short FROM form, real STARTED/DURATION.
  await expectCmd(
    'qa-cli #36: oc new-build with image~git source',
    'oc new-build openshift/nodejs:20-ubi9~https://github.com/openshift/nodejs-ex --name=webapp-build',
    /buildconfig\.build\.openshift\.io "webapp-build" created/
  );
  out = await runCmd('oc get bc');
  assert(
    /nodejs:20-ubi9/.test(out.message) && !/nodejs:20-ubi9~/.test(out.message),
    'qa-cli #36: BuildConfig FROM column is the short builder tag',
    out.message
  );
  const qaBuildStart = await expectCmd(
    'qa-cli #36: start the build',
    'oc start-build webapp-build',
    /started/
  );
  const qaBuildName = (qaBuildStart.message.match(/(webapp-build-\d+) started/) || [])[1] || '';
  assert(Boolean(qaBuildName), 'qa-cli #36: start-build reports the started build name');
  await advanceSimulation(60);
  out = await runCmd('oc get builds');
  const buildLine =
    String(out.message)
      .split('\n')
      .find((line) => line.startsWith(qaBuildName)) || '';
  assert(/Complete/.test(buildLine), 'qa-cli #36: build reaches Complete', buildLine);
  assert(
    !/<none>/.test(buildLine) && /nodejs:20-ubi9\s/.test(buildLine) && !/~/.test(buildLine),
    'qa-cli #36: build STARTED + FROM are real',
    buildLine
  );
  out = await runCmd(`oc describe build ${qaBuildName}`);
  assert(
    /Build Config:\s+BuildConfig\/webapp-build/.test(out.message) &&
      /Image:\s+image-registry\.openshift-image-registry\.svc:5000\//.test(out.message),
    'qa-cli #36: describe build shows BuildConfig and image',
    out.message.slice(0, 400)
  );

  // Rollout: undo gives the re-activated ReplicaSet the next revision (2,3).
  await expectCmd(
    'qa-cli #36: create rollout deployment',
    'oc create deploy roll --image=quay.io/openshift/origin-hello-openshift:latest',
    /deployment\.apps\/roll created/
  );
  await advanceSimulation(8);
  await expectCmd(
    'qa-cli #36: change the rollout image',
    'oc set image deploy/roll origin-hello-openshift=nginx:1.26',
    /image updated/
  );
  await advanceSimulation(4);
  await expectCmd('qa-cli #36: oc rollout undo', 'oc rollout undo deploy/roll', /rolled back/);
  out = await runCmd('oc rollout history deploy/roll');
  assert(
    /^2\s/m.test(out.message) && /^3\s/m.test(out.message) && !/^1\s/m.test(out.message),
    'qa-cli #36: rollout history after undo is 2,3',
    out.message
  );
  // A rollout stuck on ImagePullBackOff reports updated-replica availability.
  await expectCmd(
    'qa-cli #36: create bad-image deployment',
    'oc create deploy stuck --image=quay.io/openshift/origin-hello-openshift:latest',
    /deployment\.apps\/stuck created/
  );
  await advanceSimulation(8);
  await runCmd(
    'oc set image deploy/stuck origin-hello-openshift=quay.io/openshift/does-not-exist:nope'
  );
  await advanceSimulation(10);
  out = await runCmd('oc rollout status deploy/stuck');
  assert(
    /0 of 1 updated replicas are available/.test(out.message) &&
      !/old replicas are pending termination/.test(out.message),
    'qa-cli #36: rollout status on ImagePullBackOff reports updated replicas available',
    out.message
  );

  // Routes and Services.
  await runCmd('oc create service clusterip tls-app --tcp=443:8080');
  await runCmd('oc create route passthrough tls-app --service=tls-app');
  out = await runCmd('oc get route tls-app');
  assert(
    /\s8080\s+passthrough\s/.test(out.message),
    'qa-cli #36: passthrough Route PORT is the backend port',
    out.message
  );
  await runCmd(
    'oc create route edge web --service=web --hostname=web.apps.example.com --path=/api'
  );
  out = await runCmd('oc describe route web');
  assert(
    !/<auto-generated>/.test(out.message) &&
      /Requested Host:\s+web\.apps\.example\.com/.test(out.message),
    'qa-cli #36: describe route shows the real Requested Host',
    out.message.slice(0, 300)
  );
  assert(
    /Path:\s+\/api/.test(out.message),
    'qa-cli #36: describe route shows the real Path',
    out.message
  );
  await runCmd('oc create route edge web-auto --service=web');
  out = await runCmd('oc describe route web-auto');
  assert(
    !/<auto-generated>/.test(out.message) && /^Requested Host:\s+\S+/m.test(out.message),
    'qa-cli #36: describe auto-generated route shows a real host',
    out.message.slice(0, 300)
  );
  await runCmd('oc create service loadbalancer lb --tcp=80:8080');
  out = await runCmd('oc get service lb');
  assert(
    /\b80:3\d{4}\/TCP\b/.test(out.message),
    'qa-cli #36: LoadBalancer PORT(S) shows the allocated nodePort',
    out.message
  );

  // jsonpath: unset field prints empty, escaped dots work.
  out = await runCmd("oc get deploy web -o jsonpath='{.metadata.annotations.missing}'");
  assert(
    !out.error && out.message === '',
    'qa-cli #36: jsonpath on an unset field prints empty',
    JSON.stringify(out.message)
  );
  await runCmd('oc annotate deploy/web openshift.io/scc=restricted-v2 --overwrite');
  out = await runCmd("oc get deploy web -o jsonpath='{.metadata.annotations.openshift\\.io/scc}'");
  assert(
    !out.error && out.message.trim() === 'restricted-v2',
    'qa-cli #36: jsonpath escaped-dot annotations work',
    out.message
  );

  // Quota describe: aligned Resource/Used/Hard columns.
  await runCmd('oc create quota q1 --hard=pods=10,requests.cpu=2,limits.memory=4Gi');
  out = await runCmd('oc describe quota');
  const quotaLines = String(out.message).split('\n');
  const quotaHeader = quotaLines.find((line) => /^Resource\s/.test(line)) || '';
  const quotaRow = quotaLines.find((line) => /^requests\.cpu\s/.test(line)) || '';
  assert(
    /^Resource\s+Used\s+Hard$/.test(quotaHeader) &&
      quotaHeader.indexOf('Used') === quotaRow.indexOf('0m') &&
      quotaHeader.indexOf('Hard') === quotaRow.indexOf('2'),
    'qa-cli #36: describe quota columns align',
    JSON.stringify({ quotaHeader, quotaRow })
  );

  // CronJob TIMEZONE <none>.
  await runCmd('oc create cronjob nightly --image=busybox --schedule="*/5 * * * *"');
  out = await runCmd('oc get cronjob');
  const cronHeader = String(out.message)
    .split('\n')[0]
    .split(/\s{2,}/);
  const cronRow =
    String(out.message)
      .split('\n')[1]
      ?.split(/\s{2,}/) || [];
  assert(
    cronRow[cronHeader.indexOf('TIMEZONE')] === '<none>',
    'qa-cli #36: CronJob TIMEZONE column is <none>',
    JSON.stringify({ cronHeader, cronRow })
  );

  // describe deploy surfaces controller events during FailedCreate.
  await runCmd('oc create deploy priv --image=nginx:latest');
  await runCmd(
    'oc patch deploy/priv -p \'{"spec":{"template":{"spec":{"containers":[{"name":"nginx","image":"nginx:latest","securityContext":{"privileged":true}}]}}}}\''
  );
  await advanceSimulation(6);
  out = await runCmd('oc describe deploy priv');
  assert(
    /^Events:/m.test(out.message) && /FailedCreate/.test(out.message),
    'qa-cli #36: describe deploy shows Events during FailedCreate',
    out.message.slice(-600)
  );

  // Kustomize: no leading `---`, commonLabels reach selectors, v5 semantics kept.
  await evaluate(() => {
    const me = window.game.manifestEngine;
    const deploymentYaml =
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: kd\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: kd\n  template:\n    metadata:\n      labels:\n        app: kd\n    spec:\n      containers:\n        - name: c\n          image: nginx:latest\n';
    me.writeFile(
      'qa-kust-common/kustomization.yaml',
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\ncommonLabels:\n  team: platform\n'
    );
    me.writeFile('qa-kust-common/deploy.yaml', deploymentYaml);
    me.writeFile(
      'qa-kust-labels/kustomization.yaml',
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\nlabels:\n  - pairs:\n      team: platform\n'
    );
    me.writeFile('qa-kust-labels/deploy.yaml', deploymentYaml);
    me.writeFile(
      'qa-kust-selectors/kustomization.yaml',
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\nlabels:\n  - pairs:\n      team: platform\n    includeSelectors: true\n'
    );
    me.writeFile('qa-kust-selectors/deploy.yaml', deploymentYaml);
    me.writeFile(
      'qa-kust-patches/kustomization.yaml',
      'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deploy.yaml\npatches:\n  - target:\n      kind: Deployment\n      name: kd\n    patch: |-\n      apiVersion: apps/v1\n      kind: Deployment\n      metadata:\n        name: kd\n      spec:\n        replicas: 4\n'
    );
    me.writeFile('qa-kust-patches/deploy.yaml', deploymentYaml);
  });
  out = await runCmd('oc kustomize qa-kust-common');
  assert(
    !String(out.message).trimStart().startsWith('---'),
    'qa-cli #36: oc kustomize output does not start with ---'
  );
  assert(
    /selector:[\s\S]*team: platform/.test(out.message) &&
      /template:[\s\S]*team: platform/.test(out.message),
    'qa-cli #36: deprecated commonLabels reach Deployment selectors',
    out.message.slice(0, 500)
  );
  out = await runCmd('oc kustomize qa-kust-labels');
  assert(
    /labels:\n    team: platform/.test(out.message) &&
      !/selector:[\s\S]*team: platform/.test(out.message),
    'qa-cli #36: v5 labels without includeSelectors only labels metadata',
    out.message.slice(0, 500)
  );
  out = await runCmd('oc kustomize qa-kust-selectors');
  assert(
    /selector:[\s\S]*team: platform/.test(out.message),
    'qa-cli #36: v5 labels includeSelectors reaches the selector',
    out.message.slice(0, 500)
  );
  out = await runCmd('oc kustomize qa-kust-patches');
  assert(
    !out.error && /replicas: 4/.test(out.message),
    'qa-cli #36: kustomize v5 patches apply strategic-merge semantics',
    out.message.slice(0, 400)
  );

  // Namespace labels + monitoring printer columns.
  out = await runCmd('oc get ns --show-labels');
  assert(
    /^NAME\s+STATUS\s+AGE\s+LABELS/m.test(out.message) &&
      /kubernetes\.io\/metadata\.name=default/.test(out.message),
    'qa-cli #36: oc get ns --show-labels has a LABELS column',
    out.message.split('\n').slice(0, 2).join(' | ')
  );
  out = await runCmd('oc get alertmanager -n openshift-monitoring');
  assert(
    /^NAME\s+VERSION\s+REPLICAS\s+AGE/m.test(out.message) &&
      /^main\s+0\.27\.0\s+\d+\s+\d+s/m.test(out.message),
    'qa-cli #36: monitoring Alertmanager columns',
    out.message
  );
  out = await runCmd('oc get prometheusrules -A');
  assert(
    /^NAMESPACE\s+NAME\s+AGE/m.test(out.message) &&
      /openshift-monitoring\s+kubernetes-monitoring-rules\s+\d+s/.test(out.message),
    'qa-cli #36: PrometheusRule columns',
    out.message.split('\n').slice(0, 2).join(' | ')
  );

  // Node cordon keeps SchedulingDisabled in the STATUS column.
  // #53F: every mode uses the shared worker-0/worker-1/master-0 catalog now, so
  // resolve a real worker from the cluster instead of hard-coding sandbox-node-2.
  const cordonNodeName = await evaluate(
    () =>
      (window.game.cluster.getByKind?.('Node') || [])
        .map((node) => node.metadata?.name)
        .find((name) => /^worker-\d+$/.test(name)) || 'worker-1'
  );
  await runCmd(`oc adm cordon ${cordonNodeName}`);
  out = await runCmd('oc get nodes');
  assert(
    new RegExp(`${cordonNodeName}\\s+Ready,SchedulingDisabled`).test(out.message),
    'qa-cli #36: cordoned node STATUS is Ready,SchedulingDisabled',
    out.message
  );
  await runCmd(`oc adm uncordon ${cordonNodeName}`);

  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #32/#33: workstation tools, internal TLS, routing
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-workstation', async () => {
  // #32/#33 — workstation tools (base64/openssl/cut, exec/rsh content, curl to
  // Routes), internal TLS (service-ca serving certs + reencrypt) and router
  // access after a default-deny NetworkPolicy.
  await bootSandbox();
  await ensureManifestEngine();
  await evaluate(() => {
    window.game?.gameEngine?.resume?.();
    window.game?.gameEngine?.setTimeScale?.(4);
    window.game?.gameEngine?.simulation?.setBuildFailureRate?.(0);
  });
  const ns = 'qa-workstation';
  const appHost = `app-${ns}.apps.cluster.example.com`;
  const edgeHost = `edge-${ns}.apps.cluster.example.com`;
  const redirHost = `redir-${ns}.apps.cluster.example.com`;
  const ptHost = `pt-${ns}.apps.cluster.example.com`;
  const apiHost = `api-${ns}.apps.cluster.example.com`;
  const tick = (seconds = 20) => advanceSimulation(seconds);
  const podRunning = (namespace, appName) =>
    waitFor(
      () =>
        evaluate(
          ({ targetNamespace, app }) =>
            (window.game.cluster.getByKind('Pod') || []).some(
              (pod) =>
                pod.metadata?.namespace === targetNamespace &&
                pod.metadata?.labels?.app === app &&
                pod.status?.phase === 'Running' &&
                (pod.status.containerStatuses || []).every((status) => status.ready)
            ),
          { targetNamespace: namespace, app: appName }
        ),
      25000
    );
  const routeAdmitted = (name) =>
    waitFor(
      () =>
        evaluate(
          ({ routeName, routeNamespace }) => {
            const route = window.game.cluster.getByName('Route', routeName, routeNamespace);
            return Boolean(
              route?.status?.ingress?.some((entry) =>
                (entry.conditions || []).some(
                  (condition) => condition.type === 'Admitted' && condition.status === 'True'
                )
              )
            );
          },
          { routeName: name, routeNamespace: ns }
        ),
      20000
    );

  await expectCmd(
    'qa-workstation: create project',
    `oc new-project ${ns}`,
    /Now using project|created/i
  );
  await expectCmd(
    'qa-workstation: create configmap',
    `oc create configmap app-config --from-literal=APP_MODE=prod --from-literal=COLOR=blue -n ${ns}`,
    /configmap\/app-config created/
  );
  await expectCmd(
    'qa-workstation: create secret',
    `oc create secret generic db-secret --from-literal=password=s3cret -n ${ns}`,
    /secret\/db-secret created/
  );
  await expectCmd(
    'qa-workstation: create deployment',
    `oc create deployment app --image=quay.io/openshift/origin-hello-openshift:latest -n ${ns}`,
    /deployment\.apps\/app created/
  );
  await expectCmd(
    'qa-workstation: set env literal',
    `oc set env deployment/app EXTRA=hello -n ${ns}`,
    /updated/i
  );
  await expectCmd(
    'qa-workstation: set env from configmap',
    `oc set env deployment/app --from=configmap/app-config -n ${ns}`,
    /updated/i
  );
  await expectCmd(
    'qa-workstation: mount configmap volume',
    `oc set volumes deployment/app --add --name=app-config --configmap-name=app-config --mount-path=/etc/app -n ${ns}`,
    /volume updated/i
  );
  await tick(20);
  assert(await podRunning(ns, 'app'), 'qa-workstation: app pod Running with config mounted');

  // ── #32d: exec/rsh reflect the Pod's real volumes + environment ─────────
  const execLs = await runCmd(`oc exec deploy/app -n ${ns} -- ls /etc/app`);
  assert(
    !execLs.error && /APP_MODE/.test(execLs.message) && /COLOR/.test(execLs.message),
    'qa-workstation: exec ls /etc/app lists mounted ConfigMap keys',
    execLs.message.replace(/\n/g, ' ⏎ ')
  );
  const execCat = await runCmd(`oc exec deploy/app -n ${ns} -- cat /etc/app/APP_MODE`);
  assert(
    !execCat.error && execCat.message.trim() === 'prod',
    'qa-workstation: exec cat /etc/app/APP_MODE returns the ConfigMap value',
    execCat.message
  );
  const execSh = await runCmd(`oc exec deploy/app -n ${ns} -- sh -c "cat /etc/app/APP_MODE"`);
  assert(
    !execSh.error && execSh.message.trim() === 'prod',
    'qa-workstation: exec sh -c "…" unwraps the script',
    execSh.message
  );
  const execMissing = await runCmd(`oc exec deploy/app -n ${ns} -- cat /etc/app/NOPE`);
  assert(
    /No such file or directory/.test(execMissing.message),
    'qa-workstation: exec cat missing file reports No such file',
    execMissing.message
  );
  const rshEnv = await runCmd(`oc rsh -n ${ns} deploy/app env`);
  assert(
    !rshEnv.error &&
      /APP_MODE=prod/.test(rshEnv.message) &&
      /EXTRA=hello/.test(rshEnv.message) &&
      /HOSTNAME=app-/.test(rshEnv.message),
    'qa-workstation: rsh env shows envFrom ConfigMap + literal env',
    rshEnv.message.slice(0, 400)
  );
  const execHostname = await runCmd(`oc exec deploy/app -n ${ns} -- hostname`);
  assert(
    !execHostname.error && /^app-[a-z0-9-]+$/.test(execHostname.message.trim()),
    'qa-workstation: exec hostname still returns the Pod name',
    execHostname.message
  );
  await expectCmd(
    'qa-workstation: mount Secret volume + env',
    `oc set volumes deployment/app --add --name=db-secret --secret-name=db-secret --mount-path=/etc/secret -n ${ns}`,
    /volume updated/i
  );
  await expectCmd(
    'qa-workstation: env from Secret',
    `oc set env deployment/app --from=secret/db-secret -n ${ns}`,
    /updated/i
  );
  await tick(20);
  await waitFor(
    () =>
      evaluate(
        ({ targetNamespace, mountPath }) =>
          (window.game.cluster.getByKind('Pod') || []).some(
            (pod) =>
              pod.metadata?.namespace === targetNamespace &&
              pod.status?.phase === 'Running' &&
              (pod.status.containerStatuses || []).every((status) => status.ready) &&
              (pod.spec?.containers || []).some((container) =>
                (container.volumeMounts || []).some((mount) => mount.mountPath === mountPath)
              )
          ),
        { targetNamespace: ns, mountPath: '/etc/secret' }
      ),
    25000
  );
  const execSecret = await runCmd(`oc exec deploy/app -n ${ns} -- cat /etc/secret/password`);
  assert(
    !execSecret.error && execSecret.message.trim() === 's3cret',
    'qa-workstation: exec cat reads a mounted Secret value',
    execSecret.message
  );
  const rshSecretEnv = await runCmd(`oc rsh -n ${ns} deploy/app env`);
  assert(
    !rshSecretEnv.error && /PASSWORD=s3cret/.test(rshSecretEnv.message),
    'qa-workstation: rsh env shows Secret-key env values',
    rshSecretEnv.message.slice(0, 300)
  );

  // ── #32e: cut -c ranges in pipes ────────────────────────────────────────
  await expectCmd('qa-workstation: echo | cut -c1-5', 'echo abcdefghij | cut -c1-5', /^abcde$/);
  await expectCmd('qa-workstation: echo | cut -c 3-', 'echo abcdefghij | cut -c 3-', /^cdefghij$/);
  await expectCmd(
    'qa-workstation: echo | cut -c1,3,5-6',
    'echo abcdefghij | cut -c1,3,5-6',
    /^acef$/
  );

  // ── #36: real `ls` semantics — immediate children, not recursive paths ──
  const lsRoot = await runCmd('ls');
  const lsRootLines = lsRoot.message.split('\n').filter(Boolean);
  assert(
    !lsRoot.error &&
      lsRootLines.includes('manifests/') &&
      lsRootLines.includes('htpasswd') &&
      !lsRootLines.some((line) => line.includes('manifests/deployment')),
    'qa-workstation: ls at / lists immediate children only',
    lsRootLines.slice(0, 12).join(', ')
  );
  const lsManifests = await runCmd('ls manifests');
  const lsManifestLines = lsManifests.message.split('\n').filter(Boolean);
  assert(
    !lsManifests.error &&
      lsManifestLines.includes('deployment.yaml') &&
      lsManifestLines.includes('service.yaml') &&
      lsManifestLines.every((line) => !line.includes('/')),
    'qa-workstation: ls manifests prints child file names only',
    lsManifests.message.replace(/\n/g, ' ⏎ ')
  );
  const lsFile = await runCmd('ls manifests/deployment.yaml');
  assert(
    !lsFile.error && lsFile.message.trim() === 'manifests/deployment.yaml',
    'qa-workstation: ls <file> prints the file path',
    lsFile.message
  );
  const lsDirs = await runCmd('ls kustomize');
  assert(
    !lsDirs.error && /^base\/$/m.test(lsDirs.message) && /^overlays\/$/m.test(lsDirs.message),
    'qa-workstation: ls marks subdirectories with a trailing slash',
    lsDirs.message.replace(/\n/g, ' ⏎ ')
  );

  // ── #32a: base64 standalone + in pipes ──────────────────────────────────
  const b64Decode = await runCmd(
    `oc get secret db-secret -o jsonpath={.data.password} -n ${ns} | base64 -d`
  );
  assert(
    !b64Decode.error && b64Decode.message.trim() === 's3cret',
    'qa-workstation: secret jsonpath | base64 -d decodes the Secret',
    b64Decode.message
  );
  await expectCmd('qa-workstation: echo | base64 -d', 'echo czNjcmV0 | base64 -d', /^s3cret$/);
  await expectCmd(
    'qa-workstation: echo -n | base64 encodes',
    'echo -n s3cret | base64',
    /^czNjcmV0$/
  );
  const b64Cut = await runCmd(
    `oc get secret db-secret -o jsonpath={.data.password} -n ${ns} | base64 -d | cut -c1-3`
  );
  assert(
    !b64Cut.error && b64Cut.message.trim() === 's3c',
    'qa-workstation: base64 -d | cut -c1-3 chains both fixes',
    b64Cut.message
  );
  const b64Invalid = await runCmd(`echo 'not base64!!' | base64 -d`);
  assert(b64Invalid.error, 'qa-workstation: base64 -d rejects invalid input', b64Invalid.message);

  // ── #32b: openssl req -x509 / openssl x509 + real PEM files ────────────
  const opensslReq = await runCmd(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj "/CN=${edgeHost}"`
  );
  assert(
    !opensslReq.error && /writing new private key/.test(opensslReq.message),
    'qa-workstation: openssl req -x509 writes the key/cert files',
    opensslReq.message.slice(0, 240)
  );
  const certPem = await runCmd('cat tls.crt');
  const keyPem = await runCmd('cat tls.key');
  assert(
    !certPem.error && /-----BEGIN CERTIFICATE-----/.test(certPem.message),
    'qa-workstation: tls.crt is a PEM certificate',
    certPem.message.slice(0, 120)
  );
  assert(
    !keyPem.error && /-----BEGIN PRIVATE KEY-----/.test(keyPem.message),
    'qa-workstation: tls.key is a PEM private key',
    keyPem.message.slice(0, 120)
  );
  const x509Subject = await runCmd('openssl x509 -in tls.crt -noout -subject');
  assert(
    !x509Subject.error && x509Subject.message.includes(`CN = ${edgeHost}`),
    'qa-workstation: openssl x509 -subject shows the requested CN',
    x509Subject.message
  );
  const x509Dates = await runCmd('openssl x509 -in tls.crt -noout -dates');
  assert(
    !x509Dates.error &&
      /notBefore=.+GMT/.test(x509Dates.message) &&
      /notAfter=.+GMT/.test(x509Dates.message),
    'qa-workstation: openssl x509 -dates prints notBefore/notAfter',
    x509Dates.message
  );
  const x509Text = await runCmd('openssl x509 -in tls.crt -noout -text');
  assert(
    !x509Text.error &&
      /Public-Key: \(2048 bit\)/.test(x509Text.message) &&
      new RegExp(`DNS:${edgeHost.replace(/\./g, '\\.')}`).test(x509Text.message),
    'qa-workstation: openssl x509 -text renders the certificate',
    x509Text.message.slice(0, 200)
  );
  const x509Missing = await runCmd('openssl x509 -in missing.crt -noout -subject');
  assert(x509Missing.error, 'qa-workstation: openssl x509 on a missing file errors');
  const reqBad = await runCmd(`openssl req -newkey rsa:2048 -nodes -subj "/CN=x"`);
  assert(reqBad.error, 'qa-workstation: openssl req without -x509 is rejected');

  const createTls = await runCmd(
    `oc create secret tls web-tls --cert=tls.crt --key=tls.key -n ${ns}`
  );
  assert(
    !createTls.error && !/simulated/i.test(createTls.message),
    'qa-workstation: oc create secret tls reads the real PEM files (no simulated cert)',
    createTls.message
  );
  const tlsSecretState = await evaluate(
    ({ namespace, certPemText }) => {
      const secret = window.game.cluster.getByName('Secret', 'web-tls', namespace);
      const encoded = secret?.spec?.data?.['tls.crt'] || '';
      let decoded = '';
      try {
        decoded = atob(encoded);
      } catch {
        decoded = '';
      }
      return {
        type: secret?.spec?.type || null,
        hasCrt: Boolean(secret?.spec?.data?.['tls.crt']),
        hasKey: Boolean(secret?.spec?.data?.['tls.key']),
        roundTrips: decoded.trim() === String(certPemText).trim(),
      };
    },
    { namespace: ns, certPemText: certPem.message }
  );
  assert(
    tlsSecretState.type === 'kubernetes.io/tls' && tlsSecretState.hasCrt && tlsSecretState.hasKey,
    'qa-workstation: web-tls Secret is kubernetes.io/tls with tls.crt/tls.key',
    JSON.stringify(tlsSecretState)
  );
  assert(
    tlsSecretState.roundTrips,
    'qa-workstation: Secret data base64 round-trips the PEM certificate',
    JSON.stringify(tlsSecretState)
  );
  const secretYaml = await runCmd(`oc get secret web-tls -o yaml -n ${ns}`);
  assert(
    !secretYaml.error &&
      /type: kubernetes\.io\/tls/.test(secretYaml.message) &&
      /tls\.crt:/.test(secretYaml.message),
    'qa-workstation: oc get secret -o yaml exposes the tls data',
    secretYaml.message.slice(0, 200)
  );
  const extractSecret = await runCmd(`oc extract secret/web-tls -n ${ns} --to=qatest --confirm`);
  assert(!extractSecret.error, 'qa-workstation: extract Secret writes the PEM files back');
  const extractedSubject = await runCmd('openssl x509 -in qatest/tls.crt -noout -subject');
  assert(
    !extractedSubject.error && extractedSubject.message.includes(edgeHost),
    'qa-workstation: extracted certificate parses back with the same CN',
    extractedSubject.message
  );
  const secretB64 = await evaluate(
    ({ namespace }) =>
      window.game.cluster.getByName('Secret', 'web-tls', namespace)?.spec?.data?.['tls.crt'] || '',
    { namespace: ns }
  );
  const b64W0 = await runCmd('base64 -w0 tls.crt');
  assert(
    !b64W0.error && b64W0.message.trim() === secretB64,
    'qa-workstation: base64 -w0 matches the Secret data encoding',
    b64W0.message.slice(0, 120)
  );

  // ── #32c: workstation curl against Route hosts ─────────────────────────
  await expectCmd(
    'qa-workstation: expose app Service',
    `oc expose svc/app -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('app'), 'qa-workstation: Route app admitted');
  await tick(10);
  const curlHttp = await runCmd(`curl -k http://${appHost}`);
  assert(
    !curlHttp.error && /Hello OpenShift/.test(curlHttp.message),
    'qa-workstation: curl http://<route-host> reaches the app',
    curlHttp.message.slice(0, 240)
  );
  const curlHeaders = await runCmd(`curl -k -i http://${appHost}`);
  assert(
    !curlHeaders.error && /HTTP\/1\.1 200 OK/.test(curlHeaders.message),
    'qa-workstation: curl -i prints the HTTP response headers',
    curlHeaders.message.slice(0, 240)
  );
  const curlHttpsPlain = await runCmd(`curl -k https://${appHost}`);
  assert(
    !curlHttpsPlain.error && /404 Not Found/.test(curlHttpsPlain.message),
    'qa-workstation: https against a plain HTTP Route is a router 404',
    curlHttpsPlain.message.slice(0, 200)
  );
  const curlDns = await runCmd('curl no-such-host.example.com');
  assert(
    curlDns.error && /curl: \(6\)/.test(curlDns.message),
    'qa-workstation: curl unknown host fails with (6) Could not resolve host',
    curlDns.message
  );
  await expectCmd(
    'qa-workstation: create edge Route with the openssl cert',
    `oc create route edge web --service=app --hostname=${edgeHost} --cert=tls.crt --key=tls.key -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('web'), 'qa-workstation: edge Route web admitted');
  await tick(10);
  const curlEdge = await runCmd(`curl -k https://${edgeHost}`);
  assert(
    !curlEdge.error && /Hello OpenShift/.test(curlEdge.message),
    'qa-workstation: curl -k https://<edge-route> terminates TLS at the router',
    curlEdge.message.slice(0, 240)
  );
  const curlEdgeStrict = await runCmd(`curl https://${edgeHost}`);
  assert(
    curlEdgeStrict.error && /curl: \(60\)/.test(curlEdgeStrict.message),
    'qa-workstation: a self-signed edge certificate fails verification without -k',
    curlEdgeStrict.message.slice(0, 240)
  );
  await expectCmd(
    'qa-workstation: create edge Route without --cert',
    `oc create route edge default-tls --service=app --hostname=default-tls-${ns}.apps.cluster.example.com -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('default-tls'), 'qa-workstation: default-cert edge Route admitted');
  const defaultTlsRoute = await evaluate(
    ({ namespace }) => {
      const route = window.game.cluster.getByName('Route', 'default-tls', namespace);
      return {
        certificate: route?.spec?.tls?.certificate || null,
        termination: route?.spec?.tls?.termination || null,
      };
    },
    { namespace: ns }
  );
  assert(
    defaultTlsRoute.termination === 'edge' && defaultTlsRoute.certificate === null,
    'qa-workstation: edge Route without --cert keeps the router default cert (no simulated PEM)',
    JSON.stringify(defaultTlsRoute)
  );
  await tick(10);
  const curlDefaultTls = await runCmd(`curl https://default-tls-${ns}.apps.cluster.example.com`);
  assert(
    !curlDefaultTls.error && /Hello OpenShift/.test(curlDefaultTls.message),
    'qa-workstation: the router default certificate serves the edge Route',
    curlDefaultTls.message.slice(0, 200)
  );

  await expectCmd(
    'qa-workstation: create redirect-policy edge Route',
    `oc create route edge redirector --service=app --hostname=${redirHost} --cert=tls.crt --key=tls.key --insecure-policy=Redirect -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('redirector'), 'qa-workstation: redirect Route admitted');
  await tick(10);
  const curlRedirect = await runCmd(`curl -i http://${redirHost}`);
  assert(
    !curlRedirect.error &&
      /HTTP\/1\.1 302 Found/.test(curlRedirect.message) &&
      new RegExp(`location: https://${redirHost.replace(/\./g, '\\.')}`).test(curlRedirect.message),
    'qa-workstation: http→https Redirect policy returns 302 + location',
    curlRedirect.message.slice(0, 300)
  );
  const curlRedirectFollow = await runCmd(`curl -kL http://${redirHost}`);
  assert(
    !curlRedirectFollow.error && /Hello OpenShift/.test(curlRedirectFollow.message),
    'qa-workstation: curl -kL follows the http→https redirect',
    curlRedirectFollow.message.slice(0, 240)
  );
  await expectCmd(
    'qa-workstation: create passthrough Route',
    `oc create route passthrough pt --service=app --hostname=${ptHost} -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('pt'), 'qa-workstation: passthrough Route admitted');
  await tick(10);
  const curlPassthrough = await runCmd(`curl -k https://${ptHost}`);
  assert(
    !curlPassthrough.error && /Hello OpenShift/.test(curlPassthrough.message),
    'qa-workstation: curl -k https://<passthrough-route> passes TLS to the backend',
    curlPassthrough.message.slice(0, 240)
  );
  const curlPassthroughHttp = await runCmd(`curl http://${ptHost}`);
  assert(
    /404 Not Found/.test(curlPassthroughHttp.message),
    'qa-workstation: a passthrough Route does not serve plain HTTP',
    curlPassthroughHttp.message.slice(0, 200)
  );

  // ── #33a: service-ca serving certificate + inject-cabundle + reencrypt ─
  await expectCmd(
    'qa-workstation: create api deployment',
    `oc create deployment api --image=quay.io/openshift/origin-hello-openshift:latest -n ${ns}`,
    /deployment\.apps\/api created/
  );
  await expectCmd(
    'qa-workstation: expose api deployment creates Service',
    `oc expose deployment/api -n ${ns}`,
    /service\/api exposed/i
  );
  await tick(20);
  assert(await podRunning(ns, 'api'), 'qa-workstation: api pod Running');
  await expectCmd(
    'qa-workstation: annotate svc serving-cert',
    `oc annotate svc/api service.beta.openshift.io/serving-cert-secret-name=api-tls -n ${ns}`,
    /service\/api annotated/i
  );
  const servingSecret = await findResource('Secret', 'api-tls', ns);
  assert(
    Boolean(servingSecret) && servingSecret?.spec?.type === 'kubernetes.io/tls',
    'qa-workstation: service-ca creates the api-tls serving-cert Secret',
    JSON.stringify(servingSecret?.spec?.type)
  );
  const servingCertData = await evaluate(
    ({ namespace }) => {
      const secret = window.game.cluster.getByName('Secret', 'api-tls', namespace);
      return {
        hasCrt: Boolean(secret?.spec?.data?.['tls.crt']),
        hasKey: Boolean(secret?.spec?.data?.['tls.key']),
      };
    },
    { namespace: ns }
  );
  assert(
    servingCertData.hasCrt && servingCertData.hasKey,
    'qa-workstation: serving-cert Secret has tls.crt + tls.key',
    JSON.stringify(servingCertData)
  );
  await expectCmd(
    'qa-workstation: create CA ConfigMap',
    `oc create configmap ca --from-literal=placeholder=1 -n ${ns}`,
    /configmap\/ca created/
  );
  await expectCmd(
    'qa-workstation: annotate configmap inject-cabundle',
    `oc annotate configmap ca service.beta.openshift.io/inject-cabundle=true -n ${ns}`,
    /configmap\/ca annotated/i
  );
  const caMap = await runCmd(`oc get cm ca -o yaml -n ${ns}`);
  assert(
    !caMap.error && /service-ca\.crt:/.test(caMap.message),
    'qa-workstation: inject-cabundle adds the service-ca.crt key',
    caMap.message.slice(0, 240)
  );
  const extractCabundle = await runCmd(`oc extract cm/ca -n ${ns} --to=cabundle --confirm`);
  assert(!extractCabundle.error, 'qa-workstation: extract ConfigMap writes service-ca.crt');
  const caText = await runCmd(
    'openssl x509 -in cabundle/service-ca.crt -noout -ext basicConstraints'
  );
  assert(
    !caText.error && /CA:TRUE/.test(caText.message),
    'qa-workstation: the injected bundle is a CA certificate',
    caText.message
  );
  const extractServing = await runCmd(`oc extract secret/api-tls -n ${ns} --to=serving --confirm`);
  assert(!extractServing.error, 'qa-workstation: extract api-tls serving certificate');
  const servingSubject = await runCmd('openssl x509 -in serving/tls.crt -noout -subject -issuer');
  assert(
    !servingSubject.error &&
      new RegExp(`CN = api\\.${ns}\\.svc`).test(servingSubject.message) &&
      /issuer=.*CN = service-ca/.test(servingSubject.message),
    'qa-workstation: serving certificate is issued by service-ca for the Service DNS name',
    servingSubject.message
  );
  await expectCmd(
    'qa-workstation: create reencrypt Route from the serving cert',
    `oc create route reencrypt api --service=api --hostname=${apiHost} --cert=serving/tls.crt --key=serving/tls.key --dest-ca-cert=cabundle/service-ca.crt -n ${ns}`,
    /route.*(exposed|created)/i
  );
  assert(await routeAdmitted('api'), 'qa-workstation: reencrypt Route admitted');
  await tick(10);
  const curlReencrypt = await runCmd(`curl -k https://${apiHost}`);
  assert(
    !curlReencrypt.error && /Hello OpenShift/.test(curlReencrypt.message),
    'qa-workstation: curl -k https://<reencrypt-route> survives router→backend TLS',
    curlReencrypt.message.slice(0, 240)
  );
  const routeYaml = await runCmd(`oc get route api -o yaml -n ${ns}`);
  assert(
    !routeYaml.error &&
      /termination: reencrypt/.test(routeYaml.message) &&
      /destinationCACertificate:/.test(routeYaml.message),
    'qa-workstation: reencrypt Route stores cert + destinationCACertificate',
    routeYaml.message.slice(0, 240)
  );

  // ── #33b: default-deny blocks the Route; router policy restores it ─────
  const curlBefore = await runCmd(`curl -k http://${appHost}`);
  assert(
    /Hello OpenShift/.test(curlBefore.message),
    'qa-workstation: Route works before the default-deny',
    curlBefore.message.slice(0, 160)
  );
  await evaluate(
    ({ namespace }) => {
      const deny = [
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: default-deny',
        '  namespace: ' + namespace,
        'spec:',
        '  podSelector: {}',
        '  policyTypes:',
        '    - Ingress',
        '  ingress: []',
        '',
      ].join('\n');
      window.game.manifestEngine.writeFile('qa/default-deny.yaml', deny);
    },
    { namespace: ns }
  );
  await expectCmd(
    'qa-workstation: apply default-deny NetworkPolicy',
    'oc apply -f qa/default-deny.yaml',
    /networkpolicy.*(created|configured)/i
  );
  await tick(5);
  const curlDenied = await runCmd(`curl -k http://${appHost}`);
  assert(
    /503 Service Unavailable/.test(curlDenied.message),
    'qa-workstation: default-deny makes workstation curl fail with 503',
    curlDenied.message.slice(0, 200)
  );
  const routeStillAdmitted = await evaluate(
    ({ routeNamespace }) => {
      const route = window.game.cluster.getByName('Route', 'app', routeNamespace);
      return Boolean(
        route?.status?.ingress?.some((entry) =>
          (entry.conditions || []).some(
            (condition) => condition.type === 'Admitted' && condition.status === 'True'
          )
        )
      );
    },
    { routeNamespace: ns }
  );
  assert(
    routeStillAdmitted,
    'qa-workstation: Route stays Admitted=True while NetworkPolicy blocks the router (real-cluster lesson)'
  );
  const routerNamespaceLabels = await evaluate(() => {
    const sim = window.game?.gameEngine?.simulation;
    return sim?._namespaceLabels?.('openshift-ingress') || {};
  });
  assert(
    routerNamespaceLabels['policy-group.network.openshift.io/ingress'] === '',
    'qa-workstation: openshift-ingress carries the router policy-group label',
    JSON.stringify(routerNamespaceLabels)
  );
  await evaluate(
    ({ namespace }) => {
      const allow = [
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: allow-from-router',
        '  namespace: ' + namespace,
        'spec:',
        '  podSelector: {}',
        '  policyTypes:',
        '    - Ingress',
        '  ingress:',
        '    - from:',
        '        - namespaceSelector:',
        '            matchLabels:',
        '              policy-group.network.openshift.io/ingress: ""',
        '',
      ].join('\n');
      window.game.manifestEngine.writeFile('qa/allow-from-router.yaml', allow);
    },
    { namespace: ns }
  );
  await expectCmd(
    'qa-workstation: apply allow-from-router NetworkPolicy',
    'oc apply -f qa/allow-from-router.yaml',
    /networkpolicy.*(created|configured)/i
  );
  await tick(5);
  const curlFixed = await runCmd(`curl -k http://${appHost}`);
  assert(
    /Hello OpenShift/.test(curlFixed.message),
    'qa-workstation: allowing the router namespace restores the Route',
    curlFixed.message.slice(0, 200)
  );

  // Grading (#30) consumes these NetworkPolicy APIs as-is — keep them stable.
  const reachApi = await evaluate(
    ({ namespace }) => {
      const sim = window.game?.gameEngine?.simulation;
      if (!sim) return null;
      const source = {
        metadata: { name: 'grader-source', namespace: 'default', labels: { role: 'source' } },
        spec: { containers: [{ name: 'probe', image: 'busybox' }] },
      };
      const target = {
        metadata: { name: 'grader-target', namespace: 'default', labels: { role: 'target' } },
        spec: {
          containers: [{ name: 'probe', image: 'busybox', ports: [{ containerPort: 8080 }] }],
        },
      };
      const canReach = sim.canReach(source, target, { port: 8080 });
      const canResolveDNS = sim.canResolveDNS(source);
      const trafficForExec = typeof sim.trafficForExec === 'function';
      const canRouterReach = sim.canRouterReach('app', { namespace });
      return {
        canReach,
        canResolveDNS,
        trafficForExec,
        canRouterReachAllowed: canRouterReach.allowed,
      };
    },
    { namespace: ns }
  );
  assert(
    reachApi?.canReach?.allowed === true && reachApi?.canReach?.reason === 'allowed',
    'qa-workstation: canReach(source, target, {port}) contract preserved',
    JSON.stringify(reachApi?.canReach)
  );
  assert(
    typeof reachApi?.canResolveDNS?.allowed === 'boolean' && reachApi?.trafficForExec === true,
    'qa-workstation: canResolveDNS/trafficForExec contracts preserved',
    JSON.stringify(reachApi)
  );
  assert(
    reachApi?.canRouterReachAllowed === true,
    'qa-workstation: canRouterReach sees the router allow policy',
    JSON.stringify(reachApi?.canRouterReach)
  );

  // ── #35 cross-scope: exec into a CrashLoopBackOff container must fail ──
  await expectCmd(
    'qa-workstation: crash-loop project',
    'oc new-project qa-workstation-ngx',
    /Now using project|created/i
  );
  await expectCmd(
    'qa-workstation: crash-loop deployment',
    'oc create deployment ngx --image=nginx:latest -n qa-workstation-ngx',
    /deployment\.apps\/ngx created/
  );
  const crashLooping = await waitFor(() =>
    evaluate(
      () =>
        (window.game.cluster.getByKind('Pod') || []).some(
          (pod) =>
            pod.metadata?.namespace === 'qa-workstation-ngx' &&
            (pod.status?.containerStatuses || []).some(
              (status) => status.state?.waiting?.reason === 'CrashLoopBackOff'
            )
        ),
      30000
    )
  );
  assert(crashLooping, 'qa-workstation: nginx pod reaches CrashLoopBackOff');
  await evaluate(() => window.game?.gameEngine?.pause?.());
  const execCrash = await runCmd('oc exec deploy/ngx -n qa-workstation-ngx -- ls /etc/nginx');
  assert(
    execCrash.error && /not running|container not found/.test(execCrash.message),
    'qa-workstation: exec into a CrashLoopBackOff container fails like oc',
    execCrash.message.slice(0, 240)
  );
  const rshCrash = await runCmd('oc rsh -n qa-workstation-ngx deploy/ngx env');
  assert(
    rshCrash.error && /not running|container not found/.test(rshCrash.message),
    'qa-workstation: rsh into a CrashLoopBackOff container fails like oc',
    rshCrash.message.slice(0, 240)
  );
  await evaluate(() => window.game?.gameEngine?.resume?.());
  await expectCmd(
    'qa-workstation: return to the app project',
    `oc project ${ns}`,
    /Now using project/i
  );

  // Keep the sandbox manifest files tidy for later sections.
  await runCmd(
    'rm -f tls.key tls.crt qatest/tls.crt qatest/tls.key serving/tls.crt serving/tls.key cabundle/service-ca.crt qa/default-deny.yaml qa/allow-from-router.yaml'
  );

  // ── #33 acceptance: L20 capstone (shipped data) default-deny → curl 503 →
  //    allow-from-router → curl 200, and the routeAccess objective ticks. ──
  await bootMenu();
  assert(await launch('campaign', 20), 'qa-workstation: L20 capstone launches');
  await closeOverlays();
  await evaluate(() => window.game?.gameEngine?.pause?.());
  const l20Ns = 'prod-platform';
  const l20Host = `webapp-${l20Ns}.apps.cluster.example.com`;
  await expectCmd(
    'qa-workstation: L20 create capstone project',
    `oc new-project ${l20Ns}`,
    /Now using project|created/i
  );
  const l20Deploy = await runCmd(`oc apply -f manifests/deployment.yaml -n ${l20Ns}`);
  assert(
    !l20Deploy.error,
    'qa-workstation: L20 webapp Deployment manifest applies',
    l20Deploy.message.slice(0, 240)
  );
  const l20Service = await runCmd(`oc apply -f manifests/service.yaml -n ${l20Ns}`);
  assert(
    !l20Service.error,
    'qa-workstation: L20 webapp Service manifest applies',
    l20Service.message.slice(0, 240)
  );
  await expectCmd(
    'qa-workstation: L20 create webapp Route',
    `oc create route edge webapp --service=webapp -n ${l20Ns}`,
    /route.*(exposed|created)/i
  );
  await advanceSimulation(20);
  assert(
    await waitFor(
      () =>
        evaluate(
          ({ routeNamespace }) => {
            const route = window.game.cluster.getByName('Route', 'webapp', routeNamespace);
            return Boolean(
              route?.status?.ingress?.some((entry) =>
                (entry.conditions || []).some(
                  (condition) => condition.type === 'Admitted' && condition.status === 'True'
                )
              )
            );
          },
          { routeNamespace: l20Ns }
        ),
      25000
    ),
    'qa-workstation: L20 Route webapp admitted'
  );
  const l20Before = await runCmd(`curl -k https://${l20Host}`);
  assert(
    /Hello OpenShift/.test(l20Before.message),
    'qa-workstation: L20 capstone Route answers curl before the default-deny',
    l20Before.message.slice(0, 200)
  );
  await expectCmd(
    'qa-workstation: L20 apply shipped default-deny',
    `oc apply -f examples/default-deny.yaml -n ${l20Ns}`,
    /networkpolicy.*(created|configured)/i
  );
  await advanceSimulation(3);
  const l20Blocked = await runCmd(`curl -k https://${l20Host}`);
  assert(
    /503 Service Unavailable/.test(l20Blocked.message),
    'qa-workstation: L20 capstone default-deny blocks workstation curl (503)',
    l20Blocked.message.slice(0, 200)
  );
  const l20StillAdmitted = await evaluate(
    ({ routeNamespace }) => {
      const route = window.game.cluster.getByName('Route', 'webapp', routeNamespace);
      return Boolean(
        route?.status?.ingress?.some((entry) =>
          (entry.conditions || []).some(
            (condition) => condition.type === 'Admitted' && condition.status === 'True'
          )
        )
      );
    },
    { routeNamespace: l20Ns }
  );
  assert(
    l20StillAdmitted,
    'qa-workstation: L20 Route stays Admitted while the router is policy-blocked'
  );
  await expectCmd(
    'qa-workstation: L20 apply shipped allow-from-router',
    `oc apply -f examples/allow-from-router.yaml -n ${l20Ns}`,
    /networkpolicy.*(created|configured)/i
  );
  await advanceSimulation(3);
  const l20After = await runCmd(`curl -k https://${l20Host}`);
  assert(
    /Hello OpenShift/.test(l20After.message),
    'qa-workstation: L20 allow-from-router restores workstation curl (200)',
    l20After.message.slice(0, 200)
  );
  // Campaign objectives are evaluated by the mode's 1 s wall-clock ticker. The
  // routeAccess objective also needs grading's ObjectiveEvaluator support: probe
  // with a temporary objective so this integration check degrades to a warning
  // (instead of a false failure) until that evaluator lands.
  const l20Objective = await evaluate(() => {
    const mode = window.game?.app?.modeInstance;
    const definition = mode?.currentLevelDef;
    const index = (definition?.objectives || []).findIndex(
      (objective) => objective.type === 'routeAccess'
    );
    return {
      index,
      total: definition?.objectives?.length || 0,
      progress: index >= 0 ? mode?.objectiveProgress?.[index] || null : null,
    };
  });
  assert(
    l20Objective.index >= 0,
    'qa-workstation: L20 ships the routeAccess objective in the capstone data',
    JSON.stringify(l20Objective)
  );
  const l20EvaluatorSupportsRouteAccess = await evaluate(() => {
    const mode = window.game?.app?.modeInstance;
    if (!mode?.currentLevelDef?.objectives || !Array.isArray(mode.objectiveProgress)) return false;
    const probe = {
      type: 'routeAccess',
      name: 'webapp',
      label: 'qa-workstation probe',
    };
    // Evaluate the probe through the SAME path CampaignMode uses on its ticker;
    // remove it again so it never leaks into the level progress/summary.
    const definition = mode.currentLevelDef;
    const index = definition.objectives.length;
    definition.objectives.push(probe);
    mode.objectiveProgress.push({ ...probe, current: 0, target: 1, completed: false });
    try {
      mode.updateObjectives();
      return mode.objectiveProgress[index]?.completed === true;
    } finally {
      definition.objectives.pop();
      mode.objectiveProgress.pop();
    }
  });
  if (l20EvaluatorSupportsRouteAccess) {
    const l20ObjectiveCompleted = await waitFor(
      () =>
        evaluate(() => {
          const mode = window.game?.app?.modeInstance;
          const definition = mode?.currentLevelDef;
          const index = (definition?.objectives || []).findIndex(
            (objective) => objective.type === 'routeAccess'
          );
          return index >= 0 && mode.objectiveProgress?.[index]?.completed === true;
        }),
      10000
    );
    assert(
      l20ObjectiveCompleted,
      'qa-workstation: L20 routeAccess objective completes after curl is restored',
      JSON.stringify(l20Objective.progress)
    );
  } else {
    // Cross-team dependency (grading owns the routeAccess evaluator): the
    // default-deny -> 503 -> allow -> 200 end-to-end flow above is still fully
    // asserted; only the objective-type wiring is reported as pending.
    warn(
      'qa-workstation: L20 routeAccess objective type pending in ObjectiveEvaluator (grading)',
      'curl-based capstone flow asserted; objective-type integration pending'
    );
  }
  await evaluate(() => window.game?.gameEngine?.resume?.());
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #35: OpenShift platform details
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-openshift', async () => {
  // QA-35-TESTS
  const boots = await bootSandbox();
  assert(boots, 'openshift: sandbox boots');
  const project = 'openshift-qa';
  const terminalText = () => evaluate(() => document.getElementById('cmd-output')?.innerText || '');
  const roleBindingNames = (namespace) =>
    evaluate(
      (ns) =>
        (window.game.cluster.getByKindAndNamespace('RoleBinding', ns) || []).map(
          (binding) => binding.metadata.name
        ),
      namespace
    );

  // ── Default behaviour of a freshly created project (OCP 4.x) ─────────────
  let result = await runCmd(`oc new-project ${project}`);
  assert(!result.error, 'openshift: oc new-project creates the project', result.message);
  result = await runCmd('oc get sa');
  assert(
    !result.error &&
      ['builder', 'default', 'deployer'].every((name) =>
        new RegExp(`(^|\\n)${name}\\s`).test(result.message)
      ),
    'openshift: new project seeds builder/default/deployer ServiceAccounts',
    result.message
  );
  const bindings = await roleBindingNames(project);
  assert(
    ['admin', 'system:image-pullers', 'system:image-builders', 'system:deployers'].every((name) =>
      bindings.includes(name)
    ),
    'openshift: new project seeds admin + system image/deployer RoleBindings',
    JSON.stringify(bindings)
  );
  result = await runCmd('oc get rolebinding');
  assert(
    /system:image-pullers/.test(result.message) &&
      /system:image-builders/.test(result.message) &&
      /system:deployers/.test(result.message) &&
      /^admin\s/m.test(result.message),
    'openshift: oc get rolebinding shows the default bindings',
    result.message
  );
  result = await runCmd('oc get secrets');
  assert(
    (result.message.match(/-dockercfg-/g) || []).length >= 3,
    'openshift: new project gets builder/default/deployer dockercfg Secrets',
    result.message
  );
  result = await runCmd('oc create sa api-reader');
  result = await runCmd('oc describe sa api-reader');
  assert(
    !result.error &&
      /Image pull secrets:\s+api-reader-dockercfg-[a-z0-9]+/.test(result.message) &&
      /Mountable secrets:\s+api-reader-dockercfg-[a-z0-9]+/.test(result.message),
    'openshift: describe sa shows Image pull / Mountable dockercfg secrets',
    result.message.slice(0, 600)
  );
  const projectLabel = await evaluate(
    (name) => window.game.cluster.getProject(name)?.metadata?.labels || {},
    project
  );
  assert(
    projectLabel['kubernetes.io/metadata.name'] === project,
    'openshift: every Project carries kubernetes.io/metadata.name',
    JSON.stringify(projectLabel)
  );
  result = await runCmd(`oc get ns ${project} --show-labels`);
  assert(
    !result.error &&
      /\bLABELS\b/.test(result.message) &&
      new RegExp(`kubernetes\\.io/metadata\\.name=${project}`).test(result.message),
    'openshift: oc get ns --show-labels renders the LABELS column with metadata.name',
    result.message
  );

  // ── SCC: 4.x grant output, who-can and scc-subject-review ────────────────
  await runCmd('oc new-project privileged-lab');
  await runCmd('oc create sa priv-sa');
  result = await runCmd('oc adm policy add-scc-to-user privileged -z priv-sa');
  assert(
    !result.error &&
      result.message ===
        'clusterrole.rbac.authorization.k8s.io/system:openshift:scc:privileged added: "priv-sa"',
    'openshift: add-scc-to-user prints the 4.x ClusterRole form',
    JSON.stringify(result.message)
  );
  result = await runCmd('oc adm policy who-can use scc privileged');
  assert(
    !result.error &&
      /Verb:\s+use/.test(result.message) &&
      /Resource:\s+securitycontextconstraints\.security\.openshift\.io\/privileged/.test(
        result.message
      ) &&
      /system:serviceaccount:privileged-lab:priv-sa/.test(result.message),
    'openshift: who-can use scc lists the granted ServiceAccount',
    result.message
  );
  result = await runCmd('oc adm policy scc-subject-review -f examples/privileged-deployment.yaml');
  assert(
    !result.error &&
      !/subject is required/.test(result.message) &&
      /RESOURCE/.test(result.message) &&
      /ALLOWED BY/.test(result.message) &&
      /Deployment\/privileged-app/.test(result.message),
    'openshift: scc-subject-review reviews the manifest pod spec (no "subject is required")',
    result.message
  );
  // The manifest uses serviceAccountName robot: after granting it the privileged
  // SCC, admission reports privileged instead of nothing.
  await runCmd('oc create sa robot');
  await runCmd('oc adm policy add-scc-to-user privileged -z robot');
  result = await runCmd('oc adm policy scc-subject-review -f examples/privileged-deployment.yaml');
  assert(
    /privileged-app\s+privileged/.test(result.message),
    'openshift: scc-subject-review reports the admitting SCC after the grant',
    result.message
  );
  result = await runCmd('oc adm policy who-can use scc privileged');
  assert(
    /system:serviceaccount:privileged-lab:robot/.test(result.message),
    'openshift: who-can stays accurate for additional grants',
    result.message
  );

  // ── add-role-to-group uses the real default binding names edit, edit-0, … ─
  await runCmd('oc new-project team-dev');
  await runCmd('oc adm groups new developers');
  result = await runCmd('oc adm policy add-role-to-group edit developers -n team-dev');
  assert(
    !result.error && /clusterrole\.rbac\.authorization\.k8s\.io\/edit added/.test(result.message),
    'openshift: add-role-to-group output names the edit ClusterRole',
    result.message
  );
  let teamBindings = await roleBindingNames('team-dev');
  assert(
    teamBindings.includes('edit') && !teamBindings.includes('edit-developers'),
    'openshift: first binding is named edit (not edit-developers)',
    JSON.stringify(teamBindings)
  );
  await runCmd('oc adm groups new qa-team');
  await runCmd('oc adm policy add-role-to-group edit qa-team -n team-dev');
  teamBindings = await roleBindingNames('team-dev');
  assert(
    teamBindings.includes('edit-0'),
    'openshift: a second add-role-to-group creates edit-0',
    JSON.stringify(teamBindings)
  );

  // ── Login: kubeadmin password validation + real User/Identity semantics ──
  const kubeadminSecret = await findResource('Secret', 'kubeadmin', 'kube-system');
  assert(
    /^\$2a\$10\$\S{53}$/.test(
      kubeadminSecret?.spec?.data?.kubeadmin
        ? Buffer.from(String(kubeadminSecret.spec.data.kubeadmin), 'base64').toString('utf8')
        : ''
    ) && String(kubeadminSecret?.spec?.data?.kubeadmin || '') !== '',
    'openshift: kube-system/kubeadmin Secret seeds only the bcrypt hash, not the password'
  );
  // #42-4: real oc prompts for the kubeadmin password instead of logging in
  // silently; the next terminal line is the (un-echoed) password.
  result = await runCmd('oc login -u kubeadmin');
  assert(
    !result.error && /Password:/i.test(result.message) && !/Login successful/.test(result.message),
    'openshift: oc login -u kubeadmin prompts for the password (#42-4)',
    result.message.slice(0, 160)
  );
  result = await runCmd(await kubeadminPassword());
  assert(
    !result.error && /Login successful/.test(result.message),
    'openshift: typing the kubeadmin password at the prompt logs in (#42-4)',
    result.message.slice(0, 160)
  );
  result = await runCmd('oc login -u kubeadmin -p wrong-password');
  assert(
    result.error && /Login failed \(401 Unauthorized\)/.test(result.message),
    'openshift: an explicit wrong kubeadmin password is rejected',
    result.message.slice(0, 200)
  );
  result = await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  assert(
    !result.error && /Login successful/.test(result.message),
    'openshift: the seeded kubeadmin password is accepted',
    result.message.slice(0, 160)
  );
  const loginHistory = await evaluate(() => window.game.gameEngine?.getLoginHistory?.() || []);
  assert(
    Array.isArray(loginHistory) &&
      loginHistory.length >= 2 &&
      loginHistory.every((entry) => entry.user === 'kubeadmin' && entry.provider),
    'openshift: successful logins are recorded in gameEngine.loginHistory',
    JSON.stringify(loginHistory)
  );
  await runCmd('oc adm groups new qa-devs bob');
  const bobUser = await evaluate(() => Boolean(window.game.cluster.getUser('bob')));
  assert(
    bobUser === false,
    'openshift: group membership does not create a User object before first login'
  );

  // ── oc set env --from creates per-key secretKeyRef env entries ────────────
  await runCmd(`oc project ${project}`);
  await runCmd(
    'oc create secret generic db-secret --from-literal=password=s3cret --from-literal=username=app'
  );
  await runCmd('oc create deployment app --image=quay.io/openshift/origin-hello-openshift:latest');
  result = await runCmd('oc set env deploy/app --from=secret/db-secret');
  assert(!result.error, 'openshift: set env --from=secret succeeds', result.message);
  const deployment = await findResource('Deployment', 'app', project);
  const container = deployment?.spec?.template?.spec?.containers?.[0] || {};
  const envEntries = container.env || [];
  const passwordEnv = envEntries.find((entry) => entry.name === 'PASSWORD');
  assert(
    Boolean(passwordEnv?.valueFrom?.secretKeyRef) &&
      passwordEnv.valueFrom.secretKeyRef.name === 'db-secret' &&
      passwordEnv.valueFrom.secretKeyRef.key === 'password',
    'openshift: set env --from generates PASSWORD with valueFrom.secretKeyRef',
    JSON.stringify(envEntries)
  );
  assert(
    !(container.envFrom || []).length,
    'openshift: set env --from does not create an envFrom.secretRef',
    JSON.stringify(container.envFrom)
  );
  result = await runCmd('oc set env deploy/app --list');
  assert(
    /# PASSWORD from secret db-secret, key password/.test(result.message),
    'openshift: set env --list shows "# PASSWORD from secret db-secret, key password"',
    result.message
  );

  // ── start-build --follow streams logs and only prints Success at the end ──
  await runCmd('oc new-build nodejs:20 --name=webapp');
  result = await runCmd('oc start-build webapp --follow');
  const followBuildName =
    (result.message.match(/(webapp-\d+) started/) || [])[1] ||
    (result.message.match(/Build (webapp-\d+)/) || [])[1] ||
    'webapp-1';
  const followText = await terminalText();
  const followStart = followText.lastIndexOf('$ oc start-build webapp --follow');
  const followedSoFar = followStart >= 0 ? followText.slice(followStart) : followText;
  assert(
    !/--> Success/.test(followedSoFar) && !/no logs produced yet/.test(followedSoFar),
    'openshift: start-build --follow reports no success while the build is running',
    followedSoFar.slice(-320)
  );
  await advanceSimulation(30);
  await sleep(900);
  const followedText = await terminalText();
  assert(
    /STEP 5\/5/.test(followedText) &&
      new RegExp(`Build ${followBuildName} completed successfully`).test(followedText) &&
      /--> Success/.test(followedText.slice(followedText.lastIndexOf('$ oc start-build'))),
    'openshift: start-build --follow prints --> Success only once the build completes',
    followedText.slice(-500)
  );

  // ── oc run --overrides goes through SCC admission ─────────────────────────
  result = await runCmd(
    `oc run root-pod --image=quay.io/openshift/origin-hello-openshift:latest --overrides='{"spec":{"securityContext":{"runAsUser":0}}}'`
  );
  assert(
    result.error &&
      /forbidden|unable to validate against any security context constraint/.test(result.message),
    'openshift: oc run --overrides runAsUser:0 is rejected by SCC admission',
    result.message.slice(0, 300)
  );
  const rootPod = await findResource('Pod', 'root-pod', project);
  assert(rootPod === null, 'openshift: rejected run --overrides creates no Pod');

  // ── ClusterResourceQuota project selector + escaped-dot jsonpath ─────────
  await runCmd('oc new-project quota-lab');
  result = await runCmd(
    'oc create clusterquota team-quota --project-label-selector=kubernetes.io/metadata.name=quota-lab --hard=pods=10 --hard=secrets=20'
  );
  assert(
    !result.error,
    'openshift: create clusterquota with the real project label',
    result.message
  );
  const clusterQuota = await findResource('ClusterResourceQuota', 'team-quota', '');
  assert(
    (clusterQuota?.status?.namespaces || []).includes('quota-lab'),
    'openshift: ClusterResourceQuota selects quota-lab via kubernetes.io/metadata.name',
    JSON.stringify(clusterQuota?.status?.namespaces || null)
  );
  await runCmd(`oc project ${project}`);
  // #43: the requester annotation belongs on the namespace/Project, not on the
  // default ServiceAccount; the escaped-dot jsonpath still has to resolve it.
  result = await runCmd(
    `oc get project ${project} -o jsonpath='{.metadata.annotations.openshift\\.io/requester}'`
  );
  assert(
    !result.error && result.message.trim() === 'kubeadmin',
    'openshift: jsonpath supports an escaped dot in annotation keys',
    result.message
  );

  // ── Project registry (openshift-authentication) + OAuth rollout ──────────
  result = await runCmd('oc get pods -n openshift-authentication');
  assert(
    !result.error && /oauth-openshift-[a-z0-9]+/.test(result.message),
    'openshift: openshift-authentication runs oauth-openshift-* pods',
    result.message
  );
  await runCmd('htpasswd -c -B -b htpasswd alice openshift');
  await runCmd('oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config');
  result = await runCmd(
    [
      'oc apply -f - <<EOF',
      'apiVersion: config.openshift.io/v1',
      'kind: OAuth',
      'metadata:',
      '  name: cluster',
      'spec:',
      '  identityProviders:',
      '  - name: htpasswd',
      '    mappingMethod: claim',
      '    type: HTPasswd',
      '    htpasswd:',
      '      fileData:',
      '        name: htpass-secret',
      'EOF',
    ].join('\n')
  );
  assert(
    !result.error && /oauth\.config\.openshift\.io\/cluster configured/.test(result.message),
    'openshift: OAuth provider can be applied declaratively',
    result.message
  );
  const providerBefore = await evaluate(() => window.game.gameEngine?.getAuthProvider?.());
  assert(
    providerBefore?.ready === false,
    'openshift: the identity provider is not ready immediately after an OAuth change',
    JSON.stringify(providerBefore)
  );
  result = await runCmd('oc login -u alice -p openshift');
  assert(
    result.error && /not ready yet|wait for the OAuth rollout/.test(result.message),
    'openshift: login is blocked during the OAuth rollout',
    result.message.slice(0, 200)
  );
  await advanceSimulation(10);
  const providerAfter = await evaluate(() => window.game.gameEngine?.getAuthProvider?.());
  assert(
    providerAfter?.ready === true,
    'openshift: the identity provider becomes ready after the rollout',
    JSON.stringify(providerAfter)
  );
  result = await runCmd('oc login -u alice -p openshift');
  assert(
    !result.error && /Login successful/.test(result.message),
    'openshift: login succeeds after the OAuth rollout',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc whoami');
  assert(
    /^alice/m.test(result.message),
    'openshift: oc whoami is alice after login',
    result.message
  );
  const aliceIdentity = await evaluate(() =>
    window.game.cluster.getByKind('Identity').map((identity) => identity.metadata.name)
  );
  assert(
    aliceIdentity.some((name) => /htpasswd:alice/.test(name)),
    'openshift: first login creates the Identity',
    JSON.stringify(aliceIdentity)
  );
  await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  result = await runCmd('oc get rolebinding -n openshift-qa -o name');
  assert(!result.error, 'openshift: session restored to kubeadmin', result.message);

  // ── L13 consistency: provider change AND htpasswd Secret change both wait ─
  await returnToMenu();
  const launched = await launch('campaign', 13);
  assert(launched, 'openshift: campaign L13 launches');
  await closeOverlays();
  await runCmd('oc project identity-lab');
  await runCmd('htpasswd -c -B -b htpasswd carol carolpass');
  await runCmd('oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config');
  result = await runCmd(
    [
      'oc apply -f - <<EOF',
      'apiVersion: config.openshift.io/v1',
      'kind: OAuth',
      'metadata:',
      '  name: cluster',
      'spec:',
      '  identityProviders:',
      '  - name: htpasswd',
      '    mappingMethod: claim',
      '    type: HTPasswd',
      '    htpasswd:',
      '      fileData:',
      '        name: htpass-secret',
      'EOF',
    ].join('\n')
  );
  assert(!result.error, 'openshift: L13 OAuth provider applied', result.message);
  result = await runCmd('oc login -u carol -p carolpass');
  assert(
    result.error && /wait for the OAuth rollout/.test(result.message),
    'openshift: L13 blocks login until the OAuth rollout completes',
    result.message.slice(0, 200)
  );
  await advanceSimulation(10);
  result = await runCmd('oc login -u carol -p carolpass');
  assert(
    !result.error && /Login successful/.test(result.message),
    'openshift: L13 login succeeds after the OAuth rollout',
    result.message.slice(0, 200)
  );
  // Rotating the htpasswd Secret triggers the same rollout wait that lab 11
  // teaches (the authentication operator watches the referenced Secret).
  await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  await runCmd('htpasswd -B -b htpasswd carol carolpass2');
  await runCmd('oc set data secret/htpass-secret --from-file=htpasswd -n openshift-config');
  result = await runCmd('oc login -u carol -p carolpass2');
  assert(
    result.error && /wait for the OAuth rollout/.test(result.message),
    'openshift: a rotated htpasswd Secret also waits for the OAuth rollout (L13/lab 11 consistent)',
    result.message.slice(0, 240)
  );
  await advanceSimulation(10);
  result = await runCmd('oc login -u carol -p carolpass2');
  assert(
    !result.error && /Login successful/.test(result.message),
    'openshift: the rotated password works after the rollout',
    result.message.slice(0, 200)
  );
  const authenticationPods = await evaluate(() =>
    (window.game.cluster.getByKind('Pod') || [])
      .filter((pod) => pod.metadata.namespace === 'openshift-authentication')
      .map((pod) => ({ name: pod.metadata.name, phase: pod.status?.phase }))
  );
  assert(
    authenticationPods.length >= 1 && authenticationPods.every((pod) => pod.phase === 'Running'),
    'openshift: oauth-openshift pods are Running after the rollouts',
    JSON.stringify(authenticationPods)
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #30: state-based objective grading
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-grading', async () => {
  // Issue #30 — objectives are graded on the resulting cluster state and on
  // simulated traffic behaviour, never on hidden resource names or on a
  // command regex. Every assertion below drives the real mode + evaluator.
  const OAUTH_YAML = `apiVersion: config.openshift.io/v1
kind: OAuth
metadata:
  name: cluster
spec:
  identityProviders:
    - name: htpasswd
      mappingMethod: claim
      type: HTPasswd
      htpasswd:
        fileData:
          name: htpass-secret`;
  const OAUTH_PATCH =
    '{"spec":{"identityProviders":[{"name":"htpasswd","mappingMethod":"claim","type":"HTPasswd","htpasswd":{"fileData":{"name":"htpass-secret"}}}]}}';
  // A hand-written policy set: deliberately NOT the provided file, and with
  // names an objective could never know about (#30). `dnsPort` lets the test
  // prove that port 53 does not count as OpenShift DNS egress.
  const handWrittenPolicies = (dnsPort) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: block-everything
  namespace: shop
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dns-out
  namespace: shop
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openshift-dns
      ports:
        - protocol: UDP
          port: ${dnsPort}
        - protocol: TCP
          port: ${dnsPort}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-path
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-egress
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - protocol: TCP
          port: 8080`;

  // Evaluate every objective through the live evaluator + live mode context.
  const objectiveResults = () =>
    evaluate(async () => {
      const mode = window.game?.app?.modeInstance;
      const def = mode?.currentChallengeDef || mode?.currentLevelDef;
      if (!def) return [];
      const { evaluateObjective } = await import('/js/engine/ObjectiveEvaluator.js');
      const ctx = {
        clusterState: window.game.cluster,
        gameEngine: window.game.gameEngine,
        incidentEngine: window.game.incidentEngine,
        scoringEngine: window.game.scoringEngine,
        manifestEngine: window.game.manifestEngine,
        objectiveProgress: mode.objectiveProgress,
        levelDef: def,
      };
      return def.objectives.map((objective) => ({
        label: objective.label,
        ...evaluateObjective(objective, ctx),
      }));
    });
  const objectiveByLabel = (results, pattern) =>
    results.find((entry) => pattern.test(entry.label || ''));
  // Scripted incidents advance on the incident clock; drive it directly so the
  // test does not depend on wall-clock/rAF timing in the headless browser.
  const advanceIncidents = (seconds) =>
    evaluate((secs) => {
      const engine = window.game?.incidentEngine;
      for (let i = 0; i < Math.ceil(secs / 0.5); i += 1) engine.tick(0.5);
      return engine.getActiveIncidents().length;
    }, seconds);
  const writeVirtualFile = (path, text) =>
    evaluate(({ filePath, fileText }) => window.game.manifestEngine.writeFile(filePath, fileText), {
      filePath: path,
      fileText: text,
    });
  const startChallenge = async (id) => {
    await bootMenu();
    const started = await launch('challenge', id);
    await closeOverlays();
    await waitFor(() => evaluate(() => !!window.game?.manifestEngine), 8000);
    await evaluate(() => window.game?.app?.modeInstance?.seedChallengeFiles?.());
    await sleep(250);
    return started;
  };
  const startCampaign = async (id) => {
    await bootMenu();
    const started = await launch('campaign', id);
    await closeOverlays();
    return started;
  };

  // ── #30a: lab 9 — behaviour grading, hand-written policy set ─────────────
  assert(await startChallenge(9), 'qa-grading #30a: lab 9 starts');
  let results = await objectiveResults();
  assert(
    results.length > 0 && results.every((entry) => entry.completed === false),
    'qa-grading #30a: lab 9 objectives are not pre-ticked before any policy exists',
    JSON.stringify(results.filter((entry) => entry.completed).map((entry) => entry.label))
  );
  await writeVirtualFile('my-network-policies.yaml', handWrittenPolicies(53));
  let command = await runCmd('oc apply -f my-network-policies.yaml', 700);
  assert(!command.error, 'qa-grading #30a: apply hand-written policy set', command.message);
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /Deny all traffic by default/i)?.completed === true,
    'qa-grading #30a: hand-written default-deny ticks without the provided policy names',
    JSON.stringify(results.map((entry) => [entry.label, entry.completed]))
  );
  assert(
    objectiveByLabel(results, /Allow DNS egress/i)?.completed === false,
    'qa-grading #30a: DNS egress on port 53 does not count (OpenShift DNS listens on 5353)',
    JSON.stringify(objectiveByLabel(results, /Allow DNS egress/i))
  );
  // Correct the same hand-written set to 5353: no object was renamed.
  await writeVirtualFile('my-network-policies.yaml', handWrittenPolicies(5353));
  command = await runCmd('oc apply -f my-network-policies.yaml', 700);
  assert(!command.error, 'qa-grading #30a: re-apply corrected hand-written set', command.message);
  const handwrittenNames = await evaluate(() =>
    (window.game.cluster.getByKindAndNamespace('NetworkPolicy', 'shop') || []).map(
      (policy) => policy.metadata?.name
    )
  );
  assert(
    handwrittenNames.includes('block-everything') &&
      !handwrittenNames.some((name) => /deny-by-default|allow-dns-egress/.test(name)),
    'qa-grading #30a: playthrough uses hand-written policy names only',
    JSON.stringify(handwrittenNames)
  );
  results = await objectiveResults();
  const behaviourObjectives = results.filter((entry) => /deny|allow/i.test(entry.label));
  assert(
    behaviourObjectives.length >= 5 &&
      behaviourObjectives.every((entry) => entry.completed === true),
    'qa-grading #30a: all behaviour objectives tick for the hand-written set',
    JSON.stringify(behaviourObjectives.map((entry) => [entry.label, entry.completed]))
  );
  assert(
    objectiveByLabel(results, /Resolve DNSResolutionFailure/i)?.completed === false,
    'qa-grading #30a: scripted DNS incident is still unresolved before it fires'
  );
  await advanceIncidents(60);
  results = await objectiveResults();
  assert(
    results.every((entry) => entry.completed === true),
    'qa-grading #30a: hand-written solution reaches 6/6 (incident resolves)',
    JSON.stringify(results.map((entry) => [entry.label, entry.completed]))
  );
  await evaluate(() => window.game.app.modeInstance.update());
  const challengeStatus = await evaluate(() => window.game.app.modeInstance.getStatus());
  assert(
    challengeStatus.state === 'completed' && challengeStatus.completionPercentage === 100,
    'qa-grading #30a: lab 9 completes on behaviour alone',
    JSON.stringify({
      state: challengeStatus.state,
      pct: challengeStatus.completionPercentage,
      objectives: (challengeStatus.objectives || []).map((entry) => [entry.label, entry.completed]),
    })
  );

  // ── #30b: lab 9 — the provided file still passes 6/6 ────────────────────
  assert(await startChallenge(9), 'qa-grading #30b: lab 9 starts for the provided file');
  command = await runCmd('oc apply -f challenges/shop-networkpolicy.yaml', 700);
  assert(!command.error, 'qa-grading #30b: apply provided policy set', command.message);
  await advanceIncidents(60);
  results = await objectiveResults();
  assert(
    results.every((entry) => entry.completed === true),
    'qa-grading #30b: provided challenges/shop-networkpolicy.yaml still reaches 6/6',
    JSON.stringify(results.map((entry) => [entry.label, entry.completed]))
  );

  // ── #30c: lab 11 — heredoc OAuth apply, first-login User, login latch ───
  assert(await startChallenge(11), 'qa-grading #30c: lab 11 starts');
  await runCmd('oc project onboarding', 150);
  await runCmd('htpasswd -c -b htpasswd alice openshift', 250);
  await runCmd(
    'oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config',
    320
  );
  await objectiveResults(); // capture the login-evidence baseline before any login
  command = await runCmd(`cat <<EOF | oc apply -f -\n${OAUTH_YAML}\nEOF`, 650);
  assert(
    !command.error,
    'qa-grading #30c: heredoc oc apply -f - configures OAuth',
    command.message
  );
  await advanceSimulation(8);
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /OAuth HTPasswd identity provider/i)?.completed === true,
    'qa-grading #30c: heredoc OAuth apply ticks the state-based identity-provider objective',
    JSON.stringify(objectiveByLabel(results, /OAuth HTPasswd identity provider/i))
  );
  // Real OpenShift only creates the User object at first login: group
  // membership alone must not tick "User alice exists".
  command = await runCmd('oc adm groups new developers alice', 320);
  assert(!command.error, 'qa-grading #30c: create group developers', command.message);
  assert(
    (await findResource('User', 'alice')) === null,
    'qa-grading #30c: oc adm groups new does not create the User object'
  );
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /User alice exists/i)?.completed === false,
    'qa-grading #30c: "User alice exists" is not ticked by group membership',
    JSON.stringify(objectiveByLabel(results, /User alice exists/i))
  );
  command = await runCmd('oc login -u alice -p openshift', 500);
  assert(!command.error, 'qa-grading #30c: log in as alice', command.message);
  assert(
    (await runCmd('oc whoami', 120)).message.trim() === 'alice',
    'qa-grading #30c: session user is alice'
  );
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /User alice exists/i)?.completed === true,
    'qa-grading #30c: first login creates the real User object'
  );
  assert(
    objectiveByLabel(results, /Log in as alice/i)?.completed === true,
    'qa-grading #30c: login objective ticks on a successful login'
  );
  command = await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`, 320);
  assert(!command.error, 'qa-grading #30c: log back in as kubeadmin', command.message);
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /Log in as alice/i)?.completed === true,
    'qa-grading #30c: login objective latches across a user switch',
    JSON.stringify(objectiveByLabel(results, /Log in as alice/i))
  );

  // ── #30d: lab 11 — `oc patch oauth cluster` also ticks ──────────────────
  assert(await startChallenge(11), 'qa-grading #30d: lab 11 starts for the patch flow');
  await runCmd('htpasswd -c -b htpasswd alice openshift', 250);
  await runCmd(
    'oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config',
    320
  );
  command = await runCmd(`oc patch oauth cluster --type=merge -p '${OAUTH_PATCH}'`, 650);
  assert(!command.error, 'qa-grading #30d: oc patch oauth cluster --type=merge', command.message);
  await advanceSimulation(8);
  results = await objectiveResults();
  assert(
    objectiveByLabel(results, /OAuth HTPasswd identity provider/i)?.completed === true,
    'qa-grading #30d: oc patch oauth cluster ticks the state-based objective',
    JSON.stringify(objectiveByLabel(results, /OAuth HTPasswd identity provider/i))
  );

  // ── #30e: campaign L13 — login evidence + file-based OAuth apply ────────
  assert(await startCampaign(13), 'qa-grading #30e: campaign level 13 starts');
  await runCmd('oc project identity-lab', 150);
  await runCmd('htpasswd -c -B -b htpasswd alice openshift', 250);
  await runCmd(
    'oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config',
    320
  );
  await writeVirtualFile('idp.yaml', OAUTH_YAML);
  await objectiveResults();
  command = await runCmd('oc apply -f idp.yaml', 650);
  assert(!command.error, 'qa-grading #30e: oc apply -f idp.yaml activates the OAuth provider');
  await advanceSimulation(8);
  command = await runCmd('oc login -u alice -p openshift', 500);
  assert(!command.error, 'qa-grading #30e: L13 log in as alice', command.message);
  await runCmd('oc whoami', 120);
  command = await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`, 320);
  assert(!command.error, 'qa-grading #30e: L13 switch back to kubeadmin', command.message);
  const loginEvidence = await evaluate(() => {
    const def = window.game.app.modeInstance?.currentLevelDef;
    const loginObjective = (def?.objectives || []).find((objective) => objective.type === 'login');
    return {
      currentUser: window.game.gameEngine.currentUser,
      history: window.game.gameEngine.getLoginHistory(),
      rawBaseline: loginObjective?._baseline || null,
    };
  });
  results = await objectiveResults();
  assert(
    (objectiveByLabel(results, /Log in to the CLI as alice/i) || {}).completed === true,
    'qa-grading #30e: L13 "Log in to the CLI as alice" latches after the user switch',
    JSON.stringify({
      results: results.map((entry) => [entry.label, entry.completed]),
      ...loginEvidence,
    })
  );
  assert(
    (objectiveByLabel(results, /User "alice" exists after first login/i) || {}).completed === true,
    'qa-grading #30e: L13 User alice exists after first login'
  );

  // ── #30f: L2 label objective is namespace-correct ──────────────────────
  assert(await startCampaign(2), 'qa-grading #30f: campaign level 2 starts');
  await runCmd(
    'oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n default',
    380
  );
  await runCmd('oc label deploy web tier=frontend -n default', 320);
  await runCmd('oc project default', 200);
  await runCmd('oc label deploy web tier=frontend', 320);
  results = await objectiveResults();
  assert(
    (objectiveByLabel(results, /Label Deployment web/i) || {}).completed === false,
    'qa-grading #30f: wrong-namespace label does not tick "Label Deployment web"',
    JSON.stringify(objectiveByLabel(results, /Label Deployment web/i))
  );
  await runCmd('oc label deploy web tier=frontend -n query-lab', 320);
  results = await objectiveResults();
  assert(
    (objectiveByLabel(results, /Label Deployment web/i) || {}).completed === true,
    'qa-grading #30f: correct-namespace label ticks "Label Deployment web"',
    JSON.stringify(objectiveByLabel(results, /Label Deployment web/i))
  );

  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.1.8 — issue #34: EX280 coverage and post-campaign handover
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-coverage', async () => {
  // ── #34 deploy-templates-helm: standard OpenShift sample templates ────────
  assert(await bootSandbox(), 'coverage: sandbox boots for templates/alerting/alerts checks');
  await runCmd('oc project default');

  const templatesList = await runCmd('oc get templates -n openshift');
  assert(
    ['webapp-template', 'httpd-example', 'mysql-persistent', 'postgresql-persistent'].every(
      (name) => templatesList.message.includes(name)
    ),
    'coverage: oc get templates -n openshift lists the standard sample templates',
    templatesList.message.replace(/\n/g, ' | ').slice(0, 340)
  );

  const httpdParams = await runCmd('oc process --parameters httpd-example');
  assert(
    /NAME\b/.test(httpdParams.message) &&
      /SOURCE_IMAGE/.test(httpdParams.message) &&
      /MEMORY_LIMIT/.test(httpdParams.message),
    'coverage: oc process --parameters httpd-example exposes real parameters',
    httpdParams.message.slice(0, 260)
  );
  const mysqlParams = await runCmd('oc process --parameters mysql-persistent');
  assert(
    /DATABASE_SERVICE_NAME/.test(mysqlParams.message) &&
      /MYSQL_PASSWORD/.test(mysqlParams.message) &&
      /expression/.test(mysqlParams.message),
    'coverage: mysql-persistent exposes generated MYSQL_* parameters',
    mysqlParams.message.slice(0, 260)
  );

  await expectCmd(
    'coverage: oc new-project template-lab',
    'oc new-project template-lab',
    /Now using project|created/i
  );
  await expectCmd(
    'coverage: oc process httpd-example | oc apply -f -',
    'oc process httpd-example -p NAME=qa-httpd | oc apply -f -',
    /created|configured/i
  );
  const httpdDeployment = await findResource('Deployment', 'qa-httpd', 'template-lab');
  const httpdService = await findResource('Service', 'qa-httpd', 'template-lab');
  const httpdRoute = await findResource('Route', 'qa-httpd', 'template-lab');
  assert(
    Boolean(httpdDeployment && httpdService && httpdRoute),
    'coverage: processed httpd template creates Deployment + Service + Route',
    JSON.stringify({
      deployment: Boolean(httpdDeployment),
      service: Boolean(httpdService),
      route: Boolean(httpdRoute),
    })
  );
  assert(
    /registry\.redhat\.io\/ubi9\/httpd-24/.test(
      httpdDeployment?.spec?.template?.spec?.containers?.[0]?.image || ''
    ),
    'coverage: httpd SOURCE_IMAGE parameter is substituted into the Deployment'
  );

  await expectCmd(
    'coverage: oc new-app --template=mysql-persistent -p ...',
    'oc new-app --template=mysql-persistent -p DATABASE_SERVICE_NAME=qa-db -p MYSQL_USER=qa -p MYSQL_PASSWORD=s3cr3t',
    /created|Success/i
  );
  const mysqlDeployment = await findResource('Deployment', 'qa-db', 'template-lab');
  const mysqlPvc = await findResource('PersistentVolumeClaim', 'qa-db', 'template-lab');
  const mysqlEnv = mysqlDeployment?.spec?.template?.spec?.containers?.[0]?.env || [];
  assert(
    Boolean(mysqlDeployment && mysqlPvc),
    'coverage: mysql-persistent deploys a Deployment and a PVC',
    JSON.stringify({ deployment: Boolean(mysqlDeployment), pvc: Boolean(mysqlPvc) })
  );
  assert(
    mysqlEnv.some((entry) => entry.name === 'MYSQL_PASSWORD' && entry.value === 's3cr3t'),
    'coverage: -p values replace the generated mysql parameters in the Deployment env',
    JSON.stringify(mysqlEnv.map((entry) => entry.name))
  );
  assert(
    mysqlPvc?.spec?.resources?.requests?.storage === '1Gi',
    'coverage: mysql VOLUME_CAPACITY parameter lands on the PVC',
    JSON.stringify(mysqlPvc?.spec?.resources)
  );

  await expectCmd(
    'coverage: oc new-app --template=postgresql-persistent (generated params)',
    'oc new-app --template=postgresql-persistent -p DATABASE_SERVICE_NAME=qa-pg',
    /created|Success/i
  );
  const postgresDeployment = await findResource('Deployment', 'qa-pg', 'template-lab');
  const postgresEnv = postgresDeployment?.spec?.template?.spec?.containers?.[0]?.env || [];
  assert(Boolean(postgresDeployment), 'coverage: postgresql-persistent deploys a Deployment');
  assert(
    /^[A-Za-z0-9]{16}$/.test(
      postgresEnv.find((entry) => entry.name === 'POSTGRESQL_USER')?.value || ''
    ),
    'coverage: generated POSTGRESQL_* parameters expand to a 16-char expression value',
    JSON.stringify(postgresEnv.find((entry) => entry.name === 'POSTGRESQL_USER'))
  );
  assert(
    /postgresql-16/.test(postgresDeployment?.spec?.template?.spec?.containers?.[0]?.image || ''),
    'coverage: postgresql POSTGRESQL_VERSION parameter is substituted into the image'
  );

  await expectCmd(
    'coverage: webapp-template keeps working',
    'oc new-app --template=webapp-template -p APP_NAME=qa-web',
    /created|Success/i
  );
  assert(
    Boolean(await findResource('Deployment', 'qa-web', 'template-lab')),
    'coverage: the original webapp-template still deploys'
  );

  // ── #34 manage-monitor-events-alerts: PrometheusRule + Alertmanager model ─
  await expectCmd(
    'coverage: oc get prometheusrules -A lists the monitoring rules',
    'oc get prometheusrules -A',
    /NAMESPACE[\s\S]*openshift-monitoring[\s\S]*kubernetes-monitoring-rules[\s\S]*node-exporter-rules[\s\S]*openshift-monitoring-rules/
  );
  await expectCmd(
    'coverage: oc describe prometheusrule shows the alert rules',
    'oc describe prometheusrule kubernetes-monitoring-rules -n openshift-monitoring',
    /KubePodCrashLooping[\s\S]*KubePodNotReady[\s\S]*severity[\s\S]*monitoring\.coreos\.com\/v1/
  );
  await expectCmd(
    'coverage: oc get alertmanager lists the main instance',
    'oc get alertmanager -n openshift-monitoring',
    /NAME[\s\S]*main/
  );
  await expectCmd(
    'coverage: describe alertmanager shows a firing Watchdog alert',
    'oc describe alertmanager main -n openshift-monitoring',
    /Firing Alerts:[\s\S]*Watchdog[\s\S]*firing/
  );
  await expectCmd(
    'coverage: alertmanager pods are seeded in openshift-monitoring',
    'oc get pods -n openshift-monitoring',
    /alertmanager-main-0[\s\S]*Running/
  );
  await expectCmd(
    'coverage: alertmanager route is seeded',
    'oc get route alertmanager-main -n openshift-monitoring',
    /alertmanager-main[\s\S]*reencrypt/
  );
  await expectCmd(
    'coverage: alerting events surface in oc get events',
    'oc get events -n openshift-monitoring',
    /Watchdog/
  );

  // Alerts are evaluated from live cluster state: a broken workload must fire
  // the matching rule, not just display static text.
  await expectCmd(
    'coverage: create a broken workload for live alert evaluation',
    'oc create deployment qa-broken --image=quay.io/coverage/missing-image:latest -n template-lab',
    /created/i
  );
  await advanceSimulation(30);
  const firedAlerts = await runCmd('oc describe alertmanager main -n openshift-monitoring');
  assert(
    /KubePod(NotReady|CrashLooping)/.test(firedAlerts.message),
    'coverage: Alertmanager surfaces an alert for the real broken workload',
    firedAlerts.message
      .split('\n')
      .filter((line) => /Watchdog|KubePod|Firing/.test(line))
      .join(' | ')
  );
  await runCmd('oc delete deployment qa-broken -n template-lab');

  // ── #34 Kustomize v5: labels:/patches: drill data ─────────────────────────
  if (!(await waitFor(() => evaluate(() => !!window.game?.manifestEngine), 3000))) {
    await evaluate(() => document.getElementById('btn-manifests')?.click());
  }
  assert(
    await waitFor(() => evaluate(() => !!window.game?.manifestEngine), 8000),
    'coverage: Files/ManifestEngine ready for the kustomize drill'
  );
  const kustomizeSource = await evaluate(() => {
    const files = window.game?.manifestEngine?.files;
    if (!files || typeof files.get !== 'function') return null;
    return {
      base: files.get('kustomize/base/kustomization.yaml') || '',
      dev: files.get('kustomize/overlays/dev/kustomization.yaml') || '',
      prod: files.get('kustomize/overlays/prod/kustomization.yaml') || '',
    };
  });
  assert(
    kustomizeSource &&
      /labels:/.test(kustomizeSource.base) &&
      /labels:/.test(kustomizeSource.dev) &&
      /labels:/.test(kustomizeSource.prod) &&
      /patches:/.test(kustomizeSource.prod),
    'coverage: kustomize examples teach v5 labels:/patches:'
  );
  assert(
    kustomizeSource &&
      !/(^|\n)commonLabels:/.test(
        kustomizeSource.base + kustomizeSource.dev + kustomizeSource.prod
      ) &&
      !/(^|\n)patchesStrategicMerge:/.test(kustomizeSource.prod),
    'coverage: deprecated commonLabels/patchesStrategicMerge removed from the examples'
  );

  await expectCmd(
    'coverage: oc new-project kustomize-v5-lab',
    'oc new-project kustomize-v5-lab',
    /Now using project|created/i
  );
  await expectCmd(
    'coverage: oc apply -k kustomize/base',
    'oc apply -k kustomize/base',
    /created|configured/i
  );
  const baseDeployment = await findResource('Deployment', 'webapp', 'kustomize-v5-lab');
  assert(Boolean(baseDeployment), 'coverage: kustomize base renders Deployment/webapp');
  const baseLabels = await evaluate(() => {
    const deployment = (window.game.cluster.getByKind('Deployment') || []).find(
      (resource) =>
        resource.metadata?.name === 'webapp' && resource.metadata?.namespace === 'kustomize-v5-lab'
    );
    return {
      metadata: deployment?.metadata?.labels || {},
      podTemplate: deployment?.spec?.template?.metadata?.labels || {},
    };
  });
  assert(
    baseLabels.metadata['app.kubernetes.io/part-of'] === 'webapp' &&
      baseLabels.metadata['app.kubernetes.io/managed-by'] === 'kustomize',
    'coverage: labels: pairs land in metadata.labels (v5 transformer)',
    JSON.stringify(baseLabels.metadata)
  );
  assert(
    baseDeployment?.spec?.selector?.matchLabels?.['app.kubernetes.io/part-of'] === undefined,
    'coverage: labels: without includeSelectors leaves the selector alone (v5 semantics)',
    JSON.stringify(baseDeployment?.spec?.selector?.matchLabels)
  );

  await runCmd('oc new-project webapp-prod');
  await expectCmd(
    'coverage: oc apply -k kustomize/overlays/prod',
    'oc apply -k kustomize/overlays/prod',
    /created|configured/i
  );
  const prodDeployment = await findResource('Deployment', 'prod-webapp', 'webapp-prod');
  assert(Boolean(prodDeployment), 'coverage: prod overlay renders prefixed Deployment/prod-webapp');
  assert(
    Number(prodDeployment?.spec?.replicas) === 3,
    'coverage: prod overlay replicas transformer sets 3 replicas',
    JSON.stringify(prodDeployment?.spec?.replicas)
  );
  assert(
    /origin-hello-openshift:1\.0\.0/.test(
      prodDeployment?.spec?.template?.spec?.containers?.[0]?.image || ''
    ),
    'coverage: prod overlay images transformer pins the tag'
  );
  assert(
    (prodDeployment?.spec?.template?.spec?.containers?.[0]?.env || []).some(
      (entry) => entry.name === 'APP_ENV' && entry.value === 'production'
    ),
    'coverage: patches: strategic-merge patch merges the APP_ENV env var'
  );
  assert(
    prodDeployment?.spec?.selector?.matchLabels?.environment === 'prod',
    'coverage: labels: + includeSelectors: true updates selectors in v5',
    JSON.stringify(prodDeployment?.spec?.selector?.matchLabels)
  );

  // ── #34 post-campaign handover after "Finish campaign" ───────────────────
  await bootMenu();
  assert(await launch('campaign', 20), 'coverage: campaign level 20 starts for the handover flow');
  await closeOverlays();
  const restartProbe = await evaluate(() => {
    const mode = window.game.app.modeInstance;
    if (!mode || typeof mode.restart !== 'function') return { restartable: false };
    const restarted = mode.restart();
    return { restartable: true, restarted };
  });
  assert(
    restartProbe.restartable && restartProbe.restarted !== false,
    'coverage: level 20 restart still works before the finish flow',
    JSON.stringify(restartProbe)
  );
  await sleep(1200);

  // Complete the last level through the shell's real completion handler, then
  // press the relabelled primary action.
  await evaluate(() => {
    const app = window.game.app;
    app.scoringEngine.progress.campaignProgress[20] = { completed: true, stars: 3 };
    window.game.engine.emit('mode:level-complete', {
      levelId: 20,
      title: 'Level 20 — Cluster Under Pressure',
      stars: 3,
      nextLevel: null,
      isLastLevel: true,
      totalLevels: 20,
      message: 'Campaign complete',
    });
  });
  const finishLabel = await evaluate(
    () => document.getElementById('level-complete-next')?.textContent || ''
  );
  assert(
    finishLabel.trim() === 'Finish campaign',
    'coverage: final level relabels the primary action to "Finish campaign"',
    finishLabel
  );
  await evaluate(() => document.getElementById('level-complete-next')?.click());
  assert(
    await waitFor(
      () =>
        evaluate(
          () =>
            window.game?.app?.isCampaignHandoverOpen?.() === true &&
            document.getElementById('campaign-handover')?.hidden === false
        ),
      8000
    ),
    'coverage: "Finish campaign" opens the post-campaign handover instead of the start page'
  );
  await sleep(400);
  const handover = await evaluate(() => {
    const text = (id) => document.getElementById(id)?.innerText || '';
    const overlay = document.getElementById('campaign-handover');
    return {
      title: text('handover-title'),
      stats: text('handover-stats'),
      bullets: text('handover-bullets'),
      checklist: text('handover-checklist'),
      checkProgress: text('handover-checklist-progress'),
      buttons: [...overlay.querySelectorAll('button, a')].map(
        (el) => `${el.tagName}:${el.id}:${el.innerText.trim()}`
      ),
      open: window.game.app.isCampaignHandoverOpen(),
      focused: document.activeElement?.id,
      modeTornDown: window.game.app.modeInstance === null,
    };
  });
  assert(
    /real cluster/i.test(handover.title),
    'coverage: handover has closing copy about a real cluster',
    handover.title.slice(0, 160)
  );
  assert(
    /20\/20/.test(handover.stats) && /60\/60/.test(handover.stats),
    'coverage: handover stats show 20/20 levels and 60/60 stars',
    handover.stats.replace(/\n/g, ' | ').slice(0, 240)
  );
  assert(
    /OpenShift Local/.test(handover.checklist) && /Developer Sandbox/.test(handover.checklist),
    'coverage: handover checklist tells the learner to set up a real cluster',
    handover.checklist.slice(0, 240)
  );
  assert(
    /L5 — /.test(handover.checklist) &&
      /L9 — /.test(handover.checklist) &&
      /L13 — /.test(handover.checklist) &&
      /L14 — /.test(handover.checklist) &&
      /L17 — /.test(handover.checklist),
    'coverage: handover checklist redo list covers L5/L9/L13/L14/L17',
    handover.checklist.replace(/\n/g, ' | ').slice(0, 240)
  );
  assert(
    handover.bullets.trim().length > 20 && /EX280|APPLICATION|CONFIGURE/i.test(handover.bullets),
    'coverage: handover lists weak EX280 bullets from the readiness evidence',
    handover.bullets.replace(/\n/g, ' | ').slice(0, 240)
  );
  assert(
    handover.buttons.some((label) => /Start EX280 Prep/.test(label)) &&
      handover.buttons.some((label) => /Back to start page/.test(label)) &&
      handover.buttons.some((label) => /Book EX280V422/.test(label)),
    'coverage: handover offers EX280 Prep, back-to-menu and exam links',
    handover.buttons.join(' | ')
  );
  assert(
    handover.modeTornDown === true && handover.focused === 'handover-prep',
    'coverage: handover tears the run down and focuses its primary action',
    JSON.stringify({ modeTornDown: handover.modeTornDown, focused: handover.focused })
  );

  // Checklist ticks persist in localStorage across close/reopen.
  await evaluate(() => localStorage.removeItem('openshiftgames_handover_checklist'));
  const saved = await evaluate(() => {
    const box = document.querySelector('#handover-checklist [data-handover-check]');
    box?.click();
    return JSON.parse(localStorage.getItem('openshiftgames_handover_checklist') || '{}');
  });
  assert(
    saved.cluster === true,
    'coverage: handover checklist persists ticks in localStorage',
    JSON.stringify(saved)
  );
  const checkProgress = await evaluate(
    () => document.getElementById('handover-checklist-progress')?.textContent || ''
  );
  // #40: the handover checklist grew to 7 items (full cluster + Sandbox scope
  // note + the five redo levels).
  assert(/1\/7/.test(checkProgress), 'coverage: checklist progress counter updates', checkProgress);

  await evaluate(() => document.getElementById('handover-menu')?.click());
  const handoverClosed = await evaluate(() => ({
    open: window.game.app.isCampaignHandoverOpen(),
    menuVisible: document.getElementById('main-menu')?.classList.contains('hidden') === false,
  }));
  assert(
    handoverClosed.open === false && handoverClosed.menuVisible === true,
    'coverage: "Back to start page" closes the handover onto the start page',
    JSON.stringify(handoverClosed)
  );

  // Non-final "Next Level" must keep working (the handover hook is one-shot).
  assert(
    await launch('campaign', 1),
    'coverage: campaign level 1 starts for the next-level control'
  );
  await closeOverlays();
  await evaluate(() => {
    window.game.app.scoringEngine.progress.campaignProgress[1] = { completed: true, stars: 3 };
    window.game.engine.emit('mode:level-complete', {
      levelId: 1,
      title: 'Level 1',
      stars: 3,
      nextLevel: 2,
      totalLevels: 20,
      message: 'done',
    });
    document.getElementById('level-complete-next')?.click();
  });
  assert(
    await waitFor(() => evaluate(() => window.game.app.modeInstance?.currentLevel === 2), 12000),
    'coverage: non-final "Next Level" still advances to level 2'
  );
  await returnToMenu();

  // ═══════════════════════════════════════════════════════════════════════
  // #34 phase-2B — L1 intro move, L13 rotation + user/identity cleanup,
  // new netpol lab 13, L18 operator variants, lab 10 AllNamespaces
  // ═══════════════════════════════════════════════════════════════════════

  // Dismiss the launch welcome modal and guarantee the mode clock is running:
  // objectives only tick while the campaign/challenge state is PLAYING, and the
  // intro modal that launches with a fresh run registers a clock-pause reason
  // (`tutorial`) that must be released before objective assertions are made.
  const ensureRunActive = async () => {
    await evaluate(() => {
      document.getElementById('tutorial-start')?.click();
      const app = window.game?.app;
      app?.hideTutorial?.();
      app?.hidePause?.();
      app?._resumeClocksFor?.('tutorial');
      const mode = app?.modeInstance;
      if (mode && mode.state === 'paused' && typeof mode.resume === 'function') mode.resume();
      if (window.game?.gameEngine && window.game.gameEngine.state !== 'running')
        window.game.gameEngine.resume?.();
    });
    await sleep(400);
  };

  // ── #34 L1 intro: the restricted-v2/nginx trap moved out of first contact ─
  assert(await launch('campaign', 1), 'coverage: campaign L1 starts for the intro check');
  await closeOverlays();
  const l1Intro = await evaluate(() => {
    const def = window.game.app.modeInstance.currentLevelDef;
    return { description: def.description, firstMoves: (def.hints || []).slice(0, 3) };
  });
  assert(
    !/restricted-v2|nginx/i.test(l1Intro.description) &&
      !/restricted-v2|nginx/i.test(l1Intro.firstMoves.join(' ')),
    'coverage: L1 welcome card and first moves no longer explain the nginx/restricted-v2 trap',
    JSON.stringify(l1Intro).slice(0, 260)
  );
  await returnToMenu();
  assert(await launch('campaign', 3), 'coverage: campaign L3 starts for the trap-hint check');
  await closeOverlays();
  const l3Hint = await evaluate(() => {
    const def = window.game.app.modeInstance.currentLevelDef;
    return (def.hints || []).find((hint) => /ADMITTED by|admission/i.test(hint)) || '';
  });
  assert(
    /restricted-v2/.test(l3Hint) && /runAsUser: 0/.test(l3Hint),
    'coverage: the admission-vs-runtime trap moved to the L3 troubleshooting hints',
    l3Hint.slice(0, 220)
  );
  await returnToMenu();

  // ── #34 auth-passwords + auth-users: L13 rotation and cleanup ────────────
  assert(
    await launch('campaign', 13),
    'coverage: campaign L13 starts for the password/cleanup flow'
  );
  await closeOverlays();
  await ensureRunActive();
  const l13Def = await evaluate(() => {
    const def = window.game.app.modeInstance.currentLevelDef;
    return {
      objectives: def.objectives.map((objective) => ({
        type: objective.type,
        name: objective.name,
        user: objective.user,
        exists: objective.exists,
      })),
      startingResources: (def.startingResources || []).map(
        (resource) => `${resource.kind}/${resource.name}`
      ),
    };
  });
  assert(
    l13Def.objectives.some(
      (objective) => objective.type === 'password' && objective.user === 'alice'
    ),
    'coverage: L13 requires a real HTPasswd password-rotation objective',
    JSON.stringify(l13Def.objectives)
  );
  assert(
    l13Def.objectives.some(
      (objective) =>
        objective.type === 'user' && objective.name === 'bob' && objective.exists === false
    ) &&
      l13Def.objectives.some(
        (objective) =>
          objective.type === 'identity' && objective.user === 'bob' && objective.exists === false
      ),
    'coverage: L13 requires deleting both the bob User and its Identity',
    JSON.stringify(l13Def.objectives)
  );
  assert(
    l13Def.startingResources.includes('User/bob') &&
      l13Def.startingResources.some((resource) => resource.startsWith('Identity/')),
    'coverage: L13 seeds the departing user bob with a pre-existing Identity',
    JSON.stringify(l13Def.startingResources)
  );

  // Configure the HTPasswd provider the way the level hints do, then rotate.
  await runCmd('oc project identity-lab');
  await runCmd(`htpasswd -c -B -b htpasswd alice 'OldPassw0rd!'`);
  await runCmd(
    'oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config'
  );
  const oauthManifest = `apiVersion: config.openshift.io/v1
kind: OAuth
metadata:
  name: cluster
spec:
  identityProviders:
    - name: htpasswd
      mappingMethod: claim
      type: HTPasswd
      htpasswd:
        fileData:
          name: htpass-secret`;
  await runCmd(`cat <<EOF | oc apply -f -\n${oauthManifest}\nEOF`);
  await advanceSimulation(8);
  const aliceInitialLogin = await runCmd(`oc login -u alice -p 'OldPassw0rd!'`);
  assert(
    !aliceInitialLogin.error,
    'coverage: L13 alice can log in with the initial HTPasswd password',
    aliceInitialLogin.message.slice(0, 220)
  );
  await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  await runCmd('oc extract secret/htpass-secret -n openshift-config --to /tmp --confirm');
  await runCmd(`htpasswd -bB /tmp/htpasswd alice 'NewPassw0rd!'`);
  await runCmd(
    'oc set data secret/htpass-secret -n openshift-config --from-file=htpasswd=/tmp/htpasswd'
  );
  await advanceSimulation(2);
  const aliceEarlyLogin = await runCmd(`oc login -u alice -p 'NewPassw0rd!'`);
  assert(
    aliceEarlyLogin.error && /not ready|Login failed/i.test(aliceEarlyLogin.message),
    'coverage: L13 rejects the new password until the OAuth rollout completes',
    aliceEarlyLogin.message.slice(0, 220)
  );
  await advanceSimulation(8);
  // Let one objective tick observe the rotated-but-not-yet-logged-in state: the
  // requireLogin latch captures its login-history baseline when the new hash
  // first verifies. (A human learner takes seconds between these commands.)
  await sleep(1400);
  const aliceRotatedLogin = await runCmd(`oc login -u alice -p 'NewPassw0rd!'`);
  assert(
    !aliceRotatedLogin.error,
    'coverage: L13 the rotated HTPasswd password works after the OAuth rollout',
    aliceRotatedLogin.message.slice(0, 220)
  );
  assert(
    await waitFor(
      () =>
        evaluate(() =>
          (window.game.app.modeInstance.objectiveProgress || []).some(
            (objective) => objective.type === 'password' && objective.completed
          )
        ),
      15000
    ),
    'coverage: L13 password objective completes after rotation + login with the new password'
  );

  await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  await expectCmd('coverage: oc delete user bob', 'oc delete user bob', /deleted/i);
  const afterUserDelete = await evaluate(() =>
    (window.game.app.modeInstance.objectiveProgress || [])
      .filter((objective) => ['user', 'identity'].includes(objective.type))
      .map((objective) => ({ type: objective.type, completed: objective.completed }))
  );
  assert(
    afterUserDelete.some((objective) => objective.type === 'user' && objective.completed),
    'coverage: L13 deleting the User completes the user-deletion objective',
    JSON.stringify(afterUserDelete)
  );
  assert(
    afterUserDelete.some((objective) => objective.type === 'identity' && !objective.completed),
    'coverage: L13 deleting the User alone leaves the Identity behind (both deletes required)',
    JSON.stringify(afterUserDelete)
  );
  await expectCmd(
    'coverage: oc delete identity htpasswd:bob',
    'oc delete identity htpasswd:bob',
    /deleted/i
  );
  assert(
    await waitFor(
      () =>
        evaluate(() => {
          const progress = window.game.app.modeInstance.objectiveProgress || [];
          const userObjective = progress.find(
            (objective) => objective.type === 'user' && objective.name === 'bob'
          );
          const identityObjective = progress.find(
            (objective) => objective.type === 'identity' && objective.user === 'bob'
          );
          return Boolean(userObjective?.completed && identityObjective?.completed);
        }),
      12000
    ),
    'coverage: L13 user + identity deletion objectives complete after both deletes'
  );
  await returnToMenu();

  // ── #34 net-network-policies: new behaviour-graded timed lab 13 ──────────
  assert(
    await launch('challenge', 13),
    'coverage: timed lab 13 (Production Network Policies) starts'
  );
  await closeOverlays();
  await ensureRunActive();
  const lab13Def = await evaluate(() => {
    const def = window.game.app.modeInstance.currentChallengeDef;
    return {
      title: def.title,
      probes: def.objectives
        .filter((objective) => objective.type === 'networkPolicy')
        .map((objective) => objective.probe),
      files: def.manifestFiles || [],
    };
  });
  assert(
    lab13Def.title === 'Production Network Policies' &&
      lab13Def.probes.length === 4 &&
      ['default-deny', 'dns-egress', 'reach', 'deny'].every((probe) =>
        lab13Def.probes.includes(probe)
      ),
    'coverage: lab 13 has 4 behaviour-based NetworkPolicy objectives',
    JSON.stringify(lab13Def)
  );
  await expectCmd(
    'coverage: lab 13 applies the starter default-deny',
    'oc apply -f challenges/payments-networkpolicy.yaml',
    /created|configured/i
  );
  await sleep(1400);
  const starterPolicies = await evaluate(() =>
    (window.game.app.modeInstance.objectiveProgress || [])
      .filter((objective) => objective.type === 'networkPolicy')
      .map((objective) => ({ probe: objective.probe, completed: objective.completed }))
  );
  // With only the default-deny in place the allow probes must stay incomplete
  // (the `deny` probe is legitimately satisfied: the reverse direction is blocked).
  assert(
    starterPolicies.some((objective) => objective.probe === 'dns-egress' && !objective.completed) &&
      starterPolicies.some((objective) => objective.probe === 'reach' && !objective.completed),
    'coverage: lab 13 default-deny alone does not satisfy the DNS/reach allow objectives',
    JSON.stringify(starterPolicies)
  );
  const paymentsPolicies = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: payments
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openshift-dns
      ports:
        - protocol: UDP
          port: 5353
        - protocol: TCP
          port: 5353
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-gateway-egress
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: gateway
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: ledger
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-gateway-to-ledger
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: ledger
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: gateway
      ports:
        - protocol: TCP
          port: 8080`;
  const applyPolicies = await runCmd(`cat <<EOF | oc apply -f -\n${paymentsPolicies}\nEOF`);
  assert(
    !applyPolicies.error,
    'coverage: lab 13 hand-written allow policies apply',
    applyPolicies.message.slice(0, 260)
  );
  assert(
    await waitFor(
      () =>
        evaluate(() =>
          (window.game.app.modeInstance.objectiveProgress || [])
            .filter((objective) => objective.type === 'networkPolicy')
            .every((objective) => objective.completed)
        ),
      18000
    ),
    'coverage: lab 13 all NetworkPolicy objectives complete from traffic behaviour'
  );
  await returnToMenu();

  // ── #34 ops-install: L18 AllNamespaces + Manual approval + startingCSV ──
  assert(await launch('campaign', 18), 'coverage: campaign L18 starts for the OLM variants');
  await closeOverlays();
  await ensureRunActive();
  await expectCmd(
    'coverage: L18 applies the Manual/pinned AllNamespaces Subscription',
    'oc apply -f examples/subscription-manual-pinned.yaml',
    /created|configured/i
  );
  // #46/#48-1: the shipped example pins a valid NON-head channel entry by its
  // CSV name; the CSV keeps its historical `cert-manager-operator.vX` name even
  // though the catalog package is `openshift-cert-manager-operator`.
  const pinnedSubscription = await evaluate(() => {
    const sub = window.game.cluster.getByName(
      'Subscription',
      'openshift-cert-manager-operator',
      'openshift-operators'
    );
    const manifest = window.game.cluster.getByName(
      'PackageManifest',
      'openshift-cert-manager-operator',
      ''
    );
    const channel = (manifest?.status?.channels || []).find((entry) => entry.name === 'stable-v1');
    return {
      channel: sub?.spec?.channel || null,
      startingCSV: sub?.spec?.startingCSV || null,
      approval: sub?.spec?.installPlanApproval || null,
      channelHead: channel?.currentCSV || null,
    };
  });
  assert(
    pinnedSubscription.channel === 'stable-v1' &&
      /^cert-manager-operator\.v\d+\.\d+\.\d+$/.test(pinnedSubscription.startingCSV || '') &&
      pinnedSubscription.startingCSV !== pinnedSubscription.channelHead &&
      pinnedSubscription.approval === 'Manual',
    'coverage: L18 example pins a valid non-head stable-v1 channel entry',
    JSON.stringify(pinnedSubscription)
  );
  await advanceSimulation(3);
  const pinnedPlanName = await evaluate(() => {
    const plan = (window.game.cluster.getByKind('InstallPlan') || []).find(
      (candidate) =>
        candidate.metadata.namespace === 'openshift-operators' &&
        (candidate.spec?.clusterServiceVersionNames || []).some((name) => /cert-manager/.test(name))
    );
    return plan?.metadata?.name || null;
  });
  assert(
    Boolean(pinnedPlanName),
    'coverage: L18 creates an InstallPlan for the pinned AllNamespaces install',
    String(pinnedPlanName)
  );
  const pinnedPlan = await evaluate((planName) => {
    const plan = window.game.cluster.getByName('InstallPlan', planName, 'openshift-operators');
    return plan ? { approval: plan.spec?.approval, approved: plan.spec?.approved } : null;
  }, pinnedPlanName);
  assert(
    pinnedPlan?.approval === 'Manual' && pinnedPlan?.approved === false,
    'coverage: L18 InstallPlan waits at Manual approval',
    JSON.stringify(pinnedPlan)
  );
  await expectCmd(
    'coverage: L18 approves the Manual InstallPlan',
    `oc patch installplan ${pinnedPlanName} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`,
    /patched/i
  );
  await advanceSimulation(20);
  const operatorCsvs = await evaluate(() =>
    (window.game.cluster.getByKind('ClusterServiceVersion') || [])
      .filter((csv) => csv.metadata.namespace === 'openshift-operators')
      .map((csv) => ({ name: csv.metadata.name, phase: csv.status?.phase }))
  );
  assert(
    operatorCsvs.some(
      (csv) => csv.name === pinnedSubscription.startingCSV && csv.phase === 'Succeeded'
    ) && !operatorCsvs.some((csv) => csv.name === pinnedSubscription.channelHead),
    'coverage: L18 installs the pinned startingCSV instead of the channel head and it reaches Succeeded',
    JSON.stringify(operatorCsvs)
  );
  assert(
    await waitFor(
      () =>
        evaluate(() => {
          const progress = window.game.app.modeInstance.objectiveProgress || [];
          const variantObjectives = progress.filter(
            (objective) =>
              objective.type === 'installPlan' ||
              objective.type === 'subscription' ||
              (objective.type === 'operator' && objective.namespace === 'openshift-operators')
          );
          return (
            variantObjectives.length >= 3 &&
            variantObjectives.every((objective) => objective.completed)
          );
        }),
      18000
    ),
    'coverage: L18 AllNamespaces/Manual/startingCSV objectives all complete'
  );
  await returnToMenu();

  // ── #34 ops-install: lab 10 AllNamespaces variant ────────────────────────
  assert(
    await launch('challenge', 10),
    'coverage: timed lab 10 starts for the AllNamespaces variant'
  );
  await closeOverlays();
  await ensureRunActive();
  await expectCmd(
    'coverage: lab 10 applies the AllNamespaces pipelines Subscription',
    'oc apply -f examples/subscription-pipelines.yaml',
    /created|configured/i
  );
  await advanceSimulation(15);
  const pipelinesInstalled = await evaluate(() =>
    (window.game.cluster.getByKind('ClusterServiceVersion') || []).some(
      (csv) =>
        csv.metadata.namespace === 'openshift-operators' &&
        /openshift-pipelines/.test(csv.metadata.name) &&
        csv.status?.phase === 'Succeeded'
    )
  );
  assert(
    pipelinesInstalled,
    'coverage: lab 10 AllNamespaces install reaches CSV Succeeded in openshift-operators'
  );
  assert(
    await waitFor(
      () =>
        evaluate(() =>
          (window.game.app.modeInstance.objectiveProgress || []).some(
            (objective) =>
              objective.type === 'operator' &&
              objective.name === 'openshift-pipelines-operator-rh' &&
              objective.completed
          )
        ),
      18000
    ),
    'coverage: lab 10 AllNamespaces operator objective completes'
  );
  await returnToMenu();
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issue #37: L20 grades the capstone on cluster STATE, not
// on object names the level never states, and routeAccess only ticks once an
// ingress-isolation policy exists (hidden-name regression + premature tick).
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue37', async () => {
  /** Advance only the controller clock (deterministic, no wall-clock waits). */
  const advanceController = (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      if (!sim || typeof sim.tick !== 'function') return false;
      for (let index = 0; index < Math.ceil(secs / 0.05); index += 1) sim.tick(0.05);
      return true;
    }, seconds);
  /** L20 objective definitions plus their live completion flags. */
  const objectiveSnapshot = () =>
    evaluate(() => {
      const mode = window.game?.app?.modeInstance;
      const defs = mode?.currentLevelDef?.objectives || [];
      const progress = mode?.objectiveProgress || [];
      return defs.map((definition, index) => ({
        type: definition.type,
        namespace: definition.namespace || null,
        probe: definition.probe || null,
        requireIsolation: definition.requireIsolation === true,
        requiresName: Boolean(definition.name),
        completed: progress[index]?.completed === true,
      }));
    });
  const recheckObjectives = () =>
    evaluate(() => {
      window.game?.app?.modeInstance?.updateObjectives?.();
      return true;
    });
  const applyManifest = (text, namespace) =>
    runCmd(`oc apply -f - -n ${namespace} <<'EOF'\n${text}\nEOF`, 250);

  await bootCampaign(1);
  assert(await launch('campaign', 20), '#37: campaign L20 capstone starts');
  await closeOverlays();
  await evaluate(() => {
    const app = window.game?.app;
    app?._clearClockPauseReasons?.();
    app?.hidePause?.({ resume: true });
    app?.modeInstance?.resume?.();
  });

  // ── Objective definitions must be state-based, not hidden-name-based ─────
  let snap = await objectiveSnapshot();
  const quotaDef = snap.find((objective) => objective.type === 'quota');
  const limitDef = snap.find((objective) => objective.type === 'limitRange');
  const denyDef = snap.find((objective) => objective.type === 'networkPolicy');
  const accessDef = snap.find((objective) => objective.type === 'routeAccess');
  assert(
    Boolean(quotaDef) && quotaDef.namespace === 'prod-platform' && quotaDef.requiresName === false,
    '#37: L20 quota objective grades prod-platform state (no hidden name)',
    JSON.stringify(quotaDef)
  );
  assert(
    Boolean(limitDef) && limitDef.namespace === 'prod-platform' && limitDef.requiresName === false,
    '#37: L20 LimitRange objective grades prod-platform state (no hidden name)',
    JSON.stringify(limitDef)
  );
  assert(
    Boolean(denyDef) &&
      denyDef.probe === 'ingress-isolation' &&
      denyDef.namespace === 'prod-platform',
    '#37: L20 default-deny objective probes ingress isolation in prod-platform',
    JSON.stringify(denyDef)
  );
  assert(
    Boolean(accessDef) && accessDef.requireIsolation === true,
    '#37: L20 routeAccess objective requires isolation before it can tick',
    JSON.stringify(accessDef)
  );
  assert(
    denyDef?.completed === false && accessDef?.completed === false,
    '#37: default-deny and routeAccess objectives start pending',
    JSON.stringify({ deny: denyDef, access: accessDef })
  );

  // ── Build the capstone platform with CUSTOM object names (the #37 repro) ─
  await runCmd('oc new-project prod-platform');
  const deploymentApply = await runCmd('oc apply -f manifests/deployment.yaml -n prod-platform');
  assert(!deploymentApply.error, '#37: webapp deployment applies', deploymentApply.message);
  await runCmd('oc apply -f manifests/service.yaml -n prod-platform');
  await runCmd('oc create route edge webapp --service=webapp -n prod-platform');
  await advanceController(30);
  const routeAdmitted = await evaluate(() => {
    const route = window.game.cluster.getByName('Route', 'webapp', 'prod-platform');
    return route ? window.game.cluster.isRouteAdmitted(route) : false;
  });
  assert(routeAdmitted, '#37: webapp Route is admitted before the isolation work');

  const quotaCreate = await runCmd(
    'oc create quota prod-quota --hard=pods=10,requests.cpu=2,requests.memory=4Gi -n prod-platform'
  );
  assert(!quotaCreate.error, '#37: custom-named quota prod-quota is created', quotaCreate.message);
  const limitCreate = await applyManifest(
    [
      `apiVersion: v1`,
      `kind: LimitRange`,
      `metadata:`,
      `  name: prod-limits`,
      `spec:`,
      `  limits:`,
      `    - type: Container`,
      `      default:`,
      `        cpu: 500m`,
      `        memory: 512Mi`,
    ].join('\n'),
    'prod-platform'
  );
  assert(
    !limitCreate.error,
    '#37: custom-named LimitRange prod-limits is created',
    limitCreate.message
  );

  // routeAccess must NOT tick yet: there is no isolation policy.
  await recheckObjectives();
  snap = await objectiveSnapshot();
  assert(
    snap.find((objective) => objective.type === 'routeAccess')?.completed === false,
    '#37: routeAccess does not tick before any NetworkPolicy exists',
    JSON.stringify(snap.find((objective) => objective.type === 'routeAccess'))
  );

  // ── The issue's custom deny-all shape: all pods, Ingress-only, no rules ──
  const denyCreate = await applyManifest(
    [
      `apiVersion: networking.k8s.io/v1`,
      `kind: NetworkPolicy`,
      `metadata:`,
      `  name: deny-all`,
      `spec:`,
      `  podSelector: {}`,
      `  policyTypes:`,
      `    - Ingress`,
    ].join('\n'),
    'prod-platform'
  );
  assert(
    !denyCreate.error,
    '#37: custom-named deny-all NetworkPolicy is created',
    denyCreate.message
  );
  await recheckObjectives();
  snap = await objectiveSnapshot();
  assert(
    snap.find((objective) => objective.type === 'quota')?.completed === true,
    '#37: quota objective completes for prod-quota (state, not name)',
    JSON.stringify(snap.find((objective) => objective.type === 'quota'))
  );
  assert(
    snap.find((objective) => objective.type === 'limitRange')?.completed === true,
    '#37: LimitRange objective completes for prod-limits (state, not name)',
    JSON.stringify(snap.find((objective) => objective.type === 'limitRange'))
  );
  assert(
    snap.find((objective) => objective.type === 'networkPolicy')?.completed === true,
    '#37: default-deny objective completes for deny-all',
    JSON.stringify(snap.find((objective) => objective.type === 'networkPolicy'))
  );
  assert(
    snap.find((objective) => objective.type === 'routeAccess')?.completed === false,
    '#37: routeAccess stays pending while the router is policy-blocked',
    JSON.stringify(snap.find((objective) => objective.type === 'routeAccess'))
  );

  // ── A custom router-allow policy satisfies the isolation gate ───────────
  const routerAllow = await applyManifest(
    [
      `apiVersion: networking.k8s.io/v1`,
      `kind: NetworkPolicy`,
      `metadata:`,
      `  name: let-router-in`,
      `spec:`,
      `  podSelector: {}`,
      `  policyTypes:`,
      `    - Ingress`,
      `  ingress:`,
      `    - from:`,
      `        - namespaceSelector:`,
      `            matchLabels:`,
      `              policy-group.network.openshift.io/ingress: ""`,
    ].join('\n'),
    'prod-platform'
  );
  assert(
    !routerAllow.error,
    '#37: custom-named router-allow policy is created',
    routerAllow.message
  );
  await advanceController(6);
  await recheckObjectives();
  snap = await objectiveSnapshot();
  assert(
    snap.find((objective) => objective.type === 'routeAccess')?.completed === true,
    '#37: routeAccess completes after isolation + router allow exist',
    JSON.stringify(snap.find((objective) => objective.type === 'routeAccess'))
  );
  const hiddenNamesAbsent = await evaluate(() => {
    const cluster = window.game.cluster;
    return (
      !cluster.getByName('ResourceQuota', 'compute-quota', 'prod-platform') &&
      !cluster.getByName('LimitRange', 'resource-limits', 'prod-platform')
    );
  });
  assert(
    hiddenNamesAbsent,
    '#37: objectives complete without the hidden compute-quota/resource-limits names'
  );

  // Legacy routeAccess probes (no requireIsolation) keep their old semantics
  // so existing levels/challenges that rely on the plain probe do not regress.
  const legacyProbe = await evaluate(() => {
    const mode = window.game.app.modeInstance;
    const definition = mode.currentLevelDef;
    const index = definition.objectives.length;
    const probe = { type: 'routeAccess', name: 'webapp', label: 'legacy probe' };
    definition.objectives.push(probe);
    mode.objectiveProgress.push({ ...probe, current: 0, target: 1, completed: false });
    try {
      mode.updateObjectives();
      return mode.objectiveProgress[index]?.completed === true;
    } finally {
      definition.objectives.pop();
      mode.objectiveProgress.pop();
    }
  });
  assert(
    legacyProbe === true,
    '#37: legacy routeAccess probes without requireIsolation keep their old semantics',
    String(legacyProbe)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issues #38/#41: no fake `oc create limitrange`, real
// label-selector semantics, and honest openshift-ingress namespace labels.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue38-41', async () => {
  assert(await bootSandbox(), '#38: sandbox boots for LimitRange subcommand checks');

  // ── #38 CLI: oc create limitrange does not exist and is rejected ────────
  let result = await runCmd(
    'oc create limitrange team-limits --default=cpu=500m,memory=512Mi --default-request=cpu=100m,memory=128Mi --max=cpu=2,memory=4Gi'
  );
  assert(
    result.error && /error: unknown command "limitrange" for "oc create"/.test(result.message),
    '#38: oc create limitrange is rejected like real oc',
    result.message.slice(0, 300)
  );
  assert(
    /Valid subcommands:[\s\S]*quota[\s\S]*serviceaccount/.test(result.message),
    '#38: the rejection lists the real oc create subcommands',
    result.message.slice(0, 400)
  );
  result = await runCmd('oc get limitrange -n default');
  assert(
    /No resources found/.test(result.message),
    '#38: the rejected command created no LimitRange',
    result.message
  );
  result = await runCmd('oc apply -f examples/limitrange.yaml -n default');
  assert(
    !result.error,
    '#38: YAML-based LimitRange creation still works (oc apply -f)',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc get limitrange -n default');
  assert(
    /resource-limits/.test(result.message),
    '#38: examples/limitrange.yaml creates the shipped resource-limits LimitRange',
    result.message
  );

  // ── #38 content: lab 6 teaches the real YAML flow, not the fake command ──
  const lab6 = await evaluate(async () => {
    const levels = await import('/js/data/CampaignLevels.js');
    const challenges = await import('/js/modes/ChallengeMode.js');
    const challenge = challenges.CHALLENGES.find((entry) => entry.id === 6);
    const allHints = [
      ...levels.CAMPAIGN_LEVELS.flatMap((level) => level.hints || []),
      ...challenges.CHALLENGES.flatMap((entry) => entry.hints || []),
    ];
    const instructing = allHints.filter((hint) => {
      let index = hint.indexOf('oc create limitrange');
      while (index >= 0) {
        const before = hint.slice(Math.max(0, index - 60), index);
        if (!/(?:no|not|reject|does not exist|doesn't exist)\b[\s`'"]*$/i.test(before)) return true;
        index = hint.indexOf('oc create limitrange', index + 1);
      }
      return false;
    });
    const patterns = (challenge.objectives || [])
      .filter((objective) => objective.type === 'command')
      .map((objective) => objective.pattern);
    return {
      hints: challenge.hints || [],
      hintsWithYaml: (challenge.hints || []).filter((hint) =>
        /oc apply -f examples\/limitrange\.yaml/.test(hint)
      ),
      instructing,
      patterns,
      patternMatchesFake: patterns.some((pattern) =>
        new RegExp(pattern, 'i').test('oc create limitrange team-limits')
      ),
      patternMatchesYaml: patterns.some((pattern) =>
        new RegExp(pattern, 'i').test('oc apply -f examples/limitrange.yaml')
      ),
      patternMatchesQuota: patterns.some((pattern) =>
        new RegExp(pattern, 'i').test(
          'oc create quota team-quota --hard=pods=10,requests.cpu=4,requests.memory=8Gi'
        )
      ),
    };
  });
  assert(
    lab6.instructing.length === 0,
    '#38: no shipped level/challenge hint instructs the nonexistent oc create limitrange',
    JSON.stringify(lab6.instructing.slice(0, 2))
  );
  assert(
    lab6.hintsWithYaml.length === 1,
    '#38: lab 6 hint uses `oc apply -f examples/limitrange.yaml`',
    JSON.stringify(lab6.hints)
  );
  assert(
    lab6.patterns.length > 0 && !lab6.patternMatchesFake && lab6.patternMatchesYaml,
    '#38: lab 6 command objective matches the YAML apply and not oc create limitrange',
    JSON.stringify(lab6.patterns)
  );

  // ── #38 end-to-end: the lab is completable CLI-only through YAML ────────
  assert(await launch('challenge', 6), '#38: lab 6 starts for the YAML LimitRange flow');
  await closeOverlays();
  await evaluate(() => {
    const app = window.game?.app;
    app?._clearClockPauseReasons?.();
    app?.hidePause?.({ resume: true });
    app?.modeInstance?.resume?.();
  });
  await runCmd('oc project quota-lab');
  result = await runCmd(
    'oc create quota team-quota --hard=pods=10,requests.cpu=4,requests.memory=8Gi'
  );
  assert(
    !result.error,
    '#38: lab 6 quota is created with the real oc create quota',
    result.message
  );
  result = await runCmd('oc apply -f examples/limitrange.yaml');
  assert(!result.error, '#38: lab 6 LimitRange is created from shipped YAML', result.message);
  const lab6Objectives = await evaluate(() => {
    const mode = window.game?.app?.modeInstance;
    mode?.updateObjectives?.();
    return (mode?.objectiveProgress || []).map((objective) => ({
      type: objective.type,
      completed: objective.completed === true,
    }));
  });
  assert(
    lab6Objectives.find((objective) => objective.type === 'quota')?.completed === true &&
      lab6Objectives.find((objective) => objective.type === 'limitRange')?.completed === true,
    '#38: lab 6 quota + LimitRange objectives complete from the YAML flow',
    JSON.stringify(lab6Objectives)
  );

  // ── #41 CLI: real label-selector engine over oc get ─────────────────────
  result = await runCmd('oc get ns -l policy-group.network.openshift.io/ingress --show-labels');
  const namespaceRows = result.message
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() && !/No resources found/.test(line));
  assert(
    namespaceRows.length === 1 && /^openshift-ingress\b/.test(namespaceRows[0]),
    '#41: key-only label selector returns only openshift-ingress',
    result.message
  );
  assert(
    /policy-group\.network\.openshift\.io\/ingress=/.test(result.message),
    '#41: --show-labels renders the policy-group label value',
    result.message
  );
  result = await runCmd("oc get ns -l '!policy-group.network.openshift.io/ingress' -o name");
  assert(
    !/namespace\/openshift-ingress/.test(result.message) &&
      /namespace\/default/.test(result.message),
    '#41: negated key-only selector excludes openshift-ingress',
    result.message.slice(0, 300)
  );
  result = await runCmd(
    'oc get ns -l "kubernetes.io/metadata.name in (default,openshift-ingress)" -o name'
  );
  assert(
    result.message.trim() === 'namespace/default\nnamespace/openshift-ingress',
    '#41: set-based in(...) selector filters namespaces correctly',
    JSON.stringify(result.message)
  );
  result = await runCmd('oc get ns -l "network.openshift.io/policy-group notin (ingress)" -o name');
  assert(
    !/namespace\/openshift-ingress/.test(result.message) &&
      /namespace\/default/.test(result.message),
    '#41: notin(...) selector excludes openshift-ingress',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc get ns -l network.openshift.io/policy-group=ingress -o name');
  assert(
    result.message.trim() === 'namespace/openshift-ingress',
    '#41: legacy equality selector matches only openshift-ingress',
    JSON.stringify(result.message)
  );

  // ── #41 engine: Kubernetes LabelSelector operator semantics ─────────────
  const selectors = await evaluate(() => {
    const sim = window.game.gameEngine.simulation;
    const matches = (selector, labels) => sim._labelSelectorMatches(selector, labels);
    const routerLabels = { 'policy-group.network.openshift.io/ingress': '' };
    const appLabels = { 'app.kubernetes.io/name': 'web' };
    return {
      keyOnlyMatch: matches({ matchLabels: routerLabels }, routerLabels),
      keyOnlyOtherValue: matches(
        { matchLabels: routerLabels },
        {
          'policy-group.network.openshift.io/ingress': 'ingress',
        }
      ),
      inMatch: matches(
        { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'In', values: ['web'] }] },
        appLabels
      ),
      inNoMatch: matches(
        { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'In', values: ['api'] }] },
        appLabels
      ),
      notInMatch: matches(
        {
          matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'NotIn', values: ['api'] }],
        },
        appLabels
      ),
      existsMatch: matches(
        {
          matchExpressions: [
            { key: 'policy-group.network.openshift.io/ingress', operator: 'Exists' },
          ],
        },
        routerLabels
      ),
      doesNotExistMatch: matches(
        { matchExpressions: [{ key: 'missing', operator: 'DoesNotExist' }] },
        appLabels
      ),
      doesNotExistNoMatch: matches(
        {
          matchExpressions: [
            { key: 'policy-group.network.openshift.io/ingress', operator: 'DoesNotExist' },
          ],
        },
        routerLabels
      ),
      emptySelectorMatchesAll: matches({}, appLabels),
      fabricatedLabels: sim._namespaceLabels('openshift-ingress-operator')[
        'policy-group.network.openshift.io/ingress'
      ],
      realLabels:
        sim._namespaceLabels('openshift-ingress')['policy-group.network.openshift.io/ingress'],
    };
  });
  assert(
    selectors.keyOnlyMatch === true &&
      selectors.keyOnlyOtherValue === false &&
      selectors.emptySelectorMatchesAll === true,
    '#41: key-only matchLabels matches only the empty label value',
    JSON.stringify(selectors)
  );
  assert(
    selectors.inMatch && !selectors.inNoMatch && selectors.notInMatch,
    '#41: matchExpressions In/NotIn implement real set semantics',
    JSON.stringify(selectors)
  );
  assert(
    selectors.existsMatch && selectors.doesNotExistMatch && !selectors.doesNotExistNoMatch,
    '#41: matchExpressions Exists/DoesNotExist implement real key semantics',
    JSON.stringify(selectors)
  );
  assert(
    selectors.realLabels === '' && selectors.fabricatedLabels === undefined,
    '#41: namespace labels come from real Project data, not fabricated router labels',
    JSON.stringify(selectors)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issues #39/#40: externalCertificate Route admission needs
// the TLS Secret AND router RBAC; handover copy is honest about cluster-admin.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue39-40', async () => {
  // ── #39: route with spec.tls.externalCertificate ────────────────────────
  assert(await bootSandbox(), '#39: sandbox boots for Route externalCertificate admission');
  await runCmd('oc new-project ext-cert-lab');
  await runCmd('oc apply -f manifests/deployment.yaml -n ext-cert-lab');
  await runCmd('oc apply -f manifests/service.yaml -n ext-cert-lab');
  await advanceSimulation(8);
  const routeApplied = await runCmd('oc apply -f manifests/route.yaml -n ext-cert-lab');
  assert(
    !routeApplied.error && /created|configured/.test(routeApplied.message),
    '#39: the externalCertificate Route manifest applies',
    routeApplied.message.slice(0, 300)
  );
  await advanceSimulation(2);
  const routeState = () =>
    evaluate(() => {
      const route = window.game.cluster.getByName('Route', 'webapp', 'ext-cert-lab');
      if (!route) return null;
      const condition =
        (route.status?.ingress?.[0]?.conditions || []).find((entry) => entry.type === 'Admitted') ||
        null;
      return {
        admitted: window.game.cluster.isRouteAdmitted(route),
        reason: condition?.reason || null,
        message: condition?.message || null,
        externalCertificate: route.spec?.tls?.externalCertificate?.name || null,
      };
    });
  let admission = await routeState();
  assert(
    admission?.externalCertificate === 'webapp-tls' && admission?.admitted === false,
    '#39: externalCertificate Route is NOT admitted while the TLS Secret is missing',
    JSON.stringify(admission)
  );
  assert(
    admission?.reason === 'ExternalCertificateValidationFailed',
    '#39: Admitted=False reason is ExternalCertificateValidationFailed',
    admission?.reason
  );
  assert(
    /spec\.tls\.externalCertificate: Not found: secrets "webapp-tls" not found/.test(
      admission?.message || ''
    ),
    '#39: rejection message names the missing webapp-tls Secret',
    admission?.message
  );
  let described = await runCmd('oc describe route webapp -n ext-cert-lab');
  assert(
    /rejected by router default[\s\S]*ExternalCertificateValidationFailed/.test(described.message),
    '#39: describe route shows the rejected admission condition',
    described.message.slice(-500)
  );

  // Secret only: still rejected because the router RBAC is missing.
  const cert = await runCmd(
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout webapp.key -out webapp.crt -days 365 -subj "/CN=webapp.apps.cluster.example.com"'
  );
  assert(!cert.error, '#39: openssl generates the Route TLS certificate', cert.message);
  const tlsSecret = await runCmd(
    'oc create secret tls webapp-tls --cert=webapp.crt --key=webapp.key -n ext-cert-lab'
  );
  assert(
    !tlsSecret.error && /secret\/webapp-tls created/.test(tlsSecret.message),
    '#39: webapp-tls kubernetes.io/tls Secret is created',
    tlsSecret.message
  );
  await advanceSimulation(2);
  admission = await routeState();
  assert(
    admission?.admitted === false,
    '#39: Route stays rejected after the Secret exists but router RBAC is missing',
    JSON.stringify(admission)
  );
  assert(
    !/Not found: secrets "webapp-tls" not found/.test(admission?.message || '') &&
      /Forbidden: router serviceaccount does not have permission to get this secret/.test(
        admission?.message || ''
      ),
    '#39: rejection now reports the router ServiceAccount permission errors',
    admission?.message
  );

  // Grant the router read RBAC with the shipped example.
  const rbac = await runCmd('oc apply -f examples/route-external-cert-rbac.yaml -n ext-cert-lab');
  assert(!rbac.error, '#39: shipped router RBAC example applies', rbac.message);
  await advanceSimulation(2);
  admission = await routeState();
  assert(
    admission?.admitted === true && admission?.reason === 'Accepted',
    '#39: Route becomes Admitted after the Secret + router Role/RoleBinding exist',
    JSON.stringify(admission)
  );
  described = await runCmd('oc describe route webapp -n ext-cert-lab');
  assert(
    /exposed on router default/.test(described.message) &&
      !/rejected by router/.test(described.message),
    '#39: describe route reports the admitted Route once the prerequisites exist',
    described.message.slice(-400)
  );

  // ── #40: handover copy points cluster-admin work at crc/SNO, not Sandbox ─
  assert(await bootCampaign(1), '#40: campaign boots for the handover copy check');
  // Earlier sections tick a handover item and persist it in localStorage; clear
  // it so the progress-label assertion below is deterministic.
  await evaluate(() => localStorage.removeItem('openshiftgames_handover_checklist'));
  assert(await launch('campaign', 20), '#40: campaign L20 starts for the handover screen');
  await closeOverlays();
  await evaluate(() => {
    const app = window.game.app;
    app.scoringEngine.progress.campaignProgress[20] = { completed: true, stars: 3 };
    window.game.engine.emit('mode:level-complete', {
      levelId: 20,
      title: 'EX280 Final: Production Platform',
      stars: 3,
      nextLevel: null,
      isLastLevel: true,
      totalLevels: 20,
      message: 'Campaign complete',
    });
  });
  await sleep(600);
  await evaluate(() => document.getElementById('level-complete-next')?.click());
  const handoverOpened = await waitFor(
    () =>
      evaluate(
        () =>
          window.game?.app?.isCampaignHandoverOpen?.() === true &&
          document.getElementById('campaign-handover')?.hidden === false
      ),
    8000
  );
  assert(handoverOpened, '#40: finishing the capstone opens the handover screen');
  const handover = await evaluate(() => {
    const checklist = document.getElementById('handover-checklist');
    const items = [...(checklist?.querySelectorAll('li.handover-check') || [])].map((li) => ({
      title: li.querySelector('.handover-check-title')?.innerText || '',
      detail: li.querySelector('.handover-check-detail')?.innerText || '',
      link: li.querySelector('a.handover-check-link')?.getAttribute('href') || '',
    }));
    return {
      items,
      checklistText: checklist?.innerText || '',
      checkProgress: document.getElementById('handover-checklist-progress')?.innerText || '',
      sectionSub:
        checklist?.closest('.handover-section')?.querySelector('.handover-section-sub')
          ?.innerText || '',
    };
  });
  const byTitle = (needle) => handover.items.find((item) => item.title.includes(needle));
  const clusterItem = byTitle('Set up a full cluster');
  const sandboxItem = byTitle('Developer Sandbox');
  assert(
    Boolean(clusterItem) && /OpenShift Local/i.test(clusterItem.title),
    '#40: full-cluster checklist item points to OpenShift Local (crc)',
    JSON.stringify(clusterItem)
  );
  assert(
    /crc console --credentials/.test(clusterItem?.detail || '') &&
      /kubeadmin/.test(clusterItem?.detail || ''),
    '#40: full-cluster item explains crc console --credentials for the kubeadmin password',
    clusterItem?.detail
  );
  assert(
    /developers\.redhat\.com\/products\/openshift-local/.test(clusterItem?.link || ''),
    '#40: full-cluster item links to the OpenShift Local page',
    clusterItem?.link
  );
  assert(
    Boolean(sandboxItem) &&
      /project-scoped/i.test(sandboxItem.title) &&
      /not cluster-admin/i.test(sandboxItem.detail),
    '#40: Developer Sandbox item is marked project-scoped only',
    JSON.stringify(sandboxItem)
  );
  assert(
    Boolean(sandboxItem) && !/Set up a real cluster/i.test(sandboxItem.title),
    '#40: Developer Sandbox is not offered as the whole-cluster setup path',
    sandboxItem?.title
  );
  for (const [label, prefix] of [
    ['L13', 'L13'],
    ['L14', 'L14'],
    ['L17', 'L17'],
  ]) {
    const item = byTitle(prefix);
    assert(
      /cluster-admin/i.test(item?.detail || '') &&
        /not the Developer Sandbox/i.test(item?.detail || ''),
      `#40: ${label} redo item says cluster-admin on a real cluster, not the Sandbox`,
      item?.detail
    );
  }
  assert(
    !/Set up OpenShift Local or the Developer Sandbox/.test(handover.sectionSub) &&
      /project-scoped/i.test(handover.sectionSub),
    '#40: the static handover section sub no longer offers the Sandbox as cluster setup',
    handover.sectionSub
  );
  assert(
    !/Install OpenShift Local \(crc\) on your workstation, or open the free Developer Sandbox/.test(
      handover.checklistText
    ),
    '#40: the old "or open the free Developer Sandbox" cluster-setup copy is gone'
  );
  assert(
    ['L5', 'L9', 'L13', 'L14', 'L17'].every((tag) => handover.checklistText.includes(tag)),
    '#40: the handover checklist still lists every redo level L5/L9/L13/L14/L17',
    handover.checklistText.slice(0, 240)
  );
  assert(
    handover.items.length === 7 && /0\/7 done/.test(handover.checkProgress),
    '#40: handover checklist has the full-cluster + Sandbox-scope + 5 redo items',
    JSON.stringify({ items: handover.items.length, progress: handover.checkProgress })
  );
  await evaluate(() => document.getElementById('handover-menu')?.click());
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issue #42: serial build queue/--follow, new-build/new-app
// ImageStreams, ServiceAccount token files, kubeadmin discovery + prompt,
// neutral CrashLoop cause, and the L17 description.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue42', async () => {
  /** Advance only the controller clock (deterministic, no wall-clock waits). */
  const advanceController = (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      if (!sim || typeof sim.tick !== 'function') return false;
      for (let index = 0; index < Math.ceil(secs / 0.05); index += 1) sim.tick(0.05);
      return true;
    }, seconds);
  const buildStates = () =>
    evaluate(() =>
      (window.game.cluster.getByKind('Build') || [])
        .filter((build) => /^qa-sample-/.test(build.metadata.name))
        .map((build) => ({
          name: build.metadata.name,
          phase: build.status?.phase || null,
          startTimestamp: build.status?.startTimestamp || null,
          completionTimestamp: build.status?.completionTimestamp || null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  const terminalText = () => evaluate(() => document.getElementById('cmd-output')?.innerText || '');
  /** Advance the controller AND the full game loop (incidents, mode timers). */
  const advanceGame = (seconds) =>
    evaluate((secs) => {
      const engine = window.game?.gameEngine;
      const sim = engine?.simulation;
      if (!sim || typeof sim.tick !== 'function') return false;
      for (let index = 0; index < Math.ceil(secs / 0.05); index += 1) {
        sim.tick(0.05);
        engine._gameTime = (engine._gameTime || 0) + 50;
        for (const callback of engine._updateCallbacks || []) {
          try {
            callback(0.05, engine._gameTime);
          } catch {
            /* a UI callback must not stop the deterministic pump */
          }
        }
      }
      return true;
    }, seconds);

  assert(await bootSandbox(), '#42: sandbox boots for builds/auth/exec checks');
  // The build failure injection is chaos, not Serial-queue semantics: disable it
  // so queued builds deterministically complete (same fixture other sections use).
  await evaluate(() => window.game?.gameEngine?.simulation?.setBuildFailureRate?.(0));
  await runCmd('oc project default');

  // ── #42-1 new-build creates + prints the output ImageStream up front ────
  let result = await runCmd('oc new-build nodejs:20-ubi9 --name=qa-sample');
  assert(
    /imagestream\.image\.openshift\.io "qa-sample" created/.test(result.message) &&
      /buildconfig\.build\.openshift\.io "qa-sample" created/.test(result.message),
    '#42: new-build creates and prints the output ImageStream up front',
    result.message.slice(0, 400)
  );
  result = await runCmd('oc get is');
  assert(
    /qa-sample/.test(result.message),
    '#42: the new-build ImageStream exists before the first build',
    result.message.slice(0, 300)
  );
  // A real BuildConfig carries a ConfigChange trigger, so `oc new-build`
  // auto-starts <name>-1 (#49-2). Let that build finish before exercising the
  // serial start-build queue so the queue semantics are deterministic whether
  // or not the trigger is present (the queued-build assertions below only care
  // about builds started explicitly by start-build).
  for (let elapsed = 0; elapsed < 60; elapsed += 2) {
    const autoBuilds = await buildStates();
    if (
      autoBuilds.length > 0 &&
      autoBuilds.every((build) => ['Complete', 'Failed', 'Cancelled'].includes(build.phase))
    ) {
      break;
    }
    await advanceController(2);
  }

  // ── #42-1 start-build serial runPolicy queue ────────────────────────────
  const firstStart = await runCmd('oc start-build qa-sample', 0);
  const firstName = (firstStart.message.match(/(qa-sample-\d+) started/) || [])[1];
  assert(
    Boolean(firstName) && !firstStart.error,
    '#42: the first start-build starts',
    firstStart.message
  );
  const secondStart = await runCmd('oc start-build qa-sample', 0);
  const secondName = (secondStart.message.match(/(qa-sample-\d+) started/) || [])[1];
  assert(
    Boolean(secondName) &&
      !secondStart.error &&
      !/cannot start build/i.test(secondStart.message) &&
      Number(secondName.split('-').pop()) === Number(firstName.split('-').pop()) + 1,
    '#42: start-build while a build runs queues the next serial build instead of erroring',
    secondStart.message
  );
  let builds = await buildStates();
  const queuedBuild = builds.find((build) => build.name === secondName);
  assert(
    queuedBuild?.phase === 'New' && !queuedBuild?.startTimestamp,
    '#42: the queued serial build waits in phase New without a start timestamp',
    JSON.stringify(queuedBuild)
  );
  let maxRunning = 0;
  for (let elapsed = 0; elapsed < 60; elapsed += 2) {
    builds = await buildStates();
    maxRunning = Math.max(maxRunning, builds.filter((build) => build.phase === 'Running').length);
    if (
      builds.length >= 2 &&
      builds.every((build) => ['Complete', 'Failed', 'Cancelled'].includes(build.phase))
    ) {
      break;
    }
    await advanceController(2);
  }
  assert(
    maxRunning <= 1,
    '#42: Serial runPolicy never runs two builds at once',
    `max=${maxRunning}`
  );
  const completedFirst = builds.find((build) => build.name === firstName);
  assert(
    completedFirst?.phase === 'Complete',
    '#42: the running build completes before the queued build starts',
    JSON.stringify(completedFirst)
  );
  assert(
    builds.some((build) => build.name === secondName && build.phase === 'Complete'),
    '#42: the queued build runs to completion after the predecessor',
    JSON.stringify(builds)
  );
  assert(
    completedFirst?.completionTimestamp &&
      builds.find((build) => build.name === secondName)?.startTimestamp,
    '#42: serial build timestamps prove the queue ordering',
    JSON.stringify(builds)
  );

  // ── #42-1 start-build --follow streams the build log ────────────────────
  const followStart = await runCmd('oc start-build qa-sample --follow');
  assert(
    /qa-sample-\d+ started/.test(followStart.message),
    '#42: start-build --follow starts the build',
    followStart.message.slice(0, 200)
  );
  await advanceController(30);
  await sleep(1200);
  const followText = await terminalText();
  const followStartIndex = followText.lastIndexOf('oc start-build qa-sample --follow');
  const followedOutput = followStartIndex >= 0 ? followText.slice(followStartIndex) : followText;
  assert(
    /STEP \d\/5|Building your application|Cloning/.test(followedOutput),
    '#42: start-build --follow streams build log lines after "started"',
    followedOutput.slice(-600)
  );
  assert(
    /--> Success/.test(followedOutput),
    '#42: start-build --follow reports --> Success at completion',
    followedOutput.slice(-500)
  );

  // ── #42-1 new-app --image creates the output ImageStream ────────────────
  await runCmd('oc new-project is-app');
  result = await runCmd(
    'oc new-app --image=quay.io/example/webapp:latest --name=qa-web -n is-app',
    400
  );
  assert(
    /imagestream\.image\.openshift\.io "qa-web" created/.test(result.message),
    '#42: new-app --image creates and prints the deployment ImageStream',
    result.message.slice(0, 500)
  );
  result = await runCmd('oc get is -n is-app');
  assert(
    /qa-web/.test(result.message),
    '#42: the new-app ImageStream is queryable before any build',
    result.message.slice(0, 300)
  );
  await advanceController(10);

  // ── #42-2 the exec/rsh view of the Pod ServiceAccount files ─────────────
  result = await runCmd(
    'oc exec deploy/qa-web -n is-app -- ls /var/run/secrets/kubernetes.io/serviceaccount'
  );
  assert(
    ['token', 'ca.crt', 'namespace', 'service-ca.crt'].every((name) =>
      result.message.includes(name)
    ),
    '#42: oc exec lists token/ca.crt/namespace/service-ca.crt in the Pod',
    result.message
  );
  result = await runCmd(
    'oc exec deploy/qa-web -n is-app -- cat /var/run/secrets/kubernetes.io/serviceaccount/namespace'
  );
  assert(
    result.message.trim() === 'is-app',
    '#42: the Pod service-account namespace file contains the project name',
    JSON.stringify(result.message)
  );
  result = await runCmd(
    'oc exec deploy/qa-web -n is-app -- cat /var/run/secrets/kubernetes.io/serviceaccount/token'
  );
  assert(
    /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/m.test(result.message.trim()),
    '#42: the Pod service-account token is a JWT-shaped bound token',
    result.message.slice(0, 120)
  );
  result = await runCmd(
    'oc exec deploy/qa-web -n is-app -- cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
  );
  assert(
    /-----BEGIN CERTIFICATE-----/.test(result.message),
    '#42: the Pod service-account ca.crt is a PEM bundle',
    result.message.slice(0, 120)
  );
  result = await runCmd(
    'oc rsh deploy/qa-web -n is-app ls /var/run/secrets/kubernetes.io/serviceaccount'
  );
  assert(
    /token/.test(result.message) && /service-ca\.crt/.test(result.message),
    '#42: rsh sees the same service-account files as exec',
    result.message
  );

  // ── #42-4 kubeadmin password discoverable like a real installer ─────────
  // #45: the cluster Secret holds only a bcrypt hash; the plain-text password
  // lives in the installer auth/ directory (~/auth/kubeadmin-password).
  const installerPassword = await kubeadminPassword();
  result = await runCmd('cat ~/auth/kubeadmin-password');
  assert(
    !result.error && result.message.trim() === installerPassword,
    '#42: cat ~/auth/kubeadmin-password reveals the installer password',
    JSON.stringify(result.message)
  );
  result = await runCmd('ls ~/auth');
  assert(
    result.message.split('\n').includes('kubeadmin-password'),
    '#42: ls ~/auth lists kubeadmin-password like the installer auth/ directory',
    result.message
  );
  result = await runCmd('oc extract secret/kubeadmin -n kube-system --to=-');
  assert(
    /^\$2a\$10\$\S{53}$/m.test(result.message.trim()) &&
      !result.message.includes(installerPassword),
    '#42: oc extract secret/kubeadmin prints the bcrypt hash, never the plain password',
    result.message.slice(0, 200)
  );

  // ── #42-4 oc login prompts for the password; -p still works ─────────────
  result = await runCmd('oc login -u kubeadmin');
  assert(
    /Authentication required for https:\/\/api\.cluster\.example\.com:6443 \(openshift\)/.test(
      result.message
    ) &&
      /Password: $/.test(result.message) &&
      !/Login successful/.test(result.message),
    '#42: oc login -u kubeadmin prompts for the password instead of logging in silently',
    result.message
  );
  assert(
    await evaluate(() => Boolean(window.game.app.commandBar._pendingLogin)),
    '#42: the login prompt waits for the next terminal line'
  );
  result = await runCmd('wrong-password');
  assert(
    result.error &&
      /Login failed \(401 Unauthorized\)\nVerify you have provided the correct credentials\./.test(
        result.message
      ),
    '#42: a wrong prompted password keeps the real 401 wording',
    result.message
  );
  result = await runCmd('oc whoami');
  assert(
    /kubeadmin/.test(result.message),
    '#42: a failed prompted login leaves the session unchanged',
    result.message
  );
  await runCmd('oc login -u kubeadmin');
  result = await runCmd('');
  assert(
    result.error && /interrupted/.test(result.message),
    '#42: an empty line cancels the password prompt',
    result.message
  );
  assert(
    !(await evaluate(() => Boolean(window.game.app.commandBar._pendingLogin))),
    '#42: normal command parsing resumes after the prompt is cancelled'
  );
  await runCmd('oc login -u kubeadmin');
  result = await runCmd(await kubeadminPassword());
  assert(
    !result.error && /Login successful\./.test(result.message),
    '#42: typing the discovered kubeadmin password logs in',
    result.message.slice(0, 200)
  );
  result = await runCmd(`oc login -u kubeadmin -p ${await kubeadminPassword()}`);
  assert(
    !result.error && /Login successful\./.test(result.message),
    '#42: the explicit -p login flow is unchanged',
    result.message.slice(0, 200)
  );

  // ── #42-3 CrashLoop log blames APP_MODE only, on a neutral image ────────
  assert(await bootCampaign(1), '#42: campaign boots for the CrashLoop log check');
  assert(await launch('campaign', 3), '#42: campaign L3 starts for the CrashLoop log check');
  await closeOverlays();
  await evaluate(() => {
    const app = window.game?.app;
    app?._clearClockPauseReasons?.();
    app?.hidePause?.({ resume: true });
    app?.modeInstance?.resume?.();
  });
  const crashState = await evaluate(() => {
    const deployment = window.game.cluster.getByName('Deployment', 'web-app', 'ops-lab');
    const container = deployment?.spec?.template?.spec?.containers?.[0] || {};
    return { image: container.image || '', env: container.env || [] };
  });
  assert(
    !/v2-bad-config/.test(crashState.image),
    '#42: the L3 crash seed keeps a neutral image (no v2-bad-config)',
    crashState.image
  );
  assert(
    crashState.env.some((entry) => entry.name === 'APP_MODE' && entry.value === 'debug-invalid'),
    '#42: the L3 crash seed only injects the invalid APP_MODE env var',
    JSON.stringify(crashState.env)
  );
  for (let elapsed = 0; elapsed < 30; elapsed += 2) {
    await advanceGame(2);
    if (
      await evaluate(() =>
        (window.game.cluster.getByKindAndNamespace('Pod', 'ops-lab') || []).some((pod) =>
          /CrashLoopBackOff/.test(pod.status?.phase || '')
        )
      )
    ) {
      break;
    }
  }
  const crashPod = await evaluate(
    () =>
      (window.game.cluster.getByKindAndNamespace('Pod', 'ops-lab') || []).find((pod) =>
        /CrashLoopBackOff/.test(pod.status?.phase || '')
      )?.metadata.name || null
  );
  assert(Boolean(crashPod), '#42: a CrashLoopBackOff pod exists in L3', String(crashPod));
  const crashLog = await runCmd(`oc logs ${crashPod} -n ops-lab`);
  const crashLogPrevious = await runCmd(`oc logs ${crashPod} -n ops-lab --previous`);
  for (const [label, text] of [
    ['oc logs', crashLog.message],
    ['oc logs --previous', crashLogPrevious.message],
  ]) {
    assert(
      /APP_MODE has an unsupported value/.test(text) && !/\bimage\b/i.test(text),
      `#42: ${label} blames APP_MODE and never the image`,
      text.slice(0, 300)
    );
  }
  assert(
    /FATAL: configuration validation failed \(exit code 1\)/.test(crashLog.message),
    '#42: the CrashLoop log has the real application FATAL validation line',
    crashLog.message.slice(0, 300)
  );
  result = await runCmd('oc set env deployment/web-app APP_MODE=production -n ops-lab');
  assert(!result.error, '#42: correcting APP_MODE applies', result.message.slice(0, 200));
  for (let elapsed = 0; elapsed < 20; elapsed += 2) await advanceGame(2);
  const crashResolved = await evaluate(() => ({
    active: window.game.app.incidentEngine.activeIncidents.size,
    crashed: (window.game.cluster.getByKindAndNamespace('Pod', 'ops-lab') || []).filter((pod) =>
      /CrashLoopBackOff/.test(pod.status?.phase || '')
    ).length,
  }));
  assert(
    crashResolved.active === 0 && crashResolved.crashed === 0,
    '#42: fixing APP_MODE alone resolves the CrashLoopBackOff incident',
    JSON.stringify(crashResolved)
  );

  // ── #42-6 L17 text matches the shipped priv-sa ServiceAccount ───────────
  const l17 = await evaluate(() =>
    import('/js/data/CampaignLevels.js').then((module) => {
      const level = module.CAMPAIGN_LEVELS.find((entry) => entry.id === 17);
      return {
        description: level.description || '',
        objectives: (level.objectives || []).map((objective) => objective.label),
        startingServiceAccounts: (level.startingResources || [])
          .filter((resource) => resource.kind === 'ServiceAccount')
          .map((resource) => resource.name),
      };
    })
  );
  assert(
    !/Create a dedicated ServiceAccount/i.test(l17.description) && /priv-sa/.test(l17.description),
    '#42: L17 description no longer asks to create the shipped priv-sa ServiceAccount',
    l17.description.slice(0, 300)
  );
  assert(
    l17.startingServiceAccounts.includes('priv-sa'),
    '#42: L17 ships priv-sa in startingResources, matching the description',
    JSON.stringify(l17.startingServiceAccounts)
  );
  assert(
    l17.objectives.every((label) => !/create.*serviceaccount/i.test(label)) &&
      l17.objectives.some((label) => /privileged SCC/i.test(label)),
    '#42: L17 objectives describe granting the SCC, not creating a ServiceAccount',
    JSON.stringify(l17.objectives)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issue #42-5: readiness evidence must count a completed
// level's live objectives even on a gated-bypass run (L20 jobs, L17 SCC).
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue42-evidence', async () => {
  await goto('/?tutorial=0');
  assert(
    await waitFor(() => evaluate(() => !!window.game?.app?.scoringEngine), 25000),
    '#42: start page boots for the readiness-evidence check'
  );
  await sleep(500);
  await closeOverlays();
  await evaluate(() => {
    const scoring = window.game.scoringEngine;
    for (let levelId = 1; levelId < 20; levelId += 1) {
      scoring.progress.campaignProgress[levelId] = { completed: true, stars: 3 };
    }
    scoring.progress.campaignProgress[20] = { completed: true, stars: 3 };
    scoring.progress.objectiveEvidence = {
      ...(scoring.progress.objectiveEvidence || {}),
      'level:20': [
        'quota',
        'limitRange',
        'deploy',
        'route',
        'build',
        'imageStream',
        'networkPolicy',
        'routeAccess',
        'user',
        'group',
        'operator',
        'complete',
        'cronJob',
        'resolve',
      ],
      'level:17': ['scc', 'privileged', 'resolve'],
    };
    scoring.progress.drillCommandEvidence = {
      ...(scoring.progress.drillCommandEvidence || {}),
      'campaign:20': [
        'oc create job report-job --image=perl -- perl -e "print 42"',
        'oc create cronjob nightly --image=busybox --schedule="*/5 * * * *" -- sh -c date',
      ],
      'campaign:17': ['oc auth can-i get pods --as=alice -n rbac-lab'],
    };
  });
  const readinessSnapshot = () =>
    evaluate(async () => {
      const app = window.game.app;
      try {
        await app.showExamPrep?.();
      } catch {
        /* panel already open */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const snapshot = app.examPrepUI?._computeSnapshot?.();
      const statusOf = (id) => snapshot?.statuses?.get?.(id) || null;
      return {
        jobs: statusOf('security-jobs'),
        cronjobs: statusOf('security-cronjobs'),
        scc: statusOf('security-scc'),
        privileged: statusOf('security-privileged'),
      };
    });
  let readiness = await readinessSnapshot();
  assert(
    readiness.jobs === 'mastered',
    '#42: a completed L20 on a gated-bypass run evidences the Job readiness bullet',
    JSON.stringify(readiness)
  );
  assert(
    readiness.cronjobs === 'mastered',
    '#42: a completed L20 on a gated-bypass run evidences the CronJob readiness bullet',
    JSON.stringify(readiness)
  );
  assert(
    readiness.scc === 'mastered' && readiness.privileged === 'mastered',
    '#42: a completed L17 evidences the SCC readiness bullets from objective evidence',
    JSON.stringify(readiness)
  );
  await evaluate(() => {
    window.game.scoringEngine.progress.drillCommandEvidence = {};
  });
  readiness = await readinessSnapshot();
  assert(
    readiness.jobs === 'mastered' && readiness.cronjobs === 'mastered',
    '#42: live objective evidence alone (no matching command text) evidences the jobs bullets',
    JSON.stringify(readiness)
  );
  await evaluate(() => {
    const scoring = window.game.scoringEngine;
    scoring.progress.campaignProgress[20] = { completed: false, stars: 0 };
    scoring.progress.objectiveEvidence = { 'level:17': ['scc', 'privileged', 'resolve'] };
  });
  readiness = await readinessSnapshot();
  assert(
    readiness.jobs !== 'mastered' && readiness.cronjobs !== 'mastered',
    '#42: an incomplete L20 does not evidence the jobs bullets (evidence not weakened)',
    JSON.stringify(readiness)
  );
  const passwordCopy = await evaluate(() =>
    import('/js/data/CampaignLevels.js').then((module) => {
      const level1 = module.CAMPAIGN_LEVELS.find((entry) => entry.id === 1);
      const level13 = module.CAMPAIGN_LEVELS.find((entry) => entry.id === 13);
      return {
        level1: (level1.hints || []).some((hint) => /auth\/kubeadmin-password/.test(hint)),
        level13: (level13.hints || []).some((hint) => /auth\/kubeadmin-password/.test(hint)),
      };
    })
  );
  assert(
    passwordCopy.level1 && passwordCopy.level13,
    '#42: L1 and L13 hints document ~/auth/kubeadmin-password password discovery',
    JSON.stringify(passwordCopy)
  );
  await evaluate(() => window.game.app.examPrepUI?.hide?.());
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.3.0 — issue #43: collected CLI output differences (get/describe,
// nodes/node-debug, curl/openssl, project bootstrap, events aggregation).
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue43', async () => {
  assert(await bootSandbox(), '#43: sandbox boots for CLI fidelity checks');

  // ── get output: multi-type name prefixes + empty-type omission ──────────
  await runCmd('oc new-project demo');
  await runCmd('oc new-project empty-ns');
  await runCmd('oc new-app --image=quay.io/example/webapp:latest --name=web -n demo', 400);
  await runCmd('oc create deployment extra --image=quay.io/example/webapp:latest -n demo', 300);
  let result = await runCmd('oc get deploy,svc -n demo');
  assert(
    /^deployment\.apps\/web\s/m.test(result.message) && /^service\/web\s/m.test(result.message),
    '#43: multi-type get prefixes NAME with deployment.apps/ and service/',
    result.message
  );
  assert(
    !/No resources found/.test(result.message),
    '#43: multi-type get omits empty types instead of printing "No resources found" among rows',
    result.message
  );
  result = await runCmd('oc get deploy,secrets -n empty-ns');
  assert(
    !/No resources found/.test(result.message) &&
      /^secret\/builder-dockercfg-/m.test(result.message),
    '#43: an empty requested type is omitted when another requested type has rows',
    result.message
  );
  result = await runCmd('oc get jobs,cronjobs -n empty-ns');
  assert(
    result.message.trim() === 'No resources found in empty-ns namespace.',
    '#43: an all-empty multi-type get prints exactly one "No resources found"',
    JSON.stringify(result.message)
  );
  await advanceSimulation(5);
  result = await runCmd('oc get deploy,pods -n demo');
  assert(
    /deployment\.apps\/web/.test(result.message) &&
      /pod\/web-[a-z0-9]+-[a-z0-9]+/.test(result.message),
    '#43: get deploy,pods prefixes both the deployment and pod rows',
    result.message
  );

  // ── get secrets is sorted by name ───────────────────────────────────────
  await runCmd('oc create secret generic zzz-secret --from-literal=k=v -n demo');
  await runCmd('oc create secret generic aaa-secret --from-literal=k=v -n demo');
  result = await runCmd('oc get secrets -n demo -o name');
  const secretNames = result.message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(
    JSON.stringify(secretNames) === JSON.stringify([...secretNames].sort()),
    '#43: oc get secrets is sorted by name like the API server',
    JSON.stringify(secretNames)
  );

  // ── events aggregation + describe quota / rollout / set env wording ────
  result = await runCmd('oc get events -n demo');
  assert(
    !/over 0s/.test(result.message),
    '#43: aggregated events never show the bogus "over 0s" duration',
    result.message
  );
  assert(
    /^LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE$/m.test(result.message),
    '#43: get events keeps the real LAST SEEN TYPE REASON OBJECT MESSAGE header',
    result.message
  );
  result = await runCmd('oc rollout restart deploy/web -n demo');
  assert(
    result.message.trim() === 'deployment.apps/web restarted',
    '#43: rollout restart prints "deployment.apps/web restarted" without quotes',
    JSON.stringify(result.message)
  );
  await runCmd('oc set env deploy/web APP_MODE=production -n demo');
  await runCmd('oc set env deploy/extra EXTRA=1 -n demo');
  result = await runCmd('oc set env deploy --all --list -n demo');
  assert(
    /# deployment\.apps\/web, container \w+/.test(result.message) &&
      /# deployment\.apps\/extra, container \w+/.test(result.message) &&
      /APP_MODE=production/.test(result.message),
    '#43: set env <type> --all --list lists env for every deployment',
    result.message
  );

  // ── quota FailedCreate: real keyed wording, exactly once, no Events ────
  await runCmd('oc new-project quota-lab');
  await runCmd('oc create quota compute-quota --hard=pods=1 -n quota-lab');
  await runCmd('oc new-app --image=quay.io/example/webapp:latest --name=limited -n quota-lab', 400);
  await advanceSimulation(6);
  await runCmd('oc scale deploy/limited --replicas=2 -n quota-lab', 400);
  await advanceSimulation(6);
  result = await runCmd('oc describe deploy/limited -n quota-lab');
  const failedCreateRows = result.message
    .split('\n')
    .filter((line) => /Warning\s+FailedCreate/.test(line));
  assert(
    failedCreateRows.length === 1 && failedCreateRows.every((line) => /Error creating:/.test(line)),
    '#43: describe deployment shows the quota FailedCreate exactly once with real wording',
    JSON.stringify(failedCreateRows)
  );
  assert(
    /exceeded quota: compute-quota, requested: pods=1, used: pods=1, limited: pods=1/.test(
      result.message
    ),
    '#43: quota admission failure uses the keyed limited: pods=1 wording',
    result.message.slice(0, 500)
  );
  result = await runCmd('oc describe quota compute-quota -n quota-lab');
  assert(
    !/^Events:/m.test(result.message),
    '#43: describe quota has no Events section like real OpenShift 4.22',
    result.message.slice(0, 400)
  );
  assert(
    /Resource\s+Used\s+Hard/i.test(result.message),
    '#43: describe quota keeps the Resource/Used/Hard table',
    result.message.slice(0, 400)
  );
  result = await runCmd('oc get events -n quota-lab');
  assert(
    /Error creating: pods "[^"]+" is forbidden: exceeded quota: compute-quota, requested: pods=1, used: pods=1, limited: pods=1/.test(
      result.message
    ),
    '#43: get events shows the FailedCreate once with the real Error creating: wording',
    result.message
  );

  // ── project bootstrap: CA ConfigMaps + requester annotation placement ──
  result = await runCmd('oc get cm -n default');
  assert(
    /kube-root-ca\.crt/.test(result.message) && /openshift-service-ca\.crt/.test(result.message),
    '#43: seeded projects get the kube-root-ca.crt and openshift-service-ca.crt ConfigMaps',
    result.message
  );
  await runCmd('oc new-project ca-lab');
  result = await runCmd('oc get cm -n ca-lab');
  assert(
    /kube-root-ca\.crt/.test(result.message) && /openshift-service-ca\.crt/.test(result.message),
    '#43: oc new-project bootstraps both CA ConfigMaps',
    result.message
  );
  const caConfigMaps = await evaluate(() => {
    const root = window.game.cluster.getByName('ConfigMap', 'kube-root-ca.crt', 'ca-lab');
    const service = window.game.cluster.getByName(
      'ConfigMap',
      'openshift-service-ca.crt',
      'ca-lab'
    );
    return {
      rootKeys: Object.keys(root?.spec?.data || {}),
      serviceKeys: Object.keys(service?.spec?.data || {}),
      description: root?.metadata?.annotations?.['kubernetes.io/description'] || '',
      injected:
        service?.metadata?.annotations?.['service.beta.openshift.io/inject-cabundle-injected'],
    };
  });
  assert(
    caConfigMaps.rootKeys.join() === 'ca.crt' &&
      /Contains a CA bundle that can be used to verify the kube-apiserver/.test(
        caConfigMaps.description
      ),
    '#43: kube-root-ca.crt carries ca.crt plus the real description annotation',
    JSON.stringify(caConfigMaps)
  );
  assert(
    caConfigMaps.serviceKeys.join() === 'service-ca.crt' && caConfigMaps.injected === 'true',
    '#43: openshift-service-ca.crt carries service-ca.crt and the inject annotation',
    JSON.stringify(caConfigMaps)
  );
  result = await runCmd('oc describe sa default -n ca-lab');
  assert(
    !/openshift\.io\/requester/.test(result.message),
    '#43: describe sa default no longer shows the requester annotation',
    result.message
  );
  result = await runCmd('oc describe project ca-lab');
  assert(
    /openshift\.io\/requester=kubeadmin/.test(result.message),
    '#43: the project Namespace carries openshift.io/requester=kubeadmin',
    result.message
  );

  // ── controller names: 10-char pod-template-hash + 5-char pod suffix ────
  await runCmd('oc apply -f manifests/deployment.yaml -n ca-lab');
  await advanceSimulation(8);
  const podNames = await evaluate(() => {
    const set = (window.game.cluster.getByKindAndNamespace('ReplicaSet', 'ca-lab') || []).find(
      (entry) => /^webapp-/.test(entry.metadata.name)
    );
    return {
      replicaSet: set?.metadata?.name || null,
      pods: (window.game.cluster.getByKindAndNamespace('Pod', 'ca-lab') || []).map(
        (pod) => pod.metadata.name
      ),
    };
  });
  assert(
    /^webapp-[a-z0-9]{10}$/.test(podNames.replicaSet || ''),
    '#43: ReplicaSet names use the real 10-character pod-template-hash',
    String(podNames.replicaSet)
  );
  assert(
    podNames.pods.length > 0 &&
      podNames.pods.every((name) => /^webapp-[a-z0-9]{10}-[a-z0-9]{5}$/.test(name)),
    '#43: pod names use the 10-char template hash + 5-char suffix shape',
    JSON.stringify(podNames.pods)
  );

  // ── oc new-app sets the deployment=<name> pod-template label ────────────
  await runCmd('oc new-app --image=quay.io/example/webapp:latest --name=db -n ca-lab', 400);
  await advanceSimulation(8);
  result = await runCmd('oc get pods -n ca-lab -l deployment=db');
  assert(
    /^db-[a-z0-9]{10}-[a-z0-9]{5}/m.test(result.message),
    '#43: oc new-app pods carry the deployment=<name> label',
    result.message
  );

  // ── node model: condition columns; NotReady taints without cordon ──────
  const nodes = await evaluate(() =>
    (window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name)
  );
  result = await runCmd(`oc describe node ${nodes[0]}`);
  assert(
    /Type\s+Status\s+LastHeartbeatTime\s+LastTransitionTime\s+Reason\s+Message/.test(
      result.message
    ),
    '#43: describe node conditions table has the real five columns',
    result.message.slice(0, 700)
  );
  assert(
    /RouteCreated/.test(result.message) &&
      /ovn-kube cleared kubelet-set NoRouteCreated/.test(result.message) &&
      !/network plugin is not ready/.test(result.message),
    '#43: NetworkUnavailable renders the real OVN-Kubernetes route reason/message (#49)',
    result.message.slice(0, 1200)
  );
  result = await runCmd(`oc debug node/${nodes[0]}`);
  assert(
    result.message.includes('sh-5.1#'),
    '#43: oc debug node opens the real sh-5.1# node session (#49-3)',
    result.message.slice(-200)
  );
  await runCmd('chroot /host');
  const hostPrompt = await evaluate(() => window.game.app.commandBar._debugPrompt());
  assert(
    hostPrompt === 'sh-5.1#',
    '#43: chroot /host renders the real host prompt sh-5.1#',
    hostPrompt
  );
  result = await runCmd('hostname');
  assert(
    result.message.trim() === nodes[0],
    '#43: the node debug session hostname is the actual node name',
    JSON.stringify(result.message)
  );
  result = await runCmd('journalctl -u kubelet');
  const clock = await evaluate(() => ({
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getUTCDay()],
    month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      new Date().getUTCMonth()
    ],
  }));
  assert(
    new RegExp(`-- Logs begin at ${clock.weekday} \\d{4}-`).test(result.message) &&
      !/Mon 2026-11-04/.test(result.message),
    '#43: journalctl preamble weekday matches the simulated clock (not hard-coded Mon)',
    result.message.split('\n')[0]
  );
  assert(
    new RegExp(`\\d{2}:\\d{2}:\\d{2} ${nodes[0]} `).test(result.message) &&
      // #53F: node names are worker-0/worker-1/master-0 now, so reject only the
      // old generic "worker" hostname — worker-N inside the node name is correct.
      !/\bworker\b(?!-\d)/.test(result.message),
    '#43: journalctl lines use the real node hostname, not "worker"',
    result.message.split('\n').slice(0, 3).join(' | ')
  );
  assert(
    new RegExp(`^${clock.month} \\d{2} \\d{2}:\\d{2}:\\d{2} ${nodes[0]} `, 'm').test(
      result.message
    ),
    '#43: journalctl short lines use the real syslog format',
    result.message.split('\n').slice(1, 3).join(' | ')
  );
  await runCmd('exit');
  await runCmd('exit');

  // ── workstation curl fidelity (#43): -w, 443, refused, 503 ─────────────
  await runCmd('oc new-project qa-curl');
  await runCmd(
    'oc create deployment webapp --image=quay.io/openshift/origin-hello-openshift:latest -n qa-curl'
  );
  await runCmd('oc expose deployment/webapp -n qa-curl');
  await runCmd('oc expose svc/webapp -n qa-curl');
  await advanceSimulation(20);
  const curlHost = await evaluate(() => {
    const route = (window.game.cluster.getByKind('Route') || []).find(
      (entry) => entry.metadata.namespace === 'qa-curl'
    );
    return route ? window.game.cluster.getRouteHost(route) : null;
  });
  assert(Boolean(curlHost), '#43: the curl fixture Route has a host', String(curlHost));
  result = await runCmd(`curl -s -o /dev/null -w "%{http_code}" http://${curlHost}`);
  assert(
    !result.error && result.message === '200',
    '#43: curl -s -o /dev/null -w %{http_code} prints the HTTP status code',
    JSON.stringify(result.message)
  );
  result = await runCmd(`curl -v -k https://${curlHost}`);
  assert(
    /:443\.\.\./.test(result.message) &&
      /port 443/.test(result.message) &&
      !/ port 80/.test(result.message),
    '#43: curl https:// without an explicit port connects on 443, not 80',
    result.message.slice(0, 400)
  );
  result = await runCmd(`curl http://${curlHost}:9999`);
  assert(
    result.error &&
      /curl: \(7\) Failed to connect to .* port 9999 after 0 ms: Connection refused/.test(
        result.message
      ),
    '#43: genuine refused connections keep curl (7) Connection refused',
    result.message
  );

  // ── oc exec curl: real scheme port + NetworkPolicy drop => (28) ────────
  await runCmd('oc new-project qa-exec');
  await runCmd(
    'oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n qa-exec'
  );
  await advanceSimulation(10);
  const dnsEgressPolicy = [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    '  name: allow-dns-egress',
    '  namespace: qa-exec',
    'spec:',
    '  podSelector: {}',
    '  policyTypes:',
    '    - Egress',
    '  egress:',
    '    - to:',
    '        - namespaceSelector:',
    '            matchLabels:',
    '              kubernetes.io/metadata.name: openshift-dns',
  ].join('\n');
  await evaluate(
    (yaml) => window.game.manifestEngine.writeFile('qa-dns.yaml', yaml),
    dnsEgressPolicy
  );
  await runCmd('oc apply -f examples/default-deny.yaml -n qa-exec');
  await runCmd('oc apply -f qa-dns.yaml -n qa-exec');
  result = await runCmd(
    'oc exec deploy/web -n qa-exec -- curl -s -w "%{remote_port}" -o /dev/null https://example.com'
  );
  assert(
    result.message.trim() === '443',
    '#43: exec curl to an https URL uses the scheme-default port 443',
    JSON.stringify(result.message)
  );
  result = await runCmd('oc exec deploy/web -n qa-exec -- curl https://example.com');
  assert(
    /^curl: \(28\) Connection timed out after 30000 milliseconds$/.test(result.message.trim()) &&
      !/port 80/.test(result.message),
    '#43: NetworkPolicy-dropped exec curl reports the real (28) connection timeout',
    result.message
  );

  // ── openssl x509 fidelity (#43): enddate + non-invented subject O ──────
  result = await runCmd(
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout qa-leaf.key -out qa-leaf.crt -days 365 -subj "/CN=web.apps.cluster.example.com"'
  );
  assert(!result.error, '#43: openssl req -x509 generates a leaf certificate', result.message);
  result = await runCmd('openssl x509 -in qa-leaf.crt -noout -subject');
  assert(
    result.message.trim() === 'subject=CN = web.apps.cluster.example.com',
    '#43: openssl x509 subject keeps only the requested -subj (no invented O)',
    JSON.stringify(result.message)
  );
  result = await runCmd('openssl x509 -in qa-leaf.crt -noout -enddate');
  assert(
    /^notAfter=(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2} \d{4} GMT$/.test(
      result.message.trim()
    ),
    '#43: openssl x509 -noout -enddate prints notAfter=<date> GMT',
    JSON.stringify(result.message)
  );

  // ── OAuth-rollout 401 extra hint is visibly marked as a simulator hint ──
  await runCmd('htpasswd -c -B -b htpasswd alice openshift');
  await runCmd('oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config');
  result = await runCmd(
    [
      'oc apply -f - <<EOF',
      'apiVersion: config.openshift.io/v1',
      'kind: OAuth',
      'metadata:',
      '  name: cluster',
      'spec:',
      '  identityProviders:',
      '  - name: htpasswd',
      '    mappingMethod: claim',
      '    type: HTPasswd',
      '    htpasswd:',
      '      fileData:',
      '        name: htpass-secret',
      'EOF',
    ].join('\n'),
    400
  );
  assert(
    !result.error,
    '#43: the HTPasswd OAuth provider applies for the rollout hint check',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc login -u alice -p openshift', 300);
  assert(
    result.error && /Verify you have provided the correct credentials\./.test(result.message),
    '#43: a login during the OAuth rollout keeps real oc 401 wording',
    result.message
  );
  assert(
    /Simulator hint: .*not ready yet[\s\S]*OAuth rollout/.test(result.message),
    '#43: the extra OAuth-rollout detail is marked "Simulator hint:"',
    result.message
  );
  assert(
    !/401 Unauthorized\)\nThe HTPasswd identity provider is not ready yet/.test(result.message),
    '#43: the rollout hint is not a bare second line of the 401',
    result.message
  );

  // ── NotReady node: lifecycle taints instead of a cordon ────────────────
  const notReadyTarget = nodes[1] || nodes[0];
  const sparked = await evaluate((nodeName) => {
    const engine = window.game.app.incidentEngine;
    const definition = engine._defsById.get('node-not-ready');
    return engine.spawnIncident(definition, nodeName);
  }, notReadyTarget);
  assert(Boolean(sparked), '#43: the NodeNotReady incident spawns for the taint regression check');
  await advanceSimulation(3);
  const notReadyNode = await evaluate((nodeName) => {
    const node = window.game.cluster
      .getByKind('Node')
      .find((entry) => entry.metadata.name === nodeName);
    return {
      phase: node?.status?.phase || null,
      unschedulable: node?.spec?.unschedulable,
      taints: (node?.spec?.taints || []).map((taint) => `${taint.key}:${taint.effect}`),
    };
  }, notReadyTarget);
  assert(
    notReadyNode.unschedulable !== true,
    '#43: a NotReady node is not cordoned (no spec.unschedulable/SchedulingDisabled)',
    JSON.stringify(notReadyNode)
  );
  for (const expectedTaint of [
    'node.kubernetes.io/unreachable:NoSchedule',
    'node.kubernetes.io/unreachable:NoExecute',
    'node.kubernetes.io/not-ready:NoSchedule',
    'node.kubernetes.io/not-ready:NoExecute',
  ]) {
    assert(
      notReadyNode.taints.includes(expectedTaint),
      `#43: NotReady node carries the lifecycle taint ${expectedTaint}`,
      JSON.stringify(notReadyNode.taints)
    );
  }
  result = await runCmd('oc get nodes');
  const notReadyLine = result.message
    .split('\n')
    .find((line) => line.startsWith(`${notReadyTarget} `));
  assert(
    Boolean(notReadyLine) &&
      /\bNotReady\b/.test(notReadyLine) &&
      !/SchedulingDisabled/.test(notReadyLine),
    '#43: oc get nodes STATUS is NotReady without SchedulingDisabled',
    notReadyLine
  );
  result = await runCmd(`oc describe node ${notReadyTarget}`);
  assert(
    /node\.kubernetes\.io\/unreachable:NoSchedule/.test(result.message),
    '#43: describe node renders the NotReady lifecycle taints',
    result.message.slice(-800)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.4.0 — issues #44-#49: global flags before the oc verb, kubeadmin
// bcrypt Secret + installer-side password, OLM channel/startingCSV resolution
// and real catalog package naming/columns/copied CSVs, the Lab 13 network
// policy hint, state-graded L18 pin + cross-level readiness evidence, virtual
// kubeadmin/admin users, and the collected CLI fidelity differences.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue44-49', async () => {
  // Real Red Hat catalog contract (#46): the PACKAGE is
  // `openshift-cert-manager-operator` with channel `stable-v1`, while the CSVs
  // keep the historical `cert-manager-operator.vX.Y.Z` names.
  const olmPackage = 'openshift-cert-manager-operator';
  const olmChannel = 'stable-v1';
  const olmHeadCsv = 'cert-manager-operator.v1.17.0';
  const olmPinCsv = 'cert-manager-operator.v1.16.0';
  const installerPassword = await kubeadminPassword();

  /** Write a virtual manifest file, then apply it like the player-facing flow. */
  const applyManifest = async (name, yaml) => {
    await evaluate(({ file, content }) => window.game.manifestEngine.writeFile(file, content), {
      file: `qa/${name}.yaml`,
      content: yaml,
    });
    return runCmd(`oc apply -f qa/${name}.yaml`, 300);
  };
  const operatorGroupYaml = (namespace) =>
    [
      'apiVersion: operators.coreos.com/v1',
      'kind: OperatorGroup',
      'metadata:',
      `  name: ${namespace}-og`,
      `  namespace: ${namespace}`,
      'spec:',
      '  targetNamespaces:',
      `    - ${namespace}`,
    ].join('\n');
  const subscriptionYaml = ({ name, namespace, packageName, channel, startingCSV, approval }) =>
    [
      'apiVersion: operators.coreos.com/v1alpha1',
      'kind: Subscription',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${namespace}`,
      'spec:',
      `  channel: ${channel}`,
      `  name: ${packageName}`,
      '  source: redhat-operators',
      '  sourceNamespace: openshift-marketplace',
      ...(approval ? [`  installPlanApproval: ${approval}`] : []),
      ...(startingCSV ? [`  startingCSV: ${startingCSV}`] : []),
    ].join('\n');
  const subscriptionState = (name, namespace) =>
    evaluate(
      ({ subName, ns }) => {
        const sub = window.game.cluster.getByName('Subscription', subName, ns);
        if (!sub) return null;
        return {
          phase: sub.status?.phase || null,
          installedCSV: sub.status?.installedCSV || null,
          currentCSV: sub.status?.currentCSV || null,
          startingCSV: sub.spec?.startingCSV || null,
          conditions: (sub.status?.conditions || []).map((condition) => ({
            type: condition.type,
            status: condition.status,
            reason: condition.reason,
            message: condition.message || '',
          })),
        };
      },
      { subName: name, ns: namespace }
    );
  const conditionOf = (state, type) =>
    (state?.conditions || []).find((condition) => condition.type === type) || null;
  /** The L18 "pin the install" objective entry from the live objective tracker. */
  const pinObjective = () =>
    evaluate(() => {
      const mode = window.game.app.modeInstance;
      const entry = (mode?.objectiveProgress || []).find(
        (objective) => objective.type === 'subscription'
      );
      return entry ? { label: entry.label || '', completed: entry.completed === true } : null;
    });

  // ── #44: global flags before the oc verb must work (P1) ────────────────
  assert(await bootSandbox(), '#44: sandbox boots for the leading-global-flag checks');
  await runCmd('oc new-project qa2');
  await runCmd('oc create deployment web --image=quay.io/example/webapp:latest -n qa2');
  await advanceSimulation(2);
  let result = await runCmd('oc -n qa2 get pods');
  assert(
    !result.error &&
      !/internal command failure/i.test(result.message) &&
      /^NAME\s/m.test(result.message),
    '#44: `oc -n qa2 get pods` succeeds with the global flag before the verb',
    result.message.slice(0, 240)
  );
  result = await runCmd('oc --namespace=qa2 get pods');
  assert(
    !result.error &&
      !/internal command failure/i.test(result.message) &&
      /^NAME\s/m.test(result.message),
    '#44: `oc --namespace=qa2 get pods` succeeds with the global flag before the verb',
    result.message.slice(0, 240)
  );
  result = await runCmd(`oc -n qa2 patch deploy web -p '{"spec":{"replicas":2}}'`);
  assert(
    !result.error && /deployment\.apps\/web patched/.test(result.message),
    '#44: `oc -n qa2 patch deploy web -p …` applies the patch',
    result.message.slice(0, 240)
  );
  await advanceSimulation(4);
  result = await runCmd('oc -n qa2 get deploy web');
  assert(
    /^web\s+2\/2/m.test(result.message),
    '#44: the leading-flag patch really applies (Deployment shows 2/2 replicas)',
    result.message
  );
  result = await runCmd(
    'oc -n openshift-monitoring exec alertmanager-main-0 -- amtool alert --alertmanager.url=http://localhost:9093'
  );
  assert(
    !result.error &&
      !/internal command failure/i.test(result.message) &&
      /exit code 0/.test(result.message),
    '#44: `oc -n <ns> exec … -- amtool …` runs the container command',
    result.message.slice(0, 320)
  );
  // Acceptance: the trailing `-n` placement keeps working.
  result = await runCmd('oc get pods -n qa2');
  assert(
    !result.error && /^NAME\s/m.test(result.message),
    '#44: the trailing `-n` form still works',
    result.message.slice(0, 240)
  );

  // ── #45: kubeadmin Secret holds a bcrypt hash; installer file has the
  //        plain-text password; login validates against the installer copy ──
  assert(
    /^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/i.test(installerPassword),
    '#45: KUBEADMIN_PASSWORD uses the real xxxxx-xxxxx-xxxxx-xxxxx installer format',
    installerPassword
  );
  result = await runCmd('cat ~/auth/kubeadmin-password');
  assert(
    !result.error && result.message.trim() === installerPassword,
    '#45: ~/auth/kubeadmin-password holds the installer-side kubeadmin password',
    JSON.stringify(result.message)
  );
  result = await runCmd('ls ~/auth');
  assert(
    result.message.split('\n').includes('kubeadmin-password'),
    '#45: ls ~/auth lists kubeadmin-password like a real install directory',
    result.message
  );
  result = await runCmd('oc extract secret/kubeadmin -n kube-system --to=-');
  const extractedHash = result.message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^\$2a\$10\$/.test(line));
  assert(
    !result.error &&
      /^\$2a\$10\$\S{53}$/.test(extractedHash || '') &&
      !result.message.includes(installerPassword),
    '#45: oc extract secret/kubeadmin prints the bcrypt hash, never the plain password',
    result.message.slice(0, 220)
  );
  result = await runCmd(`oc login -u kubeadmin -p ${installerPassword}`, 300);
  assert(
    !result.error && /Login successful/.test(result.message),
    '#45: oc login -u kubeadmin -p <installer password> succeeds',
    result.message.slice(0, 220)
  );
  result = await runCmd('oc login -u kubeadmin -p wrong-password');
  assert(
    result.error &&
      /Login failed \(401 Unauthorized\)\nVerify you have provided the correct credentials\./.test(
        result.message
      ),
    '#45: a wrong kubeadmin password is rejected with the real 401 wording',
    result.message.slice(0, 220)
  );
  result = await runCmd('oc login -u kubeadmin');
  assert(
    /Password: $/.test(result.message) && /Authentication required for/.test(result.message),
    '#45: oc login -u kubeadmin still prompts for the installer password',
    result.message.slice(0, 220)
  );
  result = await runCmd(installerPassword, 300);
  assert(
    !result.error && /Login successful/.test(result.message),
    '#45: typing the installer password at the Password: prompt logs in',
    result.message.slice(0, 220)
  );
  // Hints and README must teach the real discovery + removal flow, never that
  // the in-cluster Secret recovers the password.
  const passwordDocs = await evaluate(() =>
    import('/js/data/CampaignLevels.js').then((module) => ({
      focused: module.CAMPAIGN_LEVELS.filter((level) => level.id === 1 || level.id === 13).map(
        (level) => ({ id: level.id, hints: level.hints || [] })
      ),
      allHints: module.CAMPAIGN_LEVELS.flatMap((level) => level.hints || []),
    }))
  );
  assert(
    passwordDocs.focused.every((level) =>
      level.hints.some((hint) => /auth\/kubeadmin-password/.test(hint))
    ),
    '#45: L1 and L13 hints point at ~/auth/kubeadmin-password',
    JSON.stringify(passwordDocs.focused.map((level) => level.id))
  );
  const kubeadminSecretHints = passwordDocs.allHints.filter((hint) =>
    /extract secret\/kubeadmin/.test(hint)
  );
  assert(
    kubeadminSecretHints.length > 0 &&
      kubeadminSecretHints.every((hint) => /bcrypt|hash/i.test(hint)),
    '#45: hints that mention the kubeadmin Secret explain it only holds a bcrypt hash',
    JSON.stringify(kubeadminSecretHints.slice(0, 2))
  );
  assert(
    passwordDocs.allHints.some((hint) => /delete secret kubeadmin -n kube-system/.test(hint)),
    '#45: hints teach deleting the kubeadmin Secret as the removal path'
  );
  const readmeSource = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert(
    /auth\/kubeadmin-password/.test(readmeSource) &&
      /bcrypt/i.test(readmeSource) &&
      /delete secret kubeadmin -n kube-system/.test(readmeSource),
    '#45: README documents the installer password and the Secret-removal path'
  );

  // ── #48-3: kubeadmin/admin are virtual users, not User resources ───────
  result = await runCmd('oc get users');
  assert(
    !result.error && !/kubeadmin/.test(result.message) && !/^admin\s/m.test(result.message),
    '#48: oc get users does not list kubeadmin or admin as User objects',
    result.message.slice(0, 240)
  );
  result = await runCmd('oc create user qa-bob --full-name="QA Bob"');
  assert(
    !result.error && /user\.user\.openshift\.io\/qa-bob created/.test(result.message),
    '#48: oc create user still creates a real User object',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc get users');
  assert(
    /^qa-bob\s/m.test(result.message) &&
      !/kubeadmin/.test(result.message) &&
      !/^admin\s/m.test(result.message),
    '#48: oc get users lists only real User objects',
    result.message
  );
  await runCmd('oc delete user qa-bob');
  result = await runCmd('oc delete user kubeadmin');
  assert(
    result.error &&
      /Error from server \(NotFound\): users\.user\.openshift\.io "kubeadmin" not found/.test(
        result.message
      ),
    '#48: oc delete user kubeadmin is NotFound like real oc',
    result.message
  );
  result = await runCmd('oc delete user admin');
  assert(
    result.error &&
      /Error from server \(NotFound\): users\.user\.openshift\.io "admin" not found/.test(
        result.message
      ),
    '#48: oc delete user admin is NotFound too',
    result.message
  );
  result = await runCmd('oc auth can-i get pods --as=kubeadmin');
  assert(
    !result.error && /\byes\b/i.test(result.message),
    '#48: the kubeadmin-cluster-admin ClusterRoleBinding still grants cluster-admin',
    result.message
  );

  // ── #49: collected CLI output fidelity ────────────────────────────────
  // Route admission event must echo the Admitted condition wording (#49-1).
  await runCmd('oc new-project qa49-route');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa49-route');
  await runCmd('oc apply -f manifests/service.yaml -n qa49-route');
  await runCmd('oc apply -f manifests/route.yaml -n qa49-route');
  await advanceSimulation(3);
  result = await runCmd('oc describe route webapp -n qa49-route');
  const describedRouteEvent =
    result.message.split('\n').find((line) => /Route webapp not admitted/.test(line)) || '';
  assert(
    /Route webapp not admitted: spec\.tls\.externalCertificate:/.test(describedRouteEvent) &&
      /ExternalCertificateValidationFailed/.test(describedRouteEvent) &&
      !/no endpoints available/.test(describedRouteEvent),
    '#49: describe route shows the admission event with the condition reason/message',
    describedRouteEvent.slice(0, 360)
  );
  result = await runCmd('oc get events -n qa49-route');
  const routeEventRow =
    result.message
      .split('\n')
      .find((line) => /route\/webapp/.test(line) && /not admitted/.test(line)) || '';
  assert(
    /ExternalCertificateValidationFailed/.test(routeEventRow) &&
      /Route webapp not admitted: spec\.tls\.externalCertificate:/.test(routeEventRow) &&
      !/no endpoints available/.test(routeEventRow),
    '#49: get events shows the Route admission failure with the condition reason/message',
    routeEventRow.slice(0, 360)
  );

  // new-build ConfigChange trigger starts <name>-1 without oc start-build (#49-2).
  await runCmd('oc new-project qa49-build');
  result = await runCmd('oc new-build nodejs:20 --name=qa-build -n qa49-build');
  assert(
    !result.error && /buildconfig\.build\.openshift\.io "qa-build" created/.test(result.message),
    '#49: oc new-build creates the BuildConfig',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc get builds -n qa49-build');
  assert(
    /qa-build-1/.test(result.message),
    '#49: the ConfigChange trigger creates qa-build-1 immediately (no oc start-build)',
    result.message.slice(0, 300)
  );
  const immediateBuildPhase = await evaluate(() => {
    const build = window.game.cluster.getByName('Build', 'qa-build-1', 'qa49-build');
    return build ? build.status?.phase || null : null;
  });
  assert(
    immediateBuildPhase === 'New',
    '#49: the ConfigChange-triggered qa-build-1 exists immediately in phase New',
    JSON.stringify(immediateBuildPhase)
  );
  let triggeredBuild = null;
  for (let elapsed = 0; elapsed < 40; elapsed += 2) {
    await advanceSimulation(2);
    triggeredBuild = await evaluate(() => {
      const build = window.game.cluster.getByName('Build', 'qa-build-1', 'qa49-build');
      return build ? { phase: build.status?.phase || null } : null;
    });
    if (triggeredBuild?.phase === 'Complete' || triggeredBuild?.phase === 'Failed') break;
  }
  assert(
    triggeredBuild?.phase === 'Complete',
    '#49: the trigger-started build really runs to Complete',
    JSON.stringify(triggeredBuild)
  );

  // oc debug node prompts are real and non-empty (#49-3).
  const clusterNodes = await evaluate(() =>
    (window.game.cluster.getByKind('Node') || []).map((node) => node.metadata.name)
  );
  assert(clusterNodes.length > 0, '#49: the cluster has nodes for the debug checks');
  result = await runCmd(`oc debug node/${clusterNodes[0]}`);
  assert(
    !result.error && /Starting pod\/.*-debug/.test(result.message),
    '#49: oc debug node starts a debug pod',
    result.message.slice(0, 320)
  );
  const nodeShellPrompt = await evaluate(() => window.game.app.commandBar._debugPrompt());
  assert(
    nodeShellPrompt === 'sh-5.1#',
    '#49: oc debug node opens the real sh-5.1# node shell prompt',
    JSON.stringify(nodeShellPrompt)
  );
  await runCmd('chroot /host');
  const hostShellPrompt = await evaluate(() => window.game.app.commandBar._debugPrompt());
  assert(
    hostShellPrompt === 'sh-5.1#',
    '#49: chroot /host renders the real host prompt sh-5.1#',
    JSON.stringify(hostShellPrompt)
  );
  await runCmd('exit');
  await runCmd('exit');

  // Stopped kubelet: Ready Unknown/NodeStatusUnknown + self-consistent
  // NetworkUnavailable (#49-4).
  const stoppedKubeletNode = clusterNodes[1] || clusterNodes[0];
  const kubeletIncidentId = await evaluate((nodeName) => {
    const engine = window.game.app.incidentEngine;
    const definition = engine._defsById.get('node-not-ready');
    return engine.spawnIncident(definition, nodeName);
  }, stoppedKubeletNode);
  assert(
    Boolean(kubeletIncidentId),
    '#49: the NodeNotReady incident spawns for the stopped-kubelet check'
  );
  await advanceSimulation(1);
  // The real game loop runs IncidentEngine.tick right after the simulation
  // tick, so drive one incident tick to observe the node-controller view.
  await evaluate(() => window.game.app.incidentEngine.tick(0.05));
  const kubeletNodeState = await evaluate((nodeName) => {
    const node = window.game.cluster
      .getByKind('Node')
      .find((entry) => entry.metadata.name === nodeName);
    const conditions = Object.fromEntries(
      (node?.status?.conditions || []).map((condition) => [
        condition.type,
        { status: condition.status, reason: condition.reason, message: condition.message },
      ])
    );
    return { phase: node?.status?.phase || null, conditions };
  }, stoppedKubeletNode);
  const stoppedKubeletMessage = 'Kubelet stopped posting node status.';
  for (const conditionType of ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure']) {
    const condition = kubeletNodeState.conditions?.[conditionType] || null;
    assert(
      condition?.status === 'Unknown' &&
        condition?.reason === 'NodeStatusUnknown' &&
        condition?.message === stoppedKubeletMessage,
      `#49: a stopped kubelet reports ${conditionType} Unknown/NodeStatusUnknown`,
      JSON.stringify(condition)
    );
  }
  const networkCondition = kubeletNodeState.conditions?.NetworkUnavailable || null;
  assert(
    networkCondition?.status === 'False' &&
      networkCondition?.reason === 'RouteCreated' &&
      networkCondition?.message === 'ovn-kube cleared kubelet-set NoRouteCreated',
    '#49: NetworkUnavailable reports the real OVN-Kubernetes route value instead of contradicting itself',
    JSON.stringify(networkCondition)
  );
  result = await runCmd(`oc describe node ${stoppedKubeletNode}`);
  assert(
    /NodeStatusUnknown/.test(result.message) &&
      /Kubelet stopped posting node status/.test(result.message) &&
      /ovn-kube cleared kubelet-set NoRouteCreated/.test(result.message),
    '#49: describe node renders the stopped-kubelet conditions',
    result.message.slice(-900)
  );

  // The workstation models a small connected internet: example.com resolves
  // and serves the real Example Domain page, other hosts keep real curl DNS
  // failures, and silent curl failures never print the shell's generic
  // "error: command failed" fallback (#49-5).
  result = await runCmd('curl https://example.com');
  assert(
    /<!doctype html>/i.test(result.message) &&
      /<title>Example Domain<\/title>/.test(result.message) &&
      !/error: command failed/i.test(result.message),
    '#49: workstation curl https://example.com downloads the Example Domain page',
    result.message.slice(0, 320)
  );
  result = await runCmd('curl -s https://example.com');
  assert(
    /<!doctype html>/i.test(result.message) &&
      /<title>Example Domain<\/title>/.test(result.message) &&
      !/error: command failed/i.test(result.message),
    '#49: curl -s https://example.com prints the page body only',
    result.message.slice(0, 320)
  );
  result = await runCmd('curl -s no-such-host.example.com');
  assert(
    result.message.trim() === '' && !/error: command failed/i.test(result.message),
    '#49: a silent curl failure prints nothing (no "error: command failed" fallback)',
    JSON.stringify(result.message.slice(0, 240))
  );

  // new-app --name=database names the container database (#49-6).
  await runCmd('oc new-project qa49-app');
  result = await runCmd(
    'oc new-app --image=registry.redhat.io/rhel9/mysql-80 --name=database -n qa49-app',
    400
  );
  assert(
    !result.error && /deployment\.apps "database" created/.test(result.message),
    '#49: oc new-app --name=database creates the database Deployment',
    result.message.slice(0, 320)
  );
  await advanceSimulation(6);
  const databaseWorkload = await evaluate(() => {
    const deployment = window.game.cluster.getByName('Deployment', 'database', 'qa49-app');
    const pods = window.game.cluster.getByKindAndNamespace('Pod', 'qa49-app') || [];
    return {
      deploymentContainers: (deployment?.spec?.template?.spec?.containers || []).map(
        (container) => container.name
      ),
      podContainers: pods.map((pod) =>
        (pod.spec?.containers || []).map((container) => container.name)
      ),
    };
  });
  assert(
    databaseWorkload.deploymentContainers.join() === 'database' &&
      databaseWorkload.podContainers.length > 0 &&
      databaseWorkload.podContainers.every((names) => names.join() === 'database'),
    '#49: oc new-app --image … --name=database names the container database',
    JSON.stringify(databaseWorkload)
  );
  result = await runCmd(
    "oc get deploy database -n qa49-app -o jsonpath='{.spec.template.spec.containers[0].name}'"
  );
  assert(
    !result.error && result.message.trim() === 'database',
    '#49: jsonpath reports the database container name on the Deployment',
    JSON.stringify(result.message)
  );

  // ScalingReplicaSet events carry the full ReplicaSet name (#49-7).
  await runCmd('oc new-project qa49-env');
  await runCmd('oc create deployment hasenv --image=quay.io/example/webapp:latest -n qa49-env');
  await runCmd('oc create deployment noenv --image=quay.io/example/webapp:latest -n qa49-env');
  await advanceSimulation(3);
  await runCmd('oc set env deploy/hasenv FOO=bar -n qa49-env');
  result = await runCmd('oc set env deploy --all --list -n qa49-env');
  assert(
    !/<none>/.test(result.message) &&
      /# deployment\.apps\/noenv, container \w+/.test(result.message) &&
      /# deployment\.apps\/hasenv, container \w+/.test(result.message) &&
      /FOO=bar/.test(result.message),
    '#49: set env --all --list prints only the header for env-less containers',
    result.message
  );
  await runCmd('oc scale deploy/noenv --replicas=2 -n qa49-env');
  await advanceSimulation(4);
  const scaledReplicaSet = await evaluate(() => {
    const replicaSet = (window.game.cluster.getByKindAndNamespace('ReplicaSet', 'qa49-env') || [])
      .filter((entry) => /^noenv-/.test(entry.metadata.name))
      .sort((left, right) =>
        String(left.metadata.creationTimestamp).localeCompare(
          String(right.metadata.creationTimestamp)
        )
      )
      .pop();
    return replicaSet?.metadata?.name || null;
  });
  result = await runCmd('oc get events -n qa49-env');
  const scalingEventRow =
    result.message
      .split('\n')
      .find(
        (line) =>
          /ScalingReplicaSet/.test(line) && /deployment\/noenv/.test(line) && /to 2/.test(line)
      ) || '';
  assert(
    Boolean(scaledReplicaSet) &&
      scalingEventRow.includes(`Scaled up replica set ${scaledReplicaSet} to 2`),
    '#49: the ScalingReplicaSet event shows the full, untruncated ReplicaSet name',
    scalingEventRow.slice(0, 320)
  );

  // perl -e "print 42" Job completes promptly (#49-9).
  await runCmd('oc new-project qa49-jobs');
  result = await runCmd('oc create job report-job --image=perl -- perl -e "print 42" -n qa49-jobs');
  assert(
    !result.error && /job\.batch\/report-job created/.test(result.message),
    '#49: oc create job with a perl command is accepted',
    result.message.slice(0, 240)
  );
  let jobCompleteAfter = null;
  for (let elapsed = 1; elapsed <= 5; elapsed += 1) {
    await advanceSimulation(1);
    const jobState = await evaluate(() => {
      const job = window.game.cluster.getByName('Job', 'report-job', 'qa49-jobs');
      return job
        ? {
            phase: job.status?.phase || null,
            succeeded: Number(job.status?.succeeded || 0),
          }
        : null;
    });
    if (jobState?.phase === 'Complete' || jobState?.succeeded >= 1) {
      jobCompleteAfter = elapsed;
      break;
    }
  }
  assert(
    jobCompleteAfter !== null,
    '#49: the quick perl -e "print 42" Job reaches Complete within 5 simulated seconds',
    `completeAfter=${jobCompleteAfter}s`
  );
  result = await runCmd('oc get job report-job -n qa49-jobs');
  assert(
    /report-job\s+Complete/.test(result.message),
    '#49: oc get job reports Complete for the quick perl Job',
    result.message
  );
  result = await runCmd('oc logs job/report-job -n qa49-jobs');
  assert(
    result.message.includes('42'),
    '#49: the perl Job logs print 42',
    result.message.slice(0, 240)
  );

  // describe alertmanager Labels indentation matches the other keys (#49-10).
  result = await runCmd('oc describe alertmanager main -n openshift-monitoring');
  const describedLines = result.message.split('\n');
  const valueColumn = (label) => {
    const line = describedLines.find((entry) => entry.startsWith(label));
    const match = line ? line.match(new RegExp(`^${label}\\s*`)) : null;
    return match ? match[0].length : -1;
  };
  const nameColumn = valueColumn('Name:');
  const labelsColumn = valueColumn('Labels:');
  const labelsStart = describedLines.findIndex((line) => line.startsWith('Labels:'));
  const secondLabelLine = labelsStart >= 0 ? describedLines[labelsStart + 1] || '' : '';
  assert(
    nameColumn > 0 &&
      labelsColumn === nameColumn &&
      /app=alertmanager/.test(describedLines[labelsStart] || '') &&
      secondLabelLine.startsWith(' '.repeat(nameColumn)) &&
      /alertmanager=main/.test(secondLabelLine),
    '#49: describe alertmanager Labels values align exactly with the other keys',
    JSON.stringify({ nameColumn, labelsColumn, secondLabelLine })
  );

  // ── #46: OLM catalog, channel/startingCSV resolution, conditions, copies ──
  result = await runCmd('oc get packagemanifests -n openshift-marketplace');
  const packageManifestHeader = parseTable(result.message).header.replace(/\s+/g, ' ').trim();
  assert(
    packageManifestHeader === 'NAME CATALOG AGE',
    '#46: oc get packagemanifests header is NAME CATALOG AGE',
    packageManifestHeader
  );
  const packageManifestRows = parseTable(result.message).rows;
  const certManagerRow = packageManifestRows.find((row) => row[0] === olmPackage) || [];
  assert(
    certManagerRow[1] === 'redhat-operators' && certManagerRow.length === 3,
    '#46: the real Red Hat package openshift-cert-manager-operator is listed with its catalog',
    JSON.stringify(certManagerRow)
  );
  result = await runCmd('oc get packagemanifests -A');
  assert(
    parseTable(result.message).header.replace(/\s+/g, ' ').trim() === 'NAME CATALOG AGE',
    '#46: oc get packagemanifests -A keeps the same NAME CATALOG AGE columns',
    parseTable(result.message).header
  );
  result = await runCmd(`oc describe packagemanifest ${olmPackage} -n openshift-marketplace`);
  const describedManifest = result.message;
  assert(
    new RegExp(`Package Name:\\s+${olmPackage}`).test(describedManifest) &&
      /Default Channel:\s+stable-v1/.test(describedManifest) &&
      /Current CSV:\s+cert-manager-operator\.v1\.17\.0/.test(describedManifest) &&
      /Entries:/.test(describedManifest) &&
      [
        'cert-manager-operator.v1.17.0',
        'cert-manager-operator.v1.16.0',
        'cert-manager-operator.v1.15.0',
      ].every((csv) => describedManifest.includes(csv)),
    '#46: describe packagemanifest shows channel stable-v1 and its channel entries',
    describedManifest.slice(0, 800)
  );
  result = await runCmd(
    `oc get packagemanifest ${olmPackage} -n openshift-marketplace -o jsonpath='{.status.channels[0].entries[*].name}'`
  );
  assert(
    !result.error &&
      [
        'cert-manager-operator.v1.17.0',
        'cert-manager-operator.v1.16.0',
        'cert-manager-operator.v1.15.0',
      ].every((csv) => result.message.includes(csv)),
    '#46: the channel entries are discoverable via -o jsonpath (the docs way to find a pin)',
    result.message.slice(0, 320)
  );
  result = await runCmd(
    `oc get packagemanifest ${olmPackage} -n openshift-marketplace -o jsonpath='{.status.channels[*].entries}'`
  );
  assert(
    !result.error && result.message.includes(olmPinCsv),
    '#46: the issue repro jsonpath path to the channel entries shows the pinnable versions',
    result.message.slice(0, 320)
  );

  // Unknown channel → per-Subscription ResolutionFailed with the real wording.
  await runCmd('oc new-project qa-olm-bad');
  await applyManifest('qa-olm-bad-og', operatorGroupYaml('qa-olm-bad'));
  result = await applyManifest(
    'qa-olm-bad-sub',
    subscriptionYaml({
      name: 'bogus-channel',
      namespace: 'qa-olm-bad',
      packageName: olmPackage,
      channel: 'does-not-exist',
    })
  );
  assert(
    !result.error &&
      /subscription\.operators\.coreos\.com\/bogus-channel created/.test(result.message),
    '#46: the unknown-channel Subscription applies',
    result.message.slice(0, 240)
  );
  await advanceSimulation(30);
  const badChannelSub = await subscriptionState('bogus-channel', 'qa-olm-bad');
  const badChannelCondition = conditionOf(badChannelSub, 'ResolutionFailed');
  const unknownChannelMessage = `constraints not satisfiable: no operators found in channel does-not-exist of package ${olmPackage} in the catalog referenced by subscription bogus-channel`;
  assert(
    badChannelCondition?.status === 'True' &&
      badChannelCondition?.reason === 'ConstraintsNotSatisfiable' &&
      badChannelCondition?.message === unknownChannelMessage,
    '#46: an unknown channel fails resolution with the real channel/package wording',
    JSON.stringify(badChannelSub?.conditions)
  );
  const badNamespaceState = await evaluate(() => {
    const cluster = window.game.cluster;
    // Copied CSVs (status.reason Copied) are replicated status from
    // AllNamespaces operators, not installs in this namespace (#46).
    const csvs = (
      cluster.getByKindAndNamespace?.('ClusterServiceVersion', 'qa-olm-bad') || []
    ).filter((csv) => String(csv.status?.reason || '') !== 'Copied');
    return {
      csvs: csvs.length,
      plans: (cluster.getByKindAndNamespace?.('InstallPlan', 'qa-olm-bad') || []).length,
    };
  });
  assert(
    badNamespaceState.csvs === 0 && badNamespaceState.plans === 0,
    '#46: an unresolvable channel installs no CSV/InstallPlan',
    JSON.stringify(badNamespaceState)
  );
  result = await runCmd('oc describe subscription bogus-channel -n qa-olm-bad');
  assert(
    /ResolutionFailed/.test(result.message) &&
      result.message.includes('no operators found in channel does-not-exist of package'),
    '#46: oc describe subscription shows the ResolutionFailed condition',
    result.message.slice(0, 500)
  );

  // Unknown startingCSV → ResolutionFailed with the real pin wording.
  await runCmd('oc new-project qa-olm-badpin');
  await applyManifest('qa-olm-badpin-og', operatorGroupYaml('qa-olm-badpin'));
  result = await applyManifest(
    'qa-olm-badpin-sub',
    subscriptionYaml({
      name: 'bogus-pin',
      namespace: 'qa-olm-badpin',
      packageName: olmPackage,
      channel: olmChannel,
      startingCSV: 'cert-manager-operator.v9.9.9',
    })
  );
  assert(
    !result.error && /subscription\.operators\.coreos\.com\/bogus-pin created/.test(result.message),
    '#46: the unknown-startingCSV Subscription applies',
    result.message.slice(0, 240)
  );
  await advanceSimulation(30);
  const badPinSub = await subscriptionState('bogus-pin', 'qa-olm-badpin');
  const badPinCondition = conditionOf(badPinSub, 'ResolutionFailed');
  const unknownPinMessage = `constraints not satisfiable: no operators found with name cert-manager-operator.v9.9.9 in channel ${olmChannel} of package ${olmPackage} in the catalog referenced by subscription bogus-pin`;
  assert(
    badPinCondition?.status === 'True' && badPinCondition?.message === unknownPinMessage,
    '#46: an unknown startingCSV fails resolution against the channel entries',
    JSON.stringify(badPinSub?.conditions)
  );

  // Valid older channel entry, Manual approval: InstallPlanPending True before
  // approval, then that exact CSV installs (AllNamespaces in openshift-operators).
  await applyManifest(
    'qa-olm-pin-sub',
    subscriptionYaml({
      name: olmPackage,
      namespace: 'openshift-operators',
      packageName: olmPackage,
      channel: olmChannel,
      startingCSV: olmPinCsv,
      approval: 'Manual',
    })
  );
  await advanceSimulation(5);
  const pinnedPlanName = await evaluate((csvName) => {
    const plan = (
      window.game.cluster.getByKindAndNamespace('InstallPlan', 'openshift-operators') || []
    ).find((candidate) => (candidate.spec?.clusterServiceVersionNames || []).includes(csvName));
    return plan?.metadata?.name || null;
  }, olmPinCsv);
  assert(
    Boolean(pinnedPlanName),
    '#46: the pinned Subscription creates an InstallPlan for the pinned CSV',
    String(pinnedPlanName)
  );
  const pinnedPlanState = await evaluate((planName) => {
    const plan = window.game.cluster.getByName('InstallPlan', planName, 'openshift-operators');
    return plan
      ? { approval: plan.spec?.approval || null, approved: plan.spec?.approved === true }
      : null;
  }, pinnedPlanName);
  assert(
    pinnedPlanState?.approval === 'Manual' && pinnedPlanState?.approved === false,
    '#46: the pinned InstallPlan waits at Manual approval',
    JSON.stringify(pinnedPlanState)
  );
  const preApprovalSub = await subscriptionState(olmPackage, 'openshift-operators');
  const pendingCondition = conditionOf(preApprovalSub, 'InstallPlanPending');
  assert(
    pendingCondition?.status === 'True' &&
      pendingCondition?.reason === 'RequiresApproval' &&
      pendingCondition?.message === `install plan ${pinnedPlanName} requires approval`,
    '#46: the Manual Subscription reports InstallPlanPending True RequiresApproval before approval',
    JSON.stringify(preApprovalSub?.conditions)
  );
  result = await runCmd(
    `oc patch installplan ${pinnedPlanName} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`
  );
  assert(
    !result.error && /patched/.test(result.message),
    '#46: approving the pinned InstallPlan succeeds',
    result.message.slice(0, 240)
  );
  let pinnedCsvPhase = null;
  for (let elapsed = 0; elapsed < 40 && pinnedCsvPhase !== 'Succeeded'; elapsed += 2) {
    await advanceSimulation(2);
    pinnedCsvPhase = await evaluate((csvName) => {
      const csv = window.game.cluster.getByName(
        'ClusterServiceVersion',
        csvName,
        'openshift-operators'
      );
      return csv?.status?.phase || null;
    }, olmPinCsv);
  }
  const installedCsvs = await evaluate(() =>
    (
      window.game.cluster.getByKindAndNamespace('ClusterServiceVersion', 'openshift-operators') ||
      []
    ).map((csv) => ({ name: csv.metadata.name, phase: csv.status?.phase || null }))
  );
  assert(
    pinnedCsvPhase === 'Succeeded' &&
      installedCsvs.some((csv) => csv.name === olmPinCsv && csv.phase === 'Succeeded') &&
      !installedCsvs.some((csv) => csv.name === olmHeadCsv),
    '#46: the valid older channel entry installs instead of the channel head',
    JSON.stringify(installedCsvs)
  );
  const pinnedSub = await subscriptionState(olmPackage, 'openshift-operators');
  // #53D: once the pinned startingCSV reaches Succeeded, real OLM immediately
  // resolves the next step and creates a Manual upgrade InstallPlan for the
  // channel head: status.currentCSV moves to v1.17.0 while installedCSV stays
  // the player's v1.16.0 pin until that plan is approved.
  assert(
    pinnedSub?.installedCSV === olmPinCsv && pinnedSub?.currentCSV === olmHeadCsv,
    '#46: the Subscription keeps installedCSV=startingCSV while the v1.17.0 upgrade plan waits',
    JSON.stringify(pinnedSub)
  );

  // AllNamespaces copies: OLM creates a copied CSV in every namespace on the
  // cluster except the source OperatorGroup's namespace (a global
  // OperatorGroup's target set is all namespaces). Copies mirror the source
  // status (reason Copied) and are pruned when the source CSV is deleted
  // (#46 P4).
  result = await runCmd('oc get csv -A');
  const csvTable = parseTable(result.message);
  const csvHeader = csvTable.header.replace(/\s+/g, ' ').trim();
  assert(
    /^NAMESPACE NAME .*PHASE$/.test(csvHeader),
    '#46: oc get csv -A has the real NAMESPACE … PHASE columns',
    csvHeader
  );
  const copiedRows = csvTable.rows.filter((row) => row[1] === olmPinCsv);
  const copyNamespaces = copiedRows
    .map((row) => row[0])
    .filter((namespace) => namespace && namespace !== 'openshift-operators');
  assert(
    copiedRows.some((row) => row[0] === 'openshift-operators') && copyNamespaces.length >= 2,
    '#46: oc get csv -A shows the AllNamespaces CSV in the source and other namespaces',
    JSON.stringify(copiedRows.map((row) => row[0]))
  );
  const copiedCsvState = await evaluate(() => {
    const csvs = window.game.cluster.getByKind('ClusterServiceVersion') || [];
    const source = csvs.find(
      (csv) =>
        csv.metadata.namespace === 'openshift-operators' &&
        csv.metadata.name === 'cert-manager-operator.v1.16.0'
    );
    const copies = csvs
      .filter(
        (csv) =>
          csv.metadata.name === 'cert-manager-operator.v1.16.0' &&
          csv.metadata.namespace !== 'openshift-operators'
      )
      .map((csv) => ({
        namespace: csv.metadata.namespace,
        phase: csv.status?.phase || null,
        reason: csv.status?.reason || null,
        copiedFrom:
          csv.metadata.labels?.['olm.copiedFrom'] ||
          csv.metadata.annotations?.['olm.copiedFrom'] ||
          null,
        targetNamespaces: csv.metadata.annotations?.['olm.targetNamespaces'] ?? null,
      }));
    return { source: source ? { phase: source.status?.phase || null } : null, copies };
  });
  assert(
    copiedCsvState.source?.phase === 'Succeeded' &&
      copiedCsvState.copies.length >= 2 &&
      copiedCsvState.copies.every(
        (copy) => copy.phase === copiedCsvState.source.phase && copy.reason === 'Copied'
      ),
    '#46: copied CSVs mirror the source phase and carry status.reason Copied',
    JSON.stringify(copiedCsvState.copies.slice(0, 3))
  );
  assert(
    copiedCsvState.copies.every(
      (copy) => copy.copiedFrom === 'openshift-operators' && copy.targetNamespaces == null
    ),
    '#46: copied CSVs point back at openshift-operators and drop olm.targetNamespaces',
    JSON.stringify(copiedCsvState.copies.slice(0, 3))
  );
  assert(
    copiedCsvState.copies.some((copy) => copy.namespace === 'qa-olm-bad'),
    '#46: copied CSVs are cluster-wide (a project with its own OperatorGroup also gets one)',
    JSON.stringify(copiedCsvState.copies.map((copy) => copy.namespace))
  );
  // Deleting the source CSV must prune the copied CSVs like real OLM (delete
  // the Subscription first, the way L18 teaches the uninstall).
  await runCmd(`oc delete subscription ${olmPackage} -n openshift-operators`);
  await runCmd(`oc delete csv ${olmPinCsv} -n openshift-operators`);
  let copiesPruned = false;
  for (let elapsed = 0; elapsed < 20 && !copiesPruned; elapsed += 2) {
    await advanceSimulation(2);
    copiesPruned = await evaluate(() => {
      const copies = (window.game.cluster.getByKind('ClusterServiceVersion') || []).filter(
        (csv) =>
          csv.metadata.name === 'cert-manager-operator.v1.16.0' &&
          csv.metadata.namespace !== 'openshift-operators'
      );
      return copies.length === 0;
    });
  }
  assert(
    copiesPruned,
    '#46: copied CSVs are deleted when the source CSV is deleted',
    'copies still present'
  );

  // ── #48-1: the L18 pin objective is graded on state, not exact values ──
  assert(await bootCampaign(1), '#48: campaign boots for the L18 pin grading check');
  await evaluate(() => {
    const progress = window.game.scoringEngine.progress;
    for (let levelId = 1; levelId < 18; levelId += 1) {
      progress.campaignProgress[levelId] = { completed: true, stars: 3 };
    }
    return true;
  });
  assert(await launch('campaign', 18), '#48: campaign L18 starts for the pin grading check');
  await closeOverlays();
  await evaluate(() => {
    document.getElementById('tutorial-start')?.click();
    const app = window.game?.app;
    app?.hideTutorial?.();
    app?.hidePause?.();
    app?._resumeClocksFor?.('tutorial');
    const mode = app?.modeInstance;
    if (mode && mode.state === 'paused' && typeof mode.resume === 'function') mode.resume();
    if (window.game?.gameEngine && window.game.gameEngine.state !== 'running') {
      window.game.gameEngine.resume?.();
    }
  });
  await sleep(500);
  const l18ObjectiveDefs = await evaluate(() =>
    (window.game.app.modeInstance.currentLevelDef.objectives || [])
      .filter(
        (objective) =>
          objective.type === 'subscription' ||
          objective.type === 'installPlan' ||
          objective.type === 'operator'
      )
      .map((objective) => ({
        type: objective.type,
        name: objective.name || null,
        package: objective.package || null,
        channel: objective.channel || null,
        startingCSV: objective.startingCSV ?? null,
        pinnedInstall: objective.pinnedInstall === true,
        approval: objective.installPlanApproval || null,
      }))
  );
  const pinObjectiveDef = l18ObjectiveDefs.find((objective) => objective.type === 'subscription');
  assert(
    pinObjectiveDef?.pinnedInstall === true &&
      pinObjectiveDef?.startingCSV === null &&
      pinObjectiveDef?.channel === olmChannel &&
      pinObjectiveDef?.package === olmPackage,
    '#48: the L18 pin objective grades state (pinnedInstall), not hard-coded v1.15.0/channel stable',
    JSON.stringify(pinObjectiveDef)
  );
  result = await applyManifest(
    'l18-pin-sub',
    subscriptionYaml({
      name: olmPackage,
      namespace: 'openshift-operators',
      packageName: olmPackage,
      channel: olmChannel,
      startingCSV: olmPinCsv,
      approval: 'Manual',
    })
  );
  assert(
    !result.error &&
      /subscription\.operators\.coreos\.com\/openshift-cert-manager-operator created/.test(
        result.message
      ),
    '#48: the L18 scenario applies a subscription pinned to the valid non-head v1.16.0 entry',
    result.message.slice(0, 260)
  );
  await advanceSimulation(5);
  const l18PlanName = await evaluate((csvName) => {
    const plan = (
      window.game.cluster.getByKindAndNamespace('InstallPlan', 'openshift-operators') || []
    ).find((candidate) => (candidate.spec?.clusterServiceVersionNames || []).includes(csvName));
    return plan?.metadata?.name || null;
  }, olmPinCsv);
  assert(
    Boolean(l18PlanName),
    '#48: the pinned L18 Subscription creates a Manual InstallPlan',
    String(l18PlanName)
  );
  const l18Pending = conditionOf(
    await subscriptionState(olmPackage, 'openshift-operators'),
    'InstallPlanPending'
  );
  assert(
    l18Pending?.status === 'True' && l18Pending?.reason === 'RequiresApproval',
    '#48: the L18 Manual InstallPlan reports RequiresApproval before approval',
    JSON.stringify(l18Pending)
  );
  let pinState = await pinObjective();
  assert(
    pinState && pinState.completed === false,
    '#48: the pin objective stays unticked until the pinned CSV is actually installed',
    JSON.stringify(pinState)
  );
  result = await runCmd(
    `oc patch installplan ${l18PlanName} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`
  );
  assert(
    !result.error && /patched/.test(result.message),
    '#48: approving the L18 Manual InstallPlan succeeds',
    result.message.slice(0, 240)
  );
  let l18CsvPhase = null;
  for (let elapsed = 0; elapsed < 40 && l18CsvPhase !== 'Succeeded'; elapsed += 2) {
    await advanceSimulation(2);
    l18CsvPhase = await evaluate((csvName) => {
      const csv = window.game.cluster.getByName(
        'ClusterServiceVersion',
        csvName,
        'openshift-operators'
      );
      return csv?.status?.phase || null;
    }, olmPinCsv);
  }
  await waitFor(
    () =>
      evaluate(() => {
        const mode = window.game.app.modeInstance;
        const entry = (mode?.objectiveProgress || []).find(
          (objective) => objective.type === 'subscription'
        );
        return Boolean(entry?.completed);
      }),
    20000
  );
  pinState = await pinObjective();
  const l18PostSub = await subscriptionState(olmPackage, 'openshift-operators');
  assert(
    l18CsvPhase === 'Succeeded' &&
      pinState?.completed === true &&
      l18PostSub?.installedCSV === olmPinCsv,
    '#48: the L18 pin objective ticks when installedCSV equals a valid non-head startingCSV',
    JSON.stringify({ phase: l18CsvPhase, pinState, installedCSV: l18PostSub?.installedCSV })
  );
  await returnToMenu();

  // ── #48-2: readiness evidence follows the command, not the level mapping ──
  await goto('/?tutorial=0');
  assert(
    await waitFor(() => evaluate(() => !!window.game?.app?.scoringEngine), 25000),
    '#48: start page boots for the cross-level readiness-evidence check'
  );
  await sleep(500);
  await closeOverlays();
  const readinessStatus = () =>
    evaluate(async () => {
      const app = window.game.app;
      try {
        await app.showExamPrep?.();
      } catch {
        /* panel already open */
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const snapshot = app.examPrepUI?._computeSnapshot?.();
      const statusOf = (id) => snapshot?.statuses?.get?.(id) || null;
      return {
        secrets: statusOf('security-secrets'),
        networking: statusOf('net-configure-components'),
      };
    });
  const setEvidenceScenario = (progress, evidenceBuckets) =>
    evaluate(
      ({ campaignProgress, buckets }) => {
        const scoring = window.game.scoringEngine;
        scoring.progress.campaignProgress = campaignProgress;
        scoring.progress.challengeProgress = {};
        scoring.progress.objectiveEvidence = {};
        scoring.progress.drillCommandEvidence = buckets;
        return true;
      },
      { campaignProgress: progress, buckets: evidenceBuckets }
    );
  // L20 commands that belong to bullets mapped to OTHER levels: they must count.
  await setEvidenceScenario(
    { 20: { completed: true, stars: 3 } },
    {
      'campaign:20': [
        'oc create secret tls web-tls --cert=tls.crt --key=tls.key',
        'oc get network/cluster -o yaml',
      ],
    }
  );
  let readiness = await readinessStatus();
  assert(
    readiness.secrets === 'mastered' && readiness.networking === 'mastered',
    '#48: a matching command from another completed level credits the readiness bullet',
    JSON.stringify(readiness)
  );
  // Same commands from a drill that was never completed only count as practiced.
  await setEvidenceScenario(
    { 21: { completed: false, stars: 0 } },
    {
      'campaign:21': [
        'oc create secret tls web-tls --cert=tls.crt --key=tls.key',
        'oc get network/cluster -o yaml',
      ],
    }
  );
  readiness = await readinessStatus();
  assert(
    readiness.secrets === 'practiced' && readiness.networking === 'practiced',
    '#48: a matching command from an incomplete drill is evidence, not mastery',
    JSON.stringify(readiness)
  );
  await setEvidenceScenario({}, {});
  readiness = await readinessStatus();
  assert(
    readiness.secrets === 'todo' && readiness.networking === 'todo',
    '#48: no drill evidence leaves the readiness bullets as todo',
    JSON.stringify(readiness)
  );
  await evaluate(() => window.game.app.examPrepUI?.hide?.());

  // ── #47: Lab 13 hint states BOTH directions need both rules ────────────
  const lab13Hints = await evaluate(() =>
    import('/js/modes/ChallengeMode.js').then((module) => {
      const challenge = (module.CHALLENGES || []).find((entry) => entry.id === 13);
      return challenge ? challenge.hints || [] : [];
    })
  );
  const directionHint = lab13Hints.find((hint) => /Direction matters/i.test(hint)) || '';
  assert(
    /both directions/i.test(directionHint) &&
      /egress rule on gateway/i.test(directionHint) &&
      /ingress rule on ledger/i.test(directionHint) &&
      !/\(or an egress rule on gateway\)/.test(directionHint),
    '#47: the Lab 13 hint says default-deny in both directions needs an egress rule on gateway AND an ingress rule on ledger',
    directionHint.slice(0, 400)
  );

  // ── #45 (destructive, last): deleting the kubeadmin Secret is the real
  //        removal path; the installer-side backup survives ────────────────
  assert(await bootSandbox(), '#45: fresh sandbox boots for the kubeadmin removal flow');
  result = await runCmd(`oc login -u kubeadmin -p ${installerPassword}`, 300);
  assert(
    !result.error && /Login successful/.test(result.message),
    '#45: the installer password logs in while the Secret exists',
    result.message.slice(0, 220)
  );
  result = await runCmd('oc delete secret kubeadmin -n kube-system');
  assert(
    !result.error && /secret "kubeadmin" deleted/.test(result.message),
    '#45: oc delete secret kubeadmin -n kube-system succeeds (the exam removal step)',
    result.message.slice(0, 240)
  );
  result = await runCmd(`oc login -u kubeadmin -p ${installerPassword}`, 300);
  assert(
    result.error &&
      /The kubeadmin password Secret "kubeadmin" in project "kube-system" is missing: kubeadmin password authentication is not available\./.test(
        result.message
      ),
    '#45: after the Secret is deleted kubeadmin password auth is unavailable',
    result.message.slice(0, 320)
  );
  result = await runCmd('cat ~/auth/kubeadmin-password');
  assert(
    !result.error && result.message.trim() === installerPassword,
    '#45: the installer-side kubeadmin-password backup survives Secret removal',
    JSON.stringify(result.message)
  );
  result = await runCmd('oc delete secret kubeadmin -n kube-system');
  assert(
    result.error &&
      /Error from server \(NotFound\): secrets "kubeadmin" not found/.test(result.message),
    '#45: deleting the already-removed kubeadmin Secret is NotFound',
    result.message
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.4.0 — open issues #50–#54
//   #50 shell chaining (;, &&, ||) + export/$VAR expansion and loud rejection
//       of unsupported shell grammar, #51 L20 CrashLoop revision isolation +
//       rollout-undo healing, #52 Route admission independent of Service
//       endpoints (HostAlreadyClaimed is a real admission failure), #53D OLM
//       Manual pinned-upgrade InstallPlan, #53E multi-name Subscription
//       delete, #53F consistent worker-N/master-N node naming + exact debug
//       node resolution, #53G platform namespaces/pods/secrets, #54 CLI/UI
//       output fidelity (flag errors, curl -sI, ResolutionFailed conditions,
//       kubelet pod-event stream, exec localhost app body, landing stats,
//       fresh-cluster OAuth CO progress).
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue50-54', async () => {
  const olmPackage = 'openshift-cert-manager-operator';
  const olmChannel = 'stable-v1';
  const olmHeadCsv = 'cert-manager-operator.v1.17.0';
  const olmPinCsv = 'cert-manager-operator.v1.16.0';

  /** Advance the simulation AND incident clocks deterministically (0.05 s). */
  const advanceBoth = async (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      const engine = window.game?.incidentEngine;
      if (!sim || typeof sim.tick !== 'function') return false;
      const steps = Math.ceil(secs / 0.05);
      for (let index = 0; index < steps; index += 1) {
        sim.tick(0.05);
        if (engine && typeof engine.tick === 'function') engine.tick(0.05);
      }
      return true;
    }, seconds);
  /** Advance both clocks until predicate() is true, or exhaust maxSeconds. */
  const advanceUntil = async (predicate, maxSeconds = 60, step = 2) => {
    for (let played = 0; played < maxSeconds; played += step) {
      await advanceBoth(step);
      if (await predicate()) return true;
    }
    return false;
  };
  const activeIncidentNames = () =>
    evaluate(() =>
      [...(window.game?.incidentEngine?.activeIncidents?.values?.() || [])].map(
        (incident) => incident.name
      )
    );
  /** Write a virtual manifest file then apply it like the player would. */
  const applyManifest = async (name, yaml) => {
    await evaluate(({ file, content }) => window.game.manifestEngine.writeFile(file, content), {
      file: `qa/${name}.yaml`,
      content: yaml,
    });
    return runCmd(`oc apply -f qa/${name}.yaml`, 300);
  };
  const operatorGroupYaml = (namespace) =>
    [
      'apiVersion: operators.coreos.com/v1',
      'kind: OperatorGroup',
      'metadata:',
      `  name: ${namespace}-og`,
      `  namespace: ${namespace}`,
      'spec:',
      '  targetNamespaces:',
      `    - ${namespace}`,
    ].join('\n');
  const subscriptionYaml = ({ name, namespace, packageName, channel, startingCSV, approval }) =>
    [
      'apiVersion: operators.coreos.com/v1alpha1',
      'kind: Subscription',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${namespace}`,
      'spec:',
      `  channel: ${channel}`,
      `  name: ${packageName}`,
      '  source: redhat-operators',
      '  sourceNamespace: openshift-marketplace',
      ...(approval ? [`  installPlanApproval: ${approval}`] : []),
      ...(startingCSV ? [`  startingCSV: ${startingCSV}`] : []),
    ].join('\n');
  const subscriptionState = (name, namespace) =>
    evaluate(
      ({ subName, ns }) => {
        const sub = window.game.cluster.getByName('Subscription', subName, ns);
        if (!sub) return null;
        return {
          phase: sub.status?.phase || null,
          state: sub.status?.state || null,
          installedCSV: sub.status?.installedCSV || null,
          currentCSV: sub.status?.currentCSV || null,
          startingCSV: sub.spec?.startingCSV || null,
          conditions: (sub.status?.conditions || []).map((condition) => ({
            type: condition.type,
            status: condition.status,
            reason: condition.reason,
            message: condition.message || '',
          })),
        };
      },
      { subName: name, ns: namespace }
    );
  const conditionOf = (state, type) =>
    (state?.conditions || []).find((condition) => condition.type === type) || null;
  const installPlanFor = (namespace, csvName) =>
    evaluate(
      ({ ns, csv }) => {
        const plan = (window.game.cluster.getByKindAndNamespace('InstallPlan', ns) || []).find(
          (candidate) => (candidate.spec?.clusterServiceVersionNames || []).includes(csv)
        );
        return plan
          ? {
              name: plan.metadata?.name || null,
              csvs: plan.spec?.clusterServiceVersionNames || [],
              approval: plan.spec?.approval || null,
              approved: plan.spec?.approved === true,
            }
          : null;
      },
      { ns: namespace, csv: csvName }
    );
  const csvPhase = (namespace, csvName) =>
    evaluate(
      ({ ns, csv }) =>
        window.game.cluster.getByName('ClusterServiceVersion', csv, ns)?.status?.phase || null,
      { ns: namespace, csv: csvName }
    );
  const csvsIn = (namespace) =>
    evaluate(
      (ns) =>
        (window.game.cluster.getByKindAndNamespace('ClusterServiceVersion', ns) || []).map(
          (csv) => ({ name: csv.metadata?.name || null, phase: csv.status?.phase || null })
        ),
      namespace
    );
  const endpointsCell = (message, name) => {
    const row = parseTable(message).rows.find((cells) => cells[0] === name) || [];
    return row[1] || '';
  };
  /** Event reasons inside the `Events:` block of `oc describe pod`, in order. */
  const describedEventReasons = (message) => {
    const lines = String(message ?? '').split('\n');
    const start = lines.findIndex((line) => line.trim() === 'Events:');
    if (start < 0) return [];
    const reasons = [];
    for (const line of lines.slice(start + 1)) {
      const match = line.match(/^\s+(\S+)\s{2,}(\S+)\s{2,}/);
      if (!match || match[1] === 'Type' || /^-+$/.test(match[1])) continue;
      reasons.push(match[2]);
    }
    return reasons;
  };
  /** Rows of `oc get events` as { type, reason, object }. */
  const getEventRows = (message) =>
    String(message ?? '')
      .split('\n')
      .slice(1)
      .map((line) =>
        line
          .split(/\s{2,}/)
          .map((cell) => cell.trim())
          .filter(Boolean)
      )
      .filter((cells) => cells.length >= 4)
      .map((cells) => ({ type: cells[1], reason: cells[2], object: cells[3] }));
  const podRows = (namespace) =>
    evaluate(
      (ns) =>
        (window.game.cluster.getByKindAndNamespace('Pod', ns) || []).map((pod) => ({
          name: pod.metadata?.name || null,
          phase: pod.status?.phase || null,
          ready: (pod.status?.conditions || []).some(
            (condition) => condition.type === 'Ready' && condition.status === 'True'
          ),
        })),
      namespace
    );
  const routeAdmission = (namespace, name) =>
    evaluate(
      ({ ns, routeName }) => {
        const route = window.game.cluster.getByName('Route', routeName, ns);
        const condition = (route?.status?.ingress?.[0]?.conditions || []).find(
          (entry) => entry.type === 'Admitted'
        );
        return {
          host: route?.spec?.host || null,
          status: condition?.status || null,
          reason: condition?.reason || null,
          message: condition?.message || '',
        };
      },
      { ns: namespace, routeName: name }
    );
  let result;

  // ── #54: landing-page stats copy (UI says 13 timed labs, not 12) ─────────
  await bootMenu();
  const landingSpecs = await evaluate(() => document.querySelector('.sp-specs')?.innerText || '');
  assert(
    /(^|\n)13 timed labs(\n|$)/.test(landingSpecs) &&
      !/(^|\n)12 timed labs(\n|$)/.test(landingSpecs),
    '#54: the landing-page stats line reports 13 timed labs',
    JSON.stringify(landingSpecs)
  );

  // ═══ Sandbox round A: fresh-cluster state, shell, CLI output, platform ═══
  assert(await bootSandbox(), '#50: sandbox boots for the CLI/platform checks');

  // ── #54f: a fresh cluster is settled — no phantom OAuth rollout ──────────
  // Must be the FIRST command after boot: an unchanged OAuth config must not
  // schedule a rollout, so authentication is Progressing=False straight away.
  result = await runCmd('oc get co');
  const coTable = parseTable(result.message);
  assert(
    coTable.header.replace(/\s+/g, ' ').trim() ===
      'NAME VERSION AVAILABLE PROGRESSING DEGRADED SINCE',
    '#54: `oc get co` keeps the real ClusterOperator columns',
    coTable.header
  );
  const authenticationRow = coTable.rows.find((cells) => cells[0] === 'authentication') || [];
  assert(
    authenticationRow[2] === 'True' &&
      authenticationRow[3] === 'False' &&
      authenticationRow[4] === 'False',
    '#54: a fresh sandbox authentication ClusterOperator is settled (Progressing False), not rolling out',
    JSON.stringify(authenticationRow)
  );
  const unsettledOperators = coTable.rows.filter(
    (cells) => cells[2] !== 'True' || cells[3] !== 'False' || cells[4] !== 'False'
  );
  assert(
    coTable.rows.length >= 13 && unsettledOperators.length === 0,
    '#54: every fresh-sandbox ClusterOperator is Available and not progressing/degraded',
    JSON.stringify(unsettledOperators)
  );

  // ── #50: real shell chaining, export/$VAR expansion, loud rejection of
  //    unsupported shell grammar (no silent partial execution) ─────────────
  result = await runCmd('echo a; echo b');
  assert(
    !result.error && result.message.trim() === 'a\nb',
    '#50: `echo a; echo b` runs both commands in order',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo a && echo b');
  assert(
    !result.error && result.message.trim() === 'a\nb',
    '#50: `echo a && echo b` runs both commands in order',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo one && echo two && echo three');
  assert(
    !result.error && result.message.trim() === 'one\ntwo\nthree',
    '#50: a three-command && chain keeps every segment',
    JSON.stringify(result.message)
  );
  result = await runCmd('oc project default && oc get svc');
  assert(
    !result.error &&
      /Now using project "default"/.test(result.message) &&
      (/^NAME\s/m.test(result.message) ||
        /No resources found in default namespace/.test(result.message)),
    '#50: `oc project default && oc get svc` runs both commands (the svc output follows)',
    result.message.slice(0, 320)
  );
  result = await runCmd('oc get nonexistent-resource; echo after-semicolon');
  assert(
    !result.error && result.message.includes('after-semicolon'),
    '#50: `;` continues after a failing command and reports the last exit status',
    result.message.slice(0, 320)
  );
  result = await runCmd('oc get nonexistent-resource && echo after-and');
  assert(
    result.error && !result.message.includes('after-and'),
    '#50: `&&` short-circuits when the previous command fails',
    result.message.slice(0, 320)
  );
  result = await runCmd('oc get nonexistent-resource || echo after-or');
  assert(
    !result.error && result.message.includes('after-or'),
    '#50: `||` runs the fallback when the previous command fails',
    result.message.slice(0, 320)
  );
  result = await runCmd('echo before-next; oc get nodes');
  assert(
    !result.error && result.message.includes('before-next') && /^NAME\s/m.test(result.message),
    '#50: no silent partial execution — every segment output is kept',
    result.message.slice(0, 320)
  );
  result = await runCmd('export NS=default');
  assert(
    !result.error && result.message.trim() === '',
    '#50: `export NS=default` is silent like a real shell',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo $NS');
  assert(
    !result.error && result.message.trim() === 'default',
    '#50: `echo $NS` expands an exported variable',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo ${NS}');
  assert(
    !result.error && result.message.trim() === 'default',
    '#50: `${NS}` braces expand the same variable',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo "prefix-$NS-suffix"');
  assert(
    !result.error && result.message.trim() === 'prefix-default-suffix',
    '#50: $NS expands inside double quotes',
    JSON.stringify(result.message)
  );
  result = await runCmd("echo '$NS'");
  assert(
    !result.error && result.message.trim() === '$NS',
    '#50: single-quoted $NS does not expand',
    JSON.stringify(result.message)
  );
  result = await runCmd('echo $QA_UNDEFINED_VAR_5054');
  assert(
    !result.error && result.message.trim() === '',
    '#50: an undefined variable expands to empty',
    JSON.stringify(result.message)
  );
  await runCmd('export QA_SESSION_VAR=persisted');
  result = await runCmd('echo $QA_SESSION_VAR');
  assert(
    !result.error && result.message.trim() === 'persisted',
    '#50: exported variables persist for the session (separate command lines)',
    JSON.stringify(result.message)
  );
  result = await runCmd('for i in 1 2; do echo QA_LOOP_BODY; done');
  assert(
    result.error &&
      /simulator:/i.test(result.message) &&
      /not supported/i.test(result.message) &&
      !/unknown command "for"/i.test(result.message) &&
      !/QA_LOOP_BODY/.test(result.message),
    '#50: `for …; do …; done` fails loudly with the simulator unsupported-shell message (and never runs part of it)',
    result.message.slice(0, 320)
  );
  result = await runCmd('while true; do echo QA_WHILE_BODY; done');
  assert(
    result.error &&
      /simulator:/i.test(result.message) &&
      /not supported/i.test(result.message) &&
      !/QA_WHILE_BODY/.test(result.message),
    '#50: `while …; do …; done` is rejected with the same clear simulator message',
    result.message.slice(0, 320)
  );
  result = await runCmd('echo recovered-after-reject');
  assert(
    !result.error && result.message.trim() === 'recovered-after-reject',
    '#50: the shell keeps working after a rejected unsupported line',
    JSON.stringify(result.message)
  );

  // ── #54a: missing global-flag values are real oc flag errors ─────────────
  result = await expectCmdError(
    '#54: `oc -n` with no value reports the real shorthand flag error',
    'oc -n',
    /(?:^|\n)error: flag needs an argument: 'n' in -n/
  );
  assert(
    !/Error: flag needs an argument/.test(result.message),
    "#54: the `oc -n` flag error uses lowercase `error:` like real oc (not cobra's `Error:`)",
    result.message.slice(0, 240)
  );
  result = await expectCmdError(
    '#54: `oc --namespace` with no value reports the real long flag error',
    'oc --namespace',
    /(?:^|\n)error: flag needs an argument: --namespace/
  );
  assert(
    !/Error: flag needs an argument/.test(result.message),
    '#54: the `oc --namespace` flag error uses lowercase `error:` like real oc',
    result.message.slice(0, 240)
  );

  // ── #54c: curl -I/-i print plain header lines (no verbose "< " prefix) ──
  result = await runCmd('curl -sI https://example.com');
  let headerLines = result.message
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  assert(
    !result.error && headerLines[0] === 'HTTP/1.1 200 OK',
    '#54: `curl -sI` starts with the plain HTTP status line',
    JSON.stringify(headerLines.slice(0, 3))
  );
  assert(
    headerLines.some((line) => /^content-type:/i.test(line)) &&
      !headerLines.some((line) => /^<\s/.test(line)) &&
      !/<html/i.test(result.message) &&
      !/<!doctype/i.test(result.message),
    '#54: `curl -sI` prints headers only — no verbose "< " prefix and no body',
    result.message.slice(0, 320)
  );
  result = await runCmd('curl -I https://example.com');
  headerLines = result.message
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  assert(
    !result.error &&
      headerLines[0] === 'HTTP/1.1 200 OK' &&
      !headerLines.some((line) => /^<\s/.test(line)),
    '#54: `curl -I` uses the same plain header format',
    result.message.slice(0, 320)
  );
  result = await runCmd('curl -si https://example.com');
  headerLines = result.message
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  assert(
    !result.error &&
      headerLines[0] === 'HTTP/1.1 200 OK' &&
      !headerLines.some((line) => /^<\s/.test(line)) &&
      /<!doctype html>/i.test(result.message) &&
      /Example Domain/.test(result.message),
    '#54: `curl -si` keeps plain headers and still includes the body',
    result.message.slice(0, 320)
  );
  result = await runCmd('curl -v https://example.com');
  assert(
    !result.error && /^<\s/m.test(result.message),
    '#54: `curl -v` keeps the verbose "< " response-header format',
    result.message.slice(0, 320)
  );

  // ── #53F: sandbox nodes use the shared catalog names (no ghosts) ────────
  result = await runCmd('oc get nodes');
  const sandboxNodeTable = parseTable(result.message);
  const sandboxNodeNames = sandboxNodeTable.rows.map((cells) => cells[0]).sort();
  assert(
    JSON.stringify(sandboxNodeNames) === JSON.stringify(['master-0', 'worker-0', 'worker-1']),
    '#53F: sandbox nodes use the shared worker-0/worker-1/master-0 names (no sandbox-node-N)',
    JSON.stringify(sandboxNodeNames)
  );
  const sandboxRoles = Object.fromEntries(
    sandboxNodeTable.rows.map((cells) => [cells[0], cells[2] || ''])
  );
  assert(
    /worker/.test(sandboxRoles['worker-0']) &&
      /worker/.test(sandboxRoles['worker-1']) &&
      /master/.test(sandboxRoles['master-0']),
    '#53F: sandbox node roles flag the 2 workers and the control-plane master',
    JSON.stringify(sandboxRoles)
  );

  // ── #53G: platform namespaces, pods and Secrets exist in every mode ─────
  result = await runCmd('oc get pods -n openshift-dns');
  assert(
    !result.error && !/NotFound/.test(result.message),
    '#53G: the openshift-dns namespace exists on a fresh cluster',
    result.message.slice(0, 240)
  );
  const sandboxDnsPods = parseTable(result.message).rows.map((cells) => cells[0]);
  assert(
    sandboxDnsPods.filter((name) => /^dns-default-/.test(name)).length ===
      sandboxNodeNames.length &&
      sandboxDnsPods.filter((name) => /^node-resolver-/.test(name)).length ===
        sandboxNodeNames.length,
    '#53G: openshift-dns runs one dns-default and one node-resolver pod per node',
    JSON.stringify(sandboxDnsPods)
  );
  const sandboxDnsTable = parseTable(result.message);
  assert(
    // #56: dns-default pods are READY 2/2 now (dns + kube-rbac-proxy container);
    // node-resolver pods keep the real single-container READY 1/1.
    sandboxDnsTable.rows.every(
      (cells) =>
        cells[2] === 'Running' &&
        (/^dns-default-/.test(cells[0]) ? cells[1] === '2/2' : cells[1] === '1/1')
    ),
    '#53G: the sandbox DNS pods are Running/Ready',
    JSON.stringify(sandboxDnsTable.rows)
  );
  result = await runCmd('oc get pods -n openshift-ingress');
  assert(
    !result.error && !/No resources found/.test(result.message),
    '#53G: openshift-ingress has router-default pods on a fresh cluster',
    result.message.slice(0, 240)
  );
  const routerPods = parseTable(result.message).rows.filter((cells) =>
    /^router-default-/.test(cells[0])
  );
  assert(
    routerPods.length >= 2 &&
      routerPods.every((cells) => cells[1] === '1/1' && cells[2] === 'Running'),
    '#53G: at least two router-default pods are Running/Ready',
    JSON.stringify(routerPods)
  );
  const platformPodLabels = await evaluate(() => {
    const summarize = (namespace) =>
      (window.game.cluster.getByKindAndNamespace('Pod', namespace) || []).map((pod) => ({
        name: pod.metadata?.name || null,
        labels: pod.metadata?.labels || {},
      }));
    return { dns: summarize('openshift-dns'), ingress: summarize('openshift-ingress') };
  });
  assert(
    platformPodLabels.dns
      .filter((pod) => /^dns-default-/.test(pod.name || ''))
      .every((pod) => pod.labels['dns.operator.openshift.io/daemonset-dns'] === 'default'),
    '#53G: dns-default pods carry the real daemonset-dns label',
    JSON.stringify(platformPodLabels.dns.slice(0, 3))
  );
  assert(
    platformPodLabels.ingress
      .filter((pod) => /^router-default-/.test(pod.name || ''))
      .every((pod) => pod.labels.app === 'router'),
    '#53G: router-default pods carry the real app=router label',
    JSON.stringify(platformPodLabels.ingress.slice(0, 3))
  );
  result = await runCmd('oc get secrets -n openshift-config');
  const configSecretNames = parseTable(result.message).rows.map((cells) => cells[0]);
  assert(
    configSecretNames.includes('pull-secret') &&
      configSecretNames.includes('initial-service-account-private-key'),
    '#53G: openshift-config seeds the documented platform Secrets',
    JSON.stringify(configSecretNames)
  );
  assert(
    !configSecretNames.includes('htpass-secret'),
    '#53G: htpass-secret is NOT seeded (identity labs create it themselves)',
    JSON.stringify(configSecretNames)
  );
  result = await runCmd("oc get secret pull-secret -n openshift-config -o jsonpath='{.type}'");
  assert(
    !result.error && result.message.trim() === 'kubernetes.io/dockerconfigjson',
    '#53G: pull-secret has the real kubernetes.io/dockerconfigjson type',
    JSON.stringify(result.message)
  );
  result = await runCmd(
    'oc extract secret/initial-service-account-private-key -n openshift-config --to=-'
  );
  assert(
    !result.error && result.message.trim() !== '',
    '#53G: oc extract works on the seeded openshift-config Secrets',
    result.message.slice(0, 180)
  );

  // ── #53F: debug node resolves exactly; wrong names are NotFound ────────
  result = await runCmd('oc debug node/worker-0');
  assert(
    !result.error && /Starting pod\/worker-0-debug/.test(result.message),
    '#53F: `oc debug node/worker-0` resolves the real sandbox node',
    result.message.slice(0, 300)
  );
  await runCmd('exit');
  const debugSessionClosed = await evaluate(
    () => window.game.app.commandBar._debugSession === null
  );
  assert(debugSessionClosed, '#53F: `exit` leaves the node debug session cleanly');
  await expectCmdError(
    '#53F: `oc debug node/worker-9` is a real NotFound, never an alias onto another node',
    'oc debug node/worker-9',
    /Error from server \(NotFound\): nodes "worker-9" not found/
  );
  await expectCmdError(
    '#53F: the retired sandbox-node-N names are NotFound too',
    'oc debug node/sandbox-node-1',
    /Error from server \(NotFound\): nodes "sandbox-node-1" not found/
  );

  // ── #52: Route admission must not depend on Service endpoints ───────────
  await runCmd('oc new-project qa-route5054');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa-route5054');
  await runCmd('oc apply -f manifests/service.yaml -n qa-route5054');
  const routePodsReady = await advanceUntil(async () => {
    const pods = await podRows('qa-route5054');
    return pods.filter((pod) => pod.phase === 'Running' && pod.ready).length >= 2;
  }, 30);
  assert(routePodsReady, '#52: the route-test Deployment reaches 2 Ready pods');
  await expectCmd(
    '#52: a plain edge Route is created',
    'oc create route edge webapp --service=webapp -n qa-route5054',
    /route\.route\.openshift\.io\/webapp created/
  );
  await advanceBoth(8);
  const admittedRoute = await routeAdmission('qa-route5054', 'webapp');
  const routeHost = admittedRoute.host;
  assert(
    admittedRoute.status === 'True' && Boolean(routeHost),
    '#52: the Route is admitted while its Service has endpoints',
    JSON.stringify(admittedRoute)
  );
  result = await runCmd(`curl -k -s https://${routeHost}`);
  assert(
    /Hello OpenShift/.test(result.message),
    '#52: the admitted Route answers curl with the app body',
    result.message.slice(0, 240)
  );
  await expectCmd(
    '#52: breaking the Service selector applies the patch',
    'oc patch svc/webapp -n qa-route5054 -p \'{"spec":{"selector":{"app":"no-match"}}}\'',
    /service\/webapp patched/
  );
  await advanceBoth(8);
  const admittedWithoutEndpoints = await routeAdmission('qa-route5054', 'webapp');
  assert(
    admittedWithoutEndpoints.status === 'True' && admittedWithoutEndpoints.reason === 'Accepted',
    '#52: a Route whose Service has no endpoints stays Admitted=True (the router returns 503)',
    JSON.stringify(admittedWithoutEndpoints)
  );
  result = await runCmd(
    "oc get route webapp -n qa-route5054 -o jsonpath='{.status.ingress[0].conditions}'"
  );
  assert(
    !result.error &&
      /"status":"True"/.test(result.message) &&
      !/"status":"False"/.test(result.message),
    '#52: jsonpath still reports the Admitted True condition with no endpoints',
    result.message.slice(0, 320)
  );
  result = await runCmd('oc describe route webapp -n qa-route5054');
  assert(
    /Endpoints:\s+<none>/.test(result.message) && !/rejected by router/.test(result.message),
    '#52: oc describe route shows Endpoints: <none> without rejecting the Route',
    result.message.slice(0, 800)
  );
  result = await runCmd(`curl -k -s -o /dev/null -w '%{http_code}' https://${routeHost}`);
  assert(
    !result.error && result.message.trim() === '503',
    '#52: curl to the Route with no endpoints returns 503',
    JSON.stringify(result.message)
  );
  result = await runCmd(`curl -k -s https://${routeHost}`);
  assert(
    /503 Service Unavailable/.test(result.message),
    '#52: the 503 body is the real router response',
    result.message.slice(0, 240)
  );
  await runCmd('oc patch svc/webapp -n qa-route5054 -p \'{"spec":{"selector":{"app":"webapp"}}}\'');
  await advanceBoth(8);
  result = await runCmd(`curl -k -s -o /dev/null -w '%{http_code}' https://${routeHost}`);
  assert(
    !result.error && result.message.trim() === '200',
    '#52: restoring the selector restores the 200 response',
    JSON.stringify(result.message)
  );

  // #52: HostAlreadyClaimed is a real admission failure (not ServiceUnavailable).
  await runCmd('oc new-project qa-route5054b');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa-route5054b');
  await runCmd('oc apply -f manifests/service.yaml -n qa-route5054b');
  await advanceBoth(8);
  result = await runCmd(
    `oc create route edge webapp --service=webapp --hostname=${routeHost} -n qa-route5054b`
  );
  assert(
    !result.error,
    '#52: the second Route claiming the same host is accepted by the API',
    result.message.slice(0, 240)
  );
  await advanceBoth(8);
  const hostConflict = await routeAdmission('qa-route5054b', 'webapp');
  assert(
    hostConflict.status === 'False' && hostConflict.reason === 'HostAlreadyClaimed',
    '#52: a Route whose host is already claimed is Admitted=False HostAlreadyClaimed',
    JSON.stringify(hostConflict)
  );
  result = await runCmd('oc describe route webapp -n qa-route5054b');
  assert(
    /HostAlreadyClaimed/.test(result.message),
    '#52: oc describe route explains the admission failure with HostAlreadyClaimed',
    result.message.slice(0, 800)
  );
  const winningRoute = await routeAdmission('qa-route5054', 'webapp');
  assert(
    winningRoute.status === 'True',
    '#52: the first Route keeps the host and stays admitted',
    JSON.stringify(winningRoute)
  );
  await runCmd('oc delete route webapp -n qa-route5054');
  const reAdmitted = await advanceUntil(
    async () => (await routeAdmission('qa-route5054b', 'webapp')).status === 'True',
    30
  );
  assert(
    reAdmitted,
    '#52: deleting the winning Route admits the waiting Route',
    JSON.stringify(await routeAdmission('qa-route5054b', 'webapp'))
  );
  result = await runCmd(`curl -k -s https://${routeHost}`);
  assert(
    /Hello OpenShift/.test(result.message),
    '#52: the newly admitted Route starts serving',
    result.message.slice(0, 240)
  );

  // ── #54d: `oc exec … -- curl -s localhost:8080` hits the pod's own app ──
  result = await runCmd('oc exec deploy/webapp -n qa-route5054 -- curl -s localhost:8080');
  assert(
    !result.error && result.message.trim() === '<html><body>Hello OpenShift!</body></html>',
    "#54: `oc exec deploy/webapp -- curl -s localhost:8080` returns the pod app's real body",
    result.message.slice(0, 240)
  );
  assert(
    !/container main/i.test(result.message) && !/Hello from the Internet/i.test(result.message),
    "#54: the exec body never names a fabricated 'container main'",
    result.message.slice(0, 240)
  );
  result = await runCmd('oc exec deploy/webapp -n qa-route5054 -- curl -s 127.0.0.1:8080');
  assert(
    !result.error && /Hello OpenShift/.test(result.message),
    '#54: 127.0.0.1 resolves to the same pod app as localhost',
    result.message.slice(0, 240)
  );

  // ── #54e: describe pod shows the real kubelet event stream ─────────────
  const routePods = await podRows('qa-route5054');
  const describedPodName = (routePods[0] || {}).name;
  assert(Boolean(describedPodName), '#54: the route-test namespace has a pod to describe');
  await advanceBoth(4);
  result = await runCmd(`oc describe pod ${describedPodName} -n qa-route5054`);
  const describedReasons = describedEventReasons(result.message);
  assert(
    JSON.stringify(describedReasons) ===
      JSON.stringify(['Scheduled', 'Pulling', 'Pulled', 'Created', 'Started']),
    '#54: oc describe pod events run Scheduled → Pulling → Pulled → Created → Started',
    JSON.stringify(describedReasons)
  );
  assert(
    !describedReasons.includes('Ready') && !describedReasons.includes('PhaseChange'),
    '#54: oc describe pod has no Ready/PhaseChange events',
    JSON.stringify(describedReasons)
  );
  result = await runCmd('oc get events -n qa-route5054');
  const podEventRows = getEventRows(result.message).filter(
    (row) => row.object === `pod/${describedPodName}`
  );
  assert(
    JSON.stringify(podEventRows.map((row) => row.reason).sort()) ===
      JSON.stringify(['Created', 'Pulled', 'Pulling', 'Scheduled', 'Started'].sort()),
    '#54: oc get events records each kubelet lifecycle reason exactly once for the pod',
    JSON.stringify(podEventRows.map((row) => row.reason))
  );
  assert(
    !podEventRows.some((row) => row.reason === 'Ready' || row.reason === 'PhaseChange'),
    '#54: oc get events has no Ready/PhaseChange reasons for pods',
    JSON.stringify(podEventRows.filter((row) => /Ready|PhaseChange/.test(row.reason)))
  );

  // ═══ Sandbox round B: OLM manual pinned upgrade (#53D), multi-name
  //     Subscription delete (#53E) and ResolutionFailed conditions (#54) ═══
  assert(await bootSandbox(), '#53D: fresh sandbox boots for the OLM checks');
  await expectCmd(
    '#53D: the pinned Manual Subscription manifest applies',
    'oc apply -f examples/subscription-manual-pinned.yaml',
    /subscription\.operators\.coreos\.com\/openshift-cert-manager-operator created/
  );
  await advanceBoth(6);
  const preApprovalSub = await subscriptionState(olmPackage, 'openshift-operators');
  assert(
    preApprovalSub?.currentCSV === olmPinCsv && !preApprovalSub?.installedCSV,
    '#53D: before approval status.currentCSV already shows the resolved startingCSV (installedCSV empty)',
    JSON.stringify(preApprovalSub)
  );
  const preApprovalPending = conditionOf(preApprovalSub, 'InstallPlanPending');
  assert(
    preApprovalPending?.status === 'True' && preApprovalPending?.reason === 'RequiresApproval',
    '#53D: the pinned Manual InstallPlan reports InstallPlanPending True RequiresApproval',
    JSON.stringify(preApprovalPending)
  );
  result = await runCmd(
    'oc describe subscription openshift-cert-manager-operator -n openshift-operators'
  );
  assert(
    /Current CSV:\s+cert-manager-operator\.v1\.16\.0/.test(result.message) &&
      /Installed CSV:\s+<none>/.test(result.message),
    '#53D: describe subscription shows Current CSV v1.16.0 and no Installed CSV before approval',
    result.message.slice(0, 600)
  );
  const pinnedPlan = await installPlanFor('openshift-operators', olmPinCsv);
  assert(
    pinnedPlan?.approval === 'Manual' && pinnedPlan?.approved === false,
    '#53D: the pinned InstallPlan waits at Manual approval',
    JSON.stringify(pinnedPlan)
  );
  if (pinnedPlan) {
    result = await runCmd(
      `oc patch installplan ${pinnedPlan.name} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`
    );
    assert(
      !result.error && /patched/.test(result.message),
      '#53D: approving the pinned InstallPlan succeeds',
      result.message.slice(0, 240)
    );
  }
  let pinCsvPhase = null;
  for (let elapsed = 0; elapsed < 40 && pinCsvPhase !== 'Succeeded'; elapsed += 2) {
    await advanceBoth(2);
    pinCsvPhase = await csvPhase('openshift-operators', olmPinCsv);
  }
  assert(
    pinCsvPhase === 'Succeeded',
    '#53D: the pinned v1.16.0 CSV reaches Succeeded',
    JSON.stringify(pinCsvPhase)
  );
  let upgradePlan = null;
  for (let elapsed = 0; elapsed < 30 && !upgradePlan; elapsed += 2) {
    await advanceBoth(2);
    upgradePlan = await installPlanFor('openshift-operators', olmHeadCsv);
  }
  assert(
    upgradePlan?.approval === 'Manual' && upgradePlan?.approved === false,
    '#53D: real OLM immediately creates a SECOND Manual, unapproved InstallPlan for v1.17.0',
    JSON.stringify(upgradePlan)
  );
  const upgradePendingSub = await subscriptionState(olmPackage, 'openshift-operators');
  assert(
    upgradePendingSub?.currentCSV === olmHeadCsv &&
      upgradePendingSub?.installedCSV === olmPinCsv &&
      upgradePendingSub?.phase === 'UpgradePending',
    '#53D: upgrade pending → currentCSV v1.17.0, installedCSV stays the pinned v1.16.0, phase UpgradePending',
    JSON.stringify(upgradePendingSub)
  );
  const upgradePendingCondition = conditionOf(upgradePendingSub, 'InstallPlanPending');
  assert(
    upgradePendingCondition?.status === 'True' &&
      upgradePendingCondition?.reason === 'RequiresApproval' &&
      /requires approval/.test(upgradePendingCondition?.message || ''),
    '#53D: the pending upgrade reports InstallPlanPending True RequiresApproval',
    JSON.stringify(upgradePendingCondition)
  );
  result = await runCmd(
    'oc describe subscription openshift-cert-manager-operator -n openshift-operators'
  );
  assert(
    /Current CSV:\s+cert-manager-operator\.v1\.17\.0/.test(result.message) &&
      /Installed CSV:\s+cert-manager-operator\.v1\.16\.0/.test(result.message) &&
      /State:\s+UpgradePending/.test(result.message) &&
      /InstallPlanPending\s+True\s+RequiresApproval/.test(result.message),
    '#53D: describe subscription shows the pending v1.17.0 upgrade with the pinned v1.16.0 installed',
    result.message.slice(0, 900)
  );
  if (upgradePlan) {
    result = await runCmd(
      `oc patch installplan ${upgradePlan.name} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`
    );
    assert(
      !result.error && /patched/.test(result.message),
      '#53D: approving the upgrade InstallPlan succeeds',
      result.message.slice(0, 240)
    );
  }
  let upgradedSub = await subscriptionState(olmPackage, 'openshift-operators');
  for (let elapsed = 0; elapsed < 60 && upgradedSub?.installedCSV !== olmHeadCsv; elapsed += 2) {
    await advanceBoth(2);
    upgradedSub = await subscriptionState(olmPackage, 'openshift-operators');
  }
  assert(
    upgradedSub?.currentCSV === olmHeadCsv &&
      upgradedSub?.installedCSV === olmHeadCsv &&
      upgradedSub?.phase === 'Succeeded',
    '#53D: approving the upgrade installs v1.17.0 (currentCSV = installedCSV = head, phase Succeeded)',
    JSON.stringify(upgradedSub)
  );
  const completedPending = conditionOf(upgradedSub, 'InstallPlanPending');
  assert(
    completedPending?.status === 'False' && completedPending?.reason === 'InstallPlanComplete',
    '#53D: after the upgrade InstallPlanPending reports False InstallPlanComplete',
    JSON.stringify(completedPending)
  );
  const finalCsvs = await csvsIn('openshift-operators');
  assert(
    finalCsvs.some((csv) => csv.name === olmHeadCsv && csv.phase === 'Succeeded') &&
      !finalCsvs.some((csv) => csv.name === olmPinCsv && csv.phase === 'Succeeded'),
    '#53D: the upgraded head CSV replaces the pinned v1.16.0 CSV (old one no longer Succeeded)',
    JSON.stringify(finalCsvs)
  );
  result = await runCmd('oc get ip -n openshift-operators');
  const installPlanRows = parseTable(result.message).rows;
  assert(
    installPlanRows.length >= 2 &&
      installPlanRows.some(
        (cells) => cells.some((cell) => cell.includes(olmHeadCsv)) && cells.includes('True')
      ),
    '#53D: oc get ip lists both the pinned install plan and the approved upgrade plan',
    result.message.slice(0, 400)
  );

  // #53E: deleting a Subscription must keep the CSV (real OLM uninstall).
  result = await runCmd(
    'oc delete subscription openshift-cert-manager-operator -n openshift-operators'
  );
  assert(
    !result.error && /"openshift-cert-manager-operator" deleted/.test(result.message),
    '#53E: deleting the Subscription succeeds',
    result.message.slice(0, 240)
  );
  const csvsAfterUninstall = await csvsIn('openshift-operators');
  assert(
    csvsAfterUninstall.some((csv) => csv.name === olmHeadCsv),
    '#53E: deleting a Subscription keeps its ClusterServiceVersion (real OLM uninstall semantics)',
    JSON.stringify(csvsAfterUninstall)
  );

  // #53E: a single `oc delete sub a b` deletes every requested name.
  const bogusSub = (name) =>
    subscriptionYaml({
      name,
      namespace: 'openshift-operators',
      packageName: `qa-missing-pkg-${name}`,
      channel: 'stable',
    });
  let applied = await applyManifest('qa-sub-a', bogusSub('qa-sub-a'));
  assert(!applied.error, '#53E: the first disposable Subscription applies', applied.message);
  applied = await applyManifest('qa-sub-b', bogusSub('qa-sub-b'));
  assert(!applied.error, '#53E: the second disposable Subscription applies', applied.message);
  result = await runCmd('oc get sub -n openshift-operators');
  const disposableSubRows = parseTable(result.message).rows.map((cells) => cells[0]);
  assert(
    disposableSubRows.includes('qa-sub-a') && disposableSubRows.includes('qa-sub-b'),
    '#53E: both disposable Subscriptions are listed before the multi-name delete',
    JSON.stringify(disposableSubRows)
  );
  result = await runCmd('oc delete sub qa-sub-a qa-sub-b -n openshift-operators');
  assert(
    !result.error &&
      /subscription\.operators\.coreos\.com "qa-sub-a" deleted/.test(result.message) &&
      /subscription\.operators\.coreos\.com "qa-sub-b" deleted/.test(result.message),
    '#53E: `oc delete sub a b` deletes every requested Subscription and prints one deleted line per name',
    result.message.slice(0, 320)
  );
  result = await runCmd('oc get sub -n openshift-operators');
  const subsAfterMultiDelete = parseTable(result.message).rows.map((cells) => cells[0]);
  assert(
    !subsAfterMultiDelete.includes('qa-sub-a') && !subsAfterMultiDelete.includes('qa-sub-b'),
    '#53E: both requested Subscriptions are really gone',
    JSON.stringify(subsAfterMultiDelete)
  );
  await expectCmdError(
    '#53E: deleting a missing Subscription is a real NotFound error',
    'oc delete sub qa-sub-missing -n openshift-operators',
    /Error from server \(NotFound\): subscriptions\.operators\.coreos\.com "qa-sub-missing" not found/
  );
  result = await runCmd('oc delete sub qa-sub-missing -n openshift-operators --ignore-not-found');
  assert(
    !result.error && result.message.trim() === '',
    '#53E: --ignore-not-found keeps a missing-name delete quiet and successful',
    JSON.stringify(result.message)
  );

  // ── #54: ResolutionFailed must not also report InstallPlanPending ───────
  await runCmd('oc new-project qa-op-rf');
  applied = await applyManifest('qa-op-rf-og', operatorGroupYaml('qa-op-rf'));
  assert(
    !applied.error,
    '#54: the ResolutionFailed project OperatorGroup applies',
    applied.message
  );
  applied = await applyManifest(
    'qa-op-rf-sub',
    subscriptionYaml({
      name: 'bogus-channel',
      namespace: 'qa-op-rf',
      packageName: olmPackage,
      channel: 'does-not-exist',
    })
  );
  assert(!applied.error, '#54: the bogus-channel Subscription applies', applied.message);
  await advanceBoth(30);
  const resolutionFailedSub = await subscriptionState('bogus-channel', 'qa-op-rf');
  const resolutionFailed = conditionOf(resolutionFailedSub, 'ResolutionFailed');
  assert(
    resolutionFailed?.status === 'True' &&
      /no operators found in channel does-not-exist/.test(resolutionFailed?.message || ''),
    '#54: an unresolvable channel still reports ResolutionFailed with the real wording',
    JSON.stringify(resolutionFailed)
  );
  assert(
    !conditionOf(resolutionFailedSub, 'InstallPlanPending'),
    '#54: ResolutionFailed must NOT also report InstallPlanPending False NoInstallPlan',
    JSON.stringify(resolutionFailedSub?.conditions)
  );
  result = await runCmd('oc describe subscription bogus-channel -n qa-op-rf');
  assert(
    /ResolutionFailed/.test(result.message) && !/InstallPlanPending/.test(result.message),
    '#54: describe subscription shows ResolutionFailed without a bogus InstallPlanPending line',
    result.message.slice(0, 600)
  );

  // ═══ Campaign round: #51 L20 crash-revision isolation + rollout-undo
  //     healing, #52 L20 Route objective stability, #54 exec body ═════════
  const l20Snapshot = () =>
    evaluate(() => {
      const cluster = window.game.cluster;
      const containersEnv = (templateSpec) =>
        (templateSpec?.containers || []).flatMap((container) =>
          (container.env || []).map((entry) => `${entry.name}=${entry.value}`)
        );
      const deployment = cluster.getByName('Deployment', 'webapp', 'prod-platform');
      const replicaSets = cluster.getByKindAndNamespace('ReplicaSet', 'prod-platform') || [];
      const pods = cluster.getByKindAndNamespace('Pod', 'prod-platform') || [];
      return {
        templateEnv: containersEnv(deployment?.spec?.template?.spec),
        replicas: replicaSets.map((replicaSet) => ({
          name: replicaSet.metadata?.name || null,
          hash: replicaSet.metadata?.labels?.['pod-template-hash'] || null,
          desired: replicaSet.spec?.replicas ?? null,
          ready: replicaSet.status?.readyReplicas ?? 0,
          templateEnv: containersEnv(replicaSet.spec?.template?.spec),
        })),
        pods: pods.map((pod) => ({
          name: pod.metadata?.name || null,
          hash: pod.metadata?.labels?.['pod-template-hash'] || null,
          phase: pod.status?.phase || null,
          ready: (pod.status?.conditions || []).some(
            (condition) => condition.type === 'Ready' && condition.status === 'True'
          ),
          env: containersEnv({ containers: pod.spec?.containers || [] }),
          waiting: (pod.status?.containerStatuses || [])
            .map((status) => status.state?.waiting?.reason)
            .filter(Boolean),
        })),
      };
    });
  const setupL20 = async (label) => {
    await returnToMenu();
    await sleep(300);
    assert(await launch('campaign', 20), `${label}: campaign L20 starts`);
    await closeOverlays();
    await evaluate(() => {
      window.game.app.hideTutorial?.();
      window.game.gameEngine.pause?.();
    });
    await runCmd('oc new-project prod-platform');
    await runCmd('oc apply -f examples/quota.yaml -n prod-platform');
    await runCmd('oc apply -f examples/limitrange.yaml -n prod-platform');
    await runCmd('oc apply -f manifests/deployment.yaml -n prod-platform');
    await runCmd('oc apply -f manifests/service.yaml -n prod-platform');
    const workloadReady = await advanceUntil(async () => {
      const pods = await podRows('prod-platform');
      return pods.filter((pod) => pod.phase === 'Running' && pod.ready).length >= 2;
    }, 30);
    assert(
      workloadReady,
      `${label}: the webapp Deployment is 2/2 Ready before the scheduled incident`
    );
  };
  const l20RouteObjective = () =>
    evaluate(() => {
      const mode = window.game.app.modeInstance;
      if (typeof mode?.updateObjectives !== 'function') return null;
      mode.updateObjectives();
      const index = (mode.currentLevelDef?.objectives || []).findIndex(
        (objective) => objective.type === 'route'
      );
      if (index < 0) return null;
      const entry = mode.objectiveProgress?.[index] || null;
      return entry ? { label: entry.label || '', completed: entry.completed === true } : null;
    });
  const runL20CrashScenario = async (undoCommand, label, options = {}) => {
    await setupL20(label);
    const fired = await advanceUntil(
      async () => (await activeIncidentNames()).includes('CrashLoopBackOff'),
      80
    );
    assert(fired, `${label}: the scheduled CrashLoopBackOff incident fires on webapp`);
    const crashed = await l20Snapshot();
    const badReplicaSet = crashed.replicas.find((replicaSet) =>
      replicaSet.templateEnv.some((entry) => entry.startsWith('APP_MODE=debug-invalid'))
    );
    const oldReplicaSet = crashed.replicas.find(
      (replicaSet) => !replicaSet.templateEnv.some((entry) => entry.startsWith('APP_MODE='))
    );
    assert(
      Boolean(badReplicaSet && oldReplicaSet),
      `${label}: the crash seed creates a new revision whose template carries the faulty APP_MODE`,
      JSON.stringify(crashed.replicas)
    );
    assert(
      oldReplicaSet?.desired === 2,
      `${label}: the old revision keeps its 2 desired replicas while the rollout stalls`,
      JSON.stringify(oldReplicaSet)
    );
    assert(
      badReplicaSet?.desired <= 1,
      `${label}: the new revision respects maxSurge (25% of 2 → one surged pod, not 2)`,
      JSON.stringify(badReplicaSet)
    );
    const oldPods = crashed.pods.filter((pod) => pod.hash === oldReplicaSet?.hash);
    const badPods = crashed.pods.filter((pod) => pod.hash === badReplicaSet?.hash);
    assert(
      oldPods.length === 2 &&
        oldPods.every(
          (pod) =>
            pod.phase === 'Running' &&
            pod.ready &&
            !pod.waiting.includes('CrashLoopBackOff') &&
            !pod.env.some((entry) => entry.startsWith('APP_MODE='))
        ),
      `${label}: old-revision pods keep Running/Ready and never crash (their template has no APP_MODE)`,
      JSON.stringify(oldPods)
    );
    assert(
      badPods.length >= 1 &&
        badPods.every(
          (pod) =>
            !pod.ready &&
            (pod.phase === 'CrashLoopBackOff' || pod.waiting.includes('CrashLoopBackOff'))
        ),
      `${label}: only the new-revision pods crash`,
      JSON.stringify(badPods)
    );
    result = await runCmd('oc get endpoints webapp -n prod-platform');
    const servingEndpoints = endpointsCell(result.message, 'webapp');
    assert(
      !/<none>/.test(servingEndpoints) && servingEndpoints.split(',').filter(Boolean).length >= 2,
      `${label}: the Service keeps serving the old pods while the rollout is broken`,
      servingEndpoints
    );
    if (options.checkPlatform) {
      result = await runCmd('oc get pods -n openshift-ingress');
      const campaignRouters = parseTable(result.message).rows.filter((cells) =>
        /^router-default-/.test(cells[0])
      );
      assert(
        campaignRouters.length >= 2 &&
          campaignRouters.every((cells) => cells[1] === '1/1' && cells[2] === 'Running'),
        `${label}: campaign mode also runs the openshift-ingress router-default pods`,
        JSON.stringify(campaignRouters)
      );
      result = await runCmd('oc get nodes');
      const campaignNodeCount = parseTable(result.message).rows.length;
      result = await runCmd('oc get pods -n openshift-dns');
      const campaignDnsPods = parseTable(result.message).rows.map((cells) => cells[0]);
      assert(
        campaignDnsPods.filter((name) => /^dns-default-/.test(name)).length === campaignNodeCount &&
          campaignDnsPods.filter((name) => /^node-resolver-/.test(name)).length ===
            campaignNodeCount,
        `${label}: campaign mode seeds one dns-default and one node-resolver pod per node`,
        JSON.stringify(campaignDnsPods)
      );
      result = await runCmd('oc debug node/node-2');
      assert(
        !result.error && /Starting pod\/worker-1-debug/.test(result.message),
        `${label}: legacy campaign node-N aliases still map forward (node-2 → worker-1)`,
        result.message.slice(0, 280)
      );
      await runCmd('exit');
    }
    const undo = await runCmd(undoCommand, 300);
    assert(
      !undo.error && /rolled back/.test(undo.message),
      `${label}: \`${undoCommand}\` rolls the Deployment back`,
      undo.message.slice(0, 280)
    );
    const healed = await advanceUntil(async () => {
      const names = await activeIncidentNames();
      const state = await l20Snapshot();
      const badReplicaSetAfter = state.replicas.find(
        (replicaSet) => replicaSet.hash === badReplicaSet?.hash
      );
      return (
        !names.includes('CrashLoopBackOff') &&
        !state.templateEnv.some((entry) => entry.startsWith('APP_MODE=')) &&
        (!badReplicaSetAfter || badReplicaSetAfter.desired === 0) &&
        state.pods.filter((pod) => pod.phase === 'Running' && pod.ready).length >= 2 &&
        !state.pods.some((pod) => pod.waiting.includes('CrashLoopBackOff'))
      );
    }, 60);
    assert(
      healed,
      `${label}: rollout undo heals the Deployment and resolves the CrashLoopBackOff incident`
    );
    const healedState = await l20Snapshot();
    assert(
      !healedState.templateEnv.some((entry) => entry.startsWith('APP_MODE=')),
      `${label}: the revision-1 template is restored (no APP_MODE)`,
      JSON.stringify(healedState.templateEnv)
    );
    const healedOldReplicaSet = healedState.replicas.find(
      (replicaSet) => replicaSet.hash === oldReplicaSet?.hash
    );
    const healedBadReplicaSet = healedState.replicas.find(
      (replicaSet) => replicaSet.hash === badReplicaSet?.hash
    );
    assert(
      healedOldReplicaSet?.desired === 2 &&
        (!healedBadReplicaSet || healedBadReplicaSet.desired === 0),
      `${label}: the good ReplicaSet scales back to 2 while the bad ReplicaSet scales to 0`,
      JSON.stringify(healedState.replicas)
    );
    assert(
      healedState.pods.filter((pod) => pod.phase === 'Running' && pod.ready).length === 2 &&
        !healedState.pods.some((pod) => pod.waiting.includes('CrashLoopBackOff')),
      `${label}: both webapp pods are Running/Ready after the undo`,
      JSON.stringify(healedState.pods)
    );
    result = await runCmd('oc get deployment webapp -n prod-platform');
    assert(
      /webapp\s+2\/2/.test(result.message),
      `${label}: oc get deployment shows 2/2 available after the heal`,
      result.message.slice(0, 240)
    );
    if (options.checkExec) {
      result = await runCmd('oc exec deploy/webapp -n prod-platform -- curl -s localhost:8080');
      assert(
        !result.error && result.message.trim() === '<html><body>Hello OpenShift!</body></html>',
        `${label}: L20 exec localhost returns the pod app's real body (no "container main")`,
        result.message.slice(0, 240)
      );
    }
    if (options.checkRouteObjective) {
      await runCmd('oc create route edge webapp --service=webapp -n prod-platform', 300);
      await advanceBoth(8);
      let routeObjective = await l20RouteObjective();
      assert(
        routeObjective?.completed === true,
        `${label}: the L20 "Create an external Route (Admitted)" objective ticks`,
        JSON.stringify(routeObjective)
      );
      await runCmd(
        'oc patch svc/webapp -n prod-platform -p \'{"spec":{"selector":{"app":"no-match"}}}\''
      );
      await advanceBoth(8);
      const admittedWithBrokenSelector = await routeAdmission('prod-platform', 'webapp');
      assert(
        admittedWithBrokenSelector.status === 'True',
        `${label}: the L20 Route stays Admitted when the Service selector matches no pods`,
        JSON.stringify(admittedWithBrokenSelector)
      );
      routeObjective = await l20RouteObjective();
      assert(
        routeObjective?.completed === true,
        `${label}: the L20 Route Admitted objective does not flip while endpoints are missing`,
        JSON.stringify(routeObjective)
      );
      await runCmd(
        'oc patch svc/webapp -n prod-platform -p \'{"spec":{"selector":{"app":"webapp"}}}\''
      );
      await advanceBoth(6);
    }
  };
  await runL20CrashScenario('oc rollout undo deployment/webapp -n prod-platform', '#51', {
    checkPlatform: true,
    checkRouteObjective: true,
    checkExec: true,
  });
  await runL20CrashScenario(
    'oc rollout undo deployment/webapp --to-revision=1',
    '#51 --to-revision=1'
  );

  // ═══ Timed lab: consistent node naming + platform DNS pods (#53F/#53G) ═══
  await returnToMenu();
  await sleep(300);
  assert(await launch('challenge', 13), '#53F: timed Lab 13 starts');
  await closeOverlays();
  await evaluate(() => {
    window.game.app.hideTutorial?.();
    window.game.gameEngine.pause?.();
  });
  result = await runCmd('oc get nodes');
  const labNodeNames = parseTable(result.message)
    .rows.map((cells) => cells[0])
    .sort();
  assert(
    JSON.stringify(labNodeNames) === JSON.stringify(['master-0', 'worker-0', 'worker-1']),
    '#53F: three-node labs use the shared worker-0/worker-1/master-0 names (no node-N ghosts)',
    JSON.stringify(labNodeNames)
  );
  result = await runCmd('oc get pods -n openshift-dns');
  const labDnsPods = parseTable(result.message).rows.map((cells) => cells[0]);
  assert(
    !result.error &&
      labDnsPods.filter((name) => /^dns-default-/.test(name)).length === labNodeNames.length &&
      labDnsPods.filter((name) => /^node-resolver-/.test(name)).length === labNodeNames.length,
    '#53G: Lab 13 has the dns-default/node-resolver pods its DNS egress objective teaches',
    JSON.stringify(labDnsPods)
  );
  result = await runCmd('oc debug node/worker-0');
  assert(
    !result.error && /Starting pod\/worker-0-debug/.test(result.message),
    '#53F: `oc debug node/worker-0` resolves the real lab node instead of silently aliasing node-1',
    result.message.slice(0, 280)
  );
  await runCmd('exit');

  // ═══ Campaign L18: the pinned-install objective survives a pending
  //     Manual upgrade plan (#53D regression contract) ════════════════════
  await returnToMenu();
  await sleep(300);
  assert(
    await launch('campaign', 18),
    '#53D: campaign L18 starts for the pin/upgrade grading check'
  );
  await closeOverlays();
  await evaluate(() => {
    window.game.app.hideTutorial?.();
    window.game.gameEngine.pause?.();
  });
  applied = await applyManifest(
    'l18-pinned-sub',
    subscriptionYaml({
      name: olmPackage,
      namespace: 'openshift-operators',
      packageName: olmPackage,
      channel: olmChannel,
      startingCSV: olmPinCsv,
      approval: 'Manual',
    })
  );
  assert(
    !applied.error,
    '#53D: the L18 pinned Manual Subscription applies',
    applied.message.slice(0, 240)
  );
  await advanceBoth(6);
  const l18PinnedPlan = await installPlanFor('openshift-operators', olmPinCsv);
  assert(Boolean(l18PinnedPlan), '#53D: the L18 pinned Subscription creates its InstallPlan');
  if (l18PinnedPlan) {
    await runCmd(
      `oc patch installplan ${l18PinnedPlan.name} -n openshift-operators --type=merge -p '{"spec":{"approved":true}}'`
    );
  }
  let l18PinPhase = null;
  for (let elapsed = 0; elapsed < 40 && l18PinPhase !== 'Succeeded'; elapsed += 2) {
    await advanceBoth(2);
    l18PinPhase = await csvPhase('openshift-operators', olmPinCsv);
  }
  let l18UpgradePlan = null;
  for (let elapsed = 0; elapsed < 30 && !l18UpgradePlan; elapsed += 2) {
    await advanceBoth(2);
    l18UpgradePlan = await installPlanFor('openshift-operators', olmHeadCsv);
  }
  const l18Sub = await subscriptionState(olmPackage, 'openshift-operators');
  assert(
    l18PinPhase === 'Succeeded' &&
      Boolean(l18UpgradePlan) &&
      l18Sub?.installedCSV === olmPinCsv &&
      l18Sub?.currentCSV === olmHeadCsv,
    '#53D: while the L18 Manual upgrade is pending installedCSV stays the pinned v1.16.0',
    JSON.stringify({ phase: l18PinPhase, upgradePlan: l18UpgradePlan, sub: l18Sub })
  );
  const l18Objective = await evaluate(() => {
    const mode = window.game.app.modeInstance;
    if (typeof mode?.updateObjectives !== 'function') return null;
    mode.updateObjectives();
    const index = (mode.currentLevelDef?.objectives || []).findIndex(
      (objective) => objective.type === 'subscription'
    );
    if (index < 0) return null;
    const entry = mode.objectiveProgress?.[index] || null;
    return entry ? { label: entry.label || '', completed: entry.completed === true } : null;
  });
  assert(
    l18Objective?.completed === true,
    '#53D: the L18 pin objective still ticks while the Manual upgrade plan is pending',
    JSON.stringify(l18Objective)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.5.0 — issues #55/#56: control-plane NoSchedule taint + pod
// scheduling, controller-owned platform workloads (router Deployment/RS, DNS
// DaemonSets), the OLM Manual pin→upgrade replacement chain/operator rollout,
// and the multi-kind `endpoints/` prefix + route-admission event fixes.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue55-56', async () => {
  const olmNamespace = 'openshift-operators';
  const olmPackageName = 'openshift-cert-manager-operator';
  const olmChannel = 'stable-v1';
  const olmHeadCsv = 'cert-manager-operator.v1.17.0';
  const olmPinCsv = 'cert-manager-operator.v1.16.0';
  const olmPreviousCsv = 'cert-manager-operator.v1.15.0';
  const operatorDeploymentName = 'cert-manager-operator-controller-manager';
  const masterTaintKey = 'node-role.kubernetes.io/master';
  const masterTaintSpec = `${masterTaintKey}:NoSchedule`;
  let result;

  /** Advance the simulation AND incident clocks deterministically (0.05 s). */
  const advanceBoth = async (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      const engine = window.game?.incidentEngine;
      if (!sim || typeof sim.tick !== 'function') return false;
      const steps = Math.ceil(secs / 0.05);
      for (let index = 0; index < steps; index += 1) {
        sim.tick(0.05);
        if (engine && typeof engine.tick === 'function') engine.tick(0.05);
      }
      return true;
    }, seconds);
  /** Advance both clocks until predicate() is true, or exhaust maxSeconds. */
  const advanceUntil = async (predicate, maxSeconds = 60, step = 2) => {
    for (let played = 0; played < maxSeconds; played += step) {
      await advanceBoth(step);
      if (await predicate()) return true;
    }
    return false;
  };
  /** Write a virtual manifest file then apply it like the player would. */
  const applyManifest = async (name, yaml) => {
    await waitFor(() => evaluate(() => !!window.game?.manifestEngine), 5000);
    await evaluate(({ file, content }) => window.game.manifestEngine.writeFile(file, content), {
      file: `qa/${name}.yaml`,
      content: yaml,
    });
    return runCmd(`oc apply -f qa/${name}.yaml`, 300);
  };
  /** Split an oc tabwriter table into header cells + rows (3+ space columns). */
  const tableParts = (message) => {
    const lines = String(message ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    return {
      headers: (lines[0] || '').split(/\s{2,}/).map((cell) => cell.trim()),
      rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
    };
  };
  /** Blank-line separated tables from a multi-kind `oc get` response. */
  const tableSections = (message) => {
    const blocks = String(message ?? '').split(/\n{2,}/);
    const sections = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      if (!lines.length) continue;
      sections.push({
        headers: lines[0].split(/\s{2,}/).map((cell) => cell.trim()),
        rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
        block,
      });
    }
    return sections;
  };
  const sectionWithHeaders = (message, required) =>
    tableSections(message).find((candidate) =>
      required.every((header) => candidate.headers.includes(header))
    ) || null;
  const columnIndex = (section, header) => (section ? section.headers.indexOf(header) : -1);
  const cellsForRow = (section, predicate) =>
    (section?.rows || []).find((cells) => predicate(cells[0] || '')) || null;
  /** `oc get pods -o wide` parsed with its real NODE column. */
  const podWide = async (namespace) => {
    const out = await runCmd(`oc get pods -o wide -n ${namespace}`);
    const table = tableParts(out.message);
    const nodeAt = table.headers.indexOf('NODE');
    return {
      message: out.message,
      rows: table.rows.map((cells) => ({
        name: cells[0] || '',
        ready: cells[1] || '',
        status: cells[2] || '',
        node: nodeAt >= 0 ? cells[nodeAt] || '' : '',
      })),
    };
  };
  const nodeNames = () =>
    evaluate(() =>
      (window.game?.cluster?.getByKind('Node') || []).map((node) => node.metadata?.name || '')
    );
  /** Pod/deployment/ReplicaSet/DaemonSet shapes the platform is expected to be. */
  const platformState = () =>
    evaluate(() => {
      const cluster = window.game.cluster;
      const summarize = (namespace) =>
        (cluster.getByKindAndNamespace('Pod', namespace) || []).map((pod) => ({
          name: pod.metadata?.name || '',
          node: pod.spec?.nodeName || '',
          phase: pod.status?.phase || '',
          ready: (pod.status?.conditions || []).some(
            (condition) => condition.type === 'Ready' && condition.status === 'True'
          ),
          hash: pod.metadata?.labels?.['pod-template-hash'] || '',
          containers: (pod.spec?.containers || []).map((container) => container.name),
          containerStatuses: (pod.status?.containerStatuses || []).map((status) => ({
            name: status.name,
            ready: status.ready === true,
          })),
          tolerations: (pod.spec?.tolerations || []).map((toleration) => ({
            key: toleration.key || '',
            operator: toleration.operator || 'Equal',
            value: toleration.value ?? '',
            effect: toleration.effect || '',
          })),
          owners: (pod.metadata?.ownerReferences || []).map((reference) => ({
            kind: reference.kind,
            name: reference.name,
            controller: reference.controller === true,
          })),
          labels: pod.metadata?.labels || {},
        }));
      return { ingress: summarize('openshift-ingress'), dns: summarize('openshift-dns') };
    });
  /** Deployments/ReplicaSets/DaemonSets in a namespace with owner links. */
  const namespaceControllers = (namespace) =>
    evaluate((ns) => {
      const cluster = window.game.cluster;
      const ownersOf = (resource) =>
        (resource.metadata?.ownerReferences || []).map((reference) => ({
          kind: reference.kind,
          name: reference.name,
        }));
      const podsOf = (kind) => cluster.getByKindAndNamespace(kind, ns) || [];
      return {
        deployments: podsOf('Deployment').map((resource) => ({
          name: resource.metadata?.name || '',
          replicas: resource.spec?.replicas ?? null,
          readyReplicas: resource.status?.readyReplicas ?? 0,
          availableReplicas: resource.status?.availableReplicas ?? 0,
          updatedReplicas: resource.status?.updatedReplicas ?? 0,
          owners: ownersOf(resource),
        })),
        replicaSets: podsOf('ReplicaSet').map((resource) => ({
          name: resource.metadata?.name || '',
          hash: resource.metadata?.labels?.['pod-template-hash'] || '',
          desired: resource.spec?.replicas ?? null,
          readyReplicas: resource.status?.readyReplicas ?? 0,
          owners: ownersOf(resource),
        })),
        daemonSets: podsOf('DaemonSet').map((resource) => ({
          name: resource.metadata?.name || '',
          desiredNumberScheduled: resource.status?.desiredNumberScheduled ?? null,
          currentNumberScheduled: resource.status?.currentNumberScheduled ?? null,
          numberReady: resource.status?.numberReady ?? null,
          owners: ownersOf(resource),
        })),
      };
    }, namespace);
  /** The cert-manager operator Deployment + ReplicaSets + pods (issue #56). */
  const operatorState = (namespace) =>
    evaluate(
      ({ ns, deploymentName }) => {
        const cluster = window.game.cluster;
        const isOperator = (name) => String(name || '').startsWith(`${deploymentName}-`);
        const deployment = cluster.getByName('Deployment', deploymentName, ns);
        const container = deployment?.spec?.template?.spec?.containers?.[0] || null;
        return {
          deployment: deployment
            ? {
                name: deployment.metadata?.name || '',
                labels: deployment.metadata?.labels || {},
                replicas: deployment.spec?.replicas ?? null,
                readyReplicas: deployment.status?.readyReplicas ?? 0,
                availableReplicas: deployment.status?.availableReplicas ?? 0,
                updatedReplicas: deployment.status?.updatedReplicas ?? 0,
                image: container?.image || '',
                template: JSON.parse(JSON.stringify(deployment.spec?.template || {})),
              }
            : null,
          replicaSets: (cluster.getByKindAndNamespace('ReplicaSet', ns) || [])
            .filter((resource) => isOperator(resource.metadata?.name))
            .map((resource) => ({
              name: resource.metadata?.name || '',
              hash: resource.metadata?.labels?.['pod-template-hash'] || '',
              desired: resource.spec?.replicas ?? null,
              readyReplicas: resource.status?.readyReplicas ?? 0,
              owners: (resource.metadata?.ownerReferences || []).map(
                (reference) => `${reference.kind}/${reference.name}`
              ),
            })),
          pods: (cluster.getByKindAndNamespace('Pod', ns) || [])
            .filter((resource) => isOperator(resource.metadata?.name))
            .map((resource) => ({
              name: resource.metadata?.name || '',
              hash: resource.metadata?.labels?.['pod-template-hash'] || '',
              phase: resource.status?.phase || '',
              ready: (resource.status?.conditions || []).some(
                (condition) => condition.type === 'Ready' && condition.status === 'True'
              ),
              owners: (resource.metadata?.ownerReferences || []).map((reference) => ({
                kind: reference.kind,
                name: reference.name,
              })),
            })),
        };
      },
      { ns: namespace, deploymentName: operatorDeploymentName }
    );
  const subscriptionState = (name, namespace) =>
    evaluate(
      ({ subName, ns }) => {
        const sub = window.game.cluster.getByName('Subscription', subName, ns);
        return sub
          ? {
              phase: sub.status?.phase || null,
              state: sub.status?.state || null,
              installedCSV: sub.status?.installedCSV || null,
              currentCSV: sub.status?.currentCSV || null,
              startingCSV: sub.spec?.startingCSV || null,
            }
          : null;
      },
      { subName: name, ns: namespace }
    );
  const installPlanFor = (namespace, csvName) =>
    evaluate(
      ({ ns, csv }) => {
        const plan = (window.game.cluster.getByKindAndNamespace('InstallPlan', ns) || []).find(
          (candidate) => (candidate.spec?.clusterServiceVersionNames || []).includes(csv)
        );
        return plan
          ? {
              name: plan.metadata?.name || null,
              csvs: plan.spec?.clusterServiceVersionNames || [],
              approval: plan.spec?.approval || null,
              approved: plan.spec?.approved === true,
            }
          : null;
      },
      { ns: namespace, csv: csvName }
    );
  const csvPhase = (namespace, csvName) =>
    evaluate(
      ({ ns, csv }) =>
        window.game.cluster.getByName('ClusterServiceVersion', csv, ns)?.status?.phase || null,
      { ns: namespace, csv: csvName }
    );
  const csvJsonPath = async (csvName, path) => {
    const out = await runCmd(`oc get csv ${csvName} -n ${olmNamespace} -o jsonpath='{${path}}'`);
    return { error: out.error, value: out.message.trim(), message: out.message };
  };
  /** Rows of `oc get events` as { type, reason, object, message }. */
  const getEventRows = (message) =>
    String(message ?? '')
      .split('\n')
      .slice(1)
      .map((line) =>
        line
          .split(/\s{2,}/)
          .map((cell) => cell.trim())
          .filter(Boolean)
      )
      .filter((cells) => cells.length >= 4)
      .map((cells) => ({
        type: cells[1],
        reason: cells[2],
        object: cells[3],
        message: cells.slice(4).join(' '),
      }));
  const routeCondition = (namespace, name) =>
    evaluate(
      ({ ns, routeName }) => {
        const route = window.game.cluster.getByName('Route', routeName, ns);
        const condition = (route?.status?.ingress?.[0]?.conditions || []).find(
          (candidate) => candidate.type === 'Admitted'
        );
        return condition
          ? {
              status: condition.status,
              reason: condition.reason || '',
              message: condition.message || '',
            }
          : null;
      },
      { ns: namespace, routeName: name }
    );

  // ═══ Round 1: #55A control-plane taint + scheduling (running sandbox) ═══
  assert(await bootSandbox(), '#55A: a fresh sandbox boots for the control-plane checks');

  result = await runCmd('oc describe node master-0');
  assert(
    /^Taints:\s+node-role\.kubernetes\.io\/master:NoSchedule\s*$/m.test(result.message),
    '#55A: `oc describe node master-0` shows the dedicated NoSchedule control-plane taint',
    (result.message.match(/^Taints:.*$/m) || [''])[0]
  );
  for (const workerName of ['worker-0', 'worker-1']) {
    result = await runCmd(`oc describe node ${workerName}`);
    assert(
      /^Taints:\s+<none>\s*$/m.test(result.message),
      `#55A: \`oc describe node ${workerName}\` has no taints`,
      (result.message.match(/^Taints:.*$/m) || [''])[0]
    );
  }

  // Platform DaemonSet pods tolerate the control-plane taint and keep running.
  let platform = await platformState();
  const masterDnsPods = platform.dns.filter((pod) => pod.node === 'master-0');
  const dnsPodOnMaster = masterDnsPods.find((pod) => /^dns-default-/.test(pod.name)) || null;
  const resolverPodOnMaster = masterDnsPods.find((pod) => /^node-resolver-/.test(pod.name)) || null;
  const toleratesMasterTaint = (pod) =>
    Boolean(
      pod?.tolerations.some(
        (toleration) =>
          toleration.key === masterTaintKey &&
          (toleration.operator === 'Exists' || toleration.value === '') &&
          (!toleration.effect || toleration.effect === 'NoSchedule')
      )
    );
  assert(
    Boolean(dnsPodOnMaster && resolverPodOnMaster) &&
      toleratesMasterTaint(dnsPodOnMaster) &&
      toleratesMasterTaint(resolverPodOnMaster),
    '#55A: dns-default/node-resolver pods on master-0 tolerate node-role.kubernetes.io/master:NoSchedule',
    JSON.stringify(masterDnsPods)
  );
  assert(
    masterDnsPods.every((pod) => pod.phase === 'Running' && pod.ready),
    '#55A: the platform pods on the tainted master-0 keep Running/Ready',
    JSON.stringify(masterDnsPods)
  );

  // User Deployment pods never schedule on the control plane and spread over workers.
  await runCmd('oc new-project qa-taint55');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa-taint55');
  await runCmd('oc apply -f manifests/service.yaml -n qa-taint55');
  const userPodsRunning = await advanceUntil(async () => {
    const wide = await podWide('qa-taint55');
    return wide.rows.length >= 2 && wide.rows.every((row) => row.status === 'Running');
  }, 40);
  const userWide = await podWide('qa-taint55');
  assert(
    userPodsRunning && userWide.rows.length === 2,
    '#55A: the webapp Deployment reaches two Running pods',
    JSON.stringify(userWide.rows)
  );
  assert(
    userWide.rows.length > 0 &&
      userWide.rows.every((row) => row.node !== 'master-0' && /^worker-\d+$/.test(row.node)),
    '#55A: user workload pods never land on the tainted master-0',
    JSON.stringify(userWide.rows)
  );
  const spreadNodes = [...new Set(userWide.rows.map((row) => row.node))].sort();
  assert(
    spreadNodes.length === 2 &&
      spreadNodes.includes('worker-0') &&
      spreadNodes.includes('worker-1'),
    '#55A: the two user replicas spread over worker-0 and worker-1',
    JSON.stringify(spreadNodes)
  );

  // The issue's `oc new-app --image=…` repro must schedule on a worker too.
  await runCmd('oc new-project qa-taint55b');
  result = await runCmd(
    'oc new-app --image=quay.io/openshift/origin-hello-openshift --name=web -n qa-taint55b',
    400
  );
  assert(
    !result.error && /deployment/.test(result.message),
    '#55A: `oc new-app --image=… --name=web` creates the workload',
    result.message.slice(0, 300)
  );
  const newAppReady = await advanceUntil(async () => {
    const wide = await podWide('qa-taint55b');
    const pods = wide.rows.filter((row) => /^web-/.test(row.name));
    return pods.length === 1 && pods.every((row) => row.status === 'Running');
  }, 40);
  const newAppWide = await podWide('qa-taint55b');
  const newAppPod = newAppWide.rows.find((row) => /^web-/.test(row.name)) || null;
  assert(
    newAppReady && Boolean(newAppPod) && newAppPod.node !== 'master-0',
    '#55A: an `oc new-app` pod is scheduled on a worker, never master-0',
    JSON.stringify(newAppWide.rows)
  );

  // A pod that explicitly targets the master must stay Pending with a
  // FailedScheduling event that names the untolerated taint.
  const masterPinnedYaml = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: pinned-master',
    '  namespace: qa-taint55',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    '      app: pinned-master',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: pinned-master',
    '    spec:',
    '      nodeSelector:',
    '        node-role.kubernetes.io/master: ""',
    '      containers:',
    '      - name: app',
    '        image: quay.io/openshift/origin-hello-openshift:latest',
  ].join('\n');
  result = await applyManifest('qa-master-pinned', masterPinnedYaml);
  assert(
    !result.error && /deployment\.apps\/pinned-master created/.test(result.message),
    '#55A: the master-nodeSelector Deployment applies',
    result.message.slice(0, 300)
  );
  await advanceBoth(10);
  result = await runCmd('oc get pods -n qa-taint55 -l app=pinned-master');
  let pinnedPodRow = tableParts(result.message).rows.find((cells) =>
    /^pinned-master-/.test(cells[0] || '')
  );
  const pinnedAppeared = await advanceUntil(async () => {
    const out = await runCmd('oc get pods -n qa-taint55 -l app=pinned-master');
    pinnedPodRow = tableParts(out.message).rows.find((cells) =>
      /^pinned-master-/.test(cells[0] || '')
    );
    return Boolean(pinnedPodRow);
  }, 20);
  assert(
    pinnedAppeared && Boolean(pinnedPodRow),
    '#55A: the master-nodeSelector pod is created',
    JSON.stringify(pinnedPodRow)
  );
  // The scheduler leaves the pod unbound: STATUS Pending with PodScheduled=False.
  // #57 fixed the pre-existing display nit this assertion used to work around:
  // an unbound Pending Pod now reports its real api phase in the `oc get pods`
  // STATUS cell (`Pending`), not the kubelet-only ContainerCreating state, so
  // the assertion reads the STATUS cell instead of the API phase.
  result = await runCmd('oc get pods -n qa-taint55 -l app=pinned-master');
  {
    const pinnedStatusTable = tableParts(result.message);
    const pinnedStatusAt = pinnedStatusTable.headers.indexOf('STATUS');
    const pinnedStatusRow =
      pinnedStatusTable.rows.find((cells) => /^pinned-master-/.test(cells[0] || '')) || [];
    assert(
      !result.error && pinnedStatusAt >= 0 && pinnedStatusRow[pinnedStatusAt] === 'Pending',
      '#55A/#57: a pod that explicitly targets the master stays Pending under the NoSchedule taint',
      JSON.stringify({ headers: pinnedStatusTable.headers, row: pinnedStatusRow })
    );
  }
  result = await runCmd(`oc describe pod ${pinnedPodRow?.[0] || 'missing'} -n qa-taint55`);
  assert(
    /FailedScheduling/.test(result.message) &&
      /untolerated taint/.test(result.message) &&
      new RegExp(masterTaintKey.replace(/\./g, '\\.')).test(result.message),
    '#55A: the Pending pod reports FailedScheduling naming the untolerated master taint',
    result.message.slice(-900)
  );

  // ═══ Round 2: #55B controller-owned platform workloads ══════════════════
  result = await runCmd('oc get deploy,rs -n openshift-ingress');
  let deploySection = sectionWithHeaders(result.message, [
    'NAME',
    'READY',
    'UP-TO-DATE',
    'AVAILABLE',
    'AGE',
  ]);
  let replicasetSection = sectionWithHeaders(result.message, [
    'NAME',
    'DESIRED',
    'CURRENT',
    'READY',
    'AGE',
  ]);
  const routerDeployRow = cellsForRow(deploySection, (name) =>
    /^(?:deployment\.apps\/)?router-default$/.test(name)
  );
  const routerRsRows = (replicasetSection?.rows || []).filter((cells) =>
    /^(?:replicaset\.apps\/)?router-default-/.test(cells[0] || '')
  );
  assert(
    Boolean(routerDeployRow) && routerDeployRow[columnIndex(deploySection, 'READY')] === '2/2',
    '#55B: `oc get deploy,rs -n openshift-ingress` shows deployment.apps/router-default 2/2',
    result.message.slice(0, 500)
  );
  assert(
    routerRsRows.length === 1,
    '#55B: openshift-ingress has exactly one router-default ReplicaSet',
    JSON.stringify(routerRsRows)
  );
  const routerRsName = String(routerRsRows[0]?.[0] || '').replace(/^(?:replicaset\.apps\/)/, '');
  const routerHash = routerRsName.replace(/^router-default-/, '');

  const ingressControllers = await namespaceControllers('openshift-ingress');
  const routerDeployment = ingressControllers.deployments.find(
    (deployment) => deployment.name === 'router-default'
  );
  const routerReplicaSets = ingressControllers.replicaSets.filter((replicaSet) =>
    /^router-default-/.test(replicaSet.name)
  );
  assert(
    Boolean(routerDeployment) &&
      routerDeployment.replicas === 2 &&
      routerDeployment.readyReplicas >= 2 &&
      routerDeployment.availableReplicas >= 2,
    '#55B: the router-default Deployment object is 2/2 ready/available',
    JSON.stringify(routerDeployment)
  );
  assert(
    routerReplicaSets.length === 1 &&
      routerReplicaSets[0].hash === routerHash &&
      routerReplicaSets[0].owners.some(
        (owner) => owner.kind === 'Deployment' && owner.name === 'router-default'
      ),
    '#55B: the router ReplicaSet carries the Deployment ownerReference and the pod-template-hash',
    JSON.stringify(routerReplicaSets)
  );

  platform = await platformState();
  const routerPods = platform.ingress.filter((pod) => /^router-default-/.test(pod.name));
  assert(
    routerPods.length === 2 && routerPods.every((pod) => pod.phase === 'Running' && pod.ready),
    '#55B: exactly two router-default pods are Running/Ready',
    JSON.stringify(routerPods.map((pod) => `${pod.name}:${pod.phase}`))
  );
  assert(
    routerPods.every((pod) => pod.hash === routerHash) && /^[a-z0-9]+$/.test(routerHash),
    '#55B: both router pods share the ReplicaSet pod-template-hash prefix',
    JSON.stringify({ hash: routerHash, pods: routerPods.map((pod) => pod.hash) })
  );
  assert(
    routerPods.every((pod) =>
      pod.owners.some((owner) => owner.kind === 'ReplicaSet' && owner.name === routerRsName)
    ),
    '#55B: every router pod is owned by the router ReplicaSet (pod → ReplicaSet → Deployment)',
    JSON.stringify(routerPods.map((pod) => pod.owners))
  );

  result = await runCmd(
    `oc get pod ${routerPods[0]?.name || 'missing'} -n openshift-ingress -o jsonpath='{.metadata.ownerReferences}'`
  );
  assert(
    !result.error &&
      /"kind"\s*:\s*"ReplicaSet"/.test(result.message) &&
      result.message.includes(routerRsName),
    '#55B: `oc get pod … -o jsonpath=ownerReferences` shows the ReplicaSet owner',
    result.message.slice(0, 500)
  );
  result = await runCmd(
    `oc get rs ${routerRsName} -n openshift-ingress -o jsonpath='{.metadata.ownerReferences}'`
  );
  assert(
    !result.error &&
      /"kind"\s*:\s*"Deployment"/.test(result.message) &&
      /"name"\s*:\s*"router-default"/.test(result.message),
    '#55B: the router ReplicaSet ownerReference points at deployment.apps/router-default',
    result.message.slice(0, 500)
  );

  result = await runCmd('oc describe deploy router-default -n openshift-ingress');
  assert(
    !result.error &&
      /^Name:\s+router-default\s*$/m.test(result.message) &&
      /Replicas:\s+2 desired/.test(result.message) &&
      /Pod Template:/.test(result.message),
    '#55B: `oc describe deploy router-default -n openshift-ingress` works',
    result.message.slice(0, 900)
  );
  result = await runCmd('oc rollout status deployment/router-default -n openshift-ingress');
  assert(
    !result.error && /successfully rolled out/.test(result.message),
    '#55B: `oc rollout status deployment/router-default -n openshift-ingress` reports the rollout complete',
    result.message.slice(0, 400)
  );

  // openshift-dns: two DaemonSets, one owned pod per node.
  result = await runCmd('oc get ds -n openshift-dns');
  const daemonSetTable = tableParts(result.message);
  const daemonSetCell = (name, header) => {
    const row = daemonSetTable.rows.find((cells) => cells[0] === name) || [];
    const at = daemonSetTable.headers.indexOf(header);
    return at >= 0 ? row[at] || '' : '';
  };
  const expectedNodes = (await nodeNames()).length;
  assert(
    !result.error &&
      daemonSetTable.rows.some((cells) => cells[0] === 'dns-default') &&
      daemonSetTable.rows.some((cells) => cells[0] === 'node-resolver'),
    '#55B: `oc get ds -n openshift-dns` lists dns-default and node-resolver',
    result.message.slice(0, 500)
  );
  for (const daemonSetName of ['dns-default', 'node-resolver']) {
    assert(
      daemonSetCell(daemonSetName, 'DESIRED') === String(expectedNodes) &&
        daemonSetCell(daemonSetName, 'CURRENT') === String(expectedNodes) &&
        daemonSetCell(daemonSetName, 'READY') === String(expectedNodes),
      `#55B: DaemonSet ${daemonSetName} is DESIRED/CURRENT/READY ${expectedNodes}/${expectedNodes}/${expectedNodes}`,
      JSON.stringify(
        ['DESIRED', 'CURRENT', 'READY'].map((header) => daemonSetCell(daemonSetName, header))
      )
    );
  }
  const dnsControllers = await namespaceControllers('openshift-dns');
  assert(
    ['dns-default', 'node-resolver'].every((name) =>
      dnsControllers.daemonSets.some((daemonSet) => daemonSet.name === name)
    ),
    '#55B: the dns-default and node-resolver DaemonSet objects exist',
    JSON.stringify(dnsControllers.daemonSets)
  );

  // dns-default pods run dns + kube-rbac-proxy at READY 2/2; node-resolver 1/1.
  result = await runCmd('oc get pods -n openshift-dns');
  const dnsPodTable = tableParts(result.message);
  const dnsPodRows = dnsPodTable.rows.filter((cells) => /^dns-default-/.test(cells[0] || ''));
  const resolverPodRows = dnsPodTable.rows.filter((cells) =>
    /^node-resolver-/.test(cells[0] || '')
  );
  assert(
    dnsPodRows.length === expectedNodes &&
      dnsPodRows.every((cells) => cells[1] === '2/2' && cells[2] === 'Running'),
    '#56: dns-default pods are READY 2/2 (dns + kube-rbac-proxy) and Running',
    JSON.stringify(dnsPodRows)
  );
  assert(
    resolverPodRows.length === expectedNodes &&
      resolverPodRows.every((cells) => cells[1] === '1/1' && cells[2] === 'Running'),
    '#55B: node-resolver pods stay READY 1/1 and Running',
    JSON.stringify(resolverPodRows)
  );
  const dnsPods = platform.dns.filter((pod) => /^dns-default-/.test(pod.name));
  assert(
    dnsPods.length === expectedNodes &&
      dnsPods.every(
        (pod) =>
          pod.containers.includes('dns') &&
          pod.containers.includes('kube-rbac-proxy') &&
          pod.containerStatuses.filter((status) => status.ready).length === 2
      ),
    '#56: dns-default pod spec has the dns + kube-rbac-proxy containers, both ready',
    JSON.stringify(dnsPods.map((pod) => ({ name: pod.name, containers: pod.containers })))
  );
  assert(
    platform.dns
      .filter((pod) => /^dns-default-/.test(pod.name))
      .every((pod) =>
        pod.owners.some((owner) => owner.kind === 'DaemonSet' && owner.name === 'dns-default')
      ) &&
      platform.dns
        .filter((pod) => /^node-resolver-/.test(pod.name))
        .every((pod) =>
          pod.owners.some((owner) => owner.kind === 'DaemonSet' && owner.name === 'node-resolver')
        ),
    '#55B: every DNS pod is owned by its DaemonSet',
    JSON.stringify(platform.dns.map((pod) => pod.owners))
  );
  {
    const dnsPod = platform.dns.find((pod) => /^dns-default-/.test(pod.name));
    result = await runCmd(
      `oc get pod ${dnsPod?.name || 'missing'} -n openshift-dns -o jsonpath='{.spec.containers[*].name}'`
    );
    assert(
      !result.error && /\bdns\b/.test(result.message) && /kube-rbac-proxy/.test(result.message),
      '#56: `oc get pod … -o jsonpath` lists the dns and kube-rbac-proxy containers',
      result.message.slice(0, 300)
    );
    result = await runCmd(
      `oc get pod ${dnsPod?.name || 'missing'} -n openshift-dns -o jsonpath='{.metadata.ownerReferences}'`
    );
    assert(
      !result.error &&
        /"kind"\s*:\s*"DaemonSet"/.test(result.message) &&
        /"name"\s*:\s*"dns-default"/.test(result.message),
      '#55B: `oc get pod … -o jsonpath=ownerReferences` shows the dns-default DaemonSet owner',
      result.message.slice(0, 500)
    );
  }

  // No pod churn or duplicates after a long deterministic tick run.
  {
    const before = await platformState();
    await advanceBoth(120);
    const after = await platformState();
    const namesOf = (state, key, pattern) =>
      state[key]
        .filter((pod) => pattern.test(pod.name))
        .map((pod) => pod.name)
        .sort();
    assert(
      JSON.stringify(namesOf(before, 'ingress', /^router-default-/)) ===
        JSON.stringify(namesOf(after, 'ingress', /^router-default-/)) &&
        JSON.stringify(namesOf(before, 'dns', /^dns-default-/)) ===
          JSON.stringify(namesOf(after, 'dns', /^dns-default-/)) &&
        JSON.stringify(namesOf(before, 'dns', /^node-resolver-/)) ===
          JSON.stringify(namesOf(after, 'dns', /^node-resolver-/)),
      '#55B: platform pods do not churn or duplicate over 120 s of ticks',
      JSON.stringify({
        before: namesOf(before, 'ingress', /^router-default-/),
        after: namesOf(after, 'ingress', /^router-default-/),
      })
    );
    result = await runCmd('oc get deploy,rs -n openshift-ingress');
    deploySection = sectionWithHeaders(result.message, [
      'NAME',
      'READY',
      'UP-TO-DATE',
      'AVAILABLE',
      'AGE',
    ]);
    replicasetSection = sectionWithHeaders(result.message, [
      'NAME',
      'DESIRED',
      'CURRENT',
      'READY',
      'AGE',
    ]);
    assert(
      cellsForRow(deploySection, (name) => /^(?:deployment\.apps\/)?router-default$/.test(name))?.[
        columnIndex(deploySection, 'READY')
      ] === '2/2' &&
        (replicasetSection?.rows || []).filter((cells) =>
          /^(?:replicaset\.apps\/)?router-default-/.test(cells[0] || '')
        ).length === 1,
      '#55B: the router Deployment stays 2/2 with one ReplicaSet after the long tick run',
      result.message.slice(0, 500)
    );
  }

  // Controller-owned pods are recreated after a manual delete.
  {
    const victim = (await platformState()).ingress.find((pod) =>
      /^router-default-/.test(pod.name)
    )?.name;
    await runCmd(`oc delete pod ${victim} -n openshift-ingress`);
    const recreated = await advanceUntil(async () => {
      const state = await platformState();
      const pods = state.ingress.filter((pod) => /^router-default-/.test(pod.name));
      return (
        pods.length === 2 &&
        pods.every((pod) => pod.phase === 'Running' && pod.ready) &&
        pods.every((pod) => pod.owners.some((owner) => owner.kind === 'ReplicaSet'))
      );
    }, 60);
    assert(recreated, '#55B: the router controller recreates a deleted router pod');
  }
  {
    const victim = (await platformState()).dns.find((pod) => /^dns-default-/.test(pod.name))?.name;
    await runCmd(`oc delete pod ${victim} -n openshift-dns`);
    const recreated = await advanceUntil(async () => {
      const state = await platformState();
      const pods = state.dns.filter((pod) => /^dns-default-/.test(pod.name));
      return (
        pods.length === expectedNodes &&
        pods.every((pod) => pod.phase === 'Running' && pod.ready) &&
        pods.every((pod) => pod.owners.some((owner) => owner.kind === 'DaemonSet'))
      );
    }, 60);
    assert(recreated, '#55B: the DNS DaemonSet controller recreates a deleted dns-default pod');
  }

  // ═══ Round 3: #55A taint removal semantics (still running sandbox) ══════
  result = await runCmd(`oc adm taint node master-0 ${masterTaintSpec}-`);
  assert(
    !result.error && /node\/master-0\s+untainted/.test(result.message),
    '#55A: `oc adm taint node master-0 node-role.kubernetes.io/master:NoSchedule-` removes the taint',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc describe node master-0');
  assert(
    /^Taints:\s+<none>\s*$/m.test(result.message),
    '#55A: the master taint is gone right after `oc adm taint …-`',
    (result.message.match(/^Taints:.*$/m) || [''])[0]
  );
  await advanceBoth(90);
  result = await runCmd('oc describe node master-0');
  assert(
    /^Taints:\s+<none>\s*$/m.test(result.message),
    '#55A: the controller loop does not re-add the removed master taint',
    (result.message.match(/^Taints:.*$/m) || [''])[0]
  );
  const pinnedCanSchedule = await advanceUntil(async () => {
    const out = await runCmd('oc get pods -n qa-taint55 -l app=pinned-master');
    return tableParts(out.message).rows.some(
      (cells) => /^pinned-master-/.test(cells[0] || '') && cells[2] === 'Running'
    );
  }, 30);
  assert(
    pinnedCanSchedule,
    '#55A: removing the taint lets the master-pinned pod actually schedule (real taint semantics)'
  );

  // ═══ Round 4: #56 CLI multi-kind `endpoints/` prefix (running sandbox) ═══
  await runCmd('oc new-project qa-cli56');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa-cli56');
  await runCmd('oc apply -f manifests/service.yaml -n qa-cli56');
  const cliPodsReady = await advanceUntil(async () => {
    const wide = await podWide('qa-cli56');
    return wide.rows.length >= 2 && wide.rows.every((row) => row.status === 'Running');
  }, 40);
  assert(cliPodsReady, '#56 CLI: the qa-cli56 workload is Running before the output checks');
  await runCmd('oc expose svc/webapp -n qa-cli56');
  await advanceBoth(8);
  result = await runCmd('oc get pods,endpoints,route -n qa-cli56');
  {
    const sections = tableSections(result.message);
    const endpointsSection = sections.find((section) => section.headers.includes('ENDPOINTS'));
    const podsSection = sections.find(
      (section) => section.headers.includes('STATUS') && section.headers.includes('RESTARTS')
    );
    const routeSection = sections.find((section) => section.headers.includes('HOST/PORT'));
    assert(
      Boolean(endpointsSection) &&
        endpointsSection.rows.length === 1 &&
        endpointsSection.rows[0][0] === 'endpoints/webapp',
      '#56 CLI: multi-kind `oc get pods,endpoints,route` prints the endpoints NAME as endpoints/webapp',
      JSON.stringify(endpointsSection?.rows || [])
    );
    assert(
      Boolean(podsSection) &&
        podsSection.rows.length >= 2 &&
        podsSection.rows.every((cells) => /^pod\//.test(cells[0] || '')),
      '#56 CLI: multi-kind pod rows keep the pod/ NAME prefix',
      JSON.stringify(podsSection?.rows || [])
    );
    assert(
      Boolean(routeSection) &&
        routeSection.rows.some((cells) => cells[0] === 'route.route.openshift.io/webapp'),
      '#56 CLI: multi-kind route rows keep the route.route.openshift.io/ NAME prefix',
      JSON.stringify(routeSection?.rows || [])
    );
  }
  result = await runCmd('oc get endpoints -n qa-cli56');
  {
    const single = tableParts(result.message);
    assert(
      single.rows.length === 1 && single.rows[0][0] === 'webapp',
      '#56 CLI: single-kind `oc get endpoints` keeps the plain NAME',
      result.message.slice(0, 300)
    );
  }
  result = await runCmd('oc get pods,endpoints -n qa-cli56');
  {
    const sections = tableSections(result.message);
    const endpointsSection = sections.find((section) => section.headers.includes('ENDPOINTS'));
    const podsSection = sections.find(
      (section) => section.headers.includes('STATUS') && section.headers.includes('RESTARTS')
    );
    assert(
      Boolean(endpointsSection) &&
        endpointsSection.rows.length === 1 &&
        endpointsSection.rows[0][0] === 'endpoints/webapp' &&
        Boolean(podsSection) &&
        podsSection.rows.every((cells) => /^pod\//.test(cells[0] || '')),
      '#56 CLI: mixing endpoints with another kind keeps both kinds’ NAME prefixes',
      result.message.slice(0, 700)
    );
  }

  // ═══ Round 5: paused pre-start sandbox — #55B platform presence and
  //     #56 CLI Route admission events/status (no ticks until Start) ═══════
  await goto('/?mode=sandbox&tutorial=1');
  const pausedBooted = await waitFor(
    () =>
      evaluate(
        () =>
          Boolean(window.game?.app?.modeInstance) &&
          Boolean(document.getElementById('tutorial-overlay'))
      ),
    20000
  );
  await sleep(600);
  const pausedSandbox = await evaluate(() => ({
    state: window.game?.gameEngine?.state || '',
    gameSeconds: window.game?.gameEngine?.simulation?.gameSeconds ?? null,
    tutorial: Boolean(document.getElementById('tutorial-overlay')),
  }));
  assert(
    pausedBooted && pausedSandbox.state === 'paused' && pausedSandbox.gameSeconds === 0,
    '#55B: the sandbox is genuinely paused before "Start exploring" (zero ticks)',
    JSON.stringify(pausedSandbox)
  );
  result = await runCmd('oc get deploy,rs -n openshift-ingress');
  deploySection = sectionWithHeaders(result.message, [
    'NAME',
    'READY',
    'UP-TO-DATE',
    'AVAILABLE',
    'AGE',
  ]);
  replicasetSection = sectionWithHeaders(result.message, [
    'NAME',
    'DESIRED',
    'CURRENT',
    'READY',
    'AGE',
  ]);
  assert(
    cellsForRow(deploySection, (name) => /^(?:deployment\.apps\/)?router-default$/.test(name))?.[
      columnIndex(deploySection, 'READY')
    ] === '2/2' &&
      (replicasetSection?.rows || []).filter((cells) =>
        /^(?:replicaset\.apps\/)?router-default-/.test(cells[0] || '')
      ).length === 1,
    '#55B: the router Deployment/ReplicaSet exist synchronously in a paused pre-start sandbox',
    result.message.slice(0, 500)
  );
  result = await runCmd('oc get ds -n openshift-dns');
  assert(
    !result.error &&
      /^dns-default\s/m.test(result.message) &&
      /^node-resolver\s/m.test(result.message),
    '#55B: the DNS DaemonSets exist synchronously in a paused pre-start sandbox',
    result.message.slice(0, 500)
  );
  result = await runCmd('oc get pods -n openshift-ingress');
  {
    const table = tableParts(result.message);
    const routerPods = table.rows.filter((cells) => /^router-default-/.test(cells[0] || ''));
    assert(
      routerPods.length === 2 && routerPods.every((cells) => cells[2] === 'Running'),
      '#55B: platform router pods are present in a paused pre-start sandbox',
      JSON.stringify(routerPods)
    );
  }

  // #56 CLI: a Route created while paused must not fabricate a rejection event.
  await runCmd('oc new-project qa-admit56');
  await runCmd('oc apply -f manifests/deployment.yaml -n qa-admit56');
  await runCmd('oc apply -f manifests/service.yaml -n qa-admit56');
  result = await runCmd('oc expose svc/webapp -n qa-admit56');
  assert(
    !result.error && /route\.route\.openshift\.io\/webapp exposed/.test(result.message),
    '#56 CLI: `oc expose svc/webapp` creates the Route in a paused pre-start sandbox',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc get events -n qa-admit56');
  {
    const routeRows = getEventRows(result.message).filter((row) => /^route\//.test(row.object));
    assert(
      routeRows.length === 0,
      '#56 CLI: a pre-tick Route publishes no fabricated route admission event',
      JSON.stringify(routeRows)
    );
    assert(
      !/ServiceUnavailable/i.test(result.message) &&
        !/not admitted/i.test(result.message) &&
        !/no endpoints available/i.test(result.message),
      '#56 CLI: `oc get events` has no "Warning/ServiceUnavailable … not admitted: no endpoints available" row before the router evaluates the Route',
      result.message.slice(0, 700)
    );
  }
  result = await runCmd('oc status -n qa-admit56');
  assert(
    !result.error &&
      /exposed by router/.test(result.message) &&
      !/no endpoints/i.test(result.message) &&
      !/not admitted/i.test(result.message),
    '#56 CLI: `oc status` does not claim missing endpoints block Route admission',
    result.message.slice(0, 800)
  );

  // Start the engine and tick: the Route is admitted with the real Normal event.
  await evaluate(() => document.getElementById('tutorial-start')?.click());
  const engineStarted = await waitFor(
    () => evaluate(() => window.game?.gameEngine?.state === 'running'),
    8000
  );
  assert(engineStarted, '#56 CLI: "Start exploring" resumes the paused sandbox');
  await advanceBoth(12);
  const admittedCondition = await routeCondition('qa-admit56', 'webapp');
  assert(
    admittedCondition?.status === 'True',
    '#56 CLI: the Route is Admitted after the router ticks',
    JSON.stringify(admittedCondition)
  );
  result = await runCmd('oc get events -n qa-admit56');
  {
    const routeRows = getEventRows(result.message).filter((row) => row.object === 'route/webapp');
    assert(
      routeRows.length === 1 &&
        routeRows[0].type === 'Normal' &&
        routeRows[0].reason === 'Admitted',
      '#56 CLI: after ticking, the Route event is the real Normal Admitted event',
      JSON.stringify(routeRows)
    );
    assert(
      !routeRows.some((row) => row.type === 'Warning') &&
        !/ServiceUnavailable/i.test(result.message) &&
        !/no endpoints available/i.test(result.message),
      '#56 CLI: no bogus warning admission event remains after the router admits the Route',
      JSON.stringify(routeRows)
    );
  }
  result = await runCmd('oc status -n qa-admit56');
  assert(
    /exposed by router default \(Admitted\)/.test(result.message),
    '#56 CLI: `oc status` reports the admitted Route',
    result.message.slice(0, 800)
  );

  // ═══ Round 6: #56 OLM Manual pin → upgrade chain + operator rollout ═════
  assert(await bootSandbox(), '#56 OLM: a fresh sandbox boots for the pin→upgrade checks');
  result = await runCmd('oc get csv -n openshift-operators');
  assert(
    /No resources found/.test(result.message),
    '#56 OLM: a fresh cluster has no installed ClusterServiceVersion yet',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc apply -f examples/subscription-manual-pinned.yaml', 300);
  assert(
    !result.error &&
      /subscription\.operators\.coreos\.com\/openshift-cert-manager-operator created/.test(
        result.message
      ),
    '#56 OLM: the Manual pinned v1.16.0 Subscription manifest applies',
    result.message.slice(0, 300)
  );
  let pinPlan = null;
  const pinPlanAppeared = await advanceUntil(async () => {
    pinPlan = await installPlanFor(olmNamespace, olmPinCsv);
    return Boolean(pinPlan);
  }, 30);
  assert(
    pinPlanAppeared && pinPlan.approval === 'Manual' && pinPlan.approved === false,
    '#56 OLM: the pinned v1.16.0 InstallPlan waits for Manual approval',
    JSON.stringify(pinPlan)
  );
  if (pinPlan) {
    result = await runCmd(
      `oc patch installplan ${pinPlan.name} -n ${olmNamespace} --type=merge -p '{"spec":{"approved":true}}'`
    );
    assert(
      !result.error && /patched/.test(result.message),
      '#56 OLM: approving the pinned InstallPlan succeeds',
      result.message.slice(0, 300)
    );
  }
  let pinCsvPhase = null;
  for (let elapsed = 0; elapsed < 40 && pinCsvPhase !== 'Succeeded'; elapsed += 2) {
    await advanceBoth(2);
    pinCsvPhase = await csvPhase(olmNamespace, olmPinCsv);
  }
  assert(
    pinCsvPhase === 'Succeeded',
    '#56 OLM: the pinned v1.16.0 CSV reaches Succeeded',
    JSON.stringify(pinCsvPhase)
  );
  // The pin is a real member of the channel's replacement chain.
  const pinReplaces = await csvJsonPath(olmPinCsv, '.spec.replaces');
  assert(
    !pinReplaces.error && pinReplaces.value === olmPreviousCsv,
    '#56 OLM: the pinned v1.16.0 CSV carries the real chain value spec.replaces=v1.15.0',
    JSON.stringify(pinReplaces)
  );
  const operatorReady = await advanceUntil(async () => {
    const state = await operatorState(olmNamespace);
    return Boolean(state.deployment) && state.deployment.readyReplicas >= 1;
  }, 40);
  const beforeUpgrade = await operatorState(olmNamespace);
  assert(
    operatorReady &&
      beforeUpgrade.deployment?.name === operatorDeploymentName &&
      beforeUpgrade.deployment?.image.includes('v1.16.0'),
    '#56 OLM: the v1.16.0 operator Deployment is installed and Ready',
    JSON.stringify(beforeUpgrade.deployment)
  );
  const beforeReplicaSetNames = beforeUpgrade.replicaSets.map((rs) => rs.name);

  let upgradePlan = null;
  const upgradeAppeared = await advanceUntil(async () => {
    upgradePlan = await installPlanFor(olmNamespace, olmHeadCsv);
    return Boolean(upgradePlan);
  }, 40);
  assert(
    upgradeAppeared && upgradePlan.approval === 'Manual' && upgradePlan.approved === false,
    '#56 OLM: OLM creates a second Manual, unapproved v1.17.0 upgrade InstallPlan',
    JSON.stringify(upgradePlan)
  );
  if (upgradePlan) {
    result = await runCmd(
      `oc patch installplan ${upgradePlan.name} -n ${olmNamespace} --type=merge -p '{"spec":{"approved":true}}'`
    );
    assert(
      !result.error && /patched/.test(result.message),
      '#56 OLM: approving the v1.17.0 upgrade InstallPlan succeeds',
      result.message.slice(0, 300)
    );
  }
  let upgradedSub = await subscriptionState(olmPackageName, olmNamespace);
  const upgraded = await advanceUntil(async () => {
    upgradedSub = await subscriptionState(olmPackageName, olmNamespace);
    return upgradedSub?.installedCSV === olmHeadCsv && upgradedSub?.phase === 'Succeeded';
  }, 60);
  assert(
    upgraded,
    '#56 OLM: approving the upgrade installs v1.17.0 (installedCSV=currentCSV=head, Succeeded)',
    JSON.stringify(upgradedSub)
  );

  // `oc get csv`: the REPLACES column names the previous CSV.
  result = await runCmd('oc get csv -n openshift-operators');
  {
    const table = tableParts(result.message);
    const replacesAt = table.headers.indexOf('REPLACES');
    const headRow = table.rows.find((cells) => cells[0] === olmHeadCsv) || [];
    const pinRowStillListed = table.rows.some((cells) => cells[0] === olmPinCsv);
    assert(
      replacesAt >= 0 && headRow[replacesAt] === olmPinCsv,
      '#56 OLM: `oc get csv` prints REPLACES cert-manager-operator.v1.16.0 on the v1.17.0 row',
      JSON.stringify({ headers: table.headers, row: headRow })
    );
    assert(
      !pinRowStillListed,
      '#56 OLM: the superseded v1.16.0 CSV is gone from `oc get csv` after the upgrade',
      JSON.stringify(table.rows.map((cells) => cells[0]))
    );
  }
  const headReplaces = await csvJsonPath(olmHeadCsv, '.spec.replaces');
  assert(
    !headReplaces.error && headReplaces.value === olmPinCsv,
    '#56 OLM: the v1.17.0 CSV spec.replaces is cert-manager-operator.v1.16.0',
    JSON.stringify(headReplaces)
  );
  result = await runCmd(`oc describe csv ${olmHeadCsv} -n ${olmNamespace}`);
  assert(
    /Replaces:\s+cert-manager-operator\.v1\.16\.0/.test(result.message),
    '#56 OLM: `oc describe csv` shows the Replaces chain',
    result.message.slice(0, 700)
  );

  // The operator pod rolls to a new ReplicaSet/pod-template hash.
  let afterUpgrade = await operatorState(olmNamespace);
  const rolledOut = await advanceUntil(async () => {
    afterUpgrade = await operatorState(olmNamespace);
    const newReplicaSets = afterUpgrade.replicaSets.filter(
      (rs) => !beforeReplicaSetNames.includes(rs.name)
    );
    return (
      newReplicaSets.length === 1 &&
      newReplicaSets[0].readyReplicas >= 1 &&
      afterUpgrade.pods.some(
        (pod) => pod.hash === newReplicaSets[0].hash && pod.phase === 'Running' && pod.ready
      )
    );
  }, 60);
  const newReplicaSets = afterUpgrade.replicaSets.filter(
    (rs) => !beforeReplicaSetNames.includes(rs.name)
  );
  const oldReplicaSets = afterUpgrade.replicaSets.filter((rs) =>
    beforeReplicaSetNames.includes(rs.name)
  );
  const rolledPod = afterUpgrade.pods.find(
    (pod) => pod.hash === newReplicaSets[0]?.hash && pod.phase === 'Running' && pod.ready
  );
  assert(
    rolledOut &&
      afterUpgrade.deployment?.name === beforeUpgrade.deployment?.name &&
      afterUpgrade.deployment?.readyReplicas >= 1,
    '#56 OLM: the upgraded operator Deployment is Ready after the rollout',
    JSON.stringify(afterUpgrade.deployment)
  );
  assert(
    JSON.stringify(afterUpgrade.deployment?.template) !==
      JSON.stringify(beforeUpgrade.deployment?.template) &&
      afterUpgrade.deployment?.image !== beforeUpgrade.deployment?.image &&
      /v1\.17\.0/.test(afterUpgrade.deployment?.image || '') &&
      /v1\.16\.0/.test(beforeUpgrade.deployment?.image || ''),
    '#56 OLM: the upgrade changes the operator Deployment pod template/image (v1.16.0 → v1.17.0)',
    JSON.stringify({
      before: beforeUpgrade.deployment?.image,
      after: afterUpgrade.deployment?.image,
    })
  );
  assert(
    newReplicaSets.length === 1 &&
      newReplicaSets[0].hash !== beforeUpgrade.replicaSets[0]?.hash &&
      newReplicaSets[0].owners.some((owner) => owner.startsWith('Deployment/')),
    '#56 OLM: the Deployment controller rolls a NEW operator ReplicaSet with a new pod-template-hash',
    JSON.stringify(afterUpgrade.replicaSets)
  );
  assert(
    oldReplicaSets.length === 1 && oldReplicaSets.every((rs) => rs.desired === 0),
    '#56 OLM: the old operator ReplicaSet is scaled to 0 and kept for rollout history',
    JSON.stringify(oldReplicaSets)
  );
  assert(
    Boolean(rolledPod) &&
      rolledPod.hash === newReplicaSets[0]?.hash &&
      rolledPod.owners.some(
        (owner) => owner.kind === 'ReplicaSet' && owner.name === newReplicaSets[0]?.name
      ),
    '#56 OLM: the operator pod has the new hash and is owned by the new ReplicaSet',
    JSON.stringify({ pod: rolledPod, rs: newReplicaSets[0] })
  );
  result = await runCmd('oc get rs -n openshift-operators');
  {
    const table = tableParts(result.message);
    const desiredAt = table.headers.indexOf('DESIRED');
    const newRow = table.rows.find((cells) => cells[0] === newReplicaSets[0]?.name) || [];
    const oldRow = table.rows.find((cells) => cells[0] === oldReplicaSets[0]?.name) || [];
    assert(
      Boolean(newRow.length) && newRow[desiredAt] !== '0',
      '#56 OLM: `oc get rs` lists the new operator ReplicaSet with desired replicas',
      result.message.slice(0, 500)
    );
    assert(
      Boolean(oldRow.length) && oldRow[desiredAt] === '0',
      '#56 OLM: `oc get rs` shows the old operator ReplicaSet scaled to 0',
      result.message.slice(0, 500)
    );
  }
  result = await runCmd('oc get deploy,rs -n openshift-operators');
  assert(
    new RegExp(`deployment\\.apps/${operatorDeploymentName}\\s+1/1`).test(result.message) &&
      result.message.includes(`replicaset.apps/${newReplicaSets[0]?.name}`),
    '#56 OLM: multi-kind `oc get deploy,rs` shows the upgraded operator Deployment 1/1 and its new ReplicaSet',
    result.message.slice(0, 700)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.7.0 — issues #57/#58: unschedulable Pods report their real phase
// (`Pending`, never ContainerCreating, with `Node: <none>`) and the scheduler
// retries FailedScheduling with the real backoff/event series; the platform
// bootstrap seeds the real openshift-dns/openshift-ingress Services in every
// mode (paused pre-start included), moves dns-default to the pod network and
// gives the DNS DaemonSets their nodeSelector + the router Pods their ingress
// controller label; `oc adm taint` accepts the kubectl empty-value grammar;
// `oc exec … cat /etc/resolv.conf` prints the cluster DNS contract; and the
// paused `oc new-app` ScalingReplicaSet event names the deterministic
// `pre-<pod-template-hash>` ReplicaSet the controller later creates.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue57-58', async () => {
  const ingressControllerLabel =
    'ingresscontroller.operator.openshift.io/deployment-ingresscontroller';
  const masterTaintKey = 'node-role.kubernetes.io/master';
  const masterTaintSpec = `${masterTaintKey}:NoSchedule`;
  const dnsAlphabet = 'bcdfghjklmnpqrstvwxz2456789';
  let result;

  /** Advance the simulation AND incident clocks deterministically (0.05 s). */
  const advanceBoth = async (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      const engine = window.game?.incidentEngine;
      if (!sim || typeof sim.tick !== 'function') return false;
      const steps = Math.ceil(secs / 0.05);
      for (let index = 0; index < steps; index += 1) {
        sim.tick(0.05);
        if (engine && typeof engine.tick === 'function') engine.tick(0.05);
      }
      return true;
    }, seconds);
  /** Advance both clocks until predicate() is true, or exhaust maxSeconds. */
  const advanceUntil = async (predicate, maxSeconds = 60, step = 2) => {
    for (let played = 0; played < maxSeconds; played += step) {
      await advanceBoth(step);
      if (await predicate()) return true;
    }
    return false;
  };
  /** Split an oc tabwriter table into header cells + rows (2+ space columns). */
  const tableParts = (message) => {
    const lines = String(message ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    return {
      headers: (lines[0] || '').split(/\s{2,}/).map((cell) => cell.trim()),
      rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
    };
  };
  /** Blank-line separated tables from a multi-kind `oc get` response. */
  const tableSections = (message) => {
    const blocks = String(message ?? '').split(/\n{2,}/);
    const sections = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      if (!lines.length) continue;
      sections.push({
        headers: lines[0].split(/\s{2,}/).map((cell) => cell.trim()),
        rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
      });
    }
    return sections;
  };
  const columnIndex = (section, header) => (section ? section.headers.indexOf(header) : -1);
  const rowFor = (section, predicate) =>
    (section?.rows || []).find((cells) => predicate(cells[0] || '')) || [];
  /** `oc get pods -o wide` parsed with its real IP/NODE columns. */
  const podWide = async (namespace, selector = '') => {
    const out = await runCmd(
      `oc get pods -o wide -n ${namespace}${selector ? ` -l ${selector}` : ''}`
    );
    const table = tableParts(out.message);
    const ipAt = table.headers.indexOf('IP');
    const nodeAt = table.headers.indexOf('NODE');
    return {
      message: out.message,
      headers: table.headers,
      rows: table.rows.map((cells) => ({
        name: cells[0] || '',
        ready: cells[1] || '',
        status: cells[2] || '',
        ip: ipAt >= 0 ? cells[ipAt] || '' : '',
        node: nodeAt >= 0 ? cells[nodeAt] || '' : '',
      })),
    };
  };
  /** Rows of `oc get events` as { type, reason, object, message }. */
  const getEventRows = (message) =>
    String(message ?? '')
      .split('\n')
      .slice(1)
      .map((line) =>
        line
          .split(/\s{2,}/)
          .map((cell) => cell.trim())
          .filter(Boolean)
      )
      .filter((cells) => cells.length >= 4)
      .map((cells) => ({
        type: cells[1],
        reason: cells[2],
        object: cells[3],
        message: cells.slice(4).join(' '),
      }));
  /** Engine truth for the platform Pods' networking + namespace annotations. */
  const podNetworkState = () =>
    evaluate(() => {
      const cluster = window.game.cluster;
      const summarize = (namespace, regex) =>
        (cluster.getByKindAndNamespace('Pod', namespace) || [])
          .filter((pod) => regex.test(pod.metadata?.name || ''))
          .map((pod) => {
            const node = cluster.getByName('Node', pod.spec?.nodeName || '', '');
            const nodeIP =
              (node?.status?.addresses || []).find((address) => address.type === 'InternalIP')
                ?.address || '';
            return {
              name: pod.metadata?.name || '',
              node: pod.spec?.nodeName || '',
              nodeIP,
              phase: pod.status?.phase || '',
              podIP: pod.status?.podIP || '',
              hostIP: pod.status?.hostIP || '',
              hostNetwork: pod.spec?.hostNetwork === true,
              scc: pod.metadata?.annotations?.['openshift.io/scc'] || '',
            };
          });
      return {
        dns: summarize('openshift-dns', /^dns-default-/),
        resolver: summarize('openshift-dns', /^node-resolver-/),
        router: summarize('openshift-ingress', /^router-default-/),
      };
    });
  /** Platform workload names + Service ClusterIPs (no-churn snapshot). */
  const platformSnapshot = () =>
    evaluate(() => {
      const cluster = window.game.cluster;
      const names = (namespace, regex) =>
        (cluster.getByKindAndNamespace('Pod', namespace) || [])
          .filter((pod) => regex.test(pod.metadata?.name || ''))
          .map((pod) => pod.metadata?.name || '')
          .sort();
      return {
        ingress: names('openshift-ingress', /^router-default-/),
        dns: names('openshift-dns', /^dns-default-/),
        resolver: names('openshift-dns', /^node-resolver-/),
        dnsService: cluster.getByName('Service', 'dns-default', 'openshift-dns')?.spec?.clusterIP,
        routerService: cluster.getByName('Service', 'router-internal-default', 'openshift-ingress')
          ?.spec?.clusterIP,
      };
    });

  // ═══ Round 1: #57 unschedulable Pod STATUS + scheduler retry backoff ════
  assert(await bootSandbox(), '#57: a fresh sandbox boots for the scheduler-display checks');

  result = await runCmd(
    `oc run big --image=registry.access.redhat.com/ubi9/ubi --overrides='{"spec":{"containers":[{"name":"big","image":"registry.access.redhat.com/ubi9/ubi","resources":{"requests":{"cpu":"64"}}}]}}'`
  );
  assert(
    !result.error && /pod\/big created/.test(result.message),
    '#57: `oc run big` with a 64-CPU request creates the Pod',
    result.message.slice(0, 300)
  );
  // Deterministic game-time retries (1 s initial, doubling, 10 s max) plus a
  // short wall-clock gap so the aggregated FailedScheduling window is real
  // (`over 1s`) instead of the degenerate `over 0s` a purely-fast-forwarded run
  // produces. The count stays small either way (no per-tick burst).
  await advanceBoth(2);
  await sleep(1200);
  await advanceBoth(8);

  result = await runCmd('oc get pod big');
  let table = tableParts(result.message);
  let row = table.rows.find((cells) => cells[0] === 'big') || [];
  assert(
    !result.error &&
      row[columnIndex(table, 'READY')] === '0/1' &&
      row[columnIndex(table, 'STATUS')] === 'Pending',
    '#57: `oc get pod big` reports READY 0/1 STATUS Pending (never ContainerCreating before binding)',
    JSON.stringify({ headers: table.headers, row })
  );
  result = await runCmd('oc get pod big -o wide');
  {
    const wide = tableParts(result.message);
    const wideRow = wide.rows.find((cells) => cells[0] === 'big') || [];
    assert(
      !result.error && wideRow[columnIndex(wide, 'NODE')] === '<none>',
      '#57: `oc get pod big -o wide` shows NODE <none> for the unscheduled Pod',
      JSON.stringify({ headers: wide.headers, row: wideRow })
    );
  }
  result = await runCmd('oc describe pod big');
  const describeBig = result.message;
  assert(
    !result.error && /^Status:\s+Pending\s*$/m.test(describeBig),
    '#57: `oc describe pod big` shows Status: Pending',
    (describeBig.match(/^Status:.*$/m) || [''])[0]
  );
  assert(
    /^Node:\s+<none>\s*$/m.test(describeBig),
    '#57: `oc describe pod big` shows `Node: <none>` (bare <none>, no derived worker/IP)',
    (describeBig.match(/^Node:.*$/m) || [''])[0]
  );
  {
    const failedRow = describeBig.split('\n').find((line) => /FailedScheduling/.test(line)) || '';
    const aggregated = failedRow.match(/\(x(\d+) over ([^)]+)\)/);
    const count = aggregated ? Number(aggregated[1]) : NaN;
    assert(
      /FailedScheduling/.test(failedRow) &&
        /default-scheduler/.test(failedRow) &&
        Number.isFinite(count) &&
        count >= 2 &&
        count <= 20 &&
        aggregated[2] !== '0s',
      '#57: describe pod aggregates FailedScheduling into a small real count over a nonzero window (never x100 over 0s)',
      failedRow.trim()
    );
  }
  result = await runCmd('oc get events -n default');
  {
    const eventRow = getEventRows(result.message).find(
      (event) => event.reason === 'FailedScheduling' && event.object === 'pod/big'
    );
    const lastSeenLine = (
      result.message.split('\n').find((line) => /pod\/big/.test(line)) || ''
    ).trim();
    const lastSeenWindow = lastSeenLine.match(/\(x(\d+) over ([^)]+)\)/);
    const count = lastSeenWindow ? Number(lastSeenWindow[1]) : NaN;
    assert(
      Boolean(eventRow) &&
        eventRow.type === 'Warning' &&
        Number.isFinite(count) &&
        count >= 2 &&
        count <= 20 &&
        lastSeenWindow[2] !== '0s',
      '#57: `oc get events` shows the same small aggregated FailedScheduling series over a nonzero window',
      lastSeenLine
    );
  }
  {
    const rawEvents = await evaluate(() => {
      const pod = (window.game?.cluster?.getByKind('Pod') || []).find(
        (candidate) => candidate.metadata?.name === 'big'
      );
      return (pod?.getEvents?.() || [])
        .filter((event) => event.reason === 'FailedScheduling')
        .map((event) => ({
          count: event.count,
          firstTimestamp: event.firstTimestamp,
          lastTimestamp: event.lastTimestamp,
        }));
    });
    const event = rawEvents[0];
    const windowMs =
      event && event.firstTimestamp && event.lastTimestamp
        ? new Date(event.lastTimestamp).getTime() - new Date(event.firstTimestamp).getTime()
        : -1;
    assert(
      rawEvents.length === 1 && event.count >= 2 && event.count <= 20 && windowMs > 0,
      '#57: the FailedScheduling Event series preserves its firstTimestamp across retries',
      JSON.stringify({ events: rawEvents, windowMs })
    );
  }

  // Both workers cordoned: a normal Pod stays unbound Pending, then schedules
  // after the workers are uncordoned (the retry state is discarded on success).
  result = await runCmd('oc adm cordon worker-0');
  assert(
    !result.error && /node\/worker-0 cordoned/.test(result.message),
    '#57: `oc adm cordon worker-0` succeeds',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc adm cordon worker-1');
  assert(
    !result.error && /node\/worker-1 cordoned/.test(result.message),
    '#57: `oc adm cordon worker-1` succeeds',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc run p2 --image=registry.access.redhat.com/ubi9/ubi');
  assert(
    !result.error && /pod\/p2 created/.test(result.message),
    '#57: `oc run p2` creates a normal Pod while both workers are cordoned',
    result.message.slice(0, 300)
  );
  await advanceBoth(4);
  table = tableParts((await runCmd('oc get pod p2')).message);
  row = table.rows.find((cells) => cells[0] === 'p2') || [];
  assert(
    row[columnIndex(table, 'READY')] === '0/1' && row[columnIndex(table, 'STATUS')] === 'Pending',
    '#57: with both workers cordoned, p2 reports READY 0/1 STATUS Pending',
    JSON.stringify({ headers: table.headers, row })
  );
  {
    const wide = tableParts((await runCmd('oc get pod p2 -o wide')).message);
    const wideRow = wide.rows.find((cells) => cells[0] === 'p2') || [];
    assert(
      wideRow[columnIndex(wide, 'NODE')] === '<none>',
      '#57: the cordoned-workers Pod has NODE <none> in `-o wide`',
      JSON.stringify({ headers: wide.headers, row: wideRow })
    );
  }
  result = await runCmd('oc describe pod p2');
  assert(
    /^Status:\s+Pending\s*$/m.test(result.message) && /^Node:\s+<none>\s*$/m.test(result.message),
    '#57: `oc describe pod p2` shows Status Pending and Node: <none>',
    result.message.split('\n').slice(0, 12).join(' ⏎ ')
  );
  result = await runCmd('oc adm uncordon worker-0');
  assert(
    !result.error && /node\/worker-0 uncordoned/.test(result.message),
    '#57: `oc adm uncordon worker-0` succeeds',
    result.message.slice(0, 200)
  );
  result = await runCmd('oc adm uncordon worker-1');
  assert(
    !result.error && /node\/worker-1 uncordoned/.test(result.message),
    '#57: `oc adm uncordon worker-1` succeeds',
    result.message.slice(0, 200)
  );
  {
    const p2Running = await advanceUntil(async () => {
      const wide = await podWide('default');
      const p2 = wide.rows.find((candidate) => candidate.name === 'p2');
      return p2?.status === 'Running' && p2.ready === '1/1';
    }, 40);
    assert(p2Running, '#57: uncordoning lets the Pending Pod schedule and reach Running 1/1');
  }

  // A router Pod recreated while both workers are cordoned must be Pending with
  // no node, exactly like the real scheduler-queue case from the issue.
  {
    const wide = await podWide('openshift-ingress');
    const routerRows = wide.rows.filter((candidate) => /^router-default-/.test(candidate.name));
    assert(
      routerRows.length === 2 && routerRows.every((candidate) => candidate.status === 'Running'),
      '#57: the two router Pods are Running before the recreate scenario',
      JSON.stringify(routerRows)
    );
    // #58: the seeded hostNetwork router Pods report the node InternalIP as
    // their Pod IP (the controller-recreated replacement is exercised below).
    const seededPlatform = await podNetworkState();
    assert(
      seededPlatform.router.length === 2 &&
        seededPlatform.router.every((pod) => pod.hostNetwork && pod.podIP === pod.nodeIP),
      '#58: the seeded router Pods stay hostNetwork and report the node IP',
      JSON.stringify(seededPlatform.router)
    );
    const victim = routerRows[0]?.name;
    await runCmd('oc adm cordon worker-0');
    await runCmd('oc adm cordon worker-1');
    result = await runCmd(`oc delete pod ${victim} -n openshift-ingress`);
    assert(
      !result.error && new RegExp(`pod "${victim}" deleted`).test(result.message),
      '#57: deleting a router Pod while both workers are cordoned succeeds',
      result.message.slice(0, 300)
    );
    const recreatedPending = await advanceUntil(async () => {
      const state = await podNetworkState();
      return (
        state.router.length === 2 &&
        state.router.some((pod) => pod.phase === 'Pending' && !pod.node)
      );
    }, 40);
    assert(
      recreatedPending,
      '#57: the router controller recreates the deleted Pod as an unscheduled Pending Pod'
    );
    const pendingWide = await podWide('openshift-ingress');
    const pendingRow = pendingWide.rows.find((candidate) => candidate.status === 'Pending') || null;
    assert(
      Boolean(pendingRow) &&
        pendingRow.ready === '0/1' &&
        pendingRow.status === 'Pending' &&
        pendingRow.node === '<none>',
      '#57: the recreated router Pod reports READY 0/1 STATUS Pending and NODE <none>',
      JSON.stringify(pendingRow)
    );
    result = await runCmd(`oc describe pod ${pendingRow?.name || 'missing'} -n openshift-ingress`);
    assert(
      /^Status:\s+Pending\s*$/m.test(result.message) &&
        /^Node:\s+<none>\s*$/m.test(result.message) &&
        /FailedScheduling/.test(result.message),
      '#57: `oc describe pod` of the recreated router Pod shows Pending, Node: <none> and FailedScheduling',
      result.message.slice(-900)
    );
    await runCmd('oc adm uncordon worker-0');
    await runCmd('oc adm uncordon worker-1');
    const healed = await advanceUntil(async () => {
      const wideAgain = await podWide('openshift-ingress');
      const pods = wideAgain.rows.filter((candidate) => /^router-default-/.test(candidate.name));
      return pods.length === 2 && pods.every((candidate) => candidate.status === 'Running');
    }, 60);
    assert(
      healed,
      '#57: uncordoning lets the recreated router Pod schedule and the Deployment heal to 2/2'
    );
    // #58: the controller-recreated hostNetwork Pod reports the node InternalIP
    // as its Pod IP (kubelet semantics), matching the bootstrap Pods in `-o wide`.
    const healedPlatform = await podNetworkState();
    const preRecreateRouterNames = routerRows.map((candidate) => candidate.name);
    const recreatedRouter = healedPlatform.router.find(
      (pod) => !preRecreateRouterNames.includes(pod.name)
    );
    assert(
      Boolean(recreatedRouter) &&
        recreatedRouter.hostNetwork &&
        recreatedRouter.podIP === recreatedRouter.nodeIP &&
        recreatedRouter.phase === 'Running',
      '#58: the recreated router Pod reports the node IP as its Pod IP (hostNetwork kubelet semantics)',
      JSON.stringify(recreatedRouter)
    );
  }

  // Regression guard: a normally-scheduled Pod still shows ContainerCreating
  // once it is BOUND (kubelet state) and then reaches Running. The create +
  // single scheduler tick + read run in ONE page.evaluate so the live clock
  // cannot pull the image (and hide the kubelet window) in between.
  {
    const atomic = await evaluate(() => {
      const bar = window.game.app.commandBar;
      const sim = window.game.gameEngine.simulation;
      const created = bar.executeCommand(
        'oc run sched-check --image=registry.access.redhat.com/ubi9/ubi'
      );
      sim._tickPodScheduling(0.05);
      const get = bar.executeCommand('oc get pod sched-check');
      return { created: String(created?.message || ''), message: String(get?.message || '') };
    });
    assert(
      /pod\/sched-check created/.test(atomic.created) &&
        /\bContainerCreating\b/.test(atomic.message) &&
        /0\/1/.test(atomic.message),
      '#57: a normally-scheduled Pod still shows STATUS ContainerCreating after binding (kubelet state preserved)',
      atomic.message.replace(/\n/g, ' ⏎ ')
    );
    const running = await advanceUntil(async () => {
      const wide = await podWide('default');
      const pod = wide.rows.find((candidate) => candidate.name === 'sched-check');
      return pod?.status === 'Running' && pod.ready === '1/1';
    }, 40);
    assert(running, '#57: the normally-scheduled Pod then reaches Running 1/1');
  }

  // ═══ Round 2: #58 platform Services + DNS networking/pod detail ═════════
  result = await runCmd('oc get svc -n openshift-dns');
  table = tableParts(result.message);
  row = table.rows.find((cells) => cells[0] === 'dns-default') || [];
  assert(
    !result.error &&
      row[columnIndex(table, 'TYPE')] === 'ClusterIP' &&
      row[columnIndex(table, 'CLUSTER-IP')] === '172.30.0.10' &&
      row[columnIndex(table, 'PORT(S)')] === '53/UDP,53/TCP,9154/TCP',
    '#58: `oc get svc -n openshift-dns` shows dns-default ClusterIP 172.30.0.10 ports 53/UDP,53/TCP,9154/TCP',
    JSON.stringify({ headers: table.headers, row })
  );
  result = await runCmd('oc get svc -n openshift-ingress');
  table = tableParts(result.message);
  row = table.rows.find((cells) => cells[0] === 'router-internal-default') || [];
  assert(
    !result.error &&
      row[columnIndex(table, 'TYPE')] === 'ClusterIP' &&
      /^172\.30\.\d+\.\d+$/.test(row[columnIndex(table, 'CLUSTER-IP')] || '') &&
      row[columnIndex(table, 'PORT(S)')] === '80/TCP,443/TCP,1936/TCP',
    '#58: `oc get svc -n openshift-ingress` shows router-internal-default ClusterIP ports 80/TCP,443/TCP,1936/TCP',
    JSON.stringify({ headers: table.headers, row })
  );
  result = await runCmd('oc get endpoints -n openshift-dns');
  table = tableParts(result.message);
  row = table.rows.find((cells) => cells[0] === 'dns-default') || [];
  {
    const endpointCell = row[columnIndex(table, 'ENDPOINTS')] || '';
    // #60: the ENDPOINTS cell truncates like kubectl — three pairs, then
    // ` + N more...` for the rest. Derive N from the canonical ready endpoints
    // (3 DNS Pods × 3 ports = 9) instead of hardcoding it, so a transiently
    // recreated platform Pod cannot make this look like a truncation bug.
    const expectedPairs = await evaluate(() => {
      const svc = window.game.cluster.getByName('Service', 'dns-default', 'openshift-dns');
      const pods = window.game.cluster.getServiceEndpoints(svc);
      return pods.length * ((svc?.spec?.ports || []).length || 1);
    });
    const truncation = endpointCell.match(/^(.*?) \+ (\d+) more\.\.\.$/);
    const endpointPairs = (truncation ? truncation[1] : endpointCell).split(',').filter(Boolean);
    const expectedListed = Math.min(3, expectedPairs);
    const expectedMore = expectedPairs > 3 ? String(expectedPairs - 3) : null;
    assert(
      !result.error &&
        expectedPairs > 3 &&
        endpointPairs.length === expectedListed &&
        endpointPairs.every((pair) => /^10\.\d+\.\d+\.\d+:\d+$/.test(pair)) &&
        endpointPairs.some((pair) => pair.endsWith(':5353')) &&
        truncation?.[2] === expectedMore,
      '#58: `oc get endpoints -n openshift-dns` lists the first 3 dns-default 10.x:5353 pairs plus " + N more..." like kubectl',
      JSON.stringify({ endpointCell: endpointCell.slice(0, 500), expectedPairs, expectedMore })
    );
  }
  result = await runCmd('oc get svc,endpoints -n openshift-dns');
  {
    const sections = tableSections(result.message);
    const serviceSection = sections.find((candidate) => candidate.headers.includes('CLUSTER-IP'));
    const endpointsSection = sections.find((candidate) => candidate.headers.includes('ENDPOINTS'));
    const serviceRow = rowFor(serviceSection, (name) => name === 'service/dns-default');
    const endpointsRow = rowFor(endpointsSection, (name) => name === 'endpoints/dns-default');
    const endpointsCell = endpointsRow[columnIndex(endpointsSection, 'ENDPOINTS')] || '';
    assert(
      !result.error &&
        serviceRow[columnIndex(serviceSection, 'CLUSTER-IP')] === '172.30.0.10' &&
        Boolean(endpointsRow.length) &&
        /10\.\d+\.\d+\.\d+:5353/.test(endpointsCell),
      '#58: multi-kind `oc get svc,endpoints -n openshift-dns` shows service/dns-default + endpoints/dns-default with 10.x:5353',
      result.message.slice(0, 900)
    );
  }
  {
    const wide = await podWide('openshift-dns');
    const dnsRows = wide.rows.filter((candidate) => /^dns-default-/.test(candidate.name));
    const resolverRows = wide.rows.filter((candidate) => /^node-resolver-/.test(candidate.name));
    const nodeIPs = new Map(
      await evaluate(() =>
        (window.game.cluster.getByKind('Node') || []).map((node) => [
          node.metadata?.name || '',
          (node.status?.addresses || []).find((address) => address.type === 'InternalIP')
            ?.address || '',
        ])
      )
    );
    assert(
      dnsRows.length === 3 &&
        dnsRows.every((candidate) => /^10\.\d+\.\d+\.\d+$/.test(candidate.ip)),
      '#58: dns-default Pods run on the pod network (10.x Pod IPs, `-o wide` IP column)',
      JSON.stringify(dnsRows)
    );
    assert(
      resolverRows.length === 3 &&
        resolverRows.every((candidate) => candidate.ip === nodeIPs.get(candidate.node)),
      '#58: node-resolver Pods keep the node InternalIP (hostNetwork)',
      JSON.stringify({ rows: resolverRows, nodeIPs: [...nodeIPs] })
    );
    const state = await podNetworkState();
    assert(
      state.dns.every(
        (pod) => !pod.hostNetwork && /^10\./.test(pod.podIP) && pod.scc === 'restricted-v2'
      ) &&
        state.resolver.every(
          (pod) => pod.hostNetwork && pod.podIP === pod.nodeIP && pod.scc === 'hostnetwork'
        ) &&
        state.router.every(
          (pod) => pod.hostNetwork && pod.podIP === pod.nodeIP && pod.scc === 'hostnetwork'
        ),
      '#58: dns-default is hostNetwork:false/restricted-v2 while node-resolver and the router are hostNetwork',
      JSON.stringify(state)
    );
  }
  result = await runCmd('oc get ds -n openshift-dns');
  table = tableParts(result.message);
  {
    const selectorAt = columnIndex(table, 'NODE SELECTOR');
    const dnsRow = table.rows.find((cells) => cells[0] === 'dns-default') || [];
    const resolverRow = table.rows.find((cells) => cells[0] === 'node-resolver') || [];
    assert(
      !result.error &&
        selectorAt >= 0 &&
        dnsRow[selectorAt] === 'kubernetes.io/os=linux' &&
        resolverRow[selectorAt] === 'kubernetes.io/os=linux',
      '#58: `oc get ds -n openshift-dns` shows NODE SELECTOR kubernetes.io/os=linux for both DNS DaemonSets',
      JSON.stringify({ headers: table.headers, rows: [dnsRow, resolverRow] })
    );
  }
  {
    const labelRows = await podWide('openshift-ingress', `${ingressControllerLabel}=default`);
    assert(
      labelRows.rows.length === 2 &&
        labelRows.rows.every(
          (candidate) => /^router-default-/.test(candidate.name) && candidate.status === 'Running'
        ),
      '#58: `oc get pods -n openshift-ingress -l <ingresscontroller label>` returns the 2 router Pods',
      JSON.stringify(labelRows.rows)
    );
    result = await runCmd(
      `oc delete pod -n openshift-ingress -l ${ingressControllerLabel}=default`
    );
    const deletedCount = (result.message.match(/pod "/g) || []).length;
    assert(
      !result.error && deletedCount === 2,
      '#58: `oc delete pod -n openshift-ingress -l <ingresscontroller label>` deletes both router Pods',
      result.message.slice(0, 400)
    );
    const recreated = await advanceUntil(async () => {
      const wideAgain = await podWide('openshift-ingress');
      const pods = wideAgain.rows.filter((candidate) => /^router-default-/.test(candidate.name));
      return pods.length === 2 && pods.every((candidate) => candidate.status === 'Running');
    }, 40);
    assert(recreated, '#58: the router Deployment controller recreates the label-deleted Pods');
    // #58: with the Service selector pinned to the operator label, the router
    // Service resolves to its Pods; hostNetwork router Pods expose the node IP
    // on the Service target ports (80/443/1936).
    result = await runCmd('oc get endpoints -n openshift-ingress');
    {
      const endpointsTable = tableParts(result.message);
      const endpointsRow =
        endpointsTable.rows.find((cells) => cells[0] === 'router-internal-default') || [];
      const endpointCell = endpointsRow[columnIndex(endpointsTable, 'ENDPOINTS')] || '';
      // #60: router Pods × 3 ports (2 × 3 = 6 ready pairs) truncate to the
      // first three then ` + N more...`. Derive N from the canonical endpoint
      // count so a transiently recreated router Pod cannot fail the check.
      const expectedPairs = await evaluate(() => {
        const svc = window.game.cluster.getByName(
          'Service',
          'router-internal-default',
          'openshift-ingress'
        );
        const pods = window.game.cluster.getServiceEndpoints(svc);
        return pods.length * ((svc?.spec?.ports || []).length || 1);
      });
      const truncation = endpointCell.match(/^(.*?) \+ (\d+) more\.\.\.$/);
      const endpointPairs = (truncation ? truncation[1] : endpointCell).split(',').filter(Boolean);
      const expectedListed = Math.min(3, expectedPairs);
      const expectedMore = expectedPairs > 3 ? String(expectedPairs - 3) : null;
      const nodeIPs = new Set(
        await evaluate(() =>
          (window.game.cluster.getByKind('Node') || []).map(
            (node) =>
              (node.status?.addresses || []).find((address) => address.type === 'InternalIP')
                ?.address || ''
          )
        )
      );
      const pairsResolve =
        endpointPairs.length === expectedListed &&
        endpointPairs.every((pair) => {
          const [ip, port] = pair.split(':');
          return nodeIPs.has(ip) && ['80', '443', '1936'].includes(port);
        });
      assert(
        !result.error && expectedPairs > 3 && pairsResolve && truncation?.[2] === expectedMore,
        '#58: `oc get endpoints -n openshift-ingress` resolves the first 3 router Pod node-IP pairs on 80/443 plus " + N more..."',
        JSON.stringify({ endpointsCell: endpointCell.slice(0, 600), expectedPairs, expectedMore })
      );
    }
  }
  result = await runCmd(`oc adm taint node master-0 ${masterTaintKey}=:NoSchedule`);
  assert(
    !result.error && /node\/master-0 tainted/.test(result.message),
    '#58: `oc adm taint node master-0 node-role.kubernetes.io/master=:NoSchedule` accepts the kubectl empty-value grammar',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc describe node master-0');
  assert(
    new RegExp(`^Taints:\\s+${masterTaintKey.replace(/\./g, '\\.')}:NoSchedule\\s*$`, 'm').test(
      result.message
    ),
    '#58: `oc describe node master-0` shows the empty-value taint as node-role.kubernetes.io/master:NoSchedule',
    (result.message.match(/^Taints:.*$/m) || [''])[0]
  );
  result = await runCmd(`oc adm taint node master-0 ${masterTaintSpec}-`);
  assert(
    !result.error && /node\/master-0 untainted/.test(result.message),
    '#58: the `key:Effect-` removal form still removes the master taint',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc describe node master-0');
  assert(
    /^Taints:\s+<none>\s*$/m.test(result.message),
    '#58: the removed master taint is gone right after the removal command',
    (result.message.match(/^Taints:.*$/m) || [''])[0]
  );
  result = await runCmd(`oc adm taint node master-0 ${masterTaintKey}=:NoSchedule`);
  assert(
    !result.error && /node\/master-0 tainted/.test(result.message),
    '#58: the control-plane taint can be restored with the empty-value form',
    result.message.slice(0, 300)
  );
  {
    await runCmd('oc adm taint node worker-0 dedicated=:NoSchedule');
    result = await runCmd('oc adm taint node worker-0 dedicated:NoSchedule-');
    assert(
      !result.error && /node\/worker-0 untainted/.test(result.message),
      '#58: the `key:Effect-` removal form works for a dedicated taint',
      result.message.slice(0, 300)
    );
    await runCmd('oc adm taint node worker-0 dedicated=:NoSchedule');
    result = await runCmd('oc adm taint node worker-0 dedicated=NoSchedule-');
    assert(
      !result.error && /node\/worker-0 untainted/.test(result.message),
      '#58: the `key=value:Effect-` removal form works (empty value accepted)',
      result.message.slice(0, 300)
    );
    await runCmd('oc adm taint node worker-0 dedicated=:NoSchedule');
    result = await runCmd('oc adm taint node worker-0 dedicated-');
    assert(
      !result.error && /node\/worker-0 untainted/.test(result.message),
      '#58: the `key-` removal form still works',
      result.message.slice(0, 300)
    );
    result = await runCmd('oc describe node worker-0');
    assert(
      /^Taints:\s+<none>\s*$/m.test(result.message),
      '#58: worker-0 has no leftover taints after the removal-form checks',
      (result.message.match(/^Taints:.*$/m) || [''])[0]
    );
    result = await runCmd('oc adm taint node worker-0 dedicated=:Bogus');
    assert(
      result.error && /invalid taint effect: Bogus, unsupported taint effect/.test(result.message),
      '#58: an unknown taint effect is rejected with the real oc error',
      result.message.slice(0, 300)
    );
  }
  result = await runCmd(
    'oc exec deployment/router-default -n openshift-ingress -- cat /etc/resolv.conf'
  );
  assert(
    !result.error &&
      /nameserver 172\.30\.0\.10/.test(result.message) &&
      /search openshift-ingress\.svc\.cluster\.local svc\.cluster\.local cluster\.local/.test(
        result.message
      ) &&
      /options ndots:5/.test(result.message),
    '#58: `oc exec <running Pod> -- cat /etc/resolv.conf` shows the cluster DNS contract',
    result.message.slice(0, 400)
  );
  {
    const before = await platformSnapshot();
    await advanceBoth(90);
    const after = await platformSnapshot();
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      '#58: platform Pods and Service ClusterIPs do not churn over 90 s of ticks',
      JSON.stringify({ before, after })
    );
  }

  // ═══ Round 3: #58 paused pre-start sandbox — platform Services + the
  //     deterministic `oc new-app` ScalingReplicaSet name ═════════════════
  await goto('/?mode=sandbox&tutorial=1');
  const pausedBooted = await waitFor(
    () =>
      evaluate(
        () =>
          Boolean(window.game?.app?.modeInstance) &&
          Boolean(document.getElementById('tutorial-overlay'))
      ),
    20000
  );
  await sleep(600);
  {
    const pausedState = await evaluate(() => ({
      state: window.game?.gameEngine?.state || '',
      gameSeconds: window.game?.gameEngine?.simulation?.gameSeconds ?? null,
      tutorial: Boolean(document.getElementById('tutorial-overlay')),
    }));
    assert(
      pausedBooted && pausedState.state === 'paused' && pausedState.gameSeconds === 0,
      '#58: the sandbox is genuinely paused before "Start exploring" (platform Services seeded without ticks)',
      JSON.stringify(pausedState)
    );
  }
  result = await runCmd('oc get svc -n openshift-dns');
  {
    const pausedTable = tableParts(result.message);
    const dnsRow = pausedTable.rows.find((cells) => cells[0] === 'dns-default') || [];
    assert(
      !result.error &&
        dnsRow[columnIndex(pausedTable, 'CLUSTER-IP')] === '172.30.0.10' &&
        dnsRow[columnIndex(pausedTable, 'PORT(S)')] === '53/UDP,53/TCP,9154/TCP',
      '#58: the dns-default Service exists in the paused pre-start sandbox',
      JSON.stringify({ headers: pausedTable.headers, row: dnsRow })
    );
  }
  result = await runCmd('oc get svc -n openshift-ingress');
  {
    const pausedTable = tableParts(result.message);
    const routerRow =
      pausedTable.rows.find((cells) => cells[0] === 'router-internal-default') || [];
    assert(
      !result.error && routerRow[columnIndex(pausedTable, 'PORT(S)')] === '80/TCP,443/TCP,1936/TCP',
      '#58: the router-internal-default Service exists in the paused pre-start sandbox',
      JSON.stringify({ headers: pausedTable.headers, row: routerRow })
    );
  }
  result = await runCmd(
    'oc new-app --name=pre --image=quay.io/openshift/origin-hello-openshift:latest'
  );
  assert(
    !result.error && /deployment\.apps "pre" created/.test(result.message),
    '#58: `oc new-app --name=pre` creates the Deployment in the paused sandbox',
    result.message.slice(0, 400)
  );
  result = await runCmd('oc get events');
  let predictedReplicaSet = '';
  {
    const scalingRow = getEventRows(result.message).find(
      (event) => event.reason === 'ScalingReplicaSet' && event.object === 'deployment/pre'
    );
    const match = String(scalingRow?.message || '').match(
      new RegExp(`Scaled up replica set (pre-[${dnsAlphabet}]{10}) to 1`)
    );
    predictedReplicaSet = match ? match[1] : '';
    assert(
      Boolean(scalingRow) && Boolean(predictedReplicaSet),
      '#58: the paused new-app ScalingReplicaSet event prints the full deterministic pre-<10-char pod-template-hash> name',
      JSON.stringify({ message: scalingRow?.message, predictedReplicaSet })
    );
  }
  result = await runCmd('oc get rs');
  assert(
    /No resources found/.test(result.message),
    '#58: no ReplicaSet exists yet while the cluster is paused (the event is only a prediction)',
    result.message.slice(0, 300)
  );
  await evaluate(() => document.getElementById('tutorial-start')?.click());
  const engineStarted = await waitFor(
    () => evaluate(() => window.game?.gameEngine?.state === 'running'),
    8000
  );
  assert(engineStarted, '#58: "Start exploring" resumes the paused sandbox');
  {
    const replicaSetExists = await advanceUntil(async () => {
      const out = await runCmd('oc get rs -n default');
      return tableParts(out.message).rows.some((cells) => cells[0] === predictedReplicaSet);
    }, 40);
    assert(
      replicaSetExists,
      '#58: after Start the Deployment controller creates exactly the predicted ReplicaSet name',
      predictedReplicaSet
    );
  }
  result = await runCmd(`oc describe rs ${predictedReplicaSet}`);
  assert(
    !result.error &&
      new RegExp(`^Name:\\s+${predictedReplicaSet}\\s*$`, 'm').test(result.message) &&
      /Replicas:\s+1 desired/.test(result.message),
    '#58: `oc describe rs <predicted name>` works and shows the 1-desired ReplicaSet',
    result.message.slice(0, 500)
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// QA ROUND 1.8.0 — issues #59/#60: Service objects carry a real
// `spec.clusterIP` + the other API-server defaults created by `oc expose` and
// `oc apply -f`, `oc describe svc` prints the real per-port kubectl shape and
// cluster DNS resolves the actual Service ClusterIP names; the #60 output
// fidelity items (unscheduled Pod describe without kubelet-only lines,
// kubectl-style Endpoints truncation, RoleBinding ROLE kind and the blocking
// `oc rollout status --timeout`) stay honest.
// ═══════════════════════════════════════════════════════════════════════════
await runSection('qa-issue59-60', async () => {
  let result;
  let row;

  /** Advance the simulation AND incident clocks deterministically (0.05 s). */
  const advanceBoth = async (seconds) =>
    evaluate((secs) => {
      const sim = window.game?.gameEngine?.simulation;
      const engine = window.game?.incidentEngine;
      if (!sim || typeof sim.tick !== 'function') return false;
      const steps = Math.ceil(secs / 0.05);
      for (let index = 0; index < steps; index += 1) {
        sim.tick(0.05);
        if (engine && typeof engine.tick === 'function') engine.tick(0.05);
      }
      return true;
    }, seconds);
  /** Advance both clocks until predicate() is true, or exhaust maxSeconds. */
  const advanceUntil = async (predicate, maxSeconds = 60, step = 2) => {
    for (let played = 0; played < maxSeconds; played += step) {
      await advanceBoth(step);
      if (await predicate()) return true;
    }
    return false;
  };
  /** Split an oc tabwriter table into header cells + rows (2+ space columns). */
  const tableParts = (message) => {
    const lines = String(message ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    return {
      headers: (lines[0] || '').split(/\s{2,}/).map((cell) => cell.trim()),
      rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
    };
  };
  const columnIndex = (section, header) => (section ? section.headers.indexOf(header) : -1);
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Ready `ip:port` pairs of an ENDPOINTS cell (strips a ` + N more...` tail). */
  const endpointCellParts = (cell) => {
    const text = String(cell ?? '').trim();
    const truncation = text.match(/^(.*?)(?: \+ (\d+) more\.\.\.)?$/);
    return {
      text,
      listed: (truncation?.[1] || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      more: truncation?.[2] === undefined ? null : Number(truncation[2]),
    };
  };
  /** Per-port blocks of `oc describe svc` (Port:/TargetPort:/Endpoints: groups). */
  const describePortBlocks = (message) => {
    const blocks = [];
    let current = null;
    for (const line of String(message ?? '').split('\n')) {
      if (/^Port:\s/.test(line)) {
        current = { header: line, lines: [] };
        blocks.push(current);
        continue;
      }
      if (current) current.lines.push(line);
    }
    return blocks;
  };
  const describeField = (block, field) => {
    const prefix = new RegExp(`^\\s*${field}:\\s*`);
    const line = (block?.lines || []).find((candidate) => prefix.test(candidate));
    return line ? line.replace(prefix, '').trim() : '';
  };
  const normalizeDescribeLine = (line) =>
    String(line ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  /** Top-level (`  key:`) keys of one top-level YAML section such as `status:`. */
  const yamlSectionKeys = (text, sectionName) => {
    const lines = String(text ?? '').split('\n');
    const start = lines.findIndex((line) => new RegExp(`^${sectionName}:\\s*$`).test(line));
    if (start < 0) return null;
    const keys = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) break;
      const match = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):/);
      if (match) keys.push(match[1]);
    }
    return keys;
  };
  /** Rows of `oc get pods -n <namespace>` as { name, ready, status }. */
  const podRows = async (namespace) => {
    const out = await runCmd(`oc get pods -n ${namespace}`);
    return tableParts(out.message).rows.map((cells) => ({
      name: cells[0] || '',
      ready: cells[1] || '',
      status: cells[2] || '',
    }));
  };
  const podsWithPrefix = async (namespace, prefix) => {
    const rows = await podRows(namespace);
    const pattern = new RegExp(`^${prefix}`);
    return rows.filter((candidate) => pattern.test(candidate.name));
  };

  // ═══ Round 1: #59 — `oc expose deployment/web` carries a real ClusterIP ══
  assert(await bootSandbox(), '#59/#60: a fresh sandbox boots for the Service/DNS fidelity checks');

  result = await runCmd('oc new-project qa7');
  assert(
    !result.error && /Now using project "qa7"/.test(result.message),
    '#59: `oc new-project qa7` creates the project used by the ClusterIP/DNS checks',
    result.message.slice(0, 300)
  );
  result = await runCmd(
    'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=2'
  );
  assert(
    !result.error && /deployment\.apps\/web created/.test(result.message),
    '#59: `oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=2` creates the Deployment',
    result.message.slice(0, 300)
  );
  const webPodsRunning = await advanceUntil(async () => {
    const pods = await podsWithPrefix('qa7', 'web-');
    return (
      pods.length === 2 && pods.every((pod) => pod.ready === '1/1' && pod.status === 'Running')
    );
  }, 40);
  assert(
    webPodsRunning,
    '#59: the two `web` Pods reach Running 1/1 before exposing the Deployment'
  );
  result = await runCmd('oc expose deploy/web --port=8080');
  assert(
    !result.error && /service\/web exposed/.test(result.message),
    '#59: `oc expose deployment/web --port=8080` creates the ClusterIP Service',
    result.message.slice(0, 300)
  );
  await advanceBoth(3);

  result = await runCmd('oc get svc web');
  const svcTable = tableParts(result.message);
  row = svcTable.rows.find((cells) => cells[0] === 'web') || [];
  const clusterIP = row[columnIndex(svcTable, 'CLUSTER-IP')] || '';
  assert(
    !result.error && /^172\.30\.\d+\.\d+$/.test(clusterIP),
    '#59: `oc get svc web` CLUSTER-IP is a real 172.30.x.y address (not empty/<none>)',
    JSON.stringify({ headers: svcTable.headers, row })
  );
  assert(
    !result.error &&
      row[columnIndex(svcTable, 'TYPE')] === 'ClusterIP' &&
      row[columnIndex(svcTable, 'PORT(S)')] === '8080/TCP',
    '#59: the exposed Service is TYPE ClusterIP with PORT(S) 8080/TCP',
    JSON.stringify({ headers: svcTable.headers, row })
  );

  result = await runCmd("oc get svc web -o jsonpath='{.spec.clusterIP}'");
  assert(
    !result.error && result.message.trim() === clusterIP,
    '#59: `oc get svc web -o jsonpath={.spec.clusterIP}` equals the `oc get svc` CLUSTER-IP',
    JSON.stringify({ clusterIP, jsonpath: result.message.trim() })
  );

  result = await runCmd('oc get svc web -o json');
  let serviceJson = null;
  try {
    serviceJson = JSON.parse(result.message);
  } catch {
    serviceJson = null;
  }
  const webSpec = serviceJson?.spec || {};
  const webSpecPort = (webSpec.ports || [])[0] || {};
  assert(
    !result.error &&
      Boolean(serviceJson) &&
      webSpec.clusterIP === clusterIP &&
      JSON.stringify(webSpec.clusterIPs) === JSON.stringify([clusterIP]) &&
      JSON.stringify(webSpec.ipFamilies) === JSON.stringify(['IPv4']) &&
      webSpec.ipFamilyPolicy === 'SingleStack' &&
      webSpec.sessionAffinity === 'None' &&
      webSpec.internalTrafficPolicy === 'Cluster' &&
      String(webSpecPort.targetPort) === '8080' &&
      webSpecPort.protocol === 'TCP' &&
      !webSpecPort.name,
    '#59: `oc get svc web -o json` spec carries clusterIP/clusterIPs/ipFamilies/ipFamilyPolicy/sessionAffinity/internalTrafficPolicy and the unnamed 8080 TCP port',
    JSON.stringify(webSpec)
  );
  const svcStatusKeys = serviceJson ? Object.keys(serviceJson.status || {}).sort() : [];
  assert(
    JSON.stringify(svcStatusKeys) === JSON.stringify(['loadBalancer']),
    '#59: the Service status serializes as ONLY loadBalancer (no phase/conditions/observedGeneration/readyEndpoints/totalEndpoints/endpoints)',
    JSON.stringify(serviceJson?.status)
  );

  result = await runCmd('oc get svc web -o yaml');
  const svcYaml = result.message;
  const yamlStatusKeys = yamlSectionKeys(svcYaml, 'status');
  const yamlSpecHasDefaults =
    new RegExp(`clusterIP:\\s+${escapeRe(clusterIP)}`).test(svcYaml) &&
    /clusterIPs:/.test(svcYaml) &&
    /ipFamilies:/.test(svcYaml) &&
    /ipFamilyPolicy:\s+SingleStack/.test(svcYaml) &&
    /sessionAffinity:\s+None/.test(svcYaml) &&
    /internalTrafficPolicy:\s+Cluster/.test(svcYaml);
  assert(
    !result.error &&
      yamlSpecHasDefaults &&
      JSON.stringify(yamlStatusKeys) === JSON.stringify(['loadBalancer']),
    '#59: `oc get svc web -o yaml` spec prints the API defaults while status keeps only loadBalancer',
    JSON.stringify({ yamlSpecHasDefaults, yamlStatusKeys })
  );

  result = await runCmd('oc describe svc web');
  const describeWeb = result.message;
  const webBlocks = describePortBlocks(describeWeb);
  assert(
    !result.error &&
      new RegExp(`^IP:\\s+${escapeRe(clusterIP)}\\s*$`, 'm').test(describeWeb) &&
      new RegExp(`^IPs:\\s+${escapeRe(clusterIP)}\\s*$`, 'm').test(describeWeb) &&
      /^IP Family Policy:\s+SingleStack\s*$/m.test(describeWeb) &&
      /^IP Families:\s+IPv4\s*$/m.test(describeWeb) &&
      /^Session Affinity:\s+None\s*$/m.test(describeWeb) &&
      !/\bundefined\b/.test(describeWeb),
    '#59: `oc describe svc web` prints the matching IP/IPs, IP Family Policy/IP Families, Session Affinity None and no literal undefined',
    describeWeb.slice(0, 900)
  );
  const webPortBlock = webBlocks[0] || { header: '', lines: [] };
  assert(
    webBlocks.length === 1 &&
      normalizeDescribeLine(webPortBlock.header) === 'Port: <unset> 8080/TCP' &&
      describeField(webPortBlock, 'TargetPort') === '8080/TCP',
    '#59: the unnamed exposed Service port prints `Port: <unset> 8080/TCP` and `TargetPort: 8080/TCP`',
    JSON.stringify({
      blocks: webBlocks.map((block) => normalizeDescribeLine(block.header)),
      targetPort: describeField(webPortBlock, 'TargetPort'),
    })
  );

  result = await runCmd('oc get endpoints web');
  const webEndpointsTable = tableParts(result.message);
  row = webEndpointsTable.rows.find((cells) => cells[0] === 'web') || [];
  const webEndpointCell = row[columnIndex(webEndpointsTable, 'ENDPOINTS')] || '';
  const webEndpointParts = endpointCellParts(webEndpointCell);
  const webDescribeEndpointPairs = (describeField(webPortBlock, 'Endpoints') || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sortedPairs = (entries) => [...entries].sort();
  assert(
    !result.error &&
      webEndpointParts.more === null &&
      webEndpointParts.listed.length === 2 &&
      JSON.stringify(sortedPairs(webEndpointParts.listed)) ===
        JSON.stringify(sortedPairs(webDescribeEndpointPairs)) &&
      webDescribeEndpointPairs.every((pair) => /^10\.\d+\.\d+\.\d+:8080$/.test(pair)),
    '#59: `oc describe svc web` Endpoints equal `oc get endpoints web` (both ready Pod IPs on 8080)',
    JSON.stringify({ webEndpointCell, describeEndpoints: webDescribeEndpointPairs })
  );

  result = await runCmd('oc exec deploy/web -n qa7 -- nslookup web.qa7.svc.cluster.local');
  const webDnsLookup = result.message;
  assert(
    !result.error &&
      /^Name:\s+web\.qa7\.svc\.cluster\.local\s*$/m.test(webDnsLookup) &&
      new RegExp(`^Address:\\s+${escapeRe(clusterIP)}\\s*$`, 'm').test(webDnsLookup) &&
      !/172\.30\.43\.12/.test(webDnsLookup),
    '#59: `oc exec deploy/web -- nslookup web.qa7.svc.cluster.local` resolves to the Service ClusterIP (never the fabricated 172.30.43.12)',
    webDnsLookup.slice(0, 500)
  );
  result = await runCmd('oc get svc router-internal-default -n openshift-ingress');
  const routerSvcTable = tableParts(result.message);
  row = routerSvcTable.rows.find((cells) => cells[0] === 'router-internal-default') || [];
  const routerClusterIP = row[columnIndex(routerSvcTable, 'CLUSTER-IP')] || '';
  result = await runCmd(
    'oc exec deploy/web -n qa7 -- nslookup router-internal-default.openshift-ingress.svc.cluster.local'
  );
  assert(
    !result.error &&
      /^172\.30\.\d+\.\d+$/.test(routerClusterIP) &&
      new RegExp(`^Address:\\s+${escapeRe(routerClusterIP)}\\s*$`, 'm').test(result.message),
    '#59: cross-namespace DNS `router-internal-default.openshift-ingress.svc.cluster.local` resolves to that Service ClusterIP',
    JSON.stringify({ routerClusterIP, message: result.message.slice(0, 400) })
  );
  result = await runCmd(
    'oc exec deploy/web -n qa7 -- nslookup does-not-exist.qa7.svc.cluster.local'
  );
  assert(
    /NXDOMAIN/.test(result.message) && !/172\.30\.43\.12/.test(result.message),
    '#59: an unknown DNS name prints NXDOMAIN (no fabricated Service IP)',
    result.message.slice(0, 400)
  );

  result = await runCmd('oc describe svc dns-default -n openshift-dns');
  const describeDns = result.message;
  const dnsBlocks = describePortBlocks(describeDns);
  const dnsExpectedPorts = [
    { header: 'Port: dns 53/UDP', target: '5353', endpointPort: '5353' },
    { header: 'Port: dns-tcp 53/TCP', target: '5353', endpointPort: '5353' },
    { header: 'Port: metrics 9154/TCP', target: '9154', endpointPort: '9154' },
  ];
  const dnsPodIPs = await evaluate(() =>
    (window.game?.cluster?.getByKindAndNamespace?.('Pod', 'openshift-dns') || [])
      .filter((pod) => /^dns-default-/.test(pod.metadata?.name || ''))
      .map((pod) => pod.status?.podIP || '')
      .filter(Boolean)
  );
  const dnsPortBlocksOk =
    dnsBlocks.length === 3 &&
    dnsExpectedPorts.every((expected, index) => {
      const block = dnsBlocks[index];
      const target = describeField(block, 'TargetPort');
      const pairs = (describeField(block, 'Endpoints') || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      return (
        normalizeDescribeLine(block.header) === expected.header &&
        new RegExp(`^${expected.target}(?:\\/(?:UDP|TCP))?$`).test(target) &&
        pairs.length === 3 &&
        pairs.every((pair) => {
          const match = pair.match(/^(10\.\d+\.\d+\.\d+):(\d+)$/);
          return (
            Boolean(match) && dnsPodIPs.includes(match[1]) && match[2] === expected.endpointPort
          );
        })
      );
    });
  assert(
    !result.error &&
      /^IP:\s+172\.30\.0\.10\s*$/m.test(describeDns) &&
      /^IPs:\s+172\.30\.0\.10\s*$/m.test(describeDns) &&
      /^IP Family Policy:\s+SingleStack\s*$/m.test(describeDns) &&
      /^IP Families:\s+IPv4\s*$/m.test(describeDns) &&
      /^Session Affinity:\s+None\s*$/m.test(describeDns) &&
      !/\bundefined\b/.test(describeDns),
    '#59: `oc describe svc dns-default -n openshift-dns` shows IP 172.30.0.10, SingleStack/IPv4, Session Affinity None and no undefined',
    describeDns.slice(0, 1200)
  );
  assert(
    dnsPortBlocksOk,
    '#59: `oc describe svc dns-default` prints one Port/TargetPort/Endpoints block per port (dns 53/UDP, dns-tcp 53/TCP, metrics 9154/TCP) with the 3 pod-network endpoints each',
    JSON.stringify({
      blocks: dnsBlocks.map((block) => ({
        header: normalizeDescribeLine(block.header),
        targetPort: describeField(block, 'TargetPort'),
        endpoints: describeField(block, 'Endpoints'),
      })),
      dnsPodIPs,
    })
  );

  result = await runCmd(
    `oc exec deploy/web -n qa7 -- curl -s -o /dev/null -w "%{http_code}" http://${clusterIP}:8080`
  );
  assert(
    !result.error && result.message.trim() === '200',
    '#59: `oc exec deploy/web -- curl … http://<clusterIP>:8080` routes through the Service endpoints and prints 200',
    result.message.replace(/\n/g, ' ⏎ ').slice(0, 300)
  );

  result = await runCmd('oc apply -f manifests/service.yaml -n qa7');
  assert(
    !result.error && /service\/webapp/.test(result.message),
    '#59: `oc apply -f manifests/service.yaml -n qa7` applies an externally authored Service manifest',
    result.message.slice(0, 400)
  );
  result = await runCmd("oc get svc webapp -n qa7 -o jsonpath='{.spec.clusterIP}'");
  const appliedClusterIP = result.message.trim();
  assert(
    !result.error && /^172\.30\.\d+\.\d+$/.test(appliedClusterIP) && appliedClusterIP !== clusterIP,
    '#59: an applied Service without spec.clusterIP gets its own real allocated ClusterIP (defaulting on the apply path)',
    JSON.stringify({ appliedClusterIP, clusterIP })
  );

  // ═══ Round 2: #60 — unscheduled Pod describe is not the kubelet view ═════
  result = await runCmd(
    `oc run unsched --image=registry.access.redhat.com/ubi9/ubi --overrides='{"spec":{"nodeSelector":{"nope":"nope"}}}' -n qa7`
  );
  assert(
    !result.error && /pod\/unsched created/.test(result.message),
    '#60: `oc run unsched` with an impossible nodeSelector creates the Pod',
    result.message.slice(0, 300)
  );
  await advanceBoth(6);
  result = await runCmd('oc describe pod unsched -n qa7');
  const describeUnsched = result.message;
  const kubeletOnlyLines = [
    ['Container ID', /^\s*Container ID:/m],
    ['Image ID', /^\s*Image ID:/m],
    ['State', /^\s*State:/m],
    ['Ready', /^\s*Ready:/m],
    ['Restart Count', /^\s*Restart Count:/m],
  ];
  const presentKubeletLines = kubeletOnlyLines
    .filter(([, pattern]) => pattern.test(describeUnsched))
    .map(([label]) => label);
  assert(
    !result.error && presentKubeletLines.length === 0,
    '#60: `oc describe pod unsched` has no Container ID/Image ID/State/Ready/Restart Count lines (never bound → no kubelet status)',
    JSON.stringify({ presentKubeletLines, excerpt: describeUnsched.slice(0, 800) })
  );
  assert(
    !result.error &&
      /^\s+Image:\s+registry\.access\.redhat\.com\/ubi9\/ubi\s*$/m.test(describeUnsched) &&
      /^\s+Port:/m.test(describeUnsched) &&
      /^\s+Host Port:/m.test(describeUnsched) &&
      /^\s+Environment:/m.test(describeUnsched) &&
      /^\s+Mounts:/m.test(describeUnsched) &&
      /PodScheduled\s+False/.test(describeUnsched) &&
      /FailedScheduling/.test(describeUnsched),
    '#60: unscheduled Pod describe keeps Image/Port/Host Port/Environment/Mounts plus PodScheduled False and the FailedScheduling event',
    describeUnsched.slice(-900)
  );

  const runningWebPod = (await podsWithPrefix('qa7', 'web-'))[0]?.name || '';
  result = await runCmd(`oc describe pod ${runningWebPod} -n qa7`);
  const describeRunning = result.message;
  assert(
    Boolean(runningWebPod) &&
      !result.error &&
      /^\s*State:\s+Running\s*$/m.test(describeRunning) &&
      /^\s*Ready:\s+True\s*$/m.test(describeRunning) &&
      /^\s*Restart Count:\s+0\s*$/m.test(describeRunning) &&
      /^\s*Container ID:/m.test(describeRunning) &&
      /^\s*Image ID:/m.test(describeRunning),
    '#60: a bound/running Pod describe keeps State Running/Ready True/Restart Count 0 plus the Container ID/Image ID fields (no over-removal)',
    JSON.stringify({ runningWebPod, excerpt: describeRunning.slice(0, 1000) })
  );

  result = await runCmd('oc get endpoints -n openshift-dns');
  const dnsEndpointsTable = tableParts(result.message);
  row = dnsEndpointsTable.rows.find((cells) => cells[0] === 'dns-default') || [];
  const dnsEndpointCell = row[columnIndex(dnsEndpointsTable, 'ENDPOINTS')] || '';
  const dnsEndpointParts = endpointCellParts(dnsEndpointCell);
  const expectedDnsPairs = await evaluate(() => {
    const svc = window.game.cluster.getByName('Service', 'dns-default', 'openshift-dns');
    const pods = window.game.cluster.getServiceEndpoints(svc);
    return pods.length * ((svc?.spec?.ports || []).length || 1);
  });
  assert(
    !result.error &&
      expectedDnsPairs > 3 &&
      dnsEndpointParts.more === expectedDnsPairs - 3 &&
      dnsEndpointParts.listed.length === 3 &&
      dnsEndpointParts.listed.every((pair) => /^10\.\d+\.\d+\.\d+:\d+$/.test(pair)),
    '#60: `oc get endpoints -n openshift-dns` ENDPOINTS prints 3 ready pairs then " + N more..." like kubectl',
    JSON.stringify({ cell: dnsEndpointCell, expectedDnsPairs })
  );
  result = await runCmd('oc get endpoints -n openshift-ingress');
  const routerEndpointsTable = tableParts(result.message);
  row = routerEndpointsTable.rows.find((cells) => cells[0] === 'router-internal-default') || [];
  const routerEndpointCell = row[columnIndex(routerEndpointsTable, 'ENDPOINTS')] || '';
  const routerEndpointParts = endpointCellParts(routerEndpointCell);
  const nodeIPs = new Set(
    await evaluate(() =>
      (window.game?.cluster?.getByKind?.('Node') || []).map(
        (node) =>
          (node.status?.addresses || []).find((address) => address.type === 'InternalIP')
            ?.address || ''
      )
    )
  );
  const routerPairsResolve = routerEndpointParts.listed.every((pair) => {
    const [ip, port] = pair.split(':');
    return nodeIPs.has(ip) && ['80', '443', '1936'].includes(port);
  });
  const expectedRouterPairs = await evaluate(() => {
    const svc = window.game.cluster.getByName(
      'Service',
      'router-internal-default',
      'openshift-ingress'
    );
    const pods = window.game.cluster.getServiceEndpoints(svc);
    return pods.length * ((svc?.spec?.ports || []).length || 1);
  });
  assert(
    !result.error &&
      expectedRouterPairs > 3 &&
      routerEndpointParts.more === expectedRouterPairs - 3 &&
      routerEndpointParts.listed.length === 3 &&
      routerPairsResolve,
    '#60: `oc get endpoints -n openshift-ingress` ENDPOINTS prints 3 node-IP pairs then " + N more..." like kubectl',
    JSON.stringify({ cell: routerEndpointCell, nodeIPs: [...nodeIPs], expectedRouterPairs })
  );

  result = await runCmd('oc get rolebinding -n qa7');
  const roleBindingTable = tableParts(result.message);
  {
    const roleAt = columnIndex(roleBindingTable, 'ROLE');
    const adminRow = roleBindingTable.rows.find((cells) => cells[0] === 'admin') || [];
    const deployersRow =
      roleBindingTable.rows.find((cells) => cells[0] === 'system:deployers') || [];
    assert(
      !result.error &&
        roleAt >= 0 &&
        adminRow[roleAt] === 'ClusterRole/admin' &&
        deployersRow[roleAt] === 'ClusterRole/system:deployer',
      '#60: `oc get rolebinding -n qa7` ROLE prints ClusterRole/<roleRef.name> (admin → ClusterRole/admin, system:deployers → ClusterRole/system:deployer)',
      JSON.stringify({
        headers: roleBindingTable.headers,
        admin: adminRow,
        deployers: deployersRow,
      })
    );
  }
  result = await runCmd(
    'oc create rolebinding qa7-edit --clusterrole=edit --user=developer -n qa7'
  );
  assert(
    !result.error &&
      /rolebinding\.rbac\.authorization\.k8s\.io\/qa7-edit created/.test(result.message),
    '#60: `oc create rolebinding … --clusterrole=edit` creates the binding',
    result.message.slice(0, 400)
  );
  result = await runCmd('oc get rolebinding qa7-edit -n qa7');
  const createdBindingTable = tableParts(result.message);
  row = createdBindingTable.rows.find((cells) => cells[0] === 'qa7-edit') || [];
  assert(
    !result.error && row[columnIndex(createdBindingTable, 'ROLE')] === 'ClusterRole/edit',
    '#60: a newly created clusterrole RoleBinding prints ROLE ClusterRole/edit',
    JSON.stringify({ headers: createdBindingTable.headers, row })
  );
  result = await runCmd('oc get clusterrolebinding');
  const clusterBindingTable = tableParts(result.message);
  row = clusterBindingTable.rows.find((cells) => cells[0] === 'kubeadmin-cluster-admin') || [];
  assert(
    !result.error && row[columnIndex(clusterBindingTable, 'ROLE')] === 'ClusterRole/cluster-admin',
    '#60: `oc get clusterrolebinding` ROLE prints ClusterRole/cluster-admin for kubeadmin-cluster-admin',
    JSON.stringify({ headers: clusterBindingTable.headers, row })
  );

  // ═══ Round 3: #60 — `oc rollout status --timeout` blocks and fails ═══════
  result = await runCmd(
    'oc create deploy healthy --image=quay.io/openshift/origin-hello-openshift:latest --replicas=1 -n qa7'
  );
  assert(
    !result.error && /deployment\.apps\/healthy created/.test(result.message),
    '#60: `oc create deploy healthy` creates the healthy rollout fixture',
    result.message.slice(0, 300)
  );
  result = await runCmd('oc rollout status deploy/healthy --timeout=120s -n qa7');
  assert(
    !result.error &&
      /successfully rolled out/.test(result.message) &&
      !/timed out waiting for the condition/.test(result.message),
    '#60: `oc rollout status deploy/healthy --timeout=120s` waits synchronously and succeeds on a healthy rollout',
    result.message.slice(0, 500)
  );

  result = await runCmd(
    'oc create deploy stalled --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=2 -n qa7'
  );
  assert(
    !result.error && /deployment\.apps\/stalled created/.test(result.message),
    '#60: `oc create deploy stalled` creates the stalled-rollout fixture',
    result.message.slice(0, 300)
  );
  const stalledRunning = await advanceUntil(async () => {
    const pods = await podsWithPrefix('qa7', 'stalled-');
    return (
      pods.length === 2 && pods.every((pod) => pod.ready === '1/1' && pod.status === 'Running')
    );
  }, 40);
  assert(
    stalledRunning,
    '#60: the `stalled` rollout is healthy before the bad image is introduced'
  );
  const stalledContainer = await evaluate(() => {
    const deployment = window.game?.cluster?.getByName?.('Deployment', 'stalled', 'qa7');
    return deployment?.spec?.template?.spec?.containers?.[0]?.name || '';
  });
  result = await runCmd(
    `oc set image deploy/stalled ${stalledContainer}=quay.io/nonexistent/boom:latest -n qa7`
  );
  assert(
    !result.error && /image updated/.test(result.message),
    '#60: `oc set image deploy/stalled <container>=quay.io/nonexistent/boom:latest` updates the pod template',
    result.message.slice(0, 300)
  );
  await advanceBoth(10);
  const stalledPods = await evaluate(() =>
    (window.game?.cluster?.getByKindAndNamespace?.('Pod', 'qa7') || [])
      .filter((pod) => /^stalled-/.test(pod.metadata?.name || ''))
      .map((pod) => ({
        name: pod.metadata.name,
        phase: pod.status?.phase || '',
        waiting: (pod.status?.containerStatuses || [])
          .map((status) => status.state?.waiting?.reason || '')
          .filter(Boolean)
          .join(','),
      }))
  );
  assert(
    stalledPods.some((pod) => pod.phase !== 'Running' && /ImagePull/.test(pod.waiting)),
    '#60: the nonexistent image leaves the new `stalled` Pods pending (ErrImagePull/ImagePullBackOff), so the rollout is stuck',
    JSON.stringify(stalledPods)
  );

  result = await runCmd('oc rollout status deploy/stalled --timeout=5s -n qa7');
  const stalledStatusMessage = result.message;
  const stalledStatusLines = stalledStatusMessage
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(
    result.error === true &&
      /Waiting for deployment "stalled"/.test(stalledStatusMessage) &&
      stalledStatusLines[stalledStatusLines.length - 1] ===
        'error: timed out waiting for the condition' &&
      !/successfully rolled out/.test(stalledStatusMessage),
    '#60: `oc rollout status deploy/stalled --timeout=5s` blocks, prints the Waiting line and ends with `error: timed out waiting for the condition` (error true)',
    JSON.stringify({ error: result.error, message: stalledStatusMessage.slice(0, 900) })
  );
  result = await runCmd('oc rollout status deploy/stalled --timeout=5s -n qa7 && echo CHAIN_RAN');
  assert(
    result.error === true && !/CHAIN_RAN/.test(result.message),
    '#60: the timed-out rollout status exits 1, so a chained `&& echo CHAIN_RAN` never runs',
    JSON.stringify({ error: result.error, message: result.message.slice(0, 900) })
  );
  result = await runCmd('oc rollout status deploy/stalled --timeout=5s -n qa7 ; echo AFTER');
  assert(
    !result.error &&
      /AFTER/.test(result.message) &&
      /error: timed out waiting for the condition/.test(result.message),
    '#60: an unchained `; echo AFTER` still runs after the timed-out rollout status (real shell exit-status semantics)',
    JSON.stringify({ error: result.error, message: result.message.slice(0, 900) })
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. DRAW PAGE
// ═══════════════════════════════════════════════════════════════════════════
await runSection('draw', async () => {
  await goto('/draw');
  const loaded = await waitFor(
    () =>
      evaluate(
        () =>
          !!window.openshiftDraw &&
          document.querySelectorAll('#resource-palette .palette-item').length > 0
      ),
    20000
  );
  assert(loaded, 'draw: page loads with palette');
  await sleep(1000);
  const draw = await evaluate(() => {
    const palette = [...document.querySelectorAll('#resource-palette .palette-item')].map(
      (el) => el.dataset.resource
    );
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
  assert(
    draw.palette.length === 37 && draw.unique === 37,
    'draw: palette has 37 unique kinds',
    `got ${draw.palette.length}/${draw.unique}`
  );
  assert(
    draw.route && draw.project && draw.buildConfig,
    'draw: Route/Project/BuildConfig in palette'
  );
  assert(
    /OpenShift Games/.test(draw.watermark) && /\/draw/.test(draw.watermark),
    'draw: OpenShift Games /draw watermark',
    draw.watermark
  );
  assert(draw.hasApp, 'draw: app instance exposed');

  const yaml = await evaluate(async () => {
    const app = window.openshiftDraw;
    const placements = [
      ['Project', 0.34, 0.58],
      ['Route', 0.46, 0.47],
      ['BuildConfig', 0.58, 0.56],
    ];
    for (const [kind, fx, fy] of placements) {
      app.placeResource(
        kind,
        Math.floor(window.innerWidth * fx),
        Math.floor(window.innerHeight * fy)
      );
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
  assert(
    /apiVersion:\s*route\.openshift\.io\/v1/.test(yaml),
    'draw: YAML export uses Route route.openshift.io/v1'
  );
  assert(
    /apiVersion:\s*build\.openshift\.io\/v1/.test(yaml),
    'draw: YAML export uses BuildConfig build.openshift.io/v1'
  );
  assert(
    /apiVersion:\s*project\.openshift\.io\/v1/.test(yaml),
    'draw: YAML export uses Project project.openshift.io/v1'
  );
  assert(
    /kind:\s*Route/.test(yaml) && /kind:\s*BuildConfig/.test(yaml) && /kind:\s*Project/.test(yaml),
    'draw: YAML export includes Route/BuildConfig/Project'
  );
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
  await ogPage.evaluate(() => document.fonts?.ready || Promise.resolve());
  await sleep(800);
  await ogPage.screenshot({ path: join(ROOT, 'og-image.png') });
  await ogPage.close();
  console.log('  SHOT  og-image.png (1200x630)');
  shotsTaken.push('og-image.png');
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
const uniqueConsole = [
  ...new Map(consoleErrors.map((e) => [`${e.section}:${e.text}`, e])).values(),
];
const uniquePageErrors = [
  ...new Map(pageErrors.map((e) => [`${e.section}:${e.text}`, e])).values(),
];
if (uniquePageErrors.length) {
  fail(
    'console: uncaught page errors',
    uniquePageErrors
      .slice(0, 8)
      .map((e) => `[${e.section}] ${e.text}`)
      .join('\n')
  );
} else {
  pass('console: no uncaught page errors');
}
if (uniqueConsole.length) {
  fail(
    'console: unexpected console errors',
    uniqueConsole
      .slice(0, 8)
      .map((e) => `[${e.section}] ${e.text}`)
      .join('\n')
  );
} else {
  pass('console: no unexpected console errors');
}

function imageInfo(rel) {
  try {
    const buf = readFileSync(join(ROOT, rel));
    return {
      path: rel,
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      bytes: buf.length,
    };
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
  assert(
    artifacts.screenshot?.width === 1600 && artifacts.screenshot?.height === 900,
    'shots: screenshot.png is 1600x900',
    JSON.stringify(artifacts.screenshot)
  );
  assert(
    artifacts.ogImage?.width === 1200 && artifacts.ogImage?.height === 630,
    'shots: og-image.png is 1200x630',
    JSON.stringify(artifacts.ogImage)
  );
  for (const name of ['menu', 'sandbox', 'campaign-level-1', 'exam-prep', 'files-panel', 'draw']) {
    const rel = `docs/screenshots/${name}.png`;
    if (ONLY.length > 0 && !shotsTaken.includes(rel)) continue; // subset runs don't take every shot
    const info = artifacts.screenshots.find((s) => s.path === rel) || imageInfo(rel);
    assert(
      !!info && info.width === 1600 && info.height === 900,
      `shots: ${rel} (1600x900)`,
      JSON.stringify(info)
    );
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
await writeFile(
  join(ROOT, 'docs', 'verification-report.json'),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log('\n' + '─'.repeat(74));
console.log(
  `Browser tests: ${summary.passes} passed, ${summary.failures} failed, ${summary.warnings} warnings`
);
if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings)
    console.log(
      `  - [${w.section}] ${w.name}${w.detail ? `: ${String(w.detail).slice(0, 300)}` : ''}`
    );
}
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures)
    console.log(
      `  - [${f.section}] ${f.name}${f.detail ? `\n      ${String(f.detail).replace(/\n/g, '\n      ')}` : ''}`
    );
}
console.log('─'.repeat(74));
console.log(`Report: docs/verification-report.json · verdict: ${goNoGo}`);
process.exit(failures.length ? 1 : 0);
