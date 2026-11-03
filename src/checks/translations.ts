import type { CheckResult, Finding, Grade } from '../types.js';
import { formatCount, plural, verb, type AnalysisContext } from './context.js';

/**
 * Translation keys that resolve to no string, the defect a user sees as a
 * raw key (`orders.cannot_delete`) on screen and every gate misses.
 *
 * Graded on the keys the bundles should know: a key some language lacks
 * while that language has the key's namespace, or another language has the
 * key. Those are typos, keys under the wrong namespace and strings added to
 * one language only. Keys whose namespace no bundle has are reported but not
 * graded, since a library's own bundle or a loader that reads the backend
 * may well supply them.
 */
export function translationsCheck(context: AnalysisContext): CheckResult {
  const facts = context.translations;
  if (!facts) {
    return {
      id: 'translations',
      title: 'Translations',
      grade: 'info',
      summary: 'No ngx-translate or Transloco bundle found to check translation keys against.',
      metrics: [],
      findings: [],
    };
  }

  const findings: Finding[] = [];
  const example = (entries: typeof facts.missing) => entries.slice(0, context.maxExamples).map((entry) => entry.file);
  const listed = (entries: typeof facts.missing) =>
    entries
      .slice(0, context.maxExamples)
      .map((entry) => `\`${entry.key}\`${entry.languages.length < facts.languages.length ? ` (${entry.languages.join(', ')})` : ''}`)
      .join(', ');
  if (facts.missing.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(facts.missing.length, 'translation key')} ${verb(facts.missing.length, 'resolves', 'resolve')} to no string in at least one language`,
      detail: `${facts.library === 'transloco' ? 'Transloco' : 'ngx-translate'} renders the key itself when a lookup fails, so this is what the user reads where a sentence should be. Neither the compiler nor a test sees it. A key under the wrong namespace looks exactly like a missing one. First ones: ${listed(facts.missing)}.`,
      files: example(facts.missing),
      count: facts.missing.length,
    });
  }
  if (facts.unknownNamespace.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(facts.unknownNamespace.length, 'translation key')} under a namespace no bundle has`,
      detail: `Either they are missing everywhere, or they come from somewhere this report does not read: a library's own bundle, a loader that fetches the backend, a bundle outside an \`i18n\` folder. Not graded for that reason. First ones: ${listed(facts.unknownNamespace)}.`,
      files: example(facts.unknownNamespace),
      count: facts.unknownNamespace.length,
    });
  }

  const missing = facts.missing.length;
  const grade: Grade = missing === 0 ? 'good' : missing <= 10 ? 'fair' : 'poor';
  return {
    id: 'translations',
    title: 'Translations',
    grade,
    summary:
      missing === 0
        ? `All ${plural(facts.keys, 'literal translation key')} resolve in ${facts.languages.join(', ')}.`
        : `${formatCount(missing)} of ${plural(facts.keys, 'literal translation key')} ${verb(missing, 'resolves', 'resolve')} to no string in some language.`,
    metrics: [
      { label: 'Literal keys', value: formatCount(facts.keys) },
      { label: 'Languages', value: formatCount(facts.languages.length), hint: facts.languages.join(', ') },
      { label: 'Missing', value: formatCount(missing) },
      { label: 'Unknown namespace', value: formatCount(facts.unknownNamespace.length) },
    ],
    findings,
    measures: [{ id: 'missing-keys', label: 'Translation keys that resolve to no string', value: missing }],
  };
}
