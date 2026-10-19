import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { asRecord, readJson } from './workspace.js';

/** What a `@deprecated` tag says. */
export interface DeprecationInfo {
  /** The version the tag names, such as `20.0` or `20.2`, when the tag starts with one. */
  since?: string;
  /** The tag's text after the version, trimmed. Can be empty: some tags give no reason. */
  message: string;
}

/** The deprecated exports of one import path, such as `@angular/common` or `@angular/common/http`. */
export interface EntryDeprecations {
  /** Exported name to its deprecation. */
  symbols: Map<string, DeprecationInfo>;
  /** `Owner.member` to its deprecation, for enum members and static class members. */
  members: Map<string, DeprecationInfo>;
}

/** Import path to its deprecated exports. */
export type DeprecationIndex = Map<string, EntryDeprecations>;

/**
 * Package scopes whose type definitions are indexed. Both publish their public
 * API as bundled `.d.ts` files with `@deprecated` tags kept, and both are where
 * an Angular upgrade breaks things.
 */
const INDEXED_SCOPES = ['@angular', '@ngrx'];

/**
 * Builds the deprecation index from the analysed repository's own `node_modules`.
 *
 * Reading the installed `.d.ts` files rather than shipping a hand-kept list is
 * what keeps the report truthful: it names exactly what the installed version
 * marks, with the version and reason Angular itself wrote. A hand-kept list
 * drifts the moment a release adds or lifts a deprecation (Angular 22, for
 * example, deprecates `ChangeDetectionStrategy.Default` in favour of `Eager`,
 * because OnPush became the default).
 *
 * Returns an empty index when dependencies are not installed; the deprecations
 * check then grades `info` and says why.
 */
export function buildDeprecationIndex(root: string): DeprecationIndex {
  const index: DeprecationIndex = new Map();
  for (const scope of INDEXED_SCOPES) {
    const scopeDirectory = join(root, 'node_modules', scope);
    if (!existsSync(scopeDirectory)) continue;
    for (const packageName of safeReaddir(scopeDirectory)) {
      const packageDirectory = join(scopeDirectory, packageName);
      for (const [entry, typesPath] of typeEntriesOf(packageDirectory)) {
        const specifier = entry === '.' ? `${scope}/${packageName}` : `${scope}/${packageName}/${entry.slice(2)}`;
        const deprecations = new DtsReader().exportsOf(typesPath);
        if (deprecations.symbols.size > 0 || deprecations.members.size > 0) index.set(specifier, deprecations);
      }
    }
  }
  return index;
}

/**
 * Each public entry point of a package with its type definition file.
 *
 * Reads `exports` (Angular 13+ and every NgRx release that matters), skipping
 * wildcard and non-code entries. A package without an `exports` map uses the
 * older layout, where every secondary entry point (`@angular/core/testing`,
 * `@angular/common/http`) is a folder with its own `package.json` naming its
 * `typings`; those are found by `legacyEntriesOf`.
 */
function typeEntriesOf(packageDirectory: string): Array<[string, string]> {
  const packageJson = readJson(join(packageDirectory, 'package.json'));
  if (!packageJson) return [];
  const entries: Array<[string, string]> = [];
  for (const [entry, target] of Object.entries(asRecord(packageJson['exports']))) {
    if (entry.includes('*') || entry === './package.json' || !entry.startsWith('.')) continue;
    const types = asRecord(target)['types'] ?? asRecord(target)['typings'];
    if (typeof types === 'string' && types.endsWith('.d.ts')) entries.push([entry, resolve(packageDirectory, types)]);
  }
  if (entries.length === 0) entries.push(...legacyEntriesOf(packageDirectory, '.', 0));
  return entries.filter(([, path]) => existsSync(path));
}

/**
 * Folders that never hold an entry point in the pre-`exports` layout: build
 * formats, schematics and nested dependencies. Skipping them keeps the walk to
 * a few dozen directories per package.
 */
const NON_ENTRY_DIRECTORIES = new Set(['node_modules', 'schematics', 'bundles', 'esm5', 'esm2015', 'esm2020', 'fesm5', 'fesm2015', 'fesm2020', 'src', 'locales', 'third_party', 'migrations']);

/**
 * Entry points of a package in the pre-`exports` layout (Angular 12 and
 * older): this folder's `package.json` `typings`, then each subfolder's, up to
 * three levels deep (`@angular/common/http/testing` is the deepest Angular has).
 *
 * @param entry The entry as an `exports` key would spell it: `.`, `./testing`.
 */
function legacyEntriesOf(directory: string, entry: string, depth: number): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const packageJson = readJson(join(directory, 'package.json'));
  const types = packageJson?.['types'] ?? packageJson?.['typings'];
  if (typeof types === 'string') entries.push([entry, resolve(directory, types)]);
  if (depth >= 3) return entries;
  for (const name of safeReaddir(directory)) {
    if (NON_ENTRY_DIRECTORIES.has(name) || name.startsWith('.')) continue;
    const child = join(directory, name);
    if (!existsSync(join(child, 'package.json'))) continue;
    entries.push(...legacyEntriesOf(child, `${entry}/${name}`, depth + 1));
  }
  return entries;
}

/**
 * Reads deprecations out of a bundle of `.d.ts` files, following re-exports
 * between them.
 *
 * Angular 20+ ships each entry point as a thin `.d.ts` that re-exports from
 * shared chunks, often under a different name (`export { a as NgIf } from
 * './_common_module-chunk.js'`), so the deprecation sits on a declaration in
 * one file and the public name lives in another. One reader instance memoises
 * per file, which matters because many entry points share the same chunks.
 */
class DtsReader {
  private readonly cache = new Map<string, EntryDeprecations>();

  /** The deprecated names `path` exports, under the names it exports them as. */
  exportsOf(path: string, depth = 0): EntryDeprecations {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const result: EntryDeprecations = { symbols: new Map(), members: new Map() };
    // Set before recursing, so a re-export cycle between chunks ends here instead of overflowing.
    this.cache.set(path, result);
    if (depth > 8 || !existsSync(path)) return result;

    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const local = localDeprecations(source);
    /** Names imported from sibling chunks, which a later `export { x }` may re-export. */
    const importedFrom = new Map<string, { file: string; name: string }>();

    const exportAs = (from: EntryDeprecations, original: string, exported: string): void => {
      const symbol = from.symbols.get(original);
      if (symbol) result.symbols.set(exported, symbol);
      for (const [member, info] of from.members) {
        if (member.startsWith(`${original}.`)) result.members.set(`${exported}${member.slice(original.length)}`, info);
      }
    };

    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
        const file = siblingDts(path, statement.moduleSpecifier.text);
        const named = statement.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) importedFrom.set(element.name.text, { file, name: (element.propertyName ?? element.name).text });
        }
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;
        const target = moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier) && moduleSpecifier.text.startsWith('.') ? this.exportsOf(siblingDts(path, moduleSpecifier.text), depth + 1) : undefined;
        const clause = statement.exportClause;
        if (!clause) {
          // `export * from './x.js'`: everything x exports, under the same names.
          if (target) {
            for (const [name, info] of target.symbols) result.symbols.set(name, info);
            for (const [name, info] of target.members) result.members.set(name, info);
          }
          continue;
        }
        if (!ts.isNamedExports(clause)) continue;
        for (const element of clause.elements) {
          const original = (element.propertyName ?? element.name).text;
          const exported = element.name.text;
          if (target) {
            exportAs(target, original, exported);
          } else if (local.symbols.has(original) || [...local.members.keys()].some((key) => key.startsWith(`${original}.`))) {
            exportAs(local, original, exported);
          } else {
            const imported = importedFrom.get(original);
            if (imported) exportAs(this.exportsOf(imported.file, depth + 1), imported.name, exported);
          }
        }
        continue;
      }
      // `export declare class X` and friends, exported under their own name.
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const name of declaredNames(statement)) exportAs(local, name, name);
      }
    }
    return result;
  }
}

/**
 * Deprecated top-level declarations of one file, by their local name, plus
 * deprecated enum members and static class members.
 *
 * A name counts as deprecated only when **every** declaration of it carries the
 * tag. Overloaded functions often deprecate one signature (an old parameter
 * shape) while the function itself is fine, and an interface merged with a
 * const (how Angular declares decorators) can deprecate one half. Flagging those
 * would accuse every caller of using a deprecated API.
 */
function localDeprecations(source: ts.SourceFile): EntryDeprecations {
  const declarations = new Map<string, Array<DeprecationInfo | undefined>>();
  const members = new Map<string, DeprecationInfo>();
  for (const statement of source.statements) {
    const info = deprecationOf(statement);
    for (const name of declaredNames(statement)) {
      const list = declarations.get(name) ?? [];
      list.push(info);
      declarations.set(name, list);
    }
    if (ts.isEnumDeclaration(statement)) {
      for (const member of statement.members) {
        const memberInfo = deprecationOf(member);
        if (memberInfo && ts.isIdentifier(member.name)) members.set(`${statement.name.text}.${member.name.text}`, memberInfo);
      }
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const byMember = new Map<string, Array<DeprecationInfo | undefined>>();
      for (const member of statement.members) {
        const isStatic = ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
        if (!isStatic || !member.name || !ts.isIdentifier(member.name)) continue;
        const list = byMember.get(member.name.text) ?? [];
        list.push(deprecationOf(member));
        byMember.set(member.name.text, list);
      }
      for (const [name, list] of byMember) {
        const first = list[0];
        if (first && list.every(Boolean)) members.set(`${statement.name.text}.${name}`, first);
      }
    }
  }
  const symbols = new Map<string, DeprecationInfo>();
  for (const [name, list] of declarations) {
    // `ɵ` marks Angular's private API. Its deprecations are internal bookkeeping, not upgrade advice.
    if (name.startsWith('ɵ')) continue;
    const first = list[0];
    if (first && list.every(Boolean)) symbols.set(name, first);
  }
  return { symbols, members };
}

/** The names a top-level statement declares. Empty for anything that declares none. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []));
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  return [];
}

/** The node's `@deprecated` tag, parsed, or undefined when it has none. */
function deprecationOf(node: ts.Node): DeprecationInfo | undefined {
  const tag = ts.getJSDocDeprecatedTag(node);
  if (!tag) return undefined;
  const text = (ts.getTextOfJSDocComment(tag.comment) ?? '').replace(/\s+/g, ' ').trim();
  // Angular writes the version three ways: `20.0 Use …`, `from v19.0.0, use …`, `since v17`.
  const version = /^(?:(?:from|since|in)\s+)?v?(\d+(?:\.\d+){0,2})\b[:.,]?\s*/i.exec(text);
  return version ? { since: version[1], message: text.slice(version[0].length) } : { since: undefined, message: text };
}

/** `./_chunk.js` next to `from`, as the `.d.ts` that types it. */
function siblingDts(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  if (base.endsWith('.d.ts')) return base;
  if (base.endsWith('.js') || base.endsWith('.mjs')) return base.replace(/\.m?js$/, '.d.ts');
  return existsSync(`${base}.d.ts`) ? `${base}.d.ts` : join(base, 'index.d.ts');
}

/** `readdirSync` that treats an unreadable directory as empty. */
function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
