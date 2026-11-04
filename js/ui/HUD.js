/**
 * HUD — in-game top bar for the OpenShift Games cluster view (OCP 4.22 / EX280).
 *
 * One 52px flat bar: pause/menu, product wordmark, platform + mode + level,
 * mission progress, cluster health, simulated clock, speed, pause, incidents
 * and settings. The resource counters and CPU/MEM meters live in a calm
 * "Cluster" popover instead of cluttering the bar.
 *
 * Test/legacy contract preserved (ids used by index.html and by the browser
 * acceptance suite): `hud-logo`, `hud-mode`, `hud-menu`, `hud-health`,
 * `hud-timer`, `hud-level`, `hud-xp-bar`, `hud-pause*`, `hud-speed-1/2/4`,
 * `hud-alert-badge`, `hud-alerts`, `hud-settings`, `hud-mode-name`,
 * `hud-projects`, `hud-workloads`, `hud-routes`, `hud-builds`, `hud-nodes`,
 * `hud-pods-running/pending/failed`, `hud-deployments`, `hud-services`,
 * `hud-cpu-bar/text`, `hud-mem-bar/text`.
 *
 * The bar also carries two compact view controls — "Mine N" (+ frame action) for
 * the resources the player created, and "Platform N" for the seeded OpenShift
 * defaults (hidden by default in campaign/timed-lab sessions). `ResourceSpotlight`
 * owns both presentation rules, the counts and the creation feedback. `destroy()`
 * tears the spotlight down too (dropping the renderer's ownership/platform chrome
 * before the start-page hero is rebuilt).
 *
 * All engine subscriptions are idempotent: `init()` re-creates the DOM and
 * re-binds; `destroy()` removes every listener. The HUD also consumes
 * `engine:stopped` so `returnToMenu()` / `engine.reset()` never leak listeners.
 */

import { XP_LEVELS } from '../engine/ScoringEngine.js';
import { SettingsPanel } from './SettingsPanel.js';
import { ResourceSpotlight } from './ResourceSpotlight.js';

const PLATFORM_LABEL = 'OpenShift 4.22';
const MODE_LABELS = {
  campaign: 'Campaign',
  challenge: 'Timed lab',
  chaos: 'Chaos',
  sandbox: 'Sandbox',
};
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'];

const SVG = {
  menu: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke-linecap="round"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="1"/><rect x="9.4" y="3" width="2.6" height="10" rx="1"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.6c0-.8.9-1.3 1.6-.9l6 4.4c.6.4.6 1.4 0 1.8l-6 4.4c-.7.4-1.6-.1-1.6-.9V3.6z"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4.3 6.8a3.7 3.7 0 017.4 0v2.4l1.1 1.7H3.2l1.1-1.7V6.8z" stroke-linejoin="round"/><path d="M6.5 12.6a1.6 1.6 0 003 0" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1 1M11.3 11.3l1 1M12.3 3.7l-1 1M4.7 11.3l-1 1" stroke-linecap="round"/></svg>',
  mark: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.4" stroke-opacity=".28"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/></svg>',
  chevron:
    '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7l2-2 2 2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  frame:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.4 5.4V3.9a1.5 1.5 0 0 1 1.5-1.5h1.5M10.6 2.4h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5M13.6 10.6v1.5a1.5 1.5 0 0 1-1.5 1.5h-1.5M5.4 13.6H3.9a1.5 1.5 0 0 1-1.5-1.5v-1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none"/></svg>',
};

export class HUD {
  constructor() {
    this.container = null;
    this.elements = {};
    this.speed = 1;
    this.paused = false;
    this.elapsedTime = 0;
    this.incidentCount = 0;
    this.xp = 0;
    this.level = 1;
    this.xpToNextLevel = 100;
    this.xpProgress = 0;
    this.settingsPanel = null;
    this.spotlight = null;
    this.mineCount = 0;
    this.mineMode = false;
    this.platformCount = 0;
    this.platformRevealed = true;
    this._popOpen = false;

    this._boundTick = this._onTick.bind(this);
    this._boundIncident = this._onIncident.bind(this);
    this._boundResolve = this._onResolve.bind(this);
    this._boundXP = this._onXPGain.bind(this);
    this._boundSelect = this._onResourceSelect.bind(this);
    this._boundAchievement = this._onAchievement.bind(this);
    this._boundStopped = this._onEngineStopped.bind(this);
    this._boundPauseState = this._onPauseState.bind(this);
    this._boundDocumentClick = this._onDocumentClick.bind(this);
    this._boundKeydown = this._onKeydown.bind(this);
    this._engineAttached = false;
    this._engineRef = null;

    this._logoClickCount = 0;
    this._logoClickTimer = null;
    this._partyModeActive = false;
    this._partyModeTarget = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  init() {
    if (this.container) this.destroy();

    this.elements = {};
    this.speed = 1;
    this.paused = false;
    this.elapsedTime = 0;
    this.incidentCount = 0;
    this.xpProgress = 0;
    this._popOpen = false;

    this.container = document.createElement('div');
    this.container.id = 'hud';
    this.container.className = 'hud';
    this.container.setAttribute('data-testid', 'hud');
    this.container.setAttribute('role', 'banner');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);

    this._cacheElements();
    this._bindEvents();
    this._bindGameEvents();
    this._syncIncidentCount();
    this._syncXPFromScoring();
    this._updateAll();
    this._updatePausedIndicator();

    this.settingsPanel = new SettingsPanel();
    this.settingsPanel.init();

    // "Mine" discovery layer: ownership rule + creation spotlight. Created from
    // HUD.init() so index.html needs no extra wiring; safe when there is no 3D
    // renderer (the count still works, the 3D calls are no-ops).
    try {
      this.spotlight = new ResourceSpotlight(this);
      this.spotlight.init();
    } catch (err) {
      console.warn('HUD: ResourceSpotlight failed to initialise', err);
      this.spotlight = null;
    }

    document.addEventListener('click', this._boundDocumentClick);
    document.addEventListener('keydown', this._boundKeydown, true);
  }

  destroy() {
    clearTimeout(this._logoClickTimer);
    clearTimeout(this._partyModeTimeout);
    try {
      this.spotlight?.destroy();
    } catch (err) {
      console.warn('HUD: ResourceSpotlight teardown failed', err);
    }
    this.spotlight = null;
    this.mineCount = 0;
    this.mineMode = false;
    this._unbindGameEvents();
    this.settingsPanel?.destroy();
    this.settingsPanel = null;
    document.removeEventListener('click', this._boundDocumentClick);
    document.removeEventListener('keydown', this._boundKeydown, true);

    if (this._partyModeTarget) {
      try {
        this._partyModeTarget.classList.remove('party-mode');
      } catch {
        /* detached node */
      }
      this._partyModeTarget = null;
    }
    document.getElementById('party-mode-style')?.remove();

    this.container?.remove();
    this.container = null;
    this.elements = {};
    this._partyModeActive = false;
    this._logoClickCount = 0;
  }

  // ─── Engine references ─────────────────────────────────────────────────

  _bus() {
    return window.game?.engine || window.game?.app?.engine?.eventBus || null;
  }

  _gameEngine() {
    return window.game?.gameEngine || window.game?.app?.engine || null;
  }

  _cluster() {
    return window.game?.cluster || window.game?.app?.engine?.cluster || null;
  }

  _app() {
    return window.game?.app || window.game?.app;
  }

  // ─── Markup ────────────────────────────────────────────────────────────

  _buildHTML() {
    return `
      <div class="hud-bar">
        <div class="hud-left">
          <button id="hud-menu" class="hud-icon-btn hud-menu-btn" type="button" title="Pause &amp; menu (Esc)" aria-label="Pause and open menu" data-testid="hud-menu">
            ${SVG.menu}
          </button>
          <div class="hud-brand">
            <span class="hud-mark">${SVG.mark}</span>
            <span id="hud-logo-text" class="hud-word" data-testid="hud-logo">OpenShift Games</span>
          </div>
          <span class="hud-rule" aria-hidden="true"></span>
          <span id="hud-mode" class="hud-mode" data-testid="hud-mode">${PLATFORM_LABEL}</span>
          <span id="hud-mode-name" class="hud-mode-name" data-testid="hud-mode-name">Sandbox</span>
          <span class="hud-rule hud-rule-optional" aria-hidden="true"></span>
          <span id="hud-level-name" class="hud-level-name"></span>
        </div>

        <div class="hud-center">
          <button id="hud-mission" class="hud-mission" type="button" title="Show mission objectives" hidden>
            <span class="hud-mission-text">
              <span id="hud-mission-count" class="hud-mission-count">0 / 0 objectives</span>
              <span class="hud-mission-bar" aria-hidden="true"><span id="hud-mission-fill" class="hud-mission-fill"></span></span>
            </span>
          </button>
        </div>

        <div class="hud-right">
          <div class="hud-mine-group">
            <button id="hud-mine" class="hud-mine" type="button" data-testid="hud-mine" aria-pressed="false" title="Show only resources you created" aria-label="Show only resources you created">
              <span class="hud-mine-dot" aria-hidden="true"></span>
              <span class="hud-mine-label">Mine</span>
              <span id="hud-mine-count" class="hud-mine-count" data-testid="hud-mine-count">0</span>
            </button>
            <button id="hud-mine-focus" class="hud-icon-btn hud-mine-focus" type="button" data-testid="hud-mine-focus" title="Frame my resources" aria-label="Frame my resources">
              ${SVG.frame}
            </button>
          </div>
          <button id="hud-platform" class="hud-platform" type="button" data-testid="hud-platform" aria-pressed="true" title="Hide seeded OpenShift platform defaults" aria-label="Hide seeded OpenShift platform defaults">
            <span class="hud-platform-dot" aria-hidden="true"></span>
            <span class="hud-platform-label">Platform</span>
            <span id="hud-platform-count" class="hud-platform-count" data-testid="hud-platform-count">0</span>
          </button>
          <span class="hud-rule" aria-hidden="true"></span>
          <button id="hud-health" class="hud-health" type="button" title="Cluster health" aria-label="Cluster health (open cluster stats)" data-testid="hud-health" aria-expanded="false">
            <span id="hud-health-dot" class="hud-health-dot"></span>
            <span id="hud-health-label" class="hud-health-label">Healthy</span>
          </button>
          <span class="hud-rule" aria-hidden="true"></span>
          <span id="hud-timer" class="hud-timer" data-testid="hud-timer">00:00</span>
          <!-- Visible pause state: overlays (Files, guide, EX280 Prep) freeze the
               simulation clock; without this chip the freeze looks like a bug. -->
          <span id="hud-paused" class="hud-paused-chip" data-testid="hud-paused" role="status" aria-live="polite" hidden>
            <span class="hud-paused-icon" aria-hidden="true">${SVG.pause}</span>
            <span class="hud-paused-label">Paused</span>
            <span id="hud-paused-reason" class="hud-paused-reason"></span>
          </span>
          <div class="hud-speed" role="group" aria-label="Simulation speed">
            <button id="hud-speed-1" class="hud-speed-btn is-active" type="button" title="Normal speed" data-testid="hud-speed-1">1x</button>
            <button id="hud-speed-2" class="hud-speed-btn" type="button" title="Double speed" data-testid="hud-speed-2">2x</button>
            <button id="hud-speed-4" class="hud-speed-btn" type="button" title="Quadruple speed" data-testid="hud-speed-4">4x</button>
          </div>
          <button id="hud-pause" class="hud-icon-btn" type="button" title="Pause simulation" aria-label="Pause simulation" data-testid="hud-pause">
            <span id="hud-pause-icon">${SVG.pause}</span>
          </button>
          <button id="hud-alerts" class="hud-icon-btn hud-alert-btn" type="button" title="OpenShift incidents" aria-label="OpenShift incidents" aria-expanded="false" aria-controls="incident-panel" data-testid="hud-alerts">
            ${SVG.bell}
            <span id="hud-alert-badge" class="hud-badge" data-testid="hud-alert-badge" hidden>0</span>
          </button>
          <button id="hud-settings" class="hud-icon-btn" type="button" title="Settings" aria-label="Settings" data-testid="hud-settings">
            ${SVG.gear}
          </button>
        </div>
      </div>

      <div id="hud-cluster-pop" class="hud-pop" hidden>
        <div class="hud-pop-head">
          <span>Cluster</span>
          <span class="hud-pop-version">${PLATFORM_LABEL}</span>
        </div>
        <dl class="hud-stat-grid">
          <div class="hud-stat"><dt>Projects</dt><dd id="hud-projects" data-testid="hud-projects">0</dd></div>
          <div class="hud-stat"><dt>Workloads</dt><dd id="hud-workloads" data-testid="hud-workloads">0</dd></div>
          <div class="hud-stat"><dt>Routes</dt><dd id="hud-routes" data-testid="hud-routes">0</dd></div>
          <div class="hud-stat"><dt>Builds</dt><dd id="hud-builds" data-testid="hud-builds">0</dd></div>
          <div class="hud-stat"><dt>Nodes</dt><dd id="hud-nodes" data-testid="hud-nodes">0</dd></div>
          <div class="hud-stat"><dt>Deployments</dt><dd id="hud-deployments" data-testid="hud-deployments">0</dd></div>
          <div class="hud-stat"><dt>Services</dt><dd id="hud-services" data-testid="hud-services">0</dd></div>
          <div class="hud-stat hud-stat-pods">
            <dt>Pods</dt>
            <dd><span id="hud-pods-running" class="is-good" data-testid="hud-pods-running">0</span><span class="hud-slash">/</span><span id="hud-pods-pending" class="is-warn" data-testid="hud-pods-pending">0</span><span class="hud-slash">/</span><span id="hud-pods-failed" class="is-bad" data-testid="hud-pods-failed">0</span></dd>
          </div>
        </dl>
        <div class="hud-meters">
          <div class="hud-meter">
            <div class="hud-meter-head"><span>CPU</span><span id="hud-cpu-text" class="hud-meter-value">0%</span></div>
            <div class="hud-meter-track"><div id="hud-cpu-bar" class="hud-meter-fill" style="width:0%"></div></div>
          </div>
          <div class="hud-meter">
            <div class="hud-meter-head"><span>Memory</span><span id="hud-mem-text" class="hud-meter-value">0%</span></div>
            <div class="hud-meter-track"><div id="hud-mem-bar" class="hud-meter-fill" style="width:0%"></div></div>
          </div>
        </div>
        <div class="hud-xp" id="hud-xp-container">
          <span id="hud-level" class="hud-xp-level">L1</span>
          <span class="hud-xp-track"><span id="hud-xp-bar" class="hud-xp-fill"></span></span>
          <span id="hud-xp-label" class="hud-xp-label">0 XP</span>
        </div>
      </div>
    `;
  }

  _cacheElements() {
    const ids = [
      'hud-menu',
      'hud-settings',
      'hud-health',
      'hud-health-dot',
      'hud-health-label',
      'hud-nodes',
      'hud-projects',
      'hud-workloads',
      'hud-routes',
      'hud-builds',
      'hud-pods-running',
      'hud-pods-pending',
      'hud-pods-failed',
      'hud-deployments',
      'hud-services',
      'hud-mode-name',
      'hud-cpu-bar',
      'hud-cpu-text',
      'hud-mem-bar',
      'hud-mem-text',
      'hud-timer',
      'hud-mode',
      'hud-paused',
      'hud-paused-reason',
      'hud-level',
      'hud-xp-bar',
      'hud-pause',
      'hud-pause-icon',
      'hud-speed-1',
      'hud-speed-2',
      'hud-speed-4',
      'hud-alert-badge',
      'hud-alerts',
      'hud-xp-container',
      'hud-logo-text',
      'hud-mission',
      'hud-mission-count',
      'hud-mission-fill',
      'hud-level-name',
      'hud-cluster-pop',
      'hud-mine',
      'hud-mine-count',
      'hud-mine-focus',
      'hud-platform',
      'hud-platform-count',
    ];
    for (const id of ids) {
      this.elements[id] =
        this.container?.querySelector(`#${id}`) || document.getElementById(id) || null;
    }
  }

  _bindEvents() {
    const on = (id, event, handler) => {
      const el = this.elements[id] || this.container?.querySelector(`#${id}`);
      if (el) el.addEventListener(event, handler);
    };

    on('hud-menu', 'click', () => {
      this._closePopover();
      window.game?.app?.showPause?.();
    });
    on('hud-settings', 'click', () => this.settingsPanel?.toggle());
    on('hud-pause', 'click', () => this._togglePause());
    on('hud-speed-1', 'click', () => this._setSpeed(1));
    on('hud-speed-2', 'click', () => this._setSpeed(2));
    on('hud-speed-4', 'click', () => this._setSpeed(4));
    on('hud-alerts', 'click', () => {
      this._closePopover();
      try {
        this._bus()?.emit?.('ui:toggle-incidents');
      } catch {
        /* no incident panel */
      }
    });
    on('hud-mine', 'click', () => {
      this._closePopover();
      this.spotlight?.toggleMineMode();
    });
    on('hud-mine-focus', 'click', () => {
      this._closePopover();
      this.spotlight?.frameMine();
    });
    on('hud-platform', 'click', () => {
      this._closePopover();
      this.spotlight?.togglePlatform();
    });
    on('hud-health', 'click', (event) => {
      event.stopPropagation();
      this._togglePopover();
    });
    on('hud-mission', 'click', () => {
      const toggle = document.getElementById('obj-panel-toggle');
      if (toggle) toggle.click();
      else document.getElementById('objectives-panel')?.classList.toggle('collapsed');
    });

    const logoText = this.elements['hud-logo-text'];
    if (logoText) {
      logoText.style.cursor = 'pointer';
      logoText.addEventListener('click', () => this._onLogoClick());
    }
  }

  _onDocumentClick(event) {
    if (!this._popOpen) return;
    if (event.target.closest?.('#hud-cluster-pop') || event.target.closest?.('#hud-health')) return;
    this._closePopover();
  }

  _onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (this._popOpen) {
      this._closePopover();
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    // Esc exits the mine-only focus before it opens the pause menu: the mode is
    // a view filter, and leaving it should not cost the player their flow.
    if (this.mineMode) {
      this.spotlight?.setMineMode(false);
      event.stopPropagation();
      event.preventDefault();
    }
  }

  _togglePopover() {
    this._popOpen = !this._popOpen;
    const pop =
      this.elements['hud-cluster-pop'] || this.container?.querySelector('#hud-cluster-pop');
    const health = this.elements['hud-health'];
    if (pop) pop.hidden = !this._popOpen;
    health?.setAttribute('aria-expanded', String(this._popOpen));
    health?.classList.toggle('is-open', this._popOpen);
  }

  _closePopover() {
    if (!this._popOpen) return;
    this._popOpen = false;
    const pop =
      this.elements['hud-cluster-pop'] || this.container?.querySelector('#hud-cluster-pop');
    const health = this.elements['hud-health'];
    if (pop) pop.hidden = true;
    health?.setAttribute('aria-expanded', 'false');
    health?.classList.remove('is-open');
  }

  _bindGameEvents() {
    const bus = this._bus();
    if (!bus || this._engineAttached) return;
    this._engineRef = bus;
    this._engineAttached = true;
    bus.on('tick', this._boundTick);
    bus.on('incident:created', this._boundIncident);
    bus.on('incident:resolved', this._boundResolve);
    bus.on('xp:gain', this._boundXP);
    bus.on('resource:selected', this._boundSelect);
    bus.on('achievement:unlocked', this._boundAchievement);
    bus.on('engine:paused', this._boundPauseState);
    bus.on('engine:resumed', this._boundPauseState);
    bus.on('engine:stopped', this._boundStopped);
  }

  _unbindGameEvents() {
    const bus = this._engineRef;
    if (bus) {
      bus.off?.('tick', this._boundTick);
      bus.off?.('incident:created', this._boundIncident);
      bus.off?.('incident:resolved', this._boundResolve);
      bus.off?.('xp:gain', this._boundXP);
      bus.off?.('resource:selected', this._boundSelect);
      bus.off?.('achievement:unlocked', this._boundAchievement);
      bus.off?.('engine:paused', this._boundPauseState);
      bus.off?.('engine:resumed', this._boundPauseState);
      bus.off?.('engine:stopped', this._boundStopped);
    }
    this._engineRef = null;
    this._engineAttached = false;
  }

  _onEngineStopped() {
    this.destroy();
  }

  // ─── Visible pause state ────────────────────────────────────────────────
  /**
   * Overlays that cover a live run (Files & Manifests, the guide, EX280 Prep,
   * the pause card) freeze the simulation and the mission clock through the
   * app's clock-pause arbitration. This chip keeps that freeze visible so OLM
   * installs / rollouts don't look stuck (GitHub issue #20).
   */
  _onPauseState() {
    this._updatePausedIndicator();
  }

  _pauseReasonLabel() {
    const app = window.game?.app;
    const reasons = app?._clockPauseReasons;
    const has = (reason) =>
      Boolean(reasons && typeof reasons.has === 'function' && reasons.has(reason));
    if (has('files')) return 'Files open';
    if (has('tutorial')) return 'Guide open';
    if (has('examprep')) return 'EX280 Prep';
    if (has('pause')) return 'Pause card';
    if (reasons && typeof reasons.size === 'number' && reasons.size > 0) return 'Overlay open';
    return '';
  }

  _updatePausedIndicator() {
    const chip = this.elements['hud-paused'] || this.container?.querySelector('#hud-paused');
    const reasonEl =
      this.elements['hud-paused-reason'] || this.container?.querySelector('#hud-paused-reason');
    if (!chip) return;
    const app = window.game?.app;
    const gameEngine = this._gameEngine();
    const state = String(gameEngine?.state || '').toLowerCase();
    const reason = this._pauseReasonLabel();
    const paused = Boolean(reason) || state === 'paused';
    chip.hidden = !paused;
    chip.classList.toggle('is-visible', paused);
    if (reasonEl) reasonEl.textContent = reason;
    if (paused) {
      chip.title = reason ? `Simulation paused — ${reason}` : 'Simulation paused';
      chip.setAttribute(
        'aria-label',
        reason ? `Simulation paused: ${reason}` : 'Simulation paused'
      );
    } else {
      chip.removeAttribute('title');
      chip.removeAttribute('aria-label');
    }
    // Mirror the pause state on the pause button so the icon is honest even
    // when another surface (not the button) paused the run.
    const button = this.elements['hud-pause'];
    const icon = this.elements['hud-pause-icon'];
    if (button) {
      button.classList.toggle('is-paused', paused);
      button.title = paused ? 'Resume simulation' : 'Pause simulation';
      button.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
    }
    if (icon) icon.innerHTML = paused ? SVG.play : SVG.pause;
  }

  // ─── Updates ───────────────────────────────────────────────────────────

  _onTick(state) {
    const data = state || {};
    this.elapsedTime = Number.isFinite(data.elapsed) ? data.elapsed : this.elapsedTime;
    this._updateResourceCounts(data);
    this._updateMetrics(data);
    this._updateTimer();
    this._updateHealth(data);
    this._updateMode(data);
    this._updateMission();
  }

  _onIncident() {
    this.incidentCount += 1;
    this._updateAlertBadge();
  }

  _onResolve() {
    this.incidentCount = Math.max(0, this.incidentCount - 1);
    this._updateAlertBadge();
  }

  _onXPGain(data) {
    const scoring = window.game?.scoringEngine;
    if (scoring && typeof scoring.getLevelInfo === 'function') {
      try {
        const info = scoring.getLevelInfo();
        this.level = info.level;
        this.xp = info.currentXP;
        this.xpProgress = info.xpProgress;
      } catch {
        this.xp += data?.amount || 0;
      }
    } else {
      this.xp += data?.amount || 0;
    }
    this._updateXP();
  }

  _onAchievement(data) {
    if (!data) return;
    this._showAchievementToast(data);
  }

  _onResourceSelect() {
    this._updateAll();
  }

  _setText(id, value) {
    const el = this.elements[id] || this.container?.querySelector(`#${id}`) || null;
    if (!el) return;
    el.textContent = String(value);
    this.elements[id] = el;
  }

  _updateResourceCounts() {
    const cluster = this._cluster();
    if (!cluster) return;

    const count = (kind) => {
      try {
        const list = cluster.getResourcesByKind?.(kind) || cluster.getByKind?.(kind) || [];
        return Array.isArray(list) ? list.length : 0;
      } catch {
        return 0;
      }
    };

    const projects = count('Project');
    const routes = count('Route');
    const builds = count('Build');
    const nodes = count('Node');
    const deployments = count('Deployment');
    const services = count('Service');
    const workloads = WORKLOAD_KINDS.reduce((sum, kind) => sum + count(kind), 0);

    this._setText('hud-projects', projects);
    this._setText('hud-workloads', workloads);
    this._setText('hud-routes', routes);
    this._setText('hud-builds', builds);
    this._setText('hud-nodes', nodes);
    this._setText('hud-deployments', deployments);
    this._setText('hud-services', services);

    let running = 0;
    let pending = 0;
    let failed = 0;
    let pods = [];
    try {
      pods = cluster.getResourcesByKind?.('Pod') || cluster.getByKind?.('Pod') || [];
    } catch {
      pods = [];
    }
    for (const pod of pods) {
      const phase = pod.status?.phase || 'Pending';
      if (phase === 'Running') running += 1;
      else if (phase === 'Pending') pending += 1;
      else if (phase === 'Failed' || phase === 'CrashLoopBackOff') failed += 1;
    }
    this._setText('hud-pods-running', running);
    this._setText('hud-pods-pending', pending);
    this._setText('hud-pods-failed', failed);
  }

  _updateMetrics(state) {
    const cpuRaw = Number(state?.metrics?.cpu);
    const memRaw = Number(state?.metrics?.memory);
    const cpuPct = Number.isFinite(cpuRaw) ? Math.min(100, Math.max(0, Math.round(cpuRaw))) : 0;
    const memPct = Number.isFinite(memRaw) ? Math.min(100, Math.max(0, Math.round(memRaw))) : 0;

    const cpuBar = this.elements['hud-cpu-bar'];
    const memBar = this.elements['hud-mem-bar'];
    if (cpuBar) {
      cpuBar.style.width = `${cpuPct}%`;
      cpuBar.dataset.level = this._metricLevel(cpuPct);
    }
    if (memBar) {
      memBar.style.width = `${memPct}%`;
      memBar.dataset.level = this._metricLevel(memPct);
    }
    this._setText('hud-cpu-text', `${cpuPct}%`);
    this._setText('hud-mem-text', `${memPct}%`);
  }

  _metricLevel(pct) {
    if (pct > 85) return 'high';
    if (pct > 65) return 'mid';
    return 'low';
  }

  _updateTimer() {
    const totalSeconds = Math.max(0, Math.floor(this.elapsedTime / 1000));
    const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    this._setText('hud-timer', `${mins}:${secs}`);
  }

  _updateHealth(state) {
    const dot = this.elements['hud-health-dot'] || this.container?.querySelector('#hud-health-dot');
    const label =
      this.elements['hud-health-label'] || this.container?.querySelector('#hud-health-label');
    const button = this.elements['hud-health'];
    if (!dot) return;
    let health = state?.clusterHealth ?? 'healthy';
    if (health && typeof health === 'object') {
      const degraded = Array.isArray(health.degraded) ? health.degraded.length : 0;
      const percent = Number(health.percent);
      health =
        degraded > 0
          ? 'critical'
          : Number.isFinite(percent) && percent < 100
            ? 'warning'
            : 'healthy';
    }
    const labelText =
      health === 'critical' ? 'Degraded' : health === 'warning' ? 'Warning' : 'Healthy';
    dot.dataset.health = health;
    if (label) label.textContent = labelText;
    if (button)
      button.setAttribute('aria-label', `Cluster health: ${labelText} (open cluster stats)`);
    this._setText('hud-pop-health', labelText);
  }

  _updateAlertBadge() {
    const badge = this.elements['hud-alert-badge'];
    const button = this.elements['hud-alerts'];
    if (!badge) return;
    if (this.incidentCount > 0) {
      badge.hidden = false;
      badge.textContent = this.incidentCount > 99 ? '99+' : String(this.incidentCount);
      badge.title = `${this.incidentCount} active OpenShift incident${this.incidentCount === 1 ? '' : 's'}`;
      button?.classList.add('has-alert');
      button?.setAttribute(
        'aria-label',
        `${this.incidentCount} active OpenShift incident${this.incidentCount === 1 ? '' : 's'} (open incidents panel)`
      );
    } else {
      badge.hidden = true;
      badge.textContent = '0';
      badge.title = 'No active incidents';
      button?.classList.remove('has-alert');
      button?.setAttribute('aria-label', 'OpenShift incidents');
    }
  }

  _syncIncidentCount() {
    const incidentEngine = window.game?.incidentEngine;
    if (!incidentEngine || typeof incidentEngine.getActiveIncidents !== 'function') {
      this._updateAlertBadge();
      return;
    }
    try {
      this.incidentCount = incidentEngine.getActiveIncidents().length;
    } catch {
      this.incidentCount = 0;
    }
    this._updateAlertBadge();
  }

  _syncXPFromScoring() {
    const scoring = window.game?.scoringEngine;
    if (scoring && typeof scoring.getLevelInfo === 'function') {
      try {
        const info = scoring.getLevelInfo();
        this.level = info.level;
        this.xp = info.currentXP;
        this.xpProgress = info.xpProgress;
      } catch {
        /* keep defaults */
      }
    } else if (this.xp > 0) {
      this.level = this._levelForXP(this.xp);
      const current = XP_LEVELS.find((entry) => entry.level === this.level);
      const next = XP_LEVELS.find((entry) => entry.level === this.level + 1);
      this.xpProgress = next
        ? (this.xp - (current?.xpRequired || 0)) / (next.xpRequired - (current?.xpRequired || 0))
        : 1;
    }
    this._updateXP();
  }

  _levelForXP(xp) {
    let level = 1;
    for (const entry of XP_LEVELS) {
      if (xp >= entry.xpRequired) level = entry.level;
    }
    return level;
  }

  _updateXP() {
    this._setText('hud-level', `L${this.level}`);
    this._setText('hud-xp-label', `${this.xp} XP`);
    const pct = Math.min(100, Math.max(0, Math.round((this.xpProgress ?? 0) * 100)));
    const bar = this.elements['hud-xp-bar'];
    if (bar) bar.style.width = `${pct}%`;
  }

  _updateMission() {
    const app = this._app();
    const mode = app?.currentMode;
    const isMission = mode === 'campaign' || mode === 'challenge';
    const button = this.elements['hud-mission'];
    const levelName = this.elements['hud-level-name'];
    if (!button) return;
    if (!isMission) {
      button.hidden = true;
      if (levelName)
        levelName.textContent =
          mode === 'chaos' ? 'Incident survival' : mode === 'sandbox' ? 'Free build' : '';
      return;
    }
    const status = app?.modeInstance?.getStatus?.();
    if (!status) return;
    const objectives = status.objectives || [];
    const done = objectives.filter((objective) => objective.completed).length;
    const total = objectives.length;
    button.hidden = false;
    this._setText('hud-mission-count', `${done} / ${total} objective${total === 1 ? '' : 's'}`);
    const fill = this.elements['hud-mission-fill'];
    if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    button.classList.toggle('is-complete', total > 0 && done === total);
    if (levelName) {
      levelName.textContent =
        mode === 'challenge'
          ? status.title || ''
          : status.levelTitle
            ? `L${status.currentLevel} · ${status.levelTitle}`
            : `Level ${status.currentLevel || ''}`;
    }
  }

  _updateAll() {
    const engine = this._gameEngine();
    let state = {};
    try {
      state = engine?.getState?.() || {};
    } catch {
      state = {};
    }
    if (Number.isFinite(state.gameTime)) this.elapsedTime = state.gameTime;
    this._updateResourceCounts(state);
    this._updateMetrics(state);
    this._updateTimer();
    this._updateHealth(state);
    this._updateAlertBadge();
    this._syncXPFromScoring();
    this._updateMode(state);
    this._updateMission();
    this._updatePausedIndicator();
  }

  _updateMode(state) {
    const rawMode = state?.mode || 'sandbox';
    const label = MODE_LABELS[String(rawMode).toLowerCase()] || String(rawMode);
    const el = this.elements['hud-mode'];
    if (el) {
      el.textContent = PLATFORM_LABEL;
      el.setAttribute('data-mode', rawMode);
      el.title = `OpenShift 4.22 · ${label}`;
    }
    const nameEl =
      this.elements['hud-mode-name'] || this.container?.querySelector('#hud-mode-name');
    if (nameEl) {
      nameEl.textContent = label;
      this.elements['hud-mode-name'] = nameEl;
    }
  }

  // ─── "Mine" ownership affordance ───────────────────────────────────────

  /** @param {number} count */
  setMineCount(count) {
    const next = Math.max(0, Number(count) || 0);
    this.mineCount = next;
    this._setText('hud-mine-count', next > 99 ? '99+' : next);
    const button = this.elements['hud-mine'];
    if (button) {
      const noun = next === 1 ? 'resource' : 'resources';
      const copy =
        next === 0
          ? 'Show only resources you created (none yet)'
          : `Show only the ${next} ${noun} you created`;
      button.title = copy;
      button.setAttribute('aria-label', copy);
      button.classList.toggle('is-empty', next === 0);
    }
    const focus = this.elements['hud-mine-focus'];
    if (focus) {
      const copy = next === 0 ? 'Frame my resources (none yet)' : 'Frame my resources';
      focus.title = copy;
      focus.setAttribute('aria-label', copy);
      focus.classList.toggle('is-empty', next === 0);
    }
  }

  /** @param {boolean} active */
  setMineActive(active) {
    this.mineMode = Boolean(active);
    const button = this.elements['hud-mine'];
    if (!button) return;
    button.classList.toggle('is-active', this.mineMode);
    button.setAttribute('aria-pressed', String(this.mineMode));
  }

  /** @param {number} count */
  setPlatformCount(count) {
    this.platformCount = Math.max(0, Number(count) || 0);
    this._setText('hud-platform-count', this.platformCount > 99 ? '99+' : this.platformCount);
    this._syncPlatformCopy();
  }

  /** @param {boolean} revealed */
  setPlatformRevealed(revealed) {
    this.platformRevealed = Boolean(revealed);
    const button = this.elements['hud-platform'];
    if (!button) return;
    button.classList.toggle('is-revealed', this.platformRevealed);
    button.classList.toggle('is-hidden', !this.platformRevealed);
    button.setAttribute('aria-pressed', String(this.platformRevealed));
    this._syncPlatformCopy();
  }

  _syncPlatformCopy() {
    const button = this.elements['hud-platform'];
    if (!button) return;
    const count = this.platformCount;
    const copy =
      count === 0
        ? 'No seeded platform defaults in the cluster'
        : `${this.platformRevealed ? 'Hide' : 'Show'} ${count} seeded OpenShift platform default${count === 1 ? '' : 's'}`;
    button.title = copy;
    button.setAttribute('aria-label', copy);
    button.classList.toggle('is-empty', count === 0);
  }

  // ─── Pause / speed ─────────────────────────────────────────────────────

  _togglePause() {
    // The app owns pausing now: it stops the mission clocks as well as the engine
    // and shows the pause card (so pausing is visible, not silent).
    const app = window.game?.app;
    if (app && typeof app.togglePause === 'function') {
      app.togglePause();
      return;
    }
    this.paused = !this.paused;
    const gameEngine = this._gameEngine();
    try {
      if (this.paused) gameEngine?.pause?.();
      else gameEngine?.resume?.();
    } catch {
      /* engine stopped */
    }
    const icon = this.elements['hud-pause-icon'];
    if (icon) icon.innerHTML = this.paused ? SVG.play : SVG.pause;
    const button = this.elements['hud-pause'];
    if (button) {
      button.title = this.paused ? 'Resume simulation' : 'Pause simulation';
      button.classList.toggle('is-paused', this.paused);
    }
  }

  _setSpeed(multiplier) {
    this.speed = multiplier;
    const gameEngine = this._gameEngine();
    try {
      if (gameEngine?.setTimeScale) gameEngine.setTimeScale(multiplier);
    } catch {
      /* engine stopped */
    }
    for (const [speed, id] of Object.entries({
      1: 'hud-speed-1',
      2: 'hud-speed-2',
      4: 'hud-speed-4',
    })) {
      const el = this.elements[id];
      if (!el) continue;
      el.classList.toggle('is-active', Number(speed) === multiplier);
    }
  }

  // ─── Achievement toast ─────────────────────────────────────────────────

  _showAchievementToast(data) {
    const toast = document.createElement('div');
    toast.className = 'hud-toast';
    toast.setAttribute('data-testid', 'achievement-toast');
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
      <span class="hud-toast-mark" aria-hidden="true">${'&#9733;'}</span>
      <span class="hud-toast-body">
        <span class="hud-toast-kicker">Achievement unlocked</span>
        <span class="hud-toast-title">${this._escapeHTML(data.name)}</span>
        <span class="hud-toast-meta">${this._escapeHTML(data.description)} +${data.xpReward ?? 0} XP</span>
      </span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('hud-toast-out');
      setTimeout(() => toast.remove(), 300);
    }, 4200);
  }

  _escapeHTML(str) {
    const div = document.createElement('span');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // ─── Easter egg (unchanged behaviour) ──────────────────────────────────

  _onLogoClick() {
    this._logoClickCount += 1;
    clearTimeout(this._logoClickTimer);
    this._logoClickTimer = setTimeout(() => {
      this._logoClickCount = 0;
    }, 2000);
    if (this._logoClickCount >= 7 && !this._partyModeActive) {
      this._logoClickCount = 0;
      this._activatePartyMode();
    }
  }

  _activatePartyMode() {
    this._partyModeActive = true;
    const style = document.createElement('style');
    style.id = 'party-mode-style';
    style.textContent = `
      @keyframes party-rainbow { 0% { filter: hue-rotate(0deg) brightness(1.15); } 50% { filter: hue-rotate(180deg) brightness(1.25); } 100% { filter: hue-rotate(360deg) brightness(1.15); } }
      .party-mode * { animation: party-rainbow 0.6s linear infinite; }
    `;
    document.head.appendChild(style);
    const target =
      document.getElementById('cluster-view') || document.querySelector('canvas') || document.body;
    this._partyModeTarget = target;
    target.classList.add('party-mode');
    try {
      const bus = this._bus();
      bus?.emit?.('easter-egg:triggered', { id: 'party-mode' });
      bus?.emit?.('xp:gain', { amount: 50 });
    } catch {
      /* event bus unavailable */
    }
    this._partyModeTimeout = setTimeout(() => {
      target.classList.remove('party-mode');
      document.getElementById('party-mode-style')?.remove();
      this._partyModeActive = false;
      this._partyModeTarget = null;
    }, 10000);
  }
}

export default HUD;
