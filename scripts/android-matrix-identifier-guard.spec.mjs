import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const android = resolve(root, 'e2e/android');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const journeyFiles = readdirSync(android)
  .filter((name) => /-journeys?\.mts$/u.test(name))
  .sort();

/**
 * Native action selectors, wait descriptions, console lines and failure
 * messages reach the published job log and `process.log`. None may interpolate
 * a Matrix Room or event identifier: a target is found by an identifier-free
 * selector and bound to its exact event by read-only observation instead.
 */
const CLIENT_SINKS = new Map([
  ['tap', 'all'],
  ['tapCurrent', 'all'],
  ['tapCurrentExposed', 'all'],
  ['tapCurrentReplacingDocument', 'all'],
  ['focusCurrent', 'all'],
  ['longPressCurrent', 'all'],
  ['tapDocumentTrigger', 'all'],
  ['scrollIntoViewIfNeeded', 'all'],
  ['swipeCurrent', 'all'],
  ['visible', 'all'],
  ['focused', 'all'],
  ['expectCount', 'all'],
  ['waitElements', 'all'],
  ['elements', 'all'],
  ['focusFixture', 'all'],
  // Typed values are input, not selectors; only the selector is logged.
  ['fill', [0]],
  ['fillFocused', [0, 2]],
  ['replace', [0]],
  ['pasteSystemClipboardFocused', [0, 2]],
  ['selectWordCurrent', [0]],
  // The identity proof takes the identifier only as its comparison value.
  ['eventIdentity', [0, 1]],
  ['testIdIdentity', [0, 1]],
]);
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const ASSERT_MESSAGE = new Map([
  ['ok', 1],
  ['equal', 2],
  ['strictEqual', 2],
  ['notEqual', 2],
  ['notStrictEqual', 2],
  ['deepEqual', 2],
  ['deepStrictEqual', 2],
  ['notDeepEqual', 2],
  ['match', 2],
  ['doesNotMatch', 2],
  ['fail', 0],
  ['rejects', 2],
  ['throws', 2],
]);
/** Object names whose `.id` is a stage, test or session id, not a Matrix one. */
const NON_MATRIX_ID_OWNERS = new Set([
  'entry',
  'stage',
  'this',
  'session',
  'namespace',
  'frame',
  'button',
  'testContext',
  'moderation',
]);
/** Members of the shared target helpers, which are identifier-free by construction. */
const IDENTIFIER_FREE_MEMBERS = new Set(['selector', 'filter']);
/** Identifier-shaped names that are never a Matrix Room or event id. */
const NON_MATRIX_ID_NAMES =
  /^(?:.*user_?ids?|.*test_?id|.*applicationid|.*(?:case|stage|mode)id|.*secretids|runid|allassertionids|requestid|transactionid|txnid|clientid|controlid|accountid|executioncontextid|frameid|contextid|defaultkeyid|board_id|pick__id|selectids|widgetid|pointerid|actionid|suiteid)$/u;
const MATRIX_ID_NAME = /(?:Id|Ids|_id)$|Id(?:Selector|Path|Segment)$/u;

const isMatrixIdName = (name) =>
  MATRIX_ID_NAME.test(name) && !NON_MATRIX_ID_NAMES.test(name.toLowerCase());

/**
 * A one-file program: the checker resolves local names with their real
 * scopes, while imports stay opaque and are judged by their names alone.
 */
function program(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (name) => (name === file ? tree : undefined);
  host.fileExists = (name) => name === file;
  host.readFile = (name) => (name === file ? source : undefined);
  const checker = ts
    .createProgram({
      rootNames: [file],
      options: { noLib: true, noResolve: true, types: [] },
      host,
    })
    .getTypeChecker();
  return { tree, checker };
}

/** The analysis for one source file: whether an expression can carry a Matrix id. */
function taintAnalysis(tree, checker) {
  const calls = [];
  const collect = (node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const declarationOf = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  const memo = new Map();
  const tainted = (node, depth = 0) => {
    if (!node || depth > 24) return false;
    if (memo.has(node)) return memo.get(node);
    memo.set(node, false);
    const result = evaluate(node, depth);
    memo.set(node, result);
    return result;
  };
  /** A parameter carries the taint of the matching argument at any local call site. */
  const parameterTaint = (parameter, depth) => {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    const target = ts.isFunctionDeclaration(fn)
      ? fn
      : ts.isVariableDeclaration(fn.parent)
        ? fn.parent
        : undefined;
    if (!target) return false;
    return calls.some(
      (call) =>
        declarationOf(call.expression) === target &&
        tainted(call.arguments[index], depth + 1),
    );
  };
  const declarationTaint = (declaration, depth) => {
    if (!declaration) return false;
    if (ts.isVariableDeclaration(declaration))
      return (
        Boolean(declaration.initializer) &&
        !ts.isFunctionLike(declaration.initializer) &&
        tainted(declaration.initializer, depth + 1)
      );
    if (ts.isParameter(declaration)) return parameterTaint(declaration, depth);
    if (ts.isPropertyAssignment(declaration))
      return tainted(declaration.initializer, depth + 1);
    if (ts.isShorthandPropertyAssignment(declaration))
      return tainted(declaration.name, depth + 1);
    return false;
  };
  const evaluate = (node, depth) => {
    if (ts.isIdentifier(node)) {
      if (isMatrixIdName(node.text)) return true;
      return declarationTaint(declarationOf(node), depth);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === 'id')
        return !NON_MATRIX_ID_OWNERS.has(
          node.expression.getText(tree).split('.').at(-1),
        );
      if (isMatrixIdName(name)) return true;
      // A property of a local object literal carries its initializer's taint;
      // a declared (interface) property is judged by its name alone; any
      // other member (`slice`, `toString`, …) carries its object's taint.
      const declaration = declarationOf(node.name);
      if (declaration) return declarationTaint(declaration, depth);
      // Imported target helpers build `selector` and `filter` without the
      // identifier (their own tests and the client's run-time check prove it).
      if (IDENTIFIER_FREE_MEMBERS.has(name)) return false;
      return tainted(node.expression, depth + 1);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      isMatrixIdName(node.argumentExpression.text)
    )
      return true;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return false;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && tainted(child, depth + 1)) found = true;
    });
    return found;
  };
  return tainted;
}

/** Every job-log sink in one journey whose text can carry a Matrix Room or event id. */
export function matrixIdentifierViolations(source, file = 'journeys.mts') {
  const { tree, checker } = program(file, source);
  const tainted = taintAnalysis(tree, checker);
  const violations = [];
  const report = (node, kind) => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    violations.push(
      `${file}:${line + 1} ${kind}: ${node.getText(tree).replace(/\s+/gu, ' ').slice(0, 120)}`,
    );
  };
  const checkArguments = (call, indices, kind) => {
    call.arguments.forEach((argument, index) => {
      if (indices !== 'all' && !indices.includes(index)) return;
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
        return;
      if (tainted(argument)) report(argument, kind);
    });
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const owner = node.expression.expression.getText(tree);
      if (owner === 'console' && LOG_METHODS.has(method))
        checkArguments(node, 'all', 'console line');
      else if (owner === 'assert' && ASSERT_MESSAGE.has(method))
        checkArguments(node, [ASSERT_MESSAGE.get(method)], 'assertion message');
      else if (/(?:^|\.)client$/u.test(owner) && CLIENT_SINKS.has(method))
        checkArguments(node, CLIENT_SINKS.get(method), `client.${method}`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'assert')
        checkArguments(node, [1], 'assertion message');
      // Shared wrappers that forward their selector and filter to the client.
      if (node.expression.text === 'observedElements')
        checkArguments(node, [2, 4], 'observedElements selector');
      if (node.expression.text === 'waitForNativeShellState')
        checkArguments(node, [2], 'wait description');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (/^(?:Type|Range)?Error$/u.test(node.expression.text))
        checkArguments(node, [0], 'error message');
      if (node.expression.text === 'AggregateError')
        checkArguments(node, [1], 'error message');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
}

/** Only fixed text, the action number, the selector and the flow name reach client log lines. */
export function clientLogViolations(source, file = 'client.mts') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  const allowed = new Set([
    'actionId',
    'selector',
    'flow',
    'description',
    'interruptedReads',
  ]);
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(tree) === 'console'
    ) {
      for (const argument of node.arguments) {
        const spans = ts.isTemplateExpression(argument)
          ? argument.templateSpans
          : [];
        if (
          !ts.isTemplateExpression(argument) &&
          !ts.isStringLiteralLike(argument)
        )
          violations.push(
            `${file}: non-literal console argument ${argument.getText(tree)}`,
          );
        for (const span of spans) {
          const expression = span.expression;
          const text = expression.getText(tree);
          const booleanSummary =
            ts.isCallExpression(expression) &&
            text.startsWith('JSON.stringify({');
          if (
            !(ts.isIdentifier(expression) && allowed.has(text)) &&
            !booleanSummary
          )
            violations.push(`${file}: console interpolates ${text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
}

describe('Android job-log Matrix identifier guard', () => {
  it('covers every Android journey', () => {
    expect(journeyFiles.length).toBeGreaterThanOrEqual(73);
    expect(journeyFiles).toContain('space-settings-core-contents-journey.mts');
  });

  it.each(journeyFiles)(
    '%s never interpolates a Room or event id into a logged selector or message',
    (name) => {
      expect(
        matrixIdentifierViolations(read(`e2e/android/${name}`), name),
      ).toEqual([]);
    },
  );

  it('keeps the shared client and wait logging to fixed, identifier-free values', () => {
    expect(
      clientLogViolations(read('e2e/android/account-workspace-client.mts')),
    ).toEqual([]);
    expect(
      clientLogViolations(read('e2e/android/native-shell-client.mts')),
    ).toEqual([]);
  });

  it.each([
    [
      'a row selector',
      'await client.longPressCurrent(`.msg[data-mid=${JSON.stringify(eventId)}]`);',
    ],
    [
      'a helper selector',
      'function rowSelector(eventId: string): string { return `.msg[data-mid=${JSON.stringify(eventId)}]`; }\nawait client.tapCurrent(rowSelector(history.targetEventId));',
    ],
    [
      'a helper parameter',
      'async function reply(selector: string) { await client.longPressCurrent(selector); }\nawait reply(`.msg[data-mid="${target.eventId}"]`);',
    ],
    [
      'a local constant',
      'const row = `[data-mid=${JSON.stringify(attachment.eventId)}]`;\nconst open = `${row} button`;\nawait client.visible(open, {}, 30_000);',
    ],
    [
      'a Room test id',
      'await client.tapCurrent(`[data-testid="add-to-space-pick-${room.id}"]`);',
    ],
    [
      'a wrapped observation',
      'async function observed(client, assertion, selector) { return client.waitElements(selector, () => true, assertion); }\nawait observed(client, a, `[data-testid="space-content-${room.id}"]`);',
    ],
    [
      'a wait description',
      "await client.waitElements('.row', () => true, `row ${eventId} rendered`);",
    ],
    ['a filter', "await client.visible('.msg', { text: event.eventId });"],
    ['a console line', 'console.info(`[suite] reacted to ${targetEventId}`);'],
    [
      'an assertion message',
      'assert(ok, `Row ${seed.originalId} is visible`);',
    ],
    ['an assert.equal message', 'assert.equal(a, b, `Room ${roomId} ready`);'],
    ['an error message', 'throw new Error(`Missing ${room.id}`);'],
    [
      'a base64url route',
      "console.info(`/rooms/${Buffer.from(room.id).toString('base64url')}`);",
    ],
    [
      'a native wait description',
      'await waitForNativeShellState(read, accept, `event ${eventId}`, signal);',
    ],
    [
      'an identifier-bearing selector field',
      'await client.longPressCurrent(target.eventIdSelector, target.filter);',
    ],
    [
      'an identity selector',
      'await client.eventIdentity(`.msg[data-mid=${JSON.stringify(eventId)}]`, {}, eventId);',
    ],
  ])('rejects %s', (_name, snippet) => {
    expect(matrixIdentifierViolations(snippet)).not.toEqual([]);
  });

  it.each([
    [
      'an identifier-free row and its read-only identity proof',
      'const ROW = \'.scroll .msg[data-mid^="$"]\';\nawait client.longPressCurrent(ROW, { text: body });\nawait client.eventIdentity(ROW, { text: body }, targetEventId);',
    ],
    [
      'stage ids in progress lines',
      'console.info(`[suite] ${entry.id} start`);',
    ],
    [
      'typed values',
      'await client.fill(\'[data-testid="join-input"]\', room.id);',
    ],
    [
      'an id only in a read-only renderer observation',
      'await evaluateNative(client.webview, `document.querySelector(${JSON.stringify(`.msg[data-mid="${eventId}"]`)})?.isConnected`);',
    ],
    [
      'user ids',
      'await client.visible(`a[href="https://matrix.to/#/${account.userId}"]`);',
    ],
  ])('accepts %s', (_name, snippet) => {
    expect(matrixIdentifierViolations(snippet)).toEqual([]);
  });

  it('detects a regression in a real journey and in the client log lines', () => {
    const journey = read('e2e/android/composer-reactions-journeys.mts');
    const regressed = journey.replace(
      'await client.longPressCurrent(MESSAGE_AVATAR, avatar);',
      'await client.longPressCurrent(`.scroll .msg[data-mid=${JSON.stringify(targetEventId)}] trn-avatar`);',
    );
    expect(regressed).not.toBe(journey);
    expect(matrixIdentifierViolations(regressed)).toHaveLength(1);
    const client = read('e2e/android/account-workspace-client.mts');
    const logged = client.replace(
      'console.info(`[accounts] native action ${actionId}: ${flow} ${selector}`);',
      'console.info(`[accounts] native action ${actionId}: ${flow} ${selector} ${JSON.stringify(filter)}`);',
    );
    expect(logged).not.toBe(client);
    expect(clientLogViolations(logged)).toHaveLength(1);
  });

  it('refuses an identifier-bearing selector at run time before any renderer access', async () => {
    const { AccountWorkspaceClient } =
      await import('../e2e/android/account-workspace-client.mts');
    const client = new AccountWorkspaceClient(
      {},
      root,
      root,
      new AbortController().signal,
    );
    const eventId = `$${'aB3_-'.repeat(8)}xyz`;
    for (const call of [
      () => client.elements(`.msg[data-mid="${eventId}"]`),
      () => client.longPressCurrent(`[data-mid="${eventId}"]`),
      () =>
        client.tapCurrent('.channel', {
          within: {
            selector: `[data-room="!AbCdEfGhIjKl:localhost"]`,
            text: 'x',
          },
        }),
      () => client.eventIdentity(`.msg[data-mid="${eventId}"]`, {}, eventId),
    ])
      await expect(call()).rejects.toThrow(
        'Native selectors never carry a Matrix Room or event identifier',
      );
  });
});
