import { isTestCode } from '../files.js';
import type { ComponentFact, SourceFileFacts } from '../scan.js';
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

  // Manual subscriptions: what a move to signals removes, and the number a migration's history should watch fall. Advice, not graded.
  const subscribeFiles = application.filter((file) => file.manualSubscribes.length > 0).sort((left, right) => right.manualSubscribes.length - left.manualSubscribes.length);
  const subscribes = subscribeFiles.reduce((sum, file) => sum + file.manualSubscribes.length, 0);
  const unbound = subscribeFiles.reduce((sum, file) => sum + file.manualSubscribes.filter((entry) => !entry.bound).length, 0);
  if (subscribes > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(subscribes, 'manual `.subscribe()` call')} in components and directives${unbound > 0 ? `, ${formatCount(unbound)} not tied to the component's lifetime` : ''}`,
      detail: `Each one moves state by hand: \`toSignal()\` or the \`async\` pipe let Angular own the subscription, and a signal is what OnPush and zoneless change detection track. "Tied to the lifetime" means \`takeUntilDestroyed\`, \`takeUntil\`, \`take\` or \`first\` in the chain; the others end only through an explicit \`unsubscribe()\`, or never.`,
      files: subscribeFiles.slice(0, context.maxExamples).map((file) => ({ path: file.path, line: file.manualSubscribes[0]!.line })),
      count: subscribeFiles.length,
    });
  }
  // The subset that leaks: nothing in the chain or the class ends it, and the source outlives the component. A defect, not a style choice, so a finding of its own.
  const unendedFiles = subscribeFiles.filter((file) => file.manualSubscribes.some((entry) => entry.unended));
  const unended = unendedFiles.reduce((sum, file) => sum + file.manualSubscribes.filter((entry) => entry.unended).length, 0);
  if (unended > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(unended, '`.subscribe()` call')} in components and directives that nothing ever ends`,
      detail: `No \`takeUntilDestroyed\`, \`takeUntil\`, \`take\` or \`first\` in the chain, and no cleanup anywhere in the class (\`ngOnDestroy\`, \`unsubscribe()\`, \`DestroyRef\`). When the source outlives the component (a service, a store, \`router.events\`, \`interval\`, \`fromEvent(window)\`), the subscription keeps the destroyed component in memory and its callback keeps running, once more each time the component is created. Calls to \`HttpClient\`, \`ActivatedRoute\`, a form's \`valueChanges\`, a dialog's close event and the component's own subjects are left out, since those complete or die with the component. A service call that completes after one value (a GraphQL query, a notification) cannot be told apart from the code and is counted; for those \`take(1)\` documents it. \`takeUntilDestroyed()\` or \`toSignal()\` fixes the rest.`,
      files: unendedFiles.slice(0, context.maxExamples).map((file) => ({ path: file.path, line: file.manualSubscribes.find((entry) => entry.unended)!.line })),
      count: unendedFiles.length,
    });
  }

  // Colour literals outside the tokens: what a theme cannot reach. Stylesheets and inline template styles, test code left out. Advice, not graded.
  const colorFiles = [
    ...context.stylesheets.filter((sheet) => !isTestCode(sheet.path)).map((sheet) => ({ path: sheet.path, lines: sheet.colorLines })),
    ...context.templates.filter((template) => !isTestCode(template.path)).map((template) => ({ path: template.path, lines: template.colorLines })),
  ]
    .filter((entry) => entry.lines.length > 0)
    .sort((left, right) => right.lines.length - left.lines.length);
  const hardcodedColors = colorFiles.reduce((sum, entry) => sum + entry.lines.length, 0);
  if (hardcodedColors > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(hardcodedColors, 'colour literal')} outside the design tokens`,
      detail: 'A theme (dark mode, a brand per customer, high contrast) changes the tokens: CSS custom properties, SCSS or Less variables. A colour written straight into a rule (`color: #fff`, `rgba(0, 0, 0, .1)`, `white`) or an inline `style` does not change with them and shows up wrong in the other theme. A value given to a custom property or a variable is a token definition and not counted, and files named for the tokens (`_tokens.scss`, `variables.less`, `theme.css`, `palette.scss`, `colors.scss`) are skipped. Replace each with `var(--token)` or the variable.',
      files: colorFiles.slice(0, context.maxExamples).map((entry) => ({ path: entry.path, line: entry.lines[0] })),
      count: colorFiles.length,
    });
  }

  // What a template makes change detection repeat. Advice, not graded: a cheap call or a list that never reorders costs nothing, and the code cannot always tell.
  const speed = templateSpeed(context, application);
  for (const rule of SPEED_RULES) {
    const hits = speed[rule.key];
    const count = hits.reduce((sum, hit) => sum + hit.lines.length, 0);
    if (count > 0) findings.push({ severity: 'low', message: rule.message(count), detail: rule.detail, files: hits.slice(0, context.maxExamples).map((hit): FileRef => ({ path: hit.path, line: hit.lines[0] })), count: hits.length });
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
    { label: 'Manual .subscribe()', value: formatCount(subscribes), hint: unbound > 0 ? `${formatCount(unbound)} not tied to the lifetime` : undefined },
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
      { id: 'manual-subscriptions', label: 'Manual .subscribe() in components and directives', value: subscribes },
      { id: 'hardcoded-colors', label: 'Colour literals outside the design tokens', value: hardcodedColors },
      { id: 'unended-subscriptions', label: '.subscribe() in components and directives that nothing ends', value: unended },
      ...SPEED_RULES.map((rule) => ({ id: rule.measure, label: rule.label, value: speed[rule.key].reduce((sum, hit) => sum + hit.lines.length, 0) })),
    ],
  };
}

/** Where one rule hit, most hits first. */
type SpeedHits = { path: string; lines: number[] }[];

interface SpeedFacts {
  untrackedLoops: SpeedHits;
  indexTrackedLoops: SpeedHits;
  methodCalls: SpeedHits;
  impurePipes: SpeedHits;
}

const SPEED_RULES: { key: keyof SpeedFacts; measure: string; label: string; message: (count: number) => string; detail: string }[] = [
  {
    key: 'untrackedLoops',
    measure: 'untracked-ngfor',
    label: '*ngFor without trackBy',
    message: (count) => `${plural(count, '\`*ngFor\` loop')} without \`trackBy\``,
    detail: 'Without `trackBy`, `*ngFor` follows rows by object identity. A list rebuilt from new objects, such as a fresh HTTP response, destroys and recreates every row, with its DOM and component state. Add a `trackBy` that returns a stable id, or move to `@for (...; track item.id)`. A literal array or a constant field of the class is left out. A list of strings or numbers is fine as it is, and the template cannot show that.',
  },
  {
    key: 'indexTrackedLoops',
    measure: 'track-by-index',
    label: '@for with track $index',
    message: (count) => `${plural(count, '\`@for\` loop')} with \`track $index\``,
    detail: 'Rows are followed by position. Insert, remove or reorder an item and the rows after it are rewritten in place, while state in the DOM or a child component (focus, typed text, an open panel) stays at the position instead of moving with the item. `track item.id` follows the item. On a list that never changes order `$index` is fine; a literal array or a constant field of the class is left out, and anything else cannot be told from the code.',
  },
  {
    key: 'methodCalls',
    measure: 'template-method-calls',
    label: 'Method calls in template bindings',
    message: (count) => `${plural(count, 'method call')} in template bindings`,
    detail: 'A method called from a binding runs on every check of the component, and one that returns a new array or object changes the binding each time. A cheap read costs nothing; a method that filters, sorts or formats belongs in `computed()` or a pure pipe. Only methods the class itself declares are counted, so signals are not, and neither are event handlers, `track` expressions or inherited methods.',
  },
  {
    key: 'impurePipes',
    measure: 'impure-pipes',
    label: 'Impure pipes',
    message: (count) => `${plural(count, 'impure pipe')} in use`,
    detail: 'With `pure: false`, Angular calls `transform` on every check of every template that uses the pipe. Some pipes need it, because they read state that changes outside their arguments. Otherwise, pass the changing value as an argument, or read a signal, and remove `pure: false`. Only pipes this repository declares and a template uses are counted.',
  },
];

/** A loop's collection that the class holds constant in every class that owns the template. */
function isConstantCollection(collection: string, owners: ComponentFact[]): boolean {
  const field = /^(?:this\.)?([A-Za-z_$][\w$]*)$/.exec(collection)?.[1];
  return field !== undefined && owners.every((owner) => owner.constantArrays?.includes(field));
}

/**
 * Joins each template with the classes that own it and keeps what those
 * classes confirm. A template no class in application code owns is not read
 * at all, and a template several classes share needs all of them to agree,
 * so a rule in doubt says nothing.
 */
function templateSpeed(context: AnalysisContext, application: SourceFileFacts[]): SpeedFacts {
  const owners = new Map<string, ComponentFact[]>();
  const own = (key: string, component: ComponentFact): void => {
    owners.set(key, [...(owners.get(key) ?? []), component]);
  };
  for (const file of application) {
    for (const component of file.components) {
      if (component.templateUrl) own(component.templateUrl, component);
      else own(`${file.path}#${component.name}`, component);
    }
  }

  const facts: SpeedFacts = { untrackedLoops: [], indexTrackedLoops: [], methodCalls: [], impurePipes: [] };
  const add = (hits: SpeedHits, path: string, lines: number[]): void => {
    if (lines.length > 0) hits.push({ path, lines });
  };
  const templates = context.templates.filter((template) => !isTestCode(template.path));
  for (const template of templates) {
    const classes = owners.get(template.inline ? `${template.path}#${template.owner}` : template.path);
    if (!classes) continue;
    add(facts.untrackedLoops, template.path, template.speed.untrackedLoops.filter((loop) => !isConstantCollection(loop.collection, classes)).map((loop) => loop.line));
    add(facts.indexTrackedLoops, template.path, template.speed.indexTrackedLoops.filter((loop) => !isConstantCollection(loop.collection, classes)).map((loop) => loop.line));
    add(facts.methodCalls, template.path, template.speed.calls.filter((call) => classes.every((owner) => owner.methods?.includes(call.name))).map((call) => call.line).sort((left, right) => left - right));
  }

  const usedPipes = new Set(templates.flatMap((template) => template.usage.pipes));
  for (const file of application) add(facts.impurePipes, file.path, file.pipes.filter((pipe) => pipe.impure && pipe.name !== undefined && usedPipes.has(pipe.name)).map((pipe) => pipe.line));

  for (const hits of Object.values(facts) as SpeedHits[]) hits.sort((left, right) => right.lines.length - left.lines.length);
  return facts;
}

/**
 * Whether a component is standalone. From Angular 19 that is the default and
 * only `standalone: false` opts out; before it, only `standalone: true` opts in.
 */
export function isStandalone(component: ComponentFact, standaloneByDefault: boolean): boolean {
  return component.standalone ?? standaloneByDefault;
}
