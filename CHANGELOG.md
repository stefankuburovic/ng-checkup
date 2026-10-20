# Changelog

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
