/**
 * SettingsPanel — in-game OpenShift Games preferences (OCP 4.22 / EX280).
 *
 * Storage contract (shared with the app shell, see index.html):
 *   - `openshiftgames_settings` is the single settings key.
 *   - the canonical object lives on `window.game.app.settings` and uses the
 *     shell schema `{ sound, particles, shadows, grid, difficulty }`.
 *   - this panel adds optional presentation keys (`showMinimap`,
 *     `showConnectionLines`, `cameraSpeed`, `autoExpandIncidents`, `showHints`)
 *     to the same object; it never writes a competing schema or the legacy
 *     `k8sgames_settings` key (that key is only read once for migration).
 *
 * The four shell toggles keep their conventional ids (`toggle-sound`,
 * `toggle-particles`, `toggle-shadows`, `toggle-grid`) and the difficulty
 * select keeps `select-difficulty`. When the main-menu copy of an id is
 * already in the document (index.html owns it), the in-game control uses an
 * `ingame-` prefix so the document never contains duplicate ids.
 *
 * No top-level DOM access: importable in Node for the static verifier.
 */

const SETTINGS_KEY = 'openshiftgames_settings';
const LEGACY_SETTINGS_KEY = 'k8sgames_settings';
const PROGRESS_KEYS = ['openshiftgames_progress', 'k8sgames_progress'];
const INVESTIGATION_KEYS = ['openshiftgames_investigation', 'k8sgames_investigation'];
const DOCS_URL = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22';
const PLATFORM_LABEL = 'OpenShift 4.22';

const DIFFICULTY_PRESETS = {
  easy: {
    label: 'Easy',
    description: 'Guided practice — slower incidents, extra cluster headroom',
    failureRate: 0.5,
    resourceMultiplier: 1.5,
  },
  normal: {
    label: 'Normal',
    description: 'Balanced EX280 practice on a stable 4.22 cluster',
    failureRate: 1.0,
    resourceMultiplier: 1.0,
  },
  hard: {
    label: 'Hard',
    description: 'Exam pace — faster incidents, tighter capacity',
    failureRate: 2.0,
    resourceMultiplier: 0.75,
  },
  nightmare: {
    label: 'Nightmare',
    description: 'Production fire drill — relentless OpenShift incidents',
    failureRate: 3.0,
    resourceMultiplier: 0.5,
  },
};

const DEFAULT_SETTINGS = {
  // Shell schema (index.html + app.applySettings)
  sound: true,
  particles: true,
  shadows: true,
  grid: true,
  difficulty: 'normal',
  // Panel-only presentation preferences
  showMinimap: true,
  showConnectionLines: true,
  cameraSpeed: 1,
  autoExpandIncidents: true,
  showHints: true,
};

export class SettingsPanel {
  constructor() {
    this.container = null;
    this.visible = false;
    this.settings = this._loadSettings();
    this._boundClick = this._onClick.bind(this);
    this._boundInput = this._onInput.bind(this);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  init() {
    if (this.container) this.destroy();
    this.container = document.createElement('div');
    this.container.id = 'ingame-settings-panel';
    this.container.className = 'fixed inset-0 z-50 hidden';
    this.container.setAttribute('data-testid', 'settings-panel');
    this.container.setAttribute('role', 'dialog');
    this.container.setAttribute('aria-modal', 'true');
    this.container.setAttribute('aria-label', 'OpenShift Games settings');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);
    this.container.addEventListener('click', this._boundClick);
    this.container.addEventListener('input', this._boundInput);
    this.container.addEventListener('change', this._boundInput);
    this._applySettings();
  }

  show() {
    if (!this.container) return;
    this._syncFromApp();
    this._rerender();
    this.visible = true;
    this.container.classList.remove('hidden');
    // The minimap may be created after HUD.init(); re-apply display preferences.
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    show('minimap', this.settings.showMinimap);
    show('minimap-container', this.settings.showMinimap);
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.classList.add('hidden');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    if (this.container) {
      this.container.removeEventListener('click', this._boundClick);
      this.container.removeEventListener('input', this._boundInput);
      this.container.removeEventListener('change', this._boundInput);
      this.container.remove();
    }
    this.container = null;
    this.visible = false;
  }

  getSettings() {
    return { ...this.settings };
  }

  /** Update one preference from code/tests; persists through the app schema. */
  setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return false;
    this._persist({ [key]: value });
    if (this.container && this.visible) this._rerender();
    return true;
  }

  // ─── Settings storage ──────────────────────────────────────────────────

  _readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _loadSettings() {
    const merged = { ...DEFAULT_SETTINGS };
    let stored = this._readJSON(SETTINGS_KEY);
    let migrated = false;

    if (!stored) {
      const legacy = this._readJSON(LEGACY_SETTINGS_KEY);
      if (legacy && typeof legacy === 'object') {
        stored = legacy;
        migrated = true;
      }
    }
    if (stored && typeof stored === 'object') {
      // Legacy in-game panel names → shell names (read-only compatibility).
      if (stored.particleEffects !== undefined && stored.particles === undefined) {
        stored.particles = Boolean(stored.particleEffects);
      }
      if (stored.soundEnabled !== undefined && stored.sound === undefined) {
        stored.sound = Boolean(stored.soundEnabled);
      }
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (stored[key] !== undefined && stored[key] !== null) merged[key] = stored[key];
      }
    }

    // The app shell owns the canonical settings object once the game boots.
    const appSettings = window.game?.app?.settings;
    if (appSettings && typeof appSettings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (appSettings[key] !== undefined) merged[key] = appSettings[key];
      }
    }

    if (!DIFFICULTY_PRESETS[merged.difficulty]) merged.difficulty = 'normal';
    merged.cameraSpeed = Number.isFinite(Number(merged.cameraSpeed))
      ? Math.min(2, Math.max(0.5, Number(merged.cameraSpeed)))
      : 1;
    for (const key of [
      'sound',
      'particles',
      'shadows',
      'grid',
      'showMinimap',
      'showConnectionLines',
      'autoExpandIncidents',
      'showHints',
    ]) {
      merged[key] = Boolean(merged[key]);
    }

    if (migrated) this._writeSettings(merged);
    return merged;
  }

  _writeSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable (private mode / file URL) — settings stay in memory */
    }
  }

  _persist(changes) {
    this.settings = { ...this.settings, ...changes };
    this._applySettings();
  }

  _syncFromApp() {
    const appSettings = window.game?.app?.settings;
    if (!appSettings || typeof appSettings !== 'object') return;
    const next = { ...this.settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (appSettings[key] !== undefined) next[key] = appSettings[key];
    }
    if (!DIFFICULTY_PRESETS[next.difficulty]) next.difficulty = this.settings.difficulty;
    this.settings = next;
  }

  // ─── Apply / broadcast ─────────────────────────────────────────────────

  _applySettings() {
    const app = window.game?.app;
    const gameEngine = window.game?.gameEngine || app?.engine || null;
    const bus = window.game?.engine || app?.engine?.eventBus || null;

    // Keep the canonical app object (and therefore openshiftgames_settings)
    // in sync — including the extra presentation keys the panel adds.
    if (app) {
      app.settings = { ...(app.settings || {}), ...this.settings };
      try {
        if (typeof app.saveSettings === 'function') app.saveSettings(app.settings);
        else this._writeSettings(app.settings);
      } catch {
        this._writeSettings(this.settings);
      }
      try {
        if (typeof app.applySettings === 'function') app.applySettings();
      } catch {
        /* renderer may not be initialised yet */
      }
      try {
        if (typeof app._syncSettingsUi === 'function') app._syncSettingsUi();
      } catch {
        /* shell UI may not be mounted */
      }
    } else {
      this._writeSettings(this.settings);
    }

    if (gameEngine && typeof gameEngine.setDifficulty === 'function') {
      try {
        gameEngine.setDifficulty(this.settings.difficulty);
      } catch {
        /* engine not ready */
      }
    }
    try {
      bus?.emit?.('settings:changed', { ...this.settings });
    } catch {
      /* EventBus unavailable */
    }

    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    show('minimap', this.settings.showMinimap);
    show('minimap-container', this.settings.showMinimap);
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  /** Avoid duplicate ids with the main-menu settings panel owned by index.html. */
  _controlId(base) {
    if (typeof document === 'undefined') return base;
    const existing = document.getElementById(base);
    if (!existing || (this.container && this.container.contains(existing))) return base;
    return `ingame-${base}`;
  }

  _buildHTML() {
    const difficulty = this.settings.difficulty;
    const selectId = this._controlId('select-difficulty');
    const resetId = this._controlId('reset-progress');
    const exportId = this._controlId('export-save');

    return `
      <div class="settings-backdrop" data-action="backdrop"></div>
      <div class="settings-dialog">
        <div class="flex items-start justify-between px-6 py-4 border-b border-white/5">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-white/90 text-base font-semibold">Settings</h2>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold text-openshift bg-openshift/10 border border-openshift/30">${PLATFORM_LABEL}</span>
            </div>
            <p class="text-white/30 text-[11px] mt-1">OpenShift Games preferences · stored in this browser · EX280 simulation</p>
          </div>
          <button data-action="close" data-testid="settings-close" class="p-1 text-white/30 hover:text-white/60 transition-colors" aria-label="Close settings">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="px-6 py-4 space-y-6">
          <div>
            <div class="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Difficulty</div>
            <p class="text-white/30 text-[10px] mb-3">Incident pressure and cluster headroom for every OpenShift game mode.</p>
            <div class="grid grid-cols-2 gap-2">
              ${Object.entries(DIFFICULTY_PRESETS)
                .map(
                  ([key, preset]) => `
                <button class="settings-difficulty px-3 py-2 rounded-lg border text-left transition-all ${key === difficulty ? 'border-openshift/50 bg-openshift/10' : 'border-white/5 bg-white/5 hover:bg-white/10'}" data-difficulty="${key}" data-testid="settings-difficulty-${key}" aria-pressed="${key === difficulty}">
                  <div class="text-sm font-medium ${key === difficulty ? 'text-openshift-light' : 'text-white/70'}">${preset.label}</div>
                  <div class="text-[10px] text-white/30 mt-0.5">${preset.description}</div>
                </button>
              `
                )
                .join('')}
            </div>
          </div>

          <div>
            <div class="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Platform display</div>
            <p class="text-white/30 text-[10px] mb-2">Renderer and simulation overlays for the 3D OpenShift cluster.</p>
            <div class="space-y-2">
              ${this._buildToggle('particles', 'Particle Traffic', 'Animated traffic along Service and Route connections', 'toggle-particles')}
              ${this._buildToggle('shadows', 'Shadows', 'Dynamic shadows on the cluster view', 'toggle-shadows')}
              ${this._buildToggle('grid', 'Cluster Grid', 'Project/Node placement grid in the 3D view', 'toggle-grid')}
              ${this._buildToggle('showConnectionLines', 'Connection Lines', 'Ownership and networking links between resources')}
              ${this._buildToggle('showMinimap', 'Minimap', 'Cluster overview in the bottom-right corner')}
            </div>
          </div>

          <div>
            <div class="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Gameplay</div>
            <div class="space-y-2">
              ${this._buildToggle('showHints', 'Show Hints', 'Show EX280 hints for campaign and timed-lab objectives')}
            </div>
            <p class="text-white/25 text-[10px] mt-2">Sound effects and camera-speed controls are not available in this build.</p>
          </div>

          <div>
            <div class="text-white/60 text-xs font-semibold uppercase tracking-wider mb-2">Difficulty select</div>
            <label class="text-[10px] text-white/30 block mb-1" for="${selectId}">Mirrored with the main-menu setting</label>
            <select id="${selectId}" data-setting-id="select-difficulty" data-action="difficulty-select" class="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-openshift/50" data-testid="settings-difficulty-select">
              ${Object.entries(DIFFICULTY_PRESETS)
                .map(
                  ([key, preset]) =>
                    `<option value="${key}" ${key === difficulty ? 'selected' : ''}>${preset.label}</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="pt-2 border-t border-white/5">
            <div class="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1">Data</div>
            <p class="text-white/25 text-[10px] mb-3">Progress and settings are stored locally under <code class="text-white/40">openshiftgames_*</code>. No account, no telemetry.</p>
            <div class="flex gap-2">
              <button id="${resetId}" data-setting-id="reset-progress" data-action="reset-progress" data-testid="settings-reset-progress" class="px-3 py-1.5 text-xs text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-colors">Reset All Progress</button>
              <button id="${exportId}" data-setting-id="export-save" data-action="export" data-testid="settings-export-save" class="px-3 py-1.5 text-xs text-white/50 border border-white/10 rounded-lg hover:bg-white/5 transition-colors">Export Save</button>
            </div>
          </div>
        </div>

        <div class="px-6 py-3 border-t border-white/5 flex items-center justify-between">
          <a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-white/25 hover:text-openshift-light transition-colors">OpenShift 4.22 documentation</a>
          <button data-action="done" data-testid="settings-done" class="px-4 py-1.5 text-sm text-openshift-light bg-openshift/10 rounded-lg hover:bg-openshift/20 transition-colors font-medium">Done</button>
        </div>
      </div>
    `;
  }

  _buildToggle(key, label, description, baseId = null) {
    const checked = Boolean(this.settings[key]);
    const settingId = baseId || `toggle-${key}`;
    const id = this._controlId(settingId);
    return `
      <div class="flex items-center justify-between py-1.5 gap-4">
        <div>
          <div class="text-white/70 text-sm">${label}</div>
          <div class="text-white/25 text-[10px]">${description}</div>
        </div>
        <button id="${id}" data-setting-id="${settingId}" class="settings-toggle relative w-9 h-5 shrink-0 rounded-full transition-colors ${checked ? 'bg-openshift' : 'bg-white/10'}" data-key="${key}" data-testid="settings-toggle-${key}" role="switch" aria-checked="${checked}" aria-label="${label}">
          <div class="absolute top-0.5 ${checked ? 'left-[18px]' : 'left-0.5'} w-4 h-4 bg-white rounded-full shadow transition-all"></div>
        </button>
      </div>
    `;
  }

  _rerender() {
    if (!this.container) return;
    const scroller = this.container.querySelector('.overflow-y-auto');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    this.container.innerHTML = this._buildHTML();
    const next = this.container.querySelector('.overflow-y-auto');
    if (next) next.scrollTop = scrollTop;
  }

  // ─── Events ────────────────────────────────────────────────────────────

  _onClick(event) {
    const target = event.target.closest('[data-action], [data-difficulty], [data-key]');
    if (!target || !this.container?.contains(target)) return;

    if (
      target.dataset.action === 'backdrop' ||
      target.dataset.action === 'close' ||
      target.dataset.action === 'done'
    ) {
      this.hide();
      return;
    }
    if (target.dataset.action === 'reset-progress') {
      this._resetProgress();
      return;
    }
    if (target.dataset.action === 'export') {
      this._exportSave();
      return;
    }
    if (target.dataset.difficulty) {
      this._change({ difficulty: target.dataset.difficulty });
      return;
    }
    if (target.dataset.key) {
      const key = target.dataset.key;
      this._change({ [key]: !this.settings[key] });
    }
  }

  _onInput(event) {
    const target = event.target;
    if (!target || !target.matches) return;
    if (target.matches('[data-action="camera-speed"]')) {
      const value = Number.parseFloat(target.value);
      if (!Number.isFinite(value)) return;
      this._persist({ cameraSpeed: Math.min(2, Math.max(0.5, value)) });
      const label = this.container?.querySelector('[data-label="camera-speed-val"]');
      if (label) label.textContent = `${this.settings.cameraSpeed}x`;
      return;
    }
    if (target.matches('[data-action="difficulty-select"]')) {
      this._change({ difficulty: target.value });
    }
  }

  _change(changes) {
    this._persist(changes);
    this._rerender();
  }

  // ─── Data actions ──────────────────────────────────────────────────────

  _resetProgress() {
    const message =
      'Reset ALL OpenShift Games progress (campaign stars, timed labs, EX280 Prep, achievements) and reload? This cannot be undone.';
    let confirmed = true;
    try {
      if (typeof window.confirm === 'function') confirmed = window.confirm(message);
    } catch {
      confirmed = true;
    }
    if (!confirmed) return;

    try {
      window.game?.scoringEngine?.resetProgress?.();
    } catch {
      /* keep removing the stored keys below regardless */
    }
    for (const key of [...PROGRESS_KEYS, ...INVESTIGATION_KEYS]) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    try {
      window.location.reload();
    } catch {
      /* not in a browser — nothing else to do */
    }
  }

  _readStorageJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _exportSave() {
    const app = window.game?.app;
    const settings = app?.settings ? { ...app.settings, ...this.settings } : { ...this.settings };
    const progress =
      this._readStorageJSON(PROGRESS_KEYS[0]) || this._readStorageJSON(PROGRESS_KEYS[1]);
    const investigation =
      this._readStorageJSON(INVESTIGATION_KEYS[0]) || this._readStorageJSON(INVESTIGATION_KEYS[1]);
    const payload = {
      app: 'OpenShift Games',
      platform: PLATFORM_LABEL,
      exam: 'EX280V422',
      exportedAt: new Date().toISOString(),
      settings,
      progress,
      investigation,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `openshiftgames-save-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* download unavailable (headless/older browser) */
    }
  }
}

export default SettingsPanel;
