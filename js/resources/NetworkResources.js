import { ResourceBase } from './ResourceBase.js';
import { deepClone } from './ManifestSerializer.js';

const timestamp = () => new Date().toISOString();

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

/** OCP 4.22 default serviceNetwork is 172.30.0.0/16 (not the kubeadm 10.96/12 range). */
const SERVICE_NETWORK_PREFIX = '172.30';

/** Simulator-internal annotations must never leak into `oc describe` output. */
const INTERNAL_ANNOTATION_PREFIX_RE = /^openshiftgames(?:\.io)?\//;

/**
 * Allocate a ClusterIP from the simulated service network, skipping IPs that
 * are already assigned to another Service — the job of the real API server's
 * ClusterIP allocator (issues #59/#60).
 *
 * @param {string[]} [usedClusterIPs] ClusterIPs currently in use in the cluster
 * @returns {string} e.g. `172.30.42.7`
 */
export function allocateClusterIP(usedClusterIPs = []) {
  const used = new Set(
    (Array.isArray(usedClusterIPs) ? usedClusterIPs : []).filter(
      (ip) => typeof ip === 'string' && ip !== '' && ip !== 'None'
    )
  );
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const candidate = `${SERVICE_NETWORK_PREFIX}.${randomInt(256)}.${randomInt(254) + 1}`;
    if (!used.has(candidate)) return candidate;
  }
  // Deterministic fallback for a (theoretical) exhausted random walk.
  for (let third = 0; third < 256; third += 1) {
    for (let fourth = 1; fourth < 255; fourth += 1) {
      const candidate = `${SERVICE_NETWORK_PREFIX}.${third}.${fourth}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  return `${SERVICE_NETWORK_PREFIX}.0.1`;
}

/**
 * Apply the API-server defaulting a real 4.22 kube-apiserver performs when a
 * Service is created or updated (issues #59/#60). This is the single shared
 * defaulting helper for the rich `Service` class and the
 * `GameEngine.applyManifestObject()` upsert path:
 *
 *  - `spec.type` defaults to `ClusterIP`;
 *  - ClusterIP/NodePort/LoadBalancer Services get an allocated `clusterIP`
 *    (unless headless: `clusterIP: None`), `clusterIPs`, `ipFamilies`,
 *    `ipFamilyPolicy`, `sessionAffinity: None` and `internalTrafficPolicy:
 *    Cluster`; ExternalName Services keep none of the clusterIP fields;
 *  - every port gets `protocol: TCP` and `targetPort` (defaults to the port);
 *  - NodePort/LoadBalancer ports get an allocated `nodePort` from 30000-32767.
 *
 * An update (apply) must preserve the ClusterIP allocated by the previous
 * object when the manifest omits it — pass it as `options.clusterIP`.
 *
 * @param {object} [spec] Service spec from a manifest / constructor defaults
 * @param {{clusterIP?: string, usedClusterIPs?: string[]}} [options]
 * @returns {object} a new, fully-defaulted spec object
 */
export function defaultServiceSpec(spec = {}, options = {}) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const next = deepClone(source);
  if (!next.type) next.type = 'ClusterIP';
  if (Array.isArray(next.ports)) {
    next.ports = next.ports.map((port) => {
      if (!port || typeof port !== 'object') return port;
      const entry = { ...port };
      if (!entry.protocol) entry.protocol = 'TCP';
      if (entry.targetPort === undefined || entry.targetPort === null || entry.targetPort === '') {
        entry.targetPort = entry.port;
      }
      return entry;
    });
  }
  if (!next.sessionAffinity) next.sessionAffinity = 'None';
  const isLoadBalancerType = next.type === 'NodePort' || next.type === 'LoadBalancer';
  if (next.type === 'ExternalName') {
    // The API server never allocates a ClusterIP for an ExternalName Service.
    delete next.clusterIP;
    delete next.clusterIPs;
    delete next.ipFamilies;
    delete next.ipFamilyPolicy;
    delete next.internalTrafficPolicy;
    delete next.externalTrafficPolicy;
    return next;
  }
  const preservedClusterIP =
    (typeof next.clusterIP === 'string' && next.clusterIP) || options.clusterIP || '';
  next.clusterIP = preservedClusterIP || allocateClusterIP(options.usedClusterIPs || []);
  // The API defaults spec.clusterIPs to the allocated ClusterIP ([] when headless).
  next.clusterIPs = next.clusterIP === 'None' ? [] : [next.clusterIP];
  if (!Array.isArray(next.ipFamilies) || next.ipFamilies.length === 0) next.ipFamilies = ['IPv4'];
  if (!next.ipFamilyPolicy) next.ipFamilyPolicy = 'SingleStack';
  if (!next.internalTrafficPolicy) next.internalTrafficPolicy = 'Cluster';
  if (isLoadBalancerType) {
    if (!next.externalTrafficPolicy) next.externalTrafficPolicy = 'Cluster';
    if (Array.isArray(next.ports)) {
      next.ports = next.ports.map((port) =>
        port && port.nodePort === undefined ? { ...port, nodePort: allocateNodePort() } : port
      );
    }
    if (next.type === 'LoadBalancer' && next.allocateLoadBalancerNodePorts === undefined) {
      next.allocateLoadBalancerNodePorts = true;
    }
  }
  return next;
}

/** Allocate a random nodePort from the API server's 30000-32767 range. */
function allocateNodePort() {
  return 30000 + randomInt(2768);
}

/** `Object.entries` sorted by key (labels/annotations/selectors are sorted on output). */
function sortedEntries(object) {
  return Object.entries(object || {}).sort(([left], [right]) => left.localeCompare(right));
}

/** `k=v,k2=v2` sorted, `labels.FormatLabels` style. */
function formatServiceSelector(selector) {
  const entries = sortedEntries(selector);
  if (!entries.length) return '<none>';
  return entries.map(([key, value]) => `${key}=${value}`).join(',');
}

/** Tabwriter-style describe rows with one label per line + continuation lines. */
function addMultilineDescribeRows(rows, title, values) {
  if (!values.length) {
    rows.push([`${title}:`, '<none>']);
    return;
  }
  rows.push([`${title}:`, values[0]]);
  for (const value of values.slice(1)) rows.push(['', value]);
}

/** The TargetPort column value: spec value verbatim (int or named string). */
function formatServiceTargetPort(targetPort, port) {
  const value = targetPort === undefined || targetPort === null ? port : targetPort;
  return value === undefined || value === null ? '' : String(value);
}

/** Endpoint address of a ready-pod endpoint entry (rich Pod or stored endpoint). */
function endpointAddress(endpoint) {
  return endpoint?.status?.podIP || endpoint?.ip || endpoint?.address || null;
}

/**
 * EndpointSlice port for a Service port: the resolved targetPort, as a number
 * (named target ports are resolved against the endpoint Pod's container ports).
 *
 * A named targetPort is looked up in every container of the endpoint Pod and
 * the LAST matching container port wins. That is what the real EndpointSlice
 * controller does for the 4.22 `dns-default` Pods: both the CoreDNS container
 * and the `kube-rbac-proxy` sidecar declare a `metrics` port, and the Service's
 * `metrics` targetPort must resolve to the sidecar's 9154, not CoreDNS' 9153
 * (issue #62E). Numeric target ports are returned verbatim.
 *
 * @param {{targetPort?: number|string, port?: number}} port Service port
 * @param {{spec?: {containers?: object[]}}} [endpoint] ready endpoint Pod
 * @returns {number|null}
 */
export function resolveEndpointPort(port, endpoint) {
  const target = port?.targetPort ?? port?.port;
  if (typeof target === 'number' && Number.isFinite(target)) return target;
  const text = String(target ?? '');
  if (/^\d+$/.test(text)) return Number(text);
  let namedPort = null;
  for (const container of endpoint?.spec?.containers || []) {
    for (const entry of container.ports || []) {
      if (entry.name === text && Number.isFinite(Number(entry.containerPort)))
        namedPort = Number(entry.containerPort);
    }
  }
  if (namedPort !== null) return namedPort;
  const servicePort = Number(port?.port);
  return Number.isFinite(servicePort) ? servicePort : null;
}

/**
 * Render describe rows the way Go's `text/tabwriter` does with the settings
 * kubectl uses for `oc describe` (minwidth 0, tabwidth 8, padding 2, spaces):
 * every tab-terminated cell is padded to the widest cell of its column block
 * plus two spaces; the trailing cell of a line is never padded. A line with
 * fewer cells ends the current column block (which is why a `Port:` line's
 * name column is padded on its own).
 *
 * @param {Array<Array<string>>} rows cells; all but the last element are padded
 * @returns {string}
 */
function renderDescribeRows(rows) {
  const widths = rows.map(() => []);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length - 1), 0);
  for (let column = 0; column < columnCount; column += 1) {
    let block = [];
    const flushBlock = () => {
      if (!block.length) return;
      const width = Math.max(...block.map((index) => String(rows[index][column] ?? '').length)) + 2;
      for (const index of block) widths[index][column] = width;
      block = [];
    };
    rows.forEach((row, index) => {
      if (row.length - 1 > column) block.push(index);
      else flushBlock();
    });
    flushBlock();
  }
  return rows
    .map((row, index) => {
      let line = '';
      for (let column = 0; column < row.length - 1; column += 1) {
        line += String(row[column] ?? '').padEnd(widths[index][column] || 0);
      }
      line += String(row[row.length - 1] ?? '');
      return line.replace(/\s+$/, '');
    })
    .join('\n');
}

export class Service extends ResourceBase {
  constructor(metadata = {}) {
    super('Service', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const name = metadata.name || 'unnamed';
    const type = metadata.serviceType || metadata.type || 'ClusterIP';
    const defaults = {
      type,
      selector: deepClone(metadata.selector || { app: name }),
      ports: deepClone(
        metadata.ports || [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }]
      ),
    };
    if (type === 'ExternalName') {
      defaults.externalName = metadata.externalName || 'example.com';
      delete defaults.selector;
      delete defaults.ports;
    }
    if (metadata.externalIPs) defaults.externalIPs = deepClone(metadata.externalIPs);
    if (metadata.loadBalancerIP) defaults.loadBalancerIP = metadata.loadBalancerIP;
    this._initSpec(defaults, metadata.spec);
    // Exactly the shape the API server stores: type/selector/ports plus the
    // defaulted clusterIP(s), ipFamilies/IPFamilyPolicy, traffic policies and
    // port defaults (shared with GameEngine.applyManifestObject).
    this.spec = defaultServiceSpec(this.spec, { clusterIP: metadata.clusterIP });

    this.endpoints = [];
    this.trafficRate = 0;
    this.totalRequests = 0;
    this.loadBalancerPending = this.spec.type === 'LoadBalancer';
    this.loadBalancerTimer = 0;
    // A Service has no phase/conditions/observedGeneration: the real status
    // subresource only carries the (initially empty) LoadBalancer status.
    this.status = { loadBalancer: {} };
  }

  get type() {
    return this.spec.type;
  }

  get externalIP() {
    return this.status.loadBalancer?.ingress?.[0]?.ip || '';
  }

  getSelector() {
    return this.spec.selector || {};
  }

  setSelector(selector) {
    this.spec.selector = deepClone(selector || {});
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  addPort(port) {
    this.spec.ports = this.spec.ports || [];
    this.spec.ports.push(deepClone(port));
    this.metadata.generation++;
    this._bumpResourceVersion();
    return this;
  }

  matchesPod(pod) {
    const selector = this.spec.selector || {};
    return Object.entries(selector).every(([k, v]) => pod.metadata.labels[k] === v);
  }

  /**
   * Replace the instance endpoint bookkeeping from a list of ready Pods.
   * SimulationTick._tickProbes feeds it ClusterState.getServiceEndpoints(),
   * which stays the canonical resolver shared by `oc describe svc`, the
   * virtual Endpoints view, the router and the metrics (issues #59/#60).
   * @param {object[]} pods
   * @returns {{ip: string, nodeName?: string, namespace?: string, targetRef: object}[]}
   */
  updateEndpoints(pods) {
    this.endpoints = (Array.isArray(pods) ? pods : [])
      .filter(
        (pod) =>
          pod.isReady?.() !== false && pod.status?.phase === 'Running' && this.matchesPod(pod)
      )
      .map((pod) => ({
        ip: pod.status?.podIP || pod.ip,
        nodeName: pod.spec?.nodeName,
        namespace: pod.metadata?.namespace,
        targetRef: { kind: 'Pod', name: pod.metadata.name, uid: pod.metadata.uid },
      }));
    return this.endpoints;
  }

  routeTraffic() {
    if (this.endpoints.length === 0) return null;
    this.totalRequests++;
    return this.endpoints[randomInt(this.endpoints.length)];
  }

  /** Mark the LoadBalancer service as provisioned with an IP. */
  setLoadBalancerIP(ip) {
    this.status.loadBalancer = { ingress: [{ ip, hostname: '' }] };
    this.loadBalancerPending = false;
    this.addEvent('Normal', 'EnsuredLoadBalancer', `Ensured load balancer with IP ${ip}`);
    return this;
  }

  /**
   * Real OCP 4.22 `oc describe svc` output (issues #59/#60).
   *
   * kubectl renders the header with its describe tabwriter (minwidth 0,
   * tabwidth 8, padding 2) and repeats one Port/TargetPort/(NodePort)/Endpoints
   * block per Service port. Endpoints are the ready pod addresses the canonical
   * ClusterState.getServiceEndpoints() resolver returns (pass
   * `{ cluster: this.cluster }` from `oc describe`); with no cluster the
   * instance `endpoints` bookkeeping is used (InspectorPanel).
   *
   * @param {{cluster?: {getServiceEndpoints?: Function}}} [opts]
   * @returns {string}
   */
  toDescribe(opts = {}) {
    const cluster = opts?.cluster || null;
    const endpoints =
      cluster && typeof cluster.getServiceEndpoints === 'function'
        ? cluster.getServiceEndpoints(this)
        : this.endpoints;
    const endpointList = Array.isArray(endpoints) ? endpoints : [];
    const rows = [];
    rows.push(['Name:', this.metadata.name]);
    rows.push(['Namespace:', this.metadata.namespace]);
    addMultilineDescribeRows(
      rows,
      'Labels',
      sortedEntries(this.metadata.labels).map(([key, value]) => `${key}=${value}`)
    );
    addMultilineDescribeRows(
      rows,
      'Annotations',
      sortedEntries(this.metadata.annotations)
        .filter(([key]) => !INTERNAL_ANNOTATION_PREFIX_RE.test(key))
        .map(([key, value]) => `${key}: ${value}`)
    );
    rows.push(['Selector:', formatServiceSelector(this.spec.selector)]);
    rows.push(['Type:', this.spec.type || 'ClusterIP']);
    if (this.spec.ipFamilyPolicy) rows.push(['IP Family Policy:', this.spec.ipFamilyPolicy]);
    const ipFamilies = Array.isArray(this.spec.ipFamilies) ? this.spec.ipFamilies : [];
    rows.push(['IP Families:', ipFamilies.length ? ipFamilies.join(',') : '<none>']);
    rows.push(['IP:', this.spec.clusterIP || '']);
    const clusterIPs = Array.isArray(this.spec.clusterIPs) ? this.spec.clusterIPs : [];
    rows.push(['IPs:', clusterIPs.length ? clusterIPs.join(',') : '<none>']);
    if (Array.isArray(this.spec.externalIPs) && this.spec.externalIPs.length) {
      rows.push(['External IPs:', this.spec.externalIPs.join(',')]);
    }
    if (this.spec.loadBalancerIP) {
      rows.push(['Desired LoadBalancer IP:', this.spec.loadBalancerIP]);
    }
    if (this.spec.externalName) rows.push(['External Name:', this.spec.externalName]);
    const ingressAddresses = (this.status.loadBalancer?.ingress || [])
      .map((entry) => entry?.ip || entry?.hostname || '')
      .filter(Boolean);
    if (ingressAddresses.length) {
      rows.push(['LoadBalancer Ingress:', ingressAddresses.join(', ')]);
    }
    for (const port of this.spec.ports || []) {
      const protocol = port.protocol || 'TCP';
      const name = port.name || '<unset>';
      rows.push(['Port:', name, `${port.port}/${protocol}`]);
      rows.push([
        'TargetPort:',
        `${formatServiceTargetPort(port.targetPort, port.port)}/${protocol}`,
      ]);
      if (port.appProtocol) rows.push(['AppProtocol:', port.appProtocol]);
      if (port.nodePort) rows.push(['NodePort:', name, `${port.nodePort}/${protocol}`]);
      rows.push([
        'Endpoints:',
        formatEndpointAddresses(this._endpointAddressesForPort(port, endpointList), 3),
      ]);
    }
    rows.push(['Session Affinity:', this.spec.sessionAffinity || 'None']);
    if (this.spec.externalTrafficPolicy) {
      rows.push(['External Traffic Policy:', this.spec.externalTrafficPolicy]);
    }
    // kubectl 1.35's describeService (the OCP 4.22 `oc`) prints the API-server
    // defaulted internalTrafficPolicy (issue #69 P4). The 24-char label is the
    // longest top-level one here, so tabwriter starts every value at column 27.
    if (this.spec.internalTrafficPolicy) {
      rows.push(['Internal Traffic Policy:', this.spec.internalTrafficPolicy]);
    }
    if (this.spec.healthCheckNodePort) {
      rows.push(['HealthCheck NodePort:', String(this.spec.healthCheckNodePort)]);
    }
    if (
      Array.isArray(this.spec.loadBalancerSourceRanges) &&
      this.spec.loadBalancerSourceRanges.length
    ) {
      rows.push(['LoadBalancer Source Ranges:', this.spec.loadBalancerSourceRanges.join(',')]);
    }
    // kubectl 1.35 prints the operator-set trafficDistribution last, after the
    // LoadBalancer source ranges — the cluster-dns-operator's 4.22 dns-default
    // asset sets PreferSameNode (issue #69 P4).
    if (this.spec.trafficDistribution) {
      rows.push(['Traffic Distribution:', this.spec.trafficDistribution]);
    }
    // CommandBar._describeResource replaces everything from this header with
    // the live aggregated Events table; the bare section keeps InspectorPanel
    // (which calls toDescribe() without a cluster) readable.
    rows.push(['Events:', '<none>']);
    return renderDescribeRows(rows);
  }

  /** `<ip>:<resolved targetPort>` endpoint addresses for one Service port. */
  _endpointAddressesForPort(port, endpoints) {
    const addresses = [];
    for (const endpoint of endpoints) {
      const ip = endpointAddress(endpoint);
      if (!ip) continue;
      const portNumber = resolveEndpointPort(port, endpoint);
      addresses.push(Number.isFinite(portNumber) ? `${ip}:${portNumber}` : String(ip));
    }
    return addresses;
  }
}

export class Ingress extends ResourceBase {
  constructor(metadata = {}) {
    super('Ingress', { ...metadata, apiVersion: metadata.apiVersion || 'networking.k8s.io/v1' });
    const name = metadata.name || 'unnamed';
    const defaults = {
      ingressClassName: metadata.ingressClassName || 'openshift-default',
      tls: deepClone(metadata.tls || []),
      rules: deepClone(
        metadata.rules || [
          {
            host: metadata.host || `${name}.apps.cluster.example.com`,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: metadata.backendService || name,
                      port: { number: metadata.backendPort || 80 },
                    },
                  },
                },
              ],
            },
          },
        ]
      ),
    };
    if (metadata.defaultBackend) defaults.defaultBackend = deepClone(metadata.defaultBackend);
    this._initSpec(defaults, metadata.spec);

    this.backendServices = new Map();
    this.requestCount = 0;
    this.loadBalancerPending = true;
    this.loadBalancerTimer = 0;
    this._setInitialStatus({ phase: 'Active', loadBalancer: { ingress: [] } });
  }

  get loadBalancerIP() {
    return this.status.loadBalancer?.ingress?.[0]?.ip || null;
  }

  setLoadBalancer(address) {
    const entry = String(address || '').includes(':') ? { hostname: address } : { ip: address };
    this.status.loadBalancer = { ingress: [entry] };
    this.loadBalancerPending = false;
    this.addEvent('Normal', 'Sync', 'Scheduled for sync');
    return this;
  }

  addTLS(hosts, secretName) {
    this.spec.tls = this.spec.tls || [];
    this.spec.tls.push({ hosts: deepClone(hosts), secretName });
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent('Normal', 'UpdatedTLS', `TLS configured for ${hosts.join(', ')}`);
    return this;
  }

  addRule(host, path, serviceName, servicePort) {
    const pathEntry = {
      path,
      pathType: 'Prefix',
      backend: { service: { name: serviceName, port: { number: servicePort } } },
    };
    const existingRule = (this.spec.rules || []).find((r) => r.host === host);
    if (existingRule) {
      existingRule.http.paths.push(pathEntry);
    } else {
      this.spec.rules = this.spec.rules || [];
      this.spec.rules.push({ host, http: { paths: [pathEntry] } });
    }
    this.metadata.generation++;
    this._bumpResourceVersion();
    this.addEvent(
      'Normal',
      'UpdatedIngress',
      `Added rule: ${host}${path} -> ${serviceName}:${servicePort}`
    );
    return this;
  }

  routeRequest(host, path) {
    this.requestCount++;
    const rule = (this.spec.rules || []).find((r) => r.host === host);
    if (!rule) return this.spec.defaultBackend || null;
    const matchedPath = [...(rule.http?.paths || [])]
      .sort((a, b) => (b.path || '').length - (a.path || '').length)
      .find((p) => String(path).startsWith(p.path || '/'));
    return matchedPath ? matchedPath.backend : this.spec.defaultBackend || null;
  }

  getBackendServices() {
    const names = [];
    for (const rule of this.spec.rules || []) {
      for (const pathEntry of rule.http?.paths || []) {
        const svc = pathEntry.backend?.service?.name;
        if (svc && !names.includes(svc)) names.push(svc);
      }
    }
    return names;
  }

  toDescribe() {
    return `Name:             ${this.metadata.name}
Namespace:        ${this.metadata.namespace}
Address:          ${this.loadBalancerIP || '<pending>'}
Ingress Class:    ${this.spec.ingressClassName}
Default backend:  ${
      this.spec.defaultBackend
        ? `${this.spec.defaultBackend.service.name}:${this.spec.defaultBackend.service.port.number}`
        : '<default>'
    }
TLS:
${(this.spec.tls || []).map((t) => `  ${t.secretName} terminates ${(t.hosts || []).join(',')}`).join('\n') || '  <none>'}
Rules:
  Host              Path  Backends
  ----              ----  --------
${(this.spec.rules || [])
  .map((r) =>
    (r.http?.paths || [])
      .map(
        (p) => `  ${r.host}  ${p.path}  ${p.backend.service.name}:${p.backend.service.port.number}`
      )
      .join('\n')
  )
  .join('\n')}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

export class NetworkPolicy extends ResourceBase {
  constructor(metadata = {}) {
    super('NetworkPolicy', {
      ...metadata,
      apiVersion: metadata.apiVersion || 'networking.k8s.io/v1',
    });
    const defaults = {
      podSelector: {
        matchLabels: deepClone(
          metadata.podSelector || (metadata.name ? { app: metadata.name } : {})
        ),
      },
      policyTypes: metadata.policyTypes || ['Ingress', 'Egress'],
      ingress: deepClone(
        metadata.ingress || [
          {
            from: [{ podSelector: { matchLabels: { role: 'frontend' } } }],
            ports: [{ protocol: 'TCP', port: 80 }],
          },
        ]
      ),
      egress: deepClone(
        metadata.egress || [
          {
            to: [{ podSelector: { matchLabels: { role: 'database' } } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ]
      ),
    };
    this._initSpec(defaults, metadata.spec);
    this.affectedPods = [];
    this.blockedConnections = 0;
    this.allowedConnections = 0;
    this._setInitialStatus({
      phase: 'Active',
      conditions: [{ type: 'Active', status: 'True', lastTransitionTime: timestamp() }],
    });
  }

  evaluateIngress(sourcePod, destPod, port) {
    if (!this._matchesPodSelector(destPod)) return true;
    for (const rule of this.spec.ingress || []) {
      const portMatch = !rule.ports || rule.ports.some((p) => String(p.port) === String(port));
      if (!portMatch) continue;
      for (const from of rule.from || []) {
        if (
          from.podSelector &&
          this._labelsMatch(sourcePod.metadata.labels, from.podSelector.matchLabels)
        ) {
          this.allowedConnections++;
          return true;
        }
        if (
          from.namespaceSelector &&
          this._labelsMatch(
            { name: sourcePod.metadata.namespace },
            from.namespaceSelector.matchLabels
          )
        ) {
          this.allowedConnections++;
          return true;
        }
      }
    }
    this.blockedConnections++;
    return false;
  }

  evaluateEgress(sourcePod, destPod, port) {
    if (!this._matchesPodSelector(sourcePod)) return true;
    for (const rule of this.spec.egress || []) {
      const portMatch = !rule.ports || rule.ports.some((p) => String(p.port) === String(port));
      if (!portMatch) continue;
      for (const to of rule.to || []) {
        if (
          to.podSelector &&
          this._labelsMatch(destPod.metadata.labels, to.podSelector.matchLabels)
        ) {
          this.allowedConnections++;
          return true;
        }
        if (
          to.namespaceSelector &&
          this._labelsMatch({ name: destPod.metadata.namespace }, to.namespaceSelector.matchLabels)
        ) {
          this.allowedConnections++;
          return true;
        }
      }
    }
    this.blockedConnections++;
    return false;
  }

  _matchesPodSelector(pod) {
    return this._labelsMatch(pod.metadata.labels, this.spec.podSelector?.matchLabels || {});
  }

  _labelsMatch(labels = {}, selector = {}) {
    return Object.entries(selector).every(([k, v]) => labels[k] === v);
  }

  updateAffectedPods(pods) {
    this.affectedPods = pods.filter((p) => this._matchesPodSelector(p));
    return this.affectedPods;
  }

  getColor() {
    const hasBoth =
      this.spec.policyTypes?.includes('Ingress') && this.spec.policyTypes?.includes('Egress');
    return hasBoth ? '#ef4444' : '#22c55e';
  }

  toDescribe() {
    return `Name:         ${this.metadata.name}
Namespace:    ${this.metadata.namespace}
Spec:
  PodSelector:     ${
    Object.entries(this.spec.podSelector?.matchLabels || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || '<all pods>'
  }
  Allowing ingress traffic:
${(this.spec.ingress || [])
  .map(
    (
      rule
    ) => `    To Port: ${(rule.ports || []).map((p) => `${p.port}/${p.protocol}`).join(', ') || '<all>'}
    From:
${(rule.from || [])
  .map((f) => {
    if (f.podSelector)
      return `      PodSelector: ${Object.entries(f.podSelector.matchLabels || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}`;
    if (f.namespaceSelector)
      return `      NamespaceSelector: ${Object.entries(f.namespaceSelector.matchLabels || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}`;
    return '      <all sources>';
  })
  .join('\n')}`
  )
  .join('\n')}
  Allowing egress traffic:
${(this.spec.egress || [])
  .map(
    (
      rule
    ) => `    To Port: ${(rule.ports || []).map((p) => `${p.port}/${p.protocol}`).join(', ') || '<all>'}
    To:
${(rule.to || [])
  .map((t) => {
    if (t.podSelector)
      return `      PodSelector: ${Object.entries(t.podSelector.matchLabels || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}`;
    if (t.namespaceSelector)
      return `      NamespaceSelector: ${Object.entries(t.namespaceSelector.matchLabels || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}`;
    return '      <all destinations>';
  })
  .join('\n')}`
  )
  .join('\n')}
  Policy Types: ${(this.spec.policyTypes || []).join(', ')}
Affected Pods: ${this.affectedPods.length}
Events:
${this.events
  .slice(-10)
  .map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
  .join('\n')}`;
  }
}

/**
 * Format ready endpoint addresses the way kubectl's `formatEndpoints` /
 * `formatEndpointSlices` do: up to `max` entries, then ` + N more...` with the
 * number of remaining ready endpoints. Shared by `oc get endpoints` (the
 * virtual Endpoints NAME/ENDPOINTS table) and `oc describe svc` so both print
 * the same source of truth (issues #59/#60).
 *
 * @param {string[]} addresses address strings already rendered as `ip:port`
 * @param {number} [max=3]
 * @returns {string}
 */
export function formatEndpointAddresses(addresses, max = 3) {
  const entries = (Array.isArray(addresses) ? addresses : []).filter(
    (entry) => entry !== undefined && entry !== null && entry !== ''
  );
  if (!entries.length) return '<none>';
  if (entries.length <= max) return entries.join(',');
  return `${entries.slice(0, max).join(',')} + ${entries.length - max} more...`;
}

export default { Service, Ingress, NetworkPolicy };
