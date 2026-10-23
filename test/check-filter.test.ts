import { parseCliArguments } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { checkFilter, runCheckup, UnknownCheckError } from '../src/index.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

describe('--only and --skip', () => {
  it('keep only the named areas in the report and the score, and still plan from all of them', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true, plan: true, only: ['security', 'testing'] });
    expect(report.checks.map((check) => check.id)).toEqual(['testing', 'security']);
    // The plan reads the measures of every check, kept or not.
    expect(report.plan?.steps.length).toBeGreaterThan(0);
    const skipped = await runCheckup(fixture('legacy-app'), { offline: true, skip: ['bundle', 'version'] });
    expect(skipped.checks.map((check) => check.id)).not.toContain('bundle');
    expect(skipped.checks).toHaveLength(10);
  });

  it('refuse an id that names no check', () => {
    expect(() => checkFilter({ skip: ['securty'] })).toThrow(UnknownCheckError);
    expect(() => checkFilter({ skip: ['securty'] })).toThrow('No check named securty');
  });

  it('come from the command line as comma-separated ids, and from the config file as arrays', () => {
    const parsed = parseCliArguments([fixture('legacy-app'), '--only', 'security, testing', '--skip', 'bundle'], {}, false);
    expect(parsed).toMatchObject({ only: ['security', 'testing'], skip: ['bundle'] });
    const root = writeTemp({ 'ng-checkup.config.json': JSON.stringify({ skip: ['bundle'] }) });
    try {
      expect(loadConfig(root).config.skip).toEqual(['bundle']);
    } finally {
      removeTemp(root);
    }
    const bad = writeTemp({ 'ng-checkup.config.json': JSON.stringify({ only: 'security' }) });
    try {
      expect(() => loadConfig(bad)).toThrow('only must be an array of check ids');
    } finally {
      removeTemp(bad);
    }
  });
});
