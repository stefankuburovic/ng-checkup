import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { scanAngularJsTemplate, type AngularJsTemplateStats } from './angularjs.js';
import { isTestCode, toReportPath } from './files.js';
import { translationKeysInCode, translationKeysInTemplate, type TranslationKeyUse } from './translations.js';
import { withoutHtmlComments } from './template-text.js';

/** One name brought in by an import or re-export. */
export interface ImportBinding {
  /** The name the module exports. `default` for a default import, `*` for a namespace import. */
  imported: string;
  /** The name it is bound to in this file. */
  local: string;
  /** For a re-export, the name it is exported under (`B` in `export { A as B } from`). */
  exported?: string;
  typeOnly: boolean;
  /**
   * False when the file only uses the binding as a type. TypeScript erases
   * such an import even without `import type`, so it is no runtime
   * dependency (see `valueReferences`). Always true for a re-export.
   */
  valueUsed: boolean;
}

/** One `import`, `export … from` or dynamic `import()` in a source file. */
export interface ImportFact {
  specifier: string;
  line: number;
  /**
   * True for `import type`, and for a named import whose every binding is
   * `type`. Such an import is erased at compile time, so it cannot take part in
   * a runtime cycle and the dependency graph ignores it.
   */
  typeOnly: boolean;
  /** `import()` loads lazily and does not form an eager cycle either. */
  dynamic: boolean;
  /** Empty for a side-effect import (`import 'zone.js'`) and for `export * from`. */
  bindings: ImportBinding[];
  /** True for `export … from`: the file passes the names on rather than using them. */
  reexport?: boolean;
}

/** One `@Component` class. */
export interface ComponentFact {
  name: string;
  line: number;
  /**
   * The literal value of `standalone` in the decorator, undefined when absent.
   * What an absent flag means depends on the Angular version (standalone is the
   * default from v19), which is why the scanner records only what is written
   * and the components check interprets it.
   */
  standalone?: boolean;
  /**
   * The strategy named in `changeDetection`, undefined when absent. Like
   * `standalone`, the default changed (OnPush from v22), so an absent value is
   * interpreted by the check that knows the version.
   */
  changeDetection?: string;
  /** The `selector` string as written, undefined when absent (a routed-only component). */
  selector?: string;
  /** True for `export default class`, which a route loads by file (`loadComponent: () => import('./x')`) rather than by name. */
  defaultExport?: boolean;
  /** See `BindingFact`. */
  inputs?: BindingFact[];
  outputs?: BindingFact[];
}

/**
 * One input or output of a component or directive, by the name a template
 * binds it with: the alias when there is one (`@Input('label')`,
 * `input(0, { alias: 'label' })`), else the property name. Decorators,
 * signal functions (`input`, `input.required`, `model`, `output`,
 * `outputFromObservable`) and the `inputs`/`outputs` arrays of the metadata
 * all count. A `model()` is an input whose `nameChange` event binds it too.
 */
export interface BindingFact {
  name: string;
  line: number;
  /** For a `model()`: the `nameChange` output that two-way binding listens to. */
  alsoAs?: string;
}

/** One `@Directive` class and the selector templates match it by. */
export interface DirectiveFact {
  name: string;
  line: number;
  /** The `selector` string as written, undefined when absent (a host directive or an abstract base). */
  selector?: string;
  defaultExport?: boolean;
  inputs?: BindingFact[];
  outputs?: BindingFact[];
}

/** One `@Pipe` class and the name templates call it by. */
export interface PipeFact {
  className: string;
  /** The `name` in the decorator, undefined when it is not a string literal. */
  name?: string;
  line: number;
  defaultExport?: boolean;
}

/** Control-flow and escape-hatch counts for one template, inline or external. */
export interface TemplateStats {
  ngIf: number;
  ngFor: number;
  ngSwitch: number;
  ifBlocks: number;
  forBlocks: number;
  switchBlocks: number;
  deferBlocks: number;
  /** `$any(...)`, the template's way of switching type checking off for one expression. */
  anyCasts: number;
  /** `[innerHTML]`/`[outerHTML]` bindings. Angular sanitizes them, unless the value went through `bypassSecurityTrustHtml`. */
  innerHtmlBindings: number;
}

/** A template and where its first legacy structural directive sits, for report examples. */
export interface TemplateFact {
  path: string;
  /** True for a `template:` string inside a component file. */
  inline: boolean;
  stats: TemplateStats;
  /** 1-based line of the first `*ngIf`/`*ngFor`/`[ngSwitch]`, undefined when there is none. */
  firstLegacyLine?: number;
  /** AngularJS syntax in an external template; absent when there is none, which is every template of an Angular-only app. */
  angularJs?: AngularJsTemplateStats;
  /** See `TemplateUsage`. */
  usage: TemplateUsage;
  /** Literal translation keys it looks up (see `translationKeysInTemplate`), with lines of the file that holds the template. */
  translationKeys: TranslationKeyUse[];
}

/**
 * What a template uses by name: element tags, the attributes on them, and
 * pipes. Read from the text, so an element in a comment does not count and
 * one built at runtime is not seen.
 */
export interface TemplateUsage {
  /** Every tag name, lower-cased, unique, sorted: `app-hero`, and `button` for a `button[mat-button]` selector. */
  elements: string[];
  /**
   * Attribute names a directive selector can match, lower-cased, unique,
   * sorted, with Angular's binding syntax removed: `appTooltip`,
   * `[appTooltip]="x"`, `[(ngModel)]`, `*appIf` and an event binding
   * `(appClickWithWarning)="go()"` all give the bare name, since Angular
   * matches selectors against inputs and outputs alike. References
   * (`#ref`), `let-` variables and `[attr.x]`, `[class.x]`, `[style.x]`
   * bindings are left out, since no selector matches them.
   */
  attributes: string[];
  /** Unique, sorted. */
  pipes: string[];
}

/** Everything the checks need from one TypeScript file, gathered in a single AST pass. */
export interface SourceFileFacts {
  /** Report path: relative to the root, `/`-separated. */
  path: string;
  absolutePath: string;
  /** Test code of any kind (see `isTestCode`), which every check leaves out of "application code". */
  isSpec: boolean;
  /**
   * Written by a tool, not a person (see `isGeneratedFile`): GraphQL or
   * OpenAPI types, protobuf stubs. Left out of every count of application
   * code, since nobody fixes an `any` in a file the next codegen run
   * rewrites, but kept in the import graph, where it is as real as any file.
   */
  isGenerated: boolean;
  /** Non-blank lines. */
  linesOfCode: number;
  imports: ImportFact[];
  components: ComponentFact[];
  ngModules: number;
  injectables: number;
  /** `@Input()` decorators on properties and setters. */
  decoratorInputs: number;
  /** `@Output()` decorators. */
  decoratorOutputs: number;
  /**
   * Calls of imported functions, keyed `module#name` (`@angular/core#signal`)
   * or `module#name.member` for calls such as `input.required()`. Values are the
   * 1-based lines of each call. Resolving through the imports is what keeps a
   * local helper that happens to be called `signal` out of the signal count.
   */
  calls: Map<string, number[]>;
  /** `new X()` of an imported class, keyed like `calls`. */
  constructions: Map<string, number[]>;
  /** `X.member` on an imported binding, keyed `module#X.member`. Used for deprecated enum members. */
  memberAccesses: Map<string, number[]>;
  /**
   * Calls of test-framework globals that are never imported: `spyOn` and
   * `jasmine.*` for Jasmine. Each one is a line to rewrite when moving to Vitest
   * or Jest, which is what the testing check reports them for.
   */
  jasmineCalls: number;
  /** Lines of every `any` type annotation or `as any`, except those an eslint directive exempts (see `suppressedAnyLines`). */
  anyLines: number[];
  /**
   * Lines of an `any` that an eslint directive switches `no-explicit-any` off
   * for: `eslint-disable-next-line`, `eslint-disable-line`, or a
   * `/* eslint-disable *\/` … `/* eslint-enable *\/` block, naming the rule
   * or no rule at all. Kept apart because that is what a team's own lint
   * count leaves out, and a report that counts them reads as contradicting it.
   */
  suppressedAnyLines: number[];
  /**
   * `.subscribe(` calls inside `@Component` and `@Directive` classes: state
   * moved by hand, where a signal (`toSignal`) or the `async` pipe would let
   * Angular own the subscription. `bound` is true when the chain hands its
   * lifetime to the class (`takeUntilDestroyed`, `takeUntil`, `take`, `first`),
   * false when only an explicit `unsubscribe()` (or nothing) ends it.
   * `unended` is true when nothing at all ends it: not bound, the class has
   * no cleanup of any kind (`ngOnDestroy`, `unsubscribe()`, `DestroyRef`,
   * `Subscription.add`), and the source is not one that completes or dies
   * with the component (`HttpClient`, `ActivatedRoute`, a form's
   * `valueChanges`, a dialog's `afterClosed()`, a `Subject` the class itself
   * creates), and no `takeWhile` stops it. Those are the ones that
   * keep a destroyed component alive.
   */
  manualSubscribes: Array<{ line: number; bound: boolean; unended: boolean }>;
  /** Lines of every `x!` non-null assertion. */
  nonNullLines: number[];
  /** `x!: T` property declarations, which skip definite-assignment checking. */
  definiteAssignments: number;
  /** `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` comments. */
  typeSuppressions: number;
  /**
   * Lines of every `x.toPromise()` call. Matched by name, not by type: an
   * instance method is invisible to the import-based deprecation index, and
   * outside RxJS almost nothing in an Angular app has a `toPromise` method.
   */
  toPromiseLines: number[];
  /** Lines of `x.bypassSecurityTrustHtml(...)` and its Style/Script/Url/ResourceUrl siblings: values Angular will not sanitize. */
  bypassSecurityLines: number[];
  /**
   * Lines that write HTML into the DOM past Angular's sanitizer: an
   * assignment to `.innerHTML`/`.outerHTML`, `insertAdjacentHTML`,
   * `document.write`, and `Renderer2.setProperty(el, 'innerHTML', …)`.
   */
  unsafeDomLines: number[];
  /** Lines of `eval(...)` and `new Function(...)`: strings run as code, which also breaks a strict CSP. */
  dynamicCodeLines: number[];
  /**
   * Route objects, recognised as object literals with a `path` and either a
   * `component` (eager) or a `loadComponent`/`loadChildren` (lazy). Lines of
   * each. A `redirectTo` route is neither.
   */
  routes: { eager: number[]; lazy: number[] };
  /**
   * Angular classes (component, directive, pipe, injectable) whose
   * constructor takes parameters: dependencies injected through the
   * constructor rather than `inject()`.
   */
  constructorInjections: Array<{ name: string; line: number; parameters: number }>;
  /** Classes implementing a router guard/resolver interface or `HttpInterceptor`, the pre-functional style. */
  classGuards: Array<{ name: string; line: number; kind: string }>;
  /**
   * Names this file exports only as types: `export type`, `export interface`,
   * `export { type X }`, and `export { X }` of a local type. A name that is
   * also a value (an interface merged with a const) is left out. The graph
   * uses it to drop imports that name nothing but types, which TypeScript
   * erases even without `import type`.
   */
  typeExports: string[];
  /** `templateUrl`/`template` is resolved by the template scan; inline templates are collected here. */
  inlineTemplates: TemplateFact[];
  pipes: PipeFact[];
  directives: DirectiveFact[];
  /**
   * Capitalised names the file mentions outside its imports, its own class
   * names, and the `declarations`/`imports`/`exports` arrays of Angular
   * metadata: a route's `component: X`, `dialog.open(X)`, `inject(XPipe)`,
   * `providers: [XPipe]`, a constructor parameter typed `XPipe`, a
   * `bootstrap: [AppComponent]`. A component or pipe no template uses and no
   * other file mentions this way is unused; being listed in an NgModule or a
   * standalone `imports` array alone keeps nothing alive.
   */
  classReferences: string[];
  /**
   * Input and output names code sets by name rather than a template:
   * `componentRef.setInput('label', x)`, `inputBinding('label', ...)`,
   * `outputBinding('closed', ...)`, and the keys of an Ionic
   * `componentProps: { label: x }`. Such a binding is used though no
   * template has it.
   */
  bindingNamesInCode: string[];
  /** Literal translation keys looked up through a translation service or marked with `marker()` (see `translationKeysInCode`). */
  translationKeys: TranslationKeyUse[];
  /** True when the file passes `bindToComponentInputs` to the router, which then sets component inputs from the URL. */
  bindsRouteInputs?: boolean;
}

/**
 * Parses one file and extracts its facts. Parsing is syntax-only (no type
 * checker, no program), which is what lets a 3 000-file repository finish in
 * seconds and lets the tool run without the project's dependencies installed.
 * The cost is that identifiers are matched by their import, never by type.
 */
export function scanSourceFile(root: string, absolutePath: string): SourceFileFacts {
  const text = readFileSync(absolutePath, 'utf8');
  const source = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const path = toReportPath(root, absolutePath);
  const facts: SourceFileFacts = {
    path,
    absolutePath,
    // The report path, not the absolute one: a repository checked out under
    // some `.../e2e/...` folder must not turn every file into test code.
    isSpec: isTestCode(path),
    isGenerated: isGeneratedFile(path, text),
    linesOfCode: countLinesOfCode(source),
    imports: [],
    components: [],
    ngModules: 0,
    injectables: 0,
    decoratorInputs: 0,
    decoratorOutputs: 0,
    calls: new Map(),
    constructions: new Map(),
    memberAccesses: new Map(),
    jasmineCalls: 0,
    anyLines: [],
    suppressedAnyLines: [],
    manualSubscribes: [],
    nonNullLines: [],
    definiteAssignments: 0,
    typeSuppressions: (text.match(/@ts-(ignore|expect-error|nocheck)\b/g) ?? []).length,
    typeExports: typeExportsOf(source),
    toPromiseLines: [],
    bypassSecurityLines: [],
    unsafeDomLines: [],
    dynamicCodeLines: [],
    routes: { eager: [], lazy: [] },
    constructorInjections: [],
    classGuards: [],
    inlineTemplates: [],
    pipes: [],
    directives: [],
    classReferences: classReferencesOf(source),
    bindingNamesInCode: [],
    translationKeys: translationKeysInCode(source),
  };  const anyExempt = lintExemptLines(text, '@typescript-eslint/no-explicit-any');


  /** Imported bindings by local name: what `signal` in this file actually refers to. */
  const locals = new Map<string, { module: string; imported: string }>();
  for (const statement of source.statements) {
    const fact = importFactOf(statement, source);
    if (!fact) continue;
    facts.imports.push(fact);
    for (const binding of fact.bindings) locals.set(binding.local, { module: fact.specifier, imported: binding.imported });
  }

  // Which imported names the file uses as values; the rest TypeScript erases.
  const valueNames = valueReferences(source, new Set(locals.keys()));
  for (const fact of facts.imports) {
    if (fact.reexport) continue;
    for (const binding of fact.bindings) binding.valueUsed = valueNames.has(binding.local);
  }

  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /** `module#name` for an identifier bound by an import, undefined for anything local or global. */
  const keyOf = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) {
      const binding = locals.get(expression.text);
      return binding && binding.imported !== '*' ? `${binding.module}#${binding.imported}` : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const binding = locals.get(expression.expression.text);
      if (!binding) return undefined;
      // `core.signal()` on a namespace import is `signal`; `input.required()` on a named import is `input.required`.
      return binding.imported === '*' ? `${binding.module}#${expression.name.text}` : `${binding.module}#${binding.imported}.${expression.name.text}`;
    }
    return undefined;
  };

  const record = (map: Map<string, number[]>, key: string, line: number): void => {
    const lines = map.get(key);
    if (lines) lines.push(line);
    else map.set(key, [line]);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const key = keyOf(node.expression);
      if (key) record(facts.calls, key, lineOf(node));
      else if (isJasmineGlobalCall(node.expression, locals)) facts.jasmineCalls++;
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === 'toPromise' && node.arguments.length === 0) facts.toPromiseLines.push(lineOf(node));
        else if (method.startsWith('bypassSecurityTrust')) facts.bypassSecurityLines.push(lineOf(node));
        else if (method === 'insertAdjacentHTML') {
          if (!isConstantString(node.arguments[1])) facts.unsafeDomLines.push(lineOf(node));
        } else if ((method === 'write' || method === 'writeln') && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'document') {
          if (!isConstantString(node.arguments[0])) facts.unsafeDomLines.push(lineOf(node));
        } else if (method === 'setProperty' && node.arguments.length >= 3) {
          const property = node.arguments[1];
          if (property && ts.isStringLiteralLike(property) && /^(inner|outer)HTML$/i.test(property.text) && !isConstantString(node.arguments[2])) facts.unsafeDomLines.push(lineOf(node));
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'eval' && !locals.has('eval')) {
        facts.dynamicCodeLines.push(lineOf(node));
      }
      const [firstArgument] = node.arguments;
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      if ((callee === 'setInput' || callee === 'inputBinding' || callee === 'outputBinding' || callee === 'twoWayBinding') && firstArgument && ts.isStringLiteralLike(firstArgument)) facts.bindingNamesInCode.push(firstArgument.text);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteralLike(argument)) {
          facts.imports.push({ specifier: argument.text, line: lineOf(node), typeOnly: false, dynamic: true, bindings: [] });
        }
      }
    } else if (ts.isNewExpression(node)) {
      const key = keyOf(node.expression);
      if (key) record(facts.constructions, key, lineOf(node));
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') facts.dynamicCodeLines.push(lineOf(node));
      // `new Worker(new URL('./app.worker', import.meta.url))`: the bundler loads the file, so it is used though nothing imports it.
      const [target, base] = node.arguments ?? [];
      if (ts.isIdentifier(node.expression) && node.expression.text === 'URL' && target && ts.isStringLiteralLike(target) && target.text.startsWith('.') && base && isImportMetaUrl(base)) {
        facts.imports.push({ specifier: target.text, line: lineOf(node), typeOnly: false, dynamic: true, bindings: [] });
      }
    } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      if (ts.isPropertyAccessExpression(node.left) && /^(innerHTML|outerHTML)$/.test(node.left.name.text) && !isConstantString(node.right)) facts.unsafeDomLines.push(lineOf(node));
    } else if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map((property) => (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : '')));
      if (names.has('bindToComponentInputs')) facts.bindsRouteInputs = true;
      // Ionic's `modalController.create({ component: X, componentProps: { label: 'Save' } })` sets inputs by name.
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) || property.name.text !== 'componentProps' || !ts.isObjectLiteralExpression(property.initializer)) continue;
        for (const prop of property.initializer.properties) if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) facts.bindingNamesInCode.push(prop.name.text);
      }
      // Angular 7 and older: `loadChildren: './admin/admin.module#AdminModule'`, a module loaded by a string the bundler resolves.
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) || property.name.text !== 'loadChildren') continue;
        if (!ts.isStringLiteralLike(property.initializer) || !property.initializer.text.includes('#')) continue;
        facts.imports.push({ specifier: property.initializer.text.split('#')[0]!, line: lineOf(property), typeOnly: false, dynamic: true, bindings: [] });
      }
      if (names.has('path') && !names.has('redirectTo')) {
        if (names.has('loadComponent') || names.has('loadChildren')) facts.routes.lazy.push(lineOf(node));
        else if (names.has('component')) facts.routes.eager.push(lineOf(node));
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = locals.get(node.expression.text);
      if (binding && binding.imported !== '*') record(facts.memberAccesses, `${binding.module}#${binding.imported}.${node.name.text}`, lineOf(node));
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = lineOf(node);
      (anyExempt(line) ? facts.suppressedAnyLines : facts.anyLines).push(line);
    } else if (ts.isNonNullExpression(node)) {
      facts.nonNullLines.push(lineOf(node));
    } else if (ts.isPropertyDeclaration(node) && node.exclamationToken) {
      facts.definiteAssignments++;
    }

    if (ts.isClassDeclaration(node)) visitClassDecorators(node);
    if ((ts.isPropertyDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isGetAccessorDeclaration(node)) && ts.canHaveDecorators(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const key = decoratorKey(decorator);
        if (key === '@angular/core#Input') facts.decoratorInputs++;
        else if (key === '@angular/core#Output') facts.decoratorOutputs++;
      }
    }
    ts.forEachChild(node, visit);
  };

  /** `module#Name` of a decorator such as `@Component({...})`, resolved through the imports. */
  const decoratorKey = (decorator: ts.Decorator): string | undefined => {
    const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
    return keyOf(expression);
  };

  /** See `BindingFact`. Empty lists are left out, so a class without inputs carries no `inputs` key. */
  const bindingsOf = (node: ts.ClassDeclaration, metadata: ts.Expression | undefined): { inputs?: BindingFact[]; outputs?: BindingFact[] } => {
    const inputs: BindingFact[] = [];
    const outputs: BindingFact[] = [];
    const aliasIn = (argument: ts.Expression | undefined): string | undefined => {
      if (!argument) return undefined;
      if (ts.isStringLiteralLike(argument)) return argument.text;
      if (!ts.isObjectLiteralExpression(argument)) return undefined;
      const alias = argument.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'alias');
      return alias && ts.isPropertyAssignment(alias) && ts.isStringLiteralLike(alias.initializer) ? alias.initializer.text : undefined;
    };
    for (const member of node.members) {
      if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
      const property = member.name.text;
      const line = lineOf(member);
      for (const decorator of (ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined) ?? []) {
        const key = decoratorKey(decorator);
        const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
        if (key === '@angular/core#Input') inputs.push({ name: aliasIn(argument) ?? property, line });
        else if (key === '@angular/core#Output') outputs.push({ name: aliasIn(argument) ?? property, line });
      }
      const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      const key = keyOf(initializer.expression);
      const alias = initializer.arguments.map((argument) => (ts.isObjectLiteralExpression(argument) ? aliasIn(argument) : undefined)).find((value) => value !== undefined);
      const bound = alias ?? property;
      if (key === '@angular/core#input' || key === '@angular/core#input.required') inputs.push({ name: bound, line });
      else if (key === '@angular/core#model' || key === '@angular/core#model.required') inputs.push({ name: bound, line, alsoAs: `${bound}Change` });
      else if (key === '@angular/core#output' || key === '@angular/core/rxjs-interop#outputFromObservable') outputs.push({ name: bound, line });
    }
    // `inputs: ['label', 'value: initialValue']` in the metadata: the name after the colon is what templates bind.
    if (metadata && ts.isObjectLiteralExpression(metadata)) {
      for (const property of metadata.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ts.isArrayLiteralExpression(property.initializer)) continue;
        const into = property.name.text === 'inputs' ? inputs : property.name.text === 'outputs' ? outputs : undefined;
        if (!into) continue;
        for (const element of property.initializer.elements) {
          if (ts.isStringLiteralLike(element)) into.push({ name: element.text.split(':').pop()!.trim(), line: lineOf(element) });
        }
      }
    }
    return { ...(inputs.length > 0 ? { inputs } : {}), ...(outputs.length > 0 ? { outputs } : {}) };
  };

  const visitClassDecorators = (node: ts.ClassDeclaration): void => {
    const name = node.name?.text ?? '(anonymous)';
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const type of clause.types) {
        const key = keyOf(type.expression);
        const kind = key?.split('#')[1];
        if (kind && (key?.startsWith('@angular/router#') ? GUARD_INTERFACES.has(kind) : key === '@angular/common/http#HttpInterceptor')) facts.classGuards.push({ name, line: lineOf(node), kind });
      }
    }
    const angularClass = (ts.getDecorators(node) ?? []).some((decorator) => ANGULAR_CLASS_DECORATORS.has(decoratorKey(decorator) ?? ''));
    const viewClass = (ts.getDecorators(node) ?? []).some((decorator) => ['@angular/core#Component', '@angular/core#Directive'].includes(decoratorKey(decorator) ?? ''));
    if (viewClass) {
      const TIED = /\b(takeUntilDestroyed|takeUntil|untilDestroyed|take|first)\s*\(/;
      // `takeWhile(() => this.alive)` with `alive = false` in a hook is the pre-DestroyRef idiom: it ends the chain, though only on the next emission, so it does not count as tied above.
      const ENDED = /\btakeWhile\s*\(/;
      // Any cleanup in the class: the subscription may be stored and ended there, which the text of the chain cannot show.
      const classCleans = /\bngOnDestroy\b|\.unsubscribe\s*\(|\bDestroyRef\b|\.onDestroy\s*\(|\.add\s*\(/.test(node.getText(source));
      // Sources that complete on their own or are owned by the component, so an unended subscription to them leaks nothing.
      const SHORT_LIVED = /^(this\.)?(http|httpClient|route|activatedRoute|dialogRef)\b|\.(valueChanges|statusChanges|afterClosed\(\)|afterOpened\(\)|changes)(?![\w$])|^(of|from|forkJoin|timer|EMPTY)\b|\b(http|httpClient)\.(get|post|put|patch|delete|request)\s*[<(]|\btranslate\w*\s*\.get\s*\(|\.(onClose|afterDismissed\(\))(?![\w$])/;
      // Subjects and emitters the component creates itself die with it: `this.state$.subscribe` on a field initialised with `new BehaviorSubject()` holds nothing alive.
      const ownStreams = new Set(node.members.flatMap((member) => (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.initializer && /^new\s+(\w*Subject|EventEmitter)\b/.test(member.initializer.getText(source)) ? [member.name.text] : [])));
      // Local variables of the member and what they were initialised with: `const order$ = this.order$().pipe(takeUntilDestroyed(...))`
      // ties every `order$.subscribe(...)` below it, and so does a local factory `const load$ = () => x.pipe(take(1))` called as `load$()`.
      let locals = new Map<string, string>();
      const collectLocals = (child: ts.Node): void => {
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) locals.set(child.name.text, child.initializer.getText(source));
        ts.forEachChild(child, collectLocals);
      };
      const findSubscribes = (child: ts.Node): void => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'subscribe') {
          // Read from the text of the chain: `pipe(takeUntilDestroyed(this.destroyRef))` and friends, wherever in the chain they sit.
          const chain = child.expression.expression.getText(source);
          const root = /^([A-Za-z_$][\w$]*)/.exec(chain)?.[1];
          const viaLocal = root !== undefined && root !== 'this' && TIED.test(locals.get(root) ?? '');
          const bound = TIED.test(chain) || viaLocal;
          const ownStream = /^this\.([A-Za-z_$][\w$]*)/.exec(chain)?.[1];
          const ends = classCleans || ENDED.test(chain) || SHORT_LIVED.test(chain) || (ownStream !== undefined && ownStreams.has(ownStream));
          facts.manualSubscribes.push({ line: lineOf(child), bound, unended: !bound && !ends });
        }
        ts.forEachChild(child, findSubscribes);
      };
      for (const member of node.members) {
        locals = new Map();
        collectLocals(member);
        findSubscribes(member);
      }
    }
    const constructor = angularClass ? node.members.find(ts.isConstructorDeclaration) : undefined;
    if (constructor && constructor.parameters.length > 0) facts.constructorInjections.push({ name, line: lineOf(constructor), parameters: constructor.parameters.length });
    for (const decorator of ts.getDecorators(node) ?? []) {
      const key = decoratorKey(decorator);
      if (key === '@angular/core#NgModule') facts.ngModules++;
      else if (key === '@angular/core#Injectable') facts.injectables++;
      else if (key === '@angular/core#Directive') {
        const metadata = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
        const selector = metadata && ts.isObjectLiteralExpression(metadata) ? metadata.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'selector') : undefined;
        const value = selector && ts.isPropertyAssignment(selector) ? selector.initializer : undefined;
        facts.directives.push({ name, line: lineOf(node), ...(value && ts.isStringLiteralLike(value) ? { selector: value.text } : {}), ...(isDefaultExport(node) ? { defaultExport: true } : {}), ...bindingsOf(node, metadata) });
      } else if (key === '@angular/core#Pipe') {
        const metadata = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
        const nameProperty = metadata && ts.isObjectLiteralExpression(metadata) ? metadata.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'name') : undefined;
        const value = nameProperty && ts.isPropertyAssignment(nameProperty) ? nameProperty.initializer : undefined;
        facts.pipes.push({ className: name, line: lineOf(node), ...(value && ts.isStringLiteralLike(value) ? { name: value.text } : {}), ...(isDefaultExport(node) ? { defaultExport: true } : {}) });
      }
      else if (key === '@angular/core#Component') {
        const metadata = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
        const component: ComponentFact = { name: node.name?.text ?? '(anonymous)', line: lineOf(node), ...(isDefaultExport(node) ? { defaultExport: true } : {}) };
        if (metadata && ts.isObjectLiteralExpression(metadata)) {
          for (const property of metadata.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            const value = property.initializer;
            if (property.name.text === 'standalone') {
              if (value.kind === ts.SyntaxKind.TrueKeyword) component.standalone = true;
              else if (value.kind === ts.SyntaxKind.FalseKeyword) component.standalone = false;
            } else if (property.name.text === 'changeDetection' && ts.isPropertyAccessExpression(value)) {
              component.changeDetection = value.name.text;
            } else if (property.name.text === 'selector' && ts.isStringLiteralLike(value)) {
              component.selector = value.text;
            } else if (property.name.text === 'template') {
              const template = templateTextOf(value);
              if (template !== undefined) {
                const stats = scanTemplate(template.text);
                const legacyOffset = firstLegacyOffset(template.text);
                facts.inlineTemplates.push({
                  path,
                  inline: true,
                  stats,
                  usage: templateUsage(template.text),
                  // Lines counted inside the template string, moved to the line the string starts on.
                  translationKeys: translationKeysInTemplate(template.text).map((use) => ({ ...use, line: use.line + source.getLineAndCharacterOfPosition(template.start).line })),
                  firstLegacyLine: legacyOffset === undefined ? undefined : source.getLineAndCharacterOfPosition(template.start + legacyOffset).line + 1,
                });
              }
            }
          }
        }
        Object.assign(component, bindingsOf(node, metadata));
        facts.components.push(component);
      }
    }
  };

  visit(source);
  return facts;
}

/**
 * The names out of `names` that the file references as values: anywhere
 * outside a type annotation, an `implements` clause, an interface or a type
 * alias. That is the rule TypeScript applies when it decides to drop an
 * import: `import { Store } from './store'` used only in `store: Store` is
 * erased, and so is the dependency.
 *
 * One exception makes Angular code a runtime dependency where plain
 * TypeScript would not be: the parameter types of a decorated class's
 * constructor. The Angular compiler turns them into DI tokens
 * (`ɵɵinject(Store)`), so they count as values, which is what keeps a real
 * service cycle visible.
 */
function valueReferences(source: ts.SourceFile, names: Set<string>): Set<string> {
  const used = new Set<string>();
  if (names.size === 0) return used;
  const visit = (node: ts.Node, inType: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isHeritageClause(node)) {
      const implementsClause = node.token === ts.SyntaxKind.ImplementsKeyword;
      for (const type of node.types) {
        visit(type.expression, inType || implementsClause);
        for (const argument of type.typeArguments ?? []) visit(argument, true);
      }
      return;
    }
    if (ts.isConstructorDeclaration(node) && ts.isClassLike(node.parent) && (ts.getDecorators(node.parent) ?? []).length > 0) {
      for (const parameter of node.parameters) {
        for (const decorator of ts.getDecorators(parameter) ?? []) visit(decorator, false);
        // The parameter's own type is the DI token; its type arguments are not.
        if (parameter.type && ts.isTypeReferenceNode(parameter.type)) visit(parameter.type.typeName, false);
        else if (parameter.type) visit(parameter.type, true);
        if (parameter.initializer) visit(parameter.initializer, false);
      }
      if (node.body) visit(node.body, false);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (!inType && names.has(node.text) && isReference(node)) used.add(node.text);
      return;
    }
    const nowInType = inType || ts.isTypeNode(node);
    ts.forEachChild(node, (child) => visit(child, nowInType));
  };
  visit(source, false);
  return used;
}

/** False for an identifier that only names something: a property after a dot, an object key, a declared name. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isPropertySignature(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isEnumMember(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isExportSpecifier(parent)) return !parent.isTypeOnly && !parent.parent.parent.isTypeOnly;
  return true;
}

/** Leading-comment phrases that code generators write; matched only before the first line of code. */
const GENERATED_HEADER = /@generated|auto-?generated|automatically generated|code generated by|generated by (graphql-codegen|openapi|swagger|protoc|the angular cli)|this file (is|was|has been) (auto-?)?generated|do not (edit|modify)\b/i;

/**
 * True for a file a tool wrote: one whose leading comment says so
 * (`// @generated`, `/* eslint-disable *\/ // This file was automatically
 * generated`, `DO NOT EDIT`), one named `generated*` or `*.generated` /
 * `*-generated` / `*.gen` (`generated-types.ts`, `api.generated.ts`), or one
 * inside a `generated` or `__generated__` folder.
 *
 * Only the comments before the first statement count: a hand-written
 * component that explains a "token generated by the API" halfway down stays
 * application code. The name rule is anchored for the same reason:
 * `modify-generated-html.ts` is a person's file about generated HTML.
 */
export function isGeneratedFile(path: string, text: string): boolean {
  const segments = path.split('/');
  const base = (segments.pop() ?? '').replace(/\.(d\.)?[cm]?ts$/, '');
  if (segments.some((segment) => segment === 'generated' || segment === '__generated__')) return true;
  if (/^generated([.\-_]|$)|[.\-_](generated|gen)$/i.test(base)) return true;
  const comments = (ts.getLeadingCommentRanges(text, 0) ?? []).map((range) => text.slice(range.pos, range.end)).join('\n');
  return GENERATED_HEADER.test(comments);
}

/**
 * See `TemplateUsage`. A pipe is a `|` that is not part of `||`, followed by
 * a name, which is how a pipe reads in an interpolation, a binding, an
 * `@if (x | async; as y)` and a `@for`'s expression alike.
 */
export function templateUsage(template: string): TemplateUsage {
  const text = withoutHtmlComments(template);
  const elements = new Set<string>();
  const attributes = new Set<string>();
  // A start tag up to its `>`, where a quoted value may hold a `>` of its own (`*ngIf="a > b"`).
  for (const match of text.matchAll(/<([a-zA-Z][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    elements.add(match[1]!.toLowerCase());
    for (const token of match[2]!.replace(/"[^"]*"|'[^']*'/g, ' ').split(/[\s=/]+/)) {
      const name = attributeName(token);
      if (name) attributes.add(name);
    }
  }
  const pipes = new Set<string>();
  for (const match of text.matchAll(/(?<![|])\|(?![|])\s*([A-Za-z_$][\w$]*)/g)) pipes.add(match[1]!);
  return { elements: [...elements].sort(), attributes: [...attributes].sort(), pipes: [...pipes].sort() };
}

/**
 * The attribute a directive selector would match for one token of a start
 * tag, lower-cased, or undefined for a token no selector matches (see
 * `TemplateUsage.attributes`). Lower-cased on both sides of the comparison,
 * since browsers lower-case attribute names and a template may be written
 * either way.
 */
function attributeName(token: string): string | undefined {
  if (token === '' || /^[#@]|^let-|^ref-/.test(token)) return undefined;
  const name = token.replace(/^\[\(|\)\]$/g, '').replace(/^[[(]|[\])]$/g, '').replace(/^\*/, '').replace(/^(bind|bindon|on)-/, '');
  if (name === '' || name.includes('.') || !/^[A-Za-z_][\w:-]*$/.test(name)) return undefined;
  return name.toLowerCase();
}

/** Metadata arrays that list declarables without using them (see `SourceFileFacts.classReferences`). */
const LISTING_ARRAYS = new Set(['declarations', 'imports', 'exports', 'entryComponents']);

/** See `SourceFileFacts.classReferences`. */
function classReferencesOf(source: ts.SourceFile): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    // Only the classes listed directly: `imports: [RouterModule.forChild([{ path: '', component: AboutPage }])]` still uses `AboutPage`.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && LISTING_ARRAYS.has(node.name.text) && isInsideDecorator(node)) {
      if (ts.isArrayLiteralExpression(node.initializer)) for (const element of node.initializer.elements) if (!ts.isIdentifier(element)) visit(element);
      return;
    }
    if (ts.isIdentifier(node) && /^[A-Z]/.test(node.text)) {
      const parent = node.parent;
      const declares = (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node;
      if (!declares) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...names].sort();
}

/** True for a node inside a decorator's arguments, such as a property of `@NgModule({ ... })`. */
function isInsideDecorator(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isDecorator(current)) return true;
    if (ts.isSourceFile(current) || ts.isClassDeclaration(current)) return false;
  }
  return false;
}

/** True for `export default class`. */
function isDefaultExport(node: ts.ClassDeclaration): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

/** True for `import.meta.url`, the base a bundler-resolved `new URL(...)` is given. */
function isImportMetaUrl(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/** See `SourceFileFacts.typeExports`. Top-level statements only, which is where exports live. */
function typeExportsOf(source: ts.SourceFile): string[] {
  const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const types = new Set<string>();
  const values = new Set<string>();
  const exportedTypes = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      types.add(statement.name.text);
      if (exported(statement)) exportedTypes.add(statement.name.text);
    } else if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      values.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) values.add(declaration.name.text);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      values.add(statement.name.text);
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const local = (element.propertyName ?? element.name).text;
      if (statement.isTypeOnly || element.isTypeOnly || (types.has(local) && !values.has(local))) exportedTypes.add(element.name.text);
    }
  }
  return [...exportedTypes].filter((name) => !values.has(name));
}

/**
 * True for HTML the code wrote itself: a string literal, a template literal
 * without substitutions, or literals joined with `+`. `el.innerHTML = ''` (the
 * usual way to clear an element) and a fixed snippet of markup carry no input,
 * so they are no XSS; flagging them buried the real cases in a 200-component
 * app under a dozen harmless ones. Undefined (a missing argument) is not constant.
 */
function isConstantString(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  if (ts.isParenthesizedExpression(expression)) return isConstantString(expression.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true;
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken && isConstantString(expression.left) && isConstantString(expression.right);
}

/** Router interfaces of class-based guards and resolvers, all replaced by functions (`CanActivateFn`, `ResolveFn`) since Angular 14.2/15. */
const GUARD_INTERFACES = new Set(['CanActivate', 'CanActivateChild', 'CanDeactivate', 'CanLoad', 'CanMatch', 'Resolve']);

/** Decorators of the classes Angular instantiates through DI, where constructor parameters are injected dependencies. */
const ANGULAR_CLASS_DECORATORS = new Set(['@angular/core#Component', '@angular/core#Directive', '@angular/core#Pipe', '@angular/core#Injectable']);

/** Turns an import or re-export statement into an `ImportFact`; undefined for any other statement. */
function importFactOf(statement: ts.Statement, source: ts.SourceFile): ImportFact | undefined {
  const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
  if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    const clause = statement.importClause;
    const bindings: ImportBinding[] = [];
    const clauseTypeOnly = clause?.isTypeOnly ?? false;
    if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly: clauseTypeOnly, valueUsed: true });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.push({ imported: '*', local: named.name.text, typeOnly: clauseTypeOnly, valueUsed: true });
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({ imported: (element.propertyName ?? element.name).text, local: element.name.text, typeOnly: clauseTypeOnly || element.isTypeOnly, valueUsed: true });
      }
    }
    return {
      specifier: statement.moduleSpecifier.text,
      line,
      typeOnly: clauseTypeOnly || (bindings.length > 0 && bindings.every((binding) => binding.typeOnly)),
      dynamic: false,
      bindings,
    };
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    const clause = statement.exportClause;
    const bindings: ImportBinding[] =
      clause && ts.isNamedExports(clause)
        ? clause.elements.map((element) => ({
            imported: (element.propertyName ?? element.name).text,
            // A re-export binds nothing locally; the empty name keeps it out of the local lookup.
            local: '',
            exported: element.name.text,
            typeOnly: statement.isTypeOnly || element.isTypeOnly,
            valueUsed: true,
          }))
        : [];
    return {
      specifier: statement.moduleSpecifier.text,
      line,
      typeOnly: statement.isTypeOnly || (bindings.length > 0 && bindings.every((binding) => binding.typeOnly)),
      dynamic: false,
      bindings,
      reexport: true,
    };
  }
  return undefined;
}

/**
 * True for `spyOn(...)` and `jasmine.x(...)` when neither name is imported. An
 * imported `spyOn` (some Vitest setups re-export one) is not Jasmine.
 */
function isJasmineGlobalCall(expression: ts.Expression, locals: Map<string, unknown>): boolean {
  if (ts.isIdentifier(expression)) return (expression.text === 'spyOn' || expression.text === 'spyOnProperty') && !locals.has(expression.text);
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'jasmine' && !locals.has('jasmine');
}

/**
 * The text of an inline template and the offset of its first character in the
 * file. For a template literal with `${}` substitutions only the literal parts
 * are kept, which is enough for counting control flow and rare in practice.
 */
function templateTextOf(value: ts.Expression): { text: string; start: number } | undefined {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { text: value.text, start: value.getStart() + 1 };
  if (ts.isTemplateExpression(value)) {
    return { text: [value.head.text, ...value.templateSpans.map((span) => span.literal.text)].join(' '), start: value.getStart() + 1 };
  }
  return undefined;
}

/** Counts control flow in one template's text. Commented-out markup is not counted (see `withoutHtmlComments`). */
export function scanTemplate(template: string): TemplateStats {
  const text = withoutHtmlComments(template);
  const count = (pattern: RegExp): number => (text.match(pattern) ?? []).length;
  return {
    ngIf: count(/\*ngIf\s*=|\[ngIf\]\s*=/g),
    ngFor: count(/\*ngFor\s*=|\[ngForOf\]\s*=/g),
    ngSwitch: count(/\[ngSwitch\]\s*=/g),
    ifBlocks: count(/@if\s*\(/g),
    forBlocks: count(/@for\s*\(/g),
    switchBlocks: count(/@switch\s*\(/g),
    deferBlocks: count(/@defer\b/g),
    anyCasts: count(/\$any\s*\(/g),
    innerHtmlBindings: count(/\[(innerHTML|outerHTML)\]\s*=/gi),
  };
}

/** Character offset of the first legacy structural directive outside a comment, or undefined. */
export function firstLegacyOffset(text: string): number | undefined {
  const match = /\*ngIf\s*=|\[ngIf\]\s*=|\*ngFor\s*=|\[ngForOf\]\s*=|\[ngSwitch\]\s*=/.exec(withoutHtmlComments(text));
  return match?.index;
}

/** Scans an external template file. */
export function scanTemplateFile(root: string, absolutePath: string): TemplateFact {
  const text = readFileSync(absolutePath, 'utf8');
  const offset = firstLegacyOffset(text);
  const angularJs = scanAngularJsTemplate(text);
  return {
    path: toReportPath(root, absolutePath),
    inline: false,
    stats: scanTemplate(text),
    usage: templateUsage(text),
    translationKeys: translationKeysInTemplate(text),
    firstLegacyLine: offset === undefined ? undefined : text.slice(0, offset).split('\n').length,
    ...(angularJs.attributes > 0 || angularJs.apps > 0 || angularJs.cdnVersion ? { angularJs } : {}),
  };
}

/**
 * Lines that hold code, the figure a reader expects behind "lines of code":
 * every line a token of the program touches. Blank lines and lines that are
 * only comment do not count, so documenting a file (JSDoc on every member
 * roughly doubles some files) does not push it over the large-file thresholds.
 * A token that spans lines, a multi-line template literal for one, counts each
 * line it covers.
 */
function countLinesOfCode(source: ts.SourceFile): number {
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const last = source.getLineAndCharacterOfPosition(node.getEnd()).line;
      for (let line = first; line <= last; line++) lines.add(line);
      return;
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return lines.size;
}

/**
 * A predicate over 1-based lines: true where an eslint directive switches
 * `rule` off. Understands `eslint-disable-next-line`, `eslint-disable-line`
 * and `eslint-disable` … `eslint-enable` blocks (to the end of the file when
 * never re-enabled), in line or block comments, with a rule list or none
 * (which disables every rule), and with a `-- reason` after the list.
 *
 * Read from the text with a regular expression rather than from the
 * TypeScript comment ranges: directives sit between statements, inside
 * object literals and in class bodies, and a line-based reading finds them
 * all the same way eslint does.
 */
export function lintExemptLines(text: string, rule: string): (line: number) => boolean {
  const lines = text.split('\n');
  const exempt = new Set<number>();
  const names = (list: string): boolean => {
    const rules = list.split('--')[0]!.replace(/\*\/.*$/, '').split(',').map((entry) => entry.trim()).filter(Boolean);
    return rules.length === 0 || rules.includes(rule);
  };
  let blockFrom: number | undefined;
  lines.forEach((content, index) => {
    const line = index + 1;
    const directive = /(?:\/\/|\/\*)\s*eslint-(disable-next-line|disable-line|disable|enable)\b([^\n]*)/.exec(content);
    if (!directive || !names(directive[2] ?? '')) return;
    if (directive[1] === 'disable-next-line') exempt.add(line + 1);
    else if (directive[1] === 'disable-line') exempt.add(line);
    else if (directive[1] === 'disable') blockFrom ??= line;
    else if (blockFrom !== undefined) {
      for (let covered = blockFrom; covered <= line; covered++) exempt.add(covered);
      blockFrom = undefined;
    }
  });
  if (blockFrom !== undefined) for (let covered = blockFrom; covered <= lines.length; covered++) exempt.add(covered);
  return (line) => exempt.has(line);
}
