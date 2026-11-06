import { parseMessages } from '../src/i18n.js';
import { runCheckup } from '../src/index.js';
import { removeTemp, writeTemp } from './helpers.js';

const xlf12 = (units: string): string => `<?xml version="1.0"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n<file source-language="en" datatype="plaintext"><body>\n${units}\n</body></file></xliff>\n`;
const xlf20 = (units: string): string => `<?xml version="1.0"?>\n<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0" srcLang="en">\n<file id="ngi18n">\n${units}\n</file></xliff>\n`;
const unit = (id: string, target = '', attributes = ''): string => `<trans-unit id="${id}" datatype="html"${attributes}><source>Hello</source>${target}</trans-unit>`;

describe('reading translation files', () => {
  it('reads XLIFF 1.2: ids, lines, empty targets and states', () => {
    const units = parseMessages(xlf12([unit('a', '<target>Hallo</target>'), unit('b'), unit('c', '<target></target>'), unit('d', '<target/>'), unit('e', '<target state="new">Hello</target>'), unit('f', '<target state="translated">Hallo</target>'), unit('g', '<target state="needs-translation">Hallo</target>'), unit('h', '<target><x id="INTERPOLATION"/></target>')].join('\n')), 'a.xlf')!;
    expect(units.map((entry) => [entry.id, entry.line, entry.empty, entry.needsTranslation])).toEqual([
      ['a', 4, false, false],
      ['b', 5, true, false],
      ['c', 6, true, false],
      ['d', 7, true, false],
      ['e', 8, false, true],
      ['f', 9, false, false],
      ['g', 10, false, false],
      ['h', 11, false, false],
    ]);
  });

  it('compares target and source with spacing and inline tags as written', () => {
    const units = parseMessages(xlf12(`<trans-unit id="a"><source>Hi <x id="I"/>\n  there</source><target state="new">Hi <x id="I"/> there</target></trans-unit>\n<trans-unit id="b"><source>Hi <x id="I"/></source><target state="new">Hallo <x id="I"/></target></trans-unit>`), 'a.xlf')!;
    expect(units.map((entry) => entry.needsTranslation)).toEqual([true, false]);
  });

  it('leaves out comments, alternative translations and translate="no"', () => {
    const units = parseMessages(xlf12(['<!-- <trans-unit id="old"><target>x</target></trans-unit> -->', '<trans-unit id="a"><source>s</source><alt-trans><target>alt</target></alt-trans></trans-unit>', unit('b', '<target>t</target>', ' translate="no"')].join('\n')), 'a.xlf')!;
    expect(units.map((entry) => [entry.id, entry.empty])).toEqual([['a', true]]);
  });

  it('reads XLIFF 2.0, with the state on the segment', () => {
    const units = parseMessages(xlf20(['<unit id="a"><segment state="translated"><source>s</source><target>t</target></segment></unit>', '<unit id="b"><segment state="initial"><source>s</source><target>s</target></segment></unit>', '<unit id="c"><segment><source>s</source></segment></unit>', '<unit id="d"><segment><source>s</source><target>t</target></segment><segment><source>s</source><target></target></segment></unit>'].join('\n')), 'a.xlf')!;
    expect(units.map((entry) => [entry.id, entry.empty, entry.needsTranslation])).toEqual([['a', false, false], ['b', false, true], ['c', true, false], ['d', true, false]]);
  });

  it('reads Angular JSON and ARB, and says when it cannot', () => {
    expect(parseMessages('{"locale":"de","translations":{"a":"x","b":""}}', 'm.de.json')!.map((entry) => [entry.id, entry.empty])).toEqual([['a', false], ['b', true]]);
    expect(parseMessages('{"@@locale":"de","a":"x","@a":{"description":"d"}}', 'm.de.arb')!.map((entry) => entry.id)).toEqual(['a']);
    expect(parseMessages('not xliff', 'a.xlf')).toBeUndefined();
    expect(parseMessages('{"a":"x"}', 'a.json')).toBeUndefined();
    expect(parseMessages('{', 'a.json')).toBeUndefined();
    expect(parseMessages('<messagebundle/>', 'a.xmb')).toBeUndefined();
  });
});

describe('built-in i18n in the translations area', () => {
  let root = '';
  afterEach(() => removeTemp(root));

  const app = (i18n: unknown, files: Record<string, string>, extract: unknown = {}): string =>
    writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } }),
      'angular.json': JSON.stringify({ projects: { shop: { root: '', sourceRoot: 'src', projectType: 'application', i18n, architect: { build: { builder: '@angular/build:application', options: { browser: 'src/main.ts' } }, 'extract-i18n': { builder: '@angular/build:extract-i18n', options: extract } } } } }),
      'src/main.ts': 'export {};',
      ...files,
    });
  const check = async () => (await runCheckup(root, { offline: true })).checks.find((entry) => entry.id === 'translations')!;
  const measures = (result: Awaited<ReturnType<typeof check>>) => Object.fromEntries(result.measures!.map((measure) => [measure.id, measure.value]));

  const source = xlf12([unit('a'), unit('b'), unit('c'), unit('d')].join('\n'));
  const german = xlf12([unit('a', '<target>x</target>'), unit('b', '<target></target>'), unit('c', '<target state="new">Hello</target>'), unit('gone', '<target>z</target>')].join('\n'));

  it('compares each locale with the source file, ungraded', async () => {
    root = app({ sourceLocale: 'en', locales: { de: 'src/locale/messages.de.xlf' } }, { 'src/locale/messages.xlf': source, 'src/locale/messages.de.xlf': german });
    const result = await check();
    expect(result.grade).toBe('info');
    expect(measures(result)).toEqual({ 'i18n-missing': 2, 'i18n-not-done': 1, 'i18n-obsolete': 1 });
    const missing = result.findings.find((finding) => finding.message.includes('without a translation'))!;
    expect(missing).toMatchObject({ severity: 'medium', count: 1 });
    expect(missing.files).toEqual([{ path: 'src/locale/messages.de.xlf', line: 5 }]);
    expect(missing.detail).toContain('`b` (de), `d` (de)');
    expect(missing.detail).toContain('ng extract-i18n');
    expect(result.findings.find((finding) => finding.message.includes('not done'))).toMatchObject({ severity: 'low', files: [{ path: 'src/locale/messages.de.xlf', line: 6 }] });
    expect(result.findings.find((finding) => finding.message.includes('no longer'))).toMatchObject({ severity: 'low', files: [{ path: 'src/locale/messages.de.xlf', line: 7 }] });
  });

  it('accepts every spelling of a locale, and merges a list of files', async () => {
    root = app(
      { sourceLocale: { code: 'en', baseHref: '/' }, locales: { de: { translation: ['src/locale/a.de.xlf', 'src/locale/b.de.xlf'], baseHref: '/de/' }, fr: { translation: 'src/locale/messages.fr.xlf' } } },
      { 'src/locale/messages.xlf': xlf12(unit('a')), 'src/locale/a.de.xlf': xlf12(unit('a')), 'src/locale/b.de.xlf': xlf12(unit('a', '<target>x</target>')), 'src/locale/messages.fr.xlf': xlf12(unit('a', '<target>y</target>')) },
    );
    expect(measures(await check())['i18n-missing']).toBe(0);
  });

  it('finds the source file extract-i18n writes, and never takes a translation for it', async () => {
    root = app({ locales: { de: 'i18n/de.xlf' } }, { 'i18n/out.xlf': source, 'i18n/de.xlf': xlf12(unit('a', '<target>x</target>')) }, { outputPath: 'i18n', outFile: 'out.xlf' });
    expect(measures(await check())['i18n-missing']).toBe(3);
    removeTemp(root);
    root = app({ locales: { de: 'src/messages.xlf' } }, { 'src/messages.xlf': xlf12(unit('a', '<target>x</target>')) });
    const result = await check();
    expect(measures(result)).toEqual({ 'i18n-missing': 0, 'i18n-not-done': 0, 'i18n-obsolete': 0 });
    expect(result.findings.some((finding) => finding.message.includes('No i18n source file'))).toBe(true);
  });

  it('without a source file it still reads states, and says what it could not compare', async () => {
    root = app({ locales: { de: 'translations/de.xlf' } }, { 'translations/de.xlf': xlf12(unit('a', '<target state="new">Hello</target>')) });
    const result = await check();
    expect(measures(result)).toEqual({ 'i18n-missing': 0, 'i18n-not-done': 1, 'i18n-obsolete': 0 });
    expect(result.summary).toContain('no source file');
  });

  it('lists a missing file or an unknown format instead of treating it as empty', async () => {
    root = app({ locales: { de: 'src/locale/messages.de.xtb', fr: 'src/locale/messages.fr.xlf' } }, { 'src/locale/messages.xlf': source, 'src/locale/messages.de.xtb': '<translationbundle/>' });
    const result = await check();
    expect(result.findings.find((finding) => finding.message.includes('not read'))).toMatchObject({ severity: 'info', count: 2 });
  });

  it('adds nothing for an app in one language, and sits beside a library', async () => {
    root = app(undefined, {});
    expect((await check()).measures).toBeUndefined();
    removeTemp(root);
    root = writeTemp({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', '@ngx-translate/core': '^15.0.0' } }),
      'angular.json': JSON.stringify({ projects: { shop: { root: '', sourceRoot: 'src', projectType: 'application', i18n: { locales: { de: 'src/locale/messages.de.xlf' } } } } }),
      'src/assets/i18n/en.json': '{"a":"x"}',
      'src/a.ts': "import { TranslateService } from '@ngx-translate/core';\nexport class A { constructor(t: TranslateService) { t.instant('a'); } }\n",
      'src/locale/messages.xlf': source,
      'src/locale/messages.de.xlf': german,
    });
    expect(Object.keys(measures(await check())).sort()).toEqual(['i18n-missing', 'i18n-not-done', 'i18n-obsolete', 'missing-keys']);
  });
});
