import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Where downloaded package typings are kept between runs: `NG_CHECKUP_CACHE`,
 * else `$XDG_CACHE_HOME/ng-checkup`, else `~/.cache/ng-checkup`. A published
 * version never changes, so an entry is valid forever and is never refreshed.
 */
export function cacheDirectory(): string {
  return process.env['NG_CHECKUP_CACHE'] ?? join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'ng-checkup');
}

/**
 * A directory holding `package.json` and every `.d.ts` file of
 * `name@version` exactly as npm publishes them, for the deprecation index to
 * read as if it were `node_modules/<name>`.
 *
 * Downloads the package tarball from the public registry once and keeps only
 * type definitions and package manifests: `@angular/core` is about 4 MB of
 * tarball, but its typings are a fraction of that, and nothing that could run
 * is written to disk. Nothing is executed either way.
 *
 * Undefined when the download fails (offline, a private package, a timeout of
 * 30 seconds); the caller then indexes what it has and the report says which
 * packages were missing.
 */
export async function packageTypings(name: string, version: string, offline = false): Promise<string | undefined> {
  const directory = join(cacheDirectory(), 'packages', `${name.replace('/', '+')}@${version}`);
  if (existsSync(join(directory, 'package.json'))) return directory;
  // --offline still uses what an earlier run downloaded; it only never fetches.
  if (offline) return undefined;
  try {
    const response = await fetch(`https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return undefined;
    const files = readTar(gunzipSync(Buffer.from(await response.arrayBuffer())));
    // Written to a sibling first and renamed, so an interrupted download never
    // leaves a half-filled directory that a later run would trust.
    const partial = `${directory}.partial-${process.pid}`;
    rmSync(partial, { recursive: true, force: true });
    let kept = 0;
    for (const [path, content] of files) {
      const relative = path.replace(/^[^/]+\//, ''); // npm puts everything under `package/`
      if (!/(^|\/)package\.json$|\.d\.(m|c)?ts$/.test(relative)) continue;
      const target = normalize(join(partial, relative));
      if (!target.startsWith(partial + sep)) continue; // never write outside the cache entry
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      kept++;
    }
    if (kept === 0 || !existsSync(join(partial, 'package.json'))) return undefined;
    mkdirSync(dirname(directory), { recursive: true });
    rmSync(directory, { recursive: true, force: true });
    renameSync(partial, directory);
    return directory;
  } catch {
    return undefined;
  }
}

/**
 * The regular files of an uncompressed tar archive, path to content.
 *
 * Handles the ustar `prefix` field and both long-name extensions (pax `path`
 * records and GNU `L` entries), which is everything `npm pack` and the
 * registry produce. Links, directories and devices are skipped.
 */
export function readTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = archive.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === '0' || type === '7') {
      files.set(name, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
