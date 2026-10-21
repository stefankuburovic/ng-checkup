import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArguments } from '../src/cli.js';
import { runCheckup } from '../src/index.js';
import { renderHtml } from '../src/report/html.js';
import { notesTemplate, renderNotes } from '../src/report/notes.js';
import { describeCheckout } from '../src/remote.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

describe('renderNotes', () => {
  it('renders headings, lists, tables and inline marks, and drops comments and empty sections', () => {
    const html = renderNotes(
      [
        '<!-- guidance for the consultant -->',
        '## Summary',
        'Upgrade in **two blocks**, see `ng update`.',
        '',
        '## Recommended plan',
        '| Phase | Estimate |',
        '| --- | --- |',
        '| Angular 18 | 3 |',
        '| Angular 19 | |',
        '',
        '## What else to address',
        '<!-- left empty -->',
        '',
        '## Next steps',
        '1. A call',
        '2. The first block',
        '- [Offer](https://example.com/offer)',
      ].join('\n'),
    );
    expect(html).not.toContain('guidance');
    expect(html).not.toContain('What else to address');
    expect(html).toContain('<h3>Summary</h3>');
    expect(html).toContain('<strong>two blocks</strong>');
    expect(html).toContain('<code>ng update</code>');
    expect(html).toContain('<tr><td>Angular 19</td><td></td></tr>');
    expect(html).toContain('<ol><li>A call</li><li>The first block</li></ol>');
    expect(html).toContain('<a href="https://example.com/offer">Offer</a>');
  });

  it('escapes everything, so notes can never inject markup or script links', () => {
    const html = renderNotes('<script>alert(1)</script> and [x](javascript:alert(1)) and <b onclick="x">b</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b ');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the client report', () => {
  it('opens with a cover, a summary, actions and the roadmap, and keeps the full report as an appendix', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true, plan: true });
    report.client = { name: 'Acme <GmbH>', preparedBy: 'Stefan Kuburovic, stefankuburovic.github.io', notes: '## Pricing\nFixed price: **9 days**.' };
    const html = renderHtml(report);
    expect(html).toContain('<title>Angular Health Check: Acme &lt;GmbH&gt;</title>');
    expect(html).toContain('<dt>Prepared by</dt><dd>Stefan Kuburovic, stefankuburovic.github.io</dd>');
    expect(html).toContain('id="summary-title"');
    expect(html).toContain('id="actions-title"');
    expect(html).toContain(`Roadmap: Angular ${report.plan!.from} → ${report.plan!.to}`);
    expect(html).toContain('Recommendations by Stefan Kuburovic');
    expect(html).toContain('<strong>9 days</strong>');
    expect(html.indexOf('id="notes-title"')).toBeLessThan(html.indexOf('Appendix: area by area'));
    for (const check of report.checks) expect(html).toContain(`id="${check.id}"`);
  });

  it('builds a notes template from the plan, with an empty estimate per step', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true, plan: true });
    const template = notesTemplate({ ...report, client: { name: 'Acme' } });
    expect(template).toContain('| Phase | Scope | Estimate |');
    for (const step of report.plan!.steps) expect(template).toContain(`| Angular ${step.to} | \`ng update\``);
    // Left as generated, it renders as nothing but the plan table: no instructions reach the client.
    expect(renderNotes(template)).not.toMatch(/Two or three sentences|What happens after/);
  });
});

describe('client flags', () => {
  const parse = (...argv: string[]) => parseCliArguments(argv, {}, false);

  it('turns on the plan, takes the name on the cover from the flag or the environment, and resolves the notes path', () => {
    expect(parse('--client', ' Acme ', '--notes', 'acme.md')).toMatchObject({ plan: true, client: { name: 'Acme', notes: resolve('acme.md') } });
    expect(parseCliArguments(['--client', 'Acme'], { NG_CHECKUP_PREPARED_BY: 'Stefan' }, false)).toMatchObject({ client: { name: 'Acme', preparedBy: 'Stefan' } });
    expect(() => parse('--notes', 'acme.md')).toThrow('belong to a client report');
    expect(() => parse('--client', ' ')).toThrow('needs the client name');
  });

  it('writes the template on the first run and uses it on the next, without a local path in the report', () => {
    const output = writeTemp({});
    const project = writeTemp({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '~15.2.0' } }), 'src/a.ts': 'export const a = 1;' });
    const cli = resolve('dist/cli.js');
    const run = () => spawnSync(process.execPath, [cli, project, '--offline', '--no-color', '--client', 'Acme', '--notes', join(output, 'notes.md'), '--report', join(output, 'r.html')], { encoding: 'utf8' });
    try {
      expect(run().stdout).toContain('Notes template written to');
      expect(existsSync(join(output, 'notes.md'))).toBe(true);
      writeFileSync(join(output, 'notes.md'), '## Pricing\nNine days, fixed.');
      expect(run().stdout).not.toContain('Notes template written');
      const html = readFileSync(join(output, 'r.html'), 'utf8');
      expect(html).toContain('Nine days, fixed.');
      expect(html).not.toContain(project);
    } finally {
      removeTemp(output);
      removeTemp(project);
    }
  }, 30_000);
});

describe('describeCheckout', () => {
  it('names a folder without git by its last segment only', () => {
    const root = writeTemp({});
    try {
      expect(describeCheckout(root)).toBe(root.split('/').pop());
    } finally {
      removeTemp(root);
    }
  });
});
