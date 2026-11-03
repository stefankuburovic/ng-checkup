import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSpecFile } from '../files.js';
import type { CheckResult, Finding, Grade } from '../types.js';
import { applicationFiles, formatCount, percent, plural, specFiles, verb, type AnalysisContext } from './context.js';

/** A unit-test runner the check recognises. */
type Runner = 'Karma' | 'Jest' | 'Vitest';

/**
 * The unit-test runner, how much of the code has a spec, and the end-to-end
 * setup.
 *
 * "Has a spec" is a proxy for coverage, not coverage: a file counts as tested
 * when `x.spec.ts` sits beside `x.ts`, or when any spec imports it (directly
 * or through a barrel). The second half matters for stores and utilities,
 * whose specs often live in a folder of their own and are where the real
 * logic coverage of a codebase is; counting by neighbour alone reported such
 * a codebase as barely tested. It needs no test run and no coverage report,
 * which is what lets this tool run in a minute on a repository it has never
 * seen; real coverage is lower or higher depending on what the specs assert.
 *
 * Stores and utilities are counted beside components and services, in a
 * metric of their own, and the grade reads all of them together. The
 * baseline measure stays components and services only: widening it would
 * make every existing baseline fail on the upgrade without a line changing.
 */
export function testingCheck(context: AnalysisContext): CheckResult {
  const { workspace } = context;
  const runners = detectRunners(context);
  // Unit specs only: mocks, page objects and e2e files are test code but not specs.
  const specs = specFiles(context).filter((file) => isSpecFile(file.path));
  const testable = applicationFiles(context).filter((file) => file.components.length > 0 || file.injectables > 0);
  const specPaths = new Set(specs.map((file) => file.path));
  const hasSpec = (file: (typeof testable)[number]): boolean => specPaths.has(file.path.replace(/\.ts$/, '.spec.ts')) || context.specImports.has(file.path);
  const untested = testable.filter((file) => !hasSpec(file));
  const coverage = percent(testable.length - untested.length, testable.length);
  // Signal stores and utility files: logic without a component or an @Injectable class, where specs are cheapest and count most.
  const logic = applicationFiles(context).filter(
    (file) =>
      file.components.length === 0 &&
      file.injectables === 0 &&
      (file.calls.has('@ngrx/signals#signalStore') || /(^|\/)(utilities|utils|helpers)\//.test(file.path) || /\.(utility|util|helper)s?\.ts$/.test(file.path)),
  );
  const logicTested = logic.filter(hasSpec).length;
  const overall = percent(testable.length - untested.length + logicTested, testable.length + logic.length);
  const jasmineCalls = specs.reduce((sum, file) => sum + file.jasmineCalls, 0);

  const protractor = 'protractor' in workspace.dependencies || workspace.targets.some((target) => target.builder.endsWith(':protractor'));
  const e2e = protractor ? 'Protractor' : '@playwright/test' in workspace.dependencies ? 'Playwright' : 'cypress' in workspace.dependencies ? 'Cypress' : undefined;

  const findings: Finding[] = [];
  if (runners.has('Karma')) {
    findings.push({
      severity: 'high',
      message: 'Unit tests run on Karma, which is deprecated',
      detail: `Karma was deprecated in 2023 and receives no further development. Vitest is the Angular CLI's default runner since v21 (\`@angular/build:unit-test\`). ${
        specs.length === 0
          ? 'With no specs written yet, moving costs only the configuration, and the first specs can be written for Vitest directly.'
          : `Moving means replacing ${plural(jasmineCalls, 'Jasmine-specific call')} (\`spyOn\`, \`jasmine.*\`) with their Vitest equivalents across ${plural(specs.length, 'spec file')}.`
      }`,
    });
  }
  if (specs.length === 0 && testable.length > 0) {
    findings.push({ severity: 'high', message: 'No unit tests found', detail: `${plural(testable.length, 'component and service file')} without a single spec. Every refactoring and upgrade step is verified by hand.` });
  } else if (testable.length > 0 && coverage < 60) {
    findings.push({
      severity: coverage < 30 ? 'medium' : 'low',
      message: `${100 - coverage}% of components and services have no spec`,
      detail: 'A file counts as tested when `x.spec.ts` sits beside it or any spec imports it, so a spec that asserts nothing still counts. It is a lower bound on where an upgrade would be verified by hand.',
      files: untested.slice(0, context.maxExamples).map((file) => ({ path: file.path })),
      count: untested.length,
    });
  }
  if (protractor) {
    findings.push({ severity: 'high', message: 'End-to-end tests use Protractor, which is end of life', detail: 'Protractor reached end of life in 2023 and gets no fixes, including for new browser versions. Playwright and Cypress are the usual replacements.' });
  } else if (!e2e && testable.length > 0) {
    findings.push({ severity: 'info', message: 'No end-to-end test setup found', detail: 'Neither Playwright nor Cypress is a dependency. A handful of smoke tests over the main flows is the cheapest safety net for an upgrade.' });
  }

  // Test quality: tests that cannot fail. Findings and measures, never part of the grade, since each is read from syntax and errs towards silence.
  const quality = specs.flatMap((file) => (file.testQuality ? [{ path: file.path, ...file.testQuality }] : []));
  const qualityFinding = (lines: (entry: (typeof quality)[number]) => number[], severity: Finding['severity'], message: (count: number) => string, detail: string): number => {
    const hits = quality.filter((entry) => lines(entry).length > 0);
    const count = hits.reduce((sum, entry) => sum + lines(entry).length, 0);
    if (count > 0) {
      findings.push({ severity, message: message(count), detail, files: hits.slice(0, context.maxExamples).map((entry) => ({ path: entry.path, line: lines(entry)[0] })), count: hits.length });
    }
    return count;
  };
  const withoutAssertions = qualityFinding(
    (entry) => entry.withoutAssertions,
    'medium',
    (count) => `${plural(count, 'test')} ${verb(count, 'asserts', 'assert')} nothing`,
    'No `expect`, no assertion helper and no function of the file that asserts is called in the test body, so it passes whatever the code does; it only fails when the code throws. The usual causes are a test that renders a component and stops (`should create` without `toBeTruthy()`), an assertion moved into a helper that never got called, and a placeholder that was never filled in. Skipped tests (`xit`, `.skip`, `.todo`) are not counted.',
  );
  const unawaited = qualityFinding(
    (entry) => entry.unawaitedSubscribeAssertions,
    'low',
    (count) => `${plural(count, 'assertion')} inside a \`.subscribe()\` the test does not wait for`,
    'The `expect` sits in a subscribe callback, and the test neither takes `done`, nor runs in `fakeAsync` / `waitForAsync`, nor awaits or flushes anything. When the source is asynchronous (HTTP without `expectOne().flush()`, a timer, a promise) the test ends before the callback runs and passes without asserting. A synchronous source (`of()`, a `BehaviorSubject`) does run it, which the code cannot show, hence low. `expect(await firstValueFrom(source$))` asserts either way.',
  );
  const schemaSuppressed = qualityFinding(
    (entry) => entry.schemaSuppressions.slice(0, 1),
    'low',
    (count) => `${plural(count, 'spec file')} ${verb(count, 'silences', 'silence')} template errors with \`NO_ERRORS_SCHEMA\` or \`CUSTOM_ELEMENTS_SCHEMA\``,
    'Both schemas turn an unknown element or property into silence, so a misspelt input or a component missing from `imports` passes the spec and fails in the app. In `configureTestingModule` they do not even apply to a standalone component\'s own template; there they only look like protection. Stub the child components or import the real ones instead.',
  );

  const grade: Grade = testable.length === 0 ? 'info' : runners.has('Karma') || protractor || specs.length === 0 ? 'poor' : overall < 30 ? 'fair' : 'good';

  return {
    id: 'testing',
    title: 'Testing',
    grade,
    summary: `${runners.size > 0 ? [...runners].join(' + ') : 'No unit-test runner detected'}, ${plural(specs.length, 'spec file')}, ${coverage}% of components and services with a spec${logic.length > 0 ? `, ${percent(logicTested, logic.length)}% of stores and utilities` : ''}.`,
    metrics: [
      { label: 'Unit-test runner', value: runners.size > 0 ? [...runners].join(' + ') : 'none' },
      { label: 'Spec files', value: formatCount(specs.length) },
      { label: 'With a spec', value: `${coverage}%`, hint: `${formatCount(testable.length - untested.length)} of ${plural(testable.length, 'component/service file')}` },
      ...(logic.length > 0 ? [{ label: 'Stores and utilities with a spec', value: `${percent(logicTested, logic.length)}%`, hint: `${formatCount(logicTested)} of ${plural(logic.length, 'file')}` }] : []),
      { label: 'End-to-end', value: e2e ?? 'none' },
    ],
    findings,
    measures: [
      { id: 'untested-files', label: 'Components and services without a spec', value: untested.length },
      { id: 'tests-without-assertions', label: 'Tests that assert nothing', value: withoutAssertions },
      { id: 'unawaited-subscribe-assertions', label: 'Assertions in a subscribe the test does not wait for', value: unawaited },
      { id: 'schema-suppressed-specs', label: 'Spec files with NO_ERRORS_SCHEMA or CUSTOM_ELEMENTS_SCHEMA', value: schemaSuppressed },
    ],
  };
}

/**
 * Runners in use, from the test targets' builders first and the dependencies
 * second. Both are needed: an Nx or CLI workspace names the runner in its
 * builder, while a hand-rolled setup only shows it as a dependency and a config
 * file. A repository can report two during a migration.
 */
function detectRunners(context: AnalysisContext): Set<Runner> {
  const { workspace } = context;
  const runners = new Set<Runner>();
  for (const target of workspace.targets) {
    const builder = target.builder;
    if (builder.endsWith(':karma')) runners.add('Karma');
    else if (builder.endsWith(':jest') || builder === '@angular-builders/jest:run') runners.add('Jest');
    else if (builder.endsWith(':vitest') || builder === '@nx/vite:test' || builder === '@nx/vitest:test') runners.add('Vitest');
    else if (builder === '@angular/build:unit-test') runners.add(target.options['runner'] === 'karma' ? 'Karma' : 'Vitest');
  }
  if (runners.size === 0) {
    if ('karma' in workspace.dependencies || existsSync(join(workspace.root, 'karma.conf.js'))) runners.add('Karma');
    if ('jest' in workspace.dependencies) runners.add('Jest');
    if ('vitest' in workspace.dependencies) runners.add('Vitest');
  }
  return runners;
}
