import type { CheckResult, Finding, Report, Severity } from '../types.js';
import { remainingCount } from './summary.js';

/** Where each check is documented; SARIF viewers link a rule's help there. */
const DOCS = 'https://github.com/stefankuburovic/ng-checkup/blob/main/docs/checks.md';

/** SARIF `level` per severity. `info` findings are hints about the run itself and are left out. */
const LEVELS: Record<Exclude<Severity, 'info'>, 'error' | 'warning' | 'note'> = { high: 'error', medium: 'warning', low: 'note' };

/**
 * The report as SARIF 2.1.0, the format GitHub code scanning (and Azure
 * DevOps, SonarQube, VS Code's SARIF viewer) reads. Uploaded with
 * `github/codeql-action/upload-sarif`, findings appear as annotations on the
 * lines of a pull request and in the repository's Security tab.
 *
 * One rule per check, not per finding: a finding's message carries counts and
 * names that change from run to run, and a rule id that changed with them
 * would make GitHub close every alert and open a new one on each push.
 *
 * One result per example location, because a viewer shows one annotation per
 * result. Only the examples are in the report (`--max-examples`, default 5),
 * so CI that wants every location raises it. A finding about the project as a
 * whole (an outdated Angular, a package that blocks the upgrade) has no file;
 * it is attached to `package.json`, since GitHub rejects a result without a
 * location. Paths stay relative to the analysed root, which is the repository
 * root in the usual setup; run from there for the annotations to land.
 */
export function renderSarif(report: Report): string {
  const checks = report.checks.filter((check) => check.findings.some(isReported));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            semanticVersion: report.tool.version,
            informationUri: 'https://github.com/stefankuburovic/ng-checkup',
            rules: checks.map(rule),
          },
        },
        invocations: [{ executionSuccessful: true, endTimeUtc: report.generatedAt }],
        results: checks.flatMap((check) => check.findings.filter(isReported).flatMap((finding) => results(check, finding))),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

/** True for the findings that become SARIF results. */
function isReported(finding: Finding): finding is Finding & { severity: Exclude<Severity, 'info'> } {
  return finding.severity !== 'info';
}

/** The rule describing one check. */
function rule(check: CheckResult): Record<string, unknown> {
  return {
    id: check.id,
    name: check.title.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : '')),
    shortDescription: { text: check.title },
    fullDescription: { text: check.summary },
    helpUri: `${DOCS}#${check.id}`,
    properties: { tags: ['angular', 'maintainability'] },
  };
}

/** The SARIF results of one finding: one per example file, or one on `package.json`. */
function results(check: CheckResult, finding: Finding & { severity: Exclude<Severity, 'info'> }): Array<Record<string, unknown>> {
  const files = finding.files && finding.files.length > 0 ? finding.files : [{ path: 'package.json' }];
  const more = remainingCount(finding);
  const text = [finding.message, finding.detail, more > 0 ? `${more} more location${more === 1 ? '' : 's'} not listed; raise --max-examples to report them all.` : undefined]
    .filter(Boolean)
    .join('\n\n');
  return files.map((file) => ({
    ruleId: check.id,
    level: LEVELS[finding.severity],
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: file.path, uriBaseId: '%SRCROOT%' },
          ...(file.line !== undefined ? { region: { startLine: file.line } } : {}),
        },
      },
    ],
  }));
}
