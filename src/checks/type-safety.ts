import type { CheckResult, Finding, Grade } from '../types.js';
import { applicationFiles, formatCount, plural, type AnalysisContext } from './context.js';

/**
 * Explicit `any` per 1 000 lines of application code above which the count is
 * a `medium` finding rather than a `low` one. Two per thousand lines is roughly
 * one per large component: past that, `any` is a habit rather than an exception.
 */
const ANY_DENSITY_THRESHOLD = 2;

/**
 * How much of the code the compiler actually checks: the strictness flags of
 * the application tsconfig, and the escape hatches the code uses to get
 * around them.
 *
 * `strictNullChecks` and `strictTemplates` carry the grade. They are the two
 * flags whose absence lets the most common runtime errors through (an
 * `undefined` dereference, a mistyped template binding), and both are the
 * ones large codebases most often have switched off because turning them on
 * is a campaign rather than an edit.
 */
export function typeSafetyCheck(context: AnalysisContext): CheckResult {
  const options = context.appCompilerOptions;
  const angular = context.angularCompilerOptions;
  const hasConfig = context.workspace.appTsconfig !== undefined;

  const strictNullChecks = options.strictNullChecks ?? options.strict ?? false;
  const noImplicitAny = options.noImplicitAny ?? options.strict ?? false;
  const strictTemplates = angular['strictTemplates'] === true;

  const application = applicationFiles(context);
  const linesOfCode = application.reduce((sum, file) => sum + file.linesOfCode, 0);
  const anyCount = application.reduce((sum, file) => sum + file.anyLines.length, 0);
  const anyDensity = linesOfCode === 0 ? 0 : (anyCount / linesOfCode) * 1000;
  const nonNull = application.reduce((sum, file) => sum + file.nonNullLines.length, 0);
  const suppressions = context.sources.reduce((sum, file) => sum + file.typeSuppressions, 0);
  const templateAnyCasts = context.templates.reduce((sum, template) => sum + template.stats.anyCasts, 0);
  const untypedForms = application.filter((file) =>
    file.imports.some((fact) => fact.specifier === '@angular/forms' && fact.bindings.some((binding) => binding.imported.startsWith('Untyped'))),
  );

  const findings: Finding[] = [];
  if (hasConfig && !strictNullChecks) {
    findings.push({
      severity: 'high',
      message: '`strictNullChecks` is off',
      detail:
        'Every value that may be `null` or `undefined` is typed as if it never is, so the most common runtime error in an Angular app is invisible to the compiler. In a large codebase switching it on is staged: a separate tsconfig that checks one folder at a time, with a count that may only go down.',
    });
  }
  if (hasConfig && !strictTemplates) {
    findings.push({
      severity: 'high',
      message: '`strictTemplates` is off',
      detail: 'Template bindings are only loosely type-checked: a wrong input type, a misspelled output payload or a possibly-undefined value passed to a component compiles and fails at runtime. Turning it on typically surfaces a batch of real bugs alongside the type noise.',
    });
  }
  if (hasConfig && !noImplicitAny) {
    findings.push({ severity: 'medium', message: '`noImplicitAny` is off', detail: 'An unannotated parameter silently becomes `any`, and no lint rule that counts the word `any` can see it.' });
  }
  if (anyCount > 0) {
    const examples = application.filter((file) => file.anyLines.length > 0).sort((left, right) => right.anyLines.length - left.anyLines.length);
    findings.push({
      severity: anyDensity > ANY_DENSITY_THRESHOLD ? 'medium' : 'low',
      message: `${formatCount(anyCount)} explicit \`any\` in application code (${anyDensity.toFixed(1)} per 1 000 lines)`,
      detail: 'Files with the most are listed first. Each `any` switches type checking off for everything that flows through it.',
      files: examples.slice(0, context.maxExamples).map((file) => ({ path: file.path, line: file.anyLines[0] })),
      count: examples.length,
    });
  }
  if (nonNull > 0) {
    findings.push({ severity: 'low', message: `${plural(nonNull, 'non-null assertion')} (\`x!\`) in application code`, detail: 'Each tells the compiler a value cannot be `null` without proving it; under `strictNullChecks` they are where the remaining null errors hide.' });
  }
  if (suppressions > 0) {
    findings.push({ severity: 'low', message: `${plural(suppressions, '`@ts-ignore` / `@ts-expect-error` comment')}`, detail: 'Each switches off checking for the next line, including errors nobody has seen yet.' });
  }
  if (templateAnyCasts > 0) {
    findings.push({ severity: 'low', message: `${plural(templateAnyCasts, '`$any()` cast')} in templates`, detail: 'The template equivalent of `as any`; usually a sign the component exposes a type the template cannot narrow.' });
  }
  if (untypedForms.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(untypedForms.length, 'file')} ${untypedForms.length === 1 ? 'imports' : 'import'} \`UntypedForm*\` classes`,
      detail: 'Typed reactive forms exist since Angular 14. The `Untyped*` aliases were the escape hatch `ng update` inserted so the upgrade would compile; each is a form whose values are still `any`.',
      files: untypedForms.slice(0, context.maxExamples).map((file) => ({ path: file.path })),
      count: untypedForms.length,
    });
  }

  const grade: Grade = !hasConfig
    ? 'info'
    : !strictNullChecks && !strictTemplates
      ? 'poor'
      : !strictNullChecks || !strictTemplates || !noImplicitAny || anyDensity > ANY_DENSITY_THRESHOLD
        ? 'fair'
        : 'good';

  const on = (flag: boolean): string => (flag ? 'on' : 'off');
  return {
    id: 'type-safety',
    title: 'Type safety',
    grade,
    summary: hasConfig
      ? `strictNullChecks ${on(strictNullChecks)}, strictTemplates ${on(strictTemplates)}, ${formatCount(anyCount)} explicit any.`
      : 'No application tsconfig found.',
    metrics: [
      { label: 'strictNullChecks', value: on(strictNullChecks) },
      { label: 'strictTemplates', value: on(strictTemplates) },
      { label: 'noImplicitAny', value: on(noImplicitAny) },
      { label: 'Explicit any', value: formatCount(anyCount), hint: `${anyDensity.toFixed(1)} per 1 000 lines` },
      { label: 'Non-null assertions', value: formatCount(nonNull) },
    ],
    findings,
  };
}
