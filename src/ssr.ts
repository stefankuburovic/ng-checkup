import ts from 'typescript';
import { withoutHtmlComments } from './template-text.js';

/**
 * Code that runs during server-side rendering and reaches for what only a
 * browser has. Read from the syntax, so it judges only code it knows runs on
 * the server: a module's top level, the fields and constructor of a component,
 * directive, pipe or service, the lifecycle hooks of a component or directive,
 * and the class's own methods those call through `this`.
 *
 * Everything else stays silent. A click handler touching `window` is fine, and
 * so is a callback, since nothing here can tell when it runs. So is anything
 * under a guard: `isPlatformBrowser`, `typeof window`, `this.isBrowser`, an
 * earlier `if` that returns, a `try`, or `afterNextRender`, which is a callback.
 */

/** One file's facts, as 1-based lines. */
export interface SsrFacts {
  /** References to a browser global that resolve to no local declaration. */
  browserGlobals: Array<{ name: string; line: number }>;
  /** Native DOM changes that put the DOM out of step with what the server sent, which hydration cannot match. */
  domMutations: number[];
  /** `ngSkipHydration` in a component's `host` metadata. */
  skipHydration: number[];
}

const BROWSER_GLOBALS = new Set(['window', 'document', 'localStorage', 'sessionStorage', 'navigator']);
/** The hooks Angular calls while rendering on the server. `ngOnDestroy` runs there too but rarely touches the page, and when it does a guard is the norm. */
const SERVER_HOOKS = new Set(['ngOnChanges', 'ngOnInit', 'ngDoCheck', 'ngAfterContentInit', 'ngAfterContentChecked', 'ngAfterViewInit', 'ngAfterViewChecked']);
const VIEW_DECORATORS = new Set(['Component', 'Directive']);
const CLASS_DECORATORS = new Set([...VIEW_DECORATORS, 'Injectable', 'Pipe']);
/** A condition that says where the code runs. Loose on purpose: a guard written in any style should silence, not the other way round. */
const GUARD = /isPlatformBrowser|isPlatformServer|typeof\s+(window|document|localStorage|sessionStorage|navigator)\b|platform|browser|server|isClient|isSSR/i;
const DOM_METHODS = new Set(['appendChild', 'removeChild', 'insertBefore', 'append', 'prepend', 'remove', 'replaceWith', 'replaceChildren', 'insertAdjacentHTML', 'insertAdjacentElement']);

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

/** Names a binding pattern declares. */
function boundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) boundNames(element.name, into);
}

/** True when `name`, seen at `node`, is declared by something around it: a parameter, a variable, an import, a class or a function. */
function isShadowed(name: string, node: ts.Node): boolean {
  const declares = (statements: readonly ts.Statement[]): boolean => {
    const names = new Set<string>();
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) boundNames(declaration.name, names);
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
      else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) names.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
        else if (bindings) for (const element of bindings.elements) names.add(element.name.text);
      }
    }
    return names.has(name);
  };
  for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      if (declares(scope.statements)) return true;
    }
    if (ts.isFunctionLike(scope)) {
      const names = new Set<string>();
      for (const parameter of scope.parameters) boundNames(parameter.name, names);
      if (names.has(name)) return true;
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const names = new Set<string>();
      for (const declaration of scope.initializer.declarations) boundNames(declaration.name, names);
      if (names.has(name)) return true;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      const names = new Set<string>();
      boundNames(scope.variableDeclaration.name, names);
      if (names.has(name)) return true;
    }
  }
  return false;
}

/** True when an `if`, a conditional, `&&` / `||`, an earlier returning `if` or a `try` around `node` covers it. */
function isGuarded(node: ts.Node, source: ts.SourceFile): boolean {
  const mentions = (condition: ts.Node): boolean => GUARD.test(condition.getText(source));
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression && mentions(parent.expression)) return true;
    if (ts.isConditionalExpression(parent) && child !== parent.condition && mentions(parent.condition)) return true;
    if (ts.isBinaryExpression(parent) && child === parent.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind) && mentions(parent.left)) return true;
    if (ts.isTryStatement(parent) && child === parent.tryBlock) return true;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === child) break;
        if (ts.isIfStatement(statement) && mentions(statement.expression)) return true;
      }
    }
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

/** Reads one file's facts. A file named `main.ts` only ever runs in the browser, so it has none. */
export function ssrFactsOf(source: ts.SourceFile, path: string): SsrFacts {
  const facts: SsrFacts = { browserGlobals: [], domMutations: [], skipHydration: [] };
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /** Reads code that runs where it stands. Stops at a nested function or class, which may run later or not at all. */
  const read = (node: ts.Node, onThisCall?: (name: string) => void): void => {
    if (ts.isTypeNode(node) || ts.isDecorator(node) || ts.isTypeOfExpression(node)) return;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node & { name?: ts.Node };
      const isName = parent.name === node && !ts.isShorthandPropertyAssignment(parent);
      if (!isName && BROWSER_GLOBALS.has(node.text) && !isShadowed(node.text, node) && !isGuarded(node, source)) facts.browserGlobals.push({ name: node.text, line: lineOf(node) });
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      // A call under a guard runs in the browser only, and so does everything it reaches.
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (!isGuarded(node, source)) onThisCall?.(callee.name.text);
      }
      else if (DOM_METHODS.has(callee.name.text) && /nativeElement/.test(callee.expression.getText(source)) && !isGuarded(node, source)) facts.domMutations.push(lineOf(node));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ['innerHTML', 'outerHTML'].includes(node.left.name.text) && !isGuarded(node, source)) facts.domMutations.push(lineOf(node));
    ts.forEachChild(node, (child) => read(child, onThisCall));
  };

  const readClass = (node: ts.ClassLikeDeclaration): void => {
    const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) ?? [];
    const names = decorators.map(decoratorName);
    if (!names.some((name) => name && CLASS_DECORATORS.has(name))) return;
    const isView = names.some((name) => name && VIEW_DECORATORS.has(name));

    for (const decorator of decorators) {
      if (decoratorName(decorator) !== 'Component' || !ts.isCallExpression(decorator.expression)) continue;
      const metadata = decorator.expression.arguments[0];
      if (!metadata || !ts.isObjectLiteralExpression(metadata)) continue;
      for (const property of metadata.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'host' || !ts.isObjectLiteralExpression(property.initializer)) continue;
        for (const entry of property.initializer.properties) if (entry.name && entry.name.getText(source).replace(/['"]/g, '') === 'ngSkipHydration') facts.skipHydration.push(lineOf(entry));
      }
    }

    const methods = new Map(node.members.flatMap((member) => (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body ? [[member.name.text, member] as const] : [])));
    const seen = new Set<string>();
    const pending: string[] = [];
    const follow = (name: string): void => {
      if (!seen.has(name) && methods.has(name)) {
        seen.add(name);
        pending.push(name);
      }
    };
    const readBody = (body: ts.Node | undefined): void => {
      if (body) ts.forEachChild(body, (child) => read(child, follow));
    };
    for (const member of node.members) {
      const isStatic = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
      if (ts.isPropertyDeclaration(member) && member.initializer && !isStatic) read(member.initializer, follow);
      else if (ts.isConstructorDeclaration(member)) readBody(member.body);
      else if (isView && ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && SERVER_HOOKS.has(member.name.text)) follow(member.name.text);
    }
    while (pending.length > 0) readBody(methods.get(pending.pop()!)!.body);
  };

  const isBrowserEntry = /(^|\/)main(\.browser)?\.ts$/.test(path);
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      readClass(node);
      return;
    }
    if (!isBrowserEntry && (ts.isVariableStatement(node) || ts.isExpressionStatement(node) || ts.isIfStatement(node))) read(node);
    else if (ts.isModuleBlock(node) || ts.isSourceFile(node)) ts.forEachChild(node, visit);
  };
  if (!isBrowserEntry) visit(source);
  facts.browserGlobals.sort((left, right) => left.line - right.line);
  facts.domMutations.sort((left, right) => left - right);
  return facts;
}

/** Lines of a template with `ngSkipHydration` on an element. Comments do not count. */
export function skipHydrationLines(template: string): number[] {
  const text = withoutHtmlComments(template);
  return [...text.matchAll(/<[a-zA-Z][^<>]*\bngSkipHydration\b/g)].map((match) => text.slice(0, match.index + match[0].length).split('\n').length);
}
