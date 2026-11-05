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
