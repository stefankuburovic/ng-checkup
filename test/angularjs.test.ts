import { scanAngularJsTemplate } from '../src/angularjs.js';
import { runCheckup } from '../src/index.js';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { notesTemplate } from '../src/report/notes.js';
import type { Report } from '../src/types.js';
import { removeTemp, writeTemp } from './helpers.js';

/** An AngularJS 1.5 app in plain JavaScript, in the registration styles real apps use. */
const ANGULARJS_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { angular: '1.5.8', 'angular-route': '1.5.8', 'angular-ui-bootstrap': '^2.5.0' }, devDependencies: { 'angular-mocks': '1.5.8' } }),
  // The tutorial style: dots at line ends, chained off angular.module().
  'app/app.module.js': "angular.\n  module('shop', ['ngRoute']).\n  config(['$routeProvider', function ($routeProvider) {\n    $routeProvider.when('/cart', { template: '<cart></cart>' }).when('/list', { templateUrl: 'list.html' });\n  }]);\n",
  'app/cart/cart.component.js': "angular.module('shop').component('cart', {\n  templateUrl: 'cart/cart.html',\n  controller: function () { this.items = []; }\n});\n",
  // A module held in a variable, as ES-module AngularJS code does.
  'app/list/index.js': "import angular from 'angular';\nlet list = angular.module('shop.list', []);\nlist.controller('ListCtrl', ['$scope', '$rootScope', function ($scope, $rootScope) {\n  $scope.items = [];\n  $rootScope.$broadcast('list:loaded');\n  $scope.$watch('items', function () {}, true);\n}]);\nlist.factory('Items', ['$http', function ($http) { return {}; }]);\nlist.filter('price', function () { return function (value) { return value; }; });\n",
  // A module imported from elsewhere: not rooted, counted because the repo is AngularJS.
  'app/legacy/tooltip.js': "export default function register(app) {\n  app.directive('tooltip', function ($compile) {\n    var linker = $compile('<b></b>');\n    return { restrict: 'A', replace: true, compile: function () { return linker; } };\n  });\n}\n",
  'app/list/list.spec.js': "describe('ListCtrl', function () { angular.module('shop').controller('SpecOnlyCtrl', function ($scope) {}); });\n",
  'app/index.html': '<html ng-app="shop"><body><script src="https://ajax.googleapis.com/ajax/libs/angularjs/1.5.8/angular.min.js"></script><div ng-view></div></body></html>',
  'app/list.html': '<div ng-controller="ListCtrl"><p ng-repeat="item in items">{{item}}</p><div ng-include="\'footer.html\'"></div></div>',
  'app/cart/cart.html': '<ul><li ng-repeat="item in $ctrl.items" ng-click="$ctrl.remove(item)">{{item}}</li></ul>',
  // AngularJS's own build, checked in: not application code.
  'app/vendor/angular.js': '/**\n * @license AngularJS v1.5.8\n * (c) 2010-2016 Google, Inc. http://angularjs.org\n */\n(function(window) { angular.module = function () {}; })(window);\n',
};

/** A hybrid app in TypeScript: Angular components plus AngularJS code bridged with @angular/upgrade/static. */
const HYBRID_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'hybrid', dependencies: { '@angular/core': '^22.0.0', '@angular/upgrade': '^22.0.0', angular: '1.8.3' } }),
  'src/app.module.ts': "import { NgModule } from '@angular/core';\nimport { UpgradeModule } from '@angular/upgrade/static';\n@NgModule({ imports: [UpgradeModule] })\nexport class AppModule {\n  constructor(private upgrade: UpgradeModule) {}\n  ngDoBootstrap() { this.upgrade.bootstrap(document.body, ['app']); }\n}\n",
  'src/header.component.ts': "import { Component } from '@angular/core';\nimport { downgradeComponent } from '@angular/upgrade/static';\nimport * as angular from 'angular';\n@Component({ selector: 'app-header', template: '<h1>Shop</h1>' })\nexport class HeaderComponent {}\nangular.module('app').directive('appHeader', downgradeComponent({ component: HeaderComponent }));\n",
  'src/prices.service.ts': "import { Injectable } from '@angular/core';\nimport { downgradeInjectable } from '@angular/upgrade/static';\nimport * as angular from 'angular';\n@Injectable({ providedIn: 'root' })\nexport class PricesService {}\nangular.module('app').factory('prices', downgradeInjectable(PricesService));\n",
  'src/legacy-list.directive.ts': "import { Directive, ElementRef, Injector } from '@angular/core';\nimport { UpgradeComponent } from '@angular/upgrade/static';\n@Directive({ selector: 'legacy-list' })\nexport class LegacyListDirective extends UpgradeComponent {\n  constructor(element: ElementRef, injector: Injector) { super('legacyList', element, injector); }\n}\n",
  'src/legacy/list.component.ts': "import * as angular from 'angular';\nangular.module('app').component('legacyList', { template: '<p ng-repeat=\"x in $ctrl.xs\">{{x}}</p>' });\n",
  'src/legacy/orders.ts': "import * as angular from 'angular';\nangular.module('app').service('orders', class Orders {});\n",
};

describe('AngularJS', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) removeTemp(root);
    root = undefined;
  });

  async function check(files: Record<string, string>, plan = false): Promise<{ report: Report; result: Report['checks'][number] | undefined }> {
    root = writeTemp(files);
    const report = await runCheckup(root, { offline: true, plan });
    return { report, result: report.checks.find((entry) => entry.id === 'angularjs') };
  }

  it('counts an AngularJS app in every registration style, and leaves specs and vendored copies out', async () => {
    const { report, result } = await check(ANGULARJS_APP);
    expect(report.checks[0]?.id).toBe('angularjs');
    expect(result?.grade).toBe('poor');
    expect(result?.summary).toBe('AngularJS 1.5.8 app: 3 components, directives and controllers, 1 service and 2 templates to migrate.');
    const measures = Object.fromEntries((result?.measures ?? []).map((measure) => [measure.id, measure.value]));
    expect(measures).toEqual({ 'angularjs-components': 3, 'angularjs-controllers': 1, 'angularjs-services': 1, 'angularjs-filters': 1, 'angularjs-templates': 2, 'scope-files': 1 });
    const messages = result?.findings.map((finding) => finding.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'AngularJS 1.5.8 is end of life since January 2022',
        'Move to AngularJS 1.8 before anything else (now 1.5.8)',
        '1 controller registered with `.controller()`, 1 bound with `ng-controller`',
        '1 directive uses `compile`, `replace` or `terminal`',
        '`$scope` in 1 file',
        '1 scope event (`$broadcast`, `$emit`, `$rootScope.$on`) used as a message bus',
        '1 runtime `$compile` call',
        '1 `$watch` call',
        '`ng-include` in 1 template',
        '3 AngularJS packages to replace',
        'The AngularJS code is plain JavaScript (4 files)',
      ]),
    );
    const version = report.checks.find((entry) => entry.id === 'version');
    expect(version?.summary).toBe('No `@angular/core` yet: the app runs on AngularJS (see AngularJS migration).');
    // Nothing graded without TypeScript code: no free "good" for an AngularJS app.
    expect(report.checks.find((entry) => entry.id === 'circular-deps')?.grade).toBe('info');
    expect(report.checks.find((entry) => entry.id === 'change-detection')?.findings).toEqual([]);
  });

  it('measures how far a hybrid app has come, and counts downgraded code as migrated', async () => {
    const { result } = await check(HYBRID_APP);
    expect(result?.summary).toBe('Hybrid AngularJS 1.8.3 and Angular 22: 50% of components on Angular, 1 AngularJS component left.');
    expect(result?.metrics.find((metric) => metric.label === 'Mode')?.value).toBe('Hybrid (UpgradeModule)');
    expect(result?.measures?.find((measure) => measure.id === 'angularjs-services')?.value).toBe(1);
    const hybrid = result?.findings.find((finding) => finding.severity === 'info');
    expect(hybrid?.detail).toContain('1 downgraded and 1 upgraded components, 1 downgraded and 0 upgraded services');
  });

  it('ignores the same call shapes in a Vue app, and adds no check to an Angular app', async () => {
    const vue = await check({ 'package.json': JSON.stringify({ name: 'vue-app', dependencies: { vue: '^3.4.0' } }), 'src/main.js': "Vue.component('todo', { template: '<li></li>' });\nVue.filter('upper', (v) => v);\nVue.directive('focus', {});\n" });
    expect(vue.result).toBeUndefined();
    removeTemp(root!);
    const angular = await check({ 'package.json': JSON.stringify({ name: 'ng', dependencies: { '@angular/core': '^22.0.0' } }), 'src/app.component.ts': "import { Component } from '@angular/core';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent {}\n" });
    expect(angular.result).toBeUndefined();
    expect(angular.report.checks).toHaveLength(12);
  });

  it('calls packages without code leftovers', async () => {
    const { result, report } = await check({ 'package.json': JSON.stringify({ name: 'done', dependencies: { '@angular/core': '^22.0.0', '@angular/upgrade': '^22.0.0', angular: '1.8.3' } }), 'src/main.ts': "import { Component } from '@angular/core';\n" }, true);
    expect(result?.grade).toBe('fair');
    expect(result?.summary).toBe('AngularJS packages without AngularJS code: leftovers to remove.');
    expect(report.migration?.phases.map((phase) => phase.title)).toEqual(['Remove AngularJS']);
    expect(report.migration?.phases[0]?.items[0]?.command).toBe('npm uninstall angular @angular/upgrade');
  });

  it('plans the migration in four phases with this codebase counts, in every report format', async () => {
    const { report } = await check(ANGULARJS_APP, true);
    const migration = report.migration;
    expect(migration?.from).toBe('AngularJS 1.5.8');
    expect(migration?.mode).toBe('angularjs-only');
    expect(migration?.phases.map((phase) => phase.title)).toEqual(['Prepare on AngularJS', 'Run Angular next to AngularJS', 'Move piece by piece, bottom up', 'Remove AngularJS']);
    const items = Object.fromEntries((migration?.phases ?? []).flatMap((phase) => phase.items).map((item) => [item.title, item]));
    expect(items['Upgrade AngularJS to 1.8.3']?.command).toBe('npm install angular@1.8.3 angular-mocks@1.8.3 angular-route@1.8.3');
    expect(items['Turn controllers into components']?.count).toBe(1);
    expect(items['Let the two routers share the URL']?.count).toBe(2);
    expect(items['Move services to Angular, oldest dependencies first']?.count).toBe(1);
    expect(items['Replace `angular-ui-bootstrap`']).toBeDefined();
    expect(items['Move the AngularJS unit tests to `TestBed`']).toBeDefined();
    expect(items['Bootstrap Angular alone and uninstall AngularJS']?.command).toBe('npm uninstall angular angular-mocks angular-route angular-ui-bootstrap');

    expect(renderMarkdown(report)).toContain(`## Migration plan: AngularJS 1.5.8 → Angular ${migration?.to}`);
    expect(renderHtml(report)).toContain('id="migration-title"');
    report.client = { name: 'Acme' };
    const client = renderHtml(report);
    expect(client).toContain('id="migration-roadmap-title"');
    expect(client).toContain('<dt>AngularJS</dt><dd>1.5.8</dd>');
    expect(client).toContain('Leaving AngularJS takes 4 phases');
    expect(notesTemplate(report)).toContain('| 1. Prepare on AngularJS | Upgrade AngularJS to 1.8.3;');
  });

  it('skips a hybrid app\'s setup phase, and points at the Angular upgrade when the Angular side is old', async () => {
    const files = { ...HYBRID_APP, 'package.json': JSON.stringify({ name: 'hybrid', dependencies: { '@angular/core': '^19.0.0', '@angular/upgrade': '^19.0.0', angular: '1.8.3' } }) };
    const { report } = await check(files, true);
    const titles = report.migration?.phases.flatMap((phase) => phase.items.map((item) => item.title)) ?? [];
    expect(titles).not.toContain('Bootstrap both frameworks on one page');
    expect(titles).toContain(`Bring the Angular side up to ${report.migration?.to}`);
    expect(report.migration?.mode).toBe('hybrid');
    expect(report.plan?.from).toBe(19);
  });
});

describe('scanAngularJsTemplate', () => {
  it('counts AngularJS attributes, not class names or Angular elements', () => {
    expect(scanAngularJsTemplate('<div class="a ng-hide b"><ng-container *ngIf="x"></ng-container><ng-template></ng-template></div>').attributes).toBe(0);
    const stats = scanAngularJsTemplate('<div data-ng-repeat="x in xs" ng-controller="A"><ng-include src="\'a.html\'"></ng-include></div>');
    expect(stats).toEqual({ attributes: 2, controllers: 1, includes: 1, apps: 0 });
    expect(scanAngularJsTemplate('<script src="https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.7.9/angular.min.js"></script>').cdnVersion).toBe('1.7.9');
    expect(scanAngularJsTemplate('<script src="https://unpkg.com/angular@1.8.2/angular.js"></script>').cdnVersion).toBe('1.8.2');
  });
});
