import type { BundleStats } from '../bundle.js';
import type { CheckResult, Finding, Grade } from '../types.js';
import { formatCount, plural, type AnalysisContext } from './context.js';

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
 * There is no baseline measure here, on purpose: a bundle grows with every
 * feature, so "may only go down" would fail CI on ordinary work. The budget
 * is the limit, and the build already enforces it; this check explains what
 * fills it.
 */
export function bundleCheck(context: AnalysisContext): CheckResult {
  const id = 'bundle';
  const title = 'Bundle size';
  const { bundles } = context;
  if (bundles.length === 0) {
    return {
      id,
      title,
      grade: 'info',
      summary: 'No build stats found, so the bundle size is not part of this report.',
      metrics: [],
      findings: [{ severity: 'info', message: 'Run `ng build --stats-json` (or `nx build <app> --stats-json`) and re-run to include the bundle size' }],
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
    findings,
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
