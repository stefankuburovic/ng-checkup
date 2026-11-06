import { createHash } from 'node:crypto';
import type { CheckResult, Finding, Report, Severity } from '../types.js';
import { findingIdentity } from './codequality.js';
import { formatLocation, sinceSentence } from './summary.js';

/**
 * The findings as backlog items (`--report x.issues.csv`, `x.issues.md`): one
 * row or checkbox per finding, for a person to import or paste. The tool
 * creates no tasks itself.
 *
 * Unlike every other report these list all the files of a finding, not the
 * first few, because a task has to say where the work is. The CLI runs the
 * checkup uncapped for them and caps the other reports again (`capExamples`);
 * a script using the API passes a high `maxExamples` for the same result.
 */

/** Excel stops a cell at this many characters, and Jira's description field has the same default limit. */
const CELL_LIMIT = 32_767;
/** Jira's limit for a summary. */
const SUMMARY_LIMIT = 255;

const ORDER: Severity[] = ['high', 'medium', 'low'];
const PRIORITY: Partial<Record<Severity, string>> = { high: 'High', medium: 'Medium', low: 'Low' };

interface Item {
  check: CheckResult;
  finding: Finding;
  fingerprint: string;
  files: string[];
}

/** True for a report that lists every file of a finding. */
export function isIssuesReport(path: string): boolean {
  return /\.issues\.(csv|md)$/i.test(path);
}

/** The report with each finding's example files cut to `max`, as the other formats show them. `count` keeps the real total. Does not mutate. */
export function capExamples(report: Report, max: number): Report {
  return { ...report, checks: report.checks.map((check) => ({ ...check, findings: check.findings.map((finding) => (finding.files && finding.files.length > max ? { ...finding, files: finding.files.slice(0, max) } : finding)) })) };
}

/**
 * The findings about the code, most urgent first and in report order within a
 * severity. `info` findings are about the run, so they are no work to do. The
 * fingerprint stays the same while the finding is the same, whatever its
 * count, so a later export can be matched with an earlier one.
 */
function itemsOf(report: Report): Item[] {
  const items = report.checks.flatMap((check) =>
    check.findings
      .filter((finding) => finding.severity !== 'info')
      .map((finding): Item => ({
        check,
        finding,
        fingerprint: createHash('sha256').update(findingIdentity(check.id, finding.message)).digest('hex').slice(0, 16),
        files: (finding.files ?? []).map(formatLocation),
      })),
  );
  return ORDER.flatMap((severity) => items.filter((item) => item.finding.severity === severity));
}

/**
 * One CSV cell. A cell a spreadsheet would run as a formula gets a leading
 * apostrophe: a message or a path comes from the repository being checked, and
 * a file named `=cmd|...` must not execute on the machine of whoever opens the
 * export.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Whole lines of `lines` that fit in `room` characters, and what was left out when some did not. */
function fitLines(lines: string[], room: number): string {
  const all = lines.join('\n');
  if (all.length <= room) return all;
  const kept: string[] = [];
  let used = 0;
  // Room for the closing line, whatever the number in it.
  const reserve = 80;
  for (const line of lines) {
    if (used + line.length + 1 > room - reserve) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, `... and ${lines.length - kept.length} more; the .issues.md and .json reports list them all`].join('\n');
}

/**
 * The backlog as CSV for a spreadsheet or the Jira importer: RFC 4180 quoting,
 * UTF-8 without a byte-order mark. `Summary` is the one column Jira requires.
 * Jira's description takes one column only, so `Description` holds the file
 * list too, and `Files` has it apart for a spreadsheet.
 */
export function renderIssuesCsv(report: Report): string {
  const rows = [['Summary', 'Priority', 'Labels', 'Description', 'Area', 'Files', 'Fingerprint'].join(',')];
  for (const { check, finding, fingerprint, files } of itemsOf(report)) {
    const detail = finding.detail ?? '';
    const heading = files.length > 0 ? `${detail ? `${detail}\n\n` : ''}Files:\n` : detail;
    rows.push(
      [
        finding.message.replace(/`/g, '').slice(0, SUMMARY_LIMIT),
        PRIORITY[finding.severity] ?? 'Low',
        `ng-checkup-${check.id}`,
        `${heading}${fitLines(files, CELL_LIMIT - heading.length)}`,
        check.title,
        fitLines(files, CELL_LIMIT),
        fingerprint,
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${rows.join('\r\n')}\r\n`;
}

/**
 * The backlog as a Markdown checklist, to paste into a GitHub or GitLab issue.
 * The fingerprint sits in an HTML comment, out of sight but searchable. Long
 * file lists fold, since both hosts render `<details>`.
 */
export function renderIssuesMarkdown(report: Report): string {
  const items = itemsOf(report);
  const lines = [`# ${report.project.name}: modernization backlog`, '', `${items.length === 1 ? '1 item' : `${items.length} items`}, most urgent first. Generated ${report.generatedAt.slice(0, 10)} by ${report.tool.name} ${report.tool.version}.`];
  const since = sinceSentence(report);
  if (since) lines.push('', since);
  lines.push('');
  for (const { check, finding, fingerprint, files } of items) {
    lines.push(`- [ ] **${finding.severity}** ${finding.message} (${check.title}) <!-- ng-checkup:${fingerprint} -->`);
    if (finding.detail) lines.push('', `  ${finding.detail}`);
    if (files.length > 0) {
      const list = files.map((file) => `  - \`${file}\``);
      if (files.length <= 5) lines.push('', ...list);
      else lines.push('', `  <details><summary>${files.length} files</summary>`, '', ...list, '', '  </details>');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
