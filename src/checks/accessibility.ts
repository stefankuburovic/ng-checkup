import { isTestCode } from '../files.js';
import type { AccessibilityFacts } from '../accessibility.js';
import type { CheckResult, Finding, Severity } from '../types.js';
import { formatCount, plural, type AnalysisContext } from './context.js';

/** One rule of the area: which list of a template's facts it reads, and how it reports. */
interface Rule {
  key: keyof AccessibilityFacts;
  measure: string;
  label: string;
  severity: Severity;
  message: (count: number) => string;
  detail: string;
}

const RULES: Rule[] = [
  {
    key: 'unlabelledControls',
    measure: 'unlabelled-controls',
    label: 'Form controls without a label',
    severity: 'medium',
    message: (count) => `${plural(count, 'form control')} without a label`,
    detail: 'An `<input>`, `<select>` or `<textarea>` with no `<label for>`, no wrapping `<label>` or form-field component (`mat-form-field`, `*-form-field`), and no `aria-label`, `aria-labelledby`, `title` or `placeholder`. A screen reader announces "edit text" and nothing else. WCAG 1.3.1 and 4.1.2, level A.',
  },
  {
    key: 'unnamedButtons',
    measure: 'unnamed-buttons',
    label: 'Buttons without a name',
    severity: 'medium',
    message: (count) => `${plural(count, 'button')} without a name`,
    detail: 'A `<button>` with no text, no image with `alt`, no projected content and no `aria-label`, `aria-labelledby` or `title`: an icon drawn by CSS or an SVG, announced as "button". WCAG 4.1.2, level A. An icon ligature (`<mat-icon>delete</mat-icon>`) counts as text here, although "delete" read aloud is a poor name.',
  },
  {
    key: 'clickWithoutKeyboard',
    measure: 'click-without-keyboard',
    label: 'Click handlers on non-interactive elements without a key handler',
    severity: 'medium',
    message: (count) => `${plural(count, '`(click)` handler')} on a \`div\`, \`span\` or similar with no key handler`,
    detail: 'Mouse-only controls: a keyboard user cannot focus the element or trigger it. A `<button>` (or an `<a>` with `href` / `routerLink`) gets focus, Enter and Space for free; otherwise the element needs `tabindex="0"`, a `role` and a `(keydown.enter)` handler. WCAG 2.1.1, level A.',
  },
  {
    key: 'imagesWithoutAlt',
    measure: 'images-without-alt',
    label: 'Images without alt',
    severity: 'medium',
    message: (count) => `${plural(count, 'image')} without \`alt\``,
    detail: 'A screen reader reads the file name instead. Give every `<img>` an `alt`, and an empty `alt=""` to one that is only decoration. WCAG 1.1.1, level A.',
  },
  {
    key: 'positiveTabindex',
    measure: 'positive-tabindex',
    label: 'tabindex above 0',
    severity: 'low',
    message: (count) => `${plural(count, '`tabindex` above 0')}`,
    detail: 'A positive `tabindex` moves the element ahead of everything else in the tab order, so keyboard focus jumps around the page. Use `0` (in the order of the markup) or `-1` (focusable by script only). WCAG 2.4.3, level A.',
  },
];

/**
 * What a template shows a screen reader or a keyboard user: labels, button
 * names, mouse-only controls, image alternatives, tab order.
 *
 * Never graded, like translations: always `info`, so it changes no score.
 * The rules are read from markup and miss whatever a directive or a
 * component supplies at runtime, so a grade would claim more than the check
 * knows; the measures sit in the baseline, which makes `--fail-on
 * regression` fail on a new defect all the same.
 */
export function accessibilityCheck(context: AnalysisContext): CheckResult {
  const templates = context.templates.filter((template) => !isTestCode(template.path));
  const findings: Finding[] = [];
  const measures = RULES.map((rule) => {
    const hits = templates.filter((template) => template.accessibility[rule.key].length > 0);
    const count = hits.reduce((sum, template) => sum + template.accessibility[rule.key].length, 0);
    if (count > 0) findings.push({ severity: rule.severity, message: rule.message(count), detail: rule.detail, files: hits.slice(0, context.maxExamples).map((template) => ({ path: template.path, line: template.accessibility[rule.key][0] })), count: hits.length });
    return { id: rule.measure, label: rule.label, value: count };
  });
  const total = measures.reduce((sum, measure) => sum + measure.value, 0);

  if (templates.length === 0) {
    return { id: 'accessibility', title: 'Accessibility', grade: 'info', summary: 'No templates to read.', metrics: [], findings: [] };
  }
  return {
    id: 'accessibility',
    title: 'Accessibility',
    grade: 'info',
    summary: total === 0 ? `No unlabelled control, unnamed button, mouse-only control or image without alt in ${plural(templates.length, 'template')}.` : `${plural(total, 'accessibility defect')} in ${plural(new Set(templates.filter((template) => RULES.some((rule) => template.accessibility[rule.key].length > 0)).map((template) => template.path)).size, 'template')}.`,
    metrics: RULES.slice(0, 4).map((rule) => ({ label: rule.label, value: formatCount(measures.find((measure) => measure.id === rule.measure)!.value) })),
    findings,
    measures,
  };
}
