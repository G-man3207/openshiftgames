/**
 * CommandBar — the OpenShift Games `oc` terminal (OCP 4.22 / EX280).
 *
 * A dependency-free, largely self-contained simulation of the `oc` CLI. It
 * renders the bottom terminal panel, parses shell-like input (optional leading
 * `oc`/`kubectl`, quotes, pipes, output redirects), dispatches to handlers for
 * the full EX280 command catalog in docs/CONVERSION-SPEC.md §4, and renders
 * realistic `oc` tables/errors using the central kind registry
 * (js/data/kindRegistry.js) as the single source of kind metadata.
 *
 * Integration contract (all optional — every call is feature-detected):
 *   window.game = {
 *     engine:        EventBus {emit,on,off},                // events
 *     cluster:       ClusterState (getByKind/getByName/add/update/remove/...),
 *     gameEngine:    GameEngine {currentUser, currentProject, login, logout,
 *                    switchProject, canI, applyManifestObject, recordCommand,
 *                    getCommandHistory, grantSCC, revokeSCC, ...},
 *     manifestEngine: ManifestEngine {readFile, writeFile, listFiles, applyFile,
 *                    applyKustomize, processTemplate, deleteFileObjects,
 *                    installHelm, upgradeHelm, listHelm, uninstallHelm,
 *                    htpasswdAdd/Update/Delete/List},
 *   }
 *
 * Public API used by the rest of the game:
 *   new CommandBar() / init() / show() / hide() / toggle() / destroy()
 *   executeCommand(raw)  -> {error, message, raw, normalized, baseCommand}
 *   _executeCommand(raw) -> legacy alias (index.html ui:run-command)
 *
 * Events emitted (window.game.engine):
 *   command:raw {command, raw, baseCommand}
 *   command:executed {command, raw, baseCommand, success, timestamp}
 *   resource:created {kind, name, namespace, mode:'command', concurrentPods, nodeCount}
 *   resource:applied {kind, name}
 *   login {user} / logout {} / project:switched {project, previous}
 *   scc:granted {scc, subject, user} / auth:checked {user, verb, resource, namespace, allowed, command}
 *   ui:manifest-editor {kind, name, namespace}
 *   xp:gain {amount} / easter-egg:triggered {id}
 *
 * The module also exports the pure helpers below so they can be unit-tested in
 * Node without a DOM (see the harness documented in the task notes).
 */

import {
  KIND_DEFS,
  RESOURCE_TYPES,
  normalizeKind,
  isClusterScopedKind,
  apiVersionForKind,
  defaultSpecForKind,
  columnsForKind,
  explainForKind,
  toManifestObject,
  createResource,
} from '../data/kindRegistry.js';
import {
  CRIO_RUNTIME,
  KUBERNETES_GIT_VERSION,
  KUSTOMIZE_VERSION,
  NODE_KERNEL_VERSION,
  OCP_CHANNEL,
  OCP_GIT_VERSION,
  OCP_VERSION,
  RHCOS_OS_IMAGE,
} from '../data/platformVersions.js';
import { parseYaml } from '../engine/YamlParser.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Rendered prompt (spec §1). */
export const OC_PROMPT = '$ oc';
/** Tailwind colour class -> terminal output tone (the terminal is self-styled). */
const TERM_TONES = {
  'text-white/70': 'out',
  'text-white/30': 'dim',
  'text-white/20': 'dim',
  'text-red-400': 'err',
  'text-green-400/80': 'cmd',
  'text-green-400': 'ok',
  'text-amber-400': 'warn',
  'text-amber-400/80': 'warn',
  'text-amber-400/70': 'warn',
  'text-sky-400': 'info',
  'text-yellow-400': 'warn',
};
/** Docs base used by help / PLEG links. */
export const OC_DOCS_URL = 'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22';
/** Simulated server + client versions, derived from js/data/platformVersions.js. */
export const OC_CLIENT_VERSION = OCP_VERSION;
export const OC_SERVER_VERSION = OCP_VERSION;
export const K8S_SERVER_VERSION = KUBERNETES_GIT_VERSION;
export const OC_SERVER_URL = 'https://api.cluster.example.com:6443';
export const APPS_DOMAIN = 'apps.cluster.example.com';
/** Internal registry reference used by builds/imagestreams (spec §5). */
export const INTERNAL_REGISTRY = 'image-registry.openshift-image-registry.svc:5000';

/**
 * `kubectl` is accepted only as an input alias on OpenShift; the UI always
 * teaches/displays `oc`. This is the only place the legacy word appears.
 */
const INPUT_PREFIX_RE = /^\s*(?:oc|kubectl)\s+/i;
const INPUT_PREFIX_WORD_RE = /^\s*(oc|kubectl)\s+/i;

/** Top-level command catalog: completion + help. */
export const BASE_COMMANDS = {
  login: { summary: 'Log in to a server', usage: 'oc login [--username=<user>] [--password=<pass>] [server]' },
  logout: { summary: 'Log out of the current session', usage: 'oc logout' },
  whoami: { summary: 'Return the current user', usage: 'oc whoami' },
  project: { summary: 'Switch to another project', usage: 'oc project [<project>]' },
  projects: { summary: 'Display existing projects', usage: 'oc projects' },
  'new-project': { summary: 'Create a new project and switch to it', usage: 'oc new-project <name> [--display-name=] [--description=]' },
  status: { summary: 'Show an overview of the current project', usage: 'oc status [-n <project>]' },
  get: { summary: 'Display one or many resources', usage: 'oc get <resource> [<name>] [-n <project>] [-A] [-o wide|yaml|json|name|jsonpath=...|custom-columns=...]' },
  describe: { summary: 'Show details of a specific resource or group of resources', usage: 'oc describe <resource> [<name>]' },
  logs: { summary: 'Print the logs for a container, build or deployment', usage: 'oc logs <pod|deployment/name|build/name|bc/name> [-f] [--previous] [-c <container>] [--tail=<n>]' },
  events: { summary: 'List recent events in the current project', usage: 'oc events [-n <project>] [--field-selector=...]' },
  explain: { summary: 'Document fields of a resource', usage: 'oc explain <resource>[.<field>]' },
  create: { summary: 'Create a resource from a file or from stdin, or create a resource by name', usage: 'oc create <resource> <name> [flags]  |  oc create -f <file> [-n <project>]' },
  apply: { summary: 'Apply a configuration to a resource by file name or stdin', usage: 'oc apply -f <file>  |  oc apply -k <directory>' },
  replace: { summary: 'Replace a resource by file name or stdin', usage: 'oc replace -f <file>' },
  delete: { summary: 'Delete resources by file names, stdin, or resource names', usage: 'oc delete <resource> <name>  |  oc delete -f <file>  |  oc delete -k <dir>' },
  scale: { summary: 'Set a new size for a deployment, replica set or stateful set', usage: 'oc scale <resource>/<name> --replicas=<count>' },
  edit: { summary: 'Edit a resource in the manifest editor', usage: 'oc edit <resource>/<name>' },
  label: { summary: 'Update the labels on a resource', usage: 'oc label <resource>/<name> <key>=<value> [--overwrite]' },
  annotate: { summary: 'Update the annotations on a resource', usage: 'oc annotate <resource>/<name> <key>=<value> [--overwrite]' },
  patch: { summary: 'Update fields of a resource using a JSON patch', usage: "oc patch <resource>/<name> -p '<json>' [--type=merge|strategic|json]" },
  set: { summary: 'Set specific features on objects (env, image, resources, probes, data, ...)', usage: 'oc set <env|image|resources|probe|serviceaccount|triggers|selector|volumes|data> ...' },
  rollout: { summary: 'Manage the rollout of a resource', usage: 'oc rollout <status|history|undo|restart|pause|resume> <resource>/<name>' },
  expose: { summary: 'Expose a replicated application as a Route', usage: 'oc expose <svc|deployment>/<name> [--name=] [--hostname=] [--path=]' },
  run: { summary: 'Run a particular image in a pod', usage: 'oc run <name> --image=<image> [--port=]' },
  exec: { summary: 'Execute a command in a container', usage: 'oc exec -it <pod> -- <command>' },
  tag: { summary: 'Tag existing images into image streams', usage: 'oc tag <source> <destination> [--scheduled]' },
  'import-image': { summary: 'Import images from an external registry into an image stream', usage: 'oc import-image <imagestream>:<tag> --from=<image> --confirm' },
  extract: { summary: 'Extract secrets or config maps to disk', usage: 'oc extract secret/<name> | configmap/<name> [--to=<dir>|-] [--keys=k1,k2] [--confirm]' },
  'new-app': { summary: 'Create an application from source code or an image', usage: 'oc new-app <image|git-url> [--name=] | --template=<name> [-p K=V] | -f <file>' },
  'new-build': { summary: 'Create a new build configuration', usage: 'oc new-build <image-stream> --name=<bc> [--code=<git-url>]' },
  'start-build': { summary: 'Start a new build', usage: 'oc start-build <buildconfig> [--follow] [--from-dir=.]' },
  'cancel-build': { summary: 'Cancel running, pending or new builds', usage: 'oc cancel-build <buildconfig>' },
  process: { summary: 'Process a template into the objects it defines', usage: 'oc process -f <file> [-p K=V] [-o yaml|json]  |  oc process <template-name>' },
  kustomize: { summary: 'Build a kustomization target from a directory or URL', usage: 'oc kustomize [directory]' },
  adm: { summary: 'Administrative commands (policy, groups, nodes, top, templates, must-gather)', usage: 'oc adm <policy|groups|cordon|uncordon|drain|taint|top|create-bootstrap-project-template|must-gather|inspect> ...' },
  auth: { summary: 'Inspect authorization', usage: 'oc auth can-i <verb> <resource> [--as=<user>] [--list]' },
  debug: { summary: 'Launch a debug shell for a node or workload', usage: 'oc debug <node|deployment>/<name>' },
  helm: { summary: 'Install and manage Helm charts (OpenShift Helm support)', usage: 'helm install|upgrade|list|uninstall ...' },
  htpasswd: { summary: 'Manage the virtual HTPasswd identity-provider file', usage: 'htpasswd [-c|-b|-D] <file> <user> [password]' },
  config: { summary: 'Modify kubeconfig files (contexts)', usage: 'oc config <current-context|view|get-contexts>' },
  version: { summary: 'Print the client and server versions', usage: 'oc version' },
  'api-resources': { summary: 'Print the supported API resources on the server', usage: 'oc api-resources' },
  help: { summary: 'Help about any command', usage: 'oc help [command]' },
  // Backwards-compatible bare forms (the game historically accepted these).
  cordon: { summary: 'Mark a node as unschedulable (alias of oc adm cordon)', usage: 'oc adm cordon <node>' },
  uncordon: { summary: 'Mark a node as schedulable (alias of oc adm uncordon)', usage: 'oc adm uncordon <node>' },
  drain: { summary: 'Drain a node (alias of oc adm drain)', usage: 'oc adm drain <node>' },
  top: { summary: 'Display resource usage (alias of oc adm top)', usage: 'oc adm top <pods|nodes>' },
};

/** Commands that mutate cluster state (used for auth-check telemetry). */
const MUTATING_COMMANDS = new Set([
  'create', 'apply', 'replace', 'delete', 'scale', 'edit', 'label', 'annotate',
  'patch', 'set', 'rollout', 'expose', 'run', 'exec', 'tag', 'import-image',
  'new-app', 'new-build', 'start-build', 'cancel-build', 'process', 'adm',
  'login', 'logout', 'new-project', 'htpasswd',
]);

/** Virtual `oc get` views implemented locally that still target a namespace. */
const NAMESPACED_VIRTUAL_GET_TOKENS = new Set([
  'csv', 'csvs', 'clusterserviceversion', 'clusterserviceversions',
  'operatorgroup', 'operatorgroups', 'og',
  'istag', 'istags', 'imagestreamtag', 'imagestreamtags',
  'endpoints', 'endslices', 'endpointslices', 'ep',
]);

/** Namespace-scoped completion subcommands. */
const SUBCOMMANDS = {
  set: ['env', 'image', 'resources', 'probe', 'serviceaccount', 'triggers', 'selector', 'volumes', 'data'],
  adm: ['policy', 'groups', 'cordon', 'uncordon', 'drain', 'taint', 'top', 'create-bootstrap-project-template', 'must-gather', 'inspect'],
  'adm policy': [
    'add-role-to-user', 'add-role-to-group', 'add-cluster-role-to-user', 'add-cluster-role-to-group',
    'remove-role-from-user', 'remove-role-from-group', 'remove-cluster-role-from-user', 'remove-cluster-role-from-group',
    'add-scc-to-user', 'add-scc-to-group', 'remove-scc-from-user', 'remove-scc-from-group',
    'who-can', 'scc-review', 'scc-subject-review',
  ],
  'adm groups': ['new', 'add-users', 'remove-users'],
  auth: ['can-i'],
  rollout: ['status', 'history', 'undo', 'restart', 'pause', 'resume'],
  expose: ['svc', 'service', 'deployment', 'deploy'],
  create: ['route', 'secret', 'configmap', 'deployment', 'service', 'quota', 'limitrange', 'clusterquota', 'user', 'group', 'serviceaccount', 'rolebinding', 'clusterrolebinding', 'job', 'cronjob', 'project', 'namespace', 'template'],
  'create route': ['edge', 'passthrough', 'reencrypt'],
  'create secret': ['generic', 'tls', 'docker-registry'],
  'create service': ['clusterip', 'nodeport', 'loadbalancer', 'externalname'],
  config: ['current-context', 'view', 'get-contexts', 'use-context'],
  helm: ['install', 'upgrade', 'list', 'uninstall', 'status'],
};

/** Flag completion hints per base command. */
const COMMAND_FLAGS = {
  get: ['-n', '--namespace', '-A', '--all-namespaces', '-o', '--output', '-l', '--selector', '--field-selector', '--sort-by', '--show-labels', '--no-headers', '-w', '--watch', '--raw'],
  describe: ['-n', '--namespace', '--show-events'],
  logs: ['-n', '--namespace', '-f', '--follow', '--previous', '-c', '--container', '--tail', '--since', '--timestamps'],
  create: ['-f', '--filename', '-n', '--namespace', '--image', '--replicas', '--dry-run', '-o', '--output', '-l', '--labels', '--verb', '--resource', '--resource-name', '--api-group', '--schedule', '--restart'],
  apply: ['-f', '--filename', '-k', '--kustomize', '-n', '--namespace', '--dry-run', '--overwrite', '--validate'],
  delete: ['-f', '--filename', '-k', '--kustomize', '-n', '--namespace', '-l', '--selector', '--all', '--force', '--grace-period'],
  scale: ['--replicas', '--current-replicas', '--resource-version', '-n', '--namespace'],
  set: ['-n', '--namespace', '-c', '--containers', '--all', '--overwrite', '-e', '--env', '--from', '--prefix', '--remove', '--list', '--limits', '--requests', '--liveness', '--readiness', '--get-url', '--open-tcp', '--remove', '--add', '--name', '--mount-path', '--claim-name', '--type', '--default-volume-mode', '--from-file', '--from-literal'],
  extract: ['-n', '--namespace', '--to', '--keys', '--confirm'],
  'new-app': ['--name', '--image', '--image-stream', '--code', '--template', '-f', '--file', '-e', '--env', '-p', '--param', '--context-dir', '--source-secret', '-n', '--namespace', '--strategy', '--build'],
  'new-build': ['--name', '--code', '--image-stream', '--strategy', '--context-dir', '-n', '--namespace'],
  'start-build': ['-F', '--follow', '--from-dir', '--from-file', '--env', '--commit', '--wait', '--no-cache', '-n', '--namespace'],
  expose: ['--name', '--hostname', '--path', '--port', '--selector', '--internal', '--wildcard-policy', '-n', '--namespace'],
  run: ['--image', '--port', '--restart', '--env', '--labels', '--serviceaccount', '-n', '--namespace'],
  patch: ['-p', '--patch', '--type', '--dry-run', '-n', '--namespace'],
  label: ['--overwrite', '--all', '-l', '--selector', '-n', '--namespace'],
  annotate: ['--overwrite', '--all', '-l', '--selector', '-n', '--namespace'],
  rollout: ['--to-revision', '--dry-run', '-w', '--watch', '-n', '--namespace'],
  adm: ['-n', '--namespace', '-z', '--serviceaccount', '--rolebinding-name', '--clusterrole', '--role', '--user', '--group', '--hard', '--project-label-selector', '--force', '--ignore-daemonsets', '--delete-emptydir-data'],
  auth: ['--as', '--as-group', '--list', '-n', '--namespace'],
  process: ['-f', '--filename', '-p', '--param', '-o', '--output', '--parameters', '--param-file', '-n', '--namespace'],
  'import-image': ['--from', '--confirm', '--all', '--scheduled', '-n', '--namespace'],
  tag: ['--scheduled', '--reference-policy', '--source', '-n', '--namespace'],
  login: ['-u', '--username', '-p', '--password', '--server', '--token'],
};

/** Plural resource names (used in completion, output and error messages). */
const KIND_PLURALS = {
  Project: 'projects', Node: 'nodes', ClusterResourceQuota: 'clusterresourcequotas',
  Pod: 'pods', Deployment: 'deployments', ReplicaSet: 'replicasets', StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs',
  BuildConfig: 'buildconfigs', Build: 'builds', ImageStream: 'imagestreams',
  Service: 'services', Route: 'routes', Ingress: 'ingresses', NetworkPolicy: 'networkpolicies',
  IPAddressPool: 'ipaddresspools', L2Advertisement: 'l2advertisements',
  ConfigMap: 'configmaps', Secret: 'secrets', LimitRange: 'limitranges', ResourceQuota: 'resourcequotas',
  Template: 'templates', PersistentVolume: 'persistentvolumes', PersistentVolumeClaim: 'persistentvolumeclaims',
  StorageClass: 'storageclasses', HorizontalPodAutoscaler: 'horizontalpodautoscalers',
  PodDisruptionBudget: 'poddisruptionbudgets', ServiceAccount: 'serviceaccounts',
  Role: 'roles', ClusterRole: 'clusterroles', RoleBinding: 'rolebindings', ClusterRoleBinding: 'clusterrolebindings',
  SecurityContextConstraints: 'securitycontextconstraints', User: 'users', Group: 'groups', Identity: 'identities',
  OAuth: 'oauths', Subscription: 'subscriptions', ClusterOperator: 'clusteroperators', ClusterVersion: 'clusterversions',
};

/** Singular `kind.group` form used by oc in create/delete/error messages. */
const KIND_REF_NAMES = {
  Project: 'project.project.openshift.io', Node: 'node', ClusterResourceQuota: 'clusterresourcequota.quota.openshift.io',
  Pod: 'pod', Deployment: 'deployment.apps', ReplicaSet: 'replicaset.apps', StatefulSet: 'statefulset.apps',
  DaemonSet: 'daemonset.apps', Job: 'job.batch', CronJob: 'cronjob.batch',
  BuildConfig: 'buildconfig.build.openshift.io', Build: 'build.build.openshift.io', ImageStream: 'imagestream.image.openshift.io',
  Service: 'service', Route: 'route.route.openshift.io', Ingress: 'ingress.networking.k8s.io',
  NetworkPolicy: 'networkpolicy.networking.k8s.io', IPAddressPool: 'ipaddresspool.metallb.io',
  L2Advertisement: 'l2advertisement.metallb.io', ConfigMap: 'configmap', Secret: 'secret', LimitRange: 'limitrange',
  ResourceQuota: 'resourcequota', Template: 'template.template.openshift.io', PersistentVolume: 'persistentvolume',
  PersistentVolumeClaim: 'persistentvolumeclaim', StorageClass: 'storageclass.storage.k8s.io',
  HorizontalPodAutoscaler: 'horizontalpodautoscaler.autoscaling', PodDisruptionBudget: 'poddisruptionbudget.policy',
  ServiceAccount: 'serviceaccount', Role: 'role.rbac.authorization.k8s.io', ClusterRole: 'clusterrole.rbac.authorization.k8s.io',
  RoleBinding: 'rolebinding.rbac.authorization.k8s.io', ClusterRoleBinding: 'clusterrolebinding.rbac.authorization.k8s.io',
  SecurityContextConstraints: 'securitycontextconstraints.security.openshift.io', User: 'user.user.openshift.io',
  Group: 'group.user.openshift.io', Identity: 'identity.user.openshift.io', OAuth: 'oauth.config.openshift.io',
  Subscription: 'subscription.operators.coreos.com', ClusterOperator: 'clusteroperator.config.openshift.io',
  ClusterVersion: 'clusterversion.config.openshift.io',
};

/** Default images used by `oc new-app`/`oc new-build` when none is supplied. */
const S2I_IMAGES = {
  nodejs: 'nodejs:20-ubi9',
  python: 'python:3.12-ubi9',
  nginx: 'nginx:1.26-ubi9',
};

/** Browser console URL of the simulated cluster (`oc whoami --show-console`). */
export const OC_CONSOLE_URL = 'https://console-openshift-console.apps.cluster.example.com';

/** Educational note appended to `oc edit` (the simulator uses a manifest editor). */
const EDIT_TEACHING_LINE =
  '(On a real cluster oc edit launches $EDITOR — vi/vim by default — in your terminal; this simulator opens the manifest editor.)';

/**
 * CommandBar-local `oc get` column overrides that differ from the shared kind
 * registry (the registry is owned by the platform workstream). Kept here so the
 * CLI can report the real K8s 1.35 / OCP 4.22 printer columns without editing
 * registry files.
 */
const COLUMN_OVERRIDES = {
  ServiceAccount: 'NAME      AGE',
  Job: 'NAME      STATUS   COMPLETIONS   DURATION   AGE',
  CronJob: 'NAME      SCHEDULE      TIMEZONE   SUSPEND   ACTIVE   LAST SCHEDULE   AGE',
  RoleBinding: 'NAME      ROLE      AGE',
  ClusterRoleBinding: 'NAME      ROLE      AGE',
};

/** Long flags the simulated `oc` implements somewhere (typo rejection). */
const KNOWN_LONG_FLAGS = new Set([
  'active-deadline-seconds', 'add', 'all', 'all-containers', 'all-namespaces', 'allow',
  'allocate-load-balancer-ip', 'api-group', 'as', 'as-group', 'audio', 'backoff-limit', 'build',
  'builder-image', 'ca-cert', 'cascade', 'cert', 'claim-name', 'cluster-ip', 'clusterrole', 'code',
  'command', 'commit', 'completions', 'config-map', 'confirm', 'container', 'containers', 'context',
  'context-dir', 'current-replicas', 'default', 'default-mode', 'default-request',
  'delete-emptydir-data', 'description', 'dest-ca-cert', 'dest-dir', 'destination',
  'destination-ca-cert', 'display-name', 'docker-email', 'docker-password', 'docker-server',
  'docker-username', 'dockerfile', 'dry-run', 'env', 'external-name', 'field-selector', 'file',
  'filename', 'follow', 'for', 'force', 'format', 'from', 'from-build', 'from-config', 'from-dir',
  'from-env-file', 'from-file', 'from-github', 'from-image', 'from-literal', 'from-repo',
  'from-webhook', 'full-name', 'get-url', 'grace-period', 'group', 'hard', 'help', 'hostname',
  'http-proxy', 'https-proxy', 'ignore-daemonsets', 'image', 'image-stream', 'import-mode',
  'insecure-policy', 'insecure-skip-tls-verify', 'internal', 'key', 'kustomize', 'label', 'labels',
  'limits', 'list', 'liveness', 'load-balancer-ip', 'local', 'max', 'max-limit-request-ratio',
  'max-surge', 'max-unavailable', 'min', 'mount-path', 'name', 'namespace', 'namespaced',
  'no-cache', 'no-headers', 'no-proxy', 'node', 'now', 'open-tcp', 'orphan', 'output', 'overwrite',
  'parallelism', 'param', 'param-file', 'parameters', 'password', 'patch', 'path', 'persist',
  'port', 'prefix', 'previous', 'progress-deadline', 'project-annotation-selector',
  'project-label-selector', 'publish-not-ready-addresses', 'readiness', 'recursive',
  'reference-policy', 'remove', 'replicas', 'repo', 'request-timeout', 'requests', 'resource',
  'resource-version', 'restart', 'revision', 'role', 'rolebinding-name', 'schedule', 'scheduled',
  'scopes', 'secret', 'selector', 'server', 'service', 'serviceaccount', 'session-affinity', 'set',
  'show-console', 'show-context', 'show-labels', 'show-server', 'show-token', 'since', 'since-time',
  'sort-by', 'source', 'source-secret', 'stdin', 'strategy', 'sub-path', 'subresource', 'suspend',
  'tail', 'target-port', 'template', 'timeout', 'timestamps', 'to-revision', 'tty', 'type', 'user',
  'username', 'validate', 'values', 'values-file', 'verb', 'verbs', 'version', 'wait', 'watch',
  'wildcard-policy', 'working-dir',
  // flags implemented by individual handlers (must stay accepted by validation)
  'as-root', 'atomic', 'attach', 'auto', 'binary', 'client', 'delete', 'delete-local-data',
  'disable-eviction', 'duration', 'enable-alpha-plugins', 'field-manager', 'generate-name',
  'generated', 'http-get', 'ignore-not-found', 'initial-delay-seconds', 'it', 'keep-annotations',
  'keep-init-containers', 'keep-labels', 'keep-liveness', 'keep-readiness', 'load-restrictor',
  'manual', 'overrides', 'paused', 'period-seconds', 'pod-selector', 'prune', 'quiet', 'raw',
  'reorder', 'rm', 'server-side', 'short', 'show-events', 'startup', 'state', 'tcp', 'timezone',
  'to', 'to-namespace', 'token', 'types', 'udp', 'keys', 'resource-name',
]);

/** Short flags the simulated `oc` implements (unknown single-letter flags error). */
const KNOWN_SHORT_FLAGS = new Set([
  'A', 'B', 'D', 'F', 'H', 'b', 'c', 'e', 'f', 'i', 'k', 'l', 'n', 'o', 'p', 'q', 'r', 't', 'u', 'w', 'z',
]);

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for the Node test harness)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip an optional leading `oc ` / `kubectl ` prefix.
 * `kubectl` is accepted as an input alias only; the rest of the game teaches `oc`.
 * @param {string} raw
 * @returns {{command:string, prefixed:boolean, usedKubectl:boolean}}
 */
export function stripCommandPrefix(raw) {
  const text = String(raw ?? '').trim();
  const match = text.match(INPUT_PREFIX_WORD_RE);
  if (!match) return { command: text, prefixed: false, usedKubectl: false };
  return {
    command: text.slice(match[0].length).trim(),
    prefixed: true,
    usedKubectl: match[1].toLowerCase() === 'kubectl',
  };
}

/**
 * Shell-like tokenizer: whitespace separated, single/double quotes, backslash escapes.
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeCommand(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(input ?? '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Split a command line into pipeline stages plus a trailing output redirect.
 * Handles quotes so `-o jsonpath='{.a}'` and `"a|b"` are not split.
 * @param {string} raw
 * @returns {{stages:string[], redirect:{file:string, append:boolean}|null}}
 */
export function splitPipeline(raw) {
  const text = String(raw ?? '').trim();
  const stages = [];
  let redirect = null;
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      if (current.trim()) stages.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '>') {
      const append = text[i + 1] === '>';
      const rest = text.slice(i + (append ? 2 : 1)).trim();
      const file = tokenizeCommand(rest)[0];
      if (file) {
        redirect = { file, append };
        i = text.length;
        break;
      }
      current += ch;
      continue;
    }
    current += ch;
  }
  if (current.trim()) stages.push(current.trim());
  if (stages.length === 0) stages.push('');
  return { stages, redirect };
}

/** Long flags that consume a value when given as `--flag value`. */
const VALUE_LONG_FLAGS = new Set([
  'namespace', 'output', 'selector', 'field-selector', 'sort-by', 'replicas', 'current-replicas',
  'resource-version', 'image', 'image-stream', 'name', 'code', 'template', 'file', 'filename',
  'kustomize', 'param', 'env', 'from', 'remove', 'prefix', 'containers', 'container', 'limits',
  'requests', 'default', 'default-request', 'max', 'min', 'max-limit-request-ratio', 'get-url',
  'open-tcp', 'claim-name', 'mount-path', 'sub-path', 'type', 'patch', 'to-revision', 'tail',
  'since', 'since-time', 'hostname', 'path', 'cert', 'key', 'ca-cert', 'dest-ca-cert',
  'destination-ca-cert', 'insecure-policy', 'wildcard-policy', 'port', 'server', 'username',
  'password', 'as', 'as-group', 'hard', 'scopes', 'project-label-selector',
  'project-annotation-selector', 'from-literal', 'from-file', 'from-env-file', 'docker-server',
  'docker-username', 'docker-password', 'docker-email', 'service', 'serviceaccount', 'clusterrole',
  'role', 'user', 'group', 'rolebinding-name', 'from-image', 'from-dir', 'revision', 'grace-period',
  'cascade', 'context-dir', 'source-secret', 'strategy', 'build', 'display-name', 'description',
  'version', 'dockerfile', 'context', 'context-dir', 'audio', 'labels', 'label', 'param-file',
  'source', 'reference-policy', 'commit', 'working-dir', 'destination', 'format', 'http-proxy',
  'https-proxy', 'no-proxy', 'node', 'target-port', 'selector', 'external-name', 'cluster-ip',
  'session-affinity', 'publish-not-ready-addresses', 'load-balancer-ip', 'allocate-load-balancer-ip',
  'max-surge', 'max-unavailable', 'progress-deadline', 'active-deadline-seconds', 'backoff-limit',
  'completions', 'parallelism', 'restart', 'schedule', 'suspend', 'serviceaccount', 'overwrite',
]);

/** Flags explicitly treated as booleans even without `=`. */
const BOOLEAN_LONG_FLAGS = new Set([
  'all', 'all-namespaces', 'show-labels', 'no-headers', 'watch', 'previous', 'follow', 'list',
  'overwrite', 'force', 'ignore-daemonsets', 'delete-emptydir-data', 'confirm', 'scheduled',
  'remove', 'add', 'liveness', 'readiness', 'parameters', 'internal', 'recursive', 'validate',
  'dry-run', 'local', 'server', 'insecure-skip-tls-verify', 'request-timeout', 'help', 'allow',
  'for', 'wait', 'no-cache', 'timestamps', 'cascade', 'orphan', 'now', 'persist', 'tty', 'stdin',
]);

/**
 * Parse argv-style tokens into positionals + flags.
 *
 * @param {string[]} tokens
 * @param {{shortValues?:Record<string,string>, shortBools?:Record<string,string>, longValues?:string[], longBools?:string[]}} [spec]
 * @returns {{positionals:string[], flags:Record<string, string|boolean|string[]>, tokens:string[], afterDoubleDash:string[]}}
 */
export function parseArgs(tokens, spec = {}) {
  const shortValues = spec.shortValues || {};
  const shortBools = spec.shortBools || {};
  const longValues = new Set([...(spec.longValues || []), ...VALUE_LONG_FLAGS]);
  const longBools = new Set([...(spec.longBools || []), ...BOOLEAN_LONG_FLAGS]);
  const multi = new Set(spec.multi || []);
  const positionals = [];
  const flags = {};
  let afterDoubleDash = [];

  const assign = (name, value) => {
    if (multi.has(name)) {
      if (!Array.isArray(flags[name])) flags[name] = [];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      afterDoubleDash = tokens.slice(i + 1);
      break;
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        assign(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const name = token.slice(2);
        if (longBools.has(name)) flags[name] = true;
        else if (longValues.has(name) && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          assign(name, tokens[++i]);
        } else if (longValues.has(name) && i + 1 < tokens.length) {
          assign(name, tokens[++i]);
        } else flags[name] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token !== '-' && !/^-\d/.test(token)) {
      let rest = token.slice(1);
      while (rest.length > 0) {
        const char = rest[0];
        const key = `-${char}`;
        if (shortBools[key]) {
          flags[shortBools[key]] = true;
          flags[key] = true;
          rest = rest.slice(1);
          continue;
        }
        if (shortValues[key]) {
          let value;
          if (rest.length > 1) {
            value = rest.slice(1);
            if (value.startsWith('=')) value = value.slice(1);
            rest = '';
          } else if (i + 1 < tokens.length) {
            value = tokens[++i];
            rest = '';
          } else {
            value = true;
            rest = '';
          }
          assign(shortValues[key], value);
          continue;
        }
        flags[char] = true;
        flags[key] = true;
        rest = rest.slice(1);
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags, tokens, afterDoubleDash };
}

/**
 * Resolve a user-typed resource token to a canonical kind. Tolerates the plurals
 * of short aliases that real oc accepts (`quotas`, `clusterquotas`, ...).
 * @param {string} token
 * @returns {string|null}
 */
export function resolveKindToken(token) {
  if (!token) return null;
  const text = String(token).toLowerCase();
  const extra = {
    quotas: 'ResourceQuota',
    clusterquotas: 'ClusterResourceQuota',
    clusterquota: 'ClusterResourceQuota',
    resourcequotas: 'ResourceQuota',
    sccs: 'SecurityContextConstraints',
    cos: 'ClusterOperator',
    cvs: 'ClusterVersion',
    pvcs: 'PersistentVolumeClaim',
    pvs: 'PersistentVolume',
    scs: 'StorageClass',
    hpas: 'HorizontalPodAutoscaler',
    pdbs: 'PodDisruptionBudget',
    sas: 'ServiceAccount',
    ics: 'Ingress',
    ippools: 'IPAddressPool',
  };
  const direct = normalizeKind(text) || extra[text];
  if (direct) return direct;
  if (text.endsWith('es') && normalizeKind(text.slice(0, -2))) return normalizeKind(text.slice(0, -2));
  if (text.endsWith('s') && normalizeKind(text.slice(0, -1))) return normalizeKind(text.slice(0, -1));
  return null;
}

/**
 * Split a `<kind>/<name>` or `<kind> <name>` reference. Accepts `deployment.apps/web`.
 * @param {string[]} positionals
 * @returns {{kind:string|null, name:string|null}}
 */
export function splitResourceRef(positionals) {
  const first = positionals[0];
  if (!first) return { kind: null, name: null };
  if (first.includes('/')) {
    const slash = first.indexOf('/');
    let kindToken = first.slice(0, slash);
    const name = first.slice(slash + 1);
    kindToken = kindToken.split('.')[0];
    return { kind: resolveKindToken(kindToken), name: name || null };
  }
  const kind = resolveKindToken(first);
  if (kind) return { kind, name: positionals[1] ?? null };
  return { kind: null, name: first };
}

/** True when the token looks like a resource reference (`svc/web`). */
export function isResourceRef(token) {
  return typeof token === 'string' && token.includes('/') && !token.startsWith('/');
}

/**
 * Parse an oc label selector string into a predicate.
 * Supports `k=v`, `k==v`, `k!=v`, `k`, `k in (a,b)`, `k notin (a,b)` joined by commas.
 * @param {string} selector
 * @returns {(resource: any) => boolean}
 */
export function parseLabelSelector(selector) {
  const text = String(selector ?? '').trim();
  if (!text) return () => true;
  const requirements = [];
  // Split on commas that are not inside parentheses.
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) requirements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) requirements.push(current.trim());

  const getLabels = (resource) => (resource && (resource.metadata?.labels || resource.labels)) || {};

  return (resource) => {
    const labels = getLabels(resource);
    for (const req of requirements) {
      let m = req.match(/^([A-Za-z0-9_.\-/]+)\s+(in|notin)\s*\(([^)]*)\)$/);
      if (m) {
        const values = m[3].split(',').map((v) => v.trim()).filter(Boolean);
        const has = Object.prototype.hasOwnProperty.call(labels, m[1]) && values.includes(labels[m[1]]);
        if (m[2] === 'in' && !has) return false;
        if (m[2] === 'notin' && has) return false;
        continue;
      }
      m = req.match(/^([A-Za-z0-9_.\-/]+)\s*(!=|==|=)\s*(.*)$/);
      if (m) {
        const [, key, op, value] = m;
        const actual = labels[key];
        if (op === '!=') {
          if (actual === value) return false;
        } else if (actual !== value) return false;
        continue;
      }
      // Bare existence / !key requirement.
      const negate = req.startsWith('!');
      const key = negate ? req.slice(1) : req;
      const exists = Object.prototype.hasOwnProperty.call(labels, key);
      if (negate ? exists : !exists) return false;
    }
    return true;
  };
}

/**
 * Parse `--field-selector` into a predicate. Supports `=` and `!=` on dotted
 * paths plus the special event fields `involvedObject.*`, `type`, `reason`.
 * @param {string} selector
 * @returns {(resource:any, extra?:any) => boolean}
 */
export function parseFieldSelector(selector) {
  const text = String(selector ?? '').trim();
  if (!text) return () => true;
  const requirements = text.split(',').map((s) => s.trim()).filter(Boolean);
  return (resource) => {
    for (const req of requirements) {
      const m = req.match(/^([A-Za-z0-9_.\-/]+)\s*(!=|==|=)\s*(.*)$/);
      if (!m) continue;
      const [, path, op, expected] = m;
      const actual = resolvePathValue(resource, path.split('.'));
      const matches = String(actual ?? '') === expected;
      if (op === '!=' ? matches : !matches) return false;
    }
    return true;
  };
}

/** Resolve a dotted path on a plain object/array (supports numeric indices). */
export function resolvePathValue(target, segments) {
  let current = target;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === '*') return current;
    if (/^\d+$/.test(segment)) current = current[Number(segment)];
    else current = current[segment];
  }
  return current;
}

/**
 * Evaluate the subset of kubectl/oc jsonpath used by the game and tutorials:
 *   {.metadata.name}  {.items[*].metadata.name}  {.spec.host}
 *   {range .items[*]}{.metadata.name}{"\n"}{end}
 *   {.status.ingress[0].host}
 * @param {any} object
 * @param {string} template
 * @returns {string}
 */
export function evaluateJsonPath(object, template) {
  const text = String(template ?? '').trim();
  if (!text) return '';
  // Whole-template `{range …}…{end}` fast path (the most common scripting form).
  const wholeRange = text.match(/^\{range\s+([^}]+)\}([\s\S]*)\{end\}\s*$/);
  if (wholeRange) {
    const items = resolveJsonPathTokens(object, wholeRange[1]);
    const list = Array.isArray(items) ? (items.length === 1 && Array.isArray(items[0]) ? items[0] : items) : [];
    return list.map((item) => renderJsonPathTemplate(item, object, wholeRange[2])).join('');
  }
  // General JSONPath template: any sequence of expressions, quoted literals and
  // range blocks — e.g. `{.items[*].metadata.name}{"\n"}` or
  // `{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}`.
  let out = '';
  let literal = '';
  let i = 0;
  const flushLiteral = () => {
    if (literal) {
      out += literal;
      literal = '';
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{') {
      literal += ch;
      i++;
      continue;
    }
    if (text.startsWith('{range ', i)) {
      flushLiteral();
      const headerClose = text.indexOf('}', i);
      const endIndex = text.indexOf('{end}', i);
      if (headerClose < 0 || endIndex < 0) {
        literal += text.slice(i);
        i = text.length;
        break;
      }
      const expression = text.slice(i + '{range '.length, headerClose).trim();
      const body = text.slice(headerClose + 1, endIndex);
      const items = resolveJsonPathTokens(object, expression);
      const list = Array.isArray(items) ? (items.length === 1 && Array.isArray(items[0]) ? items[0] : items) : [];
      out += list.map((item) => renderJsonPathTemplate(item, object, body)).join('');
      i = endIndex + '{end}'.length;
      continue;
    }
    const close = text.indexOf('}', i);
    if (close < 0) {
      literal += text.slice(i);
      i = text.length;
      break;
    }
    flushLiteral();
    out += renderJsonPathBrace(object, text.slice(i + 1, close), object);
    i = close + 1;
  }
  flushLiteral();
  return out;
}

/** Render one `{…}` JSONPath template segment (literal, `@`, or expression). */
function renderJsonPathBrace(context, innerRaw, root) {
  const inner = String(innerRaw ?? '').trim();
  const literal = jsonPathQuotedLiteral(inner);
  if (literal !== null) return literal;
  if (inner === '@') return JSON.stringify(context);
  const value = resolveJsonPathTokens(context, inner, root);
  if (Array.isArray(value)) return value.map((entry) => (entry !== null && typeof entry === 'object' ? JSON.stringify(entry) : String(entry))).join(' ');
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Decode a quoted JSONPath literal (`{"\n"}`, `{'\t'}`); null when not a literal. */
function jsonPathQuotedLiteral(inner) {
  const text = String(inner ?? '').trim();
  if (text.startsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.replace(/^"|"$/g, '');
    }
  }
  if (text.startsWith("'")) {
    return text
      .replace(/^'|'$/g, '')
      .replace(/\\(.)/g, (match, char) => (char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char));
  }
  return null;
}

function renderJsonPathTemplate(item, root, template) {
  let out = '';
  let lastIndex = 0;
  const re = /\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(template)) !== null) {
    out += template.slice(lastIndex, match.index);
    lastIndex = re.lastIndex;
    const inner = match[1].trim();
    const literal = jsonPathQuotedLiteral(inner);
    if (literal !== null) {
      out += literal;
      continue;
    }
    const value = resolveJsonPathTokens(item, inner, root);
    if (Array.isArray(value)) out += value.join(' ');
    else if (value !== undefined && value !== null) out += typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  out += template.slice(lastIndex);
  return out;
}

function resolveJsonPathTokens(context, expression, root = context) {
  const expr = String(expression).trim().replace(/^\$/, '').replace(/^\./, '');
  if (!expr) return context;
  const segments = [];
  let i = 0;
  let current = '';
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '\\' && expr[i + 1] === '.') {
      current += '.';
      i += 2;
      continue;
    }
    if (ch === '.') {
      if (current) segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === '[') {
      if (current) {
        segments.push(current);
        current = '';
      }
      const end = expr.indexOf(']', i);
      const inside = end >= 0 ? expr.slice(i + 1, end) : '';
      segments.push(inside === '*' ? '*' : inside.replace(/['"]/g, ''));
      i = end >= 0 ? end + 1 : expr.length;
      continue;
    }
    current += ch;
    i++;
  }
  if (current) segments.push(current);
  let value = context;
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s];
    if (value === undefined || value === null) return undefined;
    if (segment === '*') {
      if (Array.isArray(value)) return value.map((entry) => resolvePathValue(entry, segments.slice(s + 1)));
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

/** YAML scalar formatting rules (deterministic, safe round-trip). */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((entry) => yamlScalar(entry)).join(', ')}]`;
  }
  if (typeof value === 'object') return '{}';
  const str = String(value);
  if (str === '') return '""';
  const needsQuotes =
    /^[\s]|[\s]$/.test(str) ||
    /[\n\r\t]/.test(str) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(str) ||
    /[:#]\s|\s#/.test(str) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(str) ||
    /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(str);
  if (!needsQuotes) return str;
  return JSON.stringify(str);
}

function yamlKey(key) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Deterministic YAML emitter (2-space indent) for the manifest objects built by
 * kindRegistry.toManifestObject. Used by `oc get -o yaml` and `oc process`.
 * @param {any} value
 * @param {number} [indent]
 * @returns {string}
 */
export function toYamlDocument(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return pad + 'null';
  if (typeof value !== 'object') return pad + yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const inner = toYamlDocument(item, indent + 2).split('\n');
          inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
          return inner.join('\n');
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join('\n');
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return pad + '{}';
  return entries
    .map(([key, entryValue]) => {
      const keyText = pad + yamlKey(key);
      if (entryValue !== null && typeof entryValue === 'object') {
        if (Array.isArray(entryValue) && entryValue.length === 0) return `${keyText}: []`;
        if (!Array.isArray(entryValue) && Object.keys(entryValue).length === 0) return `${keyText}: {}`;
        return `${keyText}:\n${toYamlDocument(entryValue, indent + 2)}`;
      }
      return `${keyText}: ${yamlScalar(entryValue)}`;
    })
    .join('\n');
}

/**
 * Join manifest objects as a multi-document YAML stream.
 * @param {object[]} objects
 * @returns {string}
 */
export function toYamlDocuments(objects) {
  return (objects || []).map((obj) => toYamlDocument(obj)).join('\n---\n');
}

/** Format a timestamp/age like oc (`5s`, `3m`, `2h`, `4d`, `13d`). */
export function formatAge(timestamp, now = Date.now()) {
  if (!timestamp) return '<unknown>';
  const then = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return '<unknown>';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** Format a duration (builds/jobs) like `12s`, `1m2s`. */
export function formatDuration(milliseconds) {
  const ms = Math.max(0, Number(milliseconds) || 0);
  if (ms < 1000) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Format a fixed-width oc-style table the way oc's tabwriter does (>=3 spaces
 * between columns, last column unpadded).
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function padTable(headers, rows) {
  if (!headers || headers.length === 0) return '';
  const widths = headers.map((header) => String(header).length);
  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      widths[i] = Math.max(widths[i], String(row[i] ?? '').length);
    }
  }
  const render = (cells) =>
    cells
      .map((cell, index) => {
        const text = String(cell ?? '');
        if (index === cells.length - 1) return text;
        return text.padEnd(widths[index] + 3);
      })
      .join('');
  return [render(headers), ...rows.map(render)].join('\n');
}

/** Parse repeated `k=v,k2=v2` flag values into an object. */
export function parseCommaAssignments(values) {
  const out = {};
  const list = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
  for (const entry of list) {
    if (entry === true || entry === undefined) continue;
    for (const pair of String(entry).split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        if (pair.trim()) out[pair.trim()] = '';
        continue;
      }
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Deterministic pseudo-random integer from a string (for simulated metrics). */
export function stableHash(text, max) {
  let hash = 0;
  const str = String(text);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return max ? hash % max : hash;
}

/** Plural resource name for tables/errors (e.g. Deployment → deployments). */
export function pluralForKind(kind) {
  return KIND_PLURALS[kind] || `${String(kind).toLowerCase()}s`;
}

/** `kind.group` singular used by oc create/delete success lines. */
export function refNameForKind(kind) {
  return KIND_REF_NAMES[kind] || String(kind).toLowerCase();
}

/** Parse the header string exported by the kind registry into column names. */
export function splitHeaderCells(header) {
  return String(header || 'NAME      AGE')
    .trim()
    .split(/\s{2,}/)
    .map((cell) => cell.trim())
    .filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────────────
// `oc explain` field database (OpenShift kinds get first-class entries).
// Descriptions come from kindRegistry.explainForKind(kind); fields are below.
// ────────────────────────────────────────────────────────────────────────────

const EXPLAIN_FIELDS = {
  Pod: {
    'spec': 'PodSpec - Specification of the desired behavior of the pod.',
    'spec.containers': 'Container[] - List of containers belonging to the pod.',
    'spec.containers.name': 'string - Name of the container.',
    'spec.containers.image': 'string - Container image name.',
    'spec.containers.ports': 'ContainerPort[] - Ports exposed from the container.',
    'spec.containers.env': 'EnvVar[] - Environment variables to set in the container.',
    'spec.containers.resources': 'ResourceRequirements - Compute Resources required by this container.',
    'spec.containers.resources.requests': 'map[string]Quantity - Minimum amount of compute resources required.',
    'spec.containers.resources.limits': 'map[string]Quantity - Maximum amount of compute resources allowed.',
    'spec.containers.livenessProbe': 'Probe - Periodic probe of container liveness.',
    'spec.containers.readinessProbe': 'Probe - Periodic probe of container service readiness.',
    'spec.containers.securityContext': 'SecurityContext - Security options the container should run with (privileged, runAsUser, ...).',
    'spec.serviceAccountName': 'string - Name of the ServiceAccount to use.',
    'spec.nodeName': 'string - NodeName requests scheduling on a specific node.',
    'spec.nodeSelector': 'map[string]string - Selector for node scheduling.',
    'spec.volumes': 'Volume[] - List of volumes that can be mounted by containers.',
    'spec.restartPolicy': 'string - Restart policy: Always, OnFailure, Never. Default: Always.',
    'metadata': 'ObjectMeta - Standard object metadata.',
    'metadata.name': 'string - Name must be unique within a project.',
    'metadata.namespace': 'string - Project (namespace) of the object. Default: "default".',
    'metadata.labels': 'map[string]string - Map of string keys and values for organization and selection.',
    'metadata.annotations': 'map[string]string - Unstructured key-value data.',
    'status': 'PodStatus - Most recently observed status of the pod.',
    'status.phase': 'string - Current phase: Pending, Running, Succeeded, Failed, Unknown.',
    'status.podIP': 'string - IP address allocated to the pod.',
    'status.containerStatuses': 'ContainerStatus[] - Most recently observed status of each container.',
  },
  Deployment: {
    'spec': 'DeploymentSpec - Specification of the desired behavior of the Deployment.',
    'spec.replicas': 'integer - Number of desired pods. Default: 1.',
    'spec.selector': 'LabelSelector - Label selector for pods. Must match template labels.',
    'spec.selector.matchLabels': 'map[string]string - Label key/value pairs the selector matches.',
    'spec.template': 'PodTemplateSpec - Template describing the pods that will be created.',
    'spec.strategy': 'DeploymentStrategy - Strategy used to replace old pods.',
    'spec.strategy.type': 'string - Type of strategy: RollingUpdate or Recreate.',
    'spec.strategy.rollingUpdate.maxSurge': 'IntOrString - Maximum pods above the desired count during update.',
    'spec.strategy.rollingUpdate.maxUnavailable': 'IntOrString - Maximum pods unavailable during update.',
    'spec.revisionHistoryLimit': 'integer - Number of old ReplicaSets to retain for rollback. Default: 10.',
    'status': 'DeploymentStatus - Most recently observed status of the Deployment.',
    'status.replicas': 'integer - Total number of non-terminated pods.',
    'status.readyReplicas': 'integer - Number of ready pods.',
    'status.updatedReplicas': 'integer - Number of pods updated to the current template.',
    'status.availableReplicas': 'integer - Number of available pods.',
  },
  Service: {
    'spec': 'ServiceSpec - Specification of the desired behavior of the service.',
    'spec.type': 'string - Type: ClusterIP (default), NodePort, LoadBalancer, ExternalName.',
    'spec.selector': 'map[string]string - Routes traffic to pods matching these labels.',
    'spec.ports': 'ServicePort[] - List of ports exposed by this service.',
    'spec.ports.port': 'integer - Port exposed by the service (the ClusterIP port).',
    'spec.ports.targetPort': 'IntOrString - Port on the targeted pods.',
    'spec.ports.protocol': 'string - Protocol: TCP (default), UDP, SCTP.',
    'spec.clusterIP': 'string - ClusterIP of the service. "None" creates a headless service.',
    'status': 'ServiceStatus - Most recently observed status of the service.',
    'status.loadBalancer': 'LoadBalancerStatus - External load balancer (EXTERNAL-IP).',
  },
  Route: {
    'spec': 'RouteSpec - Specification of the desired route behavior.',
    'spec.host': 'string - Hostname the route is admitted on (generated from the project when empty).',
    'spec.path': 'string - Optional path the route matches. Default: "/".',
    'spec.to': 'RouteTargetReference - Service (or other backend) receiving traffic.',
    'spec.to.kind': 'string - Kind of the target resource. Default: Service.',
    'spec.to.name': 'string - Name of the target Service.',
    'spec.to.weight': 'integer - Relative weight for route backends. Default: 100.',
    'spec.port': 'RoutePort - Target port of the Service that receives traffic.',
    'spec.port.targetPort': 'IntOrString - Named or numeric port of the Service.',
    'spec.tls': 'TLSConfig - TLS termination configuration (omit for plain HTTP).',
    'spec.tls.termination': 'string - edge, passthrough or reencrypt.',
    'spec.tls.certificate': 'string - PEM certificate for edge/reencrypt termination.',
    'spec.tls.key': 'string - PEM private key for edge/reencrypt termination.',
    'spec.tls.caCertificate': 'string - PEM CA certificate for edge termination.',
    'spec.tls.destinationCACertificate': 'string - CA bundle used to verify the backend for reencrypt.',
    'spec.tls.insecureEdgeTerminationPolicy': 'string - Redirect, Allow or None (plain HTTP behavior).',
    'spec.wildcardPolicy': 'string - None or Subdomain.',
    'spec.alternateBackends': 'RouteTargetReference[] - Additional backends with weights.',
    'status': 'RouteStatus - Observed route admission.',
    'status.ingress': 'RouteIngress[] - Per-router admission state.',
    'status.ingress[0].host': 'string - Hostname the router admitted.',
    'status.ingress[0].routerName': 'string - Name of the admitting router (default).',
    'status.ingress[0].conditions': 'RouteIngressCondition[] - Admitted/Available conditions.',
  },
  BuildConfig: {
    'spec': 'BuildConfigSpec - Specification of a build.',
    'spec.source': 'BuildSource - Source of the build (Git, Binary, Dockerfile).',
    'spec.source.type': 'string - Git, Binary or Dockerfile.',
    'spec.source.git.uri': 'string - Git repository URI for the source.',
    'spec.source.git.ref': 'string - Git branch, tag or commit.',
    'spec.source.contextDir': 'string - Subdirectory of the source to build in.',
    'spec.strategy': 'BuildStrategy - How to build the image.',
    'spec.strategy.type': 'string - Source (S2I) or Docker.',
    'spec.strategy.sourceStrategy.from': 'ObjectReference - Builder ImageStreamTag, e.g. nodejs:20.',
    'spec.strategy.dockerStrategy.dockerfilePath': 'string - Path to the Dockerfile. Default: Dockerfile.',
    'spec.output': 'BuildOutput - Where to push the resulting image.',
    'spec.output.to': 'ObjectReference - ImageStreamTag to write, e.g. app:latest.',
    'spec.triggers': 'BuildTriggerPolicy[] - ConfigChange / ImageChange / Webhook triggers.',
    'spec.runPolicy': 'string - Serial, SerialLatestOnly or Parallel.',
    'status': 'BuildConfigStatus - Observed build history.',
    'status.lastVersion': 'integer - Last build version created.',
  },
  Build: {
    'spec': 'BuildSpec - Specification of one build execution.',
    'spec.source': 'BuildSource - Source snapshot for this build.',
    'spec.strategy': 'BuildStrategy - Strategy used to build the image.',
    'spec.output': 'BuildOutput - ImageStreamTag receiving the built image.',
    'spec.revision': 'SourceRevision - Git revision that was built.',
    'status': 'BuildStatus - Observed phase of the build.',
    'status.phase': 'string - New, Pending, Running, Complete, Failed or Cancelled.',
    'status.startTimestamp': 'string - When the build started (RFC3339).',
    'status.completionTimestamp': 'string - When the build finished (RFC3339).',
    'status.duration': 'integer - Build duration in nanoseconds.',
    'status.message': 'string - Human-readable reason when the build fails.',
  },
  ImageStream: {
    'spec': 'ImageStreamSpec - ImageStream configuration.',
    'spec.lookupPolicy': 'ImageLookupPolicy - Whether local image lookups are allowed.',
    'spec.lookupPolicy.local': 'boolean - Resolve image names locally instead of cluster-wide.',
    'spec.tags': 'TagReference[] - Tags managed by this image stream.',
    'spec.tags[0].name': 'string - Tag name, e.g. latest or v1.',
    'spec.tags[0].from': 'ObjectReference - Source of the tag (DockerImage or ImageStreamTag).',
    'spec.dockerImageRepository': 'string - External registry repository reference.',
    'status.tags': 'NamedTagEventList[] - Resolved image references per tag.',
    'status.tags[0].items': 'TagEvent[] - Image digests/pull specs for the tag.',
    'status.dockerImageRepository': 'string - Internal registry repository, e.g. image-registry.../<project>/<name>.',
  },
  Template: {
    'parameters': 'Parameter[] - Values substituted into objects at process time.',
    'parameters[0].name': 'string - Parameter name, referenced as ${NAME}.',
    'parameters[0].required': 'boolean - Fail processing when the parameter has no value.',
    'parameters[0].value': 'string - Default value.',
    'objects': 'runtime.RawExtension[] - Object definitions created by the template.',
    'message': 'string - Message printed after successful processing.',
  },
  Subscription: {
    'spec': 'SubscriptionSpec - Operator installation request (OLM).',
    'spec.name': 'string - Package name in the catalog.',
    'spec.channel': 'string - Channel to subscribe to, e.g. stable.',
    'spec.source': 'string - CatalogSource name, e.g. redhat-operators.',
    'spec.sourceNamespace': 'string - Project containing the CatalogSource (openshift-marketplace).',
    'spec.installPlanApproval': 'string - Automatic or Manual.',
    'status': 'SubscriptionStatus - Observed install state.',
    'status.phase': 'string - Installing, UpgradePending, Succeeded or Failed.',
    'status.installedCSV': 'string - ClusterServiceVersion currently installed.',
  },
  SecurityContextConstraints: {
    'priority': 'integer - Ordering priority when multiple SCCs apply; higher wins.',
    'allowPrivilegedContainer': 'boolean - Permit privileged containers.',
    'allowHostDirVolumePlugin': 'boolean - Permit hostPath volumes.',
    'allowHostNetwork': 'boolean - Permit hostNetwork pods.',
    'allowHostPorts': 'boolean - Permit hostPort/hostNetwork port usage.',
    'allowHostPID': 'boolean - Permit hostPID.',
    'allowHostIPC': 'boolean - Permit hostIPC.',
    'readOnlyRootFilesystem': 'boolean - Force read-only root filesystems.',
    'runAsUser': 'RunAsUserStrategyOptions - UID strategy: MustRunAsRange, MustRunAs or RunAsAny.',
    'seLinuxContext': 'SELinuxContextStrategyOptions - SELinux labelling strategy.',
    'fsGroup': 'FSGroupStrategyOptions - fsGroup strategy and allowed ranges.',
    'supplementalGroups': 'SupplementalGroupsStrategyOptions - supplementalGroups strategy.',
    'users': 'string[] - Users granted this SCC directly.',
    'groups': 'string[] - Groups granted this SCC (e.g. system:authenticated).',
  },
  ResourceQuota: {
    'spec': 'ResourceQuotaSpec - Enforced aggregate limits for the project.',
    'spec.hard': 'map[string]Quantity - Hard limits, e.g. pods: "20", requests.cpu: "4".',
    'spec.scopes': 'string[] - Restrict the quota to scopes such as BestEffort or NotTerminating.',
    'status': 'ResourceQuotaStatus - Observed usage.',
    'status.used': 'map[string]Quantity - Current usage per resource.',
  },
  LimitRange: {
    'spec': 'LimitRangeSpec - Defaults and limits applied at admission.',
    'spec.limits': 'LimitRangeItem[] - Per type (Container, Pod, PVC) constraints.',
    'spec.limits[0].type': 'string - Container, Pod, PersistentVolumeClaim, ImageStream or Image.',
    'spec.limits[0].default': 'map[string]Quantity - Default limits for containers.',
    'spec.limits[0].defaultRequest': 'map[string]Quantity - Default requests for containers.',
    'spec.limits[0].min': 'map[string]Quantity - Minimum allowed request/limit.',
    'spec.limits[0].max': 'map[string]Quantity - Maximum allowed request/limit.',
    'spec.limits[0].maxLimitRequestRatio': 'map[string]Quantity - Maximum limit/request ratio.',
  },
  ClusterResourceQuota: {
    'spec': 'ClusterResourceQuotaSpec - Quota applied across selected projects.',
    'spec.selector': 'ClusterResourceQuotaSelector - Project selection by label or annotation.',
    'spec.selector.labels.matchLabels': 'map[string]string - Projects with these labels are constrained.',
    'spec.selector.annotations': 'map[string]string - Projects with these annotations are constrained.',
    'spec.quota': 'ResourceQuotaSpec - Quota (hard limits) applied to each selected project.',
    'status': 'ClusterResourceQuotaStatus - Aggregate usage across selected projects.',
    'status.total': 'ResourceQuotaStatus - Sum of hard/used for all selected projects.',
  },
  Project: {
    'metadata': 'ObjectMeta - Standard object metadata; metadata.name is the project name.',
    'metadata.name': 'string - Project name (the namespace used by namespaced resources).',
    'metadata.annotations': 'map[string]string - openshift.io/display-name, openshift.io/description, openshift.io/requester.',
    'spec': 'ProjectSpec - Project display metadata.',
    'spec.displayName': 'string - Human-friendly display name shown in the console.',
    'spec.description': 'string - Project description.',
    'status': 'ProjectStatus - Observed project state.',
    'status.phase': 'string - Active or Terminating.',
  },
  User: {
    'metadata.name': 'string - User name (the identity known to the cluster).',
    'fullName': 'string - Full name of the user.',
    'identities': 'Identity[] - Provider identities mapped to this user (e.g. htpasswd:alice).',
    'groups': 'string[] - Groups the user belongs to.',
  },
  Group: {
    'metadata.name': 'string - Group name.',
    'users': 'string[] - Users that belong to the group.',
  },
  Node: {
    'spec': 'NodeSpec - Specification of the node.',
    'spec.taints': 'Taint[] - Taints that repel pods unless they tolerate them.',
    'spec.unschedulable': 'boolean - Marks the node unschedulable (cordon).',
    'status': 'NodeStatus - Most recently observed node state.',
    'status.conditions': 'NodeCondition[] - Ready, MemoryPressure, DiskPressure, PIDPressure.',
    'status.capacity': 'map[string]Quantity - Total resources (cpu, memory, pods).',
    'status.allocatable': 'map[string]Quantity - Resources available for scheduling.',
    'status.nodeInfo.kubeletVersion': 'string - Kubernetes version reported by the kubelet.',
  },
  ConfigMap: {
    'data': 'map[string]string - Key/value configuration data.',
    'binaryData': 'map[string][]byte - Binary data as base64 strings.',
    'immutable': 'boolean - Disallow updates when true.',
  },
  Secret: {
    'type': 'string - Opaque, kubernetes.io/tls, kubernetes.io/dockerconfigjson, Opaque (htpasswd) ...',
    'data': 'map[string][]byte - Base64 encoded secret values.',
    'stringData': 'map[string]string - Write-only convenience field (encoded by the API).',
    'immutable': 'boolean - Disallow updates when true.',
  },
  PersistentVolumeClaim: {
    'spec': 'PersistentVolumeClaimSpec - The storage request.',
    'spec.accessModes': 'string[] - ReadWriteOnce, ReadOnlyMany, ReadWriteMany, ReadWriteOncePod.',
    'spec.resources.requests.storage': 'Quantity - Requested storage size, e.g. 10Gi.',
    'spec.storageClassName': 'string - StorageClass to provision from (empty = default class).',
    'spec.volumeName': 'string - Bound PersistentVolume name.',
    'status.phase': 'string - Pending, Bound or Lost.',
  },
  HorizontalPodAutoscaler: {
    'spec': 'HorizontalPodAutoscalerSpec - Autoscaling behavior.',
    'spec.scaleTargetRef': 'CrossVersionObjectReference - Workload to scale.',
    'spec.minReplicas': 'integer - Lower bound on replicas. Default: 1.',
    'spec.maxReplicas': 'integer - Upper bound on replicas. Required.',
    'spec.metrics': 'MetricSpec[] - Resource (cpu/memory) or custom metrics used to scale.',
    'spec.behavior': 'HorizontalPodAutoscalerBehavior - Scale-up/down policies.',
  },
  NetworkPolicy: {
    'spec': 'NetworkPolicySpec - Allowed traffic for selected pods.',
    'spec.podSelector': 'LabelSelector - Pods this policy applies to (empty = all pods in project).',
    'spec.policyTypes': 'string[] - Ingress, Egress or both.',
    'spec.ingress': 'NetworkPolicyIngressRule[] - Allowed inbound rules.',
    'spec.egress': 'NetworkPolicyEgressRule[] - Allowed outbound rules.',
  },
  Ingress: {
    'spec': 'IngressSpec - Routing rules served by the OpenShift ingress controller.',
    'spec.rules': 'IngressRule[] - Host/path routing rules.',
    'spec.rules[0].host': 'string - Hostname to match.',
    'spec.rules[0].http.paths': 'HTTPIngressPath[] - Path → service routing.',
    'spec.tls': 'IngressTLS[] - TLS configuration referencing a secret.',
  },
  Job: {
    'spec': 'JobSpec - Desired completions for this job.',
    'spec.completions': 'integer - Number of successful pods required. Default: 1.',
    'spec.parallelism': 'integer - Maximum pods running in parallel.',
    'spec.backoffLimit': 'integer - Retries before the Job is marked failed.',
    'spec.activeDeadlineSeconds': 'integer - Deadline before the Job is terminated.',
    'spec.template': 'PodTemplateSpec - Template for the pods the Job creates.',
    'status.phase': 'string - Pending, Running, Complete or Failed.',
  },
  CronJob: {
    'spec': 'CronJobSpec - Schedule and job template.',
    'spec.schedule': 'string - Cron schedule, e.g. "*/5 * * * *".',
    'spec.concurrencyPolicy': 'string - Allow, Forbid or Replace.',
    'spec.suspend': 'boolean - Suspend subsequent runs when true.',
    'spec.jobTemplate': 'JobTemplateSpec - Template for created Jobs.',
  },
  Role: {
    'rules': 'PolicyRule[] - Permissions granted by this Role.',
    'rules[0].verbs': 'string[] - get, list, watch, create, update, patch, delete, deletecollection.',
    'rules[0].apiGroups': 'string[] - API groups ("" for core).',
    'rules[0].resources': 'string[] - Resources (pods, routes.route.openshift.io, ...).',
  },
  RoleBinding: {
    'roleRef': 'RoleRef - Role or ClusterRole being bound.',
    'subjects': 'Subject[] - Users, Groups or ServiceAccounts receiving the permissions.',
  },
  ServiceAccount: {
    'secrets': 'ObjectReference[] - Secrets linked to the service account (legacy tokens/image pull secrets).',
    'imagePullSecrets': 'LocalObjectReference[] - Secrets used to pull private images.',
    'automountServiceAccountToken': 'boolean - Automatically mount an API token.',
  },
  StorageClass: {
    'provisioner': 'string - Storage provisioner plugin name.',
    'reclaimPolicy': 'string - Delete or Retain.',
    'volumeBindingMode': 'string - Immediate or WaitForFirstConsumer.',
    'allowVolumeExpansion': 'boolean - Allow PVCs to be expanded.',
  },
  OAuth: {
    'spec': 'OAuthSpec - Cluster authentication configuration (singleton named "cluster").',
    'spec.identityProviders': 'IdentityProvider[] - HTPasswd, LDAP, OIDC, ... providers.',
    'spec.identityProviders[0].type': 'string - HTPasswd, LDAP, OIDC, RequestHeader, ...',
    'spec.identityProviders[0].htpasswd.fileData.name': 'string - Secret (openshift-config) holding the htpasswd file.',
  },
  ClusterOperator: {
    'status': 'ClusterOperatorStatus - Health of a platform operator.',
    'status.conditions': 'ClusterOperatorStatusCondition[] - Available/Progressing/Degraded conditions.',
    'status.versions': 'OperandVersion[] - Versions of the operator and operands.',
  },
  ClusterVersion: {
    'spec': 'ClusterVersionSpec - Desired version and update channel.',
    'spec.channel': 'string - Update channel, e.g. stable-4.22.',
    'spec.desiredUpdate': 'Update - Version to update to.',
    'status': 'ClusterVersionStatus - Current version and update progress.',
    'status.desired.version': 'string - Version the cluster is converging to.',
    'status.history': 'UpdateHistory[] - Version change history.',
  },
  IPAddressPool: {
    'spec': 'IPAddressPoolSpec - MetalLB external IP range.',
    'spec.addresses': 'string[] - Address ranges, e.g. 192.168.100.200-192.168.100.210.',
    'spec.autoAssign': 'boolean - Automatically assign addresses to LoadBalancer services.',
  },
  L2Advertisement: {
    'spec': 'L2AdvertisementSpec - Layer 2 advertisement configuration.',
    'spec.ipAddressPools': 'string[] - Pools advertised over L2.',
    'spec.interfaces': 'string[] - Interfaces used to advertise (optional).',
  },
  Identity: {
    'providerName': 'string - Identity provider name, e.g. htpasswd.',
    'providerUserName': 'string - User name as known by the provider.',
    'user.name': 'string - OpenShift User this identity maps to.',
  },
  ReplicaSet: {
    'spec': 'ReplicaSetSpec - Desired replica count and template.',
    'spec.replicas': 'integer - Number of desired pods.',
    'spec.selector': 'LabelSelector - Label selector for managed pods.',
    'status.readyReplicas': 'integer - Number of ready pods.',
  },
  StatefulSet: {
    'spec': 'StatefulSetSpec - Desired state for a stateful workload.',
    'spec.replicas': 'integer - Number of desired pods.',
    'spec.serviceName': 'string - Headless Service governing the pod network identity.',
    'spec.volumeClaimTemplates': 'PersistentVolumeClaim[] - Per-pod storage requests.',
    'spec.template': 'PodTemplateSpec - Template for the pods.',
  },
  DaemonSet: {
    'spec': 'DaemonSetSpec - Desired state for the per-node workload.',
    'spec.selector': 'LabelSelector - Label selector for managed pods.',
    'spec.template': 'PodTemplateSpec - Template for the pods.',
  },
  PersistentVolume: {
    'spec': 'PersistentVolumeSpec - Cluster storage definition.',
    'spec.capacity.storage': 'Quantity - Storage capacity.',
    'spec.accessModes': 'string[] - Supported access modes.',
    'spec.persistentVolumeReclaimPolicy': 'string - Retain, Delete or Recycle.',
    'spec.storageClassName': 'string - StorageClass providing this volume.',
    'spec.claimRef': 'ObjectReference - PersistentVolumeClaim bound to this volume.',
  },
  PodDisruptionBudget: {
    'spec': 'PodDisruptionBudgetSpec - Availability budget during voluntary disruptions.',
    'spec.minAvailable': 'IntOrString - Minimum pods that must stay available.',
    'spec.maxUnavailable': 'IntOrString - Maximum pods that may be unavailable.',
    'spec.selector': 'LabelSelector - Pods this budget applies to.',
  },
  ClusterRole: {
    'rules': 'PolicyRule[] - Cluster-wide permissions granted by this role.',
  },
  ClusterRoleBinding: {
    'roleRef': 'RoleRef - ClusterRole being bound.',
    'subjects': 'Subject[] - Users, Groups or ServiceAccounts.',
  },
};

/**
 * Templates the simulator ships with when the cluster has no Template objects
 * yet (used by `oc get templates -n openshift` and `oc new-app --template`).
 */
const BUILTIN_TEMPLATES = {
  'webapp-template': {
    description: 'Web application (Deployment, Service and Route)',
    parameters: [
      { name: 'APP_NAME', displayName: 'Application name', required: true, value: 'webapp' },
      { name: 'IMAGE', displayName: 'Container image', required: true, value: 'nginx:latest' },
      { name: 'REPLICAS', displayName: 'Number of replicas', required: false, value: '2' },
    ],
    objects: [
      {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: '${APP_NAME}' },
        spec: {
          replicas: '${REPLICAS}', selector: { matchLabels: { app: '${APP_NAME}' } },
          template: { metadata: { labels: { app: '${APP_NAME}' } }, spec: { containers: [{ name: 'main', image: '${IMAGE}', ports: [{ containerPort: 8080 }] }] } },
        },
      },
      { apiVersion: 'v1', kind: 'Service', metadata: { name: '${APP_NAME}' }, spec: { selector: { app: '${APP_NAME}' }, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] } },
      { apiVersion: 'route.openshift.io/v1', kind: 'Route', metadata: { name: '${APP_NAME}' }, spec: { to: { kind: 'Service', name: '${APP_NAME}', weight: 100 }, port: { targetPort: 'http' }, wildcardPolicy: 'None' } },
    ],
    message: 'Application ${APP_NAME} deployed. Run "oc get route ${APP_NAME}" to see the URL.',
  },
};

// ────────────────────────────────────────────────────────────────────────────
// CommandBar
// ────────────────────────────────────────────────────────────────────────────

export class CommandBar {
  constructor() {
    this.container = null;
    this.input = null;
    this.output = null;
    this.suggestionsEl = null;
    this.visible = false;

    /** Local command history (Up/Down); the engine keeps its own history too. */
    this.history = [];
    this.historyIndex = -1;

    this.suggestions = [];
    this.selectedSuggestion = -1;

    /** Captured output lines — lets the Node test harness read results. */
    this._outputLines = [];
    this._lastResult = null;
    this._stdinCounter = 0;

    this._boundKeydown = this._onGlobalKeydown.bind(this);
    this._boundShowCommandBar = () => this.show();
  }

  // ── Environment getters (window.game is the integration surface) ──────────

  get game() {
    return typeof window !== 'undefined' ? window.game : undefined;
  }

  /** Event bus (window.game.engine). */
  get eventBus() {
    return this.game?.engine;
  }

  /** ClusterState (window.game.cluster). */
  get cluster() {
    return this.game?.cluster;
  }

  /** GameEngine instance (window.game.gameEngine). */
  get gameEngine() {
    return this.game?.gameEngine;
  }

  /** ManifestEngine (window.game.manifestEngine), set by ManifestPanel.init(). */
  get manifestEngine() {
    return this.game?.manifestEngine;
  }

  get currentUser() {
    const ge = this.gameEngine;
    const user = ge?.currentUser;
    return user === undefined || user === null || user === '' ? 'kubeadmin' : user;
  }

  get currentProject() {
    const ge = this.gameEngine;
    return ge?.currentProject || ge?.currentNamespace || 'default';
  }

  // ── DOM lifecycle ─────────────────────────────────────────────────────────

  init() {
    if (typeof document === 'undefined') return;
    if (this.container?.isConnected) return;
    this.container?.remove();
    this.container = document.createElement('div');
    this.container.id = 'command-bar';
    this.container.className = 'term-container';
    this.container.setAttribute('aria-label', 'oc terminal');
    this.container.innerHTML = this._buildHTML();
    document.body.appendChild(this.container);

    this.input = document.getElementById('cmd-input');
    this.output = document.getElementById('cmd-output');
    this.suggestionsEl = document.getElementById('cmd-suggestions');

    this._bindEvents();
    this._updateContextLabel();
    this._appendOutput(
      `oc terminal ready — OpenShift 4.22. Type 'oc --help' for commands, '/' toggles the terminal.`,
      'text-white/30',
    );
  }

  _buildHTML() {
    return `
      <div class="term-dock">
        <div class="term-head">
          <div class="term-title">
            <span class="term-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="term-name">oc</span>
            <span class="term-platform">OpenShift 4.22</span>
            <span class="term-ctx" id="cmd-context">kubeadmin · default</span>
          </div>
          <div class="term-head-actions">
            <span class="term-hint">Close <kbd>Esc</kbd></span>
            <button id="cmd-close" class="term-close" type="button" aria-label="Close terminal">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>
        <div id="cmd-output" class="term-output" role="log" aria-live="polite"></div>
        <div class="term-prompt-row">
          <span class="term-prompt" aria-hidden="true">$</span>
          <input id="cmd-input" type="text" class="term-input" placeholder="Type a command — the 'oc ' prefix is optional" autocomplete="off" spellcheck="false" autocapitalize="off" />
        </div>
        <div id="cmd-suggestions" class="term-suggestions" hidden></div>
      </div>
    `;
  }

  _updateContextLabel() {
    const el = document.getElementById('cmd-context');
    if (!el) return;
    const user = this.currentUser || 'kubeadmin';
    const project = this.currentProject || 'default';
    el.textContent = `${user} · ${project}`;
  }

  _bindEvents() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', this._boundKeydown);

    document.getElementById('cmd-close')?.addEventListener('click', () => this.hide());
    if (this.input) {
      this.input.addEventListener('keydown', (e) => this._onInputKeydown(e));
      this.input.addEventListener('input', () => this._onInputChange());
    }
    if (this.suggestionsEl) {
      this.suggestionsEl.addEventListener('click', (e) => {
        const el = e.target.closest('[data-idx]');
        if (!el) return;
        this._applySuggestion(this.suggestions[parseInt(el.dataset.idx, 10)]);
      });
    }
    this.eventBus?.on?.('ui:show-command-bar', this._boundShowCommandBar);
    for (const eventName of ['project:switched', 'login', 'logout']) {
      this.eventBus?.on?.(eventName, () => this._updateContextLabel());
    }
  }

  _onGlobalKeydown(e) {
    if (e.defaultPrevented) return;
    if (e.key === '/' && !this.visible && !e.ctrlKey && !e.metaKey) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      this.show();
    } else if (e.key === 'Escape' && this.visible) {
      this.hide();
    }
  }

  _onInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.selectedSuggestion >= 0 && this.suggestions.length > 0) {
        this._applySuggestion(this.suggestions[this.selectedSuggestion]);
        return;
      }
      this._executeCommand(this.input.value.trim());
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this._tabComplete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.suggestions.length > 0) {
        this.selectedSuggestion = Math.max(0, this.selectedSuggestion - 1);
        this._renderSuggestions();
      } else {
        this._navigateHistory(-1);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.suggestions.length > 0) {
        this.selectedSuggestion = Math.min(this.suggestions.length - 1, this.selectedSuggestion + 1);
        this._renderSuggestions();
      } else {
        this._navigateHistory(1);
      }
    }
  }

  _onInputChange() {
    this._updateSuggestions();
  }

  _navigateHistory(direction) {
    if (this.history.length === 0) return;
    this.historyIndex += direction;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex));
    if (this.input) this.input.value = this.historyIndex >= 0 ? this.history[this.historyIndex] : '';
  }

  // ── Tab completion ────────────────────────────────────────────────────────

  _completionContext() {
    const raw = this.input?.value ?? '';
    const prefixMatch = raw.match(INPUT_PREFIX_WORD_RE);
    const leading = prefixMatch ? prefixMatch[0] : '';
    const body = raw.slice(leading.length);
    const tokens = tokenizeCommand(body);
    if (tokens.length === 0 || /\s$/.test(body)) tokens.push('');
    return { leading, tokens };
  }

  _updateSuggestions() {
    if (!this.input || !this.suggestionsEl) return;
    const { leading, tokens } = this._completionContext();
    const current = tokens[tokens.length - 1] ?? '';
    const prior = tokens.slice(0, -1);
    const candidates = this._completionCandidates(prior, current);
    this.suggestions = candidates.slice(0, 10).map((value) => ({ type: 'completion', value: leading + value }));
    this.selectedSuggestion = -1;
    this._renderSuggestions();
  }

  /**
   * @param {string[]} prior complete tokens before the word being typed
   * @param {string} current partial word
   * @returns {string[]}
   */
  _completionCandidates(prior, current) {
    const word = String(current ?? '');
    const lower = word.toLowerCase();
    const filter = (items) => items.filter((item) => item.toLowerCase().startsWith(lower));
    const cmd = (prior[0] || '').toLowerCase();
    const projectNames = () => this._resources('Project').map((p) => p.metadata?.name).filter(Boolean);
    const fileNames = () => this._manifestFileList();
    const flagList = (extra = []) => {
      const flags = [...(COMMAND_FLAGS[cmd] || []), ...extra];
      return filter([...new Set(flags)]);
    };

    if (prior.length === 0) return filter(Object.keys(BASE_COMMANDS));
    if (word.startsWith('-')) {
      if (cmd === 'adm' && prior[1] === 'policy') return flagList(['-z', '-n', '--rolebinding-name']);
      return flagList();
    }
    if (current === '') {
      const previous = prior[prior.length - 1];
      if (previous === '-n' || previous === '--namespace') return filter(projectNames());
      if (previous === '-f' || previous === '--filename' || previous === '--file') return filter(fileNames());
      if (previous === '-k' || previous === '--kustomize') return filter(fileNames());
      if (previous === '-o' || previous === '--output') return filter(['wide', 'yaml', 'json', 'name', 'jsonpath=', 'custom-columns=']);
      if (previous === '-p' || previous === '--param' || previous === '-e' || previous === '--env') return [];
    }
    if (prior.length === 1) {
      const sub = SUBCOMMANDS[cmd];
      const kindTokens = filter(RESOURCE_TYPES);
      if (sub) {
        const merged = [...sub.filter((s) => s.startsWith(lower)), ...kindTokens];
        return [...new Set(merged)];
      }
      if (cmd === 'adm' || cmd === 'auth' || cmd === 'rollout' || cmd === 'expose' || cmd === 'create' || cmd === 'set') {
        return sub ? [...new Set([...sub, ...kindTokens])] : kindTokens;
      }
      return kindTokens;
    }
    // `oc adm policy <sub>` etc.
    if (prior.length === 2) {
      const group = `${cmd} ${prior[1].toLowerCase()}`;
      if (SUBCOMMANDS[group]) return filter(SUBCOMMANDS[group]);
    }
    // Resource-name completion once a kind is present.
    const resourceToken = prior.slice(1).find((token) => !token.startsWith('-') && normalizeKind(token));
    const kind = resourceToken ? normalizeKind(resourceToken) : null;
    if (kind) {
      const namespace = this._namespaceFromTokens(prior);
      const names = this._resources(kind)
        .filter((resource) => {
          if (isClusterScopedKind(kind)) return true;
          return !namespace || resource.metadata?.namespace === namespace;
        })
        .map((resource) => resource.metadata?.name || '')
        .filter(Boolean)
        .filter((name) => name.toLowerCase().startsWith(lower));
      if (names.length) return names;
    }
    return [];
  }

  _namespaceFromTokens(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '-n' || tokens[i] === '--namespace') return tokens[i + 1];
    }
    return null;
  }

  _renderSuggestions() {
    if (!this.suggestionsEl) return;
    if (this.suggestions.length === 0) {
      this.suggestionsEl.hidden = true;
      this.suggestionsEl.innerHTML = '';
      return;
    }
    this.suggestionsEl.hidden = false;
    this.suggestionsEl.innerHTML = `
      <div class="term-suggestion-list">
        ${this.suggestions
          .map(
            (suggestion, i) => `
          <div class="term-suggestion${i === this.selectedSuggestion ? ' is-selected' : ''}" data-idx="${i}">
            <span class="term-suggestion-kind">${this._escapeHTML(suggestion.type || 'command')}</span>
            <span class="term-suggestion-value">${this._escapeHTML(suggestion.value)}</span>
          </div>`,
          )
          .join('')}
      </div>
    `;
  }

  _applySuggestion(suggestion) {
    if (!suggestion || !this.input) return;
    this.input.value = suggestion.value + ' ';
    this.suggestions = [];
    this.selectedSuggestion = -1;
    if (this.suggestionsEl) this.suggestionsEl.hidden = true;
    this.input.focus();
  }

  _tabComplete() {
    if (this.suggestions.length === 1) {
      this._applySuggestion(this.suggestions[0]);
    } else if (this.suggestions.length > 1) {
      this.selectedSuggestion = (this.selectedSuggestion + 1) % this.suggestions.length;
      this._renderSuggestions();
    }
  }

  // ── Command execution ─────────────────────────────────────────────────────

  /**
   * Public entry point used by the verifier and other UI surfaces.
   * Executes a raw command line (optionally prefixed with `oc`/`kubectl`) and
   * returns {error, message, raw, normalized, baseCommand, success}.
   * @param {string} raw
   * @returns {{error:boolean, message:string, raw:string, normalized:string, baseCommand:string, success:boolean}}
   */
  executeCommand(raw) {
    let result;
    try {
      result = this._runCommandLine(raw);
    } catch (error) {
      const message = `error: internal command failure: ${error && error.message ? error.message : error}`;
      this._appendOutput(message, 'text-red-400');
      result = { error: true, message, raw: String(raw ?? ''), normalized: '', baseCommand: '', success: false };
    }
    this._lastResult = result;
    return result;
  }

  /** Legacy entry point (index.html `ui:run-command` handler). */
  _executeCommand(raw) {
    return this.executeCommand(raw);
  }

  _runCommandLine(rawInput) {
    const raw = String(rawInput ?? '').trim();
    if (!raw) return { error: false, message: '', raw, normalized: '', baseCommand: '', success: true };

    this._pushHistory(raw);
    this._clearInput();

    const { command: normalized, usedKubectl } = stripCommandPrefix(raw);
    const firstTokens = tokenizeCommand(normalized);
    const baseCommand = (firstTokens[0] || '').toLowerCase();

    this._echoCommand(normalized, usedKubectl);
    this._emit('command:raw', { command: normalized, raw, baseCommand });

    // Easter eggs short-circuit execution (never mutate the cluster).
    const easterEgg = this._checkEasterEggs(normalized);
    if (easterEgg) {
      this._appendOutput(easterEgg.message, easterEgg.color || 'text-amber-400');
      if (easterEgg.xp) this._emit('xp:gain', { amount: easterEgg.xp });
      if (easterEgg.achievement) this._emit('easter-egg:triggered', { id: easterEgg.achievement });
      this._recordCommand(raw, baseCommand, true);
      this._emit('command:executed', { command: normalized, raw, baseCommand, success: true, timestamp: Date.now() });
      return { error: false, message: easterEgg.message, raw, normalized, baseCommand, success: true };
    }

    const { stages, redirect } = splitPipeline(normalized);
    const outputs = [];
    let stdin = null;
    let failed = false;
    let failureMessage = '';

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const isLast = i === stages.length - 1;
      const result = this._runStage(stage, stdin);
      if (result.error) {
        failed = true;
        failureMessage = result.message || 'error: command failed';
        break;
      }
      const text = result.message || '';
      if (isLast && redirect) {
        const written = this._writeRedirect(redirect, text);
        if (written.error) {
          failed = true;
          failureMessage = written.message;
        } else {
          this._appendOutput(written.message, 'text-white/30');
          outputs.push(written.message || '');
        }
      } else if (isLast) {
        if (text) this._appendOutput(text, 'text-white/70');
        outputs.push(text);
      } else {
        // Pipes: stdout feeds the next stage and is not echoed by the shell.
        stdin = text;
      }
    }

    if (failed) this._appendOutput(failureMessage, 'text-red-400');

    const message = failed ? failureMessage : outputs.filter(Boolean).join('\n');
    const success = !failed;
    this._recordCommand(raw, baseCommand, success);
    this._emit('command:executed', { command: normalized, raw, baseCommand, success, timestamp: Date.now() });
    if (success && MUTATING_COMMANDS.has(baseCommand)) this._emitMutationAuthCheck(normalized, baseCommand);
    return { error: failed, message, raw, normalized, baseCommand, success };
  }

  _runStage(stage, stdin) {
    // Stages after a pipe may repeat the `oc`/`kubectl` prefix
    // (`oc process ... | oc apply -f -`), so normalise every stage.
    const { command } = stripCommandPrefix(stage);
    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) return { error: false, message: '' };
    const first = tokens[0].toLowerCase();
    if (first === 'help') return this._cmdHelp(tokens.slice(1));
    if (first === '--help' || first === '-h') return this._cmdHelp([]);
    if (first === '--version') return this._cmdVersion([]);
    if (tokens.includes('--help') || tokens.includes('-h')) {
      return this._cmdHelp(tokens.filter((token) => !token.startsWith('-')));
    }
    const flagError = this._validateFlags(tokens);
    if (flagError) return flagError;
    return this._dispatch(tokens, { stdin: stdin ?? null });
  }

  /**
   * Reject flags the simulated `oc` does not implement, like cobra does.
   * Accepted flags are the union used anywhere in the CLI; values after `--`
   * are never inspected.
   * @param {string[]} tokens
   * @returns {{error:true,message:string}|null}
   */
  _validateFlags(tokens) {
    const command = String(tokens[0] || '').toLowerCase();
    for (let i = 0; i < tokens.length; i++) {
      const token = String(tokens[i]);
      if (token === '--') break;
      if (token === '-' || !token.startsWith('-')) continue;
      if (/^-\d/.test(token)) continue;
      if (token.startsWith('--')) {
        const name = token.slice(2).split('=')[0];
        if (!KNOWN_LONG_FLAGS.has(name)) {
          return this._err(`Error: unknown flag: --${name}\nSee 'oc ${command} --help' for usage.`);
        }
        continue;
      }
      const rest = token.slice(1).split('=')[0];
      for (const char of rest) {
        if (/[A-Za-z]/.test(char) && !KNOWN_SHORT_FLAGS.has(char)) {
          return this._err(`Error: unknown shorthand flag: '${char}' in ${token}\nSee 'oc ${command} --help' for usage.`);
        }
      }
    }
    return null;
  }

  _dispatch(tokens, ctx) {
    const cmd = (tokens[0] || '').toLowerCase();
    const args = tokens.slice(1);
    switch (cmd) {
      // Session / cluster context
      case 'login': return this._cmdLogin(args, ctx);
      case 'logout': return this._cmdLogout(args, ctx);
      case 'whoami': return this._cmdWhoami(args, ctx);
      case 'project': return this._cmdProject(args, ctx);
      case 'projects': return this._cmdProjects(args, ctx);
      case 'new-project': return this._cmdNewProject(args, ctx);
      case 'status': return this._cmdStatus(args, ctx);
      case 'config': return this._cmdConfig(args, ctx);
      case 'version': return this._cmdVersion(args, ctx);
      case 'api-resources': return this._cmdApiResources(args, ctx);
      // Querying
      case 'get': return this._cmdGet(args, ctx);
      case 'describe': return this._cmdDescribe(args, ctx);
      case 'logs': return this._cmdLogs(args, ctx);
      case 'events': return this._cmdGetEvents(args, ctx);
      case 'explain': return this._cmdExplain(args, ctx);
      // Mutations
      case 'create': return this._cmdCreate(args, ctx);
      case 'apply': return this._cmdApply(args, ctx);
      case 'replace': return this._cmdReplace(args, ctx);
      case 'delete': return this._cmdDelete(args, ctx);
      case 'scale': return this._cmdScale(args, ctx);
      case 'edit': return this._cmdEdit(args, ctx);
      case 'label': return this._cmdLabelAnnotate(args, ctx, 'labels');
      case 'annotate': return this._cmdLabelAnnotate(args, ctx, 'annotations');
      case 'patch': return this._cmdPatch(args, ctx);
      case 'set': return this._cmdSet(args, ctx);
      case 'rollout': return this._cmdRollout(args, ctx);
      case 'expose': return this._cmdExpose(args, ctx);
      case 'run': return this._cmdRun(args, ctx);
      case 'exec': return this._cmdExec(args, ctx);
      case 'tag': return this._cmdTag(args, ctx);
      case 'import-image': return this._cmdImportImage(args, ctx);
      case 'extract': return this._cmdExtract(args, ctx);
      case 'new-app': return this._cmdNewApp(args, ctx);
      case 'new-build': return this._cmdNewBuild(args, ctx);
      case 'start-build': return this._cmdStartBuild(args, ctx);
      case 'cancel-build': return this._cmdCancelBuild(args, ctx);
      case 'process': return this._cmdProcess(args, ctx);
      case 'kustomize': return this._cmdKustomize(args, ctx);
      // Admin / identity / operators / files
      case 'adm': return this._cmdAdm(args, ctx);
      case 'auth': return this._cmdAuth(args, ctx);
      case 'debug': return this._cmdDebug(args, ctx);
      case 'helm': return this._cmdHelm(args, ctx);
      case 'htpasswd': return this._cmdHtpasswd(args, ctx);
      case 'help': return this._cmdHelp(args, ctx);
      // Backwards-compatible bare forms
      case 'cordon': return this._cmdAdm(['cordon', ...args], ctx);
      case 'uncordon': return this._cmdAdm(['uncordon', ...args], ctx);
      case 'drain': return this._cmdAdm(['drain', ...args], ctx);
      case 'top': return this._cmdAdm(['top', ...args], ctx);
      default: {
        const suggestion = this._closestCommand(cmd);
        const hint = suggestion ? `\n\nDid you mean this?\n\t${suggestion}\n` : '';
        return this._err(`error: unknown command "${cmd}" for "oc"${hint}\nRun 'oc --help' for usage.`);
      }
    }
  }

  _closestCommand(word) {
    const commands = Object.keys(BASE_COMMANDS);
    for (const candidate of commands) {
      if (candidate.startsWith(word) || word.startsWith(candidate)) return candidate;
    }
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of commands) {
      const distance = levenshtein(word, candidate);
      if (distance < bestDistance && distance <= 3) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  }

  // ── History / echo / output ───────────────────────────────────────────────

  _pushHistory(raw) {
    this.history.unshift(raw);
    if (this.history.length > 100) this.history.pop();
    this.historyIndex = -1;
  }

  _clearInput() {
    if (this.input) this.input.value = '';
    this.suggestions = [];
    this.selectedSuggestion = -1;
    this.suggestionsEl?.classList.add('hidden');
  }

  _echoCommand(normalized, usedKubectl) {
    this._appendOutput(`${OC_PROMPT} ${normalized}`, 'text-green-400/80');
    if (usedKubectl) {
      this._appendOutput('tip: on OpenShift, use oc — the oc command line is the supported interface.', 'text-amber-400/80');
    }
  }

  _recordCommand(raw, baseCommand, success) {
    const ge = this.gameEngine;
    if (ge && typeof ge.recordCommand === 'function') {
      try {
        ge.recordCommand(raw, success);
      } catch {
        /* non-fatal */
      }
    }
  }

  _emit(event, payload) {
    try {
      this.eventBus?.emit?.(event, payload);
    } catch {
      /* never let telemetry break the terminal */
    }
  }

  _emitMutationAuthCheck(normalized, baseCommand) {
    // GameEngine.recordCommand() already emits an auth:checked event for mutating
    // commands (it owns the RBAC model); only emit our fallback when it does not.
    if (this.gameEngine && typeof this.gameEngine.recordCommand === 'function') return;
    const tokens = tokenizeCommand(normalized);
    const kindToken = tokens.slice(1).find((token) => {
      const candidate = token.split('/')[0].split('.')[0];
      return normalizeKind(candidate);
    });
    const kind = kindToken ? normalizeKind(kindToken.split('/')[0].split('.')[0]) : null;
    const verb = baseCommand === 'get' ? 'get' : baseCommand;
    const resource = kind ? pluralForKind(kind) : 'resources';
    const namespace = this._namespaceFromTokens(tokens) || this.currentProject;
    const check = this._canI(verb, resource, namespace, this.currentUser);
    this._emit('auth:checked', {
      user: this.currentUser,
      verb,
      resource,
      namespace,
      allowed: check.allowed,
      reason: check.reason,
      command: normalized,
    });
  }

  // ── Output helpers ────────────────────────────────────────────────────────

  _appendOutput(text, colorClass = 'text-white/70') {
    const value = String(text ?? '');
    if (!value) return;
    this._outputLines.push({ text: value, colorClass });
    if (this._outputLines.length > 500) this._outputLines.shift();
    if (typeof document === 'undefined' || !this.output) return;
    const tone = TERM_TONES[colorClass] || 'out';
    const line = document.createElement('div');
    line.className = 'term-line';
    line.dataset.tone = tone;
    if (/^(oc|kubectl)/i.test(value) || value.startsWith('$ oc')) line.dataset.tone = 'cmd';
    line.textContent = value;
    this.output.appendChild(line);
    this.output.scrollTop = this.output.scrollHeight;
  }

  _escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Errors / results ──────────────────────────────────────────────────────

  _err(message) {
    return { error: true, message };
  }

  _ok(message) {
    return { error: false, message: message || '' };
  }

  _usageError(command, extra) {
    const entry = BASE_COMMANDS[command];
    const usage = entry ? entry.usage : `oc ${command}`;
    return this._err(`error: ${extra || 'invalid arguments'}\n\nUsage:\n  ${usage}\n\nRun 'oc ${command} --help' for details.`);
  }

  // ── Easter eggs (OpenShift flavour, harmless) ─────────────────────────────

  _checkEasterEggs(normalized) {
    const lower = String(normalized || '').toLowerCase().trim();
    if (lower === 'get coffee') {
      return {
        message: `Error from server (NotFound): the server doesn't have a resource type "coffee".\nBut here's a \u2615 for your effort! +5 XP`,
        xp: 5,
        achievement: 'coffee-break',
      };
    }
    if (lower === 'explain life') {
      return {
        message: 'KIND:     Life\nVERSION:  v1\n\nDESCRIPTION:\n  42. That is it. That is the explanation.',
        color: 'text-sky-400',
      };
    }
    if (/^run\s+\S+\s+.*--image=doom\b/.test(lower)) {
      return {
        message: 'Nice try. We run containers here, not demons. +10 XP',
        xp: 10,
        achievement: 'doom-runner',
      };
    }
    if (/^delete\s+(project|projects|namespace|namespaces|ns)\s+(kube-system|openshift-config|openshift-etcd|openshift-kube-apiserver)\b/.test(lower)) {
      return {
        message: 'WHOA! You just tried to remove a control-plane project. In production this would page every SRE on the planet. +25 XP',
        color: 'text-red-400',
        xp: 25,
        achievement: 'chaos-monkey',
      };
    }
    if (lower === 'adm upgrade') {
      return {
        message: 'Updating cluster to 4.23.0... just kidding. The cluster is already on the stable-4.22 channel. +5 XP',
        xp: 5,
        achievement: 'upgrade-dreamer',
      };
    }
    return null;
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  show() {
    if (!this.container) return;
    this.visible = true;
    this._updateContextLabel();
    this.container.classList.add('is-open');
    document.body.classList.add('terminal-open');
    requestAnimationFrame(() => this.input?.focus());
  }

  hide() {
    if (!this.container) return;
    this.visible = false;
    this.container.classList.remove('is-open');
    document.body.classList.remove('terminal-open');
    this.input?.blur();
    this.suggestions = [];
    if (this.suggestionsEl) this.suggestionsEl.hidden = true;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this._boundKeydown);
    this.eventBus?.off?.('ui:show-command-bar', this._boundShowCommandBar);
    this.container?.remove();
    this.container = null;
    this.visible = false;
    if (typeof document !== 'undefined') document.body?.classList.remove('terminal-open');
  }
}

/** Tiny Levenshtein distance used for "did you mean" hints. */
function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  const matrix = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[left.length][right.length];
}

// ────────────────────────────────────────────────────────────────────────────
// CommandBar — cluster / resource access helpers
// (methods continue on the prototype below; attached after the class body)
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  // ── Cluster queries ───────────────────────────────────────────────────────

  /** Raw resource list for a kind, tolerant of old/new ClusterState APIs. */
  _getKindList(kind) {
    const cluster = this.cluster;
    if (!cluster || !kind) return [];
    try {
      if (typeof cluster.getResourcesByKind === 'function') {
        return cluster.getResourcesByKind(kind) || [];
      }
      if (typeof cluster.getByKind === 'function') {
        return cluster.getByKind(kind) || [];
      }
    } catch {
      /* fall through */
    }
    return [];
  },

  /**
   * Resource list for a kind. Interim compatibility: if the engine still models
   * projects as `Namespace` objects, expose them under the Project kind.
   */
  _resources(kind) {
    const list = this._getKindList(kind);
    if (list.length === 0 && kind === 'Project') {
      return this._getKindList('Namespace');
    }
    return list;
  },

  _isNamespaced(kind) {
    return !isClusterScopedKind(kind);
  },

  _projectNames() {
    return this._resources('Project')
      .map((resource) => resource.metadata?.name)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b)));
  },

  _projectExists(name) {
    const projects = this._resources('Project');
    if (projects.length === 0) {
      // Engine not seeded yet: only the implicit default project is considered real.
      return name === 'default';
    }
    return projects.some((project) => project.metadata?.name === name);
  },

  _setCurrentProject(name) {
    const ge = this.gameEngine;
    const previous = this.currentProject;
    let usedEngine = false;
    if (ge && typeof ge.switchProject === 'function') {
      try {
        const result = ge.switchProject(name);
        if (result && (result.success === false || result.error)) {
          return this._err(result.message || `error: project "${name}" does not exist`);
        }
        usedEngine = true;
      } catch {
        /* fall through to property assignment */
      }
    }
    if (!usedEngine && ge) {
      if ('currentProject' in ge) ge.currentProject = name;
      else if ('currentNamespace' in ge) ge.currentNamespace = name;
    }
    // GameEngine.switchProject() emits `project:switched`; avoid a duplicate.
    if (!usedEngine) this._emit('project:switched', { project: name, previous });
    return { ok: true, project: name, previous };
  },

  _namespaceFromFlags(flags) {
    return flags.namespace || this.currentProject;
  },

  // ── Namespace existence (namespace NotFound fidelity) ─────────────────────
  // A real API server rejects a namespaced request whose namespace does not
  // exist with `Error from server (NotFound): namespaces "<name>" not found`.
  // Cluster-scoped kinds, `-A/--all-namespaces`, and requests that only resolve
  // unknown resource types are unaffected (the client-side type error wins).

  /** @returns {{error:true,message:string}|null} the error object, or null when valid. */
  _namespaceNotFoundError(namespace) {
    return this._err(`Error from server (NotFound): namespaces "${namespace}" not found`);
  },

  /**
   * Validate a namespace resolved from `-n/--namespace` or the current project.
   * @param {string} namespace
   * @returns {{error:true,message:string}|null}
   */
  _requireNamespace(namespace) {
    const name = String(namespace || '');
    if (!name) return null;
    if (this._projectExists(name)) return null;
    return this._namespaceNotFoundError(name);
  },

  /**
   * True when an `oc get <token…>` request is namespace-scoped like real oc.
   */
  _getRequestUsesNamespace(resourceToken) {
    const lower = String(resourceToken || '').toLowerCase();
    if (!lower) return false;
    for (const token of lower.split(',')) {
      if (NAMESPACED_VIRTUAL_GET_TOKENS.has(token) || ['event', 'events', 'ev', 'all'].includes(token)) return true;
      if (['ingresscontroller', 'ingresscontrollers', 'ic'].includes(token)) continue;
      let kind = resolveKindToken(token);
      if (!kind && ['dc', 'deploymentconfig', 'deploymentconfigs'].includes(token)) kind = 'Deployment';
      // Unknown resource type: `oc get` reports the type error, not the namespace.
      if (!kind) return false;
      if (this._isNamespaced(kind)) return true;
    }
    return false;
  },

  /**
   * Namespaces an `oc apply/create/replace/delete -f` request will touch:
   * an explicit `-n/--namespace` is enforced on every object (like kubectl's
   * EnforceNamespace); otherwise each namespaced manifest's metadata.namespace
   * is used, falling back to the current project.
   * Returns [] when the input can't be parsed — the Files engine owns those
   * parse/path errors.
   * @param {string} path '-' for stdin
   * @param {Record<string, any>} flags
   * @param {string|null} stdinText
   * @returns {string[]}
   */
  _manifestNamespaces(path, flags, stdinText) {
    const override = flags && flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
    if (override) return [override];
    let text = null;
    if (path === '-' && typeof stdinText === 'string') text = stdinText;
    else text = this._readVirtualFile(String(path));
    if (typeof text !== 'string') return [];
    let docs = [];
    try {
      docs = parseYaml(text);
    } catch {
      return [];
    }
    if (!Array.isArray(docs)) return [];
    const namespaces = new Set();
    const visit = (doc) => {
      if (!doc || typeof doc !== 'object') return;
      if (doc.kind === 'List' && Array.isArray(doc.items)) {
        for (const item of doc.items) visit(item);
        return;
      }
      if (!doc.kind) return;
      const kind = resolveKindToken(String(doc.kind));
      if (kind && isClusterScopedKind(kind)) return;
      const namespace = doc.metadata && doc.metadata.namespace ? String(doc.metadata.namespace) : this.currentProject;
      if (namespace) namespaces.add(namespace);
    };
    for (const doc of docs) visit(doc);
    return [...namespaces];
  },

  /**
   * Fail like real oc when a manifest targets a missing project.
   * @param {string} path '-' for stdin
   * @param {Record<string, any>} flags
   * @param {string|null} stdinText
   * @returns {{error:true,message:string}|null}
   */
  _requireManifestNamespaces(path, flags, stdinText) {
    for (const namespace of this._manifestNamespaces(path, flags, stdinText)) {
      const error = this._requireNamespace(namespace);
      if (error) return error;
    }
    return null;
  },

  /** Resolve `describe route/web`, `logs pod/web`, or `logs web` forms. */
  _resolveRef(positionals) {
    if (!positionals.length) return { kind: null, name: null };
    const first = positionals[0];
    if (isResourceRef(first)) {
      const { kind, name } = splitResourceRef(positionals);
      return { kind, name };
    }
    const kind = normalizeKind(first);
    if (kind) return { kind, name: positionals[1] || null };
    return { kind: null, name: first };
  },

  /**
   * Find a resource by name. When no explicit `-n` is given and the resource is
   * namespaced, prefer the current project but fall back to a unique match in
   * another project (keeps CLI usable while modes/controllers create resources
   * in a project other than the session's current one).
   */
  _findResource(kind, name, options = {}) {
    if (!kind || !name) return null;
    const list = this._resources(kind);
    if (!this._isNamespaced(kind)) {
      return list.find((resource) => resource.metadata?.name === name) || null;
    }
    const namespace = options.namespace || (options.explicitNamespace ? options.namespace : this.currentProject);
    const inNamespace = list.filter((resource) => resource.metadata?.namespace === namespace);
    const exact = inNamespace.find((resource) => resource.metadata?.name === name);
    if (exact) return exact;
    if (options.allowPrefix !== false) {
      const prefix = inNamespace.find((resource) => (resource.metadata?.name || '').startsWith(name));
      if (prefix) return prefix;
    }
    if (!options.explicitNamespace && !options.namespace) {
      const elsewhere = list.filter((resource) => (resource.metadata?.name || '') === name);
      if (elsewhere.length === 1) return elsewhere[0];
      if (!options.allowPrefix && elsewhere.length > 1) return elsewhere[0];
    }
    return null;
  },

  _findResourceExact(kind, name, namespace) {
    const list = this._resources(kind);
    if (!this._isNamespaced(kind)) return list.find((resource) => resource.metadata?.name === name) || null;
    return (
      list.find((resource) => resource.metadata?.name === name && (!namespace || resource.metadata?.namespace === namespace)) ||
      list.find((resource) => resource.metadata?.name === name) ||
      null
    );
  },

  _notFoundMessage(kind, name) {
    return `Error from server (NotFound): ${this._resourceNamePlural(kind)} "${name}" not found`;
  },

  _resourceGroup(kind) {
    const apiVersion = apiVersionForKind(kind);
    return apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
  },

  /** `routes.route.openshift.io` / `pods` — the resource name oc uses in errors. */
  _resourceNamePlural(kind) {
    const plural = pluralForKind(kind);
    const group = this._resourceGroup(kind);
    return group ? `${plural}.${group}` : plural;
  },

  _resourceTypeError(token) {
    return this._err(`error: the server doesn't have a resource type "${token}"`);
  },

  _resourceRef(kind) {
    return refNameForKind(kind);
  },

  // ── Events / telemetry ────────────────────────────────────────────────────

  _emitCreated(resource) {
    if (!resource) return;
    const kind = resource.kind;
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace || '';
    this._emit('resource:created', {
      kind,
      name,
      namespace,
      mode: 'command',
      concurrentPods: kind === 'Pod' ? this._getKindList('Pod').length : undefined,
      nodeCount: kind === 'Node' ? this._getKindList('Node').length : undefined,
    });
  },

  _emitApplied(resource) {
    if (!resource) return;
    this._emit('resource:applied', { kind: resource.kind, name: resource.metadata?.name, namespace: resource.metadata?.namespace });
  },

  // ── ManifestEngine (Files engine) integration ─────────────────────────────

  _manifestReady() {
    const me = this.manifestEngine;
    return Boolean(me && (typeof me.readFile === 'function' || typeof me.applyFile === 'function'));
  },

  _manifestNotReady() {
    return this._err(
      'error: Files engine not ready — manifests/kustomize/helm require the declarative engine.\n' +
        'Open the Files panel or wait for it to initialise, then retry.',
    );
  },

  _manifestFileList() {
    const me = this.manifestEngine;
    if (!me || typeof me.listFiles !== 'function') return [];
    try {
      const files = me.listFiles();
      const entries = Array.isArray(files) ? files : files && Array.isArray(files.files) ? files.files : [];
      return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.name || ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  },

  _readVirtualFile(path) {
    const me = this.manifestEngine;
    if (!me || typeof me.readFile !== 'function') return null;
    try {
      const text = me.readFile(path);
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  },

  _writeVirtualFile(path, content, options = {}) {
    const me = this.manifestEngine;
    if (!me || typeof me.writeFile !== 'function') return this._manifestNotReady();
    try {
      let value = String(content ?? '');
      if (options.append) {
        const existing = this._readVirtualFile(path);
        if (existing !== null) {
          value = existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + value;
        }
      }
      me.writeFile(path, value);
      return { ok: true };
    } catch (error) {
      return this._err(`error: unable to write "${path}": ${error && error.message ? error.message : error}`);
    }
  },

  _tempStdinPath(content) {
    const path = `.oc/stdin-${++this._stdinCounter}.yaml`;
    const written = this._writeVirtualFile(path, content);
    if (written.error) return null;
    return path;
  },

  _writeRedirect(redirect, text) {
    if (!this._manifestReady()) return this._manifestNotReady();
    const written = this._writeVirtualFile(redirect.file, text, { append: redirect.append });
    if (written.error) return written;
    const lineCount = String(text || '').split('\n').filter((line) => line.length > 0).length;
    return {
      ok: true,
      message: `(${redirect.append ? 'appended' : 'wrote'} ${lineCount} line${lineCount === 1 ? '' : 's'} to ${redirect.file})`,
    };
  },

  _resolveInputFile(path, stdinText) {
    if (path === '-') {
      if (stdinText === null || stdinText === undefined) return { error: this._err('error: no objects passed to apply') };
      const tempPath = this._tempStdinPath(stdinText);
      if (!tempPath) return { error: this._manifestNotReady() };
      return { file: tempPath };
    }
    return { file: path };
  },

  _applyFileDelegated(path, options = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    const namespaceError = this._requireManifestNamespaces(path, options.flags || {}, options.stdinText ?? null);
    if (namespaceError) return namespaceError;
    const resolved = this._resolveInputFile(path, options.stdinText);
    if (resolved.error) return resolved.error;
    const me = this.manifestEngine;
    if (typeof me.applyFile !== 'function') return this._manifestNotReady();
    // Real oc's `-n` sets the namespace for every applied object (kubectl's
    // EnforceNamespace); the Files panel keeps calling applyFile(path) unchanged.
    const namespaceOverride =
      options.flags && options.flags.namespace && options.flags.namespace !== true ? String(options.flags.namespace) : null;
    let result;
    try {
      result = namespaceOverride ? me.applyFile(resolved.file, { namespace: namespaceOverride }) : me.applyFile(resolved.file);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    return this._normalizeApplyResult(result, options.command || 'apply');
  },

  _applyKustomizeDelegated(dir, flags = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    const me = this.manifestEngine;
    if (typeof me.applyKustomize !== 'function') {
      return this._err('error: Files engine does not support kustomize yet (missing ManifestEngine.applyKustomize).');
    }
    const namespace = flags && flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
    if (namespace) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    let result;
    try {
      result = me.applyKustomize(dir, { namespace: namespace || undefined, autoCreateProjects: false });
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    return this._normalizeApplyResult(result, 'apply');
  },

  _deleteFileDelegated(path, options = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    const namespaceError = this._requireManifestNamespaces(path, options.flags || {}, options.stdinText ?? null);
    if (namespaceError) return namespaceError;
    const me = this.manifestEngine;
    const resolved = this._resolveInputFile(path, options.stdinText ?? null);
    if (resolved.error) return resolved.error;
    if (typeof me.deleteFileObjects === 'function') {
      let result;
      const namespaceOverride =
        options.flags && options.flags.namespace && options.flags.namespace !== true ? String(options.flags.namespace) : undefined;
      try {
        result = me.deleteFileObjects(resolved.file, { namespace: namespaceOverride });
      } catch (error) {
        return this._err(`error: ${error && error.message ? error.message : error}`);
      }
      return this._normalizeDeleteResult(result);
    }
    if (typeof me.deleteFile === 'function') {
      try {
        me.deleteFile(resolved.file);
        return this._ok('');
      } catch (error) {
        return this._err(`error: ${error && error.message ? error.message : error}`);
      }
    }
    return this._err('error: Files engine cannot delete objects from files yet (missing ManifestEngine.deleteFileObjects).');
  },

  _normalizeDeleteResult(result) {
    if (result === null || result === undefined) return this._ok('');
    if (typeof result === 'string') return this._ok(result);
    const entries = Array.isArray(result) ? result : Array.isArray(result.deleted) ? result.deleted : [];
    const lines = entries
      .map((entry) => {
        const kind = entry?.kind || entry?.resource?.kind;
        const name = entry?.metadata?.name || entry?.name;
        if (!kind || !name) return '';
        return `${this._resourceRef(kind)} "${name}" deleted`;
      })
      .filter(Boolean);
    const engineErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
    if (result.error || result.ok === false) {
      const messages = [...lines, ...new Set([...(result.error ? [result.error] : []), ...engineErrors])];
      return this._err(messages.length ? messages.join('\n') : 'error: delete failed');
    }
    return this._ok(lines.length ? lines.join('\n') : result.message || '');
  },

  _normalizeApplyResult(result, command) {
    if (result === false) return this._err('error: the files engine reported failure');
    if (typeof result === 'string') return this._ok(result);
    if (result === null || result === undefined) return this._ok('');
    const engineErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
    if (result.error || result.ok === false) {
      const messages = [...new Set([...(result.error ? [result.error] : []), ...engineErrors])];
      return this._err(messages.length ? messages.join('\n') : 'error: apply failed');
    }
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    const created = Array.isArray(result) ? result : Array.isArray(result.created) ? result.created : [];
    const updated = Array.isArray(result) ? [] : Array.isArray(result.updated) ? result.updated : [];
    const verbCreated = 'created';
    const verbUpdated = command === 'replace' ? 'replaced' : command === 'create' ? 'created' : 'configured';
    const lines = [];
    for (const warning of warnings) lines.push(`warning: ${warning}`);
    if (result.message && typeof result.message === 'string') lines.push(result.message);
    for (const entry of created) {
      const kind = entry?.kind || entry?.resource?.kind;
      const name = entry?.metadata?.name || entry?.name;
      if (kind && name) lines.push(`${this._resourceRef(kind)}/${name} ${verbCreated}`);
    }
    for (const entry of updated) {
      const kind = entry?.kind || entry?.resource?.kind;
      const name = entry?.metadata?.name || entry?.name;
      if (kind && name) lines.push(`${this._resourceRef(kind)}/${name} ${verbUpdated}`);
    }
    if (!lines.length && Array.isArray(result.resources)) {
      for (const resource of result.resources) {
        const kind = resource?.kind;
        const name = resource?.metadata?.name || resource?.name;
        if (kind && name) lines.push(`${this._resourceRef(kind)}/${name} configured`);
      }
    }
    return this._ok(lines.join('\n'));
  },

  _processTemplateDelegated(path, params, options = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    const me = this.manifestEngine;
    const resolved = this._resolveInputFile(path, options.stdinText);
    if (resolved.error) return resolved.error;
    if (typeof me.processTemplate !== 'function') {
      return this._err('error: Files engine does not support template processing yet (missing ManifestEngine.processTemplate).');
    }
    let result;
    try {
      result = me.processTemplate(resolved.file, params);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    if (typeof result === 'string') return { ok: true, text: result, objects: [] };
    if (result && (result.error || result.ok === false)) {
      const messages = [...new Set([...(result.error ? [result.error] : []), ...(Array.isArray(result.errors) ? result.errors : [])].filter(Boolean))];
      return this._err(messages.length ? messages.join('\n') : 'error: template processing failed');
    }
    const warnings = result && Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    const objects = result && (result.objects || result.docs);
    if (Array.isArray(objects)) {
      const text = result.yaml || toYamlDocuments(objects);
      return { ok: true, text: warnings.length ? `${warnings.map((warning) => `warning: ${warning}`).join('\n')}\n${text}` : text, objects, warnings };
    }
    if (result && typeof result.yaml === 'string') return { ok: true, text: result.yaml, objects: [], warnings };
    if (Array.isArray(result)) return { ok: true, text: toYamlDocuments(result), objects: result, warnings };
    if (result && typeof result.message === 'string') return { ok: true, text: result.message, objects: [], warnings };
    return { ok: true, text: '', objects: [], warnings };
  },

  _helmCall(method, args) {
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    if (typeof me[method] !== 'function') {
      return this._err(`error: Helm is not available in the files engine yet (missing ManifestEngine.${method}).`);
    }
    try {
      const result = me[method](...args);
      if (typeof result === 'string') return this._ok(result);
      if (result && (result.error || result.ok === false)) {
        const messages = [...new Set([...(result.error ? [result.error] : []), ...(Array.isArray(result.errors) ? result.errors : [])].filter(Boolean))];
        return this._err(messages.length ? messages.join('\n') : 'error: helm failed');
      }
      return { ok: true, result };
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
  },

  _htpasswdCall(action, user, password, file = 'htpasswd') {
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    const method = { add: 'htpasswdAdd', update: 'htpasswdUpdate', remove: 'htpasswdDelete', list: 'htpasswdList' }[action];
    if (!method || typeof me[method] !== 'function') {
      return this._err(`error: HTPasswd is not available in the files engine yet (missing ManifestEngine.${method}).`);
    }
    try {
      const result =
        action === 'list'
          ? me[method](file)
          : action === 'remove'
            ? me[method](user, file)
            : me[method](user, password, file);
      if (result && result.error) return this._err(typeof result.error === 'string' ? result.error : result.message || 'error: htpasswd failed');
      return { ok: true, result };
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
  },

  // ── Resource mutation helpers ─────────────────────────────────────────────

  _createObject(kind, name, spec, options = {}) {
    const namespaced = this._isNamespaced(kind);
    const namespace = namespaced ? options.namespace || this.currentProject : '';
    const object = {
      apiVersion: options.apiVersion || apiVersionForKind(kind),
      kind,
      metadata: {
        name,
        ...(namespaced ? { namespace } : {}),
        labels: options.labels || {},
        annotations: options.annotations || {},
      },
      spec: spec || {},
    };
    return this._applyObject(object);
  },

  /**
   * Upsert a manifest object. Uses GameEngine.applyManifestObject when available
   * (documented contract), otherwise falls back to direct ClusterState edits.
   * @returns {{error?:object, resource?:any, created?:boolean}}
   */
  _applyObject(object) {
    if (!object || !object.kind || !object.metadata?.name) {
      return { error: this._err('error: manifest object is missing apiVersion/kind/metadata.name') };
    }
    const kind = object.kind;
    const name = object.metadata.name;
    const namespace = this._isNamespaced(kind)
      ? object.metadata.namespace || this.currentProject
      : object.metadata.namespace || '';
    if (this._isNamespaced(kind) && namespace) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return { error: namespaceError };
    }
    const existing = this._findResourceExact(kind, name, namespace);
    const cluster = this.cluster;
    if (!cluster) return { error: this._err('Error: cluster is not initialised') };

    const ge = this.gameEngine;
    if (ge && typeof ge.applyManifestObject === 'function') {
      try {
        const normalised = {
          ...object,
          apiVersion: object.apiVersion || apiVersionForKind(kind),
          metadata: { ...object.metadata, ...(this._isNamespaced(kind) ? { namespace } : {}) },
        };
        const resource = ge.applyManifestObject(normalised);
        if (resource) {
          const created = !existing;
          if (created) this._emitCreated(resource);
          return { resource, created };
        }
        if (ge.lastApplyError) {
          return { error: this._err(`Error from server: ${ge.lastApplyError}`) };
        }
      } catch {
        /* fall back to direct manipulation */
      }
    }

    if (existing) {
      const updates = {};
      if (object.spec !== undefined) updates.spec = object.spec;
      if (object.status !== undefined) updates.status = object.status;
      const metadata = {};
      if (object.metadata.labels) metadata.labels = { ...(existing.metadata?.labels || {}), ...object.metadata.labels };
      if (object.metadata.annotations) metadata.annotations = { ...(existing.metadata?.annotations || {}), ...object.metadata.annotations };
      if (Object.keys(metadata).length) updates.metadata = metadata;
      try {
        if (typeof cluster.update === 'function') cluster.update(existing.metadata.uid, updates);
        else {
          if (updates.spec) existing.spec = updates.spec;
          if (updates.metadata?.labels) existing.metadata.labels = updates.metadata.labels;
          if (updates.metadata?.annotations) existing.metadata.annotations = updates.metadata.annotations;
        }
      } catch {
        /* best-effort */
      }
      return { resource: existing, created: false };
    }

    let resource = null;
    try {
      resource = createResource(kind, {
        name,
        namespace: this._isNamespaced(kind) ? namespace : '',
        labels: object.metadata.labels,
        annotations: object.metadata.annotations,
        spec: object.spec,
      });
    } catch {
      resource = null;
    }
    if (!resource) {
      return { error: this._err(`error: the server doesn't have a resource type "${kind}"`) };
    }
    resource.apiVersion = object.apiVersion || apiVersionForKind(kind) || resource.apiVersion;
    if (object.metadata.uid) resource.metadata.uid = object.metadata.uid;
    if (object.status) resource.status = object.status;
    try {
      cluster.add(resource);
    } catch (error) {
      return { error: this._err(`error: unable to create ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`) };
    }
    this._emitCreated(resource);
    return { resource, created: true };
  },

  /**
   * Mutate an existing resource's spec through a callback.
   * @returns {{error?:object, resource?:any, spec?:object, metadata?:object}}
   */
  _updateResource(kind, name, mutator, options = {}) {
    const resource = this._findResource(kind, name, {
      namespace: options.namespace,
      explicitNamespace: Boolean(options.namespace),
    });
    if (!resource) return { error: this._err(this._notFoundMessage(kind, name)) };
    const spec = JSON.parse(JSON.stringify(resource.spec || {}));
    const outcome = mutator(spec, resource) || {};
    if (outcome.error) return outcome;
    const cluster = this.cluster;
    const updates = { spec };
    if (outcome.metadata) updates.metadata = outcome.metadata;
    try {
      if (cluster && typeof cluster.update === 'function') cluster.update(resource.metadata.uid || resource.uid, updates);
      else {
        resource.spec = spec;
        if (outcome.metadata) Object.assign(resource.metadata, outcome.metadata);
      }
    } catch (error) {
      return { error: this._err(`error: unable to update ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`) };
    }
    return { ok: true, resource, spec, metadata: outcome.metadata };
  },

  _deleteResource(kind, name, options = {}) {
    const resource = this._findResource(kind, name, {
      namespace: options.namespace,
      explicitNamespace: Boolean(options.namespace),
    });
    if (!resource) return { error: this._err(this._notFoundMessage(kind, name)) };
    const uid = resource.metadata?.uid || resource.uid;
    const cluster = this.cluster;
    if (!cluster || typeof cluster.remove !== 'function') {
      return { error: this._err('error: cluster is not initialised') };
    }
    try {
      cluster.remove(uid);
    } catch (error) {
      return { error: this._err(`error: unable to delete ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`) };
    }
    if (kind === 'Project' && this.currentProject === name) {
      this._setCurrentProject('default');
    }
    return { ok: true, resource };
  },

  // ── RBAC evaluation (fallback when the engine has no canI) ────────────────

  _userGroups(userName) {
    const user = String(userName || this.currentUser);
    const groups = new Set(['system:authenticated']);
    const ge = this.gameEngine;
    const cluster = this.cluster;
    for (const holder of [cluster, ge]) {
      if (holder && typeof holder.getUserGroups === 'function') {
        try {
          const result = holder.getUserGroups(user);
          if (Array.isArray(result)) result.forEach((group) => groups.add(group));
          if (result && Array.isArray(result.groups)) result.groups.forEach((group) => groups.add(group));
        } catch {
          /* ignore */
        }
      }
    }
    const userResource = this._findResource('User', user, { allowPrefix: false });
    if (userResource?.spec?.groups) userResource.spec.groups.forEach((group) => groups.add(group));
    for (const group of this._resources('Group')) {
      const users = group.spec?.users || group.users || [];
      if (users.includes(user) && group.metadata?.name) groups.add(group.metadata.name);
    }
    return [...groups];
  },

  _subjectMatches(subject, userName, groups) {
    if (!subject || !subject.name) return false;
    if (subject.kind === 'Group') {
      return groups.includes(subject.name) || (subject.name === 'system:authenticated' && Boolean(userName));
    }
    if (subject.kind === 'User') return subject.name === userName;
    if (subject.kind === 'ServiceAccount') {
      const normalised = String(subject.name).startsWith('system:serviceaccount:')
        ? subject.name
        : `system:serviceaccount:${subject.namespace || 'default'}:${subject.name}`;
      return normalised === userName;
    }
    return subject.name === userName;
  },

  _evaluateRules(rules, verb, resource) {
    const resourcePlural = String(resource || '').toLowerCase();
    for (const rule of rules || []) {
      const verbs = rule.verbs || [];
      const verbMatches = verbs.includes('*') || verbs.includes(verb);
      if (!verbMatches) continue;
      for (const candidate of rule.resources || []) {
        if (candidate === '*' || candidate === resourcePlural) return true;
        if (candidate.includes('/') && candidate.split('/')[0] === resourcePlural) return true;
      }
    }
    return false;
  },

  _roleRules(kind, name, namespace) {
    if (kind === 'Role') {
      const role = this._resources('Role').find(
        (candidate) => candidate.metadata?.name === name && (!namespace || candidate.metadata?.namespace === namespace),
      );
      return role?.spec?.rules || [];
    }
    const clusterRole = this._resources('ClusterRole').find((candidate) => candidate.metadata?.name === name);
    if (clusterRole?.spec?.rules) return clusterRole.spec.rules;
    // Built-in OpenShift roles (defined even if the ClusterRole object is not modelled).
    switch (name) {
      case 'cluster-admin':
        return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
      case 'admin':
        return [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];
      case 'edit':
        return [
          {
            apiGroups: ['*'],
            resources: ['pods', 'services', 'deployments', 'deployments.apps', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'routes', 'buildconfigs', 'builds', 'imagestreams', 'configmaps', 'secrets', 'persistentvolumeclaims'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection'],
          },
        ];
      case 'view':
        return [{ apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list', 'watch'] }];
      case 'self-provisioner':
        return [{ apiGroups: ['project.openshift.io'], resources: ['projectrequests'], verbs: ['create'] }];
      default:
        return [];
    }
  },

  /** Evaluate an authorization check. @returns {{allowed:boolean, reason:string}} */
  _canI(verb, resource, namespace, user) {
    const targetUser = user || this.currentUser;
    const targetNamespace = namespace || this.currentProject;
    const ge = this.gameEngine;
    const cluster = this.cluster;
    for (const holder of [ge, cluster]) {
      if (holder && typeof holder.canI === 'function') {
        try {
          const result = holder.canI(verb, resource, targetNamespace, targetUser);
          if (typeof result === 'boolean') {
            return { allowed: result, reason: result ? 'allowed' : 'no RBAC policy matched' };
          }
          if (result && typeof result === 'object') {
            return { allowed: Boolean(result.allowed), reason: result.reason || (result.allowed ? 'allowed' : 'no RBAC policy matched') };
          }
        } catch {
          /* fall through */
        }
      }
    }
    const groups = this._userGroups(targetUser);
    if (targetUser === 'kubeadmin' || targetUser === 'system:admin' || groups.includes('system:cluster-admins')) {
      return { allowed: true, reason: 'cluster-admin' };
    }
    for (const binding of this._resources('ClusterRoleBinding')) {
      const subjects = binding.spec?.subjects || [];
      if (subjects.some((subject) => this._subjectMatches(subject, targetUser, groups))) {
        const roleRef = binding.spec?.roleRef || {};
        if (this._evaluateRules(this._roleRules(roleRef.kind || 'ClusterRole', roleRef.name), verb, resource)) {
          return { allowed: true, reason: `ClusterRoleBinding ${binding.metadata?.name}` };
        }
      }
    }
    for (const binding of this._resources('RoleBinding')) {
      if (this._isNamespaced('RoleBinding') && binding.metadata?.namespace !== targetNamespace) continue;
      const subjects = binding.spec?.subjects || [];
      if (!subjects.some((subject) => this._subjectMatches(subject, targetUser, groups))) continue;
      const roleRef = binding.spec?.roleRef || {};
      if (this._evaluateRules(this._roleRules(roleRef.kind || 'Role', roleRef.name, targetNamespace), verb, resource)) {
        return { allowed: true, reason: `RoleBinding ${binding.metadata?.name}` };
      }
    }
    return { allowed: false, reason: 'no RBAC policy matched' };
  },
});

// ────────────────────────────────────────────────────────────────────────────
// CommandBar — output formatting (`oc get` tables, YAML/JSON/name/jsonpath)
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  /** Interpret the `-o` flag. */
  _outputFormat(flags) {
    const raw = flags.output;
    if (raw === undefined || raw === null || raw === true) return { format: 'table', arg: null };
    const text = String(raw);
    if (text.startsWith('jsonpath=')) return { format: 'jsonpath', arg: text.slice('jsonpath='.length) };
    if (text.startsWith('custom-columns=')) return { format: 'custom-columns', arg: text.slice('custom-columns='.length) };
    if (text.startsWith('go-template=')) return { format: 'jsonpath', arg: text.slice('go-template='.length) };
    if (text.startsWith('template=')) return { format: 'jsonpath', arg: text.slice('template='.length) };
    if (text === 'jsonpath' || text === 'custom-columns') return { format: text, arg: null };
    if (['wide', 'yaml', 'json', 'name'].includes(text)) return { format: text, arg: null };
    return { format: 'table', arg: null };
  },

  _isAllNamespaces(flags, tokens) {
    return Boolean(flags.A || flags['all-namespaces'] || (tokens || []).includes('-A') || (tokens || []).includes('--all-namespaces'));
  },

  _labelString(resource) {
    const labels = resource?.metadata?.labels || resource?.labels || {};
    const entries = Object.entries(labels);
    if (!entries.length) return '';
    return entries.map(([key, value]) => `${key}=${value}`).join(',');
  },

  _creationAge(resource) {
    return formatAge(resource?.metadata?.creationTimestamp || resource?.creationTimestamp);
  },

  _containerList(resource) {
    return resource?.spec?.template?.spec?.containers || resource?.spec?.containers || [];
  },

  _podStatus(resource) {
    const phase = resource.status?.phase || resource.phase || 'Pending';
    const statuses = resource.status?.containerStatuses || resource.containerStatuses || [];
    if (!statuses.length) return { ready: phase === 'Running' ? '1/1' : '0/1', status: phase, restarts: 0 };
    const readyCount = statuses.filter((status) => status.ready).length;
    const total = statuses.length;
    let status = phase;
    for (const containerStatus of statuses) {
      const waiting = containerStatus.state?.waiting?.reason;
      const terminated = containerStatus.state?.terminated;
      if (waiting) {
        status = waiting;
        break;
      }
      if (terminated && phase !== 'Succeeded') {
        status = terminated.reason || (terminated.exitCode === 0 ? 'Completed' : 'Error');
        break;
      }
    }
    const restarts = statuses.reduce((sum, status) => sum + (status.restartCount || 0), 0);
    return { ready: `${readyCount}/${total}`, status, restarts };
  },

  _podReady(resource) {
    const statuses = resource.status?.containerStatuses || resource.containerStatuses || [];
    if (!statuses.length) return resource.status?.phase === 'Running' ? '1/1' : '0/1';
    return `${statuses.filter((status) => status.ready).length}/${statuses.length}`;
  },

  _nodeRoles(resource) {
    const labels = resource.metadata?.labels || {};
    const roles = Object.keys(labels)
      .filter((key) => key.startsWith('node-role.kubernetes.io/'))
      .map((key) => key.slice('node-role.kubernetes.io/'.length))
      .filter(Boolean);
    return roles.length ? roles.sort().join(',') : '<none>';
  },

  _nodeStatus(resource) {
    const conditions = resource.status?.conditions || resource.conditions || [];
    const ready = conditions.find((condition) => condition.type === 'Ready');
    const isReady = ready ? ready.status === 'True' : (resource.status?.phase || 'Running') === 'Running';
    const cordoned = Boolean(resource.spec?.unschedulable);
    if (!isReady) return 'NotReady';
    return cordoned ? 'Ready,SchedulingDisabled' : 'Ready';
  },

  _serviceClusterIP(resource) {
    if (resource.spec?.clusterIP) return resource.spec.clusterIP;
    if (resource.status?.clusterIP) return resource.status.clusterIP;
    if (resource.spec?.clusterIP === 'None') return 'None';
    const hash = stableHash(resource.metadata?.name || 'svc', 200) + 20;
    const last = stableHash(`${resource.metadata?.name}-last`, 250) + 1;
    return `172.30.${hash}.${last}`;
  },

  _externalIP(resource) {
    const type = resource.spec?.type || 'ClusterIP';
    if (type === 'LoadBalancer') {
      const ingress = resource.status?.loadBalancer?.ingress;
      if (Array.isArray(ingress) && ingress.length) {
        return ingress.map((entry) => entry.ip || entry.hostname || '<pending>').join(',');
      }
      return '<pending>';
    }
    if (type === 'ExternalName') return resource.spec?.externalName || '<none>';
    return '<none>';
  },

  _servicePorts(resource) {
    const ports = resource.spec?.ports || [];
    if (!ports.length) return '<none>';
    return ports
      .map((port) => {
        const value = port.port ?? port.targetPort ?? '';
        if (port.nodePort) return `${value}:${port.nodePort}/${port.protocol || 'TCP'}`;
        return `${value}/${port.protocol || 'TCP'}`;
      })
      .join(',');
  },

  /** One quota printer column (request = non-limits keys, limit = limits.* keys). */
  _quotaColumn(hard, used, column = 'request') {
    const parts = [];
    for (const key of Object.keys(hard || {}).sort()) {
      const isLimit = key.startsWith('limits.');
      if (column === 'limit' ? !isLimit : isLimit) continue;
      const usedValue = used?.[key];
      parts.push(`${key}: ${usedValue !== undefined ? usedValue : '0'}/${hard[key]}`);
    }
    return parts.join(', ') || '<none>';
  },

  _quotaSummary(hard, used) {
    return this._quotaColumn(hard, used, 'request');
  },

  _booleanCell(value) {
    return value ? 'True' : 'False';
  },

  /** Wide-mode extra columns (only where real oc -o wide differs). */
  _wideExtras(kind) {
    switch (kind) {
      case 'Pod':
        return [
          { header: 'IP', value: (resource) => resource.status?.podIP || resource.ip || '<none>' },
          { header: 'NODE', value: (resource) => resource.spec?.nodeName || resource.status?.hostIP || '<none>' },
          { header: 'NOMINATED NODE', value: () => '<none>' },
          { header: 'READINESS GATES', value: () => '<none>' },
        ];
      case 'Deployment':
        return [{ header: 'SELECTOR', value: (resource) => this._selectorString(resource.spec?.selector) }];
      case 'ReplicaSet':
      case 'StatefulSet':
      case 'DaemonSet':
        return [{ header: 'SELECTOR', value: (resource) => this._selectorString(resource.spec?.selector) }];
      case 'Service':
        return [{ header: 'SELECTOR', value: (resource) => this._selectorString(resource.spec?.selector, true) }];
      case 'Node':
        return [
          { header: 'INTERNAL-IP', value: (resource) => this._nodeAddress(resource, 'InternalIP') },
          { header: 'EXTERNAL-IP', value: (resource) => this._nodeAddress(resource, 'ExternalIP') },
          { header: 'OS-IMAGE', value: (resource) => resource.status?.nodeInfo?.osImage || RHCOS_OS_IMAGE },
          { header: 'KERNEL-VERSION', value: (resource) => resource.status?.nodeInfo?.kernelVersion || NODE_KERNEL_VERSION },
          { header: 'CONTAINER-RUNTIME', value: (resource) => resource.status?.nodeInfo?.containerRuntimeVersion || CRIO_RUNTIME },
        ];
      case 'CronJob':
        return [{ header: 'CONTAINERS', value: (resource) => this._containerList(resource).map((c) => c.name).join(',') || '<none>' }];
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        const subjectNames = (resource, kindName) =>
          (resource.spec?.subjects || [])
            .filter((subject) => subject.kind === kindName)
            .map((subject) => subject.name)
            .join(',');
        return [
          { header: 'USERS', value: (resource) => subjectNames(resource, 'User') },
          { header: 'GROUPS', value: (resource) => subjectNames(resource, 'Group') },
          { header: 'SERVICEACCOUNTS', value: (resource) => subjectNames(resource, 'ServiceAccount') },
        ];
      }
      default:
        return [];
    }
  },

  _nodeAddress(resource, type) {
    const addresses = resource.status?.addresses || [];
    const address = addresses.find((entry) => entry.type === type);
    return address?.address || (type === 'InternalIP' ? '10.0.0.' + (stableHash(resource.metadata?.name || 'node', 250) + 2) : '<none>');
  },

  _selectorString(selector, objectSelector = false) {
    if (!selector) return '<none>';
    const labels = selector.matchLabels || (objectSelector ? selector : null);
    if (!labels) return '<none>';
    const entries = Object.entries(labels);
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(',') : '<none>';
  },

  _routeHost(resource) {
    const admitted = resource.status?.ingress?.[0]?.host;
    if (admitted) return admitted;
    if (resource.spec?.host) return resource.spec.host;
    const project = resource.metadata?.namespace || 'default';
    return `${resource.metadata?.name || 'route'}-${project}.${APPS_DOMAIN}`;
  },

  _routeAdmitted(resource) {
    const conditions = resource.status?.ingress?.[0]?.conditions || [];
    const admitted = conditions.find((condition) => condition.type === 'Admitted');
    if (admitted) return admitted.status === 'True';
    return false;
  },

  _buildDuration(resource) {
    const status = resource.status || {};
    if (status.startTimestamp && status.completionTimestamp) {
      return formatDuration(new Date(status.completionTimestamp).getTime() - new Date(status.startTimestamp).getTime());
    }
    if (status.startTimestamp) return formatDuration(Date.now() - new Date(status.startTimestamp).getTime());
    return '0s';
  },

  /** Cells for the given kind keyed by the registry column headers. */
  _rowCells(kind, resource) {
    const name = resource.metadata?.name || resource.name || 'unknown';
    const age = this._creationAge(resource);
    switch (kind) {
      case 'Project': {
        const display = resource.spec?.displayName || resource.metadata?.annotations?.['openshift.io/display-name'] || '';
        const status = resource.status?.phase || resource.phase || 'Active';
        return { NAME: name, 'DISPLAY NAME': display, STATUS: status, AGE: age };
      }
      case 'Node': {
        return {
          NAME: name,
          STATUS: this._nodeStatus(resource),
          ROLES: this._nodeRoles(resource),
          AGE: age,
          VERSION: resource.status?.nodeInfo?.kubeletVersion || K8S_SERVER_VERSION,
        };
      }
      case 'Pod': {
        const pod = this._podStatus(resource);
        return { NAME: name, READY: pod.ready, STATUS: pod.status, RESTARTS: String(pod.restarts), AGE: age };
      }
      case 'Deployment': {
        const replicas = resource.spec?.replicas ?? 1;
        const ready = resource.status?.readyReplicas ?? 0;
        const updated = resource.status?.updatedReplicas ?? replicas;
        const available = resource.status?.availableReplicas ?? ready;
        return { NAME: name, READY: `${ready}/${replicas}`, 'UP-TO-DATE': String(updated), AVAILABLE: String(available), AGE: age };
      }
      case 'ReplicaSet': {
        const desired = resource.spec?.replicas ?? 0;
        const current = resource.status?.replicas ?? desired;
        const ready = resource.status?.readyReplicas ?? 0;
        return { NAME: name, DESIRED: String(desired), CURRENT: String(current), READY: String(ready), AGE: age };
      }
      case 'StatefulSet': {
        const replicas = resource.spec?.replicas ?? 0;
        const ready = resource.status?.readyReplicas ?? 0;
        return { NAME: name, READY: `${ready}/${replicas}`, AGE: age };
      }
      case 'DaemonSet': {
        return {
          NAME: name,
          DESIRED: String(resource.status?.desiredNumberScheduled ?? 0),
          CURRENT: String(resource.status?.currentNumberScheduled ?? 0),
          READY: String(resource.status?.numberReady ?? 0),
          'UP-TO-DATE': String(resource.status?.updatedNumberScheduled ?? 0),
          AVAILABLE: String(resource.status?.numberAvailable ?? 0),
          'NODE SELECTOR': this._selectorString(resource.spec?.template?.spec?.nodeSelector, true),
          AGE: age,
        };
      }
      case 'Job': {
        const succeeded = resource.status?.succeeded ?? 0;
        const completions = resource.spec?.completions ?? 1;
        const failed = (resource.status?.failed ?? 0) > 0;
        const active = resource.status?.active ?? 0;
        const status = resource.status?.completed
          ? 'Complete'
          : failed
            ? 'Failed'
            : active > 0
              ? 'Running'
              : resource.status?.startTime
                ? 'Pending'
                : 'Pending';
        return { NAME: name, STATUS: status, COMPLETIONS: `${succeeded}/${completions}`, DURATION: this._buildDuration(resource), AGE: age };
      }
      case 'CronJob': {
        const active = resource.status?.active?.length ?? 0;
        const last = resource.status?.lastScheduleTime;
        return {
          NAME: name,
          SCHEDULE: resource.spec?.schedule || '0 0 * * *',
          TIMEZONE: resource.spec?.timeZone || '',
          SUSPEND: String(Boolean(resource.spec?.suspend)),
          ACTIVE: String(active),
          'LAST SCHEDULE': last ? formatAge(last) : '<none>',
          AGE: age,
        };
      }
      case 'Service': {
        return {
          NAME: name,
          TYPE: resource.spec?.type || 'ClusterIP',
          'CLUSTER-IP': this._serviceClusterIP(resource),
          'EXTERNAL-IP': this._externalIP(resource),
          'PORT(S)': this._servicePorts(resource),
          AGE: age,
        };
      }
      case 'Route': {
        const tls = resource.spec?.tls;
        return {
          NAME: name,
          'HOST/PORT': this._routeHost(resource),
          PATH: resource.spec?.path ?? '/',
          SERVICES: resource.spec?.to?.name || '<none>',
          PORT: resource.spec?.port?.targetPort ?? '<all>',
          TERMINATION: tls ? tls.termination || '' : '',
          WILDCARD: resource.spec?.wildcardPolicy || 'None',
        };
      }
      case 'Ingress': {
        const rules = resource.spec?.rules || [];
        const hosts = rules.map((rule) => rule.host).filter(Boolean).join(',') || '*';
        const conditions = resource.status?.loadBalancer?.ingress || [];
        const address = conditions.map((entry) => entry.ip || entry.hostname).filter(Boolean).join(',') || '<none>';
        return { NAME: name, CLASS: resource.spec?.ingressClassName || '<none>', HOSTS: hosts, ADDRESS: address, PORTS: resource.spec?.tls?.length ? '80, 443' : '80', AGE: age };
      }
      case 'NetworkPolicy': {
        return { NAME: name, 'POD-SELECTOR': this._selectorString(resource.spec?.podSelector), AGE: age };
      }
      case 'ConfigMap': {
        const data = resource.spec?.data || resource.data || {};
        return { NAME: name, DATA: String(Object.keys(data).length), AGE: age };
      }
      case 'Secret': {
        const data = resource.spec?.data || resource.data || {};
        const type = resource.spec?.type || resource.type || 'Opaque';
        return { NAME: name, TYPE: type, DATA: String(Object.keys(data).length), AGE: age };
      }
      case 'PersistentVolumeClaim': {
        const capacity = resource.status?.capacity?.storage || resource.spec?.resources?.requests?.storage || '';
        const conditions = resource.status?.phase || resource.status?.state || 'Pending';
        return {
          NAME: name,
          STATUS: conditions,
          VOLUME: resource.spec?.volumeName || resource.status?.volumeName || '',
          CAPACITY: capacity,
          'ACCESS MODES': (resource.spec?.accessModes || []).join(','),
          STORAGECLASS: resource.spec?.storageClassName || resource.spec?.storageClass || '',
          VOLUMEATTRIBUTESCLASS: resource.spec?.volumeAttributesClassName || '<unset>',
          AGE: age,
        };
      }
      case 'PersistentVolume': {
        return {
          NAME: name,
          CAPACITY: resource.spec?.capacity?.storage || '',
          'ACCESS MODES': (resource.spec?.accessModes || []).join(','),
          'RECLAIM POLICY': resource.spec?.persistentVolumeReclaimPolicy || 'Retain',
          STATUS: resource.status?.phase || 'Available',
          CLAIM: resource.spec?.claimRef ? `${resource.spec.claimRef.namespace || 'default'}/${resource.spec.claimRef.name}` : '',
          STORAGECLASS: resource.spec?.storageClassName || '',
          VOLUMEATTRIBUTESCLASS: resource.spec?.volumeAttributesClassName || '<unset>',
          REASON: resource.status?.reason || '',
          AGE: age,
        };
      }
      case 'StorageClass': {
        return {
          NAME: name,
          PROVISIONER: resource.spec?.provisioner || '',
          RECLAIMPOLICY: resource.spec?.reclaimPolicy || 'Delete',
          VOLUMEBINDINGMODE: resource.spec?.volumeBindingMode || 'Immediate',
          ALLOWVOLUMEEXPANSION: this._booleanCell(Boolean(resource.spec?.allowVolumeExpansion)),
          AGE: age,
        };
      }
      case 'HorizontalPodAutoscaler': {
        const target = resource.spec?.scaleTargetRef || {};
        const targetMetric = resource.spec?.metrics?.[0]?.resource?.target?.averageUtilization;
        const current = resource.status?.currentCPUUtilizationPercentage ?? targetMetric ?? 0;
        return {
          NAME: name,
          REFERENCE: `${(target.kind || 'Deployment').toLowerCase()}/${target.name || 'app'}`,
          TARGETS: `${current}%/${targetMetric || 70}%`,
          MINPODS: String(resource.spec?.minReplicas ?? 1),
          MAXPODS: String(resource.spec?.maxReplicas ?? 10),
          REPLICAS: String(resource.status?.currentReplicas ?? resource.status?.replicas ?? resource.spec?.minReplicas ?? 1),
          AGE: age,
        };
      }
      case 'PodDisruptionBudget': {
        const allowed = resource.status?.disruptionsAllowed ?? Math.max(0, (resource.spec?.minAvailable ?? 1) - 0);
        return {
          NAME: name,
          'MIN AVAILABLE': resource.spec?.minAvailable !== undefined ? String(resource.spec.minAvailable) : 'N/A',
          'MAX UNAVAILABLE': resource.spec?.maxUnavailable !== undefined ? String(resource.spec.maxUnavailable) : 'N/A',
          'ALLOWED DISRUPTIONS': String(allowed),
          AGE: age,
        };
      }
      case 'ResourceQuota': {
        const hard = resource.spec?.hard || resource.hard || {};
        const used = resource.status?.used || resource.used || {};
        return {
          NAME: name,
          AGE: age,
          REQUEST: this._quotaColumn(hard, used, 'request'),
          LIMIT: this._quotaColumn(hard, used, 'limit'),
        };
      }
      case 'LimitRange': {
        return {
          NAME: name,
          'CREATED AT': formatAge(resource.metadata?.creationTimestamp || resource.creationTimestamp),
        };
      }
      case 'ClusterResourceQuota': {
        const hard = resource.spec?.quota?.hard || resource.spec?.hard || {};
        const used = resource.status?.total?.used || {};
        return { NAME: name, AGE: age, REQUEST: this._quotaColumn(hard, used, 'request'), LIMIT: this._quotaColumn(hard, used, 'limit') };
      }
      case 'Role':
      case 'ClusterRole': {
        return { NAME: name, 'CREATED AT': formatAge(resource.metadata?.creationTimestamp || resource.creationTimestamp) };
      }
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        const subjects = resource.spec?.subjects || [];
        const byKind = (kindName) => subjects.filter((subject) => subject.kind === kindName).map((subject) => subject.name).join(',');
        return {
          NAME: name,
          ROLE: resource.spec?.roleRef?.name || '<none>',
          AGE: age,
          USERS: byKind('User'),
          GROUPS: byKind('Group'),
          SERVICEACCOUNTS: byKind('ServiceAccount'),
        };
      }
      case 'ServiceAccount': {
        return { NAME: name, AGE: age };
      }
      case 'SecurityContextConstraints': {
        const spec = resource.spec || resource;
        return {
          NAME: name,
          PRIV: this._booleanCell(Boolean(spec.allowPrivilegedContainer)),
          CAPS: '<none>',
          SELINUX: spec.seLinuxContext?.type || 'MustRunAs',
          RUNASUSER: spec.runAsUser?.type || 'MustRunAsRange',
          FSGROUP: spec.fsGroup?.type || 'MustRunAs',
          SUPGROUP: spec.supplementalGroups?.type || 'MustRunAs',
          PRIORITY: String(spec.priority ?? 0),
          READONLYROOTFS: this._booleanCell(Boolean(spec.readOnlyRootFilesystem)),
          VOLUMES: spec.allowHostDirVolumePlugin ? 'configMap,downwardAPI,emptyDir,hostPath,persistentVolumeClaim,projected,secret' : 'configMap,downwardAPI,emptyDir,persistentVolumeClaim,projected,secret',
        };
      }
      case 'User': {
        const identities = resource.spec?.identities || resource.identities || [];
        return {
          NAME: name,
          UID: resource.metadata?.uid || '',
          'FULL NAME': resource.spec?.fullName || '',
          IDENTITIES: identities.map((identity) => `${identity.providerName}:${identity.providerUserName}`).join(',') || '',
        };
      }
      case 'Group': {
        const users = resource.spec?.users || resource.users || [];
        return { NAME: name, USERS: users.join(','), AGE: age };
      }
      case 'Identity': {
        const spec = resource.spec || resource;
        return {
          NAME: name,
          'IDP NAME': spec.providerName || 'htpasswd',
          'IDP USER NAME': spec.providerUserName || '',
          'USER NAME': spec.user?.name || '',
          'USER UID': spec.user?.uid || '',
        };
      }
      case 'Template': {
        const parameters = resource.spec?.parameters || resource.parameters || [];
        const objects = resource.spec?.objects || resource.objects || [];
        return {
          NAME: name,
          DESCRIPTION: resource.spec?.description || resource.description || '',
          PARAMETERS: String(parameters.length),
          OBJECTS: String(objects.length),
        };
      }
      case 'BuildConfig': {
        const strategy = resource.spec?.strategy || {};
        const source = resource.spec?.source || {};
        return {
          NAME: name,
          TYPE: strategy.type || 'Source',
          FROM: strategy.sourceStrategy?.from?.name || source.git?.uri || '',
          LATEST: String(resource.status?.lastVersion ?? 0),
        };
      }
      case 'Build': {
        const strategy = resource.spec?.strategy || {};
        const source = resource.spec?.source || {};
        return {
          NAME: name,
          TYPE: strategy.type || 'Source',
          FROM: strategy.sourceStrategy?.from?.name || source.git?.uri || '',
          STATUS: resource.status?.phase || 'New',
          STARTED: resource.status?.startTimestamp ? formatAge(resource.status.startTimestamp) : '<none>',
          DURATION: this._buildDuration(resource),
        };
      }
      case 'ImageStream': {
        const tags = resource.status?.tags || resource.spec?.tags || [];
        const repository = resource.status?.dockerImageRepository || `${INTERNAL_REGISTRY}/${resource.metadata?.namespace || 'default'}/${name}`;
        const tagNames = tags.map((tag) => tag.tag || tag.name).filter(Boolean).join(',');
        return { NAME: name, 'IMAGE REPOSITORY': repository, TAGS: tagNames || '<none>', UPDATED: age };
      }
      case 'Subscription': {
        const spec = resource.spec || resource;
        return {
          NAME: name,
          PACKAGE: spec.packageName || spec.name || name,
          SOURCE: spec.source || 'redhat-operators',
          CHANNEL: spec.channel || 'stable',
        };
      }
      case 'ClusterOperator': {
        const conditions = resource.status?.conditions || [];
        const condition = (type) => {
          const found = conditions.find((entry) => entry.type === type);
          return found ? found.status : 'Unknown';
        };
        const version = resource.status?.versions?.[0]?.version || OCP_VERSION;
        const available = conditions.find((entry) => entry.type === 'Available');
        return {
          NAME: name,
          VERSION: version,
          AVAILABLE: this._booleanCell(condition('Available') === 'True'),
          PROGRESSING: this._booleanCell(condition('Progressing') === 'True'),
          DEGRADED: this._booleanCell(condition('Degraded') === 'True'),
          SINCE: available?.lastTransitionTime ? formatAge(available.lastTransitionTime) : formatAge(resource.metadata?.creationTimestamp),
        };
      }
      case 'ClusterVersion': {
        const version = resource.status?.desired?.version || resource.spec?.desired?.version || OCP_VERSION;
        const conditions = resource.status?.conditions || [];
        const progress = conditions.find((entry) => entry.type === 'Progressing');
        const available = conditions.find((entry) => entry.type === 'Available');
        return {
          NAME: name,
          VERSION: version,
          AVAILABLE: this._booleanCell(available ? available.status === 'True' : true),
          PROGRESSING: this._booleanCell(progress ? progress.status === 'True' : false),
          SINCE: available?.lastTransitionTime ? formatAge(available.lastTransitionTime) : formatAge(resource.metadata?.creationTimestamp),
          STATUS: progress?.message || `Done applying ${OCP_VERSION}`,
        };
      }
      case 'OAuth': {
        return { NAME: name, AGE: age };
      }
      case 'IPAddressPool':
      case 'L2Advertisement': {
        return { NAME: name, AGE: age };
      }
      default:
        return { NAME: name, STATUS: this._genericStatus(resource), AGE: age };
    }
  },

  _genericStatus(resource) {
    const phase = resource.status?.phase || resource.status?.state || resource.phase;
    if (phase) return String(phase);
    const conditions = resource.status?.conditions || resource.conditions || [];
    if (Array.isArray(conditions) && conditions.length) {
      const ready = conditions.find((condition) => ['Ready', 'Available', 'Established'].includes(condition.type));
      if (ready) return ready.status === 'True' ? 'Ready' : 'NotReady';
    }
    return 'Active';
  },

  /** Printer columns for a kind: CLI overrides (real 1.35 shapes) first. */
  _columnsFor(kind) {
    return COLUMN_OVERRIDES[kind] || columnsForKind(kind);
  },

  /**
   * Render a table for a kind, using kindRegistry.columnsForKind() headers.
   * @param {string} kind
   * @param {any[]} resources
   * @param {{wide?:boolean, showLabels?:boolean, noHeaders?:boolean, extraHeaders?:string[]}} [options]
   */
  _tableFor(kind, resources, options = {}) {
    const baseHeaders = splitHeaderCells(this._columnsFor(kind));
    const extras = options.wide ? this._wideExtras(kind) : [];
    const headers = [...baseHeaders, ...extras.map((extra) => extra.header)];
    if (options.showLabels) headers.push('LABELS');
    if (options.namespaceColumn) headers.unshift('NAMESPACE');
    const rows = resources.map((resource) => {
      const cells = this._rowCells(kind, resource);
      if (options.namePrefix) cells.NAME = `${this._singularName(kind)}/${cells.NAME}`;
      const row = baseHeaders.map((header) => (cells[header] !== undefined ? String(cells[header]) : ''));
      for (const extra of extras) row.push(String(extra.value(resource) ?? ''));
      if (options.showLabels) row.push(this._labelString(resource) || '<none>');
      if (options.namespaceColumn) row.unshift(resource.metadata?.namespace || '');
      return row;
    });
    const table = padTable(headers, rows);
    // `--no-headers` suppresses only the header row, never the data rows.
    if (options.noHeaders) return table.split('\n').slice(1).join('\n');
    return table;
  },

  /** Render `oc get` output for one kind in the requested format. */
  _formatGetResult(kind, resources, flags, options = {}) {
    const output = this._outputFormat(flags);
    const single = Boolean(options.singleName);
    if (output.format === 'yaml' || output.format === 'json') {
      const object = single && resources.length === 1 ? this._manifestFor(resources[0]) : this._listManifest(kind, resources);
      if (output.format === 'json') return JSON.stringify(object, null, 4);
      return toYamlDocument(object);
    }
    if (output.format === 'name') {
      return resources
        .map((resource) => `${this._singularName(kind)}/${resource.metadata?.name || resource.name}`)
        .join('\n');
    }
    if (output.format === 'jsonpath') {
      if (!output.arg) {
        return this._err(`error: jsonpath requires a template, e.g. -o jsonpath='{.items[*].metadata.name}'`);
      }
      const subject = single && resources.length === 1 ? resources[0] : { kind: 'List', items: resources.map((resource) => this._manifestFor(resource)) };
      return evaluateJsonPath(subject, output.arg);
    }
    if (output.format === 'custom-columns') {
      if (!output.arg) return this._err("error: custom-columns requires a template, e.g. -o custom-columns=NAME:.metadata.name");
      const columns = output.arg
        .split(',')
        .map((entry) => {
          const colon = entry.indexOf(':');
          return colon < 0 ? null : { header: entry.slice(0, colon), path: entry.slice(colon + 1) };
        })
        .filter(Boolean);
      if (!columns.length) return this._err('error: invalid custom-columns specification');
      const rows = resources.map((resource) => {
        const manifest = this._manifestFor(resource);
        return columns.map((column) => {
          const template = `{${column.path.trim()}}`;
          const value = evaluateJsonPath(manifest, template);
          return value === '' ? '<none>' : String(value);
        });
      });
      return padTable(
        columns.map((column) => column.header),
        rows,
      );
    }
    return this._tableFor(kind, resources, {
      wide: output.format === 'wide',
      showLabels: Boolean(flags['show-labels']),
      noHeaders: Boolean(flags['no-headers']),
      namespaceColumn: Boolean(options.allNamespaces) && this._isNamespaced(kind),
    });
  },

  _singularName(kind) {
    // -o name uses the singular resource + group, e.g. deployment.apps/web.
    return refNameForKind(kind);
  },

  _manifestFor(resource) {
    try {
      // apiView: real-API-shaped object (real objectMeta + status only for
      // kinds that actually have a status), matching `oc get -o yaml|json`.
      return toManifestObject(resource, { apiView: true });
    } catch {
      return {
        apiVersion: resource?.apiVersion || apiVersionForKind(resource?.kind),
        kind: resource?.kind,
        metadata: {
          name: resource?.metadata?.name || resource?.name,
          ...(resource?.metadata?.namespace ? { namespace: resource.metadata.namespace } : {}),
          labels: { ...(resource?.metadata?.labels || {}) },
          annotations: { ...(resource?.metadata?.annotations || {}) },
        },
        spec: JSON.parse(JSON.stringify(resource?.spec || {})),
        status: JSON.parse(JSON.stringify(resource?.status || {})),
      };
    }
  },

  _listManifest(kind, resources) {
    return {
      apiVersion: 'v1',
      kind: 'List',
      metadata: { resourceVersion: '' },
      items: resources.map((resource) => this._manifestFor(resource)),
    };
  },

  /** Sort resources by an oc `--sort-by` path. */
  _sortResources(resources, sortBy) {
    if (!sortBy || sortBy === true) return resources;
    const path = String(sortBy).replace(/^\{|\}$/g, '').replace(/^\./, '');
    const segments = path.split('.').filter(Boolean);
    return [...resources].sort((left, right) => {
      const a = resolvePathValue(left, segments);
      const b = resolvePathValue(right, segments);
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a ?? '').localeCompare(String(b ?? ''));
    });
  },

  /** Apply -l/--field-selector to a resource list. */
  _filterResources(resources, kind, flags) {
    let result = resources;
    const selector = flags.selector || flags.l;
    if (selector && selector !== true) {
      const predicate = parseLabelSelector(String(selector));
      result = result.filter((resource) => predicate(resource));
    }
    const fieldSelector = flags['field-selector'];
    if (fieldSelector && fieldSelector !== true) {
      const predicate = parseFieldSelector(String(fieldSelector));
      result = result.filter((resource) => predicate(resource));
    }
    return result;
  },
});

// ────────────────────────────────────────────────────────────────────────────
// CommandBar — events + `oc describe` rendering
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  /**
   * Build a deterministic synthetic event stream from incidents, resources and
   * build/route state. The simulator has no real event recorder; this mirrors the
   * events oc would show for the modelled objects.
   */
  _syntheticEvents(options = {}) {
    const events = [];
    const namespace = options.namespace || this.currentProject;
    const push = (event) => events.push(event);

    // 1. Active incidents surface as Warning events.
    const incidentEngine = this.game?.incidentEngine;
    let incidents = [];
    try {
      incidents = incidentEngine?.getActiveIncidents?.() || incidentEngine?.incidents || [];
    } catch {
      incidents = [];
    }
    for (const incident of Array.isArray(incidents) ? incidents : []) {
      if (!incident) continue;
      const state = String(incident.state || incident.status || '');
      if (state && !/active|investigating|created/i.test(state)) continue;
      const targetKind = (incident.affectedResourceTypes || ['Pod'])[0] || 'Pod';
      const timestamp = incident.activatedAt || incident.createdAt || Date.now() - 120000;
      push({
        lastTimestamp: timestamp,
        type: 'Warning',
        reason: incident.name || 'Warning',
        object: `${String(targetKind).toLowerCase()}/${incident.target || 'unknown'}`,
        subobject: '',
        source: 'incident-controller',
        message: incident.description || `${incident.name || 'Incident'} detected`,
        namespace,
      });
    }

    // 2. Pod lifecycle events (Normal) + failure events (Warning).
    for (const pod of this._getKindList('Pod')) {
      const name = pod.metadata?.name;
      if (!name) continue;
      const podNamespace = pod.metadata?.namespace || 'default';
      const created = pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : Date.now() - 300000;
      const node = pod.spec?.nodeName || `worker-${(stableHash(name, 3) + 1)}`;
      const object = `pod/${name}`;
      push({
        lastTimestamp: created + 2000,
        type: 'Normal',
        reason: 'Scheduled',
        object,
        subobject: '',
        source: 'default-scheduler',
        message: `Successfully assigned ${podNamespace}/${name} to ${node}`,
        namespace: podNamespace,
      });
      const podStatus = this._podStatus(pod);
      const phase = pod.status?.phase || 'Pending';
      if (phase === 'Pending') continue;
      push({ lastTimestamp: created + 4000, type: 'Normal', reason: 'Pulling', object, subobject: '', source: 'kubelet', message: `Pulling image "${this._containerList(pod)[0]?.image || 'nginx:latest'}"`, namespace: podNamespace });
      push({ lastTimestamp: created + 6000, type: 'Normal', reason: 'Pulled', object, subobject: '', source: 'kubelet', message: 'Successfully pulled image', namespace: podNamespace });
      push({ lastTimestamp: created + 7000, type: 'Normal', reason: 'Created', object, subobject: '', source: 'kubelet', message: `Created container ${this._containerList(pod)[0]?.name || 'main'}`, namespace: podNamespace });
      if (phase === 'Running') {
        push({ lastTimestamp: created + 8000, type: 'Normal', reason: 'Started', object, subobject: '', source: 'kubelet', message: `Started container ${this._containerList(pod)[0]?.name || 'main'}`, namespace: podNamespace });
      } else if (phase === 'Failed' || /BackOff|Error|ImagePull|CreateContainer|CrashLoop/.test(podStatus.status)) {
        push({
          lastTimestamp: created + 12000,
          type: 'Warning',
          reason: podStatus.status === 'ImagePullBackOff' ? 'Failed' : 'BackOff',
          object,
          subobject: '',
          source: 'kubelet',
          message: podStatus.status === 'ImagePullBackOff' ? 'Failed to pull image: manifest unknown' : 'Back-off restarting failed container',
          namespace: podNamespace,
        });
      }
    }

    // 3. Deployment scaling events.
    for (const deployment of this._getKindList('Deployment')) {
      const name = deployment.metadata?.name;
      if (!name) continue;
      const created = deployment.metadata?.creationTimestamp ? new Date(deployment.metadata.creationTimestamp).getTime() : Date.now() - 240000;
      push({
        lastTimestamp: created + 3000,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        object: `deployment/${name}`,
        subobject: '',
        source: 'deployment-controller',
        message: `Scaled up replica set ${name}-${(stableHash(name, 900) + 100)} to ${deployment.spec?.replicas ?? 1}`,
        namespace: deployment.metadata?.namespace || 'default',
      });
    }

    // 4. Build events.
    for (const build of this._getKindList('Build')) {
      const name = build.metadata?.name;
      if (!name) continue;
      const phase = build.status?.phase || 'New';
      const started = build.status?.startTimestamp ? new Date(build.status.startTimestamp).getTime() : Date.now() - 90000;
      push({
        lastTimestamp: started,
        type: 'Normal',
        reason: 'BuildStarted',
        object: `build/${name}`,
        subobject: '',
        source: 'build-controller',
        message: `Build ${name} started`,
        namespace: build.metadata?.namespace || 'default',
      });
      if (phase === 'Complete') {
        push({ lastTimestamp: started + 9000, type: 'Normal', reason: 'BuildCompleted', object: `build/${name}`, subobject: '', source: 'build-controller', message: `Build ${name} completed successfully`, namespace: build.metadata?.namespace || 'default' });
      } else if (phase === 'Failed') {
        push({ lastTimestamp: started + 9000, type: 'Warning', reason: 'BuildFailed', object: `build/${name}`, subobject: '', source: 'build-controller', message: build.status?.message || `Build ${name} failed`, namespace: build.metadata?.namespace || 'default' });
      }
    }

    // 5. Route admission events.
    for (const route of this._getKindList('Route')) {
      const name = route.metadata?.name;
      if (!name) continue;
      const created = route.metadata?.creationTimestamp ? new Date(route.metadata.creationTimestamp).getTime() : Date.now() - 180000;
      const admitted = this._routeAdmitted(route);
      push({
        lastTimestamp: created + 2000,
        type: admitted ? 'Normal' : 'Warning',
        reason: admitted ? 'Admitted' : 'ServiceUnavailable',
        object: `route/${name}`,
        subobject: '',
        source: 'router',
        message: admitted
          ? `Route ${name} admitted by router default`
          : `Route ${name} not admitted: no endpoints available`,
        namespace: route.metadata?.namespace || 'default',
      });
    }

    // 6. Operator subscription events.
    for (const subscription of this._getKindList('Subscription')) {
      const name = subscription.metadata?.name;
      if (!name) continue;
      const created = subscription.metadata?.creationTimestamp ? new Date(subscription.metadata.creationTimestamp).getTime() : Date.now() - 420000;
      push({
        lastTimestamp: created + 1000,
        type: 'Normal',
        reason: 'RequirementsMet',
        object: `subscription/${name}`,
        subobject: '',
        source: 'olm',
        message: `installing "${name}"`,
        namespace: subscription.metadata?.namespace || 'openshift-operators',
      });
    }

    events.sort((a, b) => a.lastTimestamp - b.lastTimestamp);
    return events.slice(-40);
  },

  _filterEvents(events, flags) {
    let result = events;
    const fieldSelector = flags['field-selector'];
    if (fieldSelector && fieldSelector !== true) {
      const requirements = String(fieldSelector).split(',').map((entry) => entry.trim()).filter(Boolean);
      result = result.filter((event) =>
        requirements.every((requirement) => {
          const match = requirement.match(/^([A-Za-z0-9_.\-/]+)\s*(!=|==|=)\s*(.+)$/);
          if (!match) return true;
          const [, path, operator, expected] = match;
          let actual;
          if (path.startsWith('involvedObject.')) actual = event.object?.split('/')[1];
          else if (path === 'involvedObject.kind') actual = event.object?.split('/')[0];
          else if (path === 'type' || path === 'reason' || path === 'message') actual = event[path];
          else actual = resolvePathValue(event, path.split('.'));
          const matches = String(actual ?? '') === expected;
          return operator === '!=' ? !matches : matches;
        }),
      );
    }
    if (flags['sort-by'] && flags['sort-by'] !== true) {
      const path = String(flags['sort-by']).replace(/^\{|\}$/g, '').replace(/^\./, '');
      const key = path === 'lastTimestamp' || path === 'metadata.creationTimestamp' ? 'lastTimestamp' : path;
      result = [...result].sort((a, b) => {
        const left = key === 'lastTimestamp' ? a.lastTimestamp : resolvePathValue(a, key.split('.'));
        const right = key === 'lastTimestamp' ? b.lastTimestamp : resolvePathValue(b, key.split('.'));
        return typeof left === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''));
      });
    }
    return result;
  },

  _formatEvents(events, flags, options = {}) {
    const output = this._outputFormat(flags);
    if (['yaml', 'json'].includes(output.format)) {
      const manifests = events.map((event) => this._eventManifest(event));
      if (output.format === 'json') return JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items: manifests }, null, 4);
      return toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: manifests });
    }
    if (output.format === 'name') {
      return events.map((event) => `event/${this._eventName(event)}`).join('\n');
    }
    // Real oc/K8s 1.35 event printer: LAST SEEN, TYPE, REASON, OBJECT, MESSAGE
    // (SUBOBJECT/SOURCE/NAMESPACE are only shown in wide/all-namespaces output).
    const wideEvents = output.format === 'wide' || Boolean(options.namespaceColumn);
    const headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
    const rows = events.map((event) => [
      formatAge(event.lastTimestamp),
      event.type || 'Normal',
      event.reason || '',
      event.object || '',
      event.message || '',
    ]);
    if (wideEvents) {
      headers.splice(4, 0, 'SUBOBJECT', 'SOURCE');
      rows.forEach((row, index) => row.splice(4, 0, events[index].subobject || '', events[index].source || ''));
    }
    if (options.namespaceColumn) {
      headers.push('NAMESPACE');
      rows.forEach((row, index) => row.push(events[index].namespace || ''));
    }
    if (flags['show-labels']) headers.push('LABELS'), rows.forEach((row) => row.push('<none>'));
    const table = padTable(headers, rows);
    if (flags['no-headers']) return table.split('\n').slice(1).join('\n');
    return table;
  },

  _eventName(event) {
    return `${String(event.object || 'object').replace('/', '.')}.${stableHash(`${event.object}-${event.reason}`, 100000)}`;
  },

  _eventManifest(event) {
    const name = this._eventName(event);
    const [objectKind, objectName] = String(event.object || '').split('/');
    return {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: {
        name,
        namespace: event.namespace || this.currentProject,
        creationTimestamp: new Date(event.lastTimestamp).toISOString(),
      },
      involvedObject: { kind: objectKind || 'Pod', name: objectName || name, namespace: event.namespace || this.currentProject },
      reason: event.reason,
      message: event.message,
      type: event.type,
      lastTimestamp: new Date(event.lastTimestamp).toISOString(),
      source: { component: event.source },
    };
  },

  _eventsForResource(kind, resource) {
    const name = resource.metadata?.name;
    const object = `${String(kind).toLowerCase()}/${name}`;
    return this._syntheticEvents({ namespace: resource.metadata?.namespace }).filter((event) => event.object === object);
  },

  _eventsSection(kind, resource) {
    const events = this._eventsForResource(kind, resource);
    if (!events.length) return 'Events:\n  <none>';
    const header = '  Type     Reason                   Age   From               Message\n  ----     ------                   ----  ----               -------';
    const rows = events.slice(-10).map(
      (event) =>
        `  ${String(event.type || 'Normal').padEnd(9)}${String(event.reason || '').padEnd(25)}${formatAge(event.lastTimestamp).padEnd(6)}${String(event.source || '').padEnd(19)}${event.message || ''}`,
    );
    return `Events:\n${header}\n${rows.join('\n')}`;
  },

  /** Render `oc describe` output for a resource (rich toDescribe when available). */
  _describeResource(kind, resource) {
    let output = '';
    if (typeof resource.toDescribe === 'function') {
      try {
        output = resource.toDescribe();
      } catch {
        output = '';
      }
    }
    if (!output || typeof output !== 'string') output = this._describeLines(kind, resource).join('\n');
    if (!/^Events:/m.test(output)) output += `\n${this._eventsSection(kind, resource)}`;
    return output;
  },

  _describeLines(kind, resource) {
    const metadata = resource.metadata || {};
    const spec = resource.spec || {};
    const status = resource.status || {};
    const lines = [];
    const push = (...entries) => lines.push(...entries);
    const labels = this._labelString(resource) || '<none>';
    const annotations = Object.entries(metadata.annotations || {}).map(([key, value]) => `${key}=${value}`).join(', ') || '<none>';

    switch (kind) {
      case 'Project': {
        push(
          `Name:           ${metadata.name}`,
          `Display Name:   ${spec.displayName || metadata.annotations?.['openshift.io/display-name'] || '<none>'}`,
          `Description:    ${spec.description || metadata.annotations?.['openshift.io/description'] || '<none>'}`,
          `Status:         ${status.phase || 'Active'}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
        );
        break;
      }
      case 'Route': {
        const router = status.ingress?.[0] || {};
        const admitted = this._routeAdmitted(resource);
        push(
          `Name:                   ${metadata.name}`,
          `Namespace:              ${metadata.namespace}`,
          `Labels:                 ${labels}`,
          `Annotations:            ${annotations}`,
          `Requested Host:         ${spec.host || '<auto-generated>'}`,
          `Admitted:               ${admitted}`,
          `Path:                   ${spec.path || '/'}`,
          `TLS Termination:        ${spec.tls?.termination || '<none>'}`,
          `Insecure Policy:        ${spec.tls?.insecureEdgeTerminationPolicy || 'None'}`,
          `Endpoint Port:          ${spec.port?.targetPort ?? '<all>'}`,
          `Service:                ${spec.to?.kind || 'Service'}/${spec.to?.name || '<none>'}`,
          `Weight:                 ${spec.to?.weight ?? 100}`,
          `Wildcard Policy:        ${spec.wildcardPolicy || 'None'}`,
          '',
          'Router:',
          `  Router Name:          ${router.routerName || 'default'}`,
          `  Host:                 ${router.host || this._routeHost(resource)}`,
        );
        const conditions = router.conditions || [];
        if (conditions.length) {
          push('  Conditions:');
          for (const condition of conditions) {
            push(
              `    Type:               ${condition.type}`,
              `    Status:             ${condition.status}`,
              `    Reason:             ${condition.reason || ''}`,
              `    Message:            ${condition.message || ''}`,
              `    Last Transition:    ${condition.lastTransitionTime ? formatAge(condition.lastTransitionTime) : '<unknown>'}`,
            );
          }
        }
        break;
      }
      case 'BuildConfig': {
        const strategy = spec.strategy || {};
        const source = spec.source || {};
        push(
          `Name:           ${metadata.name}`,
          `Namespace:      ${metadata.namespace}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          '',
          'From:',
          `  Type:         ${source.type || 'Git'}`,
          `  Git URL:      ${source.git?.uri || '<none>'}`,
          `  Ref:          ${source.git?.ref || '<none>'}`,
          '',
          'Strategy:',
          `  Type:         ${strategy.type || 'Source'}`,
          `  Builder:      ${strategy.sourceStrategy?.from?.name || '<none>'}`,
          '',
          'Output:',
          `  Kind:         ${spec.output?.to?.kind || 'ImageStreamTag'}`,
          `  Name:         ${spec.output?.to?.name || '<none>'}`,
          '',
          'Triggers:',
          ...(spec.triggers || []).map((trigger) => `  ${trigger.type}${trigger.imageChange?.from?.name ? ` - ${trigger.imageChange.from.name}` : ''}`),
          '',
          `Run Policy:     ${spec.runPolicy || 'Serial'}`,
          `Latest Version: ${status.lastVersion ?? 0}`,
        );
        break;
      }
      case 'Build': {
        push(
          `Name:           ${metadata.name}`,
          `Namespace:      ${metadata.namespace}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          `Status:         ${status.phase || 'New'}`,
          `Started:        ${status.startTimestamp ? formatAge(status.startTimestamp) : '<none>'}`,
          `Duration:       ${this._buildDuration(resource)}`,
          `Build Config:   ${metadata.labels?.buildconfig || metadata.labels?.['buildconfig.openshift.io/name'] || spec.buildConfig?.name || '<none>'}`,
          `Output:         ${spec.output?.to?.name || '<none>'}`,
          `Message:        ${status.message || '<none>'}`,
        );
        break;
      }
      case 'ImageStream': {
        const tags = status.tags || spec.tags || [];
        push(
          `Name:                   ${metadata.name}`,
          `Namespace:              ${metadata.namespace}`,
          `Labels:                 ${labels}`,
          `Annotations:            ${annotations}`,
          `Docker Pull Spec:       ${status.dockerImageRepository || `${INTERNAL_REGISTRY}/${metadata.namespace}/${metadata.name}`}`,
          `Image Lookup:           ${spec.lookupPolicy?.local ? 'local' : 'Source'}`,
          '',
          'Tags:',
          ...(tags.length
            ? tags.map((tag) => {
                const tagName = tag.tag || tag.name;
                const item = tag.items?.[0];
                return `  ${tagName}\t${item?.dockerImageReference || '<none>'}`;
              })
            : ['  <none>']),
        );
        break;
      }
      case 'Template': {
        const parameters = spec.parameters || [];
        const objects = spec.objects || [];
        push(
          `Name:           ${metadata.name}`,
          `Namespace:      ${metadata.namespace}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          `Description:    ${spec.description || '<none>'}`,
          '',
          'Parameters:',
          ...(parameters.length
            ? parameters.map((parameter) => `  ${parameter.name}\t${parameter.displayName || ''}\t${parameter.required ? 'required' : 'optional'}\t${parameter.value ?? ''}`)
            : ['  <none>']),
          '',
          `Objects:        ${objects.length}`,
          `Message:        ${spec.message || '<none>'}`,
        );
        break;
      }
      case 'Subscription': {
        push(
          `Name:                   ${metadata.name}`,
          `Namespace:              ${metadata.namespace}`,
          `Labels:                 ${labels}`,
          `Annotations:            ${annotations}`,
          '',
          'Subscription:',
          `  Package:              ${spec.name || spec.packageName || metadata.name}`,
          `  Channel:              ${spec.channel || 'stable'}`,
          `  Source:               ${spec.source || 'redhat-operators'}`,
          `  Source Namespace:     ${spec.sourceNamespace || 'openshift-marketplace'}`,
          `  Install Plan Approval:${spec.installPlanApproval || 'Automatic'}`,
          '',
          'Status:',
          `  Phase:                ${status.phase || 'Installing'}`,
          `  Installed CSV:        ${status.installedCSV || '<none>'}`,
        );
        break;
      }
      case 'SecurityContextConstraints': {
        const s = { ...defaultSpecForKind('SecurityContextConstraints'), ...spec };
        push(
          `Name:              ${metadata.name}`,
          `Priority:          ${s.priority ?? 0}`,
          `Access:            ${(s.users || []).length ? 'restricted' : '<none>'}`,
          `Users:             ${(s.users || []).join(', ') || '<none>'}`,
          `Groups:            ${(s.groups || []).join(', ') || '<none>'}`,
          '',
          'Settings:',
          `  Allow Privileged Container:        ${Boolean(s.allowPrivilegedContainer)}`,
          `  Allow Host Dir Volume Plugin:      ${Boolean(s.allowHostDirVolumePlugin)}`,
          `  Allow Host Network:                ${Boolean(s.allowHostNetwork)}`,
          `  Allow Host Ports:                  ${Boolean(s.allowHostPorts)}`,
          `  Allow Host PID:                    ${Boolean(s.allowHostPID)}`,
          `  Allow Host IPC:                    ${Boolean(s.allowHostIPC)}`,
          `  Read Only Root Filesystem:         ${Boolean(s.readOnlyRootFilesystem)}`,
          '',
          'Strategy:',
          `  Run As User:                       ${s.runAsUser?.type || 'MustRunAsRange'}`,
          `  SELinux Context:                   ${s.seLinuxContext?.type || 'MustRunAs'}`,
          `  FSGroup:                           ${s.fsGroup?.type || 'MustRunAs'}`,
          `  Supplemental Groups:               ${s.supplementalGroups?.type || 'MustRunAs'}`,
          '',
          'Volumes:',
          `  ${s.allowHostDirVolumePlugin ? 'hostPath' : 'configMap, downwardAPI, emptyDir, persistentVolumeClaim, projected, secret'}`,
        );
        break;
      }
      case 'ResourceQuota': {
        const hard = spec.hard || {};
        const used = status.used || {};
        push(
          `Name:            ${metadata.name}`,
          `Namespace:       ${metadata.namespace}`,
          `Labels:          ${labels}`,
          `Annotations:     ${annotations}`,
          `Resource         Used   Hard`,
          `--------         ----   ----`,
          ...Object.keys(hard).map((key) => `${key.padEnd(17)}${String(used[key] ?? '0').padEnd(7)}${hard[key]}`),
        );
        break;
      }
      case 'LimitRange': {
        const limits = spec.limits || [];
        push(
          `Name:        ${metadata.name}`,
          `Namespace:   ${metadata.namespace}`,
          `Labels:      ${labels}`,
          `Annotations: ${annotations}`,
          '',
          'Type        Resource  Min  Max  Default Request  Default Limit  Max Limit/Request Ratio',
          '----        --------  ---  ---  ---------------  -------------  -----------------------',
          ...limits.map((limit) => {
            const resources = new Set([
              ...Object.keys(limit.default || {}),
              ...Object.keys(limit.defaultRequest || {}),
              ...Object.keys(limit.min || {}),
              ...Object.keys(limit.max || {}),
            ]);
            return [...resources]
              .map(
                (resource) =>
                  `${String(limit.type).padEnd(12)}${resource.padEnd(10)}${(limit.min?.[resource] || '<none>').toString().padEnd(5)}${(limit.max?.[resource] || '<none>').toString().padEnd(5)}${(limit.defaultRequest?.[resource] || '<none>').toString().padEnd(17)}${(limit.default?.[resource] || '<none>').toString().padEnd(15)}${limit.maxLimitRequestRatio?.[resource] || '<none>'}`,
              )
              .join('\n');
          }),
        );
        break;
      }
      case 'ClusterResourceQuota': {
        const hard = spec.quota?.hard || {};
        const used = status.total?.used || {};
        const matchLabels = spec.selector?.labels?.matchLabels || {};
        push(
          `Name:            ${metadata.name}`,
          `Labels:          ${labels}`,
          `Annotations:     ${annotations}`,
          `Created:         ${formatAge(metadata.creationTimestamp)}`,
          '',
          "Label Selector:",
          ...(Object.keys(matchLabels).length ? Object.entries(matchLabels).map(([key, value]) => `${key}=${value}`) : ['<none>']),
          '',
          'Resource         Used   Hard',
          '--------         ----   ----',
          ...Object.keys(hard).map((key) => `${key.padEnd(17)}${String(used[key] ?? '0').padEnd(7)}${hard[key]}`),
        );
        break;
      }
      case 'User': {
        const identities = spec.identities || [];
        push(
          `Name:           ${metadata.name}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          `Full Name:      ${spec.fullName || '<none>'}`,
          `Identities:     ${identities.map((identity) => `${identity.providerName}:${identity.providerUserName}`).join(', ') || '<none>'}`,
          `Groups:         ${(spec.groups || []).join(', ') || '<none>'}`,
        );
        break;
      }
      case 'Group': {
        push(
          `Name:           ${metadata.name}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          `Users:          ${(spec.users || []).join(', ') || '<none>'}`,
        );
        break;
      }
      case 'ClusterOperator': {
        const conditions = status.conditions || [];
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    `,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `Version:      ${status.versions?.[0]?.version || OCP_VERSION}`,
          '',
          'Status:',
          '  Conditions:',
          ...conditions.map(
            (condition) =>
              `    Type:                ${condition.type}\n    Status:              ${condition.status}\n    Reason:              ${condition.reason || ''}\n    Message:             ${condition.message || ''}`,
          ),
          '  Versions:',
          ...(status.versions || []).map((version) => `    Name:                ${version.name}\n    Version:             ${version.version}`),
        );
        break;
      }
      case 'ClusterVersion': {
        push(
          `Name:         ${metadata.name}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `Version:      ${status.desired?.version || spec.desired?.version || OCP_VERSION}`,
          `Channel:      ${spec.channel || status.desired?.channel || OCP_CHANNEL}`,
          '',
          'Status:',
          '  Conditions:',
          ...(status.conditions || []).map(
            (condition) =>
              `    Type:                ${condition.type}\n    Status:              ${condition.status}\n    Reason:              ${condition.reason || ''}\n    Message:             ${condition.message || ''}`,
          ),
        );
        break;
      }
      case 'OAuth': {
        const idps = spec.identityProviders || [];
        push(
          `Name:           ${metadata.name}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          '',
          'Identity Providers:',
          ...(idps.length
            ? idps.map(
                (idp) =>
                  `  Name:  ${idp.name}\n  Type:  ${idp.type}${idp.htpasswd?.fileData?.name ? `\n  File Data:\n    Name:  ${idp.htpasswd.fileData.name}` : ''}`,
              )
            : ['  <none>']),
        );
        break;
      }
      case 'IPAddressPool':
      case 'L2Advertisement': {
        push(
          `Name:           ${metadata.name}`,
          `Namespace:      ${metadata.namespace}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          '',
          'Spec:',
          ...Object.entries(spec).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
        );
        break;
      }
      case 'Node': {
        const conditions = status.conditions || [];
        const capacity = status.capacity || {};
        const allocatable = status.allocatable || {};
        push(
          `Name:               ${metadata.name}`,
          `Roles:              ${this._nodeRoles(resource)}`,
          `Labels:             ${labels}`,
          `Annotations:        ${annotations}`,
          `CreationTimestamp:  ${metadata.creationTimestamp || '<unknown>'}`,
          '',
          'Conditions:',
          '  Type             Status  LastHeartbeatTime                 Reason                          Message',
          '  ----             ------  -----------------                 ------                          -------',
          ...conditions.map(
            (condition) =>
              `  ${condition.type.padEnd(17)}${condition.status.padEnd(8)}${String(condition.lastHeartbeatTime || '').padEnd(34)}${condition.reason || ''}`,
          ),
          '',
          'Capacity:',
          `  cpu:         ${capacity.cpu || spec.cpu || '8'}`,
          `  memory:      ${capacity.memory || spec.memory || '16Gi'}`,
          `  pods:        ${capacity.pods || '250'}`,
          '',
          'Allocatable:',
          `  cpu:         ${allocatable.cpu || '3800m'}`,
          `  memory:      ${allocatable.memory || '7Gi'}`,
          `  pods:        ${allocatable.pods || capacity.pods || '110'}`,
          '',
          `Unschedulable:  ${Boolean(spec.unschedulable)}`,
          `Taints:         ${(spec.taints || []).map((taint) => `${taint.key}=${taint.value || ''}:${taint.effect}`).join(', ') || '<none>'}`,
        );
        break;
      }
      case 'Service': {
        const selector = this._selectorString(spec.selector);
        push(
          `Name:              ${metadata.name}`,
          `Namespace:         ${metadata.namespace}`,
          `Labels:            ${labels}`,
          `Annotations:       ${annotations}`,
          `Selector:          ${selector}`,
          `Type:              ${spec.type || 'ClusterIP'}`,
          `IP:                ${this._serviceClusterIP(resource)}`,
          `External IPs:      ${this._externalIP(resource)}`,
          `Port:              ${this._servicePorts(resource)}`,
          `TargetPort:        ${(spec.ports || []).map((port) => port.targetPort).join(',') || '<none>'}`,
          `Endpoints:         ${this._serviceEndpoints(resource)}`,
        );
        break;
      }
      case 'Deployment': {
        const replicas = spec.replicas ?? 1;
        const ready = status.readyReplicas ?? 0;
        push(
          `Name:                   ${metadata.name}`,
          `Namespace:              ${metadata.namespace}`,
          `Labels:                 ${labels}`,
          `Annotations:            ${annotations}`,
          `Selector:               ${this._selectorString(spec.selector)}`,
          `Replicas:               ${replicas} desired | ${status.updatedReplicas ?? replicas} updated | ${ready} available`,
          `StrategyType:           ${spec.strategy?.type || 'RollingUpdate'}`,
          `MinReadySeconds:        0`,
          `RollingUpdateStrategy:  ${spec.strategy?.rollingUpdate?.maxUnavailable || '25%'} max unavailable, ${spec.strategy?.rollingUpdate?.maxSurge || '25%'} max surge`,
          '',
          'Pod Template:',
          ...this._containerList(resource).map(
            (container) => `  ${container.name}:\n    Image:      ${container.image}\n    Port:       ${(container.ports || []).map((port) => port.containerPort).join(',') || '<none>'}`,
          ),
        );
        break;
      }
      case 'Pod': {
        const pod = this._podStatus(resource);
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace}`,
          `Node:         ${spec.nodeName || '<none>'}`,
          `Status:       ${pod.status}`,
          `IP:           ${status.podIP || '<none>'}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `Service Account:  ${spec.serviceAccountName || 'default'}`,
          '',
          'Containers:',
          ...this._containerList(resource).map(
            (container) => `  ${container.name}:\n    Image:          ${container.image}\n    Port:           ${(container.ports || []).map((port) => port.containerPort).join(',') || '<none>'}\n    Ready:          ${(status.containerStatuses || []).find((entry) => entry.name === container.name)?.ready ?? 'Unknown'}\n    Restart Count:  ${(status.containerStatuses || []).find((entry) => entry.name === container.name)?.restartCount ?? 0}`,
          ),
        );
        break;
      }
      case 'ConfigMap':
      case 'Secret': {
        const data = spec.data || resource.data || {};
        const secret = kind === 'Secret';
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          secret ? `Type:         ${spec.type || 'Opaque'}` : '',
          '',
          'Data',
          '====',
          ...Object.keys(data).map((key) => `${key}: ${secret ? `${String(data[key]).length} bytes` : data[key]}`),
          ...(Object.keys(data).length ? [] : ['<none>']),
        );
        break;
      }
      case 'PersistentVolumeClaim': {
        push(
          `Name:          ${metadata.name}`,
          `Namespace:     ${metadata.namespace}`,
          `Labels:        ${labels}`,
          `Annotations:   ${annotations}`,
          `Status:        ${status.phase || 'Pending'}`,
          `Volume:        ${spec.volumeName || '<none>'}`,
          `StorageClass:  ${spec.storageClassName || ''}`,
          `Capacity:      ${status.capacity?.storage || spec.resources?.requests?.storage || '<none>'}`,
          `Access Modes:  ${(spec.accessModes || []).join(',') || '<none>'}`,
        );
        break;
      }
      case 'HorizontalPodAutoscaler': {
        const target = spec.scaleTargetRef || {};
        push(
          `Name:            ${metadata.name}`,
          `Namespace:       ${metadata.namespace}`,
          `Labels:          ${labels}`,
          `Annotations:     ${annotations}`,
          `Reference:       ${(target.kind || 'Deployment').toLowerCase()}/${target.name || 'app'}`,
          `Metrics:         (current / target)`,
          `  resource cpu   ${status.currentCPUUtilizationPercentage ?? 0}% / ${spec.metrics?.[0]?.resource?.target?.averageUtilization ?? 70}%`,
          `Min replicas:    ${spec.minReplicas ?? 1}`,
          `Max replicas:    ${spec.maxReplicas ?? 10}`,
          `Deployment pods: ${status.currentReplicas ?? 1} current / ${status.desiredReplicas ?? 1} desired`,
        );
        break;
      }
      case 'NetworkPolicy': {
        push(
          `Name:        ${metadata.name}`,
          `Namespace:   ${metadata.namespace}`,
          `Labels:      ${labels}`,
          `Annotations: ${annotations}`,
          `PodSelector: ${this._selectorString(spec.podSelector)}`,
          `Allowing ingress traffic:`,
          ...(spec.ingress?.length ? spec.ingress.map((rule) => `  To Port: ${JSON.stringify(rule.ports || 'all')}\n  From: ${JSON.stringify(rule.from || 'all')}`) : ['  <none> (default deny)']),
          `Policy Types: ${(spec.policyTypes || []).join(', ')}`,
        );
        break;
      }
      case 'Job': {
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `Selector:     ${this._selectorString(spec.selector)}`,
          `Parallelism:  ${spec.parallelism ?? 1}`,
          `Completions:  ${spec.completions ?? 1}`,
          `Status:       ${status.phase || 'Pending'}`,
          `Start Time:   ${status.startTime ? formatAge(status.startTime) : '<none>'}`,
          `Pods Statuses: ${status.active ?? 0} Active / ${status.succeeded ?? 0} Succeeded / ${status.failed ?? 0} Failed`,
        );
        break;
      }
      case 'Ingress': {
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `Default backend:  default-http-backend:80`,
          `Rules:`,
          ...(spec.rules || []).map(
            (rule) => `  Host: ${rule.host || '*'}\n    Path: ${(rule.http?.paths || []).map((path) => `${path.path} -> ${path.backend?.service?.name}:${path.backend?.service?.port?.number || 80}`).join(', ')}`,
          ),
        );
        break;
      }
      case 'ServiceAccount': {
        push(
          `Name:                ${metadata.name}`,
          `Namespace:           ${metadata.namespace}`,
          `Labels:              ${labels}`,
          `Annotations:         ${annotations}`,
          `Image pull secrets:  ${(spec.imagePullSecrets || []).join(', ') || '<none>'}`,
          `Mountable secrets:   ${(spec.secrets || []).join(', ') || '<none>'}`,
          `Tokens:              <none> (bound tokens are projected into pods)`,
        );
        break;
      }
      case 'Role':
      case 'ClusterRole': {
        const rules = (spec.rules || resource.rules || []).map(
          (rule) => `  Resources: ${(rule.resources || []).join(',')}\n  Verbs:     ${(rule.verbs || []).join(',')}`,
        );
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace || ''}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          '',
          'PolicyRule:',
          ...(rules.length ? rules : ['  <none>']),
        );
        break;
      }
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace || ''}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          '',
          `Role:`,
          `  Kind:  ${spec.roleRef?.kind || 'Role'}`,
          `  Name:  ${spec.roleRef?.name || '<none>'}`,
          '',
          'Subjects:',
          `  Kind            Name                                          Namespace`,
          `  ----            ----                                          ---------`,
          ...(spec.subjects || []).map((subject) => `  ${String(subject.kind).padEnd(16)}${String(subject.name).padEnd(46)}${subject.namespace || ''}`),
        );
        break;
      }
      default: {
        push(
          `Name:         ${metadata.name}`,
          ...(metadata.namespace ? [`Namespace:    ${metadata.namespace}`] : []),
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          `API Version:  ${resource.apiVersion || apiVersionForKind(kind)}`,
          `Kind:         ${kind}`,
          `Status:       ${this._genericStatus(resource)}`,
          `Created:      ${metadata.creationTimestamp || '<unknown>'}`,
        );
        if (Object.keys(spec).length) {
          push('', 'Spec:', ...Object.entries(spec).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
        }
      }
    }
    return lines.filter((line) => line !== undefined);
  },

  _serviceEndpoints(resource) {
    const selector = resource.spec?.selector || {};
    const pods = this._getKindList('Pod').filter((pod) => {
      if (pod.metadata?.namespace !== resource.metadata?.namespace) return false;
      const labels = pod.metadata?.labels || {};
      return Object.entries(selector).every(([key, value]) => labels[key] === value);
    });
    const ready = pods.filter((pod) => (pod.status?.phase || '') === 'Running');
    if (!ready.length) return '<none>';
    return ready.map((pod) => `${pod.status?.podIP || '10.128.0.' + (stableHash(pod.metadata?.name || 'pod', 250) + 2)}:${resource.spec?.ports?.[0]?.targetPort || resource.spec?.ports?.[0]?.port || 8080}`).join(',');
  },
});

// ────────────────────────────────────────────────────────────────────────────
// `oc get` / `oc events` / virtual resource views
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _getFlagSpec() {
    return {
      shortValues: { '-n': 'namespace', '-o': 'output', '-l': 'selector' },
      shortBools: { '-A': 'all-namespaces', '-w': 'watch' },
      longValues: ['namespace', 'output', 'selector', 'field-selector', 'sort-by', 'raw'],
      longBools: ['all-namespaces', 'show-labels', 'no-headers', 'watch', 'all', 'ignore-not-found'],
    };
  },

  /** `oc get --raw <path>` — direct API-server request (only `/version` is simulated). */
  _cmdGetRaw(path) {
    const clean = String(path || '').trim();
    if (clean === '/version') {
      // Kubernetes Info JSON as returned by the API server's /version endpoint.
      const version = {
        apiVersion: 'v1',
        major: '4',
        minor: '22',
        gitVersion: OCP_GIT_VERSION,
        gitCommit: '3f6a91c',
        gitTreeState: 'clean',
        buildDate: '2026-10-28T15:03:00Z',
        goVersion: 'go1.24.6',
        compiler: 'gc',
        platform: 'linux/amd64',
        kubernetesVersion: KUBERNETES_GIT_VERSION,
      };
      return this._ok(JSON.stringify(version, null, 2));
    }
    return this._err('Error from server (NotFound): the server could not find the requested resource');
  },

  _cmdGet(tokens) {
    const { positionals, flags, tokens: rawTokens } = parseArgs(tokens, this._getFlagSpec());
    const rawPath = flags.raw && flags.raw !== true ? String(flags.raw) : null;
    if (rawPath) return this._cmdGetRaw(rawPath);
    if (flags.raw === true) {
      return this._err('error: --raw requires a server path (for example: oc get --raw /version)');
    }
    if (!positionals.length) {
      return this._err('error: You must specify the type of resource to get.\n\nUsage:\n  oc get <resource> [<name>] [flags]\n\nRun \'oc get --help\' for details.');
    }
    let resourceToken = positionals[0];
    let names = positionals.slice(1);
    if (isResourceRef(resourceToken)) {
      const slash = resourceToken.indexOf('/');
      names = [resourceToken.slice(slash + 1)];
      resourceToken = resourceToken.slice(0, slash);
    }
    const name = names.length === 1 ? names[0] : null;
    const output = this._outputFormat(flags);
    const allNamespaces = this._isAllNamespaces(flags, rawTokens);
    const namespace = flags.namespace || this.currentProject;
    const lower = resourceToken.toLowerCase();
    if (this._isProjectConfigToken(lower)) {
      return this._getProjectConfigView({ name: name || 'cluster', flags, output });
    }

    // Real oc: a namespaced request scoped to a nonexistent namespace fails with
    // the API server's namespace NotFound before any empty-list rendering.
    if (!allNamespaces && this._getRequestUsesNamespace(resourceToken)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }

    if (['event', 'events', 'ev'].includes(lower)) return this._cmdGetEvents(tokens);

    const virtual = this._virtualViewGet(resourceToken, { name, flags, output, allNamespaces, namespace });
    if (virtual) return virtual;

    if (lower === 'all') return this._cmdGetAll({ flags, output, allNamespaces, namespace });

    const tokensList = resourceToken.split(',');
    const kinds = [];
    for (const kindToken of tokensList) {
      let kind = resolveKindToken(kindToken);
      if (!kind) {
        const dcAlias = ['dc', 'deploymentconfig', 'deploymentconfigs'];
        if (dcAlias.includes(kindToken.toLowerCase())) kind = 'Deployment';
      }
      if (!kind) return this._resourceTypeError(kindToken);
      kinds.push({ kind, token: kindToken });
    }

    const deprecationWarning = ['dc', 'deploymentconfig', 'deploymentconfigs'].includes(lower)
      ? 'warning: DeploymentConfig (dc) is deprecated in OpenShift 4.x — showing Deployments instead.\n'
      : '';
    const multiKindStructured = kinds.length > 1 && ['yaml', 'json', 'name', 'jsonpath', 'custom-columns'].includes(output.format);
    const combinedResources = [];
    const sections = [];
    let singleResource = null;

    for (const { kind } of kinds) {
      let resources = this._resources(kind);
      if (kind === 'Template') {
        const builtins = this._builtinTemplateObjects().filter(
          (template) =>
            !resources.some((resource) => resource.metadata?.name === template.metadata.name && resource.metadata?.namespace === 'openshift'),
        );
        resources = [...resources, ...builtins];
      }
      if (this._isNamespaced(kind) && !allNamespaces) {
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      }
      resources = this._filterResources(resources, kind, flags);
      if (names.length) {
        const matched = [];
        for (const requested of names) {
          // Exact names only: real `oc get` never prefix-matches object names.
          const found = resources.find((resource) => resource.metadata?.name === requested);
          if (!found) return this._err(this._notFoundMessage(kind, requested));
          if (!matched.includes(found)) matched.push(found);
        }
        resources = matched;
        singleResource = matched.length === 1 ? matched[0] : null;
      }
      if (flags['sort-by']) resources = this._sortResources(resources, flags['sort-by']);
      if (!resources.length) {
        if (multiKindStructured) continue;
        if (['yaml', 'json', 'name', 'jsonpath', 'custom-columns'].includes(output.format)) {
          sections.push(this._formatGetResult(kind, [], flags, { singleName: Boolean(name) }));
        } else {
          const scope = allNamespaces || !this._isNamespaced(kind) ? '' : ` in ${namespace} namespace`;
          sections.push(`No resources found${scope}.`);
        }
        continue;
      }
      if (multiKindStructured) {
        combinedResources.push(...resources);
        continue;
      }
      const rendered = this._formatGetResult(kind, resources, flags, { singleName: Boolean(name) && resources.length === 1, allNamespaces });
      if (rendered && typeof rendered === 'object' && rendered.error) return rendered;
      sections.push(rendered);
    }

    if (multiKindStructured) {
      return { error: false, message: deprecationWarning + this._formatResourcesStructured(combinedResources, flags, output) };
    }
    return { error: false, message: deprecationWarning + sections.filter((section) => section !== '').join('\n\n') };
  },

  _cmdGetAll({ flags, output, allNamespaces, namespace }) {
    // Real `oc get all` covers the `all` API category only. ConfigMaps, Secrets
    // and PVCs are deliberately NOT part of it.
    const order = [
      'Pod', 'Service', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob',
      'HorizontalPodAutoscaler', 'Route', 'BuildConfig', 'Build', 'ImageStream',
    ];
    const structured = ['yaml', 'json', 'name', 'jsonpath', 'custom-columns'].includes(output.format);
    const grouped = order.map((kind) => {
      let resources = this._resources(kind);
      if (this._isNamespaced(kind) && !allNamespaces) {
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      }
      resources = this._filterResources(resources, kind, flags);
      if (flags['sort-by']) resources = this._sortResources(resources, flags['sort-by']);
      return { kind, resources };
    });
    const visible = grouped.filter((entry) => entry.resources.length > 0);
    if (!visible.length) {
      if (structured) return this._ok(this._formatResourcesStructured([], flags, output));
      return this._ok(allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`);
    }
    if (structured) {
      const resources = visible.flatMap((entry) => entry.resources);
      return this._ok(this._formatResourcesStructured(resources, flags, output));
    }
    // `oc get all` prefixes each NAME with the resource reference so multiple
    // kinds can be told apart, and separates the per-kind tables with blank lines.
    const sections = visible.map((entry) => this._tableFor(entry.kind, entry.resources, {
      wide: output.format === 'wide',
      showLabels: Boolean(flags['show-labels']),
      noHeaders: Boolean(flags['no-headers']),
      namePrefix: true,
      namespaceColumn: Boolean(allNamespaces) && this._isNamespaced(entry.kind),
    }));
    return this._ok(sections.join('\n\n'));
  },

  /** YAML/JSON/name/jsonpath/custom-columns output for a mixed list of resources. */
  _formatResourcesStructured(resources, flags, output) {
    if (output.format === 'yaml' || output.format === 'json') {
      const list = {
        apiVersion: 'v1',
        kind: 'List',
        metadata: { resourceVersion: '' },
        items: resources.map((resource) => this._manifestFor(resource)),
      };
      return output.format === 'json' ? JSON.stringify(list, null, 4) : toYamlDocument(list);
    }
    if (output.format === 'name') {
      return resources.map((resource) => `${this._singularName(resource.kind)}/${resource.metadata?.name || resource.name}`).join('\n');
    }
    if (output.format === 'jsonpath') {
      if (!output.arg) return 'error: jsonpath requires a template';
      const subject = { kind: 'List', items: resources.map((resource) => this._manifestFor(resource)) };
      return evaluateJsonPath(subject, output.arg);
    }
    if (output.format === 'custom-columns') {
      const columns = String(output.arg || '')
        .split(',')
        .map((entry) => {
          const colon = entry.indexOf(':');
          return colon < 0 ? null : { header: entry.slice(0, colon), path: entry.slice(colon + 1) };
        })
        .filter(Boolean);
      if (!columns.length) return 'error: invalid custom-columns specification';
      const rows = resources.map((resource) => {
        const manifest = this._manifestFor(resource);
        return columns.map((column) => {
          const value = evaluateJsonPath(manifest, `{${column.path.trim()}}`);
          return value === '' ? '<none>' : String(value);
        });
      });
      return padTable(columns.map((column) => column.header), rows);
    }
    return '';
  },

  /** Virtual / projected resource views (`csv`, `og`, `istag`, `ingresscontroller`). */
  _virtualViewGet(resourceToken, context) {
    const lower = String(resourceToken || '').toLowerCase();
    const { name, flags, output, allNamespaces, namespace } = context;
    if (['csv', 'csvs', 'clusterserviceversion', 'clusterserviceversions'].includes(lower)) {
      return this._getCsvView({ flags, output, allNamespaces, namespace, name });
    }
    if (['operatorgroup', 'operatorgroups', 'og'].includes(lower)) {
      return this._getOperatorGroupView({ output, allNamespaces, namespace, name });
    }
    if (['istag', 'istags', 'imagestreamtag', 'imagestreamtags'].includes(lower)) {
      return this._getImageStreamTagView({ flags, output, allNamespaces, namespace, name });
    }
    if (['ingresscontroller', 'ingresscontrollers', 'ic'].includes(lower)) {
      return this._getIngressControllerView({ output, name });
    }
    if (['endpoints', 'endslices', 'endpointslices', 'ep'].includes(lower)) {
      return this._getEndpointsView({ flags, output, allNamespaces, namespace, name });
    }
    return null;
  },

  _subscriptionsInScope(namespace, allNamespaces) {
    let subscriptions = this._resources('Subscription');
    if (!allNamespaces) subscriptions = subscriptions.filter((subscription) => subscription.metadata?.namespace === namespace);
    return subscriptions;
  },

  _getCsvView({ flags, output, allNamespaces, namespace, name }) {
    const subscriptions = this._subscriptionsInScope(namespace, allNamespaces);
    if (!subscriptions.length) {
      return this._ok(allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`);
    }
    const rows = subscriptions.map((subscription) => {
      const spec = subscription.spec || {};
      const csvName = subscription.status?.installedCSV || `${spec.packageName || spec.name || subscription.metadata?.name}.v1.0.0`;
      const versionMatch = csvName.match(/\.v?(\d+\.\d+\.\d+)/);
      return {
        csvName,
        display: String(spec.packageName || spec.name || subscription.metadata?.name).replace(/-/g, ' '),
        version: versionMatch ? versionMatch[1] : '1.0.0',
        phase: subscription.status?.phase || 'Succeeded',
      };
    });
    const headers = ['NAME', 'DISPLAY', 'VERSION', 'REPLACES', 'PHASE'];
    const tableRows = rows.map((row) => [row.csvName, row.display, row.version, '', row.phase]);
    if (name) {
      const match = tableRows.find((row) => row[0] === name || row[0].startsWith(name));
      if (!match) return this._err(`Error from server (NotFound): clusterserviceversions.operators.coreos.com "${name}" not found`);
      return this._ok(padTable(headers, [match]));
    }
    return this._ok(padTable(headers, tableRows));
  },

  _getOperatorGroupView({ output, allNamespaces, namespace, name }) {
    const subscriptions = this._subscriptionsInScope(namespace, allNamespaces);
    if (!subscriptions.length) {
      return this._ok(allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`);
    }
    const groups = [
      { name: 'global-operators', namespace: allNamespaces ? 'openshift-operators' : namespace, age: '4h' },
      { name: 'olm-operators', namespace: 'openshift-operators', age: '4h' },
    ].filter((group) => allNamespaces || group.namespace === namespace);
    if (name) {
      const match = groups.find((group) => group.name === name);
      if (!match) return this._err(`Error from server (NotFound): operatorgroups.operators.coreos.com "${name}" not found`);
    }
    return this._ok(padTable(['NAME', 'AGE'], (name ? groups.filter((group) => group.name === name) : groups).map((group) => [group.name, group.age])));
  },

  _getImageStreamTagView({ flags, allNamespaces, namespace, name }) {
    let streams = this._resources('ImageStream');
    if (!allNamespaces) streams = streams.filter((stream) => stream.metadata?.namespace === namespace);
    const rows = [];
    for (const stream of streams) {
      const tags = stream.status?.tags || stream.spec?.tags || [];
      const repo = stream.status?.dockerImageRepository || `${INTERNAL_REGISTRY}/${stream.metadata?.namespace}/${stream.metadata?.name}`;
      if (!tags.length) {
        rows.push([`${stream.metadata?.name}:latest`, `${repo}:latest`, this._creationAge(stream)]);
        continue;
      }
      for (const tag of tags) {
        const tagName = tag.tag || tag.name;
        const reference = tag.items?.[0]?.dockerImageReference || `${repo}:${tagName}`;
        rows.push([`${stream.metadata?.name}:${tagName}`, reference, this._creationAge(stream)]);
      }
    }
    if (!rows.length) {
      return this._ok(allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`);
    }
    const filtered = name ? rows.filter((row) => row[0] === name || row[0].startsWith(name)) : rows;
    if (!filtered.length) return this._err(`Error from server (NotFound): imagestreamtags.image.openshift.io "${name}" not found`);
    return this._ok(padTable(['NAME', 'IMAGE REFERENCE', 'UPDATED'], filtered));
  },

  _getIngressControllerView({ output, name }) {
    const rows = [['default', '4h']];
    const filtered = name ? rows.filter((row) => row[0] === name) : rows;
    if (!filtered.length) {
      return this._err(`Error from server (NotFound): ingresscontrollers.operator.openshift.io "${name}" not found`);
    }
    if (output.format === 'yaml' || output.format === 'json') {
      const manifests = filtered.map((row) => ({
        apiVersion: 'operator.openshift.io/v1',
        kind: 'IngressController',
        metadata: { name: row[0], namespace: 'openshift-ingress-operator' },
        spec: { domain: APPS_DOMAIN, replicas: 2, defaultCertificate: { name: 'router-certs' } },
        status: { availableReplicas: 2, conditions: [{ type: 'Available', status: 'True', reason: 'Valid' }] },
      }));
      if (output.format === 'json') {
        return this._ok(JSON.stringify(name ? manifests[0] : { apiVersion: 'v1', kind: 'List', items: manifests }, null, 4));
      }
      return this._ok(toYamlDocument(name ? manifests[0] : { apiVersion: 'v1', kind: 'List', items: manifests }));
    }
    return this._ok(padTable(['NAME', 'AGE'], filtered));
  },

  _getEndpointsView({ flags, allNamespaces, namespace, name }) {
    let services = this._resources('Service');
    if (!allNamespaces) services = services.filter((service) => service.metadata?.namespace === namespace);
    const rows = [];
    for (const service of services) {
      if (name && service.metadata?.name !== name) continue;
      const selector = service.spec?.selector || {};
      const pods = this._getKindList('Pod').filter(
        (pod) =>
          pod.metadata?.namespace === service.metadata?.namespace &&
          Object.entries(selector).every(([key, value]) => (pod.metadata?.labels || {})[key] === value),
      );
      for (const port of service.spec?.ports || []) {
        const portName = port.name || `${port.port}-tcp`;
        if (!pods.length) {
          rows.push([service.metadata?.name, `<none>`, portName, '<none>', '<none>']);
          continue;
        }
        for (const pod of pods) {
          rows.push([service.metadata?.name, `<none>`, portName, pod.status?.podIP || '10.128.0.1', `${port.targetPort || port.port}/TCP`]);
        }
      }
      if (!service.spec?.ports?.length) rows.push([service.metadata?.name, '<none>', '<none>', '<none>', '<none>']);
    }
    if (!rows.length) {
      return this._ok(allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`);
    }
    return this._ok(padTable(['NAME', 'ENDPOINTS', 'PORT', 'ADDRESS', 'TARGET PORT'], rows));
  },

  _cmdGetEvents(tokens) {
    const spec = {
      shortValues: { '-n': 'namespace', '-o': 'output' },
      shortBools: { '-A': 'all-namespaces', '-w': 'watch' },
      longValues: ['namespace', 'output', 'field-selector', 'sort-by'],
      longBools: ['all-namespaces', 'watch', 'no-headers', 'show-labels'],
    };
    const { positionals, flags, tokens: rawTokens } = parseArgs(tokens, spec);
    const allNamespaces = this._isAllNamespaces(flags, rawTokens);
    const namespace = flags.namespace || this.currentProject;
    const output = this._outputFormat(flags);
    if (!allNamespaces) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    // `oc events` and `oc get events` both arrive here (the get path passes the full token list).
    let events = this._syntheticEvents({ namespace });
    if (!allNamespaces) {
      events = events.filter((event) => event.namespace === namespace);
    }
    events = this._filterEvents(events, flags);
    if (!events.length) {
      return this._ok(allNamespaces ? 'No events found.' : `No resources found in ${namespace} namespace.`);
    }
    return this._ok(this._formatEvents(events, { ...flags, output: flags.output }, { namespaceColumn: allNamespaces }));
  },
});

// ────────────────────────────────────────────────────────────────────────────
// `oc describe`, `oc logs`, `oc explain`, `oc status`
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdDescribe(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: ['show-events'],
    });
    if (!positionals.length) {
      return this._err('error: You must specify the type of resource to describe.\n\nUsage:\n  oc describe <resource> [<name>]\n\nUse "oc get" to list resources.');
    }
    const projectConfigRef = this._projectConfigRef(positionals);
    if (projectConfigRef) return this._describeProjectConfig(projectConfigRef);
    let { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0]);
    if (!name) {
      if (kind === 'Project') {
        name = this.currentProject;
      } else {
        return this._err('error: You must specify the name of the resource to describe.\n\nUsage:\n  oc describe <resource>/<name>');
      }
    }
    if (this._isNamespaced(kind)) {
      const namespace = flags.namespace || this.currentProject;
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    return this._ok(this._describeResource(kind, resource));
  },

  _cmdLogs(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      shortBools: { '-f': 'follow', '-p': 'previous' },
      longValues: ['namespace', 'container', 'tail', 'since', 'since-time', 'version'],
      longBools: ['follow', 'previous', 'timestamps', 'all-containers'],
    });
    if (!positionals.length) {
      return this._err('error: you must specify a resource to get logs from.\n\nUsage:\n  oc logs <pod|deployment/name|build/name|bc/name> [flags]');
    }
    const namespace = flags.namespace || this.currentProject;
    const explicitNamespace = Boolean(flags.namespace);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const tail = flags.tail !== undefined && flags.tail !== true ? parseInt(flags.tail, 10) : null;
    const { kind, name } = this._resolveRef(positionals);
    const targetKind = kind || 'Pod';
    const targetName = name || positionals[0];

    if (targetKind === 'Build' || targetKind === 'BuildConfig') {
      return this._logsForBuild(targetKind, targetName, { namespace, explicitNamespace, flags });
    }
    if (targetKind === 'Deployment' || targetKind === 'DeploymentConfig' || targetKind === 'ReplicaSet' || targetKind === 'StatefulSet' || targetKind === 'DaemonSet') {
      return this._logsForWorkload(targetKind, targetName, { namespace, explicitNamespace, flags, tail });
    }
    if (targetKind !== 'Pod') return this._resourceTypeError(targetKind);
    return this._logsForPod(targetName, { namespace, explicitNamespace, flags, tail });
  },

  _logsForPod(podName, options) {
    const pod = this._findResource('Pod', podName, {
      namespace: options.namespace,
      explicitNamespace: options.explicitNamespace,
      allowPrefix: false,
    });
    if (!pod) return this._err(this._notFoundMessage('Pod', podName));
    const containers = this._containerList(pod);
    const containerName = options.flags.container && options.flags.container !== true ? String(options.flags.container) : containers[0]?.name || 'main';
    if (containers.length && !containers.some((container) => container.name === containerName)) {
      return this._err(`Error from server (BadRequest): container "${containerName}" is not valid for pod "${pod.metadata?.name}"`);
    }
    const phase = pod.status?.phase || 'Pending';
    const podState = this._podStatus(pod);
    if (phase === 'Pending') {
      const reason = (pod.status?.containerStatuses || []).find((entry) => entry.state?.waiting)?.state?.waiting?.reason || 'ContainerCreating';
      return this._err(`error: container "${containerName}" in pod "${pod.metadata?.name}" is waiting to start: ${reason}`);
    }
    let lines = this._podLogLines(pod, containerName, Boolean(options.flags.previous));
    if (Number.isFinite(options.tail) && options.tail >= 0) lines = lines.slice(-options.tail);
    return this._ok(lines.join('\n'));
  },

  _podLogLines(pod, containerName, previous) {
    const name = pod.metadata?.name || 'pod';
    const created = pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : Date.now() - 120000;
    const port = this._containerList(pod).find((container) => container.name === containerName)?.ports?.[0]?.containerPort || 8080;
    const image = this._containerList(pod).find((container) => container.name === containerName)?.image || 'nginx:latest';
    const podState = this._podStatus(pod);
    const crashing = /CrashLoopBackOff|Error|OOMKilled|CreateContainerConfigError/.test(podState.status) || pod.status?.phase === 'Failed';
    if (previous) {
      return [
        'Starting application...',
        `FATAL: could not connect to database at ${name}-db:5432`,
        '    at Object.<anonymous> (/opt/app-root/src/server.js:42:11)',
        '    at Module._compile (node:internal/modules/cjs/loader:1256:14)',
        'Error: connect ECONNREFUSED 10.128.0.42:5432',
        '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)',
        'npm ERR! code ELIFECYCLE',
        `npm ERR! errno 1`,
        'Process exited with status 1',
      ];
    }
    if (crashing) {
      return [
        'Starting application...',
        `FATAL: unable to reach downstream service for image ${image}`,
        'Error: connect ETIMEDOUT',
        '    at Socket.<anonymous> (/opt/app-root/src/lib/client.js:88:15)',
        'npm ERR! code ELIFECYCLE',
        'Process exited with status 1',
        '[container terminated: OOMKilled]',
      ];
    }
    const stamps = [0, 1200, 2800, 4500, 6200].map((offset) => new Date(created + offset).toISOString());
    return [
      `${stamps[0]} Starting application...`,
      `${stamps[1]} Server listening on port ${port}`,
      `${stamps[2]} GET /healthz 200 3ms`,
      `${stamps[3]} GET / 200 12ms`,
      `${stamps[4]} Health check passed — ready to serve traffic`,
    ];
  },

  _logsForWorkload(kind, name, options) {
    const workload = this._findResource(kind, name, {
      namespace: options.namespace,
      explicitNamespace: options.explicitNamespace,
      allowPrefix: false,
    });
    if (!workload) return this._err(this._notFoundMessage(kind, name));
    const selector = workload.spec?.selector?.matchLabels || {};
    const pods = this._getKindList('Pod').filter(
      (pod) =>
        pod.metadata?.namespace === workload.metadata?.namespace &&
        Object.entries(selector).every(([key, value]) => (pod.metadata?.labels || {})[key] === value),
    );
    if (!pods.length) return this._err(`error: no pods found for ${kind.toLowerCase()} "${name}"`);
    const pod = pods.find((candidate) => candidate.status?.phase === 'Running') || pods[0];
    const prefix = pods.length > 1 ? `Found ${pods.length} pods, using pod/${pod.metadata?.name}\n` : '';
    const lines = this._podLogLines(pod, this._containerList(pod)[0]?.name || 'main', Boolean(options.flags.previous));
    const tail = Number.isFinite(options.tail) && options.tail >= 0 ? lines.slice(-options.tail) : lines;
    return this._ok(prefix + tail.join('\n'));
  },

  _logsForBuild(kind, name, options) {
    let build = null;
    if (kind === 'Build') {
      build = this._findResource('Build', name, { namespace: options.namespace, explicitNamespace: options.explicitNamespace });
      if (!build) return this._err(this._notFoundMessage('Build', name));
    } else {
      const buildConfig = this._findResource('BuildConfig', name, { namespace: options.namespace, explicitNamespace: options.explicitNamespace });
      if (!buildConfig) return this._err(this._notFoundMessage('BuildConfig', name));
      const version = options.flags.version && options.flags.version !== true ? parseInt(options.flags.version, 10) : null;
      const builds = this._getKindList('Build').filter(
        (candidate) =>
          candidate.metadata?.namespace === buildConfig.metadata?.namespace &&
          (candidate.metadata?.labels?.buildconfig === name ||
            candidate.metadata?.labels?.['buildconfig.openshift.io/name'] === name ||
            candidate.spec?.buildConfig?.name === name),
      );
      if (!builds.length) return this._err(`error: no builds found for build config "${name}"`);
      build = version
        ? builds.find((candidate) => candidate.metadata?.name === `${name}-${version}`) || builds[builds.length - 1]
        : builds[builds.length - 1];
    }
    return this._ok(this._buildLogLines(build).join('\n'));
  },

  _buildLogLines(build) {
    const phase = build.status?.phase || 'Running';
    const name = build.metadata?.name || 'build';
    const gitUri = build.spec?.source?.git?.uri || 'https://github.com/sclorg/nodejs-ex';
    const strategy = build.spec?.strategy?.type || 'Source';
    const builder = build.spec?.strategy?.sourceStrategy?.from?.name || 'nodejs:20';
    const lines = [
      `Cloning "${gitUri}" ...`,
      'Commit: 3f2a9c1 (main)',
      '---> Installing application source...',
      '---> Building your application from source',
      `INFO Checking if ${builder} image stream exists...`,
      `STEP 1/5: FROM image-registry.openshift-image-registry.svc:5000/openshift/${builder.replace(':', '-')}:latest`,
      'STEP 2/5: COPY ./src /tmp/src',
      'STEP 3/5: RUN npm install',
    ];
    if (phase === 'New' || phase === 'Pending') {
      lines.push('info: build is queued — no logs produced yet');
      return lines;
    }
    if (phase === 'Running') {
      lines.push('STEP 4/5: RUN npm run build', '... (build still running)');
      return lines;
    }
    lines.push('STEP 4/5: RUN npm run build', 'STEP 5/5: CMD ["npm", "start"]');
    if (phase === 'Failed') {
      lines.push('error: build error: exit status 1', `error: build ${name} failed`);
    } else if (phase === 'Cancelled') {
      lines.push(`build ${name} was cancelled`);
    } else {
      lines.push('Push successful', `Build ${name} completed successfully`);
    }
    return lines;
  },

  _cmdExplain(tokens) {
    const { positionals, flags } = parseArgs(tokens, { longBools: ['recursive'] });
    if (!positionals.length) {
      return this._err("error: You must specify a resource type.\n\nUsage:\n  oc explain <resource>[.<field>]\n\nExamples:\n  oc explain route\n  oc explain route.spec.tls");
    }
    const token = positionals[0];
    const rawParts = token.split('.');
    let kind = null;
    let fieldStart = rawParts.length;
    for (let i = rawParts.length; i >= 1; i--) {
      const candidate = normalizeKind(rawParts.slice(0, i).join('.'));
      if (candidate) {
        kind = candidate;
        fieldStart = i;
        break;
      }
    }
    if (!kind) return this._resourceTypeError(rawParts[0]);
    const fieldPath = rawParts.slice(fieldStart).join('.');
    const apiVersion = apiVersionForKind(kind);
    const fields = EXPLAIN_FIELDS[kind] || {
      metadata: 'ObjectMeta - Standard object metadata.',
      spec: `${kind}Spec - Desired state of the resource.`,
      status: `${kind}Status - Observed state of the resource.`,
    };
    const description = explainForKind(kind) || `${kind} is an OpenShift resource (${apiVersion}).`;
    const indent = (text) => text.split('\n').map((line) => `  ${line}`).join('\n');

    if (!fieldPath) {
      const topLevel = ['apiVersion', 'kind', 'metadata', 'spec', 'status'];
      const known = Object.keys(fields).filter((path) => !path.includes('.'));
      const names = [...new Set([...topLevel, ...known])];
      if (flags.recursive) {
        return this._ok(
          `KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nDESCRIPTION:\n${indent(description)}\n\nFIELDS:\n${Object.entries(fields)
            .map(([path, text]) => `   ${path.padEnd(40)} ${text}`)
            .join('\n')}`,
        );
      }
      const fieldLines = names
        .map((name) => {
          const text = fields[name] || (name === 'apiVersion' ? 'string - API version of this object.' : name === 'kind' ? 'string - Kind of this object.' : '');
          return `   ${name.padEnd(40)} ${text}`;
        })
        .join('\n');
      return this._ok(`KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nDESCRIPTION:\n${indent(description)}\n\nFIELDS:\n${fieldLines}`);
    }

    const exact = fields[fieldPath];
    if (!exact) {
      return this._err(`error: field "${fieldPath}" does not exist`);
    }
    const children = Object.entries(fields)
      .filter(([path]) => path.startsWith(`${fieldPath}.`) && path.split('.').length === fieldPath.split('.').length + 1)
      .map(([path, text]) => `   ${path.split('.').pop().padEnd(36)} ${text}`)
      .join('\n');
    return this._ok(
      `KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nFIELD:    ${fieldPath}\n\nDESCRIPTION:\n${indent(exact)}${children ? `\n\nFIELDS:\n${children}` : ''}`,
    );
  },

  _cmdStatus(tokens) {
    const { flags } = parseArgs(tokens, { shortValues: { '-n': 'namespace' }, longValues: ['namespace'] });
    const namespace = flags.namespace || this.currentProject;
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const inScope = (resource) => resource.metadata?.namespace === namespace;
    const deployments = this._resources('Deployment').filter(inScope);
    const services = this._resources('Service').filter(inScope);
    const routes = this._resources('Route').filter(inScope);
    const builds = this._resources('Build').filter(inScope);
    const pods = this._getKindList('Pod').filter(inScope);

    const lines = [`In project ${namespace} on server ${OC_SERVER_URL}`, ''];
    if (!deployments.length && !services.length && !routes.length && !pods.length && !builds.length) {
      lines.push(`You have no visible resources in project "${namespace}".`);
    } else {
      for (const service of services) {
        lines.push(`svc/${service.metadata?.name} - ${this._serviceClusterIP(service)}:${service.spec?.ports?.[0]?.port || 80}`);
        const selector = service.spec?.selector || {};
        const matchingDeployments = deployments.filter((deployment) =>
          Object.entries(selector).every(([key, value]) => (deployment.spec?.template?.metadata?.labels || {})[key] === value),
        );
        for (const deployment of matchingDeployments) {
          const image = this._containerList(deployment)[0]?.image || 'nginx:latest';
          const replicas = deployment.spec?.replicas ?? 1;
          const ready = deployment.status?.readyReplicas ?? 0;
          lines.push(`  deployment/${deployment.metadata?.name} deploys ${image}`);
          lines.push(`    deployment #${deployment.status?.observedGeneration ?? 1} running for ${this._creationAge(deployment)} - ${ready}/${replicas} pods`);
        }
        lines.push('');
      }
      const referencedDeployments = new Set();
      for (const service of services) {
        const selector = service.spec?.selector || {};
        for (const deployment of deployments) {
          if (Object.entries(selector).every(([key, value]) => (deployment.spec?.template?.metadata?.labels || {})[key] === value)) {
            referencedDeployments.add(deployment.metadata?.name);
          }
        }
      }
      for (const deployment of deployments.filter((candidate) => !referencedDeployments.has(candidate.metadata?.name))) {
        lines.push(`deployment/${deployment.metadata?.name} deploys ${this._containerList(deployment)[0]?.image || 'nginx:latest'} (${deployment.status?.readyReplicas ?? 0}/${deployment.spec?.replicas ?? 1} pods)`);
        lines.push('');
      }
      for (const route of routes) {
        lines.push(`route.route.openshift.io/${route.metadata?.name} - ${this._routeHost(route)}`);
        lines.push(`  exposed by ${this._routeAdmitted(route) ? 'router default (Admitted)' : 'router default (NOT admitted: no endpoints)'}`);
      }
      if (routes.length) lines.push('');
      const failedBuilds = builds.filter((build) => ['Failed', 'Cancelled'].includes(build.status?.phase));
      for (const build of failedBuilds) {
        lines.push(`build/${build.metadata?.name} ${String(build.status?.phase).toLowerCase()} ${this._creationAge(build)} ago`);
        if (build.status?.message) lines.push(`  ${build.status.message}`);
        lines.push('');
      }
    }
    const plural = (count, singular, pluralForm) => `${count} ${count === 1 ? singular : pluralForm}`;
    lines.push(
      `${plural(pods.length, 'pod', 'pods')}, ${plural(services.length, 'service', 'services')}, ${plural(routes.length, 'route', 'routes')}${deployments.length ? `, ${plural(deployments.length, 'deployment', 'deployments')}` : ''}`,
      '',
      "View details with 'oc describe <resource>/<name>' or list everything with 'oc get all'.",
    );
    return this._ok(lines.join('\n'));
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Session / context commands: login, logout, whoami, project(s), new-project,
// config, version, api-resources
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _htpasswdUsers() {
    const me = this.manifestEngine;
    // HTPasswd file is seeded but may be managed by ManifestEngine htpasswdList.

    let entries = null;
    if (me && typeof me.htpasswdList === 'function') {
      try {
        entries = me.htpasswdList();
      } catch {
        entries = null;
      }
    }
    if (Array.isArray(entries)) {
      return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.user || entry?.name || ''))
        .filter(Boolean);
    }
    const file = this._readVirtualFile('htpasswd');
    if (typeof file === 'string') {
      return file
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.split(':')[0])
        .filter(Boolean);
    }
    return [];
  },

  _cmdLogin(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-u': 'username', '-p': 'password' },
      longValues: ['username', 'password', 'server', 'token'],
      longBools: [],
    });
    let user = flags.username && flags.username !== true ? String(flags.username) : null;
    let password = flags.password && flags.password !== true ? String(flags.password) : null;
    let server = flags.server && flags.server !== true ? String(flags.server) : OC_SERVER_URL;
    const token = flags.token && flags.token !== true ? String(flags.token) : null;
    for (const positional of positionals) {
      if (/^https?:\/\//.test(positional)) server = positional;
      else if (!user) user = positional;
    }
    if (token && !user) user = 'kubeadmin';
    if (!user) {
      return this._usageError(
        'login',
        'you must specify a username\n\n  oc login -u <username> -p <password>\n\n(or provide --token=<token>)',
      );
    }

    const ge = this.gameEngine;
    let success = false;
    let message = '';
    let loginThrew = null;
    let loginReturned;
    const hadLoginApi = Boolean(ge && typeof ge.login === 'function');
    if (hadLoginApi) {
      try {
        loginReturned = ge.login(user, password);
      } catch (error) {
        loginThrew = error && error.message ? error.message : String(error);
      }
    }
    if (loginThrew) return this._err(`Login failed (500 Internal Server Error): ${loginThrew}`);
    if (loginReturned === true) success = true;
    else if (loginReturned === false) success = false;
    else if (loginReturned && typeof loginReturned === 'object') {
      success = loginReturned.success !== false && !loginReturned.error;
      if (typeof loginReturned.message === 'string') message = loginReturned.message;
      if (loginReturned.user) user = loginReturned.user;
    } else if (hadLoginApi) {
      // Engine login may update state without returning a value.
      success = String(ge?.currentUser || '') === user;
    } else {
      // Pre-engine fallback: kubeadmin/admin always work; HTPasswd users are
      // accepted when the virtual htpasswd file lists them.
      if (user === 'kubeadmin' || user === 'admin' || user === 'system:admin') {
        success = true;
      } else if (this._htpasswdUsers().includes(user)) {
        success = true;
      } else if (token) {
        success = true;
      } else {
        message = `Login failed (401 Unauthorized)\nThe user "${user}" is not known to the configured identity provider: no identity provider is configured on this cluster.`;
      }
    }

    if (!success) {
      if (!message) {
        const providerReady = Boolean(ge?.authProvider?.ready);
        if (!providerReady) {
          message = ge?.authProvider
            ? 'Login failed (401 Unauthorized)\nThe HTPasswd identity provider is not ready yet: wait for the OAuth rollout to complete (oc get clusteroperators authentication) and try again.'
            : `Login failed (401 Unauthorized)\nThe user "${user}" is not known to the configured identity provider: no identity provider is configured on this cluster.`;
        } else {
          message = 'Login failed (401 Unauthorized)\nVerify you have provided the correct credentials.';
        }
      }
      return this._err(message);
    }

    if (ge) {
      try {
        ge.currentUser = user;
      } catch {
        /* ignore */
      }
    }
    // GameEngine.login() emits `login` itself; only emit in the pre-engine fallback.
    if (!hadLoginApi) this._emit('login', { user, server });

    const projects = this._projectNames();
    const current = this.currentProject;
    const lines = [
      'Login successful.',
      '',
      `You have access to ${projects.length} project${projects.length === 1 ? '' : 's'}, the list of projects are:`,
      ...projects.map((project) => `    ${project === current ? '* ' : '  '}${project}`),
      '',
    ];
    if (projects.includes(current)) lines.push(`Using project "${current}".`);
    else if (projects.length) lines.push(`Using project "${projects[0]}".`);
    return this._ok(lines.join('\n'));
  },

  _cmdLogout() {
    const ge = this.gameEngine;
    const user = this.currentUser;
    let message = `Logged out '${user}' on '${OC_SERVER_URL}'`;
    if (ge && typeof ge.logout === 'function') {
      try {
        const result = ge.logout();
        if (result && typeof result === 'object' && typeof result.message === 'string') message = result.message;
      } catch {
        /* fall through */
      }
    } else if (ge) {
      try {
        ge.currentUser = null;
      } catch {
        /* ignore */
      }
    }
    if (!ge || typeof ge.logout !== 'function') this._emit('logout', { user });
    return this._ok(message);
  },

  _cmdWhoami(tokens) {
    const { flags } = parseArgs(tokens, {
      shortBools: { '-c': 'show-context', '-t': 'show-token' },
      longBools: ['show-server', 'show-context', 'show-token', 'show-console'],
    });
    const ge = this.gameEngine;
    const loggedOut = Boolean(ge && 'currentUser' in ge && !ge.currentUser);
    if (loggedOut) return this._err('error: You must be logged in to the server (Unauthorized)');
    if (flags['show-server']) return this._ok(OC_SERVER_URL);
    if (flags['show-console']) return this._ok(OC_CONSOLE_URL);
    if (flags['show-context']) return this._ok(`${this.currentUser}/api-cluster-example-com:6443/${this.currentUser}`);
    if (flags['show-token']) return this._ok(`sha256~${stableHash(`${this.currentUser}-token`, 99999999).toString(16).padStart(8, '0')}`);
    return this._ok(this.currentUser);
  },

  _cmdProject(tokens) {
    const { positionals, flags } = parseArgs(tokens, { longBools: ['short'] });
    if (!positionals.length) {
      return this._ok(`Using project "${this.currentProject}" on server "${OC_SERVER_URL}".`);
    }
    const name = positionals[0];
    if (!this._projectExists(name)) {
      return this._err(`error: A project named "${name}" does not exist on "${OC_SERVER_URL}".`);
    }
    const result = this._setCurrentProject(name);
    if (result.error) return result;
    if (flags.short) return this._ok(name);
    return this._ok(`Now using project "${name}" on server "${OC_SERVER_URL}".`);
  },

  _cmdProjects(tokens) {
    const { flags } = parseArgs(tokens, { longBools: ['short', 'quiet'] });
    if (flags.quiet || flags.short) {
      return this._ok(this._projectNames().join('\n'));
    }
    const projects = this._projectNames();
    const current = this.currentProject;
    if (!projects.length) {
      return this._ok('You have access to no projects. Create one with "oc new-project <name>".');
    }
    const lines = [
      "You have access to the following projects and can switch between them with 'oc project <projectname>':",
      '',
      ...projects.map((project) => `  ${project === current ? '* ' : '  '}${project}`),
      '',
      `Using project "${current}" on server "${OC_SERVER_URL}".`,
    ];
    return this._ok(lines.join('\n'));
  },

  _cmdNewProject(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      longValues: ['display-name', 'description'],
      longBools: [],
    });
    const name = positionals[0];
    if (!name) {
      return this._usageError('new-project', 'project name is required\n\n  oc new-project <name> [--display-name=<name>] [--description=<text>]');
    }
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
      return this._err(
        `error: project name "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      );
    }
    if (this._projectExists(name)) {
      return this._err(`Error from server (AlreadyExists): project.project.openshift.io "${name}" already exists`);
    }
    const displayName = flags['display-name'] && flags['display-name'] !== true ? String(flags['display-name']) : '';
    const description = flags.description && flags.description !== true ? String(flags.description) : '';
    const ge = this.gameEngine;
    if (ge && typeof ge.createProject === 'function') {
      const result = ge.createProject(name, { displayName, description });
      if (result.success === false) return this._err(result.message);
    } else {
      const created = this._createObject(
        'Project',
        name,
        { displayName, description },
        {
          labels: { 'kubernetes.io/metadata.name': name },
          annotations: { 'openshift.io/requester': this.currentUser },
        },
      );
      if (created.error) return created.error;
      this._setCurrentProject(name);
    }
    return this._ok(
      [
        `Now using project "${name}" on server "${OC_SERVER_URL}".`,
        '',
        "You can add applications to this project with the 'new-app' command. For example, try:",
        '',
        `    oc new-app ${S2I_IMAGES.nodejs}~https://github.com/sclorg/nodejs-ex`,
        '',
        'to build a new example application in JavaScript.',
      ].join('\n'),
    );
  },

  _cmdConfig(tokens) {
    const { positionals } = parseArgs(tokens, {});
    const sub = (positionals[0] || '').toLowerCase();
    const contextName = `${this.currentUser}/api-cluster-example-com:6443/${this.currentUser}`;
    if (!sub) {
      return this._err("error: you must specify a subcommand\n\nValid subcommands: current-context, view, get-contexts, use-context");
    }
    if (sub === 'current-context') return this._ok(contextName);
    if (sub === 'get-contexts') {
      return this._ok(padTable(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], [['*', contextName, 'cluster', this.currentUser, this.currentProject]]));
    }
    if (sub === 'view') {
      const kubeconfig = {
        apiVersion: 'v1',
        clusters: [{ cluster: { server: OC_SERVER_URL }, name: 'cluster' }],
        contexts: [{ context: { cluster: 'cluster', namespace: this.currentProject, user: this.currentUser }, name: contextName }],
        'current-context': contextName,
        kind: 'Config',
        preferences: {},
        users: [{ name: this.currentUser, user: { token: 'sha256~simulated-kubeconfig-token' } }],
      };
      return this._ok(toYamlDocument(kubeconfig));
    }
    if (sub === 'use-context') {
      const context = positionals[1];
      if (!context) return this._usageError('config', 'context name is required\n\n  oc config use-context <context-name>');
      return this._ok(`Switched to context "${context}".`);
    }
    return this._err(`error: unknown subcommand "${sub}" for "oc config"`);
  },

  _cmdVersion(tokens) {
    const { flags } = parseArgs(tokens, {
      shortValues: { '-o': 'output' },
      longValues: ['output'],
      longBools: ['client'],
    });
    const output = this._outputFormat(flags);
    const clientVersion = {
      major: '4',
      minor: '22',
      gitVersion: OCP_GIT_VERSION,
      gitCommit: '3f6a91c',
      gitTreeState: 'clean',
      buildDate: '2026-10-28T15:03:00Z',
      goVersion: 'go1.24.6',
      compiler: 'gc',
      platform: 'linux/amd64',
    };
    const serverVersion = {
      major: '4',
      minor: '22',
      gitVersion: OCP_GIT_VERSION,
      gitCommit: '3f6a91c',
      gitTreeState: 'clean',
      buildDate: '2026-10-28T15:03:00Z',
      goVersion: 'go1.24.6',
      compiler: 'gc',
      platform: 'linux/amd64',
      kubernetesVersion: KUBERNETES_GIT_VERSION,
    };
    // `oc version --client` omits server data; `-o json|yaml` uses the K8s
    // Info-shaped object (clientVersion/kustomizeVersion/serverVersion +
    // OpenShift-specific releaseClientVersion/openshiftVersion).
    const object = flags.client
      ? { clientVersion, kustomizeVersion: 'v5.7.1', releaseClientVersion: `${OCP_VERSION}`, openshiftVersion: OCP_VERSION }
      : {
          clientVersion,
          kustomizeVersion: 'v5.7.1',
          releaseClientVersion: `${OCP_VERSION}`,
          openshiftVersion: OCP_VERSION,
          serverVersion,
        };
    if (output.format === 'json') return this._ok(JSON.stringify(object, null, 4));
    if (output.format === 'yaml') return this._ok(toYamlDocument(object));
    if (output.format !== 'table') {
      return this._err(`error: unable to match a printer suitable for the output format "${String(flags.output)}"`);
    }
    if (flags.client) {
      return this._ok(`Client Version: ${OC_CLIENT_VERSION}\nKustomize Version: v5.7.1`);
    }
    return this._ok(
      `Client Version: ${OC_CLIENT_VERSION}\nKustomize Version: v5.7.1\nServer Version: ${OC_SERVER_VERSION}\nKubernetes Version: ${KUBERNETES_GIT_VERSION}`,
    );
  },

  _cmdApiResources(tokens) {
    const { flags } = parseArgs(tokens, {
      shortValues: { '-o': 'output' },
      longValues: ['api-group', 'namespaced', 'sort-by', 'output'],
      longBools: ['namespaced', 'verbs', 'no-headers'],
    });
    const namespacedFilter =
      flags.namespaced === undefined ? null : flags.namespaced === true ? true : String(flags.namespaced).toLowerCase() === 'true';
    const apiGroup = flags['api-group'] && flags['api-group'] !== true ? String(flags['api-group']) : null;
    const wide = String(flags.output || '') === 'wide' || Boolean(flags.verbs);
    const allVerbs = flags.verbs && flags.verbs !== true ? String(flags.verbs).split(',').filter(Boolean) : ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'];
    let rows = Object.entries(KIND_DEFS)
      .filter(([, definition]) => {
        const apiVersion = definition.apiVersion || 'v1';
        const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
        if (apiGroup !== null && group !== apiGroup) return false;
        if (namespacedFilter !== null && Boolean(definition.namespaced !== false) !== namespacedFilter) return false;
        return true;
      })
      .map(([kind, definition]) => {
        const plural = pluralForKind(kind);
        const singular = kind.toLowerCase();
        const shortNames = (definition.aliases || [])
          .filter((alias) => alias !== plural && alias !== singular && alias.length <= 8)
          .slice(0, 3)
          .join(',');
        const row = [plural, shortNames, definition.apiVersion, String(definition.namespaced !== false), kind];
        if (wide) row.push(allVerbs.join(','));
        return row;
      })
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const headers = ['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', ...(wide ? ['VERBS'] : [])];
    const table = padTable(headers, rows);
    if (flags['no-headers']) return this._ok(table.split('\n').slice(1).join('\n'));
    return this._ok(table);
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Mutations: create / apply / replace / delete
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _arrayFlag(flags, name) {
    const value = flags[name];
    if (value === undefined || value === null || value === true) return [];
    return Array.isArray(value) ? value : [value];
  },

  _base64(text) {
    const value = String(text ?? '');
    try {
      if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(value)));
    } catch {
      /* fall through */
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
    return value;
  },

  _basename(path) {
    return String(path).split('/').pop() || path;
  },

  /** Resolve PEM material from a virtual file, literal PEM or simulated fallback. */
  _certMaterial(value, kind, warnings) {
    if (!value || value === true) {
      warnings.push(`warning: no ${kind.toLowerCase()} file supplied; using a simulated self-signed ${kind.toLowerCase()}`);
      return `-----BEGIN ${kind}-----\nMIIDazCCAlOgAwIBAgIU simulated-by-openshift-games\n-----END ${kind}-----`;
    }
    const text = String(value);
    if (/-----BEGIN [A-Z ]+-----/.test(text)) return text;
    const file = this._readVirtualFile(text);
    if (file !== null) return file;
    warnings.push(`warning: "${text}" not found in the virtual filesystem; using a simulated ${kind.toLowerCase()}`);
    return `-----BEGIN ${kind}-----\nMIIDazCCAlOgAwIBAgIU simulated-openshift-games-${this._basename(text)}\n-----END ${kind}-----`;
  },

  _createFlagSpec() {
    return {
      shortValues: { '-n': 'namespace', '-f': 'filename', '-o': 'output', '-z': 'serviceaccount', '-c': 'container', '-p': 'port', '-l': 'labels' },
      longValues: [
        'namespace', 'filename', 'output', 'image', 'replicas', 'type', 'labels', 'display-name',
        'description', 'full-name', 'from', 'docker-server', 'docker-username', 'docker-password',
        'docker-email', 'cert', 'key', 'ca-cert', 'external-name', 'target-port', 'port', 'name',
        'clusterrole', 'role', 'serviceaccount', 'user', 'group', 'hard', 'scopes', 'default',
        'default-request', 'max', 'min', 'max-limit-request-ratio', 'project-label-selector',
        'project-annotation-selector', 'tcp', 'udp', 'dry-run', 'context-dir', 'source-secret',
        'strategy', 'image-stream', 'code', 'template', 'schedule', 'command', 'timezone',
        'restart', 'active-deadline-seconds', 'completions', 'parallelism', 'backoff-limit',
        'verb', 'resource-name', 'api-group', 'resource',
      ],
      multi: ['from-literal', 'from-file', 'from-env-file', 'hard', 'tcp', 'udp', 'env', 'param', 'user', 'group', 'serviceaccount', 'verb', 'resource', 'resource-name', 'api-group'],
      longBools: ['dry-run', 'validate', 'overwrite'],
    };
  },

  _dryRunMode(flags) {
    const value = flags['dry-run'];
    if (!value) return null;
    if (value === true) return 'client';
    return String(value);
  },

  /** Emit a created manifest (or render it for --dry-run). */
  _finishCreateObject(object, flags, options = {}) {
    const warnings = options.warnings || [];
    const dryRun = this._dryRunMode(flags);
    const output = this._outputFormat(flags);
    const name = object.metadata?.name || 'unnamed';
    if (dryRun) {
      // `oc create secret/configmap … -o yaml` is rendered in real API shape
      // (top-level type/data), so `--dry-run=client -o yaml | oc replace -f -`
      // round-trips like a real cluster.
      const displayObject = this._apiShapedDryRunObject(object);
      if (output.format === 'yaml') return this._ok([...warnings, toYamlDocument(displayObject)].filter(Boolean).join('\n'));
      if (output.format === 'json') return this._ok([...warnings, JSON.stringify(displayObject, null, 4)].filter(Boolean).join('\n'));
      if (output.format === 'name') return this._ok(`${this._resourceRef(object.kind)}/${name}`);
      return this._ok([...warnings, `${this._resourceRef(object.kind)}/${name} created (dry run)`].filter(Boolean).join('\n'));
    }
    const result = this._applyObject(object);
    if (result.error) return result.error;
    return this._ok([...warnings, `${this._resourceRef(object.kind)}/${name} ${result.created === false ? 'configured' : 'created'}`].filter(Boolean).join('\n'));
  },

  _createFromFile(filename, ctx, command = 'create', flags = {}) {
    const path = filename && filename !== true ? String(filename) : '-';
    return this._applyFileDelegated(path, { stdinText: ctx?.stdin ?? null, command, flags });
  },

  /**
   * True when `oc create <subcommand>` creates a namespaced resource, so the
   * request needs a real Project (like the API server's namespace NotFound).
   */
  _createCommandUsesNamespace(sub) {
    if (!sub) return false;
    const text = String(sub).toLowerCase();
    if (['user', 'group', 'clusterrolebinding', 'clusterquota', 'clusterresourcequota', 'project', 'namespace', 'ns'].includes(text)) {
      return false;
    }
    if (['route', 'secret', 'configmap', 'cm', 'quota', 'resourcequota', 'limitrange', 'serviceaccount', 'sa', 'service', 'job', 'rolebinding'].includes(text)) {
      return true;
    }
    const kind = resolveKindToken(text);
    if (!kind) return false;
    return this._isNamespaced(kind);
  },

  _cmdCreate(tokens, ctx) {
    const { positionals, flags, afterDoubleDash } = parseArgs(tokens, this._createFlagSpec());
    if (flags.filename) return this._createFromFile(flags.filename, ctx, 'create', flags);
    if (!positionals.length) {
      return this._err(
        'error: must specify a resource type or -f <filename>.\n\n' +
          'Create resources by name:\n' +
          '  oc create deployment <name> --image=<image>\n' +
          '  oc create secret generic <name> --from-literal=key=value\n' +
          '  oc create configmap <name> --from-literal=key=value\n' +
          '  oc create quota <name> --hard=pods=20,requests.cpu=4\n' +
          '  oc create limitrange <name> --default=cpu=500m,memory=512Mi\n' +
          '  oc create clusterquota <name> --project-label-selector=env=dev --hard=pods=10\n' +
          '  oc create job <name> --image=<image> -- <command>\n' +
          '  oc create cronjob <name> --image=<image> --schedule="*/5 * * * *" -- <command>\n' +
          '  oc create user <name> | oc create group <name> [users...]\n' +
          '  oc create serviceaccount <name> | oc create rolebinding <name> --clusterrole=edit --user=<user>\n\n' +
          'Or from a manifest:\n  oc create -f <file>\n\nRun \'oc create --help\' for details.',
      );
    }
    const sub = positionals[0].toLowerCase();
    const rest = positionals.slice(1);
    // A real API server rejects namespaced creates whose project does not exist.
    if (this._createCommandUsesNamespace(sub)) {
      const namespaceError = this._requireNamespace(this._namespaceFromFlags(flags));
      if (namespaceError) return namespaceError;
    }
    switch (sub) {
      case 'route':
        return this._createRouteCommand(rest, flags);
      case 'secret':
        return this._createSecret(rest, flags);
      case 'configmap':
      case 'cm':
        return this._createConfigMap(rest, flags);
      case 'quota':
      case 'resourcequota':
        return this._createQuota(rest, flags);
      case 'limitrange':
        return this._createLimitRange(rest, flags);
      case 'clusterquota':
      case 'clusterresourcequota':
        return this._createClusterQuota(rest, flags);
      case 'user':
        return this._createUser(rest, flags);
      case 'group':
        return this._createGroup(rest, flags);
      case 'serviceaccount':
      case 'sa':
        return this._createServiceAccount(rest, flags);
      case 'rolebinding':
        return this._createRoleBindingCommand(rest, flags, false);
      case 'clusterrolebinding':
        return this._createRoleBindingCommand(rest, flags, true);
      case 'service':
        return this._createService(rest, flags);
      case 'job':
        return this._createJob(rest, flags, afterDoubleDash);
      case 'cronjob':
      case 'cj':
        return this._createCronJob(rest, flags, afterDoubleDash);
      case 'project':
        // `oc create project` is not a real oc subcommand (use `oc new-project`).
        return this._err('error: unknown command "project" for "oc create"\n\nRun \'oc create --help\' for usage.');
      case 'role':
        return this._createRoleCommand(rest, flags, false);
      case 'clusterrole':
        return this._createRoleCommand(rest, flags, true);
      case 'namespace':
      case 'ns':
        return this._createNamespace(rest, flags);
      default: {
        const kind = resolveKindToken(sub);
        if (!kind) return this._resourceTypeError(positionals[0]);
        return this._createGeneric(kind, rest[0], flags);
      }
    }
  },

  _createGeneric(kind, name, flags) {
    if (!name) {
      return this._usageError('create', `name is required for ${kind.toLowerCase()}\n\n  oc create ${kind.toLowerCase()} <name> [flags]`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const spec = defaultSpecForKind(kind);
    const image = flags.image && flags.image !== true ? String(flags.image) : flags['image-stream'] && flags['image-stream'] !== true ? `${INTERNAL_REGISTRY}/${namespace}/${String(flags['image-stream'])}` : null;
    if (spec.replicas !== undefined && !(flags.replicas && flags.replicas !== true)) spec.replicas = 1;
    if (spec.selector?.matchLabels) spec.selector.matchLabels = { app: name };
    if (spec.template?.metadata && kind !== 'Pod') spec.template.metadata.labels = { app: name };
    if (image) {
      const containers = kind === 'Pod' ? spec.containers : spec.template?.spec?.containers;
      if (Array.isArray(containers) && containers.length) containers[0].image = image;
      else if (kind === 'Pod') spec.containers = [{ name: 'main', image }];
      else {
        spec.template = spec.template || { metadata: { labels: { app: name } }, spec: {} };
        spec.template.spec = spec.template.spec || {};
        spec.template.spec.containers = [{ name: 'main', image }];
      }
    }
    if (flags.replicas && flags.replicas !== true) spec.replicas = Number(flags.replicas);
    if (kind === 'Service' && flags.port) {
      spec.ports = [{ name: 'http', port: Number(flags.port), targetPort: Number(flags['target-port'] || flags.port) }];
    }
    const labels = parseCommaAssignments(flags.labels && flags.labels !== true ? String(flags.labels) : []);
    if (kind === 'Job' || kind === 'CronJob' || kind === 'Pod') {
      spec.template = spec.template || {};
    }
    const object = {
      apiVersion: apiVersionForKind(kind),
      kind,
      metadata: { name, ...(this._isNamespaced(kind) ? { namespace } : {}), labels },
      spec,
    };
    return this._finishCreateObject(object, flags);
  },

  _createSecret(rest, flags) {
    const types = ['generic', 'tls', 'docker-registry', 'dockerconfigjson', 'basic-auth', 'ssh-auth'];
    let secretType = rest[0];
    let name = rest[1];
    if (!types.includes(secretType)) {
      name = rest[0];
      secretType = 'generic';
    }
    if (!name) {
      return this._err('error: must specify one of: generic, tls, docker-registry\n\n  oc create secret generic <name> --from-literal=key=value\n  oc create secret tls <name> --cert=tls.crt --key=tls.key\n  oc create secret docker-registry <name> --docker-server=... --docker-username=... --docker-password=...');
    }
    const namespace = this._namespaceFromFlags(flags);
    const warnings = [];
    const data = {};
    let type = 'Opaque';
    if (secretType === 'tls') {
      type = 'kubernetes.io/tls';
      const cert = this._certMaterial(flags.cert, 'CERTIFICATE', warnings);
      const key = this._certMaterial(flags.key, 'PRIVATE KEY', warnings);
      data['tls.crt'] = this._base64(cert);
      data['tls.key'] = this._base64(key);
    } else if (secretType === 'docker-registry' || secretType === 'dockerconfigjson') {
      type = 'kubernetes.io/dockerconfigjson';
      const server = flags['docker-server'] && flags['docker-server'] !== true ? String(flags['docker-server']) : 'https://index.docker.io/v1/';
      const username = flags['docker-username'] && flags['docker-username'] !== true ? String(flags['docker-username']) : '';
      const password = flags['docker-password'] && flags['docker-password'] !== true ? String(flags['docker-password']) : '';
      const email = flags['docker-email'] && flags['docker-email'] !== true ? String(flags['docker-email']) : '';
      const auth = this._base64(`${username}:${password}`);
      data['.dockerconfigjson'] = this._base64(JSON.stringify({ auths: { [server]: { username, password, email, auth } } }));
    } else if (secretType === 'basic-auth') {
      type = 'kubernetes.io/basic-auth';
      for (const [key, value] of Object.entries(parseCommaAssignments(this._arrayFlag(flags, 'from-literal')))) {
        data[key] = this._base64(value);
      }
    } else if (secretType === 'ssh-auth') {
      type = 'kubernetes.io/ssh-auth';
      const sshKey = this._certMaterial(flags['from-file'], 'OPENSSH PRIVATE KEY', warnings);
      data['ssh-privatekey'] = this._base64(sshKey);
    } else {
      for (const [key, value] of Object.entries(parseCommaAssignments(this._arrayFlag(flags, 'from-literal')))) {
        data[key] = this._base64(value);
      }
      for (const fileSpec of this._arrayFlag(flags, 'from-file')) {
        const eq = String(fileSpec).indexOf('=');
        const key = eq >= 0 ? String(fileSpec).slice(0, eq) : this._basename(String(fileSpec));
        const path = eq >= 0 ? String(fileSpec).slice(eq + 1) : String(fileSpec);
        const content = this._readVirtualFile(path);
        if (content === null) warnings.push(`warning: "${path}" not found in the virtual filesystem; using simulated content`);
        data[key] = this._base64(content ?? `simulated secret content for ${key}\n`);
      }
      for (const envFile of this._arrayFlag(flags, 'from-env-file')) {
        const content = this._readVirtualFile(String(envFile));
        if (content === null) {
          warnings.push(`warning: "${envFile}" not found in the virtual filesystem`);
          continue;
        }
        for (const line of content.split('\n')) {
          const match = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
          if (match) data[match[1]] = this._base64(match[2]);
        }
      }
      if (flags.type && flags.type !== true) type = String(flags.type);
    }
    const object = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace },
      spec: { type, data },
    };
    return this._finishCreateObject(object, flags, { warnings });
  },

  _createConfigMap(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create configmap <name> --from-literal=key=value [--from-file=path]');
    const namespace = this._namespaceFromFlags(flags);
    const data = { ...parseCommaAssignments(this._arrayFlag(flags, 'from-literal')) };
    for (const fileSpec of this._arrayFlag(flags, 'from-file')) {
      const eq = String(fileSpec).indexOf('=');
      const key = eq >= 0 ? String(fileSpec).slice(0, eq) : this._basename(String(fileSpec));
      const path = eq >= 0 ? String(fileSpec).slice(eq + 1) : String(fileSpec);
      data[key] = this._readVirtualFile(path) ?? `# simulated content for ${path}\n`;
    }
    for (const envFile of this._arrayFlag(flags, 'from-env-file')) {
      const content = this._readVirtualFile(String(envFile));
      if (!content) continue;
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
        if (match) data[match[1]] = match[2];
      }
    }
    const object = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace },
      spec: { data },
    };
    return this._finishCreateObject(object, flags);
  },

  _createQuota(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create quota <name> --hard=pods=20,requests.cpu=4,requests.memory=8Gi');
    const hard = parseCommaAssignments(this._arrayFlag(flags, 'hard'));
    if (!Object.keys(hard).length) return this._err('error: --hard is required (e.g. --hard=pods=20,requests.cpu=4,requests.memory=8Gi)');
    const scopes = flags.scopes && flags.scopes !== true ? String(flags.scopes).split(',').map((scope) => scope.trim()).filter(Boolean) : [];
    const namespace = this._namespaceFromFlags(flags);
    const spec = { hard, ...(scopes.length ? { scopes } : {}) };
    const object = { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name, namespace }, spec };
    if (this._dryRunMode(flags)) return this._finishCreateObject(object, flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.createResourceQuota === 'function') {
      const result = ge.createResourceQuota(name, hard, { namespace });
      if (result.success === false) return this._err(result.message);
      // The engine's resource factory merges the registry's example `hard` map;
      // a real `oc create quota --hard=…` stores exactly the requested keys (and
      // --scopes). Normalise the created resource back to the requested spec.
      const quota = result.resource || this._findResource('ResourceQuota', name, { namespace, explicitNamespace: true });
      if (quota) {
        quota.spec = { hard: { ...hard }, ...(scopes.length ? { scopes } : {}) };
        try {
          this.cluster?.update?.(quota.metadata?.uid || quota.uid, quota);
        } catch {
          /* best-effort */
        }
      }
      return this._ok(result.message || `resourcequota/${name} created`);
    }
    return this._finishCreateObject(object, flags);
  },

  _createLimitRange(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create limitrange <name> --default=cpu=500m,memory=512Mi --default-request=cpu=100m --max=cpu=2,memory=4Gi');
    const namespace = this._namespaceFromFlags(flags);
    const options = {
      namespace,
      type: flags.type && flags.type !== true ? String(flags.type) : 'Container',
      default: parseCommaAssignments(this._arrayFlag(flags, 'default')),
      defaultRequest: parseCommaAssignments(this._arrayFlag(flags, 'default-request')),
      min: parseCommaAssignments(this._arrayFlag(flags, 'min')),
      max: parseCommaAssignments(this._arrayFlag(flags, 'max')),
    };
    if (flags['max-limit-request-ratio']) {
      options.maxLimitRequestRatio = parseCommaAssignments(this._arrayFlag(flags, 'max-limit-request-ratio'));
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.createLimitRange === 'function') {
      const result = ge.createLimitRange(name, options);
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `limitrange/${name} created`);
    }
    return this._finishCreateObject(
      { apiVersion: 'v1', kind: 'LimitRange', metadata: { name, namespace }, spec: { limits: [{ type: options.type, default: options.default, defaultRequest: options.defaultRequest, min: options.min, max: options.max }] } },
      flags,
    );
  },

  _createClusterQuota(rest, flags) {
    const name = rest[0];
    if (!name) {
      return this._usageError('create', 'name is required\n\n  oc create clusterquota <name> --project-label-selector=key=value --hard=pods=10');
    }
    const hard = parseCommaAssignments(this._arrayFlag(flags, 'hard'));
    const selector = parseCommaAssignments(flags['project-label-selector'] && flags['project-label-selector'] !== true ? String(flags['project-label-selector']) : []);
    const annotations = parseCommaAssignments(flags['project-annotation-selector'] && flags['project-annotation-selector'] !== true ? String(flags['project-annotation-selector']) : []);
    const ge = this.gameEngine;
    if (ge && typeof ge.createClusterResourceQuota === 'function') {
      const selectorSpec = Object.keys(annotations).length
        ? { annotations: { matchAnnotations: annotations } }
        : { labels: { matchLabels: selector } };
      const result = ge.createClusterResourceQuota(name, { hard, selector: selectorSpec });
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `clusterresourcequota.quota.openshift.io/${name} created`);
    }
    const selectorSpec = Object.keys(annotations).length
      ? { annotations: { matchAnnotations: annotations } }
      : { labels: { matchLabels: selector } };
    return this._finishCreateObject(
      { apiVersion: 'quota.openshift.io/v1', kind: 'ClusterResourceQuota', metadata: { name }, spec: { selector: selectorSpec, quota: { hard } } },
      flags,
    );
  },

  _createUser(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create user <name> [--full-name=<full name>]');
    const fullName = flags['full-name'] && flags['full-name'] !== true ? String(flags['full-name']) : '';
    const ge = this.gameEngine;
    if (ge && typeof ge.createUserResource === 'function') {
      const result = ge.createUserResource(name, { fullName });
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `user.user.openshift.io/${name} created`);
    }
    return this._finishCreateObject(
      { apiVersion: 'user.openshift.io/v1', kind: 'User', metadata: { name }, spec: { fullName, groups: [], identities: [] } },
      flags,
    );
  },

  _createGroup(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create group <name> [users...]');
    const users = [...rest.slice(1), ...this._arrayFlag(flags, 'user')];
    const ge = this.gameEngine;
    if (ge && typeof ge.createGroupResource === 'function') {
      const result = ge.createGroupResource(name, users);
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `group.user.openshift.io/${name} created`);
    }
    return this._finishCreateObject(
      { apiVersion: 'user.openshift.io/v1', kind: 'Group', metadata: { name }, spec: { users } },
      flags,
    );
  },

  _createServiceAccount(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create serviceaccount <name>');
    const namespace = this._namespaceFromFlags(flags);
    return this._finishCreateObject(
      { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace }, spec: {} },
      flags,
    );
  },

  _createRoleBindingCommand(rest, flags, clusterWide) {
    const name = rest[0];
    if (!name) {
      return this._usageError(
        'create',
        'name is required\n\n  oc create rolebinding <name> --clusterrole=<role> --user=<user> [--group=<group>] [--serviceaccount=<ns>:<sa>]',
      );
    }
    const roleName = (flags.clusterrole && flags.clusterrole !== true ? String(flags.clusterrole) : null) ||
      (flags.role && flags.role !== true ? String(flags.role) : null);
    if (!roleName) return this._err('error: you must specify a role with --clusterrole or --role');
    const namespace = this._namespaceFromFlags(flags);
    const subjects = [];
    for (const user of this._arrayFlag(flags, 'user')) subjects.push({ kind: 'User', name: String(user), apiGroup: 'rbac.authorization.k8s.io' });
    for (const group of this._arrayFlag(flags, 'group')) subjects.push({ kind: 'Group', name: String(group), apiGroup: 'rbac.authorization.k8s.io' });
    for (const serviceAccount of this._arrayFlag(flags, 'serviceaccount')) {
      const text = String(serviceAccount);
      const parts = text.split(':');
      const saNamespace = parts.length > 1 ? parts[0] : namespace;
      const saName = parts.length > 1 ? parts[1] : text;
      subjects.push({ kind: 'ServiceAccount', name: saName, namespace: saNamespace });
    }
    if (!subjects.length) return this._err('error: you must specify at least one subject with --user, --group or --serviceaccount');
    const kind = clusterWide ? 'ClusterRoleBinding' : 'RoleBinding';
    const object = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind,
      metadata: { name, ...(clusterWide ? {} : { namespace }) },
      spec: {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: clusterWide || flags.clusterrole ? 'ClusterRole' : 'Role', name: roleName },
        subjects,
      },
    };
    return this._finishCreateObject(object, flags);
  },

  _createService(rest, flags) {
    const types = ['clusterip', 'nodeport', 'loadbalancer', 'externalname'];
    let serviceTypeToken = rest[0] ? String(rest[0]).toLowerCase() : 'clusterip';
    let name = rest[1];
    if (!types.includes(serviceTypeToken)) {
      name = rest[0];
      serviceTypeToken = 'clusterip';
    }
    if (!name) {
      return this._usageError('create', 'name is required\n\n  oc create service clusterip|nodeport|loadbalancer <name> --tcp=80:8080');
    }
    const namespace = this._namespaceFromFlags(flags);
    const type = { clusterip: 'ClusterIP', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', externalname: 'ExternalName' }[serviceTypeToken];
    const protocols = [];
    for (const entry of this._arrayFlag(flags, 'tcp')) protocols.push({ protocol: 'TCP', value: String(entry) });
    for (const entry of this._arrayFlag(flags, 'udp')) protocols.push({ protocol: 'UDP', value: String(entry) });
    if (!protocols.length && flags.port) {
      protocols.push({ protocol: 'TCP', value: `${flags.port}${flags['target-port'] ? `:${flags['target-port']}` : ''}` });
    }
    if (!protocols.length) protocols.push({ protocol: 'TCP', value: '80:8080' });
    const ports = protocols.map((entry) => {
      const [portText, targetText] = entry.value.split(':');
      const port = Number(portText);
      return {
        name: `${port}-${entry.protocol.toLowerCase()}`,
        port,
        targetPort: Number(targetText || port),
        protocol: entry.protocol,
      };
    });
    const spec = { type, selector: { app: name }, ports };
    if (type === 'ExternalName') {
      spec.externalName = flags['external-name'] && flags['external-name'] !== true ? String(flags['external-name']) : `${name}.example.com`;
      delete spec.selector;
    }
    return this._finishCreateObject({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec }, flags);
  },

  /** `oc create namespace <name>` — creates the namespace but does not switch. */
  _createNamespace(rest, flags) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create namespace <name>');
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
      return this._err(
        `error: namespace name "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      );
    }
    if (this._projectExists(name)) {
      return this._err(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
    }
    const created = this._applyObject({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name },
      spec: {},
    });
    if (created.error) return created.error;
    return this._ok(`namespace/${name} created`);
  },

  /** Parse `--flag` values (strings) into optional integers for Job fields. */
  _intFlag(flags, name) {
    const value = flags[name];
    if (value === undefined || value === true) return undefined;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  },

  /** Container command/args from `oc create … -- <command>` or `--command`. */
  _createContainerCommand(flags, afterDoubleDash = []) {
    const argv = Array.isArray(afterDoubleDash) ? afterDoubleDash.filter((entry) => entry !== undefined) : [];
    if (argv.length) return { command: argv };
    const flagCommand = flags.command !== undefined && flags.command !== true ? String(flags.command) : null;
    if (flagCommand) return { command: ['/bin/sh', '-c', flagCommand] };
    return {};
  },

  _createJob(rest, flags, afterDoubleDash = []) {
    const name = rest[0];
    if (!name) return this._usageError('create', 'name is required\n\n  oc create job <name> --image=<image> [--restart=Never|OnFailure] -- <command>   |   oc create job <name> --from=cronjob/<cronjob>');
    const namespace = this._namespaceFromFlags(flags);
    const from = flags.from && flags.from !== true ? String(flags.from) : null;
    const image = flags.image && flags.image !== true ? String(flags.image) : 'busybox:latest';
    const commandSpec = this._createContainerCommand(flags, afterDoubleDash);
    const restartPolicy = flags.restart && flags.restart !== true ? String(flags.restart) : from ? 'Never' : 'Never';
    if (!['Never', 'OnFailure'].includes(restartPolicy)) {
      return this._err(`error: invalid restart policy "${restartPolicy}": must be one of Never, OnFailure`);
    }
    let spec;
    if (from && from.startsWith('cronjob/')) {
      const cronJob = this._findResource('CronJob', from.split('/')[1], { namespace, explicitNamespace: Boolean(flags.namespace) });
      if (!cronJob) return this._err(this._notFoundMessage('CronJob', from.split('/')[1]));
      spec = JSON.parse(JSON.stringify(cronJob.spec?.jobTemplate?.spec || {}));
      spec.template = spec.template || { metadata: {}, spec: {} };
      spec.template.spec = spec.template.spec || {};
      spec.template.spec.restartPolicy = restartPolicy;
      spec.template.spec.containers = spec.template.spec.containers?.length ? spec.template.spec.containers : [{ name: 'main', image }];
      if (flags.image && flags.image !== true) spec.template.spec.containers[0].image = image;
      if (commandSpec.command) spec.template.spec.containers[0].command = commandSpec.command;
    } else {
      const container = { name: 'main', image };
      if (commandSpec.command) container.command = commandSpec.command;
      spec = { template: { metadata: {}, spec: { containers: [container], restartPolicy } } };
    }
    for (const field of ['completions', 'parallelism', 'backoff-limit', 'active-deadline-seconds']) {
      const value = this._intFlag(flags, field);
      if (value !== undefined) {
        const key = field === 'backoff-limit' ? 'backoffLimit' : field === 'active-deadline-seconds' ? 'activeDeadlineSeconds' : field;
        spec[key] = value;
      }
    }
    return this._finishCreateObject({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace }, spec }, flags);
  },

  _createCronJob(rest, flags, afterDoubleDash = []) {
    const name = rest[0];
    if (!name) {
      return this._usageError('create', 'name is required\n\n  oc create cronjob <name> --image=<image> --schedule="<cron schedule>" -- <command>');
    }
    const schedule = flags.schedule && flags.schedule !== true ? String(flags.schedule) : null;
    if (!schedule) {
      return this._err('error: required flag(s) "schedule" not set\n\n  oc create cronjob <name> --image=<image> --schedule="*/5 * * * *"');
    }
    const namespace = this._namespaceFromFlags(flags);
    const image = flags.image && flags.image !== true ? String(flags.image) : 'busybox:latest';
    const commandSpec = this._createContainerCommand(flags, afterDoubleDash);
    const restartPolicy = flags.restart && flags.restart !== true ? String(flags.restart) : 'OnFailure';
    if (!['Never', 'OnFailure', 'Always'].includes(restartPolicy)) {
      return this._err(`error: invalid restart policy "${restartPolicy}"`);
    }
    const container = { name: 'main', image };
    if (commandSpec.command) container.command = commandSpec.command;
    const jobSpec = { template: { metadata: {}, spec: { containers: [container], restartPolicy } } };
    const spec = {
      schedule,
      jobTemplate: { spec: jobSpec },
    };
    if (flags.timezone && flags.timezone !== true) spec.timeZone = String(flags.timezone);
    if (flags.suspend === true) spec.suspend = true;
    const completions = this._intFlag(flags, 'completions');
    if (completions !== undefined) jobSpec.completions = completions;
    const parallelism = this._intFlag(flags, 'parallelism');
    if (parallelism !== undefined) jobSpec.parallelism = parallelism;
    return this._finishCreateObject({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace }, spec }, flags);
  },

  /** Shared by `oc create route <type> <name>` and `oc expose`. */
  _createRouteCommand(rest, flags) {
    const terminations = ['edge', 'passthrough', 'reencrypt'];
    let termination = null;
    let name = rest[0];
    if (rest[0] && terminations.includes(String(rest[0]).toLowerCase())) {
      termination = String(rest[0]).toLowerCase();
      name = rest[1];
    }
    if (flags.termination && flags.termination !== true) termination = String(flags.termination);
    if (!name) {
      return this._err(
        'error: name is required\n\n' +
          '  oc create route edge <name> --service=<service> [--hostname=] [--cert=] [--key=]\n' +
          '  oc create route passthrough <name> --service=<service>\n' +
          '  oc create route reencrypt <name> --service=<service> --cert= --key= --dest-ca-cert=',
      );
    }
    const serviceName = flags.service && flags.service !== true ? String(flags.service) : null;
    if (!serviceName) return this._err('error: --service is required for oc create route');
    const namespace = this._namespaceFromFlags(flags);
    const warnings = [];
    const options = {
      name,
      namespace,
      service: serviceName,
      host: flags.hostname && flags.hostname !== true ? String(flags.hostname) : '',
      path: flags.path && flags.path !== true ? String(flags.path) : '/',
      termination,
      insecureEdgeTerminationPolicy: flags['insecure-policy'] && flags['insecure-policy'] !== true ? String(flags['insecure-policy']) : 'None',
      wildcardPolicy: flags['wildcard-policy'] && flags['wildcard-policy'] !== true ? String(flags['wildcard-policy']) : 'None',
      port: flags.port && flags.port !== true ? String(flags.port) : undefined,
    };
    if (termination && termination !== 'passthrough') {
      if (flags.cert) options.certificate = this._certMaterial(flags.cert, 'CERTIFICATE', warnings);
      if (flags.key) options.key = this._certMaterial(flags.key, 'PRIVATE KEY', warnings);
      if (flags['ca-cert']) options.caCertificate = this._certMaterial(flags['ca-cert'], 'CERTIFICATE', warnings);
      if (flags['dest-ca-cert']) options.destinationCACertificate = this._certMaterial(flags['dest-ca-cert'], 'CERTIFICATE', warnings);
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.createRoute === 'function') {
      const result = ge.createRoute(options);
      if (result.success === false) return this._err(result.message);
      return this._ok([...warnings, result.message || `route.route.openshift.io/${name} created`].join('\n'));
    }
    const routeSpec = {
      host: options.host,
      path: options.path,
      to: { kind: 'Service', name: serviceName, weight: 100 },
      port: { targetPort: options.port || 'http' },
      wildcardPolicy: options.wildcardPolicy,
    };
    if (termination) {
      routeSpec.tls = { termination, insecureEdgeTerminationPolicy: options.insecureEdgeTerminationPolicy };
      if (termination !== 'passthrough') {
        if (options.certificate) routeSpec.tls.certificate = options.certificate;
        if (options.key) routeSpec.tls.key = options.key;
        if (options.caCertificate) routeSpec.tls.caCertificate = options.caCertificate;
        if (options.destinationCACertificate) routeSpec.tls.destinationCACertificate = options.destinationCACertificate;
      }
    }
    return this._finishCreateObject(
      { apiVersion: 'route.openshift.io/v1', kind: 'Route', metadata: { name, namespace }, spec: routeSpec },
      flags,
      { warnings },
    );
  },

  _cmdApply(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-k': 'kustomize', '-n': 'namespace', '-o': 'output' },
      longValues: ['filename', 'kustomize', 'namespace', 'output', 'dry-run', 'field-manager', 'server-side'],
      longBools: ['overwrite', 'validate', 'server-side', 'force', 'prune'],
    });
    // Allow `oc apply -f file` and the rare `oc apply file.yaml` form.
    const filename = flags.filename || (positionals[0] && !positionals[0].startsWith('-') && !flags.kustomize ? positionals[0] : null);
    const kustomize = flags.kustomize && flags.kustomize !== true ? String(flags.kustomize) : null;
    if (!filename && !kustomize) {
      return this._err('error: must specify one of -f and -k\n\n  oc apply -f <file>\n  oc apply -k <directory>');
    }
    if (flags['dry-run']) {
      return this._err('error: --dry-run is not supported for manifests in the simulator; open the file in the Files panel to inspect it, then apply without --dry-run.');
    }
    if (kustomize) return this._applyKustomizeDelegated(kustomize, flags);
    return this._applyFileDelegated(String(filename), { stdinText: ctx?.stdin ?? null, command: 'apply', flags });
  },

  _cmdReplace(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-n': 'namespace', '-o': 'output' },
      longValues: ['filename', 'namespace', 'output'],
      longBools: ['force', 'validate'],
    });
    const filename = flags.filename || positionals[0];
    if (!filename) return this._err('error: must specify -f <filename>\n\n  oc replace -f <file>');
    return this._applyFileDelegated(String(filename), { stdinText: ctx?.stdin ?? null, command: 'replace', flags });
  },

  _cmdDelete(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-f': 'filename', '-k': 'kustomize', '-l': 'selector' },
      longValues: ['filename', 'kustomize', 'namespace', 'selector', 'grace-period', 'cascade', 'field-selector'],
      longBools: ['all', 'force', 'ignore-not-found', 'now', 'wait'],
    });
    if (flags.filename) return this._deleteFileDelegated(String(flags.filename), { stdinText: ctx?.stdin ?? null, flags });
    if (flags.kustomize) {
      return this._err('error: oc delete -k is not supported in the simulator; delete the created resources by name or delete -f the manifests.');
    }
    if (!positionals.length) {
      return this._err('error: You must provide one or more resources by argument or filename.\n\n  oc delete <resource> <name> [<name>...]\n  oc delete -f <file>');
    }
    const namespace = flags.namespace || this.currentProject;
    const explicitNamespace = Boolean(flags.namespace);
    const dryRun = Boolean(flags['dry-run']);
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0]);
    const lowerKind = kind.toLowerCase();
    const ignoreNotFound = Boolean(flags['ignore-not-found']);
    const rawResourceToken = String(positionals[0] || '').toLowerCase();

    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }

    // `oc delete csv <name>` maps to the owning subscription (must run before
    // the generic Subscription branch because the registry aliases csv→Subscription).
    if (['csv', 'csvs', 'clusterserviceversion', 'clusterserviceversions'].includes(rawResourceToken)) {
      const csvName = name || positionals[1];
      const subscriptions = this._resources('Subscription');
      const subscription = subscriptions.find(
        (candidate) => candidate.status?.installedCSV === csvName || candidate.spec?.packageName === csvName || candidate.metadata?.name === csvName,
      );
      if (!subscription) return ignoreNotFound ? this._ok('') : this._err(`Error from server (NotFound): clusterserviceversions.operators.coreos.com "${csvName}" not found`);
      this._deleteResource('Subscription', subscription.metadata?.name, { namespace: subscription.metadata?.namespace });
      this._emit('operator:uninstalled', { name: subscription.metadata?.name, namespace: subscription.metadata?.namespace });
      return this._ok(`clusterserviceversions.operators.coreos.com "${csvName}" deleted`);
    }

    // Special-case destructive identity/operator commands.
    if (kind === 'Project') {
      const projectName = name || positionals[0];
      if (!projectName) return this._usageError('delete', 'project name is required\n\n  oc delete project <name>');
      const ge = this.gameEngine;
      if (ge && typeof ge.deleteProject === 'function') {
        const result = ge.deleteProject(projectName);
        if (result.success === false) return ignoreNotFound ? this._ok('') : this._err(result.message);
        return this._ok(result.message || `project.project.openshift.io "${projectName}" deleted`);
      }
      const result = this._deleteResource('Project', projectName);
      if (result.error) return ignoreNotFound ? this._ok('') : result.error;
      return this._ok(`project.project.openshift.io "${projectName}" deleted`);
    }
    if (kind === 'User') {
      const ge = this.gameEngine;
      const userName = name || positionals[1];
      if (ge && typeof ge.deleteUserResource === 'function') {
        const result = ge.deleteUserResource(userName);
        if (result.success === false) return ignoreNotFound ? this._ok('') : this._err(result.message);
        return this._ok(result.message);
      }
    }
    if (kind === 'Subscription' && name) {
      const subscriptions = this._resources('Subscription');
      const target = subscriptions.find((subscription) => subscription.metadata?.name === name);
      if (target) {
        this._deleteResource('Subscription', name, { namespace: target.metadata?.namespace });
        this._emit('operator:uninstalled', { name, namespace: target.metadata?.namespace });
        return this._ok(`subscription.operators.coreos.com "${name}" deleted`);
      }
      if (ignoreNotFound) return this._ok('');
      return this._err(`Error from server (NotFound): subscriptions.operators.coreos.com "${name}" not found`);
    }
    if (kind === 'Identity') {
      const identityName = name || positionals[1];
      const identity = this._findResource('Identity', identityName, { allowPrefix: false });
      if (!identity) return ignoreNotFound ? this._ok('') : this._err(`Error from server (NotFound): identities.user.openshift.io "${identityName}" not found`);
      this._deleteResource('Identity', identityName);
      return this._ok(`identity.user.openshift.io "${identityName}" deleted`);
    }

    const deleteList = [];
    if (flags.all) {
      let resources = this._resources(kind);
      if (this._isNamespaced(kind) && !explicitNamespace) resources = resources.filter((resource) => resource.metadata?.namespace === this.currentProject);
      else if (explicitNamespace && this._isNamespaced(kind)) resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources = this._filterResources(resources, kind, flags);
      deleteList.push(...resources);
    } else if (name) {
      const target = this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace, allowPrefix: false });
      if (!target) return ignoreNotFound ? this._ok('') : this._err(this._notFoundMessage(kind, name));
      deleteList.push(target);
      // Support additional names: `oc delete pod a b c`.
      for (const extraName of positionals.slice(2)) {
        const extra = this._findResource(kind, extraName, { namespace: flags.namespace, explicitNamespace, allowPrefix: false });
        if (extra) deleteList.push(extra);
      }
    } else {
      return this._err('error: resource name is required (or use --all / -l <selector>)');
    }
    if (!deleteList.length) return this._ok(ignoreNotFound ? '' : `No resources found in ${namespace} namespace.`);
    const lines = [];
    for (const resource of deleteList) {
      if (dryRun) {
        lines.push(`${this._resourceRef(resource.kind)} "${resource.metadata?.name}" deleted (dry run)`);
        continue;
      }
      const uid = resource.metadata?.uid || resource.uid;
      try {
        this.cluster?.remove?.(uid);
        lines.push(`${this._resourceRef(resource.kind)} "${resource.metadata?.name}" deleted`);
      } catch (error) {
        if (!ignoreNotFound) return this._err(`error: unable to delete ${this._resourceRef(resource.kind)}/${resource.metadata?.name}: ${error?.message || error}`);
      }
    }
    return this._ok(lines.join('\n'));
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Mutations: scale / edit / label / annotate / patch / set / rollout / run / exec
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdScale(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['replicas', 'current-replicas', 'namespace', 'resource-version'],
      longBools: [],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('scale', 'resource name is required\n\n  oc scale <resource>/<name> --replicas=<count>');
    const replicasRaw = flags.replicas;
    if (replicasRaw === undefined || replicasRaw === true) {
      return this._usageError('scale', '--replicas is required\n\n  oc scale <resource>/<name> --replicas=<count>');
    }
    const replicas = Number(replicasRaw);
    if (!Number.isFinite(replicas) || replicas < 0) return this._err(`error: invalid replicas value "${replicasRaw}"`);
    const scalable = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DeploymentConfig'];
    if (!scalable.includes(kind)) return this._err(`error: cannot scale a "${kind}" resource`);
    const namespace = this._namespaceFromFlags(flags);
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    if (!this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace), allowPrefix: false })) {
      return this._err(this._notFoundMessage(kind, name));
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.scale === 'function') {
      const result = ge.scale(kind, name, replicas, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} scaled`);
    }
    const result = this._updateResource(kind, name, (spec) => {
      spec.replicas = replicas;
    }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} scaled`);
  },

  _cmdEdit(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: [],
    });
    const projectConfigRef = this._projectConfigRef(positionals);
    if (projectConfigRef) return this._editProjectConfig(projectConfigRef);
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('edit', 'resource name is required\n\n  oc edit <resource>/<name>');
    const resource = this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    this._emit('ui:manifest-editor', {
      kind,
      name,
      namespace: resource.metadata?.namespace || '',
      uid: resource.metadata?.uid,
      resource,
    });
    const panel = this.game?.manifestPanel;
    if (panel && typeof panel.show === 'function') {
      try {
        panel.show(resource);
      } catch {
        /* ignore panel wiring errors */
      }
      return this._ok(`Opening the manifest editor for ${this._resourceRef(kind)}/${name} in the Files panel. Save to apply changes.\n${EDIT_TEACHING_LINE}`);
    }
    // Legacy shell fallback (index.html edit dialog) until ManifestPanel is wired.
    this._emit('ui:edit-resource', { uid: resource.metadata?.uid, kind, name, namespace: resource.metadata?.namespace });
    return this._ok(`Opening the manifest editor for ${this._resourceRef(kind)}/${name}. Save to apply changes.\n${EDIT_TEACHING_LINE}`);
  },

  _cmdLabelAnnotate(tokens, ctx, field) {
    const isLabel = field === 'labels';
    const verb = isLabel ? 'label' : 'annotate';
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-l': 'selector' },
      longValues: ['namespace', 'selector'],
      longBools: ['overwrite', 'all', 'local'],
    });
    const { kind, name, rest } = this._splitLabelArgs(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    const updates = {};
    const errors = [];
    for (const pair of rest) {
      if (pair.endsWith('-') && !pair.includes('=')) {
        const key = pair.slice(0, -1);
        if (!key) continue;
        updates[key] = null;
        continue;
      }
      const eq = pair.indexOf('=');
      if (eq > 0) updates[pair.slice(0, eq)] = pair.slice(eq + 1);
      else errors.push(pair);
    }
    if (errors.length) return this._err(`error: invalid ${verb} spec: '${errors[0]}'`);
    if (!Object.keys(updates).length) return this._err(`error: at least one ${verb} update is required`);
    const namespace = this._namespaceFromFlags(flags);
    const applyToResource = (resource) => {
      const metadata = resource.metadata || (resource.metadata = { [field]: {} });
      metadata[field] = metadata[field] || {};
      let changed = false;
      for (const [key, value] of Object.entries(updates)) {
        const current = metadata[field][key];
        if (value !== null && current !== undefined && current !== value && !flags.overwrite) {
          return this._err(`error: '${key}' already has a value (${current}), and --overwrite is false`);
        }
        if (value === null ? current !== undefined : current !== value) changed = true;
      }
      const expected = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          delete metadata[field][key];
          expected[key] = null;
        } else {
          metadata[field][key] = value;
          expected[key] = value;
        }
      }
      const ge = this.gameEngine;
      const method = isLabel ? 'labelResource' : 'annotateResource';
      if (ge && typeof ge[method] === 'function') {
        const result = ge[method](kind, resource.metadata.name, expected, { namespace: resource.metadata.namespace });
        if (result.success === false) return this._err(result.message);
      } else {
        this.cluster?.update?.(resource.metadata.uid || resource.uid, { metadata: { [field]: metadata[field] } });
      }
      return { ok: true, changed };
    };

    if (flags.all) {
      let resources = this._resources(kind);
      if (this._isNamespaced(kind)) resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources = this._filterResources(resources, kind, flags);
      if (!resources.length) return this._ok(`No resources found in ${namespace} namespace.`);
      const lines = [];
      for (const resource of resources) {
        const result = applyToResource(resource);
        if (result.error) return result;
        lines.push(`${this._resourceRef(kind)}/${resource.metadata?.name} ${result.changed ? (isLabel ? 'labeled' : 'annotated') : `not ${isLabel ? 'labeled' : 'annotated'}`}`);
      }
      return this._ok(lines.join('\n'));
    }

    if (!name) {
      return this._usageError(verb, `resource name is required\n\n  oc ${verb} <resource>/<name> <key>=<value>`);
    }
    const resource = this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const result = applyToResource(resource);
    if (result.error) return result;
    return this._ok(`${this._resourceRef(kind)}/${name} ${result.changed ? (isLabel ? 'labeled' : 'annotated') : `not ${isLabel ? 'labeled' : 'annotated'}`}`);
  },

  /** Split `oc label deployment/web key=value` and `oc label deployment web key=value`. */
  _splitLabelArgs(positionals) {
    if (!positionals.length) return { kind: null, name: null, rest: [] };
    const first = positionals[0];
    if (isResourceRef(first)) {
      const { kind, name } = splitResourceRef(positionals);
      return { kind, name, rest: positionals.slice(1) };
    }
    const kind = normalizeKind(first);
    if (kind) return { kind, name: positionals[1] || null, rest: positionals.slice(2) };
    const { kind: refKind, name } = splitResourceRef(positionals);
    return { kind: refKind, name, rest: positionals.slice(1) };
  },

  _cmdPatch(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-p': 'patch' },
      longValues: ['namespace', 'patch', 'type', 'dry-run'],
      longBools: ['dry-run'],
    });
    const projectConfigRef = this._projectConfigRef(positionals);
    if (projectConfigRef) return this._patchProjectConfig(projectConfigRef, flags);
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('patch', 'resource name is required\n\n  oc patch <resource>/<name> -p \'{"spec":{...}}\'');
    const patchText = flags.patch;
    if (!patchText || patchText === true) return this._err('error: must specify -p <patch>');
    let patch;
    try {
      patch = JSON.parse(String(patchText));
    } catch (error) {
      return this._err(`error: unable to parse patch: ${error.message}`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.patchResource === 'function') {
      const result = ge.patchResource(kind, name, patch, { namespace, type: flags.type });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} patched`);
    }
    const result = this._updateResource(kind, name, (spec, resource) => {
      if (patch.metadata) return { metadata: patch.metadata };
      if (patch.spec) Object.assign(spec, patch.spec);
      return {};
    }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} patched`);
  },

  // ── oc set ────────────────────────────────────────────────────────────────

  _cmdSet(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    switch (sub) {
      case 'env':
        return this._setEnv(rest);
      case 'image':
        return this._setImage(rest);
      case 'resources':
        return this._setResources(rest);
      case 'probe':
        return this._setProbe(rest);
      case 'serviceaccount':
      case 'sa':
        return this._setServiceAccount(rest);
      case 'triggers':
        return this._setTriggers(rest);
      case 'selector':
        return this._setSelector(rest);
      case 'volumes':
      case 'volume':
        return this._setVolumes(rest);
      case 'data':
        return this._setData(rest);
      default:
        return this._err(
          `error: unknown set subcommand "${sub}"\n\nValid subcommands:\n  env, image, resources, probe, serviceaccount, triggers, selector, volumes, data\n\nRun 'oc set --help' for details.`,
        );
    }
  },

  _setEnv(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container', 'containers', 'from', 'prefix', 'remove', 'env'],
      multi: ['from', 'remove', 'env'],
      longBools: ['list', 'overwrite', 'all'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set env <resource>/<name> KEY=VALUE');
    const namespace = this._namespaceFromFlags(flags);
    const env = {};
    const remove = [];
    const startIndex = positionals[0].includes('/') ? 1 : 2;
    for (const pair of positionals.slice(startIndex)) {
      if (pair.endsWith('-') && !pair.includes('=')) {
        remove.push(pair.slice(0, -1));
        continue;
      }
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      else remove.push(pair);
    }
    for (const entry of this._arrayFlag(flags, 'env')) {
      const eq = String(entry).indexOf('=');
      if (eq > 0) env[String(entry).slice(0, eq)] = String(entry).slice(eq + 1);
    }
    for (const entry of this._arrayFlag(flags, 'remove')) remove.push(String(entry));
    const fromList = this._arrayFlag(flags, 'from').map((entry) => String(entry));
    const ge = this.gameEngine;
    if (flags.list) {
      if (ge && typeof ge.setEnv === 'function') {
        const result = ge.setEnv(kind, name, { namespace, list: true, container: flags.container });
        if (result.success === false) return this._err(result.message);
        const containerName = flags.container || 'main';
        const lines = [`# ${this._resourceRef(kind)}/${name}, container ${containerName}`];
        for (const entry of result.env || []) {
          lines.push(entry.valueFrom ? `${entry.name}=<from ${Object.keys(entry.valueFrom)[0]}>` : `${entry.name}=${entry.value}`);
        }
        if ((result.env || []).length === 0) lines.push('<none>');
        return this._ok(lines.join('\n'));
      }
      return this._err('error: environment variable listing is not available in this build');
    }
    if (!Object.keys(env).length && !remove.length && !fromList.length) {
      return this._err('error: at least one environment variable must be provided\n\n  oc set env <resource>/<name> KEY=VALUE [--from=configmap/name] [--remove=KEY] [--list]');
    }
    if (ge && typeof ge.setEnv === 'function') {
      const result = ge.setEnv(kind, name, {
        namespace,
        env,
        remove,
        from: fromList[0] || null,
        container: flags.container,
        prefix: flags.prefix,
        overwrite: true,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} updated`);
    }
    const result = this._updateResource(kind, name, (spec) => {
      const containers = spec.template?.spec?.containers || spec.containers || [];
      const targets = flags.container ? containers.filter((container) => container.name === flags.container) : containers;
      if (!targets.length) return { error: this._err(`error: container "${flags.container || 'main'}" not found`) };
      for (const container of targets) {
        container.env = container.env || [];
        for (const [key, value] of Object.entries(env)) {
          const existing = container.env.find((entry) => entry.name === key);
          if (existing) existing.value = value;
          else container.env.push({ name: key, value });
        }
        for (const key of remove) container.env = container.env.filter((entry) => entry.name !== key);
      }
      return {};
    }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} updated`);
  },

  _setImage(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: ['all', 'source', 'local'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set image <resource>/<name> <container>=<image>');
    const assignment = positionals[positionals[0].includes('/') ? 1 : 2];
    if (!assignment) return this._err('error: you must specify an image assignment (<container>=<image>)');
    const eq = assignment.indexOf('=');
    const container = eq >= 0 ? assignment.slice(0, eq) : undefined;
    const image = eq >= 0 ? assignment.slice(eq + 1) : assignment;
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setImage === 'function') {
      const result = ge.setImage(kind, name, { container, image }, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} image updated`);
    }
    const result = this._updateResource(kind, name, (spec) => {
      const containers = spec.template?.spec?.containers || spec.containers || [];
      const targets = container ? containers.filter((entry) => entry.name === container) : containers;
      if (!targets.length) return { error: this._err(`error: container "${container}" not found`) };
      for (const target of targets) target.image = image;
      return {};
    }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} image updated`);
  },

  _setResources(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container', 'limits', 'requests'],
      longBools: [],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set resources <resource>/<name> --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi');
    const limits = parseCommaAssignments(flags.limits);
    const requests = parseCommaAssignments(flags.requests);
    if (!Object.keys(limits).length && !Object.keys(requests).length) {
      return this._err('error: at least one of --limits or --requests must be specified');
    }
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setResources === 'function') {
      const result = ge.setResources(kind, name, { namespace, limits, requests, container: flags.container });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} resource requirements updated`);
    }
    return this._err('error: resource limits are not available in this build');
  },

  _setProbe(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container', 'get-url', 'open-tcp', 'http-get', 'initial-delay-seconds', 'period-seconds'],
      longBools: ['liveness', 'readiness', 'startup', 'remove'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set probe <resource>/<name> --liveness --get-url=http://:8080/healthz');
    const probeType = flags.readiness ? 'readiness' : flags.startup ? 'startup' : 'liveness';
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    const openTcp = flags['open-tcp'] && flags['open-tcp'] !== true ? Number(flags['open-tcp']) : null;
    if (ge && typeof ge.setProbe === 'function' && !openTcp) {
      const result = ge.setProbe(kind, name, {
        namespace,
        probe: probeType,
        getUrl: flags['get-url'] && flags['get-url'] !== true ? String(flags['get-url']) : undefined,
        remove: Boolean(flags.remove),
        container: flags.container,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} ${probeType} probe ${flags.remove ? 'removed' : 'updated'}`);
    }
    const result = this._updateResource(kind, name, (spec) => {
      const containers = spec.template?.spec?.containers || spec.containers || [];
      for (const container of containers) {
        if (flags.remove) {
          delete container[`${probeType}Probe`];
        } else if (openTcp) {
          container[`${probeType}Probe`] = { tcpSocket: { port: openTcp }, initialDelaySeconds: 5, periodSeconds: 10 };
        } else {
          const url = flags['get-url'] && flags['get-url'] !== true ? String(flags['get-url']) : 'http://:8080/healthz';
          const match = url.match(/^(https?):\/\/([^/]*?)(?::(\d+))?(\/.*)?$/);
          container[`${probeType}Probe`] = {
            httpGet: { path: match?.[4] || '/', port: match?.[3] ? Number(match[3]) : 8080, scheme: (match?.[1] || 'http').toUpperCase() },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          };
        }
      }
      return {};
    }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} ${probeType} probe ${flags.remove ? 'removed' : 'updated'}`);
  },

  _setServiceAccount(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: [],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set serviceaccount <resource>/<name> <serviceaccount>');
    const serviceAccount = positionals[positionals[0].includes('/') ? 1 : 2];
    if (!serviceAccount) return this._err('error: you must specify a service account name');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setServiceAccount === 'function') {
      const result = ge.setServiceAccount(kind, name, serviceAccount, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} service account updated`);
    }
    return this._err('error: service account updates are not available in this build');
  },

  _setTriggers(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'from-image', 'containers', 'from-config', 'from-github', 'from-webhook'],
      longBools: ['remove', 'auto', 'manual'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set triggers bc/<name> --from-image=<is>:<tag> [--containers=main]');
    if (!['BuildConfig', 'Deployment'].includes(kind)) {
      return this._err(`error: triggers are only supported for BuildConfig and Deployment resources (got ${kind})`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const fromImage = flags['from-image'] && flags['from-image'] !== true ? String(flags['from-image']) : null;
    const containers = flags.containers && flags.containers !== true ? String(flags.containers).split(',').filter(Boolean) : [];
    // Deployments have no native `spec.triggers`: OpenShift manages image-change
    // triggers through the `image.openshift.io/triggers` annotation (the engine's
    // legacy setTriggers writes spec.triggers, which a real API server drops).
    if (kind === 'Deployment') {
      const resource = this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
      if (!resource) return this._err(this._notFoundMessage(kind, name));
      const annotationKey = 'image.openshift.io/triggers';
      const existing = (() => {
        try {
          return JSON.parse(resource.metadata?.annotations?.[annotationKey] || '[]');
        } catch {
          return [];
        }
      })();
      let triggers = Array.isArray(existing) ? existing : [];
      if (flags.remove) {
        triggers = fromImage
          ? triggers.filter((trigger) => trigger?.from?.name !== fromImage)
          : [];
      } else {
        if (!fromImage) {
          return this._err('error: --from-image=<image-stream:tag> is required\n\n  oc set triggers deployment/<name> --from-image=<is>:<tag>');
        }
        const targetContainers = containers.length ? containers : this._containerList(resource).map((container) => container.name);
        for (const containerName of targetContainers.length ? targetContainers : ['main']) {
          const index = Math.max(0, this._containerList(resource).findIndex((container) => container.name === containerName));
          triggers = triggers.filter((trigger) => trigger?.fieldPath !== `spec.template.spec.containers[${index}].image`);
          triggers.push({ from: { kind: 'ImageStreamTag', name: fromImage }, fieldPath: `spec.template.spec.containers[${index}].image` });
        }
      }
      if (triggers.length) {
        resource.metadata.annotations = resource.metadata.annotations || {};
        resource.metadata.annotations[annotationKey] = JSON.stringify(triggers);
      } else if (resource.metadata?.annotations) {
        delete resource.metadata.annotations[annotationKey];
      }
      try {
        this.cluster?.update?.(resource.metadata?.uid || resource.uid, { metadata: {} });
      } catch {
        /* best-effort */
      }
      return this._ok(`${this._resourceRef(kind)}/${name} triggers updated`);
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.setTriggers === 'function') {
      const result = ge.setTriggers(kind, name, {
        namespace,
        fromImage,
        containers: containers.length ? containers : undefined,
        remove: Boolean(flags.remove),
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} triggers updated`);
    }
    return this._err('error: triggers are not available in this build');
  },

  _setSelector(rest) {
    const { positionals, flags } = parseArgs(rest, { shortValues: { '-n': 'namespace' }, longValues: ['namespace'] });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set selector svc/<name> app=web');
    const start = positionals[0].includes('/') ? 1 : 2;
    const pairs = parseCommaAssignments(positionals.slice(start));
    if (!Object.keys(pairs).length) return this._err('error: at least one selector label is required');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setSelector === 'function') {
      const result = ge.setSelector(kind, name, pairs, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} selector updated`);
    }
    return this._err('error: selectors are not available in this build');
  },

  _setVolumes(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'name', 'claim-name', 'mount-path', 'sub-path', 'type', 'config-map', 'secret', 'default-mode'],
      longBools: ['add', 'remove', 'overwrite'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('set', 'resource name is required\n\n  oc set volumes <resource>/<name> --add --name=data --claim-name=data --mount-path=/data');
    if (!flags.add && !flags.remove) return this._err('error: you must specify --add or --remove');
    const namespace = this._namespaceFromFlags(flags);
    const volumeName = flags.name && flags.name !== true ? String(flags.name) : 'data';
    if (flags.remove) {
      const result = this._updateResource(kind, name, (spec) => {
        const podSpec = spec.template?.spec || spec;
        podSpec.volumes = (podSpec.volumes || []).filter((volume) => volume.name !== volumeName);
        for (const container of podSpec.containers || []) {
          container.volumeMounts = (container.volumeMounts || []).filter((mount) => mount.name !== volumeName);
        }
        return {};
      }, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
      if (result.error) return result.error;
      return this._ok(`${this._resourceRef(kind)}/${name} volume ${volumeName} removed`);
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.setVolumes === 'function') {
      const result = ge.setVolumes(kind, name, {
        namespace,
        name: volumeName,
        claimName: flags['claim-name'] && flags['claim-name'] !== true ? String(flags['claim-name']) : undefined,
        mountPath: flags['mount-path'] && flags['mount-path'] !== true ? String(flags['mount-path']) : '/data',
        configMap: flags['config-map'] && flags['config-map'] !== true ? String(flags['config-map']) : undefined,
        secret: flags.secret && flags.secret !== true ? String(flags.secret) : undefined,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} volumes updated`);
    }
    return this._err('error: volume updates are not available in this build');
  },

  // ── rollout / run / exec ─────────────────────────────────────────────────

  _cmdRollout(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'revision', 'to-revision'],
      longBools: ['watch', 'dry-run', 'paused'],
    });
    const sub = (positionals[0] || '').toLowerCase();
    const valid = ['status', 'history', 'undo', 'restart', 'pause', 'resume'];
    if (!valid.includes(sub)) {
      return this._err(`error: unknown rollout subcommand "${sub || ''}"\n\nValid subcommands: status, history, undo, restart, pause, resume\n\n  oc rollout status <resource>/<name>`);
    }
    const { kind, name } = this._resolveRef(positionals.slice(1));
    if (!kind) return this._resourceTypeError(positionals[1] || '');
    if (!name) return this._usageError('rollout', 'resource name is required\n\n  oc rollout status deployment/<name>');
    const namespace = this._namespaceFromFlags(flags);
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    if (!this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace), allowPrefix: false })) {
      return this._err(this._notFoundMessage(kind, name));
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.rollout === 'function') {
      if (sub === 'history') {
        const history = typeof ge.getRolloutHistory === 'function' ? ge.getRolloutHistory(kind, name, { namespace }) : [];
        if (!history.length) return this._err(this._notFoundMessage(kind, name));
        const rows = history.map((entry) => [String(entry.revision), entry.changeCause || '<none>']);
        return this._ok(padTable(['REVISION', 'CHANGE-CAUSE'], rows));
      }
      if (sub === 'pause' || sub === 'resume') {
        return this._ok(`${this._resourceRef(kind)}/${name} ${sub === 'pause' ? 'paused' : 'resumed'}`);
      }
      const revision = flags.revision || flags['to-revision'];
      const result = ge.rollout(kind, sub, name, { namespace, revision: revision ? Number(revision) : undefined });
      if (result.success === false) return this._err(result.message);
      if (result.status) {
        return this._ok(`${this._resourceRef(kind)}/${name} ${result.message.includes('successfully') ? 'successfully rolled out' : result.message}`);
      }
      return this._ok(result.message || `${this._resourceRef(kind)}/${name} ${sub === 'restart' ? 'restarted' : 'rolled back'}`);
    }
    return this._err(`error: rollout ${sub} is not available in this build`);
  },

  _cmdRun(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'image', 'image-stream', 'port', 'restart', 'serviceaccount', 'labels', 'env', 'overrides'],
      multi: ['env'],
      longBools: ['rm', 'it', 'stdin', 'tty', 'attach'],
    });
    const name = positionals[0];
    if (!name) return this._usageError('run', 'name is required\n\n  oc run <name> --image=<image> [--port=8080]');
    const image = flags.image && flags.image !== true ? String(flags.image) : flags['image-stream'] && flags['image-stream'] !== true ? `${INTERNAL_REGISTRY}/${this.currentProject}/${flags['image-stream']}` : null;
    if (!image) return this._err('error: --image or --image-stream is required\n\n  oc run <name> --image=nginx:latest');
    const namespace = this._namespaceFromFlags(flags);
    const port = flags.port && flags.port !== true ? Number(flags.port) : null;
    const env = parseCommaAssignments(this._arrayFlag(flags, 'env'));
    const labels = { run: name, ...parseCommaAssignments(flags.labels && flags.labels !== true ? String(flags.labels) : []) };
    const container = { name: 'main', image, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } } };
    if (port) container.ports = [{ containerPort: port, protocol: 'TCP' }];
    if (Object.keys(env).length) container.env = Object.entries(env).map(([key, value]) => ({ name: key, value }));
    const restartPolicy = flags.restart && flags.restart !== true ? String(flags.restart) : 'Always';
    const object = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace, labels },
      spec: {
        containers: [container],
        restartPolicy,
      },
    };
    const result = this._applyObject(object);
    if (result.error) return result.error;
    if (name.toLowerCase() === 'konami') {
      this._emit('easter-egg:triggered', { id: 'konami-code' });
      this._emit('xp:gain', { amount: 100 });
    }
    return this._ok(`pod/${name} created`);
  },

  _cmdExec(tokens) {
    const { positionals, flags, afterDoubleDash, tokens: rawTokens } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container'],
      longBools: ['stdin', 'tty', 'attach', 'quiet'],
    });
    const { kind, name } = this._resolveRef(positionals);
    const podName = kind === 'Pod' ? name : kind ? null : positionals[0];
    if (!podName) {
      if (kind && kind !== 'Pod') return this._err(`Error from server (BadRequest): cannot exec into a ${kind.toLowerCase()}; specify a pod`);
      return this._usageError('exec', 'pod name is required\n\n  oc exec -it <pod> -- <command>');
    }
    const namespace = this._namespaceFromFlags(flags);
    const pod = this._findResource('Pod', podName, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace), allowPrefix: false });
    if (!pod) return this._err(this._notFoundMessage('Pod', podName));
    const containers = this._containerList(pod);
    const containerName = flags.container && flags.container !== true ? String(flags.container) : containers[0]?.name || 'main';
    if (containers.length && !containers.some((container) => container.name === containerName)) {
      return this._err(`Error from server (BadRequest): container "${containerName}" is not valid for pod "${pod.metadata?.name}"`);
    }
    const interactive = rawTokens.some((token) => /^-[a-z]*[it][a-z]*$/.test(token));
    let command = afterDoubleDash.join(' ').trim();
    if (!command) {
      const plainCommand = positionals.slice(kind ? 2 : 1).join(' ').trim();
      command = plainCommand || (interactive ? '/bin/sh' : '');
    }
    const lines = [`Defaulting container name to "${containerName}".`, `Use 'oc describe pod/${pod.metadata?.name} -n ${pod.metadata?.namespace}' to see all of the containers in this pod.`];
    if (!command) return this._ok(lines.join('\n'));
    const output = this._simulateExecCommand(command, pod, containerName);
    return this._ok([...lines, ...output].join('\n'));
  },

  _simulateExecCommand(command, pod, containerName) {
    const text = String(command).trim();
    if (/^(hostname|hostname -f)$/.test(text)) return [pod.metadata?.name || 'pod'];
    if (/^whoami$/.test(text)) return ['default'];
    if (/^id$/.test(text)) return ['uid=1000840000(default) gid=0(root) groups=0(root),1000840000'];
    if (/^(env|printenv)$/.test(text)) {
      return [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'KUBERNETES_SERVICE_HOST=172.30.0.1',
        'KUBERNETES_SERVICE_PORT=443',
        'HOSTNAME=' + (pod.metadata?.name || 'pod'),
      ];
    }
    if (/^(ls|ls -l|ls -la)$/.test(text)) return ['bin  boot  dev  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var'];
    if (/^(cat \/etc\/hostname|cat \/etc\/hosts)$/.test(text)) return [pod.metadata?.name || 'pod', '172.30.0.1 kubernetes.default.svc'];
    if (/^curl\b/.test(text)) {
      const selector = pod.metadata?.labels?.app || '';
      return [`<html><body>Hello from ${selector || pod.metadata?.name} (container ${containerName})</body></html>`];
    }
    if (/^nslookup\b|^dig\b/.test(text)) {
      const target = text.split(/\s+/).pop();
      return [`Server:		172.30.0.10`, `Address:	172.30.0.10#53`, '', `Name:	${target}`, 'Address: 172.30.43.12'];
    }
    return [`(command executed in ${pod.metadata?.name}/${containerName})`, `$ ${text}`, 'exit code 0'];
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Deploy: expose, process, new-app, new-build, start-build, cancel-build, tag,
// import-image
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdExpose(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'name', 'hostname', 'path', 'port', 'selector', 'wildcard-policy'],
      longBools: ['internal', 'generated'],
    });
    let kind = null;
    let name = null;
    if (positionals.length) {
      if (isResourceRef(positionals[0])) {
        ({ kind, name } = splitResourceRef(positionals));
      } else {
        kind = normalizeKind(positionals[0]);
        if (kind) name = positionals[1];
        else {
          kind = 'Service';
          name = positionals[0];
        }
      }
    }
    if (!kind) kind = 'Service';
    if (!name) return this._usageError('expose', 'resource name is required\n\n  oc expose svc/<name> [--hostname=] [--path=]');
    const namespace = this._namespaceFromFlags(flags);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const ge = this.gameEngine;
    const options = {
      namespace,
      name: flags.name && flags.name !== true ? String(flags.name) : undefined,
      hostname: flags.hostname && flags.hostname !== true ? String(flags.hostname) : '',
      path: flags.path && flags.path !== true ? String(flags.path) : '/',
      port: flags.port && flags.port !== true ? String(flags.port) : undefined,
      wildcardPolicy: flags['wildcard-policy'] && flags['wildcard-policy'] !== true ? String(flags['wildcard-policy']) : undefined,
    };
    if (kind === 'Service') {
      let service = this._findResource('Service', name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
      let serviceWarning = '';
      if (!service) {
        // Simulator convenience: `oc expose svc/web` right after creating a
        // Deployment "web" (the EX280 quick-start flow) creates the missing
        // Service from the workload's template labels/ports.
        const workload =
          this._findResource('Deployment', name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }) ||
          this._findResource('StatefulSet', name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }) ||
          this._findResource('DaemonSet', name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
        if (workload) {
          const labels = workload.spec?.template?.metadata?.labels || { app: name };
          const selector = workload.spec?.selector?.matchLabels || labels;
          const containerPorts = (workload.spec?.template?.spec?.containers || []).flatMap((container) => container.ports || []);
          const ports = (containerPorts.length ? containerPorts : [{ containerPort: 8080 }]).map((port, index) => ({
            name: port.name || (index === 0 ? 'http' : `port-${port.containerPort}`),
            port: Number(flags.port) || port.containerPort || 8080,
            targetPort: port.containerPort || 8080,
            protocol: port.protocol || 'TCP',
          }));
          const createdService = this._applyObject({
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name, namespace, labels },
            spec: { selector, ports, type: 'ClusterIP' },
          });
          if (createdService.error) return createdService.error;
          service = createdService.resource;
          serviceWarning = `warning: service "${name}" did not exist and was created from ${this._resourceRef(workload.kind)} "${name}" (simulator convenience; real oc: expose the deployment or create the service first)`;
        }
      }
      if (!service) return this._err(this._notFoundMessage('Service', name));
      if (ge && typeof ge.exposeService === 'function') {
        const result = ge.exposeService(name, options);
        if (result.success === false) return this._err(result.message);
        return this._ok([serviceWarning, result.message || `route.route.openshift.io/${name} exposed`].filter(Boolean).join('\n'));
      }
      const routeName = options.name || name;
      const routeSpec = {
        host: options.hostname || '',
        path: options.path || '/',
        to: { kind: 'Service', name, weight: 100 },
        port: { targetPort: options.port || service.spec?.ports?.[0]?.name || service.spec?.ports?.[0]?.port || 'http' },
        wildcardPolicy: options.wildcardPolicy || 'None',
      };
      const created = this._applyObject({
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name: routeName, namespace },
        spec: routeSpec,
      });
      if (created.error) return created.error;
      return this._ok(`route.route.openshift.io/${routeName} exposed`);
    }
    if (['Deployment', 'DeploymentConfig', 'StatefulSet', 'DaemonSet'].includes(kind)) {
      const workload = this._findResource(kind, name, { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) });
      if (!workload) return this._err(this._notFoundMessage(kind, name));
      const labels = workload.spec?.template?.metadata?.labels || { app: name };
      const selector = workload.spec?.selector?.matchLabels || labels;
      let service = this._findResource('Service', name, { namespace, explicitNamespace: true });
      const serviceName = name;
      if (!service) {
        const createdService = this._applyObject({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: serviceName, namespace, labels },
          spec: {
            selector,
            ports: [{ name: 'http', port: Number(flags.port) || 8080, targetPort: Number(flags.port) || 8080, protocol: 'TCP' }],
            type: 'ClusterIP',
          },
        });
        if (createdService.error) return createdService.error;
        service = createdService.resource;
      }
      const routeResult = ge && typeof ge.exposeService === 'function'
        ? ge.exposeService(serviceName, { ...options, name: options.name || serviceName })
        : { success: true, message: `route.route.openshift.io/${serviceName} exposed` };
      if (routeResult.success === false) return this._err(routeResult.message);
      return this._ok(`service/${serviceName} exposed\n${routeResult.message || ''}`.trim());
    }
    return this._err(`error: cannot expose a ${kind}; use a Service or a workload`);
  },

  _templateParametersFromText(text) {
    const lines = String(text || '').split('\n');
    const parameters = [];
    let inParameters = false;
    let baseIndent = 0;
    let current = null;
    for (const line of lines) {
      if (!inParameters) {
        if (/^\s*parameters:\s*$/.test(line)) {
          inParameters = true;
          baseIndent = line.search(/\S/);
        }
        continue;
      }
      const indent = line.search(/\S/);
      if (line.trim() === '') continue;
      if (indent <= baseIndent) break;
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+)$/);
      if (nameMatch) {
        if (current) parameters.push(current);
        current = { name: nameMatch[1].trim().replace(/^["']|["']$/g, '') };
        continue;
      }
      const propertyMatch = line.match(/^\s*(displayName|description|required|value|generate):\s*(.*)$/);
      if (propertyMatch && current) {
        let value = propertyMatch[2].trim().replace(/^["']|["']$/g, '');
        if (propertyMatch[1] === 'required') value = value === 'true';
        current[propertyMatch[1]] = value;
      }
    }
    if (current) parameters.push(current);
    return parameters;
  },

  _printTemplateParameters(parameters) {
    if (!parameters.length) return this._ok('No parameters found in template.');
    const rows = parameters.map((parameter) => [
      parameter.name,
      parameter.displayName || '',
      parameter.description || '',
      parameter.generate || '',
      parameter.value !== undefined ? String(parameter.value) : '',
    ]);
    return this._ok(padTable(['NAME', 'DISPLAY NAME', 'DESCRIPTION', 'GENERATOR', 'VALUE'], rows));
  },

  _cmdProcess(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-n': 'namespace', '-o': 'output', '-p': 'param' },
      longValues: ['filename', 'namespace', 'output', 'param', 'param-file', 'template'],
      multi: ['param'],
      longBools: ['parameters', 'local', 'raw'],
    });
    const params = parseCommaAssignments(this._arrayFlag(flags, 'param'));
    for (const paramFile of this._arrayFlag(flags, 'param-file')) {
      const content = this._readVirtualFile(String(paramFile));
      if (content === null) return this._err(`error: open ${paramFile}: no such file or directory`);
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (match) params[match[1]] = match[2];
      }
    }
    const filename = flags.filename && flags.filename !== true ? String(flags.filename) : null;
    const templateName = flags.template && flags.template !== true ? String(flags.template) : positionals[0] || null;
    const namespace = this._namespaceFromFlags(flags);
    const output = this._outputFormat(flags);

    if (flags.parameters) {
      if (filename) {
        const me = this.manifestEngine;
        if (me && typeof me.templateParameters === 'function' && filename !== '-') {
          try {
            const declared = me.templateParameters(filename);
            if (Array.isArray(declared) && declared.length) {
              return this._printTemplateParameters(declared);
            }
          } catch {
            /* fall back to text parsing */
          }
        }
        const text = filename === '-' ? ctx?.stdin : this._readVirtualFile(filename);
        if (text === null || text === undefined) return this._manifestReady() ? this._err(`error: open ${filename}: no such file or directory`) : this._manifestNotReady();
        return this._printTemplateParameters(this._templateParametersFromText(text));
      }
      if (templateName) {
        const templateObject = this._findTemplate(templateName);
        if (!templateObject) return this._err(`Error from server (NotFound): templates.template.openshift.io "${templateName}" not found`);
        return this._printTemplateParameters((templateObject.spec?.parameters || templateObject.parameters || []));
      }
      return this._err('error: you must specify a template with -f <file> or <template-name>');
    }

    let text = '';
    let objects = [];
    if (filename) {
      const processed = this._processTemplateDelegated(filename, params, { stdinText: ctx?.stdin ?? null });
      if (processed.error) return processed;
      text = processed.text || '';
      objects = processed.objects || [];
    } else if (templateName) {
      const ge = this.gameEngine;
      let result = null;
      const template = this._findTemplate(templateName);
      if (ge && typeof ge.processTemplate === 'function' && template && !BUILTIN_TEMPLATES[templateName]) {
        result = ge.processTemplate(templateName, params, { namespace, apply: false });
      }
      if (result && result.success === false && !template) return this._err(result.message);
      if (result && result.success !== false && Array.isArray(result.objects)) objects = result.objects;
      else {
        if (!template) return this._err(`Error from server (NotFound): templates.template.openshift.io "${templateName}" not found`);
        objects = this._renderTemplateObjects(template, params);
      }
    } else {
      return this._err('error: must specify a template with -f <file> or <template-name>\n\n  oc process -f <file> [-p KEY=VALUE] [-o yaml]');
    }

    if (!objects.length && text) return this._ok(text);
    if (output.format === 'json') {
      return this._ok(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }, null, 4));
    }
    if (output.format === 'name') {
      return this._ok(objects.map((object) => `${this._resourceRef(object.kind)}/${object.metadata?.name || 'unnamed'}`).join('\n'));
    }
    if (output.format === 'yaml' || output.format === 'table') {
      return this._ok(toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }));
    }
    return this._ok(text || toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }));
  },

  /**
   * `oc kustomize [dir]` — render a kustomization target to stdout.
   * Uses the manifest engine's kustomize loader when it exposes one (the
   * public render hook is a declarative-auditor HANDOFF; see fixes log).
   */
  _cmdKustomize(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-o': 'output', '-n': 'namespace' },
      longValues: ['output', 'namespace'],
      longBools: ['enable-alpha-plugins', 'load-restrictor', 'reorder'],
    });
    const dir = positionals[0] || '.';
    const output = this._outputFormat(flags);
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    if (typeof me.renderKustomize !== 'function') {
      return this._err('error: oc kustomize rendering is not available in this build.');
    }
    let result;
    try {
      result = me.renderKustomize(dir);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    if (!result || result.ok === false) return this._err(result?.error || result?.errors?.[0] || 'error: kustomize build failed');
    const objects = Array.isArray(result.objects) ? result.objects : [];
    const warnings = (result.warnings || []).map((warning) => `warning: ${warning}`);
    const prefix = warnings.length ? `${warnings.join('\n')}\n` : '';
    if (output.format === 'json') {
      return this._ok(prefix + JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }, null, 4));
    }
    return this._ok(prefix + (result.yaml || toYamlDocuments(objects)));
  },

  _builtinTemplate(name) {
    const definition = BUILTIN_TEMPLATES[name];
    if (!definition) return null;
    return { metadata: { name, namespace: 'openshift' }, spec: definition };
  },

  /** Resource-shaped builtin templates (shown by `oc get templates -n openshift`). */
  _builtinTemplateObjects() {
    const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return Object.entries(BUILTIN_TEMPLATES).map(([name, definition]) => ({
      kind: 'Template',
      apiVersion: 'template.openshift.io/v1',
      metadata: { name, namespace: 'openshift', creationTimestamp: createdAt },
      spec: definition,
      status: {},
    }));
  },

  /** Look up a Template by name across the usual namespaces plus builtins. */
  _findTemplate(name) {
    const candidates = [this.currentProject, 'openshift', 'openshift-config'];
    for (const candidate of candidates) {
      const found = this._findResource('Template', name, { namespace: candidate, explicitNamespace: true });
      if (found) return found;
    }
    return this._builtinTemplate(name);
  },

  _renderTemplateObjects(template, params) {
    const parameters = {};
    for (const parameter of template.spec?.parameters || template.parameters || []) {
      if (parameter.value !== undefined) parameters[parameter.name] = String(parameter.value);
    }
    Object.assign(parameters, params || {});
    const substitute = (value) => {
      if (typeof value === 'string') return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => (parameters[key] !== undefined ? parameters[key] : match));
      if (Array.isArray(value)) return value.map((entry) => substitute(entry));
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry);
        return out;
      }
      return value;
    };
    return (template.spec?.objects || template.objects || []).map((object) => substitute(object));
  },

  _cmdNewApp(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-e': 'env', '-p': 'param', '-f': 'file' },
      longValues: ['namespace', 'name', 'image', 'image-stream', 'code', 'template', 'file', 'env', 'param', 'context-dir', 'source-secret', 'strategy', 'replicas', 'port', 'builder-image'],
      multi: ['env', 'param'],
      longBools: ['build', 'dockerfile', 'binary', 'source'],
    });
    const namespace = this._namespaceFromFlags(flags);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const env = parseCommaAssignments(this._arrayFlag(flags, 'env'));
    const params = parseCommaAssignments(this._arrayFlag(flags, 'param'));
    const name = flags.name && flags.name !== true ? String(flags.name) : undefined;
    const templateName = flags.template && flags.template !== true ? String(flags.template) : null;
    const file = flags.file && flags.file !== true ? String(flags.file) : null;
    const imageStream = flags['image-stream'] && flags['image-stream'] !== true ? String(flags['image-stream']) : null;
    const code = flags.code && flags.code !== true ? String(flags.code) : null;
    const image = flags.image && flags.image !== true ? String(flags.image) : null;
    const ge = this.gameEngine;

    // `oc new-app -f template-file`: process the file and apply the objects.
    if (file) {
      const processed = this._processTemplateDelegated(file, params, { stdinText: ctx?.stdin ?? null });
      if (processed.error) return processed;
      const objects = processed.objects || [];
      if (!objects.length) return this._err('error: template file produced no objects');
      return this._newAppDeployObjects(objects, { namespace, templateName: this._basename(file), name });
    }

    // `oc new-app --template=<name>`.
    if (templateName) {
      const template = this._findTemplate(templateName);
      if (ge && typeof ge.newApp === 'function' && template && !BUILTIN_TEMPLATES[templateName]) {
        const result = ge.newApp({ template: templateName, params, name, namespace });
        if (result.success === false) return this._err(result.message);
        return this._ok(this._formatNewAppOutput(result, { namespace, templateName }));
      }
      if (!template) return this._err(`Error while generating the application: template "${templateName}" not found`);
      const objects = this._renderTemplateObjects(template, params);
      return this._newAppDeployObjects(objects, { namespace, templateName, name });
    }

    // Determine the source: explicit flags, positional `<is>~<git>`, or git URL vs image.
    let resolvedImageStream = imageStream;
    let resolvedCode = code;
    let resolvedImage = image;
    const source = positionals[0];
    if (source && !resolvedImage && !resolvedImageStream && !resolvedCode) {
      if (source.includes('~')) {
        const [left, right] = source.split('~');
        resolvedImageStream = left;
        resolvedCode = right;
      } else if (/^(https?:\/\/|git@|git:\/\/)/.test(source) || /\.git($|\/)/.test(source)) {
        resolvedCode = source;
      } else {
        resolvedImage = source;
      }
    }
    if (!resolvedImage && !resolvedImageStream && !resolvedCode) {
      return this._err('error: no image, source or template specified for oc new-app\n\n  oc new-app <image|git-url> [--name=] [--code=] [--template=<name>] [-f <template-file>]');
    }

    if (ge && typeof ge.newApp === 'function') {
      const options = {
        namespace,
        name,
        image: resolvedImage || undefined,
        imageStream: resolvedImageStream || undefined,
        code: resolvedCode || undefined,
        env,
        contextDir: flags['context-dir'] && flags['context-dir'] !== true ? String(flags['context-dir']) : undefined,
        replicas: flags.replicas ? Number(flags.replicas) : undefined,
        port: flags.port ? Number(flags.port) : undefined,
        builderImage: flags['builder-image'] && flags['builder-image'] !== true ? String(flags['builder-image']) : undefined,
      };
      const result = ge.newApp(options);
      if (result.success === false) return this._err(result.message);
      return this._ok(this._formatNewAppOutput(result, { namespace, source: resolvedImage || resolvedImageStream || resolvedCode || '' }));
    }

    // Fallback: create Deployment + Service directly.
    if (resolvedImage || resolvedImageStream) {
      const appName = name || this._appNameFromSource(resolvedImage || resolvedImageStream || 'app');
      const imageRef = resolvedImage || `${INTERNAL_REGISTRY}/openshift/${resolvedImageStream}`;
      const container = { name: 'main', image: imageRef, ports: [{ containerPort: 8080 }] };
      if (Object.keys(env).length) container.env = Object.entries(env).map(([key, value]) => ({ name: key, value }));
      const createdObjects = [];
      const deployment = this._applyObject({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: appName, namespace, labels: { app: appName } },
        spec: {
          replicas: flags.replicas ? Number(flags.replicas) : 1,
          selector: { matchLabels: { app: appName } },
          template: { metadata: { labels: { app: appName } }, spec: { containers: [container] } },
        },
      });
      if (deployment.error) return deployment.error;
      createdObjects.push(deployment.resource);
      const service = this._applyObject({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: appName, namespace, labels: { app: appName } },
        spec: { selector: { app: appName }, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
      });
      if (!service.error) createdObjects.push(service.resource);
      return this._ok(this._formatNewAppOutput({ resources: createdObjects, message: '' }, { namespace }));
    }
    return this._err('error: oc new-app from source requires the game engine to be initialised');
  },

  _appNameFromSource(source) {
    const raw = String(source || 'app').split('~')[0].split('|')[0].replace(/\/+$/, '');
    let name = raw.split('/').pop() || 'app';
    name = name.replace(/\.git$/, '');
    if (name.includes(':')) name = name.split(':')[0];
    return name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'app';
  },

  _formatNewAppOutput(result, context = {}) {
    const namespace = context.namespace || this.currentProject;
    const resources = result.resources || [];
    const lines = [];
    if (context.templateName) {
      lines.push(`--> Deploying template "${context.templateName}" for "${context.templateName}" to project ${namespace}`, '');
    } else {
      const source = context.source || '';
      if (source) {
        const isGit = /^(https?:\/\/|git@|git:\/\/)/.test(source) || /\.git($|\/)/.test(source);
        lines.push(`--> Found ${isGit ? 'source code' : 'container image'} for "${source}"`, '');
      }
    }
    lines.push('--> Creating resources ...');
    for (const resource of resources) {
      const kind = resource.kind;
      const name = resource.metadata?.name;
      const action = resource._applyAction === 'updated' ? 'configured' : 'created';
      lines.push(`    ${this._resourceRef(kind)} "${name}" ${action}`);
    }
    lines.push('--> Success');
    if (resources.some((resource) => resource.kind === 'BuildConfig')) {
      lines.push("    Build scheduled, use 'oc logs -f bc/<name>' to track its progress.");
    }
    lines.push("    Run 'oc status' to view your app.");
    return lines.join('\n');
  },

  _newAppDeployObjects(objects, context) {
    const resources = [];
    for (const object of objects) {
      const result = this._applyObject(object);
      if (result.error) return result.error;
      if (result.resource) {
        result.resource._applyAction = result.created === false ? 'updated' : 'created';
        resources.push(result.resource);
      }
    }
    return this._ok(this._formatNewAppOutput({ resources }, context));
  },

  _cmdNewBuild(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'name', 'code', 'image-stream', 'strategy', 'context-dir', 'dockerfile', 'to'],
      longBools: ['binary', 'dockerfile'],
    });
    const ge = this.gameEngine;
    const namespace = this._namespaceFromFlags(flags);
    const source = positionals[0];
    const code = flags.code && flags.code !== true ? String(flags.code) : source && (/^(https?:\/\/|git@)/.test(source) || source === '.') ? source : undefined;
    const imageStream = flags['image-stream'] && flags['image-stream'] !== true ? String(flags['image-stream']) : source && !code ? source : undefined;
    const name = flags.name && flags.name !== true ? String(flags.name) : undefined;
    if (!code && !imageStream && !flags.dockerfile && !flags.binary) {
      return this._err('error: no image or source specified\n\n  oc new-build <image-stream> --name=<bc>\n  oc new-build --code=<git-url> --name=<bc>');
    }
    if (ge && typeof ge.newBuild === 'function') {
      const result = ge.newBuild({ name, code, imageStream, namespace, dockerfile: flags.dockerfile ? String(flags.dockerfile === true ? 'Dockerfile' : flags.dockerfile) : undefined });
      if (result.success === false) return this._err(result.message);
      const buildConfig = result.buildConfig;
      const lines = ['--> Creating resources ...'];
      if (buildConfig) lines.push(`    buildconfig.build.openshift.io "${buildConfig.metadata?.name}" created`);
      lines.push('--> Success', "    Run 'oc start-build <name>' to start a build, or 'oc logs -f bc/<name>' once scheduled.");
      return this._ok(lines.join('\n'));
    }
    return this._err('error: oc new-build requires the game engine to be initialised');
  },

  _cmdStartBuild(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'from-dir', 'from-file', 'env', 'commit', 'from-build'],
      multi: ['env'],
      longBools: ['follow', 'wait', 'no-cache'],
    });
    const { kind, name } = this._resolveRef(positionals);
    const buildConfigName = kind === 'BuildConfig' ? name : kind ? null : positionals[0];
    if (!buildConfigName) {
      return this._usageError('start-build', 'build config name is required\n\n  oc start-build <buildconfig> [--follow] [--from-dir=.]');
    }
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.startBuild === 'function') {
      const result = ge.startBuild(buildConfigName, { namespace });
      if (result.success === false) return this._err(result.message);
      const lines = [result.message || `build.build.openshift.io/${buildConfigName}-1 started`];
      if (flags.follow) {
        lines.push('', ...this._buildLogLines(result.build || { metadata: { name: buildConfigName }, status: { phase: 'Running' }, spec: {} }), '', '--> Success');
      } else if (result.build) {
        lines.push("Run 'oc logs -f bc/" + buildConfigName + "' to follow the build logs.");
      }
      return this._ok(lines.join('\n'));
    }
    return this._err('error: oc start-build requires the game engine to be initialised');
  },

  _cmdCancelBuild(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: ['all', 'state'],
    });
    const { kind, name } = this._resolveRef(positionals);
    const target = kind === 'Build' || kind === 'BuildConfig' ? name : kind ? null : positionals[0];
    if (!target) return this._usageError('cancel-build', 'name is required\n\n  oc cancel-build <buildconfig|build>');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.cancelBuild === 'function') {
      const result = ge.cancelBuild(target, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `build.build.openshift.io/${target} cancelled`);
    }
    return this._err('error: oc cancel-build requires the game engine to be initialised');
  },

  _cmdTag(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'reference-policy', 'source'],
      longBools: ['scheduled', 'delete', 'all'],
    });
    const source = positionals[0];
    const destination = positionals[1] || positionals[0];
    if (!source) return this._usageError('tag', 'source and destination image streams are required\n\n  oc tag <source> <destination> [--scheduled]');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.tagImage === 'function') {
      const result = ge.tagImage(source, destination, { namespace });
      if (result.success === false) return this._err(result.message);
      if (flags.scheduled) return this._ok(`Tag ${destination} scheduled for import.`);
      return this._ok(`Tag ${destination} set to ${source}.`);
    }
    return this._err('error: oc tag requires the game engine to be initialised');
  },

  _cmdImportImage(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'from'],
      longBools: ['confirm', 'all', 'scheduled', 'reference-policy'],
    });
    const reference = positionals[0];
    if (!reference) {
      return this._usageError('import-image', 'image stream reference is required\n\n  oc import-image <imagestream>:<tag> --from=<image> --confirm');
    }
    const from = flags.from && flags.from !== true ? String(flags.from) : null;
    if (!from) return this._err('error: --from=<image> is required for oc import-image');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.importImage === 'function') {
      const result = ge.importImage(reference, { from, namespace, all: Boolean(flags.all) });
      if (result.success === false) return this._err(result.message);
      const [name, tag = 'latest'] = reference.split(':');
      return this._ok(
        [
          `imagestream.image.openshift.io/${name} imported`,
          '',
          `Name:			${name}`,
          `Namespace:		${namespace}`,
          `Tag:			${tag}`,
          `From:			${from}`,
          `Image Repository:	${INTERNAL_REGISTRY}/${namespace}/${name}`,
        ].join('\n'),
      );
    }
    return this._err('error: oc import-image requires the game engine to be initialised');
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Admin, authorization, debug, Helm, htpasswd and help
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdAdm(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    switch (sub) {
      case 'policy':
        return this._admPolicy(rest);
      case 'groups':
      case 'group':
        return this._admGroups(rest);
      case 'cordon':
        return this._admNodeAction('cordon', rest);
      case 'uncordon':
        return this._admNodeAction('uncordon', rest);
      case 'drain':
        return this._admNodeAction('drain', rest);
      case 'taint':
        return this._admNodeAction('taint', rest);
      case 'top':
        return this._admTop(rest);
      case 'must-gather':
        return this._admMustGather(rest);
      case 'inspect':
        return this._admInspect(rest);
      case 'create-bootstrap-project-template':
        return this._admCreateBootstrapProjectTemplate(rest);
      default:
        return this._err(
          `error: unknown adm subcommand "${sub || ''}"\n\nValid subcommands:\n  policy   Manage authorization (roles, SCCs, who-can)\n  groups   Manage groups\n  cordon   Mark a node unschedulable\n  uncordon Mark a node schedulable\n  drain    Evict pods from a node\n  taint    Update the taints on nodes\n  top      Display resource usage\n  create-bootstrap-project-template  Output the default project-request template\n  must-gather  Collect cluster diagnostics (simulated)\n  inspect  Inspect a resource and its dependents (simulated)\n\nRun 'oc adm --help' for details.`,
        );
    }
  },

  _admPolicy(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-z': 'serviceaccount' },
      longValues: ['namespace', 'serviceaccount', 'rolebinding-name', 'clusterrole', 'role', 'user', 'group'],
      longBools: ['dry-run'],
    });
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    const useServiceAccount = flags.serviceaccount && flags.serviceaccount !== true;
    const saName = useServiceAccount ? String(flags.serviceaccount) : null;
    const role = positionals[0];
    const subject = positionals[1];
    const engineCall = (method, args) => {
      if (ge && typeof ge[method] === 'function') return ge[method](...args);
      return null;
    };
    const notAvailable = () => this._err('error: authorization changes are not available in this build');

    switch (sub) {
      case 'add-role-to-user':
      case 'add-cluster-role-to-user':
      case 'add-role-to-group':
      case 'add-cluster-role-to-group': {
        const isClusterWide = sub.includes('cluster-role');
        const subjectKind = sub.endsWith('-group') ? 'Group' : 'User';
        if (!role || (!subject && !saName)) {
          return this._usageError('adm', `role and subject are required\n\n  oc adm policy ${sub} <role> <${subjectKind.toLowerCase()}|-z sa> [-n <project>]`);
        }
        const target = saName || subject;
        if (!ge) return notAvailable();
        let result;
        if (sub === 'add-role-to-user') {
          result = engineCall('addRoleToUser', [role, target, { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) }]);
        } else if (sub === 'add-cluster-role-to-user') {
          result = engineCall('addClusterRoleToUser', [role, target, { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) }]);
        } else if (sub === 'add-role-to-group') {
          result = engineCall('addRoleToGroup', [role, target, { namespace }]);
        } else {
          result = engineCall('addClusterRoleToGroup', [role, target, { namespace }]);
        }
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        const subjectText = saName ? `system:serviceaccount:${namespace}:${saName}` : target;
        const kindLine = isClusterWide ? 'clusterrole.rbac.authorization.k8s.io' : 'role.rbac.authorization.k8s.io';
        return this._ok(`${kindLine}/${role} added: "${subjectText}"`);
      }
      case 'remove-role-from-user':
      case 'remove-cluster-role-from-user':
      case 'remove-role-from-group':
      case 'remove-cluster-role-from-group': {
        const isClusterWide = sub.includes('cluster-role');
        const subjectKind = sub.endsWith('-group') ? 'Group' : 'User';
        if (!role || !subject) {
          return this._usageError('adm', `role and subject are required\n\n  oc adm policy ${sub} <role> <${subjectKind.toLowerCase()}> [-n <project>]`);
        }
        if (!ge) return notAvailable();
        const methodMap = {
          'remove-role-from-user': 'removeRoleFromUser',
          'remove-cluster-role-from-user': 'removeClusterRoleFromUser',
          'remove-role-from-group': 'removeRoleFromGroup',
          'remove-cluster-role-from-group': 'removeClusterRoleFromGroup',
        };
        const result = engineCall(methodMap[sub], [role, subject, { namespace }]);
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        const kindLine = isClusterWide ? 'clusterrole.rbac.authorization.k8s.io' : 'role.rbac.authorization.k8s.io';
        return this._ok(`${kindLine}/${role} removed: "${subject}"`);
      }
      case 'add-scc-to-user':
      case 'add-scc-to-group': {
        const sccName = role;
        const target = saName || subject;
        if (!sccName || !target) {
          return this._usageError('adm', `SCC and subject are required\n\n  oc adm policy ${sub} <scc> <user|-z sa> [-n <project>]`);
        }
        if (!ge) return notAvailable();
        let result;
        if (sub === 'add-scc-to-group') {
          result = engineCall('addSCCToGroup', [sccName, target, { namespace }]);
        } else {
          result = engineCall('addSCCToUser', [sccName, target, { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) }]);
        }
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        const subjectText = saName ? `system:serviceaccount:${namespace}:${saName}` : target;
        return this._ok(`securitycontextconstraints.security.openshift.io/${sccName} added to: ["${subjectText}"]`);
      }
      case 'remove-scc-from-user':
      case 'remove-scc-from-group': {
        const sccName = role;
        const target = subject;
        if (!sccName || !target) {
          return this._usageError('adm', `SCC and subject are required\n\n  oc adm policy ${sub} <scc> <user|group>`);
        }
        if (!ge) return notAvailable();
        const method = sub === 'remove-scc-from-group' ? 'removeSCCFromGroup' : 'removeSCCFromUser';
        const result = engineCall(method, [sccName, target, { namespace }]);
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        return this._ok(`securitycontextconstraints.security.openshift.io/${sccName} removed from: ["${target}"]`);
      }
      case 'who-can': {
        const verb = positionals[0];
        const resourceToken = positionals[1];
        if (!verb || !resourceToken) {
          return this._usageError('adm', 'verb and resource are required\n\n  oc adm policy who-can <verb> <resource> [-n <project>]');
        }
        const kind = normalizeKind(resourceToken) || resourceToken;
        const who = ge && typeof ge.whoCan === 'function'
          ? ge.whoCan(verb, kind, namespace)
          : this._whoCanFallback(verb, kind, namespace);
        const users = (who || []).filter((entry) => entry.kind === 'User').map((entry) => entry.name);
        const groups = (who || []).filter((entry) => entry.kind === 'Group').map((entry) => entry.name);
        const serviceAccounts = (who || []).filter((entry) => entry.kind === 'ServiceAccount').map((entry) => entry.name);
        const sccToken = String(resourceToken).match(/^scc\/(.+)$/);
        const clusterScoped = Boolean(sccToken) || isClusterScopedKind(normalizeKind(resourceToken) || '');
        const resourceDisplay = sccToken
          ? `securitycontextconstraints.security.openshift.io/${sccToken[1]}`
          : normalizeKind(resourceToken)
            ? this._resourceNamePlural(normalizeKind(resourceToken))
            : String(resourceToken);
        const lines = [
          ...(clusterScoped ? [] : [`Namespace: ${namespace}`]),
          `Verb:      ${verb}`,
          `Resource:  ${resourceDisplay}`,
          '',
        ];
        if (users.length) lines.push(`Users:  ${users.join(', ')}`);
        if (groups.length) lines.push(`Groups: ${groups.join(', ')}`);
        if (serviceAccounts.length) lines.push(`ServiceAccounts: ${serviceAccounts.join(', ')}`);
        if (!users.length && !groups.length && !serviceAccounts.length) lines.push('<none>');
        return this._ok(lines.join('\n'));
      }
      case 'scc-review':
      case 'scc-subject-review': {
        const target = saName || subject;
        if (!target) {
          return this._usageError('adm', `subject is required\n\n  oc adm policy ${sub} -z <serviceaccount> -n <project>`);
        }
        const identity = saName ? `system:serviceaccount:${namespace}:${saName}` : target;
        let scc = null;
        const cluster = this.cluster;
        if (cluster && typeof cluster.sccForServiceAccount === 'function' && saName) {
          try {
            scc = cluster.sccForServiceAccount(namespace, saName);
          } catch {
            scc = null;
          }
        }
        if (!scc) scc = this._resources('SecurityContextConstraints').find((candidate) => (candidate.spec?.users || []).includes(identity) || (candidate.spec?.groups || []).includes(identity)) || null;
        const sccName = scc?.metadata?.name || 'restricted-v2';
        return this._ok(`ServiceAccount ${identity} can create pods with SCC "${sccName}".`);
      }
      default:
        return this._err(
          `error: unknown policy subcommand "${sub || ''}"\n\nValid subcommands:\n  add-role-to-user, add-cluster-role-to-user, add-role-to-group, add-cluster-role-to-group\n  remove-role-from-user, remove-cluster-role-from-user, remove-role-from-group, remove-cluster-role-from-group\n  add-scc-to-user, add-scc-to-group, remove-scc-from-user, remove-scc-from-group\n  who-can, scc-review, scc-subject-review`,
        );
    }
  },

  /** Minimal who-can fallback used before/without the engine RBAC implementation. */
  _whoCanFallback(verb, kind, namespace) {
    const results = [];
    const seen = new Set();
    const add = (subject) => {
      const key = `${subject.kind}:${subject.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(subject);
    };
    for (const binding of this._resources('ClusterRoleBinding')) {
      const roleRef = binding.spec?.roleRef || {};
      if (!this._evaluateRules(this._roleRules('ClusterRole', roleRef.name), verb, pluralForKind(kind))) continue;
      for (const subject of binding.spec?.subjects || []) add({ kind: subject.kind, name: subject.name });
    }
    for (const binding of this._resources('RoleBinding')) {
      if (binding.metadata?.namespace !== namespace) continue;
      const roleRef = binding.spec?.roleRef || {};
      if (!this._evaluateRules(this._roleRules(roleRef.kind || 'Role', roleRef.name, namespace), verb, pluralForKind(kind))) continue;
      for (const subject of binding.spec?.subjects || []) add({ kind: subject.kind, name: subject.name });
    }
    return results;
  },

  _admGroups(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    const ge = this.gameEngine;
    if (!['new', 'add-users', 'remove-users'].includes(sub)) {
      return this._err(`error: unknown groups subcommand "${sub || ''}"\n\nValid subcommands: new, add-users, remove-users`);
    }
    if (sub === 'new') {
      const name = rest[0];
      if (!name) return this._usageError('adm', 'group name is required\n\n  oc adm groups new <group> [users...]');
      const users = rest.slice(1);
      if (ge && typeof ge.createGroupResource === 'function') {
        const result = ge.createGroupResource(name, users);
        if (result.success === false) return this._err(result.message);
        return this._ok(result.message || `group.user.openshift.io/${name} created`);
      }
      return this._finishCreateObject({ apiVersion: 'user.openshift.io/v1', kind: 'Group', metadata: { name }, spec: { users } }, {});
    }
    const group = rest[0];
    const users = rest.slice(1);
    if (!group || !users.length) {
      return this._usageError('adm', 'group and at least one user are required\n\n  oc adm groups ' + sub + ' <group> <user...>');
    }
    if (ge && typeof ge.addUsersToGroup === 'function' && sub === 'add-users') {
      const result = ge.addUsersToGroup(group, users);
      if (result.success === false) return this._err(result.message);
      return this._ok(`group.user.openshift.io/${group} added: ${users.join(', ')}`);
    }
    if (ge && typeof ge.removeUsersFromGroup === 'function' && sub === 'remove-users') {
      const result = ge.removeUsersFromGroup(group, users);
      if (result.success === false) return this._err(result.message);
      return this._ok(`group.user.openshift.io/${group} removed: ${users.join(', ')}`);
    }
    return this._err('error: group membership changes are not available in this build');
  },

  _admNodeAction(action, tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      longValues: ['grace-period', 'timeout', 'pod-selector', 'delete-local-data'],
      longBools: ['force', 'ignore-daemonsets', 'delete-emptydir-data', 'dry-run', 'disable-eviction'],
    });
    let nodeRef = positionals[0];
    if (action === 'taint' && ['nodes', 'node'].includes(String(nodeRef || '').toLowerCase())) nodeRef = positionals[1];
    if (!nodeRef) {
      return this._usageError('adm', `node name is required\n\n  oc adm ${action} node/<name> [flags]`);
    }
    const nodeName = nodeRef.includes('/') ? nodeRef.split('/').slice(1).join('/') : nodeRef;
    if (action === 'taint') {
      const taintSpec = positionals[0] === nodeRef ? positionals[1] : positionals[2];
      if (!nodeName || !taintSpec) {
        return this._usageError('adm', 'node and taint are required\n\n  oc adm taint nodes <node> key=value:NoSchedule');
      }
      const node = this._findResource('Node', nodeName, {});
      if (!node) return this._err(this._notFoundMessage('Node', nodeName));
      const remove = taintSpec.endsWith('-') && !taintSpec.includes('=');
      const result = this._updateResource('Node', nodeName, (spec) => {
        spec.taints = spec.taints || [];
        if (remove) {
          const key = taintSpec.slice(0, -1);
          spec.taints = spec.taints.filter((taint) => taint.key !== key);
          return {};
        }
        const match = taintSpec.match(/^([^=:]+)(?:=([^:]+))?:([A-Za-z]+)$/);
        if (!match) return { error: this._err(`error: invalid taint spec "${taintSpec}"`) };
        spec.taints = spec.taints.filter((taint) => taint.key !== match[1]);
        spec.taints.push({ key: match[1], value: match[2] || '', effect: match[3] });
        return {};
      }, {});
      if (result.error) return result.error;
      return this._ok(`node/${nodeName} ${remove ? 'untainted' : 'tainted'}`);
    }
    const node = this._findResource('Node', nodeName, {});
    if (!node) return this._err(this._notFoundMessage('Node', nodeName));
    if (action === 'cordon' || action === 'uncordon') {
      const cordon = action === 'cordon';
      this._updateResource('Node', nodeName, (spec) => {
        spec.unschedulable = cordon;
        return {};
      }, {});
      if (this.gameEngine && typeof this.gameEngine.queueCommand === 'function') {
        try {
          this.gameEngine.queueCommand({ type: action, name: nodeName });
        } catch {
          /* ignore */
        }
      }
      return this._ok(`node/${nodeName} ${cordon ? 'cordoned' : 'uncordoned'}`);
    }
    // drain
    const pods = this._getKindList('Pod').filter(
      (pod) => pod.spec?.nodeName === nodeName || pod.status?.nodeName === nodeName || pod.status?.hostIP === nodeName,
    );
    const daemonSetPods = pods.filter((pod) => (pod.metadata?.ownerReferences || []).some((ref) => ref.kind === 'DaemonSet'));
    const evictable = pods.filter((pod) => !(pod.metadata?.ownerReferences || []).some((ref) => ref.kind === 'DaemonSet'));
    const lines = [`node/${nodeName} cordoned`];
    if (daemonSetPods.length && !flags['ignore-daemonsets']) {
      lines.push(`WARNING: ignoring DaemonSet-managed Pods: ${daemonSetPods.map((pod) => `${pod.metadata?.namespace}/${pod.metadata?.name}`).join(', ')}`);
    }
    this._updateResource('Node', nodeName, (spec) => {
      spec.unschedulable = true;
      return {};
    }, {});
    for (const pod of evictable) {
      lines.push(`evicting pod ${pod.metadata?.namespace}/${pod.metadata?.name}`);
      try {
        this.cluster?.remove?.(pod.metadata?.uid || pod.uid);
      } catch {
        /* ignore */
      }
    }
    lines.push(`node/${nodeName} drained`);
    return this._ok(lines.join('\n'));
  },

  _admTop(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: ['containers', 'no-headers'],
    });
    const target = (positionals[0] || 'pods').toLowerCase();
    const namespace = flags.namespace || this.currentProject;
    if (target === 'nodes' || target === 'node') {
      const nodes = this._resources('Node');
      if (!nodes.length) return this._ok('No resources found.');
      const rows = nodes.map((node) => {
        const name = node.metadata?.name || 'unknown';
        const cpuCapacity = this._parseQuantityToMilli(node.spec?.cpu || node.status?.capacity?.cpu || '8');
        const memoryCapacity = this._parseQuantityToMi(node.spec?.memory || node.status?.capacity?.memory || '16Gi');
        const usage = node.status?.usage || {};
        // `Node.status.usage` is numeric millicores / MiB in the simulator; a real
        // quantity string (from metrics) is parsed normally.
        const cpuUsed = typeof usage.cpu === 'number' ? usage.cpu : this._parseQuantityToMilli(usage.cpu) || 300 + stableHash(name, 2500);
        const memoryUsed = typeof usage.memory === 'number' ? Math.round(usage.memory) : this._parseQuantityToMi(usage.memory) || 1024 + stableHash(`${name}-mem`, 4096);
        return [
          name,
          `${cpuUsed}m`,
          `${Math.round((cpuUsed / Math.max(1, cpuCapacity)) * 100)}%`,
          `${memoryUsed}Mi`,
          `${Math.round((memoryUsed / Math.max(1, memoryCapacity)) * 100)}%`,
        ];
      });
      return this._ok(padTable(['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%'], rows));
    }
    if (target === 'pods' || target === 'pod') {
      let pods = this._getKindList('Pod');
      pods = pods.filter((pod) => pod.metadata?.namespace === namespace);
      if (!pods.length) return this._ok(`No resources found in ${namespace} namespace.`);
      const rows = pods.map((pod) => {
        const name = pod.metadata?.name || 'unknown';
        const usage = pod.status?.usage || {};
        const cpu = typeof usage.cpu === 'number' ? usage.cpu : this._parseQuantityToMilli(usage.cpu) || 5 + stableHash(name, 45);
        const memory = typeof usage.memory === 'number' ? Math.round(usage.memory) : this._parseQuantityToMi(usage.memory) || 20 + stableHash(`${name}-mem`, 180);
        return [name, `${cpu}m`, `${memory}Mi`];
      });
      return this._ok(padTable(['NAME', 'CPU(cores)', 'MEMORY(bytes)'], rows));
    }
    return this._err('error: You must specify "pods" or "nodes"');
  },

  _parseQuantityToMilli(value) {
    if (value === undefined || value === null || value === '') return 0;
    const text = String(value);
    if (text.endsWith('m')) return Number.parseInt(text.slice(0, -1), 10) || 0;
    const number = Number.parseFloat(text);
    return Number.isFinite(number) ? Math.round(number * 1000) : 0;
  },

  _parseQuantityToMi(value) {
    if (value === undefined || value === null || value === '') return 0;
    const text = String(value);
    const units = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / (1024 * 1024), M: 1000 * 1000 / (1024 * 1024), G: 1000 * 1000 * 1000 / (1024 * 1024) };
    const match = text.match(/^([0-9.]+)([A-Za-z]*)$/);
    if (!match) return 0;
    const number = Number.parseFloat(match[1]);
    const unit = units[match[2]] ?? 1;
    return Math.round(number * unit);
  },

  _admMustGather(tokens) {
    const { positionals, flags } = parseArgs(tokens, { longValues: ['dest-dir', 'image', 'timeout'], longBools: ['all'] });
    const destination = flags['dest-dir'] && flags['dest-dir'] !== true ? String(flags['dest-dir']) : `must-gather.local.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-4)}`;
    const projects = this._resources('Project').length || 12;
    return this._ok(
      [
        'The must-gather tool is simulated in OpenShift Games.',
        `Gathering data for all namespaces and cluster-scoped resources ...`,
        `  - collecting project "${this.currentProject}"`,
        `  - collecting clusteroperators, clusterversion, nodes, scc, routes, builds`,
        `  - collecting audit logs and etcd health snapshot (simulated)`,
        `Wrote gather to ${destination}`,
        `Archive: ${destination}.tar.gz (simulated, ${projects} projects)`,
      ].join('\n'),
    );
  },

  _admInspect(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'dest-dir'],
      longBools: [],
    });
    const target = positionals[0];
    if (!target) {
      return this._usageError('adm', 'resource is required\n\n  oc adm inspect ns/<project>   |   oc adm inspect pod/<name>');
    }
    const namespace = flags.namespace || this.currentProject;
    let description = target;
    if (target.startsWith('ns/') || target.startsWith('namespace/')) {
      const project = target.split('/')[1];
      if (!this._projectExists(project)) return this._err(`Error from server (NotFound): project.project.openshift.io "${project}" not found`);
      description = `namespace/${project}`;
    } else if (target.includes('/')) {
      const [kindToken, name] = target.split('/');
      const kind = normalizeKind(kindToken);
      if (!kind) return this._resourceTypeError(kindToken);
      if (!this._findResource(kind, name, { namespace, explicitNamespace: true })) return this._err(this._notFoundMessage(kind, name));
      description = `${this._resourceRef(kind)}/${name}`;
    }
    const destination = flags['dest-dir'] && flags['dest-dir'] !== true ? String(flags['dest-dir']) : `inspect.local.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    return this._ok(
      [
        `Gathering data for ${description} ...`,
        '  - collecting resources, events and logs',
        `Wrote inspect data to ${destination}.`,
      ].join('\n'),
    );
  },

  _cmdAuth(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    if (sub !== 'can-i') {
      return this._err(`error: unknown auth subcommand "${sub || ''}"\n\n  oc auth can-i <verb> <resource> [--as=<user>] [--list]\n  oc auth can-i --list`);
    }
    const { positionals, flags } = parseArgs(tokens.slice(1), {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'as', 'as-group'],
      multi: ['as-group'],
      longBools: ['list', 'quiet'],
    });
    const namespace = flags.namespace || this.currentProject;
    const asUser = flags.as && flags.as !== true ? String(flags.as) : undefined;
    const ge = this.gameEngine;
    if (flags.list) {
      let permissions = null;
      if (ge && typeof ge.canIList === 'function') {
        try {
          permissions = ge.canIList(namespace, asUser);
        } catch {
          permissions = null;
        }
      }
      const rows = [];
      if (Array.isArray(permissions)) {
        for (const entry of permissions) {
          for (const rule of entry.rules || []) {
            rows.push([
              (rule.resources || []).join(', ') || '*.*',
              (rule.nonResourceURLs || []).join(', ') || '[]',
              (rule.resourceNames || []).join(', ') || '[]',
              `[${(rule.verbs || []).join(' ')}]`,
            ]);
          }
        }
      }
      if (!rows.length) {
        rows.push(['*.*', '[]', '[]', '[get list watch]']);
      }
      const unique = [...new Map(rows.map((row) => [row.join('|'), row])).values()];
      return this._ok(padTable(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], unique));
    }
    const verb = positionals[0];
    const resourceToken = positionals[1];
    if (!verb || !resourceToken) {
      return this._usageError('auth', 'verb and resource are required\n\n  oc auth can-i <verb> <resource> [--as=<user>]\n  oc auth can-i --list');
    }
    // SCC checks use the SCC user/group lists, mirroring oc's scc/ resource.
    const sccMatch = resourceToken.match(/^scc\/(.+)$/);
    if (sccMatch) {
      const sccName = sccMatch[1];
      const scc = this._resources('SecurityContextConstraints').find((candidate) => candidate.metadata?.name === sccName);
      if (!scc) return this._err(`Error from server (NotFound): securitycontextconstraints.security.openshift.io "${sccName}" not found`);
      const user = asUser || this.currentUser;
      const groups = this._userGroups(user);
      const allowed = (scc.spec?.users || []).includes(user) || (scc.spec?.groups || []).some((group) => groups.includes(group));
      return this._ok(allowed ? 'yes' : 'no');
    }
    const kind = normalizeKind(resourceToken) || resourceToken;
    const resourcePlural = normalizeKind(resourceToken) ? pluralForKind(normalizeKind(resourceToken)) : resourceToken;
    let result = null;
    if (ge && typeof ge.canI === 'function') {
      try {
        result = ge.canI(verb, resourcePlural, namespace, asUser);
      } catch {
        result = null;
      }
    }
    if (!result) result = this._canI(verb, resourcePlural, namespace, asUser);
    return this._ok(result.allowed ? 'yes' : 'no');
  },

  _cmdDebug(tokens) {
    const { positionals } = parseArgs(tokens, { longBools: ['keep-labels', 'keep-init-containers', 'keep-annotations', 'keep-liveness', 'keep-readiness', 'as-root', 'to-namespace'] });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name) return this._usageError('debug', 'resource name is required\n\n  oc debug node/<node>   |   oc debug deployment/<name>');
    if (kind === 'Node') {
      const node = this._findResource('Node', name, {});
      if (!node) return this._err(this._notFoundMessage('Node', name));
      return this._ok(
        [
          `Creating debug namespace/openshift-debug-node-${name} ...`,
          `Starting pod/${name}-debug ...`,
          `To use host binaries, run \`chroot /host\``,
          '',
          `(node/${name}) $ `,
        ].join('\n'),
      );
    }
    const resource = this._findResource(kind, name, { namespace: this.currentProject, explicitNamespace: false });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const containers = this._containerList(resource);
    return this._ok(
      [
        `Creating debug pod for ${this._resourceRef(kind)}/${name} ...`,
        `Starting pod/${name}-debug ...`,
        `If you don't see a command prompt, try pressing enter.`,
        '',
        `(pod/${name}-debug) $ ${containers.length ? `# shell inside ${containers[0].image}` : ''}`,
      ]
        .join('\n')
        .trimEnd(),
    );
  },

  _cmdHelm(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const { positionals, flags } = parseArgs(tokens.slice(1), {
      shortValues: { '-n': 'namespace', '-f': 'values' },
      longValues: ['namespace', 'values', 'values-file', 'set', 'version', 'repo'],
      multi: ['set'],
      longBools: ['dry-run', 'wait', 'atomic', 'generate-name'],
    });
    const namespace = this._namespaceFromFlags(flags);
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    switch (sub) {
      case 'list':
      case 'ls': {
        const result = this._helmCall('listHelm', [{ namespace }]);
        if (result.error) return result;
        const releases = Array.isArray(result.result) ? result.result : Array.isArray(result.result?.releases) ? result.result.releases : [];
        const rows = releases.map((release) => [
          release.name || release.release || '',
          release.namespace || namespace,
          String(release.revision || 1),
          release.updatedAt ? formatAge(release.updatedAt) : release.updated || 'just now',
          release.status || 'deployed',
          release.chartVersion ? `${release.chart}-${release.chartVersion}` : release.chart || release.chartName || '',
          release.appVersion || release.app_version || '1.0.0',
        ]);
        return this._ok(padTable(['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'], rows));
      }
      case 'install':
      case 'upgrade': {
        const release = positionals[0];
        const chart = positionals[1];
        if (!release || !chart) {
          return this._usageError('helm', `release name and chart are required\n\n  helm ${sub} <release> <chart> [-f values.yaml] [-n <project>]`);
        }
        const valuesPath = flags.values && flags.values !== true ? String(flags.values) : flags['values-file'] && flags['values-file'] !== true ? String(flags['values-file']) : null;
        const method = sub === 'install' ? 'installHelm' : 'upgradeHelm';
        const dryRun = flags['dry-run'] === true || ['client', 'server'].includes(String(flags['dry-run'] || ''));
        const setValues = parseCommaAssignments(this._arrayFlag(flags, 'set'));
        const warnings = [];
        if (flags.wait) warnings.push('warning: --wait is accepted but not simulated (the simulator applies resources synchronously)');
        if (flags.atomic) warnings.push('warning: --atomic is accepted but not simulated');
        const result = this._helmCall(method, [release, chart, valuesPath, { namespace, dryRun, setValues }]);
        if (result.error) return result;
        const record = result.result || {};
        if (record.success === false || record.ok === false) {
          return this._err(record.message || record.error || 'helm failed');
        }
        const revision = record.revision || (sub === 'install' ? 1 : undefined);
        return this._ok(
          [
            ...warnings,
            `NAME: ${release}`,
            `LAST DEPLOYED: ${new Date().toISOString()}`,
            `NAMESPACE: ${record.namespace || namespace}`,
            `STATUS: ${dryRun ? 'pending-install' : record.status || 'deployed'}`,
            ...(revision ? [`REVISION: ${revision}`] : []),
            '',
            dryRun ? '(dry run) rendered resources but did not install the release' : '',
            record.message && typeof record.message === 'string' ? record.message : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        );
      }
      case 'uninstall':
      case 'delete': {
        const release = positionals[0];
        if (!release) return this._usageError('helm', 'release name is required\n\n  helm uninstall <release>');
        const result = this._helmCall('uninstallHelm', [release, { namespace }]);
        if (result.error) return result;
        if (result.result && (result.result.success === false || result.result.ok === false)) {
          return this._err(result.result.message || result.result.error || `release "${release}" not found`);
        }
        return this._ok(`release "${release}" uninstalled`);
      }
      case 'status': {
        const release = positionals[0];
        if (!release) return this._usageError('helm', 'release name is required\n\n  helm status <release>');
        const listResult = this._helmCall('listHelm', [{ namespace }]);
        if (listResult.error) return listResult;
        const releases = Array.isArray(listResult.result) ? listResult.result : Array.isArray(listResult.result?.releases) ? listResult.result.releases : [];
        const found = releases.find((entry) => (entry.name || entry.release) === release);
        if (!found) return this._err(`Error: release: "${release}" not found`);
        return this._ok(
          [
            `NAME: ${release}`,
            `LAST DEPLOYED: ${found.updatedAt ? new Date(found.updatedAt).toISOString() : found.updated || 'just now'}`,
            `NAMESPACE: ${found.namespace || namespace}`,
            `STATUS: ${found.status || 'deployed'}`,
            `REVISION: ${found.revision || 1}`,
          ].join('\n'),
        );
      }
      default:
        return this._err(`error: unknown helm subcommand "${sub || ''}"\n\nValid subcommands: install, upgrade, list, uninstall, status`);
    }
  },

  _cmdHtpasswd(tokens) {
    let create = false;
    let batch = false;
    let remove = false;
    const positionals = [];
    for (const token of tokens) {
      if (/^-[A-Za-z]+$/.test(token)) {
        for (const char of token.slice(1)) {
          if (char === 'c') create = true;
          else if (char === 'b') batch = true;
          else if (char === 'D') remove = true;
          // -B (bcrypt), -n (stdout), -v (verify) are accepted and ignored
        }
        continue;
      }
      positionals.push(token);
    }
    const file = positionals[0] || 'htpasswd';
    const user = positionals[1];
    const password = positionals[2];
    if (!user) {
      return this._err('error: user is required\n\n  htpasswd [-c] [-b] <file> <user> [password]\n  htpasswd -D <file> <user>');
    }
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    if (remove) {
      const result = this._htpasswdCall('remove', user, undefined, file);
      if (result.error) return result;
      return this._ok('');
    }
    if (!password) {
      return this._err('error: password is required when using -b\n\n  htpasswd -c -b <file> <user> <password>');
    }
    const existingUsers = typeof me.htpasswdList === 'function' ? (() => {
      try {
        return me.htpasswdList(file) || [];
      } catch {
        return [];
      }
    })() : [];
    if (!create && existingUsers.includes(user) && typeof me.htpasswdUpdate === 'function') {
      const result = this._htpasswdCall('update', user, password, file);
      if (result.error) return result;
      return this._ok('');
    }
    if (create && typeof me.htpasswdList === 'function') {
      // `htpasswd -c <file>` truncates only the target file (never the cluster's
      // root htpasswd file when a custom path like users.htpasswd is used).
      try {
        const entries = me.htpasswdList(file);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const name = typeof entry === 'string' ? entry : entry?.user || entry?.name;
            if (name) me.htpasswdDelete?.(name, file);
          }
        }
      } catch {
        /* ignore */
      }
    }
    const result = this._htpasswdCall('add', user, password, file);
    if (result.error) return result;
    return this._ok('');
  },

  _cmdHelp(tokens) {
    const topic = tokens.map((token) => token.toLowerCase()).filter((token) => token && !token.startsWith('-'));
    const docs = `Documentation: ${OC_DOCS_URL}`;
    if (topic.length === 0) {
      const groups = [
        ['Basic Commands', ['login', 'logout', 'whoami', 'project', 'projects', 'new-project', 'status']],
        ['Querying Resources', ['get', 'describe', 'logs', 'events', 'explain', 'api-resources', 'extract']],
        ['Declarative Management', ['apply', 'create', 'replace', 'delete', 'edit', 'patch', 'label', 'annotate']],
        ['Deploy & Expose', ['new-app', 'new-build', 'start-build', 'cancel-build', 'expose', 'process', 'rollout', 'scale', 'set', 'run', 'exec', 'tag', 'import-image']],
        ['Security & Identity', ['auth', 'adm']],
        ['Files, Charts & Config', ['helm', 'htpasswd', 'config', 'version']],
        ['Help', ['help']],
      ];
      const lines = ['OpenShift Client — oc (OpenShift Games, OpenShift 4.22)', ''];
      for (const [heading, commands] of groups) {
        lines.push(`${heading}:`);
        for (const command of commands) {
          const entry = BASE_COMMANDS[command];
          if (!entry) continue;
          lines.push(`  ${command.padEnd(18)}${entry.summary}`);
        }
        lines.push('');
      }
      lines.push('Use "oc <command> --help" for more information about a given command.');
      lines.push('The "oc " prefix is optional in this terminal; commands can be typed with or without it.');
      lines.push(docs);
      return this._ok(lines.join('\n'));
    }

    const key = topic.join(' ');
    if (topic.length === 2 && SUBCOMMANDS[`${topic[0]} ${topic[1]}`]) {
      const commands = SUBCOMMANDS[`${topic[0]} ${topic[1]}`];
      return this._ok(
        [
          `${topic[0]} ${topic[1]} — available subcommands:`,
          '',
          ...commands.map((command) => `  ${command}`),
          '',
          `Run 'oc ${topic[0]} ${topic[1]} <subcommand> --help' for usage.`,
          docs,
        ].join('\n'),
      );
    }
    const subcommands = SUBCOMMANDS[topic[0]];
    if (subcommands) {
      return this._ok(
        [
          `${BASE_COMMANDS[topic[0]]?.summary || topic[0]}`,
          '',
          `Usage:\n  ${BASE_COMMANDS[topic[0]]?.usage || `oc ${topic[0]}`}`,
          '',
          'Available subcommands:',
          ...subcommands.map((command) => `  ${command}`),
          '',
          docs,
        ].join('\n'),
      );
    }
    const entry = BASE_COMMANDS[topic[0]];
    if (!entry) {
      return this._err(`error: unknown command "${topic[0]}" for "oc"\n\nRun 'oc --help' for usage.`);
    }
    const flags = COMMAND_FLAGS[topic[0]] || [];
    return this._ok(
      [
        entry.summary,
        '',
        'Usage:',
        `  ${entry.usage}`,
        '',
        ...(flags.length
          ? ['Flags:', `  ${flags.join(', ')}`, '']
          : []),
        'The "oc " prefix is optional in this terminal; commands can be typed with or without it.',
        docs,
      ].join('\n'),
    );
  },
});


// ────────────────────────────────────────────────────────────────────────────
// Follow-up wave 2: RBAC create flags, extract / set data, project config,
// bootstrap project template, oc edit teaching note.
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  /** Real-API-shaped dry-run rendering for flat kinds (Secret/ConfigMap). */
  _apiShapedDryRunObject(object) {
    const kind = object?.kind;
    const spec = object?.spec || {};
    const metadata = { ...(object?.metadata || {}) };
    delete metadata.namespace;
    if (kind === 'Secret') {
      const out = { apiVersion: 'v1', kind: 'Secret', metadata };
      if (object?.metadata?.namespace) out.metadata.namespace = object.metadata.namespace;
      out.type = spec.type || 'Opaque';
      if (spec.data && Object.keys(spec.data).length) out.data = { ...spec.data };
      if (spec.stringData && Object.keys(spec.stringData).length) out.stringData = { ...spec.stringData };
      if (spec.immutable !== undefined) out.immutable = spec.immutable;
      return out;
    }
    if (kind === 'ConfigMap') {
      const out = { apiVersion: 'v1', kind: 'ConfigMap', metadata };
      if (object?.metadata?.namespace) out.metadata.namespace = object.metadata.namespace;
      if (spec.data && Object.keys(spec.data).length) out.data = { ...spec.data };
      if (spec.binaryData && Object.keys(spec.binaryData).length) out.binaryData = { ...spec.binaryData };
      if (spec.immutable !== undefined) out.immutable = spec.immutable;
      return out;
    }
    return object;
  },

  // ── oc create role / clusterrole --verb --resource ─────────────────────

  _createRoleCommand(rest, flags, clusterWide) {
    const name = rest[0];
    const kindLabel = clusterWide ? 'clusterrole' : 'role';
    if (!name) {
      return this._usageError(
        'create',
        `name is required\n\n  oc create ${kindLabel} <name> --verb=<verb> --resource=<resource>[.<group>][/<subresource>] [--resource-name=<name>]`,
      );
    }
    const splitList = (values) =>
      this._arrayFlag(flags, values)
        .flatMap((entry) => String(entry).split(','))
        .map((entry) => entry.trim())
        .filter(Boolean);
    let verbs = splitList('verb');
    if (verbs.includes('*')) verbs = ['*'];
    else verbs = [...new Set(verbs)];
    const resources = splitList('resource');
    const resourceNames = this._arrayFlag(flags, 'resource-name').map((entry) => String(entry).trim()).filter(Boolean);
    if (!verbs.length) return this._err('error: at least one verb must be specified');
    if (!resources.length) return this._err('error: at least one resource must be specified');
    const defaultGroup = flags['api-group'] && flags['api-group'] !== true ? String(flags['api-group']) : '';
    /** @type {Map<string, {group: string, resources: string[]}>} */
    const byGroup = new Map();
    for (const token of resources) {
      const parsed = this._parseRbacResourceToken(token, defaultGroup);
      if (!byGroup.has(parsed.group)) byGroup.set(parsed.group, { group: parsed.group, resources: [] });
      const bucket = byGroup.get(parsed.group);
      if (!bucket.resources.includes(parsed.resource)) bucket.resources.push(parsed.resource);
    }
    const rules = [...byGroup.values()]
      .sort((left, right) => String(left.group).localeCompare(String(right.group)))
      .map((entry) => {
        const rule = { apiGroups: [entry.group], resources: entry.resources, verbs };
        if (resourceNames.length) rule.resourceNames = resourceNames;
        return rule;
      });
    const namespace = this._namespaceFromFlags(flags);
    const object = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: clusterWide ? 'ClusterRole' : 'Role',
      metadata: { name, ...(clusterWide ? {} : { namespace }) },
      rules,
    };
    return this._finishCreateObject(object, flags);
  },

  /**
   * Parse an `oc create role --resource` token into `{resource, group}` using
   * real oc semantics: `resource.group/subresource`, short names mapped to
   * resource plurals, subresources preserved.
   */
  _parseRbacResourceToken(token, defaultGroup = '') {
    const raw = String(token || '').trim();
    const slash = raw.indexOf('/');
    let base = slash >= 0 ? raw.slice(0, slash) : raw;
    const sub = slash >= 0 ? raw.slice(slash + 1) : '';
    let group = defaultGroup || '';
    if (base.includes('.')) {
      const dot = base.indexOf('.');
      group = base.slice(dot + 1) || group;
      base = base.slice(0, dot);
    }
    const kind = normalizeKind(base);
    let resource = kind ? String(pluralForKind(kind)).toLowerCase() : base.toLowerCase();
    if (sub) resource = `${resource}/${sub.toLowerCase()}`;
    return { resource, group };
  },

  // ── oc extract secret|configmap ────────────────────────────────────────

  _decodeBase64(text) {
    const raw = String(text ?? '');
    try {
      if (typeof atob === 'function') {
        const bytes = Uint8Array.from(atob(raw.replace(/\s+/g, '')), (char) => char.charCodeAt(0));
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
    return raw;
  },

  _cmdExtract(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'to', 'keys'],
      longBools: ['confirm'],
    });
    if (!positionals.length) {
      return this._err('error: you must specify at least one resource to extract\n\n  oc extract secret/<name> | configmap/<name> [--to=<dir>|-] [--keys=k1,k2] [--confirm]');
    }
    const first = String(positionals[0]);
    let kind = null;
    let name = null;
    if (isResourceRef(first)) {
      const ref = splitResourceRef(positionals);
      kind = ref.kind;
      name = ref.name;
    } else if (positionals.length > 1) {
      kind = normalizeKind(first);
      name = positionals[1];
    }
    if (!kind || !['Secret', 'ConfigMap'].includes(kind)) return this._resourceTypeError(first);
    if (!name) return this._usageError('extract', 'a resource name is required\n\n  oc extract secret/<name>');
    const namespace = this._namespaceFromFlags(flags);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const isSecret = kind === 'Secret';
    const allData = resource.spec?.data || resource.data || {};
    const onlyKeys = flags.keys && flags.keys !== true ? String(flags.keys).split(',').map((key) => key.trim()).filter(Boolean) : [];
    const keys = Object.keys(allData).filter((key) => onlyKeys.length === 0 || onlyKeys.includes(key));
    const decoded = (key) => (isSecret ? this._decodeBase64(allData[key]) : String(allData[key] ?? ''));
    const target = flags.to && flags.to !== true ? String(flags.to) : '.';
    if (target === '-') {
      const blocks = keys.map((key) => {
        const content = decoded(key);
        return `# ${key}\n${content}${content.endsWith('\n') ? '' : '\n'}`;
      });
      return this._ok(blocks.join(''));
    }
    const written = [];
    for (const key of keys) {
      const path = target === '.' ? key : `${target.replace(/\/+$/, '')}/${key}`;
      if (!flags.confirm && this._readVirtualFile(path) !== null) {
        return this._err(`error: ${key}: file exists, pass --confirm to overwrite`);
      }
      const result = this._writeVirtualFile(path, decoded(key));
      if (result.error) return result;
      written.push(path);
    }
    return this._ok(written.join('\n'));
  },

  // ── oc set data secret|configmap ───────────────────────────────────────

  _sortedDataString(data) {
    return Object.keys(data || {})
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join('\n');
  },

  _oauthResource() {
    try {
      return this._resources('OAuth').find((resource) => resource.metadata?.name === 'cluster') || null;
    } catch {
      return null;
    }
  },

  _isOAuthHtpasswdSecret(resource) {
    if (!resource) return false;
    const name = resource.metadata?.name;
    const namespace = resource.metadata?.namespace;
    if (namespace !== 'openshift-config') return false;
    if (name === 'htpasswd-secret') return true;
    const oauth = this._oauthResource();
    return (oauth?.spec?.identityProviders || []).some(
      (provider) => provider.type === 'HTPasswd' && provider.htpasswd?.fileData?.name === name,
    );
  },

  /** Simulated authentication rollout: bump OAuth so the 5s rollout fires. */
  _triggerOAuthRollout() {
    const oauth = this._oauthResource();
    if (!oauth) return;
    try {
      oauth._bumpResourceVersion?.();
    } catch {
      /* best-effort */
    }
    try {
      const uid = oauth.metadata?.uid || oauth.uid;
      if (uid && typeof this.cluster?.update === 'function') this.cluster.update(uid, oauth);
      else if (typeof this.cluster?.update === 'function') this.cluster.update(oauth, oauth);
    } catch {
      /* the next simulation tick still re-reads the spec */
    }
  },

  _setData(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'from-file', 'from-literal'],
      multi: ['from-file', 'from-literal'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!['Secret', 'ConfigMap'].includes(kind)) {
      return this._err(`error: the object is not a config map or secret and cannot have data updated: ${kind}`);
    }
    if (!name) {
      return this._usageError('set', 'resource name is required\n\n  oc set data secret/<name> KEY=VALUE  |  KEY-  |  --from-file=KEY=PATH');
    }
    const namespace = this._namespaceFromFlags(flags);
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const isSecret = kind === 'Secret';
    const current = { ...(resource.spec?.data || resource.data || {}) };
    const next = { ...current };
    const start = positionals[0].includes('/') ? 1 : 2;
    for (const entry of positionals.slice(start)) {
      const token = String(entry);
      if (token.endsWith('-') && !token.includes('=')) {
        delete next[token.slice(0, -1)];
        continue;
      }
      const eq = token.indexOf('=');
      if (eq <= 0) return this._err(`error: invalid data update "${token}" (expected KEY=VALUE or KEY-)`);
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      next[key] = isSecret ? this._base64(value) : value;
    }
    for (const entry of this._arrayFlag(flags, 'from-file')) {
      const text = String(entry);
      const eq = text.indexOf('=');
      const key = eq >= 0 ? text.slice(0, eq) : this._basename(text);
      const path = eq >= 0 ? text.slice(eq + 1) : text;
      const content = this._readVirtualFile(path);
      if (content === null) return this._err(`error: open ${path}: no such file or directory`);
      next[key] = isSecret ? this._base64(content) : content;
    }
    for (const entry of this._arrayFlag(flags, 'from-literal')) {
      const text = String(entry);
      const eq = text.indexOf('=');
      if (eq <= 0) return this._err(`error: invalid literal "${text}" (expected KEY=VALUE)`);
      const key = text.slice(0, eq);
      const value = text.slice(eq + 1);
      next[key] = isSecret ? this._base64(value) : value;
    }
    if (Object.keys(next).length === 0 && Object.keys(current).length === 0) {
      return this._err('error: must add, update, or remove at least one key from this object');
    }
    // Simulated authentication plumbing: the htpasswd identity provider reads
    // the virtual root `htpasswd` file, so sync it whenever the OAuth backing
    // secret carries a `htpasswd` key (even when the secret data is unchanged).
    const syncHtpasswd = isSecret && next.htpasswd !== undefined && this._isOAuthHtpasswdSecret(resource);
    const decodedHtpasswd = syncHtpasswd ? this._decodeBase64(next.htpasswd) : null;
    const rootHtpasswdBefore = syncHtpasswd ? this._readVirtualFile('htpasswd') : null;
    if (this._sortedDataString(next) === this._sortedDataString(current)) {
      if (syncHtpasswd && decodedHtpasswd !== rootHtpasswdBefore) {
        this._writeVirtualFile('htpasswd', decodedHtpasswd);
        this._triggerOAuthRollout();
      }
      return this._ok(`info: ${name} was not changed`);
    }
    const updated = this._updateResource(
      kind,
      name,
      (spec) => {
        spec.data = { ...next };
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) },
    );
    if (updated.error) return updated.error;
    // Insert/remove exactly: ClusterState.update deep-merges spec maps, which
    // would keep removed keys; replace the data map on the resource directly.
    const target = updated.resource;
    if (target) {
      target.spec = target.spec || {};
      target.spec.data = { ...next };
      try {
        this.cluster?.update?.(target.metadata?.uid || target.uid, target);
      } catch {
        /* best-effort; the in-memory resource already carries the new data */
      }
    }
    // Real password-rotation flow: replace/update the htpasswd secret in
    // openshift-config and the authentication operator rolls out (~5s), after
    // which the new password works. Mirror the file + bump the OAuth singleton.
    if (syncHtpasswd) {
      this._writeVirtualFile('htpasswd', decodedHtpasswd);
      if (rootHtpasswdBefore !== decodedHtpasswd) this._triggerOAuthRollout();
    }
    return this._ok(`${this._resourceRef(kind)}/${name} data updated`);
  },

  // ── oc adm create-bootstrap-project-template ───────────────────────────

  _bootstrapProjectTemplate(name = 'project-request') {
    const param = (paramName) => ({ name: paramName });
    return {
      apiVersion: 'template.openshift.io/v1',
      kind: 'Template',
      metadata: { name },
      parameters: ['PROJECT_NAME', 'PROJECT_DISPLAYNAME', 'PROJECT_DESCRIPTION', 'PROJECT_ADMIN_USER', 'PROJECT_REQUESTING_USER'].map(param),
      objects: [
        {
          apiVersion: 'project.openshift.io/v1',
          kind: 'Project',
          metadata: {
            name: '${PROJECT_NAME}',
            creationTimestamp: null,
            annotations: {
              'openshift.io/description': '${PROJECT_DESCRIPTION}',
              'openshift.io/display-name': '${PROJECT_DISPLAYNAME}',
              'openshift.io/requester': '${PROJECT_REQUESTING_USER}',
            },
          },
          spec: { finalizers: [] },
          status: { phase: '' },
        },
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'RoleBinding',
          metadata: { name: 'admin', namespace: '${PROJECT_NAME}', creationTimestamp: null },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
          subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: '${PROJECT_ADMIN_USER}' }],
        },
      ],
    };
  },

  _admCreateBootstrapProjectTemplate(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-o': 'output' },
      longValues: ['output', 'name'],
    });
    if (positionals.length) return this._err('error: no arguments are supported');
    const name = flags.name && flags.name !== true ? String(flags.name) : 'project-request';
    if (!name) return this._err('error: --name must be provided');
    const template = this._bootstrapProjectTemplate(name);
    const output = this._outputFormat(flags);
    if (output.format === 'yaml') return this._ok(toYamlDocument(template));
    if (output.format === 'name') return this._ok(`template.template.openshift.io/${name}`);
    // Real `oc adm create-bootstrap-project-template` defaults to JSON.
    return this._ok(JSON.stringify(template, null, 4));
  },

  // ── project.config.openshift.io/cluster singleton ──────────────────────

  _isProjectConfigToken(token) {
    return ['project.config.openshift.io', 'projects.config.openshift.io', 'project.config', 'projects.config'].includes(
      String(token || '').toLowerCase(),
    );
  },

  _projectConfigRef(positionals) {
    const first = String(positionals[0] || '');
    const slash = first.indexOf('/');
    const base = (slash >= 0 ? first.slice(0, slash) : first).toLowerCase();
    if (!this._isProjectConfigToken(base)) return null;
    const name = slash >= 0 ? first.slice(slash + 1) : positionals[1] ? String(positionals[1]) : 'cluster';
    return { name: name || 'cluster' };
  },

  _projectConfigObject() {
    let raw = null;
    try {
      if (this.gameEngine && typeof this.gameEngine.getProjectConfig === 'function') raw = this.gameEngine.getProjectConfig();
    } catch {
      raw = null;
    }
    if (!raw) {
      try {
        raw = this.cluster?.projectConfig || null;
      } catch {
        raw = null;
      }
    }
    const object = {
      apiVersion: 'config.openshift.io/v1',
      kind: 'Project',
      metadata: { name: 'cluster' },
      spec: {},
    };
    if (raw && typeof raw === 'object') {
      if (raw.spec !== undefined || raw.kind || raw.apiVersion) {
        object.apiVersion = raw.apiVersion || object.apiVersion;
        object.kind = raw.kind || object.kind;
        object.metadata = { ...(raw.metadata || {}), name: 'cluster' };
        object.spec = raw.spec && typeof raw.spec === 'object' ? JSON.parse(JSON.stringify(raw.spec)) : {};
        if (raw.status) object.status = JSON.parse(JSON.stringify(raw.status));
      } else {
        object.spec = JSON.parse(JSON.stringify(raw));
      }
    }
    return object;
  },

  _getProjectConfigView({ name, flags, output }) {
    const requested = name || 'cluster';
    if (requested !== 'cluster') {
      return this._err(`Error from server (NotFound): projects.config.openshift.io "${requested}" not found`);
    }
    const object = this._projectConfigObject();
    if (output.format === 'json') return this._ok(JSON.stringify(object, null, 4));
    if (output.format === 'yaml') return this._ok(toYamlDocument(object));
    if (output.format === 'name') return this._ok('project.config.openshift.io/cluster');
    return this._ok(padTable(['NAME', 'AGE'], [['cluster', this._creationAge(object)]]));
  },

  _describeProjectConfig() {
    const object = this._projectConfigObject();
    const specYaml = toYamlDocument(object.spec || {})
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return this._ok(
      [
        'Name:         cluster',
        `ApiVersion:   ${object.apiVersion}`,
        `Kind:         ${object.kind}`,
        'Labels:       <none>',
        'Annotations:  <none>',
        '',
        'Spec:',
        specYaml || '  {}',
      ].join('\n'),
    );
  },

  /** Deep-merge a patch object into a target (used by project config patches). */
  _mergeSpecValue(target, patch) {
    const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = this._mergeSpecValue(out[key], value);
      else out[key] = value;
    }
    return out;
  },

  /** Apply JSON-patch operations (add/replace/remove) to an object. */
  _applyJsonPatchOps(object, operations) {
    const clone = JSON.parse(JSON.stringify(object || {}));
    const unescape = (segment) => String(segment).replace(/~1/g, '/').replace(/~0/g, '~');
    for (const operation of operations || []) {
      const op = String(operation?.op || '').toLowerCase();
      const segments = String(operation?.path || '').split('/').filter(Boolean).map(unescape);
      if (!segments.length) return { error: 'error: json patch path must not be empty' };
      let parent = clone;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (parent[segment] === undefined || parent[segment] === null) parent[segment] = /^\d+$/.test(segments[i + 1]) ? [] : {};
        parent = parent[segment];
      }
      const key = segments[segments.length - 1];
      if (op === 'remove') {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
      } else if (op === 'add' || op === 'replace') {
        if (Array.isArray(parent)) {
          if (key === '-') parent.push(operation.value);
          else parent[Number(key)] = operation.value;
        } else {
          parent[key] = operation.value;
        }
      } else {
        return { error: `error: unsupported JSON patch operation "${operation?.op}"` };
      }
    }
    return { object: clone };
  },

  _patchProjectConfig(projectConfigRef, flags) {
    const patchText = flags.patch;
    if (!patchText || patchText === true) return this._err('error: must specify -p <patch>');
    let patch;
    try {
      patch = JSON.parse(String(patchText));
    } catch (error) {
      return this._err(`error: unable to parse patch: ${error.message}`);
    }
    const patchType = flags.type && flags.type !== true ? String(flags.type) : 'strategic';
    if (!['merge', 'strategic', 'json'].includes(patchType)) {
      return this._err(`error: --type must be one of merge, strategic, json`);
    }
    if (patchType === 'json' && !Array.isArray(patch)) {
      return this._err('error: json patch must be an array of JSON patch operations');
    }
    if (patchType !== 'json' && Array.isArray(patch)) {
      return this._err(`error: cannot use --type=${patchType} with a JSON patch array`);
    }
    const dryRun = Boolean(flags['dry-run']);
    if (dryRun) return this._ok('project.config.openshift.io/cluster patched (dry run)');
    let specPatch;
    if (patchType === 'json') {
      const applied = this._applyJsonPatchOps(this._projectConfigObject(), patch);
      if (applied.error) return this._err(applied.error);
      specPatch = applied.object.spec || {};
    } else {
      specPatch = patch && patch.spec && typeof patch.spec === 'object' ? patch.spec : {};
    }
    if (specPatch && Object.keys(specPatch).length) {
      const ge = this.gameEngine;
      if (ge && typeof ge.updateProjectConfig === 'function') {
        const result = ge.updateProjectConfig(specPatch);
        if (result && result.success === false) return this._err(result.message || 'error: project config patch failed');
      } else {
        const current = this._projectConfigObject();
        this.cluster.projectConfig = { ...current, spec: this._mergeSpecValue(current.spec, specPatch) };
      }
    }
    return this._ok('project.config.openshift.io/cluster patched');
  },

  _editProjectConfig() {
    const object = this._projectConfigObject();
    this._emit('ui:manifest-editor', { kind: 'Project', name: 'cluster', namespace: '', resource: object });
    const panel = this.game?.manifestPanel;
    if (panel && typeof panel.show === 'function') {
      try {
        panel.show(object);
        return this._ok(`Opening the manifest editor for project.config.openshift.io/cluster in the Files panel. Save to apply changes.\n${EDIT_TEACHING_LINE}`);
      } catch {
        /* fall through to YAML output */
      }
    }
    this._emit('ui:edit-resource', { kind: 'Project', name: 'cluster', namespace: '', resource: object });
    return this._ok(`${toYamlDocument(object)}\n${EDIT_TEACHING_LINE}\n(No manifest editor is available — edit this object and apply it with oc apply -f -.)`);
  },
});

export default CommandBar;

// ===CHUNK_SENTINEL===












