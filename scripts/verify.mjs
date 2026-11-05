#!/usr/bin/env node
/**
 * OpenShift Games — static verification harness (no runtime dependencies).
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
      if (
        dnsService?.spec?.type === 'ClusterIP' &&
        dnsService.spec.clusterIP === '172.30.0.10' &&
        JSON.stringify(dnsService.spec.ports) === JSON.stringify(expectedDnsPorts) &&
        JSON.stringify(dnsService.spec.selector) ===
          JSON.stringify({ 'dns.operator.openshift.io/daemonset-dns': 'default' })
      ) {
        passed();
      } else {
        fail(
          'fidelity',
          `openshift-dns/dns-default Service contract missing (#58): ${JSON.stringify({ type: dnsService?.spec?.type, clusterIP: dnsService?.spec?.clusterIP, ports: dnsService?.spec?.ports, selector: dnsService?.spec?.selector })}`
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

        // #62F: `oc describe svc web`'s empty Events placeholder is aligned with
        // the widest top-level label (`Session Affinity:` → column 19), i.e.
        // exactly 12 spaces after `Events:` (the old fixed 10-space placeholder
        // is one tabwriter column short).
        const describeWebResult = cliBar.executeCommand('oc describe svc web -n qa61-locks');
        const describeWebMessage = String(describeWebResult?.message || '');
        const eventsLine = (describeWebMessage.match(/^Events:.*$/m) || [''])[0];
        const eventsSpaces = (eventsLine.match(/^Events:( +)<none>$/) || [])[1] || '';
        if (!describeWebResult?.error && eventsSpaces.length === 12) {
          passed();
        } else {
          fail(
            'fidelity',
            `oc describe svc web Events placeholder must align at the tabwriter column (exactly 12 spaces after "Events:", got ${eventsSpaces.length}) (#62F): ${JSON.stringify(eventsLine)}`
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

const REQUIRED_LEVEL_TITLES = [
  'Your First Project',
  'Query, Format, Filter',
  'Logs, Events & Health',
  'Declarative Manifests',
  'Kustomize Base',
  'Kustomize Overlays',
  'Secrets & ConfigMaps',
  'Templates & Helm',
  'Images, Builds & Image Streams',
  'Rolling Updates & Rollbacks',
  'Services & Routes',
  'Non-HTTP & Load Balancer',
  'HTPasswd & Users',
  'Groups & RBAC',
  'Quotas, LimitRanges & Templates',
  'Service Accounts & API Access',
  'SCC & Privileged Apps',
  'Operators',
  'Jobs & CronJobs',
  'EX280 Final: Production Platform',
];
const REQUIRED_CHAPTERS = [
  'Manage OpenShift',
  'Declarative & Kustomize',
  'Deploy & Expose',
  'Identity, RBAC & Self-service',
  'Security & Operations',
];
const levelIds = new Set();
const levels = levelsMod?.CAMPAIGN_LEVELS || [];
if (levels.length) {
  if (levels.length !== 20) fail('campaign', `expected 20 levels, found ${levels.length}`);
  else passed();
  for (const [i, level] of levels.entries()) {
    const owner = `level ${level.id} (${level.title})`;
    levelIds.add(level.id);
    if (level.id !== i + 1)
      fail('campaign', `${owner}: ids must be sequential (found ${level.id} at index ${i})`);
    if (level.title !== REQUIRED_LEVEL_TITLES[i])
      fail('campaign', `${owner}: title differs from spec "${REQUIRED_LEVEL_TITLES[i]}"`);
    if (!(level.chapter >= 1 && level.chapter <= 5))
      fail('campaign', `${owner}: chapter ${level.chapter} out of 1..5`);
    if (level.chapterName !== REQUIRED_CHAPTERS[level.chapter - 1])
      fail(
        'campaign',
        `${owner}: chapterName "${level.chapterName}" does not match chapter ${level.chapter}`
      );
    if (!level.description) fail('campaign', `${owner}: missing description`);
    if (!Array.isArray(level.examObjectives) || level.examObjectives.length === 0) {
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
      for (const url of level.docsLinks) {
        if (
          !/^https:\/\/docs\.redhat\.com\/en\/documentation\/openshift_container_platform\/4\.22\//.test(
            url
          )
        ) {
          fail('campaign', `${owner}: docsLink is not an OCP 4.22 docs page: ${url}`);
        }
      }
    }
    if (!Array.isArray(level.objectives) || level.objectives.length < 2)
      fail('campaign', `${owner}: needs 2+ objectives`);
    for (const obj of level.objectives || []) checkObjective(owner, obj);
    if (!Array.isArray(level.startingResources) || level.startingResources.length === 0)
      fail('campaign', `${owner}: no startingResources`);
    for (const res of level.startingResources || []) {
      if (registryKinds.size && !registryKinds.has(res.kind))
        fail('campaign', `${owner}: unknown startingResource kind ${res.kind}`);
      if (!res.name) fail('campaign', `${owner}: startingResource ${res.kind} missing name`);
    }
    if (!Array.isArray(level.availableResources) || level.availableResources.length === 0)
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
    if (i < levels.length - 1 && level.nextLevel !== level.id + 1)
      fail('campaign', `${owner}: nextLevel ${level.nextLevel} != ${level.id + 1}`);
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
  }
  const chapters = levelsMod.CHAPTERS || [];
  if (chapters.length !== 5) fail('campaign', `expected 5 chapters, found ${chapters.length}`);
  else {
    for (const [i, chapter] of chapters.entries()) {
      if (chapter.id !== i + 1) fail('campaign', `chapter ${chapter.id} is out of sequence`);
      if (chapter.name !== REQUIRED_CHAPTERS[i])
        fail(
          'campaign',
          `chapter ${chapter.id} name "${chapter.name}" != "${REQUIRED_CHAPTERS[i]}"`
        );
      if (!Array.isArray(chapter.levels) || chapter.levels.length !== 4)
        fail('campaign', `chapter ${chapter.id} should have 4 levels`);
      for (const id of chapter.levels || [])
        if (!levelIds.has(id))
          fail('campaign', `chapter ${chapter.id} references unknown level ${id}`);
    }
  }
  note(`Campaign: ${levels.length} levels, ${chapters.length} chapters`);
} else {
  fail('campaign', 'js/data/CampaignLevels.js missing or has no CAMPAIGN_LEVELS');
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
if (title !== 'OpenShift Games — Learn OpenShift by Playing (EX280)')
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
if (!indexSrc.includes('OpenShift Games'))
  fail('branding', 'index.html does not contain OpenShift Games branding');
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
if (!/OpenShift Games (?:·|&middot;) \/draw/.test(read('draw.html')))
  fail('branding', 'draw watermark missing');
if (!/shifting\.pro/.test(indexSrc) || !/shifting\.pro/.test(read('README.md'))) {
  fail('branding', 'canonical shifting.pro URL missing from index/README');
}

const readme = read('README.md');
const readmeChecks = [
  [/^# OpenShift Games/m, 'README title'],
  [/## EX280 coverage/i, 'README EX280 coverage heading'],
  [/## Credits & license/i, 'README credits heading'],
  [/rohitg00\/k8sgames/, 'README original-project attribution'],
  [/Apache License 2\.0/, 'README Apache-2.0 mention'],
  [/not affiliated/i, 'README non-affiliation disclaimer'],
  [/## Deploy/i, 'README deploy section'],
  [/vercel\.json/, 'README vercel.json instructions'],
  [/python3 -m http\.server/, 'README local static-server instructions'],
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
console.log('OpenShift Games — static verification');
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
