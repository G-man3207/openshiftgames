/**
 * SimulationTick.js — fixed-step controller loop for shifting.pro.
 *
 * Extends the original Kubernetes simulation with OpenShift 4.22 controllers:
 *   - Project lifecycle (Active → Terminating → purged)
 *   - Route admission (Service endpoints → status.ingress Admitted condition)
 *   - BuildConfig → Build → ImageStream (+ ImageChange rollout triggers)
 *   - OLM Subscriptions (Installing → Succeeded) and operator effects
 *   - MetalLB IPAddressPool/L2Advertisement → Service EXTERNAL-IP
 *   - SCC admission before pod creation (ReplicaSet FailedCreate, no Pod)
 *   - kubelet image pulls (internal ImageStreamTag + registry pull failures →
 *     ErrImagePull/ImagePullBackOff), Deployment progress deadlines
 *   - OLM: PackageManifest catalog, Subscription → InstallPlan → CSV,
 *     CSV-owned operator Deployment, MetalLB operand CR lifecycle
 *   - NetworkPolicy traffic evaluation (ingress+egress, DNS on port 5353)
 *   - LimitRange defaults/min/max enforcement
 *   - ResourceQuota / ClusterResourceQuota enforcement
 *   - OAuth identity-provider rollout (~5s) and ClusterOperator health
 *
 * All mutations happen inside `cluster.startBatch()` / `flushBatch()` so the
 * renderer and UI update once per tick (see docs/architecture-map.md §4).
 *
 * @module engine/SimulationTick
 */

import {
  APPS_DOMAIN,
  IMAGE_REGISTRY_HOST,
  OPENSHIFT_CHANNEL,
  OPENSHIFT_VERSION,
  deepClone,
  parseCpuMillis,
  parseMemoryMi,
} from './ClusterState.js';
import { podSecurityRequest, ruleMatches, runAsUserAllowed } from './RBACEngine.js';
import {
  validateCronSchedule,
  parseCronSchedule,
  nextCronOccurrence,
} from '../resources/WorkloadResources.js';
import {
  imageEnvironmentSatisfied,
  knownImageRuntimeFailure,
  knownImageSecurityProfile,
} from '../resources/ImageSecurityProfiles.js';
// The service-ca controller issues serving certificates with the same
// dependency-free PEM helpers that back the shell's simulated `openssl`
// commands (issue #32b/#33a), so `openssl x509` can read the resulting Secret.
import {
  createCertificateAuthority,
  createSelfSignedCertificate,
  createServiceSignedCertificate,
  parseCertificatePem,
} from '../ui/ShellTools.js';
import { createResource } from '../data/kindRegistry.js';
import { stableStringify, templateHash } from './TemplateHash.js';

/** Fixed controller timings in game seconds (1 tick = 0.05 s at 20 TPS). */
const BUILD_PHASE_NEW_SECONDS = 1;
const BUILD_PHASE_PENDING_SECONDS = 1;
const BUILD_PHASE_RUNNING_SECONDS = 6;
const SUBSCRIPTION_INSTALL_SECONDS = 8;
/** OLM install-plan/CSV step timings in game seconds (compressed vs. real OLM). */
const INSTALLPLAN_COMPLETE_SECONDS = 2;
const CSV_INSTALL_SECONDS = 5;
/** Socially-acceptable interval between duplicate FailedCreate events. */
const FAILED_CREATE_EVENT_SECONDS = 10;
/** How long a container keeps retrying before the state reports ImagePullBackOff. */
const IMAGE_PULL_RETRY_SECONDS = 2;
/**
 * In-cluster hostnames of the Kubernetes API server (issue #76 L16): a Pod's
 * service-account token is addressed to `https://kubernetes.default.svc`, which
 * resolves to the `default/kubernetes` Service ClusterIP (172.30.0.1) on OCP.
 */
const CLUSTER_API_HOSTS = new Set([
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
  'kubernetes.default',
  'kubernetes',
  '172.30.0.1',
  'api.cluster.example.com',
  'api-int.cluster.example.com',
]);

/** Core/v1 resources the in-cluster API REST model can list/get (issue #76 L16). */
const API_EXEC_RESOURCE_KINDS = {
  pods: 'Pod',
  services: 'Service',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  serviceaccounts: 'ServiceAccount',
  events: 'Event',
  persistentvolumeclaims: 'PersistentVolumeClaim',
};

/**
 * Kubelet CrashLoopBackOff schedule: the container restarts 10s after the first
 * crash, then 20s, 40s … capped at 5 minutes (k8s v1.35 kubelet backoff).
 */
const CRASH_BACKOFF_BASE_SECONDS = 10;
const CRASH_BACKOFF_MAX_SECONDS = 300;
/**
 * `APP_MODE` values the simulated demo application accepts. The game's demo app
 * validates its config at startup, so any other static value makes the
 * container exit 1 on the FIRST start (issues #75 L3 / #76 crashloop timing).
 */
const APP_MODE_ALLOWED_VALUES = new Set(['production', 'prod', 'development', 'dev']);
/** Crash output the demo app writes for an invalid APP_MODE (matches #42-3). */
const INVALID_APP_MODE_LOG_LINES = [
  'Starting application...',
  'FATAL: configuration validation failed (exit code 1)',
  'Error: configuration validation failed: APP_MODE has an unsupported value',
  'Process exited with status 1',
];

/**
 * Software catalog advertised by the simulated openshift-marketplace
 * (PackageManifest objects). Keep this list small: the objects are real cluster
 * resources and every seeded resource gets a 3D mesh.
 */
const OLM_CATALOG = [
  {
    // The redhat-operators package on OCP 4.x is `metallb-operator`; its bundle
    // follows the OCP minor (`metallb-operator.v4.22.x-<build>`), never the
    // upstream `v0.14.9` release — issues #18/#76.
    name: 'metallb-operator',
    displayName: 'MetalLB Operator',
    currentCSV: 'metallb-operator.v4.22.0-202610281200',
    channel: 'stable',
    provider: 'Red Hat',
    description:
      'MetalLB is a load-balancer implementation for bare-metal clusters using standard routing protocols.',
    crds: [{ kind: 'MetalLB', name: 'metallbs.metallb.io', version: 'v1beta1' }],
  },
  {
    name: 'ansible-automation-platform-operator',
    displayName: 'Ansible Automation Platform',
    currentCSV: 'aap-operator.v2.6.0',
    // Real AAP 2.6 catalog channel. The shipped example Subscription, the
    // palette default and the timed-lab seed use it (issue #46 keeps channel
    // validation strict, so the catalog advertises real channels only).
    channel: 'stable-2.6',
    provider: 'Red Hat',
    description: 'Deploys and manages Ansible Automation Platform instances.',
    crds: [],
  },
  {
    name: 'openshift-pipelines-operator-rh',
    displayName: 'Red Hat OpenShift Pipelines',
    currentCSV: 'openshift-pipelines-operator-rh.v1.18.0',
    channel: 'latest',
    provider: 'Red Hat',
    description: 'Tekton-based CI/CD pipelines for OpenShift.',
    crds: [],
  },
  {
    // The Red Hat catalog package for the cert-manager Operator is
    // `openshift-cert-manager-operator` and its default channel is `stable-v1`;
    // the CSVs *inside* the package keep their upstream `cert-manager-operator`
    // name (issue #46). `entries` is the discoverable pinnable-version list that
    // OLM exposes via `PackageManifest.status.channels[*].entries` and validates
    // `spec.startingCSV` against — the head (v1.17.0) plus the two older
    // z-streams a player may pin with Manual approval.
    name: 'openshift-cert-manager-operator',
    displayName: 'cert-manager Operator for Red Hat OpenShift',
    currentCSV: 'cert-manager-operator.v1.17.0',
    channel: 'stable-v1',
    entries: [
      'cert-manager-operator.v1.17.0',
      'cert-manager-operator.v1.16.0',
      'cert-manager-operator.v1.15.0',
    ],
    provider: 'Red Hat',
    description: 'Automates certificate management with cert-manager on OpenShift.',
    crds: [],
  },
];

const OAUTH_ROLLOUT_SECONDS = 5;
/**
 * openshift-apiserver config-rollout duration after a
 * `project.config.openshift.io/cluster` `spec.projectRequestTemplate` change
 * (issue #76). `oc new-project` keeps using the PREVIOUS apiserver revision
 * during this window; the new template becomes active afterwards.
 */
const PROJECT_TEMPLATE_ROLLOUT_SECONDS = 8;
const PROJECT_TERMINATION_SECONDS = 2;
/** Real nodes reserve kube/system resources, so allocatable < capacity. */
const RESERVED_CPU_MILLICORES = 250;
const RESERVED_MEMORY_MIB = 1024;

/**
 * Image references the simulated registries cannot resolve. A tag such as
 * `quay.io/openshift/origin-hello-openshift:does-not-exist` is exactly the L10
 * rolling-update scenario; `:not-found` is used by the DeploymentStuckRollout
 * incident. The token may appear ANYWHERE in the tag (`:v9-nope` is also
 * unpullable, issue #26); public images are otherwise assumed pullable.
 */
const IMAGE_PULL_FAILURE_TAG_RE =
  /(does-not-exist|doesnotexist|doesnt-exist|nonexistent|no-such|not-found|notfound|missing|invalid|bogus|nope|broken)/i;
const IMAGE_PULL_FAILURE_REPO_RE =
  /(^|[\/])(does-not-exist|doesnotexist|nonexistent|no-such-repo|missing-repo)([\/:.]|$)/i;

/** service-ca / router constants (issues #32c, #33a, #33b). */
const SERVING_CERT_ANNOTATION = 'service.beta.openshift.io/serving-cert-secret-name';
const INJECT_CABUNDLE_ANNOTATION = 'service.beta.openshift.io/inject-cabundle';
const INJECT_CABUNDLE_KEY = 'service-ca.crt';
const ROUTER_NAMESPACE = 'openshift-ingress';
const ROUTER_DEFAULT_IP = '172.30.0.20';
/**
 * The OpenShift router's own 503 page (openshift/router
 * images/router/haproxy/conf/error-page-503.http, release-4.22), served for
 * EVERY request the router cannot hand to a backend: no Route for the host or
 * path (the `openshift_default` backend has no servers — it only answers 404
 * when a custom ROUTER_ERRORFILE_404 is configured), HTTP to an edge Route with
 * insecureEdgeTerminationPolicy None, HTTP to a passthrough Route, HTTPS to a
 * plain-HTTP Route, and a Route without reachable endpoints. 1.16.0: the stock
 * HAProxy "No server is available" body and a 404 were served instead. The
 * inline <style> block of the real page is omitted.
 */
const ROUTER_503_BODY = [
  '<html>',
  '  <head>',
  '    <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  </head>',
  '  <body>',
  '    <div>',
  '      <h1>Application is not available</h1>',
  '      <p>The application is currently not serving requests at this endpoint. It may not have been started or is still starting.</p>',
  '',
  '      <div class="alert alert-info">',
  '        <p class="info">',
  '          Possible reasons you are seeing this page:',
  '        </p>',
  '        <ul>',
  '          <li>',
  "            <strong>The host doesn't exist.</strong>",
  '            Make sure the hostname was typed correctly and that a route matching this hostname exists.',
  '          </li>',
  '          <li>',
  "            <strong>The host exists, but doesn't have a matching path.</strong>",
  '            Check if the URL path was typed correctly and that the route was created using the desired path.',
  '          </li>',
  '          <li>',
  '            <strong>Route and path matches, but all pods are down.</strong>',
  '            Make sure that the resources exposed by this route (pods, services, deployment configs, etc) have at least one pod running.',
  '          </li>',
  '        </ul>',
  '      </div>',
  '    </div>',
  '  </body>',
  '</html>',
].join('\n');

/** Controller-owned platform workloads (issue #55). */
const DNS_NAMESPACE = 'openshift-dns';
const ROUTER_DEPLOYMENT_NAME = 'router-default';
/**
 * The real 4.22 platform Services (issue #58). `dns-default` is the
 * `serviceNetwork` ClusterIP every Pod's `/etc/resolv.conf` points at, so its
 * address is fixed (172.30.0.10) exactly like the DNS operator allocates it;
 * `router-internal-default` is the in-cluster router VIP the ingress operator
 * creates next to the router Deployment.
 */
const DNS_DEFAULT_SERVICE_NAME = 'dns-default';
const DNS_DEFAULT_SERVICE_IP = '172.30.0.10';
/**
 * Resolved container port the DNS pods listen on inside the pod network (not
 * :53). The dns-default Service exposes named targetPorts (`dns`/`dns-tcp` →
 * 5353, `metrics` → kube-rbac-proxy 9154, #62E); this constant is the resolved
 * DNS port NetworkPolicy checks must allow (5353, never 53).
 */
const DNS_DEFAULT_SERVICE_TARGET_PORT = 5353;
const ROUTER_INTERNAL_SERVICE_NAME = 'router-internal-default';
/** Label the ingress operator puts on the default router Pods (and selects on). */
const INGRESS_CONTROLLER_DEPLOYMENT_LABEL =
  'ingresscontroller.operator.openshift.io/deployment-ingresscontroller';
/** Labels that identify the default ingress router (Deployment selector). */
const ROUTER_DEFAULT_SELECTOR = {
  'ingress.operator.openshift.io/default-router': 'true',
  router: ROUTER_DEPLOYMENT_NAME,
};
/**
 * The real scheduler retries an unschedulable Pod with exponential backoff:
 * `podInitialBackoffDuration` 1 s doubling to `podMaxBackoffDuration` 10 s
 * (k8s.io/kubernetes/pkg/scheduler). Attempts are throttled so the
 * FailedScheduling Event series shows realistic counts over a real time window
 * (`x4 over 7s`) instead of one Event per 20 TPS tick (`x167 over 0s`, #57).
 */
const SCHEDULER_INITIAL_BACKOFF_SECONDS = 1;
const SCHEDULER_MAX_BACKOFF_SECONDS = 10;
/**
 * Tolerations of the platform node DaemonSets (dns-default, node-resolver) on a
 * real 4.22 cluster: DNS must run on EVERY node, including dedicated
 * control-plane machines, so the templates carry the master/control-plane and
 * node-lifecycle tolerations the DNS operator installs. This is also what keeps
 * the bootstrap — and any controller-recreated — dns-default Pod running/Ready
 * on master-0 even though ordinary workload Pods cannot tolerate its taint
 * (issue #55).
 */
const PLATFORM_NODE_DAEMONSET_TOLERATIONS = [
  { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute' },
  { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute' },
];

/** Real service-account mount path + projected token lifetime (issue #42). */
const SERVICE_ACCOUNT_MOUNT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount';
const SERVICE_ACCOUNT_TOKEN_SECONDS = 3607;
/** k8s.io/apimachinery `rand.String` safe alphabet for generated volume suffixes. */
const RAND_SAFE_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';

/**
 * Taints the real node lifecycle controller puts on a NotReady/unreachable
 * node (issue #43). A NotReady node is NOT cordoned: `spec.unschedulable` stays
 * false and `oc get nodes` shows STATUS `NotReady` (no SchedulingDisabled).
 */
const NODE_NOT_READY_TAINT_KEYS = [
  'node.kubernetes.io/unreachable',
  'node.kubernetes.io/not-ready',
];
const NODE_NOT_READY_TAINT_EFFECTS = ['NoSchedule', 'NoExecute'];

/** Base64-encode UTF-8 text (Secret `data` values / CABundle keys). */
function base64EncodeText(text) {
  const value = String(text ?? '');
  try {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(value)));
  } catch {
    /* fall through */
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
  return value;
}

/** Decode a base64 Secret `data` value back to UTF-8 text. */
function base64DecodeText(value) {
  const raw = String(value ?? '');
  try {
    if (typeof atob === 'function') {
      const binary = atob(raw.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    /* fall through */
  }
  return '';
}

/** Semantic version advertised by a CSV name (`pkg.v1.2.3` → `1.2.3`). */
function csvVersion(csvName) {
  const match = String(csvName || '').match(/\.v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : '1.0.0';
}

/**
 * Decode a base64url JWT segment to text (used to read the service-account
 * identity out of a Pod's projected token — issue #76 L16).
 * @param {string} value
 * @returns {string}
 */
function decodeBase64UrlText(value) {
  const base64 = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

/** Parse an absolute/relative HTTP URL (the workstation curl front end). */
function parseHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return {
      scheme: parsed.protocol.replace(/:$/, '').toLowerCase(),
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : null,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
    };
  } catch {
    return null;
  }
}

/**
 * Every virtual IP a Service answers on (`spec.clusterIP` + `spec.clusterIPs`),
 * ignoring headless (`None`) and ExternalName Services. Used so a literal
 * ClusterIP target resolves like kube-proxy would (issue #59).
 * @param {object} service
 * @returns {string[]}
 */
function serviceClusterIPs(service) {
  const values = [
    service?.spec?.clusterIP,
    ...(Array.isArray(service?.spec?.clusterIPs) ? service.spec.clusterIPs : []),
  ];
  return values.filter((ip) => typeof ip === 'string' && ip !== '' && ip !== 'None');
}

export class SimulationTick {
  /**
   * @param {import('./ClusterState.js').ClusterState} clusterState
   * @param {import('./GameEngine.js').EventBus} [eventBus]
   */
  constructor(clusterState, eventBus) {
    this.cluster = clusterState;
    this.eventBus = eventBus || null;
    /**
     * Injected container exec evaluator for kubelet exec probes (issue #67).
     * The browser registers CommandBar._simulateExecCommand so probes run in
     * the SAME simulated container filesystem/env as `oc exec`; a bare Node
     * engine falls back to {@link _fallbackExecProbe}.
     * @type {((pod: object, containerName: string, argv: string[]) => {lines?: string[], exitCode?: number})|null}
     */
    this.containerExecEvaluator = null;
    this.cluster._evictedOwnerCounts = new Map();
    this.cluster._rescheduledCount = 0;
    /**
     * Virtual wall-clock anchor. CronJob schedules (and `status.lastScheduleTime`)
     * are computed against `_simEpoch + gameSeconds*1000`, so a schedule fires
     * after its scheduled amount of *simulated* time and time scaling applies.
     */
    this._simEpoch = Date.now();
    /** OLM state kept outside the resource objects (reconcile bookkeeping). */
    this._olmOperatorDeployments = new Map();
    this._olmCatalogEnsuredAt = -Infinity;
    /** MetalLB operand resources created by the operator (uid → kind/ns). */
    this._metallbOperands = new Map();
    /** Known CSVs (uid → {name, namespace, packageName}) for uninstall cleanup. */
    this._knownCSVs = new Map();
    this._lastCronTickAt = -Infinity;

    if (eventBus) {
      eventBus.on('cluster:deleted:Pod', (data) => {
        const pod = data.resource;
        if (pod && pod.metadata.ownerReferences.length > 0) {
          const ownerKey =
            pod.metadata.ownerReferences[0]?.uid || pod.metadata.ownerReferences[0]?.name;
          if (ownerKey) {
            const map = this.cluster._evictedOwnerCounts;
            map.set(ownerKey, (map.get(ownerKey) || 0) + 1);
          }
        }
      });

      // OLM: deleting a Subscription uninstalls the operator.
      eventBus.on('cluster:deleted:Subscription', (data) => {
        const subscription = data.resource;
        eventBus.emit('operator:uninstalled', {
          name: data.name,
          namespace: data.namespace,
          packageName: subscription?.spec?.packageName || data.name,
        });
      });

      // OAuth: a CONFIG change needs a simulated oauth rollout (issue #54f).
      // The authentication operator also watches the htpasswd Secret referenced
      // by the identity provider: changing its data (password rotation, adding a
      // user) triggers the same oauth-openshift rollout, so logins must wait.
      //
      // A fresh cluster must stay settled: ClusterState.clear()/mode setup
      // re-add the SAME baseline OAuth singleton, and that must not start a
      // rollout (it used to, so a fresh sandbox showed authentication
      // PROGRESSING=True immediately). The config signature comparison in
      // {@link _noteOAuthConfigChange} filters those no-op re-seeds out.
      eventBus.on('cluster:added:OAuth', () => this._noteOAuthConfigChange());
      eventBus.on('cluster:modified:OAuth', () => this._noteOAuthConfigChange());

      // project.config.openshift.io/cluster: changing
      // `spec.projectRequestTemplate` makes the config observer start an
      // openshift-apiserver rollout IMMEDIATELY (the ClusterOperator flips to
      // Progressing=True before the next controller tick), then the tick
      // controller tracks the rollout window (issue #76).
      eventBus.on('cluster:modified:ProjectConfig', () => this._noteProjectTemplateConfigChange());
      // ClusterState.clear() (mode/level start) re-seeds a fresh project config
      // singleton: re-baseline the controller on the new object and drop any
      // pending rollout (issue #76 — a stale baseline made templating instant).
      eventBus.on('cluster:reset', () => {
        const baseline = String(
          this.cluster.getProjectConfig?.()?.spec?.projectRequestTemplate?.name || ''
        );
        this._projectTemplateSignature = baseline;
        this._projectTemplateRollout = null;
        this.cluster.setActiveProjectRequestTemplate?.(baseline);
        this.cluster.setClusterOperatorState?.('openshift-apiserver', {
          available: true,
          progressing: false,
          degraded: false,
          message: 'All is well',
        });
      });
      for (const eventName of ['cluster:added:Secret', 'cluster:modified:Secret']) {
        eventBus.on(eventName, (data) => {
          const resource = data?.resource;
          if (!resource || resource.kind !== 'Secret') return;
          if ((resource.metadata?.namespace || '') !== 'openshift-config') return;
          const provider = this.cluster.getAuthProviderConfig?.();
          if (!provider) return;
          if (resource.metadata?.name !== provider.secretName) return;
          this._noteOAuthConfigChange();
        });
      }

      // SCC grant/revocation re-evaluates pods denied earlier.
      eventBus.on('cluster:modified:SecurityContextConstraints', () => {
        this._sccDirty = true;
      });
      eventBus.on('cluster:added:SecurityContextConstraints', () => {
        this._sccDirty = true;
      });
      // OCP 4.x SCC grants are (Cluster)RoleBindings to
      // system:openshift:scc:<name>; re-evaluate when those change.
      for (const eventName of [
        'cluster:added:RoleBinding',
        'cluster:modified:RoleBinding',
        'cluster:deleted:RoleBinding',
        'cluster:added:ClusterRoleBinding',
        'cluster:modified:ClusterRoleBinding',
        'cluster:deleted:ClusterRoleBinding',
        'scc:granted',
        'scc:revoked',
      ]) {
        eventBus.on(eventName, () => {
          this._sccDirty = true;
        });
      }

      // OLM uninstall: deleting the CSV removes the operator Deployment that
      // the CSV's install strategy created (the Subscription does NOT).
      eventBus.on('cluster:deleted:ClusterServiceVersion', (data) => {
        this._onCSVDeleted(data?.resource || data);
      });
    }

    this.tickCount = 0;
    /** Accumulated simulated time in seconds (controller clock). */
    this.gameSeconds = 0;
    this.tickRate = 1;
    this.schedulerQueue = [];
    this.pendingScaleDecisions = new Map();
    this.hpaEvalInterval = 15;
    this.probeInterval = 5;
    this.cronCheckInterval = 10;
    this.metricsHistory = new Map();
    this.maxMetricsHistory = 60;
    /**
     * Difficulty dial written by GameEngine (`0.002 * multiplier`). Kept for
     * backwards compatibility, but the controllers now interpret it as a
     * per-second failure probability derived from the "normal" reference so
     * that healthy pods do not crash every few seconds (SIM-027).
     */
    this.randomFailureRate = 0.002;
    this.randomFailureRateReference = 0.002;
    this.randomFailureRatePerSecond = 0.0003;
    this.networkLatencyBase = 5;
    this.enableChaos = false;
    this.chaosConfig = {
      podKillRate: 0,
      nodeFailRate: 0,
      networkPartition: false,
      cpuStress: 0,
      memoryStress: 0,
    };

    /** Build failure probability per build (spec §5: random 15%). */
    this.buildFailureRate = 0.15;
    /** Track OAuth rollout state: {remaining, provider}. */
    this._oauthPending = null;
    this._sccDirty = false;
    this._quotaViolationNamespaces = new Set();
    /**
     * Signature of the last observed OAuth configuration (#54f). The cluster
     * starts settled: only a real identityProviders/tokenConfig or htpasswd
     * Secret DATA change differs from this signature and triggers a rollout.
     */
    this._oauthConfigSignature = this._oauthSignature();
    /**
     * `spec.projectRequestTemplate` value the running openshift-apiserver
     * revision already serves. Null until the first tick adopts the startup
     * value as the settled baseline (issue #76).
     */
    this._projectTemplateSignature = String(
      this.cluster.getProjectConfig?.()?.spec?.projectRequestTemplate?.name || ''
    );
    this.cluster.setActiveProjectRequestTemplate?.(this._projectTemplateSignature);
    /** Pending openshift-apiserver config rollout: `{target, remaining}`. */
    this._projectTemplateRollout = null;
  }

  // ── Tick pipeline ───────────────────────────────────────────────────────

  /**
   * Advance all controllers by `deltaTime` seconds (already scaled by tickRate
   * via {@link setTickRate}).
   * @param {number} deltaTime
   */
  tick(deltaTime) {
    this.tickCount++;
    const dt = deltaTime * this.tickRate;
    this.gameSeconds = (this.gameSeconds || 0) + dt;

    this.cluster.startBatch();

    // Core OpenShift controllers.
    this._tickProjects(dt);
    this._tickNodes(dt);
    this._ensurePlatformWorkloads();
    this._tickLimitRanges(dt);
    this._tickQuotaEnforcement(dt);
    this._tickPodScheduling(dt);
    this._tickPodServiceAccountMounts(dt);
    this._tickImagePulls(dt);
    this._tickPodLifecycle(dt);
    this._tickContainerResources(dt);
    this._tickHealthChecks(dt);
    this._tickOOMKiller(dt);

    // Workload controllers.
    this._tickDeployments(dt);
    this._tickStatefulSets(dt);
    this._tickDaemonSets(dt);
    this._tickJobs(dt);
    if (this.tickCount % this.cronCheckInterval === 0) this._tickCronJobs(dt);
    if (this.tickCount % this.hpaEvalInterval === 0) this._tickHPA(dt);
    this._tickPersistentVolumeClaims(dt);

    // OpenShift builds / images / networking / operators.
    this._tickBuildConfigs(dt);
    this._tickBuilds(dt);
    this._tickImageStreams(dt);
    if (this.tickCount % this.probeInterval === 0) this._tickProbes(dt);
    this._tickRoutes(dt);
    this._tickServiceCA();
    this._tickSCC(dt);
    this._ensureOLMDefaults();
    this._tickSubscriptions(dt);
    this._tickOperatorEffects(dt);
    if (this.tickCount % 5 === 0) this.cluster.recalculateQuotaStatus(true);
    if (this.tickCount % 20 === 0) this._tickClusterHealth(dt);
    this._tickProjectTemplateRollout(dt);
    this._tickOAuth(dt);

    this._recordMetrics();

    if (this.enableChaos) this._tickChaos(dt);

    this.cluster.flushBatch();

    if (this.eventBus) {
      this.eventBus.emit('simulation:tick', {
        tickCount: this.tickCount,
        deltaTime: dt,
        stats: this.cluster.getClusterStats(),
      });
    }
  }

  // ── Projects / OpenShift cluster lifecycle ─────────────────────────────

  _tickProjects(dt) {
    for (const project of this.cluster.getByKind('Project')) {
      const name = project.metadata.name;
      const terminating =
        project.status.phase === 'Terminating' || project.metadata.deletionTimestamp !== null;
      if (!terminating) {
        if (project.status.phase !== 'Active') project.setPhase('Active');
        continue;
      }
      if (project.status.phase !== 'Terminating') project.setPhase('Terminating');
      project._terminatingElapsed = (project._terminatingElapsed || 0) + dt;
      if (project._terminatingElapsed >= PROJECT_TERMINATION_SECONDS) {
        this.cluster.purgeProject(name);
      }
    }
  }

  // ── Nodes / scheduling / pod lifecycle (preserved) ─────────────────────

  _tickNodes(dt) {
    for (const node of this.cluster.getByKind('Node')) {
      if (node.status.phase === 'Terminating') continue;
      // Player-visible node status must agree with the node spec: capacity from
      // spec.cpu/spec.memory (modes seed 16 / 32Gi nodes).
      if (typeof node.syncCapacityFromSpec === 'function') node.syncCapacityFromSpec();
      const alloc = this.cluster.getNodeAllocatable(node.name);
      if (!alloc) continue;

      // Real Node.status.allocatable is a static property (capacity minus
      // kube/system reservation) and must not shrink as pods are scheduled.
      // Live consumption belongs in status.usage (SIM-023).
      node.status.allocatable = {
        ...(node.status.allocatable || {}),
        cpu: `${Math.max(0, Math.round(alloc.cpu.capacity - RESERVED_CPU_MILLICORES))}m`,
        memory: `${Math.max(0, Math.round(alloc.memory.capacity - RESERVED_MEMORY_MIB))}Mi`,
        pods: String(node.status.allocatable?.pods || node.status.capacity?.pods || '110'),
      };
      node.status.usage = {
        cpu: alloc.cpu.used,
        memory: alloc.memory.used,
        cpuPercent:
          alloc.cpu.capacity > 0 ? Math.round((alloc.cpu.used / alloc.cpu.capacity) * 100) : 0,
        memoryPercent:
          alloc.memory.capacity > 0
            ? Math.round((alloc.memory.used / alloc.memory.capacity) * 100)
            : 0,
      };

      const isReady = node.status.phase !== 'NotReady' && node.status.phase !== 'Unknown';
      // Issue #43: real nodes receive node.kubernetes.io/unreachable +
      // not-ready taints (NoSchedule/NoExecute) instead of being cordoned; the
      // node lifecycle controller removes them once the kubelet is Ready again
      // (e.g. after `chroot /host systemctl restart kubelet`).
      this._syncNodeNotReadyTaints(node, !isReady);
      this._syncNodeUnschedulableTaint(node);
      if (!isReady) {
        // Real node lifecycle controller output while the kubelet is stopped /
        // unreachable (#49): every kubelet-posted condition becomes
        // `Unknown / NodeStatusUnknown / "Kubelet stopped posting node status."`.
        // Writing them here (not just in the incident damage path) keeps the
        // controller authoritative on every tick and restores them on recovery.
        // NetworkUnavailable is managed by the network plugin (control plane),
        // not by the kubelet, so it keeps reporting the healthy OVN-K value.
        for (const conditionType of ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure']) {
          // Do not re-write an already-latched Unknown condition: the kubelet
          // stopped posting, so LastHeartbeatTime must FREEZE at the last post
          // while LastTransitionTime marks the change (issue #76). Re-asserting
          // an identical condition every tick would keep advancing the
          // heartbeat — the exact bug the real node lifecycle controller avoids.
          this._setNodeConditionIfChanged(
            node,
            conditionType,
            'Unknown',
            'NodeStatusUnknown',
            'Kubelet stopped posting node status.'
          );
        }
        this._setNodeConditionIfChanged(
          node,
          'NetworkUnavailable',
          'False',
          'RouteCreated',
          'ovn-kube cleared kubelet-set NoRouteCreated'
        );
        continue;
      }
      node.setCondition('Ready', 'True', 'KubeletReady');
      const freeMemory = alloc.memory.capacity - alloc.memory.used;
      const memoryEvictionThreshold = Math.min(
        RESERVED_MEMORY_MIB,
        Math.max(100, alloc.memory.capacity * 0.1)
      );
      node.setCondition(
        'MemoryPressure',
        freeMemory < memoryEvictionThreshold ? 'True' : 'False',
        freeMemory < memoryEvictionThreshold
          ? 'KubeletHasInsufficientMemory'
          : 'KubeletHasSufficientMemory'
      );
      // PID exhaustion is not modelled; never derive it from CPU pressure.
      node.setCondition('PIDPressure', 'False', 'KubeletHasSufficientPID');
      node.setCondition('DiskPressure', 'False', 'KubeletHasNoDiskPressure');
      node.setCondition(
        'NetworkUnavailable',
        'False',
        'RouteCreated',
        'ovn-kube cleared kubelet-set NoRouteCreated'
      );
    }
  }

  /**
   * Add/remove the real node-lifecycle taints for a node's Ready state.
   * Idempotent; only writes when the taint set actually changes (issue #43).
   * @param {object} node
   * @param {boolean} notReady
   * @returns {boolean} true when the node spec changed
   */
  _syncNodeNotReadyTaints(node, notReady) {
    if (!node?.spec) return false;
    const taints = Array.isArray(node.spec.taints) ? node.spec.taints : [];
    const isLifecycleTaint = (taint) =>
      NODE_NOT_READY_TAINT_KEYS.includes(String(taint?.key || ''));
    if (!notReady) {
      const next = taints.filter((taint) => !isLifecycleTaint(taint));
      if (next.length === taints.length) return false;
      node.spec.taints = next;
      this.cluster.update(node.uid, node);
      return true;
    }
    const next = [...taints];
    let changed = false;
    for (const key of NODE_NOT_READY_TAINT_KEYS) {
      for (const effect of NODE_NOT_READY_TAINT_EFFECTS) {
        if (next.some((taint) => taint?.key === key && taint?.effect === effect)) continue;
        next.push({ key, effect });
        changed = true;
      }
    }
    if (!changed) return false;
    node.spec.taints = next;
    this.cluster.update(node.uid, node);
    return true;
  }

  /**
   * TaintNodesByCondition: a cordoned node (`spec.unschedulable: true`, from
   * `oc adm cordon/drain`, `oc patch` or the GUI) carries the
   * `node.kubernetes.io/unschedulable:NoSchedule` taint, removed again on
   * uncordon. Cordon never sets a node label (1.16.0).
   * @param {object} node
   * @returns {boolean} true when the node spec changed
   */
  _syncNodeUnschedulableTaint(node) {
    if (!node?.spec) return false;
    const key = 'node.kubernetes.io/unschedulable';
    const taints = Array.isArray(node.spec.taints) ? node.spec.taints : [];
    const has = taints.some((taint) => taint?.key === key && taint?.effect === 'NoSchedule');
    const want = node.spec.unschedulable === true;
    if (want === has) return false;
    node.spec.taints = want
      ? [...taints, { key, effect: 'NoSchedule', timeAdded: new Date().toISOString() }]
      : taints.filter((taint) => taint?.key !== key);
    this.cluster.update(node.uid, node);
    return true;
  }

  /**
   * Set a Node condition only when its status/reason/message actually changes.
   * Used for kubelet-posted conditions while the kubelet is unreachable: the
   * controller must not refresh `lastHeartbeatTime` for a frozen post (issue
   * #76 — heartbeat freezes, LastTransitionTime marks the change).
   * @param {object} node
   * @param {string} type
   * @param {string} status
   * @param {string} reason
   * @param {string} message
   * @returns {boolean} whether the condition was written
   */
  _setNodeConditionIfChanged(node, type, status, reason, message) {
    const existing = typeof node.getCondition === 'function' ? node.getCondition(type) : null;
    if (
      existing &&
      existing.status === status &&
      existing.reason === reason &&
      (existing.message || '') === (message || '')
    ) {
      return false;
    }
    node.setCondition(type, status, reason, message || '');
    return true;
  }

  /**
   * Apply the NotReady taints immediately (used by IncidentEngine damage, which
   * may run between ticks).
   * @param {object} node
   * @returns {boolean}
   */
  applyNodeNotReadyTaints(node) {
    return this._syncNodeNotReadyTaints(node, true);
  }

  /**
   * Remove the node-lifecycle taints (used by IncidentEngine healing and the
   * kubelet-restart repair path).
   * @param {object} node
   * @returns {boolean}
   */
  clearNodeNotReadyTaints(node) {
    return this._syncNodeNotReadyTaints(node, false);
  }

  // ── OpenShift platform workloads (issues #53G, #55) ─────────────────────
  //
  // A real OCP 4.22 cluster ships controller-owned work that a player sees
  // immediately: the `router-default` Deployment (2/2) in openshift-ingress,
  // plus the `dns-default` + `node-resolver` DaemonSets in openshift-dns (one
  // Pod on every node — including dedicated control-plane machines, whose
  // master NoSchedule taint the DaemonSet templates tolerate). The namespaces
  // and Secrets are seeded by ClusterState; the owning controllers and their
  // bootstrap Pods are seeded here so they exist in every mode and are visible
  // to `oc get deploy,rs -n openshift-ingress`, `oc describe deploy`,
  // `oc rollout status`, `oc get ds -n openshift-dns` and lab 13's DNS egress
  // lesson.
  //
  // The bootstrap Pods are created synchronously (`ensureOLMDefaultsSync()`
  // runs before the app's initial mesh auto-align) and are fully Running/Ready,
  // so a paused pre-start cluster already reports 2/2 and 3/3/3. They are REAL
  // controller-owned Pods (ownerReferences: Pod → ReplicaSet → Deployment /
  // Pod → DaemonSet) seeded exactly ONCE per owner (in-memory flag). After
  // that the normal Deployment/ReplicaSet/DaemonSet controllers own
  // reconciliation: deleting a platform Pod makes the controller recreate it
  // normally, while this seeder only re-creates a controller that was deleted
  // wholesale (the platform operators do the same on a real cluster).

  _ensurePlatformWorkloads() {
    const nodes = this.cluster
      .getByKind('Node')
      .filter((node) => node.status?.phase !== 'Terminating' && !node.metadata?.deletionTimestamp);
    if (nodes.length === 0) return; // safe before a mode seeds its Nodes
    this._ensurePlatformServices();
    this._ensureRouterWorkloads(nodes);
    this._ensureDnsWorkloads(nodes);
  }

  /**
   * The real 4.22 platform Services (issue #58). They belong to the platform
   * operators, not to a player project, and every Pod's `/etc/resolv.conf`
   * points at `openshift-dns/dns-default` (ClusterIP 172.30.0.10) — which is
   * exactly the first thing a learner checks after a NetworkPolicy breaks DNS
   * in lab 13 (`oc get svc,endpoints -n openshift-dns`). `router-internal-default`
   * is the in-cluster router VIP created next to the router Deployment. Both are
   * seeded synchronously with the rest of the platform (paused pre-start
   * cluster included) and re-created by the operator seeder if deleted.
   */
  _ensurePlatformServices() {
    this._ensurePlatformService({
      name: DNS_DEFAULT_SERVICE_NAME,
      namespace: DNS_NAMESPACE,
      clusterIP: DNS_DEFAULT_SERVICE_IP,
      labels: { 'dns.operator.openshift.io/owning-dns': 'default' },
      selector: { 'dns.operator.openshift.io/daemonset-dns': 'default' },
      // The cluster-dns-operator's release-4.22 asset
      // (pkg/manifests/assets/dns/service.yaml) sets spec.trafficDistribution:
      // PreferSameNode on dns-default; `oc describe svc` prints it (issue #69 P4).
      trafficDistribution: 'PreferSameNode',
      // Real 4.22 spec (issue #62E): the Service ports use NAMED targetPorts
      // (`dns`/`dns-tcp` on the CoreDNS container, `metrics` on the
      // kube-rbac-proxy sidecar), not the 5353/9154 numbers `oc describe`
      // shows as resolved endpoints.
      ports: [
        {
          name: 'dns',
          port: 53,
          protocol: 'UDP',
          targetPort: 'dns',
        },
        {
          name: 'dns-tcp',
          port: 53,
          protocol: 'TCP',
          targetPort: 'dns-tcp',
        },
        { name: 'metrics', port: 9154, protocol: 'TCP', targetPort: 'metrics' },
      ],
    });
    this._ensurePlatformService({
      name: ROUTER_INTERNAL_SERVICE_NAME,
      namespace: ROUTER_NAMESPACE,
      // No fixed ClusterIP: the service controller allocates one from the
      // 172.30.0.0/16 serviceNetwork like any other ClusterIP Service.
      labels: { 'ingresscontroller.operator.openshift.io/owning-ingresscontroller': 'default' },
      selector: { [INGRESS_CONTROLLER_DEPLOYMENT_LABEL]: 'default' },
      ports: [
        { name: 'http', port: 80, protocol: 'TCP', targetPort: 80 },
        { name: 'https', port: 443, protocol: 'TCP', targetPort: 443 },
        { name: 'metrics', port: 1936, protocol: 'TCP', targetPort: 1936 },
      ],
    });
  }

  /**
   * Create one platform-owned ClusterIP Service when it is missing.
   * @param {{name: string, namespace: string, labels?: object, selector: object,
   *   ports: object[], clusterIP?: string, trafficDistribution?: string}} definition
   * @returns {object|null} the Service resource
   */
  _ensurePlatformService(definition) {
    const { name, namespace } = definition;
    if (!this.cluster.getByName('Project', namespace, '')) return null;
    const existing = this.cluster.getByName('Service', name, namespace);
    if (existing) return existing;
    const spec = {
      type: 'ClusterIP',
      selector: deepClone(definition.selector || {}),
      ports: deepClone(definition.ports || []),
    };
    if (definition.clusterIP) {
      spec.clusterIP = definition.clusterIP;
      spec.clusterIPs = [definition.clusterIP];
    }
    if (definition.trafficDistribution) {
      spec.trafficDistribution = definition.trafficDistribution;
    }
    const service = createResource('Service', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace,
        labels: deepClone(definition.labels || {}),
      },
      spec,
    });
    if (!service) return null;
    // The Service class defaults merge `{app: <name>}` into the selector
    // (mergeDefaults deep-merges plain objects). A real platform Service selects
    // ONLY on its operator label — an extra `app: router-internal-default` key
    // silently matched no router Pod and left the Service with `<none>`
    // endpoints, so pin the real selector explicitly.
    service.spec.selector = deepClone(definition.selector || {});
    if (definition.clusterIP) {
      service.spec.clusterIP = definition.clusterIP;
      service.spec.clusterIPs = [definition.clusterIP];
    }
    if (definition.trafficDistribution) {
      service.spec.trafficDistribution = definition.trafficDistribution;
    }
    return this.cluster.addResource(service);
  }

  /** router-default Deployment + ReplicaSet + bootstrap Pods (issue #55). */
  _ensureRouterWorkloads(nodes) {
    if (!this.cluster.getByName('Project', ROUTER_NAMESPACE, '')) return;
    const workers = nodes.filter(
      (node) =>
        node.metadata?.labels?.['node-role.kubernetes.io/worker'] !== undefined ||
        /^worker-/.test(String(node.metadata?.name || ''))
    );
    const candidates = workers.length > 0 ? workers : nodes;
    // A real 4.22 ingress operator runs at least two router-default replicas.
    const targets = candidates.slice(0, 2);
    if (targets.length === 0) return;

    let deployment = this.cluster.getByName('Deployment', ROUTER_DEPLOYMENT_NAME, ROUTER_NAMESPACE);
    let created = false;
    if (!deployment) {
      deployment = this.cluster.addResource({
        kind: 'Deployment',
        metadata: {
          name: ROUTER_DEPLOYMENT_NAME,
          namespace: ROUTER_NAMESPACE,
          labels: {
            app: 'router',
            router: ROUTER_DEPLOYMENT_NAME,
            'ingress.operator.openshift.io/default-router': 'true',
            [INGRESS_CONTROLLER_DEPLOYMENT_LABEL]: 'default',
          },
        },
        spec: {
          replicas: targets.length,
          selector: { matchLabels: deepClone(ROUTER_DEFAULT_SELECTOR) },
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' },
          },
          template: this._routerDefaultTemplate(),
        },
      });
      created = Boolean(deployment);
    }
    if (!deployment) return;
    // addResource() merges the Deployment class's default selector
    // ({app: <name>}); the real router-default selects on the ingress-operator
    // label only, and a selector that does not match the template labels would
    // be rejected by a real API server.
    deployment.spec.selector = { matchLabels: deepClone(ROUTER_DEFAULT_SELECTOR) };

    const template = deepClone(deployment.spec.template || this._routerDefaultTemplate());
    const templateHash = this._templateHash(template);
    const selector = deepClone(deployment.spec.selector?.matchLabels || ROUTER_DEFAULT_SELECTOR);
    const ownedSets = this.cluster
      .getChildren(deployment.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    let replicaSet =
      ownedSets.find((rs) => rs.metadata?.labels?.['pod-template-hash'] === templateHash) || null;
    if (!replicaSet) {
      replicaSet = this._createDeploymentReplicaSet(
        deployment,
        template,
        templateHash,
        selector,
        ownedSets
      );
    }
    if (!replicaSet) return;

    if (!created || replicaSet._platformPodsSeeded) return;
    // One-time synchronous bootstrap. Seeding on later ticks would fight the
    // Deployment controller (a deleted Pod would be instantly resurrected
    // instead of recreated by the ReplicaSet) — so this only runs immediately
    // after this seeder created the Deployment itself.
    replicaSet._platformPodsSeeded = true;
    const templateLabels = deepClone(template.metadata?.labels || {});
    const desired = Math.max(
      0,
      Math.min(targets.length, Number(deployment.spec.replicas ?? targets.length) || 0)
    );
    for (const node of targets.slice(0, desired)) {
      const name = `${replicaSet.metadata.name}-${this._platformPodSuffix(
        `router-default:${node.metadata.name}`
      )}`;
      if (this.cluster.getByName('Pod', name, ROUTER_NAMESPACE)) continue;
      this._seedPlatformPod({
        name,
        namespace: ROUTER_NAMESPACE,
        node,
        owner: replicaSet,
        labels: {
          ...templateLabels,
          ...selector,
          'pod-template-hash': templateHash,
        },
        podSpec: template.spec,
      });
    }
    replicaSet.spec.replicas = desired;
    this._refreshReplicaSetStatus(replicaSet, this._activePodsOf(replicaSet), 0);
    this.cluster.update(replicaSet.uid, replicaSet);

    const pods = this._activePodsOf(replicaSet);
    const ready = pods.filter((pod) => this._podIsReady(pod, 0));
    const now = new Date().toISOString();
    const available = desired > 0 && ready.length >= desired;
    deployment.status = {
      ...(deployment.status || {}),
      observedGeneration: deployment.metadata.generation,
      replicas: pods.length,
      updatedReplicas: pods.length,
      readyReplicas: ready.length,
      availableReplicas: ready.length,
      unavailableReplicas: Math.max(0, desired - ready.length),
      conditions: [
        {
          type: 'Available',
          status: available ? 'True' : 'False',
          reason: available ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
          message: `${ready.length}/${desired} replicas available`,
          lastTransitionTime: now,
        },
        {
          type: 'Progressing',
          status: 'True',
          reason: 'NewReplicaSetAvailable',
          message: `ReplicaSet "${replicaSet.metadata.name}" has successfully progressed.`,
          lastTransitionTime: now,
        },
      ],
    };
    this.cluster.update(deployment.uid, deployment);
  }

  /**
   * Pod template of the real 4.22 default ingress router (`router-default` in
   * openshift-ingress): hostNetwork with host ports 80/443 — which is also what
   * makes exactly one router Pod fit per node — and the default IngressController
   * node placement (`kubernetes.io/os: linux`), so the control-plane NoSchedule
   * taint is what keeps the router off dedicated masters (issue #55).
   * @returns {object} pod template
   */
  _routerDefaultTemplate() {
    return {
      metadata: {
        labels: {
          app: 'router',
          router: ROUTER_DEPLOYMENT_NAME,
          'ingress.operator.openshift.io/default-router': 'true',
          // The ingress operator labels (and selects) the default router Pods
          // with this key; docs use it to delete a router Pod by label (#58).
          [INGRESS_CONTROLLER_DEPLOYMENT_LABEL]: 'default',
        },
      },
      spec: {
        hostNetwork: true,
        dnsPolicy: 'ClusterFirstWithHostNet',
        priorityClassName: 'system-cluster-critical',
        serviceAccountName: 'router',
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        restartPolicy: 'Always',
        terminationGracePeriodSeconds: 30,
        containers: [
          {
            name: 'router',
            image: 'quay.io/openshift/origin-haproxy-router:4.22',
            imagePullPolicy: 'IfNotPresent',
            ports: [
              { name: 'http', containerPort: 80, hostPort: 80, protocol: 'TCP' },
              { name: 'https', containerPort: 443, hostPort: 443, protocol: 'TCP' },
              { name: 'metrics', containerPort: 1936, protocol: 'TCP' },
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
          },
        ],
      },
    };
  }

  /** dns-default + node-resolver DaemonSets and their Pods (issue #55). */
  _ensureDnsWorkloads(nodes) {
    if (!this.cluster.getByName('Project', DNS_NAMESPACE, '')) return;
    this._ensurePlatformDaemonSet(nodes, {
      name: 'dns-default',
      selectorLabels: { 'dns.operator.openshift.io/daemonset-dns': 'default' },
      template: this._dnsDefaultTemplate(),
    });
    this._ensurePlatformDaemonSet(nodes, {
      name: 'node-resolver',
      selectorLabels: { 'dns.operator.openshift.io/daemonset-node-resolver': 'default' },
      template: this._nodeResolverTemplate(),
    });
  }

  /**
   * Pod template of the real 4.22 `dns-default` DaemonSet (dns + kube-rbac-proxy).
   *
   * The DNS pods run on the POD network (issue #58): CoreDNS binds :5353 inside
   * the pod netns and the `dns-default` Service maps :53 to it, exactly like a
   * real 4.22 install. Only `node-resolver` (and the router on bare metal) is
   * hostNetwork, so `oc get pods -o wide -n openshift-dns` shows 10.x pod IPs
   * for dns-default and the node IP for node-resolver. The template also carries
   * the real `kubernetes.io/os: linux` nodeSelector the DNS operator installs.
   */
  _dnsDefaultTemplate() {
    return {
      metadata: {
        labels: {
          app: 'dns-default',
          'dns.operator.openshift.io/daemonset-dns': 'default',
        },
      },
      spec: {
        priorityClassName: 'system-node-critical',
        serviceAccountName: 'dns-default',
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        restartPolicy: 'Always',
        terminationGracePeriodSeconds: 30,
        tolerations: deepClone(PLATFORM_NODE_DAEMONSET_TOLERATIONS),
        containers: [
          {
            name: 'dns',
            image: 'quay.io/openshift/origin-coredns:4.22',
            imagePullPolicy: 'IfNotPresent',
            ports: [
              { name: 'dns', containerPort: 5353, protocol: 'UDP' },
              { name: 'dns-tcp', containerPort: 5353, protocol: 'TCP' },
              { name: 'metrics', containerPort: 9153, protocol: 'TCP' },
            ],
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' },
            },
          },
          {
            name: 'kube-rbac-proxy',
            image: 'quay.io/openshift/origin-kube-rbac-proxy:4.22',
            imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'metrics', containerPort: 9154, protocol: 'TCP' }],
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits: { cpu: '100m', memory: '128Mi' },
            },
          },
        ],
      },
    };
  }

  /** Pod template of the real 4.22 `node-resolver` DaemonSet. */
  _nodeResolverTemplate() {
    return {
      metadata: {
        labels: {
          app: 'node-resolver',
          'dns.operator.openshift.io/daemonset-node-resolver': 'default',
        },
      },
      spec: {
        hostNetwork: true,
        dnsPolicy: 'ClusterFirstWithHostNet',
        priorityClassName: 'system-node-critical',
        serviceAccountName: 'node-resolver',
        nodeSelector: { 'kubernetes.io/os': 'linux' },
        restartPolicy: 'Always',
        terminationGracePeriodSeconds: 30,
        tolerations: deepClone(PLATFORM_NODE_DAEMONSET_TOLERATIONS),
        containers: [
          {
            name: 'dns-node-resolver',
            image: 'quay.io/openshift/origin-node-resolver:4.22',
            imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'metrics', containerPort: 9113, protocol: 'TCP' }],
            resources: {
              requests: { cpu: '10m', memory: '16Mi' },
              limits: { cpu: '50m', memory: '64Mi' },
            },
          },
        ],
      },
    };
  }

  /**
   * Seed (or refresh) one platform DaemonSet and its bootstrap Pods. The Pods
   * are seeded once per DaemonSet; afterwards the DaemonSet controller recreates
   * any Pod the player deletes on the next tick.
   * @param {object[]} nodes current cluster Nodes
   * @param {{name: string, selectorLabels: object, template: object}} definition
   */
  _ensurePlatformDaemonSet(nodes, definition) {
    const { name, selectorLabels } = definition;
    let daemonSet = this.cluster.getByName('DaemonSet', name, DNS_NAMESPACE);
    let created = false;
    if (!daemonSet) {
      daemonSet = this.cluster.addResource({
        kind: 'DaemonSet',
        metadata: {
          name,
          namespace: DNS_NAMESPACE,
          labels: deepClone(definition.template.metadata?.labels || selectorLabels),
        },
        spec: {
          selector: { matchLabels: deepClone(selectorLabels) },
          updateStrategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxUnavailable: '10%' },
          },
          template: deepClone(definition.template),
        },
      });
      created = Boolean(daemonSet);
    }
    if (!daemonSet) return;
    // Normalise the selector the class defaults merged in ({app: <name>}), so
    // `.spec.selector.matchLabels` is the real DNS operator label set.
    daemonSet.spec.selector = { matchLabels: deepClone(selectorLabels) };

    if (!created || daemonSet._platformPodsSeeded) return;
    daemonSet._platformPodsSeeded = true;
    const template = deepClone(daemonSet.spec.template || definition.template);
    const targetNodes = this._platformDaemonSetTargets(
      nodes,
      template.spec?.nodeSelector || {},
      template.spec?.tolerations || []
    );
    for (const node of targetNodes) {
      const podName = `${name}-${this._platformPodSuffix(`${name}:${node.metadata.name}`)}`;
      if (this.cluster.getByName('Pod', podName, DNS_NAMESPACE)) continue;
      this._seedPlatformPod({
        name: podName,
        namespace: DNS_NAMESPACE,
        node,
        owner: daemonSet,
        labels: {
          ...deepClone(template.metadata?.labels || {}),
          ...deepClone(selectorLabels),
        },
        podSpec: template.spec,
      });
    }
    const pods = this._activePodsOf(daemonSet);
    const ready = pods.filter((pod) => this._podIsReady(pod, 0));
    daemonSet.status = {
      ...(daemonSet.status || {}),
      desiredNumberScheduled: targetNodes.length,
      currentNumberScheduled: pods.filter((pod) => pod.spec.nodeName).length,
      numberReady: ready.length,
      numberAvailable: ready.length,
      numberUnavailable: Math.max(0, targetNodes.length - ready.length),
      numberMisscheduled: 0,
      updatedNumberScheduled: pods.length,
      observedGeneration: daemonSet.metadata.generation,
      phase: 'Running',
      conditions: [],
    };
    this.cluster.update(daemonSet.uid, daemonSet);
  }

  /**
   * Nodes a DaemonSet targets, using the same rules as {@link _tickDaemonSets}:
   * Ready nodes that match the Pod template's nodeSelector and whose taints the
   * template tolerates.
   * @param {object[]} nodes
   * @param {object} nodeSelector DaemonSet pod-template nodeSelector
   * @param {object[]} tolerations DaemonSet pod-template tolerations
   * @returns {object[]}
   */
  _platformDaemonSetTargets(nodes, nodeSelector = {}, tolerations = []) {
    return nodes.filter((node) => {
      if (!node.isConditionTrue('Ready')) return false;
      if (typeof node.matchesSelector === 'function' && !node.matchesSelector(nodeSelector))
        return false;
      return !this._firstUntoleratedNoScheduleTaint({ spec: { tolerations } }, node);
    });
  }

  /** Deterministic 5-character rand.String suffix for bootstrap platform Pods. */
  _platformPodSuffix(seed) {
    const digest = this._hashString(seed);
    let suffix = '';
    for (let index = 0; index < 5; index += 1) {
      suffix += RAND_SAFE_ALPHABET[(digest >>> (index * 4)) % RAND_SAFE_ALPHABET.length];
    }
    return suffix;
  }

  /**
   * Create one Running/Ready bootstrap Pod for a controller-owned platform
   * workload, bound to a node, owned by its ReplicaSet/DaemonSet
   * (ownerReferences via {@link ClusterState.addRelationship}) and with the
   * full status + kubelet lifecycle event stream a real cluster shows.
   *
   * The Pod is seeded fully Ready synchronously so a paused pre-start cluster
   * already shows the platform controllers healthy; its in-memory kubelet flags
   * prevent the scheduling/image-pull/SCC controllers from churning it.
   *
   * @param {{name: string, namespace: string, node: object, owner: object,
   *   labels: object, podSpec: object, annotations?: object}} seed
   * @returns {object|null}
   */
  _seedPlatformPod(seed) {
    const nodeName = seed.node.metadata.name;
    const now = new Date().toISOString();
    const podSpec = deepClone(seed.podSpec || {});
    podSpec.containers = podSpec.containers || [];
    podSpec.nodeName = nodeName;
    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: {
        name: seed.name,
        namespace: seed.namespace,
        labels: deepClone(seed.labels || {}),
        annotations: {
          // The SCC annotation follows the real platform Pods (#58):
          // hostNetwork Pods (router, node-resolver) are admitted by the
          // hostnetwork SCC; dns-default runs on the pod network under the
          // normal restricted-v2 SCC.
          'openshift.io/scc': podSpec.hostNetwork ? 'hostnetwork' : 'restricted-v2',
          'k8s.v1.cni.cncf.io/network-status': '{}',
          ...(seed.annotations || {}),
        },
      },
      spec: podSpec,
      status: { phase: 'Running', startTime: now },
    });
    if (!pod) return null;
    if (seed.owner) this.cluster.addRelationship(seed.owner.uid, pod.uid);
    pod._nodeBound = true;
    pod._imagePullDone = true;
    pod._pullStarted = true;
    pod._sccEvaluated = true;
    pod._readyAt = this.gameSeconds;
    const hostIP = seed.node.status?.addresses?.[0]?.address || '10.0.0.1';
    pod.status.hostIP = hostIP;
    // hostNetwork Pods report the node IP as their Pod IP.
    pod.status.podIP = podSpec.hostNetwork ? hostIP : this._generatePodIP(seed.node);
    pod.status.conditions = [];
    pod.setCondition('PodScheduled', 'True', 'Scheduled', `Assigned to ${nodeName}`);
    pod.setCondition('Initialized', 'True', 'PodInitialized', '');
    pod.setCondition('ContainersReady', 'True', 'ContainersReady', '');
    pod.setCondition('Ready', 'True', 'PodReady', '');
    pod.status.containerStatuses = (pod.spec.containers || []).map((container) => ({
      name: container.name,
      image: container.image,
      ready: true,
      started: true,
      restartCount: 0,
      state: { running: { startedAt: now } },
      lastState: {},
      resources: {
        cpu: 0,
        memory: 0,
        cpuLimit: parseCpuMillis(container.resources?.limits?.cpu || '0'),
        memoryLimit: parseMemoryMi(container.resources?.limits?.memory || '0'),
        cpuRequest: parseCpuMillis(container.resources?.requests?.cpu || '100m'),
        memoryRequest: parseMemoryMi(container.resources?.requests?.memory || '128Mi'),
      },
    }));
    pod.recordEvent(
      'Normal',
      'Scheduled',
      `Successfully assigned ${seed.namespace}/${seed.name} to ${nodeName}`
    );
    for (const container of pod.spec.containers) {
      pod.recordEvent('Normal', 'Pulling', `Pulling image "${container.image || ''}"`);
    }
    for (const container of pod.spec.containers) {
      pod.recordEvent('Normal', 'Pulled', `Successfully pulled image "${container.image || ''}"`);
    }
    for (const container of pod.spec.containers) {
      pod.recordEvent('Normal', 'Created', `Created container ${container.name || 'main'}`);
      pod.recordEvent('Normal', 'Started', `Started container ${container.name || 'main'}`);
    }
    this.cluster.update(pod.uid, pod);
    return pod;
  }

  _tickPodScheduling(dt) {
    const pods = this.cluster.getByKind('Pod');
    const nodes = this.cluster.getByKind('Node');

    // 1) Unbound Pending pods: normal scheduler path.
    const pendingPods = pods.filter(
      (pod) =>
        pod.status.phase === 'Pending' &&
        !pod.spec.nodeName &&
        !pod.isDeleting &&
        !this._isPodBlocked(pod)
    );
    for (const pod of pendingPods) {
      // Real scheduler retry backoff: a Pod that failed scheduling is not
      // re-evaluated on every tick, it sits in the unschedulable queue until
      // the backoff expires (#57). The first attempt is always immediate.
      if (this._schedulerBackoffPending(pod)) continue;
      const node = this._findBestNode(pod, nodes);
      if (node) {
        this._schedulePodOnNode(pod, node);
      } else {
        this._recordSchedulingFailure(pod, this._schedulingFailureMessage(pod, nodes));
      }
    }

    // 2) Already-bound Pending pods (DaemonSet pods, manifests with
    // spec.nodeName): they skip the scheduler but must still start. Cordoned
    // nodes keep running already-bound pods; only new placement is blocked.
    for (const pod of pods) {
      if (
        pod.status.phase !== 'Pending' ||
        !pod.spec.nodeName ||
        pod.isDeleting ||
        this._isPodBlocked(pod)
      )
        continue;
      if (pod._nodeBound) continue; // already bound; kubelet owns it now
      if (this._schedulerBackoffPending(pod)) continue;
      const node = nodes.find((entry) => entry.metadata.name === pod.spec.nodeName);
      if (!node) {
        this._recordSchedulingFailure(pod, `node "${pod.spec.nodeName}" not found`);
        continue;
      }
      if (!node.isConditionTrue('Ready') || node.status.phase === 'Terminating') {
        this._recordSchedulingFailure(pod, `node "${node.metadata.name}" is not ready`);
        continue;
      }
      this._schedulePodOnNode(pod, node);
    }
  }

  /**
   * True while a Pod that already failed scheduling is still inside the real
   * scheduler's exponential backoff window (#57).
   * @param {object} pod
   * @returns {boolean}
   */
  _schedulerBackoffPending(pod) {
    return (
      typeof pod?._nextSchedulingAttemptAt === 'number' &&
      this.gameSeconds < pod._nextSchedulingAttemptAt
    );
  }

  /**
   * Record one FailedScheduling attempt and schedule the next retry with the
   * real scheduler backoff (1 s initial, doubling, 10 s maximum). This throttles
   * the Event series so `oc describe pod`/`oc get events` aggregate into a
   * realistic `(x4 over 7s)` instead of one Event per tick (#57).
   * @param {object} pod unschedulable Pod
   * @param {string} message scheduler-style rejection message
   */
  _recordSchedulingFailure(pod, message) {
    pod.setCondition('PodScheduled', 'False', 'Unschedulable', message);
    pod.recordEvent('Warning', 'FailedScheduling', message);
    const backoff = Math.min(
      SCHEDULER_MAX_BACKOFF_SECONDS,
      pod._schedulingBackoffSeconds || SCHEDULER_INITIAL_BACKOFF_SECONDS
    );
    pod._schedulingBackoffSeconds = Math.min(SCHEDULER_MAX_BACKOFF_SECONDS, backoff * 2);
    pod._nextSchedulingAttemptAt = this.gameSeconds + backoff;
  }

  /**
   * Bind a Pending pod to a node (shared by the scheduler and DaemonSet
   * controller). The kubelet still has to pull images and start containers:
   * the phase only becomes Running in {@link _tickImagePulls} once every image
   * pull succeeds (an unpullable image leaves the Pod Pending in
   * ErrImagePull/ImagePullBackOff, exactly like a real cluster).
   */
  _schedulePodOnNode(pod, node) {
    if (pod._nodeBound) return pod;
    pod._nodeBound = true;
    // Scheduling succeeded: the Pod leaves the unschedulable queue and its
    // retry backoff state is discarded (a later eviction/reschedule starts a
    // fresh series, like a real scheduler).
    delete pod._schedulingBackoffSeconds;
    delete pod._nextSchedulingAttemptAt;
    pod.spec.nodeName = node.metadata.name;
    pod.status.startTime = pod.status.startTime || new Date().toISOString();
    pod.status.hostIP = node.status.addresses?.[0]?.address || '10.0.0.1';
    // A hostNetwork Pod shares the node's network namespace, so its Pod IP IS
    // the node IP (real kubelet behaviour). Controller-recreated hostNetwork
    // Pods (router-default, node-resolver) used to get a pod-network address
    // here, which made them disagree with the bootstrap Pods and broke the
    // router Service endpoints (#58).
    pod.status.podIP =
      pod.status.podIP ||
      (pod.spec.hostNetwork === true ? pod.status.hostIP : this._generatePodIP(node));
    pod.setCondition(
      'PodScheduled',
      'True',
      'Scheduled',
      `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`
    );
    pod.setCondition('Initialized', 'True', 'PodInitialized');
    pod.setCondition(
      'Ready',
      'False',
      'ContainersNotReady',
      'containers with unready status: [' +
        (pod.spec.containers || []).map((container) => container.name).join(' ') +
        ']'
    );
    this._trackRescheduledPod(pod);
    pod.recordEvent(
      'Normal',
      'Scheduled',
      `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`
    );
    this._initContainerStatuses(pod);
    pod.status.phase = 'Pending';
    this.cluster.update(pod.uid, pod);
    return pod;
  }

  /**
   * Kubelet image-pull controller. Bound pods stay Pending until every
   * container image can be pulled; failures surface as ErrImagePull then
   * ImagePullBackOff container states + kubelet events, never as Running pods.
   */
  _tickImagePulls(dt) {
    const pendingPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Pending' &&
          pod._nodeBound &&
          !pod.isDeleting &&
          !this._isPodBlocked(pod) &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of pendingPods) {
      if (pod._imagePullDone) continue;
      // Kubelet retries failed pulls on backoff; once the image/tag appears the
      // Pod recovers instead of being stuck in ImagePullBackOff forever. While
      // waiting for the next retry the state escalates ErrImagePull ->
      // ImagePullBackOff like a real kubelet (describe/get STATUS).
      const retryDue =
        !pod._imagePullFailed ||
        typeof pod._nextImagePullRetryAt !== 'number' ||
        this.gameSeconds >= pod._nextImagePullRetryAt;
      if (!retryDue) {
        let changed = false;
        for (const status of pod.status.containerStatuses || []) {
          const waitingReason = status.state?.waiting?.reason;
          if (waitingReason === 'ErrImagePull') {
            status.state = {
              waiting: { reason: 'ImagePullBackOff', message: status.state.waiting.message },
            };
            changed = true;
          }
        }
        if (changed) this.cluster.update(pod.uid, pod);
        continue;
      }
      const containers = pod.spec.containers || [];
      if (containers.length === 0) continue;
      if (
        !pod.status.containerStatuses ||
        pod.status.containerStatuses.length !== containers.length
      ) {
        this._initContainerStatuses(pod);
      }
      // Real kubelet event stream (#54e): Pulling appears once when the image
      // pull starts, then Pulled and Created for each container. The order is
      // Scheduled → Pulling → Pulled → Created → Started; there is no kubelet
      // `Ready` event (the Pod Ready condition is status, not an event) and no
      // `PhaseChange` event.
      if (!pod._pullStarted) {
        pod._pullStarted = true;
        for (const container of containers) {
          pod.recordEvent('Normal', 'Pulling', `Pulling image "${container.image || ''}"`);
        }
      }
      const results = containers.map((container) => this._resolveContainerImagePull(container));
      const failure = results.find((result) => !result.ok);
      if (!failure) {
        pod._imagePullDone = true;
        pod._imagePullFailed = false;
        pod._nextImagePullRetryAt = undefined;
        // Containers restart from ContainerCreating before the kubelet starts
        // them (the previous waiting reason may have been ImagePullBackOff).
        this._initContainerStatuses(pod);
        pod.status.phase = 'Running';
        pod.setCondition(
          'Ready',
          'False',
          'ContainersNotReady',
          'containers with unready status: [' +
            containers.map((container) => container.name).join(' ') +
            ']'
        );
        for (const container of containers) {
          pod.recordEvent(
            'Normal',
            'Pulled',
            `Successfully pulled image "${container.image || ''}"`
          );
        }
        for (const container of containers) {
          pod.recordEvent('Normal', 'Created', `Created container ${container.name}`);
        }
        this.cluster.update(pod.uid, pod);
        continue;
      }

      const message = failure.message || 'manifest unknown';
      pod._imagePullFailed = true;
      pod._nextImagePullRetryAt = this.gameSeconds + 10;
      if (typeof pod._imagePullFailedAt !== 'number') pod._imagePullFailedAt = this.gameSeconds;
      const backoff = this.gameSeconds - pod._imagePullFailedAt >= IMAGE_PULL_RETRY_SECONDS;
      const reason = backoff ? 'ImagePullBackOff' : 'ErrImagePull';
      for (let index = 0; index < pod.status.containerStatuses.length; index++) {
        const status = pod.status.containerStatuses[index];
        const containerFailure = results[index] && !results[index].ok ? results[index] : null;
        if (!containerFailure) continue;
        status.ready = false;
        status.started = false;
        status.state = { waiting: { reason, message: containerFailure.message } };
      }
      pod.setCondition(
        'Ready',
        'False',
        'ContainersNotReady',
        `containers with unready status: [${containers.map((container) => container.name).join(' ')}]`
      );
      // kubectl/oc describe show ErrImagePull first, then the exponential
      // ImagePullBackOff retries — throttle duplicate events like a real kubelet.
      const nextLog = pod._imagePullNextEventAt;
      if (typeof nextLog !== 'number' || this.gameSeconds >= nextLog) {
        if (!backoff) {
          pod.recordEvent(
            'Warning',
            'Failed',
            `Failed to pull image "${failure.image}": ${message}`
          );
        } else {
          pod.recordEvent('Normal', 'BackOff', `Back-off pulling image "${failure.image}"`);
          if (!pod._imagePullBackOffLogged) {
            pod._imagePullBackOffLogged = true;
            pod.recordEvent('Warning', 'Failed', `Error: ImagePullBackOff`);
          }
        }
        pod._imagePullNextEventAt = this.gameSeconds + 10;
      }
      this.cluster.update(pod.uid, pod);
    }
  }

  /**
   * Would the container image pull succeed? Mirrors the interesting failure
   * modes of a real cluster:
   *   - internal registry: the ImageStreamTag must exist and have a digest;
   *   - external registries: a small set of obviously-missing references
   *     (does-not-exist / not-found tags, missing repositories) fails, while
   *     public images are assumed pullable (the simulator has no registry).
   * @param {object} container
   * @returns {{ok: boolean, image: string, message?: string}}
   */
  _resolveContainerImagePull(container) {
    const image = String(container?.image || '').trim();
    if (!image) return { ok: false, image, message: 'invalid reference format: image is required' };
    const internal = this._parseInternalImageReference(image);
    if (internal) {
      // A digest-qualified pull spec (`…/ns/stream@sha256:…`) is not an
      // ImageStreamTag: the kubelet asks the registry for that exact digest.
      // It is pullable iff the ImageStream's tag history still references it
      // (issue #70 — a fresh S2I build's Deployment points at its output digest).
      if (internal.digest) {
        if (this._imageStreamHasDigest(internal.namespace, internal.name, internal.digest)) {
          return { ok: true, image };
        }
        return {
          ok: false,
          image,
          message: `reading manifest ${internal.digest} in repository ${internal.namespace}/${internal.name}: manifest unknown`,
        };
      }
      const resolved = this.cluster.resolveImageStreamTag(
        internal.namespace,
        internal.name,
        internal.tag
      );
      const available = Boolean(resolved.found && (resolved.tagEntry?.items || []).length > 0);
      if (!available) {
        return {
          ok: false,
          image,
          message: `reading manifest ${internal.tag} in repository ${internal.namespace}/${internal.name}: manifest unknown`,
        };
      }
      return { ok: true, image };
    }
    const lastSlash = image.lastIndexOf('/');
    const lastColon = image.lastIndexOf(':');
    const tag = lastColon > lastSlash ? image.slice(lastColon + 1) : '';
    const repository = tag ? image.slice(0, lastColon) : image;
    const badTag = IMAGE_PULL_FAILURE_TAG_RE.test(tag) ? tag : '';
    const badRepoMatch = repository.match(IMAGE_PULL_FAILURE_REPO_RE);
    if (badTag || badRepoMatch) {
      return {
        ok: false,
        image,
        message: `failed to resolve reference "${image}": manifest unknown`,
      };
    }
    return { ok: true, image };
  }

  /**
   * Parse an internal-registry pull spec
   * (`image-registry.openshift-image-registry.svc:5000/ns/stream:tag` or
   * `…/ns/stream@sha256:<hex>`). A digest reference is NOT a tag: the caller
   * must resolve it against the ImageStream tag history (issue #70).
   * @returns {{namespace: string, name: string, tag: string, digest: string}|null}
   */
  _parseInternalImageReference(image) {
    const hosts = [
      IMAGE_REGISTRY_HOST,
      'image-registry.openshift-image-registry.svc',
      'docker-registry.default.svc:5000',
    ];
    for (const host of hosts) {
      if (!image.startsWith(`${host}/`)) continue;
      let remainder = image.slice(host.length + 1);
      let digest = '';
      const atIndex = remainder.indexOf('@');
      if (atIndex >= 0) {
        digest = remainder.slice(atIndex + 1);
        remainder = remainder.slice(0, atIndex);
      }
      const parts = remainder.split('/');
      if (parts.length < 2) return null;
      const name = parts[parts.length - 1];
      const namespace = parts[parts.length - 2];
      let tag = digest ? digest : 'latest';
      const colonIndex = name.lastIndexOf(':');
      let streamName = name;
      if (colonIndex > 0) {
        streamName = name.slice(0, colonIndex);
        tag = name.slice(colonIndex + 1);
      }
      return { namespace, name: streamName, tag, digest };
    }
    return null;
  }

  /**
   * Does the ImageStream tag history still reference `digest`? The internal
   * registry keeps every pushed image; a digest pull spec resolves iff one of
   * the tag history items carries that digest (issue #70).
   * @param {string} namespace
   * @param {string} name
   * @param {string} digest `sha256:<hex>`
   * @returns {boolean}
   */
  _imageStreamHasDigest(namespace, name, digest) {
    const wanted = String(digest || '')
      .trim()
      .toLowerCase();
    if (!wanted) return false;
    const imageStream = this.cluster.getImageStream(namespace, name);
    if (!imageStream) return false;
    return (imageStream.status?.tags || []).some((entry) =>
      (entry.items || []).some((item) => {
        const image = String(item?.image || '')
          .trim()
          .toLowerCase();
        const reference = String(item?.dockerImageReference || '');
        return image === wanted || reference.includes(`@${digest}`);
      })
    );
  }

  _trackRescheduledPod(pod) {
    if (pod.metadata.ownerReferences.length === 0) return;
    const ownerKey = pod.metadata.ownerReferences[0]?.uid || pod.metadata.ownerReferences[0]?.name;
    const evictedMap = this.cluster._evictedOwnerCounts;
    if (!evictedMap || !ownerKey || !(evictedMap.get(ownerKey) > 0)) return;
    this.cluster._rescheduledCount = (this.cluster._rescheduledCount || 0) + 1;
    evictedMap.set(ownerKey, evictedMap.get(ownerKey) - 1);
    if (evictedMap.get(ownerKey) <= 0) evictedMap.delete(ownerKey);
  }

  /**
   * Pick the best node for a pod, enforcing cordon, taints/tolerations,
   * nodeSelector, required node affinity, hostPort conflicts and the pod limit.
   * @param {object} pod
   * @param {object[]} [nodes]
   * @returns {object|null}
   */
  _findBestNode(pod, nodes = this.cluster.getByKind('Node')) {
    const requested = this._getPodResourceRequests(pod);
    const nodeSelector = pod.spec.nodeSelector || {};
    const requiredAffinity =
      pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    let bestNode = null;
    let bestScore = -Infinity;

    for (const node of nodes) {
      if (this._nodeUnschedulableReason(node, pod, requested)) continue;
      const available = this._nodeAvailableForScheduling(node);
      if (!available) continue;

      const cpuScore = available.cpu / available.capacityCpu;
      const memScore = available.memory / available.capacityMemory;
      const podCountPenalty = available.podCount * 0.05;
      let score = (cpuScore + memScore) / 2 - podCountPenalty;

      // Untolerated PreferNoSchedule taints bias the scheduler away softly.
      const tolerations = pod.spec.tolerations || [];
      for (const taint of node.spec.taints || []) {
        if (taint.effect !== 'PreferNoSchedule') continue;
        if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint)))
          score -= 0.1;
      }

      if (pod.spec.affinity?.nodeAffinity?.preferredDuringScheduling) {
        for (const preference of pod.spec.affinity.nodeAffinity.preferredDuringScheduling) {
          const matchLabels =
            preference.matchLabels ||
            preference.preference?.matchExpressions?.reduce((acc, expression) => {
              if (expression.operator === 'In' && expression.values?.length)
                acc[expression.key] = expression.values[0];
              return acc;
            }, {}) ||
            {};
          if (node.matchesSelector(matchLabels)) score += (preference.weight || 0) / 100;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }
    return bestNode;
  }

  /** @returns {string|null} why the node cannot host the pod (null = fits). */
  _nodeUnschedulableReason(node, pod, requested = this._getPodResourceRequests(pod)) {
    if (node.status.phase === 'Terminating') return 'node(s) were terminating';
    if (!node.isConditionTrue('Ready')) return 'node(s) were not ready';
    if (node.spec.unschedulable === true || node.isCordon) return 'node(s) were unschedulable';
    if (!node.matchesSelector(pod.spec.nodeSelector || {}))
      // k8s v1.35 node_affinity.go uses this single term for BOTH a
      // nodeSelector and a required node-affinity mismatch (#73/#76).
      return "node(s) didn't match Pod's node affinity/selector";
    const requiredAffinity =
      pod.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    if (requiredAffinity && !this._nodeMatchesRequiredAffinity(node, requiredAffinity))
      return "node(s) didn't match Pod's node affinity/selector";
    const taint = this._firstUntoleratedNoScheduleTaint(pod, node);
    if (taint) return `node(s) had untolerated taint {${taint.key}: ${taint.value ?? ''}}`;
    const available = this._nodeAvailableForScheduling(node);
    if (!available) return 'node(s) were unschedulable';
    const podLimit = parseInt(
      node.status.allocatable?.pods || node.status.capacity?.pods || '110',
      10
    );
    if (Number.isFinite(podLimit) && available.podCount >= podLimit) return 'Too many pods';
    if (this._hasHostPortConflict(node, pod))
      return "node(s) didn't have free ports for the requested pod ports";
    if (available.cpu < requested.cpu) return 'Insufficient cpu';
    if (available.memory < requested.memory) return 'Insufficient memory';
    return null;
  }

  /**
   * Scheduler-style FailedScheduling message summarising why every node was
   * rejected for a pod.
   * @returns {string}
   */
  _schedulingFailureMessage(pod, nodes = this.cluster.getByKind('Node')) {
    const total = nodes.length;
    if (total === 0) return 'no nodes available to schedule pod';
    const requested = this._getPodResourceRequests(pod);
    const reasons = new Map();
    for (const node of nodes) {
      const reason = this._nodeUnschedulableReason(node, pod, requested);
      if (!reason) continue;
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    const detail = Array.from(reasons.entries())
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    return detail
      ? `0/${total} nodes are available: ${detail}.`
      : `0/${total} nodes are available: no node matched the pod requirements.`;
  }

  /** Available resources on a node for scheduling (static allocatable - usage). */
  _nodeAvailableForScheduling(node) {
    const alloc = this.cluster.getNodeAllocatable(node.metadata.name);
    if (!alloc) return null;
    const capacityCpu = alloc.cpu.capacity - Math.min(RESERVED_CPU_MILLICORES, alloc.cpu.capacity);
    const capacityMemory =
      alloc.memory.capacity - Math.min(RESERVED_MEMORY_MIB, alloc.memory.capacity);
    return {
      cpu: capacityCpu - alloc.cpu.used,
      memory: capacityMemory - alloc.memory.used,
      podCount: alloc.podCount,
      capacityCpu: Math.max(1, capacityCpu),
      capacityMemory: Math.max(1, capacityMemory),
    };
  }

  /** First untolerated NoSchedule/NoExecute taint on the node, if any. */
  _firstUntoleratedNoScheduleTaint(pod, node) {
    const tolerations = pod.spec.tolerations || [];
    for (const taint of node.spec.taints || []) {
      if (taint.effect !== 'NoSchedule' && taint.effect !== 'NoExecute') continue;
      if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint))) return taint;
    }
    return null;
  }

  /** First untolerated NoExecute taint (the effect that evicts running pods), if any. */
  _firstUntoleratedNoExecuteTaint(pod, node) {
    const tolerations = pod.spec.tolerations || [];
    for (const taint of node.spec.taints || []) {
      if (taint.effect !== 'NoExecute') continue;
      if (!tolerations.some((toleration) => this._toleratesTaint(toleration, taint))) return taint;
    }
    return null;
  }

  /** Does a single toleration tolerate a taint? */
  _toleratesTaint(toleration, taint) {
    if (!toleration || !taint) return false;
    const operator = toleration.operator || 'Equal';
    const effect = toleration.effect || '';
    if (effect && effect !== taint.effect) return false;
    const key = toleration.key || '';
    if (operator === 'Exists') return !key || key === taint.key;
    if (key !== taint.key) return false;
    return String(toleration.value ?? '') === String(taint.value ?? '');
  }

  /** Required node affinity: any nodeSelectorTerm may match. */
  _nodeMatchesRequiredAffinity(node, required) {
    const terms = required?.nodeSelectorTerms || [];
    if (terms.length === 0) return true;
    return terms.some((term) => {
      if (!term || typeof term !== 'object') return false;
      const expressions = term.matchExpressions || [];
      const fields = term.matchFields || [];
      return (
        expressions.every((expression) =>
          this._labelsMatchExpression(node.metadata.labels || {}, expression)
        ) && fields.every((expression) => this._nodeFieldMatchesExpression(node, expression))
      );
    });
  }

  _labelsMatchExpression(labels, expression) {
    const actual = labels?.[expression.key];
    const values = expression.values || [];
    switch (expression.operator) {
      case 'In':
        return actual !== undefined && values.includes(actual);
      case 'NotIn':
        return actual === undefined || !values.includes(actual);
      case 'Exists':
        return actual !== undefined;
      case 'DoesNotExist':
        return actual === undefined;
      case 'Gt':
        return actual !== undefined && Number(actual) > Number(values[0]);
      case 'Lt':
        return actual !== undefined && Number(actual) < Number(values[0]);
      default:
        return false;
    }
  }

  _nodeFieldMatchesExpression(node, expression) {
    if (expression.key !== 'metadata.name') return false;
    const values = expression.values || [];
    switch (expression.operator) {
      case 'In':
        return values.includes(node.metadata.name);
      case 'NotIn':
        return !values.includes(node.metadata.name);
      default:
        return false;
    }
  }

  /** True when a requested hostPort is already taken on the node. */
  _hasHostPortConflict(node, pod) {
    const used = new Set();
    for (const other of this.cluster.getByKind('Pod')) {
      if (other === pod || other.spec.nodeName !== node.metadata.name) continue;
      if (other.status.phase !== 'Running' && other.status.phase !== 'Pending') continue;
      for (const container of other.spec.containers || []) {
        for (const port of container.ports || []) {
          if (port.hostPort) used.add(`${port.protocol || 'TCP'}:${port.hostPort}`);
        }
      }
    }
    for (const container of pod.spec.containers || []) {
      for (const port of container.ports || []) {
        if (port.hostPort && used.has(`${port.protocol || 'TCP'}:${port.hostPort}`)) return true;
      }
    }
    return false;
  }

  _getPodResourceRequests(pod) {
    let cpu = 0;
    let memory = 0;
    for (const container of pod.spec.containers || []) {
      cpu += parseCpuMillis(container.resources?.requests?.cpu || '100m');
      memory += parseMemoryMi(container.resources?.requests?.memory || '128Mi');
    }
    return { cpu, memory };
  }

  _getPodResourceLimits(pod) {
    let cpu = 0;
    let memory = 0;
    for (const container of pod.spec.containers || []) {
      cpu += parseCpuMillis(container.resources?.limits?.cpu || '0');
      memory += parseMemoryMi(container.resources?.limits?.memory || '0');
    }
    return { cpu, memory };
  }

  _initContainerStatuses(pod) {
    pod.status.containerStatuses = (pod.spec.containers || []).map((container) => ({
      name: container.name,
      image: container.image || 'unknown:latest',
      ready: false,
      started: false,
      restartCount: 0,
      state: { waiting: { reason: 'ContainerCreating' } },
      lastState: {},
      resources: {
        cpu: 0,
        memory: 0,
        cpuLimit: parseCpuMillis(container.resources?.limits?.cpu || '0'),
        memoryLimit: parseMemoryMi(container.resources?.limits?.memory || '0'),
        cpuRequest: parseCpuMillis(container.resources?.requests?.cpu || '100m'),
        memoryRequest: parseMemoryMi(container.resources?.requests?.memory || '128Mi'),
      },
    }));
  }

  /** True for Pods the IncidentEngine is actively managing (damaged state). */
  _isIncidentControlled(pod) {
    return Boolean(pod?.metadata?.annotations?.['openshiftgames.io/incident']);
  }

  /** Does an SCC's runAsUser strategy permit UID 0? (anyuid/privileged yes,
   * restricted-v2/nonroot no). Used by the known-root-image runtime model. */
  _sccAllowsUidZero(scc) {
    if (!scc) return false;
    return runAsUserAllowed(scc.spec?.runAsUser, 0);
  }

  /**
   * The SCC that admitted a Pod. `openshift.io/scc` is written by `_tickSCC` for
   * every admitted Pod; a Pod created between controller ticks (bare `oc run`)
   * is resolved exactly like admission would, without mutating anything.
   * @param {object} pod
   * @returns {object|null}
   */
  _podScc(pod) {
    const admittedName = pod?.metadata?.annotations?.['openshift.io/scc'];
    if (admittedName) {
      const admitted = this.cluster.getSCC(admittedName);
      if (admitted) return admitted;
    }
    const resolution = this.cluster.resolveSCCForPod(pod);
    return resolution.allowed ? resolution.scc : null;
  }

  /**
   * Known image personalities at runtime. Two families exist (#25, #31):
   *  - `nonroot-scc` (nginx): an image that starts as UID 0 is happily ADMITTED
   *    by a non-root SCC — admission only checks the explicit pod spec — but the
   *    container cannot run with the arbitrary UID and exits with "Permission
   *    denied";
   *  - `missing-env` (MySQL): the image starts but the entrypoint aborts until
   *    database credentials are supplied in the environment (`oc set env` then
   *    rolling out new Pods is the real fix).
   * Returns the image runtime failure persona when it applies, otherwise null.
   *
   * @param {object} pod
   * @param {object} container
   * @returns {{exitCode: number, lastStateReason: string, logLines: string[]}|null}
   */
  _knownImageRuntimeFailure(pod, container) {
    const profile = knownImageSecurityProfile(container?.image);
    if (!profile?.runtimeFailure) return null;
    if (profile.failureMode === 'missing-env') {
      // Configuration-driven crash: independent of the SCC; a new rollout Pod
      // with the credentials in its env starts normally.
      return imageEnvironmentSatisfied(container, profile) ? null : profile.runtimeFailure;
    }
    const scc = this._podScc(pod);
    if (!scc) return null;
    // anyuid/privileged admit the root UID the image expects: it runs normally.
    if (this._sccAllowsUidZero(scc)) return null;
    return profile.runtimeFailure;
  }

  /**
   * The simulated demo application validates `APP_MODE` at startup: an
   * unsupported static value (`debug-invalid`) makes the container exit 1 on its
   * FIRST start — it never "runs fine and crashes later" when the incident
   * fires (issues #75 L3 / #76). Returns the crash persona or null.
   * @param {object} container
   * @returns {{exitCode: number, lastStateReason: string, logLines: string[]}|null}
   */
  _knownEnvRuntimeFailure(container) {
    for (const entry of container?.env || []) {
      if (entry?.name !== 'APP_MODE' || entry.valueFrom) continue;
      const value = String(entry.value ?? '').trim();
      if (APP_MODE_ALLOWED_VALUES.has(value)) return null;
      return { exitCode: 1, lastStateReason: 'Error', logLines: INVALID_APP_MODE_LOG_LINES };
    }
    return null;
  }

  /**
   * Model a kubelet-side container crash: the process exits non-zero, the Pod
   * keeps its Running phase with a CrashLoopBackOff container state, the kubelet
   * restarts it on its real 10s/20s/40s… back-off and the crash output is
   * available to `oc logs` / `oc logs --previous` (issues #25/#75/#76).
   *
   * `restartCount` tracks COMPLETED restarts (k8s semantics): right after the
   * first crash the CLI shows RESTARTS 0 / CrashLoopBackOff and the first
   * restart happens 10s later, so "RESTARTS 2 at AGE 5s" is impossible.
   * @param {object} pod
   * @param {object} status container status
   * @param {{exitCode?: number, lastStateReason?: string, logLines?: string[]}} failure
   * @returns {object}
   */
  _crashContainerWithFailure(pod, status, failure) {
    // The container will be restarted by the CrashLoopBackOff loop: clear the
    // kubelet probe window so initial delays/thresholds apply to the new start.
    this._resetProbeState(status);
    const now = new Date().toISOString();
    status.ready = false;
    status.started = false;
    status.lastState = {
      terminated: {
        exitCode: failure.exitCode ?? 1,
        reason: failure.lastStateReason || 'Error',
        startedAt: now,
        finishedAt: now,
      },
    };
    const lines = Array.isArray(failure.logLines) ? failure.logLines : [];
    if (lines.length > 0) {
      // The CLI renders these annotations for `oc logs`/`oc logs --previous`
      // (same mechanism as the IncidentEngine's scripted crash logs).
      pod.setAnnotation('openshiftgames.io/logs', JSON.stringify(lines));
      pod.setAnnotation('openshiftgames.io/logs-previous', JSON.stringify(lines));
      pod.setAnnotation('openshiftgames.io/logs-container', status.name);
    }
    const restartPolicy = pod.spec.restartPolicy || 'Always';
    if (restartPolicy === 'Never') {
      // Job/batch Pods never restart: the container stays Terminated and the
      // Pod becomes Failed (SIM-011).
      status.state = {
        terminated: {
          exitCode: failure.exitCode ?? 1,
          reason: failure.lastStateReason || 'Error',
          finishedAt: now,
        },
      };
      pod.status.phase = 'Failed';
      pod.setCondition('ContainersReady', 'False', 'ContainersNotReady', 'container failed');
      pod.setCondition('Ready', 'False', 'ContainersNotReady', 'container failed');
      pod.recordEvent(
        'Warning',
        'Failed',
        `Container ${status.name} failed with restartPolicy: Never`
      );
      this.cluster.update(pod.uid, pod);
      return status;
    }
    status.state = { waiting: { reason: 'CrashLoopBackOff' } };
    status._lastCrashAtGameSeconds = this.gameSeconds;
    status._nextRestartAt =
      this.gameSeconds + this._crashBackoffDelaySeconds(status.restartCount || 0);
    // Real kubelet BackOff events are aggregated by the events recorder into the
    // familiar `(x3 over 50s)` series.
    pod.recordEvent(
      'Warning',
      'BackOff',
      `Back-off restarting failed container ${status.name} in pod ${pod.metadata.name}_${pod.metadata.namespace || 'default'}`
    );
    this.cluster.update(pod.uid, pod);
    return status;
  }

  /** Kubelet delay before restart attempt number `restartCount + 1`. */
  _crashBackoffDelaySeconds(restartCount) {
    const exponent = Math.max(0, Number(restartCount) || 0);
    return Math.min(CRASH_BACKOFF_MAX_SECONDS, CRASH_BACKOFF_BASE_SECONDS * 2 ** exponent);
  }

  /**
   * Pod age (game seconds) at which the NEXT restart attempt happens for a
   * container that has already completed `restartCount` restarts: the kubelet
   * waits 10 s, then 20 s, 40 s … after each crash.
   */
  _nextRestartAgeSeconds(restartCount) {
    let total = 0;
    for (let index = 0; index <= restartCount; index += 1) {
      total += this._crashBackoffDelaySeconds(index);
    }
    return total;
  }

  /** How many restarts the kubelet could physically have made in `ageSeconds`. */
  _maxKubeletRestartsForAge(ageSeconds) {
    let count = 0;
    let total = 0;
    while (count < 64) {
      const delay = this._crashBackoffDelaySeconds(count);
      if (total + delay > ageSeconds) break;
      total += delay;
      count += 1;
    }
    return count;
  }

  /** When a Pod was created in game seconds (controllers stamp this on create). */
  _podCreatedAtGameSeconds(pod) {
    if (typeof pod?._createdAtGameSeconds === 'number') return pod._createdAtGameSeconds;
    // Seeded/legacy Pods exist from the moment the level starts (game time 0).
    return 0;
  }

  /** Pod age in game seconds (the timeline every controller timer uses). */
  _podAgeSeconds(pod) {
    return Math.max(0, this.gameSeconds - this._podCreatedAtGameSeconds(pod));
  }

  /**
   * Enforce physical consistency for a CrashLooping container (issue #76):
   * RESTARTS can never exceed the kubelet back-off schedule possible within the
   * Pod's AGE. Damaged/seeded Pods that claim impossible counts (e.g. RESTARTS 2
   * at AGE 5s) are clamped, and the next restart attempt is pinned to the real
   * schedule timestamp.
   * @param {object} pod
   * @param {object} status container status in waiting/CrashLoopBackOff
   */
  _reconcileCrashLoopState(pod, status) {
    const age = this._podAgeSeconds(pod);
    const maxRestarts = this._maxKubeletRestartsForAge(age);
    if ((status.restartCount || 0) > maxRestarts) status.restartCount = maxRestarts;
    if (typeof status._nextRestartAt !== 'number') {
      const scheduledAt =
        this._podCreatedAtGameSeconds(pod) + this._nextRestartAgeSeconds(status.restartCount || 0);
      // Overdue attempts happen on the next tick; future ones at their real time.
      status._nextRestartAt = Math.max(this.gameSeconds, scheduledAt);
    }
    status._nextRestartAt = Math.max(
      status._nextRestartAt,
      this.gameSeconds // never schedule a restart in the past
    );
  }

  _tickPodLifecycle(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter((pod) => pod.status.phase === 'Running' && !this._isIncidentControlled(pod));
    for (const pod of runningPods) {
      if (!pod.status.containerStatuses) continue;
      const containers = pod.spec.containers || [];
      let allReady = true;
      let anyRunning = false;

      for (let index = 0; index < pod.status.containerStatuses.length; index++) {
        const status = pod.status.containerStatuses[index];
        const container = containers[index] || {};
        // Container-level startup failures crash as soon as the container
        // starts (the real kubelet never "runs fine then breaks later"):
        //  - a static invalid APP_MODE makes the demo app exit 1 on first start
        //    (#75 L3), and
        //  - known root images admitted by a non-root SCC exit with Permission
        //    denied (issue #25).
        const runtimeFailure =
          this._knownEnvRuntimeFailure(container) || this._knownImageRuntimeFailure(pod, container);
        if (
          runtimeFailure &&
          (status.state.running || status.state.waiting?.reason === 'ContainerCreating')
        ) {
          this._crashContainerWithFailure(pod, status, runtimeFailure);
          allReady = false;
          continue;
        }
        if (status.state.waiting) {
          if (status.state.waiting.reason === 'ContainerCreating') {
            status.state = { running: { startedAt: new Date().toISOString() } };
            status.started = true;
            status.ready = false;
            pod.recordEvent('Normal', 'Started', `Started container ${status.name}`);
          } else if (status.state.waiting.reason === 'CrashLoopBackOff') {
            this._reconcileCrashLoopState(pod, status);
            if (this.gameSeconds >= status._nextRestartAt) {
              // The kubelet's back-off expired: this is a COMPLETED restart, so
              // RESTARTS increments now (never at crash time).
              status.restartCount = (status.restartCount || 0) + 1;
              status.state = { running: { startedAt: new Date().toISOString() } };
              status.started = true;
              status.ready = false;
              delete status._nextRestartAt;
              pod.recordEvent('Normal', 'Started', `Started container ${status.name}`);
            }
            allReady = false;
            continue;
          }
        }
        if (status.state.running) {
          anyRunning = true;
          // Containers with a readinessProbe are owned by _tickHealthChecks:
          // never auto-ready them here (SIM-019). Becoming Ready is a status
          // condition change, NOT a kubelet event (issue #54e: no `Ready`
          // event reason — real kubelet emits Scheduled/Pulling/Pulled/
          // Created/Started).
          const startupPending = Boolean(container.startupProbe) && !status._startupComplete;
          if (!status.ready && status.started && !container.readinessProbe && !startupPending) {
            status.ready = true;
          }
        }
        if (!status.ready) allReady = false;
      }

      const wasReady = pod.isConditionTrue('Ready');
      if (allReady && anyRunning) {
        pod.setCondition('ContainersReady', 'True', 'ContainersReady');
        pod.setCondition('Ready', 'True', 'PodReady');
        if (!wasReady) pod._readyAt = this.gameSeconds;
      } else {
        pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
        if (wasReady) pod._readyAt = undefined;
      }

      if (pod.isDeleting) {
        // terminationGracePeriodSeconds: 0 is valid and means "kill now"
        // (the old `|| 30` treated 0 as unset).
        const rawGrace = pod.spec.terminationGracePeriodSeconds;
        const gracePeriod = typeof rawGrace === 'number' ? rawGrace : 30;
        const deletionTime = new Date(pod.metadata.deletionTimestamp).getTime();
        if (Date.now() - deletionTime > gracePeriod * 1000 * (1 / this.tickRate)) {
          pod.status.phase = 'Succeeded';
          pod.removeFinalizer('kubernetes');
        }
      }
    }
  }

  /** Effective per-second per-container random failure probability (SIM-027). */
  _effectiveFailureRatePerSecond() {
    const rate = Number(this.randomFailureRate);
    if (!(rate > 0)) return 0;
    const reference = Number(this.randomFailureRateReference) || 0.002;
    const base = Number(this.randomFailureRatePerSecond);
    if (!(base > 0)) return 0;
    return base * (rate / reference);
  }

  /**
   * Apply a container failure honouring the pod restart policy. With
   * `restartPolicy: Never` the container stays terminated and the pod becomes
   * `Failed` (a Job pod must fail instead of restarting forever, SIM-011).
   */
  _handleContainerFailure(pod, status, reason, exitCode) {
    // A restarted container gets a fresh kubelet probe window: initial delays
    // are measured from the new start, failed/successful counts restart and a
    // startup probe must succeed again (issue #67).
    this._resetProbeState(status);
    const now = new Date().toISOString();
    status.ready = false;
    status.started = false;
    status.lastState = { terminated: { exitCode, reason, startedAt: now, finishedAt: now } };
    const restartPolicy = pod.spec.restartPolicy || 'Always';
    if (restartPolicy === 'Never') {
      status.state = { terminated: { exitCode, reason, finishedAt: now } };
      pod.status.phase = 'Failed';
      pod.setCondition(
        'ContainersReady',
        'False',
        'ContainersNotReady',
        `container ${status.name} ${String(reason).toLowerCase()}`
      );
      pod.setCondition(
        'Ready',
        'False',
        'ContainersNotReady',
        `container ${status.name} ${String(reason).toLowerCase()}`
      );
      pod.recordEvent(
        'Warning',
        reason === 'OOMKilled' ? 'OOMKilled' : 'Failed',
        `Container ${status.name} failed (${reason}) with restartPolicy: Never`
      );
    } else {
      status.state = { waiting: { reason: 'CrashLoopBackOff' } };
      status._lastCrashAtGameSeconds = this.gameSeconds;
      status._nextRestartAt =
        this.gameSeconds + this._crashBackoffDelaySeconds(status.restartCount || 0);
      pod.recordEvent('Warning', 'BackOff', `Back-off restarting failed container ${status.name}`);
    }
    return status;
  }

  _tickContainerResources(dt) {
    const failureRate = this._effectiveFailureRatePerSecond();
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        // Defensive: a container status created by an incident/legacy path may
        // predate the kubelet resource accounting (the Pod constructor no longer
        // fabricates pre-bind statuses — issue #60).
        if (!status.resources) continue;
        const baseLoad = status.resources.cpuRequest * 0.6;
        const variance = status.resources.cpuRequest * 0.3;
        status.resources.cpu = Math.max(0, baseLoad + (Math.random() - 0.5) * variance);
        // Smoothed CPU sample (HPA/metrics read an averaged window, not a
        // single instantaneous sample; avoids noise-driven rescales).
        status._cpuSmooth =
          status._cpuSmooth === undefined
            ? status.resources.cpu
            : status._cpuSmooth * 0.9 + status.resources.cpu * 0.1;
        const memBase = status.resources.memoryRequest * 0.7;
        const memGrowth = status.resources.memoryRequest * 0.01 * Math.random();
        // Synthetic memory creeps up but must not exceed a configured limit on
        // its own: a healthy Guaranteed pod should not OOM just because time
        // passed (SIM-027). Chaos/incidents can still push it over the limit.
        const memoryCeiling =
          status.resources.memoryLimit > 0
            ? status.resources.memoryLimit * 0.95
            : status.resources.memoryRequest * 2;
        status.resources.memory = Math.min(
          memoryCeiling,
          memBase +
            memGrowth +
            (status.resources.memory > memBase ? (status.resources.memory - memBase) * 0.99 : 0)
        );

        if (failureRate > 0 && Math.random() < failureRate * dt) {
          this._handleContainerFailure(pod, status, 'Error', 1);
        }
      }
    }
  }

  /**
   * Inject the simulated container exec runner used to evaluate kubelet exec
   * probes (issue #67). The browser registers `CommandBar._simulateExecCommand`
   * from `index.html`, so a probe command sees exactly the same simulated
   * container filesystem, environment and exit codes as `oc exec`. When no
   * evaluator is injected (bare Node engine) {@link _fallbackExecProbe} keeps
   * exec probes deterministic instead of throwing.
   * @param {((pod: object, containerName: string, argv: string[]) => {lines?: string[], exitCode?: number})|null} evaluator
   * @returns {this}
   */
  setContainerExecEvaluator(evaluator) {
    this.containerExecEvaluator = typeof evaluator === 'function' ? evaluator : null;
    return this;
  }

  /** Clear all probe bookkeeping for a container (new start / restart). */
  _resetProbeState(status) {
    if (!status || typeof status !== 'object') return;
    delete status._probes;
    delete status._runningSince;
    delete status._probeRunSignature;
    delete status._startupComplete;
  }

  /**
   * The kubelet measures probe timing (`initialDelaySeconds`, `periodSeconds`)
   * from the moment it first observes a RUNNING container. A (re)start begins a
   * new window and discards the previous failure/readiness probe results
   * (issue #67).
   * @param {object} status containerStatus
   */
  _ensureProbeWindow(status) {
    const signature = status.state?.running?.startedAt;
    if (typeof status._runningSince !== 'number' || status._probeRunSignature !== signature) {
      status._runningSince = this.gameSeconds;
      status._probeRunSignature = signature;
      status._probes = {};
      delete status._startupComplete;
    }
  }

  /** Per-probe consecutive success/failure counters + event throttle clock. */
  _probeState(status, kind) {
    if (!status._probes || typeof status._probes !== 'object') status._probes = {};
    if (!status._probes[kind]) {
      status._probes[kind] = {
        failures: 0,
        successes: 0,
        lastEvalAt: undefined,
        failed: false,
        lastEventAt: undefined,
      };
    }
    return status._probes[kind];
  }

  /**
   * Evaluate one probe handler on the kubelet schedule: the first attempt
   * happens `initialDelaySeconds` after the container started, later attempts
   * every `periodSeconds` (all in simulated `gameSeconds`). Consecutive
   * failures/successes are thresholded like the real kubelet (issue #67).
   * @param {'liveness'|'readiness'|'startup'} kind
   * @param {object} probe container spec probe (`livenessProbe`, ...)
   * @param {object} pod
   * @param {object} container pod.spec.containers entry
   * @param {object} status pod.status.containerStatuses entry
   * @returns {{evaluated: boolean, ok: boolean, failed: boolean, healthy: boolean, detail: string, justFailed: boolean, justRecovered: boolean}}
   */
  _runProbe(kind, probe, pod, container, status) {
    const state = this._probeState(status, kind);
    const initialDelay = Math.max(0, Number(probe.initialDelaySeconds ?? 0) || 0);
    const period = Math.max(1, Number(probe.periodSeconds ?? 10) || 10);
    const successThreshold = Math.max(1, Math.trunc(Number(probe.successThreshold ?? 1) || 1));
    const failureThreshold = Math.max(1, Math.trunc(Number(probe.failureThreshold ?? 3) || 3));
    const pending = () => ({
      evaluated: false,
      ok: false,
      failed: state.failed,
      healthy: !state.failed && state.successes >= successThreshold,
      detail: '',
      justFailed: false,
      justRecovered: false,
    });
    const runningSince =
      typeof status._runningSince === 'number' ? status._runningSince : this.gameSeconds;
    if (this.gameSeconds - runningSince < initialDelay) return pending();
    if (state.lastEvalAt !== undefined && this.gameSeconds - state.lastEvalAt < period) {
      return pending();
    }
    state.lastEvalAt = this.gameSeconds;
    const wasFailed = state.failed;
    const result = this._evaluateProbeHandler(probe, pod, container, status);
    if (result.ok) {
      state.successes += 1;
      state.failures = 0;
      if (state.successes >= successThreshold) state.failed = false;
    } else {
      state.failures += 1;
      state.successes = 0;
      if (state.failures >= failureThreshold) state.failed = true;
    }
    return {
      evaluated: true,
      ok: result.ok,
      failed: state.failed,
      healthy: !state.failed && state.successes >= successThreshold,
      detail: result.detail || '',
      justFailed: !wasFailed && state.failed,
      justRecovered: wasFailed && !state.failed,
    };
  }

  /**
   * Evaluate a probe handler against the simulated container. Returns
   * `{ok, detail}`: `detail` is the exact kubelet failure text used in the
   * `Warning Unhealthy` event.
   * @param {object} probe
   * @param {object} pod
   * @param {object} container
   * @param {object} status
   * @returns {{ok: boolean, detail: string}}
   */
  _evaluateProbeHandler(probe, pod, container, status) {
    // Sim-only additional failure reason (chaos stress): a container pushed
    // over its CPU/memory limit also fails its probes — thresholded like every
    // other failure by `_runProbe` (kept from the pre-#67 model).
    const resources = status.resources || {};
    const cpuOverloaded = resources.cpuLimit > 0 && resources.cpu > resources.cpuLimit * 0.95;
    const memOverloaded =
      resources.memoryLimit > 0 && resources.memory > resources.memoryLimit * 0.95;
    if (cpuOverloaded || memOverloaded) {
      return {
        ok: false,
        detail: cpuOverloaded
          ? 'container CPU usage exceeded its limit'
          : 'container memory usage exceeded its limit',
      };
    }
    if (probe.exec) return this._evaluateExecProbe(probe.exec, pod, container, status);
    if (probe.httpGet) return this._evaluateHttpGetProbe(probe.httpGet, pod, container);
    if (probe.tcpSocket) return this._evaluateTcpSocketProbe(probe.tcpSocket, pod);
    // Unknown handler (e.g. grpc): never fabricate a failure.
    return { ok: true, detail: '' };
  }

  /**
   * "Is this probe port accepting TCP connections?" model (issue #67).
   * Containers in a Pod share the network namespace, so ANY container's
   * declared `ports[].containerPort` opens the port. A Pod that declares NO
   * ports at all is the permissive legacy fallback (hand-built fixtures with no
   * port metadata) — only a Pod WITH declared ports can refuse a probe port.
   * Named ports resolve cluster-side across every container in the Pod.
   * @param {object} pod
   * @param {number|string} rawPort probe port (numeric or named)
   * @returns {{open: boolean, port: number|string}}
   */
  _probePortState(pod, rawPort) {
    const declared = [];
    for (const container of pod.spec?.containers || []) {
      for (const port of container.ports || []) declared.push(port);
    }
    const text = String(rawPort ?? '');
    if (/^\d+$/.test(text)) {
      const port = Number(text);
      if (declared.length === 0) return { open: true, port };
      return { open: declared.some((entry) => Number(entry.containerPort) === port), port };
    }
    const named = declared.find((entry) => String(entry.name || '') === text);
    if (named) return { open: true, port: Number(named.containerPort) };
    return { open: declared.length === 0, port: text };
  }

  /** HTTP GET probe: port refusal or the simulated app's status code. */
  _evaluateHttpGetProbe(action, pod, container) {
    const portState = this._probePortState(pod, action.port);
    const scheme = String(action.scheme || 'HTTP').toLowerCase();
    const host = action.host ? String(action.host) : String(pod.status?.podIP || '0.0.0.0');
    const path = String(action.path || '/');
    if (!portState.open) {
      return {
        ok: false,
        detail: `Get "${scheme}://${host}:${portState.port}${path}": dial tcp ${host}:${portState.port}: connect: connection refused`,
      };
    }
    const image = String(container?.image || '');
    // hello-openshift is a Go catch-all handler: every path answers 200.
    if (/hello-openshift/.test(image)) return { ok: true, detail: '' };
    // The simulated HTTP app serves `/` and the conventional health endpoints;
    // any other path is the app's 404 (httpd/nginx-style static application).
    const served = ['/', '/healthz', '/health', '/readyz', '/ready', '/livez', '/live'];
    if (served.includes(path)) return { ok: true, detail: '' };
    return { ok: false, detail: 'HTTP probe failed with statuscode: 404' };
  }

  /** TCP socket probe: connection accepted iff the port is declared/open. */
  _evaluateTcpSocketProbe(action, pod) {
    const portState = this._probePortState(pod, action.port);
    const host = action.host ? String(action.host) : String(pod.status?.podIP || '0.0.0.0');
    if (portState.open) return { ok: true, detail: '' };
    return {
      ok: false,
      detail: `dial tcp ${host}:${portState.port}: connect: connection refused`,
    };
  }

  /**
   * Exec probe: run the stored argv through the injected container exec
   * evaluator (`CommandBar._simulateExecCommand` in the browser) so the probe
   * sees the same simulated container filesystem/env as `oc exec` (issue #67).
   * Success is exit code 0; the failure detail is the command's output.
   */
  _evaluateExecProbe(action, pod, container, status) {
    const argv = Array.isArray(action.command) ? action.command.map((token) => String(token)) : [];
    if (!argv.length) return { ok: false, detail: 'exec probe has no command' };
    const containerName = container?.name || status?.name || 'main';
    let result;
    if (this.containerExecEvaluator) {
      try {
        result = this.containerExecEvaluator(pod, containerName, [...argv]);
      } catch (err) {
        return { ok: false, detail: `exec probe failed: ${err.message}` };
      }
    } else {
      result = this._fallbackExecProbe(argv);
    }
    const exitCode = Number.isFinite(Number(result?.exitCode)) ? Number(result.exitCode) : 1;
    if (exitCode === 0) return { ok: true, detail: '' };
    const lines = Array.isArray(result?.lines) ? result.lines.map((line) => String(line)) : [];
    const output = lines.join('\n').trim();
    // Command-not-found: keep kubelet's short `exec: "<bin>": ...` suffix
    // instead of the CLI's `oc exec` wrapper text.
    const notFound = output.match(/exec: "[^"]+": executable file not found in \$PATH/);
    return { ok: false, detail: notFound ? notFound[0] : output };
  }

  /**
   * Safe exec-probe fallback when no container exec evaluator is registered
   * (bare Node engine): minimal deterministic container binaries so exec probes
   * never throw. There is no modelled filesystem here, so `cat <path>` is
   * always ENOENT — exactly the `/tmp/healthy` probe case.
   * @param {string[]} argv
   * @returns {{lines: string[], exitCode: number}}
   */
  _fallbackExecProbe(argv) {
    const binary = String(argv[0] ?? '')
      .split('/')
      .pop()
      .toLowerCase();
    const args = argv.slice(1);
    if (binary === 'true') return { lines: [], exitCode: 0 };
    if (binary === 'false') return { lines: [], exitCode: 1 };
    if (binary === 'cat') {
      if (!args.length) return { lines: ['cat: missing operand'], exitCode: 1 };
      return {
        lines: args.map((path) => `cat: ${path}: No such file or directory`),
        exitCode: 1,
      };
    }
    return { lines: [`exec: "${binary}": executable file not found in $PATH`], exitCode: 127 };
  }

  /**
   * Record the kubelet `Warning Unhealthy` event for a failed probe evaluation.
   * Repeated identical failures are throttled to one event per ~10 simulated
   * seconds (EventRecorder aggregation); the transition into the failed state
   * always records immediately.
   */
  _recordProbeFailure(pod, status, kindLabel, outcome, probeKind, force = false) {
    const state = this._probeState(status, probeKind);
    if (
      !force &&
      typeof state.lastEventAt === 'number' &&
      this.gameSeconds - state.lastEventAt < 10
    ) {
      return;
    }
    state.lastEventAt = this.gameSeconds;
    pod.recordEvent('Warning', 'Unhealthy', `${kindLabel} probe failed: ${outcome.detail}`);
  }

  _tickHealthChecks(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of runningPods) {
      const containers = pod.spec.containers || [];
      for (let index = 0; index < containers.length; index++) {
        const container = containers[index];
        const status = pod.status.containerStatuses[index];
        if (!status || !status.state.running) continue;
        // Only containers with probes need probe bookkeeping (keeps the
        // kubelet status of ordinary containers free of simulator-only fields).
        if (!container.livenessProbe && !container.readinessProbe && !container.startupProbe) {
          continue;
        }
        this._ensureProbeWindow(status);

        // kubelet startup-probe phase: while the startup probe has not
        // succeeded, ONLY it runs and the container stays not-Ready.
        if (container.startupProbe && !status._startupComplete) {
          const outcome = this._runProbe('startup', container.startupProbe, pod, container, status);
          if (outcome.evaluated && !outcome.ok) {
            this._recordProbeFailure(
              pod,
              status,
              'Startup',
              outcome,
              'startup',
              outcome.justFailed
            );
          }
          if (outcome.evaluated && outcome.failed) {
            // Failed startup probe: kubelet restarts the container (137) and
            // records the real `Killing` event.
            this._handleContainerFailure(pod, status, 'Error', 137);
            pod.recordEvent(
              'Normal',
              'Killing',
              `Container ${status.name} failed startup probe, will be restarted`
            );
            this.cluster.update(pod.uid, pod);
            continue;
          }
          if (!outcome.healthy) {
            status.ready = false;
            continue;
          }
          status._startupComplete = true;
          // With no readiness probe the container becomes Ready as soon as the
          // startup probe succeeds; do it in this same tick (kubelet semantics).
          if (!container.readinessProbe) status.ready = true;
        }

        if (container.livenessProbe) {
          const outcome = this._runProbe(
            'liveness',
            container.livenessProbe,
            pod,
            container,
            status
          );
          if (outcome.evaluated && !outcome.ok) {
            this._recordProbeFailure(
              pod,
              status,
              'Liveness',
              outcome,
              'liveness',
              outcome.justFailed
            );
          }
          if (outcome.evaluated && outcome.failed) {
            // Real kubelet restarts a container whose liveness probe failed:
            // exit code 137, lastState.terminated.reason `Error` (NOT
            // `LivenessProbeFailure`), then a `Killing` event with this exact
            // message. `_handleContainerFailure` owns RESTARTS/backoff.
            this._handleContainerFailure(pod, status, 'Error', 137);
            pod.recordEvent(
              'Normal',
              'Killing',
              `Container ${status.name} failed liveness probe, will be restarted`
            );
            this.cluster.update(pod.uid, pod);
            // Never evaluate readiness in the same tick after a restart.
            continue;
          }
        }

        if (container.readinessProbe) {
          const outcome = this._runProbe(
            'readiness',
            container.readinessProbe,
            pod,
            container,
            status
          );
          if (outcome.evaluated && !outcome.ok) {
            const wasReady = status.ready;
            if (outcome.failed) status.ready = false;
            this._recordProbeFailure(
              pod,
              status,
              'Readiness',
              outcome,
              'readiness',
              outcome.justFailed || wasReady
            );
          } else if (outcome.healthy) {
            // Recovery: the condition update below repopulates the Pod Ready
            // condition and Service endpoints in this same tick (SIM-019).
            status.ready = true;
          }
        }
      }

      // Readiness-probe results must reach the Pod Ready condition (and thus
      // Service endpoints) in the same tick (SIM-019).
      const statuses = pod.status.containerStatuses || [];
      const anyRunning = statuses.some((status) => status.state?.running);
      const allReady = statuses.length > 0 && statuses.every((status) => status.ready);
      const wasReady = pod.isConditionTrue('Ready');
      if (anyRunning && allReady) {
        pod.setCondition('ContainersReady', 'True', 'ContainersReady');
        pod.setCondition('Ready', 'True', 'PodReady');
        if (!wasReady) pod._readyAt = this.gameSeconds;
      } else {
        pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
        pod.setCondition('Ready', 'False', 'ContainersNotReady');
        if (wasReady) pod._readyAt = undefined;
      }
    }
  }

  _tickOOMKiller(dt) {
    const runningPods = this.cluster
      .getByKind('Pod')
      .filter(
        (pod) =>
          pod.status.phase === 'Running' &&
          pod.status.containerStatuses &&
          !this._isIncidentControlled(pod)
      );
    for (const pod of runningPods) {
      for (const status of pod.status.containerStatuses) {
        if (!status.state.running) continue;
        if (!status.resources) continue;
        if (status.resources.memoryLimit <= 0) continue;
        if (status.resources.memory > status.resources.memoryLimit) {
          const memoryUsed = status.resources.memory;
          this._handleContainerFailure(pod, status, 'OOMKilled', 137);
          status.lastState = {
            terminated: {
              exitCode: 137,
              reason: 'OOMKilled',
              finishedAt: new Date().toISOString(),
              message: `Container ${status.name} exceeded memory limit (${Math.round(memoryUsed)}Mi > ${status.resources.memoryLimit}Mi)`,
            },
          };
          status.resources.memory = 0;
          status.resources.cpu = 0;
          pod.recordEvent('Warning', 'OOMKilled', `Container ${status.name} was OOM killed`);
          this.eventBus?.emit('incident:oomkill', {
            pod: pod.name,
            namespace: pod.namespace,
            container: status.name,
            memoryUsed,
            memoryLimit: status.resources.memoryLimit,
          });
        }
      }
    }
  }

  // ── Workload controllers ───────────────────────────────────────────────

  _tickDeployments(dt) {
    for (const deploy of this.cluster.getByKind('Deployment')) {
      // OCP 4.22 image-change triggers live in the
      // `image.openshift.io/triggers` annotation (apps/v1 Deployments have no
      // spec.triggers field); apply them before reconciling the rollout.
      this._processDeploymentImageTriggers(deploy);
      this._reconcileDeployment(deploy);
    }
  }

  /**
   * Parse `metadata.annotations['image.openshift.io/triggers']` (a JSON array
   * of {from:{kind,name,namespace}, fieldPath, paused}). Returns [] when the
   * annotation is absent (no image trigger) or malformed.
   */
  _deploymentImageTriggers(deployment) {
    const raw = deployment?.metadata?.annotations?.['image.openshift.io/triggers'];
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed)
        ? parsed.filter((entry) => entry && typeof entry === 'object')
        : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Roll a Deployment when an ImageStreamTag referenced by its image-change
   * trigger annotation becomes available/changes. The controller keeps the last
   * observed tag reference on the in-memory resource (`_imageTriggerRefs`); the
   * template mutation then causes a normal ReplicaSet rollout.
   */
  _processDeploymentImageTriggers(deployment) {
    const triggers = this._deploymentImageTriggers(deployment);
    if (triggers.length === 0) return;
    if (!deployment.spec || !deployment.spec.template) return;
    const namespace = deployment.metadata.namespace;
    const containers = deployment.spec?.template?.spec?.containers || [];
    deployment._imageTriggerRefs = deployment._imageTriggerRefs || {};
    let changed = false;
    let changedTag = '';

    for (const trigger of triggers) {
      if (trigger.paused === true) continue;
      const from =
        trigger.from || trigger.imageChangeParams?.from || trigger.imageChange?.from || {};
      if (from.kind && from.kind !== 'ImageStreamTag') continue;
      const fromName = String(from.name || '');
      if (!fromName) continue;
      const [streamName, tag = 'latest'] = fromName.split(':');
      if (!streamName) continue;
      const streamNamespace = from.namespace || namespace;
      const resolved = this.cluster.resolveImageStreamTag(streamNamespace, streamName, tag);
      const tagItem = resolved.tagEntry?.items?.[0];
      const available = Boolean(resolved.found && tagItem);
      // Real image-change triggers substitute the ImageStreamTag's resolved
      // image (digest-qualified) pull spec, which is what makes an identical
      // `:latest` tag still change the pod template and roll out.
      const desiredImage = available
        ? `${IMAGE_REGISTRY_HOST}/${streamNamespace}/${streamName}@${tagItem.image || tagItem.dockerImageReference || tag}`
        : '';
      const key = `${trigger.fieldPath || fromName}`;
      const previousToken = deployment._imageTriggerRefs[key];
      const token = available
        ? `${tagItem.image || ''}|${resolved.dockerImageReference || ''}|${resolved.tagEntry?.updated || ''}`
        : '';
      deployment._imageTriggerRefs[key] = token;
      if (!available) continue;

      const fieldMatch = String(trigger.fieldPath || '').match(/containers\[(\d+)\].image/);
      const targets = [];
      if (fieldMatch) {
        const container = containers[Number(fieldMatch[1])];
        if (container) targets.push(container);
      }
      for (const name of trigger.imageChangeParams?.containerNames ||
        trigger.containerNames ||
        []) {
        const container = containers.find((entry) => entry.name === name);
        if (container && !targets.includes(container)) targets.push(container);
      }
      const effectiveTargets = targets.length > 0 ? targets : containers;
      const firstObservation = previousToken === undefined;
      const tokenChanged = !firstObservation && previousToken !== token;
      const imageDiffers = effectiveTargets.some((container) => container.image !== desiredImage);
      // Apply on the first observation only if the template still points
      // somewhere else; afterwards only on tag changes.
      if (!tokenChanged && !(firstObservation && imageDiffers)) continue;
      let appliedImage = false;
      for (const container of effectiveTargets) {
        if (container.image === desiredImage) continue;
        container.image = desiredImage;
        appliedImage = true;
      }
      if (tokenChanged && !appliedImage) {
        // The resolved pull spec is unchanged (same tag) but the tag now points
        // at a different image: record the new image identity on the pod
        // template, exactly what makes the real trigger controller roll out.
        deployment.spec.template.metadata = deployment.spec.template.metadata || {};
        deployment.spec.template.metadata.annotations =
          deployment.spec.template.metadata.annotations || {};
        deployment.spec.template.metadata.annotations['openshiftgames/image-trigger'] =
          `${streamName}:${tag}@${token}`;
      }
      changed = true;
      changedTag = `${streamName}:${tag}`;
    }

    if (!changed) return;
    deployment.metadata.generation = (Number(deployment.metadata.generation) || 1) + 1;
    deployment.setCondition(
      'Progressing',
      'True',
      'ReplicaSetUpdated',
      changedTag ? `image change ${changedTag}` : 'image change'
    );
    this.cluster.update(deployment.uid, deployment);
    this.eventBus?.emit('rollout:triggered', {
      kind: 'Deployment',
      name: deployment.metadata.name,
      namespace,
      imageStreamTag: changedTag,
      resource: deployment,
    });
  }

  /**
   * Deployment controller: template changes create a new ReplicaSet named
   * `<deploy>-<pod-template-hash>`; old ReplicaSets are scaled to zero and kept
   * for rollback up to revisionHistoryLimit (SIM-004/SIM-007/SIM-008).
   */
  _reconcileDeployment(deploy) {
    const namespace = deploy.metadata.namespace;
    const desiredReplicas = Math.max(0, Number(deploy.spec.replicas ?? 1) || 0);
    const template = deepClone(
      deploy.spec.template || { spec: { containers: [{ name: 'main', image: 'app:latest' }] } }
    );
    const templateHash = this._templateHash(template);
    const selector = deepClone(deploy.spec.selector?.matchLabels || deploy.metadata.labels || {});
    const strategy = deploy.spec.strategy || {};
    const strategyType = strategy.type || 'RollingUpdate';
    const maxSurge = this._resolveStrategyNumber(
      strategy.rollingUpdate?.maxSurge,
      desiredReplicas,
      'surge'
    );
    const maxUnavailable = this._resolveStrategyNumber(
      strategy.rollingUpdate?.maxUnavailable,
      desiredReplicas,
      'unavailable'
    );
    const minReadySeconds = Math.max(0, Number(deploy.spec.minReadySeconds) || 0);
    const progressDeadlineSeconds = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
    const revisionHistoryLimit = Number.isFinite(Number(deploy.spec.revisionHistoryLimit))
      ? Number(deploy.spec.revisionHistoryLimit)
      : 10;
    const paused = deploy.spec.paused === true;

    // The controller derives everything from ReplicaSet/template state, never
    // from GameEngine's imperative `_rollout` hint.
    delete deploy._rollout;

    const ownedSets = this.cluster
      .getChildren(deploy.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    let currentSet =
      ownedSets.find((rs) => rs.metadata.labels?.['pod-template-hash'] === templateHash) || null;
    const oldSets = ownedSets.filter((rs) => rs !== currentSet);
    const templateChanged = !currentSet;
    const status = {
      desiredReplicas,
      minReadySeconds,
      maxUnavailable,
      maxSurge,
      paused,
      strategyType,
      templateHash,
      currentSet,
      ownedSets,
    };

    if (templateChanged && paused) {
      // A paused Deployment must not start a new rollout.
      for (const rs of ownedSets) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
      this._updateDeploymentStatus(deploy, status, { rolloutPending: true });
      return;
    }
    if (templateChanged) {
      currentSet = this._createDeploymentReplicaSet(
        deploy,
        template,
        templateHash,
        selector,
        ownedSets
      );
      if (currentSet && !ownedSets.includes(currentSet)) ownedSets.push(currentSet);
      status.currentSet = currentSet;
      status.ownedSets = ownedSets;
    }

    // Reconcile a pre-existing ReplicaSet (legacy/saved state) whose template
    // no longer matches its hash label.
    if (
      currentSet &&
      this._stableStringify(currentSet.spec.template || {}) !== this._stableStringify(template)
    ) {
      currentSet.spec.template = deepClone(template);
      this.cluster.update(currentSet.uid, currentSet);
    }

    const activeOld = oldSets.reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const activeCurrent = currentSet ? this._activePodsOf(currentSet).length : 0;

    if (paused) {
      for (const rs of [currentSet, ...oldSets])
        if (rs) this._reconcileReplicaSet(rs, undefined, minReadySeconds);
    } else if (strategyType === 'Recreate') {
      if (activeOld > 0) {
        for (const rs of oldSets) {
          const oldReplicas = Math.max(0, Number(rs.spec.replicas ?? 0) || 0);
          this._reconcileReplicaSet(rs, 0, minReadySeconds);
          if (oldReplicas > 0) {
            this._recordDeploymentScalingEvent(deploy, 'down', rs.metadata?.name, 0, oldReplicas);
          }
        }
        this._reconcileReplicaSet(currentSet, 0, minReadySeconds);
      } else {
        this._reconcileReplicaSet(currentSet, desiredReplicas, minReadySeconds);
      }
    } else {
      // RollingUpdate: create up to maxSurge new pods first, then remove old
      // pods one at a time once the new ReplicaSet satisfies minAvailable.
      let currentTarget;
      if (activeOld === 0) {
        currentTarget = desiredReplicas;
      } else {
        const surgeRoom = Math.max(0, desiredReplicas + maxSurge - activeOld - activeCurrent);
        currentTarget = Math.min(desiredReplicas, activeCurrent + surgeRoom);
      }
      if (currentSet) this._reconcileReplicaSet(currentSet, currentTarget, minReadySeconds);
      if (activeOld > 0) {
        // Real Deployment controller math (reconcileOldReplicaSets):
        //   maxScaledDown = allPodsCount - minAvailable - newRSUnavailablePods
        // where newRSUnavailablePods are the new ReplicaSet's pods that are not
        // yet available. This is what keeps the old ReplicaSet serving when the
        // new image cannot be pulled (issue #7) and what removes the failed
        // ReplicaSet's leftovers after `oc rollout undo`.
        const minAvailable = Math.max(0, desiredReplicas - maxUnavailable);
        const newSetSpecReplicas = Math.max(0, Number(currentSet?.spec.replicas ?? 0) || 0);
        const newUnavailable = Math.max(
          0,
          newSetSpecReplicas -
            (currentSet ? this._readyPodsOf(currentSet, minReadySeconds).length : 0)
        );
        const allPodsCount = activeOld + Math.max(activeCurrent, newSetSpecReplicas);
        const maxScaledDown = allPodsCount - minAvailable - newUnavailable;
        if (maxScaledDown > 0) {
          let remaining = maxScaledDown;
          const victims = oldSets
            .filter((rs) => this._activePodsOf(rs).length > 0)
            .sort((a, b) => this._replicaSetRevision(a) - this._replicaSetRevision(b));
          for (const victim of victims) {
            if (remaining <= 0) break;
            const active = this._activePodsOf(victim).length;
            const remove = Math.min(remaining, active);
            const oldReplicas = Math.max(0, Number(victim.spec.replicas ?? 0) || 0);
            const nextReplicas = active - remove;
            this._reconcileReplicaSet(victim, nextReplicas, minReadySeconds);
            // The Deployment controller records the scale-down on the DEPLOYMENT
            // (`Scaled down replica set <old> to 0 from 1`) — that is the series
            // `oc describe deploy` shows (#65).
            if (nextReplicas < oldReplicas) {
              this._recordDeploymentScalingEvent(
                deploy,
                'down',
                victim.metadata?.name,
                nextReplicas,
                oldReplicas
              );
            }
            remaining -= remove;
          }
        }
      }
      for (const rs of oldSets) {
        if (rs.spec.replicas !== 0 && this._activePodsOf(rs).length === 0) {
          const oldReplicas = Math.max(0, Number(rs.spec.replicas ?? 0) || 0);
          this._reconcileReplicaSet(rs, 0, minReadySeconds);
          if (oldReplicas > 0) {
            this._recordDeploymentScalingEvent(deploy, 'down', rs.metadata?.name, 0, oldReplicas);
          }
        }
      }
    }

    const rolloutPending =
      this._activePodsOf(currentSet).length < desiredReplicas ||
      oldSets.some((rs) => this._activePodsOf(rs).length > 0);
    this._updateDeploymentStatus(deploy, status, { rolloutPending });
    this._pruneDeploymentReplicaSets(deploy, status, revisionHistoryLimit);
  }

  /** Create (or refresh) the ReplicaSet for a Deployment template revision. */
  _createDeploymentReplicaSet(deploy, template, templateHash, selector, ownedSets) {
    const namespace = deploy.metadata.namespace;
    const name = `${deploy.metadata.name}-${templateHash}`;
    let revision =
      ownedSets.reduce((max, rs) => Math.max(max, this._replicaSetRevision(rs)), 0) + 1;
    let rs = this.cluster.getByName('ReplicaSet', name, namespace);
    let createdNow = false;
    if (!rs) {
      // Real Deployment controller copies the Deployment's annotations onto each
      // new ReplicaSet, which is where `oc rollout history` reads
      // kubernetes.io/change-cause from.
      const changeCause =
        deploy.metadata?.annotations?.['kubernetes.io/change-cause'] ||
        template?.metadata?.annotations?.['kubernetes.io/change-cause'] ||
        '';
      const rsAnnotations = { 'deployment.kubernetes.io/revision': String(revision) };
      if (changeCause) rsAnnotations['kubernetes.io/change-cause'] = changeCause;
      // Real Deployment controller: the ReplicaSet copies the Pod template's
      // labels (selector labels + extra template labels such as OpenShift
      // new-app's `deployment=<name>`) and adds `pod-template-hash`.
      const templateLabels = template?.metadata?.labels || {};
      rs = this.cluster.addResource({
        kind: 'ReplicaSet',
        metadata: {
          name,
          namespace,
          labels: { ...templateLabels, ...selector, 'pod-template-hash': templateHash },
          annotations: rsAnnotations,
          ownerReferences: [this._controllerOwnerReference(deploy)],
        },
        spec: {
          replicas: 0,
          selector: { matchLabels: deepClone(selector) },
          template: deepClone(template),
        },
      });
      createdNow = Boolean(rs);
    }
    if (!rs) return null;
    // Real Deployment controller emits `Scaled up replica set <new> to <n>` on
    // the Deployment when a rollout creates the new ReplicaSet (#65).
    const desiredReplicas = Math.max(0, Number(deploy.spec?.replicas ?? 1) || 0);
    if (createdNow && desiredReplicas > 0) {
      this._recordDeploymentScalingEvent(deploy, 'up', name, desiredReplicas);
    }
    this.cluster.addRelationship(deploy.uid, rs.uid);
    deploy.metadata.annotations = deploy.metadata.annotations || {};
    const currentRevision =
      parseInt(deploy.metadata.annotations['deployment.kubernetes.io/revision'] || '0', 10) || 0;
    revision = Math.max(revision, currentRevision + 1);
    deploy.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    rs.metadata.annotations = rs.metadata.annotations || {};
    rs.metadata.annotations['deployment.kubernetes.io/revision'] = String(revision);
    this.cluster.updateMetadata(deploy.uid, {
      annotations: { 'deployment.kubernetes.io/revision': String(revision) },
    });
    this.eventBus?.emit('rollout:triggered', {
      kind: 'Deployment',
      name: deploy.metadata.name,
      namespace,
      revision,
      templateHash,
      resource: deploy,
    });
    return rs;
  }

  /**
   * Record one Deployment-controller `ScalingReplicaSet` event on the
   * Deployment itself — the only deployment events real `oc describe deploy`
   * shows (#65). Real controller wording: an up event is
   * `Scaled up replica set <rs> to <n>` and a down event is
   * `Scaled down replica set <rs> to <n> from <old>`.
   * @param {object} deploy Deployment resource
   * @param {'up'|'down'} direction
   * @param {string} replicaSetName
   * @param {number} toReplicas
   * @param {number} [fromReplicas]
   */
  _recordDeploymentScalingEvent(deploy, direction, replicaSetName, toReplicas, fromReplicas) {
    if (!deploy || !replicaSetName || typeof deploy.recordEvent !== 'function') return;
    const to = Math.max(0, Math.trunc(Number(toReplicas) || 0));
    const from =
      fromReplicas === undefined || fromReplicas === null
        ? null
        : Math.max(0, Math.trunc(Number(fromReplicas) || 0));
    const message =
      direction === 'down'
        ? `Scaled down replica set ${replicaSetName} to ${to}${from === null ? '' : ` from ${from}`}`
        : `Scaled up replica set ${replicaSetName} to ${to}`;
    deploy.recordEvent('Normal', 'ScalingReplicaSet', message);
  }

  /**
   * Reconcile one ReplicaSet to a target replica count. When `targetReplicas`
   * is undefined the existing `rs.spec.replicas` is honoured.
   */
  _reconcileReplicaSet(rs, targetReplicas, minReadySeconds = 0) {
    if (!rs) return;
    if (typeof targetReplicas === 'number' && Number.isFinite(targetReplicas)) {
      const next = Math.max(0, Math.floor(targetReplicas));
      if (rs.spec.replicas !== next) {
        rs.spec.replicas = next;
        this.cluster.update(rs.uid, rs);
      }
    }
    // A ReplicaSet scaled to zero is no longer trying (and failing) to create
    // Pods: drop its stale ReplicaFailure condition so a fixed Deployment does
    // not keep reporting the old admission failure (#25 fix path).
    if (rs.spec.replicas === 0) this._clearReplicaFailure(rs);
    const target = Math.max(0, Number(rs.spec.replicas ?? 0) || 0);
    const pods = this._activePodsOf(rs);
    const blockedPod = pods.find((pod) => this._isPodBlocked(pod));
    if (blockedPod) {
      // Do not create replacements while admission is rejecting pods.
      this._refreshReplicaSetStatus(rs, pods, minReadySeconds);
      return;
    }
    if (pods.length < target) {
      for (let index = 0; index < target - pods.length; index++) this._createPodForWorkload(rs, rs);
    } else if (pods.length > target) {
      const sorted = [...pods].sort((a, b) => {
        if (a.status.phase === 'Pending' && b.status.phase !== 'Pending') return -1;
        if (b.status.phase === 'Pending' && a.status.phase !== 'Pending') return 1;
        return new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp);
      });
      for (let index = 0; index < pods.length - target; index++)
        this.cluster.remove(sorted[index].uid);
    }
    this._refreshReplicaSetStatus(rs, this._activePodsOf(rs), minReadySeconds);
  }

  _refreshReplicaSetStatus(rs, pods, minReadySeconds = 0) {
    const ready = pods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    rs.status.replicas = pods.length;
    rs.status.fullyLabeledReplicas = pods.filter(
      (pod) =>
        pod.metadata.labels?.['pod-template-hash'] === rs.metadata.labels?.['pod-template-hash']
    ).length;
    rs.status.readyReplicas = ready.length;
    rs.status.availableReplicas = ready.length;
    rs.status.observedGeneration = rs.metadata.generation;
    rs.status.phase = 'Running';
  }

  /** Derive Deployment status/conditions from the real ReplicaSet pods. */
  _updateDeploymentStatus(deploy, ctx, flags = {}) {
    const { desiredReplicas, minReadySeconds, maxUnavailable, paused, currentSet, ownedSets } = ctx;
    const allPods = ownedSets.flatMap((rs) => this._activePodsOf(rs));
    const currentPods = currentSet ? this._activePodsOf(currentSet) : [];
    const readyAll = allPods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    const readyCurrent = currentPods.filter((pod) => this._podIsReady(pod, minReadySeconds));
    const available = readyAll.length;
    const minAvailable = Math.max(0, desiredReplicas - maxUnavailable);
    // Admission rejections no longer create Failed Pod objects (issue #13):
    // the ReplicaSet carries a ReplicaFailure/FailedCreate condition instead.
    // The legacy denied-Pod scan is kept for pre-existing/incident pods.
    const deniedPods = ownedSets
      .flatMap((rs) => this.cluster.getChildren(rs.uid))
      .filter((child) => child.kind === 'Pod' && this._isPodBlocked(child));
    const failingSets = ownedSets.filter((rs) => this._hasReplicaFailure(rs));
    const replicaFailure =
      failingSets.length > 0
        ? (failingSets[0].status.conditions || []).find(
            (condition) => condition.type === 'ReplicaFailure'
          )
        : null;
    const admissionBlocked = Boolean(replicaFailure) || deniedPods.length > 0;
    const admissionMessage =
      replicaFailure?.message ||
      deniedPods[0]?.metadata?.annotations?.['openshiftgames/denied-reason'] ||
      '';
    const oldSetPods = ownedSets
      .filter((rs) => rs !== currentSet)
      .reduce((sum, rs) => sum + this._activePodsOf(rs).length, 0);
    const rolloutPending =
      flags.rolloutPending === true ||
      oldSetPods > 0 ||
      currentPods.length < desiredReplicas ||
      (currentSet &&
        this._stableStringify(currentSet.spec.template || {}) !==
          this._stableStringify(deploy.spec.template || {}));

    const previousSignature = deploy._deploymentStatusSignature;
    const progressDeadlineSeconds = Math.max(1, Number(deploy.spec.progressDeadlineSeconds) || 600);
    const progressing = !paused && (admissionBlocked || rolloutPending);
    deploy.status.replicas = allPods.length;
    // Deployment.status.readyReplicas counts every ready Pod of the Deployment
    // (old + new ReplicaSets), like a real cluster.
    deploy.status.readyReplicas = readyAll.length;
    deploy.status.availableReplicas = available;
    deploy.status.updatedReplicas = currentPods.length;
    deploy.status.unavailableReplicas = Math.max(0, desiredReplicas - available);
    deploy.status.observedGeneration = deploy.metadata.generation;
    if (progressing && typeof deploy._progressingSince !== 'number')
      deploy._progressingSince = this.gameSeconds;
    if (!progressing) deploy._progressingSince = undefined;
    const timedOut =
      progressing &&
      typeof deploy._progressingSince === 'number' &&
      this.gameSeconds - deploy._progressingSince >= progressDeadlineSeconds;

    if (admissionBlocked) {
      deploy.setCondition(
        'Available',
        'False',
        'MinimumReplicasUnavailable',
        `${available}/${desiredReplicas} replicas available`
      );
      deploy.setCondition(
        'Progressing',
        timedOut ? 'False' : 'True',
        timedOut ? 'ProgressDeadlineExceeded' : 'ReplicaSetUpdated',
        timedOut
          ? `ReplicaSet "${currentSet?.metadata?.name || 'new'}" has timed out progressing.`
          : `waiting for pods to be admitted: ${admissionMessage}`
      );
      deploy.setCondition(
        'ReplicaFailure',
        'True',
        'FailedCreate',
        admissionMessage || 'unable to admit pod'
      );
    } else {
      deploy.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');
      if (paused) {
        deploy.setCondition(
          'Progressing',
          'True',
          'DeploymentPaused',
          'deployment is paused; rollout will not continue until resumed'
        );
        deploy.setCondition(
          'Available',
          available >= Math.min(desiredReplicas, minAvailable) ? 'True' : 'False',
          available >= Math.min(desiredReplicas, minAvailable)
            ? 'MinimumReplicasAvailable'
            : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
      } else if (rolloutPending) {
        if (timedOut) {
          deploy.setCondition(
            'Progressing',
            'False',
            'ProgressDeadlineExceeded',
            `ReplicaSet "${currentSet?.metadata?.name || 'new'}" has timed out progressing.`
          );
        } else {
          deploy.setCondition(
            'Progressing',
            'True',
            'ReplicaSetUpdated',
            `${readyCurrent.length} out of ${desiredReplicas} new replicas have been updated`
          );
        }
        deploy.setCondition(
          'Available',
          available >= minAvailable ? 'True' : 'False',
          available >= minAvailable ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
      } else {
        // The rollout has no pending ReplicaSet scale-up, but the Deployment can
        // still be unhealthy (crash-looping / unschedulable / unready Pods).
        // Real clusters only report MinimumReplicasAvailable when enough
        // replicas are actually available (issue #23: `0 available | 3
        // unavailable` must read Available False MinimumReplicasUnavailable).
        const minimumAvailable = available >= minAvailable;
        deploy.setCondition(
          'Available',
          minimumAvailable ? 'True' : 'False',
          minimumAvailable ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
          `${available}/${desiredReplicas} replicas available`
        );
        // Progressing only becomes NewReplicaSetAvailable once every desired
        // replica is available; a new ReplicaSet whose Pods exist but never
        // become Ready is still being updated.
        if (desiredReplicas > 0 && available < desiredReplicas) {
          deploy.setCondition(
            'Progressing',
            'True',
            'ReplicaSetUpdated',
            `${available} out of ${desiredReplicas} new replicas are available`
          );
        } else {
          deploy.setCondition('Progressing', 'True', 'NewReplicaSetAvailable', '');
        }
      }
    }

    // Engine hooks consumed by `oc rollout status` / other UI surfaces.
    if (timedOut && !deploy._deadlineEventEmitted) {
      deploy._deadlineEventEmitted = true;
      const message = `error: deployment "${deploy.metadata.name}" exceeded its progress deadline`;
      this.eventBus?.emit('rollout:progress-deadline-exceeded', {
        kind: 'Deployment',
        name: deploy.metadata.name,
        namespace: deploy.metadata.namespace,
        revision: this._replicaSetRevision(currentSet) || null,
        deadlineSeconds: progressDeadlineSeconds,
        message,
        resource: deploy,
      });
    }
    if (!timedOut) deploy._deadlineEventEmitted = false;

    const wasPending = deploy._rolloutPendingLast === true;
    deploy._rolloutPendingLast = progressing;
    if (progressing) {
      deploy._rolloutCompleteEmitted = false;
    } else if (wasPending && !deploy._rolloutCompleteEmitted) {
      deploy._rolloutCompleteEmitted = true;
      this.eventBus?.emit('rollout:complete', {
        kind: 'Deployment',
        name: deploy.metadata.name,
        namespace: deploy.metadata.namespace,
        revision: this._replicaSetRevision(currentSet) || null,
        message: `deployment "${deploy.metadata.name}" successfully rolled out`,
        resource: deploy,
      });
    }

    const signature = JSON.stringify({
      replicas: deploy.status.replicas,
      ready: deploy.status.readyReplicas,
      available: deploy.status.availableReplicas,
      updated: deploy.status.updatedReplicas,
      unavailable: deploy.status.unavailableReplicas,
      observedGeneration: deploy.status.observedGeneration,
      conditions: (deploy.status.conditions || []).map(
        (condition) => `${condition.type}:${condition.status}:${condition.reason}`
      ),
    });
    if (signature !== previousSignature) {
      deploy._deploymentStatusSignature = signature;
      this.cluster.update(deploy.uid, deploy);
    }
  }

  /** Keep only the newest `revisionHistoryLimit` ReplicaSets (scaled to 0). */
  _pruneDeploymentReplicaSets(deploy, ctx, revisionHistoryLimit) {
    const sets = (ctx.ownedSets || []).filter((rs) => rs !== ctx.currentSet);
    const removable = sets
      .filter((rs) => rs.spec.replicas === 0 && this._activePodsOf(rs).length === 0)
      .sort((a, b) => this._replicaSetRevision(b) - this._replicaSetRevision(a));
    const keepOld = Math.max(0, revisionHistoryLimit - 1);
    for (const rs of removable.slice(keepOld)) {
      this.cluster.remove(rs.uid);
    }
  }

  _replicaSetRevision(rs) {
    const value = Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision']);
    if (Number.isFinite(value)) return value;
    return 0;
  }

  // ── Rollout engine hooks (consumed by the CLI and UI) ────────────────────

  /** Resolve a workload for rollout inspection (`oc rollout …`). */
  _rolloutResource(kind, name, options = {}) {
    const canonical = this.cluster._canonicalKind(kind || 'Deployment') || kind || 'Deployment';
    const namespace = options.namespace || 'default';
    const resource = this.cluster.getByName(canonical, name, namespace);
    return { canonical, resource, namespace };
  }

  /**
   * Rollout status for `oc rollout status <kind>/<name>`, mirroring the real
   * oc contract: the CLI polls this through a `pending` state and prints the
   * failure line when the Deployment exhausts its progressDeadlineSeconds.
   *
   * @param {string} kind `Deployment`/`StatefulSet`/`DaemonSet`
   * @param {string} name
   * @param {{namespace?: string}} [options]
   * @returns {{
   *   found: boolean, complete: boolean, pending: boolean, timedOut: boolean,
   *   error?: string, message: string, reason: string|null,
   *   deadlineSeconds: number|null, remainingSeconds: number|null,
   *   revision: number|null,
   *   status: {desired: number, updated: number, ready: number, available: number, replicas: number, unavailable: number}
   * }}
   */
  getRolloutStatus(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    const singular = String(canonical || 'resource').toLowerCase();
    if (!resource) {
      return {
        found: false,
        complete: false,
        pending: false,
        timedOut: false,
        message: `Error from server (NotFound): ${singular}s "${name}" not found`,
        reason: null,
        generation: 0,
        observedGeneration: 0,
        specUpdatePending: false,
        deadlineSeconds: null,
        remainingSeconds: null,
        revision: null,
        status: { desired: 0, updated: 0, ready: 0, available: 0, replicas: 0, unavailable: 0 },
      };
    }
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(canonical)) {
      return {
        found: true,
        complete: false,
        pending: false,
        timedOut: false,
        error: `error: no rollout strategy for "${singular}"`,
        message: `error: no rollout strategy for "${singular}"`,
        reason: 'NoRolloutStrategy',
        generation: Number(resource.metadata?.generation) || 1,
        observedGeneration: Number(resource.status?.observedGeneration) || 0,
        specUpdatePending: false,
        deadlineSeconds: null,
        remainingSeconds: null,
        revision: null,
        status: { desired: 0, updated: 0, ready: 0, available: 0, replicas: 0, unavailable: 0 },
      };
    }

    // Honest generation mirroring (#17): `oc set image` bumps metadata.generation
    // synchronously while status.observedGeneration only advances when the
    // controller reconciles that generation. Until then any completion reported
    // from the old status would be a lie — real oc prints the spec-update
    // waiting line instead of "successfully rolled out".
    const generation = Number(resource.metadata?.generation) || 1;
    const observedGeneration = Number(resource.status?.observedGeneration) || 0;
    const specUpdatePending = observedGeneration < generation;

    if (canonical === 'Deployment') {
      const desired = Math.max(0, Number(resource.spec.replicas ?? 1) || 0);
      const status = {
        desired,
        updated: Number(resource.status.updatedReplicas || 0),
        ready: Number(resource.status.readyReplicas || 0),
        available: Number(resource.status.availableReplicas || 0),
        replicas: Number(resource.status.replicas || 0),
        unavailable: Number(resource.status.unavailableReplicas || 0),
      };
      const progressing = resource.getCondition('Progressing');
      const paused = resource.spec.paused === true;
      const timedOut =
        !paused &&
        progressing?.status === 'False' &&
        progressing.reason === 'ProgressDeadlineExceeded';
      const failedCreate = (resource.status.conditions || []).some(
        (condition) => condition.type === 'ReplicaFailure' && condition.status === 'True'
      );
      const complete =
        !paused &&
        !timedOut &&
        !failedCreate &&
        !specUpdatePending &&
        status.updated >= desired &&
        status.available >= desired &&
        status.replicas <= desired;
      const deadlineSeconds = Math.max(1, Number(resource.spec.progressDeadlineSeconds) || 600);
      const remainingSeconds =
        typeof resource._progressingSince === 'number'
          ? Math.max(0, deadlineSeconds - (this.gameSeconds - resource._progressingSince))
          : null;
      // Available replicas that belong to the NEW (latest-revision) ReplicaSet;
      // used to distinguish "old replicas pending termination" from a rollout
      // blocked by ImagePullBackOff/SCC FailedCreate.
      const revisionOfSet = (rs) =>
        Number(rs?.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0;
      const deploymentSets = this.cluster
        .getChildren(resource.uid)
        .filter((child) => child.kind === 'ReplicaSet')
        .sort((left, right) => revisionOfSet(left) - revisionOfSet(right));
      const latestSet = deploymentSets[deploymentSets.length - 1] || null;
      const unavailableUpdated = Math.min(
        status.updated,
        Number(latestSet?.status?.availableReplicas ?? status.updated) || 0
      );
      let message;
      if (timedOut) {
        message = `error: deployment "${name}" exceeded its progress deadline`;
      } else if (specUpdatePending) {
        message = `Waiting for deployment "${name}" spec update to be observed by the deployment controller...`;
      } else if (complete) {
        message = `deployment "${name}" successfully rolled out`;
      } else if (paused) {
        message = `Waiting for deployment "${name}" rollout to finish: deployment is paused`;
      } else if (status.updated < status.desired) {
        message = `Waiting for deployment "${name}" rollout to finish: ${status.updated} out of ${status.desired} new replicas have been updated...`;
      } else if (unavailableUpdated < status.updated) {
        // A new ReplicaSet that cannot start (ImagePullBackOff, SCC rejection …)
        // reports `0 of N updated replicas are available` — not "old replicas
        // pending termination" (#36).
        message = `Waiting for deployment "${name}" rollout to finish: ${unavailableUpdated} of ${status.updated} updated replicas are available...`;
      } else if (status.available < status.updated) {
        message = `Waiting for deployment "${name}" rollout to finish: ${status.available} of ${status.updated} updated replicas are available...`;
      } else if (status.replicas > status.updated) {
        message = `Waiting for deployment "${name}" rollout to finish: ${Math.max(0, status.replicas - status.updated)} old replicas are pending termination...`;
      } else {
        message = `Waiting for deployment "${name}" rollout to finish: ${status.available} of ${status.updated} updated replicas are available...`;
      }
      return {
        found: true,
        complete,
        pending: !complete && !timedOut,
        timedOut,
        message,
        reason: timedOut
          ? 'ProgressDeadlineExceeded'
          : specUpdatePending
            ? 'SpecUpdatePending'
            : complete
              ? 'NewReplicaSetAvailable'
              : progressing?.reason || null,
        generation,
        observedGeneration,
        specUpdatePending,
        deadlineSeconds,
        remainingSeconds,
        revision:
          Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) || null,
        status,
      };
    }

    const isDaemonSet = canonical === 'DaemonSet';
    const desired = isDaemonSet
      ? Math.max(
          0,
          Number(
            resource.status.desiredNumberScheduled ?? resource.status.currentNumberScheduled ?? 0
          ) || 0
        )
      : Math.max(0, Number(resource.spec.replicas ?? 1) || 0);
    const status = isDaemonSet
      ? {
          desired,
          updated: Number(resource.status.updatedNumberScheduled || 0),
          ready: Number(resource.status.numberReady || 0),
          available: Number(resource.status.numberAvailable || 0),
          replicas: Number(resource.status.currentNumberScheduled || 0),
          unavailable: Number(resource.status.numberUnavailable || 0),
        }
      : {
          desired,
          updated: Number(resource.status.updatedReplicas || resource.status.currentReplicas || 0),
          ready: Number(resource.status.readyReplicas || 0),
          available: Number(resource.status.availableReplicas || 0),
          replicas: Number(resource.status.replicas || resource.status.currentReplicas || 0),
          unavailable: Number(resource.status.unavailableReplicas || 0),
        };
    const complete =
      !specUpdatePending &&
      status.updated >= desired &&
      status.available >= desired &&
      status.replicas >= desired;
    const controllerName = isDaemonSet ? 'daemon set' : 'statefulset';
    return {
      found: true,
      complete,
      pending: !complete,
      timedOut: false,
      message: specUpdatePending
        ? `Waiting for ${controllerName} "${name}" spec update to be observed by the ${controllerName} controller...`
        : complete
          ? `${singular} "${name}" successfully rolled out`
          : `Waiting for ${controllerName} "${name}" rollout to finish: ${status.available} of ${status.desired} updated pods are available...`,
      reason: specUpdatePending
        ? 'SpecUpdatePending'
        : complete
          ? 'NewReplicaSetAvailable'
          : 'ReplicaSetUpdated',
      generation,
      observedGeneration,
      specUpdatePending,
      deadlineSeconds: null,
      remainingSeconds: null,
      revision: null,
      status,
    };
  }

  /**
   * Real rollout history: derived from the Deployment's ReplicaSets
   * (`deployment.kubernetes.io/revision` + `kubernetes.io/change-cause`), so
   * revisions appear as they really happened instead of a synthesised rev 1.
   *
   * @returns {Array<{revision:number, changeCause:string, images:string[], name:string, active:boolean, template:object}>}
   */
  getRolloutHistory(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    if (!resource || !['Deployment', 'StatefulSet', 'DaemonSet'].includes(canonical)) return [];
    const ownedSets = this.cluster
      .getChildren(resource.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    const history = ownedSets
      .map((rs) => {
        const revision = this._replicaSetRevision(rs);
        const activePods = this._activePodsOf(rs).length;
        return {
          revision,
          changeCause: rs.metadata?.annotations?.['kubernetes.io/change-cause'] || '',
          images: (rs.spec?.template?.spec?.containers || []).map(
            (container) => `${container.name}=${container.image}`
          ),
          name: rs.metadata.name,
          active: activePods > 0,
          replicas: Number(rs.spec?.replicas || 0),
          template: deepClone(rs.spec?.template || {}),
        };
      })
      .filter((entry) => entry.revision > 0);
    history.sort((a, b) => a.revision - b.revision);
    if (history.length > 0) return history;
    // Legacy/saved cluster without ReplicaSets: reflect the current template as
    // revision 1 so `rollout history` still has a row (no fake change-cause).
    const currentRevision =
      Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 1;
    return [
      {
        revision: currentRevision,
        changeCause: resource.metadata?.annotations?.['kubernetes.io/change-cause'] || '',
        images: (resource.spec?.template?.spec?.containers || []).map(
          (container) => `${container.name}=${container.image}`
        ),
        name: `${resource.metadata.name}-current`,
        active: true,
        replicas: Number(resource.spec?.replicas || 0),
        template: deepClone(resource.spec?.template || {}),
      },
    ];
  }

  /**
   * `oc rollout undo`: restore the pod template of a previous revision. The
   * Deployment controller then re-activates the existing (kept) ReplicaSet, so
   * availability is restored without creating a bogus new revision.
   *
   * @param {string} kind
   * @param {string} name
   * @param {{namespace?: string, revision?: number}} [options]
   * @returns {{success: boolean, message: string, revision?: number}}
   */
  undoRollout(kind, name, options = {}) {
    const { canonical, resource } = this._rolloutResource(kind, name, options);
    const singular = String(canonical || 'resource').toLowerCase();
    if (!resource)
      return {
        success: false,
        message: `Error from server (NotFound): ${singular}s "${name}" not found`,
      };
    if (canonical !== 'Deployment') {
      return {
        success: false,
        message: `error: no rollout history found for ${singular} "${name}"`,
      };
    }
    const history = this.getRolloutHistory(canonical, name, options);
    if (history.length === 0)
      return {
        success: false,
        message: `error: no rollout history found for ${singular} "${name}"`,
      };
    const currentRevision =
      Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) ||
      history[history.length - 1].revision;
    let target;
    if (options.revision !== undefined && options.revision !== null) {
      target = history.find((entry) => entry.revision === Number(options.revision));
      if (!target) {
        // kubectl polymorphichelpers/rollback.go revisionNotFoundErr().
        return {
          success: false,
          message: `error: unable to find specified revision ${options.revision} in history`,
        };
      }
    } else {
      target = [...history].reverse().find((entry) => entry.revision < currentRevision);
      if (!target) {
        // rollback.go deploymentRevision(): no previous ReplicaSet to roll back
        // to is an error, never a silent no-op rollout (1.16.0 — it used to
        // bump the generation and print `rolled back`).
        return {
          success: false,
          message: `error: no rollout history found for ${singular} "${name}"`,
        };
      }
    }
    // rollback.go: a revision whose template is the live one is skipped.
    try {
      if (
        this._templateHash(target.template || {}) ===
        this._templateHash(resource.spec.template || {})
      ) {
        return {
          success: true,
          skipped: true,
          revision: target.revision,
          message: `${singular}.apps/${name} skipped rollback (current template already matches revision ${target.revision})`,
        };
      }
    } catch {
      /* compare best effort */
    }
    resource.spec.template = deepClone(target.template || {});
    resource.metadata.generation = (Number(resource.metadata.generation) || 1) + 1;
    resource._progressingSince = undefined;
    resource._deadlineEventEmitted = false;
    // Real DeploymentController semantics: a rollback re-activates the old
    // ReplicaSet but stamps it with the NEXT revision, so pruning/history are
    // monotonic (`oc rollout history` shows e.g. 2,3 and never re-adds 1).
    const revisionOf = (rs) =>
      Number(rs?.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0;
    const ownedSets = this.cluster
      .getChildren(resource.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    const maxRevision = Math.max(
      Number(resource.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0,
      ...ownedSets.map((rs) => revisionOf(rs))
    );
    const nextRevision = maxRevision + 1;
    resource.metadata.annotations = resource.metadata.annotations || {};
    resource.metadata.annotations['deployment.kubernetes.io/revision'] = String(nextRevision);
    const reactivatedRevision = nextRevision;
    try {
      const targetHash = this._templateHash(resource.spec.template);
      const reactivated = ownedSets.find(
        (rs) => rs.metadata?.labels?.['pod-template-hash'] === targetHash
      );
      if (reactivated) {
        reactivated.metadata.annotations = reactivated.metadata.annotations || {};
        reactivated.metadata.annotations['deployment.kubernetes.io/revision'] =
          String(reactivatedRevision);
        this.cluster.update(reactivated.uid, reactivated);
      }
    } catch {
      /* the deployment controller will re-derive its revisions on the next tick */
    }
    this.cluster.update(resource.uid, resource);
    // Counters/events shared with the objective + scoring layers (the legacy
    // GameEngine.rollout('undo') path emitted these too).
    this.cluster._rollbackCount = (this.cluster._rollbackCount || 0) + 1;
    this.eventBus?.emit('resource:rollback', {
      uid: resource.uid,
      kind: canonical,
      name,
      revision: target.revision,
    });
    this.eventBus?.emit('rollout:triggered', {
      kind: canonical,
      name,
      namespace: resource.metadata.namespace,
      revision: target.revision,
      reason: 'undo',
      resource,
    });
    return {
      success: true,
      revision: target.revision,
      message: `${singular}.apps/${name} rolled back`,
    };
  }

  _activePodsOf(owner) {
    if (!owner) return [];
    return this.cluster
      .getChildren(owner.uid)
      .filter(
        (child) =>
          child.kind === 'Pod' &&
          child.status.phase !== 'Succeeded' &&
          child.status.phase !== 'Failed'
      );
  }

  _readyPodsOf(owner, minReadySeconds = 0) {
    return this._activePodsOf(owner).filter((pod) => this._podIsReady(pod, minReadySeconds));
  }

  _podIsReady(pod, minReadySeconds = 0) {
    if (!pod || pod.status.phase !== 'Running' || !pod.isConditionTrue('Ready')) return false;
    if (minReadySeconds > 0) {
      if (typeof pod._readyAt !== 'number') return false;
      if (this.gameSeconds - pod._readyAt < minReadySeconds) return false;
    }
    return true;
  }

  /** Resolve an int-or-percent strategy field; K8s rounds surge up / unavail down. */
  _resolveStrategyNumber(value, desiredReplicas, kind) {
    const fallbackPercent = 25;
    let raw = value;
    if (raw === undefined || raw === null || raw === '') raw = `${fallbackPercent}%`;
    if (typeof raw === 'string' && raw.trim().endsWith('%')) {
      const percent = parseFloat(raw);
      if (!Number.isFinite(percent)) return 0;
      const scaled = (percent / 100) * desiredReplicas;
      return kind === 'surge' ? Math.ceil(scaled) : Math.floor(scaled);
    }
    const number = Number(raw);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  /**
   * Deterministic `pod-template-hash` from a pod template, shaped exactly like
   * the real Deployment controller's (issue #43):
   *
   *   pod-template-hash = rand.SafeEncodeString(fmt.Sprint(fnv32a(template)))
   *
   * The shared implementation lives in `js/engine/TemplateHash.js` so the CLI
   * can predict the same ReplicaSet name before a paused cluster ticks (#58);
   * this method keeps the controller call sites unchanged.
   * @param {object} template Pod template
   * @returns {string}
   */
  _templateHash(template) {
    return templateHash(template || {});
  }

  /** JSON with recursively sorted keys (stable across apply round-trips). */
  _stableStringify(value) {
    return stableStringify(value);
  }

  _tickStatefulSets(dt) {
    for (const statefulSet of this.cluster.getByKind('StatefulSet')) {
      const desiredReplicas = Math.max(0, Number(statefulSet.spec.replicas ?? 1) || 0);
      const namespace = statefulSet.metadata.namespace;
      const templateHash = this._templateHash(statefulSet.spec.template || {});
      const revisionName = `${statefulSet.metadata.name}-${templateHash}`;
      const activePods = this._activePodsOf(statefulSet);
      this._ensureStatefulSetClaims(statefulSet, activePods);

      const blocked = activePods.some((pod) => this._isPodBlocked(pod));
      if (!blocked) {
        // Recreate the lowest missing ordinal (stable pod name, SIM-006).
        for (let ordinal = 0; ordinal < desiredReplicas; ordinal++) {
          const podName = `${statefulSet.metadata.name}-${ordinal}`;
          const existing = this.cluster.getByName('Pod', podName, namespace);
          if (
            existing &&
            !existing.isDeleting &&
            existing.status.phase !== 'Succeeded' &&
            existing.status.phase !== 'Failed'
          ) {
            continue;
          }
          const created = this._createStatefulSetPod(statefulSet, ordinal, revisionName);
          if (created) break; // approximate OrderedReady: one pod per tick
        }
      }

      // Rolling update: one outdated pod at a time, highest ordinal first,
      // until every pod carries the current controller-revision-hash.
      const outdated = this._activePodsOf(statefulSet)
        .filter((pod) => pod.metadata.labels?.['controller-revision-hash'] !== revisionName)
        .sort((a, b) => this._podOrdinal(b) - this._podOrdinal(a));
      if (!blocked && outdated.length > 0) this.cluster.remove(outdated[0].uid);

      // Scale down the highest ordinals.
      let pods = this._activePodsOf(statefulSet);
      if (pods.length > desiredReplicas) {
        const sorted = [...pods].sort((a, b) => this._podOrdinal(b) - this._podOrdinal(a));
        for (let index = 0; index < pods.length - desiredReplicas; index++)
          this.cluster.remove(sorted[index].uid);
        pods = this._activePodsOf(statefulSet);
      }

      const readyPods = pods.filter((pod) => this._podIsReady(pod));
      const updatedPods = pods.filter(
        (pod) => pod.metadata.labels?.['controller-revision-hash'] === revisionName
      );
      statefulSet.status.replicas = pods.length;
      statefulSet.status.readyReplicas = readyPods.length;
      statefulSet.status.availableReplicas = readyPods.length;
      statefulSet.status.currentReplicas = pods.length;
      statefulSet.status.updatedReplicas = updatedPods.length;
      statefulSet.status.updateRevision = revisionName;
      if (pods.length > 0 && updatedPods.length === pods.length)
        statefulSet.status.currentRevision = revisionName;
      else if (!statefulSet.status.currentRevision)
        statefulSet.status.currentRevision = revisionName;
      statefulSet.status.observedGeneration = statefulSet.metadata.generation;
      if (pods.length > 0 && statefulSet.status.phase !== 'Running')
        statefulSet.setPhase('Running');
    }
  }

  /** Create one StatefulSet pod with stable ordinal name, labels and claims. */
  _createStatefulSetPod(statefulSet, ordinal, revisionName) {
    const namespace = statefulSet.metadata.namespace;
    const podName = `${statefulSet.metadata.name}-${ordinal}`;
    const existing = this.cluster.getByName('Pod', podName, namespace);
    if (existing && !existing.isDeleting) return null;
    const template = statefulSet.spec.template || {};
    const podSpec = deepClone(template.spec || {});
    podSpec.containers = podSpec.containers || [{ name: 'main', image: 'app:latest' }];
    podSpec.hostname = podName;
    podSpec.subdomain = statefulSet.spec.serviceName || statefulSet.metadata.name;
    const claimTemplates = statefulSet.spec.volumeClaimTemplates || [];
    if (claimTemplates.length > 0) {
      const volumes = podSpec.volumes || [];
      for (const claimTemplate of claimTemplates) {
        const claimBaseName = claimTemplate.metadata?.name || claimTemplate.name || 'data';
        volumes.push({
          name: claimBaseName,
          persistentVolumeClaim: { claimName: `${claimBaseName}-${podName}` },
        });
      }
      podSpec.volumes = volumes;
    }
    const selectorLabels = statefulSet.spec.selector?.matchLabels || {};
    const templateLabels = template.metadata?.labels || {};
    const labels = {
      ...selectorLabels,
      ...templateLabels,
      'statefulset.kubernetes.io/pod-name': podName,
      'apps.kubernetes.io/pod-index': String(ordinal),
      'controller-revision-hash': revisionName,
    };
    const admissionFailure = this._admissionFailureMessage(podSpec, namespace, podName);
    if (admissionFailure) {
      this._recordFailedCreate(statefulSet, podName, admissionFailure);
      return null;
    }
    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace,
        labels,
        ownerReferences: [this._controllerOwnerReference(statefulSet)],
      },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (pod) {
      this.cluster.addRelationship(statefulSet.uid, pod.uid);
      // Admitted above (real admission runs before the object exists).
      pod.setAnnotation('openshiftgames/quota-admitted', 'true');
      this._ensurePodServiceAccountTokenMount(pod);
      this.cluster.update(pod.uid, pod);
      this._clearReplicaFailure(statefulSet);
    }
    return pod;
  }

  _podOrdinal(pod) {
    const match = String(pod?.metadata?.name || '').match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /** Create per-replica PVCs from StatefulSet volumeClaimTemplates. */
  _ensureStatefulSetClaims(statefulSet, pods) {
    const templates = statefulSet.spec.volumeClaimTemplates || [];
    if (templates.length === 0) return;
    const desiredReplicas = Math.max(0, Number(statefulSet.spec.replicas ?? 1) || 0);
    for (let ordinal = 0; ordinal < Math.max(desiredReplicas, pods.length); ordinal++) {
      const podName = `${statefulSet.metadata.name}-${ordinal}`;
      for (const template of templates) {
        const claimName = `${template.metadata?.name || template.name || 'data'}-${podName}`;
        if (
          !this.cluster.getByName(
            'PersistentVolumeClaim',
            claimName,
            statefulSet.metadata.namespace
          )
        ) {
          this.cluster.addResource({
            kind: 'PersistentVolumeClaim',
            metadata: {
              name: claimName,
              namespace: statefulSet.metadata.namespace,
              labels: { app: statefulSet.metadata.name, ...(template.metadata?.labels || {}) },
              annotations: deepClone(template.metadata?.annotations || {}),
            },
            spec: deepClone(
              template.spec || {
                accessModes: ['ReadWriteOnce'],
                resources: { requests: { storage: '1Gi' } },
              }
            ),
          });
        }
      }
    }
  }

  _tickDaemonSets(dt) {
    const allNodes = this.cluster
      .getByKind('Node')
      .filter((node) => node.status.phase !== 'Terminating');
    for (const daemonSet of this.cluster.getByKind('DaemonSet')) {
      const selectorLabels = daemonSet.spec.selector?.matchLabels || {};
      // Real DaemonSets select Nodes with the POD TEMPLATE's nodeSelector (the
      // `NODE SELECTOR` column of `oc get ds`); `.spec.nodeSelector` is a
      // simulator-only legacy fallback kept for saved states.
      const nodeSelector =
        daemonSet.spec.template?.spec?.nodeSelector || daemonSet.spec.nodeSelector || {};
      const tolerations = daemonSet.spec.template?.spec?.tolerations || [];
      // DaemonSet targets every Ready, matching node. Cordoned nodes still run
      // already-bound DS pods (real DS tolerates unschedulable); custom
      // NoSchedule taints require a template toleration.
      const targetNodes = allNodes.filter((node) => {
        if (!node.isConditionTrue('Ready')) return false;
        if (!node.matchesSelector(nodeSelector)) return false;
        if (this._firstUntoleratedNoScheduleTaint({ spec: { tolerations } }, node)) return false;
        return true;
      });

      let pods = this._activePodsOf(daemonSet);
      const blocked = pods.some((pod) => this._isPodBlocked(pod));
      if (!blocked) {
        for (const node of targetNodes) {
          const scheduled = pods.some(
            (pod) => pod.spec.nodeName === node.metadata.name && !pod.isDeleting
          );
          if (scheduled) continue;
          const pod = this._createPodForWorkload(daemonSet, daemonSet);
          if (!pod) continue;
          this._schedulePodOnNode(pod, node);
          pods = this._activePodsOf(daemonSet);
          break; // one pod per tick to keep the controller smooth
        }
      }

      // Remove pods from nodes they may not continue running on. Real
      // NodeShouldRunDaemonPod: an untolerated NoSchedule taint only stops NEW
      // daemon pods (shouldRun=false, shouldContinueRunning=true) — the running pod
      // stays and is reported as misscheduled; only a node-selector mismatch or an
      // untolerated NoExecute taint removes it (1.16.0: a `dedicated=:NoSchedule`
      // taint deleted the node's dns-default/node-resolver pods).
      for (const pod of pods) {
        if (!pod.spec.nodeName) continue;
        const node = allNodes.find((entry) => entry.metadata.name === pod.spec.nodeName);
        if (!node || targetNodes.includes(node)) continue;
        const continuesRunning =
          node.isConditionTrue('Ready') &&
          node.matchesSelector(nodeSelector) &&
          !this._firstUntoleratedNoExecuteTaint({ spec: { tolerations } }, node);
        if (!continuesRunning) this.cluster.remove(pod.uid);
      }

      pods = this._activePodsOf(daemonSet);
      const targetNames = new Set(targetNodes.map((node) => node.metadata.name));
      const onTarget = pods.filter(
        (pod) => pod.spec.nodeName && targetNames.has(pod.spec.nodeName)
      );
      const misscheduled = pods.filter(
        (pod) => pod.spec.nodeName && !targetNames.has(pod.spec.nodeName)
      );
      const ready = onTarget.filter((pod) => this._podIsReady(pod));
      daemonSet.status.desiredNumberScheduled = targetNodes.length;
      daemonSet.status.currentNumberScheduled = onTarget.length;
      daemonSet.status.numberReady = ready.length;
      daemonSet.status.numberAvailable = ready.length;
      daemonSet.status.numberUnavailable = Math.max(0, targetNodes.length - ready.length);
      daemonSet.status.numberMisscheduled = misscheduled.length;
      daemonSet.status.updatedNumberScheduled = onTarget.length;
      daemonSet.status.observedGeneration = daemonSet.metadata.generation;
      if (pods.length > 0 && daemonSet.status.phase !== 'Running') daemonSet.setPhase('Running');
    }
  }

  _tickJobs(dt) {
    for (const job of this.cluster.getByKind('Job')) {
      if (job.status.phase === 'Complete' || job.status.phase === 'Failed') continue;
      // Real Job.status.phase is only set to Complete/Failed; it is unset while
      // the Job is active (batch/v1 JobPhase has no Pending value).
      if (job.status.phase === 'Pending') delete job.status.phase;
      if (typeof job._startedAtGameSeconds !== 'number')
        job._startedAtGameSeconds = this.gameSeconds;
      if (!job.status.startTime) job.status.startTime = new Date().toISOString();

      const completions = Math.max(1, Number(job.spec.completions ?? 1) || 1);
      const parallelism = Math.max(1, Number(job.spec.parallelism ?? 1) || 1);
      const backoffLimit = Number.isFinite(Number(job.spec.backoffLimit))
        ? Number(job.spec.backoffLimit)
        : 6;
      const activeDeadlineSeconds = Number(job.spec.activeDeadlineSeconds);
      const jobPods = () =>
        this.cluster.getChildren(job.uid).filter((child) => child.kind === 'Pod');
      const succeededPods = jobPods().filter((pod) => pod.status.phase === 'Succeeded');
      const failedPods = jobPods().filter((pod) => pod.status.phase === 'Failed');
      const activePods = jobPods().filter(
        (pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending'
      );
      job.status.succeeded = succeededPods.length;
      job.status.failed = failedPods.length;
      job.status.active = activePods.length;

      /**
       * Finish a Job the way batch/v1 does (issue #31): Job.status.phase has no
       * `Pending`/`Running` value, so it is assigned directly instead of via
       * setPhase (which used to emit the nonsense "Phase changed from undefined
       * to Complete" event). The real events are `Completed` on success and the
       * failure reason on failure; the Complete/Failed condition carries the
       * completion/failure time.
       */
      const finishJob = (phase, reason, message) => {
        const finishedAt = new Date().toISOString();
        job.status.phase = phase;
        job.status.completed = phase === 'Complete';
        job.status.reason = reason;
        job.status.message = message || '';
        job.status.active = 0;
        if (phase === 'Complete') {
          job.status.completionTime = finishedAt;
          job.setCondition('Complete', 'True', reason, message || '', finishedAt);
          job.setCondition('Failed', 'False', reason, '', finishedAt);
          job.recordEvent('Normal', 'Completed', message || 'Job completed successfully');
        } else {
          delete job.status.completionTime;
          job.setCondition('Failed', 'True', reason, message || '', finishedAt);
          job.setCondition('Complete', 'False', reason, '', finishedAt);
          job.recordEvent('Warning', reason || 'Failed', message || 'Job failed');
        }
        job._finishRecorded = true;
        this.cluster.update(job.uid, job);
        return true;
      };

      if (succeededPods.length >= completions) {
        finishJob('Complete', 'JobComplete', 'Job completed successfully');
        continue;
      }
      if (Number.isFinite(activeDeadlineSeconds) && activeDeadlineSeconds > 0) {
        const elapsed = this.gameSeconds - job._startedAtGameSeconds;
        if (elapsed >= activeDeadlineSeconds) {
          // Terminate still-running pods and fail the Job (SIM-011). A real
          // container is killed by the kubelet: terminated state, exit 137.
          const now = new Date().toISOString();
          for (const pod of activePods) {
            pod.setPhase('Failed');
            for (const status of pod.status.containerStatuses || []) {
              status.state = {
                terminated: {
                  exitCode: 137,
                  reason: 'Error',
                  message: 'job active deadline exceeded',
                  finishedAt: now,
                },
              };
              status.ready = false;
              status.started = false;
            }
            pod.setCondition(
              'Ready',
              'False',
              'ContainersNotReady',
              'job active deadline exceeded'
            );
            pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
            pod.recordEvent(
              'Warning',
              'DeadlineExceeded',
              'Pod terminated because the Job activeDeadlineSeconds was exceeded'
            );
            this._applyJobPodOutput(job, pod);
            this.cluster.update(pod.uid, pod);
          }
          job.status.failed = failedPods.length + activePods.length;
          finishJob(
            'Failed',
            'DeadlineExceeded',
            // The 1.35 job controller message is exactly this sentence; it does
            // NOT append the deadline value (issue #75 L19).
            'Job was active longer than specified deadline'
          );
          continue;
        }
      }
      if (failedPods.length > backoffLimit) {
        job.status.failed = failedPods.length;
        finishJob(
          'Failed',
          'BackoffLimitExceeded',
          `Job has reached the specified backoff limit (${backoffLimit})`
        );
        continue;
      }
      if (jobPods().some((pod) => this._isPodBlocked(pod))) continue;

      // Exponential retry backoff (simulation time).
      if (failedPods.length > 0) {
        if (typeof job._nextPodCreateAtGameSeconds !== 'number') {
          job._nextPodCreateAtGameSeconds =
            this.gameSeconds + Math.min(300, Math.pow(2, failedPods.length) * 10);
        }
      } else {
        job._nextPodCreateAtGameSeconds = undefined;
      }
      const backoffPending =
        failedPods.length > 0 &&
        typeof job._nextPodCreateAtGameSeconds === 'number' &&
        this.gameSeconds < job._nextPodCreateAtGameSeconds;
      const needed = Math.min(parallelism, completions - succeededPods.length) - activePods.length;
      for (let index = 0; index < needed; index++) {
        if (backoffPending) break;
        const pod = this._createPodForWorkload(job, job);
        if (!pod) break;
        pod.spec.restartPolicy = 'Never';
        // Real Job pods carry the job-name/controller-uid labels so
        // `oc logs job/<name>` and `oc get pods -l job-name=<name>` keep working
        // even after the Job finishes (issue #31).
        pod.metadata.labels = {
          ...(pod.metadata.labels || {}),
          'job-name': job.metadata.name,
          'batch.kubernetes.io/job-name': job.metadata.name,
          'controller-uid': job.uid,
        };
        this.cluster.updateMetadata(pod.uid, { labels: pod.metadata.labels });
        const container = job.spec?.template?.spec?.containers?.[0] || {};
        // Real kubelet: the container starts and exits as soon as the command
        // finishes — `busybox sh -c "echo migrated"` takes ~1 s, not the old
        // artificial 25 s (issue #75 L19/lab 12).
        pod._completionAtGameSeconds = this.gameSeconds + this._estimateJobPodDuration(job);
        pod._jobUid = job.uid;
        pod._jobLogLines = this._jobContainerOutput(container);
        this._applyJobPodOutput(job, pod);
      }

      // Simulated-time completion (was wall-clock Date.now() based).
      for (const pod of activePods) {
        if (pod.status.phase !== 'Running') continue;
        if (
          typeof pod._completionAtGameSeconds === 'number' &&
          this.gameSeconds >= pod._completionAtGameSeconds
        ) {
          pod.setPhase('Succeeded');
          for (const status of pod.status.containerStatuses || []) {
            status.state = {
              terminated: {
                exitCode: 0,
                reason: 'Completed',
                finishedAt: new Date().toISOString(),
              },
            };
            status.ready = false;
            status.started = false;
          }
          pod.setCondition('Ready', 'False', 'ContainersNotReady', 'pod completed');
          pod.setCondition('ContainersReady', 'False', 'ContainersNotReady');
          pod.recordEvent('Normal', 'Completed', 'Pod completed successfully');
          this._applyJobPodOutput(job, pod);
        }
      }

      const succeededNow = jobPods().filter((pod) => pod.status.phase === 'Succeeded').length;
      job.status.succeeded = succeededNow;
      job.status.failed = jobPods().filter((pod) => pod.status.phase === 'Failed').length;
      job.status.active = jobPods().filter(
        (pod) => pod.status.phase === 'Running' || pod.status.phase === 'Pending'
      ).length;
      if (succeededNow >= completions)
        finishJob('Complete', 'JobComplete', 'Job completed successfully');
    }
  }

  /**
   * Evaluate a trivial container command's stdout for `oc logs job/<name>`
   * (issue #31): `perl -e "print 42"` prints 42, `-- sh -c date` prints a date,
   * an `echo` script prints its text. Unknown commands produce no output (what
   * a silent image would really print) instead of the generic app-server lines.
   * @param {object} container
   * @returns {string[]}
   */
  _jobContainerOutput(container) {
    const argv = [...(container?.command || []), ...(container?.args || [])].map(String);
    const joined = argv.join(' ');
    const lines = [];
    if (!joined.trim()) return lines;
    // `print <number>` (perl/ruby/python one-liners) — evaluate + - * / chains.
    const printMatch = joined.match(/\bprint\s+(-?\d+(?:\s*[-+*/]\s*-?\d+)*)/);
    if (printMatch) {
      let value = null;
      try {
        const tokens = printMatch[1].match(/-?\d+|[-+*/]/g) || [];
        const ops = ['*', '/', '+', '-'];
        for (const op of ops) {
          while (tokens.indexOf(op) > 0) {
            const index = tokens.indexOf(op);
            const left = Number(tokens[index - 1]);
            const right = Number(tokens[index + 1]);
            const result =
              op === '*'
                ? left * right
                : op === '/'
                  ? left / right
                  : op === '+'
                    ? left + right
                    : left - right;
            tokens.splice(index - 1, 3, String(result));
          }
        }
        value = tokens.length === 1 ? Number(tokens[0]) : null;
      } catch {
        value = null;
      }
      if (Number.isFinite(value)) lines.push(String(value));
    }
    // `echo "text"` / `echo text` lines (e.g. a script's progress output).
    const echoMatch = joined.match(/\becho\s+(?:"([^"]*)"|'([^']*)'|([^;&|]+))/);
    if (echoMatch) {
      const text = (echoMatch[1] ?? echoMatch[2] ?? echoMatch[3] ?? '').trim();
      if (text) lines.push(text);
    }
    // `date` / `date +<format>` prints an RFC-ish timestamp.
    if (/\bdate\b/.test(joined) && !lines.length) lines.push(new Date().toISOString());
    return lines.slice(0, 10);
  }

  /**
   * Game-seconds a Job Pod's container runs before it exits 0.
   *
   * A real kubelet starts the container and it exits as soon as its command
   * finishes: `busybox sh -c "echo migrated"` / `perl -e "print 42"` are
   * ~2 s Jobs, not 25-30 s ones (issue #75). Authored long tasks keep their
   * `spec.estimatedDurationSeconds`; the value is deterministic per Job name so
   * `oc get job -w` is testable.
   *
   * @param {object} job
   * @returns {number}
   */
  _estimateJobPodDuration(job) {
    const explicit = Number(job?.spec?.estimatedDurationSeconds);
    if (Number.isFinite(explicit) && explicit > 0) {
      const jitter = (this._hashString(`${job.metadata?.name || 'job'}:duration`) % 401) / 1000;
      return Math.max(1, explicit) * (0.8 + jitter);
    }
    const container = job?.spec?.template?.spec?.containers?.[0] || {};
    const script = [...(container.command || []), ...(container.args || [])].map(String).join(' ');
    // A `sleep N` (possibly inside `sh -c "…"`) dominates the process lifetime.
    const sleepMatch = script.match(/\bsleep\s+(\d+(?:\.\d+)?)/);
    if (sleepMatch) return Number(sleepMatch[1]) + 1;
    // `perl -Mbignum=bpi … print bpi(2000)` really computes for several seconds.
    if (/\bprint\s+bpi\(/.test(script)) return 6;
    // Trivial commands (echo/print/date/true/printf/cat) or no command at all
    // (the image's default CMD, e.g. the `busybox` shell) exit immediately.
    if (!script.trim() || /\b(echo|print|date|true|printf|cat)\b/.test(script)) return 2;
    // Unknown workload: keep the historical default of a 30 s task.
    return 30;
  }

  /**
   * Persist the Job Pod's real stdout on the Pod so `oc logs job/<name>` renders
   * it even after the Job finishes (the Pod object is kept, as on a real cluster
   * until ttlSecondsAfterFinished / job deletion). Issue #31.
   * @param {object} job
   * @param {object} pod
   */
  _applyJobPodOutput(job, pod) {
    if (!job || !pod) return;
    const container = job.spec?.template?.spec?.containers?.[0] || {};
    const lines = Array.isArray(pod._jobLogLines) ? pod._jobLogLines : null;
    const output = lines || this._jobContainerOutput(container);
    pod.setAnnotation('openshiftgames.io/logs', JSON.stringify(output));
    pod.setAnnotation('openshiftgames.io/logs-previous', JSON.stringify(output));
    pod.setAnnotation(
      'openshiftgames.io/logs-container',
      (pod.status?.containerStatuses || [])[0]?.name || container.name || 'main'
    );
  }

  _tickCronJobs(dt) {
    for (const cronJob of this.cluster.getByKind('CronJob')) {
      const namespace = cronJob.metadata.namespace;
      const jobs = this.cluster.getChildren(cronJob.uid).filter((child) => child.kind === 'Job');
      const running = jobs.filter(
        (job) =>
          job.status.phase !== 'Complete' &&
          job.status.phase !== 'Failed' &&
          !job.metadata.deletionTimestamp
      );
      const completed = jobs
        .filter((job) => job.status.phase === 'Complete')
        .sort(
          (a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp)
        );
      const failed = jobs
        .filter((job) => job.status.phase === 'Failed')
        .sort(
          (a, b) => new Date(a.metadata.creationTimestamp) - new Date(b.metadata.creationTimestamp)
        );

      // CronJob.status.active is an array of Job object references (batch/v1).
      cronJob.status.active = running.map((job) => ({
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: job.metadata.name,
        namespace,
        uid: job.metadata.uid,
      }));
      cronJob.status.suspend = cronJob.spec.suspend === true;
      const lastCompleted = completed[completed.length - 1];
      if (lastCompleted)
        cronJob.status.lastSuccessfulTime =
          lastCompleted.status.completionTime || cronJob.status.lastSuccessfulTime;

      const successLimit = Number.isFinite(Number(cronJob.spec.successfulJobsHistoryLimit))
        ? Number(cronJob.spec.successfulJobsHistoryLimit)
        : 3;
      const failedLimit = Number.isFinite(Number(cronJob.spec.failedJobsHistoryLimit))
        ? Number(cronJob.spec.failedJobsHistoryLimit)
        : 1;
      while (completed.length > successLimit) this.cluster.remove(completed.shift().uid);
      while (failed.length > failedLimit) this.cluster.remove(failed.shift().uid);

      if (cronJob.spec.suspend) continue;

      // Real cron validation + next-run scheduling: a CronJob never creates a
      // Job at creation time, only at the next occurrence of its schedule
      // (issue #14). The simulated clock advances with game time.
      const parsed = parseCronSchedule(cronJob.spec.schedule || '*/5 * * * *');
      if (!parsed.valid) {
        if (!cronJob._invalidScheduleLogged) {
          cronJob._invalidScheduleLogged = true;
          cronJob.setCondition(
            'ScheduleInvalid',
            'True',
            'InvalidSchedule',
            `invalid CronJob schedule: ${parsed.message || cronJob.spec.schedule}`
          );
          cronJob.recordEvent(
            'Warning',
            'InvalidSchedule',
            `invalid CronJob schedule: ${parsed.message || cronJob.spec.schedule}`
          );
          this.cluster.update(cronJob.uid, cronJob);
        }
        continue;
      }
      cronJob._invalidScheduleLogged = false;
      const nowMs = this._virtualNowMs();
      if (
        typeof cronJob._nextScheduleAtMs !== 'number' ||
        !Number.isFinite(cronJob._nextScheduleAtMs)
      ) {
        const next = nextCronOccurrence(parsed, new Date(nowMs));
        cronJob._nextScheduleAtMs = next ? next.getTime() : Number.POSITIVE_INFINITY;
        this.cluster.update(cronJob.uid, cronJob);
        continue;
      }
      if (nowMs < cronJob._nextScheduleAtMs) continue;
      const scheduledAtMs = cronJob._nextScheduleAtMs;
      const scheduledAt = new Date(scheduledAtMs);

      const policy = cronJob.spec.concurrencyPolicy || 'Allow';
      if (running.length > 0) {
        if (policy === 'Forbid') {
          cronJob.recordEvent(
            'Normal',
            'JobAlreadyActive',
            'Skipped scheduled job: concurrency policy Forbid'
          );
          cronJob.status.lastScheduleTime = scheduledAt.toISOString();
          const nextSkip = nextCronOccurrence(parsed, scheduledAt);
          cronJob._nextScheduleAtMs = nextSkip ? nextSkip.getTime() : Number.POSITIVE_INFINITY;
          this.cluster.update(cronJob.uid, cronJob);
          continue;
        }
        if (policy === 'Replace') {
          for (const job of running) this.cluster.remove(job.uid);
          cronJob.recordEvent(
            'Normal',
            'JobReplaced',
            'Replaced a running job due to concurrency policy Replace'
          );
        }
      }

      // Real job names are `<cronjob>-<scheduled epoch minutes>`.
      let jobName = `${cronJob.metadata.name}-${Math.floor(scheduledAtMs / 60000)}`;
      let suffix = 0;
      while (this.cluster.getByName('Job', jobName, namespace)) {
        suffix += 1;
        jobName = `${cronJob.metadata.name}-${Math.floor(scheduledAtMs / 60000)}-${suffix}`;
      }
      const jobSpec = deepClone(cronJob.spec.jobTemplate?.spec || {});
      const newJob = this.cluster.addResource({
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace,
          labels: {
            ...(cronJob.spec.jobTemplate?.metadata?.labels || {}),
            'cronjob.kubernetes.io/name': cronJob.metadata.name,
          },
          annotations: deepClone(cronJob.spec.jobTemplate?.metadata?.annotations || {}),
          ownerReferences: [this._controllerOwnerReference(cronJob)],
        },
        spec: jobSpec,
      });
      if (!newJob) continue;
      this.cluster.addRelationship(cronJob.uid, newJob.uid);
      cronJob.status.lastScheduleTime = scheduledAt.toISOString();
      cronJob.status.active = [
        ...(cronJob.status.active || []),
        { apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace, uid: newJob.metadata.uid },
      ];
      cronJob.recordEvent('Normal', 'SuccessfulCreate', `Created job ${jobName}`);
      const nextAfterJob = nextCronOccurrence(parsed, new Date(scheduledAtMs + 1000));
      cronJob._nextScheduleAtMs = nextAfterJob ? nextAfterJob.getTime() : Number.POSITIVE_INFINITY;
      this.cluster.update(cronJob.uid, cronJob);
    }
  }

  /**
   * Recent Event objects across the cluster (issue #21).
   *
   * Every resource keeps its own Event history (`resource.getEvents()`); the CLI
   * merges these with its synthetic event stream so controller events such as
   * the ReplicaSet `Warning FailedCreate` emitted by SCC admission are visible
   * to `oc get events --field-selector reason=FailedCreate`.
   *
   * @param {{namespace?: string, allNamespaces?: boolean, reason?: string, type?: string, limit?: number}} [options]
   * @returns {Array<{type: string, reason: string, message: string, involvedObject: object, namespace: string, object: string, source: string, count: number, firstTimestamp: string, lastTimestamp: string}>}
   */
  getEvents(options = {}) {
    const namespace = options.namespace || null;
    const allNamespaces = options.allNamespaces === true || !namespace;
    const reasonFilter = options.reason ? String(options.reason) : null;
    const typeFilter = options.type ? String(options.type) : null;
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
    const events = [];
    const resources =
      typeof this.cluster.getAllResources === 'function'
        ? this.cluster.getAllResources()
        : this.cluster.getByKind('Pod') || [];
    for (const resource of resources) {
      if (!resource) continue;
      const eventList =
        typeof resource.getEvents === 'function' ? resource.getEvents() : resource.events || [];
      for (const event of eventList || []) {
        if (!event || !event.reason) continue;
        const involvedObject = event.involvedObject || {};
        const eventNamespace = involvedObject.namespace || resource.metadata?.namespace || '';
        if (!allNamespaces && eventNamespace !== namespace) continue;
        if (reasonFilter && String(event.reason) !== reasonFilter) continue;
        if (typeFilter && String(event.type) !== typeFilter) continue;
        const kind = involvedObject.kind || resource.kind || 'Resource';
        const name = involvedObject.name || resource.metadata?.name || '';
        events.push({
          type: String(event.type || 'Normal'),
          reason: String(event.reason),
          message: String(event.message || ''),
          involvedObject: {
            kind,
            name,
            namespace: eventNamespace,
            uid: involvedObject.uid || resource.metadata?.uid || '',
          },
          namespace: eventNamespace,
          object: `${String(kind).toLowerCase()}/${name}`,
          source: event.source || kind,
          count: Number(event.count) || 1,
          firstTimestamp: event.firstTimestamp || event.timestamp || new Date().toISOString(),
          lastTimestamp: event.lastTimestamp || event.timestamp || new Date().toISOString(),
        });
      }
    }
    events.sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp)));
    return events.slice(0, limit);
  }

  /** Virtual wall-clock for CronJob scheduling (simulated time). */
  _virtualNowMs() {
    return this._simEpoch + this.gameSeconds * 1000;
  }

  _tickHPA(dt) {
    const TOLERANCE = 0.1; // --horizontal-pod-autoscaler-tolerance default
    for (const hpa of this.cluster.getByKind('HorizontalPodAutoscaler')) {
      const targetRef = hpa.spec.scaleTargetRef;
      if (!targetRef) continue;
      hpa.status.observedGeneration = hpa.metadata.generation;
      const target = this.cluster.getByName(targetRef.kind, targetRef.name, hpa.namespace);
      if (!target) {
        hpa.setCondition(
          'ScalingActive',
          'False',
          'FailedGetScale',
          `the HPA controller was unable to get the target's current scale: ${String(targetRef.kind).toLowerCase()}s.apps "${targetRef.name}" not found`
        );
        this.cluster.update(hpa.uid, hpa);
        continue;
      }

      const currentReplicas = Math.max(0, Number(target.spec.replicas ?? 1) || 0);
      const minReplicas = Number.isFinite(Number(hpa.spec.minReplicas))
        ? Number(hpa.spec.minReplicas)
        : 1;
      const maxReplicas = Number.isFinite(Number(hpa.spec.maxReplicas))
        ? Number(hpa.spec.maxReplicas)
        : 10;
      const metrics = hpa.spec.metrics || [
        {
          type: 'Resource',
          resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 50 } },
        },
      ];
      let desiredReplicas = currentReplicas;
      let metricsAvailable = true;
      const statusMetrics = [];

      for (const metric of metrics) {
        if (metric.type !== 'Resource' || !metric.resource) continue;
        const resourceName = metric.resource.name || 'cpu';
        const targetUtilization =
          Number(
            metric.resource.targetAverageUtilization ??
              metric.resource.target?.averageUtilization ??
              50
          ) || 50;
        const measured = this._getWorkloadCpuUtilization(target);
        if (!measured.available) {
          metricsAvailable = false;
          statusMetrics.push({
            type: 'Resource',
            resource: { name: resourceName, current: { averageUtilization: 0 } },
          });
          continue;
        }
        statusMetrics.push({
          type: 'Resource',
          resource: {
            name: resourceName,
            current: {
              averageUtilization: measured.utilization,
              averageValue: `${Math.round(measured.averageUsageMillis)}m`,
            },
          },
        });
        const ratio = measured.utilization / targetUtilization;
        if (ratio > 1 + TOLERANCE)
          desiredReplicas = Math.max(desiredReplicas, Math.ceil(currentReplicas * ratio));
        else if (ratio < 1 - TOLERANCE)
          desiredReplicas = Math.min(desiredReplicas, Math.ceil(currentReplicas * ratio));
      }

      if (!metricsAvailable) {
        // Real HPA: no metrics sample -> TARGETS `<unknown>/50%`; currentMetrics
        // stays empty (a 0% sample would be a lie) and REPLICAS stays at its
        // last successful value (0 until the first successful sync).
        hpa.status.currentMetrics = [];
        hpa.status.desiredReplicas = Number(hpa.status.currentReplicas || 0) || 0;
        hpa.setCondition(
          'ScalingActive',
          'False',
          'FailedGetResourceMetric',
          'the HPA was unable to compute the replica count: no metrics returned'
        );
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
        this.cluster.update(hpa.uid, hpa);
        continue;
      }
      hpa.status.currentMetrics = statusMetrics;
      hpa.status.currentReplicas = currentReplicas;

      const rawDesiredReplicas = Math.max(minReplicas, Math.min(maxReplicas, desiredReplicas));
      desiredReplicas = rawDesiredReplicas;
      hpa.setCondition(
        'ScalingActive',
        'True',
        'ValidMetricFound',
        'the HPA was able to successfully calculate a replica count from cpu resource utilization'
      );
      if (desiredReplicas >= maxReplicas && currentReplicas < desiredReplicas) {
        hpa.setCondition(
          'ScalingLimited',
          'True',
          'TooManyReplicas',
          'the desired replica count is more than the maximum replica count'
        );
      } else if (desiredReplicas <= minReplicas && currentReplicas > desiredReplicas) {
        hpa.setCondition(
          'ScalingLimited',
          'True',
          'TooFewReplicas',
          'the desired replica count is less than the minimum replica count'
        );
      } else {
        hpa.setCondition('ScalingLimited', 'False', 'DesiredWithinRange', '');
      }

      // Rate limits: ~+4 pods (or x2) per scale-up, at most halve on scale-down.
      const scaleUpLimit = Math.max(4, currentReplicas * 2);
      const scaleDownLimit = Math.max(1, Math.floor(currentReplicas * 0.5));
      let nextReplicas = desiredReplicas;
      if (nextReplicas > currentReplicas)
        nextReplicas = Math.min(nextReplicas, currentReplicas + scaleUpLimit);
      else if (nextReplicas < currentReplicas)
        nextReplicas = Math.max(nextReplicas, scaleDownLimit);

      if (nextReplicas !== currentReplicas) {
        const lastScaleTime = hpa.status.lastScaleTime
          ? new Date(hpa.status.lastScaleTime).getTime()
          : 0;
        const cooldown = nextReplicas > currentReplicas ? 30000 : 300000;
        if (Date.now() - lastScaleTime >= cooldown) {
          const direction = nextReplicas > currentReplicas ? 'up' : 'down';
          target.spec.replicas = nextReplicas;
          target.metadata.generation++;
          this.cluster.update(target.uid, target);
          hpa.status.currentReplicas = nextReplicas;
          hpa.status.desiredReplicas = nextReplicas;
          hpa.status.lastScaleTime = new Date().toISOString();
          hpa.recordEvent(
            'Normal',
            'SuccessfulRescale',
            `New size: ${nextReplicas}; reason: cpu resource utilization (percentage of request) above target`
          );
          this.eventBus?.emit('hpa:scaled', {
            hpa: hpa.metadata.name,
            target: target.metadata.name,
            from: currentReplicas,
            to: nextReplicas,
            direction,
          });
        }
      } else {
        hpa.status.desiredReplicas = desiredReplicas;
      }
      this.cluster.update(hpa.uid, hpa);
    }
  }

  /**
   * Workload CPU utilization (sum usage / sum requests) over Running pods.
   * @returns {{available: boolean, utilization: number, averageUsageMillis: number}}
   */
  _getWorkloadCpuUtilization(workload) {
    const selector = workload.spec.selector?.matchLabels || workload.metadata.labels || {};
    const pods = this.cluster
      .selectByLabels('Pod', selector)
      .filter(
        (pod) =>
          pod.metadata.namespace === workload.metadata.namespace && pod.status.phase === 'Running'
      );
    let totalUsage = 0;
    let totalRequest = 0;
    for (const pod of pods) {
      for (const status of pod.status.containerStatuses || []) {
        totalUsage += Number(status._cpuSmooth ?? status.resources?.cpu) || 0;
        totalRequest += Number(status.resources?.cpuRequest) || 0;
      }
    }
    if (pods.length === 0 || totalRequest <= 0) {
      return { available: false, utilization: 0, averageUsageMillis: 0 };
    }
    return {
      available: true,
      utilization: Math.round((totalUsage / totalRequest) * 100),
      averageUsageMillis: totalUsage / pods.length,
    };
  }

  // ── Storage: PersistentVolumeClaim binding ─────────────────────────────

  /** PVC → PV binding controller (static matching + dynamic provisioning). */
  _tickPersistentVolumeClaims(dt) {
    const claims = this.cluster.getByKind('PersistentVolumeClaim');
    if (claims.length === 0) return;

    for (const claim of claims) {
      const phase = claim.status.phase;
      if (phase === 'Bound') {
        if (claim.metadata.deletionTimestamp && claim.spec.volumeName) {
          const volume = this.cluster.getByName('PersistentVolume', claim.spec.volumeName, '');
          if (volume) {
            volume.status.phase = 'Released';
            this.cluster.update(volume.uid, volume);
          }
        }
        continue;
      }

      const request = claim.spec.resources?.requests?.storage || '1Gi';
      const requestMi = parseMemoryMi(request);
      const accessModes = claim.spec.accessModes || ['ReadWriteOnce'];

      const existing = this.cluster.getByKind('PersistentVolume').find((volume) => {
        if (volume.status.phase !== 'Available') return false;
        if ((volume.spec.storageClassName || '') !== (claim.spec.storageClassName || ''))
          return false;
        if (parseMemoryMi(volume.spec.capacity?.storage || '0') < requestMi) return false;
        return (
          accessModes.every((mode) => (volume.spec.accessModes || []).includes(mode)) &&
          volume.matchesSelector(claim.spec.selector?.matchLabels || {})
        );
      });

      let volume = existing;
      if (!volume) {
        const storageClass = this._findStorageClass(claim.spec.storageClassName);
        if (
          storageClass &&
          storageClass.spec?.provisioner &&
          storageClass.spec.provisioner !== 'kubernetes.io/no-provisioner'
        ) {
          volume = this.cluster.addResource({
            kind: 'PersistentVolume',
            metadata: {
              name: `pvc-${claim.metadata.uid}`.toLowerCase().slice(0, 63),
              labels: { ...claim.metadata.labels },
              annotations: { 'pv.kubernetes.io/provisioned-by': storageClass.spec.provisioner },
            },
            spec: {
              capacity: { storage: request },
              accessModes: [...accessModes],
              persistentVolumeReclaimPolicy: storageClass.spec.reclaimPolicy || 'Delete',
              storageClassName: storageClass.metadata.name,
              claimRef: {
                kind: 'PersistentVolumeClaim',
                name: claim.metadata.name,
                namespace: claim.metadata.namespace,
                uid: claim.metadata.uid,
              },
            },
            status: { phase: 'Bound' },
          });
        }
      }

      if (!volume) {
        claim.setCondition(
          'Pending',
          'True',
          'ProvisioningFailed',
          `no persistent volumes available for this claim and no storage class is set`
        );
        continue;
      }

      claim.status.phase = 'Bound';
      claim.status.capacity = { storage: volume.spec.capacity?.storage || request };
      claim.status.accessModes = [...accessModes];
      claim.spec.volumeName = volume.metadata.name;
      volume.status.phase = 'Bound';
      volume.spec.claimRef = {
        kind: 'PersistentVolumeClaim',
        name: claim.metadata.name,
        namespace: claim.metadata.namespace,
        uid: claim.metadata.uid,
      };
      claim.recordEvent(
        'Normal',
        'Bound',
        `PVC ${claim.metadata.name} bound to PV ${volume.metadata.name}`
      );
      this.cluster.update(claim.uid, claim);
      this.cluster.update(volume.uid, volume);
      this.eventBus?.emit('pvc:bound', {
        claim: claim.metadata.name,
        namespace: claim.metadata.namespace,
        volume: volume.metadata.name,
        resource: claim,
      });
    }
  }

  /** Find a StorageClass by name (or the default storage class). */
  _findStorageClass(storageClassName) {
    const storageClasses = this.cluster.getByKind('StorageClass');
    if (storageClassName)
      return storageClasses.find((entry) => entry.metadata.name === storageClassName) || null;
    return (
      storageClasses.find(
        (entry) =>
          entry.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
      ) ||
      storageClasses.find(
        (entry) => (entry.spec?.provisioner || '') !== 'kubernetes.io/no-provisioner'
      ) ||
      null
    );
  }

  // ── OpenShift: routes / services / MetalLB ─────────────────────────────

  /**
   * Service endpoint accounting. ClusterState.getServiceEndpoints() is the
   * canonical resolver (ready Running pods matching selector+namespace); the
   * instance `service.endpoints` list is kept in sync with it and never leaks
   * into the API-object `status` (issues #59/#60: real Service status only has
   * loadBalancer).
   */
  _tickProbes(dt) {
    for (const service of this.cluster.getByKind('Service')) {
      service.updateEndpoints(this.cluster.getServiceEndpoints(service));
    }
  }

  /** Route admission controller (CONVERSION-SPEC §5). */
  _tickRoutes(dt) {
    for (const route of this.cluster.getByKind('Route')) {
      const service = this.cluster.getRouteService(route);
      const namespace = route.metadata.namespace;
      const host = this.cluster.getRouteHost(route);
      if (!route.spec.host) route.spec.host = host;

      let admitted = false;
      let reason = 'ServiceUnavailable';
      let message = 'no endpoints available';

      // Issue #39: a Route that references an external certificate is only
      // admitted once the kubernetes.io/tls Secret exists AND the
      // openshift-ingress router service account can get/list/watch it (the
      // documented Role + RoleBinding grant). Until then the router reports
      // Admitted=False, reason ExternalCertificateValidationFailed, with the
      // same aggregate validation message a real 4.22 router records.
      const externalCertificate = this._externalCertificateName(route);
      const externalCertificateError = externalCertificate
        ? this._externalCertificateValidationError(route, externalCertificate)
        : null;
      if (route.spec.rejected === true || route._forceReject === true) {
        reason = 'Rejected';
        message = route._rejectMessage || 'the route has been rejected by the router configuration';
      } else if (externalCertificateError) {
        reason = 'ExternalCertificateValidationFailed';
        message = externalCertificateError;
      } else if (!route.spec.to || route.spec.to.kind !== 'Service') {
        reason = 'InvalidTargetKind';
        message = 'route target must be a Service';
      } else if (!service) {
        reason = 'ServiceNotFound';
        message = `service "${route.spec.to.name}" not found`;
      } else {
        // Issue #52: Route ADMISSION is a host/path-ownership and TLS/config
        // check only. A Service with NO ready endpoints stays Admitted=True —
        // the HAProxy router simply answers 503 for that host. The old
        // "no endpoints available" ServiceUnavailable admission reason made the
        // Route look broken when the real fault is the Service selector.
        const claim = this._routeHostClaimConflict(route, host);
        if (claim) {
          reason = 'HostAlreadyClaimed';
          message = claim.message;
        } else {
          admitted = true;
          reason = 'Accepted';
          message = 'The route has been admitted by the router';
        }
      }

      const previous = route._admittedState;
      route._admittedState = admitted;
      route.status = route.status || {};
      // lastTransitionTime only changes when the condition itself changes (a
      // real router keeps republishing the same condition; `oc describe route`
      // shows the age since the last actual transition).
      const statusValue = admitted ? 'True' : 'False';
      const priorCondition = route._admittedCondition;
      const unchanged =
        priorCondition &&
        priorCondition.status === statusValue &&
        priorCondition.reason === reason &&
        priorCondition.message === message;
      const condition = {
        type: 'Admitted',
        status: statusValue,
        reason,
        message,
        lastTransitionTime: unchanged
          ? priorCondition.lastTransitionTime
          : new Date().toISOString(),
      };
      route._admittedCondition = condition;
      route.status.ingress = [
        {
          host,
          routerName: 'default',
          routerCanonicalHostname: `router-default.${APPS_DOMAIN}`,
          wildcardPolicy: route.spec.wildcardPolicy || 'None',
          conditions: [condition],
        },
      ];
      route.status.observedGeneration = route.metadata.generation;

      if (admitted && previous !== true) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:admitted', {
          route: route.metadata.name,
          host,
          namespace,
          resource: route,
        });
      } else if (!admitted && previous !== false) {
        this.cluster.update(route.uid, route);
        this.eventBus?.emit('route:not-admitted', {
          route: route.metadata.name,
          host,
          namespace,
          reason,
          message,
          resource: route,
        });
      }
    }
  }

  /**
   * Host-ownership admission check (OpenShift router `UniqueHost` plugin).
   *
   * The router requires a unique host+path claim: with the default
   * `namespaceOwnership: Strict` route admission the OLDEST route for a
   * host/path combination is admitted and later claims report
   * `Admitted=False, reason=HostAlreadyClaimed` with the router's own wording
   * ("route X already exposes H and is older" / "a route in another namespace
   * holds H and is older than X"). Deleting the owner admits the waiting route
   * on the next reconcile.
   *
   * @param {object} route
   * @param {string} host
   * @returns {{owner: object, message: string}|null}
   */
  _routeHostClaimConflict(route, host) {
    const namespace = route?.metadata?.namespace || '';
    const path = this._routeAdmissionPath(route);
    const claims = [route];
    for (const other of this.cluster.getByKind('Route')) {
      if (other === route) continue;
      if (this.cluster.getRouteHost(other) !== host) continue;
      const otherNamespace = other.metadata?.namespace || '';
      const otherPath = this._routeAdmissionPath(other);
      // Different namespaces always conflict under Strict ownership; within one
      // namespace only a duplicate host+path is a conflict.
      const conflicts =
        otherNamespace !== namespace || (otherPath === path && otherNamespace === namespace);
      if (conflicts) claims.push(other);
    }
    if (claims.length < 2) return null;
    claims.sort((left, right) => this._compareRouteClaims(left, right));
    const owner = claims[0];
    if (owner === route) return null;
    const sameNamespace = (owner.metadata?.namespace || '') === namespace;
    return {
      owner,
      message: sameNamespace
        ? `route ${owner.metadata.name} already exposes ${host} and is older`
        : `a route in another namespace holds ${host} and is older than ${route.metadata.name}`,
    };
  }

  /** Normalised `spec.path` used by the router's host+path uniqueness rule. */
  _routeAdmissionPath(route) {
    const path = String(route?.spec?.path || '');
    return path && path !== '/' ? path.replace(/\/$/, '') : '/';
  }

  /** Real `RouteLessThan`: oldest creationTimestamp wins, then UID. */
  _compareRouteClaims(left, right) {
    const leftTime = String(left.metadata?.creationTimestamp || '');
    const rightTime = String(right.metadata?.creationTimestamp || '');
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    const leftUid = String(left.uid || left.metadata?.uid || '');
    const rightUid = String(right.uid || right.metadata?.uid || '');
    if (leftUid !== rightUid) return leftUid < rightUid ? -1 : 1;
    return String(left.metadata?.name || '').localeCompare(String(right.metadata?.name || ''));
  }

  /**
   * `spec.tls.externalCertificate.name` of a Route (OCP 4.22 external
   * certificate management), or null when the route does not use one.
   * @param {object} route
   * @returns {string|null}
   */
  _externalCertificateName(route) {
    const name = route?.spec?.tls?.externalCertificate?.name;
    return name ? String(name) : null;
  }

  /**
   * Aggregate validation error for a Route's external certificate, or null when
   * the router can serve it. Mirrors OCP 4.22 `ValidateTLSExternalCertificate`:
   * the `system:serviceaccount:openshift-ingress:router` subject must be allowed
   * to get/watch/list the named Secret (SubjectAccessReviews run even when the
   * Secret is missing), and the referenced Secret must exist with type
   * kubernetes.io/tls.
   *
   * @param {object} route
   * @param {string} secretName
   * @returns {string|null}
   */
  _externalCertificateValidationError(route, secretName) {
    const namespace = route.metadata.namespace;
    const fldPath = 'spec.tls.externalCertificate';
    const errors = [];
    // Router service-account SARs, in the real order (get, watch, list).
    for (const verb of ['get', 'watch', 'list']) {
      if (!this._routerServiceAccountCan(namespace, verb, 'secrets', secretName)) {
        errors.push(
          `${fldPath}: Forbidden: router serviceaccount does not have permission to ${verb} this secret`
        );
      }
    }
    const secret = this.cluster.getByName('Secret', secretName, namespace);
    if (!secret) {
      errors.push(`${fldPath}: Not found: secrets "${secretName}" not found`);
    } else if ((secret.spec?.type || secret.type) !== 'kubernetes.io/tls') {
      errors.push(
        `${fldPath}: Invalid value: "${secretName}": secret of type "kubernetes.io/tls" required`
      );
    }
    return errors.length > 0 ? errors.join(', ') : null;
  }

  /**
   * SubjectAccessReview-style check for the ingress router service account:
   * does a RoleBinding/ClusterRoleBinding grant `verb` on `resource` named
   * `resourceName` in `namespace` to `system:serviceaccount:openshift-ingress:router`?
   * Honours `verbs`, `resources`, `apiGroups`, `resourceNames` (a rule without
   * resourceNames grants every name, as the real authorizer does).
   *
   * @param {string} namespace
   * @param {string} verb
   * @param {string} resource e.g. `secrets`
   * @param {string} resourceName
   * @returns {boolean}
   */
  _routerServiceAccountCan(namespace, verb, resource, resourceName) {
    const identitySubject = (subject) => {
      if (!subject || String(subject.kind || '').toLowerCase() !== 'serviceaccount') return false;
      if (String(subject.name || '') !== 'router') return false;
      const subjectNamespace = subject.namespace || '';
      // A missing namespace on a ServiceAccount subject means the binding's
      // own project, but the router SA lives in openshift-ingress.
      return subjectNamespace === ROUTER_NAMESPACE;
    };
    const rulesOf = (roleRef) => {
      if (!roleRef || !roleRef.name) return [];
      if (String(roleRef.kind) === 'Role') {
        const role = this.cluster.getByName('Role', roleRef.name, namespace);
        return role ? role.rules || role.spec?.rules || [] : [];
      }
      if (String(roleRef.kind) === 'ClusterRole') {
        const role = this.cluster.getByName('ClusterRole', roleRef.name, '');
        return role ? role.rules || role.spec?.rules || [] : [];
      }
      return [];
    };
    const grants = (binding) => {
      const subjects = binding?.spec?.subjects || binding?.subjects || [];
      if (!subjects.some(identitySubject)) return [];
      return rulesOf(binding?.spec?.roleRef || binding?.roleRef);
    };
    const parsed = {
      kind: 'Secret',
      name: resourceName,
      subresource: null,
      tokens: new Set([resource, 'secret']),
    };
    const rules = [
      ...(this.cluster.getByKindAndNamespace('RoleBinding', namespace) || []).flatMap(grants),
      ...(this.cluster.getByKind('ClusterRoleBinding') || []).flatMap(grants),
    ];
    return rules.some((rule) => ruleMatches(rule, verb, parsed));
  }

  /**
   * MetalLB controller: when the MetalLB operator is installed and an
   * IPAddressPool is advertised by an L2Advertisement, assign EXTERNAL-IPs to
   * Services of type LoadBalancer (CONVERSION-SPEC §5).
   */
  _tickOperatorEffects(dt) {
    this._tickMetalLBOperands(dt);
    this._tickMetalLB(dt);
  }

  /**
   * Public synchronous seed hook for the app bootstrap (`launchGame`).
   *
   * The OLM catalog + global OperatorGroup are part of the seeded platform but
   * are owned by the simulation layer. They must exist BEFORE the app runs its
   * initial cluster auto-align (`_layoutClusterAfterModeStart`) so every mesh
   * gets a unique layout target; the per-tick {@link _ensureOLMDefaults} stays
   * as an idempotent safety net (level changes, manual deletion, saved games).
   *
   * @returns {void}
   */
  ensureOLMDefaultsSync() {
    this._ensureOLMDefaults();
    // Platform workload pods are part of the seeded 4.22 platform (#53G): create
    // them synchronously too, so the auto-align lays out each mesh instead of
    // adding them after the first tick at the fallback position.
    this._ensurePlatformWorkloads();
    // The oauth-openshift control-plane pods are controller-owned too: create
    // the ReplicaSet + pods synchronously before the app auto-align so each mesh
    // gets a unique layout target (otherwise RS + 2 pods share the deployment's
    // fallback position and break the fresh-level alignment uniqueness check).
    this.ensureOAuthDefaultsSync();
  }

  /**
   * Synchronously materialise the oauth-openshift ReplicaSet and its pods.
   * Idempotent: safe to call before every post-launch auto-align (level start,
   * restart) and from the per-tick controller afterwards.
   * @returns {object|null} the ReplicaSet when the deployment exists
   */
  ensureOAuthDefaultsSync() {
    const deployment = this.cluster.getByName(
      'Deployment',
      'oauth-openshift',
      'openshift-authentication'
    );
    if (!deployment) return null;
    const template = deepClone(deployment.spec.template || {});
    const templateHash = this._templateHash(template);
    const ownedSets = this.cluster
      .getChildren(deployment.uid)
      .filter((child) => child.kind === 'ReplicaSet');
    let replicaSet = ownedSets.find(
      (rs) => rs.metadata.labels?.['pod-template-hash'] === templateHash
    );
    if (!replicaSet) {
      replicaSet = this._createDeploymentReplicaSet(
        deployment,
        template,
        templateHash,
        deepClone(deployment.spec.selector?.matchLabels || deployment.metadata.labels || {}),
        ownedSets
      );
    }
    if (!replicaSet) return null;
    const desired = Math.max(0, Number(deployment.spec.replicas ?? 1) || 0);
    const pods = this._activePodsOf(replicaSet);
    if (pods.length < desired) {
      for (let index = 0; index < desired - pods.length; index += 1) {
        this._createPodForWorkload(replicaSet, replicaSet);
      }
    }
    this._refreshReplicaSetStatus(replicaSet, this._activePodsOf(replicaSet), 0);
    return replicaSet;
  }

  /**
   * Ensure the simulated openshift-marketplace software catalog exists:
   * PackageManifest objects (cluster-scoped) + the global-operators
   * OperatorGroup that a real cluster ships in openshift-operators.
   * Runs every tick but only creates missing objects (a level change/reset
   * re-seeds them; players cannot permanently remove the catalog).
   *
   * Each package advertises its channels AND every channel's CSV `entries`
   * (`status.channels[*].entries`), the way real OLM catalogs do: that list is
   * how a player discovers the valid versions to pin with `startingCSV`
   * (issue #46).
   */
  _ensureOLMDefaults() {
    if (this.cluster.getByKind('PackageManifest').length === 0) {
      for (const entry of OLM_CATALOG) {
        const channels = this._catalogChannels(entry);
        const defaultChannel =
          (channels.find((channel) => channel.name === entry.channel) || channels[0])?.name ||
          'stable';
        this.cluster.addResource({
          kind: 'PackageManifest',
          metadata: {
            name: entry.name,
            labels: {
              catalog: 'redhat-operators',
              'catalog-namespace': 'openshift-marketplace',
              provider: entry.provider,
            },
          },
          spec: {
            packageName: entry.name,
            defaultChannel,
            channels: channels.map((channel) => ({
              name: channel.name,
              currentCSV: channel.currentCSV,
            })),
          },
          status: {
            catalogSource: 'redhat-operators',
            catalogSourceNamespace: 'openshift-marketplace',
            packageName: entry.name,
            defaultChannel,
            provider: { name: entry.provider },
            channels: channels.map((channel) => ({
              name: channel.name,
              currentCSV: channel.currentCSV,
              currentCSVDesc: {
                displayName: entry.displayName,
                version: csvVersion(channel.currentCSV),
                description: entry.description,
                provider: { name: entry.provider },
              },
              entries: channel.entries.map((csvName) => ({
                name: csvName,
                version: csvVersion(csvName),
              })),
            })),
          },
        });
      }
    }
    if (
      this.cluster.getByName('Project', 'openshift-operators', '') &&
      !this.cluster.getByName('OperatorGroup', 'global-operators', 'openshift-operators')
    ) {
      this.cluster.addResource({
        kind: 'OperatorGroup',
        metadata: { name: 'global-operators', namespace: 'openshift-operators' },
        spec: { targetNamespaces: [] },
        status: { namespaces: [] },
      });
    }
  }

  /**
   * Normalise the static OLM catalog entry into its channel list, each channel
   * carrying its ordered pinnable CSV `entries` (head first). Real catalogs
   * always expose `entries`, even for single-version packages.
   *
   * @param {{channel?: string, currentCSV: string, entries?: string[],
   *   channels?: {name: string, currentCSV: string, entries?: string[]}[]}} entry
   * @returns {{name: string, currentCSV: string, entries: string[]}[]}
   */
  _catalogChannels(entry) {
    if (Array.isArray(entry.channels) && entry.channels.length > 0) {
      return entry.channels.map((channel) => {
        const currentCSV = String(channel.currentCSV || '');
        const entries =
          Array.isArray(channel.entries) && channel.entries.length > 0
            ? channel.entries
            : [currentCSV];
        return {
          name: String(channel.name || entry.channel || 'stable'),
          currentCSV,
          entries: entries.filter((csvName) => typeof csvName === 'string' && csvName),
        };
      });
    }
    const currentCSV = entry.currentCSV;
    const entries =
      Array.isArray(entry.entries) && entry.entries.length > 0 ? entry.entries : [currentCSV];
    return [
      {
        name: entry.channel || 'stable',
        currentCSV,
        entries: entries.filter((csvName) => typeof csvName === 'string' && csvName),
      },
    ];
  }

  /**
   * Channels advertised by a PackageManifest resource (status first, then spec,
   * exactly what `oc get packagemanifest -o yaml` exposes). Each channel's
   * `currentCSV` is the channel head; `entries` lists every pinnable CSV.
   *
   * @param {string} packageName
   * @returns {{name: string, currentCSV: string, entries: {name: string, version: string}[]}[]}
   */
  _packageChannels(packageName) {
    const manifest = this.cluster.getByName('PackageManifest', packageName, '');
    const channels = Array.isArray(manifest?.status?.channels)
      ? manifest.status.channels
      : Array.isArray(manifest?.spec?.channels)
        ? manifest.spec.channels
        : [];
    return channels.map((channel) => {
      const currentCSV = String(channel.currentCSV || '');
      const rawEntries =
        Array.isArray(channel.entries) && channel.entries.length > 0
          ? channel.entries
          : currentCSV
            ? [currentCSV]
            : [];
      return {
        name: String(channel.name || ''),
        currentCSV,
        entries: rawEntries
          .map((entry) =>
            typeof entry === 'string'
              ? { name: entry, version: csvVersion(entry) }
              : {
                  name: String(entry?.name || ''),
                  version: entry?.version || csvVersion(entry?.name),
                }
          )
          .filter((entry) => entry.name),
      };
    });
  }

  /**
   * The `spec.replaces` value of a catalog CSV: the NEXT OLDER entry of its
   * channel's ordered `entries` list (OLM's replacement chain). Derived from
   * the PackageManifest the catalog advertises, so every package/version gets
   * the real chain instead of an ad-hoc hardcoded string (issue #56):
   * `['…v1.17.0', '…v1.16.0', '…v1.15.0']` → v1.17.0 replaces v1.16.0,
   * v1.16.0 replaces v1.15.0, v1.15.0 (oldest) replaces nothing.
   * A single-CSV package (one entry) keeps an empty replaces.
   *
   * @param {string} packageName catalog package the Subscription tracks
   * @param {string} csvName CSV whose predecessor we need
   * @param {string} [channelName] tracked channel (defaults to the manifest's)
   * @returns {string} older CSV name, or '' at the start of the chain
   */
  _csvReplaces(packageName, csvName, channelName) {
    const channels = this._safe(() => this._packageChannels(packageName), []) || [];
    if (channels.length === 0 || !csvName) return '';
    const manifest = this.cluster.getByName('PackageManifest', packageName, '');
    const defaultChannel = String(
      manifest?.status?.defaultChannel || manifest?.spec?.defaultChannel || ''
    );
    const requested = String(channelName || '');
    const channel = requested
      ? channels.find((candidate) => candidate.name === requested) || null
      : channels.find((candidate) => candidate.name === defaultChannel) || channels[0] || null;
    if (!channel) return '';
    const index = channel.entries.findIndex((entry) => entry.name === csvName);
    if (index < 0) return '';
    return channel.entries[index + 1]?.name || '';
  }

  /**
   * Resolve which CSV an OLM Subscription installs, validating its channel and
   * `startingCSV` against the catalog (issue #46, real OLM semantics):
   *  - the channel must exist on the package's PackageManifest;
   *  - `startingCSV`, when set, MUST be one of that channel's `entries`;
   *  - otherwise the channel head (`currentCSV`) is installed.
   *
   * @param {object} subscription
   * @returns {{packageName: string, csvName?: string, version?: string,
   *   error?: {kind: 'package'|'channel'|'startingCSV', message: string}}}
   */
  _resolveSubscriptionTarget(subscription) {
    const packageName = this._packageNameForSubscription(subscription);
    const subscriptionName = subscription?.metadata?.name || packageName;
    if (!this.cluster.getByName('PackageManifest', packageName, '')) {
      return {
        packageName,
        error: {
          kind: 'package',
          message: `no operators found in package ${packageName} in the catalog referenced by subscription ${subscriptionName}`,
        },
      };
    }
    const channels = this._packageChannels(packageName);
    const requestedChannel = String(subscription?.spec?.channel || '');
    const manifest = this.cluster.getByName('PackageManifest', packageName, '');
    const defaultChannel = String(
      manifest?.status?.defaultChannel || manifest?.spec?.defaultChannel || ''
    );
    const channel = requestedChannel
      ? channels.find((candidate) => candidate.name === requestedChannel) || null
      : channels.find((candidate) => candidate.name === defaultChannel) || channels[0] || null;
    if (!channel) {
      return {
        packageName,
        error: {
          kind: 'channel',
          message: `no operators found in channel ${requestedChannel} of package ${packageName} in the catalog referenced by subscription ${subscriptionName}`,
        },
      };
    }
    const pinned = String(subscription?.spec?.startingCSV || '');
    if (pinned) {
      const entry = channel.entries.find((candidate) => candidate.name === pinned);
      if (!entry) {
        return {
          packageName,
          error: {
            kind: 'startingCSV',
            message: `no operators found with name ${pinned} in channel ${channel.name} of package ${packageName} in the catalog referenced by subscription ${subscriptionName}`,
          },
        };
      }
      return { packageName, csvName: pinned, version: entry.version, channel: channel.name };
    }
    const csvName = channel.currentCSV || channel.entries[0]?.name || `${packageName}.v1.0.0`;
    return { packageName, csvName, version: csvVersion(csvName), channel: channel.name };
  }

  /** `oc rollout`-independent helper: package name a Subscription tracks. */
  _packageNameForSubscription(subscription) {
    // `spec.name` is the real package field; `packageName` is a legacy
    // simulator alias only honoured when `name` is missing (1.16.0).
    return (
      subscription?.spec?.name ||
      subscription?.spec?.packageName ||
      subscription?.metadata?.name ||
      'operator'
    );
  }

  /** InstallPlan owned by a Subscription (created by this controller). */
  _installPlanForSubscription(subscription, namespace) {
    const child = this.cluster
      .getChildren(subscription.uid)
      .find((entry) => entry.kind === 'InstallPlan');
    if (child) return child;
    return (
      this.cluster
        .getByKindAndNamespace('InstallPlan', namespace)
        .find(
          (plan) =>
            plan.metadata?.labels?.['operators.coreos.com/subscription'] ===
              subscription.metadata.name && this._installPlanOwnedBy(plan, subscription)
        ) || null
    );
  }

  /**
   * Real OLM sets a (non-blocking) owner reference from every InstallPlan to its
   * Subscription. A re-created Subscription with the same name is a different
   * object: it must never adopt the old one's plan (1.16.0, L18: the stale,
   * already-approved Automatic plan made a re-applied Manual pinned
   * Subscription skip approval and install the channel head).
   */
  _adoptInstallPlan(subscription, plan) {
    if (!plan || !subscription?.uid) return;
    this._safe(() => {
      // The relationship makes ClusterState garbage-collect the plan with its
      // Subscription; OLM's owner reference is non-blocking and not a controller.
      this.cluster.addRelationship(subscription.uid, plan.uid);
      const owner = (plan.metadata.ownerReferences || []).find(
        (ref) => ref.uid === subscription.uid
      );
      if (owner) {
        owner.controller = false;
        owner.blockOwnerDeletion = false;
      }
    });
  }

  _installPlanOwnedBy(plan, subscription) {
    const owners = (plan?.metadata?.ownerReferences || []).filter(
      (owner) => owner?.kind === 'Subscription'
    );
    // Plans without owner data (seeded/legacy state) keep the label match.
    if (owners.length === 0) return true;
    return owners.some((owner) => owner.uid === subscription.uid);
  }

  /** Kubernetes garbage collection: a plan whose owning Subscriptions are all gone is deleted. */
  _collectOrphanedInstallPlans() {
    const plans = this.cluster.getByKind('InstallPlan');
    if (plans.length === 0) return;
    const live = new Set(this.cluster.getByKind('Subscription').map((entry) => entry.uid));
    for (const plan of plans) {
      const owners = (plan.metadata?.ownerReferences || []).filter(
        (owner) => owner?.kind === 'Subscription'
      );
      if (owners.length === 0 || owners.some((owner) => live.has(owner.uid))) continue;
      this.cluster.remove(plan.uid);
    }
  }

  /** CSV installed by a Subscription (status.installedCSV / currentCSV). */
  _csvForSubscription(subscription, namespace) {
    const csvName = subscription.status?.installedCSV || subscription.status?.currentCSV || '';
    if (csvName) {
      const named = this.cluster.getByName('ClusterServiceVersion', csvName, namespace);
      if (named) return named;
    }
    return (
      this.cluster
        .getByKindAndNamespace('ClusterServiceVersion', namespace)
        .find(
          (csv) =>
            csv.metadata?.labels?.['operators.coreos.com/subscription'] ===
            subscription.metadata.name
        ) || null
    );
  }

  /**
   * The next CSV a Subscription should move to after its currently installed
   * CSV, i.e. the tracked channel's head when it differs from `installedCSV`
   * (issue #53D). Real OLM always resolves the channel head; for a Manual
   * subscription the resulting upgrade InstallPlan simply waits for approval.
   * @returns {{headCsv: string, version: string, channel: string}|null}
   */
  _subscriptionUpgradeTarget(subscription, packageName) {
    const installed = String(subscription.status?.installedCSV || '');
    if (!installed) return null;
    const channels = this._safe(() => this._packageChannels(packageName), []) || [];
    if (channels.length === 0) return null;
    const manifest = this.cluster.getByName('PackageManifest', packageName, '');
    const defaultChannel = String(
      manifest?.status?.defaultChannel || manifest?.spec?.defaultChannel || ''
    );
    const requested = String(subscription.spec?.channel || '');
    const channel = requested
      ? channels.find((candidate) => candidate.name === requested) || null
      : channels.find((candidate) => candidate.name === defaultChannel) || channels[0] || null;
    if (!channel?.currentCSV) return null;
    if (channel.currentCSV === installed) return null;
    return {
      headCsv: channel.currentCSV,
      version: csvVersion(channel.currentCSV),
      channel: channel.name,
    };
  }

  /**
   * Reconcile a Subscription's channel upgrade one step (issue #53D):
   *
   *  1. resolve the channel head and create the SECOND InstallPlan
   *     (`clusterServiceVersionNames: [head]`, `approval` copied from the
   *     Subscription, `approved: false` for Manual);
   *  2. while it is unapproved report the real OLM status — currentCSV=head,
   *     installedCSV=stays the pinned CSV, `phase/state UpgradePending`,
   *     `InstallPlanPending True RequiresApproval`;
   *  3. after approval, complete the plan, install the head CSV to Succeeded,
   *     switch the operator Deployment owner to it, remove the old CSV (the
   *     real OLM replacement), and report Succeeded / InstallPlanComplete.
   *
   * Automatic-approval subscriptions approve their upgrade plan automatically
   * (real OLM), so this is not Manual-only.
   */
  _tickSubscriptionUpgrade(subscription, namespace, packageName, target) {
    const headCsv = target.headCsv;
    const baseStatus = () => {
      subscription.status.currentCSV = headCsv;
      subscription.status.phase = 'UpgradePending';
      subscription.status.state = 'UpgradePending';
    };

    let plan =
      this._safe(() =>
        this.cluster
          .getByKindAndNamespace('InstallPlan', namespace)
          .find(
            (candidate) =>
              candidate.metadata?.labels?.['operators.coreos.com/subscription'] ===
                subscription.metadata.name &&
              this._installPlanOwnedBy(candidate, subscription) &&
              (candidate.spec?.clusterServiceVersionNames || []).includes(headCsv)
          )
      ) || null;

    if (!plan) {
      const suffix = this._randomSuffix();
      plan = this.cluster.addResource({
        kind: 'InstallPlan',
        metadata: {
          name: `install-${suffix}`,
          namespace,
          labels: {
            'operators.coreos.com/subscription': subscription.metadata.name,
            'operators.coreos.com/package': packageName,
          },
        },
        spec: {
          approval: subscription.spec?.installPlanApproval || 'Automatic',
          approved: false,
          clusterServiceVersionNames: [headCsv],
          source: subscription.spec?.source || '',
          sourceNamespace: subscription.spec?.sourceNamespace || '',
        },
        status: { phase: 'RequiresApproval' },
      });
      if (!plan) return;
      this._adoptInstallPlan(subscription, plan);
      plan.setPlan(headCsv, target.version);
      this.cluster.update(plan.uid, plan);
      this.eventBus?.emit('installplan:created', {
        name: plan.metadata.name,
        namespace,
        subscription: subscription.metadata.name,
        csv: headCsv,
      });
    }

    // Automatic approvals approve their own upgrade plan (real OLM).
    if (plan.spec.approval !== 'Manual' && plan.spec.approved !== true) {
      plan.spec.approved = true;
      this.cluster.update(plan.uid, plan);
    }
    if (plan.spec.approved !== true) {
      baseStatus();
      // The previous (pinned) plan already completed; the upgrade is pending.
      subscription.status.installPlanComplete = false;
      subscription.status.reason = 'RequiresApproval';
      subscription.status.message = `install plan ${plan.metadata.name} requires approval`;
      subscription.setCondition(
        'InstallPlanPending',
        'True',
        'RequiresApproval',
        `install plan ${plan.metadata.name} requires approval`
      );
      subscription.setCondition('InstallPlanComplete', 'False', 'InstallPlanPending', '');
      this.cluster.update(subscription.uid, subscription);
      return;
    }

    if (typeof plan._approvedAtGameSeconds !== 'number') {
      plan._approvedAtGameSeconds = this.gameSeconds;
    }
    if (plan.status.phase !== 'Complete') {
      if (this.gameSeconds - plan._approvedAtGameSeconds >= INSTALLPLAN_COMPLETE_SECONDS) {
        plan.markComplete();
        this.cluster.update(plan.uid, plan);
        subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
        this.cluster.update(subscription.uid, subscription);
        this.eventBus?.emit('installplan:complete', {
          name: plan.metadata.name,
          namespace,
          subscription: subscription.metadata.name,
        });
      } else {
        baseStatus();
        subscription.status.reason = 'Installing';
        subscription.status.message = `waiting for InstallPlan ${plan.metadata.name} to complete`;
        this.cluster.update(subscription.uid, subscription);
        return;
      }
    }

    // Install the head ClusterServiceVersion (the upgraded CSV replaces the old
    // one; the spec/annotations mirror the initial-install path).
    let csv = this.cluster.getByName('ClusterServiceVersion', headCsv, namespace);
    if (!csv) {
      const operatorGroup =
        this.cluster.getByKindAndNamespace('OperatorGroup', namespace)[0] || null;
      const globalNamespace = namespace === 'openshift-operators';
      csv = this.cluster.addResource({
        kind: 'ClusterServiceVersion',
        metadata: {
          name: headCsv,
          namespace,
          labels: {
            'operators.coreos.com/subscription': subscription.metadata.name,
            'olm.package': packageName,
          },
          annotations: {
            'olm.operatorNamespace': namespace,
            'olm.operatorGroup': operatorGroup
              ? `${operatorGroup.metadata.namespace}/${operatorGroup.metadata.name}`
              : '',
            'olm.targetNamespaces':
              operatorGroup &&
              Array.isArray(operatorGroup.spec.targetNamespaces) &&
              operatorGroup.spec.targetNamespaces.length > 0
                ? operatorGroup.spec.targetNamespaces.join(',')
                : globalNamespace
                  ? ''
                  : namespace,
          },
        },
        spec: {
          displayName: this._catalogDisplayName(packageName),
          version: target.version,
          // The head CSV's place in the channel's replacement chain (issue #56):
          // OLM exposes it as `spec.replaces` / the `oc get csv` REPLACES column.
          replaces: this._csvReplaces(packageName, headCsv, target.channel),
          customresourcedefinitions: { owned: deepClone(this._catalogCrds(packageName)) },
        },
        status: { phase: 'Installing' },
      });
      if (csv) {
        csv._installStartedAt = this.gameSeconds;
        csv.markInstalling(`installing ${headCsv}`);
        this.cluster.update(csv.uid, csv);
        this._knownCSVs.set(csv.uid, { name: headCsv, namespace, packageName });
        this.eventBus?.emit('operator:csv-created', {
          name: headCsv,
          namespace,
          packageName,
          subscription: subscription.metadata.name,
        });
      }
    }
    if (!csv) return;
    if (csv.status.phase !== 'Succeeded') {
      if (typeof csv._installStartedAt !== 'number') csv._installStartedAt = this.gameSeconds;
      if (this.gameSeconds - csv._installStartedAt < CSV_INSTALL_SECONDS) {
        baseStatus();
        subscription.status.reason = 'Installing';
        subscription.status.message = `waiting for ClusterServiceVersion ${headCsv} to succeed`;
        this.cluster.update(subscription.uid, subscription);
        return;
      }
      csv.markSucceeded();
      this.cluster.update(csv.uid, csv);
      this._knownCSVs.set(csv.uid, { name: headCsv, namespace, packageName });
      this.eventBus?.emit('operator:csv-succeeded', {
        name: headCsv,
        namespace,
        packageName,
      });
    }
    // The operator Deployment is re-owned by the new CSV BEFORE the old CSV is
    // removed, so its uninstall handler does not tear the operator down.
    this._ensureOperatorDeploymentForCSV(csv, packageName);

    const previousCsvName = String(subscription.status.installedCSV || '');
    if (previousCsvName && previousCsvName !== headCsv) {
      const previousCsv = this.cluster.getByName(
        'ClusterServiceVersion',
        previousCsvName,
        namespace
      );
      // Real OLM replaces the old CSV on a successful upgrade (it is no longer
      // the installed CSV and is garbage-collected).
      if (previousCsv) this.cluster.remove(previousCsv.uid);
    }

    subscription.status.installedCSV = headCsv;
    subscription.status.currentCSV = headCsv;
    subscription.status.phase = 'Succeeded';
    subscription.status.state = 'AtLatestKnown';
    subscription.status.reason = 'InstallSucceeded';
    subscription.status.message = `operator ${packageName} installed successfully`;
    subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
    subscription.status.installPlanComplete = true;
    subscription.setCondition('InstallPlanPending', 'False', 'InstallPlanComplete');
    subscription.setCondition('InstallPlanComplete', 'True', 'InstallSucceeded');
    this.cluster.update(subscription.uid, subscription);
    if (!subscription._installedEmitted) {
      subscription._installedEmitted = true;
      this.eventBus?.emit('operator:installed', {
        name: subscription.metadata.name,
        namespace,
        packageName,
        csv: headCsv,
        channel: subscription.spec?.channel,
        source: subscription.spec?.source,
        resource: subscription,
      });
    }
  }

  /**
   * Pod template a CSV install strategy applies to an EXISTING operator
   * Deployment. The strategy's template is used as-is, with the Deployment's
   * (immutable) selector labels folded into the template labels so the template
   * keeps matching `.spec.selector`, exactly like the kube API requires.
   * Returns null when the CSV carries no deployment strategy for it.
   *
   * @param {object} csv ClusterServiceVersion whose install strategy to apply
   * @param {object} deployment existing operator Deployment
   * @returns {object|null} desired pod template
   */
  _operatorDeploymentPodTemplate(csv, deployment) {
    const strategyDeployments = csv.spec?.install?.spec?.deployments;
    if (!Array.isArray(strategyDeployments) || strategyDeployments.length === 0) return null;
    const strategyDeployment =
      strategyDeployments.find((entry) => entry?.name === deployment.metadata.name) ||
      strategyDeployments[0];
    const template = strategyDeployment?.spec?.template;
    if (!template || typeof template !== 'object') return null;
    const desired = deepClone(template);
    desired.metadata = desired.metadata || {};
    // Selector labels win: a Kubernetes Deployment requires its pod template to
    // carry every selector label, and the selector is immutable — so the
    // template (not the selector) is adapted when they disagree.
    desired.metadata.labels = {
      ...(desired.metadata.labels || {}),
      ...(deployment.spec?.selector?.matchLabels || {}),
    };
    return desired;
  }

  /**
   * Create the operator Deployment described by a CSV install strategy, the way
   * OLM does after the CSV reaches Succeeded. The Deployment is labelled with
   * olm.owner so deleting the CSV can remove it (real uninstall).
   */
  _ensureOperatorDeploymentForCSV(csv, packageName) {
    if (!csv) return null;
    const namespace = csv.metadata.namespace;
    const strategyDeployment = csv.spec?.install?.spec?.deployments?.[0];
    const deploymentName =
      strategyDeployment?.name ||
      `${String(csv.metadata.name).replace(/\.v\d.*$/, '')}-controller-manager`;
    const existing = this.cluster.getByName('Deployment', deploymentName, namespace);
    if (existing) {
      // A channel UPGRADE reuses the same operator Deployment name; OLM updates
      // its owning-CSV label so deleting the superseded CSV does not uninstall
      // the freshly upgraded operator (issue #53D) AND applies the new CSV's
      // pod template — that is what makes the Deployment controller roll a NEW
      // ReplicaSet for the upgraded operator (issue #56). `.spec.selector` is
      // immutable in real Kubernetes and is never touched.
      let changed = false;
      const ownerName = csv.metadata.name;
      existing.metadata.labels = existing.metadata.labels || {};
      if (existing.metadata.labels['olm.owner'] !== ownerName) {
        existing.metadata.labels['olm.owner'] = ownerName;
        existing.metadata.labels['olm.owner.namespace'] = namespace;
        changed = true;
      }
      const desiredTemplate = this._operatorDeploymentPodTemplate(csv, existing);
      if (
        desiredTemplate &&
        this._stableStringify(existing.spec?.template || {}) !==
          this._stableStringify(desiredTemplate)
      ) {
        existing.spec.template = desiredTemplate;
        existing.metadata.generation = (Number(existing.metadata.generation) || 1) + 1;
        changed = true;
      }
      if (changed) this.cluster.update(existing.uid, existing);
      this._olmOperatorDeployments.set(csv.uid, existing.uid);
      return existing;
    }
    const spec = deepClone(
      strategyDeployment?.spec || {
        replicas: 1,
        selector: { matchLabels: { name: `${packageName}-operator` } },
        template: {
          metadata: { labels: { name: `${packageName}-operator` } },
          spec: {
            serviceAccountName: 'default',
            containers: [
              {
                name: 'manager',
                image: `${packageName.replace(/-operator$/, '')}-operator:latest`,
                resources: {
                  requests: { cpu: '10m', memory: '64Mi' },
                  limits: { cpu: '200m', memory: '256Mi' },
                },
              },
            ],
          },
        },
      }
    );
    if (!spec.selector) spec.selector = { matchLabels: { name: `${packageName}-operator` } };
    const deployment = this.cluster.addResource({
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace,
        labels: {
          'olm.owner': csv.metadata.name,
          'olm.owner.namespace': namespace,
          'olm.package': packageName,
          'app.kubernetes.io/managed-by': 'olm',
        },
        annotations: {
          'olm.operatorGroup': csv.metadata.annotations?.['olm.operatorGroup'] || '',
        },
      },
      spec,
    });
    if (deployment) this._olmOperatorDeployments.set(csv.uid, deployment.uid);
    return deployment;
  }

  /** `cluster:deleted:ClusterServiceVersion` → real uninstall of its operator. */
  _onCSVDeleted(csv) {
    if (!csv) return;
    const namespace = csv.metadata?.namespace || '';
    const csvName = csv.metadata?.name || '';
    // A copied CSV (AllNamespaces shim) has no operator of its own: the source
    // CSV reconciliation recreates it, so it must not trigger uninstall effects.
    if (this._isCopiedCSV(csv)) {
      this._knownCSVs.delete(csv.uid);
      return;
    }
    // Deleting the source CSV uninstalls the operator everywhere: drop its
    // copied CSVs from the other namespaces as well (real OLM GCs copies).
    for (const candidate of this.cluster.getByKind('ClusterServiceVersion')) {
      if (
        this._isCopiedCSV(candidate) &&
        candidate.metadata?.labels?.['olm.copiedFrom'] === namespace &&
        candidate.metadata?.name === csvName
      ) {
        this._knownCSVs.delete(candidate.uid);
        this.cluster.remove(candidate.uid);
      }
    }
    const removed = [];
    for (const deployment of this.cluster.getByKindAndNamespace('Deployment', namespace)) {
      const owner = deployment.metadata?.labels?.['olm.owner'];
      if (owner === csvName || (owner && owner === csv.metadata?.name)) {
        this.cluster.remove(deployment.uid);
        removed.push(deployment.metadata.name);
      }
    }
    this._olmOperatorDeployments.delete(csv.uid);
    this._knownCSVs.delete(csv.uid);
    this.eventBus?.emit('operator:csv-deleted', {
      name: csvName,
      namespace,
      packageName: csv.metadata?.labels?.['olm.package'] || '',
      removedDeployments: removed,
    });
  }

  /**
   * MetalLB operator effects: once the operator CSV is Succeeded AND a MetalLB
   * custom resource exists (the operand CR the docs require after installing
   * the operator), the operator deploys the controller Deployment and the
   * speaker DaemonSet in the CR's namespace. Deleting the CR (or the CSV)
   * tears the operands down again.
   */
  _tickMetalLBOperands(dt) {
    const csvReady = this.cluster
      .getByKind('ClusterServiceVersion')
      .some(
        (csv) =>
          csv.status.phase === 'Succeeded' &&
          (/metallb/i.test(csv.metadata?.name || '') ||
            /^metallb/.test(String(csv.metadata?.labels?.['olm.package'] || '')))
      );
    const crs = this.cluster.getByKind('MetalLB');
    const desired = new Map();
    if (csvReady) {
      for (const cr of crs) {
        const namespace = cr.metadata.namespace;
        desired.set(`Deployment/${namespace}/controller`, {
          kind: 'Deployment',
          name: 'controller',
          namespace,
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: 'metallb', component: 'controller' } },
            template: {
              metadata: { labels: { app: 'metallb', component: 'controller' } },
              spec: {
                serviceAccountName: 'default',
                containers: [
                  {
                    name: 'controller',
                    image: 'quay.io/metallb/controller:v0.14.9',
                    args: ['--port=7472', '--log-level=info'],
                    ports: [{ name: 'monitoring', containerPort: 7472 }],
                    resources: {
                      requests: { cpu: '10m', memory: '32Mi' },
                      limits: { cpu: '100m', memory: '128Mi' },
                    },
                  },
                ],
              },
            },
          },
        });
        desired.set(`DaemonSet/${namespace}/speaker`, {
          kind: 'DaemonSet',
          name: 'speaker',
          namespace,
          spec: {
            selector: { matchLabels: { app: 'metallb', component: 'speaker' } },
            template: {
              metadata: { labels: { app: 'metallb', component: 'speaker' } },
              spec: {
                serviceAccountName: 'default',
                containers: [
                  {
                    name: 'speaker',
                    image: 'quay.io/metallb/speaker:v0.14.9',
                    args: ['--port=7472', '--log-level=info'],
                    ports: [{ name: 'monitoring', containerPort: 7472 }],
                    resources: {
                      requests: { cpu: '10m', memory: '32Mi' },
                      limits: { cpu: '100m', memory: '128Mi' },
                    },
                  },
                ],
              },
            },
          },
        });
      }
    }

    // Create/reconcile the operands that should exist.
    for (const wanted of desired.values()) {
      const existing = this.cluster.getByName(wanted.kind, wanted.name, wanted.namespace);
      if (existing) {
        this._metallbOperands.set(existing.uid, {
          kind: wanted.kind,
          name: wanted.name,
          namespace: wanted.namespace,
        });
        continue;
      }
      const created = this.cluster.addResource({
        kind: wanted.kind,
        metadata: {
          name: wanted.name,
          namespace: wanted.namespace,
          labels: {
            app: 'metallb',
            component: wanted.kind === 'Deployment' ? 'controller' : 'speaker',
            'app.kubernetes.io/managed-by': 'metallb-operator',
          },
        },
        spec: deepClone(wanted.spec),
      });
      if (created)
        this._metallbOperands.set(created.uid, {
          kind: wanted.kind,
          name: wanted.name,
          namespace: wanted.namespace,
        });
    }

    // Remove operands that are no longer desired (CR or operator removed).
    for (const [uid, entry] of this._metallbOperands) {
      const resource = this.cluster.get(uid);
      if (!resource) {
        this._metallbOperands.delete(uid);
        continue;
      }
      const key = `${entry.kind}/${entry.namespace}/${entry.name}`;
      if (desired.has(key)) continue;
      this.cluster.remove(uid);
      this._metallbOperands.delete(uid);
    }
  }

  _tickMetalLB(dt) {
    // MetalLB only programs LoadBalancer Services when the operator is
    // installed AND the MetalLB operand CR exists (real MetalLB flow).
    const metallbCRs = this.cluster.getByKind('MetalLB');
    const csvReady = this.cluster
      .getByKind('ClusterServiceVersion')
      .some((csv) => csv.status.phase === 'Succeeded' && /metallb/i.test(csv.metadata?.name || ''));
    const metallbInstalled = metallbCRs.length > 0 && csvReady;
    const pools = this.cluster
      .getByKind('IPAddressPool')
      .filter((pool) => (pool.spec?.addresses || []).length > 0);
    const advertisements = this.cluster.getByKind('L2Advertisement');
    const advertisedPools = new Set();
    for (const advertisement of advertisements) {
      const names = advertisement.spec?.ipAddressPools || [];
      if (names.length === 0) {
        // An L2Advertisement without an explicit pool list advertises all pools.
        for (const pool of pools) advertisedPools.add(pool.metadata.name);
      } else {
        for (const name of names) advertisedPools.add(name);
      }
    }
    const usablePools = pools.filter((pool) => advertisedPools.has(pool.metadata.name));

    const services = this.cluster
      .getByKind('Service')
      .filter((service) => service.spec.type === 'LoadBalancer');
    if (services.length === 0) return;

    const usedIps = new Set();
    for (const service of this.cluster.getByKind('Service')) {
      for (const ingress of service.status?.loadBalancer?.ingress || []) {
        if (ingress.ip) usedIps.add(ingress.ip);
      }
    }

    for (const service of services) {
      const current = service.status?.loadBalancer?.ingress || [];
      if (!metallbInstalled || usablePools.length === 0) {
        if (current.length > 0) {
          service.status.loadBalancer = { ingress: [] };
          this._persistService(service);
        }
        service.status.loadBalancer = service.status.loadBalancer || { ingress: [] };
        continue;
      }
      if (current.length > 0) continue;

      const address = this._allocateMetalLBAddress(usablePools, usedIps, service);
      if (!address) continue;
      usedIps.add(address);
      service.status.loadBalancer = {
        ingress: [
          {
            ip: address,
            ipMode: 'VIP',
            hostname: '',
          },
        ],
      };
      this._persistService(service);
      // Canonical MetalLB controller event on the Service (issue #76): the
      // speaker/controller reports `Assigned IP ["<ip>"]`, never the
      // cloud-provider `Assigned external IP …` event. This is the SINGLE
      // emission path for a LoadBalancer IP — resources/incidents must not add
      // a second event.
      service.recordEvent('Normal', 'IPAllocated', `Assigned IP ["${address}"]`);
      this.eventBus?.emit('service:external-ip', {
        service: service.metadata.name,
        namespace: service.metadata.namespace,
        ip: address,
        resource: service,
      });
    }
  }

  /**
   * Persist a Service status mutation without the generic ResourceBase status
   * skeleton (`conditions: []`) that `ClusterState.update(instance)` normalises
   * onto every rich resource: a real Service status subresource only carries
   * `loadBalancer` (issues #59/#60).
   * @param {object} service
   */
  _persistService(service) {
    const status = deepClone(service.status);
    this.cluster.update(service.uid, service);
    service.status = status;
  }

  /** Pick the first free IP from the advertised MetalLB pools. */
  _allocateMetalLBAddress(pools, usedIps, service = null) {
    const requestedPool =
      service?.metadata?.annotations?.['metallb.universe.tf/address-pool'] ||
      service?.metadata?.annotations?.['metallb.io/address-pool'] ||
      '';
    for (const pool of pools) {
      // autoAssign: false pools are only used by services that explicitly
      // request them via the address-pool annotation (MetalLB semantics).
      if (pool.spec?.autoAssign === false && requestedPool !== pool.metadata.name) continue;
      if (requestedPool && requestedPool !== pool.metadata.name) continue;
      for (const rawAddress of pool.spec.addresses || []) {
        for (const candidate of this._expandAddressRange(rawAddress)) {
          if (!usedIps.has(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  /**
   * Expand a MetalLB address entry ("192.168.1.200-192.168.1.210" or
   * "192.168.1.0/24") into a bounded list of candidate IPs.
   * @param {string} entry
   * @returns {string[]}
   */
  _expandAddressRange(entry) {
    const value = String(entry || '').trim();
    if (!value) return [];
    if (value.includes('-')) {
      const [start, end] = value.split('-').map((part) => part.trim());
      const startParts = start.split('.').map(Number);
      const endParts = end.split('.').map(Number);
      if (startParts.length !== 4 || endParts.length !== 4) return [start];
      let current = this._ipToInt(startParts);
      const last = this._ipToInt(endParts);
      const results = [];
      while (current <= last && results.length < 256) {
        results.push(this._intToIp(current));
        current++;
      }
      return results;
    }
    if (value.includes('/')) {
      const [base, prefixRaw] = value.split('/');
      const prefix = parseInt(prefixRaw, 10);
      const parts = base.split('.').map(Number);
      if (parts.length !== 4 || !Number.isFinite(prefix)) return [base];
      const hostBits = 32 - prefix;
      if (hostBits <= 0) return [base]; // /32 single-address pool
      const network = this._ipToInt(parts) & ((0xffffffff << hostBits) >>> 0);
      const results = [];
      const maxAddresses = Math.min(2 ** hostBits, 1024);
      for (let offset = 1; offset < maxAddresses; offset++)
        results.push(this._intToIp((network + offset) >>> 0));
      return results;
    }
    return [value];
  }

  _ipToInt(parts) {
    return (
      (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3]) >>>
      0
    );
  }

  _intToIp(value) {
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
  }

  // ── OpenShift: builds & image streams ──────────────────────────────────

  /** BuildConfig controller: kick off the initial ConfigChange build. */
  _tickBuildConfigs(dt) {
    for (const buildConfig of this.cluster.getByKind('BuildConfig')) {
      if (!buildConfig._initialTriggerChecked) {
        buildConfig._initialTriggerChecked = true;
        const hasConfigChange = (buildConfig.spec.triggers || []).some(
          (trigger) => trigger.type === 'ConfigChange'
        );
        const hasBuilds = this.cluster.getBuildsForConfig(buildConfig).length > 0;
        if (hasConfigChange && !hasBuilds) {
          buildConfig._autoBuildElapsed = 0;
        }
      }
      const triggers = buildConfig.spec.triggers || [];
      const hasConfigChange = triggers.some((trigger) => trigger.type === 'ConfigChange');
      const generation = Number(buildConfig.metadata.generation) || 1;
      if (buildConfig._lastConfigChangeGeneration === undefined)
        buildConfig._lastConfigChangeGeneration = generation;
      if (buildConfig._autoBuildElapsed !== undefined && buildConfig._autoBuildElapsed !== null) {
        buildConfig._autoBuildElapsed += dt;
        if (buildConfig._autoBuildElapsed >= 1) {
          buildConfig._autoBuildElapsed = null;
          if (!this.cluster.getActiveBuildFor(buildConfig)) {
            const result = this.cluster.startBuildFor(buildConfig, { reason: 'ConfigChange' });
            if (result.success) buildConfig._lastConfigChangeGeneration = generation;
          }
        }
      } else if (hasConfigChange && generation !== buildConfig._lastConfigChangeGeneration) {
        // ConfigChange trigger: a BuildConfig spec change starts a new build
        // once the previous (Serial) build has finished (SIM-026).
        if (!this.cluster.getActiveBuildFor(buildConfig)) {
          const result = this.cluster.startBuildFor(buildConfig, { reason: 'ConfigChange' });
          if (result.success) buildConfig._lastConfigChangeGeneration = generation;
        }
      }
      // ImageChange trigger: a new build starts when the referenced builder
      // ImageStreamTag becomes available or changes (SIM-026).
      this._maybeStartImageChangeBuild(buildConfig);
    }
  }

  /** Start a build when a BuildConfig ImageChange trigger's tag changed. */
  _maybeStartImageChangeBuild(buildConfig) {
    const triggers = (buildConfig.spec.triggers || []).filter(
      (trigger) => trigger.type === 'ImageChange' && trigger.paused !== true
    );
    if (triggers.length === 0) return;
    buildConfig.status = buildConfig.status || {};
    buildConfig.status.imageChangeTriggers = buildConfig.status.imageChangeTriggers || [];
    let statusChanged = false;
    for (const trigger of triggers) {
      const params = trigger.imageChange || trigger.imageChangeParams || {};
      const from = params.from || trigger.from || {};
      if (from.kind && from.kind !== 'ImageStreamTag') continue;
      const fromName = String(from.name || '');
      if (!fromName.includes(':')) continue;
      const [streamName, tag] = fromName.split(':');
      const streamNamespace = from.namespace || buildConfig.metadata.namespace;
      const resolved = this.cluster.resolveImageStreamTag(streamNamespace, streamName, tag);
      const tagItem = resolved.tagEntry?.items?.[0];
      const available = Boolean(resolved.found && tagItem);
      if (!available) continue;
      const reference = `${tagItem.image || ''}|${resolved.dockerImageReference || ''}|${resolved.tagEntry?.updated || ''}`;
      let record = buildConfig.status.imageChangeTriggers.find(
        (entry) =>
          (entry.from?.name || entry.fromName) === fromName &&
          (entry.from?.namespace || streamNamespace) === streamNamespace
      );
      const previous = record?.lastTriggeredImageID;
      if (previous === reference) continue;
      if (this.cluster.getActiveBuildFor(buildConfig)) continue; // retry after the serial build finishes
      const result = this.cluster.startBuildFor(buildConfig, { reason: 'ImageChange' });
      if (!result.success) continue;
      // startBuildFor() replaces buildConfig.status when it updates the
      // BuildConfig, so re-resolve the record from the fresh status array.
      buildConfig.status.imageChangeTriggers = buildConfig.status.imageChangeTriggers || [];
      let freshRecord = buildConfig.status.imageChangeTriggers.find(
        (entry) =>
          (entry.from?.name || entry.fromName) === fromName &&
          (entry.from?.namespace || streamNamespace) === streamNamespace
      );
      if (!freshRecord) {
        freshRecord = {
          from: { kind: 'ImageStreamTag', name: fromName, namespace: streamNamespace },
        };
        buildConfig.status.imageChangeTriggers.push(freshRecord);
      }
      freshRecord.lastTriggeredImageID = reference;
      statusChanged = true;
    }
    if (statusChanged) this.cluster.update(buildConfig.uid, buildConfig);
  }

  /** Build controller: New → Pending → Running → Complete/Failed. */
  _tickBuilds(dt) {
    for (const build of this.cluster.getByKind('Build')) {
      if (!['New', 'Pending', 'Running'].includes(build.status.phase)) continue;

      if (build._phaseElapsed === undefined) {
        build._phaseElapsed = 0;
        build._phase = build.status.phase || 'New';
        build._willFail = this._shouldBuildFail(build);
        build._failMessage = build._willFail ? this._buildFailureMessage(build) : '';
        // Seeded/legacy objects used the non-API `startTime` field; keep the
        // real `startTimestamp` populated for builds that already started.
        if (build.status.phase !== 'New') {
          if (!build.status.startTimestamp && build.status.startTime) {
            build.status.startTimestamp = build.status.startTime;
          }
          delete build.status.startTime;
        }
      }
      build._phaseElapsed += dt;
      const buildConfig = this._findBuildConfigForBuild(build);
      const serial =
        (buildConfig?.spec?.runPolicy || build.spec?.runPolicy || 'Serial') === 'Serial';

      if (build.status.phase === 'New') {
        // A queued build keeps its (empty) startTimestamp: the API only sets it
        // when the build actually starts.
        delete build.status.startTimestamp;
        delete build.status.startTime;
        if (serial && buildConfig) {
          const active = this._activeBuildsOfConfig(buildConfig, build).filter((entry) =>
            ['Pending', 'Running'].includes(entry.status.phase)
          );
          const olderQueued = this.cluster
            .getBuildsForConfig(buildConfig)
            .filter(
              (entry) =>
                entry.uid !== build.uid &&
                entry.status.phase === 'New' &&
                this._buildIsOlder(entry, build)
            );
          // Issue #42: a Serial BuildConfig runs builds one at a time — stay
          // queued behind the active build and behind older queued builds.
          if (active.length > 0 || olderQueued.length > 0) continue;
        }
        if (build._phaseElapsed >= BUILD_PHASE_NEW_SECONDS) {
          build.status.phase = 'Pending';
          build.status.reason = 'BuildPending';
          build.status.startTimestamp = new Date().toISOString();
          // The clone has resolved: stamp spec.revision so `oc get builds` FROM
          // becomes `Git@<commit>` instead of the BuildConfig's ref fallback.
          this._recordResolvedGitRevision(build);
          build._phaseElapsed = 0;
          build.recordEvent('Normal', 'BuildStarted', `Build ${build.metadata.name} started`);
          this.cluster.update(build.uid, build);
        }
        continue;
      }
      if (build.status.phase === 'Pending') {
        // Only one build of a Serial BuildConfig may be Running at a time.
        if (serial && buildConfig) {
          const anotherRunning = this._activeBuildsOfConfig(buildConfig, build).some(
            (entry) => entry.status.phase === 'Running'
          );
          if (anotherRunning) continue; // stay Pending behind the running build
        }
        if (build._phaseElapsed >= BUILD_PHASE_PENDING_SECONDS) {
          build.status.phase = 'Running';
          build.status.reason = 'BuildRunning';
          build._phaseElapsed = 0;
          this.cluster.update(build.uid, build);
        }
        continue;
      }

      // Running
      if (build._willFail) {
        if (build._phaseElapsed >= 1) this._completeBuildWithFailure(build, buildConfig);
        continue;
      }
      if (build._phaseElapsed >= this._buildRunningDuration(build)) {
        this._completeBuildSuccess(build, buildConfig);
      }
    }
  }

  /**
   * Record the commit a Git clone resolved, the way the build pod fills
   * `spec.revision.git.commit` before `oc get builds` shortens it to 7 hex
   * chars. Deterministic per URI+ref so the same source always prints the
   * same `Git@<commit>`. No-op for binary/Dockerfile-only builds and for a
   * revision the manifest already set.
   * @param {object} build
   */
  _recordResolvedGitRevision(build) {
    const git = build?.spec?.source?.git;
    if (!git?.uri || build.spec?.revision?.git?.commit) return;
    const commit = this.cluster?._fakeDigest?.(`git:${git.uri}@${git.ref || ''}`);
    if (!commit) return;
    build.spec.revision = { type: 'Git', git: { commit } };
  }

  /** In-flight (New/Pending/Running) builds of a BuildConfig, excluding one. */
  _activeBuildsOfConfig(buildConfig, exclude) {
    return (this.cluster.getChildren(buildConfig.uid) || []).filter(
      (child) =>
        child.kind === 'Build' &&
        child.uid !== exclude?.uid &&
        ['New', 'Pending', 'Running'].includes(child.status?.phase)
    );
  }

  /** Is Build `a` older (queued earlier) than Build `b` for Serial ordering? */
  _buildIsOlder(a, b) {
    const aTime = new Date(a.metadata?.creationTimestamp || 0).getTime();
    const bTime = new Date(b.metadata?.creationTimestamp || 0).getTime();
    if (aTime !== bTime) return aTime < bTime;
    const aVersion = Number(a.metadata?.annotations?.['openshift.io/build.number']);
    const bVersion = Number(b.metadata?.annotations?.['openshift.io/build.number']);
    if (Number.isFinite(aVersion) && Number.isFinite(bVersion) && aVersion !== bVersion) {
      return aVersion < bVersion;
    }
    return String(a.metadata?.name || '') < String(b.metadata?.name || '');
  }

  /** Deterministic 6–10s running duration based on the build name. */
  _buildRunningDuration(build) {
    const variance = this._hashString(`${build.metadata.name}:running`) % 41; // 0..40 tenths
    return BUILD_PHASE_RUNNING_SECONDS + variance / 10;
  }

  _findBuildConfigForBuild(build) {
    const owner = build.metadata.ownerReferences.find(
      (reference) => reference.kind === 'BuildConfig'
    );
    if (owner)
      return (
        this.cluster.get(owner.uid) || this.cluster.getBuildConfig(build.namespace, owner.name)
      );
    return this.cluster.getBuildConfig(
      build.namespace,
      build.metadata.labels?.buildconfig || build.metadata.labels?.['buildconfig.openshift.io/name']
    );
  }

  /**
   * Decide whether a build fails. Deterministic per build name (different build
   * versions get different outcomes) plus explicit `spec.forFailure` overrides.
   */
  _shouldBuildFail(build) {
    const buildConfig = this._findBuildConfigForBuild(build);
    if (build.spec?.forFailure === true || buildConfig?.spec?.forFailure === true) return true;
    // The first build of a BuildConfig always succeeds (deterministic levels /
    // verifier flows); later versions can fail randomly like a real cluster.
    const version = parseInt(String(build.metadata.name).split('-').pop(), 10);
    if (Number.isFinite(version) && version <= 1) return false;
    if (buildConfig?.spec?.failureRate !== undefined) {
      return (
        (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 <
        Number(buildConfig.spec.failureRate)
      );
    }
    if (!(this.buildFailureRate > 0)) return false;
    return (
      (this._hashString(`${build.metadata.name}:failure`) % 1000) / 1000 < this.buildFailureRate
    );
  }

  /** Human-readable build failure message (mirrors `oc logs build/...`). */
  _buildFailureMessage(build) {
    if (build.spec?.forFailureMessage) return build.spec.forFailureMessage;
    return 'build failed: error: unable to build the image: source compilation failed (simulated failure)';
  }

  _completeBuildSuccess(build, buildConfig) {
    build.status.phase = 'Complete';
    // Real Build status uses `completionTimestamp` (RFC3339); `completionTime`
    // is the legacy game-only field some old saves carry.
    build.status.completionTimestamp = new Date().toISOString();
    delete build.status.completionTime;
    build.status.reason = 'BuildComplete';
    build.status.message = 'Build completed successfully';
    build.setCondition('Complete', 'True', 'BuildComplete');
    this.cluster.update(build.uid, build);

    const output = build.spec?.output?.to || buildConfig?.spec?.output?.to || {};
    if (output.kind === 'ImageStreamTag' && output.name) {
      const [imageStreamName, tag = 'latest'] = String(output.name).split(':');
      const namespace = output.namespace || build.metadata.namespace;
      // Every successful build pushes a NEW image digest: the tag history item
      // carries a digest derived from this build, exactly like a registry push
      // (two builds of the same tag are different images — issue #70).
      const result = this.cluster.updateImageStreamTag(namespace, imageStreamName, tag, {
        image: `sha256:${this.cluster._fakeDigest(
          `${build.metadata.name}:${imageStreamName}:${tag}`
        )}`,
      });
      build.status.output = {
        to: { kind: 'ImageStreamTag', name: `${imageStreamName}:${tag}` },
        imageDigest: result.tagEntry?.items?.[0]?.image || '',
      };
      this.cluster.update(build.uid, build);
      this._triggerImageChangeRollout(
        namespace,
        imageStreamName,
        tag,
        result.tagEntry?.items?.[0]?.dockerImageReference
      );
    }

    if (buildConfig) {
      buildConfig.status.lastVersion = Math.max(
        buildConfig.status?.lastVersion || 0,
        Number(build.status?.version) || buildConfig.status?.lastVersion || 0
      );
      this.cluster.update(buildConfig.uid, buildConfig);
    }
    build.recordEvent(
      'Normal',
      'BuildCompleted',
      `Build ${build.metadata.name} completed successfully`
    );
    this.eventBus?.emit('build:complete', {
      build: build.metadata.name,
      buildConfig: buildConfig?.metadata.name || '',
      namespace: build.metadata.namespace,
      imageStream: output.name || '',
      resource: build,
    });
  }

  _completeBuildWithFailure(build, buildConfig) {
    build.status.phase = 'Failed';
    build.status.completionTimestamp = new Date().toISOString();
    delete build.status.completionTime;
    build.status.reason = 'BuildFailed';
    build.status.message = this._buildFailureMessage(build);
    build.setCondition('Complete', 'False', 'BuildFailed', build.status.message);
    this.cluster.update(build.uid, build);
    build.recordEvent('Warning', 'BuildFailed', build.status.message);
    this.eventBus?.emit('build:failed', {
      build: build.metadata.name,
      buildConfig: buildConfig?.metadata.name || '',
      namespace: build.metadata.namespace,
      message: build.status.message,
      resource: build,
    });
  }

  /**
   * ImageChange trigger: roll out Deployments that consume the updated
   * ImageStreamTag (either through `spec.triggers` or a container image that
   * references the internal registry).
   */
  /**
   * Called after an ImageStreamTag update (build output, `oc tag`,
   * `oc import-image`). Only Deployments carrying the
   * `image.openshift.io/triggers` annotation roll out; without the annotation
   * an image change does not automatically update workloads (OCP 4.22 model).
   */
  _triggerImageChangeRollout(namespace, imageStreamName, tag, dockerImageReference) {
    for (const deployment of this.cluster.getByKindAndNamespace('Deployment', namespace)) {
      this._processDeploymentImageTriggers(deployment);
    }
  }

  /** ImageStream controller: keep `.status.dockerImageRepository`/tags coherent. */
  _tickImageStreams(dt) {
    for (const imageStream of this.cluster.getByKind('ImageStream')) {
      const namespace = imageStream.metadata.namespace;
      imageStream.status = imageStream.status || {};
      imageStream.status.dockerImageRepository =
        imageStream.status.dockerImageRepository ||
        `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.publicDockerImageRepository = `${IMAGE_REGISTRY_HOST}/${namespace}/${imageStream.metadata.name}`;
      imageStream.status.tags = imageStream.status.tags || [];

      for (const specTag of imageStream.spec.tags || []) {
        const tagName = specTag.name || 'latest';
        let statusTag = imageStream.status.tags.find((entry) => entry.tag === tagName);
        if (!statusTag) {
          statusTag = { tag: tagName, items: [] };
          imageStream.status.tags.push(statusTag);
        }
        if (
          statusTag.items.length === 0 &&
          specTag.from?.kind === 'DockerImage' &&
          specTag.from.name
        ) {
          statusTag.items = [
            {
              dockerImageReference: specTag.from.name,
              image: `sha256:${this.cluster._fakeDigest(specTag.from.name)}`,
              generation: 1,
              created: new Date().toISOString(),
            },
          ];
        }
      }
    }
  }

  // ── OpenShift: OLM subscriptions ───────────────────────────────────────

  /** Latch ResolutionFailed on a Subscription (idempotent, event + bus hook). */
  _failSubscriptionResolution(subscription, packageName, resolutionMessage) {
    const previous = (subscription.status.conditions || []).find(
      (condition) => condition.type === 'ResolutionFailed'
    );
    if (
      subscription.status.reason === 'ConstraintsNotSatisfiable' &&
      previous?.status === 'True' &&
      previous?.message === resolutionMessage
    ) {
      return;
    }
    subscription.status.phase = 'UpgradePending';
    subscription.status.reason = 'ConstraintsNotSatisfiable';
    subscription.status.message = resolutionMessage;
    subscription.setCondition(
      'ResolutionFailed',
      'True',
      'ConstraintsNotSatisfiable',
      resolutionMessage
    );
    // Real OLM does NOT add install-plan conditions when dependency resolution
    // fails (there is no install plan to report on) — issue #54b. Reporting
    // `InstallPlanPending False NoInstallPlan` alongside ResolutionFailed was a
    // simulator-only artefact.
    subscription.status.conditions = (subscription.status.conditions || []).filter(
      (condition) => condition.type !== 'InstallPlanPending'
    );
    this.cluster.update(subscription.uid, subscription);
    subscription.recordEvent('Warning', 'ResolutionFailed', resolutionMessage);
    this.cluster.update(subscription.uid, subscription);
    this.eventBus?.emit('operator:resolution-failed', {
      name: subscription.metadata.name,
      namespace: subscription.metadata.namespace,
      packageName,
      message: resolutionMessage,
    });
  }

  /**
   * OLM resolves Subscription dependencies per namespace / OperatorGroup, not
   * per Subscription: if any package in a namespace is absent from the catalog,
   * the namespace's resolution fails as a unit, so EVERY Subscription sharing
   * that OperatorGroup reports ResolutionFailed (issue #26).
   *
   * @returns {Map<string, {packageName: string, subscriptionName: string}>}
   *   namespace → the first unresolved package it tracks
   */
  _resolutionFailuresByNamespace() {
    const failures = new Map();
    for (const subscription of this.cluster.getByKind('Subscription')) {
      if (subscription.metadata.deletionTimestamp) continue;
      const namespace = subscription.metadata.namespace;
      if (failures.has(namespace)) continue;
      const packageName = this._packageNameForSubscription(subscription);
      if (this.cluster.getByName('PackageManifest', packageName, '')) continue;
      failures.set(namespace, { packageName, subscriptionName: subscription.metadata.name });
    }
    return failures;
  }

  _tickSubscriptions(dt) {
    this._collectOrphanedInstallPlans();
    const resolutionFailures = this._resolutionFailuresByNamespace();
    for (const subscription of this.cluster.getByKind('Subscription')) {
      if (subscription.metadata.deletionTimestamp) continue;
      const namespace = subscription.metadata.namespace;
      const packageName = this._packageNameForSubscription(subscription);
      // The Subscription CRD defaults spec.installPlanApproval to Automatic.
      // Manifest apply stores the spec verbatim, so restore the API default
      // here instead of reporting `undefined` before/until the controller runs.
      if (!subscription.spec.installPlanApproval) {
        subscription.spec.installPlanApproval = 'Automatic';
        this.cluster.update(subscription.uid, subscription);
      }
      const setStatus = (reason, message, phase = subscription.status.phase || 'Installing') => {
        if (subscription.status.phase === phase && subscription.status.reason === reason) return;
        subscription.status.phase = phase;
        subscription.status.reason = reason;
        subscription.status.message = message || '';
        this.cluster.update(subscription.uid, subscription);
      };

      // Simulated install failure flag (used by the OperatorInstallFailed incident).
      if (subscription.spec?.failure === true || subscription.spec?.installFailed === true) {
        if (subscription.status.phase !== 'Failed') {
          subscription.status.phase = 'Failed';
          subscription.status.reason = 'InstallFailed';
          subscription.status.message =
            subscription.spec.failureMessage || `operator ${packageName} failed to install`;
          subscription.setCondition(
            'InstallPlanComplete',
            'False',
            'InstallFailed',
            subscription.status.message
          );
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:failed', {
            name: subscription.metadata.name,
            namespace,
            packageName,
          });
        }
        continue;
      }
      if (subscription.status.phase === 'Failed') {
        // Failure flag cleared → retry the install.
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
        continue;
      }

      // A namespaced API object requires its project to exist.
      if (!this.cluster.getByName('Project', namespace, '')) {
        setStatus('NamespaceNotFound', `namespaces "${namespace}" not found`);
        if (!subscription._noNamespaceLogged) {
          subscription._noNamespaceLogged = true;
          subscription.setCondition(
            'InstallPlanPending',
            'False',
            'NamespaceNotFound',
            `namespaces "${namespace}" not found`
          );
          subscription.recordEvent(
            'Warning',
            'FailedCreate',
            `namespaces "${namespace}" not found`
          );
          this.cluster.update(subscription.uid, subscription);
        }
        continue;
      }
      subscription._noNamespaceLogged = false;

      // Catalog resolution (issues #18/#26): OLM resolves the namespace's
      // dependency set as a whole, so when any Subscription in this namespace
      // tracks a package that is missing from the catalog, every Subscription
      // sharing the OperatorGroup reports ConstraintsNotSatisfiable /
      // ResolutionFailed and nothing is installed in that namespace — no
      // phantom CSV, and a healthy sibling is not silently ignored.
      const resolutionFailure = resolutionFailures.get(namespace);
      if (resolutionFailure) {
        const ownPackageMissing = resolutionFailure.subscriptionName === subscription.metadata.name;
        const resolutionMessage = ownPackageMissing
          ? `constraints not satisfiable: no operators found in package ${resolutionFailure.packageName} in the catalog referenced by subscription ${subscription.metadata.name}`
          : `constraints not satisfiable: no operators found in package ${resolutionFailure.packageName} in the catalog referenced by the namespace; OLM resolves namespace "${namespace}" as a unit`;
        this._failSubscriptionResolution(subscription, packageName, resolutionMessage);
        continue;
      }
      // Safety net if the namespace-level snapshot missed a package (e.g. the
      // catalog changed between the map build and this iteration).
      const catalogEntry = this.cluster.getByName('PackageManifest', packageName, '');
      if (!catalogEntry) {
        this._failSubscriptionResolution(
          subscription,
          packageName,
          `constraints not satisfiable: no operators found in package ${packageName} in the catalog referenced by subscription ${subscription.metadata.name}`
        );
        continue;
      }

      // OperatorGroup: openshift-operators has the cluster-global group, other
      // namespaces require one (SingleNamespace installs) before OLM can deploy
      // the CSV (real 4.22 semantics — issue #9).
      const globalNamespace = namespace === 'openshift-operators';
      const operatorGroup =
        this.cluster.getByKindAndNamespace('OperatorGroup', namespace)[0] || null;
      if (!globalNamespace && !operatorGroup) {
        setStatus('NoOperatorGroup', `no operator group found in namespace "${namespace}"`);
        if (!subscription._noOperatorGroupLogged) {
          subscription._noOperatorGroupLogged = true;
          subscription.setCondition(
            'InstallPlanPending',
            'False',
            'NoOperatorGroup',
            `no operator group found in namespace "${namespace}"`
          );
          subscription.recordEvent(
            'Warning',
            'NoOperatorGroup',
            'OperatorGroup required to install this operator in the namespace'
          );
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:no-operatorgroup', {
            name: subscription.metadata.name,
            namespace,
            packageName,
            message: `no operator group found in namespace "${namespace}"`,
          });
        }
        continue;
      }
      subscription._noOperatorGroupLogged = false;

      // Catalog resolution of the Subscription's channel + startingCSV (#46).
      // OLM resolves against the catalog's PackageManifest: an unknown channel
      // or a startingCSV that is not one of the channel's `entries` is a
      // terminal resolution failure — it never silently installs the channel
      // head instead. The messages are the real resolver's wording.
      const target = this._resolveSubscriptionTarget(subscription);
      if (target.error) {
        this._failSubscriptionResolution(
          subscription,
          packageName,
          `constraints not satisfiable: ${target.error.message}`
        );
        continue;
      }
      if (subscription.status.reason === 'ConstraintsNotSatisfiable') {
        // Channel/pin fixed (or package appeared later) → retry resolution.
        // Real OLM REMOVES the abnormal-true ResolutionFailed condition (and the
        // stale install-plan conditions) once resolution succeeds, so the fixed
        // Subscription must stop reporting the old failure.
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription.status.message = '';
        subscription.status.conditions = (subscription.status.conditions || []).filter(
          (condition) =>
            !['ResolutionFailed', 'InstallPlanPending', 'InstallPlanMissing'].includes(
              condition.type
            )
        );
        subscription._installElapsed = 0;
        this.cluster.update(subscription.uid, subscription);
      }
      const csvName = target.csvName;
      const version = target.version;
      // Real OLM resolves the package graph immediately: the Subscription's
      // status.currentCSV names the resolved CSV (the startingCSV pin for a
      // pinned Manual install) BEFORE the first InstallPlan is approved —
      // installedCSV stays empty until that CSV actually succeeds (issue #53D).
      if (!subscription.status.installedCSV && subscription.status.currentCSV !== csvName) {
        subscription.status.currentCSV = csvName;
        this.cluster.update(subscription.uid, subscription);
      }

      // A Subscription whose CSV was deleted re-installs it (OLM keeps the
      // operator installed while the Subscription exists). Only deleting the
      // Subscription too makes the CSV deletion the real uninstall.
      let csv = this._csvForSubscription(subscription, namespace);
      if (
        (subscription.status.phase === 'Succeeded' ||
          subscription.status.installPlanComplete === true) &&
        !csv
      ) {
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription.status.installedCSV = '';
        subscription.status.currentCSV = '';
        subscription.status.installPlanComplete = false;
        subscription.status.installPlanRef = null;
        subscription._installedEmitted = false;
        subscription._installElapsed = 0;
        // The old plan already completed; OLM resolves a NEW install plan for
        // the reinstall (a Manual subscription must approve it again).
        const stalePlan = this._installPlanForSubscription(subscription, namespace);
        if (stalePlan) this.cluster.remove(stalePlan.uid);
        this.cluster.update(subscription.uid, subscription);
        continue;
      }

      // Issue #53D: a Subscription that already installed a CSV (typically a
      // `startingCSV` pin older than the channel head) immediately resolves the
      // NEXT step of its channel and creates an upgrade InstallPlan. With
      // `installPlanApproval: Manual` the plan waits unapproved, so
      // installedCSV keeps the pin while currentCSV already names the head.
      const upgradeTarget = this._subscriptionUpgradeTarget(subscription, packageName);
      if (upgradeTarget) {
        this._tickSubscriptionUpgrade(subscription, namespace, packageName, upgradeTarget);
        continue;
      }

      if (typeof subscription._installElapsed !== 'number') {
        subscription._installElapsed = 0;
        subscription.status.phase = 'Installing';
        subscription.status.reason = 'Installing';
        subscription.status.message = `installing operator ${packageName}`;
        this.cluster.update(subscription.uid, subscription);
        this.eventBus?.emit('operator:installing', {
          name: subscription.metadata.name,
          namespace,
          packageName,
          csv: csvName,
        });
      }
      subscription._installElapsed += dt;
      const elapsed = subscription._installElapsed;

      // 1) InstallPlan (RequiresApproval until approved for Manual installs).
      let plan = this._installPlanForSubscription(subscription, namespace);
      if (!plan && elapsed >= 0.5) {
        const suffix = this._randomSuffix();
        plan = this.cluster.addResource({
          kind: 'InstallPlan',
          metadata: {
            name: `install-${suffix}`,
            namespace,
            labels: {
              'operators.coreos.com/subscription': subscription.metadata.name,
              'operators.coreos.com/package': packageName,
            },
          },
          spec: {
            approval: subscription.spec?.installPlanApproval || 'Automatic',
            approved: false,
            clusterServiceVersionNames: [csvName],
            source: subscription.spec?.source || '',
            sourceNamespace: subscription.spec?.sourceNamespace || '',
          },
          status: { phase: 'RequiresApproval' },
        });
        if (plan) {
          this._adoptInstallPlan(subscription, plan);
          plan.setPlan(csvName, version);
          this.cluster.update(plan.uid, plan);
          this.eventBus?.emit('installplan:created', {
            name: plan.metadata.name,
            namespace,
            subscription: subscription.metadata.name,
            csv: csvName,
          });
        }
      }
      if (!plan) continue;

      // Automatic plans are approved by OLM; Manual plans wait for the player
      // (`oc patch installplan install-xxxxx --type=merge -p '{"spec":{"approved":true}}'`).
      if (plan.spec.approval !== 'Manual' && plan.spec.approved !== true) {
        plan.spec.approved = true;
        this.cluster.update(plan.uid, plan);
      }
      if (plan.spec.approved !== true) {
        // Real OLM (issue #46): a Subscription whose InstallPlan is pending on
        // Manual approval reports `InstallPlanPending True RequiresApproval`
        // (an "abnormal-true" condition), never False.
        subscription.setCondition(
          'InstallPlanPending',
          'True',
          'RequiresApproval',
          `install plan ${plan.metadata.name} requires approval`
        );
        setStatus('RequiresApproval', `install plan ${plan.metadata.name} requires approval`);
        this.cluster.update(subscription.uid, subscription);
        continue;
      }
      if (typeof plan._approvedAtGameSeconds !== 'number')
        plan._approvedAtGameSeconds = this.gameSeconds;
      if (plan.status.phase !== 'Complete') {
        if (
          elapsed >= 1 ||
          this.gameSeconds - plan._approvedAtGameSeconds >= INSTALLPLAN_COMPLETE_SECONDS
        ) {
          plan.markComplete();
          this.cluster.update(plan.uid, plan);
          subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('installplan:complete', {
            name: plan.metadata.name,
            namespace,
            subscription: subscription.metadata.name,
          });
        } else {
          setStatus('Installing', `waiting for InstallPlan ${plan.metadata.name} to complete`);
          continue;
        }
      }

      // 2) ClusterServiceVersion, named after the package (never the Subscription).
      csv = this._csvForSubscription(subscription, namespace);
      if (!csv) {
        csv = this.cluster.addResource({
          kind: 'ClusterServiceVersion',
          metadata: {
            name: csvName,
            namespace,
            labels: {
              'operators.coreos.com/subscription': subscription.metadata.name,
              'olm.package': packageName,
            },
            annotations: {
              'olm.operatorNamespace': namespace,
              'olm.operatorGroup': operatorGroup
                ? `${operatorGroup.metadata.namespace}/${operatorGroup.metadata.name}`
                : '',
              'olm.targetNamespaces':
                operatorGroup &&
                Array.isArray(operatorGroup.spec.targetNamespaces) &&
                operatorGroup.spec.targetNamespaces.length > 0
                  ? operatorGroup.spec.targetNamespaces.join(',')
                  : globalNamespace
                    ? ''
                    : namespace,
            },
          },
          spec: {
            displayName: this._catalogDisplayName(packageName),
            version,
            // Replacement chain from the channel's ordered entries (issue #56):
            // a pinned v1.16.0 install carries `replaces: …v1.15.0` here, and
            // the upgrade CSV carries `replaces: …v1.16.0`.
            replaces: this._csvReplaces(packageName, csvName, target.channel),
            customresourcedefinitions: { owned: deepClone(this._catalogCrds(packageName)) },
          },
          status: { phase: 'Installing' },
        });
        if (csv) {
          csv._installStartedAt = this.gameSeconds;
          csv.markInstalling(`installing ${csvName}`);
          this.cluster.update(csv.uid, csv);
          this._knownCSVs.set(csv.uid, { name: csvName, namespace, packageName });
          subscription.status.currentCSV = csvName;
          this.cluster.update(subscription.uid, subscription);
          this.eventBus?.emit('operator:csv-created', {
            name: csvName,
            namespace,
            packageName,
            subscription: subscription.metadata.name,
          });
        }
      }
      if (!csv) continue;

      // 3) CSV install strategy → Succeeded + operator Deployment.
      if (csv.status.phase !== 'Succeeded') {
        if (typeof csv._installStartedAt !== 'number') csv._installStartedAt = this.gameSeconds;
        if (this.gameSeconds - csv._installStartedAt < CSV_INSTALL_SECONDS) {
          setStatus('Installing', `waiting for ClusterServiceVersion ${csvName} to succeed`);
          continue;
        }
        csv.markSucceeded();
        this.cluster.update(csv.uid, csv);
        this._knownCSVs.set(csv.uid, { name: csvName, namespace, packageName });
        this.eventBus?.emit('operator:csv-succeeded', { name: csvName, namespace, packageName });
      }
      const operatorDeployment = this._ensureOperatorDeploymentForCSV(csv, packageName);
      if (operatorDeployment && operatorDeployment.status?.phase !== 'Running') {
        // Deployment controller creates the operator Pod; nothing else to do here.
      }

      if (subscription.status.phase !== 'Succeeded') {
        subscription.status.phase = 'Succeeded';
        subscription.status.state = 'AtLatestKnown';
        subscription.status.installedCSV = csvName;
        subscription.status.currentCSV = csvName;
        subscription.status.reason = 'InstallSucceeded';
        subscription.status.message = `operator ${packageName} installed successfully`;
        subscription.status.installPlanRef = { name: plan.metadata.name, namespace };
        subscription.status.installPlanComplete = true;
        subscription.setCondition('InstallPlanComplete', 'True', 'InstallSucceeded');
        subscription.setCondition('InstallPlanPending', 'False', 'InstallPlanComplete');
        this.cluster.update(subscription.uid, subscription);
        if (!subscription._installedEmitted) {
          subscription._installedEmitted = true;
          this.eventBus?.emit('operator:installed', {
            name: subscription.metadata.name,
            namespace,
            packageName,
            csv: csvName,
            channel: subscription.spec?.channel,
            source: subscription.spec?.source,
            resource: subscription,
          });
        }
      }
    }

    // Keep track of CSVs created by earlier ticks so deleting them (including
    // during level teardown) performs the uninstall cleanup exactly once.
    // Copied CSVs (AllNamespaces shims, issue #46) are projections of a source
    // CSV and are reconciled by _syncCopiedCSVs, never tracked as operators.
    for (const csv of this.cluster.getByKind('ClusterServiceVersion')) {
      if (this._isCopiedCSV(csv)) continue;
      if (!this._knownCSVs.has(csv.uid)) {
        const packageName =
          csv.metadata?.labels?.['olm.package'] ||
          String(csv.metadata?.name || '').replace(/\.v\d.*$/, '');
        this._knownCSVs.set(csv.uid, {
          name: csv.metadata.name,
          namespace: csv.metadata.namespace,
          packageName,
        });
      }
    }
    for (const [uid, entry] of this._knownCSVs) {
      if (!this.cluster.get(uid)) {
        this._onCSVDeleted({
          ...entry,
          metadata: {
            name: entry.name,
            namespace: entry.namespace,
            labels: { 'olm.package': entry.packageName },
          },
        });
        this._knownCSVs.delete(uid);
      }
    }

    // Real OLM copies an AllNamespaces CSV into every other namespace so that
    // `oc get csv -A` shows the operator watching that namespace (#46 P4).
    this._syncCopiedCSVs();
  }

  /** Is this CSV an OLM copy of an AllNamespaces CSV installed elsewhere? */
  _isCopiedCSV(csv) {
    return Boolean(csv?.metadata?.labels?.['olm.copiedFrom']);
  }

  /**
   * Project every active AllNamespaces CSV into the cluster's other namespaces,
   * exactly like OLM's "copied CSVs" (issue #46 P4):
   *  - same name, spec and (almost all) annotations as the source CSV;
   *  - label `olm.copiedFrom: <source namespace>` (how OLM identifies a copy);
   *  - `olm.targetNamespaces` annotation stripped;
   *  - status matches the source CSV's status, with reason `Copied` and OLM's
   *    "The operator is running in <ns> but is managing this namespace" message.
   *
   * Copies are deleted when their source CSV or project disappears (or when the
   * OperatorGroup stops being cluster-global), and are recreated if a player
   * deletes them by hand — the source CSV continuously reconciles them.
   */
  _syncCopiedCSVs() {
    const projects = this.cluster
      .getByKind('Project')
      .filter(
        (project) => project.status?.phase !== 'Terminating' && !project.metadata?.deletionTimestamp
      )
      .map((project) => project.metadata.name);
    const projectSet = new Set(projects);
    const wanted = new Set();
    for (const source of this.cluster.getByKind('ClusterServiceVersion')) {
      if (this._isCopiedCSV(source)) continue;
      const sourceNamespace = source.metadata.namespace;
      const phase = source.status?.phase;
      if (phase !== 'Installing' && phase !== 'Succeeded') continue;
      const operatorGroup = this.cluster.getByKindAndNamespace('OperatorGroup', sourceNamespace)[0];
      const allNamespaces =
        operatorGroup &&
        Array.isArray(operatorGroup.spec?.targetNamespaces) &&
        operatorGroup.spec.targetNamespaces.length === 0;
      if (!allNamespaces) continue;
      for (const namespace of projects) {
        if (namespace === sourceNamespace) continue;
        const key = `${namespace}/${source.metadata.name}`;
        wanted.add(key);
        const existing = this.cluster.getByName(
          'ClusterServiceVersion',
          source.metadata.name,
          namespace
        );
        if (existing && !this._isCopiedCSV(existing)) continue;
        if (existing) {
          // Keep a copy's status in lockstep with its source while preserving
          // the Copied reason (real OLM updates copies on source status change).
          if (existing.status?.phase !== phase) {
            existing.status.phase = phase;
            this.cluster.update(existing.uid, existing);
          }
          continue;
        }
        const annotations = { ...(source.metadata.annotations || {}) };
        delete annotations['olm.targetNamespaces'];
        annotations['olm.operatorNamespace'] =
          annotations['olm.operatorNamespace'] || sourceNamespace;
        this.cluster.addResource({
          kind: 'ClusterServiceVersion',
          metadata: {
            name: source.metadata.name,
            namespace,
            labels: {
              ...(source.metadata.labels || {}),
              'olm.copiedFrom': sourceNamespace,
            },
            annotations,
          },
          spec: deepClone(source.spec || {}),
          status: {
            phase,
            reason: 'Copied',
            message: `The operator is running in ${sourceNamespace} but is managing this namespace`,
          },
        });
      }
    }
    // Prune copies whose source CSV/project/install mode no longer applies.
    for (const csv of this.cluster.getByKind('ClusterServiceVersion')) {
      if (!this._isCopiedCSV(csv)) continue;
      const key = `${csv.metadata.namespace}/${csv.metadata.name}`;
      if (!wanted.has(key) || !projectSet.has(csv.metadata.namespace)) {
        this.cluster.remove(csv.uid);
      }
    }
  }

  /** Display name advertised by the catalog for a package. */
  _catalogDisplayName(packageName) {
    const entry = OLM_CATALOG.find((candidate) => candidate.name === packageName);
    if (entry) return entry.displayName;
    return String(packageName)
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  /** CRDs advertised by the catalog for a package (CSV customresourcedefinitions). */
  _catalogCrds(packageName) {
    const entry = OLM_CATALOG.find((candidate) => candidate.name === packageName);
    return entry?.crds || [];
  }

  // ── OpenShift: SCC admission ───────────────────────────────────────────

  _tickSCC(dt) {
    const dirty = this._sccDirty;
    this._sccDirty = false;

    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Terminating') continue;
      const denied = pod.metadata.annotations['openshiftgames/scc-denied'] === 'true';

      if (denied) {
        if (!dirty) continue;
        const resolution = this._resolvePodSCC(pod);
        if (resolution.allowed) {
          this._revivePod(pod, 'openshiftgames/scc-denied');
          pod.setAnnotation('openshift.io/scc', resolution.scc?.metadata.name || 'restricted-v2');
          pod.recordEvent(
            'Normal',
            'SCCAdmitted',
            `Security context constraint ${resolution.scc?.metadata.name || 'restricted-v2'} admitted the pod`
          );
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }

      if (pod._sccEvaluated) continue;
      pod._sccEvaluated = true;
      const resolution = this._resolvePodSCC(pod);
      if (resolution.allowed) {
        pod.setAnnotation('openshift.io/scc', resolution.scc?.metadata.name || 'restricted-v2');
        continue;
      }

      const podSpec = pod.spec || {};
      const container = podSpec.containers?.[0] || {};
      const message = this._sccAdmissionFailure(podSpec, pod.metadata.namespace, resolution);
      pod.setAnnotation('openshiftgames/scc-denied', 'true');
      pod.setAnnotation(
        'openshiftgames/denied-reason',
        `pods "${pod.metadata.name}" is forbidden: ${message}`
      );
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'SCCDenied', message);
      pod.recordEvent(
        'Warning',
        'FailedCreate',
        `Error creating: pods "${pod.metadata.name}" is forbidden: ${message}`
      );
      this.cluster.update(pod.uid, pod);
      this.eventBus?.emit('scc:denied', {
        pod: pod.metadata.name,
        namespace: pod.metadata.namespace,
        container: container.name || 'main',
        serviceAccount: podSpec.serviceAccountName || 'default',
        securityContext: container.securityContext || podSpec.securityContext || null,
        message,
        resource: pod,
      });
    }
  }

  /**
   * Resolve the SCC for a pod. Falls back to treating pods without any bound
   * SCC as restricted (helps levels that create resources before a project is
   * fully seeded) unless they request elevated capabilities.
   */
  _resolvePodSCC(pod) {
    return this._resolveAdmissionForSpec(pod.spec || {}, pod.metadata?.namespace || 'default', pod);
  }

  /**
   * SCC admission for a (candidate) Pod spec. Works before the Pod object
   * exists, so controllers can reject a workload without ever creating a Pod
   * (issue #13: real clusters show `FailedCreate … unable to validate against
   * any security context constraint` on the ReplicaSet and no Pod).
   *
   * @param {object} podSpec
   * @param {string} namespace
   * @returns {{allowed: boolean, scc: object|null, candidates: object[], message?: string}}
   */
  _resolveAdmissionForSpec(podSpec, namespace) {
    // SCC admission only sees the explicit pod spec (RBACEngine.podSecurityRequest):
    // a bare `nginx:latest` with no securityContext is ADMITTED by restricted-v2
    // and only fails later at runtime (issue #25). Known-image personalities are
    // therefore NOT folded into the admission spec.
    const candidate = {
      metadata: { name: 'admission-candidate', namespace, labels: {} },
      spec: podSpec || {},
    };
    const resolution = this.cluster.resolveSCCForPod(candidate);
    if (resolution.allowed) return resolution;
    if (resolution.candidates && resolution.candidates.length > 0) {
      return {
        ...resolution,
        message: this._sccAdmissionFailure(podSpec, namespace, resolution),
      };
    }

    // No SCC bound to the service account at all (e.g. a custom namespace the
    // player just created): restricted pods are still admitted, elevated ones
    // are not (matches the real default `system:authenticated` binding).
    const request = podSecurityRequest(podSpec || {});
    const elevated =
      request.privileged ||
      request.hostNetwork ||
      request.hostPID ||
      request.hostIPC ||
      request.hostPath ||
      request.hostPorts.length > 0 ||
      request.runAsUsers.includes(0);
    if (elevated) {
      return {
        ...resolution,
        allowed: false,
        message: this._sccAdmissionFailure(podSpec, namespace, resolution),
      };
    }
    const restricted = this.cluster.getSCC('restricted-v2') || this.cluster.getSCCs()[0] || null;
    if (restricted && this.cluster.sccAllowsPod(restricted, podSpec || {})) {
      return { allowed: true, scc: restricted, candidates: [restricted] };
    }
    return {
      ...resolution,
      message: this._sccAdmissionFailure(podSpec, namespace, resolution),
    };
  }

  /**
   * Real 4.22 SCC admission failure detail (issue #76): the aggregate lists
   * every SCC the requesting identity cannot use (`provider "<name>": Forbidden:
   * not usable by user or serviceaccount`) followed by the per-field validation
   * reasons of the SCC(s) it CAN use, e.g.
   *
   *   unable to validate against any security context constraint: [provider
   *   "anyuid": Forbidden: not usable by user or serviceaccount,
   *   spec.containers[0].securityContext.privileged: Invalid value: true:
   *   Privileged containers are not allowed]
   *
   * @param {object} podSpec candidate pod spec
   * @param {string} namespace
   * @param {{candidates?: object[]}} [resolution] resolved SCC candidates
   * @returns {string}
   */
  _sccAdmissionFailure(podSpec, namespace, resolution = null) {
    const prefix = 'unable to validate against any security context constraint';
    const candidates =
      resolution?.candidates ||
      this.cluster.resolveSCCForPod({
        metadata: { name: 'admission-candidate', namespace },
        spec: podSpec || {},
      }).candidates ||
      [];
    const usable = new Set(candidates.map((scc) => scc.metadata?.name));
    const reasons = [];
    for (const scc of this.cluster.getSCCs()) {
      const name = scc.metadata?.name || '';
      if (usable.has(name)) continue;
      reasons.push(`provider "${name}": Forbidden: not usable by user or serviceaccount`);
    }
    const seen = new Set();
    for (const scc of candidates) {
      for (const detail of this._sccValidationDetails(scc, podSpec || {})) {
        if (seen.has(detail)) continue;
        seen.add(detail);
        reasons.push(detail);
      }
    }
    return reasons.length > 0 ? `${prefix}: [${reasons.join(', ')}]` : prefix;
  }

  /**
   * Per-field reasons an SCC rejects a pod spec (subset of the 4.22 SCC
   * validation: privileged, host namespaces, host ports, hostPath volumes).
   * @param {object} scc
   * @param {object} podSpec
   * @returns {string[]}
   */
  _sccValidationDetails(scc, podSpec) {
    const spec = scc?.spec || {};
    const request = podSecurityRequest(podSpec || {});
    const details = [];
    const add = (path, value, detail) => {
      details.push(`${path}: Invalid value: ${value}: ${detail}`);
    };
    if (!spec.allowPrivilegedContainer) {
      (podSpec.containers || []).forEach((container, index) => {
        if (container?.securityContext?.privileged === true) {
          add(
            `spec.containers[${index}].securityContext.privileged`,
            'true',
            'Privileged containers are not allowed'
          );
        }
      });
    }
    if (!spec.allowHostNetwork && request.hostNetwork) {
      add('spec.hostNetwork', 'true', 'Host network is not allowed to be used');
    }
    if (!spec.allowHostPID && request.hostPID) {
      add('spec.hostPID', 'true', 'Host PID is not allowed to be used');
    }
    if (!spec.allowHostIPC && request.hostIPC) {
      add('spec.hostIPC', 'true', 'Host IPC is not allowed to be used');
    }
    if (!spec.allowHostPorts) {
      (podSpec.containers || []).forEach((container, index) => {
        (container?.ports || []).forEach((port, portIndex) => {
          if (!(Number(port?.hostPort) > 0)) return;
          add(
            `spec.containers[${index}].ports[${portIndex}].hostPort`,
            String(port.hostPort),
            'Host ports are not allowed to be used'
          );
        });
      });
    }
    if (!spec.allowHostDirVolumePlugin) {
      (podSpec.volumes || []).forEach((volume, index) => {
        if (!volume?.hostPath) return;
        add(
          'spec.volumes[' + index + ']',
          '"hostPath"',
          'hostPath volumes are not allowed to be used'
        );
      });
    }
    return details;
  }

  /**
   * Record a controller-side FailedCreate (no Pod object is created) the way
   * the ReplicaSet/Job/DaemonSet controllers do, with duplicate-event
   * throttling like a real events recorder.
   * @param {object} parent controller resource
   * @param {string} podName candidate pod name (for the message)
   * @param {string} message admission/validation reason
   * @returns {null}
   */
  _recordFailedCreate(parent, podName, message) {
    const reason = String(message || 'unable to admit pod');
    // Real events are aggregated, not one-per-pod-attempt: throttle on the
    // failure reason so a controller retrying every tick does not flood Events.
    const signature = reason;
    const last = parent._lastFailedCreate;
    if (
      last &&
      last.signature === signature &&
      this.gameSeconds - last.at < FAILED_CREATE_EVENT_SECONDS
    ) {
      return null;
    }
    parent._lastFailedCreate = { signature, at: this.gameSeconds };
    const fullMessage = `Error creating: pods "${podName}" ${reason}`;
    parent.recordEvent('Warning', 'FailedCreate', fullMessage);
    if (
      parent.kind === 'ReplicaSet' ||
      parent.kind === 'StatefulSet' ||
      parent.kind === 'DaemonSet'
    ) {
      parent.setCondition('ReplicaFailure', 'True', 'FailedCreate', `pods "${podName}" ${reason}`);
      parent.status.replicas = parent.status.replicas || 0;
      parent.status.readyReplicas = 0;
      parent.status.availableReplicas = 0;
      parent.status.observedGeneration = parent.metadata.generation;
    }
    this.cluster.update(parent.uid, parent);
    this.eventBus?.emit('pod:failedcreate', {
      kind: parent.kind,
      name: parent.metadata.name,
      namespace: parent.metadata.namespace,
      pod: podName,
      message: `pods "${podName}" ${reason}`,
      reason: 'FailedCreate',
    });
    return null;
  }

  /** True when a controller resource currently has an active FailedCreate. */
  _hasReplicaFailure(parent) {
    return (parent?.status?.conditions || []).some(
      (condition) => condition.type === 'ReplicaFailure' && condition.status === 'True'
    );
  }

  /** Clear the FailedCreate condition after the controller succeeds again. */
  _clearReplicaFailure(parent) {
    if (!this._hasReplicaFailure(parent)) return;
    parent.setCondition('ReplicaFailure', 'False', 'NoReplicaFailure', '');
    parent._lastFailedCreate = null;
    this.cluster.update(parent.uid, parent);
  }

  /**
   * Validate a candidate Pod spec before it is created (API-server admission +
   * basic pod validation), returning a failure message or null when admitted.
   *
   * The admission chain mirrors a real cluster (issue #31):
   *   1. basic PodSpec validation,
   *   2. ServiceAccount admission (missing SA => FailedCreate, no Pod, #75),
   *   3. SCC admission (`restricted-v2` …),
   *   4. LimitRange: defaults are APPLIED to the Pod spec, then min/max checked,
   *   5. ResourceQuota: a compute quota with no LimitRange defaults rejects pods
   *      that omit requests ("failed quota: … must specify …"); a hard limit
   *      crossed rejects with the real "exceeded quota: …, requested: …, used:
   *      …, limited: …" wording. The Pod object is NEVER created for a rejected
   *      attempt — only a FailedCreate event on the owning controller.
   *
   * @param {object} podSpec
   * @param {string} namespace
   * @param {string} podName
   * @returns {string|null}
   */
  _admissionFailureMessage(podSpec, namespace, podName) {
    const containers = podSpec?.containers || [];
    for (let index = 0; index < containers.length; index++) {
      const container = containers[index];
      if (!container || !String(container.image || '').trim()) {
        return `is invalid: spec.containers[${index}].image: Required value`;
      }
      if (!String(container.name || '').trim()) {
        return `is invalid: spec.containers[${index}].name: Required value`;
      }
    }
    // ServiceAccount admission runs before SCC admission: a Pod that references
    // a ServiceAccount that does not exist is never created (issue #75 lab 8).
    // The real API-server error is exactly this lookup failure.
    const serviceAccountName = String(
      podSpec?.serviceAccountName || podSpec?.serviceAccount || ''
    ).trim();
    if (serviceAccountName && serviceAccountName !== 'default') {
      const serviceAccount = this.cluster.getByName(
        'ServiceAccount',
        serviceAccountName,
        namespace
      );
      if (!serviceAccount) {
        return `is forbidden: error looking up service account ${namespace}/${serviceAccountName}: serviceaccount "${serviceAccountName}" not found`;
      }
    }
    const resolution = this._resolveAdmissionForSpec(podSpec, namespace);
    if (!resolution.allowed) {
      return `is forbidden: ${resolution.message || 'unable to validate against any security context constraint'}`;
    }
    // LimitRanger admission: defaults first (they become part of the Pod spec),
    // then the min/max validation.
    this.cluster.applyLimitRangeDefaults(namespace, podSpec);
    const limitRangeCheck = this.cluster.checkLimitRange(namespace, podSpec);
    if (!limitRangeCheck.allowed) {
      return `is forbidden: ${limitRangeCheck.violations[0] || 'pod resources violate the project LimitRange'}`;
    }
    // ResourceQuota admission: rejected creates leave no Pod object behind.
    const quotaCheck = this.cluster.admitPodAgainstQuota(namespace, podSpec);
    if (!quotaCheck.allowed) return `is forbidden: ${quotaCheck.message}`;
    return null;
  }

  /**
   * Public admission gate for Pods the player creates directly through the CLI
   * (e.g. `oc run`, `oc create pod`): returns null when admitted, otherwise the
   * API-server reason string (`is forbidden: …`).
   *
   * Side effect: LimitRange defaults are written into the supplied podSpec, as
   * the real API server does. Callers should pass the spec they are about to
   * create (they may rebuild the object afterwards).
   *
   * @param {object} podSpec
   * @param {string} namespace
   * @param {string} [podName]
   * @returns {string|null}
   */
  podAdmissionForCreate(podSpec, namespace, podName = '') {
    if (!podSpec || typeof podSpec !== 'object') return null;
    return this._admissionFailureMessage(podSpec, namespace, podName);
  }

  /** Whether a Pod is blocked by SCC/LimitRange/quota admission. */
  _isPodBlocked(pod) {
    const annotations = pod.metadata.annotations || {};
    return (
      annotations['openshiftgames/scc-denied'] === 'true' ||
      annotations['openshiftgames/limitrange-denied'] === 'true' ||
      annotations['openshiftgames/quota-denied'] === 'true'
    );
  }

  /** Put a previously denied pod back into Pending so controllers retry it. */
  _revivePod(pod, annotationKey) {
    delete pod.metadata.annotations[annotationKey];
    delete pod.metadata.annotations['openshiftgames/denied-reason'];
    pod._sccEvaluated = false;
    pod._limitsEvaluated = false;
    pod._quotaEvaluated = false;
    delete pod.spec.nodeName;
    delete pod.status.podIP;
    delete pod.status.hostIP;
    pod.status.containerStatuses = [];
    pod.status.phase = 'Pending';
    this.cluster.update(pod.uid, pod);
    return pod;
  }

  // ── OpenShift: LimitRange enforcement ──────────────────────────────────

  _tickLimitRanges(dt) {
    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded') continue;
      const denied = pod.metadata.annotations['openshiftgames/limitrange-denied'] === 'true';
      if (denied) {
        const violations = this.cluster.checkLimitRange(
          pod.metadata.namespace,
          pod.spec || {}
        ).violations;
        if (violations.length === 0) {
          this._revivePod(pod, 'openshiftgames/limitrange-denied');
          pod.recordEvent(
            'Normal',
            'LimitRangeAdmitted',
            'Pod now satisfies the project LimitRange'
          );
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }
      if (pod._limitsEvaluated) continue;
      pod._limitsEvaluated = true;

      const namespace = pod.metadata.namespace;
      const limitRanges = this.cluster.getLimitRanges(namespace);
      if (limitRanges.length === 0) continue;

      const defaults = this.cluster.applyLimitRangeDefaults(namespace, pod.spec);
      let changed = defaults.applied;
      const check = this.cluster.checkLimitRange(namespace, pod.spec);
      if (!check.allowed) {
        pod.setAnnotation('openshiftgames/limitrange-denied', 'true');
        pod.setAnnotation(
          'openshiftgames/denied-reason',
          `pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`
        );
        pod.status.phase = 'Failed';
        pod.setCondition('Ready', 'False', 'LimitRangeViolation', check.violations[0]);
        pod.recordEvent(
          'Warning',
          'FailedCreate',
          `Error creating: pods "${pod.metadata.name}" is forbidden: ${check.violations[0]}`
        );
        this.cluster.update(pod.uid, pod);
        this.eventBus?.emit('limitrange:violation', {
          pod: pod.metadata.name,
          namespace,
          violations: check.violations,
          limitRange: limitRanges[0]?.metadata?.name,
          resource: pod,
        });
        continue;
      }
      if (changed) {
        pod.metadata.generation++;
        this.cluster.update(pod.uid, pod);
      }
    }
  }

  // ── OpenShift: quotas (ResourceQuota + ClusterResourceQuota) ───────────

  _tickQuotaEnforcement(dt) {
    // Admit/reject pods against ResourceQuota + ClusterResourceQuota.
    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.status.phase === 'Succeeded') continue;
      const annotations = pod.metadata.annotations;
      if (annotations['openshiftgames/quota-denied'] === 'true') {
        const admission = this.cluster.admitPodAgainstQuota(pod.metadata.namespace, pod.spec || {});
        if (admission.allowed) {
          this._revivePod(pod, 'openshiftgames/quota-denied');
          pod.recordEvent('Normal', 'QuotaAdmitted', 'Pod now fits within the project quota');
          this.cluster.update(pod.uid, pod);
        }
        continue;
      }
      // Controller-created pods were already admitted by _createPodForWorkload
      // (real admission happens before the object exists), and seeded/legacy
      // pods carry the admitted annotation: quota changes never retroactively
      // reject an existing Pod.
      if (annotations['openshiftgames/quota-admitted'] === 'true') continue;
      if (pod._quotaEvaluated) continue;
      pod._quotaEvaluated = true;
      // Direct Pod creates (palette/YAML/`oc run` without the CLI gate) are
      // still evaluated here; a rejected Pod is marked Failed with the same
      // "Error creating: pods … is forbidden: …" reason the API server reports.
      const admission = this.cluster.admitPodAgainstQuota(pod.metadata.namespace, pod.spec || {});
      if (admission.allowed) {
        pod.setAnnotation('openshiftgames/quota-admitted', 'true');
        this.cluster.update(pod.uid, pod);
        continue;
      }

      pod.setAnnotation('openshiftgames/quota-denied', 'true');
      pod.setAnnotation(
        'openshiftgames/denied-reason',
        `pods "${pod.metadata.name}" is forbidden: ${admission.message || 'exceeded quota'}`
      );
      pod.status.phase = 'Failed';
      pod.setCondition('Ready', 'False', 'QuotaExceeded', admission.message || 'exceeded quota');
      pod.recordEvent(
        'Warning',
        'FailedCreate',
        `Error creating: pods "${pod.metadata.name}" is forbidden: ${admission.message || 'exceeded quota'}`
      );
      this.cluster.update(pod.uid, pod);
      this.eventBus?.emit('quota:exceeded', {
        namespace: pod.metadata.namespace,
        pod: pod.metadata.name,
        violations: admission.violations,
        quotaName: admission.quotaName,
      });
    }

    // Legacy quota map + current violations (kept for backwards compatibility).
    const violating = new Set();
    for (const [namespace] of this.cluster.resourceQuotas) {
      const result = this.cluster.checkQuota(namespace, 0, 0);
      if (!result.allowed) {
        violating.add(namespace);
        if (!this._quotaViolationNamespaces.has(namespace)) {
          this.eventBus?.emit('quota:exceeded', {
            namespace,
            violations: result.violations,
            usage: result.usage,
          });
        }
      }
    }
    this._quotaViolationNamespaces = violating;
  }

  // ── OpenShift: OAuth rollout + cluster operators ───────────────────────

  /**
   * Reconcile an observed OAuth/Secret update against the settled baseline
   * (issue #54f). ClusterState.clear() and mode setup re-add the SAME baseline
   * OAuth singleton, which must NOT start an oauth-openshift rollout — a fresh
   * cluster shows authentication Progressing=False/AsExpected. Only a real
   * identityProviders/tokenConfig or htpasswd Secret data change is a rollout.
   */
  _noteOAuthConfigChange() {
    const signature = this._oauthSignature();
    const hadBaseline = typeof this._oauthConfigSignature === 'string';
    if (this._oauthConfigSignature === signature) return;
    this._oauthConfigSignature = signature;
    if (!hadBaseline) return; // first observation is the settled baseline
    this._scheduleOAuthRollout();
  }

  /**
   * Stable fingerprint of the OAuth configuration the authentication operator
   * watches: spec.identityProviders, spec.tokenConfig and the DATA of the
   * htpasswd Secret the identity provider references. The *names* of things
   * (secret/name) are included so adding a provider that references a different
   * Secret also counts as a change.
   * @returns {string}
   */
  _oauthSignature() {
    const oauth = this.cluster.getOAuth?.();
    const spec = oauth?.spec || {};
    const provider = this.cluster.getAuthProviderConfig?.() || null;
    let secretData = '';
    if (provider?.secretName) {
      const secret = this.cluster.getByName('Secret', provider.secretName, provider.namespace);
      const data = secret?.spec?.data || secret?.data || {};
      secretData = this._stableStringify(data);
    }
    return this._stableStringify({
      identityProviders: spec.identityProviders || [],
      tokenConfig: spec.tokenConfig || null,
      providerName: provider?.name || '',
      secretName: provider?.secretName || '',
      secretData,
    });
  }

  /**
   * Authentication-operator reconciliation: an OAuth configuration change (or a
   * change to the referenced htpasswd Secret) rolls out new oauth-openshift
   * pods. While the rollout is pending the OAuth server still serves the OLD
   * config and `oc login` must fail with "wait for the OAuth rollout"— in both
   * campaign L13 and lab 11 (issue #35).
   */
  _scheduleOAuthRollout() {
    const provider = this.cluster.getAuthProviderConfig();
    const wasPending = Boolean(this._oauthPending);
    this._oauthPending = { remaining: OAUTH_ROLLOUT_SECONDS, provider };
    if (!wasPending) this._rollOauthAuthenticationDeployment();
    this._setAuthenticationOperatorProgressing(true);
    const oauth = this.cluster.getOAuth();
    if (oauth) {
      oauth.status = oauth.status || {};
      oauth.status.ready = false;
      oauth.status.rollingOut = true;
    }
  }

  /** Bump the oauth-openshift Deployment template so its pods roll out. */
  _rollOauthAuthenticationDeployment() {
    const deployment = this.cluster.getByName(
      'Deployment',
      'oauth-openshift',
      'openshift-authentication'
    );
    if (!deployment) return null;
    deployment.spec = deployment.spec || {};
    deployment.spec.template = deployment.spec.template || { metadata: {}, spec: {} };
    deployment.spec.template.metadata = deployment.spec.template.metadata || {};
    deployment.spec.template.metadata.annotations =
      deployment.spec.template.metadata.annotations || {};
    // A template hash change is what makes the real deployment controller
    // create a new ReplicaSet + oauth-openshift-* pods.
    deployment.spec.template.metadata.annotations['openshift.io/oauth-rollout'] = String(
      Date.now()
    );
    deployment.metadata.generation = (Number(deployment.metadata.generation) || 1) + 1;
    deployment.setCondition?.(
      'Progressing',
      'True',
      'OAuthConfigChange',
      'rolling out the OAuth server'
    );
    this.cluster.update(deployment.uid, deployment);
    this.eventBus?.emit('rollout:triggered', {
      kind: 'Deployment',
      name: deployment.metadata.name,
      namespace: deployment.metadata.namespace,
      resource: deployment,
    });
    return deployment;
  }

  /** Reflect the OAuth rollout in `oc get clusteroperators authentication`. */
  _setAuthenticationOperatorProgressing(progressing) {
    const operator = this.cluster
      .getClusterOperators?.()
      .find((entry) => entry.metadata?.name === 'authentication');
    if (!operator) return;
    if (progressing) {
      operator.setCondition('Available', 'True', 'AsExpected', 'All is well');
      operator.setCondition(
        'Progressing',
        'True',
        'OAuthConfigChange',
        'OAuth server is rolling out'
      );
      operator.setCondition('Degraded', 'False', 'AsExpected', 'All is well');
    } else {
      operator.setCondition('Available', 'True', 'AsExpected', 'All is well');
      operator.setCondition('Progressing', 'False', 'AsExpected', 'All is well');
      operator.setCondition('Degraded', 'False', 'AsExpected', 'All is well');
    }
  }

  /**
   * Observe a `project.config.openshift.io/cluster` change and start the
   * openshift-apiserver rollout (issue #76). Called synchronously from the
   * cluster event bus (so `oc patch`/`oc edit` immediately shows
   * `Progressing=True` on the ClusterOperator) and from the tick controller as
   * a safety net.
   * @param {string} [desired] current `.spec.projectRequestTemplate.name`
   */
  _noteProjectTemplateConfigChange(desired = null) {
    const config = this.cluster.getProjectConfig?.();
    const target = String(
      desired === null ? config?.spec?.projectRequestTemplate?.name || '' : desired
    );
    if (target === this._projectTemplateSignature) return;
    this._projectTemplateSignature = target;
    this._projectTemplateRollout = {
      target,
      remaining: PROJECT_TEMPLATE_ROLLOUT_SECONDS,
    };
    this.cluster.setClusterOperatorState?.('openshift-apiserver', {
      available: true,
      progressing: true,
      degraded: false,
      message: 'Observed project.config.openshift.io/cluster change; rolling out new revision',
    });
  }

  /**
   * openshift-apiserver configuration rollout (issue #76).
   *
   * Setting `project.config.openshift.io/cluster .spec.projectRequestTemplate`
   * does NOT take effect instantly on a real cluster: the config observer rolls
   * out a new openshift-apiserver revision and project requests are templated by
   * the OLD revision until the new one is available. Modelled deterministically
   * (game clock, no wall time):
   *   - the `openshift-apiserver` ClusterOperator reports
   *     `Progressing=True` with `reason=Working` for
   *     PROJECT_TEMPLATE_ROLLOUT_SECONDS (8) game seconds,
   *   - during the window `oc new-project` still applies the PREVIOUS
   *     project-request Template (none on a fresh cluster),
   *   - afterwards `Progressing=False/AsExpected` and new projects are templated.
   * Testable with `advanceSimulation(9)`; verified in browser-test §qa-issue70-76.
   * @param {number} dt game seconds
   */
  _tickProjectTemplateRollout(dt) {
    const config = this.cluster.getProjectConfig?.();
    if (!config) return;
    const desired = String(config.spec?.projectRequestTemplate?.name || '');
    if (this._projectTemplateSignature === null) {
      // First observation = settled cluster startup: adopt the seeded value
      // without a spurious rollout (fresh clusters have no template).
      this._projectTemplateSignature = desired;
      this.cluster.setActiveProjectRequestTemplate?.(desired);
      return;
    }
    if (desired !== this._projectTemplateSignature) {
      this._noteProjectTemplateConfigChange(desired);
    }
    if (!this._projectTemplateRollout) return;
    this._projectTemplateRollout.remaining -= dt;
    if (this._projectTemplateRollout.remaining > 0) return;
    const target = this._projectTemplateRollout.target;
    this._projectTemplateRollout = null;
    this.cluster.setActiveProjectRequestTemplate?.(target);
    this.cluster.setClusterOperatorState?.('openshift-apiserver', {
      available: true,
      progressing: false,
      degraded: false,
      message: 'All is well',
    });
    this.eventBus?.emit('projecttemplate:active', { name: target });
  }

  _tickOAuth(dt) {
    if (!this._oauthPending) return;
    this._oauthPending.remaining -= dt;
    if (this._oauthPending.remaining > 0) return;

    const provider = this._oauthPending.provider;
    this._oauthPending = null;
    this._setAuthenticationOperatorProgressing(false);
    const oauth = this.cluster.getOAuth();
    if (oauth) {
      oauth.status = oauth.status || {};
      oauth.status.ready = !!provider;
      oauth.status.lastRollout = new Date().toISOString();
      oauth.status.observedGeneration = oauth.metadata.generation;
      oauth.status.rollingOut = false;
      oauth.status.conditions = [
        {
          type: provider ? 'Available' : 'Progressing',
          status: 'True',
          reason: provider ? 'IdentityProviderReady' : 'NoIdentityProviders',
          message: provider
            ? `identity provider ${provider.name} is ready`
            : 'no identity providers configured',
          lastTransitionTime: new Date().toISOString(),
        },
      ];
      oauth._bumpResourceVersion();
    }
    this.eventBus?.emit('auth:provider-ready', {
      provider,
      namespace: 'openshift-config',
      resource: oauth,
    });
  }

  _tickClusterHealth(dt) {
    const version = OPENSHIFT_VERSION;
    for (const operator of this.cluster.getClusterOperators()) {
      if (!operator.status.conditions || operator.status.conditions.length === 0) {
        operator.setCondition('Available', 'True', 'AsExpected', 'All is well');
        operator.setCondition('Progressing', 'False', 'AsExpected', 'All is well');
        operator.setCondition('Degraded', 'False', 'AsExpected', 'All is well');
      }
      operator.status.versions =
        operator.status.versions && operator.status.versions.length > 0
          ? operator.status.versions.map((entry) => ({ ...entry, version }))
          : [{ name: 'operator', version }];
      if (operator._forceDegraded) {
        operator.setCondition(
          'Degraded',
          'True',
          'Degraded',
          operator._degradedMessage || 'component is degraded'
        );
      }
      if (operator._forceUnavailable) {
        operator.setCondition(
          'Available',
          'False',
          'Unavailable',
          operator._unavailableMessage || 'component is unavailable'
        );
      }
      operator.status.observedGeneration = operator.metadata.generation;
    }

    const clusterVersion = this.cluster.getClusterVersion();
    if (clusterVersion) {
      clusterVersion.status = clusterVersion.status || {};
      clusterVersion.status.desired = {
        version: clusterVersion.spec?.desiredUpdate?.version || version,
        channel: clusterVersion.spec?.channel || OPENSHIFT_CHANNEL,
      };
      clusterVersion.status.version = clusterVersion.status.desired.version;
      clusterVersion.status.observedGeneration = clusterVersion.metadata.generation;
    }
  }

  // ── Chaos / pod factory / metrics ──────────────────────────────────────

  _tickChaos(dt) {
    if (this.chaosConfig.podKillRate > 0) {
      for (const pod of this.cluster
        .getByKind('Pod')
        .filter((entry) => entry.status.phase === 'Running')) {
        if (Math.random() < this.chaosConfig.podKillRate * dt) {
          pod.setPhase('Failed');
          pod.recordEvent('Warning', 'ChaosKilled', 'Pod killed by chaos engineering');
          this.eventBus?.emit('chaos:podkill', { pod: pod.name, namespace: pod.namespace });
        }
      }
    }
    if (this.chaosConfig.nodeFailRate > 0) {
      for (const node of this.cluster
        .getByKind('Node')
        .filter((entry) => entry.isConditionTrue('Ready'))) {
        if (Math.random() < this.chaosConfig.nodeFailRate * dt) {
          node.setPhase('NotReady');
          node.setCondition('Ready', 'False', 'ChaosNodeFailure');
          node.recordEvent('Warning', 'ChaosNodeDown', 'Node failed due to chaos injection');
          const pods = this.cluster
            .getByKind('Pod')
            .filter((pod) => pod.spec.nodeName === node.name && pod.status.phase === 'Running');
          for (const pod of pods) {
            pod.setPhase('Failed');
            pod.recordEvent('Warning', 'NodeLost', `Node ${node.name} became unreachable`);
          }
          this.eventBus?.emit('chaos:nodefailure', { node: node.name, podsEvicted: pods.length });
        }
      }
    }
    if (this.chaosConfig.cpuStress > 0 || this.chaosConfig.memoryStress > 0) {
      for (const pod of this.cluster
        .getByKind('Pod')
        .filter((entry) => entry.status.phase === 'Running' && entry.status.containerStatuses)) {
        for (const status of pod.status.containerStatuses) {
          if (!status.state.running) continue;
          if (!status.resources) continue;
          if (this.chaosConfig.cpuStress > 0)
            status.resources.cpu += status.resources.cpuRequest * this.chaosConfig.cpuStress;
          if (this.chaosConfig.memoryStress > 0)
            status.resources.memory +=
              status.resources.memoryRequest * this.chaosConfig.memoryStress;
        }
      }
    }
  }

  /**
   * The controller ownerReference a real controller writes on a child it
   * creates (same shape as ResourceBase.addOwnerReference). Children are
   * created WITH it, never ownerless first (1.16.0: the "You created" toast
   * claimed incident/controller-made ReplicaSets and Pods as the player's).
   * @param {object} owner
   * @returns {object}
   */
  _controllerOwnerReference(owner) {
    return {
      apiVersion: owner?.apiVersion,
      kind: owner?.kind,
      name: owner?.metadata?.name,
      uid: owner?.metadata?.uid || owner?.uid,
      controller: true,
      blockOwnerDeletion: true,
    };
  }

  _createPodForWorkload(parent, templateSource, nameOverride) {
    if (!parent) return null;
    // Do not spin up replacement pods while an admission-denied pod exists.
    if (
      this.cluster
        .getChildren(parent.uid)
        .some((child) => child.kind === 'Pod' && this._isPodBlocked(child))
    ) {
      return null;
    }

    const podName = nameOverride || `${parent.name}-${this._randomSuffix()}`;
    const namespace = parent.metadata.namespace;
    // Create-only path: ClusterState.addResource() re-applies the supplied
    // status to an existing object, which used to reset a running pod to
    // Pending when a controller upserted the same name again (SIM-006).
    const existing = this.cluster.getByName('Pod', podName, namespace);
    if (existing) return existing;

    const template = templateSource.spec.template || {};
    const podSpec = deepClone(template.spec || {});
    podSpec.containers = podSpec.containers || [
      {
        name: 'main',
        image: 'app:latest',
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
    ];
    const selectorLabels = templateSource.spec?.selector?.matchLabels || {};
    const templateLabels = template.metadata?.labels || templateSource.metadata.labels || {};
    // The pod-template-hash must be identical on the ReplicaSet and all pods it
    // creates (it is the RS name suffix, not a per-pod random value).
    const templateHash =
      templateLabels['pod-template-hash'] || templateSource.metadata.labels?.['pod-template-hash'];
    const labels = { ...selectorLabels, ...templateLabels };
    if (templateHash) labels['pod-template-hash'] = templateHash;

    // API-server admission + validation happen BEFORE the Pod object exists:
    // a rejected workload create leaves no Pod behind (issue #13), just a
    // FailedCreate event/condition on the owning controller.
    const admissionFailure = this._admissionFailureMessage(podSpec, namespace, podName);
    if (admissionFailure) {
      this._recordFailedCreate(parent, podName, admissionFailure);
      return null;
    }

    const pod = this.cluster.addResource({
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace,
        labels,
        ownerReferences: [this._controllerOwnerReference(parent)],
      },
      spec: podSpec,
      status: { phase: 'Pending' },
    });
    if (!pod) return null;
    // Timeline origin for kubelet-side timers (RESTARTS vs AGE consistency).
    pod._createdAtGameSeconds = this.gameSeconds;
    this.cluster.addRelationship(parent.uid, pod.uid);
    // The Pod passed API-server admission (SCC + LimitRange + quota) BEFORE it
    // existed: record that fact so later quota edits never retroactively reject
    // a running Pod (a real cluster does not re-admit existing Pods).
    pod.setAnnotation('openshiftgames/quota-admitted', 'true');
    this._ensurePodServiceAccountTokenMount(pod);
    this.cluster.update(pod.uid, pod);
    this._clearReplicaFailure(parent);
    if (parent.kind === 'ReplicaSet') {
      parent.status.replicas = (parent.status.replicas || 0) + 1;
      parent.recordEvent('Normal', 'SuccessfulCreate', `Created pod: ${podName}`);
    }
    return pod;
  }

  // ── Service-account token mounts (issue #42) ───────────────────────────

  /**
   * A real API server / kubelet always injects the projected service-account
   * token volume into every Pod unless `automountServiceAccountToken: false`:
   *
   *   volumes:
   *   - name: kube-api-access-<rand5>
   *     projected:
   *       defaultMode: 420
   *       sources:
   *       - serviceAccountToken: {expirationSeconds: 3607, path: token}
   *       - configMap: {name: kube-root-ca.crt, items: [{key: ca.crt, path: ca.crt}]}
   *       - downwardAPI: {items: [{fieldRef: {fieldPath: metadata.namespace}, path: namespace}]}
   *
   * The container mounts it read-only at
   * `/var/run/secrets/kubernetes.io/serviceaccount` so `oc exec` can read
   * token, ca.crt, namespace (and the service-ca controller adds
   * service-ca.crt). Idempotent; deterministic volume suffix per Pod name.
   *
   * @param {object} pod
   * @returns {boolean} true when the Pod spec was changed
   */
  _ensurePodServiceAccountTokenMount(pod) {
    if (!pod || pod.kind !== 'Pod' || !pod.metadata) return false;
    const spec = pod.spec || (pod.spec = {});
    // Pod-level opt-out wins over the ServiceAccount default (real semantics).
    if (spec.automountServiceAccountToken === false) return false;
    const namespace = pod.metadata.namespace || spec.namespace || 'default';
    const serviceAccountName = spec.serviceAccountName || 'default';
    const serviceAccount = this.cluster.getByName('ServiceAccount', serviceAccountName, namespace);
    if (serviceAccount?.spec?.automountServiceAccountToken === false) return false;
    spec.containers = Array.isArray(spec.containers) ? spec.containers : [];
    spec.volumes = Array.isArray(spec.volumes) ? spec.volumes : [];
    const mountPath = SERVICE_ACCOUNT_MOUNT_PATH;
    let volume = spec.volumes.find(
      (entry) => entry && /^kube-api-access-/.test(String(entry.name || ''))
    );
    let changed = false;
    if (!volume) {
      volume = {
        name: this._serviceAccountVolumeName(pod.metadata.name || 'pod'),
        projected: {
          defaultMode: 420,
          sources: [
            {
              serviceAccountToken: {
                expirationSeconds: SERVICE_ACCOUNT_TOKEN_SECONDS,
                path: 'token',
              },
            },
            {
              configMap: {
                name: 'kube-root-ca.crt',
                items: [{ key: 'ca.crt', path: 'ca.crt' }],
              },
            },
            {
              downwardAPI: {
                items: [
                  {
                    fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' },
                    path: 'namespace',
                  },
                ],
              },
            },
            // OpenShift's service-account admission plugin adds the service CA
            // bundle to the same projected volume, which is how every Pod ends
            // up with /var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt.
            {
              configMap: {
                name: 'openshift-service-ca.crt',
                items: [{ key: 'service-ca.crt', path: 'service-ca.crt' }],
              },
            },
          ],
        },
      };
      spec.volumes.push(volume);
      changed = true;
    }
    for (const container of spec.containers) {
      if (!container || typeof container !== 'object') continue;
      container.volumeMounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
      if (container.volumeMounts.some((entry) => entry?.mountPath === mountPath)) continue;
      container.volumeMounts.push({ name: volume.name, readOnly: true, mountPath });
      changed = true;
    }
    if (!spec.serviceAccountName) {
      spec.serviceAccountName = serviceAccountName;
      changed = true;
    }
    return changed;
  }

  /** Deterministic 5-char kube-api-access volume suffix for a Pod name. */
  _serviceAccountVolumeName(podName) {
    let state = this._hashString(`${podName}:kube-api-access`) >>> 0;
    let suffix = '';
    for (let index = 0; index < 5; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      suffix += RAND_SAFE_ALPHABET[state % RAND_SAFE_ALPHABET.length];
    }
    return `kube-api-access-${suffix}`;
  }

  /**
   * Ensure every existing (including seeded/legacy) Pod has the injected
   * service-account token mount. Idempotent per-tick safety net.
   */
  _tickPodServiceAccountMounts() {
    for (const pod of this.cluster.getByKind('Pod')) {
      if (pod.isDeleting) continue;
      if (!this._ensurePodServiceAccountTokenMount(pod)) continue;
      this.cluster.update(pod.uid, pod);
    }
  }

  // ── NetworkPolicy traffic evaluation ───────────────────────────────────
  //
  // Real Kubernetes NetworkPolicy semantics: a Pod is isolated for a direction
  // as soon as any policy with that policyType selects it; traffic is then
  // allowed only by an explicit rule of one of those policies. Both egress (in
  // the source namespace) and ingress (in the destination namespace) must
  // allow the flow. OpenShift's dns-default pods listen on port 5353, so DNS
  // egress policies must open 5353 (not 53) to restore name resolution
  // (issue #14).

  /** Labels used to match a namespace selector (Project labels + name label). */
  _namespaceLabels(namespace) {
    const project = this.cluster.getByName('Project', namespace, '');
    // Real selector semantics: only labels that actually exist on the Namespace
    // object are visible, plus Kubernetes' automatic
    // `kubernetes.io/metadata.name=<namespace>` label (NamespaceDefaultLabelName,
    // GA since 1.22). The ingress policy-group labels are seeded on the real
    // `openshift-ingress` Project by ClusterState — nothing is fabricated here
    // (issue #41).
    return {
      'kubernetes.io/metadata.name': namespace,
      ...(project?.metadata?.labels || {}),
    };
  }

  /** Match a LabelSelector ({matchLabels,matchExpressions}) against labels. */
  _labelSelectorMatches(selector, labels) {
    if (!selector || typeof selector !== 'object') return true;
    const matchLabels =
      selector.matchLabels && typeof selector.matchLabels === 'object'
        ? selector.matchLabels
        : selector.matchExpressions
          ? {}
          : selector;
    for (const [key, value] of Object.entries(matchLabels)) {
      if ((labels || {})[key] !== value) return false;
    }
    for (const expression of selector.matchExpressions || []) {
      if (!expression || !expression.key) continue;
      const values = Array.isArray(expression.values) ? expression.values : [];
      const actual = (labels || {})[expression.key];
      switch (expression.operator) {
        case 'In':
          if (actual === undefined || !values.includes(actual)) return false;
          break;
        case 'NotIn':
          if (actual !== undefined && values.includes(actual)) return false;
          break;
        case 'Exists':
          if (actual === undefined) return false;
          break;
        case 'DoesNotExist':
          if (actual !== undefined) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  _networkPoliciesIn(namespace) {
    return this.cluster.getByKindAndNamespace('NetworkPolicy', namespace);
  }

  _policyTypes(policy) {
    if (Array.isArray(policy?.spec?.policyTypes) && policy.spec.policyTypes.length > 0) {
      return policy.spec.policyTypes.map((entry) => String(entry));
    }
    const types = ['Ingress'];
    if (Array.isArray(policy?.spec?.egress) && policy.spec.egress.length > 0) types.push('Egress');
    return types;
  }

  _policySelectsPod(policy, pod) {
    return this._labelSelectorMatches(policy?.spec?.podSelector || {}, pod?.metadata?.labels || {});
  }

  /** Policies that isolate `pod` for the given direction ('Ingress'|'Egress'). */
  _policiesForPod(pod, direction) {
    return this._networkPoliciesIn(pod?.metadata?.namespace || 'default').filter(
      (policy) =>
        this._policyTypes(policy).includes(direction) && this._policySelectsPod(policy, pod)
    );
  }

  _networkPolicyPortMatches(rulePorts, port, protocol, destinationPod) {
    if (!Array.isArray(rulePorts) || rulePorts.length === 0) return true;
    for (const rulePort of rulePorts) {
      if (!rulePort || typeof rulePort !== 'object') continue;
      const ruleProtocol = String(rulePort.protocol || 'TCP').toUpperCase();
      const wantedProtocol = String(protocol || 'TCP').toUpperCase();
      if (ruleProtocol !== wantedProtocol) continue;
      if (rulePort.port === undefined || rulePort.port === null || rulePort.port === '')
        return true;
      const numeric = Number(rulePort.port);
      if (Number.isFinite(numeric)) {
        if (Number(port) === numeric) return true;
        if (
          Number.isFinite(Number(rulePort.endPort)) &&
          Number(port) >= numeric &&
          Number(port) <= Number(rulePort.endPort)
        )
          return true;
        continue;
      }
      // Named port: resolve against the destination container ports.
      const matched = (destinationPod?.spec?.containers || []).some((container) =>
        (container.ports || []).some(
          (containerPort) =>
            containerPort.name === rulePort.port &&
            Number(containerPort.containerPort) === Number(port)
        )
      );
      if (matched) return true;
    }
    return false;
  }

  _ipInCidr(ip, cidr) {
    if (!ip || !cidr || !String(cidr).includes('/')) return false;
    const [network, prefixRaw] = String(cidr).split('/');
    const prefix = Number(prefixRaw);
    const toInt = (value) => {
      const parts = String(value).split('.').map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
      return (
        (((parts[0] << 24) >>> 0) +
          ((parts[1] << 16) >>> 0) +
          ((parts[2] << 8) >>> 0) +
          parts[3]) >>>
        0
      );
    };
    const ipValue = toInt(ip);
    const networkValue = toInt(network);
    if (ipValue === null || networkValue === null || !Number.isFinite(prefix)) return false;
    if (prefix <= 0) return true;
    const mask = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipValue & mask) === (networkValue & mask);
  }

  /**
   * Does a NetworkPolicy peer (from/to entry) select `targetPod`?
   * @param {object} peer
   * @param {string} peerNamespace namespace the policy lives in (podSelector is scoped to it)
   * @param {object} targetPod
   */
  _peerMatchesPod(peer, peerNamespace, targetPod) {
    if (!peer || typeof peer !== 'object') return false;
    const targetNamespace = targetPod?.metadata?.namespace || 'default';
    if (peer.ipBlock) {
      const podIp = targetPod?.status?.podIP || null;
      if (!podIp) return false;
      if (!this._ipInCidr(podIp, peer.ipBlock.cidr)) return false;
      return !(peer.ipBlock.except || []).some((cidr) => this._ipInCidr(podIp, cidr));
    }
    const hasPodSelector = Boolean(peer.podSelector);
    const hasNamespaceSelector = Boolean(peer.namespaceSelector);
    if (!hasPodSelector && !hasNamespaceSelector) return true; // empty peer: everything
    if (hasNamespaceSelector) {
      if (
        !this._labelSelectorMatches(peer.namespaceSelector, this._namespaceLabels(targetNamespace))
      )
        return false;
    } else if (targetNamespace !== peerNamespace) {
      // A bare podSelector only matches Pods in the policy's own namespace.
      return false;
    }
    if (hasPodSelector)
      return this._labelSelectorMatches(peer.podSelector, targetPod?.metadata?.labels || {});
    return true;
  }

  _rulesAllowTraffic(rules, peerKey, peerNamespace, peerPod, port, protocol, destinationPod) {
    if (!Array.isArray(rules) || rules.length === 0) return false;
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      const peers = rule[peerKey];
      const peersMatch =
        !Array.isArray(peers) ||
        peers.length === 0 ||
        peers.some((peer) => this._peerMatchesPod(peer, peerNamespace, peerPod));
      if (!peersMatch) continue;
      if (!this._networkPolicyPortMatches(rule.ports, port, protocol, destinationPod)) continue;
      return true;
    }
    return false;
  }

  /**
   * Can pod-to-pod traffic flow from `source` to `target`?
   * @param {object|string} sourcePod
   * @param {object|string} target Pod, Service or `{kind,name,namespace}`
   * @param {{port?: number, protocol?: string, namespace?: string}} [options]
   * @returns {{allowed: boolean, reason: string, policy?: string, pods?: object[]}}
   */
  canReach(sourcePod, target, options = {}) {
    const namespace = options.namespace || 'default';
    const source = this._resolvePodLike(sourcePod, namespace);
    if (!source) return { allowed: false, reason: 'source-not-found' };
    const destination = this._resolveTrafficDestination(target, options);
    if (!destination) return { allowed: false, reason: 'target-not-found' };
    if (destination.pods.length === 0) return { allowed: false, reason: 'no-endpoints', pods: [] };
    const requestedPort = Number(options.port ?? destination.port ?? 80);
    const port = Number.isFinite(requestedPort) ? requestedPort : 80;
    const protocol = String(options.protocol || 'TCP').toUpperCase();

    for (const destinationPod of destination.pods) {
      const egressPolicies = this._policiesForPod(source, 'Egress');
      let egressAllowed = egressPolicies.length === 0;
      let blockedBy = null;
      if (!egressAllowed) {
        for (const policy of egressPolicies) {
          if (
            this._rulesAllowTraffic(
              policy.spec?.egress,
              'to',
              policy.metadata.namespace,
              destinationPod,
              port,
              protocol,
              destinationPod
            )
          ) {
            egressAllowed = true;
            break;
          }
          blockedBy = blockedBy || policy.metadata.name;
        }
      }
      if (!egressAllowed)
        return { allowed: false, reason: 'egress', policy: blockedBy, pods: destination.pods };

      const ingressPolicies = this._policiesForPod(destinationPod, 'Ingress');
      let ingressAllowed = ingressPolicies.length === 0;
      blockedBy = null;
      if (!ingressAllowed) {
        for (const policy of ingressPolicies) {
          if (
            this._rulesAllowTraffic(
              policy.spec?.ingress,
              'from',
              policy.metadata.namespace,
              source,
              port,
              protocol,
              destinationPod
            )
          ) {
            ingressAllowed = true;
            break;
          }
          blockedBy = blockedBy || policy.metadata.name;
        }
      }
      if (!ingressAllowed)
        return { allowed: false, reason: 'ingress', policy: blockedBy, pods: destination.pods };
      return { allowed: true, reason: 'allowed', pods: destination.pods };
    }
    return { allowed: false, reason: 'no-endpoints', pods: [] };
  }

  /**
   * DNS resolution requires egress to the dns-default pods in openshift-dns on
   * port 5353 (OpenShift's DNS pods do not listen on 53 — issue #14). When the
   * source Pod is selected by any egress policy, a rule must explicitly allow
   * that traffic or name resolution fails.
   * @param {object|string} sourcePod
   * @returns {{allowed: boolean, reason: string, policy?: string}}
   */
  canResolveDNS(sourcePod) {
    const source = this._resolvePodLike(sourcePod);
    if (!source) return { allowed: false, reason: 'source-not-found' };
    // Resolve against a REAL dns-default Pod (pod-network 10.x address since
    // #58, real daemonset labels) when one is running; fall back to a synthetic
    // Pod while the platform is still booting.
    const dnsPod = this.cluster
      .getByKind('Pod')
      .find(
        (pod) =>
          pod.metadata?.namespace === DNS_NAMESPACE &&
          /^dns-default-/.test(String(pod.metadata?.name || '')) &&
          pod.status?.phase === 'Running'
      ) || {
      metadata: {
        name: 'dns-default',
        namespace: DNS_NAMESPACE,
        labels: { 'dns.operator.openshift.io/daemonset-dns': 'default', app: 'dns-default' },
      },
      status: { podIP: DNS_DEFAULT_SERVICE_IP, phase: 'Running' },
    };
    const egressPolicies = this._policiesForPod(source, 'Egress');
    if (egressPolicies.length === 0) return { allowed: true, reason: 'no-egress-policy' };
    for (const policy of egressPolicies) {
      for (const protocol of ['UDP', 'TCP']) {
        if (
          this._rulesAllowTraffic(
            policy.spec?.egress,
            'to',
            policy.metadata.namespace,
            dnsPod,
            DNS_DEFAULT_SERVICE_TARGET_PORT,
            protocol,
            dnsPod
          )
        ) {
          return { allowed: true, reason: 'dns-egress-allowed', policy: policy.metadata.name };
        }
      }
    }
    return { allowed: false, reason: 'dns-egress', policy: egressPolicies[0]?.metadata.name };
  }

  /** Resolve a pod resource / name / uid used by the evaluators. */
  _resolvePodLike(value, namespace = 'default') {
    if (!value) return null;
    if (typeof value === 'string') {
      return this.cluster.getByName('Pod', value, namespace) || this.cluster.get(value) || null;
    }
    if (value.metadata && value.spec) return value;
    if (value.uid) return this.cluster.get(value.uid);
    return null;
  }

  /** Resolve a `canReach` target into concrete Pods + a port. */
  _resolveTrafficDestination(target, options = {}) {
    const namespace = options.namespace || 'default';
    if (!target) return null;
    if (typeof target === 'object') {
      if (target.kind === 'Service' || target.spec?.selector) {
        const pods = this.cluster.getServiceEndpoints(target);
        const resolvedPort = this._routeBackendPort(
          { spec: { port: { targetPort: options.targetPort } } },
          target,
          pods
        );
        const port = Number(options.port ?? resolvedPort);
        return {
          kind: 'Service',
          name: target.metadata?.name,
          pods,
          port: Number.isFinite(port) ? port : resolvedPort,
        };
      }
      if (target.kind === 'Pod' || (target.metadata && target.spec)) {
        const pod = this._resolvePodLike(target, namespace);
        const port = Number(
          options.port ?? pod?.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 80
        );
        return pod ? { kind: 'Pod', name: pod.metadata.name, pods: [pod], port } : null;
      }
      if (target.kind && target.name) {
        const resource = this.cluster.getByName(
          target.kind,
          target.name,
          target.namespace || namespace
        );
        return resource ? this._resolveTrafficDestination(resource, options) : null;
      }
      return null;
    }

    let host = String(target).trim();
    if (!host) return null;
    host = host.replace(/^https?:\/\//, '').split('/')[0];
    let port = options.port !== undefined ? Number(options.port) : undefined;
    const portMatch = host.match(/^(.*):(\d+)$/);
    if (portMatch) {
      host = portMatch[1];
      if (port === undefined) port = Number(portMatch[2]);
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      const pod = this.cluster.getByKind('Pod').find((entry) => entry.status?.podIP === host);
      if (pod) {
        return {
          kind: 'Pod',
          name: pod.metadata.name,
          pods: [pod],
          port: port ?? 80,
          host,
          requiresDNS: false,
        };
      }
      // A Service ClusterIP is a virtual IP: `curl http://<clusterIP>:<port>`
      // from a Pod is routed by kube-proxy to the Service's ready endpoints, so
      // it must work without DNS (issue #59).
      const clusterIPService = this.cluster
        .getByKind('Service')
        .find((service) => serviceClusterIPs(service).includes(host));
      if (clusterIPService) {
        const pods = this.cluster.getServiceEndpoints(clusterIPService);
        const resolvedPort = this._routeBackendPort(
          { spec: { port: { targetPort: options.targetPort } } },
          clusterIPService,
          pods
        );
        const numericPort = Number(port ?? resolvedPort);
        return {
          kind: 'Service',
          name: clusterIPService.metadata.name,
          namespace: clusterIPService.metadata.namespace,
          pods,
          port: Number.isFinite(numericPort) ? numericPort : 80,
          host,
          requiresDNS: false,
        };
      }
      return { kind: 'IP', name: host, pods: [], port: port ?? 80, host, requiresDNS: false };
    }
    const svcMatch = host.match(
      /^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?$/i
    );
    const serviceName = svcMatch ? svcMatch[1] : host;
    const serviceNamespace = svcMatch && svcMatch[2] ? svcMatch[2] : namespace;
    const service = this.cluster.getByName('Service', serviceName, serviceNamespace);
    if (service) {
      const pods = this.cluster.getServiceEndpoints(service);
      const resolvedPort = this._routeBackendPort(
        { spec: { port: { targetPort: options.targetPort } } },
        service,
        pods
      );
      const numericPort = Number(port ?? resolvedPort);
      return {
        kind: 'Service',
        name: serviceName,
        namespace: serviceNamespace,
        pods,
        port: Number.isFinite(numericPort) ? numericPort : 80,
        host,
        requiresDNS: true,
      };
    }
    // Unresolvable/external host: name resolution is required and egress
    // policies around ipBlock decide reachability.
    return { kind: 'External', name: host, pods: [], port: port ?? 80, host, requiresDNS: true };
  }

  /**
   * Evaluate `oc exec <pod> -- curl <target>` against the cluster's
   * NetworkPolicies and return display-ready output lines.
   *
   * @param {object|string} sourcePod
   * @param {{target: string, namespace?: string, port?: number, protocol?: string}} options
   * @returns {{allowed: boolean, reason: string, policy: string|null, lines: string[]}}
   */
  trafficForExec(sourcePod, options = {}) {
    const namespace = options.namespace || 'default';
    const source = this._resolvePodLike(sourcePod, namespace);
    if (!source) {
      return {
        allowed: false,
        reason: 'source-not-found',
        policy: null,
        lines: ['error: unable to resolve the source Pod'],
      };
    }
    // Loopback / own-Pod-IP targets hit the pod's OWN container app (issue #54d):
    // `oc exec <pod> -- curl -s localhost:8080` must return the real app body,
    // not the generic external "Hello from the Internet" page.
    const localDestination = this._localExecDestination(source, options);
    if (localDestination && !localDestination.listening) {
      return {
        allowed: false,
        reason: 'local-connection-refused',
        policy: null,
        lines: [
          `curl: (7) Failed to connect to ${localDestination.host} port ${localDestination.port} after 0 ms: Connection refused`,
        ],
      };
    }
    if (localDestination) {
      return {
        allowed: true,
        reason: 'local',
        policy: null,
        lines: [localDestination.body],
      };
    }
    // In-cluster Kubernetes API request (`curl https://kubernetes.default.svc/…`
    // from inside a Pod, issue #76 L16): the API server answers, not the
    // generic external Hello page.
    const clusterApi = this._clusterApiExecResponse(source, options);
    if (clusterApi) return clusterApi;
    const destination = this._resolveTrafficDestination(options.target, { ...options, namespace });
    if (!destination) {
      return {
        allowed: false,
        reason: 'target-not-found',
        policy: null,
        lines: [`curl: (6) Could not resolve host: ${String(options.target || '')}`],
      };
    }
    const host = destination.host || destination.name || String(options.target || '');
    const port = Number(options.port ?? destination.port ?? 80);

    if (destination.requiresDNS) {
      const dns = this.canResolveDNS(source);
      if (!dns.allowed) {
        return {
          allowed: false,
          reason: 'dns-egress',
          policy: dns.policy || null,
          lines: [`curl: (6) Could not resolve host: ${host}`],
        };
      }
    }
    if (destination.kind === 'External') {
      // External traffic is only blocked by an egress policy that has no
      // matching ipBlock rule; the simulator has no external IPs, so treat an
      // egress-isolated Pod as blocked.
      const egressPolicies = this._policiesForPod(source, 'Egress');
      if (egressPolicies.length > 0) {
        return {
          allowed: false,
          reason: 'egress',
          policy: egressPolicies[0]?.metadata?.name || null,
          lines: [
            `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection timed out`,
          ],
        };
      }
      return {
        allowed: true,
        reason: 'external',
        policy: null,
        lines: ['<html><body>Hello from the Internet (container main)</body></html>'],
      };
    }
    if (destination.pods.length === 0) {
      return {
        allowed: false,
        reason: 'no-endpoints',
        policy: null,
        lines: [
          `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`,
        ],
      };
    }
    // The destination is already resolved to concrete Pods; evaluate against
    // the first endpoint (all endpoints of a Service share the selector rules).
    const reach = this.canReach(source, destination.pods[0], {
      port,
      protocol: options.protocol || 'TCP',
      namespace: destination.namespace || namespace,
    });
    if (!reach.allowed) {
      return {
        allowed: false,
        reason: reach.reason,
        policy: reach.policy || null,
        lines: [
          `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`,
        ],
      };
    }
    const destinationPod = reach.pods?.[0] || destination.pods[0];
    const app = destinationPod?.metadata?.labels?.app || destinationPod?.metadata?.name || host;
    const container = destinationPod?.spec?.containers?.[0]?.name || 'main';
    return {
      allowed: true,
      reason: 'allowed',
      policy: null,
      lines: [`<html><body>Hello from ${app} (container ${container})</body></html>`],
    };
  }

  /**
   * Model an in-cluster request to the Kubernetes API server from inside a Pod
   * (issue #76 L16):
   *
   *   oc exec deploy/api -- sh -c 'curl -sk -H "Authorization: Bearer $(cat
   *     /var/run/secrets/kubernetes.io/serviceaccount/token)" \
   *     https://kubernetes.default.svc/api/v1/namespaces/sa-lab/pods'
   *
   * honours the bearer token's ServiceAccount identity and the cluster RBAC: an
   * authorised list returns a real `PodList` JSON body (curl exit 0), an
   * unauthorised one returns the 403 `Status` JSON with the API server's
   * message (`pods is forbidden: User "system:serviceaccount:<ns>:<sa>" cannot
   * list resource "pods" in API group "" in the namespace "<ns>"`). A request
   * without a token is anonymous; a malformed token is 401 Unauthorized.
   *
   * @param {object} source source Pod
   * @param {{target?: string, scheme?: string, port?: number, path?: string,
   *   headers?: object}} options
   * @returns {object|null} trafficForExec-shaped response, or null when the
   *   target is not the in-cluster API server
   */
  _clusterApiExecResponse(source, options = {}) {
    const raw = String(options.target || '')
      .trim()
      .toLowerCase();
    if (!raw) return null;
    const host = raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split('/')[0]
      .split(':')[0];
    if (!CLUSTER_API_HOSTS.has(host)) return null;
    const scheme = String(options.scheme || 'https').toLowerCase();
    const port = options.port === undefined || options.port === null ? 443 : Number(options.port);
    const requestPath = String(options.path || '/') || '/';
    if (scheme !== 'https' || port !== 443) {
      // The API server only listens on 6443 (exposed as 443); a plain-HTTP or
      // wrong-port request is a connection refusal, like any other Service.
      return {
        allowed: false,
        reason: 'connection-refused',
        policy: null,
        lines: [
          `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Connection refused`,
        ],
      };
    }
    const headers = options.headers || {};
    const headerValue = (name) => {
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === name) return String(value ?? '');
      }
      return '';
    };
    let userName = 'system:anonymous';
    const authHeader = headerValue('authorization');
    if (authHeader) {
      const bearer = authHeader.match(/^Bearer\s+(\S+)$/i);
      const subject = bearer ? this._decodeServiceAccountToken(bearer[1]) : null;
      if (!subject) {
        return this._apiStatusExecResponse(401, 'Unauthorized', 'Unauthorized');
      }
      userName = subject;
    }

    // Discovery/health endpoints a Pod may probe with curl.
    if (requestPath === '/healthz' || requestPath === '/readyz' || requestPath === '/livez') {
      return {
        allowed: true,
        reason: 'in-cluster-api',
        policy: null,
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        lines: ['ok'],
      };
    }
    if (requestPath === '/version') {
      return {
        allowed: true,
        reason: 'in-cluster-api',
        policy: null,
        status: 200,
        headers: { 'content-type': 'application/json' },
        lines: [
          JSON.stringify({
            major: '1',
            minor: '35',
            gitVersion: 'v1.35.2',
            gitCommit: '0000000000000000000000000000000000000000',
            gitTreeState: 'clean',
            buildDate: '2026-10-20T00:00:00Z',
            goVersion: 'go1.24.6',
            compiler: 'gc',
            platform: 'linux/amd64',
          }),
        ],
      };
    }

    const parsed = this._parseApiRequestPath(requestPath);
    if (!parsed) {
      return this._apiStatusExecResponse(
        404,
        'NotFound',
        'the server could not find the requested resource',
        {}
      );
    }
    const { namespace, resource, name } = parsed;
    if (!namespace) {
      // Only the resources the L16 diagnostic needs are modelled for
      // cluster-scoped requests.
      const window = name ? `${resource} "${name}"` : resource;
      const verb = name ? 'get' : 'list';
      return this._apiStatusExecResponse(
        403,
        'Forbidden',
        `${window} is forbidden: User "${userName}" cannot ${verb} resource "${resource}" ` +
          'in API group "" at the cluster scope',
        { kind: resource, ...(name ? { name } : {}) }
      );
    }
    const verb = name ? 'get' : 'list';
    const permission = this.cluster.canI(userName, verb, resource, namespace);
    if (!permission.allowed) {
      const window = name ? `${resource} "${name}"` : resource;
      const message =
        `${window} is forbidden: User "${userName}" cannot ${verb} resource "${resource}" ` +
        `in API group "" in the namespace "${namespace}"`;
      return this._apiStatusExecResponse(403, 'Forbidden', message, {
        kind: resource,
        ...(name ? { name } : {}),
      });
    }
    if (name) {
      const object = this._apiObjectByName(resource, name, namespace);
      if (!object) {
        return this._apiStatusExecResponse(404, 'NotFound', `${resource} "${name}" not found`, {
          kind: resource,
          name,
        });
      }
      return this._apiJsonExecResponse(object);
    }
    const list = this._apiListForResource(resource, namespace);
    if (!list) {
      return this._apiStatusExecResponse(
        404,
        'NotFound',
        'the server could not find the requested resource',
        { kind: resource }
      );
    }
    return this._apiJsonExecResponse(list);
  }

  /** Parse an API request path into `{namespace, resource, name}` (or null). */
  _parseApiRequestPath(requestPath) {
    const path = String(requestPath || '').split('?')[0];
    // Core group, namespaced: /api/v1/namespaces/<ns>/<resource>[/<name>]
    let match = path.match(/^\/api\/v1\/namespaces\/([^/]+)\/([a-z0-9]+)(?:\/([^/]+))?\/?$/);
    if (match) {
      return { namespace: match[1], resource: match[2], name: match[3] || '' };
    }
    // Core group, cluster-scoped: /api/v1/<resource>[/<name>]
    match = path.match(/^\/api\/v1\/([a-z0-9]+)(?:\/([^/]+))?\/?$/);
    if (match) {
      return { namespace: '', resource: match[1], name: match[2] || '' };
    }
    // Named API group, namespaced: /apis/<group>/<version>/namespaces/<ns>/<resource>[/<name>]
    match = path.match(/^\/apis\/[^/]+\/[^/]+\/namespaces\/([^/]+)\/([a-z0-9]+)(?:\/([^/]+))?\/?$/);
    if (match) {
      return { namespace: match[1], resource: match[2], name: match[3] || '' };
    }
    // Named API group, cluster-scoped: /apis/<group>/<version>/<resource>[/<name>]
    match = path.match(/^\/apis\/[^/]+\/[^/]+\/([a-z0-9]+)(?:\/([^/]+))?\/?$/);
    if (match) {
      return { namespace: '', resource: match[1], name: match[2] || '' };
    }
    return null;
  }

  /**
   * Validate a bound service-account token JWT and return its SA user name, or
   * null when the token is not a real API-server credential.
   *
   * A real API server rejects an invalid/unknown/forged token with 401
   * Unauthorized (NOT 403): the missing-token path is different — an
   * unauthenticated request is authenticated as `system:anonymous` and then
   * denied by RBAC with 403 (issue #76 L16). Validation checks the RS256
   * header, the bound-token claims every projected token carries
   * (aud/iss/exp/kubernetes pod+SA identity), a plausible signature segment and
   * that the ServiceAccount still exists.
   * @param {string} token
   * @returns {string|null}
   */
  _decodeServiceAccountToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    try {
      const header = JSON.parse(decodeBase64UrlText(parts[0]));
      if (String(header?.alg || '') !== 'RS256') return null;
      const payload = JSON.parse(decodeBase64UrlText(parts[1]));
      const subject = String(payload?.sub || '');
      const match = subject.match(/^system:serviceaccount:([^:]+):(.+)$/);
      if (!match) return null;
      const [, namespace, name] = match;
      const audience = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
      if (!audience.includes('https://kubernetes.default.svc')) return null;
      if (payload?.iss !== 'https://kubernetes.default.svc') return null;
      if (!Number.isFinite(Number(payload?.exp))) return null;
      const kubernetes = payload?.kubernetes || {};
      if (String(kubernetes.namespace || '') !== namespace) return null;
      if (String(kubernetes.serviceaccount?.name || '') !== name) return null;
      if (!kubernetes.pod?.name) return null;
      // RS256 signatures are long, base64url and non-empty; a truncated or
      // fabricated signature is not a credential.
      if (!/^[A-Za-z0-9_-]{100,}$/.test(String(parts[2]))) return null;
      // The token must belong to a ServiceAccount that still exists.
      if (!this.cluster.getByName('ServiceAccount', name, namespace)) return null;
      return subject;
    } catch {
      return null;
    }
  }

  /** ShellTools-shaped JSON body response for the in-cluster API model. */
  _apiJsonExecResponse(object) {
    return {
      allowed: true,
      reason: 'in-cluster-api',
      policy: null,
      status: 200,
      headers: { 'content-type': 'application/json' },
      lines: [JSON.stringify(object)],
    };
  }

  /** ShellTools-shaped API `Status` body (403/404/401 …); curl still exits 0. */
  _apiStatusExecResponse(code, reason, message, details = {}) {
    return {
      allowed: true,
      reason: 'in-cluster-api',
      policy: null,
      status: code,
      headers: { 'content-type': 'application/json' },
      lines: [
        JSON.stringify({
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message,
          reason,
          details,
          code,
        }),
      ],
    };
  }

  /** API object for a named resource the simulated API server serves over REST. */
  _apiObjectByName(resource, name, namespace) {
    const kind = API_EXEC_RESOURCE_KINDS[resource];
    if (!kind) return null;
    const object = this.cluster.getByName(kind, name, namespace);
    if (!object) return null;
    return this._apiSerialise(kind, object);
  }

  /** API list object (`PodList`, `ServiceList`, …) for a namespaced resource. */
  _apiListForResource(resource, namespace) {
    const kind = API_EXEC_RESOURCE_KINDS[resource];
    if (!kind) return null;
    const items = this.cluster
      .getByKindAndNamespace(kind, namespace)
      .slice()
      .sort((left, right) =>
        String(left.metadata?.name || '').localeCompare(String(right.metadata?.name || ''))
      )
      .map((object) => this._apiSerialise(kind, object));
    const resourceVersion = items.reduce(
      (max, item) => Math.max(max, parseInt(item.metadata?.resourceVersion, 10) || 0),
      0
    );
    return {
      kind: `${kind}List`,
      apiVersion: 'v1',
      metadata: { resourceVersion: String(resourceVersion || 1) },
      items,
    };
  }

  /**
   * Serialise a resource the way the real API server returns it: metadata +
   * spec + status, no game-only fields. Secrets keep their base64 data.
   */
  _apiSerialise(kind, object) {
    const metadata = {
      name: object.metadata?.name || '',
      namespace: object.metadata?.namespace || '',
      uid: object.uid || object.metadata?.uid || '',
      resourceVersion: String(object.metadata?.resourceVersion || '1'),
      creationTimestamp: object.metadata?.creationTimestamp || null,
      labels: deepClone(object.metadata?.labels || {}),
    };
    if (kind === 'Pod') {
      const containers = (object.spec?.containers || []).map((container) => ({
        name: container.name || 'main',
        image: container.image || '',
        ports: deepClone(container.ports || []),
        ...(container.env ? { env: deepClone(container.env) } : {}),
      }));
      return {
        metadata,
        spec: {
          containers,
          restartPolicy: object.spec?.restartPolicy || 'Always',
          serviceAccountName: object.spec?.serviceAccountName || 'default',
          nodeName: object.spec?.nodeName || '',
        },
        status: {
          phase: object.status?.phase || 'Pending',
          podIP: object.status?.podIP || undefined,
          hostIP: object.status?.hostIP || undefined,
          conditions: deepClone(object.status?.conditions || []),
          containerStatuses: deepClone(object.status?.containerStatuses || []),
        },
      };
    }
    return {
      metadata,
      spec: deepClone(object.spec || {}),
      status: deepClone(object.status || {}),
    };
  }

  // ── Router traffic + workstation curl (issues #32c, #33a, #33b) ────────
  //
  // A workstation `curl` resolves `<route>-<project>.apps.<domain>` through
  // the router. Admission only asks "does the Service have endpoints?", so a
  // Route can be Admitted=True while the router is blocked by the project's
  // NetworkPolicies — exactly the default-deny lesson (#33b). Router traffic is
  // evaluated as a synthetic `openshift-ingress` Pod, which is how the
  // `policy-group.network.openshift.io/ingress: ""` namespace selector works.

  /** Synthetic router Pod in `openshift-ingress` (source of Route traffic). */
  _routerPod() {
    return {
      metadata: {
        name: 'router-default-6b8f7c9d4-abcde',
        namespace: ROUTER_NAMESPACE,
        labels: { app: 'router', 'ingress.operator.openshift.io/default-router': 'true' },
      },
      spec: {
        containers: [
          {
            name: 'router',
            image: 'quay.io/openshift/origin-haproxy-router:4.22',
            ports: [
              { containerPort: 80, protocol: 'TCP' },
              { containerPort: 443, protocol: 'TCP' },
            ],
          },
        ],
      },
      status: { podIP: ROUTER_DEFAULT_IP, phase: 'Running' },
    };
  }

  /** Resolve a Route object / name / `{kind:'Route', name, namespace}` ref. */
  _resolveRouteLike(routeOrTarget, options = {}) {
    if (!routeOrTarget) return null;
    if (typeof routeOrTarget === 'string') {
      const namespace = options.namespace;
      if (namespace) return this.cluster.getByName('Route', routeOrTarget, namespace);
      return (
        this.cluster.getByKind('Route').find((route) => route.metadata?.name === routeOrTarget) ||
        null
      );
    }
    if (routeOrTarget.kind && routeOrTarget.kind !== 'Route') return null;
    if (routeOrTarget.metadata?.name && (routeOrTarget.spec || routeOrTarget.kind === 'Route')) {
      return routeOrTarget;
    }
    const name = routeOrTarget.name || routeOrTarget.metadata?.name;
    if (!name) return null;
    const namespace =
      routeOrTarget.namespace || routeOrTarget.metadata?.namespace || options.namespace;
    if (namespace) return this.cluster.getByName('Route', name, namespace);
    return this.cluster.getByKind('Route').find((route) => route.metadata?.name === name) || null;
  }

  /** Numeric container port behind a Route's Service (resolves named ports). */
  _routeBackendPort(route, service, pods) {
    const requested = route?.spec?.port?.targetPort;
    const servicePorts = service?.spec?.ports || [];
    let servicePort = null;
    if (requested !== undefined && requested !== null && requested !== '') {
      servicePort =
        servicePorts.find(
          (port) =>
            port.name === requested ||
            String(port.port) === String(requested) ||
            String(port.targetPort) === String(requested)
        ) || null;
    }
    servicePort = servicePort || servicePorts[0] || null;
    let target = servicePort?.targetPort ?? requested ?? servicePort?.port ?? 80;
    if (typeof target === 'string' && !/^\d+$/.test(target)) {
      const namedServicePort = servicePorts.find((port) => port.name === target);
      if (namedServicePort) target = namedServicePort.port;
    }
    if (typeof target === 'string' && !/^\d+$/.test(target)) {
      for (const pod of pods || []) {
        for (const container of pod?.spec?.containers || []) {
          const match = (container.ports || []).find((port) => port.name === target);
          if (match) return Number(match.containerPort);
        }
      }
    }
    const numeric = Number(target);
    return Number.isFinite(numeric) ? numeric : 80;
  }

  /**
   * Can the router reach a Route's backend? (issue #33b)
   *
   * Route admission only checks that the Service has ready endpoints. Traffic
   * additionally has to pass the project's NetworkPolicies, evaluated with the
   * router as the source Pod: after a default-deny, a Route stays Admitted but
   * connection attempts fail until an ingress policy allows the router
   * namespace (`namespaceSelector: matchLabels: policy-group.network.openshift.io/ingress: ""`).
   *
   * @param {object|string} routeOrTarget Route object, Route name, or `{kind:'Route',name,namespace}`
   * @param {{namespace?: string}} [options]
   * @returns {{allowed: boolean, reason: string, policy: string|null, route: object|null,
   *   service: object|null, pods: object[], port: number, termination: string|null}}
   */
  canRouterReach(routeOrTarget, options = {}) {
    const route = this._resolveRouteLike(routeOrTarget, options);
    if (!route) {
      return {
        allowed: false,
        reason: 'route-not-found',
        policy: null,
        route: null,
        service: null,
        pods: [],
        port: 0,
        termination: null,
      };
    }
    const termination = route.spec?.tls?.termination || null;
    const service = this.cluster.getRouteService(route);
    const base = {
      allowed: false,
      reason: '',
      policy: null,
      route,
      service,
      pods: [],
      port: 0,
      termination,
    };
    if (!this.cluster.isRouteAdmitted(route)) return { ...base, reason: 'route-not-admitted' };
    if (!service) return { ...base, reason: 'service-not-found' };
    const pods = this.cluster.getServiceEndpoints(service);
    const port = this._routeBackendPort(route, service, pods);
    if (!pods.length) return { ...base, pods, port, reason: 'no-endpoints' };
    const reach = this.canReach(this._routerPod(), pods[0], {
      port,
      protocol: 'TCP',
      namespace: route.metadata.namespace,
    });
    return {
      allowed: reach.allowed,
      reason: reach.allowed ? 'allowed' : reach.reason,
      policy: reach.policy || null,
      route,
      service,
      pods: reach.pods?.length ? reach.pods : pods,
      port,
      termination,
    };
  }

  /** Default router wildcard certificate (`*.apps.<cluster domain>`). */
  _routerDefaultCertificateInfo() {
    if (!this._routerDefaultCertificateInfoCache) {
      const material = createSelfSignedCertificate({
        commonName: `*.${APPS_DOMAIN}`,
        organization: 'OpenShift',
        days: 365,
      });
      this._routerDefaultCertificateInfoCache = material.info;
    }
    return this._routerDefaultCertificateInfoCache;
  }

  /** Serialisable view of the TLS certificate presented to a curl client. */
  _certificateView(info, options = {}) {
    if (!info) return null;
    const subjectJson = JSON.stringify(info.subject || {});
    const issuerJson = JSON.stringify(info.issuer || {});
    return {
      commonName: info.commonName || '',
      sans: [...(info.sans || [])],
      subject: info.subject || {},
      issuer: info.issuer || {},
      selfSigned: subjectJson === issuerJson,
      trusted:
        options.trusted === undefined
          ? String(info.issuerCommonName || '') === 'service-ca'
          : options.trusted,
      notAfter: info.notAfter || null,
    };
  }

  /** Serving certificate of a Service (the service-ca secret), if present. */
  _servingCertificateInfo(service) {
    const secretName = service?.metadata?.annotations?.[SERVING_CERT_ANNOTATION];
    if (!secretName) return null;
    const secret = this.cluster.getByName('Secret', secretName, service.metadata.namespace);
    if (!secret) return null;
    const data = secret.spec?.data || secret.data || {};
    const pem = base64DecodeText(data['tls.crt'] || '');
    if (!pem) return null;
    return parseCertificatePem(pem);
  }

  _routerResponseHeaders(body) {
    // The router's error page is an HAProxy errorfile sent verbatim: exactly
    // its own header block (no Date/Server/Content-Length), 1.16.0.
    if (body === ROUTER_503_BODY) {
      return {
        pragma: 'no-cache',
        'cache-control': 'private, max-age=0, no-cache, no-store',
        connection: 'close',
        'content-type': 'text/html',
      };
    }
    return {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(String(body ?? '').length),
      date: new Date().toUTCString(),
      server: 'haproxy',
    };
  }

  /**
   * Find the Route serving `host` + `requestPath` (longest matching path wins,
   * like the HAProxy router).
   */
  _routeForHost(host, requestPath = '/') {
    const targetHost = String(host || '').toLowerCase();
    const candidates = this.cluster
      .getByKind('Route')
      .filter(
        (route) => String(this.cluster.getRouteHost(route) || '').toLowerCase() === targetHost
      );
    if (!candidates.length) return null;
    const matched = candidates.filter((route) => {
      const prefix = String(route.spec?.path || '');
      if (!prefix || prefix === '/') return true;
      const cleanPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
      return requestPath === prefix || requestPath.startsWith(cleanPrefix);
    });
    const pool = matched.length ? matched : candidates;
    return pool.sort(
      (left, right) => String(right.spec?.path || '').length - String(left.spec?.path || '').length
    )[0];
  }

  /** Response body for a successful Route request (the backend workload). */
  _workloadHttpBody(service, pod) {
    return this._podHttpBody(pod, { fallbackApp: service?.metadata?.name });
  }

  /**
   * HTTP body served by a Pod's container. Uses the real image personality
   * (origin-hello-openshift / nginx) and the Pod's ACTUAL container name, never
   * a hardcoded `main` — issue #54d (`oc exec … -- curl localhost:8080` must
   * return the app's real response from the pod's own container).
   * @param {object|null} pod
   * @param {{container?: object, fallbackApp?: string}} [options]
   * @returns {string}
   */
  _podHttpBody(pod, options = {}) {
    const container = options.container || pod?.spec?.containers?.[0] || {};
    const image = String(container.image || '');
    const app = pod?.metadata?.labels?.app || options.fallbackApp || pod?.metadata?.name || 'app';
    if (/hello-openshift/.test(image)) {
      // The real origin hello-openshift handler is `fmt.Fprintln(w, "Hello
      // OpenShift!")`: a plain-text body with a trailing newline, never HTML
      // (issue #76).
      return 'Hello OpenShift!\n';
    }
    if (/nginx/.test(image)) {
      return (
        '<html><body><h1>Welcome to nginx!</h1>\n' +
        '<p>If you see this page, the nginx web server is successfully installed and working.</p>' +
        '</body></html>'
      );
    }
    return `<html><body>Hello from ${app} (container ${container.name || 'main'})</body></html>`;
  }

  /**
   * Resolve `curl <target>` executed INSIDE a Pod to the pod's own container
   * when the target is loopback / the pod's own IP (issue #54d): `localhost`,
   * `127.0.0.1`, `::1`, or `status.podIP` / `status.hostIP`. Returns null for
   * anything else so external hosts keep the normal traffic model.
   * @param {object} source pod resolved by `_resolvePodLike`
   * @param {{target?: string, port?: number, container?: string}} options
   * @returns {{kind: string, local: boolean, name: string, pods: object[],
   *   port: number, host: string, requiresDNS: boolean, body: string,
   *   listening: boolean}|null}
   */
  _localExecDestination(source, options = {}) {
    if (!source) return null;
    let raw = String(options.target || '')
      .trim()
      .toLowerCase();
    if (!raw) return null;
    raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
    let hostPart = raw;
    let targetPort = null;
    const portMatch = raw.match(/^(\[[0-9a-f:]+\]|[^:]+):(\d+)$/);
    if (portMatch) {
      hostPart = portMatch[1];
      targetPort = Number(portMatch[2]);
    }
    const bareHost = hostPart.replace(/^\[|\]$/g, '');
    const ownAddresses = [source.status?.podIP, source.status?.hostIP]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    const loopback = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
    if (!loopback.includes(bareHost) && !ownAddresses.includes(bareHost)) return null;

    const containers = source.spec?.containers || [];
    const requested = Number(options.port ?? targetPort ?? 0);
    // The container is the one declaring the port the app listens on; fall back
    // to the explicit container name (from the workload template) or the first.
    let container = options.container
      ? containers.find((entry) => entry.name === options.container)
      : null;
    let listening = true;
    if (!container) {
      const declared = containers.find((entry) =>
        (entry.ports || []).some((port) => Number(port.containerPort) === requested)
      );
      if (declared) container = declared;
    }
    if (!container && containers.length > 0) {
      const anyDeclared = containers.some((entry) => (entry.ports || []).length > 0);
      container = containers[0];
      // A loopback request to a port the container does not declare is a real
      // connection refusal (e.g. `curl localhost:9999`).
      if (requested && anyDeclared) {
        listening = containers.some((entry) =>
          (entry.ports || []).some((port) => Number(port.containerPort) === requested)
        );
      }
    }
    const port =
      requested || Number(containers[0]?.ports?.[0]?.containerPort) || Number(options.port) || 80;
    return {
      kind: 'Pod',
      local: true,
      name: source.metadata?.name || 'pod',
      pods: [source],
      port,
      host: bareHost,
      requiresDNS: false,
      listening,
      body: this._podHttpBody(source, { container: container || undefined }),
    };
  }

  /**
   * Does a passthrough Route's backend actually terminate TLS on the routed
   * port? TLS passthrough is a raw TCP splice: a plain-HTTP backend answers the
   * ClientHello with HTTP bytes and the client's handshake fails (issue #75
   * L12). Signals, in order:
   *   - the Service carries a service-ca serving certificate annotation
   *     (`service.beta.openshift.io/serving-cert-secret-name`), so it is a real
   *     TLS endpoint; or
   *   - an endpoint container exposes a port named `https`/`tls` (e.g. nginx on
   *     containerPort 8443), the deterministic TLS-capable fixture.
   * @param {object} service
   * @param {object[]} [pods] resolved endpoints
   * @returns {boolean}
   */
  _backendServesTls(service, pods = []) {
    if (this._servingCertificateInfo(service)) return true;
    for (const pod of pods || []) {
      for (const container of pod?.spec?.containers || []) {
        for (const port of container?.ports || []) {
          if (/^(https|tls)(-|$)/i.test(String(port?.name || ''))) return true;
        }
      }
    }
    return false;
  }

  /**
   * Workstation `curl` against a Route (issue #32c): resolve the host to a
   * Route, apply edge/passthrough/re-encrypt TLS + the http→https redirect
   * policy, then evaluate router→backend NetworkPolicy reachability (#33b).
   *
   * @param {string} rawUrl
   * @param {{method?: string, insecure?: boolean}} [options]
   * @returns {{error?: {code: number, message: string}, scheme?: string, host?: string,
   *   port?: number, path?: string, status?: number, statusText?: string,
   *   headers?: object, body?: string, location?: string,
   *   serverCert?: object|null, route?: string, routeNamespace?: string,
   *   termination?: string|null, reason?: string, policy?: string|null,
   *   targetPort?: number, serverIp?: string}}
   */
  trafficForWorkstationCurl(rawUrl, options = {}) {
    const parsed = parseHttpUrl(rawUrl);
    if (!parsed) {
      return { error: { code: 3, message: 'URL rejected: Malformed input to a URL function' } };
    }
    if (!['http', 'https'].includes(parsed.scheme)) {
      return { error: { code: 1, message: `Protocol "${parsed.scheme}" not supported` } };
    }
    const scheme = parsed.scheme;
    const host = String(parsed.hostname || '').toLowerCase();
    const method = String(options.method || 'GET').toUpperCase();
    const expectedPort = scheme === 'https' ? 443 : 80;
    const port = parsed.port ? Number(parsed.port) : expectedPort;
    const requestPath = parsed.path || '/';
    const base = { scheme, host, port, path: requestPath, method };
    if (port !== expectedPort) {
      return {
        error: {
          code: 7,
          message: `Failed to connect to ${host} port ${port} after 0 ms: Connection refused`,
        },
      };
    }

    const route = this._routeForHost(host, requestPath);
    if (!route) {
      const routerDomain = String(APPS_DOMAIN).toLowerCase();
      const isRouterHost = host === routerDomain || host.endsWith(`.${routerDomain}`);
      if (!isRouterHost) {
        return { error: { code: 6, message: `Could not resolve host: ${host}` } };
      }
      const result = {
        ...base,
        status: 503,
        statusText: 'Service Unavailable',
        headers: this._routerResponseHeaders(ROUTER_503_BODY),
        body: method === 'HEAD' ? '' : ROUTER_503_BODY,
        reason: 'no-route',
      };
      if (scheme === 'https') {
        result.serverCert = this._certificateView(this._routerDefaultCertificateInfo(), {
          trusted: true,
        });
      }
      return result;
    }

    const tls = route.spec?.tls || null;
    const termination = tls?.termination || null;
    const insecurePolicy = String(tls?.insecureEdgeTerminationPolicy || 'None').toLowerCase();
    const routeBase = {
      ...base,
      host: this.cluster.getRouteHost(route),
      route: route.metadata.name,
      routeNamespace: route.metadata.namespace,
      termination,
    };
    // No backend for this scheme/host/path: the router's default backend
    // answers 503 with its own error page (see ROUTER_503_BODY).
    const respond404 = (reason) => ({
      ...routeBase,
      status: 503,
      statusText: 'Service Unavailable',
      headers: this._routerResponseHeaders(ROUTER_503_BODY),
      body: method === 'HEAD' ? '' : ROUTER_503_BODY,
      reason,
    });
    const respond503 = (reason, policy = null) => ({
      ...routeBase,
      status: 503,
      statusText: 'Service Unavailable',
      headers: this._routerResponseHeaders(ROUTER_503_BODY),
      body: method === 'HEAD' ? '' : ROUTER_503_BODY,
      reason,
      policy,
    });

    let serverCert = null;
    if (scheme === 'http') {
      if (termination === 'edge' || termination === 'reencrypt') {
        if (insecurePolicy === 'redirect') {
          const location = `https://${host}${requestPath}`;
          const body = `<html><body>Redirecting to ${location}</body></html>`;
          return {
            ...routeBase,
            status: 302,
            statusText: 'Found',
            headers: { location, 'content-length': String(body.length) },
            location,
            body: method === 'HEAD' ? '' : body,
            reason: 'redirect-to-https',
          };
        }
        if (insecurePolicy !== 'allow') return respond404('insecure-policy-none');
      } else if (termination === 'passthrough') {
        // The router cannot route plain HTTP for a passthrough Route (no
        // insecure listener, and it cannot read the payload to route it).
        return respond404('passthrough-http');
      }
    } else if (termination === 'passthrough') {
      // TLS passthrough gives the client a raw TCP splice to the backend — if
      // the backend is not actually a TLS server the handshake fails later.
      // The certificate is resolved after the backend checks below.
      serverCert = null;
    } else if (termination === 'edge' || termination === 'reencrypt') {
      const configured = tls?.certificate ? parseCertificatePem(tls.certificate) : null;
      serverCert = configured
        ? this._certificateView(configured)
        : this._certificateView(this._routerDefaultCertificateInfo(), { trusted: true });
    } else {
      // HTTPS against a plain HTTP Route: the router falls back to its default
      // certificate and has no TLS route mapping for the host.
      const result = respond404('no-tls-route');
      result.serverCert = this._certificateView(this._routerDefaultCertificateInfo(), {
        trusted: true,
      });
      return result;
    }

    if (!this.cluster.isRouteAdmitted(route)) return respond503('no-endpoints');
    const service = this.cluster.getRouteService(route);
    if (!service) return respond503('service-not-found');
    const pods = this.cluster.getServiceEndpoints(service);
    if (!pods.length) return respond503('no-endpoints');
    if (termination === 'reencrypt') {
      // Re-encrypt needs to verify the backend TLS certificate: either the
      // Route's destinationCACertificate or (when omitted) the cluster service
      // CA, which means the backend must present a service-ca serving cert.
      if (tls?.destinationCACertificate) {
        const caInfo = parseCertificatePem(tls.destinationCACertificate);
        if (!caInfo || !caInfo.isCA) return respond503('bad-destination-ca');
      }
      if (!this._servingCertificateInfo(service)) return respond503('backend-tls-verify');
    }
    if (termination === 'passthrough') {
      // A passthrough Route to a plain-HTTP backend fails the TLS handshake at
      // the client: HAProxy just proxies the ClientHello/response bytes, so
      // curl reports the OpenSSL "wrong version number" TLS error (issue #75
      // L12). Exact contract rendered by ShellTools: `curl: (35)
      // error:0A00010B:SSL routines::wrong version number` (exit code 35).
      if (!this._backendServesTls(service, pods)) {
        return {
          error: { code: 35, message: 'error:0A00010B:SSL routines::wrong version number' },
          scheme,
          host: routeBase.host,
          port,
          path: requestPath,
          termination,
          reason: 'backend-not-tls',
        };
      }
      // The client talks TLS end-to-end with the backend: it sees the backend
      // serving certificate (service-ca signed for the Service DNS names) or a
      // synthetic certificate for an unannotated TLS fixture.
      const backendCert = this._servingCertificateInfo(service);
      serverCert = backendCert
        ? this._certificateView(backendCert)
        : this._certificateView(
            createSelfSignedCertificate({
              commonName: `${route.spec?.to?.name}.${route.metadata.namespace}.svc`,
              organization: 'shifting.pro',
              issuer: { commonName: 'service-ca', organization: 'OpenShift' },
            }).info
          );
    }
    const reach = this.canRouterReach(route);
    if (!reach.allowed) return respond503(reach.reason, reach.policy);
    const destinationPod = reach.pods[0] || pods[0];
    const body = this._workloadHttpBody(service, destinationPod);
    return {
      ...routeBase,
      status: 200,
      statusText: 'OK',
      headers: this._routerResponseHeaders(body),
      body: method === 'HEAD' ? '' : body,
      serverCert,
      reason: 'allowed',
      targetPort: reach.port,
      serverIp: ROUTER_DEFAULT_IP,
    };
  }

  // ── service-ca controller (issue #33a) ─────────────────────────────────
  //
  // Two annotations are modelled:
  //   Service:   service.beta.openshift.io/serving-cert-secret-name=<secret>
  //              → service-ca creates a kubernetes.io/tls Secret (tls.crt/tls.key)
  //                whose DNS names cover the Service; reencrypt Routes consume it,
  //   ConfigMap: service.beta.openshift.io/inject-cabundle=true
  //              → service-ca injects the `service-ca.crt` trust bundle key.

  /** Lazily-created simulated cluster service CA (one per engine instance). */
  _ensureServiceCA() {
    if (!this._serviceCA) {
      this._serviceCA = createCertificateAuthority({
        commonName: 'service-ca',
        organization: 'OpenShift',
        days: 3650,
      });
    }
    return this._serviceCA;
  }

  /** PEM bundle the controller injects into annotated ConfigMaps. */
  getServiceCABundle() {
    return this._ensureServiceCA().certPem;
  }

  _serviceServingCertName(service) {
    return service?.metadata?.annotations?.[SERVING_CERT_ANNOTATION] || null;
  }

  /** DNS names a service-serving certificate must cover. */
  _servingCertDnsNames(service) {
    const name = service.metadata.name;
    const namespace = service.metadata.namespace;
    return [
      `${name}.${namespace}.svc`,
      `${name}.${namespace}.svc.cluster.local`,
      `${name}.${namespace}.svc.cluster.local.`,
      `${name}.${namespace}`,
    ];
  }

  /** Create/repair the serving-cert Secret for an annotated Service. */
  _ensureServingCertSecret(service) {
    const secretName = this._serviceServingCertName(service);
    if (!secretName) return null;
    const namespace = service.metadata.namespace;
    const existing = this.cluster.getByName('Secret', secretName, namespace);
    if (existing) {
      const data = existing.spec?.data || existing.data || {};
      if (data['tls.crt'] && data['tls.key']) return existing;
    }
    const ca = this._ensureServiceCA();
    const commonName = `${service.metadata.name}.${namespace}.svc`;
    const material = createServiceSignedCertificate({
      commonName,
      dnsNames: this._servingCertDnsNames(service),
      days: 365,
      issuer: { commonName: ca.subject.commonName, organization: ca.subject.organization },
    });
    const spec = {
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': base64EncodeText(material.certPem),
        'tls.key': base64EncodeText(material.keyPem),
      },
    };
    const metadata = {
      labels: { 'service.beta.openshift.io/serving-cert': '' },
      annotations: {
        'service.beta.openshift.io/serving-cert-generation': '1',
        'service.beta.openshift.io/serving-cert-overflow': 'false',
      },
    };
    let secret = null;
    if (existing) {
      secret = this.cluster.update(existing.uid, { spec, metadata });
    } else {
      secret = this.cluster.addResource({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: secretName, namespace, ...metadata },
        spec,
        status: { phase: 'Active' },
      });
    }
    if (secret) {
      this.eventBus?.emit('service-ca:serving-cert', {
        namespace,
        service: service.metadata.name,
        secret: secretName,
      });
    }
    return secret;
  }

  /** Inject/replace the `service-ca.crt` key on an annotated ConfigMap. */
  _injectServiceCABundle(configMap) {
    const annotation = String(configMap?.metadata?.annotations?.[INJECT_CABUNDLE_ANNOTATION] ?? '');
    if (!/^true$/i.test(annotation)) return null;
    const bundle = this.getServiceCABundle();
    const data = configMap.spec?.data || configMap.data || {};
    if (data[INJECT_CABUNDLE_KEY] === bundle) return configMap;
    const updated = this.cluster.update(configMap.uid, {
      spec: { data: { ...data, [INJECT_CABUNDLE_KEY]: bundle } },
    });
    if (updated) {
      this.eventBus?.emit('service-ca:cabundle-injected', {
        namespace: configMap.metadata.namespace,
        configMap: configMap.metadata.name,
      });
    }
    return updated;
  }

  /**
   * Run the service-ca controller once (also called synchronously by the
   * CommandBar right after a successful `oc annotate`, so the resulting Secret
   * or CABundle is visible immediately even while the simulation is paused).
   * @returns {{secrets: string[], configMaps: string[]}} created/injected refs
   */
  reconcileServiceCA() {
    const createdSecrets = [];
    const injectedConfigMaps = [];
    for (const service of this.cluster.getByKind('Service')) {
      const secretName = this._serviceServingCertName(service);
      if (!secretName) continue;
      const existed = Boolean(
        this.cluster.getByName('Secret', secretName, service.metadata.namespace)
      );
      const secret = this._ensureServingCertSecret(service);
      if (secret && !existed) {
        createdSecrets.push(`${secret.metadata.namespace}/${secret.metadata.name}`);
      }
    }
    for (const configMap of this.cluster.getByKind('ConfigMap')) {
      const annotation = String(
        configMap?.metadata?.annotations?.[INJECT_CABUNDLE_ANNOTATION] ?? ''
      );
      if (!/^true$/i.test(annotation)) continue;
      const hadBundle = Boolean(configMap.spec?.data?.[INJECT_CABUNDLE_KEY]);
      const updated = this._injectServiceCABundle(configMap);
      if (updated && !hadBundle) {
        injectedConfigMaps.push(`${updated.metadata.namespace}/${updated.metadata.name}`);
      }
    }
    return { secrets: createdSecrets, configMaps: injectedConfigMaps };
  }

  /** Controller tick: service-ca convergence (called every tick). */
  _tickServiceCA() {
    try {
      this.reconcileServiceCA();
    } catch {
      /* never let a side controller break the simulation loop */
    }
  }

  _recordMetrics() {
    const stats = this.cluster.getClusterStats();
    this.metricsHistory.set(this.tickCount, {
      tick: this.tickCount,
      timestamp: Date.now(),
      cpu: stats.cpu,
      memory: stats.memory,
      pods: stats.pods,
      nodes: stats.nodes,
    });
    if (this.metricsHistory.size > this.maxMetricsHistory) {
      this.metricsHistory.delete(this.metricsHistory.keys().next().value);
    }
  }

  getMetricsHistory(count) {
    const entries = Array.from(this.metricsHistory.values());
    return count ? entries.slice(-count) : entries;
  }

  getMetricsSummary() {
    const entries = Array.from(this.metricsHistory.values());
    if (entries.length === 0) return null;
    const cpuValues = entries.map((entry) => entry.cpu.percent);
    const memValues = entries.map((entry) => entry.memory.percent);
    return {
      cpu: {
        current: cpuValues[cpuValues.length - 1],
        avg: Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length),
        max: Math.max(...cpuValues),
        min: Math.min(...cpuValues),
      },
      memory: {
        current: memValues[memValues.length - 1],
        avg: Math.round(memValues.reduce((a, b) => a + b, 0) / memValues.length),
        max: Math.max(...memValues),
        min: Math.min(...memValues),
      },
      tickCount: this.tickCount,
      historyLength: entries.length,
    };
  }

  setChaosConfig(config) {
    Object.assign(this.chaosConfig, config);
    this.enableChaos = Object.values(this.chaosConfig).some((value) => value > 0 || value === true);
  }

  setTickRate(rate) {
    this.tickRate = Math.max(0.1, Math.min(10, rate));
  }

  /**
   * Adjust the simulated build failure probability (`spec.forFailure` still
   * forces a failure; set to 0 for deterministic test runs).
   * @param {number} rate 0..1
   */
  setBuildFailureRate(rate) {
    this.buildFailureRate = Math.max(0, Math.min(1, Number(rate) || 0));
  }

  reset() {
    this.tickCount = 0;
    this.gameSeconds = 0;
    this.schedulerQueue = [];
    this.pendingScaleDecisions.clear();
    this.metricsHistory.clear();
    this.enableChaos = false;
    this.chaosConfig = {
      podKillRate: 0,
      nodeFailRate: 0,
      networkPartition: false,
      cpuStress: 0,
      memoryStress: 0,
    };
    this._oauthPending = null;
    this._sccDirty = false;
    this._quotaViolationNamespaces = new Set();
    // OLM / operator bookkeeping refers to resources of the previous run; a new
    // level/cluster starts with none of them (the catalog is re-seeded by
    // ensureOLMDefaultsSync() before the app's initial auto-align).
    this._olmOperatorDeployments.clear();
    this._metallbOperands.clear();
    this._knownCSVs.clear();
    this._simEpoch = Date.now();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Generate a Pod-network IP from the Pod's Node `spec.podCIDR` (issue #62B).
   *
   * A real OpenShift 4.22 cluster runs OVN-Kubernetes with the default
   * `clusterNetwork` 10.128.0.0/14 and hostPrefix /23, so every Node owns a /23
   * (`oc get node -o yaml` → `spec.podCIDR`) and the kubelet/OVN allocates each
   * Pod IP inside that Node's /23. This models it: parse the Node's podCIDR,
   * allocate the host octet in 2–254 (never the network or gateway address) and
   * skip addresses already assigned to another Pod so two Pods cannot share an
   * IP.
   *
   * When the Node (or its CIDR) is unknown — e.g. a Pod bound by an incident
   * handler — fall back to an address in the 10.128–10.131 clusterNetwork range.
   *
   * @param {object|string|null} [nodeOrName] Node resource or Node name
   * @returns {string}
   */
  _generatePodIP(nodeOrName = null) {
    const node =
      nodeOrName && typeof nodeOrName === 'object'
        ? nodeOrName
        : nodeOrName
          ? this.cluster.getByName('Node', String(nodeOrName), '')
          : null;
    const used = new Set(
      this.cluster
        .getByKind('Pod')
        .map((pod) => pod?.status?.podIP)
        .filter(Boolean)
    );
    const cidrMatch = String(node?.spec?.podCIDR || '').match(
      /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
    );
    if (cidrMatch) {
      const prefix = Number(cidrMatch[5]);
      const hostBits = 32 - prefix;
      if (hostBits >= 3 && hostBits <= 24) {
        const network =
          this._ipToInt([
            Number(cidrMatch[1]),
            Number(cidrMatch[2]),
            Number(cidrMatch[3]),
            Number(cidrMatch[4]),
          ]) &
          ((0xffffffff << hostBits) >>> 0);
        // Host octet 2–254: a subset of the Node's subnet that never lands on
        // the network/broadcast address (real OVN also starts allocating at .2).
        const lastOctet = Math.min(254, 2 ** hostBits - 2);
        const candidateCount = lastOctet - 2 + 1;
        const start = Math.floor(Math.random() * candidateCount);
        for (let attempt = 0; attempt < candidateCount; attempt += 1) {
          const candidate = this._intToIp(
            (network + 2 + ((start + attempt) % candidateCount)) >>> 0
          );
          if (!used.has(candidate)) return candidate;
        }
      }
    }
    // No Node/CIDR information: any address in the 10.128.0.0/14 clusterNetwork.
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const candidate = `10.${128 + Math.floor(Math.random() * 4)}.${Math.floor(
        Math.random() * 256
      )}.${2 + Math.floor(Math.random() * 253)}`;
      if (!used.has(candidate)) return candidate;
    }
    return '10.128.0.10';
  }

  _generateExternalIP() {
    return `203.0.113.${Math.floor(Math.random() * 254) + 1}`;
  }

  _randomSuffix() {
    // Real generateName suffix: rand.String(5) over the k8s safe alphabet,
    // e.g. the `x2k4p` in `webapp-5d8f7c9b6-x2k4p` (issue #43).
    let suffix = '';
    for (let index = 0; index < 5; index += 1) {
      suffix += RAND_SAFE_ALPHABET[Math.floor(Math.random() * RAND_SAFE_ALPHABET.length)];
    }
    return suffix;
  }

  /** FNV-1a hash used for deterministic pseudo-random behaviour. */
  _hashString(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  /**
   * Run `fn` and fall back to `fallback` when the controller helper throws.
   * Defensive helper for best-effort reconciliation (a malformed object must
   * never take down the whole simulation tick).
   * @template T
   * @param {() => T} fn
   * @param {T} [fallback]
   * @returns {T}
   */
  _safe(fn, fallback = null) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
}

export default SimulationTick;
