import type { I18nFacts, I18nIssue } from '../i18n.js';
import type { TranslationFacts } from '../translations.js';
import type { CheckResult, FileRef, Finding, Measure, Metric } from '../types.js';
import { formatCount, plural, verb, type AnalysisContext } from './context.js';

/** One half of the area, before the two are put together. */
interface AreaPart {
  summary: string;
  metrics: Metric[];
  findings: Finding[];
  measures: Measure[];
}

/**
 * Translation keys that resolve to no string, the defect a user sees as a
 * raw key (`orders.cannot_delete`) on screen and every gate misses.
 *
 * Never graded: always `info`, so it adds nothing to the score and a run
 * on 2.0 scores the same as on 1.x. The other areas grade how current and
 * safe the code is; this one only finds defects, and as a graded area every
 * app on ngx-translate with complete bundles would gain a free 100. It still
 * has teeth: the measure `missing-keys` sits in the baseline, so
 * `--fail-on regression` fails on every key that goes missing.
 *
 * A key is missing when some language lacks it while that language has the
 * key's namespace, or another language has the key: typos, keys under the
 * wrong namespace and strings added to one language only. Keys whose
 * namespace no bundle has are listed apart at low severity and stay out of
 * the measure, since a library's own bundle or a loader that reads the
 * backend may well supply them.
 */
export function translationsCheck(context: AnalysisContext): CheckResult {
  const facts = context.translations;
  const i18n = context.i18n;
  if (!facts && !i18n) {
    return {
      id: 'translations',
      title: 'Translations',
      grade: 'info',
      summary: 'No ngx-translate or Transloco bundle and no `i18n` locales found to check translations against.',
      metrics: [],
      findings: [],
    };
  }
  const library = facts ? libraryKeys(context, facts) : { findings: [], metrics: [], measures: [], summary: '' };
  const built = i18n ? builtInI18n(context, i18n) : { findings: [], metrics: [], measures: [], summary: '' };
  return {
    id: 'translations',
    title: 'Translations',
    grade: 'info',
    summary: [library.summary, built.summary].filter(Boolean).join(' '),
    metrics: [...library.metrics, ...built.metrics],
    findings: [...library.findings, ...built.findings],
    measures: [...library.measures, ...built.measures],
  };
}

/** One library's half of the area: literal keys against the bundles. */
function libraryKeys(context: AnalysisContext, facts: TranslationFacts): AreaPart {
  const findings: Finding[] = [];
  const example = (entries: typeof facts.missing) => entries.slice(0, context.maxExamples).map((entry) => entry.file);
  // Capped on its own: a `--since` run lifts maxExamples for the narrowing, and the detail would list every key.
  const listed = (entries: typeof facts.missing) =>
    entries
      .slice(0, Math.min(context.maxExamples, 10))
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
  return {
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

/** The ids of a list of issues for a finding's detail, capped, with their locales. */
function listedIssues(context: AnalysisContext, issues: I18nIssue[]): string {
  const byId = new Map<string, string[]>();
  for (const issue of issues) byId.set(issue.id, [...(byId.get(issue.id) ?? []), issue.locale]);
  const shown = [...byId.entries()].slice(0, Math.min(context.maxExamples, 10));
  return `${shown.map(([id, locales]) => `\`${id}\` (${locales.join(', ')})`).join(', ')}${byId.size > shown.length ? ', ...' : ''}`;
}

/** The files behind a list of issues, one line per file, most issues first. */
function issueFiles(context: AnalysisContext, issues: I18nIssue[]): { files: FileRef[]; count: number } {
  const byPath = new Map<string, I18nIssue[]>();
  for (const issue of issues) byPath.set(issue.file.path, [...(byPath.get(issue.file.path) ?? []), issue]);
  const sorted = [...byPath.values()].sort((left, right) => right.length - left.length);
  return { files: sorted.slice(0, context.maxExamples).map((entries) => entries.find((entry) => entry.file.line !== undefined)?.file ?? entries[0]!.file), count: sorted.length };
}

/** Angular's built-in i18n's half of the area: each locale against the source file. */
function builtInI18n(context: AnalysisContext, i18n: I18nFacts): AreaPart {
  const findings: Finding[] = [];
  const source = i18n.sourceFiles.length > 0 ? `the source file ${i18n.sourceFiles.map((path) => `\`${path}\``).join(', ')}` : 'the source file';
  const stale = `Compared with ${source}, not with the code, since an id without \`@@\` is a hash of the message. That file can be out of date, so run \`ng extract-i18n\` first.`;
  if (i18n.missing.length > 0) {
    findings.push({
      severity: 'medium',
      message: `${plural(i18n.missing.length, 'message')} without a translation (${i18n.locales.join(', ')})`,
      detail: `Angular falls back to the source text, so users of that language read those parts in the source language, and by default the build only warns (\`i18nMissingTranslation\`). ${listedIssues(context, i18n.missing)}. ${stale}`,
      ...issueFiles(context, i18n.missing),
    });
  }
  if (i18n.needsTranslation.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(i18n.needsTranslation.length, 'translation')} marked as not done`,
      detail: `State \`new\` or \`needs-translation\` in XLIFF 1.2, \`initial\` in 2.0, and the target is still the source text: a merge tool copied it there and nobody has translated it, so those users read the source language and the build does not warn. A different text under such a state is left out, since someone translated it and kept the state. ${listedIssues(context, i18n.needsTranslation)}.`,
      ...issueFiles(context, i18n.needsTranslation),
    });
  }
  if (i18n.obsolete.length > 0) {
    findings.push({
      severity: 'low',
      message: `${plural(i18n.obsolete.length, 'translation')} of messages no longer in the source file`,
      detail: `Harmless in the build. Often the message was reworded, so its hash changed, and the same text now counts as missing. ${listedIssues(context, i18n.obsolete)}. ${stale}`,
      ...issueFiles(context, i18n.obsolete),
    });
  }
  if (i18n.sourceFiles.length === 0) {
    findings.push({ severity: 'info', message: 'No i18n source file found, so missing and obsolete translations were not compared', detail: 'Run `ng extract-i18n`, or name the file with `outputPath` and `outFile` on the `extract-i18n` target.' });
  }
  if (i18n.unreadable.length > 0) {
    findings.push({ severity: 'info', message: `${plural(i18n.unreadable.length, 'i18n file')} not read`, detail: 'Missing from disk, or in a format this does not read (XMB and XTB). XLIFF 1.2 and 2.0, JSON and ARB are read.', files: i18n.unreadable.slice(0, context.maxExamples).map((path) => ({ path })), count: i18n.unreadable.length });
  }
  const total = i18n.missing.length + i18n.needsTranslation.length;
  return {
    summary: i18n.sourceFiles.length === 0 ? `${plural(i18n.locales.length, 'locale')} (${i18n.locales.join(', ')}), no source file to compare with.` : total === 0 ? `All ${plural(i18n.messages, 'message')} translated in ${i18n.locales.join(', ')}.` : `${plural(total, 'translation')} missing or not done across ${plural(i18n.locales.length, 'locale')}.`,
    metrics: [
      { label: 'Messages', value: formatCount(i18n.messages), hint: 'in the source file' },
      { label: 'Locales', value: formatCount(i18n.locales.length), hint: i18n.locales.join(', ') },
      { label: 'Without translation', value: formatCount(i18n.missing.length) },
      { label: 'Not done', value: formatCount(i18n.needsTranslation.length) },
      { label: 'Obsolete', value: formatCount(i18n.obsolete.length) },
    ],
    findings,
    measures: [
      { id: 'i18n-missing', label: 'Messages without a translation', value: i18n.missing.length },
      { id: 'i18n-not-done', label: 'Translations marked as not done', value: i18n.needsTranslation.length },
      { id: 'i18n-obsolete', label: 'Translations of messages no longer in the source file', value: i18n.obsolete.length },
    ],
  };
}
