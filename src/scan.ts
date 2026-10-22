import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { scanAngularJsTemplate, type AngularJsTemplateStats } from './angularjs.js';
import { isTestCode, toReportPath } from './files.js';
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
  /** Lines of every `any` type annotation or `as any`. */
  anyLines: number[];
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
    linesOfCode: countLinesOfCode(text),
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
  };

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
    } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      if (ts.isPropertyAccessExpression(node.left) && /^(innerHTML|outerHTML)$/.test(node.left.name.text) && !isConstantString(node.right)) facts.unsafeDomLines.push(lineOf(node));
    } else if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map((property) => (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : '')));
      if (names.has('path') && !names.has('redirectTo')) {
        if (names.has('loadComponent') || names.has('loadChildren')) facts.routes.lazy.push(lineOf(node));
        else if (names.has('component')) facts.routes.eager.push(lineOf(node));
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = locals.get(node.expression.text);
      if (binding && binding.imported !== '*') record(facts.memberAccesses, `${binding.module}#${binding.imported}.${node.name.text}`, lineOf(node));
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      facts.anyLines.push(lineOf(node));
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
    const constructor = angularClass ? node.members.find(ts.isConstructorDeclaration) : undefined;
    if (constructor && constructor.parameters.length > 0) facts.constructorInjections.push({ name, line: lineOf(constructor), parameters: constructor.parameters.length });
    for (const decorator of ts.getDecorators(node) ?? []) {
      const key = decoratorKey(decorator);
      if (key === '@angular/core#NgModule') facts.ngModules++;
      else if (key === '@angular/core#Injectable') facts.injectables++;
      else if (key === '@angular/core#Component') {
        const metadata = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
        const component: ComponentFact = { name: node.name?.text ?? '(anonymous)', line: lineOf(node) };
        if (metadata && ts.isObjectLiteralExpression(metadata)) {
          for (const property of metadata.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            const value = property.initializer;
            if (property.name.text === 'standalone') {
              if (value.kind === ts.SyntaxKind.TrueKeyword) component.standalone = true;
              else if (value.kind === ts.SyntaxKind.FalseKeyword) component.standalone = false;
            } else if (property.name.text === 'changeDetection' && ts.isPropertyAccessExpression(value)) {
              component.changeDetection = value.name.text;
            } else if (property.name.text === 'template') {
              const template = templateTextOf(value);
              if (template !== undefined) {
                const stats = scanTemplate(template.text);
                const legacyOffset = firstLegacyOffset(template.text);
                facts.inlineTemplates.push({
                  path,
                  inline: true,
                  stats,
                  firstLegacyLine: legacyOffset === undefined ? undefined : source.getLineAndCharacterOfPosition(template.start + legacyOffset).line + 1,
                });
              }
            }
          }
        }
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
    firstLegacyLine: offset === undefined ? undefined : text.slice(0, offset).split('\n').length,
    ...(angularJs.attributes > 0 || angularJs.apps > 0 || angularJs.cdnVersion ? { angularJs } : {}),
  };
}

/** Non-blank lines, the figure a reader expects behind "lines of code". */
function countLinesOfCode(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) if (line.trim() !== '') count++;
  return count;
}
