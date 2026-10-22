import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Directory names never descended into.
 *
 * Build output, caches and dependencies hold generated code that would swamp
 * every count (one `dist` folder can double the `any` total), and none of it is
 * code the team maintains. Hidden directories are skipped by a separate rule in
 * `walk`, which is what keeps `.git`, `.angular`, `.nx` and editor folders out.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'out-tsc', 'tmp', 'bazel-out']);

/**
 * Files above this size are skipped as generated. A hand-written Angular source
 * file is far below it, while a checked-in API client or a bundled vendor file
 * is not, and parsing one can cost more than the rest of the repository.
 */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Folders whose JavaScript is someone else's: Bower and JSPM installs and
 * checked-in libraries. Only JavaScript is skipped there; a TypeScript file
 * in a `vendor` folder is still the team's code. A copy of AngularJS in one
 * of them is not lost: `scanAngularJsFile` reads its version from the
 * license header, and the file walk keeps `angular.js` files for that reason.
 */
const VENDOR_DIRECTORIES = new Set(['bower_components', 'jspm_packages', 'vendor', 'vendors']);

/** Everything `collectFiles` found, as absolute paths. */
export interface CollectedFiles {
  /** `.ts` files, without `.d.ts` declaration files. */
  typescript: string[];
  /** `.html` files, which in an Angular repository are almost all component templates. */
  html: string[];
  /**
   * `.js` files outside vendor folders (see `VENDOR_DIRECTORIES`), without
   * minified builds and without a `.ts` file of the same name next to them
   * (compiler output written beside its source). Read only for AngularJS
   * code, which is mostly plain JavaScript.
   */
  javascript: string[];
  /** Every `project.json`, which is how an Nx workspace describes its projects. */
  projectJsons: string[];
  /** Every `angular.json` below the root (not the root's own): Angular workspaces in subfolders. */
  nestedAngularJsons: string[];
}

/**
 * Walks `root` once and sorts the files an analysis needs by kind.
 *
 * One walk serves the whole run, so a large monorepo is read from disk once.
 * The result is sorted, which keeps report output stable between runs on the
 * same tree. An unreadable directory is skipped rather than failing the run,
 * since a permissions problem in one corner says nothing about the code.
 *
 * @param isIgnored The config file's `ignore` patterns as a predicate over
 *   report paths. An ignored directory is not descended into at all, which is
 *   what makes ignoring a large generated folder cheap.
 */
export function collectFiles(root: string, isIgnored?: (relativePath: string) => boolean): CollectedFiles {
  const result: CollectedFiles = { typescript: [], html: [], javascript: [], projectJsons: [], nestedAngularJsons: [] };
  walk(root, root, result, isIgnored);
  result.typescript.sort();
  result.html.sort();
  result.projectJsons.sort();
  result.nestedAngularJsons.sort();
  const compiled = new Set(result.typescript.map((path) => path.replace(/\.ts$/, '.js')));
  result.javascript = result.javascript.filter((path) => !compiled.has(path)).sort();
  return result;
}

/**
 * The recursive half of `collectFiles`. Mutates `into`.
 */
function walk(root: string, directory: string, into: CollectedFiles, isIgnored?: (relativePath: string) => boolean, inVendor = false): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (isIgnored?.(toReportPath(root, path))) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(root, path, into, isIgnored, inVendor || VENDOR_DIRECTORIES.has(entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === 'project.json') {
      into.projectJsons.push(path);
    } else if (entry.name === 'angular.json' && directory !== root) {
      into.nestedAngularJsons.push(path);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      if (isWithinSizeLimit(path)) into.typescript.push(path);
    } else if (entry.name.endsWith('.html')) {
      if (isWithinSizeLimit(path)) into.html.push(path);
    } else if (/^angular(\.min)?\.js$/.test(entry.name)) {
      // A copy of AngularJS, minified or over the size limit: kept for the version in its header.
      into.javascript.push(path);
    } else if (entry.name.endsWith('.js') && !inVendor && !/[.-]min\.js$/.test(entry.name)) {
      if (isWithinSizeLimit(path)) into.javascript.push(path);
    }
  }
}

/** False for files `MAX_FILE_BYTES` treats as generated, and for files that vanished mid-walk. */
function isWithinSizeLimit(path: string): boolean {
  try {
    return statSync(path).size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * The form every report uses for a path: relative to the analysed root, with
 * `/` separators on every platform, so a report generated on Windows reads the
 * same as one generated on macOS.
 */
export function toReportPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * True for unit-test files. Angular CLI and Nx both name them `*.spec.ts`;
 * `*.test.ts` covers Jest and Vitest setups that follow the other convention.
 */
export function isSpecFile(path: string): boolean {
  return /\.(spec|test)\.[jt]s$/.test(path);
}

/**
 * True for code that only tests run: unit specs, Protractor's
 * `*.e2e-spec.ts` and page objects, Cypress and Playwright files, mocks, and
 * whatever sits in an `e2e`, `cypress`, `test-config` or `__mocks__` folder.
 * Kept out of "application code", where a mock's `any` or a cycle between
 * test helpers would be counted against the app (an Ionic wallet's
 * `test-config/mocks-ionic.ts` was the case).
 */
export function isTestCode(path: string): boolean {
  return (
    isSpecFile(path) ||
    /[.-](e2e-spec|spec|cy|po|mock|mocks|scenario)\.[jt]s$/.test(path) ||
    /(^|\/)(e2e|e2e-tests|cypress|test-config|__mocks__|playwright)\//.test(path)
  );
}
