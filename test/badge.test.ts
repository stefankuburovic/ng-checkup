import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderForFile } from '../src/cli.js';
import { renderBadgeJson, renderBadgeSvg } from '../src/report/badge.js';
import type { CheckResult, Grade, Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

const report = (...grades: Grade[]): Report => ({
  tool: { name: 'ng-checkup', version: '2.1.0' },
  generatedAt: '2026-11-06T10:00:00.000Z',
  root: '/app',
  project: { name: 'shop', kind: 'angular-cli', sourceFiles: 1, templateFiles: 0, linesOfCode: 1 },
  checks: grades.map((grade, index): CheckResult => ({ id: `c${index}`, title: 'C', grade, summary: '', metrics: [], findings: [] })),
  durationMs: 1,
});

describe('the badge', () => {
  it('takes its colour from the same bands as the tables: 80 and 50', () => {
    expect(renderBadgeSvg(report('good', 'fair'))).toContain('80/100');
    expect(renderBadgeSvg(report('good', 'fair'))).toContain('fill="#2e7d32"');
    expect(renderBadgeSvg(report('good', 'fair', 'fair', 'fair'))).toContain('fill="#a15c00"');
    expect(renderBadgeSvg(report('good', 'fair', 'poor', 'poor'))).toContain('50/100');
    expect(renderBadgeSvg(report('good', 'fair', 'poor', 'poor'))).toContain('fill="#a15c00"');
    expect(renderBadgeSvg(report('fair', 'poor'))).toContain('40/100');
    expect(renderBadgeSvg(report('fair', 'poor'))).toContain('fill="#c62828"');
  });

  it('says n/a when nothing was graded', () => {
    const svg = renderBadgeSvg(report('info'));
    expect(svg).toContain('n/a');
    expect(svg).toContain('fill="#616161"');
    expect(JSON.parse(renderBadgeJson(report()))).toMatchObject({ message: 'n/a', color: '616161' });
  });

  it('is self-contained and named for a screen reader', () => {
    const svg = renderBadgeSvg(report('good'));
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="ng-checkup score: 100/100"');
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:/);
  });

  it('is a shields.io endpoint as JSON', () => {
    expect(JSON.parse(renderBadgeJson(report('good')))).toEqual({ schemaVersion: 1, label: 'ng-checkup', message: '100/100', color: '2e7d32' });
  });

  it('is picked by the file name, and any other .json stays the full report', () => {
    const data = report('good');
    expect(renderForFile(data, 'out/badge.svg')).toContain('<svg');
    expect(JSON.parse(renderForFile(data, 'badge.json')).schemaVersion).toBe(1);
    expect(JSON.parse(renderForFile(data, 'out/shop.badge.json')).schemaVersion).toBe(1);
    expect(JSON.parse(renderForFile(data, 'out/mybadge.json')).checks).toHaveLength(1);
    expect(JSON.parse(renderForFile(data, 'checkup.json')).checks).toHaveLength(1);
  });

  it('is written by a run and accepted in the config file', () => {
    const root = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '^22.0.0' } }), 'ng-checkup.config.json': JSON.stringify({ reports: ['from-config.svg'] }) });
    try {
      const cli = join(process.cwd(), 'dist', 'cli.js');
      execFileSync('node', [cli, root, '--offline'], { encoding: 'utf8' });
      execFileSync('node', [cli, root, '--offline', '--report', join(root, 'b.svg'), '--report', join(root, 'badge.json')], { encoding: 'utf8' });
      expect(readFileSync(join(root, 'b.svg'), 'utf8')).toContain('<svg');
      expect(JSON.parse(readFileSync(join(root, 'badge.json'), 'utf8')).label).toBe('ng-checkup');
      expect(readFileSync(join(root, 'from-config.svg'), 'utf8')).toContain('<svg');
    } finally {
      removeTemp(root);
    }
  });
});
