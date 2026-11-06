/**
 * Accessibility defects a template shows on its face: what a screen reader
 * or a keyboard user hits first, and what the European Accessibility Act and
 * WCAG level A ask for.
 *
 * Read from the template text with a small tag scanner, not a browser, so it
 * judges only what the markup states and errs towards silence: an element
 * that gets its name at runtime (a directive that sets `aria-label`, a
 * component that renders its own label) is not seen, and anything with a
 * binding that could supply the missing part counts as having it.
 */

/** One template's defects, as 1-based lines. */
export interface AccessibilityFacts {
  /** `<img>` without `alt` (static or bound), unless it is hidden from assistive technology (`aria-hidden="true"`, `role="presentation"`). */
  imagesWithoutAlt: number[];
  /** `(click)` on an element that is not interactive (`div`, `span`, `li`, `td`, `img`, ...) with no key handler: a mouse-only control. */
  clickWithoutKeyboard: number[];
  /** `<button>` with no text, no image with `alt`, no projected content and no `aria-label` / `aria-labelledby` / `title`. */
  unnamedButtons: number[];
  /** `<input>`, `<select>`, `<textarea>` with no label: no `<label for>`, no wrapping `<label>` or `*-form-field` (`mat-form-field`, a library's own), no `aria-label*`, `title` or `placeholder`. */
  unlabelledControls: number[];
  /** `tabindex` above 0, which takes the element out of the reading order for every keyboard user. */
  positiveTabindex: number[];
}

/** Elements that never contain anything, so they are never pushed on the open-element stack. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Elements a click handler makes into a control nobody can reach without a mouse. */
const NON_INTERACTIVE = new Set(['div', 'span', 'li', 'ul', 'ol', 'td', 'tr', 'th', 'p', 'img', 'i', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'svg', 'mat-icon', 'mat-card', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small', 'strong', 'em', 'b', 'figure', 'dl', 'dt', 'dd']);

/** Input types that need no label: not shown, or named by their own value. */
const UNLABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** A start or end tag, attributes quoted either way, `>` inside a quoted value allowed. */
export const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
export const ATTRIBUTE = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** Attributes of one tag by name, lower-cased, with Angular's binding brackets kept (`[attr.aria-label]`, `(click)`). */
function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  return attributes;
}

/** True when the tag has the attribute in any of Angular's spellings: `x`, `[x]`, `[attr.x]`, `attr.x`. */
function has(attributes: Map<string, string>, name: string): boolean {
  return attributes.has(name) || attributes.has(`[${name}]`) || attributes.has(`[attr.${name}]`) || attributes.has(`attr.${name}`);
}

/** An accessible name given by attribute. */
function namedByAttribute(attributes: Map<string, string>): boolean {
  return ['aria-label', 'aria-labelledby', 'title'].some((name) => has(attributes, name));
}

interface OpenElement {
  name: string;
  line: number;
  /** For a `<button>`: whether anything inside names it. */
  named?: boolean;
}

/** Reads one template's accessibility defects. */
export function accessibilityOf(template: string): AccessibilityFacts {
  // Comments blanked, newlines kept, so lines stay right and commented-out markup is not judged.
  const text = template.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const facts: AccessibilityFacts = { imagesWithoutAlt: [], clickWithoutKeyboard: [], unnamedButtons: [], unlabelledControls: [], positiveTabindex: [] };
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;

  // First pass: every label target, static or bound. A bound one means any control with a bound id may be labelled.
  const labelTargets = new Set<string>();
  let boundLabelTarget = false;
  for (const match of text.matchAll(TAG)) {
    if (match[1] || match[2]!.toLowerCase() !== 'label') continue;
    const attributes = attributesOf(match[3] ?? '');
    if (attributes.has('for')) labelTargets.add(attributes.get('for')!);
    if (attributes.has('[for]') || attributes.has('[attr.for]') || attributes.has('attr.for')) boundLabelTarget = true;
  }

  const stack: OpenElement[] = [];
  const markNamed = (): void => {
    for (const element of stack) if (element.name === 'button') element.named = true;
  };
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    // Text between tags names every button it sits in: words or an interpolation, not just whitespace or control-flow braces.
    const between = text.slice(last, match.index).replace(/@(if|else|for|switch|case|default|defer|empty|placeholder|loading)\b[^{]*\{|[{}]/g, (block) => (block.startsWith('{{') ? block : ' '));
    if (/\{\{|[^\s]/.test(between)) markNamed();
    last = match.index + match[0].length;

    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    const line = lineAt(match.index);
    if (closing) {
      const index = stack.map((element) => element.name).lastIndexOf(name);
      if (index < 0) continue;
      for (const element of stack.splice(index)) if (element.name === 'button' && !element.named) facts.unnamedButtons.push(element.line);
      continue;
    }

    const attributes = attributesOf(match[3] ?? '');
    const hidden = attributes.get('aria-hidden') === 'true' || ['presentation', 'none'].includes(attributes.get('role') ?? '');

    if (name === 'img') {
      if (!has(attributes, 'alt') && !hidden) facts.imagesWithoutAlt.push(line);
      else if (has(attributes, 'alt') && attributes.get('alt') !== '') markNamed();
    }
    if (name === 'ng-content') markNamed();
    if (attributes.has('(click)') && NON_INTERACTIVE.has(name) && ![...attributes.keys()].some((key) => /^\((keydown|keyup|keypress)/.test(key))) facts.clickWithoutKeyboard.push(line);
    const tabindex = attributes.get('tabindex') ?? attributes.get('[tabindex]') ?? attributes.get('[attr.tabindex]');
    if (tabindex !== undefined && /^\s*'?([1-9]\d*)'?\s*$/.test(tabindex)) facts.positiveTabindex.push(line);

    const control = name === 'select' || name === 'textarea' || (name === 'input' && !UNLABELLED_INPUT_TYPES.has((attributes.get('type') ?? 'text').toLowerCase()));
    if (control && !attributes.has('hidden') && !hidden) {
      const id = attributes.get('id');
      const labelled =
        namedByAttribute(attributes) ||
        has(attributes, 'placeholder') ||
        (id !== undefined && labelTargets.has(id)) ||
        (boundLabelTarget && (attributes.has('[id]') || attributes.has('[attr.id]'))) ||
        // `mat-form-field`, and any library's `*-form-field` wrapper (`sci-form-field label="..."`), renders the label itself.
        stack.some((element) => element.name === 'label' || /(^|-)form-field$/.test(element.name));
      if (!labelled) facts.unlabelledControls.push(line);
    }

    // Any named descendant names its button: `<button><span aria-label="Close">×</span></button>`.
    if (namedByAttribute(attributes) && name !== 'button') markNamed();
    const selfClosing = match[4] === '/' || VOID.has(name);
    if (!selfClosing) stack.push({ name, line, ...(name === 'button' ? { named: namedByAttribute(attributes) } : {}) });
  }
  return facts;
}
