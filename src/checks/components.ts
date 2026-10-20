import type { ComponentFact } from '../scan.js';
import type { CheckResult, FileRef, Finding, Grade, Metric } from '../types.js';
import { applicationFiles, countCalls, formatCount, percent, plural, type AnalysisContext } from './context.js';

/** Calls that declare a signal input, including two-way `model()` bindings. */
const SIGNAL_INPUTS = ['input', 'input.required', 'model', 'model.required'].map((name) => `@angular/core#${name}`);
/** Calls that declare a function-based output. */
const SIGNAL_OUTPUTS = ['@angular/core#output', '@angular/core/rxjs-interop#outputFromObservable'];

/**
 * Adoption of the component APIs Angular has moved to: standalone components,
 * signal inputs and outputs, and built-in control flow.
 *
 * Graded on the average adoption across the three, so a codebase is not
 * punished for an API it has no use for (an app without a single `@Input`
 * is not graded on signal inputs). Each lagging area comes with the
 * `ng generate` migration Angular ships for it, because each is mostly
 * mechanical and the report's job is to say how much work is left.
 */
export function componentsCheck(context: AnalysisContext): CheckResult {
  const application = applicationFiles(context);
  const major = context.workspace.angular.major;
  const standaloneByDefault = major === undefined || major >= 19;
  const components = application.flatMap((file) => file.components.map((component) => ({ file: file.path, component })));

  if (components.length === 0) {
    return { id: 'components', title: 'Components & templates', grade: 'info', summary: 'No `@Component` classes found.', metrics: [], findings: [] };
  }

  const moduleBased = components.filter(({ component }) => !isStandalone(component, standaloneByDefault));
  const ngModules = application.reduce((sum, file) => sum + file.ngModules, 0);
  const signalInputs = countCalls(application, ...SIGNAL_INPUTS);
  const signalOutputs = countCalls(application, ...SIGNAL_OUTPUTS);
  const decoratorInputs = application.reduce((sum, file) => sum + file.decoratorInputs, 0);
  const decoratorOutputs = application.reduce((sum, file) => sum + file.decoratorOutputs, 0);

  const totals = context.templates.reduce(
    (sum, template) => ({
      legacy: sum.legacy + template.stats.ngIf + template.stats.ngFor + template.stats.ngSwitch,
      modern: sum.modern + template.stats.ifBlocks + template.stats.forBlocks + template.stats.switchBlocks,
      defer: sum.defer + template.stats.deferBlocks,
    }),
    { legacy: 0, modern: 0, defer: 0 },
  );

  const standaloneShare = percent(components.length - moduleBased.length, components.length);
  const inputs = signalInputs + decoratorInputs;
  const outputs = signalOutputs + decoratorOutputs;
  const signalInputShare = percent(signalInputs, inputs);
  const signalOutputShare = percent(signalOutputs, outputs);
  const controlFlow = totals.legacy + totals.modern;
  const controlFlowShare = percent(totals.modern, controlFlow);

  const findings: Finding[] = [];
  if (moduleBased.length > 0) {
    findings.push({
      severity: standaloneShare < 50 ? 'medium' : 'low',
      message: `${plural(moduleBased.length, 'component')} still declared in NgModules (${plural(ngModules, 'NgModule')} in total)`,
      detail:
        'Standalone components are the default since Angular 19 and what every new API assumes. `ng generate @angular/core:standalone` converts declarations, removes the emptied NgModules and switches bootstrapping, in three passes that can be reviewed one at a time.',
      files: moduleBased.slice(0, context.maxExamples).map(({ file, component }): FileRef => ({ path: file, line: component.line })),
      count: moduleBased.length,
    });
  }
  if (decoratorInputs + decoratorOutputs > 0) {
    findings.push({
      severity: signalInputShare < 50 ? 'medium' : 'low',
      message: `${plural(decoratorInputs, '`@Input()` decorator')} and ${plural(decoratorOutputs, '`@Output()` decorator')} left`,
      detail:
        'Signal inputs (`input()`) make inputs readable in `computed()` and effects without `ngOnChanges`, and are what zoneless change detection tracks. `ng generate @angular/core:signal-input-migration` and `ng generate @angular/core:output-migration` convert most of them; the rest are usually inputs written to from inside the component.',
      count: decoratorInputs + decoratorOutputs,
    });
  }
  const controlFlowDeprecated = context.deprecations.get('@angular/common')?.symbols.has('NgIf') ?? false;
  if (totals.legacy > 0 && !controlFlowDeprecated) {
    // When NgIf is deprecated in the installed version the deprecated-APIs check reports this instead.
    findings.push({
      severity: 'low',
      message: `${plural(totals.legacy, 'use')} of \`*ngIf\`, \`*ngFor\` and \`[ngSwitch]\``,
      detail: 'Built-in control flow (`@if`, `@for`, `@switch`) is available from Angular 17. `ng generate @angular/core:control-flow` migrates most templates automatically.',
      count: totals.legacy,
    });
  }

  const shares = [standaloneShare, ...(inputs > 0 ? [signalInputShare] : []), ...(controlFlow > 0 ? [controlFlowShare] : [])];
  const average = shares.reduce((sum, share) => sum + share, 0) / shares.length;
  const grade: Grade = average >= 80 ? 'good' : average >= 40 ? 'fair' : 'poor';

  const metrics: Metric[] = [
    { label: 'Components', value: formatCount(components.length) },
    { label: 'Standalone', value: `${standaloneShare}%`, hint: `${formatCount(ngModules)} NgModules` },
    { label: 'Signal inputs', value: inputs > 0 ? `${signalInputShare}%` : 'n/a', hint: `${formatCount(signalInputs)} of ${formatCount(inputs)}` },
    { label: 'Signal outputs', value: outputs > 0 ? `${signalOutputShare}%` : 'n/a', hint: `${formatCount(signalOutputs)} of ${formatCount(outputs)}` },
    { label: 'Built-in control flow', value: controlFlow > 0 ? `${controlFlowShare}%` : 'n/a', hint: `${formatCount(totals.modern)} of ${formatCount(controlFlow)} blocks` },
    { label: '@defer blocks', value: formatCount(totals.defer) },
  ];

  return {
    id: 'components',
    title: 'Components & templates',
    grade,
    summary: `${plural(components.length, 'component')}: ${standaloneShare}% standalone, ${inputs > 0 ? `${signalInputShare}% signal inputs` : 'no inputs'}, ${controlFlow > 0 ? `${controlFlowShare}% built-in control flow` : 'no control flow'}.`,
    metrics,
    findings,
    measures: [
      { id: 'module-components', label: 'Components declared in NgModules', value: moduleBased.length },
      { id: 'decorator-inputs-outputs', label: '@Input() / @Output() decorators', value: decoratorInputs + decoratorOutputs },
      { id: 'legacy-control-flow', label: '*ngIf / *ngFor / [ngSwitch] uses', value: totals.legacy },
    ],
  };
}

/**
 * Whether a component is standalone. From Angular 19 that is the default and
 * only `standalone: false` opts out; before it, only `standalone: true` opts in.
 */
export function isStandalone(component: ComponentFact, standaloneByDefault: boolean): boolean {
  return component.standalone ?? standaloneByDefault;
}
