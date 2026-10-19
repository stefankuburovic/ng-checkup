import type { CheckResult, Finding, Grade } from '../types.js';
import { applicationFiles, countCalls, filesImporting, formatCount, plural, verb, type AnalysisContext } from './context.js';

/** The classic, action-based NgRx packages. */
const CLASSIC_NGRX = ['@ngrx/store', '@ngrx/effects', '@ngrx/entity', '@ngrx/router-store', '@ngrx/component-store'];

/**
 * How application state is held: classic NgRx, the NgRx signal store,
 * Angular signals, or services wrapping a `BehaviorSubject`.
 *
 * Never graded `poor`. Classic NgRx is supported and not deprecated, and a
 * `BehaviorSubject` service is a legitimate pattern, so neither is a defect;
 * the check reports how far the codebase has moved towards signals, which is
 * the direction zoneless change detection rewards, and how big the remaining
 * move would be.
 */
export function stateCheck(context: AnalysisContext): CheckResult {
  const application = applicationFiles(context);
  const classicFiles = filesImporting(application, CLASSIC_NGRX);
  const signalStoreFiles = filesImporting(application, ['@ngrx/signals']);
  const signals = countCalls(application, '@angular/core#signal', '@angular/core#computed', '@angular/core#linkedSignal');
  const toSignal = countCalls(application, '@angular/core/rxjs-interop#toSignal');
  const subjectServices = application.filter((file) => file.injectables > 0 && (file.constructions.get('rxjs#BehaviorSubject')?.length ?? 0) > 0);

  const reducers = countCalls(application, '@ngrx/store#createReducer');
  const effects = countCalls(application, '@ngrx/effects#createEffect');
  const selectors = countCalls(application, '@ngrx/store#createSelector', '@ngrx/store#createFeatureSelector');
  const actions = countCalls(application, '@ngrx/store#createAction', '@ngrx/store#createActionGroup');
  const removedEffectDecorators = countCalls(application, '@ngrx/effects#Effect');

  const findings: Finding[] = [];
  if (removedEffectDecorators > 0) {
    findings.push({
      severity: 'high',
      message: `${plural(removedEffectDecorators, '`@Effect()` decorator')} from NgRx`,
      detail: 'The `@Effect()` decorator was removed in NgRx 15. These have to become `createEffect()` before NgRx can be upgraded past 14.',
      count: removedEffectDecorators,
    });
  }
  if (classicFiles.length > 0) {
    findings.push({
      severity: 'low',
      message: `Classic NgRx in ${plural(classicFiles.length, 'file')}: ${plural(reducers, 'reducer')}, ${plural(effects, 'effect')}, ${plural(selectors, 'selector')}, ${plural(actions, 'action creator')}`,
      detail:
        'Classic NgRx is supported, so this is a choice rather than a defect. Moving a feature to `@ngrx/signals` removes the action, reducer and effect boilerplate and fits zoneless change detection without the async pipe; the cost is a rewrite per feature, and the action log that the devtools show goes with it.',
      files: classicFiles.slice(0, context.maxExamples),
      count: classicFiles.length,
    });
  }
  if (subjectServices.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(subjectServices.length, 'service')} ${verb(subjectServices.length, 'holds', 'hold')} state in a \`BehaviorSubject\``,
      detail: 'Each is a candidate for a `signal()`-based service: templates read it without the async pipe, `computed()` replaces `combineLatest` chains, and zoneless change detection tracks it automatically. `toObservable()` keeps existing RxJS consumers working during the move.',
      files: subjectServices.slice(0, context.maxExamples).map((file) => ({ path: file.path, line: file.constructions.get('rxjs#BehaviorSubject')?.[0] })),
      count: subjectServices.length,
    });
  }

  const usesSignals = signals + signalStoreFiles.length > 0;
  const nothingToGrade = classicFiles.length === 0 && signalStoreFiles.length === 0 && signals === 0 && subjectServices.length === 0;
  const grade: Grade = nothingToGrade ? 'info' : removedEffectDecorators > 0 ? 'poor' : usesSignals && classicFiles.length === 0 ? 'good' : 'fair';

  return {
    id: 'state',
    title: 'State management',
    grade,
    summary: nothingToGrade
      ? 'No state-management library or signal usage found.'
      : `${classicFiles.length > 0 ? `Classic NgRx in ${plural(classicFiles.length, 'file')}` : 'No classic NgRx'}, ${formatCount(signals)} signal()/computed() calls, ${plural(signalStoreFiles.length, 'signal-store file')}.`,
    metrics: [
      { label: 'Classic NgRx files', value: formatCount(classicFiles.length) },
      { label: 'Signal store files', value: formatCount(signalStoreFiles.length) },
      { label: 'signal() / computed()', value: formatCount(signals), hint: `${formatCount(toSignal)} toSignal()` },
      { label: 'BehaviorSubject services', value: formatCount(subjectServices.length) },
    ],
    findings,
  };
}
