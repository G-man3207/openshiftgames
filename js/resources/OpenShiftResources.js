/**
 * OpenShift-specific resource classes (OpenShift 4.22 / EX280).
 *
 * These kinds are first-class in OpenShift Games: they appear in the palette,
 * the 3D renderer, the inspector, `oc` output and YAML export. All classes
 * extend ResourceBase and follow the same contract:
 *   - constructor accepts just `{ name }` (namespace defaults are applied by
 *     the registry factory / base class),
 *   - defaults are deep-cloned per instance via `_initSpec`,
 *   - status skeletons are created immediately (no `tick()` assumptions),
 *   - `toYAML()`/`toManifestObject()` are inherited from ResourceBase (they use
 *     the shared ManifestSerializer, which flattens spec-less kinds such as
 *     SCC or Template to their real top-level field layout),
 *   - each class provides a realistic `oc describe` via `toDescribe()`.
 *
 * The game keeps every payload under `.spec` for uniform engine/UI code; the
 * serializer lifts the flat kinds (SecurityContextConstraints, Template,
 * ConfigMap, Secret, ...) back to the API's top-level fields when exporting.
 */

import { ResourceBase } from './ResourceBase.js';
import { OCP_CHANNEL, OCP_VERSION } from '../data/platformVersions.js';
import { deepClone } from './ManifestSerializer.js';

const timestamp = () => new Date().toISOString();

/** `5s` / `2m` / `3h` / `4d` — the age suffix real tabwriter describe output uses. */
function relativeAge(value) {
  if (!value) return '0s';
  const ms = Date.now() - new Date(value).getTime();
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Default apps wildcard domain used by the simulator's ingress router. */
export const APPS_DOMAIN = 'apps.cluster.example.com';
/** Internal image registry host used by `image-registry.openshift-image-registry`. */
export const IMAGE_REGISTRY = 'image-registry.openshift-image-registry.svc:5000';
/** Same host, used when synthesising build output image references. */
const ITEM_REGISTRY_FOR_BUILD = IMAGE_REGISTRY;
// `OCP_VERSION` / `OCP_CHANNEL` are re-exported from js/data/platformVersions.js
// (imported above) so the resource classes and the `oc` output share one source.

function seededUUID(seed) {
  let hash = 0;
  for (let i = 0; i < String(seed).length; i++) {
    hash = (hash * 31 + String(seed).charCodeAt(i)) | 0;
  }
  const hex = (value) => (value >>> 0).toString(16).padStart(8, '0');
  const a = hex(hash);
  const b = hex(hash ^ 0x9e3779b9).slice(0, 4);
  const c = hex(Math.imul(hash, 31) ^ 0x85ebca6b).slice(0, 4);
  const d = hex(Math.imul(hash, 131) ^ 0xc2b2ae35).slice(0, 4);
  const e = hex(Math.imul(hash, 7) ^ 0x27d4eb2f) + hex(hash);
  return `${a}-${b}-${c}-${d}-${e.slice(0, 12)}`;
}

// ─── Project ────────────────────────────────────────────────────────────────

export class Project extends ResourceBase {
  constructor(metadata = {}) {
    super('Project', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'project.openshift.io/v1',
    });
    this._initSpec(
      {
        displayName: metadata.displayName || '',
        description: metadata.description || '',
      },
      metadata.spec
    );
    // Real Kubernetes namespaces are automatically labelled with
    // kubernetes.io/metadata.name=<name> (NamespaceDefaultLabelName, GA since
    // k8s 1.22); an OpenShift Project is the OpenShift-facing view of that
    // namespace, so the label is present on the Project too. ClusterResourceQuota
    // project selectors rely on it:
    //   oc create clusterquota team-quota \
    //     --project-label-selector=kubernetes.io/metadata.name=quota-lab
    if (this.metadata.name && !this.metadata.labels['kubernetes.io/metadata.name']) {
      this.metadata.labels['kubernetes.io/metadata.name'] = this.metadata.name;
    }
    if (this.spec.displayName) {
      this.metadata.annotations['openshift.io/display-name'] = this.spec.displayName;
    }
    if (this.spec.description) {
      this.metadata.annotations['openshift.io/description'] = this.spec.description;
    }
    this._setInitialStatus({ phase: 'Active' });
  }

  get displayName() {
    return this.spec.displayName || this.metadata.annotations['openshift.io/display-name'] || '';
  }

  get description() {
    return this.spec.description || this.metadata.annotations['openshift.io/description'] || '';
  }

  isActive() {
    return this.status.phase === 'Active';
  }

  terminate() {
    this.setPhase('Terminating');
    this.addEvent('Normal', 'ProjectTerminating', `Project ${this.metadata.name} is terminating`);
    return this;
  }

  toDescribe() {
    return `Name:           ${this.metadata.name}
Display Name:   ${this.displayName || '<none>'}
Description:    ${this.description || '<none>'}
Status:         ${this.status.phase}
Labels:         ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:    ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Route ──────────────────────────────────────────────────────────────────

export class Route extends ResourceBase {
  constructor(metadata = {}) {
    super('Route', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'route.openshift.io/v1',
    });
    const name = metadata.name || 'unnamed';
    const serviceName = metadata.serviceName || metadata.to?.name || name;
    const defaults = {
      host: metadata.host || '',
      to: {
        kind: 'Service',
        name: serviceName,
        weight: metadata.weight ?? 100,
      },
      port: { targetPort: metadata.targetPort || metadata.portName || 'http' },
      wildcardPolicy: metadata.wildcardPolicy || 'None',
    };
    // Real oc expose routes omit spec.path/tls (omitempty) until configured.
    if (metadata.path !== undefined) defaults.path = metadata.path;
    if (metadata.tls !== undefined) defaults.tls = deepClone(metadata.tls);
    if (metadata.termination) {
      defaults.tls = {
        termination: metadata.termination,
        insecureEdgeTerminationPolicy: metadata.insecureEdgeTerminationPolicy || 'None',
        certificate: metadata.certificate || '',
        key: metadata.key || '',
        caCertificate: metadata.caCertificate || '',
      };
    }
    this._initSpec(defaults, metadata.spec);
    this.applyAdmissionDefaults();
    this._setInitialStatus({ phase: 'Active', ingress: [] });
  }

  get serviceName() {
    return this.spec.to?.name || '';
  }

  get termination() {
    return this.spec.tls?.termination || '';
  }

  hasTLS() {
    return Boolean(this.spec.tls && this.spec.tls.termination);
  }

  defaultHost() {
    return `${this.metadata.name}-${this.metadata.namespace}.${APPS_DOMAIN}`;
  }

  /**
   * Route admission plugin defaults (#75/#76): a Route created without
   * `spec.host` gets the generated `<name>-<namespace>.<apps-domain>` host
   * SYNCHRONOUSLY, exactly like a real cluster (`oc get route -o yaml` right
   * after `oc expose` already shows it). GameEngine.applyManifestObject() calls
   * this after installing an applied spec — that path replaces `.spec`
   * wholesale, which used to leave `host: ""` until a later router tick and made
   * `oc get route … -o jsonpath={.spec.host}` print nothing.
   * @returns {this}
   */
  applyAdmissionDefaults() {
    if (!this.spec.host) this.spec.host = this.defaultHost();
    return this;
  }

  effectiveHost() {
    return this.spec.host || this.defaultHost();
  }

  getCondition() {
    const ingress = this.status.ingress?.[0];
    return ingress?.conditions?.find((c) => c.type === 'Admitted') || null;
  }

  isAdmitted() {
    return this.getCondition()?.status === 'True';
  }

  setAdmitted(admitted, reason, message) {
    const host = this.effectiveHost();
    const condition = {
      type: 'Admitted',
      status: admitted ? 'True' : 'False',
      reason: reason || (admitted ? 'Accepted' : 'ServiceUnavailable'),
      message:
        message ||
        (admitted
          ? `Route admitted by the ingress router for host ${host}`
          : 'no endpoints available'),
      lastTransitionTime: timestamp(),
    };
    this.status.ingress = [
      {
        host,
        routerName: 'default',
        routerCanonicalHostname: `router-default.${APPS_DOMAIN}`,
        wildcardPolicy: this.spec.wildcardPolicy || 'None',
        conditions: [condition],
      },
    ];
    this.setPhase(admitted ? 'Admitted' : 'Rejected');
    return this;
  }

  setTLS(termination, options = {}) {
    if (!termination) {
      this.spec.tls = null;
      return this;
    }
    this.spec.tls = {
      termination,
      insecureEdgeTerminationPolicy: options.insecureEdgeTerminationPolicy || 'None',
      certificate: options.certificate || '',
      key: options.key || '',
      caCertificate: options.caCertificate || '',
    };
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.to || this.spec.to.kind !== 'Service' || !this.spec.to.name) {
      result.errors.push('spec.to must reference a Service by name');
    }
    if (this.spec.path && !String(this.spec.path).startsWith('/')) {
      result.errors.push('spec.path must start with "/"');
    }
    if (this.spec.tls) {
      const allowed = ['edge', 'passthrough', 'reencrypt'];
      if (!allowed.includes(this.spec.tls.termination)) {
        result.errors.push(`spec.tls.termination must be one of ${allowed.join(', ')}`);
      }
      if (this.spec.tls.termination === 'passthrough' && this.spec.path && this.spec.path !== '/') {
        result.errors.push(
          'passthrough routes cannot set spec.path (the router cannot read the TLS payload)'
        );
      }
      // certificate/key are optional: the ingress router falls back to its
      // default certificate when an edge/reencrypt route does not provide one.
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * Real `oc describe route` shape (OpenShift oc RouteDescriber): the requested
   * host (or `<auto>`), the router admission line with the real generated host,
   * the path from the spec (blank when unset), endpoint port and the
   * Service/Weight/Endpoints block (#36).
   * @param {{cluster?: any}} [opts]
   * @returns {string}
   */
  toDescribe(opts = {}) {
    const cluster = opts?.cluster || null;
    const tls = this.spec.tls || null;
    const labels =
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>';
    const annotations =
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>';
    const lines = [
      `Name:                   ${this.metadata.name}`,
      `Namespace:              ${this.metadata.namespace}`,
      `Labels:                 ${labels}`,
      `Annotations:            ${annotations}`,
      `Requested Host:         ${this.spec.host || '<auto>'}`,
    ];
    const ingressList = this.status.ingress || [];
    const admissionLine = (ingress, short) => {
      const condition = (ingress.conditions || []).find((entry) => entry.type === 'Admitted');
      if (!condition) return null;
      const hostSuffix = ingress.routerCanonicalHostname
        ? ` (host ${ingress.routerCanonicalHostname})`
        : '';
      const age = condition.lastTransitionTime
        ? ` ${relativeAge(condition.lastTransitionTime)} ago`
        : '';
      if (condition.status === 'True') {
        const prefix = short ? '  ' : `  ${ingress.host}`;
        return `${prefix} exposed on router ${ingress.routerName || 'default'}${hostSuffix}${age}`;
      }
      // OCP 4.x rejected routes render the condition reason followed by every
      // message line (e.g. ExternalCertificateValidationFailed, issue #39).
      const rejectedLines = [
        `  rejected by router ${ingress.routerName || 'default'}${hostSuffix}: ${
          condition.reason || ''
        } (${relativeAge(condition.lastTransitionTime)} ago)`,
      ];
      if (condition.message) rejectedLines.push(`    ${condition.message}`);
      return rejectedLines.join('\n');
    };
    // The ingress whose host equals the requested host is shown short-form
    // under "Requested Host"; every other ingress gets its full host line.
    if (this.spec.host) {
      for (const ingress of ingressList) {
        if (ingress.host !== this.spec.host) continue;
        const line = admissionLine(ingress, true);
        if (line) lines.push(line);
      }
    }
    for (const ingress of ingressList) {
      if (ingress.host === this.spec.host) continue;
      const line = admissionLine(ingress, false);
      if (line) lines.push(line);
    }
    lines.push(`Path:                   ${this.spec.path || ''}`);
    lines.push(`TLS Termination:        ${tls?.termination || ''}`);
    lines.push(
      `Insecure Policy:        ${tls?.termination ? tls.insecureEdgeTerminationPolicy || 'None' : ''}`
    );
    lines.push(
      `Endpoint Port:          ${
        this.spec.port?.targetPort !== undefined
          ? this.spec.port.targetPort
          : '<all endpoint ports>'
      }`
    );
    lines.push('', `Service:                ${this.spec.to?.name || ''}`);
    const weight = this.spec.to?.weight ?? 100;
    lines.push(`Weight:                 ${weight} (${weight}%)`);
    const endpoints = this._endpointAddresses(cluster);
    lines.push(`Endpoints:              ${endpoints.length ? endpoints.join(', ') : '<none>'}`);
    lines.push('Events:');
    for (const event of (this.events || []).slice(-10)) {
      lines.push(`  ${event.type}\t${event.reason}\t${event.message}`);
    }
    return lines.join('\n');
  }

  /**
   * Router endpoints for the backing Service (ready Pods IP:targetPort), the
   * way `oc describe route` lists them.
   * @param {any} cluster
   * @returns {string[]}
   */
  _endpointAddresses(cluster) {
    if (!cluster) return [];
    const serviceName = this.spec.to?.name;
    if (!serviceName) return [];
    const namespace = this.metadata.namespace;
    const service = cluster.getByName?.('Service', serviceName, namespace);
    const selector = service?.spec?.selector || {};
    if (!service || !Object.keys(selector).length) return [];
    const pods = (cluster.getByKind?.('Pod') || []).filter(
      (pod) =>
        pod.metadata?.namespace === namespace &&
        Object.entries(selector).every(
          ([key, value]) => (pod.metadata?.labels || {})[key] === value
        ) &&
        (pod.status?.phase || pod.phase) === 'Running'
    );
    const targetPort = this.spec.port?.targetPort;
    const ports = service.spec?.ports || [];
    const addresses = [];
    for (const port of ports) {
      const matchesRoute =
        targetPort === undefined ||
        String(port.name) === String(targetPort) ||
        String(port.targetPort) === String(targetPort) ||
        String(port.port) === String(targetPort);
      if (!matchesRoute) continue;
      for (const pod of pods) {
        const podIp = pod.status?.podIP || pod.ip;
        if (podIp) addresses.push(`${podIp}:${port.targetPort ?? port.port}`);
      }
    }
    return addresses.slice(0, 3);
  }
}

// ─── BuildConfig / Build / ImageStream ──────────────────────────────────────

export class BuildConfig extends ResourceBase {
  constructor(metadata = {}) {
    super('BuildConfig', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'build.openshift.io/v1',
    });
    const name = metadata.name || 'unnamed';
    const outputName = metadata.outputImage || metadata.outputTo || `${name}:latest`;
    const strategyType = metadata.strategyType || 'Source';
    // Real BuildConfig validation requires exactly one strategy object:
    // sourceStrategy for Source, dockerStrategy for Docker, customStrategy for Custom.
    const strategy = { type: strategyType };
    if (strategyType === 'Docker') {
      strategy.dockerStrategy = { dockerfilePath: metadata.dockerfilePath || 'Dockerfile' };
    } else if (strategyType === 'Custom') {
      strategy.customStrategy = {
        from: {
          kind: 'ImageStreamTag',
          name: metadata.builderImage || metadata.from || 'nodejs:20-ubi9',
          namespace: metadata.builderNamespace || 'openshift',
        },
      };
    } else {
      strategy.sourceStrategy = {
        from: {
          kind: 'ImageStreamTag',
          name: metadata.builderImage || metadata.from || 'nodejs:20-ubi9',
          namespace: metadata.builderNamespace || 'openshift',
        },
      };
    }
    const defaults = {
      source: {
        type: metadata.sourceType || 'Git',
        git: {
          uri: metadata.gitUri || metadata.git?.uri || '',
          ref: metadata.gitRef || metadata.git?.ref || '',
        },
        contextDir: metadata.contextDir || '',
      },
      strategy,
      output: { to: { kind: 'ImageStreamTag', name: outputName } },
      triggers: deepClone(
        metadata.triggers || [{ type: 'ConfigChange' }, { type: 'ImageChange', imageChange: {} }]
      ),
      runPolicy: metadata.runPolicy || 'Serial',
    };
    if (metadata.sourceSecret)
      defaults.source = { ...defaults.source, sourceSecret: deepClone(metadata.sourceSecret) };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({
      phase: 'Ready',
      lastVersion: 0,
      imageChangeTriggers: [],
      conditions: [],
    });
  }

  get outputImage() {
    return this.spec.output?.to?.name || '';
  }

  getSourceDescription() {
    const source = this.spec.source || {};
    if (source.type === 'Dockerfile') return 'Dockerfile';
    return source.git?.uri || source.type || '<none>';
  }

  getStrategyDescription() {
    const strategy = this.spec.strategy || {};
    if (strategy.type === 'Docker')
      return `docker ${strategy.dockerStrategy?.dockerfilePath || 'Dockerfile'}`;
    return strategy.sourceStrategy?.from?.name || strategy.type || '<none>';
  }

  /** Name of the next build this config would create. */
  nextBuildName() {
    const base = this.metadata.name;
    const match = base.match(/-(\d+)$/);
    const stem = match ? base.slice(0, -match[1].length - 1) : base;
    return `${stem}-${(this.status.lastVersion || 0) + 1}`;
  }

  bumpVersion() {
    this.status.lastVersion = (this.status.lastVersion || 0) + 1;
    this.metadata.generation++;
    this.addEvent('Normal', 'BuildStarted', `Build ${this.nextBuildName()} started`);
    return this.status.lastVersion;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.source || !this.spec.strategy || !this.spec.output) {
      result.errors.push('spec.source, spec.strategy and spec.output are required');
    }
    if (!this.spec.output?.to?.name) result.errors.push('spec.output.to.name is required');
    if (this.spec.strategy?.type === 'Source' && !this.spec.strategy.sourceStrategy?.from?.name) {
      result.errors.push('a Source strategy requires spec.strategy.sourceStrategy.from.name');
    }
    if (
      this.spec.strategy?.type === 'Docker' &&
      !this.spec.strategy.dockerStrategy?.dockerfilePath
    ) {
      result.errors.push('a Docker strategy requires spec.strategy.dockerStrategy.dockerfilePath');
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:           ${this.metadata.name}
Namespace:      ${this.metadata.namespace}
Labels:         ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:    ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Latest Version: ${this.status.lastVersion || 0}
Source:
  Type:         ${this.spec.source?.type}
  From:         ${this.getSourceDescription()}
Strategy:
  Type:         ${this.spec.strategy?.type}
  From:         ${this.getStrategyDescription()}
Output:
  To:           ${this.spec.output?.to?.kind}/${this.spec.output?.to?.name}
  Push Secret:  ${this.spec.output?.pushSecret?.name || '<none>'}
Triggers:
${(this.spec.triggers || []).map((t) => `  ${t.type}`).join('\n') || '  <none>'}
Run Policy:     ${this.spec.runPolicy}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class Build extends ResourceBase {
  constructor(metadata = {}) {
    super('Build', { ...metadata, apiVersion: metadata.apiVersion || 'build.openshift.io/v1' });
    const name = metadata.name || 'unnamed';
    const defaults = {
      source: deepClone(metadata.source || { type: 'Git', git: { uri: '', ref: '' } }),
      strategy: deepClone(
        metadata.strategy || {
          type: 'Source',
          sourceStrategy: {
            from: { kind: 'ImageStreamTag', name: 'nodejs:20-ubi9', namespace: 'openshift' },
          },
        }
      ),
      output: deepClone(
        metadata.output || { to: { kind: 'ImageStreamTag', name: `${name}:latest` } }
      ),
      serviceAccount: metadata.serviceAccount || 'builder',
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({
      phase: 'New',
      startTimestamp: null,
      completionTimestamp: null,
      duration: 0,
      message: '',
      reason: '',
      config: { kind: 'BuildConfig', name: metadata.buildConfigName || '' },
      output: {},
      conditions: [],
    });
  }

  get dockerImageReference() {
    return this.status.output?.to?.dockerImageReference || '';
  }

  markRunning() {
    this.status.startTimestamp = timestamp();
    this.status.duration = 0;
    this.setPhase('Running');
    this.addEvent('Normal', 'BuildStarted', 'Build started');
    return this;
  }

  markComplete(dockerImageReference) {
    this.status.completionTimestamp = timestamp();
    if (this.status.startTimestamp) {
      this.status.duration = Math.max(
        1,
        Math.round(
          (new Date(this.status.completionTimestamp).getTime() -
            new Date(this.status.startTimestamp).getTime()) /
            1000
        )
      );
    }
    this.status.output = { to: { dockerImageReference: dockerImageReference || '' } };
    this.setPhase('Complete');
    this.addEvent('Normal', 'BuildCompleted', 'Build completed successfully');
    return this;
  }

  markFailed(message = 'build failed') {
    this.status.completionTimestamp = timestamp();
    this.status.message = message;
    this.status.reason = 'GenericBuildFailed';
    this.setPhase('Failed');
    this.addEvent('Warning', 'BuildFailed', message);
    return this;
  }

  cancel() {
    this.setPhase('Cancelled');
    this.addEvent('Normal', 'BuildCancelled', 'Build was cancelled');
    return this;
  }

  isComplete() {
    return this.status.phase === 'Complete';
  }

  isFailed() {
    return this.status.phase === 'Failed' || this.status.phase === 'Cancelled';
  }

  describePhase() {
    return this.status.phase || 'New';
  }

  validate() {
    const result = super.validate();
    const phases = ['New', 'Pending', 'Running', 'Complete', 'Failed', 'Cancelled'];
    if (this.status.phase && !phases.includes(this.status.phase)) {
      result.errors.push(`status.phase must be one of ${phases.join(', ')}`);
    }
    if (!this.spec.output?.to?.name) result.errors.push('spec.output.to.name is required');
    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * Real `oc describe build`: real timestamps (the build controller keeps
   * `startTime`/`completionTime`, the resource class uses `startTimestamp`…),
   * BuildConfig name and the built image reference (#36).
   * @param {{cluster?: any}} [opts]
   * @returns {string}
   */
  toDescribe(opts = {}) {
    const cluster = opts?.cluster || null;
    const started = this.status.startTimestamp || this.status.startTime;
    const completed = this.status.completionTimestamp || this.status.completionTime;
    let durationSeconds = Number(this.status.duration) || 0;
    if (!durationSeconds && started && completed) {
      durationSeconds = Math.max(
        1,
        Math.round((new Date(completed).getTime() - new Date(started).getTime()) / 1000)
      );
    }
    const buildConfigName =
      this.metadata?.labels?.buildconfig ||
      this.metadata?.labels?.['buildconfig.openshift.io/name'] ||
      this.metadata?.annotations?.['openshift.io/build-config.name'] ||
      this.status.config?.name ||
      '';
    let image = this.dockerImageReference || '';
    if (!image && cluster) {
      const output = this.spec.output?.to || {};
      if (output.kind === 'ImageStreamTag' && output.name) {
        const [streamName, tag = 'latest'] = String(output.name).split(':');
        try {
          const resolved = cluster.resolveImageStreamTag?.(
            output.namespace || this.metadata.namespace,
            streamName,
            tag
          );
          const item = resolved?.tagEntry?.items?.[0];
          image = item?.image
            ? `${ITEM_REGISTRY_FOR_BUILD}/${output.namespace || this.metadata.namespace}/${streamName}@${item.image}`
            : '';
        } catch {
          image = '';
        }
      }
    }
    return `Name:           ${this.metadata.name}
Namespace:      ${this.metadata.namespace}
Created:        ${started || this.metadata.creationTimestamp}
Labels:         ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:    ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Started:        ${started || '<pending>'}
Completed:      ${completed || '<pending>'}
Duration:       ${durationSeconds}s
Status:         ${this.status.phase}
Message:        ${this.status.message || '<none>'}
Build Config:   ${buildConfigName ? `BuildConfig/${buildConfigName}` : '<none>'}
Output To:      ${this.spec.output?.to?.kind || ''}/${this.spec.output?.to?.name || ''}
Image:          ${image || '<none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class ImageStream extends ResourceBase {
  constructor(metadata = {}) {
    super('ImageStream', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'image.openshift.io/v1',
    });
    const defaults = {
      lookupPolicy: { local: metadata.lookupPolicy?.local ?? metadata.localLookup ?? false },
      tags: deepClone(metadata.tags || []),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({
      phase: 'Active',
      dockerImageRepository: this.getImageRepository(),
      tags: [],
    });
  }

  getImageRepository() {
    return `${IMAGE_REGISTRY}/${this.metadata.namespace}/${this.metadata.name}`;
  }

  getTag(tagName) {
    return (this.status.tags || []).find((t) => t.tag === tagName) || null;
  }

  getTagItems(tagName) {
    return this.getTag(tagName)?.items || [];
  }

  getDockerImageReference(tagName = 'latest') {
    return this.getTagItems(tagName)[0]?.dockerImageReference || '';
  }

  /** Record a tag pointing at an external image (oc import-image / oc tag). */
  addTag(tagName, dockerImageReference, options = {}) {
    const tag = {
      tag: tagName,
      items: [
        {
          created: timestamp(),
          dockerImageReference,
          image: options.image || '',
          generation: (this.metadata.generation || 1) + 1,
        },
      ],
      conditions: [
        {
          type: 'ImportSuccess',
          status: 'True',
          reason: 'Imported',
          message: 'Tag has been imported',
          lastTransitionTime: timestamp(),
        },
      ],
    };
    this.status.tags = (this.status.tags || []).filter((t) => t.tag !== tagName);
    this.status.tags.push(tag);
    this.spec.tags = (this.spec.tags || []).filter((t) => t.name !== tagName);
    this.spec.tags.push({
      name: tagName,
      from: { kind: 'DockerImage', name: dockerImageReference },
    });
    this.metadata.generation++;
    this.addEvent('Normal', 'ImportSuccess', `Tag ${tagName} imported`);
    return tag;
  }

  removeTag(tagName) {
    this.status.tags = (this.status.tags || []).filter((t) => t.tag !== tagName);
    this.spec.tags = (this.spec.tags || []).filter((t) => t.name !== tagName);
    this.metadata.generation++;
    return this;
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.tags || [])) result.errors.push('spec.tags must be an array');
    const seen = new Set();
    for (const tag of this.spec.tags || []) {
      if (!tag.name) result.errors.push('every spec.tags[] entry requires a name');
      else if (seen.has(tag.name)) result.errors.push(`duplicate image stream tag "${tag.name}"`);
      seen.add(tag.name);
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:               ${this.metadata.name}
Namespace:          ${this.metadata.namespace}
Labels:             ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:        ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Image Repository:   ${this.getImageRepository()}
Image Lookup:       ${this.spec.lookupPolicy?.local ? 'Local' : 'Source'}
Tags:
${
  (this.status.tags || [])
    .map(
      (tag) => `  ${tag.tag}
    Image:  ${tag.items?.[0]?.dockerImageReference || '<none>'}
    ${(tag.conditions || []).map((c) => `${c.type} ${c.status}`).join(', ')}`
    )
    .join('\n') || '  <none>'
}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Template ───────────────────────────────────────────────────────────────

export class Template extends ResourceBase {
  constructor(metadata = {}) {
    super('Template', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'template.openshift.io/v1',
    });
    this._initSpec(
      {
        parameters: deepClone(
          metadata.parameters || [
            {
              name: 'APP_NAME',
              displayName: 'Application name',
              description: 'Name used for the deployed application',
              required: true,
              value: 'webapp',
            },
          ]
        ),
        objects: deepClone(
          metadata.objects || [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: '${APP_NAME}' },
              spec: {
                replicas: 2,
                selector: { matchLabels: { app: '${APP_NAME}' } },
                template: {
                  metadata: { labels: { app: '${APP_NAME}' } },
                  spec: {
                    containers: [
                      {
                        name: 'main',
                        image: 'quay.io/openshift/origin-hello-openshift:latest',
                        ports: [{ containerPort: 8080 }],
                      },
                    ],
                  },
                },
              },
            },
            {
              apiVersion: 'v1',
              kind: 'Service',
              metadata: { name: '${APP_NAME}' },
              spec: { selector: { app: '${APP_NAME}' }, ports: [{ port: 8080, targetPort: 8080 }] },
            },
          ]
        ),
        message: metadata.message || 'Application ${APP_NAME} deployed.',
      },
      metadata.spec
    );
    this._setInitialStatus({ phase: 'Active' });
  }

  getParameter(name) {
    return (this.spec.parameters || []).find((p) => p.name === name) || null;
  }

  getParameters() {
    return this.spec.parameters || [];
  }

  getObjects() {
    return this.spec.objects || [];
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.objects)) result.errors.push('spec.objects must be an array');
    const names = new Set();
    for (const parameter of this.spec.parameters || []) {
      if (!parameter.name) result.errors.push('every spec.parameters[] entry requires a name');
      else if (names.has(parameter.name))
        result.errors.push(`duplicate template parameter "${parameter.name}"`);
      names.add(parameter.name);
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Labels:       ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:  ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Description:  ${this.metadata.annotations.description || '<none>'}
Parameters:
${
  (this.spec.parameters || [])
    .map(
      (p) =>
        `  Name:        ${p.name}\n  Display Name:${p.displayName || ''}\n  Description: ${p.description || ''}\n  Required:    ${p.required === true}\n  Value:       ${p.value ?? p.generate ?? ''}`
    )
    .join('\n') || '  <none>'
}
Objects:
${(this.spec.objects || []).map((o) => `  ${o.kind}/${o.metadata?.name || ''}`).join('\n') || '  <none>'}
Message:      ${this.spec.message || '<none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Operator Lifecycle Manager (Subscription) ──────────────────────────────

export class Subscription extends ResourceBase {
  constructor(metadata = {}) {
    super('Subscription', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'operators.coreos.com/v1alpha1',
    });
    // `spec.name` IS the package (operators.coreos.com/v1alpha1 has no
    // `spec.packageName`). The default only applies when nothing names one; a
    // spec merged in later (`addResource`) keeps its own `name` and no stale
    // default package can survive next to it (1.16.0: a seeded `name:
    // metallb-operator` resolved ansible-automation-platform-operator).
    const pkg =
      metadata.packageName ||
      metadata.package ||
      metadata.operatorName ||
      metadata.spec?.name ||
      metadata.subscriptionName ||
      'ansible-automation-platform-operator';
    const defaults = {
      name: pkg,
      channel: metadata.channel || 'stable',
      source: metadata.source || 'redhat-operators',
      sourceNamespace: metadata.sourceNamespace || 'openshift-marketplace',
      installPlanApproval: metadata.installPlanApproval || 'Automatic',
    };
    if (metadata.startingCSV) defaults.startingCSV = metadata.startingCSV;
    if (metadata.config) defaults.config = deepClone(metadata.config);
    this._initSpec(defaults, metadata.spec);
    // A freshly created Subscription has not been resolved by OLM yet: it must
    // NOT claim `InstallPlanPending True RequiresApproval` before an InstallPlan
    // even exists (issue #18). The controller adds the real conditions
    // (ResolutionFailed / InstallPlanPending / InstallPlanComplete) as it
    // progresses, exactly like a real cluster.
    this._setInitialStatus({
      phase: 'Installing',
      currentCSV: '',
      installedCSV: '',
      installPlanRef: null,
      state: 'UpgradePending',
      conditions: [],
    });
  }

  get operatorName() {
    return this.spec.name || this.spec.packageName || this.metadata.name;
  }

  get installedCSV() {
    return this.status.installedCSV || '';
  }

  get installed() {
    return this.status.phase === 'Succeeded' && Boolean(this.status.installedCSV);
  }

  markInstalled(csvName) {
    const csv = csvName || `${this.operatorName}.v1.0.0`;
    this.status.currentCSV = csv;
    this.status.installedCSV = csv;
    this.status.state = 'AtLatestKnown';
    this.status.conditions = [
      {
        type: 'CatalogSourcesUnhealthy',
        status: 'False',
        reason: 'AllCatalogSourcesHealthy',
        message: '',
        lastTransitionTime: timestamp(),
      },
    ];
    this.setPhase('Succeeded');
    this.addEvent('Normal', 'Installed', `Operator ${csv} installed successfully`);
    return this;
  }

  markFailed(message = 'operator installation failed', reason = 'InstallFailed') {
    this.status.conditions = [
      {
        type: 'InstallPlanFailed',
        status: 'True',
        reason,
        message,
        lastTransitionTime: timestamp(),
      },
    ];
    this.setPhase('Failed');
    this.addEvent('Warning', reason, message);
    return this;
  }

  supportsNamespace(namespace) {
    return !namespace || namespace === this.metadata.namespace;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.name && !this.spec.packageName)
      result.errors.push('spec.name (operator package) is required');
    if (!this.spec.channel) result.errors.push('spec.channel is required');
    if (!this.spec.source) result.errors.push('spec.source is required');
    if (!this.spec.sourceNamespace) result.errors.push('spec.sourceNamespace is required');
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:                 ${this.metadata.name}
Namespace:            ${this.metadata.namespace}
Labels:               ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:          ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Channel:              ${this.spec.channel}
InstallPlan Approval:  ${this.spec.installPlanApproval || 'Automatic'}
Source:               ${this.spec.source}
Source Namespace:     ${this.spec.sourceNamespace}
Package:              ${this.spec.name || this.spec.packageName}
Current CSV:          ${this.status.currentCSV || '<none>'}
Installed CSV:        ${this.status.installedCSV || '<none>'}
State:                ${this.status.state || '<none>'}
Status:               ${this.status.phase}
Conditions:
${(this.status.conditions || []).map((c) => `  ${c.type.padEnd(24)} ${c.status.padEnd(6)} ${c.reason || ''} ${c.message || ''}`).join('\n') || '  <none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── SecurityContextConstraints ─────────────────────────────────────────────

export class SecurityContextConstraints extends ResourceBase {
  constructor(metadata = {}) {
    super('SecurityContextConstraints', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'security.openshift.io/v1',
    });
    const defaults = {
      priority: metadata.priority ?? null,
      allowPrivilegedContainer: metadata.allowPrivilegedContainer ?? false,
      allowHostDirVolumePlugin: metadata.allowHostDirVolumePlugin ?? false,
      allowHostNetwork: metadata.allowHostNetwork ?? false,
      allowHostPorts: metadata.allowHostPorts ?? false,
      allowHostPID: metadata.allowHostPID ?? false,
      allowHostIPC: metadata.allowHostIPC ?? false,
      allowPrivilegeEscalation: metadata.allowPrivilegeEscalation ?? false,
      readOnlyRootFilesystem: metadata.readOnlyRootFilesystem ?? false,
      defaultAddCapabilities: deepClone(metadata.defaultAddCapabilities || null),
      allowedCapabilities: deepClone(metadata.allowedCapabilities || ['NET_BIND_SERVICE']),
      requiredDropCapabilities: deepClone(metadata.requiredDropCapabilities || ['ALL']),
      runAsUser: deepClone(metadata.runAsUser || { type: 'MustRunAsRange' }),
      seLinuxContext: deepClone(metadata.seLinuxContext || { type: 'MustRunAs' }),
      fsGroup: deepClone(metadata.fsGroup || { type: 'MustRunAs' }),
      supplementalGroups: deepClone(metadata.supplementalGroups || { type: 'MustRunAs' }),
      seccompProfiles: deepClone(metadata.seccompProfiles || ['runtime/default']),
      volumes: deepClone(
        metadata.volumes || [
          'configMap',
          'csi',
          'downwardAPI',
          'emptyDir',
          'ephemeral',
          'image',
          'persistentVolumeClaim',
          'projected',
          'secret',
        ]
      ),
      users: deepClone(metadata.users || []),
      groups: deepClone(metadata.groups || []),
    };
    // Optional fields are only emitted when the caller supplies them.
    if (metadata.allowedUnsafeSysctls)
      defaults.allowedUnsafeSysctls = deepClone(metadata.allowedUnsafeSysctls);
    if (metadata.userNamespaceLevel) defaults.userNamespaceLevel = metadata.userNamespaceLevel;
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get users() {
    return this.spec.users || [];
  }

  get groups() {
    return this.spec.groups || [];
  }

  allows(user) {
    return this.spec.users?.includes(user) || this.spec.groups?.includes(user);
  }

  addUser(user) {
    this.spec.users = this.spec.users || [];
    if (!this.spec.users.includes(user)) {
      this.spec.users.push(user);
      this.metadata.generation++;
      this.addEvent('Normal', 'Updated', `User ${user} added to SCC`);
    }
    return this;
  }

  removeUser(user) {
    this.spec.users = (this.spec.users || []).filter((u) => u !== user);
    this.metadata.generation++;
    return this;
  }

  addGroup(group) {
    this.spec.groups = this.spec.groups || [];
    if (!this.spec.groups.includes(group)) {
      this.spec.groups.push(group);
      this.metadata.generation++;
      this.addEvent('Normal', 'Updated', `Group ${group} added to SCC`);
    }
    return this;
  }

  removeGroup(group) {
    this.spec.groups = (this.spec.groups || []).filter((g) => g !== group);
    this.metadata.generation++;
    return this;
  }

  isPrivileged() {
    return this.spec.allowPrivilegedContainer === true;
  }

  allowsRunAsUser() {
    return this.spec.runAsUser?.type === 'RunAsAny';
  }

  validate() {
    const result = super.validate();
    // priority is nullable in the real API (unset for all default SCCs).
    if (
      this.spec.priority !== null &&
      this.spec.priority !== undefined &&
      typeof this.spec.priority !== 'number'
    ) {
      result.errors.push('priority must be a number or null');
    }
    const strategies = ['MustRunAs', 'MustRunAsNonRoot', 'MustRunAsRange', 'RunAsAny'];
    for (const field of ['runAsUser', 'seLinuxContext', 'fsGroup', 'supplementalGroups']) {
      const strategy = this.spec[field]?.type;
      if (!strategy) result.errors.push(`spec.${field}.type is required`);
      else if (!strategies.includes(strategy)) {
        result.errors.push(`${field}.type must be one of ${strategies.join(', ')}`);
      }
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:                        ${this.metadata.name}
Priority:                    ${this.spec.priority}
Access:
  Users:                     ${(this.spec.users || []).join(', ') || '<none>'}
  Groups:                    ${(this.spec.groups || []).join(', ') || '<none>'}
Settings:
  Allow Privileged:          ${this.spec.allowPrivilegedContainer}
  Allow Host Dir Volume Plugin: ${this.spec.allowHostDirVolumePlugin}
  Allow Host Network:        ${this.spec.allowHostNetwork}
  Allow Host Ports:          ${this.spec.allowHostPorts}
  Allow Host PID:            ${this.spec.allowHostPID}
  Allow Host IPC:            ${this.spec.allowHostIPC}
  Read Only Root Filesystem: ${this.spec.readOnlyRootFilesystem}
  RunAsUser Strategy:        ${this.spec.runAsUser?.type}
  SELinux Context Strategy:  ${this.spec.seLinuxContext?.type}
  FSGroup Strategy:          ${this.spec.fsGroup?.type}
  SupplementalGroups Strategy: ${this.spec.supplementalGroups?.type}
Volumes:                     ${(this.spec.volumes || []).join(', ') || '<all>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── ClusterResourceQuota / LimitRange ──────────────────────────────────────

export class ClusterResourceQuota extends ResourceBase {
  constructor(metadata = {}) {
    super('ClusterResourceQuota', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'quota.openshift.io/v1',
    });
    // No invented hard limits: spec.quota.hard is exactly what the caller
    // passed (issue #14 — ghosts like requests.cpu: 10 / requests.memory: 20Gi
    // were being merged into every ClusterResourceQuota).
    const hard = deepClone(metadata.hard || metadata.spec?.quota?.hard || {});
    const defaults = {
      selector: {
        labels: {
          matchLabels: deepClone(
            metadata.selector?.labels?.matchLabels || metadata.matchLabels || {}
          ),
        },
      },
      quota: { hard },
    };
    if (metadata.selector?.annotations) {
      defaults.selector.annotations = deepClone(metadata.selector.annotations);
    }
    this._initSpec(defaults, metadata.spec);
    const used = {};
    for (const key of Object.keys(this.spec.quota?.hard || {})) used[key] = '0';
    this._setInitialStatus({
      phase: 'Active',
      total: { hard: deepClone(this.spec.quota?.hard || {}), used },
      namespaces: [],
      conditions: [],
    });
  }

  get hard() {
    return this.spec.quota?.hard || {};
  }

  matchesNamespace(namespaceResource) {
    const selector = this.spec.selector || {};
    if (selector.labels?.matchLabels && Object.keys(selector.labels.matchLabels).length > 0) {
      for (const [key, value] of Object.entries(selector.labels.matchLabels)) {
        if (namespaceResource?.metadata?.labels?.[key] !== value) return false;
      }
    }
    if (selector.annotations) {
      for (const [key, value] of Object.entries(selector.annotations)) {
        if (namespaceResource?.metadata?.annotations?.[key] !== value) return false;
      }
    }
    return true;
  }

  updateUsage(namespaces, resources) {
    const used = {};
    for (const key of Object.keys(this.hard)) used[key] = '0';
    const matching = (namespaces || []).filter((ns) => this.matchesNamespace(ns));
    this.status.namespaces = matching.map((ns) => ns.metadata.name);
    const names = new Set(this.status.namespaces);
    const scoped = (resources || []).filter((resource) => names.has(resource.metadata?.namespace));
    const podCount = scoped.filter((resource) => resource.kind === 'Pod').length;
    if ('pods' in used) used.pods = String(podCount);
    if ('secrets' in used) used.secrets = String(scoped.filter((r) => r.kind === 'Secret').length);
    let cpu = 0;
    let memory = 0;
    for (const pod of scoped.filter((resource) => resource.kind === 'Pod')) {
      for (const container of pod.spec?.containers || []) {
        cpu += parseFloat(container.resources?.requests?.cpu || '0') || 0;
        memory += parseFloat(container.resources?.requests?.memory || '0') || 0;
      }
    }
    if ('requests.cpu' in used) used['requests.cpu'] = String(cpu);
    if ('requests.memory' in used) used['requests.memory'] = `${memory}Gi`;
    this.status.total = { hard: deepClone(this.hard), used };
    return this.status.total;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.quota?.hard || Object.keys(this.spec.quota.hard).length === 0) {
      result.errors.push('spec.quota.hard must define at least one resource limit');
    }
    if (!this.spec.selector) result.errors.push('spec.selector is required');
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Created:      ${this.metadata.creationTimestamp}
Labels:       ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations:  ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Selector:
  Labels:      ${
    Object.entries(this.spec.selector?.labels?.matchLabels || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || '<none>'
  }
  Annotations: ${
    Object.entries(this.spec.selector?.annotations || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || '<none>'
  }
Status:
  Namespaces:  ${(this.status.namespaces || []).join(', ') || '<none>'}
Resource      Used    Hard
--------      ----    ----
${Object.keys(this.hard)
  .map(
    (k) =>
      `${k.padEnd(14)} ${String(this.status.total?.used?.[k] ?? '0').padEnd(7)} ${this.hard[k]}`
  )
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class LimitRange extends ResourceBase {
  constructor(metadata = {}) {
    super('LimitRange', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const defaults = {
      limits: deepClone(
        metadata.limits || [
          {
            type: 'Container',
            default: { cpu: '500m', memory: '512Mi' },
            defaultRequest: { cpu: '100m' },
            min: { cpu: '50m', memory: '64Mi' },
            max: { cpu: '2', memory: '4Gi' },
          },
        ]
      ),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  getLimits() {
    return this.spec.limits || [];
  }

  getContainerLimit() {
    return (this.spec.limits || []).find((entry) => entry.type === 'Container') || null;
  }

  getPodLimit() {
    return (this.spec.limits || []).find((entry) => entry.type === 'Pod') || null;
  }

  /** Return {requests, limits} defaults that would be injected into a container. */
  getContainerDefaults() {
    const containerLimit = this.getContainerLimit();
    return {
      requests: deepClone(containerLimit?.defaultRequest || {}),
      limits: deepClone(containerLimit?.default || {}),
    };
  }

  /** Validate a pod against this LimitRange; returns {valid, errors}. */
  validatePod(pod) {
    const errors = [];
    const containerLimit = this.getContainerLimit();
    if (!containerLimit) return { valid: true, errors };
    for (const container of pod.spec?.containers || []) {
      const resources = container.resources || {};
      const parseCpu = (v) =>
        String(v).endsWith('m') ? parseFloat(v) : (parseFloat(v) || 0) * 1000;
      if (
        containerLimit.min?.cpu &&
        parseCpu(resources.requests?.cpu) < parseCpu(containerLimit.min.cpu)
      ) {
        errors.push(
          `container ${container.name} cpu request is below the minimum of ${containerLimit.min.cpu}`
        );
      }
      if (
        containerLimit.max?.cpu &&
        parseCpu(resources.limits?.cpu) > parseCpu(containerLimit.max.cpu)
      ) {
        errors.push(
          `container ${container.name} cpu limit is above the maximum of ${containerLimit.max.cpu}`
        );
      }
      if (containerLimit.min?.memory && String(resources.requests?.memory || '') === '') {
        errors.push(`container ${container.name} is missing a memory request`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  validate() {
    const result = super.validate();
    const types = [
      'Container',
      'Pod',
      'PersistentVolumeClaim',
      'openshift.io/Image',
      'openshift.io/ImageStream',
    ];
    if (!Array.isArray(this.spec.limits) || this.spec.limits.length === 0) {
      result.errors.push('spec.limits must contain at least one LimitRangeItem');
    }
    for (const entry of this.spec.limits || []) {
      if (!entry.type) result.errors.push('every spec.limits[] entry requires a type');
      else if (!types.includes(entry.type))
        result.errors.push(`unsupported LimitRange type "${entry.type}"`);
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:        ${this.metadata.name}
Namespace:   ${this.metadata.namespace}
Labels:      ${
      Object.entries(this.metadata.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Annotations: ${
      Object.entries(this.metadata.annotations)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '<none>'
    }
Type       Resource  Min  Max  Default Request  Default Limit  Max Limit/Request Ratio
----       --------  ---  ---  ---------------  -------------  -----------------------
${(this.spec.limits || [])
  .map(
    (entry) =>
      `${String(entry.type).padEnd(10)} cpu       ${entry.min?.cpu || '-'}  ${entry.max?.cpu || '-'}  ${entry.defaultRequest?.cpu || '-'}            ${entry.default?.cpu || '-'}            ${entry.maxLimitRequestRatio?.cpu || '-'}`
  )
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── Cluster config singletons ──────────────────────────────────────────────

export class OAuth extends ResourceBase {
  constructor(metadata = {}) {
    super('OAuth', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'config.openshift.io/v1',
    });
    const defaults = {
      identityProviders: deepClone(
        metadata.identityProviders || [
          {
            name: 'htpasswd',
            mappingMethod: 'claim',
            type: 'HTPasswd',
            htpasswd: { fileData: { name: 'htpasswd-secret' } },
          },
        ]
      ),
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active', conditions: [] });
  }

  getProviders() {
    return this.spec.identityProviders || [];
  }

  getProvider(type) {
    return this.getProviders().find((provider) => provider.type === type) || null;
  }

  getHTPasswdProvider() {
    return this.getProvider('HTPasswd');
  }

  setIdentityProviders(providers) {
    this.spec.identityProviders = deepClone(providers);
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  addIdentityProvider(provider) {
    this.spec.identityProviders = [...this.getProviders(), deepClone(provider)];
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'ProviderAdded', `Identity provider ${provider.name} added`);
    return this;
  }

  removeIdentityProvider(name) {
    this.spec.identityProviders = this.getProviders().filter((provider) => provider.name !== name);
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  validate() {
    const result = super.validate();
    const types = [
      'HTPasswd',
      'LDAP',
      'OIDC',
      'GitHub',
      'GitLab',
      'Google',
      'RequestHeader',
      'BasicAuth',
    ];
    const names = new Set();
    for (const provider of this.spec.identityProviders || []) {
      if (!provider.name) result.errors.push('every identity provider requires a name');
      else if (names.has(provider.name))
        result.errors.push(`duplicate identity provider "${provider.name}"`);
      else if (!provider.type)
        result.errors.push(`identity provider "${provider.name}" requires a type`);
      else if (!types.includes(provider.type))
        result.errors.push(`unsupported identity provider type "${provider.type}"`);
      names.add(provider.name);
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * `oc describe oauth cluster` — OAuth is a CRD, so real oc uses kubectl's
   * generic describer: Name/Namespace/Labels/Annotations, then every field in
   * sorted order with Title-Case labels (`Identity Providers`, `Mapping
   * Method`, `File Data`) and tabwriter alignment per block of lines (1.16.0:
   * the hand-written block printed `Mapping Method:claim`).
   */
  toDescribe() {
    const rows = [];
    const push = (level, label, value) =>
      rows.push(
        value === undefined
          ? `${'  '.repeat(level)}${label}:`
          : `${'  '.repeat(level)}${label}:\t${value}`
      );
    const annotations = Object.entries(this.metadata.annotations || {});
    const labels = Object.entries(this.metadata.labels || {});
    push(0, 'Name', this.metadata.name);
    push(0, 'Namespace', '');
    if (labels.length) {
      push(0, 'Labels', `${labels[0][0]}=${labels[0][1]}`);
      for (const [key, value] of labels.slice(1)) rows.push(`\t${key}=${value}`);
    } else push(0, 'Labels', '<none>');
    if (annotations.length) {
      push(0, 'Annotations', `${annotations[0][0]}: ${annotations[0][1]}`);
      for (const [key, value] of annotations.slice(1)) rows.push(`\t${key}: ${value}`);
    } else push(0, 'Annotations', '<none>');
    push(0, 'API Version', this.apiVersion);
    push(0, 'Kind', 'OAuth');
    push(0, 'Metadata');
    push(1, 'Creation Timestamp', this.metadata.creationTimestamp);
    push(1, 'Generation', this.metadata.generation ?? 1);
    push(1, 'Resource Version', this.metadata.resourceVersion ?? '1');
    push(1, 'UID', this.metadata.uid);
    const smartLabel = (field) =>
      String(field)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^./, (char) => char.toUpperCase())
        .replace(/\b(Api|Uid|Url|Id|Ca)\b/g, (word) => word.toUpperCase());
    const walk = (level, value) => {
      for (const field of Object.keys(value || {}).sort()) {
        const entry = value[field];
        if (entry === undefined) continue;
        if (Array.isArray(entry)) {
          push(level, smartLabel(field));
          for (const item of entry) {
            if (item && typeof item === 'object') walk(level + 1, item);
            else rows.push(`${'  '.repeat(level + 1)}${item}`);
          }
        } else if (entry && typeof entry === 'object') {
          push(level, smartLabel(field));
          walk(level + 1, entry);
        } else push(level, smartLabel(field), entry);
      }
    };
    if (this.spec && Object.keys(this.spec).length) {
      push(0, 'Spec');
      walk(1, this.spec);
    }
    const events = this.events.slice(-10);
    if (events.length) {
      push(0, 'Events');
      rows.push('  Type\tReason\tMessage', '  ----\t------\t-------');
      for (const event of events) rows.push(`  ${event.type}\t${event.reason}\t${event.message}`);
    } else push(0, 'Events', '<none>');
    // text/tabwriter (minwidth 0, padding 2): adjacent lines that contain tabs
    // form one block; every cell of a column is padded to the widest one.
    const out = [];
    for (let index = 0; index < rows.length;) {
      if (!rows[index].includes('\t')) {
        out.push(rows[index]);
        index += 1;
        continue;
      }
      let end = index;
      while (end < rows.length && rows[end].includes('\t')) end += 1;
      const block = rows.slice(index, end).map((line) => line.split('\t'));
      const widths = [];
      for (const cells of block)
        cells.slice(0, -1).forEach((cell, column) => {
          widths[column] = Math.max(widths[column] || 0, cell.length + 2);
        });
      for (const cells of block)
        out.push(
          cells
            .map((cell, column) => (column < cells.length - 1 ? cell.padEnd(widths[column]) : cell))
            .join('')
            .trimEnd()
        );
      index = end;
    }
    return out.join('\n');
  }
}

export class ClusterOperator extends ResourceBase {
  constructor(metadata = {}) {
    super('ClusterOperator', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'config.openshift.io/v1',
    });
    const version = metadata.version || OCP_VERSION;
    const now = timestamp();
    const makeCondition = (type, status, reason, message = '') => ({
      type,
      status,
      reason,
      message,
      lastTransitionTime: now,
      lastHeartbeatTime: now,
    });
    const available = metadata.available !== false;
    const degrading = metadata.degraded === true;
    this._initSpec({}, metadata.spec);
    this._setInitialStatus({
      phase: 'Active',
      versions: [{ name: metadata.versionName || 'operator', version }],
      conditions: [
        makeCondition(
          'Available',
          available ? 'True' : 'False',
          available ? 'AsExpected' : 'Unavailable',
          available ? '' : 'Cluster operator is unavailable'
        ),
        makeCondition(
          'Progressing',
          metadata.progressing ? 'True' : 'False',
          metadata.progressing ? 'Progressing' : 'AsExpected'
        ),
        makeCondition(
          'Degraded',
          degrading ? 'True' : 'False',
          degrading ? 'Degraded' : 'AsExpected'
        ),
        makeCondition('Upgradeable', 'True', 'Upgradeable'),
      ],
      relatedObjects: deepClone(metadata.relatedObjects || []),
    });
  }

  isAvailable() {
    return this.isConditionTrue('Available');
  }

  isProgressing() {
    return this.isConditionTrue('Progressing');
  }

  isDegraded() {
    return this.isConditionTrue('Degraded');
  }

  getVersion() {
    return this.status.versions?.[0]?.version || OCP_VERSION;
  }

  setAvailable(available, reason, message) {
    this.setCondition(
      'Available',
      available ? 'True' : 'False',
      reason || (available ? 'AsExpected' : 'Unavailable'),
      message || ''
    );
    return this;
  }

  setProgressing(progressing, reason, message) {
    this.setCondition(
      'Progressing',
      progressing ? 'True' : 'False',
      reason || (progressing ? 'Progressing' : 'AsExpected'),
      message || ''
    );
    return this;
  }

  setDegraded(degraded, reason, message) {
    this.setCondition(
      'Degraded',
      degraded ? 'True' : 'False',
      reason || (degraded ? 'Degraded' : 'AsExpected'),
      message || ''
    );
    return this;
  }

  toDescribe() {
    return `Name:           ${this.metadata.name}
Version:        ${this.getVersion()}
Available:      ${this.isAvailable() ? 'True' : 'False'}
Progressing:    ${this.isProgressing() ? 'True' : 'False'}
Degraded:       ${this.isDegraded() ? 'True' : 'False'}
Conditions:
${(this.status.conditions || []).map((c) => `  ${c.type.padEnd(14)} ${c.status.padEnd(6)} ${c.reason || ''} ${c.message || ''}`).join('\n')}
Related Objects:
${(this.status.relatedObjects || []).map((o) => `  ${o.kind}/${o.name || ''}${o.namespace ? ` -n ${o.namespace}` : ''}`).join('\n') || '  <none>'}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class ClusterVersion extends ResourceBase {
  constructor(metadata = {}) {
    super('ClusterVersion', {
      ...metadata,
      namespace: '',
      apiVersion: metadata.apiVersion || 'config.openshift.io/v1',
    });
    const version = metadata.version || OCP_VERSION;
    const channel = metadata.channel || OCP_CHANNEL;
    this._initSpec(
      {
        clusterID: metadata.clusterID || seededUUID('openshift-games-cluster'),
        channel,
      },
      metadata.spec
    );
    const now = timestamp();
    this._setInitialStatus({
      phase: 'Active',
      desired: { version, channel },
      versionHash: '',
      observedGeneration: 1,
      history: [
        {
          state: 'Completed',
          verified: true,
          version,
          image: '',
          startedTime: now,
          completionTime: now,
        },
      ],
      conditions: [
        {
          type: 'Available',
          status: 'True',
          reason: 'ClusterVersionAvailable',
          message: `Done applying ${version}`,
          lastTransitionTime: now,
        },
        {
          type: 'Failing',
          status: 'False',
          reason: 'AsExpected',
          message: 'No errors',
          lastTransitionTime: now,
        },
        {
          type: 'Progressing',
          status: 'False',
          reason: 'ClusterVersionNotProgressing',
          message: `Cluster version is ${version}`,
          lastTransitionTime: now,
        },
        {
          type: 'RetrievedUpdates',
          status: 'True',
          reason: 'RecommendedUpdatesAvailable',
          message: 'Updates are available',
          lastTransitionTime: now,
        },
      ],
    });
  }

  get version() {
    return this.status.desired?.version || OCP_VERSION;
  }

  get channel() {
    return this.spec.channel || this.status.desired?.channel || OCP_CHANNEL;
  }

  isAvailable() {
    return this.isConditionTrue('Available');
  }

  updateTo(version, channel = this.channel) {
    const now = timestamp();
    this.spec.channel = channel;
    this.status.desired = { version, channel };
    this.status.history = [
      ...(this.status.history || []),
      { state: 'Completed', verified: true, version, startedTime: now, completionTime: now },
    ];
    this.status.conditions = (this.status.conditions || []).map((condition) =>
      condition.type === 'Progressing'
        ? {
            ...condition,
            status: 'False',
            reason: 'ClusterVersionNotProgressing',
            message: `Cluster version is ${version}`,
          }
        : condition
    );
    this.addEvent('Normal', 'UpdateComplete', `Cluster updated to ${version}`);
    return this;
  }

  validate() {
    const result = super.validate();
    if (!this.spec.channel && !this.status.desired?.channel) {
      result.errors.push('spec.channel is required');
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:       ${this.metadata.name}
Channel:    ${this.channel}
Version:    ${this.version}
Available:  ${this.isAvailable() ? 'True' : 'False'}
History:
${(this.status.history || [])
  .map(
    (entry) =>
      `  ${entry.version}  ${entry.state}  ${entry.completionTime || entry.startedTime || ''}`
  )
  .join('\n')}
Conditions:
${(this.status.conditions || []).map((c) => `  ${c.type.padEnd(18)} ${c.status.padEnd(6)} ${c.reason || ''} ${c.message || ''}`).join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

// ─── MetalLB (Operator-provided CRs) ───────────────────────────────────────

export class IPAddressPool extends ResourceBase {
  constructor(metadata = {}) {
    super('IPAddressPool', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'metallb.io/v1beta1',
    });
    const defaults = {
      addresses: deepClone(
        metadata.addresses || [metadata.addressRange || '192.168.100.200-192.168.100.210']
      ),
      autoAssign: metadata.autoAssign ?? true,
      avoidBuggyIPs: metadata.avoidBuggyIPs ?? false,
    };
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get addresses() {
    return this.spec.addresses || [];
  }

  /** First usable IP of a simple or ranged IPv4 pool entry (simulation only). */
  firstAddress() {
    const entry = this.addresses[0];
    if (!entry) return '';
    const [start] = String(entry).split('-');
    return start;
  }

  /** Allocate an IP by index from the first range (deterministic for the sim). */
  addressAt(index = 0) {
    const entry = this.addresses[0];
    if (!entry) return '';
    const parts = String(entry).split('-');
    const startIp = parts[0];
    if (parts.length === 1) return startIp;
    const octets = startIp.split('.').map(Number);
    let value = octets[3] + index;
    octets[3] = value % 256;
    return octets.join('.');
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.addresses) || this.spec.addresses.length === 0) {
      result.errors.push('spec.addresses must contain at least one address range or CIDR');
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Addresses:
${(this.spec.addresses || []).map((address) => `  ${address}`).join('\n')}
Auto Assign:  ${this.spec.autoAssign}
Avoid Buggy IPs: ${this.spec.avoidBuggyIPs}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class L2Advertisement extends ResourceBase {
  constructor(metadata = {}) {
    super('L2Advertisement', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'metallb.io/v1beta1',
    });
    const defaults = {
      ipAddressPools: deepClone(metadata.ipAddressPools || [metadata.ipAddressPool || 'default']),
    };
    if (metadata.interfaces) defaults.interfaces = deepClone(metadata.interfaces);
    if (metadata.nodeSelectors) defaults.nodeSelectors = deepClone(metadata.nodeSelectors);
    this._initSpec(defaults, metadata.spec);
    this._setInitialStatus({ phase: 'Active' });
  }

  get ipAddressPools() {
    return this.spec.ipAddressPools || [];
  }

  advertisesPool(poolName) {
    return this.ipAddressPools.includes(poolName);
  }

  validate() {
    const result = super.validate();
    if (!Array.isArray(this.spec.ipAddressPools) || this.spec.ipAddressPools.length === 0) {
      result.errors.push('spec.ipAddressPools must reference at least one IPAddressPool');
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  toDescribe() {
    return `Name:             ${this.metadata.name}
Namespace:        ${this.metadata.namespace}
IP Address Pools:
${(this.spec.ipAddressPools || []).map((pool) => `  ${pool}`).join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export default {
  APPS_DOMAIN,
  IMAGE_REGISTRY,
  OCP_VERSION,
  OCP_CHANNEL,
  Project,
  Route,
  BuildConfig,
  Build,
  ImageStream,
  Template,
  Subscription,
  SecurityContextConstraints,
  ClusterResourceQuota,
  LimitRange,
  OAuth,
  ClusterOperator,
  ClusterVersion,
  IPAddressPool,
  L2Advertisement,
};
