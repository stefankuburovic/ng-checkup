import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { toReportPath } from './files.js';
import type { FileRef } from './types.js';
import { asRecord, type WorkspaceInfo } from './workspace.js';

/**
 * Angular's built-in i18n: the translation files `angular.json` names, judged
 * against the source file `ng extract-i18n` writes. An id without `@@` is a
 * hash of the message, so the source file is what can be compared, and not the
 * code; it may be out of date, which is why every finding says so.
 *
 * XLIFF is read by a small scanner rather than an XML parser, to keep the
 * tool's dependencies as they are. It reads what the Angular tools and common
 * translation tools write. A file it cannot read is listed and judged no
 * further, since an unreadable file must not look like an empty one.
 */

/** One message of a translation or source file. */
export interface I18nUnit {
  id: string;
  /** 1-based; absent for JSON and ARB, whose lines nobody edits by hand. */
  line?: number;
  /** No text to show: no target, or an empty one. */
  empty: boolean;
  /**
   * Marked as not done (`new` or `needs-translation` in XLIFF 1.2, `initial` in
   * 2.0) and the target still reads as the source. A different text under such a
   * state was translated by someone who left the state as it was, so it is fine.
   */
  needsTranslation: boolean;
}

/** One message of one locale that needs attention. */
export interface I18nIssue {
  id: string;
  locale: string;
  file: FileRef;
}

/** What the i18n part of the translations check reads. */
export interface I18nFacts {
  /** The source files read, as report paths. Empty when none was found, and then nothing can be missing or obsolete. */
  sourceFiles: string[];
  messages: number;
  /** The locales with a translation file, sorted. */
  locales: string[];
  /** In the source file, and in the locale without text. */
  missing: I18nIssue[];
  /** Has a state that says it is not done. */
  needsTranslation: I18nIssue[];
  /** In the locale, and no longer in the source file. */
  obsolete: I18nIssue[];
  /** Named by the workspace, and missing from disk or in no format this reads. */
  unreadable: string[];
}

const NOT_DONE_STATES = new Set(['new', 'needs-translation', 'initial']);

const decode = (text: string): string => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decode(match[1] ?? match[2] ?? '') : undefined;
};
const blanked = (text: string): string => text.replace(/[^\n]/g, ' ');

/** XLIFF 1.2 (`trans-unit`) or 2.0 (`unit`, with `segment`). Undefined for anything else. */
function parseXliff(raw: string): I18nUnit[] | undefined {
  // Comments and alternative translations hold targets that do not count. Blanked, so lines stay right.
  const text = raw.replace(/<!--[\s\S]*?-->/g, blanked).replace(/<alt-trans\b[\s\S]*?<\/alt-trans>/g, blanked);
  if (!/<xliff\b/.test(text)) return undefined;
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const units: I18nUnit[] = [];
  const isEmpty = (target: RegExpExecArray | null): boolean => target === null || (target[2] ?? '').replace(/<!\[CDATA\[\s*\]\]>/g, '').trim() === '';
  const TARGET = /<target\b([^>]*?)(?:\/>|>([\s\S]*?)<\/target>)/;
  const SOURCE = /<source\b[^>]*?(?:\/>|>([\s\S]*?)<\/source>)/;
  const flat = (markup: string | undefined): string => (markup ?? '').replace(/\s+/g, ' ').trim();
  const sameAsSource = (body: string, target: RegExpExecArray | null): boolean => flat(SOURCE.exec(body)?.[1]) === flat(target?.[2]);

  for (const match of text.matchAll(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g)) {
    const id = attribute(match[1]!, 'id');
    if (id === undefined || attribute(match[1]!, 'translate') === 'no') continue;
    const target = TARGET.exec(match[2]!);
    const state = target ? attribute(target[1]!, 'state') : undefined;
    units.push({ id, line: lineAt(match.index), empty: isEmpty(target), needsTranslation: state !== undefined && NOT_DONE_STATES.has(state) && sameAsSource(match[2]!, target) });
  }
  for (const match of text.matchAll(/<unit\b([^>]*)>([\s\S]*?)<\/unit>/g)) {
    const id = attribute(match[1]!, 'id');
    if (id === undefined || attribute(match[1]!, 'translate') === 'no') continue;
    const segments = [...match[2]!.matchAll(/<segment\b([^>]*)>([\s\S]*?)<\/segment>/g)];
    if (segments.length === 0) continue;
    units.push({
      id,
      line: lineAt(match.index),
      empty: segments.some((segment) => isEmpty(TARGET.exec(segment[2]!))),
      needsTranslation: segments.some((segment) => {
        const state = attribute(segment[1]!, 'state');
        return state !== undefined && NOT_DONE_STATES.has(state) && sameAsSource(segment[2]!, TARGET.exec(segment[2]!));
      }),
    });
  }
  return units;
}

/** Angular's JSON (`{ "locale": "de", "translations": { id: text } }`) or ARB (`{ id: text, "@id": {...} }`). Undefined for anything else. */
function parseJsonMessages(raw: string, isArb: boolean): I18nUnit[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const entries = isArb ? Object.entries(record).filter(([key]) => !key.startsWith('@')) : typeof record['translations'] === 'object' && record['translations'] !== null ? Object.entries(asRecord(record['translations'])) : undefined;
  if (!entries) return undefined;
  return entries.map(([id, value]) => ({ id, empty: typeof value !== 'string' || value.trim() === '', needsTranslation: false }));
}

/** The messages of a translation file, by its extension. Undefined when it holds no format this reads. */
export function parseMessages(text: string, path: string): I18nUnit[] | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === '.xlf' || extension === '.xlf2' || extension === '.xliff') return parseXliff(text);
  if (extension === '.json') return parseJsonMessages(text, false);
  if (extension === '.arb') return parseJsonMessages(text, true);
  return undefined;
}

/** The translation files of `i18n.locales`: a path, a list of paths, or an object with `translation`. */
function localeFiles(value: unknown): string[] {
  const entry = typeof value === 'object' && value !== null && !Array.isArray(value) ? asRecord(value)['translation'] : value;
  return (Array.isArray(entry) ? entry : [entry]).filter((path): path is string => typeof path === 'string');
}

/**
 * The source file: what `extract-i18n` is told to write, else `messages.<ext>`
 * beside a translation file (`messages.de.xlf` gives `messages.xlf`), else
 * the default places.
 */
function sourceFileOf(root: string, target: Record<string, unknown> | undefined, sourceRoot: string, translations: string[]): string | undefined {
  const candidates: string[] = [];
  const outputPath = target?.['outputPath'];
  const outFile = target?.['outFile'];
  if (typeof outputPath === 'string' || typeof outFile === 'string') {
    const extension = target?.['format'] === 'json' || target?.['format'] === 'legacy-migrate' ? '.json' : target?.['format'] === 'arb' ? '.arb' : '.xlf';
    candidates.push(join(typeof outputPath === 'string' ? outputPath : sourceRoot, typeof outFile === 'string' ? outFile : `messages${extension}`));
  }
  for (const path of translations) {
    const name = basename(path);
    const parts = name.split('.');
    if (parts.length >= 3) candidates.push(join(dirname(path), [...parts.slice(0, -2), parts[parts.length - 1]].join('.')));
    candidates.push(join(dirname(path), `messages${extname(path)}`));
  }
  candidates.push(join(sourceRoot, 'locale', 'messages.xlf'), join(sourceRoot, 'messages.xlf'), 'messages.xlf');
  const translated = new Set(translations.map((path) => resolve(root, path)));
  return candidates.map((path) => resolve(root, path)).find((path) => !translated.has(path) && existsSync(path));
}

/**
 * Reads every project's `i18n` block. Undefined when no project has a locale,
 * which is every app on ngx-translate or Transloco, and every app in one language.
 */
export function readI18n(root: string, workspace: WorkspaceInfo): I18nFacts | undefined {
  const facts: I18nFacts = { sourceFiles: [], messages: 0, locales: [], missing: [], needsTranslation: [], obsolete: [], unreadable: [] };
  const locales = new Set<string>();
  let any = false;
  for (const project of workspace.projects) {
    const entries = Object.entries(asRecord(asRecord(project.i18n)['locales']));
    if (entries.length === 0) continue;
    any = true;
    const extract = workspace.targets.find((target) => target.project === project.name && target.target === 'extract-i18n')?.options;
    const allFiles = entries.flatMap(([, value]) => localeFiles(value));
    const sourcePath = sourceFileOf(workspace.root, extract, project.sourceRoot ?? project.root, allFiles);
    const read = (absolute: string): I18nUnit[] | undefined => {
      try {
        return parseMessages(readFileSync(absolute, 'utf8'), absolute);
      } catch {
        return undefined;
      }
    };
    const sourceUnits = sourcePath ? read(sourcePath) : undefined;
    if (sourcePath && !sourceUnits) facts.unreadable.push(toReportPath(root, sourcePath));
    const sourceIds = sourceUnits ? new Set(sourceUnits.map((unit) => unit.id)) : undefined;
    if (sourcePath && sourceUnits) {
      facts.sourceFiles.push(toReportPath(root, sourcePath));
      facts.messages += sourceIds!.size;
    }

    for (const [locale, value] of entries) {
      const units = new Map<string, { unit: I18nUnit; path: string }>();
      for (const file of localeFiles(value)) {
        const absolute = resolve(workspace.root, file);
        const parsed = existsSync(absolute) ? read(absolute) : undefined;
        if (!parsed) {
          facts.unreadable.push(toReportPath(root, absolute));
          continue;
        }
        // A later file wins, as Angular merges them.
        for (const unit of parsed) units.set(unit.id, { unit, path: toReportPath(root, absolute) });
      }
      if (units.size === 0 && localeFiles(value).length > 0 && !sourceIds) continue;
      locales.add(locale);
      const firstFile = localeFiles(value)[0];
      if (firstFile === undefined) continue;
      const defaultRef: FileRef = { path: toReportPath(root, resolve(workspace.root, firstFile)) };
      for (const id of sourceIds ?? []) {
        const found = units.get(id);
        if (!found) facts.missing.push({ id, locale, file: defaultRef });
        else if (found.unit.empty) facts.missing.push({ id, locale, file: { path: found.path, ...(found.unit.line !== undefined ? { line: found.unit.line } : {}) } });
      }
      for (const [id, { unit, path }] of units) {
        const file: FileRef = { path, ...(unit.line !== undefined ? { line: unit.line } : {}) };
        if (sourceIds && !sourceIds.has(id)) facts.obsolete.push({ id, locale, file });
        else if (unit.needsTranslation && !unit.empty) facts.needsTranslation.push({ id, locale, file });
      }
    }
  }
  if (!any) return undefined;
  facts.locales = [...locales].sort();
  return facts;
}
