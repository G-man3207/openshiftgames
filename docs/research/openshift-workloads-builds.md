# OpenShift 4.22 - Workloads, Builds, ImageStreams, Templates, Operators, Helm, Kustomize & Quotas

**Research reference for the k8sgames → OpenShift/EX280 conversion.**
Feeds campaign levels, incident definitions, and command-bar verbs. RESEARCH ONLY - no game code was modified.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document                | `docs/research/openshift-workloads-builds.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Research / access date  | **2026-11-03**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary doc set         | **OpenShift Container Platform 4.22** on docs.redhat.com - latest 4.x (`/4.22/` is live; `/4.23/` returns 404). The docs root/version selector also lists **5.0**; the exam is 4.22-based, so every link below is pinned to `/4.22/`.                                                                                                                                                                                                                                                                                  |
| Exam targeted           | **EX280V422** - Red Hat Certified Specialist in OpenShift Administration (per the LMS objectives PDF; redhat.com page still titles it "Red Hat Certified System Administrator in OpenShift exam")                                                                                                                                                                                                                                                                                                                      |
| Exam/objectives sources | Exam page <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>; LMS _Exam Objectives by Version_ PDF <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf> (EX280V422 section; both fetched 2026-11-03)                                                                                                                                                                                            |
| Verification method     | Downloaded the official OCP 4.22 PDF bundles for **CLI tools, Building applications, Builds using BuildConfig, Images, Operators, Nodes, Authentication and authorization, Release notes** and extracted them locally; every command/YAML/API version below was cross-checked against that text. Every cited docs.redhat.com chapter URL was fetched and returned HTTP 200 on 2026-11-03. Upstream Kubernetes/Helm docs are used only for the two documented gaps (Kustomize prose, StatefulSet prose) and are marked. |
| Confidence              | **High** for commands, flags, YAML shapes and API versions that appear verbatim in the 4.22 docs. **Medium** for items flagged ⚠️ (doc inconsistency, CLI help-only flag, or lab-dependent behaviour - verify on the exam-like 4.22 cluster).                                                                                                                                                                                                                                                                          |
| Deliberate exclusions   | Services/Routes/Ingress/NetworkPolicy/PVC/Storage/SCC detail → sibling task `docs/research/openshift-networking-security-storage.md`; exam-objective narrative → `docs/research/ex280-objectives.md` and `docs/research/ex280-study-guide.md`.                                                                                                                                                                                                                                                                         |

> **Version caveat up front**
>
> 1. **DeploymentConfig is deprecated** (since OCP 4.14; still listed Deprecated in the 4.22 release-notes tracker). New content should teach `Deployment` (`apps/v1`). `DeploymentConfig` stays in the game only for legacy/realism/trap content.
> 2. **The Cluster Samples Operator is deprecated** in 4.22: no new templates, samples or non-S2I image streams are added; existing **S2I builder image streams and templates keep receiving updates "until the Cluster Samples Operator is removed in a future release."** So `oc get templates -n openshift`, `oc new-app --template=...`, and `openshift/<lang>` builder images are real in 4.22 but on a deprecation path.
> 3. **Pipeline build strategy is deprecated**; Red Hat points to OpenShift Pipelines (Tekton).
> 4. **OLM v1** (next-gen Operator Lifecycle Manager) is GA alongside classic OLM; OCP 4.22 docs keep OLM v1 in a separate "Extensions (OLM v1)" guide. EX280 exercises classic OLM objects (`Subscription`/`OperatorGroup`/`CSV`/`InstallPlan`) - that is what this doc covers. [R26][R28][R29]
> 5. Some 4.22 doc **examples are legacy** (e.g. they show `dc/...` output for `oc new-app`). Where docs and current CLI behaviour disagree, this doc says so explicitly and tells the game which fact to model.

---

## 0. How this document maps to EX280V422

Objective bullets below are quoted/normalised from the EX280V422 section of the official exam-objectives PDF. The companion exam docs own the exhaustive objectives list; this doc owns **how the workloads/builds half is actually done**.

| #   | EX280V422 objective                                                                                                                                                                       | Covered in                                          | Exam-style lab |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| 1   | Manage OCP → **Use the command-line interface**; **create/delete projects**; **locate/examine container images**; **identify images by tags and digests**                                 | §1, §2, §5.5                                        | L1, L2         |
| 2   | Manage OCP → **Query, format, and filter attributes of Kubernetes resources**; **import, export, and configure Kubernetes resources**; **examine resources and cluster status**           | §1.4, §1.5, §3                                      | L1, L5         |
| 3   | Manage OCP → **View logs**; **monitor events/alerts**; **troubleshoot common container/pod/cluster events**                                                                               | §1.7, §4.8, §5.4 (build-specific)                   | L1, L2         |
| 4   | Declarative resource management → **work with resource manifests**; **deploy from YAML**; **update application deployments**                                                              | §3, §4                                              | L1, L5         |
| 5   | Declarative resource management → **deploy with Kustomize**; **work with Kustomize overlays**                                                                                             | §3.3                                                | L5             |
| 6   | Deploy applications → **deploy from templates and Helm charts**                                                                                                                           | §6, §8                                              | L3, L6         |
| 7   | Deploy applications → **manage application deployments**; **work with replica sets**; **labels and selectors**                                                                            | §4.3-§4.6                                           | L1             |
| 8   | Enable developer self-service → **cluster resource quotas**; **project quotas**; **project resource requirements**; **project limit ranges**; **project templates**                       | §2.3, §9                                            | L4             |
| 9   | Manage OpenShift operators → **install an operator**; **uninstall an operator**; **delete an operator**                                                                                   | §7                                                  | L6             |
| 10  | Manage authentication and authorization → **HTPasswd identity provider**; **create/delete users**; **modify user passwords**; **create/manage groups**; **modify user/group permissions** | §11 (practical flow; SCC/RBAC depth in sibling doc) | L7             |
| 11  | Configure application security → **service accounts**; **Kubernetes API access**; **Jobs**; **CronJobs** (SCC/privileged/Secrets → sibling doc)                                           | §10, §11.4                                          | L7             |

**V422-explicit vs. background in this doc**

| Topic                                                                                                        | Status for EX280V422                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oc` CLI, projects, manifests, `oc apply/create/replace/patch/edit/delete`, query/format/filter, events/logs | **Explicit** ("Manage OpenShift Container Platform", "Declarative Resource Management")                                                                                                                                                                                                                                               |
| Kustomize (kustomization.yaml, overlays, `oc apply -k`)                                                      | **Explicit** ("Deploy applications using Kustomize / Work with Kustomize overlays")                                                                                                                                                                                                                                                   |
| Deployment / replica sets / labels / selectors / scaling / rollouts                                          | **Explicit** ("Manage application deployments / Work with replica sets")                                                                                                                                                                                                                                                              |
| Templates (`oc process`, `oc new-app --template`, `oc get templates -n openshift`) and project templates     | **Explicit** ("Deploy applications from templates", "Configure project templates")                                                                                                                                                                                                                                                    |
| Helm charts                                                                                                  | **Explicit** ("Deploy applications from templates and Helm charts")                                                                                                                                                                                                                                                                   |
| Operator install/uninstall/delete (classic OLM)                                                              | **Explicit** ("Manage OpenShift operators")                                                                                                                                                                                                                                                                                           |
| ResourceQuota / ClusterResourceQuota / LimitRange / QoS / resource requirements                              | **Explicit** ("Enable developer self-service", "Configure project resource requirements")                                                                                                                                                                                                                                             |
| Jobs, CronJobs                                                                                               | **Explicit** ("Deploy jobs to perform one-time tasks", "Configure Kubernetes cron jobs")                                                                                                                                                                                                                                              |
| HTPasswd, users, groups, role bindings                                                                       | **Explicit** ("Manage authentication and authorization")                                                                                                                                                                                                                                                                              |
| BuildConfig / S2I / `oc new-app` / `oc start-build` / image-change triggers                                  | **Background but required context**: the objectives say "locate and examine container images", "identify images using tags and digests", and templates that contain `BuildConfig` objects are still the canonical OpenShift build workflow. The game should teach it for realism and because the in-exam 4.22 cluster still ships it. |
| DeploymentConfig (DC)                                                                                        | **Legacy/background only** - deprecated; useful as a trap/incident ("why is `oc rollout undo` different on a DC?").                                                                                                                                                                                                                   |
| DaemonSets, StatefulSets                                                                                     | **Background/supporting** - implied by broad "manage and configure an OpenShift cluster" but not a named V422 bullet. Keep one screen each.                                                                                                                                                                                           |
| Shipwright "Builds" framework                                                                                | **Out of scope** - separate product docs; note it exists so game copy never presents `BuildConfig` as the only build system in 4.22.                                                                                                                                                                                                  |

---

## 1. `oc` CLI essentials (the command bar's vocabulary)

OpenShift CLI (`oc`) is a superset of `kubectl`: same verbs/API access, plus native support for `DeploymentConfig`, `BuildConfig`, `Route`, `ImageStream`, `ImageStreamTag`; built-in `oc login`; the "project" abstraction; and commands such as `oc new-app` / `oc new-project`. Both binaries ship with OCP and both work against a cluster; `kubectl` only knows Kubernetes primitives. [R4]

### 1.1 Quick reference - the commands the game must support

| Task                                     | Exact command (OCP 4.22 docs)                                                                                                                                              | Source    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Interactive/browser login                | `oc login <cluster_url> --web` (optional `--callback-port 8280`)                                                                                                           | [R4]      |
| Password login                           | `oc login <api_server_url> -u <username> -p <password>`                                                                                                                    | [R4]      |
| Token login                              | `oc login https://openshift1.example.com --token=<token>`                                                                                                                  | [R4]      |
| Logout                                   | `oc logout`                                                                                                                                                                | [R4]      |
| Who am I / which context                 | `oc whoami` · `oc whoami -c`                                                                                                                                               | [R4]      |
| Current project                          | `oc project` (prints `Using project "..." on server "..."`)                                                                                                                | [R4]      |
| List accessible projects                 | `oc projects` · `oc get projects`                                                                                                                                          | [R4][R6]  |
| Switch project                           | `oc project <project_name>`                                                                                                                                                | [R4][R6]  |
| Create project                           | `oc new-project <project_name> --description="<description>" --display-name="<display_name>"`                                                                              | [R4][R6]  |
| Delete project                           | `oc delete project <project_name>`                                                                                                                                         | [R6]      |
| Project/cluster overview                 | `oc status` · `oc status --suggest`                                                                                                                                        | [R4][R6]  |
| Health-oriented view                     | `oc cluster-info`; `oc get clusteroperators` (see sibling networking doc)                                                                                                  | [R4]      |
| Resource help                            | `oc explain pods` · `oc explain pods.spec.containers` · `oc explain pods --recursive` · `oc explain deployments --api-version=apps/v1`                                     | [R4]      |
| Command help                             | `oc help` · `oc <command> --help`                                                                                                                                          | [R4]      |
| Supported APIs                           | `oc api-resources` · `-o wide` · `--namespaced=true\|false` · `--api-group=rbac.authorization.k8s.io` · `oc api-versions`                                                  | [R4]      |
| Apply manifests                          | `oc apply -f ./pod.json` · `oc apply -k dir/` · `cat pod.json \| oc apply -f -` · `oc diff -f pod.json`                                                                    | [R4]      |
| Create from manifest                     | `oc create -f <file>` · `oc create -f -` (stdin)                                                                                                                           | [R4]      |
| Replace                                  | `oc replace -f ./pod.json` · `oc replace --force -f ./pod.json` (delete + recreate)                                                                                        | [R4]      |
| Patch                                    | `oc patch deployment nginx-deployment --subresource='scale' --type='merge' -p '{"spec":{"replicas":2}}'` · `oc patch node k8s-node-1 -p '{"spec":{"unschedulable":true}}'` | [R4]      |
| Edit live object                         | `oc edit deployment/mydeployment` · `KUBE_EDITOR="nano" oc edit svc/registry`                                                                                              | [R4]      |
| Delete                                   | `oc delete -f ./pod.json` · `oc delete pod,service baz foo` · `oc delete pods,services -l name=myLabel` · `oc delete pods --all` · `oc delete -k dir`                      | [R4]      |
| Get                                      | `oc get pods -o wide` · `oc get deployments.v1.apps -o json` · `oc get -o json pod web-pod-13je7` · `oc get pods --all-namespaces` · `oc get rc,services`                  | [R4]      |
| Describe                                 | `oc describe pods/nginx` · `oc describe pods -l name=myLabel` · `oc describe -f pod.json`                                                                                  | [R4]      |
| Events                                   | `oc events` · `oc events --all-namespaces` · `oc events --for pod/web-pod-13je7 --watch` · `oc events --types=Warning,Normal`                                              | [R4]      |
| Logs                                     | `oc logs -f pod/backend -c ruby-container` · `oc logs deployment/ruby` · `oc logs -f bc/<bc>` · `oc logs -f dc/<dc>`                                                       | [R4][R32] |
| Get all classic app objects              | `oc get all` · `oc get -o yaml all > <yaml_filename>`                                                                                                                      | [R4][R7]  |
| Export one resource as YAML              | `oc get deployment/myapp -o yaml > myapp.yaml`                                                                                                                             | [R4]      |
| Set context project without `oc project` | `oc config set-context \`oc config current-context\` --namespace=<project_name>`                                                                                           | [R4]      |
| Kubeconfig operations                    | `oc config view --raw > kubeconfig`; `export KUBECONFIG=./kubeconfig`; `oc config get-contexts`; `oc config use-context <name>`; `oc config current-context`               | [R4]      |

**Auth/session facts:** first interactive login writes/updates `~/.kube/config` (contexts/clusters/users + `current-context`); multiple kubeconfig files merge at runtime and CLI flags override; `KUBECONFIG` selects a file. `oc login` supports `--certificate-authority`, `--insecure-skip-tls-verify`, `--token`, `--username/--password`, `--web`. `oc logout` deletes the token server-side and from the config. [R4]

### 1.2 `oc` vs `kubectl` - what to put in game copy

| Capability                                                                                       | `oc`                                                                                                                                                                                                                                               | `kubectl`                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Kubernetes API objects (Deployment, Pod, Job, …)                                                 | yes                                                                                                                                                                                                                                                | yes                                                                                               |
| OpenShift resources: `DeploymentConfig`, `BuildConfig`, `Route`, `ImageStream`, `ImageStreamTag` | yes (full support)                                                                                                                                                                                                                                 | not natively modelled (you can fetch via API if CRDs exist, but no First-Class UX/help/`new-app`) |
| `oc login` / OAuth token flow                                                                    | yes                                                                                                                                                                                                                                                | no (needs kubeconfig/token setup)                                                                 |
| Projects / project requests                                                                      | yes (`oc project`, `oc new-project`, project abstraction)                                                                                                                                                                                          | namespaces only                                                                                   |
| App scaffolding                                                                                  | `oc new-app`, `oc new-build`, `oc new-project`                                                                                                                                                                                                     | no equivalent                                                                                     |
| Client/server compatibility                                                                      | must be ≤ server-ish; **older `oc` cannot use all commands/features of a newer server** - OCP docs: "If you installed an earlier version of the oc binary, you cannot use it to complete all of the commands in OpenShift Container Platform 4.22" | standard k8s skew rules                                                                           |

Game rule of thumb: **`oc` is the in-game verb; `kubectl` is an alias/trap** - acceptable for pure-Kubernetes objects, but a "wrong tool" incident for `oc new-app`/`oc login`/`oc project` tasks and for OpenShift objects. [R4]

### 1.3 Kubeconfig / contexts / projects - exact model

- `~/.kube/config` holds `clusters[]`, `contexts[]` (cluster + user + namespace), `users[]`, `current-context`. A context nickname in OCP docs is typically `<namespace>/<cluster>/<user>`. [R4]
- `oc config set-context \`oc config current-context\` --namespace=<project>`changes the namespace of the active context;`oc config use-context <nickname>` switches context. [R4]
- The **project** is the CLI-facing representation of a namespace. `oc project <name>` changes the active context's namespace for the session/context (same effect as `oc config set-context ... --namespace`). [R4][R6][R37]

### 1.4 Query, format, filter (V422-explicit)

Documented output/filter options the game should model:

| Need                     | Command pattern                                                                                                                                         | Source    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Human table              | `oc get pods`                                                                                                                                           | [R4]      |
| More columns (node, IP…) | `oc get pods -o wide` (`oc get nodes -o wide` is also documented)                                                                                       | [R4][R31] |
| Full objects             | `oc get deployment/myapp -o yaml` / `-o json`                                                                                                           | [R4]      |
| Names only               | `oc get pods -o name` (same `-o` machinery; docs show `-o name` on `oc adm groups new`)                                                                 | [R4]      |
| Custom columns           | `oc get pod test-pod -o custom-columns=CONTAINER:.spec.containers[0].name,IMAGE:.spec.containers[0].image`                                              | [R4]      |
| JSONPath / go-template   | `oc get istag busybox:latest -ojsonpath="{...}"` · `oc get is -o go-template='{{range ...}}'` · `oc get -o template pod/x --template={{.status.phase}}` | [R4][R21] |
| Label selector           | `oc get pods -l name=myLabel` · `oc delete pods -l app=foo` · `oc describe pods -l name=myLabel`                                                        | [R4]      |
| Show labels              | `oc get pods --show-labels` (documented for `machineconfigpool`)                                                                                        | [R31]     |
| Field selector           | `oc get pod --all-namespaces --field-selector=spec.nodeName=<nodename>` · `oc delete pods --field-selector status.phase=Failed -n <ns>`                 | [R31]     |
| Sort                     | `oc api-resources --sort-by=name`; `oc get ... --sort-by=...` is the same kubectl flag                                                                  | [R4]      |
| All namespaces           | `oc get pods --all-namespaces` / `-A`                                                                                                                   | [R4]      |
| Watch                    | `oc get pods -w` (standard kubectl flag; docs use `oc events --watch`)                                                                                  | [R4]      |
| API discovery            | `oc api-resources`, `oc explain`, `oc api-versions`                                                                                                     | [R4]      |

> ⚠️ `-o jsonpath`, `-o custom-columns`, `-o go-template`, `--show-labels`, `--field-selector`, `--sort-by` are standard `oc get` flags (same as kubectl) and appear in 4.22 docs in specific examples, but the 4.22 `oc get` reference itself only lists a subset of examples. Treat the table above as doc-verified by example.

### 1.5 Import / export / configure resources (V422-explicit)

**Export (live object → file):**

```bash
oc get deployment/myapp -o yaml > myapp.yaml
oc get -o yaml all > all.yaml          # docs recommend NOT using `all` long-term
oc get -o yaml all | oc apply -f -     # round-trip (only after editing)
```

Docs for `oc get -o yaml all` list included kinds as `BuildConfig, Build, DeploymentConfig, ImageStream, Pod, ReplicationController, Route, Service` and explicitly warn: _"Using the all alias is not recommended because the contents might vary across different clusters and versions. Instead, specify all required resources."_ [R7]

**Import/apply (file → cluster):**

```bash
oc apply -f myapp.yaml                 # create or update; records last-applied annotation
oc create -f myapp.yaml                # create only; errors if object exists
oc replace -f myapp.yaml               # replace; --force = delete then re-create
oc get deployment/myapp -o yaml | sed 's/image: .*/image: quay.io/x/y:2/' | oc replace -f -
oc diff -f myapp.yaml                  # preview apply diff
cat myapp.yaml | oc apply -f -         # stdin
```

**Configure live objects without a file:** `oc patch` (strategic merge / JSON patch / `--subresource=scale`), `oc edit` (opens `$KUBE_EDITOR`), `oc set ...` helpers, `oc label`/`oc annotate`. [R4]

**Deletion:** `oc delete -f <file>`, `oc delete <type>/<name>`, `-l <selector>`, `--all`, `--now`, `--force`; `oc delete -k <dir>` deletes a kustomization. [R4]

**Last-applied bookkeeping (advanced but documented):**

```bash
oc apply view-last-applied deployment/nginx
oc apply set-last-applied -f deploy.yaml [--create-annotation=true]
oc apply edit-last-applied deployment/nginx
```

⚠️ `oc apply --prune` is still **Alpha** per 4.22 CLI reference - don't make it an exam-critical command in the game. [R4]

**Vanished command:** there is **no `oc export`** in OCP 4.22 docs/CLI reference. The export path is `oc get -o yaml/json` (+ `oc adm release extract` for release content). Game should reject `oc export` as a deprecated/removed habit. [R4]

### 1.6 Labels and annotations (V422-explicit: "work with labels and selectors")

```bash
# add / overwrite / remove
oc label pods foo unhealthy=true
oc label --overwrite pods foo status=unhealthy
oc label pods foo bar-                       # remove label key
oc annotate pods foo description='my frontend'
oc annotate --overwrite pods foo description='nginx frontend'
oc annotate pods foo description-            # remove annotation

# select
oc get pods -l name=myLabel
oc get pods --show-labels
oc delete pods,services -l name=myLabel
oc describe pods -l name=myLabel
```

Label semantics needed by the game: controllers match **spec.selector** to **pod template labels**; `oc get all -l app=x` filters the curated "all" list; label keys can carry `openshift.io/...` meaning (e.g. `openshift.io/requester` selects projects for `ClusterResourceQuota`; `image.openshift.io/triggers` is an annotation not a label). Annotations are non-identifying metadata (tooling/human) - the game should distinguish `metadata.labels` from `metadata.annotations`. [R4][R9][R24]

### 1.7 Cluster status & events for CLI-first incidents

```bash
oc status
oc status --suggest
oc get all
oc events --all-namespaces
oc events --for deployment/myapp --watch
oc events --types=Warning
oc describe deployment/myapp
oc logs -f deployment/myapp          # documented resource form: oc logs deployment/ruby
oc get clusteroperators              # cluster health; see networking/security doc for CO details
```

`oc status` output on 4.22 docs is **legacy-flavoured** (shows `dc/...` for old samples). For game copy, render `deploy/...` unless the scenario is intentionally legacy. [R4]

---

## 2. Projects vs namespaces

**Doc-anchored definition (quote):** _"An OpenShift project is an alternative representation of a Kubernetes namespace. Projects are exposed as editable to end users while namespaces are not. Direct creation of a project is typically restricted to administrators, while end users should use the requestproject resource."_ - Project API, `project.openshift.io/v1`. [R37]

### 2.1 Objects and commands

| Concept                      | Fact                                                                                                                                                    | Source   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Project                      | cluster-scoped `project.openshift.io/v1` representation of a namespace; users see only projects they can read                                           | [R37]    |
| Namespace                    | `v1` Namespace; `oc create namespace` works for admins                                                                                                  | [R4]     |
| Creation by users            | `oc new-project <name>` submits a **ProjectRequest**; API provisions project from the **project template** and grants requester `admin` in that project | [R6]     |
| Creation by admin            | `oc adm new-project <name>` (bypasses self-provisioning/project-request)                                                                                | [R6]     |
| Reserved names               | cannot create `openshift-*` / `kube-*` via `oc new-project`; admins can via `oc adm new-project`                                                        | [R6]     |
| List                         | `oc get projects`, `oc projects`                                                                                                                        | [R4][R6] |
| Switch                       | `oc project <name>`                                                                                                                                     | [R6]     |
| Status                       | `oc project`, `oc status`                                                                                                                               | [R6]     |
| Delete                       | `oc delete project <name>`; project goes `Active` → `Terminating`, content cleared, then removed                                                        | [R6]     |
| Impersonated project request | `oc new-project <p> --as=<user> --as-group=system:authenticated --as-group=system:authenticated:oauth`                                                  | [R6]     |

### 2.2 Self-provisioning (developer self-service prerequisite)

- Access is granted by the **`self-provisioner` ClusterRole** bound by the **`self-provisioners` ClusterRoleBinding** to group `system:authenticated:oauth` by default. [R6]
- Inspect: `oc describe clusterrolebinding.rbac self-provisioners`. [R6]
- **Disable self-provisioning** (either form, then set `autoupdate: "false"`):

```bash
# if the binding only binds system:authenticated:oauth:
oc patch clusterrolebinding.rbac self-provisioners -p '{"subjects": null}'
# otherwise:
oc adm policy remove-cluster-role-from-group self-provisioner system:authenticated:oauth
# stop automatic re-bootstrap of the CRB:
oc patch clusterrolebinding.rbac self-provisioners -p '{ "metadata": { "annotations": { "rbac.authorization.kubernetes.io/autoupdate": "false" } } }'
oc new-project test      # now fails: Error from server (Forbidden): You may not request a new project via this API.
```

- Custom rejection text: `spec.projectRequestMessage` in `project.config.openshift.io/cluster`. [R6]

### 2.3 Project template (V422-explicit "configure project templates")

Project creation runs the template named by `spec.projectRequestTemplate.name` in the cluster-scoped **Project** config resource (`config.openshift.io/v1`, kind `Project`, name `cluster`). If unset, the API server creates a default project template. Substituted parameters: `PROJECT_NAME`, `PROJECT_DISPLAYNAME`, `PROJECT_DESCRIPTION`, `PROJECT_ADMIN_USER`, `PROJECT_REQUESTING_USER`. [R6]

```bash
oc adm create-bootstrap-project-template -o yaml > template.yaml   # generate default
# edit template.yaml: add objects (ResourceQuota, LimitRange, RoleBindings, ...)
oc create -f template.yaml -n openshift-config
oc edit project.config.openshift.io/cluster
```

```yaml
apiVersion: config.openshift.io/v1
kind: Project
metadata:
  name: cluster
spec:
  projectRequestTemplate:
    name: project-request # name of the Template in openshift-config
  # projectRequestMessage: "To request a project, contact ..."   # optional custom message
```

⚠️ Adding a `ResourceQuota` to the project template is exactly how a cluster admin makes every new project start with quotas (see §9.6). The Quota object must include `namespace: ${PROJECT_NAME}`. [R9]

### 2.4 Namespace-scoped `Project` vs cluster-scoped `Namespace` - game traps

| Trap                                     | Correct behaviour                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `oc create namespace foo` by a developer | usually Forbidden - developers use `oc new-project` (project request)                                               |
| `oc get projects` as non-admin           | only readable projects are listed                                                                                   |
| `oc project` with no arg                 | prints current project + server                                                                                     |
| `kubectl create namespace`               | bypasses project template/quota/RBAC defaults; should be flagged as wrong way in game content                       |
| deleting a project                       | `Terminating` state is slow - game incidents can show "namespace stuck terminating" (see §7.3 uninstall caveat too) |

---

## 3. Declarative resource management (V422-explicit)

### 3.1 The four write paths (teach the difference!)

| Verb                   | Behaviour                                                                                                                                             | When used                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `oc create -f`         | POST; fails if object already exists                                                                                                                  | first deployment, exam "create from manifest"            |
| `oc apply -f`          | create **or** update; stores `kubectl.kubernetes.io/last-applied-configuration`; warning if resource wasn't created by `create --save-config`/`apply` | idempotent/declarative workflow, exam "deploy from YAML" |
| `oc replace -f`        | PUT/full replace; `--force` deletes then re-creates (drops status/uid)                                                                                | fix immutable-field errors, recover broken objects       |
| `oc patch` / `oc edit` | partial update / in-editor update                                                                                                                     | quick field changes (`replicas`, `image`, `resources`)   |

Documented examples: [R4] (all four), [R7] (pipe `oc new-app ... -o yaml` → edit → `oc create -f`), [R33] (export/apply pattern: `oc create ... --dry-run=client -o yaml | oc replace -f -`).

**Assumed exam behaviour:** after `oc apply -f app.yaml`, the game should validate object shape (`apiVersion`/`kind`/`metadata.name`/`spec.selector` matching etc.) and then instantiate the object through the simulated controllers (§4). `oc create -f -` from `oc process`/`oc new-app -o yaml` must work too.

### 3.2 Export → edit → re-apply loop (classic exam workflow)

```bash
oc get deployment/myapp -o yaml > /tmp/myapp.yaml
# edit image/replicas/resources in the YAML
oc apply -f /tmp/myapp.yaml      # or: oc replace -f /tmp/myapp.yaml
oc rollout status deployment/myapp
```

`oc apply` on a `Deployment` changes the pod template → triggers a new ReplicaSet/rollout. Changing only metadata labels/annotations does not. [R8][R39]

### 3.3 Kustomize (V422-explicit, thin OCP prose - flagged)

**Docs gap:** OCP 4.22 has **no dedicated Kustomize chapter**. The verified documentation is the CLI reference entries for `oc apply -k`, `oc kustomize`, `oc get -k`, `oc delete -k`, plus the CLI help text. The game should therefore teach the standard Kubernetes Kustomize workflow (upstream docs are the canonical reference) with OCP commands as the wrapper. [R4][R41]

| Command                   | Meaning                                         | Source |
| ------------------------- | ----------------------------------------------- | ------ |
| `oc apply -k dir/`        | build `dir/kustomization.yaml` and apply output | [R4]   |
| `oc kustomize [dir\|URL]` | render kustomization to stdout (client-side)    | [R4]   |
| `oc get -k dir/`          | get resources declared by the kustomization     | [R4]   |
| `oc delete -k dir`        | delete resources declared by the kustomization  | [R4]   |

Canonical layout the game should support (upstream-verified):

```
myapp/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
└── overlays/
    └── prod/
        ├── kustomization.yaml
        ├── replicas-patch.yaml
        └── resources-patch.yaml
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
commonLabels:
  app: myapp
```

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: myapp-prod
namePrefix: prod-
bases: # newer kustomize prefers `resources:` for both
  - ../../base
images:
  - name: quay.io/example/myapp
    newTag: '1.2.3'
patchesStrategicMerge:
  - replicas-patch.yaml
```

```yaml
# overlays/prod/replicas-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 3
```

```bash
oc apply -k overlays/prod
oc kustomize overlays/prod | oc apply -f -   # equivalent, inspectable
oc get deploy,svc -n myapp-prod
```

⚠️ Exact kustomize field names drift across kustomize versions (`bases` vs `resources`, `commonLabels` vs `labels`, `patchesStrategicMerge` vs `patches`). `oc apply -k` in 4.22 accepts the vendored kustomize version's schema. For game content, stick to `resources:`, `namespace:`, `namePrefix:`, `images:`, `commonLabels:`, `patchesStrategicMerge:` which are stable across the OCP 4.x line, and mention `patches:` (JSON6902/strategic) as an alternative. Verify against `oc kustomize` on the exam cluster if the game simulates strict validation. [R4][R41]

### 3.4 Minimal valid Deployment manifest (the shape every manifest check must accept)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-openshift
  labels:
    app: hello-openshift
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-openshift
  template:
    metadata:
      labels:
        app: hello-openshift
    spec:
      containers:
        - name: hello-openshift
          image: openshift/hello-openshift:latest
          ports:
            - containerPort: 80
```

Source: 4.22 Building applications §7.1.2 (verbatim structure). [R8]

Key validation rules for game content:

- `spec.selector.matchLabels` **must match** `spec.template.metadata.labels`, else API rejects the Deployment.
- `image` pull: `openshift/hello-openshift` resolves through the internal registry/image streams; in game define image availability explicitly.
- `containerPort` is informational for networking; Services select pods by labels (sibling doc).
- `resources.requests/limits` required when a quota/limitrange enforces them (§9).

---

## 4. Workloads: Deployment vs DeploymentConfig, rollouts, scaling, runtime config

### 4.1 Which to use in OCP 4.22 (and in the exam)

**Verbatim guidance:** _"Use Deployment objects unless you need a feature that only DeploymentConfig objects provide."_ [R8]
**Deprecation:** _"As of OpenShift Container Platform 4.14, DeploymentConfig objects are deprecated. DeploymentConfig objects are still supported, but are not recommended for new installations. Only security-related and critical issues will be fixed."_ [R8] The 4.22 release-notes tracker lists `DeploymentConfig objects` = Deprecated for 4.20/4.21/4.22. [R36]

| Aspect                        | Deployment (`apps/v1`)                                        | DeploymentConfig (`apps.openshift.io/v1`)                    |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Controller / child objects    | DeploymentController → **ReplicaSets**                        | deployer pod → **ReplicationControllers**                    |
| Rollout engine                | controller loop (fast, many RS alive at once)                 | one deployer pod per rollout; max 2 RCs active               |
| Scale during rollout          | supported (proportional scaling)                              | not supported while a rollout is in progress                 |
| Pause mid-rollout             | yes (`oc rollout pause deployment/...`)                       | deployer pods cannot be paused                               |
| Triggers                      | implicit config change (pod-template change triggers rollout) | explicit `ConfigChange` + `ImageChange` triggers             |
| Automatic rollback on failure | **no**                                                        | **yes** (automatic rollback to last successful revision)     |
| Lifecycle hooks               | **no**                                                        | yes (`pre`/`mid`/`post`, `failurePolicy` Abort/Retry/Ignore) |
| Custom deployment strategy    | **no**                                                        | yes (`Custom` strategy + `customParams`)                     |
| Route-based strategies        | supported (blue-green/A/B via route weights)                  | supported                                                    |
| Status for exam               | **recommended/default**                                       | **deprecated; legacy/trap content only**                     |

Sources: [R8] (comparison section 7.1.4), [R12] (triggers/hooks concept), [R4] (`oc rollout` vs `oc rollback` command split).

**Game modelling guidance**

- Default workload kind for "deploy an app" tasks: `deployment.apps` (Deployment).
- `oc new-app` in current OCP produces a **Deployment by default**; `--as-deployment-config=true` opts into a DC. ⚠️ The 4.22 "new-app output objects" table still says "DeploymentConfig" (legacy text) and several doc examples use DC; the 4.22 CLI includes `--as-deployment-config` _"If true create this application as a deployment config, which allows for hooks and custom strategies."_ The flag existing (and doc examples needing it to get DC behaviour) is the evidence that Deployment is the default. Verify with `oc new-app --help` on the exam-like cluster before hard-coding the rule in game copy. [R7][R4]
- Rollback verbs: `oc rollout undo deployment/...` for Deployments; `oc rollback` / `oc rollout undo dc/...` / `oc rollout latest dc/...` / `oc rollout retry dc/...` for DCs. [R4]

### 4.2 Deployment creation paths

```bash
# scaffold from an image (quick object)
oc create deployment my-dep --image=nginx --replicas=3 --port=80

# scaffold from code + builder (S2I; also creates BC/IS/Service)
oc new-app https://github.com/sclorg/cakephp-ex
oc new-app openshift/php:8.0~https://github.com/sclorg/cakephp-ex
oc new-app --strategy=docker --binary --name myapp
oc new-app --image=myregistry:5000/example/myimage --name=private

# declaratively (preferred)
oc apply -f deployment.yaml
```

`oc new-app` documented capabilities (all used by exam prep labs): `--list`, `--search ruby`, `--template=`, `--file=`, `-p/--param`, `--param-file`, `--name`, `-n`, `-l`, `-e/--env`, `--env-file`, `--build-env`, `--build-env-file`, `--context-dir`, `--source-secret`, `--strategy`, `--binary`, `-o yaml`, `--import-mode=Legacy|PreserveOriginal`, `-i/--image-stream` + `--code` (search/list form: `oc new-app -S --image-stream=mysql`). [R4][R7]

**Build strategy auto-detection** when source is given: `Jenkinsfile` → pipeline strategy (deprecated); `Dockerfile` → docker strategy; neither → source (S2I) strategy. Language detection (S2I): `pom.xml`→jee, `package.json`→nodejs, `requirements.txt`/`setup.py`→python, `Gemfile`/`Rakefile`/`config.ru`→ruby, `composer.json`/`index.php`→php, `cpanfile`/`index.pl`→perl, `project.json`/`*.csproj`→dotnet, `build.sbt`→scala, `Godeps`/`main.go`→golang. [R7]

### 4.3 Scaling and ReplicaSets (V422: "work with replica sets")

```bash
oc scale deployment/myapp --replicas=3
oc scale dc/frontend --replicas=3                 # legacy
oc scale --replicas=3 rs/foo                      # explicit RS scaling (rare)
oc scale --replicas=3 statefulset/web             # documented form
oc autoscale deployment myapp --min=2 --max=10 --cpu=80%
oc autoscale deployment myapp --min=3 --max=6 --cpu=500m --memory=200Mi

oc get rs                                       # one RS per rollout revision
oc describe rs                                  # pod-template / replicas / events
oc get pods -l app=hello-openshift              # pods carry template labels
```

Facts: scaling a Deployment changes `spec.replicas` and the deployment controller propagates it to the active RS; old RSs stay at 0 replicas (history). The scale subresource can also be patched: `oc patch deployment nginx-deployment --subresource='scale' --type='merge' -p '{"spec":{"replicas":2}}'`. [R4][R8][R39]

### 4.4 Rollout lifecycle commands (documented verbatim)

```bash
oc rollout status deployment/nginx
oc rollout history deployment/abc
oc rollout history deployment/abc --revision=1
oc rollout history daemonset/abc --revision=3
oc rollout undo deployment/abc
oc rollout undo daemonset/abc --to-revision=3
oc rollout undo --dry-run=server deployment/abc
oc rollout restart deployment/nginx
oc rollout restart deployment --selector=app=nginx
oc rollout pause deployment/nginx
oc rollout resume deployment/nginx
# legacy/DC-only:
oc rollout latest dc/nginx
oc rollout retry dc/frontend
oc rollback frontend --to-version=3 --dry-run
oc rollback frontend
oc set triggers dc/myapp --auto            # re-enable image triggers after a DC rollback
```

Source: [R4] (`oc rollout` reference; `oc rollback` reference), [R8] (DC walkthrough: retry/rollback/trigger-disable semantics), [R36] (DC deprecated).

Exam-critical behaviours to simulate:

- `oc rollout status` blocks/streams until the rollout completes or fails; failure path leaves old RS serving (rolling) or new RS degraded.
- `oc rollout undo` uses revision history; `--to-revision` selects a specific revision (default: previous).
- For a DC, `oc rollout undo` re-disables image change triggers; re-enable with `oc set triggers dc/<name> --auto`. [R8]
- A failed rollout of a Deployment does **not** auto-rollback (this is a DC-only feature). [R8]
- `oc rollout restart` is the "redeploy same image" idiom (e.g. after ConfigMap change) - on a Deployment it updates the pod template annotation and creates a new RS.

### 4.5 Deployment strategies

| Strategy                               | Applies to       | YAML                                                                                                                                             | Docs      |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| RollingUpdate (default for Deployment) | Deployment       | `spec.strategy.type: RollingUpdate`, `rollingUpdate.maxSurge`, `maxUnavailable`                                                                  | [R8][R39] |
| Recreate                               | Deployment       | `spec.strategy.type: Recreate`                                                                                                                   | [R8]      |
| Rolling (default for DC)               | DeploymentConfig | `spec.strategy.type: Rolling`, `rollingParams.maxSurge/maxUnavailable/timeoutSeconds/updatePeriodSeconds/intervalSeconds` (+ `pre`/`post` hooks) | [R8]      |
| Recreate                               | DC               | `spec.strategy.type: Recreate`, optional `recreateParams.pre/mid/post`                                                                           | [R8]      |
| Custom (privileged)                    | DC only          | `spec.strategy.type: Custom`, `customParams.image/command/environment`                                                                           | [R8]      |
| Route-based blue-green / A-B           | any              | two Deployments + one Service/Route; `oc set route-backends web a=2 b=1` / `--adjust b=+10%`                                                     | [R8][R4]  |

Deployment defaults: Kubernetes `rollingUpdate.maxUnavailable` and `maxSurge` default to **25%**; readiness checks gate progress; `Recreate` involves downtime. [R39] OCP's DC rolling strategy defaults `maxSurge`/`maxUnavailable` to 25%, `timeoutSeconds` 600, and automatically rolls back on failure. [R8]

### 4.6 `oc set` - mutate runtime config without editing YAML (documented verbatim)

```bash
# image
oc set image deployment/myapp mycontainer=quay.io/example/app:2
oc set image dc/myapp app=openshift/ruby:2.3 --source=imagestreamtag

# env / env from ConfigMap+Secret
oc set env deployment/myapp STORAGE_DIR=/local
oc set env --from=secret/mysecret deployment/myapp
oc set env --from=configmap/myconfigmap --prefix=MYSQL_ deployment/myapp
oc set env deployment/myapp ENV-                      # remove variable
oc set env bc/sample-build --list

# resources
oc set resources deployment nginx -c=nginx --limits=cpu=200m,memory=512Mi --requests=cpu=100m,memory=256Mi

# probes
oc set probe deployment/webapp --readiness --get-url=http://:8080/healthz
oc set probe deployment/webapp --liveness --open-tcp=3306
oc set probe deployment/webapp --startup --get-url=http://:8080/healthz --initial-delay-seconds=30
oc set probe deployment/myapp --remove --readiness --liveness

# volumes
oc set volume deployment/myapp --add --name=v1 -t pvc --claim-name=pvc1 --overwrite
oc set volume deployment/myapp --add --mount-path=/var/lib/myapp          # emptyDir
oc set volume deployment/myapp --remove --name=v1

# service account (pod identity - V422 "configure/access service accounts")
oc set serviceaccount deployment/myapp myserviceaccount

# triggers (image change for Deployment/StatefulSet; build triggers for BC)
oc set triggers deployment/example --from-image=example:latest -c web
oc set triggers bc/webapp --from-github
oc set triggers bc/webapp --from-image='<image>'
oc set triggers dc/myapp --manual / --auto / --from-config --remove
```

Sources: [R4] (`oc set image|env|resources|probe|volumes|serviceaccount|triggers` reference), [R8] (deployment trigger prose), [R24] (image triggers on Kubernetes workloads).

⚠️ Docs examples usually show `dc/...`; the same `oc set` subcommands accept `deployment/...` for pod-template resources. Verified in 4.22 docs for `deployment nginx` (`set resources`), `deployment/example` (`set triggers`), `deploy/mysql` (`set image-lookup`); others are documented generically as "objects with pod templates". For the game, accept both `deploy/` and `dc/` for `oc set` with the caveat that DC is legacy.

### 4.7 Probes / health checks (V422: manage deployments; troubleshooting)

Three probe types: **readiness** (endpoint membership), **liveness** (kill + restart), **startup** (gate the other two). Test types: HTTP GET (success 2xx-3xx), exec command (exit 0), TCP socket. Tuning fields: `initialDelaySeconds`(0), `periodSeconds`(10), `timeoutSeconds`(1), `successThreshold`(1; must be 1 for liveness), `failureThreshold`(3). [R11]

```yaml
containers:
  - name: web
    image: quay.io/example/web:1
    readinessProbe:
      httpGet:
        path: /healthz
        port: 8080
      periodSeconds: 5
    livenessProbe:
      exec:
        command: ['cat', '/tmp/healthy']
    startupProbe:
      httpGet:
        path: /healthz
        port: 8080
      failureThreshold: 30
      periodSeconds: 10
```

Game incidents to seed: liveness loop (CrashLoopBackOff caused by probe), readiness never passing (Service has no endpoints), startup probe too short, wrong port. [R11][R32]

### 4.8 `oc debug` (troubleshooting / rollout debugging)

```bash
oc debug                              # debug pod from openshift tools image
oc debug deploy/test                  # new pod from deployment's template
oc debug node/master-1                # node debug shell (admin)
oc debug istag/mysql:latest -n openshift
oc debug job/test --as-user=1000000
oc debug daemonset/test -c second -- /bin/env
oc debug mypod-9xbc -o yaml           # inspect the debug pod that would be created
```

`oc debug` creates a standalone pod (not managed by the controller) so it is safe to poke at. [R4] Node debug is `oc debug node/<node>` which lands you in `/host` (see sibling networking doc for node troubleshooting).

### 4.9 DeploymentConfig YAML (legacy reference - keep for traps/realism)

```yaml
apiVersion: apps.openshift.io/v1
kind: DeploymentConfig
metadata:
  name: frontend
spec:
  replicas: 5
  selector:
    name: frontend
  template:
    metadata:
      labels:
        name: frontend
    spec:
      containers:
        - name: helloworld
          image: openshift/hello-openshift
  triggers:
    - type: ConfigChange
    - type: ImageChange
      imageChangeParams:
        automatic: true
        containerNames:
          - helloworld
        from:
          kind: ImageStreamTag
          name: hello-openshift:latest
  strategy:
    type: Rolling
```

Source: 4.22 Building applications §7.1.3 (example DC definition). [R8]

DC semantics to model if the game includes DCs: `ConfigChange` trigger creates a new RC on pod-template change; `ImageChange` fires when the referenced `ImageStreamTag` changes; image triggers are disabled after a rollback until `oc set triggers ... --auto`; deployer pod logs accessible with `oc logs -f dc/<name>`; old deployment logs at `oc logs --version=1 dc/mysql`. [R8][R4]

---

## 5. Builds, S2I, ImageStreams (OpenShift background; required for exam realism)

### 5.1 Build model and strategies

A **BuildConfig** describes one build definition + triggers. It is characterised by a **strategy** and one or more **sources**. Builds run in a build pod, produce an image, and push it to an output (`ImageStreamTag` in the integrated registry or an external `DockerImage`). [R12][R17]

| Strategy              | BuildConfig field                                               | Notes                                                                                               |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Source-to-image (S2I) | `spec.strategy.sourceStrategy.from` (ImageStreamTag of builder) | assembles source into a builder image; supports incremental builds; most OpenShift app builds       |
| Docker                | `spec.strategy.dockerStrategy`                                  | Buildah builds from `Dockerfile`; supports `dockerfilePath`, `from` override, build args, env       |
| Custom                | `spec.strategy.customStrategy`                                  | builder image drives entire build; **runs with high privilege - not available to users by default** |
| Pipeline              | `spec.strategy.jenkinsPipelineStrategy`                         | **deprecated** in OCP 4; use OpenShift Pipelines (Tekton)                                           |

Sources: [R12] (BC definition + runPolicy/triggers/source/strategy/output/postCommit), [R13] (strategy chapters), [R16] (inputs).

**BuildConfig example (S2I, image-change + webhook triggers):**

```yaml
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: ruby-sample-build
spec:
  runPolicy: Serial
  triggers:
    - type: GitHub
      github:
        secret: secret101
    - type: Generic
      generic:
        secret: secret101
    - type: ImageChange
  source:
    git:
      uri: https://github.com/openshift/ruby-hello-world
  strategy:
    sourceStrategy:
      from:
        kind: ImageStreamTag
        name: ruby-20-centos7:latest
  output:
    to:
      kind: ImageStreamTag
      name: origin-ruby-sample:latest
  postCommit:
    script: bundle exec rake test
```

Source: 4.22 Builds §2.1 (verbatim; annotations explained). [R12]

**Docker strategy variant:**

```yaml
spec:
  strategy:
    dockerStrategy:
      dockerfilePath: dockerfiles/app1/Dockerfile
      from:
        kind: ImageStreamTag
        name: debian:latest
      env:
        - name: HTTP_PROXY
          value: http://myproxy.net:5187/
```

Source: [R13] §5.1.

**Build input precedence:** inline Dockerfile → content extracted from existing images → Git repositories → binary (local) inputs → input secrets → external artifacts. Binary and Git are **mutually exclusive**; inline Dockerfile wins over any other `Dockerfile`. [R16]

**Build output:** `ImageStreamTag` (pushed to integrated registry) vs `DockerImage` (external push spec); empty output = no push. Output images get env vars `OPENSHIFT_BUILD_NAME/NAMESPACE/SOURCE/REFERENCE/COMMIT` and labels; extra labels via `spec.output.imageLabels`. [R17]

**Build resources / max duration / node placement / chained builds:** `spec.resources`, `spec.completionDeadlineSeconds`, `spec.nodeSelector`, chained builds via `ImageChange` trigger on the downstream BC. [R18]

### 5.2 Build operations (exam-friendly commands)

```bash
# create builds / apps
oc new-build https://github.com/openshift/ruby-hello-world
oc new-build https://github.com/openshift/ruby-hello-world#beta2
oc new-build -D $'FROM centos:7\nRUN yum install -y httpd'
oc new-build --binary --name=myapp
oc new-app --strategy=docker --binary --name myapp
oc new-build . --image=repo/langimage
oc new-build https://github.com/you/repo --context-dir=src --source-secret=yoursecret

# run / observe
oc start-build hello-world                       # start build for BC
oc start-build hello-world --follow              # stream build log
oc start-build hello-world --wait                # wait; non-zero exit on failure
oc start-build --from-build=hello-world-1        # re-run a specific build
oc start-build hello-world --env=FOO=bar
oc cancel-build bc/hello-world                   # cancel all builds of BC
oc logs -f bc/hello-world                        # latest build logs
oc logs --version=2 bc/hello-world
oc describe build hello-world-1                  # build details incl. source commit/digest
oc describe bc/hello-world                       # includes webhook URLs
oc delete bc/hello-world [--cascade=false]       # keep builds with --cascade=false
```

Sources: [R4] (`oc new-build`, `oc start-build`, `oc cancel-build`, `oc logs`, `oc describe`, `oc delete` references), [R14] (basic build ops) - note `oc start-build` options table: `--from-dir`, `--from-file`, `--from-repo`, `--commit`, `--from-archive`. [R16]

**Binary (local) source builds** - BuildConfig `spec.source.type: Binary`; content is streamed from the client at `oc start-build` time and is _not_ stored server-side; therefore image-change triggers cannot rebuild them and the web console cannot launch them. Dockerfile/contextDir semantics still apply. [R16]

### 5.3 Build triggers

| Trigger                                         | Type                                       | Behaviour                                                                                                                                                                        | Source |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Webhook (GitHub / GitLab / Bitbucket / Generic) | `GitHub`, `GitLab`, `Bitbucket`, `Generic` | External SCM/CI POST triggers a build; URL is generated from BC; secret makes URL unique                                                                                         | [R15]  |
| Image change                                    | `ImageChange`                              | New build when builder image tag changes; with `imageChange: {}` it follows the strategy's `from`; with `from:` it monitors an arbitrary ImageStreamTag; supports `paused: true` | [R15]  |
| Config change                                   | `ConfigChange`                             | Builds once **when the BuildConfig is created** (docs note it currently only works at creation time)                                                                             | [R15]  |

**Webhook URL format** (GitHub example): `https://<openshift_api_host:port>/apis/build.openshift.io/v1/namespaces/<namespace>/buildconfigs/<name>/webhooks/<secret>/github` - `oc describe bc/<name>` prints the URLs. [R15]

**Webhook RBAC gotcha (great incident seed):** OCP's webhook endpoint requires the request to map to the `system:webhook` ClusterRole. Since OCP 4.16, **unauthenticated groups have no default access**; to let GitHub/GitLab/Bitbucket trigger builds, an admin adds `system:unauthenticated` to the `system:webhook` RoleBinding (preferred, per-namespace) or ClusterRoleBinding (less safe, cluster-wide). [R15]

**Set/remove triggers:**

```bash
oc set triggers bc/webapp --from-github
oc set triggers bc/webapp --from-webhook
oc set triggers bc/webapp --from-image='<namespace>/<image>:<tag>'
oc set triggers bc/webapp --from-bitbucket --remove
oc set triggers bc/webapp --remove-all
```

Adding an existing webhook trigger again **regenerates the secret**. [R15]

**Build hooks:** `postCommit` runs a command/script in a temporary container built from the output image, after the final layer is committed and before push; non-zero exit fails the build and prevents the push. [R15]

### 5.4 Build troubleshooting (V422 "troubleshoot")

| Symptom                     | First commands                                                                        | Likely cause                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Build stuck `New`/`Pending` | `oc get builds`, `oc describe bc/<name>`, `oc get events`                             | no build pod schedulable; quota on builds; node selectors                             |
| Build `Failed`              | `oc logs build/<name>`, `oc describe build/<name>`                                    | git clone failed, S2I assemble failure, missing source secret, postCommit test failed |
| No new build after push     | `oc get bc/<name> -o yaml` (triggers/secrets), `oc describe bc/<name>` (webhook URLs) | webhook secret/URL wrong; `system:webhook` RBAC; git ref mismatch                     |
| Image not updated           | `oc get is`, `oc describe istag/<is>:<tag>`                                           | output to DockerImage not ImageStreamTag; tag not pushed; build failed pre-push       |
| Build quota denied          | `oc describe quota`                                                                   | build pods count toward compute quota (`NotTerminating`/`Terminating` scopes)         |

Sources: [R14] (logs/details), [R15] (webhooks/triggers), [R19] (troubleshooting chapter), [R4] (events/logs), [R9] (quota scopes).

### 5.5 ImageStreams: tags, digests, lookup, imports (V422: "locate/examine images", "tags and digests")

**Model:** an ImageStream is an abstraction over image repositories: it stores metadata (tags → image digests), not image data. A tag is a **mutable pointer** to an immutable digest; when a new image is imported/tagged, the tag moves to the new digest; history is kept (enables rollback). Tags may be **permanent** (version-specific) or **tracking** (follow another tag, e.g. `latest`). An ImageStreamTag is `is:tag`; an ImageStreamImage is `is@sha256:...`. [R20][R21]

| Job                                              | Command                                                                                                                                        | Source    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| List streams                                     | `oc get is` / `oc get imagestreams`                                                                                                            | [R4]      |
| Inspect stream + tags + pull spec                | `oc describe is/<image-name>` (prints `Docker Pull Spec:` and tag→digest)                                                                      | [R21]     |
| Inspect one tag (digest, size, entrypoint, arch) | `oc describe istag/<image-stream>:<tag>`                                                                                                       | [R21]     |
| Tag an existing image / other stream             | `oc tag openshift/ruby:2.0 yourproject/ruby:tip`                                                                                               | [R4][R21] |
| Tag external image                               | `oc tag --source=docker openshift/origin-control-plane:latest yourproject/ruby:tip`                                                            | [R4]      |
| Periodic re-import (tracking)                    | `oc tag docker.io/python:3.6.0 python:3.6 --scheduled`                                                                                         | [R21]     |
| Remove a tag                                     | `oc tag -d python:3.6` / `oc delete istag/ruby:latest`                                                                                         | [R21]     |
| Import all/single tags                           | `oc import-image mystream --from=registry.io/repo/image:latest --confirm`; `oc import-image mystream --all`; `oc import-image mystream:stable` | [R4]      |
| Multi-arch import mode                           | `oc import-image ... --import-mode=PreserveOriginal`                                                                                           | [R4][R21] |
| Discover arch/OS of a tag                        | `oc get istag <istag> -ojsonpath="{range .image.dockerImageManifests[*]}{.os}/{.architecture}{'\n'}{end}"`                                     | [R21]     |
| External image inspection                        | `oc image info quay.io/openshift/cli:latest` (also `oc image mirror`, `oc image extract`)                                                      | [R4]      |
| Registry login                                   | `oc registry login`                                                                                                                            | [R4]      |

**Image identity (game model):** tag = human pointer; digest = immutable identity. Any `image:` string can be a registry reference (`registry/repo/image:tag` or `...@sha256:...`) or an ImageStreamTag (`name:tag`) when lookup policy/resolution is enabled. Internal registry pull spec form: `image-registry.openshift-image-registry.svc:5000/<namespace>/<imagestream>:<tag>` (docs show this host in image-registry config; older examples show `docker-registry.default.svc:5000`). [R21][R25]

**ImageStream YAML:**

```yaml
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: my-image-stream
spec:
  lookupPolicy:
    local: true
```

Optionally `spec.tags[].from` (ImageStreamTag / DockerImage / ImageStreamImage). Periodic re-import is configured with `oc tag --scheduled` (cluster-wide default period is 15 minutes; omitting `--scheduled` resets the tag), not required in the YAML for basic game levels. [R21][R22]

**Image lookup for Kubernetes resources (needed for deployment-from-ImageStream):** a Deployment cannot use `image: my-stream:tag` unless image-stream resolution is enabled. Two ways: (a) set the stream's `spec.lookupPolicy.local: true` (`oc set image-lookup mysql`), which applies to all tags; or (b) annotate the workload (`oc set image-lookup deploy/mysql` sets `alpha.image.policy.openshift.io/resolve-names: '*'`). `oc set image-lookup` with no args prints lookup-enabled streams; `--enabled=false` disables. [R23]

**Image-change triggers on Kubernetes workloads (Deployment/StatefulSet/DaemonSet/Job/CronJob/RC/Pod):** Kubernetes objects have no trigger fields; OCP uses the `image.openshift.io/triggers` annotation. `oc set triggers deployment/example --from-image=example:latest -c web` writes it. JSONPath is limited to a precise container by name/index. [R24]

**S2I builder images and the Samples Operator:**

- S2I builder image streams and quick-start templates are created in the `openshift` namespace by the **Cluster Samples Operator**; the operator config lives in `openshift-cluster-samples-operator` and is cluster-scoped. [R21]
- 4.22 caveat: **Cluster Samples Operator is deprecated** - no new templates/samples/non-S2I streams; existing S2I image streams/templates continue to receive updates until removal in a future release. S2I image streams include: Ruby, Python, Node.js, Perl, PHP, HTTPD, Nginx, EAP, Java, Webserver, .NET, Go. [R21][R36]
- List available samples/builders: `oc get templates -n openshift`, `oc get is -n openshift`, `oc new-app --list`, `oc new-app --search php`. [R7]

**S2I mechanics (if the game animates the build):** S2I combines sources + S2I scripts + builder image; it generates a Dockerfile whose `FROM` is the builder and drives Buildah. Scripts lookup order: build-config-specified script → `.s2i/bin` in source → image default from the `io.openshift.s2i.scripts-url` label. Required scripts: `assemble`, `run`; optional: `save-artifacts`, `usage`, `test/run`. [R13]

**Not the only build system:** OCP 4.22 also documents **"Builds" (Shipwright)** as an extensible build framework (S2I + Buildah strategies, Shipwright CLI) in a separate product doc set; the game should not imply BuildConfig is the only way to build in 4.22, but EX280-era tasks still use BuildConfig/ImageStream. [R43]

---

## 6. Templates (V422-explicit: "Deploy applications from templates")

### 6.1 Concepts

A **Template** (`template.openshift.io/v1`, kind `Template`) is a parameterised list of objects. Processing it (`oc process`) substitutes `${PARAM}` / `${{PARAM}}` values and yields an object list (usually a `List`), which is then created with `oc create -f -`. Templates can contain anything the user may create, plus `parameters`, `message`, `labels`, and object-list metadata. [R7][R38]

> 4.22 docs still describe templates as processing into _"resources such as Service and DeploymentConfig objects"_ [R7] - that sentence is legacy; templates can contain any kinds, and current sample templates are being deprecated alongside the Samples Operator (§5.5). For game content: accept arbitrary kinds; prefer `Deployment` in new template objects.

### 6.2 Process / instantiate (documented verbatim)

```bash
# upload a template to the current project's template library
oc create -f <template.yaml>
oc create -f <template.yaml> -n <project>

# list available templates (cluster samples in the openshift namespace)
oc get templates -n openshift

# inspect parameters
oc process --parameters -f <filename>
oc process --parameters -n openshift rails-postgresql-example

# render (no creation)
oc process -f <filename>
oc process -f <filename> --local -o yaml     # process locally, no server contact
oc process <template_name>
oc process openshift//foo                    # template from another namespace

# create objects from the processed output
oc process -f <filename> | oc create -f -
oc process <template> | oc create -f -

# override parameters
oc process -f my-rails-postgresql -p POSTGRESQL_USER=bob -p POSTGRESQL_DATABASE=mydatabase
oc process foo PARM1=VALUE1 PARM2=VALUE2
oc process -f template.json -l name=mytemplate       # add labels to all generated objects
oc process -f my-rails-postgresql --param-file=postgres.env
oc process -f my-rails-postgresql --param-file=-     # read params from stdin

# create an app from a template
oc new-app ruby-helloworld-sample
oc new-app ruby-helloworld-sample -p ADMIN_USERNAME=admin -p ADMIN_PASSWORD=mypassword
oc new-app -f examples/sample-app/application-template-stibuild.json
oc new-app ruby-helloworld-sample --param-file=helloworld.params

# edit an uploaded template
oc edit template <template>
```

Sources: [R4] (`oc process`, `oc new-app` references), [R7] §3.1 (using templates), [R38] (Template API).

### 6.3 Template YAML anatomy (parameters + object list)

```yaml
apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: my-template
objects:
  - kind: BuildConfig
    apiVersion: build.openshift.io/v1
    metadata:
      name: cakephp-mysql-example
    spec:
      source:
        type: Git
        git:
          uri: '${SOURCE_REPOSITORY_URL}'
          ref: '${SOURCE_REPOSITORY_REF}'
        contextDir: '${CONTEXT_DIR}'
  - kind: Deployment
    apiVersion: apps/v1
    metadata:
      name: frontend
    spec:
      replicas: '${{REPLICA_COUNT}}'
parameters:
  - name: SOURCE_REPOSITORY_URL
    displayName: Source Repository URL
    description: The URL of the repository with your application source code
    value: https://github.com/sclorg/cakephp-ex.git
    required: true
  - name: GITHUB_WEBHOOK_SECRET
    description: A secret string used to configure the GitHub webhook
    generate: expression
    from: '[a-zA-Z0-9]{40}'
  - name: REPLICA_COUNT
    description: Number of replicas to run
    value: '2'
    required: true
message: '... The GitHub webhook secret is ${GITHUB_WEBHOOK_SECRET} ...'
```

Source: 4.22 Building applications §3.1.7.3 (verbatim shape; the original uses a `DeploymentConfig`; `Deployment` substituted here deliberately). [R7]

**Parameter substitution facts (game validation rules):**

| Syntax                                        | Meaning                                                                                           | Example                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `${PARAM}`                                    | string substitution anywhere in a string field; multiple refs + fixed text allowed                | `"http://${PARAMETER_1}${PARAMETER_2}"` |
| `${{PARAM}}`                                  | single parameter reference replacing a whole field value; unquoted unless result isn't valid JSON | `replicas: "${{REPLICA_COUNT}}"`        |
| `parameters[].value`                          | default value                                                                                     | `value: joe`                            |
| `parameters[].required: true`                 | cannot be overridden with empty; must have value/generator otherwise supply at process time       |                                         |
| `parameters[].generate: expression` + `from:` | generate value: `[a-zA-Z0-9]{12}`, plus `\w`/`\d`/`\a`/`\A` classes                               | random webhook secret                   |
| `message`                                     | text shown to user; may reference parameters                                                      |                                         |

Also documented: a fixed `metadata.namespace` on template objects is stripped at instantiation; if it contains a parameter reference, substitution happens and the object is created in that namespace (requires permission). [R7]

Template extras (documented, optional for game): `template.openshift.io/bindable: "false"`; expose annotations `template.openshift.io/expose-<key>: "{.jsonpath}"` and `template.openshift.io/base64-expose-<key>` on ConfigMap/Secret/Service/Route; `template.alpha.openshift.io/wait-for-ready: "true"` on Build/BuildConfig/Deployment/DeploymentConfig/Job/StatefulSet to delay creation completion until ready (1-hour timeout). [R7]

### 6.4 Create a template from existing objects (classic exam task)

```bash
oc get -o yaml all > all.yaml       # docs warn: prefer explicit resource types over `all`
# then wrap/extend: add kind: Template / apiVersion: template.openshift.io/v1 / parameters / objects:
```

Docs list the kinds returned by `oc get -o yaml all` as `BuildConfig, Build, DeploymentConfig, ImageStream, Pod, ReplicationController, Route, Service` (legacy list; not recommended for reuse because it varies by cluster/version). [R7]

### 6.5 Project templates vs application templates (do not conflate)

| Concept                                            | What it is                                                                                                                   | Command / object                                                                                                                                                                                 | Source    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Application template                               | Parameterised object list a user instantiates with `oc process`/`oc new-app --template`                                      | `template.openshift.io/v1` Template                                                                                                                                                              | [R7][R38] |
| Project template (a.k.a. project request template) | Template in `openshift-config` used by the API server to provision **new projects** (quota/limitrange/rolebindings defaults) | `project.config.openshift.io/cluster` → `spec.projectRequestTemplate.name`; params `PROJECT_NAME`, `PROJECT_DISPLAYNAME`, `PROJECT_DESCRIPTION`, `PROJECT_ADMIN_USER`, `PROJECT_REQUESTING_USER` | [R6]      |

Game rule: the "configure project templates" V422 objective is the **project request template**; "deploy applications from templates" is the application Template. Both should be separate levels/incidents.

---

## 7. Operators / OLM (V422-explicit: install, uninstall, delete)

### 7.1 Classic OLM object model (what EX280 tests)

| Object                        | API                             | Short name | Role                                                                                                     | Source     |
| ----------------------------- | ------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| `ClusterServiceVersion` (CSV) | `operators.coreos.com/v1alpha1` | `csv`      | versioned metadata + install strategy for one Operator version; the installed "operator instance" record | [R26]      |
| `CatalogSource`               | `operators.coreos.com/v1alpha1` | `catsrc`   | repository of CSVs/CRDs/packages (OperatorHub catalog)                                                   | [R26]      |
| `Subscription`                | `operators.coreos.com/v1alpha1` | `sub`      | keeps CSVs up to date by tracking a channel in a package                                                 | [R26]      |
| `InstallPlan`                 | `operators.coreos.com/v1alpha1` | `ip`       | calculated set of resources to install/upgrade a CSV; auto- or manually-approved                         | [R26]      |
| `OperatorGroup`               | `operators.coreos.com/v1`       | `og`       | configures which namespaces Operators in that namespace watch; one per namespace                         | [R26][R28] |

Docs describe OLM ("OLM classic") as the component that installs/updates Operators from catalogs; the default software catalog is served by `openshift-marketplace`-namespace CatalogSources. Install modes: `OwnNamespace`, `SingleNamespace`, `MultiNamespace`, `AllNamespaces`. **AllNamespaces** installs into `openshift-operators` (which already has an OperatorGroup named `global-operators`); `SingleNamespace` requires you to create an OperatorGroup in the target namespace. [R27][R28]

### 7.2 Install from the software catalog - CLI flow (copy-pasteable)

```bash
# 1) find the operator / catalog
oc get packagemanifests -n openshift-marketplace
oc describe packagemanifests <operator_name> -n openshift-marketplace
oc get packagemanifests <operator_name> -n openshift-marketplace -o yaml

# 2) (SingleNamespace only) create an OperatorGroup - one per namespace
cat <<'EOF' | oc apply -f -
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: my-operatorgroup
  namespace: my-namespace
spec:
  targetNamespaces:
    - my-namespace
EOF

# 3) subscribe
cat <<'EOF' | oc apply -f -
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: my-operator
  namespace: my-namespace          # openshift-operators for AllNamespaces
spec:
  channel: stable
  installPlanApproval: Automatic   # or Manual
  name: my-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF

# 4) verify
oc describe subscription my-operator -n my-namespace
oc describe operatorgroup my-operatorgroup -n my-namespace
oc get sub,csv,installplan -n my-namespace
oc get csv                                  # cluster-admin / installed operators view
```

Source: 4.22 Operators §3.2.4 "Install from the software catalog by using the CLI" (verbatim flow and example Subscription, including `config` overrides for OLM pod env/resources/tolerations/nodeSelector). [R27]

**Manual approval:** set `spec.installPlanApproval: Manual` (optionally with `startingCSV` to pin a version). OLM then creates an InstallPlan that must be approved; the documented approval path is the web console (Ecosystem → Installed Operators → Subscription → "requires approval" → Preview Install Plan → Approve). [R27][R28] ⚠️ The docs do not document a CLI approval command; by API the approval is `InstallPlan.spec.approved: true` (you can inspect with `oc get installplan -n <ns>`). For game purposes, teach the concept + console path, and only simulate a CLI patch if you verify it on the exam cluster.

**Console path (V422 "use the web console"):** Ecosystem → Installed Operators (or OperatorHub/software catalog) → choose operator → Install → pick mode/channel/approval. [R27][R28]

### 7.3 What "Manage OpenShift operators" means for EX280

V422 bullets: **Install an operator**, **Uninstall an operator**, **Delete an operator**. In practice:

1. **Install** = create/accept OperatorGroup + Subscription (or use console) → OLM creates InstallPlan → approves (automatic or manual) → CSV reaches `Succeeded` → the operator's CRDs/APIs become available.
2. **Uninstall** = remove the operator from the cluster/namespace: delete `Subscription` first, then its `ClusterServiceVersion` (and cleanup) so OLM stops reconciling and removes the operator deployment:
   ```bash
   oc get subscription.operators.coreos.com serverless-operator -n openshift-serverless -o yaml | grep currentCSV
   oc delete subscription.operators.coreos.com serverless-operator -n openshift-serverless
   oc delete clusterserviceversion serverless-operator.v1.28.0 -n openshift-serverless
   ```
   Also check copied CSVs in other namespaces (`oc get csvs -n openshift`) and the OperatorGroup/RBAC leftovers. Source: 4.22 Operators §4.3.2 (CLI deletion). [R28]
3. **Delete an operator** can also mean deleting the **operand** (the custom resource the operator manages), e.g. `oc delete etcdcluster my-cluster -n my-etcd`, without removing the operator itself. The game should distinguish "delete operator (uninstall CSVs/Subscription)" from "delete operator instance (CR)". [R28][R7]

**Uninstall caveat (incident seed):** docs warn failed/incomplete uninstalls do not automatically remove created permissions and can leave namespaces stuck in `Terminating`; you must audit/remove leftover permissions and may need to refresh failed subscriptions by deleting the sub, CSV and failing jobs/configmaps in `openshift-marketplace`, then reinstalling. [R27][R28]

**Troubleshooting operators:** `oc get sub,csv,installplan -n <ns>`; CSV phase (e.g. `Succeeded`, `Installing`, `Failed`, `Pending`); `oc describe csv`; `oc get events -n <ns>`; check `openshift-marketplace` pods/jobs for image pull failures (`ImagePullBackOff` on a catalog/catalog-job → refresh subscription). [R28]

### 7.4 OLM v1 caveat (4.22)

OCP 4.22 includes **OLM v1** (GA since 4.18) with its own docs guide ("Extensions (OLM v1)"; the 4.22 Operators book has a pointer chapter). Newer cluster-extension work uses `ClusterExtension` etc.; EX280-era tasks use classic OLM objects above. Game copy should mention OLM v1 only as a "newer alternative" note, not as a required command set. [R29]

### 7.5 Operator install modifiers worth simulating (optional/realism)

- `spec.config.env[]` → environment for OLM-managed operator pod (e.g. `ARGS=-v=10`).
- `spec.config.envFrom[]`, `volumes[]`, `volumeMounts[]`, `tolerations[]`, `resources`, `nodeSelector` - all on the Subscription.
- `startingCSV` + `installPlanApproval: Manual` to pin exactly one version.
- Cloud token-auth clusters: `Manual` approval recommended; provider-specific env vars (`ROLEARN`, `CLIENTID`/`TENANTID`/`SUBSCRIPTIONID`, `AUDIENCE`/`SERVICE_ACCOUNT_EMAIL`). [R27]

---

## 8. Helm (V422-explicit: "Deploy applications from templates and Helm charts")

OCP ships a **Red Hat build of the Helm CLI** and integrates Helm into the web console (Ecosystem → Helm; install from Developer Catalog or chart URL; upgrade/rollback/delete actions on releases). The OCP docs' CLI examples cover installing a chart and listing releases; upgrades/rollbacks/deletes are documented via the web console. Standard Helm CLI commands for those operations are upstream Helm docs. [R10][R42]

```bash
helm version                                                    # verify CLI presence  [R10]
helm repo add openshift-helm-charts https://charts.openshift.io/
helm repo update
helm install example-vault openshift-helm-charts/hashicorp-vault
helm list
helm install nodejs-chart nodejs-ex-k                           # local chart  [R10]
helm lint .                                                     # chart validation  [R10]

# upstream Helm CLI equivalents of the console operations (NOT in the OCP 4.22 chapter):
helm upgrade <release> <chart> [--values values.yaml] [--set key=value]
helm rollback <release> <revision>
helm uninstall <release>            # helm delete <release> is the old spelling
helm status <release>
```

[All Helm CLI examples above: `helm version`, repo add/update, install, list, lint are quoted from 4.22 Building applications §6.3/6.4; `upgrade`/`rollback`/`uninstall` from upstream Helm docs because the OCP chapter documents those operations through the console only.]

Verified OCP Helm facts for game content:

- Install from **chart URL**: chart URL may use `oci://` for OCI registries (e.g. `oci://quay.io/org/repo/chart-name`); direct-URL install bypasses Developer Catalog validation (warning in docs). [R10]
- Console path: **Ecosystem → Helm**; Helm releases appear with status `Deployed`; actions include Upgrade, Rollback (revision picker), Delete. [R10]
- Helm charts on OpenShift can create `DaemonSet, CronJob, Pod, Deployment, DeploymentConfig` workloads; resources are then visible in Topology/Workloads. [R10]
- Custom chart repos are configured with `helm repo add` + `helm repo update`; OCP console also offers repo management. [R10]

Game rule: `helm` is a separate binary/verb family - the game's command bar can expose it as an "advanced" tool (not `oc` subcommand), and incidents can hinge on "chart installed but release failed" (`helm list`, `helm status`, `oc get events`/`oc describe` of created workloads).

---

## 9. Resource management: requests/limits, quotas, LimitRange, QoS (V422-explicit self-service)

### 9.1 Requests, limits, QoS

Container resources are declared under `spec.containers[].resources`:

```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
```

QoS classes (priority order), documented verbatim: [R31]

| Priority    | Class          | Condition                                                            | Eviction behaviour                                                                |
| ----------- | -------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1 (highest) | **Guaranteed** | limits (and optionally requests) set for all resources and **equal** | terminated only if exceeding limits / system pressure with no lower-priority pods |
| 2           | **Burstable**  | requests (and optionally limits) set, and requests ≠ limits          | terminated under memory pressure when exceeding requests if no BestEffort pods    |
| 3 (lowest)  | **BestEffort** | no requests/limits at all                                            | first to be terminated                                                            |

Why the game should teach QoS: quotas interact with it (`scopes: BestEffort`), and incident scenarios ("BestEffort pod keeps getting OOM-killed under node pressure") are exam-adjacent.

### 9.2 ResourceQuota (namespace-scoped, `v1`)

**Sample compute quota** (verbatim from 4.22 docs): [R9]

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
```

**Object-count quota** (verbatim): [R9]

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: core-object-counts
spec:
  hard:
    configmaps: '10'
    persistentvolumeclaims: '4'
    replicationcontrollers: '20'
    secrets: '10'
    services: '10'
    services.loadbalancers: '2'
```

Other documented quota keys: `openshift.io/imagestreams` (ImageStream count); `requests.storage`, `<storageclass>.storageclass.storage.k8s.io/requests.storage`, `<storageclass>.storageclass.storage.k8s.io/persistentvolumeclaims`, `requests.ephemeral-storage`, `limits.ephemeral-storage`; extended resources via `requests.<ext-resource>` (e.g. `requests.nvidia.com/gpu: 1`). [R9]

**CRITICAL semantics** (very likely exam-tested): if a quota specifies `requests.cpu`/`requests.memory`, **every incoming container must make an explicit request**; if it specifies `limits.cpu`/`limits.memory`, every container must specify a limit. Otherwise pod creation is denied ("must specify limits.cpu" style error). [R9]

**Quota scopes:** `BestEffort` (only BestEffort pods), `NotTerminating` (pods with no activeDeadlineSeconds - long-running; build pods count here unless `restartPolicy: Never`), `Terminating` (pods with activeDeadlineSeconds >= 0 - includes build/deployer pods). [R9]

**Quota scopes example:** `spec.scopes: [BestEffort]`, `[NotTerminating]`, `[Terminating]`. [R9]

**Create/view quota (documented):**

```bash
oc create -f compute-resources.yaml -n demoproject
oc get quota -n demoproject
oc describe quota core-object-counts -n demoproject

# object-count quota in one command:
oc create quota test \
  --hard=count/deployments.apps=2,count/replicasets.apps=4,count/pods=3,count/secrets=4
oc describe quota test
```

Sources: [R9] §8.1.6/8.1.7; `count/<resource>.<group>` syntax is documented; an object is charged to quota at creation and usage recalculated after deletion.

### 9.3 ClusterResourceQuota (multi-project, cluster-scoped `quota.openshift.io/v1`)

Use when a cluster admin must enforce an aggregate quota across **multiple projects** selected by annotation or label (classic case: per-user quota over projects requested by that user). [R9]

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

Documented create commands (aliases: `clusterresourcequota` / `clusterquota`): [R9]

```bash
oc create clusterquota for-user \
  --project-annotation-selector openshift.io/requester=<user_name> \
  --hard pods=10 --hard secrets=20

oc create clusterresourcequota for-name \
  --project-label-selector=name=frontend \
  --hard=pods=10 --hard=secrets=20

# view quotas applied to the current project:
oc describe AppliedClusterResourceQuota
```

⚠️ Docs advise selecting **≤100 projects** per ClusterResourceQuota (quota claims lock; more can degrade API server responsiveness). [R9]

### 9.4 LimitRange (namespace-scoped, `v1`)

LimitRange sets min/max/default/ratio for `Container`, `Pod`, `openshift.io/Image`, `openshift.io/ImageStream`, `PersistentVolumeClaim`; defaults are injected into pods that omit resources; requests/limits violating min/max/ratio cause pod rejection. [R31]

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: resource-limits
spec:
  limits:
    - type: Container
      max:
        cpu: '2'
        memory: 1Gi
      min:
        cpu: 100m
        memory: 4Mi
      default: # injected as resources.limits
        cpu: 300m
        memory: 200Mi
      defaultRequest: # injected as resources.requests
        cpu: 200m
        memory: 100Mi
      maxLimitRequestRatio:
        cpu: '10'
    - type: Pod
      max:
        cpu: '2'
        memory: 1Gi
      min:
        cpu: 200m
        memory: 6Mi
    - type: openshift.io/Image
      max:
        storage: 1Gi
    - type: openshift.io/ImageStream
      max:
        openshift.io/image-tags: 20
        openshift.io/images: 30
    - type: PersistentVolumeClaim
      min:
        storage: 2Gi
      max:
        storage: 50Gi
```

```bash
oc create -f limits.yaml -n demoproject
oc get limits -n demoproject
oc describe limits resource-limits -n demoproject
oc delete limits resource-limits
```

Source: 4.22 Nodes §8.3 (LimitRange create/view/delete; sample object). [R31]

**Default injection facts for game validation:** if the pod spec omits memory or limit, the LimitRange `default`/`defaultRequest` are applied; `maxLimitRequestRatio` requires both request and limit on new containers; for PVCs the request must be within `min`/`max`. [R31]

### 9.5 "Project resource requirements" - how the objectives usually manifest

| Wording                                   | What is actually tested                                                       | Commands/objects                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Configure project resource requirements" | set requests/limits on workloads; rely on LimitRange defaults; understand QoS | `oc set resources`, `resources:` in Deployment YAML, LimitRange `default`/`defaultRequest` |
| "Configure project limit ranges"          | create/edit/verify LimitRange; reject out-of-range pods                       | `oc create -f limits.yaml`, `oc describe limits`                                           |
| "Configure project quotas"                | ResourceQuota for compute/object counts; denial messages                      | `oc create -f quota.yaml`, `oc describe quota`                                             |
| "Configure cluster resource quotas"       | ClusterResourceQuota selecting projects (annotation/label)                    | `oc create clusterquota ...`, `oc describe AppliedClusterResourceQuota`                    |
| "Configure project templates"             | project request template + quota/limits inside it                             | §2.3                                                                                       |

**Explicit defaults via project template** (documented pattern): generate the bootstrap project template, insert a ResourceQuota (including `namespace: ${PROJECT_NAME}`) before `parameters:`, upload to `openshift-config`, set `project.config.openshift.io/cluster` `spec.projectRequestTemplate.name`. [R9]

### 9.6 Quota/LimitRange failure states for incidents (very exam-like)

| Game state                         | Diagnostic                                                                  | Cause                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pod `Pending` / Forbidden          | `oc describe pod`, `oc get events`, `oc describe quota`                     | quota exhausted; or quota requires requests/limits the pod lacks                                               |
| Pod rejected at admission          | `oc get events --types=Warning`, `oc describe limitrange`                   | violates LimitRange min/max/maxLimitRequestRatio                                                               |
| New project cannot create anything | `oc describe quota -n <new>` / `oc describe clusterresourcequota`           | project template applies quota but workload doesn't set resources; or ClusterResourceQuota aggregate exhausted |
| Deployment stuck Progressing       | `oc rollout status`, `oc describe deployment`, `oc get rs`, `oc get events` | `FailedCreate` due to quota/limitrange                                                                         |

Sources: [R9], [R31], [R4] (events/describe), [R8] (rollout status).

---

## 10. Jobs, CronJobs, DaemonSets, StatefulSets (V422: Jobs + CronJobs explicit; DS/STS supporting)

### 10.1 Job (`batch/v1`) - V422-explicit "deploy jobs to perform one-time tasks"

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  parallelism: 1
  completions: 1
  activeDeadlineSeconds: 1800
  backoffLimit: 6
  ttlSecondsAfterFinished: 100
  template:
    metadata:
      name: pi
    spec:
      containers:
        - name: pi
          image: perl
          command: ['perl', '-Mbignum=bpi', '-wle', 'print bpi(2000)']
      restartPolicy: OnFailure
```

Documented field semantics: `parallelism` (default 1), `completions` (default 1; fixed-count parallel = set), `activeDeadlineSeconds` (max duration, from first scheduled pod), `backoffLimit` (default 6; exponential backoff capped at 6m), `ttlSecondsAfterFinished` (auto-delete after completion; 0 = immediately). `restartPolicy` ∈ Never / OnFailure / Always per docs list; docs also state the _known limitation_ that the job spec restart policy applies to pods only - the job controller is hard-coded to keep retrying to completion, so `Never` and `OnFailure` behave the same for the job controller, with `Never` creating a new pod per failure while `OnFailure` restarts in place. [R30]

```bash
oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'
oc create -f job.yaml
oc get jobs
oc describe job pi
oc logs job/pi
oc delete job pi
oc create job test-job --from=cronjob/a-cronjob     # manual run of a CronJob's job template
```

Source: [R4] (`oc create job`, incl. `--from=cronjob`), [R30] (Job creation/fields).

### 10.2 CronJob (`batch/v1`) - V422-explicit "configure Kubernetes cron jobs"

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pi
spec:
  schedule: '*/1 * * * *'
  timeZone: Etc/UTC
  concurrencyPolicy: 'Replace' # Allow | Forbid | Replace
  startingDeadlineSeconds: 200
  suspend: true
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            parent: 'cronjobpi'
        spec:
          containers:
            - name: pi
              image: perl
              command: ['perl', '-Mbignum=bpi', '-wle', 'print bpi(2000)']
          restartPolicy: OnFailure
```

Documented field semantics: `schedule` cron format; `timeZone` (valid tz names; default = controller manager local time); `concurrencyPolicy` Allow (default) / Forbid / Replace; `startingDeadlineSeconds` (missed starts counted as failed); `suspend` (true suspends subsequent runs); `successfulJobsHistoryLimit` default 3; `failedJobsHistoryLimit` default 1; `jobTemplate` as Job. Docs warn cron jobs may create zero or two jobs around a schedule time → **jobs must be idempotent** and history limits configured. [R30]

```bash
oc create cronjob pi --image=perl --schedule='*/1 * * * *' -- perl -Mbignum=bpi -wle 'print bpi(2000)'
oc get cronjobs
oc describe cronjob pi
oc delete cronjob/pi          # also stops future artifacts
```

Also: suspend/resume by editing `spec.suspend`; jobs created by a CronJob are named `<cronjob>-<timestamp/suffix>`; prune history with the two limits. [R30]

### 10.3 DaemonSet (`apps/v1`) - background/supporting

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hello-daemonset
spec:
  selector:
    matchLabels:
      name: hello-daemonset
  template:
    metadata:
      labels:
        name: hello-daemonset
    spec:
      nodeSelector:
        role: worker
      containers:
        - name: registry
          image: openshift/hello-openshift
          imagePullPolicy: Always
          ports:
            - containerPort: 80
              protocol: TCP
```

Documented caveats: **DaemonSet scheduling is incompatible with a project's default node selector** - disable it for the namespace first (`oc patch namespace myproject -p '{"metadata":{"annotations":{"openshift.io/node-selector":""}}}'` or `oc adm new-project <name> --node-selector=""`); changing a DaemonSet's pod template does **not** update existing pods (delete pods or nodes to force recreation); deleting/recreating with the same selector can leave old pods. [R30]

```bash
oc create -f daemonset.yaml
oc get pods -o wide
oc describe pod/hello-daemonset-xxxxx | grep Node
oc rollout status daemonset/foo
oc rollout restart daemonset/abc
```

### 10.4 StatefulSet (`apps/v1`) - background/supporting (docs gap flagged)

⚠️ OCP 4.22 has **no dedicated StatefulSet prose chapter**; it references StatefulSets in deployments/templates/images docs and documents `oc scale --replicas=3 statefulset/web`, `oc set triggers statefulset/db --from-image=...`, and image-stream triggers for StatefulSets. Use upstream Kubernetes docs for the object itself. [R4][R24][R40]

Minimal shape (upstream-verified; storage details in sibling doc):

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: web # headless Service (clusterIP: None)
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: quay.io/example/web:1
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 1Gi
```

Facts to model: each pod gets a stable name/identity (`web-0`, `web-1`, …), ordered create/scale-down, one PVC per replica from `volumeClaimTemplates`, and a **headless Service** for stable network identity. `oc scale statefulset/web --replicas=3` is documented; `oc rollout status/undo` work with StatefulSets in the CLI (docs demonstrate `oc rollout status daemonset/foo`; same family of commands). [R40][R4]

---

## 11. Authentication/authorization quick reference for V422 (practical half)

> SCCs, privileged workloads, secrets and the RBAC theory deep-dive are in the sibling `openshift-networking-security-storage.md` (§6, §7). This section is the **HTPasswd → users → groups → permissions** flow the workloads game needs, with copy-pasteable commands.

### 11.1 HTPasswd identity provider - end-to-end (the canonical EX280 task)

```bash
# 1) create/patch the htpasswd file (httpd-tools package provides htpasswd)
htpasswd -c -B -b users.htpasswd <username> <password>       # create with first user
htpasswd -B -b users.htpasswd <username> <password>          # add/update users
htpasswd -D users.htpasswd <username>                        # delete a user

# 2) create the secret in openshift-config (key MUST be named "htpasswd")
oc create secret generic htpass-secret \
  --from-file=htpasswd=<path_to_users.htpasswd> -n openshift-config

# 3) register the identity provider in the cluster OAuth config
oc apply -f htpasswd-oauth.yaml

# 4) log in and verify
oc login -u <username>
oc whoami
```

```yaml
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
```

**Add/patch users later (documented pattern):**

```bash
htpasswd -bB users.htpasswd <username> <password>
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd \
  --dry-run=client -o yaml -n openshift-config | oc replace -f -
```

**Remove a user:** update the file/secret **and** delete the OpenShift records - otherwise the user's existing token keeps working until it expires:

```bash
oc delete user <username>
oc delete identity my_htpasswd_provider:<username>
```

**OAuth rollout gotcha:** changing the OAuth configuration triggers the authentication cluster operator to roll out new OAuth server pods; the documented pattern is to watch `oc get clusteroperators authentication` until `PROGRESSING` is `False` (docs use exactly this in an OAuth token-config procedure). Users/logins may fail until the rollout completes - a great "wait for infrastructure" game mechanic. [R33]

Source for all HTPasswd material: 4.22 Authentication and authorization §7.1 (create htpasswd file, create secret, sample `OAuth` CR, add identity provider, update users). [R33]

### 11.2 Users and groups

| Task                                                           | Command                                                                         | Source    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| Users are created automatically on first login from an IdP     | -                                                                               | [R35]     |
| Manually create a user (only when automatic creation disabled) | `oc create user ajones --full-name="Adam Jones"`                                | [R4]      |
| List users / describe                                          | `oc get users` · `oc get user <name> -o yaml`                                   | [R4][R35] |
| Create a group with users                                      | `oc adm groups new my-group user1 user2` · `oc adm groups new my-group` (empty) | [R4]      |
| Add users to a group                                           | `oc adm groups add-users my-group user1 user2`                                  | [R4]      |
| Remove users from group / prune                                | `oc adm groups remove-users`, `oc adm groups prune`                             | [R4]      |
| Delete a group                                                 | `oc delete group <name>` (standard delete; Group is `user.openshift.io/v1`)     | [R35][R4] |
| Group YAML                                                     | `apiVersion: user.openshift.io/v1`, `kind: Group`, `users: [ ... ]`             | [R35]     |
| Identity object (for HTPasswd)                                 | `oc delete identity my_htpasswd_provider:<user>`                                | [R33]     |

Virtual groups that matter: `system:authenticated` (all authenticated users), `system:authenticated:oauth` (OAuth-token users; self-provisioning bootstrap group), `system:unauthenticated`. [R35][R6]

### 11.3 Role bindings / permissions

```bash
# project-scoped
oc adm policy add-role-to-user admin alice -n joe
oc adm policy add-role-to-user view bob
oc adm policy add-role-to-group edit devs -n joe
oc adm policy remove-role-from-user admin alice -n joe
oc adm policy remove-user bob -n joe

# cluster-scoped
oc adm policy add-cluster-role-to-user cluster-admin <user>
oc adm policy add-cluster-role-to-group cluster-admin cluster-admins
oc adm policy remove-cluster-role-from-user <role> <user>

# introspection / verification
oc describe rolebinding.rbac -n joe
oc auth can-i create pods
oc auth can-i list pods --as=system:serviceaccount:dev:foo -n prod
oc adm policy who-can <verb> <resource>
```

RoleBinding YAML (equivalent to `add-role-to-user`): [R34]

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: admin-0
  namespace: joe
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: alice
```

Built-in project roles: `admin`, `edit`, `view`; cluster role `cluster-admin` = full control. [R34]

### 11.4 Service accounts and API access (V422 "configure application access to Kubernetes APIs")

```bash
oc create serviceaccount myapp-sa
oc get sa
oc describe sa/myapp-sa
oc create token myapp-sa [--duration 10m] [--audience ...]     # bound service account token
oc set serviceaccount deployment/myapp myapp-sa
oc adm policy add-role-to-user view -z myapp-sa -n myns         # -z = serviceaccount in current project
```

A pod using a non-default SA runs with that SA's API permissions; the deployed pod automatically gets a projected service-account token. For privileged/API-connected apps the game pairs `serviceAccountName` + a RoleBinding + (for privileged/SCC) the sibling doc's SCC steps. [R4][R35]

---

## 12. End-to-end exam-style lab flows (use as campaign level blueprints)

Each lab has: setup → steps (with the exact commands) → verification → traps to seed as incidents. All commands are doc-verified per the section citations.

### L1 - Declarative deployment, rollout, rollback, scale, resource guardrails (V422 groups 1-4, 7)

**Goal:** deploy an app from YAML, update it, roll it back, scale it, and prove quota/limitrange enforcement.

```bash
oc new-project app-lab
oc apply -f myapp-deploy.yaml                       # apps/v1 Deployment, 1 replica, image :v1, resources set
oc rollout status deployment/myapp
oc get rs,pods -l app=myapp

# update image/replicas
oc set image deployment/myapp myapp=quay.io/example/myapp:v2
oc rollout status deployment/myapp
oc rollout history deployment/myapp

# rollback (Deployment path)
oc rollout undo deployment/myapp
oc rollout status deployment/myapp

# scale + inspect RS
oc scale deployment/myapp --replicas=3
oc get rs -l app=myapp
oc describe deployment/myapp

# verify exposed service (sibling networking doc covers Service/Route)
oc expose service myapp
oc get route
```

**Verification:** `oc get deployment/myapp -o yaml` shows the original image after undo; RS list shows old/new revisions with 0/3 replicas; `oc get events` clean.

**Traps:** editing the Deployment's `spec.selector` (immutable → API error; rebuild object); `oc rollout undo` on a Deployment without history (fresh create → error); forgetting `--to-revision` semantics; applying YAML with a selector that doesn't match template labels (API rejection); changing `spec.replicas` via `oc patch` with wrong subresource path.

### L2 - Build → ImageStream → Deployment image-change trigger (OpenShift background, exam-realistic)

**Goal:** source-to-image build, follow logs, inspect tags/digests, and wire an image-change trigger to a Deployment.

```bash
oc new-project build-lab
oc new-app https://github.com/sclorg/cakephp-ex       # creates BC, IS, Deployment, Service
oc get bc,is,deploy
oc start-build cakephp-ex --follow
oc logs -f bc/cakephp-ex
oc describe is/cakephp-ex                             # tags → digest, pull spec
oc describe istag/cakephp-ex:latest
oc get istag/cakephp-ex:latest -ojsonpath="{range .image.dockerImageManifests[*]}{.os}/{.architecture}{'\n'}{end}"

# wire image change to a Kubernetes Deployment (annotation via oc set triggers)
oc set triggers deployment/cakephp-ex --from-image=cakephp-ex:latest -c cakephp-ex

# rebuild and watch the Deployment roll
oc start-build cakephp-ex --follow
oc rollout status deployment/cakephp-ex
```

**Verification:** new Build → new ImageStream tag digest → Deployment annotation `image.openshift.io/triggers` → new ReplicaSet.

**Traps:** build fails (`oc logs build/...`), webhook trigger doesn't fire because `system:unauthenticated` isn't bound to `system:webhook`; binary build can't be image-change-triggered; image-pull BackOff because the internal-registry pull secret is missing; `oc new-app` produced a DeploymentConfig (legacy) instead of a Deployment - verify with `oc get deploy,dc`.

### L3 - Template + project template + quota/limitrange (V422 self-service)

**Goal:** process an application template, create a project template that bootstraps quota+limits for every new project.

```bash
# A) application template flow
oc new-project tmpl-lab
oc create -f my-template.yaml -n tmpl-lab
oc process --parameters my-template
oc process my-template -p SOURCE_REPOSITORY_URL=https://github.com/sclorg/cakephp-ex | oc create -f -
oc get all

# B) project template with quota + limitrange
oc adm create-bootstrap-project-template -o yaml > project-template.yaml
# edit: prepend ResourceQuota (namespace: ${PROJECT_NAME}) and LimitRange objects before `parameters:`
oc create -f project-template.yaml -n openshift-config
oc edit project.config.openshift.io/cluster      # spec.projectRequestTemplate.name: project-request
oc new-project quota-lab                          # must now fail to admit pods w/o resources if quota demands them
oc describe quota -n quota-lab
oc describe limits -n quota-lab
```

**Verification:** `oc process -f` renders all `${PARAM}` substitutions; objects appear in the project; a new project has quota/limits immediately.

**Traps:** template parameters not substituted (`${...}` left literal), wrong namespace in ResourceQuota inside project template, project template not named correctly in `projectRequestTemplate`, `oc process` without `oc create -f -` (nothing created).

### L4 - Operator install, verify, manual approval, uninstall (V422 operators group)

**Goal:** install an operator from the catalog with a Subscription, verify CSV/InstallPlan, exercise manual approval, then uninstall.

```bash
oc get packagemanifests -n openshift-marketplace | head
oc describe packagemanifests <operator> -n openshift-marketplace      # install modes + channels
# create OperatorGroup (SingleNamespace) + Subscription (see §7.2 YAML)
oc apply -f operatorgroup.yaml
oc apply -f subscription.yaml
oc get sub,csv,installplan -n <ns>
oc describe subscription <name> -n <ns>
oc describe csv <name> -n <ns>
# manual approval exercise: set installPlanApproval: Manual, create new sub version, approve via console or InstallPlan.spec.approved
# uninstall
oc delete subscription.operators.coreos.com <name> -n <ns>
oc delete clusterserviceversion <csv> -n <ns>
oc get csvs -n openshift
```

**Verification:** CSV phase `Succeeded`; operator pods in the namespace; after uninstall the CSV/Subscription are gone and copies in other namespaces are removed/ignored.

**Traps:** missing OperatorGroup with SingleNamespace; one-OG-per-namespace limit; subscription in `openshift-operators` watching global namespaces when SingleNamespace intended; failed uninstall leaving namespace `Terminating`; forgetting to delete CSV after Subscription.

### L5 - Kustomize overlays + manifest import/export (V422 declarative group)

**Goal:** deploy base+overlay with `oc apply -k`; export and re-import the live object.

```bash
oc new-project kustomize-lab
oc apply -k overlays/dev
oc kustomize overlays/dev | oc apply -f -
oc get deploy -n kustomize-lab
oc get deployment/myapp -n kustomize-lab -o yaml > live.yaml
oc apply -f live.yaml
oc diff -f live.yaml
oc delete -k overlays/dev
```

**Verification:** namePrefix/namespace/images from the overlay appear on rendered objects (`oc kustomize overlays/dev` compares to `oc get ... -o yaml`).

**Traps:** wrong overlay path; missing kustomization.yaml; `oc apply -f overlays/dev` (file mode) instead of `-k`; base/overlay selector conflicts.

### L6 - Jobs + CronJobs (V422 application security group)

**Goal:** run a one-off Job and a CronJob, inspect history, run one Job from the CronJob template, suspend/delete.

```bash
oc new-project jobs-lab
oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'
oc get jobs,pods
oc logs job/pi
oc create -f cronjob.yaml
oc get cronjobs
oc create job manual-run --from=cronjob/pi
oc describe cronjob pi
oc edit cronjob pi            # spec.suspend: true
oc delete cronjob/pi
```

**Verification:** Job `Complete`; CronJob schedules child Jobs; `--from=cronjob` creates a Job using the cron template; deleting the CronJob stops future artifacts.

**Traps:** wrong `restartPolicy` (jobs need Never/OnFailure); CronJob history limits filling etcd (students forget `successfulJobsHistoryLimit`); non-idempotent jobs (docs warn); quota denying Job pods (only applies to non-terminal pods + Terminating scopes).

### L7 - HTPasswd user/group/permission flow (V422 authn/authz)

**Goal:** add an HTPasswd provider, create users, change a password, put users in a group, grant project permissions.

```bash
htpasswd -c -B -b users.htpasswd alice <pass1>
htpasswd -B -b users.htpasswd bob <pass2>
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config
oc apply -f htpasswd-oauth.yaml
oc get clusteroperators authentication       # wait PROGRESSING False
oc login --username=alice --password=<pass1>
oc whoami
oc get users
oc adm groups new devs alice bob
oc adm policy add-role-to-group edit devs -n app-lab
oc auth can-i create pods -n app-lab
# password change
htpasswd -bB users.htpasswd alice <newpass>
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd \
  --dry-run=client -o yaml -n openshift-config | oc replace -f -
```

**Verification:** `oc login -u alice` works after OAuth rollout; `oc get users` shows auto-created User objects; `oc auth can-i` reflects group role binding; old password rejected, new accepted.

**Traps:** secret key must be `htpasswd`; OAuth pods not restarted yet; user removed from file but `oc delete user/identity` not run (token still valid); wrong namespace for the secret (`openshift-config`); `oc adm policy add-role-to-user` vs `add-cluster-role-to-user`.

---

## 13. Game-conversion hooks (for the content/engine authors)

### 13.1 Command-bar verbs this document legitimises

| Command family     | Minimum grammar the game should accept                                                                                                                                                                                                                                                                                                                                                   | First implementation priority                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Session/project    | `oc login`, `oc logout`, `oc whoami`, `oc project [name]`, `oc projects`, `oc new-project <name> [--description --display-name]`, `oc delete project <name>`, `oc status [--suggest]`                                                                                                                                                                                                    | P0 (onboarding/tutorial)                          |
| Read/format/filter | `oc get <type> [name] [-n ns] [-A] [-o wide\|yaml\|json\|name\|jsonpath=...] [-l sel] [--show-labels] [--field-selector ...]`, `oc describe <type>/<name>`, `oc explain ...`, `oc api-resources`, `oc events [--all-namespaces --for ... --types=Warning]`                                                                                                                               | P0 (inspector panel + incidents)                  |
| Declarative        | `oc apply -f <file\|->`, `oc apply -k <dir>`, `oc create -f <file\|->`, `oc replace -f <file> [--force]`, `oc patch <type>/<name> -p '<json>' [--type merge\|json]`, `oc edit <type>/<name>`, `oc delete <type>/<name> [-l sel] [-f file] [-k dir]`, `oc diff -f`, `oc get ... -o yaml > file` (export affordance)                                                                       | P1 (manifest editor + kustomize level)            |
| Workloads          | `oc scale <deploy\|rs\|sts>/<name> --replicas=N`, `oc autoscale deployment <name> --min --max [--cpu]`, `oc rollout status\|history\|undo\|restart\|pause\|resume`, `oc set image\|env\|resources\|probe\|volumes\|serviceaccount\|triggers`, `oc debug <resource\|node>`                                                                                                                | P1 (rollout/incident engine)                      |
| Builds/images      | `oc new-app ...`, `oc new-build ...`, `oc start-build <bc> [--follow --wait --from-dir/--from-file/--from-repo/--from-build]`, `oc cancel-build`, `oc logs -f bc/<name>`, `oc describe bc/<name>`, `oc get is`, `oc describe is/istag`, `oc tag`, `oc tag -d`, `oc import-image`, `oc image info`, `oc set image-lookup`, `oc set triggers bc/... --from-github\|--from-image\|--remove` | P2 (build pipeline visualisation)                 |
| Templates          | `oc process [-f file \| <template>] [-p K=V ...] [--param-file=...] [-l ...] [--parameters] [--local]`, pipe to `oc create -f -`, `oc new-app --template=<t> -p K=V`, `oc new-app -f <file>`, `oc get templates -n openshift`, `oc create -f <template>`                                                                                                                                 | P2 (templates level + project-template objective) |
| Operators/OLM      | `oc get packagemanifests -n openshift-marketplace`, `oc get sub,csv,installplan,og`, `oc describe subscription\|csv\|operatorgroup`, `oc apply -f subscription.yaml\|operatorgroup.yaml`, `oc delete subscription <n> -n <ns>`, `oc delete csv <csv> -n <ns>`, `oc get csvs -n openshift`                                                                                                | P2 (operator install/uninstall level)             |
| Quotas/limits      | `oc create -f quota\|limitrange.yaml`, `oc create quota <name> --hard=...`, `oc create clusterquota <name> --project-annotation-selector=... --hard ...`, `oc get/describe quota`, `oc get/describe limits`, `oc describe AppliedClusterResourceQuota`                                                                                                                                   | P1 (self-service + incident engine: quota denial) |
| Jobs               | `oc create job <name> --image=... [-- <cmd>]`, `oc create job <n> --from=cronjob/<cj>`, `oc create cronjob <n> --image=... --schedule='...' -- <cmd>`, `oc get/describe jobs,cronjobs`, `oc delete job\|cronjob`                                                                                                                                                                         | P2 (one-time task levels)                         |
| Helm               | separate `helm` surface: `helm version`, `helm repo add`, `helm repo update`, `helm install`, `helm list`, `helm upgrade\|rollback\|uninstall` (label as "Helm CLI; OCP docs demonstrate upgrade/rollback/delete in console")                                                                                                                                                            | P3 (advanced level)                               |

### 13.1b Web console paths (V422: "use the web console")

The exam includes web-console tasks, so game levels/flags that claim "console path" should use the 4.22 navigation names. Verified paths from the 4.22 docs:

| Task                                                                | Console path                                                                                  | Source     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| Projects / project overview, details, YAML, workloads, rolebindings | **Home → Projects** → select project (tabs: Overview, Details, YAML, Workloads, RoleBindings) | [R6]       |
| Project template / project config / OAuth config                    | **Administration → Cluster Settings → Configuration** → Project / OAuth → Edit YAML           | [R6][R33]  |
| Installed Operators / operator install                              | **Ecosystem → Installed Operators** (OperatorHub/software catalog for new installs)           | [R27][R28] |
| Helm releases                                                       | **Ecosystem → Helm** (install from Developer Catalog or chart URL; upgrade/rollback/delete)   | [R10]      |
| Builds                                                              | **Builds** page (Form/YAML edit of BuildConfig)                                               | [R14]      |
| Developer add/import                                                | **+Add** (Git import, container image, Helm chart, templates, etc.)                           | [R5][R7]   |
| General console reference                                           | web console book                                                                              | [R44]      |

### 13.2 Simulation-state requirements (what the engine/controllers must model)

1. **Deployment → ReplicaSet → Pod** with revision history for `rollout history/undo/--to-revision`; RSs = revision records; pod template hashes as versions.
2. **DeploymentConfig → ReplicationController** (optional/legacy level): deployer pod simulation, image-change trigger semantics, rollback disables triggers, `oc rollout latest/retry`.
3. **ImageStream store** per project: tags → image digests (immutable image IDs), tag history stack, `ImageStreamTag` vs `ImageStreamImage`, lookup policy, external imports (`oc import-image`/`oc tag --source=docker`) and build outputs writing tags.
4. **BuildConfig → Build state machine**: New → Pending → Running → Complete/Failed/Cancelled; triggers (webhook secret URL, image-change on builder tag digest, config-change at creation); binary builds accept local source only; build logs available via `oc logs -f bc/...`; postCommit failure prevents push.
5. **Template processor**: parameter substitution `${}`/`${{}}`, generators, required/default; instantiation = create objects (same validators).
6. **OLM state machine** (simplified): PackageManifest → Subscription+OperatorGroup → InstallPlan (auto/manual) → CSV phases → operator Deployment + CRDs → operands; uninstall removes Subscription → CSV → operator resources; copied CSVs across namespaces.
7. **Admission validators**: selector-match rule for Deployment/RS/DS/STS; immutable selector on update; quota `requests/limits` requirements; LimitRange min/max/default injection; resource quantity parsing (`100m`, `1Gi`).
8. **Quota accounting**: non-terminal pods count toward pod quota and sum requests/limits; object-count quota on create; `count/<resource>.<group>`; scopes BestEffort/Terminating/NotTerminating; ClusterResourceQuota aggregate across selected projects.
9. **Job/CronJob controllers**: Job completion/backoff/TTL; CronJob schedule tick, concurrency policy, history limits, `--from=cronjob` manual instantiation.
10. **Auth/RBAC simulation**: users auto-created on first successful IdP login, groups, role bindings (`admin/edit/view/cluster-admin`), `oc auth can-i`/`oc adm policy who-can`; HTPasswd file → secret → OAuth provider with rollout delay.
11. **Kustomize renderer**: base/overlay merge for `resources`, `namespace`, `namePrefix`, `commonLabels`, `images`, `patchesStrategicMerge` (strategic merge patch semantics).
12. **Helm renderer**: chart → rendered manifests → release object; `helm list` status; upgrade/rollback produce new revision; uninstall deletes tracked resources.

### 13.3 Incident seeds (each maps to a real documented failure mode)

| Incident seed                                   | Repro command                                                                                      | Root cause / fix                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ImagePullBackOff` on Deployment                | `oc describe pod`, `oc events`                                                                     | wrong image/tag or missing pull secret/internal registry auth               |
| Rollout stuck / `Progressing=False`             | `oc rollout status`, `oc describe deploy`, `oc get rs`, `oc get events`                            | readiness probe failing, quota `FailedCreate`, unschedulable, bad selector  |
| Liveness loop → CrashLoopBackOff                | `oc logs -p`, `oc describe pod`                                                                    | liveness probe too aggressive / wrong path/port; fix probe                  |
| Service has no endpoints                        | `oc get endpoints`, `oc get pods --show-labels`                                                    | selector mismatch label                                                     |
| Build failed                                    | `oc logs build/<n>`, `oc describe build`                                                           | git/source secret, assemble script, test failure, quota for build pod       |
| Webhook doesn't trigger                         | `oc describe bc` (URLs), `oc get rolebinding system:webhook -n ns`                                 | system:unauthenticated not bound to system:webhook since 4.16               |
| Image-change trigger never fires                | `oc get bc/<n> -o yaml` / `oc get deployment/<n> -o yaml` (triggers+annotations), `oc describe is` | tag not updated; binary build; wrong istag name/namespace                   |
| Quota denial on scale-out                       | `oc describe quota`, events                                                                        | requests/limits missing or aggregate quota exhausted                        |
| LimitRange rejection                            | `oc describe limits`, events                                                                       | pod below `min`/above `max` or missing request                              |
| Project cannot create anything                  | `oc describe quota`, `oc describe clusterresourcequota`                                            | quota inherited via project template but workloads don't set resources      |
| Operator CSV `Failed`/`Pending`                 | `oc get sub,csv,installplan`, `oc describe csv`                                                    | missing OperatorGroup, catalog image pull failure, manual approval pending  |
| Operator uninstall leaves namespace terminating | `oc get csvs -n openshift`, `oc get ns <ns> -o yaml`                                               | failed uninstall; audit/remove leftover permissions/resources               |
| HTPasswd login broken                           | `oc get clusteroperators authentication`, `oc get oauth cluster -o yaml`                           | OAuth rollout in progress; wrong secret key/name; secret in wrong namespace |
| Removed user still works                        | `oc get users`, `oc get identity`                                                                  | forgot `oc delete user`/`oc delete identity`                                |
| CronJob storm                                   | `oc get jobs`, `oc get cronjobs`                                                                   | missing history limits / bad schedule / concurrencyPolicy not set           |
| BestEffort pod evicted                          | `oc get pod -o yaml` (qosClass), `oc describe node`                                                | no requests/limits → BestEffort; add resources or LimitRange defaults       |

### 13.4 Content accuracy rules (do not violate when writing levels)

- Use `apiVersion: apps/v1` for Deployment/ReplicaSet/DaemonSet/StatefulSet; `batch/v1` for Job/CronJob; `v1` for Service/ConfigMap/Secret/ResourceQuota/LimitRange/Pod; `build.openshift.io/v1` for BuildConfig; `image.openshift.io/v1` for ImageStream; `apps.openshift.io/v1` for DeploymentConfig (legacy); `route.openshift.io/v1` for Route (sibling doc); `template.openshift.io/v1` for Template; `operators.coreos.com/v1alpha1` for Subscription/CSV/InstallPlan; `operators.coreos.com/v1` for OperatorGroup; `quota.openshift.io/v1` for ClusterResourceQuota; `project.openshift.io/v1` for Project (cluster-scoped); `user.openshift.io/v1` for User/Group; `config.openshift.io/v1` for OAuth/Project/Image config.
- `oc new-app`/`oc new-build` may render `oc status`-style legacy output; game should show Deployments unless scenario explicitly teaches DC.
- Flag deprecations in-game: DeploymentConfig (deprecated), Pipeline build strategy (deprecated), Cluster Samples Operator (deprecated), `oc export` (removed - do not accept).
- `oc rollout undo` ≠ `oc rollback`: the latter is DC-only; a Deployment rollback must use `oc rollout undo`.
- `oc logs -f deploy/<name>` is documented as `oc logs deployment/ruby`; keep the resource form.
- Values like `200m`, `512Mi`, `1Gi`, replicas integers; quoted strings in YAML (`"2"`, `"20%"`) where docs quote them.

---

## 14. Version caveats, doc inconsistencies, and confidence notes

### 14.1 Version facts (all verified 2026-11-03)

| Fact                                                                                            | Evidence                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Latest OCP **4.x** doc set = **4.22**; `/4.23/` = HTTP 404                                      | `docs.redhat.com/.../4.22` HTTP 200, `/4.23` 404; docs root/version selector lists 4.22 and **5.0**                    |
| A **5.0** docs set is published and is what the docs root defaults to                           | fetched `docs.redhat.com/.../5.0` HTTP 200; version selector on every 4.22 page shows "5.0 4.22 4.21 …"                |
| EX280 is **based on 4.22** in the current exam version                                          | exam page: "This exam is based on Red Hat® OpenShift® Container Platform 4.22." [R1]; LMS PDF section `EX280V422` [R2] |
| OCP 4.22 uses **Kubernetes 1.35** with CRI-O                                                    | 4.22 release notes [R36]                                                                                               |
| DeploymentConfig: Deprecated (4.20/4.21/4.22 tracker); deprecation text since 4.14              | [R8][R36]                                                                                                              |
| Cluster Samples Operator: Deprecated; S2I builder streams/templates keep updating until removal | [R21][R36]                                                                                                             |
| Pipeline build strategy: deprecated                                                             | [R12]                                                                                                                  |
| OLM v1 GA (since 4.18) alongside classic OLM; separate docs guide                               | [R29]                                                                                                                  |
| Shipwright "Builds" documented as separate product doc set                                      | [R43]                                                                                                                  |

### 14.2 Where the 4.22 docs are internally inconsistent (do not copy blindly)

| Inconsistency                                                                                                                                                                                          | Resolution chosen in this doc                                                                                                                     | Confidence              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `oc new-app` output table says it creates **DeploymentConfig**, while the CLI has `--as-deployment-config` and the 4.22 docs' own examples must pass `--as-deployment-config=true` to get DC behaviour | Treat **Deployment as default**, DC as opt-in legacy; verify with `oc new-app --help` on the exam-like cluster before hard-coding game validation | Medium-High             |
| `oc status` sample output shows `dc/cakephp-ex` for a modern `oc new-app`                                                                                                                              | Legacy sample text; game renders `deploy/...`                                                                                                     | Medium                  |
| `oc get -o yaml all` documented kind list includes DeploymentConfig/RC and not Deployments/Jobs                                                                                                        | Legacy list; docs themselves call `all` unreliable; game should support explicit resource lists and only loosely model `all`                      | High (that it's legacy) |
| `oc describe is` sample shows old registry host `docker-registry.default.svc:5000`; other 4.22 pages show `image-registry.openshift-image-registry.svc:5000`                                           | Use `image-registry.openshift-image-registry.svc:5000` as the internal registry host for 4.22 content; note old host appears in stale samples     | Medium                  |
| Template API examples sometimes use `apiVersion: v1` for `kind: Template`                                                                                                                              | Prefer `template.openshift.io/v1` (API reference + newer examples)                                                                                | High                    |
| Example blue-green section titled "Deployment" uses `--as-deployment-config=true` / `dc/...`                                                                                                           | Treat as legacy sample; teach route-based blue-green with Deployments                                                                             | Medium                  |
| `oc logs -f bc/<name>` (documented), `oc logs deployment/<name>` (documented), `oc logs -f deploy/<name>` (abbrev, common)                                                                             | Use documented long forms in game copy                                                                                                            | High                    |

### 14.3 Documented gaps where other sources were needed

| Gap                                                                                    | Workaround                                                                                                           | Confidence                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| No Kustomize prose chapter in 4.22 OCP docs (only CLI commands)                        | `oc apply -k`/`oc kustomize`/`oc get -k`/`oc delete -k` from CLI reference + upstream Kubernetes Kustomize task docs | High for OCP commands; Medium for exact kustomize schema strictness                         |
| No StatefulSet prose chapter in 4.22 OCP docs                                          | Upstream Kubernetes StatefulSet docs + OCP-documented `oc scale statefulset/web` / image triggers                    | High for commands; Medium for OCP-specific STS operational nuance                           |
| Helm upgrade/rollback/uninstall documented only via web console in OCP chapter         | Upstream Helm CLI docs for `helm upgrade`/`rollback`/`uninstall`                                                     | High for Helm CLI; Medium for "what EX280 expects" (console path is the OCP-documented one) |
| No documented CLI command to approve an InstallPlan with `installPlanApproval: Manual` | Console path documented; API-level `.spec.approved` is raw-object knowledge (⚠️ verify on cluster)                   | Medium                                                                                      |
| `oc whoami` flags (`--show-token`, `--show-context`, `--show-server`)                  | Only `oc whoami`/`-c` appear in 4.22 prose; flag list from CLI help (not quoted here as exam-critical)               | Medium                                                                                      |

### 14.4 Confidence summary

| Area                                                                                                                                                                                    | Confidence                                                                                                 | Notes                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `oc` CLI command syntax/flags used in §1, §4, §5, §9, §10, §11                                                                                                                          | **High**                                                                                                   | Every command quoted from the 4.22 CLI reference PDF/chapter; chapter URLs 200                      |
| Objects/YAML apiVersions for BuildConfig, ImageStream, Deployment, Template, OperatorGroup/Subscription/CSV, ResourceQuota/ClusterResourceQuota/LimitRange, Job/CronJob, Project, Group | **High**                                                                                                   | From 4.22 docs prose/API references (Template/Project from API pages; others from chapter examples) |
| Deprecation statuses (DC, Samples Operator, Pipeline strategy)                                                                                                                          | **High**                                                                                                   | 4.22 docs + release notes tracker tables                                                            |
| Build trigger semantics, webhook RBAC gotcha                                                                                                                                            | **High** (doc-verified)                                                                                    | builds_using_buildconfig §8                                                                         |
| Quota/LimitRange admission semantics                                                                                                                                                    | **High**                                                                                                   | 4.22 Building applications §8 + Nodes §8.3                                                          |
| OLM install/uninstall flows                                                                                                                                                             | **High** for console/CLI install + CLI uninstall; **Medium** for manual-approval CLI and OLM v1 boundaries | see §7 caveats                                                                                      |
| Kustomize overlays                                                                                                                                                                      | **Medium-High**                                                                                            | OCP commands High, kustomize schema strictness Medium (version-dependent)                           |
| Helm                                                                                                                                                                                    | **High** for documented commands; **Medium** for upgrade/rollback/uninstall CLI parity with console        |                                                                                                     |
| "What EX280 expects" beyond the objective bullet names                                                                                                                                  | **Medium** - inferred from objective wording + current 4.22 docs; no leaked exam items exist               | Do not over-fit game scoring to this                                                                |

### 14.5 Things deliberately NOT claimed

- No passing score, exam-item count, or validity period (not published on the exam page - see sibling `exam-facts.json`).
- No claim that `--image-stream`/`--code` etc. are the only flags (only those documented; full flag list from `oc new-app --help`).
- No claim that OLM v1 is examinable; no claim about future removal dates beyond "in a future release" wording in docs.
- No claim that Kustomize or StatefulSet have OCP-specific chapters in 4.22.
- No exact "default SCC" list (out of scope; sibling doc).

---

## 15. Sources (all accessed **2026-11-03**)

**Exam / objectives**

- **[R1]** Red Hat exam page - _Red Hat Certified System Administrator in OpenShift exam (EX280)_: <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>
- **[R2]** Red Hat _Exam Objectives by Version_ PDF (EX280V422 section): <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf>

**OCP 4.22 documentation (docs.redhat.com; PDF bundles downloaded and used for exact text)**

- **[R3]** OCP 4.22 documentation root: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22>
- **[R4]** CLI tools - Chapter 2, OpenShift CLI (oc) (incl. §2.6 developer and §2.7 administrator command references): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/openshift-cli-oc>
- **[R5]** Building applications (book): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index>
- **[R6]** Building applications - Projects: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/projects>
- **[R7]** Building applications - Creating applications (templates §3.1, `oc new-app` CLI §3.4, template writing §3.1.7): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/creating-applications>
- **[R8]** Building applications - Deployments (Deployment vs DeploymentConfig, triggers, strategies, scaling, rollback): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/deployments>
- **[R9]** Building applications - Quotas (ResourceQuota, ClusterResourceQuota, project template quotas): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/quotas>
- **[R10]** Building applications - Working with Helm charts: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/working-with-helm-charts>
- **[R11]** Building applications - Monitoring application health by using health checks: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/application-health>
- **[R12]** Builds using BuildConfig - Understanding build configurations: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/understanding-buildconfigs>
- **[R13]** Builds using BuildConfig - Using build strategies (Docker, S2I, Custom, Pipeline): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/build-strategies>
- **[R14]** Builds using BuildConfig - Performing and configuring basic builds: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/basic-build-operations>
- **[R15]** Builds using BuildConfig - Triggering builds and build hooks (webhooks, image-change, config-change, postCommit): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/triggering-builds-build-hooks>
- **[R16]** Builds using BuildConfig - Creating build inputs (Git/Dockerfile/binary/input secrets; S2I process): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/creating-build-inputs>
- **[R17]** Builds using BuildConfig - Managing build output: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/managing-build-output>
- **[R18]** Builds using BuildConfig - Advanced build operations (resources, deadlines, chained builds, run policy): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/advanced-build-operations>
- **[R19]** Builds using BuildConfig - Troubleshooting builds: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_buildconfig/troubleshooting-builds_build-configuration>
- **[R20]** Images - Overview of images: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/overview-of-images>
- **[R21]** Images - Managing image streams (tags/digests, describe is/istag, tag/import-image, Samples Operator deprecation): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/managing-image-streams>
- **[R22]** Images - Using images (tagging images): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/using-images>
- **[R23]** Images - Using image streams with Kubernetes resources (lookup policy, `oc set image-lookup`): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/using-imagestreams-with-kube-resources>
- **[R24]** Images - Triggering updates on image stream changes (`image.openshift.io/triggers`, Deployment/StatefulSet/DaemonSet/Job): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/triggering-updates-on-imagestream-changes>
- **[R25]** Images - Image configuration (registry hostname `image-registry.openshift-image-registry.svc:5000`): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/image-configuration-classic>
- **[R26]** Operators - Understanding Operators (OLM concepts/resources, short names): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/understanding-operators>
- **[R27]** Operators - User tasks (install operators in your namespace via CLI, Subscription/OperatorGroup, manual approval): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/user-tasks>
- **[R28]** Operators - Administrator tasks (cluster-wide install, delete Operators via CLI/console, refresh failing subscriptions): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/administrator-tasks>
- **[R29]** Operators - OLM v1 (pointer chapter; OLM v1 GA since 4.18, docs moved to Extensions guide): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/olm-v1>
- **[R30]** Nodes - Using jobs and daemon sets (Job/CronJob/DaemonSet docs): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/using-jobs-and-daemon-sets>
- **[R31]** Nodes - Working with clusters (§8.3 LimitRange, §8.4 memory, §8.5 overcommit/QoS classes, node docs): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-clusters>
- **[R32]** Nodes - Working with pods (logs by pod/resource, events): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/working-with-pods>
- **[R33]** Authentication and authorization - Configuring identity providers (§7.1 HTPasswd): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/configuring-identity-providers>
- **[R34]** Authentication and authorization - Using RBAC (role bindings, `oc adm policy`, `oc auth can-i`, `oc describe rolebinding`): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/using-rbac>
- **[R35]** Authentication and authorization - Understanding authentication (users, groups, virtual groups, Group YAML): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-authentication>
- **[R36]** Release notes - OCP 4.22 (Kubernetes 1.35; deprecated/removed trackers incl. DeploymentConfig, Cluster Samples Operator): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/release_notes/ocp-4-22-release-notes>
- **[R37]** Project APIs - Project [project.openshift.io/v1]: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/project_apis/project-project-openshift-io-v1>
- **[R38]** Template APIs - Template [template.openshift.io/v1]: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/template_apis/template-template-openshift-io-v1>
- **[R43]** Builds using Shipwright - Overview of Builds (separate product doc set): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/builds_using_shipwright/overview-openshift-builds>
- **[R44]** Web console (book; console navigation reference): <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index>

**Upstream/supplementary (only for documented gaps)**

- **[R39]** Kubernetes - Deployments (strategy/rollingUpdate defaults): <https://kubernetes.io/docs/concepts/workloads/controllers/deployment/>
- **[R40]** Kubernetes - StatefulSets: <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/>
- **[R41]** Kubernetes - Managing objects with Kustomize: <https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/>
- **[R42]** Helm - `helm upgrade` / `helm uninstall` CLI docs: <https://helm.sh/docs/helm/helm_upgrade/>, <https://helm.sh/docs/helm/helm_uninstall/>

**Verification artefacts (local, downloaded 2026-11-03, not part of the repo):** OCP 4.22 PDF bundles for CLI tools, Building applications, Builds using BuildConfig, Images, Operators, Nodes, Authentication and authorization, and Release notes (from the `pdf/<book>/OpenShift_Container_Platform-4.22-<book>-en-US.pdf` endpoints reachable from each book index); `pdftotext -layout` extraction used to quote/cross-check commands, YAML and deprecation statements. CLI tools PDF shows "Last Updated: 2026-10-28".

---

## Appendix A - One-page command cheat sheet (workloads/builds half)

```bash
# ---- session / projects ----
oc login <url> --web | oc login <url> -u U -p P
oc whoami ; oc whoami -c ; oc logout
oc project ; oc projects ; oc project <name>
oc new-project <name> --display-name="..." --description="..."
oc delete project <name>
oc status [--suggest]
oc config get-contexts ; oc config use-context <ctx>
oc config set-context `oc config current-context` --namespace=<project>

# ---- read / format / filter ----
oc get <type> [-n ns] [-A] [-o wide|yaml|json|name] [-l k=v] [--show-labels]
oc get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image
oc get deploy/<name> -o yaml > out.yaml
oc describe <type>/<name>
oc explain <resource>.<field> [--recursive]
oc events [--all-namespaces] [--for pod/<name>] [--types=Warning]
oc logs -f <pod> [-c container] ; oc logs deployment/<name> ; oc logs -f bc/<name>
oc api-resources ; oc api-versions

# ---- declarative ----
oc apply -f f.yaml | -k dir/ | -f -
oc create -f f.yaml
oc replace -f f.yaml [--force]
oc patch <type>/<name> -p '<json>' [--type=merge|json] [--subresource=scale]
oc edit <type>/<name>
oc delete <type>/<name> [-l sel] [--all] [-f f.yaml] [-k dir]
oc diff -f f.yaml
oc kustomize dir/ | oc apply -f -
oc apply -k dir/

# ---- labels / annotations ----
oc label <type>/<name> k=v [--overwrite] ; oc label <type>/<name> k-
oc annotate <type>/<name> k=v [--overwrite] ; oc annotate <type>/<name> k-

# ---- workloads ----
oc create deployment <n> --image=<img> --replicas=3 --port=8080
oc new-app <git-url> | <image> | <is>:<tag> | --template=<t> | -f <tpl>
oc scale deployment/<n> --replicas=3 ; oc autoscale deployment <n> --min=2 --max=10 --cpu=80%
oc rollout status deployment/<n> ; oc rollout history deployment/<n>
oc rollout undo deployment/<n> [--to-revision=N] ; oc rollout restart deployment/<n>
oc rollout pause|resume deployment/<n> ; oc debug deploy/<n> ; oc debug node/<node>
oc set image deploy/<n> <c>=<img> ; oc set env deploy/<n> K=V | --from=cm/<n> | --from=secret/<n>
oc set resources deploy/<n> -c=<c> --limits=cpu=200m,memory=512Mi --requests=cpu=100m,memory=256Mi
oc set probe deploy/<n> --readiness --get-url=http://:8080/healthz
oc set volume deploy/<n> --add --name=v1 -t pvc --claim-name=pvc1 --overwrite
oc set serviceaccount deploy/<n> <sa>
oc set triggers deploy/<n> --from-image=<is>:<tag> -c <container>

# ---- builds / images ----
oc new-build <git-url> | -D $'FROM ...' | --binary --name=<n> --strategy=docker
oc start-build <bc> [--follow|--wait] [--from-dir=dir|--from-file=f|--from-repo=repo --commit=ref] [--from-build=<build>] [--env=K=V]
oc cancel-build bc/<bc> ; oc logs -f bc/<bc> ; oc describe bc/<bc> ; oc describe build/<build>
oc get is ; oc describe is/<is> ; oc describe istag/<is>:<tag>
oc tag <src> <is>:<tag> ; oc tag -d <is>:<tag> ; oc tag --source=docker <img> <is>:<tag> [--scheduled]
oc import-image <is>:<tag> --from=<img> --confirm [--all] [--import-mode=PreserveOriginal]
oc image info <image> ; oc set image-lookup <is> | deploy/<n> ; oc registry login

# ---- templates / helm ----
oc get templates -n openshift
oc process -f <tpl> [-p K=V ...] [--param-file=f] [-l k=v] [--local -o yaml] [--parameters]
oc process <tpl> | oc create -f -
oc new-app --template=<tpl> -p K=V ; oc new-app -f <tpl>
helm repo add <name> <url> ; helm repo update ; helm install <rel> <chart> ; helm list

# ---- operators ----
oc get packagemanifests -n openshift-marketplace ; oc describe packagemanifests <op> -n openshift-marketplace
oc apply -f operatorgroup.yaml ; oc apply -f subscription.yaml
oc get sub,csv,installplan -n <ns> ; oc describe subscription <n> -n <ns> ; oc describe csv <n> -n <ns>
oc delete subscription <n> -n <ns> ; oc delete csv <csv> -n <ns> ; oc get csvs -n openshift

# ---- quotas / limits ----
oc create -f quota.yaml ; oc create quota <n> --hard=count/deployments.apps=2,count/pods=3,count/secrets=4
oc create clusterquota <n> --project-annotation-selector=<k>=<v> --hard pods=10 --hard secrets=20
oc get quota ; oc describe quota <n> ; oc get limits ; oc describe limits <n> ; oc describe AppliedClusterResourceQuota

# ---- jobs / cronjobs ----
oc create job <n> --image=<img> [-- <cmd>] ; oc create job <n> --from=cronjob/<cj>
oc create cronjob <n> --image=<img> --schedule='*/1 * * * *' -- <cmd>
oc get jobs,cronjobs ; oc logs job/<n> ; oc delete job <n> ; oc delete cronjob <n>

# ---- users / groups / RBAC ----
htpasswd -c -B -b users.htpasswd <user> <pass> ; htpasswd -B -b users.htpasswd <user> <pass>
oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config
oc adm policy add-role-to-user <role> <user> -n <ns> ; oc adm policy add-cluster-role-to-user <role> <user>
oc adm groups new <g> [users...] ; oc adm groups add-users <g> <u1> <u2>
oc auth can-i <verb> <resource> [--as=...] ; oc describe rolebinding.rbac -n <ns>
oc create serviceaccount <sa> ; oc create token <sa> ; oc set serviceaccount deploy/<n> <sa>
```

## Appendix B - API group/version quick table

| Kind                                                                                                                     | apiVersion                      | Notes                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------- |
| Deployment, ReplicaSet, DaemonSet, StatefulSet                                                                           | `apps/v1`                       | workloads                 |
| ReplicationController, Pod, Service, ConfigMap, Secret, ResourceQuota, LimitRange, PersistentVolumeClaim, ServiceAccount | `v1`                            | core                      |
| Job, CronJob                                                                                                             | `batch/v1`                      | one-time/scheduled        |
| BuildConfig                                                                                                              | `build.openshift.io/v1`         | builds                    |
| Build                                                                                                                    | `build.openshift.io/v1`         | runtime build object      |
| ImageStream, ImageStreamTag, ImageStreamImage                                                                            | `image.openshift.io/v1`         | image metadata            |
| DeploymentConfig                                                                                                         | `apps.openshift.io/v1`          | **deprecated**            |
| Route                                                                                                                    | `route.openshift.io/v1`         | exposure - sibling doc    |
| Template                                                                                                                 | `template.openshift.io/v1`      | parameterised objects     |
| Project                                                                                                                  | `project.openshift.io/v1`       | cluster-scoped            |
| User, Group, Identity                                                                                                    | `user.openshift.io/v1`          | authn                     |
| ClusterResourceQuota                                                                                                     | `quota.openshift.io/v1`         | multi-project quota       |
| OAuth, Project (config), Image (config)                                                                                  | `config.openshift.io/v1`        | cluster config: `cluster` |
| Subscription, CSV, InstallPlan, CatalogSource                                                                            | `operators.coreos.com/v1alpha1` | OLM classic               |
| OperatorGroup, OLMConfig                                                                                                 | `operators.coreos.com/v1`       | OLM classic               |
| Role, RoleBinding, ClusterRole, ClusterRoleBinding                                                                       | `rbac.authorization.k8s.io/v1`  | RBAC                      |
| SecurityContextConstraints                                                                                               | `security.openshift.io/v1`      | see sibling doc           |
| Ingress                                                                                                                  | `networking.k8s.io/v1`          | see sibling doc           |
| NetworkPolicy                                                                                                            | `networking.k8s.io/v1`          | see sibling doc           |

---

_End of document. Research only; no game code was modified. Document written 2026-11-03 by teammate `researcher-workloads` for task-2._
