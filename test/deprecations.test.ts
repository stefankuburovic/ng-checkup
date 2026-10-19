import { buildDeprecationIndex } from '../src/deprecations.js';
import { fixture, removeTemp, writeTemp } from './helpers.js';

describe('buildDeprecationIndex', () => {
  const index = buildDeprecationIndex(fixture('deprecations-app'));
  const core = index.get('@angular/core');
  const common = index.get('@angular/common');

  it('follows re-exports from chunk files, including renamed ones', () => {
    expect(core?.members.get('ChangeDetectionStrategy.Default')).toEqual({ since: undefined, message: 'Use `Eager` instead.' });
    expect(core?.symbols.get('provideLegacyThing')).toEqual({ since: '18', message: 'Nothing replaces it.' });
  });

  it('parses the version however Angular writes it', () => {
    expect(core?.symbols.get('APP_INITIALIZER')).toEqual({ since: '19.0.0', message: 'use provideAppInitializer instead' });
    expect(common?.symbols.get('NgIf')).toEqual({ since: '20.0', message: 'Use the `@if` block instead. Intent to remove in a future major release' });
  });

  it('does not flag a function for one deprecated overload, private names, or untagged exports', () => {
    expect(core?.symbols.has('inject')).toBe(false);
    expect(core?.symbols.has('ɵInternalThing')).toBe(false);
    expect(core?.symbols.has('Component')).toBe(false);
    expect(common?.symbols.has('AsyncPipe')).toBe(false);
  });

  it('reads secondary entry points of packages that predate the exports map (Angular 12 and older)', () => {
    const root = writeTemp({
      'node_modules/@angular/core/package.json': JSON.stringify({ name: '@angular/core', version: '12.2.17', typings: './core.d.ts' }),
      'node_modules/@angular/core/core.d.ts': '/** @deprecated since v8. Use `Injector.create()` instead. */\nexport declare class ReflectiveInjector {}\n',
      'node_modules/@angular/core/testing/package.json': JSON.stringify({ name: '@angular/core/testing', typings: '../testing.d.ts' }),
      'node_modules/@angular/core/testing.d.ts': '/** @deprecated use `waitForAsync()` instead. */\nexport declare function async(fn: Function): unknown;\n',
      'node_modules/@angular/core/schematics/package.json': JSON.stringify({ typings: './ignored.d.ts' }),
    });
    try {
      const legacy = buildDeprecationIndex(root);
      expect(legacy.get('@angular/core')?.symbols.get('ReflectiveInjector')).toEqual({ since: '8', message: 'Use `Injector.create()` instead.' });
      expect(legacy.get('@angular/core/testing')?.symbols.get('async')).toEqual({ since: undefined, message: 'use `waitForAsync()` instead.' });
      expect([...legacy.keys()].sort()).toEqual(['@angular/core', '@angular/core/testing']);
    } finally {
      removeTemp(root);
    }
  });

  it('is empty when dependencies are not installed', () => {
    const root = writeTemp({ 'package.json': '{}' });
    try {
      expect(buildDeprecationIndex(root).size).toBe(0);
    } finally {
      removeTemp(root);
    }
  });
});
