# Changelog

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
