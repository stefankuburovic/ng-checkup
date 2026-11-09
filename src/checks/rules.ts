import type { CheckResult, Finding, Measure } from '../types.js';
import { formatCount, plural, type AnalysisContext } from './context.js';

/**
 * The team's own rules from the config (see `CustomRule`), as an area that is
 * never graded: one finding per broken rule and one measure per rule, broken
 * or not, so the baseline holds a 0 and `--fail-on regression` fails on the
 * first violation of a rule that had none.
 *
 * Absent from the report when no rule is configured, so a project without
 * rules sees no new area.
 */
export function customRulesCheck(context: AnalysisContext): CheckResult | undefined {
  const facts = context.customRules;
  if (!facts || facts.rules.length === 0) return undefined;
  const findings: Finding[] = [];
  const measures: Measure[] = [];
  let broken = 0;
  for (const rule of facts.rules) {
    const violations = facts.violations.filter((violation) => violation.rule === rule.id).sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
    measures.push({ id: rule.id, label: `Rule ${rule.id}`, value: violations.length });
    if (violations.length === 0) continue;
    broken++;
    const what = rule.forbidImport
      ? `Forbidden ${rule.forbidImport.length === 1 ? 'import' : 'imports'}: ${rule.forbidImport.map((name) => `\`${name}\``).join(', ')}.`
      : `Lines matching \`${rule.pattern}\`.`;
    findings.push({
      severity: rule.severity,
      message: `${plural(violations.length, 'place')} ${violations.length === 1 ? 'breaks' : 'break'} rule \`${rule.id}\``,
      detail: `${rule.message ? `${sentence(rule.message)} ` : ''}${what} A rule from the config: \`ng-checkup baseline\` records the count, and \`--fail-on regression\` fails only when it goes up.`,
      files: violations.slice(0, context.maxExamples).map(({ path, line }) => ({ path, line })),
      count: violations.length,
    });
  }
  const total = facts.violations.length;
  return {
    id: 'rules',
    title: 'Custom rules',
    grade: 'info',
    summary:
      broken === 0
        ? `${plural(facts.rules.length, 'rule')} from the config, none broken.`
        : `${plural(facts.rules.length, 'rule')} from the config, ${formatCount(broken)} broken in ${plural(total, 'place')}.`,
    metrics: [
      { label: 'Rules', value: formatCount(facts.rules.length) },
      { label: 'Broken', value: formatCount(broken) },
      { label: 'Places', value: formatCount(total) },
    ],
    findings,
    measures,
  };
}

/** The rule's message as a sentence: trimmed, with a full stop unless it already ends in punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
