import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, posix, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  readRetiredPredecessor,
  RETIRED_PREDECESSOR_COMMIT,
} from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));

const PREDECESSOR = 'e2e/browser/journeys/conversations/reactions-who.spec.mts';
const predecessor = PREDECESSOR;
const NAVIGATION = 'e2e/support/journeys/navigation.mts';
const SOURCE_SHA256 =
  'dce976ac883e07e14850bfee43cf50050b1b1f334174ba742ca530e2b0dc9b8a';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/journeys/navigation.mts':
    '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
  'e2e/browser/support/settings-journey.mts':
    'b645b7cb0ad697c8a2ec28cf74d0c5a74e0f103ea2ee1a51f8d0c3fad22fb813',
};
const blob = () => readRetiredPredecessor(PREDECESSOR).toString('utf8');
const readPredecessor = blob;
const loadContract = () => import('../e2e/android/who-reacted-contract.mts');
const GENERAL_SPAN = [241, 531];
const MOBILE_SPAN = [534, 709];
const SYNTHETIC = [647, 700];

const LINE_PINS = {
  45: 'expect(response.ok(), `login ${user}: ${response.status()}`).toBe(true);',
  58: 'for (let attempt = 0; attempt < 5; attempt++) {',
  64: 'expect(response.status(), `join ${user}: final status`).toBeLessThan(300);',
  67: 'if (response.status() !== 429) {',
  78: '? Math.min(Math.max(retryAfter, 1), 10_000)',
  79: ': 1_000,',
  82: 'throw new Error(`join ${user}: still rate-limited after 5 attempts`);',
  106: 'const readerUser = `who-reader-${runId}`;',
  108: "`who-other-${runId}-${'x'.repeat(36)}`,",
  109: '...Array.from({ length: 15 }, (_, index) => `who-other-${runId}-${index}`),',
  112: 'const roomName = `Who reacted ${runId}`;',
  113: 'const body = `react to me ${runId}`;',
  137: "{ headers: readerHeaders, data: { name: roomName, preset: 'public_chat' } },",
  142: 'await joinWithRetry(request, hs, roomId, headers, user);',
  146: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/who-${runId}`,',
  147: "{ headers: readerHeaders, data: { msgtype: 'm.text', body } },",
  165: "'m.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },",
  172: "await react(readerHeaders, '👍', `r1-${runId}`);",
  176: "await react(headers, '👍', `r${index + 2}-${runId}`);",
  178: "await react(otherHeaders[0].headers, '🎉', `r10-${runId}`);",
  180: "'❤️',",
  197: "'🌟',",
  198: '].entries()) {',
  202: 'otherHeaders[(index + 1) % otherHeaders.length].headers,',
  204: '`group${index}-${runId}`,',
  221: 'totalReactions: otherUsers.length + 1 + 1 + 18,',
  222: 'reactionGroupCount: 20,',
  228: "await page.getByTestId('rail-rooms').click();",
  229: "const channel = page.locator('.channel', { hasText: roomName });",
  231: 'await channel.first().click();',
  232: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  245: "const runId = `${testResourceId('run')}w`;",
  252: 'await login(page, seeded.reader);',
  253: 'await openRoom(page, seeded.roomName);',
  255: "const row = page.locator('.scroll .msg', { hasText: seeded.body });",
  259: ".locator('.reaction:not(.reaction--who)')",
  264: 'await seeded.sendReactions();',
  265: "await expect(thumbsUp.locator('.reaction__count')).toHaveText(",
  272: "row.first().locator('.reaction:not(.reaction--who)'),",
  273: ').toHaveCount(seeded.reactionGroupCount, { timeout: 30_000 });',
  280: '/^👍 reacted by You, .* and \\d+ others$/,',
  296: 'if (!isAndroidE2E) {',
  318: "await row.first().getByTestId('reactions-who').click();",
  320: 'await expect(dialog).toBeVisible({ timeout: 10_000 });',
  327: 'if (!isAndroidE2E) {',
  348: "await expect(dialog.locator('.reactions-dialog__total')).toHaveText(",
  349: '`${seeded.totalReactions} total`,',
  351: "await expect(page.getByTestId('close-reactions')).toBeVisible();",
  391: "await expect(dialog.getByTestId('reactions-key')).toHaveCount(20);",
  404: "await expect(dialog.locator('.reactor')).toHaveCount(seeded.reactorCount);",
  410: ").toHaveCSS('text-overflow', 'ellipsis');",
  417: '.evaluate((element) => element.scrollWidth - element.clientWidth),',
  419: '.toBeGreaterThan(0);',
  424: '.evaluate((element) => element.scrollHeight - element.clientHeight),',
  471: '} else {',
  475: 'await heart.click();',
  476: "await expect(heart).toHaveAttribute('aria-pressed', 'true');",
  477: "await expect(dialog.locator('.reactor')).toHaveCount(1);",
  524: '} else {',
  528: "await page.keyboard.press('Escape');",
  529: 'await expect(dialog).toBeHidden();',
  548: "`${testResourceId('mobile')}m`,",
  568: 'if (await lightBack.isVisible()) await touch(lightBack);',
  569: 'await openSettingsFromRooms(page, touch);',
  570: "await page.getByTestId('settings-nav-appearance').click();",
  571: "await page.getByTestId('mode-light').click();",
  572: 'await expect.poll(() => hasDarkMode(page)).toBe(false);',
  573: 'await closeSettings(page);',
  574: 'await openRoom(page, seeded.roomName);',
  584: 'await expect(sheetHost).toHaveClass(/reactions-dialog--sheet/);',
  599: 'expect(geometry.bottom).toBeCloseTo(geometry.viewportHeight, 0);',
  605: "await touch(page.getByTestId('close-reactions'));",
  611: "await page.getByTestId('mode-dark').click();",
  612: 'await expect.poll(() => hasDarkMode(page)).toBe(true);',
  639: "const lastKey = dialog.getByTestId('reactions-key').last();",
  640: 'await touch(lastKey);',
  641: "await expect(lastKey).toHaveAttribute('aria-pressed', 'true');",
  643: '.poll(() => directory.evaluate((element) => element.scrollLeft))',
  645: "await expect(dialog.locator('.reactor')).toHaveCount(1);",
  649: 'await page.setViewportSize({ width: 900, height: 800 });',
  668: "element.textContent = '123456789';",
  679: "document.documentElement.style.fontSize = '125%';",
  681: 'await page.setViewportSize({ width: 320, height: 568 });',
  702: 'await pressHostBack();',
  703: 'await expect(dialog).toBeHidden();',
  707: "await expect(page.getByTestId('composer-input')).toBeVisible();",
  714: 'viewport: { width: 393, height: 851 },',
  715: 'hasTouch: true,',
  716: 'isMobile: true,',
  731: "test('uses touch selection and native Back to dismiss the reaction sheet', async ({",
  735: '}) => runMobileReactionJourney(page, request, () => app.pressBack()));',
};

function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(738);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
}

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const endLineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

/** Map a relative import specifier of `from` to a repository path. */
const repositoryPath = (from, specifier) =>
  posix.normalize(posix.join(posix.dirname(from), specifier));

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

/** Corrupt the last alphanumeric character of a pinned line's exact text. */
function corrupt(text) {
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index--) {
    if (/[A-Za-z0-9]/u.test(chars[index])) {
      const ch = chars[index];
      chars[index] =
        ch === '9'
          ? '8'
          : ch === 'z'
            ? 'y'
            : ch === 'Z'
              ? 'Y'
              : String.fromCharCode(ch.charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  throw new Error(
    `No alphanumeric character to corrupt in ${JSON.stringify(text)}`,
  );
}

const parse = (source, name = predecessor) =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
const inside = (line, spans) => spans.some(([a, b]) => line >= a && line <= b);
const nodesOf = (root) => {
  const out = [];
  const visit = (node) => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
};
/** An `expect(…)` call, or an `expect.poll(…)` call unless `identifierOnly`. */
const isAssertion = (node, identifierOnly = false) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text === 'expect') ||
    (!identifierOnly &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'expect' &&
      node.expression.name.text === 'poll'));

function assertionLines(
  source,
  start,
  end,
  name = predecessor,
  identifierOnly = false,
) {
  const tree = parse(source, name);
  return nodesOf(tree)
    .filter((node) => isAssertion(node, identifierOnly))
    .map((node) => lineOf(tree, node))
    .filter((line) => line >= start && line <= end);
}

/**
 * Desktop-only spans: an `if (!isAndroidE2E)` then-block, an
 * `if (isAndroidE2E)` else-block, or the rest of a block after an Android
 * block that ends in `return`.
 */
function desktopSpans(source, [from, to], name = predecessor, notRule = true) {
  const tree = parse(source, name);
  const spans = [];
  for (const node of nodesOf(tree)) {
    if (
      !ts.isIfStatement(node) ||
      lineOf(tree, node) < from ||
      lineOf(tree, node) > to
    )
      continue;
    const condition = node.expression.getText(tree);
    if (condition === '!isAndroidE2E' && notRule)
      spans.push([
        lineOf(tree, node.thenStatement),
        endLineOf(tree, node.thenStatement),
      ]);
    else if (condition === 'isAndroidE2E') {
      if (node.elseStatement)
        spans.push([
          lineOf(tree, node.elseStatement),
          endLineOf(tree, node.elseStatement),
        ]);
      else if (
        ts.isBlock(node.thenStatement) &&
        ts.isReturnStatement(node.thenStatement.statements.at(-1)) &&
        ts.isBlock(node.parent)
      )
        spans.push([
          endLineOf(tree, node) + 1,
          endLineOf(tree, node.parent) - 1,
        ]);
    }
  }
  return spans;
}

/** A TypeChecker over one in-memory source, as #758's importedCalls builds it. */
function checkedProgram(source, fileName = predecessor) {
  const virtual = `/virtual/${basename(fileName)}`;
  const file = ts.createSourceFile(
    virtual,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = {
    getSourceFile: (n) => (n === virtual ? file : undefined),
    getDefaultLibFileName: () => '/virtual/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/virtual',
    getDirectories: () => [],
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (n) => n === virtual,
    readFile: (n) => (n === virtual ? source : undefined),
  };
  const program = ts.createProgram({
    rootNames: [virtual],
    options: {
      noResolve: true,
      noLib: true,
      types: [],
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    host,
  });
  return {
    checker: program.getTypeChecker(),
    tree: program.getSourceFile(virtual),
  };
}
const bindingOf = (identifier, checker) =>
  checker.getSymbolAtLocation(identifier)?.declarations?.[0];
const moduleFunction = (tree, name) =>
  tree.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
/** The `const name = <arrow>` declared directly in `fn`'s body. */
const localArrow = (fn, name) =>
  fn.body.statements
    .flatMap((s) =>
      ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [],
    )
    .find(
      (d) =>
        d.name.getText() === name &&
        d.initializer &&
        ts.isArrowFunction(d.initializer),
    );

/** How many elements an iterated expression yields; fails closed on any other shape. */
function cardinality(e, checker, tree) {
  if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e))
    return cardinality(e.expression, checker, tree);
  if (ts.isArrayLiteralExpression(e))
    return e.elements.reduce(
      (sum, element) =>
        sum +
        (ts.isSpreadElement(element)
          ? cardinality(element.expression, checker, tree)
          : 1),
      0,
    );
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const target = e.expression.expression.getText(tree);
    const method = e.expression.name.text;
    if (target === 'Array' && method === 'from') {
      const [shape] = e.arguments;
      const length =
        shape && ts.isObjectLiteralExpression(shape)
          ? shape.properties.find(
              (p) =>
                ts.isPropertyAssignment(p) && p.name.getText(tree) === 'length',
            )
          : undefined;
      if (length && ts.isNumericLiteral(length.initializer))
        return Number(length.initializer.text);
    } else if (target === 'Promise' && method === 'all')
      return cardinality(e.arguments[0], checker, tree);
    else if (method === 'map' || method === 'entries')
      return cardinality(e.expression.expression, checker, tree);
  }
  if (ts.isIdentifier(e)) {
    const d = bindingOf(e, checker);
    if (d && ts.isVariableDeclaration(d) && d.initializer)
      return cardinality(d.initializer, checker, tree);
  }
  throw new Error(
    `Unsupported cardinality at line ${lineOf(tree, e)}: ${e.getText(tree)}`,
  );
}

/**
 * Executions of `node` per call of `boundary`: the product of every enclosing
 * for-of and `.map` callback. A bounded `for` retry loop counts once, and only
 * on its `if (response.ok()) { …; return; }` path; any other branch or loop throws.
 */
function executions(node, boundary, checker, tree) {
  let count = 1;
  for (
    let child = node, parent = node.parent;
    child !== boundary;
    child = parent, parent = parent.parent
  ) {
    if (!parent) throw new Error('Site is outside its boundary');
    if (ts.isForOfStatement(parent) && child === parent.statement)
      count *= cardinality(parent.expression, checker, tree);
    else if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === 'map' &&
      parent.arguments[0] === child
    )
      count *= cardinality(parent.expression.expression, checker, tree);
    else if (ts.isIfStatement(parent) && child === parent.thenStatement) {
      const block = parent.thenStatement;
      if (
        parent.expression.getText(tree) !== 'response.ok()' ||
        !ts.isBlock(block) ||
        !ts.isReturnStatement(block.statements.at(-1))
      )
        throw new Error(`Unsupported branch at line ${lineOf(tree, parent)}`);
    } else if (ts.isForStatement(parent) && child === parent.statement) {
      if (
        !nodesOf(parent.statement).some(
          (n) =>
            ts.isIfStatement(n) &&
            n.expression.getText(tree) === 'response.ok()',
        )
      )
        throw new Error(`Unsupported loop at line ${lineOf(tree, parent)}`);
    } else if (
      ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isTryStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForStatement(parent)
    )
      throw new Error(
        `Unsupported control flow at line ${lineOf(tree, parent)}`,
      );
  }
  return count;
}

/** The fixture's groups per `seedReactedMessage` call (35) and per `sendReactions` call (36). */
function fixtureGroups(source) {
  const { checker, tree } = checkedProgram(source);
  const seed = moduleFunction(tree, 'seedReactedMessage');
  const react = localArrow(seed, 'react');
  const send = localArrow(seed, 'sendReactions');
  const returned = nodesOf(seed.body).find(
    (n) =>
      ts.isReturnStatement(n) &&
      n.expression &&
      ts.isObjectLiteralExpression(n.expression),
  );
  const shorthand = returned.expression.properties.find(
    (p) =>
      ts.isShorthandPropertyAssignment(p) && p.name.text === 'sendReactions',
  );
  if (
    checker.getShorthandAssignmentValueSymbol(shorthand)?.declarations?.[0] !==
    send
  )
    throw new Error('sendReactions shorthand binding');
  const seedGroups = [];
  const reactionGroups = [];
  for (const node of nodesOf(seed.body)) {
    if (isAssertion(node) && !(node.pos >= react.pos && node.end <= react.end))
      seedGroups.push({
        helper: 'seedReactedMessage',
        line: lineOf(tree, node),
        via: lineOf(tree, node),
        count: executions(node, seed, checker, tree),
      });
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
      continue;
    const d = bindingOf(node.expression, checker);
    if (d === react) {
      for (const site of nodesOf(react.initializer).filter((n) =>
        isAssertion(n),
      ))
        reactionGroups.push({
          helper: 'react',
          line: lineOf(tree, site),
          via: lineOf(tree, node),
          count: executions(node, send.initializer, checker, tree),
        });
    } else if (
      d &&
      ts.isFunctionDeclaration(d) &&
      ts.isSourceFile(d.parent) &&
      ['loginApi', 'joinWithRetry'].includes(d.name.text)
    ) {
      for (const site of nodesOf(d).filter((n) => isAssertion(n)))
        seedGroups.push({
          helper: d.name.text,
          line: lineOf(tree, site),
          via: lineOf(tree, node),
          count:
            executions(node, seed, checker, tree) *
            executions(site, d, checker, tree),
        });
    }
  }
  const byVia = (a, b) => a.via - b.via;
  return {
    seed: seedGroups.sort(byVia),
    reactions: reactionGroups.sort(byVia),
  };
}

/** A helper's assertion lines along its Android path. */
function androidHelperLines(
  module,
  name,
  source = module === predecessor ? readPredecessor() : read(module),
) {
  const tree = parse(source, module);
  const d = moduleFunction(tree, name);
  const span = [lineOf(tree, d), endLineOf(tree, d)];
  const desktop = desktopSpans(source, span, module);
  return assertionLines(source, ...span, module).filter(
    (l) => !inside(l, desktop),
  );
}

const NO_SITE = new Set([
  'test',
  'expect',
  'login',
  'registerUser',
  'hasDarkMode',
  'captureScreenshot',
  'synapseSession',
  'testResourceId',
  'wait',
]);

/** Every Android parity group of one definition span, in record order. */
function deriveStage(source, [from, to], excluded = [], notRule = true) {
  const { checker, tree } = checkedProgram(source);
  const desktop = [
    ...desktopSpans(source, [from, to], predecessor, notRule),
    ...excluded,
  ];
  const groups = assertionLines(source, from, to)
    .filter((l) => !inside(l, desktop))
    .map((line) => ({ kind: 'direct', line, key: [line, 1, 0] }));
  const fixture = fixtureGroups(source);
  for (const node of nodesOf(tree)) {
    if (!ts.isCallExpression(node)) continue;
    const line = lineOf(tree, node);
    if (line < from || line > to || inside(line, desktop)) continue;
    if (ts.isIdentifier(node.expression)) {
      const d = bindingOf(node.expression, checker);
      const name =
        d && ts.isImportSpecifier(d)
          ? (d.propertyName ?? d.name).text
          : d && ts.isFunctionDeclaration(d) && ts.isSourceFile(d.parent)
            ? d.name.text
            : null;
      if (name === 'seedReactedMessage')
        groups.push(
          ...fixture.seed.map((g) => ({
            kind: 'inherited',
            ...g,
            call: line,
            key: [line, 0, g.via],
          })),
        );
      else if (name === 'openRoom')
        for (const l of androidHelperLines(predecessor, 'openRoom', source))
          groups.push({
            kind: 'inherited',
            helper: 'openRoom',
            line: l,
            via: l,
            count: 1,
            call: line,
            key: [line, 0, l],
          });
      else if (name === 'openSettingsFromRooms' || name === 'closeSettings')
        for (const l of androidHelperLines(NAVIGATION, name))
          groups.push({
            kind: 'inherited',
            helper: name,
            line: l,
            via: l,
            count: 1,
            call: line,
            key: [line, 0, l],
          });
      else if (name !== null && !NO_SITE.has(name))
        throw new Error(`Unclassified helper ${name} at ${line}`);
    } else if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'sendReactions'
    ) {
      const receiver = node.expression.expression;
      const d = ts.isIdentifier(receiver)
        ? bindingOf(receiver, checker)
        : undefined;
      let init = d && ts.isVariableDeclaration(d) ? d.initializer : undefined;
      if (init && ts.isAwaitExpression(init)) init = init.expression;
      const callee =
        init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
          ? bindingOf(init.expression, checker)
          : undefined;
      if (!(
        callee &&
        ts.isFunctionDeclaration(callee) &&
        callee.name?.text === 'seedReactedMessage'
      ))
        throw new Error(`Unbound sendReactions at ${line}`);
      groups.push(
        ...fixture.reactions.map((g) => ({
          kind: 'inherited',
          ...g,
          call: line,
          key: [line, 0, g.via],
        })),
      );
    }
  }
  const cmp = (a, b) =>
    a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2];
  return groups
    .sort(cmp)
    .map((g) =>
      g.kind === 'direct'
        ? ['direct', g.line]
        : [g.helper, g.line, g.call, g.via, g.count],
    );
}
const total = (groups) =>
  groups.reduce((sum, g) => sum + (g[0] === 'direct' ? 1 : g[4]), 0);

const GENERAL_GROUPS = [
  ['loginApi', 45, 246, 119, 1],
  ['loginApi', 45, 246, 130, 16],
  ['seedReactedMessage', 139, 246, 139, 1],
  ['joinWithRetry', 64, 246, 142, 16],
  ['seedReactedMessage', 149, 246, 149, 1],
  ['openRoom', 232, 253, 232, 1],
  ['direct', 256],
  ['react', 169, 264, 172, 1],
  ['react', 169, 264, 176, 16],
  ['react', 169, 264, 178, 1],
  ['react', 169, 264, 201, 18],
  ['direct', 265],
  ['direct', 271],
  ['direct', 278],
  ['direct', 320],
  ['direct', 348],
  ['direct', 351],
  ['direct', 391],
  ['direct', 401],
  ['direct', 404],
  ['direct', 405],
  ['direct', 411],
  ['direct', 420],
  ['direct', 476],
  ['direct', 477],
  ['direct', 529],
];
const MOBILE_GROUPS = [
  ['loginApi', 45, 545, 119, 1],
  ['loginApi', 45, 545, 130, 16],
  ['seedReactedMessage', 139, 545, 139, 1],
  ['joinWithRetry', 64, 545, 142, 16],
  ['seedReactedMessage', 149, 545, 149, 1],
  ['openRoom', 232, 551, 232, 1],
  ['direct', 553],
  ['react', 169, 557, 172, 1],
  ['react', 169, 557, 176, 16],
  ['react', 169, 557, 178, 1],
  ['react', 169, 557, 201, 18],
  ['direct', 558],
  ['direct', 562],
  ['openSettingsFromRooms', 19, 569, 19, 1],
  ['openSettingsFromRooms', 32, 569, 32, 1],
  ['direct', 572],
  ['closeSettings', 69, 573, 69, 1],
  ['closeSettings', 84, 573, 84, 1],
  ['closeSettings', 99, 573, 99, 1],
  ['openRoom', 232, 574, 232, 1],
  ['direct', 583],
  ['direct', 584],
  ['direct', 597],
  ['direct', 598],
  ['direct', 599],
  ['direct', 606],
  ['openSettingsFromRooms', 19, 609, 19, 1],
  ['openSettingsFromRooms', 32, 609, 32, 1],
  ['direct', 612],
  ['closeSettings', 69, 613, 69, 1],
  ['closeSettings', 84, 613, 84, 1],
  ['closeSettings', 99, 613, 99, 1],
  ['openRoom', 232, 614, 232, 1],
  ['direct', 618],
  ['direct', 626],
  ['direct', 633],
  ['direct', 641],
  ['direct', 642],
  ['direct', 645],
  ['direct', 703],
  ['direct', 707],
];

/**
 * Resolve every call through the TypeChecker. A call binds to a helper only
 * when its symbol is a named import or a module-level function declaration, so
 * a shadowing local of the same name never expands.
 */
function naiveCalls(source, fileName = predecessor) {
  const virtual = `/virtual/${basename(fileName)}`;
  const file = ts.createSourceFile(
    virtual,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = {
    getSourceFile: (name) => (name === virtual ? file : undefined),
    getDefaultLibFileName: () => '/virtual/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/virtual',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === virtual,
    readFile: (name) => (name === virtual ? source : undefined),
  };
  const program = ts.createProgram({
    rootNames: [virtual],
    options: {
      noResolve: true,
      noLib: true,
      types: [],
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    host,
  });
  const checker = program.getTypeChecker();
  const tree = program.getSourceFile(virtual);
  const calls = [];
  const shadowed = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)
        ?.declarations?.[0];
      if (declaration && ts.isImportSpecifier(declaration)) {
        calls.push({
          name: (declaration.propertyName ?? declaration.name).text,
          specifier: declaration.parent.parent.parent.moduleSpecifier.text,
          line: lineOf(tree, node),
        });
      } else if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        ts.isSourceFile(declaration.parent)
      ) {
        calls.push({
          name: node.expression.text,
          specifier: null,
          line: lineOf(tree, node),
        });
      } else if (declaration) {
        shadowed.push({ name: node.expression.text, line: lineOf(tree, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { calls, shadowed };
}

/** Every `expect` line a helper reaches, following module-local and relative imports. */
function naiveHelperLines(
  module,
  name,
  source = module === predecessor ? readPredecessor() : read(module),
  seen = new Set(),
) {
  const key = `${module}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const tree = ts.createSourceFile(
    module,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = tree.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) return [];
  const start = lineOf(tree, declaration);
  const end = endLineOf(tree, declaration);
  const own = assertionLines(source, start, end, module).map((line) => ({
    module,
    line,
  }));
  const { calls } = naiveCalls(source, module);
  const nested = calls
    .filter((call) => call.line >= start && call.line <= end)
    .flatMap((call) =>
      call.specifier === null
        ? naiveHelperLines(module, call.name, source, seen)
        : call.specifier.startsWith('.')
          ? naiveHelperLines(
              repositoryPath(module, call.specifier),
              call.name,
              undefined,
              seen,
            )
          : [],
    );
  return [...own, ...nested];
}

/**
 * Expand a definition into parity sites by following every module-local or
 * `support/` call in its span (AST-derived, rule (c)). Unlike message-quote's
 * guard, this has no `isAndroidE2E` branch awareness, so its output is
 * compared against the contract's site table with `toEqual` rather than
 * trusted on its own.
 */
function naiveExpand(source, span) {
  const [from, to] = span;
  const { calls } = naiveCalls(source);
  const inherited = calls
    .filter(
      (call) =>
        call.line >= from &&
        call.line <= to &&
        (call.specifier === null ||
          /^(\.\.\/){2,3}support\//u.test(call.specifier)),
    )
    .flatMap((call) => {
      const module =
        call.specifier === null
          ? predecessor
          : repositoryPath(predecessor, call.specifier);
      const lines = naiveHelperLines(
        module,
        call.name,
        call.specifier === null ? source : undefined,
      );
      return lines.map(({ line }) => ({
        kind: 'inherited',
        line,
        helper: call.name,
        call: call.line,
      }));
    });
  const direct = assertionLines(source, from, to).map((line) => ({
    kind: 'direct',
    line,
  }));
  const key = (site) =>
    site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
  return [...inherited, ...direct].sort((a, b) => {
    const [left, right] = [key(a), key(b)];
    return left[0] - right[0] || left[1] - right[1];
  });
}

describe('Android who-reacted predecessor pins', () => {
  it('pins the dd0cb53c blob and the working tree at one hash, byte-equal, and four shared sources', () => {
    expect(RETIRED_PREDECESSOR_COMMIT.startsWith('dd0cb53c')).toBe(true);
    expect(sha256(blob())).toBe(SOURCE_SHA256);
    expect(sha256(read(PREDECESSOR))).toBe(SOURCE_SHA256);
    expect(read(PREDECESSOR) === blob()).toBe(true);
    for (const [path, hash] of Object.entries(SHARED_SHA256)) {
      expect(digest(path)).toBe(hash);
      const committed = execFileSync(
        'git',
        ['show', `${RETIRED_PREDECESSOR_COMMIT}:${path}`],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      );
      expect(
        sha256(committed),
        `${path} at ${RETIRED_PREDECESSOR_COMMIT}`,
      ).toBe(hash);
    }
    const flippedBlob = Buffer.from(blob());
    flippedBlob[0] ^= 1;
    expect(sha256(flippedBlob)).not.toBe(SOURCE_SHA256);
    const flippedTree = Buffer.from(readFileSync(resolve(root, PREDECESSOR)));
    flippedTree[0] ^= 1;
    expect(sha256(flippedTree)).not.toBe(SOURCE_SHA256);
    expect(flippedTree.toString('utf8') === blob()).toBe(false);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('pins every generated line', () => {
    assertPredecessorShape(readPredecessor());
  });

  it('fails every text pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
    for (const [line, text] of Object.entries(LINE_PINS)) {
      // A pin with no alphanumeric character (an emoji key) is corrupted by a prefix.
      const bad = /[A-Za-z0-9]/u.test(text) ? corrupt(text) : `x${text}`;
      const mutated = mutateLine(source, Number(line), (raw) =>
        raw.replace(text, bad),
      );
      expect(mutated, `line ${line} mutation applied`).not.toBe(source);
      expect(() => assertPredecessorShape(mutated), `line ${line}`).toThrow();
    }
  });

  it('pins the definition, helper and describe spans by AST', () => {
    const tree = parse(readPredecessor());
    const span = (node) => [lineOf(tree, node), endLineOf(tree, node)];
    const fn = (name) => moduleFunction(tree, name);
    expect(span(fn('loginApi'))).toEqual([32, 48]);
    expect(span(fn('joinWithRetry'))).toEqual([51, 83]);
    const seeded = tree.statements.find(
      (s) => ts.isInterfaceDeclaration(s) && s.name.text === 'Seeded',
    );
    expect(span(seeded)).toEqual([85, 95]);
    expect(span(fn('seedReactedMessage'))).toEqual([101, 225]);
    expect(span(fn('openRoom'))).toEqual([227, 235]);
    expect(span(fn('runMobileReactionJourney'))).toEqual([534, 709]);
    const seed = fn('seedReactedMessage');
    expect(span(localArrow(seed, 'react'))).toEqual([155, 170]);
    expect(span(localArrow(seed, 'sendReactions'))).toEqual([171, 207]);
    const tests = nodesOf(tree).filter(
      (n) => ts.isCallExpression(n) && n.expression.getText(tree) === 'test',
    );
    expect(tests.map((t) => [lineOf(tree, t), endLineOf(tree, t)])).toEqual([
      [241, 531],
      [723, 729],
      [731, 735],
    ]);
    expect(tests.map((t) => t.arguments[0].text)).toEqual([
      'names the reactors on the pill and lists them all in the dialog',
      'keeps the reaction sheet bounded, touch-selectable and scrollable',
      'uses touch selection and native Back to dismiss the reaction sheet',
    ]);
  });
});

describe('Android who-reacted AST site map', () => {
  it('maps 16 general and 19 mobile Android sites, counting expect.poll', () => {
    const src = readPredecessor();
    const android = (span, excluded = []) =>
      assertionLines(src, ...span).filter(
        (l) => !inside(l, [...desktopSpans(src, span), ...excluded]),
      );
    expect(android(GENERAL_SPAN)).toEqual([
      256, 265, 271, 278, 320, 348, 351, 391, 401, 404, 405, 411, 420, 476, 477,
      529,
    ]);
    expect(android(MOBILE_SPAN, [SYNTHETIC])).toEqual([
      553, 558, 562, 572, 583, 584, 597, 598, 599, 606, 612, 618, 626, 633, 641,
      642, 645, 703, 707,
    ]);
    const idOnly = (span, excluded = []) =>
      assertionLines(src, ...span, predecessor, true).filter(
        (l) => !inside(l, [...desktopSpans(src, span), ...excluded]),
      );
    expect([
      idOnly(GENERAL_SPAN).length,
      idOnly(MOBILE_SPAN, [SYNTHETIC]).length,
    ]).toEqual([14, 14]);
  });

  it('derives every desktop span and exclusion', () => {
    const src = readPredecessor();
    expect(desktopSpans(src, GENERAL_SPAN)).toEqual([
      [296, 306],
      [309, 317],
      [327, 345],
      [354, 388],
      [392, 400],
      [428, 471],
      [482, 505],
      [507, 524],
    ]);
    expect(desktopSpans(src, MOBILE_SPAN)).toEqual([
      [543, 543],
      [704, 706],
    ]);
    expect(desktopSpans(src, [711, 737])).toEqual([[718, 730]]);
    expect(desktopSpans(read(NAVIGATION), [1, 200], NAVIGATION)).toEqual([
      [37, 44],
      [104, 105],
    ]);
    const desktopSites = assertionLines(src, ...GENERAL_SPAN).filter((l) =>
      inside(l, desktopSpans(src, GENERAL_SPAN)),
    );
    expect(desktopSites).toHaveLength(35);
    expect(assertionLines(src, ...SYNTHETIC)).toEqual([
      650, 651, 653, 654, 655, 656, 670, 682, 683, 685, 686, 687, 688,
    ]);
    expect(
      assertionLines(src, ...MOBILE_SPAN).filter((l) =>
        inside(l, desktopSpans(src, MOBILE_SPAN)),
      ),
    ).toEqual([705]);
  });

  it('drops to 51 general sites without the !isAndroidE2E rule', () => {
    const src = readPredecessor();
    expect(
      assertionLines(src, ...GENERAL_SPAN).filter(
        (l) => !inside(l, desktopSpans(src, GENERAL_SPAN, predecessor, false)),
      ),
    ).toHaveLength(51);
  });
});

describe('Android who-reacted helper expansion by binding and multiplicity', () => {
  const totals = (src) => [
    total(deriveStage(src, GENERAL_SPAN)),
    total(deriveStage(src, MOBILE_SPAN, [SYNTHETIC])),
  ];
  const replaceOnce = (src, from, to) => {
    expect(src).toContain(from);
    const out = src.replace(from, () => to);
    expect(out).not.toBe(src);
    return out;
  };

  it('derives 88 and 103 records in record order', () => {
    const src = readPredecessor();
    const general = deriveStage(src, GENERAL_SPAN);
    const mobile = deriveStage(src, MOBILE_SPAN, [SYNTHETIC]);
    expect(general).toEqual(GENERAL_GROUPS);
    expect(mobile).toEqual(MOBILE_GROUPS);
    expect([total(general), total(mobile)]).toEqual([88, 103]);
  });

  it('follows navigation along its Android path only', () => {
    expect(androidHelperLines(NAVIGATION, 'openSettingsFromRooms')).toEqual([
      19, 32,
    ]);
    expect(androidHelperLines(NAVIGATION, 'closeSettings')).toEqual([
      69, 84, 99,
    ]);
    const all = assertionLines(read(NAVIGATION), 1, 200, NAVIGATION);
    for (const line of [41, 44, 105]) expect(all).toContain(line);
  });

  it('reaches no site through the non-asserting helpers', () => {
    expect(androidHelperLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      androidHelperLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    const settings = 'e2e/browser/support/settings-journey.mts';
    const tree = parse(read(settings), settings);
    const declaration = nodesOf(tree).find(
      (n) =>
        ts.isVariableDeclaration(n) && n.name.getText(tree) === 'hasDarkMode',
    );
    expect(
      declaration?.initializer && ts.isArrowFunction(declaration.initializer),
    ).toBe(true);
    expect(nodesOf(declaration).some((n) => isAssertion(n))).toBe(false);
    const shot = 'e2e/support/screenshot.mts';
    expect(assertionLines(read(shot), 1, 100000, shot)).toEqual([]);
  });

  it('counts multiplicities from the AST and fails closed', () => {
    const src = readPredecessor();
    expect(
      totals(replaceOnce(src, '{ length: 15 }', '{ length: 14 }')),
    ).toEqual([85, 100]);
    expect(totals(replaceOnce(src, "'🌟',", "'🌟',\n      '🌙',"))).toEqual([
      89, 104,
    ]);
    const r10 = "await react(otherHeaders[0].headers, '🎉', `r10-${runId}`);";
    expect(() => totals(replaceOnce(src, r10, `if (runId) ${r10}`))).toThrow(
      'Unsupported branch at line 178',
    );
    const r1 = "await react(readerHeaders, '👍', `r1-${runId}`);";
    expect(() => totals(replaceOnce(src, r1, `while (!runId) ${r1}`))).toThrow(
      'Unsupported control flow',
    );
    const lines = src.split('\n');
    expect(lines[64].trim()).toBe('return;');
    lines.splice(64, 1);
    expect(() => totals(lines.join('\n'))).toThrow(
      'Unsupported branch at line 63',
    );
  });

  it('does not expand a shadowing local or an unbound receiver', () => {
    const src = readPredecessor();
    const insertAfter = (source, line, text) => {
      const lines = source.split('\n');
      lines.splice(line, 0, text);
      return lines.join('\n');
    };
    const sendStart = 171;
    const shadowReact = insertAfter(
      src,
      sendStart,
      '    const react = async (..._a: unknown[]) => {};',
    );
    expect(totals(shadowReact)).toEqual([52, 67]);
    expect(deriveStage(shadowReact, GENERAL_SPAN)).not.toEqual(GENERAL_GROUPS);

    const shadowRoom = insertAfter(
      src,
      252,
      '    const openRoom = async (..._a: unknown[]) => {};',
    );
    expect(total(deriveStage(shadowRoom, GENERAL_SPAN))).toBe(87);

    const unbound = mutateLine(
      src,
      264,
      () => '    await ({ sendReactions: async () => {} }).sendReactions();',
    );
    expect(() => deriveStage(unbound, GENERAL_SPAN)).toThrow(
      'Unbound sendReactions at 264',
    );

    const shadowLogin = insertAfter(
      src,
      105,
      "  const loginApi = async (..._a: unknown[]) => '';",
    );
    expect(total(deriveStage(shadowLogin, GENERAL_SPAN))).toBe(71);
  });

  it('a naive expansion counts 73 and 57, not 88 and 103', () => {
    const src = readPredecessor();
    expect(naiveExpand(src, GENERAL_SPAN)).toHaveLength(73);
    expect(naiveExpand(src, MOBILE_SPAN)).toHaveLength(57);
  });
});

const IMPORTED_SHAPES = {
  'e2e/android/message-quote-observer.mts': {
    ObservationOptions: 'accepts,description,timeoutMs',
    readAppliedProfile:
      '(client: AccountWorkspaceClient, options: ObservationOptions<AppliedProfileObservation> = {}): Promise<AppliedProfileObservation>',
  },
  'e2e/android/pinned-message-panel-artifacts.mts': {
    PinnedPanelPublicationSafety: 'unsafeSecrets,cleanupFailed,scrubFailed',
    redactDiagnosticText:
      '(text: string, secrets: Readonly<Record<string, string>>): string',
    scrubPinnedPanelArtifacts:
      '(output: string, secrets: Readonly<Record<string, string>>): Promise<void>',
    scanPinnedPanelArtifacts:
      '(output: string, secrets: Readonly<Record<string, string>>): Promise<void>',
    runPinnedPanelStageCleanup:
      '(actions: readonly (() => Promise<void>)[], failures: unknown[]): Promise<void>',
  },
};
const NATIVE_BACK_FLOW = 'e2e/android/flows/native-shell-back.yaml';
const NATIVE_BACK_TEXT =
  'appId: ${APP_ID}\nandroidWebViewHierarchy: devtools\n---\n- pressKey: BACK\n';
const NATIVE_BACK_SHA256 =
  'adc7db0f5268cdf9ac3797b3ccba2763ec52fde773b305011236c74c4a9e43c1';

/** Exported declarations' normalized shapes, keyed by name. */
function exportedShapes(file, source = read(file)) {
  const norm = (t) =>
    t
      .replace(/\s+/gu, ' ')
      .replace(/,\s*\)/gu, ')')
      .trim();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = {};
  for (const st of tree.statements) {
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (ts.isFunctionDeclaration(st))
      out[st.name.text] = norm(
        `(${st.parameters.map((p) => p.getText(tree)).join(', ')}): ${st.type?.getText(tree)}`,
      );
    else if (ts.isInterfaceDeclaration(st))
      out[st.name.text] = st.members
        .map((m) => m.name?.getText(tree))
        .join(',');
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        out[d.name.text] = `const ${d.initializer.getText(tree)}`;
  }
  return out;
}

describe('Android who-reacted imported-export shape', () => {
  it('pins the shape of every name imported from message-quote and pinned-message-panel', () => {
    for (const [file, names] of Object.entries(IMPORTED_SHAPES)) {
      const shapes = exportedShapes(file);
      for (const [name, shape] of Object.entries(names))
        expect(shapes[name], `${file}#${name}`).toBe(shape);
    }
    expect(read(NATIVE_BACK_FLOW)).toBe(NATIVE_BACK_TEXT);
    expect(digest(NATIVE_BACK_FLOW)).toBe(NATIVE_BACK_SHA256);
  });

  it('imports exactly these names and nothing else from those modules', () => {
    for (const path of [
      'e2e/android/who-reacted-contract.mts',
      'e2e/android/who-reacted-observer.mts',
      'e2e/android/who-reacted-artifacts.mts',
      'e2e/android/who-reacted-journeys.mts',
    ]) {
      if (!existsSync(resolve(root, path))) continue;
      const tree = ts.createSourceFile(
        path,
        read(path),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const st of tree.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const spec = st.moduleSpecifier.text;
        if (
          !spec.startsWith('./message-quote-') &&
          !spec.startsWith('./pinned-message-panel-')
        )
          continue;
        const shapes =
          IMPORTED_SHAPES[
            `e2e/android/${spec.slice(2).replace(/\.mts$/u, '')}.mts`
          ];
        expect(shapes, `${path} imports ${spec}`).toBeDefined();
        for (const element of st.importClause?.namedBindings?.elements ?? [])
          expect(
            Object.keys(shapes),
            `${path}: ${element.name.text}`,
          ).toContain((element.propertyName ?? element.name).text);
      }
    }
  });

  it('fails each shape pin under an effective mutation', () => {
    const observer = 'e2e/android/message-quote-observer.mts';
    const artifacts = 'e2e/android/pinned-message-panel-artifacts.mts';
    const cases = [
      [
        observer,
        'readAppliedProfile',
        (s) =>
          s.replace(
            /Promise<AppliedProfileObservation> \{/u,
            'Promise<unknown> {',
          ),
      ],
      [
        observer,
        'ObservationOptions',
        (s) => s.replace(/\n\s*readonly timeoutMs[^\n]*/u, ''),
      ],
      [
        artifacts,
        'runPinnedPanelStageCleanup',
        (s) =>
          s.replace(
            /(export (?:async )?function runPinnedPanelStageCleanup\(\s*actions: [^,]*,)/u,
            '$1 extra: string,',
          ),
      ],
      [
        artifacts,
        'scanPinnedPanelArtifacts',
        (s) =>
          s.replace(/export (async function scanPinnedPanelArtifacts)/u, '$1'),
      ],
    ];
    for (const [file, name, mutate] of cases) {
      const source = read(file);
      const mutated = mutate(source);
      expect(mutated, `${file}#${name} mutation applied`).not.toBe(source);
      expect(exportedShapes(file, mutated)[name], `${file}#${name}`).not.toBe(
        IMPORTED_SHAPES[file][name],
      );
    }
    expect(NATIVE_BACK_TEXT.replace('BACK', 'HOME')).not.toBe(
      read(NATIVE_BACK_FLOW),
    );
    expect(sha256(NATIVE_BACK_TEXT.replace('BACK', 'HOME'))).not.toBe(
      NATIVE_BACK_SHA256,
    );
  });
});

const STAGE_SUFFIXES = (stage) => stage.sites.map((s) => s.suffix);

describe('Android who-reacted contract ledger', () => {
  it('equals the AST output group by group', async () => {
    const c = await loadContract();
    const grouped = (sites) => {
      const out = [];
      for (const s of sites) {
        const tuple =
          s.kind === 'direct'
            ? ['direct', s.line]
            : [s.helper, s.line, s.call, s.via];
        const last = out.at(-1);
        if (
          s.kind === 'inherited' &&
          last &&
          last[0] !== 'direct' &&
          last.slice(0, 4).every((v, i) => v === tuple[i])
        )
          last[4]++;
        else out.push(s.kind === 'direct' ? tuple : [...tuple, 1]);
      }
      return out;
    };
    const [general, mobile] = c.WHO_REACTED_STAGES;
    const expectedGeneral = deriveStage(readPredecessor(), GENERAL_SPAN);
    const expectedMobile = deriveStage(readPredecessor(), MOBILE_SPAN, [
      SYNTHETIC,
    ]);
    expect(grouped(general.sites)).toEqual(expectedGeneral);
    expect(grouped(mobile.sites)).toEqual(expectedMobile);
    const movedVia = general.sites.map((s, i) =>
      i === 40 ? { ...s, via: 175 } : s,
    );
    expect(grouped(movedVia)).not.toEqual(expectedGeneral);
    const noLast = general.sites.filter((s) => s.suffix !== 'reaction-36');
    expect(noLast).toHaveLength(general.sites.length - 1);
    expect(grouped(noLast)).not.toEqual(expectedGeneral);
  });

  it('pins sources, spans, helpers and exclusions', async () => {
    const c = await loadContract();
    const src = readPredecessor();
    expect(c.WHO_REACTED_SOURCE).toBe(PREDECESSOR);
    expect(c.WHO_REACTED_SOURCE_SHA256).toBe(SOURCE_SHA256);
    expect(c.WHO_REACTED_SOURCE_LINES).toBe(737);
    expect(c.WHO_REACTED_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    expect(c.WHO_REACTED_SPANS).toEqual({
      loginApi: { from: 32, to: 48 },
      joinWithRetry: { from: 51, to: 83 },
      seedReactedMessage: { from: 101, to: 225 },
      react: { from: 155, to: 170 },
      sendReactions: { from: 171, to: 207 },
      openRoom: { from: 227, to: 235 },
      fixtureAndRoom: { from: 32, to: 235 },
      general: { from: 241, to: 531 },
      mobileJourney: { from: 534, to: 709 },
      synthetic: { from: 647, to: 700 },
      pixelDefinition: { from: 723, to: 729 },
      mobileDefinition: { from: 731, to: 735 },
    });
    expect([
      c.WHO_REACTED_SPANS.general.from,
      c.WHO_REACTED_SPANS.general.to,
    ]).toEqual(GENERAL_SPAN);
    expect([
      c.WHO_REACTED_SPANS.mobileJourney.from,
      c.WHO_REACTED_SPANS.mobileJourney.to,
    ]).toEqual(MOBILE_SPAN);
    expect([
      c.WHO_REACTED_SPANS.synthetic.from,
      c.WHO_REACTED_SPANS.synthetic.to,
    ]).toEqual(SYNTHETIC);
    expect(c.WHO_REACTED_HELPERS.openRoom.expectLines).toEqual(
      androidHelperLines(predecessor, 'openRoom', src),
    );
    expect(c.WHO_REACTED_HELPERS.openSettingsFromRooms.expectLines).toEqual(
      androidHelperLines(NAVIGATION, 'openSettingsFromRooms'),
    );
    expect(c.WHO_REACTED_HELPERS.closeSettings.expectLines).toEqual(
      androidHelperLines(NAVIGATION, 'closeSettings'),
    );
    expect(c.WHO_REACTED_HELPERS.loginApi.expectLines).toEqual(
      androidHelperLines(predecessor, 'loginApi', src),
    );
    expect(c.WHO_REACTED_HELPERS.joinWithRetry.expectLines).toEqual(
      androidHelperLines(predecessor, 'joinWithRetry', src),
    );
    expect(c.WHO_REACTED_HELPERS.react.expectLines).toEqual([169]);
    const desktopGeneral = desktopSpans(src, GENERAL_SPAN);
    const desktopMobile = desktopSpans(src, MOBILE_SPAN);
    expect(c.WHO_REACTED_EXCLUDED.generalDesktopSpans).toEqual(desktopGeneral);
    expect(c.WHO_REACTED_EXCLUDED.generalDesktopSites).toBe(
      assertionLines(src, ...GENERAL_SPAN).filter((l) =>
        inside(l, desktopGeneral),
      ).length,
    );
    expect(c.WHO_REACTED_EXCLUDED.mobileDesktopSpans).toEqual(desktopMobile);
    expect(c.WHO_REACTED_EXCLUDED.mobileDesktopSites).toEqual(
      assertionLines(src, ...MOBILE_SPAN).filter((l) =>
        inside(l, desktopMobile),
      ),
    );
    expect(c.WHO_REACTED_EXCLUDED.syntheticSites).toEqual(
      assertionLines(src, ...SYNTHETIC),
    );
    expect(c.WHO_REACTED_EXCLUDED.pixelDefinitionSpan).toEqual(
      desktopSpans(src, [711, 737])[0],
    );
    expect(c.WHO_REACTED_EXCLUDED.navigationDesktopSpans).toEqual(
      desktopSpans(read(NAVIGATION), [1, 200], NAVIGATION),
    );
  });

  it('owns 88 + 103 = 191 unique identities', async () => {
    const c = await loadContract();
    const [general, mobile] = c.WHO_REACTED_STAGES;
    expect(c.WHO_REACTED_STAGE_IDS).toEqual(['pill-dialog', 'mobile-sheet']);
    expect(c.WHO_REACTED_STAGES.map((s) => s.id)).toEqual([
      ...c.WHO_REACTED_STAGE_IDS,
    ]);
    expect([general.assertions.length, mobile.assertions.length]).toEqual([
      88, 103,
    ]);
    expect(c.WHO_REACTED_STAGE_RECORDS).toEqual({
      'pill-dialog': 88,
      'mobile-sheet': 103,
    });
    expect(c.WHO_REACTED_ASSERTION_RECORDS).toBe(191);
    expect(new Set([...general.assertions, ...mobile.assertions]).size).toBe(
      191,
    );
    expect(general.source).toBe(`${PREDECESSOR}:241-531`);
    expect(mobile.source).toBe(`${PREDECESSOR}:731-735`);
    expect(general.title).toBe(
      'names the reactors on the pill and lists them all in the dialog',
    );
    expect(mobile.title).toBe(
      'uses touch selection and native Back to dismiss the reaction sheet',
    );
    expect(general.assertions.at(0)).toBe(
      'who-reacted.pill-dialog.api-login-reader',
    );
    expect(general.assertions.at(-1)).toBe(
      'who-reacted.pill-dialog.dialog-dismissed',
    );
    expect(mobile.assertions.at(0)).toBe(
      'who-reacted.mobile-sheet.api-login-reader',
    );
    expect(mobile.assertions.at(-1)).toBe(
      'who-reacted.mobile-sheet.composer-visible',
    );
    expect(c.siteOrderKey({ kind: 'direct', line: 256, suffix: 'x' })).toEqual([
      256, 1, 0, 0,
    ]);
    expect(
      c.siteOrderKey({
        kind: 'inherited',
        helper: 'react',
        line: 169,
        call: 264,
        via: 176,
        index: 3,
        suffix: 'x',
      }),
    ).toEqual([264, 0, 176, 3]);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const c = await loadContract();
    for (const stage of c.WHO_REACTED_STAGES) {
      const all = [...stage.assertions];
      expect(() => c.assertWhoReactedRecords(stage.id, all)).not.toThrow();
      for (const invalid of [
        [],
        all.slice(0, -1),
        [...all, all.at(-1)],
        [...all].reverse(),
      ])
        expect(() => c.assertWhoReactedRecords(stage.id, invalid)).toThrow();
      for (const suffix of STAGE_SUFFIXES(stage))
        expect(c.whoReactedAssertion(stage.id, suffix)).toBe(
          `who-reacted.${stage.id}.${suffix}`,
        );
      expect(() => c.whoReactedAssertion(stage.id, 'not-owned')).toThrow();
    }
    expect(() => c.whoReactedAssertion('not-a-stage', 'room-open')).toThrow();
  });

  it('keeps receipts out of the parity namespace', async () => {
    const c = await loadContract();
    for (const name of ['reaction-gate-1', 'arranged'])
      expect(() => c.assertWhoReactedReceiptName(name)).not.toThrow();
    for (const name of [
      'thumbs-count',
      'light-mode',
      'Room-Open',
      'a/b',
      '',
      '1abc',
    ])
      expect(() => c.assertWhoReactedReceiptName(name)).toThrow();
    for (const stage of c.WHO_REACTED_STAGES)
      for (const suffix of STAGE_SUFFIXES(stage))
        expect(() => c.assertWhoReactedReceiptName(suffix)).toThrow();
  });
});
