# Changelog

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
