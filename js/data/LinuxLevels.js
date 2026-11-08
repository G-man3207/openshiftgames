/**
 * Linux & RHEL Foundations — the optional prelude chapter of the campaign
 * (chapter 0, level ids 101–107, displayed 0.1–0.7).
 *
 * The EX280 is "Red Hat Certified System Administrator in OpenShift": every
 * lab assumes a fluent RHEL command line (YAML files, logs, kubeconfig
 * permissions, node services such as kubelet/crio, DNS for the cluster API,
 * container images). Each level is one short, realistic task on the RHEL 9 lab
 * workstation (`student@workstation`) that an OpenShift admin really does, so
 * the skills transfer directly to the OpenShift levels.
 *
 * Levels run against the simulated workstation in js/engine/LinuxHost.js: the
 * `linuxHost` field is the level's seed (schema: /tmp/osg-team/LINUX-SCHEMA.md,
 * mirrored in the LinuxHost.js header) and CampaignMode resets the host with it
 * at level start. Objectives are graded from host STATE (file/service/process/
 * package/firewall/container) wherever possible; the few "inspect" steps are
 * `command` objectives whose patterns only match the real successful command
 * (failed commands never count, see ObjectiveEvaluator matchCommands()).
 *
 * Objectives are end-state and re-checked every second (CampaignMode
 * `recheckCompleted`), so all objectives of a level must be true together at
 * the end — e.g. L107 removes `old-test` while `web` keeps running.
 *
 * Every `how.run`/`how.check` command is replayed in a real browser by
 * scripts/browser-test.mjs (qa-guidance-replay) and must exit 0 there; the
 * qa-linux-levels section checks that wrong states never tick. CampaignLevels.js
 * places these levels first in CAMPAIGN_LEVELS (CHAPTERS order).
 */

import { imageDigest } from '../engine/LinuxHost.js';

const HOME = '/home/student';
const CHAPTER = { chapter: 0, chapterName: 'Linux & RHEL Foundations' };
const RHEL_DOCS = 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html';
const DOCS = {
  basics: `${RHEL_DOCS}/configuring_basic_system_settings/index`,
  logs: `${RHEL_DOCS}/configuring_basic_system_settings/assembly_troubleshooting-problems-using-log-files_configuring-basic-system-settings`,
  permissions: `${RHEL_DOCS}/configuring_basic_system_settings/managing-file-system-permissions_configuring-basic-system-settings`,
  sudo: `${RHEL_DOCS}/configuring_basic_system_settings/managing-sudo-access_configuring-basic-system-settings`,
  selinux: `${RHEL_DOCS}/using_selinux/index`,
  systemd: `${RHEL_DOCS}/configuring_basic_system_settings/managing-systemd_configuring-basic-system-settings`,
  time: `${RHEL_DOCS}/configuring_basic_system_settings/configuring-time-synchronization_configuring-basic-system-settings`,
  webServers: `${RHEL_DOCS}/deploying_web_servers_and_reverse_proxies/index`,
  networking: `${RHEL_DOCS}/configuring_and_managing_networking/index`,
  firewall: `${RHEL_DOCS}/configuring_firewalls_and_packet_filters/index`,
  dnf: `${RHEL_DOCS}/managing_software_with_the_dnf_tool/index`,
  containers: `${RHEL_DOCS}/building_running_and_managing_containers/index`,
};

/** Two worker nodes: the cluster the player will manage after this chapter (3D backdrop only). */
function workerNodes() {
  return ['worker-0', 'worker-1'].map((name) => ({
    kind: 'Node',
    name,
    labels: {
      'node-role.kubernetes.io/worker': '',
      'kubernetes.io/hostname': name,
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
    },
    spec: { cpu: '8', memory: '16Gi', status: 'Ready' },
  }));
}

// ─── seed file contents ────────────────────────────────────────────────────

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  labels:
    app: hello
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hello
  template:
    metadata:
      labels:
        app: hello
    spec:
      containers:
        - name: hello
          image: registry.access.redhat.com/ubi9/httpd-24
          ports:
            - containerPort: 8080
`;

const SERVICE_YAML = `apiVersion: v1
kind: Service
metadata:
  name: hello
spec:
  selector:
    app: hello
  ports:
    - port: 8080
      targetPort: 8080
`;

const ROUTE_YAML = `apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: hello
spec:
  to:
    kind: Service
    name: hello
  port:
    targetPort: 8080
`;

const NOTES_TXT = `EX280 study notes
=================
- oc login -u kubeadmin https://api.cluster.example.com:6443
- oc new-project NAME creates a project and switches to it
- oc apply -f FILE creates or updates what a manifest describes
- oc get pods -o wide shows the node each pod runs on
`;

const DRAFT_1_YAML = `# draft - replaced by deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-old
`;

const DRAFT_2_YAML = `# draft - do not apply
apiVersion: v1
kind: Service
metadata:
  name: hello-old
`;

/** The L101 end state: later levels start from the organised workspace. */
const WORKSPACE_FILES = [
  { path: `${HOME}/ex280/manifests/deployment.yaml`, content: DEPLOYMENT_YAML },
  { path: `${HOME}/ex280/manifests/service.yaml`, content: SERVICE_YAML },
  { path: `${HOME}/ex280/manifests/route.yaml`, content: ROUTE_YAML },
  { path: `${HOME}/ex280/notes.txt`, content: NOTES_TXT },
];

// `oc logs` output of the shop app's Pods (L102). Single spaces between the
// fields — timestamp, level, Pod, message — so `cut -d' ' -f3` is the Pod.
const SHOP_LOG_LINES = [
  '2026-11-08T09:00:01Z INFO web-7d9f8c6b5d-2xkqp starting shop web server on :8080',
  '2026-11-08T09:00:01Z INFO web-7d9f8c6b5d-9vjzt starting shop web server on :8080',
  '2026-11-08T09:00:02Z INFO cart-6b8f9c7d4-lm4wd starting cart service on :8081',
  '2026-11-08T09:00:02Z INFO payment-5f7c8d9b6-qz4tn starting payment service on :8443',
  '2026-11-08T09:00:05Z INFO web-7d9f8c6b5d-2xkqp GET /healthz 200 2ms',
  '2026-11-08T09:00:05Z INFO web-7d9f8c6b5d-9vjzt GET /healthz 200 3ms',
  '2026-11-08T09:00:06Z INFO cart-6b8f9c7d4-lm4wd GET /healthz 200 1ms',
  '2026-11-08T09:00:06Z INFO payment-5f7c8d9b6-qz4tn GET /healthz 200 2ms',
  '2026-11-08T09:00:09Z ERROR cart-6b8f9c7d4-lm4wd database connection refused: db.shop.svc:5432',
  '2026-11-08T09:00:11Z INFO web-7d9f8c6b5d-2xkqp GET /products 200 41ms',
  '2026-11-08T09:00:12Z WARN web-7d9f8c6b5d-9vjzt slow response from cart service (1840ms)',
  '2026-11-08T09:00:14Z ERROR payment-5f7c8d9b6-qz4tn x509: certificate has expired or is not yet valid',
  '2026-11-08T09:00:15Z INFO web-7d9f8c6b5d-2xkqp GET /healthz 200 2ms',
  '2026-11-08T09:00:15Z INFO web-7d9f8c6b5d-9vjzt GET /healthz 200 2ms',
  '2026-11-08T09:00:16Z INFO cart-6b8f9c7d4-lm4wd GET /healthz 200 1ms',
  '2026-11-08T09:00:16Z INFO payment-5f7c8d9b6-qz4tn GET /healthz 200 3ms',
  '2026-11-08T09:00:19Z ERROR cart-6b8f9c7d4-lm4wd database connection refused: db.shop.svc:5432',
  '2026-11-08T09:00:21Z INFO web-7d9f8c6b5d-2xkqp GET /cart 200 233ms',
  '2026-11-08T09:00:22Z ERROR web-7d9f8c6b5d-9vjzt upstream timeout calling cart service after 5000ms',
  '2026-11-08T09:00:23Z WARN web-7d9f8c6b5d-9vjzt retrying GET /cart after error (attempt 2 of 3)',
  '2026-11-08T09:00:24Z WARN payment-5f7c8d9b6-qz4tn TLS handshake with bank-gateway.example.com failed, retrying',
  '2026-11-08T09:00:25Z INFO web-7d9f8c6b5d-2xkqp GET /healthz 200 2ms',
  '2026-11-08T09:00:25Z INFO web-7d9f8c6b5d-9vjzt GET /healthz 200 4ms',
  '2026-11-08T09:00:26Z INFO cart-6b8f9c7d4-lm4wd GET /healthz 200 1ms',
  '2026-11-08T09:00:26Z INFO payment-5f7c8d9b6-qz4tn GET /healthz 200 2ms',
  '2026-11-08T09:00:28Z ERROR payment-5f7c8d9b6-qz4tn x509: certificate has expired or is not yet valid',
  '2026-11-08T09:00:29Z ERROR cart-6b8f9c7d4-lm4wd database connection refused: db.shop.svc:5432',
  '2026-11-08T09:00:31Z INFO web-7d9f8c6b5d-2xkqp GET /products 200 38ms',
  '2026-11-08T09:00:32Z ERROR web-7d9f8c6b5d-9vjzt upstream timeout calling cart service after 5000ms',
  '2026-11-08T09:00:33Z WARN cart-6b8f9c7d4-lm4wd connection pool exhausted, 0 of 10 free',
  '2026-11-08T09:00:35Z INFO web-7d9f8c6b5d-2xkqp GET /healthz 200 2ms',
  '2026-11-08T09:00:35Z INFO web-7d9f8c6b5d-9vjzt GET /healthz 200 3ms',
  '2026-11-08T09:00:36Z INFO cart-6b8f9c7d4-lm4wd GET /healthz 200 1ms',
  '2026-11-08T09:00:36Z INFO payment-5f7c8d9b6-qz4tn GET /healthz 200 2ms',
  '2026-11-08T09:00:39Z ERROR cart-6b8f9c7d4-lm4wd database connection refused: db.shop.svc:5432',
  '2026-11-08T09:00:41Z INFO web-7d9f8c6b5d-2xkqp GET /checkout 200 512ms',
];
const SHOP_LOG = `${SHOP_LOG_LINES.join('\n')}\n`;
const logLevel = (line) => line.split(' ')[1];
const SHOP_ERROR_LINES = SHOP_LOG_LINES.filter((line) => logLevel(line) === 'ERROR');
const SHOP_WARN_LINES = SHOP_LOG_LINES.filter((line) => logLevel(line) === 'WARN');
const SHOP_FAILING_PODS = [...new Set(SHOP_ERROR_LINES.map((line) => line.split(' ')[2]))].sort();
const SHOP_CLEAN_LINES = SHOP_LOG_LINES.filter((line) => !line.includes('healthz'));

/** pod.yaml with a TAB before `image:` — YAML forbids tabs for indentation (L103). */
const BROKEN_POD_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app: hello
spec:
  containers:
    - name: hello
    \timage: registry.access.redhat.com/ubi9/httpd-24
      ports:
        - containerPort: 8080
`;

/** The helper script written in L103 (seeded in L104 without the execute bit). */
const LAB_INFO_SH = `#!/bin/bash
echo "User: $(whoami) on $(hostname)"
echo "Editor: $KUBE_EDITOR"
`;

/** Installer-style kubeconfig (auth/kubeconfig of openshift-install), L104. */
const KUBECONFIG_YAML = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURNakNDQWhxZ0F3SUJBZ0lJVGJ5VXN0K3d4N0F3RFFZSktvWklodmNOQVFFTEJRQXdOekVTTUJBR0ExVUUKQ3hNSmIzQmxibk5vYVdaME1TRXdId1lEVlFRREV4aHJkV0psTFdGd2FYTmxjblpsY2kxc1lpMXphV2R1WlhJdwpIaGNOTWpZeE1UQXhNRGt3TURBd1doY05Nell4TURJNU1Ea3dNREF3V2pBM01SSXdFQVlEVlFRTEV3bHZjR1Z1CmMyaHBablF4SVRBZkJnTlZCQU1UR0d0MVltVXRZWEJwYzJWeWRtVnlMV3hpTFhOcFoyNWxjZz09Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K
    server: https://api.cluster.example.com:6443
  name: cluster
contexts:
- context:
    cluster: cluster
    user: admin
  name: admin
current-context: admin
kind: Config
preferences: {}
users:
- name: admin
  user:
    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURaekNDQWsrZ0F3SUJBZ0lJYWRtaW5jZXJ0d0RRWUpLb1pJaHZjTkFRRUxCUUF3TmpFU01CQUdBMVVFQ3hNSmIzQmxibk5vYVdaME1TQXdIZ1lEVlFRREV4ZGhaRzFwYmkxcmRXSmxZMjl1Wm1sbkxYTnBaMjVsY2c9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFcEFJQkFBS0NBUUVBdTNhZG1pbmtleWRhdGFkb25vdHNoYXJldGhpc2ZpbGV3aXRoYW55b25lCi0tLS0tRU5EIFJTQSBQUklWQVRFIEtFWS0tLS0tCg==
`;

const NOTES_PAGE_HTML = `<!DOCTYPE html>
<html>
  <head><title>EX280 lab notes</title></head>
  <body>
    <h1>EX280 lab notes</h1>
    <p>Lab files for the cluster nodes: <a href="/labfiles/">/labfiles/</a></p>
  </body>
</html>
`;

/** httpd drop-in for the lab file server; line 5 carries the typo (L105). */
const LABFILES_CONF_BROKEN = `# Lab files for the cluster nodes: http://workstation.lab.example.com/labfiles/
Alias /labfiles /srv/labfiles
<Directory "/srv/labfiles">
    Options +Indexes
    Requre all granted
</Directory>
`;
const LABFILES_CONF = LABFILES_CONF_BROKEN.replace('Requre', 'Require');

/** The lab file server's content (L105/L106). */
const LABFILES = [
  { path: '/srv/labfiles/deployment.yaml', content: DEPLOYMENT_YAML, owner: 'root', group: 'root' },
  { path: '/srv/labfiles/service.yaml', content: SERVICE_YAML, owner: 'root', group: 'root' },
  { path: '/srv/labfiles/route.yaml', content: ROUTE_YAML, owner: 'root', group: 'root' },
];

/**
 * The OpenShift lab files every campaign level gets in the Files panel (manifests/, examples/,
 * kustomize/, …) belong to the EX280 levels: the prelude starts from a plain RHEL home, so the
 * workspace the player builds is the only thing in it.
 */
const OPENSHIFT_LAB_PATHS = [
  'manifests',
  'examples',
  'kustomize',
  'templates',
  'helm',
  'netpol',
  'htpasswd',
].map((name) => `${HOME}/${name}`);

/** Digest of registry.access.redhat.com/ubi9/httpd-24:latest — what `skopeo inspect` prints (L107). */
const HTTPD_24_DIGEST = imageDigest('registry.access.redhat.com/ubi9/httpd-24:latest');

/** The address the stale /etc/hosts line sends the API name to (L106). */
const STALE_API_IP = '192.168.50.99';

// ─── levels ────────────────────────────────────────────────────────────────

export const LINUX_LEVELS = [
  // ── 0.1 ──────────────────────────────────────────────────────────────────
  {
    id: 101,
    title: 'The Shell & the Filesystem',
    ...CHAPTER,
    description:
      'Everything in this chapter happens in the terminal of your RHEL 9 lab workstation (press `/`), where you are logged in as `student`. Your browser saved the EX280 lab files to `~/Downloads`: turn them into a tidy `~/ex280` workspace — a `manifests` directory with copies of the three YAML files, your notes moved and renamed, and the old drafts deleted.',
    examObjectives: [],
    docsLinks: [DOCS.basics],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      files: [
        { path: `${HOME}/Downloads/deployment.yaml`, content: DEPLOYMENT_YAML },
        { path: `${HOME}/Downloads/service.yaml`, content: SERVICE_YAML },
        { path: `${HOME}/Downloads/route.yaml`, content: ROUTE_YAML },
        { path: `${HOME}/Downloads/ex280-notes.txt`, content: NOTES_TXT },
        { path: `${HOME}/Downloads/old-drafts/draft-1.yaml`, content: DRAFT_1_YAML },
        { path: `${HOME}/Downloads/old-drafts/draft-2.yaml`, content: DRAFT_2_YAML },
      ],
      remove: [...OPENSHIFT_LAB_PATHS, `${HOME}/ex280`],
    },
    objectives: [
      {
        type: 'ran',
        command: 'ls',
        flags: 'l',
        path: `${HOME}/Downloads`,
        label: 'List `~/Downloads` in long format (`ls -l`)',
        how: {
          explain:
            'The prompt `[student@workstation ~]$` names you, the host and where you are: `~` is your home, `/home/student`. `pwd` prints the current directory, `ls` lists one, `-l` adds owner, size and date and `-a` shows hidden files. Paths starting with `/` or `~` are absolute; any other path is relative to where you are.',
          run: ['pwd', 'ls -l ~/Downloads'],
          check: 'ls -la ~',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/manifests`,
        isDirectory: true,
        label: 'Create the directory `~/ex280/manifests`',
        how: {
          explain:
            '`mkdir` creates a directory. `-p` also creates the missing parent `~/ex280` and does not complain when the directory already exists; without it, `mkdir ~/ex280/manifests` fails because `~/ex280` does not exist yet.',
          run: ['mkdir -p ~/ex280/manifests'],
          check: 'ls -ld ~/ex280/manifests',
        },
      },
      {
        type: 'file',
        all: [
          { path: `${HOME}/ex280/manifests/deployment.yaml`, equals: DEPLOYMENT_YAML },
          { path: `${HOME}/ex280/manifests/service.yaml`, equals: SERVICE_YAML },
          { path: `${HOME}/ex280/manifests/route.yaml`, equals: ROUTE_YAML },
          { path: `${HOME}/Downloads/deployment.yaml`, exists: true },
          { path: `${HOME}/Downloads/service.yaml`, exists: true },
          { path: `${HOME}/Downloads/route.yaml`, exists: true },
        ],
        label: 'Copy the three YAML files into `~/ex280/manifests` (keep the originals)',
        how: {
          explain:
            '`cp SOURCE… DIRECTORY` copies files. `*.yaml` is a glob: the shell replaces it with every name ending in `.yaml` before `cp` runs (`echo ~/Downloads/*.yaml` shows the list). Keeping the downloads untouched means you can start over after breaking a manifest you edit and `oc apply` in the OpenShift levels.',
          run: ['cp ~/Downloads/*.yaml ~/ex280/manifests/'],
          check: 'ls -l ~/ex280/manifests',
        },
      },
      {
        type: 'file',
        all: [
          { path: `${HOME}/ex280/notes.txt`, equals: NOTES_TXT },
          { path: `${HOME}/Downloads/ex280-notes.txt`, absent: true },
        ],
        label: 'Move `~/Downloads/ex280-notes.txt` to `~/ex280/notes.txt`',
        how: {
          explain:
            '`mv` moves and renames in one step: the file leaves `~/Downloads` and arrives in `~/ex280` under its new name. The shell has no separate rename command.',
          run: ['mv ~/Downloads/ex280-notes.txt ~/ex280/notes.txt'],
          check: 'cat ~/ex280/notes.txt',
        },
      },
      {
        type: 'file',
        path: `${HOME}/Downloads/old-drafts`,
        absent: true,
        label: 'Delete the directory `~/Downloads/old-drafts`',
        how: {
          explain:
            '`rm` deletes files; a directory with files inside needs `-r` (recursive), while `rmdir` only removes empty directories. There is no recycle bin in the shell, so look at what you delete first.',
          run: ['ls ~/Downloads/old-drafts', 'rm -r ~/Downloads/old-drafts'],
          check: 'ls ~/Downloads',
        },
      },
    ],
    hints: [
      'Press `Tab` to complete names: type `ls ~/Dow` and press Tab. `cd` alone goes home, `cd ..` goes up one directory and `cd -` jumps back to the previous one.',
      '`ls -a` also shows hidden files (names starting with a dot, such as `.bashrc`); `ls -ld DIR` describes the directory itself instead of listing its content.',
      'Relative or absolute: after `cd ~/ex280`, `ls manifests` and `ls ~/ex280/manifests` list the same directory — `ls /manifests` does not.',
      '`touch FILE` creates an empty file, `cp -r` copies a whole directory and `rm -i` asks before each deletion.',
    ],
    starCriteria: { time: 300, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 102,
    tutorial: {
      steps: [
        {
          target: 'command-bar',
          text: 'Press / to open the terminal of your RHEL 9 workstation. You are student, in your home directory (~). Type pwd and press Enter.',
        },
        {
          target: 'command-bar',
          text: 'Every objective has a Show me how with the exact commands. Linux commands are case-sensitive and options start with a dash: ls -l ~/Downloads.',
        },
      ],
    },
  },

  // ── 0.2 ──────────────────────────────────────────────────────────────────
  {
    id: 102,
    title: 'Read, Search & Pipe Text',
    ...CHAPTER,
    description:
      "Logs are text, and the shell is built to search text. A teammate saved the `shop` application's Pod logs to `~/ex280/logs/shop.log`: read the newest lines, save the errors, count errors and warnings, list the failing Pods once each and strip the health-check noise — every result goes into a file next to the log.",
    examObjectives: [],
    docsLinks: [DOCS.logs],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      remove: OPENSHIFT_LAB_PATHS,
      files: [...WORKSPACE_FILES, { path: `${HOME}/ex280/logs/shop.log`, content: SHOP_LOG }],
    },
    objectives: [
      {
        type: 'command',
        pattern: '^\\s*(tail|head|less|cat)\\b.*shop\\.log',
        label: 'Read the newest lines of `shop.log` (`tail`)',
        how: {
          explain:
            '`cat` prints a whole file, `less` lets you scroll it (`q` quits), `head` and `tail` print the first and last 10 lines and `-n 20` changes the number. The newest log lines are at the end, so `tail` comes first. After `cd ~/ex280/logs` the short name `shop.log` is enough.',
          run: ['cd ~/ex280/logs', 'head -n 5 shop.log', 'tail -n 20 shop.log'],
          check: 'wc -l ~/ex280/logs/shop.log',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/logs/errors.txt`,
        equals: `${SHOP_ERROR_LINES.join('\n')}\n`,
        label: 'Save only the `ERROR` lines to `~/ex280/logs/errors.txt`',
        how: {
          explain:
            '`grep WORD FILE` prints the lines that contain WORD. It is case-sensitive: `ERROR` skips the WARN line that mentions “error”, which `grep -i` would include. `>` sends the output into a file instead of the screen, replacing what the file contained.',
          run: ['cd ~/ex280/logs', 'grep ERROR shop.log > errors.txt'],
          check: 'cat ~/ex280/logs/errors.txt',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/logs/summary.txt`,
        equals: `${SHOP_ERROR_LINES.length}\n${SHOP_WARN_LINES.length}\n`,
        label: 'Write `summary.txt`: the ERROR count on line 1, the WARN count on line 2',
        how: {
          explain:
            '`grep -c` prints how many lines match instead of the lines. `>` creates or overwrites a file and `>>` appends to its end: the first count goes in with `>`, the second with `>>`. Using `>` twice would leave only the WARN count.',
          run: [
            'cd ~/ex280/logs',
            'grep -c ERROR shop.log > summary.txt',
            'grep -c WARN shop.log >> summary.txt',
          ],
          check: 'cat ~/ex280/logs/summary.txt',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/logs/failing-pods.txt`,
        lineSet: SHOP_FAILING_PODS,
        label: 'List every Pod that logged an ERROR, once each, in `failing-pods.txt`',
        how: {
          explain:
            "A pipe `|` feeds one command's output into the next. `cut -d' ' -f3` keeps the third space-separated field (the Pod), `sort -u` sorts and keeps one of each (`sort | uniq -c` would count them). You will slice `oc get` and `oc logs` output with the same grep, cut and sort chain.",
          run: [
            'cd ~/ex280/logs',
            "grep ERROR shop.log | cut -d' ' -f3 | sort -u > failing-pods.txt",
          ],
          check: 'cat ~/ex280/logs/failing-pods.txt',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/logs/shop-clean.log`,
        equals: `${SHOP_CLEAN_LINES.join('\n')}\n`,
        label: 'Save the log without the `/healthz` lines to `shop-clean.log`',
        how: {
          explain:
            '`grep -v` inverts the match: it prints every line that does NOT contain the text. The kubelet calls `/healthz` every few seconds to check the Pods, so dropping those lines leaves the requests that matter. `wc -l` counts lines to compare both files.',
          run: ['cd ~/ex280/logs', 'grep -v healthz shop.log > shop-clean.log'],
          check: 'wc -l ~/ex280/logs/shop.log ~/ex280/logs/shop-clean.log',
        },
      },
    ],
    hints: [
      '`grep -n ERROR shop.log` adds line numbers, `grep -i error shop.log` ignores case and `grep -r ERROR ~/ex280` searches every file below a directory.',
      'Inside `less`: Space and `b` page down and up, `/word` searches, `G` jumps to the end, `q` quits.',
      "`grep ERROR shop.log | cut -d' ' -f3 | sort | uniq -c | sort -rn` counts and ranks the failing Pods — the classic “which Pod fails most” one-liner.",
      '`tee` writes to a file and still shows the output: `grep WARN shop.log | tee warnings.txt`.',
    ],
    starCriteria: { time: 360, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 103,
    tutorial: null,
  },

  // ── 0.3 ──────────────────────────────────────────────────────────────────
  {
    id: 103,
    title: 'Edit Files & the Shell Environment',
    ...CHAPTER,
    description:
      'OpenShift admins write YAML and tune their shell every day. Write a ConfigMap manifest, derive a staging copy with `sed`, fix a manifest that a TAB character broke, make `KUBE_EDITOR` permanent in `~/.bashrc` and load it, and write a small helper script in `~/bin`.',
    examObjectives: [],
    docsLinks: [DOCS.basics],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      files: [
        ...WORKSPACE_FILES,
        { path: `${HOME}/ex280/manifests/pod.yaml`, content: BROKEN_POD_YAML },
      ],
      remove: [...OPENSHIFT_LAB_PATHS, `${HOME}/bin`],
    },
    objectives: [
      {
        type: 'file',
        path: `${HOME}/ex280/manifests/configmap.yaml`,
        yaml: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          'metadata.name': 'app-config',
          'data.APP_MODE': 'production',
        },
        label:
          'Write `~/ex280/manifests/configmap.yaml`: ConfigMap `app-config` with `APP_MODE: production`',
        how: {
          explain:
            'YAML nests with spaces, two per level, never TAB. `printf` turns every `\\n` into a new line, so one command writes the file. On a real terminal a heredoc works too: `cat <<EOF > configmap.yaml`, the lines, then `EOF`. Or edit with `vim FILE`: `i` inserts, `Esc` stops, `:wq` saves and quits.',
          run: [
            "printf 'apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: app-config\\ndata:\\n  APP_MODE: production\\n' > ~/ex280/manifests/configmap.yaml",
          ],
          check: 'cat ~/ex280/manifests/configmap.yaml',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/manifests/configmap-staging.yaml`,
        yaml: { kind: 'ConfigMap', 'metadata.name': 'app-config', 'data.APP_MODE': 'staging' },
        label: 'Create `configmap-staging.yaml` from it with `sed` (`APP_MODE: staging`)',
        how: {
          explain:
            "`sed 's/old/new/' FILE` prints the file with the first “old” on each line replaced; the file itself is untouched. `| tee FILE` shows that output and saves it. Later you will pipe such output straight into the cluster: `… | oc apply -f -`, where `-` means “read standard input”.",
          run: [
            "sed 's/production/staging/' ~/ex280/manifests/configmap.yaml | tee ~/ex280/manifests/configmap-staging.yaml",
          ],
          check: 'grep APP_MODE ~/ex280/manifests/configmap-staging.yaml',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/manifests/pod.yaml`,
        yaml: {
          kind: 'Pod',
          'metadata.name': 'hello',
          'spec.containers.0.image': 'registry.access.redhat.com/ubi9/httpd-24',
        },
        label: 'Fix `pod.yaml`: replace the TAB that breaks its indentation',
        how: {
          explain:
            'YAML forbids TAB characters for indentation and a TAB looks like spaces on screen; `cat -A` shows it as `^I` (and every line end as `$`). `sed -i` edits the file in place: `\\t` matches the TAB and two spaces replace it. In `vim` you would delete it with `x` and type the spaces.',
          run: [
            'cat -A ~/ex280/manifests/pod.yaml',
            "sed -i 's/\\t/  /' ~/ex280/manifests/pod.yaml",
          ],
          check: 'cat -A ~/ex280/manifests/pod.yaml',
        },
      },
      {
        type: 'file',
        path: `${HOME}/.bashrc`,
        // The RHEL skeleton must survive: `echo … > ~/.bashrc` (overwrite) does not count.
        contains: ['^# \\.bashrc$', '^\\s*export\\s+KUBE_EDITOR=["\']?vim["\']?\\s*$'],
        label: 'Make it permanent: add `export KUBE_EDITOR=vim` to `~/.bashrc`',
        how: {
          explain:
            '`oc edit` opens the editor named in `KUBE_EDITOR` (then `EDITOR`, else `vi`). `~/.bashrc` runs whenever a new shell starts, so a line appended there makes the setting permanent. The single quotes write the text literally and `>>` appends instead of overwriting the file.',
          run: ["echo 'export KUBE_EDITOR=vim' >> ~/.bashrc"],
          check: 'tail -n 3 ~/.bashrc',
        },
      },
      {
        type: 'env',
        name: 'KUBE_EDITOR',
        value: 'vim',
        exported: true,
        label: 'Load it into your current shell: `echo $KUBE_EDITOR` prints `vim`',
        how: {
          explain:
            'Editing `~/.bashrc` does not change the shell you are already in: `source ~/.bashrc` re-reads it now. `NAME=value` sets a variable for this shell only; `export` also passes it to every program you start, such as `oc` or a script. `$NAME` reads it back.',
          run: ['source ~/.bashrc'],
          check: 'echo $KUBE_EDITOR',
        },
      },
      {
        type: 'file',
        path: `${HOME}/bin/lab-info.sh`,
        contains: ['^#!/bin/bash$', '\\$\\(whoami\\)'],
        label: 'Write the helper script `~/bin/lab-info.sh` (shebang + `$(whoami)`)',
        how: {
          explain:
            'Line 1 `#!/bin/bash` (the shebang) names the interpreter. `$(whoami)` is command substitution: the output of `whoami` replaces it. Single quotes keep `$…` literal so the script expands it when it runs; double quotes would expand it at once. RHEL 9 puts `~/bin` on your PATH.',
          run: [
            'mkdir -p ~/bin',
            `printf '#!/bin/bash\\necho "User: $(whoami) on $(hostname)"\\necho "Editor: $KUBE_EDITOR"\\n' > ~/bin/lab-info.sh`,
            'bash ~/bin/lab-info.sh',
          ],
          check: 'cat ~/bin/lab-info.sh',
        },
      },
    ],
    hints: [
      'vim survival kit: `i` insert, `Esc` back to command mode, `:wq` save and quit, `:q!` quit without saving, `dd` delete a line, `u` undo. In this game `vim FILE` opens the Files panel editor; `oc edit` uses the same editor later.',
      "Single vs double quotes: `echo '$HOME'` prints `$HOME`, `echo \"$HOME\"` prints `/home/student`. The same rule decides whether `oc exec POD -- sh -c 'echo $VAR'` expands the variable inside the container or on your workstation.",
      '`env | grep KUBE` lists exported variables; `echo $PATH` shows where the shell looks for commands (`~/bin` is in it).',
      'A heredoc on a real terminal: `cat <<EOF > app.yaml`, then the YAML lines, then a line with only `EOF`. Indent with spaces only.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 104,
    tutorial: null,
  },

  // ── 0.4 ──────────────────────────────────────────────────────────────────
  {
    id: 104,
    title: 'Users, Permissions & SELinux',
    ...CHAPTER,
    description:
      '`~/.kube/config` holds cluster-admin credentials, but it was copied with `sudo`, so root owns it and you cannot read it. Take it back and make it private, make your helper script executable, and restore the SELinux label of a web page that was moved into `/var/www/html` — without ever switching SELinux off.',
    examObjectives: [],
    docsLinks: [DOCS.permissions, DOCS.sudo, DOCS.selinux],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      remove: OPENSHIFT_LAB_PATHS,
      files: [
        ...WORKSPACE_FILES,
        { path: `${HOME}/.kube`, type: 'directory', mode: '0755' },
        {
          path: `${HOME}/.kube/config`,
          content: KUBECONFIG_YAML,
          mode: '0640',
          owner: 'root',
          group: 'root',
        },
        { path: `${HOME}/bin/lab-info.sh`, content: LAB_INFO_SH, mode: '0644' },
        {
          // Written in root's home and moved with `mv`: it keeps the admin_home_t label of /root
          // (the textbook RHEL case), so httpd answers 403 until restorecon.
          path: '/var/www/html/index.html',
          content: NOTES_PAGE_HTML,
          mode: '0644',
          owner: 'root',
          group: 'root',
          context: 'unconfined_u:object_r:admin_home_t:s0',
        },
      ],
      packages: { install: ['httpd'] },
      services: [{ name: 'httpd', active: true, enabled: true }],
    },
    objectives: [
      {
        type: 'command',
        pattern: '^\\s*id(\\s|$)',
        label: 'Check who you are and your groups (`id`)',
        how: {
          explain:
            '`id` prints your user and group IDs: `uid=1000(student)` and membership of `wheel`, the group allowed to run single commands as root with `sudo`. OpenShift works with numeric IDs too: every project gets its own UID range and containers run as a random high UID, not as root.',
          run: ['whoami', 'id'],
          check: 'groups',
        },
      },
      {
        type: 'file',
        path: `${HOME}/.kube/config`,
        owner: 'student',
        group: 'student',
        label: 'Take ownership of `~/.kube/config` (owner and group `student`)',
        how: {
          explain:
            '`ls -l` shows the owner and group after the permission bits. Only root may give a file to someone else, so `chown` needs `sudo`; `student:student` sets owner and group in one go (`chgrp` changes only the group). Using sudo for everything is how the file became root-owned.',
          run: ['ls -l ~/.kube/config', 'sudo chown student:student ~/.kube/config'],
          check: 'ls -l ~/.kube/config',
        },
      },
      {
        type: 'file',
        path: `${HOME}/.kube/config`,
        mode: '0600',
        owner: 'student',
        label: 'Make `~/.kube/config` private: mode `600` (`rw-------`)',
        how: {
          explain:
            'Permissions are three triplets — owner, group, others — of r=4, w=2, x=1, so `600` means read+write for you and nothing for anyone else. A kubeconfig is a password: `helm` even warns when it is group-readable. You own the file now, so `chmod` needs no sudo.',
          run: ['chmod 600 ~/.kube/config'],
          check: 'ls -l ~/.kube/config',
        },
      },
      {
        type: 'file',
        path: `${HOME}/bin/lab-info.sh`,
        perm: 'u+x',
        notPerm: 'go+w',
        label: 'Make `~/bin/lab-info.sh` executable so it runs by name',
        how: {
          explain:
            'A script runs by name only with the execute bit; without it bash answers `Permission denied`. Symbolic modes change single bits: `u+x` adds execute for the owner (u user, g group, o others, a all; `-` removes). `~/bin` is on your PATH, so `lab-info.sh` now runs from anywhere.',
          run: ['chmod u+x ~/bin/lab-info.sh', 'lab-info.sh'],
          check: 'ls -l ~/bin/lab-info.sh',
        },
      },
      {
        type: 'command',
        pattern: '^\\s*(sudo\\s+)?(getenforce|sestatus)(\\s|$)',
        label: 'Confirm that SELinux is enforcing (`getenforce`)',
        how: {
          explain:
            'SELinux labels every process and file and blocks any access its policy does not allow, even for root. `getenforce` must print `Enforcing`; `ls -Z` and `id -Z` show labels. OpenShift relies on it: each project gets its own SELinux categories, the `s0:c26,c5` values you will meet with SCCs.',
          run: ['getenforce', 'ls -Z ~/.kube/config'],
          check: 'sestatus',
        },
      },
      {
        type: 'file',
        path: '/var/www/html/index.html',
        context: 'httpd_sys_content_t',
        label: 'Restore the SELinux label of `/var/www/html/index.html`',
        how: {
          explain:
            "`mv` keeps a file's label: this page was written in root's home `/root` and still carries `admin_home_t`, so the web server may not read it (403 Forbidden). `restorecon` resets a path to the label the policy expects there, `httpd_sys_content_t`. A `cp` would have created a new file with the right label.",
          run: ['ls -Z /var/www/html/index.html', 'sudo restorecon -v /var/www/html/index.html'],
          check: 'ls -Z /var/www/html/index.html',
        },
      },
    ],
    hints: [
      'Reading `ls -l`: in `-rw-r-----. 1 root root`, the first character is the type (`-` file, `d` directory), then rw for the owner, r for the group, nothing for others; the final `.` means the file has an SELinux label.',
      'Octal cheat sheet: 7=rwx 6=rw- 5=r-x 4=r-- 0=---. `chmod 755 script` gives rwxr-xr-x; `chmod go-rwx FILE` removes everything from group and others.',
      '`sudo -l` lists what you may run as root; `sudo -i` opens a root shell whose prompt ends in `#` — `exit` returns.',
      'Never `setenforce 0` to make a problem go away: fix the label (`restorecon`) or the policy instead. `curl http://localhost/index.html` answers 403 until the label is right.',
    ],
    starCriteria: { time: 360, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 105,
    tutorial: null,
  },

  // ── 0.5 ──────────────────────────────────────────────────────────────────
  {
    id: 105,
    title: 'Processes, Services & Logs',
    ...CHAPTER,
    description:
      'The workstation is sluggish, the lab file server `httpd` failed to start after an edit, and the clock is not synchronised. Stop the runaway process, read the journal to find why httpd fails, fix it, and make sure httpd and `chronyd` run now and after every reboot — the `systemctl` and `journalctl` skills you use on a cluster node through `oc debug node`.',
    examObjectives: [],
    docsLinks: [DOCS.systemd, DOCS.logs, DOCS.time],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      remove: OPENSHIFT_LAB_PATHS,
      files: [
        ...WORKSPACE_FILES,
        ...LABFILES,
        {
          path: '/etc/httpd/conf.d/labfiles.conf',
          content: LABFILES_CONF_BROKEN,
          mode: '0644',
          owner: 'root',
          group: 'root',
        },
      ],
      packages: { install: ['httpd'] },
      services: [
        { name: 'httpd', active: false, enabled: false, failing: true },
        { name: 'chronyd', active: false, enabled: false },
      ],
      processes: [
        {
          name: 'dd',
          command: 'dd if=/dev/zero of=/dev/null',
          user: 'student',
          pid: 3871,
          cpu: 99.6,
          mem: 0.0,
        },
      ],
    },
    objectives: [
      {
        type: 'process',
        name: 'dd',
        running: false,
        label: 'Stop the runaway `dd` process',
        how: {
          explain:
            "`ps aux` lists every process with its owner, PID, CPU and memory use; `--sort=-%cpu` puts the busiest first. `kill PID` asks a process to stop (signal TERM); `kill -9 PID` forces one that ignores it. You may signal your own processes, other users' need sudo. `top -b -n 1` prints one snapshot.",
          run: ['ps aux --sort=-%cpu | head -n 5', 'kill 3871'],
          check: 'top -b -n 1 | head -n 12',
        },
      },
      {
        type: 'command',
        pattern:
          '^\\s*(sudo\\s+)?journalctl\\b.*(-[a-zA-Z]*u\\s*|--unit[=\\s]+)httpd(\\.service)?\\b',
        label: 'Read why httpd failed in its journal (`journalctl -u httpd`)',
        how: {
          explain:
            'systemd stores the output of every service in the journal. `journalctl -u UNIT` shows one service, `-n 20` the last 20 lines, `-p err` only errors and `-e` jumps to the end. Look for the httpd line that names the file, the line number and the problem. On a node, `journalctl -u kubelet` is the same skill.',
          run: ['systemctl --failed', 'journalctl -u httpd -n 20'],
          check: 'journalctl -u httpd -p err',
        },
      },
      {
        type: 'service',
        name: 'httpd',
        active: true,
        label: 'Fix the typo in `/etc/httpd/conf.d/labfiles.conf` and start httpd',
        how: {
          explain:
            'The journal blames line 5 of `labfiles.conf`: `Requre` is not a directive. Files under `/etc` belong to root, so fix it with `sudo sed -i` (or `sudo vim`). `sudo httpd -t` checks the syntax, then `systemctl restart` starts the service again.',
          run: [
            "sudo sed -i 's/Requre/Require/' /etc/httpd/conf.d/labfiles.conf",
            'sudo systemctl restart httpd',
          ],
          check: 'systemctl status httpd',
        },
      },
      {
        type: 'service',
        name: 'httpd',
        enabled: true,
        label: 'Make httpd start at every boot (enabled)',
        how: {
          explain:
            '`start` and `restart` change the running system only; `enable` makes systemd start the unit at boot. A service that runs but is disabled is gone after the next reboot — a classic exam trap. `systemctl enable --now` does both at once.',
          run: ['sudo systemctl enable httpd'],
          check: 'systemctl is-enabled httpd',
        },
      },
      {
        type: 'service',
        name: 'chronyd',
        active: true,
        enabled: true,
        label: 'Turn on time synchronisation: `chronyd` running and enabled',
        how: {
          explain:
            'Certificates and login tokens are valid only within a time window: with a drifting clock `oc login` fails with “x509: certificate has expired or is not yet valid”. `chronyd` keeps the clock in sync; `enable --now` starts it and enables it at boot. `timedatectl` shows the result.',
          run: ['timedatectl', 'sudo systemctl enable --now chronyd'],
          check: 'timedatectl',
        },
      },
    ],
    hints: [
      '`systemctl status httpd` shows the state and the newest log lines at once; it exits with status 3 while the unit is not running, which is why scripts use `systemctl is-active httpd`.',
      '`journalctl -xeu httpd` (explanations, jump to the end, one unit) is the usual first look after a failed start; `systemctl --failed` lists every failed unit.',
      '`pgrep -a dd` finds processes by name and `pkill dd` signals them; `kill -l` lists the signal names.',
      'On an OpenShift node the same commands fix the node agent: `oc debug node/worker-0`, then `chroot /host`, `systemctl status kubelet` and `journalctl -u kubelet -n 50`.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 106,
    tutorial: null,
  },

  // ── 0.6 ──────────────────────────────────────────────────────────────────
  {
    id: 106,
    title: 'Networking & the Firewall',
    ...CHAPTER,
    description:
      'Your workstation must reach the cluster, and the cluster nodes must reach your lab file server. Check your address and route, resolve the cluster DNS names, remove the stale `/etc/hosts` line that sends `api.cluster.example.com` to a dead address, and open the firewall for HTTP — now and permanently.',
    examObjectives: [],
    docsLinks: [DOCS.networking, DOCS.firewall],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      remove: OPENSHIFT_LAB_PATHS,
      files: [
        ...WORKSPACE_FILES,
        ...LABFILES,
        {
          path: '/etc/httpd/conf.d/labfiles.conf',
          content: LABFILES_CONF,
          mode: '0644',
          owner: 'root',
          group: 'root',
        },
      ],
      packages: { install: ['httpd'] },
      services: [{ name: 'httpd', active: true, enabled: true }],
      hosts: [{ ip: STALE_API_IP, names: ['api.cluster.example.com'] }],
    },
    objectives: [
      {
        type: 'command',
        pattern: '^\\s*ip\\s+(-\\S+\\s+)*r(o(u(te?)?)?)?(\\s|$)',
        label: 'Find your default gateway (`ip route`)',
        how: {
          explain:
            '`ip addr` (short `ip a`) lists the network interfaces and their addresses: `eth0` has 172.25.250.9/24. `ip route` shows where packets go; the `default via 172.25.250.254` line is the gateway towards every other network, the cluster included.',
          run: ['ip -4 addr show eth0', 'ip route'],
          check: 'hostname -I',
        },
      },
      {
        type: 'command',
        pattern: '^\\s*(dig|host|nslookup)\\b.*\\.apps\\.cluster\\.example\\.com\\b',
        label: 'Resolve a hostname under `*.apps.cluster.example.com` with `dig`',
        how: {
          explain:
            'A cluster needs two DNS records: `api.cluster.example.com` for the API server and the wildcard `*.apps.cluster.example.com`, which sends every application hostname to the ingress router. `dig +short NAME` prints only the address — any name under `.apps` resolves, even one nobody created.',
          run: [
            'dig api.cluster.example.com',
            'dig +short console-openshift-console.apps.cluster.example.com',
            'dig +short anything.apps.cluster.example.com',
          ],
          check: 'host console-openshift-console.apps.cluster.example.com',
        },
      },
      {
        type: 'file',
        path: '/etc/hosts',
        notContains: '^[^#\\n]*\\bapi\\.cluster\\.example\\.com\\b',
        label: 'Remove the stale `/etc/hosts` entry for `api.cluster.example.com`',
        how: {
          explain:
            "Programs read `/etc/hosts` before DNS, but `dig` asks DNS only: `dig` finds the API while `ping` and `curl` use the stale line. `$(…)` inserts a command's output, so `API_IP=$(dig +short …)` stores the real address and `ping -c 1 $API_IP` proves it answers. `sed -i '/TEXT/d'` deletes the matching line.",
          run: [
            'getent hosts api.cluster.example.com',
            'API_IP=$(dig +short api.cluster.example.com)',
            'ping -c 1 $API_IP',
            "sudo sed -i '/api.cluster.example.com/d' /etc/hosts",
          ],
          check: 'curl -k https://api.cluster.example.com:6443/readyz',
        },
      },
      {
        type: 'firewall',
        service: 'http',
        runtime: true,
        label: 'Allow HTTP through the firewall now (runtime)',
        how: {
          explain:
            '`ss -tlnp` lists listening TCP ports and their programs: httpd waits on port 80, but firewalld still blocks it from other machines. `firewall-cmd --add-service=http` opens it in the runtime configuration, which is active at once but lost on `--reload` or reboot. Firewall changes need root.',
          run: ['sudo ss -tlnp', 'sudo firewall-cmd --add-service=http'],
          check: 'sudo firewall-cmd --list-services',
        },
      },
      {
        type: 'firewall',
        service: 'http',
        permanent: true,
        label: 'Make the HTTP rule permanent',
        how: {
          explain:
            '`--permanent` writes the rule to the saved configuration only; `--reload` then turns the saved configuration into the running one — a runtime-only rule would disappear with it. Permanent plus reload is the safe pair (`--runtime-to-permanent` saves what is running now).',
          run: ['sudo firewall-cmd --permanent --add-service=http', 'sudo firewall-cmd --reload'],
          check: 'sudo firewall-cmd --list-all',
        },
      },
    ],
    hints: [
      '`cat /etc/resolv.conf` shows the DNS server and search domain, `cat /etc/hosts` the local overrides, and the `hosts:` line of `/etc/nsswitch.conf` the order (files before dns).',
      '`curl -k https://api.cluster.example.com:6443/readyz` asks the API server whether it is ready; `-k` skips the certificate check that `oc login` performs.',
      '`firewall-cmd --add-port=8080/tcp` opens a port that has no service name; `--list-all` shows the zone with its services and ports.',
      '`ping -c 3 HOST` sends three packets and stops — without `-c` it runs until Ctrl+C.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 107,
    tutorial: null,
  },

  // ── 0.7 ──────────────────────────────────────────────────────────────────
  {
    id: 107,
    title: 'Packages & Containers',
    ...CHAPTER,
    description:
      "OpenShift runs your applications as containers. Install the OpenShift CLI `oc` with `dnf`, clean up an old test container, run Red Hat's UBI httpd image with `podman` the way a Pod will run it, read its log, and record the digest that pins the image for good. Next stop: Level 1, where `oc` runs containers on the cluster for you.",
    examObjectives: [],
    docsLinks: [DOCS.dnf, DOCS.containers],
    startingResources: workerNodes(),
    availableResources: [],
    workProject: null,
    linuxHost: {
      cwd: HOME,
      remove: OPENSHIFT_LAB_PATHS,
      files: [...WORKSPACE_FILES],
      // A fresh RHEL machine has no `oc` yet: it comes from the openshift-clients RPM.
      packages: { remove: ['openshift-clients'] },
      podman: {
        images: ['registry.access.redhat.com/ubi9/ubi-minimal:latest'],
        containers: [
          {
            name: 'old-test',
            image: 'registry.access.redhat.com/ubi9/ubi-minimal:latest',
            state: 'running',
          },
        ],
      },
    },
    objectives: [
      {
        type: 'package',
        name: 'openshift-clients',
        installed: true,
        label: 'Install the OpenShift CLI: the `openshift-clients` package (provides `oc`)',
        how: {
          explain:
            '`dnf` installs RPM packages from the enabled repositories, dependencies included; `-y` answers the confirmation prompt and installing needs root. `dnf info PACKAGE` describes a package, `rpm -q PACKAGE` asks the RPM database whether it is installed. The exam workstation has `oc` already; your own RHEL machine gets it like this.',
          run: ['dnf info openshift-clients', 'sudo dnf install -y openshift-clients'],
          check: 'oc version --client',
        },
      },
      {
        type: 'container',
        name: 'old-test',
        exists: false,
        label: 'Stop and remove the old container `old-test`',
        how: {
          explain:
            '`podman ps` lists running containers and `-a` adds stopped ones. `podman stop` asks the main process to end (then kills it after 10 seconds) and `podman rm` deletes the stopped container; `rm -f` does both. Removing a container never deletes its image.',
          run: ['podman ps -a', 'podman stop old-test', 'podman rm old-test'],
          check: 'podman ps -a',
        },
      },
      {
        type: 'container',
        name: 'web',
        running: true,
        image: 'ubi9/httpd-24',
        publish: '8080:8080',
        label: 'Run `web` from `ubi9/httpd-24` in the background with port 8080 published',
        how: {
          explain:
            '`podman run -d` starts a container in the background, `--name` names it and `-p 8080:8080` maps port 8080 of the workstation to port 8080 in the container. Red Hat images listen on 8080 and run without root, exactly what OpenShift requires. You run podman rootless: no sudo.',
          run: [
            'podman pull registry.access.redhat.com/ubi9/httpd-24',
            'podman run -d --name web -p 8080:8080 registry.access.redhat.com/ubi9/httpd-24',
          ],
          check: 'podman ps',
        },
      },
      {
        type: 'command',
        pattern: '^\\s*podman\\s+(container\\s+)?logs\\s+(-\\S+\\s+)*web(\\s|$)',
        label: "Read the container's log (`podman logs web`)",
        how: {
          explain:
            "A container's output is its log: `podman logs web` prints it, just as `oc logs` will for a Pod. `podman exec web COMMAND` runs a command inside the running container, like `oc exec`.",
          run: ['podman logs web', 'podman exec web cat /etc/redhat-release'],
          check: 'podman ps',
        },
      },
      {
        type: 'file',
        path: `${HOME}/ex280/httpd-24.digest`,
        // THE digest of ubi9/httpd-24:latest (what skopeo prints), not just any sha256.
        contains: HTTPD_24_DIGEST,
        label: 'Save the image digest to `~/ex280/httpd-24.digest`',
        how: {
          explain:
            'A tag such as `latest` is a movable label; the digest `sha256:…` names exactly one image forever. `skopeo inspect` reads image details from the registry without pulling, `--format` prints a single field. OpenShift image streams record this digest, so a Deployment keeps the image it was tested with.',
          run: [
            "skopeo inspect --format '{{.Digest}}' docker://registry.access.redhat.com/ubi9/httpd-24:latest > ~/ex280/httpd-24.digest",
          ],
          check: 'cat ~/ex280/httpd-24.digest',
        },
      },
    ],
    hints: [
      '`podman images` lists local images with their tags and `podman images --digests` adds the digest; pull by digest with `podman pull IMAGE@sha256:DIGEST`.',
      '`dnf repolist` shows the enabled repositories: `openshift-clients` comes from `rhocp-4.22-for-rhel-9-x86_64-rpms`, the OpenShift repository a subscribed RHEL machine must enable first. `rpm -qi openshift-clients` prints the package details.',
      'Rootless `podman` cannot publish ports below 1024 (`-p 80:8080` fails with “rootlessport cannot expose privileged port 80”) — one more reason container images listen on 8080.',
      'A Pod is one or more containers that share an IP address. From Level 1 on, OpenShift schedules containers like `web` onto worker nodes for you, and `oc` reads manifests from a file or from a pipe (`… | oc apply -f -`) just like the commands here.',
    ],
    starCriteria: { time: 420, efficiency: 0.7, noFailures: false },
    incidents: [],
    nextLevel: 1,
    tutorial: null,
  },
];

/** Seed contents the tests and verify.mjs compare against (read-only). */
export const LINUX_LEVEL_FIXTURES = Object.freeze({
  shopLog: SHOP_LOG,
  shopErrorLines: SHOP_ERROR_LINES,
  shopWarnLines: SHOP_WARN_LINES,
  shopFailingPods: SHOP_FAILING_PODS,
  shopCleanLines: SHOP_CLEAN_LINES,
  staleApiIp: STALE_API_IP,
});
