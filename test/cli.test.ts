import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliArguments, shouldFail } from '../src/cli.js';
import type { Report } from '../src/types.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

describe('parseCliArguments', () => {
  const parse = (...argv: string[]) => parseCliArguments(argv, {}, true);

  it('defaults to the current directory with colour on a TTY', () => {
    expect(parse()).toMatchObject({ root: process.cwd(), reports: [], json: false, verbose: false, maxExamples: 5, offline: false, color: true });
  });

  it('turns colour off for NO_COLOR, --no-color and a non-TTY', () => {
    expect(parseCliArguments([], { NO_COLOR: '' }, true)).toMatchObject({ color: false });
    expect(parse('--no-color')).toMatchObject({ color: false });
    expect(parseCliArguments([], {}, false)).toMatchObject({ color: false });
  });

  it('collects repeated reports and the CI options', () => {
    expect(parse(fixture('modern-app'), '-r', 'a.html', '--report', 'b.json', '--fail-on', 'poor', '--max-examples', '2', '--offline')).toMatchObject({
      root: fixture('modern-app'),
      reports: ['a.html', 'b.json'],
      failOn: 'poor',
      maxExamples: 2,
      offline: true,
    });
  });

  it('rejects what it cannot act on, with a message for the user', () => {
    expect(() => parse('/definitely/not/here')).toThrow('Not a directory');
    expect(() => parse('--report', 'out.pdf')).toThrow('use .html, .md or .json');
    expect(() => parse('--fail-on', 'good')).toThrow('--fail-on takes poor or fair');
    expect(() => parse('--max-examples', 'abc')).toThrow('whole number');
    expect(() => parse('--max-examples', '1.5')).toThrow('whole number');
    expect(() => parse('a', 'b')).toThrow('Expected one path');
  });

  it('answers help and version before validating anything else', () => {
    expect(parse('--help', '/definitely/not/here')).toBe('help');
    expect(parse('--version')).toBe('version');
  });
});

describe('shouldFail', () => {
  const report = (grades: Array<'good' | 'fair' | 'poor' | 'info'>) =>
    ({ checks: grades.map((grade, index) => ({ id: `c${index}`, title: '', grade, summary: '', metrics: [], findings: [] })) }) as unknown as Report;

  it('fails at or above the threshold and never on info', () => {
    expect(shouldFail(report(['good', 'fair']), 'poor')).toBe(false);
    expect(shouldFail(report(['good', 'poor']), 'poor')).toBe(true);
    expect(shouldFail(report(['good', 'fair']), 'fair')).toBe(true);
    expect(shouldFail(report(['info', 'good']), 'fair')).toBe(false);
    expect(shouldFail(report(['poor']), undefined)).toBe(false);
  });
});

/**
 * End-to-end through the compiled CLI. `npm test` builds first (`pretest`), so
 * `dist/cli.js` is current; running Vitest directly without a build fails
 * here on purpose rather than skipping, since a skipped test reads as green.
 */
describe('the built CLI', () => {
  const cli = join(fixture('..'), '..', 'dist', 'cli.js');
  beforeAll(() => {
    if (!existsSync(cli)) throw new Error(`${cli} is missing: run npm run build first (npm test does it for you).`);
  });
  let output = '';
  afterEach(() => output && removeTemp(output));

  it('writes every requested report and exits 1 when --fail-on trips', () => {
    output = writeTemp({});
    const result = spawnSync(process.execPath, [cli, fixture('legacy-app'), '--offline', '--no-color', '--fail-on', 'poor', '-r', join(output, 'r.html'), '-r', join(output, 'r.md'), '-r', join(output, 'r.json')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Top priorities');
    expect(readFileSync(join(output, 'r.html'), 'utf8')).toContain('<!doctype html>');
    expect(readFileSync(join(output, 'r.md'), 'utf8')).toContain('# Angular checkup: legacy-app');
    expect((JSON.parse(readFileSync(join(output, 'r.json'), 'utf8')) as Report).checks).toHaveLength(8);
  });

  it('prints JSON to stdout with --json and exits 2 on a bad argument', () => {
    const json = execFileSync(process.execPath, [cli, fixture('modern-app'), '--offline', '--json'], { encoding: 'utf8' });
    expect((JSON.parse(json) as Report).project.name).toBe('modern-app');
    expect(spawnSync(process.execPath, [cli, '--fail-on', 'never'], { encoding: 'utf8' }).status).toBe(2);
  });
});
