import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, Finding, Grade } from '../types.js';
import { applicationFiles, formatCount, percent, plural, specFiles, type AnalysisContext } from './context.js';

/** A unit-test runner the check recognises. */
type Runner = 'Karma' | 'Jest' | 'Vitest';

/**
 * The unit-test runner, how much of the code has a spec next to it, and the
 * end-to-end setup.
 *
 * "Has a spec next to it" is a proxy for coverage, not coverage: it counts a
 * component or service as tested when `x.spec.ts` sits beside `x.ts`. It needs
 * no test run and no coverage report, which is what lets this tool run in a
 * minute on a repository it has never seen; real coverage is lower or higher
 * depending on what those specs assert.
 */
export function testingCheck(context: AnalysisContext): CheckResult {
  const { workspace } = context;
  const runners = detectRunners(context);
  const specs = specFiles(context);
  const testable = applicationFiles(context).filter((file) => file.components.length > 0 || file.injectables > 0);
  const specPaths = new Set(specs.map((file) => file.path));
  const untested = testable.filter((file) => !specPaths.has(file.path.replace(/\.ts$/, '.spec.ts')));
  const coverage = percent(testable.length - untested.length, testable.length);
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
      message: `${100 - coverage}% of components and services have no spec file next to them`,
      detail: 'Counted by file name (`x.spec.ts` beside `x.ts`), so a spec kept elsewhere is missed and a spec that asserts nothing still counts. It is a lower bound on where an upgrade would be verified by hand.',
      files: untested.slice(0, context.maxExamples).map((file) => ({ path: file.path })),
      count: untested.length,
    });
  }
  if (protractor) {
    findings.push({ severity: 'high', message: 'End-to-end tests use Protractor, which is end of life', detail: 'Protractor reached end of life in 2023 and gets no fixes, including for new browser versions. Playwright and Cypress are the usual replacements.' });
  } else if (!e2e && testable.length > 0) {
    findings.push({ severity: 'info', message: 'No end-to-end test setup found', detail: 'Neither Playwright nor Cypress is a dependency. A handful of smoke tests over the main flows is the cheapest safety net for an upgrade.' });
  }

  const grade: Grade = testable.length === 0 ? 'info' : runners.has('Karma') || protractor || specs.length === 0 ? 'poor' : coverage < 30 ? 'fair' : 'good';

  return {
    id: 'testing',
    title: 'Testing',
    grade,
    summary: `${runners.size > 0 ? [...runners].join(' + ') : 'No unit-test runner detected'}, ${plural(specs.length, 'spec file')}, ${coverage}% of components and services with a spec.`,
    metrics: [
      { label: 'Unit-test runner', value: runners.size > 0 ? [...runners].join(' + ') : 'none' },
      { label: 'Spec files', value: formatCount(specs.length) },
      { label: 'With a spec', value: `${coverage}%`, hint: `${formatCount(testable.length - untested.length)} of ${plural(testable.length, 'component/service file')}` },
      { label: 'End-to-end', value: e2e ?? 'none' },
    ],
    findings,
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
