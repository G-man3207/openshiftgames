/**
 * HUD — top bar for the OpenShift Games cluster view (OCP 4.22 / EX280).
 *
 * Shows the product identity, cluster health, OpenShift resource counters
 * (Projects / Workloads / Routes / Builds / Pods / Nodes / Deployments /
 * Services), CPU+memory, mode label, XP, Pause/Speed controls, the incident
 * bell and the settings/party-mode handlers.
 *
 * The element ids consumed by index.html and by prior work are preserved
 * (`hud-logo-text`, `hud-nodes`, `hud-pods-*`, `hud-deployments`,
 * `hud-services`, `hud-mode`, `hud-pause*`, `hud-speed-*`, ...). New counters
 * add `hud-projects`, `hud-workloads`, `hud-routes`, `hud-builds`.
 *
 * All engine subscriptions are idempotent: `init()` re-creates the DOM and
 * re-binds; `destroy()` removes every listener. The HUD also consumes
 * `engine:stopped` so `returnToMenu()` / `engine.reset()` never leak listeners
 * or leave a stale settings modal behind.
 */

import { XP_LEVELS } from '../engine/ScoringEngine.js';
import { SettingsPanel } from './SettingsPanel.js';

const PLATFORM_LABEL = 'OpenShift 4.22';
const REPO_URL = 'https://github.com/G-man3207/openshiftgames';
const MODE_LABELS = {
  campaign: 'Campaign',
  challenge: 'Timed Lab',
  chaos: 'Chaos',
  sandbox: 'Sandbox',
};
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'];

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

    this._boundTick = this._onTick.bind(this);
    this._boundIncident = this._onIncident.bind(this);
    this._boundResolve = this._onResolve.bind(this);
    this._boundXP = this._onXPGain.bind(this);
    this._boundSelect = this._onResourceSelect.bind(this);
    this._boundAchievement = this._onAchievement.bind(this);
    this._boundStopped = this._onEngineStopped.bind(this);
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
    this.container = document.createElement('div');
    this.container.id = 'hud';
    this.container.className = 'fixed top-0 left-0 right-0 z-40 pointer-events-none';
    this.container.setAttribute('data-testid', 'hud');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);

    this._cacheElements();
    this._bindEvents();
    this._bindGameEvents();
    this._syncIncidentCount();
    this._syncXPFromScoring();
    this._updateAll();

    this.settingsPanel = new SettingsPanel();
    this.settingsPanel.init();

    if (window._ghStars) {
      const el = this.container.querySelector('#hud-github-stars');
      if (el) el.textContent = window._ghStars;
    }
  }

  destroy() {
    clearTimeout(this._logoClickTimer);
    clearTimeout(this._partyModeTimeout);
    this._unbindGameEvents();
    this.settingsPanel?.destroy();
    this.settingsPanel = null;

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

  // ─── Markup ────────────────────────────────────────────────────────────

  _buildHTML() {
    return `
      <style>
        /* Keep the top bar on one line at 1600px; reveal secondary counters on wide screens. */
        #hud .hud-wide-only { display: none !important; }
        #hud .hud-github { display: none !important; }
        @media (min-width: 1900px) {
          #hud .hud-wide-only { display: flex !important; }
          #hud .hud-github { display: flex !important; }
        }
        @media (max-width: 1560px) {
          #hud .hud-center { display: none !important; }
        }
        @media (max-width: 1280px) {
          #hud #hud-xp-container { display: none !important; }
        }
        @media (max-width: 1199px) {
          #hud .hud-stat-workloads,
          #hud .hud-stat-routes,
          #hud .hud-stat-builds { display: none !important; }
        }
        @media (max-width: 900px) {
          #hud .hud-stat-projects,
          #hud .hud-stat-nodes { display: none !important; }
          #hud #hud-mode-name { display: none !important; }
        }
      </style>
      <div class="flex items-center justify-between px-4 py-2 gap-3 backdrop-blur-xl bg-white/5 border-b border-white/10 pointer-events-auto">
        <div class="flex items-center gap-4 min-w-0">
          <button id="hud-menu" class="px-2 py-1 text-xs text-white/60 hover:text-white/90 hover:bg-white/10 rounded-lg transition-all flex items-center gap-1.5" title="Back to Menu (Esc)" data-testid="hud-menu">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
            <span>Menu</span>
          </button>
          <div class="hud-divider h-5 w-px bg-white/10"></div>
          <div class="flex items-center gap-2 shrink-0">
            <div id="hud-health" class="w-3 h-3 rounded-full bg-green-400 shadow-lg shadow-green-400/50 transition-colors duration-500" title="Cluster health" data-testid="hud-health"></div>
            <span id="hud-logo-text" class="text-white/90 text-sm font-semibold tracking-wide whitespace-nowrap" data-testid="hud-logo">OpenShift Games</span>
          </div>
          <div class="hud-divider h-5 w-px bg-white/10"></div>
          <div class="flex items-center gap-3 text-xs text-white/60 whitespace-nowrap min-w-0">
            <div class="hud-stat hud-stat-projects flex items-center gap-1" title="Projects">
              <span class="text-white/40">Projects</span>
              <span id="hud-projects" class="text-white/90 font-mono" data-testid="hud-projects">0</span>
            </div>
            <div class="hud-stat hud-stat-workloads hud-extra-stat flex items-center gap-1" title="Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and CronJobs">
              <span class="text-white/40">Workloads</span>
              <span id="hud-workloads" class="text-white/90 font-mono" data-testid="hud-workloads">0</span>
            </div>
            <div class="hud-stat hud-stat-routes hud-extra-stat flex items-center gap-1" title="Routes">
              <span class="text-white/40">Routes</span>
              <span id="hud-routes" class="text-white/90 font-mono" data-testid="hud-routes">0</span>
            </div>
            <div class="hud-stat hud-stat-builds hud-extra-stat flex items-center gap-1" title="Builds (all phases)">
              <span class="text-white/40">Builds</span>
              <span id="hud-builds" class="text-white/90 font-mono" data-testid="hud-builds">0</span>
            </div>
            <div class="hud-stat hud-stat-nodes hud-extra-stat flex items-center gap-1" title="Nodes">
              <span class="text-white/40">Nodes</span>
              <span id="hud-nodes" class="text-white/90 font-mono" data-testid="hud-nodes">0</span>
            </div>
            <div class="hud-stat hud-stat-pods flex items-center gap-1" title="Pods: running / pending / failed">
              <span class="text-white/40">Pods</span>
              <span id="hud-pods-running" class="text-green-400 font-mono" data-testid="hud-pods-running">0</span>
              <span class="text-white/20">/</span>
              <span id="hud-pods-pending" class="text-yellow-400 font-mono" data-testid="hud-pods-pending">0</span>
              <span class="text-white/20">/</span>
              <span id="hud-pods-failed" class="text-red-400 font-mono" data-testid="hud-pods-failed">0</span>
            </div>
            <div class="hud-extra-stat hud-wide-only flex items-center gap-1" title="Deployments">
              <span class="text-white/40">Deploy</span>
              <span id="hud-deployments" class="text-white/90 font-mono" data-testid="hud-deployments">0</span>
            </div>
            <div class="hud-extra-stat hud-wide-only flex items-center gap-1" title="Services">
              <span class="text-white/40">Svc</span>
              <span id="hud-services" class="text-white/90 font-mono" data-testid="hud-services">0</span>
            </div>
          </div>
        </div>

        <div class="hud-center flex items-center gap-4">
          <div class="flex items-center gap-2 min-w-[140px]">
            <span class="text-white/40 text-xs">CPU</span>
            <div class="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div id="hud-cpu-bar" class="h-full bg-blue-400 rounded-full transition-all duration-500" style="width: 0%"></div>
            </div>
            <span id="hud-cpu-text" class="text-white/60 text-xs font-mono w-8 text-right">0%</span>
          </div>
          <div class="flex items-center gap-2 min-w-[140px]">
            <span class="text-white/40 text-xs">MEM</span>
            <div class="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div id="hud-mem-bar" class="h-full bg-purple-400 rounded-full transition-all duration-500" style="width: 0%"></div>
            </div>
            <span id="hud-mem-text" class="text-white/60 text-xs font-mono w-8 text-right">0%</span>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <div class="flex items-center gap-2">
            <span id="hud-timer" class="text-white/60 text-xs font-mono" data-testid="hud-timer">00:00</span>
            <div class="hud-divider h-5 w-px bg-white/10"></div>
            <span id="hud-mode" class="text-xs text-sky-400 font-medium uppercase tracking-wider whitespace-nowrap" data-testid="hud-mode">${PLATFORM_LABEL}</span>
            <span id="hud-mode-name" class="text-[10px] text-white/30 uppercase tracking-wider whitespace-nowrap" data-testid="hud-mode-name">Sandbox</span>
          </div>

          <div class="flex items-center gap-1.5">
            <div class="relative">
              <div id="hud-xp-container" class="flex items-center gap-1.5" title="OpenShift skills XP">
                <span id="hud-level" class="text-xs text-amber-400 font-bold">L1</span>
                <div class="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div id="hud-xp-bar" class="h-full bg-amber-400 rounded-full transition-all duration-300" style="width: 0%"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="hud-divider h-5 w-px bg-white/10"></div>

          <div class="flex items-center gap-1">
            <button id="hud-pause" class="px-1.5 py-0.5 text-xs text-white/60 hover:text-white/90 hover:bg-white/10 rounded transition-colors" title="Pause / resume simulation" data-testid="hud-pause">
              <span id="hud-pause-icon">&#9646;&#9646;</span>
            </button>
            <button id="hud-speed-1" class="px-1.5 py-0.5 text-xs text-sky-400 bg-sky-400/10 rounded font-mono" data-testid="hud-speed-1">1x</button>
            <button id="hud-speed-2" class="px-1.5 py-0.5 text-xs text-white/40 hover:text-white/60 rounded font-mono transition-colors" data-testid="hud-speed-2">2x</button>
            <button id="hud-speed-4" class="px-1.5 py-0.5 text-xs text-white/40 hover:text-white/60 rounded font-mono transition-colors" data-testid="hud-speed-4">4x</button>
          </div>

          <div class="hud-divider h-5 w-px bg-white/10"></div>

          <button id="hud-alerts" class="relative px-2 py-0.5 text-xs text-white/60 hover:text-white/90 transition-colors" title="OpenShift incidents" data-testid="hud-alerts">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            <span id="hud-alert-badge" class="absolute -top-1 -right-1 hidden min-w-[16px] h-4 px-1 text-[10px] font-bold text-white bg-red-500 rounded-full flex items-center justify-center" data-testid="hud-alert-badge">0</span>
          </button>

          <button id="hud-settings" class="px-2 py-0.5 text-xs text-white/60 hover:text-white/90 transition-colors" title="Settings" data-testid="hud-settings">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>

          <div class="hud-divider h-5 w-px bg-white/10"></div>

          <a href="${REPO_URL}" target="_blank" rel="noopener" class="hud-github flex items-center gap-1.5 px-2 py-0.5 text-xs text-white/50 hover:text-white/90 transition-all rounded-md hover:bg-white/5" title="Star OpenShift Games on GitHub">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <svg class="w-3 h-3 text-amber-400" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>
            <span id="hud-github-stars" class="font-mono text-amber-400/80">--</span>
          </a>
        </div>
      </div>
    `;
  }

  _cacheElements() {
    const ids = [
      'hud-menu', 'hud-settings', 'hud-health', 'hud-nodes', 'hud-projects', 'hud-workloads',
      'hud-routes', 'hud-builds', 'hud-pods-running', 'hud-pods-pending', 'hud-pods-failed',
      'hud-deployments', 'hud-services', 'hud-mode-name', 'hud-cpu-bar', 'hud-cpu-text', 'hud-mem-bar',
      'hud-mem-text', 'hud-timer', 'hud-mode', 'hud-level', 'hud-xp-bar', 'hud-pause',
      'hud-pause-icon', 'hud-speed-1', 'hud-speed-2', 'hud-speed-4', 'hud-alert-badge',
      'hud-alerts', 'hud-xp-container', 'hud-github-stars', 'hud-logo-text',
    ];
    for (const id of ids) {
      this.elements[id] = this.container?.querySelector(`#${id}`) || document.getElementById(id) || null;
    }
  }

  _bindEvents() {
    const on = (id, event, handler) => {
      const el = this.elements[id] || this.container?.querySelector(`#${id}`);
      if (el) el.addEventListener(event, handler);
    };

    on('hud-menu', 'click', () => window.game?.app?.returnToMenu?.());
    on('hud-settings', 'click', () => this.settingsPanel?.toggle());
    on('hud-pause', 'click', () => this._togglePause());
    on('hud-speed-1', 'click', () => this._setSpeed(1));
    on('hud-speed-2', 'click', () => this._setSpeed(2));
    on('hud-speed-4', 'click', () => this._setSpeed(4));
    on('hud-alerts', 'click', () => {
      try {
        this._bus()?.emit?.('ui:toggle-incidents');
      } catch {
        /* no incident panel */
      }
    });

    const logoText = this.elements['hud-logo-text'];
    if (logoText) {
      logoText.style.cursor = 'pointer';
      logoText.addEventListener('click', () => this._onLogoClick());
    }
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
      bus.off?.('engine:stopped', this._boundStopped);
    }
    this._engineRef = null;
    this._engineAttached = false;
  }

  _onEngineStopped() {
    this.destroy();
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
      cpuBar.className = `h-full rounded-full transition-all duration-500 ${this._metricBarColor(cpuPct, 'bg-blue-400')}`;
    }
    if (memBar) {
      memBar.style.width = `${memPct}%`;
      memBar.className = `h-full rounded-full transition-all duration-500 ${this._metricBarColor(memPct, 'bg-purple-400')}`;
    }
    this._setText('hud-cpu-text', `${cpuPct}%`);
    this._setText('hud-mem-text', `${memPct}%`);
  }

  _updateTimer() {
    const totalSeconds = Math.max(0, Math.floor(this.elapsedTime / 1000));
    const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    this._setText('hud-timer', `${mins}:${secs}`);
  }

  _updateHealth(state) {
    const el = this.elements['hud-health'];
    if (!el) return;
    let health = state?.clusterHealth ?? 'healthy';
    if (health && typeof health === 'object') {
      const degraded = Array.isArray(health.degraded) ? health.degraded.length : 0;
      const percent = Number(health.percent);
      health = degraded > 0 ? 'critical' : Number.isFinite(percent) && percent < 100 ? 'warning' : 'healthy';
    }
    const label = health === 'critical' ? 'Degraded' : health === 'warning' ? 'Warning' : 'Healthy';
    el.title = `Cluster health: ${label}`;
    el.setAttribute('data-health', health);
    if (health === 'critical') {
      el.className = 'w-3 h-3 rounded-full bg-red-400 shadow-lg shadow-red-400/50 animate-pulse transition-colors duration-500';
    } else if (health === 'warning') {
      el.className = 'w-3 h-3 rounded-full bg-yellow-400 shadow-lg shadow-yellow-400/50 transition-colors duration-500';
    } else {
      el.className = 'w-3 h-3 rounded-full bg-green-400 shadow-lg shadow-green-400/50 transition-colors duration-500';
    }
  }

  _updateAlertBadge() {
    const badge = this.elements['hud-alert-badge'];
    if (!badge) return;
    if (this.incidentCount > 0) {
      badge.classList.remove('hidden');
      badge.textContent = this.incidentCount > 99 ? '99+' : String(this.incidentCount);
      badge.title = `${this.incidentCount} active OpenShift incident${this.incidentCount === 1 ? '' : 's'}`;
    } else {
      badge.classList.add('hidden');
      badge.textContent = '0';
      badge.title = 'No active incidents';
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
    const pct = Math.min(100, Math.max(0, Math.round((this.xpProgress ?? 0) * 100)));
    const bar = this.elements['hud-xp-bar'];
    if (bar) bar.style.width = `${pct}%`;
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
  }

  _metricBarColor(pct, normalColor) {
    if (pct > 80) return 'bg-red-400';
    if (pct > 60) return 'bg-yellow-400';
    return normalColor;
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
    const nameEl = this.elements['hud-mode-name'] || this.container?.querySelector('#hud-mode-name');
    if (nameEl) {
      nameEl.textContent = label;
      this.elements['hud-mode-name'] = nameEl;
    }
  }

  // ─── Pause / speed ─────────────────────────────────────────────────────

  _togglePause() {
    this.paused = !this.paused;
    const gameEngine = this._gameEngine();
    try {
      if (this.paused) gameEngine?.pause?.();
      else gameEngine?.resume?.();
    } catch {
      /* engine stopped */
    }
    const icon = this.elements['hud-pause-icon'];
    if (icon) icon.innerHTML = this.paused ? '&#9654;' : '&#9646;&#9646;';
    const button = this.elements['hud-pause'];
    if (button) button.title = this.paused ? 'Resume simulation' : 'Pause simulation';
  }

  _setSpeed(multiplier) {
    this.speed = multiplier;
    const gameEngine = this._gameEngine();
    try {
      if (gameEngine?.setTimeScale) gameEngine.setTimeScale(multiplier);
    } catch {
      /* engine stopped */
    }
    const buttons = { 1: 'hud-speed-1', 2: 'hud-speed-2', 4: 'hud-speed-4' };
    for (const [speed, id] of Object.entries(buttons)) {
      const el = this.elements[id];
      if (!el) continue;
      if (Number(speed) === multiplier) {
        el.className = 'px-1.5 py-0.5 text-xs text-sky-400 bg-sky-400/10 rounded font-mono';
      } else {
        el.className = 'px-1.5 py-0.5 text-xs text-white/40 hover:text-white/60 rounded font-mono transition-colors';
      }
    }
  }

  // ─── Achievement toast (unchanged behaviour) ───────────────────────────

  _showAchievementToast(data) {
    const toast = document.createElement('div');
    toast.className = 'fixed top-16 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 backdrop-blur-xl shadow-2xl animate-slide-in-right';
    toast.setAttribute('data-testid', 'achievement-toast');
    toast.innerHTML = `
      <div class="text-2xl">${this._achievementIcon(data.icon)}</div>
      <div>
        <div class="text-amber-400 text-xs font-bold uppercase tracking-wider">Achievement Unlocked!</div>
        <div class="text-white/90 text-sm font-medium">${this._escapeHTML(data.name)}</div>
        <div class="text-white/40 text-[10px]">${this._escapeHTML(data.description)} &middot; +${data.xpReward ?? 0} XP</div>
      </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.5s ease-out';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  _achievementIcon(icon) {
    const icons = {
      seedling: '\ud83c\udf31', rocket: '\ud83d\ude80', shield: '\ud83d\udee1\ufe0f', star: '\u2b50',
      terminal: '\ud83d\udcbb', folder: '\ud83d\udcc1', link: '\ud83d\udd17', sprout: '\ud83c\udf3f',
      graduation: '\ud83c\udf93', lightning: '\u26a1', fire: '\ud83d\udd25', trophy: '\ud83c\udfc6',
      crown: '\ud83d\udc51', sword: '\u2694\ufe0f', moon: '\ud83c\udf19', brain: '\ud83e\udde0',
      skull: '\ud83d\udc80', monkey: '\ud83d\udc12', coffee: '\u2615', disco: '\ud83c\udf89',
      gamepad: '\ud83c\udfae', key: '\ud83d\udd11', medal: '\ud83c\udfc5', castle: '\ud83c\udff0',
      scroll: '\ud83d\udcdc', domino: '\ud83c\udfb2', explosion: '\ud83d\udca5', loop: '\ud83d\udd04',
      zap: '\u26a1', herd: '\ud83d\udc02', house: '\ud83c\udfe0', crosshair: '\ud83c\udfaf',
      server: '\ud83d\udda5\ufe0f', firewall: '\ud83e\uddf1', database: '\ud83d\uddc4\ufe0f',
      book: '\ud83d\udcd6', expand: '\ud83d\udd0d', stars: '\u2728', blueprint: '\ud83d\udcd0',
      collection: '\ud83d\udce6', check: '\u2705',
    };
    return icons[icon] || '\ud83c\udfc6';
  }

  _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // ─── Easter egg (unchanged) ────────────────────────────────────────────

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
      @keyframes party-rainbow { 0% { filter: hue-rotate(0deg) brightness(1.2); } 50% { filter: hue-rotate(180deg) brightness(1.3); } 100% { filter: hue-rotate(360deg) brightness(1.2); } }
      .party-mode * { animation: party-rainbow 0.5s linear infinite; }
    `;
    document.head.appendChild(style);
    const target = document.getElementById('cluster-view') || document.querySelector('canvas') || document.body;
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
