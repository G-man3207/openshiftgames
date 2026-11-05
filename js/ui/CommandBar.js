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
import { deploymentReplicaSetName } from '../engine/TemplateHash.js';
import {
  validateCronSchedule,
  visibleAnnotations,
  visibleFinalizers,
  isInternalMetadataKey,
  describeEventLines,
  estimateJobRuntimeSeconds,
} from '../resources/WorkloadResources.js';
import { ShellTools, SHELL_COMMANDS, SHELL_FILE_COMMANDS } from './ShellTools.js';

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
export const OC_DOCS_URL =
  'https://docs.redhat.com/en/documentation/openshift_container_platform/4.22';
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

/**
 * Effects a taint may carry (Kubernetes core/v1 TaintEffect): `oc adm taint` /
 * `kubectl taint` reject anything else when parsing `key[=value]:effect` (#58).
 */
const VALID_TAINT_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'];

/**
 * The `openshift-dns/dns-default` ClusterIP on a real OCP install — the
 * nameserver every Pod's `/etc/resolv.conf` lists. Derived from the seeded
 * Service object at runtime; this is the documented 4.22 fallback (#58).
 */
const CLUSTER_DNS_SERVICE_IP = '172.30.0.10';

/** Top-level command catalog: completion + help. */
export const BASE_COMMANDS = {
  login: {
    summary: 'Log in to a server',
    usage: 'oc login [--username=<user>] [--password=<pass>] [server]',
  },
  logout: { summary: 'Log out of the current session', usage: 'oc logout' },
  whoami: { summary: 'Return the current user', usage: 'oc whoami' },
  project: {
    summary: 'Switch to another project',
    usage: 'oc project [<project>] [-q]  # -q prints only the project name',
  },
  projects: { summary: 'Display existing projects', usage: 'oc projects' },
  'new-project': {
    summary: 'Create a new project and switch to it',
    usage: 'oc new-project <name> [--display-name=] [--description=]',
  },
  status: { summary: 'Show an overview of the current project', usage: 'oc status [-n <project>]' },
  get: {
    summary: 'Display one or many resources',
    usage:
      'oc get <resource> [<name>] [-n <project>] [-A] [-o wide|yaml|json|name|jsonpath=...|custom-columns=...]',
  },
  describe: {
    summary: 'Show details of a specific resource or group of resources',
    usage: 'oc describe <resource> [<name>] [-l <selector>]',
  },
  logs: {
    summary: 'Print the logs for a container, build or deployment',
    usage:
      'oc logs <pod|deployment/name|build/name|bc/name> [-f] [--previous] [-c <container>] [--tail=<n>]',
  },
  events: {
    summary: 'List recent events in the current project',
    usage: 'oc events [-n <project>] [--field-selector=...]',
  },
  explain: { summary: 'Document fields of a resource', usage: 'oc explain <resource>[.<field>]' },
  create: {
    summary: 'Create a resource from a file or from stdin, or create a resource by name',
    usage: 'oc create <resource> <name> [flags]  |  oc create -f <file> [-n <project>]',
  },
  apply: {
    summary: 'Apply a configuration to a resource by file name or stdin',
    usage: 'oc apply -f <file>  |  oc apply -k <directory>',
  },
  replace: { summary: 'Replace a resource by file name or stdin', usage: 'oc replace -f <file>' },
  delete: {
    summary: 'Delete resources by file names, stdin, or resource names',
    usage: 'oc delete <resource> <name>  |  oc delete -f <file>  |  oc delete -k <dir>',
  },
  scale: {
    summary: 'Set a new size for a deployment, replica set or stateful set',
    usage: 'oc scale <resource>/<name> --replicas=<count>',
  },
  edit: { summary: 'Edit a resource in the manifest editor', usage: 'oc edit <resource>/<name>' },
  label: {
    summary: 'Update the labels on a resource',
    usage: 'oc label <resource>/<name> <key>=<value> [--overwrite]',
  },
  annotate: {
    summary: 'Update the annotations on a resource',
    usage: 'oc annotate <resource>/<name> <key>=<value> [--overwrite]',
  },
  patch: {
    summary: 'Update fields of a resource using a JSON patch',
    usage: "oc patch <resource>/<name> -p '<json>' [--type=merge|strategic|json]",
  },
  set: {
    summary: 'Set specific features on objects (env, image, resources, probes, data, ...)',
    usage: 'oc set <env|image|resources|probe|serviceaccount|triggers|selector|volumes|data> ...',
  },
  rollout: {
    summary: 'Manage the rollout of a resource',
    usage:
      'oc rollout <status|history|undo|restart|pause|resume> <resource>/<name> [--timeout=<duration>]',
  },
  expose: {
    summary: 'Expose a replicated application as a Route',
    usage: 'oc expose <svc|deployment>/<name> [--name=] [--hostname=] [--path=]',
  },
  run: {
    summary: 'Run a particular image in a pod',
    usage: 'oc run <name> --image=<image> [--port=]',
  },
  exec: { summary: 'Execute a command in a container', usage: 'oc exec -it <pod> -- <command>' },
  tag: {
    summary: 'Tag existing images into image streams',
    usage: 'oc tag <source> <destination> [--scheduled]',
  },
  'import-image': {
    summary: 'Import images from an external registry into an image stream',
    usage: 'oc import-image <imagestream>:<tag> --from=<image> --confirm',
  },
  extract: {
    summary: 'Extract secrets or config maps to disk',
    usage: 'oc extract secret/<name> | configmap/<name> [--to=<dir>|-] [--keys=k1,k2] [--confirm]',
  },
  'new-app': {
    summary: 'Create an application from source code or an image',
    usage: 'oc new-app <image|git-url> [--name=] | --template=<name> [-p K=V] | -f <file>',
  },
  'new-build': {
    summary: 'Create a new build configuration',
    usage: 'oc new-build <image-stream> --name=<bc> [--code=<git-url>]',
  },
  'start-build': {
    summary: 'Start a new build',
    usage: 'oc start-build <buildconfig> [--follow] [--from-dir=.]',
  },
  'cancel-build': {
    summary: 'Cancel running, pending or new builds',
    usage: 'oc cancel-build <buildconfig>',
  },
  process: {
    summary: 'Process a template into the objects it defines',
    usage: 'oc process -f <file> [-p K=V] [-o yaml|json]  |  oc process <template-name>',
  },
  kustomize: {
    summary: 'Build a kustomization target from a directory or URL',
    usage: 'oc kustomize [directory]',
  },
  adm: {
    summary: 'Administrative commands (policy, groups, nodes, top, templates, must-gather)',
    usage:
      'oc adm <policy|groups|cordon|uncordon|drain|taint|top|create-bootstrap-project-template|must-gather|inspect> ...',
  },
  auth: {
    summary: 'Inspect authorization',
    usage: 'oc auth can-i <verb> <resource> [--as=<user>] [--list]',
  },
  debug: {
    summary: 'Launch a debug shell for a node or workload',
    usage: 'oc debug <node|deployment>/<name>',
  },
  helm: {
    summary: 'Install and manage Helm charts (OpenShift Helm support)',
    usage: 'helm install|upgrade|list|uninstall|history|rollback|repo|search ...',
  },
  policy: {
    summary: 'Manage authorization policy',
    usage:
      'oc policy add-role-to-user <role> <user> [-n <project>]  |  oc policy add-role-to-group ...',
  },
  image: {
    summary: 'Useful commands for managing images',
    usage: 'oc image info <image> [-o json]',
  },
  rsh: {
    summary: 'Start a shell session in a container',
    usage: 'oc rsh [-c <container>] (POD | TYPE/NAME) [COMMAND]',
  },
  cp: {
    summary: 'Copy files between a local filesystem and a pod',
    usage: 'oc cp <local-path> <pod>:<path>  |  oc cp <pod>:<path> <local-path>',
  },
  wait: {
    summary: 'Experimental: Wait for a specific condition on one or many resources',
    usage: 'oc wait --for=condition=Ready pod/<name> --timeout=60s',
  },
  diff: {
    summary: 'Diff the live version against a would-be applied version',
    usage: 'oc diff -f <file> [-n <project>]',
  },
  autoscale: {
    summary: 'Autoscale a deployment, replica set, replication controller or stateful set',
    usage: 'oc autoscale <resource>/<name> --min=<n> --max=<n> [--cpu-percent=<percent>]',
  },
  htpasswd: {
    summary: 'Manage the virtual HTPasswd identity-provider file',
    usage: 'htpasswd [-c] [-b] [-B] [-D] <file> <user> [password]  # -B writes bcrypt ($2y$…)',
  },
  config: {
    summary: 'Modify kubeconfig files (contexts)',
    usage: 'oc config <current-context|view|get-contexts>',
  },
  version: { summary: 'Print the client and server versions', usage: 'oc version' },
  'api-resources': {
    summary: 'Print the supported API resources on the server',
    usage: 'oc api-resources',
  },
  help: { summary: 'Help about any command', usage: 'oc help [command]' },
  // Backwards-compatible bare forms (the game historically accepted these).
  cordon: {
    summary: 'Mark a node as unschedulable (alias of oc adm cordon)',
    usage: 'oc adm cordon <node>',
  },
  uncordon: {
    summary: 'Mark a node as schedulable (alias of oc adm uncordon)',
    usage: 'oc adm uncordon <node>',
  },
  drain: { summary: 'Drain a node (alias of oc adm drain)', usage: 'oc adm drain <node>' },
  top: {
    summary: 'Display resource usage (alias of oc adm top)',
    usage: 'oc adm top <pods|nodes>',
  },
};

/** Commands that mutate cluster state (used for auth-check telemetry). */
const MUTATING_COMMANDS = new Set([
  'create',
  'apply',
  'replace',
  'delete',
  'scale',
  'edit',
  'label',
  'annotate',
  'patch',
  'set',
  'rollout',
  'expose',
  'run',
  'exec',
  'tag',
  'import-image',
  'new-app',
  'new-build',
  'start-build',
  'cancel-build',
  'process',
  'adm',
  'login',
  'logout',
  'new-project',
  'htpasswd',
  'policy',
  'autoscale',
  'cp',
  'rsh',
]);

/** Virtual `oc get` views implemented locally that still target a namespace. */
const NAMESPACED_VIRTUAL_GET_TOKENS = new Set([
  'csv',
  'csvs',
  'clusterserviceversion',
  'clusterserviceversions',
  'operatorgroup',
  'operatorgroups',
  'og',
  'istag',
  'istags',
  'imagestreamtag',
  'imagestreamtags',
  'endpoints',
  'endslices',
  'endpointslices',
  'ep',
]);

/** Namespace-scoped completion subcommands. */
const SUBCOMMANDS = {
  set: [
    'env',
    'image',
    'resources',
    'probe',
    'serviceaccount',
    'triggers',
    'selector',
    'volumes',
    'volume',
    'data',
  ],
  adm: [
    'policy',
    'groups',
    'cordon',
    'uncordon',
    'drain',
    'taint',
    'top',
    'create-bootstrap-project-template',
    'must-gather',
    'inspect',
  ],
  'adm policy': [
    'add-role-to-user',
    'add-role-to-group',
    'add-cluster-role-to-user',
    'add-cluster-role-to-group',
    'remove-role-from-user',
    'remove-role-from-group',
    'remove-cluster-role-from-user',
    'remove-cluster-role-from-group',
    'add-scc-to-user',
    'add-scc-to-group',
    'remove-scc-from-user',
    'remove-scc-from-group',
    'who-can',
    'scc-review',
    'scc-subject-review',
  ],
  'adm groups': ['new', 'add-users', 'remove-users'],
  auth: ['can-i'],
  rollout: ['status', 'history', 'undo', 'restart', 'pause', 'resume'],
  expose: ['svc', 'service', 'deployment', 'deploy'],
  create: [
    'route',
    'secret',
    'configmap',
    'deployment',
    'service',
    'quota',
    'limitrange',
    'clusterquota',
    'user',
    'group',
    'serviceaccount',
    'rolebinding',
    'clusterrolebinding',
    'role',
    'clusterrole',
    'job',
    'cronjob',
    'project',
    'namespace',
    'template',
    'token',
  ],
  'create route': ['edge', 'passthrough', 'reencrypt'],
  'create secret': ['generic', 'tls', 'docker-registry'],
  'create service': ['clusterip', 'nodeport', 'loadbalancer', 'externalname'],
  config: ['current-context', 'view', 'get-contexts', 'use-context'],
  helm: [
    'install',
    'upgrade',
    'list',
    'uninstall',
    'status',
    'history',
    'rollback',
    'repo',
    'search',
  ],
  'helm repo': ['add', 'list', 'remove', 'update'],
  policy: [
    'add-role-to-user',
    'add-role-to-group',
    'remove-role-from-user',
    'remove-role-from-group',
    'remove-user-from-project',
    'remove-group-from-project',
    'who-can',
    'scc-review',
    'scc-subject-review',
  ],
  image: ['info'],
};

/** Flag completion hints per base command. */
const COMMAND_FLAGS = {
  get: [
    '-n',
    '--namespace',
    '-A',
    '--all-namespaces',
    '-o',
    '--output',
    '-l',
    '--selector',
    '--field-selector',
    '--sort-by',
    '--show-labels',
    '--no-headers',
    '-w',
    '--watch',
    '--raw',
  ],
  describe: ['-n', '--namespace', '--show-events'],
  logs: [
    '-n',
    '--namespace',
    '-f',
    '--follow',
    '--previous',
    '-c',
    '--container',
    '--tail',
    '--since',
    '--timestamps',
  ],
  create: [
    '-f',
    '--filename',
    '-n',
    '--namespace',
    '--image',
    '--replicas',
    '--dry-run',
    '-o',
    '--output',
    '-l',
    '--labels',
    '--verb',
    '--resource',
    '--resource-name',
    '--api-group',
    '--schedule',
    '--restart',
  ],
  apply: [
    '-f',
    '--filename',
    '-k',
    '--kustomize',
    '-n',
    '--namespace',
    '--dry-run',
    '--overwrite',
    '--validate',
  ],
  delete: [
    '-f',
    '--filename',
    '-k',
    '--kustomize',
    '-n',
    '--namespace',
    '-l',
    '--selector',
    '--all',
    '--force',
    '--grace-period',
  ],
  scale: ['--replicas', '--current-replicas', '--resource-version', '-n', '--namespace'],
  set: [
    '-n',
    '--namespace',
    '-c',
    '--containers',
    '--all',
    '--overwrite',
    '-e',
    '--env',
    '--from',
    '--prefix',
    '--remove',
    '--list',
    '--limits',
    '--requests',
    '--liveness',
    '--readiness',
    '--get-url',
    '--open-tcp',
    '--add',
    '--name',
    '-m',
    '--mount-path',
    '--sub-path',
    '-t',
    '--type',
    '--claim-name',
    '--claim-size',
    '--claim-mode',
    '--claim-class',
    '--configmap-name',
    '--secret-name',
    '--read-only',
    '--default-mode',
    '--from-file',
    '--from-literal',
  ],
  extract: ['-n', '--namespace', '--to', '--keys', '--confirm'],
  'new-app': [
    '--name',
    '--image',
    '--image-stream',
    '--code',
    '--template',
    '-f',
    '--file',
    '-e',
    '--env',
    '-p',
    '--param',
    '--context-dir',
    '--source-secret',
    '-n',
    '--namespace',
    '--strategy',
    '--build',
  ],
  'new-build': [
    '--name',
    '--code',
    '--image-stream',
    '--strategy',
    '--context-dir',
    '-n',
    '--namespace',
  ],
  'start-build': [
    '-F',
    '--follow',
    '--from-dir',
    '--from-file',
    '--env',
    '--commit',
    '--wait',
    '--no-cache',
    '-n',
    '--namespace',
  ],
  expose: [
    '--name',
    '--hostname',
    '--path',
    '--port',
    '--selector',
    '--internal',
    '--wildcard-policy',
    '-n',
    '--namespace',
  ],
  run: [
    '--image',
    '--port',
    '--restart',
    '--env',
    '--labels',
    '--serviceaccount',
    '-n',
    '--namespace',
  ],
  patch: ['-p', '--patch', '--type', '--dry-run', '-n', '--namespace'],
  label: ['--overwrite', '--all', '-l', '--selector', '-n', '--namespace'],
  annotate: ['--overwrite', '--all', '-l', '--selector', '-n', '--namespace'],
  rollout: ['--to-revision', '--dry-run', '-w', '--watch', '-n', '--namespace'],
  adm: [
    '-n',
    '--namespace',
    '-z',
    '--serviceaccount',
    '--rolebinding-name',
    '--clusterrole',
    '--role',
    '--user',
    '--group',
    '--hard',
    '--project-label-selector',
    '--force',
    '--ignore-daemonsets',
    '--delete-emptydir-data',
  ],
  auth: ['--as', '--as-group', '--list', '-n', '--namespace'],
  process: [
    '-f',
    '--filename',
    '-p',
    '--param',
    '-o',
    '--output',
    '--parameters',
    '--param-file',
    '-n',
    '--namespace',
  ],
  'import-image': ['--from', '--confirm', '--all', '--scheduled', '-n', '--namespace'],
  tag: ['--scheduled', '--reference-policy', '--source', '-n', '--namespace'],
  login: ['-u', '--username', '-p', '--password', '--server', '--token'],
  policy: ['-n', '--namespace', '-z', '--serviceaccount', '--rolebinding-name'],
  image: ['-o', '--output', '--filter-by-os', '--dir', '--registry-config', '--insecure'],
  rsh: ['-c', '--container', '-n', '--namespace', '-t', '--tty', '-T', '--no-tty', '--shell'],
  cp: ['-c', '--container', '-n', '--namespace', '--no-preserve', '--retries'],
  wait: ['--for', '--timeout', '-n', '--namespace', '-l', '--selector', '--all'],
  diff: ['-f', '--filename', '-n', '--namespace', '--server-side', '--field-manager'],
  autoscale: ['--min', '--max', '--cpu-percent', '--name', '-n', '--namespace', '--dry-run'],
  helm: [
    '-n',
    '--namespace',
    '-f',
    '--values',
    '--set',
    '--version',
    '--repo',
    '--dry-run',
    '--wait',
    '--atomic',
    '--history-max',
  ],
};

/** Plural resource names (used in completion, output and error messages). */
const KIND_PLURALS = {
  Project: 'projects',
  Node: 'nodes',
  ClusterResourceQuota: 'clusterresourcequotas',
  Pod: 'pods',
  Deployment: 'deployments',
  ReplicaSet: 'replicasets',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
  BuildConfig: 'buildconfigs',
  Build: 'builds',
  ImageStream: 'imagestreams',
  Service: 'services',
  Route: 'routes',
  Ingress: 'ingresses',
  NetworkPolicy: 'networkpolicies',
  IPAddressPool: 'ipaddresspools',
  L2Advertisement: 'l2advertisements',
  ConfigMap: 'configmaps',
  Secret: 'secrets',
  LimitRange: 'limitranges',
  ResourceQuota: 'resourcequotas',
  Template: 'templates',
  PersistentVolume: 'persistentvolumes',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  StorageClass: 'storageclasses',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers',
  PodDisruptionBudget: 'poddisruptionbudgets',
  ServiceAccount: 'serviceaccounts',
  Role: 'roles',
  ClusterRole: 'clusterroles',
  RoleBinding: 'rolebindings',
  ClusterRoleBinding: 'clusterrolebindings',
  SecurityContextConstraints: 'securitycontextconstraints',
  User: 'users',
  Group: 'groups',
  Identity: 'identities',
  OAuth: 'oauths',
  Subscription: 'subscriptions',
  ClusterOperator: 'clusteroperators',
  ClusterVersion: 'clusterversions',
};

/** Singular `kind.group` form used by oc in create/delete/error messages. */
const KIND_REF_NAMES = {
  Project: 'project.project.openshift.io',
  Node: 'node',
  ClusterResourceQuota: 'clusterresourcequota.quota.openshift.io',
  Pod: 'pod',
  Deployment: 'deployment.apps',
  ReplicaSet: 'replicaset.apps',
  StatefulSet: 'statefulset.apps',
  DaemonSet: 'daemonset.apps',
  Job: 'job.batch',
  CronJob: 'cronjob.batch',
  BuildConfig: 'buildconfig.build.openshift.io',
  Build: 'build.build.openshift.io',
  ImageStream: 'imagestream.image.openshift.io',
  Service: 'service',
  Route: 'route.route.openshift.io',
  Ingress: 'ingress.networking.k8s.io',
  NetworkPolicy: 'networkpolicy.networking.k8s.io',
  IPAddressPool: 'ipaddresspool.metallb.io',
  L2Advertisement: 'l2advertisement.metallb.io',
  ConfigMap: 'configmap',
  Secret: 'secret',
  LimitRange: 'limitrange',
  ResourceQuota: 'resourcequota',
  Template: 'template.template.openshift.io',
  PersistentVolume: 'persistentvolume',
  PersistentVolumeClaim: 'persistentvolumeclaim',
  StorageClass: 'storageclass.storage.k8s.io',
  HorizontalPodAutoscaler: 'horizontalpodautoscaler.autoscaling',
  PodDisruptionBudget: 'poddisruptionbudget.policy',
  ServiceAccount: 'serviceaccount',
  Role: 'role.rbac.authorization.k8s.io',
  ClusterRole: 'clusterrole.rbac.authorization.k8s.io',
  RoleBinding: 'rolebinding.rbac.authorization.k8s.io',
  ClusterRoleBinding: 'clusterrolebinding.rbac.authorization.k8s.io',
  SecurityContextConstraints: 'securitycontextconstraints.security.openshift.io',
  User: 'user.user.openshift.io',
  Group: 'group.user.openshift.io',
  Identity: 'identity.user.openshift.io',
  OAuth: 'oauth.config.openshift.io',
  Subscription: 'subscription.operators.coreos.com',
  ClusterOperator: 'clusteroperator.config.openshift.io',
  ClusterVersion: 'clusterversion.config.openshift.io',
  OperatorGroup: 'operatorgroup.operators.coreos.com',
  InstallPlan: 'installplan.operators.coreos.com',
  ClusterServiceVersion: 'clusterserviceversion.operators.coreos.com',
  PackageManifest: 'packagemanifest.packages.operators.coreos.com',
  MetalLB: 'metallb.metallb.io',
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
  // Real `oc get packagemanifests` printer columns (issue #46): the catalog
  // source and the object age, not the OLM-spec DISPLAY/VERSION/SOURCE extras.
  PackageManifest: 'NAME      CATALOG   AGE',
};

/** Long flags the simulated `oc` implements somewhere (typo rejection). */
const KNOWN_LONG_FLAGS = new Set([
  'active-deadline-seconds',
  'add',
  'all',
  'all-containers',
  'all-namespaces',
  'allow',
  'allocate-load-balancer-ip',
  'api-group',
  'as',
  'as-group',
  'audio',
  'backoff-limit',
  'build',
  'builder-image',
  'ca-cert',
  'cascade',
  'cert',
  'claim-class',
  'claim-mode',
  'claim-name',
  'claim-size',
  'cluster-ip',
  'clusterrole',
  'code',
  'command',
  'commit',
  'completions',
  'configmap-name',
  'confirm',
  'container',
  'containers',
  'context',
  'context-dir',
  'current-replicas',
  'default',
  'default-mode',
  'default-request',
  'delete-emptydir-data',
  'description',
  'dest-ca-cert',
  'dest-dir',
  'destination',
  'destination-ca-cert',
  'display-name',
  'docker-email',
  'docker-password',
  'docker-server',
  'docker-username',
  'dockerfile',
  'dry-run',
  'env',
  'external-name',
  'field-selector',
  'file',
  'filename',
  'follow',
  'for',
  'force',
  'format',
  'from',
  'from-build',
  'from-config',
  'from-dir',
  'from-env-file',
  'from-file',
  'from-github',
  'from-image',
  'from-literal',
  'from-repo',
  'from-webhook',
  'full-name',
  'get-url',
  'grace-period',
  'group',
  'hard',
  'help',
  'hostname',
  'http-proxy',
  'https-proxy',
  'ignore-daemonsets',
  'image',
  'image-stream',
  'import-mode',
  'insecure-policy',
  'insecure-skip-tls-verify',
  'internal',
  'key',
  'kustomize',
  'label',
  'labels',
  'limits',
  'list',
  'liveness',
  'load-balancer-ip',
  'local',
  'max',
  'max-limit-request-ratio',
  'max-surge',
  'max-unavailable',
  'min',
  'mount-path',
  'name',
  'namespace',
  'namespaced',
  'no-cache',
  'no-headers',
  'no-proxy',
  'node',
  'now',
  'open-tcp',
  'orphan',
  'output',
  'overwrite',
  'parallelism',
  'param',
  'param-file',
  'parameters',
  'password',
  'patch',
  'path',
  'persist',
  'port',
  'prefix',
  'previous',
  'progress-deadline',
  'project-annotation-selector',
  'project-label-selector',
  'publish-not-ready-addresses',
  'read-only',
  'readiness',
  'recursive',
  'reference-policy',
  'remove',
  'replicas',
  'repo',
  'request-timeout',
  'requests',
  'resource',
  'resource-version',
  'restart',
  'revision',
  'role',
  'rolebinding-name',
  'schedule',
  'scheduled',
  'scopes',
  'secret-name',
  'selector',
  'server',
  'service',
  'serviceaccount',
  'session-affinity',
  'set',
  'show-console',
  'show-context',
  'show-labels',
  'show-server',
  'show-token',
  'since',
  'since-time',
  'sort-by',
  'source',
  'source-secret',
  'stdin',
  'strategy',
  'sub-path',
  'subresource',
  'suspend',
  'tail',
  'target-port',
  'template',
  'timeout',
  'timestamps',
  'to-revision',
  'tty',
  'type',
  'user',
  'username',
  'validate',
  'values',
  'values-file',
  'verb',
  'verbs',
  'version',
  'wait',
  'watch',
  'wildcard-policy',
  'working-dir',
  'versions',
  // flags implemented by individual handlers (must stay accepted by validation)
  'as-root',
  'atomic',
  'attach',
  'auto',
  'binary',
  'client',
  'delete',
  'delete-local-data',
  'disable-eviction',
  'duration',
  'enable-alpha-plugins',
  'field-manager',
  'generate-name',
  'generated',
  'http-get',
  'ignore-not-found',
  'initial-delay-seconds',
  'it',
  'keep-annotations',
  'keep-init-containers',
  'keep-labels',
  'keep-liveness',
  'keep-readiness',
  'load-restrictor',
  'manual',
  'overrides',
  'paused',
  'period-seconds',
  'pod-selector',
  'prune',
  'quiet',
  'raw',
  'reorder',
  'rm',
  'server-side',
  'short',
  'show-events',
  'startup',
  'state',
  'tcp',
  'timezone',
  'to',
  'to-namespace',
  'token',
  'types',
  'udp',
  'keys',
  'resource-name',
  // #11 follow-up commands (policy/image/rsh/cp/wait/diff/autoscale/helm)
  'audience',
  'bound-object-kind',
  'bound-object-name',
  'bound-object-uid',
  'cpu-percent',
  'filter-by-os',
  'history-max',
  'insecure',
  'no-preserve',
  'no-tty',
  'registry-config',
  'retries',
  'shell',
  'keep-local',
  'no-headers',
  'template',
  'output',
]);

/** Short flags the simulated `oc` implements (unknown single-letter flags error). */
const KNOWN_SHORT_FLAGS = new Set([
  'A',
  'B',
  'D',
  'F',
  'H',
  'R',
  'T',
  'b',
  'c',
  'e',
  'f',
  'i',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  't',
  'u',
  'w',
  'z',
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
  'namespace',
  'output',
  'selector',
  'field-selector',
  'sort-by',
  'replicas',
  'current-replicas',
  'resource-version',
  'image',
  'image-stream',
  'name',
  'code',
  'template',
  'file',
  'filename',
  'kustomize',
  'param',
  'env',
  'from',
  'remove',
  'prefix',
  'containers',
  'container',
  'limits',
  'requests',
  'default',
  'default-request',
  'max',
  'min',
  'max-limit-request-ratio',
  'get-url',
  'open-tcp',
  'claim-name',
  'mount-path',
  'sub-path',
  'type',
  'patch',
  'to-revision',
  'tail',
  'since',
  'since-time',
  'hostname',
  'path',
  'cert',
  'key',
  'ca-cert',
  'dest-ca-cert',
  'destination-ca-cert',
  'insecure-policy',
  'wildcard-policy',
  'port',
  'server',
  'username',
  'password',
  'as',
  'as-group',
  'hard',
  'scopes',
  'project-label-selector',
  'project-annotation-selector',
  'from-literal',
  'from-file',
  'from-env-file',
  'docker-server',
  'docker-username',
  'docker-password',
  'docker-email',
  'service',
  'serviceaccount',
  'clusterrole',
  'role',
  'user',
  'group',
  'rolebinding-name',
  'from-image',
  'from-dir',
  'revision',
  'grace-period',
  'cascade',
  'context-dir',
  'source-secret',
  'strategy',
  'build',
  'display-name',
  'description',
  'version',
  'dockerfile',
  'context',
  'context-dir',
  'audio',
  'labels',
  'label',
  'param-file',
  'source',
  'reference-policy',
  'commit',
  'working-dir',
  'destination',
  'format',
  'http-proxy',
  'https-proxy',
  'no-proxy',
  'node',
  'target-port',
  'selector',
  'external-name',
  'cluster-ip',
  'session-affinity',
  'publish-not-ready-addresses',
  'load-balancer-ip',
  'allocate-load-balancer-ip',
  'max-surge',
  'max-unavailable',
  'progress-deadline',
  'active-deadline-seconds',
  'backoff-limit',
  'completions',
  'parallelism',
  'restart',
  'schedule',
  'suspend',
  'serviceaccount',
  'overwrite',
]);

/** Flags explicitly treated as booleans even without `=`. */
const BOOLEAN_LONG_FLAGS = new Set([
  'all',
  'all-namespaces',
  'show-labels',
  'no-headers',
  'watch',
  'previous',
  'follow',
  'list',
  'overwrite',
  'force',
  'ignore-daemonsets',
  'delete-emptydir-data',
  'confirm',
  'scheduled',
  'remove',
  'add',
  'liveness',
  'readiness',
  'parameters',
  'internal',
  'recursive',
  'validate',
  'dry-run',
  'local',
  'server',
  'insecure-skip-tls-verify',
  'request-timeout',
  'help',
  'allow',
  'for',
  'wait',
  'no-cache',
  'timestamps',
  'cascade',
  'orphan',
  'now',
  'persist',
  'tty',
  'stdin',
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
  if (text.endsWith('es') && normalizeKind(text.slice(0, -2)))
    return normalizeKind(text.slice(0, -2));
  if (text.endsWith('s') && normalizeKind(text.slice(0, -1)))
    return normalizeKind(text.slice(0, -1));
  // Real oc accepts `<resource>.<group>` (`deployment.apps`, `clusterrolebinding.rbac`,
  // `route.route.openshift.io`). Strip group suffixes until a kind resolves; never
  // map the project.config singleton onto Project.
  if (text.includes('.') && !/^projects?\.config\./.test(text)) {
    const segments = text.split('.');
    for (let i = segments.length - 1; i >= 1; i -= 1) {
      const candidate = segments.slice(0, i).join('.');
      const kind = normalizeKind(candidate) || extra[candidate];
      if (kind) return kind;
      if (candidate.endsWith('es') && normalizeKind(candidate.slice(0, -2)))
        return normalizeKind(candidate.slice(0, -2));
      if (candidate.endsWith('s') && normalizeKind(candidate.slice(0, -1)))
        return normalizeKind(candidate.slice(0, -1));
    }
  }
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

  const getLabels = (resource) =>
    (resource && (resource.metadata?.labels || resource.labels)) || {};

  return (resource) => {
    const labels = getLabels(resource);
    for (const req of requirements) {
      let m = req.match(/^([A-Za-z0-9_.\-/]+)\s+(in|notin)\s*\(([^)]*)\)$/);
      if (m) {
        const values = m[3]
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        const has =
          Object.prototype.hasOwnProperty.call(labels, m[1]) && values.includes(labels[m[1]]);
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
  const requirements = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    const list = Array.isArray(items)
      ? items.length === 1 && Array.isArray(items[0])
        ? items[0]
        : items
      : [];
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
      const list = Array.isArray(items)
        ? items.length === 1 && Array.isArray(items[0])
          ? items[0]
          : items
        : [];
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
  if (Array.isArray(value))
    return value
      .map((entry) =>
        entry !== null && typeof entry === 'object' ? JSON.stringify(entry) : String(entry)
      )
      .join(' ');
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
      .replace(/\\(.)/g, (match, char) =>
        char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char
      );
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
    else if (value !== undefined && value !== null)
      out += typeof value === 'object' ? JSON.stringify(value) : String(value);
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
      if (Array.isArray(value))
        return value.map((entry) => resolvePathValue(entry, segments.slice(s + 1)));
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
        if (!Array.isArray(entryValue) && Object.keys(entryValue).length === 0)
          return `${keyText}: {}`;
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
 * Helm 3 prints timestamps with Go's `time.ANSIC` layout:
 * `Thu Nov  6 16:42:23 2026` (single-digit days are space-padded).
 * @param {Date|number|string} [value]
 * @returns {string}
 */
export function formatHelmDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '<unknown>';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (number) => String(number).padStart(2, '0');
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}

/**
 * Strip simulator-internal `openshiftgames*` annotations/finalizers from a
 * manifest object tree before it is printed by `oc ... -o yaml|json` (issue
 * #23). Top-level metadata and nested pod templates are both covered; genuine
 * user annotations are preserved.
 * @param {any} value
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
export function stripInternalCliMetadata(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) stripInternalCliMetadata(entry, seen);
    return value;
  }
  const metadata = value.metadata;
  if (metadata && typeof metadata === 'object') {
    if (metadata.annotations && typeof metadata.annotations === 'object') {
      for (const key of Object.keys(metadata.annotations)) {
        if (isInternalMetadataKey(key)) delete metadata.annotations[key];
      }
      if (Object.keys(metadata.annotations).length === 0) delete metadata.annotations;
    }
    if (Array.isArray(metadata.finalizers)) {
      const finalizers = visibleFinalizers(metadata.finalizers);
      if (finalizers.length) metadata.finalizers = finalizers;
      else delete metadata.finalizers;
    }
  }
  for (const entry of Object.values(value)) stripInternalCliMetadata(entry, seen);
  return value;
}

const INTERNAL_ANNOTATION_ENTRY_RE = /^openshiftgames(?:\.io)?\//;

/**
 * Scrub simulator-internal `openshiftgames*` entries from rendered describe
 * text. Resource classes outside the CLI render `Annotations: k=v, k2=v2…`
 * on one line; filtering here keeps every `oc describe` leak-free (#23)
 * without changing each class, while user annotations (openshift.io/…,
 * kubernetes.io/…) stay untouched.
 * @param {string} text
 * @returns {string}
 */
export function scrubInternalAnnotationsText(text) {
  return String(text ?? '').replace(/^(\s*Annotations:\s*)(.*)$/gm, (line, prefix, rest) => {
    if (!/openshiftgames/i.test(rest)) return line;
    const entries = rest
      .split(/,\s+/)
      .filter((entry) => !INTERNAL_ANNOTATION_ENTRY_RE.test(entry.trim()));
    return `${prefix}${entries.join(', ') || '<none>'}`;
  });
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
  const list = Array.isArray(values)
    ? values
    : values === undefined || values === null
      ? []
      : [values];
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
    spec: 'PodSpec - Specification of the desired behavior of the pod.',
    'spec.containers': 'Container[] - List of containers belonging to the pod.',
    'spec.containers.name': 'string - Name of the container.',
    'spec.containers.image': 'string - Container image name.',
    'spec.containers.ports': 'ContainerPort[] - Ports exposed from the container.',
    'spec.containers.env': 'EnvVar[] - Environment variables to set in the container.',
    'spec.containers.resources':
      'ResourceRequirements - Compute Resources required by this container.',
    'spec.containers.resources.requests':
      'map[string]Quantity - Minimum amount of compute resources required.',
    'spec.containers.resources.limits':
      'map[string]Quantity - Maximum amount of compute resources allowed.',
    'spec.containers.livenessProbe': 'Probe - Periodic probe of container liveness.',
    'spec.containers.readinessProbe': 'Probe - Periodic probe of container service readiness.',
    'spec.containers.securityContext':
      'SecurityContext - Security options the container should run with (privileged, runAsUser, ...).',
    'spec.serviceAccountName': 'string - Name of the ServiceAccount to use.',
    'spec.nodeName': 'string - NodeName requests scheduling on a specific node.',
    'spec.nodeSelector': 'map[string]string - Selector for node scheduling.',
    'spec.volumes': 'Volume[] - List of volumes that can be mounted by containers.',
    'spec.restartPolicy': 'string - Restart policy: Always, OnFailure, Never. Default: Always.',
    metadata: 'ObjectMeta - Standard object metadata.',
    'metadata.name': 'string - Name must be unique within a project.',
    'metadata.namespace': 'string - Project (namespace) of the object. Default: "default".',
    'metadata.labels':
      'map[string]string - Map of string keys and values for organization and selection.',
    'metadata.annotations': 'map[string]string - Unstructured key-value data.',
    status: 'PodStatus - Most recently observed status of the pod.',
    'status.phase': 'string - Current phase: Pending, Running, Succeeded, Failed, Unknown.',
    'status.podIP': 'string - IP address allocated to the pod.',
    'status.containerStatuses':
      'ContainerStatus[] - Most recently observed status of each container.',
  },
  Deployment: {
    spec: 'DeploymentSpec - Specification of the desired behavior of the Deployment.',
    'spec.replicas': 'integer - Number of desired pods. Default: 1.',
    'spec.selector': 'LabelSelector - Label selector for pods. Must match template labels.',
    'spec.selector.matchLabels': 'map[string]string - Label key/value pairs the selector matches.',
    'spec.template': 'PodTemplateSpec - Template describing the pods that will be created.',
    'spec.strategy': 'DeploymentStrategy - Strategy used to replace old pods.',
    'spec.strategy.type': 'string - Type of strategy: RollingUpdate or Recreate.',
    'spec.strategy.rollingUpdate.maxSurge':
      'IntOrString - Maximum pods above the desired count during update.',
    'spec.strategy.rollingUpdate.maxUnavailable':
      'IntOrString - Maximum pods unavailable during update.',
    'spec.revisionHistoryLimit':
      'integer - Number of old ReplicaSets to retain for rollback. Default: 10.',
    status: 'DeploymentStatus - Most recently observed status of the Deployment.',
    'status.replicas': 'integer - Total number of non-terminated pods.',
    'status.readyReplicas': 'integer - Number of ready pods.',
    'status.updatedReplicas': 'integer - Number of pods updated to the current template.',
    'status.availableReplicas': 'integer - Number of available pods.',
  },
  Service: {
    spec: 'ServiceSpec - Specification of the desired behavior of the service.',
    'spec.type': 'string - Type: ClusterIP (default), NodePort, LoadBalancer, ExternalName.',
    'spec.selector': 'map[string]string - Routes traffic to pods matching these labels.',
    'spec.ports': 'ServicePort[] - List of ports exposed by this service.',
    'spec.ports.port': 'integer - Port exposed by the service (the ClusterIP port).',
    'spec.ports.targetPort': 'IntOrString - Port on the targeted pods.',
    'spec.ports.protocol': 'string - Protocol: TCP (default), UDP, SCTP.',
    'spec.clusterIP': 'string - ClusterIP of the service. "None" creates a headless service.',
    status: 'ServiceStatus - Most recently observed status of the service.',
    'status.loadBalancer': 'LoadBalancerStatus - External load balancer (EXTERNAL-IP).',
  },
  Route: {
    spec: 'RouteSpec - Specification of the desired route behavior.',
    'spec.host':
      'string - Hostname the route is admitted on (generated from the project when empty).',
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
    'spec.tls.destinationCACertificate':
      'string - CA bundle used to verify the backend for reencrypt.',
    'spec.tls.insecureEdgeTerminationPolicy':
      'string - Redirect, Allow or None (plain HTTP behavior).',
    'spec.wildcardPolicy': 'string - None or Subdomain.',
    'spec.alternateBackends': 'RouteTargetReference[] - Additional backends with weights.',
    status: 'RouteStatus - Observed route admission.',
    'status.ingress': 'RouteIngress[] - Per-router admission state.',
    'status.ingress[0].host': 'string - Hostname the router admitted.',
    'status.ingress[0].routerName': 'string - Name of the admitting router (default).',
    'status.ingress[0].conditions': 'RouteIngressCondition[] - Admitted/Available conditions.',
  },
  BuildConfig: {
    spec: 'BuildConfigSpec - Specification of a build.',
    'spec.source': 'BuildSource - Source of the build (Git, Binary, Dockerfile).',
    'spec.source.type': 'string - Git, Binary or Dockerfile.',
    'spec.source.git.uri': 'string - Git repository URI for the source.',
    'spec.source.git.ref': 'string - Git branch, tag or commit.',
    'spec.source.contextDir': 'string - Subdirectory of the source to build in.',
    'spec.strategy': 'BuildStrategy - How to build the image.',
    'spec.strategy.type': 'string - Source (S2I) or Docker.',
    'spec.strategy.sourceStrategy.from':
      'ObjectReference - Builder ImageStreamTag, e.g. nodejs:20.',
    'spec.strategy.dockerStrategy.dockerfilePath':
      'string - Path to the Dockerfile. Default: Dockerfile.',
    'spec.output': 'BuildOutput - Where to push the resulting image.',
    'spec.output.to': 'ObjectReference - ImageStreamTag to write, e.g. app:latest.',
    'spec.triggers': 'BuildTriggerPolicy[] - ConfigChange / ImageChange / Webhook triggers.',
    'spec.runPolicy': 'string - Serial, SerialLatestOnly or Parallel.',
    status: 'BuildConfigStatus - Observed build history.',
    'status.lastVersion': 'integer - Last build version created.',
  },
  Build: {
    spec: 'BuildSpec - Specification of one build execution.',
    'spec.source': 'BuildSource - Source snapshot for this build.',
    'spec.strategy': 'BuildStrategy - Strategy used to build the image.',
    'spec.output': 'BuildOutput - ImageStreamTag receiving the built image.',
    'spec.revision': 'SourceRevision - Git revision that was built.',
    status: 'BuildStatus - Observed phase of the build.',
    'status.phase': 'string - New, Pending, Running, Complete, Failed or Cancelled.',
    'status.startTimestamp': 'string - When the build started (RFC3339).',
    'status.completionTimestamp': 'string - When the build finished (RFC3339).',
    'status.duration': 'integer - Build duration in nanoseconds.',
    'status.message': 'string - Human-readable reason when the build fails.',
  },
  ImageStream: {
    spec: 'ImageStreamSpec - ImageStream configuration.',
    'spec.lookupPolicy': 'ImageLookupPolicy - Whether local image lookups are allowed.',
    'spec.lookupPolicy.local': 'boolean - Resolve image names locally instead of cluster-wide.',
    'spec.tags': 'TagReference[] - Tags managed by this image stream.',
    'spec.tags[0].name': 'string - Tag name, e.g. latest or v1.',
    'spec.tags[0].from': 'ObjectReference - Source of the tag (DockerImage or ImageStreamTag).',
    'spec.dockerImageRepository': 'string - External registry repository reference.',
    'status.tags': 'NamedTagEventList[] - Resolved image references per tag.',
    'status.tags[0].items': 'TagEvent[] - Image digests/pull specs for the tag.',
    'status.dockerImageRepository':
      'string - Internal registry repository, e.g. image-registry.../<project>/<name>.',
  },
  Template: {
    parameters: 'Parameter[] - Values substituted into objects at process time.',
    'parameters[0].name': 'string - Parameter name, referenced as ${NAME}.',
    'parameters[0].required': 'boolean - Fail processing when the parameter has no value.',
    'parameters[0].value': 'string - Default value.',
    objects: 'runtime.RawExtension[] - Object definitions created by the template.',
    message: 'string - Message printed after successful processing.',
  },
  Subscription: {
    spec: 'SubscriptionSpec - Operator installation request (OLM).',
    'spec.name': 'string - Package name in the catalog.',
    'spec.channel': 'string - Channel to subscribe to, e.g. stable.',
    'spec.source': 'string - CatalogSource name, e.g. redhat-operators.',
    'spec.sourceNamespace':
      'string - Project containing the CatalogSource (openshift-marketplace).',
    'spec.installPlanApproval': 'string - Automatic or Manual.',
    status: 'SubscriptionStatus - Observed install state.',
    'status.phase': 'string - Installing, UpgradePending, Succeeded or Failed.',
    'status.installedCSV': 'string - ClusterServiceVersion currently installed.',
  },
  SecurityContextConstraints: {
    priority: 'integer - Ordering priority when multiple SCCs apply; higher wins.',
    allowPrivilegedContainer: 'boolean - Permit privileged containers.',
    allowHostDirVolumePlugin: 'boolean - Permit hostPath volumes.',
    allowHostNetwork: 'boolean - Permit hostNetwork pods.',
    allowHostPorts: 'boolean - Permit hostPort/hostNetwork port usage.',
    allowHostPID: 'boolean - Permit hostPID.',
    allowHostIPC: 'boolean - Permit hostIPC.',
    readOnlyRootFilesystem: 'boolean - Force read-only root filesystems.',
    runAsUser: 'RunAsUserStrategyOptions - UID strategy: MustRunAsRange, MustRunAs or RunAsAny.',
    seLinuxContext: 'SELinuxContextStrategyOptions - SELinux labelling strategy.',
    fsGroup: 'FSGroupStrategyOptions - fsGroup strategy and allowed ranges.',
    supplementalGroups: 'SupplementalGroupsStrategyOptions - supplementalGroups strategy.',
    users: 'string[] - Users granted this SCC directly.',
    groups: 'string[] - Groups granted this SCC (e.g. system:authenticated).',
  },
  ResourceQuota: {
    spec: 'ResourceQuotaSpec - Enforced aggregate limits for the project.',
    'spec.hard': 'map[string]Quantity - Hard limits, e.g. pods: "20", requests.cpu: "4".',
    'spec.scopes': 'string[] - Restrict the quota to scopes such as BestEffort or NotTerminating.',
    status: 'ResourceQuotaStatus - Observed usage.',
    'status.used': 'map[string]Quantity - Current usage per resource.',
  },
  LimitRange: {
    spec: 'LimitRangeSpec - Defaults and limits applied at admission.',
    'spec.limits': 'LimitRangeItem[] - Per type (Container, Pod, PVC) constraints.',
    'spec.limits[0].type': 'string - Container, Pod, PersistentVolumeClaim, ImageStream or Image.',
    'spec.limits[0].default': 'map[string]Quantity - Default limits for containers.',
    'spec.limits[0].defaultRequest': 'map[string]Quantity - Default requests for containers.',
    'spec.limits[0].min': 'map[string]Quantity - Minimum allowed request/limit.',
    'spec.limits[0].max': 'map[string]Quantity - Maximum allowed request/limit.',
    'spec.limits[0].maxLimitRequestRatio': 'map[string]Quantity - Maximum limit/request ratio.',
  },
  ClusterResourceQuota: {
    spec: 'ClusterResourceQuotaSpec - Quota applied across selected projects.',
    'spec.selector': 'ClusterResourceQuotaSelector - Project selection by label or annotation.',
    'spec.selector.labels.matchLabels':
      'map[string]string - Projects with these labels are constrained.',
    'spec.selector.annotations':
      'map[string]string - Projects with these annotations are constrained.',
    'spec.quota': 'ResourceQuotaSpec - Quota (hard limits) applied to each selected project.',
    status: 'ClusterResourceQuotaStatus - Aggregate usage across selected projects.',
    'status.total': 'ResourceQuotaStatus - Sum of hard/used for all selected projects.',
  },
  Project: {
    metadata: 'ObjectMeta - Standard object metadata; metadata.name is the project name.',
    'metadata.name': 'string - Project name (the namespace used by namespaced resources).',
    'metadata.annotations':
      'map[string]string - openshift.io/display-name, openshift.io/description, openshift.io/requester.',
    spec: 'ProjectSpec - Project display metadata.',
    'spec.displayName': 'string - Human-friendly display name shown in the console.',
    'spec.description': 'string - Project description.',
    status: 'ProjectStatus - Observed project state.',
    'status.phase': 'string - Active or Terminating.',
  },
  User: {
    'metadata.name': 'string - User name (the identity known to the cluster).',
    fullName: 'string - Full name of the user.',
    identities: 'Identity[] - Provider identities mapped to this user (e.g. htpasswd:alice).',
    groups: 'string[] - Groups the user belongs to.',
  },
  Group: {
    'metadata.name': 'string - Group name.',
    users: 'string[] - Users that belong to the group.',
  },
  Node: {
    spec: 'NodeSpec - Specification of the node.',
    'spec.taints': 'Taint[] - Taints that repel pods unless they tolerate them.',
    'spec.unschedulable': 'boolean - Marks the node unschedulable (cordon).',
    status: 'NodeStatus - Most recently observed node state.',
    'status.conditions': 'NodeCondition[] - Ready, MemoryPressure, DiskPressure, PIDPressure.',
    'status.capacity': 'map[string]Quantity - Total resources (cpu, memory, pods).',
    'status.allocatable': 'map[string]Quantity - Resources available for scheduling.',
    'status.nodeInfo.kubeletVersion': 'string - Kubernetes version reported by the kubelet.',
  },
  ConfigMap: {
    data: 'map[string]string - Key/value configuration data.',
    binaryData: 'map[string][]byte - Binary data as base64 strings.',
    immutable: 'boolean - Disallow updates when true.',
  },
  Secret: {
    type: 'string - Opaque, kubernetes.io/tls, kubernetes.io/dockerconfigjson, Opaque (htpasswd) ...',
    data: 'map[string][]byte - Base64 encoded secret values.',
    stringData: 'map[string]string - Write-only convenience field (encoded by the API).',
    immutable: 'boolean - Disallow updates when true.',
  },
  PersistentVolumeClaim: {
    spec: 'PersistentVolumeClaimSpec - The storage request.',
    'spec.accessModes': 'string[] - ReadWriteOnce, ReadOnlyMany, ReadWriteMany, ReadWriteOncePod.',
    'spec.resources.requests.storage': 'Quantity - Requested storage size, e.g. 10Gi.',
    'spec.storageClassName': 'string - StorageClass to provision from (empty = default class).',
    'spec.volumeName': 'string - Bound PersistentVolume name.',
    'status.phase': 'string - Pending, Bound or Lost.',
  },
  HorizontalPodAutoscaler: {
    spec: 'HorizontalPodAutoscalerSpec - Autoscaling behavior.',
    'spec.scaleTargetRef': 'CrossVersionObjectReference - Workload to scale.',
    'spec.minReplicas': 'integer - Lower bound on replicas. Default: 1.',
    'spec.maxReplicas': 'integer - Upper bound on replicas. Required.',
    'spec.metrics': 'MetricSpec[] - Resource (cpu/memory) or custom metrics used to scale.',
    'spec.behavior': 'HorizontalPodAutoscalerBehavior - Scale-up/down policies.',
  },
  NetworkPolicy: {
    spec: 'NetworkPolicySpec - Allowed traffic for selected pods.',
    'spec.podSelector':
      'LabelSelector - Pods this policy applies to (empty = all pods in project).',
    'spec.policyTypes': 'string[] - Ingress, Egress or both.',
    'spec.ingress': 'NetworkPolicyIngressRule[] - Allowed inbound rules.',
    'spec.egress': 'NetworkPolicyEgressRule[] - Allowed outbound rules.',
  },
  Ingress: {
    spec: 'IngressSpec - Routing rules served by the OpenShift ingress controller.',
    'spec.rules': 'IngressRule[] - Host/path routing rules.',
    'spec.rules[0].host': 'string - Hostname to match.',
    'spec.rules[0].http.paths': 'HTTPIngressPath[] - Path → service routing.',
    'spec.tls': 'IngressTLS[] - TLS configuration referencing a secret.',
  },
  Job: {
    spec: 'JobSpec - Desired completions for this job.',
    'spec.completions': 'integer - Number of successful pods required. Default: 1.',
    'spec.parallelism': 'integer - Maximum pods running in parallel.',
    'spec.backoffLimit': 'integer - Retries before the Job is marked failed.',
    'spec.activeDeadlineSeconds': 'integer - Deadline before the Job is terminated.',
    'spec.template': 'PodTemplateSpec - Template for the pods the Job creates.',
    'status.phase': 'string - Pending, Running, Complete or Failed.',
  },
  CronJob: {
    spec: 'CronJobSpec - Schedule and job template.',
    'spec.schedule': 'string - Cron schedule, e.g. "*/5 * * * *".',
    'spec.concurrencyPolicy': 'string - Allow, Forbid or Replace.',
    'spec.suspend': 'boolean - Suspend subsequent runs when true.',
    'spec.jobTemplate': 'JobTemplateSpec - Template for created Jobs.',
  },
  Role: {
    rules: 'PolicyRule[] - Permissions granted by this Role.',
    'rules[0].verbs':
      'string[] - get, list, watch, create, update, patch, delete, deletecollection.',
    'rules[0].apiGroups': 'string[] - API groups ("" for core).',
    'rules[0].resources': 'string[] - Resources (pods, routes.route.openshift.io, ...).',
  },
  RoleBinding: {
    roleRef: 'RoleRef - Role or ClusterRole being bound.',
    subjects: 'Subject[] - Users, Groups or ServiceAccounts receiving the permissions.',
  },
  ServiceAccount: {
    secrets:
      'ObjectReference[] - Secrets linked to the service account (legacy tokens/image pull secrets).',
    imagePullSecrets: 'LocalObjectReference[] - Secrets used to pull private images.',
    automountServiceAccountToken: 'boolean - Automatically mount an API token.',
  },
  StorageClass: {
    provisioner: 'string - Storage provisioner plugin name.',
    reclaimPolicy: 'string - Delete or Retain.',
    volumeBindingMode: 'string - Immediate or WaitForFirstConsumer.',
    allowVolumeExpansion: 'boolean - Allow PVCs to be expanded.',
  },
  OAuth: {
    spec: 'OAuthSpec - Cluster authentication configuration (singleton named "cluster").',
    'spec.identityProviders': 'IdentityProvider[] - HTPasswd, LDAP, OIDC, ... providers.',
    'spec.identityProviders[0].type': 'string - HTPasswd, LDAP, OIDC, RequestHeader, ...',
    'spec.identityProviders[0].htpasswd.fileData.name':
      'string - Secret (openshift-config) holding the htpasswd file.',
  },
  ClusterOperator: {
    status: 'ClusterOperatorStatus - Health of a platform operator.',
    'status.conditions':
      'ClusterOperatorStatusCondition[] - Available/Progressing/Degraded conditions.',
    'status.versions': 'OperandVersion[] - Versions of the operator and operands.',
  },
  ClusterVersion: {
    spec: 'ClusterVersionSpec - Desired version and update channel.',
    'spec.channel': 'string - Update channel, e.g. stable-4.22.',
    'spec.desiredUpdate': 'Update - Version to update to.',
    status: 'ClusterVersionStatus - Current version and update progress.',
    'status.desired.version': 'string - Version the cluster is converging to.',
    'status.history': 'UpdateHistory[] - Version change history.',
  },
  IPAddressPool: {
    spec: 'IPAddressPoolSpec - MetalLB external IP range.',
    'spec.addresses': 'string[] - Address ranges, e.g. 192.168.100.200-192.168.100.210.',
    'spec.autoAssign': 'boolean - Automatically assign addresses to LoadBalancer services.',
  },
  L2Advertisement: {
    spec: 'L2AdvertisementSpec - Layer 2 advertisement configuration.',
    'spec.ipAddressPools': 'string[] - Pools advertised over L2.',
    'spec.interfaces': 'string[] - Interfaces used to advertise (optional).',
  },
  Identity: {
    providerName: 'string - Identity provider name, e.g. htpasswd.',
    providerUserName: 'string - User name as known by the provider.',
    'user.name': 'string - OpenShift User this identity maps to.',
  },
  ReplicaSet: {
    spec: 'ReplicaSetSpec - Desired replica count and template.',
    'spec.replicas': 'integer - Number of desired pods.',
    'spec.selector': 'LabelSelector - Label selector for managed pods.',
    'status.readyReplicas': 'integer - Number of ready pods.',
  },
  StatefulSet: {
    spec: 'StatefulSetSpec - Desired state for a stateful workload.',
    'spec.replicas': 'integer - Number of desired pods.',
    'spec.serviceName': 'string - Headless Service governing the pod network identity.',
    'spec.volumeClaimTemplates': 'PersistentVolumeClaim[] - Per-pod storage requests.',
    'spec.template': 'PodTemplateSpec - Template for the pods.',
  },
  DaemonSet: {
    spec: 'DaemonSetSpec - Desired state for the per-node workload.',
    'spec.selector': 'LabelSelector - Label selector for managed pods.',
    'spec.template': 'PodTemplateSpec - Template for the pods.',
  },
  PersistentVolume: {
    spec: 'PersistentVolumeSpec - Cluster storage definition.',
    'spec.capacity.storage': 'Quantity - Storage capacity.',
    'spec.accessModes': 'string[] - Supported access modes.',
    'spec.persistentVolumeReclaimPolicy': 'string - Retain, Delete or Recycle.',
    'spec.storageClassName': 'string - StorageClass providing this volume.',
    'spec.claimRef': 'ObjectReference - PersistentVolumeClaim bound to this volume.',
  },
  PodDisruptionBudget: {
    spec: 'PodDisruptionBudgetSpec - Availability budget during voluntary disruptions.',
    'spec.minAvailable': 'IntOrString - Minimum pods that must stay available.',
    'spec.maxUnavailable': 'IntOrString - Maximum pods that may be unavailable.',
    'spec.selector': 'LabelSelector - Pods this budget applies to.',
  },
  ClusterRole: {
    rules: 'PolicyRule[] - Cluster-wide permissions granted by this role.',
  },
  ClusterRoleBinding: {
    roleRef: 'RoleRef - ClusterRole being bound.',
    subjects: 'Subject[] - Users, Groups or ServiceAccounts.',
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
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: '${APP_NAME}' },
        spec: {
          replicas: '${REPLICAS}',
          selector: { matchLabels: { app: '${APP_NAME}' } },
          template: {
            metadata: { labels: { app: '${APP_NAME}' } },
            spec: {
              containers: [{ name: 'main', image: '${IMAGE}', ports: [{ containerPort: 8080 }] }],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: '${APP_NAME}' },
        spec: {
          selector: { app: '${APP_NAME}' },
          ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
        },
      },
      {
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name: '${APP_NAME}' },
        spec: {
          to: { kind: 'Service', name: '${APP_NAME}', weight: 100 },
          port: { targetPort: 'http' },
          wildcardPolicy: 'None',
        },
      },
    ],
    message: 'Application ${APP_NAME} deployed. Run "oc get route ${APP_NAME}" to see the URL.',
  },

  // Standard OpenShift sample templates (openshift namespace). The shapes and
  // parameter names follow the templates the EX280 exam environment ships, so
  // `oc get templates -n openshift` → `oc process --parameters` →
  // `oc new-app --template=<name> -p KEY=VALUE` is a realistic workflow.
  'httpd-example': {
    description:
      'An example Apache HTTP Server (httpd) application that serves static content. For more information about using this template, including OpenShift considerations, see https://github.com/openshift/httpd-example.',
    parameters: [
      {
        name: 'NAME',
        displayName: 'Name',
        description: 'The name of the application.',
        required: true,
        value: 'httpd-example',
      },
      {
        name: 'SOURCE_IMAGE',
        displayName: 'HTTPD Docker Image',
        description:
          'The UBI httpd image to use for the application. Defaults to the latest ubi9/httpd-24 image.',
        required: true,
        value: 'registry.redhat.io/ubi9/httpd-24:latest',
      },
      {
        name: 'MEMORY_LIMIT',
        displayName: 'Memory limit',
        description: 'Maximum amount of memory the container can use.',
        required: true,
        value: '512Mi',
      },
    ],
    objects: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: '${NAME}',
          labels: { app: '${NAME}', 'app.kubernetes.io/part-of': '${NAME}' },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: '${NAME}' } },
          template: {
            metadata: { labels: { app: '${NAME}', deployment: '${NAME}' } },
            spec: {
              containers: [
                {
                  name: 'httpd',
                  image: '${SOURCE_IMAGE}',
                  ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
                  resources: { limits: { memory: '${MEMORY_LIMIT}' } },
                },
              ],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: '${NAME}', labels: { app: '${NAME}' } },
        spec: {
          selector: { app: '${NAME}' },
          ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
        },
      },
      {
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name: '${NAME}', labels: { app: '${NAME}' } },
        spec: {
          to: { kind: 'Service', name: '${NAME}', weight: 100 },
          port: { targetPort: 'http' },
          wildcardPolicy: 'None',
        },
      },
    ],
    message:
      'The following service(s) have been created in your project: ${NAME}.\n\n       Run "oc get route ${NAME}" to see the URL for the application.',
  },

  'mysql-persistent': {
    description:
      'MySQL database service with a persistent volume. For more information about using this template, including OpenShift considerations, see https://github.com/sclorg/mysql-container.',
    parameters: [
      {
        name: 'MEMORY_LIMIT',
        displayName: 'Memory limit',
        description: 'Maximum amount of memory the container can use.',
        required: true,
        value: '512Mi',
      },
      {
        name: 'DATABASE_SERVICE_NAME',
        displayName: 'Database Service Name',
        description: 'The name of the database service.',
        required: true,
        value: 'mysql',
      },
      {
        name: 'MYSQL_USER',
        displayName: 'MySQL Connection Username',
        description:
          'Username for MySQL user that will be used for accessing the database. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'MYSQL_PASSWORD',
        displayName: 'MySQL Connection Password',
        description:
          'Password for the MySQL connection user. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'MYSQL_DATABASE',
        displayName: 'MySQL Database Name',
        description: 'Name of the MySQL database accessed by the application.',
        required: true,
        value: 'sampledb',
      },
      {
        name: 'MYSQL_ROOT_PASSWORD',
        displayName: 'MySQL root Password',
        description: 'Password for the MySQL root user. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'MYSQL_VERSION',
        displayName: 'Version of MySQL Image',
        description: 'Version of the MySQL image to be used (8.0 or 8.4).',
        required: true,
        value: '8.0',
      },
      {
        name: 'VOLUME_CAPACITY',
        displayName: 'Volume Capacity',
        description: 'Volume space available for data, e.g. 512Mi, 2Gi.',
        required: true,
        value: '1Gi',
      },
    ],
    objects: [
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          selector: { name: '${DATABASE_SERVICE_NAME}' },
          ports: [{ name: 'mysql', port: 3306, targetPort: 3306 }],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '${VOLUME_CAPACITY}' } },
        },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { name: '${DATABASE_SERVICE_NAME}' } },
          strategy: { type: 'Recreate' },
          template: {
            metadata: { labels: { name: '${DATABASE_SERVICE_NAME}' } },
            spec: {
              containers: [
                {
                  name: 'mysql',
                  image: 'registry.redhat.io/rhel9/mysql-${MYSQL_VERSION}:latest',
                  ports: [{ name: 'mysql', containerPort: 3306, protocol: 'TCP' }],
                  env: [
                    { name: 'MYSQL_USER', value: '${MYSQL_USER}' },
                    { name: 'MYSQL_PASSWORD', value: '${MYSQL_PASSWORD}' },
                    { name: 'MYSQL_DATABASE', value: '${MYSQL_DATABASE}' },
                    { name: 'MYSQL_ROOT_PASSWORD', value: '${MYSQL_ROOT_PASSWORD}' },
                  ],
                  resources: { limits: { memory: '${MEMORY_LIMIT}' } },
                  volumeMounts: [{ name: 'mysql-data', mountPath: '/var/lib/mysql' }],
                },
              ],
              volumes: [
                {
                  name: 'mysql-data',
                  persistentVolumeClaim: { claimName: '${DATABASE_SERVICE_NAME}' },
                },
              ],
            },
          },
        },
      },
    ],
    message:
      'The following service(s) have been created in your project: ${DATABASE_SERVICE_NAME}.\n\n       Username: ${MYSQL_USER}\n       Password: ${MYSQL_PASSWORD}\n       Database Name: ${MYSQL_DATABASE}\n       Connection URL: mysql://${DATABASE_SERVICE_NAME}:3306/',
  },

  'postgresql-persistent': {
    description:
      'PostgreSQL database service with a persistent volume. For more information about using this template, including OpenShift considerations, see https://github.com/sclorg/postgresql-container.',
    parameters: [
      {
        name: 'MEMORY_LIMIT',
        displayName: 'Memory limit',
        description: 'Maximum amount of memory the container can use.',
        required: true,
        value: '512Mi',
      },
      {
        name: 'DATABASE_SERVICE_NAME',
        displayName: 'Database Service Name',
        description: 'The name of the database service.',
        required: true,
        value: 'postgresql',
      },
      {
        name: 'POSTGRESQL_USER',
        displayName: 'PostgreSQL Connection Username',
        description:
          'Username for PostgreSQL user that will be used for accessing the database. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'POSTGRESQL_PASSWORD',
        displayName: 'PostgreSQL Connection Password',
        description:
          'Password for the PostgreSQL connection user. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'POSTGRESQL_DATABASE',
        displayName: 'PostgreSQL Database Name',
        description: 'Name of the PostgreSQL database accessed by the application.',
        required: true,
        value: 'sampledb',
      },
      {
        name: 'POSTGRESQL_ADMIN_PASSWORD',
        displayName: 'PostgreSQL admin Password',
        description:
          'Password for the PostgreSQL admin (postgres) user. The value is generated when not supplied.',
        generate: 'expression',
        from: '[a-zA-Z0-9]{16}',
        required: true,
      },
      {
        name: 'POSTGRESQL_VERSION',
        displayName: 'Version of PostgreSQL Image',
        description: 'Version of the PostgreSQL image to be used (13, 15 or 16).',
        required: true,
        value: '16',
      },
      {
        name: 'VOLUME_CAPACITY',
        displayName: 'Volume Capacity',
        description: 'Volume space available for data, e.g. 512Mi, 2Gi.',
        required: true,
        value: '1Gi',
      },
    ],
    objects: [
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          selector: { name: '${DATABASE_SERVICE_NAME}' },
          ports: [{ name: 'postgresql', port: 5432, targetPort: 5432 }],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '${VOLUME_CAPACITY}' } },
        },
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: '${DATABASE_SERVICE_NAME}',
          labels: { name: '${DATABASE_SERVICE_NAME}' },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { name: '${DATABASE_SERVICE_NAME}' } },
          strategy: { type: 'Recreate' },
          template: {
            metadata: { labels: { name: '${DATABASE_SERVICE_NAME}' } },
            spec: {
              containers: [
                {
                  name: 'postgresql',
                  image: 'registry.redhat.io/rhel9/postgresql-${POSTGRESQL_VERSION}:latest',
                  ports: [{ name: 'postgresql', containerPort: 5432, protocol: 'TCP' }],
                  env: [
                    { name: 'POSTGRESQL_USER', value: '${POSTGRESQL_USER}' },
                    { name: 'POSTGRESQL_PASSWORD', value: '${POSTGRESQL_PASSWORD}' },
                    { name: 'POSTGRESQL_DATABASE', value: '${POSTGRESQL_DATABASE}' },
                    { name: 'POSTGRESQL_ADMIN_PASSWORD', value: '${POSTGRESQL_ADMIN_PASSWORD}' },
                  ],
                  resources: { limits: { memory: '${MEMORY_LIMIT}' } },
                  volumeMounts: [{ name: 'postgresql-data', mountPath: '/var/lib/pgsql/data' }],
                },
              ],
              volumes: [
                {
                  name: 'postgresql-data',
                  persistentVolumeClaim: { claimName: '${DATABASE_SERVICE_NAME}' },
                },
              ],
            },
          },
        },
      },
    ],
    message:
      'The following service(s) have been created in your project: ${DATABASE_SERVICE_NAME}.\n\n       Username: ${POSTGRESQL_USER}\n       Password: ${POSTGRESQL_PASSWORD}\n       Database Name: ${POSTGRESQL_DATABASE}\n       Connection URL: postgresql://${DATABASE_SERVICE_NAME}:5432/',
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
    /** Simulated bash layer (issue #11): cat/echo/heredoc/grep/vim/skopeo… */
    this.shellTools = new ShellTools(this);
    /** Set by the last authorizeCommand gate call (#2). */
    this._gate = null;
    /**
     * Pending interactive `oc login` password prompt (#42): the next terminal
     * line is the password, never echoed and never stored in history.
     * @type {{user: string, server: string}|null}
     */
    this._pendingLogin = null;

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
    // #50: exported shell variables live in the session/terminal, but a new
    // game run (engine reset) starts a fresh shell like a new login session.
    this._installEngineResetListener();
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
      'text-white/30'
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
    // A pending `oc login` password prompt must never survive a cluster/level
    // reset or an external session change (it would swallow the next command).
    for (const eventName of ['cluster:reset', 'login', 'logout']) {
      this.eventBus?.on?.(eventName, () => {
        if (this._pendingLogin) this._closeLoginPrompt();
      });
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
    // While the `oc login` password prompt is waiting for input, the terminal
    // behaves like a TTY password read: no completion/history, Enter submits,
    // Ctrl+C cancels (#42).
    if (this._pendingLogin) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._executeCommand(this.input.value);
        return;
      }
      if (e.ctrlKey && /^[cC]$/.test(e.key)) {
        e.preventDefault();
        this._executeCommand('\u0003');
        return;
      }
      if (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        return;
      }
      return;
    }
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
        this.selectedSuggestion = Math.min(
          this.suggestions.length - 1,
          this.selectedSuggestion + 1
        );
        this._renderSuggestions();
      } else {
        this._navigateHistory(1);
      }
    }
  }

  _onInputChange() {
    if (this._pendingLogin) {
      this.suggestions = [];
      this.selectedSuggestion = -1;
      this.suggestionsEl?.classList.add('hidden');
      return;
    }
    this._updateSuggestions();
  }

  _navigateHistory(direction) {
    if (this.history.length === 0) return;
    this.historyIndex += direction;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex));
    if (this.input)
      this.input.value = this.historyIndex >= 0 ? this.history[this.historyIndex] : '';
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
    this.suggestions = candidates
      .slice(0, 10)
      .map((value) => ({ type: 'completion', value: leading + value }));
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
    const projectNames = () =>
      this._resources('Project')
        .map((p) => p.metadata?.name)
        .filter(Boolean);
    const fileNames = () => this._manifestFileList();
    const flagList = (extra = []) => {
      const flags = [...(COMMAND_FLAGS[cmd] || []), ...extra];
      return filter([...new Set(flags)]);
    };

    if (prior.length === 0)
      return filter([...new Set([...Object.keys(BASE_COMMANDS), ...SHELL_COMMANDS])]);
    if (word.startsWith('-')) {
      if (cmd === 'adm' && prior[1] === 'policy')
        return flagList(['-z', '-n', '--rolebinding-name']);
      return flagList();
    }
    const shellCommandLead = (prior[0] || '').toLowerCase();
    if (SHELL_FILE_COMMANDS.has(shellCommandLead) && !word.startsWith('-')) {
      const files = filter(this._manifestFileList());
      if (files.length) return files;
    }
    if (current === '') {
      const previous = prior[prior.length - 1];
      if (previous === '-n' || previous === '--namespace') return filter(projectNames());
      if (previous === '-f' || previous === '--filename' || previous === '--file')
        return filter(fileNames());
      if (previous === '-k' || previous === '--kustomize') return filter(fileNames());
      if (previous === '-o' || previous === '--output')
        return filter(['wide', 'yaml', 'json', 'name', 'jsonpath=', 'custom-columns=']);
      if (previous === '-p' || previous === '--param' || previous === '-e' || previous === '--env')
        return [];
    }
    if (prior.length === 1) {
      const sub = SUBCOMMANDS[cmd];
      const kindTokens = filter(RESOURCE_TYPES);
      if (sub) {
        const merged = [...sub.filter((s) => s.startsWith(lower)), ...kindTokens];
        return [...new Set(merged)];
      }
      if (
        cmd === 'adm' ||
        cmd === 'auth' ||
        cmd === 'rollout' ||
        cmd === 'expose' ||
        cmd === 'create' ||
        cmd === 'set'
      ) {
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
    const resourceToken = prior
      .slice(1)
      .find((token) => !token.startsWith('-') && normalizeKind(token));
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
          </div>`
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
      // An `oc login` password prompt owns the next terminal line (#42): the
      // password is consumed here before any shell/oc parsing and is never
      // echoed or stored in history.
      if (this._pendingLogin) {
        result = this._submitLoginPassword(String(raw ?? ''));
      } else if (this._debugSession) {
        // `oc debug node/…` opens a small node-debug session (#28): while it is
        // active the terminal input is fed to the debug container / host shell
        // (`chroot /host`, `systemctl status|restart kubelet`, `journalctl`,
        // `exit`) instead of to `oc`. `oc debug …` itself still resolves through
        // the normal command path and opens/closes the session.
        result = this._runDebugSessionLine(String(raw ?? ''));
      } else {
        result = this._runCommandLine(raw);
      }
    } catch (error) {
      const message = `error: internal command failure: ${error && error.message ? error.message : error}`;
      this._appendOutput(message, 'text-red-400');
      result = {
        error: true,
        message,
        raw: String(raw ?? ''),
        normalized: '',
        baseCommand: '',
        success: false,
      };
    }
    this._lastResult = result;
    return result;
  }

  /** Legacy entry point (index.html `ui:run-command` handler). */
  _executeCommand(raw) {
    return this.executeCommand(raw);
  }

  /** Reset the simulated shell session when the engine restarts (#50). */
  _installEngineResetListener() {
    if (this._boundEngineReset) return;
    const bus = this.eventBus;
    if (!bus || typeof bus.on !== 'function') return;
    this._boundEngineReset = () => this.shellTools?.resetSession?.();
    bus.on('engine:reset', this._boundEngineReset);
  }

  _runCommandLine(rawInput) {
    const raw = String(rawInput ?? '').trim();
    if (!raw)
      return { error: false, message: '', raw, normalized: '', baseCommand: '', success: true };

    this._pushHistory(raw);
    this._clearInput();

    // Shell preprocessing: heredocs (`cat <<EOF > file`) and `$(command)`
    // substitution run before the oc pipeline so `oc create … --from-literal=$(openssl rand -hex 16)` works.
    const preprocessed = this.shellTools?.preprocess
      ? this.shellTools.preprocess(raw)
      : { command: raw, stdin: null, display: raw };
    // #50: split `;` / `&&` / `||` BEFORE anything executes. The splitter is
    // quote/escape-aware and keeps pipes/redirects inside one segment; the
    // unsupported-grammar check runs over every segment up front so no part of
    // an unsupported line is ever executed silently.
    const plan = this.shellTools?.splitCommandLine
      ? this.shellTools.splitCommandLine(preprocessed.command)
      : { segments: [preprocessed.command], operators: [], error: null };
    const syntaxError =
      plan.error ||
      (this.shellTools?.findUnsupportedShellSyntax
        ? this.shellTools.findUnsupportedShellSyntax(plan.segments)
        : null);
    const { command: normalized, usedKubectl, prefixed } = stripCommandPrefix(preprocessed.command);
    const firstTokens = tokenizeCommand(plan.segments[0] || '');
    const baseCommand = (firstTokens[0] || '').toLowerCase();

    this._echoCommand(preprocessed.display ?? raw, normalized, usedKubectl, prefixed);
    this._emit('command:raw', { command: normalized, raw, baseCommand });
    if (syntaxError) {
      this._appendOutput(syntaxError, 'text-red-400');
      this._recordCommand(raw, baseCommand, false);
      this._emit('command:executed', {
        command: normalized,
        raw,
        baseCommand,
        success: false,
        timestamp: Date.now(),
      });
      return { error: true, message: syntaxError, raw, normalized, baseCommand, success: false };
    }

    // Easter eggs short-circuit execution (never mutate the cluster). They are
    // exact whole-line phrases, so a chained line dispatches normally.
    if (plan.segments.length === 1) {
      const easterEgg = this._checkEasterEggs(normalized);
      if (easterEgg) {
        this._appendOutput(easterEgg.message, easterEgg.color || 'text-amber-400');
        if (easterEgg.xp) this._emit('xp:gain', { amount: easterEgg.xp });
        if (easterEgg.achievement)
          this._emit('easter-egg:triggered', { id: easterEgg.achievement });
        this._recordCommand(raw, baseCommand, true);
        this._emit('command:executed', {
          command: normalized,
          raw,
          baseCommand,
          success: true,
          timestamp: Date.now(),
        });
        return {
          error: false,
          message: easterEgg.message,
          raw,
          normalized,
          baseCommand,
          success: true,
        };
      }
    }

    // #2: server-side authorization gate (engine owns the RBAC model). Runs once
    // per command line, before any dispatch/mutation; exempt client/session
    // commands (login/logout/whoami/project/help/auth can-i/…) pass through.
    const gateBlocked = this._authorizationGate(normalized, raw, baseCommand);
    if (gateBlocked) return gateBlocked;

    const lineOutputs = [];
    let lastStatus = true;
    let stdinPending = preprocessed.stdin ?? null;
    let ranSegment = false;

    for (let index = 0; index < plan.segments.length; index += 1) {
      const separator = index === 0 ? null : plan.operators[index - 1];
      // Shell sequencing: `;` always runs, `&&` only after success, `||` only
      // after failure. A skipped segment leaves the previous exit status alone
      // (POSIX left-associative `a && b || c`).
      const shouldRun =
        index === 0 ||
        separator === ';' ||
        (separator === '&&' && lastStatus) ||
        (separator === '||' && !lastStatus);
      if (!shouldRun) continue;
      const segment = String(plan.segments[index] ?? '').trim();
      if (!segment) continue;
      // Variables expand per segment (bash expands after parsing), so a value
      // containing `;` is never re-parsed as an operator.
      const expanded = this.shellTools?.expandVariables
        ? this.shellTools.expandVariables(segment)
        : segment;
      // Bare shell variable assignment (`HOST=$(oc get route … -o …)`, the L20
      // hint form): silent, session-persistent, and visible to `$VAR` in later
      // segments of the same line (#50).
      const assignment = this.shellTools?.parseShellAssignment?.(expanded);
      if (assignment) {
        this.shellTools.setSessionVariable(assignment.name, assignment.value);
        stdinPending = null;
        ranSegment = true;
        lastStatus = true;
        continue;
      }
      const result = this._runSegment(expanded, stdinPending, !ranSegment && prefixed);
      stdinPending = null;
      ranSegment = true;
      lastStatus = !result.error;
      if (result.clear) {
        this._outputLines = [];
        if (this.output) this.output.innerHTML = '';
        lineOutputs.length = 0;
        continue;
      }
      if (result.exit) {
        this.hide();
        break;
      }
      let text = result.error ? result.message || '' : result.output || '';
      // Multi-command lines append each segment's stdout in order; strip the
      // shell command's single trailing newline so `echo a; echo b` prints two
      // lines instead of a blank line between the segments (#50).
      if (plan.segments.length > 1) text = text.replace(/\n$/, '');
      if (text) this._appendOutput(text, result.error ? 'text-red-400' : 'text-white/70');
      lineOutputs.push(text);
    }

    // Exit status of the last executed segment is the line's result.
    const message = lineOutputs.filter(Boolean).join('\n');
    const success = lastStatus;
    this._recordCommand(raw, baseCommand, success);
    this._emit('command:executed', {
      command: normalized,
      raw,
      baseCommand,
      success,
      timestamp: Date.now(),
    });
    if (success && MUTATING_COMMANDS.has(baseCommand))
      this._emitMutationAuthCheck(normalized, baseCommand);
    return { error: !success, message, raw, normalized, baseCommand, success };
  }

  /**
   * Run one shell sequencing segment (#50): its own pipeline stages plus a
   * trailing output redirect. Pipes feed stdout to the next stage inside the
   * segment only; output of every executed segment is appended by the caller.
   * @param {string} segment
   * @param {string|null} stdin piped/heredoc stdin (first executed segment only)
   * @param {boolean} linePrefixed true when the original line started with `oc`
   * @returns {{error:boolean,message:string,output:string,clear?:boolean,exit?:boolean}}
   */
  _runSegment(segment, stdin, linePrefixed = false) {
    const { stages, redirect } = splitPipeline(segment);
    let stageStdin = stdin ?? null;
    let failed = false;
    let failureMessage = '';
    let output = '';
    for (let index = 0; index < stages.length; index += 1) {
      const isLast = index === stages.length - 1;
      const result = this._runStage(stages[index], stageStdin, index === 0 && linePrefixed);
      if (result.clear) return { error: false, message: '', output: '', clear: true };
      if (result.exit) return { error: false, message: '', output: '', exit: true };
      if (result.error) {
        failed = true;
        // Silent shell commands (`curl -s` on a failed request) print nothing at
        // all — never substitute the generic fallback line for them (#49).
        failureMessage = result.message || (result.silentFailure ? '' : 'error: command failed');
        break;
      }
      const text = result.message || '';
      if (isLast && redirect) {
        const written = this._writeRedirect(redirect, text);
        if (written.error) {
          failed = true;
          failureMessage = written.message;
        } else {
          // Shell redirection is silent on success (`cmd > file` prints nothing).
          output = '';
        }
      } else if (isLast) {
        output = text;
      } else {
        // Pipes: stdout feeds the next stage and is not echoed by the shell.
        stageStdin = text;
      }
    }
    return { error: failed, message: failureMessage, output };
  }

  _runStage(stage, stdin, linePrefixed = false) {
    // Stages after a pipe may repeat the `oc`/`kubectl` prefix
    // (`oc process ... | oc apply -f -`), so normalise every stage. The first
    // stage inherits the prefix stripped from the whole command line, so
    // `oc cp`/`oc rsh` are never mistaken for the shell commands of the same name.
    const explicitlyPrefixed =
      Boolean(linePrefixed) || /^\s*(?:oc|kubectl)\s+/i.test(String(stage ?? ''));
    const { command } = stripCommandPrefix(stage);
    // `let`: the global-flag hoisting below rewrites this array with the
    // global flags moved after the subcommand (issue #44 — `oc -n ns get pods`).
    let tokens = tokenizeCommand(command);
    if (tokens.length === 0) return { error: false, message: '' };
    let first = tokens[0].toLowerCase();
    // Shell layer first: shell flags (`-n`, `-i`…) are not oc flags, and
    // `cat`/`grep`/`vim`/`skopeo`/`htpasswd` must never be routed through `oc`.
    if (!explicitlyPrefixed && this.shellTools && this.shellTools.isShellLead(first)) {
      return this.shellTools.runTokens(tokens, stdin ?? null);
    }
    // Cobra validates flag values before dispatch: `oc -n` / `oc --namespace`
    // must report `flag needs an argument` instead of an unknown-command error
    // (#54a). Runs before the global-flag hoisting below.
    const flagValueError = this._validateFlagValues(tokens);
    if (flagValueError) return flagValueError;
    // Real oc accepts global flags before the subcommand (`oc -n ns patch …`).
    if (
      tokens.length > 1 &&
      /^(-{1,2}[A-Za-z]|--)/.test(first) &&
      first !== '--help' &&
      first !== '-h' &&
      first !== '--version'
    ) {
      const globalFlags = [];
      let index = 0;
      while (index < tokens.length && tokens[index].startsWith('-') && tokens[index] !== '--') {
        if (
          (tokens[index] === '-n' || tokens[index] === '--namespace') &&
          tokens[index + 1] &&
          !tokens[index + 1].startsWith('-')
        ) {
          globalFlags.push(tokens[index], tokens[index + 1]);
          index += 2;
          continue;
        }
        globalFlags.push(tokens[index]);
        index += 1;
      }
      if (globalFlags.length && index < tokens.length) {
        tokens = [...tokens.slice(index), ...globalFlags];
        first = tokens[0].toLowerCase();
      }
    }
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
          return this._err(
            `Error: unknown shorthand flag: '${char}' in ${token}\nSee 'oc ${command} --help' for usage.`
          );
        }
      }
    }
    return null;
  }

  /**
   * Validate that flags which take a value actually received one (#54a).
   *
   * cobra/pflag parse values before the command runs, so `oc -n` must fail with
   * `flag needs an argument: 'n' in -n` and `oc --namespace` with
   * `flag needs an argument: --namespace` — not an unknown-command error or a
   * namespace literally called `true`. Only flags whose value semantics are
   * unambiguous across every command are checked (`-c/-f/-p` are value flags in
   * some commands and boolean flags in others, e.g. `oc logs -f`).
   * @param {string[]} tokens
   * @returns {{error:true,message:string}|null}
   */
  _validateFlagValues(tokens) {
    // Short flags that always consume a value in the simulated CLI. `-n`
    // (namespace), `-o` (output), `-l` (selector), `-k`, `-e`, `-u`, `-z` —
    // ambiguous `-c/-f/-p` (value for some commands, boolean for `oc logs -f`)
    // are deliberately excluded.
    const shortValueFlags = new Set(['e', 'k', 'l', 'n', 'o', 'u', 'z']);
    // Some long flags are booleans for a specific command even though the shared
    // VALUE_LONG_FLAGS set lists them as value-taking (`oc delete --cascade` vs
    // `oc set env --from`, …). Skip those to avoid rejecting valid invocations.
    const booleanElsewhere = new Set([
      'build',
      'containers',
      'dockerfile',
      'format',
      'node',
      'overwrite',
      'reference-policy',
      'remove',
      'source',
    ]);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = String(tokens[i] ?? '');
      if (token === '--') break;
      if (token === '-' || !token.startsWith('-')) continue;
      if (/^-\d/.test(token)) continue; // negative number positional
      const next = tokens[i + 1];
      const hasNext = next !== undefined && !(String(next).startsWith('-') && String(next) !== '-');
      if (token.startsWith('--')) {
        const [name, inline] = token.slice(2).split('=');
        if (inline !== undefined) continue;
        if (
          !VALUE_LONG_FLAGS.has(name) ||
          BOOLEAN_LONG_FLAGS.has(name) ||
          booleanElsewhere.has(name)
        )
          continue;
        // Real cobra prints these messages with a lowercase `error:` prefix.
        if (!hasNext) return this._err(`error: flag needs an argument: --${name}`);
        continue;
      }
      const rest = token.slice(1);
      if (rest.includes('=')) continue;
      // Inspect a short-flag cluster left-to-right: a value-taking shorthand
      // consumes the remainder of the cluster as its attached value (`-owide`),
      // or needs the next token when it is the last character (`-n`).
      for (let charIndex = 0; charIndex < rest.length; charIndex += 1) {
        if (!shortValueFlags.has(rest[charIndex])) continue;
        if (charIndex < rest.length - 1) break; // attached value, nothing missing
        if (!hasNext)
          return this._err(`error: flag needs an argument: '${rest[charIndex]}' in ${token}`);
        break;
      }
    }
    return null;
  }

  _dispatch(tokens, ctx) {
    const cmd = (tokens[0] || '').toLowerCase();
    const args = tokens.slice(1);
    switch (cmd) {
      // Session / cluster context
      case 'login':
        return this._cmdLogin(args, ctx);
      case 'logout':
        return this._cmdLogout(args, ctx);
      case 'whoami':
        return this._cmdWhoami(args, ctx);
      case 'project':
        return this._cmdProject(args, ctx);
      case 'projects':
        return this._cmdProjects(args, ctx);
      case 'new-project':
        return this._cmdNewProject(args, ctx);
      case 'status':
        return this._cmdStatus(args, ctx);
      case 'config':
        return this._cmdConfig(args, ctx);
      case 'version':
        return this._cmdVersion(args, ctx);
      case 'api-resources':
        return this._cmdApiResources(args, ctx);
      // Querying
      case 'get':
        return this._cmdGet(args, ctx);
      case 'describe':
        return this._cmdDescribe(args, ctx);
      case 'logs':
        return this._cmdLogs(args, ctx);
      case 'events':
        return this._cmdGetEvents(args, ctx);
      case 'explain':
        return this._cmdExplain(args, ctx);
      // Mutations
      case 'create':
        return this._cmdCreate(args, ctx);
      case 'apply':
        return this._cmdApply(args, ctx);
      case 'replace':
        return this._cmdReplace(args, ctx);
      case 'delete':
        return this._cmdDelete(args, ctx);
      case 'scale':
        return this._cmdScale(args, ctx);
      case 'edit':
        return this._cmdEdit(args, ctx);
      case 'label':
        return this._cmdLabelAnnotate(args, ctx, 'labels');
      case 'annotate':
        return this._cmdLabelAnnotate(args, ctx, 'annotations');
      case 'patch':
        return this._cmdPatch(args, ctx);
      case 'set':
        return this._cmdSet(args, ctx);
      case 'rollout':
        return this._cmdRollout(args, ctx);
      case 'expose':
        return this._cmdExpose(args, ctx);
      case 'run':
        return this._cmdRun(args, ctx);
      case 'exec':
        return this._cmdExec(args, ctx);
      case 'tag':
        return this._cmdTag(args, ctx);
      case 'import-image':
        return this._cmdImportImage(args, ctx);
      case 'extract':
        return this._cmdExtract(args, ctx);
      case 'new-app':
        return this._cmdNewApp(args, ctx);
      case 'new-build':
        return this._cmdNewBuild(args, ctx);
      case 'start-build':
        return this._cmdStartBuild(args, ctx);
      case 'cancel-build':
        return this._cmdCancelBuild(args, ctx);
      case 'process':
        return this._cmdProcess(args, ctx);
      case 'kustomize':
        return this._cmdKustomize(args, ctx);
      // Admin / identity / operators / files
      case 'adm':
        return this._cmdAdm(args, ctx);
      case 'auth':
        return this._cmdAuth(args, ctx);
      case 'debug':
        return this._cmdDebug(args, ctx);
      case 'helm':
        return this._cmdHelm(args, ctx);
      case 'policy':
        return this._cmdPolicy(args, ctx);
      case 'image':
        return this._cmdImage(args, ctx);
      case 'rsh':
        return this._cmdRsh(args, ctx);
      case 'cp':
        return this._cmdCp(args, ctx);
      case 'wait':
        return this._cmdWait(args, ctx);
      case 'diff':
        return this._cmdDiff(args, ctx);
      case 'autoscale':
        return this._cmdAutoscale(args, ctx);
      case 'htpasswd':
        return this._cmdHtpasswd(args, ctx);
      case 'help':
        return this._cmdHelp(args, ctx);
      // Backwards-compatible bare forms
      case 'cordon':
        return this._cmdAdm(['cordon', ...args], ctx);
      case 'uncordon':
        return this._cmdAdm(['uncordon', ...args], ctx);
      case 'drain':
        return this._cmdAdm(['drain', ...args], ctx);
      case 'top':
        return this._cmdAdm(['top', ...args], ctx);
      default: {
        const suggestion = this._closestCommand(cmd);
        const hint = suggestion ? `\n\nDid you mean this?\n\t${suggestion}\n` : '';
        return this._err(
          `error: unknown command "${cmd}" for "oc"${hint}\nRun 'oc --help' for usage.`
        );
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

  _echoCommand(display, normalized, usedKubectl, prefixed = false) {
    // Only real oc commands are echoed with the `$ oc` prompt; shell input
    // (`cat file`, `htpasswd …`) keeps its own `$ ` prompt (issue #11). An
    // explicit `oc`/`kubectl` prefix always means oc (`oc cp`, `oc rsh`).
    const shellLine = !prefixed && !usedKubectl && this.shellTools?.isShellLine(normalized);
    if (shellLine) {
      this._appendOutput(`$ ${display}`, 'text-green-400/80');
    } else {
      this._appendOutput(`${OC_PROMPT} ${normalized}`, 'text-green-400/80');
    }
    if (usedKubectl) {
      this._appendOutput(
        'tip: on OpenShift, use oc — the oc command line is the supported interface.',
        'text-amber-400/80'
      );
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

  /**
   * #2 authorization gate: `Error from server (Forbidden): …` for commands the
   * current user may not run. Returns a failed command result when denied.
   * @param {string} normalized
   * @param {string} raw
   * @param {string} baseCommand
   * @returns {null|{error:boolean,message:string,raw:string,normalized:string,baseCommand:string,success:boolean}}
   */
  _authorizationGate(normalized, raw, baseCommand) {
    const ge = this.gameEngine;
    if (!ge || typeof ge.authorizeCommand !== 'function') return null;
    let gate = null;
    try {
      gate = ge.authorizeCommand(normalized, {
        user: this.currentUser,
        namespace: this.currentProject,
      });
    } catch {
      return null;
    }
    if (!gate || typeof gate !== 'object') return null;
    this._gate = gate;
    if (gate.exempt || gate.allowed !== false) return null;
    const message = gate.message || 'Error from server (Forbidden): request is forbidden';
    this._appendOutput(message, 'text-red-400');
    this._recordCommand(raw, baseCommand, false);
    this._emit('command:executed', {
      command: normalized,
      raw,
      baseCommand,
      success: false,
      timestamp: Date.now(),
    });
    return { error: true, message, raw, normalized, baseCommand, success: false };
  }

  /**
   * #2 authorization for `-f`/`-k`/stdin manifests: per-object
   * `GameEngine.authorizeObject(verb, obj)` (aborts the first denial, before
   * anything is mutated).
   * @returns {{error:true,message:string}|null}
   */
  _authorizeManifestObjects(objects, verb, flags = {}) {
    const ge = this.gameEngine;
    if (!ge || typeof ge.authorizeObject !== 'function') return null;
    const namespace =
      flags.namespace && flags.namespace !== true ? String(flags.namespace) : this.currentProject;
    for (const object of objects || []) {
      if (!object || typeof object !== 'object' || !object.kind) continue;
      let result = null;
      try {
        result = ge.authorizeObject(verb, object, { user: this.currentUser, namespace });
      } catch {
        return null;
      }
      if (result && result.allowed === false) {
        const message =
          result.message ||
          `Error from server (Forbidden): ${String(object.kind).toLowerCase()}/${object.metadata?.name || ''} is forbidden`;
        this._appendOutput(message, 'text-red-400');
        return this._err(message);
      }
    }
    return null;
  }

  _authorizeManifestInput(path, verb, stdinText, flags = {}) {
    const ge = this.gameEngine;
    if (!ge || typeof ge.authorizeObject !== 'function') return null;
    if (!this._gate || this._gate.requiresManifestCheck === false) {
      // `oc create/apply -f` without a manifest command gate still needs an
      // object check; skip only when the engine has no per-object API.
      if (!this._gate) return null;
    }
    const preview = this._manifestPreviewDocs(path, { stdinText });
    if (preview.error) return null; // let the normal parser surface path/parse errors
    return this._authorizeManifestObjects(preview.docs, verb, flags);
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
    return this._err(
      `error: ${extra || 'invalid arguments'}\n\nUsage:\n  ${usage}\n\nRun 'oc ${command} --help' for details.`
    );
  }

  // ── Easter eggs (OpenShift flavour, harmless) ─────────────────────────────

  _checkEasterEggs(normalized) {
    const lower = String(normalized || '')
      .toLowerCase()
      .trim();
    if (lower === 'get coffee') {
      return {
        message: `Error from server (NotFound): the server doesn't have a resource type "coffee".\nBut here's a \u2615 for your effort! +5 XP`,
        xp: 5,
        achievement: 'coffee-break',
      };
    }
    if (lower === 'explain life') {
      return {
        message:
          'KIND:     Life\nVERSION:  v1\n\nDESCRIPTION:\n  42. That is it. That is the explanation.',
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
    if (
      /^delete\s+(project|projects|namespace|namespaces|ns)\s+(kube-system|openshift-config|openshift-etcd|openshift-kube-apiserver)\b/.test(
        lower
      )
    ) {
      return {
        message:
          'WHOA! You just tried to remove a control-plane project. In production this would page every SRE on the planet. +25 XP',
        color: 'text-red-400',
        xp: 25,
        achievement: 'chaos-monkey',
      };
    }
    if (lower === 'adm upgrade') {
      return {
        message:
          'Updating cluster to 4.23.0... just kidding. The cluster is already on the stable-4.22 channel. +5 XP',
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
    if (this._pendingLogin) this._closeLoginPrompt();
    if (this._boundEngineReset) this.eventBus?.off?.('engine:reset', this._boundEngineReset);
    this._boundEngineReset = null;
    this._clearRolloutWatches?.();
    this._clearBuildWatches?.();
    if (typeof document !== 'undefined')
      document.removeEventListener('keydown', this._boundKeydown);
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
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
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

  /**
   * Projects the current user may see (#2): engine's binding-aware visibility
   * filter, falling back to every project without the engine helper.
   * @returns {string[]}
   */
  _visibleProjectNames() {
    const ge = this.gameEngine;
    if (ge && typeof ge.getVisibleProjects === 'function') {
      try {
        const projects = ge.getVisibleProjects(this.currentUser);
        if (Array.isArray(projects)) {
          return projects
            .map((project) => (typeof project === 'string' ? project : project?.metadata?.name))
            .filter(Boolean)
            .sort((a, b) => String(a).localeCompare(String(b)));
        }
      } catch {
        /* fall through */
      }
    }
    return this._projectNames();
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
      if (
        NAMESPACED_VIRTUAL_GET_TOKENS.has(token) ||
        ['event', 'events', 'ev', 'all'].includes(token)
      )
        return true;
      if (['ingresscontroller', 'ingresscontrollers', 'ic'].includes(token)) continue;
      let kind = resolveKindToken(token);
      if (!kind && ['dc', 'deploymentconfig', 'deploymentconfigs'].includes(token))
        kind = 'Deployment';
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
    const override =
      flags && flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
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
      const namespace =
        doc.metadata && doc.metadata.namespace
          ? String(doc.metadata.namespace)
          : this.currentProject;
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
    const kind = resolveKindToken(first);
    if (kind) return { kind, name: positionals[1] || null };
    return { kind: null, name: first };
  },

  /**
   * Find a resource by name. When no explicit `-n` is given and the resource is
   * namespaced, prefer the current project but fall back to a unique match in
   * another project (keeps CLI usable while modes/controllers create resources
   * in a project other than the session's current one).
   *
   * Read paths may keep that convenience fallback. Every WRITE path must pass
   * `allowOtherNamespaces: false`: real oc resolves names strictly inside the
   * request namespace (`Error from server (NotFound)` otherwise), and a
   * cross-project fallback would let `oc delete`/`oc label` mutate another
   * project's object (issue #29).
   */
  _findResource(kind, name, options = {}) {
    if (!kind || !name) return null;
    const list = this._resources(kind);
    if (!this._isNamespaced(kind)) {
      return list.find((resource) => resource.metadata?.name === name) || null;
    }
    const namespace =
      options.namespace || (options.explicitNamespace ? options.namespace : this.currentProject);
    const inNamespace = list.filter((resource) => resource.metadata?.namespace === namespace);
    const exact = inNamespace.find((resource) => resource.metadata?.name === name);
    if (exact) return exact;
    if (options.allowPrefix !== false) {
      const prefix = inNamespace.find((resource) =>
        (resource.metadata?.name || '').startsWith(name)
      );
      if (prefix) return prefix;
    }
    if (
      options.allowOtherNamespaces !== false &&
      !options.explicitNamespace &&
      !options.namespace
    ) {
      const elsewhere = list.filter((resource) => (resource.metadata?.name || '') === name);
      if (elsewhere.length === 1) return elsewhere[0];
      if (!options.allowPrefix && elsewhere.length > 1) return elsewhere[0];
    }
    return null;
  },

  /**
   * Namespace-exact lookup. Unlike `_findResource` it never falls through to a
   * same-named resource in another project; `null` means the API server would
   * answer NotFound for the request namespace (and for `create` requests it
   * means the name is free).
   */
  _findResourceExact(kind, name, namespace) {
    const list = this._resources(kind);
    if (!this._isNamespaced(kind))
      return list.find((resource) => resource.metadata?.name === name) || null;
    return (
      list.find(
        (resource) =>
          resource.metadata?.name === name &&
          (!namespace || resource.metadata?.namespace === namespace)
      ) || null
    );
  },

  _notFoundMessage(kind, name) {
    return `Error from server (NotFound): ${this._resourceNamePlural(kind)} "${name}" not found`;
  },

  _alreadyExistsMessage(kind, name) {
    return `Error from server (AlreadyExists): ${this._resourceNamePlural(kind)} "${name}" already exists`;
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
    this._emit('resource:applied', {
      kind: resource.kind,
      name: resource.metadata?.name,
      namespace: resource.metadata?.namespace,
    });
  },

  // ── ManifestEngine (Files engine) integration ─────────────────────────────

  _manifestReady() {
    const me = this.manifestEngine;
    return Boolean(me && (typeof me.readFile === 'function' || typeof me.applyFile === 'function'));
  },

  _manifestNotReady() {
    return this._err(
      'error: Files engine not ready — manifests/kustomize/helm require the declarative engine.\n' +
        'Open the Files panel or wait for it to initialise, then retry.'
    );
  },

  _manifestFileList() {
    const me = this.manifestEngine;
    if (!me || typeof me.listFiles !== 'function') return [];
    try {
      const files = me.listFiles();
      const entries = Array.isArray(files)
        ? files
        : files && Array.isArray(files.files)
          ? files.files
          : [];
      return entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.name || ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  },

  /**
   * Map an absolute `/home/student/...` path (what `$HOME` expands to after the
   * shell layer runs, #50) back onto the virtual filesystem, whose root is the
   * workstation home directory. Other paths pass through unchanged (the
   * ManifestEngine normalises leading slashes itself).
   * @param {string} path
   * @returns {string}
   */
  _normalizeVirtualPath(path) {
    const raw = String(path ?? '');
    if (raw === '/home/student') return '';
    if (raw.startsWith('/home/student/')) return raw.slice('/home/student/'.length);
    return raw;
  },

  _readVirtualFile(path) {
    const me = this.manifestEngine;
    if (!me || typeof me.readFile !== 'function') return null;
    try {
      const text = me.readFile(this._normalizeVirtualPath(path));
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  },

  _writeVirtualFile(path, content, options = {}) {
    const me = this.manifestEngine;
    if (!me || typeof me.writeFile !== 'function') return this._manifestNotReady();
    try {
      path = this._normalizeVirtualPath(path);
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
      return this._err(
        `error: unable to write "${path}": ${error && error.message ? error.message : error}`
      );
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
    this.shellTools?._refreshFilesPanel?.();
    // Real bash prints nothing when a redirect succeeds; the file content is the
    // only observable effect (`oc get deploy -o yaml > deploy.yaml`).
    return { ok: true, message: '' };
  },

  _resolveInputFile(path, stdinText) {
    if (path === '-') {
      if (stdinText === null || stdinText === undefined)
        return { error: this._err('error: no objects passed to apply') };
      const tempPath = this._tempStdinPath(stdinText);
      if (!tempPath) return { error: this._manifestNotReady() };
      return { file: tempPath };
    }
    return { file: this._normalizeVirtualPath(path) };
  },

  // ── --dry-run support for `create|apply|replace -f|-k|- ` ───────────────

  /** Parse manifest text into preview documents (Lists flattened). */
  _parseManifestPreviewText(text, source) {
    let docs;
    try {
      docs = parseYaml(text);
    } catch (error) {
      return {
        error: this._err(
          `error: error parsing ${source}: ${error && error.message ? error.message : error}`
        ),
      };
    }
    if (!Array.isArray(docs) || !docs.length) {
      return { error: this._err(`error: no objects passed to apply (file "${source}" is empty)`) };
    }
    const flattened = [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.kind === 'List' && Array.isArray(doc.items)) {
        flattened.push(...doc.items);
        continue;
      }
      flattened.push(doc);
    }
    if (!flattened.length)
      return { error: this._err(`error: no objects passed to apply (file "${source}" is empty)`) };
    return { docs: flattened, source };
  },

  /** Resolve documents for `-f <file|dir|->` without touching the cluster. */
  _manifestPreviewDocs(path, options = {}) {
    const stdinText = options.stdinText ?? null;
    if (path === '-') {
      if (stdinText === null || stdinText === undefined)
        return { error: this._err('error: no objects passed to apply') };
      return this._parseManifestPreviewText(String(stdinText), '<stdin>');
    }
    const direct = this._readVirtualFile(path);
    if (direct !== null) return this._parseManifestPreviewText(direct, path);
    const prefix = `${String(path).replace(/\/+$/, '')}/`;
    const files = this._manifestFileList().filter(
      (file) => file.startsWith(prefix) && /\.(ya?ml|json)$/i.test(file)
    );
    if (!files.length) return { error: this._err(`error: the path "${path}" does not exist`) };
    const docs = [];
    for (const file of files) {
      const parsed = this._parseManifestPreviewText(this._readVirtualFile(file) ?? '', file);
      if (parsed.error) return parsed;
      docs.push(...parsed.docs);
    }
    return { docs, source: path };
  },

  /** Deterministic fake UUID for server-side dry-run metadata. */
  _dryRunUid(name) {
    const hex = (input) => stableHash(String(input), 0xffffffff).toString(16).padStart(8, '0');
    const text = String(name || 'dry-run');
    return `${hex(text)}-${hex(`${text}-b`).slice(0, 4)}-4${hex(`${text}-c`).slice(0, 3)}-a${hex(`${text}-d`).slice(0, 3)}-${hex(`${text}-e`)}${hex(`${text}-f`)}`.slice(
      0,
      36
    );
  },

  /**
   * Print the would-be-created objects for `--dry-run=client|server`, without
   * persisting anything (real oc prints the manifest / `<type>/<name> created (dry run)`).
   * @param {object[]} docs
   * @param {{command?:string, flags?:object, mode?:string, source?:string}} options
   */
  _printDryRunObjects(docs, options = {}) {
    const flags = options.flags || {};
    const command = options.command || (flags.filename ? 'create' : 'apply');
    const mode = options.mode || 'client';
    const output = this._outputFormat(flags);
    const namespaceOverride =
      flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
    const prepared = [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      const object = JSON.parse(JSON.stringify(doc));
      const kind = resolveKindToken(String(object.kind || '')) || null;
      if (!kind) {
        if (!object.kind) return this._err('error: error validating data: apiVersion/kind not set');
        return this._err(`error: the server doesn't have a resource type "${object.kind}"`);
      }
      object.apiVersion = object.apiVersion || apiVersionForKind(kind);
      object.kind = kind;
      object.metadata = object.metadata || {};
      if (!object.metadata.name) {
        return this._err(
          `error: error validating "${options.source || '<stdin>'}": metadata.name: Required value`
        );
      }
      if (this._isNamespaced(kind)) {
        const manifestNamespace = object.metadata.namespace;
        if (mode === 'server' || namespaceOverride || manifestNamespace) {
          // Real client-side dry-run omits metadata.namespace unless the object
          // (or an explicit -n) carries one; server dry-run lets the API server
          // fill it in.
          object.metadata.namespace = namespaceOverride || manifestNamespace || this.currentProject;
        } else {
          delete object.metadata.namespace;
        }
        if (mode === 'server' && object.metadata.namespace) {
          const namespaceError = this._requireNamespace(object.metadata.namespace);
          if (namespaceError) return namespaceError;
        }
      } else {
        delete object.metadata.namespace;
      }
      const exists = Boolean(
        this._findResourceExact(kind, object.metadata.name, object.metadata.namespace)
      );
      if (mode === 'server') {
        if (command === 'create' && exists) {
          return this._err(
            `Error from server (AlreadyExists): ${this._resourceNamePlural(kind)} "${object.metadata.name}" already exists`
          );
        }
        object.metadata.uid = object.metadata.uid || this._dryRunUid(object.metadata.name);
        object.metadata.resourceVersion = object.metadata.resourceVersion || '1';
        object.metadata.creationTimestamp =
          object.metadata.creationTimestamp || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        object.metadata.generation = object.metadata.generation || 1;
      }
      prepared.push({ kind, object, exists });
    }
    if (!prepared.length) return this._err('error: no objects passed to apply');
    const suffix = mode === 'server' ? ' (server dry run)' : ' (dry run)';
    const lines = [];
    for (const { kind, object, exists } of prepared) {
      if (output.format === 'yaml') lines.push(toYamlDocument(object));
      else if (output.format === 'json') lines.push(JSON.stringify(object, null, 4));
      else if (output.format === 'name')
        lines.push(`${this._resourceRef(kind)}/${object.metadata?.name}`);
      else {
        const verb =
          command === 'create'
            ? 'created'
            : command === 'replace'
              ? 'replaced'
              : exists
                ? 'configured'
                : 'created';
        lines.push(`${this._resourceRef(kind)}/${object.metadata?.name} ${verb}${suffix}`);
      }
    }
    return this._ok(output.format === 'yaml' ? lines.join('\n---\n') : lines.join('\n'));
  },

  /** `-k/--kustomize` counterpart of `_printDryRunObjects` (renders without applying). */
  _printKustomizeDryRun(dir, flags = {}, mode = 'client') {
    const me = this.manifestEngine;
    if (!me || typeof me.renderKustomize !== 'function') {
      return this._err('error: oc kustomize rendering is not available in this build.');
    }
    let result;
    try {
      result = me.renderKustomize(dir);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    if (!result || result.ok === false)
      return this._err(result?.error || result?.errors?.[0] || 'error: kustomize build failed');
    const objects = Array.isArray(result.objects) ? result.objects : [];
    if (!objects.length) return this._err('error: no objects passed to apply');
    const warnings = (result.warnings || []).map((warning) => `warning: ${warning}`);
    const printed = this._printDryRunObjects(objects, {
      command: 'apply',
      flags,
      mode,
      source: dir,
    });
    if (printed.error) return printed;
    return this._ok([...warnings, printed.message].filter(Boolean).join('\n'));
  },

  _applyFileDelegated(path, options = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    path = this._normalizeVirtualPath(path);
    const flags = options.flags || {};
    const dryRun = this._dryRunMode(flags);
    if (dryRun === 'invalid')
      return this._err('error: --dry-run must be "none", "server", or "client"');
    if (dryRun) {
      // Client dry-run never contacts the server (no namespace lookup); server
      // dry-run still validates the request server-side, just without persisting.
      if (dryRun === 'server') {
        const namespaceError = this._requireManifestNamespaces(
          path,
          flags,
          options.stdinText ?? null
        );
        if (namespaceError) return namespaceError;
        const objectVerb =
          options.command === 'replace'
            ? 'update'
            : options.command === 'create'
              ? 'create'
              : 'apply';
        const authorizationError = this._authorizeManifestInput(
          path,
          objectVerb,
          options.stdinText ?? null,
          flags
        );
        if (authorizationError) return authorizationError;
      }
      const preview = this._manifestPreviewDocs(path, options);
      if (preview.error) return preview.error;
      return this._printDryRunObjects(preview.docs, {
        command: options.command || 'apply',
        flags,
        mode: dryRun,
        source: preview.source || path,
      });
    }
    const namespaceError = this._requireManifestNamespaces(path, flags, options.stdinText ?? null);
    if (namespaceError) return namespaceError;
    const objectVerb =
      options.command === 'replace' ? 'update' : options.command === 'create' ? 'create' : 'apply';
    const authorizationError = this._authorizeManifestInput(
      path,
      objectVerb,
      options.stdinText ?? null,
      flags
    );
    if (authorizationError) return authorizationError;
    const resolved = this._resolveInputFile(path, options.stdinText);
    if (resolved.error) return resolved.error;
    const me = this.manifestEngine;
    if (typeof me.applyFile !== 'function') return this._manifestNotReady();
    // Real oc's `-n` sets the namespace for every applied object (kubectl's
    // EnforceNamespace); the Files panel keeps calling applyFile(path) unchanged.
    const namespaceOverride =
      options.flags && options.flags.namespace && options.flags.namespace !== true
        ? String(options.flags.namespace)
        : null;
    const command = options.command || 'apply';
    const applyOptions = { command };
    if (namespaceOverride) applyOptions.namespace = namespaceOverride;
    let result;
    try {
      result = me.applyFile(resolved.file, applyOptions);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    return this._normalizeApplyResult(result, command);
  },

  _applyKustomizeDelegated(dir, flags = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    dir = this._normalizeVirtualPath(dir);
    const me = this.manifestEngine;
    if (typeof me.applyKustomize !== 'function') {
      return this._err(
        'error: Files engine does not support kustomize yet (missing ManifestEngine.applyKustomize).'
      );
    }
    const namespace =
      flags && flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
    if (namespace) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    if (typeof me.renderKustomize === 'function') {
      let rendered = null;
      try {
        rendered = me.renderKustomize(dir);
      } catch {
        rendered = null;
      }
      if (rendered && Array.isArray(rendered.objects) && rendered.objects.length) {
        const authorizationError = this._authorizeManifestObjects(
          rendered.objects,
          'apply',
          flags || {}
        );
        if (authorizationError) return authorizationError;
      }
    }
    let result;
    try {
      result = me.applyKustomize(dir, {
        namespace: namespace || undefined,
        autoCreateProjects: false,
      });
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    return this._normalizeApplyResult(result, 'apply');
  },

  _deleteFileDelegated(path, options = {}) {
    if (!this._manifestReady()) return this._manifestNotReady();
    path = this._normalizeVirtualPath(path);
    const namespaceError = this._requireManifestNamespaces(
      path,
      options.flags || {},
      options.stdinText ?? null
    );
    if (namespaceError) return namespaceError;
    const authorizationError = this._authorizeManifestInput(
      path,
      'delete',
      options.stdinText ?? null,
      options.flags || {}
    );
    if (authorizationError) return authorizationError;
    const me = this.manifestEngine;
    const resolved = this._resolveInputFile(path, options.stdinText ?? null);
    if (resolved.error) return resolved.error;
    if (typeof me.deleteFileObjects === 'function') {
      let result;
      const namespaceOverride =
        options.flags && options.flags.namespace && options.flags.namespace !== true
          ? String(options.flags.namespace)
          : undefined;
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
    return this._err(
      'error: Files engine cannot delete objects from files yet (missing ManifestEngine.deleteFileObjects).'
    );
  },

  _normalizeDeleteResult(result) {
    if (result === null || result === undefined) return this._ok('');
    if (typeof result === 'string') return this._ok(result);
    const entries = Array.isArray(result)
      ? result
      : Array.isArray(result.deleted)
        ? result.deleted
        : [];
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
      const messages = [
        ...lines,
        ...new Set([...(result.error ? [result.error] : []), ...engineErrors]),
      ];
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
    const created = Array.isArray(result)
      ? result
      : Array.isArray(result.created)
        ? result.created
        : [];
    const updated = Array.isArray(result)
      ? []
      : Array.isArray(result.updated)
        ? result.updated
        : [];
    const unchanged = Array.isArray(result)
      ? []
      : Array.isArray(result.unchanged)
        ? result.unchanged
        : [];
    const verbCreated = 'created';
    const verbUpdated =
      command === 'replace' ? 'replaced' : command === 'create' ? 'created' : 'configured';
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
    for (const entry of unchanged) {
      const kind = entry?.kind || entry?.resource?.kind;
      const name = entry?.metadata?.name || entry?.name;
      if (kind && name)
        lines.push(
          `${this._resourceRef(kind)}/${name} ${command === 'replace' ? 'replaced' : 'unchanged'}`
        );
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
      return this._err(
        'error: Files engine does not support template processing yet (missing ManifestEngine.processTemplate).'
      );
    }
    let result;
    try {
      result = me.processTemplate(resolved.file, params);
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
    if (typeof result === 'string') return { ok: true, text: result, objects: [] };
    if (result && (result.error || result.ok === false)) {
      const messages = [
        ...new Set(
          [
            ...(result.error ? [result.error] : []),
            ...(Array.isArray(result.errors) ? result.errors : []),
          ].filter(Boolean)
        ),
      ];
      return this._err(messages.length ? messages.join('\n') : 'error: template processing failed');
    }
    const warnings =
      result && Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    const objects = result && (result.objects || result.docs);
    if (Array.isArray(objects)) {
      const text = result.yaml || toYamlDocuments(objects);
      return {
        ok: true,
        text: warnings.length
          ? `${warnings.map((warning) => `warning: ${warning}`).join('\n')}\n${text}`
          : text,
        objects,
        warnings,
      };
    }
    if (result && typeof result.yaml === 'string')
      return { ok: true, text: result.yaml, objects: [], warnings };
    if (Array.isArray(result))
      return { ok: true, text: toYamlDocuments(result), objects: result, warnings };
    if (result && typeof result.message === 'string')
      return { ok: true, text: result.message, objects: [], warnings };
    return { ok: true, text: '', objects: [], warnings };
  },

  _helmCall(method, args) {
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    if (typeof me[method] !== 'function') {
      return this._err(
        `error: Helm is not available in the files engine yet (missing ManifestEngine.${method}).`
      );
    }
    try {
      const result = me[method](...args);
      if (typeof result === 'string') return this._ok(result);
      if (result && (result.error || result.ok === false)) {
        const messages = [
          ...new Set(
            [
              ...(result.error ? [result.error] : []),
              ...(Array.isArray(result.errors) ? result.errors : []),
            ].filter(Boolean)
          ),
        ];
        return this._err(messages.length ? messages.join('\n') : 'error: helm failed');
      }
      return { ok: true, result };
    } catch (error) {
      return this._err(`error: ${error && error.message ? error.message : error}`);
    }
  },

  _htpasswdCall(action, user, password, file = 'htpasswd', options = {}) {
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    const method = {
      add: 'htpasswdAdd',
      update: 'htpasswdUpdate',
      remove: 'htpasswdDelete',
      list: 'htpasswdList',
    }[action];
    if (!method || typeof me[method] !== 'function') {
      return this._err(
        `error: HTPasswd is not available in the files engine yet (missing ManifestEngine.${method}).`
      );
    }
    try {
      const result =
        action === 'list'
          ? me[method](file)
          : action === 'remove'
            ? me[method](user, file)
            : me[method](user, password, file, options);
      if (result && result.error)
        return this._err(
          typeof result.error === 'string'
            ? result.error
            : result.message || 'error: htpasswd failed'
        );
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
      return {
        error: this._err('error: manifest object is missing apiVersion/kind/metadata.name'),
      };
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
      if (object.metadata.labels)
        metadata.labels = { ...(existing.metadata?.labels || {}), ...object.metadata.labels };
      if (object.metadata.annotations)
        metadata.annotations = {
          ...(existing.metadata?.annotations || {}),
          ...object.metadata.annotations,
        };
      if (Object.keys(metadata).length) updates.metadata = metadata;
      try {
        if (typeof cluster.update === 'function') cluster.update(existing.metadata.uid, updates);
        else {
          if (updates.spec) existing.spec = updates.spec;
          if (updates.metadata?.labels) existing.metadata.labels = updates.metadata.labels;
          if (updates.metadata?.annotations)
            existing.metadata.annotations = updates.metadata.annotations;
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
      return {
        error: this._err(
          `error: unable to create ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`
        ),
      };
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
      allowOtherNamespaces: false,
    });
    if (!resource) return { error: this._err(this._notFoundMessage(kind, name)) };
    const spec = JSON.parse(JSON.stringify(resource.spec || {}));
    const outcome = mutator(spec, resource) || {};
    if (outcome.error) return outcome;
    const cluster = this.cluster;
    const updates = { spec };
    if (outcome.metadata) updates.metadata = outcome.metadata;
    try {
      if (cluster && typeof cluster.update === 'function')
        cluster.update(resource.metadata.uid || resource.uid, updates);
      else {
        resource.spec = spec;
        if (outcome.metadata) Object.assign(resource.metadata, outcome.metadata);
      }
    } catch (error) {
      return {
        error: this._err(
          `error: unable to update ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`
        ),
      };
    }
    return { ok: true, resource, spec, metadata: outcome.metadata };
  },

  _deleteResource(kind, name, options = {}) {
    const resource = this._findResource(kind, name, {
      namespace: options.namespace,
      explicitNamespace: Boolean(options.namespace),
      allowOtherNamespaces: false,
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
      return {
        error: this._err(
          `error: unable to delete ${this._resourceRef(kind)}/${name}: ${error && error.message ? error.message : error}`
        ),
      };
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
          if (result && Array.isArray(result.groups))
            result.groups.forEach((group) => groups.add(group));
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
      return (
        groups.includes(subject.name) ||
        (subject.name === 'system:authenticated' && Boolean(userName))
      );
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
        (candidate) =>
          candidate.metadata?.name === name &&
          (!namespace || candidate.metadata?.namespace === namespace)
      );
      return role?.spec?.rules || [];
    }
    const clusterRole = this._resources('ClusterRole').find(
      (candidate) => candidate.metadata?.name === name
    );
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
            resources: [
              'pods',
              'services',
              'deployments',
              'deployments.apps',
              'replicasets',
              'statefulsets',
              'daemonsets',
              'jobs',
              'cronjobs',
              'routes',
              'buildconfigs',
              'builds',
              'imagestreams',
              'configmaps',
              'secrets',
              'persistentvolumeclaims',
            ],
            verbs: [
              'get',
              'list',
              'watch',
              'create',
              'update',
              'patch',
              'delete',
              'deletecollection',
            ],
          },
        ];
      case 'view':
        return [{ apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list', 'watch'] }];
      case 'self-provisioner':
        return [
          {
            apiGroups: ['project.openshift.io'],
            resources: ['projectrequests'],
            verbs: ['create'],
          },
        ];
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
            return {
              allowed: Boolean(result.allowed),
              reason: result.reason || (result.allowed ? 'allowed' : 'no RBAC policy matched'),
            };
          }
        } catch {
          /* fall through */
        }
      }
    }
    const groups = this._userGroups(targetUser);
    if (
      targetUser === 'kubeadmin' ||
      targetUser === 'system:admin' ||
      groups.includes('system:cluster-admins')
    ) {
      return { allowed: true, reason: 'cluster-admin' };
    }
    for (const binding of this._resources('ClusterRoleBinding')) {
      const subjects = binding.spec?.subjects || [];
      if (subjects.some((subject) => this._subjectMatches(subject, targetUser, groups))) {
        const roleRef = binding.spec?.roleRef || {};
        if (
          this._evaluateRules(
            this._roleRules(roleRef.kind || 'ClusterRole', roleRef.name),
            verb,
            resource
          )
        ) {
          return { allowed: true, reason: `ClusterRoleBinding ${binding.metadata?.name}` };
        }
      }
    }
    for (const binding of this._resources('RoleBinding')) {
      if (this._isNamespaced('RoleBinding') && binding.metadata?.namespace !== targetNamespace)
        continue;
      const subjects = binding.spec?.subjects || [];
      if (!subjects.some((subject) => this._subjectMatches(subject, targetUser, groups))) continue;
      const roleRef = binding.spec?.roleRef || {};
      if (
        this._evaluateRules(
          this._roleRules(roleRef.kind || 'Role', roleRef.name, targetNamespace),
          verb,
          resource
        )
      ) {
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
    if (text.startsWith('jsonpath='))
      return { format: 'jsonpath', arg: text.slice('jsonpath='.length) };
    if (text.startsWith('custom-columns='))
      return { format: 'custom-columns', arg: text.slice('custom-columns='.length) };
    if (text.startsWith('go-template='))
      return { format: 'jsonpath', arg: text.slice('go-template='.length) };
    if (text.startsWith('template='))
      return { format: 'jsonpath', arg: text.slice('template='.length) };
    if (text === 'jsonpath' || text === 'custom-columns') return { format: text, arg: null };
    if (['wide', 'yaml', 'json', 'name'].includes(text)) return { format: text, arg: null };
    return { format: 'table', arg: null };
  },

  _isAllNamespaces(flags, tokens) {
    return Boolean(
      flags.A ||
      flags['all-namespaces'] ||
      (tokens || []).includes('-A') ||
      (tokens || []).includes('--all-namespaces')
    );
  },

  _labelString(resource) {
    const labels = resource?.metadata?.labels || resource?.labels || {};
    // Real oc prints label sets sorted by key (`labels.FormatLabels`), with an
    // empty value rendered as `key=` (#41/#43).
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    if (!entries.length) return '';
    return entries.map(([key, value]) => `${key}=${value}`).join(',');
  },

  _creationAge(resource) {
    return formatAge(resource?.metadata?.creationTimestamp || resource?.creationTimestamp);
  },

  /**
   * Container name real `oc create deployment --image=<ref>` derives from an
   * image: basename after the last `/`, tag/digest stripped, RFC-1123 sanitised.
   * @param {string} image
   * @returns {string}
   */
  _containerNameForImage(image) {
    let name = String(image ?? '')
      .trim()
      .split('@')[0];
    const slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.slice(slash + 1);
    const colon = name.lastIndexOf(':');
    if (colon > 0) name = name.slice(0, colon);
    name = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (name && !/^[a-z0-9]/.test(name)) name = `c-${name}`;
    return (name || 'app').slice(0, 63).replace(/-+$/g, '') || 'app';
  },

  _containerList(resource) {
    return resource?.spec?.template?.spec?.containers || resource?.spec?.containers || [];
  },

  _podStatus(resource) {
    const phase = resource.status?.phase || resource.phase || 'Pending';
    // `oc get pods` prints Completed for phase Succeeded (real name-printer).
    const displayPhase = phase === 'Succeeded' ? 'Completed' : phase;
    const statuses = resource.status?.containerStatuses || resource.containerStatuses || [];
    // A Pod the scheduler has not bound yet has no container statuses a real
    // kubelet could have written: the name-printer shows the pod PHASE
    // (`Pending`), never `ContainerCreating`. ContainerCreating is only correct
    // once the Pod is bound to a Node and the kubelet starts setting up its
    // containers (#57). READY stays 0/N.
    if (phase === 'Pending' && !resource.spec?.nodeName) {
      const total = statuses.length || this._containerList(resource).length || 1;
      const restarts = statuses.reduce((sum, status) => sum + (status.restartCount || 0), 0);
      return { ready: `0/${total}`, status: 'Pending', restarts };
    }
    if (!statuses.length)
      return { ready: phase === 'Running' ? '1/1' : '0/1', status: displayPhase, restarts: 0 };
    const readyCount = statuses.filter((status) => status.ready).length;
    const total = statuses.length;
    let status = displayPhase;
    for (const containerStatus of statuses) {
      const waiting = containerStatus.state?.waiting?.reason;
      const terminated = containerStatus.state?.terminated;
      if (waiting) {
        status = waiting;
        break;
      }
      if (terminated && phase !== 'Succeeded' && status !== 'Completed') {
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
    const isReady = ready
      ? ready.status === 'True'
      : (resource.status?.phase || 'Running') === 'Running';
    const cordoned = Boolean(
      resource.spec?.unschedulable ?? resource.isCordoned ?? resource.unschedulable
    );
    // Real oc joins every condition-ish status with commas:
    // `Ready,SchedulingDisabled` / `NotReady,SchedulingDisabled` (issue #28).
    const statuses = [isReady ? 'Ready' : 'NotReady'];
    if (cordoned) statuses.push('SchedulingDisabled');
    return statuses.join(',');
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
    const type = resource.spec?.type || 'ClusterIP';
    const allocatesNodePort = type === 'NodePort' || type === 'LoadBalancer';
    const namespace = resource.metadata?.namespace || '';
    const name = resource.metadata?.name || '';
    return ports
      .map((port, index) => {
        const value = port.port ?? port.targetPort ?? '';
        // NodePort/LoadBalancer Services get an allocated nodePort from the
        // 30000-32767 range; `oc get svc` prints `80:31234/TCP`.
        const nodePort =
          port.nodePort ||
          (allocatesNodePort
            ? 30000 + (stableHash(`${namespace}/${name}/${index}`, 2767) >>> 0)
            : null);
        if (nodePort) return `${value}:${nodePort}/${port.protocol || 'TCP'}`;
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
          {
            header: 'NODE',
            value: (resource) => resource.spec?.nodeName || resource.status?.hostIP || '<none>',
          },
          { header: 'NOMINATED NODE', value: () => '<none>' },
          { header: 'READINESS GATES', value: () => '<none>' },
        ];
      case 'Deployment':
        return [
          {
            header: 'CONTAINERS',
            value: (resource) =>
              this._containerList(resource)
                .map((container) => container.name)
                .join(',') || '<none>',
          },
          {
            header: 'IMAGES',
            value: (resource) =>
              this._containerList(resource)
                .map((container) => container.image)
                .join(',') || '<none>',
          },
          {
            header: 'SELECTOR',
            value: (resource) => this._selectorString(resource.spec?.selector),
          },
        ];
      case 'ReplicaSet':
      case 'StatefulSet':
      case 'DaemonSet':
        return [
          {
            header: 'SELECTOR',
            value: (resource) => this._selectorString(resource.spec?.selector),
          },
        ];
      case 'Service':
        return [
          {
            header: 'SELECTOR',
            value: (resource) => this._selectorString(resource.spec?.selector, true),
          },
        ];
      case 'Node':
        return [
          { header: 'INTERNAL-IP', value: (resource) => this._nodeAddress(resource, 'InternalIP') },
          { header: 'EXTERNAL-IP', value: (resource) => this._nodeAddress(resource, 'ExternalIP') },
          {
            header: 'OS-IMAGE',
            value: (resource) => resource.status?.nodeInfo?.osImage || RHCOS_OS_IMAGE,
          },
          {
            header: 'KERNEL-VERSION',
            value: (resource) => resource.status?.nodeInfo?.kernelVersion || NODE_KERNEL_VERSION,
          },
          {
            header: 'CONTAINER-RUNTIME',
            value: (resource) => resource.status?.nodeInfo?.containerRuntimeVersion || CRIO_RUNTIME,
          },
        ];
      case 'CronJob':
        return [
          {
            header: 'CONTAINERS',
            value: (resource) =>
              this._containerList(resource)
                .map((c) => c.name)
                .join(',') || '<none>',
          },
        ];
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
          {
            header: 'SERVICEACCOUNTS',
            value: (resource) => subjectNames(resource, 'ServiceAccount'),
          },
        ];
      }
      default:
        return [];
    }
  },

  _nodeAddress(resource, type) {
    const addresses = resource.status?.addresses || [];
    const address = addresses.find((entry) => entry.type === type);
    return (
      address?.address ||
      (type === 'InternalIP'
        ? '10.0.0.' + (stableHash(resource.metadata?.name || 'node', 250) + 2)
        : '<none>')
    );
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

  /**
   * `oc status` admission annotation for a Route (#56). A Route the router has
   * not reconciled yet has no Admitted condition at all — say so instead of
   * pretending missing Service endpoints block admission (they never do, #52:
   * the router admits the Route and answers 503).
   * @param {object} resource Route
   * @returns {string}
   */
  _routeAdmissionStatusText(resource) {
    const conditions = resource.status?.ingress?.[0]?.conditions || [];
    const condition = conditions.find((entry) => entry.type === 'Admitted');
    if (!condition) return 'router default (not yet evaluated)';
    if (condition.status === 'True') return 'router default (Admitted)';
    return `router default (NOT admitted: ${condition.reason || 'rejected'})`;
  },

  /**
   * The ReplicaSet the deployment controller currently scales — the owner-linked
   * RS carrying the deployment's pod-template hash, newest first for rolling
   * updates. Used by the synthetic ScalingReplicaSet event so it prints the real
   * RS name instead of a truncated hash (#49).
   * @param {object} deployment
   * @returns {string|null}
   */
  _deploymentReplicaSetName(deployment) {
    const name = deployment?.metadata?.name;
    const namespace = deployment?.metadata?.namespace || '';
    if (!name) return null;
    const candidates = this._getKindList('ReplicaSet').filter((replicaSet) => {
      const rsMeta = replicaSet.metadata || {};
      if ((rsMeta.namespace || '') !== namespace) return false;
      const ownerNames = (rsMeta.ownerReferences || [])
        .filter((reference) => reference.kind === 'Deployment')
        .map((reference) => reference.name);
      if (ownerNames.length) return ownerNames.includes(name);
      return String(rsMeta.name || '').startsWith(`${name}-`);
    });
    if (!candidates.length) return null;
    const newestFirst = [...candidates].sort((left, right) => {
      const leftTime = Date.parse(left.metadata?.creationTimestamp || '') || 0;
      const rightTime = Date.parse(right.metadata?.creationTimestamp || '') || 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return String(right.metadata?.name || '').localeCompare(String(left.metadata?.name || ''));
    });
    return newestFirst[0].metadata?.name || null;
  },

  _buildDuration(resource) {
    const status = resource.status || {};
    const start = status.startTimestamp || status.startTime;
    const end = status.completionTimestamp || status.completionTime;
    if (start && end) {
      return formatDuration(new Date(end).getTime() - new Date(start).getTime());
    }
    if (Number(status.duration) > 0) return formatDuration(Number(status.duration) * 1000);
    if (start) return formatDuration(Date.now() - new Date(start).getTime());
    return '0s';
  },

  /**
   * `FROM` column for Build/BuildConfig rows: the builder image tag only.
   * `oc new-build nodejs:20-ubi9~https://…` stores the combined token in some
   * code paths; real oc prints `nodejs:20-ubi9` (#36).
   */
  _buildSourceLabel(resource) {
    const strategy = resource.spec?.strategy || {};
    const source = resource.spec?.source || {};
    let from = strategy.sourceStrategy?.from?.name || '';
    if (!from && strategy.dockerStrategy) from = 'Dockerfile';
    if (!from && source.git?.uri) from = 'Git';
    from = String(from).split('~')[0];
    from = from.replace(/^(?:openshift|openshift-config)\//, '');
    return from || '<none>';
  },

  /** Cells for the given kind keyed by the registry column headers. */
  _rowCells(kind, resource) {
    const name = resource.metadata?.name || resource.name || 'unknown';
    const age = this._creationAge(resource);
    switch (kind) {
      case 'Project': {
        const display =
          resource.spec?.displayName ||
          resource.metadata?.annotations?.['openshift.io/display-name'] ||
          '';
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
        return {
          NAME: name,
          READY: pod.ready,
          STATUS: pod.status,
          RESTARTS: String(pod.restarts),
          AGE: age,
        };
      }
      case 'Deployment': {
        const replicas = resource.spec?.replicas ?? 1;
        const ready = resource.status?.readyReplicas ?? 0;
        const updated = resource.status?.updatedReplicas ?? replicas;
        const available = resource.status?.availableReplicas ?? ready;
        return {
          NAME: name,
          READY: `${ready}/${replicas}`,
          'UP-TO-DATE': String(updated),
          AVAILABLE: String(available),
          AGE: age,
        };
      }
      case 'ReplicaSet': {
        const desired = resource.spec?.replicas ?? 0;
        const current = resource.status?.replicas ?? desired;
        const ready = resource.status?.readyReplicas ?? 0;
        return {
          NAME: name,
          DESIRED: String(desired),
          CURRENT: String(current),
          READY: String(ready),
          AGE: age,
        };
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
        return {
          NAME: name,
          STATUS: status,
          COMPLETIONS: `${succeeded}/${completions}`,
          DURATION: this._buildDuration(resource),
          AGE: age,
        };
      }
      case 'CronJob': {
        const active = resource.status?.active?.length ?? 0;
        const last = resource.status?.lastScheduleTime;
        return {
          NAME: name,
          SCHEDULE: resource.spec?.schedule || '0 0 * * *',
          TIMEZONE: resource.spec?.timeZone || '<none>',
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
          PATH: resource.spec?.path || '',
          SERVICES: resource.spec?.to?.name || '<none>',
          PORT: resource.spec?.port?.targetPort ?? '<all>',
          TERMINATION: tls ? tls.termination || '' : '',
          WILDCARD: resource.spec?.wildcardPolicy || 'None',
        };
      }
      case 'Ingress': {
        const rules = resource.spec?.rules || [];
        const hosts =
          rules
            .map((rule) => rule.host)
            .filter(Boolean)
            .join(',') || '*';
        const conditions = resource.status?.loadBalancer?.ingress || [];
        const address =
          conditions
            .map((entry) => entry.ip || entry.hostname)
            .filter(Boolean)
            .join(',') || '<none>';
        return {
          NAME: name,
          CLASS: resource.spec?.ingressClassName || '<none>',
          HOSTS: hosts,
          ADDRESS: address,
          PORTS: resource.spec?.tls?.length ? '80, 443' : '80',
          AGE: age,
        };
      }
      case 'NetworkPolicy': {
        return {
          NAME: name,
          'POD-SELECTOR': this._selectorString(resource.spec?.podSelector),
          AGE: age,
        };
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
        const capacity =
          resource.status?.capacity?.storage || resource.spec?.resources?.requests?.storage || '';
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
          CLAIM: resource.spec?.claimRef
            ? `${resource.spec.claimRef.namespace || 'default'}/${resource.spec.claimRef.name}`
            : '',
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
        const metrics = resource.status?.currentMetrics || [];
        const sampled =
          metrics[0]?.resource?.current?.averageUtilization ??
          resource.status?.currentCPUUtilizationPercentage;
        const current = sampled === undefined || sampled === null ? '<unknown>' : `${sampled}%`;
        return {
          NAME: name,
          REFERENCE: `${(target.kind || 'Deployment').toLowerCase()}/${target.name || 'app'}`,
          TARGETS: `${current}/${targetMetric ?? 50}%`,
          MINPODS: String(resource.spec?.minReplicas ?? 1),
          MAXPODS: String(resource.spec?.maxReplicas ?? 10),
          REPLICAS: String(
            resource.status?.currentReplicas ??
              resource.status?.replicas ??
              resource.spec?.minReplicas ??
              1
          ),
          AGE: age,
        };
      }
      case 'PodDisruptionBudget': {
        const allowed =
          resource.status?.disruptionsAllowed ??
          Math.max(0, (resource.spec?.minAvailable ?? 1) - 0);
        return {
          NAME: name,
          'MIN AVAILABLE':
            resource.spec?.minAvailable !== undefined ? String(resource.spec.minAvailable) : 'N/A',
          'MAX UNAVAILABLE':
            resource.spec?.maxUnavailable !== undefined
              ? String(resource.spec.maxUnavailable)
              : 'N/A',
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
          'CREATED AT': formatAge(
            resource.metadata?.creationTimestamp || resource.creationTimestamp
          ),
        };
      }
      case 'ClusterResourceQuota': {
        const hard = resource.spec?.quota?.hard || resource.spec?.hard || {};
        const used = resource.status?.total?.used || {};
        return {
          NAME: name,
          AGE: age,
          REQUEST: this._quotaColumn(hard, used, 'request'),
          LIMIT: this._quotaColumn(hard, used, 'limit'),
        };
      }
      case 'Role':
      case 'ClusterRole': {
        return {
          NAME: name,
          'CREATED AT': formatAge(
            resource.metadata?.creationTimestamp || resource.creationTimestamp
          ),
        };
      }
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        const subjects = resource.spec?.subjects || [];
        const byKind = (kindName) =>
          subjects
            .filter((subject) => subject.kind === kindName)
            .map((subject) => subject.name)
            .join(',');
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
          VOLUMES: spec.allowHostDirVolumePlugin
            ? 'configMap,downwardAPI,emptyDir,hostPath,persistentVolumeClaim,projected,secret'
            : 'configMap,downwardAPI,emptyDir,persistentVolumeClaim,projected,secret',
        };
      }
      case 'User': {
        const identities = resource.spec?.identities || resource.identities || [];
        return {
          NAME: name,
          UID: resource.metadata?.uid || '',
          'FULL NAME': resource.spec?.fullName || '',
          IDENTITIES:
            identities
              .map((identity) => `${identity.providerName}:${identity.providerUserName}`)
              .join(',') || '',
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
        return {
          NAME: name,
          TYPE: strategy.type || 'Source',
          FROM: this._buildSourceLabel(resource),
          LATEST: String(resource.status?.lastVersion ?? 0),
        };
      }
      case 'Build': {
        const strategy = resource.spec?.strategy || {};
        const started = resource.status?.startTimestamp || resource.status?.startTime;
        return {
          NAME: name,
          TYPE: strategy.type || 'Source',
          FROM: this._buildSourceLabel(resource),
          STATUS: resource.status?.phase || 'New',
          STARTED: started && resource.status?.phase !== 'New' ? formatAge(started) : '<none>',
          DURATION: this._buildDuration(resource),
        };
      }
      case 'ImageStream': {
        const tags = resource.status?.tags || resource.spec?.tags || [];
        const repository =
          resource.status?.dockerImageRepository ||
          `${INTERNAL_REGISTRY}/${resource.metadata?.namespace || 'default'}/${name}`;
        const tagNames = tags
          .map((tag) => tag.tag || tag.name)
          .filter(Boolean)
          .join(',');
        return {
          NAME: name,
          'IMAGE REPOSITORY': repository,
          TAGS: tagNames || '<none>',
          UPDATED: age,
        };
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
          SINCE: available?.lastTransitionTime
            ? formatAge(available.lastTransitionTime)
            : formatAge(resource.metadata?.creationTimestamp),
        };
      }
      case 'ClusterVersion': {
        const version =
          resource.status?.desired?.version || resource.spec?.desired?.version || OCP_VERSION;
        const conditions = resource.status?.conditions || [];
        const progress = conditions.find((entry) => entry.type === 'Progressing');
        const available = conditions.find((entry) => entry.type === 'Available');
        return {
          NAME: name,
          VERSION: version,
          AVAILABLE: this._booleanCell(available ? available.status === 'True' : true),
          PROGRESSING: this._booleanCell(progress ? progress.status === 'True' : false),
          SINCE: available?.lastTransitionTime
            ? formatAge(available.lastTransitionTime)
            : formatAge(resource.metadata?.creationTimestamp),
          STATUS: progress?.message || `Done applying ${OCP_VERSION}`,
        };
      }
      case 'OAuth': {
        return { NAME: name, AGE: age };
      }
      case 'OperatorGroup': {
        return { NAME: name, AGE: age };
      }
      case 'InstallPlan': {
        return {
          NAME: name,
          CSV: (resource.spec?.clusterServiceVersionNames || []).join(','),
          APPROVAL: resource.spec?.approval || 'Automatic',
          APPROVED: this._booleanCell(resource.spec?.approved === true),
        };
      }
      case 'ClusterServiceVersion': {
        const version = resource.spec?.version;
        return {
          NAME: name,
          DISPLAY: resource.spec?.displayName || '<none>',
          VERSION:
            typeof version === 'object' && version
              ? version.version || '<none>'
              : version || '<none>',
          REPLACES: resource.spec?.replaces || '',
          PHASE: this._genericStatus(resource),
        };
      }
      case 'PackageManifest': {
        // Real `oc get packagemanifests` columns are NAME, CATALOG, AGE (#46).
        return {
          NAME: name,
          CATALOG: resource.status?.catalogSource || '<none>',
          AGE: age,
        };
      }
      case 'MetalLB': {
        return { NAME: name, AGE: age };
      }
      case 'PrometheusRule': {
        return { NAME: name, AGE: age };
      }
      case 'Alertmanager': {
        return {
          NAME: name,
          VERSION: resource.spec?.version || '<none>',
          REPLICAS: String(resource.status?.replicas ?? resource.spec?.replicas ?? 0),
          AGE: age,
        };
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
      const ready = conditions.find((condition) =>
        ['Ready', 'Available', 'Established'].includes(condition.type)
      );
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
      const row = baseHeaders.map((header) =>
        cells[header] !== undefined ? String(cells[header]) : ''
      );
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
      const object =
        single && resources.length === 1
          ? this._manifestFor(resources[0])
          : this._listManifest(kind, resources);
      if (output.format === 'json') return JSON.stringify(object, null, 4);
      return toYamlDocument(object);
    }
    if (output.format === 'name') {
      return resources
        .map(
          (resource) => `${this._singularName(kind)}/${resource.metadata?.name || resource.name}`
        )
        .join('\n');
    }
    if (output.format === 'jsonpath') {
      if (!output.arg) {
        return this._err(
          `error: jsonpath requires a template, e.g. -o jsonpath='{.items[*].metadata.name}'`
        );
      }
      const subject =
        single && resources.length === 1
          ? this._manifestFor(resources[0])
          : { kind: 'List', items: resources.map((resource) => this._manifestFor(resource)) };
      return evaluateJsonPath(subject, output.arg);
    }
    if (output.format === 'custom-columns') {
      if (!output.arg)
        return this._err(
          'error: custom-columns requires a template, e.g. -o custom-columns=NAME:.metadata.name'
        );
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
        rows
      );
    }
    return this._tableFor(kind, resources, {
      wide: output.format === 'wide',
      showLabels: Boolean(flags['show-labels']),
      noHeaders: Boolean(flags['no-headers']),
      namespaceColumn: Boolean(options.allNamespaces) && this._isNamespaced(kind),
      // Multi-type requests print `<resource>.<group>/<name>` in the NAME cell
      // (`deployment.apps/web`, `job.batch/nightly`) like real oc (#43).
      namePrefix: Boolean(options.namePrefix),
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
      // Simulator book-keeping in `openshiftgames*` annotations/finalizers is
      // never part of the real API object and must not leak to the CLI (#23).
      return stripInternalCliMetadata(toManifestObject(resource, { apiView: true }));
    } catch {
      return stripInternalCliMetadata({
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
      });
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
    const path = String(sortBy)
      .replace(/^\{|\}$/g, '')
      .replace(/^\./, '');
    const segments = path.split('.').filter(Boolean);
    return [...resources].sort((left, right) => {
      const a = resolvePathValue(left, segments);
      const b = resolvePathValue(right, segments);
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a ?? '').localeCompare(String(b ?? ''));
    });
  },

  /**
   * Default ordering of a list request: the API server returns objects sorted
   * by namespace/name (etcd key order), so `oc get secrets`, `oc get pods`, …
   * are always name-sorted like a real cluster (#43). `--sort-by` overrides it.
   * @param {any[]} resources
   * @returns {any[]}
   */
  _sortResourcesByName(resources) {
    return [...resources].sort((left, right) => {
      const leftNamespace = String(left.metadata?.namespace || '');
      const rightNamespace = String(right.metadata?.namespace || '');
      if (leftNamespace !== rightNamespace) return leftNamespace.localeCompare(rightNamespace);
      // Plain lexicographic order, like the API server's namespace/name sort.
      return String(left.metadata?.name || '').localeCompare(String(right.metadata?.name || ''));
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

    // 2. Pod failure events (Warning). The kubelet lifecycle stream
    // (Scheduled → Pulling → Pulled → Created → Started) is recorded by the
    // engine's real event recorder (#54e); synthesizing Scheduled/Pulling/
    // Pulled/Created/Started/Ready here as well made `oc describe pod` print a
    // duplicate, wrongly ordered stream. Warning events stay synthetic.
    for (const pod of this._getKindList('Pod')) {
      const name = pod.metadata?.name;
      if (!name) continue;
      const podNamespace = pod.metadata?.namespace || 'default';
      const created = pod.metadata?.creationTimestamp
        ? new Date(pod.metadata.creationTimestamp).getTime()
        : Date.now() - 300000;
      const podStatus = this._podStatus(pod);
      const phase = pod.status?.phase || 'Pending';
      const failedStatus =
        phase === 'Failed' ||
        /BackOff|Error|ImagePull|CreateContainer|CrashLoop/.test(podStatus.status);
      if (!failedStatus) continue;
      push({
        lastTimestamp: created + 12000,
        type: 'Warning',
        reason: podStatus.status === 'ImagePullBackOff' ? 'Failed' : 'BackOff',
        object: `pod/${name}`,
        subobject: '',
        source: 'kubelet',
        message:
          podStatus.status === 'ImagePullBackOff'
            ? 'Failed to pull image: manifest unknown'
            : 'Back-off restarting failed container',
        namespace: podNamespace,
      });
    }

    // 3. Deployment scaling events.
    for (const deployment of this._getKindList('Deployment')) {
      const name = deployment.metadata?.name;
      if (!name) continue;
      const created = deployment.metadata?.creationTimestamp
        ? new Date(deployment.metadata.creationTimestamp).getTime()
        : Date.now() - 240000;
      // The deployment controller scales the *new* ReplicaSet and records its
      // real name (`Scaled up replica set web-5d8f7c9b6 to 2`). Before the
      // controller has ticked (paused pre-start sandbox) there is no RS object
      // yet, so predict the exact name it will get from the pod template hash —
      // never a truncated numeric placeholder (#49, #58).
      const replicaSetName =
        this._deploymentReplicaSetName(deployment) || deploymentReplicaSetName(deployment);
      const replicas = deployment.spec?.replicas ?? 1;
      push({
        lastTimestamp: created + 3000,
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        object: `deployment/${name}`,
        subobject: '',
        source: 'deployment-controller',
        message: `Scaled ${replicas <= 0 ? 'down' : 'up'} replica set ${replicaSetName} to ${replicas}`,
        namespace: deployment.metadata?.namespace || 'default',
      });
    }

    // 4. Build events.
    for (const build of this._getKindList('Build')) {
      const name = build.metadata?.name;
      if (!name) continue;
      const phase = build.status?.phase || 'New';
      const started = build.status?.startTimestamp
        ? new Date(build.status.startTimestamp).getTime()
        : Date.now() - 90000;
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
        push({
          lastTimestamp: started + 9000,
          type: 'Normal',
          reason: 'BuildCompleted',
          object: `build/${name}`,
          subobject: '',
          source: 'build-controller',
          message: `Build ${name} completed successfully`,
          namespace: build.metadata?.namespace || 'default',
        });
      } else if (phase === 'Failed') {
        push({
          lastTimestamp: started + 9000,
          type: 'Warning',
          reason: 'BuildFailed',
          object: `build/${name}`,
          subobject: '',
          source: 'build-controller',
          message: build.status?.message || `Build ${name} failed`,
          namespace: build.metadata?.namespace || 'default',
        });
      }
    }

    // 5. Route admission events.
    for (const route of this._getKindList('Route')) {
      const name = route.metadata?.name;
      if (!name) continue;
      const created = route.metadata?.creationTimestamp
        ? new Date(route.metadata.creationTimestamp).getTime()
        : Date.now() - 180000;
      // The router records the admission event with the same reason/message as
      // the Admitted condition it sets on the Route (#49): a route rejected for
      // an unreadable externalCertificate reports ExternalCertificateValidationFailed,
      // a host-claim conflict reports HostAlreadyClaimed (#52).
      const condition =
        (route.status?.ingress?.[0]?.conditions || []).find(
          (candidate) => candidate.type === 'Admitted'
        ) || null;
      // Before the router's first reconcile the Route has no Admitted condition
      // and the router has published no event: omit the row entirely rather than
      // fabricate a rejection. The old fallback here invented an admission
      // failure out of missing endpoints, contradicting the fixed #52 semantics
      // (missing endpoints never block admission — the router admits the Route
      // and answers 503 for it).
      if (!condition) continue;
      const admitted = condition.status === 'True';
      const rejectionReason = condition.reason || 'Rejected';
      const rejectionMessage =
        condition.message || condition.reason || 'route rejected by the router';
      push({
        lastTimestamp: created + 2000,
        type: admitted ? 'Normal' : 'Warning',
        reason: admitted ? 'Admitted' : rejectionReason,
        object: `route/${name}`,
        subobject: '',
        source: 'router',
        message: admitted
          ? `Route ${name} admitted by router default`
          : `Route ${name} not admitted: ${rejectionMessage}`,
        namespace: route.metadata?.namespace || 'default',
      });
    }

    // 6. Operator subscription events.
    for (const subscription of this._getKindList('Subscription')) {
      const name = subscription.metadata?.name;
      if (!name) continue;
      const created = subscription.metadata?.creationTimestamp
        ? new Date(subscription.metadata.creationTimestamp).getTime()
        : Date.now() - 420000;
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

    // 7. ReplicaSet admission/creation failures (e.g. restricted-v2 SCC
    // rejection) are real Warning FailedCreate events; surface them so
    // `oc get events --field-selector reason=FailedCreate` returns data.
    for (const replicaSet of this._getKindList('ReplicaSet')) {
      const name = replicaSet.metadata?.name;
      if (!name) continue;
      const replicaNamespace = replicaSet.metadata?.namespace || 'default';
      const created = replicaSet.metadata?.creationTimestamp
        ? new Date(replicaSet.metadata.creationTimestamp).getTime()
        : Date.now() - 60000;
      for (const condition of replicaSet.status?.conditions || []) {
        const failedCreate =
          /FailedCreate/i.test(String(condition.reason || '')) ||
          (condition.type === 'ReplicaFailure' && condition.status === 'True');
        if (!failedCreate) continue;
        // Real ReplicaSet-controller FailedCreate events always carry the
        // `Error creating: ` prefix (the RS condition message does not) (#43).
        const conditionMessage = String(
          condition.message || `pods for ${name} were rejected`
        ).replace(/^Error creating:\s*/, '');
        push({
          lastTimestamp: condition.lastTransitionTime
            ? new Date(condition.lastTransitionTime).getTime()
            : created + 5000,
          type: 'Warning',
          reason: condition.reason || 'FailedCreate',
          object: `replicaset/${name}`,
          subobject: '',
          source: 'replicaset-controller',
          message: `Error creating: ${conditionMessage}`,
          namespace: replicaNamespace,
        });
      }
    }

    events.sort((a, b) => a.lastTimestamp - b.lastTimestamp);
    return events.slice(-40);
  },

  /** Merge runtime-recorded events (issue #21: SCC FailedCreate etc.). */
  _runtimeEvents({ namespace, allNamespaces }) {
    const sim = this.gameEngine?.simulation;
    if (!sim || typeof sim.getEvents !== 'function') return [];
    let raw = [];
    try {
      raw = sim.getEvents({ namespace, allNamespaces: Boolean(allNamespaces) }) || [];
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.map((event) => {
      const involved = event.involvedObject || {};
      const object =
        event.object ||
        (involved.kind ? `${String(involved.kind).toLowerCase()}/${involved.name || ''}` : '');
      const timestamp = event.lastTimestamp ? new Date(event.lastTimestamp).getTime() : Date.now();
      const firstRaw = event.firstTimestamp ?? event.lastTimestamp;
      const firstTimestamp = firstRaw ? new Date(firstRaw).getTime() : timestamp;
      return {
        lastTimestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : timestamp,
        type: event.type || 'Normal',
        reason: event.reason || '',
        object,
        subobject: '',
        source: event.source || involved.kind || '',
        message: event.message || '',
        namespace: event.namespace || involved.namespace || namespace,
        count: event.count,
      };
    });
  },

  /**
   * Aggregate repeated events of the same TYPE/OBJECT/REASON into one series row,
   * the way a controller retry burst is folded into a single Event (#26). The
   * LAST SEEN column then shows `(xN over <age of first occurrence>)` — the real
   * K8s aggregation format, not a first→last delta (which printed the bogus
   * `(x2 over 0s)`, #43).
   */
  _aggregateEvents(events) {
    const groups = new Map();
    for (const event of events || []) {
      const lastTimestamp = this._eventTimestamp(event.lastTimestamp);
      const firstTimestamp = this._eventTimestamp(
        event.firstTimestamp ?? event.lastTimestamp,
        lastTimestamp
      );
      const count = Math.max(1, Number(event.count) || 1);
      const key = `${event.type || 'Normal'}|${event.object || ''}|${event.reason || ''}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { ...event, count, lastTimestamp, firstTimestamp });
        continue;
      }
      existing.count += count;
      existing.firstTimestamp = Math.min(existing.firstTimestamp, firstTimestamp);
      if (lastTimestamp >= existing.lastTimestamp) {
        existing.lastTimestamp = lastTimestamp;
        existing.message = event.message;
        existing.subobject = event.subobject || existing.subobject;
        existing.source = event.source || existing.source;
      }
    }
    return [...groups.values()].sort((left, right) => left.lastTimestamp - right.lastTimestamp);
  },

  /**
   * Merge synthetic lifecycle events with the runtime event recorder (which is
   * authoritative for controller-recorded events). A runtime event wins over
   * the synthetic reconstruction of the same event (same TYPE/OBJECT/REASON),
   * so e.g. the quota FailedCreate is described once, with the real
   * `Error creating: …` message (#43).
   * @param {object[]} synthetic
   * @param {object[]} runtime
   * @returns {object[]}
   */
  _mergeEventStreams(synthetic, runtime) {
    const runtimeKeys = new Set(
      (runtime || []).map(
        (event) => `${event.type || 'Normal'}|${event.object || ''}|${event.reason || ''}`
      )
    );
    const merged = (synthetic || []).filter(
      (event) =>
        !runtimeKeys.has(`${event.type || 'Normal'}|${event.object || ''}|${event.reason || ''}`)
    );
    merged.push(...(runtime || []));
    const seen = new Set();
    return merged.filter((event) => {
      const key = `${event.type || 'Normal'}|${event.object || ''}|${event.reason || ''}|${event.source || ''}|${event.message || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  _eventTimestamp(value, fallback = Date.now()) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    const parsed = new Date(value ?? fallback).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  },

  _filterEvents(events, flags) {
    let result = events;
    const fieldSelector = flags['field-selector'];
    if (fieldSelector && fieldSelector !== true) {
      const requirements = String(fieldSelector)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
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
        })
      );
    }
    if (flags['sort-by'] && flags['sort-by'] !== true) {
      const path = String(flags['sort-by'])
        .replace(/^\{|\}$/g, '')
        .replace(/^\./, '');
      const key =
        path === 'lastTimestamp' || path === 'metadata.creationTimestamp' ? 'lastTimestamp' : path;
      result = [...result].sort((a, b) => {
        const left =
          key === 'lastTimestamp' ? a.lastTimestamp : resolvePathValue(a, key.split('.'));
        const right =
          key === 'lastTimestamp' ? b.lastTimestamp : resolvePathValue(b, key.split('.'));
        return typeof left === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''));
      });
    }
    return result;
  },

  _formatEvents(events, flags, options = {}) {
    const output = this._outputFormat(flags);
    if (['yaml', 'json'].includes(output.format)) {
      const manifests = events.map((event) => this._eventManifest(event));
      if (output.format === 'json')
        return JSON.stringify(
          { apiVersion: 'v1', kind: 'List', metadata: {}, items: manifests },
          null,
          4
        );
      return toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: manifests });
    }
    if (output.format === 'name') {
      return events.map((event) => `event/${this._eventName(event)}`).join('\n');
    }
    // Real oc/K8s 1.35 event printer: LAST SEEN, TYPE, REASON, OBJECT, MESSAGE
    // (SUBOBJECT/SOURCE/NAMESPACE are only shown in wide/all-namespaces output).
    // Repeated occurrences of the same Event are folded into one Event series,
    // shown as `LAST SEEN (xN over <age of first occurrence>)` — never a
    // first→last delta, which printed the bogus `(x2 over 0s)` (#43).
    const aggregated = this._aggregateEvents(events);
    const wideEvents = output.format === 'wide' || Boolean(options.namespaceColumn);
    const headers = ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
    const rows = aggregated.map((event) => {
      let lastSeen = formatAge(event.lastTimestamp);
      if (event.count > 1) {
        lastSeen = `${lastSeen} (x${event.count} over ${formatAge(event.firstTimestamp)})`;
      }
      return [
        lastSeen,
        event.type || 'Normal',
        event.reason || '',
        event.object || '',
        event.message || '',
      ];
    });
    if (wideEvents) {
      headers.splice(4, 0, 'SUBOBJECT', 'SOURCE');
      rows.forEach((row, index) =>
        row.splice(4, 0, aggregated[index].subobject || '', aggregated[index].source || '')
      );
    }
    if (options.namespaceColumn) {
      headers.push('NAMESPACE');
      rows.forEach((row, index) => row.push(aggregated[index].namespace || ''));
    }
    if (flags['show-labels']) (headers.push('LABELS'), rows.forEach((row) => row.push('<none>')));
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
      involvedObject: {
        kind: objectKind || 'Pod',
        name: objectName || name,
        namespace: event.namespace || this.currentProject,
      },
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
    const namespace = resource.metadata?.namespace;
    // Synthetic lifecycle events + runtime controller events (SCC FailedCreate …).
    // Runtime wins for the same event, so describe shows it once (#43).
    const events = this._mergeEventStreams(
      this._syntheticEvents({ namespace }),
      this._runtimeEvents({ namespace, allNamespaces: false })
    );
    return events.filter((event) => {
      const eventObject = event.object || '';
      let related = eventObject === object;
      // A Deployment's ReplicaSet controller records FailedCreate/Scaling events
      // on the ReplicaSet; `oc describe deployment` still surfaces them (#36).
      if (!related && kind === 'Deployment' && eventObject.startsWith('replicaset/')) {
        const rsName = eventObject.slice('replicaset/'.length);
        related = Boolean(name) && rsName.startsWith(`${name}-`);
      }
      return related;
    });
  },

  _eventsSection(kind, resource) {
    // Shared with the resource-level describe (real Type/Reason/Age/From/Message
    // table, identical events aggregated as `2m (x10 over 1m)`).
    return describeEventLines(this._eventsForResource(kind, resource)).join('\n');
  },

  /** Render `oc describe` output for a resource (rich toDescribe when available). */
  _describeResource(kind, resource) {
    let output = '';
    if (typeof resource.toDescribe === 'function') {
      try {
        // Resource classes resolve owner-linked children (Pod -> Node,
        // Deployment -> ReplicaSets) from the cluster when it is available.
        output = resource.toDescribe({ cluster: this.cluster });
      } catch {
        output = '';
      }
    }
    if (!output || typeof output !== 'string')
      output = this._describeLines(kind, resource).join('\n');
    output = scrubInternalAnnotationsText(output);
    // Real 4.22 `oc describe quota` prints only the Resource/Used/Hard table —
    // no Events section (#43).
    if (kind === 'ResourceQuota' || kind === 'ClusterResourceQuota') {
      const eventsAt = output.search(/^Events:/m);
      if (eventsAt >= 0) output = output.slice(0, eventsAt).replace(/\s+$/, '');
      return output;
    }
    // The Events table is always the last block of a describe. Rich resource
    // describes hard-code a placeholder (`Events:  <none>`) or their own table;
    // replace everything from that header to the end with the live events block
    // so the table can never be printed twice (#36/#43).
    const liveSection = this._eventsSection(kind, resource);
    const eventsAt = output.search(/^Events:/m);
    if (eventsAt < 0) output += `\n${liveSection}`;
    else output = `${output.slice(0, eventsAt)}${liveSection}`;
    return output;
  },

  _describeLines(kind, resource) {
    const metadata = resource.metadata || {};
    const spec = resource.spec || {};
    const status = resource.status || {};
    const lines = [];
    const push = (...entries) => lines.push(...entries);
    const labels = this._labelString(resource) || '<none>';
    const annotations =
      Object.entries(visibleAnnotations(metadata.annotations))
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || '<none>';

    switch (kind) {
      case 'Project': {
        push(
          `Name:           ${metadata.name}`,
          `Display Name:   ${spec.displayName || metadata.annotations?.['openshift.io/display-name'] || '<none>'}`,
          `Description:    ${spec.description || metadata.annotations?.['openshift.io/description'] || '<none>'}`,
          `Status:         ${status.phase || 'Active'}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`
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
          `Path:                   ${spec.path || ''}`,
          `TLS Termination:        ${spec.tls?.termination || '<none>'}`,
          `Insecure Policy:        ${spec.tls?.insecureEdgeTerminationPolicy || 'None'}`,
          `Endpoint Port:          ${spec.port?.targetPort ?? '<all>'}`,
          `Service:                ${spec.to?.kind || 'Service'}/${spec.to?.name || '<none>'}`,
          `Weight:                 ${spec.to?.weight ?? 100}`,
          `Wildcard Policy:        ${spec.wildcardPolicy || 'None'}`,
          '',
          'Router:',
          `  Router Name:          ${router.routerName || 'default'}`,
          `  Host:                 ${router.host || this._routeHost(resource)}`
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
              `    Last Transition:    ${condition.lastTransitionTime ? formatAge(condition.lastTransitionTime) : '<unknown>'}`
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
          ...(spec.triggers || []).map(
            (trigger) =>
              `  ${trigger.type}${trigger.imageChange?.from?.name ? ` - ${trigger.imageChange.from.name}` : ''}`
          ),
          '',
          `Run Policy:     ${spec.runPolicy || 'Serial'}`,
          `Latest Version: ${status.lastVersion ?? 0}`
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
          `Message:        ${status.message || '<none>'}`
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
            : ['  <none>'])
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
            ? parameters.map(
                (parameter) =>
                  `  ${parameter.name}\t${parameter.displayName || ''}\t${parameter.required ? 'required' : 'optional'}\t${parameter.value ?? ''}`
              )
            : ['  <none>']),
          '',
          `Objects:        ${objects.length}`,
          `Message:        ${spec.message || '<none>'}`
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
          `  Installed CSV:        ${status.installedCSV || '<none>'}`
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
          `  ${s.allowHostDirVolumePlugin ? 'hostPath' : 'configMap, downwardAPI, emptyDir, persistentVolumeClaim, projected, secret'}`
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
          ...Object.keys(hard).map(
            (key) => `${key.padEnd(17)}${String(used[key] ?? '0').padEnd(7)}${hard[key]}`
          )
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
                  `${String(limit.type).padEnd(12)}${resource.padEnd(10)}${(limit.min?.[resource] || '<none>').toString().padEnd(5)}${(limit.max?.[resource] || '<none>').toString().padEnd(5)}${(limit.defaultRequest?.[resource] || '<none>').toString().padEnd(17)}${(limit.default?.[resource] || '<none>').toString().padEnd(15)}${limit.maxLimitRequestRatio?.[resource] || '<none>'}`
              )
              .join('\n');
          })
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
          'Label Selector:',
          ...(Object.keys(matchLabels).length
            ? Object.entries(matchLabels).map(([key, value]) => `${key}=${value}`)
            : ['<none>']),
          '',
          'Resource         Used   Hard',
          '--------         ----   ----',
          ...Object.keys(hard).map(
            (key) => `${key.padEnd(17)}${String(used[key] ?? '0').padEnd(7)}${hard[key]}`
          )
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
          `Groups:         ${(spec.groups || []).join(', ') || '<none>'}`
        );
        break;
      }
      case 'Group': {
        push(
          `Name:           ${metadata.name}`,
          `Labels:         ${labels}`,
          `Annotations:    ${annotations}`,
          `Users:          ${(spec.users || []).join(', ') || '<none>'}`
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
              `    Type:                ${condition.type}\n    Status:              ${condition.status}\n    Reason:              ${condition.reason || ''}\n    Message:             ${condition.message || ''}`
          ),
          '  Versions:',
          ...(status.versions || []).map(
            (version) =>
              `    Name:                ${version.name}\n    Version:             ${version.version}`
          )
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
              `    Type:                ${condition.type}\n    Status:              ${condition.status}\n    Reason:              ${condition.reason || ''}\n    Message:             ${condition.message || ''}`
          )
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
                  `  Name:  ${idp.name}\n  Type:  ${idp.type}${idp.htpasswd?.fileData?.name ? `\n  File Data:\n    Name:  ${idp.htpasswd.fileData.name}` : ''}`
              )
            : ['  <none>'])
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
          ...Object.entries(spec).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
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
              `  ${condition.type.padEnd(17)}${condition.status.padEnd(8)}${String(condition.lastHeartbeatTime || '').padEnd(34)}${condition.reason || ''}`
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
          `Taints:         ${(spec.taints || []).map((taint) => `${taint.key}=${taint.value || ''}:${taint.effect}`).join(', ') || '<none>'}`
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
          `Endpoints:         ${this._serviceEndpoints(resource)}`
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
            (container) =>
              `  ${container.name}:\n    Image:      ${container.image}\n    Port:       ${(container.ports || []).map((port) => port.containerPort).join(',') || '<none>'}`
          )
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
            (container) =>
              `  ${container.name}:\n    Image:          ${container.image}\n    Port:           ${(container.ports || []).map((port) => port.containerPort).join(',') || '<none>'}\n    Ready:          ${(status.containerStatuses || []).find((entry) => entry.name === container.name)?.ready ?? 'Unknown'}\n    Restart Count:  ${(status.containerStatuses || []).find((entry) => entry.name === container.name)?.restartCount ?? 0}`
          )
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
          ...Object.keys(data).map(
            (key) => `${key}: ${secret ? `${String(data[key]).length} bytes` : data[key]}`
          ),
          ...(Object.keys(data).length ? [] : ['<none>'])
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
          `Access Modes:  ${(spec.accessModes || []).join(',') || '<none>'}`
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
          `Deployment pods: ${status.currentReplicas ?? 1} current / ${status.desiredReplicas ?? 1} desired`
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
          ...(spec.ingress?.length
            ? spec.ingress.map(
                (rule) =>
                  `  To Port: ${JSON.stringify(rule.ports || 'all')}\n  From: ${JSON.stringify(rule.from || 'all')}`
              )
            : ['  <none> (default deny)']),
          `Policy Types: ${(spec.policyTypes || []).join(', ')}`
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
          `Pods Statuses: ${status.active ?? 0} Active / ${status.succeeded ?? 0} Succeeded / ${status.failed ?? 0} Failed`
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
            (rule) =>
              `  Host: ${rule.host || '*'}\n    Path: ${(rule.http?.paths || []).map((path) => `${path.path} -> ${path.backend?.service?.name}:${path.backend?.service?.port?.number || 80}`).join(', ')}`
          )
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
          `Tokens:              <none> (bound tokens are projected into pods)`
        );
        break;
      }
      case 'Role':
      case 'ClusterRole': {
        const rules = (spec.rules || resource.rules || []).map(
          (rule) =>
            `  Resources: ${(rule.resources || []).join(',')}\n  Verbs:     ${(rule.verbs || []).join(',')}`
        );
        push(
          `Name:         ${metadata.name}`,
          `Namespace:    ${metadata.namespace || ''}`,
          `Labels:       ${labels}`,
          `Annotations:  ${annotations}`,
          '',
          'PolicyRule:',
          ...(rules.length ? rules : ['  <none>'])
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
          ...(spec.subjects || []).map(
            (subject) =>
              `  ${String(subject.kind).padEnd(16)}${String(subject.name).padEnd(46)}${subject.namespace || ''}`
          )
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
          `Created:      ${metadata.creationTimestamp || '<unknown>'}`
        );
        if (Object.keys(spec).length) {
          push(
            '',
            'Spec:',
            ...Object.entries(spec).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
          );
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
    return ready
      .map(
        (pod) =>
          `${pod.status?.podIP || '10.128.0.' + (stableHash(pod.metadata?.name || 'pod', 250) + 2)}:${resource.spec?.ports?.[0]?.targetPort || resource.spec?.ports?.[0]?.port || 8080}`
      )
      .join(',');
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
      longBools: [
        'all-namespaces',
        'show-labels',
        'no-headers',
        'watch',
        'all',
        'ignore-not-found',
      ],
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
    return this._err(
      'Error from server (NotFound): the server could not find the requested resource'
    );
  },

  _cmdGet(tokens) {
    const { positionals, flags, tokens: rawTokens } = parseArgs(tokens, this._getFlagSpec());
    const rawPath = flags.raw && flags.raw !== true ? String(flags.raw) : null;
    if (rawPath) return this._cmdGetRaw(rawPath);
    if (flags.raw === true) {
      return this._err('error: --raw requires a server path (for example: oc get --raw /version)');
    }
    if (!positionals.length) {
      return this._err(
        "error: You must specify the type of resource to get.\n\nUsage:\n  oc get <resource> [<name>] [flags]\n\nRun 'oc get --help' for details."
      );
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
    // `oc get ns` prints the Kubernetes Namespace layout (NAME STATUS AGE),
    // while `oc get projects` keeps the OpenShift Project layout.
    if (['ns', 'namespace', 'namespaces'].includes(lower)) {
      return this._getNamespaceView({ name, output, flags });
    }

    // Real oc: a namespaced request scoped to a nonexistent namespace fails with
    // the API server's namespace NotFound before any empty-list rendering.
    if (!allNamespaces && this._getRequestUsesNamespace(resourceToken)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }

    if (['event', 'events', 'ev'].includes(lower)) return this._cmdGetEvents(tokens);

    const virtual = this._virtualViewGet(resourceToken, {
      name,
      flags,
      output,
      allNamespaces,
      namespace,
    });
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
      // `endpoints` is a virtual view (endpoints are synthesized from Services);
      // accept it in multi-resource requests too, e.g. `oc get pods,endpoints,route`
      // (#52 — it used to fail with "the server doesn't have a resource type").
      if (
        !kind &&
        ['endpoints', 'ep', 'endslices', 'endpointslices'].includes(kindToken.toLowerCase())
      ) {
        kind = 'Endpoints';
      }
      if (!kind) return this._resourceTypeError(kindToken);
      kinds.push({ kind, token: kindToken });
    }

    const deprecationWarning = ['dc', 'deploymentconfig', 'deploymentconfigs'].includes(lower)
      ? 'warning: DeploymentConfig (dc) is deprecated in OpenShift 4.x — showing Deployments instead.\n'
      : '';
    // Real oc prefixes the NAME cell with `deployment.apps/`, `job.batch/`, … when
    // more than one resource type is requested (#43).
    const multiKind = kinds.length > 1;
    const structuredFormats = ['yaml', 'json', 'name', 'jsonpath', 'custom-columns'];
    const multiKindStructured = multiKind && structuredFormats.includes(output.format);
    const combinedResources = [];
    const sections = [];
    let singleResource = null;

    const visibleProjectNames = kinds.some((entry) => entry.kind === 'Project')
      ? new Set(this._visibleProjectNames())
      : null;
    for (const { kind } of kinds) {
      // Virtual Endpoints: synthesized from Services, one object per Service.
      if (kind === 'Endpoints') {
        const endpointsObjects = this._endpointsObjects({ allNamespaces, namespace });
        if (multiKindStructured) {
          if (endpointsObjects.length) combinedResources.push(...endpointsObjects);
          continue;
        }
        if (endpointsObjects.length) {
          sections.push(
            // Multi-type requests prefix every kind's NAME cell, so the virtual
            // Endpoints rows must print `endpoints/<name>` like the real
            // resource does in `oc get pods,endpoints,route` (#56).
            this._formatEndpointsObjects(endpointsObjects, {
              output,
              allNamespaces,
              name: null,
              namePrefix: multiKind,
              noHeaders: Boolean(flags['no-headers']),
            }).message
          );
        }
        continue;
      }
      let resources = this._resources(kind);
      if (kind === 'Project' && visibleProjectNames) {
        resources = resources.filter((resource) =>
          visibleProjectNames.has(resource.metadata?.name)
        );
      }
      if (kind === 'Template') {
        const builtins = this._builtinTemplateObjects().filter(
          (template) =>
            !resources.some(
              (resource) =>
                resource.metadata?.name === template.metadata.name &&
                resource.metadata?.namespace === 'openshift'
            )
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
      else resources = this._sortResourcesByName(resources);
      if (!resources.length) {
        if (multiKindStructured) continue;
        if (structuredFormats.includes(output.format)) {
          sections.push(this._formatGetResult(kind, [], flags, { singleName: Boolean(name) }));
        } else if (!multiKind) {
          const scope =
            allNamespaces || !this._isNamespaced(kind) ? '' : ` in ${namespace} namespace`;
          sections.push(`No resources found${scope}.`);
        }
        // Multi-type tabular output: real oc omits an empty type entirely when
        // other types have rows; the "No resources found" message is only
        // printed when nothing at all was written (handled after the loop).
        continue;
      }
      if (multiKindStructured) {
        combinedResources.push(...resources);
        continue;
      }
      const rendered = this._formatGetResult(kind, resources, flags, {
        singleName: Boolean(name) && resources.length === 1,
        allNamespaces,
        namePrefix: multiKind,
      });
      if (rendered && typeof rendered === 'object' && rendered.error) return rendered;
      sections.push(rendered);
    }

    if (multiKindStructured) {
      return {
        error: false,
        message:
          deprecationWarning + this._formatResourcesStructured(combinedResources, flags, output),
      };
    }
    let body = sections.filter((section) => section !== '').join('\n\n');
    if (!body && structuredFormats.includes(output.format)) {
      // Structured empty output is still written (an empty List/table); do not
      // append a human-readable message for -o name/yaml/json (#43).
    } else if (!body) {
      // Real kubectl only prints this once, after every requested type produced
      // no output: "No resources found in <ns> namespace." when all requested
      // types are namespaced, plain "No resources found" otherwise.
      const allNamespaced = kinds.every((entry) => this._isNamespaced(entry.kind));
      const scope = allNamespaced && !allNamespaces ? ` in ${namespace} namespace` : '';
      body = `No resources found${scope}.`;
    }
    return { error: false, message: deprecationWarning + body };
  },

  /** `oc get ns/namespaces` — real K8s table/object shape (NAME STATUS AGE). */
  _getNamespaceView({ name, output, flags }) {
    let projects = this._resources('Project').slice();
    if (name) {
      projects = projects.filter((project) => project.metadata?.name === name);
      if (!projects.length)
        return this._err(`Error from server (NotFound): namespaces "${name}" not found`);
    }
    // #41: `oc get ns -l <selector>` filters on the real Namespace labels
    // (key-only existence, `!key`, `key in (...)`/`notin`, equality).
    projects = this._filterResources(projects, 'Project', flags);
    projects.sort((left, right) =>
      String(left.metadata?.name || '').localeCompare(String(right.metadata?.name || ''))
    );
    const objects = projects.map((project) => ({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: project.metadata?.name,
        labels: { ...(project.metadata?.labels || {}) },
        annotations: { ...(project.metadata?.annotations || {}) },
        creationTimestamp: project.metadata?.creationTimestamp,
      },
      spec: { finalizers: ['kubernetes'] },
      status: { phase: 'Active' },
    }));
    if (output.format === 'yaml')
      return this._ok(
        toYamlDocument(
          name && objects.length === 1
            ? objects[0]
            : { apiVersion: 'v1', kind: 'List', items: objects }
        )
      );
    if (output.format === 'json')
      return this._ok(
        JSON.stringify(
          name && objects.length === 1
            ? objects[0]
            : { apiVersion: 'v1', kind: 'List', items: objects },
          null,
          4
        )
      );
    if (output.format === 'name')
      return this._ok(objects.map((object) => `namespace/${object.metadata.name}`).join('\n'));
    if (output.format === 'jsonpath') {
      if (!output.arg)
        return this._err(
          "error: jsonpath requires a template, e.g. -o jsonpath='{.items[*].metadata.name}'"
        );
      return this._ok(
        evaluateJsonPath(
          name && objects.length === 1 ? objects[0] : { kind: 'List', items: objects },
          output.arg
        )
      );
    }
    if (output.format === 'custom-columns') {
      const columns = String(output.arg || '')
        .split(',')
        .map((entry) => {
          const colon = entry.indexOf(':');
          return colon < 0 ? null : { header: entry.slice(0, colon), path: entry.slice(colon + 1) };
        })
        .filter(Boolean);
      if (!columns.length) return this._err('error: invalid custom-columns specification');
      const rows = objects.map((object) =>
        columns.map((column) =>
          String(evaluateJsonPath(object, `{${column.path.trim()}}`) || '<none>')
        )
      );
      return this._ok(
        padTable(
          columns.map((column) => column.header),
          rows
        )
      );
    }
    const showLabels = Boolean(flags['show-labels']);
    const headers = ['NAME', 'STATUS', 'AGE'];
    if (showLabels) headers.push('LABELS');
    if (!objects.length) {
      // `oc get ns -l <selector>` with no match prints the standard empty-list
      // message (cluster-scoped, so no namespace suffix).
      return this._ok('No resources found');
    }
    const rows = objects.map((object) => {
      const project = projects.find((entry) => entry.metadata?.name === object.metadata.name);
      const row = [object.metadata.name, object.status.phase, this._creationAge(project)];
      if (showLabels) row.push(this._labelString(project) || '<none>');
      return row;
    });
    const table = padTable(headers, rows);
    return this._ok(flags['no-headers'] ? table.split('\n').slice(1).join('\n') : table);
  },

  _cmdGetAll({ flags, output, allNamespaces, namespace }) {
    // Real `oc get all` covers the `all` API category only. ConfigMaps, Secrets
    // and PVCs are deliberately NOT part of it.
    const order = [
      'Pod',
      'Service',
      'Deployment',
      'ReplicaSet',
      'StatefulSet',
      'DaemonSet',
      'Job',
      'CronJob',
      'HorizontalPodAutoscaler',
      'Route',
      'BuildConfig',
      'Build',
      'ImageStream',
    ];
    const structured = ['yaml', 'json', 'name', 'jsonpath', 'custom-columns'].includes(
      output.format
    );
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
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    if (structured) {
      const resources = visible.flatMap((entry) => entry.resources);
      return this._ok(this._formatResourcesStructured(resources, flags, output));
    }
    // `oc get all` prefixes each NAME with the resource reference so multiple
    // kinds can be told apart, and separates the per-kind tables with blank lines.
    const sections = visible.map((entry) =>
      this._tableFor(entry.kind, entry.resources, {
        wide: output.format === 'wide',
        showLabels: Boolean(flags['show-labels']),
        noHeaders: Boolean(flags['no-headers']),
        namePrefix: true,
        namespaceColumn: Boolean(allNamespaces) && this._isNamespaced(entry.kind),
      })
    );
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
      return resources
        .map(
          (resource) =>
            `${this._singularName(resource.kind)}/${resource.metadata?.name || resource.name}`
        )
        .join('\n');
    }
    if (output.format === 'jsonpath') {
      if (!output.arg) return 'error: jsonpath requires a template';
      const subject = {
        kind: 'List',
        items: resources.map((resource) => this._manifestFor(resource)),
      };
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
      return padTable(
        columns.map((column) => column.header),
        rows
      );
    }
    return '';
  },

  /** Virtual / projected resource views (`csv`, `og`, `istag`, `ingresscontroller`). */
  _virtualViewGet(resourceToken, context) {
    const lower = String(resourceToken || '').toLowerCase();
    const { name, flags, output, allNamespaces, namespace } = context;
    // OLM kinds are real registry resources now (#9): let the generic `oc get`
    // path handle listing/NAMESPACE/-o jsonpath/-o yaml. The virtual views stay
    // as a fallback for saved clusters seeded before the registry knew them.
    const realRegistryKinds = new Set([
      'csv',
      'csvs',
      'clusterserviceversion',
      'clusterserviceversions',
      'operatorgroup',
      'operatorgroups',
      'og',
      'installplan',
      'installplans',
      'ip',
      'packagemanifest',
      'packagemanifests',
      'metallb',
      'metallbs',
    ]);
    if (realRegistryKinds.has(lower) && resolveKindToken(lower)) return null;
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
    if (!allNamespaces)
      subscriptions = subscriptions.filter(
        (subscription) => subscription.metadata?.namespace === namespace
      );
    return subscriptions;
  },

  _getCsvView({ flags, output, allNamespaces, namespace, name }) {
    const subscriptions = this._subscriptionsInScope(namespace, allNamespaces);
    if (!subscriptions.length) {
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    const rows = subscriptions.map((subscription) => {
      const spec = subscription.spec || {};
      const csvName =
        subscription.status?.installedCSV ||
        `${spec.packageName || spec.name || subscription.metadata?.name}.v1.0.0`;
      const versionMatch = csvName.match(/\.v?(\d+\.\d+\.\d+)/);
      return {
        namespace: subscription.metadata?.namespace,
        csvName,
        display: String(spec.packageName || spec.name || subscription.metadata?.name).replace(
          /-/g,
          ' '
        ),
        version: versionMatch ? versionMatch[1] : '1.0.0',
        phase: subscription.status?.phase || 'Succeeded',
      };
    });
    const objects = rows.map((row) => ({
      apiVersion: 'operators.coreos.com/v1alpha1',
      kind: 'ClusterServiceVersion',
      metadata: { name: row.csvName, namespace: row.namespace || namespace },
      spec: { displayName: row.display, version: { version: row.version } },
      status: { phase: row.phase },
    }));
    const filtered = name
      ? objects.filter(
          (object) => object.metadata.name === name || object.metadata.name.startsWith(name)
        )
      : objects;
    if (!filtered.length) {
      if (name)
        return this._err(
          `Error from server (NotFound): clusterserviceversions.operators.coreos.com "${name}" not found`
        );
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    if (output.format === 'yaml')
      return this._ok(
        toYamlDocument(
          name && filtered.length === 1
            ? filtered[0]
            : { apiVersion: 'v1', kind: 'List', items: filtered }
        )
      );
    if (output.format === 'json')
      return this._ok(
        JSON.stringify(
          name && filtered.length === 1
            ? filtered[0]
            : { apiVersion: 'v1', kind: 'List', items: filtered },
          null,
          4
        )
      );
    if (output.format === 'jsonpath') {
      if (!output.arg) return this._err('error: jsonpath requires a template');
      return this._ok(
        evaluateJsonPath(
          name && filtered.length === 1 ? filtered[0] : { kind: 'List', items: filtered },
          output.arg
        )
      );
    }
    if (output.format === 'name')
      return this._ok(
        filtered
          .map((object) => `clusterserviceversion.operators.coreos.com/${object.metadata.name}`)
          .join('\n')
      );
    const headers = allNamespaces
      ? ['NAMESPACE', 'NAME', 'DISPLAY', 'VERSION', 'REPLACES', 'PHASE']
      : ['NAME', 'DISPLAY', 'VERSION', 'REPLACES', 'PHASE'];
    const tableRows = rows
      .filter((row) => !name || row.csvName === name || row.csvName.startsWith(name))
      .map((row) => [
        ...(allNamespaces ? [row.namespace || namespace] : []),
        row.csvName,
        row.display,
        row.version,
        '',
        row.phase,
      ]);
    return this._ok(padTable(headers, tableRows));
  },

  _getOperatorGroupView({ output, allNamespaces, namespace, name }) {
    const subscriptions = this._subscriptionsInScope(namespace, allNamespaces);
    if (!subscriptions.length) {
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    const groups = [
      {
        name: 'global-operators',
        namespace: allNamespaces ? 'openshift-operators' : namespace,
        age: '4h',
      },
      { name: 'olm-operators', namespace: 'openshift-operators', age: '4h' },
    ].filter((group) => allNamespaces || group.namespace === namespace);
    if (name) {
      const match = groups.find((group) => group.name === name);
      if (!match)
        return this._err(
          `Error from server (NotFound): operatorgroups.operators.coreos.com "${name}" not found`
        );
    }
    return this._ok(
      padTable(
        ['NAME', 'AGE'],
        (name ? groups.filter((group) => group.name === name) : groups).map((group) => [
          group.name,
          group.age,
        ])
      )
    );
  },

  _getImageStreamTagView({ flags, allNamespaces, namespace, name }) {
    let streams = this._resources('ImageStream');
    if (!allNamespaces)
      streams = streams.filter((stream) => stream.metadata?.namespace === namespace);
    const objects = [];
    for (const stream of streams) {
      const tags = stream.status?.tags || stream.spec?.tags || [];
      const repo =
        stream.status?.dockerImageRepository ||
        `${INTERNAL_REGISTRY}/${stream.metadata?.namespace}/${stream.metadata?.name}`;
      const entries = tags.length ? tags : [{ tag: 'latest' }];
      for (const tag of entries) {
        const tagName = tag.tag || tag.name;
        const item = tag.items?.[0] || {};
        // Real `oc get istag` prints the immutable digest reference
        // (`repo@sha256:…`), never the mutable `:latest` tag.
        const dockerRef = item.dockerImageReference || `${repo}:${tagName}`;
        const digestMatch = String(dockerRef).includes('@sha256:')
          ? String(dockerRef).slice(String(dockerRef).indexOf('@'))
          : '';
        const reference =
          item.image && /^sha256:/.test(String(item.image))
            ? `${String(dockerRef)
                .split('@')[0]
                .replace(/:[^/:]+$/, '')}@${item.image}`
            : dockerRef || `${repo}:${tagName}`;
        void digestMatch;
        const imageName = item.image || this._imageDigest(reference);
        const updated =
          tag.updated || tag.items?.[0]?.created || stream.metadata?.creationTimestamp;
        objects.push({
          apiVersion: 'image.openshift.io/v1',
          kind: 'ImageStreamTag',
          metadata: {
            name: `${stream.metadata?.name}:${tagName}`,
            namespace: stream.metadata?.namespace,
            creationTimestamp: stream.metadata?.creationTimestamp,
            labels: { ...(stream.metadata?.labels || {}) },
          },
          generation: 1,
          lookupPolicy: { local: false },
          tag: {
            name: tagName,
            from: { kind: 'DockerImage', name: reference },
            generation: 1,
            importPolicy: {},
            referencePolicy: { type: 'Source' },
          },
          image: {
            dockerImageReference: reference,
            metadata: { name: imageName },
            dockerImageMetadata: { kind: 'DockerImage', apiVersion: 'v1' },
          },
          _updated: updated,
          _reference: reference,
        });
      }
    }
    const filtered = name
      ? objects
          .filter((object) => object.metadata.name === name)
          .concat(
            objects.filter(
              (object) => object.metadata.name.startsWith(name) && object.metadata.name !== name
            )
          )
      : objects;
    if (!filtered.length) {
      if (name)
        return this._err(
          `Error from server (NotFound): imagestreamtags.image.openshift.io "${name}" not found`
        );
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    const output = (() => {
      const rawOutput = flags.output;
      if (rawOutput === undefined || rawOutput === null || rawOutput === true)
        return { format: 'table', arg: null };
      const text = String(rawOutput);
      if (text.startsWith('jsonpath='))
        return { format: 'jsonpath', arg: text.slice('jsonpath='.length) };
      if (text.startsWith('custom-columns='))
        return { format: 'custom-columns', arg: text.slice('custom-columns='.length) };
      if (['wide', 'yaml', 'json', 'name'].includes(text)) return { format: text, arg: null };
      return { format: 'table', arg: null };
    })();
    const clean = filtered.map((object) => {
      const copy = { ...object };
      delete copy._updated;
      delete copy._reference;
      return copy;
    });
    if (output.format === 'yaml')
      return this._ok(
        toYamlDocument(
          name && clean.length === 1 ? clean[0] : { apiVersion: 'v1', kind: 'List', items: clean }
        )
      );
    if (output.format === 'json')
      return this._ok(
        JSON.stringify(
          name && clean.length === 1 ? clean[0] : { apiVersion: 'v1', kind: 'List', items: clean },
          null,
          4
        )
      );
    if (output.format === 'name')
      return this._ok(
        clean
          .map((object) => `imagestreamtag.image.openshift.io/${object.metadata.name}`)
          .join('\n')
      );
    if (output.format === 'jsonpath') {
      if (!output.arg)
        return this._err(
          "error: jsonpath requires a template, e.g. -o jsonpath='{.items[*].image.dockerImageReference}'"
        );
      const subject = name && clean.length === 1 ? clean[0] : { kind: 'List', items: clean };
      return this._ok(evaluateJsonPath(subject, output.arg));
    }
    if (output.format === 'custom-columns') {
      const columns = String(output.arg || '')
        .split(',')
        .map((entry) => {
          const colon = entry.indexOf(':');
          return colon < 0 ? null : { header: entry.slice(0, colon), path: entry.slice(colon + 1) };
        })
        .filter(Boolean);
      if (!columns.length) return this._err('error: invalid custom-columns specification');
      const rows = clean.map((object) =>
        columns.map((column) =>
          String(evaluateJsonPath(object, `{${column.path.trim()}}`) || '<none>')
        )
      );
      return this._ok(
        padTable(
          columns.map((column) => column.header),
          rows
        )
      );
    }
    const headers = allNamespaces
      ? ['NAMESPACE', 'NAME', 'IMAGE REFERENCE', 'UPDATED']
      : ['NAME', 'IMAGE REFERENCE', 'UPDATED'];
    const rows = filtered.map((object) => [
      ...(allNamespaces ? [object.metadata.namespace || ''] : []),
      object.metadata.name,
      object._reference,
      formatAge(object._updated),
    ]);
    return this._ok(padTable(headers, rows));
  },

  _getIngressControllerView({ output, name }) {
    const rows = [['default', '4h']];
    const filtered = name ? rows.filter((row) => row[0] === name) : rows;
    if (!filtered.length) {
      return this._err(
        `Error from server (NotFound): ingresscontrollers.operator.openshift.io "${name}" not found`
      );
    }
    if (output.format === 'yaml' || output.format === 'json') {
      const manifests = filtered.map((row) => ({
        apiVersion: 'operator.openshift.io/v1',
        kind: 'IngressController',
        metadata: { name: row[0], namespace: 'openshift-ingress-operator' },
        spec: { domain: APPS_DOMAIN, replicas: 2, defaultCertificate: { name: 'router-certs' } },
        status: {
          availableReplicas: 2,
          conditions: [{ type: 'Available', status: 'True', reason: 'Valid' }],
        },
      }));
      if (output.format === 'json') {
        return this._ok(
          JSON.stringify(
            name ? manifests[0] : { apiVersion: 'v1', kind: 'List', items: manifests },
            null,
            4
          )
        );
      }
      return this._ok(
        toYamlDocument(name ? manifests[0] : { apiVersion: 'v1', kind: 'List', items: manifests })
      );
    }
    return this._ok(padTable(['NAME', 'AGE'], filtered));
  },

  /**
   * Build the virtual Endpoints objects for every Service (#52): one object per
   * Service, `subsets` listing the ready pod IPs + target ports.
   * `oc get endpoints` has always been a virtual view; the multi-kind resolver
   * (`oc get pods,endpoints,route`) reuses this instead of failing with
   * "the server doesn't have a resource type \"endpoints\"".
   * @param {{allNamespaces?: boolean, namespace?: string, name?: string|null}} [options]
   * @returns {object[]}
   */
  _endpointsObjects({ allNamespaces = false, namespace = 'default', name = null } = {}) {
    let services = this._resources('Service');
    if (!allNamespaces)
      services = services.filter((service) => service.metadata?.namespace === namespace);
    if (name) services = services.filter((service) => service.metadata?.name === name);
    const endpointsObjects = [];
    for (const service of services) {
      const selector = service.spec?.selector || {};
      const pods = this._getKindList('Pod')
        .filter(
          (pod) =>
            pod.metadata?.namespace === service.metadata?.namespace &&
            Object.keys(selector).length > 0 &&
            Object.entries(selector).every(
              ([key, value]) => (pod.metadata?.labels || {})[key] === value
            ) &&
            (pod.status?.phase || pod.phase) === 'Running'
        )
        .sort((a, b) => String(a.metadata?.name).localeCompare(String(b.metadata?.name)));
      // A Service's Endpoints object is one row: every ready address:port pair.
      const subsets = [];
      for (const port of service.spec?.ports || []) {
        const targetPort = port.targetPort ?? port.port;
        const addresses = [];
        for (const pod of pods) {
          const podIp = pod.status?.podIP || pod.ip;
          if (!podIp) continue;
          addresses.push({ ip: String(podIp) });
        }
        if (addresses.length) {
          subsets.push({
            addresses,
            ports: [
              {
                name: port.name,
                port: Number.isFinite(Number(targetPort)) ? Number(targetPort) : port.port,
                protocol: port.protocol || 'TCP',
              },
            ],
          });
        }
      }
      endpointsObjects.push({
        apiVersion: 'v1',
        kind: 'Endpoints',
        metadata: {
          name: service.metadata?.name,
          namespace: service.metadata?.namespace,
          creationTimestamp: service.metadata?.creationTimestamp,
          labels: { ...(service.metadata?.labels || {}) },
        },
        subsets,
      });
    }
    return endpointsObjects;
  },

  /** Render a list of virtual Endpoints objects in cli-runtime format. */
  _formatEndpointsObjects(
    endpointsObjects,
    { output, allNamespaces, name = null, namePrefix = false, noHeaders = false }
  ) {
    if (output.format === 'name') {
      return this._ok(
        endpointsObjects.map((object) => `endpoints/${object.metadata.name}`).join('\n')
      );
    }
    if (output.format === 'yaml' || output.format === 'json') {
      const subject =
        name && endpointsObjects.length === 1
          ? endpointsObjects[0]
          : { apiVersion: 'v1', kind: 'EndpointsList', items: endpointsObjects };
      if (output.format === 'json') return this._ok(JSON.stringify(subject, null, 4));
      if (name && endpointsObjects.length === 1) return this._ok(toYamlDocument(subject));
      return this._ok(endpointsObjects.map((object) => toYamlDocument(object)).join('\n---\n'));
    }
    if (output.format === 'jsonpath') {
      if (!output.arg)
        return this._err(
          `error: jsonpath requires a template, e.g. -o jsonpath='{.items[*].subsets[*].addresses[*].ip}'`
        );
      const subject =
        name && endpointsObjects.length === 1
          ? endpointsObjects[0]
          : { kind: 'List', items: endpointsObjects };
      return this._ok(evaluateJsonPath(subject, output.arg));
    }
    const headers = allNamespaces
      ? ['NAMESPACE', 'NAME', 'ENDPOINTS', 'AGE']
      : ['NAME', 'ENDPOINTS', 'AGE'];
    const rows = endpointsObjects.map((object) => {
      const addresses = (object.subsets || []).flatMap((subset) =>
        (subset.addresses || []).flatMap((address) =>
          (subset.ports || []).map((port) => `${address.ip}:${port.port}`)
        )
      );
      return [
        ...(allNamespaces ? [object.metadata.namespace || ''] : []),
        // `oc get pods,endpoints,route` labels each kind's rows in the NAME
        // cell (`endpoints/<svc>`) while the single-kind `oc get endpoints`
        // view stays plain `web` (#56).
        namePrefix
          ? `${this._singularName('Endpoints')}/${object.metadata.name}`
          : object.metadata.name,
        addresses.join(',') || '<none>',
        this._creationAge(object),
      ];
    });
    const table = padTable(headers, rows);
    if (noHeaders) return this._ok(table.split('\n').slice(1).join('\n'));
    return this._ok(table);
  },

  _getEndpointsView({ flags, allNamespaces, namespace, name }) {
    const output = this._outputFormat(flags);
    const endpointsObjects = this._endpointsObjects({ allNamespaces, namespace, name });
    if (!endpointsObjects.length) {
      if (name) return this._err(`Error from server (NotFound): endpoints "${name}" not found`);
      return this._ok(
        allNamespaces ? 'No resources found.' : `No resources found in ${namespace} namespace.`
      );
    }
    return this._formatEndpointsObjects(endpointsObjects, { output, allNamespaces, name });
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
    // Runtime-recorded events win over the synthetic lifecycle reconstruction
    // of the same event, so each controller event appears exactly once (#43).
    let events = this._mergeEventStreams(
      this._syntheticEvents({ namespace }),
      this._runtimeEvents({ namespace, allNamespaces })
    );
    if (!allNamespaces) {
      events = events.filter((event) => event.namespace === namespace);
    }
    events = this._filterEvents(events, flags);
    if (!events.length) {
      return this._ok(
        allNamespaces ? 'No events found.' : `No resources found in ${namespace} namespace.`
      );
    }
    return this._ok(
      this._formatEvents(
        events,
        { ...flags, output: flags.output },
        { namespaceColumn: allNamespaces }
      )
    );
  },
});

// ────────────────────────────────────────────────────────────────────────────
// `oc describe`, `oc logs`, `oc explain`, `oc status`
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdDescribe(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-l': 'selector' },
      longValues: ['namespace', 'selector'],
      longBools: ['show-events'],
    });
    if (!positionals.length) {
      return this._err(
        'error: You must specify the type of resource to describe.\n\nUsage:\n  oc describe <resource> [<name>]\n\nUse "oc get" to list resources.'
      );
    }
    const istagRef = this._imageStreamTagRef(positionals);
    if (istagRef) return this._describeImageStreamTag(istagRef, flags);
    const projectConfigRef = this._projectConfigRef(positionals);
    if (projectConfigRef) return this._describeProjectConfig(projectConfigRef);
    let { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0]);
    // `oc describe <type>` (no name) describes every object of that type in the
    // namespace — real oc accepts the type alone (`oc describe quota` lists
    // every ResourceQuota, `oc describe rs -l app=web` filters by selector).
    if (!name && kind !== 'Project') {
      const namespace = flags.namespace || this.currentProject;
      if (this._isNamespaced(kind)) {
        const namespaceError = this._requireNamespace(namespace);
        if (namespaceError) return namespaceError;
      }
      let resources = this._resources(kind);
      if (this._isNamespaced(kind))
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources = this._filterResources(resources, kind, flags);
      if (!resources.length)
        return this._ok(
          this._isNamespaced(kind)
            ? `No resources found in ${namespace} namespace.`
            : 'No resources found'
        );
      return this._ok(
        resources.map((resource) => this._describeResource(kind, resource)).join('\n\n')
      );
    }
    if (!name) {
      name = this.currentProject;
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
      return this._err(
        'error: you must specify a resource to get logs from.\n\nUsage:\n  oc logs <pod|deployment/name|build/name|bc/name> [flags]'
      );
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
    if (
      targetKind === 'Deployment' ||
      targetKind === 'DeploymentConfig' ||
      targetKind === 'ReplicaSet' ||
      targetKind === 'StatefulSet' ||
      targetKind === 'DaemonSet'
    ) {
      return this._logsForWorkload(targetKind, targetName, {
        namespace,
        explicitNamespace,
        flags,
        tail,
      });
    }
    if (targetKind === 'Job') {
      return this._logsForJob(targetName, { namespace, explicitNamespace, flags, tail });
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
    const containerName =
      options.flags.container && options.flags.container !== true
        ? String(options.flags.container)
        : containers[0]?.name || 'main';
    if (containers.length && !containers.some((container) => container.name === containerName)) {
      return this._err(
        `Error from server (BadRequest): container "${containerName}" is not valid for pod "${pod.metadata?.name}"`
      );
    }
    if (options.flags.previous && !this._podHasPreviousContainer(pod, containerName)) {
      return this._err(
        `Error from server (BadRequest): previous terminated container "${containerName}" in pod "${pod.metadata?.name}" not found`
      );
    }
    const phase = pod.status?.phase || 'Pending';
    const podState = this._podStatus(pod);
    if (phase === 'Pending') {
      const reason =
        (pod.status?.containerStatuses || []).find((entry) => entry.state?.waiting)?.state?.waiting
          ?.reason || 'ContainerCreating';
      return this._err(
        `error: container "${containerName}" in pod "${pod.metadata?.name}" is waiting to start: ${reason}`
      );
    }
    let lines = this._podLogLines(pod, containerName, Boolean(options.flags.previous));
    if (Number.isFinite(options.tail) && options.tail >= 0) lines = lines.slice(-options.tail);
    return this._ok(lines.join('\n'));
  },

  /** Parse incident/campaign-produced `openshiftgames.io/logs*` annotations. */
  _podLogAnnotation(pod, containerName, previous) {
    const annotations = pod?.metadata?.annotations || {};
    const annotationContainer = annotations['openshiftgames.io/logs-container'];
    if (annotationContainer && annotationContainer !== containerName) return null;
    const raw = previous
      ? annotations['openshiftgames.io/logs-previous']
      : annotations['openshiftgames.io/logs'];
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw)) return raw.map((line) => String(line));
    const text = String(raw);
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((line) => String(line));
    } catch {
      /* plain text annotation */
    }
    return text.split('\n');
  },

  /** True when the container actually terminated before (`--previous` semantics). */
  _podHasPreviousContainer(pod, containerName) {
    const annotations = pod?.metadata?.annotations || {};
    if (annotations['openshiftgames.io/logs-previous'] !== undefined) {
      const annotated = annotations['openshiftgames.io/logs-container'];
      if (!annotated || annotated === containerName) return true;
    }
    const statuses = pod?.status?.containerStatuses || [];
    return statuses.some(
      (status) => status?.name === containerName && status?.lastState?.terminated
    );
  },

  _podLogLines(pod, containerName, previous) {
    const annotated = this._podLogAnnotation(pod, containerName, previous);
    if (annotated) return annotated;
    const name = pod.metadata?.name || 'pod';
    const created = pod.metadata?.creationTimestamp
      ? new Date(pod.metadata.creationTimestamp).getTime()
      : Date.now() - 120000;
    const port =
      this._containerList(pod).find((container) => container.name === containerName)?.ports?.[0]
        ?.containerPort || 8080;
    const image =
      this._containerList(pod).find((container) => container.name === containerName)?.image ||
      'nginx:latest';
    const podState = this._podStatus(pod);
    const crashing =
      /CrashLoopBackOff|Error|OOMKilled|CreateContainerConfigError/.test(podState.status) ||
      pod.status?.phase === 'Failed';
    if (previous) {
      const appName =
        pod.metadata?.labels?.app ||
        pod.metadata?.labels?.['app.kubernetes.io/name'] ||
        name.replace(/-[a-z0-9]+-[a-z0-9]+$/, '');
      return [
        'Starting application...',
        `FATAL: could not connect to database at ${appName}-db:5432`,
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
    const stamps = [0, 1200, 2800, 4500, 6200].map((offset) =>
      new Date(created + offset).toISOString()
    );
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
        Object.entries(selector).every(
          ([key, value]) => (pod.metadata?.labels || {})[key] === value
        )
    );
    if (!pods.length) return this._err(`error: no pods found for ${kind.toLowerCase()} "${name}"`);
    const pod = pods.find((candidate) => candidate.status?.phase === 'Running') || pods[0];
    const logContainer = this._containerList(pod)[0]?.name || 'main';
    if (options.flags.previous && !this._podHasPreviousContainer(pod, logContainer)) {
      return this._err(
        `Error from server (BadRequest): previous terminated container "${logContainer}" in pod "${pod.metadata?.name}" not found`
      );
    }
    const prefix =
      pods.length > 1 ? `Found ${pods.length} pods, using pod/${pod.metadata?.name}\n` : '';
    const lines = this._podLogLines(pod, logContainer, Boolean(options.flags.previous));
    const tail =
      Number.isFinite(options.tail) && options.tail >= 0 ? lines.slice(-options.tail) : lines;
    return this._ok(prefix + tail.join('\n'));
  },

  _logsForJob(jobName, options) {
    const job = this._findResource('Job', jobName, {
      namespace: options.namespace,
      explicitNamespace: options.explicitNamespace,
      allowPrefix: false,
    });
    if (!job) return this._err(this._notFoundMessage('Job', jobName));
    const jobUid = job.uid || job.metadata?.uid;
    const selector = job.spec?.selector?.matchLabels || {};
    const pods = this._getKindList('Pod').filter((pod) => {
      if (pod.metadata?.namespace !== job.metadata?.namespace) return false;
      const owned = (pod.metadata?.ownerReferences || []).some(
        (owner) => owner.uid === jobUid || owner.name === jobName
      );
      if (owned) return true;
      if ((pod.metadata?.labels?.['job-name'] || '') === jobName) return true;
      return (
        Object.keys(selector).length > 0 &&
        Object.entries(selector).every(
          ([key, value]) => (pod.metadata?.labels || {})[key] === value
        )
      );
    });
    if (!pods.length) return this._err(`error: no pods found for job "${jobName}"`);
    const pod =
      pods.find((candidate) => candidate.status?.phase === 'Running') || pods[pods.length - 1];
    const containers = this._containerList(pod);
    const containerName =
      options.flags.container && options.flags.container !== true
        ? String(options.flags.container)
        : containers[0]?.name || 'main';
    if (options.flags.previous && !this._podHasPreviousContainer(pod, containerName)) {
      return this._err(
        `Error from server (BadRequest): previous terminated container "${containerName}" in pod "${pod.metadata?.name}" not found`
      );
    }
    const prefix =
      pods.length > 1 ? `Found ${pods.length} pods, using pod/${pod.metadata?.name}\n` : '';
    let lines = this._podLogLines(pod, containerName, Boolean(options.flags.previous));
    if (Number.isFinite(options.tail) && options.tail >= 0) lines = lines.slice(-options.tail);
    return this._ok(prefix + lines.join('\n'));
  },

  _logsForBuild(kind, name, options) {
    let build = null;
    if (kind === 'Build') {
      build = this._findResource('Build', name, {
        namespace: options.namespace,
        explicitNamespace: options.explicitNamespace,
      });
      if (!build) return this._err(this._notFoundMessage('Build', name));
    } else {
      const buildConfig = this._findResource('BuildConfig', name, {
        namespace: options.namespace,
        explicitNamespace: options.explicitNamespace,
      });
      if (!buildConfig) return this._err(this._notFoundMessage('BuildConfig', name));
      const version =
        options.flags.version && options.flags.version !== true
          ? parseInt(options.flags.version, 10)
          : null;
      const builds = this._getKindList('Build').filter(
        (candidate) =>
          candidate.metadata?.namespace === buildConfig.metadata?.namespace &&
          (candidate.metadata?.labels?.buildconfig === name ||
            candidate.metadata?.labels?.['buildconfig.openshift.io/name'] === name ||
            candidate.spec?.buildConfig?.name === name)
      );
      if (!builds.length) return this._err(`error: no builds found for build config "${name}"`);
      build = version
        ? builds.find((candidate) => candidate.metadata?.name === `${name}-${version}`) ||
          builds[builds.length - 1]
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
      return this._err(
        'error: You must specify a resource type.\n\nUsage:\n  oc explain <resource>[.<field>]\n\nExamples:\n  oc explain route\n  oc explain route.spec.tls'
      );
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
    const indent = (text) =>
      text
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');

    if (!fieldPath) {
      const topLevel = ['apiVersion', 'kind', 'metadata', 'spec', 'status'];
      const known = Object.keys(fields).filter((path) => !path.includes('.'));
      const names = [...new Set([...topLevel, ...known])];
      if (flags.recursive) {
        return this._ok(
          `KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nDESCRIPTION:\n${indent(description)}\n\nFIELDS:\n${Object.entries(
            fields
          )
            .map(([path, text]) => `   ${path.padEnd(40)} ${text}`)
            .join('\n')}`
        );
      }
      const fieldLines = names
        .map((name) => {
          const text =
            fields[name] ||
            (name === 'apiVersion'
              ? 'string - API version of this object.'
              : name === 'kind'
                ? 'string - Kind of this object.'
                : '');
          return `   ${name.padEnd(40)} ${text}`;
        })
        .join('\n');
      return this._ok(
        `KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nDESCRIPTION:\n${indent(description)}\n\nFIELDS:\n${fieldLines}`
      );
    }

    const exact = fields[fieldPath];
    if (!exact) {
      return this._err(`error: field "${fieldPath}" does not exist`);
    }
    const children = Object.entries(fields)
      .filter(
        ([path]) =>
          path.startsWith(`${fieldPath}.`) &&
          path.split('.').length === fieldPath.split('.').length + 1
      )
      .map(([path, text]) => `   ${path.split('.').pop().padEnd(36)} ${text}`)
      .join('\n');
    return this._ok(
      `KIND:     ${kind}\nVERSION:  ${apiVersion}\n\nFIELD:    ${fieldPath}\n\nDESCRIPTION:\n${indent(exact)}${children ? `\n\nFIELDS:\n${children}` : ''}`
    );
  },

  _cmdStatus(tokens) {
    const { flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
    });
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
    if (
      !deployments.length &&
      !services.length &&
      !routes.length &&
      !pods.length &&
      !builds.length
    ) {
      lines.push(`You have no visible resources in project "${namespace}".`);
    } else {
      for (const service of services) {
        lines.push(
          `svc/${service.metadata?.name} - ${this._serviceClusterIP(service)}:${service.spec?.ports?.[0]?.port || 80}`
        );
        const selector = service.spec?.selector || {};
        const matchingDeployments = deployments.filter((deployment) =>
          Object.entries(selector).every(
            ([key, value]) => (deployment.spec?.template?.metadata?.labels || {})[key] === value
          )
        );
        for (const deployment of matchingDeployments) {
          const image = this._containerList(deployment)[0]?.image || 'nginx:latest';
          const replicas = deployment.spec?.replicas ?? 1;
          const ready = deployment.status?.readyReplicas ?? 0;
          lines.push(`  deployment/${deployment.metadata?.name} deploys ${image}`);
          lines.push(
            `    deployment #${deployment.status?.observedGeneration ?? 1} running for ${this._creationAge(deployment)} - ${ready}/${replicas} pods`
          );
        }
        lines.push('');
      }
      const referencedDeployments = new Set();
      for (const service of services) {
        const selector = service.spec?.selector || {};
        for (const deployment of deployments) {
          if (
            Object.entries(selector).every(
              ([key, value]) => (deployment.spec?.template?.metadata?.labels || {})[key] === value
            )
          ) {
            referencedDeployments.add(deployment.metadata?.name);
          }
        }
      }
      for (const deployment of deployments.filter(
        (candidate) => !referencedDeployments.has(candidate.metadata?.name)
      )) {
        lines.push(
          `deployment/${deployment.metadata?.name} deploys ${this._containerList(deployment)[0]?.image || 'nginx:latest'} (${deployment.status?.readyReplicas ?? 0}/${deployment.spec?.replicas ?? 1} pods)`
        );
        lines.push('');
      }
      for (const route of routes) {
        lines.push(`route.route.openshift.io/${route.metadata?.name} - ${this._routeHost(route)}`);
        lines.push(`  exposed by ${this._routeAdmissionStatusText(route)}`);
      }
      if (routes.length) lines.push('');
      const failedBuilds = builds.filter((build) =>
        ['Failed', 'Cancelled'].includes(build.status?.phase)
      );
      for (const build of failedBuilds) {
        lines.push(
          `build/${build.metadata?.name} ${String(build.status?.phase).toLowerCase()} ${this._creationAge(build)} ago`
        );
        if (build.status?.message) lines.push(`  ${build.status.message}`);
        lines.push('');
      }
    }
    const plural = (count, singular, pluralForm) =>
      `${count} ${count === 1 ? singular : pluralForm}`;
    lines.push(
      `${plural(pods.length, 'pod', 'pods')}, ${plural(services.length, 'service', 'services')}, ${plural(routes.length, 'route', 'routes')}${deployments.length ? `, ${plural(deployments.length, 'deployment', 'deployments')}` : ''}`,
      '',
      "View details with 'oc describe <resource>/<name>' or list everything with 'oc get all'."
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
    const password = flags.password && flags.password !== true ? String(flags.password) : null;
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
        'you must specify a username\n\n  oc login -u <username> -p <password>\n\n(or provide --token=<token>)'
      );
    }

    // #42: real oc prompts for the password interactively when neither `-p` nor
    // `--token` was given. Prompt only for users whose password the simulated
    // cluster actually knows (kubeadmin via the installer's
    // auth/kubeadmin-password copy, and HTPasswd identities); switching to
    // scripted simulator users without a password keeps working and gets a
    // clearly marked simulator hint instead of a misleading silent login.
    if (password === null && !token && this._loginPasswordKnown(user)) {
      return this._promptLoginPassword(user, server);
    }
    const result = this._completeLogin({ user, password, token, server });
    if (!result.error && password === null && !token) {
      return this._ok(
        `${result.message}\n\nSimulator hint: on a real cluster \`oc login\` prompts for the password interactively; this simulated account does not use one.`
      );
    }
    return result;
  },

  /** True when the simulated cluster can verify this user's password (#42). */
  _loginPasswordKnown(user) {
    const normalized = String(user || '');
    // Only kubeadmin has a real password, and its plain text comes from the
    // installer's auth/kubeadmin-password file — the in-cluster
    // kube-system/kubeadmin Secret holds just a bcrypt hash (#45).
    // `admin`/`system:admin` are simulator convenience accounts used for user
    // switching; prompting for them would break those flows (see the simulator
    // hint branch in _cmdLogin).
    if (normalized === 'kubeadmin') return true;
    const ge = this.gameEngine;
    try {
      if (ge && typeof ge._getHtpasswdEntries === 'function') {
        const entries = ge._getHtpasswdEntries();
        if (Array.isArray(entries) && entries.some((entry) => entry?.user === normalized))
          return true;
      }
    } catch {
      /* fall through to the virtual htpasswd file */
    }
    return this._htpasswdUsers().includes(normalized);
  },

  /**
   * Start the real `oc login` password prompt (#42): print the authentication
   * banner plus a bare `Password: ` line, switch the terminal input to masked
   * mode and consume the next entered line as the password.
   * @param {string} user
   * @param {string} server
   */
  _promptLoginPassword(user, server) {
    this._pendingLogin = { user, server };
    if (this.input) {
      this.input.type = 'password';
      this.input.placeholder = 'Password';
      this.input.value = '';
    }
    this.suggestions = [];
    this.selectedSuggestion = -1;
    this.suggestionsEl?.classList.add('hidden');
    return this._ok(`Authentication required for ${server} (openshift)\nPassword: `);
  },

  /** Leave the password prompt and restore the normal terminal input. */
  _closeLoginPrompt() {
    this._pendingLogin = null;
    if (this.input) {
      this.input.type = 'text';
      this.input.placeholder = "Type a command — the 'oc ' prefix is optional";
      this.input.value = '';
    }
  },

  /**
   * Handle the line entered at the `oc login` password prompt (#42). Mirrors a
   * TTY: the entry is masked/not echoed, Ctrl+C (`\u0003`) or an empty line
   * cancels, and the session only changes on a successful login.
   * @param {string} rawInput
   */
  _submitLoginPassword(rawInput) {
    const pending = this._pendingLogin || { user: 'kubeadmin', server: OC_SERVER_URL };
    const raw = String(rawInput ?? '');
    const cancelled = raw === '\u0003' || raw.trim() === '';
    this._closeLoginPrompt();
    this._clearInput();
    const commandLine = `oc login -u ${pending.user}`;
    const result = cancelled
      ? this._err('error: interrupted')
      : this._completeLogin({
          user: pending.user,
          password: raw,
          token: null,
          server: pending.server,
        });
    if (result.message)
      this._appendOutput(result.message, result.error ? 'text-red-400' : 'text-white/70');
    this._recordCommand(commandLine, 'login', !result.error);
    this._emit('command:executed', {
      command: commandLine,
      raw: commandLine,
      baseCommand: 'login',
      success: !result.error,
      timestamp: Date.now(),
    });
    return {
      error: Boolean(result.error),
      message: result.message || '',
      raw: commandLine,
      normalized: commandLine,
      baseCommand: 'login',
      success: !result.error,
    };
  },

  /**
   * Authenticate and render the real `oc login` result banner. Shared by the
   * `-p`/`--token` path and the interactive password prompt (#42).
   * @param {{user: string, password: string|null, token: string|null, server: string}} params
   * @returns {{error: boolean, message: string}}
   */
  _completeLogin({ user, password, token, server }) {
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
          message =
            'Login failed (401 Unauthorized)\nVerify you have provided the correct credentials.';
        }
      }
      // #43: real oc only prints the generic 401 wording. Keep the rollout
      // learning aid, but mark it as a simulator hint so it is never mistaken
      // for real `oc` output.
      const rolloutHint = String(message).match(
        /^Login failed \(401 Unauthorized\)\n(The HTPasswd identity provider is not ready yet:[\s\S]*)$/
      );
      if (rolloutHint) {
        message = [
          'Login failed (401 Unauthorized)',
          'Verify you have provided the correct credentials.',
          '',
          `Simulator hint: ${rolloutHint[1]}`,
        ].join('\n');
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

    const projects = this._visibleProjectNames();
    const current = this.currentProject;
    if (!projects.length) {
      return this._ok(
        [
          'Login successful.',
          '',
          "You don't have any projects. You can try to create a new project, by running",
          '',
          '    oc new-project <projectname>',
          '',
        ].join('\n')
      );
    }
    const lines = [
      'Login successful.',
      '',
      `You have access to ${projects.length} project${projects.length === 1 ? '' : 's'}, the list of projects are:`,
      ...projects.map((project) => `    ${project === current ? '* ' : '  '}${project}`),
      '',
    ];
    if (projects.includes(current)) lines.push(`Using project "${current}".`);
    else lines.push(`Using project "${projects[0]}".`);
    return this._ok(lines.join('\n'));
  },

  _cmdLogout() {
    const ge = this.gameEngine;
    const user = this.currentUser;
    let message = `Logged out '${user}' on '${OC_SERVER_URL}'`;
    if (ge && typeof ge.logout === 'function') {
      try {
        const result = ge.logout();
        if (result && typeof result === 'object' && typeof result.message === 'string')
          message = result.message;
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
    if (flags['show-context'])
      return this._ok(`${this.currentUser}/api-cluster-example-com:6443/${this.currentUser}`);
    if (flags['show-token'])
      return this._ok(
        `sha256~${stableHash(`${this.currentUser}-token`, 99999999).toString(16).padStart(8, '0')}`
      );
    return this._ok(this.currentUser);
  },

  _cmdProject(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortBools: { '-q': 'short' },
      longBools: ['short', 'quiet'],
    });
    const shortOnly = Boolean(flags.short || flags.quiet);
    if (!positionals.length) {
      if (shortOnly) return this._ok(this.currentProject);
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
    const visibleProjects = this._visibleProjectNames();
    if (flags.quiet || flags.short) {
      return this._ok(visibleProjects.join('\n'));
    }
    const projects = visibleProjects;
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
      return this._usageError(
        'new-project',
        'project name is required\n\n  oc new-project <name> [--display-name=<name>] [--description=<text>]'
      );
    }
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
      return this._err(
        `error: project name "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character.`
      );
    }
    if (this._projectExists(name)) {
      return this._err(
        `Error from server (AlreadyExists): project.project.openshift.io "${name}" already exists`
      );
    }
    const displayName =
      flags['display-name'] && flags['display-name'] !== true ? String(flags['display-name']) : '';
    const description =
      flags.description && flags.description !== true ? String(flags.description) : '';
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
        }
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
      ].join('\n')
    );
  },

  _cmdConfig(tokens) {
    const { positionals } = parseArgs(tokens, {});
    const sub = (positionals[0] || '').toLowerCase();
    const contextName = `${this.currentUser}/api-cluster-example-com:6443/${this.currentUser}`;
    if (!sub) {
      return this._err(
        'error: you must specify a subcommand\n\nValid subcommands: current-context, view, get-contexts, use-context'
      );
    }
    if (sub === 'current-context') return this._ok(contextName);
    if (sub === 'get-contexts') {
      return this._ok(
        padTable(
          ['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'],
          [['*', contextName, 'cluster', this.currentUser, this.currentProject]]
        )
      );
    }
    if (sub === 'view') {
      const kubeconfig = {
        apiVersion: 'v1',
        clusters: [{ cluster: { server: OC_SERVER_URL }, name: 'cluster' }],
        contexts: [
          {
            context: { cluster: 'cluster', namespace: this.currentProject, user: this.currentUser },
            name: contextName,
          },
        ],
        'current-context': contextName,
        kind: 'Config',
        preferences: {},
        users: [{ name: this.currentUser, user: { token: 'sha256~simulated-kubeconfig-token' } }],
      };
      return this._ok(toYamlDocument(kubeconfig));
    }
    if (sub === 'use-context') {
      const context = positionals[1];
      if (!context)
        return this._usageError(
          'config',
          'context name is required\n\n  oc config use-context <context-name>'
        );
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
      ? {
          clientVersion,
          kustomizeVersion: 'v5.7.1',
          releaseClientVersion: `${OCP_VERSION}`,
          openshiftVersion: OCP_VERSION,
        }
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
      return this._err(
        `error: unable to match a printer suitable for the output format "${String(flags.output)}"`
      );
    }
    if (flags.client) {
      return this._ok(`Client Version: ${OC_CLIENT_VERSION}\nKustomize Version: v5.7.1`);
    }
    return this._ok(
      `Client Version: ${OC_CLIENT_VERSION}\nKustomize Version: v5.7.1\nServer Version: ${OC_SERVER_VERSION}\nKubernetes Version: ${KUBERNETES_GIT_VERSION}`
    );
  },

  _cmdApiResources(tokens) {
    const { flags } = parseArgs(tokens, {
      shortValues: { '-o': 'output' },
      longValues: ['api-group', 'namespaced', 'sort-by', 'output'],
      longBools: ['namespaced', 'verbs', 'no-headers'],
    });
    const namespacedFilter =
      flags.namespaced === undefined
        ? null
        : flags.namespaced === true
          ? true
          : String(flags.namespaced).toLowerCase() === 'true';
    const apiGroup =
      flags['api-group'] && flags['api-group'] !== true ? String(flags['api-group']) : null;
    const wide = String(flags.output || '') === 'wide' || Boolean(flags.verbs);
    const allVerbs =
      flags.verbs && flags.verbs !== true
        ? String(flags.verbs).split(',').filter(Boolean)
        : ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'];
    let rows = Object.entries(KIND_DEFS)
      .filter(([, definition]) => {
        const apiVersion = definition.apiVersion || 'v1';
        const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
        if (apiGroup !== null && group !== apiGroup) return false;
        if (
          namespacedFilter !== null &&
          Boolean(definition.namespaced !== false) !== namespacedFilter
        )
          return false;
        return true;
      })
      .map(([kind, definition]) => {
        const plural = pluralForKind(kind);
        const singular = kind.toLowerCase();
        const shortNames = (definition.aliases || [])
          .filter((alias) => alias !== plural && alias !== singular && alias.length <= 8)
          .slice(0, 3)
          .join(',');
        const row = [
          plural,
          shortNames,
          definition.apiVersion,
          String(definition.namespaced !== false),
          kind,
        ];
        if (wide) row.push(allVerbs.join(','));
        return row;
      })
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const headers = [
      'NAME',
      'SHORTNAMES',
      'APIVERSION',
      'NAMESPACED',
      'KIND',
      ...(wide ? ['VERBS'] : []),
    ];
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
      warnings.push(
        `warning: no ${kind.toLowerCase()} file supplied; using a simulated self-signed ${kind.toLowerCase()}`
      );
      return `-----BEGIN ${kind}-----\nMIIDazCCAlOgAwIBAgIU simulated-by-openshift-games\n-----END ${kind}-----`;
    }
    const text = String(value);
    if (/-----BEGIN [A-Z ]+-----/.test(text)) return text;
    const file = this._readVirtualFile(text);
    if (file !== null) return file;
    warnings.push(
      `warning: "${text}" not found in the virtual filesystem; using a simulated ${kind.toLowerCase()}`
    );
    return `-----BEGIN ${kind}-----\nMIIDazCCAlOgAwIBAgIU simulated-openshift-games-${this._basename(text)}\n-----END ${kind}-----`;
  },

  _createFlagSpec() {
    return {
      shortValues: {
        '-n': 'namespace',
        '-f': 'filename',
        '-o': 'output',
        '-z': 'serviceaccount',
        '-c': 'container',
        '-p': 'port',
        '-l': 'labels',
      },
      longValues: [
        'namespace',
        'filename',
        'output',
        'image',
        'replicas',
        'type',
        'labels',
        'display-name',
        'description',
        'full-name',
        'from',
        'docker-server',
        'docker-username',
        'docker-password',
        'docker-email',
        'cert',
        'key',
        'ca-cert',
        'dest-ca-cert',
        'external-name',
        'target-port',
        'port',
        'name',
        'clusterrole',
        'role',
        'serviceaccount',
        'user',
        'group',
        'hard',
        'scopes',
        'default',
        'default-request',
        'max',
        'min',
        'max-limit-request-ratio',
        'project-label-selector',
        'project-annotation-selector',
        'tcp',
        'udp',
        'dry-run',
        'context-dir',
        'source-secret',
        'strategy',
        'image-stream',
        'code',
        'template',
        'schedule',
        'command',
        'timezone',
        'restart',
        'active-deadline-seconds',
        'completions',
        'parallelism',
        'backoff-limit',
        'verb',
        'resource-name',
        'api-group',
        'resource',
        'hostname',
        'path',
        'service',
        'termination',
        'duration',
        'audience',
        'bound-object-kind',
        'bound-object-name',
        'bound-object-uid',
        'insecure-policy',
        'wildcard-policy',
      ],
      multi: [
        'from-literal',
        'from-file',
        'from-env-file',
        'hard',
        'tcp',
        'udp',
        'env',
        'param',
        'user',
        'group',
        'serviceaccount',
        'verb',
        'resource',
        'resource-name',
        'api-group',
      ],
      longBools: ['dry-run', 'validate', 'overwrite'],
    };
  },

  /**
   * Interpret `--dry-run[=none|client|server]`.
   * @returns {'client'|'server'|'invalid'|null}
   */
  _dryRunMode(flags) {
    const value = flags['dry-run'];
    if (value === undefined || value === null || value === false || value === 'none') return null;
    if (value === true) return 'client';
    const text = String(value).toLowerCase();
    if (!text || text === 'none') return null;
    if (text === 'client' || text === 'server') return text;
    return 'invalid';
  },

  /** Emit a created manifest (or render it for --dry-run). */
  _finishCreateObject(object, flags, options = {}) {
    const warnings = options.warnings || [];
    const dryRun = this._dryRunMode(flags);
    if (dryRun === 'invalid')
      return this._err('error: --dry-run must be "none", "server", or "client"');
    const output = this._outputFormat(flags);
    const name = object.metadata?.name || 'unnamed';
    const targetNamespace = this._isNamespaced(object.kind)
      ? object.metadata?.namespace || this.currentProject
      : '';
    // `create` is NOT idempotent: a real API server rejects an existing name
    // with AlreadyExists (unlike `apply`). Server dry-run validates the same
    // request, so it fails the same way; client dry-run never contacts the
    // server and therefore prints the object (issue #29).
    if (dryRun !== 'client') {
      if (this._findResourceExact(object.kind, name, targetNamespace))
        return this._err(this._alreadyExistsMessage(object.kind, name));
    }
    if (dryRun) {
      // `oc create secret/configmap … -o yaml` is rendered in real API shape
      // (top-level type/data), so `--dry-run=client -o yaml | oc replace -f -`
      // round-trips like a real cluster.
      const displayObject = this._apiShapedDryRunObject(object);
      // Real `--dry-run=client` output omits metadata.namespace unless -n was
      // given (the namespace is applied to the request, not the manifest).
      if (dryRun === 'client' && !(flags.namespace && flags.namespace !== true)) {
        delete displayObject.metadata.namespace;
      }
      const suffix = dryRun === 'server' ? ' (server dry run)' : ' (dry run)';
      if (output.format === 'yaml')
        return this._ok([...warnings, toYamlDocument(displayObject)].filter(Boolean).join('\n'));
      if (output.format === 'json')
        return this._ok(
          [...warnings, JSON.stringify(displayObject, null, 4)].filter(Boolean).join('\n')
        );
      if (output.format === 'name') return this._ok(`${this._resourceRef(object.kind)}/${name}`);
      return this._ok(
        [...warnings, `${this._resourceRef(object.kind)}/${name} created${suffix}`]
          .filter(Boolean)
          .join('\n')
      );
    }
    const result = this._applyObject(object);
    if (result.error) return result.error;
    return this._ok(
      [
        ...warnings,
        `${this._resourceRef(object.kind)}/${name} ${result.created === false ? 'configured' : 'created'}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
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
    if (
      [
        'user',
        'group',
        'clusterrolebinding',
        'clusterquota',
        'clusterresourcequota',
        'project',
        'namespace',
        'ns',
      ].includes(text)
    ) {
      return false;
    }
    if (
      [
        'route',
        'secret',
        'configmap',
        'cm',
        'quota',
        'resourcequota',
        'limitrange',
        'serviceaccount',
        'sa',
        'service',
        'job',
        'rolebinding',
      ].includes(text)
    ) {
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
          '  oc create clusterquota <name> --project-label-selector=env=dev --hard=pods=10\n' +
          '  oc create job <name> --image=<image> -- <command>\n' +
          '  oc create cronjob <name> --image=<image> --schedule="*/5 * * * *" -- <command>\n' +
          '  oc create user <name> | oc create group <name> [users...]\n' +
          '  oc create serviceaccount <name> | oc create rolebinding <name> --clusterrole=edit --user=<user>\n\n' +
          "Or from a manifest:\n  oc create -f <file>\n\nRun 'oc create --help' for details."
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
        // #38: real oc has no `create limitrange` subcommand — it is a cobra
        // unknown-command error, not a silent success. LimitRanges are created
        // from YAML: `oc apply -f examples/limitrange.yaml`.
        return this._err(
          [
            'error: unknown command "limitrange" for "oc create"',
            '',
            'Valid subcommands:',
            '  clusterrole, clusterrolebinding, configmap, cronjob, deployment, ingress, job, namespace, pdb, priorityclass, quota, role, rolebinding, secret, service, serviceaccount, token',
            '',
            'To create a LimitRange, apply a manifest instead: oc apply -f examples/limitrange.yaml (or oc create -f <file>).',
            '',
            "Run 'oc create --help' for usage.",
          ].join('\n')
        );
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
        return this._err(
          'error: unknown command "project" for "oc create"\n\nRun \'oc create --help\' for usage.'
        );
      case 'role':
        return this._createRoleCommand(rest, flags, false);
      case 'clusterrole':
        return this._createRoleCommand(rest, flags, true);
      case 'token':
        return this._cmdCreateToken(rest, flags);
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
      return this._usageError(
        'create',
        `name is required for ${kind.toLowerCase()}\n\n  oc create ${kind.toLowerCase()} <name> [flags]`
      );
    }
    const namespace = this._namespaceFromFlags(flags);
    const spec = defaultSpecForKind(kind);
    const image =
      flags.image && flags.image !== true
        ? String(flags.image)
        : flags['image-stream'] && flags['image-stream'] !== true
          ? `${INTERNAL_REGISTRY}/${namespace}/${String(flags['image-stream'])}`
          : null;
    if (spec.replicas !== undefined && !(flags.replicas && flags.replicas !== true))
      spec.replicas = 1;
    if (spec.selector?.matchLabels) spec.selector.matchLabels = { app: name };
    if (spec.template?.metadata && kind !== 'Pod') spec.template.metadata.labels = { app: name };
    if (image) {
      // Real oc names the generated container after the image basename
      // (`--image=quay.io/openshift/origin-hello-openshift:latest` → container
      // `origin-hello-openshift`), never the generic `main`.
      const containerName = this._containerNameForImage(image);
      const containers = kind === 'Pod' ? spec.containers : spec.template?.spec?.containers;
      if (Array.isArray(containers) && containers.length) {
        containers[0].image = image;
        containers[0].name = containerName;
      } else if (kind === 'Pod') spec.containers = [{ name: containerName, image }];
      else {
        spec.template = spec.template || { metadata: { labels: { app: name } }, spec: {} };
        spec.template.spec = spec.template.spec || {};
        spec.template.spec.containers = [{ name: containerName, image }];
      }
    }
    if (flags.replicas && flags.replicas !== true) spec.replicas = Number(flags.replicas);
    if (kind === 'Service' && flags.port) {
      spec.ports = [
        {
          name: 'http',
          port: Number(flags.port),
          targetPort: Number(flags['target-port'] || flags.port),
        },
      ];
    }
    const labels = parseCommaAssignments(
      flags.labels && flags.labels !== true ? String(flags.labels) : []
    );
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
    const types = [
      'generic',
      'tls',
      'docker-registry',
      'dockerconfigjson',
      'basic-auth',
      'ssh-auth',
    ];
    let secretType = rest[0];
    let name = rest[1];
    if (!types.includes(secretType)) {
      name = rest[0];
      secretType = 'generic';
    }
    if (!name) {
      return this._err(
        'error: must specify one of: generic, tls, docker-registry\n\n  oc create secret generic <name> --from-literal=key=value\n  oc create secret tls <name> --cert=tls.crt --key=tls.key\n  oc create secret docker-registry <name> --docker-server=... --docker-username=... --docker-password=...'
      );
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
      const server =
        flags['docker-server'] && flags['docker-server'] !== true
          ? String(flags['docker-server'])
          : 'https://index.docker.io/v1/';
      const username =
        flags['docker-username'] && flags['docker-username'] !== true
          ? String(flags['docker-username'])
          : '';
      const password =
        flags['docker-password'] && flags['docker-password'] !== true
          ? String(flags['docker-password'])
          : '';
      const email =
        flags['docker-email'] && flags['docker-email'] !== true
          ? String(flags['docker-email'])
          : '';
      const auth = this._base64(`${username}:${password}`);
      data['.dockerconfigjson'] = this._base64(
        JSON.stringify({ auths: { [server]: { username, password, email, auth } } })
      );
    } else if (secretType === 'basic-auth') {
      type = 'kubernetes.io/basic-auth';
      for (const [key, value] of Object.entries(
        parseCommaAssignments(this._arrayFlag(flags, 'from-literal'))
      )) {
        data[key] = this._base64(value);
      }
    } else if (secretType === 'ssh-auth') {
      type = 'kubernetes.io/ssh-auth';
      const sshKey = this._certMaterial(flags['from-file'], 'OPENSSH PRIVATE KEY', warnings);
      data['ssh-privatekey'] = this._base64(sshKey);
    } else {
      for (const [key, value] of Object.entries(
        parseCommaAssignments(this._arrayFlag(flags, 'from-literal'))
      )) {
        data[key] = this._base64(value);
      }
      for (const fileSpec of this._arrayFlag(flags, 'from-file')) {
        const eq = String(fileSpec).indexOf('=');
        const key = eq >= 0 ? String(fileSpec).slice(0, eq) : this._basename(String(fileSpec));
        const path = eq >= 0 ? String(fileSpec).slice(eq + 1) : String(fileSpec);
        const content = this._readVirtualFile(path);
        if (content === null)
          warnings.push(
            `warning: "${path}" not found in the virtual filesystem; using simulated content`
          );
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
    if (!name)
      return this._usageError(
        'create',
        'name is required\n\n  oc create configmap <name> --from-literal=key=value [--from-file=path]'
      );
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
    if (!name)
      return this._usageError(
        'create',
        'name is required\n\n  oc create quota <name> --hard=pods=20,requests.cpu=4,requests.memory=8Gi'
      );
    const hard = parseCommaAssignments(this._arrayFlag(flags, 'hard'));
    if (!Object.keys(hard).length)
      return this._err(
        'error: --hard is required (e.g. --hard=pods=20,requests.cpu=4,requests.memory=8Gi)'
      );
    const scopes =
      flags.scopes && flags.scopes !== true
        ? String(flags.scopes)
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean)
        : [];
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
      const quota =
        result.resource ||
        this._findResource('ResourceQuota', name, { namespace, explicitNamespace: true });
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

  _createClusterQuota(rest, flags) {
    const name = rest[0];
    if (!name) {
      return this._usageError(
        'create',
        'name is required\n\n  oc create clusterquota <name> --project-label-selector=key=value --hard=pods=10'
      );
    }
    const hard = parseCommaAssignments(this._arrayFlag(flags, 'hard'));
    const selector = parseCommaAssignments(
      flags['project-label-selector'] && flags['project-label-selector'] !== true
        ? String(flags['project-label-selector'])
        : []
    );
    const annotations = parseCommaAssignments(
      flags['project-annotation-selector'] && flags['project-annotation-selector'] !== true
        ? String(flags['project-annotation-selector'])
        : []
    );
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
      {
        apiVersion: 'quota.openshift.io/v1',
        kind: 'ClusterResourceQuota',
        metadata: { name },
        spec: { selector: selectorSpec, quota: { hard } },
      },
      flags
    );
  },

  _createUser(rest, flags) {
    const name = rest[0];
    if (!name)
      return this._usageError(
        'create',
        'name is required\n\n  oc create user <name> [--full-name=<full name>]'
      );
    const fullName =
      flags['full-name'] && flags['full-name'] !== true ? String(flags['full-name']) : '';
    const ge = this.gameEngine;
    if (ge && typeof ge.createUserResource === 'function') {
      const result = ge.createUserResource(name, { fullName });
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `user.user.openshift.io/${name} created`);
    }
    return this._finishCreateObject(
      {
        apiVersion: 'user.openshift.io/v1',
        kind: 'User',
        metadata: { name },
        spec: { fullName, groups: [], identities: [] },
      },
      flags
    );
  },

  _createGroup(rest, flags) {
    const name = rest[0];
    if (!name)
      return this._usageError('create', 'name is required\n\n  oc create group <name> [users...]');
    const users = [...rest.slice(1), ...this._arrayFlag(flags, 'user')];
    const ge = this.gameEngine;
    if (ge && typeof ge.createGroupResource === 'function') {
      const result = ge.createGroupResource(name, users);
      if (result.success === false) return this._err(result.message);
      return this._ok(result.message || `group.user.openshift.io/${name} created`);
    }
    return this._finishCreateObject(
      { apiVersion: 'user.openshift.io/v1', kind: 'Group', metadata: { name }, spec: { users } },
      flags
    );
  },

  _createServiceAccount(rest, flags) {
    const name = rest[0];
    if (!name)
      return this._usageError('create', 'name is required\n\n  oc create serviceaccount <name>');
    const namespace = this._namespaceFromFlags(flags);
    return this._finishCreateObject(
      { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name, namespace }, spec: {} },
      flags
    );
  },

  _createRoleBindingCommand(rest, flags, clusterWide) {
    const name = rest[0];
    if (!name) {
      return this._usageError(
        'create',
        'name is required\n\n  oc create rolebinding <name> --clusterrole=<role> --user=<user> [--group=<group>] [--serviceaccount=<ns>:<sa>]'
      );
    }
    const roleName =
      (flags.clusterrole && flags.clusterrole !== true ? String(flags.clusterrole) : null) ||
      (flags.role && flags.role !== true ? String(flags.role) : null);
    if (!roleName) return this._err('error: you must specify a role with --clusterrole or --role');
    const namespace = this._namespaceFromFlags(flags);
    const subjects = [];
    for (const user of this._arrayFlag(flags, 'user'))
      subjects.push({ kind: 'User', name: String(user), apiGroup: 'rbac.authorization.k8s.io' });
    for (const group of this._arrayFlag(flags, 'group'))
      subjects.push({ kind: 'Group', name: String(group), apiGroup: 'rbac.authorization.k8s.io' });
    for (const serviceAccount of this._arrayFlag(flags, 'serviceaccount')) {
      const text = String(serviceAccount);
      const parts = text.split(':');
      const saNamespace = parts.length > 1 ? parts[0] : namespace;
      const saName = parts.length > 1 ? parts[1] : text;
      subjects.push({ kind: 'ServiceAccount', name: saName, namespace: saNamespace });
    }
    if (!subjects.length)
      return this._err(
        'error: you must specify at least one subject with --user, --group or --serviceaccount'
      );
    const kind = clusterWide ? 'ClusterRoleBinding' : 'RoleBinding';
    const object = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind,
      metadata: { name, ...(clusterWide ? {} : { namespace }) },
      spec: {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: clusterWide || flags.clusterrole ? 'ClusterRole' : 'Role',
          name: roleName,
        },
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
      return this._usageError(
        'create',
        'name is required\n\n  oc create service clusterip|nodeport|loadbalancer <name> --tcp=80:8080'
      );
    }
    const namespace = this._namespaceFromFlags(flags);
    const type = {
      clusterip: 'ClusterIP',
      nodeport: 'NodePort',
      loadbalancer: 'LoadBalancer',
      externalname: 'ExternalName',
    }[serviceTypeToken];
    const protocols = [];
    for (const entry of this._arrayFlag(flags, 'tcp'))
      protocols.push({ protocol: 'TCP', value: String(entry) });
    for (const entry of this._arrayFlag(flags, 'udp'))
      protocols.push({ protocol: 'UDP', value: String(entry) });
    if (!protocols.length && flags.port) {
      protocols.push({
        protocol: 'TCP',
        value: `${flags.port}${flags['target-port'] ? `:${flags['target-port']}` : ''}`,
      });
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
      spec.externalName =
        flags['external-name'] && flags['external-name'] !== true
          ? String(flags['external-name'])
          : `${name}.example.com`;
      delete spec.selector;
    }
    return this._finishCreateObject(
      { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec },
      flags
    );
  },

  /** `oc create namespace <name>` — creates the namespace but does not switch. */
  _createNamespace(rest, flags) {
    const name = rest[0];
    if (!name)
      return this._usageError('create', 'name is required\n\n  oc create namespace <name>');
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
      return this._err(
        `error: namespace name "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character.`
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
    const argv = Array.isArray(afterDoubleDash)
      ? afterDoubleDash.filter((entry) => entry !== undefined)
      : [];
    if (argv.length) return { command: argv };
    const flagCommand =
      flags.command !== undefined && flags.command !== true ? String(flags.command) : null;
    if (flagCommand) return { command: ['/bin/sh', '-c', flagCommand] };
    return {};
  },

  _createJob(rest, flags, afterDoubleDash = []) {
    const name = rest[0];
    if (!name)
      return this._usageError(
        'create',
        'name is required\n\n  oc create job <name> --image=<image> [--restart=Never|OnFailure] -- <command>   |   oc create job <name> --from=cronjob/<cronjob>'
      );
    const namespace = this._namespaceFromFlags(flags);
    const from = flags.from && flags.from !== true ? String(flags.from) : null;
    const image = flags.image && flags.image !== true ? String(flags.image) : 'busybox:latest';
    const commandSpec = this._createContainerCommand(flags, afterDoubleDash);
    const restartPolicy =
      flags.restart && flags.restart !== true ? String(flags.restart) : from ? 'Never' : 'Never';
    if (!['Never', 'OnFailure'].includes(restartPolicy)) {
      return this._err(
        `error: invalid restart policy "${restartPolicy}": must be one of Never, OnFailure`
      );
    }
    let spec;
    if (from && from.startsWith('cronjob/')) {
      const cronJob = this._findResource('CronJob', from.split('/')[1], {
        namespace,
        explicitNamespace: Boolean(flags.namespace),
      });
      if (!cronJob) return this._err(this._notFoundMessage('CronJob', from.split('/')[1]));
      spec = JSON.parse(JSON.stringify(cronJob.spec?.jobTemplate?.spec || {}));
      spec.template = spec.template || { metadata: {}, spec: {} };
      spec.template.spec = spec.template.spec || {};
      spec.template.spec.restartPolicy = restartPolicy;
      spec.template.spec.containers = spec.template.spec.containers?.length
        ? spec.template.spec.containers
        : [{ name: 'main', image }];
      if (flags.image && flags.image !== true) spec.template.spec.containers[0].image = image;
      if (commandSpec.command) spec.template.spec.containers[0].command = commandSpec.command;
    } else {
      const container = { name: 'main', image };
      if (commandSpec.command) container.command = commandSpec.command;
      spec = { template: { metadata: {}, spec: { containers: [container], restartPolicy } } };
    }
    for (const field of [
      'completions',
      'parallelism',
      'backoff-limit',
      'active-deadline-seconds',
    ]) {
      const value = this._intFlag(flags, field);
      if (value !== undefined) {
        const key =
          field === 'backoff-limit'
            ? 'backoffLimit'
            : field === 'active-deadline-seconds'
              ? 'activeDeadlineSeconds'
              : field;
        spec[key] = value;
      }
    }
    // #49: a quick one-shot command (`perl -e "print 42"`, `sh -c date`, …)
    // finishes in ~1 s on a real cluster; give the controller an honest runtime
    // hint instead of the generic 30 s Job duration. The hint is a simulation
    // field (like the level-authored Jobs' estimatedDurationSeconds).
    if (spec.estimatedDurationSeconds === undefined) {
      const estimate = estimateJobRuntimeSeconds(spec.template?.spec?.containers);
      if (Number.isFinite(estimate)) spec.estimatedDurationSeconds = estimate;
    }
    return this._finishCreateObject(
      { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace }, spec },
      flags
    );
  },

  _createCronJob(rest, flags, afterDoubleDash = []) {
    const name = rest[0];
    if (!name) {
      return this._usageError(
        'create',
        'name is required\n\n  oc create cronjob <name> --image=<image> --schedule="<cron schedule>" -- <command>'
      );
    }
    const schedule = flags.schedule && flags.schedule !== true ? String(flags.schedule) : null;
    if (!schedule) {
      return this._err(
        'error: required flag(s) "schedule" not set\n\n  oc create cronjob <name> --image=<image> --schedule="*/5 * * * *"'
      );
    }
    // API-server-level schedule validation (runtime owns the cron parser).
    const scheduleValidation = validateCronSchedule(schedule);
    if (!scheduleValidation.valid) {
      return this._err(`error: The CronJob "${name}" is invalid: ${scheduleValidation.message}`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const image = flags.image && flags.image !== true ? String(flags.image) : 'busybox:latest';
    const commandSpec = this._createContainerCommand(flags, afterDoubleDash);
    const restartPolicy =
      flags.restart && flags.restart !== true ? String(flags.restart) : 'OnFailure';
    if (!['Never', 'OnFailure', 'Always'].includes(restartPolicy)) {
      return this._err(`error: invalid restart policy "${restartPolicy}"`);
    }
    const container = { name: 'main', image };
    if (commandSpec.command) container.command = commandSpec.command;
    const jobSpec = {
      template: { metadata: {}, spec: { containers: [container], restartPolicy } },
    };
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
    // #49: carry the honest one-shot runtime hint into the Jobs this CronJob
    // spawns (the CronJob controller copies jobTemplate.spec verbatim).
    if (jobSpec.estimatedDurationSeconds === undefined) {
      const estimate = estimateJobRuntimeSeconds(jobSpec.template?.spec?.containers);
      if (Number.isFinite(estimate)) jobSpec.estimatedDurationSeconds = estimate;
    }
    return this._finishCreateObject(
      { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace }, spec },
      flags
    );
  },

  /** Shared by `oc create route <type> <name>` and `oc expose`. */
  /**
   * Real oc leaves `route.spec.path` empty unless `--path` was given (the API
   * does not default it to `/`). Kind registry/engine may fill `/`; normalise
   * the persisted object so `oc get route -o yaml` matches a real cluster.
   */
  _normalizeRoutePath(name, namespace, requestedPath) {
    const wanted = requestedPath && requestedPath !== true ? String(requestedPath) : '';
    const route = this._findResource('Route', name, {
      namespace,
      explicitNamespace: true,
      allowPrefix: false,
    });
    if (!route) return;
    if ((route.spec?.path || '') === wanted) return;
    try {
      this._updateResource(
        'Route',
        name,
        (spec) => {
          spec.path = wanted;
          return {};
        },
        { namespace, explicitNamespace: true }
      );
    } catch {
      /* best-effort */
    }
  },

  _createRouteCommand(rest, flags) {
    const terminations = ['edge', 'passthrough', 'reencrypt'];
    let termination = null;
    let name = rest[0];
    if (rest[0] && terminations.includes(String(rest[0]).toLowerCase())) {
      termination = String(rest[0]).toLowerCase();
      name = rest[1];
    }
    if (flags.termination && flags.termination !== true) termination = String(flags.termination);
    const serviceName = flags.service && flags.service !== true ? String(flags.service) : null;
    if (!serviceName) {
      return this._err(
        'error: required flag(s) "service" not set\n\n  oc create route edge [NAME] --service=<service> [--hostname=] [--path=]'
      );
    }
    // Real oc: "If the route name is omitted, the service name will be used".
    if (!name) name = serviceName;
    const namespace = this._namespaceFromFlags(flags);
    const warnings = [];
    const pathProvided = flags.path !== undefined && flags.path !== true;
    const options = {
      name,
      namespace,
      service: serviceName,
      host: flags.hostname && flags.hostname !== true ? String(flags.hostname) : '',
      path: pathProvided ? String(flags.path) : '',
      termination,
      insecureEdgeTerminationPolicy:
        flags['insecure-policy'] && flags['insecure-policy'] !== true
          ? String(flags['insecure-policy'])
          : 'None',
      wildcardPolicy:
        flags['wildcard-policy'] && flags['wildcard-policy'] !== true
          ? String(flags['wildcard-policy'])
          : 'None',
      port: flags.port && flags.port !== true ? String(flags.port) : undefined,
    };
    if (termination && termination !== 'passthrough') {
      if (flags.cert) options.certificate = this._certMaterial(flags.cert, 'CERTIFICATE', warnings);
      if (flags.key) options.key = this._certMaterial(flags.key, 'PRIVATE KEY', warnings);
      if (flags['ca-cert'])
        options.caCertificate = this._certMaterial(flags['ca-cert'], 'CERTIFICATE', warnings);
      if (flags['dest-ca-cert'])
        options.destinationCACertificate = this._certMaterial(
          flags['dest-ca-cert'],
          'CERTIFICATE',
          warnings
        );
    }
    // Real `oc create route passthrough` always pins route.spec.port to the
    // Service's targetPort (forcePort), so a TLS Service on 443:8443 shows
    // PORT 8443 — not the (synthetic) service port name `http` (#36).
    if (termination === 'passthrough' && options.port === undefined) {
      const service = this._findResource('Service', serviceName, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowOtherNamespaces: false,
      });
      const servicePort = service?.spec?.ports?.[0];
      if (servicePort) {
        options.port = String(servicePort.targetPort ?? servicePort.port);
      }
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.createRoute === 'function') {
      const result = ge.createRoute(options);
      if (result.success === false) return this._err(result.message);
      this._normalizeRoutePath(name, namespace, options.path);
      return this._ok([...warnings, `route.route.openshift.io/${name} created`].join('\n'));
    }
    const routeSpec = {
      host: options.host,
      path: options.path,
      to: { kind: 'Service', name: serviceName, weight: 100 },
      port: { targetPort: options.port || 'http' },
      wildcardPolicy: options.wildcardPolicy,
    };
    if (termination) {
      routeSpec.tls = {
        termination,
        insecureEdgeTerminationPolicy: options.insecureEdgeTerminationPolicy,
      };
      if (termination !== 'passthrough') {
        if (options.certificate) routeSpec.tls.certificate = options.certificate;
        if (options.key) routeSpec.tls.key = options.key;
        if (options.caCertificate) routeSpec.tls.caCertificate = options.caCertificate;
        if (options.destinationCACertificate)
          routeSpec.tls.destinationCACertificate = options.destinationCACertificate;
      }
    }
    return this._finishCreateObject(
      {
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name, namespace },
        spec: routeSpec,
      },
      flags,
      { warnings }
    );
  },

  _cmdApply(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-k': 'kustomize', '-n': 'namespace', '-o': 'output' },
      longValues: [
        'filename',
        'kustomize',
        'namespace',
        'output',
        'dry-run',
        'field-manager',
        'server-side',
      ],
      longBools: ['overwrite', 'validate', 'server-side', 'force', 'prune'],
    });
    // Allow `oc apply -f file` and the rare `oc apply file.yaml` form.
    const filename =
      flags.filename ||
      (positionals[0] && !positionals[0].startsWith('-') && !flags.kustomize
        ? positionals[0]
        : null);
    const kustomize = flags.kustomize && flags.kustomize !== true ? String(flags.kustomize) : null;
    if (!filename && !kustomize) {
      return this._err(
        'error: must specify one of -f and -k\n\n  oc apply -f <file>\n  oc apply -k <directory>'
      );
    }
    const dryRun = this._dryRunMode(flags);
    if (dryRun === 'invalid')
      return this._err('error: --dry-run must be "none", "server", or "client"');
    if (kustomize) {
      if (dryRun) return this._printKustomizeDryRun(kustomize, flags, dryRun);
      return this._applyKustomizeDelegated(kustomize, flags);
    }
    return this._applyFileDelegated(String(filename), {
      stdinText: ctx?.stdin ?? null,
      command: 'apply',
      flags,
    });
  },

  _cmdReplace(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-n': 'namespace', '-o': 'output' },
      longValues: ['filename', 'namespace', 'output'],
      longBools: ['force', 'validate'],
    });
    const filename = flags.filename || positionals[0];
    if (!filename) return this._err('error: must specify -f <filename>\n\n  oc replace -f <file>');
    return this._applyFileDelegated(String(filename), {
      stdinText: ctx?.stdin ?? null,
      command: 'replace',
      flags,
    });
  },

  _cmdDelete(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-f': 'filename', '-k': 'kustomize', '-l': 'selector' },
      longValues: [
        'filename',
        'kustomize',
        'namespace',
        'selector',
        'grace-period',
        'cascade',
        'field-selector',
      ],
      longBools: ['all', 'force', 'ignore-not-found', 'now', 'wait'],
    });
    if (flags.filename)
      return this._deleteFileDelegated(String(flags.filename), {
        stdinText: ctx?.stdin ?? null,
        flags,
      });
    if (flags.kustomize) {
      return this._err(
        'error: oc delete -k is not supported in the simulator; delete the created resources by name or delete -f the manifests.'
      );
    }
    if (!positionals.length) {
      return this._err(
        'error: You must provide one or more resources by argument or filename.\n\n  oc delete <resource> <name> [<name>...]\n  oc delete -f <file>'
      );
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

    // Special-case destructive identity/operator commands.
    if (kind === 'Project') {
      const projectName = name || positionals[0];
      if (!projectName)
        return this._usageError('delete', 'project name is required\n\n  oc delete project <name>');
      const ge = this.gameEngine;
      if (ge && typeof ge.deleteProject === 'function') {
        const result = ge.deleteProject(projectName);
        if (result.success === false)
          return ignoreNotFound ? this._ok('') : this._err(result.message);
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
        if (result.success === false)
          return ignoreNotFound ? this._ok('') : this._err(result.message);
        return this._ok(result.message);
      }
    }
    if (kind === 'Subscription') {
      // `oc delete sub a b -n ns` deletes every requested Subscription (#53E):
      // this special case used to return after the first name, silently leaving
      // the rest behind. Deleting a Subscription still uninstalls the operator
      // while keeping its CSV, like real OLM.
      const requested = name ? [name, ...positionals.slice(2)] : positionals.slice(1);
      const subscriptions = this._resources('Subscription');
      const deletedLines = [];
      const missing = [];
      for (const subscriptionName of requested) {
        const target = subscriptions.find(
          (subscription) => subscription.metadata?.name === subscriptionName
        );
        if (!target) {
          missing.push(subscriptionName);
          continue;
        }
        if (dryRun) {
          deletedLines.push(
            `subscription.operators.coreos.com "${subscriptionName}" deleted (dry run)`
          );
          continue;
        }
        this._deleteResource('Subscription', subscriptionName, {
          namespace: target.metadata?.namespace,
        });
        this._emit('operator:uninstalled', {
          name: subscriptionName,
          namespace: target.metadata?.namespace,
        });
        deletedLines.push(`subscription.operators.coreos.com "${subscriptionName}" deleted`);
      }
      if (missing.length && !ignoreNotFound) {
        // Real oc deletes the names it finds, then reports each missing one and
        // exits non-zero.
        const notFoundLines = missing.map(
          (missingName) =>
            `Error from server (NotFound): subscriptions.operators.coreos.com "${missingName}" not found`
        );
        return this._err([...deletedLines, ...notFoundLines].join('\n'));
      }
      return this._ok(deletedLines.join('\n'));
    }
    if (kind === 'Identity') {
      const identityName = name || positionals[1];
      const identity = this._findResource('Identity', identityName, { allowPrefix: false });
      if (!identity)
        return ignoreNotFound
          ? this._ok('')
          : this._err(
              `Error from server (NotFound): identities.user.openshift.io "${identityName}" not found`
            );
      this._deleteResource('Identity', identityName);
      return this._ok(`identity.user.openshift.io "${identityName}" deleted`);
    }

    const deleteList = [];
    const hasSelector = Boolean(
      (flags.selector && flags.selector !== true) ||
      (flags['field-selector'] && flags['field-selector'] !== true)
    );
    if (flags.all || (hasSelector && !name)) {
      // `oc delete pods --all` and `oc delete pods -l app=web` both operate on
      // the list in the request namespace (real oc defaults to the current
      // project; only the list path is filtered by the selector).
      let resources = this._resources(kind);
      if (this._isNamespaced(kind) && !explicitNamespace)
        resources = resources.filter(
          (resource) => resource.metadata?.namespace === this.currentProject
        );
      else if (explicitNamespace && this._isNamespaced(kind))
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources = this._filterResources(resources, kind, flags);
      deleteList.push(...resources);
    } else if (name) {
      const target = this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace,
        allowPrefix: false,
        allowOtherNamespaces: false,
      });
      if (!target)
        return ignoreNotFound ? this._ok('') : this._err(this._notFoundMessage(kind, name));
      deleteList.push(target);
      // Support additional names: `oc delete pod a b c`.
      for (const extraName of positionals.slice(2)) {
        const extra = this._findResource(kind, extraName, {
          namespace: flags.namespace,
          explicitNamespace,
          allowPrefix: false,
          allowOtherNamespaces: false,
        });
        if (extra) deleteList.push(extra);
      }
    } else {
      return this._err('error: resource name is required (or use --all / -l <selector>)');
    }
    if (!deleteList.length)
      return this._ok(ignoreNotFound ? '' : `No resources found in ${namespace} namespace.`);
    const lines = [];
    for (const resource of deleteList) {
      if (dryRun) {
        lines.push(
          `${this._resourceRef(resource.kind)} "${resource.metadata?.name}" deleted (dry run)`
        );
        continue;
      }
      const uid = resource.metadata?.uid || resource.uid;
      try {
        this.cluster?.remove?.(uid);
        lines.push(`${this._resourceRef(resource.kind)} "${resource.metadata?.name}" deleted`);
      } catch (error) {
        if (!ignoreNotFound)
          return this._err(
            `error: unable to delete ${this._resourceRef(resource.kind)}/${resource.metadata?.name}: ${error?.message || error}`
          );
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
    if (!name)
      return this._usageError(
        'scale',
        'resource name is required\n\n  oc scale <resource>/<name> --replicas=<count>'
      );
    const replicasRaw = flags.replicas;
    if (replicasRaw === undefined || replicasRaw === true) {
      return this._usageError(
        'scale',
        '--replicas is required\n\n  oc scale <resource>/<name> --replicas=<count>'
      );
    }
    const replicas = Number(replicasRaw);
    if (!Number.isFinite(replicas) || replicas < 0)
      return this._err(`error: invalid replicas value "${replicasRaw}"`);
    const scalable = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DeploymentConfig'];
    if (!scalable.includes(kind)) return this._err(`error: cannot scale a "${kind}" resource`);
    const namespace = this._namespaceFromFlags(flags);
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    if (
      !this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
        allowOtherNamespaces: false,
      })
    ) {
      return this._err(this._notFoundMessage(kind, name));
    }
    const ge = this.gameEngine;
    if (ge && typeof ge.scale === 'function') {
      const result = ge.scale(kind, name, replicas, { namespace });
      if (result.success === false) return this._err(result.message);
      // #49/#58: the ScalingReplicaSet event names the ReplicaSet the
      // controller owns for the current pod template, using the exact
      // pod-template-hash name even before the controller has ticked.
      const deployment =
        kind === 'Deployment'
          ? this._findResource('Deployment', name, {
              namespace,
              explicitNamespace: Boolean(flags.namespace),
              allowPrefix: false,
            })
          : null;
      const replicaSetName = deployment
        ? this._deploymentReplicaSetName(deployment) || deploymentReplicaSetName(deployment)
        : null;
      if (deployment && replicaSetName) {
        deployment.addEvent(
          'Normal',
          'ScalingReplicaSet',
          `Scaled ${replicas < (result.oldReplicas ?? replicas) ? 'down' : 'up'} replica set ${replicaSetName} to ${replicas}`
        );
      }
      return this._ok(`${this._resourceRef(kind)}/${name} scaled`);
    }
    const result = this._updateResource(
      kind,
      name,
      (spec) => {
        spec.replicas = replicas;
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
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
    if (!name)
      return this._usageError('edit', 'resource name is required\n\n  oc edit <resource>/<name>');
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowOtherNamespaces: false,
    });
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
      return this._ok(
        `Opening the manifest editor for ${this._resourceRef(kind)}/${name} in the Files panel. Save to apply changes.\n${EDIT_TEACHING_LINE}`
      );
    }
    // Legacy shell fallback (index.html edit dialog) until ManifestPanel is wired.
    this._emit('ui:edit-resource', {
      uid: resource.metadata?.uid,
      kind,
      name,
      namespace: resource.metadata?.namespace,
    });
    return this._ok(
      `Opening the manifest editor for ${this._resourceRef(kind)}/${name}. Save to apply changes.\n${EDIT_TEACHING_LINE}`
    );
  },

  _cmdLabelAnnotate(tokens, ctx, field) {
    const isLabel = field === 'labels';
    const verb = isLabel ? 'label' : 'annotate';
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-l': 'selector', '-o': 'output' },
      longValues: ['namespace', 'selector', 'output', 'dry-run'],
      longBools: ['overwrite', 'all', 'local'],
    });
    const dryRun = this._dryRunMode(flags);
    if (dryRun === 'invalid')
      return this._err('error: --dry-run must be "none", "server", or "client"');
    const output = this._outputFormat(flags);
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
    if (!Object.keys(updates).length)
      return this._err(`error: at least one ${verb} update is required`);
    const namespace = this._namespaceFromFlags(flags);
    const applyToResource = (resource) => {
      const metadata = resource.metadata || (resource.metadata = { [field]: {} });
      metadata[field] = metadata[field] || {};
      let changed = false;
      const expected = {};
      for (const [key, value] of Object.entries(updates)) {
        const current = metadata[field][key];
        if (value !== null && current !== undefined && current !== value && !flags.overwrite) {
          return this._err(
            `error: '${key}' already has a value (${current}), and --overwrite is false`
          );
        }
        if (value === null ? current !== undefined : current !== value) changed = true;
        expected[key] = value;
      }
      // Dry-run validates the request without persisting it (and without firing
      // any controller side effects).
      if (dryRun) return { ok: true, changed };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete metadata[field][key];
        else metadata[field][key] = value;
      }
      const ge = this.gameEngine;
      const method = isLabel ? 'labelResource' : 'annotateResource';
      if (ge && typeof ge[method] === 'function') {
        const result = ge[method](kind, resource.metadata.name, expected, {
          namespace: resource.metadata.namespace,
        });
        if (result.success === false) return this._err(result.message);
      } else {
        this.cluster?.update?.(resource.metadata.uid || resource.uid, {
          metadata: { [field]: metadata[field] },
        });
      }
      // service-ca controller inputs (issue #33a): a serving-cert / inject-cabundle
      // annotation must materialise its Secret / CABundle key immediately — the
      // per-tick reconcile is the steady-state safety net but would not run while
      // the simulation is paused, right after the learner types the command.
      if (!isLabel && typeof this.gameEngine?.simulation?.reconcileServiceCA === 'function') {
        try {
          this.gameEngine.simulation.reconcileServiceCA();
        } catch {
          /* a controller side effect must never fail the CLI command */
        }
      }
      return { ok: true, changed };
    };

    if (flags.all) {
      let resources = this._resources(kind);
      if (this._isNamespaced(kind))
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources = this._filterResources(resources, kind, flags);
      if (!resources.length) return this._ok(`No resources found in ${namespace} namespace.`);
      const lines = [];
      for (const resource of resources) {
        const result = applyToResource(resource);
        if (result.error) return result;
        lines.push(this._labelResultLine(resource, result, { isLabel, dryRun, output }));
      }
      return this._ok(lines.join('\n'));
    }

    if (!name) {
      return this._usageError(
        verb,
        `resource name is required\n\n  oc ${verb} <resource>/<name> <key>=<value>`
      );
    }
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowOtherNamespaces: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const result = applyToResource(resource);
    if (result.error) return result;
    return this._ok(this._labelResultLine(resource, result, { isLabel, dryRun, output }));
  },

  /** One output line for `oc label`/`oc annotate` (`-o name`, `--dry-run`, plain). */
  _labelResultLine(resource, result, { isLabel, dryRun, output }) {
    const ref = this._resourceRef(resource.kind);
    const name = resource.metadata?.name;
    if (dryRun && output.format === 'name') return `${ref}/${name}`;
    const action = result.changed
      ? isLabel
        ? 'labeled'
        : 'annotated'
      : `not ${isLabel ? 'labeled' : 'annotated'}`;
    const suffix = dryRun ? (dryRun === 'server' ? ' (server dry run)' : ' (dry run)') : '';
    return `${ref}/${name} ${action}${suffix}`;
  },

  /** Split `oc label deployment/web key=value` and `oc label deployment web key=value`. */
  _splitLabelArgs(positionals) {
    if (!positionals.length) return { kind: null, name: null, rest: [] };
    const first = positionals[0];
    if (isResourceRef(first)) {
      const { kind, name } = splitResourceRef(positionals);
      return { kind, name, rest: positionals.slice(1) };
    }
    const kind = resolveKindToken(first);
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
    if (!name)
      return this._usageError(
        'patch',
        'resource name is required\n\n  oc patch <resource>/<name> -p \'{"spec":{...}}\''
      );
    const patchText = flags.patch;
    if (!patchText || patchText === true) return this._err('error: must specify -p <patch>');
    let patch;
    try {
      patch = JSON.parse(String(patchText));
    } catch (error) {
      return this._err(`error: unable to parse patch: ${error.message}`);
    }
    // Real oc: --type defaults to strategic for built-in types; json requires an
    // RFC-6902 operation array, merge/strategic require an object.
    const patchType =
      flags.type !== undefined && flags.type !== true
        ? String(flags.type).toLowerCase()
        : 'strategic';
    if (!['json', 'merge', 'strategic'].includes(patchType)) {
      return this._err('error: --type must be one of merge, strategic, json');
    }
    if (patchType === 'json' && !Array.isArray(patch)) {
      return this._err('error: json patch must be an array of JSON patch operations');
    }
    if (patchType !== 'json' && Array.isArray(patch)) {
      return this._err(`error: cannot use --type=${patchType} with a JSON patch array`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const dryRun = this._dryRunMode(flags);
    if (dryRun === 'invalid')
      return this._err('error: --dry-run must be "none", "server", or "client"');
    const output = this._outputFormat(flags);
    // Resolve strictly inside the request namespace before touching the engine:
    // `GameEngine.patchResource()` would otherwise answer a generic NotFound last
    // and a real oc reports `deployments.apps "web" not found` (issue #29).
    const existingTarget = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowOtherNamespaces: false,
    });
    if (!existingTarget) return this._err(this._notFoundMessage(kind, name));
    const ge = this.gameEngine;
    if (ge && typeof ge.patchResource === 'function') {
      if (dryRun) {
        // Dry-run: the patch is validated server-side but not persisted. Print
        // the object (or the real name-printer line) like oc.
        const displayObject = this._manifestFor(existingTarget);
        if (output.format === 'yaml') return this._ok(toYamlDocument(displayObject));
        if (output.format === 'json') return this._ok(JSON.stringify(displayObject, null, 4));
        return this._ok(`${this._resourceRef(kind)}/${name} patched (dry run)`);
      }
      const result = ge.patchResource(kind, name, patch, { namespace, type: patchType });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} patched`);
    }
    const result = this._updateResource(
      kind,
      name,
      (spec, resource) => {
        if (patch.metadata) return { metadata: patch.metadata };
        if (patch.spec) Object.assign(spec, patch.spec);
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
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
          `error: unknown set subcommand "${sub}"\n\nValid subcommands:\n  env, image, resources, probe, serviceaccount, triggers, selector, volumes, data\n\nRun 'oc set --help' for details.`
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
    const namespace = this._namespaceFromFlags(flags);
    // `oc set env <type> --all` selects every resource of that type in the
    // namespace (real oc supports --all for set env) (#43).
    const allResources = Boolean(flags.all) && !name;
    if (!name && !allResources)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set env <resource>/<name> KEY=VALUE'
      );
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
    const prefix = flags.prefix && flags.prefix !== true ? String(flags.prefix) : '';

    /** Env arrays of the target containers (workloads and BuildConfigs). */
    const envArraysForSpec = (spec) => {
      if (kind === 'BuildConfig') {
        const strategy = spec.strategy || {};
        const containerStrategy =
          strategy.sourceStrategy ||
          strategy.dockerStrategy ||
          strategy.customStrategy ||
          (strategy.sourceStrategy = {});
        containerStrategy.env = containerStrategy.env || [];
        return [containerStrategy.env];
      }
      const containers = spec.template?.spec?.containers || spec.containers || [];
      const targets =
        flags.container && flags.container !== true
          ? containers.filter((container) => container.name === flags.container)
          : containers;
      return targets.map((container) => {
        container.env = container.env || [];
        return container.env;
      });
    };

    /** Env name real oc derives from a Secret/ConfigMap key (upper-cased, valid chars). */
    const envNameForKey = (key) =>
      `${prefix}${String(key)
        .replace(/[^A-Za-z0-9_]/g, '_')
        .toUpperCase()}`;

    /** Append one container's env entries in real `oc set env --list` format. */
    const renderEnvEntries = (lines, envArray) => {
      for (const entry of envArray || []) {
        const valueFrom = entry.valueFrom || {};
        if (valueFrom.secretKeyRef) {
          lines.push(
            `# ${entry.name} from secret ${valueFrom.secretKeyRef.name}, key ${valueFrom.secretKeyRef.key}`
          );
        } else if (valueFrom.configMapKeyRef) {
          lines.push(
            `# ${entry.name} from configmap ${valueFrom.configMapKeyRef.name}, key ${valueFrom.configMapKeyRef.key}`
          );
        } else if (valueFrom.fieldRef) {
          lines.push(`# ${entry.name} from field ${valueFrom.fieldRef.fieldPath}`);
        } else {
          lines.push(`${entry.name}=${entry.value}`);
        }
      }
    };

    /**
     * `--list` output for one resource: real oc prints one
     * `# <kind>/<name>, container <c>` header per selected container followed by
     * that container's env entries. A container without env vars prints ONLY its
     * header — never a `<none>` placeholder (#49).
     */
    const renderEnvList = (resource) => {
      const resourceName = resource.metadata?.name || '';
      const spec = JSON.parse(JSON.stringify(resource.spec || {}));
      const lines = [];
      if (kind === 'BuildConfig') {
        const strategy = spec.strategy || {};
        const containerStrategy =
          strategy.sourceStrategy || strategy.dockerStrategy || strategy.customStrategy || {};
        const builderName =
          flags.container && flags.container !== true
            ? String(flags.container)
            : containerStrategy.from?.name || 'main';
        lines.push(`# ${this._resourceRef(kind)}/${resourceName}, container ${builderName}`);
        renderEnvEntries(lines, containerStrategy.env || []);
        return lines;
      }
      const containers = spec.template?.spec?.containers || spec.containers || [];
      const selected =
        flags.container && flags.container !== true
          ? containers.filter((container) => container.name === flags.container)
          : containers;
      const targets = selected.length
        ? selected
        : [{ name: this._containerList(resource)[0]?.name || 'main' }];
      for (const container of targets) {
        lines.push(`# ${this._resourceRef(kind)}/${resourceName}, container ${container.name}`);
        renderEnvEntries(lines, container.env || []);
      }
      return lines;
    };

    if (allResources) {
      if (!flags.list) {
        return this._err(
          `error: bulk env edits (oc set env ${this._resourceRef(kind)} --all KEY=VALUE) are not simulated: use --all --list or target resources by name`
        );
      }
      if (this._isNamespaced(kind)) {
        const namespaceError = this._requireNamespace(namespace);
        if (namespaceError) return namespaceError;
      }
      let targets = this._resources(kind);
      if (this._isNamespaced(kind)) {
        targets = targets.filter((resource) => resource.metadata?.namespace === namespace);
      }
      targets = this._sortResourcesByName(targets);
      if (!targets.length) return this._ok(`No resources found in ${namespace} namespace.`);
      return this._ok(targets.map((resource) => renderEnvList(resource).join('\n')).join('\n'));
    }

    if (flags.list) {
      const resource = this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
      });
      if (!resource) return this._err(this._notFoundMessage(kind, name));
      return this._ok(renderEnvList(resource).join('\n'));
    }
    if (!Object.keys(env).length && !remove.length && !fromList.length) {
      return this._err(
        'error: at least one environment variable must be provided\n\n  oc set env <resource>/<name> KEY=VALUE [--from=configmap/name] [--remove=KEY] [--list]'
      );
    }

    // Real oc reads each --from Secret/ConfigMap and creates one explicit env
    // entry per key with a secretKeyRef/configMapKeyRef and an upper-cased name
    // (it does NOT add an envFrom block):
    //   $ oc set env deploy/app --from=secret/db-secret
    //   -> PASSWORD = valueFrom.secretKeyRef{name: db-secret, key: password}
    const fromEntries = [];
    for (const fromRef of fromList) {
      const separator = fromRef.indexOf('/');
      if (separator <= 0) {
        return this._err(
          `error: --from must be of the form <secret|configmap>/<name>: "${fromRef}"`
        );
      }
      const sourceKindToken = fromRef.slice(0, separator).toLowerCase();
      const sourceName = fromRef.slice(separator + 1);
      const sourceKind = sourceKindToken.startsWith('secret')
        ? 'Secret'
        : sourceKindToken.startsWith('configmap') || sourceKindToken.startsWith('cm')
          ? 'ConfigMap'
          : null;
      if (!sourceKind) {
        return this._err(
          `error: unsupported --from source "${sourceKindToken}": use secret/<name> or configmap/<name>`
        );
      }
      const source = this._findResource(sourceKind, sourceName, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
      });
      if (!source) return this._err(this._notFoundMessage(sourceKind, sourceName));
      const data =
        sourceKind === 'Secret'
          ? Object.keys(source.spec?.data || source.data || {})
          : Object.keys(source.spec?.data || {});
      for (const key of data) {
        fromEntries.push({
          name: envNameForKey(key),
          valueFrom:
            sourceKind === 'Secret'
              ? { secretKeyRef: { name: sourceName, key } }
              : { configMapKeyRef: { name: sourceName, key } },
        });
      }
    }

    // Keep the engine path for plain BuildConfig env mutations (strategy env),
    // but handle `--from` here: oc creates explicit per-key entries, and the
    // engine's legacy `envFrom` behaviour is the issue #35 bug.
    if (kind === 'BuildConfig' && !fromList.length && ge && typeof ge.setEnv === 'function') {
      const result = ge.setEnv(kind, name, {
        namespace,
        env,
        remove,
        container: flags.container,
        prefix: flags.prefix,
        overwrite: true,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} updated`);
    }

    const result = this._updateResource(
      kind,
      name,
      (spec, resource) => {
        const target = kind === 'BuildConfig' ? [] : spec.template?.spec?.containers;
        if (kind !== 'BuildConfig' && !(target || spec.containers)?.length) {
          return {
            error: this._err(`error: container "${flags.container || 'main'}" not found`),
          };
        }
        const arrays = envArraysForSpec(spec);
        if (!arrays.length) {
          return {
            error: this._err(`error: container "${flags.container || 'main'}" not found`),
          };
        }
        for (const envArray of arrays) {
          for (const [key, value] of Object.entries(env)) {
            const existing = envArray.find((entry) => entry.name === key);
            if (existing) {
              delete existing.valueFrom;
              existing.value = value;
            } else envArray.push({ name: key, value });
          }
          for (const entry of fromEntries) {
            const existing = envArray.find((candidate) => candidate.name === entry.name);
            if (existing) {
              delete existing.value;
              existing.valueFrom = JSON.parse(JSON.stringify(entry.valueFrom));
            } else envArray.push(JSON.parse(JSON.stringify(entry)));
          }
          for (const key of remove) {
            const index = envArray.findIndex((entry) => entry.name === key);
            if (index >= 0) envArray.splice(index, 1);
          }
        }
        // `oc set env` rolls the workload out (new pod template hash).
        if (resource) {
          resource._rollout = { reason: 'set env', startedAt: Date.now(), remaining: null };
        }
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
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
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set image <resource>/<name> <container>=<image>'
      );
    const assignments = positionals.slice(positionals[0].includes('/') ? 1 : 2);
    if (!assignments.length)
      return this._err('error: you must specify an image assignment (<container>=<image>)');
    const namespace = this._namespaceFromFlags(flags);
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
      allowOtherNamespaces: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const containers = this._containerList(resource);
    if (!containers.length)
      return this._err(
        `error: unable to find any containers in ${this._resourceRef(kind)}/${name}`
      );
    const containerNames = containers.map((container) => container.name);
    const updates = [];
    for (const assignment of assignments) {
      const eq = String(assignment).indexOf('=');
      if (eq <= 0)
        return this._err('error: invalid image format: must be of the form <container>=<image>');
      const containerName = String(assignment).slice(0, eq);
      const image = String(assignment).slice(eq + 1);
      if (containerName === '*') {
        for (const entry of containerNames) updates.push({ container: entry, image });
        continue;
      }
      // Real oc hard-errors on unknown container names and never adds one.
      if (!containerNames.includes(containerName)) {
        return this._err(`error: unable to find container named "${containerName}"`);
      }
      updates.push({ container: containerName, image });
    }
    const ge = this.gameEngine;
    const useEngine =
      ge &&
      typeof ge.setImage === 'function' &&
      updates.every((update) => update.container !== '*');
    if (useEngine) {
      for (const update of updates) {
        const result = ge.setImage(
          kind,
          name,
          { container: update.container, image: update.image },
          { namespace }
        );
        if (result.success === false) return this._err(result.message);
      }
      return this._ok(`${this._resourceRef(kind)}/${name} image updated`);
    }
    const result = this._updateResource(
      kind,
      name,
      (spec) => {
        const targetContainers = spec.template?.spec?.containers || spec.containers || [];
        for (const update of updates) {
          for (const target of targetContainers) {
            if (target.name === update.container) target.image = update.image;
          }
        }
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
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
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set resources <resource>/<name> --limits=cpu=500m,memory=512Mi --requests=cpu=100m,memory=128Mi'
      );
    const limits = parseCommaAssignments(flags.limits);
    const requests = parseCommaAssignments(flags.requests);
    if (!Object.keys(limits).length && !Object.keys(requests).length) {
      return this._err('error: at least one of --limits or --requests must be specified');
    }
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setResources === 'function') {
      const result = ge.setResources(kind, name, {
        namespace,
        limits,
        requests,
        container: flags.container,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} resource requirements updated`);
    }
    return this._err('error: resource limits are not available in this build');
  },

  _setProbe(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: [
        'namespace',
        'container',
        'get-url',
        'open-tcp',
        'http-get',
        'initial-delay-seconds',
        'period-seconds',
      ],
      longBools: ['liveness', 'readiness', 'startup', 'remove'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set probe <resource>/<name> --liveness --get-url=http://:8080/healthz'
      );
    const probeType = flags.readiness ? 'readiness' : flags.startup ? 'startup' : 'liveness';
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    const openTcp =
      flags['open-tcp'] && flags['open-tcp'] !== true ? Number(flags['open-tcp']) : null;
    if (ge && typeof ge.setProbe === 'function' && !openTcp) {
      const result = ge.setProbe(kind, name, {
        namespace,
        probe: probeType,
        getUrl:
          flags['get-url'] && flags['get-url'] !== true ? String(flags['get-url']) : undefined,
        remove: Boolean(flags.remove),
        container: flags.container,
      });
      if (result.success === false) return this._err(result.message);
      return this._ok(
        `${this._resourceRef(kind)}/${name} ${probeType} probe ${flags.remove ? 'removed' : 'updated'}`
      );
    }
    const result = this._updateResource(
      kind,
      name,
      (spec) => {
        const containers = spec.template?.spec?.containers || spec.containers || [];
        for (const container of containers) {
          if (flags.remove) {
            delete container[`${probeType}Probe`];
          } else if (openTcp) {
            container[`${probeType}Probe`] = {
              tcpSocket: { port: openTcp },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            };
          } else {
            const url =
              flags['get-url'] && flags['get-url'] !== true
                ? String(flags['get-url'])
                : 'http://:8080/healthz';
            const match = url.match(/^(https?):\/\/([^/]*?)(?::(\d+))?(\/.*)?$/);
            container[`${probeType}Probe`] = {
              httpGet: {
                path: match?.[4] || '/',
                port: match?.[3] ? Number(match[3]) : 8080,
                scheme: (match?.[1] || 'http').toUpperCase(),
              },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            };
          }
        }
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
    if (result.error) return result.error;
    return this._ok(
      `${this._resourceRef(kind)}/${name} ${probeType} probe ${flags.remove ? 'removed' : 'updated'}`
    );
  },

  _setServiceAccount(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: [],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set serviceaccount <resource>/<name> <serviceaccount>'
      );
    const serviceAccount = positionals[positionals[0].includes('/') ? 1 : 2];
    if (!serviceAccount) return this._err('error: you must specify a service account name');
    // oc's polymorphic pod-spec helper supports every workload with a pod
    // template, including CronJob (`spec.jobTemplate.spec.template.spec`).
    // Paths are relative to the resource's own `spec` (the mutator receives it).
    const podSpecPaths = {
      Deployment: ['template', 'spec'],
      StatefulSet: ['template', 'spec'],
      DaemonSet: ['template', 'spec'],
      Job: ['template', 'spec'],
      CronJob: ['jobTemplate', 'spec', 'template', 'spec'],
      ReplicationController: ['template', 'spec'],
      Pod: [],
    };
    const path = podSpecPaths[kind];
    if (!path)
      return this._err(`error: the ${kind} ${name} is not a pod or does not have a pod template`);
    const namespace = this._namespaceFromFlags(flags);
    const resource = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
      allowOtherNamespaces: false,
    });
    if (!resource) return this._err(this._notFoundMessage(kind, name));
    const result = this._updateResource(
      kind,
      name,
      (spec) => {
        let target = spec;
        for (const segment of path) {
          target[segment] = target[segment] || {};
          target = target[segment];
        }
        target.serviceAccountName = serviceAccount;
        delete target.serviceAccount;
        return {};
      },
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
    );
    if (result.error) return result.error;
    return this._ok(`${this._resourceRef(kind)}/${name} service account updated`);
  },

  _setTriggers(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: [
        'namespace',
        'from-image',
        'containers',
        'from-config',
        'from-github',
        'from-webhook',
      ],
      longBools: ['remove', 'auto', 'manual'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set triggers bc/<name> --from-image=<is>:<tag> [--containers=main]'
      );
    if (!['BuildConfig', 'Deployment'].includes(kind)) {
      return this._err(
        `error: triggers are only supported for BuildConfig and Deployment resources (got ${kind})`
      );
    }
    const namespace = this._namespaceFromFlags(flags);
    const fromImage =
      flags['from-image'] && flags['from-image'] !== true ? String(flags['from-image']) : null;
    const containers =
      flags.containers && flags.containers !== true
        ? String(flags.containers).split(',').filter(Boolean)
        : [];
    // Deployments have no native `spec.triggers`: OpenShift manages image-change
    // triggers through the `image.openshift.io/triggers` annotation (the engine's
    // legacy setTriggers writes spec.triggers, which a real API server drops).
    if (kind === 'Deployment') {
      const resource = this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowOtherNamespaces: false,
      });
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
        triggers = fromImage ? triggers.filter((trigger) => trigger?.from?.name !== fromImage) : [];
      } else {
        if (!fromImage) {
          return this._err(
            'error: --from-image=<image-stream:tag> is required\n\n  oc set triggers deployment/<name> --from-image=<is>:<tag>'
          );
        }
        const targetContainers = containers.length
          ? containers
          : this._containerList(resource).map((container) => container.name);
        for (const containerName of targetContainers.length ? targetContainers : ['main']) {
          const index = Math.max(
            0,
            this._containerList(resource).findIndex((container) => container.name === containerName)
          );
          triggers = triggers.filter(
            (trigger) => trigger?.fieldPath !== `spec.template.spec.containers[${index}].image`
          );
          triggers.push({
            from: { kind: 'ImageStreamTag', name: fromImage },
            fieldPath: `spec.template.spec.containers[${index}].image`,
          });
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
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set selector svc/<name> app=web'
      );
    const start = positionals[0].includes('/') ? 1 : 2;
    const pairs = parseCommaAssignments(positionals.slice(start));
    if (!Object.keys(pairs).length)
      return this._err('error: at least one selector label is required');
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.setSelector === 'function') {
      const result = ge.setSelector(kind, name, pairs, { namespace });
      if (result.success === false) return this._err(result.message);
      return this._ok(`${this._resourceRef(kind)}/${name} selector updated`);
    }
    return this._err('error: selectors are not available in this build');
  },

  /** Boolean flag value (`--overwrite` / `--overwrite=false`). */
  _boolFlag(flags, name) {
    const value = flags[name];
    return value === true || value === 'true' || value === '1';
  },

  /** `path.Clean`-equivalent: oc compares volume mount paths after cleaning. */
  _cleanPath(value) {
    const text = String(value ?? '');
    if (!text) return '/';
    const absolute = text.startsWith('/');
    const parts = [];
    for (const segment of text.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        parts.pop();
        continue;
      }
      parts.push(segment);
    }
    const joined = parts.join('/');
    if (absolute) return `/${joined}`;
    return joined || '.';
  },

  /** Glob matcher used by `-c/--containers` (`*` and `?` wildcards). */
  _globMatch(pattern, value) {
    const source = String(pattern ?? '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    try {
      return new RegExp(`^${source}$`).test(String(value ?? ''));
    } catch {
      return pattern === value;
    }
  },

  /** Select pod-template containers for the `-c/--containers` flag (default `*`). */
  _selectContainers(podSpec, containersFlag) {
    const containers = podSpec?.containers || [];
    const raw =
      containersFlag === undefined || containersFlag === true ? '*' : String(containersFlag);
    if (raw === '*' || raw === '') return { containers, skipped: [] };
    const patterns = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const selected = containers.filter((container) =>
      patterns.some((pattern) => this._globMatch(pattern, container.name))
    );
    const skipped = containers.filter((container) => !selected.includes(container));
    return { containers: selected, skipped };
  },

  /**
   * Pod-spec accessor for `oc set …` (mirrors kubectl's UpdatePodSpecForObject:
   * Pods and workloads with a pod template are supported, CronJob is not).
   * @returns {{podSpec: object, template: object|null}|null}
   */
  _podSpecForSet(kind, resource) {
    if (!resource) return null;
    if (kind === 'Pod' || resource.kind === 'Pod') {
      resource.spec = resource.spec || {};
      return { podSpec: resource.spec, template: null };
    }
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(kind)) {
      resource.spec = resource.spec || {};
      resource.spec.template = resource.spec.template || {};
      resource.spec.template.spec = resource.spec.template.spec || {};
      const podSpec = resource.spec.template.spec;
      podSpec.containers = podSpec.containers || [];
      return { podSpec, template: resource.spec.template };
    }
    return null;
  },

  /** Human description of a volume source for `oc set volumes` list output. */
  _volumeSourceDescription(source, claimDescription) {
    const volumeSource = source || {};
    if (volumeSource.emptyDir !== undefined) return 'empty directory';
    if (volumeSource.hostPath) return `host path ${volumeSource.hostPath.path || ''}`;
    if (volumeSource.persistentVolumeClaim) {
      return `pvc/${volumeSource.persistentVolumeClaim.claimName}${claimDescription ? ` ${claimDescription}` : ''}`;
    }
    if (volumeSource.secret) return `secret/${volumeSource.secret.secretName || ''}`;
    if (volumeSource.configMap) return `configMap/${volumeSource.configMap.name || ''}`;
    if (volumeSource.projected) return 'projected';
    if (volumeSource.nfs)
      return `NFS ${volumeSource.nfs.server || ''}:${volumeSource.nfs.path || ''}`;
    if (volumeSource.downwardAPI) return 'downward API';
    return 'unknown';
  },

  /** `oc set volume` PVC reference annotation: `(does not exist)`, `(waiting for 10GiB allocation)` … */
  _claimReferenceDescription(namespace, claimName) {
    const claim = this._findResource('PersistentVolumeClaim', claimName, {
      namespace,
      explicitNamespace: true,
      allowPrefix: false,
    });
    if (!claim) return '(does not exist)';
    const request = claim.spec?.resources?.requests?.storage;
    if (!claim.spec?.volumeName)
      return request ? `(waiting for ${request}B allocation)` : '(waiting to allocate)';
    const capacity = claim.status?.capacity?.storage || request;
    return capacity ? `(allocated ${capacity}B)` : '(allocated unknown size)';
  },

  /** Normalise a Kubernetes storage quantity (e.g. `1G`, `512Mi`, `10`). */
  _normalizeQuantity(text) {
    const value = String(text ?? '').trim();
    const match = value.match(/^([+-]?[0-9]+(?:\.[0-9]+)?)([eE][+-]?[0-9]+|[numkKMGTP]i?)?$/);
    if (!match) return null;
    if (!Number.isFinite(Number(match[1]))) return null;
    return `${match[1]}${match[2] || ''}`;
  },

  /**
   * `oc set volume(s) RESOURCE/NAME [--add|--remove] …` — real oc 4.22 flag set
   * and semantics (openshift/oc pkg/cli/set/volume.go):
   *   - no operation lists volumes; `--add`/`--remove` are exclusive
   *   - `-t/--type` emptyDir|hostPath|secret|configmap|persistentVolumeClaim
   *   - `--configmap-name`, `--secret-name`, `--claim-name`, `--claim-size`,
   *     `--claim-mode`, `--claim-class`, `--mount-path/-m`, `--sub-path`,
   *     `--default-mode`, `--read-only`, `--overwrite`, `-c/--containers`
   *   - invented flags (`--config-map`, `--configmap`, `--secret`) are rejected
   */
  _setVolumes(rest) {
    const { positionals, flags } = parseArgs(rest, {
      shortValues: {
        '-n': 'namespace',
        '-m': 'mount-path',
        '-t': 'type',
        '-c': 'containers',
        '-l': 'selector',
        '-o': 'output',
        '-f': 'filename',
        '-k': 'kustomize',
      },
      longValues: [
        'namespace',
        'name',
        'containers',
        'type',
        'mount-path',
        'sub-path',
        'default-mode',
        'path',
        'configmap-name',
        'secret-name',
        'claim-name',
        'claim-class',
        'claim-size',
        'claim-mode',
        'source',
        'selector',
        'filename',
        'kustomize',
        'output',
        'dry-run',
        'field-manager',
        'template',
      ],
      longBools: [
        'add',
        'remove',
        'all',
        'confirm',
        'local',
        'overwrite',
        'read-only',
        'recursive',
        'allow-missing-template-keys',
        'show-managed-fields',
      ],
    });
    const textFlag = (name) =>
      flags[name] !== undefined && flags[name] !== true && flags[name] !== false
        ? String(flags[name])
        : null;
    const typeChanged = flags.type !== undefined && flags.type !== true;
    const namespace = this._namespaceFromFlags(flags);
    const dryRun = this._dryRunMode(flags);
    const output = this._outputFormat(flags);

    // ── Complete(): decide the operation (list is the default) ─────────────
    const operationCount = [this._boolFlag(flags, 'add'), this._boolFlag(flags, 'remove')].filter(
      Boolean
    ).length;
    if (operationCount > 1) return this._err('error: you may only specify one operation at a time');
    const isAdd = this._boolFlag(flags, 'add');
    const isRemove = this._boolFlag(flags, 'remove');
    const addOpts = {
      type: (textFlag('type') || '').toLowerCase(),
      mountPath: textFlag('mount-path') || '',
      subPath: textFlag('sub-path') || '',
      defaultMode: textFlag('default-mode') || '',
      readOnly: this._boolFlag(flags, 'read-only'),
      overwrite: this._boolFlag(flags, 'overwrite'),
      path: textFlag('path') || '',
      configMapName: textFlag('configmap-name') || '',
      secretName: textFlag('secret-name') || '',
      claimName: textFlag('claim-name') || '',
      claimSize: textFlag('claim-size') || '',
      claimMode: textFlag('claim-mode') || 'ReadWriteOnce',
      claimClass: textFlag('claim-class') || '',
      source: textFlag('source') || '',
      createClaim: false,
    };
    if (this._boolFlag(flags, 'local') && dryRun === 'server') {
      return this._err(
        'error: cannot specify --local and --dry-run=server - did you mean --dry-run=client?'
      );
    }

    // ── Complete() for --add: infer --type, normalise claim fields ─────────
    if (isAdd) {
      if (!addOpts.type) {
        if (addOpts.claimName || addOpts.claimSize) addOpts.type = 'persistentvolumeclaim';
        else if (addOpts.secretName) addOpts.type = 'secret';
        else if (addOpts.configMapName) addOpts.type = 'configmap';
        else if (addOpts.path) addOpts.type = 'hostpath';
        else addOpts.type = 'emptydir';
      }
      if (addOpts.type === 'configmap' || addOpts.type === 'secret') {
        if (!addOpts.defaultMode) addOpts.defaultMode = '644';
      } else if (addOpts.defaultMode) {
        return this._err('error: --default-mode is only available for secrets and configmaps');
      }
      if (addOpts.source) addOpts.type = '';
      if (addOpts.claimSize) {
        addOpts.createClaim = true;
        if (!addOpts.claimName) addOpts.claimName = `pvc-${Math.random().toString(36).slice(2, 7)}`;
        const normalisedSize = this._normalizeQuantity(addOpts.claimSize);
        if (!normalisedSize) {
          return this._err(
            "error: --claim-size is not valid: quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'"
          );
        }
        addOpts.claimSize = normalisedSize;
      }
      const claimMode = String(addOpts.claimMode).toLowerCase();
      const claimModes = {
        readonlymany: 'ReadOnlyMany',
        rom: 'ReadOnlyMany',
        readwriteonce: 'ReadWriteOnce',
        rwo: 'ReadWriteOnce',
        readwritemany: 'ReadWriteMany',
        rwm: 'ReadWriteMany',
        '': 'ReadWriteOnce',
      };
      if (!(claimMode in claimModes)) {
        return this._err(
          'error: --claim-mode must be one of ReadWriteOnce (rwo), ReadWriteMany (rwm), or ReadOnlyMany (rom)'
        );
      }
      addOpts.claimMode = claimModes[claimMode];
    }

    // ── Validate() ─────────────────────────────────────────────────────────
    if (flags.selector && this._boolFlag(flags, 'all')) {
      return this._err('error: you may specify either --selector or --all but not both');
    }
    if (isAdd) {
      if (!addOpts.type && !addOpts.source)
        return this._err('error: must provide --type or --source for --add operation');
      if (typeChanged && addOpts.source) {
        return this._err(
          'error: either specify --type or --source but not both for --add operation'
        );
      }
      switch (String(addOpts.type).toLowerCase()) {
        case 'emptydir':
          break;
        case 'hostpath':
          if (!addOpts.path) return this._err('error: must provide --path for --type=hostPath');
          break;
        case 'secret':
          if (!addOpts.secretName)
            return this._err('error: must provide --secret-name for --type=secret');
          if (!/^0?[0-7]{3}$/.test(addOpts.defaultMode))
            return this._err('error: --default-mode must be between 0000 and 0777');
          break;
        case 'configmap':
          if (!addOpts.configMapName)
            return this._err('error: must provide --configmap-name for --type=configmap');
          if (!/^0?[0-7]{3}$/.test(addOpts.defaultMode))
            return this._err('error: --default-mode must be between 0000 and 0777');
          break;
        case 'persistentvolumeclaim':
        case 'pvc':
          if (!addOpts.claimName && !addOpts.claimSize)
            return this._err(
              'error: must provide --claim-name or --claim-size (to create a new claim) for --type=pvc'
            );
          break;
        case '':
          break;
        default:
          return this._err(
            'error: invalid volume type. Supported types: emptyDir, hostPath, secret, configmap, persistentVolumeClaim'
          );
      }
      if (!addOpts.type && (addOpts.path || addOpts.secretName || addOpts.claimName)) {
        return this._err(
          'error: --path|--secret-name|--claim-name are only valid for --type option'
        );
      }
      if (
        addOpts.claimClass &&
        !['persistentvolumeclaim', 'pvc'].includes(String(addOpts.type).toLowerCase())
      ) {
        return this._err('error: must provide --type as persistentVolumeClaim');
      }
      if (addOpts.claimClass && !addOpts.claimSize)
        return this._err('error: must provide --claim-size to create new pvc with claim-class');
    } else if (
      addOpts.source ||
      addOpts.path ||
      addOpts.secretName ||
      addOpts.configMapName ||
      addOpts.claimName ||
      addOpts.defaultMode ||
      addOpts.overwrite
    ) {
      return this._err(
        'error: --type|--path|--configmap-name|--secret-name|--claim-name|--source|--default-mode|--overwrite are only valid for --add operation'
      );
    }
    const volumeNameFlag = textFlag('name');
    if (isRemove && !volumeNameFlag && !this._boolFlag(flags, 'confirm')) {
      return this._err('error: must provide --confirm for removing more than one volume');
    }
    if (flags.filename || flags.kustomize) {
      return this._err(
        'error: oc set volumes -f/-k is not simulated; operate on a live resource instead (e.g. oc set volume deployment/web --add …).'
      );
    }
    if (!positionals.length) {
      return this._err(
        'error: provide one or more resources to add, list, or delete volumes on as TYPE/NAME'
      );
    }

    // ── Resolve the target resources ───────────────────────────────────────
    const ref = this._resolveRef(positionals);
    const kind = ref.kind;
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    let resources = [];
    const explicitNamespace = Boolean(flags.namespace);
    if (this._boolFlag(flags, 'all')) {
      resources = this._filterResources(this._resources(kind), kind, flags);
      if (this._isNamespaced(kind))
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
    } else {
      const name = ref.name;
      if (!name)
        return this._usageError(
          'set',
          'resource name is required\n\n  oc set volume deployment/<name> --add --name=data --claim-path=/data'
        );
      const resource = this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace,
        allowPrefix: false,
        allowOtherNamespaces: false,
      });
      if (!resource) return this._err(this._notFoundMessage(kind, name));
      resources = [resource];
    }
    if (!resources.length)
      return this._ok(
        this._boolFlag(flags, 'all')
          ? 'No resources found'
          : `No resources found in ${namespace} namespace.`
      );
    const singleResource = resources.length === 1;

    // ── List mode (no --add/--remove): `oc set volume deployment/app` ──────
    if (!isAdd && !isRemove) {
      const lines = [];
      const errors = [];
      for (const resource of resources) {
        const target = this._podSpecForSet(kind, resource);
        if (!target) {
          errors.push(
            `error: ${resource.kind} ${resource.metadata?.name} the ${resource.kind} ${resource.metadata?.name} is not a pod or does not have a pod template`
          );
          continue;
        }
        const { podSpec } = target;
        const selected = this._selectContainers(podSpec, flags.containers);
        if (!selected.containers.length && String(flags.containers || '*') !== '*') {
          lines.push(
            `warning: ${resource.kind}/${resource.metadata?.name} does not have any containers matching "${flags.containers}"`
          );
          continue;
        }
        const resourceNamespace = resource.metadata?.namespace || namespace;
        const volumes = podSpec.volumes || [];
        lines.push(`${resource.kind} ${resource.metadata?.name}`);
        let found = false;
        for (const volume of volumes) {
          if (volumeNameFlag && volume.name !== volumeNameFlag) continue;
          found = true;
          const claimName = volume.persistentVolumeClaim?.claimName;
          const claimDescription = claimName
            ? this._claimReferenceDescription(resourceNamespace, claimName)
            : '';
          lines.push(
            `  ${this._volumeSourceDescription(volume, claimDescription)} as ${volume.name}`
          );
          for (const container of selected.containers) {
            for (const mount of container.volumeMounts || []) {
              if (mount.name !== volume.name) continue;
              const suffix =
                podSpec.containers.length === 1 ? '' : ` in container ${container.name}`;
              lines.push(`    mounted at ${mount.mountPath}${suffix}`);
            }
          }
        }
        if (volumeNameFlag && !found)
          errors.push(
            `error: ${resource.kind} ${resource.metadata?.name} volume "${volumeNameFlag}" not found`
          );
      }
      if (errors.length) return this._err([...lines, ...errors].join('\n'));
      return this._ok(lines.join('\n'));
    }

    // ── Add / remove: mutate a clone so dry-run never touches the cluster ──
    const warnings = [];
    const applied = [];
    let resolvedVolumeName = volumeNameFlag;
    for (const resource of resources) {
      const resourceNamespace = resource.metadata?.namespace || namespace;
      const clone = JSON.parse(JSON.stringify(resource));
      const target = this._podSpecForSet(kind, clone);
      if (!target) {
        if (singleResource)
          return this._err(
            `error: the ${resource.kind} ${resource.metadata?.name} is not a pod or does not have a pod template`
          );
        warnings.push(
          `warning: skipping ${resource.kind} ${resource.metadata?.name} (not a pod or does not have a pod template)`
        );
        continue;
      }
      const { podSpec } = target;
      podSpec.volumes = podSpec.volumes || [];
      const selected = this._selectContainers(podSpec, flags.containers);
      if (!selected.containers.length && String(flags.containers || '*') !== '*') {
        warnings.push(
          `warning: ${resource.kind}/${resource.metadata?.name} does not have any containers matching "${flags.containers}"`
        );
        continue;
      }

      if (isRemove) {
        const removeName = resolvedVolumeName;
        if (!removeName) {
          for (const container of selected.containers) container.volumeMounts = [];
          podSpec.volumes = [];
        } else {
          for (const container of selected.containers) {
            container.volumeMounts = (container.volumeMounts || []).filter(
              (mount) => mount.name !== removeName
            );
          }
          const stillUsed = (podSpec.containers || []).some((container) =>
            (container.volumeMounts || []).some((mount) => mount.name === removeName)
          );
          if (!stillUsed) {
            const index = podSpec.volumes.findIndex((volume) => volume.name === removeName);
            if (index < 0) return this._err(`error: volume '${removeName}' not found`);
            podSpec.volumes.splice(index, 1);
          }
        }
      } else {
        // Resolve/generate the volume name exactly like oc's AddVolumeOptions.
        let claimFound = false;
        if (!resolvedVolumeName) {
          if (addOpts.overwrite) {
            if (!singleResource)
              return this._err(
                'error: you must specify --name for the volume name when dealing with multiple resources'
              );
            if (addOpts.mountPath) {
              const matches = [];
              for (const container of selected.containers) {
                for (const mount of container.volumeMounts || []) {
                  if (
                    this._cleanPath(mount.mountPath) === this._cleanPath(addOpts.mountPath) &&
                    !matches.includes(mount.name)
                  )
                    matches.push(mount.name);
                }
              }
              if (matches.length === 0)
                return this._err(
                  `error: unable to find the volume for mount-path: ${addOpts.mountPath}`
                );
              if (matches.length > 1)
                return this._err(
                  `error: found multiple volumes with same mount-path: ${addOpts.mountPath}`
                );
              resolvedVolumeName = matches[0];
            } else {
              return this._err('error: ambiguous --overwrite, specify --name or --mount-path');
            }
          } else {
            const claimVolume = addOpts.claimName
              ? podSpec.volumes.find(
                  (volume) => volume.persistentVolumeClaim?.claimName === addOpts.claimName
                )
              : null;
            if (claimVolume) {
              resolvedVolumeName = claimVolume.name;
              claimFound = true;
            } else {
              resolvedVolumeName = `volume-${Math.random().toString(36).slice(2, 7)}`;
              warnings.push(`info: Generated volume name: ${resolvedVolumeName}`);
            }
          }
        } else {
          claimFound = Boolean(
            addOpts.claimName &&
            podSpec.volumes.some(
              (volume) => volume.persistentVolumeClaim?.claimName === addOpts.claimName
            )
          );
        }

        const existingIndex = podSpec.volumes.findIndex(
          (volume) => volume.name === resolvedVolumeName
        );
        let newVolume = { name: resolvedVolumeName };
        let setSource = true;
        if (existingIndex >= 0) {
          const existing = podSpec.volumes[existingIndex];
          if (!addOpts.overwrite && !claimFound) {
            return this._err(
              `error: volume '${resolvedVolumeName}' already exists. Use --overwrite to replace`
            );
          }
          if (!typeChanged && !addOpts.source) {
            // `--overwrite` without --type keeps the existing volume source.
            const reused = JSON.parse(JSON.stringify(existing));
            delete reused.name;
            newVolume = { name: resolvedVolumeName, ...reused };
            setSource = false;
          }
          podSpec.volumes.splice(existingIndex, 1);
        } else if (addOpts.overwrite) {
          warnings.push(
            `warning: volume "${resolvedVolumeName}" did not previously exist and was not overwritten. A new volume with this name has been created instead.`
          );
        }
        if (setSource) {
          const type = String(addOpts.type).toLowerCase();
          if (type === '' && addOpts.source) {
            let source = null;
            try {
              source = JSON.parse(addOpts.source);
            } catch (error) {
              return this._err(`error: invalid --source JSON: ${error.message}`);
            }
            if (!source || typeof source !== 'object' || Object.keys(source).length !== 1) {
              return this._err('error: must provide only one volume for --source');
            }
            Object.assign(newVolume, source);
          } else if (type === 'emptydir') {
            newVolume.emptyDir = {};
          } else if (type === 'hostpath') {
            newVolume.hostPath = { path: addOpts.path };
          } else if (type === 'secret') {
            newVolume.secret = {
              secretName: addOpts.secretName,
              defaultMode: parseInt(addOpts.defaultMode, 8),
            };
          } else if (type === 'configmap') {
            newVolume.configMap = {
              name: addOpts.configMapName,
              defaultMode: parseInt(addOpts.defaultMode, 8),
            };
          } else if (type === 'persistentvolumeclaim' || type === 'pvc') {
            newVolume.persistentVolumeClaim = { claimName: addOpts.claimName };
          }
        }
        podSpec.volumes.push(newVolume);
        if (addOpts.mountPath) {
          for (const container of selected.containers) {
            const conflict = (container.volumeMounts || []).find(
              (mount) =>
                this._cleanPath(mount.mountPath) === this._cleanPath(addOpts.mountPath) &&
                mount.name !== resolvedVolumeName
            );
            if (conflict)
              return this._err(
                `error: volume mount '${addOpts.mountPath}' already exists for container '${container.name}'`
              );
            container.volumeMounts = container.volumeMounts || [];
            if (addOpts.overwrite)
              container.volumeMounts = container.volumeMounts.filter(
                (mount) => mount.name !== resolvedVolumeName
              );
            const volumeMount = {
              name: resolvedVolumeName,
              mountPath: this._cleanPath(addOpts.mountPath),
            };
            if (addOpts.readOnly) volumeMount.readOnly = true;
            if (addOpts.subPath) volumeMount.subPath = this._cleanPath(addOpts.subPath);
            container.volumeMounts.push(volumeMount);
          }
        }
      }

      applied.push({ resource, clone, podSpec, target });
    }

    if (!applied.length) {
      return this._err(
        [
          ...warnings,
          isRemove ? 'error: no volumes were removed' : 'error: no volumes were added',
        ].join('\n')
      );
    }

    // Optional PVC creation for `--claim-size` (real oc creates it server-side).
    const claims = [];
    if (isAdd && addOpts.createClaim) {
      for (const entry of applied) {
        if (entry.resource.metadata?.namespace === undefined && kind !== 'Pod') continue;
        claims.push({
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: {
            name: addOpts.claimName,
            namespace: entry.resource.metadata?.namespace || namespace,
          },
          spec: {
            accessModes: [addOpts.claimMode],
            resources: { requests: { storage: addOpts.claimSize } },
            ...(addOpts.claimClass ? { storageClassName: addOpts.claimClass } : {}),
          },
        });
        break;
      }
    }

    const printObject = (object) => {
      if (output.format === 'yaml') return toYamlDocument(object);
      if (output.format === 'json') return JSON.stringify(object, null, 4);
      if (output.format === 'name')
        return `${this._resourceRef(object.kind)}/${object.metadata?.name}`;
      return `${this._resourceRef(object.kind)}/${object.metadata?.name} volume updated`;
    };
    const outputLines = [];
    for (const entry of applied) {
      const object = {
        apiVersion: entry.resource.apiVersion || apiVersionForKind(kind),
        kind: entry.resource.kind || kind,
        metadata: {
          name: entry.resource.metadata?.name,
          ...(entry.resource.metadata?.namespace
            ? { namespace: entry.resource.metadata.namespace }
            : {}),
        },
        spec: entry.clone.spec,
      };
      outputLines.push(printObject(object));
      if (dryRun) continue;
      const result =
        kind === 'Pod'
          ? this._updateResource(
              kind,
              entry.resource.metadata?.name,
              (spec) => {
                Object.assign(spec, entry.clone.spec);
                return {};
              },
              {
                namespace: entry.resource.metadata?.namespace || flags.namespace,
                explicitNamespace: Boolean(entry.resource.metadata?.namespace || flags.namespace),
              }
            )
          : this._updateResource(
              kind,
              entry.resource.metadata?.name,
              (spec) => {
                spec.template = entry.clone.spec.template;
                return {};
              },
              {
                namespace: entry.resource.metadata?.namespace || flags.namespace,
                explicitNamespace: Boolean(entry.resource.metadata?.namespace || flags.namespace),
              }
            );
      if (result.error) return result.error;
    }

    if (dryRun) {
      const display = [...warnings, ...outputLines];
      if (claims.length) display.push(...claims.map(printObject));
      return this._ok(display.join('\n'));
    }
    for (const claim of claims) {
      const created = this._applyObject(claim);
      if (created.error) return created.error;
    }
    return this._ok([...warnings, ...outputLines].join('\n'));
  },

  // ── rollout / run / exec ─────────────────────────────────────────────────

  _cmdRollout(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'revision', 'to-revision', 'timeout'],
      longBools: ['watch', 'dry-run', 'paused'],
    });
    const sub = (positionals[0] || '').toLowerCase();
    const valid = ['status', 'history', 'undo', 'restart', 'pause', 'resume'];
    if (!valid.includes(sub)) {
      return this._err(
        `error: unknown rollout subcommand "${sub || ''}"\n\nValid subcommands: status, history, undo, restart, pause, resume\n\n  oc rollout status <resource>/<name>`
      );
    }
    const { kind, name } = this._resolveRef(positionals.slice(1));
    if (!kind) return this._resourceTypeError(positionals[1] || '');
    if (!name)
      return this._usageError(
        'rollout',
        'resource name is required\n\n  oc rollout status deployment/<name>'
      );
    const namespace = this._namespaceFromFlags(flags);
    if (this._isNamespaced(kind)) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    if (
      !this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
        allowOtherNamespaces: false,
      })
    ) {
      return this._err(this._notFoundMessage(kind, name));
    }
    const ge = this.gameEngine;
    // runtime owns deploy/RS/pod state; prefer its real-ReplicaSet view.
    const sim = ge?.simulation || ge?.sim || null;
    const refLine = `${this._resourceRef(kind)}/${name}`;
    if (sub === 'status' && sim && typeof sim.getRolloutStatus === 'function') {
      const status = sim.getRolloutStatus(kind, name, { namespace });
      if (status && status.found === false) return this._err(this._notFoundMessage(kind, name));
      if (status && status.error) return this._err(status.error);
      if (status && status.timedOut) {
        // Real oc: error: deployment "api-server" exceeded its progress deadline
        const text = /^error:/.test(status.message || '')
          ? status.message
          : `error: ${status.message || `${this._singularName(kind)} "${name}" exceeded its progress deadline`}`;
        return this._err(text);
      }
      if (status && status.complete)
        return this._ok(
          status.message || `${this._singularName(kind)} "${name}" successfully rolled out`
        );
      const pending =
        status?.message || `Waiting for ${this._singularName(kind)} "${name}" rollout to finish...`;
      // `--timeout=<duration>` is CLI-side (real oc blocks, then fails with
      // `error: timed out waiting for the condition` if the rollout never lands).
      const timeoutMs =
        flags.timeout !== undefined && flags.timeout !== true
          ? this._parseTimeoutMs(String(flags.timeout))
          : 0;
      if (flags.timeout !== undefined && flags.timeout !== true && timeoutMs === null) {
        return this._err(
          `error: invalid timeout "${flags.timeout}": must be a duration such as 30s, 5m or 0`
        );
      }
      this._watchRolloutStatus(kind, name, namespace, sim, { timeoutMs: timeoutMs || 0 });
      return this._ok(pending);
    }
    if (sub === 'history' && sim && typeof sim.getRolloutHistory === 'function') {
      const history = sim.getRolloutHistory(kind, name, { namespace }) || [];
      if (!history.length) return this._err(this._notFoundMessage(kind, name));
      const revisionFlag = flags.revision || flags['to-revision'];
      if (revisionFlag && revisionFlag !== true) {
        const wanted = Number(revisionFlag);
        const entry = history.find((item) => Number(item.revision) === wanted);
        if (!entry) return this._err(`error: unable to find the specified revision`);
        const images = (entry.images || []).map((image) => `    Image:\t${image}`);
        const containers = entry.template?.spec?.containers || [];
        const lines = [
          `${this._resourceRef(kind)}/${name} with revision #${entry.revision}`,
          'Pod Template:',
          `  Labels:\t${
            Object.entries(entry.template?.metadata?.labels || {})
              .map(([key, value]) => `${key}=${value}`)
              .join(',') || '<none>'
          }`,
          '  Containers:',
          ...(containers.length
            ? containers.flatMap((container) => [
                `   ${container.name || 'main'}:`,
                `    Image:\t${container.image || '<none>'}`,
              ])
            : images),
        ];
        return this._ok(lines.join('\n'));
      }
      const rows = history.map((entry) => [String(entry.revision), entry.changeCause || '<none>']);
      return this._ok(padTable(['REVISION', 'CHANGE-CAUSE'], rows));
    }
    if (sub === 'undo' && sim && typeof sim.undoRollout === 'function') {
      const revision = flags.revision || flags['to-revision'];
      const result = sim.undoRollout(kind, name, {
        namespace,
        revision: revision && revision !== true ? Number(revision) : undefined,
      });
      if (!result || result.success === false)
        return this._err(
          result?.message ||
            `error: no rollout history found for ${this._singularName(kind)} "${name}"`
        );
      return this._ok(result.message || `${refLine} rolled back`);
    }
    if (ge && typeof ge.rollout === 'function') {
      if (sub === 'history') {
        const history =
          typeof ge.getRolloutHistory === 'function'
            ? ge.getRolloutHistory(kind, name, { namespace })
            : [];
        if (!history.length) return this._err(this._notFoundMessage(kind, name));
        const rows = history.map((entry) => [
          String(entry.revision),
          entry.changeCause || '<none>',
        ]);
        return this._ok(padTable(['REVISION', 'CHANGE-CAUSE'], rows));
      }
      if (sub === 'pause' || sub === 'resume') {
        return this._ok(`${refLine} ${sub === 'pause' ? 'paused' : 'resumed'}`);
      }
      const revision = flags.revision || flags['to-revision'];
      const result = ge.rollout(kind, sub, name, {
        namespace,
        revision: revision && revision !== true ? Number(revision) : undefined,
      });
      if (result.success === false) return this._err(result.message);
      if (sub === 'status' && result.status) {
        return this._ok(result.message || `${refLine} successfully rolled out`);
      }
      if (sub === 'restart') {
        // Real oc: `deployment.apps/web restarted` — resource/name form, no
        // quoted name (#43). Keep the engine's success/failure decision.
        return this._ok(`${refLine} restarted`);
      }
      return this._ok(result.message || `${refLine} rolled back`);
    }
    return this._err(`error: rollout ${sub} is not available in this build`);
  },

  /**
   * `oc rollout status` blocks on a real cluster; the simulator prints the
   * current Waiting line and then appends the final state from runtime's
   * deployment controller (progress-deadline-exceeded / complete).
   */
  /** Parse `--timeout` durations (`30s`, `5m`, `1h`, bare seconds, `0`). */
  _parseTimeoutMs(value) {
    const text = String(value ?? '')
      .trim()
      .toLowerCase();
    if (!text) return null;
    if (text === '0') return 0;
    const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
    if (!match) return null;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = match[2] || 's';
    const multiplier = unit === 'ms' ? 1 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000;
    return Math.round(amount * multiplier);
  },

  _watchRolloutStatus(kind, name, namespace, sim, options = {}) {
    this._clearRolloutWatches();
    const timeoutMs = Number(options.timeoutMs) || 0;
    const state = { stopped: false, timer: null, offs: [], startedAt: Date.now(), timeoutMs };
    const finish = (message, tone) => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
      for (const off of state.offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      state.offs = [];
      this._rolloutWatches = (this._rolloutWatches || []).filter((entry) => entry !== state);
      if (message) this._appendOutput(message, tone || 'text-white/70');
    };
    const poll = () => {
      if (state.stopped) return;
      let status = null;
      try {
        status = sim.getRolloutStatus(kind, name, { namespace });
      } catch {
        status = null;
      }
      if (!status) return;
      const timedOutByCli = timeoutMs > 0 && Date.now() - state.startedAt >= timeoutMs;
      if (timedOutByCli && !status.timedOut && !status.complete) {
        // Real oc's client-side wait timeout (distinct from the deployment's
        // progress deadline): `error: timed out waiting for the condition`.
        finish('error: timed out waiting for the condition', 'text-red-400');
        return;
      }
      if (status.timedOut) {
        const text = /^error:/.test(status.message || '')
          ? status.message
          : `error: ${status.message || `${this._singularName(kind)} "${name}" exceeded its progress deadline`}`;
        finish(text, 'text-red-400');
      } else if (status.complete) {
        finish(
          status.message || `${this._singularName(kind)} "${name}" successfully rolled out`,
          'text-white/70'
        );
      } else if (status.error) {
        finish(status.error, 'text-red-400');
      }
    };
    state.timer = setInterval(poll, 1000);
    const offDeadline = this.eventBus?.on?.('rollout:progress-deadline-exceeded', (payload) => {
      if (payload && (payload.name !== name || (payload.kind && payload.kind !== kind))) return;
      const text =
        payload?.message ||
        `error: ${this._singularName(kind)} "${name}" exceeded its progress deadline`;
      finish(/^error:/.test(text) ? text : `error: ${text}`, 'text-red-400');
    });
    const offComplete = this.eventBus?.on?.('rollout:complete', (payload) => {
      if (payload && (payload.name !== name || (payload.kind && payload.kind !== kind))) return;
      finish(
        payload?.message || `${this._singularName(kind)} "${name}" successfully rolled out`,
        'text-white/70'
      );
    });
    state.offs = [offDeadline, offComplete].filter((off) => typeof off === 'function');
    this._rolloutWatches = [...(this._rolloutWatches || []), state];
  },

  _clearRolloutWatches() {
    for (const state of this._rolloutWatches || []) {
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
      for (const off of state.offs || []) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    }
    this._rolloutWatches = [];
  },

  _cmdRun(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: [
        'namespace',
        'image',
        'image-stream',
        'port',
        'restart',
        'serviceaccount',
        'labels',
        'env',
        'overrides',
      ],
      multi: ['env'],
      longBools: ['rm', 'it', 'stdin', 'tty', 'attach'],
    });
    const name = positionals[0];
    if (!name)
      return this._usageError(
        'run',
        'name is required\n\n  oc run <name> --image=<image> [--port=8080]'
      );
    const image =
      flags.image && flags.image !== true
        ? String(flags.image)
        : flags['image-stream'] && flags['image-stream'] !== true
          ? `${INTERNAL_REGISTRY}/${this.currentProject}/${flags['image-stream']}`
          : null;
    if (!image)
      return this._err(
        'error: --image or --image-stream is required\n\n  oc run <name> --image=nginx:latest'
      );
    const namespace = this._namespaceFromFlags(flags);
    const port = flags.port && flags.port !== true ? Number(flags.port) : null;
    const env = parseCommaAssignments(this._arrayFlag(flags, 'env'));
    const labels = {
      run: name,
      ...parseCommaAssignments(flags.labels && flags.labels !== true ? String(flags.labels) : []),
    };
    // Real `kubectl/oc run <name> --image=…` names the container after the run
    // name and sets NO resource requests/limits: a project quota that tracks
    // requests.cpu/requests.memory therefore rejects the Pod with
    // "must specify requests.cpu,requests.memory" when no LimitRange defaults it
    // (the lab 12 exam trap). LimitRanger admission fills defaults in later.
    const container = {
      name,
      image,
    };
    if (port) container.ports = [{ containerPort: port, protocol: 'TCP' }];
    if (Object.keys(env).length)
      container.env = Object.entries(env).map(([key, value]) => ({ name: key, value }));
    const restartPolicy =
      flags.restart && flags.restart !== true ? String(flags.restart) : 'Always';
    const object = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace, labels },
      spec: {
        containers: [container],
        restartPolicy,
      },
    };
    // `--overrides` takes a strategic-merge-patch-style JSON fragment that is
    // applied to the generated object before it is sent to the API server, so
    // admission (SCC) sees the overridden spec. A runAsUser: 0 override must be
    // rejected exactly like a manifest with securityContext.runAsUser: 0.
    if (flags.overrides && flags.overrides !== true) {
      let overrides;
      try {
        overrides = JSON.parse(String(flags.overrides));
      } catch (error) {
        return this._err(
          `error: invalid JSON passed to --overrides: ${error && error.message ? error.message : error}`
        );
      }
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return this._err('error: --overrides must be a JSON object');
      }
      const deepMergeObject = (target, patch) => {
        for (const [key, value] of Object.entries(patch || {})) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
            deepMergeObject(target[key], value);
          } else {
            target[key] = value;
          }
        }
        return target;
      };
      deepMergeObject(object, overrides);
      // Overrides may supply metadata; the generated name/namespace stay unless
      // explicitly replaced (real oc honours metadata overrides).
      object.metadata.name = object.metadata.name || name;
    }
    // Quota admission for direct Pod creation (e.g. lab 12's "pods without
    // requests are forbidden when the quota has no LimitRange defaults"). The
    // simulation exposes the same admission check its controllers use; the API
    // is optional so `_cmdRun` keeps working when it is absent.
    const ge = this.gameEngine;
    const targetNamespace = object.metadata.namespace || namespace;
    const podAdmission = ge?.simulation?.podAdmissionForCreate?.(
      object.spec,
      targetNamespace,
      object.metadata.name || name
    );
    if (podAdmission) {
      return this._err(
        `Error from server (Forbidden): pods "${object.metadata.name || name}" ${podAdmission}`
      );
    }
    const result = this._applyObject(object);
    if (result.error) return result.error;
    if (name.toLowerCase() === 'konami') {
      this._emit('easter-egg:triggered', { id: 'konami-code' });
      this._emit('xp:gain', { amount: 100 });
    }
    return this._ok(`pod/${name} created`);
  },

  _cmdExec(tokens) {
    const {
      positionals,
      flags,
      afterDoubleDash,
      tokens: rawTokens,
    } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container'],
      longBools: ['stdin', 'tty', 'attach', 'quiet'],
    });
    const { kind: refKind, name: refName } = this._resolveRef(positionals);
    const namespace = this._namespaceFromFlags(flags);
    let pod = null;
    let kind = refKind;
    let name = refName;
    if (refKind === 'Pod') {
      pod = this._findResource('Pod', refName, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
      });
    } else if (refKind) {
      // Real oc resolves deployment/statefulset/job/... to a concrete pod.
      pod = this._podForResource(refKind, refName, namespace, Boolean(flags.namespace));
      if (!pod)
        return this._err(`error: no pods found for ${this._resourceRef(refKind)}/${refName}`);
    } else {
      // `oc exec <pod> -- …` (no resource type)
      kind = 'Pod';
      name = positionals[0];
      if (!name)
        return this._usageError('exec', 'pod name is required\n\n  oc exec -it <pod> -- <command>');
      pod = this._findResource('Pod', name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowPrefix: false,
      });
    }
    if (!pod) return this._err(this._notFoundMessage('Pod', refName || positionals[0] || ''));
    const containers = this._containerList(pod);
    const containerName =
      flags.container && flags.container !== true
        ? String(flags.container)
        : containers[0]?.name || 'main';
    if (containers.length && !containers.some((container) => container.name === containerName)) {
      return this._err(
        `Error from server (BadRequest): container "${containerName}" is not valid for pod "${pod.metadata?.name}"`
      );
    }
    // A CrashLoopBackOff / ImagePullBackOff / completed container cannot be
    // exec'd into; real oc fails the attach instead of pretending to run (#35).
    const containerStateError = this._execContainerStateError(pod, containerName);
    if (containerStateError) return this._err(containerStateError);
    const interactive = rawTokens.some((token) => /^-[a-z]*[it][a-z]*$/.test(token));
    let command = afterDoubleDash.join(' ').trim();
    if (!command) {
      const consumed = String(positionals[0] || '').includes('/') ? 1 : refKind ? 2 : 1;
      const plainCommand = positionals.slice(consumed).join(' ').trim();
      command = plainCommand || (interactive ? '/bin/sh' : '');
    }
    // Real oc only prints the "Defaulting container name" hint for
    // MULTI-container pods when no -c container was requested (#26).
    const containerSpecified = Boolean(flags.container && flags.container !== true);
    const lines =
      containers.length > 1 && !containerSpecified
        ? [
            `Defaulting container name to "${containerName}".`,
            `Use 'oc describe pod/${pod.metadata?.name} -n ${pod.metadata?.namespace}' to see all of the containers in this pod.`,
          ]
        : [];
    if (!command) return this._ok(lines.join('\n'));
    const output = this._simulateExecCommand(command, pod, containerName);
    return this._ok([...lines, ...output].join('\n'));
  },

  _simulateExecCommand(command, pod, containerName) {
    const raw = String(command ?? '').trim();
    if (!raw) return [];
    const context = this._podExecContext(pod, containerName);
    // `oc exec … -- sh -c "cmd"` / `/bin/bash -c "…"`: unwrap the script.
    const tokens = tokenizeCommand(raw);
    if (tokens.length >= 3 && /(?:^|\/)(?:ba)?sh$/.test(tokens[0]) && tokens[1] === '-c') {
      return this._simulateExecCommand(tokens.slice(2).join(' '), pod, containerName);
    }
    // Support simple pipelines like `cat /etc/app/APP_MODE | grep prod`.
    if (tokens.includes('|')) {
      const stages = [];
      let current = [];
      for (const token of tokens) {
        if (token === '|') {
          stages.push(current);
          current = [];
        } else current.push(token);
      }
      stages.push(current);
      let stdin = null;
      let lines = [];
      for (const stage of stages) {
        const result = this._execStage(stage, context, stdin);
        lines = result.lines;
        if (!result.ok) break;
        stdin = result.lines.join('\n');
      }
      return lines;
    }
    return this._execStage(tokens, context, null).lines;
  },

  /**
   * Run one `oc exec`/`oc rsh` command against the simulated Pod filesystem.
   * The filesystem mirrors the Pod's mounted ConfigMaps/Secrets/downwardAPI
   * volumes and its environment (`env`, `envFrom`, valueFrom), so
   * `ls /etc/app` / `cat /etc/app/APP_MODE` / `env` show the real config (#32d).
   */
  _execStage(tokens, context, stdin) {
    const argv = tokens.length ? tokens : ['sh'];
    const name = String(argv[0] || '').toLowerCase();
    const args = argv.slice(1);
    const stdinText = stdin === null || stdin === undefined ? null : String(stdin);
    const ok = (lines) => ({ ok: true, lines });
    const pipeLines = () =>
      stdinText === null
        ? []
        : stdinText
            .split('\n')
            .filter((line, index, list) => !(index === list.length - 1 && line === ''));
    if (/^(hostname)$/.test(name)) return ok([context.podName]);
    if (name === 'hostname' && args[0] === '-f') return ok([context.podName]);
    if (name === 'whoami') {
      // restricted-v2 runs with an arbitrary, passwd-less UID, so whoami fails
      // exactly like a real RHEL UBI container on OCP 4.22.
      return ok(
        context.restricted
          ? [`whoami: cannot find name for user ID ${context.runtimeUid}`]
          : ['default']
      );
    }
    if (name === 'id') {
      return ok(
        context.restricted
          ? [`uid=${context.runtimeUid} gid=0(root) groups=0(root),${context.runtimeUid}`]
          : ['uid=1000840000(default) gid=0(root) groups=0(root),1000840000']
      );
    }
    if (name === 'env' || name === 'printenv') {
      const entries = [...context.env.entries()];
      if (name === 'printenv' && args[0]) {
        const value = context.env.get(args[0]);
        return ok(value === undefined ? [] : [String(value)]);
      }
      return ok(entries.map(([key, value]) => `${key}=${value}`));
    }
    if (name === 'pwd') return ok(['/']);
    if (name === 'ls' || name === 'll') {
      const flags = args.filter((arg) => arg.startsWith('-'));
      const targetArg = args.find((arg) => !arg.startsWith('-')) || '/';
      const target = this._podExecNormalizePath(targetArg, '/');
      const longFormat = flags.some((flag) => /l/.test(flag));
      const all = flags.some((flag) => /a/.test(flag));
      if (context.files.has(target)) {
        if (longFormat) {
          const file = context.files.get(target) || '';
          return ok([
            `-rw-r--r--. 1 root root ${String(file.length).padStart(6)} ${target.split('/').pop()}`,
          ]);
        }
        return ok([target.split('/').pop()]);
      }
      if (!context.dirs.has(target)) {
        return ok([`ls: cannot access '${targetArg}': No such file or directory`]);
      }
      const entries = [...context.dirs.get(target)].sort();
      const shown = all ? entries : entries.filter((entry) => !entry.startsWith('.'));
      if (longFormat) {
        const destination = target === '/' ? '' : target;
        return ok(
          shown.map((entry) => {
            const child = `${destination}/${entry}`.replace(/\/+/g, '/');
            const isDir = context.dirs.has(child);
            return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'}. 1 root root ${
              isDir ? '    4096' : String((context.files.get(child) || '').length).padStart(8)
            } ${entry}`;
          })
        );
      }
      return ok([shown.join('  ')]);
    }
    if (name === 'cat') {
      const files = args.filter((arg) => arg !== '-' && !arg.startsWith('-'));
      if (!files.length) return ok(stdinText === null ? [] : stdinText.split('\n').slice(0, -1));
      const lines = [];
      let failed = false;
      for (const file of files) {
        const target = this._podExecNormalizePath(file, '/');
        if (!context.files.has(target)) {
          lines.push(`cat: ${file}: No such file or directory`);
          failed = true;
          continue;
        }
        lines.push(...String(context.files.get(target)).replace(/\n$/, '').split('\n'));
      }
      return { ok: !failed, lines };
    }
    if (name === 'echo') {
      const text = args.filter((arg) => !/^-[neE]+$/.test(arg)).join(' ');
      return ok([text]);
    }
    if (name === 'grep') {
      const ignoreCase = args.some((arg) => /^-[A-Za-z]*i/.test(arg));
      const invert = args.some((arg) => /^-[A-Za-z]*v/.test(arg));
      const positional = args.filter((arg) => !arg.startsWith('-'));
      const pattern = positional[0];
      if (pattern === undefined) return { ok: false, lines: ['usage: grep pattern'] };
      let matcher;
      try {
        matcher = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch {
        matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
      }
      const lines = pipeLines().filter((line) => matcher.test(line) !== invert);
      return { ok: lines.length > 0, lines };
    }
    if (name === 'head' || name === 'tail') {
      const match = args.join(' ').match(/-n?\s*(\d+)/);
      const count = match ? Number(match[1]) : 10;
      const lines = pipeLines();
      return ok(
        name === 'head' ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count))
      );
    }
    if (name === 'wc') {
      const flag = args.find((arg) => /^-[lwc]+$/.test(arg)) || '-lwc';
      const lines = pipeLines();
      const counts = {
        l: lines.length,
        w: lines.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0),
        c: lines.join('\n').length,
      };
      return ok([
        [
          ...(flag.includes('l') ? [counts.l] : []),
          ...(flag.includes('w') ? [counts.w] : []),
          ...(flag.includes('c') ? [counts.c] : []),
        ].join(' '),
      ]);
    }
    if (name === 'curl') {
      // #43: real curl flag handling (`-s -o /dev/null -w "%{http_code}"`,
      // scheme-default ports, NetworkPolicy drops → (28) timeout) lives in
      // ShellTools.runExecCurl so the workstation shell and `oc exec` agree.
      const rendered = this.shellTools?.runExecCurl?.(args, context);
      if (rendered) return rendered;
      const sim = this.gameEngine?.simulation || this.gameEngine?.sim || null;
      const argv = args.filter((token) => token && !token.startsWith('-'));
      const rawTarget = argv[argv.length - 1] || '';
      let target = rawTarget;
      let port = null;
      if (target) {
        const parsed = target.match(/^[a-z]+:\/\/([^/:]+)(?::(\d+))?/i);
        if (parsed) {
          target = parsed[1];
          port = parsed[2] ? Number(parsed[2]) : null;
        } else {
          const hostPort = target.match(/^([^:]+):(\d+)$/);
          if (hostPort) {
            target = hostPort[1];
            port = Number(hostPort[2]);
          }
        }
      }
      if (sim && typeof sim.trafficForExec === 'function' && target) {
        const result = sim.trafficForExec(context.pod, {
          target,
          ...(port ? { port } : {}),
          namespace: context.namespace,
          protocol: 'TCP',
          // Container resolved from the workload's pod template, not `main`
          // (#54d: `oc exec deploy/webapp -- curl …` runs in container webapp).
          container: context.containerName,
        });
        if (result && Array.isArray(result.lines) && result.lines.length) return ok(result.lines);
      }
      // Fallback body when the engine cannot route the request: use the app's
      // real response for the origin-hello-openshift image and the resolved
      // container name (never a hardcoded `main`, #54d).
      const image = String(context.container?.image || '');
      if (/hello-openshift/.test(image)) {
        return ok(['<html><body>Hello OpenShift!</body></html>']);
      }
      const selector = context.pod?.metadata?.labels?.app || '';
      return ok([
        `<html><body>Hello from ${selector || context.podName} (container ${context.containerName})</body></html>`,
      ]);
    }
    if (name === 'nslookup' || name === 'dig') {
      const target = args[args.length - 1] || '';
      return ok([
        'Server:\t\t172.30.0.10',
        'Address:\t172.30.0.10#53',
        '',
        `Name:\t${target}`,
        'Address: 172.30.43.12',
      ]);
    }
    // Unknown binary: keep the legacy simulator hint instead of pretending.
    return ok([
      `(command executed in ${context.podName}/${context.containerName})`,
      `$ ${argv.join(' ')}`,
      'exit code 0',
    ]);
  },

  /** Resolve a container path (`/etc/app`, `/etc/app/APP_MODE`) against `/`. */
  _podExecNormalizePath(path, base = '/') {
    const target = String(path || '');
    let resolved;
    if (target.startsWith('/')) resolved = target;
    else if (target === '~') resolved = '/root';
    else if (target.startsWith('~/')) resolved = `/root/${target.slice(2)}`;
    else resolved = `${base.replace(/\/+$/, '')}/${target}`;
    const segments = [];
    for (const segment of resolved.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join('/')}`;
  },

  /**
   * Cluster DNS Service address for a Pod's `/etc/resolv.conf`: the seeded
   * `openshift-dns/dns-default` ClusterIP (172.30.0.10 on real OCP 4.22).
   * @returns {string}
   */
  _clusterDnsServiceIP() {
    const service = this.cluster?.getByName?.('Service', 'dns-default', 'openshift-dns');
    const clusterIP = service?.spec?.clusterIP;
    return clusterIP && clusterIP !== 'None' ? String(clusterIP) : CLUSTER_DNS_SERVICE_IP;
  },

  /**
   * Build the simulated Pod filesystem + environment from the Pod spec:
   * ConfigMap/Secret/downwardAPI volumes become files, `env`/`envFrom`/
   * `valueFrom` become environment entries (#32d).
   */
  _podExecContext(pod, containerName) {
    const namespace = pod.metadata?.namespace || 'default';
    const containers = this._containerList(pod);
    const container =
      containers.find((entry) => entry.name === containerName) || containers[0] || {};
    const files = new Map();
    const dirs = new Map([['/', new Set()]]);
    const addDir = (path) => {
      const clean = this._podExecNormalizePath(path);
      if (!dirs.has(clean)) dirs.set(clean, new Set());
      dirs.get('/').add(clean === '/' ? '' : clean.split('/')[1]);
      const parent = clean === '/' ? null : clean.slice(0, clean.lastIndexOf('/')) || '/';
      if (parent && dirs.has(parent)) dirs.get(parent).add(clean.split('/').pop());
      return clean;
    };
    const addFile = (path, content) => {
      const clean = this._podExecNormalizePath(path);
      files.set(clean, String(content ?? ''));
      addDir(clean.slice(0, clean.lastIndexOf('/')) || '/');
      const parent = clean.slice(0, clean.lastIndexOf('/')) || '/';
      if (dirs.has(parent)) dirs.get(parent).add(clean.split('/').pop());
    };
    for (const standardDir of [
      '/bin',
      '/boot',
      '/dev',
      '/etc',
      '/home',
      '/lib',
      '/media',
      '/mnt',
      '/opt',
      '/proc',
      '/root',
      '/run',
      '/sbin',
      '/srv',
      '/sys',
      '/tmp',
      '/usr',
      '/var',
      '/usr/bin',
      '/usr/sbin',
      '/usr/local',
      '/usr/local/bin',
    ]) {
      addDir(standardDir);
    }
    addFile('/etc/hostname', `${pod.metadata?.name || 'pod'}\n`);
    addFile(
      '/etc/hosts',
      '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n172.30.0.1\tkubernetes.default.svc\n'
    );
    // Every real Pod's /etc/resolv.conf points at the cluster DNS Service
    // ClusterIP — that is `openshift-dns/dns-default` 172.30.0.10 on OCP. The
    // command is the first thing a learner runs when lab 13 breaks DNS (#58).
    addFile(
      '/etc/resolv.conf',
      `search ${namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver ${this._clusterDnsServiceIP()}\noptions ndots:5\n`
    );
    addFile(
      '/etc/os-release',
      'NAME="Red Hat Enterprise Linux"\nVERSION="9.4 (Plow)"\nID="rhel"\nID_LIKE="fedora"\nVERSION_ID="9.4"\nPRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"\n'
    );
    addFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/bash\n');
    for (const mount of container.volumeMounts || []) {
      const mountPath = String(mount?.mountPath || '').replace(/\/+$/, '');
      if (!mountPath.startsWith('/')) continue;
      const volume = (pod.spec?.volumes || []).find((entry) => entry.name === mount.name);
      if (!volume) continue;
      const entries = this._volumeDirectoryEntries(volume, pod, namespace);
      if (mount.subPath) {
        const content = entries.get(String(mount.subPath).replace(/^\/+/, ''));
        if (content !== undefined) addFile(mountPath, content);
        continue;
      }
      addDir(mountPath);
      for (const [entryName, content] of entries) {
        addFile(`${mountPath}/${entryName}`, content);
      }
    }
    // #42: every Pod (unless automountServiceAccountToken:false) exposes the
    // projected service-account tree under /var/run/secrets/kubernetes.io/serviceaccount.
    this._appendServiceAccountFiles(pod, namespace, container, { addDir, addFile });
    const env = this._podEnvironment(pod, container, namespace);
    const podScc = String(pod.metadata?.annotations?.['openshift.io/scc'] || 'restricted-v2');
    return {
      pod,
      podName: pod.metadata?.name || 'pod',
      namespace,
      container,
      containerName: container.name || containerName,
      restricted: /^restricted/.test(podScc),
      runtimeUid: 1000000000 + stableHash(`${namespace}/${pod.metadata?.name || 'pod'}`, 8999999),
      files,
      dirs,
      env,
    };
  },

  /**
   * Add the projected service-account tree to the simulated Pod filesystem (#42):
   * `token` (JWT-shaped bound token), `ca.crt` (kube-root-ca.crt), `namespace`
   * (downwardAPI) and `service-ca.crt` (openshift-service-ca.crt), mounted at the
   * `kube-api-access-*` projected volume's mountPath when the Pod spec carries it.
   * @param {object} pod
   * @param {string} namespace
   * @param {object} container
   * @param {{addDir: Function, addFile: Function}} fs
   */
  _appendServiceAccountFiles(pod, namespace, container, { addDir, addFile }) {
    const automount = pod.spec?.automountServiceAccountToken !== false;
    let mountPath = null;
    for (const mount of container.volumeMounts || []) {
      const volume = (pod.spec?.volumes || []).find((entry) => entry.name === mount.name);
      const sources = volume?.projected?.sources || [];
      if (sources.some((source) => source?.serviceAccountToken)) {
        mountPath = String(mount.mountPath || '').replace(/\/+$/, '');
        break;
      }
    }
    // Real Pods always mount it unless automountServiceAccountToken is false;
    // seeded/legacy Pods in the simulator keep the standard path as a fallback.
    if (!mountPath) {
      if (!automount) return;
      mountPath = '/var/run/secrets/kubernetes.io/serviceaccount';
    }
    if (!mountPath) return;
    const segments = this._podExecNormalizePath(mountPath).split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      addDir(current);
    }
    addFile(`${mountPath}/namespace`, `${namespace}\n`);
    addFile(`${mountPath}/token`, this._serviceAccountToken(pod, namespace));
    addFile(`${mountPath}/ca.crt`, this._serviceAccountCaBundle(namespace));
    addFile(`${mountPath}/service-ca.crt`, this._serviceCaBundle(namespace));
  },

  /**
   * A realistic bound service-account token: three base64url JWT segments whose
   * payload carries the real 4.x bound-token claims (aud/exp/iat/iss/jti/
   * kubernetes.io namespace/pod/serviceaccount, sub) (#42).
   * @param {object} pod
   * @param {string} namespace
   * @returns {string}
   */
  _serviceAccountToken(pod, namespace) {
    const now = Math.floor(Date.now() / 1000);
    const serviceAccount = pod.spec?.serviceAccountName || pod.spec?.serviceAccount || 'default';
    const podName = pod.metadata?.name || 'pod';
    const uid = pod.uid || pod.metadata?.uid || this._imageDigest(podName).slice(0, 8);
    const header = this._base64Url(
      JSON.stringify({ alg: 'RS256', kid: this._imageDigest('sa-signing-key').slice(7, 27) })
    );
    const payload = this._base64Url(
      JSON.stringify({
        aud: ['https://kubernetes.default.svc'],
        exp: now + 3607,
        iat: now,
        iss: 'https://kubernetes.default.svc',
        jti: this._imageDigest(`${namespace}/${podName}/${now}`).slice(7, 39),
        kubernetes: {
          namespace,
          node: {
            name: pod.spec?.nodeName || 'worker-1',
            uid: this._imageDigest(`node-${pod.spec?.nodeName || 'worker-1'}`).slice(0, 8),
          },
          pod: { name: podName, uid },
          serviceaccount: {
            name: serviceAccount,
            uid: this._imageDigest(`${namespace}/${serviceAccount}`).slice(0, 8),
          },
        },
        nbf: now,
        sub: `system:serviceaccount:${namespace}:${serviceAccount}`,
      })
    );
    const signature = this._base64Url(
      `${this._imageDigest(`sa-sig-${namespace}/${podName}`).slice(7)}${this._imageDigest(`sa-sig2-${namespace}/${podName}`).slice(7)}${this._imageDigest(`sa-sig3-${namespace}/${podName}`).slice(7)}`
    );
    return `${header}.${payload}.${signature}\n`;
  },

  /** PEM-formatted bundle for the SA directory; real ConfigMap contents win. */
  _serviceAccountCaBundle(namespace) {
    const configMap = this.cluster?.getByName?.('ConfigMap', 'kube-root-ca.crt', namespace);
    const data = configMap?.spec?.data || configMap?.data || {};
    const bundle = data['ca.crt'];
    if (typeof bundle === 'string' && bundle.includes('BEGIN CERTIFICATE'))
      return bundle.endsWith('\n') ? bundle : `${bundle}\n`;
    return this._fakePem('kube-root-ca', namespace);
  },

  /** `openshift-service-ca.crt` bundle for the SA directory (#42). */
  _serviceCaBundle(namespace) {
    const configMap = this.cluster?.getByName?.('ConfigMap', 'openshift-service-ca.crt', namespace);
    const data = configMap?.spec?.data || configMap?.data || {};
    const bundle = data['service-ca.crt'];
    if (typeof bundle === 'string' && bundle.includes('BEGIN CERTIFICATE'))
      return bundle.endsWith('\n') ? bundle : `${bundle}\n`;
    return this._fakePem('openshift-service-ca', namespace);
  },

  /** Deterministic PEM-looking certificate (fallback when the CA ConfigMap is absent). */
  _fakePem(label, seed) {
    const body = `${this._imageDigest(`pem-${label}-${seed}`)}${this._imageDigest(`pem2-${label}-${seed}`)}${this._imageDigest(`pem3-${label}-${seed}`)}`;
    const chunks = body.match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${chunks.join('\n')}\n-----END CERTIFICATE-----\n`;
  },

  /** Files contributed by a Pod volume (configMap / secret / projected / downwardAPI). */
  _volumeDirectoryEntries(volume, pod, namespace) {
    const entries = new Map();
    const itemsFor = (items) => {
      const map = new Map();
      for (const item of items || []) {
        if (item?.key) map.set(String(item.key), String(item.path || item.key).replace(/^\/+/, ''));
      }
      return map;
    };
    const addData = (data, items, decodeBase64Value) => {
      const itemMap = itemsFor(items);
      for (const [key, value] of Object.entries(data || {})) {
        const target = itemMap.size ? itemMap.get(key) : key;
        if (!target) continue;
        entries.set(
          String(target).replace(/^\/+/, ''),
          decodeBase64Value ? this._decodeBase64(value) : String(value ?? '')
        );
      }
    };
    if (volume.configMap) {
      const configMap = this.cluster.getByName('ConfigMap', volume.configMap.name, namespace);
      addData(configMap?.spec?.data, volume.configMap.items, false);
    } else if (volume.secret) {
      // Pod volume spec uses `secretName` (projected sources use `name`).
      const secretName = volume.secret.secretName || volume.secret.name;
      const secret = this.cluster.getByName('Secret', secretName, namespace);
      addData(secret?.spec?.data, volume.secret.items, true);
    } else if (volume.projected) {
      for (const source of volume.projected.sources || []) {
        if (source.configMap) {
          const configMap = this.cluster.getByName('ConfigMap', source.configMap.name, namespace);
          addData(configMap?.spec?.data, source.configMap.items, false);
        } else if (source.secret) {
          const secret = this.cluster.getByName('Secret', source.secret.name, namespace);
          addData(secret?.spec?.data, source.secret.items, true);
        } else if (source.downwardAPI) {
          for (const item of source.downwardAPI.items || []) {
            const value = this._downwardApiValue(pod, item?.fieldRef);
            if (value !== null && item?.path) entries.set(String(item.path), `${value}\n`);
          }
        }
      }
    } else if (volume.downwardAPI) {
      for (const item of volume.downwardAPI.items || []) {
        const value = this._downwardApiValue(pod, item?.fieldRef);
        if (value !== null && item?.path) entries.set(String(item.path), `${value}\n`);
      }
    }
    return entries;
  },

  /** Resolve a downwardAPI fieldRef against the Pod. */
  _downwardApiValue(pod, fieldRef) {
    const path = String(fieldRef?.fieldPath || '');
    const labelled = path.match(/^metadata\.(labels|annotations)\['([^']+)'\]$/);
    if (labelled) return (pod.metadata?.[labelled[1]] || {})[labelled[2]] ?? null;
    switch (path) {
      case 'metadata.name':
        return pod.metadata?.name ?? null;
      case 'metadata.namespace':
        return pod.metadata?.namespace ?? null;
      case 'metadata.uid':
        return pod.uid || pod.metadata?.uid || null;
      case 'spec.nodeName':
        return pod.spec?.nodeName || null;
      case 'spec.serviceAccountName':
        return pod.spec?.serviceAccountName || 'default';
      case 'status.podIP':
      case 'status.podIPs':
        return pod.status?.podIP || null;
      default:
        return null;
    }
  },

  /** Container environment: base env + envFrom + env/valueFrom resolution. */
  _podEnvironment(pod, container, namespace) {
    const env = new Map();
    env.set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    env.set('KUBERNETES_SERVICE_HOST', '172.30.0.1');
    env.set('KUBERNETES_SERVICE_PORT', '443');
    env.set('HOSTNAME', pod.metadata?.name || 'pod');
    for (const from of container.envFrom || []) {
      const prefix = String(from.prefix || '');
      if (from.configMapRef) {
        const configMap = this.cluster.getByName('ConfigMap', from.configMapRef.name, namespace);
        for (const [key, value] of Object.entries(configMap?.spec?.data || {})) {
          env.set(`${prefix}${key}`, String(value ?? ''));
        }
      } else if (from.secretRef) {
        const secret = this.cluster.getByName('Secret', from.secretRef.name, namespace);
        for (const [key, value] of Object.entries(secret?.spec?.data || {})) {
          env.set(`${prefix}${key}`, this._decodeBase64(value));
        }
      }
    }
    for (const entry of container.env || []) {
      if (!entry?.name) continue;
      if (entry.value !== undefined) {
        env.set(entry.name, String(entry.value));
        continue;
      }
      const valueFrom = entry.valueFrom || {};
      if (valueFrom.fieldRef?.fieldPath) {
        const value = this._downwardApiValue(pod, valueFrom.fieldRef);
        if (value !== null) env.set(entry.name, String(value));
      } else if (valueFrom.configMapKeyRef) {
        const reference = valueFrom.configMapKeyRef;
        const configMap = this.cluster.getByName('ConfigMap', reference.name, namespace);
        const data = configMap?.spec?.data || {};
        if (reference.key in data) env.set(entry.name, String(data[reference.key]));
      } else if (valueFrom.secretKeyRef) {
        const reference = valueFrom.secretKeyRef;
        const secret = this.cluster.getByName('Secret', reference.name, namespace);
        const data = secret?.spec?.data || {};
        if (reference.key in data) env.set(entry.name, this._decodeBase64(data[reference.key]));
      }
    }
    return env;
  },

  /**
   * Why `oc exec`/`oc rsh` cannot attach to this container, or null when it is
   * running. CrashLoopBackOff / ImagePullBackOff / completed Pods must fail
   * exactly like real oc (#35) — never pretend the command ran.
   */
  _execContainerStateError(pod, containerName) {
    const phase = String(pod?.status?.phase || pod?.phase || 'Pending');
    if (phase === 'Succeeded' || phase === 'Failed') {
      return `error: cannot exec into a container in a completed pod; current phase is ${phase}`;
    }
    const statuses = pod?.status?.containerStatuses || [];
    if (!statuses.length) {
      if (phase === 'Running') return null;
      return `error: unable to upgrade connection: container not found ("${containerName}")`;
    }
    const status = statuses.find((entry) => entry.name === containerName) || statuses[0] || null;
    const state = status?.state || {};
    if (state.running) return null;
    const reason =
      state.waiting?.reason || state.terminated?.reason || (status?.ready ? 'Ready' : phase);
    return [
      `error: unable to upgrade connection: container not found ("${containerName}")`,
      `container "${containerName}" is not running (${reason}); cannot exec into a container that is not running`,
    ].join('\n');
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
      longValues: [
        'namespace',
        'name',
        'hostname',
        'path',
        'port',
        'target-port',
        'selector',
        'wildcard-policy',
        'type',
        'protocol',
        'labels',
        'session-affinity',
        'cluster-ip',
        'external-name',
        'load-balancer-ip',
        'overrides',
      ],
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
    if (!kind) kind = kind || 'Service';
    if (!name)
      return this._usageError(
        'expose',
        'resource name is required\n\n  oc expose svc/<name> [--hostname=] [--path=]'
      );
    const namespace = this._namespaceFromFlags(flags);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const text = (flagName) =>
      flags[flagName] !== undefined && flags[flagName] !== true ? String(flags[flagName]) : null;
    const ge = this.gameEngine;

    // ── `oc expose svc/<name>` → Route (never a Service) ───────────────────
    if (kind === 'Service') {
      const options = {
        namespace,
        name: text('name') || undefined,
        hostname: text('hostname') || '',
        path: text('path') || '',
        port: text('port') || undefined,
        wildcardPolicy: text('wildcard-policy') || undefined,
      };
      let service = this._findResource('Service', name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowOtherNamespaces: false,
      });
      let serviceWarning = '';
      if (!service) {
        // Simulator convenience: `oc expose svc/web` right after creating a
        // Deployment "web" (the EX280 quick-start flow) creates the missing
        // Service from the workload's template labels/ports.
        const workload =
          this._findResource('Deployment', name, {
            namespace: flags.namespace,
            explicitNamespace: Boolean(flags.namespace),
            allowOtherNamespaces: false,
          }) ||
          this._findResource('StatefulSet', name, {
            namespace: flags.namespace,
            explicitNamespace: Boolean(flags.namespace),
            allowOtherNamespaces: false,
          }) ||
          this._findResource('DaemonSet', name, {
            namespace: flags.namespace,
            explicitNamespace: Boolean(flags.namespace),
            allowOtherNamespaces: false,
          });
        if (workload) {
          const labels = workload.spec?.template?.metadata?.labels || { app: name };
          const selector = workload.spec?.selector?.matchLabels || labels;
          const containerPorts = (workload.spec?.template?.spec?.containers || []).flatMap(
            (container) => container.ports || []
          );
          const ports = (containerPorts.length ? containerPorts : [{ containerPort: 8080 }]).map(
            (port, index) => ({
              name: port.name || (index === 0 ? 'http' : `port-${port.containerPort}`),
              port: Number(flags.port) || port.containerPort || 8080,
              targetPort: port.containerPort || 8080,
              protocol: port.protocol || 'TCP',
            })
          );
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
      const routeName = options.name || name;
      if (ge && typeof ge.exposeService === 'function') {
        const result = ge.exposeService(name, options);
        if (result.success === false) return this._err(result.message);
        this._normalizeRoutePath(routeName, namespace, options.path);
        return this._ok(
          [serviceWarning, `route.route.openshift.io/${routeName} exposed`]
            .filter(Boolean)
            .join('\n')
        );
      }
      const routeSpec = {
        host: options.hostname || '',
        path: options.path || '',
        to: { kind: 'Service', name, weight: 100 },
        port: {
          targetPort:
            options.port ||
            service.spec?.ports?.[0]?.name ||
            service.spec?.ports?.[0]?.port ||
            'http',
        },
        wildcardPolicy: options.wildcardPolicy || 'None',
      };
      const created = this._applyObject({
        apiVersion: 'route.openshift.io/v1',
        kind: 'Route',
        metadata: { name: routeName, namespace },
        spec: routeSpec,
      });
      if (created.error) return created.error;
      return this._ok(
        [serviceWarning, `route.route.openshift.io/${routeName} exposed`].filter(Boolean).join('\n')
      );
    }

    // ── `oc expose deployment/<name>` → Service only (issue: no Route) ─────
    if (
      ['Deployment', 'DeploymentConfig', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod'].includes(
        kind
      )
    ) {
      const workload = this._findResource(kind, name, {
        namespace: flags.namespace,
        explicitNamespace: Boolean(flags.namespace),
        allowOtherNamespaces: false,
      });
      if (!workload) return this._err(this._notFoundMessage(kind, name));
      const serviceName = text('name') || name;
      const existing = this._findResource('Service', serviceName, {
        namespace,
        explicitNamespace: true,
        allowPrefix: false,
      });
      if (existing)
        return this._err(
          `Error from server (AlreadyExists): services "${serviceName}" already exists`
        );
      const templateLabels =
        kind === 'Pod'
          ? workload.metadata?.labels || {}
          : workload.spec?.template?.metadata?.labels || {};
      const labels = text('labels')
        ? parseCommaAssignments(text('labels'))
        : { ...(workload.metadata?.labels || templateLabels) };
      const selector = text('selector')
        ? parseCommaAssignments(text('selector'))
        : kind === 'Pod'
          ? { ...(workload.metadata?.labels || {}) }
          : { ...(workload.spec?.selector?.matchLabels || templateLabels) };
      if (!Object.keys(selector).length) {
        return this._err(
          `error: couldn't find selectors for ${this._resourceRef(kind)}/${name}; specify --selector`
        );
      }
      const containerPorts =
        kind === 'Pod'
          ? (workload.spec?.containers || []).flatMap((container) => container.ports || [])
          : (workload.spec?.template?.spec?.containers || []).flatMap(
              (container) => container.ports || []
            );
      const firstPort = containerPorts[0] || null;
      const serviceTypeToken = String(text('type') || 'ClusterIP').toLowerCase();
      const serviceTypes = {
        clusterip: 'ClusterIP',
        nodeport: 'NodePort',
        loadbalancer: 'LoadBalancer',
        externalname: 'ExternalName',
      };
      if (!serviceTypes[serviceTypeToken]) {
        return this._err(
          `error: invalid service type "${text('type')}": must be one of ClusterIP, NodePort, LoadBalancer, ExternalName`
        );
      }
      const protocol = String(text('protocol') || firstPort?.protocol || 'TCP').toUpperCase();
      if (!['TCP', 'UDP', 'SCTP'].includes(protocol))
        return this._err(`error: invalid protocol "${text('protocol')}"`);
      const port = text('port') ? Number(text('port')) : Number(firstPort?.containerPort) || 80;
      const targetPortRaw = text('target-port');
      const targetPort = targetPortRaw
        ? /^\d+$/.test(targetPortRaw)
          ? Number(targetPortRaw)
          : targetPortRaw
        : Number(firstPort?.containerPort) || port;
      const servicePort = { name: firstPort?.name || 'http', port, targetPort, protocol };
      if (/^\d+$/.test(String(servicePort.name))) servicePort.name = 'http';
      const spec = {
        type: serviceTypes[serviceTypeToken],
        selector,
        ports: [servicePort],
      };
      if (spec.type === 'ExternalName') {
        delete spec.selector;
        const externalName = text('external-name');
        if (!externalName)
          return this._err('error: cannot expose an external name service without --external-name');
        spec.externalName = externalName;
      }
      if (text('cluster-ip')) spec.clusterIP = text('cluster-ip');
      if (text('session-affinity')) spec.sessionAffinity = text('session-affinity');
      const created = this._applyObject({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: serviceName, namespace, labels },
        spec,
      });
      if (created.error) return created.error;
      return this._ok(`service/${serviceName} exposed`);
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
      const propertyMatch = line.match(
        /^\s*(displayName|description|required|value|generate):\s*(.*)$/
      );
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
    const templateName =
      flags.template && flags.template !== true ? String(flags.template) : positionals[0] || null;
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
        if (text === null || text === undefined)
          return this._manifestReady()
            ? this._err(`error: open ${filename}: no such file or directory`)
            : this._manifestNotReady();
        return this._printTemplateParameters(this._templateParametersFromText(text));
      }
      if (templateName) {
        const templateObject = this._findTemplate(templateName);
        if (!templateObject)
          return this._err(
            `Error from server (NotFound): templates.template.openshift.io "${templateName}" not found`
          );
        return this._printTemplateParameters(
          templateObject.spec?.parameters || templateObject.parameters || []
        );
      }
      return this._err('error: you must specify a template with -f <file> or <template-name>');
    }

    let text = '';
    let objects = [];
    if (filename) {
      const processed = this._processTemplateDelegated(filename, params, {
        stdinText: ctx?.stdin ?? null,
      });
      if (processed.error) return processed;
      text = processed.text || '';
      objects = processed.objects || [];
    } else if (templateName) {
      const ge = this.gameEngine;
      let result = null;
      const template = this._findTemplate(templateName);
      if (
        ge &&
        typeof ge.processTemplate === 'function' &&
        template &&
        !BUILTIN_TEMPLATES[templateName]
      ) {
        result = ge.processTemplate(templateName, params, { namespace, apply: false });
      }
      if (result && result.success === false && !template) return this._err(result.message);
      if (result && result.success !== false && Array.isArray(result.objects))
        objects = result.objects;
      else {
        if (!template)
          return this._err(
            `Error from server (NotFound): templates.template.openshift.io "${templateName}" not found`
          );
        const missing = this._templateRequiredMissing(template, params);
        if (missing.length)
          return this._err(
            `error: unable to process template: Template parameter(s) required: [${missing.join(
              ' '
            )}]`
          );
        objects = this._renderTemplateObjects(template, params);
      }
    } else {
      return this._err(
        'error: must specify a template with -f <file> or <template-name>\n\n  oc process -f <file> [-p KEY=VALUE] [-o yaml]'
      );
    }

    if (!objects.length && text) return this._ok(text);
    if (output.format === 'json') {
      return this._ok(
        JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }, null, 4)
      );
    }
    if (output.format === 'name') {
      return this._ok(
        objects
          .map(
            (object) => `${this._resourceRef(object.kind)}/${object.metadata?.name || 'unnamed'}`
          )
          .join('\n')
      );
    }
    if (output.format === 'yaml' || output.format === 'table') {
      return this._ok(
        toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects })
      );
    }
    return this._ok(
      text || toYamlDocument({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects })
    );
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
    if (!result || result.ok === false)
      return this._err(result?.error || result?.errors?.[0] || 'error: kustomize build failed');
    const objects = Array.isArray(result.objects) ? result.objects : [];
    const warnings = (result.warnings || []).map((warning) => `warning: ${warning}`);
    const prefix = warnings.length ? `${warnings.join('\n')}\n` : '';
    if (output.format === 'json') {
      return this._ok(
        prefix +
          JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: {}, items: objects }, null, 4)
      );
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
      const found = this._findResource('Template', name, {
        namespace: candidate,
        explicitNamespace: true,
      });
      if (found) return found;
    }
    return this._builtinTemplate(name);
  },

  /** Declared parameters of a Template (builtin, file-based or API resource). */
  _templateParameterDefinitions(template) {
    const declared = template.spec?.parameters || template.parameters || [];
    return Array.isArray(declared) ? declared : [];
  },

  /**
   * Required parameters that still have no usable value: neither `-p K=V`, nor
   * a default `value`, nor a `generate` expression. Mirrors the API server's
   * `Template parameter(s) required: [NAME]` rejection.
   */
  _templateRequiredMissing(template, params) {
    const provided = params || {};
    const missing = [];
    for (const parameter of this._templateParameterDefinitions(template)) {
      if (!parameter.required) continue;
      const supplied = provided[parameter.name];
      if (supplied !== undefined && supplied !== '') continue;
      if (parameter.value !== undefined) continue;
      if (parameter.generate) continue;
      missing.push(parameter.name);
    }
    return missing;
  },

  /**
   * Expand a template `generate: expression` parameter. The simulator supports
   * the fixed-length character-class form templates actually use
   * (`[a-zA-Z0-9]{16}`, `[a-z0-9]{8}`...); anything else falls back to a
   * 16-character alphanumeric value.
   */
  _generateTemplateValue(from) {
    const source = String(from || '').trim();
    const charset = (chars) => chars.replace(/[^A-Za-z0-9]/g, '');
    const match = source.match(/\[([^\]]+)\]\{(\d+)\}/);
    let chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let length = 16;
    if (match) {
      const ranges = match[1];
      const expanded = [
        /a-z/.test(ranges) ? 'abcdefghijklmnopqrstuvwxyz' : '',
        /A-Z/.test(ranges) ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '',
        /0-9/.test(ranges) ? '0123456789' : '',
        charset(ranges.replace(/a-z|A-Z|0-9/g, '')),
      ].join('');
      if (expanded) chars = expanded;
      length = Math.max(1, Math.min(64, parseInt(match[2], 10) || 16));
    }
    let value = '';
    for (let i = 0; i < length; i += 1) {
      value += chars[Math.floor(Math.random() * chars.length)];
    }
    return value;
  },

  _renderTemplateObjects(template, params) {
    const definitions = this._templateParameterDefinitions(template);
    const parameters = {};
    for (const parameter of definitions) {
      if (parameter.value !== undefined) parameters[parameter.name] = String(parameter.value);
    }
    Object.assign(parameters, params || {});
    // Parameters with `generate: expression` get a fresh value, exactly like
    // `oc process` / `oc new-app --template` on a real cluster.
    for (const parameter of definitions) {
      if (parameters[parameter.name] !== undefined && parameters[parameter.name] !== '') continue;
      if (parameter.generate)
        parameters[parameter.name] = this._generateTemplateValue(parameter.from);
    }
    const substitute = (value) => {
      if (typeof value === 'string')
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) =>
          parameters[key] !== undefined ? parameters[key] : match
        );
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
      longValues: [
        'namespace',
        'name',
        'image',
        'image-stream',
        'code',
        'template',
        'file',
        'env',
        'param',
        'context-dir',
        'source-secret',
        'strategy',
        'replicas',
        'port',
        'builder-image',
      ],
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
    const imageStream =
      flags['image-stream'] && flags['image-stream'] !== true
        ? String(flags['image-stream'])
        : null;
    const code = flags.code && flags.code !== true ? String(flags.code) : null;
    const image = flags.image && flags.image !== true ? String(flags.image) : null;
    const ge = this.gameEngine;

    // `oc new-app -f template-file`: process the file and apply the objects.
    if (file) {
      const processed = this._processTemplateDelegated(file, params, {
        stdinText: ctx?.stdin ?? null,
      });
      if (processed.error) return processed;
      const objects = processed.objects || [];
      if (!objects.length) return this._err('error: template file produced no objects');
      return this._newAppDeployObjects(objects, {
        namespace,
        templateName: this._basename(file),
        name,
      });
    }

    // `oc new-app --template=<name>`.
    if (templateName) {
      const template = this._findTemplate(templateName);
      if (ge && typeof ge.newApp === 'function' && template && !BUILTIN_TEMPLATES[templateName]) {
        const result = ge.newApp({ template: templateName, params, name, namespace });
        if (result.success === false) return this._err(result.message);
        return this._ok(this._formatNewAppOutput(result, { namespace, templateName }));
      }
      if (!template)
        return this._err(
          `Error while generating the application: template "${templateName}" not found`
        );
      const missing = this._templateRequiredMissing(template, params);
      if (missing.length)
        return this._err(
          `error: unable to process template: Template parameter(s) required: [${missing.join(' ')}]`
        );
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
      return this._err(
        'error: no image, source or template specified for oc new-app\n\n  oc new-app <image|git-url> [--name=] [--code=] [--template=<name>] [-f <template-file>]'
      );
    }

    if (ge && typeof ge.newApp === 'function') {
      const options = {
        namespace,
        name,
        image: resolvedImage || undefined,
        imageStream: resolvedImageStream || undefined,
        code: resolvedCode || undefined,
        env,
        contextDir:
          flags['context-dir'] && flags['context-dir'] !== true
            ? String(flags['context-dir'])
            : undefined,
        replicas: flags.replicas ? Number(flags.replicas) : undefined,
        port: flags.port ? Number(flags.port) : undefined,
        builderImage:
          flags['builder-image'] && flags['builder-image'] !== true
            ? String(flags['builder-image'])
            : undefined,
      };
      const result = ge.newApp(options);
      if (result.success === false) return this._err(result.message);
      // #42: real `oc new-app --image=…` creates the ImageStreamTag target for
      // the deployed image; create and print it before the workload resources.
      if (resolvedImage) {
        const deployment = (result.resources || []).find((entry) => entry.kind === 'Deployment');
        const appName =
          deployment?.metadata?.name || this._appNameFromSource(String(resolvedImage || 'app'));
        const imageStream = this._ensureImageStream(namespace, appName, 'latest', resolvedImage);
        if (imageStream)
          result.resources = [imageStream, ...(result.resources || []).filter(Boolean)];
      }
      return this._ok(
        this._formatNewAppOutput(result, {
          namespace,
          source: resolvedImage || resolvedImageStream || resolvedCode || '',
        })
      );
    }

    // Fallback: create Deployment + Service directly.
    if (resolvedImage || resolvedImageStream) {
      const appName =
        name || this._appNameFromSource(resolvedImage || resolvedImageStream || 'app');
      const imageRef = resolvedImage || `${INTERNAL_REGISTRY}/openshift/${resolvedImageStream}`;
      const container = { name: 'main', image: imageRef, ports: [{ containerPort: 8080 }] };
      if (Object.keys(env).length)
        container.env = Object.entries(env).map(([key, value]) => ({ name: key, value }));
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
        spec: {
          selector: { app: appName },
          ports: [{ name: 'http', port: 8080, targetPort: 8080 }],
        },
      });
      if (!service.error) createdObjects.push(service.resource);
      return this._ok(
        this._formatNewAppOutput({ resources: createdObjects, message: '' }, { namespace })
      );
    }
    return this._err('error: oc new-app from source requires the game engine to be initialised');
  },

  _appNameFromSource(source) {
    const raw = String(source || 'app')
      .split('~')[0]
      .split('|')[0]
      .replace(/\/+$/, '');
    let name = raw.split('/').pop() || 'app';
    name = name.replace(/\.git$/, '');
    if (name.includes(':')) name = name.split(':')[0];
    return (
      name
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .toLowerCase()
        .replace(/^-+|-+$/g, '') || 'app'
    );
  },

  _formatNewAppOutput(result, context = {}) {
    const namespace = context.namespace || this.currentProject;
    const resources = result.resources || [];
    const lines = [];
    if (context.templateName) {
      lines.push(
        `--> Deploying template "${context.templateName}" for "${context.templateName}" to project ${namespace}`,
        ''
      );
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
      longValues: [
        'namespace',
        'name',
        'code',
        'image-stream',
        'strategy',
        'context-dir',
        'dockerfile',
        'to',
      ],
      longBools: ['binary', 'dockerfile'],
    });
    const ge = this.gameEngine;
    const namespace = this._namespaceFromFlags(flags);
    const source = positionals[0];
    // Real oc accepts `oc new-build <image-stream>~<git-url>`: split the two.
    let sourceImageStream = undefined;
    let sourceCode = undefined;
    if (source && String(source).includes('~')) {
      const [beforeImage, afterImage] = String(source).split('~');
      sourceImageStream = beforeImage;
      sourceCode = afterImage;
    }
    const imageStreamArg = sourceImageStream || source;
    const code =
      flags.code && flags.code !== true
        ? String(flags.code)
        : sourceCode !== undefined
          ? sourceCode
          : source && (/^(https?:\/\/|git@)/.test(source) || source === '.')
            ? source
            : undefined;
    let imageStream =
      flags['image-stream'] && flags['image-stream'] !== true
        ? String(flags['image-stream'])
        : source && !code
          ? imageStreamArg
          : undefined;
    // `openshift/nodejs:20-ubi9` → tag `nodejs:20-ubi9` (namespace defaults to openshift).
    if (imageStream)
      imageStream = String(imageStream).replace(/^(?:openshift|openshift-config)\//, '');
    const name = flags.name && flags.name !== true ? String(flags.name) : undefined;
    if (!code && !imageStream && !flags.dockerfile && !flags.binary) {
      return this._err(
        'error: no image or source specified\n\n  oc new-build <image-stream> --name=<bc>\n  oc new-build --code=<git-url> --name=<bc>'
      );
    }
    if (ge && typeof ge.newBuild === 'function') {
      const result = ge.newBuild({
        name,
        code,
        imageStream,
        namespace,
        dockerfile: flags.dockerfile
          ? String(flags.dockerfile === true ? 'Dockerfile' : flags.dockerfile)
          : undefined,
      });
      if (result.success === false) return this._err(result.message);
      const buildConfig = result.buildConfig;
      const buildConfigName = buildConfig?.metadata?.name || name;
      const lines = ['--> Creating resources ...'];
      // #42: real `oc new-build` creates and prints the output ImageStream up
      // front (the build later pushes the built image into it).
      const imageStreamResource = buildConfigName
        ? this._ensureImageStream(namespace, buildConfigName, buildConfig?.spec?.output?.to?.name)
        : null;
      if (imageStreamResource)
        lines.push(
          `    imagestream.image.openshift.io "${imageStreamResource.metadata?.name}" created`
        );
      if (buildConfig)
        lines.push(`    buildconfig.build.openshift.io "${buildConfigName}" created`);
      // #49: on a real cluster the BuildConfig's ConfigChange trigger starts the
      // first build immediately — `oc get builds` right after `oc new-build`
      // already shows `<name>-1`, no `oc start-build` needed. Create it
      // synchronously (after the output ImageStream exists) instead of letting
      // the controller pick it up on a later tick.
      if (buildConfig && buildConfigName && typeof ge.startBuild === 'function') {
        // A failed trigger start is retried by the controller on the next tick.
        ge.startBuild(buildConfigName, { namespace });
      }
      lines.push(
        '--> Success',
        `    Build scheduled, use 'oc logs -f bc/${buildConfigName}' to track its progress.`,
        "    Run 'oc status' to view your app."
      );
      return this._ok(lines.join('\n'));
    }
    return this._err('error: oc new-build requires the game engine to be initialised');
  },

  /**
   * Create an output ImageStream if it does not exist yet (#42). Real
   * `oc new-build`/`oc new-app` create the ImageStreamTag target before the
   * first build/image import runs.
   * @param {string} namespace
   * @param {string} name
   * @param {string} [tagName] `name:latest` / `web:latest`
   * @returns {object|null} the ImageStream resource
   */
  _ensureImageStream(namespace, name, tagName, imageRef) {
    if (!name) return null;
    const existing = this.cluster?.getByName?.('ImageStream', name, namespace);
    if (existing) return existing;
    const tag = String(tagName || 'latest').includes(':')
      ? String(tagName).split(':').pop()
      : 'latest';
    const applied = this._applyObject({
      apiVersion: 'image.openshift.io/v1',
      kind: 'ImageStream',
      metadata: { name, namespace, labels: { app: name } },
      spec: {
        lookupPolicy: { local: false },
        tags: [
          {
            name: tag,
            generation: 1,
            ...(imageRef
              ? { from: { kind: 'DockerImage', name: String(imageRef) }, importPolicy: {} }
              : {}),
          },
        ],
      },
    });
    if (applied.error) return null;
    const imageStream = applied.resource || null;
    // Real `oc new-app --image=…` imports the image into the ImageStreamTag.
    if (imageStream && imageRef && typeof this.cluster?.updateImageStreamTag === 'function') {
      try {
        this.cluster.updateImageStreamTag(namespace, name, tag, {
          dockerImageReference: String(imageRef),
          image: undefined,
          isExternal: true,
          silent: true,
        });
      } catch {
        /* status is cosmetic; keep the created object */
      }
    }
    return imageStream;
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
      return this._usageError(
        'start-build',
        'build config name is required\n\n  oc start-build <buildconfig> [--follow] [--from-dir=.]'
      );
    }
    const namespace = this._namespaceFromFlags(flags);
    const ge = this.gameEngine;
    if (ge && typeof ge.startBuild === 'function') {
      const result = ge.startBuild(buildConfigName, { namespace });
      if (result.success === false) return this._err(result.message);
      const lines = [result.message || `build.build.openshift.io/${buildConfigName}-1 started`];
      if (flags.follow) {
        // Real `oc start-build --follow` streams the build logs and only prints
        // `--> Success` once the build reaches Complete (a build that is still
        // Running must not report success). The command returns immediately with
        // the started line; the log chunks are appended by a poller as the
        // controllers advance the Build resource.
        const buildName = result.build?.metadata?.name || `${buildConfigName}-1`;
        this._watchBuildFollow(buildName, namespace);
      } else if (result.build) {
        lines.push("Run 'oc logs -f bc/" + buildConfigName + "' to follow the build logs.");
      }
      return this._ok(lines.join('\n'));
    }
    return this._err('error: oc start-build requires the game engine to be initialised');
  },

  /**
   * Follow an in-flight Build like `oc start-build --follow` / `oc logs -f`:
   * append log chunks as the Build moves through Running and only print
   * `--> Success` when it reaches Complete (issue #35).
   * @param {string} buildName
   * @param {string} namespace
   */
  _watchBuildFollow(buildName, namespace) {
    this._clearBuildWatches();
    const state = { stopped: false, timer: null, phase: null, startedAt: Date.now() };
    this._buildWatches = [state];
    const finish = () => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
      this._buildWatches = (this._buildWatches || []).filter((entry) => entry !== state);
    };
    const findBuild = () =>
      this._getKindList('Build').find(
        (candidate) =>
          candidate.metadata?.name === buildName &&
          candidate.metadata?.namespace === (namespace || this.currentProject)
      ) || null;
    const poll = () => {
      if (state.stopped) return;
      const build = findBuild();
      if (!build) {
        if (Date.now() - state.startedAt > 180000) finish();
        return;
      }
      const phase = build.status?.phase || 'New';
      if (phase === state.phase) return;
      const previousPhase = state.phase;
      state.phase = phase;
      if (phase === 'New' || phase === 'Pending') return;
      const logLines = this._buildLogLines(build);
      if (phase === 'Running') {
        // Stream the logs produced so far; no success claim while running.
        this._appendOutput(logLines.join('\n'), 'text-white/70');
        return;
      }
      // Terminal phase — append the remaining log lines exactly once. When the
      // Running chunk was already shown, the shared head (Cloning … STEP 4/5)
      // was already printed, so only the completion tail is appended.
      const tail = previousPhase === 'Running' ? logLines.slice(11) : logLines;
      this._appendOutput(tail.join('\n'), phase === 'Failed' ? 'text-red-400' : 'text-white/70');
      if (phase === 'Complete') {
        this._appendOutput('--> Success', 'text-green-400/80');
      } else if (phase === 'Failed') {
        this._appendOutput(
          `error: build ${build.metadata?.name || buildName} failed`,
          'text-red-400'
        );
      }
      finish();
    };
    state.timer = setInterval(poll, 350);
    // First sample on the next macrotask so the command's own output is printed
    // before any follow-up log lines.
    setTimeout(poll, 50);
  },

  _clearBuildWatches() {
    for (const state of this._buildWatches || []) {
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
    }
    this._buildWatches = [];
  },

  _cmdCancelBuild(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace'],
      longBools: ['all', 'state'],
    });
    const { kind, name } = this._resolveRef(positionals);
    const target = kind === 'Build' || kind === 'BuildConfig' ? name : kind ? null : positionals[0];
    if (!target)
      return this._usageError(
        'cancel-build',
        'name is required\n\n  oc cancel-build <buildconfig|build>'
      );
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
    if (!source)
      return this._usageError(
        'tag',
        'source and destination image streams are required\n\n  oc tag <source> <destination> [--scheduled]'
      );
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
      return this._usageError(
        'import-image',
        'image stream reference is required\n\n  oc import-image <imagestream>:<tag> --from=<image> --confirm'
      );
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
        ].join('\n')
      );
    }
    return this._err('error: oc import-image requires the game engine to be initialised');
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Admin, authorization, debug, Helm, htpasswd and help
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  _cmdAdm(tokens, ctx) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    switch (sub) {
      case 'policy':
        return this._admPolicy(rest, ctx);
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
          `error: unknown adm subcommand "${sub || ''}"\n\nValid subcommands:\n  policy   Manage authorization (roles, SCCs, who-can)\n  groups   Manage groups\n  cordon   Mark a node unschedulable\n  uncordon Mark a node schedulable\n  drain    Evict pods from a node\n  taint    Update the taints on nodes\n  top      Display resource usage\n  create-bootstrap-project-template  Output the default project-request template\n  must-gather  Collect cluster diagnostics (simulated)\n  inspect  Inspect a resource and its dependents (simulated)\n\nRun 'oc adm --help' for details.`
        );
    }
  },

  _admPolicy(tokens, ctx) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    const { positionals, flags } = parseArgs(rest, {
      shortValues: { '-n': 'namespace', '-z': 'serviceaccount', '-f': 'filename' },
      longValues: [
        'namespace',
        'serviceaccount',
        'filename',
        'rolebinding-name',
        'clusterrole',
        'role',
        'user',
        'group',
        'output',
      ],
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
    const notAvailable = () =>
      this._err('error: authorization changes are not available in this build');

    switch (sub) {
      case 'add-role-to-user':
      case 'add-cluster-role-to-user':
      case 'add-role-to-group':
      case 'add-cluster-role-to-group': {
        const isClusterWide = sub.includes('cluster-role');
        const subjectKind = sub.endsWith('-group') ? 'Group' : 'User';
        if (!role || (!subject && !saName)) {
          return this._usageError(
            'adm',
            `role and subject are required\n\n  oc adm policy ${sub} <role> <${subjectKind.toLowerCase()}|-z sa> [-n <project>]`
          );
        }
        const target = saName || subject;
        if (!ge) return notAvailable();
        let result;
        if (sub === 'add-role-to-user') {
          result = engineCall('addRoleToUser', [
            role,
            target,
            { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) },
          ]);
        } else if (sub === 'add-cluster-role-to-user') {
          result = engineCall('addClusterRoleToUser', [
            role,
            target,
            { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) },
          ]);
        } else if (sub === 'add-role-to-group') {
          result = engineCall('addRoleToGroup', [role, target, { namespace }]);
        } else {
          result = engineCall('addClusterRoleToGroup', [role, target, { namespace }]);
        }
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        return this._ok(
          `${this._rbacRoleRefLine(result, role, isClusterWide)} added: "${this._rbacSubjectLabel(result, saName, target)}"`
        );
      }
      case 'remove-role-from-user':
      case 'remove-cluster-role-from-user':
      case 'remove-role-from-group':
      case 'remove-cluster-role-from-group': {
        const isClusterWide = sub.includes('cluster-role');
        const subjectKind = sub.endsWith('-group') ? 'Group' : 'User';
        if (!role || !subject) {
          return this._usageError(
            'adm',
            `role and subject are required\n\n  oc adm policy ${sub} <role> <${subjectKind.toLowerCase()}> [-n <project>]`
          );
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
        return this._ok(
          `${this._rbacRoleRefLine(result, role, isClusterWide)} removed: "${this._rbacSubjectLabel(result, null, subject)}"`
        );
      }
      case 'add-scc-to-user':
      case 'add-scc-to-group': {
        const sccName = role;
        const target = saName || subject;
        if (!sccName || !target) {
          return this._usageError(
            'adm',
            `SCC and subject are required\n\n  oc adm policy ${sub} <scc> <user|-z sa> [-n <project>]`
          );
        }
        if (!ge) return notAvailable();
        let result;
        if (sub === 'add-scc-to-group') {
          result = engineCall('addSCCToGroup', [sccName, target, { namespace }]);
        } else {
          result = engineCall('addSCCToUser', [
            sccName,
            target,
            { namespace, serviceAccount: Boolean(saName), z: Boolean(saName) },
          ]);
        }
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        // OCP 4.x output (openshift/oc since PR #412): the grant is a
        // ClusterRole `system:openshift:scc:<name>` bound to the subject.
        //   $ oc adm policy add-scc-to-user anyuid -z nginx-sa
        //   clusterrole.rbac.authorization.k8s.io/system:openshift:scc:anyuid added: "nginx-sa"
        const subjectLabel = this._rbacSubjectLabel(result, saName, target);
        return this._ok(
          `clusterrole.rbac.authorization.k8s.io/system:openshift:scc:${sccName} added: "${subjectLabel}"`
        );
      }
      case 'remove-scc-from-user':
      case 'remove-scc-from-group': {
        const sccName = role;
        const target = subject;
        if (!sccName || !target) {
          return this._usageError(
            'adm',
            `SCC and subject are required\n\n  oc adm policy ${sub} <scc> <user|group>`
          );
        }
        if (!ge) return notAvailable();
        const method = sub === 'remove-scc-from-group' ? 'removeSCCFromGroup' : 'removeSCCFromUser';
        const result = engineCall(method, [sccName, target, { namespace }]);
        if (!result) return notAvailable();
        if (result.success === false) return this._err(result.message);
        return this._ok(
          `clusterrole.rbac.authorization.k8s.io/system:openshift:scc:${sccName} removed: "${target}"`
        );
      }
      case 'who-can': {
        const verb = positionals[0];
        let resourceToken = positionals[1];
        // Real syntax is `oc adm policy who-can use scc privileged` (resource
        // type + name as two args) — also accept `scc/privileged`.
        const firstResourceToken = String(resourceToken || '').toLowerCase();
        if (
          ['scc', 'sccs', 'securitycontextconstraints', 'securitycontextconstraint'].includes(
            firstResourceToken
          ) &&
          positionals[2]
        ) {
          resourceToken = `scc/${positionals[2]}`;
        }
        if (!verb || !resourceToken) {
          return this._usageError(
            'adm',
            'verb and resource are required\n\n  oc adm policy who-can <verb> <resource> [-n <project>]'
          );
        }
        const kind = normalizeKind(resourceToken) || resourceToken;
        const who =
          ge && typeof ge.whoCan === 'function'
            ? ge.whoCan(verb, kind, namespace)
            : this._whoCanFallback(verb, kind, namespace);
        const users = (who || [])
          .filter((entry) => entry.kind === 'User')
          .map((entry) => entry.name);
        const groups = (who || [])
          .filter((entry) => entry.kind === 'Group')
          .map((entry) => entry.name);
        // Real oc lists service-account subjects as `system:serviceaccount:<ns>:<sa>`
        // under Users (there is no separate ServiceAccounts section).
        const userIdentities = [
          ...users,
          ...(who || [])
            .filter((entry) => entry.kind === 'ServiceAccount')
            .map((entry) => entry.name),
        ];
        const sccToken = String(resourceToken).match(/^scc\/(.+)$/);
        const clusterScoped =
          Boolean(sccToken) || isClusterScopedKind(normalizeKind(resourceToken) || '');
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
        const pushList = (label, entries) => {
          if (!entries.length) return;
          lines.push(`${label}${entries[0]}`);
          for (const entry of entries.slice(1)) {
            lines.push(`${' '.repeat(label.length)}${entry}`);
          }
        };
        pushList('Users:  ', userIdentities);
        pushList('Groups: ', groups);
        if (!userIdentities.length && !groups.length) lines.push('<none>');
        return this._ok(lines.join('\n'));
      }
      case 'scc-review':
      case 'scc-subject-review': {
        const cluster = this.cluster;
        if (!cluster || typeof cluster.sccAllowsPod !== 'function') return notAvailable();
        const filename = flags.filename && flags.filename !== true ? String(flags.filename) : null;
        const reviewNamespace = this._namespaceFromFlags(flags) || this.currentProject || 'default';
        /** Extract the Pod spec from a workload manifest. */
        const podSpecFromManifest = (doc) => {
          const kind = normalizeKind(doc?.kind) || doc?.kind;
          const spec = doc?.spec || {};
          if (kind === 'Pod') return { kind, spec };
          const path = {
            Deployment: ['template', 'spec'],
            DeploymentConfig: ['template', 'spec'],
            ReplicaSet: ['template', 'spec'],
            ReplicationController: ['template', 'spec'],
            StatefulSet: ['template', 'spec'],
            DaemonSet: ['template', 'spec'],
            Job: ['template', 'spec'],
            CronJob: ['jobTemplate', 'spec', 'template', 'spec'],
          }[kind];
          if (!path) return { kind, spec: null };
          let target = spec;
          for (const segment of path) {
            target = target?.[segment];
            if (!target) break;
          }
          return { kind, spec: target || null };
        };
        const rows = [];
        let docs = [];
        if (filename) {
          const preview = this._manifestPreviewDocs(filename, {
            stdinText: ctx?.stdin ?? null,
          });
          if (preview.error) return preview.error;
          docs = preview.docs || [];
        } else if (!saName) {
          return this._usageError(
            'adm',
            `a resource must be specified\n\n  oc adm policy ${sub} -f <file>   |   oc adm policy ${sub} -z <serviceaccount> -n <project>`
          );
        }
        for (const doc of docs) {
          const { kind, spec: podSpec } = podSpecFromManifest(doc);
          if (!podSpec) {
            return this._err(
              `error: ${doc?.kind || 'resource'} is not a pod or does not have a pod template`
            );
          }
          const docNamespace = doc?.metadata?.namespace || reviewNamespace;
          const serviceAccount =
            (flags.serviceaccount && flags.serviceaccount !== true
              ? String(flags.serviceaccount)
              : null) ||
            podSpec.serviceAccountName ||
            podSpec.serviceAccount ||
            'default';
          const candidates =
            typeof cluster.getSCCsForServiceAccount === 'function'
              ? cluster.getSCCsForServiceAccount(docNamespace, serviceAccount)
              : this._resources('SecurityContextConstraints');
          const allowed = (candidates || []).find((scc) => cluster.sccAllowsPod(scc, podSpec));
          const allowedBy = allowed?.metadata?.name || '<none>';
          rows.push([
            `${kind}/${doc?.metadata?.name || 'unnamed'}`,
            ...(sub === 'scc-review' ? [serviceAccount] : []),
            allowedBy,
          ]);
        }
        if (!docs.length) {
          // `-z <sa>` without a resource: review the service account with an
          // unconstrained pod spec (the most restrictive usable SCC wins).
          const candidates =
            typeof cluster.getSCCsForServiceAccount === 'function'
              ? cluster.getSCCsForServiceAccount(reviewNamespace, saName)
              : this._resources('SecurityContextConstraints');
          rows.push([
            `ServiceAccount/${reviewNamespace}/${saName}`,
            ...(sub === 'scc-review' ? [saName] : []),
            candidates?.[0]?.metadata?.name || '<none>',
          ]);
        }
        const headers =
          sub === 'scc-review'
            ? ['RESOURCE', 'SERVICE ACCOUNT', 'ALLOWED BY']
            : ['RESOURCE', 'ALLOWED BY'];
        return this._ok(padTable(headers, rows));
      }
      default:
        return this._err(
          `error: unknown policy subcommand "${sub || ''}"\n\nValid subcommands:\n  add-role-to-user, add-cluster-role-to-user, add-role-to-group, add-cluster-role-to-group\n  remove-role-from-user, remove-cluster-role-from-user, remove-role-from-group, remove-cluster-role-from-group\n  add-scc-to-user, add-scc-to-group, remove-scc-from-user, remove-scc-from-group\n  who-can, scc-review, scc-subject-review`
        );
    }
  },

  /** `clusterrole.rbac.authorization.k8s.io/view` style role reference for policy output. */
  _rbacRoleRefLine(result, role, isClusterWide) {
    const roleKind =
      result?.roleKind ||
      (isClusterWide ? 'ClusterRole' : null) ||
      (this._resources('ClusterRole').some((entry) => entry.metadata?.name === role)
        ? 'ClusterRole'
        : 'Role');
    const resource = roleKind === 'ClusterRole' ? 'clusterrole' : 'role';
    const group = result?.roleRefApiGroup || 'rbac.authorization.k8s.io';
    return `${resource}.${group}/${role}`;
  },

  /** Real oc's subject label: bare SA name for `-z`, the user/group name otherwise. */
  _rbacSubjectLabel(result, saName, fallback) {
    if (result?.subjectLabel) return result.subjectLabel;
    if (saName) return saName;
    return fallback;
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
      if (
        !this._evaluateRules(
          this._roleRules('ClusterRole', roleRef.name),
          verb,
          pluralForKind(kind)
        )
      )
        continue;
      for (const subject of binding.spec?.subjects || [])
        add({ kind: subject.kind, name: subject.name });
    }
    for (const binding of this._resources('RoleBinding')) {
      if (binding.metadata?.namespace !== namespace) continue;
      const roleRef = binding.spec?.roleRef || {};
      if (
        !this._evaluateRules(
          this._roleRules(roleRef.kind || 'Role', roleRef.name, namespace),
          verb,
          pluralForKind(kind)
        )
      )
        continue;
      for (const subject of binding.spec?.subjects || [])
        add({ kind: subject.kind, name: subject.name });
    }
    return results;
  },

  _admGroups(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    const ge = this.gameEngine;
    if (!['new', 'add-users', 'remove-users'].includes(sub)) {
      return this._err(
        `error: unknown groups subcommand "${sub || ''}"\n\nValid subcommands: new, add-users, remove-users`
      );
    }
    if (sub === 'new') {
      const name = rest[0];
      if (!name)
        return this._usageError(
          'adm',
          'group name is required\n\n  oc adm groups new <group> [users...]'
        );
      const users = rest.slice(1);
      if (ge && typeof ge.createGroupResource === 'function') {
        const result = ge.createGroupResource(name, users);
        if (result.success === false) return this._err(result.message);
        return this._ok(result.message || `group.user.openshift.io/${name} created`);
      }
      return this._finishCreateObject(
        { apiVersion: 'user.openshift.io/v1', kind: 'Group', metadata: { name }, spec: { users } },
        {}
      );
    }
    const group = rest[0];
    const users = rest.slice(1);
    if (!group || !users.length) {
      return this._usageError(
        'adm',
        'group and at least one user are required\n\n  oc adm groups ' + sub + ' <group> <user...>'
      );
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
      longBools: [
        'force',
        'ignore-daemonsets',
        'delete-emptydir-data',
        'dry-run',
        'disable-eviction',
      ],
    });
    let nodeRef = positionals[0];
    if (action === 'taint' && ['nodes', 'node'].includes(String(nodeRef || '').toLowerCase()))
      nodeRef = positionals[1];
    if (!nodeRef) {
      return this._usageError(
        'adm',
        `node name is required\n\n  oc adm ${action} node/<name> [flags]`
      );
    }
    const nodeName = nodeRef.includes('/') ? nodeRef.split('/').slice(1).join('/') : nodeRef;
    if (action === 'taint') {
      const taintSpec = positionals[0] === nodeRef ? positionals[1] : positionals[2];
      if (!nodeName || !taintSpec) {
        return this._usageError(
          'adm',
          'node and taint are required\n\n  oc adm taint nodes <node> key=value:NoSchedule'
        );
      }
      const node = this._findResource('Node', nodeName, {});
      if (!node) return this._err(this._notFoundMessage('Node', nodeName));
      // Real `oc adm taint` removal forms (trailing `-`):
      //   key-                      remove every taint with that key
      //   key:NoSchedule-           remove that key/effect
      //   key=value:NoSchedule-     remove that exact key/value/effect
      // The old parser stripped the `-` and compared the WHOLE spec against
      // `taint.key`, so `node-role.kubernetes.io/master:NoSchedule-` never
      // matched an existing taint and the command still printed "untainted"
      // (issue #55A).
      const remove = taintSpec.endsWith('-');
      /** kubectl/oc `ParseTaint` rejects unknown effects with a dedicated error. */
      const taintParseError = (match) => {
        if (!match) return this._err(`error: invalid taint spec "${taintSpec}"`);
        if (match[3] !== undefined && !VALID_TAINT_EFFECTS.includes(match[3]))
          return this._err(`error: invalid taint effect: ${match[3]}, unsupported taint effect`);
        return null;
      };
      const result = this._updateResource(
        'Node',
        nodeName,
        (spec) => {
          spec.taints = spec.taints || [];
          if (remove) {
            const removal = taintSpec.slice(0, -1);
            // `key=:Effect` (empty value) is valid kubectl grammar (#58): the
            // value group must accept the empty string.
            const match = removal.match(/^([^=:]+)(?:=([^:]*))?(?::([A-Za-z]+))?$/);
            const parseError = taintParseError(match);
            if (parseError) return { error: parseError };
            const [, key, value, effect] = match;
            spec.taints = spec.taints.filter(
              (taint) =>
                taint.key !== key ||
                (value !== undefined && String(taint.value ?? '') !== value) ||
                (effect !== undefined && taint.effect !== effect)
            );
            return {};
          }
          // `key=:Effect` is accepted by kubectl: it is a taint with an empty
          // value (e.g. `node-role.kubernetes.io/master=:NoSchedule`, #58).
          const match = taintSpec.match(/^([^=:]+)(?:=([^:]*))?:([A-Za-z]+)$/);
          const parseError = taintParseError(match);
          if (parseError) return { error: parseError };
          spec.taints = spec.taints.filter((taint) => taint.key !== match[1]);
          spec.taints.push({ key: match[1], value: match[2] || '', effect: match[3] });
          return {};
        },
        {}
      );
      if (result.error) return result.error;
      return this._ok(`node/${nodeName} ${remove ? 'untainted' : 'tainted'}`);
    }
    const node = this._findResource('Node', nodeName, {});
    if (!node) return this._err(this._notFoundMessage('Node', nodeName));
    if (action === 'cordon' || action === 'uncordon') {
      const cordon = action === 'cordon';
      this._updateResource(
        'Node',
        nodeName,
        (spec) => {
          spec.unschedulable = cordon;
          return {};
        },
        {}
      );
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
      (pod) =>
        pod.spec?.nodeName === nodeName ||
        pod.status?.nodeName === nodeName ||
        pod.status?.hostIP === nodeName
    );
    const daemonSetPods = pods.filter((pod) =>
      (pod.metadata?.ownerReferences || []).some((ref) => ref.kind === 'DaemonSet')
    );
    const evictable = pods.filter(
      (pod) => !(pod.metadata?.ownerReferences || []).some((ref) => ref.kind === 'DaemonSet')
    );
    const lines = [`node/${nodeName} cordoned`];
    if (daemonSetPods.length && !flags['ignore-daemonsets']) {
      lines.push(
        `WARNING: ignoring DaemonSet-managed Pods: ${daemonSetPods.map((pod) => `${pod.metadata?.namespace}/${pod.metadata?.name}`).join(', ')}`
      );
    }
    this._updateResource(
      'Node',
      nodeName,
      (spec) => {
        spec.unschedulable = true;
        return {};
      },
      {}
    );
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
        const cpuCapacity = this._parseQuantityToMilli(
          node.spec?.cpu || node.status?.capacity?.cpu || '8'
        );
        const memoryCapacity = this._parseQuantityToMi(
          node.spec?.memory || node.status?.capacity?.memory || '16Gi'
        );
        const usage = node.status?.usage || {};
        // `Node.status.usage` is numeric millicores / MiB in the simulator; a real
        // quantity string (from metrics) is parsed normally.
        const cpuUsed =
          typeof usage.cpu === 'number'
            ? usage.cpu
            : this._parseQuantityToMilli(usage.cpu) || 300 + stableHash(name, 2500);
        const memoryUsed =
          typeof usage.memory === 'number'
            ? Math.round(usage.memory)
            : this._parseQuantityToMi(usage.memory) || 1024 + stableHash(`${name}-mem`, 4096);
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
        const cpu =
          typeof usage.cpu === 'number'
            ? usage.cpu
            : this._parseQuantityToMilli(usage.cpu) || 5 + stableHash(name, 45);
        const memory =
          typeof usage.memory === 'number'
            ? Math.round(usage.memory)
            : this._parseQuantityToMi(usage.memory) || 20 + stableHash(`${name}-mem`, 180);
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
    const units = {
      Ki: 1 / 1024,
      Mi: 1,
      Gi: 1024,
      Ti: 1024 * 1024,
      K: 1000 / (1024 * 1024),
      M: (1000 * 1000) / (1024 * 1024),
      G: (1000 * 1000 * 1000) / (1024 * 1024),
    };
    const match = text.match(/^([0-9.]+)([A-Za-z]*)$/);
    if (!match) return 0;
    const number = Number.parseFloat(match[1]);
    const unit = units[match[2]] ?? 1;
    return Math.round(number * unit);
  },

  _admMustGather(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      longValues: ['dest-dir', 'image', 'timeout'],
      longBools: ['all'],
    });
    const destination =
      flags['dest-dir'] && flags['dest-dir'] !== true
        ? String(flags['dest-dir'])
        : `must-gather.local.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-4)}`;
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
      ].join('\n')
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
      return this._usageError(
        'adm',
        'resource is required\n\n  oc adm inspect ns/<project>   |   oc adm inspect pod/<name>'
      );
    }
    const namespace = flags.namespace || this.currentProject;
    let description = target;
    if (target.startsWith('ns/') || target.startsWith('namespace/')) {
      const project = target.split('/')[1];
      if (!this._projectExists(project))
        return this._err(
          `Error from server (NotFound): project.project.openshift.io "${project}" not found`
        );
      description = `namespace/${project}`;
    } else if (target.includes('/')) {
      const [kindToken, name] = target.split('/');
      const kind = normalizeKind(kindToken);
      if (!kind) return this._resourceTypeError(kindToken);
      if (!this._findResource(kind, name, { namespace, explicitNamespace: true }))
        return this._err(this._notFoundMessage(kind, name));
      description = `${this._resourceRef(kind)}/${name}`;
    }
    const destination =
      flags['dest-dir'] && flags['dest-dir'] !== true
        ? String(flags['dest-dir'])
        : `inspect.local.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    return this._ok(
      [
        `Gathering data for ${description} ...`,
        '  - collecting resources, events and logs',
        `Wrote inspect data to ${destination}.`,
      ].join('\n')
    );
  },

  _cmdAuth(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    if (sub !== 'can-i') {
      return this._err(
        `error: unknown auth subcommand "${sub || ''}"\n\n  oc auth can-i <verb> <resource> [--as=<user>] [--list]\n  oc auth can-i --list`
      );
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
      return this._ok(
        padTable(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs'], unique)
      );
    }
    const verb = positionals[0];
    const resourceToken = positionals[1];
    if (!verb || !resourceToken) {
      return this._usageError(
        'auth',
        'verb and resource are required\n\n  oc auth can-i <verb> <resource> [--as=<user>]\n  oc auth can-i --list'
      );
    }
    // SCC checks: the engine owns the OCP 4.x binding model (ClusterRole
    // system:openshift:scc:<name> for users/groups, project RoleBinding for -z);
    // fall back to the legacy spec.users/groups lists only without the engine.
    const sccMatch = resourceToken.match(/^scc\/(.+)$/);
    if (sccMatch) {
      const sccName = sccMatch[1];
      const scc = this._resources('SecurityContextConstraints').find(
        (candidate) => candidate.metadata?.name === sccName
      );
      if (!scc)
        return this._err(
          `Error from server (NotFound): securitycontextconstraints.security.openshift.io "${sccName}" not found`
        );
      const user = asUser || this.currentUser;
      let allowed = null;
      if (ge && typeof ge.canI === 'function') {
        try {
          const engineResult = ge.canI('use', `scc/${sccName}`, namespace, user);
          if (engineResult && typeof engineResult.allowed === 'boolean')
            allowed = engineResult.allowed;
        } catch {
          allowed = null;
        }
      }
      if (allowed === null) {
        const groups = this._userGroups(user);
        allowed =
          (scc.spec?.users || []).includes(user) ||
          (scc.spec?.groups || []).some((group) => groups.includes(group));
      }
      return this._ok(allowed ? 'yes' : 'no');
    }
    const kind = normalizeKind(resourceToken) || resourceToken;
    const resourcePlural = normalizeKind(resourceToken)
      ? pluralForKind(normalizeKind(resourceToken))
      : resourceToken;
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
    const { positionals, afterDoubleDash } = parseArgs(tokens, {
      longBools: [
        'keep-labels',
        'keep-init-containers',
        'keep-annotations',
        'keep-liveness',
        'keep-readiness',
        'as-root',
        'to-namespace',
      ],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'debug',
        'resource name is required\n\n  oc debug node/<node>   |   oc debug deployment/<name>'
      );
    if (kind === 'Node') {
      const node = this._findDebugNode(name);
      if (!node) return this._err(this._notFoundMessage('Node', name));
      const nodeName = node.metadata?.name || node.name || name;
      // One-shot form: `oc debug node/x -- chroot /host systemctl restart kubelet`.
      if (Array.isArray(afterDoubleDash) && afterDoubleDash.length > 0) {
        return this._runDebugOneShot(nodeName, afterDoubleDash.join(' '));
      }
      // Interactive session (#28): keep the debug shell open until `exit`.
      this._debugSession = { kind: 'node', name: nodeName, chroot: false, uid: node.uid };
      return this._ok(
        [
          `Creating debug namespace/openshift-debug-node-${nodeName} ...`,
          `Starting pod/${nodeName}-debug ...`,
          `To use host binaries, run \`chroot /host\``,
          `Pod IP: ${node.status?.addresses?.find((address) => address.type === 'InternalIP')?.address || '10.0.0.2'}`,
          `If you don't see a command prompt, try pressing enter.`,
          '',
          `${this._debugPrompt()} `,
        ].join('\n')
      );
    }
    const resource = this._findResource(kind, name, {
      namespace: this.currentProject,
      explicitNamespace: false,
    });
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
        .trimEnd()
    );
  },

  // ── Node debug session (issue #28) ────────────────────────────────────────
  /**
   * Resolve a node for `oc debug` (#53F).
   *
   * Resolution is exact-first: the requested name must match a real Node
   * resource. Only when that misses do we accept a *forward* legacy alias from
   * the campaign node catalog (`node-1 → worker-0`, `node-2 → worker-1`,
   * `node-3 → master-0`) — the reverse direction used to alias a real name
   * onto whichever legacy node happened to exist, so `oc debug node/worker-9`
   * (or `worker-0` on a legacy-named cluster) could silently land elsewhere.
   * Forward aliases stay so campaign level data authored with `node-N` keeps
   * working (contract with IncidentEngine NODE_NAME_ALIASES).
   * @param {string} name
   * @returns {object|null}
   */
  _findDebugNode(name) {
    const requested = String(name || '').trim();
    if (!requested) return null;
    const exact = this._findResource('Node', requested, {});
    if (exact) return exact;
    // Forward-only legacy alias: campaign level data still names nodes node-1…3
    // while the cluster presents worker-0/worker-1/master-0.
    const legacy = requested.toLowerCase().match(/^node-([1-9]\d*)$/);
    if (!legacy) return null;
    const catalog = ['worker-0', 'worker-1', 'master-0'];
    const mapped = catalog[Number(legacy[1]) - 1];
    if (!mapped) return null;
    return this._findResource('Node', mapped, {});
  },

  /**
   * The prompt shown for the active debug shell. Real `oc debug node/x` drops
   * you into the RHCOS 9 toolbox container's bash 5.1 shell, whose root prompt
   * is `sh-5.1#`; `chroot /host` enters the host's identical bash 5.1 shell, so
   * the prompt does not change (#49 — it used to show `(node/x) $` instead).
   * @returns {string}
   */
  _debugPrompt() {
    const session = this._debugSession;
    if (!session) return '$';
    return 'sh-5.1#';
  },

  /** Split `cmd1; cmd2 && cmd3` into individual debug-shell commands. */
  _splitDebugCommands(commandLine) {
    return String(commandLine || '')
      .split(/&&|;/)
      .map((part) => part.trim())
      .filter(Boolean);
  },

  /** Run `oc debug node/x -- <command>` without entering the session. */
  _runDebugOneShot(nodeName, commandLine) {
    const session = { kind: 'node', name: nodeName, chroot: false, uid: null };
    this._debugSession = null; // the one-shot form always exits afterwards
    const header = [
      `Creating debug namespace/openshift-debug-node-${nodeName} ...`,
      `Starting pod/${nodeName}-debug ...`,
      `To use host binaries, run \`chroot /host\``,
    ];
    const parts = this._splitDebugCommands(commandLine);
    if (parts.length === 0) {
      return this._ok([...header, 'sh-5.1# '].join('\n'));
    }
    // `-- chroot /host` with no trailing command opens the interactive host
    // shell, like `oc debug node/x -- chroot /host` on a real cluster.
    if (parts.length === 1 && /^chroot\s+\/host$/i.test(parts[0])) {
      session.chroot = true;
      this._debugSession = session;
      return this._ok([...header, '', `${this._debugPrompt()} `].join('\n'));
    }
    const outputs = [];
    let failed = false;
    for (const part of parts) {
      // The one-shot argument list runs in the debug pod, so `chroot /host …`
      // switches the subsequent commands to the node host shell.
      if (/^chroot\s+\/host\b/i.test(part)) session.chroot = true;
      const outcome = session.chroot
        ? this._runDebugHostCommand(session, part)
        : this._runDebugContainerCommand(session, part);
      if (outcome.message) outputs.push(outcome.message);
      if (outcome.error) {
        failed = true;
        break;
      }
      if (outcome.ended) break;
    }
    const message = [...header, ...outputs].join('\n');
    return failed ? this._err(message) : this._ok(message);
  },

  /**
   * Feed one line to the active debug session (called from executeCommand while
   * `_debugSession` is set). Echoes the debug prompt, runs the command and
   * returns the same result shape as every other command.
   * @param {string} rawInput
   */
  _runDebugSessionLine(rawInput) {
    const raw = String(rawInput ?? '').trim();
    const promptBefore = this._debugPrompt();
    this._pushHistory(raw);
    this._clearInput();
    this._appendOutput(raw ? `${promptBefore} ${raw}` : promptBefore, 'text-green-400/80');
    if (!raw) {
      const empty = {
        error: false,
        message: '',
        raw,
        normalized: '',
        baseCommand: 'debug',
        success: true,
      };
      this._lastResult = empty;
      return empty;
    }
    const session = this._debugSession;
    const outcome = this._runDebugCommandForSession(session, raw);
    if (outcome.message) {
      this._appendOutput(outcome.message, outcome.error ? 'text-red-400' : 'text-white/70');
    }
    if (outcome.ended) {
      this._appendOutput('logout', 'text-white/30');
    } else if (this._debugSession) {
      this._appendOutput(this._debugPrompt(), 'text-green-400/80');
    }
    const result = {
      error: Boolean(outcome.error),
      message: outcome.message || '',
      raw,
      normalized: raw,
      baseCommand: 'debug',
      success: !outcome.error,
      debugSession: Boolean(this._debugSession),
    };
    this._lastResult = result;
    return result;
  },

  /** Dispatch one debug-shell command, chrooted or inside the debug container. */
  _runDebugCommandForSession(session, commandLine) {
    if (!session) return { message: '', error: false, ended: true };
    if (!session.chroot) return this._runDebugContainerCommand(session, commandLine);
    return this._runDebugHostCommand(session, commandLine);
  },

  /** Commands available inside the debug container before `chroot /host`. */
  _runDebugContainerCommand(session, commandLine) {
    const tokens = tokenizeCommand(commandLine);
    const first = (tokens[0] || '').toLowerCase();
    if (first === 'chroot' && (tokens[1] || '') === '/host') {
      session.chroot = true;
      // `chroot /host <cmd>` runs <cmd> in the host shell immediately (the L20
      // hint uses `chroot /host systemctl restart kubelet`); it must not be
      // dropped after switching the session (#43).
      const remainder = String(commandLine || '')
        .replace(/^\s*chroot\s+\/host\b/i, '')
        .trim();
      if (!remainder) return { message: '', error: false };
      return this._runDebugHostCommand(session, remainder);
    }
    if (first === 'chroot') {
      return {
        message: `chroot: ${tokens[1] ? 'cannot change root directory' : 'missing operand'}`,
        error: true,
      };
    }
    if (first === 'exit' || first === 'logout') {
      this._debugSession = null;
      return { message: 'exit', error: false, ended: true };
    }
    if (first === 'help' || first === '?') {
      return {
        message:
          'Host binaries are not in this container. Run `chroot /host` first, then use systemctl/journalctl.',
        error: false,
      };
    }
    return { message: `bash: ${first || 'command'}: command not found`, error: true };
  },

  /**
   * Commands available on the node host shell after `chroot /host`.
   * `systemctl restart kubelet` is the state-driven repair of NodeNotReady.
   */
  _runDebugHostCommand(session, commandLine) {
    // Strip an optional `chroot /host` prefix (`oc debug … -- chroot /host …`).
    let line = String(commandLine || '').trim();
    if (/^chroot\s+\/host\b/i.test(line)) line = line.replace(/^chroot\s+\/host\b/i, '').trim();
    if (!line) return { message: '', error: false };
    const { command, filters } = this._splitDebugPipeline(line);
    const tokens = tokenizeCommand(command);
    const first = (tokens[0] || '').toLowerCase();
    if (first === 'exit' || first === 'logout') {
      if (session.chroot) {
        // First exit leaves the host shell and returns to the debug container.
        session.chroot = false;
        return { message: 'exit', error: false };
      }
      this._debugSession = null;
      return { message: 'exit', error: false, ended: true };
    }
    if (first === 'systemctl') {
      return this._debugSystemctl(session, tokens, filters);
    }
    if (first === 'journalctl') {
      return this._debugJournalctl(session, tokens, filters);
    }
    if (first === 'hostname') {
      return this._applyDebugFilters(session.name, filters);
    }
    if (first === 'uname') {
      // `uname -a` reports the actual node hostname (worker-0/worker-1/…), not a
      // generic `worker` (#43).
      const unameFlags = tokens.slice(1).filter((token) => token.startsWith('-'));
      const join = (line) => this._applyDebugFilters(line, filters);
      if (unameFlags.includes('-r')) return join(NODE_KERNEL_VERSION);
      if (unameFlags.includes('-n')) return join(session.name);
      if (unameFlags.includes('-m')) return join('x86_64');
      return join(
        `Linux ${session.name} ${NODE_KERNEL_VERSION} #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`
      );
    }
    if (first === 'df') {
      return this._applyDebugFilters(
        [
          'Filesystem      Size  Used Avail Use% Mounted on',
          '/dev/nvme0n1p4   50G  9.8G   40G  20% /sysroot',
          'tmpfs           32G     0   32G   0% /host/tmp',
        ].join('\n'),
        filters
      );
    }
    return { message: `bash: ${first || 'command'}: command not found`, error: true };
  },

  /** Split `journalctl -u kubelet | tail -n 20` into command + text filters. */
  _splitDebugPipeline(line) {
    const stages = String(line || '')
      .split('|')
      .map((stage) => stage.trim())
      .filter(Boolean);
    const command = stages.shift() || '';
    return { command, filters: stages };
  },

  /** Apply a tiny subset of pipe filters (`tail`, `head`, `grep`, `wc -l`). */
  _applyDebugFilters(text, filters = []) {
    let output = String(text ?? '');
    for (const filter of filters) {
      const tokens = tokenizeCommand(filter);
      const name = (tokens[0] || '').toLowerCase();
      if (name === 'tail') {
        const count = Number(tokens.find((token) => /^\d+$/.test(token)) || -10);
        const n = Math.abs(count) || 10;
        output = output.split('\n').slice(-n).join('\n');
      } else if (name === 'head') {
        const count = Number(tokens.find((token) => /^\d+$/.test(token)) || 10);
        output = output.split('\n').slice(0, count).join('\n');
      } else if (name === 'grep') {
        const pattern = tokens.slice(1).find((token) => !token.startsWith('-')) || '';
        try {
          const regex = new RegExp(pattern, 'i');
          output = output
            .split('\n')
            .filter((row) => regex.test(row))
            .join('\n');
        } catch {
          output = '';
        }
      } else if (name === 'wc') {
        output = String(output.split('\n').length);
      }
    }
    return { message: output, error: false };
  },

  /** `systemctl …` on the host, including the kubelet restart repair. */
  _debugSystemctl(session, tokens, filters = []) {
    const verb = (tokens[1] || '').toLowerCase();
    const unit = (tokens[2] || '').toLowerCase();
    const node = this._findDebugNode(session.name);
    const nodeReady = Boolean(
      node &&
      (node.status?.phase || 'Running') !== 'NotReady' &&
      (typeof node.isConditionTrue === 'function' ? node.isConditionTrue('Ready') : true)
    );
    if (verb === 'status' && (unit === 'kubelet' || unit === 'kubelet.service' || !unit)) {
      const status = nodeReady
        ? [
            '● kubelet.service - kubelet: The Kubernetes Node Agent',
            '     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)',
            '     Active: active (running)',
            '   Main PID: 2841 (kubelet)',
            '      Tasks: 21 (limit: 100000)',
            '     Memory: 84.2M',
          ].join('\n')
        : [
            '○ kubelet.service - kubelet: The Kubernetes Node Agent',
            '     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)',
            '     Active: inactive (dead)',
          ].join('\n');
      return this._applyDebugFilters(status, filters);
    }
    if (verb === 'restart' && (unit === 'kubelet' || unit === 'kubelet.service')) {
      const repaired = this._restartKubelet(session.name, session);
      if (!repaired.ok) return { message: repaired.message, error: true };
      return { message: '', error: false };
    }
    if (verb === 'is-active') {
      return { message: nodeReady ? 'active' : 'inactive', error: false };
    }
    if (verb === 'start' && (unit === 'kubelet' || unit === 'kubelet.service')) {
      this._restartKubelet(session.name, session);
      return { message: '', error: false };
    }
    return {
      message: `Unknown command verb ${verb || '(none)'}.`,
      error: true,
    };
  },

  /**
   * journalctl timestamp: short syslog form `Nov 04 20:00:01`, or the long
   * header form `Wed 2026-11-04 20:00:00 UTC` (real journalctl preamble).
   * @param {number|Date} value
   * @param {boolean} [long]
   */
  _journalTimestamp(value, long = false) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    const safe = Number.isFinite(date.getTime()) ? date : new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const pad = (number) => String(number).padStart(2, '0');
    const clock = `${pad(safe.getUTCHours())}:${pad(safe.getUTCMinutes())}:${pad(safe.getUTCSeconds())}`;
    if (long) {
      return `${days[safe.getUTCDay()]} ${safe.getUTCFullYear()}-${pad(safe.getUTCMonth() + 1)}-${pad(safe.getUTCDate())} ${clock} UTC`;
    }
    return `${months[safe.getUTCMonth()]} ${pad(safe.getUTCDate())} ${clock}`;
  },

  /** kubelet's Go-log prefix (`I1104 20:00:05.301`). */
  _klogTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    const safe = Number.isFinite(date.getTime()) ? date : new Date();
    const pad = (number) => String(number).padStart(2, '0');
    return `I${pad(safe.getUTCMonth() + 1)}${pad(safe.getUTCDate())} ${pad(safe.getUTCHours())}:${pad(safe.getUTCMinutes())}:${pad(safe.getUTCSeconds())}.${String(safe.getUTCMilliseconds()).padStart(3, '0')}`;
  },

  /** `journalctl -u kubelet …` on the host. */
  _debugJournalctl(session, tokens, filters = []) {
    // Real journalctl: `-u <unit>` filters to that unit; an unknown unit prints
    // `-- No entries --`. With no `-u` the whole journal is shown.
    const unitMatch = tokens.join(' ').match(/(?:-u\s+|--unit[= ])([^\s|]+)/i);
    const unit = unitMatch ? unitMatch[1].replace(/\.service$/, '') : null;
    if (unit && unit !== 'kubelet') {
      return { message: '-- No entries --', error: false };
    }
    const node = this._findDebugNode(session.name);
    const hostname = session?.name || 'worker-1';
    const nodeReady = Boolean(
      node &&
      (node.status?.phase || 'Running') !== 'NotReady' &&
      (typeof node.isConditionTrue === 'function' ? node.isConditionTrue('Ready') : true)
    );
    const now = Date.now();
    const begin = now - 10 * 60 * 1000;
    const header = `-- Logs begin at ${this._journalTimestamp(begin, true)}, end at ${this._journalTimestamp(now, true)}. --`;
    const lines = nodeReady
      ? [
          header,
          `${this._journalTimestamp(begin + 1000)} ${hostname} systemd[1]: Starting kubelet: The Kubernetes Node Agent...`,
          `${this._journalTimestamp(begin + 2000)} ${hostname} systemd[1]: Started kubelet: The Kubernetes Node Agent.`,
          `${this._journalTimestamp(begin + 5000)} ${hostname} kubelet[2841]: ${this._klogTimestamp(begin + 5000)} kubelet.go:2457] "Node status is Ready"`,
        ]
      : [
          header,
          `${this._journalTimestamp(now - 120000)} ${hostname} systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE`,
          `${this._journalTimestamp(now - 120000)} ${hostname} systemd[1]: kubelet.service: Failed with result 'exit-code'.`,
          `${this._journalTimestamp(now - 120000)} ${hostname} systemd[1]: Failed to start kubelet: The Kubernetes Node Agent.`,
        ];
    return this._applyDebugFilters(lines.join('\n'), filters);
  },

  /**
   * State-driven repair used by `systemctl restart kubelet` (#28): the kubelet
   * posts Ready again, so the Node becomes Ready and IncidentEngine's per-tick
   * state check clears NodeNotReady. Workload rescheduling/uncordon is done by
   * the incident's own resolution effect (or `oc adm uncordon`).
   */
  _restartKubelet(nodeName, session = null) {
    const node = this._findDebugNode(nodeName);
    if (!node)
      return { ok: false, message: `Failed to restart kubelet.service: "${nodeName}" not found` };
    if (typeof node.setPhase === 'function') {
      node.setPhase('Running');
    } else {
      node.status = node.status || {};
      node.status.phase = 'Running';
    }
    if (typeof node.setCondition === 'function') {
      node.setCondition('Ready', 'True', 'KubeletReady', 'kubelet is posting ready status');
    } else {
      node.status = node.status || {};
      node.status.conditions = Array.isArray(node.status.conditions) ? node.status.conditions : [];
      const index = node.status.conditions.findIndex((condition) => condition.type === 'Ready');
      const ready = {
        type: 'Ready',
        status: 'True',
        reason: 'KubeletReady',
        message: 'kubelet is posting ready status',
        lastTransitionTime: new Date().toISOString(),
      };
      if (index >= 0) node.status.conditions[index] = ready;
      else node.status.conditions.push(ready);
    }
    if (typeof node.recordEvent === 'function') {
      node.recordEvent(
        'Normal',
        'NodeReady',
        'kubelet restarted via oc debug; node is posting ready status'
      );
    }
    try {
      this.cluster?.update?.(node.uid, node);
    } catch {
      /* cluster may be mid-reset */
    }
    if (this.gameEngine && typeof this.gameEngine.emit === 'function') {
      try {
        this.gameEngine.emit('node:kubelet-restarted', {
          node: node.metadata?.name || nodeName,
          actor: this.currentUser,
        });
      } catch {
        /* ignore */
      }
    }
    if (session) session.kubeletRestarted = true;
    return { ok: true };
  },

  /** Helm repo/release bookkeeping for the simulated Helm client. */
  _helmState() {
    if (!this._helmRepoState) {
      this._helmRepoState = new Map();
      this._helmReleasesMeta = new Map();
      this._helmReleaseHistory = new Map();
    }
    return this._helmRepoState;
  },

  /**
   * Simulated software-catalog entries for a Helm repository. Real repos differ;
   * the simulator serves the same common catalog from every added repo so
   * `helm search repo nginx` finds `bitnami/nginx` after `helm repo add bitnami …`.
   * @param {string} repo
   * @returns {Array<{repo:string,name:string,versions:string[],version:string,appVersion:string,description:string,path:string}>}
   */
  _helmChartCatalog(repo) {
    const catalog = [
      {
        name: 'nginx',
        versions: ['15.1.0', '15.0.0'],
        appVersion: '1.25.3',
        description:
          'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache',
      },
      {
        name: 'webapp',
        versions: ['0.1.0'],
        appVersion: '1.0.0',
        description:
          'A Helm chart for OpenShift Games sample web applications (bundled simulator chart)',
      },
      {
        name: 'postgresql',
        versions: ['12.1.0', '12.0.0'],
        appVersion: '15.4.0',
        description: 'PostgreSQL (Postgres) is an open source object-relational database',
      },
      {
        name: 'redis',
        versions: ['17.0.0', '16.0.0'],
        appVersion: '7.0.5',
        description: 'Redis(R) is an open source, advanced key-value store',
      },
    ];
    return catalog.map((chart) => ({
      ...chart,
      repo,
      version: chart.versions[0],
      path: 'helm/webapp',
    }));
  },

  _helmAvailableChart(repo, chartName) {
    if (!repo) return null;
    const match = this._helmChartCatalog(repo).find((chart) => chart.name === chartName);
    if (match) return match;
    // Unknown chart names stay installable (the simulator renders the bundled
    // chart) but are absent from `helm search`, matching a repo index.
    return {
      repo,
      name: chartName,
      versions: ['0.1.0'],
      version: '0.1.0',
      appVersion: '1.0.0',
      description: `A Helm chart for ${chartName} (bundled simulator chart)`,
      path: 'helm/webapp',
    };
  },

  _helmReleaseList(namespace) {
    const result = this._helmCall('listHelm', [{ namespace }]);
    if (result.error) return { error: result };
    const payload = result.result;
    const releases = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.releases)
        ? payload.releases
        : [];
    return { releases };
  },

  /** Stored (non-seeded) release history, or null when none recorded yet. */
  _helmStoredHistory(release) {
    this._helmState();
    const stored = this._helmReleaseHistory.get(release);
    return Array.isArray(stored) ? stored : null;
  },

  /** Append a history entry, replacing any entry with the same revision. */
  _helmPushHistory(release, entry) {
    this._helmState();
    const history = this._helmStoredHistory(release) || [];
    const next = history.filter((existing) => Number(existing.revision) !== Number(entry.revision));
    next.push(entry);
    next.sort((left, right) => Number(left.revision) - Number(right.revision));
    this._helmReleaseHistory.set(release, next);
    return next;
  },

  _helmHistoryFor(release, record) {
    this._helmState();
    const stored = this._helmStoredHistory(release);
    if (stored) return stored;
    const meta = this._helmReleasesMeta.get(release) || {};
    const history = [
      {
        revision: Number(record?.revision || 1),
        updatedAt: record?.updatedAt || Date.now(),
        status: record?.status || 'deployed',
        chart: meta.chart || record?.chart || 'webapp',
        chartVersion: meta.chartVersion || record?.chartVersion || '0.1.0',
        appVersion: meta.appVersion || record?.appVersion || '1.0.0',
        description: 'Install complete',
      },
    ];
    this._helmReleaseHistory.set(release, history);
    return history;
  },

  _helmRepoCommand(positionals, flags) {
    const sub = (positionals[0] || '').toLowerCase();
    const rest = positionals.slice(1);
    const repos = this._helmState();
    switch (sub) {
      case 'add': {
        const name = rest[0];
        const url = rest[1];
        if (!name || !url) {
          return this._err(
            'Error: "helm repo add" requires 2 arguments\n\nUsage:  helm repo add [NAME] [URL] [flags]'
          );
        }
        if (repos.has(name))
          return this._err(
            `Error: repository name (${name}) already exists, please specify a different name`
          );
        repos.set(name, url);
        return this._ok(`"${name}" has been added to your repositories`);
      }
      case 'list':
      case 'ls': {
        if (!repos.size) return this._err('Error: no repositories to show');
        return this._ok(padTable(['NAME', 'URL'], [...repos.entries()]));
      }
      case 'remove':
      case 'rm': {
        const name = rest[0];
        if (!name)
          return this._err(
            'Error: "helm repo remove" requires 1 argument\n\nUsage:  helm repo remove [NAME]'
          );
        if (!repos.has(name)) return this._err(`Error: no repo named "${name}" found`);
        repos.delete(name);
        return this._ok(`"${name}" has been removed from your repositories`);
      }
      case 'update': {
        if (!repos.size) return this._err('Error: no repositories configured');
        const lines = ['Hang tight while we grab the latest from your chart repositories...'];
        for (const name of repos.keys())
          lines.push(`...Successfully got an update from the "${name}" chart repository`);
        lines.push('Update Complete. ⎈Happy Helming!⎈');
        return this._ok(lines.join('\n'));
      }
      case 'index': {
        if (!repos.size) return this._err('Error: no repositories configured');
        return this._ok('Adding repo index for local simulator charts... done');
      }
      default:
        return this._err(
          `Error: unknown command "${sub || ''}" for "helm repo"\n\nAvailable Commands:\n  add, list, remove, update\n\nRun 'helm repo --help' for usage.`
        );
    }
  },

  _cmdHelm(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const { positionals, flags } = parseArgs(tokens.slice(1), {
      shortValues: { '-n': 'namespace', '-f': 'values', '-o': 'output' },
      longValues: [
        'namespace',
        'values',
        'values-file',
        'set',
        'version',
        'repo',
        'output',
        'history-max',
        'timeout',
        'max',
      ],
      multi: ['set'],
      longBools: [
        'dry-run',
        'wait',
        'atomic',
        'generate-name',
        'install',
        'devel',
        'skip-crds',
        'versions',
      ],
    });
    const namespace = this._namespaceFromFlags(flags);
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    const repos = this._helmState();
    switch (sub) {
      case 'repo':
        return this._helmRepoCommand(positionals, flags);
      case 'search': {
        const searchArgs = positionals[0] === 'repo' ? positionals.slice(1) : positionals;
        const keyword = String(searchArgs[0] || '').toLowerCase();
        const reposAvailable = [...repos.keys()];
        if (!reposAvailable.length) return this._err('Error: no repositories configured');
        if (keyword === 'hub' || keyword === 'artifacts') return this._ok('No results found');
        let repoFilter = null;
        let chartFilter = keyword;
        if (keyword.includes('/')) {
          repoFilter = keyword.slice(0, keyword.indexOf('/'));
          chartFilter = keyword.slice(keyword.indexOf('/') + 1);
        }
        const charts = [];
        for (const repo of reposAvailable) {
          if (repoFilter && repo.toLowerCase() !== repoFilter) continue;
          for (const chart of this._helmChartCatalog(repo)) {
            if (chartFilter && !chart.name.toLowerCase().includes(chartFilter)) continue;
            charts.push(chart);
          }
        }
        if (!charts.length) return this._ok('No results found');
        const showVersions = Boolean(flags.versions);
        const rows = [];
        for (const chart of charts) {
          const versions = showVersions ? chart.versions : [chart.version];
          for (const version of versions) {
            rows.push([
              `${chart.repo}/${chart.name}`,
              version,
              chart.appVersion,
              chart.description,
            ]);
          }
        }
        return this._ok(padTable(['NAME', 'CHART VERSION', 'APP VERSION', 'DESCRIPTION'], rows));
      }

      case 'list':
      case 'ls': {
        const { releases, error } = this._helmReleaseList(namespace);
        if (error) return error;
        const rows = releases.map((release) => {
          const name = release.name || release.release || '';
          const meta = this._helmReleasesMeta?.get(name) || {};
          const chartName = release.chart || meta.chart || release.chartName || '';
          const chartVersion = release.chartVersion || meta.chartVersion || '0.1.0';
          return [
            name,
            release.namespace || namespace,
            String(release.revision || 1),
            release.updatedAt ? formatAge(release.updatedAt) : release.updated || 'just now',
            release.status || 'deployed',
            chartName ? `${chartName}${chartVersion ? `-${chartVersion}` : ''}` : '',
            release.appVersion || release.app_version || meta.appVersion || '1.0.0',
          ];
        });
        return this._ok(
          padTable(
            ['NAME', 'NAMESPACE', 'REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION'],
            rows
          )
        );
      }
      case 'install':
      case 'upgrade': {
        const release = positionals[0];
        const chart = positionals[1];
        if (!release || !chart) {
          return this._usageError(
            'helm',
            `release name and chart are required\n\n  helm ${sub} <release> <chart> [-f values.yaml] [-n <project>]`
          );
        }
        let chartPath = chart;
        let chartRepo = null;
        let chartName = chart;
        let catalogEntry = null;
        const slash = chart.indexOf('/');
        if (slash > 0 && repos.has(chart.slice(0, slash))) {
          chartRepo = chart.slice(0, slash);
          chartName = chart.slice(slash + 1);
          catalogEntry = this._helmAvailableChart(chartRepo, chartName);
          chartPath = catalogEntry.path;
        } else if (
          slash > 0 &&
          !chart.startsWith('.') &&
          chart.split('/')[0] !== 'helm' &&
          chart.split('/')[0] !== 'kustomize'
        ) {
          return this._err(`Error: repo ${chart.split('/')[0]} not found`);
        }
        const requestedVersion =
          flags.version && flags.version !== true ? String(flags.version) : null;
        const valuesPath =
          flags.values && flags.values !== true
            ? String(flags.values)
            : flags['values-file'] && flags['values-file'] !== true
              ? String(flags['values-file'])
              : null;
        const method = sub === 'install' ? 'installHelm' : 'upgradeHelm';
        const dryRun =
          flags['dry-run'] === true ||
          ['client', 'server'].includes(String(flags['dry-run'] || ''));
        const setValues = parseCommaAssignments(this._arrayFlag(flags, 'set'));
        const warnings = [];
        if (flags.wait)
          warnings.push(
            'warning: --wait is accepted but not simulated (the simulator applies resources synchronously)'
          );
        if (flags.atomic) warnings.push('warning: --atomic is accepted but not simulated');
        // Pass the catalog chart identity through to the renderer so templates,
        // releases and history report the real chart name/version/appVersion
        // (`nginx-15.0.0`, `1.25.3`) instead of the bundled chart's (#24).
        const catalogChartVersion =
          requestedVersion || (catalogEntry ? catalogEntry.version : null);
        const renderOptions = {
          namespace,
          dryRun,
          setValues,
          ...(catalogChartVersion ? { chartVersion: catalogChartVersion } : {}),
          ...(catalogEntry?.name ? { chartName: catalogEntry.name } : {}),
          ...(catalogEntry?.appVersion ? { appVersion: catalogEntry.appVersion } : {}),
        };
        const result = this._helmCall(method, [release, chartPath, valuesPath, renderOptions]);
        if (result.error) return result;
        const record = result.result || {};
        if (record.success === false || record.ok === false) {
          return this._err(record.message || record.error || 'helm failed');
        }
        const resolvedChart = record.chart || catalogEntry?.name || chartName;
        const resolvedVersion =
          requestedVersion || record.chartVersion || catalogEntry?.version || '0.1.0';
        const resolvedAppVersion = record.appVersion || catalogEntry?.appVersion || '1.0.0';
        this._helmReleasesMeta.set(release, {
          chart: resolvedChart,
          chartVersion: resolvedVersion,
          appVersion: resolvedAppVersion,
        });
        const prior = this._helmStoredHistory(release) || [];
        const previousRevision = prior.reduce(
          (max, entry) => Math.max(max, Number(entry.revision) || 0),
          0
        );
        const revision = sub === 'install' ? 1 : previousRevision + 1;
        if (!dryRun) {
          // Helm 3 keeps exactly one deployed revision: the previous revision
          // becomes superseded once the new one is deployed.
          for (const entry of prior) entry.status = 'superseded';
          this._helmPushHistory(release, {
            revision,
            updatedAt: Date.now(),
            status: 'deployed',
            chart: resolvedChart,
            chartVersion: resolvedVersion,
            appVersion: resolvedAppVersion,
            chartPath,
            valuesPath,
            repo: chartRepo,
            values: record.values ? JSON.parse(JSON.stringify(record.values)) : null,
            description: sub === 'install' ? 'Install complete' : 'Upgrade complete',
          });
        }
        const status = dryRun
          ? sub === 'install'
            ? 'pending-install'
            : 'pending-upgrade'
          : record.status || 'deployed';
        return this._ok(
          [
            ...warnings,
            `NAME: ${release}`,
            `LAST DEPLOYED: ${formatHelmDate(new Date())}`,
            `NAMESPACE: ${record.namespace || namespace}`,
            `STATUS: ${status}`,
            `REVISION: ${revision}`,
            'TEST SUITE: None',
            ...(dryRun ? ['', '(dry run) rendered resources but did not install the release'] : []),
            ...(record.message && typeof record.message === 'string' ? [record.message] : []),
          ].join('\n')
        );
      }
      case 'uninstall':
      case 'delete': {
        const release = positionals[0];
        if (!release)
          return this._usageError('helm', 'release name is required\n\n  helm uninstall <release>');
        const result = this._helmCall('uninstallHelm', [release, { namespace }]);
        if (result.error) return result;
        if (result.result && (result.result.success === false || result.result.ok === false)) {
          return this._err(
            result.result.message || result.result.error || `release "${release}" not found`
          );
        }
        this._helmReleasesMeta?.delete(release);
        this._helmReleaseHistory?.delete(release);
        return this._ok(`release "${release}" uninstalled`);
      }
      case 'status': {
        const release = positionals[0];
        if (!release)
          return this._usageError('helm', 'release name is required\n\n  helm status <release>');
        const { releases, error } = this._helmReleaseList(namespace);
        if (error) return error;
        const found = releases.find((entry) => (entry.name || entry.release) === release);
        if (!found) return this._err(`Error: release: "${release}" not found`);
        return this._ok(
          [
            `NAME: ${release}`,
            `LAST DEPLOYED: ${found.updatedAt ? formatHelmDate(new Date(found.updatedAt)) : found.updated || 'just now'}`,
            `NAMESPACE: ${found.namespace || namespace}`,
            `STATUS: ${found.status || 'deployed'}`,
            `REVISION: ${found.revision || 1}`,
            'TEST SUITE: None',
          ].join('\n')
        );
      }
      case 'history': {
        const release = positionals[0];
        if (!release)
          return this._err(
            'Error: "helm history" requires 1 argument\n\nUsage:  helm history [RELEASE] [flags]'
          );
        const { releases, error } = this._helmReleaseList(namespace);
        if (error) return error;
        const found = releases.find((entry) => (entry.name || entry.release) === release);
        if (!found) return this._err(`Error: release: "${release}" not found`);
        const history = this._helmHistoryFor(release, found);
        const rows = history.map((entry) => [
          String(entry.revision),
          entry.updatedAt ? formatHelmDate(new Date(entry.updatedAt)) : 'just now',
          entry.status || 'deployed',
          `${entry.chart || 'webapp'}-${entry.chartVersion || '0.1.0'}`,
          entry.appVersion || '1.0.0',
          entry.description || '',
        ]);
        return this._ok(
          padTable(['REVISION', 'UPDATED', 'STATUS', 'CHART', 'APP VERSION', 'DESCRIPTION'], rows)
        );
      }
      case 'rollback': {
        const release = positionals[0];
        if (!release)
          return this._err(
            'Error: "helm rollback" requires at least 1 argument\n\nUsage:  helm rollback <RELEASE> [REVISION] [flags]'
          );
        const { releases, error } = this._helmReleaseList(namespace);
        if (error) return error;
        const found = releases.find((entry) => (entry.name || entry.release) === release);
        if (!found) return this._err(`Error: release: "${release}" not found`);
        const history = this._helmHistoryFor(release, found);
        const requested =
          flags.revision && flags.revision !== true
            ? Number(flags.revision)
            : positionals[1]
              ? Number(positionals[1])
              : 0;
        const targetRevision = requested || history[history.length - 1]?.revision || 1;
        const targetEntry = history.find(
          (entry) => Number(entry.revision) === Number(targetRevision)
        );
        if (!targetEntry)
          return this._err(`Error: release "${release}" has no revision ${targetRevision}`);
        // A rollback re-deploys revision N's chart AND its values (that is the
        // whole point of the exercise): pass the stored chart path/version/
        // appVersion/values back through the renderer (#24).
        const rollbackValues = targetEntry.values
          ? JSON.parse(JSON.stringify(targetEntry.values))
          : null;
        const rollbackOptions = {
          namespace,
          ...(targetEntry.chartVersion ? { chartVersion: targetEntry.chartVersion } : {}),
          ...(targetEntry.chart ? { chartName: targetEntry.chart } : {}),
          ...(targetEntry.appVersion ? { appVersion: targetEntry.appVersion } : {}),
          ...(rollbackValues ? { values: rollbackValues } : {}),
        };
        const result = this._helmCall('upgradeHelm', [
          release,
          targetEntry.chartPath || 'helm/webapp',
          targetEntry.valuesPath || null,
          rollbackOptions,
        ]);
        if (result.error) return result;
        const record = result.result || {};
        if (record.success === false || record.ok === false) {
          return this._err(record.message || record.error || 'helm rollback failed');
        }
        for (const entry of history) entry.status = 'superseded';
        const revision =
          history.reduce((max, entry) => Math.max(max, Number(entry.revision) || 0), 0) + 1;
        this._helmReleasesMeta.set(release, {
          chart: targetEntry.chart,
          chartVersion: targetEntry.chartVersion,
          appVersion: targetEntry.appVersion,
        });
        this._helmPushHistory(release, {
          revision,
          updatedAt: Date.now(),
          status: 'deployed',
          chart: targetEntry.chart || 'webapp',
          chartVersion: targetEntry.chartVersion || '0.1.0',
          appVersion: targetEntry.appVersion || '1.0.0',
          chartPath: targetEntry.chartPath || 'helm/webapp',
          valuesPath: targetEntry.valuesPath || null,
          repo: targetEntry.repo || null,
          values: rollbackValues,
          description: `Rollback to ${targetRevision}`,
        });
        return this._ok('Rollback was a success! Happy Helming!');
      }
      default:
        return this._err(
          `Error: unknown command "${sub || ''}" for "helm"\n\nAvailable Commands:\n  install, upgrade, list, uninstall, status, history, rollback, repo, search\n\nRun 'helm --help' for usage.`
        );
    }
  },

  /**
   * `htpasswd` with the real Apache htpasswd output/semantics (issue #26):
   *  - `Adding password for user u1` for a new entry,
   *  - `Updating password for user u1` when the user already exists,
   *  - `Deleting password for user u1` / `User u1 not found` for -D,
   *  - `-c` truncates the target file and creates it when missing,
   *  - without `-c` a missing file is an error (`use '-c' to create it`).
   */
  _cmdHtpasswd(tokens) {
    let create = false;
    let batch = false;
    let remove = false;
    let bcrypt = false;
    const positionals = [];
    for (const token of tokens) {
      if (/^-[A-Za-z]+$/.test(token)) {
        for (const char of token.slice(1)) {
          if (char === 'c') create = true;
          else if (char === 'b') batch = true;
          else if (char === 'D') remove = true;
          else if (char === 'B') bcrypt = true; // real htpasswd -B writes a $2y$ bcrypt hash
          // -n (stdout), -v (verify) are accepted and ignored
        }
        continue;
      }
      positionals.push(token);
    }
    void batch;
    const file = positionals[0] || 'htpasswd';
    const user = positionals[1];
    const password = positionals[2];
    if (!user) {
      return this._err(
        'error: user is required\n\n  htpasswd [-c] [-b] [-B] <file> <user> [password]\n  htpasswd -D <file> <user>'
      );
    }
    const me = this.manifestEngine;
    if (!me) return this._manifestNotReady();
    const listedUsers = () => {
      try {
        return typeof me.htpasswdList === 'function' ? me.htpasswdList(file) || [] : [];
      } catch {
        return [];
      }
    };
    if (remove) {
      if (!listedUsers().includes(user)) return this._ok(`User ${user} not found`);
      const result = this._htpasswdCall('remove', user, undefined, file);
      if (result.error) return result;
      return this._ok(`Deleting password for user ${user}`);
    }
    if (!password) {
      return this._err(
        'error: password is required when using -b\n\n  htpasswd -c -b [-B] <file> <user> <password>'
      );
    }
    const fileExists = this._readVirtualFile(file) !== null;
    if (!fileExists && !create) {
      return this._err(`htpasswd: cannot modify file ${file}; use '-c' to create it`);
    }
    const existingUsers = listedUsers();
    if (!create && existingUsers.includes(user) && typeof me.htpasswdUpdate === 'function') {
      const result = this._htpasswdCall('update', user, password, file, { bcrypt });
      if (result.error) return result;
      return this._ok(`Updating password for user ${user}`);
    }
    if (create) {
      // `htpasswd -c <file>` truncates ONLY the target file (never the cluster's
      // root htpasswd file when a custom path like /tmp/users.htpasswd is used).
      const truncated = this._writeVirtualFile(file, '');
      if (truncated.error) return truncated;
    }
    const result = this._htpasswdCall('add', user, password, file, { bcrypt });
    if (result.error) return result;
    return this._ok(`Adding password for user ${user}`);
  },

  _cmdHelp(tokens) {
    const topic = tokens
      .map((token) => token.toLowerCase())
      .filter((token) => token && !token.startsWith('-'));
    const docs = `Documentation: ${OC_DOCS_URL}`;
    if (topic.length === 0) {
      const groups = [
        [
          'Basic Commands',
          ['login', 'logout', 'whoami', 'project', 'projects', 'new-project', 'status'],
        ],
        [
          'Querying Resources',
          ['get', 'describe', 'logs', 'events', 'explain', 'api-resources', 'extract'],
        ],
        [
          'Declarative Management',
          ['apply', 'create', 'replace', 'delete', 'edit', 'patch', 'label', 'annotate'],
        ],
        [
          'Deploy & Expose',
          [
            'new-app',
            'new-build',
            'start-build',
            'cancel-build',
            'expose',
            'process',
            'rollout',
            'scale',
            'set',
            'run',
            'exec',
            'tag',
            'import-image',
          ],
        ],
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
      lines.push(
        'The "oc " prefix is optional in this terminal; commands can be typed with or without it.'
      );
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
        ].join('\n')
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
        ].join('\n')
      );
    }
    const entry = BASE_COMMANDS[topic[0]];
    if (!entry) {
      return this._err(
        `error: unknown command "${topic[0]}" for "oc"\n\nRun 'oc --help' for usage.`
      );
    }
    const flags = COMMAND_FLAGS[topic[0]] || [];
    return this._ok(
      [
        entry.summary,
        '',
        'Usage:',
        `  ${entry.usage}`,
        '',
        ...(flags.length ? ['Flags:', `  ${flags.join(', ')}`, ''] : []),
        'The "oc " prefix is optional in this terminal; commands can be typed with or without it.',
        docs,
      ].join('\n')
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
      if (spec.stringData && Object.keys(spec.stringData).length)
        out.stringData = { ...spec.stringData };
      if (spec.immutable !== undefined) out.immutable = spec.immutable;
      return out;
    }
    if (kind === 'ConfigMap') {
      const out = { apiVersion: 'v1', kind: 'ConfigMap', metadata };
      if (object?.metadata?.namespace) out.metadata.namespace = object.metadata.namespace;
      if (spec.data && Object.keys(spec.data).length) out.data = { ...spec.data };
      if (spec.binaryData && Object.keys(spec.binaryData).length)
        out.binaryData = { ...spec.binaryData };
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
        `name is required\n\n  oc create ${kindLabel} <name> --verb=<verb> --resource=<resource>[.<group>][/<subresource>] [--resource-name=<name>]`
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
    const resourceNames = this._arrayFlag(flags, 'resource-name')
      .map((entry) => String(entry).trim())
      .filter(Boolean);
    if (!verbs.length) return this._err('error: at least one verb must be specified');
    if (!resources.length) return this._err('error: at least one resource must be specified');
    const defaultGroup =
      flags['api-group'] && flags['api-group'] !== true ? String(flags['api-group']) : '';
    /** @type {Map<string, {group: string, resources: string[]}>} */
    const byGroup = new Map();
    for (const token of resources) {
      const parsed = this._parseRbacResourceToken(token, defaultGroup);
      if (!byGroup.has(parsed.group))
        byGroup.set(parsed.group, { group: parsed.group, resources: [] });
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
      return this._err(
        'error: you must specify at least one resource to extract\n\n  oc extract secret/<name> | configmap/<name> [--to=<dir>|-] [--keys=k1,k2] [--confirm]'
      );
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
    if (!name)
      return this._usageError(
        'extract',
        'a resource name is required\n\n  oc extract secret/<name>'
      );
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
    const onlyKeys =
      flags.keys && flags.keys !== true
        ? String(flags.keys)
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean)
        : [];
    const keys = Object.keys(allData).filter(
      (key) => onlyKeys.length === 0 || onlyKeys.includes(key)
    );
    const decoded = (key) =>
      isSecret ? this._decodeBase64(allData[key]) : String(allData[key] ?? '');
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
      return (
        this._resources('OAuth').find((resource) => resource.metadata?.name === 'cluster') || null
      );
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
      (provider) => provider.type === 'HTPasswd' && provider.htpasswd?.fileData?.name === name
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
      return this._err(
        `error: the object is not a config map or secret and cannot have data updated: ${kind}`
      );
    }
    if (!name) {
      return this._usageError(
        'set',
        'resource name is required\n\n  oc set data secret/<name> KEY=VALUE  |  KEY-  |  --from-file=KEY=PATH'
      );
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
      allowOtherNamespaces: false,
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
      if (eq <= 0)
        return this._err(`error: invalid data update "${token}" (expected KEY=VALUE or KEY-)`);
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
    const syncHtpasswd =
      isSecret && next.htpasswd !== undefined && this._isOAuthHtpasswdSecret(resource);
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
      { namespace: flags.namespace, explicitNamespace: Boolean(flags.namespace) }
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
      parameters: [
        'PROJECT_NAME',
        'PROJECT_DISPLAYNAME',
        'PROJECT_DESCRIPTION',
        'PROJECT_ADMIN_USER',
        'PROJECT_REQUESTING_USER',
      ].map(param),
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
          subjects: [
            { apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: '${PROJECT_ADMIN_USER}' },
          ],
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
    return [
      'project.config.openshift.io',
      'projects.config.openshift.io',
      'project.config',
      'projects.config',
    ].includes(String(token || '').toLowerCase());
  },

  _projectConfigRef(positionals) {
    const first = String(positionals[0] || '');
    const slash = first.indexOf('/');
    const base = (slash >= 0 ? first.slice(0, slash) : first).toLowerCase();
    if (!this._isProjectConfigToken(base)) return null;
    const name =
      slash >= 0 ? first.slice(slash + 1) : positionals[1] ? String(positionals[1]) : 'cluster';
    return { name: name || 'cluster' };
  },

  _projectConfigObject() {
    let raw = null;
    try {
      if (this.gameEngine && typeof this.gameEngine.getProjectConfig === 'function')
        raw = this.gameEngine.getProjectConfig();
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
        object.spec =
          raw.spec && typeof raw.spec === 'object' ? JSON.parse(JSON.stringify(raw.spec)) : {};
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
      return this._err(
        `Error from server (NotFound): projects.config.openshift.io "${requested}" not found`
      );
    }
    const object = this._projectConfigObject();
    if (output.format === 'json') return this._ok(JSON.stringify(object, null, 4));
    if (output.format === 'yaml') return this._ok(toYamlDocument(object));
    if (output.format === 'name') return this._ok('project.config.openshift.io/cluster');
    if (output.format === 'jsonpath') {
      if (!output.arg)
        return this._err(
          "error: jsonpath requires a template, e.g. -o jsonpath='{.spec.projectRequestTemplate.name}'"
        );
      return this._ok(evaluateJsonPath(object, output.arg));
    }
    if (output.format === 'custom-columns') {
      const columns = String(output.arg || '')
        .split(',')
        .map((entry) => {
          const colon = entry.indexOf(':');
          return colon < 0 ? null : { header: entry.slice(0, colon), path: entry.slice(colon + 1) };
        })
        .filter(Boolean);
      if (!columns.length) return this._err('error: invalid custom-columns specification');
      return this._ok(
        padTable(
          columns.map((column) => column.header),
          [
            columns.map((column) =>
              String(evaluateJsonPath(object, `{${column.path.trim()}}`) || '<none>')
            ),
          ]
        )
      );
    }
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
      ].join('\n')
    );
  },

  /** Deep-merge a patch object into a target (used by project config patches). */
  _mergeSpecValue(target, patch) {
    const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value))
        out[key] = this._mergeSpecValue(out[key], value);
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
      const segments = String(operation?.path || '')
        .split('/')
        .filter(Boolean)
        .map(unescape);
      if (!segments.length) return { error: 'error: json patch path must not be empty' };
      let parent = clone;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (parent[segment] === undefined || parent[segment] === null)
          parent[segment] = /^\d+$/.test(segments[i + 1]) ? [] : {};
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
        if (result && result.success === false)
          return this._err(result.message || 'error: project config patch failed');
      } else {
        const current = this._projectConfigObject();
        this.cluster.projectConfig = {
          ...current,
          spec: this._mergeSpecValue(current.spec, specPatch),
        };
      }
    }
    return this._ok('project.config.openshift.io/cluster patched');
  },

  _editProjectConfig() {
    const object = this._projectConfigObject();
    this._emit('ui:manifest-editor', {
      kind: 'Project',
      name: 'cluster',
      namespace: '',
      resource: object,
    });
    const panel = this.game?.manifestPanel;
    if (panel && typeof panel.show === 'function') {
      try {
        panel.show(object);
        return this._ok(
          `Opening the manifest editor for project.config.openshift.io/cluster in the Files panel. Save to apply changes.\n${EDIT_TEACHING_LINE}`
        );
      } catch {
        /* fall through to YAML output */
      }
    }
    this._emit('ui:edit-resource', {
      kind: 'Project',
      name: 'cluster',
      namespace: '',
      resource: object,
    });
    return this._ok(
      `${toYamlDocument(object)}\n${EDIT_TEACHING_LINE}\n(No manifest editor is available — edit this object and apply it with oc apply -f -.)`
    );
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Issue #11 follow-up commands: policy / image / rsh / cp / wait / diff /
// autoscale / helm repo-history-rollback, and `oc create token`.
// ────────────────────────────────────────────────────────────────────────────

Object.assign(CommandBar.prototype, {
  /** `oc policy …` is the top-level alias of `oc adm policy …` (OCP 4.22). */
  _cmdPolicy(tokens) {
    return this._admPolicy(tokens);
  },

  // ── oc image info ────────────────────────────────────────────────────────

  /** Deterministic fake sha256 digest for simulated images. */
  _imageDigest(seed) {
    const cluster = this.cluster;
    if (cluster && typeof cluster._fakeDigest === 'function') {
      try {
        return `sha256:${cluster._fakeDigest(String(seed))}`;
      } catch {
        /* fall through */
      }
    }
    let out = '';
    let counter = 0;
    while (out.length < 64) {
      out += stableHash(`${seed}:${counter++}`, 0xffffffff).toString(16).padStart(8, '0');
    }
    return `sha256:${out.slice(0, 64)}`;
  },

  /** Resolve image metadata (ImageStream-aware) for `oc image info` / describe istag. */
  _imageInfoFor(reference, namespace = this.currentProject) {
    const raw = String(reference || '').trim();
    let name = raw;
    let digest = null;
    let pullSpec = raw;
    let created = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const isToken = raw.replace(/^imagestreamtag\//, '').replace(/^istag\//, '');
    const parts = isToken.split(':');
    const repoToken = parts[0].replace(/^imagestream\//, '').replace(/^is\//, '');
    if (
      !raw.includes('/') ||
      raw.startsWith('istag/') ||
      raw.startsWith('imagestreamtag/') ||
      raw.startsWith('is/')
    ) {
      const repoAndTag = repoToken.includes('@') ? repoToken.split('@')[0] : repoToken;
      const tag =
        parts.length > 1 ? parts[1] : repoToken.includes('@') ? repoToken.split('@')[1] : 'latest';
      const cluster = this.cluster;
      let resolved = null;
      if (cluster && typeof cluster.resolveImageStreamTag === 'function') {
        try {
          resolved = cluster.resolveImageStreamTag(namespace, repoAndTag, tag);
        } catch {
          resolved = null;
        }
      }
      if (resolved && resolved.found) {
        name = `${resolved.imageStream.metadata?.name}:${resolved.tag}`;
        const item = resolved.tagEntry?.items?.[0] || {};
        digest =
          item.image && /^sha256:/.test(String(item.image))
            ? String(item.image)
            : this._imageDigest(
                resolved.dockerImageReference ||
                  `${INTERNAL_REGISTRY}/${namespace}/${repoAndTag}:${tag}`
              );
        // An ImageStreamTag points at the internal registry copy of the image:
        // `image-registry.openshift-image-registry.svc:5000/<ns>/<is>@sha256:…`.
        const streamName = resolved.imageStream.metadata?.name || repoAndTag;
        pullSpec = `${INTERNAL_REGISTRY}/${resolved.imageStream.metadata?.namespace || namespace}/${streamName}@${digest}`;
        created = item.created || created;
      } else {
        name = `${repoAndTag}:${tag}`;
        pullSpec = `${INTERNAL_REGISTRY}/${namespace}/${repoAndTag}:${tag}`;
        digest = this._imageDigest(pullSpec);
      }
    } else if (raw.includes('@sha256:')) {
      digest = `sha256:${raw.split('@sha256:')[1]}`;
      name = raw;
    } else {
      digest = this._imageDigest(raw);
      name = raw;
    }
    const imageName = name;
    // The container Command is image-specific: S2I language images run
    // /usr/libexec/s2i/run, only the Apache/nginx images run httpd directly.
    const imageToken = `${repoToken} ${name} ${pullSpec}`.toLowerCase();
    const isHttpd = /nginx|httpd|apache/.test(imageToken);
    return {
      name: imageName,
      reference: raw,
      dockerImage: pullSpec,
      digest,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      created,
      size: 132 * 1024 * 1024,
      layers: 5,
      os: 'linux',
      arch: 'amd64',
      entrypoint: isHttpd ? '/usr/bin/run-httpd' : '/usr/libexec/s2i/entrypoint',
      command: isHttpd ? '/usr/bin/run-httpd' : '/usr/libexec/s2i/run',
      workingDir: '/opt/app-root/src',
      user: '1001',
      env: [
        'PATH=/opt/app-root/src/bin:/opt/app-root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
      labels: {},
    };
  },

  _describeImageInfo(info) {
    const lines = [
      `Name:		${info.dockerImage}`,
      `Digest:		${info.digest}`,
      `Media Type:	${info.mediaType}`,
      `Created:	${formatAge(info.created)} ago`,
      `Image Size:	132.4MB in ${info.layers} layers`,
      `OS:		${info.os}`,
      `Arch:		${info.arch}`,
      `Command:	${info.command}`,
      `Working Dir:	${info.workingDir}`,
      `User:		${info.user}`,
      `Environment:	${info.env[0]}`,
    ];
    return lines.join('\n');
  },

  _cmdImage(tokens) {
    const sub = (tokens[0] || '').toLowerCase();
    const { positionals, flags } = parseArgs(tokens.slice(1), {
      shortValues: { '-o': 'output' },
      longValues: ['output', 'filter-by-os', 'dir', 'registry-config'],
      longBools: ['insecure', 'all'],
    });
    if (sub !== 'info') {
      return this._err(
        `error: unknown image subcommand "${sub || ''}"\n\nAvailable subcommands:\n  info     Display information about an image\n\nRun 'oc image --help' for details.`
      );
    }
    if (!positionals.length)
      return this._err('error: info expects at least one argument, an image pull spec');
    const output = this._outputFormat(flags);
    const infos = positionals.map((reference) =>
      this._imageInfoFor(reference, this.currentNamespaceForImage())
    );
    if (String(flags.output || '') === 'json')
      return this._ok(JSON.stringify(infos.length === 1 ? infos[0] : infos, null, 2));
    if (output.format === 'json')
      return this._ok(JSON.stringify(infos.length === 1 ? infos[0] : infos, null, 2));
    return this._ok(infos.map((info) => this._describeImageInfo(info)).join('\n'));
  },

  currentNamespaceForImage() {
    return this.currentProject || 'default';
  },

  // ── oc create token <serviceaccount> ────────────────────────────────────

  _base64Url(text) {
    const value = String(text ?? '');
    let base64 = '';
    try {
      if (typeof btoa === 'function') base64 = btoa(unescape(encodeURIComponent(value)));
      else if (typeof Buffer !== 'undefined')
        base64 = Buffer.from(value, 'utf8').toString('base64');
    } catch {
      base64 = value;
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  _cmdCreateToken(rest, flags) {
    const serviceAccount = rest[0];
    if (!serviceAccount)
      return this._err(
        'error: exactly one name is required\n\n  oc create token <serviceaccount> [--duration=1h]'
      );
    const namespace = this._namespaceFromFlags(flags);
    const sa = this._findResource('ServiceAccount', serviceAccount, {
      namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
      allowOtherNamespaces: false,
    });
    if (!sa)
      return this._err(
        `Error from server (NotFound): serviceaccounts "${serviceAccount}" not found`
      );
    const durationText = flags.duration && flags.duration !== true ? String(flags.duration) : '1h';
    const match = durationText.match(/^(\d+)([smh])$/);
    const seconds = match
      ? Number(match[1]) * (match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1)
      : 3600;
    const now = Math.floor(Date.now() / 1000);
    const audience =
      flags.audience && flags.audience !== true
        ? String(flags.audience).split(',')
        : ['https://kubernetes.default.svc'];
    const header = this._base64Url(JSON.stringify({ alg: 'RS256', kid: '' }));
    const payload = this._base64Url(
      JSON.stringify({
        aud: audience,
        exp: now + seconds,
        iat: now,
        iss: 'https://kubernetes.default.svc',
        jti: `${this._imageDigest(`${serviceAccount}-${now}`).slice(7, 39)}`,
        kubernetes: {
          namespace,
          serviceaccount: { name: serviceAccount, uid: sa.metadata?.uid || sa.uid || '' },
        },
        nbf: now,
        sub: `system:serviceaccount:${namespace}:${serviceAccount}`,
      })
    );
    const signature = this._base64Url(this._imageDigest(`sig-${serviceAccount}-${now}`).slice(7));
    return this._ok(`${header}.${payload}.${signature}`);
  },

  // ── pod resolution shared by exec / rsh / logs / cp ─────────────────────

  /** Ready Pod for a TYPE/NAME reference (picks a real pod like oc does). */
  _podForResource(kind, name, namespace, explicitNamespace) {
    if (!kind || !name) return null;
    if (kind === 'Pod') {
      return this._findResource('Pod', name, { namespace, explicitNamespace, allowPrefix: false });
    }
    const workload = this._findResource(kind, name, {
      namespace,
      explicitNamespace,
      allowPrefix: false,
    });
    if (!workload) return null;
    const pods = this._getKindList('Pod').filter((pod) => {
      if (pod.metadata?.namespace !== workload.metadata?.namespace) return false;
      const owners = pod.metadata?.ownerReferences || [];
      if (owners.length) {
        const chainMatch = owners.some(
          (owner) =>
            owner.name === workload.metadata?.name ||
            owner.uid === (workload.uid || workload.metadata?.uid)
        );
        if (chainMatch) return true;
      }
      const selector =
        workload.spec?.selector?.matchLabels || workload.spec?.template?.metadata?.labels || {};
      return Object.entries(selector).every(
        ([key, value]) => (pod.metadata?.labels || {})[key] === value
      );
    });
    if (!pods.length) return null;
    const running = pods.filter((pod) =>
      ['Running', 'Pending'].includes(pod.status?.phase || pod.phase || 'Running')
    );
    const pool = running.length ? running : pods;
    return pool
      .slice()
      .sort((left, right) =>
        String(left.metadata?.creationTimestamp || '').localeCompare(
          String(right.metadata?.creationTimestamp || '')
        )
      )[0];
  },

  // ── oc rsh ──────────────────────────────────────────────────────────────

  _cmdRsh(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container', 'shell'],
      longBools: ['tty', 'no-tty'],
    });
    if (!positionals.length) {
      return this._err(
        "error: expected 'oc rsh [-c CONTAINER] [flags] (POD | TYPE/NAME) COMMAND [args...]'.\nPOD or TYPE/NAME is a required argument for the rsh command"
      );
    }
    const namespace = this._namespaceFromFlags(flags);
    const explicitNamespace = Boolean(flags.namespace);
    if (this._isNamespaced('Pod')) {
      const namespaceError = this._requireNamespace(namespace);
      if (namespaceError) return namespaceError;
    }
    let { kind, name } = this._resolveRef(positionals);
    let consumed = 2;
    if (!kind) {
      // Real `oc rsh <pod>` treats a bare name as a Pod (same as `oc exec`).
      const barePod = this._findResource('Pod', positionals[0], {
        namespace,
        explicitNamespace,
        allowPrefix: false,
      });
      if (!barePod) return this._resourceTypeError(positionals[0]);
      kind = 'Pod';
      name = positionals[0];
      consumed = 1;
    } else if (String(positionals[0] || '').includes('/')) {
      // `oc rsh deployment/app env`: TYPE/NAME is a single positional token.
      consumed = 1;
    }
    if (!name)
      return this._usageError('rsh', 'resource name is required\n\n  oc rsh deployment/<name>');
    const pod = this._podForResource(kind, name, namespace, explicitNamespace);
    if (!pod) return this._err(`error: pods "${kind === 'Pod' ? name : `${name}-`}" not found`);
    const containers = this._containerList(pod);
    const containerName =
      flags.container && flags.container !== true
        ? String(flags.container)
        : containers[0]?.name || 'main';
    if (containers.length && !containers.some((container) => container.name === containerName)) {
      return this._err(
        `Error from server (BadRequest): container "${containerName}" is not valid for pod "${pod.metadata?.name}"`
      );
    }
    // A CrashLoopBackOff / ImagePullBackOff / completed container cannot be
    // exec'd into; real oc fails the attach instead of pretending to run (#35).
    const containerStateError = this._execContainerStateError(pod, containerName);
    if (containerStateError) return this._err(containerStateError);
    const command = positionals.slice(consumed).join(' ').trim();
    // Real oc only defaults (and announces) a container for multi-container pods.
    const containerSpecified = Boolean(flags.container && flags.container !== true);
    const lines =
      containers.length > 1 && !containerSpecified
        ? [
            `Defaulting container name to "${containerName}".`,
            `Use 'oc describe pod/${pod.metadata?.name} -n ${pod.metadata?.namespace}' to see all of the containers in this pod.`,
          ]
        : [];
    if (command) {
      const output = this._simulateExecCommand(command, pod, containerName);
      return this._ok([...lines, ...output].join('\n'));
    }
    return this._ok(
      [
        ...lines,
        '',
        `(pod/${pod.metadata?.name}) $`,
        '(interactive shell is simulated — run `oc exec ' +
          `${kind === 'Pod' ? pod.metadata?.name : `${this._resourceRef(kind)}/${name}`}` +
          ' -- <command>` to execute commands)',
      ].join('\n')
    );
  },

  // ── oc cp ───────────────────────────────────────────────────────────────

  _parseCpSpec(arg) {
    const text = String(arg || '');
    const colon = text.indexOf(':');
    if (colon <= 0) return { local: text };
    const left = text.slice(0, colon);
    const path = text.slice(colon + 1);
    const slash = left.indexOf('/');
    const namespace = slash >= 0 ? left.slice(0, slash) : null;
    const podRef = slash >= 0 ? left.slice(slash + 1) : left;
    return { podRef, podNamespace: namespace, path };
  },

  _cmdCp(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-c': 'container' },
      longValues: ['namespace', 'container', 'retries'],
      longBools: ['no-preserve'],
    });
    if (positionals.length !== 2) {
      return this._err(
        'error: expected `oc cp <source> <destination>`\n\n  oc cp /tmp/app.yaml pod/name:/tmp/app.yaml\n  oc cp pod/name:/etc/os-release ./os-release'
      );
    }
    const [sourceArg, destArg] = positionals;
    const source = this._parseCpSpec(sourceArg);
    const dest = this._parseCpSpec(destArg);
    if (Boolean(source.podRef) === Boolean(dest.podRef)) {
      return this._err('error: one of source or destination must be a pod (use <pod>:<path>)');
    }
    const podSpec = source.podRef ? source : dest;
    const namespace = podSpec.podNamespace || flags.namespace || this.currentProject;
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const pod = this._findResource('Pod', podSpec.podRef, {
      namespace,
      explicitNamespace: true,
      allowPrefix: false,
    });
    if (!pod) return this._err(this._notFoundMessage('Pod', podSpec.podRef));
    this._cpFiles = this._cpFiles || {};
    const podKey = `${namespace}/${podSpec.podRef}`;
    if (source.podRef) {
      // pod → local: materialise a virtual file with plausible content.
      const content = this._cpSimulatedFile(source.path, pod);
      const targetPath = dest.local.replace(/^\.\//, '');
      const written = this._writeVirtualFile(targetPath, content);
      if (written.error) return written;
      return this._ok('');
    }
    // local → pod: read the virtual file (or directory) so the copy can be verified.
    let sourceText = this._readVirtualFile(source.local);
    if (sourceText === null) {
      const prefix = `${source.local.replace(/\/+$/, '')}/`;
      const files = this._manifestFileList().filter((file) => file.startsWith(prefix));
      if (files.length)
        sourceText = files
          .map((file) => `# ${file}\n${this._readVirtualFile(file) || ''}`)
          .join('\n');
    }
    if (sourceText === null)
      return this._err(`error: tar: ${source.local}: Cannot stat: No such file or directory`);
    this._cpFiles[podKey] = this._cpFiles[podKey] || {};
    this._cpFiles[podKey][dest.path] = sourceText;
    return this._ok('');
  },

  _cpSimulatedFile(path, pod) {
    const target = String(path || '').replace(/\/+$/, '');
    if (/etc\/os-release$/.test(target))
      return 'NAME="Red Hat Enterprise Linux"\nVERSION="9.4 (Plow)"\nID="rhel"\nID_LIKE="fedora"\n';
    if (/etc\/hostname$/.test(target)) return `${pod.metadata?.name || 'pod'}\n`;
    if (/etc\/hosts$/.test(target))
      return '127.0.0.1\tlocalhost\n172.30.0.1\tkubernetes.default.svc\n';
    return `simulated content of ${target} from pod/${pod.metadata?.name}\n`;
  },

  // ── oc wait ─────────────────────────────────────────────────────────────

  _evaluateWaitCondition(condition, resource) {
    const text = String(condition || '');
    if (!text) return false;
    if (text === 'delete') return false;
    const match = text.match(/^jsonpath=(.+?)(?:=(.*))?$/);
    if (match) {
      const evaluated = evaluateJsonPath(this._manifestFor(resource), match[1]);
      return match[2] === undefined ? Boolean(evaluated) : String(evaluated) === String(match[2]);
    }
    const conditionMatch = text.match(/^condition=([A-Za-z]+)(?:=([A-Za-z]+))?$/);
    if (conditionMatch) {
      const conditions = resource.status?.conditions || [];
      const found = conditions.find((entry) => entry.type === conditionMatch[1]);
      if (!found) return false;
      return found.status === (conditionMatch[2] || 'True');
    }
    return false;
  },

  _cmdWait(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace', '-l': 'selector' },
      longValues: ['namespace', 'selector', 'timeout'],
      longBools: ['all', 'local'],
    });
    const forFlag = flags.for !== undefined && flags.for !== true ? String(flags.for) : null;
    if (!forFlag) return this._err('error: required flag(s) "for" not set');
    const namespace = this._namespaceFromFlags(flags);
    const explicitNamespace = Boolean(flags.namespace);
    if (!positionals.length && !flags.all) {
      return this._err(
        'error: no resources to wait for specified\n\n  oc wait --for=condition=Ready pod/<name> --timeout=60s'
      );
    }
    const targets = [];
    if (flags.all) {
      const kindToken = positionals[0] || 'pods';
      const kind = resolveKindToken(kindToken);
      if (!kind) return this._resourceTypeError(kindToken);
      let resources = this._resources(kind);
      if (this._isNamespaced(kind) && !flags['all-namespaces'])
        resources = resources.filter((resource) => resource.metadata?.namespace === namespace);
      resources.forEach((resource) =>
        targets.push({ kind, name: resource.metadata?.name, resource })
      );
    } else {
      for (const token of positionals) {
        const { kind, name } = splitResourceRef(token.includes('/') ? [token] : [token]);
        if (!kind || !name)
          return this._err(`error: invalid resource reference "${token}" (use TYPE/NAME)`);
        const resource = this._findResource(kind, name, {
          namespace: flags.namespace,
          explicitNamespace,
          allowPrefix: false,
        });
        targets.push({ kind, name, resource });
      }
    }
    const okLines = [];
    for (const target of targets) {
      if (forFlag === 'delete') {
        if (!target.resource) {
          okLines.push(`${this._resourceRef(target.kind)}/${target.name} deleted`);
          continue;
        }
        return this._err(
          `error: timed out waiting for the condition on ${this._pluralRef(target.kind)}/${target.name}`
        );
      }
      if (!target.resource) return this._err(this._notFoundMessage(target.kind, target.name));
      if (this._evaluateWaitCondition(forFlag, target.resource)) {
        okLines.push(`${this._resourceRef(target.kind)}/${target.name} condition met`);
      } else {
        return this._err(
          `error: timed out waiting for the condition on ${this._pluralRef(target.kind)}/${target.name}`
        );
      }
    }
    return this._ok(okLines.join('\n'));
  },

  _pluralRef(kind) {
    return this._resourceNamePlural(kind);
  },

  // ── oc diff -f ──────────────────────────────────────────────────────────

  _unifiedDiffLines(leftLines, rightLines, context = 2) {
    // Simple LCS-based unified diff (no external dependency).
    const left = leftLines || [];
    const right = rightLines || [];
    const rows = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        rows[i][j] =
          left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        ops.push({ type: ' ', line: left[i] });
        i += 1;
        j += 1;
      } else if (rows[i + 1][j] >= rows[i][j + 1]) {
        ops.push({ type: '-', line: left[i] });
        i += 1;
      } else {
        ops.push({ type: '+', line: right[j] });
        j += 1;
      }
    }
    while (i < left.length) {
      ops.push({ type: '-', line: left[i] });
      i += 1;
    }
    while (j < right.length) {
      ops.push({ type: '+', line: right[j] });
      j += 1;
    }
    return { ops, context };
  },

  _formatUnifiedDiff(ops, context, livePath, mergedPath) {
    if (!ops.some((op) => op.type !== ' ')) return '';
    const lines = [`diff -u -N ${livePath} ${mergedPath}`, `--- ${livePath}`, `+++ ${mergedPath}`];
    // Group changed rows with surrounding context into hunks.
    const interesting = [];
    ops.forEach((op, index) => {
      if (op.type !== ' ') {
        for (let offset = -context; offset <= context; offset += 1)
          interesting.push(index + offset);
      }
    });
    const selected = [...new Set(interesting)]
      .filter((index) => index >= 0 && index < ops.length)
      .sort((a, b) => a - b);
    let cursor = 0;
    while (cursor < selected.length) {
      let end = cursor;
      while (end + 1 < selected.length && selected[end + 1] === selected[end] + 1) end += 1;
      const startIndex = selected[cursor];
      const endIndex = selected[end];
      const start = ops.slice(0, startIndex);
      const leftStart = start.filter((op) => op.type !== '+').length + 1;
      const rightStart = start.filter((op) => op.type !== '-').length + 1;
      const hunk = ops.slice(startIndex, endIndex + 1);
      const leftCount = hunk.filter((op) => op.type !== '+').length;
      const rightCount = hunk.filter((op) => op.type !== '-').length;
      lines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
      for (const op of hunk) lines.push(`${op.type}${op.line}`);
      cursor = end + 1;
    }
    return lines.join('\n');
  },

  /** Strip server-populated metadata/status before diffing. */
  _diffStripServerFields(manifest) {
    const copy = JSON.parse(JSON.stringify(manifest || {}));
    if (copy.metadata) {
      for (const key of [
        'uid',
        'resourceVersion',
        'creationTimestamp',
        'generation',
        'managedFields',
        'selfLink',
      ])
        delete copy.metadata[key];
      if (copy.metadata.annotations) {
        delete copy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
        if (!Object.keys(copy.metadata.annotations).length) delete copy.metadata.annotations;
      }
      if (copy.metadata.labels && !Object.keys(copy.metadata.labels).length)
        delete copy.metadata.labels;
    }
    delete copy.status;
    return copy;
  },

  /** JSON-merge style deep merge (lists replace, scalars overwrite) for diff/apply. */
  _diffMerge(live, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      return patch === undefined ? live : JSON.parse(JSON.stringify(patch));
    const base =
      live && typeof live === 'object' && !Array.isArray(live)
        ? JSON.parse(JSON.stringify(live))
        : {};
    for (const [key, value] of Object.entries(patch)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        base[key] &&
        typeof base[key] === 'object' &&
        !Array.isArray(base[key])
      ) {
        base[key] = this._diffMerge(base[key], value);
      } else {
        base[key] = JSON.parse(JSON.stringify(value));
      }
    }
    return base;
  },

  _cmdDiff(tokens, ctx) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-f': 'filename', '-n': 'namespace' },
      longValues: ['filename', 'namespace', 'field-manager', 'output'],
      longBools: ['server-side'],
    });
    const filename = flags.filename || positionals[0];
    if (!filename) return this._err('error: must specify -f <filename>\n\n  oc diff -f <file>');
    if (!this._manifestReady()) return this._manifestNotReady();
    const preview = this._manifestPreviewDocs(String(filename), { stdinText: ctx?.stdin ?? null });
    if (preview.error) return preview.error;
    const namespaceOverride =
      flags.namespace && flags.namespace !== true ? String(flags.namespace) : null;
    const diffs = [];
    for (const doc of preview.docs) {
      const kind = resolveKindToken(String(doc.kind || ''));
      if (!kind) return this._err(`error: the server doesn't have a resource type "${doc.kind}"`);
      // Desired object: top-level shape from the file (data/stringData/rules/spec…),
      // namespace defaulted like `oc apply`.
      const desired = JSON.parse(JSON.stringify(doc));
      desired.apiVersion = desired.apiVersion || apiVersionForKind(kind);
      desired.kind = kind;
      desired.metadata = desired.metadata || {};
      if (!desired.metadata.name)
        return this._err(
          `error: error validating "${preview.source}": metadata.name: Required value`
        );
      if (this._isNamespaced(kind))
        desired.metadata.namespace =
          namespaceOverride || desired.metadata.namespace || this.currentProject;
      else delete desired.metadata.namespace;
      const live = this._findResourceExact(kind, desired.metadata.name, desired.metadata.namespace);
      const fileName =
        `${this._resourceRef(kind).replace(/\//g, '.')}.${desired.metadata.namespace || ''}.${desired.metadata.name}`.replace(
          /^\.+|\.+$/g,
          ''
        );
      const mergedPath = `/tmp/MERGED-${String(stableHash(`${fileName}-${Date.now()}`, 99999999)).padStart(8, '0')}/${fileName}`;
      let livePath = '/dev/null';
      let liveLines = [];
      let mergedLines = [];
      if (live) {
        livePath = `/tmp/LIVE-${String(live.metadata?.uid || live.uid || 'unknown').slice(0, 8)}/${fileName}`;
        const liveClean = this._diffStripServerFields(this._manifestFor(live));
        const merged = this._diffMerge(liveClean, desired);
        const stripKinds = ['Secret']; // data is already comparable for simulated kinds
        void stripKinds;
        liveLines = toYamlDocument(liveClean).split('\n');
        mergedLines = toYamlDocument(merged).split('\n');
      } else {
        const cleanDesired = this._diffStripServerFields(desired);
        mergedLines = toYamlDocument(cleanDesired).split('\n');
      }
      const { ops } = this._unifiedDiffLines(liveLines, mergedLines, 2);
      const text = this._formatUnifiedDiff(ops, 2, livePath, mergedPath);
      if (text) diffs.push(text);
    }
    if (!diffs.length) return this._ok('');
    return this._ok(diffs.join('\n'));
  },

  // ── oc autoscale ────────────────────────────────────────────────────────

  // ── oc describe istag/<is>:<tag> ────────────────────────────────────────

  /** Detect `oc describe istag/<name>[:<tag>]` (and imagestreamtag variants). */
  _imageStreamTagRef(positionals) {
    if (!positionals || !positionals.length) return null;
    const first = String(positionals[0] || '');
    const slash = first.indexOf('/');
    const base = (slash >= 0 ? first.slice(0, slash) : first).toLowerCase();
    if (!['istag', 'istags', 'imagestreamtag', 'imagestreamtags'].includes(base)) return null;
    const name = slash >= 0 ? first.slice(slash + 1) : positionals[1];
    if (!name) return null;
    return { name: String(name) };
  },

  /** `oc describe istag/webapp:latest` — real output is the image description. */
  _describeImageStreamTag(ref, flags) {
    const namespace = flags.namespace || this.currentProject;
    if (!namespace) return this._err('error: you must be logged in to a project');
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const raw = String(ref.name);
    const at = raw.indexOf('@');
    const colon = raw.lastIndexOf(':');
    let repo = raw;
    let tag = 'latest';
    if (at >= 0) {
      repo = raw.slice(0, at);
    } else if (colon > 0) {
      repo = raw.slice(0, colon);
      tag = raw.slice(colon + 1) || 'latest';
    }
    const cluster = this.cluster;
    const stream =
      typeof cluster?.getImageStream === 'function'
        ? cluster.getImageStream(namespace, repo)
        : null;
    if (!stream) {
      return this._err(
        `Error from server (NotFound): imagestreamtags.image.openshift.io "${raw}" not found`
      );
    }
    const knownTags = [
      ...(stream.status?.tags || []).map((entry) => entry.tag),
      ...(stream.spec?.tags || []).map((entry) => entry.name),
    ].filter(Boolean);
    if (!knownTags.includes(tag)) {
      return this._err(
        `Error from server (NotFound): imagestreamtags.image.openshift.io "${raw}" not found`
      );
    }
    const info = this._imageInfoFor(`istag/${repo}:${tag}`, namespace);
    const lines = [
      `Image Name:\t${info.digest}`,
      `Docker Image:\t${info.dockerImage.includes('@') ? info.dockerImage : `${info.dockerImage.split(':')[0]}@${info.digest}`}`,
      `Name:\t\t${info.digest}`,
      `Created:\t${formatAge(info.created)} ago`,
      `Image Size:\t132.4MB in ${info.layers} layers`,
      `Image Created:\t${formatAge(info.created)} ago`,
      `Arch:\t\t${info.arch}`,
      `Command:\t${info.command}`,
      `Working Dir:\t${info.workingDir}`,
      `User:\t\t${info.user}`,
      `Environment:\t${info.env[0]}`,
    ];
    return this._ok(lines.join('\n'));
  },

  _cmdAutoscale(tokens) {
    const { positionals, flags } = parseArgs(tokens, {
      shortValues: { '-n': 'namespace' },
      longValues: ['namespace', 'min', 'max', 'cpu-percent', 'name', 'dry-run'],
      longBools: ['dry-run'],
    });
    const { kind, name } = this._resolveRef(positionals);
    if (!kind) return this._resourceTypeError(positionals[0] || '');
    if (!name)
      return this._usageError(
        'autoscale',
        'resource name is required\n\n  oc autoscale deployment/<name> --min=2 --max=5 --cpu-percent=80'
      );
    if (!['Deployment', 'ReplicaSet', 'StatefulSet', 'DeploymentConfig'].includes(kind)) {
      return this._err(`error: cannot autoscale a ${kind}`);
    }
    const namespace = this._namespaceFromFlags(flags);
    const namespaceError = this._requireNamespace(namespace);
    if (namespaceError) return namespaceError;
    const target = this._findResource(kind, name, {
      namespace: flags.namespace,
      explicitNamespace: Boolean(flags.namespace),
      allowPrefix: false,
      allowOtherNamespaces: false,
    });
    if (!target) return this._err(this._notFoundMessage(kind, name));
    const min = flags.min !== undefined && flags.min !== true ? Number(flags.min) : 1;
    const max = flags.max !== undefined && flags.max !== true ? Number(flags.max) : null;
    if (!Number.isFinite(min) || min < 0)
      return this._err(`error: invalid --min value "${flags.min}"`);
    if (max === null || !Number.isFinite(max) || max < 1)
      return this._err('error: must specify --max');
    if (min > max) return this._err('error: --min must be less than or equal to --max');
    const cpuPercent =
      flags['cpu-percent'] !== undefined && flags['cpu-percent'] !== true
        ? Number(flags['cpu-percent'])
        : null;
    if (cpuPercent !== null && (!Number.isFinite(cpuPercent) || cpuPercent < 1))
      return this._err('error: --cpu-percent must be greater than 0');
    const hpaName = flags.name && flags.name !== true ? String(flags.name) : name;
    if (this._findResourceExact('HorizontalPodAutoscaler', hpaName, namespace)) {
      return this._err(
        `Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "${hpaName}" already exists`
      );
    }
    const object = {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: hpaName, namespace },
      spec: {
        scaleTargetRef: { apiVersion: apiVersionForKind(kind), kind, name },
        minReplicas: min,
        maxReplicas: max,
        ...(cpuPercent !== null
          ? {
              metrics: [
                {
                  type: 'Resource',
                  resource: {
                    name: 'cpu',
                    target: { type: 'Utilization', averageUtilization: cpuPercent },
                  },
                },
              ],
            }
          : {}),
      },
    };
    if (this._dryRunMode(flags)) {
      const output = this._outputFormat(flags);
      if (output.format === 'yaml') return this._ok(toYamlDocument(object));
      if (output.format === 'json') return this._ok(JSON.stringify(object, null, 4));
      return this._ok(`horizontalpodautoscaler.autoscaling/${hpaName} autoscaled (dry run)`);
    }
    const created = this._applyObject(object);
    if (created.error) return created.error;
    return this._ok(`horizontalpodautoscaler.autoscaling/${hpaName} autoscaled`);
  },
});

export default CommandBar;

// ===CHUNK_SENTINEL===
