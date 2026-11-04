# Declarative engine — manifests, Kustomize, Helm, templates & HTPasswd

Status: implemented for the OpenShift 4.22 / EX280V422 conversion.
Owner (write scope): **manifests-dev**.
Files: `js/engine/YamlParser.js`, `js/engine/ManifestEngine.js`, `js/ui/ManifestPanel.js`,
`js/data/ManifestFiles.js`, this document.

The declarative engine makes the simulator's virtual filesystem the source of truth for the
workflows EX280V422 explicitly tests:

| Exam workflow                    | Command                                                        | Engine call                                                          |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Deploy from a manifest           | `oc apply -f manifests/deployment.yaml`                        | `applyFile(path)`                                                    |
| Create / replace from a manifest | `oc create -f` / `oc replace -f`                               | `applyFile(path)` (upsert)                                           |
| Kustomize base and overlays      | `oc apply -k kustomize/overlays/prod`                          | `applyKustomize(dir)`                                                |
| Process a template               | `oc process -f templates/webapp-template.yaml -p APP_NAME=web` | `processTemplate(path, params)`                                      |
| Template → apply                 | `oc process ... \| oc apply -f -`                              | `applyObjects(objects)` / `applyFile(<stdin temp>)`                  |
| Delete from a manifest           | `oc delete -f manifests/route.yaml`                            | `deleteFileObjects(path)`                                            |
| Helm lifecycle                   | `helm install/upgrade/list/uninstall`                          | `installHelm` / `upgradeHelm` / `listHelm` / `uninstallHelm`         |
| HTPasswd identity provider       | `htpasswd -c/-b/-D <file> <user>`                              | `htpasswdAdd` / `htpasswdUpdate` / `htpasswdDelete` / `htpasswdList` |
| Export / edit loop               | `oc get deploy web -o yaml > web.yaml`, `oc edit`              | `writeFile` / `readFile`, `ManifestPanel.show(resource)`             |

No dependencies, no build step, pure ES modules. Nothing here touches the DOM at module load, so
all modules can be imported in Node for model tests.

---

## 1. Files and responsibilities

| File                          | Responsibility                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `js/engine/YamlParser.js`     | Practical YAML subset parser + stringifier + structured errors + `selfTest()`                                |
| `js/engine/ManifestEngine.js` | Virtual FS, apply/apply -k/process/delete, Helm releases, HTPasswd file, objective state, events             |
| `js/data/ManifestFiles.js`    | Default virtual files (`MANIFEST_FILES`), realistic OCP 4.22 content                                         |
| `js/ui/ManifestPanel.js`      | Self-contained "Files & Manifests" modal (own DOM/CSS, file tree, editor, apply buttons, errors, docs links) |
| `docs/declarative-engine.md`  | This API reference                                                                                           |

The engine never imports `GameEngine`/`CommandBar`; it resolves the live game lazily through
`window.game` (or the object passed to its constructor). That keeps the dependency direction
one-way and lets the verifier import the engine in Node.

---

## 2. Quick start

### Browser (normal game boot)

`index.html` already lazy-loads the panel:

```js
const mod = await import('./js/ui/ManifestPanel.js');
const panel = new mod.ManifestPanel(this.engine); // GameEngine instance
panel.init(); // creates DOM + engine + globals
panel.show(); // opens modal
panel.setContext({
  manifestFiles: ['manifests/deployment.yaml'],
  focusFiles: ['manifests/deployment.yaml'],
});
```

`panel.init()` sets:

```js
window.game.manifestPanel = panel;
window.game.manifestEngine = panel.manifestEngine; // ManifestEngine
```

The level/session boot calls `_ensureManifestPanel()` at mode start, so the engine is available
to the command bar before the player opens the modal.

### Node model test (no DOM)

```js
globalThis.window = {
  game: {
    cluster: fakeCluster, // getByName/getByKind/getByNamespace/add/remove
    gameEngine: { currentProject: 'demo', currentUser: 'kubeadmin', emit() {} },
  },
};
const { ManifestEngine } = await import('./js/engine/ManifestEngine.js');
const engine = new ManifestEngine();
engine.applyFile('manifests/deployment.yaml');
```

If `window.game.gameEngine.applyManifestObject` exists it is used for every object; otherwise the
engine falls back to `kindRegistry.createResource()` + `ClusterState`. See §6.3.

---

## 3. `YamlParser` API

```js
import {
  parseYaml,
  parseDocument,
  parseYamlSafe,
  stringifyYaml,
  toYamlError,
  YamlParseError,
  selfTest,
} from './js/engine/YamlParser.js';
```

| Export           | Signature                                  | Returns                                                                   |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `parseYaml`      | `(text, {file?} = {})`                     | `Array<object>` — one entry per non-empty `---` document                  |
| `parseDocument`  | `(text, {file?} = {})`                     | `object                                                                   | null` — first document (`null` when empty) |
| `parseYamlSafe`  | `(text, {file?} = {})`                     | `{ok: boolean, docs: object[], errors: [{line, message, file?}]}`         |
| `stringifyYaml`  | `(value)`                                  | `string` (single YAML document, trailing newline)                         |
| `toYamlError`    | `(err)`                                    | `{line, message, file?}`                                                  |
| `YamlParseError` | `new YamlParseError(message, line, file?)` | `Error` with `.name === 'YamlParseError'`, `.line`, `.file?`, `.toJSON()` |
| `selfTest`       | `()`                                       | `{ok: boolean, failures: Array<{name, error}>}` (27 cases)                |

### Supported YAML

- block mappings and sequences, arbitrary indentation, sequence-of-mappings
- inline / flow collections: `{a: 1, b: [2, 3]}` including multi-line flow
- plain, single-quoted (`''` escape) and double-quoted (`\n`, `\t`, `\"`, `\uXXXX`, …) scalars
- booleans `true/false` (+ capitalised forms), integers, floats, exponent floats, `.inf`, `.nan`,
  `null`/`~`; everything else (including `yes/no/on/off` and version-looking strings) stays a string
- comments `#` outside quotes; `key: value # comment`, full-line comments
- multiple documents with `---` / `...` (including `--- # comment`)
- literal `|` and folded `>` block scalars with chomping (`|-`, `|+`, `>-`, `>+`) and explicit
  indentation digits (`|2`)

Not supported (raises a structured error or documented limitation): YAML anchors/aliases
(`&a`, `*a`), merge keys (`<<`), complex keys (`? key`), custom tags (tags are stripped), and
multi-line _plain_ (unfolded) scalars. Use `|`/`>` for multi-line strings.

### Errors

Parser errors always carry a 1-based line and the optional file name:

```js
try {
  parseYaml('metadata:\n  name: x\n   bad: 1\n', { file: 'manifests/deployment.yaml' });
} catch (err) {
  err.name; // 'YamlParseError'
  err.line; // 3
  err.message; // "bad indentation of a mapping entry"
  err.file; // 'manifests/deployment.yaml'
}
```

### `stringifyYaml`

- preserves object key order and round-trips strings exactly (multiline strings become `|`/`|-`/`|+`,
  leading-whitespace strings get an explicit indentation indicator, strings with tabs are JSON-quoted)
- quotes keys/values that would otherwise change type (`"true"`, `"123"`, `"has: colon"`, `"#x"`)
- emits `[]` / `{}` for empty collections and `.inf` / `.nan` for special numbers

The verifier round-trip test (`parse(file) → stringifyYaml → parse`) passes for every default file.

---

## 4. `ManifestEngine` API

```js
import { ManifestEngine, deepMerge } from './js/engine/ManifestEngine.js';
const engine = new ManifestEngine(gameOrEngine?, { autoCreateProjects: true });
```

`gameOrEngine` may be `window.game` (`{gameEngine, cluster}`) or a `GameEngine` instance; it may be
omitted and is then resolved from `window.game` on every call. `autoCreateProjects` defaults to
`true` (simulator convenience, §8).

Every apply-style result has the same shape:

```js
{
  ok: boolean,
  created: [{ kind: 'Deployment', name: 'webapp', namespace: 'demo' }],
  updated: [{ kind: 'Service',  name: 'webapp', namespace: 'demo' }],
  errors: ['manifests/x.yaml:3: bad indentation of a mapping entry'], // human-readable
  errorDetails: [{ file: 'manifests/x.yaml', line: 3, message: '...' }], // structured
  warnings: ['project "webapp-prod" did not exist and was created automatically …'],
  autoCreatedProjects: [{ kind: 'Project', name: 'webapp-prod', namespace: '' }],
  source: 'manifests/deployment.yaml',
  error?: 'first error string'   // convenience for CLI consumers that check result.error
}
```

Success results also include `template?: {path, name}` when the applied objects were produced by
`processTemplate()`.

### 4.1 Virtual filesystem

| Method        | Signature                                                             | Notes                                                                                 |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `listFiles`   | `()` → `string[]`                                                     | sorted, normalized paths (`manifests/deployment.yaml`)                                |
| `getFileTree` | `()` → `[{path, kind: 'directory'\|'file', name, depth, extension?}]` | flat tree representation for the panel                                                |
| `readFile`    | `(path)` → `string\|null`                                             | `null` when missing                                                                   |
| `writeFile`   | `(path, text)` → `string`                                             | creates parent directories implicitly; overwrites                                     |
| `deleteFile`  | `(path)` → `boolean`                                                  | does not delete cluster objects                                                       |
| `resetFiles`  | `()` → `string[]`                                                     | restores `MANIFEST_FILES`, clears apply/template/Helm records, emits `manifest:reset` |
| `exists`      | `(path)` → `boolean`                                                  | helper                                                                                |

All paths are virtual, POSIX-like and relative to the workspace root (`./` is stripped, `..` is
resolved). `htpasswd` lives at the root of this filesystem.

### 4.2 `oc apply -f` / `oc create -f` / `oc replace -f`

```js
engine.applyFile('manifests/deployment.yaml');
// → result shape above; emits manifest:applied {file, path, source, resources, created, updated, warnings}
```

- Parses **all** documents, validates kind/name (`kind: List` is expanded), and applies them in order.
- Parse/validation errors return `{ok:false, errors, errorDetails}` **before any cluster mutation**.
- Missing file: `error: the path "x" does not exist`.
- Unknown kind: `error: unable to recognize "...": no matches for kind "X" in version "Y"`.
- Kind aliases are canonicalised through `kindRegistry.normalizeKind` (`namespace` → `Project`,
  `dc` → `Deployment`, …); `apiVersion` comes from the manifest or the registry.
- `generateName` is supported (`metadata.generateName` generates a suffix).
- Top-level payload fields (`data`, `stringData`, `type`, `rules`, `roleRef`, `subjects`, `objects`,
  `parameters`, …) are folded into the game-model `spec` for ConfigMap/Secret/Role/Template/OAuth.
- Upsert semantics (simulator): existing kind/name/namespace updates the spec, labels and
  annotations and reports `updated`; otherwise creates and reports `created`.
- Records the applied path in `appliedFiles` on success (objective type `manifest {file}`).

```js
engine.applyObjects(objects, 'oc apply -f -');
// same result; used for stdin / `oc process ... | oc apply -f -`.
// If the objects match a pending processTemplate() result, the template record is
// marked applied and template:processed is emitted.
```

```js
engine.applyTemplate(path, { APP_NAME: 'web' });
// processTemplate() + applyObjects() in one call (returns the apply result + objects/message).
```

### 4.3 `oc apply -k` — Kustomize

```js
engine.applyKustomize('kustomize/overlays/prod');
// → result shape; emits kustomize:applied {path, source, resources, created, updated, warnings}
```

Supported `kustomization.yaml` fields:

| Field                       | Behaviour                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resources` / `bases`       | relative files or directories (recursive, cycle-detected); remote URLs are rejected                                                                    |
| `namespace`                 | sets `metadata.namespace` on all namespaced kinds                                                                                                      |
| `namePrefix` / `nameSuffix` | rewrites `metadata.name` and known name references (Route.spec.to, StatefulSet.serviceName, HPA.scaleTargetRef, RoleBinding.roleRef, Ingress backends) |
| `commonLabels`              | added to `metadata.labels`, workload pod-template labels and selectors (Service selector, Deployment/STS/DS/RS selector.matchLabels)                   |
| `labels`                    | pairs added like `commonLabels`; selectors only when `includeSelectors: true`                                                                          |
| `commonAnnotations`         | added to `metadata.annotations`                                                                                                                        |
| `images`                    | `[{name, newName?, newTag?, digest?}]`, applied to every `containers`/`initContainers` image whose repository matches `name`                           |
| `replicas`                  | `[{name, count}]` sets `spec.replicas` on matching Deployment/StatefulSet/ReplicaSet (matches original or prefixed name)                               |
| `patchesStrategicMerge`     | file path, inline YAML string, or object; deep-merge maps, **lists replaced**; target matched by kind+`metadata.name`                                  |
| `patches`                   | file-based strategic patches (`path`), subset documented below                                                                                         |

Transformation order: load resources → apply patches (patches match the **original** names) →
`namespace` → `namePrefix`/`nameSuffix` + references → labels/annotations → images → replicas → apply.
A `patchesStrategicMerge` entry that matches nothing is an error and leaves the cluster unchanged;
a `replicas` entry that matches nothing is a warning.

Missing kustomization directory/file:
`error: unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory 'x'`.
JSON6902 patches, `configMapGenerator`/`secretGenerator`, `replacements`, `components`, remote bases
and `patchesJson6902` are not implemented.

### 4.4 OpenShift templates — `oc process`

```js
const t = engine.processTemplate('templates/webapp-template.yaml', {
  APP_NAME: 'web',
  REPLICAS: '3',
});
// {
//   ok: true,
//   objects: [ /* 3 substituted objects */ ],
//   yaml: '---\napiVersion: apps/v1\n…',   // ready for `oc apply -f -`
//   message: 'Application web has been created from template webapp-template.',
//   parameters: { APP_NAME: 'web', IMAGE: 'quay.io/…', REPLICAS: '3' },
//   errors: [], errorDetails: [], warnings: []
// }
```

- Template may be `kind: Template` with top-level `parameters`/`objects`/`message` (real OCP shape)
  or the game-model `spec.parameters`/`spec.objects`.
- Parameters resolve as: supplied value → `parameters[].value` default → `generate`/`from`
  (simple `[a-zA-Z0-9]{12}` generators) → empty. Missing `required: true` parameters produce
  `template parameter APP_NAME is required` and `ok:false`.
- `${PARAM}` substitutions work inside any string; `${{PARAM}}` additionally becomes a typed value
  when it is the whole field (`replicas: "${{REPLICAS}}"` → `replicas: 3`). Unknown placeholders are
  left intact and reported in `warnings`.
- `processTemplate` **does not apply anything and emits no event**. Pipe the result to
  `applyObjects(objects)`/`applyFile(<stdin temp>)` (or call `applyTemplate`) to create the objects;
  that path marks the record `applied: true` and emits `template:processed`.
- `templateParameters(path)` returns `[{name, displayName, description, value, required, generate, from}]`
  for `oc process --parameters -f`.

### 4.5 `oc delete -f`

```js
engine.deleteFileObjects('manifests/route.yaml');
// → {ok, deleted: [{kind,name,namespace}], notFound: [...], errors: [...], errorDetails: [...]}
```

Parses the file first; invalid YAML changes nothing. Missing objects produce realistic
`Error from server (NotFound): routes.route.openshift.io "webapp" not found` and `ok:false`.

### 4.6 Helm

```js
engine.installHelm('webapp', 'helm/webapp'); // → {ok, released, resources, …}
engine.upgradeHelm('webapp', 'helm/webapp', 'values-prod.yaml'); // revision++, re-applies objects
engine.listHelm();
// [{name, chart, chartVersion, status:'deployed', namespace, revision,
//   chartDir, resources:[{kind,name,namespace}], updatedAt}]
engine.uninstallHelm('webapp'); // → {ok, deleted, notFound, errors}
engine.renderHelm('webapp', 'helm/webapp'); // render only (no apply)
engine.getHelmRelease('webapp');
```

- Chart layout: `Chart.yaml`, optional `values.yaml`, `templates/*.yaml`; `valuesPath` is merged over
  the chart defaults (maps deep-merged, lists replaced). Release namespace comes from the optional
  fourth argument `{namespace}`, else the current project.
- Supported Go-template subset in `templates/*.yaml`: `{{ .Values.path.to.key }}`,
  `{{ .Release.Name }}`, `{{ .Release.Namespace }}`, `{{ .Chart.Name }}`, `{{ .Chart.Version }}`,
  `{{ .Chart.AppVersion }}` and the `| quote`, `| default "x"`, `| toString` pipelines.
  Unknown expressions/missing values are clear template errors.
- Chart templates are valid YAML **before rendering** (expressions are quoted), so the YAML
  verifier and parser self-tests can parse them. After rendering, the YAML is parsed and numeric
  strings for known integer fields (`replicas`, `port`, `targetPort`, `containerPort`, …) are coerced.
- Release names must be lowercase DNS-1123 (`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, ≤53 chars).
- Installing an existing release fails with `release "x" already exists`; upgrading/uninstalling a
  missing release fails with `release not found`.
- Events: `helm:installed`, `helm:upgraded`, `helm:uninstalled`.
- Resources are applied through the same `applyManifestObject`/`ClusterState` path as manifests and
  remembered on the release so `uninstallHelm` can delete them.

### 4.7 HTPasswd file

```js
engine.htpasswdAdd('alice', 'ChangeMe123!'); // → {ok, user, file:'htpasswd', errors:[]}
engine.htpasswdUpdate('alice', 'NewPass456!'); // → {ok, user, updated:true|false, …}
engine.htpasswdDelete('alice'); // → {ok, user, …}
engine.htpasswdList(); // → ['alice', …]
engine.htpasswdAuthenticate('alice', 'NewPass456!'); // → true (used by `oc login`)
engine.verifyHtpasswd('alice', 'NewPass456!'); // alias
```

The virtual `htpasswd` file contains lines `user:{SHA}<fake-hash>`; the hash is a deterministic
non-reversible stand-in, so raw passwords are never written to the filesystem or state. Existing
real bcrypt hashes in a hand-edited file are listed but cannot be verified (documented limitation).
`readFile('htpasswd')` shows the hash lines (never plaintext).

### 4.8 State and events for objectives / Exam Prep

```js
engine.getState();
// {
//   files: {path: content},
//   fileList: [...],
//   appliedFiles: [{path, source, at, resources}],
//   appliedKustomize: [{path, kustomization, at, resources}],
//   templates: [{path, name, params, applied, at, resources}],
//   helmReleases: [...], helm: [...],           // same array, alias
//   htpasswd: {file:'htpasswd', users:[...], content:'...'},
//   lastApplied: {...}|null,
//   lastErrors: [...]
// }
```

Convenience helpers: `hasAppliedFile(path)`, `hasAppliedKustomize(path)`, `getAppliedTemplates()`,
`getHelmRelease(name)`. All paths are normalized; `hasAppliedKustomize` also accepts a trailing `/`.

Events (emitted on `window.game.gameEngine`/EventBus **and** as DOM
`CustomEvent('openshiftgames:<event-with-dashes>')`):

| Event                | Payload                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `manifest:applied`   | `{file, path, source, resources, created, updated, warnings}`       |
| `kustomize:applied`  | `{path, source, resources, created, updated, warnings}`             |
| `template:processed` | `{path, name, templateName, params, resources}` (only when applied) |
| `helm:installed`     | `{release, name, chart, namespace, resources}`                      |
| `helm:upgraded`      | `{release, name, chart, namespace, resources}`                      |
| `helm:uninstalled`   | `{release, name, deleted}`                                          |
| `manifest:reset`     | `{files}` (from `resetFiles()`)                                     |

---

## 5. Default files (`js/data/ManifestFiles.js`)

All 18 YAML files parse with `YamlParser` and round-trip through `stringifyYaml`.

| Path                                                    | Purpose                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `manifests/deployment.yaml`                             | `apps/v1` Deployment `webapp`, 2 replicas, hello-openshift image, ports 8080, requests/limits, readiness probe            |
| `manifests/service.yaml`                                | `v1` Service ClusterIP 8080 → 8080, selector `app: webapp`                                                                |
| `manifests/route.yaml`                                  | `route.openshift.io/v1` Route, edge TLS + `Redirect`, `externalCertificate.name: webapp-tls` (OCP 4.22), service `webapp` |
| `kustomize/base/kustomization.yaml`                     | base `resources`, `commonLabels`                                                                                          |
| `kustomize/base/deployment.yaml`, `service.yaml`        | unprefixed base objects                                                                                                   |
| `kustomize/overlays/dev/kustomization.yaml`             | `namePrefix: dev-`, namespace `webapp-dev`, dev labels, replicas 1                                                        |
| `kustomize/overlays/prod/kustomization.yaml`            | `namePrefix: prod-`, namespace `webapp-prod`, tag `1.0.0`, replicas 3, `patchesStrategicMerge`                            |
| `kustomize/overlays/prod/patch-deployment.yaml`         | adds `APP_ENV=production`, larger resources                                                                               |
| `templates/webapp-template.yaml`                        | `template.openshift.io/v1` Template with `APP_NAME`/`IMAGE`/`REPLICAS`, Deployment+Service+Route objects                  |
| `helm/webapp/Chart.yaml`, `values.yaml`                 | chart `webapp` 0.1.0, replicaCount/image/service/resources values                                                         |
| `helm/webapp/templates/deployment.yaml`, `service.yaml` | Helm-templated Deployment + Service                                                                                       |
| `htpasswd`                                              | empty HTPasswd database                                                                                                   |
| `examples/quota.yaml`                                   | ResourceQuota `compute-quota`                                                                                             |
| `examples/limitrange.yaml`                              | LimitRange `resource-limits`                                                                                              |
| `examples/subscription.yaml`                            | MetalLB-style Subscription `ansible-automation-platform-operator` in `openshift-operators`                                |
| `examples/buildconfig.yaml`                             | BuildConfig `webapp` (Git → nodejs:20 S2I → ImageStreamTag webapp:latest)                                                 |

Levels may pass `manifestFiles` (files to surface) and `focusFiles` (file to open) through
`panel.setContext(...)`; the panel always shows the complete default tree. Session/level start calls
`manifestEngine.resetFiles()` which also emits `manifest:reset`, so the panel drops stale drafts.

---

## 6. Integration

### 6.1 `index.html` (owned by brand-dev; already wired)

- `#btn-manifests` / `F` → `_ensureManifestPanel()` → `new ManifestPanel(this.engine)` + `init()`.
- On level start and on `showFiles()`: `panel.setContext({manifestFiles, focusFiles})`.
- `Esc` / `handleEscape()` checks `panel.visible` then calls `panel.hide()`.
- `window.game.manifestPanel` and `window.game.manifestEngine` are set in `init()`.
- `ManifestPanel.show(resource)` materialises `oc edit` objects under `.oc/edit-<kind>-<name>.yaml`
  and focuses that editor; CommandBar calls `panel.show(resource)` for `oc edit`.
- The modal appends its own DOM and `<style>` to `<body>`; no index.html/CSS changes are required.
  `data-testid` hooks: `manifest-panel`, `manifest-file` (+`data-path`), `manifest-editor`,
  `manifest-save`, `manifest-reset`, `manifest-apply`, `manifest-apply-kustomize`,
  `manifest-result`, `manifest-error`, `manifest-current-file`, `manifest-close`.

### 6.2 `CommandBar` (owned by cli-dev; delegated helpers already call this API)

| CLI command                           | Engine call                                               | CLI result handling                                                                            |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `oc apply/create/replace -f <file>`   | `applyFile(file)`                                         | `_normalizeApplyResult` reads `created`/`updated` (`{kind,name}`); failures via `result.error` |
| `oc apply -f -` (pipe/stdin)          | CommandBar writes `.oc/stdin-N.yaml`, then `applyFile`    | same; a pending template result is marked applied + `template:processed`                       |
| `oc apply -k <dir>`                   | `applyKustomize(dir)`                                     | same as apply                                                                                  |
| `oc delete -f <file>`                 | `deleteFileObjects(file)`                                 | `deleted` entries rendered as `<resource> "<name>" deleted`; failures via `result.error`       |
| `oc process -f <file> -p K=V`         | `processTemplate(file, params)`                           | use `result.yaml`/`result.objects`; failures via `result.error` (`ok:false` also set)          |
| `helm install/upgrade/list/uninstall` | `installHelm`, `upgradeHelm`, `listHelm`, `uninstallHelm` | failures carry `result.error`; list returns an array                                           |
| `htpasswd -c/-b/-D`                   | `htpasswdAdd`, `htpasswdUpdate`, `htpasswdDelete`         | failures carry `result.error`; success has `ok:true`                                           |
| `oc login -u/-p`                      | `manifestEngine.htpasswdAuthenticate(user, pass)`         | boolean gate for HTPasswd login                                                                |
| `oc get ... -o yaml > file`           | `writeFile(path, text)`                                   | CommandBar handles redirect writing                                                            |
| `oc edit`                             | `window.game.manifestPanel.show(resource)`                | opens the resource as an editable manifest file                                                |

`window.game.manifestEngine` may briefly be `null` before the panel is initialised; CommandBar's
`_manifestNotReady()` guard covers that (the session boot initialises it early).

### 6.3 `GameEngine.applyManifestObject(obj)` (owned by engine-dev)

`ManifestEngine._applyOne` prefers the engine API:

```js
const returned = gameEngine.applyManifestObject({
  apiVersion,
  kind,
  metadata: { name, namespace, labels, annotations },
  spec,
});
// accepted return: ResourceBase | {resource: ResourceBase, created?: boolean} | undefined
```

`created` is taken from `returned.created` when present, otherwise from a pre-apply lookup by
kind/name/namespace. If the API is absent (or in Node model tests) the engine creates/updates a
`kindRegistry.createResource()` instance and calls `cluster.add(resource)` (or mutates the existing
resource and bumps its version). The top-level payload folding described in §4.2 is also applied to
the object passed to `applyManifestObject` (payload under `spec`), matching the game-model registry.

### 6.4 `ObjectiveEvaluator` / Exam Prep

Use `window.game.manifestEngine.getState()`:

- `manifest {file}` → `state.appliedFiles.some(f => f.path === file)` (or `hasAppliedFile(file)`).
- `kustomize {path}` → `state.appliedKustomize` / `hasAppliedKustomize(path)`.
- `template {name?, parameters?}` → `state.templates` (a processed template is recorded even before
  apply; `applied === true` after pipe/apply; `params` holds resolved values).
- `helm {release?, chart?}` → `state.helmReleases` / `listHelm()`.
- HTPasswd/OAuth → `htpasswdList()`, `htpasswdAuthenticate()`, `state.htpasswd`.

Because records are cleared by `resetFiles()`, levels that reset their files at start also start with
a clean declarative objective history (the cluster is reset separately by the mode).

---

## 7. Self-test evidence

Environment: Node v26.10.0, Chrome (puppeteer-core from `/tmp/verify-tools`). Test scripts live in
`/tmp` (not committed; the repo stays dependency-free).

1. **Syntax** — `node --input-type=module --check` for each file:

   ```
   js/engine/YamlParser.js     OK
   js/engine/ManifestEngine.js OK
   js/ui/ManifestPanel.js      OK
   js/data/ManifestFiles.js    OK
   ```

2. **Parser self-test** — `YamlParser.selfTest()`:

   ```json
   { "ok": true, "failures": [] }
   ```

   27 cases: mappings/types, comments, nested sequences, indentless sequences, multi-document split,
   empty docs, literal/folded/chomped block scalars, flow collections (multi-line), quoted escapes, JSON/root flow documents, dotted keys, template placeholders, invalid indentation (line number), unterminated quotes,
   stringify round-trips (maps, sequences, tricky strings, multi-doc), realistic Deployment, root
   scalars, empty collections.

3. **Model flow harness** — `/tmp/declarative-test.mjs` with a stubbed `window.game`
   (fake `ClusterState`, event recorder): **75 assertions, 0 failures**. Covers:
   every default file parses · file tree shape · apply deployment (create/update) · invalid YAML
   rejected without cluster changes (line 5 reported) · missing file · Service/Route apply · delete -f
   (+ NotFound) · Kustomize prod (namePrefix, namespace, commonLabels, image tag `1.0.0`, replicas 3,
   strategic patch env/resources, auto project, event, state record) · Kustomize dev · missing
   kustomization · template processing/substitution/typed replicas/required-parameter error/no apply
   event before apply · `applyObjects` marks template applied + emits `template:processed` ·
   `applyTemplate` · Helm install/list/upgrade with values file/reinstall rejection/uninstall/events ·
   HTPasswd add/list/hash format/no plaintext/auth/update/delete/errors · examples apply · the
   `gameEngine.applyManifestObject` path (create + update) · `resetFiles` · `deepMerge` list
   replacement · embedded parser self-test.

4. **Real CommandBar integration harness** — `/tmp/cli-integration-test.mjs` imports the actual
   `js/ui/CommandBar.js` from cli-dev and drives its delegated helpers: **23 assertions, 0 failures**:
   `oc apply -f` create/update, invalid YAML error surfaced through `result.error`, `oc apply -k`,
   `oc process`, `oc process | oc apply -f -` (template marked applied, event emitted), missing
   required template parameter, `oc delete -f` (NotFound + success), Helm install/list/uninstall
   error strings, HTPasswd add/list/verify/duplicate error.

5. **Browser panel harness** — `/tmp/panel-browser-test.mjs` (headless Chrome, module served from a
   temporary static server): **28 assertions, 0 failures**, no console/page errors:
   module loads without DOM at import, `init()` creates globals/testids, hidden initially, 19 files in
   the tree, default file selected, `show()` opens the overlay, `setContext` focus+highlight,
   focus opens the kustomization, Apply -k creates `prod-webapp` and emits `kustomize:applied`,
   file selection loads the editor, dirty badge, Save writes the virtual file, Apply -f creates the
   Deployment, missing kustomization error rendered, failed apply restores the last good file and
   reports the YAML line, Reset restores saved content, `show(resource)` opens
   `.oc/edit-deployment-webapp.yaml` and applies it, Esc closes, `destroy()` removes DOM/globals.

6. **Default-file round-trip** — all 18 YAML files in `MANIFEST_FILES`:
   `parse → stringifyYaml → parse` is deep-equal, and all parse without warnings.

7. **Real `index.html` smoke test** (headless Chrome, `app.showFiles()`): Files panel becomes visible
   with 19 files in the tree, editor populated with `manifests/deployment.yaml`, Esc closes it, and
   the page reports no console errors.

---

## 8. Limitations (simulator scope)

**YAML parser**

- No anchors/aliases, merge keys (`<<`), complex keys, custom tags (tags stripped), directives,
  or multi-line plain scalars.
- Flow collections do not support comments that themselves contain brackets.
- Block-scalar folding (`>`) is practical, not byte-for-byte YAML 1.2 (more-indented folded lines
  are folded like normal lines).
- Tabs are rejected in indentation; strings containing tabs are written as double-quoted scalars by
  the stringifier.
- Duplicate keys: last value wins (no error).

**Manifest engine**

- `oc create -f` is an upsert in the simulator (real `oc create` fails when the object exists);
  `oc replace -f` behaves like apply. This keeps level/reset replay forgiving.
- Invalid YAML/validation is transactional (nothing applied); a runtime error thrown mid-file by a
  custom `applyManifestObject` can leave earlier objects applied.
- **Auto-created projects**: when a manifest/kustomization targets a project that does not exist, the
  engine creates it (recorded in `autoCreatedProjects` + warning). Real OCP returns
  `namespaces "x" not found`; levels can disable this with
  `new ManifestEngine(game, {autoCreateProjects: false})`.
- No API-server validation of selectors, immutable fields, quota admission, SCC, or RBAC for
  declarative applies — those belong to the simulation/engine layers. Kind/apiVersion are validated
  against `kindRegistry`; unknown kinds are rejected.
- Kustomize: no generators (`configMapGenerator`, `secretGenerator`), `replacements`, `components`,
  JSON6902 patches, remote resources, or `$patch` directives. Strategic merge replaces lists
  (including `containers`); the newer `patches` field supports file-based strategic patches only.
- Helm: no subcharts, `_helpers.tpl`/`include`/`template`/`if`/`range`/`toYaml`, hooks, CRDs,
  dependency management, repositories or OCI charts. Values merging is deep-map/lists-replaced.
- `uninstallHelm` deletes the recorded objects by kind/name/namespace; objects already removed are
  reported in `notFound` (not an error).
- HTPasswd hashes are fake (`{SHA}` + deterministic digest) and only verifiable for users created by
  this engine; real bcrypt hashes are listed but cannot authenticate. OAuth wiring, secret creation
  and login flows are engine-dev/cli-dev responsibilities.
- The virtual FS is in-memory only (not persisted to localStorage). `resetFiles()` clears the
  filesystem and declarative records; the panel listens for `manifest:reset` to drop drafts.
- `ManifestPanel` is browser-only (`init()` no-ops without `document`); it owns its styles and appends
  to `<body>`, so no `index.html` edit is needed, but it also cannot be unit-tested without a DOM.

---

## 9. EX280V422 coverage

| Objective area                                    | Covered by                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Manage OpenShift declaratively                    | `applyFile` (create/update/delete), export/edit loop, Files panel editor                 |
| Work with Kustomize                               | `applyKustomize` base/dev/prod overlays, patches, images, replicas, namespace, labels    |
| Deploy applications from templates                | `processTemplate` + `applyObjects`/`applyTemplate`, parameters and message               |
| Deploy applications from Helm charts              | `installHelm`/`upgradeHelm`/`listHelm`/`uninstallHelm`, local chart                      |
| Configure developers' self-service (quota/limits) | `examples/quota.yaml`, `examples/limitrange.yaml` apply through the same engine          |
| Configure HTPasswd authentication                 | `htpasswdAdd/Update/Delete/List`, raw-password-free hash storage, `htpasswdAuthenticate` |
| Install/manage operators                          | `examples/subscription.yaml` apply; controller install/CSV states remain engine-dev      |
