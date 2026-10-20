import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { changeDetectionCheck } from './checks/change-detection.js';
import { circularDepsCheck } from './checks/circular-deps.js';
import { componentsCheck } from './checks/components.js';
import type { AnalysisContext, Check } from './checks/context.js';
import { deprecatedApisCheck } from './checks/deprecated-apis.js';
import { stateCheck } from './checks/state.js';
import { testingCheck } from './checks/testing.js';
import { typeSafetyCheck } from './checks/type-safety.js';
import { versionCheck } from './checks/version.js';
import { buildDeprecationIndex } from './deprecations.js';
import { ignoreMatcher } from './config.js';
import { collectFiles } from './files.js';
import { findTangles, readCompilerOptions } from './graph.js';
import { buildPlan } from './plan.js';
import { scanSourceFile, scanTemplateFile } from './scan.js';
import type { CheckupOptions, Report } from './types.js';
import { asRecord, majorOf, readJson, readWorkspace } from './workspace.js';

export type * from './types.js';
// The renderers and the score are public so a script can turn a report from
// `runCheckup` into the same HTML or Markdown the CLI writes, e.g. to post it
// as a pull-request comment.
export { renderHtml } from './report/html.js';
export { renderMarkdown } from './report/markdown.js';
export { overallScore, topPriorities } from './report/summary.js';
export { CONFIG_FILE, loadConfig, type CheckupConfig } from './config.js';
export { buildPlan, type PlanItem, type PlanRequirement, type UpgradePlan, type UpgradeStep } from './plan.js';
export { ANGULAR_VERSIONS, type AngularVersionInfo } from './angular-versions.js';
export {
  BASELINE_FILE,
  baselineIncreases,
  compareWithBaseline,
  createBaseline,
  readBaseline,
  serializeBaseline,
  type Baseline,
  type BaselineComparison,
  type MeasureDelta,
} from './baseline.js';
export { planInit, type InitChange, type InitOptions, type InitPlan } from './init.js';

/**
 * The newest Angular major this release of the tool knows about. Used only
 * when the registry cannot be reached or `--offline` is set, and the report
 * says so next to the number, because it goes stale with every Angular release.
 */
export const BUNDLED_LATEST_ANGULAR_MAJOR = 22;

/**
 * The checks in report order: the upgrade blockers first (version,
 * deprecations), then the modernisation areas, then the structural ones.
 */
export const CHECKS: Check[] = [versionCheck, deprecatedApisCheck, changeDetectionCheck, componentsCheck, stateCheck, testingCheck, typeSafetyCheck, circularDepsCheck];

/** This package's own name and version, read from its package.json at runtime so the two never drift. */
export const TOOL = readToolInfo();

/**
 * Analyses the Angular codebase at `root` and returns the full report.
 *
 * Reads the disk and, unless `offline` is set, makes one request to the npm
 * registry for the latest `@angular/core` version (three-second timeout,
 * falling back to `BUNDLED_LATEST_ANGULAR_MAJOR`). Nothing else leaves the
 * machine: no source, no file names, no telemetry. Never writes anything.
 */
export async function runCheckup(root: string, options: CheckupOptions = {}): Promise<Report> {
  const started = Date.now();
  const absoluteRoot = resolve(root);
  const context = await buildContext(absoluteRoot, options);
  const checks = CHECKS.map((check) => check(context));
  const application = context.sources.filter((file) => !file.isSpec);
  const plan = options.plan ? buildPlan(context.workspace, checks, context.latestAngular.major) : undefined;

  return {
    tool: TOOL,
    generatedAt: new Date().toISOString(),
    root: absoluteRoot,
    project: {
      name: context.workspace.name,
      kind: context.workspace.kind,
      angularVersion: context.workspace.angular.installed ?? context.workspace.angular.declared,
      sourceFiles: context.sources.length,
      templateFiles: context.templates.filter((template) => !template.inline).length,
      linesOfCode: application.reduce((sum, file) => sum + file.linesOfCode, 0),
    },
    checks,
    durationMs: Date.now() - started,
    ...(plan ? { plan } : {}),
  };
}

/** Gathers everything the checks read. Exported for tests that want to inspect the facts. */
export async function buildContext(root: string, options: CheckupOptions): Promise<AnalysisContext> {
  const files = collectFiles(root, ignoreMatcher(options.ignore));
  const workspace = readWorkspace(root, files.projectJsons);
  const sources = files.typescript.map((path) => scanSourceFile(root, path));
  const templates = [...files.html.map((path) => scanTemplateFile(root, path)), ...sources.flatMap((file) => file.inlineTemplates)];
  const appCompilerOptions = readCompilerOptions(workspace.appTsconfig);

  return {
    workspace,
    sources,
    templates,
    deprecations: buildDeprecationIndex(root),
    tangles: findTangles(sources, readCompilerOptions(workspace.rootTsconfig)),
    latestAngular: options.offline ? { major: BUNDLED_LATEST_ANGULAR_MAJOR, source: 'bundled' } : await fetchLatestAngularMajor(),
    appCompilerOptions,
    angularCompilerOptions: workspace.appTsconfig ? readAngularCompilerOptions(workspace.appTsconfig) : {},
    maxExamples: options.maxExamples ?? 5,
  };
}

/**
 * The latest `@angular/core` major from the npm registry, or the bundled
 * fallback when the request fails or takes longer than three seconds. A slow
 * or offline network must never stall a run that is otherwise local.
 */
async function fetchLatestAngularMajor(): Promise<AnalysisContext['latestAngular']> {
  try {
    const response = await fetch('https://registry.npmjs.org/@angular/core/latest', { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const major = majorOf(asRecord(await response.json())['version'] as string | undefined);
      if (major !== undefined) return { major, source: 'registry' };
    }
  } catch {
    // Offline, blocked by a proxy, or timed out: the bundled value is the answer.
  }
  return { major: BUNDLED_LATEST_ANGULAR_MAJOR, source: 'bundled' };
}

/**
 * `angularCompilerOptions` of a tsconfig, merged along its `extends` chain
 * with the child winning. TypeScript's own config parser resolves `extends`
 * for `compilerOptions` only and drops this block, so it is merged by hand.
 * Follows relative `extends` paths (strings or, since TS 5.0, arrays); a
 * package-name `extends` is skipped, since no shared tsconfig package sets
 * Angular's options.
 */
export function readAngularCompilerOptions(tsconfigPath: string, depth = 0): Record<string, unknown> {
  const config = readJson(tsconfigPath);
  if (!config || depth > 10) return {};
  const parents = (Array.isArray(config['extends']) ? config['extends'] : [config['extends']]).filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('.'));
  const inherited = parents.reduce<Record<string, unknown>>((merged, parent) => {
    const path = resolve(dirname(tsconfigPath), parent.endsWith('.json') ? parent : `${parent}.json`);
    return { ...merged, ...readAngularCompilerOptions(path, depth + 1) };
  }, {});
  return { ...inherited, ...asRecord(config['angularCompilerOptions']) };
}

/** Reads name and version from this package's package.json, one level above both `src/` and `dist/`. */
function readToolInfo(): { name: string; version: string } {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: string; version?: string };
    return { name: packageJson.name ?? 'ng-checkup', version: packageJson.version ?? '0.0.0' };
  } catch {
    return { name: 'ng-checkup', version: '0.0.0' };
  }
}
