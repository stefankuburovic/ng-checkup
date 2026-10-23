import type { CheckResult, Finding, Grade } from '../types.js';
import { applicationFiles, formatCount, percent, plural, type AnalysisContext } from './context.js';

/** Lines of code from which a file is listed as large. */
const LARGE_FILE = 500;
/** Lines of code from which a file counts against the grade. */
const VERY_LARGE_FILE = 1000;
/**
 * A hotspot is at least this large… The thresholds keep the list to files
 * that matter on a large app (on a 1 600-file app, 200 lines and 5 commits
 * named 147 files, which is a list nobody acts on).
 */
const HOTSPOT_LINES = 300;
/** …and was changed in at least this many commits of the last year. */
const HOTSPOT_COMMITS = 10;

/**
 * How the code is put together: lazy loading, oversized files, and the
 * dependency-injection and guard style.
 *
 * Graded only on what makes an app slower to load or harder to change:
 * routes that load everything up front, and files past a thousand lines,
 * where every change touches code nobody fully reads any more. Constructor
 * injection and class-based guards are reported but never grade, because
 * they are a matter of style that works fine; `inject()` and functional
 * guards are the current default and what the Angular migrations produce,
 * which is all the findings say.
 *
 * Routes are recognised syntactically (object literals with `path` and
 * `component` or `loadComponent`/`loadChildren`), so routes built by a
 * helper function are not seen. A `component:` route inside a lazily loaded
 * module is lazy, and is counted so: only files statically reachable from
 * `main.ts` hold eager routes (`AnalysisContext.eagerFiles`).
 */
export function architectureCheck(context: AnalysisContext): CheckResult {
  const files = applicationFiles(context);
  // A `component:` route counts as eager only in a file loaded at startup: in
  // a module that is itself behind `loadChildren`, it loads with that module.
  const loadedAtStartup = (path: string): boolean => context.eagerFiles === undefined || context.eagerFiles.has(path);
  const eager = files.filter((file) => loadedAtStartup(file.path)).flatMap((file) => file.routes.eager.map((line) => ({ path: file.path, line })));
  const lazy = files.flatMap((file) => [...file.routes.lazy, ...(loadedAtStartup(file.path) ? [] : file.routes.eager)].map((line) => ({ path: file.path, line })));
  const routes = eager.length + lazy.length;
  const large = files.filter((file) => file.linesOfCode >= LARGE_FILE).sort((left, right) => right.linesOfCode - left.linesOfCode);
  const veryLarge = large.filter((file) => file.linesOfCode >= VERY_LARGE_FILE);
  const constructorInjections = files.flatMap((file) => file.constructorInjections.map((entry) => ({ ...entry, path: file.path })));
  const classGuards = files.flatMap((file) => file.classGuards.map((entry) => ({ ...entry, path: file.path })));
  const injectCalls = files.reduce((sum, file) => sum + (file.calls.get('@angular/core#inject')?.length ?? 0), 0);
  const max = context.maxExamples;

  const findings: Finding[] = [];
  if (eager.length > 0 && eager.length >= lazy.length && routes >= 5) {
    findings.push({
      severity: lazy.length === 0 ? 'high' : 'medium',
      message: lazy.length === 0 ? `All ${plural(routes, 'route')} load eagerly` : `${plural(eager.length, 'route')} of ${formatCount(routes)} load eagerly`,
      detail: 'A route with `component:` puts its whole screen in the initial bundle, downloaded before the first page shows. `loadComponent: () => import(...)` (or `loadChildren` for a group) loads it when the user navigates there; the route config is the only change.',
      files: eager.slice(0, max),
      count: eager.length,
    });
  }
  if (large.length > 0) {
    findings.push({
      severity: veryLarge.length > 0 ? 'medium' : 'low',
      message: `${plural(large.length, 'file')} over ${formatCount(LARGE_FILE)} lines${veryLarge.length > 0 ? `, ${formatCount(veryLarge.length)} over ${formatCount(VERY_LARGE_FILE)}` : ''}`,
      detail: `The largest: ${large
        .slice(0, 3)
        .map((file) => `${file.path.split('/').pop()} (${formatCount(file.linesOfCode)})`)
        .join(', ')}. Files this size usually hold several responsibilities; they are where changes collide and where a refactor pays back first.`,
      files: large.slice(0, max).map((file) => ({ path: file.path })),
      count: large.length,
    });
  }
  // Hotspots: large files that also change often, ranked by size times commits.
  const churn = typeof context.churn === 'object' ? context.churn : undefined;
  const hotspots = churn
    ? files
        .map((file) => ({ file, commits: churn.files.get(file.path) ?? 0 }))
        .filter(({ file, commits }) => file.linesOfCode >= HOTSPOT_LINES && commits >= HOTSPOT_COMMITS)
        .sort((left, right) => right.file.linesOfCode * right.commits - left.file.linesOfCode * left.commits)
    : [];
  if (hotspots.length > 0) {
    findings.push({
      severity: hotspots.some(({ file }) => file.linesOfCode >= LARGE_FILE) ? 'medium' : 'low',
      message: `Hotspots: ${hotspots.length > 5 ? 'the ' : ''}large files changed most often${hotspots.length > 5 ? ` (top 5 of ${formatCount(hotspots.length)})` : ''}`,
      detail: `${hotspots
        .slice(0, 5)
        .map(({ file, commits }) => `${file.path.split('/').pop()} (${formatCount(file.linesOfCode)} lines, ${plural(commits, 'commit')})`)
        .join(', ')}, over the last year of history. A file that is both large and edited all the time costs its size on every change; these are where splitting or a refactor pays back first, more than the largest file nobody touches.`,
      files: hotspots.slice(0, max).map(({ file }) => ({ path: file.path })),
      count: hotspots.length,
    });
  }
  if (classGuards.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(classGuards.length, 'class-based guard or interceptor', 'class-based guards and interceptors')}`,
      detail: `${[...new Set(classGuards.map((entry) => entry.kind))].join(', ')}. Functional guards (\`CanActivateFn\`, \`ResolveFn\`) and interceptors (\`HttpInterceptorFn\` with \`withInterceptors\`) are the current style: a function with \`inject()\` inside, no class, no provider. Class interceptors also need \`withInterceptorsFromDi()\` to keep working with \`provideHttpClient\`.`,
      files: classGuards.slice(0, max).map((entry) => ({ path: entry.path, line: entry.line })),
      count: classGuards.length,
    });
  }
  if (constructorInjections.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(constructorInjections.length, 'class injects', 'classes inject')} through the constructor`,
      detail: `\`inject()\` is the current default (${plural(injectCalls, 'call')} already in the code). It works in field initialisers and functions, and it is what signal-based code expects. \`ng generate @angular/core:inject\` migrates constructors automatically.`,
      files: constructorInjections.slice(0, max).map((entry) => ({ path: entry.path, line: entry.line })),
      count: constructorInjections.length,
    });
  }

  const lazyShare = percent(lazy.length, routes);
  const grade: Grade =
    files.length === 0
      ? 'info'
      : // File size alone never makes the area poor: an app with every route lazy and no constructor injection was graded
        // poor for three long files, which read as the architecture being broken when it is a refactoring list.
        lazy.length === 0 && eager.length >= 10
        ? 'poor'
        : (routes >= 5 && eager.length > lazy.length) || veryLarge.length > 0
          ? 'fair'
          : 'good';
  return {
    id: 'architecture',
    title: 'Architecture',
    grade,
    summary:
      files.length === 0
        ? 'No application code to check.'
        : `${routes === 0 ? 'No routes found' : `${lazyShare}% of ${plural(routes, 'route')} lazy`}, ${plural(large.length, 'file')} over ${formatCount(LARGE_FILE)} lines, ${plural(constructorInjections.length, 'class', 'classes')} with constructor injection.`,
    metrics: [
      { label: 'Lazy routes', value: `${lazyShare}%`, hint: `${formatCount(lazy.length)} of ${formatCount(routes)}` },
      { label: 'Large files', value: formatCount(large.length), hint: `over ${formatCount(LARGE_FILE)} lines` },
      { label: 'Constructor injection', value: formatCount(constructorInjections.length), hint: `classes; ${formatCount(injectCalls)} inject() calls` },
      { label: 'Class guards', value: formatCount(classGuards.length), hint: 'and interceptors' },
      churn
        ? { label: 'Hotspots', value: formatCount(hotspots.length), hint: `from ${plural(churn.commits, 'commit')} in the last year` }
        : { label: 'Hotspots', value: '-', hint: context.churn === 'shallow clone' ? 'shallow clone: no history (fetch-depth: 0)' : `${context.churn}` },
    ],
    findings,
    measures: [
      { id: 'eager-routes', label: 'Eagerly loaded routes', value: eager.length },
      { id: 'very-large-files', label: `Files over ${VERY_LARGE_FILE} lines`, value: veryLarge.length },
      { id: 'constructor-injection', label: 'Classes with constructor injection', value: constructorInjections.length },
      { id: 'class-guards', label: 'Class-based guards and interceptors', value: classGuards.length },
    ],
  };
}
