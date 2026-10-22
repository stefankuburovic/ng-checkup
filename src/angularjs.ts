import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isTestCode, toReportPath } from './files.js';

/** The AngularJS registration methods that define something a migration has to move. */
export type RegistrationKind = 'component' | 'directive' | 'controller' | 'service' | 'factory' | 'provider' | 'filter';

const REGISTRATION_KINDS = new Set<RegistrationKind>(['component', 'directive', 'controller', 'service', 'factory', 'provider', 'filter']);

/** One `.controller('Name', …)`, `.component('name', …)` and so on. */
export interface Registration {
  kind: RegistrationKind;
  name: string;
  line: number;
  /**
   * True when the call chain starts at `angular.module(…)`, directly or
   * through a variable this file assigned from it. False for `app.controller()`
   * on a module that came from somewhere else, which is only counted when the
   * repository shows other AngularJS evidence: Vue registers components,
   * directives and filters with the same call shape.
   */
  rooted: boolean;
  /**
   * True for `.factory('X', downgradeInjectable(X))` and
   * `.directive('x', downgradeComponent(…))`: an Angular class made available
   * to AngularJS. That is migrated code, not code left to migrate.
   */
  downgraded: boolean;
}

/** A directive definition object using what `UpgradeComponent` rejects. */
export interface LegacyDirective {
  line: number;
  /** Which of `compile`, `replace`, `terminal` it sets. */
  keys: string[];
}

/** Everything the AngularJS check needs from one JavaScript or TypeScript file. */
export interface AngularJsFileFacts {
  /** Report path. */
  path: string;
  language: 'js' | 'ts';
  isSpec: boolean;
  /** Non-blank lines. */
  linesOfCode: number;
  /** Lines of `angular.module('x', [...])`, the form that defines a module (one argument only looks it up). */
  moduleDefinitions: number[];
  registrations: Registration[];
  /** Lines mentioning `$scope`, as a parameter, a string in an injection array, or a reference. */
  scopeLines: number[];
  /** `$rootScope.$broadcast/$emit/$on` and `$scope.$broadcast/$emit`: events used as a message bus. */
  scopeEventLines: number[];
  /** `$watch`, `$watchCollection` and `$watchGroup` calls. */
  watcherLines: number[];
  /** Calls of an injected `$compile`: templates compiled at runtime. */
  compileLines: number[];
  legacyDirectives: LegacyDirective[];
  /** `$routeProvider.when(…)` and `$stateProvider.state(…)`: routes to move to the Angular router. */
  routeLines: number[];
  /** `class X extends UpgradeComponent`: an AngularJS component wrapped for use in Angular. */
  upgradedComponents: number;
  /** Provider objects whose `deps` include `'$injector'`: AngularJS services made injectable in Angular. */
  upgradedServices: number;
}

/**
 * Cheap test before a parse: files without any of these strings cannot hold
 * AngularJS code, and a monorepo's Node backend can have thousands of them.
 * Whitespace around the dots is allowed: the AngularJS tutorial itself writes
 * `angular.` and `module('x').` at line ends.
 */
const CANDIDATE = /angular\s*\.\s*module|\$scope|\$rootScope|\$compile|\$routeProvider|\$stateProvider|UpgradeComponent|\$injector|\.\s*(controller|directive|component|service|factory|provider|filter)\s*\(\s*['"`]/;

/**
 * The version in the license header AngularJS ships in every build
 * (`@license AngularJS v1.5.8`). A file that carries it is a copy of the
 * framework, not application code.
 */
const ANGULARJS_LICENSE = /@license AngularJS v(1\.\d+\.\d+)/;

/** What `scanAngularJsFile` found: the facts, a vendored copy of AngularJS itself, or nothing worth keeping. */
export type AngularJsScan = { facts: AngularJsFileFacts } | { vendoredVersion: string } | undefined;

/**
 * Reads one file for AngularJS code. Syntax-only, like `scanSourceFile`, and
 * it runs on `.js` as well as `.ts` files, since most AngularJS code is
 * plain JavaScript.
 *
 * Skips, by returning undefined: files that cannot contain AngularJS code
 * (see `CANDIDATE`), minified files (very long lines), and files where
 * nothing was found. A copy of `angular.js` itself returns its version
 * instead, which is how an app that loads AngularJS from a checked-in file
 * still gets a version in the report.
 */
export function scanAngularJsFile(root: string, absolutePath: string, text = readFileSync(absolutePath, 'utf8')): AngularJsScan {
  const head = text.slice(0, 2000);
  const vendored = ANGULARJS_LICENSE.exec(head);
  if (vendored) return { vendoredVersion: vendored[1]! };
  if (!CANDIDATE.test(text) || isMinified(text)) return undefined;

  const language = absolutePath.endsWith('.ts') ? 'ts' : 'js';
  const source = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, language === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const path = toReportPath(root, absolutePath);
  const facts: AngularJsFileFacts = {
    path,
    language,
    isSpec: isTestCode(path),
    linesOfCode: text.split('\n').filter((line) => line.trim() !== '').length,
    moduleDefinitions: [],
    registrations: [],
    scopeLines: [],
    scopeEventLines: [],
    watcherLines: [],
    compileLines: [],
    legacyDirectives: [],
    routeLines: [],
    upgradedComponents: 0,
    upgradedServices: 0,
  };
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const addLine = (lines: number[], node: ts.Node): void => {
    const line = lineOf(node);
    if (lines[lines.length - 1] !== line) lines.push(line);
  };

  /** Variables this file assigned from `angular.module(…)`, so `homeModule.controller()` counts as rooted. */
  const moduleVariables = new Set<string>();
  const collectModuleVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isModuleChain(node.initializer, moduleVariables)) moduleVariables.add(node.name.text);
    ts.forEachChild(node, collectModuleVariables);
  };
  collectModuleVariables(source);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (isAngularModuleCall(node)) {
        if (node.arguments.length >= 2) facts.moduleDefinitions.push(lineOf(node));
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const [first, second] = node.arguments;
        const name = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
        if (REGISTRATION_KINDS.has(method as RegistrationKind) && name !== undefined && second !== undefined) {
          facts.registrations.push({ kind: method as RegistrationKind, name, line: lineOf(node), rooted: isModuleChain(callee.expression, moduleVariables), downgraded: isDowngradeCall(second) });
        } else if (method === '$watch' || method === '$watchCollection' || method === '$watchGroup') {
          facts.watcherLines.push(lineOf(node));
        } else if (isScopeEvent(callee)) {
          facts.scopeEventLines.push(lineOf(node));
        } else if ((method === 'when' && chainRoot(callee) === '$routeProvider') || (method === 'state' && chainRoot(callee) === '$stateProvider')) {
          facts.routeLines.push(lineOf(node));
        }
      } else if (ts.isIdentifier(callee) && callee.text === '$compile') {
        facts.compileLines.push(lineOf(node));
      }
    } else if (ts.isIdentifier(node) && node.text === '$scope') {
      addLine(facts.scopeLines, node);
    } else if (ts.isStringLiteral(node) && node.text === '$scope') {
      addLine(facts.scopeLines, node);
    } else if (ts.isObjectLiteralExpression(node)) {
      const legacy = legacyDirectiveKeys(node);
      if (legacy.length > 0) facts.legacyDirectives.push({ line: lineOf(node), keys: legacy });
      if (isUpgradedServiceProvider(node)) facts.upgradedServices++;
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const extendsClause = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
      const base = extendsClause?.types[0]?.expression;
      if (base && ts.isIdentifier(base) && base.text === 'UpgradeComponent') facts.upgradedComponents++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const found =
    facts.moduleDefinitions.length +
    facts.registrations.length +
    facts.scopeLines.length +
    facts.compileLines.length +
    facts.routeLines.length +
    facts.upgradedComponents +
    facts.upgradedServices;
  return found > 0 ? { facts } : undefined;
}

/** `angular.module(…)`, also on a namespace or default import named `angular`. */
function isAngularModuleCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'module' && ts.isIdentifier(callee.expression) && callee.expression.text === 'angular';
}

/**
 * True when `expression` is, or ends a chain that starts at,
 * `angular.module(…)`: `angular.module('a').controller(…).service(…)` and
 * `homeModule` after `let homeModule = angular.module('app.home', [])`.
 */
function isModuleChain(expression: ts.Expression, moduleVariables: Set<string>): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isIdentifier(current)) return moduleVariables.has(current.text);
    else if (ts.isCallExpression(current)) {
      if (isAngularModuleCall(current)) return true;
      if (!ts.isPropertyAccessExpression(current.expression)) return false;
      current = current.expression.expression;
    } else return false;
  }
}

/** The identifier a call chain such as `$routeProvider.when(…).when(…)` starts at. */
function chainRoot(callee: ts.PropertyAccessExpression): string | undefined {
  let current: ts.Expression = callee.expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) current = current.expression.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

/** `downgradeInjectable(X)` or `downgradeComponent({…})`, by name: that is what the upgrade guide writes. */
function isDowngradeCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return name === 'downgradeInjectable' || name === 'downgradeComponent';
}

/** `$rootScope.$broadcast/$emit/$on` or `$scope.$broadcast/$emit`. `$scope.$on` is left out: mostly `$destroy` cleanup, not a message bus. */
function isScopeEvent(callee: ts.PropertyAccessExpression): boolean {
  const receiver = callee.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const method = callee.name.text;
  if (receiver.text === '$rootScope') return method === '$broadcast' || method === '$emit' || method === '$on';
  return receiver.text === '$scope' && (method === '$broadcast' || method === '$emit');
}

/** Keys that only a directive definition object has, so `{ replace: true }` elsewhere is not mistaken for one. */
const DIRECTIVE_KEYS = new Set(['restrict', 'link', 'template', 'templateUrl', 'transclude', 'require', 'bindToController', 'controllerAs', 'priority', 'scope']);

/**
 * The keys of a directive definition object that `UpgradeComponent` refuses
 * (it throws "Upgraded directive … contains unsupported feature"): `compile`,
 * `replace: true` and `terminal: true`. Empty for any other object.
 */
function legacyDirectiveKeys(node: ts.ObjectLiteralExpression): string[] {
  const keys = new Map<string, ts.Node>();
  for (const property of node.properties) {
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
    if (name) keys.set(name, property);
  }
  if (![...keys.keys()].some((key) => DIRECTIVE_KEYS.has(key))) return [];
  const isTrue = (key: string): boolean => {
    const property = keys.get(key);
    return property !== undefined && ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  };
  const legacy: string[] = [];
  if (keys.has('compile')) legacy.push('compile');
  if (isTrue('replace')) legacy.push('replace');
  if (isTrue('terminal')) legacy.push('terminal');
  return legacy;
}

/** `{ provide: X, useFactory: (i) => i.get('heroes'), deps: ['$injector'] }`. */
function isUpgradedServiceProvider(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'deps' &&
      ts.isArrayLiteralExpression(property.initializer) &&
      property.initializer.elements.some((element) => ts.isStringLiteral(element) && element.text === '$injector'),
  );
}

/**
 * True for a minified file: some line longer than 1 000 characters within
 * the first 20 lines. Hand-written code never has one; a bundle or a
 * `.min.js` always does.
 */
function isMinified(text: string): boolean {
  return text
    .split('\n', 20)
    .some((line) => line.length > 1000);
}

/** AngularJS attributes in one HTML file. */
export interface AngularJsTemplateStats {
  /** `ng-*="…"` and `data-ng-*="…"` attributes, which Angular templates never use. Bootstrap attributes such as `ng-app` are left out. */
  attributes: number;
  /** `ng-controller`: a controller bound in the template, which ngUpgrade cannot bridge. */
  controllers: number;
  /** `ng-include`: templates pulled in at runtime, with no Angular equivalent. */
  includes: number;
  /** `ng-app`: where AngularJS bootstraps. */
  apps: number;
  /** The AngularJS version in a CDN `<script>` URL, such as `…/angularjs/1.8.2/angular.min.js`. */
  cdnVersion?: string;
}

/**
 * Counts AngularJS syntax in a template. Only attributes with a value are
 * counted (`ng-repeat="…"`): `class="a ng-hide b"` would otherwise match, and
 * Angular's own `<ng-container>`/`<ng-template>` are elements, not attributes.
 */
export function scanAngularJsTemplate(text: string): AngularJsTemplateStats {
  const count = (pattern: RegExp): number => (text.match(pattern) ?? []).length;
  const cdn = /<script[^>]+src=["'][^"']*angular(?:js|\.js)?[/@](1\.\d+\.\d+)[^"']*["']/i.exec(text);
  return {
    // Bootstrap attributes (`ng-app`, `ng-strict-di`, `ng-csp`, `ng-jq`) mark the host page, not a template to rewrite.
    // `ng-reflect-*` and `ng-version` are what Angular itself writes into the DOM in dev mode; they end up in
    // templates pasted from the browser's dev tools (an Ionic app's notifications page had a dozen).
    attributes: count(/\s(?:data-)?ng-(?!(?:app|strict-di|csp|jq|version|reflect-[a-z-]+)\b)[a-z][a-z-]*\s*=\s*["']/g),
    controllers: count(/\s(?:data-)?ng-controller\s*=\s*["']/g),
    includes: count(/\s(?:data-)?ng-include\s*=\s*["']|<ng-include[\s>]/g),
    apps: count(/\s(?:data-)?ng-app(?:\s*=|[\s>])/g),
    ...(cdn ? { cdnVersion: cdn[1]! } : {}),
  };
}

/** `dependencies.angular` (or `devDependencies`) of `bower.json` at the root: how AngularJS apps installed packages before npm. */
export function readBowerAngular(root: string): { version?: string; exists: boolean } {
  try {
    const bower = JSON.parse(readFileSync(join(root, 'bower.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const version = bower.dependencies?.['angular'] ?? bower.devDependencies?.['angular'];
    return { exists: true, ...(version ? { version } : {}) };
  } catch {
    return { exists: false };
  }
}

/** Where the AngularJS version in a report was read from. */
export type AngularJsVersionSource = 'node_modules or lockfile' | 'package.json range' | 'bower.json' | 'script tag' | 'vendored copy';

/** Everything AngularJS in the repository, as `AnalysisContext.angularJs`. */
export interface AngularJsFacts {
  /** Files with AngularJS code, test files included (checks filter them). */
  files: AngularJsFileFacts[];
  /** External templates with AngularJS syntax. */
  templates: Array<{ path: string; stats: AngularJsTemplateStats }>;
  /** Undefined when AngularJS is neither a dependency nor loaded from a recognisable file or URL. */
  version?: { version: string; source: AngularJsVersionSource };
  /** A `bower.json` at the root. */
  bower: boolean;
}

/**
 * Assembles `AngularJsFacts` from the scanned files. The version comes from
 * the first source that has one, most exact first: the installed or locked
 * `angular` package, its `package.json` range, `bower.json`, a CDN script
 * tag, a checked-in copy of `angular.js`.
 *
 * @param scans One result of `scanAngularJsFile` per JavaScript or
 *   candidate TypeScript file.
 * @param templates Every external template; those with AngularJS syntax are kept.
 * @param angular `versions.angular` and `dependencies.angular` of the workspace.
 */
export function assembleAngularJs(
  root: string,
  scans: AngularJsScan[],
  templates: Array<{ path: string; inline: boolean; angularJs?: AngularJsTemplateStats }>,
  angular: { exact?: string; declared?: string },
): AngularJsFacts {
  const files = scans.flatMap((scan) => (scan && 'facts' in scan ? [scan.facts] : []));
  const vendored = scans.flatMap((scan) => (scan && 'vendoredVersion' in scan ? [scan.vendoredVersion] : []))[0];
  const withSyntax = templates.flatMap((template) => (!template.inline && template.angularJs ? [{ path: template.path, stats: template.angularJs }] : []));
  const cdn = withSyntax.find((template) => template.stats.cdnVersion)?.stats.cdnVersion;
  const bower = readBowerAngular(root);
  const version: AngularJsFacts['version'] = angular.exact
    ? { version: angular.exact, source: 'node_modules or lockfile' }
    : angular.declared
      ? { version: angular.declared.replace(/^[\s^~>=<]+/, ''), source: 'package.json range' }
      : bower.version
        ? { version: bower.version, source: 'bower.json' }
        : cdn
          ? { version: cdn, source: 'script tag' }
          : vendored
            ? { version: vendored, source: 'vendored copy' }
            : undefined;
  return { files, templates: withSyntax, ...(version ? { version } : {}), bower: bower.exists };
}
