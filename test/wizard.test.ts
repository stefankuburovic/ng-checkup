import { parseCliArguments } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { CHECK_IDS } from '../src/index.js';
import { parseRules } from '../src/rules.js';
import { runWizard, toJson } from '../src/wizard.js';

/** Answers the questions in order and records them with what was said in between. */
function script(answers: string[]): { ask: (question: string) => Promise<string>; say: (line: string) => void; transcript: string[] } {
  const transcript: string[] = [];
  const queue = [...answers];
  return {
    transcript,
    say: (line) => transcript.push(line),
    ask: async (question) => {
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`no answer left for: ${question}`);
      transcript.push(`${question}${answer}`);
      return answer;
    },
  };
}

describe('the settings wizard', () => {
  it('keeps every current value on Enter and offers to save', async () => {
    const current = parseConfig({ failOn: 'regression', ignore: ['src/legacy'], rules: [{ id: 'no-moment', forbidImport: 'moment' }] }, 'f');
    // fail-on, offline, plan, only, skip, ignore, examples, reports, remove rules, add rule, save
    const { ask, say, transcript } = script(['', '', '', '', '', '', '', '', '', '', 'y']);
    const result = await runWizard(current, CHECK_IDS, ask, say, 'ng-checkup.config.json');
    expect(result).toEqual({ config: current, save: true });
    expect(transcript).toContain('Paths to leave out of the analysis (src/legacy, **/generated) [src/legacy] ');
    expect(transcript.at(-1)).toBe('Save these settings to ng-checkup.config.json for the next runs? [y/N] y');
  });

  it('asks again after a wrong answer, and builds rules one question at a time', async () => {
    const { ask, say, transcript } = script([
      'sometimes', 'fair', // fail-on: wrong, then right
      'y', // offline
      '', // plan
      'securty', 'security,testing', // only: unknown id, then right
      '', // skip
      'src/legacy, **/generated', // ignore
      'many', '20', // examples
      'out/x.pdf', 'out/checkup.html', // reports
      'y', // add a rule
      'No Moment', 'no-moment', 'import', 'moment, lodash', '', 'high', 'Use date-fns',
      'yes', // add another
      'no-moment', 'no-log', 'pattern', '(', 'console\\.log', 'src/app', '', '',
      'n', // no more rules
      '', // do not save
    ]);
    const result = await runWizard({}, CHECK_IDS, ask, say, 'ng-checkup.config.json');
    expect(result.save).toBe(false);
    expect(result.config).toEqual({
      failOn: 'fair',
      offline: true,
      only: ['security', 'testing'],
      ignore: ['src/legacy', '**/generated'],
      maxExamples: 20,
      reports: ['out/checkup.html'],
      rules: parseRules(
        [
          { id: 'no-moment', forbidImport: ['moment', 'lodash'], severity: 'high', message: 'Use date-fns' },
          { id: 'no-log', pattern: 'console\\.log', files: ['src/app'] },
        ],
        't',
      ),
    });
    for (const message of ['  answer one of never, poor, fair, regression', '  no area named securty', '  a whole number, 0 or more', '  out/x.pdf names no report format', '  lower-case letters, digits and dashes', '  there is already a rule no-moment']) {
      expect(transcript).toContain(message);
    }
    expect(transcript.some((line) => line.startsWith('  Invalid regular expression'))).toBe(true);
  });

  it('removes rules and clears a list with -, and writes what it saves the way a person would', async () => {
    const current = parseConfig({ offline: true, ignore: ['x'], rules: [{ id: 'a', forbidImport: 'x' }, { id: 'b', pattern: 'y', severity: 'low' }] }, 'f');
    const { ask, say } = script(['', 'n', '', '', '', '-', '', '', 'a', '', 'y']);
    const { config } = await runWizard(current, CHECK_IDS, ask, say, 'c.json');
    expect(config).toEqual({ offline: false, rules: [{ id: 'b', pattern: 'y', severity: 'low' }] });
    expect(toJson(parseConfig({ rules: [{ id: 'a', forbidImport: 'x' }, { id: 'b', forbidImport: ['x', 'y'], severity: 'high' }] }, 'f'))).toEqual({
      rules: [
        { id: 'a', forbidImport: 'x' },
        { id: 'b', forbidImport: ['x', 'y'], severity: 'high' },
      ],
    });
  });
});

describe('--interactive on the command line', () => {
  it('is a flag of its own, and refuses --config-json beside it', () => {
    expect(parseCliArguments(['-i'], {}, false)).toMatchObject({ interactive: true });
    expect(() => parseCliArguments(['--interactive', '--config-json', '{}'], {}, false)).toThrow('--interactive asks for the settings that --config-json gives');
  });
});
