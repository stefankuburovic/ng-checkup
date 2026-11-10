import { formatCount, plural } from '../checks/context.js';
import { measuresOf } from '../baseline.js';
import type { CheckResult, FileRef, Grade, Report } from '../types.js';
import { editorName, editorUrl, type Editor } from './editor.js';
import { escape } from './escape.js';
import { gradeLabel, kindLabel, overallScore, scoreBand, sinceSentence } from './summary.js';
import { trendSentence } from '../trend.js';

/** The layouts of the overview block. The markup is the same in all of them; only CSS differs. */
export type OverviewVariant = 'base' | 'ledger' | 'tiles' | 'columns' | 'changes';

export const OVERVIEW_VARIANTS: readonly OverviewVariant[] = ['base', 'ledger', 'tiles', 'columns', 'changes'];

export function isOverviewVariant(value: string): value is OverviewVariant {
  return (OVERVIEW_VARIANTS as readonly string[]).includes(value);
}

/** How many measure changes the overview lists before it links to the rest. */
export const OVERVIEW_CHANGE_LIMIT = 8;

/** Below this many graded areas the score is a rough signal, and the overview says so. */
const LOW_COVERAGE = 5;

const GRADE_ORDER: Record<Grade, number> = { poor: 0, fair: 1, good: 2, info: 3 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The first page of the HTML report: who the project is, the score with its
 * change since the baseline, every area's grade, and which measures moved.
 *
 * A grade is never told by colour alone (WCAG 1.4.1): every one carries a
 * shape (`.ov-glyph`) and its word, and a change carries a triangle and the
 * word Better or Worse. Everything that names something links to it: a tally
 * card to its grade group, an area or a change to its section, a file to the
 * editor at its line.
 */
export function renderOverview(report: Report, options: { editor: Editor; variant: OverviewVariant }): string {
  const { project, checks } = report;
  const comparison = report.baseline;
  const score = overallScore(report);
  const band = scoreBand(score);
  const graded = checks.filter((check) => check.grade !== 'info');
  const count = (grade: Grade): number => checks.filter((check) => check.grade === grade).length;
  const low = graded.length < LOW_COVERAGE && checks.length >= LOW_COVERAGE;
  const since = comparison?.updated ? formatDate(comparison.updated) : undefined;

  const meta = [
    `${kindLabel(report)}${project.workspaceFolder ? ` in ${project.workspaceFolder}` : ''}`,
    project.angularVersion ? `Angular ${project.angularVersion}` : undefined,
    report.projects ? plural(report.projects.length, 'project') : undefined,
    `${plural(project.sourceFiles, 'TypeScript file')}${project.javascriptFiles ? `, ${plural(project.javascriptFiles, 'JavaScript file')}` : ''}`,
    plural(project.templateFiles, 'template'),
    `${plural(project.linesOfCode, 'line')} of code`,
    project.generatedFiles ? `${plural(project.generatedFiles, 'generated file')} left out` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const dates = `Generated ${formatDate(report.generatedAt.slice(0, 10))}${comparison ? ` · compared with the baseline${since ? ` of ${since}` : ''}` : ' · no baseline yet'}`;
  const notes = [sinceSentence(report), report.trend && trendSentence(report.trend) ? `Last ${report.trend.days} days: ${trendSentence(report.trend)}` : undefined].filter(Boolean) as string[];

  // Worst first, then the fixed check order, so reading order and tab order match every variant.
  const areas = checks.map((check, index) => ({ check, index })).sort((left, right) => GRADE_ORDER[left.check.grade] - GRADE_ORDER[right.check.grade] || left.index - right.index).map(({ check }) => check);
  const firstOf = (grade: Grade): CheckResult | undefined => areas.find((check) => check.grade === grade);

  const verdict = verdictSentence(report, score, comparison?.score, since, low);
  const delta = scoreDelta(score, comparison?.score, since, comparison !== undefined);

  return `<section class="ov" id="overview" data-variant="${options.variant}" data-coverage="${low ? 'low' : 'ok'}" aria-labelledby="ov-title">
  <header class="ov-head">
    <p class="ov-eyebrow">Angular checkup</p>
    <h1 class="ov-title" id="ov-title">${escape(project.name)}</h1>
    <p class="ov-meta">${escape(meta)}</p>
    <p class="ov-dates">${escape(dates)}</p>
    ${notes.map((note) => `<p class="ov-dates">${escape(note)}</p>`).join('\n    ')}
  </header>

  <div class="ov-verdict">
    <div class="ov-score g-${band}">
      <p class="ov-score-num"><span class="ov-score-value">${score ?? '–'}</span><span class="ov-score-max">/100</span></p>
      <p class="ov-band"><span class="ov-glyph" aria-hidden="true"></span>${score === undefined ? 'Not graded' : gradeLabel(band)}</p>
      ${delta ? `<p class="ov-delta" data-dir="${delta.dir}"><span class="ov-judge"><span class="ov-dir" aria-hidden="true"></span>${delta.word}</span><span>${escape(delta.text)}</span></p>` : ''}
      <div class="ov-scale" role="img" aria-label="${escape(`Score ${score ?? 'not available'} of 100${comparison?.score !== undefined ? `, baseline ${comparison.score}` : ''}. Under 50 is poor, 50 to 79 fair, 80 and above good.`)}">
        <span class="ov-scale-track"></span>
        ${score === undefined ? '' : `<span class="ov-scale-fill" style="width:${score}%"></span>`}
        ${comparison?.score !== undefined ? `<span class="ov-scale-base" style="left:${comparison.score}%"></span>` : ''}
        <span class="ov-scale-tick" style="left:50%">50</span>
        <span class="ov-scale-tick" style="left:80%">80</span>
      </div>
      <p class="ov-coverage">${escape(coverageSentence(graded.length, checks.length, low))}</p>
    </div>
    <p class="ov-summary">${escape(verdict)}</p>
    <ul class="ov-tally" aria-label="Areas by grade">
      ${(['poor', 'fair', 'good', 'info'] as const)
        .map((grade) => {
          const n = count(grade);
          const first = firstOf(grade);
          const inner = `<span class="ov-glyph" aria-hidden="true"></span><span class="ov-tally-count">${n}</span><span class="ov-tally-label">${gradeLabel(grade)}</span>`;
          return `<li class="ov-tally-item g-${grade}" data-count="${n}">${first ? `<a class="ov-tally-link" href="#ov-${escape(first.id)}">${inner}</a>` : `<span class="ov-tally-link">${inner}</span>`}</li>`;
        })
        .join('\n      ')}
    </ul>
  </div>
${projectsBlock(report)}
  <section class="ov-areas" aria-labelledby="ov-areas-h">
    <div class="ov-section-head"><h2 class="ov-h2" id="ov-areas-h">${plural(checks.length, 'area')}</h2><p class="ov-aside">Worst first · a row opens its findings${options.editor === 'none' ? '' : `, a file opens in ${escape(editorName(options.editor))}`}</p></div>
    <ol class="ov-area-list">
      ${areas.map((check) => areaRow(check, comparison?.grades?.[check.id])).join('\n      ')}
    </ol>
  </section>

${changesBlock(report, since)}
</section>`;
}

/** One area: grade, name (the row's link), its summary, and the grade it had in the baseline when that differs. */
function areaRow(check: CheckResult, was: Grade | undefined): string {
  const changed = was !== undefined && was !== check.grade && was !== 'info' && check.grade !== 'info';
  const dir = changed ? (GRADE_ORDER[check.grade] < GRADE_ORDER[was] ? 'worse' : 'better') : undefined;
  return `<li class="ov-area g-${check.grade}" id="ov-${escape(check.id)}"><div class="ov-area-row"><span class="ov-grade"><span class="ov-glyph" aria-hidden="true"></span><span class="ov-grade-word">${gradeLabel(check.grade)}</span></span><a class="ov-area-name" href="#${escape(check.id)}">${escape(check.title)}</a><span class="ov-area-note">${inlineText(check.summary)}</span>${changed ? `<span class="ov-area-change" data-dir="${dir}"><span class="ov-dir" aria-hidden="true"></span><span class="ov-vh">Grade changed, </span>was ${gradeLabel(was!)}</span>` : ''}</div></li>`;
}

/** The per-project scores of a multi-project workspace, worst first; each row links to its line in the detail table. */
function projectsBlock(report: Report): string {
  const rows = report.projects ?? [];
  if (rows.length === 0) return '';
  return `
  <section class="ov-projects" aria-labelledby="ov-projects-h">
    <div class="ov-section-head"><h2 class="ov-h2" id="ov-projects-h">${plural(rows.length, 'project')}</h2><p class="ov-aside">Worst first</p></div>
    <ol class="ov-project-list">
      ${rows
        .map((row) => {
          const band = scoreBand(row.score);
          const shown = row.root || row.name;
          const cut = shown.lastIndexOf('/');
          return `<li class="ov-project g-${band}"><a class="ov-project-link" href="#${projectAnchor(row.name)}"><span class="ov-grade"><span class="ov-glyph" aria-hidden="true"></span><span class="ov-grade-word">${gradeLabel(band)}</span></span><span class="ov-project-name ov-path"><span class="ov-path-dir">${breakable(shown.slice(0, cut + 1))}</span><span class="ov-path-file">${escape(shown.slice(cut + 1))}</span></span><span class="ov-project-score"><span class="ov-vh">Score </span>${row.score ?? '–'}</span><span class="ov-project-bar" aria-hidden="true">${row.score === undefined ? '' : `<span class="ov-project-fill" style="width:${row.score}%"></span>`}</span></a></li>`;
        })
        .join('\n      ')}
    </ol>
  </section>
`;
}

/** The measures that moved since the baseline: worse first, at most `OVERVIEW_CHANGE_LIMIT`, then a link to the full list. */
function changesBlock(report: Report, since: string | undefined): string {
  const comparison = report.baseline;
  const title = since ? `Since ${since}` : 'Since the baseline';
  if (!comparison) {
    return `  <section class="ov-changes" aria-labelledby="ov-changes-h">
    <div class="ov-section-head"><h2 class="ov-h2" id="ov-changes-h">${escape(title)}</h2></div>
    <p class="ov-empty">No baseline yet. Run <code>ng-checkup baseline</code> to record this run; later runs list here what got better or worse.</p>
  </section>`;
  }
  const rows = [...comparison.regressions.map((delta) => ({ delta, dir: 'worse' as const })), ...comparison.improvements.map((delta) => ({ delta, dir: 'better' as const }))];
  const unchanged = Math.max(0, measuresOf(report).size - comparison.added.length - rows.length);
  const aside = `${comparison.regressions.length} worse · ${comparison.improvements.length} better · ${unchanged} unchanged`;
  if (rows.length === 0) {
    return `  <section class="ov-changes" aria-labelledby="ov-changes-h">
    <div class="ov-section-head"><h2 class="ov-h2" id="ov-changes-h">${escape(title)}</h2><p class="ov-aside">${escape(aside)}</p></div>
    <p class="ov-empty">No measure changed${since ? ` since ${escape(since)}` : ''}.</p>
  </section>`;
  }
  const shown = rows.slice(0, OVERVIEW_CHANGE_LIMIT);
  const more = rows.length - shown.length;
  return `  <section class="ov-changes" aria-labelledby="ov-changes-h">
    <div class="ov-section-head"><h2 class="ov-h2" id="ov-changes-h">${escape(title)}</h2><p class="ov-aside">${escape(aside)}</p></div>
    <ol class="ov-change-list">
      ${shown
        .map(({ delta, dir }) => {
          const difference = delta.after - delta.before;
          return `<li class="ov-change" data-dir="${dir}"><a class="ov-change-name" href="#${escape(delta.key.split('.')[0]!)}">${escape(delta.label)}</a><span class="ov-change-area">${escape(delta.check)}</span><span class="ov-change-values"><span class="ov-vh">from </span><span class="ov-before">${number(delta.before)}</span><span class="ov-arrow" aria-hidden="true">→</span><span class="ov-vh"> to </span><span class="ov-now">${number(delta.after)}</span></span><span class="ov-change-diff">${difference > 0 ? '+' : '−'}${number(Math.abs(difference))}</span><span class="ov-judge"><span class="ov-dir" aria-hidden="true"></span>${dir === 'worse' ? 'Worse' : 'Better'}</span></li>`;
        })
        .join('\n      ')}
      ${more > 0 ? `<li class="ov-change-more"><a href="#changes">And ${plural(more, 'more change')} in the full list</a></li>` : ''}
    </ol>
  </section>`;
}

/** The score's change since the baseline, or the first-run line; undefined when the baseline has no score to compare with. */
function scoreDelta(score: number | undefined, base: number | undefined, since: string | undefined, hasBaseline: boolean): { dir: string; word: string; text: string } | undefined {
  if (!hasBaseline) return { dir: 'none', word: 'First run', text: 'No baseline yet' };
  if (score === undefined || base === undefined) return undefined;
  const when = since ? ` since ${since}` : ' since the baseline';
  if (score > base) return { dir: 'better', word: 'Better', text: `+${score - base}${when}, was ${base}` };
  if (score < base) return { dir: 'worse', word: 'Worse', text: `−${base - score}${when}, was ${base}` };
  return { dir: 'same', word: 'Same', text: `Unchanged${when}` };
}

function coverageSentence(graded: number, total: number, low: boolean): string {
  if (graded === 0) return 'No area could be graded, so there is no score.';
  if (low) return `Only ${graded} of ${total} areas apply, so read the score as a rough signal.`;
  if (graded === total) return `Based on all ${total} areas.`;
  return `Based on ${graded} of ${total} areas; ${total - graded} ${total - graded === 1 ? 'is' : 'are'} info and not graded.`;
}

/**
 * The one-paragraph verdict a manager reads: the band and its move, how many
 * graded areas are poor, and which areas slipped a grade.
 */
function verdictSentence(report: Report, score: number | undefined, base: number | undefined, since: string | undefined, low: boolean): string {
  const graded = report.checks.filter((check) => check.grade !== 'info');
  if (score === undefined) return 'No area could be graded for this codebase; the details below say what each check needs.';
  const band = gradeLabel(scoreBand(score));
  const month = since ? since.split(' ').slice(1).join(' ') : undefined;
  const moved = base === undefined ? '' : score > base ? `, ${score - base} ${score - base === 1 ? 'point' : 'points'} up since ${month ?? 'the baseline'}` : score < base ? `, ${base - score} ${base - score === 1 ? 'point' : 'points'} down since ${month ?? 'the baseline'}` : `, unchanged since ${month ?? 'the baseline'}`;
  const poor = graded.filter((check) => check.grade === 'poor').length;
  const fair = graded.filter((check) => check.grade === 'fair').length;
  const spread = poor > 0 ? `${formatCount(poor)} of the ${formatCount(graded.length)} graded areas ${poor === 1 ? 'is' : 'are'} poor` : fair > 0 ? `No area is poor; ${formatCount(fair)} ${fair === 1 ? 'is' : 'are'} fair` : `Every graded area is good`;
  const grades = report.baseline?.grades;
  const slipped = grades
    ? report.checks.filter((check) => {
        const was = grades[check.id];
        return was !== undefined && was !== 'info' && check.grade !== 'info' && GRADE_ORDER[check.grade] < GRADE_ORDER[was];
      })
    : [];
  const slip = slipped.length > 0 ? `, and ${slipped.slice(0, 2).map((check) => `${check.title} slipped from ${grades![check.id]} to ${check.grade}`).join(' and ')}` : '';
  const coverage = low ? ` Only ${formatCount(graded.length)} of ${formatCount(report.checks.length)} areas apply to this codebase.` : '';
  return `${band}${moved}. ${spread}${slip}.${coverage}`;
}

/** The anchor of a project's row in the detail table. */
export function projectAnchor(name: string): string {
  return `project-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * A file location as a link that opens it in the editor, or as plain text
 * when there is no editor or no absolute root. The folder breaks after every
 * slash and is dimmed; the file name and line stay strong.
 */
export function fileLink(ref: FileRef, root: string, editor: Editor, className = 'ov-path'): string {
  const cut = ref.path.lastIndexOf('/');
  const label = `<span class="ov-path-dir">${breakable(ref.path.slice(0, cut + 1))}</span><span class="ov-path-file">${escape(ref.path.slice(cut + 1))}${ref.line !== undefined ? `:${ref.line}` : ''}</span>`;
  const url = editorUrl(editor, root, ref);
  if (!url) return `<span class="${className}">${label}</span>`;
  return `<a class="${className}" href="${escape(url)}" title="${escape(`Open ${ref.path}${ref.line !== undefined ? ` at line ${ref.line}` : ''} in ${editorName(editor)}`)}">${label}</a>`;
}

/** Escaped text with a break opportunity after every slash. */
function breakable(text: string): string {
  return escape(text).replace(/\//g, '/<wbr>');
}

/** Backtick spans as code, as in the rest of the report. */
function inlineText(text: string): string {
  return escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Thousands with a narrow no-break space, so 1 012 never wraps. */
function number(value: number): string {
  return formatCount(value).replace(/ /g, ' ');
}

/** `2026-08-10` as `10 Aug 2026`; anything else as given. */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}
