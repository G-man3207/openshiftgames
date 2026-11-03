# OpenShift Games — EX280 Study Guide

**Exam:** EX280V422 — Red Hat Certified Specialist in OpenShift Administration
(redhat.com page title: _Red Hat Certified System Administrator in OpenShift exam (EX280)_)
**Platform:** Red Hat OpenShift Container Platform **4.22** · **3.0 hours** · hands-on, performance-based
**Content verified:** 2026-11-03 · **In-game dashboard:** EX280 Prep mode (menu button, toolbar or `?`)

This guide is the study companion to the game. It is deliberately concise; the authoritative research
lives in the repo:

- [`docs/research/ex280-objectives.md`](research/ex280-objectives.md) — official objectives verbatim, exam facts, version-sensitive flags.
- [`docs/research/ex280-study-guide.md`](research/ex280-study-guide.md) — command drills, flags and traps with sources.
- [`docs/research/exam-facts.json`](research/exam-facts.json) — machine-readable facts + dated sources.
- [`docs/EXAM-PREP.md`](EXAM-PREP.md) — how the in-app tracker works + full objective→level matrix.

Red Hat sources (accessed 2026-11-03):

- Official exam page: <https://www.redhat.com/en/services/training/red-hat-certified-openshift-administrator-exam>
- Exam Objectives by Version PDF (`EX280V422`): <https://training-lms.redhat.com/public_content/redhat/training/Red%20Hat%20Certification%20Exam%20Objectives%20by%20Version.pdf>
- OCP 4.22 docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22>
- Certification Program Guide (scoring/validity policy): <https://docs.redhat.com/en/documentation/red_hat_learning_subscription/1-latest/html/red_hat_certification_program_guide/index>

> **Scoring/validity caveat.** The exam page publishes only that results are total scores; it does not
> state a passing score, score scale or certification validity period. The Red Hat Certification Program
> Guide governs those. Don't rely on numbers you did not verify there.

---

## 1. What the exam expects from you

Red Hat groups the exam into **9 objective groups / 55 bullets**. The safest way to study is bullet by
bullet in the in-app tracker: each bullet shows what it means, the real `oc` commands, the docs page and
one or more game levels/challenges to practise it.

| # | Objective group | Study outcome (one screen) |
|---|---|---|
| 1 | Manage OpenShift Container Platform | Create a project, deploy and break an app, then explain node/pod/ClusterOperator/cluster-version state from `oc` output, logs and events. |
| 2 | Declarative Resource Management | Apply a Deployment+Service manifest, update it, deploy via a Kustomize base and a prod overlay, and inject a Secret/ConfigMap. |
| 3 | Deploy applications | Go from source to running app (`new-app`/build), update/rollback a Deployment, and expose it with a Service+Route (edge TLS). |
| 4 | Manage authentication and authorization | Configure HTPasswd in the OAuth CR, log in as the new user, manage groups and prove a role binding with `oc auth can-i`. |
| 5 | Configure network security | Default-deny a project, allow only frontend→backend, restore DNS/ingress access, and secure an external Route with TLS. |
| 6 | Expose non-HTTP/SNI Applications | Expose a TCP/UDP workload via NodePort and a LoadBalancer Service (MetalLB on bare metal); use a passthrough Route for TLS protocols. |
| 7 | Enable developer self-service | Enforce a ResourceQuota + LimitRange + ClusterResourceQuota, and customise the default `project-request` template. |
| 8 | Manage OpenShift operators | Install an Operator from OperatorHub/CLI (OperatorGroup + Subscription), verify the CSV, then uninstall and delete it cleanly. |
| 9 | Configure application security | Create a service account, grant it an SCC for a privileged workload, issue a bound token and prove API access; run Jobs and CronJobs. |

### Version-sensitive facts that change answers

- **Deployment preferred over DeploymentConfig.** `DeploymentConfig` is deprecated since OCP 4.14 (still supported in 4.22); manifests on the exam use `apps/v1` **Deployment**.
- **No auto long-lived ServiceAccount token Secret** since OCP 4.16 — use `oc create token` or a projected `serviceAccountToken` volume.
- **`oc export` does not exist** — export with `oc get … -o yaml > file.yaml`.
- **Default SCC is `restricted-v2`**; `privileged` is never granted by default. Grant an SCC to the workload's service account (or a custom SCC), don't edit defaults.
- **Kustomize and Helm are explicit V422 objectives** (they were not named in V412K/V414K).
- **Dropped from V422:** the old storage section (PV/storage classes/StatefulSet), the reliability section (probes/limits/scaling as its own section) and the update section (OCP/operator updates). Don't over-invest there.
- **Routes are HTTP/HTTPS/SNI only** — non-HTTP needs NodePort/LoadBalancer/external access.

---

## 2. How to practise in the game

1. Open **EX280 Prep** from the main menu (also in the in-game toolbar or with `?`).
2. Pick the objective group you are studying; read the bullet summary and copy the `oc` command.
3. Click a linked **Level N** / **Challenge N** chip — the overlay launches it for you.
4. Finish the level/challenge: the bullet flips to **Mastered** automatically.
5. For fast reps, use **Quick labs** and **Mark complete**; the tracker records the bullet as mastered.
6. Watch the readiness badge: **Exam ready** appears at **≥ 90 %** of the 55 bullets mastered.

The **Cheat sheet** tab has 109 real `oc` commands grouped for exam-day scanning, each with a copy button
and a docs link. The **Exam facts** tab keeps the official links and the scoring caveat one click away.

---

## 3. Suggested 12-session plan

Each session: ~45–60 min of reading/commands in the sandbox, then 1–2 linked levels/challenges, then mark
the objective bullets you can perform unaided.

| Session | Focus | Game content | Docs |
|---|---|---|---|
| 1 | CLI, projects, web console, query/format/filter | Levels 1–2 | [CLI tools](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index) · [Web console](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/web_console/index) |
| 2 | Logs, events, cluster health, troubleshooting | Level 3 + challenge 2 | [Nodes](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/nodes/index) · [Monitoring](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/monitoring/index) |
| 3 | Manifests, updates, rollouts/rollbacks | Levels 4, 10 | [Building applications](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index) |
| 4 | Secrets & ConfigMaps | Level 7 | [Building applications](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index) |
| 5 | Kustomize base + overlays | Levels 5–6 + challenge 4 | [CLI tools](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index) |
| 6 | Templates + Helm charts | Level 8 | [Building applications](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index) |
| 7 | Images, ImageStreams, builds, triggers | Level 9 + challenge 5 | [Images](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/images/index) |
| 8 | Services, Routes, TLS, non-HTTP exposure | Levels 11–12 + challenges 3, 10 | [Ingress and load balancing](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index) |
| 9 | HTPasswd, users, groups, RBAC | Levels 13–14 + challenges 7, 11 | [Authentication](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index) |
| 10 | SCCs, service accounts, API access | Levels 16–17 + challenge 8 | [Authentication](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index) · [Service accounts](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/understanding-and-creating-service-accounts) |
| 11 | Quotas, LimitRanges, project templates; Jobs/CronJobs | Levels 15, 19 + challenge 6 | [Quotas and limits](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas) |
| 12 | NetworkPolicy + full timed mock | Challenges 9, 12; level 20 | [Network security](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index) · [Network policy](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/network-policy) |

Exam-day discipline to practise from session 1: work without hints, read `oc describe`/events before
changing anything, and create everything from manifests/controllers because **configurations must persist**
across reboot.

---

## 4. Quick labs (in-app)

Nine drills cover the highest-value mechanics. Each shows steps, commands and hints, and launches Sandbox.

| Lab | What you will prove |
|---|---|
| Projects & the oc CLI | Create project → deploy image → inspect pod → delete project. |
| HTPasswd users & login | `htpasswd` file → `htpass-secret` in `openshift-config` → OAuth CR → login. |
| Route with edge TLS | TLS secret + `oc create route edge` + Admitted route. |
| BuildConfig → Build → ImageStream | `oc new-app` from Git, follow build logs, read ImageStreamTag digest. |
| Kustomize prod overlay | Apply base, then a prod overlay (namespace/image/replicas) with `oc apply -k`. |
| ResourceQuota + LimitRange | Compute quota + LimitRange defaults; deploy a compliant workload. |
| Service account + SCC grant | Create SA, grant `anyuid`, confirm the pod's `openshift.io/scc`. |
| Install an operator | OperatorGroup + Subscription, CSV to `Succeeded`, then uninstall. |
| Job + CronJob | Run a one-time Job to completion, create a CronJob schedule. |

---

## 5. Common traps (from the research notes)

1. **Wrong project** — almost everything is namespaced; check `oc project` and use `-n`.
2. **SCC vs `securityContext`** — requesting privileged/root/capabilities needs an SCC granted to the pod's service account; default SCC edits are reverted on upgrade.
3. **DeploymentConfig habits** — `oc rollout undo dc/...` works for legacy, but new manifests are `apps/v1` Deployments; image triggers on a Deployment are the `image.openshift.io/triggers` annotation set by `oc set triggers`.
4. **No `oc export`** — `oc get … -o yaml > file`.
5. **SA tokens** — no token Secret appears for new SAs; use `oc create token`.
6. **Routes need a Service** — a Route with no endpoints fails; edge needs cert+key, reencrypt needs a destination CA, passthrough cannot use path routing.
7. **Default-deny breaks DNS and ingress** — add DNS egress and ingress-controller allows; NetworkPolicies are additive.
8. **Compute quota needs requests/limits** — pods without them are rejected unless a LimitRange supplies defaults.
9. **Templates are namespaced** — developers see templates in their project or the `openshift` project; the default project template is `project-request` in `openshift-config`.
10. **ClusterOperator ≠ OLM Operator** — `oc get co` is CVO health; `oc get csv/sub` is OLM.
11. **Verify, don't assume** — `oc get` + `oc describe` + test externally (curl, connect, job completion) before declaring done.

---

## 6. Not on EX280V422 — don't over-study

- PV/PVC lifecycle, storage classes, CSI details, StatefulSets as their own topic.
- HPA/PDB, standalone health-probe deep dive, cluster updates, deprecated-API audits.
- Jenkins/Pipelines/GitOps, custom S2I builder images, advanced router sharding/MetalLB BGP.

Keep only what naturally appears in a manifest or qualifies a task you may be asked to build.

---

## 7. Verification and attribution

- Exam identity/objectives last verified **2026-11-03** against the live redhat.com exam page and the Red
  Hat LMS objectives PDF; OCP docs version **4.22** (4.23 returns 404).
- Command syntax was verified against the OpenShift 4.22 documentation sources (docs.redhat.com renders
  bodies client-side, so the identical `openshift/openshift-docs` branch `enterprise-4.22` modules were
  used); see the research docs for the per-command citations and the **†** marks for generic patterns not
  found verbatim in the docs.
- OpenShift Games is an unofficial educational project, not affiliated with or endorsed by Red Hat.
  OpenShift and Red Hat are trademarks of Red Hat, Inc.
