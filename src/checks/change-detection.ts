import type { ComponentFact } from '../scan.js';
import type { CheckResult, FileRef, Finding, Grade } from '../types.js';
import { applicationFiles, callSites, countCalls, filesImporting, formatCount, percent, plural, specFiles, verb, type AnalysisContext } from './context.js';

/** Test helpers that only work with zone.js loaded. */
const ZONE_TEST_HELPERS = ['fakeAsync', 'waitForAsync', 'tick', 'flush', 'flushMicrotasks', 'discardPeriodicTasks'].map((name) => `@angular/core/testing#${name}`);

/**
 * How far the app is from zoneless change detection.
 *
 * Zoneless has been stable since Angular 20.2 and is the default from 21: an
 * app on 21+ runs zoneless unless it calls `provideZoneChangeDetection()`,
 * which is how an app upgraded from an older version keeps zone.js. Before 21
 * it is the other way round, zoneless only with `provideZonelessChangeDetection()`.
 * Whether an app can switch is
 * mostly decided by how much of it already tells Angular when something
 * changed, and OnPush coverage is the best single proxy for that: an OnPush
 * component already has to, an eager one usually relies on zone.js noticing.
 */
export function changeDetectionCheck(context: AnalysisContext): CheckResult {
  const application = applicationFiles(context);
  const major = context.workspace.angular.major;
  const zonelessByDefault = major !== undefined && major >= 21;
  const zoneless = zonelessByDefault
    ? countCalls(application, '@angular/core#provideZoneChangeDetection') === 0
    : countCalls(application, '@angular/core#provideZonelessChangeDetection', '@angular/core#provideExperimentalZonelessChangeDetection') > 0;
  const usesZoneJs =
    'zone.js' in context.workspace.dependencies ||
    context.workspace.polyfills.some((entry) => entry.startsWith('zone.js')) ||
    application.some((file) => file.imports.some((fact) => fact.specifier.startsWith('zone.js')));

  const components = application.flatMap((file) => file.components.map((component) => ({ file: file.path, component })));
  const onPushByDefault = major !== undefined && major >= 22;
  const eager = components.filter(({ component }) => !isOnPush(component, onPushByDefault));
  const onPushShare = percent(components.length - eager.length, components.length);

  const ngZoneFiles = application.filter((file) => file.imports.some((fact) => fact.specifier === '@angular/core' && fact.bindings.some((binding) => binding.imported === 'NgZone' && !binding.typeOnly)));
  const zoneHelpers = countCalls(specFiles(context), ...ZONE_TEST_HELPERS);

  const findings: Finding[] = [];
  if (!zoneless && (major === undefined || major >= 20)) {
    findings.push({
      severity: 'medium',
      message: 'Change detection still runs on zone.js',
      detail: `${zonelessByDefault ? 'Zoneless is the default since Angular 21; this app opts back into zone.js with `provideZoneChangeDetection()`.' : 'Zoneless change detection is stable since Angular 20.2 (`provideZonelessChangeDetection()`) and the default from 21.'} It removes zone.js from the bundle and the cost of patching every async API, but every component then has to notify Angular itself, through signals, \`markForCheck()\`, the async pipe or event bindings. OnPush coverage below shows how much of the app already does.`,
    });
  } else if (!zoneless && major !== undefined) {
    findings.push({ severity: 'info', message: 'Zoneless change detection needs Angular 20.2 or newer', detail: 'Upgrade first; OnPush coverage is the preparation that pays off now.' });
  }

  if (components.length > 0 && eager.length > 0) {
    findings.push({
      severity: onPushShare < 50 ? 'medium' : 'low',
      message: `${plural(eager.length, 'component')} ${verb(eager.length, 'uses', 'use')} eager change detection (${100 - onPushShare}%)`,
      detail: onPushByDefault
        ? 'OnPush is the default since Angular 22, so these set `ChangeDetectionStrategy.Default` or `Eager` explicitly. Each is a component that relies on being checked on every cycle.'
        : 'Without `changeDetection: ChangeDetectionStrategy.OnPush` a component is checked on every change detection cycle and usually relies on zone.js to notice mutations. These are the components to review before going zoneless.',
      files: eager.slice(0, context.maxExamples).map(({ file, component }): FileRef => ({ path: file, line: component.line })),
      count: eager.length,
    });
  }

  if (zoneHelpers > 0) {
    findings.push({
      severity: zoneless ? 'medium' : 'low',
      message: `${formatCount(zoneHelpers)} zone-based test helper calls (\`fakeAsync\`, \`tick\`, \`waitForAsync\`)`,
      detail: 'These only run with zone.js loaded in the test environment. Once zone.js leaves the test setup too, each needs rewriting with the runner\'s fake timers (`vi.useFakeTimers()` and `vi.advanceTimersByTime()` under Vitest).',
      files: callSites(specFiles(context), ...ZONE_TEST_HELPERS).slice(0, context.maxExamples),
      count: callSites(specFiles(context), ...ZONE_TEST_HELPERS).length,
    });
  }

  if (ngZoneFiles.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(ngZoneFiles.length, 'file')} ${verb(ngZoneFiles.length, 'injects', 'inject')} \`NgZone\``,
      detail: 'Zoneless, `NgZone` is still injectable but `run()` no longer triggers change detection and `runOutsideAngular()` no longer saves any. Code that relied on either needs a signal or an explicit `markForCheck()` instead.',
      files: filesImporting(ngZoneFiles, ['@angular/core']).slice(0, context.maxExamples),
      count: ngZoneFiles.length,
    });
  }

  const grade: Grade = major === undefined && components.length === 0 && !usesZoneJs ? 'info' : zoneless ? 'good' : onPushShare >= 50 ? 'fair' : 'poor';

  return {
    id: 'change-detection',
    title: 'Change detection & zoneless readiness',
    grade,
    summary: zoneless
      ? `Zoneless, with ${onPushShare}% of components on OnPush.`
      : `Runs on zone.js; ${onPushShare}% of ${plural(components.length, 'component')} use OnPush.`,
    metrics: [
      { label: 'Mode', value: zoneless ? 'Zoneless' : 'zone.js', hint: zoneless && zonelessByDefault ? 'Angular 21+ default' : undefined },
      { label: 'OnPush', value: `${onPushShare}%`, hint: `${formatCount(components.length - eager.length)} of ${plural(components.length, 'component')}` },
      { label: 'Files injecting NgZone', value: formatCount(ngZoneFiles.length) },
      { label: 'Zone test helpers', value: formatCount(zoneHelpers) },
    ],
    findings,
  };
}

/**
 * Whether a component is checked OnPush. From Angular 22 OnPush is the default
 * and only an explicit `Default` or `Eager` opts out; before it, only an
 * explicit `OnPush` opts in.
 */
export function isOnPush(component: ComponentFact, onPushByDefault: boolean): boolean {
  if (component.changeDetection === undefined) return onPushByDefault;
  return component.changeDetection === 'OnPush';
}
