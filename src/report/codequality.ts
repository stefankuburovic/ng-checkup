import { createHash } from 'node:crypto';
import type { CheckResult, Finding, Report, Severity } from '../types.js';

/** GitLab severities per finding severity. `info` findings are about the run, not the code, and are left out. */
const SEVERITIES: Record<Exclude<Severity, 'info'>, 'critical' | 'major' | 'minor'> = { high: 'critical', medium: 'major', low: 'minor' };

/**
 * The report as a GitLab Code Quality report (`--report x.codequality.json`),
 * the subset of the Code Climate format GitLab reads.
 *
 * Declared in a job as `artifacts: reports: codequality:`, it puts the
 * findings in the merge request's Code Quality widget, and GitLab itself
 * compares the MR with its target branch: findings the MR introduces are
 * listed as new, those it removes as resolved. That works on every GitLab
 * tier, self-hosted included, which is why it is GitLab's counterpart of the
 * SARIF report rather than a second copy of it.
 *
 * The comparison runs on `fingerprint`, so a fingerprint must stay the same
 * for as long as the finding is the same. It is built from the check, the
 * message with every number taken out, and the file: "41 explicit `any`"
 * becoming "42 explicit `any`" is the same finding at the same places, and
 * only the new file's entry is new. Line numbers are left out of it too, so
 * code moving down a file does not resurface a finding as new.
 *
 * One entry per example location, like the SARIF report; a finding about the
 * project as a whole sits on `package.json`.
 */
export function renderCodeQuality(report: Report): string {
  const entries = report.checks.flatMap((check) => check.findings.filter(isReported).flatMap((finding) => entriesOf(check, finding)));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/**
 * What a finding is about, with everything that changes with its size taken
 * out: numbers, and the singular or plural they force on the words around
 * them. "1 component uses eager change detection" and "2 components use
 * eager change detection" are one finding; without the second step GitLab
 * showed the first as resolved and the second as new on an unrelated file.
 * Exported for tests.
 */
export function findingKind(message: string): string {
  const irregular: Record<string, string> = { is: 'be', are: 'be', was: 'be', were: 'be', has: 'have', does: 'do', its: 'their' };
  return message
    .toLowerCase()
    .replace(/\d[\d\s.,%]*/g, '#')
    .split(/(\W+)/)
    .map((word) => irregular[word] ?? (/(ss|sh|ch|x)es$/.test(word) ? word.slice(0, -2) : word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word))
    .join('');
}

/** True for the findings that become Code Quality entries. */
function isReported(finding: Finding): finding is Finding & { severity: Exclude<Severity, 'info'> } {
  return finding.severity !== 'info';
}

/** The entries of one finding: one per example file, or one on `package.json`. */
function entriesOf(check: CheckResult, finding: Finding & { severity: Exclude<Severity, 'info'> }): Array<Record<string, unknown>> {
  const files = finding.files && finding.files.length > 0 ? finding.files : [{ path: 'package.json' }];
  const kind = findingKind(finding.message);
  return files.map((file) => ({
    type: 'issue',
    check_name: `ng-checkup/${check.id}`,
    description: `${finding.message.replace(/`/g, '')} (${check.title})`,
    ...(finding.detail ? { content: { body: finding.detail } } : {}),
    categories: [check.id === 'security' ? 'Security' : 'Style'],
    severity: SEVERITIES[finding.severity],
    fingerprint: createHash('sha256').update(`${check.id}\n${kind}\n${file.path}`).digest('hex'),
    location: { path: file.path, lines: { begin: file.line ?? 1 } },
  }));
}
