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
