# OpenShift 4.22 — Networking, Routes, Storage, Scheduling, Security/RBAC/SCC

**Research reference for the k8sgames → OpenShift/EX280 conversion.**
Feeds campaign levels, incident definitions, and command-bar verbs. RESEARCH ONLY — no game code was modified.

| Field                       | Value                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document                    | `docs/research/openshift-networking-security-storage.md`                                                                                                                                                                                                                                        |
| Research date / access date | **2026-11-03**                                                                                                                                                                                                                                                                                  |
| Primary doc set             | **OpenShift Container Platform 4.22** on docs.redhat.com (latest 4.x; `4.23` returns 404)                                                                                                                                                                                                       |
| Exam targeted               | **EX280V422** — Red Hat Certified Specialist in OpenShift Administration (the version ID comes from Red Hat's public _Exam Objectives by Version_ PDF)                                                                                                                                          |
| Exam objectives source      | <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf> (downloaded and text-extracted 2026-11-03; EX280V422 section)                                                                                                 |
| Exact-text verification     | Red Hat docs source branch `enterprise-4.22` of `openshift/openshift-docs` (commit `a1ea307ec1ff90d82126e21f229a0c1142a9565d`): <https://github.com/openshift/openshift-docs/tree/enterprise-4.22> — used to quote command/YAML exactly where the docs.redhat.com SPA could not be text-fetched |
| Confidence                  | **High** for command syntax/YAML/API versions and SCC list (verbatim doc source). **Medium** for a few operational nuances flagged ⚠️ (lab-dependent; verify on the exam-like cluster).                                                                                                         |
| Deliberate exclusions       | Builds/ImageStreams/Deployments/DFC/operators → sibling task (`openshift-workloads-builds.md`); EX280 objectives overview → sibling task (`ex280-objectives.md`)                                                                                                                                |

> **Version caveat up front:** docs.redhat.com now defaults to **OpenShift 5.0** docs. EX280V422 is a **4.22-era exam**. Use 4.22 docs only; 5.0 pages can differ in SCC/PSA defaults, API groups and CLI. All URLs below are pinned to `/4.22/`.
> Every claim that matters for the game is tied to a citation key `[R#]` resolved in **§15 Sources**. Web content was treated strictly as reference data.

---

## 0. How this document maps to EX280V422

Objective bullets below are quoted (lightly normalised) from the EX280V422 section of the official exam-objectives PDF, access date above. "Section" points into this document; "Lab" to §12.

| #   | EX280V422 objective                                                                                                                                                               | Covered in            | Exam-style lab |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------- |
| 1   | Configure network security → **Configure networking components**                                                                                                                  | §1, §3, §4            | L7             |
| 2   | …**Troubleshoot software defined networking**                                                                                                                                     | §5.7, §11             | L3, L5         |
| 3   | …**Create and edit external routes**                                                                                                                                              | §2                    | L1, L2         |
| 4   | …**Control cluster network ingress**                                                                                                                                              | §3, §4, §5            | L3, L7         |
| 5   | …**Secure external and internal traffic using TLS certificates**                                                                                                                  | §2.3–§2.8, §3.4, §6.3 | L1, L2         |
| 6   | …**Configure application network policies**                                                                                                                                       | §5                    | L5             |
| 7   | Expose non-HTTP/SNI applications → **Configure a load balancer service**                                                                                                          | §4.1–§4.4             | L7             |
| 8   | …**Configure external application access**                                                                                                                                        | §1, §2.1, §4          | L1, L7         |
| 9   | Manage authentication and authorization → **HTPasswd identity provider; create/delete users; modify user passwords; create/manage groups; modify user and group permissions**     | §6.4–§7.6             | L4             |
| 10  | Enable developer self-service → **cluster resource quotas; project quotas; project resource requirements; project limit ranges; project templates**                               | §8                    | L6             |
| 11  | Configure application security → **service accounts; run privileged applications; SCC permissions; secrets; Kubernetes API access; Jobs; CronJobs**                               | §6, §8.6, §9.4        | L4, L6         |
| 12  | Manage OpenShift Container Platform (**cluster health, events, logs, projects**) — implied by "be prepared to perform all tasks of a Red Hat Certified Technologist in OpenShift" | §3.7, §11             | L3             |

**Not explicit in EX280V422** (still included because the game should remain truthful / because sibling objectives use them):

- **Storage (PV/PVC/StorageClass/CSI):** the V422 objective list does **not** contain a storage domain. §9 is marked _background_, one screen long.
- **Pod scheduling (affinity/taints/drain):** also absent from the V422 list. §10 is marked _supporting_; it still matters for `IngressController nodePlacement`, node maintenance, and resource/limit work.
- Storage **adjacent** topics that _are_ explicit: Secrets, ConfigMaps, PVCs in project templates, ServiceAccount `imagePullSecrets`.

---

## 1. Services, endpoints, and exposure primitives

OpenShift is Kubernetes: `Service` is `v1` (core), `EndpointSlice` is `discovery.k8s.io/v1`. These are the stable facts for game modelling. [R26][R27]

### 1.1 Service types cheat sheet

| Type                  | apiVersion/kind                     | What it gives you                                      | Cluster exposure path   | Typical EX280 use                        |
| --------------------- | ----------------------------------- | ------------------------------------------------------ | ----------------------- | ---------------------------------------- |
| `ClusterIP` (default) | `v1/Service`                        | Stable virtual IP inside the cluster only              | nothing external        | app-to-app, then `oc expose svc` → Route |
| `NodePort`            | `v1/Service`                        | Same, plus `nodePort` in **30000–32767** on every node | node IP:nodePort        | non-HTTP/SNI access, simple labs         |
| `LoadBalancer`        | `v1/Service`                        | Cloud LB or **MetalLB**-assigned external IP           | external IP 80/443 etc. | non-HTTP/SNI access; objective 7         |
| `ExternalName`        | `v1/Service`                        | DNS CNAME to external hostname                         | DNS only                | pointing to outside DB/service           |
| Headless              | `v1/Service` with `clusterIP: None` | Per-pod A/AAAA DNS, no VIP                             | endpoints only          | StatefulSets, direct pod addressing      |

Minimal ClusterIP service (correct `apiVersion`):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello
spec:
  selector:
    app: hello
  ports:
    - name: 8080-tcp
      port: 8080 # service port
      targetPort: 8080 # container port
      protocol: TCP
  type: ClusterIP # omit for default
```

Commands (verified against oc-by-example CLI reference) [R19]:

```bash
oc create service clusterip my-cs --tcp=5678:8080
oc create service clusterip my-cs --clusterip="None"          # headless
oc create service nodeport my-ns --tcp=5678:8080
oc create service loadbalancer my-lbs --tcp=5678:8080
oc create service externalname my-ns --external-name bar.com
oc get svc
oc get svc hello -o yaml
oc get endpoints hello                    # legacy endpoints object (still present)
oc get endpointslices -l kubernetes.io/service-name=hello
oc describe svc hello
```

Headless/selectorless services have **no** cluster IP; `oc get svc` shows `CLUSTER-IP: None` / `<none>`. Endpoints are populated by the endpoints controller from the selector; `EndpointSlice` objects are the scalable successor (one slice can hold up to 100 endpoints). [R27]

### 1.2 What the _router_ traffic path looks like

```
client → Route (host) → IngressController pods (openshift-ingress ns, HAProxy) → Service ClusterIP → Endpoints → Pod
```

That one line is the best mental model for the game's connection lines: **Route → Service → Endpoints → Pods**. `oc get routes` shows the `SERVICES` column linking route→service. [R2][R3]

**Game hooks**

- Palette/connection model: `Route` edges should point at a `Service`, not directly at pods; Service edges point at pods via selector match.
- Incident: "Service has no endpoints" → selector typo. Fix: `oc edit svc`, or `oc expose`/apply correct `spec.selector`; verify `oc get endpointslices`.
- Command-bar verbs: `oc get svc`, `oc get endpoints`, `oc get endpointslices`, `oc expose svc`, `oc create service <type>`.

---

## 2. Routes (`route.openshift.io/v1`) — the core OpenShift exposure object

Canonical docs: **Routes** chapter of the _Ingress and load balancing_ book [R2], with the _Configuring ingress cluster traffic_ chapter [R3]; API schema [R21].

### 2.1 Concept and simplest path: `oc expose`

```bash
# HTTP(S) route for a service; host defaults to <route>-<namespace>.<apps-domain>
oc expose service hello
oc expose svc/hello
oc get route
```

Example output shape (from the docs' `nodejs-ex` walkthrough) [R3]:

```
NAME        HOST/PORT                        PATH   SERVICES    PORT       TERMINATION   WILDCARD
nodejs-ex   nodejs-ex-myproject.example.com         nodejs-ex   8080-tcp                 None
```

The generated host is `<route-name>-<project>.<default-ingress-domain>`. Print the cluster's ingress domain with:

```bash
oc get ingresses.config/cluster -o jsonpath={.spec.domain}
```

Useful `oc expose` options (all documented in the CLI by-example) [R19]:

```bash
oc expose service nginx -l name=myroute --name=fromdowntown
oc expose service nginx --hostname=www.example.com
oc expose service nginx --hostname=x.example.com --wildcard-policy=Subdomain
oc expose service nginx --path=/nginx
```

Minimal unsecured Route YAML [R2]:

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: hello-openshift
spec:
  host: www.example.com # optional; generated if omitted
  path: / # optional
  port:
    targetPort: 8080 # container port or service port NAME
  to:
    kind: Service
    name: hello-openshift
```

- `spec.to` → the service; `spec.port.targetPort` must match a container port (or a service port **name**, e.g. `8080-tcp`).
- `path` only works for HTTP-visible routes: **not** for passthrough (router can't read TLS payload). [R2]

### 2.2 TLS termination types (memorise this table)

| `spec.tls.termination` | TLS ends at                           | Router needs cert/key?                                                                          | Backend traffic              | `insecureEdgeTerminationPolicy`                  | Create with                       |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------ | --------------------------------- |
| _(none)_               | nowhere (plain HTTP)                  | no                                                                                              | plain HTTP                   | n/a                                              | `oc expose svc`                   |
| `edge`                 | IngressController (HAProxy)           | **yes** — `tls.certificate`+`tls.key` (route or default cert)                                   | HTTP (decrypted)             | `None` (default), `Redirect`, `Allow`            | `oc create route edge ...`        |
| `passthrough`          | backend pod                           | no (only `tls.termination` required)                                                            | still **TLS**, SNI forwarded | `None`/`Redirect` (Allow is edge/reencrypt-only) | `oc create route passthrough ...` |
| `reencrypt`            | router **and** re-encrypts to backend | yes (`cert`/`key` on router side) + trust for backend (`destinationCACertificate` / service CA) | TLS again                    | `None`, `Redirect`, `Allow`                      | `oc create route reencrypt ...`   |

`insecureEdgeTerminationPolicy` semantics are explicit in the Route API: _Allow — traffic is sent to the server on the insecure port (edge/reencrypt terminations only); None — no traffic on insecure port (default); Redirect — clients redirected to secure port._ [R21]

### 2.3 Create edge route with a custom certificate

```bash
oc create route edge --service=frontend \
  --cert=tls.crt --key=tls.key --ca-cert=ca.crt \
  --hostname=www.example.com
```

Flags verified against `oc` 4.22 source (`pkg/cli/create/routeedge.go`): `--hostname --port --insecure-policy --service --path --cert --key --ca-cert --wildcard-policy`. `--service` is required. [R32]

Resulting YAML (exact shape from docs) [R2]:

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: frontend
spec:
  host: www.example.com
  to:
    kind: Service
    name: frontend
  tls:
    termination: edge
    key: |-
      -----BEGIN PRIVATE KEY-----
      [...]
      -----END PRIVATE KEY-----
    certificate: |-
      -----BEGIN CERTIFICATE-----
      [...]
      -----END CERTIFICATE-----
    caCertificate: |-
      -----BEGIN CERTIFICATE-----
      [...]
      -----END CERTIFICATE-----
```

Password-protected keys are not supported; strip the passphrase:
`openssl rsa -in password_protected_tls.key -out tls.key`. [R2]

### 2.4 Create reencrypt route with custom cert

```bash
oc create route reencrypt --service=frontend \
  --cert=tls.crt --key=tls.key \
  --dest-ca-cert=destca.crt --ca-cert=ca.crt \
  --hostname=www.example.com
```

If `--dest-ca-cert` is omitted the route uses the **service CA** and the backend must serve a service-serving certificate (`service.beta.openshift.io/serving-cert-secret-name` annotation pattern). [R32][R2]

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: frontend
spec:
  host: www.example.com
  to:
    kind: Service
    name: frontend
  tls:
    termination: reencrypt
    key: |-
      -----BEGIN PRIVATE KEY-----
      [...]
    certificate: |-
      -----BEGIN CERTIFICATE-----
      [...]
    caCertificate: |-
      -----BEGIN CERTIFICATE-----
      [...]
    destinationCACertificate: |-
      -----BEGIN CERTIFICATE-----
      [...]
```

### 2.5 Create passthrough route

```bash
oc create route passthrough route-passthrough-secured --service=frontend --port=8080
```

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: route-passthrough-secured
spec:
  host: www.example.com
  port:
    targetPort: 8080
  tls:
    termination: passthrough
    insecureEdgeTerminationPolicy: None # only None/Redirect/empty valid; Allow is not
  to:
    kind: Service
    name: frontend
```

Passthrough is the only method that can require **client certificates (mTLS)** end-to-end and it cannot do path-based routing. [R2]

### 2.6 Self-signed certificate workflow (EX280: "Create a self signed certificate / Secure routes using TLS")

This is the standard, repeatable recipe. The openssl invocation was **executed during this research** (2026-11-03) and produced a valid `CN` + `subjectAltName` pair; the `oc create secret tls` / `oc create route edge` parts are verbatim doc commands. [R2][R19][R32]

```bash
# 1) self-signed cert for the route host (one hostname; add DNS:… SANs as needed)
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout tls.key -out tls.crt \
  -subj "/CN=hello.apps.example.com" \
  -addext "subjectAltName=DNS:hello.apps.example.com"

# 2) (optional but exam-realistic) TLS Secret object with the pair
oc create secret tls hello-tls --cert=tls.crt --key=tls.key

# 3a) route that embeds the cert directly
oc create route edge hello --service=hello --cert=tls.crt --key=tls.key \
  --hostname=hello.apps.example.com

# 3b) OR route that references a secret via .spec.tls.externalCertificate (4.22-capable)
#     * secret must be kubernetes.io/tls with tls.crt + tls.key
#     * router reads it via SubjectAccessReview → grant read with a Role+RoleBinding
#       for serviceaccount openshift-ingress:router in the project
#     * cannot combine externalCertificate with tls.certificate/tls.key

# 4) verify
oc get route hello -o yaml
curl -k -sI https://hello.apps.example.com | head -1     # -k while self-signed
echo | openssl s_client -connect hello.apps.example.com:443 -showcerts 2>/dev/null | \
  openssl x509 -noout -subject -issuer -enddate
```

Trusted-CA versions: for the **default** wildcard certificate of all routes, put a `kubernetes.io/tls` secret in `openshift-ingress` and patch the IngressController (§3.4) instead of every route. [R3]

### 2.7 Route admission / host claims / wildcard policy

`IngressController.spec.routeAdmission` controls _admission of route host claims_: [R1][R21]

| Field                | Values                                              | Meaning                                                                                                                          |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `namespaceOwnership` | `Strict` (default), `InterNamespaceAllowed`         | Strict: a hostname can only be claimed from one namespace; InterNamespaceAllowed: different paths of same host across namespaces |
| `wildcardPolicy`     | `WildcardsDisallowed` (default), `WildcardsAllowed` | Whether `wildcardPolicy: Subdomain` routes are admitted                                                                          |

```bash
# allow two namespaces to share a hostname with different paths
oc -n openshift-ingress-operator patch ingresscontroller/default --type=merge \
  --patch '{"spec":{"routeAdmission":{"namespaceOwnership":"InterNamespaceAllowed"}}}'

# allow wildcard routes
oc -n openshift-ingress-operator patch ingresscontroller/default --type=merge \
  --patch '{"spec":{"routeAdmission":{"wildcardPolicy":"WildcardsAllowed"}}}'
```

Wildcard route YAML (`spec.wildcardPolicy: Subdomain`, host must be `*.example.com` semantics via host suffix): [R1]

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: wildcard
spec:
  host: www.example.com
  wildcardPolicy: Subdomain
  to:
    kind: Service
    name: frontend
```

Route creation via `oc expose --wildcard-policy=Subdomain` is also documented. [R19]

### 2.8 Observing, editing, and troubleshooting routes

```bash
oc get routes
oc get routes -o wide
oc get route hello -o yaml
oc describe route hello
oc edit route hello            # change host/path/tls
oc patch route hello --type=merge -p '{"spec":{"host":"new.example.com"}}'
oc delete route hello
```

**Route "admitted" status.** The route's `status.ingress[]` array has conditions; an Ingress Controller reports `type: Admitted` = `True` when it will serve the route. Typical checks: [R3]

```bash
oc get route hello -o jsonpath='{.status.ingress[0].conditions}' | jq
oc get route hello -o jsonpath='{.status.ingress[0].host}{"\n"}'
# sharded controllers: a route is admitted to 0..n controllers; status lists each router shard
```

Common "route not admitted / route not working" causes for the game:

1. host claim conflict across namespaces → `namespaceOwnership: Strict` (default) → change host or switch to `InterNamespaceAllowed`. [R1]
2. wildcard route while `WildcardPolicy=WildcardsDisallowed` (default). [R1]
3. no/short router shard matching the route label → `routeSelector` mismatch (§3.5). [R3]
4. service has no ready endpoints → router 503 (`oc get endpointslices`).
5. TLS secret missing/wrong type, or `externalCertificate` RBAC failure (`ExternalCertificateGetFailed`, `ExternalCertificateValidationFailed` route conditions). [R2]

**Game hooks**

- Incidents: "Route 503 after deploy" (selector/endpoints), "host already claimed" (namespaceOwnership vs host edit), "cert expired/self-signed" (`openssl` verification), "passthrough + path not working", "wildcard route not admitted".
- Command bar: `oc expose svc`, `oc create route edge|reencrypt|passthrough`, `oc get route`, `oc describe route`, `oc edit route`. New flags to teach: `--hostname`, `--path`, `--cert`, `--key`, `--ca-cert`, `--dest-ca-cert`, `--insecure-policy`, `--wildcard-policy`.
- Nice visual: route glyph in the canvas gets `TERMINATION` badge (none/edge/passthrough/reencrypt) and a lock icon when TLS.

---

## 3. Ingress and IngressController (OpenShift's routing engine)

### 3.1 Objects and defaults

- `IngressController` is `operator.openshift.io/v1`, namespace `openshift-ingress-operator`, **exactly one named `default` exists on every cluster**. If deleted, the Ingress Operator recreates it. [R1][R22]
- The default controller runs **2 replicas** by default and admits **any route in any project** by default. [R3]
- The operator ("Ingress Operator") is a cluster operator; routes are served by HAProxy pods in namespace `openshift-ingress`. [R1]

```bash
oc get ingresscontroller -n openshift-ingress-operator
oc describe --namespace=openshift-ingress-operator ingresscontroller/default
oc get pods -n openshift-ingress
oc get svc -n openshift-ingress                      # router-default service (LoadBalancer/NodePort on many platforms)
oc get routes -A
oc get clusteroperators ingress
oc describe clusteroperators/ingress                  # Available/Progressing/Degraded
oc get pods -n openshift-ingress -l ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default
```

### 3.2 Typical edits (exam-realistic)

```bash
# scale router pods (default 2)
oc patch -n openshift-ingress-operator ingresscontroller/default \
  --patch '{"spec":{"replicas": 3}}' --type=merge
oc get -n openshift-ingress-operator ingresscontrollers/default -o jsonpath='{$.status.availableReplicas}'

# pin router pods to specific nodes (critical: workers, not control plane)
oc patch -n openshift-ingress-operator ingresscontroller/default --type=merge --patch \
 '{"spec":{"nodePlacement":{"nodeSelector":{"matchLabels":{"node-role.kubernetes.io/worker":""}},"tolerations":[{"effect":"NoSchedule","key":"node-role.kubernetes.io/master","operator":"Exists"}]}}}'

# make the router internal (LoadBalancer scope internal) or external
oc -n openshift-ingress-operator patch ingresscontrollers/default --type=merge \
  --patch='{"spec":{"endpointPublishingStrategy":{"type":"LoadBalancerService","loadBalancer":{"scope":"Internal"}}}}'
```

`nodePlacement` has exactly `nodeSelector` + `tolerations`. `endpointPublishingStrategy.type` values include `LoadBalancerService`, `NodePortService`, `HostNetwork`, `Private` (platform-dependent); scope can be `Internal`/`External` and changing it may delete/recreate the `router-default` service. [R3][R22]

### 3.3 Route vs Ingress (what the exam expects you to say)

Both expose apps externally; OpenShift routes are the native object with richer TLS/termination and sharding features. Ingress objects are supported and are translated/admitted by the same Ingress Controller (an Ingress ends up rendered as a Route). For EX280V422, be able to: create a route (native, preferred), create/edit Ingress YAML when asked, and explain that `oc expose`/`oc create route` = Route API while `k8s Ingress` = `networking.k8s.io/v1` admitted by the IngressController. [R1][R2][R3]

`oc create ingress` exists in the CLI reference (`oc create ingress` is in oc-by-example); the OpenShift-specific capability list lives on Routes (path, wildcard, reencrypt, route admission). [R19]

Minimal Ingress for reference (correct apiVersion for current clusters):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello
spec:
  rules:
    - host: hello.apps.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hello
                port:
                  number: 8080
  tls:
    - hosts:
        - hello.apps.example.com
      secretName: hello-tls
```

### 3.4 Default (wildcard) certificate for the ingress domain

```bash
oc --namespace openshift-ingress create secret tls custom-certs-default --cert=tls.crt --key=tls.key
oc patch --type=merge --namespace openshift-ingress-operator ingresscontrollers/default \
  --patch '{"spec":{"defaultCertificate":{"name":"custom-certs-default"}}}'
# verify served cert
echo Q | openssl s_client -connect console-openshift-console.apps.<domain>:443 -showcerts 2>/dev/null | \
  openssl x509 -noout -subject -issuer -enddate
```

The certificate must be valid for the ingress domain and use a wildcard SAN such as `*.apps.ocp4.example.com`; intermediates go after the server cert in `tls.crt`. This rolls the router. [R1]

### 3.5 Router sharding (basics the exam can ask for)

A second IngressController = a "shard". Select routes by **route labels** (`spec.routeSelector`) or by **namespace labels** (`spec.namespaceSelector`); each shard needs a unique `spec.domain`. [R3]

```yaml
apiVersion: operator.openshift.io/v1
kind: IngressController
metadata:
  name: sharded
  namespace: openshift-ingress-operator
spec:
  domain: apps-sharded.basedomain.example.net
  nodePlacement:
    nodeSelector:
      matchLabels:
        node-role.kubernetes.io/worker: ''
  routeSelector:
    matchLabels:
      type: sharded
```

```bash
oc apply -f router-internal.yaml
oc expose svc <service-name> --hostname <route-name>.apps-sharded.basedomain.example.net
oc get route <route-name> -o yaml     # check status.ingress conditions: Admitted per shard
```

The **default** Ingress Controller has no selectors, so it admits the new shard's routes too unless you also give it selectors — a classic lab/troubleshooting detail. [R3]

### 3.6 Route creation via Ingress objects / editing routes through Ingress

`oc expose` and `oc create route` are the EX280 path; if the task says "create an Ingress", use `oc create -f` with the YAML above, then `oc get ingress` and `oc describe route` — the generated Route is visible. Editing the Route directly is also fine (the Ingress may re-reconcile). [R3]

### 3.7 Cluster ingress health (used by "control cluster network ingress" + cluster health)

```bash
oc get clusteroperators                       # or: oc get co
oc get co ingress network authentication openshift-apiserver
oc get nodes
oc get pods -n openshift-ingress
oc get events -A --sort-by=.lastTimestamp | tail
oc describe clusteroperators/ingress
```

`oc get co/network -o json | jq '.status.conditions[]'` is a documented health check for the network operator. [R5][R16]

**Game hooks**

- Shard levels: give a route label + a shard label selector; player must "fix admission" by aligning `routeSelector`/`namespaceSelector` and domain.
- Incident: router pods Pending after node drain → `nodePlacement` tolerations.
- Command bar: `oc get ingresscontroller`, `oc get ingresscontrollers/default -o yaml`, `oc edit ingresscontroller`, `oc get co`, `oc get pods -n openshift-ingress`.

---

## 4. Exposing non-HTTP/SNI applications (V422 objective)

A Route only proxies HTTP, HTTPS (SNI) and TLS (SNI). Non-HTTP protocols (TCP/UDP, databases, MQTT, gRPC without TLS…) need a **Service** of type `LoadBalancer`, `NodePort`, or `ExternalIPs`. [R3][R4]

### 4.1 LoadBalancer Service (MetalLB on bare metal / on-prem)

On cloud platforms the cloud provider allocates the external IP. On bare metal/on-prem the **MetalLB Operator** provides it. [R4]

```bash
# MetalLB CRs (MetalLB Operator installed; operator itself is task-2/operators territory)
oc get ipaddresspool -n metallb-system
oc get l2advertisement -n metallb-system
```

`IPAddressPool` + `L2Advertisement` YAML (correct `metallb.io/v1beta1`): [R4]

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  namespace: metallb-system
  name: doc-example-l2
spec:
  addresses:
    - 203.0.113.1-203.0.113.10 # or a CIDR, e.g. 4.4.4.0/24
  autoAssign: false
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: l2advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
    - doc-example-l2
```

LoadBalancer Service with MetalLB pool pinning: [R4]

```yaml
apiVersion: v1
kind: Service
metadata:
  name: example-metallb-svc
  namespace: example-metallb
  annotations:
    metallb.io/address-pool: doc-example-l2
spec:
  type: LoadBalancer
  selector:
    app: example-app
  ports:
    - port: 80
      targetPort: 8080
```

```bash
oc apply -f example-metallb-app.yaml
oc get svc example-metallb-svc
oc describe svc example-metallb-svc          # EXTERNAL-IP is the MetalLB-assigned VIP
oc get events -n example-metallb --sort-by=.lastTimestamp
```

Layer 2 mode: one node announces the VIP via ARP/NDP; failover is automatic; clients must be in the same subnet. BGP mode advertises to peers (not needed for EX280 basics, but the exam may mention both). [R4]

### 4.2 NodePort Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello-nodeport
spec:
  type: NodePort
  selector:
    app: hello
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30327 # optional; 30000–32767 assigned if omitted
```

```bash
oc create service nodeport my-ns --tcp=5678:8080
oc get svc my-ns
# call it from outside the cluster on any node IP
curl http://<node-ip>:30327
```

The docs explicitly show editing the service via `oc edit svc <service_name>` to set `nodePort` and the default `30000-32767` range. [R3]

### 4.3 ExternalIPs (and ExternalName, headless for non-router use)

```bash
oc get svc
oc explain service.spec.externalIPs
```

- `spec.externalIPs: [ "192.0.2.10" ]` on a ClusterIP service makes the service reachable on that IP if routing exists — no router involved.
- `ExternalName` (`oc create service externalname my-ns --external-name bar.com`) returns a CNAME — useful to present an external DB "inside" the project.
- Headless (`clusterIP: None`) for direct pod DNS (StatefulSet stable DNS names).

### 4.4 What "configure external application access" means in practice

For a non-HTTP workload the exam-realistic chain is: Deployment/StatefulSet → Service (`LoadBalancer`/`NodePort`) → verify `EXTERNAL-IP`/`nodePort` → test connectivity (`oc exec` from another pod or `curl`/`nc` from admin host) → only use a Route if the protocol is HTTP/HTTPS/TLS-with-SNI. [R3][R4]

**Game hooks**

- Incident: `EXTERNAL-IP: <pending>` forever (MetalLB operator not installed, no address pool, `autoAssign: false` and no annotation).
- Level: "expose the database (TCP/5432) to the demo client" — correct answer is LB/NodePort, a Route is wrong.
- Command bar: `oc create service loadbalancer|nodeport|externalname`, `oc get svc`, `oc get ipaddresspool -n metallb-system`, `oc get l2advertisement -n metallb-system`.

---

## 5. NetworkPolicy, SDN, and application network policies (V422 objective)

### 5.1 The network stack in 4.22

- **OVN-Kubernetes is the default network provider** for OpenShift 4.22 (overlay, OVS on each node). [R5][R34]
- **OpenShift SDN is no longer supported in 4.22**: installation supports only `OVNKubernetes`; the docs note SDN was removed in 4.17. For the exam: answer OVN-Kubernetes; do not try to "migrate to SDN". [R5][R34]
- Cluster-wide network config:
  - `oc describe network.config/cluster` — `spec.networkType`, `clusterNetwork`, `serviceNetwork`, MTU status (verified documented command). [R5][R25][R34]
  - `oc get network.operators.operator.openshift.io cluster -o yaml` (fully qualified resource; the shorter `oc get network.operator cluster -o yaml` also resolves on 4.x) — operator view: `operator.openshift.io/v1` Network named `cluster`; `spec.defaultNetwork.type: OVNKubernetes`. [R22][R34]
  - `oc get co network -o yaml` / `oc get co/network -o json` for status. [R16]
- Caveats: `clusterNetwork` can be expanded post-install; `serviceNetwork` cannot be changed post-install; `defaultNetwork.type` is set at install. [R5]

```bash
oc describe network.config/cluster    # config.openshift.io/v1 Network "cluster"
oc get network.operators.operator.openshift.io/cluster -o yaml   # CNO view
oc get network.config.openshift.io/cluster -o yaml
oc get co network
```

### 5.2 NetworkPolicy semantics (Kubernetes + OVN)

`NetworkPolicy` is `networking.k8s.io/v1`. Objects are **additive** and **default-allow until selected**: every pod not matched by any policy stays fully open; a pod matched by one or more policies only accepts what at least one policy allows. [R5][R28]

- Policy selects pods in its **own namespace only** (`spec.podSelector`); `ingress.from` can combine `podSelector` (same ns), `namespaceSelector` (other ns by labels), `ipBlock`.
- `namespaceSelector` matches namespace labels — note the implicit `kubernetes.io/metadata.name: <ns>` label; this is a very common exam shortcut.
- `policyTypes: [Ingress]`, `[Egress]` or both; an **empty `ingress: []` denies all ingress** to selected pods.
- Egress policies must allow **DNS** (`kube-dns` in `openshift-dns` namespace, port 53/udp+tcp) or pods lose name resolution.
- OVN-Kubernetes enforces policies in the OVN pipeline; the previous "multitenant" OpenShift-SDN mode is now emulated with policies (see multitenant-isolation docs). [R5]

### 5.3 Copy-paste policy set for a project (default-deny + allow)

1. Default deny all ingress (Kubernetes "fundamental policy"): [R5]

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-by-default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress: []
```

2. Allow ingress from all pods in the same namespace: [R5]

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}
```

3. Allow a particular namespace (by its implicit name label): [R5]

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-traffic-pod
spec:
  podSelector:
    matchLabels:
      pod: pod-a
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: namespace-y
```

4. Allow ingress from the **OpenShift router only** (label `policy-group.network.openshift.io/ingress: ""` on `openshift-ingress` namespace) — needed when default-deny breaks external Routes. [R5]

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-router
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              policy-group.network.openshift.io/ingress: ''
```

5. Default deny **egress** + explicitly allow DNS and the app's dependencies. This full pair is the canonical "secure project" lab: [R5][R28]

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress: [] # deny all egress from selected pods (DNS included!)
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-and-app
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to: # DNS is REQUIRED or everything breaks
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openshift-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to: # example: reach another project's API
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: backend
          podSelector:
            matchLabels:
              app: api
      ports:
        - protocol: TCP
          port: 8080
```

> ⚠️ The exact `allow-dns` namespace/port form above is the standard pattern; always validate with the cluster's real DNS pods (`oc get pods -n openshift-dns`, `oc get svc -n openshift-dns`) because some distributions expose DNS through the `openshift-dns/dns-default` service on port 53. [R5]

### 5.4 Viewing/editing policies + project defaults

```bash
oc get networkpolicy
oc get networkpolicy -A
oc describe networkpolicy allow-same-namespace
oc edit networkpolicy deny-by-default
oc delete networkpolicy deny-by-default
oc apply -f policy.yaml -n myproject
```

Policies can be injected into **every new project** via the project template (the same mechanism as quotas): edit the template in `openshift-config` and add the NetworkPolicy objects. [R5][R35]

⚠️ **4.22 change:** OCP 4.22 now ships default `NetworkPolicy` objects in _some platform namespaces_ (cluster DNS and Ingress components install and maintain "deny-all" policies). Do **not** run custom pods in `openshift-dns`, `openshift-ingress`, `openshift-dns-operator`, or `openshift-ingress-operator` — their deny-by-default model will block them. Do not modify the platform's own policies. [R5]

- `AdminNetworkPolicy` / `BaselineAdminNetworkPolicy` (`policy.networking.k8s.io/v1alpha1`) exist for cluster-wide admin policies; awareness only for EX280. [R5][R21]

### 5.5 Testing isolation (how the exam verifies it)

```bash
# run a throwaway tester pod in the target namespace
oc run test-$RANDOM --namespace=prod --rm -i -t --image=alpine -- sh
# inside:
nslookup kubernetes.default
wget -qO- --timeout=3 http://web.prod.svc.cluster.local:8080 || echo BLOCKED
```

The docs' own verification uses `oc run ... --rm -i -t --image=alpine` from `default`/`dev`/`prod` namespaces to prove cross-namespace allow/deny. [R5]

### 5.6 Network troubleshooting toolbox

```bash
oc get pods -A -o wide
oc get svc,endpoints,endpointslices -n <ns>
oc exec -it deploy/hello -- curl -sv http://hello:8080            # in-cluster call by Service DNS
oc exec -it deploy/hello -- nslookup hello.<ns>.svc.cluster.local
oc logs -f deploy/hello
oc get events --sort-by=.lastTimestamp
oc debug node/<node>            # then: chroot /host   (host networking/OVS tools)
oc adm must-gather -- /usr/bin/gather_network_logs
oc adm must-gather -- oc adm inspect ns/<namespace>
oc adm inspect clusteroperator/network
```

- `oc debug node/<name>` starts a privileged debug pod for that node; inside it, `chroot /host` gives the host shell (network, OVS, tcpdump, `crictl`). This is _the_ answer for "troubleshoot SDN on a node". [R16][R17]
- `oc adm must-gather` uses the default plugin; `-- /usr/bin/gather_network_logs` collects network logs; `oc adm inspect ns/<project>` collects targeted namespace data (documented form: `oc adm must-gather --dest-dir=my-project-must-gather -- oc adm inspect ns/my-project`). [R16]
- Route/policy debugging per docs: `oc get events`, `oc describe route`, check pod DNS, check CNI pods in `openshift-ovn-kubernetes`. [R17]
- OVN-Kubernetes troubleshooting sources (deeper): `oc get pods -n openshift-ovn-kubernetes`, OVN-Kubernetes troubleshooting docs, `ovnkube-trace` (advanced, not required for EX280). [R17]

### 5.7 "Troubleshoot software defined networking" exam checklist

1. `oc get co network` / `oc get nodes` / pods in `openshift-ovn-kubernetes` (and `openshift-dns`, `openshift-ingress`) healthy?
2. Pod-to-Service-to-pod path: exec-call by service name, then by pod IP.
3. DNS: `nslookup`/`getent hosts` inside the pod.
4. Policy blocking: `oc describe networkpolicy`, temporarily delete a suspect policy (lab), retest.
5. Node-level: `oc debug node/<node>` → `chroot /host` → `ip a`, `ovs-vsctl show`, `tcpdump`, `crictl ps`.
6. Collect `oc adm must-gather` if it is a "real" escalation.

**Game hooks**

- Incident: "Namespace isolated after adding default-deny — everyone now gets 503/timeouts" → player must add the same-namespace/allow-router/DNS policies.
- Incident: "DNS resolution failures after egress policy" → add port 53 UDP/TCP egress rule.
- Incident: "custom pod in openshift-ingress cannot reach anything" (4.22 platform deny-all behavior) → move the pod to a normal project.
- Command bar: `oc get networkpolicy`, `oc describe networkpolicy`, `oc apply -f`, `oc run --rm -i -t --image=alpine`, `oc debug node`, `oc adm must-gather`, `oc adm inspect ns/...`.

---

## 6. Security: SCCs, service accounts, securityContext, PSA

Canonical: SCC chapter in _Authentication and authorization_ [R20]; Service accounts chapters [R10]; PSA chapter [R11].

### 6.1 SCC concept (30-second version)

An SCC is a cluster-scoped policy (`security.openshift.io/v1` CustomResource; API reference [R24]) that constrains what a pod may request and **defaults the fields the pod left out** (runAsUser, fsGroup, SELinux, capabilities, volume types, privileged, host namespaces…). Admission picks the set of SCCs usable by the **user creating the pod or the pod's service account**, sorts by (priority, restrictiveness, name), and admits the pod if **all** fields validate against **one** SCC; otherwise the pod is rejected. Only the **service account** matters when pods come from a workload controller (Deployment etc.). [R20]

### 6.2 Default SCCs in 4.22 (know the list + the warnings)

From the 4.22 `oc get scc` example and the default-SCC table: [R20]

| SCC                             | What it adds / allows                                                                                                 | Notes                                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restricted-v2`                 | restricted + all capabilities dropped + `NET_BIND_SERVICE` only + `runtime/default` seccomp + no privilege escalation | **default for authenticated users on 4.11+ installs**                                                                                                                                                          |
| `restricted-v3`                 | like restricted-v2 plus **pod-level Linux user namespaces required** (`hostUsers: false`)                             | most restrictive default SCC in 4.22; docs state it is the default for authenticated users in new installs — ⚠️ verify with `oc get scc` / `oc adm policy who-can use scc restricted-v3` on the target cluster |
| `restricted`                    | legacy restricted (not granted to users on 4.11+ new installs)                                                        | present for upgraded clusters                                                                                                                                                                                  |
| `nonroot`, `nonroot-v2`         | any non-root UID                                                                                                      | v2 drops ALL caps / seccomp default                                                                                                                                                                            |
| `anyuid`                        | run as any UID/GID                                                                                                    | **cluster-admin priority by default**                                                                                                                                                                          |
| `hostaccess`                    | host namespaces                                                                                                       | dangerous                                                                                                                                                                                                      |
| `hostmount-anyuid`              | hostPath + any UID                                                                                                    | dangerous                                                                                                                                                                                                      |
| `hostnetwork`, `hostnetwork-v2` | host network + host ports                                                                                             | v2 caps-drop/seccomp                                                                                                                                                                                           |
| `node-exporter`                 | host fs access for node exporter                                                                                      | platform                                                                                                                                                                                                       |
| `nested-container`              | run container engines inside pods (user namespaces)                                                                   | new-ish                                                                                                                                                                                                        |
| `privileged`                    | everything: privileged, hostPath, host PID/IPC/network, any UID, any caps                                             | "most relaxed, cluster-admin only"                                                                                                                                                                             |

Command reference (verbatim): `oc get scc`, `oc describe scc restricted`, `oc edit scc <name>`, `oc delete scc <name>`; do **not** edit/delete default SCCs (they are regenerated and customizations can break platform upgrades). [R20]

`oc get scc` output columns: `NAME PRIV CAPS SELINUX RUNASUSER FSGROUP SUPGROUP PRIORITY READONLYROOTFS VOLUMES`. [R20]

### 6.3 Granting SCCs (EX280: "Manage and apply permissions using SCC")

```bash
# user or service account (SA in current project with -z)
oc adm policy add-scc-to-user privileged -z deployer
oc adm policy add-scc-to-user anyuid -z builder
oc adm policy add-scc-to-user <scc> user1
oc adm policy add-scc-to-group <scc> group1 group2
oc adm policy remove-scc-from-user <scc> <user>
oc adm policy remove-scc-from-group <scc> <group>

# what can a subject do?
oc adm policy who-can use scc privileged
oc auth can-i use scc/privileged
oc describe scc privileged
oc get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.openshift\.io/scc}{"\n"}{end}'
```

⚠️ Documented subtlety: `oc adm policy who-can use scc` / `oc auth can-i use scc/<name>` evaluate **only RBAC** (RoleBinding/ClusterRoleBinding), while `oc describe scc` shows **only** the SCC `users`/`groups` fields. These two views can disagree. [R20]

SCC as an RBAC resource (project-scoped grant; cluster-admin only in practice): [R20]

```bash
oc create role scc-privileged --verb=use --resource=scc --resource-name=privileged -n myproject
oc create rolebinding scc-privileged --role=scc-privileged --serviceaccount=myproject:myapp -n myproject
```

### 6.4 SCC vs securityContext — how to run a privileged app (V422: "Run privileged applications")

Pod/workload YAML must **ask** for the privilege; the SA/user must be **granted** the SCC:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: privileged-app
spec:
  replicas: 1
  selector:
    matchLabels: { app: privileged-app }
  template:
    metadata:
      labels: { app: privileged-app }
    spec:
      serviceAccountName: priv-sa
      containers:
        - name: app
          image: registry.access.redhat.com/ubi9/ubi:latest
          command: ['sleep', 'infinity']
          securityContext:
            privileged: true # asks for privileged SCC
            # allowPrivilegeEscalation: true     # only if the SCC permits it
            # runAsUser: 0                       # asks for anyuid/privileged
            # capabilities:
            #   add: ["NET_ADMIN"]
```

```bash
oc create sa priv-sa
oc adm policy add-scc-to-user privileged -z priv-sa
oc set serviceaccount deployment/privileged-app priv-sa
oc rollout status deployment/privileged-app
oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\.io/scc}{"\n"}'   # -> privileged
```

Key rules:

- `privileged: true` alone does **not** select the privileged SCC — the available SCC set must contain one with `allowPrivilegedContainer: true` and the user/SA must be allowed to use it. [R20]
- **SCC is admission**: if nothing matches, pod creation fails with a `Forbidden: unable to validate against any security context constraint` error listing each SCC's reason. The fix is either request less (drop `privileged`, `runAsUser`, `hostPath`…) **or** grant a matching SCC to the SA. [R20] (⚠️ exact error text varies by OCP minor; game should show the _shape_: `Error creating: pods ... is forbidden: unable to validate against any security context constraint: [provider restricted-v2: ...]`.)
- `runAsUser`/`fsGroup` explicit values must fall inside the namespace's `openshift.io/sa.scc.uid-range` / `*-supplemental-groups` annotations for `restricted-v2` (`MustRunAsRange`). Get them with `oc get ns <ns> -o yaml`. [R20]
- Pin a workload to an SCC with the annotation (4.22-supported): [R20]

```yaml
spec:
  template:
    metadata:
      annotations:
        openshift.io/required-scc: 'my-scc'
```

- SCC priority: cluster-admin's `anyuid` has admin priority so a cluster-admin can set `runAsUser`; **do not** set priority >0 on default SCCs. [R20]
- PSA coexistence: OpenShift also enforces Kubernetes **Pod Security Admission** labels (`pod-security.kubernetes.io/enforce: restricted|baseline|privileged`) as an _additional_ gate; a pod can pass PSA but fail SCC, or vice versa. The two systems are synchronized for the default SCC set; custom SCCs may need label sync. Awareness only for EX280, but useful for game incidents. [R11]

### 6.5 Service accounts and tokens (V422: "Configure and manage service accounts")

- Every project has `default`, `builder`, `deployer` SAs; `default` is used by pods that don't specify one. [R10]
- SA user name format: `system:serviceaccount:<namespace>:<name>`; groups `system:serviceaccounts` and `system:serviceaccounts:<namespace>`. [R10]
- **Since OCP 4.16 no long-lived API token Secret is auto-created** for a new SA. Get a short-lived token on demand: `oc create token myapp` (flags: `--duration`, `--audience`, `--bound-object-kind/name/uid`). The auto-created secret is only the **image pull** secret (`<sa>-dockercfg-*`). [R10]
- `oc describe sa` shows `Image pull secrets` / `Mountable secrets` / `Tokens`; the pod gets a projected (bound) token by default at `/var/run/secrets/kubernetes.io/serviceaccount/token`. [R10]

```bash
oc get sa
oc create sa robot
oc describe sa robot
oc adm policy add-role-to-user view -z robot            # local role binding for SA
oc policy add-role-to-user edit system:serviceaccount:top-secret:robot
oc create token robot --duration 10m
oc set serviceaccount deployment/myapp robot
oc secrets link serviceaccount-name pull-secret --for=pull
```

Kubernetes API access from an application (V422: "Configure application access to Kubernetes APIs"):

```bash
TOKEN=$(oc create token myapp -n myproject)
API=$(oc whoami --show-server)
oc run curl --rm -i -t --image=registry.access.redhat.com/ubi9/ubi-minimal -- \
  sh -c "curl -sk -H \"Authorization: Bearer $TOKEN\" $API/api/v1/namespaces/myproject/pods"
```

The application's permissions come from the **role bindings of its SA** (typically `view`/custom Role). 4.22 note: platform components now use **dedicated service accounts** instead of `default`; `oc debug` and `oc adm must-gather` still use `default` to keep them friction-free. [R33]

### 6.6 Secrets for applications (V422: "Create and apply secrets")

```bash
oc create secret generic app-secret --from-literal=username=admin --from-literal=password=s3cr3t
oc create secret generic ssh --from-file=ssh-privatekey=id_rsa
oc create secret docker-registry my-regcred --docker-server=quay.io \
  --docker-username=u --docker-password=p --docker-email=me@example.com
oc create secret tls tls-secret --cert=tls.crt --key=tls.key
oc set env --from=secret/mysecret deployment/myapp
oc set env --from=configmap/myconfigmap --prefix=MYSQL_ deployment/myapp
oc set data secret/foo password=this_is_secret
oc set data configmap/bar --from-file=haproxy.conf
oc get secret app-secret -o yaml
```

Secret types to know: `Opaque` (generic), `kubernetes.io/dockerconfigjson` (registry auth; `type: kubernetes.io/dockerconfigjson`), `kubernetes.io/tls` (`tls.crt`+`tls.key`), `kubernetes.io/service-account-token` (legacy), `Opaque` htpasswd secret (key **must** be `htpasswd`). [R10][R30]

Mount + env + immutable (Kubernetes semantics, verified against k8s docs): [R30][R31]

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: app }
spec:
  replicas: 1
  selector: { matchLabels: { app: app } }
  template:
    metadata: { labels: { app: app } }
    spec:
      containers:
        - name: app
          image: registry.access.redhat.com/ubi9/ubi:latest
          command: ['sleep', 'infinity']
          envFrom:
            - secretRef: { name: app-secret } # all keys -> env vars
            - configMapRef: { name: app-config }
          env:
            - name: TOKEN
              valueFrom: { secretKeyRef: { name: app-secret, key: password } }
          volumeMounts:
            - name: cfg
              mountPath: /etc/app
              readOnly: true
      volumes:
        - name: cfg
          configMap:
            name: app-config
            items: [{ key: app.conf, path: app.conf }]
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
immutable: true # can also be set on Secret; cannot be changed afterwards, only deleted/recreated
data:
  app.conf: |
    listen=8080
```

**Game hooks**

- Incident: "Pod Forbidden — SCC" with player choice: grant `anyuid` to SA vs set `runAsUser` to allowed UID-range value vs runAsNonRoot. Correct fix depends on task wording; teach both.
- Incident: "App cannot pull image from internal registry" → missing/incorrect image pull secret or SA lacking pull rights (`oc secrets link ... --for=pull`, `oc get sa default -o yaml`).
- Incident: "App's API calls return 403" → SA missing role binding; fix with `oc adm policy add-role-to-user view -z <sa>`; teach `oc create token` instead of legacy token secret (4.16+ behavior is a common trap).
- Command bar: `oc get scc`, `oc describe scc`, `oc adm policy add-scc-to-user`, `oc get sa`, `oc create sa`, `oc create token`, `oc set env --from`, `oc create secret ...`.

---

## 7. RBAC, users, groups, HTPasswd (V422: "Manage authentication and authorization")

Canonical: _Authentication and authorization_ book [R7] — _Using RBAC to define and apply permissions_ [R8]; _Configuring identity providers_ (htpasswd) [R9]; service-account docs [R10]. API: `rbac.authorization.k8s.io/v1` for Role/ClusterRole/RoleBinding/ClusterRoleBinding; `user.openshift.io/v1` for User/Identity/Group; `config.openshift.io/v1` OAuth.

### 7.1 Object model in one table

| Object             | Scope     | apiVersion/kind                                   | Purpose                                                            |
| ------------------ | --------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Rule               | —         | (inside Role/ClusterRole `rules[]`)               | verbs × resources × resourceNames                                  |
| Role               | namespace | `rbac.authorization.k8s.io/v1 Role`               | project-scoped permission set                                      |
| ClusterRole        | cluster   | `rbac.authorization.k8s.io/v1 ClusterRole`        | cluster-wide permission set (also bindable locally)                |
| RoleBinding        | namespace | `rbac.authorization.k8s.io/v1 RoleBinding`        | binds Role **or** ClusterRole to users/groups/SAs in one namespace |
| ClusterRoleBinding | cluster   | `rbac.authorization.k8s.io/v1 ClusterRoleBinding` | binds ClusterRole cluster-wide                                     |

A RoleBinding may point at a **ClusterRole** (usual pattern: bind default `view`/`edit`/`admin` locally); a ClusterRoleBinding may reference only ClusterRoles. [R8]

Minimal YAML:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: podview
  namespace: blue
rules:
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['get', 'list', 'watch']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: podview
  namespace: blue
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: podview
subjects:
  - kind: User
    name: user2
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount
    name: robot
    namespace: blue
```

### 7.2 Default cluster roles (bind these instead of inventing new ones)

`cluster-admin` (super-user), `admin` (project manager, everything except quota in the project when bound locally), `edit` (modify most objects, not roles/bindings), `view` (read-only, not roles/bindings), `cluster-reader`, `cluster-status`, `basic-user`, `self-provisioner` (create own projects). The `admin`/`edit`/`view`/`cluster-reader` ClusterRoles are **aggregated** — new API resources can add rules to them. [R8]

### 7.3 The command set (verbatim from the RBAC docs)

Local (per project; `-n` defaults to current project): [R8]

```bash
oc adm policy add-role-to-user <role> <user> -n <project>       # e.g. admin alice -n joe
oc adm policy add-role-to-user podview user2 --role-namespace=blue -n blue
oc adm policy add-role-to-group <role> <group> -n <project>
oc adm policy remove-role-from-user <role> <user>
oc adm policy remove-user <user>
oc adm policy remove-role-from-group <role> <group>
oc adm policy remove-group <group>
oc create role <name> --verb=<verb> --resource=<resource> -n <project>
oc create rolebinding <name> --clusterrole=admin --user=user1 --user=user2 --group=group1
oc create rolebinding admin-binding --role=admin --serviceaccount=monitoring:sa-dev
```

Cluster-wide: [R8]

```bash
oc adm policy add-cluster-role-to-user <role> <user>          # e.g. cluster-admin alice
oc adm policy add-cluster-role-to-group <role> <group>
oc adm policy remove-cluster-role-from-user <role> <user>
oc adm policy remove-cluster-role-from-group <role> <group>
oc adm policy add-cluster-role-to-user system:build-strategy-docker devuser
oc create clusterrole pod-reader --verb=get,list,watch --resource=pods
oc create clusterrole foo --verb=get --resource=rs.apps        # group-qualified
oc create clusterrole foo --verb=get,list,watch --resource=pods,pods/status   # subresource
oc create clusterrole foo --verb=get --non-resource-url=/logs/*
```

Checking permissions (exact examples from CLI reference + SCC docs): [R19][R20]

```bash
oc auth can-i create pods --all-namespaces
oc auth can-i list deployments.apps
oc auth can-i '*' '*'
oc auth can-i list pods --as=system:serviceaccount:dev:foo -n prod
oc auth can-i get pods --subresource=log
oc auth can-i use scc/privileged
oc auth can-i --list --namespace=foo
oc auth whoami
oc adm policy who-can <verb> <resource>        # e.g. who-can create pods
oc get rolebindings -n <project>
oc get clusterrolebindings
oc describe rolebinding <name> -n <project>
oc get roles -n <project>
oc get clusterrole view -o yaml
```

Local vs cluster: a local RoleBinding to `cluster-admin` grants those powers **only in that namespace**. [R8]

### 7.4 Users, identities, groups (the mechanics behind "create/delete users; groups; passwords")

Identity-provider users are usually **auto-provisioned at first login**: the IDP supplies an _Identity_ (e.g. `my_htpasswd_provider:alice`), OpenShift maps it to a _User_ (mappingMethod `claim`). Manual objects exist for edge cases: `oc create user`, `oc create identity`, `oc create useridentitymapping`. [R9][R19]

```bash
oc get users
oc get groups
oc create user ajones --full-name="Adam Jones"
oc create identity my_htpasswd_provider:ajones
oc create useridentitymapping my_htpasswd_provider:ajones ajones
oc whoami
oc login -u ajones -p <password>
oc adm groups new my-group user1 user2          # create group + members
oc adm groups add-users my-group user3
oc adm groups remove-users my-group user3
oc get groups
oc get group my-group -o yaml                   # users[], after add
oc adm policy add-role-to-group edit my-group -n myproject
oc adm policy add-cluster-role-to-group cluster-admin my-group
oc delete user ajones
oc delete identity my_htpasswd_provider:ajones
```

Groups are `user.openshift.io/v1 Group` objects; the `users` list on the Group is the authoritative membership. When you delete a user, also delete its Identity (otherwise stale mapping/tokens). [R9]

### 7.5 HTPasswd identity provider — full lab flow (V422 explicit)

Provider CR: `config.openshift.io/v1 OAuth` named **cluster**, in namespace `openshift-config`. [R9]

```bash
# 1) create the htpasswd file (httpd-tools package provides htpasswd)
htpasswd -c -B -b users.htpasswd alice 'ChangeMe123!'
htpasswd -B -b users.htpasswd bob   'ChangeMe456!'

# 2) secret in openshift-config — the key MUST be "htpasswd"
oc create secret generic htpass-secret \
  --from-file=htpasswd=users.htpasswd -n openshift-config

# 3) OAuth CR (apply/replace; the resource named "cluster" is the only one)
oc apply -f - <<'EOF'
apiVersion: config.openshift.io/v1
kind: OAuth
metadata:
  name: cluster
spec:
  identityProviders:
  - name: my_htpasswd_provider
    mappingMethod: claim
    type: HTPasswd
    htpasswd:
      fileData:
        name: htpass-secret
EOF

# 4) verify
oc get oauth cluster -o yaml
oc login -u alice -p 'ChangeMe123!'
oc whoami
```

**Modify a user's password** (the exam objective!): you do not edit a User object — you update the htpasswd file/secret and optionally the Identity: [R9]

```bash
# pull current file out of the secret, change it, push it back
oc get secret htpass-secret -ojsonpath={.data.htpasswd} -n openshift-config | base64 --decode > users.htpasswd
htpasswd -B -b users.htpasswd alice 'NewPass456!'
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd \
  --dry-run=client -o yaml -n openshift-config | oc replace -f -

# remove a user entirely
htpasswd -D users.htpasswd bob
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd \
  --dry-run=client -o yaml -n openshift-config | oc replace -f -
oc delete user bob
oc delete identity my_htpasswd_provider:bob
```

⚠️ Docs warning: HTPasswd auth is intended for development/lab use, not production; the exam still uses it because it is local and stable. [R9]

Kubeadmin (lab detail, optional): `oc get secrets -n kube-system | grep kubeadmin`, `oc delete secret kubeadmin -n kube-system`. Not needed for V422 objectives but a classic lab cleanup step.

### 7.6 Identity-provider troubleshooting symptoms

| Symptom                                   | Likely cause / fix                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oc login` says invalid username/password | htpasswd secret not updated / OAuth not applied / wrong provider name; check `oc get oauth cluster -o yaml`, `oc get secret htpass-secret -n openshift-config` |
| Login works but user has no access        | `self-provisioner` or role bindings missing; `oc auth can-i` / `oc adm policy add-role-to-user`                                                                |
| Deleted user still has a token            | tokens are not revoked on `oc delete user`; also delete Identity, and remember long-lived tokens (preexisting) stay valid until expired                        |
| `oc login` fails after IDP edit           | wait for OAuth rollout: `oc get pods -n openshift-authentication`, `oc get clusteroperator authentication`                                                     |

**Game hooks**

- Level: "Onboard the dev team" — htpasswd file + secret + OAuth + group + `add-role-to-user edit` + password rotation; final check `oc login` as each user and `oc auth can-i`.
- Incident: "alice can't see her project" (no RoleBinding), "password rotation keeps old login working" (secret not replaced), "group has right role but user missing from group" (`oc get group -o yaml`).
- Command bar: `htpasswd`, `oc create secret generic htpasswd...`, `oc apply oauth`, `oc adm groups *`, `oc adm policy add-role-to-*`, `oc auth can-i`, `oc whoami`, `oc login`.

---

## 8. Quotas, LimitRanges, and developer self-service (V422: "Enable developer self-service")

Canonical: quotas in the _Building applications_ book [R35]; LimitRange in the _Nodes_ book [R12]; project templates/self-provisioner in the _Configuring project creation_ chapter of the _Building applications_ book [R35].

### 8.1 The four objects (don't mix them up)

| Object                 | Scope            | apiVersion/kind                                                                                                             | What it does                                                                                   |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ResourceQuota`        | namespace        | `v1 ResourceQuota`                                                                                                          | caps **aggregate** requests/limits and object counts per project                               |
| `ClusterResourceQuota` | cluster          | `quota.openshift.io/v1 ClusterResourceQuota`                                                                                | one quota applied to selected projects (by annotation/label selector)                          |
| `LimitRange`           | namespace        | `v1 LimitRange`                                                                                                             | per-container/pod **min/max/default/defaultRequest/ratio**; injects defaults                   |
| project template       | cluster (config) | `template.openshift.io/v1 Template` referenced by `project.config.openshift.io/v1 Project.spec.projectRequestTemplate.name` | objects created automatically in every new project (quota + limitrange + networkpolicy + RBAC) |

Quota mechanism: when a ResourceQuota exists, every **new** pod must specify requests/limits (or a LimitRange must supply defaults) — otherwise admission rejects it with `FailedCreate ... must specify limits/requests`. This interaction is the most common exam trap for "project resource requirements". [R23]

### 8.2 ResourceQuota — commands + YAML

```bash
oc create quota my-quota --hard=cpu=1,memory=1G,pods=2,services=3,secrets=5,persistentvolumeclaims=10
oc create quota test --hard=count/deployments.apps=2,count/replicasets.apps=4,count/pods=3,count/secrets=4
oc get resourcequota
oc describe quota test
oc get quota -o yaml
oc delete quota my-quota
```

Sample quota definitions (verbatim): [R23]

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-resources
spec:
  hard:
    pods: '4'
    requests.cpu: '1'
    requests.memory: 1Gi
    limits.cpu: '2'
    limits.memory: 2Gi
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: core-object-counts
spec:
  hard:
    configmaps: '10'
    persistentvolumeclaims: '4'
    secrets: '10'
    services: '10'
    services.loadbalancers: '2'
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort
spec:
  hard:
    pods: '1'
  scopes:
    - BestEffort
```

Scopes: `Terminating`, `NotTerminating`, `BestEffort`, `NotBestEffort`, `PriorityClass`, `CrossNamespacePodAffinity`. [R23]

### 8.3 ClusterResourceQuota (multi-project quota) — V422 explicit

Select projects by annotation (e.g. the default `openshift.io/requester` used by project requests) or label: [R23]

```bash
oc create clusterquota for-user \
  --project-annotation-selector openshift.io/requester=<user_name> \
  --hard pods=10 --hard secrets=20

oc create clusterresourcequota for-name \
  --project-label-selector=name=frontend \
  --hard=pods=10 --hard=secrets=20

oc get clusterresourcequota
oc describe clusterresourcequota for-user
oc get appliedclusterresourcequota -n myproject        # view what applies to a project
oc describe appliedclusterresourcequota
```

```yaml
apiVersion: quota.openshift.io/v1
kind: ClusterResourceQuota
metadata:
  name: for-user
spec:
  quota:
    hard:
      pods: '10'
      secrets: '20'
  selector:
    annotations:
      openshift.io/requester: <user_name>
    labels: null
```

⚠️ For a user to create projects, the cluster must still allow self-provisioning (`self-provisioner` ClusterRole bound to `system:authenticated:oauth` — the default). [R35]

### 8.4 LimitRange — commands + YAML

```bash
oc create -f limitrange.yaml -n myproject
oc get limitrange
oc describe limitrange resource-limits
oc delete limitrange resource-limits
```

Combined LimitRange (Container + Pod + Image + ImageStream + PVC): [R12]

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: resource-limits
spec:
  limits:
    - type: Container
      max: { cpu: '2', memory: '1Gi' }
      min: { cpu: '100m', memory: '4Mi' }
      default: { cpu: '300m', memory: '200Mi' }
      defaultRequest: { cpu: '200m', memory: '100Mi' }
      maxLimitRequestRatio: { cpu: '10' }
    - type: Pod
      max: { cpu: '2', memory: '1Gi' }
      min: { cpu: '200m', memory: '6Mi' }
    - type: PersistentVolumeClaim
      min: { storage: '2Gi' }
      max: { storage: '50Gi' }
```

**V422 phrase "Configure project resource requirements"** usually means: defaults/limits for pods in a project (LimitRange `default`/`defaultRequest` + required requests under quota). Tutorial flow: create project → apply LimitRange → apply ResourceQuota → deploy app with no resources → show injected defaults → deploy too-large pod → show rejection.

### 8.5 Project templates + self-provisioning (V422: "Configure project templates")

Flow (verbatim): [R35]

```bash
oc adm create-bootstrap-project-template -o yaml > template.yaml
# edit template.yaml: add ResourceQuota, LimitRange, NetworkPolicy, RoleBinding objects
oc create -f template.yaml -n openshift-config
oc edit project.config.openshift.io/cluster
# set:
# spec:
#   projectRequestTemplate:
#     name: project-request      # or your template's name
oc new-project demo                  # must inherit your objects
```

The template should return the standard objects; the canonical default template name is `project-request`. [R35]

Disable self-provisioning (so only admins create projects): [R35]

```bash
oc describe clusterrolebinding.rbac self-provisioners        # default subject: system:authenticated:oauth
oc adm policy remove-cluster-role-from-group self-provisioner system:authenticated:oauth
oc patch clusterrolebinding.rbac self-provisioners -p '{"subjects": null}'
oc patch clusterrolebinding.rbac self-provisioners -p \
  '{ "metadata": { "annotations": { "rbac.authorization.kubernetes.io/autoupdate": "false" } } }'
oc new-project test        # as a normal user -> Forbidden: You may not request a new project via this API.
```

### 8.6 Standalone quota for Jobs (V422 includes Jobs/CronJobs)

Jobs consume quota for their pods; `count/batch.jobs` and `count/cronjobs.batch` object counts are valid quota keys. `oc create job my-job --image=busybox -- date` and `oc create cronjob my-job --image=busybox --schedule="*/1 * * * *" -- date` are the CLI reference forms. [R19][R23]

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: pi }
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: pi
          image: perl:5.34
          command: ['perl', '-Mbignum=bpi', '-wle', 'print bpi(2000)']
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: hello }
spec:
  schedule: '*/5 * * * *'
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: hello
              image: busybox:1.36
              command: ['/bin/sh', '-c', 'date; echo Hello from OpenShift']
              resources:
                requests: { cpu: 100m, memory: 64Mi }
                limits: { cpu: 200m, memory: 128Mi }
```

`oc get jobs`, `oc get cronjobs`, `oc logs job/pi`, `oc delete job pi`, `oc create job test-job --from=cronjob/a-cronjob`. [R19]

**Game hooks**

- Incident: "New pods Pending/FailedCreate after quota" — show `oc describe quota` Used/Hard and the admission error; fix = right-size requests or raise quota/limitrange.
- Incident: "Project has quota but no LimitRange → default app can't deploy" — the classic missing-requests trap.
- Level: "Onboard a new tenant automatically" — project template with quota+limitrange+networkpolicy + ClusterResourceQuota by requester annotation.
- Command bar: `oc create quota`, `oc create clusterquota`, `oc create -f limitrange.yaml`, `oc describe quota`, `oc get appliedclusterresourcequota`, `oc adm create-bootstrap-project-template`, `oc edit project.config.openshift.io/cluster`.

---

## 9. Storage — BACKGROUND ONLY (not an explicit EX280V422 objective)

> **Status:** Storage (PV/PVC/StorageClass/CSI) is **not** in the EX280V422 objective list (verified 2026-11-03). It is included because the game already simulates volumes, project templates often carry PVCs, and StatefulSet/template levels need it. Keep this section one screen; don't build primary campaign content on it. [R14][R15][R29]

### 9.1 Core objects

| Object                      | Scope     | apiVersion/kind                                        | Notes                                                                                              |
| --------------------------- | --------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| PersistentVolume (PV)       | cluster   | `v1 PersistentVolume`                                  | capacity, accessModes, reclaimPolicy, storageClassName, backend (`nfs`, `hostPath`, CSI…)          |
| PersistentVolumeClaim (PVC) | namespace | `v1 PersistentVolumeClaim`                             | request size + accessModes + storageClassName; binds 1:1 to a PV                                   |
| StorageClass                | cluster   | `storage.k8s.io/v1 StorageClass`                       | dynamic provisioning template; `storageclass.kubernetes.io/is-default-class: "true"` marks default |
| CSI driver                  | cluster   | `operator.openshift.io/v1 ClusterCSIDriver` / operator | provisioner behind a StorageClass; `oc get sc`, `oc get clustercsidriver`                          |
| ConfigMap / Secret          | namespace | `v1 ConfigMap` / `v1 Secret`                           | non-storage config objects also mounted as volumes (§6.6)                                          |

Access modes: `ReadWriteOnce` (RWO, single node), `ReadWriteOncePod` (RWOP), `ReadOnlyMany` (ROX), `ReadWriteMany` (RWX). Modes describe capabilities, not enforcement. [R15]

### 9.2 YAML + commands

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: myclaim
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 8Gi
  storageClassName: gold # omit to use the default class
```

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gold
  annotations:
    storageclass.kubernetes.io/is-default-class: 'true'
provisioner: ebs.csi.aws.com # example cloud CSI; on-prem: LVM/ODF/NFS/CSI vendor
parameters:
  type: gp3
```

```bash
oc get storageclass                    # "(default)" marks the default class
oc get sc
oc get pvc
oc get pv
oc describe pvc myclaim
oc get pv <pv> -o jsonpath='{.spec.claimRef.name}'
oc adm top persistentvolumeclaims -A   # usage (metrics-based)
# change default class
oc patch storageclass standard -p '{"metadata": {"annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}'
oc patch storageclass gp3 -p '{"metadata": {"annotations": {"storageclass.kubernetes.io/is-default-class": "false"}}}'
```

### 9.3 `oc set volume` on workloads (classic EX280-era command, still useful in the game)

```bash
oc set volume dc --all
oc set volume dc/myapp --add --mount-path=/var/lib/myapp
oc set volume dc/myapp --add --name=v1 -t pvc --claim-name=pvc1 --overwrite
oc set volume dc/myapp --add --name=v1 -t pvc --claim-size=1G --overwrite
oc set volume dc/myapp --add --name=v1 -m /data --overwrite
oc set volume dc/myapp --remove --name=v1
oc set volume dc/myapp --remove --name=v1 --containers=c1
```

For `apps/v1 Deployment` prefer `oc set volume deployment/myapp ...` or edit the YAML (`volumes` + `volumeMounts`); the command works on objects with pod templates. [R19]

### 9.4 StatefulSet + volumeClaimTemplates (Kubernetes semantics, current stable apiVersion `apps/v1`)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: web }
spec:
  serviceName: web # headless service
  replicas: 3
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: registry.access.redhat.com/ubi9/ubi:latest
          command: ['sleep', 'infinity']
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates: # creates data-web-0, data-web-1, data-web-2 PVCs
    - metadata:
        name: data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 1Gi
```

StatefulSet pods get stable names/ordinals and stable DNS via the headless `serviceName`; PVC retention after scale-down is the default (pods/PVCs are not deleted automatically). [R29]

**Game hooks**

- Incident: "PVC Pending" (no matching PV, wrong accessMode, storageClass typo, no default class).
- Keep volume simulation secondary; the EX280V422 campaign should prefer Secrets/ConfigMaps/quota/template levels over PV levels.

---

## 10. Scheduling — SUPPORTING (not in the EX280V422 objective list)

> **Status:** the EX280V422 list has no "configure pod scheduling" domain (it existed in older versions). Keep it as supporting knowledge: it appears indirectly in `IngressController.spec.nodePlacement`, node maintenance/drain, resource/limit work, and any "why is my pod Pending" incident. Commands/YAML below are from the 4.22 _Nodes → Controlling pod placement_ chapter. [R13]

### 10.1 Labels, node selectors

```bash
oc label node <node> region=east type=user-node
oc get nodes --show-labels
oc get nodes -l type=user-node,region=east
oc label node <node> region-            # remove
```

```yaml
spec:
  nodeSelector:
    region: east
    type: user-node
```

If `nodeSelector` matches no node → pod stays `Pending` (`0/N nodes are available: N node(s) didn't match Pod's node affinity/selector`). [R13]

### 10.2 Node affinity (required/preferred) and pod affinity/anti-affinity

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ['east-1a', 'east-1b']
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 1
          preference:
            matchExpressions:
              - { key: node.kubernetes.io/instance-type, operator: In, values: ['m5.large'] }
```

Operators: `In`, `NotIn`, `Exists`, `DoesNotExist`, `Lt`, `Gt` (`nodeSelector` and `nodeAffinity` combine with AND; multiple `nodeSelectorTerms` OR; multiple `matchExpressions` AND). [R13]

Pod affinity/anti-affinity (co-locate or spread relative to other pods) — `podAffinity`/`podAntiAffinity` with `topologyKey` (e.g. `kubernetes.io/hostname`, `topology.kubernetes.io/zone`). Topology spread constraints are the modern spread mechanism. Keep to concept + one example for the game. [R13]

### 10.3 Taints / tolerations

```bash
oc adm taint nodes node1 key1=value1:NoSchedule
oc adm taint nodes node1 key1:NoSchedule-          # remove one taint
oc adm taint nodes node1 dedicated-                # remove all with key
oc adm taint node -l myLabel=X dedicated=foo:PreferNoSchedule
oc describe node node1 | grep -A3 Taints
```

Effects: `NoSchedule` (don't place new non-tolerating pods), `PreferNoSchedule` (soft), `NoExecute` (evict existing non-tolerating pods). Tolerations match on key/value/effect with operator `Equal`/`Exists`; `tolerationSeconds` controls eviction delay. [R13]

```yaml
spec:
  tolerations:
    - key: 'key1'
      operator: 'Equal'
      value: 'value1'
      effect: 'NoExecute'
      tolerationSeconds: 3600
```

### 10.4 Node maintenance: cordon / drain / uncordon

```bash
oc adm cordon <node>                 # mark unschedulable
oc adm drain <node> --force           # evict pods (force even for non-controller pods)
oc adm drain <node> --grace-period=900
oc adm drain <node> --ignore-daemonsets --delete-emptydir-data    # common flags
oc adm uncordon <node>               # schedulable again
oc get nodes
oc describe node <node>
```

`drain` is the maintenance primitive used during upgrades and in "evacuate a node" labs; DaemonSet pods need `--ignore-daemonsets`, emptyDir data needs `--delete-emptydir-data`. [R13]

### 10.5 MachineConfig / MachineConfigPool (awareness only)

Node-level changes (kernel args, registries, kubelet) flow through `MachineConfig` (`machineconfiguration.openshift.io/v1`) applied to `MachineConfigPool`s (`oc get mcp`), which cordon/drain/reboot per pool and roll out with `oc get mcp` showing DEGRADED/UPDATING/UPDATED. The Machine Config Operator is a cluster operator (`oc get co machine-config`). Not an EX280V422 objective — one-liner in the game's "cluster health" docs is enough. [R12]

**Game hooks**

- Incident: "Pod Pending — node selector typo / taint not tolerated / insufficient CPU" — inspect `oc describe pod` events (Scheduler section).
- Incident: "Drain worker before maintenance — half the app goes down" → teach `oc adm drain --ignore-daemonsets` + PDB awareness.
- Reuse existing scheduling game content; re-label as supporting.

---

## 11. Monitoring and troubleshooting (cluster health, events, logs, probes, failure states)

Canonical: _Support_ book — Gathering data [R16], Troubleshooting chapter [R17]; CLI reference for commands ([R18] book, [R19] by-example pages); pod error states page [R17].

### 11.1 Everyday observability commands

```bash
oc get pods -A -o wide
oc get pods -n <ns> --show-labels
oc get all -n <ns>
oc describe pod <pod>
oc logs <pod>
oc logs -f deploy/<deploy>
oc logs -f buildconfig/<bc>          # builds (task-2 territory)
oc logs -f bc/openldap
oc exec -it <pod> -- /bin/sh
oc rsh <pod>
oc port-forward <pod> 8080:8080
oc get events -n <ns> --sort-by=.lastTimestamp
oc events                             # oc events: recent events (CLI reference)
oc events --for pod/<pod> --watch
oc events -oyaml
oc events --types=Warning,Normal
oc get events --field-selector type=Warning
oc adm top pod
oc adm top pod --containers
oc adm top node
oc adm top node <node>
oc adm top persistentvolumeclaims -A
oc adm inspect ns/<project>
oc adm inspect clusteroperator/<name>
oc adm must-gather
oc adm must-gather --dest-dir=/local/dir
oc adm must-gather -- /usr/bin/gather_audit_logs
oc adm must-gather --dest-dir=my-project-must-gather -- oc adm inspect ns/my-project
```

`oc adm top` requires the metrics stack (cluster monitoring); in a lab with monitoring disabled, the game should model a friendly "metrics not available" message. [R19]

### 11.2 Cluster health triage (expect the exam to ask "assess cluster health")

```bash
oc get nodes                                      # Ready / NotReady, roles
oc get co                                        # clusteroperators: Available/Progressing/Degraded
oc get co network ingress authentication machine-config
oc get clusterversion                            # version + update status
oc get events -A --sort-by=.lastTimestamp | tail -30
oc describe node <node> | sed -n '/Conditions/,/Addresses/p'
oc adm top nodes
oc status
oc status --suggest
oc get pods -n openshift-ovn-kubernetes -o wide
oc get pods -n openshift-ingress -o wide
oc get pods -n openshift-etcd -o wide
```

`oc status --suggest` includes remediation hints for detected issues; `oc get co` is the fastest "is the platform healthy" check (Degraded condition). [R19]

### 11.3 Probes (needed for "troubleshoot container/pod events")

```yaml
spec:
  containers:
    - name: app
      image: ...
      readinessProbe: # traffic readiness; Service endpoints only when Ready
        httpGet: { path: /readyz, port: 8080 }
        initialDelaySeconds: 3
        periodSeconds: 5
      livenessProbe: # restarts container on failure
        httpGet: { path: /healthz, port: 8080 }
        initialDelaySeconds: 10
        periodSeconds: 10
      startupProbe: # slow-start guard; liveness disabled until success
        httpGet: { path: /healthz, port: 8080 }
        failureThreshold: 30
        periodSeconds: 5
```

CLI equivalents: `oc set probe deployment/webapp --readiness --get-url=http://:8080/healthz`, `oc set probe dc/myapp --liveness -- echo ok`, `oc set probe ... --remove --readiness --liveness`. [R19]

### 11.4 Failure-state → cause → fix table (the game's incident engine goldmine)

| State / symptom                                                         | Read it as                                                                                        | Typical fix (commands)                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Pending` (no node)                                                     | no schedulable node, nodeSelector/affinity mismatch, taints, insufficient CPU/memory, quota pends | `oc describe pod`, `oc get nodes`, `oc describe node`, fix selector/resources/quota                                                 |
| `Pending` (quota)                                                       | namespace at `requests.cpu`/`memory` hard limit                                                   | `oc describe quota`, raise quota or lower requests                                                                                  |
| `ContainerCreating` long                                                | PVC not bound, CNI/IP issue, image pull slow, SCC admission retry                                 | `oc describe pod` events, `oc get pvc`, `oc get events`                                                                             |
| `ImagePullBackOff` / `ErrImagePull`                                     | bad image name/tag, registry auth, image pull secret missing/wrong, internal registry route/cert  | `oc describe pod` (Events), `oc get secret`, `oc get sa default -o yaml`, `oc secrets link ... --for=pull`, `oc get imagestreamtag` |
| Image pull fails for internal-registry images                           | imagestream/tag not imported, registry route/cert, or image pull secret missing                   | `oc get istag`, `oc import-image`, `oc get sa default -o yaml`, `oc secrets link ... --for=pull`                                    |
| `CrashLoopBackOff`                                                      | app exits non-zero; bad config/secret/env, missing volume, command typo                           | `oc logs`, `oc logs --previous`, `oc describe pod`, fix configmap/secret/env                                                        |
| `CreateContainerConfigError`                                            | referenced ConfigMap/Secret key missing                                                           | `oc describe pod`, `oc get cm/secret`, create/fix object                                                                            |
| `RunContainerError` / `ErrRunInitContainer`                             | init container failed, permissions                                                                | `oc logs -c <init>`, SCC/uid issues                                                                                                 |
| `Forbidden: unable to validate against any security context constraint` | pod requests not matched by any usable SCC (privileged/runAsUser/hostPath/caps)                   | grant SCC (`oc adm policy add-scc-to-user`) or remove request; inspect with `oc auth can-i use scc/<scc>`                           |
| `Forbidden ... exceeded quota` / `must specify limits`                  | ResourceQuota enforcement without LimitRange defaults                                             | add requests/limits or LimitRange; `oc describe quota`                                                                              |
| `route not admitted` / 503                                              | host conflict, wildcard disallowed, shard mismatch, no endpoints, TLS secret issue                | `oc describe route`, `oc get route -o yaml` (status conditions), `oc get endpointslices`, `oc get pods -n openshift-ingress`        |
| `403` from API inside pod                                               | SA RBAC missing                                                                                   | `oc auth can-i ... --as=system:serviceaccount:ns:sa`, add role binding                                                              |
| `no such host` / DNS timeouts                                           | NetworkPolicy egress blocks DNS, DNS pods degraded                                                | `oc exec ... nslookup`, `oc get pods -n openshift-dns`, add port-53 egress policy                                                   |
| `connection refused` cross-namespace                                    | default-deny NetworkPolicy                                                                        | `oc get networkpolicy`, add allow policy, retest                                                                                    |
| Pods OOMKilled                                                          | memory limit too low                                                                              | `oc describe pod`, raise limit (or fix leak)                                                                                        |
| `oc adm must-gather` needed                                             | platform-level issue                                                                              | collect with `--dest-dir`, include network logs variant                                                                             |

Sources: pod error states table [R17], events/logs/exec commands [R19], SCC validation mechanics [R20], quota mechanics [R23], network policy behaviour [R5], route status [R3].

### 11.5 The "must-gather / inspect / debug" trio (EX280 troubleshooting trinity)

```bash
oc adm must-gather                         # cluster-wide diagnostic bundle (default plugin)
oc adm must-gather -- /usr/bin/gather_network_logs    # network logs
oc adm inspect ns/my-project                # targeted namespace data (also usable standalone)
oc adm inspect clusteroperator/network
oc debug node/<node>                        # privileged debug pod on node; chroot /host
oc debug deploy/myapp                       # copy of workload with shell
oc debug node/<node> -- chroot /host        # run one host command
oc get events -A --sort-by=.lastTimestamp    # timeline before collecting
```

`must-gather` writes `must-gather.local.<rand>` in the CWD; it runs pods in `openshift-must-gather-*` namespaces. `oc debug` and `oc adm must-gather` intentionally use the `default` SA (4.22 notable change). [R16][R19]

**Game hooks**

- Build incidents around 4–6 canonical states above; reward the _exact_ diagnostic command (`oc describe pod` first, then `oc logs --previous`, then events).
- Show live "Events:" lines in the Inspector panel (Kubernetes event objects ↔ `oc get events`).
- Command bar: add `oc events`, `oc adm top pod|node`, `oc adm must-gather`, `oc adm inspect`, `oc debug node`, `oc logs --previous`, `oc set probe`.

---

## 12. End-to-end exam-style lab flows

Each flow lists the exact command sequence. These are designed to become campaign levels; they are ordered by dependency (L1 → L7).

### L1 — HTTP app + edge route with a self-signed certificate (EX280 core)

1. `oc new-project demo`
2. Deploy app: `oc create deployment hello --image=registry.access.redhat.com/ubi9/httpd-24:latest --replicas=1` (or `oc new-app`), then `oc expose deployment/hello --port=8080 --name=hello` (creates Service + Route; simpler: `oc expose deploy hello --port=8080` then `oc expose svc hello`).
3. `oc logs -f deploy/hello` until running; `oc get pods`.
4. Create cert (§2.6): `openssl req -x509 ... -subj "/CN=hello.apps.example.com" -addext "subjectAltName=DNS:hello.apps.example.com"`.
5. `oc create route edge hello --service=hello --cert=tls.crt --key=tls.key --hostname=hello.apps.example.com`.
6. Verify: `oc get route`, `oc describe route hello` (Admitted=True), `curl -k https://hello.apps.example.com`, `openssl s_client ...`.
7. Break/fix variant: change host to an already-claimed hostname → observe host-claim error; fix with `namespaceOwnership: InterNamespaceAllowed` or a new host.

### L2 — Route variants: path, passthrough, reencrypt, edit

1. Two services (`frontend`, `api`) in one project.
2. `oc expose svc frontend --hostname=www.example.com`; `oc expose svc api --hostname=www.example.com --path=/api`.
3. `oc create route passthrough secure --service=backend --hostname=secure.example.com` (backend serves TLS itself; no path allowed).
4. `oc create route reencrypt reenc --service=backend2 --cert=tls.crt --key=tls.key --dest-ca-cert=destca.crt --hostname=reenc.example.com`.
5. `oc get routes` — compare TERMINATION column.
6. Practice edit: `oc edit route api`, change path; `oc get route api -o yaml`.

### L3 — Cluster health + ingress control

1. `oc get co`, `oc get nodes`, `oc get clusterversion`, `oc get pods -n openshift-ingress`.
2. `oc describe clusteroperator/ingress`.
3. `oc patch -n openshift-ingress-operator ingresscontroller/default --type=merge -p '{"spec":{"replicas":3}}'`; watch router pods.
4. `oc get pods -n openshift-ingress -o wide`; `oc delete pod -l ingresscontroller.operator.openshift.io/deployment-ingresscontroller=default -n openshift-ingress`; observe recreation.
5. `oc get events -A --sort-by=.lastTimestamp | tail`.
6. Collect `oc adm must-gather --dest-dir=/tmp/mg` (or explain when to use).

### L4 — HTPasswd users/groups + RBAC + password rotation

1. `htpasswd -c -B -b users.htpasswd alice 'Passw0rd1!'`; add bob.
2. `oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`.
3. Apply OAuth CR (§7.5).
4. `oc login -u alice -p 'Passw0rd1!'` → success; `oc whoami`.
5. As admin: `oc adm groups new devs alice bob`; `oc adm policy add-role-to-group edit devs -n demo`; `oc new-project demo` as admin first.
6. Verify as alice: `oc get pods -n demo` works, `oc delete project demo` forbidden (`oc auth can-i`).
7. Rotate alice's password via htpasswd secret replace; delete bob user/identity; verify old login fails.
8. Test `oc auth can-i`, `oc adm policy who-can edit`.

### L5 — Default-deny NetworkPolicy + allow + DNS egress + verification

1. Two projects `demo` and `backend`, each with labeled apps.
2. Apply `deny-by-default` in demo → test from backend pod: blocked.
3. Apply `allow-same-namespace`, `allow-traffic-pod` (specific namespace label) → test allowed/denied paths.
4. Add default-deny **egress** + DNS allow + explicit backend allow; `oc exec` nslookup/curl from demo pods.
5. Verify with `oc run test --rm -i -t --image=alpine -- sh`; `oc describe networkpolicy`.
6. Break/fix: remove DNS egress rule → curl fails → restore.

### L6 — Developer self-service: quota + limitrange + ClusterResourceQuota + project template

1. `oc adm create-bootstrap-project-template -o yaml > template.yaml`; edit to add ResourceQuota + LimitRange + NetworkPolicy; `oc create -f template.yaml -n openshift-config`; `oc edit project.config.openshift.io/cluster` to set `projectRequestTemplate.name`.
2. `oc new-project selfservice` → `oc get quota,limitrange,networkpolicy -n selfservice` shows inherited objects.
3. Try a pod without resources → LimitRange defaults appear (`oc get pod -o yaml`).
4. `oc create quota big --hard=pods=1`; deploy 2 pods → second rejected; `oc describe quota big`.
5. `oc create clusterquota per-user --project-annotation-selector=openshift.io/requester=alice --hard=pods=5`; `oc get appliedclusterresourcequota -n selfservice`.
6. (Optional) Job/CronJob with quota: `oc create job`, `oc create cronjob`, verify counts in `oc describe quota`.

### L7 — Non-HTTP exposure with MetalLB/NodePort

1. Deploy a TCP app (e.g. `registry.access.redhat.com/ubi9/ubi-minimal` running `nc`) or use HTTP on a LoadBalancer for the plumbing.
2. Ensure MetalLB Operator + `IPAddressPool` + `L2Advertisement` exist (§4.1).
3. Create LoadBalancer service (annotation `metallb.io/address-pool`).
4. `oc get svc` → EXTERNAL-IP; `curl http://<EXTERNAL-IP>` / `nc` from outside.
5. Create NodePort service; `oc get svc` → 30000-range port; `curl http://<node-ip>:<nodePort>`.
6. Explain that a Route is the wrong tool for non-HTTP/SNI.

---

## 13. Game-conversion hooks (for the content/engine authors)

### 13.1 Command-bar conversion targets for this research area

Current K8s game undoubtedly has `kubectl`-style verbs. For this half of EX280, the command bar needs at minimum:

```
oc expose svc <name> [--hostname H] [--path P] [--name N] [--wildcard-policy Subdomain]
oc create route edge|passthrough|reencrypt <name> --service S [--hostname H] [--path P] [--cert F] [--key F] [--ca-cert F] [--dest-ca-cert F] [--insecure-policy None|Redirect|Allow] [--wildcard-policy None|Subdomain]
oc get route|routes [NAME] [-o yaml|json|wide]
oc describe route NAME
oc edit route NAME / oc patch route NAME --type=merge -p '{...}'
oc create service clusterip|nodeport|loadbalancer|externalname ...
oc get svc|services|endpoints|endpointslices
oc get ingresscontroller -n openshift-ingress-operator
oc edit ingresscontroller default -n openshift-ingress-operator
oc get pods -n openshift-ingress
oc get co | oc get clusteroperators | oc describe clusteroperator/ingress
oc get networkpolicy | oc describe networkpolicy NAME
oc get scc | oc describe scc NAME
oc adm policy add-scc-to-user SCC -z SA | user
oc adm policy add-scc-to-group SCC GROUP
oc adm policy add-role-to-user ROLE USER [-n NS] | -z SA
oc adm policy add-cluster-role-to-user ROLE USER
oc adm policy remove-*-from-* ...
oc adm policy who-can VERB RESOURCE
oc auth can-i VERB RESOURCE [--as=...] | use scc/SCC | --list
oc get users | oc get groups | oc get identities
oc create sa NAME | oc get sa | oc describe sa NAME
oc create token SA [--duration D]
oc get scc -o yaml | oc get sa -o yaml
oc create secret generic|tls|docker-registry ... | oc set env --from=secret/NAME
oc create quota NAME --hard=... | oc create clusterquota NAME ...
oc get quota|resourcequota|limitrange | oc describe quota NAME
oc create -f limitrange.yaml | oc adm create-bootstrap-project-template -o yaml
oc edit project.config.openshift.io/cluster
oc get nodes | oc label node | oc adm cordon|drain|uncordon|taint
oc adm top pod|node [--containers]
oc events | oc get events [--sort-by=.lastTimestamp]
oc logs [-f] POD|deploy/NAME [--previous] [-c CONTAINER]
oc exec -it POD -- CMD | oc rsh POD | oc debug node/NODE | oc debug deploy/NAME
oc adm must-gather [--dest-dir D] [-- /usr/bin/gather_network_logs]
oc adm inspect ns/NS | clusteroperator/NAME
oc apply -f - (heredoc/YAML editor) | oc create -f file
```

Command behaviours the game should simulate faithfully (these are the "gotchas"):

- `oc get route` shows `TERMINATION` and `WILDCARD` columns; default host is generated; `Admitted` condition lives in `status.ingress[].conditions`.
- `oc create route edge` without `--cert/--key` is legal (router uses default cert) — the cert files are only needed for a _custom_ cert. [R32]
- `oc create route passthrough` has **no `--path`** flag. [R32]
- `oc create route reencrypt` without `--dest-ca-cert` defaults to the service CA. [R32]
- `oc adm policy add-role-to-user ... -z SA` (SA in current project) vs `-n` for namespace. [R19]
- `oc create token` replaced the "read the SA token secret" workflow in 4.16+. [R10]
- Deleting a user does **not** revoke existing tokens; delete Identity too. [R9]
- Deleting default SCCs is bad; they are recreated; editing them can break upgrades. [R20]
- `oc get scc` on a real 4.22 cluster may show `restricted-v3` depending on install; game should model the documented set (§6.2) with `restricted-v2` as the everyday default.

### 13.2 Incident ideas mapped to this reference

| Incident concept        | Wrong-state to inject                               | Expected player fix                                                       | §ref      |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| Route 503               | Service selector wrong → no endpoints               | fix selector / `oc expose` correct svc                                    | 1.2, 2.8  |
| Host already claimed    | two projects claim same host                        | change host OR `namespaceOwnership: InterNamespaceAllowed`                | 2.7       |
| Invalid cert            | expired/self-signed/different CN                    | regenerate cert, `oc create route edge --cert/--key`, or fix default cert | 2.3, 2.6  |
| Passthrough + path      | route configured with path + passthrough            | remove path / use edge+reencrypt                                          | 2.2, 2.5  |
| Wildcard route rejected | `wildcardPolicy` default Disallowed                 | patch IngressController `routeAdmission.wildcardPolicy`                   | 2.7       |
| Shard miss              | route label doesn't match `routeSelector`           | fix route label or shard selector; check `Admitted`                       | 3.5       |
| Router Pending on node  | drain removed router pods; nodePlacement too strict | fix nodePlacement tolerations/selectors; replicas                         | 3.2, 10.4 |
| LB pending              | no MetalLB operator/pool                            | install operator, create IPAddressPool+L2Advertisement, annotate svc      | 4.1       |
| Wrong service type      | player uses Route for TCP DB                        | recreate as LoadBalancer/NodePort                                         | 4.2–4.4   |
| Default-deny break      | policy added, all traffic dies                      | add same-ns/router/DNS allow policies                                     | 5.3       |
| DNS blocked             | egress default-deny without 53                      | add UDP/TCP 53 egress                                                     | 5.3       |
| Forbidden SCC           | privileged pod as default SA                        | grant SCC to SA or adjust securityContext                                 | 6.4       |
| Lost token              | player expects long-lived SA token secret           | `oc create token` or bound projected token                                | 6.5       |
| Registry auth           | imagePullSecret missing / SA not linked             | `oc create secret docker-registry` + `oc secrets link --for=pull`         | 6.5       |
| User no access          | login succeeds, RBAC missing                        | `oc adm policy add-role-to-user` / group binding                          | 7.3       |
| Password stuck          | htpasswd file edited but secret not replaced        | replace `htpass-secret`, delete stale user if removed                     | 7.5       |
| Quota deadlock          | quota exists, no LimitRange defaults                | add LimitRange defaults or requests/limits                                | 8.1–8.4   |
| Tenant quotas           | per-user ClusterResourceQuota missing               | create ClusterResourceQuota by requester annotation                       | 8.3       |
| No-inherit project      | template not wired to `projectRequestTemplate`      | fix project config / recreate project                                     | 8.5       |
| Pod Pending scheduler   | taint/selector/resources                            | inspect events, fix                                                       | 10, 11.4  |
| CrashLoop               | bad config map key                                  | `oc logs --previous`, fix secret/cm                                       | 11.4      |
| Platform degraded       | `oc get co` Degraded / node NotReady                | triage per §11.2                                                          | 11.2      |

### 13.3 Achievements / scoring ideas (objective coverage)

- **Router**: create an edge route with custom cert; create passthrough route; reencrypt route; path-based route; fix host-claim conflict; fix shard admission.
- **Network security**: implement default-deny ingress + allow-list; DNS egress allow; prove isolation with tester pods; explain OVN-K vs SDN.
- **Exposure**: LoadBalancer via MetalLB; NodePort; explain route vs LB choice.
- **Identity bridge**: HTPasswd provider end-to-end; create group, bind role; rotate password; delete user+identity.
- **Gatekeeper**: quota + limitrange + project template + ClusterResourceQuota self-service flow.
- **Guardian**: repair SCC Forbidden workload; fix SA RBAC; repair image pull auth; issue SA token for API access.
- **Operator of last resort**: cluster-health triage with `oc get co`, `oc adm top`, events, `oc adm must-gather`.

---

## 14. Version caveats, uncertainties, and confidence notes

### 14.1 Verified version facts (2026-11-03)

- docs.redhat.com `openshift_container_platform/4.22` → HTTP 200; `4.23` → HTTP 404. `openshift-docs` branch `enterprise-4.22` exists with commit `a1ea307ec1ff90d82126e21f229a0c1142a9565d`.
- **docs.redhat.com now defaults to OpenShift 5.0**, and an `enterprise-5.0` docs branch exists. EX280V422 is pinned to the 4.22-era feature set; **all URLs in this doc are pinned `/4.22/`**.
- Exam version: EX280V422 objectives text extracted from the official Red Hat "Exam Objectives by Version" PDF on 2026-11-03. The PDF also contains older EX280K/V410/V45/V46/V412/V414 lists; make sure the game maps to **V422** (which drops storage/scheduling domains and adds declarative management/operators/network-security wording).

### 14.2 4.22-specific changes that affect game content

| Change                                                                                                                                                          | Impact for game                                                                                                                                        | Cite       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| OCP 4.22 ships default `NetworkPolicy` objects in some platform namespaces (DNS/Ingress); Do not modify them; don't run custom pods in those namespaces         | Model as trap: "why is my debug pod in openshift-ingress broken?"                                                                                      | [R5]       |
| Platform components use dedicated service accounts instead of `default`; `oc debug` and `oc adm must-gather` still use `default`                                | Don't teach "everything runs as default SA"                                                                                                            | [R33]      |
| HAProxy 2.8.18 in the router (4.22)                                                                                                                             | Just flavor text; TLS/cipher behaviour unchanged for lab                                                                                               | [R33]      |
| MetalLB `ConfigurationState` CR reports config health (4.22)                                                                                                    | Optional extra incident: check `oc get configurationstate -n metallb-system`                                                                           | [R33]      |
| Route external certificates (`.spec.tls.externalCertificate`) supported                                                                                         | Advanced route TLS level; needs RBAC Role+RoleBinding for `openshift-ingress:router`                                                                   | [R2]       |
| `restricted-v3` SCC documented as default for authenticated users in new 4.22 installs (user namespaces) — while `restricted-v2` remains the well-known default | ⚠️ Don't hard-code ONE answer in the game; display the SCC set from `oc get scc`; exam labs typically show restricted-v2. Verify on the target cluster | [R20]      |
| OpenShift SDN removed (since 4.17); OVN-Kubernetes only                                                                                                         | Remove any "OpenShift SDN" answer from quiz content; SDN troubleshooting = OVN/OVS pods + `oc debug node`                                              | [R5][R34]  |
| No auto long-lived SA token secret (since 4.16)                                                                                                                 | Use `oc create token`; old-style token-secret levels are traps                                                                                         | [R10]      |
| SCC admission errors and PSA coexistence                                                                                                                        | Show platform-realistic error shapes; don't invent exact text; support both gates                                                                      | [R20][R11] |

### 14.3 Confidence levels

- **High**: all command syntax/YAML in §§1–8 (verbatim from `enterprise-4.22` docs source and `openshift/oc release-4.22` flag definitions); API `apiVersion`/`kind` (docs API reference books); default SCC list and mechanics; HTPasswd flow; quota/limitrange/template flows; Route/IngressController fields; RBAC commands; troubleshooting command set; exam objective list (official PDF).
- **Medium** (flagged ⚠️ in text): exact SCC error-message wording (varies by OCP minor/build); whether the target exam cluster defaults to `restricted-v2` vs `restricted-v3`; the precise DNS egress policy form for the exam cluster's DNS service; MetalLB operator availability (depends on the exam/lab platform — cloud clusters use the platform LB, bare metal uses MetalLB).
- **Out of scope / delegated**: builds/S2I/ImageStreams/DeploymentConfigs (task-2), full exam objectives doc/study guide (task-1), kustomize/helm/operators (task-2/other), UI specifics.
- **Not tested against a live cluster**: no `oc` binary/cluster was used in this research. Everything is doc-derived (plus local `openssl` validation of the self-signed cert recipe). Lab validation before content freeze is recommended.

---

## 15. Sources (all accessed **2026-11-03**)

### 15.1 Primary Red Hat documentation (OCP 4.22; HTTP 200 verified)

| Key | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Ingress and load balancing (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R2  | Routes (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R3  | Configuring ingress cluster traffic (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/configuring-ingress-cluster-traffic>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R4  | Load balancing with MetalLB (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/load-balancing-with-metallb>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R5  | Network security (book, whole-book single page): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/network_security/index> — includes the Network policy chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy>, network policy APIs, admin network policy, egress firewall                                                                                                                                                                                                                                                                                                                                                  |
| R7  | Authentication and authorization (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> — includes Using RBAC <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac>, identity providers <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers>, service accounts <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts>, project creation templates (Building applications book) |
| R8  | Using RBAC to define and apply permissions (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R9  | Configuring identity providers (chapter; HTPasswd): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R10 | Understanding and creating service accounts (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R11 | Understanding and managing pod security admission (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-managing-pod-security-admission>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R12 | Nodes (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index> — includes scheduling chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/controlling-pod-placement-onto-nodes-scheduling> and LimitRange content                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R13 | Controlling pod placement onto nodes (scheduling) (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/controlling-pod-placement-onto-nodes-scheduling>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R14 | Storage (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/storage/index>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R15 | Understanding persistent storage (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/storage/understanding-persistent-storage>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R16 | Support (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/support/index> — includes Gathering data about your cluster <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/support/gathering-cluster-data>                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R17 | Troubleshooting (chapter): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/support/troubleshooting> — includes Investigating pod issues (pod error states) and Troubleshooting network issues sections                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R18 | CLI tools (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R19 | OpenShift CLI command references (administrator + developer "by example" content, published in the CLI tools book): developer commands <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index>; source text verified from `enterprise-4.22` `modules/oc-by-example-content.adoc` and `modules/oc-adm-by-example-content.adoc`                                                                                                                                                                                                                                                                                                                                                               |
| R20 | Managing security context constraints (SCC chapter, in Authentication and authorization book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/authentication_and_authorization/index>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R21 | Network APIs (API reference): Route `route.openshift.io/v1` — <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/network_apis/index#route-route-openshift-io-v1>; NetworkPolicy `networking.k8s.io/v1`; AdminNetworkPolicy `policy.networking.k8s.io/v1alpha1`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R22 | Operator APIs (API reference): IngressController `operator.openshift.io/v1` — <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/operator_apis/index#ingresscontroller-operator-openshift-io-v1>; Network `operator.openshift.io/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R23 | Schedule and quota APIs + quota docs (API reference + Building applications quota chapters): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/schedule_and_quota_apis/index#clusterresourcequota-quota-openshift-io-v1>; ResourceQuota `v1`, LimitRange `v1`, ClusterResourceQuota `quota.openshift.io/v1`                                                                                                                                                                                                                                                                                                                                                                                     |
| R24 | Security APIs (API reference): SecurityContextConstraints `security.openshift.io/v1`, ServiceAccount `v1` — <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/security_apis/index#securitycontextconstraints-security-openshift-io-v1>                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R25 | Config APIs (API reference): Network `config.openshift.io/v1` — <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html-single/config_apis/index#network-config-openshift-io-v1>; Project `config.openshift.io/v1`, OAuth `config.openshift.io/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R33 | OpenShift Container Platform 4.22 release notes (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/release_notes/index> — 4.22 notable/deprecated/removed changes (dedicated platform SAs, HAProxy 2.8.18, MetalLB ConfigurationState, platform NetworkPolicy defaults). Source text verified from `release_notes/ocp-4-22-release-notes.adoc` and `modules/rn-ocp-*-4-22*` on `enterprise-4.22`.                                                                                                                                                                                                                                                                                               |
| R34 | Networking Operators (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/networking_operators/index> — Cluster Network Operator, DNS Operator, Ingress Operator; OVN-Kubernetes network plugin material verified from `networking/ovn_kubernetes_network_provider/about-ovn-kubernetes.adoc` on `enterprise-4.22`                                                                                                                                                                                                                                                                                                                                                                                |
| R35 | Building applications (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> — project creation/self-provisioning/project templates, quotas (per-project and ClusterResourceQuota), Secrets/ConfigMaps usage. Source: `applications/**` on `enterprise-4.22`                                                                                                                                                                                                                                                                                                                                                                                                           |
| R26 | Kubernetes — Service: <https://kubernetes.io/docs/concepts/services-networking/service/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R27 | Kubernetes — EndpointSlices: <https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R28 | Kubernetes — Network Policies: <https://kubernetes.io/docs/concepts/services-networking/network-policies/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R29 | Kubernetes — StatefulSets: <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R30 | Kubernetes — Secrets: <https://kubernetes.io/docs/concepts/configuration/secret/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R31 | Kubernetes — ConfigMaps: <https://kubernetes.io/docs/concepts/configuration/configmap/>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R32 | OpenShift CLI source (release-4.22), route subcommand flags: `pkg/cli/create/routeedge.go`, `routepassthrough.go`, `routereenecrypt.go` — <https://github.com/openshift/oc/tree/release-4.22/pkg/cli/create>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Additional verification corpus (not individually cited above but used for exact-text checking): official docs AsciiDoc source branch <https://github.com/openshift/openshift-docs/tree/enterprise-4.22> (commit `a1ea307ec1ff90d82126e21f229a0c1142a9565d`): `networking/**`, `authentication/**`, `nodes/**`, `storage/**`, `support/**`, `applications/quotas/**`, `cli_reference/**`, `rest_api/**`, `release_notes/**`, `maps/ocp-jobs/**`.

### 15.2 Exam/version sources

- Red Hat exam objectives by version (EX280V422 section extracted): <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf> (accessed 2026-11-03)
- EX280 exam page (overview; objectives detail is in the PDF above): <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>
- Version availability checks: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22> (200), <https://docs.redhat.com/en/documentation/openshift_container_platform/4.23> (404), <https://docs.redhat.com/en/documentation/openshift_container_platform/5.0> (200)

---

## Appendix A — One-page command cheat sheet (this research area)

```bash
# --- expose HTTP ---
oc expose svc/hello
oc expose service nginx --hostname=www.example.com --path=/nginx
oc create route edge hello --service=hello --cert=tls.crt --key=tls.key --hostname=hello.apps.example.com
oc create route passthrough secure --service=backend --hostname=secure.example.com
oc create route reencrypt reenc --service=backend --cert=tls.crt --key=tls.key --dest-ca-cert=ca.crt --hostname=reenc.example.com
oc get routes
oc describe route hello
oc edit route hello

# --- TLS / ingress ---
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout tls.key -out tls.crt -subj "/CN=HOST" -addext "subjectAltName=DNS:HOST"
oc create secret tls tls-secret --cert=tls.crt --key=tls.key
oc patch -n openshift-ingress-operator ingresscontroller/default --type=merge -p '{"spec":{"defaultCertificate":{"name":"custom-certs-default"}}}'
oc get ingresses.config/cluster -o jsonpath={.spec.domain}
oc get ingresscontroller -n openshift-ingress-operator
oc get pods -n openshift-ingress

# --- non-HTTP ---
oc create service nodeport my-ns --tcp=5678:8080
oc create service loadbalancer my-lbs --tcp=5678:8080
oc get ipaddresspool -n metallb-system
oc get l2advertisement -n metallb-system

# --- network policy / SDN ---
oc get networkpolicy -A
oc describe networkpolicy deny-by-default
oc describe network.config/cluster
oc get network.operators.operator.openshift.io/cluster -o yaml
oc get co network
oc run test --rm -i -t --image=alpine -- sh
oc debug node/<node>          # then: chroot /host
oc adm must-gather -- /usr/bin/gather_network_logs

# --- security / SCC ---
oc get scc
oc describe scc restricted-v2
oc adm policy add-scc-to-user privileged -z myapp
oc adm policy add-scc-to-group anyuid group1
oc adm policy who-can use scc privileged
oc auth can-i use scc/privileged
oc get pod <p> -o jsonpath='{.metadata.annotations.openshift\.io/scc}{"\n"}'

# --- service accounts / RBAC / users ---
oc create sa robot && oc adm policy add-role-to-user view -z robot
oc create token robot --duration 10m
oc get sa && oc describe sa robot
oc adm policy add-role-to-user edit alice -n demo
oc adm policy add-cluster-role-to-user cluster-admin alice
oc auth can-i create pods --all-namespaces
oc auth can-i list pods --as=system:serviceaccount:dev:foo -n prod
oc adm groups new devs alice bob
oc adm groups add-users devs carol
htpasswd -c -B -b users.htpasswd alice 'P@ss'
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config
oc get oauth cluster -o yaml
oc get users && oc get groups && oc get identities
oc delete user bob && oc delete identity my_htpasswd_provider:bob

# --- quotas / limits / self-service ---
oc create quota q --hard=cpu=1,memory=1G,pods=2
oc create clusterquota per-user --project-annotation-selector=openshift.io/requester=alice --hard=pods=5
oc create -f limitrange.yaml
oc describe quota q && oc describe limitrange resource-limits
oc get appliedclusterresourcequota -n demo
oc adm create-bootstrap-project-template -o yaml
oc edit project.config.openshift.io/cluster
oc describe clusterrolebinding.rbac self-provisioners
oc adm policy remove-cluster-role-from-group self-provisioner system:authenticated:oauth

# --- workloads/security basics used here ---
oc create secret generic app-secret --from-literal=password=s3cr3t
oc set env --from=secret/app-secret deployment/myapp
oc create secret docker-registry regcred --docker-server=... --docker-username=... --docker-password=...
oc secrets link default regcred --for=pull
oc create job my-job --image=busybox -- date
oc create cronjob my-job --image=busybox --schedule="*/1 * * * *" -- date

# --- scheduling / health ---
oc label node <node> region=east
oc adm cordon <node> && oc adm drain <node> --ignore-daemonsets --delete-emptydir-data && oc adm uncordon <node>
oc adm taint nodes node1 key1=value1:NoSchedule
oc adm top pod && oc adm top node
oc get events -A --sort-by=.lastTimestamp
oc get co && oc get nodes && oc get clusterversion
oc status --suggest
oc adm inspect ns/myproject
```

---

_End of document. Sibling research files (not part of this one): `docs/research/ex280-objectives.md`, `docs/research/ex280-study-guide.md`, `docs/research/exam-facts.json`, `docs/research/openshift-workloads-builds.md`, `docs/architecture-map.md`._
