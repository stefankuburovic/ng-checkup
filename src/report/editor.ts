import { isAbsolute as isPosixAbsolute } from 'node:path/posix';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import type { FileRef } from '../types.js';

/**
 * Where a file link in the HTML report opens. There is no operating-system
 * "default IDE" that can jump to a line, so each editor gets its own URL
 * scheme; `file` opens the file in whatever app the system has for its
 * extension, without the line, and `none` leaves the paths as plain text.
 */
export type Editor = 'vscode' | 'cursor' | 'windsurf' | 'idea' | 'webstorm' | 'file' | 'none';

export const EDITORS: readonly Editor[] = ['vscode', 'cursor', 'windsurf', 'idea', 'webstorm', 'file', 'none'];

export function isEditor(value: string): value is Editor {
  return (EDITORS as readonly string[]).includes(value);
}

/**
 * The editor when `--editor` is not given: `NG_CHECKUP_EDITOR`, then the
 * editor whose terminal the command runs in, then VS Code. On CI the paths
 * are a runner's and mean nothing on the reader's machine, so none.
 */
export function detectEditor(environment: NodeJS.ProcessEnv = process.env): Editor {
  const named = environment['NG_CHECKUP_EDITOR']?.trim().toLowerCase();
  if (named && isEditor(named)) return named;
  if (environment['CI'] && environment['CI'] !== 'false') return 'none';
  if (environment['CURSOR_TRACE_ID']) return 'cursor';
  if (environment['TERMINAL_EMULATOR']?.includes('JetBrains')) return 'idea';
  return 'vscode';
}

/**
 * The URL that opens `ref` in `editor`, or undefined when the report has no
 * absolute root to resolve it against (a remote run shows `github:owner/repo`).
 */
export function editorUrl(editor: Editor, root: string, ref: FileRef): string | undefined {
  if (editor === 'none') return undefined;
  if (!isPosixAbsolute(root) && !isWindowsAbsolute(root)) return undefined;
  // `C:\work\app` becomes `/C:/work/app`, the form every one of these schemes expects.
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = `${base.startsWith('/') ? '' : '/'}${base}/${ref.path.replace(/^\.?\//, '')}`;
  const line = ref.line !== undefined ? ref.line : undefined;
  switch (editor) {
    case 'vscode':
    case 'cursor':
    case 'windsurf':
      return `${editor}://file${encodeURI(absolute)}${line !== undefined ? `:${line}` : ''}`;
    case 'idea':
    case 'webstorm':
      return `${editor}://open?file=${encodeURIComponent(absolute)}${line !== undefined ? `&line=${line}` : ''}`;
    case 'file':
      return `file://${encodeURI(absolute)}`;
  }
}

/** Display name for a link title: "Open … in VS Code". */
export function editorName(editor: Editor): string {
  return { vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', idea: 'IntelliJ IDEA', webstorm: 'WebStorm', file: 'the default app', none: '' }[editor];
}
