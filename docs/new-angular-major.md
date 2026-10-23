# Supporting a new Angular major

What to do when Angular publishes a new major, so ng-checkup knows it the same week. Written for Angular 23; the steps are the same for every major.

## While it is in prerelease

Nothing has to be released for this phase. As soon as npm's `next` tag of `@angular/core` is a prerelease of the coming major (`23.0.0-next.0`, later `-rc.N`), every online run on a project that is on the current major compares its imports with that prerelease's typings. The deprecated-APIs area then says what the new major removes ("1 imported API removed in Angular 23 (23.0.0-rc.1, a prerelease)") and newly deprecates.

1. Run the checkup online on the corpus projects that are on the current major (`flights42`, `ionic-conference-app`, `scion-workbench`, `ui-router-hybrid` for 22). What it finds there is the material for the release-day post: real removals in real code.
2. Read the prerelease's changelog for changed defaults and new `ng generate` migrations. Those are the code changes of release day (step 2 below).

## On release day

1. **Numbers.** `node scripts/update-angular-versions.mjs` adds the new major to `src/angular-versions.ts` with its Node.js, TypeScript, RxJS and zone.js ranges. `BUNDLED_LATEST_ANGULAR_MAJOR` is read from that snapshot, so nothing else holds the number. The script falls back to the newest stable release of a major whose `vN-lts` tag the registry has not set yet.
2. **Defaults and migrations.** Only the new major's release notes can say these:
   - a default that changed (as OnPush did in 22, zoneless in 21, `strictTemplates` in 22) goes into the check that interprets it: `checks/change-detection.ts`, `checks/components.ts`, `checks/type-safety.ts`, and the "is the default since" wording in `site.ts`;
   - a new migration (`ng generate @angular/core:…`) becomes a `once(…)` item in `plan.ts`, scheduled at the new major, with the count of places it touches;
   - deprecation rules need nothing: they come from the new major's typings, and "deprecated two majors ago" moves along by itself.
3. **Tests and corpus.** `npm test`, then `npm run corpus`. Projects on the previous major now read "1 major behind", and their snapshots change accordingly; read the diff, then `node scripts/corpus.mjs --update`.
4. **Release** as a minor version: CHANGELOG entry, `npm version <x.y.0> --no-git-tag-version`, `NG_CHECKUP_VERSION` in `gitlab/ng-checkup.yml`, commit, push.
   - `npm whoami` first; an expired web login fails the publish with a 404. `npm publish --auth-type=web` needs the security key.
   - Move the `v1` tag only after the tarball answers 200, in the same command: `[ "$(curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ng-checkup/-/ng-checkup-<x.y.0>.tgz)" = 200 ] && git tag -f v1 && git push -f origin v1`. A `v1` that names an unpublished version breaks every `@v1` workflow.
   - GitLab CI/CD component: bump the `version` input default, commit, tag the same number.
5. **Show it.** Regenerate the example reports on the offer page, and write the post: what the new major removes and deprecates, with numbers from step 1 of the prerelease phase.
