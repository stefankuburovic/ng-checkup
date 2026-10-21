#!/usr/bin/env node
/**
 * Runs ng-checkup on real, public Angular repositories and compares the
 * results with committed snapshots.
 *
 * Unit tests prove the rules do what they say on code written to test them.
 * This proves they still say the right thing on code nobody wrote for them:
 * the three false positives fixed in 0.5.1 and 0.5.2 (a constant `innerHTML`,
 * mocks counted as application code, TSLint leftovers) were all found on real
 * repositories, after release, and would have been caught here before it.
 *
 * Usage (after `npm run build`):
 *   node scripts/corpus.mjs            compare, exit 1 and print a diff on any change
 *   node scripts/corpus.mjs --update   rewrite the snapshots to the current output
 *   node scripts/corpus.mjs --only go-data,realworld
 *
 * Each repository is fetched once, shallow, at its pinned commit into
 * `.corpus/` (git-ignored) and reused afterwards. Runs are offline and the
 * dependencies are never installed, so no third-party code runs and the
 * result depends only on the source and on ng-checkup. A changed snapshot is
 * not a failure to silence: read the diff, and update only when every line of
 * it is an improvement.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.corpus');
const SNAPSHOTS = join(ROOT, 'corpus', 'snapshots');

const { runCheckup, overallScore } = await import(join(ROOT, 'dist', 'index.js'));
const { repos } = JSON.parse(readFileSync(join(ROOT, 'corpus', 'repos.json'), 'utf8'));

const args = process.argv.slice(2);
const update = args.includes('--update');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1]?.split(',')) : undefined;

let changed = 0;
for (const entry of repos) {
  if (only && !only.has(entry.name)) continue;
  const directory = checkout(entry);
  const started = Date.now();
  const report = await runCheckup(directory, { offline: true, plan: true, maxExamples: 3 });
  const snapshot = `${JSON.stringify(normalise(entry, report), null, 2)}\n`;
  const path = join(SNAPSHOTS, `${entry.name}.json`);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const status = previous === snapshot ? 'same' : previous === undefined ? 'new' : 'changed';
  process.stdout.write(`${entry.name.padEnd(22)} ${String(overallScore(report) ?? '-').padStart(3)}  ${status.padEnd(7)} ${Date.now() - started} ms\n`);
  if (status === 'same') continue;
  if (update) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(path, snapshot);
    continue;
  }
  changed++;
  if (previous !== undefined) printDiff(path, snapshot);
}

if (!update && changed > 0) {
  process.stdout.write(`\n${changed} snapshot(s) differ. Read the diff; if every change is right, run: node scripts/corpus.mjs --update\n`);
  process.exit(1);
}

/**
 * The repository at its pinned commit, fetched on first use. Only that one
 * commit is downloaded (`--depth 1` by SHA, which GitHub allows), so even a
 * repository with a large history costs no more than its current tree.
 */
function checkout({ name, repo, commit }) {
  const directory = join(CACHE, name);
  const git = (...gitArgs) => execFileSync('git', ['-C', directory, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (existsSync(join(directory, '.git'))) {
    try {
      if (git('rev-parse', 'HEAD') === commit) return directory;
    } catch {
      // A broken cache is fetched again below.
    }
  }
  mkdirSync(directory, { recursive: true });
  if (!existsSync(join(directory, '.git'))) {
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  }
  git('fetch', '-q', '--depth', '1', 'origin', commit);
  git('checkout', '-q', '--force', 'FETCH_HEAD');
  return directory;
}

/**
 * What the snapshot keeps: everything a reader of the report would act on,
 * nothing that changes from run to run. Timings, dates, the absolute root and
 * the tool version are dropped; finding details are dropped too, since their
 * wording is edited often and the message, files and counts carry the result.
 */
function normalise(entry, report) {
  return {
    repo: entry.repo,
    commit: entry.commit,
    project: report.project,
    score: overallScore(report) ?? null,
    checks: report.checks.map((check) => ({
      id: check.id,
      grade: check.grade,
      summary: check.summary,
      measures: Object.fromEntries((check.measures ?? []).map((measure) => [measure.id, measure.value])),
      findings: check.findings.map((finding) => ({
        severity: finding.severity,
        message: finding.message,
        ...(finding.files ? { files: finding.files.map((file) => (file.line === undefined ? file.path : `${file.path}:${file.line}`)) } : {}),
        ...(finding.count !== undefined ? { count: finding.count } : {}),
      })),
    })),
    ...(report.projects ? { projects: report.projects.map((row) => ({ name: row.name, root: row.root, score: row.score ?? null, grades: row.grades })) } : {}),
    ...(report.plan
      ? {
          plan: {
            from: report.plan.from,
            to: report.plan.to,
            before: report.plan.before.map(title),
            steps: report.plan.steps.map((step) => ({ to: step.to, items: step.items.map(title) })),
          },
        }
      : {}),
  };
}

/** A plan item as one line, with its count when it has one. */
function title(item) {
  return item.count === undefined ? item.title : `${item.title} (${item.count})`;
}

/** Prints a unified diff of the committed snapshot against the new output. */
function printDiff(path, snapshot) {
  const next = join(CACHE, 'next.json');
  writeFileSync(next, snapshot);
  const result = spawnSync('diff', ['-u', '--label', `${path} (committed)`, '--label', `${path} (now)`, path, next], { encoding: 'utf8' });
  process.stdout.write(result.stdout);
}
