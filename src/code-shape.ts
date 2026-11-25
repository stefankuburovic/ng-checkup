import ts from 'typescript';

/**
 * Two facts about the shape of code, read from the syntax alone: subscriptions
 * nested in subscriptions, and the cognitive complexity of functions.
 */

/** The threshold of eslint-plugin-sonarjs's `cognitive-complexity` rule, so the counts can be compared. */
export const COMPLEXITY_THRESHOLD = 15;

/** One function and its cognitive complexity. */
export interface FunctionComplexity {
  name: string;
  line: number;
  complexity: number;
}

const lineOf = (source: ts.SourceFile, node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

function isSubscribeCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'subscribe';
}

/**
 * Lines of `.subscribe()` calls with another `.subscribe()` inside one of
 * their arguments, a callback or an observer object: the inner stream starts
 * per value of the outer one and nothing cancels the previous run. Each outer
 * call counts once, however many it nests.
 */
export function nestedSubscribeLines(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const containsSubscribe = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (isSubscribeCall(child)) found = true;
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (isSubscribeCall(node) && node.arguments.some(containsSubscribe)) lines.push(lineOf(source, node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(lines)];
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
}

/** The name a reader looks for: the function's own, else the variable, property or class member it is assigned to. */
function nameOf(node: FunctionNode, source: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return `${(node.parent as ts.ClassLikeDeclaration).name?.text ?? 'class'}.constructor`;
  const own = node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
  const parent = node.parent;
  const holder =
    own ??
    (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
      ? parent.name.text
      : (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
        ? parent.name.text
        : undefined);
  const owner = ts.isClassLike(node.parent) ? node.parent.name?.text : ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent) ? parent.parent.name?.text : undefined;
  if (holder) return owner ? `${owner}.${holder}` : holder;
  // A callback: named after the call it is passed to, `catchError callback`.
  if (ts.isCallExpression(parent)) {
    const callee = ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : ts.isIdentifier(parent.expression) ? parent.expression.text : undefined;
    if (callee) return `${callee} callback`;
  }
  return `function at line ${lineOf(source, node)}`;
}

/** Skips the parentheses ESTree does not have, so a logical sequence reads the same as in eslint. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

function isLogical(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind);
}

/**
 * The cognitive complexity of every function in a file, by SonarSource's
 * definition as eslint-plugin-sonarjs 4 computes it, checked against it on
 * small cases and on the corpus:
 *
 * - +1 for each `if`, `else if`, `else`, `?:`, `switch`, loop, `catch` and
 *   labelled `break` / `continue`;
 * - plus the nesting level for `if`, `?:`, `switch`, loops and `catch`;
 * - in a logical expression, +1 for each `&&` that follows another operator
 *   or none (`a && b && c` is 1, `(a || b) && c` 1); `||` and `??` add
 *   nothing, as in the plugin;
 * - every function counts on its own, a nested one too, from nesting 0:
 *   a callback is not added to the function that passes it;
 * - a function written as a branch of `?:` raises the nesting of every later
 *   structure of the function that holds it by one, which is how the plugin
 *   counts, so the numbers match it.
 */
export function functionComplexities(source: ts.SourceFile): FunctionComplexity[] {
  const results: FunctionComplexity[] = [];

  const measure = (root: FunctionNode): number => {
    let total = 0;
    // The plugin's own count: a function written as a branch of `?:` raises the nesting of every later structure in the function by one.
    let carried = 0;
    // Logical expressions already counted as part of a larger sequence.
    const counted = new Set<ts.Node>();
    const logicalSequence = (node: ts.BinaryExpression): number => {
      const operators: ts.SyntaxKind[] = [];
      const flatten = (expression: ts.Expression): void => {
        const inner = unwrap(expression);
        if (isLogical(inner)) {
          counted.add(inner);
          flatten(inner.left);
          operators.push(inner.operatorToken.kind);
          flatten(inner.right);
        }
      };
      flatten(node);
      let score = 0;
      let previous: ts.SyntaxKind | undefined;
      for (const operator of operators) {
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken && operator !== previous) score++;
        previous = operator;
      }
      return score;
    };

    const visit = (node: ts.Node, nesting: number): void => {
      // A nested function is measured on its own.
      if (node !== root && isFunctionNode(node)) return;
      if (ts.isIfStatement(node)) {
        const elseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
        total += elseIf ? 1 : 1 + nesting + carried;
        visit(node.expression, nesting);
        visit(node.thenStatement, nesting + 1);
        if (node.elseStatement) {
          if (ts.isIfStatement(node.elseStatement)) visit(node.elseStatement, nesting);
          else {
            total += 1;
            visit(node.elseStatement, nesting + 1);
          }
        }
        return;
      }
      if (ts.isConditionalExpression(node)) {
        total += 1 + nesting + carried;
        visit(node.condition, nesting);
        visit(node.whenTrue, nesting + 1);
        if (isFunctionNode(unwrap(node.whenTrue))) carried++;
        visit(node.whenFalse, nesting + 1);
        if (isFunctionNode(unwrap(node.whenFalse))) carried++;
        return;
      }
      if (ts.isSwitchStatement(node)) {
        total += 1 + nesting + carried;
        visit(node.expression, nesting);
        visit(node.caseBlock, nesting + 1);
        return;
      }
      if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        total += 1 + nesting + carried;
        ts.forEachChild(node, (child) => visit(child, child === node.statement ? nesting + 1 : nesting));
        return;
      }
      if (ts.isCatchClause(node)) {
        total += 1 + nesting + carried;
        ts.forEachChild(node, (child) => visit(child, nesting + 1));
        return;
      }
      if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) total += 1;
      if (isLogical(node) && !counted.has(node)) total += logicalSequence(node);
      ts.forEachChild(node, (child) => visit(child, nesting));
    };
    ts.forEachChild(root, (child) => visit(child, 0));
    return total;
  };

  const find = (node: ts.Node): void => {
    if (isFunctionNode(node) && node.body) results.push({ name: nameOf(node, source), line: lineOf(source, ts.isArrowFunction(node) ? node.equalsGreaterThanToken : (node.name ?? node)), complexity: measure(node) });
    ts.forEachChild(node, find);
  };
  find(source);
  return results;
}
