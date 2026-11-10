import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Which lockfile the versions came from, for the report's "version from" hint. */
export type LockfileKind = 'npm' | 'yarn' | 'pnpm';

/** Exact versions of the asked-for packages, as the repository's lockfile pins them. */
export interface LockedVersions {
  kind?: LockfileKind;
  /** Package name to exact version. Packages the lockfile does not pin are absent. */
  versions: Record<string, string>;
}

/**
 * The exact versions a clean install of this repository would get, read from
 * its lockfile without installing anything.
 *
 * This is what lets a repository be checked without `node_modules`: a CI job
 * before `npm ci`, a fresh clone, or `ng-checkup github:owner/repo`. A
 * `package.json` range (`^15.0.0`) says only roughly what is used; the
 * lockfile says exactly, and exact versions are what the deprecation index
 * downloads the typings of.
 *
 * Reads `package-lock.json` / `npm-shrinkwrap.json` (lockfile v1 to v3),
 * `yarn.lock` (classic and Berry) and `pnpm-lock.yaml` (v5 to v9), with small
 * hand-written parsers: a YAML library for one lookup per package would be
 * the tool's first runtime dependency besides TypeScript. Only top-level
 * versions are read, which is what an application resolves its own imports
 * to. When several versions of one package are locked (yarn), the one locked
 * for the range `package.json` declares wins.
 *
 * @param declared The ranges from `package.json`, used to pick among several locked versions.
 */
export function readLockedVersions(root: string, names: string[], declared: Record<string, string> = {}): LockedVersions {
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const path = join(root, file);
    if (existsSync(path)) return { kind: 'npm', versions: fromNpm(readFileSync(path, 'utf8'), names) };
  }
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return { kind: 'pnpm', versions: fromPnpm(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), names) };
  if (existsSync(join(root, 'yarn.lock'))) return { kind: 'yarn', versions: fromYarn(readFileSync(join(root, 'yarn.lock'), 'utf8'), names, declared) };
  return { versions: {} };
}

/** `packages["node_modules/x"].version` (v2, v3), else `dependencies.x.version` (v1). */
function fromNpm(text: string, names: string[]): Record<string, string> {
  let lock: { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return {};
  }
  const versions: Record<string, string> = {};
  for (const name of names) {
    const version = lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version;
    if (version && /^\d/.test(version)) versions[name] = version;
  }
  return versions;
}

/**
 * `yarn.lock`, classic and Berry. A block starts with an unindented line
 * listing the descriptors it satisfies (`"@angular/core@npm:^15.0.0", …:`)
 * and holds a `version` line (`  version "15.2.10"` or `  version: 15.2.10`).
 */
function fromYarn(text: string, names: string[], declared: Record<string, string>): Record<string, string> {
  const wanted = new Set(names);
  const candidates = new Map<string, Array<{ ranges: string[]; version: string }>>();
  let current: Array<{ name: string; range: string }> = [];
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      current = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((descriptor) => descriptor.replace(/^"|"$/g, ''))
        .map((descriptor) => {
          const at = descriptor.indexOf('@', 1);
          return { name: descriptor.slice(0, at), range: descriptor.slice(at + 1).replace(/^npm:/, '') };
        })
        .filter((descriptor) => wanted.has(descriptor.name));
      continue;
    }
    const match = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (!match || current.length === 0) continue;
    const name = current[0]!.name;
    const list = candidates.get(name) ?? [];
    list.push({ ranges: current.map((descriptor) => descriptor.range), version: match[1]! });
    candidates.set(name, list);
    current = [];
  }
  const versions: Record<string, string> = {};
  for (const [name, list] of candidates) {
    const range = declared[name];
    const match = (range ? list.find((entry) => entry.ranges.includes(range)) : undefined) ?? list[0];
    if (match && /^\d/.test(match.version)) versions[name] = match.version;
  }
  return versions;
}

/**
 * `pnpm-lock.yaml`. v6 and later list the root importer's dependencies as
 * `'name':` / `specifier:` / `version: 15.2.10(peer@…)`; v5 as
 * `'name': 15.2.10_peer@…` under a top-level `dependencies:`. Either way the
 * version is the leading `x.y.z` before any peer suffix.
 */
function fromPnpm(text: string, names: string[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of names) {
    const quoted = `'?${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'?`;
    const modern = new RegExp(`^\\s+${quoted}:\\s*\\n\\s+specifier:[^\\n]*\\n\\s+version:\\s*'?(\\d[^\\s('_]*)`, 'm').exec(text);
    const legacy = modern ? undefined : new RegExp(`^ {2,6}${quoted}:\\s+'?(\\d[^\\s('_]*)`, 'm').exec(text);
    const version = (modern ?? legacy)?.[1];
    if (version) versions[name] = version;
  }
  return versions;
}

/** Packages installed in more than one major, and the lockfile that says so. */
export interface DuplicatePackages {
  /** The lockfile, relative to the workspace root. */
  file: string;
  /** Sorted by name; each with its locked versions, lowest first, one per major. */
  packages: Array<{ name: string; versions: string[] }>;
}

/**
 * The runtime packages two copies of which break each other: `rxjs`,
 * `zone.js`, Angular's own packages and NgRx. Tooling (`@angular/cli`, the
 * compiler CLI, the builders) never reaches the browser, and a second `tslib`
 * costs a few kilobytes and breaks nothing, so they are not listed.
 */
export function isSingletonPackage(name: string): boolean {
  if (name === 'rxjs' || name === 'zone.js') return true;
  if (name.startsWith('@ngrx/')) return true;
  return name.startsWith('@angular/') && !['@angular/cli', '@angular/compiler-cli', '@angular/build', '@angular/language-service', '@angular/ssr', '@angular/fire'].includes(name);
}

/**
 * Every locked version of the packages `isSingletonPackage` names, from the
 * whole tree and not only the top level, and those in two majors or more.
 * Copies only development needs are left out: `package-lock.json` marks
 * them, and in `yarn.lock` only what the app's `dependencies` reach counts.
 * A copy only a build tool pulls in never reaches the browser.
 *
 * @param production The `dependencies` of `package.json`, without the dev ones.
 * @returns Undefined without a lockfile this reads (pnpm is not read).
 */
export function readDuplicatePackages(root: string, production: Record<string, string>): DuplicatePackages | undefined {
  let file: string | undefined;
  let versions: Map<string, Set<string>> | undefined;
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (existsSync(join(root, name))) {
      file = name;
      versions = allFromNpm(readFileSync(join(root, name), 'utf8'));
      break;
    }
  }
  // pnpm-lock.yaml from v9 on keeps no mark of what only development needs, and its tree is not read here, so a pnpm repository says nothing rather than guess.
  if (!versions && !existsSync(join(root, 'pnpm-lock.yaml')) && existsSync(join(root, 'yarn.lock'))) {
    file = 'yarn.lock';
    versions = allFromYarn(readFileSync(join(root, file), 'utf8'), production);
  }
  if (!versions || !file) return undefined;
  const packages: DuplicatePackages['packages'] = [];
  for (const [name, set] of [...versions].sort(([left], [right]) => left.localeCompare(right))) {
    const byMajor = new Map<string, string>();
    for (const version of [...set].sort(compareVersions)) {
      const major = version.split('.')[0]!;
      if (!byMajor.has(major)) byMajor.set(major, version);
    }
    if (byMajor.size > 1) packages.push({ name, versions: [...byMajor.values()] });
  }
  return { file, packages };
}

function add(into: Map<string, Set<string>>, name: string, version: string | undefined): void {
  if (!version || !/^\d/.test(version) || !isSingletonPackage(name)) return;
  const set = into.get(name) ?? new Set<string>();
  set.add(version);
  into.set(name, set);
}

/** Every `node_modules/…/name` of lockfile v2 and v3, else the nested `dependencies` of v1; `dev: true` entries left out. */
function allFromNpm(text: string): Map<string, Set<string>> {
  const into = new Map<string, Set<string>>();
  let lock: { packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>; dependencies?: Record<string, NpmV1Entry> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return into;
  }
  if (lock.packages) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      const at = key.lastIndexOf('node_modules/');
      if (at < 0 || entry.dev || entry.link) continue;
      add(into, key.slice(at + 'node_modules/'.length), entry.version);
    }
    return into;
  }
  const walk = (dependencies: Record<string, NpmV1Entry> | undefined): void => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      if (entry.dev) continue;
      add(into, name, entry.version);
      walk(entry.dependencies);
    }
  };
  walk(lock.dependencies);
  return into;
}

interface NpmV1Entry {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, NpmV1Entry>;
}

/**
 * The packages of `yarn.lock` that the app's own `dependencies` reach,
 * classic and Berry. The lockfile does not mark what only development needs,
 * so the tree is walked from `package.json`: a block lists the descriptors it
 * satisfies, and its `dependencies:` lines the descriptors it needs.
 */
function allFromYarn(text: string, production: Record<string, string>): Map<string, Set<string>> {
  const into = new Map<string, Set<string>>();
  const blocks = new Map<string, { name: string; version?: string; needs: string[] }>();
  let current: { name: string; version?: string; needs: string[] } | undefined;
  let inDependencies = false;
  const descriptorKey = (name: string, range: string): string => `${name}@${range.replace(/^npm:/, '')}`;
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      const descriptors = line.slice(0, -1).split(/,\s*/).map((descriptor) => descriptor.replace(/^"|"$/g, ''));
      const first = descriptors[0]!;
      current = { name: first.slice(0, first.indexOf('@', 1)), needs: [] };
      for (const descriptor of descriptors) {
        const at = descriptor.indexOf('@', 1);
        blocks.set(descriptorKey(descriptor.slice(0, at), descriptor.slice(at + 1)), current);
      }
      inDependencies = false;
      continue;
    }
    if (!current) continue;
    const version = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (version) {
      current.version = version[1];
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      inDependencies = /^ {2}dependencies:\s*$/.test(line);
      continue;
    }
    const dependency = inDependencies ? /^ {4}"?((?:@[^/"\s]+\/)?[^"\s:]+)"?:?\s+"?([^"\s]+)"?\s*$/.exec(line) : null;
    if (dependency) current.needs.push(descriptorKey(dependency[1]!, dependency[2]!));
  }
  const seen = new Set<object>();
  const queue = Object.entries(production).map(([name, range]) => descriptorKey(name, range));
  while (queue.length > 0) {
    const block = blocks.get(queue.pop()!);
    if (!block || seen.has(block)) continue;
    seen.add(block);
    add(into, block.name, block.version);
    queue.push(...block.needs);
  }
  return into;
}

/** Numeric order of `x.y.z` versions; a prerelease sorts by its numeric part. */
function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] => version.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}
