import { highestSupported } from '../compatibility.js';
import type { CheckResult, Finding, Grade } from '../types.js';
import { formatCount, plural, verb, type AnalysisContext } from './context.js';

/**
 * Third-party packages that depend on Angular, and whether they hold the
 * project back.
 *
 * A library pinned to an old Angular is the most common reason an upgrade
 * stalls halfway: `ng update` refuses, or worse, succeeds with
 * `--force` and the library fails at runtime. This check reads every
 * installed package's `@angular/core` peer range, so it covers any UI kit,
 * state library or utility without a list of known names.
 *
 * Graded `poor` when something is already broken (a package that does not
 * accept the Angular in use) or when, per the registry, no release of a
 * package supports the latest Angular yet; `fair` when packages block the
 * upgrade but have newer releases, or are deprecated on npm.
 */
export function dependenciesCheck(context: AnalysisContext): CheckResult {
  const { workspace, compatibility } = context;
  const current = workspace.angular.major;
  const target = context.latestAngular.major;
  const id = 'dependencies';
  const title = 'Third-party compatibility';

  // Without node_modules the peer ranges come from the registry, so only an
  // offline run (or an unreachable registry) leaves nothing to read.
  const unreadable = !workspace.hasNodeModules && context.latestAngular.source === 'bundled' && compatibility.length === 0;
  if (current === undefined || unreadable) {
    return {
      id,
      title,
      grade: 'info',
      summary: current === undefined ? 'No Angular dependency to check against.' : 'Dependencies are not installed and the npm registry was not used, so the packages that depend on Angular could not be read.',
      metrics: [],
      findings: current === undefined ? [] : [{ severity: 'info', message: 'Install the dependencies, or run without --offline to read each package from the npm registry' }],
    };
  }

  const majors = Array.from({ length: target - current + 1 }, (_, index) => current + index);
  const mismatched = compatibility.filter((entry) => !entry.supportsCurrent);
  const blocking = compatibility.filter((entry) => entry.supportsCurrent && entry.blocksAt !== undefined);
  const deprecated = compatibility.filter((entry) => entry.deprecated);
  const dead = blocking.filter((entry) => entry.releaseFor?.[target] === null);

  const findings: Finding[] = [];
  for (const entry of mismatched) {
    findings.push({
      severity: 'high',
      message: `\`${entry.name}\` ${entry.installed} does not accept Angular ${current}`,
      detail: `It declares \`@angular/core\` ${entry.angularRange}, so it was installed with --force, --legacy-peer-deps or an override, and it may fail at runtime in ways no build catches.${releaseHint(entry, current)}${entry.releaseFor?.[current] === null ? ` No release accepts Angular ${current} yet (latest ${entry.latest ?? 'unknown'}).` : ''}`,
    });
  }
  for (const entry of blocking) {
    const upTo = highestSupported(entry.angularRange, majors);
    const noRelease = entry.releaseFor?.[target] === null;
    findings.push({
      severity: noRelease ? 'high' : 'medium',
      message: `\`${entry.name}\` ${entry.installed} supports Angular up to ${upTo ?? current}: it blocks the step to ${entry.blocksAt}`,
      detail: `It declares \`@angular/core\` ${entry.angularRange}.${releaseHint(entry, entry.blocksAt!)}${noRelease ? ` No release supports Angular ${target} yet (latest ${entry.latest ?? 'unknown'}): plan to replace it, or to stop at the last major it supports.` : ''}`,
    });
  }
  for (const entry of deprecated) {
    findings.push({ severity: 'medium', message: `\`${entry.name}\` is deprecated on npm`, detail: entry.deprecated });
  }
  if (blocking.length > 0 && blocking.every((entry) => entry.releaseFor === undefined)) {
    findings.push({ severity: 'info', message: 'Run without --offline to find the releases that support newer Angular versions' });
  }

  const grade: Grade = mismatched.length > 0 || dead.length > 0 ? 'poor' : blocking.length > 0 || deprecated.length > 0 ? 'fair' : 'good';
  return {
    id,
    title,
    grade,
    summary:
      compatibility.length === 0
        ? 'No third-party package depends on Angular.'
        : `${plural(compatibility.length, 'package')} ${verb(compatibility.length, 'depends', 'depend')} on Angular: ${formatCount(blocking.length)} blocking the upgrade to ${target}, ${formatCount(mismatched.length)} not accepting the current version.`,
    metrics: [
      { label: 'Depend on Angular', value: formatCount(compatibility.length), hint: 'third-party packages' },
      { label: 'Block the upgrade', value: formatCount(blocking.length), hint: `to Angular ${target}` },
      { label: 'Peer mismatches', value: formatCount(mismatched.length), hint: `with Angular ${current}` },
      { label: 'Deprecated on npm', value: formatCount(deprecated.length) },
    ],
    findings,
    // Only what the code controls: blocking packages depend on when Angular ships, so they are not a measure.
    measures: [
      { id: 'peer-mismatches', label: 'Packages that do not accept the installed Angular', value: mismatched.length },
      { id: 'deprecated-packages', label: 'Packages deprecated on npm', value: deprecated.length },
    ],
  };
}

/** " Version 5.1.0 supports Angular 14." when the registry found one, else an empty string. */
function releaseHint(entry: { releaseFor?: Record<number, { version: string } | null> }, major: number): string {
  const release = entry.releaseFor?.[major];
  return release ? ` Version ${release.version} supports Angular ${major}.` : '';
}
