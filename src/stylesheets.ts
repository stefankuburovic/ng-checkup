import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { toReportPath } from './files.js';

/**
 * Colour literals written outside the design tokens.
 *
 * A theme (dark mode, a brand per customer, high contrast) works by changing
 * the tokens: CSS custom properties, SCSS or Less variables. A colour written
 * straight into a rule (`color: #fff`, `background: rgba(0, 0, 0, .1)`,
 * `border-color: white`) does not change with them, and in the other theme
 * shows up as a white box or black text on a dark panel. The build is green
 * and the default theme looks right, so nothing else notices.
 *
 * What counts as a token is read from the syntax, not from a list: the value
 * of a custom property (`--brand: #0b5`) or of a preprocessor variable
 * (`$brand: #0b5`, `@brand: #0b5`) defines one, wherever it sits, and a file
 * whose name says it holds them (`_tokens.scss`, `variables.less`,
 * `theme.css`, `palette.scss`, `colors.scss`) is skipped whole.
 */

/** One stylesheet's colour literals. */
export interface StylesheetFact {
  path: string;
  /** 1-based lines of every colour literal in a declaration that is not a token definition. */
  colorLines: number[];
}

/** The named colours people actually write; the full CSS list would also match words such as `tan` in a class name. */
const NAMED = ['white', 'black', 'red', 'green', 'blue', 'orange', 'yellow', 'grey', 'gray', 'lightgrey', 'lightgray', 'darkgrey', 'darkgray', 'whitesmoke', 'silver', 'gold', 'purple', 'pink', 'navy', 'teal', 'lime', 'maroon', 'cyan', 'magenta', 'brown', 'darkred', 'darkgreen', 'lightblue', 'lightgreen', 'gainsboro', 'dimgray', 'dimgrey'];

/** `#fff`, `#ffffff80`, `rgb(`, `rgba(`, `hsl(`, `hsla(` followed by a number, and the named colours as whole words. */
const LITERAL = new RegExp(String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(\s*[\d.]|(?<![\w$.#@-])(?:${NAMED.join('|')})(?![\w-])`, 'gi');

/** Properties that take a colour; `transition: color .2s` names one without setting it. */
const COLOR_PROPERTY = /color|background|border|outline|fill|stroke|shadow|caret|decoration|column-rule/i;

/** `property: value` up to `;`, `}` or the end of the line, with what precedes it so a selector is not read as one. */
const DECLARATION = /(?:^|[;{}])\s*(--[\w-]+|\$[\w-]+|@[\w-]+|-?[a-zA-Z][\w-]*)\s*:\s*([^;{}\n]*)/gm;

/** File names that hold the tokens themselves. */
const TOKEN_FILE = /(^|[._-])(tokens?|variables?|vars|theme|themes|palette|colou?rs?)(\.[\w-]+)*\.(s?css|less|sass)$/i;

/** Blanks out comments, keeping newlines so lines stay right. `//` comments only outside a `url(...)` and a string. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
}

/** Colour literals in declarations of a stylesheet's text, as 1-based lines. Token definitions, `url(...)` values and transitions are left out. */
export function colorLinesIn(text: string): number[] {
  const clean = withoutComments(text);
  const lines: number[] = [];
  for (const match of clean.matchAll(DECLARATION)) {
    const [whole, property, value] = match as unknown as [string, string, string];
    if (/^(--|\$|@)/.test(property)) continue;
    if (!COLOR_PROPERTY.test(property) || /^(transition|animation|will-change)/i.test(property) || /url\(/i.test(value)) continue;
    const valueStart = match.index + whole.indexOf(value, whole.indexOf(':'));
    for (const literal of value.matchAll(LITERAL)) lines.push(clean.slice(0, valueStart + literal.index).split('\n').length);
  }
  return lines;
}

/** Colour literals in a template's `style="..."` attributes and `[style.x]="'...'"` bindings, as 1-based lines. */
export function colorLinesInTemplate(text: string): number[] {
  const lines: number[] = [];
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  for (const match of text.matchAll(/\sstyle\s*=\s*"([^"]*)"/g)) {
    const start = match.index + match[0].indexOf(match[1]!);
    for (const line of colorLinesIn(match[1]!)) lines.push(lineAt(start) + line - 1);
  }
  for (const match of text.matchAll(/\[style\.([\w-]+)\]\s*=\s*"'([^'"]*)'"/g)) {
    if (COLOR_PROPERTY.test(match[1]!) && new RegExp(LITERAL.source, 'i').test(match[2]!)) lines.push(lineAt(match.index));
  }
  return lines;
}

/** True for a stylesheet that defines the tokens (see `TOKEN_FILE`), which is skipped whole. */
export function isTokenFile(path: string): boolean {
  return TOKEN_FILE.test(basename(path));
}

/** Scans one stylesheet. A token file gives no lines. */
export function scanStylesheetFile(root: string, absolutePath: string): StylesheetFact {
  const path = toReportPath(root, absolutePath);
  return { path, colorLines: isTokenFile(path) ? [] : colorLinesIn(readFileSync(absolutePath, 'utf8')) };
}
