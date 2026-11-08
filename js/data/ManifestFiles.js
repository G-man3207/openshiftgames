/**
 * Default virtual files for the Files / Manifests panel (ManifestEngine).
 *
 * Every entry is seeded into the in-memory filesystem on `ManifestEngine`
 * construction / `resetFiles()`. Content targets OpenShift Container Platform
 * 4.22 and EX280V422 workflows:
 *
 *   manifests/          plain `oc apply -f` objects (Deployment/Service/Route)
 *   kustomize/          base + dev/prod overlays for `oc apply -k`
 *   templates/          `oc process -f ... | oc apply -f -`
 *   helm/webapp/        a local chart for `helm install webapp helm/webapp`
 *   htpasswd            HTPasswd identity-provider user database
 *   examples/           quotas, LimitRange, Subscriptions (incl. OLM variants), BuildConfig
 *   netpol/             the NetworkPolicy level's docs policies and its egress starter
 *
 * All files in this map parse with js/engine/YamlParser.js (helm templates are
 * valid YAML before Go-template rendering because their expressions are quoted).
 *
 * @type {Record<string, string>}
 */
export const MANIFEST_FILES = {
  // ─── Plain manifests: oc apply -f manifests/deployment.yaml ───────────────
  'manifests/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  labels:
    app: webapp
    app.kubernetes.io/part-of: webapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: webapp
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
  template:
    metadata:
      labels:
        app: webapp
    spec:
      containers:
        - name: webapp
          image: quay.io/openshift/origin-hello-openshift:latest
          imagePullPolicy: Always
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
`,

  'manifests/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  type: ClusterIP
  selector:
    app: webapp
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
`,

  'manifests/route.yaml': `apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: webapp
  labels:
    app: webapp
  annotations:
    haproxy.router.openshift.io/rewrite-target: /
spec:
  # Omit host to let the ingress controller generate
  # <route>-<project>.apps.<cluster-domain>.
  host: webapp.apps.cluster.example.com
  path: /
  to:
    kind: Service
    name: webapp
    weight: 100
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
    # OCP 4.22: reference a kubernetes.io/tls Secret instead of inlining PEM data.
    # The Secret must live in this Route's project and the ingress router must be
    # allowed to read it, or admission fails with reason
    # ExternalCertificateValidationFailed (Route Admitted=False). Real order:
    #   1. oc create secret tls webapp-tls --cert=tls.crt --key=tls.key -n prod-platform
    #   2. grant the router ServiceAccount read access in the SAME project:
    #      Role (verbs get,list,watch; resourceNames webapp-tls; resources secrets)
    #      + RoleBinding to system:serviceaccount:openshift-ingress:router
    #      (see the L20 capstone hint for the full manifest)
    #   3. oc apply -f manifests/route.yaml -n prod-platform, then confirm
    #      oc get route webapp -n prod-platform reports Admitted.
    externalCertificate:
      name: webapp-tls
  wildcardPolicy: None
`,

  // ── OCP 4.22 externalCertificate prerequisite RBAC (issue #39) ────────────
  // A Route that references `spec.tls.externalCertificate.name` is not admitted
  // until the ingress router can get/list/watch that named Secret in the
  // Route's project. Apply this in the Route's project (it carries no
  // metadata.namespace so `-n <project>` applies to both objects):
  //   oc apply -f examples/route-external-cert-rbac.yaml -n <project>
  'examples/route-external-cert-rbac.yaml': `# Router ServiceAccount read access for a Route's externalCertificate Secret.
# Apply it in the Route's own project, after creating the kubernetes.io/tls
# Secret that spec.tls.externalCertificate.name points at.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: read-webapp-tls
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["webapp-tls"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-webapp-tls
subjects:
  - kind: ServiceAccount
    name: router
    namespace: openshift-ingress
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: read-webapp-tls
`,

  // ─── Kustomize base + overlays: oc apply -k kustomize/overlays/prod ───────
  'kustomize/base/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Base objects shared by every environment.
resources:
  - deployment.yaml
  - service.yaml

# kustomize v5 labels transformer (replaces the deprecated commonLabels field).
# includeSelectors defaults to false, so these pairs only land in metadata.labels
# and the base selectors stay exactly as declared in the resource files.
labels:
  - pairs:
      app.kubernetes.io/part-of: webapp
      app.kubernetes.io/managed-by: kustomize
`,

  'kustomize/base/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: webapp
  template:
    metadata:
      labels:
        app: webapp
    spec:
      containers:
        - name: webapp
          image: quay.io/openshift/origin-hello-openshift:latest
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
`,

  'kustomize/base/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  type: ClusterIP
  selector:
    app: webapp
  ports:
    - name: http
      port: 8080
      targetPort: 8080
`,

  'kustomize/overlays/dev/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Developer environment: one replica, its own project, extra labels.
resources:
  - ../../base

namespace: webapp-dev
namePrefix: dev-

# kustomize v5 labels transformer (replaces commonLabels). includeSelectors:
# true also adds the pairs to workload selectors and pod-template labels.
labels:
  - pairs:
      environment: dev
    includeSelectors: true

images:
  - name: quay.io/openshift/origin-hello-openshift
    newTag: latest

replicas:
  - name: webapp
    count: 1
`,

  'kustomize/overlays/prod/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

# Production environment: pinned image, three replicas, strategic-merge patch.
resources:
  - ../../base

namespace: webapp-prod
namePrefix: prod-

# kustomize v5 labels transformer (replaces commonLabels); includeSelectors:
# true keeps the old commonLabels behaviour of also labelling selectors.
labels:
  - pairs:
      environment: prod
    includeSelectors: true

images:
  - name: quay.io/openshift/origin-hello-openshift
    newTag: "1.0.0"

replicas:
  - name: webapp
    count: 3

# kustomize v5 patches transformer (replaces patchesStrategicMerge). Each entry
# targets objects by kind+name and points at a strategic-merge patch file.
patches:
  - target:
      kind: Deployment
      name: webapp
    path: patch-deployment.yaml
`,

  // A REAL strategic-merge patch: containers are merged by `name`, so the base
  // container's ports survive; re-specify only the fields the overlay changes.
  // (Over-specifying lists in patches is not how kustomize works.)
  'kustomize/overlays/prod/patch-deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: webapp
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: webapp
          image: quay.io/openshift/origin-hello-openshift:latest
          env:
            - name: APP_ENV
              value: production
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
`,

  // ─── OpenShift template: oc process -f ... -p APP_NAME=web | oc apply -f - ─
  'templates/webapp-template.yaml': `apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: webapp-template
  annotations:
    description: Parameterised web application (Deployment, Service and Route)
    tags: webapp,nodejs
parameters:
  - name: APP_NAME
    displayName: Application name
    description: Name used for the Deployment, Service and Route
    required: true
  - name: IMAGE
    displayName: Container image
    description: Image to deploy (defaults to the OpenShift hello-openshift image)
    value: quay.io/openshift/origin-hello-openshift:latest
    required: true
  - name: REPLICAS
    displayName: Replica count
    description: Number of Pods to run
    value: "2"
    required: true
objects:
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: \${APP_NAME}
      labels:
        app: \${APP_NAME}
    spec:
      replicas: "\${{REPLICAS}}"
      selector:
        matchLabels:
          app: \${APP_NAME}
      template:
        metadata:
          labels:
            app: \${APP_NAME}
        spec:
          containers:
            - name: webapp
              image: \${IMAGE}
              ports:
                - name: http
                  containerPort: 8080
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 512Mi
  - apiVersion: v1
    kind: Service
    metadata:
      name: \${APP_NAME}
      labels:
        app: \${APP_NAME}
    spec:
      type: ClusterIP
      selector:
        app: \${APP_NAME}
      ports:
        - name: http
          port: 8080
          targetPort: 8080
  - apiVersion: route.openshift.io/v1
    kind: Route
    metadata:
      name: \${APP_NAME}
      labels:
        app: \${APP_NAME}
    spec:
      to:
        kind: Service
        name: \${APP_NAME}
      port:
        targetPort: http
      tls:
        termination: edge
        insecureEdgeTerminationPolicy: Redirect
      wildcardPolicy: None
message: "Application \${APP_NAME} has been created from template webapp-template."
`,

  // ─── Helm chart: helm install webapp helm/webapp ──────────────────────────
  'helm/webapp/Chart.yaml': `apiVersion: v2
name: webapp
description: A Helm chart for the OpenShift Games web application
type: application
version: 0.1.0
appVersion: "1.0.0"
keywords:
  - openshift
  - webapp
`,

  'helm/webapp/values.yaml': `# Default values for the webapp chart.
replicaCount: 2

image:
  repository: quay.io/openshift/origin-hello-openshift
  tag: latest
  pullPolicy: Always

service:
  type: ClusterIP
  port: 8080

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
`,

  'helm/webapp/templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: "{{ .Release.Name }}"
  labels:
    app: "{{ .Release.Name }}"
    app.kubernetes.io/managed-by: Helm
    helm.sh/chart: "{{ .Chart.Name }}-{{ .Chart.Version }}"
  annotations:
    meta.helm.sh/release-name: "{{ .Release.Name }}"
    meta.helm.sh/release-namespace: "{{ .Release.Namespace }}"
spec:
  replicas: "{{ .Values.replicaCount }}"
  selector:
    matchLabels:
      app: "{{ .Release.Name }}"
  template:
    metadata:
      labels:
        app: "{{ .Release.Name }}"
    spec:
      containers:
        - name: webapp
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: "{{ .Values.image.pullPolicy }}"
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: "{{ .Values.resources.requests.cpu }}"
              memory: "{{ .Values.resources.requests.memory }}"
            limits:
              cpu: "{{ .Values.resources.limits.cpu }}"
              memory: "{{ .Values.resources.limits.memory }}"
`,

  'helm/webapp/templates/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: "{{ .Release.Name }}"
  labels:
    app: "{{ .Release.Name }}"
    app.kubernetes.io/managed-by: Helm
spec:
  type: "{{ .Values.service.type }}"
  selector:
    app: "{{ .Release.Name }}"
  ports:
    - name: http
      port: "{{ .Values.service.port }}"
      targetPort: 8080
`,

  // ─── HTPasswd identity provider database (empty until htpasswd -b ...) ────
  htpasswd: '',

  // ─── Examples referenced by levels, labs and the docs ─────────────────────
  'examples/quota.yaml': `apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
spec:
  hard:
    pods: "20"
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    services: "10"
    secrets: "20"
    configmaps: "20"
    persistentvolumeclaims: "4"
`,

  'examples/limitrange.yaml': `apiVersion: v1
kind: LimitRange
metadata:
  name: resource-limits
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      min:
        cpu: 50m
        memory: 64Mi
      max:
        cpu: "2"
        memory: 4Gi
`,

  'examples/default-deny.yaml': `# Default-deny ingress and egress for every Pod in the project.
# NetworkPolicies are additive: add explicit allow rules for required traffic
# (for example DNS egress on UDP/TCP 5353 to the openshift-dns namespace — the
# dns-default Pods listen on 5353, not on port 53).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
`,

  // Paired with examples/default-deny.yaml: keep the project isolated but let
  // the ingress router through. The router Pods run in a namespace labelled
  // policy-group.network.openshift.io/ingress="", so this single ingress policy
  // re-opens only the router → Pod path (Routes keep working after default-deny).
  'examples/allow-from-router.yaml': `apiVersion: networking.k8s.io/v1
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
              policy-group.network.openshift.io/ingress: ""
`,

  // ─── NetworkPolicy lab (campaign "Network Policies", id 21) ───────────────
  // The OpenShift 4.22 docs policies (deny-by-default, allow-same-namespace,
  // allow-from-openshift-ingress) plus an egress lockdown that keeps DNS
  // working. allow-frontend-to-backend.yaml is a starter the player completes.
  'netpol/deny-by-default.yaml': `# Deny all ingress by default (the "deny-by-default" policy from the
# OpenShift docs). An empty podSelector selects every Pod of the project;
# with no ingress rules nothing may connect to them until another policy
# allows it. Egress is not affected.
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: deny-by-default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress: []
`,

  'netpol/allow-from-openshift-ingress.yaml': `# Let the OpenShift router reach the Pods behind your Routes. The router Pods
# run in the openshift-ingress namespace, which the ingress operator labels
# policy-group.network.openshift.io/ingress: "" — the documented 4.x selector.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-openshift-ingress
spec:
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              policy-group.network.openshift.io/ingress: ""
  podSelector: {}
  policyTypes:
    - Ingress
`,

  'netpol/allow-same-namespace.yaml': `# Accept connections from any Pod of the same project ("allow-same-namespace"
# in the OpenShift docs). A podSelector inside "from" without a
# namespaceSelector only matches Pods of this namespace, so other projects
# stay locked out.
kind: NetworkPolicy
apiVersion: networking.k8s.io/v1
metadata:
  name: allow-same-namespace
spec:
  podSelector: {}
  ingress:
    - from:
        - podSelector: {}
`,

  'netpol/deny-all-egress.yaml': `# Deny all egress by default: Pods of the project may not open any
# connection — not even a DNS lookup — until an egress rule allows it.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
`,

  'netpol/allow-dns.yaml': `# Allow DNS lookups while egress is denied. The dns-default Pods in
# openshift-dns listen on port 5353 (the dns-default Service maps 53 to 5353)
# and a NetworkPolicy matches the Pod port, so allow 5353 over UDP and TCP:
# port 53 alone does not unblock name resolution.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: openshift-dns
      ports:
        - protocol: UDP
          port: 5353
        - protocol: TCP
          port: 5353
`,

  'netpol/allow-frontend-to-backend.yaml': `# Starter: the egress half of the frontend -> backend call. Once egress is
# denied by default, the Pods that SEND need their own allow rule (the
# receiving side is covered by an ingress policy). Replace the placeholders,
# then apply the file:
#   SOURCE-APP  app label of the Pods that send    (frontend)
#   TARGET-APP  app label of the Pods they may call (backend)
# The port is the Pod (container) port the backend listens on.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-backend
spec:
  podSelector:
    matchLabels:
      app: SOURCE-APP
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: TARGET-APP
      ports:
        - protocol: TCP
          port: 8080
`,

  'examples/privileged-deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: privileged-app
  labels:
    app: privileged-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: privileged-app
  template:
    metadata:
      labels:
        app: privileged-app
    spec:
      # The SCC granted to this service account decides whether the pod is admitted.
      serviceAccountName: robot
      containers:
        - name: app
          image: quay.io/openshift/origin-hello-openshift:latest
          securityContext:
            privileged: true
`,

  'examples/subscription.yaml': `apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ansible-automation-platform-operator
  namespace: openshift-operators
spec:
  # Real Red Hat catalog channel for the AAP 2.6 package.
  channel: stable-2.6
  installPlanApproval: Automatic
  name: ansible-automation-platform-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
`,

  // L18 operator variants: AllNamespaces install (global OperatorGroup in
  // openshift-operators) with Manual approval and a pinned startingCSV.
  // The catalog PACKAGE is `openshift-cert-manager-operator` (channel
  // `stable-v1`), while its CSVs keep the historical
  // `cert-manager-operator.v<version>` names. v1.16.0 is a real, older channel
  // entry (the head is v1.17.0), so this demonstrates a genuine pin; discover
  // valid entries with
  //   oc get packagemanifest openshift-cert-manager-operator \
  //     -n openshift-marketplace -o jsonpath='{.status.channels[0].entries[*].name}'
  // Apply it, then approve the InstallPlan by hand:
  //   oc patch installplan <name> -n openshift-operators --type=merge \
  //     -p '{"spec":{"approved":true}}'
  'examples/subscription-manual-pinned.yaml': `apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-cert-manager-operator
  namespace: openshift-operators
spec:
  channel: stable-v1
  installPlanApproval: Manual
  name: openshift-cert-manager-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
  # Pin a specific channel entry instead of installing the channel head.
  startingCSV: cert-manager-operator.v1.16.0
`,

  // Lab 10 AllNamespaces variant: the global-operators OperatorGroup already
  // exists in openshift-operators, so no new OperatorGroup is needed.
  'examples/subscription-pipelines.yaml': `apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-pipelines-operator-rh
  namespace: openshift-operators
spec:
  channel: latest
  installPlanApproval: Automatic
  name: openshift-pipelines-operator-rh
  source: redhat-operators
  sourceNamespace: openshift-marketplace
`,

  // OLM / MetalLB lab (L12/L18 hints): OperatorGroup scoping the namespace,
  // then the MetalLB operand CR + address pool + L2 advertisement.
  'examples/operatorgroup.yaml': `apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: metallb-operatorgroup
  namespace: metallb-system
spec:
  targetNamespaces:
    - metallb-system
`,

  'examples/metallb.yaml': `# MetalLB configuration (needs the MetalLB operator installed in metallb-system).
# 1. MetalLB: the operator's own resource; creating it starts the controller and
#    the speaker Pods.
apiVersion: metallb.io/v1beta1
kind: MetalLB
metadata:
  name: metallb
  namespace: metallb-system
spec: {}
---
# 2. IPAddressPool: the addresses MetalLB may give to LoadBalancer Services.
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: metallb-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.100.200-192.168.100.210
  autoAssign: true
---
# 3. L2Advertisement: answer ARP for the pool's addresses on the local network.
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: metallb-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - metallb-pool
`,

  'examples/buildconfig.yaml': `apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: webapp
  labels:
    app: webapp
spec:
  source:
    type: Git
    git:
      uri: https://github.com/openshift/nodejs-ex
      ref: main
    contextDir: /
  strategy:
    type: Source
    sourceStrategy:
      from:
        kind: ImageStreamTag
        name: nodejs:20-ubi9
        namespace: openshift
  output:
    to:
      kind: ImageStreamTag
      name: webapp:latest
  triggers:
    - type: ConfigChange
    - type: ImageChange
      imageChange: {}
  runPolicy: Serial
`,
};

export default MANIFEST_FILES;
