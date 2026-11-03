# EXAM-PREP.md — In-app EX280 Prep mode

> Status: implemented in `js/modes/ExamPrepMode.js` + `js/data/EX280Objectives.js` (task-13).
> Last content verification: 2026-11-03. Docs source: OpenShift 4.22.

The EX280 Prep mode is a non-3D overlay that turns the game into a study dashboard for
**EX280V422** (55 official objective bullets in 9 groups).
It is opened from the main menu (**EX280 Prep**), the in-game toolbar shortcut, the `?` key, or the
deep link `/?panel=exam`.

## 1. What it contains

| Tab | Contents |
|---|---|
| Objective tracker | Every official bullet in Red Hat's 9 groups: mastery status, summary, real `oc` commands with copy buttons, links to the linked campaign levels/challenges/quick labs, and a docs.redhat.com 4.22 link. |
| Quick labs | 9 do-it-now drills. Each shows steps/commands, hints and an objective, launches Sandbox mode, and can be marked complete. |
| Cheat sheet | 109 verified `oc` commands in 10 searchable groups. |
| Exam facts | EX280V422 facts, format, persistence rule, recommended preparation, naming note, official links and the scoring/validity caveat. |

Readiness rule: **Ready when ≥ 90 % of the 55 bullets are mastered**
("Exam ready"), 60–89 % = "Almost there", below that = "Keep going".

## 2. Progress semantics

A bullet is **Mastered** when any of:

1. a linked campaign level is completed (`ScoringEngine.getProgress().campaignProgress[levelId].completed`), or
2. a linked challenge is completed (`challengeProgress[challengeId].completed`), or
3. the user marks the linked quick lab complete (**Mark complete**) — this calls
   `ScoringEngine.markExamPrep(objectiveId, 'mastered')` when that API exists, or records the state in the
   local fallback store.

A bullet is **Practiced** when its `examPrep` state is `practiced` (set when its quick lab is launched) or
when a linked level/challenge has any recorded attempt.

Progress sources (feature-detected, first available wins):

1. `scoringEngine.getExamPrepProgress()` — preferred API (defined in CONVERSION-SPEC §11, implemented by modes-dev);
2. `scoringEngine.getProgress().examPrep` — fallback shape `{[bulletId]: {state: 'practiced'|'mastered', updatedAt}}`;
3. `localStorage['openshiftgames_exam_prep']` — last-resort fallback so the tracker still works before the
   scoring engine integration lands (writes are mirrored here; the canonical game progress key is unchanged).

If no scoring engine exists at all (e.g. isolated UI tests), the overlay still renders and every bullet is
"Not started".

## 3. Shell integration contract

The overlay is dynamically imported by the shell (quiet HEAD probe) and degrades to a toast if the module is
missing. It exports `ExamPrepUI` (also `ExamPrepMode`, `ExamPrep`, default).

```js
const ui = new ExamPrepUI(gameEngine, scoringEngine, app); // constructor per brand-dev contract
ui.init();                                                // called once at boot by the shell
ui.show(); ui.hide();                                     // menu button / ? key / Esc
ui.visible;                                               // boolean, shell checks before Esc handling
ui.getBulletCount();                                      // 55 — used by the browser verifier
ui.getProgressSummary();                                  // {mastered,total,percent,ready} (optional hook)
```

Launch behaviour (click-through):

- Campaign chip: `app.startMode('campaign')` then `app.launchGame('campaign', levelId)`.
- Challenge chip: `app.launchGame('challenge', challengeId)`.
- Quick lab: `app.startMode('sandbox')`; if a future `app.modeInstance.setupQuickLab(lab)` hook exists it is
  called with the lab definition, and `window.game.manifestEngine.resetFiles()` is called when available.
  A toast reminds the player of the first command.
- The overlay hides itself before launching a mode; the shell also calls `hide()` in `launchGame`.

Events emitted by the overlay (for other owners to consume, all optional):

- `ui:exam-prep-opened` `{tab}`
- `ui:exam-prep-closed` `{}`

Events the overlay listens to (refresh while visible): `campaign:level-completed`, `campaign:completed`,
`challenge:completed`, `exam-prep:progress`, `level:completed`, `challenge:complete`. modes-dev can emit
`exam-prep:progress` after `markExamPrep` to keep the overlay live.

DOM/verifier hooks: root `#exam-prep-overlay[data-testid="exam-prep"]`; testids for tabs, panels, groups
(`exam-group-<id>`), bullets (`exam-objective-<id>`), labs (`exam-lab-<id>`), cheat groups, progress,
readiness and close. The overlay injects its own scoped <style> (id `exam-prep-styles`) and appends itself
to `<body>`; **index.html needs no further changes** beyond the already-wired menu/toolbar buttons and the
`?panel=exam` deep link.

Style/quality: dark card matching the game shell, OpenShift red/orange accents, keyboard Esc close,
responsive down to small widths, searchable objective + cheat lists, copy-to-clipboard with a headless-safe
fallback, aria-live status messages.

## 4. Data module (`js/data/EX280Objectives.js`)

Exports:

- `EX280_OBJECTIVE_GROUPS` — 9 groups × 55 bullets, each `{id, title, summary, docsUrl, levels, challenges, commands, quickLabs?}`.
- `EX280_OBJECTIVE_BULLETS` / `EX280_OBJECTIVE_COUNT` — flattened bullets (55) with `groupId/groupTitle`.
- `EX280_QUICK_LABS` — 9 labs: `{id, title, objectiveId, objectiveIds, docsUrl, setup, check, hints, steps}`.
- `EX280_CHEATSHEET` — 10 grouped command sections.
- `EX280_EXAM_FACTS` — exam identity/format/prereqs/links/caveats.
- `EX280_LEVEL_TITLES` / `EX280_CHALLENGE_TITLES` — display mirrors of the fixed game content titles
  (CONVERSION-SPEC §9/§10 are the source of truth; update these two maps if titles change).
- Helpers: `getEX280ObjectiveById`, `getEX280GroupById`, `levelTitle`, `challengeTitle`.

Everything is derived from the research docs in `docs/research/` (`ex280-objectives.md`,
`ex280-study-guide.md`, `exam-facts.json`), which cite Red Hat sources with access dates.

## 5. Coverage summary

**55/55 official bullets mapped**, every one to at least one campaign
level or challenge. All 20 campaign levels and all 12 challenges are referenced by at least one bullet;
9 quick labs cover 25 distinct objectives.

### 5.1 Quick labs

| Lab | Primary objective | Commands |
|---|---|---|
| **Projects & the oc CLI**<br>`lab-projects` | `manage-create-delete-projects` | `oc new-project ex280-lab --display-name="EX280 Lab"`<br>`oc new-app --image=registry.redhat.io/ubi9/ubi-minimal --name=lab-app`<br>`oc get pods`<br>`oc delete project ex280-lab` |
| **HTPasswd users & login**<br>`lab-users-htpasswd` | `auth-htpasswd` | `htpasswd -c -B -b users.htpasswd ex280-user 'Passw0rd!'`<br>`oc create secret generic htpass-secret --from-file=htpasswd=users.htpasswd -n openshift-config`<br>`oc apply -f oauth.yaml`<br>`oc login -u ex280-user` |
| **Route with edge TLS**<br>`lab-route-tls` | `deploy-expose-external` | `oc new-project web`<br>`oc create secret tls web-tls --cert=tls.crt --key=tls.key`<br>`oc create route edge web --service=web --hostname=web.apps.example.com --cert=tls.crt --key=tls.key`<br>`oc get route web -o yaml` |
| **BuildConfig → Build → ImageStream**<br>`lab-build-imagestream` | `deploy-manage-deployments` | `oc new-project build-lab`<br>`oc new-app https://github.com/sclorg/nodejs-ex.git --name=app`<br>`oc logs -f bc/app`<br>`oc get is app -o yaml` |
| **Kustomize prod overlay**<br>`lab-kustomize` | `declarative-kustomize` | `oc kustomize kustomize/overlays/prod`<br>`oc apply -k kustomize/overlays/prod`<br>`oc get deployment -n prod` |
| **ResourceQuota + LimitRange**<br>`lab-quota` | `selfservice-project-quotas` | `oc new-project quota-lab`<br>`oc create quota compute-quota --hard=pods=4,requests.cpu=1,requests.memory=1Gi --namespace=quota-lab`<br>`oc create -f limitrange.yaml -n quota-lab`<br>`oc get quota,limits -n quota-lab` |
| **Service account + SCC grant**<br>`lab-scc` | `security-scc` | `oc new-project scc-lab`<br>`oc create sa robot -n scc-lab`<br>`oc adm policy add-scc-to-user anyuid -z robot -n scc-lab`<br>`oc get pod <pod> -o jsonpath='{.metadata.annotations.openshift\.io/scc}'` |
| **Install an operator**<br>`lab-operator` | `ops-install` | `oc new-project operators-lab`<br>`oc apply -f operatorgroup.yaml`<br>`oc get packagemanifests -n openshift-marketplace`<br>`oc apply -f subscription.yaml`<br>`oc get sub,csv,installplan -n operators-lab` |
| **Job + CronJob**<br>`lab-jobs` | `security-jobs` | `oc new-project jobs-lab`<br>`oc create job pi --image=perl -- perl -Mbignum=bpi -wle 'print bpi(2000)'`<br>`oc get jobs`<br>`oc create cronjob pi --image=perl --schedule='*/1 * * * *' -- perl -Mbignum=bpi -wle 'print bpi(2000)'` |

### 5.2 Objective → game content matrix


### Manage OpenShift Container Platform

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/cli_tools/index> · bullets: 14

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Use the web console to manage and configure an OpenShift cluster**<br>`manage-web-console` | 1, 3, 20 | 12 | — |
| 2 | **Use the command-line interface to manage and configure an OpenShift cluster**<br>`manage-cli` | 1, 2, 4 | 12 | — |
| 3 | **Create and delete projects**<br>`manage-create-delete-projects` | 1, 15 | 1, 12 | Projects & the oc CLI |
| 4 | **Locate and examine container images**<br>`manage-locate-images` | 9 | 5 | — |
| 5 | **Identify images using tags and digests**<br>`manage-images-tags-digests` | 9 | 5 | — |
| 6 | **Query, format, and filter attributes of Kubernetes resources**<br>`manage-query-format-filter` | 2 | 12 | — |
| 7 | **Import, export, and configure Kubernetes resources**<br>`manage-import-export-manifests` | 4 | 4, 12 | — |
| 8 | **Examine resources and cluster status**<br>`manage-examine-status` | 3, 20 | 2 | — |
| 9 | **Monitor cluster events and alerts**<br>`manage-monitor-events-alerts` | 3 | 2 | — |
| 10 | **View logs**<br>`manage-view-logs` | 3 | 2, 5 | — |
| 11 | **Assess the health of an OpenShift cluster**<br>`manage-assess-health` | 3, 20 | 2 | — |
| 12 | **Troubleshoot common container, pod, and cluster events and alerts**<br>`manage-troubleshoot` | 3, 10 | 2, 9 | — |
| 13 | **Use product documentation**<br>`manage-use-docs` | 1, 20 | 12 | — |
| 14 | **Be prepared to perform all tasks of a Red Hat Certified Technologist in OpenShift**<br>`manage-certified-technologist` | 20 | 12 | — |

### Declarative Resource Management

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> · bullets: 7

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Work with resource manifests**<br>`declarative-work-manifests` | 4 | 4, 12 | — |
| 2 | **Deploy applications from YAML resource manifests**<br>`declarative-deploy-yaml` | 4, 11 | 1, 12 | — |
| 3 | **Update application deployments**<br>`declarative-update-deployments` | 4, 10 | 10 | — |
| 4 | **Deploy applications using Kustomize**<br>`declarative-kustomize` | 5 | 4 | Kustomize prod overlay |
| 5 | **Work with Kustomize overlays**<br>`declarative-kustomize-overlays` | 6 | 4 | — |
| 6 | **Create and use secrets**<br>`declarative-secrets` | 7 | 3, 11 | — |
| 7 | **Create and use configuration maps**<br>`declarative-configmaps` | 7 | 12 | — |

### Deploy applications

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/building_applications/index> · bullets: 6

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Deploy applications from templates and Helm charts**<br>`deploy-templates-helm` | 8 | 12 | — |
| 2 | **Manage application deployments**<br>`deploy-manage-deployments` | 8, 10 | 5, 12 | — |
| 3 | **Work with replica sets**<br>`deploy-replica-sets` | 10 | 10 | — |
| 4 | **Work with labels and selectors**<br>`deploy-labels-selectors` | 2, 11 | 1, 9 | — |
| 5 | **Configure services**<br>`deploy-configure-services` | 11 | 1, 3 | — |
| 6 | **Expose applications to external access**<br>`deploy-expose-external` | 11, 12 | 1, 3 | Route with edge TLS |

### Manage authentication and authorization

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> · bullets: 5

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Configure the HTPasswd identity provider for authentication**<br>`auth-htpasswd` | 13 | 11 | HTPasswd users & login |
| 2 | **Create and delete users**<br>`auth-users` | 13 | 11 | — |
| 3 | **Modify user passwords**<br>`auth-passwords` | 13 | 11 | — |
| 4 | **Create and manage groups**<br>`auth-groups` | 14 | 7, 11 | — |
| 5 | **Modify user and group permissions**<br>`auth-permissions` | 14, 16 | 7, 12 | — |

### Configure network security

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/network_security/index> · bullets: 6

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Configure networking components**<br>`net-configure-components` | 11, 12 | 3 | — |
| 2 | **Troubleshoot software defined networking**<br>`net-troubleshoot-sdn` | 3, 11 | 9 | — |
| 3 | **Create and edit external routes**<br>`net-routes` | 11, 12 | 3, 10 | — |
| 4 | **Control cluster network ingress**<br>`net-control-ingress` | 20 | 9 | — |
| 5 | **Secure external and internal traffic using TLS certificates**<br>`net-tls` | 11, 12 | 3, 8 | — |
| 6 | **Configure application network policies**<br>`net-network-policies` | 20 | 9 | — |

### Expose non-HTTP/SNI Applications

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/index> · bullets: 2

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Configure a load balancer service**<br>`nonhttp-load-balancer-service` | 12 | 10 | — |
| 2 | **Configure external application access**<br>`nonhttp-external-access` | 12 | 10 | — |

### Enable developer self-service

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/scalability_and_performance/compute-resource-quotas> · bullets: 5

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Configure cluster resource quotas**<br>`selfservice-cluster-quotas` | 15 | 6 | — |
| 2 | **Configure project quotas**<br>`selfservice-project-quotas` | 15 | 6 | ResourceQuota + LimitRange |
| 3 | **Configure project resource requirements**<br>`selfservice-resource-requirements` | 15, 20 | 6 | — |
| 4 | **Configure project limit ranges**<br>`selfservice-limit-ranges` | 15 | 6 | ResourceQuota + LimitRange |
| 5 | **Configure project templates**<br>`selfservice-project-templates` | 15, 8 | 12 | — |

### Manage OpenShift operators

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/operators/index> · bullets: 3

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Install an operator**<br>`ops-install` | 12, 18 | 10 | Install an operator |
| 2 | **Uninstall an operator**<br>`ops-uninstall` | 18 | 10 | — |
| 3 | **Delete an operator**<br>`ops-delete` | 18 | 10 | — |

### Configure application security

Docs: <https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/index> · bullets: 7

| # | Objective (bullet id) | Campaign levels | Challenges | Quick labs |
|---|---|---|---|---|
| 1 | **Configure and manage service accounts**<br>`security-service-accounts` | 16 | 8, 12 | Service account + SCC grant |
| 2 | **Run privileged applications**<br>`security-privileged` | 17 | 8 | — |
| 3 | **Manage and apply permissions using security context constraints**<br>`security-scc` | 17 | 8 | Service account + SCC grant |
| 4 | **Create and apply secrets to manage sensitive information**<br>`security-secrets` | 7, 17 | 3, 8 | — |
| 5 | **Configure application access to Kubernetes APIs**<br>`security-api-access` | 16 | 7, 12 | — |
| 6 | **Deploy jobs to perform one-time tasks**<br>`security-jobs` | 19 | 12 | Job + CronJob |
| 7 | **Configure Kubernetes cron jobs**<br>`security-cronjobs` | 19 | 12 | — |

## 6. Known limits / follow-ups

- Passing score, score scale and certification validity are **not published** on the exam page; the
  Exam facts tab links the Red Hat Certification Program Guide and says so. Do not add unverified numbers.
- Quick-lab *seeding* depends on future engine support (`setupQuickLab` / `manifestEngine`). Until then,
  labs launch Sandbox and display the full command walkthrough; the `setup` field is ready for the
  engine hook.
- `EX280_LEVEL_TITLES`/`EX280_CHALLENGE_TITLES` are display mirrors. If task-14/task-11 finalise different
  titles, update the two maps (no logic changes needed).
- The Cheat sheet intentionally repeats the most common commands across sections for exam-day scanning;
  it is not a unique-command count.
