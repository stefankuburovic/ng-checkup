import type { BundleStats } from '../bundle.js';
import type ts from 'typescript';
import type { PackageCompatibility } from '../compatibility.js';
import type { DeprecationIndex } from '../deprecations.js';
import type { DependencyTangle } from '../graph.js';
import type { TypingsSource } from '../typings.js';
import type { SourceFileFacts, TemplateFact } from '../scan.js';
import type { CheckResult, FileRef } from '../types.js';
import type { WorkspaceInfo } from '../workspace.js';

/**
 * Everything a check may read. Built once by `runCheckup` before any check
 * runs, so checks are pure functions of it: no check reads the disk, which is
 * what lets the tests build a context by hand.
 */
export interface AnalysisContext {
  workspace: WorkspaceInfo;
  /** Every scanned TypeScript file, specs included; each check filters what it needs. */
  sources: SourceFileFacts[];
  /** External template files and inline `template:` strings. */
  templates: TemplateFact[];
  /** Empty when no typings could be read, neither installed nor from the registry. */
  deprecations: DeprecationIndex;
  /** Where the typings behind `deprecations` came from, and which imported packages had none. */
  typings: TypingsSource;
  tangles: DependencyTangle[];
  /**
   * Report paths of the files loaded at startup: statically reachable from an
   * application entry (`main.ts`). Undefined when no build target names an
   * entry that was analysed, in which case nothing can be said about what
   * loads lazily.
   */
  eagerFiles?: Set<string>;
  /** Stats of the last `ng build --stats-json` per application. Empty when there is none. */
  bundles: BundleStats[];
  /** Installed third-party packages that depend on Angular. Empty without node_modules. */
  compatibility: PackageCompatibility[];
  /** Newest Angular major, and whether it came from the registry or the tool's bundled fallback. */
  latestAngular: { major: number; source: 'registry' | 'bundled' };
  /** Effective options of the application tsconfig, `extends` resolved. */
  appCompilerOptions: ts.CompilerOptions;
  /** `angularCompilerOptions` of the application tsconfig, merged along its `extends` chain. */
  angularCompilerOptions: Record<string, unknown>;
  maxExamples: number;
}

/** A check: a pure function from the analysis context to a graded result. */
export type Check = (context: AnalysisContext) => CheckResult;

/** Total of the line arrays stored under `keys` in each file's `calls` map. */
export function countCalls(files: SourceFileFacts[], ...keys: string[]): number {
  let total = 0;
  for (const file of files) for (const key of keys) total += file.calls.get(key)?.length ?? 0;
  return total;
}

/** The first call site of any of `keys` in each file that has one, for report examples. */
export function callSites(files: SourceFileFacts[], ...keys: string[]): FileRef[] {
  const refs: FileRef[] = [];
  for (const file of files) {
    const lines = keys.flatMap((key) => file.calls.get(key) ?? []);
    if (lines.length > 0) refs.push({ path: file.path, line: Math.min(...lines) });
  }
  return refs;
}

/** Files that import any of `modules`, with the line of the first such import. */
export function filesImporting(files: SourceFileFacts[], modules: string[]): FileRef[] {
  const refs: FileRef[] = [];
  for (const file of files) {
    const first = file.imports.find((fact) => !fact.dynamic && modules.includes(fact.specifier));
    if (first) refs.push({ path: file.path, line: first.line });
  }
  return refs;
}

/** Whole percentage, 0 when the denominator is 0, so an empty codebase never reports NaN. */
export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/** Thousands separated by a thin space, which reads in every locale a report goes to. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, ' ');
}

/** `1 file` / `3 files`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** "uses" for one, "use" for several: the verb that agrees with a count. */
export function verb(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** Non-spec files: application code, as opposed to tests. */
export function applicationFiles(context: AnalysisContext): SourceFileFacts[] {
  return context.sources.filter((file) => !file.isSpec);
}

/** Spec files only. */
export function specFiles(context: AnalysisContext): SourceFileFacts[] {
  return context.sources.filter((file) => file.isSpec);
}
