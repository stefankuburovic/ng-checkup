import { hookSelector, primoFactsOf, viewRootOf } from '../src/primo.js';
import { runCheckup } from '../src/index.js';
import { renderMarkdown } from '../src/report/markdown.js';
import type { Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

/** The module source of one view, in the shape Primo VE packages use. */
const VIEW_MODULE = [
  "var app = angular.module('viewCustom', ['angularLoad']);",
  "app.controller('shelfMapController', ['$http', function ($http) {",
  '  var vm = this;',
  "  vm.$onInit = function () { vm.callNumber = vm.parentCtrl.item.callNumber; $http.get('/map?cn=' + vm.callNumber); };",
  '}]);',
  "app.component('prmLocationItemsAfter', { bindings: { parentCtrl: '<' }, controller: 'shelfMapController', template: '<shelf-map></shelf-map>' });",
  "app.component('shelfMap', { template: '<a>Map</a>' });",
  "app.component('prmSearchBarAfter', { bindings: { parentCtrl: '<' }, controller: function () { this.q = this.parentCtrl.mainSearchField; } });",
  "window.browzine = { api: 'https://public-api.thirdiron.com' };",
].join('\n');

/** A Primo VE repository: a central package, one view with its source and its concatenated build, and a leftover copy outside the views. */
const PACKAGES: Record<string, string> = {
  '41NET_NETWORK-CENTRAL_PACKAGE/js/custom.js': "var app = angular.module('viewCustom', []);\napp.component('prmTopBarBefore', { bindings: { parentCtrl: '<' }, template: '<div>Network notice</div>' });\n",
  '41NET_INST-MAIN/js/custom.module.js': VIEW_MODULE,
  // The build: the same registrations again. Counting it doubled every number before 0.11.0.
  '41NET_INST-MAIN/js/custom.js': `(function(){\n"use strict";\n${VIEW_MODULE}\n})();\n`,
  '41NET_INST-MAIN/html/home_en.html': '<md-card><h2>Welcome</h2></md-card>',
  '41NET_INST-MAIN/html/homepage/homepage_de.html': '<md-card><h2>Willkommen</h2></md-card>',
  'old_primo.js': "angular.module('viewCustom').component('prmFacetAfter', { bindings: { parentCtrl: '<' } });",
};

describe('Primo VE customization packages', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  async function run(files: Record<string, string>, plan = true): Promise<Report> {
    root = writeTemp(files);
    return runCheckup(root, { offline: true, plan });
  }

  it('reads hooks, parentCtrl, integrations and home pages view by view, without counting the build or leftovers', async () => {
    const report = await run(PACKAGES);
    expect(report.checks.map((check) => check.id)).not.toContain('angularjs');
    const primo = report.checks[0];
    expect(primo?.id).toBe('primo-nde');
    expect(primo?.summary).toBe('Primo VE customization: 3 hooks in 2 views, 2 `parentCtrl` reads to rebuild for NDE.');
    const measures = Object.fromEntries((primo?.measures ?? []).map((measure) => [measure.id, measure.value]));
    expect(measures).toEqual({ 'primo-hooks': 3, 'primo-helper-components': 1, 'parentctrl-reads': 2, 'primo-integrations': 1 });
    const messages = primo?.findings.map((finding) => finding.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'Primo VE customizations do not carry over to NDE, announced as the only Primo UI from January 2028',
        '3 Primo hooks to rebuild across 2 views, with 1 helper component',
        '`parentCtrl` read in 2 places',
        '1 third-party integration to rebuild or replace',
        'A central package and 1 view',
        'Static home pages in 2 languages (de, en)',
      ]),
    );
    expect(primo?.findings.find((finding) => finding.message.startsWith('`parentCtrl`'))?.detail).toContain('Read most: `item.callNumber` (1), `mainSearchField` (1).')
    expect(report.checks.find((check) => check.id === 'version')?.summary).toBe('No `@angular/core`: a Primo VE customization package, on AngularJS (see Primo NDE migration).');
  });

  it('plans the move to NDE, central package first, in every report format', async () => {
    const report = await run(PACKAGES);
    const migration = report.migration;
    expect(migration?.mode).toBe('primo-nde');
    expect(migration?.targetLabel).toBe('Primo NDE');
    const items = Object.fromEntries((migration?.phases ?? []).flatMap((phase) => phase.items).map((item) => [item.title, item]));
    expect(items['Rebuild the central package first']?.count).toBe(1);
    expect(items['Rebuild each hook as an Angular component']?.count).toBe(3);
    expect(items['Replace `parentCtrl` reads']?.count).toBe(2);
    expect(items['Move `$http` requests to `HttpClient`']?.count).toBe(1);
    expect(items['Rebuild or replace BrowZine / LibKey (Third Iron)']).toBeDefined();
    expect(items['Move the static home pages']?.count).toBe(2);
    expect(renderMarkdown(report)).toContain('## Migration plan: Primo VE customizations (AngularJS) → Primo NDE');
  });

  it('leaves an ordinary AngularJS app to the AngularJS area', async () => {
    const report = await run({ 'package.json': JSON.stringify({ name: 'shop', dependencies: { angular: '1.8.3' } }), 'app/app.js': "angular.module('shop', []).component('cart', { template: '<p></p>' });\n" });
    expect(report.checks[0]?.id).toBe('angularjs');
    expect(report.migration?.mode).toBe('angularjs-only');
  });
});

describe('Primo helpers', () => {
  it('turns hook names into selectors and finds the view of a file', () => {
    expect(hookSelector('prmSearchResultAvailabilityLineAfter')).toBe('prm-search-result-availability-line-after');
    expect(hookSelector('shelfMap')).toBeUndefined();
    expect(viewRootOf('41SLSP_NETWORK-VU1_UNION/js/a/b.js')).toBe('41SLSP_NETWORK-VU1_UNION');
    expect(viewRootOf('js/custom.js')).toBe('.');
  });

  it('collects parentCtrl lines, $http calls and integrations from a file', () => {
    expect(primoFactsOf("angular.module('shop', []);")).toBeUndefined();
    const facts = primoFactsOf("angular.module('viewCustom', []);\nvar x = this.parentCtrl.a;\n$http.get('/x');\n$http({ url: '/y' });\nga('send'); // googletagmanager\n");
    expect(facts).toEqual({ viewCustom: true, parentCtrlLines: [2], parentCtrlPaths: ['a'], integrations: ['Google Analytics / Tag Manager'], httpCalls: 2 });
  });
});
