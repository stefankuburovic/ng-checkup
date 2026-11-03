import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import ts from 'typescript';
import { languageOfBundle, toReportPath } from './files.js';
import type { FileRef } from './types.js';

/**
 * Translation keys that resolve to no string.
 *
 * ngx-translate and Transloco both render the key itself when a lookup
 * fails, so `{{ 'orders.cannot_delete' | translate }}` against a bundle that
 * lacks it shows the user `orders.cannot_delete` where a sentence should be.
 * Neither the compiler nor a test suite sees it: the key is a string, and a
 * spec that renders the template passes either way. Only literal keys are
 * judged; a key built from data (`{{ item.state | translate }}`) resolves or
 * not depending on what the API returns.
 */

/** The translation libraries whose bundles and lookups this module understands. */
export type TranslationLibrary = 'ngx-translate' | 'transloco';

/** A literal key the code or a template looks up. */
export interface TranslationKeyUse {
  key: string;
  /** 1-based line in the file that holds it. */
  line: number;
}

/** One key that is missing in at least one language. */
export interface MissingTranslation {
  key: string;
  /** Languages whose bundle has no string under the key, sorted. */
  languages: string[];
  /** First place that looks it up. */
  file: FileRef;
  /** Number of places that look it up. */
  uses: number;
}

/** What the translations check reads; undefined in the context when there is nothing to judge. */
export interface TranslationFacts {
  library: TranslationLibrary;
  /** Languages with a bundle, sorted: `de`, `en`, `pt_BR`. */
  languages: string[];
  /** Report paths of the bundle files read. */
  bundles: string[];
  /** Distinct literal keys looked up. */
  keys: number;
  /**
   * Keys some language lacks while its bundles know the key's first segment,
   * or another language has the key: a typo, a key under the wrong namespace,
   * or a string added to one language only.
   */
  missing: MissingTranslation[];
  /**
   * Keys whose first segment no bundle of any language has. They are kept
   * apart because they are as likely to come from a library's own bundle or
   * a loader that reads the backend as to be missing.
   */
  unknownNamespace: MissingTranslation[];
}

/** A key as both libraries spell them: segments of letters, digits, `_` and `-`, joined by dots. No spaces, no interpolation. */
const KEY = String.raw`[A-Za-z0-9_][A-Za-z0-9_\-]*(?:\.[A-Za-z0-9_\-]+)*`;

/** `'a.b' | translate`, `"a.b" | transloco`, with or without arguments after the pipe. */
const PIPE = new RegExp(String.raw`(['"])(${KEY})\1\s*\|\s*(?:translate|transloco)\b`, 'g');

/** `translate="a.b"` and `[translate]="'a.b'"`, ngx-translate's directive. */
const DIRECTIVE = new RegExp(String.raw`\stranslate\s*=\s*"(${KEY})"|\[translate\]\s*=\s*"'(${KEY})'"`, 'g');

/** `t('a.b')` inside a `*transloco="let t"` block. Only read when the template has such a block without `read:`, which would prefix every key. */
const TRANSLOCO_FUNCTION = new RegExp(String.raw`\bt\(\s*(['"])(${KEY})\1`, 'g');

/** Literal keys a template looks up, with lines counted from the start of `text`. HTML comments are skipped. */
export function translationKeysInTemplate(text: string): TranslationKeyUse[] {
  const visible = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const uses: TranslationKeyUse[] = [];
  const lineAt = (offset: number): number => visible.slice(0, offset).split('\n').length;
  for (const match of visible.matchAll(PIPE)) {
    // `prefix + 'suffix' | translate` pipes the whole sum, so 'suffix' is only the end of a key built at runtime.
    if (/\+\s*$/.test(visible.slice(Math.max(0, match.index - 20), match.index))) continue;
    uses.push({ key: match[2]!, line: lineAt(match.index) });
  }
  for (const match of visible.matchAll(DIRECTIVE)) uses.push({ key: (match[1] ?? match[2])!, line: lineAt(match.index) });
  if (/\*transloco\s*=\s*"[^"]*\blet\s+t\b/.test(visible) && !/\*transloco\s*=\s*"[^"]*\bread\s*:/.test(visible)) {
    for (const match of visible.matchAll(TRANSLOCO_FUNCTION)) uses.push({ key: match[2]!, line: lineAt(match.index) });
  }
  return uses;
}

/** Methods that take a key as their first argument: ngx-translate's `instant`/`get`/`stream`, Transloco's `translate`/`selectTranslate`. */
const LOOKUP_METHODS = new Set(['instant', 'get', 'stream', 'translate', 'selectTranslate']);

/** Receivers named like a translation service: `this.translate`, `translateService`, `this.transloco`, `this.i18n`. `get` is too common a name to trust without it. */
const TRANSLATION_RECEIVER = /transl|i18n/i;

/** `marker('a.b')` from ngx-translate-extract, which marks a key for a lookup made elsewhere. */
const MARKER_FUNCTIONS = new Set(['marker', '_']);

/** Literal keys TypeScript code looks up through a translation service, or marks with `marker()`. */
export function translationKeysInCode(source: ts.SourceFile): TranslationKeyUse[] {
  const uses: TranslationKeyUse[] = [];
  const keyPattern = new RegExp(`^${KEY}$`);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      const literal = argument && ts.isStringLiteralLike(argument) && keyPattern.test(argument.text) ? argument.text : undefined;
      if (literal !== undefined) {
        const callee = node.expression;
        const isLookup = ts.isPropertyAccessExpression(callee) && LOOKUP_METHODS.has(callee.name.text) && TRANSLATION_RECEIVER.test(callee.expression.getText(source));
        const isMarker = ts.isIdentifier(callee) && MARKER_FUNCTIONS.has(callee.text);
        if (isLookup || isMarker) uses.push({ key: literal, line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

type Bundle = Record<string, unknown>;

/**
 * Merges `source` into `target`, recursing into objects both have. Deep, not
 * shallow: an app that loads a core bundle and one bundle per feature often
 * declares the same top-level namespace in several files with different
 * children, and a shallow merge silently drops all but one of them.
 */
function deepMerge(target: Bundle, source: Bundle): Bundle {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isBundle(value) && isBundle(existing)) deepMerge(existing, value);
    else target[key] = isBundle(value) ? deepMerge({}, value) : value;
  }
  return target;
}

function isBundle(value: unknown): value is Bundle {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value under a dotted key, as ngx-translate looks it up: it walks the
 * path, but also accepts a property whose own name holds a dot
 * (`"cannot_delete.header": "…"`), which real bundles rely on.
 */
function lookUp(bundle: Bundle, key: string): unknown {
  const segments = key.split('.');
  let target: unknown = bundle;
  let pending = '';
  for (const segment of segments) {
    pending = pending ? `${pending}.${segment}` : segment;
    if (isBundle(target) && pending in target) {
      target = target[pending];
      pending = '';
    }
  }
  return pending ? undefined : target;
}

/**
 * Reads every bundle and merges them per language.
 *
 * For Transloco a bundle in a subfolder of its `i18n` folder is a scope, and
 * its keys are looked up under the scope's name (`admin/en.json` answers
 * `admin.title`). ngx-translate has no scopes: an app that loads several
 * bundles merges them into one, which is what this does too. A file that is
 * not valid JSON, or not an object, is skipped.
 */
export function readTranslationBundles(paths: string[], library: TranslationLibrary): Map<string, Bundle> {
  const byLanguage = new Map<string, Bundle>();
  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!isBundle(parsed)) continue;
    const language = languageOfBundle(path);
    const scope = library === 'transloco' ? transLocoScope(path) : undefined;
    const content = scope ? { [scope]: parsed } : parsed;
    byLanguage.set(language, deepMerge(byLanguage.get(language) ?? {}, content));
  }
  return byLanguage;
}

/** The scope a Transloco bundle belongs to: its folder below the nearest `i18n`-style folder, or undefined for a root bundle. */
function transLocoScope(path: string): string | undefined {
  const folders = dirname(path).split(/[\\/]/);
  const index = folders.map((segment) => segment.toLowerCase()).lastIndexOf('i18n');
  if (index < 0 || index === folders.length - 1) return undefined;
  return folders.slice(index + 1).join('/');
}

/**
 * Judges every literal key against every language.
 *
 * @param uses Keys per report path; one key used in five places is one entry
 *   with `uses: 5`, pointing at the first place.
 * @returns Undefined when there are no bundles to judge against, which is
 *   also the case for an app whose strings come from the backend or from
 *   TypeScript files.
 */
export function judgeTranslations(root: string, library: TranslationLibrary, bundlePaths: string[], uses: Array<{ path: string; keys: TranslationKeyUse[] }>): TranslationFacts | undefined {
  const bundles = readTranslationBundles(bundlePaths, library);
  if (bundles.size === 0) return undefined;
  const languages = [...bundles.keys()].sort();

  const byKey = new Map<string, { file: FileRef; uses: number }>();
  for (const { path, keys } of uses) {
    for (const use of keys) {
      const entry = byKey.get(use.key);
      if (entry) entry.uses++;
      else byKey.set(use.key, { file: { path, line: use.line }, uses: 1 });
    }
  }

  const missing: MissingTranslation[] = [];
  const unknownNamespace: MissingTranslation[] = [];
  for (const [key, { file, uses: count }] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    const lacking = languages.filter((language) => typeof lookUp(bundles.get(language)!, key) !== 'string');
    if (lacking.length === 0) continue;
    const entry: MissingTranslation = { key, languages: lacking, file, uses: count };
    const namespace = key.split('.')[0]!;
    const known = lacking.length < languages.length || languages.some((language) => namespace in bundles.get(language)!);
    (known ? missing : unknownNamespace).push(entry);
  }
  return { library, languages, bundles: bundlePaths.map((path) => toReportPath(root, path)).sort(), keys: byKey.size, missing, unknownNamespace };
}
