#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, type CheckupConfig } from './config.js';
import { runCheckup, TOOL } from './index.js';
import { planInit, type CiChoice, type InitPlan } from './init.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { renderTerminal } from './report/terminal.js';
import type { Grade, Report } from './types.js';

const HELP = `Usage: ng-checkup [path] [options]
       ng-checkup init [path] [init options]

A one-minute modernization report for an Angular codebase. Reads the code,
never changes it, and sends nothing anywhere except one npm registry lookup
of the latest Angular version (skip it with --offline).

Arguments:
  path                   Repository root (default: current directory)

Options:
  -r, --report <file>    Write the full report; format from the extension:
                         .html, .md or .json. Repeatable.
      --json             Print the report as JSON to stdout instead of the summary
  -v, --verbose          Print every finding with its files
      --fail-on <grade>  Exit with code 1 if any area is graded <grade> or worse:
                         poor or fair (for CI)
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

Examples:
  npx ng-checkup
  npx ng-checkup ../my-app --report checkup.html
  npx ng-checkup --fail-on poor --report checkup.md
  npx ng-checkup init`;

/** Grades in order of how bad they are, for `--fail-on`. */
const SEVERITY_ORDER: Grade[] = ['good', 'fair', 'poor'];

/** Parsed and validated arguments of a checkup run, before the config file is applied. */
export interface CliArguments {
  root: string;
  /** Reports named on the command line, resolved against the working directory. Empty when none. */
  reports: string[];
  json: boolean;
  verbose: boolean;
  failOn?: 'fair' | 'poor';
  /** Undefined when the flag was not given, so the config file can supply it. */
  maxExamples?: number;
  offline: boolean;
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

/** What a run actually uses: the command line laid over the config file. */
export interface RunSettings {
  reports: string[];
  failOn?: 'fair' | 'poor';
  maxExamples: number;
  offline: boolean;
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
  if (failOn !== undefined && failOn !== 'fair' && failOn !== 'poor') throw new Error(`--fail-on takes poor or fair, got ${failOn}`);

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
    ignore: config.ignore,
  };
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
  if (!['.html', '.htm', '.md', '.json'].includes(extname(path).toLowerCase())) throw new Error(`Unknown report format for ${path}: use .html, .md or .json`);
}

/** Renders a report in the format its file extension names. */
export function renderForFile(report: Report, path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') return `${JSON.stringify(report, null, 2)}\n`;
  if (extension === '.md') return renderMarkdown(report);
  return renderHtml(report);
}

/**
 * True when some area is graded `failOn` or worse. `info` never fails a
 * run: it means the area could not be measured, not that it is bad.
 */
export function shouldFail(report: Report, failOn: 'fair' | 'poor' | undefined): boolean {
  if (!failOn) return false;
  const threshold = SEVERITY_ORDER.indexOf(failOn);
  return report.checks.some((check) => check.grade !== 'info' && SEVERITY_ORDER.indexOf(check.grade) >= threshold);
}

/**
 * Runs `ng-checkup init`: plans against the real file system, then writes
 * the changes unless `dryRun`. Returns the plan so the caller can print it.
 */
export function runInit(args: InitArguments): InitPlan {
  const plan = planInit(
    {
      read: (path) => {
        const absolute = join(args.root, path);
        return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : undefined;
      },
      exists: (path) => existsSync(join(args.root, path)),
    },
    { ci: args.ci, force: args.force, version: TOOL.version },
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

  let parsed: ReturnType<typeof parseCliArguments>;
  let settings: RunSettings;
  try {
    parsed = parseCliArguments(argv);
    if (parsed === 'help' || parsed === 'version') {
      process.stdout.write(`${parsed === 'help' ? HELP : TOOL.version}\n`);
      return 0;
    }
    const { config, directory } = loadConfig(parsed.root, parsed.config);
    settings = resolveSettings(parsed, config, directory);
  } catch (error) {
    return usageError(error);
  }

  const report = await runCheckup(parsed.root, { offline: settings.offline, maxExamples: settings.maxExamples, ignore: settings.ignore });

  for (const target of settings.reports) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderForFile(report, target));
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(report, { color: parsed.color, verbose: parsed.verbose })}\n`);
    for (const target of settings.reports) process.stdout.write(`Report written to ${target}\n`);
  }
  return shouldFail(report, settings.failOn) ? 1 : 0;
}

/** `ng-checkup init`. */
function mainInit(argv: string[]): number {
  try {
    const parsed = parseInitArguments(argv);
    if (parsed === 'help') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    const plan = runInit(parsed);
    process.stdout.write(`${describeInitPlan(plan, parsed.dryRun)}\n`);
    return 0;
  } catch (error) {
    return usageError(error);
  }
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
