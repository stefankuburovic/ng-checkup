import { join } from 'node:path';
import { resolveSettings, type CliArguments } from '../src/cli.js';
import { ignoreMatcher, loadConfig } from '../src/config.js';
import { runCheckup } from '../src/index.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

describe('loadConfig', () => {
  let root = '';
  afterEach(() => root && removeTemp(root));

  it('is empty when there is no config file', () => {
    root = writeTemp({});
    expect(loadConfig(root)).toEqual({ config: {}, directory: root });
  });

  it('reads every supported key', () => {
    root = writeTemp({ 'ng-checkup.config.json': JSON.stringify({ $schema: 'x', reports: ['out/checkup.html'], failOn: 'fair', maxExamples: 2, offline: true, ignore: ['src/legacy'] }) });
    expect(loadConfig(root).config).toEqual({ reports: ['out/checkup.html'], failOn: 'fair', maxExamples: 2, offline: true, ignore: ['src/legacy'] });
  });

  it('fails loudly on a typo, a wrong type, bad JSON or a missing --config file', () => {
    root = writeTemp({ 'ng-checkup.config.json': '{"failon":"poor"}', 'bad.json': '{"failOn":"never"}', 'broken.json': '{', 'ext.json': '{"reports":["x.pdf"]}' });
    expect(() => loadConfig(root)).toThrow('unknown key failon');
    expect(() => loadConfig(root, join(root, 'bad.json'))).toThrow('failOn must be "poor", "fair" or "regression"');
    expect(() => loadConfig(root, join(root, 'broken.json'))).toThrow('is not valid JSON');
    expect(() => loadConfig(root, join(root, 'ext.json'))).toThrow('unknown report format for x.pdf');
    expect(() => loadConfig(root, join(root, 'missing.json'))).toThrow('Config file not found');
  });
});

describe('ignoreMatcher', () => {
  it('matches a path and everything below it, with * inside a segment and ** across them', () => {
    const ignored = ignoreMatcher(['src/legacy/', './apps/*/e2e', '**/generated', 'tools/*.ts'])!;
    expect(ignored('src/legacy')).toBe(true);
    expect(ignored('src/legacy/a/b.ts')).toBe(true);
    expect(ignored('src/legacyish/b.ts')).toBe(false);
    expect(ignored('apps/web/e2e/spec.ts')).toBe(true);
    expect(ignored('apps/web/src/e2e.ts')).toBe(false);
    expect(ignored('libs/api/generated/client.ts')).toBe(true);
    expect(ignored('generated/client.ts')).toBe(true);
    expect(ignored('tools/build.ts')).toBe(true);
    expect(ignored('tools/sub/build.ts')).toBe(false);
  });

  it('is undefined without patterns, so the walk does no extra work', () => {
    expect(ignoreMatcher(undefined)).toBeUndefined();
    expect(ignoreMatcher(['', '  '])).toBeUndefined();
  });

  it('removes ignored files from the analysis', async () => {
    const all = await runCheckup(fixture('legacy-app'), { offline: true });
    const ignored = await runCheckup(fixture('legacy-app'), { offline: true, ignore: ['src/app/state'] });
    expect(ignored.project.sourceFiles).toBe(all.project.sourceFiles - 2);
    // The reducer closed the only cycle.
    expect(ignored.checks.find((check) => check.id === 'circular-deps')?.grade).toBe('good');
  });
});

describe('resolveSettings', () => {
  const args = (overrides: Partial<CliArguments>): CliArguments => ({ root: '/repo', reports: [], json: false, verbose: false, offline: false, plan: false, watch: false, color: false, ...overrides });

  it('lets every flag win over the config, and the config over the defaults', () => {
    const config = { reports: ['checkup.html'], failOn: 'fair' as const, maxExamples: 2, offline: true, ignore: ['x'] };
    expect(resolveSettings(args({}), config, '/repo')).toEqual({ reports: ['/repo/checkup.html'], failOn: 'fair', maxExamples: 2, offline: true, plan: false, ignore: ['x'], baselinePath: '/repo/ng-checkup.baseline.json' });
    expect(resolveSettings(args({ reports: ['/tmp/a.md'], failOn: 'poor', maxExamples: 9 }), config, '/repo')).toMatchObject({ reports: ['/tmp/a.md'], failOn: 'poor', maxExamples: 9 });
    expect(resolveSettings(args({}), {}, '/repo')).toEqual({ reports: [], failOn: undefined, maxExamples: 5, offline: false, plan: false, ignore: undefined, baselinePath: '/repo/ng-checkup.baseline.json' });
    expect(resolveSettings(args({}), { baseline: 'ci/base.json' }, '/repo/config').baselinePath).toBe('/repo/config/ci/base.json');
  });
});
