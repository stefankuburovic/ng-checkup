import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFleetList, runFleet } from '../src/fleet.js';
import { renderFleetHtml, renderFleetMarkdown } from '../src/report/fleet.js';
import { removeTemp, writeTemp } from './helpers.js';

describe('fleet', () => {
  it('reads a list with comments and relative paths, keeps remote entries as written', () => {
    const root = writeTemp({ 'repos.txt': '# front ends\n./shop\n\nadmin   # the back office\ngithub:acme/portal#release\n' });
    try {
      expect(readFleetList(join(root, 'repos.txt'))).toEqual([
        { entry: './shop', target: join(root, 'shop') },
        { entry: 'admin', target: join(root, 'admin') },
        { entry: 'github:acme/portal#release', target: 'github:acme/portal#release' },
      ]);
      writeFileSync(join(root, 'empty.txt'), '# nothing\n');
      expect(() => readFleetList(join(root, 'empty.txt'))).toThrow('names no repository');
    } finally {
      removeTemp(root);
    }
  });

  it('ranks the repositories worst first and keeps a failed entry as a row', async () => {
    const root = writeTemp({
      'legacy/package.json': JSON.stringify({ name: 'legacy', dependencies: { '@angular/core': '12.0.0' }, devDependencies: { karma: '^6.0.0' } }),
      'legacy/src/a.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-a', template: '' })\nexport class AComponent {}\n",
      'modern/package.json': JSON.stringify({ name: 'modern', dependencies: { '@angular/core': '^22.0.0' } }),
    });
    try {
      const report = await runFleet([
        { entry: 'modern', target: join(root, 'modern') },
        { entry: 'gone', target: join(root, 'gone') },
        { entry: 'legacy', target: join(root, 'legacy') },
      ]);
      expect(report.rows.map((row) => row.name)).toEqual(['legacy', 'modern', 'gone']);
      expect(report.rows[2]?.error).toContain('no such folder');
      expect(report.rows[0]?.grades['testing']).toBe('poor');
      expect(renderFleetMarkdown(report)).toContain('| **legacy** | 12.0.0 |');
      expect(renderFleetHtml(report)).toContain('not checked: no such folder');
    } finally {
      removeTemp(root);
    }
  });
});
