import { PassThrough } from 'node:stream';
import { serveMcp } from '../src/mcp.js';
import { removeTemp, writeTemp } from './helpers.js';

/** Sends `requests` as one session and returns every answer, parsed, in order. */
async function session(requests: unknown[]): Promise<Array<Record<string, any>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString()));
  const served = serveMcp(input, output, () => {});
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
  input.end();
  await served;
  return written
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

describe('the MCP server', () => {
  it('initializes, lists its tools, answers a tool call and rejects an unknown method, and stays silent on notifications', async () => {
    const root = writeTemp({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0' } }),
      'src/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '' })\nexport class AComponent {\n  ngOnInit() { this.store.list$.subscribe(); }\n}\n",
    });
    try {
      const answers = await session([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'findings', arguments: { path: root, file: 'src/a.component.ts' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'checkup', arguments: { path: root, only: ['components'] } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'checkup', arguments: { path: root, project: 'missing' } } },
        { jsonrpc: '2.0', id: 6, method: 'resources/list' },
      ]);
      expect(answers.map((answer) => answer['id'])).toEqual([1, 2, 3, 4, 5, 6]);
      expect(answers[0]?.['result']).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ng-checkup' } });
      expect(answers[1]?.['result'].tools.map((tool: { name: string }) => tool.name)).toEqual(['checkup', 'findings', 'upgrade_plan']);

      const findings = JSON.parse(answers[2]?.['result'].content[0].text);
      expect(findings.findings.map((finding: { check: string; message: string }) => `${finding.check}: ${finding.message}`)).toContain('components: 1 `.subscribe()` call in components and directives that nothing ever ends');
      expect(answers[3]?.['result'].content[0].text).toContain('# Angular checkup: app');
      // A failed run is a tool result the agent can read, not a protocol error.
      expect(answers[4]?.['result']).toMatchObject({ isError: true });
      expect(answers[5]?.['error']).toMatchObject({ code: -32601 });
    } finally {
      removeTemp(root);
    }
  });
});
