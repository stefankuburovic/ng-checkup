import type { Grade, Report } from '../types.js';
import { overallScore, scoreBand } from './summary.js';

/** Fill per score band, each at least 4.5:1 against the white text. */
const COLORS: Record<Grade, string> = { good: '2e7d32', fair: 'a15c00', poor: 'c62828', info: '616161' };
const LABEL = 'ng-checkup';

/** What a badge says: `91/100`, or `n/a` when nothing was graded. */
function message(report: Pick<Report, 'checks'>): string {
  const score = overallScore(report);
  return score === undefined ? 'n/a' : `${score}/100`;
}

/** Width in pixels of Verdana at 11px, near enough: `textLength` below makes the text fit whatever font renders it. */
const textWidth = (text: string): number => Math.round(text.length * 6.6);

/**
 * The score as a README badge (`--report badge.svg`), in the same bands as the
 * report's tables: 80 and up is good, 50 and up is fair. Self-contained, so
 * it can be committed next to the README and loads nothing from the network.
 * A committed file is only as fresh as the job that writes it, which is why
 * `renderBadgeJson` exists too.
 */
export function renderBadgeSvg(report: Pick<Report, 'checks'>): string {
  const text = message(report);
  const left = textWidth(LABEL) + 12;
  const right = textWidth(text) + 12;
  const width = left + right;
  const fill = COLORS[scoreBand(overallScore(report))];
  const label = `${LABEL} score: ${text}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}">
  <title>${label}</title>
  <rect width="${left}" height="20" fill="#444444"/>
  <rect x="${left}" width="${right}" height="20" fill="#${fill}"/>
  <g fill="#ffffff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${left / 2}" y="14" textLength="${left - 12}">${LABEL}</text>
    <text x="${left + right / 2}" y="14" textLength="${right - 12}">${text}</text>
  </g>
</svg>
`;
}

/**
 * The same badge as a shields.io endpoint (`--report badge.json`): host the
 * file anywhere public and `img.shields.io/endpoint?url=...` draws it, so the
 * job only has to publish a file and never has to commit to the repository.
 */
export function renderBadgeJson(report: Pick<Report, 'checks'>): string {
  return `${JSON.stringify({ schemaVersion: 1, label: LABEL, message: message(report), color: COLORS[scoreBand(overallScore(report))] }, null, 2)}\n`;
}
