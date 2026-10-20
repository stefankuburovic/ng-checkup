#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BASELINE_FILE, baselineIncreases, compareWithBaseline, createBaseline, readBaseline, serializeBaseline } from './baseline.js';
import { createAnalysisCache } from './cache.js';
import { loadConfig, REPORT_FORMATS, type CheckupConfig } from './config.js';
import { ProjectNotFoundError, runCheckup, TOOL } from './index.js';
import { planInit, type CiChoice, type InitPlan } from './init.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { renderSarif } from './report/sarif.js';
import { renderTerminal } from './report/terminal.js';
import type { Grade, Report } from './types.js';
import { describeProgress, watchCheckup } from './watch.js';

const HELP = `Usage: ng-checkup [path] [options]
       ng-checkup init [path] [init options]
       ng-checkup baseline [path] [--force]

A one-minute modernization report for an Angular codebase. Reads the code,
never changes it, and sends nothing anywhere except package names to the npm
registry, to look up the latest Angular and compatible releases (skip it with
--offline).

Arguments:
  path                   Repository root (default: current directory)

Options:
  -r, --report <file>    Write the full report; format from the extension:
                         .html, .md, .json or .sarif (GitHub code scanning).
                         Repeatable.
      --json             Print the report as JSON to stdout instead of the summary
  -v, --verbose          Print every finding with its files
      --plan             Add an upgrade plan to the latest Angular, one major
                         at a time, with the migrations this code needs
  -p, --project <name>   Analyse one project of an Angular CLI or Nx workspace.
                         Without it, a multi-project workspace also gets a
                         per-project table
  -w, --watch            Re-run on every change and show how the score and the
                         measures moved since the watch started
      --fail-on <grade>  Exit with code 1 if any area is graded <grade> or worse
                         (poor or fair), or with regression if a measure is
                         worse than the baseline (for CI)
      --max-examples <n> Example files listed per finding (default 5)
      --offline          Do not look up the latest Angular version online
      --config <file>    Config file (default: ng-checkup.config.json in the root)
      --no-color         Plain output (also off when NO_COLOR is set or not a TTY)
  -h, --help             Show this help
      --version          Show the version

Init options (ng-checkup init):
      --ci <provider>    auto (default), github, gitlab or none
      --dry-run          Show what would change without writing anything
      --force            Replace an existing "checkup" script

Baseline options (ng-checkup baseline):
      --force            Accept measures that went up since the last baseline

Examples:
  npx ng-checkup
  npx ng-checkup ../my-app --report checkup.html
  npx ng-checkup --plan --report plan.md
  npx ng-checkup --watch
  npx ng-checkup --project admin --report admin.html
  npx ng-checkup --fail-on poor --report checkup.md
  npx ng-checkup init
  npx ng-checkup baseline && npx ng-checkup --fail-on regression`;

/** Grades in order of how bad they are, for `--fail-on`. */
const SEVERITY_ORDER: Grade[] = ['good', 'fair', 'poor'];

/** Parsed and validated arguments of a checkup run, before the config file is applied. */
export interface CliArguments {
  root: string;
  /** Reports named on the command line, resolved against the working directory. Empty when none. */
  reports: string[];
  json: boolean;
  verbose: boolean;
  failOn?: FailOn;
  /** Undefined when the flag was not given, so the config file can supply it. */
  maxExamples?: number;
  offline: boolean;
  plan: boolean;
  /** `--project`: one project of the workspace, by name. */
  project?: string;
  watch: boolean;
  color: boolean;
  config?: string;
}

/** Parsed arguments of `ng-checkup init`. */
export interface InitArguments {
  root: string;
  ci: CiChoice;
  dryRun: boolean;
  force: boolean;
}

/** What `--fail-on` accepts: a grade threshold, or `regression` against the baseline. */
export type FailOn = 'fair' | 'poor' | 'regression';

/** Parsed arguments of `ng-checkup baseline`. */
export interface BaselineArguments {
  root: string;
  force: boolean;
  config?: string;
}

/** What a run actually uses: the command line laid over the config file. */
export interface RunSettings {
  reports: string[];
  failOn?: FailOn;
  /** Absolute path of the baseline file, whether or not it exists. */
  baselinePath: string;
  maxExamples: number;
  offline: boolean;
  plan: boolean;
  ignore?: string[];
}

/**
 * Parses `argv` (without the node and script entries) of a checkup run.
 * Throws an `Error` whose message is meant for the user on anything invalid,
 * which `main` prints with the hint to `--help`. Returns `'help'` or
 * `'version'` for those two flags so `main` can print and exit before doing
 * any work.
 */
export function parseCliArguments(argv: string[], environment: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): CliArguments | 'help' | 'version' {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      report: { type: 'string', short: 'r', multiple: true },
      json: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      'fail-on': { type: 'string' },
      'max-examples': { type: 'string' },
      offline: { type: 'boolean' },
      plan: { type: 'boolean' },
      watch: { type: 'boolean', short: 'w' },
      project: { type: 'string', short: 'p' },
      config: { type: 'string' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (values.help) return 'help';
  if (values.version) return 'version';
  const root = parseRoot(positionals);

  const reports = (values.report ?? []).map((report) => resolve(report));
  for (const report of reports) assertReportFormat(report);

  const failOn = values['fail-on'];
  if (failOn !== undefined && failOn !== 'fair' && failOn !== 'poor' && failOn !== 'regression') throw new Error(`--fail-on takes poor, fair or regression, got ${failOn}`);

  if (values.watch && values.json) throw new Error('--watch prints a live summary, so it cannot be combined with --json');
  if (values.watch && failOn !== undefined) throw new Error('--watch never exits on its own, so --fail-on has nothing to fail; use it in a normal run');

  let maxExamples: number | undefined;
  if (values['max-examples'] !== undefined) {
    maxExamples = Number(values['max-examples']);
    if (!Number.isInteger(maxExamples) || maxExamples < 0) throw new Error(`--max-examples takes a whole number, got ${values['max-examples']}`);
  }

  return {
    root,
    reports,
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    failOn,
    maxExamples,
    offline: values.offline ?? false,
    plan: values.plan ?? false,
    project: values.project,
    watch: values.watch ?? false,
    color: !values['no-color'] && environment['NO_COLOR'] === undefined && isTty,
    config: values.config,
  };
}

/** Parses the arguments after `init`. Same error contract as `parseCliArguments`. */
export function parseInitArguments(argv: string[]): InitArguments | 'help' {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ci: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return 'help';
  const ci = values.ci ?? 'auto';
  if (!['auto', 'github', 'gitlab', 'none'].includes(ci)) throw new Error(`--ci takes auto, github, gitlab or none, got ${ci}`);
  return { root: parseRoot(positionals), ci: ci as CiChoice, dryRun: values['dry-run'] ?? false, force: values.force ?? false };
}

/**
 * Lays the command line over the config file: every flag that was given
 * wins, the config fills the rest, and the built-in defaults come last.
 * Config reports resolve against the config file's directory, command-line
 * ones were already resolved against the working directory, which is what a
 * user typing a path expects.
 */
export function resolveSettings(args: CliArguments, config: CheckupConfig, configDirectory: string): RunSettings {
  return {
    reports: args.reports.length > 0 ? args.reports : (config.reports ?? []).map((report) => resolve(configDirectory, report)),
    failOn: args.failOn ?? config.failOn,
    maxExamples: args.maxExamples ?? config.maxExamples ?? 5,
    offline: args.offline || (config.offline ?? false),
    plan: args.plan || (config.plan ?? false),
    ignore: config.ignore,
    baselinePath: config.baseline ? resolve(configDirectory, config.baseline) : join(args.root, BASELINE_FILE),
  };
}

/** Parses the arguments after `baseline`. */
export function parseBaselineArguments(argv: string[]): BaselineArguments | 'help' {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { force: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return 'help';
  return { root: parseRoot(positionals), force: values.force ?? false, config: values.config };
}

/** The single optional path argument, checked to be a directory. */
function parseRoot(positionals: string[]): string {
  if (positionals.length > 1) throw new Error(`Expected one path, got ${positionals.length}: ${positionals.join(' ')}`);
  const root = resolve(positionals[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  return root;
}

/** Rejects a report path whose extension names no format. */
function assertReportFormat(path: string): void {
  if (!REPORT_FORMATS.includes(extname(path).toLowerCase())) throw new Error(`Unknown report format for ${path}: use .html, .md, .json or .sarif`);
}

/** Renders a report in the format its file extension names. */
export function renderForFile(report: Report, path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') return `${JSON.stringify(report, null, 2)}\n`;
  if (extension === '.md') return renderMarkdown(report);
  if (extension === '.sarif') return renderSarif(report);
  return renderHtml(report);
}

/**
 * True when some area is graded `failOn` or worse, or, for `regression`,
 * when the report's baseline comparison holds a regression. `info` never
 * fails a run: it means the area could not be measured, not that it is bad.
 */
export function shouldFail(report: Report, failOn: FailOn | undefined): boolean {
  if (!failOn) return false;
  if (failOn === 'regression') return (report.baseline?.regressions.length ?? 0) > 0;
  const threshold = SEVERITY_ORDER.indexOf(failOn);
  return report.checks.some((check) => check.grade !== 'info' && SEVERITY_ORDER.indexOf(check.grade) >= threshold);
}

/**
 * Runs `ng-checkup init`: plans against the real file system, then writes
 * the changes unless `dryRun`. Returns the plan so the caller can print it.
 */
export async function runInit(args: InitArguments): Promise<InitPlan> {
  // The first baseline is today's code, measured offline: no measure depends
  // on the registry. Skipped when one exists, which the planner keeps anyway.
  const baselinePath = join(args.root, BASELINE_FILE);
  const baseline = existsSync(baselinePath) ? undefined : serializeBaseline(createBaseline(await runCheckup(args.root, { offline: true })));
  const plan = planInit(
    {
      read: (path) => {
        const absolute = join(args.root, path);
        return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : undefined;
      },
      exists: (path) => existsSync(join(args.root, path)),
    },
    { ci: args.ci, force: args.force, version: TOOL.version, baseline },
  );
  if (!args.dryRun) {
    for (const change of plan.changes) {
      const target = join(args.root, change.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, change.content);
    }
  }
  return plan;
}

/** The text `ng-checkup init` prints: what changed, what was left alone, what to run next. */
export function describeInitPlan(plan: InitPlan, dryRun: boolean): string {
  const lines: string[] = [];
  if (plan.changes.length === 0) {
    lines.push('Nothing to set up: ng-checkup is already configured here.');
  } else {
    lines.push(dryRun ? 'ng-checkup init would make these changes (dry run, nothing written):' : 'ng-checkup is set up:');
    for (const change of plan.changes) lines.push(`  ${change.action === 'create' ? 'create' : 'update'}  ${change.path.padEnd(36)} ${change.summary}`);
  }
  for (const note of plan.notes) lines.push('', note);
  if (!dryRun) {
    lines.push('', 'Next:');
    plan.nextSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  }
  return lines.join('\n');
}

/** Entry point. Exit codes: 0 done, 1 `--fail-on` tripped, 2 usage or runtime error. */
async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'init') return mainInit(argv.slice(1));
  if (argv[0] === 'baseline') return mainBaseline(argv.slice(1));

  let parsed: ReturnType<typeof parseCliArguments>;
  let settings: RunSettings;
  let baseline: ReturnType<typeof readBaseline>;
  try {
    parsed = parseCliArguments(argv);
    if (parsed === 'help' || parsed === 'version') {
      process.stdout.write(`${parsed === 'help' ? HELP : TOOL.version}\n`);
      return 0;
    }
    const { config, directory } = loadConfig(parsed.root, parsed.config);
    settings = resolveSettings(parsed, config, directory);
    // The baseline records the whole workspace; one project measured against
    // it would show every other project's code as an improvement.
    if (parsed.project !== undefined && settings.failOn === 'regression') throw new Error('--fail-on regression compares the whole workspace with its baseline, so it cannot be combined with --project');
    baseline = parsed.project === undefined ? readBaseline(settings.baselinePath) : undefined;
    if (settings.failOn === 'regression' && !baseline) throw new Error(`--fail-on regression needs a baseline, and there is none at ${settings.baselinePath}. Create it with: ng-checkup baseline`);
  } catch (error) {
    return usageError(error);
  }

  if (parsed.watch) return mainWatch(parsed, settings);

  let report: Report;
  try {
    report = await runCheckup(parsed.root, { offline: settings.offline, maxExamples: settings.maxExamples, ignore: analysisIgnores(parsed.root, settings), plan: settings.plan, project: parsed.project });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return usageError(error);
    throw error;
  }
  if (baseline) report.baseline = compareWithBaseline(report, baseline, settings.baselinePath);
  writeReports(report, settings.reports);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(report, { color: parsed.color, verbose: parsed.verbose })}\n`);
    for (const target of settings.reports) process.stdout.write(`Report written to ${target}\n`);
  }
  return shouldFail(report, settings.failOn) ? 1 : 0;
}

/**
 * The config's `ignore` patterns plus every report file inside the
 * repository. Without the second part an HTML report written to the root is
 * read back on the next run as an Angular template, and its own text (which
 * quotes `$any()` and the like) shows up as findings.
 */
export function analysisIgnores(root: string, settings: Pick<RunSettings, 'ignore' | 'reports'>): string[] | undefined {
  const reports = settings.reports.map((report) => relative(root, report).split('\\').join('/')).filter((path) => path !== '' && !path.startsWith('..') && !isAbsolute(path));
  const patterns = [...(settings.ignore ?? []), ...reports];
  return patterns.length > 0 ? patterns : undefined;
}

/** Writes `report` to every target, in the format its extension names. */
function writeReports(report: Report, targets: string[]): void {
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderForFile(report, target));
  }
}

/**
 * `ng-checkup --watch`: re-runs on every relevant change until Ctrl+C.
 *
 * Every run re-reads the config and the baseline, so `ng-checkup baseline`
 * in another terminal shows up at the next save. Parsing, the deprecation
 * index and the registry lookups are cached between runs (`AnalysisCache`),
 * so a save re-parses only the changed files and never hits the network
 * again unless `package.json` or a lockfile changed. The screen is cleared
 * only on a terminal; piped output gets one report after another. The report
 * files of the first run's settings are ignored by the watcher, otherwise
 * writing them would trigger the next run.
 */
async function mainWatch(parsed: CliArguments, initial: RunSettings): Promise<number> {
  const cache = createAnalysisCache();
  const clear = process.stdout.isTTY ? '\u001b[2J\u001b[3J\u001b[H' : '';
  let first: Report | undefined;
  const stop = watchCheckup({
    root: parsed.root,
    ignorePaths: initial.reports,
    run: async () => {
      const { config, directory } = loadConfig(parsed.root, parsed.config);
      const settings = resolveSettings(parsed, config, directory);
      const report = await runCheckup(parsed.root, { offline: settings.offline, maxExamples: settings.maxExamples, ignore: analysisIgnores(parsed.root, settings), plan: settings.plan, project: parsed.project, cache });
      const baseline = parsed.project === undefined ? readBaseline(settings.baselinePath) : undefined;
      if (baseline) report.baseline = compareWithBaseline(report, baseline, settings.baselinePath);
      writeReports(report, settings.reports);
      first ??= report;
      const time = new Date().toLocaleTimeString();
      process.stdout.write(
        `${clear}${renderTerminal(report, { color: parsed.color, verbose: parsed.verbose })}\n\n${describeProgress(first, report, parsed.color)}\nWatching ${parsed.root} for changes, last run ${time}. Ctrl+C to stop.\n`,
      );
    },
    onError: (error) => process.stderr.write(`ng-checkup: ${error instanceof Error ? error.message : String(error)}\nStill watching.\n`),
  });
  await new Promise<void>((done) => process.once('SIGINT', () => done()));
  await stop();
  return 0;
}

/** `ng-checkup init`. */
async function mainInit(argv: string[]): Promise<number> {
  try {
    const parsed = parseInitArguments(argv);
    if (parsed === 'help') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    const plan = await runInit(parsed);
    process.stdout.write(`${describeInitPlan(plan, parsed.dryRun)}\n`);
    return 0;
  } catch (error) {
    return usageError(error);
  }
}

/**
 * `ng-checkup baseline`: records the current measures. Updating may only
 * lower numbers; a measure that went up is refused unless `--force`, so a
 * regression cannot be waved through by re-running the command.
 */
async function mainBaseline(argv: string[]): Promise<number> {
  try {
    const parsed = parseBaselineArguments(argv);
    if (parsed === 'help') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    const written = await writeBaseline(parsed);
    process.stdout.write(`${written}\n`);
    return 0;
  } catch (error) {
    return usageError(error);
  }
}

/**
 * Runs the analysis and writes the baseline. Returns the message to print.
 * Offline on purpose: no measure depends on the latest Angular version.
 *
 * @throws When a measure went up and `force` is not set, listing each one.
 */
export async function writeBaseline(args: BaselineArguments): Promise<string> {
  const { config, directory } = loadConfig(args.root, args.config);
  const path = config.baseline ? resolve(directory, config.baseline) : join(args.root, BASELINE_FILE);
  const previous = readBaseline(path);
  const report = await runCheckup(args.root, { offline: true, ignore: config.ignore });
  const next = createBaseline(report);
  const increases = baselineIncreases(previous, next);
  if (increases.length > 0 && !args.force) {
    throw new Error(`these measures went up since the last baseline, which only ever goes down:\n${increases.map((entry) => `  ${entry.key}: ${entry.before} -> ${entry.after}`).join('\n')}\nFix them, or accept the new numbers with: ng-checkup baseline --force`);
  }
  writeFileSync(path, serializeBaseline(next));
  const lowered = previous ? Object.entries(next.measures).filter(([key, value]) => previous.measures[key] !== undefined && value < previous.measures[key]!) : [];
  const lines = [`Baseline ${previous ? 'updated' : 'written'}: ${path} (${Object.keys(next.measures).length} measures)`];
  for (const [key, value] of lowered) lines.push(`  lowered ${key}: ${previous!.measures[key]} -> ${value}`);
  if (increases.length > 0) for (const entry of increases) lines.push(`  raised (--force) ${entry.key}: ${entry.before} -> ${entry.after}`);
  if (!previous) lines.push('Commit it, then run ng-checkup --fail-on regression in CI: it fails only when a number gets worse.');
  return lines.join('\n');
}

/** Prints a user-facing error with the hint to `--help` and returns exit code 2. */
function usageError(error: unknown): number {
  process.stderr.write(`ng-checkup: ${error instanceof Error ? error.message : String(error)}\nRun ng-checkup --help for usage.\n`);
  return 2;
}

/**
 * True when this file is the process entry point. Compared through
 * `realpath` because npm starts the CLI through a symlink in `.bin`, so
 * `argv[1]` names the link while `import.meta.url` names the target. A test
 * importing the parsing helpers is not the entry point and runs nothing.
 */
function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ng-checkup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
