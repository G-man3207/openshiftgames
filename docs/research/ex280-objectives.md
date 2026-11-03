# EX280V422 — Official Exam Objectives and What Each One Requires

**Verified 2026-11-03.** Exam code **EX280V422**, based on **Red Hat OpenShift Container Platform 4.22**, **3.0 hours**, hands-on performance-based.

Primary sources (fetched 2026-11-03):

- Official exam page: <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>
- Red Hat "Exam Objectives by Version" PDF (section `EX280V422`): <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf>
- OCP 4.22 documentation: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22>

Method note: the redhat.com exam page and docs.redhat.com render their bodies with JavaScript. The exam page was fetched as raw HTML and converted to text; docs.redhat.com guide bodies were verified by reading the same 4.22 AsciiDoc sources in the `openshift-docs` repository, branch `enterprise-4.22` (<https://github.com/openshift/openshift-docs/tree/enterprise-4.22>), which is what publishes to docs.redhat.com 4.22. Every command shown in the companion study guide was checked there. All docs chapter URLs marked ✅ were fetched and returned HTTP 200 on 2026-11-03.

---

## 1. Exam facts

| Fact | Value |
|---|---|
| Exam code (current version) | **EX280V422** |
| Family code | EX280 / EX280K |
| Exam name (LMS objectives PDF) | **Red Hat Certified Specialist in OpenShift Administration** |
| Exam name (redhat.com page title) | Red Hat Certified System Administrator in OpenShift exam (EX280) |
| Product/version tested | **Red Hat OpenShift Container Platform 4.22** |
| Delivery | Hands-on, performance-based practical exam on a live 4.22 system |
| Time limit | **3.0 hours** |
| Documentation during exam | Relevant product documentation is provided; no outside assistance |
| Results | Emailed by Red Hat Certification Central, usually within 3 U.S. business days; **total score only**, no per-item feedback |
| Version policy | Multiple versions in use; review your designated version in the LMS |
| Performance rule | Configurations and services must persist and stay functional across the normal platform lifecycle without manual intervention; LMS PDF: "configurations must persist after reboot without intervention" |
| Recommended prep | RH124 or equivalent; RHCSA strongly recommended (not required); DO180; DO280; container experience recommended |

**Naming conflict (flagged):** the live exam page still brands the credential "Red Hat Certified System Administrator in OpenShift" and says passing "counts towards earning a Red Hat Certified Architect in OpenShift", while the LMS objectives PDF lists `EX280K - Red Hat Certified Specialist in OpenShift Administration`, matching what the Lead reported as the rename. Both sources contain the identical `EX280V422` objective list. The game should use one name consistently; this guide uses "Red Hat Certified Specialist in OpenShift Administration (EX280V422)" per the Lead's direction and flags the discrepancy instead of silently harmonizing it.

**Scoring and validity — NOT VERIFIED.** The exam page states only that results are reported as total scores. It does **not** publish a passing score, score scale, or certification validity period. Those are governed by the Red Hat Certification Program Guide linked from the exam page (<https://docs.redhat.com/en/documentation/red_hat_learning_subscription/1-latest/html/red_hat_certification_program_guide/index>), but that page could not be extracted (JS-rendered; PDF endpoint returned HTTP 403; no Wayback snapshot). **Do not put a passing score or a "valid for N years" claim in game copy** without re-verifying the program guide.

**Recommended preparation (verbatim from exam page):**

- Have taken Red Hat System Administration I (RH124) or have comparable experience. Red Hat Certified System Administrator (RHCSA) is strongly recommended but not required.
- Have taken Red Hat OpenShift Administration I: Containers & Kubernetes (DO180) or comparable work experience.
- Have taken Red Hat OpenShift Administration II: Operating a Production Kubernetes Cluster (DO280) or comparable work experience.
- Review the exam objectives.
- Experience with container technology is recommended.

The DO280 title printed on the exam page is *Operating a Production Kubernetes Cluster*. The redhat.com DO280 course page returned **HTTP 404** on 2026-11-03, so a current official course outline could not be verified. A partner-hosted DO280LS outline (based on OCP 4.14) confirms the same chapter structure as the V422 groups but still includes an "OpenShift Updates" chapter that the V422 exam dropped — treat it as secondary and possibly stale.

**Retired/superseded versions (from LMS PDF):** `EX280V410K`, `EX280V45K`, `EX280V46K` are retired; `EX280V412K`, `EX280V414K` are older versions still listed. **`EX280V422` is current.** The old V412K/V414K objectives differ materially (see §5) — do not build curriculum from them.

---

## 2. The official objectives (9 groups, 55 bullets) and what each requires

Wording is verbatim from the exam page / EX280V422 PDF section. "Must know" notes name the actual CLI/resources to practise. Filled-in commands and flag details are in `ex280-study-guide.md`; each was verified against OCP 4.22 docs.

### 2.1 Manage OpenShift Container Platform (14 bullets)

Docs: CLI tools guide <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index> ✅ · Web console guide <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index> ✅ · Nodes guide <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index> ✅ · Monitoring guide <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/monitoring/index> ✅

- **Use the web console to manage and configure an OpenShift cluster** — Administrator vs Developer perspectives; create projects; deploy from container image/Git; work with Topology; inspect workloads; OperatorHub; User Management; Administration → Cluster Settings; Home → Overview for cluster health.
- **Use the command-line interface to manage and configure an OpenShift cluster** — `oc login`, `oc whoami`, `oc status`, `oc project`, `oc config`, kubeconfig/context handling; tabs/`oc` versus `kubectl` compatibility.
- **Create and delete projects** — `oc new-project`, `oc project`, `oc projects`, `oc delete project`, self-provisioner behaviour; `Project` is a real cluster-scoped API object (`project.openshift.io/v1`), `ProjectRequest` is the create path.
- **Locate and examine container images** — image pull specs (registry/namespace/name:tag, `@sha256:` digest), `oc get imagestreams -n openshift`, `oc describe is/<name>`, `oc describe istag/<is>:<tag>`, `oc get istag`, internal registry pull spec `image-registry.openshift-image-registry.svc:5000/<ns>/<name>:<tag>`.
- **Identify images using tags and digests** — mutable tags vs permanent digest references; `oc tag`, `oc import-image`, `oc describe is` shows `@sha256`; `oc get istag ... -o jsonpath` for image ID/digest; tag conventions (`latest`, `v2`, `stable`).
- **Query, format, and filter attributes of Kubernetes resources** — `-o wide|yaml|json|jsonpath|go-template|custom-columns`, `-l/--selector`, `--field-selector`, `--sort-by`, `-n/-A`, `oc get all`, `oc explain`, `oc api-resources`.
- **Import, export, and configure Kubernetes resources** — `oc create -f`, `oc apply -f`, `oc replace -f`, `oc edit`, `oc patch`, `oc delete -f`, stdin (`oc create -f -`), `oc get <kind> -o yaml > file.yaml` as export. **`oc export` is removed in 4.x** — do not teach it.
- **Examine resources and cluster status** — `oc get nodes`, `oc get pods -A`, `oc describe <kind>/<name>`, `oc get clusteroperators`/`oc get co`, `oc get clusterversion`, `oc get events`, `oc status`.
- **Monitor cluster events and alerts** — `oc get events [-n ns]`, `--sort-by=.lastTimestamp`; web console Home → Events / Alerting; monitoring guide; Alertmanager route in `openshift-monitoring`.
- **View logs** — `oc logs <pod> [-c container] [-f] [--previous]`; `oc logs deployment/<name>`; build logs `oc logs -f bc/<name>`; deployment logs `oc logs deployment/...`; `oc logs bc/<name> --version=<n>`.
- **Assess the health of an OpenShift cluster** — node readiness, ClusterOperators Available/Degraded/Progressing, ClusterVersion, `oc adm top nodes`, `oc adm top pods`, pod restart counts, etcd/control-plane operator health, `oc adm must-gather` for evidence.
- **Troubleshoot common container, pod, and cluster events and alerts** — read Events/describe output for ImagePullBackOff, CrashLoopBackOff, Pending, SCC/PSA forbidden, quota exceeded, route not admitted; `oc debug pod|node|deployment`, `oc rsh`, `oc adm inspect namespace/<ns>`.
- **Use product documentation** — the exam provides docs.redhat.com content; know how to navigate the OCP 4.22 guides quickly (CLI reference, Authentication, Network security, Ingress and load balancing, Building applications, Images, Nodes, Operators, Monitoring).
- **Be prepared to perform all tasks of a Red Hat Certified Technologist in OpenShift** — cross-objective: everything above must be fluent without step-by-step hints.

### 2.2 Declarative Resource Management (7 bullets)

Docs: Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> ✅ · CLI tools <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index> ✅

- **Work with resource manifests** — apiVersion/kind/metadata/spec, labels/annotations, multi-document YAML, `oc apply -f`, `oc diff`, `oc explain`; know current apiVersions (`apps/v1` Deployment, `v1` Service/ConfigMap/Secret, `route.openshift.io/v1` Route, `build.openshift.io/v1` BuildConfig, `image.openshift.io/v1` ImageStream, `template.openshift.io/v1` Template).
- **Deploy applications from YAML resource manifests** — apply Deployment + Service + optional Route; verify rollout; update by editing/re-applying manifests.
- **Update application deployments** — change image/replicas/env in manifest, re-apply; `oc set image`, `oc set env`, `oc scale`, `oc apply`; watch `oc rollout status`.
- **Deploy applications using Kustomize** — directory with `kustomization.yaml` (`resources`, `namespace`, `images`, `replicas`); `oc apply -k <dir>`; `oc kustomize <dir>` to build/inspect output.
- **Work with Kustomize overlays** — base + overlay dirs, `patchesStrategicMerge`/`patches`, overlay-specific namespace/replicas/image tags; `oc apply -k overlays/prod`.
- **Create and use secrets** — `oc create secret generic|tls|docker-registry`, `--from-literal/--from-file`, `--dry-run=client -o yaml`, secret types (Opaque, kubernetes.io/tls, kubernetes.io/dockerconfigjson); consume via env/envFrom/volume; `oc set env --from=secret/...`.
- **Create and use configuration maps** — `oc create configmap --from-literal/--from-file/--from-env-file`, immutable ConfigMaps, consume via env vars, envFrom, volume mounts; keep sensitive data out of ConfigMaps.

### 2.3 Deploy applications (6 bullets)

Docs: Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> ✅ · Images <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/index> ✅ · Ingress and load balancing <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index> ✅

- **Deploy applications from templates and Helm charts** — `oc process -f template.yaml [-p KEY=VALUE] | oc create -f -`; `oc process --parameters`; `oc new-app --template=<name> --param=K=V`; `oc get templates -n openshift`; upload template with `oc create -f template.yaml -n <ns>`; Helm: `helm repo add openshift-helm-charts https://charts.openshift.io/`, `helm repo update`, `helm install <release> <repo>/<chart>`, `helm list`, web-console Helm releases; `HelmChartRepository` CR (`helm.openshift.io/v1beta1`) for custom repos.
- **Manage application deployments** — Deployments (`apps/v1`) and ReplicaSets; `oc new-app`, `oc create/apply/delete`; `oc rollout status|history|undo|restart|pause|resume`; `oc scale`; image update and triggers (`oc set triggers deploy/<name> --from-image=...` using the `image.openshift.io/triggers` annotation). DeploymentConfig exists but is deprecated (see §4).
- **Work with replica sets** — `oc get rs`, `oc describe rs`; Deployments own ReplicaSets; a new RS per pod-template revision enables rollback; manual ReplicaSet only when custom orchestration is required.
- **Work with labels and selectors** — `oc label`, `oc annotate`, selectors (`-l app=web,tier in (frontend)`), Deployment `spec.selector.matchLabels` must match pod template labels, Service selectors, NetworkPolicy selectors; `--show-labels`.
- **Configure services** — `v1 Service` types ClusterIP/NodePort/LoadBalancer/ExternalName/headless (`clusterIP: None`); `oc expose deployment/...` or `oc create service ...`; targetPort/port, Endpoints/EndpointSlices; selector must match pods.
- **Expose applications to external access** — `oc expose svc/<name>` (HTTP route), `oc create route edge|passthrough|reencrypt`, hostname/path/wildcard policy; verify `oc get route` and admission status; default domain via `oc get ingresses.config/cluster -o jsonpath={.spec.domain}`.

### 2.4 Manage authentication and authorization (5 bullets)

Docs: Authentication and authorization <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> ✅ · RBAC chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac> ✅

- **Configure the HTPasswd identity provider for authentication** — `htpasswd -c -B -b <file> <user> <password>` (bcrypt `-B`); `oc create secret generic htpass-secret --from-file=htpasswd=<file> -n openshift-config`; apply `OAuth` CR (`config.openshift.io/v1`, name `cluster`, `type: HTPasswd`, `fileData.name: htpass-secret`); `oc apply -f oauth.yaml`; then `oc login -u <user>`.
- **Create and delete users** — with HTPasswd, creation means adding a line to the htpasswd secret (then users appear as `User`/`Identity` objects after first login); power users can `oc create user <name>` and `oc create useridentitymapping`; delete with `oc delete user <name>` and `oc delete identity <provider>:<user>`.
- **Modify user passwords** — add/remove user with `htpasswd -bB` / `htpasswd -D` in the local file, then replace the secret (`oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd --dry-run=client -o yaml -n openshift-config | oc replace -f -`); handle User/Identity cleanup when removing.
- **Create and manage groups** — `oc adm groups new <group> [users...]`, `oc adm groups add-users/remove-users`, `oc get groups`, `oc describe group`.
- **Modify user and group permissions** — `oc adm policy add-role-to-user <role> <user> -n <ns>`, `add-cluster-role-to-user`, `add-role-to-group`, `add-cluster-role-to-group`, remove-* counterparts; `oc auth can-i`, `oc adm policy who-can`; Role/ClusterRole/RoleBinding/ClusterRoleBinding YAML (`rbac.authorization.k8s.io/v1`); built-in roles `view`/`edit`/`admin`/`cluster-admin`, `system:serviceaccount:<ns>:<sa>` subjects.

### 2.5 Configure network security (6 bullets)

Docs: Network security <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index> ✅ · Network policy chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy> ✅ · Routes chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes> ✅

- **Configure networking components** — cluster network type/status (`oc get network.config/cluster`, `oc get network/cluster -o jsonpath='{.status.clusterNetwork[*]}'`), ingress controller/router (`oc get ingresscontroller -n openshift-ingress-operator`, `oc get deployment -n openshift-ingress`), default ingress domain, DNS operator concepts, service types.
- **Troubleshoot software defined networking** — OVN-Kubernetes vs OpenShift SDN; verify service endpoints (`oc get endpoints`/`endpointslices`), test connectivity with `oc run ... --rm -i -t --image=... -- sh`, `curl`, `nslookup`/`dig`; `oc debug node/<node>`; inspect router/network operator pods; events.
- **Create and edit external routes** — unsecured route (`oc expose svc`), edge/passthrough/reencrypt TLS routes, host/path, wildcard policy; edit with `oc edit route`; route admission policy is on the IngressController (`spec.routeAdmission.namespaceOwnership`).
- **Control cluster network ingress** — NetworkPolicy (`networking.k8s.io/v1`) default-deny ingress/egress, pod/namespace selectors, port rules; isolate a project then allow specific traffic; remember DNS egress and ingress-controller traffic; default project NetworkPolicies can come from the `project-request` template.
- **Secure external and internal traffic using TLS certificates** — create TLS secrets (`oc create secret tls`, `oc create secret generic --from-file=tls.crt/tls.key`), route `certificate`/`key`/`caCertificate` for edge and `destinationCACertificate` for reencrypt, service-to-service TLS, CA trust bundles.
- **Configure application network policies** — allow same-namespace, allow from a labelled namespace (`namespaceSelector.matchLabels`, e.g. `kubernetes.io/metadata.name: ns`), allow from ingress controller, allow external clients; verify with `oc get networkpolicy` and connectivity tests.

### 2.6 Expose non-HTTP/SNI Applications (2 bullets)

Docs: Ingress and load balancing <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index> ✅

- **Configure a load balancer service** — Service `spec.type: LoadBalancer`, ports, selector, `EXTERNAL-IP`; `oc get svc`; on bare-metal/on-prem, MetalLB must be installed as an Operator (`Subscription`) with `IPAddressPool` + `L2Advertisement` (this is how non-HTTP apps get an external IP on non-cloud clusters); cloud clusters get LB IPs from the provider. Restrict source ranges via endpoint publishing strategy rather than `loadBalancerSourceRanges` where docs say so.
- **Configure external application access** — for protocols that Routes cannot carry (TCP/UDP/TLS passthrough/non-HTTP): NodePort (`oc create service nodeport`, port 30000–32767), LoadBalancer Service, or ExternalIP; TLS passthrough route when the protocol is TLS-based; verify reachability from outside the cluster (curl/openssl/nc); understand IngressController only handles HTTP/HTTPS/SNI.

### 2.7 Enable developer self-service (5 bullets)

Docs: Using quotas and limit ranges <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas> ✅ · Building applications <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> ✅

- **Configure cluster resource quotas** — `ClusterResourceQuota` (`quota.openshift.io/v1`), `oc create clusterquota <name> --project-label-selector=key=value --hard=pods=10 --hard=secrets=20` (also `--project-annotation-selector`, alias `clusterresourcequota`), aggregate status across selected projects, `oc describe AppliedClusterResourceQuota` from a project.
- **Configure project quotas** — `ResourceQuota` (`v1`) per project: compute (`requests.cpu`, `limits.memory`, `pods`), storage, object counts (`count/deployments.apps`, `count/pods`, `services.loadbalancers`, `openshift.io/imagestreams`), scopes (`BestEffort`, `NotTerminating`, etc.); `oc create quota`, `oc describe quota`, `oc get quota`.
- **Configure project resource requirements** — container `resources.requests`/`limits`; QoS classes Guaranteed/Burstable/BestEffort; when a compute quota exists pods must declare requests/limits or a LimitRange default must fill them; `oc set resources`.
- **Configure project limit ranges** — `LimitRange` (`v1`) per project for Pod/Container/PVC/Image/ImageStream min/max/default/defaultRequest/maxLimitRequestRatio; `oc create -f`; `oc describe limitrange`; explains admission errors when pods violate it.
- **Configure project templates** — default project template `project-request` in `openshift-config` (`oc edit template project-request -n openshift-config`), add objects (e.g. NetworkPolicies) to its `objects` list; templates in a project/`openshift` namespace enable `oc new-app --template`; template parameters.

### 2.8 Manage OpenShift operators (3 bullets)

Docs: Operators <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index> ✅

- **Install an operator** — via web console OperatorHub (subscription + approval), or CLI: create `OperatorGroup` (`operators.coreos.com/v1`) in the target namespace for `SingleNamespace` (or use the default `global-operators` group in `openshift-operators` for `AllNamespaces`), then `Subscription` (`operators.coreos.com/v1alpha1`) with `channel`, `name`, `source`, `sourceNamespace`; inspect `PackageManifest` in `openshift-marketplace`; approve `InstallPlan` when `installPlanApproval: Manual`; verify `CSV` status `Succeeded`.
- **Uninstall an operator** — web console: Operator details → Uninstall (creates the correct cleanup/deletion flow); CLI: delete `Subscription` (`oc delete subscription.operators.coreos.com <name> -n <ns>`), and delete the `OperatorGroup` if it was created just for this operator.
- **Delete an operator** — delete the `ClusterServiceVersion` (`oc delete clusterserviceversion <csv_name> -n <ns>`) associated with the removed subscription, and clean up CRs/operands as appropriate; verify with `oc get csv,sub,installplan -n <ns>`.

### 2.9 Configure application security (7 bullets)

Docs: Authentication and authorization (incl. SCC + service accounts) <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> ✅ · Service accounts chapter <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts> ✅ · Nodes (jobs) <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index> ✅

- **Configure and manage service accounts** — `oc create sa <name>`, `oc get sa`, `oc describe sa`; default project SAs `builder`/`deployer`/`default`; each SA gets an image-pull secret, and since OCP 4.16 **no long-lived API token secret** is auto-created; assign SA to a workload (`oc set serviceaccount deployment/<name> <sa>` / `spec.serviceAccountName`).
- **Run privileged applications** — Pod/Deployment `securityContext` (`privileged: true`, `runAsUser`, `capabilities.add`, `hostNetwork`, `hostPID`, `hostPorts`, `allowPrivilegeEscalation`); must be admitted by an SCC that allows it; grant with `oc adm policy add-scc-to-user privileged -z <sa>` (or create a custom SCC); note that `privileged: true` alone does not select the privileged SCC.
- **Manage and apply permissions using security context constraints** — `oc get scc`, `oc describe scc <name>`, `oc adm policy add-scc-to-user/-to-group/-to-serviceaccount`, `oc adm policy who-can use scc <name>`, `oc auth can-i use scc/<name>`; default SCCs include `restricted-v2` (granted to all authenticated users), `nonroot-v2`, `anyuid`, `privileged`, `hostnetwork-v2`, `hostaccess`, `hostmount-anyuid`, `node-exporter`; default-SCC edits are overwritten on upgrade. Fix "Forbidden: unable to validate against any security context constraint" by granting a suitable SCC to the service account, not by editing default SCCs.
- **Create and apply secrets to manage sensitive information** — secret types and creation (Opaque generic, TLS, dockerconfigjson), env/envFrom/volume consumption, `oc set env --from=secret/...`, image pull secrets (`imagePullSecrets`, `oc set build-secret`/`oc secrets link` where applicable), avoid secrets in ConfigMaps, base64 is not encryption.
- **Configure application access to Kubernetes APIs** — create a dedicated SA, bind a least-privilege Role/ClusterRole (`oc adm policy add-role-to-user view -z <sa>`, or RoleBinding), provide credentials via bound service-account tokens (`oc create token <sa>`, or projected `serviceAccountToken` volume with audience/expirationSeconds), verify with `oc auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa>`; in-cluster clients use the mounted token + `KUBERNETES_SERVICE_HOST`.
- **Deploy jobs to perform one-time tasks** — `batch/v1 Job`: `completions`, `parallelism`, `backoffLimit`, `activeDeadlineSeconds`, `ttlSecondsAfterFinished`, `restartPolicy: Never|OnFailure`; `oc create job <name> --image=... -- <cmd>`; inspect `oc get/describe job`, `oc logs job/<name>`; Job must reach `Complete`.
- **Configure Kubernetes cron jobs** — `batch/v1 CronJob`: `schedule` (cron format), `timeZone`, `concurrencyPolicy` Allow/Forbid/Replace, `startingDeadlineSeconds`, `suspend`, `successfulJobsHistoryLimit`, `failedJobsHistoryLimit`, `jobTemplate`; `oc create cronjob <name> --image=... --schedule='*/1 * * * *' -- <cmd>`; verify spawned Jobs.

---

## 3. Objective counts

9 groups, **55 bullets**: 14 + 7 + 6 + 5 + 6 + 2 + 5 + 3 + 7. This was counted from the redhat.com page and matches the LMS PDF's `EX280V422` section.

> ⚠️ Internal inconsistency: `docs/CONVERSION-SPEC.md` mentions "X / 104 objectives" in the EX280 Prep and progress sections. The official V422 objective set is 55 bullets / 9 groups, not 104. The game should either use 55 or define explicitly that it counts bullets + groups + recommended drill items. Flag for the Lead.

## 4. Version-sensitive things this exam punishes if you get them wrong

1. **DeploymentConfig vs Deployment.** `DeploymentConfig` (`apps.openshift.io/v1`) is deprecated since OCP 4.14 and only maintained for security/critical fixes; it still works in 4.22. New manifest/declarative tasks on the exam should use `apps/v1` **Deployment**. DeploymentConfig-specific features (native triggers, deployment strategies, deployer pod) exist mostly for legacy content; the `deployer` service account can even be absent when the DeploymentConfig capability is disabled. Source: 4.22 docs include `snippets/deployment-config-deprecated.adoc` ("As of OCP 4.14, DeploymentConfig objects are deprecated...").
2. **`oc export` no longer exists.** No occurrence in OCP 4.22 CLI docs. Export with `oc get ... -o yaml > file`.
3. **Service-account tokens changed in 4.16.** No automatically created long-lived API token Secret for new SAs. Use `oc create token <sa>` (bound token, default expiry) or projected `serviceAccountToken` volumes. Existing long-lived tokens keep working.
4. **SCCs are still enforced in 4.22, and `restricted-v2` is the default.** `privileged` is not granted by default; "Run privileged applications" = grant an SCC to the workload's service account (or custom SCC), not just set `privileged: true`.
5. **Kustomize and Helm are new/explicit in V422.** V412K/V414K did not name them. OCP product docs coverage of Kustomize is thin (CLI help for `oc apply -k`/`oc kustomize`; MicroShift job doc); rely on DO280-style hands-on practice.
6. **Old sections are gone from V422.** V412K had *Manage storage for application configuration and data* (PV/PVC/storage classes/StatefulSets) and *Configure applications for reliability* (probes/limits/scaling); V414K had *Update OpenShift* (cluster updates/deprecated APIs/operator updates). None is a separate V422 objective. Do not spend primary study time there; keep only what naturally appears in manifests (e.g. a PVC in a template, probes inside a Deployment).
7. **MetalLB/Multus sentence from V412K is gone.** V422 instead says "Configure a load balancer service" + "Configure external application access". You still need MetalLB knowledge to make `type: LoadBalancer` work on bare-metal/on-prem clusters, but do not assume the exam asks you to configure BGP/VRF.
8. **Default project template lives in `openshift-config`** as `project-request` (older docs referenced different namespaces). NetworkPolicies can be added to its `objects` list.
9. **Route admission policy:** cross-namespace hostname claims are disabled by default; set `IngressController` `.spec.routeAdmission.namespaceOwnership` via `oc -n openshift-ingress-operator patch ingresscontroller/default ...`.
10. **OLM v0 vs v1:** 4.22 docs contain both classic OLM (Subscription/OperatorGroup/CSV/InstallPlan) and new "Extensions" OLM v1. EX280 operator tasks align with classic OLM v0 / OperatorHub; treat OLM v1 as out of scope unless Red Hat says otherwise (flagged as an assumption).

## 5. What changed vs V412K/V414K (why old study material lies)

From the LMS PDF's version sections:

| V412K/V414K sections not in V422 | V422 sections that are new/changed |
|---|---|
| Manage storage for application configuration and data (secrets, configmaps, PV, storage classes, StatefulSets) | **Declarative Resource Management** (manifests, Kustomize, Kustomize overlays, secrets, config maps) — Kustomize is new |
| Configure applications for reliability (health probes, compute limits, scaling) | **Deploy applications** explicitly includes templates **and Helm charts**, replica sets, labels/selectors, services |
| Manage application updates (image tags/digests, rollbacks, image streams, triggers) | Image tags/digests moved into **Manage OpenShift Container Platform**; rollbacks folded into "Manage application deployments" |
| Update OpenShift (cluster updates, deprecated API usage, operator updates) | **No update objective** in V422 |
| "Work with operators such as MetalLB and Multus" | Replaced by explicit **Expose non-HTTP/SNI Applications** group (LB service + external access) |

Also new in V422: **service accounts** and **application access to Kubernetes APIs** are explicit under Configure application security; **jobs and cron jobs** are explicit (V412K had "Deploy jobs to perform one-time tasks" but not cron jobs).

## 6. Verified documentation map (OCP 4.22)

All URLs below were fetched and returned HTTP 200 on 2026-11-03 unless marked "(guide index)".

| Topic | URL |
|---|---|
| OCP 4.22 doc home | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22 |
| CLI tools / CLI reference | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index |
| Web console | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index |
| Authentication and authorization | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index |
| RBAC chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac |
| Service accounts chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts |
| Network security | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index |
| Network policy chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy |
| Ingress and load balancing | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index |
| Routes chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes |
| Building applications | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index |
| Images | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/index |
| Managing image streams chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams |
| Nodes | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index |
| Operators | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index |
| Monitoring | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/monitoring/index |
| Using quotas and limit ranges chapter | https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas |
| Exam objectives by version PDF (LMS) | https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf |
| Official exam page | https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam |
| Red Hat Certification Program Guide | https://docs.redhat.com/en/documentation/red_hat_learning_subscription/1-latest/html/red_hat_certification_program_guide/index |

## 7. Gaps and unverifiable claims

- **Passing score / score scale / certification validity:** not published on the fetched exam page; program guide content could not be extracted. Marked UNVERIFIED.
- **Current DO280 official outline:** redhat.com DO280 page is HTTP 404 (2026-11-03). The exam page's own "Recommended Preparation" is authoritative for the course name; partner outlines are stale (4.14-based).
- **Exam price and number of tasks/items:** not stated on the fetched exam page content.
- **OLS/Olm v1 scope:** assumption that EX280V422 operator tasks mean classic OLM v0 (OperatorHub/Subscription/CSV). Not explicitly stated by Red Hat.
- **Chapter-level docs URLs:** guide index pages and a subset of chapter pages were verified HTTP 200; some topic citations therefore link the guide index rather than a specific chapter. The published chapter slugs are not 1:1 with source file names.
- Some learner-facing claims about "what the exam will actually ask" are informed judgement from objective wording + DO280 topic alignment, not Red Hat statements; they are separated as "must know" notes and flagged where they matter.
