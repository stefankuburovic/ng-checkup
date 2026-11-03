import ts from 'typescript';

/**
 * What a spec file's tests actually check: the facts behind the testing
 * check's test-quality findings.
 *
 * "Has a spec" says a file is tested; these say whether the spec could fail.
 * Each is a pattern that lets a test pass while asserting nothing, and each
 * is read from the syntax alone, so it errs towards silence: a test that
 * calls any function the file defines with an assertion in it, or any
 * `expect*` / `assert*` / `verify*` / `check*` / `should*` helper, counts as
 * asserting.
 */
export interface TestQuality {
  /** Lines of `it(...)` / `test(...)` blocks whose body asserts nothing. `xit`, `.skip` and `.todo` are not counted. */
  withoutAssertions: number[];
  /**
   * Lines of `.subscribe(...)` calls whose callback asserts, in a test that
   * does nothing to wait for it: no `done` parameter, no returned promise
   * (`() => new Promise((done) => ...)`), no `fakeAsync` /
   * `waitForAsync`, no `await`, nothing that flushes (`flush`, `tick`,
   * `expectOne`, `whenStable`). When the source is asynchronous the test
   * ends first and passes without the assertion ever running; a synchronous
   * source (`of()`, a `BehaviorSubject`) runs it, which the syntax cannot
   * tell apart, hence a low finding.
   */
  unawaitedSubscribeAssertions: number[];
  /**
   * Lines naming `NO_ERRORS_SCHEMA` or `CUSTOM_ELEMENTS_SCHEMA`. Either one
   * silences the unknown-element and unknown-property errors a template
   * would otherwise raise, so a misspelt input or a forgotten import passes.
   * In `configureTestingModule` neither even applies to a standalone
   * component's own template, so there it only suggests a protection it
   * does not give.
   */
  schemaSuppressions: number[];
}

const TEST_FUNCTIONS = new Set(['it', 'test', 'fit']);
const SKIPPED_MODIFIERS = new Set(['skip', 'todo']);

/** Helper names that assert by convention: `expect`, `expectAsync`, `assertValid`, `verify`, `checkRow`, `shouldShow`, `expectOne`. */
const ASSERTING_NAME = /^(expect|assert|verify|check|should)/i;

/** Wrappers that make a test wait for asynchronous work. */
const WAITING_WRAPPERS = new Set(['fakeAsync', 'waitForAsync', 'async', 'inject']);

/** Calls in a test body that run pending asynchronous work, so a subscription's callback has run by the time the test ends. */
const FLUSHING_CALL = /^(flush|flushMicrotasks|tick|expectOne|match|whenStable|whenRenderingDone|advanceTimersByTime|runAllTimers|runOnlyPendingTimers|advanceTimersToNextTimer|flushPromises)$/;

/** Reads a spec file's test-quality facts. Meant for spec files; a file without tests gives empty lists. */
export function testQualityOf(source: ts.SourceFile): TestQuality {
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const calledName = (call: ts.CallExpression): string | undefined => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };
  // `expect.element(x)`, `expect.soft(x)`, `assert.equal(a, b)`: the namespace object asserts, whatever the method is called.
  const assertingNamespace = (call: ts.CallExpression): boolean => {
    let target: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(target)) target = target.expression;
    return target !== call.expression && ts.isIdentifier(target) && ASSERTING_NAME.test(target.text);
  };

  // Functions this file defines that assert: `function expectRow(...)`, `const check = () => expect(...)`. Calling one asserts.
  const assertingHelpers = new Set<string>();
  const containsDirectAssertion = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const name = calledName(child);
        if ((name && ASSERTING_NAME.test(name)) || assertingNamespace(child)) found = true;
      }
      // Cypress commands assert implicitly: `cy.get('x')` fails when nothing matches.
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'cy') found = true;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const collectHelpers = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && containsDirectAssertion(node.body)) assertingHelpers.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && containsDirectAssertion(node.initializer)) {
      assertingHelpers.add(node.name.text);
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body && containsDirectAssertion(node.body)) assertingHelpers.add(node.name.text);
    ts.forEachChild(node, collectHelpers);
  };
  collectHelpers(source);

  const asserts = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const name = calledName(child);
        if ((name && (ASSERTING_NAME.test(name) || assertingHelpers.has(name))) || assertingNamespace(child)) found = true;
      }
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'cy') found = true;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  const quality: TestQuality = { withoutAssertions: [], unawaitedSubscribeAssertions: [], schemaSuppressions: [] };

  const judgeTest = (call: ts.CallExpression): void => {
    const last = call.arguments[call.arguments.length - 1];
    if (!last) return;
    let body: ts.Node | undefined;
    let waits = false;
    if (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) {
      body = last.body;
      // A test waits when it takes `done`, is async, or returns something: the runner awaits a returned promise, `() => new Promise((done) => ...)` and `return firstValueFrom(...)` alike.
      const returnsValue = !ts.isBlock(last.body) || last.body.statements.some((statement) => ts.isReturnStatement(statement) && statement.expression !== undefined);
      waits = last.parameters.length > 0 || (last.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || returnsValue;
    } else if (ts.isCallExpression(last) && ts.isIdentifier(last.expression) && WAITING_WRAPPERS.has(last.expression.text)) {
      const inner = last.arguments[last.arguments.length - 1];
      if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) body = inner.body;
      waits = true;
    }
    if (!body) return;
    // A type test asserts at compile time: `// @ts-expect-error` fails the build when the error it expects goes away.
    const assertsTypes = /@ts-expect-error/.test(body.getFullText(source));
    if (!asserts(body) && !assertsTypes) quality.withoutAssertions.push(lineOf(call));
    if (waits) return;

    let flushes = false;
    const subscribes: ts.CallExpression[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isAwaitExpression(child)) flushes = true;
      if (ts.isCallExpression(child)) {
        const name = calledName(child);
        if (name && FLUSHING_CALL.test(name)) flushes = true;
        // `testScheduler.run(...)` runs its virtual time synchronously before it returns, so a subscription inside it has emitted by then.
        if (name === 'run' && ts.isPropertyAccessExpression(child.expression) && /scheduler/i.test(child.expression.expression.getText(source))) flushes = true;
        if (name === 'subscribe' && ts.isPropertyAccessExpression(child.expression) && child.arguments.some((argument) => asserts(argument))) subscribes.push(child);
      }
      ts.forEachChild(child, visit);
    };
    visit(body);
    if (!flushes) for (const subscribe of subscribes) quality.unawaitedSubscribeAssertions.push(lineOf(subscribe));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && TEST_FUNCTIONS.has(callee.text)) judgeTest(node);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && TEST_FUNCTIONS.has(callee.expression.text) && !SKIPPED_MODIFIERS.has(callee.name.text)) judgeTest(node);
    }
    if (ts.isIdentifier(node) && (node.text === 'NO_ERRORS_SCHEMA' || node.text === 'CUSTOM_ELEMENTS_SCHEMA') && !ts.isImportSpecifier(node.parent)) {
      const line = lineOf(node);
      if (!quality.schemaSuppressions.includes(line)) quality.schemaSuppressions.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return quality;
}
