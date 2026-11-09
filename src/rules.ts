import { Worker } from 'node:worker_threads';
import { ignoreMatcher } from './config.js';
import { isTestCode } from './files.js';
import type { SourceFileFacts } from './scan.js';

/**
 * A team's own rule, from `rules` in `ng-checkup.config.json` or `--config-json`.
 * Exactly one of `forbidImport` and `pattern` is set.
 *
 * A rule is a baseline measure, not a grade: the count of places that break
 * it is recorded by `ng-checkup baseline`, and `--fail-on regression` fails
 * only when it goes up. That is the difference from an ESLint rule, which
 * fails on every old violation and so tends to be switched off in a legacy
 * codebase.
 */
export interface CustomRule {
  /** Lower-case letters, digits and dashes; the measure is `rules.<id>`. */
  id: string;
  /** Package or path specifiers no file may import; `moment` also forbids `moment/locale/de`. */
  forbidImport?: string[];
  /** A regular expression tested against every line of the files the rule reads, comments included. */
  pattern?: string;
  /**
   * Paths the rule reads, relative to the root, with the `ignore` syntax:
   * a pattern matches a file or a folder and everything below it. Without
   * it the rule reads application code only; with it, test code too, so a
   * rule can forbid `fdescribe` in `**\/*.spec.ts`.
   */
  files?: string[];
  severity: 'high' | 'medium' | 'low';
  /** What to do instead, shown with every finding. */
  message?: string;
}

/** One place that breaks a rule. */
export interface RuleViolation {
  rule: string;
  path: string;
  line: number;
}

/** The rules of a run and what breaks them, for the custom-rules check. */
export interface RuleFacts {
  rules: CustomRule[];
  violations: RuleViolation[];
}

const RULE_KEYS = new Set(['id', 'forbidImport', 'pattern', 'files', 'severity', 'message']);
const RULE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validates the `rules` value of a config. Every problem names the rule and
 * the key, and stops the run, as an unknown config key does: a rule that
 * silently never matches would let CI pass on something the team forbade.
 *
 * @param label Where the value came from, for the messages: a file path or `--config-json`.
 */
export function parseRules(value: unknown, label: string): CustomRule[] {
  if (!Array.isArray(value)) throw new Error(`${label}: rules must be an array of rules`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${label}: rules[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || !RULE_ID.test(id)) throw new Error(`${label}: rules[${index}] needs an id of lower-case letters, digits and dashes, such as "no-moment"`);
    const where = `${label}: rule ${id}`;
    if (seen.has(id)) throw new Error(`${where} is defined twice`);
    seen.add(id);
    const unknown = Object.keys(record).filter((key) => !RULE_KEYS.has(key));
    if (unknown.length > 0) throw new Error(`${where}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')}. Allowed: ${[...RULE_KEYS].join(', ')}`);

    const hasImport = record['forbidImport'] !== undefined;
    const hasPattern = record['pattern'] !== undefined;
    if (hasImport === hasPattern) throw new Error(`${where} needs exactly one of forbidImport and pattern`);
    const rule: CustomRule = { id, severity: 'medium' };
    if (hasImport) {
      const raw = record['forbidImport'];
      const list = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(list) || list.length === 0 || !list.every((item) => typeof item === 'string' && item.trim() !== '')) throw new Error(`${where}: forbidImport must be a package name or an array of them`);
      rule.forbidImport = list.map((item: string) => item.trim().replace(/\/+$/, ''));
    } else {
      const pattern = record['pattern'];
      if (typeof pattern !== 'string' || pattern === '') throw new Error(`${where}: pattern must be a regular expression as a string`);
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new Error(`${where}: pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
      rule.pattern = pattern;
    }
    if (record['files'] !== undefined) {
      const files = record['files'];
      if (!Array.isArray(files) || files.length === 0 || !files.every((item) => typeof item === 'string' && item.trim() !== '')) throw new Error(`${where}: files must be an array of paths`);
      rule.files = files as string[];
    }
    if (record['severity'] !== undefined) {
      const severity = record['severity'];
      if (severity !== 'high' && severity !== 'medium' && severity !== 'low') throw new Error(`${where}: severity must be "high", "medium" or "low"`);
      rule.severity = severity;
    }
    if (record['message'] !== undefined) {
      if (typeof record['message'] !== 'string') throw new Error(`${where}: message must be text`);
      rule.message = record['message'];
    }
    return rule;
  });
}

/** Rules from two sources by id: the later list replaces a rule of the same id and adds the others. */
export function mergeRules(base: CustomRule[] | undefined, override: CustomRule[] | undefined): CustomRule[] | undefined {
  if (!override) return base;
  if (!base) return override;
  const ids = new Set(override.map((rule) => rule.id));
  return [...base.filter((rule) => !ids.has(rule.id)), ...override];
}

/**
 * Whether a rule reads a file: the rule's `files` when it has them, test
 * code included; application code otherwise.
 */
function ruleScope(rule: CustomRule): (path: string) => boolean {
  const matches = rule.files ? ignoreMatcher(rule.files) : undefined;
  return matches ?? ((path) => !isTestCode(path));
}

/** True when `specifier` is `forbidden` or a path inside it: `moment` covers `moment/locale/de`, not `moment-timezone`. */
function isForbidden(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

/**
 * The imports that break the `forbidImport` rules. An `import type` is
 * erased at compile time and loads nothing, so it is allowed; `import()`,
 * `require` and `export … from` are not.
 */
export function importViolations(rules: CustomRule[], sources: SourceFileFacts[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (const rule of rules) {
    if (!rule.forbidImport) continue;
    const inScope = ruleScope(rule);
    for (const file of sources) {
      if (!inScope(file.path) || (!rule.files && file.isGenerated)) continue;
      for (const fact of file.imports) {
        if (fact.typeOnly) continue;
        if (rule.forbidImport.some((forbidden) => isForbidden(fact.specifier, forbidden))) violations.push({ rule: rule.id, path: file.path, line: fact.line });
      }
    }
  }
  return violations;
}

/** Thrown when a rule's regular expression takes too long on one file. */
export class RuleTimeoutError extends Error {
  override name = 'RuleTimeoutError';
}

/** How long one pattern may take on one file before the run stops. A sound pattern takes microseconds. */
export const PATTERN_TIMEOUT_MS = 2000;

/**
 * Runs in a worker thread, so a regular expression that backtracks without
 * end can be stopped: JavaScript cannot interrupt a running match, but it can
 * terminate the thread it runs in. It announces each rule and file before
 * testing, which tells the main thread which one hung.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const rules = workerData.rules.map((rule) => ({ id: rule.id, expression: new RegExp(rule.pattern) }));
for (const file of workerData.files) {
  let lines;
  try {
    lines = readFileSync(file.absolute, 'utf8').split(/\\r?\\n/);
  } catch {
    continue;
  }
  for (const rule of rules) {
    if (!file.rules.includes(rule.id)) continue;
    parentPort.postMessage({ type: 'start', rule: rule.id, path: file.path });
    const lineNumbers = [];
    for (let index = 0; index < lines.length; index++) if (rule.expression.test(lines[index])) lineNumbers.push(index + 1);
    if (lineNumbers.length > 0) parentPort.postMessage({ type: 'hits', rule: rule.id, path: file.path, lines: lineNumbers });
  }
}
parentPort.postMessage({ type: 'done' });
`;

/** A file a pattern rule may read: its report path and where it is on disk. */
export interface PatternFile {
  path: string;
  absolute: string;
}

/**
 * The lines that match the `pattern` rules, read in a worker thread.
 *
 * @throws `RuleTimeoutError` naming the rule and the file when one pattern
 *   takes longer than `timeoutMs` on one file. The run stops rather than
 *   reporting a count that silently left files out.
 */
export async function patternViolations(rules: CustomRule[], files: PatternFile[], isGenerated: (path: string) => boolean, timeoutMs = PATTERN_TIMEOUT_MS): Promise<RuleViolation[]> {
  const patternRules = rules.filter((rule): rule is CustomRule & { pattern: string } => rule.pattern !== undefined);
  if (patternRules.length === 0) return [];
  const scopes = patternRules.map((rule) => ({ rule, inScope: ruleScope(rule) }));
  const work = files
    .map((file) => ({ ...file, rules: scopes.filter(({ rule, inScope }) => inScope(file.path) && (rule.files !== undefined || !isGenerated(file.path))).map(({ rule }) => rule.id) }))
    .filter((file) => file.rules.length > 0);
  if (work.length === 0) return [];

  return new Promise((resolvePromise, reject) => {
    const violations: RuleViolation[] = [];
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { rules: patternRules.map(({ id, pattern }) => ({ id, pattern })), files: work } });
    let current: { rule: string; path: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolvePromise(violations);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const where = current ? `rule ${current.rule} took longer than ${timeoutMs / 1000} s on ${current.path}` : `the pattern rules took longer than ${timeoutMs / 1000} s to start`;
        finish(new RuleTimeoutError(`${where}. Its pattern probably backtracks without end (nested quantifiers such as (a+)+); simplify it or narrow it with files.`));
      }, timeoutMs);
    };
    worker.on('message', (message: { type: string; rule?: string; path?: string; lines?: number[] }) => {
      if (message.type === 'start') {
        current = { rule: message.rule!, path: message.path! };
        arm();
      } else if (message.type === 'hits') {
        for (const line of message.lines!) violations.push({ rule: message.rule!, path: message.path!, line });
      } else if (message.type === 'done') {
        finish();
      }
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => finish(code === 0 ? undefined : new Error(`the pattern rules stopped with exit code ${code}`)));
    arm();
  });
}
