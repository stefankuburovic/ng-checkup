import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createAnalysisCache, type AnalysisCache } from './cache.js';
import { CHECK_IDS, runCheckup, TOOL } from './index.js';
import { renderMarkdown } from './report/markdown.js';
import type { CheckupOptions, Report, Severity } from './types.js';

/**
 * `ng-checkup mcp`: the checkup as a Model Context Protocol server, so an
 * editor agent (Claude Code, Cursor, Copilot, any MCP client) can ask "what
 * blocks zoneless here" or "what is wrong with this file" and get findings
 * with paths and lines instead of reading a report.
 *
 * Written against the protocol directly rather than the SDK: the stdio
 * transport is newline-delimited JSON-RPC 2.0 and a server needs four
 * methods, while the SDK would be the package's first runtime dependency
 * beyond TypeScript. Nothing is written to stdout except protocol messages,
 * since a stray line there breaks the client's parser; diagnostics go to
 * stderr.
 *
 * One analysis cache per root lives as long as the server, so the second
 * question about a workspace re-parses only the files that changed since the
 * first, as `--watch` does.
 */

/** The protocol version answered when the client names none; a client that names one gets it echoed back. */
const PROTOCOL_VERSION = '2025-06-18';

/** Examples per finding in tool answers: an agent reads them all, so the terminal's 5 would hide most of a finding. */
const AGENT_EXAMPLES = 50;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PATH_PROPERTY = { type: 'string', description: 'Folder of the Angular workspace or repository, absolute or relative to where the server was started. Default: that folder.' };

/** What `tools/list` answers. Descriptions are written for the agent that picks a tool, not for a person. */
const TOOLS = [
  {
    name: 'checkup',
    description:
      'Grades an Angular codebase in twelve areas (Angular version, deprecated APIs, third-party compatibility, zoneless readiness, components, state, architecture, testing, type safety, security, circular dependencies, bundle size), lists missing translation keys, accessibility defects and code that breaks server rendering beside them, and returns the report as Markdown: score, grade per area, every finding with its files. Start here for "how modern is this app" or "what should we fix first".',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        only: { type: 'array', items: { type: 'string', enum: [...CHECK_IDS] }, description: 'Keep only these areas.' },
        project: { type: 'string', description: 'One project of a multi-project workspace, by its name in angular.json or project.json.' },
        since: { type: 'string', description: 'A git ref (origin/main): keep only findings in files changed since its merge base with HEAD, as a pull request would.' },
        online: { type: 'boolean', description: 'Ask the npm registry for the latest Angular and osv.dev for vulnerabilities. Default false: offline is faster and needs no network.' },
      },
    },
  },
  {
    name: 'findings',
    description:
      'Lists findings as JSON (area, severity, message, detail, files with lines), filtered by area, minimum severity or file. Use it for "what is wrong with src/app/x.component.ts" (file), "what blocks the next upgrade" (severity high) or "which subscriptions leak" (area components).',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        check: { type: 'string', enum: [...CHECK_IDS], description: 'Only this area.' },
        severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'], description: 'Only findings at least this severe.' },
        file: { type: 'string', description: 'Only findings that name this file, relative to path.' },
        online: { type: 'boolean', description: 'As for checkup. Default false.' },
      },
    },
  },
  {
    name: 'upgrade_plan',
    description: 'The step-by-step plan from the installed Angular to the latest major, one major at a time, with what to fix before each step and the ng update commands, as Markdown; for AngularJS code, the migration plan instead.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY, online: { type: 'boolean', description: 'Ask the npm registry for the latest Angular. Default false.' } } },
  },
] as const;

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/**
 * Serves the protocol on `input` / `output` until `input` ends.
 *
 * @returns A promise that settles when the input closes, after the last
 *   answer was written.
 */
export function serveMcp(input: Readable, output: Writable, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Promise<void> {
  const caches = new Map<string, AnalysisCache>();
  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  // Calls run one at a time, in order, so two questions about one root never share its cache concurrently.
  let queue: Promise<void> = Promise.resolve();

  const run = async (args: Record<string, unknown>, extra: CheckupOptions): Promise<Report> => {
    const root = resolve(typeof args['path'] === 'string' ? args['path'] : '.');
    let cache = caches.get(root);
    if (!cache) caches.set(root, (cache = createAnalysisCache()));
    return runCheckup(root, { offline: args['online'] !== true, maxExamples: AGENT_EXAMPLES, cache, ...extra });
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'checkup') {
      const report = await run(args, {
        ...(Array.isArray(args['only']) ? { only: args['only'].map(String) } : {}),
        ...(typeof args['project'] === 'string' ? { project: args['project'] } : {}),
        ...(typeof args['since'] === 'string' ? { since: args['since'] } : {}),
      });
      return renderMarkdown(report);
    }
    if (name === 'findings') {
      const report = await run(args, {});
      const minimum = SEVERITY_RANK[(args['severity'] as Severity | undefined) ?? 'info'] ?? 0;
      const file = typeof args['file'] === 'string' ? args['file'].replace(/^\.\//, '') : undefined;
      const findings = report.checks
        .filter((check) => args['check'] === undefined || check.id === args['check'])
        .flatMap((check) =>
          check.findings
            .filter((finding) => SEVERITY_RANK[finding.severity] >= minimum)
            .filter((finding) => file === undefined || (finding.files ?? []).some((ref) => ref.path === file))
            .map((finding) => ({ check: check.id, ...finding })),
        );
      return JSON.stringify({ root: report.root, findings }, null, 2);
    }
    if (name === 'upgrade_plan') {
      const report = await run(args, { plan: true });
      const markdown = renderMarkdown(report);
      const start = markdown.search(/^## (Upgrade|Migration) plan/m);
      return start >= 0 ? markdown.slice(start) : `Nothing to plan: ${report.project.name} is on the latest Angular major and has no AngularJS code.`;
    }
    throw new Error(`Unknown tool ${name}`);
  };

  const handle = async (request: JsonRpcRequest): Promise<void> => {
    const respond = (result: unknown): void => send({ jsonrpc: '2.0', id: request.id, result });
    const fail = (code: number, message: string): void => send({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    // Notifications (no id) get no answer, whatever the method.
    const isNotification = request.id === undefined || request.id === null;
    switch (request.method) {
      case 'initialize':
        respond({ protocolVersion: typeof request.params?.['protocolVersion'] === 'string' ? request.params['protocolVersion'] : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: TOOL.name, version: TOOL.version } });
        return;
      case 'ping':
        if (!isNotification) respond({});
        return;
      case 'tools/list':
        respond({ tools: TOOLS });
        return;
      case 'tools/call': {
        const name = String(request.params?.['name'] ?? '');
        const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
        try {
          respond({ content: [{ type: 'text', text: await call(name, args) }] });
        } catch (error) {
          // A failed analysis is a tool result the agent can read and act on, not a protocol error.
          respond({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
        return;
      }
      default:
        if (!isNotification) fail(-32601, `Method not found: ${request.method}`);
    }
  };

  return new Promise((done) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      queue = queue.then(() => handle(request)).catch((error: unknown) => log(`ng-checkup mcp: ${error instanceof Error ? error.message : String(error)}`));
    });
    lines.on('close', () => void queue.then(() => done()));
  });
}
