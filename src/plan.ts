import { ANGULAR_VERSIONS, type AngularVersionInfo } from './angular-versions.js';
import type { PackageCompatibility } from './compatibility.js';
import type { CheckResult } from './types.js';
import type { WorkspaceInfo } from './workspace.js';

/** One requirement of a step, checked against what the project has now. */
export interface PlanRequirement {
  name: 'Node.js' | 'TypeScript' | 'RxJS' | 'zone.js';
  /** The range the target major accepts, from the registry snapshot. */
  range: string;
  /** The project's version today, when known (installed first, then the package.json range). Never known for Node.js. */
  current?: string;
  /**
   * False when `current` is outside `range`: this step has to move it.
   * Undefined when it cannot be judged (Node.js, or no version known).
   */
  satisfied?: boolean;
}

/** One thing to do in a step, specific to this codebase. */
export interface PlanItem {
  title: string;
  /** The command that does it, when there is one. */
  command?: string;
  detail?: string;
  /** How many places in the code it touches, when the analysis counted them. */
  count?: number;
}

/** Moving from one major to the next. */
export interface UpgradeStep {
  /** The major this step reaches. */
  to: number;
  /** The last released version of that major. */
  version: string;
  command: string;
  requirements: PlanRequirement[];
  items: PlanItem[];
}

/** The way from the installed Angular to the target. Attached to `Report.plan`. */
export interface UpgradePlan {
  from: number;
  to: number;
  /** Things to settle before the first `ng update`. */
  before: PlanItem[];
  steps: UpgradeStep[];
}

/**
 * Plans the upgrade from the installed Angular major to `target`, one major
 * at a time as `ng update` requires.
 *
 * Each step carries what is the same for everyone (the command, and the
 * Node.js / TypeScript / RxJS / zone.js ranges from the registry snapshot in
 * `angular-versions.ts`) and what is specific to this codebase: the
 * migrations its findings call for, scheduled at the first step where
 * Angular ships them, with the count of places each one touches. A migration
 * the code does not need is left out, which is what makes the plan read as
 * this project's and not as the Angular changelog.
 *
 * Deliberately gives no time estimate. Counts are measured; days would be a
 * guess dressed up as data.
 *
 * @returns Undefined when the Angular version is unknown, or already at or
 *   past the target.
 */
export function buildPlan(
  workspace: WorkspaceInfo,
  checks: CheckResult[],
  target: number,
  versions: AngularVersionInfo[] = ANGULAR_VERSIONS,
  compatibility: PackageCompatibility[] = [],
): UpgradePlan | undefined {
  const from = workspace.angular.major;
  if (from === undefined || from >= target) return undefined;

  const measure = (check: string, id: string): number => checks.find((result) => result.id === check)?.measures?.find((entry) => entry.id === id)?.value ?? 0;
  const metric = (check: string, label: string): string | undefined => {
    const value = checks.find((result) => result.id === check)?.metrics.find((entry) => entry.label === label)?.value;
    return value === undefined ? undefined : String(value);
  };
  const dependencies = workspace.dependencies;
  const has = (name: string): boolean => name in dependencies;
  const current = {
    typescript: workspace.versions['typescript'] ?? dependencies['typescript'],
    rxjs: workspace.versions['rxjs'] ?? dependencies['rxjs'],
    zoneJs: workspace.versions['zone.js'] ?? dependencies['zone.js'],
  };

  const before: PlanItem[] = [];
  const overdue = checks.find((result) => result.id === 'deprecated-apis')?.findings.filter((finding) => finding.severity === 'high') ?? [];
  if (overdue.length > 0) {
    before.push({ title: 'Replace APIs deprecated two or more majors ago', detail: 'Any of the next steps may remove them. The deprecated-APIs section lists each one with its replacement.', count: overdue.reduce((sum, finding) => sum + (finding.count ?? 1), 0) });
  }
  // A project already on angular-eslint often still lists `codelyzer` or
  // `tslint` from before the move; telling it to "move to ESLint" is wrong.
  const leftovers = ['tslint', 'codelyzer'].filter(has);
  if (leftovers.length > 0 && has('@angular-eslint/builder')) {
    before.push({ title: 'Remove the TSLint leftovers', command: `npm uninstall ${leftovers.join(' ')}`, detail: 'Linting already runs on angular-eslint; these packages are unused and pin old TypeScript and Angular versions.' });
  } else if (leftovers.length > 0) {
    before.push({ title: 'Move from TSLint to ESLint', command: 'ng add @angular-eslint/schematics', detail: 'TSLint is deprecated and later versions of the Angular CLI no longer support it.' });
  }
  if (measure('circular-deps', 'files-in-cycles') > 0) {
    before.push({ title: 'Break the import cycles', detail: 'A cycle that works by luck of load order is the first thing a new compiler or bundler breaks, and the failure looks unrelated to the upgrade.', count: measure('circular-deps', 'files-in-cycles') });
  }

  for (const entry of compatibility.filter((candidate) => !candidate.supportsCurrent)) {
    const release = entry.releaseFor?.[from];
    before.push({
      title: `Fix ${entry.name}: version ${entry.installed} does not accept Angular ${from}`,
      command: release ? `npm install ${entry.name}@${release.version}` : undefined,
      detail: release ? `Version ${release.version} does.` : `It declares @angular/core ${entry.angularRange}.`,
    });
  }

  /**
   * The Angular range each third-party package has at the current point of the
   * plan. A step that falls outside it gets an "update to X" item, and the
   * range moves to X's, so a later step is only flagged if X stops short too.
   */
  const packageRanges = new Map(compatibility.filter((entry) => entry.supportsCurrent && entry.blocksAt !== undefined).map((entry) => [entry.name, entry.angularRange]));
  const packageItems = (major: number): PlanItem[] => {
    const items: PlanItem[] = [];
    for (const entry of compatibility) {
      const range = packageRanges.get(entry.name);
      if (range === undefined || satisfies([major, 0, 0], range) || satisfies([major, 99, 99], range)) continue;
      const release = entry.releaseFor?.[major];
      if (release) {
        items.push({ title: `Update ${entry.name} to ${release.version}`, command: `npm install ${entry.name}@${release.version}`, detail: `The installed ${entry.installed} does not support Angular ${major}.` });
        packageRanges.set(entry.name, release.angularRange);
      } else {
        items.push({
          title: release === null ? `${entry.name} has no release for Angular ${major}` : `${entry.name} does not support Angular ${major}`,
          detail: release === null ? 'Replace it before this step, or stop the upgrade at the last major it supports.' : 'Run the checkup online to find a release that does, or replace it.',
        });
        packageRanges.delete(entry.name);
      }
    }
    return items;
  };

  const steps: UpgradeStep[] = [];
  /** Each project-specific migration is scheduled once, at the first step where it exists. */
  const scheduled = new Set<string>();
  const once = (key: string, step: number, availableFrom: number, item: PlanItem | undefined): PlanItem[] => {
    if (!item || scheduled.has(key) || step < availableFrom) return [];
    scheduled.add(key);
    return [item];
  };

  const moduleComponents = measure('components', 'module-components');
  const legacyControlFlow = Math.max(measure('components', 'legacy-control-flow'), measure('deprecated-apis', 'legacy-template-directives'));
  const decoratorBindings = measure('components', 'decorator-inputs-outputs');
  const eagerComponents = measure('change-detection', 'eager-components');
  const zoneHelpers = measure('change-detection', 'zone-test-helpers');
  const webpackBuilders = measure('version', 'webpack-builders');
  const onKarma = (metric('testing', 'Unit-test runner') ?? '').includes('Karma');
  const zoneless = metric('change-detection', 'Mode') === 'Zoneless';
  const ngrx = Object.keys(dependencies).filter((name) => name.startsWith('@ngrx/'));
  /**
   * Requirements the project has had to move already. From that step on the
   * project's original version says nothing (it was upgraded), so later steps
   * show the range alone instead of repeating "now 4.3.5" ten times.
   */
  const moved = new Set<PlanRequirement['name']>();
  const track = (entry: PlanRequirement): PlanRequirement => {
    if (entry.satisfied === false) moved.add(entry.name);
    return entry;
  };

  for (let major = from + 1; major <= target; major++) {
    // A major newer than this release's snapshot still gets a step, without requirements.
    const info: AngularVersionInfo = versions.find((entry) => entry.major === major) ?? { major, version: `${major}.x`, node: null, typescript: null, rxjs: null, zoneJs: null };
    const unknown = !versions.some((entry) => entry.major === major);
    const packages = [`@angular/core@${major}`, `@angular/cli@${major}`];
    if (has('@angular/material')) packages.push(`@angular/material@${major}`);
    else if (has('@angular/cdk')) packages.push(`@angular/cdk@${major}`);

    const requirements: PlanRequirement[] = [];
    if (info.node) requirements.push({ name: 'Node.js', range: info.node });
    if (info.typescript) requirements.push(track(requirement('TypeScript', info.typescript, moved.has('TypeScript') ? undefined : current.typescript)));
    if (info.rxjs && has('rxjs')) requirements.push(track(requirement('RxJS', info.rxjs, moved.has('RxJS') ? undefined : current.rxjs)));
    if (info.zoneJs && has('zone.js') && !zoneless) requirements.push(track(requirement('zone.js', info.zoneJs, moved.has('zone.js') ? undefined : current.zoneJs)));

    const items: PlanItem[] = [
      ...packageItems(major),
      ...(unknown ? [{ title: 'Check the requirements for this major', detail: 'It was released after this version of ng-checkup. Node.js and TypeScript ranges: angular.dev/reference/versions.' }] : []),
      ...(ngrx.length > 0 && major >= 8 ? [{ title: `Update NgRx to ${major} in the same step`, command: `ng update ${ngrx.map((name) => `${name}@${major}`).join(' ')}`, detail: 'NgRx versions follow Angular majors. If that major is not released yet, wait for it before this step.' }] : []),
      ...(has('@angular/flex-layout') && major === 16
        ? [{ title: 'Replace @angular/flex-layout first', detail: 'Its last release targets Angular 15, so it blocks this step. Use CSS flexbox and grid, or a maintained layout library.' }]
        : []),
      ...(has('@angular/material') && from < 15 && major === 15
        ? [{ title: 'Angular Material moves to the MDC-based components', detail: 'The old ones stay available as MatLegacy* until 17. Budget time for visual review: spacing, typography and density change.' }]
        : []),
      ...(has('@angular/material') && from < 17 && major === 17
        ? [{ title: 'The MatLegacy* components are removed', detail: 'Anything still imported from the legacy entry points has to move to the MDC-based components before this step.' }]
        : []),
      ...once('standalone', major, 16, moduleComponents > 0 ? { title: 'Convert NgModule components to standalone', command: 'ng generate @angular/core:standalone', detail: 'Three passes: convert declarations, remove unneeded NgModules, switch to standalone bootstrap.', count: moduleComponents } : undefined),
      ...once('control-flow', major, 17, legacyControlFlow > 0 ? { title: 'Move templates to built-in control flow', command: 'ng generate @angular/core:control-flow', count: legacyControlFlow } : undefined),
      ...once('application-builder', major, 18, webpackBuilders > 0 ? { title: 'Switch to the esbuild application builder', command: 'ng update @angular/cli --name use-application-builder', count: webpackBuilders } : undefined),
      ...once(
        'signal-inputs',
        major,
        19,
        decoratorBindings > 0 ? { title: 'Convert @Input() and @Output() to signal inputs and outputs', command: 'ng generate @angular/core:signal-input-migration && ng generate @angular/core:output-migration', count: decoratorBindings } : undefined,
      ),
      ...once('vitest', major, 21, onKarma ? { title: 'Move unit tests from Karma to Vitest', detail: 'Vitest is the Angular CLI default from 21 (@angular/build:unit-test). Jasmine-specific calls (spyOn, jasmine.*) need rewriting.' } : undefined),
      ...once(
        'zoneless',
        major,
        21,
        !zoneless
          ? {
              title: eagerComponents > 0 ? 'Prepare for zoneless: move components to OnPush, then drop zone.js' : 'Drop zone.js: zoneless is the default from 21',
              detail: `Upgraded apps keep zone.js through provideZoneChangeDetection() until it is removed.${zoneHelpers > 0 ? ` ${zoneHelpers} zone-based test helper calls (fakeAsync, tick) need fake timers instead.` : ''}`,
              count: eagerComponents || undefined,
            }
          : undefined,
      ),
    ];
    steps.push({ to: major, version: info.version, command: `ng update ${packages.join(' ')}`, requirements, items });
  }
  return { from, to: target, before, steps };
}

/** A requirement with the project's current version judged against the range. */
function requirement(name: PlanRequirement['name'], range: string, current: string | undefined): PlanRequirement {
  const version = current ? lowestVersionOf(current) : undefined;
  return { name, range, current, satisfied: version ? satisfies(version, range) : undefined };
}

/** `[major, minor, patch]` of `1.2.3`, `^1.2`, `~4.3.5`, `>=5`; undefined for anything without a number. */
/**
 * One `||` alternative as plain comparators, in the forms packages really
 * publish beyond the textbook ones: a space after the operator (`>= 14.x`, as
 * `@sentry/angular` declares), a partial version with an operator (`<= 21.x`
 * means below 22, `> 21` means 22 or later), and a hyphen range
 * (`14 - 21.x`). Misreading `>= 14.x <= 21.x` reported Angular 16 as
 * unsupported by a package that supports it.
 */
function normaliseRange(alternative: string): string[] {
  let text = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) text = `>=${hyphen[1]} <=${hyphen[2]}`;
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((comparator) => {
      const match = /^(<=|>)(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(comparator);
      if (!match) return comparator;
      const parts = [match[2], match[3], match[4]].filter((part) => part !== undefined && part !== 'x' && part !== '*').map(Number);
      if (parts.length === 3) return comparator;
      // `<=21.x` is `<22.0.0` and `>21.x` is `>=22.0.0`: bump the last given part.
      const bumped = [...parts];
      bumped[bumped.length - 1]! += 1;
      while (bumped.length < 3) bumped.push(0);
      return `${match[1] === '<=' ? '<' : '>='}${bumped.join('.')}`;
    });
}

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(text);
  if (!match) return undefined;
  const part = (value: string | undefined) => (value === undefined || value === 'x' || value === '*' ? 0 : Number(value));
  return [Number(match[1]), part(match[2]), part(match[3])];
}

/** The lowest version a declared range allows (`^4.3.5` gives 4.3.5), or the version itself. */
function lowestVersionOf(text: string): [number, number, number] | undefined {
  return parseVersion(text.split('||')[0]!.trim());
}

/** Orders two versions. */
function compare(left: [number, number, number], right: [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Whether `version` falls in an npm range of the shapes Angular publishes:
 * alternatives joined by `||`, each a space-separated set of comparators
 * (`>=4.8.2 <5.0`, `^14.20.0`, `~0.15.0`, `>=18.10.0`, `6.0.x`). Enough for
 * the requirement ranges in the snapshot, not a general semver implementation.
 */
export function satisfies(version: [number, number, number], range: string): boolean {
  return range.split('||').some((alternative) =>
    normaliseRange(alternative)
      .every((comparator) => {
        const operator = /^(\^|~|>=|<=|>|<|=)?/.exec(comparator)![0];
        const bound = parseVersion(comparator.slice(operator.length));
        if (!bound) return true;
        const order = compare(version, bound);
        switch (operator) {
          case '^':
            return order >= 0 && (bound[0] > 0 ? version[0] === bound[0] : version[1] === bound[1]);
          case '~':
            return order >= 0 && version[0] === bound[0] && version[1] === bound[1];
          case '>=':
            return order >= 0;
          case '>':
            return order > 0;
          case '<=':
            return order <= 0;
          case '<':
            return order < 0;
          default: {
            // A bare or x-range version: `6.0.3` is exact, `6.0.x` and `6.0` match every patch, `6` every minor.
            const significant = comparator.replace(/^=/, '').split('.').filter((part) => part !== 'x' && part !== '*').length;
            return version.slice(0, significant).every((value, index) => value === bound[index]);
          }
        }
      }),
  );
}
