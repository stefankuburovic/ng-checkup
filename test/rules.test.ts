import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, mergeConfig, parseInlineConfig } from '../src/config.js';
import { overallScore } from '../src/report/summary.js';
import { CHECK_IDS, runCheckup } from '../src/index.js';
import { parseRules, patternViolations, RuleTimeoutError } from '../src/rules.js';
import { removeTemp, writeTemp } from './helpers.js';

const cli = join(process.cwd(), 'dist', 'cli.js');

describe('parseRules', () => {
  it('fills the defaults and accepts one package or a list', () => {
    expect(parseRules([{ id: 'no-moment', forbidImport: 'moment' }, { id: 'no-log', pattern: 'console\\.log', files: ['src'], severity: 'low', message: 'Use the logger' }], 'x')).toEqual([
      { id: 'no-moment', forbidImport: ['moment'], severity: 'medium' },
      { id: 'no-log', pattern: 'console\\.log', files: ['src'], severity: 'low', message: 'Use the logger' },
    ]);
    expect(parseRules([{ id: 'a', forbidImport: ['lodash', 'jquery/'] }], 'x')[0]!.forbidImport).toEqual(['lodash', 'jquery']);
  });

  it('stops on every mistake, naming the rule and the key', () => {
    const bad = (rule: unknown): (() => unknown) => () => parseRules([rule], 'cfg.json');
    expect(() => parseRules({}, 'cfg.json')).toThrow('cfg.json: rules must be an array');
    expect(bad({ id: 'No Moment', forbidImport: 'moment' })).toThrow('needs an id of lower-case letters');
    expect(bad({ id: 'a' })).toThrow('rule a needs exactly one of forbidImport and pattern');
    expect(bad({ id: 'a', forbidImport: 'x', pattern: 'y' })).toThrow('exactly one of');
    expect(bad({ id: 'a', pattern: '(' })).toThrow('rule a: pattern is not a valid regular expression');
    expect(bad({ id: 'a', forbidImport: [] })).toThrow('forbidImport must be a package name or an array');
    expect(bad({ id: 'a', forbidImport: 'x', severity: 'critical' })).toThrow('severity must be "high", "medium" or "low"');
    expect(bad({ id: 'a', forbidImport: 'x', file: ['src'] })).toThrow('rule a: unknown key file');
    expect(bad({ id: 'a', forbidImport: 'x', files: 'src' })).toThrow('files must be an array of paths');
    expect(() => parseRules([{ id: 'a', forbidImport: 'x' }, { id: 'a', pattern: 'y' }], 'cfg.json')).toThrow('rule a is defined twice');
  });
});

describe('rules in the config', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  it('are read from the file and fail it like any other key', () => {
    root = writeTemp({ 'ng-checkup.config.json': JSON.stringify({ rules: [{ id: 'no-moment', forbidImport: 'moment' }] }), 'bad.json': JSON.stringify({ rules: [{ id: 'x', pattern: '[' }] }) });
    expect(loadConfig(root).config.rules).toEqual([{ id: 'no-moment', forbidImport: ['moment'], severity: 'medium' }]);
    expect(() => loadConfig(root, join(root, 'bad.json'))).toThrow(`${join(root, 'bad.json')}: rule x: pattern is not a valid regular expression`);
  });

  it('--config-json lays its keys over the file and merges rules by id', () => {
    const file = { offline: false, maxExamples: 3, rules: parseRules([{ id: 'a', forbidImport: 'x' }, { id: 'b', forbidImport: 'y' }], 'f') };
    const inline = parseInlineConfig('{"offline":true,"rules":[{"id":"b","pattern":"z"},{"id":"c","forbidImport":"w"}]}');
    expect(mergeConfig(file, inline)).toEqual({
      offline: true,
      maxExamples: 3,
      rules: [
        { id: 'a', forbidImport: ['x'], severity: 'medium' },
        { id: 'b', pattern: 'z', severity: 'medium' },
        { id: 'c', forbidImport: ['w'], severity: 'medium' },
      ],
    });
    expect(() => parseInlineConfig('{rules:')).toThrow('--config-json is not valid JSON');
    expect(() => parseInlineConfig('[]')).toThrow('--config-json must be a JSON object');
    expect(() => parseInlineConfig('{"failon":"poor"}')).toThrow('--config-json: unknown key failon');
  });
});

describe('the custom-rules area', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  const project = (): string =>
    writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' } }),
      'src/app/a.ts': "import moment from 'moment';\nimport 'moment/locale/de';\nimport tz from 'moment-timezone';\nimport type { Moment } from 'moment';\n// console.log('left in a comment');\nconsole.log(moment());\n",
      'src/app/b.ts': "export const later = () => import('moment');\nconsole.debug('x');\n",
      'src/app/a.component.html': '<p>{{ value }}</p>\n<p style="color: red">x</p>\n',
      'src/app/a.spec.ts': "import moment from 'moment';\nfdescribe('a', () => { console.log(1); });\n",
      'src/app/api.generated.ts': '// @generated\nconsole.log(1);\n',
    });

  it('counts imports and lines per rule, leaving test and generated code out unless files names them', async () => {
    root = project();
    const rules = parseRules(
      [
        { id: 'no-moment', forbidImport: 'moment', message: 'Use date-fns' },
        { id: 'no-console', pattern: 'console\\.(log|debug)', severity: 'low' },
        { id: 'no-inline-style', pattern: 'style="' },
        { id: 'no-focused', pattern: '\\bf(describe|it)\\(', files: ['**/*.spec.ts'], severity: 'high' },
        { id: 'no-jquery', forbidImport: 'jquery' },
      ],
      'test',
    );
    const report = await runCheckup(root, { offline: true, rules });
    const check = report.checks.find((entry) => entry.id === 'rules')!;
    expect(check.grade).toBe('info');
    expect(check.summary).toBe('5 rules from the config, 4 broken in 8 places.');
    expect(check.measures).toEqual([
      { id: 'no-moment', label: 'Rule no-moment', value: 3 },
      { id: 'no-console', label: 'Rule no-console', value: 3 },
      { id: 'no-inline-style', label: 'Rule no-inline-style', value: 1 },
      { id: 'no-focused', label: 'Rule no-focused', value: 1 },
      { id: 'no-jquery', label: 'Rule no-jquery', value: 0 },
    ]);
    const moment = check.findings.find((finding) => finding.message.includes('no-moment'))!;
    // `moment` and `moment/locale/de` and `import()`, but not `moment-timezone`, `import type` or the spec.
    expect(moment.files).toEqual([
      { path: 'src/app/a.ts', line: 1 },
      { path: 'src/app/a.ts', line: 2 },
      { path: 'src/app/b.ts', line: 1 },
    ]);
    expect(moment.message).toBe('3 places break rule `no-moment`');
    expect(moment.detail).toMatch(/^Use date-fns\. Forbidden import: `moment`\./);
    // The comment counts: a pattern reads lines, not code. The spec and the generated file do not.
    expect(check.findings.find((finding) => finding.message.includes('no-console'))!.files).toEqual([
      { path: 'src/app/a.ts', line: 5 },
      { path: 'src/app/a.ts', line: 6 },
      { path: 'src/app/b.ts', line: 2 },
    ]);
    expect(check.findings.find((finding) => finding.message.includes('no-focused'))).toMatchObject({ severity: 'high', files: [{ path: 'src/app/a.spec.ts', line: 2 }] });
    expect(check.findings.some((finding) => finding.message.includes('no-jquery'))).toBe(false);
  });

  it('is absent without rules, never moves the score, and answers to --only and --skip', async () => {
    root = project();
    const rules = parseRules([{ id: 'no-moment', forbidImport: 'moment', severity: 'high' }], 'test');
    const without = await runCheckup(root, { offline: true });
    const withRules = await runCheckup(root, { offline: true, rules });
    expect(without.checks.some((check) => check.id === 'rules')).toBe(false);
    expect(overallScore(withRules)).toBe(overallScore(without));
    expect(CHECK_IDS).toContain('rules');
    expect((await runCheckup(root, { offline: true, rules, only: ['rules'] })).checks.map((check) => check.id)).toEqual(['rules']);
    expect((await runCheckup(root, { offline: true, rules, skip: ['rules'] })).checks.some((check) => check.id === 'rules')).toBe(false);
  });

  it('stops a pattern that backtracks without end, naming the rule and the file', async () => {
    root = writeTemp({ 'src/slow.ts': `${'a'.repeat(40)}\n` });
    const rules = parseRules([{ id: 'fine', pattern: 'a' }, { id: 'slow', pattern: '(a+)+b' }], 'test');
    const error = await patternViolations(rules, [{ path: 'src/slow.ts', absolute: join(root, 'src/slow.ts') }], () => false, 300).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuleTimeoutError);
    expect((error as Error).message).toMatch(/^rule slow took longer than 0\.3 s on src\/slow\.ts/);
  });
});

describe('rules through the built CLI', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  it('records a rule in the baseline and fails --fail-on regression only on a new violation', () => {
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '22.0.0' } }),
      'ng-checkup.config.json': JSON.stringify({ rules: [{ id: 'no-moment', forbidImport: 'moment' }] }),
      'src/a.ts': "import moment from 'moment';\n",
    });
    const run = (...args: string[]): { status: number; output: string } => {
      try {
        return { status: 0, output: execFileSync('node', [cli, root, '--offline', '--no-color', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
      } catch (error) {
        const failed = error as { status: number; stdout: string; stderr: string };
        return { status: failed.status, output: `${failed.stdout}${failed.stderr}` };
      }
    };
    execFileSync('node', [cli, 'baseline', root], { encoding: 'utf8' });
    expect(run('--fail-on', 'regression').status).toBe(0);
    // A rule given for this run only, with a new violation of the file's rule beside it.
    writeFileSync(join(root, 'src/b.ts'), "import m from 'moment';\n");
    const failed = run('--fail-on', 'regression');
    expect(failed.status).toBe(1);
    expect(failed.output).toContain('Custom rules: Rule no-moment 1 → 2');
    const inline = run('--only', 'rules', '--json', '--config-json', '{"rules":[{"id":"no-log","pattern":"console"}]}');
    const report = JSON.parse(inline.output) as { checks: Array<{ id: string; measures: Array<{ id: string; value: number }> }> };
    expect(report.checks[0]!.measures.map((measure) => measure.id)).toEqual(['no-moment', 'no-log']);
    expect(run('--config-json', '{"rules":[{"id":"x"}]}').output).toContain('--config-json: rule x needs exactly one of forbidImport and pattern');
  });
});
