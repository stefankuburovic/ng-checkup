import { isTestCode } from '../files.js';
import type { SourceFileFacts } from '../scan.js';
import type { CheckResult, FileRef, Finding } from '../types.js';
import { owningProject } from '../workspace.js';
import { applicationFiles, countCalls, plural, type AnalysisContext } from './context.js';

const SERVER_RENDERING = ['@angular/platform-server#provideServerRendering', '@angular/ssr#provideServerRendering'];
const HYDRATION = '@angular/platform-browser#provideClientHydration';

/** True for a build target that renders on the server: a `server` target, or the `server`, `ssr` or `outputMode: "server"` options of the application builder. */
function targetRenders(context: AnalysisContext, project?: string): boolean {
  return context.workspace.targets
    .filter((target) => project === undefined || target.project === project)
    .some((target) => target.target === 'server' || (target.target === 'build' && (Boolean(target.options['server']) || Boolean(target.options['ssr']) || target.options['outputMode'] === 'server')));
}

/**
 * The files to judge, or undefined without server-side rendering. Without it
 * every `window` would be noise, so nothing runs. In a workspace with several
 * projects only the ones that say they render on the server are read: a
 * shared library may or may not run there, and a rule in doubt stays quiet.
 */
function serverCode(context: AnalysisContext): { files: SourceFileFacts[]; owns: (path: string) => boolean } | undefined {
  const application = applicationFiles(context);
  const { dependencies, projects } = context.workspace;
  const strong = targetRenders(context) || countCalls(application, ...SERVER_RENDERING) > 0;
  const hasPackage = Object.keys(dependencies).some((name) => name === '@angular/ssr' || name.startsWith('@nguniversal/'));
  if (!strong && !hasPackage) return undefined;
  const everything = { files: application, owns: () => true };
  if (projects.length < 2) return everything;
  const rendering = projects.filter((project) => targetRenders(context, project.name) || countCalls(application.filter((file) => owningProject(file.path, projects) === project), ...SERVER_RENDERING) > 0);
  if (rendering.length === 0) return everything;
  const owns = (path: string): boolean => {
    const owner = owningProject(path, projects);
    return owner !== undefined && rendering.includes(owner);
  };
  return { files: application.filter((file) => owns(file.path)), owns };
}

/**
 * Code that breaks on the server or breaks hydration: browser globals and
 * native DOM changes in code known to run during rendering, hydration switched
 * off for a component, and hydration not turned on at all.
 *
 * Never graded, like translations and accessibility: always `info`, so it
 * changes no score. It reads syntax and cannot see which routes render on the
 * client only, so a grade would claim more than the check knows. The measures
 * sit in the baseline, so `--fail-on regression` catches a new one.
 */
export function ssrCheck(context: AnalysisContext): CheckResult {
  const base = { id: 'ssr', title: 'SSR & hydration', grade: 'info' as const };
  const code = serverCode(context);
  if (!code) return { ...base, summary: 'This project does not render on the server, so nothing here applies.', metrics: [], findings: [] };

  const { files, owns } = code;
  const findings: Finding[] = [];
  const major = context.workspace.angular.major;
  const application = applicationFiles(context);
  const hasEntry = context.workspace.targets.some((target) => target.target === 'build' && (target.options['browser'] ?? target.options['main']) !== undefined);
  const missingHydration = hasEntry && (major === undefined || major >= 16) && countCalls(application, HYDRATION) === 0 ? 1 : 0;
  if (missingHydration) {
    findings.push({
      severity: 'medium',
      message: 'Server-rendered, but `provideClientHydration()` is missing',
      detail: 'Without hydration the browser throws the server-rendered DOM away and builds it again, so the page flickers and the work on the server is wasted. Add `provideClientHydration()` to the providers of the browser application. Available since Angular 16.',
    });
  }

  const withGlobals = files.filter((file) => file.ssr.browserGlobals.length > 0).sort((left, right) => right.ssr.browserGlobals.length - left.ssr.browserGlobals.length);
  const globals = withGlobals.reduce((sum, file) => sum + file.ssr.browserGlobals.length, 0);
  if (globals > 0) {
    const names = [...new Set(withGlobals.flatMap((file) => file.ssr.browserGlobals.map((entry) => entry.name)))].sort();
    findings.push({
      severity: 'medium',
      message: `${plural(globals, 'browser global')} in code that runs on the server (${names.map((name) => `\`${name}\``).join(', ')})`,
      detail: 'In a module\'s top level, a field or constructor, a lifecycle hook, or a method those call. On the server these names do not exist, so the render stops with a ReferenceError. Inject `DOCUMENT`, move the code into `afterNextRender()`, or guard it with `isPlatformBrowser()`. A guard, a `try`, a callback and a method nothing there calls are left out, and so are routes that render on the client only, which this check cannot see.',
      files: withGlobals.slice(0, context.maxExamples).map((file): FileRef => ({ path: file.path, line: file.ssr.browserGlobals[0]!.line })),
      count: withGlobals.length,
    });
  }

  const withMutations = files.filter((file) => file.ssr.domMutations.length > 0).sort((left, right) => right.ssr.domMutations.length - left.ssr.domMutations.length);
  const mutations = withMutations.reduce((sum, file) => sum + file.ssr.domMutations.length, 0);
  if (mutations > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(mutations, 'native DOM change')} in code that runs during rendering`,
      detail: 'Assigning `innerHTML` or `outerHTML`, or `appendChild` and similar on a `nativeElement`. Hydration expects the DOM the server sent, so a change made behind its back ends in a mismatch error. Use a binding, or move the change into `afterNextRender()`.',
      files: withMutations.slice(0, context.maxExamples).map((file): FileRef => ({ path: file.path, line: file.ssr.domMutations[0] })),
      count: withMutations.length,
    });
  }

  const skipped: FileRef[] = [
    ...context.templates.filter((template) => !isTestCode(template.path) && owns(template.path) && template.skipHydration.length > 0).flatMap((template) => template.skipHydration.map((line) => ({ path: template.path, line }))),
    ...files.flatMap((file) => file.ssr.skipHydration.map((line) => ({ path: file.path, line }))),
  ];
  if (skipped.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(skipped.length, 'use')} of \`ngSkipHydration\``,
      detail: 'That component and its children are rendered again from scratch in the browser. It is the documented way out for a component that cannot hydrate yet, so each one is a small debt to pay back, not a defect.',
      files: skipped.slice(0, context.maxExamples),
      count: skipped.length,
    });
  }

  const total = missingHydration + globals + mutations;
  return {
    ...base,
    summary: total === 0 ? `No browser global or native DOM change in code that runs on the server, across ${plural(files.length, 'file')}.` : `${plural(globals, 'browser global')} and ${plural(mutations, 'native DOM change')} in code that runs on the server${missingHydration ? ', and hydration is not on' : ''}.`,
    metrics: [
      { label: 'Browser globals on the server', value: globals },
      { label: 'Native DOM changes', value: mutations },
      { label: 'ngSkipHydration', value: skipped.length },
    ],
    findings,
    measures: [
      { id: 'browser-globals', label: 'Browser globals in code that runs on the server', value: globals },
      { id: 'dom-mutations', label: 'Native DOM changes in code that runs during rendering', value: mutations },
      { id: 'skip-hydration', label: 'Uses of ngSkipHydration', value: skipped.length },
      { id: 'missing-hydration', label: 'Server rendering without provideClientHydration', value: missingHydration },
    ],
  };
}
