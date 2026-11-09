import { isReportPath, parseConfig, type CheckupConfig } from './config.js';
import { parseRules, type CustomRule } from './rules.js';

/** Asks one question and resolves with the answer as typed, without the newline. */
export type Ask = (question: string) => Promise<string>;

/** What the wizard settled on, and whether to write it to the config file. */
export interface WizardResult {
  config: CheckupConfig;
  save: boolean;
}

/** Answers that mean yes. */
const YES = new Set(['y', 'yes', 'd', 'da', 'да', 'j', 'ja']);
const NO = new Set(['n', 'no', 'ne', 'не', 'nein']);

/**
 * `ng-checkup --interactive`: asks for every setting one at a time, the
 * current value in brackets, Enter keeps it. A wrong answer is explained and
 * asked again, so the result is always a valid config. It ends with the
 * question whether to save the settings for the next runs; either way the
 * run that follows uses them.
 *
 * @param current The config file as it is (empty without one), which gives every default.
 * @param checkIds The ids `only` and `skip` accept.
 * @param say Writes one line for the person answering.
 */
export async function runWizard(current: CheckupConfig, checkIds: readonly string[], ask: Ask, say: (line: string) => void, configPath: string): Promise<WizardResult> {
  say('Settings for this run. Enter keeps the value in brackets; - clears a list.');
  say('');

  const failOn = await choose(ask, say, 'Fail the run when', ['never', 'poor', 'fair', 'regression'], current.failOn ?? 'never', {
    never: 'never fail',
    poor: 'an area is graded poor',
    fair: 'an area is graded fair or poor',
    regression: 'a measure is worse than the baseline',
  });
  const offline = await yesNo(ask, say, 'Work offline (no npm registry, no osv.dev)?', current.offline ?? false);
  const plan = await yesNo(ask, say, 'Add the upgrade plan?', current.plan ?? false);
  say(`Areas: ${checkIds.join(', ')}`);
  const only = await list(ask, say, 'Report only these areas (empty for all)', current.only, (id) => (checkIds.includes(id) ? undefined : `no area named ${id}`));
  const skip = await list(ask, say, 'Leave out these areas', current.skip, (id) => (checkIds.includes(id) ? undefined : `no area named ${id}`));
  const ignore = await list(ask, say, 'Paths to leave out of the analysis (src/legacy, **/generated)', current.ignore);
  const maxExamples = await whole(ask, say, 'Example files per finding', current.maxExamples ?? 5);
  const reports = await list(ask, say, 'Report files to write (checkup.html, checkup.md, checkup.json)', current.reports, (path) => (isReportPath(path) ? undefined : `${path} names no report format`));
  const rules = await editRules(ask, say, current.rules ?? []);

  const config: CheckupConfig = { ...current };
  // A setting left at the default stays out of the file, unless the file already had it.
  assign(config, 'offline', offline || current.offline !== undefined ? offline : undefined);
  assign(config, 'plan', plan || current.plan !== undefined ? plan : undefined);
  assign(config, 'maxExamples', maxExamples !== 5 || current.maxExamples !== undefined ? maxExamples : undefined);
  assign(config, 'failOn', failOn === 'never' ? undefined : (failOn as CheckupConfig['failOn']));
  assign(config, 'only', only);
  assign(config, 'skip', skip);
  assign(config, 'ignore', ignore);
  assign(config, 'reports', reports);
  assign(config, 'rules', rules.length > 0 ? rules : undefined);
  // The same validation as the file, so a saved config always loads.
  parseConfig(toJson(config), 'the answers');

  say('');
  const save = await yesNo(ask, say, `Save these settings to ${configPath} for the next runs?`, false);
  return { config, save };
}

/** The config as it is written to the file: one package in `forbidImport` as a string, the default severity left out. */
export function toJson(config: CheckupConfig): Record<string, unknown> {
  const { rules, ...rest } = config;
  return {
    ...rest,
    ...(rules
      ? {
          rules: rules.map((rule) => ({
            id: rule.id,
            ...(rule.forbidImport ? { forbidImport: rule.forbidImport.length === 1 ? rule.forbidImport[0] : rule.forbidImport } : {}),
            ...(rule.pattern ? { pattern: rule.pattern } : {}),
            ...(rule.files ? { files: rule.files } : {}),
            ...(rule.severity !== 'medium' ? { severity: rule.severity } : {}),
            ...(rule.message ? { message: rule.message } : {}),
          })),
        }
      : {}),
  };
}

/** Sets `key`, or removes it when `value` is undefined, so a cleared setting leaves the file. */
function assign<K extends keyof CheckupConfig>(config: CheckupConfig, key: K, value: CheckupConfig[K] | undefined): void {
  if (value === undefined) delete config[key];
  else config[key] = value;
}

/** Asks until `parse` accepts the answer; an empty answer is `fallback`. */
async function until<T>(ask: Ask, say: (line: string) => void, question: string, parse: (answer: string) => { value: T } | { error: string }): Promise<T> {
  for (;;) {
    const result = parse((await ask(question)).trim());
    if ('value' in result) return result.value;
    say(`  ${result.error}`);
  }
}

async function choose(ask: Ask, say: (line: string) => void, question: string, options: string[], fallback: string, hints: Record<string, string>): Promise<string> {
  say(`${question}:`);
  for (const option of options) say(`  ${option.padEnd(11)} ${hints[option]}`);
  return until<string>(ask, say, `> [${fallback}] `, (answer) => {
    const value = answer === '' ? fallback : answer.toLowerCase();
    return options.includes(value) ? { value } : { error: `answer one of ${options.join(', ')}` };
  });
}

async function yesNo(ask: Ask, say: (line: string) => void, question: string, fallback: boolean): Promise<boolean> {
  return until<boolean>(ask, say, `${question} [${fallback ? 'Y/n' : 'y/N'}] `, (answer) => {
    const value = answer.toLowerCase();
    if (value === '') return { value: fallback };
    if (YES.has(value)) return { value: true };
    if (NO.has(value)) return { value: false };
    return { error: 'answer y or n' };
  });
}

async function whole(ask: Ask, say: (line: string) => void, question: string, fallback: number): Promise<number> {
  return until<number>(ask, say, `${question} [${fallback}] `, (answer) => {
    if (answer === '') return { value: fallback };
    const value = Number(answer);
    return Number.isInteger(value) && value >= 0 ? { value } : { error: 'a whole number, 0 or more' };
  });
}

/** A comma-separated list. Enter keeps the current one, `-` clears it. */
async function list(ask: Ask, say: (line: string) => void, question: string, fallback: string[] | undefined, check?: (item: string) => string | undefined): Promise<string[] | undefined> {
  const shown = fallback && fallback.length > 0 ? fallback.join(', ') : '';
  return until<string[] | undefined>(ask, say, `${question} [${shown}] `, (answer) => {
    if (answer === '') return { value: fallback && fallback.length > 0 ? fallback : undefined };
    if (answer === '-') return { value: undefined };
    const items = answer.split(',').map((item) => item.trim()).filter(Boolean);
    const problem = check ? items.map(check).find((message) => message !== undefined) : undefined;
    return problem ? { error: problem } : { value: items };
  });
}

/** Shows the rules there are, lets some go, then adds new ones one question at a time. */
async function editRules(ask: Ask, say: (line: string) => void, current: CustomRule[]): Promise<CustomRule[]> {
  let rules = current;
  if (rules.length > 0) {
    say('Rules now:');
    for (const rule of rules) say(`  ${rule.id}  ${rule.forbidImport ? `forbids ${rule.forbidImport.join(', ')}` : `pattern ${rule.pattern}`}`);
    const ids = rules.map((rule) => rule.id);
    const removed = await list(ask, say, 'Remove any of them (ids)', undefined, (id) => (ids.includes(id) ? undefined : `no rule ${id}`));
    if (removed) rules = rules.filter((rule) => !removed.includes(rule.id));
  }
  while (await yesNo(ask, say, rules.length === 0 ? 'Add a rule (a forbidden import or pattern)?' : 'Add a rule?', false)) {
    rules = [...rules, await askRule(ask, say, rules.map((rule) => rule.id))];
  }
  return rules;
}

/** One new rule. Each answer is checked by `parseRules`, so the rule is valid the moment it is added. */
async function askRule(ask: Ask, say: (line: string) => void, taken: string[]): Promise<CustomRule> {
  const id = await until<string>(ask, say, '  Id (no-moment): ', (answer) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(answer)) return { error: 'lower-case letters, digits and dashes' };
    return taken.includes(answer) ? { error: `there is already a rule ${answer}` } : { value: answer };
  });
  const kind = await until<string>(ask, say, '  Forbid an import or a pattern? [import/pattern] ', (answer) => (answer === 'import' || answer === 'pattern' ? { value: answer } : { error: 'answer import or pattern' }));
  const raw: Record<string, unknown> = { id };
  if (kind === 'import') {
    raw['forbidImport'] = await until<string[]>(ask, say, '  Packages, comma-separated (moment, lodash): ', (answer) => {
      const names = answer.split(',').map((name) => name.trim()).filter(Boolean);
      return names.length > 0 ? { value: names } : { error: 'at least one package' };
    });
  } else {
    raw['pattern'] = await until<string>(ask, say, '  Regular expression, tested on every line (console\\.log): ', (answer) => {
      if (answer === '') return { error: 'a regular expression' };
      try {
        new RegExp(answer);
        return { value: answer };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
  const files = await list(ask, say, '  Only in these paths (empty for application code; **/*.spec.ts for tests)', undefined);
  if (files) raw['files'] = files;
  raw['severity'] = await choose(ask, say, '  Severity', ['high', 'medium', 'low'], 'medium', { high: 'blocks the next step', medium: 'should be fixed', low: 'worth knowing' });
  const message = (await ask('  What to do instead (optional): ')).trim();
  if (message) raw['message'] = message;
  return parseRules([raw], 'the answers')[0]!;
}
