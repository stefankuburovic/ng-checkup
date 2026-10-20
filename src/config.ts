import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

/** The file `ng-checkup` reads from the analysed root when no `--config` is given. */
export const CONFIG_FILE = 'ng-checkup.config.json';

/**
 * What `ng-checkup.config.json` may set. Every key is optional and every one
 * has a command-line flag that overrides it, so a config file only ever
 * supplies defaults: a developer running `npx ng-checkup --report x.md` gets
 * exactly that, whatever the file says.
 */
export interface CheckupConfig {
  /** Report files to write, relative to the config file's directory. */
  reports?: string[];
  /** As `--fail-on`. `regression` fails only when a measure is worse than the baseline. */
  failOn?: 'fair' | 'poor' | 'regression';
  /** As `--max-examples`. */
  maxExamples?: number;
  /** As `--offline`. */
  offline?: boolean;
  /**
   * Paths left out of the analysis, relative to the root: `src/legacy`,
   * `**\/generated`, `apps/*\/e2e`. A pattern matches a file or a directory and
   * everything below it; `*` stops at `/`, `**` does not.
   */
  ignore?: string[];
  /** The baseline file, relative to the config file. Defaults to `ng-checkup.baseline.json` in the root. */
  baseline?: string;
  /** As `--plan`: add the upgrade plan to every report. */
  plan?: boolean;
}

/** Keys the file may contain. `$schema` is accepted so editors can attach one later. */
const KNOWN_KEYS = new Set(['$schema', 'reports', 'failOn', 'maxExamples', 'offline', 'ignore', 'baseline', 'plan']);

/**
 * Reads and validates the config file.
 *
 * @param explicitPath A path given with `--config`. It must exist; the default
 *   file may be absent, which simply means no config.
 * @returns The parsed config and the directory its relative paths resolve
 *   against, or an empty config when there is no file.
 * @throws An `Error` whose message is meant for the user on malformed JSON,
 *   an unknown key or a value of the wrong type. A typo such as `failon`
 *   fails loudly instead of being silently ignored, which would leave CI
 *   passing on a threshold nobody set.
 */
export function loadConfig(root: string, explicitPath?: string): { config: CheckupConfig; directory: string; path?: string } {
  const path = explicitPath ? resolve(explicitPath) : join(root, CONFIG_FILE);
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`Config file not found: ${path}`);
    return { config: {}, directory: root };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object`);
  const record = raw as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${path}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')}. Allowed: ${[...KNOWN_KEYS].filter((key) => key !== '$schema').join(', ')}`);

  const config: CheckupConfig = {};
  if (record['reports'] !== undefined) {
    const reports = record['reports'];
    if (!Array.isArray(reports) || !reports.every((entry) => typeof entry === 'string')) throw new Error(`${path}: reports must be an array of file names`);
    for (const report of reports) {
      if (!['.html', '.htm', '.md', '.json'].includes(extname(report).toLowerCase())) throw new Error(`${path}: unknown report format for ${report}, use .html, .md or .json`);
    }
    config.reports = reports;
  }
  if (record['failOn'] !== undefined) {
    if (record['failOn'] !== 'fair' && record['failOn'] !== 'poor' && record['failOn'] !== 'regression') throw new Error(`${path}: failOn must be "poor", "fair" or "regression"`);
    config.failOn = record['failOn'];
  }
  if (record['maxExamples'] !== undefined) {
    const value = record['maxExamples'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${path}: maxExamples must be a whole number`);
    config.maxExamples = value;
  }
  if (record['offline'] !== undefined) {
    if (typeof record['offline'] !== 'boolean') throw new Error(`${path}: offline must be true or false`);
    config.offline = record['offline'];
  }
  if (record['ignore'] !== undefined) {
    const ignore = record['ignore'];
    if (!Array.isArray(ignore) || !ignore.every((entry) => typeof entry === 'string')) throw new Error(`${path}: ignore must be an array of paths`);
    config.ignore = ignore;
  }
  if (record['baseline'] !== undefined) {
    if (typeof record['baseline'] !== 'string' || record['baseline'].trim() === '') throw new Error(`${path}: baseline must be a file path`);
    config.baseline = record['baseline'];
  }
  if (record['plan'] !== undefined) {
    if (typeof record['plan'] !== 'boolean') throw new Error(`${path}: plan must be true or false`);
    config.plan = record['plan'];
  }
  return { config, directory: resolve(path, '..'), path };
}

/**
 * Compiles `ignore` patterns into one predicate over report paths (relative
 * to the root, `/`-separated). Undefined when there are no patterns, so the
 * file walk can skip the check entirely.
 */
export function ignoreMatcher(patterns: string[] | undefined): ((relativePath: string) => boolean) | undefined {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  const expressions = cleaned.map((pattern) => {
    const source = pattern
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    // A pattern matches the path itself or anything below it.
    return new RegExp(`^${source}(?:/.*)?$`);
  });
  return (relativePath) => expressions.some((expression) => expression.test(relativePath));
}
