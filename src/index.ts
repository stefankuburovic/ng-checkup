import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readBundleStats } from './bundle.js';
import { bundleCheck } from './checks/bundle.js';
import { architectureCheck } from './checks/architecture.js';
import { changeDetectionCheck } from './checks/change-detection.js';
import { circularDepsCheck } from './checks/circular-deps.js';
import { componentsCheck } from './checks/components.js';
import type { AnalysisContext, Check } from './checks/context.js';
import { deprecatedApisCheck } from './checks/deprecated-apis.js';
import { dependenciesCheck } from './checks/dependencies.js';
import { readCompatibility } from './compatibility.js';
import { securityCheck } from './checks/security.js';
import { stateCheck } from './checks/state.js';
import { testingCheck } from './checks/testing.js';
import { typeSafetyCheck } from './checks/type-safety.js';
import { versionCheck } from './checks/version.js';
import { cachedFacts, dependencyStamp } from './cache.js';
import { loadDeprecationIndex } from './typings.js';
import { ignoreMatcher } from './config.js';
import { collectFiles } from './files.js';
import { buildImportGraph, findTanglesIn, readCompilerOptions, staticallyReachable } from './graph.js';
import { buildPlan } from './plan.js';
import { scanSourceFile, scanTemplateFile } from './scan.js';
import { overallScore } from './report/summary.js';
import type { CheckupOptions, ProjectSummary, Report } from './types.js';
import { applicationEntries, asRecord, majorOf, owningProject, readJson, readWorkspace, restrictToProject, type ProjectInfo } from './workspace.js';

export type * from './types.js';
// The renderers and the score are public so a script can turn a report from
// `runCheckup` into the same HTML or Markdown the CLI writes, e.g. to post it
// as a pull-request comment.
export { renderHtml } from './report/html.js';
export { renderMarkdown } from './report/markdown.js';
export { renderSarif } from './report/sarif.js';
export { COMMENT_MARKER, renderComment } from './report/comment.js';
export { createAnalysisCache, type AnalysisCache } from './cache.js';
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
export const CHECKS: Check[] = [
  versionCheck,
  deprecatedApisCheck,
  dependenciesCheck,
  changeDetectionCheck,
  componentsCheck,
  stateCheck,
  architectureCheck,
  testingCheck,
  typeSafetyCheck,
  securityCheck,
  circularDepsCheck,
  bundleCheck,
];

/**
 * The checks that grade a project's own code, for the per-project breakdown.
 * `version` and `dependencies` read the root `package.json`, which all
 * projects of a workspace share.
 */
const PROJECT_CHECKS: Check[] = CHECKS.filter((check) => check !== versionCheck && check !== dependenciesCheck);

/** Thrown by `runCheckup` for a `project` option that names no project; the message lists the names. */
export class ProjectNotFoundError extends Error {
  override name = 'ProjectNotFoundError';
}

/** This package's own name and version, read from its package.json at runtime so the two never drift. */
export const TOOL = readToolInfo();

/**
 * Analyses the Angular codebase at `root` and returns the full report.
 *
 * Reads the disk and, unless `offline` is set, asks the npm registry for the
 * latest `@angular/core` version (three-second timeout, falling back to
 * `BUNDLED_LATEST_ANGULAR_MAJOR`) and for the metadata of each installed
 * package that depends on Angular (see `readCompatibility`). Only package
 * names leave the machine: no source, no file names, no telemetry. Never
 * writes anything. With `options.cache`, a repeated run re-parses only the
 * files that changed and repeats no registry request (see `AnalysisCache`).
 */
export async function runCheckup(root: string, options: CheckupOptions = {}): Promise<Report> {
  const started = Date.now();
  const absoluteRoot = resolve(root);
  const context = await buildContext(absoluteRoot, options);
  const checks = CHECKS.map((check) => check(context));
  const application = context.sources.filter((file) => !file.isSpec && !file.isGenerated);
  const generatedFiles = context.sources.filter((file) => file.isGenerated).length;
  const plan = options.plan ? buildPlan(context.workspace, checks, context.latestAngular.major, undefined, context.compatibility) : undefined;
  const projects = options.project ? [] : projectBreakdown(context);

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
      ...(generatedFiles > 0 ? { generatedFiles } : {}),
    },
    checks,
    durationMs: Date.now() - started,
    ...(plan ? { plan } : {}),
    ...(projects.length >= 2 ? { projects } : {}),
  };
}

/**
 * Runs the code checks once per project on the files it owns (see
 * `owningProject`), worst score first. Parsing is shared with the
 * whole-workspace run, so this costs only the checks, not a second scan.
 *
 * Import cycles are taken from the workspace graph and kept only when every
 * file of the cycle belongs to the project; a cycle across two projects is in
 * the whole-workspace report and in neither row, since neither project can
 * cut it alone. A project with no file importing `@angular/*` gets no row:
 * Nx workspaces routinely hold React apps, Node services and Cypress or
 * Playwright e2e projects, and grading those on OnPush and strictTemplates
 * would fill the table with noise.
 */
function projectBreakdown(context: AnalysisContext): ProjectSummary[] {
  const { projects } = context.workspace;
  if (projects.length < 2) return [];
  const ownerOf = (path: string): ProjectInfo | undefined => owningProject(path, projects);
  const rows: ProjectSummary[] = [];
  for (const project of projects) {
    const sources = context.sources.filter((file) => ownerOf(file.path) === project);
    if (!sources.some((file) => file.imports.some((fact) => fact.specifier.startsWith('@angular/')))) continue;
    const projectContext = narrowContext(context, project, ownerOf);
    const checks = PROJECT_CHECKS.map((check) => check(projectContext));
    rows.push({
      name: project.name,
      root: project.root,
      type: project.type,
      sourceFiles: sources.length,
      linesOfCode: sources.filter((file) => !file.isSpec && !file.isGenerated).reduce((sum, file) => sum + file.linesOfCode, 0),
      score: overallScore({ checks }),
      grades: Object.fromEntries(checks.map((check) => [check.id, check.grade])),
      highFindings: checks.reduce((sum, check) => sum + check.findings.filter((finding) => finding.severity === 'high').length, 0),
    });
  }
  return rows.sort((left, right) => (left.score ?? 101) - (right.score ?? 101) || left.name.localeCompare(right.name));
}

/** The context of one project: its files, its cycles, its tsconfig. Everything read from the registry or `node_modules` is shared. */
function narrowContext(context: AnalysisContext, project: ProjectInfo, ownerOf: (path: string) => ProjectInfo | undefined): AnalysisContext {
  const workspace = restrictToProject(context.workspace, project);
  return {
    ...context,
    workspace,
    sources: context.sources.filter((file) => ownerOf(file.path) === project),
    templates: context.templates.filter((template) => ownerOf(template.path) === project),
    tangles: context.tangles.filter((tangle) => tangle.files.every((path) => ownerOf(path) === project)),
    bundles: context.bundles.filter((bundle) => bundle.project === project.name),
    appCompilerOptions: readCompilerOptions(workspace.appTsconfig),
    angularCompilerOptions: workspace.appTsconfig ? readAngularCompilerOptions(workspace.appTsconfig) : {},
  };
}

/** Gathers everything the checks read. Exported for tests that want to inspect the facts. */
export async function buildContext(root: string, options: CheckupOptions): Promise<AnalysisContext> {
  const files = collectFiles(root, ignoreMatcher(options.ignore));
  const workspace = readWorkspace(root, files.projectJsons);
  const { cache } = options;
  const sources = files.typescript.map((path) => cachedFacts(cache, path, () => scanSourceFile(root, path)));
  const templates = [...files.html.map((path) => cachedFacts(cache, path, () => scanTemplateFile(root, path))), ...sources.flatMap((file) => file.inlineTemplates)];
  // Drop entries for files that no longer exist, so a deleted file stops counting.
  if (cache) {
    const present = new Set([...files.typescript, ...files.html]);
    for (const path of cache.files.keys()) if (!present.has(path)) cache.files.delete(path);
  }
  const appCompilerOptions = readCompilerOptions(workspace.appTsconfig);

  const stamp = dependencyStamp(root);
  let dependencies = cache?.dependencies?.stamp === stamp ? cache.dependencies : undefined;
  if (!dependencies) {
    const latestAngular: AnalysisContext['latestAngular'] = options.offline ? { major: BUNDLED_LATEST_ANGULAR_MAJOR, source: 'bundled' } : await fetchLatestAngularMajor();
    const offline = options.offline ?? false;
    const [{ index, typings }, compatibility] = await Promise.all([loadDeprecationIndex(root, workspace, sources, offline), readCompatibility(workspace, latestAngular.major, offline)]);
    dependencies = { stamp, latestAngular, deprecations: index, typings, compatibility };
    if (cache) cache.dependencies = dependencies;
  }
  const { latestAngular } = dependencies;
  const graph = buildImportGraph(sources, readCompilerOptions(workspace.rootTsconfig));
  const eagerFiles = staticallyReachable(graph, applicationEntries(workspace));

  const context: AnalysisContext = {
    workspace,
    sources,
    templates,
    deprecations: dependencies.deprecations,
    typings: dependencies.typings,
    tangles: findTanglesIn(graph),
    ...(eagerFiles.size > 0 ? { eagerFiles } : {}),
    latestAngular,
    compatibility: dependencies.compatibility,
    bundles: readBundleStats(workspace),
    appCompilerOptions,
    angularCompilerOptions: workspace.appTsconfig ? readAngularCompilerOptions(workspace.appTsconfig) : {},
    maxExamples: options.maxExamples ?? 5,
  };
  if (options.project === undefined) return context;
  const project = workspace.projects.find((entry) => entry.name === options.project);
  if (!project) {
    const names = workspace.projects.map((entry) => entry.name).sort();
    throw new ProjectNotFoundError(`No project named ${options.project}. ${names.length > 0 ? `Projects: ${names.join(', ')}` : 'This workspace declares no projects (no angular.json or project.json).'}`);
  }
  // Narrowed after the whole-workspace graph is built, so an import into
  // another project still resolves and a cycle through it is recognised as
  // crossing projects rather than silently broken.
  return narrowContext(context, project, (path) => owningProject(path, workspace.projects));
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
