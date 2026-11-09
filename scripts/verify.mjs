#!/usr/bin/env node
/**
 * shifting.pro — static verification harness (no runtime dependencies).
 *
 * Usage:  node scripts/verify.mjs [--verbose]
 * Exit code 0 = all checks passed, 1 = failures.
 *
 * Checks:
 *  1. JS syntax for every module and inline HTML module.
 *  2. Relative import graph: files exist and named imports resolve to exports.
 *  3. Kind registry integrity: 47 OpenShift kinds, API versions/scope, palette
 *     coverage, mesh creators, factory behaviour, draw/index palette wiring.
 *  4. Default cluster state (Projects, ClusterOperators, ClusterVersion, SCCs,
 *     users/RBAC, ImageStreams) and the declarative engine self-tests.
 *  5. Campaign (20 levels / 5 chapters), Challenges (13), incidents (35+) and
 *     EX280V422 objective coverage (9 groups / 55 bullets).
 *  6. ScoringEngine / achievements contract and OpenShift branding.
 *  7. Required root files, README coverage/deploy docs and image dimensions.
 *  8. Dev-tooling contract: package.json is dev-only (Prettier/Knip/husky) with no
 *     runtime dependencies or bundler/build config, node_modules is never tracked,
 *     and the Knip entry mirror covers every inline index.html/draw.html import.
 *
 * This script only reports; it never edits the repo.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const failures = [];
const warnings = [];
const notes = [];
const checks = { passed: 0, failed: 0, warned: 0 };

function fail(check, message, detail) {
  checks.failed += 1;
  failures.push({ check, message, detail: detail ? String(detail) : undefined });
}
function warn(check, message, detail) {
  checks.warned += 1;
  warnings.push({ check, message, detail: detail ? String(detail) : undefined });
}
function note(message) {
  notes.push(message);
}
function passed() {
  checks.passed += 1;
}
function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}
function has(rel) {
  return existsSync(path.join(ROOT, rel));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allAbs = walk(ROOT);
const allFiles = allAbs.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
const jsFiles = allFiles.filter((f) => f.endsWith('.js'));

async function tryImport(rel) {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (err) {
    warn('imports', `${rel} could not be imported for data checks: ${err.message}`);
    return null;
  }
}

const IMPORT_FROM_RE = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const NAMED_IMPORT_RE = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const EXPORT_DECL_RE = /export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function scanExports(src) {
  src = stripComments(src);
  const names = new Set(['default']);
  let wildcard = false;
  for (const m of src.matchAll(EXPORT_DECL_RE)) names.add(m[1]);
  for (const m of src.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits.length === 2) names.add(bits[1].trim());
      else if (bits[0].trim()) names.add(bits[0].trim());
    }
  }
  if (/export\s+\*\s+from/.test(src)) wildcard = true;
  return { names, wildcard };
}

const exportCache = new Map();
function getExports(rel) {
  if (exportCache.has(rel)) return exportCache.get(rel);
  const abs = path.join(ROOT, rel);
  let info = null;
  if (existsSync(abs) && abs.endsWith('.js')) info = scanExports(readFileSync(abs, 'utf8'));
  exportCache.set(rel, info);
  return info;
}

function inlineModules(htmlRel) {
  const src = read(htmlRel);
  const out = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of src.matchAll(re)) out.push({ htmlRel, src: m[1] });
  return out;
}

function pngSize(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return null;
  const buf = readFileSync(abs);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// ── 1. Syntax ──────────────────────────────────────────────────────────────
for (const rel of jsFiles) {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const res = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: src,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fail('syntax', `${rel}: syntax error`, (res.stderr || '').split('\n').slice(0, 6).join('\n'));
  } else {
    passed();
  }
}
for (const htmlRel of ['index.html', 'draw.html']) {
  for (const [i, mod] of inlineModules(htmlRel).entries()) {
    const res = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: mod.src,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      fail(
        'syntax',
        `${htmlRel} inline module #${i + 1}: syntax error`,
        (res.stderr || '').split('\n').slice(0, 6).join('\n')
      );
    } else {
      passed();
    }
  }
}
note(`Syntax: ${jsFiles.length} JS modules + inline HTML modules parsed`);

// ── 2. Import graph (JS + inline HTML modules) ─────────────────────────────
const scannedModules = [
  ...jsFiles.map((rel) => ({ rel, src: readFileSync(path.join(ROOT, rel), 'utf8') })),
  ...['index.html', 'draw.html'].flatMap((htmlRel) =>
    inlineModules(htmlRel).map((mod, i) => ({ rel: `${htmlRel}#inline${i + 1}`, src: mod.src }))
  ),
];

for (const { rel, src } of scannedModules) {
  const clean = stripComments(src);
  const baseDir = rel.includes('#') ? '' : path.posix.dirname(rel);
  const specs = new Set();
  for (const m of clean.matchAll(IMPORT_FROM_RE)) specs.add(m[1]);
  for (const m of clean.matchAll(DYNAMIC_IMPORT_RE)) specs.add(m[1]);
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue; // bare specifiers are CDN import-map modules
    const target = path.posix.normalize(path.posix.join(baseDir, spec));
    if (!existsSync(path.join(ROOT, target))) {
      fail('imports', `${rel}: missing import target "${spec}"`);
    } else {
      passed();
    }
  }
  for (const m of clean.matchAll(NAMED_IMPORT_RE)) {
    const clause = m[1];
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const brace = clause.match(/\{([\s\S]*?)\}/);
    if (!brace) continue;
    const target = path.posix.normalize(path.posix.join(baseDir, spec));
    const info = getExports(target);
    if (!info || info.wildcard) continue;
    for (const raw of brace[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (!name) continue;
      if (!info.names.has(name)) fail('imports', `${rel}: "${name}" not exported by ${target}`);
      else passed();
    }
  }
}
// Dynamic import() paths inside the HTML shells (including optional panels).
for (const htmlRel of ['index.html', 'draw.html']) {
  for (const m of read(htmlRel).matchAll(/['"]\.\/(js\/[^'"]+\.js)['"]/g)) {
    if (!existsSync(path.join(ROOT, m[1])))
      fail('imports', `${htmlRel}: dynamic import target missing "${m[1]}"`);
  }
}

// ── 3. Kind registry ───────────────────────────────────────────────────────
const EXPECTED_API = {
  Pod: 'v1',
  Deployment: 'apps/v1',
  ReplicaSet: 'apps/v1',
  StatefulSet: 'apps/v1',
  DaemonSet: 'apps/v1',
  Job: 'batch/v1',
  CronJob: 'batch/v1',
  Service: 'v1',
  Route: 'route.openshift.io/v1',
  Ingress: 'networking.k8s.io/v1',
  NetworkPolicy: 'networking.k8s.io/v1',
  ConfigMap: 'v1',
  Secret: 'v1',
  PersistentVolumeClaim: 'v1',
  PersistentVolume: 'v1',
  StorageClass: 'storage.k8s.io/v1',
  HorizontalPodAutoscaler: 'autoscaling/v2',
  PodDisruptionBudget: 'policy/v1',
  ResourceQuota: 'v1',
  LimitRange: 'v1',
  Role: 'rbac.authorization.k8s.io/v1',
  RoleBinding: 'rbac.authorization.k8s.io/v1',
  ClusterRole: 'rbac.authorization.k8s.io/v1',
  ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
  ServiceAccount: 'v1',
  Project: 'project.openshift.io/v1',
  BuildConfig: 'build.openshift.io/v1',
  Build: 'build.openshift.io/v1',
  ImageStream: 'image.openshift.io/v1',
  Template: 'template.openshift.io/v1',
  Subscription: 'operators.coreos.com/v1alpha1',
  OperatorGroup: 'operators.coreos.com/v1',
  InstallPlan: 'operators.coreos.com/v1alpha1',
  ClusterServiceVersion: 'operators.coreos.com/v1alpha1',
  PackageManifest: 'packages.operators.coreos.com/v1',
  MetalLB: 'metallb.io/v1beta1',
  SecurityContextConstraints: 'security.openshift.io/v1',
  ClusterResourceQuota: 'quota.openshift.io/v1',
  User: 'user.openshift.io/v1',
  Group: 'user.openshift.io/v1',
  Identity: 'user.openshift.io/v1',
  OAuth: 'config.openshift.io/v1',
  ClusterOperator: 'config.openshift.io/v1',
  ClusterVersion: 'config.openshift.io/v1',
  IPAddressPool: 'metallb.io/v1beta1',
  L2Advertisement: 'metallb.io/v1beta1',
  PrometheusRule: 'monitoring.coreos.com/v1',
  Alertmanager: 'monitoring.coreos.com/v1',
  Node: 'v1',
};
const EXPECTED_CLUSTER_SCOPED = new Set([
  'Node',
  'Project',
  'PersistentVolume',
  'StorageClass',
  'ClusterRole',
  'ClusterRoleBinding',
  'SecurityContextConstraints',
  'ClusterResourceQuota',
  'User',
  'Group',
  'Identity',
  'OAuth',
  'ClusterOperator',
  'ClusterVersion',
  'PackageManifest',
]);
const EXPECTED_PLACEABLE = [
  'Project',
  'Node',
  'ClusterResourceQuota',
  'Pod',
  'Deployment',
  'ReplicaSet',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'BuildConfig',
  'ImageStream',
  'Service',
  'Route',
  'Ingress',
  'NetworkPolicy',
  'IPAddressPool',
  'L2Advertisement',
  'ConfigMap',
  'Secret',
  'LimitRange',
  'ResourceQuota',
  'Template',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'StorageClass',
  'HorizontalPodAutoscaler',
  'PodDisruptionBudget',
  'ServiceAccount',
  'Role',
  'ClusterRole',
  'RoleBinding',
  'ClusterRoleBinding',
  'SecurityContextConstraints',
  'User',
  'Group',
  'Subscription',
];

let registry = null;
try {
  registry = await import(pathToFileURL(path.join(ROOT, 'js/data/kindRegistry.js')).href);
  passed();
} catch (err) {
  fail('registry', `js/data/kindRegistry.js failed to import: ${err.message}`);
}

if (registry) {
  const kinds = registry.RESOURCE_KINDS || [];
  const kindSet = new Set(kinds);
  const expected = Object.keys(EXPECTED_API);
  for (const kind of expected) {
    if (!kindSet.has(kind)) fail('registry', `missing OpenShift kind in RESOURCE_KINDS: ${kind}`);
  }
  for (const kind of kinds) {
    if (!expected.includes(kind))
      warn('registry', `unexpected kind outside the spec catalog: ${kind}`);
  }
  if (kinds.length < 40) fail('registry', `expected 40+ kinds, found ${kinds.length}`);
  if (kindSet.has('Namespace'))
    fail('registry', 'retired Namespace kind is still in RESOURCE_KINDS');
  if (
    typeof registry.normalizeKind !== 'function' ||
    registry.normalizeKind('namespace') !== 'Project'
  ) {
    fail('registry', 'normalizeKind("namespace") must resolve to Project (Namespace is retired)');
  }
  if (registry.KIND_ALIASES?.dc !== 'Deployment')
    fail('registry', 'dc alias must map to Deployment (DeploymentConfig deprecated)');

  const sectionIds = new Set((registry.KIND_SECTIONS || []).map((s) => s.id));
  for (const kind of kinds) {
    const def = registry.KIND_DEFS?.[kind];
    if (!def) {
      fail('registry', `missing definition for ${kind}`);
      continue;
    }
    if (!def.apiVersion) fail('registry', `${kind}: missing apiVersion`);
    else if (EXPECTED_API[kind] && def.apiVersion !== EXPECTED_API[kind]) {
      fail('registry', `${kind}: apiVersion "${def.apiVersion}" != spec "${EXPECTED_API[kind]}"`);
    } else passed();
    if (typeof def.namespaced !== 'boolean') fail('registry', `${kind}: missing namespaced flag`);
    else if (def.namespaced === EXPECTED_CLUSTER_SCOPED.has(kind)) {
      fail('registry', `${kind}: namespaced=${def.namespaced} contradicts spec scope`);
    } else passed();
    if (!def.palette || !def.palette.label || !sectionIds.has(def.palette.section)) {
      fail('registry', `${kind}: missing/invalid palette metadata ${JSON.stringify(def.palette)}`);
    }
    if (typeof def.minimapSize !== 'number' || def.minimapSize <= 0)
      fail('registry', `${kind}: missing minimapSize`);
    if (typeof def.defaultSpec !== 'function') fail('registry', `${kind}: missing defaultSpec()`);
    if (!Array.isArray(def.aliases) || def.aliases.length === 0)
      fail('registry', `${kind}: missing CLI aliases`);
    if (!def.columns) fail('registry', `${kind}: missing oc get columns`);
  }

  const clusterScopedSet = new Set(registry.CLUSTER_SCOPED_KINDS || []);
  const missingScope = [...EXPECTED_CLUSTER_SCOPED].filter((k) => !clusterScopedSet.has(k));
  const extraScope = [...clusterScopedSet].filter((k) => !EXPECTED_CLUSTER_SCOPED.has(k));
  if (missingScope.length || extraScope.length) {
    fail(
      'registry',
      'cluster-scoped kind mismatch',
      `missing=${missingScope.join(',')} extra=${extraScope.join(',')}`
    );
  }
  if (JSON.stringify(registry.PLACEABLE_KINDS) !== JSON.stringify(EXPECTED_PLACEABLE)) {
    fail(
      'registry',
      'PLACEABLE_KINDS differs from the 37-kind spec set',
      JSON.stringify(registry.PLACEABLE_KINDS)
    );
  } else passed();
  const paletteKinds = (registry.PALETTE_SECTIONS || []).flatMap((s) => s.kinds || []);
  if (paletteKinds.length !== EXPECTED_PLACEABLE.length) {
    fail(
      'registry',
      `PALETTE_SECTIONS covers ${paletteKinds.length} kinds, expected ${EXPECTED_PLACEABLE.length}`
    );
  }
  for (const kind of EXPECTED_PLACEABLE) {
    const count = paletteKinds.filter((k) => k === kind).length;
    if (count !== 1)
      fail('registry', `PALETTE_SECTIONS must contain ${kind} exactly once (found ${count})`);
  }
  if (new Set(paletteKinds).size !== paletteKinds.length)
    fail('registry', 'PALETTE_SECTIONS contains duplicate kinds');
  if ((registry.PALETTE_SECTIONS || []).length !== 9)
    fail(
      'registry',
      `expected 9 palette sections, found ${(registry.PALETTE_SECTIONS || []).length}`
    );
  for (const section of registry.PALETTE_SECTIONS || []) {
    if (!section.label || !section.kinds?.length)
      fail('registry', `palette section ${section.id} missing label/kinds`);
  }

  // Mesh creators (tolerant of method shorthand and object properties).
  const meshSrc = read('js/rendering/ResourceMeshes.js');
  const start = meshSrc.indexOf('const CREATORS');
  const block = start >= 0 ? meshSrc.slice(start, meshSrc.indexOf('\n};', start) + 3) : meshSrc;
  const creators = new Set();
  for (const m of block.matchAll(/^\s{2}(['"]?)([A-Za-z0-9_]+)\1\s*[:(]/gm)) creators.add(m[2]);
  const missingMeshes = kinds.filter((k) => !creators.has(k));
  if (missingMeshes.length) fail('rendering', `no mesh creator for: ${missingMeshes.join(', ')}`);
  else passed();
  note(`Mesh creators: ${creators.size} registered for ${kinds.length} kinds`);

  const indexSrc = read('index.html');
  const indexRuntimePalette =
    indexSrc.includes('PALETTE_SECTIONS') && indexSrc.includes('data-resource');
  if (!indexRuntimePalette) {
    for (const kind of EXPECTED_PLACEABLE) {
      if (!indexSrc.includes(`data-resource="${kind}"`))
        fail('palette', `index.html palette missing data-resource="${kind}"`);
    }
  } else note('index.html palette: runtime-generated from PALETTE_SECTIONS');
  const drawSrc = read('draw.html');
  const drawRuntimePalette =
    drawSrc.includes('PALETTE_SECTIONS') && drawSrc.includes('data-resource=');
  if (!drawRuntimePalette) {
    for (const kind of EXPECTED_PLACEABLE) {
      if (!drawSrc.includes(`data-resource="${kind}"`))
        fail('palette', `draw.html palette missing data-resource="${kind}"`);
    }
  } else note('draw.html palette: runtime-generated from PALETTE_SECTIONS');

  // Factory behaviour: UID honouring + rich resource classes + correct apiVersion.
  try {
    const route = registry.createResource('Route', {
      name: 'verify-route',
      namespace: 'verify',
      spec: { host: 'verify.example.com' },
    });
    if (!route || route.kind !== 'Route')
      fail('registry', 'createResource("Route") did not return a Route resource');
    else {
      if (route.apiVersion !== 'route.openshift.io/v1')
        fail('registry', `createResource(Route).apiVersion=${route.apiVersion}`);
      if (route.metadata?.name !== 'verify-route')
        fail('registry', 'createResource did not apply metadata.name');
      if (typeof route.toYAML !== 'function' || typeof route.toDescribe !== 'function')
        fail(
          'registry',
          'createResource(Route) is not a rich resource (missing toYAML/toDescribe)'
        );
      else passed();
    }
    const project = registry.createResource('Project', {
      name: 'verify-project',
      metadata: { uid: 'draw-keep-uid' },
    });
    if (project.uid !== 'draw-keep-uid' && project.metadata?.uid !== 'draw-keep-uid') {
      fail('registry', 'createResource(Project) did not honour supplied metadata.uid');
    } else passed();
  } catch (err) {
    fail('registry', `createResource self-test threw: ${err.message}`);
  }
}

// ── 4. Default cluster state (project indicators / seeds) ──────────────────
const DEFAULT_PROJECTS = [
  'default',
  'openshift',
  'openshift-config',
  'openshift-operators',
  'openshift-ingress',
  'openshift-dns',
  'openshift-monitoring',
  'openshift-console',
  'openshift-authentication',
  'openshift-image-registry',
  'kube-system',
];
const CLUSTER_OPERATORS = [
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

const seedMod = await tryImport('js/engine/ClusterState.js');
if (seedMod?.ClusterState) {
  try {
    const cluster = new seedMod.ClusterState();
    const resources = cluster.getAllResources?.() || [];
    const byKind = (kind) => cluster.getByKind?.(kind) || [];
    if (resources.length < 45)
      fail('seed', `default cluster seeds ${resources.length} resources; expected 45+ (~50)`);
    else passed();

    const projects = byKind('Project').map((r) => r.metadata?.name);
    for (const name of DEFAULT_PROJECTS) {
      if (!projects.includes(name)) fail('seed', `default Project "${name}" is not seeded`);
    }
    if (projects.length < 10)
      fail('seed', `expected 11 default Projects, found ${projects.length}`);
    const activeProjects = byKind('Project').filter(
      (p) => (p.status?.phase || p.phase) === 'Active'
    ).length;
    if (activeProjects < DEFAULT_PROJECTS.length)
      fail('seed', `default Projects not Active (${activeProjects}/${DEFAULT_PROJECTS.length})`);

    // #53F: one machine-name catalog shared by every mode (worker-0/worker-1/
    // master-0); campaign levels, timed labs, sandbox and chaos all build Nodes
    // from it so `oc debug node/worker-0` muscle memory transfers.
    const hasLabel = (labels, key) => Object.prototype.hasOwnProperty.call(labels || {}, key);
    if (!Array.isArray(seedMod.NODE_CATALOG)) {
      fail('seed', 'ClusterState must export NODE_CATALOG (shared node naming, #53F)');
    } else {
      const catalogNames = seedMod.NODE_CATALOG.map((entry) => entry?.name);
      if (catalogNames.join(',') !== 'worker-0,worker-1,master-0') {
        fail(
          'seed',
          `NODE_CATALOG names ${catalogNames.join(',')} != worker-0,worker-1,master-0 (#53F)`
        );
      } else if (typeof seedMod.catalogNode !== 'function') {
        fail('seed', 'ClusterState must export catalogNode(index) (#53F)');
      } else {
        const worker0 = seedMod.catalogNode(0);
        const master0 = seedMod.catalogNode(2);
        const problems = [];
        if (worker0?.name !== 'worker-0') problems.push(`catalogNode(0)=${worker0?.name}`);
        if (!hasLabel(worker0?.labels, 'node-role.kubernetes.io/worker'))
          problems.push('worker-0 lacks node-role.kubernetes.io/worker');
        if (master0?.name !== 'master-0') problems.push(`catalogNode(2)=${master0?.name}`);
        if (!hasLabel(master0?.labels, 'node-role.kubernetes.io/control-plane'))
          problems.push('master-0 lacks node-role.kubernetes.io/control-plane');
        if (!hasLabel(master0?.labels, 'node-role.kubernetes.io/master'))
          problems.push('master-0 lacks the legacy node-role.kubernetes.io/master label');
        if (problems.length) fail('seed', `NODE_CATALOG contract: ${problems.join('; ')} (#53F)`);
        else passed();
      }
    }

    // #53G: openshift-config carries the real platform bootstrap Secrets, and
    // identity-provider Secrets stay absent until the labs create them.
    const configSecrets = byKind('Secret').filter(
      (secret) => (secret.metadata?.namespace || '') === 'openshift-config'
    );
    const configSecretNames = configSecrets.map((secret) => secret.metadata?.name);
    const pullSecret = configSecrets.find((secret) => secret.metadata?.name === 'pull-secret');
    const saKey = configSecrets.find(
      (secret) => secret.metadata?.name === 'initial-service-account-private-key'
    );
    const secretProblems = [];
    if (!pullSecret) secretProblems.push('openshift-config/pull-secret is not seeded');
    else if ((pullSecret.type || pullSecret.spec?.type) !== 'kubernetes.io/dockerconfigjson')
      secretProblems.push(
        `pull-secret type ${pullSecret.type || pullSecret.spec?.type} != kubernetes.io/dockerconfigjson`
      );
    if (!saKey) secretProblems.push('openshift-config/initial-service-account-private-key missing');
    else if ((saKey.type || saKey.spec?.type) !== 'Opaque')
      secretProblems.push(
        `initial-service-account-private-key type ${saKey.type || saKey.spec?.type} != Opaque`
      );
    if (configSecretNames.includes('htpass-secret'))
      secretProblems.push('htpass-secret must not be seeded (identity labs create it)');
    if (secretProblems.length)
      fail('seed', `openshift-config bootstrap Secrets: ${secretProblems.join('; ')} (#53G)`);
    else passed();

    const cos = byKind('ClusterOperator');
    if (cos.length < 13) fail('seed', `expected 13 ClusterOperators, found ${cos.length}`);
    for (const name of CLUSTER_OPERATORS) {
      const co = cos.find((c) => c.metadata?.name === name);
      if (!co) {
        fail('seed', `ClusterOperator "${name}" missing`);
        continue;
      }
      const cond = (type) => (co.status?.conditions || []).find((c) => c.type === type);
      if (cond('Available')?.status !== 'True')
        fail('seed', `ClusterOperator ${name}: Available != True`);
      if (cond('Progressing')?.status !== 'False')
        fail('seed', `ClusterOperator ${name}: Progressing != False`);
      if (cond('Degraded')?.status !== 'False')
        fail('seed', `ClusterOperator ${name}: Degraded != False`);
      const version = co.status?.versions?.[0]?.version || co.status?.version;
      if (version !== '4.22.0')
        fail('seed', `ClusterOperator ${name}: version ${version} != 4.22.0`);
    }

    const cv = byKind('ClusterVersion').find((r) => r.metadata?.name === 'version');
    if (!cv) fail('seed', 'ClusterVersion "version" missing');
    else {
      if (cv.spec?.channel !== 'stable-4.22')
        fail('seed', `ClusterVersion channel ${cv.spec?.channel} != stable-4.22`);
      if (cv.status?.desired?.version !== '4.22.0')
        fail('seed', `ClusterVersion desired.version ${cv.status?.desired?.version} != 4.22.0`);
    }

    const sccs = byKind('SecurityContextConstraints');
    for (const name of ['restricted-v2', 'nonroot-v2', 'anyuid', 'privileged']) {
      const scc = sccs.find((s) => s.metadata?.name === name);
      if (!scc) fail('seed', `SCC "${name}" missing`);
      else {
        const groups = scc.groups || scc.spec?.groups || [];
        if (
          ['restricted-v2', 'nonroot-v2'].includes(name) &&
          !groups.includes('system:authenticated')
        ) {
          fail('seed', `SCC ${name}: groups must include system:authenticated`);
        }
        // OCP 4.22 ships API-shaped default SCCs: `privileged` is granted to
        // system:admin / the build controller and to cluster-admins/nodes/masters,
        // while `anyuid` starts with no users (only system:cluster-admins).
        const users = scc.users || scc.spec?.users || [];
        if (name === 'anyuid' && users.length) fail('seed', 'SCC anyuid: must start with no users');
        if (name === 'privileged') {
          if (!(scc.allowPrivilegedContainer || scc.spec?.allowPrivilegedContainer))
            fail('seed', 'SCC privileged: allowPrivilegedContainer must be true');
          if (!users.includes('system:admin'))
            fail('seed', 'SCC privileged: real 4.22 default grants the system:admin user');
        }
      }
    }

    // Issue #48.3: kubeadmin is a virtual user on real 4.x and is never listed
    // by `oc get users`; the simulator's `admin` convenience account is virtual
    // too. Keep only the cluster-admin ClusterRoleBinding subject semantics.
    const users = byKind('User').map((u) => u.metadata?.name);
    if (users.length)
      fail(
        'seed',
        `fresh 4.22 cluster must not seed User resources (kubeadmin/admin are virtual): found ${users.join(', ')}`
      );
    const crbs = byKind('ClusterRoleBinding');
    const kubeadminBinding = crbs.find((b) => {
      const ref = b.roleRef || b.spec?.roleRef || {};
      const subjects = b.subjects || b.spec?.subjects || [];
      return ref.name === 'cluster-admin' && subjects.some((s) => s.name === 'kubeadmin');
    });
    if (!kubeadminBinding) fail('seed', 'kubeadmin is not bound to cluster-admin');

    const imageStreams = byKind('ImageStream').filter(
      (is) => (is.metadata?.namespace || is.namespace) === 'openshift'
    );
    const tagNames = (name) => {
      const is = imageStreams.find((i) => i.metadata?.name === name);
      return (is?.spec?.tags || is?.status?.tags || []).map((t) => t.name || t.tag);
    };
    for (const [name, tags] of [
      ['nodejs', ['20-ubi9', '22-ubi9']],
      ['python', ['3.12-ubi9']],
      ['nginx', ['1.26-ubi9']],
    ]) {
      if (!imageStreams.some((is) => is.metadata?.name === name))
        fail('seed', `ImageStream openshift/${name} missing`);
      for (const tag of tags) {
        if (!tagNames(name).includes(tag))
          fail('seed', `ImageStream openshift/${name}: tag ${tag} missing`);
      }
    }

    // A fresh OCP 4.22 cluster stores no project template; the template is
    // opt-in via `oc adm create-bootstrap-project-template` + project.config.
    const projectTemplates = byKind('Template').filter(
      (t) => (t.metadata?.namespace || '') === 'openshift-config'
    );
    if (projectTemplates.length)
      fail(
        'seed',
        `fresh cluster must not seed project templates in openshift-config (found ${projectTemplates.map((t) => t.metadata?.name).join(', ')})`
      );
    if (typeof cluster.getProjectConfig !== 'function')
      fail(
        'seed',
        'ClusterState.getProjectConfig() missing (project.config.openshift.io/cluster singleton)'
      );
    else {
      const projectConfig = cluster.getProjectConfig();
      if (
        projectConfig?.apiVersion !== 'config.openshift.io/v1' ||
        projectConfig?.kind !== 'Project' ||
        projectConfig?.metadata?.name !== 'cluster'
      ) {
        fail('seed', 'project.config.openshift.io/cluster singleton has the wrong shape');
      }
      if (typeof cluster.updateProjectConfig !== 'function')
        fail('seed', 'ClusterState.updateProjectConfig() missing');
    }

    if (typeof cluster.addResource !== 'function')
      fail('seed', 'ClusterState.addResource() missing');
    else {
      const probe = cluster.addResource({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'verify-uid-pod', namespace: 'default', uid: 'draw-verify-uid' },
        spec: {},
      });
      const gotUid = probe?.metadata?.uid || probe?.uid;
      if (gotUid !== 'draw-verify-uid')
        fail(
          'seed',
          'ClusterState.addResource() does not honour supplied metadata.uid (draw position bug)'
        );
      else passed();
    }
    note(
      `Cluster seed: ${resources.length} resources, ${projects.length} Projects, ${cos.length} ClusterOperators`
    );
  } catch (err) {
    fail('seed', `default ClusterState self-test threw: ${err.message}`);
  }
} else {
  fail('seed', 'js/engine/ClusterState.js is missing or not importable');
}

// ── 4b. Issue #50–#54 platform-fidelity locks (static) ────────────────────
// These lock the contracts the 1.4.0 QA fixes rely on so a future refactor
// cannot silently reintroduce the reported bugs. Behaviour is asserted in the
// browser suite section `qa-issue50-54`; these are cheap source/shape locks.
{
  const indexHtml = read('index.html');
  // #54: the landing stats copy must agree with the 13 timed labs everywhere
  // else (mode card, "Thirteen timed labs" copy, CHALLENGES length).
  if (/<strong>12<\/strong>\s*timed labs/.test(indexHtml))
    fail('fidelity', 'index.html landing stats still say 12 timed labs (#54)');
  else if (!/<strong>13<\/strong>\s*timed labs/.test(indexHtml))
    fail('fidelity', 'index.html landing stats do not say 13 timed labs (#54)');
  else passed();

  // #53F: no mode may invent its own legacy node names again.
  const legacyNodeOwners = [];
  for (const rel of [
    'js/modes/SandboxMode.js',
    'js/modes/ChaosMode.js',
    'js/modes/ChallengeMode.js',
  ]) {
    const src = read(rel);
    if (/sandbox-node-|chaos-node-|['"`]node-\$\{/.test(src)) legacyNodeOwners.push(rel);
  }
  if (legacyNodeOwners.length)
    fail('fidelity', `legacy node-name literals returned in ${legacyNodeOwners.join(', ')} (#53F)`);
  else passed();
  const challengeSrc = read('js/modes/ChallengeMode.js');
  const sandboxSrc = read('js/modes/SandboxMode.js');
  const chaosSrc = read('js/modes/ChaosMode.js');
  if (
    !/catalogNode/.test(challengeSrc) ||
    !/catalogNode/.test(sandboxSrc) ||
    !/catalogNode/.test(chaosSrc)
  )
    fail('fidelity', 'a mode stopped building Nodes from the shared catalogNode() (#53F)');
  else passed();

  // #54e: the kubelet event stream is engine-owned; no synthetic duplicate in
  // CommandBar and no Ready/PhaseChange kubelet reasons anywhere in the stream.
  const commandBarSrc = read('js/ui/CommandBar.js');
  const syntheticPodLifecycle = [
    /Successfully assigned \$\{podNamespace\}/,
    /reason:\s*'Pulling'/,
    /reason:\s*'Pulled'/,
    /reason:\s*'Ready'/,
  ].filter((pattern) => pattern.test(commandBarSrc));
  if (syntheticPodLifecycle.length)
    fail(
      'fidelity',
      `CommandBar still synthesizes pod lifecycle events (${syntheticPodLifecycle.join(', ')}) (#54e)`
    );
  else passed();
  for (const rel of ['js/engine/ClusterState.js', 'js/engine/SimulationTick.js']) {
    const src = read(rel);
    if (/recordEvent\([^)]*'PhaseChange'/.test(src))
      fail('fidelity', `${rel} still records a PhaseChange event (#54e)`);
    else passed();
  }
  const simulationTickSrc = read('js/engine/SimulationTick.js');
  if (/recordEvent\(\s*'Normal',\s*'Ready'/.test(simulationTickSrc))
    fail('fidelity', 'SimulationTick still records a Ready pod event (#54e)');
  else passed();
  for (const reason of ['Scheduled', 'Pulling', 'Pulled', 'Created', 'Started']) {
    if (!new RegExp(`['"]${reason}['"]`).test(simulationTickSrc))
      fail('fidelity', `SimulationTick no longer records the kubelet ${reason} event (#54e)`);
    else passed();
  }

  // #53G: platform workload pods are seeded by the simulation engine in every
  // mode (the namespace/Secret seeds live in ClusterState, checked above).
  for (const literal of [
    'openshift-dns',
    'openshift-ingress',
    'dns-default',
    'node-resolver',
    'router-default',
  ])
    if (!simulationTickSrc.includes(literal))
      fail('fidelity', `SimulationTick no longer seeds platform pods: missing "${literal}" (#53G)`);
    else passed();
}

// ── 4c. Issue #55–#56 platform/OLM/CLI fidelity locks (static) ────────────
// The browser suite section `qa-issue55-56` proves the behaviour end-to-end.
// These module/source locks fail the fast static gate if a future refactor
// silently reintroduces the #55/#56 bugs (no browser, no long sleeps).
{
  // #55A: Node construction derives the dedicated control-plane NoSchedule taint
  // from the master/control-plane role labels. Every creation path (modes,
  // campaign levels, manifests, saved games) funnels through this constructor,
  // so `oc adm taint …-` is the only way to remove it (the tick loop never
  // re-adds it). Worker Nodes must stay untainted.
  const clusterResourcesMod = await tryImport('js/resources/ClusterResources.js');
  if (typeof clusterResourcesMod?.Node !== 'function') {
    fail('fidelity', 'ClusterResources.js must export the Node class (#55A)');
  } else {
    try {
      const masterNode = new clusterResourcesMod.Node({
        name: 'master-0',
        labels: {
          'node-role.kubernetes.io/control-plane': '',
          'node-role.kubernetes.io/master': '',
          'kubernetes.io/hostname': 'master-0',
        },
      });
      const workerNode = new clusterResourcesMod.Node({
        name: 'worker-0',
        labels: {
          'node-role.kubernetes.io/worker': '',
          'kubernetes.io/hostname': 'worker-0',
        },
      });
      const masterTaints = (masterNode.spec?.taints || []).map(
        (taint) => `${taint.key}:${taint.effect}`
      );
      const workerTaints = workerNode.spec?.taints || [];
      if (
        masterTaints.includes('node-role.kubernetes.io/master:NoSchedule') &&
        workerTaints.length === 0
      )
        passed();
      else
        fail(
          'fidelity',
          `Node constructor control-plane taint contract (#55A): master=${JSON.stringify(masterTaints)} worker=${JSON.stringify(workerTaints)}`
        );
    } catch (err) {
      fail('fidelity', `Node constructor taint contract threw: ${err.message} (#55A)`);
    }
  }

  // #55A/#55B: build a sandbox cluster exactly like a mode launch does, then run
  // the synchronous platform seed — the paused pre-start {deployment, RS, DS,
  // pods} contract — and assert the real controller-owned graph. Seeding twice
  // and ticking must not churn or duplicate platform Pods.
  const platformEngineMod = await tryImport('js/engine/GameEngine.js');
  const platformSandboxMod = await tryImport('js/modes/SandboxMode.js');
  if (!platformEngineMod?.GameEngine || !platformSandboxMod?.SandboxMode) {
    fail('fidelity', 'GameEngine/SandboxMode are not importable for the #55 platform lock');
  } else {
    try {
      const engine = new platformEngineMod.GameEngine({ mode: 'sandbox' });
      new platformSandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      if (typeof simulation?.ensureOLMDefaultsSync !== 'function') {
        fail(
          'fidelity',
          'SimulationTick.ensureOLMDefaultsSync() synchronous platform seed hook is missing (#55)'
        );
      } else {
        simulation.ensureOLMDefaultsSync();
        const cluster = engine.cluster;
        const nodes = cluster.getByKind('Node') || [];
        const master = nodes.find((node) => node.metadata?.name === 'master-0');
        const workers = nodes.filter((node) => /^worker-\d+$/.test(node.metadata?.name || ''));
        const masterTaints = (master?.spec?.taints || []).map(
          (taint) => `${taint.key}:${taint.effect}`
        );
        if (
          masterTaints.includes('node-role.kubernetes.io/master:NoSchedule') &&
          workers.length > 0 &&
          workers.every((worker) => (worker.spec?.taints || []).length === 0)
        )
          passed();
        else
          fail(
            'fidelity',
            `sandbox Nodes must be master-tainted and worker-clean (#55A): master=${JSON.stringify(masterTaints)}`
          );
        const ingressPods = (
          cluster.getByKindAndNamespace('Pod', 'openshift-ingress') || []
        ).filter((pod) => /^router-default-/.test(pod.metadata?.name || ''));
        const ingressReplicaSets = (
          cluster.getByKindAndNamespace('ReplicaSet', 'openshift-ingress') || []
        ).filter((replicaSet) => /^router-default-/.test(replicaSet.metadata?.name || ''));
        const routerDeployment = cluster.getByName(
          'Deployment',
          'router-default',
          'openshift-ingress'
        );
        const routerHashes = new Set(
          ingressPods.map((pod) => pod.metadata?.labels?.['pod-template-hash'])
        );
        const routerReplicaSetName = ingressReplicaSets[0]?.metadata?.name;
        const routerGraphOk =
          Boolean(routerDeployment) &&
          routerDeployment.spec?.replicas === 2 &&
          ingressReplicaSets.length === 1 &&
          (ingressReplicaSets[0].metadata?.ownerReferences || []).some(
            (reference) => reference.kind === 'Deployment' && reference.name === 'router-default'
          ) &&
          ingressPods.length === 2 &&
          routerHashes.size === 1 &&
          Boolean([...routerHashes][0]) &&
          ingressPods.every((pod) =>
            (pod.metadata?.ownerReferences || []).some(
              (reference) =>
                reference.kind === 'ReplicaSet' && reference.name === routerReplicaSetName
            )
          );
        if (routerGraphOk) passed();
        else
          fail(
            'fidelity',
            `router-default controller graph missing (#55B): Deployment 2/2 → one ReplicaSet → two shared-hash owned Pods`
          );
        const dnsDaemonSet = cluster.getByName('DaemonSet', 'dns-default', 'openshift-dns');
        const resolverDaemonSet = cluster.getByName('DaemonSet', 'node-resolver', 'openshift-dns');
        const expectedNodes = nodes.length;
        const daemonSetStatusOk = [dnsDaemonSet, resolverDaemonSet].every(
          (daemonSet) =>
            daemonSet &&
            daemonSet.status?.desiredNumberScheduled === expectedNodes &&
            daemonSet.status?.currentNumberScheduled === expectedNodes &&
            daemonSet.status?.numberReady === expectedNodes
        );
        if (dnsDaemonSet && resolverDaemonSet && daemonSetStatusOk) passed();
        else
          fail(
            'fidelity',
            `dns DaemonSets must seed DESIRED/CURRENT/READY ${expectedNodes}/${expectedNodes}/${expectedNodes} (#55B)`
          );
        const dnsPods = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || []).filter(
          (pod) => /^dns-default-/.test(pod.metadata?.name || '')
        );
        const resolverPods = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || []).filter(
          (pod) => /^node-resolver-/.test(pod.metadata?.name || '')
        );
        const nodeNameSet = new Set(nodes.map((node) => node.metadata?.name));
        const onePodPerNodeOk =
          [dnsPods, resolverPods].every(
            (pods) =>
              pods.length === expectedNodes &&
              new Set(pods.map((pod) => pod.spec?.nodeName)).size === expectedNodes &&
              pods.every((pod) => nodeNameSet.has(pod.spec?.nodeName))
          ) &&
          dnsPods.every((pod) =>
            (pod.metadata?.ownerReferences || []).some(
              (reference) => reference.kind === 'DaemonSet' && reference.name === 'dns-default'
            )
          ) &&
          resolverPods.every((pod) =>
            (pod.metadata?.ownerReferences || []).some(
              (reference) => reference.kind === 'DaemonSet' && reference.name === 'node-resolver'
            )
          );
        if (onePodPerNodeOk) passed();
        else
          fail(
            'fidelity',
            `DNS DaemonSets must own exactly one pod per node (#55B): dns=${dnsPods.length} resolver=${resolverPods.length} nodes=${expectedNodes}`
          );
        const dnsPodShapeOk =
          dnsPods.length > 0 &&
          dnsPods.every((pod) => {
            const containers = (pod.spec?.containers || []).map((container) => container.name);
            const toleratesMaster = (pod.spec?.tolerations || []).some(
              (toleration) =>
                toleration.key === 'node-role.kubernetes.io/master' &&
                (!toleration.effect || toleration.effect === 'NoSchedule')
            );
            const readyContainers = (pod.status?.containerStatuses || []).filter(
              (status) => status.ready
            ).length;
            return (
              containers.includes('dns') &&
              containers.includes('kube-rbac-proxy') &&
              readyContainers === 2 &&
              toleratesMaster
            );
          });
        if (dnsPodShapeOk) passed();
        else
          fail(
            'fidelity',
            'dns-default pods must run dns + kube-rbac-proxy READY 2/2 and tolerate node-role.kubernetes.io/master:NoSchedule (#55A/#56)'
          );
        const platformPodNames = () =>
          [...ingressPods, ...dnsPods, ...resolverPods]
            .map((pod) => pod.metadata?.name || '')
            .sort();
        const beforeSeedAgain = platformPodNames();
        simulation.ensureOLMDefaultsSync();
        for (let tickIndex = 0; tickIndex < 200; tickIndex += 1) simulation.tick(0.05);
        const refreshPods = (namespace, pattern) =>
          (cluster.getByKindAndNamespace('Pod', namespace) || []).filter((pod) =>
            pattern.test(pod.metadata?.name || '')
          );
        const afterSeedAgain = [
          ...refreshPods('openshift-ingress', /^router-default-/),
          ...refreshPods('openshift-dns', /^dns-default-/),
          ...refreshPods('openshift-dns', /^node-resolver-/),
        ]
          .map((pod) => pod.metadata?.name || '')
          .sort();
        if (
          JSON.stringify(beforeSeedAgain) === JSON.stringify(afterSeedAgain) &&
          afterSeedAgain.length === 2 + expectedNodes * 2
        )
          passed();
        else
          fail(
            'fidelity',
            `platform seed is not idempotent — Pod churn/duplication (#55B): before=${JSON.stringify(beforeSeedAgain)} after=${JSON.stringify(afterSeedAgain)}`
          );
      }
    } catch (err) {
      fail('fidelity', `#55 sandbox platform-seed lock threw: ${err.message}`);
    }
  }

  // #56 OLM: the CSV replacement chain must be derived from the catalog
  // channel's ordered entries and applied on BOTH the initial-install and the
  // channel-upgrade paths (v1.17.0 → REPLACES v1.16.0, v1.16.0 → v1.15.0).
  const olmTickSrc = read('js/engine/SimulationTick.js');
  const olmResourceSrc = read('js/resources/OLMResources.js');
  const replacesAssignments = (olmTickSrc.match(/replaces:\s*this\._csvReplaces\(/g) || []).length;
  if (replacesAssignments >= 2 && /entries\[index \+ 1\]/.test(olmTickSrc)) {
    passed();
  } else {
    fail(
      'fidelity',
      `CSV replacement-chain wiring missing (#56): _csvReplaces assignments=${replacesAssignments}, channel-ordered entries lookup missing=${!/entries\[index \+ 1\]/.test(olmTickSrc)}`
    );
  }

  // #56 OLM: a channel upgrade applies the NEW CSV install strategy's pod
  // template to the existing operator Deployment, so the Deployment controller
  // rolls a new ReplicaSet/pod-template-hash.
  if (
    /_operatorDeploymentPodTemplate\s*\(/.test(olmTickSrc) &&
    /existing\.spec\.template\s*=\s*desiredTemplate/.test(olmTickSrc)
  ) {
    passed();
  } else {
    fail(
      'fidelity',
      'OLM upgrade does not apply the new CSV pod template to the operator Deployment (#56)'
    );
  }

  // #56 OLM: `oc describe csv` exposes the replacement graph.
  if (/(?:['"]Replaces['"]|Replaces:)/.test(olmResourceSrc)) passed();
  else fail('fidelity', 'CSV describe output does not expose the Replaces chain (#56)');

  // #56 CLI: multi-type `oc get …` prefixes the virtual Endpoints NAME cell
  // (`endpoints/<svc>`) while single-kind `oc get endpoints` stays plain.
  const cliLockSrc = read('js/ui/CommandBar.js');
  const multiKindEndpointsPrefixed =
    /_formatEndpointsObjects\(endpointsObjects, \{[\s\S]{0,400}?namePrefix:\s*multiKind/.test(
      cliLockSrc
    ) &&
    /_formatEndpointsObjects\(\s*endpointsObjects,\s*\{[^}]*namePrefix\s*=\s*false/.test(
      cliLockSrc
    ) &&
    /this\._singularName\('Endpoints'\)/.test(cliLockSrc);
  if (multiKindEndpointsPrefixed) passed();
  else
    fail(
      'fidelity',
      'multi-kind `oc get` does not prefix endpoints NAME with endpoints/<svc> (#56)'
    );

  // #56 CLI: the router's admission events/`oc status` must never invent a
  // "no endpoints available"/ServiceUnavailable rejection for an un-evaluated
  // Route; only a real Admitted condition produces an event row.
  const staleRouteFallback =
    /no endpoints available/.test(cliLockSrc) || /ServiceUnavailable/.test(cliLockSrc);
  if (!staleRouteFallback && /if \(!condition\) continue;/.test(cliLockSrc)) passed();
  else
    fail(
      'fidelity',
      'CommandBar still fabricates a "no endpoints available"/ServiceUnavailable route admission event (#56)'
    );
  if (
    /_routeAdmissionStatusText\s*\(resource\)/.test(cliLockSrc) &&
    /_routeAdmissionStatusText\(route\)/.test(cliLockSrc) &&
    !/_routeAdmissionStatusText[\s\S]{0,600}?endpoints/.test(cliLockSrc)
  )
    passed();
  else fail('fidelity', '`oc status` does not use the honest route admission wording (#56)');

  // #55A: `oc adm taint node <node> key:Effect-` must parse the optional
  // value/effect before removing the matching taint(s) (the old parser compared
  // the whole `key:Effect` string against `taint.key` and silently did nothing).
  if (
    /const removal = taintSpec\.slice\(0, -1\)/.test(cliLockSrc) &&
    /removal\.match\(/.test(cliLockSrc) &&
    !/const key = taintSpec\.slice\(0, -1\)/.test(cliLockSrc)
  ) {
    passed();
  } else {
    fail(
      'fidelity',
      '`oc adm taint …:Effect-` removal parser does not strip the value/effect before matching the taint key (#55A)'
    );
  }
}

// ── 4d. Issue #57–#58 scheduler/platform/CLI fidelity locks (static) ──────
// The browser suite section `qa-issue57-58` proves the behaviour end-to-end.
// These module/source locks fail the fast static gate if a future refactor
// silently reintroduces the #57/#58 bugs (no browser, no long sleeps).
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const templateHashMod = await tryImport('js/engine/TemplateHash.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !templateHashMod?.deploymentReplicaSetName
  ) {
    fail(
      'fidelity',
      'GameEngine/SandboxMode/CommandBar/TemplateHash are not importable for the #57/#58 locks'
    );
  } else {
    try {
      // Build a 3-node sandbox cluster exactly like a mode launch does. The
      // synchronous platform seed runs before any tick, so the paused
      // pre-start contract (platform Services present, no ReplicaSet for a
      // freshly created Deployment) is exercised deterministically.
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      const cluster = engine.cluster;
      const nodes = cluster.getByKind('Node') || [];

      // #57: an unscheduled Pending Pod prints its API phase (`Pending`) in the
      // `oc get pods` STATUS cell; ContainerCreating is only correct once the
      // Pod is bound to a node (kubelet state).
      const bar = new commandBarMod.CommandBar();
      const fakePod = (spec, status) => ({
        metadata: { name: 'big', namespace: 'default' },
        spec,
        status,
      });
      const pendingContainerStatus = {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'big',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ContainerCreating' } },
          },
        ],
      };
      const unscheduled = bar._podStatus(
        fakePod({ containers: [{ name: 'big', image: 'ubi' }] }, pendingContainerStatus)
      );
      const bound = bar._podStatus(
        fakePod(
          { nodeName: 'worker-0', containers: [{ name: 'big', image: 'ubi' }] },
          pendingContainerStatus
        )
      );
      if (
        unscheduled.ready === '0/1' &&
        unscheduled.status === 'Pending' &&
        bound.status === 'ContainerCreating'
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `_podStatus must report Pending before binding and ContainerCreating after (#57): ${JSON.stringify({ unscheduled, bound })}`
        );
      }

      // #58: the real platform Services must be seeded with the exact
      // ClusterIP/ports/selectors a 4.22 install carries, in every mode.
      const dnsService = cluster.getByName('Service', 'dns-default', 'openshift-dns');
      const routerService = cluster.getByName(
        'Service',
        'router-internal-default',
        'openshift-ingress'
      );
      // #62E: the 4.22 dns-default Service carries NAMED targetPorts
      // (`dns`/`dns-tcp` on the CoreDNS container, `metrics` on the
      // kube-rbac-proxy sidecar); the Service *ports* stay 53/UDP, 53/TCP,
      // 9154/TCP while EndpointSlice ports resolve to 5353/5353/9154.
      const expectedDnsPorts = [
        { name: 'dns', port: 53, protocol: 'UDP', targetPort: 'dns' },
        { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 'dns-tcp' },
        { name: 'metrics', port: 9154, protocol: 'TCP', targetPort: 'metrics' },
      ];
      const expectedRouterPorts = [
        { name: 'http', port: 80, protocol: 'TCP', targetPort: 80 },
        { name: 'https', port: 443, protocol: 'TCP', targetPort: 443 },
        { name: 'metrics', port: 1936, protocol: 'TCP', targetPort: 1936 },
      ];
      // #69 P4: the cluster-dns-operator's 4.22 dns-default asset additionally
      // carries spec.trafficDistribution: PreferSameNode (`oc describe svc`
      // prints it, and `-o jsonpath={.spec.trafficDistribution}` returns it).
      if (
        dnsService?.spec?.type === 'ClusterIP' &&
        dnsService.spec.clusterIP === '172.30.0.10' &&
        JSON.stringify(dnsService.spec.ports) === JSON.stringify(expectedDnsPorts) &&
        JSON.stringify(dnsService.spec.selector) ===
          JSON.stringify({ 'dns.operator.openshift.io/daemonset-dns': 'default' }) &&
        dnsService.spec.trafficDistribution === 'PreferSameNode'
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `openshift-dns/dns-default Service contract missing (#58): ${JSON.stringify({ type: dnsService?.spec?.type, clusterIP: dnsService?.spec?.clusterIP, ports: dnsService?.spec?.ports, selector: dnsService?.spec?.selector, trafficDistribution: dnsService?.spec?.trafficDistribution })}`
        );
      }
      if (
        routerService?.spec?.type === 'ClusterIP' &&
        /^172\.30\.\d+\.\d+$/.test(String(routerService.spec.clusterIP || '')) &&
        JSON.stringify(routerService.spec.ports) === JSON.stringify(expectedRouterPorts) &&
        JSON.stringify(routerService.spec.selector) ===
          JSON.stringify({
            'ingresscontroller.operator.openshift.io/deployment-ingresscontroller': 'default',
          })
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `openshift-ingress/router-internal-default Service contract missing (#58): ${JSON.stringify({ type: routerService?.spec?.type, clusterIP: routerService?.spec?.clusterIP, ports: routerService?.spec?.ports, selector: routerService?.spec?.selector })}`
        );
      }

      // #58: dns-default runs on the pod network (10.x, no hostNetwork) while
      // node-resolver keeps hostNetwork and reports the node InternalIP.
      const dnsPods = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || []).filter((pod) =>
        /^dns-default-/.test(pod.metadata?.name || '')
      );
      const resolverPods = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || []).filter(
        (pod) => /^node-resolver-/.test(pod.metadata?.name || '')
      );
      if (
        dnsPods.length === nodes.length &&
        dnsPods.every(
          (pod) =>
            pod.spec?.hostNetwork !== true &&
            // #62B: the OpenShift pod network is 10.128.0.0/14 (10.128–10.131).
            /^10\.(?:12[89]|13[01])\.\d+\.\d+$/.test(String(pod.status?.podIP || '')) &&
            pod.spec?.nodeSelector?.['kubernetes.io/os'] === 'linux' &&
            pod.metadata?.annotations?.['openshift.io/scc'] === 'restricted-v2'
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `dns-default Pods must run on the pod network (10.x, hostNetwork not set, restricted-v2, kubernetes.io/os=linux) (#58): ${JSON.stringify(dnsPods.map((pod) => ({ name: pod.metadata?.name, hostNetwork: pod.spec?.hostNetwork, podIP: pod.status?.podIP, nodeSelector: pod.spec?.nodeSelector, scc: pod.metadata?.annotations?.['openshift.io/scc'] })))}`
        );
      }
      if (
        resolverPods.length === nodes.length &&
        resolverPods.every(
          (pod) =>
            pod.spec?.hostNetwork === true &&
            pod.status?.podIP === pod.status?.hostIP &&
            !/^10\./.test(String(pod.status?.podIP || '')) &&
            pod.spec?.nodeSelector?.['kubernetes.io/os'] === 'linux' &&
            pod.metadata?.annotations?.['openshift.io/scc'] === 'hostnetwork'
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `node-resolver Pods must stay hostNetwork with the node IP (#58): ${JSON.stringify(resolverPods.map((pod) => ({ name: pod.metadata?.name, hostNetwork: pod.spec?.hostNetwork, podIP: pod.status?.podIP, hostIP: pod.status?.hostIP })))}`
        );
      }

      // #58: both DNS DaemonSet POD TEMPLATES carry the real nodeSelector shown
      // by the `NODE SELECTOR` column of `oc get ds -n openshift-dns`.
      const dnsDaemonSet = cluster.getByName('DaemonSet', 'dns-default', 'openshift-dns');
      const resolverDaemonSet = cluster.getByName('DaemonSet', 'node-resolver', 'openshift-dns');
      if (
        [dnsDaemonSet, resolverDaemonSet].every(
          (daemonSet) =>
            daemonSet?.spec?.template?.spec?.nodeSelector?.['kubernetes.io/os'] === 'linux'
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `DNS DaemonSet pod templates must carry nodeSelector kubernetes.io/os=linux (#58): ${JSON.stringify([dnsDaemonSet?.spec?.template?.spec?.nodeSelector, resolverDaemonSet?.spec?.template?.spec?.nodeSelector])}`
        );
      }

      // #58: router Pods carry the ingress controller label the documented
      // `oc delete pod -n openshift-ingress -l …` flow selects on.
      const routerPods = (cluster.getByKindAndNamespace('Pod', 'openshift-ingress') || []).filter(
        (pod) => /^router-default-/.test(pod.metadata?.name || '')
      );
      const ingressControllerLabel =
        'ingresscontroller.operator.openshift.io/deployment-ingresscontroller';
      if (
        routerPods.length === 2 &&
        routerPods.every(
          (pod) =>
            pod.metadata?.labels?.[ingressControllerLabel] === 'default' &&
            pod.spec?.hostNetwork === true &&
            pod.status?.podIP === pod.status?.hostIP
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `router Pods must carry ${ingressControllerLabel}=default and stay hostNetwork (#58): ${JSON.stringify(routerPods.map((pod) => ({ name: pod.metadata?.name, labels: pod.metadata?.labels, hostNetwork: pod.spec?.hostNetwork })))}`
        );
      }

      // #58: a controller-recreated hostNetwork Pod reports the node InternalIP
      // as its Pod IP (real kubelet semantics) — deleting a bootstrap router Pod
      // and ticking lets the Deployment controller recreate it, and the new Pod
      // must match the bootstrap Pods' `-o wide` output instead of a fabricated
      // pod-network address.
      const routerNamesBefore = routerPods.map((pod) => pod.metadata?.name || '');
      const victimRouterPod = routerPods[0];
      if (victimRouterPod) cluster.remove(victimRouterPod.uid);
      for (let tickIndex = 0; tickIndex < 40; tickIndex += 1) simulation.tick(0.05);
      const routerPodsAfter = (
        cluster.getByKindAndNamespace('Pod', 'openshift-ingress') || []
      ).filter((pod) => /^router-default-/.test(pod.metadata?.name || ''));
      const recreatedRouterPod = routerPodsAfter.find(
        (pod) => !routerNamesBefore.includes(pod.metadata?.name || '')
      );
      const recreatedRouterNode = recreatedRouterPod
        ? cluster.getByName('Node', recreatedRouterPod.spec?.nodeName || '', '')
        : null;
      const recreatedRouterNodeIP =
        (recreatedRouterNode?.status?.addresses || []).find(
          (address) => address.type === 'InternalIP'
        )?.address || '';
      if (
        routerPodsAfter.length === 2 &&
        recreatedRouterPod?.spec?.hostNetwork === true &&
        recreatedRouterNodeIP !== '' &&
        recreatedRouterPod.status?.podIP === recreatedRouterNodeIP
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `controller-recreated hostNetwork router Pod must report the node IP as its podIP (#58): ${JSON.stringify({ before: routerNamesBefore, after: routerPodsAfter.map((pod) => ({ name: pod.metadata?.name, hostNetwork: pod.spec?.hostNetwork, podIP: pod.status?.podIP, node: pod.spec?.nodeName, hostIP: pod.status?.hostIP })), recreatedRouterPod: recreatedRouterPod?.metadata?.name, recreatedRouterNodeIP })}`
        );
      }

      // #57: the scheduler retries FailedScheduling with the real exponential
      // backoff (1 s initial, doubling, 10 s max) instead of one Event per tick;
      // the aggregated series keeps a small count and preserves firstTimestamp.
      const simulationSrc = read('js/engine/SimulationTick.js');
      const hasBackoffConstants =
        /SCHEDULER_INITIAL_BACKOFF_SECONDS\s*=\s*1\b/.test(simulationSrc) &&
        /SCHEDULER_MAX_BACKOFF_SECONDS\s*=\s*10\b/.test(simulationSrc);
      const hasBackoffGating =
        /_schedulerBackoffPending\(\s*pod\s*\)/.test(simulationSrc) &&
        /_recordSchedulingFailure\(\s*pod,/.test(simulationSrc) &&
        /pod\.recordEvent\('Warning', 'FailedScheduling'/.test(simulationSrc);
      if (hasBackoffConstants && hasBackoffGating) {
        passed();
      } else {
        fail(
          'fidelity',
          `scheduler retry backoff constants/gating missing (#57): constants=${hasBackoffConstants} gating=${hasBackoffGating}`
        );
      }
      const unschedulablePod = cluster.addResource({
        kind: 'Pod',
        apiVersion: 'v1',
        metadata: { name: 'qa57-big', namespace: 'default', labels: { app: 'qa57-big' } },
        spec: {
          containers: [
            {
              name: 'qa57-big',
              image: 'registry.access.redhat.com/ubi9/ubi',
              resources: { requests: { cpu: '64' } },
            },
          ],
        },
      });
      if (!unschedulablePod) {
        fail('fidelity', 'could not add the unschedulable Pod for the #57 backoff lock');
      } else {
        simulation.tick(0.05);
        const firstFailedScheduling = unschedulablePod
          .getEvents?.()
          .find((event) => event.reason === 'FailedScheduling');
        const firstTimestamp = firstFailedScheduling?.firstTimestamp;
        for (let tickIndex = 0; tickIndex < 219; tickIndex += 1) simulation.tick(0.05);
        const failedEvents =
          unschedulablePod.getEvents?.().filter((event) => event.reason === 'FailedScheduling') ||
          [];
        const failedEvent = failedEvents[0];
        const firstTimestampPreserved =
          Boolean(firstTimestamp) &&
          failedEvent?.firstTimestamp === firstTimestamp &&
          String(failedEvent?.firstTimestamp) <= String(failedEvent?.lastTimestamp);
        if (
          failedEvents.length === 1 &&
          failedEvent.count > 1 &&
          failedEvent.count <= 20 &&
          firstTimestampPreserved
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `FailedScheduling series over 11 s must aggregate small and preserve firstTimestamp (#57): ${JSON.stringify(failedEvents.map((event) => ({ count: event.count, firstTimestamp: event.firstTimestamp, lastTimestamp: event.lastTimestamp })))}`
          );
        }
      }

      // CommandBar locks need the `window.game` integration surface the app
      // wires in the browser; provide the minimum shim around the real engine.
      globalThis.window = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
        },
      };
      try {
        const cliBar = new commandBarMod.CommandBar();
        // #58: `/etc/resolv.conf` inside a Pod names the seeded cluster DNS
        // Service, exactly what `oc exec <pod> -- cat /etc/resolv.conf` prints.
        const execContext = cliBar._podExecContext(
          {
            metadata: { name: 'shell57', namespace: 'default' },
            spec: { containers: [{ name: 'shell57', image: 'ubi' }], volumes: [] },
            status: { phase: 'Running' },
          },
          'shell57'
        );
        const resolvConf = String(execContext?.files?.get('/etc/resolv.conf') || '');
        if (
          /nameserver 172\.30\.0\.10/.test(resolvConf) &&
          /search default\.svc\.cluster\.local svc\.cluster\.local cluster\.local/.test(
            resolvConf
          ) &&
          /options ndots:5/.test(resolvConf)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `CommandBar _podExecContext /etc/resolv.conf contract missing (#58): ${JSON.stringify(resolvConf)}`
          );
        }

        // #58: `oc adm taint` accepts kubectl's empty-value `key=:Effect`
        // grammar, and the real removal forms keep working. The engine cluster
        // is local to this lock, so the mutations are restored at the end.
        const addEmptyValue = cliBar._admNodeAction('taint', [
          'node',
          'master-0',
          `${'node-role.kubernetes.io/master'}=:NoSchedule`,
        ]);
        const masterAfterAdd = cluster.getByName('Node', 'master-0', '');
        const addOk =
          !addEmptyValue?.error &&
          (masterAfterAdd?.spec?.taints || []).filter(
            (taint) => taint.key === 'node-role.kubernetes.io/master'
          ).length === 1 &&
          (masterAfterAdd?.spec?.taints || []).some(
            (taint) =>
              taint.key === 'node-role.kubernetes.io/master' &&
              taint.value === '' &&
              taint.effect === 'NoSchedule'
          );
        const removeKeyEffect = cliBar._admNodeAction('taint', [
          'node',
          'master-0',
          'node-role.kubernetes.io/master:NoSchedule-',
        ]);
        const masterAfterRemove = cluster.getByName('Node', 'master-0', '');
        const removeOk =
          !removeKeyEffect?.error &&
          (masterAfterRemove?.spec?.taints || []).every(
            (taint) => taint.key !== 'node-role.kubernetes.io/master'
          );
        cliBar._admNodeAction('taint', ['node', 'worker-0', 'dedicated=special:NoSchedule']);
        const removeValueEffect = cliBar._admNodeAction('taint', [
          'node',
          'worker-0',
          'dedicated=special:NoSchedule-',
        ]);
        cliBar._admNodeAction('taint', ['node', 'worker-0', 'dedicated=:NoSchedule']);
        const removeKey = cliBar._admNodeAction('taint', ['node', 'worker-0', 'dedicated-']);
        const workerAfterRemove = cluster.getByName('Node', 'worker-0', '');
        const removalFormsOk =
          !removeValueEffect?.error &&
          !removeKey?.error &&
          (workerAfterRemove?.spec?.taints || []).every((taint) => taint.key !== 'dedicated');
        const invalidEffect = cliBar._admNodeAction('taint', [
          'node',
          'worker-0',
          'dedicated=:Bogus',
        ]);
        const invalidEffectOk =
          Boolean(invalidEffect?.error) &&
          /invalid taint effect: Bogus, unsupported taint effect/.test(invalidEffect.message);
        // Restore the seeded control-plane taint (the removal form above
        // intentionally removed it).
        cliBar._admNodeAction('taint', [
          'node',
          'master-0',
          'node-role.kubernetes.io/master=:NoSchedule',
        ]);
        if (addOk && removeOk && removalFormsOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `oc adm taint empty-value grammar/removal forms missing (#58): ${JSON.stringify({ addEmptyValue, addOk, removeKeyEffect, removeOk, removeValueEffect, removeKey, removalFormsOk })}`
          );
        }
        if (invalidEffectOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `oc adm taint must reject unknown effects like real oc (#58): ${JSON.stringify(invalidEffect)}`
          );
        }

        // #58: in a paused pre-start cluster there is no ReplicaSet yet, so the
        // synthetic Deployment ScalingReplicaSet event must predict the exact
        // `<deployment>-<pod-template-hash>` name the controller will create.
        const newAppCommand = cliBar.executeCommand(
          'oc new-app --name=pre58 --image=quay.io/openshift/origin-hello-openshift:latest -n default'
        );
        const preDeployment = cluster.getByName('Deployment', 'pre58', 'default');
        const predictedReplicaSetName = preDeployment
          ? templateHashMod.deploymentReplicaSetName(preDeployment)
          : null;
        const scalingEvents = cliBar
          ._syntheticEvents({ namespace: 'default' })
          .filter(
            (event) => event.reason === 'ScalingReplicaSet' && event.object === 'deployment/pre58'
          );
        const predictedNameOk =
          Boolean(predictedReplicaSetName) &&
          new RegExp(`^pre58-[${templateHashMod.RAND_SAFE_ALPHABET}]{10}$`).test(
            predictedReplicaSetName
          ) &&
          scalingEvents.length === 1 &&
          String(scalingEvents[0]?.message || '').includes(
            `replica set ${predictedReplicaSetName} to `
          ) &&
          !newAppCommand?.error;
        if (predictedNameOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `paused oc new-app ScalingReplicaSet must use the deterministic template-hash ReplicaSet name (#58): ${JSON.stringify({ command: newAppCommand?.message, predictedReplicaSetName, events: scalingEvents.map((event) => event.message) })}`
          );
        }
        simulation.tick(0.05);
        simulation.tick(0.05);
        if (
          predictedReplicaSetName &&
          cluster.getByName('ReplicaSet', predictedReplicaSetName, 'default')
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `the Deployment controller must create the predicted ReplicaSet ${predictedReplicaSetName} after the paused cluster starts (#58)`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#57/#58 dynamic fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4e. Issue #59–#60 Service/CLI fidelity locks (static) ────────────────
// The browser suite section `qa-issue59-60` proves the behaviour end-to-end.
// These module/source locks fail the fast static gate if a future refactor
// silently reintroduces the #59/#60 bugs (no browser, no long sleeps).
{
  const netMod = await tryImport('js/resources/NetworkResources.js');
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const workloadMod = await tryImport('js/resources/WorkloadResources.js');
  if (
    !netMod?.Service ||
    typeof netMod.formatEndpointAddresses !== 'function' ||
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !workloadMod?.Pod
  ) {
    fail(
      'fidelity',
      'NetworkResources/GameEngine/SandboxMode/CommandBar/WorkloadResources are not importable for the #59/#60 locks'
    );
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      const cluster = engine.cluster;

      /** Per-port groups of `oc describe svc` (Port:/TargetPort:/Endpoints:). */
      const describeServicePorts = (text) => {
        const rows = [];
        let current = null;
        for (const line of String(text ?? '').split('\n')) {
          if (/^Port:\s/.test(line)) {
            current = {
              portLine: line.replace(/\s+/g, ' ').trim(),
              targetPort: '',
              endpoints: '',
            };
            rows.push(current);
            continue;
          }
          if (!current) continue;
          if (/^TargetPort:\s/.test(line)) {
            current.targetPort = line.replace(/^TargetPort:\s*/, '').trim();
          } else if (/^Endpoints:\s/.test(line)) {
            current.endpoints = line.replace(/^Endpoints:\s*/, '').trim();
          }
        }
        return rows;
      };

      // #59: the Service class must build the API-server shape even when the
      // caller supplies only a name/ports (palette, manifest panel, expose);
      // ExternalName Services never get ClusterIP fields.
      const constructedService = new netMod.Service({
        name: 'qa59-constructed',
        namespace: 'default',
        ports: [{ port: 8080 }],
      });
      const constructedSpec = constructedService.spec || {};
      const constructedPort = (constructedSpec.ports || [])[0] || {};
      const externalNameService = new netMod.Service({
        name: 'qa59-external',
        namespace: 'default',
        serviceType: 'ExternalName',
        externalName: 'example.com',
      });
      const externalSpec = externalNameService.spec || {};
      if (
        constructedSpec.type === 'ClusterIP' &&
        /^172\.30\.\d+\.\d+$/.test(String(constructedSpec.clusterIP || '')) &&
        JSON.stringify(constructedSpec.clusterIPs) ===
          JSON.stringify([constructedSpec.clusterIP]) &&
        JSON.stringify(constructedSpec.ipFamilies) === JSON.stringify(['IPv4']) &&
        constructedSpec.ipFamilyPolicy === 'SingleStack' &&
        constructedSpec.sessionAffinity === 'None' &&
        constructedSpec.internalTrafficPolicy === 'Cluster' &&
        constructedPort.protocol === 'TCP' &&
        Number(constructedPort.targetPort) === 8080 &&
        externalSpec.type === 'ExternalName' &&
        externalSpec.externalName === 'example.com' &&
        externalSpec.clusterIP === undefined &&
        externalSpec.clusterIPs === undefined &&
        externalSpec.ipFamilies === undefined
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `Service constructor must default clusterIP/clusterIPs/ipFamilies/ipFamilyPolicy/sessionAffinity/internalTrafficPolicy and port protocol/targetPort, while ExternalName stays ClusterIP-free (#59): ${JSON.stringify({ constructedSpec, externalSpec })}`
        );
      }

      // #59: manifest upserts (oc apply/create -f) go through the same API
      // defaulting and are idempotent.
      const serviceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'qa59-applied', namespace: 'default' },
        spec: { selector: { app: 'qa59-applied' }, ports: [{ port: 8080 }] },
      };
      const appliedService = engine.applyManifestObject(
        JSON.parse(JSON.stringify(serviceManifest))
      );
      const appliedSpec = appliedService?.spec || {};
      const appliedPort = (appliedSpec.ports || [])[0] || {};
      if (
        appliedService?._applyAction === 'created' &&
        /^172\.30\.\d+\.\d+$/.test(String(appliedSpec.clusterIP || '')) &&
        JSON.stringify(appliedSpec.clusterIPs) === JSON.stringify([appliedSpec.clusterIP]) &&
        JSON.stringify(appliedSpec.ipFamilies) === JSON.stringify(['IPv4']) &&
        appliedSpec.ipFamilyPolicy === 'SingleStack' &&
        appliedSpec.sessionAffinity === 'None' &&
        appliedSpec.internalTrafficPolicy === 'Cluster' &&
        appliedPort.protocol === 'TCP' &&
        Number(appliedPort.targetPort) === 8080
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `GameEngine.applyManifestObject must default a created Service like the API server (#59): ${JSON.stringify({ action: appliedService?._applyAction, spec: appliedSpec })}`
        );
      }
      const reappliedService = engine.applyManifestObject(
        JSON.parse(JSON.stringify(serviceManifest))
      );
      if (
        reappliedService?._applyAction === 'unchanged' &&
        reappliedService?.spec?.clusterIP === appliedSpec.clusterIP &&
        reappliedService?.metadata?.generation === appliedService?.metadata?.generation
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `re-applying the same Service manifest must be unchanged and keep the ClusterIP (#59): ${JSON.stringify({ action: reappliedService?._applyAction, clusterIP: reappliedService?.spec?.clusterIP, generation: reappliedService?.metadata?.generation })}`
        );
      }

      // #59: applying an updated manifest that omits spec.clusterIP preserves
      // the ClusterIP the API server allocated on create.
      const updatedServiceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: 'qa59-applied',
          namespace: 'default',
          labels: { qa59: 'updated' },
        },
        spec: { selector: { app: 'qa59-updated' }, ports: [{ port: 8080 }] },
      };
      const updatedService = engine.applyManifestObject(
        JSON.parse(JSON.stringify(updatedServiceManifest))
      );
      if (
        updatedService?._applyAction === 'updated' &&
        updatedService?.spec?.clusterIP === appliedSpec.clusterIP &&
        JSON.stringify(updatedService?.spec?.clusterIPs) ===
          JSON.stringify([appliedSpec.clusterIP]) &&
        JSON.stringify(updatedService?.spec?.selector) === JSON.stringify({ app: 'qa59-updated' })
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `applying an updated Service manifest without spec.clusterIP must preserve the allocated ClusterIP (#59): ${JSON.stringify({ action: updatedService?._applyAction, spec: updatedService?.spec })}`
        );
      }

      // #60: the shared Endpoints formatter prints at most 3 pairs and then
      // ` + N more...`, `<none>` when there are no addresses.
      const endpointPairs = Array.from({ length: 9 }, (_, index) => `10.0.0.${index + 1}:8080`);
      const formattedNine = netMod.formatEndpointAddresses(endpointPairs);
      const formattedThree = netMod.formatEndpointAddresses(endpointPairs.slice(0, 3));
      const formattedSix = netMod.formatEndpointAddresses(endpointPairs.slice(0, 6));
      const formattedNone = netMod.formatEndpointAddresses([]);
      const formattedUndefined = netMod.formatEndpointAddresses(undefined);
      if (
        formattedNine === `${endpointPairs.slice(0, 3).join(',')} + 6 more...` &&
        formattedThree === endpointPairs.slice(0, 3).join(',') &&
        !/more\.\.\./.test(formattedThree) &&
        formattedSix === `${endpointPairs.slice(0, 3).join(',')} + 3 more...` &&
        formattedNone === '<none>' &&
        formattedUndefined === '<none>'
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `formatEndpointAddresses must truncate like kubectl's formatEndpoints (#60): ${JSON.stringify({ formattedNine, formattedThree, formattedSix, formattedNone, formattedUndefined })}`
        );
      }

      // #59/#60: Service.status carries ONLY the LoadBalancer subresource after
      // ticks (no phase/conditions/observedGeneration/endpoint counters) and
      // the instance endpoints stay in sync with getServiceEndpoints.
      for (let tickIndex = 0; tickIndex < 20; tickIndex += 1) simulation.tick(0.05);
      const dnsService = cluster.getByName('Service', 'dns-default', 'openshift-dns');
      const dnsStatusKeys = Object.keys(dnsService?.status || {}).sort();
      const canonicalDnsEndpoints = cluster.getServiceEndpoints(dnsService);
      const dnsEndpointIPs = (dnsService?.endpoints || []).map((entry) => entry.ip).sort();
      const canonicalEndpointIPs = canonicalDnsEndpoints.map((pod) => pod.status?.podIP).sort();
      if (
        JSON.stringify(dnsStatusKeys) === JSON.stringify(['loadBalancer']) &&
        dnsService?.status?.readyEndpoints === undefined &&
        dnsService?.status?.totalEndpoints === undefined &&
        dnsService?.status?.endpoints === undefined &&
        dnsEndpointIPs.length === canonicalEndpointIPs.length &&
        JSON.stringify(dnsEndpointIPs) === JSON.stringify(canonicalEndpointIPs)
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `Service status must only contain loadBalancer after ticks while service.endpoints mirrors getServiceEndpoints (#59/#60): ${JSON.stringify({ status: dnsService?.status, dnsEndpointIPs, canonicalEndpointIPs })}`
        );
      }

      // #59: `oc describe svc dns-default` prints the real per-port kubectl
      // blocks with the canonical ready endpoints.
      const dnsDescribe = dnsService?.toDescribe({ cluster }) || '';
      const dnsPortRows = describeServicePorts(dnsDescribe);
      const dnsExpectedPorts = [
        { portLine: 'Port: dns 53/UDP', targetPrefix: 'dns/UDP', endpointPort: '5353' },
        { portLine: 'Port: dns-tcp 53/TCP', targetPrefix: 'dns-tcp/TCP', endpointPort: '5353' },
        { portLine: 'Port: metrics 9154/TCP', targetPrefix: 'metrics/TCP', endpointPort: '9154' },
      ];
      const dnsPodIPs = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || [])
        .filter((pod) => /^dns-default-/.test(pod.metadata?.name || ''))
        .map((pod) => pod.status?.podIP)
        .filter(Boolean);
      const dnsDescribeOk =
        /^IP:\s+172\.30\.0\.10\s*$/m.test(dnsDescribe) &&
        /^IPs:\s+172\.30\.0\.10\s*$/m.test(dnsDescribe) &&
        /^IP Family Policy:\s+SingleStack\s*$/m.test(dnsDescribe) &&
        /^IP Families:\s+IPv4\s*$/m.test(dnsDescribe) &&
        /^Session Affinity:\s+None\s*$/m.test(dnsDescribe) &&
        !/\bundefined\b/.test(dnsDescribe) &&
        dnsPortRows.length === dnsExpectedPorts.length &&
        dnsExpectedPorts.every((expected, index) => {
          const portRow = dnsPortRows[index];
          const pairs = String(portRow.endpoints || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
          return (
            portRow.portLine === expected.portLine &&
            String(portRow.targetPort).startsWith(expected.targetPrefix) &&
            pairs.length === dnsPodIPs.length &&
            pairs.every((pair) => {
              const match = pair.match(/^(10\.\d+\.\d+\.\d+):(\d+)$/);
              return (
                Boolean(match) && dnsPodIPs.includes(match[1]) && match[2] === expected.endpointPort
              );
            })
          );
        });
      if (dnsDescribeOk) {
        passed();
      } else {
        fail(
          'fidelity',
          `Service.toDescribe must print the real per-port describe-svc shape for openshift-dns/dns-default (#59): ${JSON.stringify({ dnsPortRows, dnsPodIPs, excerpt: dnsDescribe.slice(0, 1600) })}`
        );
      }

      // #59: an unnamed Service port describes as `Port: <unset> port/proto`.
      const unnamedService = engine.applyManifestObject({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'qa59-unnamed', namespace: 'default' },
        spec: { selector: { app: 'qa59-unnamed' }, ports: [{ port: 8080 }] },
      });
      const unnamedDescribe = unnamedService?.toDescribe({ cluster }) || '';
      const unnamedPortRows = describeServicePorts(unnamedDescribe);
      if (
        unnamedPortRows.length === 1 &&
        unnamedPortRows[0].portLine === 'Port: <unset> 8080/TCP' &&
        unnamedPortRows[0].targetPort === '8080/TCP' &&
        /^IP Family Policy:\s+SingleStack\s*$/m.test(unnamedDescribe) &&
        /^IP Families:\s+IPv4\s*$/m.test(unnamedDescribe) &&
        /^Session Affinity:\s+None\s*$/m.test(unnamedDescribe) &&
        !/\bundefined\b/.test(unnamedDescribe)
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `an unnamed Service port must describe as "Port: <unset> 8080/TCP" with IP Family Policy/IPs/Session Affinity and no undefined (#59): ${JSON.stringify({ unnamedPortRows, excerpt: unnamedDescribe.slice(0, 900) })}`
        );
      }

      // #60: an unscheduled/unbound Pod has no kubelet container status, so
      // describe must not print Container ID/Image ID/State/Ready/Restart Count.
      const unscheduledPod = new workloadMod.Pod({
        name: 'qa60-unscheduled',
        namespace: 'default',
        containers: [{ name: 'ubi', image: 'registry.access.redhat.com/ubi9/ubi' }],
      });
      const unscheduledDescribe = unscheduledPod.toDescribe({ cluster });
      const kubeletOnlyLines = [
        /^\s*Container ID:/m,
        /^\s*Image ID:/m,
        /^\s*State:/m,
        /^\s*Ready:/m,
        /^\s*Restart Count:/m,
      ];
      const presentKubeletLines = kubeletOnlyLines.filter((pattern) =>
        pattern.test(unscheduledDescribe)
      ).length;
      if (
        presentKubeletLines === 0 &&
        /^\s+Image:\s+registry\.access\.redhat\.com\/ubi9\/ubi\s*$/m.test(unscheduledDescribe) &&
        /^\s+Port:/m.test(unscheduledDescribe) &&
        /^\s+Host Port:/m.test(unscheduledDescribe) &&
        /^\s+Environment:/m.test(unscheduledDescribe)
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `Pod.toDescribe for an unbound Pod must omit kubelet-only Container ID/Image ID/State/Ready/Restart Count lines but keep Image/Port/Host Port/Environment (#60): ${JSON.stringify({ presentKubeletLines, excerpt: unscheduledDescribe.slice(0, 900) })}`
        );
      }

      // #60: a bound/running Pod keeps the kubelet status block.
      const runningPod = new workloadMod.Pod({
        name: 'qa60-running',
        namespace: 'default',
        nodeName: 'worker-0',
        containers: [{ name: 'ubi', image: 'registry.access.redhat.com/ubi9/ubi' }],
      });
      runningPod.status.phase = 'Running';
      runningPod.status.containerStatuses = [
        {
          name: 'ubi',
          image: 'registry.access.redhat.com/ubi9/ubi',
          imageID: `docker://sha256:${'a'.repeat(64)}`,
          containerID: `cri-o://${'b'.repeat(64)}`,
          ready: true,
          started: true,
          restartCount: 0,
          state: { running: { startedAt: new Date().toISOString() } },
          lastState: {},
        },
      ];
      const runningDescribe = runningPod.toDescribe({ cluster });
      if (
        /^\s*State:\s+Running\s*$/m.test(runningDescribe) &&
        /^\s*Ready:\s+True\s*$/m.test(runningDescribe) &&
        /^\s*Restart Count:\s+0\s*$/m.test(runningDescribe) &&
        /^\s*Container ID:\s+cri-o:\/\//m.test(runningDescribe) &&
        /^\s*Image ID:\s+docker:\/\/sha256:/m.test(runningDescribe)
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `Pod.toDescribe for a bound/running Pod must keep State Running/Ready True/Restart Count 0 and the container/image IDs (#60): ${JSON.stringify({ excerpt: runningDescribe.slice(0, 900) })}`
        );
      }

      // CommandBar behaviour locks need the `window.game` integration surface
      // the app wires in the browser; provide the minimum shim around the
      // real sandbox engine (mirrors the #57/#58 lock above).
      globalThis.window = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
        },
      };
      try {
        const cliBar = new commandBarMod.CommandBar();
        const parseTable = (message) => {
          const lines = String(message ?? '')
            .split('\n')
            .filter((line) => line.trim() !== '');
          return {
            headers: (lines[0] || '').split(/\s{2,}/).map((cell) => cell.trim()),
            rows: lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim())),
          };
        };

        // #60: `oc get endpoints` truncates the ENDPOINTS cell like kubectl.
        const endpointsResult = cliBar.executeCommand('oc get endpoints -n openshift-dns');
        const endpointsTable = parseTable(endpointsResult?.message);
        const endpointsAt = endpointsTable.headers.indexOf('ENDPOINTS');
        const dnsEndpointsRow =
          endpointsTable.rows.find((cells) => cells[0] === 'dns-default') || [];
        const endpointsCell = endpointsAt >= 0 ? dnsEndpointsRow[endpointsAt] || '' : '';
        const endpointsTruncation = endpointsCell.match(/^(.*?) \+ (\d+) more\.\.\.$/);
        const listedEndpointPairs = (endpointsTruncation ? endpointsTruncation[1] : endpointsCell)
          .split(',')
          .filter(Boolean);
        if (
          !endpointsResult?.error &&
          endpointsTruncation?.[2] === '6' &&
          listedEndpointPairs.length === 3 &&
          listedEndpointPairs.every((pair) => /^10\.\d+\.\d+\.\d+:\d+$/.test(pair))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `CommandBar \`oc get endpoints -n openshift-dns\` must print 3 pairs + " + 6 more..." (#60): ${JSON.stringify({ headers: endpointsTable.headers, endpointsCell, listedEndpointPairs })}`
          );
        }

        // #60: RoleBinding/ClusterRoleBinding ROLE prints roleRef.kind/name.
        const newProjectResult = cliBar.executeCommand('oc new-project qa59-locks');
        const roleBindingResult = cliBar.executeCommand('oc get rolebinding -n qa59-locks');
        const roleBindingTable = parseTable(roleBindingResult?.message);
        const roleAt = roleBindingTable.headers.indexOf('ROLE');
        const adminBinding = roleBindingTable.rows.find((cells) => cells[0] === 'admin') || [];
        const deployerBinding =
          roleBindingTable.rows.find((cells) => cells[0] === 'system:deployers') || [];
        const createdBindingResult = cliBar.executeCommand(
          'oc create rolebinding qa59-edit --clusterrole=edit --user=developer -n qa59-locks'
        );
        const createdBindingTable = parseTable(
          cliBar.executeCommand('oc get rolebinding qa59-edit -n qa59-locks')?.message
        );
        const createdBindingRow =
          createdBindingTable.rows.find((cells) => cells[0] === 'qa59-edit') || [];
        const clusterBindingTable = parseTable(
          cliBar.executeCommand('oc get clusterrolebinding')?.message
        );
        const kubeadminBinding =
          clusterBindingTable.rows.find((cells) => cells[0] === 'kubeadmin-cluster-admin') || [];
        const roleKindOk =
          !newProjectResult?.error &&
          !roleBindingResult?.error &&
          roleAt >= 0 &&
          adminBinding[roleAt] === 'ClusterRole/admin' &&
          deployerBinding[roleAt] === 'ClusterRole/system:deployer' &&
          !createdBindingResult?.error &&
          createdBindingRow[createdBindingTable.headers.indexOf('ROLE')] === 'ClusterRole/edit' &&
          kubeadminBinding[clusterBindingTable.headers.indexOf('ROLE')] ===
            'ClusterRole/cluster-admin';
        if (roleKindOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `RoleBinding ROLE cells must print ClusterRole/<roleRef.name> (#60): ${JSON.stringify({ admin: adminBinding, deployers: deployerBinding, created: createdBindingRow, kubeadmin: kubeadminBinding })}`
          );
        }

        // #59: a literal Service ClusterIP routes through the Service's ready
        // endpoints (kube-proxy semantics), while a non-Service IP does not.
        const trafficService = engine.applyManifestObject({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'qa59-traffic', namespace: 'default' },
          spec: { selector: { app: 'qa59-traffic' }, ports: [{ port: 8080 }] },
        });
        const trafficPod = cluster.addResource({
          kind: 'Pod',
          apiVersion: 'v1',
          metadata: {
            name: 'qa59-traffic-pod',
            namespace: 'default',
            labels: { app: 'qa59-traffic' },
          },
          spec: {
            nodeName: 'worker-0',
            containers: [
              {
                name: 'web',
                image: 'registry.access.redhat.com/ubi9/httpd-24',
                ports: [{ containerPort: 8080 }],
              },
            ],
          },
          status: {
            phase: 'Running',
            podIP: '10.128.250.10',
            hostIP: '192.168.1.10',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        });
        simulation.tick(0.05);
        const trafficResult = simulation.trafficForExec(trafficPod, {
          target: trafficService?.spec?.clusterIP,
          port: 8080,
          namespace: 'default',
        });
        const usedServiceIPs = new Set(
          (cluster.getByKind('Service') || [])
            .flatMap((service) => [service.spec?.clusterIP, ...(service.spec?.clusterIPs || [])])
            .filter(Boolean)
        );
        const nonServiceIP = ['172.30.249.249', '172.30.248.248', '172.30.247.247'].find(
          (candidate) => !usedServiceIPs.has(candidate)
        );
        const nonServiceDestination = simulation._resolveTrafficDestination(nonServiceIP, {
          namespace: 'default',
        });
        if (
          /^172\.30\.\d+\.\d+$/.test(String(trafficService?.spec?.clusterIP || '')) &&
          trafficResult?.allowed === true &&
          Array.isArray(trafficResult.lines) &&
          trafficResult.lines.length > 0 &&
          nonServiceDestination?.kind !== 'Service' &&
          (nonServiceDestination?.pods || []).length === 0
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `SimulationTick clusterIP traffic: a Service ClusterIP must route to ready endpoints while a non-Service IP stays unresolved (#59): ${JSON.stringify({ clusterIP: trafficService?.spec?.clusterIP, trafficResult, nonServiceIP, nonServiceDestination })}`
          );
        }

        // #60: a healthy `oc rollout status --timeout` waits synchronously and
        // succeeds; a stalled rollout fails with real oc's timeout error.
        const healthyCreate = cliBar.executeCommand(
          'oc create deploy qa60-healthy --image=quay.io/openshift/origin-hello-openshift:latest --replicas=1 -n qa59-locks'
        );
        const healthyStatus = cliBar.executeCommand(
          'oc rollout status deploy/qa60-healthy --timeout=120s -n qa59-locks'
        );
        const healthyStatusMessage = String(healthyStatus?.message || '');
        if (
          !healthyCreate?.error &&
          !healthyStatus?.error &&
          /successfully rolled out/.test(healthyStatusMessage) &&
          !/timed out waiting for the condition/.test(healthyStatusMessage)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`oc rollout status --timeout=120s\` on a healthy Deployment must succeed (#60): ${JSON.stringify({ create: healthyCreate?.message, status: healthyStatus })}`
          );
        }

        const stalledCreate = cliBar.executeCommand(
          'oc create deploy qa60-stalled --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=2 -n qa59-locks'
        );
        for (let tickIndex = 0; tickIndex < 240; tickIndex += 1) simulation.tick(0.05);
        const stalledDeployment = cluster.getByName('Deployment', 'qa60-stalled', 'qa59-locks');
        const stalledContainer = stalledDeployment?.spec?.template?.spec?.containers?.[0]?.name;
        const stalledImageUpdate = cliBar.executeCommand(
          `oc set image deploy/qa60-stalled ${stalledContainer}=quay.io/nonexistent/boom:latest -n qa59-locks`
        );
        for (let tickIndex = 0; tickIndex < 200; tickIndex += 1) simulation.tick(0.05);
        const timedOutStatus = cliBar.executeCommand(
          'oc rollout status deploy/qa60-stalled --timeout=5s -n qa59-locks'
        );
        const timedOutMessage = String(timedOutStatus?.message || '');
        const timedOutLines = timedOutMessage
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (
          !stalledCreate?.error &&
          !stalledImageUpdate?.error &&
          timedOutStatus?.error === true &&
          /Waiting for deployment "qa60-stalled"/.test(timedOutMessage) &&
          timedOutLines[timedOutLines.length - 1] ===
            'error: timed out waiting for the condition' &&
          !/successfully rolled out/.test(timedOutMessage)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`oc rollout status --timeout=5s\` on a stalled Deployment must block, print the Waiting line and end with error: timed out waiting for the condition (#60): ${JSON.stringify({ create: stalledCreate?.message, imageUpdate: stalledImageUpdate?.message, status: timedOutStatus })}`
          );
        }

        // #60: the timeout makes the command exit 1, so `&&` is skipped while
        // `;` continues (real shell exit-status semantics).
        const chainedTimeout = cliBar.executeCommand(
          'oc rollout status deploy/qa60-stalled --timeout=5s -n qa59-locks && echo CHAIN_RAN'
        );
        const semicolonTimeout = cliBar.executeCommand(
          'oc rollout status deploy/qa60-stalled --timeout=5s -n qa59-locks ; echo AFTER'
        );
        if (
          chainedTimeout?.error === true &&
          !/CHAIN_RAN/.test(String(chainedTimeout?.message || '')) &&
          semicolonTimeout?.error === false &&
          /AFTER/.test(String(semicolonTimeout?.message || '')) &&
          /timed out waiting for the condition/.test(String(semicolonTimeout?.message || ''))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `a timed-out \`oc rollout status\` must skip a following \`&&\` command but run a following \`;\` command (#60): ${JSON.stringify({ chained: chainedTimeout, semicolon: semicolonTimeout })}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#59/#60 dynamic fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4f. Issue #61–#62 DNS/exec/pod-network fidelity locks (static) ────────
// The browser suite section `qa-issue61-62` proves the behaviour end-to-end.
// These module/source locks fail the fast static gate if a future refactor
// silently reintroduces the #61/#62 bugs (no browser, no long sleeps):
// NetworkPolicy-aware DNS, honest `oc exec` exit codes, the 10.128.0.0/14 pod
// network, the kubelet `/etc/hosts`, rolebinding-wide ServiceAccounts, the
// tabwriter Events alignment and the named dns-default targetPorts.
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const netMod = await tryImport('js/resources/NetworkResources.js');
  const manifestMod = await tryImport('js/engine/ManifestEngine.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !netMod?.Service ||
    !manifestMod?.ManifestEngine
  ) {
    fail(
      'fidelity',
      '#61/#62: GameEngine/SandboxMode/CommandBar/NetworkResources/ManifestEngine are not importable for the locks'
    );
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      // This lock ticks the cluster for ~20 s of game time; the sandbox seeds
      // random container failures (0.002), which could transiently restart a
      // dns-default container and make the exact EndpointSlice assertions
      // flaky. The lock proves deterministic output fidelity, so disable them.
      simulation.randomFailureRate = 0;
      const cluster = engine.cluster;
      const nodes = cluster.getByKind('Node') || [];
      /** OCP 4.22 clusterNetwork 10.128.0.0/14 → 10.128–10.131 in the 2nd octet. */
      const POD_NETWORK_RE = /^10\.(?:12[89]|13[01])\.\d{1,3}\.\d{1,3}$/;
      const ipToInt = (value) =>
        String(value)
          .split('.')
          .reduce((accumulator, octet) => accumulator * 256 + Number(octet), 0);
      const ipInCidr = (ip, cidr) => {
        const [network, prefixRaw] = String(cidr || '').split('/');
        const prefix = Number(prefixRaw);
        if (!ip || !network || !Number.isFinite(prefix)) return false;
        const block = 2 ** (32 - prefix);
        return Math.floor(ipToInt(ip) / block) === Math.floor(ipToInt(network) / block);
      };
      const nodeCidrs = new Map(nodes.map((node) => [node.metadata?.name, node.spec?.podCIDR]));

      // #62B: `_generatePodIP(node)` allocates inside the Pod's Node
      // `spec.podCIDR` (/23, OVN-Kubernetes hostPrefix) and accepts both the
      // Node object and the Node name call shapes used by the platform seeders.
      const generated = nodes.map((node) => ({
        name: node.metadata?.name,
        cidr: node.spec?.podCIDR || '',
        byObject: simulation._generatePodIP(node),
        byName: simulation._generatePodIP(node.metadata?.name),
      }));
      if (
        nodes.length === 3 &&
        generated.every(
          (entry) =>
            String(entry.cidr).endsWith('/23') &&
            ipInCidr(entry.byObject, entry.cidr) &&
            ipInCidr(entry.byName, entry.cidr) &&
            POD_NETWORK_RE.test(entry.byObject) &&
            POD_NETWORK_RE.test(entry.byName)
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `_generatePodIP must allocate the host part inside the Node spec.podCIDR (/23) for both a Node object and a Node name (#62B): ${JSON.stringify(generated)}`
        );
      }

      // #62B: with no Node/CIDR info `_generatePodIP` falls back to the
      // clusterNetwork range (10.128–10.131, never 10.244), and the seeded
      // dns-default Pods (IPs generated by the platform seeder) are in range and
      // inside their Node's podCIDR.
      const fallbackIps = [
        simulation._generatePodIP(),
        simulation._generatePodIP(null),
        simulation._generatePodIP('node-that-does-not-exist'),
      ];
      const dnsPods = (cluster.getByKindAndNamespace('Pod', 'openshift-dns') || []).filter((pod) =>
        /^dns-default-/.test(pod.metadata?.name || '')
      );
      if (
        fallbackIps.every((ip) => POD_NETWORK_RE.test(ip) && !String(ip).startsWith('10.244.')) &&
        dnsPods.length === nodes.length &&
        dnsPods.every(
          (pod) =>
            POD_NETWORK_RE.test(String(pod.status?.podIP || '')) &&
            ipInCidr(pod.status?.podIP, nodeCidrs.get(pod.spec?.nodeName))
        )
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `the pod-network fallback must stay in 10.128–10.131 (not 10.244) and dns-default Pod IPs must come from the Node podCIDR (#62B): ${JSON.stringify({ fallbackIps, dnsPods: dnsPods.map((pod) => ({ name: pod.metadata?.name, ip: pod.status?.podIP, node: pod.spec?.nodeName, cidr: nodeCidrs.get(pod.spec?.nodeName) })) })}`
        );
      }

      // #62B: no runtime source still carries the old kubeadm 10.244 range; the
      // platform seeder and incident paths pass the Node into _generatePodIP and
      // IncidentEngine's last-resort literal is the 10.128.0.10 pod-network IP.
      const stalePodRangeFiles = jsFiles.filter((rel) => read(rel).includes('10.244.'));
      const simulationSrc = read('js/engine/SimulationTick.js');
      const incidentSrc = read('js/engine/IncidentEngine.js');
      const generateCallSitesOk =
        /_generatePodIP\(\s*seed\.node\s*\)/.test(simulationSrc) &&
        /_generatePodIP\(\s*node\s*\)/.test(simulationSrc) &&
        /_generatePodIP\(\s*nodeName\s*\)/.test(incidentSrc) &&
        /'10\.128\.0\.10'/.test(incidentSrc);
      if (stalePodRangeFiles.length === 0 && generateCallSitesOk) {
        passed();
      } else {
        fail(
          'fidelity',
          `runtime code must not contain the old 10.244 pod range and _generatePodIP call sites must pass the Node (#62B): stale=${JSON.stringify(stalePodRangeFiles)} callSites=${generateCallSitesOk}`
        );
      }

      // CommandBar locks need the `window.game` integration surface the app
      // wires in the browser; provide the minimum shim around the real engine
      // (mirrors the #57/#58 and #59/#60 locks above).
      const windowShim = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
          manifestEngine: null,
        },
      };
      globalThis.window = windowShim;
      try {
        const manifestEngine = new manifestMod.ManifestEngine();
        windowShim.game.manifestEngine = manifestEngine;
        const cliBar = new commandBarMod.CommandBar();
        /** Split an oc/kubectl tabwriter table into header cells + positioned rows. */
        const parseTabwriter = (message) => {
          const lines = String(message ?? '')
            .split('\n')
            .filter((line) => line.trim() !== '');
          const headerLine = lines[0] || '';
          const headers = headerLine
            .split(/\s{2,}/)
            .map((cell) => cell.trim())
            .filter(Boolean);
          const starts = [];
          let searchFrom = 0;
          for (const header of headers) {
            const at = headerLine.indexOf(header, searchFrom);
            starts.push(at < 0 ? searchFrom : at);
            searchFrom = (at < 0 ? searchFrom : at) + header.length;
          }
          const rows = lines
            .slice(1)
            .map((line) =>
              headers.map((_, index) =>
                line
                  .slice(starts[index], index + 1 < starts.length ? starts[index + 1] : line.length)
                  .trim()
              )
            );
          return { headers, rows };
        };

        // A real project + Deployment + exposed Service fixture: `oc exec` and
        // `oc describe svc` need a Running Pod and a ClusterIP Service.
        const projectResult = cliBar.executeCommand('oc new-project qa61-locks');
        const deploymentResult = cliBar.executeCommand(
          'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa61-locks'
        );
        for (let tickIndex = 0; tickIndex < 400; tickIndex += 1) simulation.tick(0.05);
        const exposeResult = cliBar.executeCommand(
          'oc expose deploy/web --port=8080 -n qa61-locks'
        );
        for (let tickIndex = 0; tickIndex < 20; tickIndex += 1) simulation.tick(0.05);
        const webService = cluster.getByName('Service', 'web', 'qa61-locks');
        const clusterIP = String(webService?.spec?.clusterIP || '');
        const webPods = (cluster.getByKindAndNamespace('Pod', 'qa61-locks') || []).filter((pod) =>
          /^web-/.test(String(pod.metadata?.name || ''))
        );
        const runningWebPod =
          webPods.find((pod) => pod.status?.phase === 'Running') || webPods[0] || null;
        const fixtureOk =
          !projectResult?.error &&
          !deploymentResult?.error &&
          !exposeResult?.error &&
          /^172\.30\.\d+\.\d+$/.test(clusterIP) &&
          Boolean(runningWebPod);

        // #62A: an unmodelled container binary is a real OCI exec failure (exit
        // 127, no fake `(command executed in …)`/`exit code 0`), so `&&` stops
        // and `||` recovers — the shell exit-status contract real oc has.
        const foobarResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- foobar --x'
        );
        const chainedResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- foobar && echo AFTER'
        );
        const recoveredResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- foobar || echo RECOVERED'
        );
        const foobarMessage = String(foobarResult?.message || '');
        if (
          fixtureOk &&
          foobarResult?.error === true &&
          /error: Internal error occurred:/.test(foobarMessage) &&
          /exec: "foobar": executable file not found in \$PATH/.test(foobarMessage) &&
          /command terminated with exit code 127\s*$/.test(foobarMessage) &&
          !/\(command executed in /.test(foobarMessage) &&
          !/exit code 0/.test(foobarMessage) &&
          chainedResult?.error === true &&
          !/AFTER/.test(String(chainedResult?.message || '')) &&
          recoveredResult?.error === false &&
          /RECOVERED/.test(String(recoveredResult?.message || ''))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `unknown exec binaries must fail with the OCI not-found wording + exit 127 and honour && / || (#62A): ${JSON.stringify({ fixtureOk, foobar: foobarResult, chained: chainedResult, recovered: recoveredResult })}`
          );
        }

        // #62A: `oc rsh` shares the exit-status contract; modelled binaries are
        // matched by basename (`/bin/cat`) and `sh -c` still unwraps.
        const rshResult = cliBar.executeCommand('oc rsh -n qa61-locks deploy/web foobar');
        const hostnameResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- hostname'
        );
        const binCatResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- /bin/cat /etc/hostname'
        );
        const shellResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- sh -c "echo SHELL_OK"'
        );
        const podName = String(runningWebPod?.metadata?.name || '');
        if (
          rshResult?.error === true &&
          /command terminated with exit code 127\s*$/.test(String(rshResult?.message || '')) &&
          hostnameResult?.error === false &&
          String(hostnameResult?.message || '').trim() === podName &&
          binCatResult?.error === false &&
          String(binCatResult?.message || '').trim() === podName &&
          shellResult?.error === false &&
          /SHELL_OK/.test(String(shellResult?.message || ''))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `oc rsh must share the exit-status contract and modelled binaries (hostname, /bin/cat, sh -c) must keep working (#62A): ${JSON.stringify({ rsh: rshResult, hostname: hostnameResult, binCat: binCatResult, shell: shellResult })}`
          );
        }

        // #62C: `_podExecContext` builds the kubelet-managed /etc/hosts — the
        // standard header/loopback lines plus the Pod's own IP + name, and no
        // Service entry (`172.30.0.1 kubernetes.default.svc` must stay gone).
        const execContext = runningWebPod
          ? cliBar._podExecContext(runningWebPod, 'httpd-24')
          : null;
        const hostsFile = String(execContext?.files?.get?.('/etc/hosts') || '');
        const expectedHosts = [
          '# Kubernetes-managed hosts file.',
          '127.0.0.1\tlocalhost',
          '::1\tlocalhost ip6-localhost ip6-loopback',
          'fe00::0\tip6-localnet',
          'fe00::0\tip6-mcastprefix',
          'fe00::1\tip6-allnodes',
          'fe00::2\tip6-allrouters',
          `${runningWebPod?.status?.podIP}\t${runningWebPod?.metadata?.name}`,
        ].join('\n');
        if (
          hostsFile === `${expectedHosts}\n` &&
          !/172\.30\.0\.1/.test(hostsFile) &&
          !/kubernetes\.default\.svc/.test(hostsFile)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `Pod /etc/hosts must be the kubelet-managed file (own podIP+name, no Service entry) (#62C): ${JSON.stringify(hostsFile)}`
          );
        }

        // #62C/#61: a legacy Pod without podIP omits only the final line, and an
        // empty/none `_podExecContext` fallback must not throw (item 9).
        const legacyPod = {
          metadata: { name: 'qa61-legacy', namespace: 'default' },
          spec: { containers: [{ name: 'ubi', image: 'registry.access.redhat.com/ubi9/ubi' }] },
          status: { phase: 'Running' },
        };
        const legacyHosts = String(
          cliBar._podExecContext(legacyPod, 'ubi')?.files?.get?.('/etc/hosts') || ''
        );
        const legacyLines = legacyHosts.replace(/\n$/, '').split('\n');
        let emptyExecContextOk = false;
        try {
          const emptyContext = cliBar._podExecContext({}, 'main');
          emptyExecContextOk = typeof emptyContext?.files?.get?.('/etc/hosts') === 'string';
        } catch {
          emptyExecContextOk = false;
        }
        if (
          legacyLines.length === 7 &&
          legacyLines[0] === '# Kubernetes-managed hosts file.' &&
          legacyLines[6] === 'fe00::2\tip6-allrouters' &&
          !legacyHosts.includes('qa61-legacy') &&
          emptyExecContextOk
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `a Pod without podIP must omit only the /etc/hosts final line and empty _podExecContext must not throw (#62C/#61): ${JSON.stringify({ legacyLines, emptyExecContextOk })}`
          );
        }

        // #62E: the dns-default Service keeps NAMED targetPorts in its spec
        // (`dns`/`dns-tcp` → 5353 on the dns container, `metrics` → the
        // kube-rbac-proxy sidecar's 9154); the Service ports stay 53/UDP,
        // 53/TCP, 9154/TCP.
        const dnsService = cluster.getByName('Service', 'dns-default', 'openshift-dns');
        const dnsPortSpecs = (dnsService?.spec?.ports || []).map((port) => ({
          name: port.name,
          port: port.port,
          protocol: port.protocol,
          targetPort: port.targetPort,
        }));
        if (
          JSON.stringify(dnsPortSpecs) ===
          JSON.stringify([
            { name: 'dns', port: 53, protocol: 'UDP', targetPort: 'dns' },
            { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 'dns-tcp' },
            { name: 'metrics', port: 9154, protocol: 'TCP', targetPort: 'metrics' },
          ])
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `openshift-dns/dns-default must keep the real NAMED targetPorts dns/dns-tcp/metrics (#62E): ${JSON.stringify(dnsPortSpecs)}`
          );
        }

        // #62E: `oc describe svc dns-default` prints the named TargetPorts while
        // the Endpoints (and `oc get endpoints`) resolve to the real pod ports
        // 5353/5353/9154 — the `metrics` name must pick the sidecar's 9154, not
        // CoreDNS' 9153.
        const dnsDescribeResult = cliBar.executeCommand(
          'oc describe svc dns-default -n openshift-dns'
        );
        const dnsTargetPorts = String(dnsDescribeResult?.message || '')
          .split('\n')
          .filter((line) => /^TargetPort:/.test(line))
          .map((line) => line.replace(/^TargetPort:\s*/, '').trim());
        const dnsEndpointsResult = cliBar.executeCommand(
          'oc get endpoints dns-default -n openshift-dns -o json'
        );
        let dnsEndpointPorts = [];
        let dnsEndpointIPs = [];
        try {
          const endpointsJson = JSON.parse(String(dnsEndpointsResult?.message || '{}'));
          dnsEndpointPorts = (endpointsJson.subsets || []).map((subset) => ({
            port: subset.ports?.[0]?.port,
            protocol: subset.ports?.[0]?.protocol,
          }));
          dnsEndpointIPs = [
            ...new Set(
              (endpointsJson.subsets || []).flatMap((subset) =>
                (subset.addresses || []).map((address) => address.ip)
              )
            ),
          ];
        } catch {
          dnsEndpointPorts = [];
          dnsEndpointIPs = [];
        }
        const expectedDnsPodIPs = dnsPods.map((pod) => pod.status?.podIP).filter(Boolean);
        const dnsEndpointsText = cliBar.executeCommand('oc get endpoints -n openshift-dns');
        const dnsEndpointsTable = parseTabwriter(dnsEndpointsText?.message);
        const dnsEndpointsRow =
          dnsEndpointsTable.rows.find(
            (cells) => cells[dnsEndpointsTable.headers.indexOf('NAME')] === 'dns-default'
          ) || [];
        const dnsEndpointsCell =
          dnsEndpointsRow[dnsEndpointsTable.headers.indexOf('ENDPOINTS')] || '';
        if (
          !dnsDescribeResult?.error &&
          JSON.stringify(dnsTargetPorts) ===
            JSON.stringify(['dns/UDP', 'dns-tcp/TCP', 'metrics/TCP']) &&
          !dnsEndpointsResult?.error &&
          JSON.stringify(dnsEndpointPorts) ===
            JSON.stringify([
              { port: 5353, protocol: 'UDP' },
              { port: 5353, protocol: 'TCP' },
              { port: 9154, protocol: 'TCP' },
            ]) &&
          dnsEndpointIPs.length === expectedDnsPodIPs.length &&
          dnsEndpointIPs.every((ip) => expectedDnsPodIPs.includes(ip) && POD_NETWORK_RE.test(ip)) &&
          !dnsEndpointsText?.error &&
          /^(?:10\.(?:12[89]|13[01])\.\d+\.\d+:5353,){2}10\.(?:12[89]|13[01])\.\d+\.\d+:5353 \+ \d+ more\.\.\.$/.test(
            dnsEndpointsCell
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `named dns-default targetPorts must still resolve to the real endpoint ports 5353/5353/9154 (never 9153) (#62E): ${JSON.stringify({ dnsTargetPorts, dnsEndpointPorts, dnsEndpointIPs, expectedDnsPodIPs, dnsEndpointsCell })}`
          );
        }

        // #62D: `oc get rolebinding -o wide` prints a ServiceAccount subject as
        // `<namespace>/<name>` (rbac.SubjectsStrings), never the bare name and
        // never a leading `/`.
        const roleBindingWideResult = cliBar.executeCommand(
          'oc get rolebinding -o wide -n qa61-locks'
        );
        const roleBindingTable = parseTabwriter(roleBindingWideResult?.message);
        const roleBindingNameAt = roleBindingTable.headers.indexOf('NAME');
        const serviceAccountsAt = roleBindingTable.headers.indexOf('SERVICEACCOUNTS');
        const deployersRow =
          roleBindingTable.rows.find((cells) => cells[roleBindingNameAt] === 'system:deployers') ||
          [];
        const buildersRow =
          roleBindingTable.rows.find(
            (cells) => cells[roleBindingNameAt] === 'system:image-builders'
          ) || [];
        const serviceAccountCells = roleBindingTable.rows
          .map((cells) => cells[serviceAccountsAt] || '')
          .filter(Boolean);
        if (
          !roleBindingWideResult?.error &&
          serviceAccountsAt >= 0 &&
          deployersRow[serviceAccountsAt] === 'qa61-locks/deployer' &&
          buildersRow[serviceAccountsAt] === 'qa61-locks/builder' &&
          serviceAccountCells.every(
            (cell) => /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9:._-]+$/.test(cell) && !cell.startsWith('/')
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `rolebinding -o wide SERVICEACCOUNTS must print <namespace>/<name> (#62D): ${JSON.stringify({ headers: roleBindingTable.headers, deployers: deployersRow, builders: buildersRow, serviceAccountCells })}`
          );
        }

        // #62F / #69 P4: `oc describe svc web`'s empty Events placeholder is
        // aligned with the widest top-level label. kubectl 1.35 (OCP 4.22)
        // prints the API-server-defaulted `Internal Traffic Policy:` row
        // (24-char label → value column 27), so `Events:` is followed by
        // exactly 19 spaces (the old 12-space column only accounted for
        // `Session Affinity:`; the pre-#69 fixed 10-space placeholder was two
        // tabwriter columns short).
        const describeWebResult = cliBar.executeCommand('oc describe svc web -n qa61-locks');
        const describeWebMessage = String(describeWebResult?.message || '');
        const eventsLine = (describeWebMessage.match(/^Events:.*$/m) || [''])[0];
        const eventsSpaces = (eventsLine.match(/^Events:( +)<none>$/) || [])[1] || '';
        if (!describeWebResult?.error && eventsSpaces.length === 19) {
          passed();
        } else {
          fail(
            'fidelity',
            `oc describe svc web Events placeholder must align at the tabwriter column (exactly 19 spaces after "Events:" with the kubectl 1.35 Internal Traffic Policy row, got ${eventsSpaces.length}) (#62F/#69 P4): ${JSON.stringify(eventsLine)}`
          );
        }

        const shortName = 'web';
        const canonicalName = `web.qa61-locks.svc.cluster.local`;
        const escapedCanonical = canonicalName.replace(/\./g, '\\.');
        const escapedClusterIP = clusterIP.replace(/\./g, '\\.');

        // #61 item 7 / #62 item 1: `nslookup web` resolves through the Pod's
        // resolv.conf search list and prints the CANONICAL FQDN in the Name line.
        const nslookupFqdnResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- nslookup ${canonicalName}`
        );
        const nslookupShortResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- nslookup ${shortName}`
        );
        const nslookupFqdnMessage = String(nslookupFqdnResult?.message || '');
        const nslookupShortMessage = String(nslookupShortResult?.message || '');
        if (
          fixtureOk &&
          !nslookupFqdnResult?.error &&
          new RegExp(`^Name:\\t${escapedCanonical}$`, 'm').test(nslookupFqdnMessage) &&
          nslookupFqdnMessage.includes(`Address: ${clusterIP}`) &&
          !nslookupFqdnMessage.includes('172.30.43.12') &&
          !nslookupShortResult?.error &&
          new RegExp(`^Name:\\t${escapedCanonical}$`, 'm').test(nslookupShortMessage) &&
          nslookupShortMessage.includes(`Address: ${clusterIP}`)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `nslookup must resolve FQDN + short names through the search list and print the canonical FQDN in Name: (#61 item 7): ${JSON.stringify({ fqdn: nslookupFqdnMessage, short: nslookupShortMessage, clusterIP })}`
          );
        }

        // #61 item 6: `dig` uses the real cluster-DNS answer (the Service's own
        // spec.clusterIP, never the fabricated 172.30.43.12) and its own DiG
        // output format; `+short` is only the IP.
        const digShortResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- dig +short ${canonicalName}`
        );
        const digPlainResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- dig ${canonicalName}`
        );
        const digPlainMessage = String(digPlainResult?.message || '');
        if (
          !digShortResult?.error &&
          String(digShortResult?.message || '').trim() === clusterIP &&
          !digPlainResult?.error &&
          /^; <<>> DiG 9\.18\.28 <<>>/m.test(digPlainMessage) &&
          /^;; ->>HEADER<<- opcode: QUERY, status: NOERROR/m.test(digPlainMessage) &&
          /^;; QUESTION SECTION:/m.test(digPlainMessage) &&
          /^;; ANSWER SECTION:/m.test(digPlainMessage) &&
          new RegExp(`^${escapedCanonical}\\. 30 IN A ${escapedClusterIP}$`, 'm').test(
            digPlainMessage
          ) &&
          /^;; SERVER: 172\.30\.0\.10#53\(172\.30\.0\.10\) \(UDP\)$/m.test(digPlainMessage) &&
          !digPlainMessage.includes('172.30.43.12') &&
          !/^Name:\t/m.test(digPlainMessage)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `dig must answer from the real Service ClusterIP with its own DiG format (never 172.30.43.12) (#61 item 6): ${JSON.stringify({ short: digShortResult?.message, plain: digPlainMessage, clusterIP })}`
          );
        }

        // #61 item 8: `getent hosts` prints glibc's `%-15s %s` format (IP padded
        // to 15 + one space + canonical name) and an unknown name is a silent
        // exit 2.
        const getentResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- getent hosts ${canonicalName}`
        );
        const getentLine = String(getentResult?.message || '').trim();
        const getentMatch = getentLine.match(/^(\S+)( +)(\S+)$/);
        const getentUnknownResult = cliBar.executeCommand(
          'oc exec deploy/web -n qa61-locks -- getent hosts does-not-exist.qa61-locks.svc.cluster.local'
        );
        const getentUnknownMessage = String(getentUnknownResult?.message || '');
        if (
          !getentResult?.error &&
          getentMatch &&
          getentMatch[1] === clusterIP &&
          getentMatch[2].length === 16 - clusterIP.length &&
          getentMatch[3] === canonicalName &&
          getentUnknownResult?.error === true &&
          /command terminated with exit code 2\s*$/.test(getentUnknownMessage) &&
          !getentUnknownMessage.includes(clusterIP)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `getent hosts must print the glibc %-15s %s line and fail silently with exit 2 for unknown names (#61 item 8): ${JSON.stringify({ line: getentLine, expectedSpaces: 16 - clusterIP.length, unknown: getentUnknownMessage })}`
          );
        }

        // #61 items 1–5: a NetworkPolicy that isolates the Pod for Egress and
        // only allows same-namespace traffic blocks DNS (the dns-default pods
        // live in openshift-dns): nslookup times out (exit 1), dig times out
        // (exit 9) and getent is silent (exit 2). The allow-dns-egress policy on
        // UDP/TCP 5353 then restores all three together.
        const denyPolicyYaml = [
          'apiVersion: networking.k8s.io/v1',
          'kind: NetworkPolicy',
          'metadata:',
          '  name: deny-egress',
          '  namespace: qa61-locks',
          'spec:',
          '  podSelector: {}',
          '  policyTypes:',
          '    - Egress',
        ].join('\n');
        const sameNamespacePolicyYaml = [
          'apiVersion: networking.k8s.io/v1',
          'kind: NetworkPolicy',
          'metadata:',
          '  name: allow-same-ns',
          '  namespace: qa61-locks',
          'spec:',
          '  podSelector: {}',
          '  policyTypes:',
          '    - Egress',
          '  egress:',
          '    - to:',
          '        - podSelector: {}',
        ].join('\n');
        manifestEngine.writeFile('qa61-deny-egress.yaml', denyPolicyYaml);
        manifestEngine.writeFile('qa61-allow-same-ns.yaml', sameNamespacePolicyYaml);
        const denyApplyResult = cliBar.executeCommand(
          'oc apply -f qa61-deny-egress.yaml -n qa61-locks'
        );
        const sameNamespaceApplyResult = cliBar.executeCommand(
          'oc apply -f qa61-allow-same-ns.yaml -n qa61-locks'
        );
        for (let tickIndex = 0; tickIndex < 10; tickIndex += 1) simulation.tick(0.05);
        const blockedNslookupResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- nslookup ${canonicalName}`
        );
        const blockedDigResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- dig +short ${canonicalName}`
        );
        const blockedGetentResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- getent hosts ${canonicalName}`
        );
        const blockedNslookupMessage = String(blockedNslookupResult?.message || '');
        const blockedDigMessage = String(blockedDigResult?.message || '');
        const blockedGetentMessage = String(blockedGetentResult?.message || '');
        const timeoutLine = /^;; connection timed out; no servers could be reached$/m;
        if (
          !denyApplyResult?.error &&
          !sameNamespaceApplyResult?.error &&
          blockedNslookupResult?.error === true &&
          timeoutLine.test(blockedNslookupMessage) &&
          /command terminated with exit code 1\s*$/.test(blockedNslookupMessage) &&
          !/^Server:/m.test(blockedNslookupMessage) &&
          !/^Address:/m.test(blockedNslookupMessage) &&
          !/^Name:/m.test(blockedNslookupMessage) &&
          blockedDigResult?.error === true &&
          timeoutLine.test(blockedDigMessage) &&
          /command terminated with exit code 9\s*$/.test(blockedDigMessage) &&
          !blockedDigMessage.includes(clusterIP) &&
          blockedGetentResult?.error === true &&
          /command terminated with exit code 2\s*$/.test(blockedGetentMessage) &&
          !blockedGetentMessage.includes(clusterIP) &&
          !blockedGetentMessage.includes(canonicalName)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `a DNS-blocking NetworkPolicy must fail nslookup (exit 1), dig (exit 9) and getent (silent exit 2) (#61 items 1–3): ${JSON.stringify({ apply: denyApplyResult?.message, nslookup: blockedNslookupMessage, dig: blockedDigMessage, getent: blockedGetentMessage })}`
          );
        }

        const allowDnsPolicyYaml = [
          'apiVersion: networking.k8s.io/v1',
          'kind: NetworkPolicy',
          'metadata:',
          '  name: allow-dns-egress',
          '  namespace: qa61-locks',
          'spec:',
          '  podSelector: {}',
          '  policyTypes:',
          '    - Egress',
          '  egress:',
          '    - to:',
          '        - namespaceSelector:',
          '            matchLabels:',
          '              kubernetes.io/metadata.name: openshift-dns',
          '      ports:',
          '        - protocol: UDP',
          '          port: 5353',
          '        - protocol: TCP',
          '          port: 5353',
        ].join('\n');
        manifestEngine.writeFile('qa61-allow-dns-egress.yaml', allowDnsPolicyYaml);
        const allowDnsApplyResult = cliBar.executeCommand(
          'oc apply -f qa61-allow-dns-egress.yaml -n qa61-locks'
        );
        for (let tickIndex = 0; tickIndex < 10; tickIndex += 1) simulation.tick(0.05);
        const restoredNslookupResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- nslookup ${canonicalName}`
        );
        const restoredDigResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- dig +short ${canonicalName}`
        );
        const restoredGetentResult = cliBar.executeCommand(
          `oc exec deploy/web -n qa61-locks -- getent hosts ${canonicalName}`
        );
        const restoredNslookupMessage = String(restoredNslookupResult?.message || '');
        if (
          !allowDnsApplyResult?.error &&
          !restoredNslookupResult?.error &&
          new RegExp(`^Name:\\t${escapedCanonical}$`, 'm').test(restoredNslookupMessage) &&
          restoredNslookupMessage.includes(`Address: ${clusterIP}`) &&
          !restoredDigResult?.error &&
          String(restoredDigResult?.message || '').trim() === clusterIP &&
          !restoredGetentResult?.error &&
          String(restoredGetentResult?.message || '')
            .trim()
            .endsWith(canonicalName)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `the allow-dns-egress policy (UDP/TCP 5353 to openshift-dns) must restore nslookup/dig/getent together (#61 item 5): ${JSON.stringify({ apply: allowDnsApplyResult?.message, nslookup: restoredNslookupMessage, dig: restoredDigResult?.message, getent: restoredGetentResult?.message })}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#61/#62 dynamic fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4g. Issue #63 shell/exec fidelity locks (static) ──────────────────────
// The browser suite section `qa-issue63` proves the behaviour end-to-end.
// These module/source locks fail the fast static gate if a future refactor
// silently reintroduces the #63 bugs (no browser, no long sleeps): real `$?` /
// `${?}` expansion (within a line and across terminal lines), container
// `true`/`false`, honest non-zero exit statuses from real container commands
// with `&&`/`||` chaining, and the corrected Lab 13 description (the provided
// policy must be applied — it is neither seeded nor already applied).
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const challengeMod = await tryImport('js/modes/ChallengeMode.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !challengeMod?.CHALLENGES
  ) {
    fail(
      'fidelity',
      '#63: GameEngine/SandboxMode/CommandBar/ChallengeMode are not importable for the locks'
    );
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      // The sandbox seeds random container failures (0.002) that could restart
      // the fixture Pod mid-lock; this lock proves fixed shell/exec semantics,
      // so disable them for deterministic output (#61/#62 lock precedent).
      simulation.randomFailureRate = 0;
      const cluster = engine.cluster;
      // CommandBar needs the `window.game` integration surface the app wires in
      // the browser; provide the minimum shim around the real engine.
      const windowShim = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
          manifestEngine: null,
        },
      };
      globalThis.window = windowShim;
      try {
        const cliBar = new commandBarMod.CommandBar();
        const run = (command) => cliBar.executeCommand(command);
        const messageOf = (result) => String(result?.message ?? '');

        // Self-contained fixture: project + Deployment + a Running Pod, so
        // `oc exec` / `oc rsh` resolve a real container to run in.
        const projectResult = run('oc new-project qa63');
        const deploymentResult = run(
          'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa63'
        );
        const findRunningWebPod = () =>
          (cluster.getByKindAndNamespace('Pod', 'qa63') || []).find(
            (pod) =>
              /^web-/.test(String(pod.metadata?.name || '')) && pod.status?.phase === 'Running'
          ) || null;
        for (let tickIndex = 0; tickIndex < 400 && !findRunningWebPod(); tickIndex += 1) {
          simulation.tick(0.05);
        }
        const fixtureOk =
          !projectResult?.error && !deploymentResult?.error && Boolean(findRunningWebPod());

        // #63A: `$?` is bash's last-exit-status special parameter. It is
        // expanded per segment (after the previous segment ran), so a failed
        // `oc exec` on the same line feeds the next `echo`; `${?}` is the braced
        // form and a successful command leaves 0.
        const failedInline = run('oc exec deploy/web -n qa63 -- ls /nope; echo rc=$?');
        const bracedInline = run('oc exec deploy/web -n qa63 -- ls /nope; echo rc=${?}');
        const successInline = run('oc exec deploy/web -n qa63 -- true; echo rc=$?');
        const failedInlineMessage = messageOf(failedInline);
        if (
          fixtureOk &&
          failedInline?.error === false &&
          /^rc=2$/m.test(failedInlineMessage) &&
          /^rc=2$/m.test(messageOf(bracedInline)) &&
          successInline?.error === false &&
          /^rc=0$/m.test(messageOf(successInline))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`$?\` / \`\${?}\` must expand to the previous command's real status within a line (failed exec -> rc=2, success -> rc=0) (#63A): ${JSON.stringify({ failed: failedInlineMessage, braced: messageOf(bracedInline), success: messageOf(successInline) })}`
          );
        }

        // #63A: exported variables and `$?` expand together; the assignment
        // itself exits 0, so `export X=5; echo $X $?` is `5 0`.
        const exportInline = run('export X=5; echo $X $?');
        if (
          fixtureOk &&
          exportInline?.error === false &&
          messageOf(exportInline).trim() === '5 0'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`export X=5; echo $X $?\` must print \`5 0\` (variable expansion + assignment status 0) (#63A): ${JSON.stringify({ message: messageOf(exportInline) })}`
          );
        }

        // #63A: the shell status persists ACROSS terminal lines — the next
        // command line's `echo rc=$?` sees 1 after an NXDOMAIN `nslookup`, 2
        // after `ls /nope`, and 0 after a successful `hostname` exec.
        const nxdomainExec = run(
          'oc exec deploy/web -n qa63 -- nslookup does-not-exist.qa63.svc.cluster.local'
        );
        const afterNxdomain = run('echo rc=$?');
        const failingExec = run('oc exec deploy/web -n qa63 -- ls /nope');
        const afterFailingExec = run('echo rc=$?');
        const succeedingExec = run('oc exec deploy/web -n qa63 -- hostname');
        const afterSucceedingExec = run('echo rc=$?');
        if (
          fixtureOk &&
          nxdomainExec?.error === true &&
          /command terminated with exit code 1\s*$/.test(messageOf(nxdomainExec)) &&
          messageOf(afterNxdomain).trim() === 'rc=1' &&
          failingExec?.error === true &&
          messageOf(afterFailingExec).trim() === 'rc=2' &&
          succeedingExec?.error === false &&
          messageOf(afterSucceedingExec).trim() === 'rc=0'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `$? must persist ACROSS terminal lines (nslookup NXDOMAIN -> rc=1, ls /nope -> rc=2, hostname -> rc=0) (#63A): ${JSON.stringify({ nxdomain: messageOf(afterNxdomain), failing: messageOf(afterFailingExec), succeeding: messageOf(afterSucceedingExec) })}`
          );
        }

        // #63B: UBI images ship coreutils, so `true`/`false` are real container
        // binaries: `true` is a silent success, `false` a silent failure with
        // `command terminated with exit code 1` — never a fake local success.
        const trueResult = run('oc exec deploy/web -n qa63 -- true');
        const falseResult = run('oc exec deploy/web -n qa63 -- false');
        const falseRecovered = run('oc exec deploy/web -n qa63 -- false || echo RECOVERED');
        const falseMessage = messageOf(falseResult);
        if (
          fixtureOk &&
          trueResult?.error === false &&
          messageOf(trueResult).trim() === '' &&
          falseResult?.error === true &&
          /^command terminated with exit code 1$/m.test(falseMessage) &&
          !/\(command executed in /.test(falseMessage) &&
          !/exit code 0/.test(falseMessage) &&
          falseRecovered?.error === false &&
          /RECOVERED/.test(messageOf(falseRecovered))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `container \`true\` must be a silent success and \`false\` a silent exit 1 with \`command terminated with exit code 1\` that \`||\` recovers from (#63B): ${JSON.stringify({ trueResult, falseResult, recovered: messageOf(falseRecovered) })}`
          );
        }

        // #63C: a real container command's non-zero status is reported exactly
        // like oc: the tool's stderr + `command terminated with exit code 2`,
        // with the remote status driving `&&` (stops) / `||` (recovers).
        const lsResult = run('oc exec deploy/web -n qa63 -- ls /nope');
        const lsMessage = messageOf(lsResult);
        const lsChained = run('oc exec deploy/web -n qa63 -- ls /nope && echo AFTER');
        const lsRecovered = run('oc exec deploy/web -n qa63 -- ls /nope || echo RECOVERED');
        if (
          fixtureOk &&
          lsResult?.error === true &&
          lsMessage.includes("ls: cannot access '/nope': No such file or directory") &&
          /command terminated with exit code 2\s*$/.test(lsMessage) &&
          lsChained?.error === true &&
          !/AFTER/.test(messageOf(lsChained)) &&
          lsRecovered?.error === false &&
          /RECOVERED/.test(messageOf(lsRecovered))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`oc exec … -- ls /nope\` must report the real stderr + exit 2 and honour \`&&\`/\`||\` (#63C): ${JSON.stringify({ ls: lsMessage, chained: messageOf(lsChained), recovered: messageOf(lsRecovered) })}`
          );
        }

        // #63C: exit 1 failures — `cat` on a missing file prints its own error
        // then exits 1; `grep` with no match is silent and exits 1.
        const catResult = run('oc exec deploy/web -n qa63 -- cat /nope');
        const catMessage = messageOf(catResult);
        const grepResult = run('oc exec deploy/web -n qa63 -- grep nope');
        const grepMessage = messageOf(grepResult);
        if (
          fixtureOk &&
          catResult?.error === true &&
          catMessage.includes('cat: /nope: No such file or directory') &&
          /command terminated with exit code 1\s*$/.test(catMessage) &&
          grepResult?.error === true &&
          grepMessage.trim() === 'command terminated with exit code 1'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`cat /nope\` must exit 1 with its own error and \`grep\` with no match must be silent exit 1 (#63C): ${JSON.stringify({ cat: catMessage, grep: grepMessage })}`
          );
        }

        // #63C: `oc rsh` shares the same remote exit-status contract as
        // `oc exec` — a failed command terminates the session with its code.
        const rshResult = run('oc rsh -n qa63 deploy/web ls /nope');
        const rshMessage = messageOf(rshResult);
        if (
          fixtureOk &&
          rshResult?.error === true &&
          rshMessage.includes("ls: cannot access '/nope': No such file or directory") &&
          /command terminated with exit code 2\s*$/.test(rshMessage)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `\`oc rsh … ls /nope\` must report the real exit 2 like \`oc exec\` (#63C): ${JSON.stringify({ rsh: rshMessage })}`
          );
        }

        // #63D: Lab 13 ships a starter manifest, so the description must tell
        // the learner to apply `challenges/payments-networkpolicy.yaml` (or
        // write their own) — never pretend a default-deny policy is seeded or
        // already applied.
        const lab13 = (challengeMod.CHALLENGES || []).find((challenge) => challenge.id === 13);
        const lab13Description = String(lab13?.description || '');
        const lab13Hint = String(lab13?.hints?.[0] || '');
        const lab13ManifestFiles = lab13?.manifestFiles || [];
        const lab13FocusFiles = lab13?.focusFiles || [];
        if (
          lab13 &&
          /challenges\/payments-networkpolicy\.yaml/.test(lab13Description) &&
          /\bapply\b/i.test(lab13Description) &&
          !/seeded/i.test(lab13Description) &&
          !/already\s+(?:applied|seeded)/i.test(lab13Description) &&
          lab13ManifestFiles.includes('challenges/payments-networkpolicy.yaml') &&
          lab13FocusFiles.includes('challenges/payments-networkpolicy.yaml') &&
          /apply\s+-f\s+challenges\/payments-networkpolicy\.yaml/.test(lab13Hint) &&
          !/seeded/i.test(lab13Hint) &&
          !/already\s+(?:applied|seeded)/i.test(lab13Hint)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `Lab 13 must point at the provided challenges/payments-networkpolicy.yaml, instruct applying it, and not claim a seeded/applied default-deny policy (#63D): ${JSON.stringify({ description: lab13Description, hint: lab13Hint, manifestFiles: lab13ManifestFiles, focusFiles: lab13FocusFiles })}`
          );
        }

        // #63D: the project starts WITHOUT a NetworkPolicy — only Nodes,
        // Project, Deployments and Services are seeded (the learner applies the
        // provided policy first).
        const lab13StartingResources = lab13?.startingResources || [];
        const lab13SeededPolicies = lab13StartingResources.filter(
          (resource) => resource?.kind === 'NetworkPolicy'
        );
        const lab13PaymentsProject = lab13StartingResources.some(
          (resource) => resource?.kind === 'Project' && resource?.name === 'payments'
        );
        if (lab13 && lab13SeededPolicies.length === 0 && lab13PaymentsProject) {
          passed();
        } else {
          fail(
            'fidelity',
            `Lab 13 startingResources must seed the payments Project and no NetworkPolicy object (nothing is applied at start) (#63D): ${JSON.stringify(lab13StartingResources.map((resource) => `${resource?.kind}/${resource?.name}`))}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#63 dynamic fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4h. Issue #64–#65 describe/exec/events/metrics fidelity locks (static) ─
// The browser suite sections `qa-issue64` / `qa-issue65` prove the behaviour
// end-to-end. These Node locks fail the fast static gate if a refactor silently
// reintroduces the #64/#65 bugs (no browser, no long sleeps): kubectl-style
// `oc describe` output (secret/configmap env placeholders, probe lines with the
// `--initial-delay-seconds` value, `key: value` annotations, ConfigMap volume
// blocks), the `oc exec -- sh -c '<script>'` container-shell contract (env
// expansion, `exit` builtin, `id`), Deployment-only describe events with the
// per-rollout `ScalingReplicaSet` up/down series, and sorted `oc adm top nodes`.
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  if (!engineMod?.GameEngine || !sandboxMod?.SandboxMode || !commandBarMod?.CommandBar) {
    fail('fidelity', '#64/#65: GameEngine/SandboxMode/CommandBar are not importable for the locks');
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      // The sandbox seeds random container failures (0.002) that could restart
      // the fixture Pods mid-lock; these locks assert fixed describe/exec
      // semantics, so disable them for deterministic output (#63 lock precedent).
      simulation.randomFailureRate = 0;
      const cluster = engine.cluster;
      const windowShim = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
          manifestEngine: null,
        },
      };
      globalThis.window = windowShim;
      try {
        const cliBar = new commandBarMod.CommandBar();
        const run = (command) => cliBar.executeCommand(command);
        const messageOf = (result) => String(result?.message ?? '');
        /** True once the Deployment controller has finished its current rollout. */
        const deploymentSettled = (namespace, deploymentName = 'web') => {
          const deployment = (cluster.getByKindAndNamespace('Deployment', namespace) || []).find(
            (entry) => entry.metadata?.name === deploymentName
          );
          if (!deployment) return false;
          const generation = Number(deployment.metadata?.generation) || 0;
          const desired = Number(deployment.spec?.replicas ?? 1) || 0;
          const status = deployment.status || {};
          const progressing = (status.conditions || []).find(
            (condition) => condition.type === 'Progressing'
          );
          return (
            Number(status.observedGeneration) >= generation &&
            status.replicas === desired &&
            status.updatedReplicas === desired &&
            status.availableReplicas === desired &&
            Number(status.unavailableReplicas || 0) === 0 &&
            progressing?.reason === 'NewReplicaSetAvailable'
          );
        };
        /** Tick until predicate() is true, or exhaust maxTicks (0.05 s steps). */
        const tickUntil = (predicate, maxTicks = 1200) => {
          for (let index = 0; index < maxTicks; index += 1) {
            if (predicate()) return true;
            simulation.tick(0.05);
          }
          return predicate();
        };
        const runningPodName = (namespace, prefix) => {
          const pod = (cluster.getByKindAndNamespace('Pod', namespace) || []).find(
            (entry) =>
              new RegExp(`^${prefix}-`).test(String(entry.metadata?.name || '')) &&
              entry.status?.phase === 'Running'
          );
          return pod?.metadata?.name || null;
        };
        /** `oc`/kubectl age forms: `0s`, `25s`, `3m`, `2m10s`, `1h`, `2d`. */
        const parseAgeSeconds = (raw) => {
          const text = String(raw ?? '').trim();
          const match = text.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
          if (!match || !text) return Number.NaN;
          const [, days, hours, minutes, seconds] = match;
          if (!days && !hours && !minutes && !seconds) return Number.NaN;
          return (
            Number(days || 0) * 86400 +
            Number(hours || 0) * 3600 +
            Number(minutes || 0) * 60 +
            Number(seconds || 0)
          );
        };
        /** The value column (0-based index of the first value char) of a `Key:  value` line. */
        const valueColumn = (line) => {
          const match = String(line ?? '').match(/^(\s*[A-Za-z]+:)(\s+)/);
          return match ? match[0].length : -1;
        };

        // Fixture A: the issue #64 command sequence (secret/configmap env,
        // readiness probe with an explicit 2 s initial delay, liveness probe).
        const project64 = run('oc new-project qa64lock');
        const deployment64 = run(
          'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa64lock'
        );
        const podCreated64 = tickUntil(() => runningPodName('qa64lock', 'web') !== null);
        run('oc create secret generic db --from-literal=DB_PASS=s3cr3t -n qa64lock');
        run('oc set env deploy/web --from=secret/db -n qa64lock');
        tickUntil(() => deploymentSettled('qa64lock'));
        run('oc set env deploy/web APP_MODE=prod -n qa64lock');
        tickUntil(() => deploymentSettled('qa64lock'));
        run(
          'oc set probe deploy/web --readiness --get-url=http://:8080/ --initial-delay-seconds=2 -n qa64lock'
        );
        tickUntil(() => deploymentSettled('qa64lock'));
        run(
          'oc set probe deploy/web --liveness --get-url=http://:8080/ --initial-delay-seconds=3 -n qa64lock'
        );
        tickUntil(() => deploymentSettled('qa64lock'));
        run('oc create configmap cfg --from-literal=APP_LOG=debug -n qa64lock');
        run('oc set env deploy/web --from=configmap/cfg -n qa64lock');
        tickUntil(() => deploymentSettled('qa64lock'));
        const pod64 = runningPodName('qa64lock', 'web');
        const fixture64Ok =
          !project64?.error && !deployment64?.error && podCreated64 && Boolean(pod64);
        const describe64 = messageOf(run('oc describe deploy/web -n qa64lock'));
        const readinessJson = messageOf(
          run(
            'oc get deploy web -o jsonpath={.spec.template.spec.containers[0].readinessProbe.initialDelaySeconds} -n qa64lock'
          )
        ).trim();

        // #64A: secret env must render the kubectl placeholder, never raw JSON.
        if (
          fixture64Ok &&
          /DB_PASS:\s+<set to the key 'DB_PASS' in secret 'db'>\s+Optional: false/.test(
            describe64
          ) &&
          !/\{"secretKeyRef"|\{"configMapKeyRef"/.test(describe64)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#64: describe deploy must render the secret env as \`<set to the key 'DB_PASS' in secret 'db'>  Optional: false\` and never the raw JSON valueFrom (#64A): ${JSON.stringify(describe64.split('\n').filter((line) => /DB_PASS/.test(line)))}`
          );
        }

        // #64A: configmap env uses the `of config map` wording.
        if (
          fixture64Ok &&
          /APP_LOG:\s+<set to the key 'APP_LOG' of config map 'cfg'>\s+Optional: false/.test(
            describe64
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#64: describe deploy must render the configmap env as \`<set to the key 'APP_LOG' of config map 'cfg'>  Optional: false\` (#64A): ${JSON.stringify(describe64.split('\n').filter((line) => /APP_LOG/.test(line)))}`
          );
        }

        // #64A: the probe line carries the real kubectl tokens, and the
        // `--initial-delay-seconds` flag reaches the API object.
        if (
          fixture64Ok &&
          readinessJson === '2' &&
          /Readiness:\s+http-get\s+http:\/\/:8080\/\s+delay=2s\s+timeout=1s\s+period=10s\s+#success=1\s+#failure=3/.test(
            describe64
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#64: describe deploy must print \`Readiness:  http-get http://:8080/ delay=2s timeout=1s period=10s #success=1 #failure=3\` and jsonpath readinessProbe.initialDelaySeconds must be 2 (#64A): ${JSON.stringify({ readinessJson, lines: describe64.split('\n').filter((line) => /Readiness:/.test(line)) })}`
          );
        }

        // #64A: liveness probes get the same treatment.
        if (fixture64Ok && /Liveness:\s+http-get\s+http:\/\/:8080\/\s+delay=3s/.test(describe64)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#64: describe deploy must print the Liveness probe line with delay=3s (#64A): ${JSON.stringify(describe64.split('\n').filter((line) => /Liveness:/.test(line)))}`
          );
        }

        // #64B: `oc exec -- sh -c '<script>'` runs a container shell — single
        // quotes reach the shell, double quotes expand on the workstation.
        const execEnv = messageOf(
          run("oc exec deploy/web -n qa64lock -- sh -c 'echo $DB_PASS $APP_MODE'")
        );
        const execHostname = messageOf(
          run("oc exec deploy/web -n qa64lock -- sh -c 'echo $HOSTNAME'")
        );
        const execEmpty = messageOf(
          run('oc exec deploy/web -n qa64lock -- sh -c "echo $APP_MODE"')
        );
        const execPrintenv = messageOf(run('oc exec deploy/web -n qa64lock -- printenv DB_PASS'));
        if (
          fixture64Ok &&
          execEnv.trim() === 's3cr3t prod' &&
          execHostname.trim() === pod64 &&
          execEmpty.trim() === '' &&
          execPrintenv.trim() === 's3cr3t'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#64: \`oc exec -- sh -c '<script>'\` must run a container shell ($DB_PASS/$APP_MODE -> \`s3cr3t prod\`, $HOSTNAME -> pod name, double-quoted $APP_MODE -> empty) and printenv must keep resolving (#64B): ${JSON.stringify({ execEnv, execHostname, pod64, execEmpty, execPrintenv })}`
          );
        }

        // Fixture B: the issue #65 command sequence (three rollouts, a ConfigMap
        // volume Deployment, exec builtins and node metrics).
        run('oc new-project qa65lock');
        run('oc create configmap cfg --from-literal=APP_LOG=debug -n qa65lock');
        const deployment65 = run(
          'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa65lock'
        );
        const initialSettled65 = tickUntil(() => deploymentSettled('qa65lock'));
        for (let rollout = 1; rollout <= 3; rollout += 1) {
          run(`oc set env deploy/web ROLLOUT=${rollout} -n qa65lock`);
          tickUntil(() => deploymentSettled('qa65lock'));
        }
        const pod65 = runningPodName('qa65lock', 'web');
        const fixture65Ok = !deployment65?.error && initialSettled65 && Boolean(pod65);
        const describe65 = messageOf(run('oc describe deploy/web -n qa65lock'));
        const podDescribe65 = messageOf(run(`oc describe pod ${pod65} -n qa65lock`));
        const replicaSets65 = (
          cluster.getByKindAndNamespace('ReplicaSet', 'qa65lock') || []
        ).filter((entry) => /^web-/.test(String(entry.metadata?.name || '')));

        // #65A: annotations print as `key: value`; labels keep `key=value`.
        const deployAnnotationBlock = (() => {
          const at = describe65.search(/^Annotations:/m);
          if (at < 0) return '';
          const rest = describe65.slice(at);
          const end = rest.search(/^(?:Selector:|Replicas:)/m);
          return end >= 0 ? rest.slice(0, end) : rest;
        })();
        const podAnnotationBlock = (() => {
          const at = podDescribe65.search(/^Annotations:/m);
          if (at < 0) return '';
          const rest = podDescribe65.slice(at);
          const end = rest.search(/^Status:/m);
          return end >= 0 ? rest.slice(0, end) : rest;
        })();
        if (
          fixture64Ok &&
          fixture65Ok &&
          /deployment\.kubernetes\.io\/revision: \d+/.test(deployAnnotationBlock) &&
          !/deployment\.kubernetes\.io\/revision=/.test(describe65) &&
          /^Selector:\s+app=web/m.test(describe65) &&
          /openshift\.io\/scc: restricted-v2/.test(podAnnotationBlock) &&
          !/openshift\.io\/scc=/.test(podDescribe65) &&
          /^Labels:\s+.*app=web.*pod-template-hash=/m.test(podDescribe65)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#65: describe must print annotations as \`key: value\` (deployment.kubernetes.io/revision / openshift.io/scc) and labels as \`key=value\` (#65A): ${JSON.stringify({ deployAnnotations: deployAnnotationBlock, podAnnotations: podAnnotationBlock.slice(0, 400), deploySelector: describe65.split('\n').filter((line) => /^Selector:/.test(line)), podLabels: podDescribe65.split('\n').filter((line) => /^Labels:/.test(line)) })}`
          );
        }

        // #65B: describe deploy lists only the Deployment controller's own
        // ScalingReplicaSet series — no ReplicaSet SuccessfulCreate rows, one
        // `Scaled up … to 1` per ReplicaSet, and `Scaled down … to 0 from 1`
        // rows for retired ReplicaSets with ages consistent with `oc get rs`.
        const eventsAt65 = describe65.search(/^Events:/m);
        const eventsBlock65 = eventsAt65 >= 0 ? describe65.slice(eventsAt65) : '';
        const eventLines65 = eventsBlock65
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const upRows65 = eventLines65
          .map((line) =>
            line.match(
              /^Normal\s+ScalingReplicaSet\s+(\S+)\s+deployment-controller\s+Scaled up replica set (\S+) to (\d+)$/
            )
          )
          .filter(Boolean);
        const downRows65 = eventLines65
          .map((line) =>
            line.match(
              /^Normal\s+ScalingReplicaSet\s+(\S+)\s+deployment-controller\s+Scaled down replica set (\S+) to 0 from (\d+)$/
            )
          )
          .filter(Boolean);
        const replicaSetNames65 = new Set(replicaSets65.map((entry) => entry.metadata.name));
        const newestReplicaSet65 = (describe65.match(/^NewReplicaSet:\s+(\S+)/m) || [])[1] || '';
        const newestSet65 =
          replicaSets65.find((entry) => entry.metadata.name === newestReplicaSet65) || null;
        const newestUp65 = upRows65.find((match) => match[2] === newestReplicaSet65) || null;
        const eventAge65 = newestUp65 ? parseAgeSeconds(newestUp65[1]) : Number.NaN;
        const replicaSetAge65 = newestSet65
          ? (Date.now() - Date.parse(newestSet65.metadata.creationTimestamp)) / 1000
          : Number.NaN;
        const eventsOk65 =
          eventsAt65 >= 0 &&
          !/SuccessfulCreate/.test(eventsBlock65) &&
          !/replicaset-controller/.test(eventsBlock65) &&
          replicaSetNames65.size === 4 &&
          upRows65.length === replicaSetNames65.size &&
          upRows65.every((match) => replicaSetNames65.has(match[2]) && match[3] === '1') &&
          downRows65.length >= 1 &&
          downRows65.every((match) => replicaSetNames65.has(match[2]) && match[3] === '1') &&
          Boolean(newestUp65) &&
          Number.isFinite(eventAge65) &&
          Number.isFinite(replicaSetAge65) &&
          Math.abs(eventAge65 - replicaSetAge65) <= 10;
        if (fixture65Ok && eventsOk65) {
          passed();
        } else {
          fail(
            'fidelity',
            `#65: describe deploy events must be the Deployment's own ScalingReplicaSet series (no SuccessfulCreate / replicaset-controller, one Scaled up … to 1 per ReplicaSet, Scaled down … to 0 from 1 rows for retired sets, newest age within 10s of oc get rs AGE) (#65B): ${JSON.stringify({ events: eventsBlock65.slice(0, 800), replicaSetNames: [...replicaSetNames65], newestReplicaSet65, eventAge65, replicaSetAge65 })}`
          );
        }

        // #65C: a DEployment with a ConfigMap volume renders the kubectl
        // Type/Name/Optional block (never the old bare `Type:  configMap`).
        run(
          'oc create deployment volweb --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa65lock'
        );
        run(
          `oc patch deployment/volweb -n qa65lock -p '{"spec":{"template":{"spec":{"containers":[{"name":"httpd-24","image":"registry.access.redhat.com/ubi9/httpd-24","volumeMounts":[{"name":"cfg","mountPath":"/etc/cfg"}]}],"volumes":[{"name":"cfg","configMap":{"name":"cfg"}}]}}}}'`
        );
        tickUntil(() => deploymentSettled('qa65lock', 'volweb'));
        const volumeDescribe = messageOf(run('oc describe deploy volweb -n qa65lock'));
        const volumeLines = volumeDescribe
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const volumeNameLine = volumeLines.find((line) => /^cfg:$/.test(line)) || '';
        const volumeTypeLine =
          volumeLines.find((line) =>
            /^Type:\s+ConfigMap \(a volume populated by a ConfigMap\)$/.test(line)
          ) || '';
        const volumeKeyNameLine = volumeLines.find((line) => /^Name:\s+cfg$/.test(line)) || '';
        const volumeOptionalLine =
          volumeLines.find((line) => /^Optional:\s+false$/.test(line)) || '';
        if (
          fixture65Ok &&
          Boolean(volumeNameLine) &&
          Boolean(volumeTypeLine) &&
          Boolean(volumeKeyNameLine) &&
          Boolean(volumeOptionalLine) &&
          !/Type:\s+configMap\b/.test(volumeDescribe) &&
          valueColumn(volumeTypeLine) === valueColumn(volumeKeyNameLine) &&
          valueColumn(volumeTypeLine) === valueColumn(volumeOptionalLine)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#65: describe deploy must render the ConfigMap volume block (cfg: Type: ConfigMap (a volume populated by a ConfigMap) / Name: cfg / Optional: false, aligned), never the old bare \`Type:  configMap\` (#65C): ${JSON.stringify(volumeDescribe.slice(volumeDescribe.search(/^  Volumes:/m) >= 0 ? volumeDescribe.search(/^  Volumes:/m) : -600))}`
          );
        }

        // #65D: shell builtins inside `sh -c` — `exit N` status, bare `id -u`
        // / `id -g` / `id -un` values, while `oc exec -- id` keeps the full line.
        const exitResult = run('oc exec deploy/web -n qa65lock -- sh -c "exit 3"; echo rc=$?');
        const idResult = messageOf(run('oc exec deploy/web -n qa65lock -- id')).trim();
        const idUid = (idResult.match(/^uid=(\d+)\b/) || [])[1] || '';
        const idUser = messageOf(run('oc exec deploy/web -n qa65lock -- sh -c "id -u"')).trim();
        const idGroup = messageOf(run('oc exec deploy/web -n qa65lock -- sh -c "id -g"')).trim();
        const idUserName = messageOf(
          run('oc exec deploy/web -n qa65lock -- sh -c "id -un"')
        ).trim();
        if (
          fixture65Ok &&
          exitResult?.error === false &&
          /command terminated with exit code 3/.test(messageOf(exitResult)) &&
          /^rc=3$/m.test(messageOf(exitResult)) &&
          /^uid=\d+ gid=0\(root\) groups=/.test(idResult) &&
          /^\d+$/.test(idUser) &&
          idUser === idUid &&
          idGroup === '0' &&
          idUserName === idUid &&
          !/uid=/.test(idUserName)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#65: container-shell builtins must behave like bash ('exit 3' -> \`command terminated with exit code 3\` + \`rc=3\`; \`id -u\`/\`id -g\`/\`id -un\` bare values; \`oc exec -- id\` full uid/gid/groups line) (#65D): ${JSON.stringify({ exit: messageOf(exitResult), error: exitResult?.error, idResult, idUser, idGroup, idUserName })}`
          );
        }

        // #65E: `oc adm top nodes` is sorted by NAME, the control plane is the
        // busiest node, and the two workers report distinct usage.
        const topNodesMessage = messageOf(run('oc adm top nodes'));
        const topNodeLines = topNodesMessage
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const parseCpuMillis = (raw) => {
          const text = String(raw ?? '').trim();
          if (/m$/.test(text)) return Number.parseFloat(text) || 0;
          const cores = Number.parseFloat(text);
          return Number.isFinite(cores) ? cores * 1000 : 0;
        };
        const parseMemoryBytes = (raw) => {
          const text = String(raw ?? '').trim();
          const match = text.match(/^([\d.]+)([KMGT]i)?$/);
          if (!match) return Number.NaN;
          const value = Number.parseFloat(match[1]);
          const unit = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[match[2]];
          return unit ? value * unit : value;
        };
        const topNodeRows = topNodeLines
          .slice(1)
          .map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()))
          .map((cells) => ({
            name: cells[0] || '',
            cpu: cells[1] || '',
            cpuPercent: cells[2] || '',
            memory: cells[3] || '',
          }))
          .filter((row) => row.name);
        const masterRow = topNodeRows.find((row) => row.name === 'master-0') || {};
        const workerRows = topNodeRows.filter((row) => /^worker-/.test(row.name));
        if (
          fixture65Ok &&
          /^NAME\s+CPU\(cores\)\s+CPU%\s+MEMORY\(bytes\)\s+MEMORY%$/.test(topNodeLines[0] || '') &&
          JSON.stringify(topNodeRows.map((row) => row.name)) ===
            JSON.stringify(['master-0', 'worker-0', 'worker-1']) &&
          parseCpuMillis(masterRow.cpu) >= 2000 &&
          parseMemoryBytes(masterRow.memory) >= 8 * 1024 ** 3 &&
          parseMemoryBytes(masterRow.memory) <= 12 * 1024 ** 3 &&
          workerRows.every(
            (row) => Number.parseInt(masterRow.cpuPercent, 10) > Number.parseInt(row.cpuPercent, 10)
          ) &&
          workerRows.length === 2 &&
          (workerRows[0].cpu !== workerRows[1].cpu || workerRows[0].memory !== workerRows[1].memory)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#65: \`oc adm top nodes\` must keep the real header, sort rows by NAME, make the control plane the busiest (CPU >= 2000m, MEMORY 8–12Gi, greatest CPU%) and keep the worker rows distinct (#65E): ${JSON.stringify({ header: topNodeLines[0], rows: topNodeRows })}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#64/#65 dynamic fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4i. Issue #66–#67 cache policy and player-set probe evaluation locks ──
// The browser suite sections `qa-issue66` / `qa-issue67` prove these end-to-end.
// These Node locks fail the fast static gate if a refactor silently reintroduces
// the #66 stale-module cache policy (unversioned /js served with max-age=86400
// + stale-while-revalidate) or the #67 "player probes are never evaluated / an
// exec probe is stored as httpGet /healthz" bugs (no browser, no long sleeps).
{
  // ── #66 — unversioned app assets must revalidate; images/fonts stay cached ─
  try {
    const config = JSON.parse(read('vercel.json'));
    /** Translate a Vercel header `source` pattern to an anchored RegExp. */
    const sourceMatches = (source, pathname) => {
      let pattern = String(source)
        .replace(/\\\./g, '\u0000DOT')
        .replace(/\(\.\*\)/g, '\u0000STAR')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = pattern
        .replace(/\u0000STAR/g, '.*')
        .replace(/\u0000DOT/g, '\\.')
        .replace(/\\\(([^)]*)\\\)/g, (match, inner) =>
          inner.includes('\\|') ? `(?:${inner.replace(/\\\|/g, '|')})` : match
        );
      try {
        return new RegExp(`^${pattern}$`).test(pathname);
      } catch {
        return false;
      }
    };
    const cacheRules = [];
    for (const rule of config.headers || []) {
      for (const header of rule.headers || []) {
        if (String(header.key).toLowerCase() === 'cache-control') {
          cacheRules.push({ source: String(rule.source), value: String(header.value) });
        }
      }
    }
    const matchingRules = (pathname) =>
      cacheRules.filter((rule) => sourceMatches(rule.source, pathname));
    const revalidates = (value) =>
      /(?:^|[,\s])max-age=0(?:[,\s]|$)/.test(value) && /must-revalidate/.test(value);
    const longLived = (value) => {
      const maxAge = String(value).match(/(?:^|[,\s])max-age=(\d+)/);
      return Boolean(maxAge) && Number(maxAge[1]) >= 86400;
    };
    const expectRevalidates = (pathname, label) => {
      const hits = matchingRules(pathname);
      if (hits.length > 0 && hits.every((hit) => revalidates(hit.value))) {
        passed();
      } else {
        fail(
          'fidelity',
          `#66: ${label} — Cache-Control for ${pathname} must be the Vercel-ETag revalidation policy \`public, max-age=0, must-revalidate\` (got ${JSON.stringify(hits.map((hit) => `${hit.source} => ${hit.value}`))})`
        );
      }
    };
    expectRevalidates(
      '/js/engine/GameEngine.js',
      'unversioned ES modules must revalidate after a release'
    );
    expectRevalidates(
      '/js/ui/CommandBar.js',
      'every unversioned /js module path must revalidate after a release'
    );
    expectRevalidates('/style.css', 'unversioned CSS must revalidate with the modules');
    expectRevalidates('/start.css', 'the start-page CSS must revalidate with the modules');
    expectRevalidates('/', 'the entry document must revalidate');
    expectRevalidates('/index.html', 'index.html must revalidate');
    expectRevalidates('/draw', 'the /draw entry must revalidate');
    expectRevalidates('/draw.html', 'draw.html must revalidate');
    const appCodeHits = [
      '/js/engine/GameEngine.js',
      '/js/ui/CommandBar.js',
      '/style.css',
      '/index.html',
      '/',
    ].flatMap((pathname) => matchingRules(pathname));
    const staleHits = appCodeHits.filter((hit) =>
      /stale-while-revalidate|s-maxage/.test(hit.value)
    );
    if (staleHits.length === 0) {
      passed();
    } else {
      fail(
        'fidelity',
        `#66: unversioned app code must not keep stale-while-revalidate/s-maxage (a returning visitor could run a stale release for days): ${JSON.stringify(staleHits)}`
      );
    }
    const imageHits = [
      '/screenshot.png',
      '/og-image.png',
      '/img/start/levels.png',
      '/favicon.ico',
    ].flatMap((pathname) => matchingRules(pathname));
    if (imageHits.length > 0 && imageHits.every((hit) => longLived(hit.value))) {
      passed();
    } else {
      fail(
        'fidelity',
        `#66: images/fonts must keep their long-lived cache (max-age >= 86400) — got ${JSON.stringify(imageHits)}`
      );
    }
  } catch (err) {
    fail('fidelity', `#66: vercel.json cache-policy lock could not run: ${err.message}`);
  }

  // ── #67 — player-set probes are parsed into a real handler and evaluated ──
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  if (!engineMod?.GameEngine || !sandboxMod?.SandboxMode || !commandBarMod?.CommandBar) {
    fail('fidelity', '#67: GameEngine/SandboxMode/CommandBar are not importable for the locks');
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      const simulation = engine.simulation;
      simulation.ensureOLMDefaultsSync();
      // The sandbox seeds random container failures (0.002) that could restart
      // the fixture Pods mid-lock; these locks assert fixed probe semantics.
      simulation.randomFailureRate = 0;
      const cluster = engine.cluster;
      const windowShim = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
          manifestEngine: null,
        },
      };
      globalThis.window = windowShim;
      try {
        const cliBar = new commandBarMod.CommandBar();
        windowShim.game.commandBar = cliBar;
        const run = (command) => cliBar.executeCommand(command);
        const messageOf = (result) => String(result?.message ?? '');
        const tickBy = (seconds) => {
          const steps = Math.ceil(seconds / 0.05);
          for (let step = 0; step < steps; step += 1) simulation.tick(0.05);
        };
        const tickUntil = (predicate, maxSeconds = 90) => {
          for (let elapsed = 0; elapsed < maxSeconds; elapsed += 0.05) {
            if (predicate()) return true;
            simulation.tick(0.05);
          }
          return predicate();
        };
        const podsIn = (namespace) => cluster.getByKindAndNamespace('Pod', namespace) || [];
        const podRows = (namespace) => {
          const out = messageOf(run(`oc get pods -n ${namespace}`));
          const lines = out.split('\n').filter((line) => line.trim() !== '');
          return lines.slice(1).map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()));
        };
        const podRow = (namespace, prefix) =>
          podRows(namespace).find((cells) => String(cells[0] || '').startsWith(prefix)) || null;
        const runningPod = (namespace, prefix) =>
          podsIn(namespace).find(
            (pod) =>
              String(pod.metadata?.name || '').startsWith(prefix) && pod.status?.phase === 'Running'
          ) || null;
        const hostOf = (kind, name, namespace) =>
          messageOf(
            run(`oc get ${kind} ${name} -n ${namespace} -o jsonpath='{.spec.host}'`)
          ).trim();
        const curlStatus = (url) =>
          messageOf(run(`curl -s -o /dev/null -w "%{http_code}" ${url}`)).trim();
        const deploymentSettled = (namespace, name) => {
          const deployment = cluster.getByName('Deployment', name, namespace);
          if (!deployment) return false;
          const generation = Number(deployment.metadata?.generation) || 0;
          const desired = Number(deployment.spec?.replicas ?? 1) || 0;
          const status = deployment.status || {};
          const progressing = (status.conditions || []).find(
            (condition) => condition.type === 'Progressing'
          );
          return (
            Number(status.observedGeneration) >= generation &&
            status.replicas === desired &&
            status.updatedReplicas === desired &&
            status.availableReplicas === desired &&
            Number(status.unavailableReplicas || 0) === 0 &&
            progressing?.reason === 'NewReplicaSetAvailable'
          );
        };
        // Wire the container exec simulator exactly like index.html does: an
        // exec probe runs against the same simulated Pod filesystem as
        // `oc exec`, so `cat /tmp/healthy` really fails with ENOENT.
        simulation.setContainerExecEvaluator((pod, containerName, argv) =>
          cliBar._simulateExecCommand(argv, pod, containerName)
        );

        const project = run('oc new-project qa67lock');
        /** Newest Pod of a name prefix (a stalled RollingUpdate can keep an old Ready Pod). */
        const latestPod = (namespace, prefix) =>
          podsIn(namespace)
            .filter((pod) => String(pod.metadata?.name || '').startsWith(prefix))
            .sort((left, right) =>
              String(left.metadata?.creationTimestamp || '').localeCompare(
                String(right.metadata?.creationTimestamp || '')
              )
            )
            .pop() || null;

        // #67A: the issue's exact command must store an exec handler (not the
        // old fallback `httpGet /healthz`) with the API-server timing defaults.
        const webCreate = run(
          'oc create deployment web --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const probeSet = run('oc set probe deploy/web -n qa67lock --liveness -- cat /tmp/healthy');
        const webDeployment = cluster.getByName('Deployment', 'web', 'qa67lock');
        const livenessProbe = webDeployment?.spec?.template?.spec?.containers?.[0]?.livenessProbe;
        const execCommand = Array.isArray(livenessProbe?.exec?.command)
          ? livenessProbe.exec.command.map(String)
          : [];
        const fixtureOk = Boolean(
          project && !project.error && webCreate && !webCreate.error && probeSet && !probeSet.error
        );
        if (
          fixtureOk &&
          execCommand.join(' ') === 'cat /tmp/healthy' &&
          !livenessProbe?.httpGet &&
          !livenessProbe?.tcpSocket &&
          livenessProbe?.initialDelaySeconds === 0 &&
          livenessProbe?.periodSeconds === 10 &&
          livenessProbe?.timeoutSeconds === 1 &&
          livenessProbe?.successThreshold === 1 &&
          livenessProbe?.failureThreshold === 3
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: \`oc set probe deploy/web -n qa67lock --liveness -- cat /tmp/healthy\` must store livenessProbe.exec.command ['cat','/tmp/healthy'] with the API defaults and no httpGet (#67A): ${JSON.stringify(livenessProbe)}`
          );
        }
        const describeWeb = messageOf(run('oc describe deploy/web -n qa67lock'));
        if (
          /Liveness:\s+exec \[cat \/tmp\/healthy\] delay=0s timeout=1s period=10s #success=1 #failure=3/.test(
            describeWeb
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: describe deploy must print the exec probe line \`Liveness:  exec [cat /tmp/healthy] delay=0s timeout=1s period=10s #success=1 #failure=3\` (#67A): ${JSON.stringify(describeWeb.split('\n').filter((line) => /Liveness:/.test(line)))}`
          );
        }

        // #67D: the failing exec liveness probe (API default 10 s period,
        // #failure=3) must restart the container after failureThreshold with
        // kubectl's real kubelet events and reach CrashLoopBackOff.
        const livenessRestarted = tickUntil(() => {
          const pod = latestPod('qa67lock', 'web-');
          const status = pod?.status?.containerStatuses?.[0];
          return Boolean(
            status &&
            (Number(status.restartCount || 0) > 0 ||
              status.state?.waiting?.reason === 'CrashLoopBackOff')
          );
        }, 120);
        const livenessPod = latestPod('qa67lock', 'web-');
        const describeLiveness = livenessPod
          ? messageOf(run(`oc describe pod/${livenessPod.metadata.name} -n qa67lock`))
          : '';
        if (livenessRestarted) {
          passed();
        } else {
          fail(
            'fidelity',
            '#67: a failing liveness probe must restart the container after failureThreshold (RESTARTS/CrashLoopBackOff) (#67D)'
          );
        }
        if (
          describeLiveness.includes(
            'Liveness probe failed: cat: /tmp/healthy: No such file or directory'
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: describe pod must contain \`Liveness probe failed: cat: /tmp/healthy: No such file or directory\` (#67D): ${JSON.stringify(describeLiveness.split('\n').filter((line) => /Liveness probe/.test(line)))}`
          );
        }
        if (/Container \S+ failed liveness probe, will be restarted/.test(describeLiveness)) {
          passed();
        } else {
          fail(
            'fidelity',
            '#67: describe pod must contain the real kubelet `Container <name> failed liveness probe, will be restarted` event (#67D)'
          );
        }
        const livenessRow = podRows('qa67lock').find((cells) =>
          String(cells[0] || '').startsWith('web-')
        );
        if (
          livenessRow &&
          ((livenessRow[3] && livenessRow[3] !== '0') ||
            /CrashLoopBackOff/.test(livenessRow[2] || ''))
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: \`oc get pods\` must show the restarted container (RESTARTS > 0 or CrashLoopBackOff) (#67D): ${JSON.stringify(livenessRow)}`
          );
        }

        // #67E: a liveness exec probe whose command succeeds never restarts.
        const webokCreate = run(
          'oc create deployment webok --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const webokProbe = run(
          'oc set probe deploy/webok -n qa67lock --liveness --period-seconds=1 --failure-threshold=1 -- cat /etc/os-release'
        );
        const healthyExec = tickUntil(() => {
          const pod = latestPod('qa67lock', 'webok-');
          return Boolean(
            pod?.isConditionTrue('Ready') &&
            Number(pod.status?.containerStatuses?.[0]?.restartCount || 0) === 0
          );
        }, 120);
        const healthyPod = latestPod('qa67lock', 'webok-');
        const healthyRestarts = Number(
          healthyPod?.status?.containerStatuses?.[0]?.restartCount || 0
        );
        if (
          webokCreate &&
          !webokCreate.error &&
          webokProbe &&
          !webokProbe.error &&
          healthyExec &&
          healthyRestarts === 0
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a succeeding exec liveness probe (\`cat /etc/os-release\`) must keep the Pod Ready with 0 restarts (#67E): ${JSON.stringify({ healthyExec, healthyRestarts })}`
          );
        }

        // #67B: a readiness probe on a closed port fails after failureThreshold —
        // Ready=False, kubectl's exact Unhealthy message, no Service endpoint and
        // a 503 from the Route. The probe is installed BEFORE the first tick so
        // the single initial Pod is the one that fails; a stalled RollingUpdate
        // of an already-Ready Pod would keep that old Pod in the endpoints (real
        // k8s behavior that must not be faked).
        const p2Create = run(
          'oc create deployment p2 --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const p2Expose = run('oc expose deployment p2 -n qa67lock');
        const p2RouteCreate = run('oc expose service p2 -n qa67lock');
        const readinessSet = run(
          'oc set probe deploy/p2 -n qa67lock --readiness --get-url=http://:9999/nope'
        );
        tickBy(3);
        const p2Host = hostOf('route', 'p2', 'qa67lock');
        const readinessFailed = tickUntil(() => {
          const pod = latestPod('qa67lock', 'p2-');
          return Boolean(
            pod &&
            pod.status?.phase === 'Running' &&
            pod.isConditionTrue('Ready') === false &&
            pod.status?.containerStatuses?.[0]?.started
          );
        }, 120);
        const p2Pod = latestPod('qa67lock', 'p2-');
        const p2Ip = String(p2Pod?.status?.podIP || '');
        const p2Row = podRows('qa67lock').find((cells) => String(cells[0] || '').startsWith('p2-'));
        const describeP2 = p2Pod
          ? messageOf(run(`oc describe pod/${p2Pod.metadata.name} -n qa67lock`))
          : '';
        const p2Service = cluster.getByName('Service', 'p2', 'qa67lock');
        const p2Endpoints = p2Service ? cluster.getServiceEndpoints(p2Service) : [];
        const curlDuringFailure = p2Host ? curlStatus(`http://${p2Host}`) : '';
        if (
          p2Create &&
          !p2Create.error &&
          p2Expose &&
          !p2Expose.error &&
          p2RouteCreate &&
          !p2RouteCreate.error &&
          readinessSet &&
          !readinessSet.error &&
          Boolean(p2Host)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: the #67B readiness fixture (deployment p2, Service, Route, closed-port probe) must be created (#67B): ${JSON.stringify({ create: p2Create?.message, expose: p2Expose?.message, route: p2RouteCreate?.message, probe: readinessSet?.message })}`
          );
        }
        if (readinessFailed && /^0\/1$/.test(String(p2Row?.[1] || ''))) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a failing readiness probe must show the Pod as \`0/1 Running\` after failureThreshold (#67B): ${JSON.stringify({ failed: readinessFailed, row: p2Row })}`
          );
        }
        const readinessRefusal = `Readiness probe failed: Get "http://${p2Ip}:9999/nope": dial tcp ${p2Ip}:9999: connect: connection refused`;
        if (p2Ip && describeP2.includes(readinessRefusal)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: describe pod must contain kubectl's real readiness message \`${readinessRefusal}\` (#67B): ${JSON.stringify(describeP2.split('\n').filter((line) => /Readiness probe/.test(line)))}`
          );
        }
        if (p2Endpoints.length === 0) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a NotReady Pod must be removed from the Service endpoints (#67B): ${JSON.stringify(p2Endpoints.map((pod) => pod.metadata?.name))}`
          );
        }
        if (curlDuringFailure === '503') {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: while the only endpoint is NotReady the Route must return 503 (got ${JSON.stringify(curlDuringFailure)}) (#67B)`
          );
        }

        // #67C: fixing the readiness probe restores Ready, endpoints and the Route.
        run(
          'oc set probe deploy/p2 -n qa67lock --readiness --get-url=http://:8080/ --period-seconds=1 --failure-threshold=1'
        );
        const readinessRecovered = tickUntil(() => {
          const pod = latestPod('qa67lock', 'p2-');
          const endpoints = p2Service ? cluster.getServiceEndpoints(p2Service) : [];
          return Boolean(pod?.isConditionTrue('Ready')) && endpoints.length > 0;
        }, 120);
        const curlRecovered = p2Host ? curlStatus(`http://${p2Host}`) : '';
        if (readinessRecovered && curlRecovered === '200') {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a corrected readiness probe must bring the Pod back to Ready, repopulate the Service endpoints and make the Route return 200 (#67C): ${JSON.stringify({ readinessRecovered, curlRecovered })}`
          );
        }

        // #67D2: the simulated app HTTP model — a wrong path on the OPEN port
        // fails with kubelet's `HTTP probe failed with statuscode: 404`, and a
        // corrected path recovers (the issue's "fix the path" troubleshooting flow).
        const p5Create = run(
          'oc create deployment p5 --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const p5Probe = run(
          'oc set probe deploy/p5 -n qa67lock --readiness --get-url=http://:8080/nope'
        );
        const wrongPathFailed = tickUntil(() => {
          const pod = latestPod('qa67lock', 'p5-');
          return Boolean(
            pod &&
            pod.status?.phase === 'Running' &&
            pod.isConditionTrue('Ready') === false &&
            pod.status?.containerStatuses?.[0]?.started
          );
        }, 120);
        const p5Pod = latestPod('qa67lock', 'p5-');
        const describeP5 = p5Pod
          ? messageOf(run(`oc describe pod/${p5Pod.metadata.name} -n qa67lock`))
          : '';
        if (
          p5Create &&
          !p5Create.error &&
          p5Probe &&
          !p5Probe.error &&
          wrongPathFailed &&
          describeP5.includes('Readiness probe failed: HTTP probe failed with statuscode: 404')
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a readiness probe on a wrong path of the OPEN port must fail with \`HTTP probe failed with statuscode: 404\` (#67D2): ${JSON.stringify({ wrongPathFailed, lines: describeP5.split('\n').filter((line) => /Readiness probe/.test(line)) })}`
          );
        }
        run(
          'oc set probe deploy/p5 -n qa67lock --readiness --get-url=http://:8080/ --period-seconds=1 --failure-threshold=1'
        );
        const wrongPathRecovered = tickUntil(
          () => Boolean(latestPod('qa67lock', 'p5-')?.isConditionTrue('Ready')),
          120
        );
        if (wrongPathRecovered) {
          passed();
        } else {
          fail(
            'fidelity',
            '#67: correcting the readiness probe path must bring the Pod back to Ready (#67D2)'
          );
        }

        // #67F: startup probes gate liveness/readiness, support named ports and
        // restart the container on failure; exec argv stays verbatim; a bare
        // engine falls back to the deterministic container command model.
        const webapp = engine.applyManifestObject({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'webapp', namespace: 'qa67lock' },
          spec: {
            replicas: 2,
            selector: { matchLabels: { app: 'webapp' } },
            template: {
              metadata: { labels: { app: 'webapp' } },
              spec: {
                containers: [
                  {
                    name: 'webapp',
                    image: 'quay.io/openshift/origin-hello-openshift:latest',
                    ports: [{ name: 'http', containerPort: 8080 }],
                    readinessProbe: {
                      httpGet: { path: '/', port: 8080 },
                      periodSeconds: 1,
                      failureThreshold: 1,
                    },
                    startupProbe: {
                      httpGet: { path: '/', port: 'http' },
                      periodSeconds: 1,
                      failureThreshold: 1,
                    },
                  },
                ],
              },
            },
          },
        });
        const webappStartupSet = tickUntil(() => {
          const pods = podsIn('qa67lock').filter((pod) =>
            String(pod.metadata?.name || '').startsWith('webapp-')
          );
          return (
            pods.length > 0 &&
            pods.every((pod) => pod.isConditionTrue('Ready')) &&
            pods.every((pod) => pod.status?.containerStatuses?.[0]?._startupComplete === true)
          );
        }, 120);
        const webappProbe = cluster.getByName('Deployment', 'webapp', 'qa67lock')?.spec?.template
          ?.spec?.containers?.[0]?.startupProbe;
        if (webapp && webappStartupSet && webappProbe?.httpGet?.port === 'http') {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a startup probe on the named port \`http\` must resolve to the container's 8080 and gate the Pod to Ready (#67F): ${JSON.stringify({ webapp: Boolean(webapp), webappStartupSet, webappProbe })}`
          );
        }

        const bootCreate = run(
          'oc create deployment boot --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const bootProbe = run(
          'oc set probe deploy/boot -n qa67lock --startup --get-url=http://:9999/nope --period-seconds=1 --failure-threshold=1'
        );
        const bootRestarted = tickUntil(() => {
          const pod = latestPod('qa67lock', 'boot-');
          const status = pod?.status?.containerStatuses?.[0];
          return Boolean(
            status &&
            (Number(status.restartCount || 0) > 0 ||
              status.state?.waiting?.reason === 'CrashLoopBackOff')
          );
        }, 120);
        const bootPod = latestPod('qa67lock', 'boot-');
        const describeBoot = bootPod
          ? messageOf(run(`oc describe pod/${bootPod.metadata.name} -n qa67lock`))
          : '';
        if (
          bootCreate &&
          !bootCreate.error &&
          bootProbe &&
          !bootProbe.error &&
          bootRestarted &&
          /Startup probe failed: Get "http:\/\/\d{1,3}(?:\.\d{1,3}){3}:9999\/nope": dial tcp \d{1,3}(?:\.\d{1,3}){3}:9999: connect: connection refused/.test(
            describeBoot
          ) &&
          /Container \S+ failed startup probe, will be restarted/.test(describeBoot)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: a failing startup probe must restart the container with the real \`Startup probe failed: …\` + \`Container <name> failed startup probe, will be restarted\` events (#67F): ${JSON.stringify(describeBoot.split('\n').filter((line) => /probe/.test(line)))}`
          );
        }

        // One handler per probe: an exec argv plus --get-url is rejected.
        const conflict = run(
          'oc set probe deploy/webapp -n qa67lock --liveness --get-url=http://:8080/ -- cat /tmp/healthy'
        );
        if (conflict?.error && /only one handler/.test(messageOf(conflict))) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: \`oc set probe … --get-url=… -- <command>\` must be rejected with an oc-style one-handler error (#67F): ${JSON.stringify(messageOf(conflict))}`
          );
        }
        // `--remove` deletes the probe from the template.
        run('oc set probe deploy/webapp -n qa67lock --remove --startup');
        const removedProbe = cluster.getByName('Deployment', 'webapp', 'qa67lock')?.spec?.template
          ?.spec?.containers?.[0]?.startupProbe;
        if (removedProbe === undefined) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: \`oc set probe … --remove\` must delete the probe from the pod template (#67F): ${JSON.stringify(removedProbe)}`
          );
        }

        // Bare Node engine (no CommandBar evaluator) keeps exec probes safe.
        simulation.setContainerExecEvaluator(null);
        const fbCreate = run(
          'oc create deployment fb --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const fbProbe = run(
          'oc set probe deploy/fb -n qa67lock --liveness -- cat /tmp/healthy --period-seconds=1 --failure-threshold=1'
        );
        const fbRestarted = tickUntil(() => {
          const pod = latestPod('qa67lock', 'fb-');
          const status = pod?.status?.containerStatuses?.[0];
          return Boolean(
            status &&
            (Number(status.restartCount || 0) > 0 ||
              status.state?.waiting?.reason === 'CrashLoopBackOff')
          );
        }, 120);
        const fbPod = latestPod('qa67lock', 'fb-');
        const describeFb = fbPod
          ? messageOf(run(`oc describe pod/${fbPod.metadata.name} -n qa67lock`))
          : '';
        if (
          fbCreate &&
          !fbCreate.error &&
          fbProbe &&
          !fbProbe.error &&
          fbRestarted &&
          describeFb.includes('Liveness probe failed: cat: /tmp/healthy: No such file or directory')
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: without a CommandBar evaluator the bare engine must still fail \`cat /tmp/healthy\` deterministically (no exception) (#67F): ${JSON.stringify(describeFb.split('\n').filter((line) => /probe/.test(line)))}`
          );
        }
        // Restore the browser wiring for the remaining locks.
        simulation.setContainerExecEvaluator((pod, containerName, argv) =>
          cliBar._simulateExecCommand(argv, pod, containerName)
        );
        // Exec-probe argv is pre-tokenized: `sh -c '<script with spaces>'` must
        // not be re-split when the kubelet runs it.
        const webokPod = latestPod('qa67lock', 'webok-');
        const webokContainer = webokPod?.spec?.containers?.[0];
        const argvShell = webokPod
          ? cliBar._simulateExecCommand(
              ['sh', '-c', 'echo "a b"'],
              webokPod,
              webokContainer?.name || 'webok'
            )
          : null;
        if (argvShell && argvShell.exitCode === 0 && argvShell.lines.join('\n').trim() === 'a b') {
          passed();
        } else {
          fail(
            'fidelity',
            `#67: \`_simulateExecCommand(['sh','-c','echo "a b"'])\` must keep the script as one argv element (#67F): ${JSON.stringify(argvShell)}`
          );
        }

        // #67 P4: kubectl 1.35 (OCP 4.22) prints ALL old ReplicaSets, including
        // the 0/0 ones a finished rollout leaves behind — not `<none>` (checked
        // against kubectl release-1.35 describe_test.go). Lock that behavior.
        run(
          'oc create deployment roll --image=registry.access.redhat.com/ubi9/httpd-24 --replicas=1 -n qa67lock'
        );
        const rollRunning = tickUntil(
          () => Boolean(runningPod('qa67lock', 'roll-')?.isConditionTrue('Ready')),
          60
        );
        let rolloutsSettled = rollRunning;
        for (let rollout = 0; rollout < 3 && rolloutsSettled; rollout += 1) {
          run(`oc set env deploy/roll ITER=${rollout} -n qa67lock`);
          rolloutsSettled = tickUntil(() => deploymentSettled('qa67lock', 'roll'), 120);
        }
        const describeRoll = messageOf(run('oc describe deploy/roll -n qa67lock'));
        const oldReplicaSetLine =
          describeRoll.split('\n').find((line) => /^OldReplicaSets:/.test(line)) || '';
        if (
          rolloutsSettled &&
          /OldReplicaSets:\s+roll-[a-z0-9]+ \(0\/0 replicas created\)/.test(oldReplicaSetLine) &&
          !/<none>/.test(oldReplicaSetLine)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#67 P4: after finished rollouts kubectl 1.35 lists the old ReplicaSets as \`roll-… (0/0 replicas created)\` (it does NOT print <none>); keep that behavior (#67 P4): ${JSON.stringify(oldReplicaSetLine)}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#67 dynamic probe-fidelity lock threw: ${err.message}`);
    }
  }
}

// ── 4j. Issue #68–#69 versioned-module cache/boot/describe fidelity locks ──
// The browser suite sections `qa-issue68` / `qa-issue69` prove these end-to-end.
// These static/dynamic locks fail the fast static gate if a refactor silently
// reintroduces the #68 stale-module graph (a returning browser pinned to an old
// module URL by the one-year immutable cache, fetch probes that bypass the
// import map, or a local dev server that cannot emulate the /v/ rewrite) or the
// #69 P3 "blame the GPU for a JavaScript crash" panel and the #69 P4 missing
// Internal Traffic Policy/Traffic Distribution describe rows (no browser, no
// ticks needed).
{
  // ── #68 — import-map versioning + Vercel rewrite/immutable header ─────────
  try {
    const packageJson = JSON.parse(read('package.json'));
    const version = String(packageJson.version ?? '');
    const indexHtml = read('index.html');
    const drawHtml = read('draw.html');
    const vercelConfig = JSON.parse(read('vercel.json'));
    /**
     * Translate a Vercel path pattern (`:param`, `:path*`, `(.*)`) to a RegExp
     * and test it against a pathname.
     */
    const vercelPatternMatches = (source, pathname) => {
      const pattern = String(source)
        .split('/')
        .map((segment) => {
          if (!segment) return '';
          if (segment === '(.*)' || /^:\w+\*$/.test(segment)) return '.*';
          if (/^:\w+$/.test(segment)) return '[^/]+';
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
      try {
        return new RegExp(`^${pattern}$`).test(pathname);
      } catch {
        return false;
      }
    };
    const importMapOf = (html) => {
      const match = String(html).match(
        /<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/
      );
      if (!match) return null;
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    };

    // #68 (a): package.json is the single source of truth for the version.
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: package.json version must be plain semver (got ${JSON.stringify(version)})`
      );
    }

    // #68 (b)/(c): both entry documents map "./js/" to the SAME versioned prefix.
    const expectedJsBase = `./v/${version}/js/`;
    for (const [rel, html] of [
      ['index.html', indexHtml],
      ['draw.html', drawHtml],
    ]) {
      const jsBase = importMapOf(html)?.imports?.['./js/'];
      if (jsBase === expectedJsBase) {
        passed();
      } else {
        fail(
          'fidelity',
          `#68: ${rel} import map must version app modules ("./js/" => ${JSON.stringify(expectedJsBase)} from package.json), got ${JSON.stringify(jsBase)}`
        );
      }
    }

    // #68 (d): the inline index module keeps plain './js/...' specifiers (so
    // the import map is what versions the graph) and the import map precedes
    // the module script in the document.
    const inlineImports = inlineModules('index.html').flatMap((mod) => {
      const clean = stripComments(mod.src);
      return [
        ...[...clean.matchAll(IMPORT_FROM_RE)].map((match) => match[1]),
        ...[...clean.matchAll(DYNAMIC_IMPORT_RE)].map((match) => match[1]),
      ];
    });
    const relativeImports = inlineImports.filter((spec) => spec.startsWith('.'));
    const plainJsImports = relativeImports.filter((spec) => spec.startsWith('./js/'));
    const directVersionedImports = relativeImports.filter((spec) => spec.startsWith('./v/'));
    const importMapAt = indexHtml.indexOf('<script type="importmap"');
    const moduleScriptAt = indexHtml.indexOf('<script type="module"');
    if (
      relativeImports.length >= 10 &&
      plainJsImports.length === relativeImports.length &&
      directVersionedImports.length === 0 &&
      importMapAt >= 0 &&
      moduleScriptAt > importMapAt
    ) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: index.html inline module must import plain './js/...' specifiers (plain=${plainJsImports.length}/${relativeImports.length}, direct-versioned=${JSON.stringify(directVersionedImports)}) and the import map must precede the module script (importMap@${importMapAt}, moduleScript@${moduleScriptAt})`
      );
    }

    // #68 (e): Vercel rewrites the versioned URL prefix back onto the real files.
    const versionedModulePath = `/v/${version}/js/engine/GameEngine.js`;
    const versionRewrite = (vercelConfig.rewrites || []).find(
      (rewrite) =>
        vercelPatternMatches(rewrite.source, versionedModulePath) &&
        /^\/js\/(?::path\*|\(\.\*\)|\$1)$/.test(String(rewrite.destination))
    );
    if (versionRewrite) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: vercel.json must rewrite /v/:version/js/:path* onto /js/:path* (tested ${JSON.stringify(versionedModulePath)}; rewrites=${JSON.stringify((vercelConfig.rewrites || []).map((rewrite) => `${rewrite.source} -> ${rewrite.destination}`))})`
      );
    }

    // #68 (f): the versioned prefix is immutable for at least a year so a
    // release changes every module URL; unversioned /js keeps revalidating (#66).
    const versionedCacheValues = (vercelConfig.headers || [])
      .filter((rule) => vercelPatternMatches(rule.source, versionedModulePath))
      .flatMap((rule) => rule.headers || [])
      .filter((header) => String(header.key).toLowerCase() === 'cache-control')
      .map((header) => String(header.value));
    const versionedImmutable =
      versionedCacheValues.length > 0 &&
      versionedCacheValues.every((value) => {
        const maxAge = Number((value.match(/max-age=(\d+)/) || [])[1] || 0);
        return maxAge >= 31536000 && /(?:^|[,\s])immutable(?:[,\s]|$)/.test(value);
      });
    if (versionedImmutable) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: /v/<version>/js/* must be served with Cache-Control max-age >= 31536000 and immutable (got ${JSON.stringify(versionedCacheValues)})`
      );
    }

    // #68 (g): no entry document may load an unversioned /js module, and the
    // `_moduleExists()` fetch probe must resolve through the import map (a
    // bare `fetch(path)` probe would hit /js while `import()` hits /v/…).
    const moduleProbeAt = indexHtml.indexOf('async _moduleExists(path) {');
    const moduleProbeEnd = moduleProbeAt < 0 ? -1 : indexHtml.indexOf('\n        }', moduleProbeAt);
    const moduleProbe =
      moduleProbeAt < 0
        ? ''
        : indexHtml.slice(moduleProbeAt, moduleProbeEnd > 0 ? moduleProbeEnd : moduleProbeAt + 900);
    const unversionedEntryRefs = [];
    for (const [rel, html] of [
      ['index.html', indexHtml],
      ['draw.html', drawHtml],
    ]) {
      if (/<script\b[^>]*\bsrc\s*=\s*["']\.\/js\//i.test(html)) {
        unversionedEntryRefs.push(`${rel}: <script src="./js/...">`);
      }
      for (const mod of inlineModules(rel)) {
        for (const match of stripComments(mod.src).matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\/js\//g
        )) {
          unversionedEntryRefs.push(`${rel}: ${match[0]}`);
        }
      }
    }
    const moduleProbeResolves =
      /const resolveModulePath\s*=\s*\(specifier\)\s*=>/.test(indexHtml) &&
      /fetch\(\s*resolveModulePath\(path\)/.test(moduleProbe) &&
      !/fetch\(\s*path\b/.test(moduleProbe);
    if (moduleProbeResolves && unversionedEntryRefs.length === 0) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: index.html must probe modules with fetch(resolveModulePath(path)) (never fetch(path)) and the entry documents must not load unversioned /js modules: ${JSON.stringify({ moduleProbeResolves, unversionedEntryRefs, moduleProbe })}`
      );
    }

    // #68 local-dev: `/v/<version>/js/*` only exists as a production rewrite, so
    // a plain `python3 -m http.server` can no longer load the app locally. The
    // zero-dependency dev server must exist, be non-trivial, compile the
    // vercel.json rewrites (including the `/v/:version/js/:path*` rule) and never
    // cache locally (an edit must show up on the next reload). It is the
    // canonical `npm run dev` / README local command.
    const devServerRel = 'scripts/dev-server.mjs';
    const devServerExists = has(devServerRel);
    const devServerSrc = devServerExists ? read(devServerRel) : '';
    const devServerEmulatesRewrites =
      /vercel\.json/.test(devServerSrc) &&
      /compile(?:Source|Rewrites)/.test(devServerSrc) &&
      /applyRewrites|rewrite\.destination/.test(devServerSrc) &&
      /\/v\//.test(devServerSrc);
    const devServerNoStore = /'cache-control'\s*:\s*'no-store'/.test(devServerSrc);
    if (
      devServerExists &&
      devServerSrc.split('\n').length >= 60 &&
      devServerEmulatesRewrites &&
      devServerNoStore
    ) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: ${devServerRel} must emulate the vercel.json /v/:version/js/:path* rewrites locally and serve Cache-Control: no-store: ${JSON.stringify({ exists: devServerExists, lines: devServerSrc.split('\n').length, emulatesRewrites: devServerEmulatesRewrites, noStore: devServerNoStore })}`
      );
    }
    const devScript = String(packageJson.scripts?.dev ?? '');
    if (devScript === 'node scripts/dev-server.mjs') {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: package.json scripts.dev must be "node scripts/dev-server.mjs" (got ${JSON.stringify(devScript)})`
      );
    }
    // The dev server is reachable as the package.json `dev` script (Knip adds
    // script-referenced files as entries automatically), and scripts/**/*.mjs
    // is project code, so dead-file detection covers it without a duplicate
    // `entry` pattern (Knip rejects a redundant one with a configuration hint).
    const knipProject = (read('knip.jsonc').match(/"project"\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '';
    if (/"scripts\/\*\*\/\*\.mjs"/.test(knipProject)) {
      passed();
    } else {
      fail(
        'fidelity',
        `#68: knip.jsonc "project" must keep scripts/**/*.mjs so the dev server is checked (got ${JSON.stringify(knipProject)})`
      );
    }
  } catch (err) {
    fail('fidelity', `#68: versioned-module cache lock could not run: ${err.message}`);
  }

  // ── #69 P3 — boot failures show the generic panel, never GPU advice ───────
  try {
    const indexHtml = read('index.html');
    /** Slice a class method body: from its signature to the next 8-space `}`. */
    const methodBodyOf = (needle, fallbackLength = 2600) => {
      const start = indexHtml.indexOf(needle);
      if (start < 0) return '';
      const end = indexHtml.indexOf('\n        }', start);
      return indexHtml.slice(start, end > start ? end : start + fallbackLength);
    };

    // #69 P3 (h): the generic overlay: id=init-error, role=alert, the message
    // filled through textContent (never innerHTML), and the hard-reload hints.
    const showInitError = methodBodyOf('_showInitError(err) {');
    const showInitErrorOk =
      showInitError.length > 0 &&
      /overlay\.id\s*=\s*'init-error'/.test(showInitError) &&
      /setAttribute\('role',\s*'alert'\)/.test(showInitError) &&
      /#init-error-message/.test(showInitError) &&
      /\.textContent\s*=\s*message/.test(showInitError) &&
      showInitError.includes('The game failed to load') &&
      showInitError.includes('Ctrl+Shift+R') &&
      showInitError.includes('Cmd+Shift+R') &&
      showInitError.includes('${REPO_URL}/issues');
    if (showInitErrorOk) {
      passed();
    } else {
      fail(
        'fidelity',
        `#69 P3: _showInitError must render the generic panel (id=init-error, role=alert, message via textContent, "The game failed to load", Ctrl+Shift+R / Cmd+Shift+R, REPO_URL/issues link): ${JSON.stringify({ hasMethod: showInitError.length > 0, hasOverlayId: /overlay\.id\s*=\s*'init-error'/.test(showInitError), hasRole: /setAttribute\('role',\s*'alert'\)/.test(showInitError), hasMessageNode: /#init-error-message/.test(showInitError), fillsTextContent: /\.textContent\s*=\s*message/.test(showInitError), hasTitle: showInitError.includes('The game failed to load'), hasHardReloadHints: showInitError.includes('Ctrl+Shift+R') && showInitError.includes('Cmd+Shift+R'), hasReportLink: showInitError.includes('${REPO_URL}/issues') })}`
      );
    }

    // #69 P3 (i): init().catch routes non-WebGL failures to _showInitError(err)
    // and calls _showWebGLError() only behind `app._webglFailed`.
    const initCatchAt = indexHtml.indexOf(' init error:');
    const initCatch = initCatchAt < 0 ? '' : indexHtml.slice(initCatchAt, initCatchAt + 600);
    const initCatchOk =
      /_showInitError\(err\)/.test(initCatch) &&
      /if \(app\._webglFailed\) app\._showWebGLError\(\);/.test(initCatch) &&
      (initCatch.match(/_showWebGLError\(\)/g) || []).length === 1;
    if (initCatchOk) {
      passed();
    } else {
      fail(
        'fidelity',
        `#69 P3: init().catch must show _showInitError(err) for non-WebGL failures and gate _showWebGLError() behind app._webglFailed: ${JSON.stringify(initCatch)}`
      );
    }

    // #69 P3 (j): the renderer-constructor catch is a boot failure (not a
    // missing GPU) — it must show the generic panel and never blame WebGL.
    const rendererCatchAt = indexHtml.indexOf('renderer init failed');
    const rendererCatchEnd =
      rendererCatchAt < 0 ? -1 : indexHtml.indexOf('\n          }', rendererCatchAt);
    const rendererCatch =
      rendererCatchAt < 0
        ? ''
        : indexHtml.slice(
            rendererCatchAt,
            rendererCatchEnd > rendererCatchAt ? rendererCatchEnd : rendererCatchAt + 600
          );
    if (/_showInitError\(err\)/.test(rendererCatch) && !/_showWebGLError\(\)/.test(rendererCatch)) {
      passed();
    } else {
      fail(
        'fidelity',
        `#69 P3: the renderer-constructor catch must call _showInitError(err) and never _showWebGLError() (or set _webglFailed): ${JSON.stringify(rendererCatch)}`
      );
    }

    // #69 P3 (k): `_webglFailed = true` may only be set in the WebGL capability
    // branch of init(); the renderer catch must not mark the GPU as missing.
    const webglProbeAt = indexHtml.indexOf("const gl = testCanvas.getContext('webgl2')");
    const webglProbe = webglProbeAt < 0 ? '' : indexHtml.slice(webglProbeAt, webglProbeAt + 400);
    const webglFailedAssignments = (indexHtml.match(/_webglFailed = true/g) || []).length;
    if (
      webglFailedAssignments === 1 &&
      /if \(!gl\) \{\s*this\._webglFailed = true;\s*this\._showWebGLError\(\);/.test(webglProbe)
    ) {
      passed();
    } else {
      fail(
        'fidelity',
        `#69 P3: _webglFailed = true must occur exactly once, inside the WebGL capability branch of init() (count=${webglFailedAssignments}, capability branch=${JSON.stringify(webglProbe)})`
      );
    }
  } catch (err) {
    fail('fidelity', `#69 P3: boot-failure panel lock could not run: ${err.message}`);
  }

  // ── #69 P4 — Internal Traffic Policy / Traffic Distribution describe rows ─
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  if (!engineMod?.GameEngine || !sandboxMod?.SandboxMode || !commandBarMod?.CommandBar) {
    fail(
      'fidelity',
      '#69 P4: GameEngine/SandboxMode/CommandBar are not importable for the traffic-policy locks'
    );
  } else {
    try {
      const engine = new engineMod.GameEngine({ mode: 'sandbox' });
      new sandboxMod.SandboxMode(engine, null).setupCluster(3);
      engine.simulation.ensureOLMDefaultsSync();
      const cluster = engine.cluster;

      // #69 P4 (l): the cluster-dns-operator's 4.22 dns-default asset sets
      // spec.trafficDistribution: PreferSameNode.
      const dnsService = cluster.getByName('Service', 'dns-default', 'openshift-dns');
      if (dnsService?.spec?.trafficDistribution === 'PreferSameNode') {
        passed();
      } else {
        fail(
          'fidelity',
          `#69 P4: openshift-dns/dns-default must carry spec.trafficDistribution="PreferSameNode": ${JSON.stringify({ trafficDistribution: dnsService?.spec?.trafficDistribution, spec: dnsService?.spec })}`
        );
      }

      // #69 P4 (m): `oc describe svc dns-default` prints Internal Traffic Policy
      // right after Session Affinity and Traffic Distribution last, before
      // Events; kubectl 1.35's tabwriter aligns EVERY top-level value in column
      // 27 (the 24-char `Internal Traffic Policy:` label is the widest).
      const dnsDescribe = dnsService?.toDescribe?.({ cluster }) || '';
      const dnsDescribeLines = dnsDescribe.split('\n').filter((line) => line.trim() !== '');
      const misalignedDnsLabels = dnsDescribeLines
        .map((line) => {
          const match = line.match(/^([A-Za-z][^:]*:)(\s*)(\S.*)$/);
          return { line, column: match ? match[1].length + match[2].length + 1 : null };
        })
        .filter((entry) => entry.column !== 27);
      const sessionAffinityAt = dnsDescribe.indexOf('Session Affinity:');
      const internalTrafficAt = dnsDescribe.indexOf('Internal Traffic Policy:');
      const trafficDistributionAt = dnsDescribe.indexOf('Traffic Distribution:');
      const eventsHeaderAt = dnsDescribe.indexOf('Events:');
      if (
        /^Internal Traffic Policy: {2}Cluster$/m.test(dnsDescribe) &&
        /^Traffic Distribution: {5}PreferSameNode$/m.test(dnsDescribe) &&
        sessionAffinityAt >= 0 &&
        sessionAffinityAt < internalTrafficAt &&
        internalTrafficAt < trafficDistributionAt &&
        trafficDistributionAt < eventsHeaderAt &&
        misalignedDnsLabels.length === 0
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `#69 P4: describe dns-default must print Internal Traffic Policy (after Session Affinity) and Traffic Distribution (before Events) with every value in column 27: ${JSON.stringify({ order: { sessionAffinityAt, internalTrafficAt, trafficDistributionAt, eventsHeaderAt }, misalignedDnsLabels, excerpt: dnsDescribe.slice(0, 900) })}`
        );
      }

      // #69 P4 (n): any other ClusterIP Service now prints the defaulted
      // Internal Traffic Policy row (widening the value column from 19 to 27),
      // so its empty Events placeholder carries 19 spaces; it has no operator
      // traffic distribution.
      const appliedWeb = engine.applyManifestObject({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'qa69-web', namespace: 'default' },
        spec: { selector: { app: 'qa69-web' }, ports: [{ port: 8080 }] },
      });
      const appliedWebDescribe = appliedWeb?.toDescribe?.({ cluster }) || '';
      const appliedWebEventsLine = (appliedWebDescribe.match(/^Events:.*$/m) || [''])[0];
      const appliedWebEventsSpaces =
        (appliedWebEventsLine.match(/^Events:( +)<none>$/) || [])[1] || '';
      const appliedWebOk =
        appliedWeb?._applyAction === 'created' &&
        /^Internal Traffic Policy: {2}Cluster$/m.test(appliedWebDescribe) &&
        appliedWebEventsSpaces.length === 19 &&
        !/^Traffic Distribution:/m.test(appliedWebDescribe);
      if (appliedWebOk) {
        passed();
      } else {
        fail(
          'fidelity',
          `#69 P4: an applied ClusterIP Service must describe with Internal Traffic Policy: Cluster, 19 spaces after "Events:" and no Traffic Distribution line: ${JSON.stringify({ action: appliedWeb?._applyAction, eventsLine: appliedWebEventsLine, eventsSpaces: appliedWebEventsSpaces.length, hasInternal: /^Internal Traffic Policy: {2}Cluster$/m.test(appliedWebDescribe), hasTrafficDistribution: /^Traffic Distribution:/m.test(appliedWebDescribe), excerpt: appliedWebDescribe.slice(0, 900) })}`
        );
      }

      // #69 P4 (o): ExternalName Services have no cluster traffic fields
      // (`oc describe svc` prints neither Internal Traffic Policy nor Traffic
      // Distribution for them).
      const appliedExternal = engine.applyManifestObject({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'qa69-external', namespace: 'default' },
        spec: { type: 'ExternalName', externalName: 'example.com' },
      });
      const appliedExternalDescribe = appliedExternal?.toDescribe?.({ cluster }) || '';
      if (
        appliedExternal?._applyAction === 'created' &&
        /^Type: +ExternalName$/m.test(appliedExternalDescribe) &&
        !/^Internal Traffic Policy:/m.test(appliedExternalDescribe) &&
        !/^Traffic Distribution:/m.test(appliedExternalDescribe)
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `#69 P4: an ExternalName Service describe must not print Internal Traffic Policy/Traffic Distribution: ${JSON.stringify({ action: appliedExternal?._applyAction, excerpt: appliedExternalDescribe.slice(0, 700) })}`
        );
      }

      // #69 P4 (p): the operator-set field is addressable through the CLI
      // jsonpath machinery, exactly like `oc get svc -o jsonpath`.
      const windowShim = {
        game: {
          cluster,
          gameEngine: engine,
          engine: { emit() {}, on() {}, off() {} },
          manifestEngine: null,
        },
      };
      globalThis.window = windowShim;
      try {
        const cliBar = new commandBarMod.CommandBar();
        const jsonpathResult = cliBar.executeCommand(
          'oc get svc dns-default -n openshift-dns -o jsonpath={.spec.trafficDistribution}'
        );
        if (
          !jsonpathResult?.error &&
          String(jsonpathResult?.message ?? '').trim() === 'PreferSameNode'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#69 P4: \`oc get svc dns-default -n openshift-dns -o jsonpath={.spec.trafficDistribution}\` must print PreferSameNode: ${JSON.stringify(jsonpathResult)}`
          );
        }
      } finally {
        delete globalThis.window;
      }
    } catch (err) {
      fail('fidelity', `#69 P4 dynamic traffic-policy lock threw: ${err.message}`);
    }
  }
}

// ── 4k. Issue #70–#76 CLI/model fidelity locks (static) ────────────────────
// The browser suite section `qa-issue70-76` proves these end-to-end. These
// headless locks fail the fast static gate if a refactor silently reintroduces
// a #70–#76 regression: S2I digest pulls (#70), SCC API-group resolution in
// `oc create role` (#72), reactive Deployment-template damage / scheduler
// wording (#73), immutable Job templates (#74), the kubectl-1.35 debug-signal
// and output contracts (#75/#76) and the model invariants (heartbeat freeze,
// DeadlineExceeded message, SCC/SA FailedCreate details, MetalLB IPAllocated).
// One in-process sandbox fixture is shared so the gate stays fast (no browser,
// no screenshots).
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const manifestMod = await tryImport('js/engine/ManifestEngine.js');
  const clusterStateMod = await tryImport('js/engine/ClusterState.js');
  const incidentMod = await tryImport('js/engine/IncidentEngine.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !manifestMod?.ManifestEngine ||
    !clusterStateMod?.KUBEADMIN_PASSWORD ||
    !incidentMod?.IncidentEngine
  ) {
    fail(
      'fidelity',
      '#70–#76: GameEngine/SandboxMode/CommandBar/ManifestEngine/ClusterState/IncidentEngine are not importable for the CLI fidelity locks'
    );
  } else {
    const engine = new engineMod.GameEngine({ mode: 'sandbox' });
    new sandboxMod.SandboxMode(engine, null).setupCluster(3);
    const cluster = engine.cluster;
    const simulation = engine.simulation;
    const manifestEngine = new manifestMod.ManifestEngine({ cluster, gameEngine: engine });
    globalThis.window = {
      game: {
        cluster,
        gameEngine: engine,
        engine: { emit() {}, on() {}, off() {} },
        manifestEngine,
      },
    };
    manifestEngine.game = globalThis.window.game;
    const commandBar = new commandBarMod.CommandBar();
    /** Run one oc/shell command headlessly and normalise the result shape. */
    const cli = (raw) => {
      try {
        const out = commandBar.executeCommand(raw);
        return {
          error: Boolean(out?.error),
          message: String(out?.message ?? ''),
          normalized: String(out?.normalized ?? ''),
        };
      } catch (err) {
        return { error: true, message: `THROW ${err?.message || err}`, normalized: '' };
      }
    };
    /** Advance the controller clock only (0.05 s fixed steps). */
    const tick = (seconds, incidentEngine = null) => {
      const steps = Math.ceil(seconds / 0.05);
      for (let step = 0; step < steps; step += 1) {
        simulation.tick(0.05);
        if (incidentEngine) incidentEngine.tick(0.05);
      }
    };
    /** Tabwriter table split (3+ space columns). */
    const tableCells = (line) =>
      String(line)
        .split(/\s{3,}/)
        .map((cell) => cell.trim());
    /** Table rows (header + data) of an oc/helm listing, ignoring blank lines. */
    const tableRows = (message) =>
      String(message)
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => tableCells(line));
    try {
      // ── #70 — S2I digest image pulls resolve against the IS tag history ───
      try {
        const registry = 'image-registry.openshift-image-registry.svc:5000';
        const builtDigest = `sha256:${'a1b2c3d4e5f60718'.repeat(4)}`;
        cluster.updateImageStreamTag('qa4k-build', 'webapp', 'latest', {
          image: builtDigest,
          dockerImageReference: `${registry}/qa4k-build/webapp@${builtDigest}`,
        });
        const builtPull = simulation._resolveContainerImagePull({
          image: `${registry}/qa4k-build/webapp@${builtDigest}`,
        });
        if (builtPull?.ok === true) {
          passed();
        } else {
          fail(
            'fidelity',
            `#70: the built digest reference must pull successfully once it appears in the ImageStream tag history: ${JSON.stringify(builtPull)}`
          );
        }
        const unknownDigest = `sha256:${'0'.repeat(64)}`;
        const unknownPull = simulation._resolveContainerImagePull({
          image: `${registry}/qa4k-build/webapp@${unknownDigest}`,
        });
        if (unknownPull?.ok === false && /manifest unknown/.test(unknownPull.message || '')) {
          passed();
        } else {
          fail(
            'fidelity',
            `#70: an @sha256 digest that is NOT in the tag history must fail with a real manifest-unknown pull error: ${JSON.stringify(unknownPull)}`
          );
        }
        // Point 4: a pre-build :latest pod must be ImagePullBackOff until the
        // first successful push creates the tag, then recover.
        const latestRef = `${registry}/qa4k-nobuild/app:latest`;
        const preBuildPull = simulation._resolveContainerImagePull({ image: latestRef });
        cluster.updateImageStreamTag('qa4k-nobuild', 'app', 'latest', {});
        const postBuildPull = simulation._resolveContainerImagePull({ image: latestRef });
        if (preBuildPull?.ok === false && postBuildPull?.ok === true) {
          passed();
        } else {
          fail(
            'fidelity',
            `#70: <ns>/<name>:latest must be unpullable before the first build push and pullable after it: ${JSON.stringify({ preBuildPull, postBuildPull })}`
          );
        }
      } catch (err) {
        fail('fidelity', `#70: S2I digest-pull lock could not run: ${err.message}`);
      }

      // ── #72 — `oc create role --resource=…` resolves the API group ───────
      try {
        const rbacProject = 'qa4k-rbac';
        cli(`oc new-project ${rbacProject}`);
        const roleRules = (name) => cluster.getByName('Role', name, rbacProject)?.rules || [];
        const rulesEqual = (rules, expected) =>
          rules.length === 1 && JSON.stringify(rules[0]) === JSON.stringify(expected);
        const sccRole = cli(
          `oc create role use-priv --verb=use --resource=securitycontextconstraints --resource-name=privileged -n ${rbacProject}`
        );
        const sccRules = roleRules('use-priv');
        const sccExpected = {
          apiGroups: ['security.openshift.io'],
          resources: ['securitycontextconstraints'],
          resourceNames: ['privileged'],
          verbs: ['use'],
        };
        if (!sccRole.error && rulesEqual(sccRules, sccExpected)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#72: \`oc create role --resource=securitycontextconstraints\` must write apiGroups ["security.openshift.io"]: ${JSON.stringify({ error: sccRole.error, message: sccRole.message, rules: sccRules })}`
          );
        }
        cli(
          `oc create role use-scc-alias --verb=use --resource=scc --resource-name=privileged -n ${rbacProject}`
        );
        if (rulesEqual(roleRules('use-scc-alias'), sccExpected)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#72: the \`scc\` short resource name must resolve to securitycontextconstraints.security.openshift.io: ${JSON.stringify(roleRules('use-scc-alias'))}`
          );
        }
        const nonCoreGroups = [
          ['routes', ['route.openshift.io'], ['routes']],
          ['imagestreamtags', ['image.openshift.io'], ['imagestreamtags']],
          ['deployments', ['apps'], ['deployments']],
        ];
        for (const [resource, groups, resources] of nonCoreGroups) {
          const name = `role-${resource}`;
          cli(`oc create role ${name} --verb=get --resource=${resource} -n ${rbacProject}`);
          const rules = roleRules(name);
          if (
            rules.length === 1 &&
            JSON.stringify(rules[0].apiGroups) === JSON.stringify(groups) &&
            JSON.stringify(rules[0].resources) === JSON.stringify(resources)
          ) {
            passed();
          } else {
            fail(
              'fidelity',
              `#72: \`oc create role --resource=${resource}\` must resolve to apiGroups ${JSON.stringify(groups)}/resources ${JSON.stringify(resources)}: ${JSON.stringify(rules)}`
            );
          }
        }
        const coreRole = cli(
          `oc create role pod-reader --verb=get --resource=pods -n ${rbacProject}`
        );
        const coreRules = roleRules('pod-reader');
        if (
          !coreRole.error &&
          coreRules.length === 1 &&
          JSON.stringify(coreRules[0].apiGroups) === JSON.stringify(['']) &&
          JSON.stringify(coreRules[0].resources) === JSON.stringify(['pods'])
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#72: core resources must keep apiGroups [""] (pods): ${JSON.stringify(coreRules)}`
          );
        }
        // The resolved grant must actually grant: can-i flips no → yes.
        cli(`oc create sa priv-sa -n ${rbacProject}`);
        const beforeGrant = cli(
          `oc auth can-i use scc/privileged --as=system:serviceaccount:${rbacProject}:priv-sa -n ${rbacProject}`
        );
        cli(
          `oc create rolebinding priv-sa-use-scc --role=use-priv --serviceaccount=${rbacProject}:priv-sa -n ${rbacProject}`
        );
        const afterGrant = cli(
          `oc auth can-i use scc/privileged --as=system:serviceaccount:${rbacProject}:priv-sa -n ${rbacProject}`
        );
        if (beforeGrant.message.trim() === 'no' && afterGrant.message.trim() === 'yes') {
          passed();
        } else {
          fail(
            'fidelity',
            `#72: a custom SCC "use" Role bound to the SA must flip \`oc auth can-i use scc/privileged\` from no to yes: ${JSON.stringify({ before: beforeGrant.message.trim(), prefix: beforeGrant.message.slice(0, 120), after: afterGrant.message.trim() })}`
          );
        }
      } catch (err) {
        fail('fidelity', `#72: oc create role API-group lock could not run: ${err.message}`);
      }

      // ── #73 — PendingScheduling damage is a template rollout, never a pod ──
      try {
        const incidentEngine = new incidentMod.IncidentEngine(engine);
        incidentEngine.start('sandbox');
        const pendingProject = 'qa4k-pending';
        cli(`oc new-project ${pendingProject}`);
        cli(
          `oc create deployment webapp --replicas=2 --image=quay.io/openshift/origin-hello-openshift:latest -n ${pendingProject}`
        );
        tick(5, incidentEngine);
        const snapshotPods = () =>
          cluster.getByKindAndNamespace('Pod', pendingProject).map((pod) => ({
            name: pod.metadata.name,
            phase: pod.status?.phase || '',
            ready: (pod.status?.containerStatuses || []).every((status) => status.ready),
            nodeName: pod.spec?.nodeName || '',
            nodeSelector: pod.spec?.nodeSelector || null,
          }));
        const beforePods = snapshotPods();
        const runningBefore = beforePods.filter(
          (pod) => pod.phase === 'Running' && pod.ready && pod.nodeName
        );
        const pendingDef = [...incidentEngine._defsById.values()].find(
          (def) => def.name === 'PendingScheduling'
        );
        const pendingId = pendingDef
          ? incidentEngine.spawnIncident(pendingDef, 'webapp', 3, {
              exactTarget: true,
              namespace: pendingProject,
            })
          : null;
        tick(8, incidentEngine);
        const deploymentAfter = cluster.getByName('Deployment', 'webapp', pendingProject);
        const templateSelector = deploymentAfter?.spec?.template?.spec?.nodeSelector || null;
        const afterPods = snapshotPods();
        const newPods = afterPods.filter(
          (pod) => !beforePods.some((before) => before.name === pod.name)
        );
        const pendingPod =
          newPods.find((pod) => pod.phase === 'Pending') ||
          afterPods.find((pod) => pod.phase === 'Pending');
        const runningPodsIntact = runningBefore.every((before) => {
          const now = afterPods.find((pod) => pod.name === before.name);
          return (
            now &&
            now.phase === 'Running' &&
            JSON.stringify(now.nodeSelector || null) === JSON.stringify(before.nodeSelector)
          );
        });
        if (pendingId && templateSelector && Object.keys(templateSelector).length > 0) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: PendingScheduling must patch the Deployment template nodeSelector (immutable pod specs), not mutate a Running pod: ${JSON.stringify({ pendingId, templateSelector })}`
          );
        }
        if (runningPodsIntact) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: pods already Running before the incident must never be re-pended or have their spec mutated: ${JSON.stringify({ beforePods, afterPods })}`
          );
        }
        if (pendingPod && !pendingPod.nodeName) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: the damaged rollout must leave a NEW unscheduled (Pending, no nodeName) pod while old pods serve: ${JSON.stringify({ newPods, afterPods })}`
          );
        }
        const allPodEvents = cluster
          .getByKind('Pod')
          .flatMap((pod) =>
            (pod.events || []).map((event) => ({ pod: pod.metadata.name, ...event }))
          );
        const failedScheduling = allPodEvents.find((event) => event.reason === 'FailedScheduling');
        if (
          failedScheduling &&
          /^0\/3 nodes are available: \d+ node\(s\) didn't match Pod's node affinity\/selector\.$/.test(
            String(failedScheduling.message || '')
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: the Pending pod must carry the k8s v1.35 FailedScheduling wording "0/<N> nodes are available: <M> node(s) didn't match Pod's node affinity/selector.": ${JSON.stringify({ failedScheduling, events: allPodEvents.slice(0, 8) })}`
          );
        }
        const healedEvents = [
          ...allPodEvents,
          ...cluster.getByKind('ReplicaSet').flatMap((rs) => rs.events || []),
        ].filter((event) => /^Healed$/.test(String(event.reason || '')));
        if (healedEvents.length === 0) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: the incident must not fabricate a kubelet "Healed" event: ${JSON.stringify(healedEvents)}`
          );
        }
        const widePods = cli(`oc get pods -o wide -n ${pendingProject}`).message;
        const wideRows = tableRows(widePods);
        const wideHeader = wideRows[0] || [];
        const nodeColumn = wideHeader.indexOf('NODE');
        const pendingRow = wideRows.find((row) => pendingPod && row[0] === pendingPod.name);
        if (
          nodeColumn >= 0 &&
          pendingRow &&
          pendingRow[nodeColumn] === '<none>' &&
          !/^10\.|^192\.168\./.test(pendingRow[nodeColumn] || '')
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: \`oc get pods -o wide\` NODE column for the Pending pod must be <none> (never a node InternalIP): ${JSON.stringify({ header: wideHeader, pendingRow, pendingPod })}`
          );
        }
        // The documented fixes must heal the state (delete-pod is not the fix).
        const undone = cli(`oc rollout undo deployment/webapp -n ${pendingProject}`);
        tick(10, incidentEngine);
        const healedPods = snapshotPods();
        const healedSelector =
          cluster.getByName('Deployment', 'webapp', pendingProject)?.spec?.template?.spec
            ?.nodeSelector || null;
        if (
          !undone.error &&
          healedPods.every((pod) => pod.phase === 'Running') &&
          (!healedSelector || Object.keys(healedSelector).length === 0)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#73: \`oc rollout undo\` must remove the bad template nodeSelector and restore Running pods: ${JSON.stringify({ undone: undone.message, healedSelector, healedPods })}`
          );
        }
      } catch (err) {
        fail('fidelity', `#73: PendingScheduling rollout lock could not run: ${err.message}`);
      }

      // ── #74 — a Job pod template is immutable (real API-server rejection) ──
      try {
        const jobsProject = 'qa4k-jobs';
        cli(`oc new-project ${jobsProject}`);
        cli(
          `oc create quota prod-quota --hard=pods=20,requests.cpu=4,requests.memory=8Gi -n ${jobsProject}`
        );
        cli(`oc create job db-migrate --image=busybox:latest -n ${jobsProject}`);
        tick(4);
        const rejected = cli(
          `oc set resources job/db-migrate -n ${jobsProject} --requests=cpu=100m,memory=128Mi`
        );
        const job = cluster.getByName('Job', 'db-migrate', jobsProject);
        const jobContainer = job?.spec?.template?.spec?.containers?.[0];
        if (
          rejected.error &&
          /The Job "db-migrate" is invalid: spec\.template: Invalid value/.test(rejected.message) &&
          /field is immutable/.test(rejected.message) &&
          !jobContainer?.resources?.requests
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#74: \`oc set resources job/<name>\` must be rejected with the real "spec.template: Invalid value: ...: field is immutable" error and must not mutate the Job: ${JSON.stringify({ error: rejected.error, message: rejected.message, resources: jobContainer?.resources })}`
          );
        }
        tick(4);
        const jobAfter = cluster.getByName('Job', 'db-migrate', jobsProject);
        if (jobAfter?.status?.phase !== 'Complete' && jobAfter?.status?.phase !== 'Succeeded') {
          passed();
        } else {
          fail(
            'fidelity',
            `#74: the rejected requestless Job must stay blocked by the quota (no completion): ${JSON.stringify(jobAfter?.status)}`
          );
        }
        // Deployment pod templates stay mutable.
        cli(
          `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${jobsProject}`
        );
        const deploymentUpdate = cli(
          `oc set resources deployment/web --requests=cpu=100m,memory=128Mi -n ${jobsProject}`
        );
        if (!deploymentUpdate.error) {
          passed();
        } else {
          fail(
            'fidelity',
            `#74: Deployment templates remain mutable, so \`oc set resources deployment/<name>\` must still work: ${deploymentUpdate.message}`
          );
        }
        // The exam-correct fix: delete + recreate the Job from YAML with requests.
        manifestEngine.writeFile(
          'qa4k-job.yaml',
          [
            'apiVersion: batch/v1',
            'kind: Job',
            'metadata:',
            '  name: db-migrate',
            `  namespace: ${jobsProject}`,
            'spec:',
            '  template:',
            '    spec:',
            '      restartPolicy: Never',
            '      containers:',
            '        - name: db-migrate',
            '          image: busybox:latest',
            '          command: ["sh", "-c", "echo migrated"]',
            '          resources:',
            '            requests:',
            '              cpu: 100m',
            '              memory: 128Mi',
          ].join('\n')
        );
        cli(`oc delete job db-migrate -n ${jobsProject}`);
        const recreated = cli(`oc apply -f qa4k-job.yaml`);
        let recreatedComplete = false;
        for (let played = 0; played < 20; played += 1) {
          tick(1);
          const recreatedJob = cluster.getByName('Job', 'db-migrate', jobsProject);
          if (recreatedJob && /^(Complete|Succeeded)$/.test(String(recreatedJob.status?.phase))) {
            recreatedComplete = true;
            break;
          }
        }
        if (!recreated.error && recreatedComplete) {
          passed();
        } else {
          fail(
            'fidelity',
            `#74: deleting the Job and recreating it from YAML with resources.requests must complete: ${JSON.stringify({ error: recreated.error, message: recreated.message, recreatedComplete })}`
          );
        }
        const dryRunJob = cli(
          `oc create job qa-dry-job --image=busybox:latest --dry-run=client -o yaml -n ${jobsProject}`
        );
        if (
          !dryRunJob.error &&
          /-\s+name:\s+qa-dry-job\b/.test(dryRunJob.message) &&
          !/-\s+name:\s+main\b/.test(dryRunJob.message)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#74: \`oc create job --dry-run=client -o yaml\` must name the container after the Job (kubectl create_job.go), not "main": ${JSON.stringify(dryRunJob.message)}`
          );
        }
      } catch (err) {
        fail('fidelity', `#74: Job immutability lock could not run: ${err.message}`);
      }

      // ── #75 — debug signals: real cert errors, shell substitution, job
      //    deadline wording and honest admission failure messages ────────────
      try {
        const shellProject = 'qa4k-shell';
        cli(`oc new-project ${shellProject}`);
        cli(
          `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${shellProject}`
        );
        tick(4);
        // `oc create secret tls` must fail on missing files like real oc.
        const missingCert = cli(
          `oc create secret tls missing-tls --cert=missing.crt --key=missing.key -n ${shellProject}`
        );
        const missingSecret = cluster.getByName('Secret', 'missing-tls', shellProject);
        if (
          missingCert.error &&
          /open missing\.crt: no such file or directory/.test(missingCert.message) &&
          !missingSecret
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: \`oc create secret tls x --cert=missing.crt --key=missing.key\` must fail with "open missing.crt: no such file or directory" and create no Secret: ${JSON.stringify({ error: missingCert.error, message: missingCert.message, created: Boolean(missingSecret) })}`
          );
        }
        // The real openssl flow creates the files, so the Secret then exists.
        cli(
          'openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 365 -subj /CN=qa4k.example.com'
        );
        const tlsSecretResult = cli(
          `oc create secret tls qa-tls --cert=tls.crt --key=tls.key -n ${shellProject}`
        );
        const tlsSecret = cluster.getByName('Secret', 'qa-tls', shellProject);
        if (
          !tlsSecretResult.error &&
          tlsSecret?.data?.['tls.crt'] &&
          tlsSecret?.data?.['tls.key']
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: after the real openssl flow, \`oc create secret tls\` must succeed with tls.crt/tls.key: ${JSON.stringify({ error: tlsSecretResult.error, message: tlsSecretResult.message, keys: Object.keys(tlsSecret?.data || {}) })}`
          );
        }
        // Word-final $(...) must expand (curl one-liner from the issue).
        cli(`oc expose svc web -n ${shellProject} --hostname=web.qa4k.example.com`);
        tick(3);
        const substituted = cli(
          `curl -s http://$(oc get route web -n ${shellProject} -o jsonpath={.spec.host})`
        );
        const trailingSlash = cli(
          `curl -s http://$(oc get route web -n ${shellProject} -o jsonpath={.spec.host})/`
        );
        if (
          !substituted.error &&
          !/URL rejected|Malformed input/.test(substituted.message) &&
          /Hello OpenShift!/.test(substituted.message) &&
          !/URL rejected|Malformed input/.test(trailingSlash.message) &&
          substituted.message === trailingSlash.message
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: a word-final command substitution must expand (\`curl http://$(oc get route … -o jsonpath={.spec.host})\`): ${JSON.stringify({ substituted, trailingSlash })}`
          );
        }
        // hello-openshift answers plain text (fmt.Fprintln), not an HTML body.
        if (
          /^Hello OpenShift!\n?$/.test(substituted.message) &&
          !/<html>|<body>/i.test(substituted.message)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: hello-openshift must answer the plain-text body "Hello OpenShift!\\n" (real origin hello-openshift fmt.Fprintln): ${JSON.stringify(substituted.message)}`
          );
        }
        // /tmp is a real virtual-filesystem directory: write/read/list/remove.
        const redirected = cli(`oc get deployment web -n ${shellProject} > /tmp/webapp.yaml`);
        const listTmp = cli('ls /tmp');
        const catTmp = cli('cat /tmp/webapp.yaml');
        const removeTmp = cli('rm /tmp/webapp.yaml');
        const listAfterRemove = cli('ls /tmp');
        if (
          !redirected.error &&
          !listTmp.error &&
          /webapp\.yaml/.test(listTmp.message) &&
          !catTmp.error &&
          /deployment|kind|NAME|metadata/i.test(catTmp.message) &&
          !removeTmp.error &&
          !/webapp\.yaml/.test(listAfterRemove.message)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: /tmp must be a consistent virtual directory (redirect, ls, cat, rm): ${JSON.stringify({ redirected, listTmp, catTmp, removeTmp, listAfterRemove })}`
          );
        }
        // L19: exact job-controller DeadlineExceeded message (no "(8s)" suffix).
        cli(`oc create job slow --image=busybox:latest -n ${shellProject} -- sh -c "sleep 30"`);
        cli(
          `oc patch job/slow -n ${shellProject} -p '{"spec":{"activeDeadlineSeconds":2}}' --type=merge`
        );
        let deadlineMessage = '';
        for (let played = 0; played < 30; played += 1) {
          tick(1);
          const slowJob = cluster
            .getByKindAndNamespace('Job', shellProject)
            .find((entry) => entry.metadata.name === 'slow');
          const deadlineEvent = (slowJob?.events || []).find(
            (event) => event.reason === 'DeadlineExceeded'
          );
          if (deadlineEvent) {
            deadlineMessage = String(deadlineEvent.message || '');
            break;
          }
        }
        if (deadlineMessage === 'Job was active longer than specified deadline') {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: the DeadlineExceeded event message must be exactly "Job was active longer than specified deadline" (k8s v1.35 job controller), got ${JSON.stringify(deadlineMessage)}`
          );
        }
        // lab 8: a Deployment whose ServiceAccount does not exist must not get
        // a Running pod — ServiceAccount admission records FailedCreate.
        const admissionProject = 'qa4k-admission';
        cli(`oc new-project ${admissionProject}`);
        engine.applyManifestObject({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'privileged-app', namespace: admissionProject },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: 'privileged-app' } },
            template: {
              metadata: { labels: { app: 'privileged-app' } },
              spec: {
                serviceAccountName: 'priv-sa',
                containers: [
                  {
                    name: 'main',
                    image: 'quay.io/openshift/origin-hello-openshift:latest',
                    securityContext: { privileged: true },
                  },
                ],
              },
            },
          },
        });
        const admissionEvents = () =>
          cluster
            .getByKindAndNamespace('ReplicaSet', admissionProject)
            .flatMap((rs) => rs.events || []);
        let saMissingMessage = '';
        for (let played = 0; played < 20 && !saMissingMessage; played += 1) {
          tick(1);
          saMissingMessage = String(
            (
              admissionEvents().find((event) =>
                /serviceaccount "priv-sa" not found/.test(String(event.message || ''))
              ) || {}
            ).message || ''
          );
        }
        if (
          /error looking up service account qa4k-admission\/priv-sa: serviceaccount "priv-sa" not found/.test(
            saMissingMessage
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: a Deployment whose ServiceAccount does not exist must record the real ServiceAccount admission failure "error looking up service account <ns>/priv-sa: serviceaccount \\"priv-sa\\" not found": ${JSON.stringify({ saMissingMessage, events: admissionEvents().slice(0, 6) })}`
          );
        }
        cli(`oc create sa priv-sa -n ${admissionProject}`);
        let sccMessage = '';
        for (let played = 0; played < 20 && !sccMessage; played += 1) {
          tick(1);
          sccMessage = String(
            (
              admissionEvents().find((event) =>
                /unable to validate against any security context constraint/.test(
                  String(event.message || '')
                )
              ) || {}
            ).message || ''
          );
        }
        if (
          /^.*unable to validate against any security context constraint: \[provider "[a-z-]+": .*Privileged containers are not allowed/.test(
            sccMessage
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: the SCC FailedCreate message must append the per-provider reasons (provider + "Privileged containers are not allowed"): ${JSON.stringify({ sccMessage, events: admissionEvents().slice(0, 6) })}`
          );
        }
        const admittedPods = cluster.getByKindAndNamespace('Pod', admissionProject);
        if (
          admittedPods.every(
            (pod) =>
              !(pod.spec?.containers || []).some(
                (container) => container.securityContext?.privileged
              )
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#75: the privileged Deployment must not produce a Running pod before the SCC grant: ${JSON.stringify(admittedPods.map((pod) => ({ name: pod.metadata.name, phase: pod.status?.phase })))}`
          );
        }
      } catch (err) {
        fail('fidelity', `#75: debug-signal shell/admission lock could not run: ${err.message}`);
      }

      // ── #76 — kubectl-1.35 output fidelity (explain/jsonpath/kustomize/
      //    new-app/lists/login/helm/describe) and MetalLB/heartbeat models ────
      try {
        // explain v2 plaintext template (real kubectl 1.35 / oc 4.22).
        const explainStrategy = cli('oc explain deployment.spec.strategy').message;
        const explainDeployment = cli('oc explain deployment').message;
        const explainPod = cli('oc explain pod').message;
        const strategyLines = explainStrategy.split('\n');
        const strategyFieldsAt = strategyLines.findIndex((line) => line === 'FIELDS:');
        const strategyHeaderOk =
          /^GROUP: {6}apps$/m.test(explainStrategy) &&
          /^KIND: {7}Deployment$/m.test(explainStrategy) &&
          /^VERSION: {4}v1$/m.test(explainStrategy) &&
          /^FIELD: strategy <DeploymentStrategy>$/m.test(explainStrategy) &&
          strategyLines[3] === '' &&
          strategyLines[5] === '';
        if (strategyHeaderOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc explain deployment.spec.strategy\` must use the kubectl-1.35 explain v2 header (GROUP/KIND/VERSION aligned at col 13, blank line, "FIELD: strategy <DeploymentStrategy>", blank line): ${JSON.stringify(explainStrategy.slice(0, 500))}`
          );
        }
        const rollingUpdateLine = strategyLines.findIndex(
          (line) => line === '  rollingUpdate\t<RollingUpdateDeployment>'
        );
        const typeLine = strategyLines.findIndex((line) => line === '  type\t<string>');
        const descriptionAt = strategyLines.findIndex((line) => line === 'DESCRIPTION:');
        const descriptionIndented = strategyLines
          .slice(descriptionAt + 1, strategyFieldsAt)
          .some((line) => /^ {4}\S/.test(line));
        if (
          descriptionAt >= 0 &&
          descriptionIndented &&
          rollingUpdateLine > strategyFieldsAt &&
          typeLine > rollingUpdateLine &&
          strategyFieldsAt > descriptionAt &&
          strategyLines[strategyFieldsAt - 1] !== ''
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: explain v2 FIELDS must list rollingUpdate before type (tab + <Type>, 2-space indent) right after the 4-space-indented DESCRIPTION, including the enum line: ${JSON.stringify(explainStrategy.slice(0, 900))}`
          );
        }
        // (The FIELDS entries and enum are checked separately to keep each
        // failure message actionable.)
        if (
          rollingUpdateLine >= 0 &&
          typeLine > rollingUpdateLine &&
          /^  enum: Recreate, RollingUpdate$/m.test(explainStrategy)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: explain v2 must include rollingUpdate <RollingUpdateDeployment>, type <string> and the "enum: Recreate, RollingUpdate" line: ${JSON.stringify({ rollingUpdateLine, typeLine, excerpt: explainStrategy.slice(-400) })}`
          );
        }
        const deploymentFields = explainDeployment.split('\n');
        const deploymentFidsAt = deploymentFields.findIndex((line) => line === 'FIELDS:');
        const afterFields = deploymentFields.slice(deploymentFidsAt + 1);
        const topLevelOk =
          /^GROUP: {6}apps$/m.test(explainDeployment) &&
          /^KIND: {7}Deployment$/m.test(explainDeployment) &&
          !/^FIELD:[ \t]/m.test(explainDeployment) &&
          deploymentFidsAt >= 0 &&
          afterFields.some((line) => line === '  spec\t<DeploymentSpec>') &&
          afterFields.some((line) => line === '  metadata\t<ObjectMeta>') &&
          afterFields.some((line) => line === '  status\t<DeploymentStatus>') &&
          afterFields.every(
            (line) => line === '' || /^  \S+\t<.+>$/.test(line) || /^ {6}enum:/.test(line)
          );
        if (topLevelOk) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: top-level \`oc explain deployment\` must print GROUP/KIND/VERSION + DESCRIPTION + an alphabetically sorted FIELDS list with tab + <Type> entries and no per-field descriptions: ${JSON.stringify(explainDeployment.slice(0, 900))}`
          );
        }
        if (
          !/^GROUP:/m.test(explainPod) &&
          /^KIND: {7}Pod$/m.test(explainPod) &&
          /^VERSION: {4}v1$/m.test(explainPod)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: explain v2 omits the GROUP line for core kinds (Pod): ${JSON.stringify(explainPod.slice(0, 400))}`
          );
        }

        // jsonpath: object/slice values marshal like client-go (JSON, brackets).
        const shellProject = 'qa4k-shell';
        cli(`oc set env deployment/web -n ${shellProject} APP_ENV=production`);
        const envJsonPath = cli(
          `oc get deployment web -n ${shellProject} -o jsonpath={.spec.template.spec.containers[0].env}`
        ).message.trim();
        let envParsed = null;
        try {
          envParsed = JSON.parse(envJsonPath);
        } catch {
          envParsed = null;
        }
        if (
          Array.isArray(envParsed) &&
          envParsed[0]?.name === 'APP_ENV' &&
          envParsed[0]?.value === 'production'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: jsonpath on a list field must marshal as a JSON array (\`{.spec.template.spec.containers[0].env}\` → [{"name":"APP_ENV","value":"production"}]): ${JSON.stringify(envJsonPath)}`
          );
        }
        const portsJsonPath = cli(
          `oc get svc web -n ${shellProject} -o jsonpath={.spec.ports}`
        ).message.trim();
        let portsParsed = null;
        try {
          portsParsed = JSON.parse(portsJsonPath);
        } catch {
          portsParsed = null;
        }
        if (
          Array.isArray(portsParsed) &&
          portsParsed.length >= 1 &&
          Number(portsParsed[0].port) === 8080
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: jsonpath on the Service ports slice must print a JSON array (client-go jsonpath.go), got ${JSON.stringify(portsJsonPath)}`
          );
        }
        const scalarJsonPath = cli(
          `oc get deployment web -n ${shellProject} -o jsonpath={.spec.replicas}`
        ).message.trim();
        if (scalarJsonPath === '1') {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: jsonpath scalar output must stay a bare value: ${JSON.stringify(scalarJsonPath)}`
          );
        }

        // kustomize / apply -k: Kustomize legacy sort (Service before Deployment).
        manifestEngine.writeFile(
          'qa4k-kustomize/kustomization.yaml',
          'resources:\n  - deployment.yaml\n  - service.yaml\n'
        );
        manifestEngine.writeFile(
          'qa4k-kustomize/deployment.yaml',
          [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  name: kd',
            '  namespace: default',
            'spec:',
            '  replicas: 1',
            '  selector:',
            '    matchLabels: {app: kd}',
            '  template:',
            '    metadata:',
            '      labels: {app: kd}',
            '    spec:',
            '      containers:',
            '        - name: c',
            '          image: quay.io/openshift/origin-hello-openshift:latest',
          ].join('\n')
        );
        manifestEngine.writeFile(
          'qa4k-kustomize/service.yaml',
          [
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            '  name: ks',
            '  namespace: default',
            'spec:',
            '  selector: {app: kd}',
            '  ports:',
            '    - port: 8080',
          ].join('\n')
        );
        const rendered = cli('oc kustomize qa4k-kustomize').message;
        const serviceAt = rendered.indexOf('kind: Service');
        const deploymentAt = rendered.indexOf('kind: Deployment');
        if (serviceAt >= 0 && deploymentAt > serviceAt) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc kustomize\` must apply the Kustomize legacy sort (Service before Deployment): ${JSON.stringify({ serviceAt, deploymentAt, excerpt: rendered.slice(0, 500) })}`
          );
        }
        const appliedKustomize = cli('oc apply -k qa4k-kustomize').message;
        if (
          appliedKustomize.indexOf('service/ks') >= 0 &&
          appliedKustomize.indexOf('deployment.apps/kd') > appliedKustomize.indexOf('service/ks')
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc apply -k\` must create resources in Kustomize legacy sort order (Service before Deployment): ${JSON.stringify(appliedKustomize)}`
          );
        }

        // oc new-app Service port names are "%d-%s" (8080-tcp / 3306-tcp).
        const portsProject = 'qa4k-ports';
        cli(`oc new-project ${portsProject}`);
        cli(
          `oc new-app --image=quay.io/openshift/origin-hello-openshift:latest --name=api -n ${portsProject}`
        );
        const apiService = cluster.getByName('Service', 'api', portsProject);
        if (apiService?.spec?.ports?.[0]?.name === '8080-tcp') {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc new-app\` must name Service ports fmt.Sprintf("%d-%s") → "8080-tcp", got ${JSON.stringify(apiService?.spec?.ports)}`
          );
        }
        cli(
          `oc new-app --image=registry.redhat.io/rhel9/mysql-80 --name=database -n ${portsProject}`
        );
        const mysqlService = cluster.getByName('Service', 'database', portsProject);
        if (mysqlService?.spec?.ports?.[0]?.name === '3306-tcp') {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: the MySQL new-app Service port must be "3306-tcp", got ${JSON.stringify(mysqlService?.spec?.ports)}`
          );
        }
        cli(`oc expose svc api -n ${portsProject}`);
        const routeLines = cli(`oc get route api -n ${portsProject}`)
          .message.split('\n')
          .filter((line) => line.trim() !== '');
        const routeDataLine = routeLines[1] || '';
        if (/^api\s+\S+\s+\S+\s+8080-tcp(?:\s|$)/.test(routeDataLine)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: the Route PORT column must reflect the new-app Service port name "8080-tcp": ${JSON.stringify(routeDataLine)}`
          );
        }

        // oc login project listing (loginoptions.go).
        cli(`oc new-project qa4k-login-a`);
        cli(`oc new-project qa4k-login-b`);
        const login = cli(`oc login -u kubeadmin -p ${clusterStateMod.KUBEADMIN_PASSWORD}`).message;
        const loginHeader =
          "You have access to the following projects and can switch between them with 'oc project <projectname>':";
        const loginLines = login.split('\n');
        const loginHeaderAt = loginLines.indexOf(loginHeader);
        const currentMarkerAt = loginLines.indexOf('  * qa4k-login-b');
        const otherProjectAt = loginLines.findIndex((line) => /^ {4}default$/.test(line));
        if (
          !/You have access to \d+ projects/.test(login) &&
          loginHeaderAt >= 0 &&
          loginLines[loginHeaderAt + 1] === '' &&
          currentMarkerAt > loginHeaderAt &&
          otherProjectAt > loginHeaderAt &&
          /^Using project "qa4k-login-b"\.$/m.test(login)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc login\` must print the real 4.22 project list ("You have access to the following projects and can switch between them with 'oc project <projectname>':", "  * <current>", 4-space others, "Using project \\"<x>\\"."): ${JSON.stringify(login.slice(0, 900))}`
          );
        }
        const singleProjectText = allFiles
          .filter((rel) => rel.startsWith('js/') && rel.endsWith('.js'))
          .map((rel) => read(rel))
          .some((src) => src.includes('You have one project on this server:'));
        if (singleProjectText) {
          passed();
        } else {
          fail(
            'fidelity',
            '#76: the exact-one-project login text `You have one project on this server: "<project>"` must exist in the CLI implementation'
          );
        }

        // describe quota: canonical resource.Quantity strings.
        const quotaProject = 'qa4k-quota';
        cli(`oc new-project ${quotaProject}`);
        cli(
          `oc create quota q --hard=pods=10,requests.cpu=4,requests.memory=8Gi -n ${quotaProject}`
        );
        cli(
          `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${quotaProject}`
        );
        cli(
          `oc set resources deployment/web --requests=cpu=1000m,memory=1024Mi -n ${quotaProject}`
        );
        tick(4);
        const quotaDescribe = cli(`oc describe quota q -n ${quotaProject}`).message;
        const quotaRows = quotaDescribe
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()));
        const cpuRow = quotaRows.find((row) => row[0] === 'requests.cpu') || [];
        const memoryRow = quotaRows.find((row) => row[0] === 'requests.memory') || [];
        if (
          cpuRow[1] === '1' &&
          cpuRow[2] === '4' &&
          memoryRow[1] === '1Gi' &&
          memoryRow[2] === '8Gi'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc describe quota\` Used values must be canonical quantities (1000m→1, 1024Mi→1Gi): ${JSON.stringify({ cpuRow, memoryRow, excerpt: quotaDescribe })}`
          );
        }

        // oc get all: the API server returns lists sorted by name.
        const orderProject = 'qa4k-order';
        cli(`oc new-project ${orderProject}`);
        cli(
          `oc create deployment web --image=quay.io/openshift/origin-hello-openshift:latest -n ${orderProject}`
        );
        cli(`oc expose deployment web -n ${orderProject}`);
        cli(
          `oc create deployment shop --image=quay.io/openshift/origin-hello-openshift:latest -n ${orderProject}`
        );
        cli(`oc expose deployment shop -n ${orderProject}`);
        const allList = cli(`oc get all -n ${orderProject}`).message;
        const allLines = allList.split('\n');
        const serviceOrder = allLines
          .filter((line) => /^service\//.test(line))
          .map((line) => line.split(/\s+/)[0]);
        const deploymentOrder = allLines
          .filter((line) => /^deployment\.apps\//.test(line))
          .map((line) => line.split(/\s+/)[0]);
        if (
          JSON.stringify(serviceOrder) === JSON.stringify(['service/shop', 'service/web']) &&
          JSON.stringify(deploymentOrder) ===
            JSON.stringify(['deployment.apps/shop', 'deployment.apps/web'])
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc get all\` must be name-sorted like the API server (shop before web): ${JSON.stringify({ serviceOrder, deploymentOrder })}`
          );
        }

        // oc get identities: USER UID is populated (OpenShift always sets one).
        // Use the real login/`createIdentity` path this time: a raw Identity
        // manifest only references the user by name, which is the fallback edge.
        cli('oc create user qa4k-user');
        cluster.createIdentity('htpasswd', 'qa4k-user', 'qa4k-user');
        const identities = tableRows(cli('oc get identities').message);
        const identityRow =
          identities.find((row) => row[0] === 'htpasswd:qa4k-user') ||
          identities.find((row) => /htpasswd:qa4k-user/.test(String(row[0]))) ||
          [];
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            identityRow[identityRow.length - 1] || ''
          )
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc get identities\` must populate the USER UID column: ${JSON.stringify({ header: identities[0], row: identityRow })}`
          );
        }

        // helm list: UPDATED is the Go time.Time.String() timestamp, not 0s.
        const helmProject = 'qa4k-helm';
        cli(`oc new-project ${helmProject}`);
        cli('helm repo add bitnami https://charts.bitnami.com/bitnami');
        const helmInstall = cli(`helm install webapp helm/webapp -n ${helmProject}`);
        const helmList = tableRows(cli(`helm list -n ${helmProject}`).message);
        const updatedColumn = (helmList[0] || []).indexOf('UPDATED');
        const updatedValue = (helmList[1] || [])[updatedColumn] || '';
        if (
          !helmInstall.error &&
          updatedColumn >= 0 &&
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})? \+0000 UTC$/.test(updatedValue) &&
          updatedValue !== '0s'
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`helm list\` UPDATED must be the Go time.Time.String() form (YYYY-MM-DD HH:MM:SS.fffffffff +0000 UTC), not "0s": ${JSON.stringify({ updatedColumn, updatedValue, rows: helmList.slice(0, 2), error: helmInstall.message })}`
          );
        }

        // describe pod: Waiting prints only Reason; Terminated Last State shows
        // Started before Finished; Running containers carry real IDs.
        const podsProject = 'qa4k-pods';
        cli(`oc new-project ${podsProject}`);
        engine.applyManifestObject({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'qa4k-crash', namespace: podsProject },
          spec: {
            containers: [
              {
                name: 'main',
                image: 'quay.io/openshift/origin-hello-openshift:latest',
              },
            ],
          },
        });
        const crashPod = cluster.getByName('Pod', 'qa4k-crash', podsProject);
        if (crashPod) {
          crashPod.status = {
            ...(crashPod.status || {}),
            phase: 'CrashLoopBackOff',
            containerStatuses: [
              {
                name: 'main',
                image: 'quay.io/openshift/origin-hello-openshift:latest',
                ready: false,
                started: false,
                restartCount: 2,
                state: {
                  waiting: {
                    reason: 'CrashLoopBackOff',
                    message: 'Back-off restarting failed container',
                  },
                },
                lastState: {
                  terminated: {
                    exitCode: 1,
                    reason: 'Error',
                    startedAt: '2026-11-05T20:00:00Z',
                    finishedAt: '2026-11-05T20:00:01Z',
                  },
                },
              },
            ],
          };
          cluster.update(crashPod.uid, crashPod);
        }
        const crashDescribe = cli(`oc describe pod qa4k-crash -n ${podsProject}`).message;
        if (
          crashPod &&
          /^ {4}State: +Waiting$/m.test(crashDescribe) &&
          /^ {6}Reason: +CrashLoopBackOff$/m.test(crashDescribe) &&
          !/^ {6}Message: +Back-off restarting failed container/m.test(crashDescribe)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: describe pod must print only Reason for a Waiting container state (no "Message: Back-off restarting failed container"): ${JSON.stringify(crashDescribe.slice(0, 1100))}`
          );
        }
        const crashLines = crashDescribe.split('\n');
        const lastStateAt = crashLines.findIndex((line) =>
          /^ {4}Last State: +Terminated$/.test(line)
        );
        const lastStateBlock = crashLines.slice(lastStateAt, lastStateAt + 8).join('\n');
        const startedAtIdx = lastStateBlock.indexOf('Started:');
        const finishedAtIdx = lastStateBlock.indexOf('Finished:');
        if (lastStateAt >= 0 && startedAtIdx >= 0 && startedAtIdx < finishedAtIdx) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: a Terminated Last State must print Started before Finished: ${JSON.stringify({ lastStateAt, block: lastStateBlock })}`
          );
        }
        cli(
          `oc create deployment run --image=quay.io/openshift/origin-hello-openshift:latest -n ${podsProject}`
        );
        tick(4);
        const runPod = cluster
          .getByKindAndNamespace('Pod', podsProject)
          .find((pod) => /^run-/.test(pod.metadata.name));
        const runningDescribe = runPod
          ? cli(`oc describe pod ${runPod.metadata.name} -n ${podsProject}`).message
          : '';
        if (
          /Container ID: +cri-o:\/\/[0-9a-f]{16,}/.test(runningDescribe) &&
          /Image ID: +[^\n]*sha256:[0-9a-f]{64}/.test(runningDescribe) &&
          !/Container ID: +<none>/.test(runningDescribe) &&
          !/Image ID: +<none>/.test(runningDescribe)
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: a Running container must describe with a real Container ID (cri-o://…) and Image ID digest, never <none>: ${JSON.stringify(runningDescribe.slice(0, 900))}`
          );
        }

        // describe job prints Active Deadline Seconds whenever it is set.
        const jobDescribeProject = 'qa4k-job-describe';
        cli(`oc new-project ${jobDescribeProject}`);
        cli(`oc create job deadline-job --image=busybox:latest -n ${jobDescribeProject}`);
        cli(
          `oc patch job/deadline-job -n ${jobDescribeProject} -p '{"spec":{"activeDeadlineSeconds":8}}' --type=merge`
        );
        const jobDescribe = cli(`oc describe job deadline-job -n ${jobDescribeProject}`).message;
        if (/^Active Deadline Seconds: +8s$/m.test(jobDescribe)) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: \`oc describe job\` must print "Active Deadline Seconds:  8s" whenever spec.activeDeadlineSeconds is set: ${JSON.stringify(jobDescribe.slice(0, 900))}`
          );
        }

        // NotReady node: LastHeartbeatTime freezes at the last kubelet post.
        const heartbeatEngine = new incidentMod.IncidentEngine(engine);
        heartbeatEngine.start('sandbox');
        const nodeNotReadyDef = [...heartbeatEngine._defsById.values()].find(
          (def) => def.name === 'NodeNotReady'
        );
        heartbeatEngine.spawnIncident(nodeNotReadyDef, 'worker-1', 3, { exactTarget: true });
        tick(2, heartbeatEngine);
        const readReadyCondition = () => {
          const node = cluster
            .getByKind('Node')
            .find((entry) => entry.metadata.name === 'worker-1');
          return (node?.status?.conditions || []).find((condition) => condition.type === 'Ready');
        };
        const heartbeatOnset = readReadyCondition();
        tick(10, heartbeatEngine);
        const heartbeatLater = readReadyCondition();
        if (
          heartbeatOnset?.status === 'Unknown' &&
          /Kubelet stopped posting node status/.test(String(heartbeatOnset?.message || '')) &&
          heartbeatOnset.lastHeartbeatTime === heartbeatLater?.lastHeartbeatTime &&
          heartbeatOnset.lastTransitionTime === heartbeatLater?.lastTransitionTime
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: a NotReady node's LastHeartbeatTime must freeze at the kubelet's last post (it must not keep advancing), with LastTransitionTime fixed at onset: ${JSON.stringify({ onset: heartbeatOnset, later: heartbeatLater })}`
          );
        }

        // MetalLB: redhat-operators OCP-minor CSV name and ONE canonical
        // IPAllocated emitter (SimulationTick), no cloud-provider leftovers.
        const jsSources = allFiles
          .filter((rel) => rel.startsWith('js/') && rel.endsWith('.js'))
          .map((rel) => ({ rel, src: read(rel) }));
        const csvName = 'metallb-operator.v4.22.0-202610281200';
        const newCsvRefs = jsSources
          .filter(({ src }) => src.includes(csvName))
          .map(({ rel }) => rel);
        const oldCsvRefs = jsSources
          .filter(({ src }) => src.includes('metallb-operator.v0.14.9'))
          .map(({ rel }) => rel);
        if (oldCsvRefs.length === 0 && newCsvRefs.length >= 3) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: the MetalLB CSV must be the redhat-operators OCP-minor bundle "${csvName}" everywhere (seed + hints/labels), never metallb-operator.v0.14.9: ${JSON.stringify({ newCsvRefs, oldCsvRefs })}`
          );
        }
        const ensuredLoadBalancerRefs = jsSources
          .filter(({ src }) => /EnsuredLoadBalancer/.test(src))
          .map(({ rel }) => rel);
        if (ensuredLoadBalancerRefs.length === 0) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: the cloud-provider EnsuredLoadBalancer event must be gone (MetalLB emits IPAllocated): ${JSON.stringify(ensuredLoadBalancerRefs)}`
          );
        }
        const simulationSource = read('js/engine/SimulationTick.js');
        const otherEmitters = jsSources
          .filter(
            ({ rel, src }) =>
              /IPAllocated/.test(src) &&
              rel !== 'js/engine/SimulationTick.js' &&
              /^js\/(engine|resources)\//.test(rel)
          )
          .map(({ rel }) => rel);
        if (
          /IPAllocated/.test(simulationSource) &&
          /Assigned IP/.test(simulationSource) &&
          otherEmitters.length === 0
        ) {
          passed();
        } else {
          fail(
            'fidelity',
            `#76: MetalLB IPAllocated must have exactly ONE canonical emitter (SimulationTick, "Assigned IP [...]"); other emitters: ${JSON.stringify(otherEmitters)}`
          );
        }
      } catch (err) {
        fail('fidelity', `#76: CLI output/metallb/heartbeat lock could not run: ${err.message}`);
      }
    } finally {
      delete globalThis.window;
    }
  }
}

// ── 4l. Linux workstation model (1.16.0) ───────────────────────────────────
// The simulated RHEL 9 workstation behind the terminal (js/engine/LinuxHost.js +
// js/ui/LinuxCommands.js, wired through ShellTools/CommandBar, graded by the Linux
// objective types). The browser section `qa-linux-shell` drives the real command bar;
// these headless locks keep the contracts from regressing: the cwd path model (and
// identical behaviour at cwd = home), permissions + real coreutils wording/exit codes,
// sudo, systemd failure → journal → fix, processes, dnf/rpm, firewalld runtime vs
// permanent, rootless podman + skopeo digests, objective evaluation from STATE, and
// shell lines recorded as typed (never `oc …`).
{
  const linuxHostMod = await tryImport('js/engine/LinuxHost.js');
  const linuxEngineMod = await tryImport('js/engine/GameEngine.js');
  const linuxSandboxMod = await tryImport('js/modes/SandboxMode.js');
  const linuxBarMod = await tryImport('js/ui/CommandBar.js');
  const linuxManifestMod = await tryImport('js/engine/ManifestEngine.js');
  const linuxEvalMod = await tryImport('js/engine/ObjectiveEvaluator.js');
  const linuxClusterMod = await tryImport('js/engine/ClusterState.js');
  const lock = (ok, message, detail) => {
    if (ok) passed();
    else fail('linux', `1.16.0 workstation: ${message}`, detail);
  };
  if (
    !linuxHostMod?.LinuxHost ||
    !linuxHostMod?.imageDigest ||
    !linuxEngineMod?.GameEngine ||
    !linuxSandboxMod?.SandboxMode ||
    !linuxBarMod?.CommandBar ||
    !linuxManifestMod?.ManifestEngine ||
    !linuxEvalMod?.evaluateObjective
  ) {
    fail(
      'linux',
      '1.16.0 workstation: LinuxHost/GameEngine/CommandBar/ObjectiveEvaluator not importable'
    );
  } else {
    const engine = new linuxEngineMod.GameEngine({ mode: 'sandbox' });
    new linuxSandboxMod.SandboxMode(engine, null).setupCluster(3);
    const manifestEngine = new linuxManifestMod.ManifestEngine({
      cluster: engine.cluster,
      gameEngine: engine,
    });
    globalThis.window = {
      game: {
        cluster: engine.cluster,
        gameEngine: engine,
        engine: { emit() {}, on() {}, off() {} },
        manifestEngine,
      },
    };
    manifestEngine.game = globalThis.window.game;
    engine.setManifestEngine(manifestEngine);
    const bar = new linuxBarMod.CommandBar();
    const host = engine.linuxHost;
    /** Run one line; returns {message, error, code} (code = the shell's `$?`). */
    const sh = (line) => {
      try {
        const out = bar.executeCommand(line);
        return {
          message: String(out?.message ?? ''),
          error: Boolean(out?.error),
          code: bar.shellTools.lastExitCode,
        };
      } catch (err) {
        return { message: `THROW ${err?.message || err}`, error: true, code: -1 };
      }
    };
    const grade = (objective) =>
      Boolean(
        linuxEvalMod.evaluateObjective(objective, { gameEngine: engine, manifestEngine })?.completed
      );
    const freshHost = (seed = null) => {
      manifestEngine.resetFiles();
      host.reset(seed);
      bar.shellTools.resetSession();
    };
    try {
      // ── wiring + identity ────────────────────────────────────────────────
      lock(
        host instanceof linuxHostMod.LinuxHost && linuxEvalMod.OBJECTIVE_TYPES.includes('file'),
        'GameEngine must own the LinuxHost (gameEngine.linuxHost) and OBJECTIVE_TYPES must export the Linux types'
      );
      freshHost();
      let r = sh('whoami');
      lock(
        r.message === 'student' && r.code === 0,
        'bare `whoami` is the Linux user (student)',
        r.message
      );
      r = sh('oc whoami');
      lock(r.message.trim() === 'kubeadmin', '`oc whoami` stays the OpenShift identity', r.message);
      r = sh('echo $USER $HOME');
      lock(
        r.message === 'student /home/student',
        '$USER is the Linux user, not the OpenShift user',
        r.message
      );
      r = sh('id');
      lock(
        /^uid=1000\(student\) gid=1000\(student\) groups=1000\(student\),10\(wheel\) context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0\.c1023$/.test(
          r.message
        ),
        '`id` prints the RHEL 9 coreutils line with the SELinux context',
        r.message
      );
      r = sh('cat /etc/redhat-release');
      lock(
        r.message.trim() === 'Red Hat Enterprise Linux release 9.6 (Plow)',
        '/etc/redhat-release is RHEL 9.6',
        r.message
      );
      lock(
        bar.shellTools.prompt() === '[student@workstation ~]$',
        'prompt is `[student@workstation ~]$`',
        bar.shellTools.prompt()
      );

      // ── cwd model + identical behaviour at cwd = home ────────────────────
      r = sh('cat ~/auth/kubeadmin-password');
      lock(
        r.message.trim() === linuxClusterMod?.KUBEADMIN_PASSWORD,
        '`cat ~/auth/kubeadmin-password` still reveals the installer password',
        r.message
      );
      r = sh('ls');
      lock(
        r.message.split('\n').includes('manifests/') && r.message.split('\n').includes('htpasswd'),
        '`ls` at home lists the Files panel tree (dirs marked with /)',
        r.message
      );
      sh('echo qa4l > /tmp/qa4l.txt');
      lock(
        manifestEngine.readFile('tmp/qa4l.txt') === 'qa4l\n',
        "`echo … > /tmp/x` still writes the Files-panel key tmp/x (with echo's newline)",
        manifestEngine.readFile('tmp/qa4l.txt')
      );
      r = sh('cd manifests && oc apply -f deployment.yaml --dry-run=client');
      lock(
        !r.error && /created \(dry run\)/.test(r.message),
        '`cd manifests && oc apply -f deployment.yaml` resolves the file against the cwd',
        r.message
      );
      lock(
        bar.shellTools.prompt() === '[student@workstation manifests]$',
        'prompt follows cd (`[student@workstation manifests]$`)',
        bar.shellTools.prompt()
      );
      r = sh('pwd');
      lock(
        r.message === '/home/student/manifests',
        '`pwd` prints the logical working directory',
        r.message
      );
      r = sh('cd -');
      lock(
        r.message === '/home/student' && sh('pwd').message === '/home/student',
        '`cd -` prints and returns to OLDPWD',
        r.message
      );
      r = sh('cd /nonexistent');
      lock(
        r.code === 1 && r.message === 'bash: cd: /nonexistent: No such file or directory',
        '`cd` to a missing directory fails like bash',
        JSON.stringify(r)
      );

      // ── permissions + coreutils wording ──────────────────────────────────
      r = sh('cat /etc/shadow');
      lock(
        r.code === 1 && r.message === 'cat: /etc/shadow: Permission denied',
        'non-root `cat /etc/shadow` is refused',
        JSON.stringify(r)
      );
      r = sh('echo x > /etc/hosts');
      lock(
        r.error && r.message === 'bash: /etc/hosts: Permission denied',
        'a redirect into a root-owned file fails in bash',
        JSON.stringify(r)
      );
      r = sh('sudo cat /etc/shadow');
      lock(
        r.code === 0 && /^root:\$6\$/.test(r.message),
        '`sudo cat /etc/shadow` runs as root (passwordless lab sudo)',
        r.message.slice(0, 40)
      );
      r = sh('chmod 600 /etc/hosts');
      lock(
        r.code === 1 &&
          r.message === "chmod: changing permissions of '/etc/hosts': Operation not permitted",
        'chmod on a file you do not own is EPERM',
        r.message
      );
      r = sh('chown student /etc/hosts');
      lock(
        r.code === 1 &&
          r.message === "chown: changing ownership of '/etc/hosts': Operation not permitted",
        'chown without root is EPERM',
        r.message
      );
      sh('touch qa4l-mode && chmod 640 qa4l-mode && chmod u+x,g-r qa4l-mode');
      r = sh('stat -c %a qa4l-mode');
      lock(
        r.message === '700',
        'chmod octal + symbolic clauses compose (640 → u+x,g-r → 700)',
        r.message
      );
      r = sh('ls -l /etc/hosts');
      lock(
        /^-rw-r--r--\. 1 root root \d+ [A-Z][a-z]{2} [ \d]\d +(\d{4}|\d\d:\d\d) \/etc\/hosts$/.test(
          r.message
        ),
        '`ls -l` prints the real column layout (mode, links, owner, group, size, time)',
        r.message
      );
      r = sh('mkdir qa4l/a/b');
      lock(
        r.code === 1 &&
          /cannot create directory ‘qa4l\/a\/b’: No such file or directory/.test(r.message),
        '`mkdir` without -p reports the missing parent',
        r.message
      );
      lock(
        !sh('mkdir -p qa4l/a/b').error && host.fileInfo('~/qa4l/a/b').type === 'dir',
        '`mkdir -p` creates empty directories (kept by the host overlay)',
        ''
      );
      r = sh('rm qa4l');
      lock(
        r.code === 1 && r.message === "rm: cannot remove 'qa4l': Is a directory",
        '`rm DIR` refuses a directory',
        r.message
      );
      r = sh('./qa4l-missing.sh');
      lock(
        r.code === 127 && r.message === 'bash: ./qa4l-missing.sh: No such file or directory',
        'running a missing script path exits 127 like bash',
        JSON.stringify(r)
      );

      // ── systemd failure → journal → fix ──────────────────────────────────
      freshHost({
        packages: { install: ['httpd'] },
        files: [
          {
            path: '/etc/httpd/conf.d/qa.conf',
            content: '<Directory "/srv">\n    Requre all granted\n</Directory>\n',
          },
        ],
        services: [{ name: 'httpd', failing: true, enabled: false }],
      });
      r = sh('systemctl is-active httpd');
      lock(
        r.message === 'failed' && r.code === 3,
        'a seeded failing unit reports `failed` (exit 3)',
        JSON.stringify(r)
      );
      r = sh('systemctl start httpd');
      lock(
        r.code === 1 &&
          /^Failed to start httpd\.service: Interactive authentication required\./.test(r.message),
        'systemctl start as student is refused by polkit',
        r.message
      );
      r = sh('sudo systemctl restart httpd');
      lock(
        r.code === 1 &&
          /^Job for httpd\.service failed because the control process exited with error code\./.test(
            r.message
          ),
        'starting a broken httpd fails like systemd',
        r.message
      );
      r = sh('journalctl -u httpd -n 20');
      lock(
        /AH00526: Syntax error on line 2 of \/etc\/httpd\/conf\.d\/qa\.conf:/.test(r.message) &&
          /Invalid command 'Requre'/.test(r.message),
        'the journal names the httpd syntax error (AH00526, file and line)',
        r.message.slice(-400)
      );
      r = sh('apachectl configtest');
      lock(
        r.code === 1 && /AH00526/.test(r.message),
        '`apachectl configtest` agrees with the unit failure',
        r.message
      );
      sh("sudo sed -i 's/Requre/Require/' /etc/httpd/conf.d/qa.conf");
      r = sh('sudo systemctl enable --now httpd');
      lock(
        r.code === 0 &&
          /Created symlink \/etc\/systemd\/system\/multi-user\.target\.wants\/httpd\.service → \/usr\/lib\/systemd\/system\/httpd\.service\./.test(
            r.message
          ),
        '`enable --now` starts the fixed unit and prints the symlink',
        r.message
      );
      lock(
        grade({ type: 'service', name: 'httpd', active: true, enabled: true }),
        'the `service` objective follows unit state (active + enabled)',
        JSON.stringify(host.serviceState('httpd'))
      );
      r = sh('systemctl status httpd');
      lock(
        r.code === 0 &&
          /● httpd\.service - The Apache HTTP Server/.test(r.message) &&
          /Active: active \(running\)/.test(r.message),
        '`systemctl status` renders the running unit',
        r.message.slice(0, 300)
      );
      r = sh('curl -s http://localhost');
      lock(
        /Test Page/.test(r.message),
        'curl to localhost reaches the running httpd (RHEL test page)',
        r.message.slice(0, 120)
      );

      // ── processes ────────────────────────────────────────────────────────
      freshHost({
        processes: [
          {
            name: 'dd',
            command: 'dd if=/dev/zero of=/dev/null',
            user: 'student',
            pid: 4242,
            cpu: 99.5,
          },
        ],
      });
      r = sh('ps aux --sort=-%cpu | head -n 2');
      lock(
        /^student +4242 +\d+\.\d +\d+\.\d .* dd if=\/dev\/zero of=\/dev\/null$/m.test(r.message),
        '`ps aux --sort=-%cpu` puts the runaway process first',
        r.message
      );
      lock(
        !grade({ type: 'process', name: 'dd', running: false }),
        'a `process` running:false objective is not done while it runs',
        ''
      );
      r = sh('kill 4242');
      lock(
        r.code === 0 && grade({ type: 'process', name: 'dd', running: false }),
        '`kill PID` (SIGTERM) ends it and the objective ticks',
        JSON.stringify(r)
      );
      r = sh('kill 4242');
      lock(
        r.code === 1 && r.message === 'bash: kill: (4242) - No such process',
        'killing a missing PID fails like bash',
        r.message
      );

      // ── packages ─────────────────────────────────────────────────────────
      r = sh('dnf install -y tree');
      lock(
        r.code === 1 &&
          r.message ===
            'Error: This command has to be run with superuser privileges (under the root user on most systems).',
        'dnf install as student is refused',
        r.message
      );
      lock(
        !grade({ type: 'package', name: 'tree', installed: true }),
        'package objective is not done before the install',
        ''
      );
      r = sh('sudo dnf install -y tree');
      lock(
        r.code === 0 &&
          /Complete!$/.test(r.message) &&
          sh('rpm -q tree').message === 'tree-1.8.0-10.el9.x86_64',
        'sudo dnf install -y installs (rpm -q agrees)',
        r.message.slice(-200)
      );
      lock(
        grade({ type: 'package', name: 'tree', installed: true }),
        'the `package` objective follows the RPM database',
        ''
      );
      freshHost({ packages: { remove: ['bind-utils'] } });
      r = sh('dig +short api.cluster.example.com');
      lock(
        r.code === 127 && r.message === 'bash: dig: command not found',
        'a removed package removes its commands (exit 127)',
        JSON.stringify(r)
      );

      // ── firewalld runtime vs permanent ───────────────────────────────────
      freshHost();
      r = sh('firewall-cmd --add-service=http');
      lock(
        r.code === 253 && /^Authorization failed\./.test(r.message),
        'firewall-cmd changes need root',
        r.message
      );
      sh('sudo firewall-cmd --add-service=http');
      lock(
        grade({ type: 'firewall', service: 'http', runtime: true }) &&
          !grade({ type: 'firewall', service: 'http', permanent: true }),
        'a runtime-only rule is not permanent',
        ''
      );
      sh('sudo firewall-cmd --permanent --add-service=http');
      sh('sudo firewall-cmd --reload');
      lock(
        grade({ type: 'firewall', service: 'http', runtime: true, permanent: true }),
        'runtime + permanent after --permanent + --reload',
        ''
      );

      // ── rootless podman + skopeo ─────────────────────────────────────────
      r = sh('podman run -d --name web -p 8080:8080 registry.access.redhat.com/ubi9/httpd-24');
      lock(
        r.code === 0 && /^[0-9a-f]{64}$/m.test(r.message),
        '`podman run -d` pulls the image and prints the container id',
        r.message.slice(-120)
      );
      lock(
        grade({
          type: 'container',
          name: 'web',
          running: true,
          image: 'ubi9/httpd-24',
          publish: '8080:8080',
        }),
        'the `container` objective reads podman state (running, image, published port)',
        ''
      );
      r = sh(
        "skopeo inspect --format '{{.Digest}}' docker://registry.access.redhat.com/ubi9/httpd-24:latest"
      );
      lock(
        r.message.trim() ===
          linuxHostMod.imageDigest('registry.access.redhat.com/ubi9/httpd-24:latest'),
        'skopeo prints the same digest podman pulled (imageDigest)',
        r.message
      );
      r = sh('podman run -d --name low -p 80:8080 registry.access.redhat.com/ubi9/httpd-24');
      lock(
        r.code === 126 && /Failed to bind port 80 \(Permission denied\)/.test(r.message),
        'rootless podman cannot publish ports < 1024',
        r.message
      );

      // ── objectives graded from state, history recorded as typed ──────────
      freshHost();
      lock(
        !grade({ type: 'ran', command: 'ls', flags: 'l', path: '/home/student/manifests' }),
        '`ran` is not done before the command',
        ''
      );
      sh('cd manifests');
      sh('ls -la');
      lock(
        grade({ type: 'ran', command: 'ls', flags: 'l', path: '/home/student/manifests' }),
        '`ran` matches `ls -la` run inside the directory (cwd-aware)',
        JSON.stringify(host.execLog.slice(-1))
      );
      sh('KUBE_EDITOR=vim');
      lock(
        !grade({ type: 'env', name: 'KUBE_EDITOR', value: 'vim', exported: true }),
        'an unexported variable does not satisfy `env exported:true`',
        ''
      );
      sh('export KUBE_EDITOR');
      lock(
        grade({ type: 'env', name: 'KUBE_EDITOR', value: 'vim', exported: true }),
        '`export NAME` exports the current value',
        JSON.stringify(host.envVar('KUBE_EDITOR'))
      );
      sh("printf 'apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: cm\\n' > ~/cm.yaml");
      lock(
        grade({
          type: 'file',
          path: '~/cm.yaml',
          yaml: { kind: 'ConfigMap', 'metadata.name': 'cm' },
          owner: 'student',
          mode: '0644',
        }),
        '`file` objective: printf > file, YAML fields, owner and umask mode',
        host.fileInfo('~/cm.yaml').content
      );
      const history = engine.getCommandHistory().map((entry) => entry.raw);
      lock(
        history.includes('ls -la') &&
          history.includes('cd manifests') &&
          history.includes('whoami') &&
          !history.some((raw) => /^oc (ls|cd|cp|printf)\b/.test(raw)),
        'shell lines are recorded as typed (never `oc …`)',
        JSON.stringify(history.slice(-6))
      );
      host.reset(null);
      lock(
        host.session.cwd === '/home/student' &&
          !host.isInstalled('tree') &&
          host.listContainers({ all: true }).length === 0,
        'reset(null) restores the default workstation',
        ''
      );
    } catch (err) {
      fail('linux', `1.16.0 workstation locks crashed: ${err?.stack || err}`);
    } finally {
      delete globalThis.window;
    }
  }
}

// ── 4m. Grading fixes (1.16.0) ─────────────────────────────────────────────
// The browser section `qa-grading-1160` replays every "Open — grading" finding
// of docs/guidance-qa-findings.md through the real UI. These headless locks keep
// the evaluator contracts and the level data that carry the fixes from silently
// regressing: Builds graded on phase Complete, reads that must show something in
// the lab project, subject/role-aware RoleBindings, TLS Secret types, Route
// target ports, first-login Users, Subscription+CSV uninstalls, exclusive SCC
// grants, the project-config state, the capstone gates and ONE investigation
// matcher shared by IncidentEngine and the Incidents panel.
{
  const gradingEvaluator = await tryImport('js/engine/ObjectiveEvaluator.js');
  const gradingLevels = await tryImport('js/data/CampaignLevels.js');
  const gradingChallenges = await tryImport('js/modes/ChallengeMode.js');
  const lock = (ok, message, detail) => {
    if (ok) passed();
    else fail('grading', `1.16.0: ${message}`, detail);
  };
  if (
    !gradingEvaluator?.evaluateObjective ||
    !gradingEvaluator?.canonicalCommandText ||
    !gradingEvaluator?.outputShowsSomething ||
    !gradingLevels?.CAMPAIGN_LEVELS ||
    !gradingChallenges?.CHALLENGES
  ) {
    fail(
      'grading',
      '1.16.0: ObjectiveEvaluator (evaluateObjective/canonicalCommandText/outputShowsSomething), CampaignLevels and ChallengeMode must be importable for the grading locks'
    );
  } else {
    const { evaluateObjective, canonicalCommandText, outputShowsSomething } = gradingEvaluator;
    const level = (id) => gradingLevels.CAMPAIGN_LEVELS.find((entry) => entry.id === id) || null;
    const lab = (id) => gradingChallenges.CHALLENGES.find((entry) => entry.id === id) || null;
    const objectiveOf = (owner, test) => (owner?.objectives || []).find(test) || null;
    const byLabel = (owner, pattern) =>
      objectiveOf(owner, (objective) => pattern.test(objective.label || ''));
    /** Minimal ClusterState stand-in (the evaluator feature-detects its readers). */
    const fakeCluster = (resources, extra = {}) => ({
      getResourcesByKind: (kind) => resources.filter((resource) => resource.kind === kind),
      getAllResources: () => resources,
      ...extra,
    });
    const res = (kind, name, namespace, body = {}) => ({
      kind,
      metadata: { name, namespace, labels: {}, annotations: {}, ...(body.metadata || {}) },
      spec: body.spec || {},
      status: body.status || {},
      ...(body.top || {}),
    });
    const levelDefFor = (project) => ({
      objectives: [],
      startingResources: project ? [{ kind: 'Project', name: project }] : [],
    });
    const run = (objective, ctx) => evaluateObjective({ ...objective }, ctx).completed;

    // Builds: phase Complete only — no BuildConfig.status.lastVersion shortcut (L9/L20).
    const buildConfig = res('BuildConfig', 'webapp', 'build-lab', { status: { lastVersion: 1 } });
    const build = (phase) =>
      res('Build', 'webapp-1', 'build-lab', {
        metadata: { labels: { buildconfig: 'webapp' } },
        status: { phase },
      });
    const buildObjective = { type: 'build', name: 'webapp', namespace: 'build-lab' };
    lock(
      run(buildObjective, { clusterState: fakeCluster([buildConfig, build('Running')]) }) ===
        false &&
        run(buildObjective, { clusterState: fakeCluster([buildConfig, build('Complete')]) }) ===
          true,
      'a `build` objective must wait for a Build in phase Complete (a created/running build with lastVersion 1 must not tick)'
    );

    // Reads: canonical form, output evidence, project scope (L3/L9).
    lock(
      canonicalCommandText('oc -n build-lab get is') === 'oc get is -n build-lab' &&
        canonicalCommandText('oc --namespace=x describe pod y') ===
          'oc describe pod y --namespace=x' &&
        canonicalCommandText('oc get pods') === 'oc get pods',
      'canonicalCommandText must move global flags typed before the verb behind it',
      JSON.stringify([
        canonicalCommandText('oc -n build-lab get is'),
        canonicalCommandText('oc --namespace=x describe pod y'),
      ])
    );
    const emptyYaml = 'apiVersion: v1\nkind: List\nmetadata:\n  resourceVersion: ""\nitems: []';
    const emptyJson = '{\n  "apiVersion": "v1",\n  "kind": "List",\n  "items": []\n}';
    lock(
      outputShowsSomething('No resources found in default namespace.') === false &&
        outputShowsSomething('') === false &&
        outputShowsSomething(emptyYaml) === false &&
        outputShowsSomething(emptyJson) === false &&
        outputShowsSomething(
          'Now using project "x" on server "https://api.cluster.example.com:6443".\nNo resources found in x namespace.'
        ) === false &&
        outputShowsSomething(
          'Warning: apps.openshift.io/v1 DeploymentConfig is deprecated in v4.14+, unavailable in v4.10000+\nNo resources found in x namespace.'
        ) === false &&
        outputShowsSomething('NAME   READY\nweb    1/1') === true &&
        outputShowsSomething(undefined) === true,
      'outputShowsSomething must treat empty output, "No resources found" and empty Lists as nothing shown'
    );
    const l9 = level(9);
    const examineIs = byLabel(l9, /Examine the ImageStream/);
    const isOutput =
      'NAME     IMAGE REPOSITORY                                                    TAGS     UPDATED\nwebapp   image-registry.openshift-image-registry.svc:5000/build-lab/webapp   latest   1s';
    const historyCtx = (entries) => ({
      clusterState: fakeCluster([]),
      gameEngine: { getCommandHistory: () => entries },
      levelDef: l9,
    });
    const entry = (raw, project, output) => ({ raw, success: true, project, output });
    lock(
      Boolean(examineIs) &&
        examineIs.inspect === true &&
        run(
          examineIs,
          historyCtx([
            entry('oc get is', 'build-lab', 'No resources found in build-lab namespace.'),
          ])
        ) === false &&
        run(examineIs, historyCtx([entry('oc get is', 'default', isOutput)])) === false &&
        run(examineIs, historyCtx([entry('oc -n build-lab get is', 'default', isOutput)])) ===
          true &&
        run(examineIs, historyCtx([entry('oc get all', 'build-lab', isOutput)])) === true,
      'L9 "Examine the ImageStream" must be an inspect read: "No resources found" and other projects do not count, `oc -n build-lab get is` and an `oc get all` that lists the stream do',
      JSON.stringify(examineIs)
    );
    const l3 = level(3);
    lock(
      byLabel(l3, /Inspect Pods/)?.inspect === true &&
        byLabel(l3, /container logs/)?.inspect === true,
      'L3 "Inspect Pods" / "Read container logs" must be inspect reads (a read in `default` that saw nothing must not tick)'
    );
    const l18 = level(18);
    lock(
      byLabel(l18, /Verify the Subscription/)?.inspect === true &&
        Boolean(byLabel(l18, /Verify the Subscription/)?.outputPattern),
      'L18 "Verify the Subscription / CSV / InstallPlan" must require the read to show the operator objects'
    );

    // RoleBindings: right subject AND role (L14/L16/lab 11).
    const binding = (name, roleName, subjects) =>
      res('RoleBinding', name, 'rbac-lab', {
        spec: { roleRef: { kind: 'ClusterRole', name: roleName }, subjects },
      });
    const l14Bind = byLabel(level(14), /Bind a role/);
    const l14Ctx = (bindings) => ({
      clusterState: fakeCluster(bindings),
      levelDef: levelDefFor('rbac-lab'),
    });
    lock(
      Boolean(l14Bind) &&
        run(
          l14Bind,
          l14Ctx([
            binding('view', 'view', [
              { kind: 'ServiceAccount', name: 'default', namespace: 'rbac-lab' },
            ]),
          ])
        ) === false &&
        run(l14Bind, l14Ctx([binding('edit', 'edit', [{ kind: 'Group', name: 'developers' }])])) ===
          true,
      'L14 "Bind a role to the developers group" must reject the ServiceAccount binding and accept edit/view → Group developers',
      JSON.stringify(l14Bind)
    );
    const l16Bind = byLabel(level(16), /Bind the view role/);
    lock(
      JSON.stringify(l16Bind?.subjects) === '["system:serviceaccount:sa-lab:api-reader"]' &&
        JSON.stringify(l16Bind?.roles) === '["view"]' &&
        Array.isArray(byLabel(lab(11), /Grant project access/)?.subjects),
      'L16 binding objective must require view → ServiceAccount api-reader; lab 11 must name the subject'
    );

    // Secret types (L11, lab 3) and Route target ports (L12 evaluator).
    const webTls = objectiveOf(level(11), (o) => o.type === 'deploy' && o.kind === 'Secret');
    const appTls = objectiveOf(lab(3), (o) => o.type === 'deploy' && o.kind === 'Secret');
    const secret = (type) => res('Secret', 'web-tls', 'route-lab', { top: { type } });
    lock(
      webTls?.secretType === 'kubernetes.io/tls' &&
        appTls?.secretType === 'kubernetes.io/tls' &&
        run(webTls, {
          clusterState: fakeCluster([secret('Opaque')]),
          levelDef: levelDefFor('route-lab'),
        }) === false &&
        run(webTls, {
          clusterState: fakeCluster([secret('kubernetes.io/tls')]),
          levelDef: levelDefFor('route-lab'),
        }) === true,
      'the L11/lab 3 TLS Secret objectives must require type kubernetes.io/tls'
    );
    const admitted = { ingress: [{ conditions: [{ type: 'Admitted', status: 'True' }] }] };
    const route = (name, port) =>
      res('Route', name, 'lb-lab', {
        spec: {
          to: { name: 'tls-app' },
          tls: { termination: 'passthrough' },
          ...(port ? { port: { targetPort: port } } : {}),
        },
        status: admitted,
      });
    const service = res('Service', 'tls-app', 'lb-lab', {
      spec: { ports: [{ name: 'https', port: 443, targetPort: 8443 }] },
    });
    const routeObjective = {
      type: 'route',
      name: 'tls-app',
      namespace: 'lb-lab',
      targetPort: 'https',
    };
    lock(
      run(routeObjective, { clusterState: fakeCluster([service, route('tls-app', '8443')]) }) ===
        false &&
        run(routeObjective, { clusterState: fakeCluster([service, route('tls-app', 'https')]) }) ===
          true &&
        run(routeObjective, { clusterState: fakeCluster([service, route('tls-app', null)]) }) ===
          true,
      'a route `targetPort` must reject --port=8443 and accept the named port (explicit or the Service default)'
    );

    // Users: a first login (Identity), not `oc create user` (L13, lab 11).
    const l13 = level(13);
    const firstLogin = byLabel(l13, /exists after first login/);
    const alice = res('User', 'alice', '', { top: { identities: [] } });
    const identity = res('Identity', 'htpasswd:alice', '', {
      spec: { user: { name: 'alice' }, providerUserName: 'alice' },
    });
    lock(
      firstLogin?.viaLogin === true &&
        byLabel(lab(11), /created on first login/)?.viaLogin === true &&
        run(firstLogin, { clusterState: fakeCluster([alice]) }) === false &&
        run(firstLogin, { clusterState: fakeCluster([alice, identity]) }) === true,
      '"User alice exists after first login" must need the Identity a login creates (L13, lab 11)'
    );
    // htpasswd: the tool adding alice, never the Secret command (L13, lab 11).
    const htpasswdPatterns = [
      new RegExp(byLabel(l13, /to the htpasswd file/)?.pattern || '^$', 'i'),
      new RegExp(byLabel(lab(11), /Create an htpasswd entry/)?.pattern || '^$', 'i'),
    ];
    lock(
      htpasswdPatterns.every(
        (pattern) =>
          pattern.test('htpasswd -c -B -b htpasswd alice redhat123') &&
          pattern.test('oc htpasswd -c -B -b htpasswd alice redhat123') &&
          pattern.test('htpasswd -bB /tmp/htpasswd alice newpass456') &&
          !pattern.test(
            'oc create secret generic htpass-secret --from-file=htpasswd -n openshift-config'
          ) &&
          !pattern.test(
            'oc create secret generic htpass-secret --from-file=htpasswd=htpasswd -n openshift-config'
          ) &&
          !pattern.test('htpasswd -D htpasswd alice')
      ),
      'the htpasswd command objectives must match the htpasswd tool only (not `oc create secret … --from-file=htpasswd`, not -D)',
      htpasswdPatterns.map(String).join(' | ')
    );

    // Uninstall = Subscription AND CSV (L18, lab 10).
    const uninstall = { type: 'operator', name: 'metallb-operator', installed: false };
    const sub = res('Subscription', 'metallb-operator', 'metallb-system', {
      spec: { name: 'metallb-operator' },
      status: { installedCSV: 'metallb-operator.v4.22.0-202610281200' },
    });
    const csv = res(
      'ClusterServiceVersion',
      'metallb-operator.v4.22.0-202610281200',
      'metallb-system',
      {
        status: { phase: 'Succeeded' },
      }
    );
    const uninstallCtx = (resources) => ({
      clusterState: fakeCluster(resources),
      levelDef: levelDefFor('operator-lab'),
    });
    const uninstallRun = { ...uninstall };
    const uninstallSteps = [
      evaluateObjective(uninstallRun, uninstallCtx([sub, csv])).completed,
      evaluateObjective(uninstallRun, uninstallCtx([csv])).completed,
      evaluateObjective(uninstallRun, uninstallCtx([])).completed,
    ];
    lock(
      JSON.stringify(uninstallSteps) === '[false,false,true]' &&
        /CSV/.test(byLabel(lab(10), /Uninstall the old AAP operator/)?.label || ''),
      'an operator uninstall must need the Subscription AND its CSV deleted',
      JSON.stringify(uninstallSteps)
    );

    // Exclusive SCC grants (L17, lab 8).
    const sccObjective = byLabel(level(17), /Grant the privileged SCC/);
    const scc = res('SecurityContextConstraints', 'privileged', '', {});
    const sccBinding = (subjects) =>
      res('RoleBinding', 'system:openshift:scc:privileged', 'privileged-lab', {
        spec: {
          roleRef: { kind: 'ClusterRole', name: 'system:openshift:scc:privileged' },
          subjects,
        },
      });
    const sa = (name) => ({ kind: 'ServiceAccount', name, namespace: 'privileged-lab' });
    const sccRun = { ...(sccObjective || {}) };
    const sccCtx = (resources) => ({
      clusterState: fakeCluster(resources),
      levelDef: levelDefFor('privileged-lab'),
    });
    const sccSteps = [
      evaluateObjective(sccRun, sccCtx([scc])).completed,
      evaluateObjective(sccRun, sccCtx([scc, sccBinding([sa('priv-sa'), sa('default')])]))
        .completed,
      evaluateObjective(sccRun, sccCtx([scc, sccBinding([sa('priv-sa')])])).completed,
    ];
    lock(
      sccObjective?.exclusive === true &&
        byLabel(lab(8), /Grant the privileged SCC/)?.exclusive === true &&
        JSON.stringify(sccSteps) === '[false,false,true]',
      'the dedicated-ServiceAccount SCC grant must reject a grant that also reaches `default` (L17, lab 8)',
      JSON.stringify(sccSteps)
    );

    // L15: project.config.openshift.io/cluster state, not `oc edit` typed.
    const l15 = level(15);
    const projectTemplate = objectiveOf(l15, (o) => o.type === 'projectRequestTemplate');
    const template = res('Template', 'project-request', 'openshift-config', {});
    const configCtx = (name, resources) => ({
      clusterState: fakeCluster(resources, {
        getProjectConfig: () => ({ spec: name ? { projectRequestTemplate: { name } } : {} }),
      }),
    });
    lock(
      Boolean(projectTemplate) &&
        !(l15?.objectives || []).some(
          (o) => o.type === 'command' && /project\\?\.config/.test(String(o.pattern || ''))
        ) &&
        run(projectTemplate, configCtx('', [template])) === false &&
        run(projectTemplate, configCtx('project-request', [])) === false &&
        run(projectTemplate, configCtx('project-request', [template])) === true,
      'L15 must grade spec.projectRequestTemplate.name (pointing at an existing openshift-config Template), not an `oc edit|patch project.config` regex'
    );

    // L10 rollouts from the Deployment's own ReplicaSet history (oldest first), on
    // the FIRST evaluation — no first-look baseline (the level intro pauses the mode,
    // so the first evaluation can come after the player's first command).
    const hashMod = await tryImport('js/engine/TemplateHash.js');
    if (hashMod?.templateHash) {
      const templateFor = (image) => ({
        metadata: { labels: { app: 'api-server' } },
        spec: { containers: [{ name: 'main', image }] },
      });
      const good = templateFor('quay.io/openshift/origin-hello-openshift:latest');
      const bad = templateFor('quay.io/openshift/origin-hello-openshift:does-not-exist');
      const rsFor = (template) =>
        res('ReplicaSet', `api-server-${hashMod.templateHash(template)}`, 'rollout-lab', {
          metadata: { labels: { 'pod-template-hash': hashMod.templateHash(template) } },
          spec: { template },
        });
      const rolloutCtx = (template, sets, rollbacks) => {
        const deploymentRes = res('Deployment', 'api-server', 'rollout-lab', {
          spec: { replicas: 3, template },
          top: { uid: 'deploy-api-server' },
        });
        return {
          clusterState: {
            ...fakeCluster([deploymentRes, ...sets]),
            getChildren: (uid) => (uid === 'deploy-api-server' ? sets : []),
            _rollbackCount: rollbacks,
          },
          levelDef: levelDefFor('rollout-lab'),
        };
      };
      const l10 = level(10);
      const update = objectiveOf(l10, (o) => o.type === 'update');
      const rollback = objectiveOf(l10, (o) => o.type === 'rollback');
      const states = [
        // one revision + a no-op undo: nothing
        [rolloutCtx(good, [rsFor(good)], 1), false, false],
        // updated to the bad image: update only
        [rolloutCtx(bad, [rsFor(good), rsFor(bad)], 0), true, false],
        // undone: the older ReplicaSet is active again
        [rolloutCtx(good, [rsFor(good), rsFor(bad)], 1), true, true],
        // undone twice: the bad (newest) template is back
        [rolloutCtx(bad, [rsFor(good), rsFor(bad)], 2), true, false],
      ].map(([ctx, wantUpdate, wantRollback]) => [
        run(update, ctx) === wantUpdate,
        run(rollback, ctx) === wantRollback,
      ]);
      lock(
        Boolean(update && rollback) && states.every((pair) => pair.every(Boolean)),
        'L10 update/rollback must follow the ReplicaSet history on the first evaluation (lone undo: nothing; update; undo re-activates the older set; second undo: no rollback)',
        JSON.stringify(states)
      );
    } else {
      fail('grading', '1.16.0: js/engine/TemplateHash.js must be importable for the rollout locks');
    }

    // L10 and L20 objective data.
    const l10Uptime = objectiveOf(level(10), (o) => o.type === 'uptime');
    const l20 = level(20);
    lock(
      l10Uptime?.name === 'api-server' &&
        objectiveOf(l20, (o) => o.type === 'architectureScore')?.namespace === 'prod-platform' &&
        objectiveOf(l20, (o) => o.type === 'examScore')?.namespace === 'prod-platform',
      'L10 availability must grade api-server; L20 Advisor/composite must rate prod-platform'
    );
    const composite = { type: 'examScore', minScore: 75 };
    const compositeCtx = (done) => ({
      clusterState: fakeCluster([]),
      objectiveProgress: [
        ...Array.from({ length: 18 }, (_, index) => ({ type: 'deploy', completed: index < done })),
        composite,
      ],
    });
    lock(
      evaluateObjective({ ...composite }, compositeCtx(17)).completed === false &&
        evaluateObjective({ ...composite }, compositeCtx(18)).completed === true,
      'the composite drill score must only complete once every other objective is done'
    );

    // One investigation matcher; output travels with the recorded command.
    const panelSource = read('js/ui/IncidentPanel.js');
    const incidentSource = read('js/engine/IncidentEngine.js');
    const tickSource = read('js/engine/SimulationTick.js');
    lock(
      !/['"]command:(raw|executed)['"]/.test(panelSource) &&
        !/\.completeStep\?*\.?\(/.test(panelSource) &&
        /['"]incident:step-completed['"]/.test(panelSource),
      'the Incidents panel must mirror IncidentEngine steps (incident:step-completed), never run its own command matcher'
    );
    lock(
      /import \{ outputShowsSomething \} from '\.\/ObjectiveEvaluator\.js'/.test(incidentSource) &&
        /_stepIsClusterScoped\(expectedWords\)/.test(incidentSource),
      'IncidentEngine investigation must require output and the incident project for namespaced steps'
    );
    lock(
      (tickSource.match(/_installPlanOwnedBy\(/g) || []).length >= 3 &&
        (tickSource.match(/this\._adoptInstallPlan\(subscription, plan\)/g) || []).length >= 2,
      'OLM InstallPlans must be owned by (and only adopted for) their own Subscription'
    );
    lock(
      /this\._recordCommand\(raw, baseCommand, success, message\)/.test(
        read('js/ui/CommandBar.js')
      ) &&
        /entry\.output = details\.output/.test(read('js/engine/GameEngine.js')) &&
        /project: this\.currentProject/.test(read('js/engine/GameEngine.js')),
      'command history entries must carry the output and the project they ran in'
    );
  }
}

// ── 4n. Simulator fixes (1.16.0) ───────────────────────────────────────────
// Headless locks for the 1.16.0 simulator-fidelity pass (browser section
// `qa-sim-1160` proves the same end-to-end): the 2026-11-07 NO-GO root causes
// (alert flicker, incident fire-moment Pod state, GitHub API calls off the
// production host) and the "Open — simulator fidelity" list of
// docs/guidance-qa-findings.md. One in-process sandbox fixture, no browser.
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const manifestMod = await tryImport('js/engine/ManifestEngine.js');
  const incidentMod = await tryImport('js/engine/IncidentEngine.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !manifestMod?.ManifestEngine ||
    !incidentMod?.IncidentEngine
  ) {
    fail('sim-1160', '4n: engine/CommandBar modules are not importable for the 1.16.0 locks');
  } else {
    const engine = new engineMod.GameEngine({ mode: 'sandbox' });
    new sandboxMod.SandboxMode(engine, null).setupCluster(3);
    const cluster = engine.cluster;
    const simulation = engine.simulation;
    simulation.randomFailureRate = 0;
    const manifestEngine = new manifestMod.ManifestEngine({ cluster, gameEngine: engine });
    globalThis.window = {
      game: {
        cluster,
        gameEngine: engine,
        engine: { emit() {}, on() {}, off() {} },
        manifestEngine,
      },
    };
    manifestEngine.game = globalThis.window.game;
    const commandBar = new commandBarMod.CommandBar();
    const cli = (raw) => {
      try {
        const out = commandBar.executeCommand(raw);
        return { error: Boolean(out?.error), message: String(out?.message ?? '') };
      } catch (err) {
        return { error: true, message: `THROW ${err?.message || err}` };
      }
    };
    const tick = (seconds, incidentEngine = null) => {
      const steps = Math.ceil(seconds / 0.05);
      for (let step = 0; step < steps; step += 1) {
        simulation.tick(0.05);
        if (incidentEngine) incidentEngine.tick(0.05);
      }
    };
    /** Record one lock: pass when `ok`, otherwise fail with the detail. */
    const lock = (ok, message, detail) => {
      if (ok) passed();
      else fail('sim-1160', message, detail === undefined ? undefined : JSON.stringify(detail));
    };
    try {
      // ── NO-GO 1: KubePodCrashLooping holds through the kubelet restart ─────
      try {
        cli('oc new-project qa4n-alerts');
        cli('oc create deployment qa4n-crash --image=nginx:latest -n qa4n-alerts');
        const alertmanager = cluster.getByName('Alertmanager', 'main', 'openshift-monitoring');
        const crashAlerts = () =>
          (alertmanager?.getFiringAlerts?.() || []).filter(
            (alert) =>
              alert.name === 'KubePodCrashLooping' && /qa4n-crash-/.test(alert.target || '')
          ).length;
        tick(1);
        const gaps = [];
        for (let step = 0; step < 20 * 45; step += 1) {
          simulation.tick(0.05);
          if (crashAlerts() === 0) gaps.push(Number((1.05 + step * 0.05).toFixed(2)));
        }
        lock(
          alertmanager && gaps.length === 0,
          '4n: KubePodCrashLooping must stay firing while the kubelet restarts a crash-looping container (max_over_time[5m] window), never blink off for one tick',
          { gaps: gaps.slice(0, 8) }
        );
        cli(
          'oc create deployment qa4n-pull --image=quay.io/qa4n/app:does-not-exist -n qa4n-alerts'
        );
        tick(5);
        lock(
          (alertmanager?.getFiringAlerts?.() || []).some(
            (alert) => alert.name === 'KubePodNotReady' && /qa4n-pull-/.test(alert.target || '')
          ),
          '4n: an ImagePullBackOff Pod fires KubePodNotReady with its own pod target'
        );
      } catch (err) {
        fail('sim-1160', `4n: alert lock could not run: ${err.message}`);
      }

      // ── NO-GO 2: seeded CrashLoopBackOff incident, fire-moment Pod state ───
      try {
        const incidentEngine = new incidentMod.IncidentEngine(engine);
        incidentEngine.start('sandbox');
        cli('oc new-project qa4n-crash');
        cli(
          'oc create deployment webapp --replicas=2 --image=quay.io/openshift/origin-hello-openshift:latest -n qa4n-crash'
        );
        tick(10, incidentEngine);
        const crashDef = [...incidentEngine._defsById.values()].find(
          (def) => def.name === 'CrashLoopBackOff'
        );
        incidentEngine.spawnIncident(crashDef, 'webapp', 2, {
          exactTarget: true,
          namespace: 'qa4n-crash',
          seed: { env: { name: 'APP_MODE', value: 'debug-invalid' } },
          fix: { env: { name: 'APP_MODE', allowed: ['production'] } },
        });
        const podStates = () =>
          cluster.getByKindAndNamespace('Pod', 'qa4n-crash').map((pod) => ({
            bad: (pod.spec?.containers?.[0]?.env || []).some(
              (entry) => entry.name === 'APP_MODE' && entry.value === 'debug-invalid'
            ),
            phase: pod.status?.phase || '',
            node: pod.spec?.nodeName || '',
            waiting: (pod.status?.containerStatuses || []).map(
              (status) => status.state?.waiting?.reason || 'running'
            ),
          }));
        const atFire = podStates();
        const atFireBad = atFire.filter((pod) => pod.bad);
        lock(
          atFireBad.length === 1 &&
            atFireBad[0].phase === 'Pending' &&
            !atFireBad[0].node &&
            atFireBad[0].waiting.length === 0,
          '4n: when the seeded incident fires, the new revision Pod exists but is still unscheduled (Pending, no container status) — the browser check must give the kubelet a tick',
          atFire
        );
        tick(0.05, incidentEngine);
        const oneTickLater = podStates();
        lock(
          oneTickLater
            .filter((pod) => pod.bad)
            .every((pod) => pod.waiting[0] === 'CrashLoopBackOff') &&
            oneTickLater.filter((pod) => !pod.bad && pod.phase === 'Running').length === 2,
          '4n: one kubelet tick later the new revision crash-loops while the 2 old Pods keep running',
          oneTickLater
        );
      } catch (err) {
        fail('sim-1160', `4n: incident fire-moment lock could not run: ${err.message}`);
      }

      // ── NO-GO 4: GitHub stars API only on the production host ─────────────
      {
        const indexSource = read('index.html');
        const fetchAt = indexSource.indexOf('fetch(GITHUB_API');
        const guardAt = indexSource.search(
          /if \(\/\(\^\|\\\.\)shifting\\\.pro\$\/\.test\(window\.location\.hostname\)\) \{/
        );
        lock(
          fetchAt > 0 && guardAt > 0 && guardAt < fetchAt && fetchAt - guardAt < 200,
          '4n: index.html may only call api.github.com on the production host (local/test boots hit its rate limit and log a CORS console error)',
          { fetchAt, guardAt }
        );
      }

      // ── Open — simulator fidelity (docs/guidance-qa-findings.md) ──────────
      /** `cli()` + the shell exit status `$?` the line left behind. */
      const status = () => commandBar.shellTools?.lastExitCode;

      // Scope: describe never falls back to another project; -n never moves an
      // object that names its own namespace; new-app honours -n.
      try {
        cli('oc new-project qa4n-ops');
        cli(
          'oc create deployment web-app --image=quay.io/openshift/origin-hello-openshift:latest -n qa4n-ops'
        );
        cli('oc project default');
        const described = cli('oc describe deployment web-app');
        lock(
          described.error &&
            described.message.trim() ===
              'Error from server (NotFound): deployments.apps "web-app" not found',
          '4n: `oc describe deployment web-app` from default is NotFound like get/logs/set env (it used to print the qa4n-ops Deployment)',
          described.message.slice(0, 160)
        );
        const kustomizeMismatch = cli('oc apply -k kustomize/overlays/dev -n default');
        lock(
          kustomizeMismatch.error &&
            /^error: the namespace from the provided object "webapp-dev" does not match the namespace "default"\. You must pass '--namespace=webapp-dev' to perform this operation\.$/.test(
              kustomizeMismatch.message.trim()
            ) &&
            !cluster.getByName('Deployment', 'dev-webapp', 'default'),
          '4n: `oc apply -k <overlay> -n default` is kubectl’s namespace-mismatch error and creates nothing (it used to rewrite the overlay namespace)',
          kustomizeMismatch.message
        );
        const fileMismatch = cli('oc apply -f examples/subscription.yaml -n default');
        lock(
          fileMismatch.error && /does not match the namespace "default"/.test(fileMismatch.message),
          '4n: `oc apply -f <file naming openshift-operators> -n default` is the same mismatch error',
          fileMismatch.message
        );
        cli('oc new-project qa4n-other');
        cli('oc project qa4n-ops');
        const newAppFile = cli(
          'oc new-app -f templates/webapp-template.yaml -p APP_NAME=qa4n-file -n qa4n-other'
        );
        lock(
          !newAppFile.error &&
            cluster.getByName('Deployment', 'qa4n-file', 'qa4n-other') &&
            !cluster.getByName('Deployment', 'qa4n-file', 'qa4n-ops'),
          '4n: `oc new-app -f <template> -n other` creates the objects in `other`, not the current project',
          newAppFile.message.slice(0, 200)
        );
      } catch (err) {
        fail('sim-1160', `4n: scope locks could not run: ${err.message}`);
      }

      // Too lenient: new-app create-only semantics, builder argument, template record.
      try {
        cli('oc project qa4n-ops');
        const first = cli('oc new-app php:8.2-ubi9 https://github.com/sclorg/cakephp-ex');
        const buildConfig = cluster.getByName('BuildConfig', 'cakephp-ex', 'qa4n-ops');
        lock(
          !first.error &&
            buildConfig?.spec?.strategy?.sourceStrategy?.from?.name === 'php:8.2-ubi9' &&
            !cluster.getByName('Deployment', 'php', 'qa4n-ops'),
          '4n: `oc new-app <builder> <repo>` (space) builds the repo with that builder like `<builder>~<repo>` (it used to deploy the builder image and build nothing)',
          {
            message: first.message.slice(0, 200),
            from: buildConfig?.spec?.strategy?.sourceStrategy?.from,
          }
        );
        const buildsBefore = cluster.getByKindAndNamespace('Build', 'qa4n-ops').length;
        const rerun = cli('oc new-app php:8.2-ubi9 https://github.com/sclorg/cakephp-ex');
        const buildsAfter = cluster.getByKindAndNamespace('Build', 'qa4n-ops').length;
        lock(
          rerun.error &&
            status() === 1 &&
            /error: buildconfigs\.build\.openshift\.io "cakephp-ex" already exists/.test(
              rerun.message
            ) &&
            /--> Failed$/.test(rerun.message.trim()) &&
            !/created/.test(rerun.message) &&
            buildsAfter === buildsBefore,
          '4n: re-running `oc new-app` is AlreadyExists per object + `--> Failed` (exit 1) and starts no second build',
          { message: rerun.message, status: status(), buildsBefore, buildsAfter }
        );
        const fromTemplate = cli('oc new-app --template=webapp-template -p APP_NAME=qa4n-tpl');
        const record = (manifestEngine.templates || []).find(
          (entry) => entry.name === 'webapp-template' && entry.params?.APP_NAME === 'qa4n-tpl'
        );
        lock(
          !fromTemplate.error && record?.applied === true,
          '4n: `oc new-app --template=<name>` records the processed+applied template (L8 `template` objective)',
          { message: fromTemplate.message.slice(0, 160), record: Boolean(record) }
        );
      } catch (err) {
        fail('sim-1160', `4n: new-app locks could not run: ${err.message}`);
      }

      // Too lenient: required flags and subcommands that real oc does not have.
      try {
        const expectations = [
          ['oc create deployment qa4n-x', /^error: required flag\(s\) "image" not set$/],
          ['oc create job qa4n-j', /^error: either --image or --from must be specified$/],
          ['oc create cronjob qa4n-c', /^error: required flag\(s\) "image", "schedule" not set$/],
          [
            'oc create job qa4n-j --image=perl --active-deadline-seconds=600 -- perl -e 1',
            /^error: unknown flag: --active-deadline-seconds/,
          ],
          ['oc create service web', /^error: unknown command "web"/],
          ['oc create subscription x', /^error: Unexpected args: \[subscription x\]/],
          ['oc create networkpolicy x', /^error: Unexpected args: \[networkpolicy x\]/],
          ['oc create group devs', /^error: Unexpected args: \[group devs\]/],
          ['oc create secret mysecret --from-literal=a=b', /^error: unknown flag: --from-literal/],
          [
            'oc create secret generic qa4n-s --from-file=htpasswd=/tmp/qa4n-missing',
            /^error: error reading \/tmp\/qa4n-missing: no such file or directory$/,
          ],
          ['oc create', /^error: must specify one of -f and -k$/],
        ];
        for (const [raw, pattern] of expectations) {
          const out = cli(raw);
          lock(
            out.error && pattern.test(out.message.trim()),
            `4n: \`${raw}\` fails like real oc (${pattern})`,
            out.message.slice(0, 200)
          );
        }
        lock(
          !cluster.getByName('NetworkPolicy', 'x', 'qa4n-ops') &&
            !cluster.getByName('Subscription', 'x', 'qa4n-ops') &&
            !cluster.getByName('Deployment', 'qa4n-x', 'qa4n-ops'),
          '4n: the rejected create commands created nothing (the fake NetworkPolicy used to satisfy the capstone objective)'
        );
        const service = cli('oc create service clusterip qa4n-svc --tcp=443:8080');
        const created = cluster.getByName('Service', 'qa4n-svc', 'qa4n-ops');
        lock(
          !service.error &&
            created?.spec?.ports?.[0]?.name === '443-8080' &&
            created?.metadata?.labels?.app === 'qa4n-svc',
          '4n: `oc create service clusterip` names the port after the --tcp pair (443-8080) and labels app=<name>',
          created?.spec?.ports
        );
      } catch (err) {
        fail('sim-1160', `4n: create locks could not run: ${err.message}`);
      }

      // Too lenient: InstallPlan spec.approved is a boolean; CRDs refuse
      // strategic-merge patches.
      try {
        cli('oc apply -f examples/subscription-manual-pinned.yaml');
        tick(12);
        const plan = cluster.getByKindAndNamespace('InstallPlan', 'openshift-operators')[0];
        const planName = plan?.metadata?.name || 'missing';
        const stringPatch = cli(
          `oc patch installplan ${planName} -n openshift-operators --type=merge -p '{"spec":{"approved":"true"}}'`
        );
        lock(
          plan &&
            stringPatch.error &&
            stringPatch.message.trim() ===
              `The InstallPlan "${planName}" is invalid: spec.approved: Invalid value: "string": spec.approved in body must be of type boolean: "string"` &&
            plan.spec?.approved !== true,
          '4n: `{"spec":{"approved":"true"}}` (a string) is rejected by the InstallPlan schema instead of being accepted and ignored',
          stringPatch.message
        );
        const strategic = cli(`oc patch oauth cluster -p '{"spec":{}}'`);
        lock(
          strategic.error && /UnsupportedMediaType/.test(strategic.message),
          '4n: `oc patch oauth cluster` without --type=merge is the API server’s 415 (CRDs have no strategic merge patch)',
          strategic.message
        );
      } catch (err) {
        fail('sim-1160', `4n: patch locks could not run: ${err.message}`);
      }

      // Too strict / missing: glued shorthands, logs -l, helm upgrade --install,
      // JSONPath filters.
      try {
        cli('oc project qa4n-ops');
        cli(
          'oc create deployment qa4n-web --image=quay.io/openshift/origin-hello-openshift:latest --replicas=2'
        );
        tick(6);
        const wide = cli('oc get pods -owide');
        const yaml = cli('oc get deployment qa4n-web -oyaml');
        lock(
          !wide.error &&
            /NOMINATED NODE/.test(wide.message) &&
            !yaml.error &&
            /^apiVersion: apps\/v1/.test(yaml.message),
          '4n: glued shorthand values `-owide` / `-oyaml` parse like pflag (they used to be unknown shorthand flags)',
          { wide: wide.message.slice(0, 120), yaml: yaml.message.slice(0, 60) }
        );
        const selected = cli('oc logs -l app=qa4n-web --prefix --tail=1');
        const prefixed = selected.message
          .split('\n')
          .filter((line) => /^\[pod\/qa4n-web-[^/]+\/origin-hello-openshift\] /.test(line));
        lock(
          !selected.error && prefixed.length === 2,
          '4n: `oc logs -l <selector> --prefix --tail=1` prints one prefixed line per matching Pod',
          selected.message
        );
        const filter = cli(
          `oc get pods -l app=qa4n-web -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}'`
        );
        const nodeIp = cli(
          `oc get nodes -o jsonpath='{.items[?(@.metadata.name=="worker-0")].status.addresses[?(@.type=="InternalIP")].address}'`
        );
        lock(
          filter.message
            .trim()
            .split(/\s+/)
            .filter((name) => /^qa4n-web-/.test(name)).length === 2 &&
            /^\d+\.\d+\.\d+\.\d+$/.test(nodeIp.message.trim()),
          '4n: JSONPath filter expressions `[?(@.a=="b")]` select matching items (they used to print nothing)',
          { filter: filter.message, nodeIp: nodeIp.message }
        );
        const helmInstall = cli('helm upgrade --install qa4n-shop ./helm/webapp');
        const helmUpgrade = cli(
          'helm upgrade --install qa4n-shop ./helm/webapp --set replicaCount=2'
        );
        lock(
          !helmInstall.error &&
            /^Release "qa4n-shop" does not exist\. Installing it now\.\nNAME: qa4n-shop/.test(
              helmInstall.message
            ) &&
            /REVISION: 1/.test(helmInstall.message) &&
            !helmUpgrade.error &&
            /^Release "qa4n-shop" has been upgraded\. Happy Helming!/.test(helmUpgrade.message) &&
            /REVISION: 2/.test(helmUpgrade.message),
          '4n: `helm upgrade --install` installs a missing release, then upgrades it (it used to be an unknown flag)',
          {
            helmInstall: helmInstall.message.slice(0, 120),
            helmUpgrade: helmUpgrade.message.slice(0, 120),
          }
        );
      } catch (err) {
        fail('sim-1160', `4n: CLI parsing locks could not run: ${err.message}`);
      }

      // Cosmetic: describe oauth, debug-shell cue, oc edit pause cue, rollout
      // undo/history, `oc get all` warning.
      try {
        cli(
          `oc patch oauth cluster --type=merge -p '{"spec":{"identityProviders":[{"name":"htpasswd_provider","mappingMethod":"claim","type":"HTPasswd","htpasswd":{"fileData":{"name":"htpass-secret"}}}]}}'`
        );
        const oauth = cli('oc describe oauth cluster');
        lock(
          !/Mapping Method:claim/.test(oauth.message) &&
            /\n    Mapping Method:\s+claim\n/.test(oauth.message) &&
            /\n      File Data:\n        Name:\s+htpass-secret\n/.test(oauth.message),
          '4n: `oc describe oauth cluster` uses the generic CRD describer (`Mapping Method:  claim`, `File Data:` block), never `Mapping Method:claim`',
          oauth.message
        );
        const debug = cli('oc debug node/worker-0');
        const insideRaw = commandBar.executeCommand('oc get pods');
        const inside = {
          error: Boolean(insideRaw?.error),
          message: String(insideRaw?.message ?? ''),
        };
        const insideStatus = insideRaw?.exitCode;
        cli('exit');
        const back = cli('oc whoami');
        lock(
          /sh-5\.1#/.test(debug.message) &&
            inside.error &&
            /^sh: oc: command not found\n\nSimulator hint: this terminal is inside the debug shell of node\/worker-0 \(sh-5\.1#\)/.test(
              inside.message
            ) &&
            insideStatus === 127 &&
            !back.error,
          '4n: `oc` inside `oc debug node/…` is `sh: oc: command not found` (exit 127) with a cue to `exit`, and `exit` returns to the workstation',
          { inside: inside.message, insideStatus, back: back.message }
        );
        globalThis.window.game.manifestPanel = { show() {} };
        const edit = cli('oc edit deployment/qa4n-web');
        delete globalThis.window.game.manifestPanel;
        lock(
          !edit.error && /the cluster is paused while the Files panel is open/.test(edit.message),
          '4n: `oc edit` that opens the Files panel says the simulation is paused while it is open',
          edit.message
        );
        cli(
          'oc create deployment qa4n-one --image=quay.io/openshift/origin-hello-openshift:latest'
        );
        tick(3);
        const undo = cli('oc rollout undo deployment/qa4n-one');
        const generation = cluster.getByName('Deployment', 'qa4n-one', 'qa4n-ops')?.metadata
          ?.generation;
        const missing = cli('oc rollout undo deployment/qa4n-one --to-revision=7');
        lock(
          undo.error &&
            undo.message.trim() === 'error: no rollout history found for deployment "qa4n-one"' &&
            Number(generation) === 1 &&
            missing.message.trim() === 'error: unable to find specified revision 7 in history',
          '4n: `oc rollout undo` without a previous revision is an error, not a no-op success that bumps the generation',
          { undo: undo.message, generation, missing: missing.message }
        );
        const all = cli('oc get all');
        lock(
          /^Warning: apps\.openshift\.io\/v1 DeploymentConfig is deprecated in v4\.14\+, unavailable in v4\.10000\+\n/.test(
            all.message
          ),
          '4n: `oc get all` prints the 4.14+ DeploymentConfig deprecation warning first',
          all.message.slice(0, 160)
        );
      } catch (err) {
        fail('sim-1160', `4n: cosmetic locks could not run: ${err.message}`);
      }

      // Nodes: cordon = taint (no label), drain filters, top -A; exec curl status.
      try {
        tick(2);
        const cordon = cli('oc adm cordon worker-1');
        const worker1 = cluster.getByName('Node', 'worker-1', '');
        lock(
          cordon.message.trim() === 'node/worker-1 cordoned' &&
            (worker1?.spec?.taints || []).some(
              (taint) =>
                taint.key === 'node.kubernetes.io/unschedulable' && taint.effect === 'NoSchedule'
            ) &&
            !Object.prototype.hasOwnProperty.call(
              worker1?.metadata?.labels || {},
              'node.kubernetes.io/unschedulable'
            ),
          '4n: cordon adds the node.kubernetes.io/unschedulable:NoSchedule TAINT, never a label',
          { taints: worker1?.spec?.taints, labels: worker1?.metadata?.labels }
        );
        cli('oc adm uncordon worker-1');
        cli('oc run qa4n-bare --image=quay.io/openshift/origin-hello-openshift:latest -n qa4n-ops');
        tick(3);
        const bareNode =
          cluster.getByName('Pod', 'qa4n-bare', 'qa4n-ops')?.spec?.nodeName || 'worker-0';
        const podsBefore = cluster
          .getByKind('Pod')
          .filter((pod) => pod.spec?.nodeName === bareNode).length;
        const plain = cli(`oc adm drain ${bareNode}`);
        const plainStatus = status();
        const podsAfterPlain = cluster
          .getByKind('Pod')
          .filter((pod) => pod.spec?.nodeName === bareNode).length;
        lock(
          plain.error &&
            plainStatus === 1 &&
            new RegExp(
              `^node/${bareNode} cordoned\\nerror: unable to drain node "${bareNode}" due to error: `
            ).test(plain.message) &&
            /cannot delete DaemonSet-managed Pods \(use --ignore-daemonsets to ignore\): openshift-dns\//.test(
              plain.message
            ) &&
            /There are pending nodes to be drained:/.test(plain.message) &&
            podsAfterPlain === podsBefore &&
            cluster.getByName('Node', bareNode, '')?.spec?.unschedulable === true,
          '4n: `oc adm drain` without --ignore-daemonsets cordons, evicts NOTHING and fails with the real DaemonSet error (exit 1)',
          { message: plain.message, plainStatus, podsBefore, podsAfterPlain }
        );
        const noForce = cli(`oc adm drain ${bareNode} --ignore-daemonsets --delete-emptydir-data`);
        lock(
          noForce.error &&
            /cannot delete cannot delete Pods that declare no controller \(use --force to override\): qa4n-ops\/qa4n-bare/.test(
              noForce.message
            ),
          '4n: a bare Pod needs --force (`cannot delete Pods that declare no controller`)',
          noForce.message
        );
        const drained = cli(
          `oc adm drain ${bareNode} --ignore-daemonsets --delete-emptydir-data --force`
        );
        lock(
          !drained.error &&
            /^Warning: .*ignoring DaemonSet-managed Pods: openshift-dns\//m.test(drained.message) &&
            /^evicting pod qa4n-ops\/qa4n-bare$/m.test(drained.message) &&
            /^pod\/qa4n-bare evicted$/m.test(drained.message) &&
            new RegExp(`node/${bareNode} drained$`).test(drained.message.trim()) &&
            !cluster.getByName('Pod', 'qa4n-bare', 'qa4n-ops'),
          '4n: drain with --ignore-daemonsets --delete-emptydir-data --force warns, evicts and ends `node/<n> drained`',
          drained.message
        );
        cli(`oc adm uncordon ${bareNode}`);
        const top = cli('oc adm top pods -A');
        lock(
          /^NAMESPACE\s+NAME\s+CPU\(cores\)\s+MEMORY\(bytes\)/.test(top.message) &&
            /\nopenshift-dns\s+/.test(top.message),
          '4n: `oc adm top pods -A` lists every project with a NAMESPACE column',
          top.message.slice(0, 160)
        );
        cli(
          'oc create deployment qa4n-front --image=quay.io/openshift/origin-hello-openshift:latest'
        );
        cli(
          'oc create deployment qa4n-back --image=quay.io/openshift/origin-hello-openshift:latest'
        );
        cli('oc expose deployment qa4n-back --port=8080');
        tick(6);
        manifestEngine.writeFile(
          'qa4n/deny-ingress.yaml',
          'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: qa4n-deny\nspec:\n  podSelector: {}\n  policyTypes:\n    - Ingress\n'
        );
        cli('oc apply -f qa4n/deny-ingress.yaml');
        tick(1);
        const curl = cli(
          'oc exec deploy/qa4n-front -- curl -s http://qa4n-back:8080 && echo reached'
        );
        lock(
          curl.error &&
            /command terminated with exit code 28/.test(curl.message) &&
            !/reached/.test(curl.message) &&
            status() === 28,
          '4n: a NetworkPolicy-blocked `oc exec … curl -s` exits 28 (`command terminated with exit code 28`) so `&&` stops',
          { message: curl.message, status: status() }
        );
      } catch (err) {
        fail('sim-1160', `4n: node/exec locks could not run: ${err.message}`);
      }

      // Controller children are created WITH their ownerReferences (the
      // "YOU CREATED Pod …" toast claimed incident-made Pods as the player's).
      try {
        const ownerless = [];
        const onAdded = (payload) => {
          const resource = payload?.resource || payload;
          if (!['ReplicaSet', 'Pod'].includes(resource?.kind)) return;
          if (resource?.metadata?.namespace !== 'qa4n-ops') return;
          if (!(resource?.metadata?.ownerReferences || []).length)
            ownerless.push(resource.metadata.name);
        };
        engine.eventBus.on('cluster:added', onAdded);
        cli(
          'oc create deployment qa4n-owned --image=quay.io/openshift/origin-hello-openshift:latest'
        );
        tick(3);
        engine.eventBus.off?.('cluster:added', onAdded);
        lock(
          ownerless.length === 0 &&
            cluster
              .getByKindAndNamespace('Pod', 'qa4n-ops')
              .some((pod) => /^qa4n-owned-/.test(pod.metadata.name)),
          '4n: Deployment ReplicaSets and their Pods carry the controller ownerReference in their first `cluster:added` event',
          ownerless
        );
      } catch (err) {
        fail('sim-1160', `4n: ownerReference lock could not run: ${err.message}`);
      }

      // describe networkpolicy = kubectl 1.35 describeNetworkPolicy; a seeded
      // Subscription's package is its spec.name (no invented spec.packageName).
      try {
        cli('oc new-project qa4n-np');
        cli('oc apply -f examples/allow-from-router.yaml -n qa4n-np');
        const policy = cli('oc describe networkpolicy allow-from-router -n qa4n-np');
        lock(
          /^Name:         allow-from-router\nNamespace:    qa4n-np\nCreated on:   \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000 UTC\nLabels:       <none>\nAnnotations:  <none>\nSpec:\n  PodSelector:     <none> \(Allowing the specific traffic to all pods in this namespace\)\n  Allowing ingress traffic:\n    To Port: <any> \(traffic allowed to all ports\)\n    From:\n      NamespaceSelector: policy-group\.network\.openshift\.io\/ingress=\n  Not affecting egress traffic\n  Policy Types: Ingress$/.test(
            policy.message
          ),
          '4n: `oc describe networkpolicy` prints the kubectl 1.35 layout (no `<all pods>`, no `Affected Pods`, no Events)',
          policy.message
        );
        const seeded = cluster.addResource({
          kind: 'Subscription',
          metadata: { name: 'qa4n-metallb', namespace: 'openshift-operators' },
          spec: {
            name: 'metallb-operator',
            channel: 'stable',
            source: 'redhat-operators',
            sourceNamespace: 'openshift-marketplace',
          },
        });
        const subscriptions = cli('oc get subscription qa4n-metallb -n openshift-operators');
        lock(
          seeded &&
            !Object.prototype.hasOwnProperty.call(seeded.spec || {}, 'packageName') &&
            /qa4n-metallb\s+metallb-operator\s+redhat-operators\s+stable/.test(
              subscriptions.message
            ) &&
            simulation._packageNameForSubscription(seeded) === 'metallb-operator',
          '4n: a Subscription seeded with spec.name resolves THAT package (no default spec.packageName next to it)',
          { spec: seeded?.spec, table: subscriptions.message }
        );
        cluster.remove(seeded?.uid);
      } catch (err) {
        fail('sim-1160', `4n: networkpolicy/subscription locks could not run: ${err.message}`);
      }

      // The OpenShift router answers every request it cannot route with its own
      // error-page-503.http ("Application is not available"), never a 404 or
      // HAProxy's stock "No server is available" text.
      try {
        const unknownHost = simulation.trafficForWorkstationCurl(
          'http://qa4n-nothing.apps.cluster.example.com/'
        );
        lock(
          unknownHost?.status === 503 &&
            /<h1>Application is not available<\/h1>/.test(unknownHost?.body || '') &&
            !/No server is available|404 Not Found/.test(unknownHost?.body || ''),
          '4n: an unknown *.apps host gets the router’s 503 "Application is not available" page',
          { status: unknownHost?.status, body: String(unknownHost?.body || '').slice(0, 120) }
        );
      } catch (err) {
        fail('sim-1160', `4n: router error-page lock could not run: ${err.message}`);
      }

      // `oc get bc` / `oc get builds` FROM is the source, not the builder image.
      // OCP 4.22 printer: openshift-apiserver pkg/build/printers/internalversion/printer.go
      // describeSourceShort (Git / Git@<ref|7-char commit> / Dockerfile / Binary;
      // a custom-strategy BuildConfig prints CustomStrategy.From.Name).
      try {
        const fromColumn = (table, name) => {
          const line = String(table || '')
            .split('\n')
            .find((row) => row.startsWith(name));
          if (!line) return '';
          return line.trim().split(/\s{2,}/)[2] || '';
        };
        cli('oc new-project qa-from');
        const gitBuild = cli(
          'oc new-build openshift/nodejs:20-ubi9~https://github.com/openshift/nodejs-ex --name=from-git'
        );
        const gitBc = cli('oc get bc from-git');
        const gitBcFrom = fromColumn(gitBc.message, 'from-git');
        lock(
          !gitBuild.error &&
            gitBcFrom === 'Git@main' &&
            !/nodejs/.test(gitBc.message) &&
            !/~/.test(gitBc.message),
          'FROM: a Git BuildConfig prints Git@<ref>, never the builder image or the image~git token (OCP 4.22 describeSourceShort)',
          { from: gitBcFrom, table: gitBc.message }
        );
        const gitNew = cli('oc get builds from-git-1');
        lock(
          fromColumn(gitNew.message, 'from-git-1') === 'Git@main',
          'FROM: a New build still prints the ref until the clone resolves a commit',
          gitNew.message
        );
        tick(2);
        const startedFrom = fromColumn(cli('oc get builds from-git-1').message, 'from-git-1');
        const expectedCommit = cluster
          ._fakeDigest('git:https://github.com/openshift/nodejs-ex@main')
          .slice(0, 7);
        lock(
          startedFrom === `Git@${expectedCommit}`,
          'FROM: once the build starts, oc get builds prints Git@<7-char commit> (a full hex hash is shortened like the 4.22 printer)',
          { from: startedFrom, expected: `Git@${expectedCommit}` }
        );

        const binary = cli('oc new-build nodejs:20-ubi9 --name=from-bin');
        const binaryTable = cli('oc get bc from-bin');
        lock(
          !binary.error &&
            fromColumn(binaryTable.message, 'from-bin') === 'Binary' &&
            !/nodejs/.test(binaryTable.message),
          'FROM: a binary BuildConfig prints Binary, not the builder image',
          binaryTable.message
        );

        const docker = cli('oc new-build --dockerfile --name=from-docker');
        const dockerTable = cli('oc get bc from-docker');
        lock(
          !docker.error && fromColumn(dockerTable.message, 'from-docker') === 'Dockerfile',
          'FROM: a Dockerfile BuildConfig prints Dockerfile',
          dockerTable.message
        );

        engine.applyManifestObject({
          apiVersion: 'build.openshift.io/v1',
          kind: 'BuildConfig',
          metadata: { name: 'from-both', namespace: 'qa-from' },
          spec: {
            source: {
              type: 'Git',
              git: { uri: 'https://github.com/example/app.git', ref: 'release-1' },
              dockerfile: 'FROM scratch',
            },
            strategy: { type: 'Docker', dockerStrategy: { dockerfilePath: 'Dockerfile' } },
            output: { to: { kind: 'ImageStreamTag', name: 'from-both:latest' } },
          },
        });
        const bothFrom = fromColumn(cli('oc get bc from-both').message, 'from-both');
        lock(
          bothFrom === 'Dockerfile,Git@release-1',
          'FROM: Dockerfile+Git prints Dockerfile,Git@<ref> (ref is not a long hex hash, so it is not shortened)',
          bothFrom
        );

        const fullCommit = 'e79d887aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        engine.applyManifestObject({
          apiVersion: 'build.openshift.io/v1',
          kind: 'Build',
          metadata: { name: 'from-pin-1', namespace: 'qa-from' },
          spec: {
            source: {
              type: 'Git',
              git: { uri: 'https://github.com/example/app.git', ref: 'main' },
            },
            revision: { type: 'Git', git: { commit: fullCommit } },
            strategy: {
              type: 'Source',
              sourceStrategy: {
                from: { kind: 'ImageStreamTag', name: 'nodejs:20-ubi9', namespace: 'openshift' },
              },
            },
            output: { to: { kind: 'ImageStreamTag', name: 'from-pin:latest' } },
          },
        });
        const pinnedFrom = fromColumn(cli('oc get builds from-pin-1').message, 'from-pin-1');
        lock(
          pinnedFrom === 'Git@e79d887' && !pinnedFrom.includes(fullCommit),
          'FROM: a full hex commit is shortened to 7 characters and wins over source.git.ref',
          pinnedFrom
        );

        engine.applyManifestObject({
          apiVersion: 'build.openshift.io/v1',
          kind: 'BuildConfig',
          metadata: { name: 'from-custom', namespace: 'qa-from' },
          spec: {
            source: {
              type: 'Git',
              git: { uri: 'https://github.com/example/app.git', ref: 'main' },
            },
            strategy: {
              type: 'Custom',
              customStrategy: {
                from: { kind: 'DockerImage', name: 'registry.example/custom-builder:1' },
              },
            },
            output: { to: { kind: 'ImageStreamTag', name: 'from-custom:latest' } },
          },
        });
        const customFrom = fromColumn(cli('oc get bc from-custom').message, 'from-custom');
        lock(
          customFrom === 'registry.example/custom-builder:1',
          'FROM: a custom-strategy BuildConfig prints CustomStrategy.From.Name, not the Git source',
          customFrom
        );
      } catch (err) {
        fail('sim-1160', `FROM column lock could not run: ${err.message}`);
      }

      // Logged out: anonymous 403s, real logout/whoami/project errors, token login.
      try {
        const token = cli('oc whoami -t').message.trim();
        const logout = cli('oc logout');
        const second = cli('oc logout');
        const getPods = cli('oc get pods');
        const run = cli('oc run qa4n-anon --image=quay.io/openshift/origin-hello-openshift:latest');
        const whoami = cli('oc whoami');
        const project = cli('oc project');
        const bogus = cli('oc login --token=sha256~not-a-real-token');
        lock(
          logout.message.trim() ===
            'Logged "kubeadmin" out on "https://api.cluster.example.com:6443"' &&
            second.error &&
            second.message.trim() === 'error: You must have a token in order to logout.',
          '4n: `oc logout` prints the real `Logged "<user>" out on "<server>"`; a second logout has no token to revoke',
          { logout: logout.message, second: second.message }
        );
        lock(
          getPods.error &&
            /^Error from server \(Forbidden\): pods is forbidden: User "system:anonymous" cannot list resource "pods" in API group "" in the namespace "/.test(
              getPods.message.trim()
            ) &&
            run.error &&
            /User "system:anonymous" cannot create resource "pods"/.test(run.message) &&
            !cluster.getByName('Pod', 'qa4n-anon', 'qa4n-ops'),
          '4n: logged out, `oc get` / `oc run` are anonymous 403s and create nothing (they used to work)',
          { getPods: getPods.message, run: run.message }
        );
        lock(
          whoami.error &&
            /users\.user\.openshift\.io "~" is forbidden: User "system:anonymous"/.test(
              whoami.message
            ) &&
            project.error &&
            /you do not have rights to view project/.test(project.message) &&
            bogus.error &&
            bogus.message.trim() === 'error: The token provided is invalid or expired.',
          '4n: logged out, whoami/project fail like real oc and `oc login --token=<garbage>` is rejected (it used to log in as kubeadmin)',
          { whoami: whoami.message, project: project.message, bogus: bogus.message }
        );
        const clientDryRun = cli(
          'oc create deployment qa4n-yaml --image=quay.io/openshift/origin-hello-openshift:latest --dry-run=client -o yaml'
        );
        lock(
          !clientDryRun.error &&
            /^apiVersion: apps\/v1\nkind: Deployment/.test(clientDryRun.message),
          '4n: logged out, `oc create … --dry-run=client -o yaml` still renders locally (no API request is made)',
          clientDryRun.message.slice(0, 160)
        );
        const tokenLogin = cli(`oc login --token=${token}`);
        lock(
          !tokenLogin.error &&
            /^Logged into "https:\/\/api\.cluster\.example\.com:6443" as "kubeadmin" using the token provided\./.test(
              tokenLogin.message
            ) &&
            cli('oc whoami').message.trim() === 'kubeadmin',
          '4n: `oc login --token=$(oc whoami -t)` (a token the cluster issued) logs back in',
          tokenLogin.message.slice(0, 160)
        );
      } catch (err) {
        fail('sim-1160', `4n: logged-out locks could not run: ${err.message}`);
      }
    } finally {
      delete globalThis.window;
    }
  }
}

// ── 4o. Chaos incident targets stay on an affected kind (1.16.2) ───────────
// A random CronJobMissedSchedule with no CronJob or Job used to bind the first
// platform Pod (`alertmanager-main-0`). The panel then taught
// `oc get cronjob alertmanager-main-0`, onset damage never applied, and the
// unsuspend fix could not resolve it. Same class: JobDeadlineExceeded (which
// lists Pod) bound that Pod through the unknown-target lookup.
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const chaosMod = await tryImport('js/modes/ChaosMode.js');
  const incidentMod = await tryImport('js/engine/IncidentEngine.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const manifestMod = await tryImport('js/engine/ManifestEngine.js');
  if (
    !engineMod?.GameEngine ||
    !chaosMod?.ChaosMode ||
    !incidentMod?.IncidentEngine ||
    !commandBarMod?.CommandBar ||
    !manifestMod?.ManifestEngine
  ) {
    fail('chaos-target', '4o: engine modules are not importable for the chaos-target lock');
  } else {
    const engine = new engineMod.GameEngine({ mode: 'chaos' });
    const incidentEngine = new incidentMod.IncidentEngine(engine);
    new chaosMod.ChaosMode(engine, incidentEngine, null).setupCluster();
    // Sandbox clock: the cluster is the chaos seed (platform Pods, no CronJob),
    // but random chaos respawns must not re-suspend the CronJob during the heal wait.
    incidentEngine.start('sandbox');
    engine.simulation.randomFailureRate = 0;
    const cluster = engine.cluster;
    const manifestEngine = new manifestMod.ManifestEngine({ cluster, gameEngine: engine });
    globalThis.window = {
      game: {
        cluster,
        gameEngine: engine,
        engine: { emit() {}, on() {}, off() {} },
        manifestEngine,
      },
    };
    manifestEngine.game = globalThis.window.game;
    const commandBar = new commandBarMod.CommandBar();
    const cli = (raw) => {
      try {
        const out = commandBar.executeCommand(raw);
        return { error: Boolean(out?.error), message: String(out?.message ?? '') };
      } catch (err) {
        return { error: true, message: `THROW ${err?.message || err}` };
      }
    };
    const tick = (seconds) => {
      const steps = Math.ceil(seconds / 0.05);
      for (let step = 0; step < steps; step += 1) {
        engine.simulation.tick(0.05);
        incidentEngine.tick(0.05);
      }
    };
    const lock = (ok, message, detail) => {
      if (ok) passed();
      else fail('chaos-target', message, detail === undefined ? undefined : JSON.stringify(detail));
    };
    const defOf = (name) => [...incidentEngine._defsById.values()].find((def) => def.name === name);
    try {
      const pods = cluster.getByKind('Pod') || [];
      const cronDef = defOf('CronJobMissedSchedule');
      const jobDef = defOf('JobDeadlineExceeded');
      lock(
        pods.some((pod) => pod.name === 'alertmanager-main-0') &&
          (cluster.getByKind('CronJob') || []).length === 0 &&
          (cluster.getByKind('Job') || []).length === 0,
        '4o: the chaos seed has alertmanager-main-0 and no CronJob or Job (the reported empty-cluster case)',
        { pods: pods.slice(0, 3).map((pod) => pod.name) }
      );
      lock(
        incidentEngine._findFallbackTarget(cronDef) == null &&
          incidentEngine._findFallbackTarget(jobDef) == null,
        '4o: a non-Pod incident must not fall back to the first platform Pod'
      );
      const podOnly = {
        affectedResourceTypes: ['Pod'],
        resolution: { targetKind: 'Pod' },
      };
      const podFallback = incidentEngine._findFallbackTarget(podOnly);
      lock(
        podFallback?.kind === 'Pod',
        '4o: a Pod incident with no owner still falls back to a Pod',
        podFallback?.kind
      );
      const picked = incidentEngine.selectRandomTarget(cronDef);
      const id = incidentEngine.spawnIncident(cronDef, picked);
      const incident = incidentEngine.activeIncidents.get(id);
      const cron = cluster.getByName('CronJob', incident?.target, incident?.namespace);
      const boundPod = (cluster.getByKind('Pod') || []).find(
        (pod) => pod.name === incident?.target
      );
      lock(
        picked === 'unknown' &&
          cron?.kind === 'CronJob' &&
          cron.spec?.suspend === true &&
          incident?.damageApplied === true &&
          !boundPod &&
          incident.target !== 'alertmanager-main-0',
        '4o: CronJobMissedSchedule creates and suspends a CronJob instead of binding alertmanager-main-0',
        {
          picked,
          target: incident?.target,
          namespace: incident?.namespace,
          suspend: cron?.spec?.suspend,
          damageApplied: incident?.damageApplied,
        }
      );
      const step = String(incident?.investigationSteps?.[0]?.command || '')
        .replace(/<cronjob>/g, incident?.target || '')
        .replace(/<namespace>/g, incident?.namespace || '');
      const listed = cli(`oc get cronjob ${incident.target} -n ${incident.namespace}`);
      const row = listed.message.split('\n').find((line) => line.startsWith(incident.target)) || '';
      lock(
        step === `oc get cronjob ${incident.target} -n ${incident.namespace}` &&
          !listed.error &&
          row.includes(incident.target) &&
          /\btrue\b/.test(row) &&
          !/alertmanager-main-0/.test(step),
        '4o: the taught `oc get cronjob <name>` names the suspended CronJob, not a Pod',
        { step, row, error: listed.error, message: listed.message.slice(0, 200) }
      );
      tick(0.1);
      const patched = cli(
        `oc patch cronjob ${incident.target} -n ${incident.namespace} -p '{"spec":{"suspend":false}}'`
      );
      tick(2.2);
      const after = cluster.getByName('CronJob', incident.target, incident.namespace);
      lock(
        !patched.error &&
          /patched/.test(patched.message) &&
          incident.state === 'Resolved' &&
          !incidentEngine.activeIncidents.has(id) &&
          after?.spec?.suspend === false,
        '4o: `oc patch cronjob … suspend:false` resolves CronJobMissedSchedule (the taught fix)',
        {
          patch: patched.message.slice(0, 160),
          state: incident.state,
          suspend: after?.spec?.suspend,
        }
      );

      // Same class, second engine: JobDeadlineExceeded lists Pod, so the old
      // unknown-target walk bound alertmanager-main-0 and never damaged a Job.
      const engine2 = new engineMod.GameEngine({ mode: 'chaos' });
      const incidents2 = new incidentMod.IncidentEngine(engine2);
      new chaosMod.ChaosMode(engine2, incidents2, null).setupCluster();
      incidents2.start('sandbox');
      const jobId = incidents2.spawnIncident(jobDef, incidents2.selectRandomTarget(jobDef));
      const jobIncident = incidents2.activeIncidents.get(jobId);
      const job = engine2.cluster.getByName('Job', jobIncident?.target, jobIncident?.namespace);
      lock(
        job?.kind === 'Job' &&
          job.status?.phase === 'Failed' &&
          jobIncident?.damageApplied === true &&
          jobIncident.target !== 'alertmanager-main-0',
        '4o: JobDeadlineExceeded creates a Failed Job instead of binding alertmanager-main-0',
        {
          target: jobIncident?.target,
          kind: job?.kind,
          phase: job?.status?.phase,
          damageApplied: jobIncident?.damageApplied,
        }
      );
      incidents2.stop();
    } catch (err) {
      fail('chaos-target', `4o: chaos-target lock could not run: ${err?.stack || err}`);
    } finally {
      incidentEngine.stop();
      delete globalThis.window;
    }
  }
}

// ── 4p. Unquoted CPU quantities are cores, not millicores (1.16.3) ─────────
// YAML `cpu: 1` is a number. parseCpuMillis used to return that number as
// millicores, so a 500m quota admitted a 1-core Pod (Used printed `1m`) and a
// 20-core Pod scheduled onto a 16-core node, while the quoted form `cpu: "1"`
// was rejected. A bare number is a decimal quantity in cores.
{
  const engineMod = await tryImport('js/engine/GameEngine.js');
  const sandboxMod = await tryImport('js/modes/SandboxMode.js');
  const commandBarMod = await tryImport('js/ui/CommandBar.js');
  const manifestMod = await tryImport('js/engine/ManifestEngine.js');
  const stateMod = await tryImport('js/engine/ClusterState.js');
  const yamlMod = await tryImport('js/engine/YamlParser.js');
  if (
    !engineMod?.GameEngine ||
    !sandboxMod?.SandboxMode ||
    !commandBarMod?.CommandBar ||
    !manifestMod?.ManifestEngine ||
    !stateMod?.parseCpuMillis ||
    !yamlMod?.parseDocument
  ) {
    fail('cpu-quantity', '4p: engine modules are not importable for the CPU quantity lock');
  } else {
    const engine = new engineMod.GameEngine({ mode: 'sandbox' });
    new sandboxMod.SandboxMode(engine, null).setupCluster(3);
    const cluster = engine.cluster;
    const simulation = engine.simulation;
    simulation.randomFailureRate = 0;
    const manifestEngine = new manifestMod.ManifestEngine({ cluster, gameEngine: engine });
    globalThis.window = {
      game: {
        cluster,
        gameEngine: engine,
        engine: { emit() {}, on() {}, off() {} },
        manifestEngine,
      },
    };
    manifestEngine.game = globalThis.window.game;
    const commandBar = new commandBarMod.CommandBar();
    const cli = (raw) => {
      try {
        const out = commandBar.executeCommand(raw);
        return { error: Boolean(out?.error), message: String(out?.message ?? '') };
      } catch (err) {
        return { error: true, message: `THROW ${err?.message || err}` };
      }
    };
    const tick = (seconds) => {
      const steps = Math.ceil(seconds / 0.05);
      for (let step = 0; step < steps; step += 1) simulation.tick(0.05);
    };
    const lock = (ok, message, detail) => {
      if (ok) passed();
      else fail('cpu-quantity', message, detail === undefined ? undefined : JSON.stringify(detail));
    };
    const writeApply = (path, body, namespace) => {
      const written = cli(`cat > ${path} <<'EOF'\n${body}EOF`);
      const applied = cli(`oc apply -f ${path}${namespace ? ` -n ${namespace}` : ''}`);
      return { written, applied };
    };
    try {
      const parsed = stateMod.parseCpuMillis;
      lock(
        parsed(1) === 1000 &&
          parsed('1') === 1000 &&
          parsed(0.5) === 500 &&
          parsed('0.5') === 500 &&
          parsed(2) === 2000 &&
          parsed('100m') === 100 &&
          parsed('250m') === 250 &&
          parsed(0) === 0 &&
          parsed('100m') === parsed(0.1),
        '4p: a bare CPU number is cores (1 → 1000m, 0.5 → 500m), agreeing with the quoted string; milli suffixes stay milli',
        {
          n1: parsed(1),
          s1: parsed('1'),
          nHalf: parsed(0.5),
          milli: parsed('100m'),
        }
      );
      const yamlNumber = yamlMod.parseDocument('cpu: 1\nhalf: 0.5\nmilli: 100m\nquoted: "1"\n');
      lock(
        typeof yamlNumber?.cpu === 'number' &&
          yamlNumber.cpu === 1 &&
          parsed(yamlNumber.cpu) === parsed(yamlNumber.quoted) &&
          parsed(yamlNumber.half) === 500 &&
          parsed(yamlNumber.milli) === 100,
        '4p: the YAML parser keeps unquoted `cpu: 1` as a number, and that number is the same quantity as `cpu: "1"`',
        yamlNumber
      );

      cli('oc new-project qa4p-cpu');
      cli('oc create quota tight --hard=pods=10,requests.cpu=500m,requests.memory=2Gi -n qa4p-cpu');
      const oneCore = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: one-core
  namespace: qa4p-cpu
spec:
  replicas: 1
  selector:
    matchLabels:
      app: one-core
  template:
    metadata:
      labels:
        app: one-core
    spec:
      containers:
      - name: app
        image: quay.io/openshift/origin-hello-openshift:latest
        resources:
          requests:
            cpu: 1
            memory: 64Mi
`;
      const appliedOne = writeApply('/tmp/qa4p-one-core.yaml', oneCore, 'qa4p-cpu');
      const deploy = cluster.getByName('Deployment', 'one-core', 'qa4p-cpu');
      const storedCpu = deploy?.spec?.template?.spec?.containers?.[0]?.resources?.requests?.cpu;
      lock(
        !appliedOne.applied.error && storedCpu === 1 && typeof storedCpu === 'number',
        '4p: `oc apply` of unquoted `cpu: 1` stores the YAML number, not a milli string',
        { apply: appliedOne.applied.message.slice(0, 160), storedCpu, type: typeof storedCpu }
      );
      const numericAdmit = cluster.admitPodAgainstQuota('qa4p-cpu', {
        containers: [
          { name: 'app', image: 'x', resources: { requests: { cpu: 1, memory: '64Mi' } } },
        ],
      });
      const quotedAdmit = cluster.admitPodAgainstQuota('qa4p-cpu', {
        containers: [
          { name: 'app', image: 'x', resources: { requests: { cpu: '1', memory: '64Mi' } } },
        ],
      });
      lock(
        numericAdmit.allowed === false &&
          quotedAdmit.allowed === false &&
          /requested: requests\.cpu=1000m/.test(numericAdmit.message) &&
          numericAdmit.message === quotedAdmit.message,
        '4p: quota admission rejects numeric `cpu: 1` and string `cpu: "1"` with the same 1000m exceeded-quota error (a 500m quota used to admit the number as 1m)',
        { numeric: numericAdmit, quoted: quotedAdmit }
      );
      tick(2);
      cluster.recalculateQuotaStatus(false);
      const quota = cluster.getByName('ResourceQuota', 'tight', 'qa4p-cpu');
      const rs = (cluster.getByKindAndNamespace('ReplicaSet', 'qa4p-cpu') || []).find((item) =>
        String(item.metadata?.name || '').startsWith('one-core-')
      );
      const failed = (rs?.events || []).find((event) => event.reason === 'FailedCreate');
      const pods = cluster.getByKindAndNamespace('Pod', 'qa4p-cpu') || [];
      lock(
        pods.length === 0 &&
          quota?.status?.used?.['requests.cpu'] === '0m' &&
          /exceeded quota: tight/.test(failed?.message || '') &&
          /requests\.cpu=1000m/.test(failed?.message || ''),
        '4p: the ReplicaSet does not create the 1-core Pod; FailedCreate names 1000m and quota Used stays 0m (it used to run and show Used 1m)',
        {
          pods: pods.map((pod) => pod.metadata?.name),
          used: quota?.status?.used,
          failed: failed?.message,
        }
      );

      const small = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: small
  namespace: qa4p-cpu
spec:
  replicas: 1
  selector:
    matchLabels:
      app: small
  template:
    metadata:
      labels:
        app: small
    spec:
      containers:
      - name: app
        image: quay.io/openshift/origin-hello-openshift:latest
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
`;
      writeApply('/tmp/qa4p-small.yaml', small, 'qa4p-cpu');
      tick(6);
      cluster.recalculateQuotaStatus(false);
      const smallPods = (cluster.getByKindAndNamespace('Pod', 'qa4p-cpu') || []).filter((pod) =>
        String(pod.metadata?.name || '').startsWith('small-')
      );
      lock(
        smallPods.length === 1 &&
          smallPods[0].status?.phase === 'Running' &&
          quota?.status?.used?.['requests.cpu'] === '100m',
        '4p: a 100m request is unchanged (still admitted, Used 100m, not 100000m)',
        {
          phase: smallPods[0]?.status?.phase,
          used: quota?.status?.used?.['requests.cpu'],
          count: smallPods.length,
        }
      );

      const limitCheck = cluster.checkLimitRange('qa4p-cpu', {
        containers: [{ resources: { requests: { cpu: 0.5 } } }],
      });
      lock(
        limitCheck.allowed === true,
        '4p: LimitRange is not involved until one exists (control before the max check)',
        limitCheck
      );
      const limitRange = `apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-max
  namespace: qa4p-cpu
spec:
  limits:
  - type: Container
    max:
      cpu: 200m
`;
      const appliedLimit = writeApply('/tmp/qa4p-limit.yaml', limitRange, 'qa4p-cpu');
      const overMax = cluster.checkLimitRange('qa4p-cpu', {
        containers: [{ name: 'app', resources: { requests: { cpu: 0.5, memory: '64Mi' } } }],
      });
      lock(
        !appliedLimit.applied.error &&
          overMax.allowed === false &&
          /maximum cpu usage per Container is 200m/.test(overMax.violations?.[0] || ''),
        '4p: LimitRange max 200m rejects numeric `cpu: 0.5` (500m); it used to compare 0.5 < 200 and allow it',
        { apply: appliedLimit.applied.message.slice(0, 120), overMax }
      );

      cli('oc new-project qa4p-sched');
      const huge = `apiVersion: v1
kind: Pod
metadata:
  name: twenty-core
  namespace: qa4p-sched
spec:
  containers:
  - name: app
    image: quay.io/openshift/origin-hello-openshift:latest
    resources:
      requests:
        cpu: 20
        memory: 64Mi
`;
      const appliedHuge = writeApply('/tmp/qa4p-twenty.yaml', huge, 'qa4p-sched');
      const hugePod = cluster.getByName('Pod', 'twenty-core', 'qa4p-sched');
      tick(1);
      const schedEvent = (hugePod?.events || []).find(
        (event) => event.reason === 'FailedScheduling'
      );
      lock(
        !appliedHuge.applied.error &&
          hugePod?.spec?.containers?.[0]?.resources?.requests?.cpu === 20 &&
          !hugePod?.spec?.nodeName &&
          hugePod?.status?.phase === 'Pending' &&
          /Insufficient cpu/.test(schedEvent?.message || ''),
        '4p: numeric `cpu: 20` stays Pending with Insufficient cpu on 16-core nodes (it used to schedule onto worker-0 as 20m)',
        {
          apply: appliedHuge.applied.message.slice(0, 120),
          phase: hugePod?.status?.phase,
          node: hugePod?.spec?.nodeName || null,
          event: schedEvent?.message,
        }
      );
    } catch (err) {
      fail('cpu-quantity', `4p: CPU quantity lock could not run: ${err?.stack || err}`);
    } finally {
      delete globalThis.window;
    }
  }
}

// ── 5. Campaign, challenges, incidents and EX280 content ──────────────────
const levelsMod = await tryImport('js/data/CampaignLevels.js');
const challengesMod = await tryImport('js/modes/ChallengeMode.js');
const incidentsMod = await tryImport('js/data/IncidentDefs.js');
const evaluatorMod = await tryImport('js/engine/ObjectiveEvaluator.js');
const ex280Mod = await tryImport('js/data/EX280Objectives.js');
const achievementsMod = await tryImport('js/data/Achievements.js');
const manifestFilesMod = await tryImport('js/data/ManifestFiles.js');
const registryKinds = registry?.RESOURCE_KINDS ? new Set(registry.RESOURCE_KINDS) : new Set();

const implementedTypes = new Set();
if (evaluatorMod?.OBJECTIVE_TYPES) {
  for (const t of evaluatorMod.OBJECTIVE_TYPES) implementedTypes.add(String(t).toLowerCase());
} else if (evaluatorMod) {
  const src = read('js/engine/ObjectiveEvaluator.js');
  for (const m of src.matchAll(/case\s+['"]([a-zA-Z0-9_]+)['"]\s*:/g))
    implementedTypes.add(m[1].toLowerCase());
}
if (implementedTypes.size)
  note(`ObjectiveEvaluator: ${implementedTypes.size} objective types exported`);
else fail('objectives', 'ObjectiveEvaluator does not export OBJECTIVE_TYPES or switch cases');

const INCIDENT_DEFS = incidentsMod?.INCIDENT_DEFS || [];
const incidentNames = new Set(INCIDENT_DEFS.map((i) => i.name));
const REQUIRED_INCIDENTS = [
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'OOMKilled',
  'SCCForbidden',
  'PendingScheduling',
  'CreateContainerConfigError',
  'ReadinessProbeFailure',
  'LivenessProbeFailure',
  'PodStuckTerminating',
  'DeploymentStuckRollout',
  'ImageStreamTagMissing',
  'BuildFailed',
  'HPAUnableToScale',
  'JobDeadlineExceeded',
  'CronJobMissedSchedule',
  'PVCPending',
  'ConfigMapMissing',
  'SecretMissing',
  'SecretExposed',
  'ServiceNoEndpoints',
  'RouteNotAdmitted',
  'RouteTLSCertificateError',
  'RouteHostConflict',
  'NetworkPolicyBlocking',
  'DNSResolutionFailure',
  'IngressDegraded',
  'LoadBalancerPending',
  'UnauthorizedAccess',
  'HTPasswdAuthFailure',
  'ResourceQuotaExceeded',
  'LimitRangeViolation',
  'ClusterResourceQuotaExceeded',
  'NodeNotReady',
  'NodeDiskPressure',
  'NodeMemoryPressure',
  'OperatorInstallFailed',
];
const INCIDENT_CATEGORIES = new Set([
  'Pod',
  'Network',
  'Security',
  'Build',
  'Cluster',
  'Storage',
  'Identity',
]);

if (INCIDENT_DEFS.length) {
  if (INCIDENT_DEFS.length < 30)
    fail('incidents', `expected 30+ incidents, found ${INCIDENT_DEFS.length}`);
  for (const name of REQUIRED_INCIDENTS) {
    if (!incidentNames.has(name)) fail('incidents', `required incident "${name}" is missing`);
  }
  const ids = new Set();
  for (const inc of INCIDENT_DEFS) {
    if (!inc.id) fail('incidents', `${inc.name || '?'}: missing id`);
    if (ids.has(inc.id)) fail('incidents', `duplicate incident id ${inc.id}`);
    ids.add(inc.id);
    if (!INCIDENT_CATEGORIES.has(inc.category))
      fail('incidents', `${inc.name}: invalid category ${inc.category}`);
    if (!(Number(inc.severity) >= 1 && Number(inc.severity) <= 5))
      fail('incidents', `${inc.name}: severity out of 1..5`);
    if (!inc.description) fail('incidents', `${inc.name}: missing description`);
    if (!Array.isArray(inc.ocCommands) || inc.ocCommands.length === 0)
      fail('incidents', `${inc.name}: no ocCommands`);
    else {
      for (const cmd of inc.ocCommands) {
        if (/\bkubectl\b/.test(cmd))
          fail('incidents', `${inc.name}: ocCommands contains kubectl: ${cmd}`);
        if (!/\boc\b/.test(cmd))
          warn('incidents', `${inc.name}: ocCommands command does not use oc: ${cmd}`);
      }
    }
    if (inc.kubectlCommands)
      fail('incidents', `${inc.name}: legacy kubectlCommands field still present`);
    if (!Array.isArray(inc.investigationSteps) || inc.investigationSteps.length < 2) {
      fail('incidents', `${inc.name}: needs 2+ investigationSteps`);
    } else {
      for (const step of inc.investigationSteps) {
        if (!step.command) fail('incidents', `${inc.name}: investigation step without command`);
        if (/\bkubectl\b/.test(step.command || ''))
          fail('incidents', `${inc.name}: investigation uses kubectl: ${step.command}`);
      }
    }
    if (!Array.isArray(inc.resolutionActions) || inc.resolutionActions.length < 2) {
      fail('incidents', `${inc.name}: needs 2+ resolutionActions`);
    }
    if (!inc.resolution || typeof inc.resolution !== 'object')
      fail('incidents', `${inc.name}: missing resolution object`);
    for (const kind of inc.affectedResourceTypes || []) {
      if (registryKinds.size && !registryKinds.has(kind))
        fail('incidents', `${inc.name}: unknown affectedResourceType ${kind}`);
    }
  }
  if (/kubectlCommands/.test(read('js/engine/IncidentEngine.js'))) {
    warn(
      'incidents',
      'IncidentEngine source still mentions kubectlCommands (rename to ocCommands)'
    );
  }
} else {
  fail('incidents', 'js/data/IncidentDefs.js missing or has no INCIDENT_DEFS');
}

function collectTypes(objectives, set = new Set()) {
  for (const obj of objectives || []) {
    if (obj && obj.type) set.add(obj.type);
  }
  return set;
}
function normalizeType(type) {
  return String(type || '').toLowerCase();
}
function objectiveTypeImplemented(type) {
  if (!implementedTypes.size) return true;
  return implementedTypes.has(normalizeType(type));
}
function checkObjective(owner, obj) {
  if (!obj || typeof obj !== 'object') {
    fail('objectives', `${owner}: objective is not an object`);
    return;
  }
  if (!obj.type) {
    fail('objectives', `${owner}: objective without type: ${JSON.stringify(obj).slice(0, 120)}`);
    return;
  }
  if (!objectiveTypeImplemented(obj.type)) {
    fail(
      'objectives',
      `${owner}: objective type "${obj.type}" not implemented in ObjectiveEvaluator`
    );
  } else passed();
  // `kind` is a resource kind for most objective types; serviceType.kind is a
  // Service type string, so only validate the types where kind means a kind.
  const resourceKindTypes = new Set([
    'deploy',
    'scale',
    'replicas',
    'build',
    'imagestream',
    'image',
    'mount',
    'envfrom',
    'resources',
    'probes',
    'hpa',
    'pdb',
    'bound',
    'headless',
    'stable',
    'update',
    'complete',
    'cronjob',
    'coverage',
    'distribute',
    'reschedule',
    'nodeselector',
    'label',
  ]);
  if (
    obj.kind &&
    registryKinds.size &&
    resourceKindTypes.has(normalizeType(obj.type)) &&
    !registryKinds.has(obj.kind)
  ) {
    fail('objectives', `${owner}: objective references unknown kind "${obj.kind}"`);
  }
  if (obj.targetKind && registryKinds.size && !registryKinds.has(obj.targetKind)) {
    fail('objectives', `${owner}: objective references unknown targetKind "${obj.targetKind}"`);
  }
  if (obj.incidentType && incidentNames.size && !incidentNames.has(obj.incidentType)) {
    fail('objectives', `${owner}: objective references unknown incident "${obj.incidentType}"`);
  }
}
function checkManifestRefs(owner, files) {
  for (const file of files || []) {
    if (manifestFilesMod?.MANIFEST_FILES && !(file in manifestFilesMod.MANIFEST_FILES)) {
      fail('manifests', `${owner}: manifest file not seeded: ${file}`);
    }
  }
}

// 1.16.0 campaign structure: level ids are stable SAVE KEYS (player progress is
// stored per id), campaign ORDER comes from CHAPTERS, display numbers are
// positional. Ids 1–20 keep their titles forever; new EX280 levels got new ids
// (21, 22) placed before the capstone (id 20); the optional Linux & RHEL
// Foundations prelude is chapter 0 with ids 101–107 (displayed 0.1–0.7).
const REQUIRED_LEVEL_TITLES = {
  1: 'Your First Project',
  2: 'Query, Format, Filter',
  3: 'Logs, Events & Health',
  4: 'Declarative Manifests',
  5: 'Kustomize Base',
  6: 'Kustomize Overlays',
  7: 'Secrets & ConfigMaps',
  8: 'Templates & Helm',
  9: 'Images, Builds & Image Streams',
  10: 'Rolling Updates & Rollbacks',
  11: 'Services & Routes',
  12: 'Non-HTTP & Load Balancer',
  13: 'HTPasswd & Users',
  14: 'Groups & RBAC',
  15: 'Quotas, LimitRanges & Templates',
  16: 'Service Accounts & API Access',
  17: 'SCC & Privileged Apps',
  18: 'Operators',
  19: 'Jobs & CronJobs',
  20: 'EX280 Final: Production Platform',
  21: 'Network Policies',
  22: 'Nodes & Cluster Troubleshooting',
};
const REQUIRED_CHAPTER_STRUCTURE = [
  { id: 0, name: 'Linux & RHEL Foundations', levels: [101, 102, 103, 104, 105, 106, 107] },
  { id: 1, name: 'Manage OpenShift', levels: [1, 2, 3, 4] },
  { id: 2, name: 'Declarative & Kustomize', levels: [5, 6, 7, 8] },
  { id: 3, name: 'Deploy & Expose', levels: [9, 10, 11, 12] },
  { id: 4, name: 'Identity, RBAC & Self-service', levels: [13, 14, 15, 16] },
  { id: 5, name: 'Security & Operations', levels: [17, 18, 19, 21, 22, 20] },
];
const PRELUDE_CHAPTER = 0;
/**
 * Commands a how-to may tell the player to type: the `oc`/`helm` CLIs plus the
 * simulated workstation shell (js/ui/ShellTools.js + the 1.16.0 RHEL host). A
 * how-to step must start with one of them (no prose, no placeholders).
 */
const TYPEABLE_COMMANDS = [
  'oc',
  'helm',
  'cat',
  'echo',
  'printf',
  'htpasswd',
  'openssl',
  'curl',
  'vi',
  'vim',
  'ls',
  'cd',
  'pwd',
  'export',
  'skopeo',
  'sed',
  'grep',
  'head',
  'tail',
  'cut',
  'sort',
  'uniq',
  'wc',
  'tr',
  'tee',
  'less',
  'find',
  'stat',
  'du',
  'df',
  'base64',
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'tar',
  'whoami',
  'id',
  'groups',
  'sudo',
  'chmod',
  'chown',
  'chgrp',
  'getenforce',
  'sestatus',
  'restorecon',
  'semanage',
  'timedatectl',
  'bash',
  // The interactive `oc debug node/<n>` session (chroot /host → systemctl → exit, exit).
  'chroot',
  'exit',
  'hostname',
  'uname',
  'date',
  'uptime',
  'free',
  'ps',
  'pgrep',
  'kill',
  'pkill',
  'top',
  'systemctl',
  'journalctl',
  'ip',
  'ss',
  'ping',
  'dig',
  'host',
  'nslookup',
  'getent',
  'firewall-cmd',
  'dnf',
  'rpm',
  'podman',
  'env',
  'printenv',
  'which',
  'source',
];
const TYPEABLE_COMMAND_RE = new RegExp(
  `^(${TYPEABLE_COMMANDS.map((name) => name.replace(/[-]/g, '\\-')).join('|')})(\\s+\\S|$)`
);
/** The RHEL prelude may also run a shell script by name or path (`lab-info.sh`, `./x.sh`). */
const PRELUDE_SCRIPT_RE = /^(\.\/|~\/|\/)?[\w./-]*[\w-]\.sh(\s+\S|$)/;
/** A plain shell assignment (`API_IP=$(dig +short api.cluster.example.com)`) is typeable too. */
const SHELL_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S/;
const REQUIRED_ORDER = REQUIRED_CHAPTER_STRUCTURE.flatMap((chapter) => chapter.levels);
const REQUIRED_PRELUDE_ORDER = REQUIRED_CHAPTER_STRUCTURE[0].levels;
const REQUIRED_EX280_ORDER = REQUIRED_CHAPTER_STRUCTURE.slice(1).flatMap(
  (chapter) => chapter.levels
);
const chapterOfLevel = new Map(
  REQUIRED_CHAPTER_STRUCTURE.flatMap((chapter) => chapter.levels.map((id) => [id, chapter]))
);
const levelIds = new Set();
const levels = levelsMod?.CAMPAIGN_LEVELS || [];
if (levels.length) {
  if (levels.length !== REQUIRED_ORDER.length)
    fail('campaign', `expected ${REQUIRED_ORDER.length} levels, found ${levels.length}`);
  else passed();
  const actualOrder = levels.map((level) => level.id);
  if (JSON.stringify(actualOrder) !== JSON.stringify(REQUIRED_ORDER))
    fail(
      'campaign',
      `CAMPAIGN_LEVELS must be in campaign order ${REQUIRED_ORDER.join(',')}, got ${actualOrder.join(',')}`
    );
  else passed();
  for (const [i, level] of levels.entries()) {
    const owner = `level ${level.id} (${level.title})`;
    if (levelIds.has(level.id)) fail('campaign', `${owner}: duplicate level id`);
    levelIds.add(level.id);
    const isPrelude = level.chapter === PRELUDE_CHAPTER;
    const expectedChapter = chapterOfLevel.get(level.id);
    if (!expectedChapter) fail('campaign', `${owner}: id is not placed in any chapter`);
    else if (level.chapter !== expectedChapter.id)
      fail('campaign', `${owner}: chapter ${level.chapter} != ${expectedChapter.id}`);
    else if (level.chapterName !== expectedChapter.name)
      fail(
        'campaign',
        `${owner}: chapterName "${level.chapterName}" does not match chapter ${level.chapter}`
      );
    else passed();
    if (REQUIRED_LEVEL_TITLES[level.id] && level.title !== REQUIRED_LEVEL_TITLES[level.id])
      fail('campaign', `${owner}: title differs from spec "${REQUIRED_LEVEL_TITLES[level.id]}"`);
    if (!isPrelude && !REQUIRED_LEVEL_TITLES[level.id])
      fail('campaign', `${owner}: EX280 level has no pinned title in REQUIRED_LEVEL_TITLES`);
    if (isPrelude && !(level.id >= 101 && level.id <= 199))
      fail('campaign', `${owner}: prelude level ids live in 101–199`);
    if (!level.description) fail('campaign', `${owner}: missing description`);
    if (isPrelude) {
      // Prerequisite skills, not EX280 bullets: examObjectives may be empty, but
      // anything listed must still be an official bullet (checked below).
      if (!Array.isArray(level.examObjectives))
        fail('campaign', `${owner}: examObjectives must be an array (may be empty)`);
    }
    if (isPrelude && Array.isArray(level.examObjectives) && level.examObjectives.length === 0) {
      passed();
    } else if (!Array.isArray(level.examObjectives) || level.examObjectives.length === 0) {
      fail('campaign', `${owner}: missing examObjectives`);
    } else if (ex280Mod) {
      const groupMap = new Map(
        ex280Mod.EX280_OBJECTIVE_GROUPS.map((g) => [
          g.title,
          new Set(g.bullets.map((b) => b.title)),
        ])
      );
      for (const mapping of level.examObjectives) {
        const [groupName, bulletTitle] = String(mapping)
          .split('>')
          .map((s) => s.trim());
        if (!groupMap.has(groupName) || !groupMap.get(groupName).has(bulletTitle)) {
          fail(
            'campaign',
            `${owner}: examObjectives entry does not match an official bullet: ${mapping}`
          );
        }
      }
    }
    if (!Array.isArray(level.docsLinks) || level.docsLinks.length === 0)
      fail('campaign', `${owner}: no docsLinks`);
    else {
      // EX280 levels link the OCP 4.22 docs; the Linux prelude links the RHEL docs.
      const docsPattern = isPrelude
        ? /^https:\/\/docs\.redhat\.com\/en\/documentation\/red_hat_enterprise_linux\/(9|10)\//
        : /^https:\/\/docs\.redhat\.com\/en\/documentation\/openshift_container_platform\/4\.22\//;
      for (const url of level.docsLinks) {
        if (!docsPattern.test(url)) {
          fail(
            'campaign',
            `${owner}: docsLink is not ${isPrelude ? 'a RHEL' : 'an OCP 4.22'} docs page: ${url}`
          );
        }
      }
    }
    if (!Array.isArray(level.objectives) || level.objectives.length < 2)
      fail('campaign', `${owner}: needs 2+ objectives`);
    for (const obj of level.objectives || []) checkObjective(owner, obj);
    // The prelude happens on the RHEL workstation: it may seed no cluster objects.
    if (
      !Array.isArray(level.startingResources) ||
      (!isPrelude && level.startingResources.length === 0)
    )
      fail('campaign', `${owner}: no startingResources`);
    for (const res of level.startingResources || []) {
      if (registryKinds.size && !registryKinds.has(res.kind))
        fail('campaign', `${owner}: unknown startingResource kind ${res.kind}`);
      if (!res.name) fail('campaign', `${owner}: startingResource ${res.kind} missing name`);
    }
    if (
      !Array.isArray(level.availableResources) ||
      (!isPrelude && level.availableResources.length === 0)
    )
      fail('campaign', `${owner}: no availableResources`);
    for (const kind of level.availableResources || []) {
      if (registryKinds.size && !registryKinds.has(kind))
        fail('campaign', `${owner}: unknown availableResource ${kind}`);
    }
    if (!Array.isArray(level.hints) || level.hints.length < 3)
      fail('campaign', `${owner}: needs 3+ hints`);
    if (!level.starCriteria || typeof level.starCriteria !== 'object')
      fail('campaign', `${owner}: missing starCriteria`);
    else {
      if (!(Number(level.starCriteria.time) > 0))
        fail('campaign', `${owner}: starCriteria.time missing/<=0`);
      if (!(
        Number(level.starCriteria.efficiency) >= 0.5 && Number(level.starCriteria.efficiency) <= 1
      )) {
        fail('campaign', `${owner}: starCriteria.efficiency invalid`);
      }
      if (typeof level.starCriteria.noFailures !== 'boolean')
        fail('campaign', `${owner}: starCriteria.noFailures must be boolean`);
    }
    for (const inc of level.incidents || []) {
      if (incidentNames.size && !incidentNames.has(inc.type))
        fail('campaign', `${owner}: unknown incident type ${inc.type}`);
      if (!(Number(inc.triggerTime) >= 0))
        fail('campaign', `${owner}: incident ${inc.type} missing triggerTime`);
    }
    checkManifestRefs(owner, level.manifestFiles);
    checkManifestRefs(owner, level.focusFiles);
    if (level.tutorial !== null && level.tutorial !== undefined) {
      if (!Array.isArray(level.tutorial.steps) || level.tutorial.steps.length === 0) {
        fail('campaign', `${owner}: tutorial has no steps`);
      } else {
        for (const step of level.tutorial.steps) {
          if (
            !['command-bar', 'cluster-view', 'inspector', 'files', 'palette'].includes(step.target)
          ) {
            fail('campaign', `${owner}: invalid tutorial target ${step.target}`);
          }
        }
      }
    }
    // nextLevel follows campaign order inside each track; the last prelude level
    // hands over to Level 1 and the capstone (last EX280 level) ends the campaign.
    {
      const track = isPrelude ? REQUIRED_PRELUDE_ORDER : REQUIRED_EX280_ORDER;
      const position = track.indexOf(level.id);
      const expectedNext =
        position >= 0 && position < track.length - 1
          ? track[position + 1]
          : isPrelude
            ? REQUIRED_EX280_ORDER[0]
            : null;
      if ((level.nextLevel ?? null) !== expectedNext)
        fail('campaign', `${owner}: nextLevel ${level.nextLevel} != ${expectedNext}`);
      else passed();
    }
    if (i === levels.length - 1 && level.nextLevel)
      fail('campaign', `${owner}: last level must not have nextLevel`);
    for (const field of [
      level.description,
      ...(level.hints || []),
      ...(level.examObjectives || []),
    ]) {
      if (/\bkubectl\b/.test(field || ''))
        fail(
          'branding',
          `${owner}: player-facing copy uses kubectl: ${String(field).slice(0, 90)}`
        );
      if (/\boc\s+export\b/.test(field || ''))
        fail('content', `${owner}: oc export was removed in OpenShift 4.x`);
    }
    for (const obj of level.objectives || []) {
      if (obj.kind === 'Namespace')
        fail('model', `${owner}: objective still references retired Namespace kind`);
    }

    // ── Player guidance (per-objective `how`, level `workProject`) ─────────
    // Players got stuck because the commands lived in sequential hints that did not match
    // the objectives and the lab project was only mentioned in hint #1. Authored guidance
    // is replayed in the browser suite (qa-guidance); these static locks keep it typeable.
    const seededProjects = (level.startingResources || [])
      .filter((resource) => resource.kind === 'Project')
      .map((resource) => resource.name);
    // The project the mission card's project row tells the player to switch to.
    const rowProject = Object.prototype.hasOwnProperty.call(level, 'workProject')
      ? level.workProject
      : seededProjects.length === 1
        ? seededProjects[0]
        : null;
    if (Object.prototype.hasOwnProperty.call(level, 'workProject')) {
      const workProject = level.workProject;
      if (
        workProject !== null &&
        (typeof workProject !== 'string' || !seededProjects.includes(workProject))
      )
        fail(
          'guidance',
          `${owner}: workProject must be null or a seeded Project (${seededProjects.join(', ') || 'none'}), got ${JSON.stringify(workProject)}`
        );
      else passed();
    }
    for (const [objectiveIndex, obj] of (level.objectives || []).entries()) {
      if (obj.how === undefined) continue;
      const where = `${owner}: objective ${objectiveIndex + 1} how`;
      const how = obj.how;
      if (!how || typeof how !== 'object' || Array.isArray(how)) {
        fail('guidance', `${where} must be an object { explain, run?, check? }`);
        continue;
      }
      const unknownFields = Object.keys(how).filter(
        (field) => !['explain', 'run', 'check'].includes(field)
      );
      if (unknownFields.length > 0)
        fail('guidance', `${where}: unknown field(s) ${unknownFields.join(', ')}`);
      if (typeof how.explain !== 'string' || how.explain.trim().length < 20)
        fail('guidance', `${where}.explain must be a plain-language sentence`);
      else if (how.explain.length > 420)
        fail(
          'guidance',
          `${where}.explain is ${how.explain.length} chars; keep it to 1–2 sentences`
        );
      if (how.run !== undefined && (!Array.isArray(how.run) || how.run.length === 0))
        fail('guidance', `${where}.run must be a non-empty array of commands (or omitted)`);
      if (how.check !== undefined && typeof how.check !== 'string')
        fail('guidance', `${where}.check must be one command string`);
      const typed = [...(Array.isArray(how.run) ? how.run : []), how.check].filter(
        (command) => command !== undefined
      );
      for (const command of typed) {
        if (
          typeof command !== 'string' ||
          !(
            TYPEABLE_COMMAND_RE.test(command) ||
            SHELL_ASSIGNMENT_RE.test(command) ||
            (isPrelude && PRELUDE_SCRIPT_RE.test(command))
          ) ||
          // A bare `oc`/`helm` is never a step; bare shell words (`pwd`, `id`, `exit`)
          // are real commands (the prelude and the `oc debug` session use them).
          /^(oc|helm)$/.test(command.trim())
        )
          fail(
            'guidance',
            `${where}: "${String(command).slice(0, 60)}" is not a typeable terminal command`
          );
        else if (/<[A-Za-z][\w.-]*>|…|\.\.\./.test(command))
          fail(
            'guidance',
            `${where}: "${command.slice(0, 60)}" contains a placeholder; use the concrete name`
          );
        else if (/[\r\n]/.test(command)) fail('guidance', `${where}: commands must be single-line`);
        else if (rowProject && new RegExp(`^oc project ${rowProject}$`).test(command))
          fail(
            'guidance',
            `${where}: "${command}" repeats the mission card's project row; leave it out of the step`
          );
        else passed();
      }
      for (const text of [how.explain, ...typed]) {
        if (/\bkubectl\b/.test(text || ''))
          fail(
            'branding',
            `${where}: player-facing guidance uses kubectl: ${String(text).slice(0, 80)}`
          );
        if (/\boc\s+export\b/.test(text || ''))
          fail('content', `${where}: oc export was removed in OpenShift 4.x`);
      }
      passed();
    }
  }
  const chapters = levelsMod.CHAPTERS || [];
  if (chapters.length !== REQUIRED_CHAPTER_STRUCTURE.length)
    fail(
      'campaign',
      `expected ${REQUIRED_CHAPTER_STRUCTURE.length} chapters (prelude + 5), found ${chapters.length}`
    );
  else {
    for (const [i, chapter] of chapters.entries()) {
      const expected = REQUIRED_CHAPTER_STRUCTURE[i];
      if (chapter.id !== expected.id) fail('campaign', `chapter ${chapter.id} is out of sequence`);
      if (chapter.name !== expected.name)
        fail('campaign', `chapter ${chapter.id} name "${chapter.name}" != "${expected.name}"`);
      if (JSON.stringify(chapter.levels) !== JSON.stringify(expected.levels))
        fail(
          'campaign',
          `chapter ${chapter.id} levels ${JSON.stringify(chapter.levels)} != ${JSON.stringify(expected.levels)}`
        );
      else passed();
      if (Boolean(chapter.prelude) !== (expected.id === PRELUDE_CHAPTER))
        fail('campaign', `chapter ${chapter.id}: only chapter 0 is the prelude`);
      for (const id of chapter.levels || [])
        if (!levelIds.has(id))
          fail('campaign', `chapter ${chapter.id} references unknown level ${id}`);
    }
  }

  // Progress safety + display numbers (1.16.0). Saved progress is keyed by id, so
  // these helpers are the only place order/unlock/labels may be derived from.
  const campaignApi = levelsMod;
  for (const name of [
    'CAMPAIGN_ORDER',
    'EX280_ORDER',
    'PRELUDE_ORDER',
    'continueLevelId',
    'isLevelUnlocked',
    'isCampaignComplete',
    'levelLabel',
    'levelOrdinal',
    'previousLevelId',
    'isPreludeLevel',
    'getCampaignLevel',
  ]) {
    if (campaignApi[name] === undefined)
      fail('campaign', `CampaignLevels.js must export ${name} (order/unlock/label helper)`);
    else passed();
  }
  if (typeof campaignApi.levelLabel === 'function') {
    const labelChecks = [
      [1, '1'],
      [19, '19'],
      [21, '20'],
      [22, '21'],
      [20, '22'],
      [101, '0.1'],
      [107, '0.7'],
    ];
    for (const [id, label] of labelChecks) {
      if (campaignApi.levelLabel(id) !== label)
        fail(
          'campaign',
          `levelLabel(${id}) should be "${label}", got "${campaignApi.levelLabel(id)}"`
        );
      else passed();
    }
  }
  if (typeof campaignApi.isLevelUnlocked === 'function') {
    const done = (ids) => Object.fromEntries(ids.map((id) => [String(id), { completed: true }]));
    const unlockChecks = [
      // Level 1 and the first prelude level are always open; the prelude never gates Level 1.
      ['L1 is open for a new player', campaignApi.isLevelUnlocked(1, {}), true],
      ['L0.1 is open for a new player', campaignApi.isLevelUnlocked(101, {}), true],
      ['L0.2 is locked for a new player', campaignApi.isLevelUnlocked(102, {}), false],
      // The capstone now follows the new levels 21/22 ...
      [
        'capstone is locked after L19 until 21/22 are done',
        campaignApi.isLevelUnlocked(20, done([...Array(19).keys()].map((n) => n + 1))),
        false,
      ],
      [
        'level 21 opens after L19',
        campaignApi.isLevelUnlocked(21, done([...Array(19).keys()].map((n) => n + 1))),
        true,
      ],
      // ... but a player who finished the old 20-level campaign keeps the capstone open.
      [
        'a completed capstone never re-locks',
        campaignApi.isLevelUnlocked(20, done([...Array(20).keys()].map((n) => n + 1))),
        true,
      ],
      ['an unknown id is never unlocked', campaignApi.isLevelUnlocked(999, {}), false],
    ];
    for (const [name, actual, expected] of unlockChecks) {
      if (actual !== expected) fail('campaign', `unlock rule: ${name} (got ${actual})`);
      else passed();
    }
  }
  if (typeof campaignApi.continueLevelId === 'function') {
    const at = (ids, stamp = 0) =>
      Object.fromEntries(
        ids.map((id, index) => [String(id), { completed: true, completedAt: stamp + index }])
      );
    const continueChecks = [
      ['a new player starts with the Linux prelude', campaignApi.continueLevelId({}), 101],
      [
        'a returning EX280 player continues the EX280 track',
        campaignApi.continueLevelId(at([1, 2, 3, 4, 5, 6, 7, 8])),
        9,
      ],
      [
        'finishing the prelude continues at Level 1',
        campaignApi.continueLevelId(at(REQUIRED_PRELUDE_ORDER)),
        1,
      ],
      [
        'the old 20-level save continues at the new level 21',
        campaignApi.continueLevelId(at([...Array(20).keys()].map((n) => n + 1))),
        21,
      ],
    ];
    for (const [name, actual, expected] of continueChecks) {
      if (actual !== expected)
        fail('campaign', `continue rule: ${name} (expected ${expected}, got ${actual})`);
      else passed();
    }
  }
  // Every launcher uses the helpers: no `levelId - 1` unlocking survives.
  for (const rel of [
    'index.html',
    'js/modes/CampaignMode.js',
    'js/ui/StartMenu.js',
    'js/engine/ScoringEngine.js',
  ]) {
    const src = read(rel);
    if (/campaignProgress\[\s*(?:level\.id|levelId|id)\s*-\s*1\s*\]/.test(src))
      fail('campaign', `${rel}: unlocks by "id - 1"; use isLevelUnlocked() from CampaignLevels.js`);
    else passed();
  }
  if (/\(level\.chapter \|\| 1\)/.test(read('index.html')))
    fail('campaign', 'index.html: `level.chapter || 1` folds the chapter-0 prelude into chapter 1');
  note(`Campaign: ${levels.length} levels, ${chapters.length} chapters`);
} else {
  fail('campaign', 'js/data/CampaignLevels.js missing or has no CAMPAIGN_LEVELS');
}

// ── 5L. Linux & RHEL Foundations levels (1.16.0) ───────────────────────────
// Prelude-specific locks for js/data/LinuxLevels.js (levels 101–107). §5 checks the campaign
// structure; this block keeps the RHEL content honest: verified RHEL 9 docs pages, a seed for the
// simulated workstation, graded objective types, every command taught before it is used (the
// chapter never jumps ahead), `sudo` exactly where real RHEL needs root, inspect objectives that
// their own how-to ticks, and the L102 log fixture the grep lessons depend on. The how-to
// commands themselves are replayed in the browser (qa-guidance-replay, qa-linux-levels).
{
  const linuxMod = await tryImport('js/data/LinuxLevels.js');
  const LINUX = linuxMod?.LINUX_LEVELS || [];
  const PRELUDE_TITLES = {
    101: 'The Shell & the Filesystem',
    102: 'Read, Search & Pipe Text',
    103: 'Edit Files & the Shell Environment',
    104: 'Users, Permissions & SELinux',
    105: 'Processes, Services & Logs',
    106: 'Networking & the Firewall',
    107: 'Packages & Containers',
  };
  // RHEL 9 pages checked against the docs source (enterprise-docs rhel-9 titles and assembly ids,
  // 2026-11-08). docs.redhat.com URLs: /html/<title>/index or /html/<title>/<assembly-id>_<context>.
  const RHEL9 = 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/';
  const VERIFIED_RHEL_DOCS = new Set(
    [
      'configuring_basic_system_settings/index',
      'configuring_basic_system_settings/assembly_troubleshooting-problems-using-log-files_configuring-basic-system-settings',
      'configuring_basic_system_settings/managing-file-system-permissions_configuring-basic-system-settings',
      'configuring_basic_system_settings/managing-sudo-access_configuring-basic-system-settings',
      'configuring_basic_system_settings/managing-users-and-groups_configuring-basic-system-settings',
      'configuring_basic_system_settings/managing-systemd_configuring-basic-system-settings',
      'configuring_basic_system_settings/configuring-time-synchronization_configuring-basic-system-settings',
      'using_selinux/index',
      'deploying_web_servers_and_reverse_proxies/index',
      'configuring_and_managing_networking/index',
      'configuring_firewalls_and_packet_filters/index',
      'managing_software_with_the_dnf_tool/index',
      'building_running_and_managing_containers/index',
    ].map((page) => `${RHEL9}${page}`)
  );
  // Objective types graded from the simulated workstation (LinuxHost) plus `command` for the few
  // inspect steps. OpenShift-only types (deploy, route, …) make no sense on the workstation.
  const LINUX_OBJECTIVE_TYPES = new Set([
    'file',
    'service',
    'process',
    'package',
    'firewall',
    'container',
    'selinux',
    'linuxuser',
    'cwd',
    'env',
    'ran',
    'command',
  ]);
  // The level that introduces each command: a how-to may use a command from that level on, never
  // before (the chapter must not use a concept it has not taught yet). `script` = a script run by
  // name (needs the execute bit, taught with chmod in 0.4).
  const TAUGHT_IN = {
    pwd: 101,
    ls: 101,
    cd: 101,
    mkdir: 101,
    cp: 101,
    mv: 101,
    rm: 101,
    rmdir: 101,
    touch: 101,
    cat: 101,
    echo: 101,
    head: 102,
    tail: 102,
    less: 102,
    grep: 102,
    wc: 102,
    sort: 102,
    uniq: 102,
    cut: 102,
    printf: 103,
    sed: 103,
    tee: 103,
    vim: 103,
    vi: 103,
    export: 103,
    source: 103,
    env: 103,
    printenv: 103,
    bash: 103,
    assignment: 103,
    whoami: 104,
    id: 104,
    groups: 104,
    sudo: 104,
    chmod: 104,
    chown: 104,
    chgrp: 104,
    getenforce: 104,
    sestatus: 104,
    restorecon: 104,
    script: 104,
    ps: 105,
    top: 105,
    pgrep: 105,
    pkill: 105,
    kill: 105,
    systemctl: 105,
    journalctl: 105,
    timedatectl: 105,
    ip: 106,
    hostname: 106,
    ss: 106,
    ping: 106,
    dig: 106,
    host: 106,
    nslookup: 106,
    getent: 106,
    curl: 106,
    'firewall-cmd': 106,
    dnf: 107,
    rpm: 107,
    podman: 107,
    skopeo: 107,
    oc: 107,
  };
  /**
   * Every simple command of one how-to line: pipeline stages, `;`/`&&`/`||` segments and `$(…)`
   * substitutions (which run), but nothing inside single quotes (literal text, e.g. a script body
   * written with printf). `sudo` is reported as a flag on the command it wraps.
   */
  const simpleCommands = (line) => {
    const subs = [];
    let text = String(line).replace(/'[^']*'/g, "'Q'");
    text = text.replace(/\$\(([^()]*)\)/g, (_, inner) => {
      subs.push(inner);
      return 'SUBST';
    });
    text = text.replace(/"[^"]*"/g, '"Q"');
    const out = [];
    for (const part of [text, ...subs]) {
      for (const segment of part.split(/\|\||&&|[|;]/)) {
        const words = segment.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) continue;
        // `NAME=value` (a shell variable, taught with the environment in 0.3); the `$(…)` it
        // may hold is checked as its own command above.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
          out.push({ name: 'assignment', args: words.slice(1), sudo: false, raw: segment.trim() });
          continue;
        }
        const sudo = words[0] === 'sudo';
        if (sudo) words.shift();
        out.push({ name: words[0] || '', args: words.slice(1), sudo, raw: segment.trim() });
      }
    }
    return out;
  };
  /** Commands that need root on RHEL 9 (true) — a how-to must run them with sudo. */
  const needsRoot = ({ name, args }) => {
    const joined = args.join(' ');
    if (name === 'firewall-cmd')
      return /--(add|remove|reload|permanent|runtime-to-permanent|set|new|delete)/.test(joined);
    if (name === 'dnf')
      return /^(install|remove|erase|upgrade|update|reinstall|downgrade|autoremove)\b/.test(joined);
    if (name === 'systemctl')
      return /^(start|stop|restart|reload|try-restart|enable|disable|mask|unmask|daemon-reload|isolate)\b/.test(
        joined
      );
    if (
      ['restorecon', 'semanage', 'setenforce', 'chcon', 'useradd', 'usermod', 'groupadd'].includes(
        name
      )
    )
      return true;
    if (name === 'chown') return true;
    // Writing a file outside the home directory and /tmp (in-place edit or tee).
    if ((name === 'sed' && /(^|\s)-i\b/.test(joined)) || name === 'tee')
      return args.some((arg) => /^\/(etc|var|srv|usr|opt)\//.test(arg));
    return false;
  };

  if (!linuxMod) fail('linux-levels', 'js/data/LinuxLevels.js missing or failed to import');
  else if (LINUX.length !== 7)
    fail('linux-levels', `LINUX_LEVELS must hold the 7 prelude levels, found ${LINUX.length}`);
  else passed();
  const ids = LINUX.map((level) => level.id);
  if (JSON.stringify(ids) !== JSON.stringify([101, 102, 103, 104, 105, 106, 107]))
    fail('linux-levels', `LINUX_LEVELS ids must be 101..107 in order, got ${ids.join(',')}`);
  else passed();
  const campaignIds = (levelsMod?.CAMPAIGN_LEVELS || []).map((level) => level.id);
  if (JSON.stringify(campaignIds.slice(0, 7)) !== JSON.stringify(ids))
    fail('linux-levels', 'CAMPAIGN_LEVELS must start with the LINUX_LEVELS prelude');
  else passed();

  for (const level of LINUX) {
    const owner = `prelude ${level.id} (${level.title})`;
    if (level.title !== PRELUDE_TITLES[level.id])
      fail('linux-levels', `${owner}: title must be "${PRELUDE_TITLES[level.id]}"`);
    if (level.chapter !== 0 || level.chapterName !== 'Linux & RHEL Foundations')
      fail('linux-levels', `${owner}: chapter 0 / "Linux & RHEL Foundations" expected`);
    else passed();
    const sentences = String(level.description || '')
      .split(/[.!?](?:\s|$)/)
      .filter((s) => s.trim());
    if (!level.description || sentences.length > 3 || level.description.length > 400)
      fail(
        'linux-levels',
        `${owner}: description must be plain and short (≤ 3 sentences, ≤ 400 chars; got ${sentences.length}/${String(level.description || '').length})`
      );
    else passed();
    for (const url of level.docsLinks || []) {
      if (!VERIFIED_RHEL_DOCS.has(url))
        fail('linux-levels', `${owner}: docsLink is not a verified RHEL 9 docs page: ${url}`);
      else passed();
    }
    if (level.workProject !== null)
      fail(
        'linux-levels',
        `${owner}: workProject must be null (no lab project on the workstation)`
      );
    if (Array.isArray(level.incidents) && level.incidents.length > 0)
      fail('linux-levels', `${owner}: prelude levels have no cluster incidents`);
    if ((level.availableResources || []).length > 0)
      fail('linux-levels', `${owner}: no palette resources on the workstation`);
    for (const resource of level.startingResources || []) {
      if (resource.kind !== 'Node')
        fail(
          'linux-levels',
          `${owner}: only Nodes (3D backdrop) may be seeded, got ${resource.kind}`
        );
    }
    // The workstation seed (js/engine/LinuxHost.js reset()).
    const seed = level.linuxHost;
    if (!seed || typeof seed !== 'object' || Array.isArray(seed))
      fail('linux-levels', `${owner}: linuxHost seed object missing`);
    else {
      if (seed.cwd !== undefined && !String(seed.cwd).startsWith('/'))
        fail('linux-levels', `${owner}: linuxHost.cwd must be absolute`);
      for (const file of seed.files || []) {
        if (!String(file.path || '').startsWith('/'))
          fail('linux-levels', `${owner}: seed file path must be absolute: ${file.path}`);
        else if (typeof file.content === 'string' && file.content && !file.content.endsWith('\n'))
          fail('linux-levels', `${owner}: seed text file must end with a newline: ${file.path}`);
        else passed();
        if (file.mode !== undefined && !/^0?[0-7]{3,4}$/.test(String(file.mode)))
          fail('linux-levels', `${owner}: seed file mode is not octal: ${file.path} ${file.mode}`);
      }
    }
    const objectives = level.objectives || [];
    if (objectives.length < 4 || objectives.length > 6)
      fail('linux-levels', `${owner}: 4–6 objectives expected, got ${objectives.length}`);
    else passed();
    for (const [index, objective] of objectives.entries()) {
      const where = `${owner}: objective ${index + 1}`;
      const type = String(objective.type || '').toLowerCase();
      if (!LINUX_OBJECTIVE_TYPES.has(type))
        fail(
          'linux-levels',
          `${where}: type "${objective.type}" is not a workstation objective type`
        );
      else if (implementedTypes.size && !implementedTypes.has(type))
        fail(
          'linux-levels',
          `${where}: type "${objective.type}" not implemented in ObjectiveEvaluator`
        );
      else passed();
      for (const field of ['path', ...(objective.all || []).map((_, i) => `all.${i}.path`)]) {
        const value =
          field === 'path' ? objective.path : objective.all[Number(field.split('.')[1])].path;
        if (value !== undefined && !String(value).startsWith('/'))
          fail('linux-levels', `${where}: ${field} must be absolute, got ${value}`);
      }
      if (!objective.how || typeof objective.how.explain !== 'string')
        fail('linux-levels', `${where}: every prelude objective needs a how-to`);
      else passed();
      const run = objective.how?.run || [];
      if (type !== 'command' && run.length === 0)
        fail('linux-levels', `${where}: a state objective must show the commands that reach it`);
      if (type === 'command') {
        let regex = null;
        try {
          regex = new RegExp(objective.pattern, 'i');
        } catch (error) {
          fail('linux-levels', `${where}: pattern does not compile: ${error.message}`);
        }
        // An inspect objective must be ticked by its own how-to (successful commands only).
        if (regex && !run.some((command) => regex.test(command)))
          fail(
            'linux-levels',
            `${where}: no how.run command matches its pattern ${objective.pattern}`
          );
        else if (regex) passed();
      }
      for (const line of [...run, ...(objective.how?.check ? [objective.how.check] : [])]) {
        // The prelude never drives the cluster with oc (taught from Level 1); the one exception
        // is 0.7 checking the freshly installed CLI, the hand-over to Level 1.
        if (/^\s*oc\s/.test(line) && !(level.id === 107 && line === 'oc version --client'))
          fail(
            'linux-levels',
            `${where}: "${line}" — the prelude never runs oc (taught from Level 1)`
          );
        if (/^\s*sudo\b[^|]*>{1,2}\s*\/(etc|var|srv|usr|opt)\//.test(line))
          fail(
            'linux-levels',
            `${where}: "${line}" — the redirect runs as student, not root; use \`| sudo tee\``
          );
        for (const command of simpleCommands(line)) {
          const key = /\.sh$/.test(command.name) ? 'script' : command.name;
          const taught = TAUGHT_IN[key];
          if (taught === undefined)
            fail(
              'linux-levels',
              `${where}: "${command.name}" is not in TAUGHT_IN (which level teaches it?)`
            );
          else if (taught > level.id)
            fail(
              'linux-levels',
              `${where}: "${command.name}" is used before level ${taught} teaches it`
            );
          else passed();
          if (command.sudo && TAUGHT_IN.sudo > level.id)
            fail(
              'linux-levels',
              `${where}: sudo is used before level ${TAUGHT_IN.sudo} teaches it`
            );
          if (needsRoot(command) && !command.sudo)
            fail('linux-levels', `${where}: "${command.raw}" needs root on RHEL — prefix sudo`);
          if (command.sudo && command.name === 'podman')
            fail(
              'linux-levels',
              `${where}: podman runs rootless as student (sudo podman uses root's storage)`
            );
        }
      }
    }
    const hints = level.hints || [];
    if (hints.length < 3 || !hints.every((hint) => /`[^`]+`/.test(hint)))
      fail('linux-levels', `${owner}: 3+ hints, each with a \`command\` in backticks`);
    else passed();
    const copy = [
      level.description,
      ...hints,
      ...objectives.map((objective) => `${objective.label} ${objective.how?.explain || ''}`),
    ].join(' ');
    if (!/OpenShift|\boc\b|\bPods?\b|cluster|\bnode\b/.test(copy))
      fail('linux-levels', `${owner}: say why the skill matters for OpenShift work`);
    else passed();
  }
  // The prelude hands over to the EX280 track.
  const last = LINUX[LINUX.length - 1];
  if (last && last.nextLevel !== 1)
    fail('linux-levels', '0.7 must point to Level 1 (nextLevel: 1)');
  else if (last) passed();

  // L102 log fixture: single-space fields (cut -d' ' -f3 is the Pod), exactly the counts the
  // objectives expect, and the `grep -i error` trap (a WARN line that says "error").
  const fixtures = linuxMod?.LINUX_LEVEL_FIXTURES;
  const l102 = LINUX.find((level) => level.id === 102);
  if (!fixtures || !l102) fail('linux-levels', 'LINUX_LEVEL_FIXTURES / level 102 missing');
  else {
    const lines = fixtures.shopLog.replace(/\n$/, '').split('\n');
    const malformed = lines.filter(
      (line) => !/^\S+Z (INFO|WARN|ERROR) [a-z0-9-]+ \S/.test(line) || /\s{2}/.test(line)
    );
    if (malformed.length) fail('linux-levels', `shop.log has malformed lines: ${malformed[0]}`);
    else passed();
    const errorLines = lines.filter((line) => line.split(' ')[1] === 'ERROR');
    const objectiveFor = (path) => l102.objectives.find((objective) => objective.path === path);
    const logs = '/home/student/ex280/logs';
    const checks = [
      [objectiveFor(`${logs}/errors.txt`)?.equals, `${errorLines.join('\n')}\n`, 'errors.txt'],
      [
        objectiveFor(`${logs}/summary.txt`)?.equals,
        `${errorLines.length}\n${lines.filter((line) => line.split(' ')[1] === 'WARN').length}\n`,
        'summary.txt',
      ],
      [
        JSON.stringify(objectiveFor(`${logs}/failing-pods.txt`)?.lineSet),
        JSON.stringify([...new Set(errorLines.map((line) => line.split(' ')[2]))].sort()),
        'failing-pods.txt',
      ],
    ];
    for (const [actual, expected, name] of checks) {
      if (actual !== expected)
        fail('linux-levels', `L102 ${name} expectation does not match the seeded shop.log`);
      else passed();
    }
    if (!lines.some((line) => line.split(' ')[1] !== 'ERROR' && /error/i.test(line)))
      fail(
        'linux-levels',
        'shop.log lost its `grep -i error` trap (a non-ERROR line saying "error")'
      );
    else passed();
    if (!lines.some((line) => line.includes('/healthz')))
      fail('linux-levels', 'shop.log needs /healthz probe lines for the grep -v lesson');
    else passed();
  }
  note(
    `Linux prelude: ${LINUX.length} levels, ${LINUX.reduce((n, l) => n + l.objectives.length, 0)} objectives`
  );
}

// ── 5B. Bridge levels (1.16.0) ─────────────────────────────────────────────
// The campaign used concepts before it taught them: the capstone (id 20) needed a
// router-aware default-deny NetworkPolicy and an `oc debug` → `chroot /host` →
// `systemctl restart kubelet` node repair that no level taught, and L12 installed the
// MetalLB operator through OLM six levels before the Operators level. Levels 21 "Network
// Policies" and 22 "Nodes & Cluster Troubleshooting" (new ids, played 19 → 21 → 22 → 20)
// teach them; L12 uses an operator the platform team installed. These locks keep the
// bridge in place; qa-bridge-levels and qa-guidance-replay play them in the browser.
{
  const bridgeLevel = (id) => levels.find((level) => level.id === id) || null;
  const failBridge = (message) => fail('bridge-levels', message);
  const l12 = bridgeLevel(12);
  const l19 = bridgeLevel(19);
  const l21 = bridgeLevel(21);
  const l22 = bridgeLevel(22);
  const l11 = bridgeLevel(11);
  const files = manifestFilesMod?.MANIFEST_FILES || {};
  const runOf = (objective) => (Array.isArray(objective?.how?.run) ? objective.how.run : []);
  const seededProjects = (level) =>
    (level?.startingResources || []).filter((r) => r.kind === 'Project').map((r) => r.name);

  // Chain: 19 → 21 → 22 → 20 (the capstone stays last).
  if (!l21 || !l22) failBridge('levels 21 and 22 must exist');
  else if (l19?.nextLevel !== 21 || l21.nextLevel !== 22 || l22.nextLevel !== 20)
    failBridge(
      `chain must be 19 → 21 → 22 → 20 (got 19→${l19?.nextLevel}, 21→${l21.nextLevel}, 22→${l22.nextLevel})`
    );
  else passed();
  for (const [level, title] of [
    [l21, 'Network Policies'],
    [l22, 'Nodes & Cluster Troubleshooting'],
  ]) {
    if (!level) continue;
    if (
      level.title !== title ||
      level.chapter !== 5 ||
      level.chapterName !== 'Security & Operations' ||
      ex280Mod?.EX280_LEVEL_TITLES?.[level.id] !== title
    )
      failBridge(`level ${level.id} must be "${title}" in chapter 5 and in EX280_LEVEL_TITLES`);
    else passed();
    // The mission card's project row is derived from the single seeded Project.
    if (seededProjects(level).length !== 1 || Object.hasOwn(level, 'workProject'))
      failBridge(`level ${level.id} must seed exactly one Project and derive its workProject`);
    else passed();
  }

  // L21: graded on reachability state with the proven lab 9/13 + capstone probes.
  if (l21) {
    const objectives21 = l21.objectives || [];
    const probes = objectives21
      .filter((objective) => objective.type === 'networkPolicy')
      .map((objective) => objective.probe);
    for (const probe of ['ingress-isolation', 'dns-egress', 'reach', 'deny', 'deny-external']) {
      if (!probes.includes(probe))
        failBridge(`L21 needs a networkPolicy "${probe}" probe objective`);
      else passed();
    }
    if (
      !objectives21.some(
        (objective) => objective.type === 'routeAccess' && objective.requireIsolation === true
      )
    )
      failBridge('L21 must grade the Route through the router with routeAccess requireIsolation');
    else passed();
    if (objectives21.some((objective) => objective.kind === 'NetworkPolicy'))
      failBridge('L21 must not grade NetworkPolicy object names (behaviour only)');
    else passed();
    const reach = objectives21.find((objective) => objective.probe === 'reach');
    if (reach?.source?.name !== 'frontend' || reach?.to?.name !== 'backend' || reach?.port !== 8080)
      failBridge('L21 reach probe must be frontend → backend on port 8080');
    else passed();
    // Order teaches the path first, then ingress, the router, egress/DNS, the targeted allow.
    const order = objectives21.map((objective) =>
      objective.type === 'networkPolicy' ? objective.probe : objective.type
    );
    const position = (key) => order.indexOf(key);
    if (!(
      position('command') === 0 &&
      position('ingress-isolation') < position('routeAccess') &&
      position('routeAccess') < position('dns-egress') &&
      position('dns-egress') < position('reach')
    ))
      failBridge(
        `L21 objective order must teach path → deny ingress → router → DNS → targeted allow (got ${order.join(', ')})`
      );
    else passed();
    for (const mapping of [
      'Configure network security > Configure application network policies',
      'Configure network security > Control cluster network ingress',
    ]) {
      if (!(l21.examObjectives || []).includes(mapping)) failBridge(`L21 must map "${mapping}"`);
      else passed();
    }
    if (!(l21.docsLinks || []).some((url) => /\/network_security\/network-policy$/.test(url)))
      failBridge('L21 must link the OCP 4.22 network-policy docs page');
    else passed();
    const frontend = (l21.startingResources || []).find(
      (resource) => resource.kind === 'Deployment' && resource.name === 'frontend'
    );
    // The level execs curl/nslookup in frontend: hello-openshift has no shell or curl.
    const frontendImage = frontend?.spec?.template?.spec?.containers?.[0]?.image || '';
    if (!/^registry\.access\.redhat\.com\/ubi9\//.test(frontendImage))
      failBridge(`L21 frontend must run a UBI image that ships curl (got ${frontendImage})`);
    else passed();
    if (
      !(l21.startingResources || []).some(
        (resource) => resource.kind === 'Route' && resource.name === 'frontend'
      )
    )
      failBridge('L21 must seed the Route frontend the router policy is about');
    else passed();
    // Docs-verbatim policies + the starter the player adapts.
    const policy = (name) => String(files[name] || '');
    const checksFiles = [
      [
        'netpol/deny-by-default.yaml',
        (text) =>
          /name: deny-by-default/.test(text) &&
          /podSelector: \{\}/.test(text) &&
          /ingress: \[\]/.test(text),
      ],
      [
        'netpol/allow-from-openshift-ingress.yaml',
        (text) => /policy-group\.network\.openshift\.io\/ingress: ""/.test(text),
      ],
      [
        'netpol/allow-same-namespace.yaml',
        (text) => /name: allow-same-namespace/.test(text) && /- podSelector: \{\}/.test(text),
      ],
      [
        'netpol/allow-dns.yaml',
        (text) =>
          /kubernetes\.io\/metadata\.name: openshift-dns/.test(text) &&
          /protocol: UDP\s+port: 5353/.test(text) &&
          /protocol: TCP\s+port: 5353/.test(text) &&
          !/port: 53\s*$/m.test(text),
      ],
      ['netpol/deny-all-egress.yaml', (text) => /- Egress/.test(text) && !/egress:/.test(text)],
      [
        'netpol/allow-frontend-to-backend.yaml',
        (text) => /app: SOURCE-APP/.test(text) && /app: TARGET-APP/.test(text),
      ],
    ];
    for (const [name, check] of checksFiles) {
      if (!(l21.manifestFiles || []).includes(name) || !check(policy(name)))
        failBridge(`L21 manifest ${name} is missing or lost its documented shape`);
      else passed();
    }
    if (
      !objectives21.some((objective) =>
        runOf(objective).some((command) =>
          /SOURCE-APP.*TARGET-APP.*netpol\/allow-frontend-to-backend\.yaml \| oc apply -f -/.test(
            command
          )
        )
      )
    )
      failBridge('L21 how-to must adapt the starter policy (the player writes/adapts one policy)');
    else passed();
  }

  // L22: node maintenance graded on Node state; the incident fixed from a debug shell.
  if (l22) {
    const objectives22 = l22.objectives || [];
    const nodes = (l22.startingResources || []).filter((resource) => resource.kind === 'Node');
    if (nodes.length !== 3) failBridge('L22 must seed 3 nodes (two workers and master-0)');
    else passed();
    const incident = (l22.incidents || []).find((entry) => entry.type === 'NodeNotReady');
    if (!incident || incident.target !== 'worker-1' || !(incident.triggerTime >= 60))
      failBridge('L22 must schedule NodeNotReady on worker-1 after the maintenance part');
    else passed();
    const nodeObjectives = objectives22.filter((objective) => objective.type === 'node');
    if (
      !nodeObjectives.some(
        (objective) => objective.drained === true && objective.workloadsAvailable === true
      ) ||
      !nodeObjectives.some(
        (objective) => objective.drained === true && objective.schedulable === true
      )
    )
      failBridge(
        'L22 must grade drained (+ workload available) and uncordoned-after-drain node state'
      );
    else passed();
    if (!implementedTypes.has('node'))
      failBridge('ObjectiveEvaluator must implement the `node` type');
    else passed();
    const drain =
      objectives22.flatMap(runOf).find((command) => /^oc adm drain /.test(command)) || '';
    if (!/--ignore-daemonsets/.test(drain) || !/--delete-emptydir-data/.test(drain))
      failBridge(`L22 drain must use --ignore-daemonsets --delete-emptydir-data (got "${drain}")`);
    else passed();
    const fix = objectives22.find(
      (objective) => objective.type === 'resolve' && objective.incidentType === 'NodeNotReady'
    );
    const fixRun = runOf(fix);
    const debugAt = fixRun.indexOf('oc debug node/worker-1');
    const chrootAt = fixRun.indexOf('chroot /host');
    const restartAt = fixRun.indexOf('systemctl restart kubelet');
    if (
      !(debugAt >= 0 && debugAt < chrootAt && chrootAt < restartAt) ||
      !fixRun.includes('journalctl -u kubelet') ||
      fixRun.slice(-2).join('|') !== 'exit|exit'
    )
      failBridge(
        'L22 must teach the interactive repair: oc debug node → chroot /host → systemctl/journalctl → restart kubelet → exit twice'
      );
    else passed();
    const inspections = objectives22.filter((objective) => objective.type === 'command');
    if (inspections.length < 4 || !inspections.every((objective) => objective.inspect === true))
      failBridge(
        'L22 inspection steps must be `inspect` command objectives (a read that showed something)'
      );
    else passed();
    for (const pattern of [
      /oc get nodes/,
      /oc adm top nodes/,
      /oc describe node /,
      /oc get clusteroperators/,
    ]) {
      if (
        !inspections.some((objective) => runOf(objective).some((command) => pattern.test(command)))
      )
        failBridge(`L22 inspection how-tos must include ${pattern}`);
      else passed();
    }
  }

  // L12: MetalLB pre-installed; the player verifies it and configures the operand.
  if (l12) {
    const seeded = l12.startingResources || [];
    const subscription = seeded.find((resource) => resource.kind === 'Subscription');
    const operatorGroup = seeded.find((resource) => resource.kind === 'OperatorGroup');
    if (
      JSON.stringify(seededProjects(l12)) !== '["lb-lab","metallb-system"]' ||
      l12.workProject !== 'lb-lab' ||
      subscription?.namespace !== 'metallb-system' ||
      subscription?.spec?.name !== 'metallb-operator' ||
      // A real Subscription names its package in spec.name; there is no spec.packageName.
      Object.hasOwn(subscription?.spec || {}, 'packageName') ||
      subscription?.spec?.channel !== 'stable' ||
      operatorGroup?.namespace !== 'metallb-system'
    )
      failBridge(
        'L12 must seed metallb-system + its OperatorGroup and a real metallb-operator Subscription (spec.name, no spec.packageName), workProject lb-lab'
      );
    else passed();
    if (
      seeded.some(
        (resource) =>
          ['Deployment', 'Service'].includes(resource.kind) && resource.namespace !== 'lb-lab'
      )
    )
      failBridge('L12 seeds 2 Projects, so its Deployment/Service must name lb-lab explicitly');
    else passed();
    const objectives12 = l12.objectives || [];
    if (objectives12.some((objective) => objective.type === 'operator'))
      failBridge('L12 must not grade an operator install (taught in the Operators level)');
    else passed();
    if (
      objectives12
        .flatMap(runOf)
        .some((command) =>
          /subscription\.yaml|operatorgroup\.yaml|create namespace metallb-system|new-project metallb-system/.test(
            command
          )
        )
    )
      failBridge('L12 how-tos must not install the operator');
    else passed();
    if ((l12.examObjectives || []).some((entry) => /Install an operator/.test(entry)))
      failBridge('L12 must not map "Install an operator"');
    else passed();
    const verify = objectives12.find(
      (objective) => objective.type === 'command' && objective.namespace === 'metallb-system'
    );
    if (verify?.inspect !== true || verify?.outputPattern !== 'Succeeded')
      failBridge(
        'L12 must grade reading the Succeeded CSV in metallb-system (inspect + outputPattern)'
      );
    else passed();
    if (
      objectives12.some(
        (objective) =>
          ['route', 'tls', 'serviceType'].includes(objective.type) &&
          objective.namespace !== 'lb-lab'
      )
    )
      failBridge('L12 route/tls/serviceType objectives must be graded in lb-lab explicitly');
    else passed();
    for (const kind of ['MetalLB', 'IPAddressPool', 'L2Advertisement']) {
      if (
        !objectives12.some(
          (objective) =>
            objective.type === 'deploy' &&
            objective.kind === kind &&
            objective.namespace === 'metallb-system'
        )
      )
        failBridge(`L12 must grade the ${kind} configuration in metallb-system`);
      else passed();
    }
  }

  // L11: the edge Route serves the openssl certificate it teaches.
  if (l11) {
    const objectives11 = l11.objectives || [];
    const secretAt = objectives11.findIndex(
      (objective) => objective.kind === 'Secret' && objective.name === 'web-tls'
    );
    const routeAt = objectives11.findIndex((objective) => objective.type === 'route');
    const tls = objectives11.find((objective) => objective.type === 'tls');
    if (
      !(secretAt >= 0 && secretAt < routeAt) ||
      !runOf(objectives11[routeAt]).some((command) =>
        /--cert=tls\.crt --key=tls\.key/.test(command)
      ) ||
      tls?.certificate !== true
    )
      failBridge(
        'L11 must create the certificate before the Route and grade an edge Route that serves it'
      );
    else passed();
  }

  // EX280 mapping: the levels list the bullets they drill, and the bullets list them back.
  const bullets = (ex280Mod?.EX280_OBJECTIVE_GROUPS || []).flatMap((group) =>
    (group.bullets || []).map((bullet) => ({ ...bullet, group: group.title }))
  );
  const bulletById = (id) => bullets.find((bullet) => bullet.id === id);
  if (JSON.stringify(bulletById('ops-install')?.levels) !== '[18]')
    failBridge('ops-install must map only L18 (L12 no longer installs an operator)');
  else passed();
  for (const level of [l12, l21, l22].filter(Boolean)) {
    const fromLevel = new Set(level.examObjectives || []);
    const fromBullets = new Set(
      bullets
        .filter((bullet) => (bullet.levels || []).includes(level.id))
        .map((bullet) => `${bullet.group} > ${bullet.title}`)
    );
    const missing = [...fromLevel].filter((entry) => !fromBullets.has(entry));
    const extra = [...fromBullets].filter((entry) => !fromLevel.has(entry));
    if (missing.length || extra.length)
      failBridge(
        `level ${level.id} examObjectives and EX280 bullet levels disagree (bullets missing the level: ${missing.join('; ') || '-'}; bullets listing it without the level naming them: ${extra.join('; ') || '-'})`
      );
    else passed();
  }
  if ((bulletById('net-troubleshoot-sdn')?.levels || []).includes(3))
    failBridge('net-troubleshoot-sdn must not list L3 (no networking content)');
  else passed();
  if ((bulletById('selfservice-project-templates')?.levels || []).includes(8))
    failBridge(
      'selfservice-project-templates must not list L8 (app templates, not project templates)'
    );
  else passed();

  // The `node` objective explains the missing maintenance step (cordon/drain/uncordon).
  const evaluatorSrc = read('js/engine/ObjectiveEvaluator.js');
  if (
    !/function evaluateNode\(/.test(evaluatorSrc) ||
    !/case 'node':\s*return evaluateNode\(obj, c\)/.test(evaluatorSrc) ||
    !/if \(type === 'node'\) return explainNode\(objective, c\)/.test(evaluatorSrc)
  )
    failBridge('ObjectiveEvaluator must evaluate and explain the `node` objective type');
  else passed();
  note(
    'Bridge levels: 21 Network Policies, 22 Nodes & Cluster Troubleshooting, L12 MetalLB pre-installed'
  );
}

// ── Challenges ─────────────────────────────────────────────────────────────
const REQUIRED_CHALLENGE_TITLES = [
  'Three-Tier App',
  'Fix CrashLoopBackOff',
  'Route with Edge TLS',
  'Kustomize Prod Overlay',
  'Build & Deploy from Source',
  'Quota Guardrail',
  'RBAC for a New Teammate',
  'SCC for a Privileged Workload',
  'Network Isolation',
  'Install an Operator',
  'HTPasswd Onboarding',
  'EX280 Speed Run',
  'Production Network Policies',
];
const challengeIds = new Set();
const challenges = challengesMod?.CHALLENGES || [];
if (challenges.length) {
  if (challenges.length !== 13)
    fail('challenges', `expected 13 challenges, found ${challenges.length}`);
  else passed();
  for (const [i, challenge] of challenges.entries()) {
    const owner = `challenge ${challenge.id} (${challenge.title})`;
    challengeIds.add(challenge.id);
    if (challenge.id !== i + 1) fail('challenges', `${owner}: ids must be sequential`);
    if (challenge.title !== REQUIRED_CHALLENGE_TITLES[i])
      fail('challenges', `${owner}: title differs from spec "${REQUIRED_CHALLENGE_TITLES[i]}"`);
    if (!challenge.description) fail('challenges', `${owner}: missing description`);
    if (!(Number(challenge.timeLimit) >= 180 && Number(challenge.timeLimit) <= 420)) {
      fail('challenges', `${owner}: timeLimit ${challenge.timeLimit} outside 180..420s`);
    }
    if (!Array.isArray(challenge.objectives) || challenge.objectives.length < 1)
      fail('challenges', `${owner}: no objectives`);
    for (const obj of challenge.objectives || []) checkObjective(owner, obj);
    if (!Array.isArray(challenge.startingResources) || challenge.startingResources.length === 0)
      fail('challenges', `${owner}: no startingResources`);
    for (const res of challenge.startingResources || []) {
      if (registryKinds.size && !registryKinds.has(res.kind))
        fail('challenges', `${owner}: unknown startingResource kind ${res.kind}`);
    }
    if (!Array.isArray(challenge.availableResources) || challenge.availableResources.length === 0)
      fail('challenges', `${owner}: no availableResources`);
    for (const kind of challenge.availableResources || []) {
      if (registryKinds.size && !registryKinds.has(kind))
        fail('challenges', `${owner}: unknown availableResource ${kind}`);
    }
    if (!Array.isArray(challenge.hints) || challenge.hints.length < 2)
      fail('challenges', `${owner}: needs 2+ hints`);
    for (const hint of challenge.hints || []) {
      if (/\bkubectl\b/.test(hint))
        fail('branding', `${owner}: hint uses kubectl: ${hint.slice(0, 90)}`);
    }
    for (const inc of challenge.preloadIncidents || []) {
      if (incidentNames.size && !incidentNames.has(inc.type))
        fail('challenges', `${owner}: unknown incident ${inc.type}`);
    }
    for (const obj of challenge.objectives || []) {
      if (obj.kind === 'Namespace')
        fail('model', `${owner}: objective still references retired Namespace kind`);
    }
  }
  note(`Challenges: ${challenges.length}`);
} else {
  fail('challenges', 'js/modes/ChallengeMode.js missing or has no CHALLENGES');
}
if (challengesMod?.ChallengeMode) {
  if (typeof challengesMod.ChallengeMode.prototype?.startChallenge !== 'function')
    fail('challenges', 'ChallengeMode.startChallenge() is missing');
  if (typeof challengesMod.ChallengeMode.prototype?.getStatus !== 'function')
    fail('challenges', 'ChallengeMode.getStatus() is missing');
} else {
  fail('challenges', 'ChallengeMode class is not exported');
}

// ── Incidents referenced by levels/challenges ──────────────────────────────
for (const level of levels) {
  for (const inc of level.incidents || []) {
    if (!incidentNames.has(inc.type))
      fail('campaign', `level ${level.id}: unknown incident ${inc.type}`);
  }
}
for (const challenge of challenges) {
  for (const inc of challenge.preloadIncidents || []) {
    if (!incidentNames.has(inc.type))
      fail('challenges', `challenge ${challenge.id}: unknown incident ${inc.type}`);
  }
}

// ── Issue #37/#38/#39/#40/#42 regression invariants (QA round 1.3.0) ───────
// Behaviour is covered by the browser suite; these static locks fail fast if a
// future content/config edit reintroduces the regression the issue reported.
{
  const l20Def = levels.find((level) => level.id === 20);
  const l20Objectives = l20Def?.objectives || [];
  const stateQuota = l20Objectives.find((obj) => obj.type === 'quota');
  const stateLimit = l20Objectives.find((obj) => obj.type === 'limitRange');
  const stateDeny = l20Objectives.find((obj) => obj.type === 'networkPolicy');
  const stateRouteAccess = l20Objectives.find((obj) => obj.type === 'routeAccess');
  const gradesState =
    stateQuota?.namespace === 'prod-platform' &&
    !stateQuota?.name &&
    stateLimit?.namespace === 'prod-platform' &&
    !stateLimit?.name &&
    stateDeny?.probe === 'ingress-isolation' &&
    stateDeny?.namespace === 'prod-platform';
  if (gradesState) passed();
  else
    fail(
      'campaign',
      '#37: L20 quota/limitRange objectives must grade prod-platform state without hidden object names, and default-deny must use the ingress-isolation probe'
    );
  if (stateRouteAccess?.requireIsolation === true) passed();
  else fail('campaign', '#37: L20 routeAccess objective must set requireIsolation: true');

  // #38: shipped hints must never teach the non-existent create subcommand.
  const hintSets = [
    ...levels.map((level) => level.hints || []),
    ...challenges.map((challenge) => challenge.hints || []),
  ];
  let instructingLimitRange = 0;
  for (const hints of hintSets) {
    for (const hint of hints) {
      let index = hint.indexOf('oc create limitrange');
      while (index >= 0) {
        const before = hint.slice(Math.max(0, index - 60), index);
        if (!/(?:no|not|reject|does not exist|doesn't exist)\b[\s`'"]*$/i.test(before)) {
          instructingLimitRange += 1;
        }
        index = hint.indexOf('oc create limitrange', index + 1);
      }
    }
  }
  if (instructingLimitRange === 0) passed();
  else
    fail(
      'challenges',
      `#38: ${instructingLimitRange} shipped hint(s) still instruct the non-existent "oc create limitrange"`
    );
  const lab6Def = challenges.find((challenge) => challenge.id === 6);
  const lab6TeachesYaml = (lab6Def?.hints || []).some((hint) =>
    /oc apply -f examples\/limitrange\.yaml/.test(hint)
  );
  const lab6MatchesFake = (lab6Def?.objectives || [])
    .filter((obj) => obj.type === 'command')
    .some((obj) => {
      try {
        return new RegExp(obj.pattern, 'i').test(
          'oc create limitrange team-limits --default=cpu=500m'
        );
      } catch {
        return false;
      }
    });
  if (lab6TeachesYaml && !lab6MatchesFake) passed();
  else
    fail(
      'challenges',
      '#38: lab 6 must teach oc apply -f examples/limitrange.yaml and its command objective must not match oc create limitrange'
    );
  if (!/oc create limitrange --/.test(read('README.md'))) passed();
  else fail('docs', '#38: README still shows an oc create limitrange example');

  // #39: the externalCertificate flow ships and references the router RBAC.
  const rbacExample = manifestFilesMod?.MANIFEST_FILES?.['examples/route-external-cert-rbac.yaml'];
  const rbacExampleOk =
    typeof rbacExample === 'string' &&
    /kind: Role\b/.test(rbacExample) &&
    /kind: RoleBinding\b/.test(rbacExample) &&
    /resourceNames: \["webapp-tls"\]/.test(rbacExample) &&
    /name: router\b/.test(rbacExample) &&
    /namespace: openshift-ingress\b/.test(rbacExample) &&
    (l20Def?.manifestFiles || []).includes('examples/route-external-cert-rbac.yaml');
  if (rbacExampleOk) passed();
  else
    fail(
      'manifests',
      '#39: examples/route-external-cert-rbac.yaml must grant the router SA get/list/watch on webapp-tls and be listed in L20 manifestFiles'
    );

  // #40: handover copy must send cluster-admin work to crc/SNO and scope the
  // Developer Sandbox to project work only.
  const indexHtml = read('index.html');
  if (
    /crc console --credentials/.test(indexHtml) &&
    /OpenShift Local/.test(indexHtml) &&
    /project-scoped/i.test(indexHtml)
  ) {
    passed();
  } else {
    fail(
      'handover',
      '#40: handover must document OpenShift Local/crc (crc console --credentials) and mark the Developer Sandbox project-scoped'
    );
  }

  // #42: L17 copy matches the shipped priv-sa, crash seeds inject only
  // APP_MODE, and the kubeadmin password discovery + evidence contracts hold.
  const l17Def = levels.find((level) => level.id === 17);
  if (
    l17Def &&
    !/Create a dedicated ServiceAccount/i.test(l17Def.description || '') &&
    /priv-sa/.test(l17Def.description || '') &&
    (l17Def.startingResources || []).some(
      (resource) => resource.kind === 'ServiceAccount' && resource.name === 'priv-sa'
    )
  ) {
    passed();
  } else {
    fail(
      'campaign',
      '#42: L17 description must describe granting the SCC to the shipped priv-sa ServiceAccount'
    );
  }
  const imageSeedLevels = [levels.find((level) => level.id === 3), l20Def];
  const imageSeeds = imageSeedLevels.some((level) =>
    (level?.incidents || []).some((incident) => incident.seed?.image)
  );
  if (!imageSeeds) passed();
  else
    fail(
      'campaign',
      '#42: the L3/L20 CrashLoop seeds must inject only APP_MODE, never an image override'
    );
  const manifestEngineSource = read('js/engine/ManifestEngine.js');
  if (
    /auth\/kubeadmin-password/.test(manifestEngineSource) &&
    /import \{ KUBEADMIN_PASSWORD \} from '\.\/ClusterState\.js'/.test(manifestEngineSource) &&
    /export const KUBEADMIN_PASSWORD/.test(read('js/engine/ClusterState.js'))
  ) {
    passed();
  } else {
    fail(
      'files',
      '#42: the installer auth/kubeadmin-password file must stay seeded from ClusterState.KUBEADMIN_PASSWORD'
    );
  }
  const loginLevels = [
    levels.find((level) => level.id === 1),
    levels.find((level) => level.id === 13),
  ];
  const passwordHintsOk = loginLevels.every((level) =>
    (level?.hints || []).some((hint) => /auth\/kubeadmin-password/.test(hint))
  );
  if (passwordHintsOk) passed();
  else fail('campaign', '#42: L1 and L13 hints must document ~/auth/kubeadmin-password discovery');
  const evidenceBullets = (ex280Mod?.EX280_OBJECTIVE_BULLETS || []).filter((bullet) =>
    ['security-jobs', 'security-cronjobs', 'security-scc', 'security-privileged'].includes(
      bullet.id
    )
  );
  if (
    evidenceBullets.length === 4 &&
    evidenceBullets.every(
      (bullet) => Array.isArray(bullet.objectiveTypes) && bullet.objectiveTypes.length > 0
    )
  ) {
    passed();
  } else {
    fail(
      'exam',
      '#42: the Job/CronJob/SCC readiness bullets must declare objectiveTypes for the evidence fallback'
    );
  }
}

// ── EX280 Prep objective data (official ground truth) ──────────────────────
let examFacts = null;
if (has('docs/research/exam-facts.json')) {
  try {
    examFacts = JSON.parse(read('docs/research/exam-facts.json'));
    passed();
  } catch (err) {
    fail('exam', `docs/research/exam-facts.json is not valid JSON: ${err.message}`);
  }
}
if (ex280Mod) {
  const groups = ex280Mod.EX280_OBJECTIVE_GROUPS || [];
  const bullets = groups.flatMap((g) => g.bullets || []);
  if (groups.length !== 9)
    fail('exam', `expected 9 EX280 objective groups, found ${groups.length}`);
  else passed();
  if (bullets.length !== 55) fail('exam', `expected 55 EX280V422 bullets, found ${bullets.length}`);
  else passed();
  if (ex280Mod.EX280_OBJECTIVE_COUNT !== 55)
    fail('exam', `EX280_OBJECTIVE_COUNT ${ex280Mod.EX280_OBJECTIVE_COUNT} != 55`);
  if (examFacts?.objective_counts) {
    if (examFacts.objective_counts.groups !== groups.length)
      fail('exam', 'exam-facts group count differs from EX280 data');
    if (examFacts.objective_counts.bullets !== bullets.length)
      fail('exam', 'exam-facts bullet count differs from EX280 data');
  }
  if (examFacts?.objectives) {
    for (const [gi, factGroup] of examFacts.objectives.entries()) {
      const group = groups[gi];
      if (!group || group.title !== factGroup.title) {
        fail(
          'exam',
          `EX280 group ${gi + 1} title differs from official facts: ${group?.title} vs ${factGroup.title}`
        );
        continue;
      }
      if ((group.bullets || []).length !== factGroup.bullets.length) {
        fail(
          'exam',
          `EX280 group "${group.title}": ${(group.bullets || []).length} bullets vs official ${factGroup.bullets.length}`
        );
      }
      for (const [bi, title] of factGroup.bullets.entries()) {
        if (group.bullets[bi]?.title !== title) {
          fail(
            'exam',
            `EX280 ${group.title} bullet ${bi + 1} differs from official: "${group.bullets[bi]?.title}" vs "${title}"`
          );
        }
      }
    }
    const counts = examFacts.objectives.map((g) => g.bullets.length).join('+');
    if (counts !== '14+7+6+5+6+2+5+3+7')
      fail('exam', `official group distribution changed: ${counts}`);
  }
  for (const bullet of bullets) {
    if (!bullet.id) fail('exam', 'EX280 bullet without id');
    if (!bullet.title) fail('exam', `EX280 bullet ${bullet.id}: missing title`);
    if (!bullet.summary) fail('exam', `EX280 bullet ${bullet.id}: missing summary`);
    if (!bullet.docsUrl) fail('exam', `EX280 bullet ${bullet.id}: missing docsUrl`);
    else if (
      !/^https:\/\/docs\.redhat\.com\/en\/documentation\/openshift_container_platform\/4\.22(?:\/|$)/.test(
        bullet.docsUrl
      )
    ) {
      if (/redhat\.com\/en\/services\/training\//.test(bullet.docsUrl)) {
        // The "be prepared to perform all tasks" bullet legitimately references the exam page.
        note(`EX280 bullet ${bullet.id}: docsUrl is the official exam page (accepted)`);
      } else {
        fail('exam', `EX280 bullet ${bullet.id}: docsUrl is not 4.22: ${bullet.docsUrl}`);
      }
    }
    const linkedLevels = bullet.levels || [];
    const linkedChallenges = bullet.challenges || [];
    if (linkedLevels.length + linkedChallenges.length === 0)
      fail('exam', `EX280 bullet ${bullet.id}: not mapped to any level/challenge`);
    for (const id of linkedLevels)
      if (!levelIds.has(id)) fail('exam', `EX280 bullet ${bullet.id}: unknown level ${id}`);
    for (const id of linkedChallenges) {
      if (challengeIds.size && !challengeIds.has(id))
        fail('exam', `EX280 bullet ${bullet.id}: unknown challenge ${id}`);
    }
    if (!Array.isArray(bullet.commands) || bullet.commands.length === 0)
      fail('exam', `EX280 bullet ${bullet.id}: no oc commands`);
    else {
      for (const cmd of bullet.commands) {
        if (/\bkubectl\b/.test(cmd))
          fail('branding', `EX280 bullet ${bullet.id}: command uses kubectl: ${cmd}`);
      }
    }
  }
  const labs = ex280Mod.EX280_QUICK_LABS || [];
  if (labs.length < 8 || labs.length > 10)
    fail('exam', `expected 8-10 quick labs, found ${labs.length}`);
  const bulletIds = new Set(bullets.map((b) => b.id));
  for (const lab of labs) {
    if (!lab.id || !lab.title) fail('exam', 'quick lab missing id/title');
    if (!bulletIds.has(lab.objectiveId))
      fail('exam', `quick lab ${lab.id}: unknown objectiveId ${lab.objectiveId}`);
    for (const obj of lab.check || []) checkObjective(`quick lab ${lab.id}`, obj);
    if (!lab.docsUrl || !/4\.22/.test(lab.docsUrl))
      fail('exam', `quick lab ${lab.id}: docsUrl is not 4.22`);
    for (const res of lab.setup?.startingResources || []) {
      if (registryKinds.size && !registryKinds.has(res.kind))
        fail('exam', `quick lab ${lab.id}: unknown startingResource kind ${res.kind}`);
    }
  }
  const cheat = ex280Mod.EX280_CHEATSHEET || [];
  if (cheat.length < 8) fail('exam', `cheatsheet expected 8+ groups, found ${cheat.length}`);
  for (const group of cheat) {
    if (!group.title || !Array.isArray(group.items) || group.items.length === 0)
      fail('exam', 'cheatsheet group missing title/items');
    for (const item of group.items || []) {
      if (!item.cmd) fail('exam', `cheatsheet item missing cmd in ${group.title}`);
      else if (/\bkubectl\b/.test(item.cmd))
        fail('branding', `cheatsheet uses kubectl: ${item.cmd}`);
    }
    if (!group.docsUrl || !/4\.22/.test(group.docsUrl))
      fail('exam', `cheatsheet group ${group.title}: docsUrl is not 4.22`);
  }
  if (ex280Mod.EX280_READINESS_THRESHOLD !== 0.9)
    fail('exam', `readiness threshold ${ex280Mod.EX280_READINESS_THRESHOLD} != 0.9`);
  const facts = ex280Mod.EX280_EXAM_FACTS || {};
  if (facts.examCode !== 'EX280V422')
    fail('exam', `EX280_EXAM_FACTS.examCode ${facts.examCode} != EX280V422`);
  if (Number(facts.durationHours) !== 3)
    fail('exam', `exam duration ${facts.durationHours} != 3 hours`);
  if (String(facts.ocpVersion) !== '4.22') fail('exam', `OCP version ${facts.ocpVersion} != 4.22`);
  if (!Array.isArray(facts.recommendedPrep) || facts.recommendedPrep.length < 3)
    fail('exam', 'recommendedPrep missing from exam facts');
  note(
    `EX280 mapping: ${bullets.length} bullets in ${groups.length} groups, ${labs.length} quick labs`
  );
} else {
  fail('exam', 'js/data/EX280Objectives.js missing or has no EX280_OBJECTIVE_GROUPS');
}

// ── Scoring / achievements contract ────────────────────────────────────────
const scoringSrc = read('js/engine/ScoringEngine.js');
if (!/getExamPrepProgress\s*\(/.test(scoringSrc))
  fail('scoring', 'ScoringEngine.getExamPrepProgress() is missing');
if (!/markExamPrep\s*\(/.test(scoringSrc))
  fail('scoring', 'ScoringEngine.markExamPrep() is missing');
if (!/examPrep/.test(scoringSrc)) fail('scoring', 'ScoringEngine has no examPrep progress store');
const REQUIRED_STATS = [
  'totalPodsDeployed',
  'deploymentsCreated',
  'servicesCreated',
  'projectsCreated',
  'routesCreated',
  'buildsCompleted',
  'imageStreamsCreated',
  'templatesProcessed',
  'helmReleases',
  'manifestsApplied',
  'kustomizeOverlaysApplied',
  'usersCreated',
  'groupsCreated',
  'rolebindingsCreated',
  'sccGrants',
  'operatorsInstalled',
  'incidentsResolved',
  'maxConcurrentPods',
  'levelsCompleted',
  'chaptersCompleted',
  'threeStarLevels',
  'totalStars',
  'challengesCompleted',
  'threeStarChallenges',
  'longestChaosSurvival',
  'commandsExecuted',
  'yamlViewed',
  'architectureScore',
  'examPrepMastered',
];
const STAT_ALIASES = {
  rolebindingsCreated: ['rolebindingsCreated', 'roleBindingsCreated'],
  architectureScore: ['architectureScore', 'bestArchitectureScore', 'highestArchitectureScore'],
};
for (const key of REQUIRED_STATS) {
  const aliases = STAT_ALIASES[key] || [key];
  if (!aliases.some((alias) => new RegExp(`\\b${alias}\\b`).test(scoringSrc))) {
    fail('scoring', `ScoringEngine missing required stat: ${key}`);
  }
}
if (achievementsMod?.ACHIEVEMENTS) {
  const achievements = achievementsMod.ACHIEVEMENTS;
  if (achievements.length < 35 || achievements.length > 45) {
    warn(
      'achievements',
      `expected ~40 OpenShift-themed achievements, found ${achievements.length}`
    );
  }
  const ids = new Set();
  const categories = new Set(Object.keys(achievementsMod.ACHIEVEMENT_CATEGORIES || {}));
  const statsRefs = new Set();
  for (const achievement of achievements) {
    if (!achievement.id) fail('achievements', 'achievement without id');
    if (ids.has(achievement.id)) fail('achievements', `duplicate achievement id ${achievement.id}`);
    ids.add(achievement.id);
    if (!achievement.name || !achievement.description)
      fail('achievements', `${achievement.id}: missing name/description`);
    if (categories.size && !categories.has(achievement.category))
      fail('achievements', `${achievement.id}: unknown category ${achievement.category}`);
    if (typeof achievement.condition !== 'function')
      fail('achievements', `${achievement.id}: condition must be a function`);
    else {
      const conditionSrc = achievement.condition.toString();
      for (const m of conditionSrc.matchAll(/stat\(\s*stats\s*,\s*([^)]+)\)/g)) {
        for (const s of m[1].matchAll(/'([^']+)'/g)) statsRefs.add(s[1]);
      }
      if (/\bkubectl\b/.test(achievement.description) && achievement.id !== 'oc-alias') {
        fail('branding', `achievement ${achievement.id}: description uses kubectl`);
      }
    }
  }
  const STAT_FALLBACKS = {
    resourceQuotaCreated: 'resourceQuotasCreated',
    quotasCreated: 'resourceQuotasCreated',
    authChecksAllowed: 'canIAllowed',
    canIChecks: 'canIAllowed',
    architectureScore: 'bestArchitectureScore',
  };
  for (const statKey of statsRefs) {
    const alias = STAT_FALLBACKS[statKey] || statKey;
    if (!new RegExp(`\\b${alias}\\b`).test(scoringSrc)) {
      warn(
        'achievements',
        `achievement references stat "${statKey}" not found in ScoringEngine (may be an easter egg/custom stat)`
      );
    }
  }
  note(`Achievements: ${achievements.length}`);
} else {
  fail('achievements', 'js/data/Achievements.js missing or has no ACHIEVEMENTS');
}

// ── 6. Branding / independence ─────────────────────────────────────────────
const ALLOW_UPSTREAM = new Set([
  'README.md',
  'NOTICE',
  'LICENSE',
  'docs/architecture-map.md',
  'docs/CONVERSION-SPEC.md',
]);
const ATTRIBUTION_DOCS = (rel) =>
  rel === 'README.md' || rel === 'NOTICE' || rel.startsWith('docs/');
// The start page intentionally credits the original K8s Games as a homage. The
// credit blocks are explicitly delimited in index.html so the legacy-branding
// scan can exempt them without relaxing the rule for the rest of the UI.
const ATTRIBUTION_MARKER_START = /<!--\s*upstream-attribution:start\s*-->/;
const ATTRIBUTION_MARKER_END = /<!--\s*upstream-attribution:end\s*-->/;
function upstreamAttributionLines(rel, src) {
  const set = new Set();
  if (rel !== 'index.html') return set;
  let inside = false;
  for (const [i, line] of src.split('\n').entries()) {
    if (ATTRIBUTION_MARKER_START.test(line)) {
      inside = true;
      continue;
    }
    if (ATTRIBUTION_MARKER_END.test(line)) {
      inside = false;
      continue;
    }
    if (inside) set.add(i);
  }
  return set;
}
for (const rel of allFiles.filter((f) => /\.(html|js|css|json|txt|yml|yaml)$/.test(f))) {
  if (rel.startsWith('scripts/') || ATTRIBUTION_DOCS(rel) || ALLOW_UPSTREAM.has(rel)) continue;
  const src = read(rel);
  const lines = src.split('\n');
  const allowedAttributionLines = upstreamAttributionLines(rel, src);
  for (const [i, line] of lines.entries()) {
    if (allowedAttributionLines.has(i)) continue;
    if (/k8sgames\.com/i.test(line))
      fail('branding', `${rel}:${i + 1}: contains k8sgames.com outside attribution`);
    if (/rohitg00\/k8sgames/i.test(line)) {
      if (rel === 'index.html' && /K8s Games by Rohit/.test(line) && /Apache-2\.0/.test(line)) {
        continue;
      }
      fail('branding', `${rel}:${i + 1}: contains rohitg00/k8sgames outside attribution files`);
    }
  }
}
const indexAttributionLines = upstreamAttributionLines('index.html', read('index.html'));
if (indexAttributionLines.size > 0)
  note(
    `index.html upstream-attribution blocks are delimited and exempt from the legacy-branding scan (${indexAttributionLines.size} lines)`
  );
const FORBIDDEN_UI_NAMES = [/Kubernetes Cluster Simulation/i, /K8s Games/i];
for (const rel of ['index.html', 'draw.html', ...jsFiles.filter((f) => f.startsWith('js/'))]) {
  const src = read(rel);
  const allowedAttributionLines = upstreamAttributionLines(rel, src);
  for (const [i, line] of src.split('\n').entries()) {
    if (allowedAttributionLines.has(i)) continue;
    // The menu attribution line is required copy ("based on K8s Games by Rohit").
    if (rel === 'index.html' && /based on .*K8s Games by Rohit/.test(line)) continue;
    for (const re of FORBIDDEN_UI_NAMES) {
      if (re.test(line))
        fail('branding', `${rel}:${i + 1}: legacy product branding: ${line.trim().slice(0, 120)}`);
    }
  }
}
// kubectl is only an input alias / legacy migration note, never taught copy.
const KUBECTL_ALLOWED_FILES = new Set([
  'js/ui/CommandBar.js',
  'js/ui/IncidentPanel.js',
  'js/ui/SettingsPanel.js',
]);
// `kubectl.kubernetes.io/*` is a real Kubernetes annotation/label key prefix, not player copy.
const KUBECTL_ALLOWED_LINE =
  /(legacy|migration|alias|prefix|not kubectl|oc.*kubectl|kubectl.*oc|kubectl\.kubernetes\.io)/i;
for (const rel of ['index.html', 'draw.html', ...jsFiles]) {
  if (rel.startsWith('docs/') || KUBECTL_ALLOWED_FILES.has(rel)) continue;
  const lines = read(rel).split('\n');
  for (const [i, line] of lines.entries()) {
    if (!/\bkubectl\b/.test(line)) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // source comment, not player copy
    if (KUBECTL_ALLOWED_LINE.test(line)) continue; // educational alias note
    fail(
      'branding',
      `${rel}:${i + 1}: kubectl outside the alias allowlist: ${line.trim().slice(0, 120)}`
    );
  }
}
if (
  /\bK8S_BLUE\b/.test(allFiles.map((f) => (/\.(html|js|css)$/.test(f) ? read(f) : '')).join('\n'))
) {
  fail('branding', 'legacy K8S_BLUE constant name remains in UI code');
}
const requiredUiFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'screenshot.png',
  'og-image.png',
  'index.html',
  'draw.html',
  'style.css',
  'vercel.json',
  'robots.txt',
  'og-image.html',
];
for (const rel of requiredUiFiles) {
  if (!has(rel)) fail('files', `missing required file ${rel}`);
  else passed();
}
const screenshot = pngSize('screenshot.png');
if (screenshot) {
  if (screenshot.width !== 1600 || screenshot.height !== 900)
    warn(
      'files',
      `screenshot.png is ${screenshot.width}x${screenshot.height}; expected 1600x900 hero`
    );
  else passed();
  if (screenshot.bytes < 50_000)
    warn('files', `screenshot.png is suspiciously small (${screenshot.bytes} bytes)`);
}
const ogShot = pngSize('og-image.png');
if (ogShot) {
  if (ogShot.width !== 1200 || ogShot.height !== 630)
    fail('files', `og-image.png is ${ogShot.width}x${ogShot.height}; expected 1200x630`);
  else passed();
}
const indexSrc = read('index.html');
const title = indexSrc.match(/<title>([^<]+)<\/title>/)?.[1] || '';
if (title !== 'shifting.pro - Learn OpenShift by Playing (EX280)')
  fail('branding', `index title is "${title}"`);
else passed();
const requiredMeta = [
  ['name="description"', 'Learn Red Hat OpenShift by playing.'],
  ['property="og:url"', 'https://shifting.pro'],
  ['property="og:image"', 'https://shifting.pro/og-image.png'],
  ['name="twitter:card"', 'summary_large_image'],
  ['name="theme-color"', '#EE0000'],
];
for (const [needle, value] of requiredMeta) {
  if (!indexSrc.includes(needle) || !indexSrc.includes(value))
    fail('branding', `index.html missing ${needle} / ${value}`);
}
if (!indexSrc.includes('shifting.pro'))
  fail('branding', 'index.html does not contain shifting.pro branding');
if (!indexSrc.includes('menu-logo')) fail('branding', 'index.html menu logo element missing');
if (!/OpenShift 4\.22 Cluster Simulation · Built for EX280/.test(indexSrc))
  fail('branding', 'menu subtitle does not match spec');
if (!(
  indexSrc.includes('Built for') &&
  indexSrc.includes('EX280') &&
  /based on/.test(indexSrc) &&
  indexSrc.includes('K8s Games by Rohit') &&
  indexSrc.includes('(Apache-2.0)') &&
  /trademark of Red Hat/.test(indexSrc)
)) {
  fail('branding', 'required menu footer attribution copy missing');
} else passed();
// Marker-delimited credit regions are required (homage section + footer legal
// block), so the exemption above can never silently remove the upstream credit.
const attributionStarts = (indexSrc.match(/upstream-attribution:start/g) || []).length;
const attributionEnds = (indexSrc.match(/upstream-attribution:end/g) || []).length;
if (attributionStarts < 2 || attributionEnds !== attributionStarts) {
  fail(
    'branding',
    `start page upstream attribution block missing or unbalanced (start=${attributionStarts}, end=${attributionEnds}; expected >=2 balanced pairs)`
  );
} else passed();
if (!/github\.com\/rohitg00\/k8sgames/.test(indexSrc))
  fail('branding', 'start page does not link to the original k8sgames repo');
else passed();
if (!/Apache-2\.0/.test(indexSrc))
  fail('branding', 'start page does not state the Apache-2.0 licence of the original');
else passed();
if (/Kubernetes Cluster Simulation/.test(indexSrc))
  fail('branding', 'index.html still says Kubernetes Cluster Simulation');
if (!/three@0\.152\.0/.test(indexSrc))
  fail('branding', 'index.html Three.js CDN version is not pinned to 0.152.0');
if (!/cdn\.tailwindcss\.com\/3\.4\.1/.test(indexSrc))
  fail('branding', 'index.html Tailwind CDN is not pinned');
if (!/<meta name="viewport"/.test(indexSrc)) fail('branding', 'index.html missing viewport meta');
const drawTitle = read('draw.html').match(/<title>([^<]+)<\/title>/)?.[1] || '';
if (!/OpenShift Draw/.test(drawTitle)) fail('branding', `draw title is "${drawTitle}"`);
if (!/shifting.pro (?:·|&middot;) \/draw/.test(read('draw.html')))
  fail('branding', 'draw watermark missing');
if (!/shifting\.pro/.test(indexSrc) || !/shifting\.pro/.test(read('README.md'))) {
  fail('branding', 'canonical shifting.pro URL missing from index/README');
}

const readme = read('README.md');
const readmeChecks = [
  [/^# shifting.pro/m, 'README title'],
  [/## EX280 coverage/i, 'README EX280 coverage heading'],
  [/## Credits & license/i, 'README credits heading'],
  [/rohitg00\/k8sgames/, 'README original-project attribution'],
  [/Apache License 2\.0/, 'README Apache-2.0 mention'],
  [/not affiliated/i, 'README non-affiliation disclaimer'],
  [/## Deploy/i, 'README deploy section'],
  [/vercel\.json/, 'README vercel.json instructions'],
  // #68: the versioned /v/ prefix only exists as a production rewrite, so the
  // canonical local command is the zero-dependency dev server (a plain
  // `python3 -m http.server` cannot resolve those URLs any more).
  [/node scripts\/dev-server\.mjs/, 'README local dev-server instructions'],
  [/EX280V422/, 'README EX280V422 coverage'],
  [/github\.com\/G-man3207\/openshiftgames\/wiki/, 'README GitHub wiki link'],
  [/wiki\/EX280-Study-Guide/, 'README wiki study-guide link'],
  [/wiki\/Exam-Prep/, 'README wiki EX280 Prep link'],
];
for (const [re, label] of readmeChecks) {
  if (!re.test(readme)) fail('readme', `README missing ${label}`);
  else passed();
}
for (const group of [
  'Manage OpenShift Container Platform',
  'Declarative Resource Management',
  'Deploy applications',
  'authentication and authorization',
  'network security',
  'non-HTTP',
  'developer self-service',
  'OpenShift operators',
  'application security',
]) {
  if (!new RegExp(group, 'i').test(readme))
    fail('readme', `README coverage table missing objective group: ${group}`);
}
const notice = read('NOTICE');
for (const needle of [
  'derivative work',
  'K8s Games',
  'rohitg00/k8sgames',
  'Apache License',
  'Rohit',
]) {
  if (!notice.includes(needle)) fail('notice', `NOTICE missing "${needle}"`);
}
if (!/K8s Games, Copyright \(c\) Rohit G \/ rohitg00/.test(readme))
  warn('readme', 'README copyright line differs from the exact attribution requirement');

// ── 7. Declarative engine self-tests ───────────────────────────────────────
const parserMod = await tryImport('js/engine/YamlParser.js');
if (parserMod?.selfTest) {
  try {
    const res = await parserMod.selfTest();
    if (!res?.ok)
      fail(
        'yaml',
        'YamlParser.selfTest() failed',
        JSON.stringify(res?.failures || res).slice(0, 800)
      );
    else {
      passed();
      note('YamlParser self-test: ok');
    }
  } catch (err) {
    fail('yaml', `YamlParser.selfTest() threw: ${err.message}`);
  }
} else {
  fail('yaml', 'js/engine/YamlParser.js must export selfTest()');
}
const manifestFiles = manifestFilesMod?.MANIFEST_FILES || null;
if (manifestFiles) {
  const keys = Object.keys(manifestFiles);
  const requiredManifests = [
    'manifests/deployment.yaml',
    'manifests/service.yaml',
    'manifests/route.yaml',
    'kustomize/base/kustomization.yaml',
    'kustomize/base/deployment.yaml',
    'kustomize/base/service.yaml',
    'kustomize/overlays/dev/kustomization.yaml',
    'kustomize/overlays/prod/kustomization.yaml',
    'templates/webapp-template.yaml',
    'helm/webapp/Chart.yaml',
    'helm/webapp/values.yaml',
    'helm/webapp/templates/deployment.yaml',
    'helm/webapp/templates/service.yaml',
    'htpasswd',
    'examples/quota.yaml',
    'examples/limitrange.yaml',
    'examples/privileged-deployment.yaml',
    'examples/subscription.yaml',
    'examples/buildconfig.yaml',
  ];
  for (const file of requiredManifests)
    if (!(file in manifestFiles)) fail('yaml', `default manifest file missing: ${file}`);
  if (keys.length < 19)
    warn('yaml', `expected at least 19 default manifest files, found ${keys.length}`);
  if (parserMod?.parseYaml) {
    for (const file of keys) {
      if (
        file === 'htpasswd' ||
        file.includes('kustomization') ||
        file.includes('Chart.yaml') ||
        file.includes('values.yaml')
      )
        continue;
      try {
        const docs = parserMod.parseYaml(manifestFiles[file], { file });
        if (!docs.length) fail('yaml', `default manifest has no documents: ${file}`);
        for (const doc of docs) {
          if (doc && typeof doc === 'object' && !doc.apiVersion && !doc.kind) {
            fail('yaml', `default manifest doc missing apiVersion/kind: ${file}`);
          }
        }
      } catch (err) {
        fail('yaml', `default manifest does not parse: ${file}: ${err.message}`);
      }
    }
  }
  note(`Manifest files: ${keys.length}`);
} else {
  fail('yaml', 'js/data/ManifestFiles.js missing or has no MANIFEST_FILES');
}

const manifestEngineMod = await tryImport('js/engine/ManifestEngine.js');
const gameEngineMod = await tryImport('js/engine/GameEngine.js');
if (manifestEngineMod?.ManifestEngine && gameEngineMod?.GameEngine && manifestFiles) {
  try {
    const engine = new gameEngineMod.GameEngine({ mode: 'sandbox' });
    const manifestEngine = new manifestEngineMod.ManifestEngine(engine, {
      autoCreateProjects: true,
    });

    const apply = manifestEngine.applyFile('manifests/deployment.yaml');
    if (!apply.ok)
      fail(
        'declarative',
        `applyFile(manifests/deployment.yaml) failed: ${(apply.errors || []).join('; ')}`
      );
    else if (
      !engine.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'webapp')
    ) {
      fail('declarative', 'applyFile did not create Deployment/webapp');
    } else passed();

    const kustomize = manifestEngine.applyKustomize('kustomize/overlays/prod');
    if (!kustomize.ok)
      fail('declarative', `applyKustomize(prod) failed: ${(kustomize.errors || []).join('; ')}`);
    else if (
      !engine.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'prod-webapp')
    ) {
      fail('declarative', 'applyKustomize(prod) did not create Deployment/prod-webapp');
    } else passed();

    const processed = manifestEngine.processTemplate('templates/webapp-template.yaml', {
      APP_NAME: 'verify-app',
    });
    if (!processed.ok)
      fail('declarative', `processTemplate failed: ${(processed.errors || []).join('; ')}`);
    else {
      const applied = manifestEngine.applyObjects(processed.objects, '<verify>');
      if (!applied.ok)
        fail(
          'declarative',
          `applyObjects(processTemplate) failed: ${(applied.errors || []).join('; ')}`
        );
      else if (
        !engine.cluster.getByKind?.('Deployment')?.some((d) => d.metadata?.name === 'verify-app')
      ) {
        fail('declarative', 'processed template was not applied as Deployment/verify-app');
      } else passed();
    }

    const helm = manifestEngine.installHelm('verify-release', 'helm/webapp');
    if (!helm.ok) fail('declarative', `installHelm failed: ${(helm.errors || []).join('; ')}`);
    else if (!manifestEngine.listHelm().some((r) => (r.name || r.release) === 'verify-release')) {
      fail('declarative', 'helm release missing from listHelm()');
    } else {
      const uninstall = manifestEngine.uninstallHelm('verify-release');
      if (!uninstall.ok) fail('declarative', 'uninstallHelm failed');
      else passed();
    }

    if (!manifestEngine.htpasswdAdd('verifyuser', 'Passw0rd!'))
      fail('declarative', 'htpasswdAdd failed');
    else if (manifestEngine.verifyHtpasswd?.('verifyuser', 'Passw0rd!') !== true)
      fail('declarative', 'htpasswd verify failed');
    else if (
      manifestEngine.htpasswdDelete('verifyuser') &&
      !manifestEngine.htpasswdList().includes('verifyuser')
    )
      passed();
    else fail('declarative', 'htpasswdDelete did not remove the user');
    note(
      'Declarative engine: apply -f, apply -k, process template, helm install/list/uninstall, htpasswd verified'
    );
  } catch (err) {
    fail('declarative', `declarative engine smoke test threw: ${err.stack || err.message}`);
  }
} else {
  fail('declarative', 'ManifestEngine/GameEngine missing or not importable');
}

// ── CommandBar interface / UI wiring ───────────────────────────────────────
const commandBarSrc = read('js/ui/CommandBar.js');
if (!/export\s+class\s+CommandBar/.test(commandBarSrc))
  fail('cli', 'CommandBar class is not exported');
if (!/executeCommand\s*\(/.test(commandBarSrc)) fail('cli', 'CommandBar.executeCommand() missing');
if (!/_executeCommand\s*\(/.test(commandBarSrc))
  fail('cli', 'CommandBar._executeCommand legacy alias missing');
if (!/stripCommandPrefix/.test(commandBarSrc) || !/kubectl/.test(commandBarSrc))
  fail('cli', 'kubectl input alias/educational note missing');
const dispatch = new Set(
  [...commandBarSrc.matchAll(/case\s+'([a-z0-9-]+)'\s*:/g)].map((m) => m[1])
);
const REQUIRED_COMMANDS = [
  'login',
  'logout',
  'whoami',
  'project',
  'projects',
  'new-project',
  'status',
  'config',
  'version',
  'api-resources',
  'get',
  'describe',
  'logs',
  'events',
  'explain',
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
  'new-app',
  'new-build',
  'start-build',
  'cancel-build',
  'expose',
  'route',
  'adm',
  'auth',
  'process',
  'helm',
  'htpasswd',
  'tag',
  'import-image',
  'rollout',
  'run',
  'exec',
  'debug',
  'top',
  'taint',
  'cordon',
  'uncordon',
  'drain',
  'must-gather',
  'inspect',
  'clusterquota',
  'quota',
  'limitrange',
  'user',
  'group',
  'sa',
  'install',
  'uninstall',
];
for (const cmd of REQUIRED_COMMANDS) {
  if (!dispatch.has(cmd) && !new RegExp(`['"]${cmd}['"]`).test(commandBarSrc)) {
    fail('cli', `CommandBar has no "${cmd}" command path`);
  }
}
if (!/applyKustomize|_applyKustomizeDelegated/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support oc apply -k');
if (!/htpasswd/.test(commandBarSrc)) fail('cli', 'CommandBar does not support htpasswd');
if (!/helm/.test(commandBarSrc)) fail('cli', 'CommandBar does not support helm');
if (!/processTemplate|_cmdProcess/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support oc process');
if (!/can-i|_cmdAuth/.test(commandBarSrc)) fail('cli', 'CommandBar does not support oc auth can-i');
if (!/add-scc-to-user/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support add-scc-to-user');
if (!/create-bootstrap-project-template/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support oc adm create-bootstrap-project-template');
if (!/_cmdExtract|oc extract|extractSecret/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support oc extract');
if (!/_setData|set data/.test(commandBarSrc))
  fail('cli', 'CommandBar does not support oc set data');
if (!/project\.config\.openshift\.io|projectConfig/i.test(commandBarSrc))
  fail('cli', 'CommandBar does not support project.config.openshift.io');
if (!/verb/.test(commandBarSrc) || !/resource-name/.test(commandBarSrc))
  fail('cli', 'Handler for oc create role --verb/--resource flags missing');
note('CommandBar: API + required command paths present');

const expectedIndexIds = [
  'game-canvas',
  'main-menu',
  'menu-exam-prep',
  'game-container',
  'objectives-panel',
  'resource-palette',
  'btn-manifests',
  'btn-exam-prep',
  'btn-settings',
  'btn-achievements',
  'btn-stats',
  'settings-panel',
  'achievements-panel',
  'stats-panel',
  'modal-level-complete',
  'modal-game-over',
  'level-select',
  'challenge-select',
  'view-toolbar',
];
const presentIndexIds = new Set([...indexSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const id of expectedIndexIds)
  if (!presentIndexIds.has(id)) fail('ui', `index.html missing #${id}`);
const expectedDrawIds = [
  'draw-canvas',
  'resource-palette',
  'draw-props',
  'btn-export-yaml',
  'draw-watermark',
];
const presentDrawIds = new Set([...read('draw.html').matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const id of expectedDrawIds)
  if (!presentDrawIds.has(id)) fail('ui', `draw.html missing #${id}`);
for (const [rel, id] of [
  ['js/ui/InspectorPanel.js', 'inspector-panel'],
  ['js/ui/ContextMenu.js', 'context-menu'],
  ['js/ui/MetricsDashboard.js', 'metrics-dashboard'],
  ['js/ui/SettingsPanel.js', 'ingame-settings-panel'],
  ['js/ui/ManifestPanel.js', 'ogmf-overlay'],
]) {
  if (!read(rel).includes(id)) fail('ui', `${rel} does not define #${id}`);
}
if (!indexSrc.includes('window.game =')) fail('ui', 'index.html never exposes window.game');
if (!indexSrc.includes('manifestEngine')) fail('ui', 'index.html does not wire manifestEngine');
if (!indexSrc.includes('examPrepUI')) fail('ui', 'index.html does not wire examPrepUI');

// External dependency / build-step invariants. The app itself is a no-build, dependency-free
// static site; the only permitted package.json content is the pinned dev-only toolchain
// (Prettier + Knip + husky), and no bundler/build config may appear.
const DEV_TOOLING = new Set(['prettier', 'knip', 'husky']);
const FORBIDDEN_BUILD_CONFIGS = [
  'vite.config.js',
  'vite.config.mjs',
  'webpack.config.js',
  'webpack.config.cjs',
  'rollup.config.js',
  'rollup.config.mjs',
  'esbuild.config.js',
  'esbuild.config.mjs',
  'parcel.config.json',
  'tsconfig.json',
];
for (const rel of FORBIDDEN_BUILD_CONFIGS) {
  if (has(rel)) fail('deps', `bundler/build config is not allowed: ${rel}`);
  else passed();
}
if (!/^node_modules\/$/m.test(read('.gitignore'))) {
  fail('deps', '.gitignore must keep node_modules/ out of the repo');
} else {
  passed();
}
if (has('.git')) {
  const trackedNodeModules = spawnSync('git', ['ls-files', '--', 'node_modules'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (trackedNodeModules.status === 0 && trackedNodeModules.stdout.trim()) {
    fail('deps', 'node_modules must never be git-tracked');
  } else {
    passed();
  }
}

// Dev tooling contract: the runtime stays dependency-free, the toolchain is dev-only/optional.
const devToolingFiles = [
  'package.json',
  'package-lock.json',
  '.prettierrc',
  '.prettierignore',
  'knip.jsonc',
  'scripts/knip-entrypoints.mjs',
  '.husky/pre-commit',
];
for (const rel of devToolingFiles) {
  if (!has(rel)) fail('deps', `missing dev-tooling file ${rel}`);
  else passed();
}
let pkg = null;
if (has('package.json')) {
  try {
    pkg = JSON.parse(read('package.json'));
  } catch (err) {
    fail('deps', `package.json is not valid JSON: ${err.message}`);
  }
}
if (pkg) {
  if (pkg.private !== true) fail('deps', 'package.json must be private');
  else passed();
  const runtimeDepFields = ['dependencies', 'optionalDependencies', 'peerDependencies'].filter(
    (field) => pkg[field] && Object.keys(pkg[field]).length > 0
  );
  if (runtimeDepFields.length) {
    fail(
      'deps',
      `package.json declares runtime dependencies (${runtimeDepFields.join(', ')}); the app must stay dependency-free`
    );
  } else {
    passed();
  }
  const devDeps = Object.keys(pkg.devDependencies || {}).sort();
  const unknownDevDeps = devDeps.filter((dep) => !DEV_TOOLING.has(dep));
  if (unknownDevDeps.length) {
    fail(
      'deps',
      `package.json devDependencies contain non-tooling packages: ${unknownDevDeps.join(', ')}`
    );
  } else {
    passed();
  }
  const missingDevDeps = [...DEV_TOOLING].filter((dep) => !devDeps.includes(dep));
  if (missingDevDeps.length) {
    fail('deps', `package.json is missing dev tooling: ${missingDevDeps.join(', ')}`);
  } else {
    passed();
  }
  if (pkg.main !== 'index.html') fail('deps', 'package.json "main" must point at index.html');
  else passed();
  const requiredScripts = {
    'format:check': 'prettier --check .',
    knip: 'knip',
    prepare: 'husky',
  };
  for (const [name, command] of Object.entries(requiredScripts)) {
    if ((pkg.scripts || {})[name] !== command) {
      fail('deps', `package.json scripts.${name} must be "${command}"`);
    } else {
      passed();
    }
  }
  const lintScript = (pkg.scripts || {}).lint || '';
  const lintRunsPrettier =
    /prettier --check \./.test(lintScript) || /npm run format:check/.test(lintScript);
  if (!lintRunsPrettier || !/\bknip\b/.test(lintScript)) {
    fail('deps', 'package.json scripts.lint must run both prettier --check and knip');
  } else {
    passed();
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version || ''))) {
    fail('deps', 'package.json version must be plain semver (no "v" prefix)');
  } else {
    passed();
  }
}
if (has('package-lock.json')) {
  try {
    const lock = JSON.parse(read('package-lock.json'));
    if (!lock.lockfileVersion || !lock.packages) {
      fail('deps', 'package-lock.json must be a lockfile v2+ with a packages map');
    } else {
      passed();
    }
  } catch (err) {
    fail('deps', `package-lock.json is not valid JSON: ${err.message}`);
  }
}

// Pre-commit gate contract: the hook must run both gates and guard on node_modules.
if (has('.husky/pre-commit')) {
  const hook = read('.husky/pre-commit');
  for (const [re, message] of [
    [/prettier --check \./, 'pre-commit hook must run prettier --check .'],
    [/\bknip\b/, 'pre-commit hook must run knip'],
    [/node_modules/, 'pre-commit hook must guard on node_modules'],
    [
      /npm install/,
      'pre-commit hook must tell users to run npm install when node_modules is missing',
    ],
  ]) {
    if (!re.test(hook)) fail('deps', message);
    else passed();
  }
}

// The Knip entry mirror must cover every ./js/ import of the inline HTML modules (static and
// dynamic) in both directions, so dead-file detection cannot silently rot.
const inlineJsImports = new Set();
for (const htmlRel of ['index.html', 'draw.html']) {
  for (const mod of inlineModules(htmlRel)) {
    const clean = stripComments(mod.src);
    const specs = new Set();
    for (const m of clean.matchAll(IMPORT_FROM_RE)) specs.add(m[1]);
    for (const m of clean.matchAll(DYNAMIC_IMPORT_RE)) specs.add(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('./js/')) continue;
      inlineJsImports.add(path.posix.normalize(spec));
    }
  }
}
if (inlineJsImports.size === 0) {
  fail('deps', 'no ./js/ imports found in the inline index.html/draw.html modules');
} else {
  passed();
}
const mirrorRel = 'scripts/knip-entrypoints.mjs';
if (has(mirrorRel)) {
  const mirrorImports = new Set();
  for (const m of stripComments(read(mirrorRel)).matchAll(IMPORT_FROM_RE)) {
    if (!m[1].startsWith('../js/')) continue;
    mirrorImports.add(path.posix.normalize(path.posix.join('scripts', m[1])));
  }
  for (const spec of inlineJsImports) {
    if (mirrorImports.has(spec)) passed();
    else fail('deps', `scripts/knip-entrypoints.mjs mirror is missing inline import "${spec}"`);
  }
  for (const spec of mirrorImports) {
    if (inlineJsImports.has(spec)) passed();
    else {
      fail(
        'deps',
        `scripts/knip-entrypoints.mjs mirror has stale import "${spec}" not used by index.html/draw.html`
      );
    }
  }
}

if (
  !/importmap/.test(indexSrc) ||
  !/"three": "https:\/\/unpkg\.com\/three@0\.152\.0/.test(indexSrc)
) {
  fail('deps', 'Three.js import map is not pinned to 0.152.0');
}

// ── Report ─────────────────────────────────────────────────────────────────
const sep = '─'.repeat(74);
console.log(sep);
console.log('shifting.pro — static verification');
console.log(sep);
if (VERBOSE) {
  for (const n of notes) console.log(`  note: ${n}`);
  if (notes.length) console.log('');
}
for (const w of warnings)
  console.log(`  WARN  [${w.check}] ${w.message}${w.detail ? `\n         ${w.detail}` : ''}`);
for (const f of failures) {
  console.log(`  FAIL  [${f.check}] ${f.message}`);
  if (f.detail)
    console.log(
      String(f.detail)
        .split('\n')
        .map((l) => `         ${l}`)
        .join('\n')
    );
}
console.log(sep);
console.log(`Files checked: ${jsFiles.length} JS modules, ${allFiles.length} total files`);
console.log(
  `Checks passed: ${checks.passed} · failures: ${failures.length} · warnings: ${warnings.length}`
);
console.log(sep);
process.exit(failures.length > 0 ? 1 : 0);
