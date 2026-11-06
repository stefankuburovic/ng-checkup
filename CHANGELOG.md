# Changelog

## Unreleased

- **Template speed** in the components area, as low findings and measures outside the grade, so no score changes: `*ngFor` without `trackBy` (`untracked-ngfor`), `@for` with `track $index` (`track-by-index`), method calls in template bindings (`template-method-calls`) and impure pipes a template uses (`impure-pipes`). A template is joined with the component class that owns it: a call counts only when that class declares the method, so a signal never does, and a constant array of the class is left out of the loop rules. A template no class owns is not read. On the corpus: 0 to 80 `*ngFor`, 0 to 12 `track $index`, 0 to 41 method calls and 0 to 2 impure pipes per repository, with all 149 method calls pointing at the line that makes them.
- **Heavy packages** in the bundle area, outside the grade: `moment`, whole `lodash`, `rxjs-compat` and `jquery` when startup code imports them or the build loads them through `scripts`, each with its lighter way out, and the measure `heavy-packages`. Without a stats file it is a low finding with no size; with one it is medium, gives the real size in the initial bundle and also names a listed package only another package pulls in. No saving is estimated. On the corpus: `moment` and `lodash` in airgap-wallet, `lodash` in go-data.
- **`ng-checkup diff <before.json> <after.json>`**: what changed between two saved reports, the proof of a piece of work: score, grades, measures that moved, new and resolved findings, in the terminal or as `.html`, `.md` or `.json`. Findings are matched as a whole and not file by file, since a report lists only a few example files. A measure only one report has is neither better nor worse, and the report says when the two come from different tool versions or a `--since` run. Always exits 0 on a comparison.
- **A README badge**: `--report badge.svg` writes the score and its colour as a self-contained SVG, in the same bands as the tables (80 and 50), and `--report badge.json` or `x.badge.json` writes the same badge as a shields.io endpoint. The tool does not commit or publish anything; the README shows both ways of keeping it fresh. Any other `.json` is still the full report.

## 2.0.2 (2026-11-03)

- **Test quality, fewer false positives.** A test that returns a promise (`() => new Promise((done) => ...)`, `return firstValueFrom(...)`) is awaited by the runner, so an assertion in its subscription is no longer reported as unwaited; neither is one inside `testScheduler.run(...)`, which runs its virtual time before it returns. A type test (`// @ts-expect-error` in the body) asserts at compile time and is no longer reported as asserting nothing. On rx-angular's main branch this takes the unwaited assertions from 22 to 1; on the corpus snapshot from 17 to 16, and the empty tests from 5 to 3.

## 2.0.1 (2026-11-03)

- Documentation only, so the npm page matches 2.0: the README lists every option of `--help` again (`--since`, `fleet`, `mcp`), counts the 19 corpus repositories and the 61 baseline measures, and `docs/checks.md` lists the six dead-code measures it was missing. The usage lines of `--help` name `fleet` and `mcp`. No check, grade or measure changed.

## 2.0.0 (2026-11-03)

A major release because the report grows: two new areas (`translations`, `accessibility`, both never graded, so no score changes) and new measures in three others, which a consumer counting areas or reading the JSON by position notices. Nothing is removed and no flag changes meaning; a baseline from 1.x keeps working, the new measures count as "not known yet", never as a failure. The GitHub Action moves to `@v2` and the GitLab component to `@2`; `@v1` and `@1` stay on 1.6.1.

- **Translations**, a new area (`translations`) that reports but is never graded, so no score changes: literal ngx-translate and Transloco keys judged against the JSON bundles of every language, merged deeply per language, Transloco scopes under their folder name. A key some language lacks while it knows the namespace, or another language has, is a medium finding and the measure `missing-keys`; a key under a namespace no bundle has is listed apart and not graded. Both libraries render a missing key as the key itself, which nothing else catches. On the corpus: 5 in airgap-wallet, all real (`walletconnect.error` against `walletconnect.connection_error`, `transaction-qr.qr-data-too-big_warning` in no language, three keys only English has); 0 of 2 858 in a 1 669-file production app whose own guard already holds it at 0. The measure sits in the baseline, so `--fail-on regression` fails on a new missing key. Keys in test code, inline test-host templates included, are not judged.
- **`ng-checkup fleet <list>`**: one page across many repositories, worst first, with the Angular version, score, high findings and a grade per area for each; local paths and remote repositories, offline unless `--online`, an entry that fails is a row saying why. `.html`, `.md` or `.json`.
- **Accessibility**, a new area (`accessibility`) that reports but is never graded: form controls without a label, buttons without a name, `(click)` on non-interactive elements without a key handler, images without `alt` and `tabindex` above 0, each a measure, read from every template with Angular's attribute spellings and `*-form-field` wrappers understood.
- **Test quality** in the testing area, as findings and measures outside the grade: tests that assert nothing (`tests-without-assertions`, medium; helpers, namespace assertions such as `expect.element` and Cypress commands count as asserting), assertions in a `.subscribe()` the test does not wait for (`unawaited-subscribe-assertions`, low) and spec files with `NO_ERRORS_SCHEMA` / `CUSTOM_ELEMENTS_SCHEMA` (`schema-suppressed-specs`, low). On the corpus: 5 empty tests and 17 unwaited assertions in rx-angular, 0 to 3 elsewhere.
- **`--since <ref>`** keeps only the findings in files changed since the merge base of the ref and `HEAD` (committed, uncommitted and untracked), for a pull-request comment without the backlog. Grades, score and measures stay the whole repository's; every format says the findings were narrowed. Also `since` in the API and the MCP `checkup` tool.
- **`ng-checkup mcp`**: a Model Context Protocol server on stdio with the tools `checkup`, `findings` (by area, severity or file) and `upgrade_plan`, for Claude Code, Cursor, Copilot and other MCP clients. Offline unless asked, one analysis cache per folder, no new dependency.
- **Azure DevOps and Bitbucket** in `init` and `ng add` (`--ci azure`, `--ci bitbucket`, detected from `azure-pipelines.yml` / `bitbucket-pipelines.yml`): a separate Azure pipeline that publishes the SARIF report as `CodeAnalysisLogs` for the Scans tab, and a Bitbucket pull-request step with the reports as artifacts, printed instead of written when `bitbucket-pipelines.yml` exists, since Bitbucket has no include.
- **Colour literals outside the design tokens** (`components.hardcoded-colors`, low): colours written into rules of `.css`/`.scss`/`.sass`/`.less` files and inline template styles, which a theme cannot reach. Custom-property and variable definitions and token-named files are not counted. On the corpus: 0 to 89 per repository.
- **Subscriptions nothing ends** (`components.unended-subscriptions`): a `.subscribe()` in a component or directive with no lifetime operator in its chain, no cleanup anywhere in the class, and a source that outlives the component, a low finding of its own. `HttpClient`, `ActivatedRoute`, `valueChanges`, a dialog's close event, `translate.get()` and the class's own subjects are left out. `takeWhile(() => this.alive)` counts as an ending too. On the corpus: 0 to 25 per repository.

## 1.6.1 (2026-11-03)

- **The npm package is now `ng-checkup-cli`.** The name `ng-checkup` is no longer available to me on npm, so from 1.6.1 on it is published as `ng-checkup-cli`: run `npx ng-checkup-cli`, install `npm i -D ng-checkup-cli`, add it with `ng add ng-checkup-cli`, import from `ng-checkup-cli`. The installed binary is still `ng-checkup`, so an existing `"checkup": "ng-checkup"` script keeps working once the dependency is swapped. Versions up to 1.5.0 stay on npm as `ng-checkup`.
- The GitHub Action and the GitLab component run `ng-checkup-cli` for 1.6.1 and later, and `ng-checkup` for an older `version:` / `NG_CHECKUP_VERSION`.
- `init` and `ng add` add `ng-checkup-cli` to `devDependencies`, unless the project already has either name. Code is unchanged from 1.6.0, which was tagged but never reached npm.

## 1.6.0 (2026-11-03)

- The bundled Angular versions are refreshed (20.3.35, 21.2.26, 22.2.4).
- **Dead code.** The architecture area lists the application files nothing imports and the components and pipes no template uses, each as a low finding and a baseline measure (`unused-files`, `unused-components`, `unused-pipes`), so a baseline holds them from growing; neither changes the grade. A component counts as used when a template has its tag or a file names its class outside the `declarations`/`imports`/`exports` arrays (a route, a dialog, `bootstrap`); a pipe when a template calls it or a file injects or provides it. Workers loaded through `new URL(..., import.meta.url)`, Angular 7 string `loadChildren`, build-option files, library entries and files outside a project's `sourceRoot` are never reported. On the corpus: 0 to 5 unused files in most repositories (airgap-wallet's unrouted `scan-sync.module.ts`, four pipe files nothing imports in scion-workbench), 24 and 26 in the flights42 and rx-angular demo apps; 5 unused components in airgap-wallet, four of them used only in commented-out HTML.
- **`--attribute-selectors`** (config `attributeSelectors`, option `attributeSelectors`) also lists directives, and components with an attribute selector (`[appTooltip]`, `button[mat-button]`), that no template matches, under a measure of its own (`unused-attribute-selectors`). An attribute counts as an attribute, a binding, a `*` structural directive or an output binding, as Angular matches them. It also lists the inputs and outputs no template binds and no code sets by name (`setInput`, `inputBinding`, an Ionic `componentProps`), under `unused-inputs` and `unused-outputs`; names are compared across the repository, so the list can miss unused ones but not call a bound one unused. Opt-in, since matching attributes is looser than matching tags. On the corpus it reports no directives and 0 to 10 unbound inputs in most repositories, typically inputs with a default no caller sets (ngx-admin's `thumbRadius`, go-data's `displayDisclaimer`).
- Imports through `baseUrl` (`'src/app/x'` without a `paths` entry) are followed by the cycle search, the eager-route analysis and the spec coverage too; they were only resolved through `paths`. On the corpus this moves beaconchain-app's components and services with a spec from 65% to 69%.
- Projects carry their `sourceRoot` (declared, else `<root>/src`).

## 1.5.0 (2026-10-29)

- **Per-project baselines.** In a workspace with several Angular projects, `ng-checkup baseline` records each project's numbers next to the workspace's (`projects` in `ng-checkup.baseline.json`), and a `--project` run compares with its own entry, so `--project admin --fail-on regression` now works: it fails on admin's numbers, not on another team's library. Before, `--project` runs were never compared and the combination was refused. The Angular version and package measures stay with the whole-workspace run. Each project's numbers may only go down, like the workspace's; `baseline` refuses `admin:type-safety.explicit-any: 2 -> 3` even when code only moved between projects. A baseline without `projects` still reads (the format stays version 1); `--project --fail-on regression` against one says to run `ng-checkup baseline` once. The JSON report's project rows gain `measures`.
- The strictness findings (`strictNullChecks`, `noImplicitAny`, `strictTemplates` is off) point at the tsconfig line that decides the flag, following `extends` to the file that sets it or the `strict` that implies it, or at the application tsconfig when nothing sets it. They were attached to no file, so SARIF annotations and the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=stefankuburovic.ng-checkup-vscode) showed them on `package.json`. Corpus snapshots gain these locations; no grade changes.

## 1.4.1 (2026-10-28)

- Lines of code count only lines that hold code: blank lines and comment-only lines are left out. A codebase that documents every member (one went from 27 to 44 "files over 500 lines" just by adding JSDoc) is no longer reported as full of large files, and densities such as `any` per 1 000 lines are measured against code. Corpus snapshots updated; one repository's type safety moves from good to fair because its `any` density was diluted by comments before.
- A `.subscribe()` on a local variable counts as tied to the component's lifetime when the variable was bound where it was declared (`const order$ = x.pipe(takeUntilDestroyed(...)); order$.subscribe(...)`, or a local factory such as `const name$ = (iri) => api.get(iri).pipe(take(1))`).

## 1.4.0 (2026-10-23)

- **Trend in CI.** `--trend <file.json>` compares a run with a trend file, and `--trend-record` adds the run to it. Every report shows the last 30 days in one line: `Score 72, +4 since 2026-09-23 ▃▄▄▆▇ · initial bundle 812 kB, +23 kB`, and the Markdown report lists the measures that moved most.
- **The bundle from now on.** A trend point keeps the largest application's initial bundle from the build's stats file. `ng-checkup history` cannot follow the bundle backwards, since old commits cannot be rebuilt reliably; the trend follows it forwards, from the first recorded run.
- The GitHub Action keeps the trend in the Actions cache (input `trend`, on by default): default-branch pushes record, pull requests read and show it in their comment. Both GitLab integrations keep it in the CI cache, shared with merge request branches, which only read it (input `trend` in the component, `NG_CHECKUP_TREND` in the template). Run on the default branch as well as on pull requests to get a trend.
- An older `version` than 1.4.0 in the Action or the GitLab integrations simply runs without the trend.

## 1.3.0 (2026-10-23)

- **Manual subscriptions:** the components area counts `.subscribe()` calls in components and directives, and how many are not tied to the component's lifetime (no `takeUntilDestroyed`, `takeUntil`, `take` or `first` in the chain). It is a low finding and a new baseline measure, so `ng-checkup history` shows the curve a move to signals should bring down. On the corpus: 601 in go-data, 103 in scion-workbench of which 13 unbound, 22 in the RealWorld app. Suggested by Amir Mohammad Iravani.
- `--verbose` keeps the top priorities at the end of the terminal output; they were left out in verbose mode.

## 1.2.1 (2026-10-23)

Three changes from review on a real codebase, where the report read as harsher than the code:

- **Architecture:** file size alone no longer makes the area poor. An app with every route lazy and no constructor injection was graded poor for three files over 1 000 lines; long files now cap the grade at fair, and the hotspots say which to split first.
- **Explicit `any`:** an `any` that an eslint directive exempts from `no-explicit-any` (on its line, the line before, or in a `/* eslint-disable */` … `/* eslint-enable */` block) is left out of the count and reported apart as an info finding, so the number matches the project's own lint rule. A codebase whose lint gate says 0 was shown 28, all of them deliberate.
- **Specs:** a file counts as tested when any spec imports it, not only when `x.spec.ts` sits next to it, and signal stores and utility files get their own metric ("Stores and utilities with a spec") and count toward the grade. The baseline measure stays components and services only, so existing baselines do not fail on the upgrade; it can only go down.

## 1.2.0 (2026-10-23)

- **Health Check report 2.0** (`--client`):
  - `--history` adds "How the code got here": the score and the measures that moved most over the last twelve months, as charts, from the git history of a local checkout. A repository without usable history still gets the rest of the report.
  - The key figures show the known vulnerabilities of the direct dependencies and how many imports the next Angular major removes.
  - "Where refactoring pays off first" lists the hotspots, the large files changed most often.
- `ng-checkup history` counts its months back from the last commit, not from today, so a repository nobody has committed to for a while still gets one point per month; a clean working tree is no longer counted twice as HEAD and "now", and "now" labels the last point only when it is recent.
- Charts live in their own module and are shared by the history page and the client report.

## 1.1.0 (2026-10-23)

- **What the next major breaks.** The deprecated-APIs area downloads the next Angular major's type definitions for the `@angular/*` and `@ngrx/*` packages the code imports and compares them with the installed ones. An imported name the next major no longer exports is a `high` finding (that import stops compiling after `ng update`), and the upgrade plan's first step lists it; a name or enum member the next major newly deprecates is a `low` finding that does not change the grade. On the corpus: `Resolve` deprecated in Angular 15 for go-data, `ChangeDetectionStrategy.Default` and `withFetch` deprecated in 22 for rx-angular; online, OrientDB Studio's `Class` import is gone in Angular 5.
- **During an Angular RC**, a project on the latest major is compared with npm's `next` prerelease, so the report says what the coming major breaks before it ships.
- `BUNDLED_LATEST_ANGULAR_MAJOR` is read from the version snapshot, and `scripts/update-angular-versions.mjs` falls back to the newest stable release of a major whose `vN-lts` tag is not set yet. Supporting a new major starts with one script run; the rest is in `docs/new-angular-major.md`.
- `compareNextMajor: false` turns the comparison off, for runs that must be reproducible (the corpus uses it).

## 1.0.1 (2026-10-23)

- History charts put the points on a time axis. A month without a commit has no point, and evenly spaced points drew a five-month pause as one step; the axis now reads by year for a long history and by month for a short one, with the last point marked "now".
- A codebase without `angular.json` or an Nx workspace is named by what it is in the report header: "Primo VE package", "AngularJS app", "AngularJS and Angular hybrid", or "custom build", instead of "unknown workspace".

## 1.0.0 (2026-10-23)

The command line, the config file, the JSON report and the baseline format are now stable: a change that breaks one of them gets a new major version.

- **`ng-checkup history`**: how the score and every measure moved over the last months. It extracts the last commit of each month with `git archive` into a temporary folder (the working tree is never touched), runs the checkup offline on each, and ends with the working tree. `--points` sets the months (default 12); `--report history.html` draws the score and the measures that moved most as charts, `.md` and `.json` work too. On the RealWorld example app it shows 36 months from Angular 16 at 60 to Angular 21 at 91, with 27 legacy `*ngIf`/`*ngFor` gone.
- **Known vulnerabilities**: the security area looks up every direct dependency at its exact version in [OSV](https://osv.dev), the GitHub advisories for npm, and AngularJS from Bower, a CDN or a checked-in copy as `angular`. A finding per package with CVE ids and the nearest fixed version; dev-only dependencies get a separate low finding. A high or critical advisory in a runtime dependency grades security poor, a moderate one fair. Not a baseline measure, since the count grows when advisories are published. Skipped with `--offline`.
- **Hotspots**: in a git repository, the architecture area ranks the large files changed most often in the last twelve months (300 lines and 10 commits at least, lines times commits), the five worst listed. Never graded, never a measure. A shallow clone says it has no history.
- **`--only` and `--skip`** (and the `only` / `skip` config keys): choose the areas a report covers, by check id. Every check still runs; the others stay out of the report, the score and the baseline. An unknown id is a usage error that lists the valid ones.
- The GitHub Action and the GitLab template move to the **`v1`** tag (`uses: stefankuburovic/ng-checkup@v1`, `…/ng-checkup/v1/gitlab/ng-checkup.yml`), and the GitLab Catalog component can be included as `@1`. `v0` stays on 0.12.0.
- `collectHistory`, `movedMeasures`, `renderHistoryHtml` and `renderHistoryMarkdown` are exported.

**Upgrading from 0.x:** a run that passed `--fail-on poor` can fail on 1.0.0 when a runtime dependency has a high or critical advisory. That is the point of the check; until the dependency is upgraded, `--skip security` or `--fail-on regression` with a baseline keeps CI green. Nothing else changes for an existing setup.

## 0.12.0 (2026-10-23)

- **`ng-checkup url <address>`**: which framework a public web app runs, from what a browser downloads. Reads the page and up to 12 scripts of the same site, following the chunks they import, and recognises AngularJS and Angular with versions (license header, version object, `new Version(...)` including template-literal builds, `ng-version`), zone.js, React with its version, Vue, Next.js and Nuxt, also several in one app. Third-party scripts are skipped, except AngularJS from a public CDN; `--json` for scripts. Checked on angular.dev, material.angular.dev, angularjs.org, react.dev, vuejs.org and nuxt.com.

## 0.11.1 (2026-10-22)

- An Angular app in a subfolder is found: when the root has no `angular.json`, no Nx workspace and no `@angular/core`, and exactly one subfolder has an `angular.json`, the workspace is read from there (package.json, lockfile, tsconfig, build targets), and the report header names the folder. Before, a repository like privacyIDEA (a Python server with its Angular UI in `privacyidea/static`) had no Angular version, no tsconfig, and every route counted as eager. With several such subfolders, the version area names them.
- The CI flow diagram is in the README.

## 0.11.0 (2026-10-22)

- **Primo VE to NDE.** A repository with an Ex Libris Primo VE customization package gets a Primo NDE migration area instead of the AngularJS one: the hooks to rebuild in the NDE custom module, view by view, `parentCtrl` reads with the paths read most, third-party integrations (BrowZine/LibKey, Altmetric, Unpaywall, LibChat, analytics, …), static home pages and the central package of a network. `--plan` gives the move to NDE in four phases, also in the client report. NDE is announced as the only Primo UI from January 2028, and VE customizations do not carry over.
- AngularJS: a registration is counted once per name and kind within a folder, so a concatenated `custom.js` checked in beside its sources no longer doubles the numbers. On the corpus this took one service off orientdb-studio, two modules registering the same factory name in one folder.
- The corpus has two Primo VE packages: SLSP's swisscovery union view and Brandeis University's view.

## 0.10.1 (2026-10-22)

- Templates: markup inside HTML comments (`<!-- … -->`) is no longer counted. Commented-out `*ngIf`/`*ngFor`, `[innerHTML]` bindings and AngularJS attributes were reported as live code; on a 460-template app fully on built-in control flow, all 33 `*ngIf`/`*ngFor` reported as deprecated sat in comments. Line numbers after a comment are unchanged. On the corpus: 4, 1 and 1 fewer legacy directives in three repositories.
- README links the GitLab CI/CD Catalog component.

## 0.10.0 (2026-10-22)

- **AngularJS and hybrid apps.** A repository with AngularJS code or packages gets a thirteenth area, AngularJS migration, at the top of the report. It reads JavaScript as well as TypeScript, counts components, directives, controllers, services, filters and templates with AngularJS syntax, names what makes them hard to move (controllers, `$scope`, scope events, runtime `$compile`, `$watch`, `ng-include`, directives `UpgradeComponent` cannot wrap), maps AngularJS packages to their Angular replacements, and finds the version in `package.json`, the lockfile, `bower.json`, a CDN script tag or a checked-in `angular.js`. A hybrid app (`UpgradeModule`, `downgradeModule`, `UpgradeAdapter`) gets the share of components already on Angular. Six new measures, so a baseline keeps a running migration from growing back.
- **Migration plan:** `--plan` adds `report.migration`, four phases from AngularJS to Angular with this codebase's counts, in every format and in the client report's roadmap and notes template.
- An AngularJS app is no longer graded 100/100 for having no TypeScript: circular dependencies are `info` without TypeScript application code, and the zone.js finding needs `@angular/core` or components.
- The corpus has four AngularJS repositories: the AngularJS tutorial app, an ES-module AngularJS app, a hybrid on Angular 4 and one on Angular 22. Its first run found a false positive before release: `ng-reflect-*` attributes pasted from dev tools into an Ionic template.

## 0.9.1 (2026-10-21)

- Code Quality fingerprints ignore singular and plural as well as numbers. In the first real merge request, "1 component uses…" turning into "2 components use…" showed an unchanged file as resolved and new in the widget.

## 0.9.0 (2026-10-21)

- **GitLab:** `include: remote: …/ng-checkup/v0/gitlab/ng-checkup.yml` adds a job that puts the findings in the merge request's Code Quality widget (GitLab lists what the MR introduces and resolves, on every tier), keeps the reports as artifacts, and writes one merge request comment, edited on every push, when `NG_CHECKUP_TOKEN` is set. Runs on merge requests and on the default branch.
- `--report x.codequality.json`: the GitLab Code Quality format. Fingerprints leave out counts and line numbers, so a finding stays the same finding while its numbers change.
- `ng-checkup init` writes the GitLab job as an include of that template.
- The pull-request comment's footer no longer says "workflow run", since GitLab uses it too.

## 0.8.0 (2026-10-21)

- **GitHub Action:** `uses: stefankuburovic/ng-checkup@v0`. One pull-request comment, edited in place on every push, with the measures that got worse or better than the baseline, a grade per area and the top priorities; the same in the job summary; the HTML, Markdown and JSON reports as an artifact; optionally SARIF to code scanning (paths fixed up for a monorepo folder). `fail-on` fails the job. Needs no `npm ci`.
- `--report x.comment.md`: the short pull-request comment format, also usable from any other CI.

## 0.7.0 (2026-10-21)

- **Client report:** `--client "<name>"` writes the HTML report as a deliverable: a cover, a summary in sentences, the key figures, what to act on, the roadmap per major, then the consultant's recommendations from `--notes` (Markdown), with the full report as an appendix. The first run creates the notes as a template prefilled with the upgrade steps and an empty estimate column. Prints to PDF with the cover, notes and appendix on their own pages. `--prepared-by` (or `NG_CHECKUP_PREPARED_BY`) names the author; the codebase is named by its repository and commit, never a local path.
- **Generated files** (a leading `@generated` or "do not edit" comment, `generated-types.ts`, `*.generated.ts`, `*.gen.ts`, a `generated` folder) are left out of every count of application code and reported as such. On the corpus this only moved the Vendure storefront: its GraphQL types took explicit `any` from 318 to 66.

## 0.6.0 (2026-10-21)

- **No `npm install` needed.** Without `node_modules`, exact versions come from the lockfile (`package-lock.json`, `yarn.lock` classic and Berry, `pnpm-lock.yaml` v5 to v9), the `@angular/*`, `@ngrx/*` and `rxjs` typings of those versions are downloaded once from npm (only `package.json` and `.d.ts` files are kept, in `~/.cache/ng-checkup`), and third-party peer ranges come from the registry. Works on a fresh clone and in CI before `npm ci`. `--offline` uses only what is cached.
- **Remote repositories:** `npx ng-checkup github:owner/repo`, `gitlab:group/app#ref`, a GitHub or GitLab URL, or any `.git` URL. One commit is cloned into a temporary folder, checked and deleted; the report names the repository and commit.
- Peer ranges are read as packages really publish them: `>= 14.x <= 21.x` (with spaces and partial versions) and hyphen ranges. `@sentry/angular` was reported as not accepting the Angular version it supports.
- The deprecated-API summary counts `.toPromise()` calls when they are the only finding.
- The version metric says where the version came from: `node_modules`, the lockfile, or the `package.json` range.
- The corpus prefetches typings into `.corpus/.typings`, so its snapshots now cover deprecations and stay reproducible offline.

## 0.5.3 (2026-10-21)

- Circular dependencies: an import the file uses only as types is no longer an edge. TypeScript erases it even without `import type` (a class used as `store: Store`, a name that is `export type`, directly or through a barrel), so it cannot form a runtime cycle. Constructor parameters of decorated classes still count, since Angular turns them into DI tokens. On the corpus this took one library from a 123-file group to real cycles of 40 and 20 files, and an app with 13 files in cycles to none.
- Version: a project counts as "built with the webpack builder" only when it has no esbuild build; an extra webpack target kept on purpose beside one no longer does.
- `npm run corpus`: 13 public Angular repositories at pinned commits, compared with committed snapshots in CI.

## 0.5.2 (2026-10-20)

- Security: HTML the code writes itself is no longer flagged. `el.innerHTML = ''` (clearing an element) and fixed markup carry no input; only values that are not constant strings count as direct DOM writes.
- Test code is recognised beyond `*.spec.ts`: Protractor's `*.e2e-spec.ts` and page objects, Cypress files, mocks, and the `e2e`, `cypress`, `test-config` and `__mocks__` folders. Their `any`, cycles and size no longer count against the application; the spec count still counts unit specs only.
- Upgrade plan: a project already on angular-eslint that still lists `codelyzer` or `tslint` is told to remove the leftovers (`npm uninstall …`), not to move to ESLint.

## 0.5.1 (2026-10-20)

- Third-party compatibility no longer grades end-of-life tooling (`codelyzer`, `tslint`, `protractor`, ...). The version check already reports it for removal, and the upgrade plan removes it in its first step, so it was counted twice and could make the area poor on its own.
- "1 package depends on Angular", not "depend".

## 0.5.0 (2026-10-20)

- Four new areas, twelve in all:
  - **Third-party compatibility**: the Angular peer range of every installed package, which upgrade step it blocks, and (online) the release that supports each next major and npm deprecations. With `--plan`, each package update is scheduled at the step that needs it.
  - **Architecture**: eager vs. lazy routes (a `component:` route inside a lazily loaded module counts as lazy), files over 500 and 1 000 lines, constructor injection and class-based guards and interceptors.
  - **Security**: `bypassSecurityTrust*`, HTML written straight into the DOM, `eval` / `new Function`, `[innerHTML]` bindings.
  - **Bundle size**: the initial bundle from the last `ng build --stats-json` (esbuild metafile or webpack stats) against the build's own budget, with its largest packages.
- RxJS deprecations from its installed type definitions, and `.toPromise()` calls on RxJS 7+.
- `--watch`: re-runs on every save and shows how the score and each measure moved since the watch started. Only changed files are parsed again; the registry is asked again only when dependencies change.
- `--report x.sarif`: SARIF 2.1.0 for GitHub code scanning, one rule per area.
- Monorepos: a per-project table, worst first, graded on each project's own files and tsconfig; projects without Angular code are left out. `--project <name>` narrows the report to one project.
- Fixed: an HTML report written inside the analysed folder was read back as a template on the next run.
- 11 new baseline measures (33 in all). An existing baseline keeps working: new measures are listed as added, never as regressions.

## 0.4.0 (2026-10-20)

- `--plan`: the upgrade from the installed Angular to the latest, one major at a time. Each step has its `ng update` command, the Node.js, TypeScript, RxJS and zone.js ranges that major requires (flagged where the project is outside them), and the migrations this code needs, scheduled at the first step that ships them, with counts. In every report format and in `report.plan`.
- Requirements come from a snapshot of the npm registry (`scripts/update-angular-versions.mjs`), so the plan works offline.
- `plan` config key.

## 0.3.0 (2026-10-20)

- Baseline mode. `ng-checkup baseline` records 22 counts (explicit `any`, `x!`, files in import cycles, components without OnPush or a spec, deprecated API uses, ...) in `ng-checkup.baseline.json`, and `--fail-on regression` fails CI only when one of them goes up. Updating the baseline may only lower numbers; `--force` accepts an increase.
- Every run with a baseline shows what got worse and better, in the terminal, Markdown and HTML reports.
- `ng add` and `init` create the first baseline and set CI to `--fail-on regression`, so an existing codebase can adopt the check on day one. An older workflow that still runs `--fail-on poor` is pointed out.
- Each check now returns `measures`; the baseline functions are exported.

## 0.2.0 (2026-10-20)

- `ng add ng-checkup` and `npx ng-checkup init`: a `checkup` script, `ng-checkup.config.json`, the reports in `.gitignore` and a CI step for GitHub Actions or GitLab CI, in one command. Idempotent, `--dry-run`, never overwrites your files.
- `ng-checkup.config.json`: `reports`, `failOn`, `maxExamples`, `offline` and `ignore`, each overridden by its flag. Unknown keys and wrong types are errors. `--config` points at another file.
- `ignore` patterns leave paths out of the analysis (`src/legacy`, `**/generated`, `apps/*/e2e`).
- The package exports `renderHtml`, `renderMarkdown`, `overallScore`, `topPriorities`, `loadConfig` and `planInit`.
- New README with screenshots, a live example report and per-check docs in `docs/checks.md`.
- Type safety follows version defaults: an unset `strict` counts as on from TypeScript 6 and an unset `strictTemplates` from Angular 22, so a new Angular 22 project is no longer graded poor.
- `ng add` works with the Angular CLI: `package.json` is now reachable through the `exports` map.
- Deprecations are also read from Angular packages that predate the `exports` map (Angular 12 and older), so `@angular/core/testing` and similar entry points are covered.

## 0.1.0 (2026-10-19)

First release: eight graded checks, terminal, HTML, Markdown and JSON reports, `--fail-on` for CI.
