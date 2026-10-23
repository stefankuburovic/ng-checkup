import { join } from 'node:path';
import { parseCliArguments } from '../src/cli.js';
import { renderComment } from '../src/report/comment.js';
import { readTrend, recordTrend, sparkline, summarizeTrend, trendSentence, type TrendPoint } from '../src/trend.js';
import { runCheckup } from '../src/index.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

const point = (date: string, score: number, anys: number, initialBytes?: number, commit = date): TrendPoint => ({ date, commit, score, measures: { 'type-safety.explicit-any': anys }, ...(initialBytes ? { initialBytes } : {}) });

describe('trend', () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder) removeTemp(folder);
    folder = undefined;
  });

  it('starts empty, records points, and replaces a rerun of the same commit', () => {
    folder = writeTemp({ 'broken.json': '{ not json' });
    const path = join(folder, 'cache', 'trend.json');
    expect(readTrend(path)).toEqual([]);
    expect(readTrend(join(folder, 'broken.json'))).toEqual([]);
    recordTrend(path, [], point('2026-09-01', 60, 30));
    recordTrend(path, readTrend(path), point('2026-10-01', 70, 20));
    recordTrend(path, readTrend(path), { ...point('2026-10-01', 71, 19), commit: '2026-10-01' });
    expect(readTrend(path).map((entry) => entry.score)).toEqual([60, 71]);
  });

  it('compares with the last point at least 30 days old, and says it in one sentence with the bundle', () => {
    const points = [point('2026-08-01', 50, 40, 900_000), point('2026-09-20', 60, 30, 880_000), point('2026-10-10', 66, 25, 870_000)];
    const trend = summarizeTrend(points, point('2026-10-23', 72, 20, 903_000, 'now'), { 'type-safety.explicit-any': 'Explicit any' });
    expect(trend?.since?.date).toBe('2026-09-20');
    expect(trend?.moved).toEqual([{ key: 'type-safety.explicit-any', label: 'Explicit any', before: 30, after: 20 }]);
    expect(trendSentence(trend!)).toBe('Score 72, +12 since 2026-09-20 ▁▅█ · initial bundle 903 kB, +23 kB');
  });

  it('has nothing to say on the first run, and draws no sparkline from one value', () => {
    expect(summarizeTrend([], point('2026-10-23', 72, 20), {})).toBeUndefined();
    expect(sparkline([5])).toBe('');
  });

  it('shows the trend in the pull-request comment', async () => {
    const report = await runCheckup(fixture('legacy-app'), { offline: true });
    report.trend = summarizeTrend([point('2026-09-01', 30, 30)], { ...point('2026-10-23', 40, 20), commit: 'now' }, {});
    expect(renderComment(report)).toContain('**Last 30 days on the default branch:** Score 40, +10 since 2026-09-01 ▁█');
  });

  it('needs a trend file for --trend-record', () => {
    expect(() => parseCliArguments(['.', '--trend-record'], {}, false)).toThrow('--trend-record adds this run to a trend file');
    expect(parseCliArguments(['.', '--trend', 't.json', '--trend-record'], {}, false)).toMatchObject({ trend: { record: true } });
  });
});
