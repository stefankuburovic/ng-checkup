import { formatCount } from '../checks/context.js';
import type { SiteFinding, SiteProbe } from '../site.js';
import { palette } from './terminal.js';

/** The result of `ng-checkup url` as `--json` prints it. */
export interface SiteReport {
  tool: { name: string; version: string };
  generatedAt: string;
  probe: SiteProbe;
  latestAngular: { major: number; source: 'registry' | 'bundled' };
  findings: SiteFinding[];
}

/** `ng-checkup url` for a terminal: what runs on the site, then what that means. */
export function renderSiteTerminal(report: SiteReport, options: { color: boolean }): string {
  const c = palette(options.color);
  const { probe } = report;
  const bytes = probe.scripts.reduce((sum, script) => sum + script.bytes, 0);
  const host = new URL(probe.finalUrl).hostname;
  const lines = [
    `${c.bold(report.tool.name)} ${c.dim(report.tool.version)}  ${c.bold(probe.finalUrl)}${probe.title ? c.dim(`  ${probe.title}`) : ''}`,
    c.dim(`Read the page and ${probe.scripts.length === 1 ? '1 script' : `${formatCount(probe.scripts.length)} scripts`} (${(bytes / 1_000_000).toFixed(1)} MB) from ${host}${probe.skipped > 0 ? `; ${formatCount(probe.skipped)} skipped (other sites or the request limit)` : ''}`),
    '',
  ];
  if (probe.frameworks.length === 0) lines.push(`  ${c.dim('no framework recognised')}`);
  for (const framework of probe.frameworks) {
    const label = `${framework.name}${framework.version ? ` ${framework.version}` : ''}`;
    const zone = framework.name === 'Angular' && probe.zoneJs !== undefined ? (probe.zoneJs ? ', zone.js' : ', zoneless') : '';
    lines.push(`  ${c.bold(label.padEnd(22))} ${c.dim(`seen in ${framework.evidence}${zone}`)}`);
  }
  if (report.findings.length > 0) lines.push('');
  const tag = { high: c.red('high  '), medium: c.yellow('medium'), low: c.cyan('low   '), info: c.dim('note  ') } as const;
  for (const finding of report.findings) {
    lines.push(`  ${tag[finding.severity]} ${finding.message}`);
    if (finding.detail) lines.push(`         ${c.dim(finding.detail)}`);
  }
  lines.push('', c.dim(`Latest Angular: ${report.latestAngular.major} (${report.latestAngular.source === 'registry' ? 'npm registry' : 'bundled, offline'}). Only what a browser downloads was read.`));
  return lines.join('\n');
}
