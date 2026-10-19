import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of a fixture project under `test/fixtures`. */
export function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
}

/**
 * Writes `files` (relative path to content) into a fresh temporary directory
 * and returns its path. For tests that need one or two source files rather
 * than a whole fixture project. Pair with `removeTemp` in `afterEach`.
 */
export function writeTemp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ng-checkup-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/** Deletes a directory made by `writeTemp`. */
export function removeTemp(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
