/**
 * ClusterState.js — in-memory OpenShift cluster resource store for OpenShift Games.
 *
 * This is the single source of truth for every resource in the simulated
 * cluster. It is intentionally dependency-free (no DOM, no Three.js) so it can
 * be exercised with plain Node harnesses.
 *
 * Conversion notes (OpenShift 4.22 / EX280):
 *  - Kinds, apiVersions, scope and owner chains are DERIVED from
 *    `js/data/kindRegistry.js`; do not hard-code kind lists here.
 *  - `Namespace` is retired as a game kind; everything uses `Project`.
 *    Legacy callers that still pass `Namespace` are transparently mapped to
 *    `Project` so old level data keeps working.
 *  - The cluster seeds an OpenShift-like default state: default Projects,
 *    SCCs, kubeadmin/admin users, a cluster-admin binding, ClusterOperators,
 *    ClusterVersion, an OAuth singleton and the ImageStreams in `openshift`.
 *  - `addResource()` honours a supplied `metadata.uid` (needed by draw mode)
 *    and never downgrades rich resource class instances to plain ResourceBase.
 *
 * @module engine/ClusterState
 */

import { ResourceBase } from '../resources/ResourceBase.js';
import { normalizeManifestObject } from '../resources/ManifestSerializer.js';
import {
  RESOURCE_KINDS as REGISTRY_RESOURCE_KINDS,
  CLUSTER_SCOPED_KINDS as REGISTRY_CLUSTER_SCOPED_KINDS,
  createResource,
  defaultNamespaceForKind,
  defaultSpecForKind,
  isClusterScopedKind as registryIsClusterScopedKind,
  getOwnerChain,
  normalizeKind,
} from '../data/kindRegistry.js';
import {
  canI as rbacCanI,
  getRoleRules,
  getSCCGrantsForSubject as rbacGetSCCGrantsForSubject,
  getSCCs as rbacGetSCCs,
  getSCCsForServiceAccount as rbacGetSCCsForServiceAccount,
  getSCCsForSubject as rbacGetSCCsForSubject,
  listPermissions as rbacListPermissions,
  normalizeSCCSubject,
  resolveSCCForPod as rbacResolveSCCForPod,
  sccAllowsPod as rbacSccAllowsPod,
  sccForServiceAccount as rbacSccForServiceAccount,
  whoCan as rbacWhoCan,
} from './RBACEngine.js';
import { OCP_CHANNEL, OCP_VERSION as PLATFORM_OCP_VERSION } from '../data/platformVersions.js';

// ─── OpenShift constants ───────────────────────────────────────────────────

/** Target OpenShift version of the game. */
export const OPENSHIFT_VERSION = PLATFORM_OCP_VERSION;
/** Upgrade channel exposed by ClusterVersion. */
export const OPENSHIFT_CHANNEL = OCP_CHANNEL;
/** Simulated cluster base domain. */
export const CLUSTER_DOMAIN = 'cluster.example.com';
/** Domain used by the default ingress router for Route hosts. */
export const APPS_DOMAIN = `apps.${CLUSTER_DOMAIN}`;
/** Internal image registry host used in imagestream dockerImageReference values. */
export const IMAGE_REGISTRY_HOST = 'image-registry.openshift-image-registry.svc:5000';

/** Projects every simulated cluster starts with (CONVERSION-SPEC §3.2). */
export const DEFAULT_PROJECTS = [
  'default',
  'openshift',
  'openshift-config',
  'openshift-operators',
  'openshift-ingress',
  'openshift-monitoring',
  'openshift-console',
  'openshift-authentication',
  'openshift-image-registry',
  'kube-system',
];

/** ClusterOperators seeded for the simulated 4.22 cluster. */
export const CLUSTER_OPERATOR_NAMES = [
  'authentication',
  'console',
  'dns',
  'ingress',
  'monitoring',
  'network',
  'image-registry',
  'kube-apiserver',
  'openshift-apiserver',
  'openshift-controller-manager',
  'operator-lifecycle-manager',
  'storage',
  'etcd',
];

/** ImageStreams pre-installed in the `openshift` project (OCP 4.22 samples).
 * `latestVersion` is the UBI image the samples' `latest` tag resolves to. */
export const DEFAULT_IMAGE_STREAMS = [
  { name: 'nodejs', tags: ['20-ubi9', '22-ubi9', 'latest'], repository: 'nodejs', latestVersion: '22' },
  { name: 'python', tags: ['3.12-ubi9', 'latest'], repository: 'python', latestVersion: '3.12' },
  { name: 'nginx', tags: ['1.26-ubi9', 'latest'], repository: 'nginx', latestVersion: '1.26' },
];

/** Internal registry import reference for a 4.22 sample tag (registry.redhat.io/ubi9/<image>:latest). */
export function sampleImageReference(imageStream, tag) {
  const version = tag === 'latest' ? imageStream.latestVersion : tag.split('-')[0];
  const imageVersion = String(version).replace(/\./g, '');
  return `registry.redhat.io/ubi9/${imageStream.repository}-${imageVersion}:latest`;
}

/** Built-in SCC definitions seeded into every cluster.
 *
 * Specs mirror the real OCP 4.22 defaults shipped by the kube-apiserver operator
 * (`bindata/bootkube/scc-manifests/..._00_scc-<name>.yaml` in
 * openshift/cluster-kube-apiserver-operator release-4.22).
 *
 * Admission note: on a real 4.22 install, restricted-v2 AND restricted-v3 are
 * granted to `system:authenticated` through ClusterRoleBindings, so admission
 * normally selects the more restrictive restricted-v3. The game's SCC admission
 * reads `spec.users/spec.groups` only (no RBAC-aware SCC grants), therefore
 * restricted-v3 is seeded without the `system:authenticated` group here to keep
 * the current effective admission (restricted-v2) used by existing labs. The
 * object is still listed/describable by `oc get scc` / `oc describe scc`.
 */
const SCC_ALLOWED_VOLUMES = [
  'configMap',
  'csi',
  'downwardAPI',
  'emptyDir',
  'ephemeral',
  'image',
  'persistentVolumeClaim',
  'projected',
  'secret',
];
const SCC_HOST_VOLUMES = [
  'configMap',
  'csi',
  'downwardAPI',
  'emptyDir',
  'ephemeral',
  'hostPath',
  'image',
  'persistentVolumeClaim',
  'projected',
  'secret',
];
const SCC_HOST_NFS_VOLUMES = [
  'configMap',
  'csi',
  'downwardAPI',
  'emptyDir',
  'ephemeral',
  'hostPath',
  'image',
  'nfs',
  'persistentVolumeClaim',
  'projected',
  'secret',
];

export function defaultSCCDefinitions() {
  // Fields shared by all default SCCs; each entry overrides what differs.
  const baseSpec = {
    priority: null,
    allowPrivilegedContainer: false,
    allowHostDirVolumePlugin: false,
    allowHostNetwork: false,
    allowHostPorts: false,
    allowHostPID: false,
    allowHostIPC: false,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    defaultAddCapabilities: null,
    allowedCapabilities: null,
    requiredDropCapabilities: null,
    runAsUser: { type: 'MustRunAsRange' },
    seLinuxContext: { type: 'MustRunAs' },
    fsGroup: { type: 'MustRunAs' },
    supplementalGroups: { type: 'RunAsAny' },
    seccompProfiles: null,
    users: [],
    groups: [],
    volumes: [...SCC_ALLOWED_VOLUMES],
  };
  return [
    {
      name: 'anyuid',
      spec: {
        ...baseSpec,
        priority: 10,
        groups: ['system:cluster-admins'],
        allowPrivilegeEscalation: true,
        allowedCapabilities: null,
        requiredDropCapabilities: ['MKNOD'],
        runAsUser: { type: 'RunAsAny' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        seccompProfiles: null,
      },
    },
    {
      name: 'hostaccess',
      spec: {
        ...baseSpec,
        allowHostDirVolumePlugin: true,
        allowHostIPC: true,
        allowHostNetwork: true,
        allowHostPID: true,
        allowHostPorts: true,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['KILL', 'MKNOD', 'SETUID', 'SETGID'],
        runAsUser: { type: 'MustRunAsRange' },
        fsGroup: { type: 'MustRunAs' },
        supplementalGroups: { type: 'RunAsAny' },
        volumes: [...SCC_HOST_VOLUMES],
      },
    },
    {
      name: 'hostmount-anyuid',
      spec: {
        ...baseSpec,
        allowHostDirVolumePlugin: true,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['MKNOD'],
        runAsUser: { type: 'RunAsAny' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        users: ['system:serviceaccount:openshift-infra:pv-recycler-controller'],
        volumes: [...SCC_HOST_NFS_VOLUMES],
      },
    },
    {
      name: 'hostmount-anyuid-v2',
      spec: {
        ...baseSpec,
        allowHostDirVolumePlugin: true,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['MKNOD'],
        runAsUser: { type: 'RunAsAny' },
        seLinuxContext: { type: 'RunAsAny' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        volumes: [...SCC_HOST_NFS_VOLUMES],
      },
    },
    {
      name: 'hostnetwork',
      spec: {
        ...baseSpec,
        allowHostNetwork: true,
        allowHostPorts: true,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['KILL', 'MKNOD', 'SETUID', 'SETGID'],
        runAsUser: { type: 'MustRunAsRange' },
        fsGroup: { type: 'MustRunAs' },
        supplementalGroups: { type: 'MustRunAs' },
      },
    },
    {
      name: 'hostnetwork-v2',
      spec: {
        ...baseSpec,
        allowHostNetwork: true,
        allowHostPorts: true,
        allowPrivilegeEscalation: false,
        allowedCapabilities: ['NET_BIND_SERVICE'],
        requiredDropCapabilities: ['ALL'],
        runAsUser: { type: 'MustRunAsRange' },
        fsGroup: { type: 'MustRunAs' },
        supplementalGroups: { type: 'MustRunAs' },
        seccompProfiles: ['runtime/default'],
      },
    },
    {
      name: 'nested-container',
      spec: {
        ...baseSpec,
        allowPrivilegeEscalation: true,
        allowedCapabilities: ['SETUID', 'SETGID'],
        requiredDropCapabilities: null,
        runAsUser: { type: 'MustRunAsRange', uidRangeMin: 0, uidRangeMax: 65534 },
        seLinuxContext: { type: 'MustRunAs', seLinuxOptions: { type: 'container_engine_t' } },
        fsGroup: { type: 'MustRunAs', ranges: [{ min: 0, max: 65534 }] },
        supplementalGroups: { type: 'MustRunAs', ranges: [{ min: 0, max: 65534 }] },
        seccompProfiles: ['*'],
        userNamespaceLevel: 'RequirePodLevel',
      },
    },
    {
      // Installed by the cluster-monitoring-operator, not the kube-apiserver
      // operator bindata; listed as a default SCC in the OCP 4.22 docs.
      // Spec from cluster-monitoring-operator release-4.22
      // assets/node-exporter/security-context-constraints.yaml.
      name: 'node-exporter',
      spec: {
        ...baseSpec,
        allowHostDirVolumePlugin: true,
        allowHostNetwork: true,
        allowHostPID: true,
        allowHostPorts: true,
        allowPrivilegedContainer: true,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: null,
        runAsUser: { type: 'RunAsAny' },
        seLinuxContext: { type: 'RunAsAny' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        seccompProfiles: ['runtime/default'],
        users: [],
        groups: [],
        volumes: ['*'],
      },
    },
    {
      name: 'nonroot',
      spec: {
        ...baseSpec,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['KILL', 'MKNOD', 'SETUID', 'SETGID'],
        runAsUser: { type: 'MustRunAsNonRoot' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
      },
    },
    {
      name: 'nonroot-v2',
      spec: {
        ...baseSpec,
        // Real object has groups: [] plus a system:authenticated SCC binding.
        groups: ['system:authenticated'],
        allowPrivilegeEscalation: false,
        allowedCapabilities: ['NET_BIND_SERVICE'],
        requiredDropCapabilities: ['ALL'],
        runAsUser: { type: 'MustRunAsNonRoot' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        seccompProfiles: ['runtime/default'],
      },
    },
    {
      name: 'privileged',
      spec: {
        ...baseSpec,
        allowPrivilegedContainer: true,
        allowHostDirVolumePlugin: true,
        allowHostNetwork: true,
        allowHostPorts: true,
        allowHostPID: true,
        allowHostIPC: true,
        allowPrivilegeEscalation: true,
        allowedCapabilities: ['*'],
        allowedUnsafeSysctls: ['*'],
        requiredDropCapabilities: null,
        runAsUser: { type: 'RunAsAny' },
        seLinuxContext: { type: 'RunAsAny' },
        fsGroup: { type: 'RunAsAny' },
        supplementalGroups: { type: 'RunAsAny' },
        seccompProfiles: ['*'],
        groups: ['system:cluster-admins', 'system:nodes', 'system:masters'],
        users: ['system:admin', 'system:serviceaccount:openshift-infra:build-controller'],
        volumes: ['*'],
      },
    },
    {
      name: 'restricted',
      spec: {
        ...baseSpec,
        allowPrivilegeEscalation: true,
        requiredDropCapabilities: ['KILL', 'MKNOD', 'SETUID', 'SETGID'],
        runAsUser: { type: 'MustRunAsRange' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'MustRunAs' },
        supplementalGroups: { type: 'RunAsAny' },
      },
    },
    {
      name: 'restricted-v2',
      spec: {
        ...baseSpec,
        // Real object has groups: [] and is granted to system:authenticated via
        // the system:openshift:scc:restricted-v2 ClusterRoleBinding; the game's
        // SCC admission model uses spec.groups directly, so keep the grant here.
        groups: ['system:authenticated'],
        allowPrivilegeEscalation: false,
        allowedCapabilities: ['NET_BIND_SERVICE'],
        requiredDropCapabilities: ['ALL'],
        runAsUser: { type: 'MustRunAsRange' },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'MustRunAs' },
        supplementalGroups: { type: 'RunAsAny' },
        seccompProfiles: ['runtime/default'],
      },
    },
    {
      name: 'restricted-v3',
      // Not granted to system:authenticated in-game (see admission note above).
      spec: {
        ...baseSpec,
        groups: [],
        allowPrivilegeEscalation: false,
        allowedCapabilities: ['NET_BIND_SERVICE'],
        requiredDropCapabilities: ['ALL'],
        runAsUser: { type: 'MustRunAsRange', uidRangeMin: 1000, uidRangeMax: 65534 },
        seLinuxContext: { type: 'MustRunAs' },
        fsGroup: { type: 'MustRunAs', ranges: [{ min: 1000, max: 65534 }] },
        supplementalGroups: { type: 'MustRunAs', ranges: [{ min: 1000, max: 65534 }] },
        seccompProfiles: ['runtime/default'],
        userNamespaceLevel: 'RequirePodLevel',
      },
    },
  ];
}

// ─── Derived kind metadata (single source of truth = kindRegistry.js) ──────

/** All canonical resource kinds, in registry order. */
export const RESOURCE_KINDS = [...REGISTRY_RESOURCE_KINDS];
/** Kinds without a namespace (cluster-scoped). */
export const CLUSTER_SCOPED_KINDS = [...REGISTRY_CLUSTER_SCOPED_KINDS];
/** Parent kind → expected child kinds, derived from the registry ownerChain. */
export const OWNER_CHAINS = Object.fromEntries(
  RESOURCE_KINDS.filter((kind) => getOwnerChain(kind).length > 0).map((kind) => [kind, [...getOwnerChain(kind)]])
);

/**
 * Is `kind` cluster-scoped? Backwards-compatible export used by index.html and
 * draw.html; delegates to the registry.
 * @param {string} kind
 * @returns {boolean}
 */
export function isClusterScopedKind(kind) {
  if (kind === 'Namespace') return false;
  return registryIsClusterScopedKind(kind);
}

// ─── Small shared object helpers ───────────────────────────────────────────

/**
 * Structured clone of JSON-compatible data (safe for functions? no — functions
 * are dropped; resources only contain data).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
  return out;
}

/**
 * Deep merge plain objects. Arrays and scalars from later sources replace
 * earlier values (Kubernetes strategic-merge lite). `undefined` values are
 * skipped.
 * @param {object} target
 * @param {...object} sources
 * @returns {object}
 */
export function deepMerge(target, ...sources) {
  const out = target && typeof target === 'object' ? target : {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = deepMerge(out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}, value);
      } else {
        out[key] = deepClone(value);
      }
    }
  }
  return out;
}

/**
 * Parse a Kubernetes CPU quantity into millicores.
 * @param {string|number} value
 * @returns {number}
 */
export function parseCpuMillis(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (!str) return 0;
  if (str.endsWith('m')) return parseFloat(str) || 0;
  const n = parseFloat(str);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 1000);
}

/**
 * Parse a Kubernetes memory quantity into mebibytes (Mi).
 * @param {string|number} value
 * @returns {number}
 */
export function parseMemoryMi(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (!str) return 0;
  const match = str.match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!match) return 0;
  const n = parseFloat(match[1]);
  if (Number.isNaN(n)) return 0;
  const unit = match[2];
  switch (unit) {
    case 'Ki':
      return n / 1024;
    case 'Mi':
      return n;
    case 'Gi':
      return n * 1024;
    case 'Ti':
      return n * 1024 * 1024;
    case 'K':
    case 'k':
      return (n * 1000) / (1024 * 1024);
    case 'M':
      return (n * 1000 * 1000) / (1024 * 1024);
    case 'G':
      return (n * 1000 * 1000 * 1000) / (1024 * 1024);
    case 'T':
      return (n * 1000 * 1000 * 1000 * 1000) / (1024 * 1024);
    default:
      // Kubernetes quantities without a unit are bytes.
      return n / (1024 * 1024);
  }
}

const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function isValidProjectName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 63 && DNS1123_LABEL.test(name);
}

// ─── ClusterState ──────────────────────────────────────────────────────────

export class ClusterState {
  /**
   * @param {import('./GameEngine.js').EventBus} [eventBus]
   */
  constructor(eventBus) {
    this.eventBus = eventBus || null;
    this.resources = new Map();
    /**
     * config.openshift.io/v1 Project singleton (`project.config.openshift.io/cluster`).
     * Kept OUT of the resource maps/indexes because its kind name ("Project")
     * collides with the project.openshift.io Project game kind.
     * @type {object|null}
     */
    this._projectConfig = null;
    this.relationships = new Map();
    this.reverseRelationships = new Map();
    this.kindIndex = new Map();
    this.namespaceIndex = new Map();
    this.nameIndex = new Map();
    this.labelIndex = new Map();
    /** Legacy quota map kept for backwards compatibility (`setResourceQuota`). */
    this.resourceQuotas = new Map();
    this.limitRanges = new Map();
    this._watchCallbacks = new Map();
    this._batchMode = false;
    this._batchedEvents = [];
    this._unknownKindsWarned = new Set();

    for (const kind of RESOURCE_KINDS) {
      this.kindIndex.set(kind, new Set());
    }

    this._initDefaults();
  }

  // ── Default OpenShift cluster state ─────────────────────────────────────

  /** Seed the default OpenShift 4.22 cluster resources. */
  _initDefaults() {
    // Projects first so every namespaced namespace reference resolves.
    for (const name of DEFAULT_PROJECTS) {
      const project = this._seed('Project', name, {
        uid: `seed-project-${name}`,
        labels: { 'kubernetes.io/metadata.name': name, 'openshift.io/project': name },
        annotations: { 'openshift.io/display-name': name, 'openshift.io/requester': 'kubeadmin' },
        spec: { displayName: name === 'default' ? 'Default project' : name, description: '' },
        status: { phase: 'Active' },
      });
      project.metadata.name = name;
    }

    // Default service account in every default project.
    for (const name of DEFAULT_PROJECTS) {
      this._seed('ServiceAccount', 'default', {
        namespace: name,
        uid: `seed-sa-${name}-default`,
        spec: {},
      });
    }

    // SecurityContextConstraints.
    for (const def of defaultSCCDefinitions()) {
      this._seed('SecurityContextConstraints', def.name, {
        uid: `seed-scc-${def.name}`,
        spec: def.spec,
      });
    }

    // Identity: kubeadmin + admin users and the cluster-admin binding.
    this._seed('ClusterRole', 'cluster-admin', {
      uid: 'seed-clusterrole-cluster-admin',
      spec: { rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
    });
    this._seed('User', 'kubeadmin', {
      uid: 'seed-user-kubeadmin',
      spec: { fullName: 'Cluster administrator', groups: ['system:authenticated', 'system:masters'], identities: [] },
    });
    this._seed('User', 'admin', {
      uid: 'seed-user-admin',
      spec: { fullName: 'Administrator', groups: ['system:authenticated'], identities: [] },
    });
    this._seed('ClusterRoleBinding', 'kubeadmin-cluster-admin', {
      uid: 'seed-crb-kubeadmin',
      spec: {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
        subjects: [{ kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: 'kubeadmin' }],
      },
    });
    // Real OpenShift 4.x bootstrap policy: the `self-provisioners`
    // ClusterRoleBinding binds ClusterRole `self-provisioner` to the OAuth
    // authenticated group so any logged-in user can create projects with
    // `oc new-project`. Removing that subject (the documented way to disable
    // self-provisioning) must make `new-project` return Forbidden (issue #3).
    this._seed('ClusterRole', 'self-provisioner', {
      uid: 'seed-clusterrole-self-provisioner',
      spec: {
        rules: [
          { apiGroups: ['project.openshift.io'], resources: ['projectrequests'], verbs: ['create'] },
        ],
      },
    });
    this._seed('ClusterRoleBinding', 'self-provisioners', {
      uid: 'seed-crb-self-provisioners',
      spec: {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'self-provisioner' },
        subjects: [{ kind: 'Group', apiGroup: 'rbac.authorization.k8s.io', name: 'system:authenticated:oauth' }],
      },
    });

    // ClusterOperators: healthy on a freshly installed 4.22 cluster.
    for (const name of CLUSTER_OPERATOR_NAMES) {
      this._seed('ClusterOperator', name, {
        uid: `seed-co-${name}`,
        status: {
          conditions: [
            { type: 'Available', status: 'True', reason: 'AsExpected', message: 'All is well', lastTransitionTime: new Date().toISOString() },
            { type: 'Progressing', status: 'False', reason: 'AsExpected', message: 'All is well', lastTransitionTime: new Date().toISOString() },
            { type: 'Degraded', status: 'False', reason: 'AsExpected', message: 'All is well', lastTransitionTime: new Date().toISOString() },
            { type: 'Upgradeable', status: 'True', reason: 'AsExpected', message: '' },
          ],
          versions: [{ name: 'operator', version: OPENSHIFT_VERSION }],
        },
      });
    }

    // ClusterVersion singleton.
    this._seed('ClusterVersion', 'version', {
      uid: 'seed-clusterversion-version',
      spec: { channel: OPENSHIFT_CHANNEL, clusterID: 'simulated-cluster-id' },
      status: {
        desired: { version: OPENSHIFT_VERSION, channel: OPENSHIFT_CHANNEL },
        history: [{ state: 'Completed', version: OPENSHIFT_VERSION, startedTime: new Date().toISOString(), completionTime: new Date().toISOString() }],
        conditions: [
          { type: 'Available', status: 'True', reason: 'ClusterVersionAvailable', message: `Done applying ${OPENSHIFT_VERSION}` },
          { type: 'Progressing', status: 'False', reason: 'ClusterVersionNotProgressing', message: `Cluster version is ${OPENSHIFT_VERSION}` },
        ],
        versionHash: 'simulated',
      },
    });

    // OAuth singleton (no identity providers configured yet).
    this._seed('OAuth', 'cluster', {
      uid: 'seed-oauth-cluster',
      spec: { identityProviders: [], tokenConfig: {} },
      status: { ready: false, rolloutPending: false },
    });

    // ImageStreams in the openshift project (S2I builder images).
    for (const imageStream of DEFAULT_IMAGE_STREAMS) {
      const is = this._seed('ImageStream', imageStream.name, {
        namespace: 'openshift',
        uid: `seed-imagestream-openshift-${imageStream.name}`,
        spec: { lookupPolicy: { local: false }, tags: [] },
        status: { dockerImageRepository: `${IMAGE_REGISTRY_HOST}/openshift/${imageStream.name}`, tags: [] },
      });
      for (const tag of imageStream.tags) {
        this.updateImageStreamTag('openshift', imageStream.name, tag, {
          // Real 4.22 samples import from registry.redhat.io/ubi9/<image>-<ver>:latest.
          dockerImageReference: sampleImageReference(imageStream, tag),
          isExternal: true,
          silent: true,
        });
      }
      is.recordEvent('Normal', 'Imported', `Imported ${imageStream.tags.length} tags`);
    }

    // Project request template: a fresh OCP 4.22 cluster stores NO Template.
    // When `spec.projectRequestTemplate` is unset on
    // project.config.openshift.io/cluster the API server synthesises the default
    // template; customisation is an admin opt-in flow:
    //   oc adm create-bootstrap-project-template -o yaml > template.yaml
    //   edit template.yaml && oc create -f template.yaml -n openshift-config
    //   oc edit project.config.openshift.io/cluster  # spec.projectRequestTemplate.name
    this._seedProjectConfig();
  }

  /**
   * Create and register a seeded default resource with a deterministic UID.
   * @param {string} kind
   * @param {string} name
   * @param {{namespace?: string, spec?: object, status?: object, labels?: object, annotations?: object, uid?: string}} [options]
   * @returns {ResourceBase}
   */
  _seed(kind, name, options = {}) {
    const namespaced = !isClusterScopedKind(kind);
    const namespace = namespaced ? options.namespace || 'default' : '';
    const resource = createResource(kind, {
      name,
      namespace,
      labels: options.labels || {},
      annotations: options.annotations || {},
      spec: {},
    });
    resource.metadata.uid = options.uid || `seed-${kind}-${namespace ? `${namespace}-` : ''}${name}`;
    resource.apiVersion = resource.apiVersion || 'v1';
    resource.spec = deepMerge({}, defaultSpecForKind(kind), options.spec || {});
    if (options.status) this._applyStatus(resource, options.status);
    // Register directly to avoid duplicate-name exceptions while seeding.
    this._register(resource);
    return resource;
  }

  get totalResources() {
    return this.resources.size;
  }

  // ── Event batching ──────────────────────────────────────────────────────

  startBatch() {
    this._batchMode = true;
    this._batchedEvents = [];
  }

  flushBatch() {
    this._batchMode = false;
    const events = this._batchedEvents;
    this._batchedEvents = [];
    for (const evt of events) {
      this._emitEvent(evt.type, evt.resource, evt.extra);
    }
  }

  /**
   * @param {'added'|'modified'|'deleted'} type
   * @param {ResourceBase} resource
   * @param {object} [extra]
   */
  _emitEvent(type, resource, extra = {}) {
    const payload = {
      type,
      resource,
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
      uid: resource.metadata.uid,
      timestamp: Date.now(),
      ...extra,
    };
    if (this._batchMode) {
      this._batchedEvents.push({ type, resource, extra });
      return;
    }
    if (this.eventBus) {
      this.eventBus.emit(`cluster:${type}`, payload);
      this.eventBus.emit(`cluster:${type}:${resource.kind}`, payload);
    }
    const watchers = this._watchCallbacks.get(resource.kind) || [];
    for (const callback of watchers) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`ClusterState watcher error for ${resource.kind}:`, error);
      }
    }
  }

  // ── Write APIs ──────────────────────────────────────────────────────────

  /**
   * Register a resource. Throws when a different resource already uses the same
   * kind/name/namespace (use {@link addResource} for upsert semantics).
   * @param {ResourceBase} resource
   * @returns {ResourceBase}
   */
  add(resource) {
    if (!(resource instanceof ResourceBase)) {
      throw new Error('Resource must be an instance of ResourceBase');
    }
    const existingByUid = this.resources.get(resource.uid);
    if (existingByUid) {
      if (existingByUid === resource) return resource;
      return this.update(resource.uid, resource);
    }
    const nameKey = `${resource.kind}:${resource.metadata.namespace}:${resource.metadata.name}`;
    const existingUid = this.nameIndex.get(nameKey);
    if (existingUid && this.resources.has(existingUid)) {
      throw new Error(`${resource.kind} "${resource.metadata.name}" already exists in project "${resource.metadata.namespace || '(cluster)'}"`);
    }
    this._register(resource);
    if (resource.kind === 'Project') this.ensureProjectDefaults(resource);
    return resource;
  }

  /** Register indices/relationships and emit `cluster:added`. */
  _register(resource) {
    this.resources.set(resource.uid, resource);
    this._addToKindIndex(resource);
    this._addToNamespaceIndex(resource);
    this._addToNameIndex(resource);
    this._addToLabelIndex(resource);
    this.relationships.set(resource.uid, new Set());
    this.reverseRelationships.set(resource.uid, new Set());
    for (const ref of resource.metadata.ownerReferences) {
      this._addRelationship(ref.uid, resource.uid);
    }
    this._emitEvent('added', resource);
    return resource;
  }

  /**
   * Apply a partial update to a resource.
   * @param {string} uid
   * @param {ResourceBase|{spec?: object, status?: object, metadata?: object}} updates
   * @returns {ResourceBase|null}
   */
  update(uid, updates) {
    const resource = this.resources.get(uid);
    if (!resource) return null;

    this._removeFromLabelIndex(resource);

    if (updates instanceof ResourceBase) {
      const oldPhase = resource.status.phase;
      resource.spec = deepClone(updates.spec);
      resource.status = deepClone(updates.status);
      if (!Array.isArray(resource.status.conditions)) resource.status.conditions = [];
      resource.apiVersion = updates.apiVersion || resource.apiVersion;
      Object.assign(resource.metadata.labels, updates.metadata.labels);
      Object.assign(resource.metadata.annotations, updates.metadata.annotations);
      resource._bumpResourceVersion();

      if (oldPhase !== resource.status.phase) {
        resource.recordEvent('Normal', 'PhaseChange', `Phase changed from ${oldPhase} to ${resource.status.phase}`);
      }
    } else if (updates && typeof updates === 'object') {
      if (updates.spec) {
        resource.spec = deepMerge(resource.spec, updates.spec);
        resource.metadata.generation++;
      }
      if (updates.status) {
        this._applyStatus(resource, updates.status);
      }
      if (updates.metadata) {
        if (updates.metadata.labels) Object.assign(resource.metadata.labels, updates.metadata.labels);
        if (updates.metadata.annotations) Object.assign(resource.metadata.annotations, updates.metadata.annotations);
      }
      if (updates.apiVersion) resource.apiVersion = updates.apiVersion;
      resource._bumpResourceVersion();
    }

    this._addToLabelIndex(resource);
    this._emitEvent('modified', resource);
    return resource;
  }

  /**
   * Apply a full/partial status object to a resource.
   * @param {ResourceBase} resource
   * @param {object} status
   */
  _applyStatus(resource, status) {
    if (!status || typeof status !== 'object') return resource;
    if (!resource.status || typeof resource.status !== 'object') {
      resource.status = { phase: 'Pending', conditions: [], observedGeneration: 0 };
    }
    if (!Array.isArray(resource.status.conditions)) resource.status.conditions = [];
    for (const [key, value] of Object.entries(status)) {
      if (key === 'phase') {
        if (value) resource.status.phase = value;
      } else if (key === 'conditions' && Array.isArray(value)) {
        resource.status.conditions = deepClone(value);
      } else {
        resource.status[key] = deepClone(value);
      }
    }
    return resource;
  }

  /**
   * Remove a resource (recursively removes owned children). Resources with
   * finalizers are only marked for deletion until the finalizer is cleared.
   * @param {string} uid
   * @returns {ResourceBase|null}
   */
  remove(uid) {
    const resource = this.resources.get(uid);
    if (!resource) return null;

    if (resource.metadata.finalizers.length > 0) {
      resource.markForDeletion();
      this._emitEvent('modified', resource, { deletionPending: true });
      return resource;
    }

    for (const child of this.getChildren(uid)) {
      this.remove(child.uid);
    }

    this._removeFromKindIndex(resource);
    this._removeFromNamespaceIndex(resource);
    this._removeFromNameIndex(resource);
    this._removeFromLabelIndex(resource);

    const parents = this.reverseRelationships.get(uid);
    if (parents) {
      for (const parentUid of parents) {
        const parentRels = this.relationships.get(parentUid);
        if (parentRels) parentRels.delete(uid);
      }
    }
    const childRels = this.relationships.get(uid);
    if (childRels) {
      for (const childUid of childRels) {
        const reverseRels = this.reverseRelationships.get(childUid);
        if (reverseRels) reverseRels.delete(uid);
      }
    }

    this.relationships.delete(uid);
    this.reverseRelationships.delete(uid);
    this.resources.delete(uid);

    resource._deleted = true;
    this._emitEvent('deleted', resource);
    return resource;
  }

  // ── Read APIs ───────────────────────────────────────────────────────────

  get(uid) {
    return this.resources.get(uid) || null;
  }

  /** Alias of {@link get} for callers that use the semantic name. */
  getResource(uid) {
    return this.resources.get(uid) || null;
  }

  /**
   * Look up a resource by kind/name/namespace.
   * @param {string} kind
   * @param {string} name
   * @param {string} [namespace] ignored for cluster-scoped kinds
   * @returns {ResourceBase|null}
   */
  getByName(kind, name, namespace = 'default') {
    const canonical = this._canonicalKind(kind);
    if (!canonical) return null;
    const ns = isClusterScopedKind(canonical) ? '' : namespace;
    const uid = this.nameIndex.get(`${canonical}:${ns}:${name}`);
    if (!uid) return null;
    return this.resources.get(uid) || null;
  }

  /**
   * @param {string} kind
   * @returns {ResourceBase[]}
   */
  getByKind(kind) {
    if (kind === 'Namespace' || kind === 'namespace' || kind === 'ns') return this.getByKind('Project');
    const canonical = this._canonicalKind(kind);
    if (!canonical) return [];
    const uids = this.kindIndex.get(canonical);
    if (!uids) return [];
    const results = [];
    for (const uid of uids) {
      const resource = this.resources.get(uid);
      if (resource) results.push(resource);
    }
    return results;
  }

  /** Backwards-compatible alias of {@link getByKind}. */
  getResourcesByKind(kind) {
    return this.getByKind(kind);
  }

  getAllResources() {
    return Array.from(this.resources.values());
  }

  getByNamespace(namespace) {
    const uids = this.namespaceIndex.get(namespace);
    if (!uids) return [];
    const results = [];
    for (const uid of uids) {
      const resource = this.resources.get(uid);
      if (resource) results.push(resource);
    }
    return results;
  }

  getByKindAndNamespace(kind, namespace) {
    const kindUids = this.kindIndex.get(this._canonicalKind(kind));
    if (!kindUids) return [];
    const nsUids = this.namespaceIndex.get(namespace);
    if (!nsUids) return [];
    const results = [];
    for (const uid of kindUids) {
      if (nsUids.has(uid)) {
        const resource = this.resources.get(uid);
        if (resource) results.push(resource);
      }
    }
    return results;
  }

  /**
   * Structured query used by `oc get` and the inspector.
   * @param {{kind?: string, namespace?: string, allNamespaces?: boolean, selector?: object, fieldSelector?: object, phase?: string, name?: string, sortBy?: string, sortOrder?: string, limit?: number}} [options]
   * @returns {ResourceBase[]}
   */
  query(options = {}) {
    let results = [];
    if (options.kind) {
      results = this.getByKind(options.kind);
    } else if (options.namespace) {
      results = this.getByNamespace(options.namespace);
    } else {
      results = Array.from(this.resources.values());
    }

    if (options.kind && options.namespace) {
      results = results.filter((resource) => resource.metadata.namespace === options.namespace);
    }
    if (options.selector) {
      results = results.filter((resource) => resource.matchesSelector(options.selector));
    }
    if (options.fieldSelector) {
      for (const [field, value] of Object.entries(options.fieldSelector)) {
        results = results.filter((resource) => resource.matchesFieldSelector(field, value));
      }
    }
    if (options.phase) {
      results = results.filter((resource) => resource.status.phase === options.phase);
    }
    if (options.name) {
      results = results.filter((resource) => resource.metadata.name.includes(options.name));
    }
    if (options.sortBy) {
      const key = options.sortBy;
      results.sort((a, b) => {
        const av = a.metadata[key] ?? a.status[key] ?? '';
        const bv = b.metadata[key] ?? b.status[key] ?? '';
        if (av < bv) return options.sortOrder === 'desc' ? 1 : -1;
        if (av > bv) return options.sortOrder === 'desc' ? -1 : 1;
        return 0;
      });
    }
    if (options.limit) results = results.slice(0, options.limit);
    return results;
  }

  selectByLabels(kind, selector) {
    return this.getByKind(kind).filter((resource) => resource.matchesSelector(selector));
  }

  findPodsForService(serviceName, namespace = 'default') {
    const service = this.getByName('Service', serviceName, namespace);
    if (!service || !service.spec.selector) return [];
    return this.selectByLabels('Pod', service.spec.selector).filter((pod) => pod.metadata.namespace === namespace);
  }

  /** Ready endpoints (pods) for a Service. */
  getServiceEndpoints(service) {
    if (!service || !service.spec.selector) return [];
    return this.selectByLabels('Pod', service.spec.selector).filter(
      (pod) => pod.metadata.namespace === service.metadata.namespace && pod.status.phase === 'Running' && pod.isConditionTrue('Ready')
    );
  }

  findServiceForPod(podUid) {
    const pod = this.get(podUid);
    if (!pod) return [];
    return this.getByKindAndNamespace('Service', pod.metadata.namespace).filter((service) => {
      if (!service.spec.selector) return false;
      return pod.matchesSelector(service.spec.selector);
    });
  }

  getOwnerChain(uid) {
    const chain = [];
    let current = this.get(uid);
    while (current) {
      chain.unshift(current);
      const owner = current.getControllerOwner();
      if (!owner) break;
      current = this.get(owner.uid);
    }
    return chain;
  }

  getChildren(uid) {
    const childUids = this.relationships.get(uid);
    if (!childUids) return [];
    const results = [];
    for (const childUid of childUids) {
      const resource = this.resources.get(childUid);
      if (resource) results.push(resource);
    }
    return results;
  }

  getDescendants(uid) {
    const descendants = [];
    const queue = [uid];
    const visited = new Set();
    while (queue.length > 0) {
      const currentUid = queue.shift();
      if (visited.has(currentUid)) continue;
      visited.add(currentUid);
      for (const child of this.getChildren(currentUid)) {
        descendants.push(child);
        queue.push(child.uid);
      }
    }
    return descendants;
  }

  getParents(uid) {
    const parentUids = this.reverseRelationships.get(uid);
    if (!parentUids) return [];
    const results = [];
    for (const parentUid of parentUids) {
      const resource = this.resources.get(parentUid);
      if (resource) results.push(resource);
    }
    return results;
  }

  _addRelationship(parentUid, childUid) {
    let parentChildren = this.relationships.get(parentUid);
    if (!parentChildren) {
      parentChildren = new Set();
      this.relationships.set(parentUid, parentChildren);
    }
    parentChildren.add(childUid);

    let childParents = this.reverseRelationships.get(childUid);
    if (!childParents) {
      childParents = new Set();
      this.reverseRelationships.set(childUid, childParents);
    }
    childParents.add(parentUid);
  }

  addRelationship(parentUid, childUid) {
    this._addRelationship(parentUid, childUid);
    const child = this.get(childUid);
    const parent = this.get(parentUid);
    if (child && parent) child.addOwnerReference(parent);
  }

  removeRelationship(parentUid, childUid) {
    this.relationships.get(parentUid)?.delete(childUid);
    this.reverseRelationships.get(childUid)?.delete(parentUid);
    const child = this.get(childUid);
    if (child) child.removeOwnerReference(parentUid);
  }

  // ── Index helpers ───────────────────────────────────────────────────────

  _addToKindIndex(resource) {
    let set = this.kindIndex.get(resource.kind);
    if (!set) {
      set = new Set();
      this.kindIndex.set(resource.kind, set);
    }
    set.add(resource.uid);
  }

  _removeFromKindIndex(resource) {
    this.kindIndex.get(resource.kind)?.delete(resource.uid);
  }

  _addToNamespaceIndex(resource) {
    const namespace = resource.metadata.namespace || '';
    let set = this.namespaceIndex.get(namespace);
    if (!set) {
      set = new Set();
      this.namespaceIndex.set(namespace, set);
    }
    set.add(resource.uid);
  }

  _removeFromNamespaceIndex(resource) {
    const namespace = resource.metadata.namespace || '';
    this.namespaceIndex.get(namespace)?.delete(resource.uid);
  }

  _addToNameIndex(resource) {
    this.nameIndex.set(`${resource.kind}:${resource.metadata.namespace}:${resource.metadata.name}`, resource.uid);
  }

  _removeFromNameIndex(resource) {
    this.nameIndex.delete(`${resource.kind}:${resource.metadata.namespace}:${resource.metadata.name}`);
  }

  _addToLabelIndex(resource) {
    for (const [key, value] of Object.entries(resource.metadata.labels)) {
      const indexKey = `${key}=${value}`;
      let set = this.labelIndex.get(indexKey);
      if (!set) {
        set = new Set();
        this.labelIndex.set(indexKey, set);
      }
      set.add(resource.uid);
    }
    // Keep a snapshot so externally-mutated labels can still be de-indexed.
    resource._indexedLabels = { ...resource.metadata.labels };
  }

  _removeFromLabelIndex(resource) {
    const indexed = resource._indexedLabels || resource.metadata.labels;
    for (const [key, value] of Object.entries(indexed)) {
      this.labelIndex.get(`${key}=${value}`)?.delete(resource.uid);
    }
    resource._indexedLabels = {};
  }

  /**
   * Update labels/annotations safely (removal-aware) and reindex.
   * @param {string} uid
   * @param {{labels?: object, annotations?: object, removeLabels?: string[], removeAnnotations?: string[]}} changes
   * @returns {ResourceBase|null}
   */
  updateMetadata(uid, changes = {}) {
    const resource = this.get(uid);
    if (!resource) return null;
    this._removeFromLabelIndex(resource);
    for (const [key, value] of Object.entries(changes.labels || {})) {
      if (value === null || value === undefined) delete resource.metadata.labels[key];
      else resource.metadata.labels[key] = value;
    }
    for (const key of changes.removeLabels || []) delete resource.metadata.labels[key];
    for (const [key, value] of Object.entries(changes.annotations || {})) {
      if (value === null || value === undefined) delete resource.metadata.annotations[key];
      else resource.metadata.annotations[key] = value;
    }
    for (const key of changes.removeAnnotations || []) delete resource.metadata.annotations[key];
    resource._bumpResourceVersion();
    this._addToLabelIndex(resource);
    this._emitEvent('modified', resource);
    return resource;
  }

  getByLabel(key, value) {
    const uids = this.labelIndex.get(`${key}=${value}`);
    if (!uids) return [];
    return Array.from(uids)
      .map((uid) => this.resources.get(uid))
      .filter(Boolean);
  }

  /**
   * Watch cluster changes for a kind (or all kinds with `'*'`).
   * @param {string} kind
   * @param {(payload: object) => void} callback
   * @returns {() => void} unsubscribe
   */
  watch(kind, callback) {
    if (!this._watchCallbacks.has(kind)) this._watchCallbacks.set(kind, []);
    this._watchCallbacks.get(kind).push(callback);
    return () => {
      const list = this._watchCallbacks.get(kind);
      if (list) this._watchCallbacks.set(kind, list.filter((cb) => cb !== callback));
    };
  }

  // ── Legacy quota map API ────────────────────────────────────────────────

  /**
   * Legacy quota API: register a per-namespace quota as a plain map
   * (`{pods, cpu (millis), memory (Mi)}`). New content should create real
   * `ResourceQuota`/`ClusterResourceQuota` resources instead.
   * @param {string} namespace
   * @param {{pods?: number, cpu?: number, memory?: number}} quota
   */
  setResourceQuota(namespace, quota) {
    this.resourceQuotas.set(namespace, { hard: { ...quota }, used: this._calculateQuotaUsage(namespace) });
  }

  getResourceQuota(namespace) {
    return this.resourceQuotas.get(namespace) || null;
  }

  _calculateQuotaUsage(namespace) {
    const pods = this.getByKindAndNamespace('Pod', namespace);
    let cpuUsed = 0;
    let memoryUsed = 0;
    let podCount = 0;
    for (const pod of pods) {
      if (pod.status.phase !== 'Running' && pod.status.phase !== 'Pending') continue;
      podCount++;
      for (const container of pod.spec.containers || []) {
        const requests = container.resources?.requests || {};
        cpuUsed += parseCpuMillis(requests.cpu || '0');
        memoryUsed += parseMemoryMi(requests.memory || '0');
      }
    }
    return { pods: podCount, cpu: cpuUsed, memory: memoryUsed };
  }

  /** @param {string|number} value @returns {number} millicores */
  _parseCpu(value) {
    return parseCpuMillis(value);
  }

  /** @param {string|number} value @returns {number} mebibytes */
  _parseMemory(value) {
    return parseMemoryMi(value);
  }

  // ── ResourceQuota / LimitRange / ClusterResourceQuota model ─────────────

  /** @returns {object[]} ResourceQuota resources in a project */
  getResourceQuotaObjects(namespace) {
    return this.getByKindAndNamespace('ResourceQuota', namespace);
  }

  /** @param {string} [namespace] @returns {object[]} LimitRange resources */
  getLimitRanges(namespace) {
    return namespace ? this.getByKindAndNamespace('LimitRange', namespace) : this.getByKind('LimitRange');
  }

  /** @returns {object[]} ClusterResourceQuota resources */
  getClusterResourceQuotas() {
    return this.getByKind('ClusterResourceQuota');
  }

  /**
   * Does a ClusterResourceQuota select a project?
   * @param {object} clusterQuota
   * @param {object} project
   * @returns {boolean}
   */
  clusterQuotaSelectsProject(clusterQuota, project) {
    const selector = clusterQuota.spec?.selector || {};
    const labels = selector.labels || {};
    const matchLabels = labels.matchLabels || {};
    const matchExpressions = labels.matchExpressions || [];
    if (Object.keys(matchLabels).length === 0 && matchExpressions.length === 0) return true;
    const projectLabels = project?.metadata?.labels || {};
    for (const [key, value] of Object.entries(matchLabels)) {
      if (projectLabels[key] !== value) return false;
    }
    for (const expression of matchExpressions) {
      const actual = projectLabels[expression.key];
      const values = expression.values || [];
      switch (expression.operator) {
        case 'In':
          if (!values.includes(actual)) return false;
          break;
        case 'NotIn':
          if (values.includes(actual)) return false;
          break;
        case 'Exists':
          if (actual === undefined) return false;
          break;
        case 'DoesNotExist':
          if (actual !== undefined) return false;
          break;
        default:
          break;
      }
    }
    return true;
  }

  /**
   * ClusterResourceQuotas that apply to a project.
   * @param {string} namespace
   * @returns {object[]}
   */
  getClusterResourceQuotasForProject(namespace) {
    const project = this.getByName('Project', namespace, '');
    if (!project) return [];
    return this.getClusterResourceQuotas().filter((clusterQuota) => this.clusterQuotaSelectsProject(clusterQuota, project));
  }

  /**
   * Aggregate quota usage for a project. Counts are numbers, CPU is millis and
   * memory is Mi. Supports the common `requests.*`, `limits.*`, object-count
   * and OpenShift `count/<resource>.<group>` keys.
   * @param {string} namespace
   * @returns {Record<string, number>}
   */
  getQuotaUsage(namespace) {
    const usage = {
      pods: 0,
      services: 0,
      configmaps: 0,
      secrets: 0,
      persistentvolumeclaims: 0,
      'requests.cpu': 0,
      'requests.memory': 0,
      'limits.cpu': 0,
      'limits.memory': 0,
      'count/deployments.apps': 0,
      'count/replicasets.apps': 0,
      'count/statefulsets.apps': 0,
      'count/daemonsets.apps': 0,
      'count/jobs.batch': 0,
      'count/cronjobs.batch': 0,
      'count/buildconfigs.build.openshift.io': 0,
      'count/builds.build.openshift.io': 0,
      'count/imagestreams.image.openshift.io': 0,
      'count/routes.route.openshift.io': 0,
    };

    const pods = this.getByKindAndNamespace('Pod', namespace);
    for (const pod of pods) {
      // Only admitted pods count towards quota: Running pods always count;
      // Pending pods count once admission marked them (quota-admitted).
      const admittedPending = pod.status.phase === 'Pending'
        && pod.metadata.annotations?.['openshiftgames/quota-admitted'] === 'true';
      if (pod.status.phase !== 'Running' && !admittedPending) continue;
      usage.pods++;
      for (const container of pod.spec.containers || []) {
        usage['requests.cpu'] += parseCpuMillis(container.resources?.requests?.cpu || '0');
        usage['requests.memory'] += parseMemoryMi(container.resources?.requests?.memory || '0');
        usage['limits.cpu'] += parseCpuMillis(container.resources?.limits?.cpu || '0');
        usage['limits.memory'] += parseMemoryMi(container.resources?.limits?.memory || '0');
      }
    }

    const count = (kind) => this.getByKindAndNamespace(kind, namespace).length;
    usage.services = count('Service');
    usage.configmaps = count('ConfigMap');
    usage.secrets = count('Secret');
    usage.persistentvolumeclaims = count('PersistentVolumeClaim');
    usage['count/deployments.apps'] = count('Deployment');
    usage['count/replicasets.apps'] = count('ReplicaSet');
    usage['count/statefulsets.apps'] = count('StatefulSet');
    usage['count/daemonsets.apps'] = count('DaemonSet');
    usage['count/jobs.batch'] = count('Job');
    usage['count/cronjobs.batch'] = count('CronJob');
    usage['count/buildconfigs.build.openshift.io'] = count('BuildConfig');
    usage['count/builds.build.openshift.io'] = count('Build');
    usage['count/imagestreams.image.openshift.io'] = count('ImageStream');
    usage['count/routes.route.openshift.io'] = count('Route');
    return usage;
  }

  /**
   * Aggregate usage of a ClusterResourceQuota across every selected project.
   * @param {object} clusterQuota
   * @returns {Record<string, number>}
   */
  getClusterQuotaUsage(clusterQuota) {
    const total = {};
    for (const project of this.getProjects()) {
      if (!this.clusterQuotaSelectsProject(clusterQuota, project)) continue;
      for (const [key, value] of Object.entries(this.getQuotaUsage(project.metadata.name))) {
        total[key] = (total[key] || 0) + value;
      }
    }
    return total;
  }

  /**
   * Refresh `.status.hard` / `.status.used` of every ResourceQuota and
   * `.status.total` of every ClusterResourceQuota.
   * @param {boolean} [emitChanges] emit cluster:modified events
   * @returns {number} number of updated quota objects
   */
  recalculateQuotaStatus(emitChanges = true) {
    let updated = 0;
    for (const quota of this.getByKind('ResourceQuota')) {
      const hard = deepClone(quota.spec.hard || {});
      const usedMap = this.getQuotaUsage(quota.metadata.namespace);
      const used = {};
      for (const key of Object.keys(hard)) {
        if (usedMap[key] !== undefined) used[key] = this._formatQuotaUsage(key, usedMap[key]);
        else used[key] = '0';
      }
      const newStatus = { hard: deepClone(hard), used, observedGeneration: quota.metadata.generation };
      const changed = JSON.stringify(quota.status?.used) !== JSON.stringify(used);
      quota.status = { ...quota.status, ...newStatus };
      if (changed) {
        updated++;
        if (emitChanges) this.update(quota.uid, quota);
      }
    }

    for (const clusterQuota of this.getByKind('ClusterResourceQuota')) {
      const hard = deepClone(clusterQuota.spec.quota?.hard || {});
      const usedMap = this.getClusterQuotaUsage(clusterQuota);
      const used = {};
      for (const key of Object.keys(hard)) {
        used[key] = usedMap[key] !== undefined ? this._formatQuotaUsage(key, usedMap[key]) : '0';
      }
      const changed = JSON.stringify(clusterQuota.status?.total?.used) !== JSON.stringify(used);
      clusterQuota.status = {
        ...clusterQuota.status,
        total: { hard: deepClone(hard), used },
        namespaces: this.getProjects()
          .filter((project) => this.clusterQuotaSelectsProject(clusterQuota, project))
          .map((project) => project.metadata.name),
      };
      if (changed) {
        updated++;
        if (emitChanges) this.update(clusterQuota.uid, clusterQuota);
      }
    }
    return updated;
  }

  /**
   * Format an internal usage number back into a quota quantity string.
   * @param {string} key
   * @param {number} value
   * @returns {string}
   */
  _formatQuotaUsage(key, value) {
    if (key.endsWith('.cpu')) return `${Math.round(value)}m`;
    if (key.endsWith('.memory')) return `${Math.ceil(value)}Mi`;
    return String(Math.round(value));
  }

  /**
   * Check whether a project can admit one more pod with the given requests.
   * Considers real ResourceQuota resources, ClusterResourceQuotas and the
   * legacy `setResourceQuota` map. CPU is millis, memory is Mi.
   *
   * @param {string} namespace
   * @param {number} requestedCpu
   * @param {number} requestedMemory
   * @returns {{allowed: boolean, violations: string[], usage: object, quotaName?: string}}
   */
  checkQuota(namespace, requestedCpu = 0, requestedMemory = 0) {
    const violations = [];
    const usage = this.getQuotaUsage(namespace);
    let quotaName = null;

    const checkHard = (hard, currentUsage, label) => {
      const hardPods = hard.pods !== undefined ? Number(hard.pods) : undefined;
      if (hardPods !== undefined && currentUsage.pods + 1 > hardPods) {
        violations.push(`${label}: pods ${currentUsage.pods + 1} > ${hardPods}`);
      }
      for (const [cpuKey, label2] of [['requests.cpu', 'cpu'], ['cpu', 'cpu']]) {
        if (hard[cpuKey] === undefined) continue;
        const limit = parseCpuMillis(hard[cpuKey]);
        if (currentUsage['requests.cpu'] + requestedCpu > limit) {
          violations.push(`${label}: ${label2} ${currentUsage['requests.cpu'] + requestedCpu}m > ${limit}m`);
        }
        break;
      }
      for (const memKey of ['requests.memory', 'memory']) {
        if (hard[memKey] === undefined) continue;
        const limit = parseMemoryMi(hard[memKey]);
        if (currentUsage['requests.memory'] + requestedMemory > limit) {
          violations.push(`${label}: memory ${Math.round(currentUsage['requests.memory'] + requestedMemory)}Mi > ${Math.round(limit)}Mi`);
        }
        break;
      }
    };

    for (const quota of this.getResourceQuotaObjects(namespace)) {
      const hard = quota.spec.hard || {};
      const before = violations.length;
      checkHard(hard, usage, `exceeded quota: ${quota.metadata.name}`);
      if (violations.length > before) quotaName = quotaName || quota.metadata.name;
    }

    for (const clusterQuota of this.getClusterResourceQuotasForProject(namespace)) {
      const hard = clusterQuota.spec.quota?.hard || {};
      const totalUsage = this.getClusterQuotaUsage(clusterQuota);
      const before = violations.length;
      checkHard(hard, totalUsage, `exceeded cluster quota: ${clusterQuota.metadata.name}`);
      if (violations.length > before) quotaName = quotaName || clusterQuota.metadata.name;
    }

    const legacy = this.resourceQuotas.get(namespace);
    if (legacy) checkHard(legacy.hard, usage, 'exceeded quota');

    return { allowed: violations.length === 0, violations, usage, quotaName };
  }

  /**
   * Check a ClusterResourceQuota (used by the controller for named reporting).
   * @param {string} namespace
   * @param {number} requestedCpu
   * @param {number} requestedMemory
   * @returns {{allowed: boolean, violations: string[]}}
   */
  checkClusterResourceQuota(namespace, requestedCpu = 0, requestedMemory = 0) {
    const violations = [];
    for (const clusterQuota of this.getClusterResourceQuotasForProject(namespace)) {
      const hard = clusterQuota.spec.quota?.hard || {};
      const usage = this.getClusterQuotaUsage(clusterQuota);
      if (hard.pods !== undefined && usage.pods + 1 > Number(hard.pods)) {
        violations.push(`exceeded cluster quota: ${clusterQuota.metadata.name}`);
      }
      if (hard['requests.cpu'] !== undefined && usage['requests.cpu'] + requestedCpu > parseCpuMillis(hard['requests.cpu'])) {
        violations.push(`exceeded cluster quota: ${clusterQuota.metadata.name}`);
      }
      if (hard['requests.memory'] !== undefined && usage['requests.memory'] + requestedMemory > parseMemoryMi(hard['requests.memory'])) {
        violations.push(`exceeded cluster quota: ${clusterQuota.metadata.name}`);
      }
    }
    return { allowed: violations.length === 0, violations };
  }

  /**
   * Apply LimitRange defaults (`default`, `defaultRequest`) to a Pod spec.
   * @param {string} namespace
   * @param {object} podSpec
   * @returns {{applied: boolean, changes: string[]}}
   */
  applyLimitRangeDefaults(namespace, podSpec) {
    const changes = [];
    const limitRanges = this.getLimitRanges(namespace);
    if (!podSpec || !Array.isArray(podSpec.containers)) return { applied: false, changes };
    for (const limitRange of limitRanges) {
      for (const limit of limitRange.spec.limits || []) {
        if (limit.type !== 'Container') continue;
        const defaultLimits = limit.default || {};
        const defaultRequests = limit.defaultRequest || {};
        for (const container of podSpec.containers) {
          container.resources = container.resources || {};
          container.resources.requests = container.resources.requests || {};
          container.resources.limits = container.resources.limits || {};
          for (const [key, value] of Object.entries(defaultRequests)) {
            if (container.resources.requests[key] === undefined) {
              container.resources.requests[key] = value;
              changes.push(`${container.name || 'container'}.requests.${key}=${value}`);
            }
          }
          for (const [key, value] of Object.entries(defaultLimits)) {
            if (container.resources.limits[key] === undefined) {
              container.resources.limits[key] = value;
              changes.push(`${container.name || 'container'}.limits.${key}=${value}`);
            }
          }
        }
      }
    }
    return { applied: changes.length > 0, changes };
  }

  /**
   * Validate a Pod spec against the project's LimitRanges.
   * @param {string} namespace
   * @param {object} podSpec
   * @returns {{allowed: boolean, violations: string[]}}
   */
  checkLimitRange(namespace, podSpec) {
    const violations = [];
    const limitRanges = this.getLimitRanges(namespace);
    if (limitRanges.length === 0 || !podSpec) return { allowed: true, violations };
    const containers = podSpec.containers || [];

    for (const limitRange of limitRanges) {
      for (const limit of limitRange.spec.limits || []) {
        if (limit.type === 'Container') {
          for (const container of containers) {
            const requests = container.resources?.requests || {};
            const limits = container.resources?.limits || {};
            for (const [key, minValue] of Object.entries(limit.min || {})) {
              const actual = requests[key] !== undefined ? requests[key] : limits[key];
              if (actual === undefined) continue;
              const failed = key === 'cpu' ? parseCpuMillis(actual) < parseCpuMillis(minValue) : parseMemoryMi(actual) < parseMemoryMi(minValue);
              if (failed) {
                violations.push(`minimum ${key} usage per Container is ${minValue}, but request is ${actual}`);
              }
            }
            for (const [key, maxValue] of Object.entries(limit.max || {})) {
              const actual = limits[key] !== undefined ? limits[key] : requests[key];
              if (actual === undefined) continue;
              const failed = key === 'cpu' ? parseCpuMillis(actual) > parseCpuMillis(maxValue) : parseMemoryMi(actual) > parseMemoryMi(maxValue);
              if (failed) {
                violations.push(`maximum ${key} usage per Container is ${maxValue}, but limit is ${actual}`);
              }
            }
          }
        } else if (limit.type === 'Pod') {
          let podCpuRequest = 0;
          let podMemRequest = 0;
          for (const container of containers) {
            podCpuRequest += parseCpuMillis(container.resources?.requests?.cpu || '0');
            podMemRequest += parseMemoryMi(container.resources?.requests?.memory || '0');
          }
          for (const [key, minValue] of Object.entries(limit.min || {})) {
            const failed = key === 'cpu' ? podCpuRequest < parseCpuMillis(minValue) : key === 'memory' ? podMemRequest < parseMemoryMi(minValue) : false;
            if (failed) violations.push(`minimum ${key} usage per Pod is ${minValue}`);
          }
          for (const [key, maxValue] of Object.entries(limit.max || {})) {
            const failed = key === 'cpu' ? podCpuRequest > parseCpuMillis(maxValue) : key === 'memory' ? podMemRequest > parseMemoryMi(maxValue) : false;
            if (failed) violations.push(`maximum ${key} usage per Pod is ${maxValue}`);
          }
        }
      }
    }
    return { allowed: violations.length === 0, violations };
  }

  // ── Nodes / scheduling / cluster stats ──────────────────────────────────

  getNodeAllocatable(nodeName) {
    const node = this.getByName('Node', nodeName, '');
    if (!node) return null;

    const cpuSpec = node.spec.cpu || node.capacity?.cpu || node.status.capacity?.cpu;
    const memSpec = node.spec.memory || node.capacity?.memory || node.status.capacity?.memory;
    const capacity = {
      cpu: cpuSpec ? parseCpuMillis(cpuSpec) : 4000,
      memory: memSpec ? parseMemoryMi(memSpec) : 8192,
    };
    const pods = this.getByKind('Pod').filter(
      (pod) => pod.spec.nodeName === nodeName && (pod.status.phase === 'Running' || pod.status.phase === 'Pending')
    );
    let cpuUsed = 0;
    let memoryUsed = 0;
    for (const pod of pods) {
      for (const container of pod.spec.containers || []) {
        cpuUsed += parseCpuMillis(container.resources?.requests?.cpu || '0');
        memoryUsed += parseMemoryMi(container.resources?.requests?.memory || '0');
      }
    }
    return {
      cpu: { capacity: capacity.cpu, used: cpuUsed, available: capacity.cpu - cpuUsed },
      memory: { capacity: capacity.memory, used: memoryUsed, available: capacity.memory - memoryUsed },
      podCount: pods.length,
    };
  }

  /**
   * Cluster-wide stats consumed by the HUD, metrics dashboard and engine tick.
   * Keeps the legacy shape while adding OpenShift counters.
   * @returns {object}
   */
  getClusterStats() {
    const nodes = this.getByKind('Node');
    const pods = this.getByKind('Pod');
    const deployments = this.getByKind('Deployment');
    const services = this.getByKind('Service');
    const projects = this.getByKind('Project');
    const routes = this.getByKind('Route');
    const builds = this.getByKind('Build');
    const subscriptions = this.getByKind('Subscription');
    const clusterOperators = this.getByKind('ClusterOperator');

    let totalCpu = 0;
    let usedCpu = 0;
    let totalMemory = 0;
    let usedMemory = 0;
    for (const node of nodes) {
      const alloc = this.getNodeAllocatable(node.metadata.name);
      if (!alloc) continue;
      totalCpu += alloc.cpu.capacity;
      usedCpu += alloc.cpu.used;
      totalMemory += alloc.memory.capacity;
      usedMemory += alloc.memory.used;
    }

    const podPhases = { Pending: 0, Running: 0, Succeeded: 0, Failed: 0, Unknown: 0 };
    for (const pod of pods) {
      const phase = pod.status.phase || 'Unknown';
      podPhases[phase] = (podPhases[phase] || 0) + 1;
    }

    const admittedRoutes = routes.filter((route) => this.isRouteAdmitted(route)).length;
    const activeProjects = projects.filter((project) => project.status.phase !== 'Terminating').length;

    return {
      nodes: { total: nodes.length, ready: nodes.filter((node) => node.isConditionTrue('Ready')).length },
      pods: { total: pods.length, ...podPhases },
      deployments: { total: deployments.length, available: deployments.filter((deployment) => deployment.isConditionTrue('Available')).length },
      services: { total: services.length },
      namespaces: { total: projects.length },
      projects: { total: projects.length, active: activeProjects },
      routes: { total: routes.length, admitted: admittedRoutes },
      builds: {
        total: builds.length,
        running: builds.filter((build) => ['New', 'Pending', 'Running'].includes(build.status.phase)).length,
        complete: builds.filter((build) => build.status.phase === 'Complete').length,
        failed: builds.filter((build) => build.status.phase === 'Failed').length,
      },
      workloads: {
        deployments: deployments.length,
        statefulsets: this.getByKind('StatefulSet').length,
        daemonsets: this.getByKind('DaemonSet').length,
        jobs: this.getByKind('Job').length,
        cronjobs: this.getByKind('CronJob').length,
      },
      imageStreams: { total: this.getByKind('ImageStream').length },
      subscriptions: { total: subscriptions.length, installed: subscriptions.filter((sub) => sub.status.phase === 'Succeeded').length },
      clusterOperators: {
        total: clusterOperators.length,
        available: clusterOperators.filter((operator) => operator.isConditionTrue('Available')).length,
        degraded: clusterOperators.filter((operator) => operator.isConditionTrue('Degraded')).length,
      },
      resources: { total: this.resources.size },
      cpu: { total: totalCpu, used: usedCpu, percent: totalCpu > 0 ? Math.round((usedCpu / totalCpu) * 100) : 0 },
      memory: { total: totalMemory, used: usedMemory, percent: totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0 },
    };
  }

  getResourceGraph() {
    const nodes = [];
    const edges = [];
    for (const [uid, resource] of this.resources) {
      nodes.push({
        id: uid,
        kind: resource.kind,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace,
        phase: resource.status.phase,
      });
    }
    for (const [parentUid, childUids] of this.relationships) {
      for (const childUid of childUids) {
        if (this.resources.has(parentUid) && this.resources.has(childUid)) {
          edges.push({ source: parentUid, target: childUid });
        }
      }
    }
    return { nodes, edges };
  }

  snapshot() {
    const data = {};
    for (const [uid, resource] of this.resources) {
      data[uid] = resource.toJSON();
    }
    return {
      timestamp: Date.now(),
      resourceCount: this.resources.size,
      resources: data,
      // Project config singleton lives outside the resource maps (kind-name collision).
      projectConfig: this._projectConfig ? deepClone(this._projectConfig) : null,
    };
  }

  /** Reset the cluster to the default OpenShift state. */
  clear() {
    this.resources.clear();
    this._projectConfig = null;
    this.relationships.clear();
    this.reverseRelationships.clear();
    this.nameIndex.clear();
    this.labelIndex.clear();
    this.resourceQuotas.clear();
    this.limitRanges.clear();
    for (const [, set] of this.kindIndex) set.clear();
    for (const [, set] of this.namespaceIndex) set.clear();
    this._batchMode = false;
    this._batchedEvents = [];
    this._initDefaults();
    if (this.eventBus) this.eventBus.emit('cluster:reset', { timestamp: Date.now() });
  }

  getExpectedChildKinds(kind) {
    return OWNER_CHAINS[this._canonicalKind(kind)] || [];
  }

  getAllKinds() {
    return [...RESOURCE_KINDS];
  }

  /** Resolve a CLI kind token to its canonical game kind (Namespace → Project). */
  _canonicalKind(kind) {
    if (!kind) return null;
    const str = String(kind);
    if (str === 'Namespace' || str === 'namespace' || str === 'namespaces') return 'Project';
    const normalized = normalizeKind(str);
    if (normalized) return normalized;
    const canonical = str.charAt(0).toUpperCase() + str.slice(1);
    return RESOURCE_KINDS.includes(canonical) ? canonical : canonical;
  }

  // ── Universal resource creation / upsert ────────────────────────────────

  /**
   * Create (or upsert) a resource from a plain description object.
   *
   * This is the single creation path for the palette, command bar, modes,
   * controllers, ManifestEngine and draw page:
   *   - honours a supplied `metadata.uid` (draw page position persistence),
   *   - uses `kindRegistry.createResource()` so rich subclasses, apiVersions
   *     and default specs are applied consistently,
   *   - upserts by uid/name instead of downgrading an existing instance.
   *
   * @param {object|ResourceBase} obj
   * @param {{kind?: string, name?: string, namespace?: string, metadata?: object, spec?: object, status?: object}} [obj]
   * @returns {ResourceBase|null}
   */
  addResource(obj) {
    if (!obj) return null;
    if (obj instanceof ResourceBase) return this._addInstance(obj);

    const kind = this._canonicalKind(obj.kind || obj.type);
    if (!kind) return null;
    const rawMeta = obj.metadata || {};
    const name = obj.name || rawMeta.name || 'unnamed';
    const namespaced = !isClusterScopedKind(kind);
    const namespace = namespaced
      ? rawMeta.namespace || obj.namespace || obj.namespaceName || defaultNamespaceForKind(kind)
      : '';
    const suppliedUid = rawMeta.uid || obj.uid || null;

    if (namespace && this.isProjectTerminating(namespace)) {
      return null;
    }

    const existing = (suppliedUid && this.resources.get(suppliedUid)) || this.getByName(kind, name, namespace);
    if (existing) {
      this._mergeInto(existing, obj);
      return this.update(existing.uid, existing);
    }

    let resource;
    try {
      resource = createResource(kind, {
        name,
        namespace,
        labels: rawMeta.labels || obj.labels || {},
        annotations: rawMeta.annotations || obj.annotations || {},
        spec: {},
      });
    } catch (error) {
      console.warn(`ClusterState.addResource: failed to create ${kind} via registry, falling back:`, error);
      resource = new ResourceBase(kind, obj.apiVersion || 'v1', name, namespace);
    }
    if (!(resource instanceof ResourceBase)) {
      resource = new ResourceBase(kind, obj.apiVersion || 'v1', name, namespace);
    }
    if (obj.apiVersion && !RESOURCE_KINDS.includes(kind)) resource.apiVersion = obj.apiVersion;
    if (suppliedUid) resource.metadata.uid = String(suppliedUid);
    if (obj.spec && typeof obj.spec === 'object') {
      resource.spec = deepMerge(resource.spec || {}, obj.spec);
      // Nodes derive display capacity/allocatable from their spec; keep them in
      // sync when a mode/manifest merges capacity into an existing Node.
      if (typeof resource.syncCapacityFromSpec === 'function') resource.syncCapacityFromSpec();
    }
    if (rawMeta.labels) Object.assign(resource.metadata.labels, rawMeta.labels);
    if (rawMeta.annotations) Object.assign(resource.metadata.annotations, rawMeta.annotations);
    if (Array.isArray(rawMeta.finalizers)) resource.metadata.finalizers = [...rawMeta.finalizers];
    if (obj.status) this._applyStatus(resource, obj.status);

    return this.add(resource);
  }

  /** Handle `addResource(new ResourceBaseInstance)` without downgrading. */
  _addInstance(obj) {
    const existing = this.resources.get(obj.uid) || this.getByName(obj.kind, obj.metadata.name, obj.metadata.namespace);
    if (existing) {
      this._copyResourceState(existing, obj);
      return this.update(existing.uid, existing);
    }
    return this.add(obj);
  }

  /**
   * Merge a plain object description into an existing (possibly rich) resource.
   * @param {ResourceBase} target
   * @param {object} obj
   */
  _mergeInto(target, obj) {
    if (obj.apiVersion) target.apiVersion = obj.apiVersion;
    if (obj.spec && typeof obj.spec === 'object') {
      target.spec = deepMerge(target.spec || {}, obj.spec);
      target.metadata.generation++;
    }
    const rawMeta = obj.metadata || {};
    if (rawMeta.labels) Object.assign(target.metadata.labels, rawMeta.labels);
    if (rawMeta.annotations) Object.assign(target.metadata.annotations, rawMeta.annotations);
    if (Array.isArray(rawMeta.finalizers)) {
      for (const finalizer of rawMeta.finalizers) target.addFinalizer(finalizer);
    }
    if (obj.status) this._applyStatus(target, obj.status);
    target._bumpResourceVersion();
    return target;
  }

  /**
   * Replace the content of an existing resource with an incoming instance,
   * preserving the existing instance (and therefore its class) when possible.
   * @param {ResourceBase} target
   * @param {ResourceBase} incoming
   */
  _copyResourceState(target, incoming) {
    target.spec = deepClone(incoming.spec);
    target.status = deepClone(incoming.status);
    if (!Array.isArray(target.status.conditions)) target.status.conditions = [];
    target.apiVersion = incoming.apiVersion || target.apiVersion;
    Object.assign(target.metadata.labels, incoming.metadata.labels);
    Object.assign(target.metadata.annotations, incoming.metadata.annotations);
    target.metadata.generation++;
    target._bumpResourceVersion();
    return target;
  }

  /**
   * Remove a resource by kind/name/namespace.
   * @param {string} kind
   * @param {string} name
   * @param {string} [namespace]
   * @returns {ResourceBase|null}
   */
  removeResource(kind, name, namespace = 'default') {
    const resource = this.getByName(kind, name, namespace);
    return resource ? this.remove(resource.uid) : null;
  }

  // ── Projects ────────────────────────────────────────────────────────────

  /** @returns {object[]} all Project resources sorted by name */
  getProjects() {
    return this.getByKind('Project').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  /** @param {string} name @returns {object|null} */
  getProject(name) {
    return this.getByName('Project', name, '');
  }

  projectExists(name) {
    return !!this.getProject(name);
  }

  isProjectTerminating(name) {
    const project = this.getProject(name);
    return !!project && (project.status.phase === 'Terminating' || project.metadata.deletionTimestamp !== null);
  }

  /** Create a default service account in a project (idempotent). */
  ensureProjectDefaults(project) {
    if (!project || project.kind !== 'Project') return;
    const name = project.metadata.name;
    if (!this.getByName('ServiceAccount', 'default', name)) {
      this.addResource({
        kind: 'ServiceAccount',
        name: 'default',
        metadata: {
          name: 'default',
          namespace: name,
          annotations: { 'openshift.io/requester': project.metadata.annotations?.['openshift.io/requester'] || 'kubeadmin' },
        },
        spec: {},
      });
    }
  }

  // ── Project config singleton (config.openshift.io/v1 Project "cluster") ──

  /** Seed the `project.config.openshift.io/cluster` singleton (fresh 4.22: empty spec). */
  _seedProjectConfig() {
    this._projectConfig = {
      apiVersion: 'config.openshift.io/v1',
      kind: 'Project',
      metadata: {
        name: 'cluster',
        uid: 'seed-project-config',
        creationTimestamp: new Date().toISOString(),
        resourceVersion: '1',
        generation: 1,
      },
      spec: {},
    };
    return this._projectConfig;
  }

  /**
   * The cluster-scoped project configuration (`oc get project.config.openshift.io/cluster`).
   * Not registered in the normal resource indexes because its kind name collides
   * with the project.openshift.io Project game kind.
   * @returns {object|null}
   */
  getProjectConfig() {
    return this._projectConfig || null;
  }

  /**
   * Merge a patch into the project config `spec` (the `oc edit`/`oc patch`
   * path for `spec.projectRequestTemplate.name`). Bumps resourceVersion and
   * generation and emits `cluster:modified:ProjectConfig`.
   * @param {object} [specPatch]
   * @returns {object} the updated singleton
   */
  updateProjectConfig(specPatch = {}) {
    if (!this._projectConfig) this._seedProjectConfig();
    const config = this._projectConfig;
    config.spec = deepMerge(config.spec || {}, specPatch || {});
    const resourceVersion = parseInt(config.metadata.resourceVersion || '1', 10) || 1;
    config.metadata.resourceVersion = String(resourceVersion + 1);
    config.metadata.generation = (config.metadata.generation || 1) + 1;
    this.eventBus?.emit('cluster:modified:ProjectConfig', {
      kind: 'Project',
      name: 'cluster',
      namespace: '',
      resource: config,
    });
    return config;
  }

  /**
   * Process a project-request Template: resolve `${PARAM}`/`${{PARAM}}`
   * substitutions in every string of its objects using the template parameter
   * defaults overridden by `params`.
   * @param {object} template Template resource (flat `.spec` model)
   * @param {Record<string, string|undefined>} params
   * @returns {{objects: object[], project: object|null, values: Record<string, string>}}
   */
  _processProjectTemplate(template, params = {}) {
    const values = {};
    for (const parameter of template?.spec?.parameters || []) {
      if (!parameter?.name) continue;
      values[parameter.name] = parameter.value !== undefined ? parameter.value : parameter.generate ?? '';
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      values[key] = String(value);
    }
    const substitute = (value) => {
      if (typeof value === 'string') {
        return value.replace(/\$\{\{?([A-Za-z_][A-Za-z0-9_]*)\}?\}/g, (match, key) =>
          Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
        );
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry);
        return out;
      }
      return value;
    };
    const objects = (template?.spec?.objects || []).map((object) => substitute(deepClone(object)));
    return {
      objects: objects.filter((object) => object?.kind !== 'Project'),
      project: objects.find((object) => object?.kind === 'Project') || null,
      values,
    };
  }

  /**
   * Create one non-Project object from a project-request Template inside the
   * new project (namespaced objects only, namespace forced to the project).
   * Objects are normalised first so flat API kinds (RoleBinding roleRef/subjects,
   * ConfigMap data, Secret data, ...) are lifted into the game's `.spec` model.
   * @param {object} object
   * @param {string} namespace
   * @returns {object|null}
   */
  _createProjectTemplateObject(object, namespace) {
    if (!object || !object.kind || object.kind === 'Project') return null;
    const normalized = normalizeManifestObject(object);
    const canonical = this._canonicalKind(normalized.kind);
    if (!canonical || !RESOURCE_KINDS.includes(canonical)) return null;
    if (isClusterScopedKind(canonical)) return null;
    if (!normalized.name) return null;
    // The requester's admin RoleBinding is always created above; the bootstrap
    // project template also carries one, so skip its duplicate.
    if (canonical === 'RoleBinding' && normalized.name === 'admin') return null;
    const created = this.addResource({
      kind: canonical,
      apiVersion: normalized.apiVersion || undefined,
      metadata: {
        name: normalized.name,
        namespace,
        labels: normalized.labels,
        annotations: normalized.annotations,
      },
      spec: normalized.spec,
    });
    // Template objects are applied manifests: keep the exact spec from the
    // template (addResource() would otherwise merge the game's class defaults
    // into them, e.g. a NetworkPolicy podSelector, which the API never defaults).
    if (created && normalized.spec && typeof normalized.spec === 'object') {
      created.spec = deepClone(normalized.spec);
    }
    return created;
  }

  /**
   * Create an OpenShift Project the way an API-server project request does:
   *   - always create the requester's `admin` RoleBinding in the new project
   *     (the real project request assigns the requesting user the admin role),
   *   - when `project.config.openshift.io/cluster` sets
   *     `spec.projectRequestTemplate.name`, instantiate that Template from
   *     `openshift-config` with the standard PROJECT_* parameters; a missing
   *     template fails the request and no project is created,
   *   - create the template's non-Project objects in the new project namespace
   *     (e.g. NetworkPolicy / ResourceQuota / LimitRange),
   *   - use the template Project object's labels/annotations when present.
   *
   * @param {string} name
   * @param {{displayName?: string, description?: string, labels?: object,
   *   annotations?: object, requester?: string}} [options]
   * @returns {{success: boolean, project?: object, message?: string,
   *   error?: boolean, createdObjects?: object[]}}
   */
  createProject(name, options = {}) {
    if (!isValidProjectName(name)) {
      return { success: false, error: true, message: `error: Invalid project name "${name}": must be a lowercase DNS-1123 label` };
    }
    if (this.getProject(name)) {
      return { success: false, error: true, message: `Error from server (AlreadyExists): project.project.openshift.io "${name}" already exists` };
    }
    const requester = String(options.requester || 'kubeadmin');
    const templateName = this.getProjectConfig()?.spec?.projectRequestTemplate?.name || '';
    let templateProject = null;
    let templateObjects = [];
    if (templateName) {
      const template = this.getByName('Template', templateName, 'openshift-config');
      if (!template) {
        return {
          success: false,
          error: true,
          message: `Error from server (NotFound): templates.template.openshift.io "${templateName}" not found in project "openshift-config"`,
        };
      }
      const processed = this._processProjectTemplate(template, {
        PROJECT_NAME: name,
        PROJECT_DISPLAYNAME: options.displayName,
        PROJECT_DESCRIPTION: options.description,
        PROJECT_ADMIN_USER: requester,
        PROJECT_REQUESTING_USER: requester,
      });
      templateProject = processed.project;
      templateObjects = processed.objects;
    }
    const projectAnnotations = {
      'openshift.io/display-name': options.displayName || name,
      'openshift.io/requester': requester,
      ...(options.annotations || {}),
      ...(templateProject?.metadata?.annotations || {}),
    };
    const displayName = projectAnnotations['openshift.io/display-name'] || options.displayName || name;
    const project = this.addResource({
      kind: 'Project',
      metadata: {
        name,
        labels: {
          'kubernetes.io/metadata.name': name,
          ...(options.labels || {}),
          ...(templateProject?.metadata?.labels || {}),
        },
        annotations: projectAnnotations,
      },
      spec: { displayName, description: options.description || '' },
      status: { phase: 'Active' },
    });
    project.setPhase('Active');
    // Real project requests bind the requesting user to the admin ClusterRole
    // in the new project (name "admin", roleRef admin, subject the requester).
    this.addResource({
      kind: 'RoleBinding',
      metadata: { name: 'admin', namespace: name },
      spec: {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
        subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: requester }],
      },
    });
    const createdObjects = [];
    for (const object of templateObjects) {
      const created = this._createProjectTemplateObject(object, name);
      if (created) createdObjects.push(created);
    }
    this.eventBus?.emit('project:created', {
      name,
      namespace: name,
      resource: project,
      displayName,
      requester,
    });
    return {
      success: true,
      project,
      createdObjects,
      message: `project.project.openshift.io/${name}`,
    };
  }

  /**
   * Mark a project for asynchronous deletion (the project controller finishes
   * the cleanup and removes the Project after a short grace period).
   * @param {string} name
   * @returns {{success: boolean, project?: object, message?: string, error?: boolean}}
   */
  deleteProject(name) {
    const project = this.getProject(name);
    if (!project) {
      return { success: false, error: true, message: `Error from server (NotFound): project.project.openshift.io "${name}" not found` };
    }
    project.setPhase('Terminating');
    project.setAnnotation('openshiftgames/terminate-at', String(Date.now() + 2000));
    project.markForDeletion();
    this.eventBus?.emit('project:terminating', { name, namespace: name, resource: project });
    return { success: true, project, message: `project.project.openshift.io "${name}" deleted` };
  }

  /**
   * Immediately delete all resources in a project and then the Project itself.
   * @param {string} name
   * @returns {boolean} whether the project was removed
   */
  purgeProject(name) {
    const project = this.getProject(name);
    if (!project) return false;
    for (const resource of this.getByNamespace(name)) {
      if (resource.uid === project.uid) continue;
      this.remove(resource.uid);
    }
    this.remove(project.uid);
    this.eventBus?.emit('project:deleted', { name, namespace: name });
    return true;
  }

  // ── Identity (users, groups, identities) ────────────────────────────────

  /** @param {string} name @returns {object|null} */
  getUser(name) {
    return this.getByName('User', name, '');
  }

  /** @param {string} name @returns {object|null} */
  getGroup(name) {
    return this.getByName('Group', name, '');
  }

  /** @param {string} name @returns {object|null} */
  getIdentity(name) {
    return this.getByName('Identity', name, '');
  }

  /** All identities whose user.name matches. */
  getIdentitiesForUser(userName) {
    return this.getByKind('Identity').filter((identity) => identity.spec?.user?.name === userName);
  }

  /**
   * Group membership for a user (explicit `spec.groups` + Group resources).
   * @param {string|object} user user name or User resource
   * @returns {string[]}
   */
  getUserGroups(user) {
    const userName = typeof user === 'string' ? user : user?.metadata?.name;
    if (!userName) return [];
    const groups = new Set();
    const userResource = typeof user === 'object' ? user : this.getUser(userName);
    for (const group of userResource?.spec?.groups || []) groups.add(group);
    for (const group of this.getByKind('Group')) {
      if ((group.spec?.users || []).includes(userName)) groups.add(group.metadata.name);
    }
    return Array.from(groups).sort();
  }

  /**
   * Create a User resource.
   * @param {string} name
   * @param {{fullName?: string, groups?: string[], identities?: object[]}} [options]
   * @returns {object}
   */
  createUser(name, options = {}) {
    const existing = this.getUser(name);
    if (existing) return existing;
    const user = this.addResource({
      kind: 'User',
      metadata: { name, labels: { 'kubernetes.io/metadata.name': name } },
      spec: {
        fullName: options.fullName || '',
        groups: options.groups || ['system:authenticated'],
        identities: options.identities || [],
      },
      status: {},
    });
    this.eventBus?.emit('user:created', { name, user });
    return user;
  }

  /**
   * Create an Identity for a provider login and link it to a User.
   * @param {string} providerName e.g. "htpasswd"
   * @param {string} providerUserName e.g. "alice"
   * @param {string} userName OpenShift User name
   * @returns {object}
   */
  createIdentity(providerName, providerUserName, userName) {
    const identityName = `${providerName}:${providerUserName}`;
    let identity = this.getIdentity(identityName);
    if (!identity) {
      identity = this.addResource({
        kind: 'Identity',
        metadata: { name: identityName },
        spec: { providerName, providerUserName, user: { name: userName } },
        status: {},
      });
    } else {
      identity.spec.user = { name: userName };
      this.update(identity.uid, identity);
    }
    const user = this.getUser(userName);
    if (user) {
      user.spec.identities = user.spec.identities || [];
      if (!user.spec.identities.some((entry) => entry.providerName === providerName && entry.providerUserName === providerUserName)) {
        user.spec.identities.push({ providerName, providerUserName });
        this.update(user.uid, user);
      }
    }
    return identity;
  }

  /**
   * Delete a User resource (`oc delete user <name>`).
   *
   * Real OpenShift 4.x semantics (issue #12): deleting a User does NOT delete
   * its Identity (`oc delete identity` is a separate operation), and it does
   * not rewrite Group membership, RBAC bindings or SCC lists. A subsequent
   * OAuth login recreates the User and re-links the existing Identity.
   * @param {string} name
   * @returns {boolean} whether the user existed
   */
  deleteUser(name) {
    const user = this.getUser(name);
    if (!user) return false;
    this.remove(user.uid);
    this.eventBus?.emit('user:deleted', { name });
    return true;
  }

  /**
   * Delete an Identity resource (`oc delete identity <provider>:<user>`).
   * @param {string} name
   * @returns {boolean} whether the identity existed
   */
  deleteIdentity(name) {
    const identity = this.getIdentity(name);
    if (!identity) return false;
    this.remove(identity.uid);
    this.eventBus?.emit('identity:deleted', { name });
    return true;
  }

  /**
   * Create a Group.
   * @param {string} name
   * @param {string[]} [users]
   * @returns {object}
   */
  createGroup(name, users = []) {
    const existing = this.getGroup(name);
    if (existing) {
      if (users.length > 0) this.addUserToGroup(name, users);
      return existing;
    }
    const group = this.addResource({
      kind: 'Group',
      metadata: { name, labels: { 'kubernetes.io/metadata.name': name } },
      spec: { users: [] },
      status: {},
    });
    if (users.length > 0) this.addUserToGroup(name, users);
    this.eventBus?.emit('group:created', { name, group });
    return group;
  }

  /**
   * Add users to a group (creating users/groups when needed).
   * @param {string} groupName
   * @param {string|string[]} users
   * @returns {{group: object, added: string[]}}
   */
  addUserToGroup(groupName, users) {
    const list = Array.isArray(users) ? users : [users];
    const group = this.createGroup(groupName);
    const added = [];
    for (const userName of list) {
      if (!userName) continue;
      group.spec.users = group.spec.users || [];
      if (!group.spec.users.includes(userName)) {
        group.spec.users.push(userName);
        added.push(userName);
      }
      const user = this.createUser(userName);
      user.spec.groups = user.spec.groups || ['system:authenticated'];
      if (!user.spec.groups.includes(groupName)) {
        user.spec.groups.push(groupName);
        this.update(user.uid, user);
      }
    }
    if (added.length > 0) this.update(group.uid, group);
    return { group, added };
  }

  /**
   * Remove users from a group.
   * @param {string} groupName
   * @param {string|string[]} users
   * @returns {{group: object|null, removed: string[]}}
   */
  removeUserFromGroup(groupName, users) {
    const list = Array.isArray(users) ? users : [users];
    const group = this.getGroup(groupName);
    if (!group) return { group: null, removed: [] };
    const removed = [];
    for (const userName of list) {
      const before = (group.spec.users || []).length;
      group.spec.users = (group.spec.users || []).filter((entry) => entry !== userName);
      if (group.spec.users.length !== before) removed.push(userName);
      const user = this.getUser(userName);
      if (user) {
        user.spec.groups = (user.spec.groups || []).filter((entry) => entry !== groupName);
        this.update(user.uid, user);
      }
    }
    if (removed.length > 0) this.update(group.uid, group);
    return { group, removed };
  }

  // ── RBAC / SCC ──────────────────────────────────────────────────────────

  /**
   * Evaluate `oc auth can-i`.
   * @param {string} userName
   * @param {string} verb
   * @param {string} resource
   * @param {string} [namespace] defaults to "default" for namespaced resources
   * @returns {{allowed: boolean, reason: string, role?: string, binding?: string}}
   */
  canI(userName, verb, resource, namespace) {
    return rbacCanI(this, userName, verb, resource, namespace);
  }

  /**
   * Permission list for `oc auth can-i --list`.
   * @param {string} userName
   * @param {string} [namespace]
   * @returns {Array<object>}
   */
  listPermissions(userName, namespace = 'default') {
    return rbacListPermissions(this, userName, namespace);
  }

  /** `oc adm policy who-can <verb> <resource>` */
  whoCan(verb, resource, namespace = 'default') {
    return rbacWhoCan(this, verb, resource, namespace);
  }

  /** Resolve role rules for a roleRef (built-in fallbacks included). */
  getRoleRules(roleRef, namespace = 'default') {
    return getRoleRules(this, roleRef, namespace);
  }

  /** @param {string} name @returns {object|null} */
  getSCC(name) {
    return this.getByName('SecurityContextConstraints', name, '');
  }

  /** @returns {object[]} SCCs sorted by admission precedence */
  getSCCs() {
    return rbacGetSCCs(this);
  }

  /** SCCs usable by a service account, sorted by precedence. */
  getSCCsForServiceAccount(namespace, serviceAccount = 'default') {
    return rbacGetSCCsForServiceAccount(this, namespace, serviceAccount);
  }

  /**
   * SCCs usable by an arbitrary subject (user, group, SA identity or
   * `{kind,name,namespace}`). Binding-aware 4.x model.
   * @param {string|object} subject
   * @param {string} [namespace]
   * @returns {object[]}
   */
  getSCCsForSubject(subject, namespace = '') {
    return rbacGetSCCsForSubject(this, subject, namespace);
  }

  /**
   * Names of the SCCs granted to a subject through the 4.x RBAC binding model
   * (plus seeded legacy SCC lists). Convenience for objective/incident repair
   * detection.
   * @param {string|object} subject
   * @param {string} [namespace]
   * @returns {string[]}
   */
  getSCCGrantsForSubject(subject, namespace = '') {
    return rbacGetSCCGrantsForSubject(this, subject, namespace);
  }

  /**
   * Subjects granted an SCC through the OpenShift 4.x RBAC binding model, in
   * the canonical identity spelling used by SCC lists:
   * `system:serviceaccount:<ns>:<sa>` for service accounts, the user name for
   * users and `group:<name>` for groups.
   *
   * Example: after `oc adm policy add-scc-to-user anyuid -z default -n demo`,
   * `cluster.getSCCGrantSubjects('anyuid')` includes
   * `system:serviceaccount:demo:default`.
   *
   * @param {string} sccName
   * @returns {string[]} sorted subject identities
   */
  getSCCGrantSubjects(sccName) {
    const roleName = `system:openshift:scc:${sccName}`;
    const identities = new Set();
    /** @param {object} binding @param {string} bindingNamespace */
    const collect = (binding, bindingNamespace) => {
      if (!binding || !this._bindingHasRoleRef(binding, roleName)) return;
      for (const subject of binding.spec?.subjects || []) {
        if (!subject?.kind || !subject?.name) continue;
        if (subject.kind === 'ServiceAccount') {
          const namespace = subject.namespace || bindingNamespace || '';
          identities.add(`system:serviceaccount:${namespace}:${subject.name}`);
        } else if (subject.kind === 'Group') {
          identities.add(`group:${subject.name}`);
        } else {
          identities.add(subject.name);
        }
      }
    };
    for (const crb of this.getByKind('ClusterRoleBinding')) collect(crb, '');
    for (const rb of this.getByKind('RoleBinding')) collect(rb, rb.metadata?.namespace || '');
    return [...identities].sort();
  }

  /**
   * Highest-precedence SCC bound to a service account.
   * @param {string} namespace
   * @param {string} [serviceAccount]
   * @returns {object|null}
   */
  sccForServiceAccount(namespace, serviceAccount = 'default') {
    return rbacSccForServiceAccount(this, namespace, serviceAccount);
  }

  /**
   * Resolve which SCC would admit a Pod.
   * @param {object} pod
   * @returns {{allowed: boolean, scc: object|null, candidates: object[], reason?: string}}
   */
  resolveSCCForPod(pod) {
    return rbacResolveSCCForPod(this, pod);
  }

  /** Would the SCC allow the given pod spec? */
  sccAllowsPod(scc, podSpec) {
    return rbacSccAllowsPod(scc, podSpec);
  }

  /**
   * Grant an SCC to a subject with OpenShift 4.x semantics
   * (`oc adm policy add-scc-to-user/-group/-serviceaccount`).
   *
   * Real 4.x model:
   *  - users/groups → ClusterRoleBinding named `system:openshift:scc:<scc>`
   *    whose roleRef is ClusterRole `system:openshift:scc:<scc>`
   *    (`use` on that one securitycontextconstraints resource),
   *  - service accounts (`-z <sa> -n <project>`) → RoleBinding named
   *    `system:openshift:scc:<scc>` in the SA's project with the same
   *    ClusterRole roleRef.
   *
   * The SCC object's legacy `spec.users`/`spec.groups` lists are NEVER mutated
   * by grants (that is the OCP 3.x model; issue #13).
   *
   * @param {string} sccName
   * @param {string|object} subject user, group, SA identity or {kind,name,namespace}
   * @param {{kind?: string, namespace?: string, actor?: string}} [options]
   * @returns {{success: boolean, scc?: object, subject?: object, binding?: object, message?: string}}
   */
  grantSCC(sccName, subject, options = {}) {
    const scc = this.getSCC(sccName);
    if (!scc) {
      return { success: false, message: `Error from server (NotFound): securitycontextconstraints.security.openshift.io "${sccName}" not found` };
    }
    const parsed = normalizeSCCSubject(subject, options);
    if (!parsed.name) return { success: false, message: 'error: you must specify a subject' };
    const roleName = `system:openshift:scc:${sccName}`;
    this._ensureSCCClusterRole(sccName);
    const { bindingKind, bindingNamespace, subjectEntry } = this._sccGrantBindingTarget(parsed, options.namespace);
    const existing = this.getByName(bindingKind, roleName, bindingNamespace);
    let binding = existing;
    let changed = false;
    if (!existing) {
      binding = this.addResource({
        kind: bindingKind,
        metadata: { name: roleName, namespace: bindingNamespace },
        spec: {
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roleName },
          subjects: [subjectEntry],
        },
      });
      changed = Boolean(binding);
    } else {
      existing.spec = existing.spec || {};
      existing.spec.subjects = existing.spec.subjects || [];
      if (!existing.spec.subjects.some((entry) => this._sameRBACSubject(entry, subjectEntry))) {
        existing.spec.subjects.push(subjectEntry);
        this.update(existing.uid, existing);
        changed = true;
      }
      binding = existing;
    }
    if (!changed) {
      return { success: true, scc, subject: parsed, binding };
    }
    this.eventBus?.emit('scc:granted', {
      scc: scc.metadata.name,
      subject: parsed.subject,
      kind: parsed.kind,
      name: parsed.name,
      namespace: parsed.namespace,
      role: roleName,
      binding: binding?.metadata?.name || roleName,
      bindingKind,
      actor: options.actor || 'kubeadmin',
      resource: scc,
    });
    return { success: true, scc, subject: parsed, binding };
  }

  /**
   * Revoke an SCC from a subject (removes it from the 4.x RBAC bindings).
   * The SCC object's legacy users/groups lists are left untouched.
   * @param {string} sccName
   * @param {string|object} subject
   * @param {{kind?: string, namespace?: string, actor?: string}} [options]
   * @returns {{success: boolean, scc?: object, subject?: object, message?: string}}
   */
  revokeSCC(sccName, subject, options = {}) {
    const scc = this.getSCC(sccName);
    if (!scc) {
      return { success: false, message: `Error from server (NotFound): securitycontextconstraints.security.openshift.io "${sccName}" not found` };
    }
    const parsed = normalizeSCCSubject(subject, options);
    if (!parsed.name) return { success: false, message: 'error: you must specify a subject' };
    const roleName = `system:openshift:scc:${sccName}`;
    /** @type {Set<string>} */
    const removedFrom = new Set();

    const removeFromBinding = (binding, bindingNamespace) => {
      if (!binding || !this._bindingHasRoleRef(binding, roleName)) return;
      const subjects = binding.spec?.subjects || [];
      const next = subjects.filter((entry) => !this._subjectMatchesSCCGrant(entry, parsed, bindingNamespace, options.namespace));
      if (next.length !== subjects.length) {
        binding.spec.subjects = next;
        this.update(binding.uid, binding);
        removedFrom.add(`${binding.kind}/${binding.metadata?.namespace || ''}/${binding.metadata?.name || ''}`);
      }
    };

    // Cluster-wide grants live on the ClusterRoleBinding.
    const crb = this.getByName('ClusterRoleBinding', roleName, '');
    removeFromBinding(crb, '');
    // `-z <sa>` grants live on RoleBindings named after the ClusterRole in the
    // subject's project (scan every project so removal works without -n too).
    for (const rb of this.getByKind('RoleBinding')) {
      if ((rb.metadata?.name || '') !== roleName) continue;
      if (parsed.kind === 'ServiceAccount' && parsed.namespace && rb.metadata?.namespace !== parsed.namespace) continue;
      removeFromBinding(rb, rb.metadata?.namespace || '');
    }

    if (removedFrom.size > 0) {
      this.eventBus?.emit('scc:revoked', {
        scc: scc.metadata.name,
        subject: parsed.subject,
        kind: parsed.kind,
        name: parsed.name,
        namespace: parsed.namespace,
        role: roleName,
        actor: options.actor || 'kubeadmin',
        resource: scc,
      });
    }
    return { success: true, scc, subject: parsed, removed: [...removedFrom] };
  }

  /**
   * Ensure the OCP 4.x ClusterRole `system:openshift:scc:<name>` exists.
   * Real 4.22 clusters ship these ClusterRoles for the default SCCs; the game
   * creates them lazily on first grant so the seeded resource count stays
   * faithful to a fresh cluster.
   * @param {string} sccName
   * @returns {object}
   */
  _ensureSCCClusterRole(sccName) {
    const roleName = `system:openshift:scc:${sccName}`;
    const existing = this.getByName('ClusterRole', roleName, '');
    if (existing) return existing;
    return this.addResource({
      kind: 'ClusterRole',
      metadata: { name: roleName },
      spec: {
        rules: [{
          apiGroups: ['security.openshift.io'],
          resources: ['securitycontextconstraints'],
          resourceNames: [sccName],
          verbs: ['use'],
        }],
      },
    });
  }

  /**
   * Resolve the binding kind/namespace and the RBAC subject entry for an SCC
   * grant (users/groups → ClusterRoleBinding, service accounts → namespaced
   * RoleBinding).
   * @param {{kind: string, name: string, namespace: string}} parsed
   * @param {string} [namespaceHint]
   * @returns {{bindingKind: 'ClusterRoleBinding'|'RoleBinding', bindingNamespace: string, subjectEntry: object}}
   */
  _sccGrantBindingTarget(parsed, namespaceHint = '') {
    if (parsed.kind === 'ServiceAccount') {
      const namespace = parsed.namespace || namespaceHint || 'default';
      return {
        bindingKind: 'RoleBinding',
        bindingNamespace: namespace,
        subjectEntry: { apiGroup: '', kind: 'ServiceAccount', name: parsed.name, namespace },
      };
    }
    if (parsed.kind === 'Group') {
      return {
        bindingKind: 'ClusterRoleBinding',
        bindingNamespace: '',
        subjectEntry: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: parsed.name },
      };
    }
    return {
      bindingKind: 'ClusterRoleBinding',
      bindingNamespace: '',
      subjectEntry: { apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: parsed.name },
    };
  }

  /** @param {object} binding @param {string} roleName @returns {boolean} */
  _bindingHasRoleRef(binding, roleName) {
    return (binding?.spec?.roleRef?.name || '') === roleName;
  }

  /**
   * Does an existing RBAC subject entry refer to the parsed SCC grant subject?
   * @param {object} entry
   * @param {{kind: string, name: string, namespace: string}} parsed
   * @param {string} bindingNamespace
   * @param {string} [optionNamespace]
   * @returns {boolean}
   */
  _subjectMatchesSCCGrant(entry, parsed, bindingNamespace = '', optionNamespace = '') {
    if (!entry || entry.kind !== parsed.kind || entry.name !== parsed.name) return false;
    if (parsed.kind !== 'ServiceAccount') return true;
    const targetNamespace = entry.namespace || bindingNamespace || parsed.namespace || optionNamespace || '';
    return targetNamespace === '' || targetNamespace === parsed.namespace;
  }

  /** @param {object} left @param {object} right @returns {boolean} */
  _sameRBACSubject(left, right) {
    return Boolean(left && right)
      && left.kind === right.kind
      && left.name === right.name
      && (left.namespace || '') === (right.namespace || '');
  }

  // ── OAuth / identity providers ──────────────────────────────────────────

  /** @returns {object|null} the OAuth singleton */
  getOAuth() {
    return this.getByName('OAuth', 'cluster', '');
  }

  /**
   * Configured HTPasswd identity provider summary (from the OAuth singleton).
   * @returns {{type: string, name: string, secretName: string, namespace: string}|null}
   */
  getAuthProviderConfig() {
    const oauth = this.getOAuth();
    const providers = oauth?.spec?.identityProviders || [];
    const htpasswd = providers.find((provider) => provider.type === 'HTPasswd');
    if (!htpasswd) return null;
    return {
      type: 'HTPasswd',
      name: htpasswd.name || 'htpasswd',
      secretName: htpasswd.htpasswd?.fileData?.name || htpasswd.htpasswd?.secret?.name || 'htpasswd-secret',
      namespace: 'openshift-config',
    };
  }

  // ── ImageStreams / builds ───────────────────────────────────────────────

  /** @param {string} namespace @param {string} name @returns {object|null} */
  getImageStream(namespace, name) {
    return this.getByName('ImageStream', name, namespace);
  }

  /**
   * Resolve an `ImageStreamTag` reference.
   * @param {string} namespace
   * @param {string} imageStreamName
   * @param {string} [tag]
   * @returns {{found: boolean, imageStream: object|null, tag: string, dockerImageReference: string}}
   */
  resolveImageStreamTag(namespace, imageStreamName, tag = 'latest') {
    const imageStream = this.getImageStream(namespace, imageStreamName);
    const dockerImageReference = `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStreamName}:${tag}`;
    if (!imageStream) return { found: false, imageStream: null, tag, dockerImageReference };
    const tagEntry = (imageStream.status?.tags || []).find((entry) => entry.tag === tag);
    const resolved = tagEntry?.items?.[0]?.dockerImageReference || dockerImageReference;
    return { found: true, imageStream, tag, dockerImageReference: resolved, tagEntry };
  }

  /**
   * Create/update an ImageStreamTag (used by builds, `oc tag`, `oc import-image`).
   * @param {string} namespace
   * @param {string} imageStreamName
   * @param {string} tag
   * @param {{dockerImageReference?: string, image?: string, isExternal?: boolean, silent?: boolean}} [options]
   * @returns {{imageStream: object, tagEntry: object}}
   */
  updateImageStreamTag(namespace, imageStreamName, tag, options = {}) {
    let imageStream = this.getImageStream(namespace, imageStreamName);
    if (!imageStream) {
      imageStream = this.addResource({
        kind: 'ImageStream',
        metadata: { name: imageStreamName, namespace, labels: { app: imageStreamName } },
        spec: { lookupPolicy: { local: false }, tags: [] },
        status: { tags: [] },
      });
    }
    const internalRef = `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStreamName}:${tag}`;
    const dockerImageReference = options.dockerImageReference || internalRef;
    const image = options.image || `sha256:${this._fakeDigest(`${namespace}/${imageStreamName}:${tag}`)}`;

    imageStream.spec.tags = imageStream.spec.tags || [];
    if (!imageStream.spec.tags.some((entry) => entry.name === tag)) {
      imageStream.spec.tags.push({
        name: tag,
        from: { kind: options.isExternal ? 'DockerImage' : 'ImageStreamTag', name: dockerImageReference },
        generation: 1,
        importPolicy: { insecure: false },
      });
    }

    imageStream.status = imageStream.status || {};
    imageStream.status.dockerImageRepository = imageStream.status.dockerImageRepository || `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStreamName}`;
    imageStream.status.tags = imageStream.status.tags || [];
    let tagEntry = imageStream.status.tags.find((entry) => entry.tag === tag);
    if (!tagEntry) {
      tagEntry = { tag, items: [] };
      imageStream.status.tags.push(tagEntry);
    }
    const previous = tagEntry.items?.[0]?.dockerImageReference;
    tagEntry.items = [{ dockerImageReference, image, generation: 1, created: new Date().toISOString() }];
    tagEntry.updated = new Date().toISOString();
    this.update(imageStream.uid, imageStream);

    if (!options.silent && previous !== dockerImageReference) {
      this.eventBus?.emit('imagestream:updated', {
        imageStream: imageStream.metadata.name,
        namespace,
        tag,
        dockerImageReference,
        resource: imageStream,
      });
    }
    return { imageStream, tagEntry };
  }

  /** Deterministic fake sha256 digest for a string (no crypto dependency). */
  _fakeDigest(seed) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const chunk = hash.toString(16).padStart(8, '0');
    return `${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}`;
  }

  /** @returns {object|null} */
  getBuildConfig(namespace, name) {
    return this.getByName('BuildConfig', name, namespace);
  }

  /** Active (not finished) Build for a BuildConfig. */
  getActiveBuildFor(buildConfig) {
    return this.getChildren(buildConfig.uid).find(
      (child) => child.kind === 'Build' && ['New', 'Pending', 'Running'].includes(child.status.phase)
    ) || null;
  }

  /** Builds owned by a BuildConfig, newest first. */
  getBuildsForConfig(buildConfig) {
    return this.getChildren(buildConfig.uid)
      .filter((child) => child.kind === 'Build')
      .sort((a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp));
  }

  /**
   * Create and register a Build for a BuildConfig (the BuildConfig controller
   * calls this on ConfigChange triggers; `oc start-build` calls it directly).
   * @param {object} buildConfig
   * @param {{reason?: string, actor?: string, force?: boolean}} [options]
   * @returns {{success: boolean, build?: object, message?: string}}
   */
  startBuildFor(buildConfig, options = {}) {
    if (!buildConfig) return { success: false, message: 'BuildConfig not found' };
    const active = this.getActiveBuildFor(buildConfig);
    if (active && buildConfig.spec?.runPolicy === 'Serial') {
      return { success: false, message: `cannot start build: Build "${active.metadata.name}" is already running for BuildConfig "${buildConfig.metadata.name}"` };
    }
    const version = (buildConfig.status?.lastVersion || 0) + 1;
    const buildName = `${buildConfig.metadata.name}-${version}`;
    const build = createResource('Build', {
      name: buildName,
      namespace: buildConfig.metadata.namespace,
      labels: {
        buildconfig: buildConfig.metadata.name,
        'buildconfig.openshift.io/name': buildConfig.metadata.name,
        'openshift.io/build-config.name': buildConfig.metadata.name,
      },
      annotations: {
        'openshift.io/build.number': String(version),
        'openshift.io/build-config.name': buildConfig.metadata.name,
      },
      spec: {
        source: deepClone(buildConfig.spec.source || {}),
        strategy: deepClone(buildConfig.spec.strategy || {}),
        output: deepClone(buildConfig.spec.output || {}),
        serviceAccount: buildConfig.spec.serviceAccount || 'builder',
        runPolicy: buildConfig.spec.runPolicy || 'Serial',
      },
    });
    build.status = {
      ...(build.status || {}),
      phase: 'New',
      startTime: new Date().toISOString(),
      conditions: [],
      output: {},
      message: '',
    };
    this.add(build);
    this.addRelationship(buildConfig.uid, build.uid);
    buildConfig.status = buildConfig.status || {};
    buildConfig.status.lastVersion = version;
    buildConfig.status.lastBuild = buildName;
    buildConfig.status.observedGeneration = buildConfig.metadata.generation;
    this.update(buildConfig.uid, buildConfig);
    this.eventBus?.emit('build:started', {
      build: buildName,
      buildConfig: buildConfig.metadata.name,
      namespace: buildConfig.metadata.namespace,
      version,
      reason: options.reason || (options.actor ? 'Manual' : 'ConfigChange'),
      resource: build,
    });
    return { success: true, build, message: `build.build.openshift.io/${buildName} started` };
  }

  // ── Routes / networking ─────────────────────────────────────────────────

  /** Default router hostname for a route: `<route>-<project>.apps.cluster.example.com`. */
  defaultRouteHost(routeName, namespace) {
    return `${routeName}-${namespace}.${APPS_DOMAIN}`;
  }

  /** Effective host for a Route (explicit spec.host or generated default). */
  getRouteHost(route) {
    return route.spec?.host || this.defaultRouteHost(route.metadata.name, route.metadata.namespace);
  }

  /** @returns {object|null} the target Service of a Route */
  getRouteService(route) {
    const to = route.spec?.to || {};
    if (to.kind && to.kind !== 'Service') return null;
    return this.getByName('Service', to.name, route.metadata.namespace);
  }

  /**
   * Is a Route admitted by the router? (status.ingress[].conditions Admitted)
   * @param {object} route
   * @returns {boolean}
   */
  isRouteAdmitted(route) {
    const ingress = route.status?.ingress || [];
    return ingress.some((entry) => (entry.conditions || []).some((condition) => condition.type === 'Admitted' && condition.status === 'True'));
  }

  // ── ClusterOperators / ClusterVersion ──────────────────────────────────

  /** @param {string} name @returns {object|null} */
  getClusterOperator(name) {
    return this.getByName('ClusterOperator', name, '');
  }

  /** @returns {object[]} */
  getClusterOperators() {
    return this.getByKind('ClusterOperator').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  /** @returns {object|null} the ClusterVersion singleton */
  getClusterVersion() {
    return this.getByName('ClusterVersion', 'version', '');
  }

  /**
   * Update a ClusterOperator condition set (used by incidents/controllers).
   * @param {string} name
   * @param {{available?: boolean, progressing?: boolean, degraded?: boolean, message?: string}} state
   * @returns {object|null}
   */
  setClusterOperatorState(name, state = {}) {
    const operator = this.getClusterOperator(name);
    if (!operator) return null;
    if (state.available !== undefined) {
      operator.setCondition('Available', state.available ? 'True' : 'False', state.available ? 'AsExpected' : 'Unavailable', state.message || '');
    }
    if (state.progressing !== undefined) {
      operator.setCondition('Progressing', state.progressing ? 'True' : 'False', state.progressing ? 'Working' : 'AsExpected', state.message || '');
    }
    if (state.degraded !== undefined) {
      operator.setCondition('Degraded', state.degraded ? 'True' : 'False', state.degraded ? 'Degraded' : 'AsExpected', state.message || '');
    }
    this.update(operator.uid, operator);
    return operator;
  }

  /** Summary of ClusterOperator health (percentage available, degraded list). */
  getClusterHealth() {
    const operators = this.getClusterOperators();
    const available = operators.filter((operator) => operator.isConditionTrue('Available')).length;
    const degraded = operators.filter((operator) => operator.isConditionTrue('Degraded')).map((operator) => operator.metadata.name);
    const progressing = operators.filter((operator) => operator.isConditionTrue('Progressing')).map((operator) => operator.metadata.name);
    const total = operators.length;
    return {
      total,
      available,
      degraded,
      progressing,
      percent: total > 0 ? Math.round((available / total) * 100) : 100,
      healthy: degraded.length === 0 && available === total,
    };
  }
}

export default ClusterState;
