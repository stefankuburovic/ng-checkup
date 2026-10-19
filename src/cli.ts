#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCheckup, TOOL } from './index.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { renderTerminal } from './report/terminal.js';
import type { Grade, Report } from './types.js';

const HELP = `Usage: ng-checkup [path] [options]

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
      --no-color         Plain output (also off when NO_COLOR is set or not a TTY)
  -h, --help             Show this help
      --version          Show the version

Examples:
  npx ng-checkup
  npx ng-checkup ../my-app --report checkup.html
  npx ng-checkup --fail-on poor --report checkup.md`;

/** Grades in order of how bad they are, for `--fail-on`. */
const SEVERITY_ORDER: Grade[] = ['good', 'fair', 'poor'];

/** Parsed and validated command-line arguments. */
interface CliArguments {
  root: string;
  reports: string[];
  json: boolean;
  verbose: boolean;
  failOn?: 'fair' | 'poor';
  maxExamples: number;
  offline: boolean;
  color: boolean;
}

/**
 * Parses `argv` (without the node and script entries). Throws an `Error`
 * whose message is meant for the user on anything invalid, which `main`
 * prints with the hint to `--help`. Returns `'help'` or `'version'` for those
 * two flags so `main` can print and exit before doing any work.
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
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (values.help) return 'help';
  if (values.version) return 'version';
  if (positionals.length > 1) throw new Error(`Expected one path, got ${positionals.length}: ${positionals.join(' ')}`);

  const root = resolve(positionals[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

  const reports = values.report ?? [];
  for (const report of reports) {
    if (!['.html', '.htm', '.md', '.json'].includes(extname(report).toLowerCase())) throw new Error(`Unknown report format for ${report}: use .html, .md or .json`);
  }

  const failOn = values['fail-on'];
  if (failOn !== undefined && failOn !== 'fair' && failOn !== 'poor') throw new Error(`--fail-on takes poor or fair, got ${failOn}`);

  const maxExamples = values['max-examples'] === undefined ? 5 : Number(values['max-examples']);
  if (!Number.isInteger(maxExamples) || maxExamples < 0) throw new Error(`--max-examples takes a whole number, got ${values['max-examples']}`);

  return {
    root,
    reports,
    json: values.json ?? false,
    verbose: values.verbose ?? false,
    failOn,
    maxExamples,
    offline: values.offline ?? false,
    color: !values['no-color'] && environment['NO_COLOR'] === undefined && isTty,
  };
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

/** Entry point. Exit codes: 0 done, 1 `--fail-on` tripped, 2 usage or runtime error. */
async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseCliArguments>;
  try {
    parsed = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ng-checkup: ${error instanceof Error ? error.message : String(error)}\nRun ng-checkup --help for usage.\n`);
    return 2;
  }
  if (parsed === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed === 'version') {
    process.stdout.write(`${TOOL.version}\n`);
    return 0;
  }

  const report = await runCheckup(parsed.root, { offline: parsed.offline, maxExamples: parsed.maxExamples });

  for (const path of parsed.reports) {
    const target = resolve(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderForFile(report, target));
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTerminal(report, { color: parsed.color, verbose: parsed.verbose })}\n`);
    for (const path of parsed.reports) process.stdout.write(`Report written to ${resolve(path)}\n`);
  }
  return shouldFail(report, parsed.failOn) ? 1 : 0;
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
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ng-checkup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
