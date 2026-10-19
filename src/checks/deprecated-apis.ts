import type { DeprecationInfo } from '../deprecations.js';
import { isSpecFile } from '../files.js';
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
      summary: 'Dependencies are not installed, so deprecations could not be read from the Angular packages.',
      metrics: [{ label: 'Legacy template directives', value: formatCount(legacyUses) }],
      findings: [
        {
          severity: 'info',
          message: 'Run `npm install` (or your package manager) and re-run for this check',
          detail: 'Deprecations are read from the `@deprecated` tags of the installed `@angular/*` and `@ngrx/*` type definitions, so they always match the version the project actually uses.',
        },
      ],
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
  const isOverdue = (info: DeprecationInfo): boolean => current !== undefined && info.since !== undefined && current - Number.parseInt(info.since, 10) >= 2;
  const sorted = [...usages.values()];
  const groups = groupByDeprecation(sorted).sort((left, right) => Number(isOverdue(right.info)) - Number(isOverdue(left.info)) || right.refs.length - left.refs.length);

  const findings: Finding[] = groups.map((group) => ({
    severity: isOverdue(group.info) ? 'high' : 'medium',
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

  const affectedFiles = new Set(sorted.flatMap((usage) => usage.refs.map((ref) => ref.path)));
  const grade: Grade = findings.length === 0 ? 'good' : findings.some((finding) => finding.severity === 'high') ? 'poor' : 'fair';

  return {
    id: 'deprecated-apis',
    title: 'Deprecated APIs',
    grade,
    summary:
      findings.length === 0
        ? current !== undefined && current < context.latestAngular.major
          ? `Nothing deprecated as of Angular ${current} is in use; APIs deprecated in later versions surface at each upgrade step.`
          : 'No deprecated Angular or NgRx API in use.'
        : `${plural(usages.size, 'deprecated symbol')} in ${plural(affectedFiles.size, 'file')}${ngIf && legacyUses > 0 ? ', plus deprecated control flow in templates' : ''}.`,
    metrics: [
      { label: 'Deprecated symbols', value: usages.size },
      { label: 'Files affected', value: formatCount(affectedFiles.size) },
      { label: 'Legacy template directives', value: formatCount(legacyUses), hint: ngIf ? 'deprecated' : 'not deprecated in this version' },
    ],
    findings,
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
