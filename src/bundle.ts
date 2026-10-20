import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { asRecord, type TargetInfo, type WorkspaceInfo } from './workspace.js';

/** Default budgets of a new Angular application (`initial`), used when the build target declares none. */
export const DEFAULT_BUDGET = { warning: 500 * 1024, error: 1024 * 1024 };

/** Builders whose output is a browser bundle with a stats file. */
const APPLICATION_BUILDERS = /:(application|browser|browser-esbuild)$/;

/** What one stats file says about one application's build. */
export interface BundleStats {
  /** Project name from the build target, or the folder name when the file was found by searching `dist`. */
  project: string;
  /** The stats file, relative to the analysed root. */
  file: string;
  format: 'esbuild' | 'webpack';
  /** When the stats file was written: a stale file describes an old build. ISO 8601. */
  builtAt: string;
  /** Bytes the browser loads before the app starts: entry scripts, what they import statically, global styles. */
  initialBytes: number;
  lazyChunks: number;
  lazyBytes: number;
  /** The largest lazily loaded file. Undefined without lazy chunks. */
  largestLazy?: { file: string; bytes: number };
  /**
   * Bytes of the initial bundle per npm package, largest first; code outside
   * `node_modules` is grouped as `(your code)`. Empty when the stats file does
   * not break outputs down by input (webpack stats without modules).
   */
  initialByPackage: Array<{ name: string; bytes: number }>;
  /** The `initial` budget of the build target's production configuration, else `DEFAULT_BUDGET`. Bytes. */
  budget: { warning?: number; error?: number };
}

/**
 * Finds and reads the stats file of every application build.
 *
 * `ng build --stats-json` writes `browser-stats.json` (Angular 18 and later)
 * or `stats.json` (the esbuild builder in 17, and every webpack build) into
 * the output folder. The folder comes from the build target's `outputPath`,
 * or `dist/<project>` as the CLI defaults to; without targets, `dist` is
 * searched two levels deep. Nothing is built: a project that was never built
 * with `--stats-json` simply has no entry, and a stats file that does not
 * parse is skipped rather than failing the run.
 */
export function readBundleStats(workspace: WorkspaceInfo): BundleStats[] {
  const builds = workspace.targets.filter((target) => target.target === 'build' && APPLICATION_BUILDERS.test(target.builder));
  const candidates: Array<{ project: string; directory: string; target?: TargetInfo }> = builds.map((target) => ({ project: target.project, directory: outputDirectory(workspace.root, target), target }));
  if (candidates.length === 0) {
    for (const directory of subdirectories(join(workspace.root, 'dist'), 2)) candidates.push({ project: relative(join(workspace.root, 'dist'), directory).split(/[\\/]/).join('/'), directory });
  }
  const results: BundleStats[] = [];
  const seen = new Set<string>();
  for (const { project, directory, target } of candidates) {
    const path = ['browser-stats.json', 'stats.json'].map((name) => join(directory, name)).find((candidate) => existsSync(candidate));
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try {
      const parsed = parseStats(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      if (!parsed) continue;
      results.push({ project, file: relative(workspace.root, path).split(/[\\/]/).join('/'), builtAt: statSync(path).mtime.toISOString(), budget: target ? readInitialBudget(target) : DEFAULT_BUDGET, ...parsed });
    } catch {
      // Unreadable or truncated (a build still writing it): no entry.
    }
  }
  return results;
}

/** The parts of a stats file that do not depend on where it was found. */
type ParsedStats = Pick<BundleStats, 'format' | 'initialBytes' | 'lazyChunks' | 'lazyBytes' | 'largestLazy' | 'initialByPackage'>;

/** Reads either format; undefined for JSON that is neither. Exported for tests. */
export function parseStats(json: unknown): ParsedStats | undefined {
  const record = asRecord(json);
  if (typeof record['outputs'] === 'object' && record['outputs'] !== null) return parseEsbuildMetafile(asRecord(record['outputs']));
  if (Array.isArray(record['assets']) && Array.isArray(record['chunks'])) return parseWebpackStats(record);
  return undefined;
}

/**
 * An esbuild metafile, as the Angular application builder writes it.
 *
 * The initial set is computed the way the CLI's "Initial total" is: every
 * output with an entry point that no other output loads through a dynamic
 * `import()`, plus everything those reach through static imports. Lazy
 * routes are entry points too in this format, which is why "has an entry
 * point" alone would count them as initial. Component CSS files without an
 * entry point are inlined by Angular and not loaded as files, so they are
 * left out like the CLI leaves them out.
 */
function parseEsbuildMetafile(outputs: Record<string, unknown>): ParsedStats {
  const files = new Map<string, { bytes: number; entryPoint?: string; imports: Array<{ path: string; kind: string }>; inputs: Record<string, number> }>();
  for (const [name, value] of Object.entries(outputs)) {
    if (name.endsWith('.map')) continue;
    const output = asRecord(value);
    const imports = (Array.isArray(output['imports']) ? output['imports'] : []).map((entry) => asRecord(entry)).map((entry) => ({ path: String(entry['path']), kind: String(entry['kind']) }));
    const inputs = Object.fromEntries(Object.entries(asRecord(output['inputs'])).map(([input, data]) => [input, Number(asRecord(data)['bytesInOutput']) || 0]));
    files.set(name, { bytes: Number(output['bytes']) || 0, entryPoint: typeof output['entryPoint'] === 'string' ? output['entryPoint'] : undefined, imports, inputs });
  }
  const dynamicTargets = new Set([...files.values()].flatMap((file) => file.imports.filter((entry) => entry.kind === 'dynamic-import').map((entry) => entry.path)));
  const initial = new Set<string>();
  const queue = [...files.entries()].filter(([name, file]) => file.entryPoint !== undefined && !dynamicTargets.has(name)).map(([name]) => name);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (initial.has(name) || !files.has(name)) continue;
    initial.add(name);
    for (const entry of files.get(name)!.imports) if (entry.kind === 'import-statement') queue.push(entry.path);
  }
  const lazy = [...files.entries()].filter(([name]) => !initial.has(name) && name.endsWith('.js'));
  const byPackage = new Map<string, number>();
  for (const name of initial) {
    for (const [input, bytes] of Object.entries(files.get(name)!.inputs)) {
      const owner = packageOf(input);
      if (owner) byPackage.set(owner, (byPackage.get(owner) ?? 0) + bytes);
    }
  }
  return summarise('esbuild', [...initial].reduce((sum, name) => sum + files.get(name)!.bytes, 0), lazy.map(([file, data]) => ({ file, bytes: data.bytes })), byPackage);
}

/**
 * Webpack stats (`--stats-json` with the browser builder, Angular 16 and
 * earlier). Chunks marked `initial` hold the initial files; every other
 * `.js` asset is lazy. Packages come from `modules` when the stats include
 * them, which Angular's do.
 */
function parseWebpackStats(stats: Record<string, unknown>): ParsedStats {
  const assets = new Map((stats['assets'] as unknown[]).map((entry) => asRecord(entry)).map((asset) => [String(asset['name']), Number(asset['size']) || 0]));
  const chunks = (stats['chunks'] as unknown[]).map((entry) => asRecord(entry));
  const initialChunkIds = new Set(chunks.filter((chunk) => chunk['initial'] === true).map((chunk) => String(chunk['id'])));
  const initialFiles = new Set(chunks.filter((chunk) => chunk['initial'] === true).flatMap((chunk) => (Array.isArray(chunk['files']) ? chunk['files'].map(String) : [])).filter((file) => /\.(js|css)$/.test(file)));
  const lazy = [...assets.entries()].filter(([name]) => name.endsWith('.js') && !initialFiles.has(name)).map(([file, bytes]) => ({ file, bytes }));
  const byPackage = new Map<string, number>();
  for (const module of Array.isArray(stats['modules']) ? stats['modules'].map((entry) => asRecord(entry)) : []) {
    const inInitial = Array.isArray(module['chunks']) && module['chunks'].some((id) => initialChunkIds.has(String(id)));
    const owner = inInitial ? packageOf(String(module['name'] ?? '')) : undefined;
    if (owner) byPackage.set(owner, (byPackage.get(owner) ?? 0) + (Number(module['size']) || 0));
  }
  return summarise('webpack', [...initialFiles].reduce((sum, file) => sum + (assets.get(file) ?? 0), 0), lazy, byPackage);
}

/** The shared tail of both parsers. */
function summarise(format: ParsedStats['format'], initialBytes: number, lazy: Array<{ file: string; bytes: number }>, byPackage: Map<string, number>): ParsedStats {
  const largestLazy = [...lazy].sort((left, right) => right.bytes - left.bytes)[0];
  return {
    format,
    initialBytes,
    lazyChunks: lazy.length,
    lazyBytes: lazy.reduce((sum, file) => sum + file.bytes, 0),
    ...(largestLazy ? { largestLazy } : {}),
    initialByPackage: [...byPackage.entries()].map(([name, bytes]) => ({ name, bytes })).filter((entry) => entry.bytes > 0).sort((left, right) => right.bytes - left.bytes),
  };
}

/**
 * The npm package an input path belongs to (`@angular/core`, `rxjs`), or
 * `(your code)` for anything outside `node_modules`. Undefined for the
 * builder's virtual inputs (`angular:…`, `<runtime>`), which no one can act on.
 */
function packageOf(input: string): string | undefined {
  const path = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const index = path.lastIndexOf('node_modules/');
  if (index >= 0) {
    const parts = path.slice(index + 'node_modules/'.length).split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  if (path.startsWith('angular:') || path.startsWith('<') || path === '') return undefined;
  return '(your code)';
}

/** The build output folder: `outputPath` as a string or `{ base }`, else the CLI default `dist/<project>`. */
function outputDirectory(root: string, target: TargetInfo): string {
  const option = target.options['outputPath'];
  const base = typeof option === 'string' ? option : typeof asRecord(option)['base'] === 'string' ? (asRecord(option)['base'] as string) : `dist/${target.project}`;
  return resolve(target.baseDirectory || root, base);
}

/**
 * The `initial` budget of the production configuration. Angular reads
 * `kb` and `mb` as binary units (1 kB = 1024 bytes), so this does too.
 * Absent when the target has no production configuration or no `initial`
 * budget; `DEFAULT_BUDGET` then applies.
 */
function readInitialBudget(target: TargetInfo): BundleStats['budget'] {
  const budgets = asRecord(asRecord(target.configurations)['production'])['budgets'];
  const initial = Array.isArray(budgets) ? budgets.map((entry) => asRecord(entry)).find((budget) => budget['type'] === 'initial') : undefined;
  if (!initial) return DEFAULT_BUDGET;
  return { warning: parseSize(initial['maximumWarning']), error: parseSize(initial['maximumError']) };
}

/** `"500kB"` → 512000, `"1mb"` → 1048576, `"300"` → 300 bytes. Undefined for anything else. */
export function parseSize(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (!match) return undefined;
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return Math.round(Number(match[1]) * factor);
}

/** Directories under `directory` down to `depth` levels, deepest last. Empty when it does not exist. */
function subdirectories(directory: string, depth: number): string[] {
  if (depth === 0 || !existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    found.push(path, ...subdirectories(path, depth - 1));
  }
  return found;
}
