import type { CheckResult, Finding, Grade } from '../types.js';
import { formatCount, plural, type AnalysisContext } from './context.js';

/** How many tangles get a finding of their own; the rest are summarised in one line. */
const LISTED_TANGLES = 5;

/**
 * Import cycles between application files.
 *
 * A cycle is more than a style issue in an Angular app: whichever file of the
 * loop the bundler evaluates first sees the others' exports as `undefined`,
 * which surfaces as "X is not a function" or "Cannot access X before
 * initialization" only in some load orders, such as one lazy route or one test
 * file run on its own. Cycles also stop the bundler from splitting the files
 * into separate lazy chunks.
 */
export function circularDepsCheck(context: AnalysisContext): CheckResult {
  const tangles = context.tangles;
  const filesInTangles = tangles.reduce((sum, tangle) => sum + tangle.files.length, 0);
  const largest = tangles[0]?.files.length ?? 0;

  const findings: Finding[] = tangles.slice(0, LISTED_TANGLES).map((tangle) => ({
    severity: tangle.files.length >= 10 ? 'high' : 'medium',
    message: `${plural(tangle.files.length, 'file')} import each other in a loop`,
    detail: `For example: ${tangle.example.map((path) => `\`${path}\``).join(' → ')}. The group dissolves once every loop in it loses one import; most often the culprit is a barrel (\`index.ts\`) import that drags in a sibling, fixed by importing the file directly.`,
    files: tangle.files.slice(0, context.maxExamples).map((path) => ({ path })),
    count: tangle.files.length,
  }));
  if (tangles.length > LISTED_TANGLES) {
    const rest = tangles.slice(LISTED_TANGLES);
    findings.push({ severity: 'medium', message: `${plural(rest.length, 'more tangle')} with ${plural(rest.reduce((sum, tangle) => sum + tangle.files.length, 0), 'file')}`, detail: 'Smaller than the ones above; the same fix applies.' });
  }

  const grade: Grade = tangles.length === 0 ? 'good' : tangles.length <= 3 && filesInTangles <= 10 ? 'fair' : 'poor';

  return {
    id: 'circular-deps',
    title: 'Circular dependencies',
    grade,
    summary: tangles.length === 0 ? 'No import cycles between application files.' : `${plural(tangles.length, 'group')} of files importing each other in a loop, ${plural(filesInTangles, 'file')} in total.`,
    metrics: [
      { label: 'Tangles', value: formatCount(tangles.length), hint: 'groups of files in a loop' },
      { label: 'Files involved', value: formatCount(filesInTangles) },
      { label: 'Largest tangle', value: formatCount(largest), hint: 'files' },
    ],
    findings,
    measures: [
      { id: 'files-in-cycles', label: 'Files in import cycles', value: filesInTangles },
    ],
  };
}
