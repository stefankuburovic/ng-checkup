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

  it('is empty when dependencies are not installed', () => {
    const root = writeTemp({ 'package.json': '{}' });
    try {
      expect(buildDeprecationIndex(root).size).toBe(0);
    } finally {
      removeTemp(root);
    }
  });
});
