import type { DeprecationInfo } from '../deprecations.js';
import { isSpecFile } from '../files.js';
import { majorOf } from '../workspace.js';
import type { CheckResult, FileRef, Finding, Grade } from '../types.js';
import { formatCount, plural, type AnalysisContext } from './context.js';

/** One deprecated symbol and everywhere it is used. */
interface Usage {
  module: string;
  /** `NgIf`, or `ChangeDetectionStrategy.Default` for a member. */
  name: string;
  info: DeprecationInfo;
  refs: FileRef[];
}

/**
 * Deprecated Angular and NgRx APIs the code uses, as the installed packages
 * mark them, plus the template-side use of the deprecated structural
 * directives (`*ngIf`, `*ngFor`, `[ngSwitch]`), which no import reveals because
 * templates reach them through `CommonModule`.
 *
 * A symbol deprecated two or more majors before the installed one is `high`:
 * Angular removes deprecated APIs no earlier than two majors after
 * deprecating them, so from then on any `ng update` may be the one that breaks
 * the build.
 */
export function deprecatedApisCheck(context: AnalysisContext): CheckResult {
  const { deprecations, workspace } = context;
  const legacyTemplates = context.templates.filter((template) => template.firstLegacyLine !== undefined);
  const legacyUses = legacyTemplates.reduce((sum, template) => sum + template.stats.ngIf + template.stats.ngFor + template.stats.ngSwitch, 0);

  if (deprecations.size === 0) {
    return {
      id: 'deprecated-apis',
      title: 'Deprecated APIs',
      grade: 'info',
      summary: 'The Angular type definitions could not be read, neither installed nor from the npm registry, so deprecations are not checked.',
      metrics: [{ label: 'Legacy template directives', value: formatCount(legacyUses) }],
      findings: [
        {
          severity: 'info',
          message: 'Install the dependencies, or run without --offline so the typings of the exact versions can be downloaded',
          detail: `Deprecations are read from the \`@deprecated\` tags of the \`@angular/*\`, \`@ngrx/*\` and \`rxjs\` type definitions of the versions the project uses: installed in \`node_modules\`, else the versions the lockfile pins, downloaded once into the cache.${context.typings.missing.length > 0 ? ` Not available: ${context.typings.missing.join(', ')}.` : ''}`,
        },
      ],
      measures: [{ id: 'legacy-template-directives', label: '*ngIf / *ngFor / [ngSwitch] uses', value: legacyUses }],
    };
  }

  const usages = new Map<string, Usage>();
  const add = (module: string, name: string, info: DeprecationInfo, ref: FileRef): void => {
    const key = `${module}#${name}`;
    const usage = usages.get(key) ?? { module, name, info, refs: [] };
    if (!usage.refs.some((existing) => existing.path === ref.path)) usage.refs.push(ref);
    usages.set(key, usage);
  };

  for (const file of context.sources) {
    for (const fact of file.imports) {
      const entry = deprecations.get(fact.specifier);
      if (!entry) continue;
      for (const binding of fact.bindings) {
        const info = entry.symbols.get(binding.imported);
        if (info) add(fact.specifier, binding.imported, info, { path: file.path, line: fact.line });
      }
    }
    for (const [key, lines] of file.memberAccesses) {
      const [module, member] = splitKey(key);
      const info = deprecations.get(module)?.members.get(member);
      if (info) add(module, member, info, { path: file.path, line: lines[0] });
    }
  }

  const current = workspace.angular.major;
  /**
   * Overdue means deprecated two or more Angular majors ago. Only Angular's and
   * NgRx's version numbers follow Angular majors; RxJS has its own ("7.0"), and
   * comparing that with Angular 22 would call every RxJS deprecation overdue.
   */
  const isOverdue = (info: DeprecationInfo, module?: string): boolean =>
    (module === undefined || module.startsWith('@angular/') || module.startsWith('@ngrx/')) && current !== undefined && info.since !== undefined && current - Number.parseInt(info.since, 10) >= 2;
  const sorted = [...usages.values()];
  const groups = groupByDeprecation(sorted).sort((left, right) => Number(isOverdue(right.info, right.module)) - Number(isOverdue(left.info, left.module)) || right.refs.length - left.refs.length);

  const findings: Finding[] = groups.map((group) => ({
    severity: isOverdue(group.info, group.module) ? 'high' : 'medium',
    message: `${group.names.map((name) => `\`${name}\``).join(', ')} from ${group.module}, used in ${plural(group.refs.length, 'file')}${testShare(group.refs)}`,
    detail: describe(group.info),
    files: group.refs.slice(0, context.maxExamples),
    count: group.refs.length,
  }));

  const ngIf = deprecations.get('@angular/common')?.symbols.get('NgIf');
  if (ngIf && legacyUses > 0) {
    findings.push({
      severity: isOverdue(ngIf) ? 'high' : 'medium',
      message: `${plural(legacyUses, 'use')} of \`*ngIf\`, \`*ngFor\` and \`[ngSwitch]\` in ${plural(legacyTemplates.length, 'template')}`,
      detail: `${describe(ngIf)} \`ng generate @angular/core:control-flow\` migrates most templates to \`@if\`, \`@for\` and \`@switch\` automatically; what it leaves behind is usually an \`ngFor\` with a custom \`trackBy\` or a template reference it cannot follow.`,
      files: legacyTemplates.slice(0, context.maxExamples).map((template) => ({ path: template.path, line: template.firstLegacyLine })),
      count: legacyTemplates.length,
    });
  }

  // `.toPromise()`: deprecated in RxJS 7 and removed in 8, so it only counts from 7 on.
  const rxjsMajor = majorOf(workspace.versions['rxjs'] ?? workspace.dependencies['rxjs']);
  const toPromiseFiles = context.sources.filter((file) => file.toPromiseLines.length > 0);
  const toPromiseCalls = toPromiseFiles.reduce((sum, file) => sum + file.toPromiseLines.length, 0);
  if (rxjsMajor !== undefined && rxjsMajor >= 7 && toPromiseCalls > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(toPromiseCalls, '`.toPromise()` call')} in ${plural(toPromiseFiles.length, 'file')}`,
      detail: 'Deprecated in RxJS 7 and removed in RxJS 8. `firstValueFrom(source$)` or `lastValueFrom(source$)` replace it; pick by whether the code wants the first value or waits for completion.',
      files: toPromiseFiles.slice(0, context.maxExamples).map((file) => ({ path: file.path, line: file.toPromiseLines[0] })),
      count: toPromiseFiles.length,
    });
  }

  // What the next major removes or newly deprecates among the imports: visible before `ng update`, not after.
  const next = context.nextMajor;
  const nextLabel = next ? `Angular ${next.major}${next.prerelease ? ` (${next.version}, a prerelease)` : ''}` : '';
  const listChanges = (changes: NonNullable<typeof next>['removed'], withReason: boolean): string =>
    `${changes
      .slice(0, 8)
      .map((change) => {
        // Some tags lose their code span in the parsed comment and read just "use"; a reason that short says nothing.
        const reason = change.info?.message.replace(/\.$/, '') ?? '';
        return `\`${change.name}\` from ${change.module} (${plural(change.refs.length, 'file')})${withReason && reason.length >= 12 ? `: ${reason}` : ''}`;
      })
      .join('; ')}${changes.length > 8 ? `; and ${changes.length - 8} more` : ''}.`;
  const filesOf = (changes: NonNullable<typeof next>['removed']): FileRef[] => {
    const refs: FileRef[] = [];
    for (const change of changes) for (const ref of change.refs) if (!refs.some((existing) => existing.path === ref.path)) refs.push(ref);
    return refs;
  };
  if (next && next.removed.length > 0) {
    const refs = filesOf(next.removed);
    findings.unshift({
      severity: 'high',
      message: `${plural(next.removed.length, 'imported API')} removed in ${nextLabel}, imported in ${plural(refs.length, 'file')}`,
      detail: `${listChanges(next.removed, false)} The ${next.major} type definitions no longer export ${next.removed.length === 1 ? 'it, so the import stops' : 'them, so each import stops'} compiling after \`ng update\`; replace ${next.removed.length === 1 ? 'it' : 'them'} before that step. Read from the published typings of ${next.version}.`,
      files: refs.slice(0, context.maxExamples),
      count: refs.length,
    });
  }
  if (next && next.deprecated.length > 0) {
    const refs = filesOf(next.deprecated);
    findings.push({
      severity: 'low',
      message: `${plural(next.deprecated.length, 'imported API')} deprecated in ${nextLabel}`,
      detail: `${listChanges(next.deprecated, true)} Not deprecated in the installed version yet, so nothing above flags them; they still work after the upgrade and go away two majors later.`,
      files: refs.slice(0, context.maxExamples),
      count: refs.length,
    });
  }

  const affectedFiles = new Set(sorted.flatMap((usage) => usage.refs.map((ref) => ref.path)));
  // What the next major only deprecates (low) is advance notice, not a problem with the code today, so it does not grade.
  const graded = findings.filter((finding) => finding.severity !== 'low');
  const grade: Grade = graded.length === 0 ? 'good' : graded.some((finding) => finding.severity === 'high') ? 'poor' : 'fair';

  return {
    id: 'deprecated-apis',
    title: 'Deprecated APIs',
    grade,
    summary:
      graded.length === 0
        ? `${
            current !== undefined && current < context.latestAngular.major
              ? `Nothing deprecated as of Angular ${current} is in use; APIs deprecated in later versions surface at each upgrade step.`
              : 'No deprecated Angular or NgRx API in use.'
          }${next && next.deprecated.length > 0 ? ` ${plural(next.deprecated.length, 'import')} ${next.deprecated.length === 1 ? 'becomes' : 'become'} deprecated in Angular ${next.major}.` : ''}`
        : `${[
            usages.size > 0 ? `${plural(usages.size, 'deprecated symbol')} in ${plural(affectedFiles.size, 'file')}` : undefined,
            rxjsMajor !== undefined && rxjsMajor >= 7 && toPromiseCalls > 0 ? plural(toPromiseCalls, '`.toPromise()` call') : undefined,
            ngIf && legacyUses > 0 ? 'deprecated control flow in templates' : undefined,
            next && next.removed.length > 0 ? `${plural(next.removed.length, 'import')} removed in Angular ${next.major}` : undefined,
          ]
            .filter(Boolean)
            .join(', ')
            .replace(/^./, (first) => first.toUpperCase())}.`,
    metrics: [
      { label: 'Deprecated symbols', value: usages.size },
      { label: 'Files affected', value: formatCount(affectedFiles.size) },
      { label: 'Legacy template directives', value: formatCount(legacyUses), hint: ngIf ? 'deprecated' : 'not deprecated in this version' },
      ...(next ? [{ label: `Angular ${next.major}`, value: `${formatCount(next.removed.length)} removed, ${formatCount(next.deprecated.length)} deprecated`, hint: `imports, compared with ${next.version}` }] : []),
    ],
    findings,
    measures: [
      { id: 'deprecated-usages', label: 'Deprecated API uses (symbol × file)', value: sorted.reduce((sum, usage) => sum + usage.refs.length, 0) },
      { id: 'legacy-template-directives', label: '*ngIf / *ngFor / [ngSwitch] uses', value: legacyUses },
      { id: 'to-promise-calls', label: '.toPromise() calls', value: rxjsMajor !== undefined && rxjsMajor >= 7 ? toPromiseCalls : 0 },
    ],
  };
}

/** Symbols of one module deprecated for the same reason, reported as one finding. */
interface UsageGroup {
  module: string;
  names: string[];
  info: DeprecationInfo;
  /** Union of the members' files, one entry per file. */
  refs: FileRef[];
}

/**
 * Merges usages that share a module, a version and a message. A package
 * deprecated as a whole tags every export with the same sentence
 * (`@angular/animations`: `trigger`, `state`, `style`, `animate`, …), and one
 * finding per export would fill the top priorities with a single decision.
 */
function groupByDeprecation(usages: Usage[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const usage of usages) {
    const key = `${usage.module}\u0000${usage.info.since ?? ''}\u0000${usage.info.message}`;
    const group = groups.get(key) ?? { module: usage.module, names: [], info: usage.info, refs: [] };
    group.names.push(usage.name);
    for (const ref of usage.refs) if (!group.refs.some((existing) => existing.path === ref.path)) group.refs.push(ref);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * " (all in tests)" or " (12 in tests)" when some of the files are specs, since
 * a deprecated testing module is a smaller job than one in shipped code.
 * Empty when none are.
 */
function testShare(refs: FileRef[]): string {
  const inTests = refs.filter((ref) => isSpecFile(ref.path)).length;
  if (inTests === 0) return '';
  return inTests === refs.length ? ' (all in tests)' : ` (${formatCount(inTests)} in tests)`;
}

/** `module#Owner.member` split at the `#`. Module names never contain one. */
function splitKey(key: string): [string, string] {
  const separator = key.indexOf('#');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

/** "Deprecated since 20.0: Use the `@if` block instead." in the form the reports show. */
function describe(info: DeprecationInfo): string {
  const since = info.since ? `Deprecated since ${info.since}` : 'Deprecated';
  const message = info.message.replace(/\.?$/, '.');
  return info.message ? `${since}: ${message}` : `${since}.`;
}
