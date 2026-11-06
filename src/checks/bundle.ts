import type { BundleStats } from '../bundle.js';
import type { CheckResult, FileRef, Finding, Grade, Measure } from '../types.js';
import { applicationFiles, formatCount, plural, type AnalysisContext } from './context.js';

/**
 * Packages with a well-known lighter way out, kept short and by hand. Only a
 * package whose cost is not in doubt belongs here: the point is a finding a
 * team can act on, not a verdict on every dependency.
 */
const HEAVY_PACKAGES: Array<{ name: string; imports: RegExp; minBytes?: number; advice: string }> = [
  {
    name: 'moment',
    imports: /^moment(\/|$)/,
    advice: 'Moment cannot be tree-shaken and is in maintenance mode. `date-fns`, imported function by function, or `dayjs` cover most uses, and `Intl.DateTimeFormat` covers formatting.',
  },
  {
    name: 'lodash',
    // `lodash/debounce` brings one function, which is the fix and not the problem.
    imports: /^lodash(\/lodash(\.min)?(\.js)?)?$/,
    // In a stats file both spellings are the package `lodash`, so size tells the whole library from a few functions.
    minBytes: 50 * 1000,
    advice: '`lodash` is CommonJS, so even a named import brings the whole library. `lodash-es` with named imports, or `lodash/debounce` per function, keeps only what is used, and many of its functions now have a native equivalent.',
  },
  {
    name: 'rxjs-compat',
    imports: /^rxjs-compat(\/|$)/,
    advice: 'The compatibility layer for RxJS 5 code, meant for the move to RxJS 6. Move what still needs it to pipeable operators and remove the package.',
  },
  {
    name: 'jquery',
    imports: /^jquery(\/|$)/,
    advice: 'Angular bindings and the native DOM cover what most code uses it for (`querySelector`, `classList`, `fetch`). A plugin that needs jQuery has to go first.',
  },
];

/** The startup files that import a package for its code: not `import type`, not `import()`, not a binding only used as a type. */
function startupImports(context: AnalysisContext, imports: RegExp): FileRef[] {
  const refs: FileRef[] = [];
  for (const file of applicationFiles(context)) {
    if (!context.eagerFiles?.has(file.path)) continue;
    const fact = file.imports.find((entry) => imports.test(entry.specifier) && !entry.typeOnly && !entry.dynamic && !(entry.bindings.length > 0 && entry.bindings.every((binding) => binding.typeOnly || !binding.valueUsed)));
    if (fact) refs.push({ path: file.path, line: fact.line });
  }
  return refs;
}

/** True when a build target loads the package as a global script. `inject: false` loads it on demand, so that does not count. */
function isGlobalScript(context: AnalysisContext, name: string): boolean {
  return context.workspace.targets
    .filter((target) => target.target === 'build')
    .flatMap((target) => (Array.isArray(target.options['scripts']) ? (target.options['scripts'] as unknown[]) : []))
    .some((entry) => {
      const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined;
      const input = record ? record['input'] : entry;
      return typeof input === 'string' && record?.['inject'] !== false && input.includes(`node_modules/${name}/`);
    });
}

/**
 * The listed packages that load at startup. The findings add what a stats
 * file knows: the real size, and a package only another package pulls in.
 * No saving is ever given, because it depends on what replaces the package.
 *
 * The measure counts only what the code and the build configuration state,
 * so that it reads the same with a stats file and without one. It is left out
 * when the workspace names no entry to start from.
 */
function heavyPackages(context: AnalysisContext): { findings: Finding[]; measures: Measure[] } {
  const findings: Finding[] = [];
  let loaded = 0;
  let known = context.eagerFiles !== undefined;
  for (const entry of HEAVY_PACKAGES) {
    const files = startupImports(context, entry.imports);
    const script = isGlobalScript(context, entry.name);
    if (script) known = true;
    if (files.length > 0 || script) loaded++;
    const measured = context.bundles
      .flatMap((bundle) => bundle.initialByPackage.filter((part) => part.name === entry.name).map((part) => ({ bundle, bytes: part.bytes })))
      .sort((left, right) => right.bytes - left.bytes)[0];
    const direct = files.length > 0 || script;
    if (!direct && (!measured || measured.bytes < (entry.minBytes ?? 0))) continue;
    const name = context.bundles.length > 1 && measured ? ` of ${measured.bundle.project}` : '';
    const message = measured
      ? `\`${entry.name}\` is in the initial bundle${name}: ${formatBytes(measured.bytes)}`
      : files.length > 0
        ? `\`${entry.name}\` is imported by code that loads at startup`
        : `\`${entry.name}\` is a global script of the build`;
    const pulled = direct ? '' : ' No file here imports it, so another package pulls it in.';
    const size = measured ? '' : ' `ng build --stats-json` gives its real size.';
    const refs = files.length > 0 ? files : measured ? [{ path: measured.bundle.file }] : undefined;
    findings.push({
      severity: measured ? 'medium' : 'low',
      message,
      detail: `${entry.advice}${pulled}${size}`,
      ...(refs ? { files: refs.slice(0, context.maxExamples), count: refs.length } : {}),
    });
  }
  return { findings, measures: known ? [{ id: 'heavy-packages', label: 'Heavy packages loaded at startup', value: loaded }] : [] };
}

/**
 * The size of what the browser loads before the app starts, from the stats
 * file of the last `ng build --stats-json`, against the build's `initial`
 * budget.
 *
 * It reads a build, it does not run one: building takes minutes and needs a
 * working toolchain, while every other check takes seconds on a repository
 * that may not even compile. Without a stats file it grades `info` and says
 * how to get one. The file's date is in the summary, because a stats file
 * from last month describes last month's bundle.
 *
 * The size is no baseline measure, on purpose: a bundle grows with every
 * feature, so "may only go down" would fail CI on ordinary work. The budget
 * is the limit, and the build already enforces it; this check explains what
 * fills it. The count of heavy packages is a measure, since a new one is a
 * choice and not ordinary growth, and it never touches the grade.
 */
export function bundleCheck(context: AnalysisContext): CheckResult {
  const id = 'bundle';
  const title = 'Bundle size';
  const { bundles } = context;
  const heavy = heavyPackages(context);
  const measures = heavy.measures.length > 0 ? { measures: heavy.measures } : {};
  if (bundles.length === 0) {
    return {
      id,
      title,
      grade: 'info',
      summary: 'No build stats found, so the bundle size is not part of this report.',
      metrics: [],
      findings: [{ severity: 'info', message: 'Run `ng build --stats-json` (or `nx build <app> --stats-json`) and re-run to include the bundle size' }, ...heavy.findings],
      ...measures,
    };
  }

  const graded = bundles.map((bundle) => ({ bundle, grade: gradeOf(bundle) }));
  const worst = [...graded].sort((left, right) => rank(right.grade) - rank(left.grade) || right.bundle.initialBytes - left.bundle.initialBytes)[0]!;
  const largest = worst.bundle;
  const findings: Finding[] = [];
  for (const { bundle, grade } of graded) {
    const name = bundles.length > 1 ? ` of ${bundle.project}` : '';
    const top = bundle.initialByPackage.slice(0, 5).map((entry) => `${entry.name} ${formatBytes(entry.bytes)}`).join(', ');
    if (grade !== 'good') {
      const limit = grade === 'poor' ? bundle.budget.error : bundle.budget.warning;
      findings.push({
        severity: grade === 'poor' ? 'high' : 'medium',
        message: `The initial bundle${name} is ${formatBytes(bundle.initialBytes)}, over its ${grade === 'poor' ? 'error' : 'warning'} budget of ${formatBudget(limit)}`,
        detail: `Everything in it is downloaded, parsed and run before the first screen.${top ? ` Largest parts: ${top}.` : ''} Lazy routes (\`loadComponent\`, \`loadChildren\`) and \`@defer\` move code out of it; a large package used on one screen is the usual first candidate.`,
        files: [{ path: bundle.file }],
      });
    } else if (top) {
      findings.push({ severity: 'info', message: `Largest parts of the initial bundle${name}: ${top}`, files: [{ path: bundle.file }] });
    }
    if (bundle.lazyChunks === 0 && bundle.initialBytes > 250 * 1000) {
      findings.push({
        severity: 'low',
        message: `Nothing${name} is loaded lazily`,
        detail: 'The whole app ships in the initial bundle. Lazy routes split it per screen at no cost to the code that stays eager.',
        files: [{ path: bundle.file }],
      });
    }
  }

  const builtAt = bundles.map((bundle) => bundle.builtAt).sort()[0]!.slice(0, 10);
  const summary =
    bundles.length === 1
      ? `Initial bundle ${formatBytes(largest.initialBytes)} of a ${formatBudget(largest.budget.warning)} budget, ${plural(largest.lazyChunks, 'lazy chunk')} (build of ${builtAt}).`
      : `${bundles.length} apps measured; ${worst.grade === 'good' ? 'largest' : 'worst'} initial bundle ${formatBytes(largest.initialBytes)} (${largest.project}) of a ${formatBudget(largest.budget.warning)} budget (builds from ${builtAt}).`;
  return {
    id,
    title,
    grade: worst.grade,
    summary,
    metrics: [
      { label: 'Initial bundle', value: formatBytes(largest.initialBytes), hint: `budget ${formatBudget(largest.budget.warning)}${bundles.length > 1 ? `, ${largest.project}` : ''}` },
      { label: 'Lazy chunks', value: formatCount(largest.lazyChunks), hint: formatBytes(largest.lazyBytes) },
      { label: 'Largest lazy chunk', value: largest.largestLazy ? formatBytes(largest.largestLazy.bytes) : '-' },
      { label: 'Largest package', value: largest.initialByPackage.find((entry) => entry.name !== '(your code)')?.name ?? '-', hint: 'in the initial bundle' },
    ],
    findings: [...findings, ...heavy.findings],
    ...measures,
  };
}

/** Good under the warning budget, fair under the error budget, poor above it. A missing limit never trips. */
function gradeOf(bundle: BundleStats): Grade {
  if (bundle.budget.error !== undefined && bundle.initialBytes > bundle.budget.error) return 'poor';
  if (bundle.budget.warning !== undefined && bundle.initialBytes > bundle.budget.warning) return 'fair';
  return 'good';
}

/** Order for picking the worst bundle. */
function rank(grade: Grade): number {
  return { info: 0, good: 1, fair: 2, poor: 3 }[grade];
}

/**
 * Bytes in decimal units, as the size table of `ng build` prints them
 * (112063 bytes is "112.1 kB"), so a number here can be found in the build log.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1000 / 1000).toFixed(2)} MB`;
}

/**
 * A budget in binary units, the way `angular.json` declares it: Angular reads
 * "500kB" as 500 × 1024 bytes, so it is printed back as "500 kB", not "512.0 kB".
 */
function formatBudget(bytes: number | undefined): string {
  if (bytes === undefined) return 'no';
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / 1024 / 1024} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
