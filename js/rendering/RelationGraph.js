/**
 * OpenShift relationship graph for the 3D renderer.
 *
 * Computes the semantic edges drawn between resources in the cluster view:
 *
 *   ownership    parent → child (Deployment → ReplicaSet → Pod, CronJob → Job, ownerRefs)
 *   containment  Project → namespaced resource (Project replaces Namespace)
 *   network      Service → Pod / Deployment (spec.selector)
 *   route        Route → Service (spec.to)
 *   build        BuildConfig → ImageStream (spec.output), Build → ImageStream (spec.output)
 *   image        ImageStream → Deployment (ImageStreamTag triggers / internal registry images)
 *   security     SecurityContextConstraints → ServiceAccount / Pod (users[] + openshift.io/scc)
 *   identity     RoleBinding/ClusterRoleBinding → Role/ClusterRole/subjects, ServiceAccount → Pod
 *   storage      PVC → PV, Pod/Deployment → PVC
 *   config       Pod/Deployment → ConfigMap / Secret (env/envFrom/volumes)
 *   scaling      HorizontalPodAutoscaler → scale target
 *   operator     Subscription → ClusterOperator (installed operator health)
 *
 * The module is intentionally dependency-free (no THREE import) so it can be unit
 * tested in Node. ConnectionLineManager draws the returned map; ParticleTrafficSystem
 * derives route/network/build traffic from it.
 *
 * Connection shape (kept identical to the pre-conversion renderer contract):
 *   { id, sourceId, targetId, type, trafficVolume }
 */

const MAX_EDGES_PER_TYPE = 400;

function uidOf(resource) {
  return resource?.uid || resource?.metadata?.uid || null;
}

function kindOf(resource) {
  return resource?.kind || resource?.type || null;
}

function nameOf(resource) {
  return resource?.metadata?.name || resource?.name || '';
}

function namespaceOf(resource) {
  return resource?.metadata?.namespace ?? resource?.namespace ?? '';
}

function specOf(resource) {
  return resource?.spec || {};
}

function labelsOf(resource) {
  return resource?.metadata?.labels || {};
}

function templateLabels(resource) {
  // Deployment/StatefulSet/DaemonSet/Job/CronJob templates
  const spec = specOf(resource);
  const templates = [
    spec.template?.metadata?.labels,
    spec.jobTemplate?.spec?.template?.metadata?.labels,
  ];
  for (const t of templates) {
    if (t && Object.keys(t).length > 0) return t;
  }
  return labelsOf(resource);
}

function podTemplateContainers(resource) {
  const kind = kindOf(resource);
  const spec = specOf(resource);
  if (kind === 'Pod') return spec.containers || [];
  if (kind === 'CronJob') return spec.jobTemplate?.spec?.template?.spec?.containers || [];
  return spec.template?.spec?.containers || [];
}

function podTemplateVolumes(resource) {
  const kind = kindOf(resource);
  const spec = specOf(resource);
  if (kind === 'Pod') return spec.volumes || [];
  if (kind === 'CronJob') return spec.jobTemplate?.spec?.template?.spec?.volumes || [];
  return spec.template?.spec?.volumes || [];
}

function podTemplateServiceAccount(resource) {
  const kind = kindOf(resource);
  const spec = specOf(resource);
  const podSpec = kind === 'Pod'
    ? spec
    : (kind === 'CronJob' ? spec.jobTemplate?.spec?.template?.spec : spec.template?.spec);
  return podSpec?.serviceAccountName || podSpec?.serviceAccount || '';
}

function selectorMatches(selector, labels) {
  if (!selector || typeof selector !== 'object') return false;
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => labels?.[key] === value);
}

/**
 * Strip a tag/digest and return the ImageStream name part of an
 * ImageStreamTag reference (`app:latest` → `app`, `ns/app@sha256:...` → `app`).
 */
export function imageStreamNameFromRef(ref) {
  if (!ref) return null;
  const kind = ref.kind || 'ImageStreamTag';
  if (!String(kind).startsWith('ImageStream')) return null;
  const name = String(ref.name || '');
  if (!name) return null;
  return name.split('@')[0].split(':')[0].split('/').pop();
}

function imageStreamNamespaceFromRef(ref, fallback) {
  const name = String(ref?.name || '');
  if (name.includes('/')) return name.split('/')[0];
  return ref?.namespace || fallback || '';
}

const INTERNAL_REGISTRY_RE = /image-registry\.openshift-image-registry\.svc(?::\d+)?\/([^/]+)\/([^:@/]+)(?::[^@]+)?(?:@sha256:[a-f0-9]+)?/i;

function imageStreamFromImage(image) {
  if (!image) return null;
  const match = INTERNAL_REGISTRY_RE.exec(String(image));
  if (!match) return null;
  return { namespace: match[1], name: match[2] };
}

/** Normalise an operator package/CSV/ClusterOperator name for heuristic matching. */
function normalizeOperatorName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^openshift-/, '')
    .replace(/-operator$/, '')
    .replace(/-operator-v?\d+.*$/, '')
    .replace(/^cluster-/, '');
}

function operatorNamesMatch(a, b) {
  const na = normalizeOperatorName(a);
  const nb = normalizeOperatorName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4) {
    return na.startsWith(nb) || nb.startsWith(na);
  }
  return false;
}

/**
 * Compare two arrays of OwnerReferences / relationships and return unique
 * [sourceUid, targetUid] pairs.
 */
function ownershipPairs(resources, relationships) {
  const pairs = [];
  const seen = new Set();
  const byUid = new Map();
  const byKey = new Map();
  for (const r of resources) {
    const uid = uidOf(r);
    if (!uid) continue;
    byUid.set(uid, r);
    byKey.set(`${kindOf(r)}:${namespaceOf(r)}:${nameOf(r)}`, r);
  }

  const addPair = (parentUid, childUid) => {
    if (!parentUid || !childUid || parentUid === childUid) return;
    if (!byUid.has(parentUid) || !byUid.has(childUid)) return;
    const key = `${parentUid}:${childUid}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([parentUid, childUid]);
  };

  if (relationships && typeof relationships.forEach === 'function') {
    for (const [parentUid, children] of relationships) {
      if (!children) continue;
      for (const childUid of children) addPair(parentUid, childUid);
    }
  }

  for (const r of resources) {
    const refs = r?.metadata?.ownerReferences || [];
    const childUid = uidOf(r);
    for (const ref of refs) {
      let parent = ref?.uid ? byUid.get(ref.uid) : null;
      if (!parent) {
        parent = byKey.get(`${ref.kind}:${namespaceOf(r)}:${ref.name}`) || null;
      }
      if (parent) addPair(uidOf(parent), childUid);
    }
  }

  return pairs;
}

/**
 * Compute the full OpenShift relationship map for a ClusterState.
 *
 * @param {object} clusterState ClusterState-like object exposing getAllResources()/relationships
 * @param {{extraConnections?: Iterable<object>, includeContainment?: boolean}} [options]
 * @returns {Map<string, {id:string, sourceId:string, targetId:string, type:string, trafficVolume:number}>}
 */
export function computeConnections(clusterState, options = {}) {
  const map = new Map();
  const { extraConnections = [], includeContainment = true } = options;

  const resources = typeof clusterState?.getAllResources === 'function'
    ? clusterState.getAllResources()
    : Array.from(clusterState?.resources?.values?.() || []);

  // Deterministic ordering independent of insertion order.
  resources.sort((a, b) => String(uidOf(a) || '').localeCompare(String(uidOf(b) || '')));

  const byKind = new Map();
  for (const r of resources) {
    const kind = kindOf(r);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(r);
  }
  const ofKind = (kind) => byKind.get(kind) || [];

  const findByRef = (kind, name, namespace) => {
    if (!name) return null;
    const candidates = ofKind(kind);
    for (const r of candidates) {
      if (nameOf(r) !== name) continue;
      if (namespace !== undefined && namespace !== null && namespaceOf(r) !== namespace) continue;
      return r;
    }
    return null;
  };

  const edgeCounts = new Map();
  const addEdge = (type, sourceId, targetId, trafficVolume = 1) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const count = edgeCounts.get(type) || 0;
    if (count >= MAX_EDGES_PER_TYPE) return;
    const id = `${type}:${sourceId}:${targetId}`;
    if (map.has(id)) return;
    edgeCounts.set(type, count + 1);
    map.set(id, { id, sourceId, targetId, type, trafficVolume });
  };

  // Custom/user-drawn connections first (draw page), then derived edges.
  for (const conn of extraConnections) {
    if (!conn) continue;
    const id = conn.id || `custom:${conn.sourceId}:${conn.targetId}`;
    if (map.has(id)) continue;
    map.set(id, {
      id,
      sourceId: conn.sourceId,
      targetId: conn.targetId,
      type: conn.type || 'custom',
      trafficVolume: conn.trafficVolume ?? 1,
    });
  }

  // ── ownership ────────────────────────────────────────────────────────────
  for (const [parentUid, childUid] of ownershipPairs(resources, clusterState?.relationships)) {
    addEdge('ownership', parentUid, childUid, 1);
  }

  // ── project containment (Project replaces Namespace) ────────────────────
  if (includeContainment) {
    const projects = new Map();
    for (const p of ofKind('Project')) projects.set(nameOf(p), p);
    for (const r of resources) {
      const kind = kindOf(r);
      if (kind === 'Project' || kind === 'Node') continue;
      const ns = namespaceOf(r);
      if (!ns) continue;
      const project = projects.get(ns);
      if (project) addEdge('containment', uidOf(project), uidOf(r), 1);
    }
  }

  // ── Route → Service → Pod / Deployment ───────────────────────────────────
  for (const route of ofKind('Route')) {
    const spec = specOf(route);
    const ns = namespaceOf(route);
    const toRef = spec.to || {};
    if (toRef.name && (!toRef.kind || String(toRef.kind).toLowerCase() === 'service')) {
      const svc = findByRef('Service', toRef.name, ns);
      if (svc) addEdge('route', uidOf(route), uidOf(svc), 3);
    }
    for (const targetRef of spec.alternateBackends || []) {
      if (targetRef?.name) {
        const svc = findByRef('Service', targetRef.name, ns);
        if (svc) addEdge('route', uidOf(route), uidOf(svc), 2);
      }
    }
  }

  for (const svc of ofKind('Service')) {
    const spec = specOf(svc);
    const ns = namespaceOf(svc);
    const selector = spec.selector;
    if (!selector || Object.keys(selector).length === 0) continue;

    for (const pod of ofKind('Pod')) {
      if (namespaceOf(pod) !== ns) continue;
      if (selectorMatches(selector, labelsOf(pod))) {
        addEdge('network', uidOf(svc), uidOf(pod), 2);
      }
    }
    for (const workloadKind of ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'DeploymentConfig']) {
      for (const workload of ofKind(workloadKind)) {
        if (namespaceOf(workload) !== ns) continue;
        if (selectorMatches(selector, templateLabels(workload))) {
          addEdge('network', uidOf(svc), uidOf(workload), 3);
        }
      }
    }
  }

  // ── BuildConfig → ImageStream, Build → BuildConfig/ImageStream ──────────
  for (const buildConfig of ofKind('BuildConfig')) {
    const outputTo = specOf(buildConfig).output?.to;
    const isName = imageStreamNameFromRef(outputTo);
    if (isName) {
      const stream = findByRef('ImageStream', isName, imageStreamNamespaceFromRef(outputTo, namespaceOf(buildConfig)));
      if (stream) addEdge('build', uidOf(buildConfig), uidOf(stream), 2);
    }
  }

  for (const build of ofKind('Build')) {
    const spec = specOf(build);
    const ns = namespaceOf(build);
    const outputTo = spec.output?.to || spec.output;
    const isName = imageStreamNameFromRef(outputTo);
    if (isName) {
      const stream = findByRef('ImageStream', isName, imageStreamNamespaceFromRef(outputTo, ns));
      if (stream) addEdge('build', uidOf(build), uidOf(stream), 2);
    }
    const bcName = build.metadata?.labels?.['buildconfig'] || build.metadata?.labels?.['openshift.io/build-config.name'];
    if (bcName) {
      const bc = findByRef('BuildConfig', bcName, ns);
      if (bc) addEdge('build', uidOf(build), uidOf(bc), 1);
    }
  }

  // ── ImageStream → Deployment (image triggers / internal registry) ───────
  for (const workloadKind of ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet']) {
    for (const workload of ofKind(workloadKind)) {
      const ns = namespaceOf(workload);
      const spec = specOf(workload);
      const linked = new Set();

      for (const trigger of spec.triggers || []) {
        const from = trigger?.imageChangeParams?.from || trigger?.from;
        const isName = imageStreamNameFromRef(from);
        if (!isName) continue;
        const isNs = imageStreamNamespaceFromRef(from, ns);
        const stream = findByRef('ImageStream', isName, isNs);
        if (stream) {
          addEdge('image', uidOf(stream), uidOf(workload), 2);
          linked.add(`${isNs}/${isName}`);
        }
      }

      for (const container of podTemplateContainers(workload)) {
        const parsed = imageStreamFromImage(container?.image);
        if (!parsed) continue;
        const key = `${parsed.namespace}/${parsed.name}`;
        if (linked.has(key)) continue;
        const stream = findByRef('ImageStream', parsed.name, parsed.namespace);
        if (stream) {
          addEdge('image', uidOf(stream), uidOf(workload), 2);
          linked.add(key);
        }
      }
    }
  }

  // ── SCC → ServiceAccount / Pod ───────────────────────────────────────────
  for (const scc of ofKind('SecurityContextConstraints')) {
    const spec = specOf(scc);
    const users = Array.isArray(spec.users) ? spec.users : [];
    if (users.length === 0) continue;
    const userIndex = new Map();
    for (const user of users) {
      if (typeof user === 'string' && user.startsWith('system:serviceaccount:')) {
        const [, , ns, saName] = user.split(':');
        userIndex.set(`${ns}/${saName}`, user);
      }
    }
    if (userIndex.size === 0) continue;

    for (const sa of ofKind('ServiceAccount')) {
      const key = `${namespaceOf(sa)}/${nameOf(sa)}`;
      if (userIndex.has(key)) addEdge('security', uidOf(scc), uidOf(sa), 2);
    }
    for (const pod of ofKind('Pod')) {
      const sccAnnotation = pod.metadata?.annotations?.['openshift.io/scc'];
      if (sccAnnotation && sccAnnotation === nameOf(scc)) {
        addEdge('security', uidOf(scc), uidOf(pod), 2);
        continue;
      }
      const key = `${namespaceOf(pod)}/${podTemplateServiceAccount(pod)}`;
      if (podTemplateServiceAccount(pod) && userIndex.has(key)) {
        addEdge('security', uidOf(scc), uidOf(pod), 1);
      }
    }
  }

  // ── RBAC identity graph ──────────────────────────────────────────────────
  for (const bindingKind of ['RoleBinding', 'ClusterRoleBinding']) {
    for (const binding of ofKind(bindingKind)) {
      const spec = specOf(binding);
      const roleRef = spec.roleRef || {};
      if (roleRef.name) {
        const roleKind = roleRef.kind === 'ClusterRole' ? 'ClusterRole' : 'Role';
        const role = findByRef(roleKind, roleRef.name, roleKind === 'Role' ? namespaceOf(binding) : undefined);
        if (role) addEdge('identity', uidOf(binding), uidOf(role), 2);
      }
      for (const subject of spec.subjects || []) {
        if (!subject?.name) continue;
        if (subject.kind === 'ServiceAccount') {
          const sa = findByRef('ServiceAccount', subject.name, subject.namespace || namespaceOf(binding));
          if (sa) addEdge('identity', uidOf(binding), uidOf(sa), 1);
        } else if (subject.kind === 'User') {
          const user = findByRef('User', subject.name);
          if (user) addEdge('identity', uidOf(binding), uidOf(user), 1);
        } else if (subject.kind === 'Group') {
          const group = findByRef('Group', subject.name);
          if (group) addEdge('identity', uidOf(binding), uidOf(group), 1);
        }
      }
    }
  }

  for (const pod of ofKind('Pod')) {
    const saName = podTemplateServiceAccount(pod);
    if (!saName || saName === 'default') continue;
    const sa = findByRef('ServiceAccount', saName, namespaceOf(pod));
    if (sa) addEdge('identity', uidOf(sa), uidOf(pod), 1);
  }

  // ── HPA / PDB scaling graph ──────────────────────────────────────────────
  for (const hpa of ofKind('HorizontalPodAutoscaler')) {
    const ref = specOf(hpa).scaleTargetRef || {};
    if (!ref.name) continue;
    const target = findByRef(ref.kind || 'Deployment', ref.name, namespaceOf(hpa));
    if (target) addEdge('scaling', uidOf(hpa), uidOf(target), 2);
  }
  for (const pdb of ofKind('PodDisruptionBudget')) {
    const selector = specOf(pdb).selector?.matchLabels;
    if (!selector) continue;
    for (const workloadKind of ['Deployment', 'StatefulSet', 'ReplicaSet']) {
      for (const workload of ofKind(workloadKind)) {
        if (namespaceOf(workload) !== namespaceOf(pdb)) continue;
        if (selectorMatches(selector, templateLabels(workload))) {
          addEdge('scaling', uidOf(pdb), uidOf(workload), 1);
        }
      }
    }
  }

  // ── storage graph ────────────────────────────────────────────────────────
  const volumesByKey = new Map();
  for (const claim of ofKind('PersistentVolumeClaim')) {
    volumesByKey.set(`${namespaceOf(claim)}/${nameOf(claim)}`, claim);
    const pvName = specOf(claim).volumeName;
    if (pvName) {
      const pv = findByRef('PersistentVolume', pvName);
      if (pv) addEdge('storage', uidOf(claim), uidOf(pv), 1);
    }
  }
  for (const workloadKind of ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']) {
    for (const workload of ofKind(workloadKind)) {
      const ns = namespaceOf(workload);
      for (const volume of podTemplateVolumes(workload)) {
        const claimName = volume?.persistentVolumeClaim?.claimName;
        if (!claimName) continue;
        const claim = volumesByKey.get(`${ns}/${claimName}`);
        if (claim) addEdge('storage', uidOf(workload), uidOf(claim), 1);
      }
      // StatefulSet volumeClaimTemplates are per-ordinal; link the template's StorageClass if present.
      const vcts = specOf(workload).volumeClaimTemplates || [];
      for (const vct of vcts) {
        const className = vct?.spec?.storageClassName;
        if (!className) continue;
        const sc = findByRef('StorageClass', className);
        if (sc) addEdge('storage', uidOf(workload), uidOf(sc), 1);
      }
    }
  }

  // ── config references (ConfigMap / Secret consumed by workloads) ─────────
  const configMaps = new Map();
  for (const cm of ofKind('ConfigMap')) configMaps.set(`${namespaceOf(cm)}/${nameOf(cm)}`, cm);
  const secrets = new Map();
  for (const secret of ofKind('Secret')) secrets.set(`${namespaceOf(secret)}/${nameOf(secret)}`, secret);

  const addConfigEdge = (workload, refs) => {
    const ns = namespaceOf(workload);
    for (const [kind, refName] of refs) {
      if (!refName) continue;
      const target = kind === 'ConfigMap' ? configMaps.get(`${ns}/${refName}`) : secrets.get(`${ns}/${refName}`);
      if (target) addEdge('config', uidOf(workload), uidOf(target), 1);
    }
  };

  for (const workloadKind of ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job']) {
    for (const workload of ofKind(workloadKind)) {
      const refs = [];
      const addContainerRefs = (container) => {
        for (const envFrom of container?.envFrom || []) {
          if (envFrom.configMapRef?.name) refs.push(['ConfigMap', envFrom.configMapRef.name]);
          if (envFrom.secretRef?.name) refs.push(['Secret', envFrom.secretRef.name]);
        }
        for (const env of container?.env || []) {
          if (env.valueFrom?.configMapKeyRef?.name) refs.push(['ConfigMap', env.valueFrom.configMapKeyRef.name]);
          if (env.valueFrom?.secretKeyRef?.name) refs.push(['Secret', env.valueFrom.secretKeyRef.name]);
        }
      };
      for (const container of podTemplateContainers(workload)) addContainerRefs(container);
      for (const volume of podTemplateVolumes(workload)) {
        if (volume?.configMap?.name) refs.push(['ConfigMap', volume.configMap.name]);
        if (volume?.secret?.secretName) refs.push(['Secret', volume.secret.secretName]);
      }
      addConfigEdge(workload, refs);
    }
  }

  // ── operator graph (Subscription → ClusterOperator) ─────────────────────
  for (const subscription of ofKind('Subscription')) {
    const spec = specOf(subscription);
    const packageName = spec.packageName || spec.name || nameOf(subscription);
    const installedCSV = subscription.status?.installedCSV || '';
    for (const co of ofKind('ClusterOperator')) {
      const coName = nameOf(co);
      if (operatorNamesMatch(packageName, coName) || (installedCSV && operatorNamesMatch(installedCSV, coName))) {
        addEdge('operator', uidOf(subscription), uidOf(co), 2);
      }
    }
  }

  return map;
}

/**
 * Convenience wrapper: relationship edges grouped by type, useful for debugging
 * and for the verifier.
 * @returns {Record<string, object[]>}
 */
export function connectionsByType(connectionsMap) {
  /** @type {Record<string, object[]>} */
  const result = {};
  for (const connection of connectionsMap.values()) {
    if (!result[connection.type]) result[connection.type] = [];
    result[connection.type].push(connection);
  }
  return result;
}

export default { computeConnections, connectionsByType, imageStreamNameFromRef };
