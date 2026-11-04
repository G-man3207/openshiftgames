import { ResourceBase } from './ResourceBase.js';
import { deepClone } from './ManifestSerializer.js';

const timestamp = () => new Date().toISOString();

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

export class Service extends ResourceBase {
  constructor(metadata = {}) {
    super('Service', { ...metadata, apiVersion: metadata.apiVersion || 'v1' });
    const name = metadata.name || 'unnamed';
    const type = metadata.serviceType || metadata.type || 'ClusterIP';
    const ports = deepClone(
      metadata.ports || [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }]
    );
    const defaults = {
      type,
      selector: deepClone(metadata.selector || { app: name }),
      ports,
      sessionAffinity: metadata.sessionAffinity || 'None',
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
    };
    if (type === 'ExternalName') {
      defaults.externalName = metadata.externalName || 'example.com';
      delete defaults.selector;
      delete defaults.ports;
    }
    if (type === 'NodePort' || type === 'LoadBalancer') {
      defaults.ports = defaults.ports.map((p) => ({
        ...p,
        nodePort: p.nodePort || 30000 + randomInt(2768),
      }));
    }
    if (type === 'LoadBalancer') defaults.allocateLoadBalancerNodePorts = true;
    if (type !== 'ExternalName') {
      defaults.clusterIP = metadata.clusterIP || this._generateClusterIP();
      // The API defaults spec.clusterIPs to the allocated ClusterIP ([] when headless).
      defaults.clusterIPs = defaults.clusterIP === 'None' ? [] : [defaults.clusterIP];
    }
    if (metadata.externalIPs) defaults.externalIPs = deepClone(metadata.externalIPs);
    if (metadata.loadBalancerIP) defaults.loadBalancerIP = metadata.loadBalancerIP;
    this._initSpec(defaults, metadata.spec);
    // Keep the API-defaulted clusterIPs list consistent with any overridden clusterIP.
    if (this.spec.type !== 'ExternalName') {
      if (this.spec.clusterIP === 'None') this.spec.clusterIPs = [];
      else if (this.spec.clusterIP) this.spec.clusterIPs = [this.spec.clusterIP];
    }

    this.endpoints = [];
    this.trafficRate = 0;
    this.totalRequests = 0;
    this.loadBalancerPending = this.spec.type === 'LoadBalancer';
    this.loadBalancerTimer = 0;
    this._setInitialStatus({ phase: 'Active', loadBalancer: { ingress: [] } });
  }

  /** OCP 4.22 default serviceNetwork is 172.30.0.0/16 (not the kubeadm 10.96/12 range). */
  _generateClusterIP() {
    return `172.30.${randomInt(256)}.${randomInt(254) + 1}`;
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

  updateEndpoints(pods) {
    this.endpoints = pods
      .filter((p) => p.isReady?.() !== false && p.status?.phase === 'Running' && this.matchesPod(p))
      .map((p) => ({
        ip: p.status?.podIP || p.ip,
        nodeName: p.spec?.nodeName,
        targetRef: { kind: 'Pod', name: p.metadata.name, uid: p.metadata.uid },
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

  toDescribe() {
    const externalIP =
      this.spec.type === 'LoadBalancer' ? this.externalIP || '<pending>' : '<none>';
    const endpointText =
      this.endpoints.map((e) => `${e.ip}:${this.spec.ports?.[0]?.targetPort ?? ''}`).join(', ') ||
      '<none>';
    const lines = [
      `Name:              ${this.metadata.name}`,
      `Namespace:         ${this.metadata.namespace}`,
      `Labels:            ${
        Object.entries(this.metadata.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || '<none>'
      }`,
      `Annotations:       ${
        Object.entries(this.metadata.annotations)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || '<none>'
      }`,
      `Selector:          ${
        Object.entries(this.spec.selector || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(',') || '<none>'
      }`,
      `Type:              ${this.spec.type}`,
      `IP:                ${this.spec.clusterIP || '<none>'}`,
      `External IP:       ${externalIP}`,
      `Port:              ${(this.spec.ports || []).map((p) => `${p.name} ${p.port}/${p.protocol}`).join(', ')}`,
      `TargetPort:        ${(this.spec.ports || []).map((p) => `${p.targetPort}/${p.protocol}`).join(', ')}`,
    ];
    if (this.spec.ports?.[0]?.nodePort) {
      lines.push(
        `NodePort:          ${this.spec.ports.map((p) => `${p.name} ${p.nodePort}/${p.protocol}`).join(', ')}`
      );
    }
    lines.push(
      `Endpoints:         ${endpointText}`,
      `Session Affinity:  ${this.spec.sessionAffinity}`,
      'Events:',
      ...this.events.slice(-10).map((e) => `  ${e.type}\t${e.reason}\t${e.message}`)
    );
    return lines.join('\n');
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

export default { Service, Ingress, NetworkPolicy };
