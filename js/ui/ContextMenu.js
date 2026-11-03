/**
 * ContextMenu — right-click actions for an OpenShift resource.
 *
 * Actions are derived per kind and labelled with OpenShift/`oc` wording:
 * Expose Service → Route, Start Build, Rollout Restart/Undo, Scale, Logs,
 * Investigate, Edit YAML, Add to SCC, Install/Uninstall Operator, Delete.
 *
 * Wiring stays compatible with index.html:
 *   in : `resource:contextmenu` { uid, resource, x, y }
 *   out: `resource:selected`, `ui:scale-dialog`, `ui:edit-resource`,
 *        `ui:run-command`, `ui:toggle-incidents`, `operator:*`
 *
 * Engine handlers (`window.game.gameEngine`) are used when present:
 * exposeService, startBuild, rollout, scale/queueCommand, addSCC*, deleteResource.
 * Otherwise the panel falls back to the existing `ui:*` events.
 *
 * All kind/apiVersion display data comes from the central registry; there is
 * no hard-coded API metadata here.
 */

import { KIND_DEFS, isClusterScopedKind } from '../data/kindRegistry.js';

const DELETE_ACTION = { id: 'delete', label: 'Delete', shortcut: 'Del', event: 'resource:delete', danger: true };
const EDIT_ACTION = { id: 'edit-yaml', label: 'Edit YAML', shortcut: 'Y', event: 'ui:edit-resource' };
const DESCRIBE_ACTION = { id: 'describe', label: 'Describe', shortcut: 'D', event: 'resource:describe' };
const LOGS_KINDS = new Set(['Pod', 'Deployment', 'BuildConfig', 'Build']);
const SCALE_KINDS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet']);
const ROLLOUT_KINDS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet']);
const IDENTITY_KINDS = new Set(['User', 'Group', 'ServiceAccount']);

export class ContextMenu {
  constructor() {
    this.container = null;
    this.visible = false;
    this.resource = null;
    this._boundClose = this._onClickOutside.bind(this);
    this._boundKeydown = this._onKeydown.bind(this);
    this._boundContextMenu = this._onContextMenu.bind(this);
    this._boundContainerClick = this._onContainerClick.bind(this);
    this._contextHandler = null;
    this._deleteHandler = null;
    this._resetHandler = null;
    this._stoppedHandler = null;
    this._ignoreNextContextMenu = false;
  }

  init() {
    if (this.container) this.destroy();

    this.container = document.createElement('div');
    this.container.id = 'context-menu';
    this.container.className = 'fixed z-50 hidden';
    this.container.setAttribute('data-testid', 'context-menu');
    this.container.setAttribute('role', 'menu');
    this.container.setAttribute('aria-label', 'OpenShift resource actions');
    document.body.appendChild(this.container);
    this.container.addEventListener('click', this._boundContainerClick);

    const bus = this._bus();
    if (bus) {
      this._contextHandler = (data) => {
        if (!data) return;
        this.resource = data.resource || this._cluster()?.getResource?.(data.uid) || null;
        if (!this.resource) return;
        this._ignoreNextContextMenu = true;
        // The engine event is emitted from the native contextmenu handler; keep
        // the close-on-right-click guard from swallowing a later, unrelated click.
        setTimeout(() => { this._ignoreNextContextMenu = false; }, 0);
        this.show(data.x ?? 0, data.y ?? 0);
      };
      this._deleteHandler = () => this.hide();
      this._resetHandler = () => this.hide();
      this._stoppedHandler = () => this.destroy();
      bus.on('resource:contextmenu', this._contextHandler);
      bus.on('cluster:deleted', this._deleteHandler);
      bus.on('cluster:reset', this._resetHandler);
      bus.on('engine:stopped', this._stoppedHandler);
    }

    document.addEventListener('contextmenu', this._boundContextMenu);
  }

  destroy() {
    const bus = this._bus();
    if (bus) {
      if (this._contextHandler) bus.off?.('resource:contextmenu', this._contextHandler);
      if (this._deleteHandler) bus.off?.('cluster:deleted', this._deleteHandler);
      if (this._resetHandler) bus.off?.('cluster:reset', this._resetHandler);
      if (this._stoppedHandler) bus.off?.('engine:stopped', this._stoppedHandler);
    }
    this._contextHandler = null;
    this._deleteHandler = null;
    this._resetHandler = null;
    this._stoppedHandler = null;

    document.removeEventListener('contextmenu', this._boundContextMenu);
    document.removeEventListener('click', this._boundClose);
    document.removeEventListener('keydown', this._boundKeydown);
    this.container?.removeEventListener('click', this._boundContainerClick);
    this.container?.remove();
    this.container = null;
    this.resource = null;
    this.visible = false;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  _bus() {
    return window.game?.engine || window.game?.app?.engine?.eventBus || null;
  }

  _cluster() {
    return window.game?.cluster || window.game?.app?.engine?.cluster || null;
  }

  _gameEngine() {
    return window.game?.gameEngine || window.game?.app?.engine || null;
  }

  _emit(event, data) {
    try {
      this._bus()?.emit?.(event, data);
    } catch {
      /* EventBus unavailable */
    }
  }

  _runCommand(command) {
    this._emit('ui:run-command', { command });
  }

  _nsFlag() {
    const namespace = this.resource?.metadata?.namespace;
    return namespace ? ` -n ${namespace}` : '';
  }

  _resourceRef() {
    const kind = this.resource?.kind || '';
    const name = this.resource?.metadata?.name || '';
    return `${kind}/${name}`;
  }

  // ─── Action model ──────────────────────────────────────────────────────

  _actionsFor(resource) {
    const kind = resource.kind || '';
    const groups = [];
    const inspect = [DESCRIBE_ACTION];

    if (LOGS_KINDS.has(kind)) {
      const ref = kind === 'BuildConfig' ? `bc/${resource.metadata?.name}` : kind === 'Build' ? `build/${resource.metadata?.name}` : kind === 'Deployment' ? `deploy/${resource.metadata?.name}` : resource.metadata?.name;
      inspect.push({ id: 'logs', label: 'View Logs', shortcut: 'L', event: 'pod:logs', command: `logs ${ref}${this._nsFlag()}` });
    }
    inspect.push({ id: 'investigate', label: 'Investigate', shortcut: 'I', event: 'ui:investigate-resource' });
    groups.push({ group: 'inspect', actions: inspect });

    const manage = [];
    switch (kind) {
      case 'Service':
        manage.push({ id: 'expose', label: 'Expose Service → Route', shortcut: 'E', event: 'service:expose' });
        break;
      case 'BuildConfig':
        manage.push({ id: 'start-build', label: 'Start Build', shortcut: 'B', event: 'build:start' });
        break;
      case 'Deployment':
      case 'ReplicaSet':
      case 'StatefulSet':
        manage.push({ id: 'scale', label: 'Scale', shortcut: 'S', event: 'deployment:scale' });
        manage.push({ id: 'rollout-restart', label: 'Rollout Restart', shortcut: 'R', event: 'deployment:restart' });
        manage.push({ id: 'rollout-undo', label: 'Rollout Undo', shortcut: 'U', event: 'deployment:rollback' });
        break;
      case 'DaemonSet':
        manage.push({ id: 'rollout-restart', label: 'Rollout Restart', shortcut: 'R', event: 'deployment:restart' });
        break;
      case 'Node':
        manage.push({
          id: resource.spec?.unschedulable ? 'uncordon' : 'cordon',
          label: resource.spec?.unschedulable ? 'Uncordon' : 'Cordon',
          shortcut: 'C',
          event: resource.spec?.unschedulable ? 'node:uncordon' : 'node:cordon',
        });
        manage.push({ id: 'drain', label: 'Drain', shortcut: 'N', event: 'node:drain' });
        manage.push({ id: 'top-node', label: 'Top Node', shortcut: 'T', event: 'node:top' });
        break;
      case 'Project':
        manage.push({ id: 'switch-project', label: 'Switch to Project', shortcut: 'P', event: 'project:switch' });
        break;
      case 'User':
      case 'Group':
      case 'ServiceAccount':
        manage.push({ id: 'add-scc', label: 'Add to SCC', shortcut: 'A', event: 'scc:add' });
        break;
      case 'SecurityContextConstraints':
        manage.push({ id: 'grant-scc-current', label: 'Add to SCC', shortcut: 'A', event: 'scc:grant' });
        break;
      case 'Subscription':
        manage.push({
          id: resource.status?.phase === 'Succeeded' ? 'uninstall-operator' : 'install-operator',
          label: resource.status?.phase === 'Succeeded' ? 'Uninstall Operator' : 'Install Operator',
          shortcut: 'O',
          event: 'operator:manage',
        });
        break;
      default:
        break;
    }
    if (manage.length > 0) groups.push({ group: 'manage', actions: manage });

    groups.push({ group: 'meta', actions: [EDIT_ACTION, DELETE_ACTION] });

    return groups;
  }

  // ─── Rendering / positioning ───────────────────────────────────────────

  show(x, y) {
    if (!this.resource || !this.container) return;
    const kind = this.resource.kind || 'Unknown';
    const name = this.resource.metadata?.name || 'unnamed';
    const def = KIND_DEFS[kind] || {};
    const apiVersion = this.resource.apiVersion || def.apiVersion || '';
    const scope = isClusterScopedKind(kind) ? 'cluster-scoped' : (this.resource.metadata?.namespace || 'default');
    const groups = this._actionsFor(this.resource);

    this.container.innerHTML = `
      <div class="backdrop-blur-xl bg-gray-900/95 border border-white/10 rounded-lg shadow-2xl overflow-hidden min-w-[220px]">
        <div class="px-3 py-2 border-b border-white/5">
          <div class="text-white/90 text-xs font-medium truncate" data-testid="context-menu-title">${this._escapeHTML(name)}</div>
          <div class="text-white/30 text-[10px] truncate">${this._escapeHTML(kind)}${apiVersion ? ` · ${this._escapeHTML(apiVersion)}` : ''} · ${this._escapeHTML(scope)}</div>
        </div>
        ${groups.map((group, groupIndex) => `
          ${groupIndex > 0 ? '<div class="h-px bg-white/5"></div>' : ''}
          <div class="py-1" role="group">
            ${group.actions.map((action) => `
              <button
                class="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${action.danger ? 'text-red-400 hover:bg-red-400/10' : 'text-white/70 hover:bg-white/5'}"
                data-action-id="${this._escapeHTML(action.id)}"
                data-event="${this._escapeHTML(action.event || action.id)}"
                data-testid="context-menu-${this._escapeHTML(action.id)}"
                role="menuitem"
                ${action.command ? `data-command="${this._escapeHTML(action.command)}"` : ''}
              >
                <span>${this._escapeHTML(action.label)}</span>
                <span class="text-white/20 text-[10px] ml-4">${this._escapeHTML(action.shortcut || '')}</span>
              </button>
            `).join('')}
          </div>
        `).join('')}
        <div class="px-3 py-1.5 border-t border-white/5 text-[9px] text-white/20 flex items-center justify-between">
          <span>OpenShift 4.22 · oc</span>
          <span>Esc to close</span>
        </div>
      </div>
    `;

    this.container.style.visibility = 'hidden';
    this.container.style.left = '0px';
    this.container.style.top = '0px';
    this.container.classList.remove('hidden');

    const rect = this.container.getBoundingClientRect();
    const width = rect.width || 220;
    const height = rect.height || 260;
    const margin = 8;
    const finalX = x + width > window.innerWidth - margin ? x - width : x;
    const finalY = y + height > window.innerHeight - margin ? y - height : y;
    this.container.style.left = `${Math.max(margin, finalX)}px`;
    this.container.style.top = `${Math.max(margin, finalY)}px`;
    this.container.style.visibility = '';

    this.visible = true;
    document.addEventListener('click', this._boundClose);
    document.addEventListener('keydown', this._boundKeydown);
  }

  hide() {
    this.container?.classList.add('hidden');
    this.container?.style.removeProperty('visibility');
    this.visible = false;
    this.resource = null;
    document.removeEventListener('click', this._boundClose);
    document.removeEventListener('keydown', this._boundKeydown);
  }

  _onClickOutside(event) {
    if (this.container && !this.container.contains(event.target)) this.hide();
  }

  _onContextMenu(event) {
    if (this._ignoreNextContextMenu) {
      this._ignoreNextContextMenu = false;
      return;
    }
    if (event.target.closest?.('#context-menu')) return;
    if (this.visible) {
      event.preventDefault();
      this.hide();
    }
  }

  _onKeydown(event) {
    if (event.key === 'Escape') {
      this.hide();
      return;
    }
    if (!this.resource) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const key = event.key;
    for (const group of this._actionsFor(this.resource)) {
      for (const action of group.actions) {
        if (!action.shortcut) continue;
        const matchesLetter = action.shortcut.length === 1 && action.shortcut.toLowerCase() === key.toLowerCase();
        const matchesDelete = action.shortcut === 'Del' && (key === 'Delete' || key === 'Backspace');
        if (matchesLetter || matchesDelete) {
          event.preventDefault();
          this._executeAction(action);
          this.hide();
          return;
        }
      }
    }
  }

  _onContainerClick(event) {
    const button = event.target.closest?.('[data-action-id]');
    if (!button || !this.container?.contains(button)) return;
    const actionId = button.dataset.actionId;
    const action = this._allActions().find((candidate) => candidate.id === actionId) || { id: actionId };
    if (button.dataset.command) action.command = button.dataset.command;
    this._executeAction(action);
    this.hide();
  }

  _allActions() {
    return [
      DESCRIBE_ACTION,
      { id: 'edit-yaml', label: 'Edit YAML' },
      { id: 'logs', label: 'View Logs' },
      { id: 'investigate', label: 'Investigate' },
      { id: 'expose', label: 'Expose Service' },
      { id: 'start-build', label: 'Start Build' },
      { id: 'scale', label: 'Scale' },
      { id: 'rollout-restart', label: 'Rollout Restart' },
      { id: 'rollout-undo', label: 'Rollout Undo' },
      { id: 'cordon', label: 'Cordon' },
      { id: 'uncordon', label: 'Uncordon' },
      { id: 'drain', label: 'Drain' },
      { id: 'top-node', label: 'Top Node' },
      { id: 'switch-project', label: 'Switch Project' },
      { id: 'add-scc', label: 'Add to SCC' },
      { id: 'grant-scc-current', label: 'Add to SCC' },
      { id: 'install-operator', label: 'Install Operator' },
      { id: 'uninstall-operator', label: 'Uninstall Operator' },
      DELETE_ACTION,
    ];
  }

  // ─── Action execution ──────────────────────────────────────────────────

  _executeAction(action) {
    if (!this.resource) return;
    const resource = this.resource;
    const gameEngine = this._gameEngine();
    const cluster = this._cluster();
    const uid = resource.metadata?.uid;
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || undefined;
    const nsFlag = this._nsFlag();

    switch (action.id) {
      case 'describe':
        this._emit('resource:selected', { uid });
        return;

      case 'edit-yaml':
        this._editYaml();
        return;

      case 'logs':
        this._runCommand(action.command || `logs ${name}${nsFlag}`);
        return;

      case 'investigate':
        this._emit('ui:toggle-incidents');
        this._emit('ui:investigate-resource', { uid, kind, name, namespace });
        return;

      case 'expose': {
        let result = null;
        if (typeof gameEngine?.exposeService === 'function') {
          try {
            result = gameEngine.exposeService(name, { namespace });
          } catch {
            result = null;
          }
        }
        if (!result) this._runCommand(`expose svc/${name}${nsFlag}`);
        return;
      }

      case 'start-build': {
        let result = null;
        if (typeof gameEngine?.startBuild === 'function') {
          try {
            result = gameEngine.startBuild(name, { namespace });
          } catch {
            result = null;
          }
        }
        if (!result) this._runCommand(`start-build ${name}${nsFlag}`);
        return;
      }

      case 'scale':
        this._emit('ui:scale-dialog', { uid, kind, name, namespace });
        return;

      case 'rollout-restart':
      case 'rollout-undo': {
        const subcommand = action.id === 'rollout-restart' ? 'restart' : 'undo';
        let result = null;
        if (typeof gameEngine?.rollout === 'function') {
          try {
            result = gameEngine.rollout(kind || 'Deployment', subcommand, name, { namespace });
          } catch {
            result = null;
          }
        }
        if (!result) this._runCommand(`rollout ${subcommand} ${kind || 'Deployment'}/${name}${nsFlag}`);
        return;
      }

      case 'cordon':
      case 'uncordon':
      case 'drain':
        if (typeof gameEngine?.queueCommand === 'function') {
          try {
            gameEngine.queueCommand({ type: action.id, name });
          } catch {
            this._runCommand(`adm ${action.id === 'drain' ? 'drain' : action.id} node/${name}`);
          }
        } else {
          this._runCommand(`adm ${action.id === 'drain' ? 'drain' : action.id} node/${name}`);
        }
        return;

      case 'top-node':
        this._runCommand('adm top nodes');
        return;

      case 'switch-project':
        if (typeof gameEngine?.switchProject === 'function') {
          try {
            gameEngine.switchProject(name);
          } catch {
            this._runCommand(`project ${name}`);
          }
        } else {
          this._runCommand(`project ${name}`);
        }
        return;

      case 'add-scc':
        this._addToSCC(resource, gameEngine, nsFlag);
        return;

      case 'grant-scc-current': {
        const currentUser = gameEngine?.currentUser || 'kubeadmin';
        let result = null;
        if (typeof gameEngine?.addSCCToUser === 'function') {
          try {
            result = gameEngine.addSCCToUser(name, currentUser);
          } catch {
            result = null;
          }
        }
        if (!result) this._runCommand(`adm policy add-scc-to-user ${name} ${currentUser}`);
        return;
      }

      case 'install-operator':
        this._installOperator(resource, gameEngine);
        return;

      case 'uninstall-operator': {
        let result = null;
        if (typeof gameEngine?.deleteResource === 'function') {
          try {
            result = gameEngine.deleteResource('Subscription', name, namespace);
          } catch {
            result = null;
          }
        }
        if (!result && cluster?.remove && uid) cluster.remove(uid);
        if (result?.success !== false) this._emit('operator:uninstalled', { name, namespace });
        return;
      }

      case 'delete': {
        let result = null;
        if (typeof gameEngine?.deleteResource === 'function') {
          try {
            result = gameEngine.deleteResource(kind, name, namespace);
          } catch {
            result = null;
          }
        }
        if (!result && cluster?.remove && uid && cluster.getResource?.(uid)) {
          cluster.remove(uid);
        }
        this._emit('resource:deleted', { uid, kind, name, namespace, message: result?.message || '' });
        return;
      }

      default:
        this._emit(action.event || action.id, { uid, kind, name, namespace });
    }
  }

  _editYaml() {
    const resource = this.resource;
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const command = `edit ${kind} ${name}${this._nsFlag()}`;
    const app = window.game?.app;
    const bar = app?.commandBar;
    const exec = bar?.executeCommand || bar?._executeCommand;
    if (typeof exec === 'function') {
      try {
        exec.call(bar, command);
        return;
      } catch {
        /* fall through to the event contract */
      }
    }
    if (window.game?.app?.commandBar) {
      this._emit('ui:run-command', { command });
      return;
    }
    this._emit('ui:edit-resource', { uid: resource.metadata?.uid, kind, name, namespace: resource.metadata?.namespace });
  }

  _bestSCCName() {
    const cluster = this._cluster();
    let sccs = [];
    try {
      sccs = cluster?.getResourcesByKind?.('SecurityContextConstraints') || cluster?.getByKind?.('SecurityContextConstraints') || [];
    } catch {
      sccs = [];
    }
    const names = sccs.map((scc) => scc.metadata?.name).filter(Boolean);
    return names.includes('anyuid') ? 'anyuid' : (names[0] || 'anyuid');
  }

  _addToSCC(resource, gameEngine, nsFlag) {
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const sccName = this._bestSCCName();
    let result = null;
    try {
      if (kind === 'ServiceAccount' && typeof gameEngine?.addSCCToServiceAccount === 'function') {
        result = gameEngine.addSCCToServiceAccount(sccName, name, { namespace: resource.metadata?.namespace });
      } else if (kind === 'Group' && typeof gameEngine?.addSCCToGroup === 'function') {
        result = gameEngine.addSCCToGroup(sccName, name);
      } else if (typeof gameEngine?.addSCCToUser === 'function' && kind === 'User') {
        result = gameEngine.addSCCToUser(sccName, name);
      }
    } catch {
      result = null;
    }
    if (!result) {
      const subject = kind === 'ServiceAccount' ? `-z ${name}` : name;
      const flag = kind === 'Group' ? 'add-scc-to-group' : 'add-scc-to-user';
      this._runCommand(`adm policy ${flag} ${sccName} ${subject}${nsFlag}`);
    }
  }

  _installOperator(resource, gameEngine) {
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace;
    const packageName = resource.spec?.packageName || resource.spec?.name || name;
    let result = null;

    if (typeof gameEngine?.installOperator === 'function') {
      try {
        result = gameEngine.installOperator(name, { namespace });
      } catch {
        result = null;
      }
    }
    if (!result && resource.status) {
      // Clear a failed install and let the OLM controller retry.
      try {
        resource.spec = resource.spec || {};
        resource.spec.failure = false;
        delete resource.spec.installFailed;
        resource.status.phase = 'Installing';
        resource.status.reason = 'Installing';
        resource.status.message = `installing operator ${packageName}`;
        resource.status.installedCSV = resource.status.installedCSV || '';
        resource._installElapsed = 0;
        this._cluster()?.update?.(resource.metadata?.uid, resource);
        this._emit('operator:installing', { name, namespace, packageName });
        result = { success: true };
      } catch {
        result = null;
      }
    }
    if (!result) {
      this._runCommand(`create -f examples/subscription.yaml -n ${namespace || 'openshift-operators'}`);
    }
  }

  _escapeHTML(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
  }
}

export default ContextMenu;
