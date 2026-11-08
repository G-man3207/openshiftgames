/**
 * ManifestPanel — the "Files & Manifests" modal (Files toolbar button / `F`).
 *
 * Self-contained: builds its own DOM + <style> and appends it to <body>, so
 * index.html needs no changes beyond the existing #btn-manifests wiring.
 *
 *   const panel = new ManifestPanel(window.game); // or new ManifestPanel(gameEngine)
 *   panel.init();        // create DOM, engine, globals (idempotent)
 *   panel.show();        // open + refresh from the virtual FS
 *   panel.setContext({ focusFiles: ['manifests/deployment.yaml'] });
 *   panel.refresh();     // reload tree/editor after external changes
 *   panel.hide(); panel.destroy();
 *
 * The panel also exposes `manifestEngine` (the ManifestEngine instance) and
 * writes `window.game.manifestPanel` / `window.game.manifestEngine` on init.
 *
 * Browser-only: no top-level `document`/`window` access (Node imports are safe).
 */

import { ManifestEngine } from '../engine/ManifestEngine.js';
import { toManifestObject } from '../data/kindRegistry.js';
import { stringifyYaml } from '../engine/YamlParser.js';

const DOCS_BASE = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22';
const DOCS_LINKS = [
  { label: 'OpenShift 4.22 docs', href: DOCS_BASE },
  { label: 'Building applications', href: `${DOCS_BASE}/html/building_applications/index` },
  { label: 'oc CLI reference', href: `${DOCS_BASE}/html/cli_tools/openshift-cli-oc` },
];
const PANEL_ID = 'og-manifest-panel';
const STYLE_ID = 'og-manifest-panel-styles';

/** DOM builder used only after init(); keeps markup injection-free. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export class ManifestPanel {
  /**
   * @param {object|null} game `window.game` or a GameEngine instance.
   * @param {{engineOptions?: object}} [options]
   */
  constructor(game = null, options = {}) {
    this.game = game;
    this.options = options;
    this.manifestEngine = new ManifestEngine(game, options.engineOptions || {});
    /** Alias kept for code that expects `panel.engine`. */
    this.engine = this.manifestEngine;
    this.visible = false;
    this.initialized = false;
    this.root = null;
    this.dialog = null;
    this.treeEl = null;
    this.editor = null;
    this.pathLabel = null;
    this.dirtyBadge = null;
    this.resultEl = null;
    this.errorEl = null;
    this.tipEl = null;
    this.buttons = {};
    this.currentPath = null;
    this._drafts = new Map();
    this._focusFiles = [];
    this._manifestFiles = [];
    this._context = { focusFiles: [], manifestFiles: [] };
    this._keyHandler = null;
    this._resetHandler = null;
    this._lastResult = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  init() {
    if (this.initialized) return this;
    if (typeof document === 'undefined') return this;

    // Reuse an engine that another module already installed on window.game.
    if (
      typeof window !== 'undefined' &&
      window.game?.manifestEngine &&
      typeof window.game.manifestEngine.applyFile === 'function'
    ) {
      this.manifestEngine = window.game.manifestEngine;
      this.engine = this.manifestEngine;
    }

    this._injectStyles();
    this._buildDom();
    document.body.appendChild(this.root);

    this._keyHandler = (event) => {
      if (!this.visible) return;
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
      }
    };
    document.addEventListener('keydown', this._keyHandler, true);

    // Levels call manifestEngine.resetFiles(); drop stale editor drafts too.
    this._resetHandler = () => {
      this._drafts.clear();
      this.currentPath = null;
      if (this.initialized) this.refresh();
    };
    window.addEventListener('openshiftgames:manifest-reset', this._resetHandler);

    this.initialized = true;
    this._registerGlobals();
    this.refresh();
    return this;
  }

  /**
   * @param {object} [resource] optional resource to edit (from `oc edit`);
   *   a YAML file is materialised under `.oc/` and opened in the editor.
   */
  show(resource) {
    this.init();
    if (!this.initialized) return this;
    const wasVisible = this.visible;
    const editingResource = Boolean(resource && typeof resource === 'object');
    if (editingResource) this._openResourceForEdit(resource);
    this.refresh();
    this.root.style.display = 'flex';
    this.visible = true;
    this._registerGlobals();
    // `oc edit` must keep the requested resource focused; regular opens follow
    // the level's focusFiles context.
    if (!editingResource) this._applyFocusSelection();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        try {
          this.editor?.focus();
        } catch {
          /* ignore */
        }
      });
    }
    // The shell listens to this to freeze the mission clock while the modal is
    // up; emit only on the hidden → visible transition so re-opens cannot stack.
    if (!wasVisible) this._emit('ui:manifest-opened', { path: this.currentPath });
    return this;
  }

  hide() {
    const wasVisible = this.visible;
    this.visible = false;
    if (this.root) this.root.style.display = 'none';
    // Emit only on the visible → hidden transition (close button, backdrop,
    // Esc key handler, programmatic hide and destroy all funnel through here).
    if (wasVisible) this._emit('ui:manifest-closed', { path: this.currentPath });
    return this;
  }

  destroy() {
    this.hide();
    if (this._keyHandler && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._keyHandler, true);
    }
    if (this._resetHandler && typeof window !== 'undefined') {
      window.removeEventListener('openshiftgames:manifest-reset', this._resetHandler);
    }
    this._keyHandler = null;
    this._resetHandler = null;
    this.root?.remove();
    this.root = null;
    this.dialog = null;
    this.treeEl = null;
    this.editor = null;
    this.resultEl = null;
    this.errorEl = null;
    this.tipEl = null;
    this.buttons = {};
    this.initialized = false;
    if (typeof window !== 'undefined' && window.game) {
      if (window.game.manifestPanel === this) window.game.manifestPanel = null;
      if (window.game.manifestEngine === this.manifestEngine) window.game.manifestEngine = null;
    }
    if (typeof document !== 'undefined') document.getElementById(STYLE_ID)?.remove();
    return this;
  }

  // ── context / refresh ────────────────────────────────────────────────────

  /** @param {{focusFiles?: string[], manifestFiles?: string[]}} context */
  setContext(context = {}) {
    if (!context || typeof context !== 'object') return this;
    this._context = { ...this._context, ...context };
    if (Array.isArray(context.focusFiles)) {
      this._focusFiles = dedupe(context.focusFiles.map((entry) => String(entry)));
    }
    if (Array.isArray(context.manifestFiles)) {
      this._manifestFiles = dedupe(context.manifestFiles.map((entry) => String(entry)));
    }
    if (this.initialized) {
      this._renderTree();
      if (this.visible) this._applyFocusSelection();
    }
    return this;
  }

  /** Reload the tree and (when not dirty) the editor from the virtual FS. */
  refresh() {
    if (!this.initialized) {
      this.init();
      return this;
    }
    this._registerGlobals();
    if (this.currentPath && !this.manifestEngine.exists(this.currentPath)) this.currentPath = null;
    this._renderTree();
    if (!this.currentPath) {
      const preferred = this._focusFiles.find((candidate) => this._resolveFocus(candidate));
      this.currentPath = preferred ? this._resolveFocus(preferred) : this._defaultFile();
    }
    if (this.currentPath) this._loadEditor(this.currentPath);
    else {
      if (this.editor) this.editor.value = '';
      this.currentPath = null;
    }
    this._updateToolbar();
    return this;
  }

  /** Open the panel directly on a file (used by `oc edit`). */
  openFile(path) {
    this.show();
    const norm = String(path || '').replace(/^\.\//, '');
    if (this.manifestEngine.exists(norm)) this._selectFile(norm);
    return this;
  }

  /** Materialise a live resource as a manifest file and focus it (`oc edit`). */
  _openResourceForEdit(resource) {
    const kind = String(resource.kind || 'resource');
    const name = String(resource.metadata?.name || 'resource').replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = `.oc/edit-${kind.toLowerCase()}-${name}.yaml`;
    try {
      const manifest = toManifestObject(resource);
      this.manifestEngine.writeFile(path, stringifyYaml(manifest));
      this._drafts.delete(path);
      this.currentPath = path;
    } catch {
      /* if the resource cannot be serialised, keep the current file */
    }
    return path;
  }

  /** Alias for openFile, handy for CLI integration. */
  showFile(path) {
    return this.openFile(path);
  }

  getState() {
    return this.manifestEngine.getState();
  }

  /** Drop unsaved editor drafts (used when a level resets its files). */
  resetDrafts() {
    this._drafts.clear();
    this.currentPath = null;
    if (this.initialized) this.refresh();
    return this;
  }

  // ── DOM construction ─────────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ogmf-overlay { position: fixed; inset: 0; z-index: 260; display: none; align-items: center; justify-content: center;
        background: rgba(6, 8, 11, 0.72); padding: 16px; box-sizing: border-box; }
      .ogmf-dialog { display: flex; flex-direction: column; width: min(1140px, 96vw); height: min(780px, 92vh);
        background: var(--surface, #111419); color: var(--text, #ECEEF1);
        border: 1px solid var(--line-strong, #2C333E); border-radius: 8px; overflow: hidden;
        box-shadow: 0 18px 44px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4); font-family: var(--font-sans, 'Inter', system-ui, sans-serif); }
      .ogmf-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
        padding: 14px 18px; border-bottom: 1px solid var(--line, #1F242C);
        background: transparent; }
      .ogmf-title { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; color: var(--text, #ECEEF1); }
      .ogmf-subtitle { margin: 4px 0 0; font-size: 12px; color: var(--muted, #9AA1A9); }
      .ogmf-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
      .ogmf-docs { display: flex; gap: 8px; flex-wrap: wrap; }
      .ogmf-docs a { font-size: 11px; color: var(--muted, #9AA1A9); text-decoration: none; border-bottom: 1px solid var(--line-strong, #2C333E); }
      .ogmf-docs a:hover { color: var(--text, #ECEEF1); }
      .ogmf-body { display: grid; grid-template-columns: 268px minmax(0, 1fr); flex: 1; min-height: 0; }
      .ogmf-sidebar { border-right: 1px solid var(--line, #1F242C); display: flex;
        flex-direction: column; min-height: 0; background: rgba(255,255,255,.02); }
      .ogmf-sidebar-title { padding: 12px 14px 8px; font-size: 11px; letter-spacing: 0; text-transform: none; font-weight: 600;
        color: var(--faint, #7C8590); }
      .ogmf-tree { overflow: auto; flex: 1; padding: 0 6px 12px; }
      .ogmf-dir { padding: 5px 8px 2px; font-size: 11px; color: var(--text-muted, rgba(255,255,255,.35));
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ogmf-file { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--text-secondary, rgba(255,255,255,.6));
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 4px 8px;
        border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ogmf-file:hover { background: var(--raised, #161A20); color: var(--text, #ECEEF1); }
      .ogmf-file.is-active { background: var(--raised-2, #1B2027); color: var(--text, #ECEEF1); }
      .ogmf-file.is-focus::after { content: ' ·'; color: var(--warning, #E8A33D); font-size: 10px; }
      .ogmf-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 12px 16px 14px; gap: 10px; }
      .ogmf-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ogmf-path { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text, #ECEEF1);
        background: var(--ground, #0A0C10); border: 1px solid var(--line-strong, #2C333E);
        border-radius: 6px; padding: 4px 8px; max-width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ogmf-spacer { flex: 1; }
      .ogmf-dirty { font-size: 11px; text-transform: none; letter-spacing: 0; color: var(--warning, #E8A33D); display: none; }
      .ogmf-btn { font: inherit; font-size: 12px; padding: 6px 11px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--line-strong, #2C333E); background: transparent; color: var(--text, #ECEEF1); }
      .ogmf-btn:hover { background: var(--raised, #161A20); }
      .ogmf-btn:disabled { opacity: .4; cursor: not-allowed; }
      .ogmf-btn-primary { background: var(--text, #ECEEF1); border-color: var(--text, #ECEEF1); color: #0B0D11; font-weight: 600; }
      .ogmf-btn-primary:hover { background: #fff; }
      .ogmf-btn-kustomize { border-color: var(--line-strong, #2C333E); color: var(--text, #ECEEF1); }
      .ogmf-close { background: transparent; border: 0; color: var(--text-secondary, rgba(255,255,255,.6)); font-size: 22px;
        line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
      .ogmf-close:hover { color: #fff; background: rgba(255,255,255,.1); }
      .ogmf-editor { flex: 1; min-height: 160px; resize: none; width: 100%; box-sizing: border-box;
        background: var(--ground, #0A0C10); color: var(--text, #ECEEF1); border: 1px solid var(--line-strong, #2C333E);
        border-radius: 8px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px; line-height: 1.55; tab-size: 2; white-space: pre; overflow: auto; }
      .ogmf-editor:focus { outline: none; border-color: #464F5C; box-shadow: none; }
      .ogmf-output { max-height: 150px; overflow: auto; border-radius: 8px; border: 1px solid transparent; }
      .ogmf-output.has-result { border-color: rgba(63,185,80,.35); background: rgba(63,185,80,.07); }
      .ogmf-output.has-error { border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.08); }
      .ogmf-result { margin: 0; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px; line-height: 1.5; color: #7ee787; white-space: pre-wrap; word-break: break-word; }
      .ogmf-error { margin: 0; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px; line-height: 1.5; color: #ff7b72; white-space: pre-wrap; word-break: break-word; }
      .ogmf-hint { font-size: 11px; color: var(--faint, #7C8590); display: flex; justify-content: space-between; gap: 10px; }
      .ogmf-hint code { color: var(--text-secondary, rgba(255,255,255,.6)); }
      .ogmf-tip { margin: 0; padding: 8px 12px; border-left: 2px solid var(--warning, #E8A33D); border-radius: 0 8px 8px 0;
        background: var(--warning-dim, rgba(232,163,61,.12)); color: var(--text, #ECEEF1); font-size: 12px; line-height: 1.55; }
      .ogmf-tip[hidden] { display: none; }
      .ogmf-tip code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
      @media (max-width: 760px) {
        .ogmf-body { grid-template-columns: 1fr; grid-template-rows: 180px minmax(0, 1fr); }
        .ogmf-sidebar { border-right: 0; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.1)); }
      }
    `;
    document.head.appendChild(style);
  }

  _buildDom() {
    this.pathLabel = el('span', {
      class: 'ogmf-path',
      'data-testid': 'manifest-current-file',
      text: 'no file selected',
    });
    this.dirtyBadge = el('span', { class: 'ogmf-dirty', text: 'unsaved' });

    const makeButton = (id, label, extraClass, onClick, title) => {
      const button = el(
        'button',
        {
          type: 'button',
          class: `ogmf-btn ${extraClass || ''}`.trim(),
          'data-testid': id,
          title: title || label,
          onclick: onClick,
        },
        label
      );
      this.buttons[id] = button;
      return button;
    };

    this.importInput = el('input', {
      type: 'file',
      accept: '.yaml,.yml,.json,text/plain',
      style: { display: 'none' },
      'data-testid': 'manifest-import-input',
      onchange: (event) => this._importSelectedFile(event),
    });

    const toolbar = el('div', { class: 'ogmf-toolbar' }, [
      this.pathLabel,
      this.dirtyBadge,
      el('span', { class: 'ogmf-spacer' }),
      makeButton(
        'manifest-new',
        'New file',
        '',
        () => this._createNewFile(),
        'Create a new virtual manifest file'
      ),
      makeButton(
        'manifest-import',
        'Import',
        '',
        () => this.importInput?.click(),
        'Import a local YAML/JSON file into the virtual filesystem'
      ),
      makeButton(
        'manifest-delete',
        'Delete',
        '',
        () => this._deleteCurrentFile(),
        'Delete the current virtual file (does not delete cluster objects)'
      ),
      makeButton(
        'manifest-save',
        'Save',
        '',
        () => this._saveCurrent(),
        'Write the editor content to the virtual file'
      ),
      makeButton(
        'manifest-reset',
        'Reset',
        '',
        () => this._resetCurrent(),
        'Discard unsaved edits and reload the file'
      ),
      makeButton(
        'manifest-apply',
        'Apply -f',
        'ogmf-btn-primary',
        () => this._applyCurrent(),
        'oc apply -f <current file>'
      ),
      makeButton(
        'manifest-apply-kustomize',
        'Apply -k',
        'ogmf-btn-kustomize',
        () => this._applyKustomize(),
        'oc apply -k <nearest kustomization directory>'
      ),
      this.importInput,
    ]);

    this.editor = el('textarea', {
      class: 'ogmf-editor',
      'data-testid': 'manifest-editor',
      spellcheck: 'false',
      wrap: 'off',
      'aria-label': 'Manifest editor',
      oninput: () => this._onEditorInput(),
    });

    this.resultEl = el('pre', { class: 'ogmf-result', 'data-testid': 'manifest-result' });
    this.errorEl = el('pre', { class: 'ogmf-error', 'data-testid': 'manifest-error' });
    const output = el('div', { class: 'ogmf-output' }, [this.resultEl, this.errorEl]);
    this.outputEl = output;
    // Contextual note for files that Apply -f does not turn into a running app
    // (Templates must be processed, Helm charts installed). See _fileTip().
    this.tipEl = el('div', { class: 'ogmf-tip', 'data-testid': 'manifest-tip', hidden: true });

    const docs = el(
      'div',
      { class: 'ogmf-docs' },
      DOCS_LINKS.map((link) =>
        el('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer', text: link.label })
      )
    );

    const header = el('div', { class: 'ogmf-header' }, [
      el('div', {}, [
        el('h2', { class: 'ogmf-title', id: 'ogmf-title', text: 'Files & Manifests' }),
        el('p', {
          class: 'ogmf-subtitle',
          text: 'Virtual filesystem · oc apply -f · oc apply -k · oc process · helm · htpasswd',
        }),
      ]),
      el('div', { class: 'ogmf-header-actions' }, [
        docs,
        el('button', {
          type: 'button',
          class: 'ogmf-close',
          'data-testid': 'manifest-close',
          'aria-label': 'Close Files panel',
          title: 'Close (Esc)',
          text: '×',
          onclick: () => this.hide(),
        }),
      ]),
    ]);

    this.treeEl = el('div', { class: 'ogmf-tree', role: 'tree', 'aria-label': 'Virtual files' });
    const sidebar = el('aside', { class: 'ogmf-sidebar' }, [
      el('div', { class: 'ogmf-sidebar-title', text: 'Virtual files' }),
      this.treeEl,
    ]);

    const main = el('section', { class: 'ogmf-main' }, [
      toolbar,
      this.editor,
      this.tipEl,
      output,
      el('div', { class: 'ogmf-hint' }, [
        el('span', {}, [
          'Esc closes · ',
          el('code', { text: 'Apply -f' }),
          ' runs against the current project',
        ]),
        el('span', { text: 'oc apply -f / oc apply -k / oc process / helm' }),
      ]),
    ]);

    this.dialog = el(
      'div',
      {
        class: 'ogmf-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ogmf-title',
      },
      [header, el('div', { class: 'ogmf-body' }, [sidebar, main])]
    );

    this.root = el(
      'div',
      {
        class: 'ogmf-overlay',
        id: PANEL_ID,
        'data-testid': 'manifest-panel',
        onclick: (event) => {
          if (event.target === this.root) this.hide();
        },
      },
      [this.dialog]
    );
  }

  _registerGlobals() {
    if (typeof window === 'undefined') return;
    window.game = window.game || {};
    window.game.manifestPanel = this;
    window.game.manifestEngine = this.manifestEngine;
  }

  /** Emit a shell event (best effort: the panel also runs in Node harnesses). */
  _emit(event, data) {
    try {
      const bus =
        this.game?.eventBus ||
        (typeof window !== 'undefined' ? window.game?.gameEngine?.eventBus : null);
      bus?.emit?.(event, data);
    } catch {
      /* ignore event wiring failures */
    }
  }

  // ── file tree / editor ───────────────────────────────────────────────────

  _compareTreeEntries(a, b) {
    const aParts = a.path.split('/');
    const bParts = b.path.split('/');
    const length = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < length; i++) {
      if (aParts[i] === bParts[i]) continue;
      if (aParts[i] < bParts[i]) return -1;
      if (aParts[i] > bParts[i]) return 1;
    }
    if (aParts.length !== bParts.length) return aParts.length - bParts.length;
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return 0;
  }

  _renderTree() {
    if (!this.treeEl) return;
    this.treeEl.textContent = '';
    const entries = this.manifestEngine
      .getFileTree()
      .slice()
      .sort((a, b) => this._compareTreeEntries(a, b));
    for (const entry of entries) {
      const indentPx = 6 + entry.depth * 14;
      if (entry.kind === 'directory') {
        this.treeEl.appendChild(
          el('div', {
            class: 'ogmf-dir',
            style: { paddingLeft: `${indentPx}px` },
            title: entry.path,
            text: `${entry.name}/`,
          })
        );
        continue;
      }
      const button = el('button', {
        type: 'button',
        class: `ogmf-file${entry.path === this.currentPath ? ' is-active' : ''}${
          this._isFocusedFile(entry.path) ? ' is-focus' : ''
        }`,
        style: { paddingLeft: `${indentPx}px` },
        'data-testid': 'manifest-file',
        'data-path': entry.path,
        title: entry.path,
        text: entry.name,
        onclick: () => this._selectFile(entry.path),
      });
      this.treeEl.appendChild(button);
    }
  }

  _isFocusedFile(path) {
    return [...this._focusFiles, ...this._manifestFiles].some(
      (entry) => entry === path || entry === path.split('/').pop() || path.endsWith(`/${entry}`)
    );
  }

  _resolveFocus(entry) {
    if (!entry) return null;
    const value = String(entry);
    const files = this.manifestEngine.listFiles();
    if (files.includes(value)) return value;
    const byBasename = files.filter((file) => file.split('/').pop() === value);
    if (byBasename.length === 1) return byBasename[0];
    const bySuffix = files.filter((file) => file.endsWith(`/${value}`));
    return bySuffix.length === 1 ? bySuffix[0] : null;
  }

  _defaultFile() {
    const preferred = [...this._focusFiles, ...this._manifestFiles]
      .map((entry) => this._resolveFocus(entry))
      .find(Boolean);
    if (preferred) return preferred;
    const files = this.manifestEngine.listFiles();
    return files.includes('manifests/deployment.yaml')
      ? 'manifests/deployment.yaml'
      : files[0] || null;
  }

  _applyFocusSelection() {
    // Explicit `focusFiles` wins over the wider `manifestFiles` highlight list.
    const focusPath = this._focusFiles.map((entry) => this._resolveFocus(entry)).find(Boolean);
    if (!focusPath) return;
    if (
      this.currentPath &&
      this._focusFiles.some((entry) => this._resolveFocus(entry) === this.currentPath)
    )
      return;
    this._selectFile(focusPath);
  }

  _selectFile(path) {
    if (!this.manifestEngine.exists(path)) return;
    if (this.currentPath === path) return;
    // Preserve unsaved editor state for the previous file.
    if (this.currentPath && this.editor && this._dirty()) {
      this._drafts.set(this.currentPath, this.editor.value);
    }
    this.currentPath = path;
    this._renderTree();
    this._loadEditor(path);
    this._updateToolbar();
    this.errorEl.textContent = '';
    this.resultEl.textContent = '';
    this.outputEl.className = 'ogmf-output';
  }

  _loadEditor(path) {
    if (!this.editor) return;
    const draft = this._drafts.get(path);
    this.editor.value = draft !== undefined ? draft : (this.manifestEngine.readFile(path) ?? '');
    this.editor.scrollTop = 0;
    this._updateToolbar();
  }

  _dirty() {
    if (!this.currentPath || !this.editor) return false;
    return (
      this._drafts.has(this.currentPath) ||
      this.editor.value !== (this.manifestEngine.readFile(this.currentPath) ?? '')
    );
  }

  _onEditorInput() {
    if (!this.currentPath) return;
    this._drafts.set(this.currentPath, this.editor.value);
    this._updateToolbar(false);
  }

  /** Show or hide the contextual note for the open file. */
  _updateTip() {
    if (!this.tipEl) return;
    const path = this.currentPath;
    const text = path ? (this.editor?.value ?? this.manifestEngine.readFile(path) ?? '') : '';
    const children = this._fileTip(path, text);
    this.tipEl.replaceChildren(...(children || []));
    this.tipEl.hidden = !children;
  }

  /**
   * What the player needs to know before pressing Apply -f on this file:
   * `oc apply -f` on a Template only stores it (it must be processed), and a
   * Helm chart is installed as a whole, never file by file.
   * @returns {Array<string|Node>|null}
   */
  _fileTip(path, text) {
    if (!path) return null;
    if (/^\s*kind:\s*Template\s*$/m.test(text)) {
      return [
        el('b', { text: 'This file is a Template. ' }),
        'Apply -f only stores it; it does not create the app. Process it in the terminal: ',
        el('code', { text: `oc process -f ${path} -p KEY=value | oc apply -f -` }),
        ' (list its parameters with ',
        el('code', { text: `oc process --parameters -f ${path}` }),
        ').',
      ];
    }
    const chartRoot = this._helmChartRoot(path);
    if (chartRoot) {
      return [
        el('b', { text: 'Helm chart files are not applied one by one. ' }),
        'Install the whole chart from the terminal: ',
        el('code', { text: `helm install <release-name> ${chartRoot}` }),
        '.',
      ];
    }
    return null;
  }

  /** The nearest directory at or above `path` that holds a Chart.yaml. */
  _helmChartRoot(path) {
    let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    while (dir) {
      if (this.manifestEngine.exists(`${dir}/Chart.yaml`)) return dir;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    return null;
  }

  _updateToolbar(renderTree = true) {
    if (!this.initialized) return;
    this.pathLabel.textContent = this.currentPath || 'no file selected';
    this._updateTip();
    const dirty = this._dirty();
    this.dirtyBadge.style.display = dirty ? 'inline' : 'none';
    for (const key of [
      'manifest-save',
      'manifest-reset',
      'manifest-apply',
      'manifest-apply-kustomize',
      'manifest-delete',
    ]) {
      const button = this.buttons[key];
      if (button) button.disabled = !this.currentPath;
    }
    if (renderTree) this._renderTree();
  }

  // ── actions ──────────────────────────────────────────────────────────────

  _saveCurrent({ quiet = false } = {}) {
    if (!this.currentPath) return false;
    const path = this.currentPath;
    const isEditBuffer = path.startsWith('.oc/edit-');
    const previous = this.manifestEngine.readFile(path) ?? '';
    this.manifestEngine.writeFile(path, this.editor.value);
    this._drafts.delete(path);
    if (!isEditBuffer) {
      this._updateToolbar();
      if (!quiet) this._showSuccess(`Saved ${path}`);
      return true;
    }
    // Real `oc edit` applies the buffer when the editor is saved. The panel
    // materialises the object under `.oc/edit-*`; Save must apply it, not just
    // write the virtual file (the CLI reports "Save to apply changes").
    let result;
    try {
      result = this.manifestEngine.applyFile(path);
    } catch (err) {
      result = { ok: false, errors: [err?.message || String(err)], created: [], updated: [] };
    }
    this._lastResult = result;
    this._showResult(result);
    if (!result.ok) {
      // Keep the attempted YAML as an unsaved draft and restore the last good file.
      this.manifestEngine.writeFile(path, previous);
      this._drafts.set(path, this.editor.value);
    }
    this.refresh();
    return Boolean(result.ok);
  }

  /** Create a new file in the virtual filesystem (manifest authoring in-game). */
  _createNewFile() {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return false;
    const baseDir =
      this.currentPath && this.currentPath.includes('/')
        ? this.currentPath.slice(0, this.currentPath.lastIndexOf('/') + 1)
        : 'manifests/';
    const suggested = `${baseDir}new-app.yaml`;
    const input = window.prompt(
      'New virtual file path (created in-memory; not on the host)',
      suggested
    );
    if (input === null || input === undefined) return false;
    const path = String(input).trim();
    if (!path) return false;
    if (this.manifestEngine.exists(path)) {
      this._showError(`A virtual file already exists at "${path}"`);
      return false;
    }
    const starter = `# New manifest. Edit, Save, then Apply -f (oc apply -f ${path}).
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  key: value
`;
    this.manifestEngine.writeFile(path, starter);
    this._drafts.delete(path);
    this.currentPath = this.manifestEngine.exists(path) ? path : null;
    this.refresh();
    this._showSuccess(`Created ${path} - edit it, then Apply -f`);
    return true;
  }

  /** Import a local YAML/JSON file into the virtual filesystem. */
  _importSelectedFile(event) {
    const input = event?.target;
    const file = input?.files && input.files[0];
    if (!file) return false;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const suggested = `imports/${file.name || 'imported.yaml'}`;
      const target =
        typeof window.prompt === 'function'
          ? window.prompt(`Import "${file.name}" as virtual path`, suggested)
          : suggested;
      if (target === null || target === undefined) return;
      const path = String(target).trim();
      if (!path) return;
      this.manifestEngine.writeFile(path, text);
      this._drafts.delete(path);
      this.currentPath = path;
      this.refresh();
      this._showSuccess(
        `Imported ${path} (${text.split('\n').length} lines) - apply with Apply -f`
      );
    };
    reader.readAsText(file);
    if (input) input.value = '';
    return true;
  }

  /** Delete the current virtual file (cluster objects are not touched). */
  _deleteCurrentFile() {
    if (!this.currentPath) return false;
    const path = this.currentPath;
    const confirmed =
      typeof window.confirm === 'function'
        ? window.confirm(
            `Delete virtual file "${path}"?\n\nCluster resources created from it are not deleted.`
          )
        : true;
    if (!confirmed) return false;
    this.manifestEngine.deleteFile(path);
    this._drafts.delete(path);
    this.currentPath = null;
    this.refresh();
    this._showSuccess(`Deleted ${path} from the virtual filesystem`);
    return true;
  }

  _resetCurrent() {
    if (!this.currentPath) return;
    this._drafts.delete(this.currentPath);
    this._loadEditor(this.currentPath);
    this._showSuccess(`Reverted ${this.currentPath} to the last saved content`);
  }

  _applyCurrent() {
    if (!this.currentPath) return;
    const path = this.currentPath;
    const previous = this.manifestEngine.readFile(path) ?? '';
    const wasDirty = this._dirty();
    if (wasDirty) this._saveCurrent({ quiet: true });

    this._clearOutput();
    let result;
    try {
      result = this.manifestEngine.applyFile(path);
    } catch (err) {
      result = { ok: false, errors: [err?.message || String(err)], created: [], updated: [] };
    }
    // A failed apply must not leave the virtual file in a broken state: keep the
    // attempted content as an unsaved draft and restore the last good file.
    if (!result.ok && wasDirty) {
      this.manifestEngine.writeFile(path, previous);
      this._drafts.set(path, this.editor?.value ?? '');
    }
    this._lastResult = result;
    this._showResult(result);
    this.refresh();
    return result;
  }

  _applyKustomize() {
    if (!this.currentPath) return;
    // Persist every draft below the kustomization directory first.
    const dir = this._nearestKustomizationDir(this.currentPath);
    for (const [draftPath, text] of [...this._drafts.entries()]) {
      if (dir === '' || draftPath === dir || draftPath.startsWith(`${dir}/`)) {
        this.manifestEngine.writeFile(draftPath, text);
        this._drafts.delete(draftPath);
      }
    }
    this._updateToolbar();
    this._run(() => this.manifestEngine.applyKustomize(dir));
  }

  _nearestKustomizationDir(path) {
    let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const candidates = [];
    while (true) {
      candidates.push(dir);
      if (!dir) break;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    for (const candidate of candidates) {
      const prefix = candidate ? `${candidate}/` : '';
      if (
        this.manifestEngine.exists(`${prefix}kustomization.yaml`) ||
        this.manifestEngine.exists(`${prefix}kustomization.yml`) ||
        this.manifestEngine.exists(`${prefix}Kustomization`)
      ) {
        return candidate;
      }
    }
    return candidates[0] || '';
  }

  _clearOutput() {
    if (!this.resultEl || !this.errorEl || !this.outputEl) return;
    this.resultEl.textContent = '';
    this.errorEl.textContent = '';
    this.outputEl.className = 'ogmf-output';
  }

  _run(operation) {
    this._clearOutput();
    let result;
    try {
      result = operation();
    } catch (err) {
      result = { ok: false, errors: [err?.message || String(err)], created: [], updated: [] };
    }
    this._lastResult = result;
    this._showResult(result);
    this.refresh();
    return result;
  }

  _showResult(result) {
    const created = Array.isArray(result?.created) ? result.created : [];
    const updated = Array.isArray(result?.updated) ? result.updated : [];
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    const lines = [];
    for (const ref of created) lines.push(`${this._refLabel(ref)} created`);
    for (const ref of updated) lines.push(`${this._refLabel(ref)} configured`);
    // Some apply paths (the config.openshift.io Project singleton) report via a
    // real-oc message instead of created/updated refs.
    if (
      result?.ok &&
      lines.length === 0 &&
      typeof result?.message === 'string' &&
      result.message.trim()
    ) {
      lines.push(result.message.trim());
    }
    if (result?.ok && lines.length === 0) lines.push('apply complete: no changes');
    for (const warning of warnings) lines.push(`warning: ${warning}`);
    if (result?.ok) {
      this.resultEl.textContent = lines.join('\n');
      this.errorEl.textContent = '';
      this.outputEl.className = 'ogmf-output has-result';
    } else {
      const errorLines = errors.length ? errors : ['unknown error'];
      this.errorEl.textContent = errorLines.join('\n');
      this.resultEl.textContent = lines.join('\n');
      this.outputEl.className = 'ogmf-output has-error';
    }
  }

  _showSuccess(message) {
    this.resultEl.textContent = message;
    this.errorEl.textContent = '';
    this.outputEl.className = 'ogmf-output has-result';
  }

  _showError(message) {
    this.resultEl.textContent = '';
    this.errorEl.textContent = String(message || 'error');
    this.outputEl.className = 'ogmf-output has-error';
  }

  _refLabel(ref) {
    if (!ref) return 'resource';
    const kind = String(ref.kind || 'resource').toLowerCase();
    const namespace = ref.namespace ? ` (project ${ref.namespace})` : '';
    return `${kind}/${ref.name || 'unnamed'}${namespace}`;
  }
}

export default ManifestPanel;
