import { ATTRIBUTE, TAG } from './accessibility.js';
import { withoutHtmlComments } from './template-text.js';

/**
 * What a template makes change detection do over and over: loops that cannot
 * follow their items, and functions called from bindings.
 *
 * Read from the template text alone, so that a file's facts can be cached. A
 * call here is only a name: `count()` is usually a signal, so the components
 * check keeps a call only when the class that owns the template declares a
 * method of that name, and it keeps a loop only when the collection is not a
 * constant of that class. A template no class owns says nothing.
 */

/** A loop and the expression it loops over, as written. */
export interface TemplateLoop {
  line: number;
  collection: string;
}

/** A call of a bare name (`total()`, `this.total()`) in a binding, not in an event handler or a `track`. */
export interface TemplateCall {
  name: string;
  line: number;
}

/** One template's facts, as 1-based lines. */
export interface TemplateSpeedFacts {
  /** `*ngFor` or `[ngForOf]` with no `trackBy`. A literal array is left out: it never changes. */
  untrackedLoops: TemplateLoop[];
  /** `@for` with `track $index`, or the variable it was renamed to. A literal array is left out. */
  indexTrackedLoops: TemplateLoop[];
  /** Bare calls in interpolations, property bindings, structural directives and block conditions. */
  calls: TemplateCall[];
}

/** A root call, `this.` allowed: `a.b()` and `a?.b()` are calls on something the class may not own. */
const CALL = /(?<![\w$]|\.\s*)(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
/** The blocks with an expression worth reading. `@defer` is left out: `on timer(500ms)` is syntax, not a call. */
const BLOCK = /(?<![\w.$])@(if|else\s+if|for|switch|case)\s*\(/g;
const LET_BLOCK = /(?<![\w.$])@let\s+([A-Za-z_$][\w$]*)\s*=/g;

/** String contents blanked, length kept, so a call inside a string is not one and offsets stay right. */
function withoutStrings(expression: string): string {
  return expression.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (literal) => `${literal[0]}${' '.repeat(literal.length - 2)}${literal[0]}`);
}

/** Offset of the `)` that closes the `(` before `from`, skipping strings; undefined when it is never closed. */
function closingParen(text: string, from: number): number | undefined {
  let depth = 1;
  let quote: string | undefined;
  for (let index = from; index < text.length; index++) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return undefined;
}

/** Reads one template's facts. */
export function templateSpeedOf(template: string): TemplateSpeedFacts {
  const text = withoutHtmlComments(template);
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const facts: TemplateSpeedFacts = { untrackedLoops: [], indexTrackedLoops: [], calls: [] };
  // Template variables shadow the class, wherever in the template they are declared: an `item()` might be either, so it is not judged.
  const locals = new Set<string>();

  const readCalls = (expression: string, offset: number): void => {
    for (const match of withoutStrings(expression).matchAll(CALL)) {
      const name = match[1]!;
      if (name !== '$any') facts.calls.push({ name, line: lineAt(offset + match.index + match[0].indexOf(name)) });
    }
  };
  const readLocals = (microsyntax: string): void => {
    for (const match of withoutStrings(microsyntax).matchAll(/\b(?:let|as)\s+([A-Za-z_$][\w$]*)/g)) locals.add(match[1]!);
  };

  for (const tag of text.matchAll(TAG)) {
    if (tag[1]) continue;
    const start = tag.index + 1 + tag[2]!.length;
    const attributes = [...(tag[3] ?? '').matchAll(ATTRIBUTE)].map((match) => {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      const quoted = match[4] === undefined && (match[2] !== undefined || match[3] !== undefined);
      return { name: match[1]!, value, offset: start + match.index + match[0].length - value.length - (quoted ? 1 : 0) };
    });
    for (const { name, value, offset } of attributes) {
      if (name.startsWith('#')) locals.add(name.slice(1));
      else if (name.startsWith('let-')) locals.add(name.slice(4));
      else if (name === '*ngFor') {
        readLocals(value);
        const masked = withoutStrings(value);
        const of = /\bof\s+/.exec(masked);
        if (!of) continue;
        const from = of.index + of[0].length;
        const length = masked.slice(from).search(/\s*(?:[;,]|\b(?:trackBy|let|index|first|last|even|odd|as)\b|$)/);
        const collection = value.slice(from, from + length);
        readCalls(collection, offset + from);
        if (!/\btrackBy\b/.test(masked) && !collection.startsWith('[')) facts.untrackedLoops.push({ line: lineAt(offset), collection });
      } else if (name === '[ngForOf]') {
        readCalls(value, offset);
        if (!attributes.some((other) => other.name === '[ngForTrackBy]' || other.name === 'ngForTrackBy') && !value.trim().startsWith('[')) facts.untrackedLoops.push({ line: lineAt(offset), collection: value.trim() });
      } else if (name.startsWith('*')) {
        readLocals(value);
        readCalls(value, offset);
      } else if ((name.startsWith('[') && !name.startsWith('[(')) || name.startsWith('bind-')) {
        readCalls(value, offset);
      }
    }
  }

  // Interpolations, in text and in attribute values alike.
  for (const match of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) readCalls(match[1]!, match.index + 2);

  for (const match of text.matchAll(BLOCK)) {
    const from = match.index + match[0].length;
    const to = closingParen(text, from);
    if (to === undefined) continue;
    const expression = text.slice(from, to);
    if (match[1] !== 'for') {
      readLocals(expression);
      readCalls(expression, from);
      continue;
    }
    const [head = '', ...clauses] = withoutStrings(expression).split(';');
    const loop = /^\s*([A-Za-z_$][\w$]*)\s+of\s+/.exec(head);
    if (!loop) continue;
    locals.add(loop[1]!);
    const collectionStart = loop[0].length;
    const collection = expression.slice(collectionStart, head.length).trim();
    readCalls(expression.slice(collectionStart, head.length), from + collectionStart);
    const renamed = clauses.flatMap((clause) => (/^\s*let\b/.test(clause) ? [...clause.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\$index\b/g)].map((entry) => entry[1]!) : []));
    for (const clause of clauses) if (/^\s*let\b/.test(clause)) for (const entry of clause.matchAll(/([A-Za-z_$][\w$]*)\s*=/g)) locals.add(entry[1]!);
    const track = clauses.map((clause) => /^\s*track\s+([\s\S]*?)\s*$/.exec(clause)?.[1]).find((value) => value !== undefined);
    if (track !== undefined && (track === '$index' || renamed.includes(track)) && !collection.startsWith('[')) facts.indexTrackedLoops.push({ line: lineAt(match.index), collection });
  }

  for (const match of text.matchAll(LET_BLOCK)) {
    locals.add(match[1]!);
    const from = match.index + match[0].length;
    const to = withoutStrings(text.slice(from)).indexOf(';');
    if (to >= 0) readCalls(text.slice(from, from + to), from);
  }

  facts.calls = facts.calls.filter((call) => !locals.has(call.name));
  return facts;
}
