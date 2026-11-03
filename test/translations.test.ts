import ts from 'typescript';
import { runCheckup } from '../src/index.js';
import { translationKeysInCode, translationKeysInTemplate } from '../src/translations.js';
import type { CheckResult } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

/** The translations area of a run with `--offline` over `files`. */
async function translations(files: Record<string, string>): Promise<CheckResult> {
  const root = writeTemp(files);
  try {
    const report = await runCheckup(root, { offline: true });
    return report.checks.find((check) => check.id === 'translations')!;
  } finally {
    removeTemp(root);
  }
}

/** An app on ngx-translate with `en` and `de` core bundles plus a feature bundle that shares the `general` namespace. */
function ngxApp(files: Record<string, string>): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^20.0.0', '@ngx-translate/core': '^17.0.0' } }),
    'src/assets/i18n/core/en.json': JSON.stringify({ general: { save: 'Save' }, orders: { title: 'Orders', 'cannot_delete.header': 'Cannot delete' } }),
    'src/assets/i18n/core/de.json': JSON.stringify({ general: { save: 'Speichern' }, orders: { title: 'Aufträge', 'cannot_delete.header': 'Nicht löschbar' } }),
    'src/assets/i18n/modules/tickets/en.json': JSON.stringify({ general: { cancel: 'Cancel' } }),
    'src/assets/i18n/modules/tickets/de.json': JSON.stringify({ general: { cancel: 'Abbrechen' } }),
    ...files,
  };
}

describe('translation keys', () => {
  it('reads pipe, directive and Transloco keys from a template, skipping comments and keys built at runtime', () => {
    const uses = translationKeysInTemplate(
      [
        `<h1>{{ 'orders.title' | translate }}</h1>`,
        `<!-- {{ 'orders.commented' | translate }} -->`,
        `<p>{{ "orders.list" | translate: { count: 2 } }}</p>`,
        `<span translate="general.save"></span><b [translate]="'general.cancel'"></b>`,
        `<i>{{ 'status.' + state | translate }} {{ prefix + 'suffix' | translate }} {{ state | translate }}</i>`,
      ].join('\n'),
    );
    expect(uses).toEqual([
      { key: 'orders.title', line: 1 },
      { key: 'orders.list', line: 3 },
      { key: 'general.save', line: 4 },
      { key: 'general.cancel', line: 4 },
    ]);
    expect(translationKeysInTemplate(`<ng-container *transloco="let t"><p>{{ t('home.title') }}</p></ng-container>`)).toEqual([{ key: 'home.title', line: 1 }]);
    // `read:` prefixes every key, which this does not resolve, so none is read.
    expect(translationKeysInTemplate(`<ng-container *transloco="let t; read: 'home'">{{ t('title') }}</ng-container>`)).toEqual([]);
  });

  it('reads keys from a translation service call or a marker, not from any get()', () => {
    const source = ts.createSourceFile(
      'x.ts',
      [
        `this.translate.instant('orders.title');`,
        `this.translateService.get('orders.list').subscribe();`,
        `this.transloco.translate('home.title');`,
        `this.http.get('api.orders');`,
        `this.translate.instant(key);`,
        `const label = marker('general.save');`,
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(translationKeysInCode(source)).toEqual([
      { key: 'orders.title', line: 1 },
      { key: 'orders.list', line: 2 },
      { key: 'home.title', line: 3 },
      { key: 'general.save', line: 6 },
    ]);
  });
});

describe('the translations check', () => {
  it('finds a key missing in one language, a typo under a known namespace, and keeps an unknown namespace apart', async () => {
    const check = await translations(
      ngxApp({
        'src/assets/i18n/core/en.json': JSON.stringify({ general: { save: 'Save' }, orders: { title: 'Orders', 'cannot_delete.header': 'Cannot delete', export: 'Export' } }),
        'src/app/orders.component.html': [
          `{{ 'orders.title' | translate }} {{ 'orders.cannot_delete.header' | translate }}`,
          `{{ 'general.save' | translate }} {{ 'general.cancel' | translate }}`,
          `{{ 'orders.export' | translate }}`,
          `{{ 'orders.titel' | translate }}`,
          `{{ 'library.close' | translate }}`,
        ].join('\n'),
        'src/app/orders.component.spec.ts': `translate.instant('orders.made_up_for_the_test');`,
      }),
    );
    expect(check.grade).toBe('fair');
    expect(check.measures).toEqual([{ id: 'missing-keys', label: 'Translation keys that resolve to no string', value: 2 }]);
    const [missing, unknown] = check.findings;
    expect(missing?.message).toBe('2 translation keys resolve to no string in at least one language');
    // `orders.export` is in en only, `orders.titel` in neither; the spec's key is not counted.
    expect(missing?.detail).toContain('`orders.export` (de), `orders.titel`.');
    expect(missing?.files).toEqual([
      { path: 'src/app/orders.component.html', line: 3 },
      { path: 'src/app/orders.component.html', line: 4 },
    ]);
    expect(unknown?.message).toBe('1 translation key under a namespace no bundle has');
  });

  it('is good when every key resolves, and info without a translation library or a bundle', async () => {
    const good = await translations(ngxApp({ 'src/app/a.component.html': `{{ 'general.save' | translate }} {{ 'general.cancel' | translate }}` }));
    expect(good.grade).toBe('good');
    expect(good.summary).toBe('All 2 literal translation keys resolve in de, en.');

    const noLibrary = await translations({ 'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } }), 'src/assets/i18n/en.json': '{}', 'src/a.html': `{{ 'x.y' | translate }}` });
    expect(noLibrary.grade).toBe('info');
    const noBundle = await translations({ 'package.json': JSON.stringify({ dependencies: { '@ngx-translate/core': '^17.0.0' } }), 'src/a.html': `{{ 'x.y' | translate }}` });
    expect(noBundle.grade).toBe('info');
  });

  it('looks up Transloco scopes under the folder name', async () => {
    const check = await translations({
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', '@jsverse/transloco': '^7.0.0' } }),
      'src/assets/i18n/en.json': JSON.stringify({ home: { title: 'Home' } }),
      'src/assets/i18n/admin/en.json': JSON.stringify({ users: 'Users' }),
      'src/app/a.component.html': `{{ 'home.title' | transloco }} {{ 'admin.users' | transloco }} {{ 'admin.roles' | transloco }}`,
    });
    expect(check.measures?.[0]?.value).toBe(1);
    expect(check.findings[0]?.detail).toContain('`admin.roles`');
  });
});
