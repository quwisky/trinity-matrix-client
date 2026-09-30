import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { withMutantModule } from './support/mutant-module.mjs';
import { describe, expect, it, vi } from 'vitest';
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
/** The canonical bytes: the dd0cb53c blob. */
const SOURCE_SHA256 =
  'dce976ac883e07e14850bfee43cf50050b1b1f334174ba742ca530e2b0dc9b8a';
/** The working tree after the #759 retirement: the desktop-only general definition and the Pixel 5 one. */
const WORKING_TREE_SHA256 =
  'be60fe7cb441be52354c429c841003154efeb72b43c0156f59b6491e52966d1f';
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
  it('pins the dd0cb53c blob, the retired working tree and four shared sources', () => {
    expect(RETIRED_PREDECESSOR_COMMIT.startsWith('dd0cb53c')).toBe(true);
    expect(sha256(blob())).toBe(SOURCE_SHA256);
    expect(sha256(read(PREDECESSOR))).toBe(WORKING_TREE_SHA256);
    expect(read(PREDECESSOR) === blob()).toBe(false);
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
    expect(sha256(flippedTree)).not.toBe(WORKING_TREE_SHA256);
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

/* -------------------------------------------------------------------------- */
/* Texts, plan and asserters                                                  */
/* -------------------------------------------------------------------------- */

const loadObserver = () => import('../e2e/android/who-reacted-observer.mts');

describe('Android who-reacted texts, plan and asserters', () => {
  const READER = '@reader:localhost';
  const OTHERS = Array.from({ length: 16 }, (_, i) => `@o${i + 1}:localhost`);
  const TARGET = '$target';

  const arrangement = (
    c,
    { others = OTHERS, extra = [], mutate = (e) => e } = {},
  ) => {
    const member = (id, extraContent = {}) => ({
      type: 'm.room.member',
      state_key: id,
      sender: id,
      content: { membership: 'join', ...extraContent },
    });
    const events = [
      { type: 'm.room.create', content: {} },
      member(READER),
      { type: 'm.room.power_levels', content: {} },
      { type: 'm.room.join_rules', content: { join_rule: 'public' } },
      { type: 'm.room.history_visibility', content: {} },
      { type: 'm.room.name', content: { name: c.roomNameOf('R') } },
      ...others.map((id, i) =>
        member(id, i === 0 ? { displayname: c.longReactorNameOf('R') } : {}),
      ),
      {
        type: 'm.room.message',
        event_id: TARGET,
        sender: READER,
        content: { msgtype: 'm.text', body: c.bodyOf('R') },
      },
      ...extra,
    ];
    return mutate(events);
  };
  const expectation = {
    readerId: READER,
    otherIds: OTHERS,
    targetId: TARGET,
    runId: 'R',
  };

  const reactions = (c) => {
    const plan = c.reactionPlan('R');
    const ids = plan.map((p) => `$re${p.n}`);
    const events = plan.map((p, i) => ({
      type: 'm.reaction',
      event_id: ids[i],
      sender: p.sender === 0 ? READER : OTHERS[p.sender - 1],
      content: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: TARGET,
          key: p.key,
        },
      },
    }));
    return {
      plan,
      ids,
      events,
      e: { plan, ids, readerId: READER, otherIds: OTHERS, targetId: TARGET },
    };
  };

  it('types exactly the predecessor texts and profiles', async () => {
    const c = await loadContract();
    expect(c.GENERAL_TOUCH_PROFILE).toEqual({
      width: 1280,
      height: 720,
      isMobile: false,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    expect(c.MOBILE_SHEET_PROFILE).toEqual({
      width: 393,
      height: 851,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    expect(c.WHO_REACTED_PROFILES).toEqual({
      'pill-dialog': c.GENERAL_TOUCH_PROFILE,
      'mobile-sheet': c.MOBILE_SHEET_PROFILE,
    });
    expect(c.RUN_TAGS).toEqual({
      'pill-dialog': { role: 'run', suffix: 'w' },
      'mobile-sheet': { role: 'mobile', suffix: 'm' },
    });
    expect([c.roomNameOf('R'), c.bodyOf('R'), c.targetTxnOf('R')]).toEqual([
      'Who reacted R',
      'react to me R',
      'who-R',
    ]);
    expect(c.longReactorNameOf('R')).toBe(`who-other-R-${'x'.repeat(36)}`);
    expect([
      c.readerRole('pill-dialog'),
      c.otherRole('mobile-sheet', 7),
    ]).toEqual(['pd-reader', 'ms-other-07']);
    expect(c.REACTION_KEYS).toEqual([
      '❤️',
      '😂',
      '😮',
      '😢',
      '😡',
      '🚀',
      '✅',
      '❌',
      '👏',
      '🙌',
      '🔥',
      '💯',
      '🎯',
      '✨',
      '💡',
      '🌈',
      '🍀',
      '🌟',
    ]);
    expect(c.REACTION_GROUP).toBe(8);
    expect(c.GATES).toEqual([
      { thumbs: 8, groups: 1 },
      { thumbs: 16, groups: 1 },
      { thumbs: 17, groups: 8 },
      { thumbs: 17, groups: 16 },
    ]);
  });

  it("plans the predecessor's 36 reactions exactly", async () => {
    const c = await loadContract();
    const plan = c.reactionPlan('R');
    expect(plan).toHaveLength(36);
    expect(plan[0]).toEqual({ n: 1, key: '👍', sender: 0, txn: 'r1-R' });
    for (let n = 2; n <= 17; n++)
      expect(plan[n - 1]).toEqual({
        n,
        key: '👍',
        sender: n - 1,
        txn: `r${n}-R`,
      });
    expect(plan[17]).toEqual({ n: 18, key: '🎉', sender: 1, txn: 'r10-R' });
    c.REACTION_KEYS.forEach((key, i) =>
      expect(plan[18 + i]).toEqual({
        n: 19 + i,
        key,
        sender: ((i + 1) % 16) + 1,
        txn: `group${i}-R`,
      }),
    );
    expect(plan.filter((p) => p.key === '👍')).toHaveLength(17);
    expect(new Set(plan.map((p) => p.key)).size).toBe(20);
    // The plan implements the predecessor's templates at the pinned lines.
    const pinFor = (n) => LINE_PINS[c.reactionVia(n)];
    expect(pinFor(1)).toContain('`r1-${runId}`');
    expect(pinFor(2)).toContain('`r${index + 2}-${runId}`');
    expect(pinFor(18)).toContain("'🎉', `r10-${runId}`");
    expect(LINE_PINS[176]).toContain("'👍'");
    expect(LINE_PINS[202]).toContain('(index + 1) % otherHeaders.length');
    expect(LINE_PINS[204]).toContain('`group${index}-${runId}`');
    expect(LINE_PINS[c.reactionVia(19)]).toBeUndefined(); // 201 is a multi-line call; 202/204 carry its arguments
    for (const p of plan) expect(typeof c.reactionVia(p.n)).toBe('number');
  });

  it('asserts the API login, Room, join and event send', async () => {
    const c = await loadContract();
    c.assertApiLogin({ userId: '@u:localhost', username: 'u' });
    expect(() =>
      c.assertApiLogin({ userId: '@v:localhost', username: 'u' }),
    ).toThrow(/API login returned the exact user/);
    c.assertRoomCreated('!r:localhost');
    expect(() => c.assertRoomCreated('r')).toThrow(/Room id/);
    c.assertJoined({ status: 200, attempts: 2, retryAfterMs: [440] });
    for (const bad of [
      { status: 403, attempts: 2, retryAfterMs: [440] },
      { status: 200, attempts: 6, retryAfterMs: [1, 1, 1, 1, 1] },
      { status: 200, attempts: 2, retryAfterMs: [] },
    ])
      expect(() => c.assertJoined(bad)).toThrow(/joined within five attempts/);
    c.assertEventSent('$e');
    expect(() => c.assertEventSent('e')).toThrow(/event id/);
  });

  it('asserts the arrangement and fails each fault', async () => {
    const c = await loadContract();
    c.assertArrangement(arrangement(c), expectation);
    const cases = [
      [/17 joined members/, arrangement(c, { others: OTHERS.slice(0, 15) })],
      [
        /exactly the target/,
        arrangement(c, {
          extra: [
            {
              type: 'm.room.message',
              event_id: '$two',
              sender: READER,
              content: { body: 'x' },
            },
          ],
        }),
      ],
      [
        /the reader sent the target/i,
        arrangement(c, {
          mutate: (e) =>
            e.map((x) =>
              x.type === 'm.room.message' ? { ...x, sender: OTHERS[0] } : x,
            ),
        }),
      ],
      [
        /public/,
        arrangement(c, {
          mutate: (e) =>
            e.map((x) =>
              x.type === 'm.room.join_rules'
                ? { ...x, content: { join_rule: 'invite' } }
                : x,
            ),
        }),
      ],
      [
        /long reactor's display name/,
        arrangement(c, {
          mutate: (e) =>
            e.map((x) =>
              x.state_key === OTHERS[0]
                ? { ...x, content: { membership: 'join' } }
                : x,
            ),
        }),
      ],
      [
        /m\.room\.create/,
        arrangement(c, {
          mutate: (e) => e.filter((x) => x.type !== 'm.room.create'),
        }),
      ],
    ];
    for (const [message, events] of cases)
      expect(() => c.assertArrangement(events, expectation)).toThrow(message);
  });

  it('asserts the 36 reactions and fails each fault', async () => {
    const c = await loadContract();
    const good = reactions(c);
    expect(c.assertReactionsArranged(good.events, good.e)).toEqual({
      reactions: 36,
      thumbs: 17,
      keys: 20,
      readerIncluded: true,
    });
    const fail = (message, events, e = good.e) =>
      expect(() => c.assertReactionsArranged(events, e)).toThrow(message);
    fail(/exactly 36/i, good.events.slice(1));
    fail(
      /annotates the target/,
      good.events.map((x, i) =>
        i === 3
          ? {
              ...x,
              content: {
                'm.relates_to': {
                  rel_type: 'm.annotation',
                  event_id: '$other',
                  key: '👍',
                },
              },
            }
          : x,
      ),
    );
    fail(
      /17 distinct/,
      good.events.map((x, i) => (i === 3 ? { ...x, sender: OTHERS[0] } : x)),
    );
    const merge = good.events.map((x) =>
      x.content['m.relates_to'].key === '🌟'
        ? {
            ...x,
            content: {
              'm.relates_to': {
                rel_type: 'm.annotation',
                event_id: TARGET,
                key: '🌈',
              },
            },
          }
        : x,
    );
    fail(/20 keys/, merge);
    fail(
      /planned sender/,
      good.events.map((x) =>
        x.content['m.relates_to'].key === '🚀'
          ? { ...x, sender: OTHERS[15] }
          : x,
      ),
    );
    fail(
      /recorded ids/,
      good.events.map((x, i) =>
        i === 0 ? { ...x, event_id: '$stranger' } : x,
      ),
    );
    fail(
      /unredacted/,
      good.events.map((x, i) =>
        i === 5 ? { ...x, unsigned: { redacted_because: {} } } : x,
      ),
    );
  });

  const row = (over = {}) => ({
    rows: 1,
    exactEvent: true,
    pills: 1,
    thumbsPills: 1,
    thumbsCount: '8',
    summaryMatches: true,
    ...over,
  });
  it('asserts rows, gates, counts and summary', async () => {
    const c = await loadContract();
    c.assertGate(row(), c.GATES[0]);
    for (const bad of [row({ rows: 0 }), row({ exactEvent: false })])
      expect(() => c.assertGate(bad, c.GATES[0])).toThrow(
        /target row is still rendered/,
      );
    expect(() => c.assertGate(row({ thumbsCount: '7' }), c.GATES[0])).toThrow(
      /cumulative 👍/,
    );
    expect(() => c.assertGate(row({ pills: 2 }), c.GATES[0])).toThrow(
      /cumulative groups/,
    );
    c.assertTargetRow(row());
    for (const bad of [
      row({ rows: 0 }),
      row({ rows: 2 }),
      row({ exactEvent: false }),
    ])
      expect(() => c.assertTargetRow(bad)).toThrow(
        /Exactly one reconciled target row/,
      );
    c.assertThumbsCount(row({ thumbsCount: '17' }));
    expect(() => c.assertThumbsCount(row({ thumbsCount: '16' }))).toThrow(/17/);
    c.assertGroupCount(row({ pills: 20 }));
    expect(() => c.assertGroupCount(row({ pills: 19 }))).toThrow(
      /20 reaction groups/,
    );
    c.assertThumbsSummary(row());
    for (const bad of [
      row({ summaryMatches: false }),
      row({ thumbsPills: 0, summaryMatches: false }),
    ])
      expect(() => c.assertThumbsSummary(bad)).toThrow(/reacted by You/);
    c.assertComposerVisible({ composers: 1, composerVisible: true });
    expect(() =>
      c.assertComposerVisible({ composers: 1, composerVisible: false }),
    ).toThrow();
    expect(() =>
      c.assertComposerVisible({ composers: 0, composerVisible: false }),
    ).toThrow();
  });

  const dialog = (over = {}) => ({
    dialogs: 1,
    sheetHost: true,
    box: { left: 0, right: 393.14, top: 300, bottom: 851.05 },
    innerWidth: 393,
    innerHeight: 851,
    total: '36 total',
    closeVisible: true,
    keys: 20,
    pressedKeys: ['❤️'],
    lastKey: { key: '🌟', pressed: true, unobstructed: true },
    reactors: 1,
    listContainsLong: true,
    longName: { found: true, textOverflow: 'ellipsis', overflow: 44 },
    detailOverflow: 350,
    directory: {
      scrollWidth: 1121,
      clientWidth: 393,
      scrollLeft: 728,
      rect: { x: 0, y: 0, width: 393, height: 50 },
    },
    ...over,
  });
  it('asserts the dialog and sheet observations and fails each fault', async () => {
    const c = await loadContract();
    const ok = (name, ...args) => expect(() => c[name](...args)).not.toThrow();
    const bad = (name, message, ...args) =>
      message
        ? expect(() => c[name](...args)).toThrow(message)
        : expect(() => c[name](...args)).toThrow();
    ok('assertDialogVisible', dialog());
    for (const dialogs of [0, 2])
      bad(
        'assertDialogVisible',
        /one visible Reactions dialog/,
        dialog({ dialogs }),
      );
    ok('assertDialogTotal', dialog());
    bad('assertDialogTotal', /36 total/, dialog({ total: '35 total' }));
    ok('assertCloseVisible', dialog());
    bad('assertCloseVisible', null, dialog({ closeVisible: false }));
    ok('assertKeyCount', dialog());
    bad('assertKeyCount', null, dialog({ keys: 19 }));
    ok('assertLongReactorListed', dialog());
    bad('assertLongReactorListed', null, dialog({ listContainsLong: false }));
    for (const n of [1, 17]) {
      ok('assertReactors', dialog({ reactors: n }), n);
      for (const off of [-1, 1])
        bad('assertReactors', null, dialog({ reactors: n + off }), n);
    }
    ok('assertLongReactorEllipsis', dialog());
    bad(
      'assertLongReactorEllipsis',
      null,
      dialog({
        longName: { found: false, textOverflow: null, overflow: null },
      }),
    );
    bad(
      'assertLongReactorEllipsis',
      /ellipsis/,
      dialog({ longName: { found: true, textOverflow: 'clip', overflow: 44 } }),
    );
    ok('assertLongReactorOverflow', dialog());
    bad(
      'assertLongReactorOverflow',
      /actually overflows/,
      dialog({
        longName: { found: true, textOverflow: 'ellipsis', overflow: 0 },
      }),
    );
    ok('assertDetailOverflow', dialog());
    bad('assertDetailOverflow', null, dialog({ detailOverflow: 0 }));
    ok('assertKeyPressed', dialog({ pressedKeys: ['❤️'] }), '❤️');
    for (const pressedKeys of [['👍'], [], ['❤️', '👍']])
      bad('assertKeyPressed', /pressed/, dialog({ pressedKeys }), '❤️');
    ok('assertDialogDismissed', dialog({ dialogs: 0 }));
    bad('assertDialogDismissed', /dismissed/, dialog({ dialogs: 1 }));
    ok('assertSheetClass', dialog());
    bad('assertSheetClass', null, dialog({ sheetHost: false }));
    ok('assertSheetLeft', dialog());
    bad(
      'assertSheetLeft',
      null,
      dialog({ box: { left: -1, right: 393, top: 0, bottom: 851 } }),
    );
    ok('assertSheetRight', dialog());
    bad(
      'assertSheetRight',
      null,
      dialog({ box: { left: 0, right: 395, top: 0, bottom: 851 } }),
    );
    ok('assertSheetBottom', dialog());
    for (const bottom of [850.5, 851.5])
      bad(
        'assertSheetBottom',
        /bottom-attached/,
        dialog({ box: { left: 0, right: 393, top: 0, bottom } }),
      );
    ok('assertDirectoryOverflow', dialog());
    bad(
      'assertDirectoryOverflow',
      null,
      dialog({
        directory: {
          scrollWidth: 393,
          clientWidth: 393,
          scrollLeft: 0,
          rect: {},
        },
      }),
    );
    ok('assertLastKeyPressed', dialog());
    bad(
      'assertLastKeyPressed',
      null,
      dialog({ lastKey: { key: '🌟', pressed: false, unobstructed: true } }),
    );
    ok('assertDirectoryScrolled', dialog());
    bad(
      'assertDirectoryScrolled',
      null,
      dialog({
        directory: {
          scrollWidth: 1121,
          clientWidth: 393,
          scrollLeft: 0,
          rect: {},
        },
      }),
    );
  });

  const route = (over = {}) => ({
    path: '/rooms/x',
    account: '@u:localhost',
    settingsHosts: 0,
    sectionsVisible: false,
    dark: true,
    backToRoomsVisible: false,
    composers: 1,
    composerVisible: true,
    ...over,
  });
  it('asserts the shell route and mode and fails each fault', async () => {
    const c = await loadContract();
    c.assertRoomsRoute(route(), '@u:localhost');
    expect(() =>
      c.assertRoomsRoute(route({ path: '/settings' }), '@u:localhost'),
    ).toThrow(/Account-qualified Rooms route/);
    expect(() =>
      c.assertRoomsRoute(route({ account: '@v:localhost' }), '@u:localhost'),
    ).toThrow(/Account-qualified Rooms route/);
    c.assertSettingsSections(
      route({ path: '/settings', sectionsVisible: true }),
    );
    expect(() =>
      c.assertSettingsSections(
        route({ path: '/settings', sectionsVisible: false }),
      ),
    ).toThrow();
    c.assertMode(route({ dark: true }), 'dark');
    c.assertMode(route({ dark: false }), 'light');
    expect(() => c.assertMode(route({ dark: true }), 'light')).toThrow();
    expect(() => c.assertMode(route({ dark: false }), 'dark')).toThrow();
    for (const path of ['/settings', '/rooms/x'])
      c.assertSectionUnwound(route({ path }));
    expect(() =>
      c.assertSectionUnwound(route({ path: '/settings/appearance' })),
    ).toThrow();
    c.assertSettingsDetached(route());
    expect(() =>
      c.assertSettingsDetached(route({ settingsHosts: 1 })),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only observer (jsdom)                                                 */
/* -------------------------------------------------------------------------- */

describe('Android who-reacted read-only observer (jsdom)', () => {
  const LONG = `who-other-R-${'x'.repeat(36)}`;
  const BOXES = {
    dialog: [0, 300, 393, 551],
    directory: [0, 320, 393, 50],
    close: [340, 310, 40, 40],
    lastkey: [300, 330, 60, 30],
    composer: [0, 700, 393, 40],
    who: [10, 100, 60, 20],
    back: [0, 0, 0, 0],
    sections: [0, 0, 200, 300],
  };
  const rect = ([x, y, width, height]) => ({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  });

  const rowHtml = `
    <div class="scroll"><div class="msg" data-mid="$target">react to me R
      <span class="reaction" aria-label="👍 reacted by You, a, b and 14 others"><span class="reaction__key">👍</span><span class="reaction__count">17</span></span>
      <span class="reaction"><span class="reaction__key">🎉</span><span class="reaction__count">1</span></span>
      <span class="reaction"><span class="reaction__key">❤️</span><span class="reaction__count">1</span></span>
      <span class="reaction reaction--who"><span class="reaction__key">5</span></span>
      <button class="reaction reaction--who" data-testid="reactions-who" data-box="who"></button>
    </div></div>
    <textarea data-testid="composer-input" data-box="composer"></textarea>`;
  const names = Array.from(
    { length: 16 },
    (_, i) =>
      `<li class="reactor"><span class="reactor__name">n${i}</span></li>`,
  ).join('');
  const keys = ['❤️', '🎉', '🌟']
    .map(
      (k, i, all) =>
        `<button data-testid="reactions-key" aria-pressed="${i === 0}" aria-label="${k}, ${i + 1} reacted"${i === all.length - 1 ? ' data-box="lastkey"' : ''}></button>`,
    )
    .join('');
  const dialogHtml = (longText = LONG) => `
    <trn-reactions-dialog class="reactions-dialog--sheet"><div data-testid="reactions-dialog" data-box="dialog">
      <span class="reactions-dialog__total">36 total</span>
      <div data-testid="reactions-directory" data-box="directory">${keys}</div>
      <div class="reactions-dialog__detail"><ul data-testid="reactors-list">${names}<li class="reactor"><span class="reactor__name">${longText}</span></li></ul></div>
    </div></trn-reactions-dialog>
    <button data-testid="close-reactions" data-box="close"></button>
    <textarea data-testid="composer-input" data-box="composer"></textarea>`;
  const settingsHtml = `<trn-settings><nav aria-label="Settings sections" data-box="sections"></nav></trn-settings>`;

  function windowFor(
    html,
    { url = 'http://localhost/rooms/x', dark = false, guard = false } = {},
  ) {
    const dom = new JSDOM(
      `<!doctype html><html class="${dark ? 'dark' : ''}"><body><main>${html}</main></body></html>`,
      { url },
    );
    const { window } = dom;
    Object.defineProperty(window, 'innerWidth', {
      value: 393,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 851,
      configurable: true,
    });
    const proto = window.HTMLElement.prototype;
    proto.getBoundingClientRect = function () {
      const key = this.getAttribute('data-box');
      if (key && BOXES[key]) return rect(BOXES[key]);
      if (this.matches('.msg')) return rect([0, 90, 393, 200]);
      return rect([0, 0, 0, 0]);
    };
    Object.defineProperties(proto, {
      scrollWidth: {
        get() {
          return this.matches('[data-testid="reactions-directory"]')
            ? 1121
            : this.matches('.reactor__name')
              ? 200
              : 0;
        },
        configurable: true,
      },
      clientWidth: {
        get() {
          return this.matches('[data-testid="reactions-directory"]')
            ? 393
            : this.matches('.reactor__name')
              ? 156
              : 0;
        },
        configurable: true,
      },
      scrollHeight: {
        get() {
          return this.matches('.reactions-dialog__detail') ? 500 : 0;
        },
        configurable: true,
      },
      clientHeight: {
        get() {
          return this.matches('.reactions-dialog__detail') ? 150 : 0;
        },
        configurable: true,
      },
    });
    window.getComputedStyle = (element) => ({
      visibility: 'visible',
      display: 'block',
      backgroundColor: 'rgb(0, 0, 0)',
      textOverflow: element.matches('.reactor__name') ? 'ellipsis' : 'clip',
    });
    window.document.elementFromPoint = (x, y) =>
      [
        ...window.document.querySelectorAll(
          '[data-box="who"], [data-box="lastkey"]',
        ),
      ].find((element) => {
        const b = element.getBoundingClientRect();
        return (
          x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
        );
      }) ?? null;
    if (guard) {
      const boom = (name) => () => {
        throw new Error(`write: ${name}`);
      };
      for (const name of [
        'click',
        'focus',
        'scrollTo',
        'scrollBy',
        'scrollIntoView',
      ])
        proto[name] = boom(name);
      window.Element.prototype.scrollTo = boom('scrollTo');
      window.Element.prototype.scrollBy = boom('scrollBy');
      window.Element.prototype.scrollIntoView = boom('scrollIntoView');
      window.Element.prototype.dispatchEvent = boom('dispatchEvent');
      window.EventTarget.prototype.dispatchEvent = boom('dispatchEvent');
      for (const name of ['scrollLeft', 'scrollTop'])
        Object.defineProperty(window.Element.prototype, name, {
          get: () => 0,
          set: boom(name),
          configurable: true,
        });
      const tokens = window.DOMTokenList.prototype;
      for (const name of ['add', 'remove', 'toggle', 'replace'])
        tokens[name] = boom(`classList.${name}`);
      Object.defineProperty(window.Node.prototype, 'textContent', {
        get: Object.getOwnPropertyDescriptor(
          window.Node.prototype,
          'textContent',
        )?.get,
        set: boom('textContent'),
        configurable: true,
      });
    }
    return window;
  }
  const run = (window, expression) =>
    JSON.parse(
      JSON.stringify(
        runInNewContext(expression, {
          document: window.document,
          URL: window.URL,
        }),
      ),
    );

  it('observes the reaction row', async () => {
    const o = await loadObserver();
    const window = windowFor(rowHtml);
    expect(
      run(window, o.reactionRowExpression('react to me R', '$target')),
    ).toEqual({
      rows: 1,
      exactEvent: true,
      pills: 3,
      thumbsPills: 1,
      thumbsCount: '17',
      summaryMatches: true,
      summaryOthers: 14,
      who: 1,
      whoUnobstructed: true,
      composers: 1,
      composerVisible: true,
    });
    expect(
      run(window, o.reactionRowExpression('react to me R', '$other'))
        .exactEvent,
    ).toBe(false);
  });

  it('observes the dialog and ignores a name that only contains a prefix', async () => {
    const o = await loadObserver();
    const seen = run(windowFor(dialogHtml()), o.reactionDialogExpression(LONG));
    expect(seen).toMatchObject({
      dialogs: 1,
      sheetHost: true,
      box: { left: 0, right: 393, top: 300, bottom: 851 },
      innerWidth: 393,
      innerHeight: 851,
      total: '36 total',
      closeVisible: true,
      keys: 3,
      pressedKeys: ['❤️'],
      lastKey: { key: '🌟', pressed: false, unobstructed: true },
      reactors: 17,
      listContainsLong: true,
      longName: { found: true, textOverflow: 'ellipsis', overflow: 44 },
      detailOverflow: 350,
      directory: {
        scrollWidth: 1121,
        clientWidth: 393,
        scrollLeft: 0,
        rect: { x: 0, y: 320, width: 393, height: 50 },
      },
      background: 'rgb(0, 0, 0)',
      composers: 1,
      composerVisible: true,
    });
    const prefix = run(
      windowFor(dialogHtml(LONG.slice(0, 20))),
      o.reactionDialogExpression(LONG),
    );
    expect(prefix.longName).toEqual({
      found: false,
      textOverflow: null,
      overflow: null,
    });
    expect(prefix.listContainsLong).toBe(false);
    // A longer name that merely contains the arranged one is not the long reactor either.
    const longer = run(
      windowFor(dialogHtml(`${LONG}y`)),
      o.reactionDialogExpression(LONG),
    );
    expect(longer.longName.found).toBe(false);
  });

  it('observes the Settings route', async () => {
    const o = await loadObserver();
    const window = windowFor(settingsHtml, {
      url: 'http://localhost/settings/appearance',
      dark: true,
    });
    expect(run(window, o.shellRouteExpression())).toEqual({
      path: '/settings/appearance',
      account: null,
      settingsHosts: 1,
      sectionsVisible: true,
      dark: true,
      backToRoomsVisible: false,
      composers: 0,
      composerVisible: false,
    });
  });

  it('writes nothing: each expression succeeds against a document whose writers throw', async () => {
    const o = await loadObserver();
    run(
      windowFor(rowHtml, { guard: true }),
      o.reactionRowExpression('react to me R', '$target'),
    );
    run(
      windowFor(dialogHtml(), { guard: true }),
      o.reactionDialogExpression(LONG),
    );
    run(
      windowFor(settingsHtml, {
        guard: true,
        url: 'http://localhost/settings',
      }),
      o.shellRouteExpression(),
    );
    // The proof is effective: a write appended to an expression throws.
    for (const write of [
      'document.querySelector("textarea").focus()',
      'document.querySelector("textarea").click()',
      'document.body.classList.add("x")',
      'document.body.textContent = "x"',
    ])
      expect(() =>
        run(windowFor(rowHtml, { guard: true }), `(() => { ${write}; })()`),
      ).toThrow(/write:/);
  });

  it('carries no banned token', () => {
    const source = read('e2e/android/who-reacted-observer.mts');
    const banned = [
      '.click(',
      '.tap(',
      '.focus(',
      'dispatchEvent',
      '.value =',
      'textContent =',
      '.style.',
      'classList.add',
      'classList.remove',
      'classList.toggle',
      'scrollLeft =',
      'scrollTop =',
      'scrollTo(',
      'scrollBy(',
      'scrollIntoView(',
      'setViewportSize',
      '.resize(',
      '.fill(',
      '.press(',
      'localStorage',
      'Preferences.set',
      'requestSubmit',
      '.submit(',
      'preventDefault',
      'stopPropagation',
      'select(',
      'showReactors',
      'toggleReaction',
      'open$(',
      'new SharedStageAccount(',
      'input_method',
      'dumpsys',
    ];
    for (const token of banned) expect(source, token).not.toContain(token);
    expect(source).not.toMatch(/(?<![.\w])(location|history)\./u);
  });
});

/* -------------------------------------------------------------------------- */
/* Artifacts and diagnostics safety                                           */
/* -------------------------------------------------------------------------- */

const ARTIFACTS_PATH = 'e2e/android/who-reacted-artifacts.mts';
const loadArtifacts = () => import('../e2e/android/who-reacted-artifacts.mts');
async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

describe('Android who-reacted diagnostics safety', () => {
  const RUN = 'R';
  const two = (n) => String(n).padStart(2, '0');
  const READER = {
    userId: '@who-reader-R:localhost',
    username: 'who-reader-R',
    password: 'pw-reader-R',
  };
  const OTHERS = Array.from({ length: 16 }, (_, i) => ({
    userId: `@who-other-R-${two(i + 1)}:localhost`,
    username: `who-other-R-${two(i + 1)}`,
    password: `pw-other-R-${two(i + 1)}`,
  }));
  const ROOM = { id: '!who:localhost', name: 'Who reacted R' };
  const TXNS = [
    'who-R',
    ...Array.from({ length: 17 }, (_, i) => `r${i + 1}-R`),
    ...Array.from({ length: 18 }, (_, i) => `group${i}-R`),
  ];
  const EVENTS = [
    '$target',
    ...Array.from({ length: 36 }, (_, i) => `$r${two(i + 1)}`),
  ];
  const stageIds = (c) => ({
    accounts: [READER, ...OTHERS],
    rooms: [ROOM],
    texts: ['react to me R', c.longReactorNameOf(RUN)],
    transactions: TXNS,
    eventIds: EVENTS,
  });
  const secretsOf = async (stage = 'pill-dialog') => {
    const c = await loadContract();
    const { whoReactedSecrets } = await loadArtifacts();
    return whoReactedSecrets(stage, stageIds(c));
  };

  it('registers 17 accounts, the Room, texts, 36 transactions and 37 event ids in every form', async () => {
    const c = await loadContract();
    const secrets = await secretsOf('mobile-sheet');
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_WHO_REACTED_MOBILE_SHEET_'),
      ),
    ).toBe(true);
    expect(new Set(TXNS).size).toBe(36);
    expect(EVENTS).toHaveLength(37);
    const values = new Set(Object.values(secrets));
    for (const account of [READER, ...OTHERS])
      for (const value of [
        account.userId,
        encodeURIComponent(account.userId),
        account.username,
        account.password,
      ])
        expect(values.has(value), value).toBe(true);
    for (const value of [
      ROOM.id,
      ROOM.id.slice(1),
      encodeURIComponent(ROOM.id),
      Buffer.from(ROOM.id).toString('base64url'),
      ROOM.name,
      'react to me R',
      c.longReactorNameOf(RUN),
      ...TXNS,
      ...EVENTS,
    ])
      expect(values.has(value), value).toBe(true);
  });

  it('registers no emoji key, thumbs-up, party popper or bare server name', async () => {
    const c = await loadContract();
    const values = new Set(Object.values(await secretsOf()));
    for (const key of [...c.REACTION_KEYS, '👍', '🎉'])
      expect(values.has(key), key).toBe(false);
    expect(values.has('localhost')).toBe(false);
    const { whoReactedSecrets } = await loadArtifacts();
    expect(() => whoReactedSecrets('not-a-stage', stageIds(c))).toThrow();
  });

  it('rejects every identifier form and token in both stage directories', async () => {
    const c = await loadContract();
    const secrets = await secretsOf();
    const { scanPinnedPanelArtifacts } =
      await import('../e2e/android/pinned-message-panel-artifacts.mts');
    const fixtureTokens = Array.from(
      { length: 17 },
      (_, n) => `syt_fixtureToken_${n}`,
    );
    const unsafeValues = [
      'react to me R',
      c.longReactorNameOf(RUN),
      ROOM.name,
      READER.username,
      OTHERS[15].username,
      READER.userId,
      OTHERS[0].userId,
      ROOM.id,
      ROOM.id.slice(1),
      encodeURIComponent(ROOM.id),
      Buffer.from(ROOM.id).toString('base64url'),
      '$r17',
      'r10-R',
      'group17-R',
      READER.password,
      OTHERS[3].password,
      ...fixtureTokens,
      'syt_deviceToken_x',
    ];
    expect(new Set(fixtureTokens).size).toBe(17);
    await withOutput('trinity-who-scan-', async (output) => {
      for (const stage of ['pill-dialog', 'mobile-sheet']) {
        await mkdir(join(output, stage));
        const capture = join(output, stage, 'receipt-01-x.json');
        for (const unsafe of unsafeValues) {
          await writeFile(capture, `x=${unsafe}`);
          await expect(
            scanPinnedPanelArtifacts(output, secrets),
            `${stage}: ${unsafe}`,
          ).rejects.toThrow();
        }
        await writeFile(capture, '{"ok":true}\n');
      }
      await expect(
        scanPinnedPanelArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  const flags = {
    unsafeSecrets: false,
    cleanupFailed: false,
    scrubFailed: false,
  };
  const CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'];
  /** A complete two-stage passing run, as the runner reports it. */
  const reportOf = (c) => ({
    status: 'passed',
    expectedStages: 2,
    expectedAssertionRecords: 191,
    attempt: 1,
    retries: 0,
    stages: c.WHO_REACTED_STAGES.map((entry) => ({
      id: entry.id,
      status: 'passed',
      attempt: 1,
      retries: 0,
      expectedAssertionRecords: entry.expectedAssertionRecords,
      assertionRecords: entry.assertions.length,
      assertions: [...entry.assertions],
      failureCount: 0,
    })),
  });

  /** Each case arranges the output, report, flags or secrets to be unsafe in one way. */
  const casesOf = (c) => {
    const { GENERAL_TOUCH_PROFILE: GENERAL, MOBILE_SHEET_PROFILE: MOBILE } = c;
    const swap = (stage, a, b) => (report) => {
      const list = report.stages[stage].assertions;
      [list[a], list[b]] = [list[b], list[a]];
    };
    const truncate = (stage, records) => (report) => {
      report.stages[stage].assertions.pop();
      report.stages[stage].assertionRecords = records;
    };
    return {
      'one stage': { report: (r) => r.stages.pop() },
      'three stages': {
        report: (r) => r.stages.push(structuredClone(r.stages[0])),
      },
      'expectedStages 1': { report: (r) => (r.expectedStages = 1) },
      'expectedAssertionRecords 190': {
        report: (r) => (r.expectedAssertionRecords = 190),
      },
      'attempt 2': { report: (r) => (r.attempt = 2) },
      'retries 1': { report: (r) => (r.retries = 1) },
      '87 records in pill-dialog': { report: truncate(0, 87) },
      '102 records in mobile-sheet': { report: truncate(1, 102) },
      'assertionRecords count alone': {
        report: (r) => (r.stages[0].assertionRecords = 87),
      },
      'stage expected records alone': {
        report: (r) => (r.stages[1].expectedAssertionRecords = 102),
      },
      'two records swapped': { report: swap(1, 5, 6) },
      'journeys.json differs from the run': { differentJourneys: true },
      'provenance with the mobile profile': { provenance: MOBILE },
      'general profile in mobile-sheet': {
        applied: { 'mobile-sheet': GENERAL },
      },
      'mobile profile in pill-dialog': { applied: { 'pill-dialog': MOBILE } },
      'missing capture': { missing: join('mobile-sheet', 'passed-ui.json') },
      cleanupFailed: { flags: { cleanupFailed: true } },
      scrubFailed: { flags: { scrubFailed: true } },
      unsafeSecrets: { flags: { unsafeSecrets: true } },
      'raster under a stage': { png: true },
      'unscrubbed identifier': { leak: true },
    };
  };

  /** Arrange a passing output, apply one case, and return a call against `module`. */
  async function attempt(c, output, module, spec = {}) {
    const write = (path, value) =>
      writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
    const report = reportOf(c);
    spec.report?.(report);
    const profile = spec.provenance ?? c.GENERAL_TOUCH_PROFILE;
    await write(
      'journeys.json',
      spec.differentJourneys ? { other: true } : report,
    );
    await write('runtime-provenance.json', {
      schemaVersion: 1,
      profile: { requested: profile, digest: sha256(JSON.stringify(profile)) },
    });
    for (const entry of c.WHO_REACTED_STAGES) {
      await mkdir(join(output, entry.id), { recursive: true });
      await write(join(entry.id, 'profile-applied.json'), {
        requested: spec.applied?.[entry.id] ?? c.WHO_REACTED_PROFILES[entry.id],
      });
      for (const name of CAPTURES)
        await write(join(entry.id, name), { ok: true });
    }
    if (spec.missing) await rm(join(output, spec.missing));
    if (spec.png)
      await writeFile(
        join(output, 'mobile-sheet', 'failed.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    if (spec.leak)
      await writeFile(
        join(output, 'pill-dialog', 'passed-surface.json'),
        'token=$r17',
      );
    const marker = join(output, 'publication-safe');
    await writeFile(marker, 'stale\n');
    return {
      marker,
      call: async () =>
        module.markWhoReactedDiagnosticsSafe(
          output,
          spec.leak ? await secretsOf() : {},
          { ...flags, ...spec.flags },
          undefined,
          report,
        ),
    };
  }

  it('withholds publication-safe from every unsafe run and writes it for a complete report', async () => {
    const c = await loadContract();
    const artifacts = await loadArtifacts();
    await withOutput('trinity-who-gate-', async (output) => {
      const good = await attempt(c, output, artifacts);
      await good.call();
      expect(await readFile(good.marker, 'utf8')).toBe('scanned\n');
      for (const [name, spec] of Object.entries(casesOf(c))) {
        const unsafe = await attempt(c, output, artifacts, spec);
        await expect(unsafe.call(), name).rejects.toThrow();
        expect(existsSync(unsafe.marker), name).toBe(false);
      }
    });
  });

  // Every refusal term of the marker: deleting it in memory lets the same case through.
  const TERMS = [
    ['unsafeSecrets', '!flags.unsafeSecrets && ', '', ['unsafeSecrets']],
    ['cleanupFailed', '!flags.cleanupFailed && ', '', ['cleanupFailed']],
    ['scrubFailed', ' && !flags.scrubFailed', '', ['scrubFailed']],
    [
      'expectedStages',
      "report['expectedStages'] === WHO_REACTED_STAGES.length &&",
      'true &&',
      ['expectedStages 1'],
    ],
    [
      'expectedAssertionRecords',
      "report['expectedAssertionRecords'] === WHO_REACTED_ASSERTION_RECORDS &&",
      'true &&',
      ['expectedAssertionRecords 190'],
    ],
    ['attempt', "report['attempt'] === 1 && ", '', ['attempt 2']],
    ['retries', "report['retries'] === 0", 'true', ['retries 1']],
    [
      'stage count',
      "report['stages'].length === WHO_REACTED_STAGES.length",
      'true',
      ['three stages'],
    ],
    [
      'stage expected records',
      "stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&",
      'true &&',
      ['stage expected records alone'],
    ],
    [
      'stage record count',
      "stage['assertionRecords'] === entry.assertions.length &&",
      'true &&',
      ['assertionRecords count alone'],
    ],
    [
      'stage assertion order',
      "assert.deepEqual(stage['assertions'], [...entry.assertions],",
      'assert.deepEqual([], [],',
      ['two records swapped'],
    ],
    // A truncated stage is refused by its count and by its list: both terms go together.
    [
      'stage count and list',
      [
        "stage['assertionRecords'] === entry.assertions.length &&",
        "assert.deepEqual(stage['assertions'], [...entry.assertions],",
      ],
      ['true &&', 'assert.deepEqual([], [],'],
      ['87 records in pill-dialog', '102 records in mobile-sheet'],
    ],
    [
      'persisted report',
      "assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,",
      'assert.deepEqual(current, current,',
      ['journeys.json differs from the run'],
    ],
    [
      'provenance profile',
      'assert.deepEqual(installed, {',
      'assert.deepEqual(installed, installed, {',
      ['provenance with the mobile profile'],
    ],
    [
      'applied profile',
      "assert.deepEqual(applied['requested'], WHO_REACTED_PROFILES[entry.id],",
      "assert.deepEqual(applied['requested'], applied['requested'],",
      ['general profile in mobile-sheet', 'mobile profile in pill-dialog'],
    ],
    [
      'required captures',
      'await requireTextFile(join(output, entry.id, name));',
      'void name;',
      ['missing capture'],
    ],
    [
      'scan (identifier and raster)',
      'await scanPinnedPanelArtifacts(output, secrets);',
      '',
      ['unscrubbed identifier', 'raster under a stage'],
    ],
  ];

  it('gives every marker refusal flag and the raster case a mutation term present once', () => {
    const names = TERMS.flatMap(([, , , cases]) => cases);
    for (const required of [
      'unsafeSecrets',
      'cleanupFailed',
      'scrubFailed',
      'raster under a stage',
    ])
      expect(names).toContain(required);
    const source = read(ARTIFACTS_PATH);
    for (const [name, from] of TERMS)
      for (const term of [from].flat())
        expect(
          source.split(term).length,
          `${name}: term is present exactly once`,
        ).toBe(2);
  });

  it('refuses a .png under the stage output', async () => {
    const c = await loadContract();
    const artifacts = await loadArtifacts();
    await withOutput('trinity-who-raster-', async (output) => {
      const unsafe = await attempt(c, output, artifacts, { png: true });
      await expect(unsafe.call()).rejects.toThrow();
      expect(existsSync(unsafe.marker)).toBe(false);
    });
  });

  for (const [index, [name, from, to, caseNames]] of TERMS.entries())
    it(`deleting the "${name}" term lets its unsafe case publish (in-memory mutation)`, async () => {
      const c = await loadContract();
      const artifacts = await loadArtifacts();
      const source = read(ARTIFACTS_PATH);
      const mutated = [from]
        .flat()
        .reduce((text, term, i) => text.replace(term, [to].flat()[i]), source);
      expect(mutated, `${name}: mutation applied`).not.toBe(source);
      const temp = resolve(
        root,
        `e2e/android/who-reacted-artifacts.mutant-${process.pid}-${index}.mts`,
      );
      try {
        await writeFile(temp, mutated);
        const mutant = await import(pathToFileURL(temp).href);
        const cases = casesOf(c);
        for (const caseName of caseNames)
          await withOutput('trinity-who-mut-', async (output) => {
            const real = await attempt(c, output, artifacts, cases[caseName]);
            await expect(
              real.call(),
              `${caseName}: real module refuses`,
            ).rejects.toThrow();
            const loose = await attempt(c, output, mutant, cases[caseName]);
            await loose.call();
            expect(
              await readFile(loose.marker, 'utf8'),
              `${caseName}: mutant publishes`,
            ).toBe('scanned\n');
          });
      } finally {
        await rm(temp, { force: true });
      }
    }, 30_000);

  it('revokes publication on abort with the exact message', async () => {
    const { revokeWhoReactedPublicationOnAbort } = await loadArtifacts();
    await withOutput('trinity-who-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [
          { status: 'passed', failureCount: 0 },
          { status: 'passed', failureCount: 0 },
        ],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeWhoReactedPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeWhoReactedPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before who-reacted publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('imports only the scan and its type from the pinned-panel module', () => {
    const source = read(ARTIFACTS_PATH);
    expect(source).toMatch(
      /import \{\s*scanPinnedPanelArtifacts,\s*type PinnedPanelPublicationSafety,\s*\} from '\.\/pinned-message-panel-artifacts\.mts';/u,
    );
    expect(source).toContain(
      'export type WhoReactedPublicationSafety = PinnedPanelPublicationSafety;',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Simulated installed app: the pill-dialog stage against production-shaped DOM */
/* -------------------------------------------------------------------------- */

const JOURNEYS = 'e2e/android/who-reacted-journeys.mts';
const CONTRACT_PATH = 'e2e/android/who-reacted-contract.mts';
const OBSERVER_PATH = 'e2e/android/who-reacted-observer.mts';
const loadJourneys = () => import('../e2e/android/who-reacted-journeys.mts');

const SIM_ROOM = '!Room-AbC:example.test';
const SIM_HOMESERVER = 'https://localhost:8448';
const SIM_RUN = 'simrun';
const SIM_STAGE = 'pill-dialog';
const SIM_ROOM_NAME = `Who reacted ${SIM_RUN}`;
const SIM_BODY = `react to me ${SIM_RUN}`;
const SIM_LONG = `who-other-${SIM_RUN}-${'x'.repeat(36)}`;
const SIM_TARGET = '$Tgt9z';
const SIM_ROUTE = `https://localhost/rooms/${Buffer.from(SIM_ROOM).toString('base64url')}?account=x&view=rooms`;
const SIM_WHO = '[data-testid="reactions-who"]';
const SIM_KEY = '[data-testid="reactions-key"]';
const SIM_BACK_FLOW = 'e2e/android/flows/native-shell-back.yaml';
const SIM_BOXES = {
  dialog: [0, 300, 393, 551],
  directory: [0, 320, 393, 50],
  close: [340, 310, 40, 40],
  who: [10, 100, 60, 20],
  composer: [0, 780, 393, 40],
  msg: [0, 90, 393, 200],
  btn: [10, 10, 40, 40],
  lastKey: [300, 320, 50, 50],
  zero: [0, 0, 0, 0],
};
const SIM_LIGHT_PAINT = 'oklch(0.965 0.008 265)';
const SIM_DARK_PAINT = 'oklch(0.24 0.016 265)';
const simEscape = (value) =>
  String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
const simPad = (n) => String(n).padStart(2, '0');
const simAccount = (role) => ({
  userId: `@${role}:localhost`,
  username: role,
  password: `pw-${role}`,
  homeserver: SIM_HOMESERVER,
});
const SIM_READER = simAccount('pd-reader');
const SIM_OTHERS = Array.from({ length: 16 }, (_, i) =>
  simAccount(`pd-other-${simPad(i + 1)}`),
);
const SIM_SENDERS = [SIM_READER, ...SIM_OTHERS];
const simNameOf = (sender, longMissing) =>
  sender === 0
    ? 'You'
    : sender === 1 && !longMissing
      ? SIM_LONG
      : `Other ${simPad(sender)}`;
/** Keys ordered 👍, 🎉, then first appearance (the dialog snapshot's order). */
const simKeyOrder = (rendered) => {
  const rank = (key) => (key === '👍' ? 0 : key === '🎉' ? 1 : 2);
  return [...new Set(rendered.map(({ key }) => key))]
    .map((key, index) => ({ key, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
    .map(({ key }) => key);
};

/**
 * A model of the installed app, its Synapse Room and native input. Every state
 * is a pure function of the fake clock and of the returns recorded when a
 * native call finished (#757/#758): a native call only enqueues its transition
 * and a later read applies it once `lag[label]` has elapsed since the call
 * returned. REST reactions reach the rendered state only as one sync batch on a
 * webview read; a batch above the limit resets the timeline (the target row is
 * gone and stays gone), Synapse's default incremental limit being 10.
 */
async function simulatedWhoReactedApp(faults = {}) {
  const c = await loadContract();
  const stage = faults.stage ?? 'pill-dialog';
  const mobile = stage === 'mobile-sheet';
  const prefix = mobile ? 'ms' : 'pd';
  const simReader = simAccount(`${prefix}-reader`);
  const simOthers = Array.from({ length: 16 }, (_, i) =>
    simAccount(`${prefix}-other-${simPad(i + 1)}`),
  );
  const simSenders = [simReader, ...simOthers];
  const output = mobile
    ? await mkdtemp(join(tmpdir(), 'who-reacted-sim-'))
    : undefined;
  const controller = new AbortController();
  const advance = (ms) => vi.setSystemTime(Date.now() + ms);
  const plan = c.reactionPlan(SIM_RUN);
  const state = {
    actions: [],
    rest: [],
    written: [],
    returns: {},
    queue: [],
    profile: undefined,
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    chipRevealed: false,
    dialog: false,
    dialogKey: null,
    snapshot: [],
    composerGone: false,
    timelineReset: false,
    pendingReactions: [],
    rendered: [],
    batches: [],
    sent: [],
    sendReturns: [],
    registeredBeforeSend: [],
    firstReadyRead: undefined,
    thumbsSatisfiedAt: undefined,
    groupsSatisfiedAt: undefined,
    dialogReads: 0,
    chainAnchor: undefined,
    heartPressedAt: undefined,
    backApplied: false,
    dismissedAt: undefined,
    secretsAtReset: undefined,
    joins: 0,
    // Mobile: the route (`room` | `rooms` | `settings` | `appearance`), the theme and the sheet's timeline.
    route: 'rooms',
    opens: 0,
    dialogOpens: 0,
    dark: faults.modeIgnored === 'light' || faults.startDark === true,
    settingsBackApplied: false,
    restoredSeenAt: undefined,
    scrollLeft: 0,
    dchain: {},
    swipes: [],
    nativeRects: [],
    flows: [],
  };
  const lagOf = (label) => faults.lag?.[label] ?? 0;
  const applyDueEntries = () => {
    const rest = [];
    for (const entry of state.queue) {
      if (Date.now() - state.returns[entry.label] < lagOf(entry.label))
        rest.push(entry);
      else entry.apply();
    }
    state.queue = rest;
  };
  const deliver = () => {
    if (!state.roomOpen || state.pendingReactions.length === 0) return;
    const lastSend = state.sendReturns.at(-1);
    if (Date.now() - lastSend < lagOf('gate')) return;
    const batch = state.pendingReactions;
    state.pendingReactions = [];
    state.batches.push(batch.length);
    if (batch.length > (faults.burstLimit ?? 10)) {
      state.timelineReset = true;
      state.rendered = [...batch];
    } else state.rendered.push(...batch);
  };
  const rowShown = () =>
    state.roomOpen &&
    !state.timelineReset &&
    state.firstReadyRead !== undefined &&
    Date.now() - state.firstReadyRead >= lagOf('targetRow');
  const thumbsCount = () => {
    const raw = state.rendered.filter(({ key }) => key === '👍').length;
    const capped = Math.min(raw, faults.thumbsRenderedAs ?? raw);
    const stale =
      state.sendReturns.length === 36 &&
      Date.now() - state.sendReturns.at(-1) < lagOf('final');
    return stale ? Math.max(capped - 1, 0) : capped;
  };
  /** A knob of 0 means immediate; otherwise it counts from the read that satisfied the previous record. */
  const since = (at, key) =>
    lagOf(key) === 0 || (at !== undefined && Date.now() - at >= lagOf(key));
  /** The last batch's pills (group-count) render `lag.group` after the read that satisfied thumbs-count. */
  const visiblePills = () =>
    state.rendered.length > 32 && !since(state.thumbsSatisfiedAt, 'group')
      ? state.rendered.slice(0, 32)
      : state.rendered;
  const summaryShown = () =>
    state.rendered.length < 36 || since(state.groupsSatisfiedAt, 'summary');
  const maxScroll = () => (faults.directoryWidth ?? 1121) - 393;
  const swipeStep = () =>
    faults.swipesNeeded
      ? Math.ceil(maxScroll() / faults.swipesNeeded)
      : (faults.swipeStep ?? 201);
  const lastKeyName = () => simKeyOrder(state.snapshot).at(-1);
  const lastKeyUnobstructed = () =>
    !faults.lastKeyBlocked && state.scrollLeft >= maxScroll();
  const inSettings = () =>
    state.route === 'settings' || state.route === 'appearance';
  /** The light sheet's class follows the visible read by `lag.sheet`; the dark one is asserted on its visible read. */
  const sheetShown = () =>
    !mobile || state.dialogOpens > 1 || since(state.dchain.visibleAt, 'sheet');
  const pillsHtml = () =>
    simKeyOrder(visiblePills())
      .map((key) => {
        const count =
          key === '👍'
            ? thumbsCount()
            : visiblePills().filter((item) => item.key === key).length;
        const label =
          key === '👍' && summaryShown()
            ? ` aria-label="${simEscape(count > 3 ? `👍 reacted by ${faults.summaryWithoutYou ? 'Alpha' : 'You'}, Beta, Gamma and ${count - 3} others` : `👍 reacted by ${faults.summaryWithoutYou ? 'Alpha' : 'You'}`)}"`
            : '';
        return `<span class="reaction"${label}><span class="reaction__key">${key}</span><span class="reaction__count">${count}</span></span>`;
      })
      .join('');
  const reactorsFor = (key) => {
    const senders = state.snapshot
      .filter((item) => item.key === key)
      .map(({ sender }) => sender);
    let names = senders.map((sender) =>
      simNameOf(sender, faults.longReactorMissing),
    );
    if (key === '👍' && faults.reactors !== undefined)
      names = names.slice(0, faults.reactors);
    if (mobile && faults.lastKeyTwoReactors && key === lastKeyName())
      names = [...names, 'Second reactor'];
    return names;
  };
  const dialogHtml = () => {
    const keys = simKeyOrder(state.snapshot);
    const shownKeys =
      faults.keys !== undefined ? keys.slice(0, faults.keys) : keys;
    const selected = state.dialogKey ?? '👍';
    // heart-reactors: the list follows the pressed key `lag.heartReactors` after heart-pressed.
    const listed =
      (selected === '❤️' && !since(state.heartPressedAt, 'heartReactors')) ||
      (mobile &&
        selected === lastKeyName() &&
        !since(state.dchain.scrolledAt, 'lastKeyReactors'))
        ? '👍'
        : selected;
    const keyButtons = shownKeys
      .map(
        (key) =>
          `<button data-testid="reactions-key"${mobile && key === shownKeys.at(-1) ? ' data-box="lastKey"' : ''} aria-pressed="${key === selected}" aria-label="${simEscape(key)}, ${state.snapshot.filter((item) => item.key === key).length} reacted">${key}</button>`,
      )
      .join('');
    const items = reactorsFor(listed)
      .map((name) =>
        name === SIM_LONG
          ? `<li class="reactor"><span class="reactor__name" data-scroll='${JSON.stringify({ clientWidth: 500, scrollWidth: faults.longWidth ?? 544 })}' data-style='${JSON.stringify({ textOverflow: faults.textOverflow ?? 'ellipsis' })}'>${name}</span></li>`
          : `<li class="reactor"><span class="reactor__name">${name}</span></li>`,
      )
      .join('');
    return (
      `<trn-reactions-dialog class="${faults.noSheetClass || !sheetShown() ? '' : 'reactions-dialog--sheet'}"><div data-testid="reactions-dialog" data-box="${mobile ? 'sheet' : 'dialog'}" data-style='${JSON.stringify({ backgroundColor: state.dark && !faults.darkPaintSame ? SIM_DARK_PAINT : SIM_LIGHT_PAINT })}'>` +
      `<span class="reactions-dialog__total">${faults.total ?? '36 total'}</span>` +
      `<div data-testid="reactions-directory" data-box="directory" data-scroll='${JSON.stringify({ scrollWidth: mobile && !since(state.dchain.sheetAt, 'directory') ? 393 : (faults.directoryWidth ?? 1121), clientWidth: 393, scrollLeft: mobile && state.dchain.pressedAt !== undefined && !since(state.dchain.pressedAt, 'scrolled') ? 0 : state.scrollLeft })}'>${keyButtons}</div>` +
      `<div class="reactions-dialog__detail" data-scroll='${JSON.stringify({ scrollHeight: 791, clientHeight: faults.detailScrolls === false || !since(mobile ? state.dchain.overflowAt : state.chainAnchor, 'detail') ? 791 : 441 })}'><ul data-testid="reactors-list">${items}</ul></div>` +
      `</div></trn-reactions-dialog>` +
      `<button data-testid="close-reactions" data-box="${faults.closeHidden ? 'zero' : 'close'}"></button>`
    );
  };
  const render = () => {
    applyDueEntries();
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    if (state.signedIn && mobile)
      parts.push(
        '<button data-testid="open-settings" data-box="btn">Settings</button>',
      );
    parts.push('</nav>');
    if (mobile && state.roomOpen)
      parts.push(
        `<button data-testid="back-to-rooms" data-box="${faults.backToRoomsHidden ? 'zero' : 'btn'}">Rooms</button>`,
      );
    const settingsHost =
      inSettings() ||
      (state.settingsBackApplied &&
        (faults.settingsStuck || !since(state.restoredSeenAt, 'detached')));
    if (mobile && settingsHost) {
      parts.push('<trn-settings>');
      if (state.route === 'settings')
        parts.push(
          `<nav aria-label="Settings sections" data-box="${faults.sectionsHidden ? 'zero' : 'btn'}"><button data-testid="settings-nav-appearance">Appearance</button></nav>`,
        );
      if (state.route === 'appearance')
        parts.push(
          '<button data-testid="mode-light">Light</button><button data-testid="mode-dark">Dark</button>',
        );
      if (inSettings())
        parts.push('<button aria-label="Back" data-box="btn"></button>');
      parts.push('</trn-settings>');
    }
    if (state.roomsShown && !inSettings())
      parts.push(
        `<aside><div class="channel">${simEscape(SIM_ROOM_NAME)}</div></aside>`,
      );
    if (state.roomOpen) {
      parts.push(
        '<div class="scroll" data-box="msg"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      if (rowShown())
        parts.push(
          `<div class="msg" data-mid="${faults.otherRoomReopened && state.opens >= 2 ? '$other' : SIM_TARGET}" data-box="msg"><p class="msg__text">${simEscape(SIM_BODY)}</p>${pillsHtml()}<button class="reaction reaction--who" data-testid="reactions-who" data-box="who">5</button></div>`,
        );
      else if (state.timelineReset && faults.ghostRow)
        parts.push(
          `<div class="msg" data-mid="$ghost" data-box="msg"><p class="msg__text">${simEscape(SIM_BODY)}</p>${pillsHtml()}</div>`,
        );
      parts.push('</div>');
      const composerLate =
        state.backApplied && !since(state.dismissedAt, 'composer');
      if (!state.composerGone && !composerLate)
        parts.push(
          '<textarea data-testid="composer-input" data-box="composer"></textarea>',
        );
    }
    if (state.dialog) parts.push(dialogHtml());
    return parts.join('');
  };
  const routeUrl = () => {
    if (!mobile)
      return state.roomOpen ? SIM_ROUTE : 'https://localhost/rooms?account=x';
    // The Rooms route resolves its account `lag.roomsRoute` after the back-to-rooms tap returned.
    const qualified =
      !faults.routeWithoutAccount &&
      (state.roomOpen || since(state.returns.roomsTap, 'roomsRoute'));
    const account = qualified
      ? `?account=${encodeURIComponent(simReader.userId)}`
      : '';
    if (state.roomOpen)
      return `https://localhost/rooms/${Buffer.from(SIM_ROOM).toString('base64url')}${account}`;
    if (state.route === 'settings') return 'https://localhost/settings';
    if (state.route === 'appearance')
      return 'https://localhost/settings/appearance';
    return `https://localhost/rooms${account}`;
  };
  const dom = () => {
    const jsdom = new JSDOM(`<main>${render()}</main>`, {
      url: routeUrl(),
    });
    const { window } = jsdom;
    if (state.dark) window.document.documentElement.classList.add('dark');
    const requested = state.profile ?? c.GENERAL_TOUCH_PROFILE;
    Object.defineProperty(window, 'innerWidth', {
      value: faults.profileWidth ?? requested.width,
    });
    Object.defineProperty(window, 'innerHeight', { value: requested.height });
    Object.defineProperty(window, 'devicePixelRatio', {
      value: requested.deviceScaleFactor ?? 1,
    });
    const rect = ([x, y, width, height]) => ({
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
    });
    const proto = window.HTMLElement.prototype;
    proto.getBoundingClientRect = function () {
      const name = this.getAttribute('data-box');
      if (name === 'sheet') {
        const left = faults.sheetLeft ?? 0;
        const right = faults.sheetRight ?? 393.14;
        const bottom = faults.sheetBottom ?? 851.05;
        return rect([left, 170, right - left, bottom - 170]);
      }
      return rect(SIM_BOXES[name] ?? SIM_BOXES.zero);
    };
    for (const name of [
      'scrollWidth',
      'clientWidth',
      'scrollHeight',
      'clientHeight',
      'scrollLeft',
    ])
      Object.defineProperty(proto, name, {
        get() {
          const scroll = JSON.parse(this.getAttribute('data-scroll') ?? '{}');
          return scroll[name] ?? 0;
        },
        configurable: true,
      });
    window.matchMedia = (query) => ({
      matches: query === '(hover: none)' || query === '(pointer: coarse)',
    });
    window.Capacitor = { getPlatform: () => 'android' };
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => {
      const overrides = {
        visibility: 'visible',
        ...JSON.parse(element.getAttribute('data-style') ?? '{}'),
      };
      const base = computed(element);
      return new Proxy(base, {
        get: (target, key) => (key in overrides ? overrides[key] : target[key]),
      });
    };
    window.document.elementFromPoint = (x, y) => {
      if (x === 325 && y === 345)
        return window.document.querySelector(
          lastKeyUnobstructed()
            ? '[data-box="lastKey"]'
            : '[data-testid="reactions-directory"]',
        );
      return state.chipRevealed || faults.chipVisible
        ? window.document.querySelector('[data-box="who"]')
        : window.document.querySelector('[data-box="composer"]');
    };
    return window;
  };
  const matches = (selector, filter = {}) =>
    [...dom().document.querySelectorAll(selector)].filter(
      (element) =>
        (filter.text === undefined ||
          (element.textContent ?? '').includes(filter.text)) &&
        (filter.exactText === undefined ||
          element.textContent?.trim() === filter.exactText) &&
        (filter.within === undefined ||
          (element.closest(filter.within.selector)?.textContent ?? '').includes(
            filter.within.text,
          )),
    );
  const elementsOf = (selector, filter) =>
    matches(selector, filter).map((element) => ({
      text: element.textContent?.trim() ?? '',
      visible: true,
      focused: false,
      disabled: element.matches(':disabled'),
      value: null,
      unobstructedCenter: true,
      rect: { x: 0, y: 0, width: 120, height: 20, bottom: 20, right: 120 },
      scrollHeight: 400,
      clientHeight: 200,
    }));
  const notActionable = (selector) =>
    new Error(`Simulated target is not one actionable element: ${selector}`);
  const actionable = (selector, filter) => {
    const found = matches(selector, filter);
    if (found.length !== 1 || found[0].matches(':disabled'))
      throw notActionable(selector);
    if (selector === SIM_WHO && !(state.chipRevealed || faults.chipVisible))
      throw notActionable(selector);
    if (selector.includes(':last-of-type') && !lastKeyUnobstructed())
      throw notActionable(selector);
    return found[0];
  };
  /** A native call finishes: the clock advances, then its return is recorded. */
  const finish = (label, ms = faults.tapMs ?? 1_000) => {
    advance(ms);
    state.returns[label] = Date.now();
  };
  const enqueue = (label, apply) => state.queue.push({ label, apply });
  const label = (selector, filter) =>
    `${selector}${filter.text || filter.exactText ? `|${filter.text ?? filter.exactText}` : ''}`;
  let context;
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    output,
    device: {
      async runFlow(flow, env) {
        if (mobile && /accounts-point-swipe-directory-\d+\.yaml$/u.test(flow)) {
          state.flows.push({
            name: basename(flow),
            text: await readFile(flow, 'utf8'),
          });
          state.actions.push('flow:swipe');
          finish('swipe');
          enqueue('swipe', () => {
            if (!faults.swipeIgnored)
              state.scrollLeft = Math.min(
                state.scrollLeft + swipeStep(),
                maxScroll(),
              );
          });
          return;
        }
        assert.ok(
          flow.endsWith(SIM_BACK_FLOW),
          'Only the Back flow is modelled',
        );
        assert.equal(env.APP_ID, 'eu.qwky.trinity');
        state.actions.push('flow:native-shell-back.yaml');
        finish('back');
        enqueue('back', () => {
          if (!faults.backIgnored) {
            state.dialog = false;
            state.backApplied = true;
          }
          if (faults.composerLost) state.composerGone = true;
        });
      },
    },
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          advance(faults.readMs ?? 1_000);
          applyDueEntries();
          deliver();
          const window = dom();
          if (state.roomOpen && state.firstReadyRead === undefined)
            state.firstReadyRead = Date.now();
          const now = Date.now();
          if (state.settingsBackApplied && state.restoredSeenAt === undefined)
            state.restoredSeenAt = now;
          if (
            state.thumbsSatisfiedAt === undefined &&
            state.sendReturns.length === 36 &&
            state.rendered.length > 0 &&
            rowShown() &&
            thumbsCount() === 17
          )
            state.thumbsSatisfiedAt = now;
          else if (
            state.groupsSatisfiedAt === undefined &&
            state.thumbsSatisfiedAt !== undefined &&
            state.rendered.length === 36 &&
            visiblePills().length === 36
          )
            state.groupsSatisfiedAt = now;
          if (state.dialog && expression.includes('reactions-dialog"')) {
            state.dialogReads++;
            // Read 8 satisfies long-reactor-overflow; detail-overflow polls from it.
            if (state.dialogReads === 8) state.chainAnchor = now;
            // Mobile: each record's knob counts from the read that satisfied the previous one; one stage advances per read.
            const d = state.dchain;
            if (d.visibleAt === undefined) {
              d.visibleAt = now;
              // The dark sheet is asserted on its own visible read.
              if (state.dialogOpens > 1) d.sheetAt = now;
            } else if (d.sheetAt === undefined) {
              if (sheetShown()) d.sheetAt = now;
            } else if (d.overflowAt === undefined) {
              if (since(d.sheetAt, 'directory')) d.overflowAt = now;
            } else if (
              d.pressedAt === undefined &&
              mobile &&
              state.dialogKey !== null &&
              state.dialogKey === lastKeyName()
            )
              d.pressedAt = now;
            else if (
              d.scrolledAt === undefined &&
              d.pressedAt !== undefined &&
              since(d.pressedAt, 'scrolled') &&
              state.scrollLeft > 0
            )
              d.scrolledAt = now;
            if (state.dialogKey === '❤️' && state.heartPressedAt === undefined)
              state.heartPressedAt = now;
          }
          if (state.backApplied && state.dismissedAt === undefined)
            state.dismissedAt = now;
          return {
            result: {
              value: JSON.parse(
                JSON.stringify(
                  runInNewContext(expression, {
                    document: window.document,
                    URL: window.URL,
                  }),
                ),
              ),
            },
          };
        },
      },
    },
    async reset(profile) {
      state.actions.push('reset');
      state.secretsAtReset = Object.values(context.secrets);
      state.profile = profile;
      finish('reset');
    },
    async login() {
      state.actions.push('login');
      finish('login');
      enqueue('login', () => (state.signedIn = true));
    },
    async hideKeyboard() {
      state.actions.push('hide-keyboard');
      finish('hide');
    },
    async elements(selector, filter) {
      advance(faults.readMs ?? 1_000);
      return elementsOf(selector, filter);
    },
    async waitElements(selector, accepts, description, filter, timeoutMs) {
      assert.ok(Number.isFinite(timeoutMs), 'Simulated waits are bounded');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        controller.signal.throwIfAborted();
        advance(faults.readMs ?? 1_000);
        const values = elementsOf(selector, filter);
        if (accepts(values)) return values;
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    async visible(selector, filter, timeoutMs = 15_000) {
      const [element] = await client.waitElements(
        selector,
        (values) => values.length === 1 && values[0].visible,
        selector,
        filter,
        timeoutMs,
      );
      return element;
    },
    async eventIdentity(selector, filter, eventId) {
      advance(faults.readMs ?? 1_000);
      const found = matches(selector, filter);
      return {
        matches: found.length,
        exactEvent:
          found.length === 1 && found[0].getAttribute('data-mid') === eventId,
      };
    },
    async nativeRect(rect) {
      state.nativeRects.push(rect);
      const point = (x, y) => ({
        x: Math.round(x * 2.75),
        y: Math.round(y * 2.75),
      });
      return {
        topLeft: point(rect.x + 0.5, rect.y + 0.5),
        bottomRight: point(
          rect.x + rect.width - 0.5,
          rect.y + rect.height - 0.5,
        ),
      };
    },
    async tapCurrent(selector, filter = {}) {
      // A target that is not one actionable element fails before any native input.
      const element = actionable(selector, filter);
      state.actions.push(`tap:${label(selector, filter)}`);
      const testId = element.getAttribute('data-testid');
      let tapped;
      if (testId === 'rail-rooms') {
        tapped = 'rail';
        enqueue(tapped, () => (state.roomsShown = true));
      } else if (element.classList.contains('channel')) {
        tapped = 'room';
        enqueue(tapped, () => {
          state.roomOpen = true;
          state.route = 'room';
          state.opens++;
          state.chipRevealed = false;
          if (faults.dialogWithoutTap) state.dialog = true;
        });
      } else if (testId === 'reactions-who') {
        tapped = 'who';
        enqueue(tapped, () => {
          state.dialog = true;
          state.dialogKey = '👍';
          state.snapshot = [...state.rendered];
          state.dialogOpens++;
          state.dialogReads = 0;
          state.dchain = {};
        });
      } else if (
        testId === 'reactions-key' &&
        selector.includes(':last-of-type')
      ) {
        tapped = 'lastKey';
        enqueue(tapped, () => {
          if (faults.lastKeyIgnored) return;
          state.dialogKey = lastKeyName();
          if (faults.scrollResetOnTap) state.scrollLeft = 0;
        });
      } else if (testId === 'reactions-key') {
        tapped = 'heart';
        enqueue(tapped, () => {
          if (!faults.heartIgnored) state.dialogKey = '❤️';
        });
      } else if (testId === 'close-reactions') {
        tapped = 'close';
        enqueue(tapped, () => {
          if (!faults.closeIgnored) state.dialog = false;
        });
      } else if (testId === 'back-to-rooms') {
        tapped = 'roomsTap';
        enqueue(tapped, () => {
          state.roomOpen = false;
          state.route = 'rooms';
        });
      } else if (testId === 'open-settings') {
        tapped = 'sections';
        enqueue(tapped, () => {
          state.roomOpen = false;
          state.route = 'settings';
          state.settingsBackApplied = false;
          state.restoredSeenAt = undefined;
        });
      } else if (testId === 'settings-nav-appearance') {
        tapped = 'nav';
        enqueue(tapped, () => (state.route = 'appearance'));
      } else if (testId === 'mode-light' || testId === 'mode-dark') {
        tapped = 'mode';
        const mode = testId.slice('mode-'.length);
        enqueue(tapped, () => {
          if (faults.modeIgnored !== mode) state.dark = mode === 'dark';
        });
      } else if (element.matches('button[aria-label="Back"]')) {
        const from = state.route;
        tapped = from === 'appearance' ? 'unwound' : 'restored';
        enqueue(tapped, () => {
          if (from === 'appearance' && !faults.firstBackToRooms) {
            if (!faults.sectionStuck) state.route = 'settings';
            return;
          }
          state.route = 'rooms';
          state.settingsBackApplied = true;
        });
      } else throw new Error(`Unmodelled simulated tap ${selector}`);
      finish(tapped);
    },
    async scrollIntoViewIfNeeded(selector) {
      assert.equal(selector, SIM_WHO, 'Only the chip is scrolled into view');
      state.actions.push(`scroll:${selector}`);
      finish('scroll');
      if (!faults.chipObstructed)
        enqueue('scroll', () => (state.chipRevealed = true));
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  const history = () => {
    const member = (userId, membership, displayname) => ({
      type: 'm.room.member',
      event_id: `$member-${userId}`,
      state_key: userId,
      content: { membership, displayname },
    });
    const others = simOthers.slice(0, faults.joinedOthers ?? 16);
    const events = [
      ...(faults.noCreate
        ? []
        : [{ type: 'm.room.create', event_id: '$create', content: {} }]),
      {
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: faults.joinRule ?? 'public' },
      },
      member(simReader.userId, 'join', 'Reader'),
      ...others.map((other, index) =>
        member(
          other.userId,
          'join',
          index === 0 && !faults.longNameMissing ? SIM_LONG : other.username,
        ),
      ),
      {
        type: 'm.room.message',
        event_id: SIM_TARGET,
        sender: faults.targetFromOther ? simOthers[0].userId : simReader.userId,
        content: { msgtype: 'm.text', body: SIM_BODY },
      },
    ];
    if (faults.extraMessage)
      events.push({
        type: 'm.room.message',
        event_id: '$extra',
        sender: simReader.userId,
        content: { msgtype: 'm.text', body: 'extra' },
      });
    return { chunk: [...events].reverse() };
  };
  const relations = () => {
    let events = state.sent.map(({ id, key, sender }) => ({
      type: 'm.reaction',
      event_id: id,
      sender: simSenders[sender].userId,
      content: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: SIM_TARGET,
          key,
        },
      },
    }));
    // The relations read converges only `relationsLagMs` after the last send.
    if (
      faults.relationsLagMs !== undefined &&
      Date.now() - state.sendReturns.at(-1) < faults.relationsLagMs
    )
      events = events.slice(0, -1);
    if (faults.relationsMissing) events = events.slice(0, -1);
    if (faults.relationsWrongTarget)
      events[0] = {
        ...events[0],
        content: {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: '$elsewhere',
            key: '👍',
          },
        },
      };
    if (faults.relationsDuplicateSender)
      events[1] = { ...events[1], sender: events[0].sender };
    if (faults.relationsWrongSender)
      events[1] = { ...events[1], sender: '@stranger:localhost' };
    return events;
  };
  const fixtures = {
    async account(role) {
      state.rest.push('rest:account');
      const account = simSenders.find(({ username }) => username === role);
      assert.ok(account, `Unknown role ${role}`);
      return account;
    },
    async setDisplayName(account, name) {
      assert.equal(account, simOthers[0]);
      assert.equal(name, SIM_LONG);
      state.rest.push('rest:setDisplayName');
    },
    async createRoom(account, { name, preset }) {
      assert.equal(account, simReader);
      assert.equal(preset, 'public_chat');
      assert.equal(name, SIM_ROOM_NAME);
      state.rest.push('rest:createRoom');
      return { id: SIM_ROOM, name };
    },
    async joinHonoringRateLimit(account, roomId) {
      assert.equal(roomId, SIM_ROOM);
      assert.equal(account, simOthers[state.joins]);
      if (faults.joinExhausted)
        throw new Error(
          'Matrix fixture join still rate-limited after 5 attempts',
        );
      const attempts = faults.joinAttempts?.[state.joins] ?? 1;
      state.joins++;
      state.rest.push('rest:joinHonoringRateLimit');
      return {
        status: 200,
        attempts,
        retryAfterMs: Array(attempts - 1).fill(462),
      };
    },
    async sendMessage(account, roomId, body, txn) {
      assert.equal(account, simReader);
      assert.equal(roomId, SIM_ROOM);
      assert.equal(body, SIM_BODY);
      assert.equal(txn, c.targetTxnOf(SIM_RUN));
      state.rest.push('rest:sendMessage');
      return SIM_TARGET;
    },
    async roomMessages(account, roomId) {
      assert.equal(account, simReader);
      assert.equal(roomId, SIM_ROOM);
      advance(faults.readMs ?? 1_000);
      state.rest.push('rest:roomMessages');
      return history();
    },
    async sendReaction(sender, roomId, eventId, key, txn) {
      const index = state.sent.length;
      const planned = plan[index];
      assert.equal(roomId, SIM_ROOM);
      assert.equal(eventId, SIM_TARGET);
      assert.equal(key, planned.key);
      assert.equal(txn, planned.txn);
      assert.equal(sender, simSenders[planned.sender]);
      // Rule 7: the previous reaction's id is registered before this send.
      state.registeredBeforeSend.push(
        index === 0
          ? true
          : Object.values(context.secrets).includes(state.sent[index - 1].id),
      );
      state.rest.push('rest:sendReaction');
      if (faults.reactionSendFails === index + 1)
        throw new Error(
          `Matrix fixture PUT /rooms/x/send/m.reaction/${txn} failed with HTTP 500`,
        );
      advance(faults.sendMs ?? 0);
      state.sendReturns.push(Date.now());
      const id = `$evt-r${simPad(index + 1)}`;
      state.sent.push({ id, key, sender: planned.sender });
      state.pendingReactions.push({ key, sender: planned.sender });
      return id;
    },
    async reactionRelations(observer, roomId, eventId) {
      assert.equal(observer, simReader);
      assert.equal(roomId, SIM_ROOM);
      assert.equal(eventId, SIM_TARGET);
      advance(faults.readMs ?? 1_000);
      state.rest.push('rest:reactionRelations');
      return relations();
    },
  };
  context = {
    entry: c.WHO_REACTED_STAGES.find(({ id }) => id === stage),
    records: [],
    identities: new Set(),
    receipts: 0,
    client,
    fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    signal: controller.signal,
    ledger: {
      run: SIM_RUN,
      accounts: [],
      rooms: [],
      texts: [],
      eventIds: [],
      transactions: [],
    },
    reactionIds: [],
  };
  return { client, fixtures, state, context, output };
}

/** Runs one simulated stage on the fake clock, restoring real timers afterwards. */
async function withSimulatedStage(faults, run, journeysModule) {
  const journeys = journeysModule ?? (await loadJourneys());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  let output;
  try {
    const app = await simulatedWhoReactedApp(faults);
    output = app.output;
    return await run({
      ...app,
      runPillDialog: journeys.runPillDialog,
      runMobileSheet: journeys.runMobileSheet,
    });
  } finally {
    vi.useRealTimers();
    if (output) await rm(output, { recursive: true, force: true });
  }
}

const SIM_ACTIONS = [
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${SIM_ROOM_NAME}`,
  `scroll:${SIM_WHO}`,
  `tap:${SIM_WHO}`,
  `tap:${SIM_KEY}|❤️`,
  'flow:native-shell-back.yaml',
];
const SIM_RECEIPTS = [
  'arranged',
  'reaction-gate-1',
  'reaction-gate-2',
  'reaction-gate-3',
  'reaction-gate-4',
  'reactions-arranged',
  'dialog-absent',
  'dialog-shape',
  'room-recovered',
];
const SIM_SLICE = {
  none: 0,
  reset: 1,
  room: 5,
  scroll: 6,
  chip: 7,
  heart: 8,
  all: 9,
};

/** Written evidence carries digests and booleans, never an identifier, a credential or the pill label. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of secrets)
    expect(written, `written evidence leaks ${value}`).not.toContain(value);
  expect(written).not.toContain('reacted by');
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~][A-Za-z0-9_]{2,}|data-mid[*~|]?=[^^]/u,
    );
}

const fragment = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu');

describe('Android who-reacted pill-dialog against a simulated installed app', () => {
  it('drives the exact native sequence and records all 88 identities in order', async () => {
    const c = await loadContract();
    await withSimulatedStage({}, async ({ context, state, runPillDialog }) => {
      await runPillDialog(context);
      expect(context.records).toEqual(
        c.WHO_REACTED_STAGES.find(({ id }) => id === SIM_STAGE).assertions,
      );
      expect(context.records).toHaveLength(88);
      expect(state.actions).toEqual(SIM_ACTIONS);
      expect(state.rest).toEqual([
        ...Array(17).fill('rest:account'),
        'rest:setDisplayName',
        'rest:createRoom',
        ...Array(16).fill('rest:joinHonoringRateLimit'),
        'rest:sendMessage',
        'rest:roomMessages',
        ...Array(36).fill('rest:sendReaction'),
        'rest:reactionRelations',
      ]);
      expect(state.batches.every((size) => size <= 8)).toBe(true);
      expect(state.batches).toEqual([8, 8, 8, 8, 4]);
      expect(
        state.written
          .map(({ name }) => name)
          .filter((name) => name.startsWith('receipt-'))
          .map((name) => name.replace(/^receipt-\d+-/u, '')),
      ).toEqual(SIM_RECEIPTS);
      const registered = [];
      for (const account of [SIM_READER, ...SIM_OTHERS])
        registered.push(account.userId, account.username, account.password);
      registered.push(
        SIM_ROOM,
        SIM_ROOM_NAME,
        SIM_BODY,
        SIM_LONG,
        SIM_TARGET,
        c.targetTxnOf(SIM_RUN),
        ...new Set(c.reactionPlan(SIM_RUN).map(({ txn }) => txn)),
      );
      for (const value of registered)
        expect(state.secretsAtReset).toContain(value);
      // Each reaction id was registered as its send returned.
      for (const id of context.reactionIds)
        expect(Object.values(context.secrets)).toContain(id);
      expect(context.reactionIds).toHaveLength(36);
      expect(new Set(c.reactionPlan(SIM_RUN).map(({ txn }) => txn)).size).toBe(
        35,
      );
      expect(state.registeredBeforeSend).toHaveLength(36);
      expect(state.registeredBeforeSend.every(Boolean)).toBe(true);
      assertIdFreeEvidence(state, Object.values(context.secrets));
    });
  }, 60_000);

  const CONTROLS = [
    ['joinedOthers: 15', { joinedOthers: 15 }, '17 joined members', 'none'],
    ['extraMessage', { extraMessage: true }, 'exactly the target', 'none'],
    [
      'targetFromOther',
      { targetFromOther: true },
      'reader sent the target',
      'none',
    ],
    ['joinRule: invite', { joinRule: 'invite' }, 'public', 'none'],
    [
      'longNameMissing [RF-2]',
      { longNameMissing: true },
      "long reactor's display name",
      'none',
    ],
    ['noCreate', { noCreate: true }, 'm.room.create', 'none'],
    [
      'joinExhausted [RF-5]',
      { joinExhausted: true },
      'still rate-limited after 5 attempts',
      'none',
    ],
    [
      'profileWidth: 1279',
      { profileWidth: 1279 },
      'general touch profile',
      'reset',
    ],
    ['thumbsRenderedAs: 16', { thumbsRenderedAs: 16 }, 'cumulative 👍', 'room'],
    ['relationsMissing', { relationsMissing: true }, 'exactly 36', 'room'],
    [
      'relationsWrongTarget',
      { relationsWrongTarget: true },
      'annotates the target',
      'room',
    ],
    [
      'relationsDuplicateSender',
      { relationsDuplicateSender: true },
      '17 distinct',
      'room',
    ],
    [
      'relationsWrongSender',
      { relationsWrongSender: true },
      'planned sender',
      'room',
    ],
    [
      'summaryWithoutYou',
      { summaryWithoutYou: true },
      'reacted by You',
      'room',
    ],
    [
      'reactionSendFails: 12',
      { reactionSendFails: 12 },
      'failed with HTTP 500',
      'room',
    ],
    ['chipObstructed', { chipObstructed: true }, 'one actionable', 'scroll'],
    [
      'dialogWithoutTap [RF-4]',
      { dialogWithoutTap: true },
      'no Reactions dialog before the native tap',
      'room',
    ],
    ['total: 35 total', { total: '35 total' }, '36 total', 'chip'],
    ['closeHidden', { closeHidden: true }, 'close control is visible', 'chip'],
    ['keys: 19', { keys: 19 }, 'lists 20 keys', 'chip'],
    [
      'longReactorMissing',
      { longReactorMissing: true },
      "long reactor's name is listed",
      'chip',
    ],
    [
      'textOverflow: clip',
      { textOverflow: 'clip' },
      'text-overflow: ellipsis',
      'chip',
    ],
    ['longWidth: 500 [RF-2]', { longWidth: 500 }, 'actually overflows', 'chip'],
    [
      'detailScrolls: false',
      { detailScrolls: false },
      'scrolls vertically',
      'chip',
    ],
    ['reactors: 16', { reactors: 16 }, 'lists 17 reactors', 'chip'],
    ['heartIgnored', { heartIgnored: true }, 'Only ❤️ is pressed', 'heart'],
    ['backIgnored', { backIgnored: true }, 'dismissed', 'all'],
    ['composerLost', { composerLost: true }, 'composer', 'all'],
    [
      'burstLimit: 7 [RF-1]',
      { burstLimit: 7 },
      'target row is still rendered',
      'room',
    ],
    [
      'ghostRow [RF-1]',
      { burstLimit: 7, ghostRow: true },
      'target row is still rendered',
      'room',
    ],
  ];
  for (const [name, faults, message, upTo] of CONTROLS)
    it(`rejects ${name} with ${message}`, async () => {
      await withSimulatedStage(
        { readMs: 4_000, ...faults },
        async ({ context, state, runPillDialog }) => {
          await expect(runPillDialog(context)).rejects.toThrow(
            fragment(message),
          );
          expect(state.actions).toEqual(SIM_ACTIONS.slice(0, SIM_SLICE[upTo]));
          if (faults.reactionSendFails !== undefined)
            expect(
              context.records.filter((record) => record.includes('.reaction-')),
            ).toEqual(
              Array.from(
                { length: 11 },
                (_, i) => `who-reacted.${SIM_STAGE}.reaction-${simPad(i + 1)}`,
              ),
            );
        },
      );
    }, 60_000);

  it('passes with bursts capped at 8 and proves every batch holds at most 8 [RF-1]', async () => {
    await withSimulatedStage(
      { burstLimit: 8 },
      async ({ context, state, runPillDialog }) => {
        await runPillDialog(context);
        expect(Math.max(...state.batches)).toBeLessThanOrEqual(8);
        expect(state.timelineReset).toBe(false);
      },
    );
  }, 60_000);

  it('keeps a user id and the long name in an assertion actual and expected out of the redacted failure [RF-5]', async () => {
    const { redactStageFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const { default: strict } = await import('node:assert/strict');
    const userId = SIM_READER.userId;
    const secrets = { reader: userId, long: SIM_LONG };
    const withMessage = new AssertionError({
      actual: userId,
      expected: SIM_LONG,
      operator: 'strictEqual',
      message: 'The first line names no value',
    });
    let generated;
    try {
      strict.equal(userId, SIM_LONG);
    } catch (error) {
      generated = error;
    }
    expect(generated.actual).toBe(userId);
    expect(generated.expected).toBe(SIM_LONG);
    expect(generated.generatedMessage).toBe(true);
    const thrown = redactStageFailure(
      SIM_STAGE,
      [withMessage, generated, new AggregateError([generated], 'nested')],
      secrets,
    );
    for (const value of [userId, SIM_LONG, '@pd-reader', 'xxxxxxxx'])
      expect(thrown.message).not.toContain(value);
    expect(thrown.message).toContain('The first line names no value');
    expect(thrown.message).toContain('strictEqual assertion failed');
    expect(Object.keys(thrown)).toEqual([]);
    expect(thrown.cause).toBeUndefined();
    for (const property of ['actual', 'expected', 'errors', 'operator'])
      expect(Reflect.has(thrown, property)).toBe(false);
  });

  // [RF-3] Every window is anchored after its event: 45 s taps and 5 s sends, one pass 5 s inside the bound and one fail 1 s past it.
  const WINDOWS = [
    ['room', 15_000, 21_000, 'composer'],
    ['targetRow', 15_000, 21_000, 'Exactly one reconciled target row'],
    ['gate', 25_000, 31_000, 'cumulative 👍'],
    ['final', 25_000, 31_000, '17'],
    ['who', 15_000, 21_000, 'one visible Reactions dialog'],
    ['heart', 15_000, 21_000, 'Only ❤️ is pressed'],
    ['back', 15_000, 21_000, 'dismissed'],
    ['rail', 25_000, 31_000, '.channel'],
    ['group', 25_000, 31_000, 'reaction groups'],
    ['summary', 15_000, 21_000, 'names its reactors'],
    ['detail', 15_000, 21_000, 'scrolls vertically'],
    ['heartReactors', 15_000, 21_000, 'lists 1 reactors'],
    ['composer', 15_000, 21_000, 'composer'],
  ];
  const SLOW = { tapMs: 45_000, sendMs: 5_000 };
  for (const [key, passAt, failAt, message] of WINDOWS) {
    it(`passes the ${key} window at ${passAt} ms [RF-3]`, async () => {
      const c = await loadContract();
      await withSimulatedStage(
        { ...SLOW, lag: { [key]: passAt } },
        async ({ context, runPillDialog }) => {
          await runPillDialog(context);
          expect(context.records).toEqual(
            c.WHO_REACTED_STAGES.find(({ id }) => id === SIM_STAGE).assertions,
          );
        },
      );
    }, 120_000);
    it(`fails the ${key} window at ${failAt} ms [RF-3]`, async () => {
      await withSimulatedStage(
        { ...SLOW, lag: { [key]: failAt } },
        async ({ context, state, runPillDialog }) => {
          await expect(runPillDialog(context)).rejects.toThrow(
            fragment(message),
          );
          // The lagged gate is gate 1 itself, not a later count fault.
          if (key === 'gate')
            expect(
              state.written.some(({ name }) =>
                name.endsWith('reaction-gate-1'),
              ),
            ).toBe(false);
        },
      );
    }, 120_000);
  }
  // The reactions-arranged read-back converges `relationsLagMs` after the last send; its bound runs from that send.
  it('passes the reactions-arranged window at 25 000 ms [RF-3]', async () => {
    await withSimulatedStage(
      { ...SLOW, relationsLagMs: 25_000 },
      async ({ context, runPillDialog }) => {
        await runPillDialog(context);
        expect(context.records).toHaveLength(88);
      },
    );
  }, 120_000);
  it('fails the reactions-arranged window at 31 000 ms [RF-3]', async () => {
    await withSimulatedStage(
      { ...SLOW, relationsLagMs: 31_000 },
      async ({ context, runPillDialog }) => {
        await expect(runPillDialog(context)).rejects.toThrow(
          fragment('exactly 36'),
        );
      },
    );
  }, 120_000);
  it('fails the reactions-arranged read-back when every read takes 10 s, which a fresh per-read bound would pass [RF-3]', async () => {
    const faults = { ...SLOW, readMs: 10_000, relationsLagMs: 55_000 };
    await withSimulatedStage(faults, async ({ context, runPillDialog }) => {
      await expect(runPillDialog(context)).rejects.toThrow(
        fragment('exactly 36'),
      );
    });
    const source = read(JOURNEYS);
    const mutated = source.replace(
      "lastSentAt, 'the 36 reactions on the server'",
      "Date.now(), 'the 36 reactions on the server'",
    );
    expect(mutated).not.toBe(source);
    await withMutatedJourneys({ journeys: mutated }, (module) =>
      withSimulatedStage(
        faults,
        async ({ context, runPillDialog }) => {
          await runPillDialog(context);
          expect(context.records).toHaveLength(88);
        },
        module,
      ),
    );
  }, 240_000);
  it('fails the final window at 31 000 ms even when every read takes 10 s [RF-3]', async () => {
    await withSimulatedStage(
      { ...SLOW, readMs: 10_000, lag: { final: 31_000 } },
      async ({ context, runPillDialog }) => {
        await expect(runPillDialog(context)).rejects.toThrow(fragment('17'));
      },
    );
  }, 120_000);
});

const MS_STAGE = 'mobile-sheet';
const MS_BACK = 'tap:trn-settings button[aria-label="Back"]';
const MS_LAST_KEY =
  'tap:[data-testid="reactions-directory"] > [data-testid="reactions-key"]:last-of-type';
const msSettings = (mode) => [
  'tap:[data-testid="back-to-rooms"]',
  'tap:[data-testid="open-settings"]',
  'tap:[data-testid="settings-nav-appearance"]',
  `tap:[data-testid="mode-${mode}"]`,
  MS_BACK,
  MS_BACK,
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${SIM_ROOM_NAME}`,
];
const MS_ACTIONS = [
  'reset',
  'login',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${SIM_ROOM_NAME}`,
  ...msSettings('light'),
  `scroll:${SIM_WHO}`,
  `tap:${SIM_WHO}`,
  'tap:[data-testid="close-reactions"]',
  ...msSettings('dark'),
  `scroll:${SIM_WHO}`,
  `tap:${SIM_WHO}`,
  'flow:swipe',
  'flow:swipe',
  'flow:swipe',
  'flow:swipe',
  MS_LAST_KEY,
  'flow:native-shell-back.yaml',
];
const MS_RECEIPTS = [
  'arranged',
  'reaction-gate-1',
  'reaction-gate-2',
  'reaction-gate-3',
  'reaction-gate-4',
  'reactions-arranged',
  'light-back-to-rooms',
  'light-same-room',
  'light-dialog-absent',
  'light-sheet-paint',
  'dark-back-to-rooms',
  'dark-same-room',
  'dark-dialog-absent',
  'dark-sheet-usable',
  'directory-swipe-1',
  'directory-swipe-2',
  'directory-swipe-3',
  'directory-swipe-4',
  'room-recovered',
];
/** The actions through index `last` (inclusive) of the happy-path log. */
const through = (last) => MS_ACTIONS.slice(0, last + 1);
const IX = {
  reset: 0,
  firstBackToRooms: 5,
  openSettings: 6,
  lightMode: 8,
  firstBack: 9,
  secondBack: 10,
  lightRoom: 12,
  lightChip: 14,
  close: 15,
  darkMode: 19,
  darkRoom: 23,
  darkChip: 25,
  firstSwipe: 26,
  lastKey: 30,
};
const msRecords = async () =>
  (await loadContract()).WHO_REACTED_STAGES.find(({ id }) => id === MS_STAGE)
    .assertions;
const withMobileStage = (faults, run, journeysModule) =>
  withSimulatedStage(
    { stage: MS_STAGE, ...faults },
    (app) => run({ ...app, run: app.runMobileSheet }),
    journeysModule,
  );

describe('Android who-reacted mobile-sheet against a simulated installed app', () => {
  it('drives the exact native sequence and records all 103 identities in order', async () => {
    await withMobileStage({}, async ({ context, state, run, output }) => {
      await run(context);
      expect(context.records).toEqual(await msRecords());
      expect(context.records).toHaveLength(103);
      expect(state.actions).toEqual(MS_ACTIONS);
      expect(state.batches).toEqual([8, 8, 8, 8, 4]);
      expect(
        state.written
          .map(({ name }) => name)
          .filter((name) => name.startsWith('receipt-'))
          .map((name) => name.replace(/^receipt-\d+-/u, '')),
      ).toEqual(MS_RECEIPTS);
      // The swipe is a materialized native flow on the client's mapped directory rect.
      expect(state.flows.map(({ name }) => name)).toEqual(
        [1, 2, 3, 4].map((n) => `accounts-point-swipe-directory-${n}.yaml`),
      );
      const rect = { x: 0, y: 320, width: 393, height: 50 };
      expect(state.nativeRects).toEqual(Array(4).fill(rect));
      const px = (css) => Math.round(css * 2.75);
      const left = px(rect.x + 0.5);
      const span = px(rect.x + rect.width - 0.5) - left;
      const y = Math.round(
        (px(rect.y + 0.5) + px(rect.y + rect.height - 0.5)) / 2,
      );
      for (const { text } of state.flows)
        expect(text).toBe(
          `appId: eu.qwky.trinity\n---\n- swipe:\n    start: "${Math.round(left + span * 0.8)},${y}"\n    end: "${Math.round(left + span * 0.2)},${y}"\n    duration: 600\n`,
        );
      expect(state.scrollLeft).toBe(728);
      const swipes = state.written.filter(({ name }) =>
        name.includes('directory-swipe-'),
      );
      expect(swipes.map(({ value }) => [value.before, value.after])).toEqual([
        [0, 201],
        [201, 402],
        [402, 603],
        [603, 728],
      ]);
      expect(swipes.every(({ value }) => value.max === 728)).toBe(true);
      const accounts = [simAccount('ms-reader')];
      for (const account of accounts)
        expect(state.secretsAtReset).toContain(account.userId);
      expect(context.reactionIds).toHaveLength(36);
      assertIdFreeEvidence(state, Object.values(context.secrets));
      await expect(readdir(output)).resolves.toEqual(
        state.flows.map(({ name }) => name),
      );
    });
  }, 120_000);

  it('records every Settings, sheet and swipe identity with a receipt that is not a parity suffix', async () => {
    await withMobileStage({}, async ({ context, run }) => {
      await run(context);
      const suffixes = context.records.map((id) => id.split('.').at(-1));
      for (const suffix of [
        'light-rooms-route',
        'light-settings-sections',
        'light-mode',
        'light-section-unwound',
        'light-rooms-restored',
        'light-settings-detached',
        'light-room-open',
        'sheet-class',
        'sheet-left-bound',
        'sheet-right-bound',
        'sheet-bottom-attached',
        'light-dialog-closed',
        'dark-mode',
        'directory-overflow',
        'detail-overflow',
        'last-key-pressed',
        'directory-scrolled',
        'last-key-reactors',
        'dialog-dismissed',
        'composer-visible',
      ])
        expect(suffixes).toContain(suffix);
    });
  }, 120_000);

  // Every fault is modelled exactly as the matrix names it; `through` is the last native action that runs.
  const swipeSix = [...through(IX.darkChip), ...Array(6).fill('flow:swipe')];
  const CONTROLS = [
    [
      'profileWidth: 412',
      { profileWidth: 412 },
      'mobile sheet profile',
      through(IX.reset),
    ],
    [
      'routeWithoutAccount',
      { routeWithoutAccount: true },
      'Account-qualified Rooms route',
      through(IX.firstBackToRooms),
    ],
    [
      'sectionsHidden',
      { sectionsHidden: true },
      'Settings sections',
      through(IX.openSettings),
    ],
    [
      "modeIgnored: 'light'",
      { modeIgnored: 'light' },
      'Appearance mode is light',
      through(IX.lightMode),
    ],
    [
      "modeIgnored: 'dark'",
      { modeIgnored: 'dark' },
      'Appearance mode is dark',
      through(IX.darkMode),
    ],
    [
      'sectionStuck',
      { sectionStuck: true },
      'Settings section unwound',
      through(IX.firstBack),
    ],
    [
      'settingsStuck',
      { settingsStuck: true },
      'Settings host is detached',
      through(IX.secondBack),
    ],
    [
      'otherRoomReopened',
      { otherRoomReopened: true },
      'same Room and target',
      through(IX.lightRoom),
    ],
    [
      'noSheetClass',
      { noSheetClass: true },
      'carries the sheet class',
      through(IX.lightChip),
    ],
    [
      'sheetLeft: -1',
      { sheetLeft: -1 },
      'starts inside the viewport',
      through(IX.lightChip),
    ],
    [
      'sheetRight: 395',
      { sheetRight: 395 },
      'ends inside the viewport',
      through(IX.lightChip),
    ],
    [
      'sheetBottom: 850.5',
      { sheetBottom: 850.5 },
      'bottom-attached',
      through(IX.lightChip),
    ],
    [
      'closeIgnored',
      { closeIgnored: true },
      'Reactions dialog is dismissed',
      through(IX.close),
    ],
    [
      'darkPaintSame',
      { darkPaintSame: true },
      'differs from the light',
      through(IX.darkChip),
    ],
    [
      'directoryWidth: 393',
      { directoryWidth: 393 },
      'overflows horizontally',
      through(IX.darkChip),
    ],
    [
      'swipeIgnored',
      { swipeIgnored: true },
      'native swipe advanced the directory',
      through(IX.firstSwipe),
    ],
    [
      'swipesNeeded: 7',
      { swipesNeeded: 7 },
      'last key within six native swipes',
      swipeSix,
    ],
    [
      'lastKeyBlocked',
      { lastKeyBlocked: true },
      'native swipe advanced the directory',
      [...through(IX.darkChip), ...Array(5).fill('flow:swipe')],
    ],
    [
      'lastKeyIgnored',
      { lastKeyIgnored: true },
      'last key is pressed',
      through(IX.lastKey),
    ],
    [
      'scrollResetOnTap',
      { scrollResetOnTap: true },
      'scrolled to the last key',
      through(IX.lastKey),
    ],
    [
      'lastKeyTwoReactors',
      { lastKeyTwoReactors: true },
      'detail lists 1 reactors',
      through(IX.lastKey),
    ],
    [
      'backIgnored',
      { backIgnored: true },
      'Reactions dialog is dismissed',
      MS_ACTIONS,
    ],
    ['composerLost', { composerLost: true }, 'composer', MS_ACTIONS],
  ];
  for (const [name, faults, message, actions] of CONTROLS)
    it(`rejects ${name} with ${message}`, async () => {
      await withMobileStage(
        { readMs: 4_000, ...faults },
        async ({ context, state, run }) => {
          await expect(run(context)).rejects.toThrow(fragment(message));
          expect(state.actions).toEqual(actions);
        },
      );
    }, 120_000);

  // The three sheet bounds come from one read; each fault must fail its own record, not an earlier one.
  for (const [name, faults, last] of [
    ['noSheetClass', { noSheetClass: true }, 'light-dialog-visible'],
    ['sheetLeft: -1', { sheetLeft: -1 }, 'sheet-class'],
    ['sheetRight: 395', { sheetRight: 395 }, 'sheet-left-bound'],
    ['sheetBottom: 850.5', { sheetBottom: 850.5 }, 'sheet-right-bound'],
  ])
    it(`fails ${name} at its own sheet record`, async () => {
      await withMobileStage(faults, async ({ context, run }) => {
        await expect(run(context)).rejects.toThrow();
        expect(context.records.at(-1)).toBe(`who-reacted.${MS_STAGE}.${last}`);
      });
    }, 120_000);

  it('passes without the back-to-rooms taps when that button is hidden, as the predecessor conditional', async () => {
    await withMobileStage(
      { backToRoomsHidden: true },
      async ({ context, state, run }) => {
        await run(context);
        expect(context.records).toEqual(await msRecords());
        expect(state.actions).toEqual(
          MS_ACTIONS.filter((a) => a !== 'tap:[data-testid="back-to-rooms"]'),
        );
        expect(
          state.written.filter(({ name }) => name.endsWith('-back-to-rooms')),
        ).toHaveLength(2);
        expect(
          state.written
            .filter(({ name }) => name.endsWith('-back-to-rooms'))
            .every(({ value }) => !value.tapped && !value.visible),
        ).toBe(true);
      },
    );
  }, 120_000);

  it('passes with one Back tap when the first Back lands on Rooms, as the helper conditional', async () => {
    await withMobileStage(
      { firstBackToRooms: true },
      async ({ context, state, run }) => {
        await run(context);
        expect(context.records).toEqual(await msRecords());
        expect(state.actions).toEqual(
          MS_ACTIONS.filter(
            (_, index) => index !== IX.secondBack && index !== 21,
          ),
        );
      },
    );
  }, 120_000);

  // [RF-3] Every D4 window class of the stage: pass 5 s inside its bound, fail 1 s past it, 45 s taps and 5 s sends.
  const SLOW = { tapMs: 45_000, sendMs: 5_000 };
  const WINDOWS = [
    // Shared with pill-dialog, re-run on this stage's own anchors.
    ['rail', 25_000, 31_000, '.channel'],
    ['room', 15_000, 21_000, 'composer'],
    ['targetRow', 15_000, 21_000, 'Exactly one reconciled target row'],
    ['gate', 25_000, 31_000, 'cumulative 👍'],
    ['final', 25_000, 31_000, '17'],
    ['group', 25_000, 31_000, 'reaction groups'],
    // Settings and Rooms navigation (19–99).
    ['roomsRoute', 15_000, 21_000, 'Account-qualified Rooms route'],
    ['sections', 15_000, 21_000, 'Settings sections'],
    ['mode', 15_000, 21_000, 'Appearance mode is light', { startDark: true }],
    ['unwound', 15_000, 21_000, 'Settings section unwound'],
    ['restored', 15_000, 21_000, 'Account-qualified Rooms route'],
    ['detached', 15_000, 21_000, 'Settings host is detached'],
    // The sheet, the directory and the last key (320–707).
    ['who', 15_000, 21_000, 'one visible Reactions dialog'],
    ['sheet', 15_000, 21_000, 'carries the sheet class'],
    ['close', 15_000, 21_000, 'Reactions dialog is dismissed'],
    ['directory', 15_000, 21_000, 'overflows horizontally'],
    ['detail', 15_000, 21_000, 'scrolls vertically'],
    ['swipe', 15_000, 21_000, 'native swipe advanced the directory'],
    ['lastKey', 15_000, 21_000, 'last key is pressed'],
    ['scrolled', 15_000, 21_000, 'scrolled to the last key'],
    ['lastKeyReactors', 15_000, 21_000, 'lists 1 reactors'],
    ['back', 15_000, 21_000, 'Reactions dialog is dismissed'],
    ['composer', 15_000, 21_000, 'composer'],
  ];
  for (const [key, passAt, failAt, message, extra = {}] of WINDOWS) {
    it(`passes the ${key} window at ${passAt} ms [RF-3]`, async () => {
      await withMobileStage(
        { ...SLOW, ...extra, lag: { [key]: passAt } },
        async ({ context, run }) => {
          await run(context);
          expect(context.records).toEqual(await msRecords());
        },
      );
    }, 240_000);
    it(`fails the ${key} window at ${failAt} ms [RF-3]`, async () => {
      await withMobileStage(
        { ...SLOW, ...extra, lag: { [key]: failAt } },
        async ({ context, state, run }) => {
          await expect(run(context)).rejects.toThrow(fragment(message));
          if (key === 'gate')
            expect(
              state.written.some(({ name }) =>
                name.endsWith('reaction-gate-1'),
              ),
            ).toBe(false);
        },
      );
    }, 240_000);
  }
  it('passes the reactions-arranged window at 25 000 ms [RF-3]', async () => {
    await withMobileStage(
      { ...SLOW, relationsLagMs: 25_000 },
      async ({ context, run }) => {
        await run(context);
        expect(context.records).toHaveLength(103);
      },
    );
  }, 240_000);
  it('fails the reactions-arranged window at 31 000 ms [RF-3]', async () => {
    await withMobileStage(
      { ...SLOW, relationsLagMs: 31_000 },
      async ({ context, run }) => {
        await expect(run(context)).rejects.toThrow(fragment('exactly 36'));
      },
    );
  }, 240_000);
  it('fails the reactions-arranged read-back when every read takes 10 s, which a fresh per-read bound would pass [RF-3]', async () => {
    const faults = { ...SLOW, readMs: 10_000, relationsLagMs: 45_000 };
    await withMobileStage(faults, async ({ context, run }) => {
      await expect(run(context)).rejects.toThrow(fragment('exactly 36'));
    });
    const source = read(JOURNEYS);
    const mutated = source.replace(
      'await proveReactionsArranged(context, a, lastSentAt);\n  const dialog =',
      'await proveReactionsArranged(context, a, Date.now());\n  const dialog =',
    );
    expect(mutated).not.toBe(source);
    await withMutatedJourneys({ journeys: mutated }, (module) =>
      withMobileStage(
        faults,
        async ({ context, run }) => {
          await run(context);
          expect(context.records).toHaveLength(103);
        },
        module,
      ),
    );
  }, 240_000);
  // Step 5 proofs: an anchor taken before its native call makes the 15 000 ms case fail.
  for (const [key, from, to, faults, message] of [
    [
      'mode',
      'await tap(context, \'[data-testid="settings-nav-appearance"]\');\n  const modeAt = await tap(context, `[data-testid="mode-${mode}"]`);',
      'const modeAt = Date.now();\n  await tap(context, \'[data-testid="settings-nav-appearance"]\');\n  await tap(context, `[data-testid="mode-${mode}"]`);',
      { startDark: true },
      'Appearance mode is light',
    ],
    [
      'swipe',
      'await client.device.runFlow(flow, {});\n    const swipedAt = Date.now();',
      'const swipedAt = Date.now();\n    await client.device.runFlow(flow, {});',
      {},
      'native swipe advanced the directory',
    ],
    [
      'lastKey',
      'const lastAt = await tap(context, LAST_KEY);',
      'const lastAt = Date.now();\n  await tap(context, LAST_KEY);',
      {},
      'last key is pressed',
    ],
  ])
    it(`fails the ${key} window at 15 000 ms when its anchor is taken before the native call [RF-3]`, async () => {
      const source = read(JOURNEYS);
      const mutated = source.includes(from)
        ? source.replace(from, to)
        : undefined;
      expect(mutated).toBeDefined();
      await withMutatedJourneys({ journeys: mutated }, (module) =>
        withMobileStage(
          { ...SLOW, ...faults, lag: { [key]: 15_000 } },
          async ({ context, run }) => {
            await expect(run(context)).rejects.toThrow(fragment(message));
          },
          module,
        ),
      );
    }, 240_000);
  for (const [key, failAt, message] of [
    ['final', 31_000, '17'],
    ['sections', 21_000, 'Settings sections'],
    ['lastKey', 21_000, 'last key is pressed'],
    ['composer', 21_000, 'composer'],
  ])
    it(`fails the ${key} window at ${failAt} ms even when every read takes 10 s [RF-3]`, async () => {
      await withMobileStage(
        { ...SLOW, readMs: 10_000, lag: { [key]: failAt } },
        async ({ context, run }) => {
          await expect(run(context)).rejects.toThrow(fragment(message));
        },
      );
    }, 240_000);
});

/* -------------------------------------------------------------------------- */
/* Journeys mutations and AST helpers                                         */
/* -------------------------------------------------------------------------- */

const treeOf = (source) =>
  ts.createSourceFile(JOURNEYS, source, ts.ScriptTarget.Latest, true);

/** Apply source edits (`{ start, end, text }`) from the back, so earlier offsets stay valid. */
function applyEdits(source, edits) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, { start, end, text: replacement }) =>
        `${text.slice(0, start)}${replacement}${text.slice(end)}`,
      source,
    );
}

const allNodes = (tree) => {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return nodes;
};

const statementStartingWith = (prefix, tree) => (node) =>
  ts.isStatement(node) &&
  !ts.isBlock(node) &&
  node.getText(tree).startsWith(prefix);

/** Locate nodes of the journeys by predicate and replace (or delete) their text. */
function editRunner(source, edits) {
  const tree = treeOf(source);
  const nodes = allNodes(tree);
  const found = (predicate) => {
    const node = nodes.find(predicate);
    expect(node, 'mutation target exists').toBeDefined();
    return node;
  };
  const text = (node) => node.getText(tree);
  return applyEdits(
    source,
    edits(found, text, tree).map(([node, replacement]) => ({
      start: node.getStart(tree),
      end: node.getEnd(),
      text: replacement,
    })),
  );
}

/** Import a mutated copy of the journeys (and optionally the contract) from outside the source tree. */
function withMutatedJourneys({ journeys, contract }, run) {
  const journeysPath = resolve(root, JOURNEYS);
  return withMutantModule(
    {
      original: journeysPath,
      source: journeys,
      companions:
        contract === undefined
          ? {}
          : { [resolve(root, CONTRACT_PATH)]: contract },
    },
    run,
  );
}

describe('who-reacted mutant modules', () => {
  it('never place a mutant inside the scanned e2e/android tree', async () => {
    const strays = () =>
      readdirSync(resolve(root, 'e2e/android')).filter((name) =>
        /mutated|probe-order/u.test(name),
      );
    expect(strays()).toEqual([]);
    await withMutatedJourneys(
      { journeys: read(JOURNEYS), contract: read(CONTRACT_PATH) },
      async () => expect(strays()).toEqual([]),
    );
  });
});

describe('Android who-reacted pacing controls [RF-1]', () => {
  const GATE_PREFIXES = [
    'const sentAt = lastSentAt;',
    'const row = await until<ReactionRowObservation>(',
    'await receipt(context, `reaction-gate-',
  ];

  it('fails a run whose sendPacedReactions has no gate: the batch of 36 resets the timeline', async () => {
    const source = read(JOURNEYS);
    const mutated = editRunner(source, (found, text, tree) =>
      GATE_PREFIXES.map((prefix) => [
        found(statementStartingWith(prefix, tree)),
        '',
      ]),
    );
    expect(mutated).not.toBe(source);
    expect(mutated).not.toContain('reaction-gate-');
    await withMutatedJourneys({ journeys: mutated }, async (module) =>
      withSimulatedStage(
        { readMs: 4_000 },
        async ({ context, state, runPillDialog }) => {
          await expect(runPillDialog(context)).rejects.toThrow(
            fragment('One 👍 pill is rendered'),
          );
          expect(state.batches).toEqual([36]);
          expect(state.timelineReset).toBe(true);
        },
        module,
      ),
    );
    // Counter-run: the same journeys pass when the limit is high, so the reset caused the failure.
    await withMutatedJourneys({ journeys: mutated }, async (module) =>
      withSimulatedStage(
        { readMs: 4_000, burstLimit: 40 },
        async ({ context, state, runPillDialog }) => {
          await runPillDialog(context);
          expect(state.batches).toEqual([36]);
          expect(state.timelineReset).toBe(false);
          expect(context.records).toHaveLength(88);
        },
        module,
      ),
    );
  }, 60_000);

  it('fails a run whose REACTION_GROUP is 11 at the first gate: the batch of 11 resets the timeline', async () => {
    const contractSource = read(CONTRACT_PATH);
    const contract = contractSource.replace(
      'export const REACTION_GROUP = 8;',
      'export const REACTION_GROUP = 11;',
    );
    expect(contract).not.toBe(contractSource);
    await withMutatedJourneys(
      { journeys: read(JOURNEYS), contract },
      async (module) =>
        withSimulatedStage(
          { readMs: 4_000 },
          async ({ context, state, runPillDialog }) => {
            await expect(runPillDialog(context)).rejects.toThrow(
              fragment('target row is still rendered'),
            );
            expect(state.batches).toEqual([11]);
            expect(state.timelineReset).toBe(true);
          },
          module,
        ),
    );
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Teardown, must-run steps and redaction                                     */
/* -------------------------------------------------------------------------- */

/** The structure of `runWhoReactedSuite` that the must-run steps depend on (rule d). */
function runnerShape(source) {
  const tree = treeOf(source);
  const runner = allNodes(tree).find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'runWhoReactedSuite',
  );
  expect(runner, 'runWhoReactedSuite is declared').toBeDefined();
  const inside = allNodes(runner);
  const stageCall = 'STAGE_RUNNERS[entry.id](context)';
  const stageTry = inside
    .filter(
      (node) =>
        ts.isTryStatement(node) &&
        node.tryBlock.getText(tree).includes(stageCall),
    )
    .sort((a, b) => a.tryBlock.getWidth(tree) - b.tryBlock.getWidth(tree))[0];
  const tryCalls = stageTry
    ? allNodes(stageTry.tryBlock)
        .filter(ts.isCallExpression)
        .map((node) => node.getText(tree))
    : [];
  const firstDevice = inside.find(
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'openMaestroDevice',
  );
  const outerTry = inside.find(ts.isTryStatement);
  const outerFinally = outerTry?.finallyBlock?.statements.find(
    ts.isIfStatement,
  );
  return {
    finallyFirst: stageTry?.finallyBlock?.statements[0]?.getText(tree),
    tryOrder: tryCalls,
    cleanups: inside
      .filter(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(tree) === 'guardedCleanup' &&
          (!firstDevice || node.getStart(tree) < firstDevice.getStart(tree)),
      )
      .map((node) => node.arguments[0]?.getText(tree).slice(1, -1)),
    outerFinally: outerFinally?.getText(tree),
    throws: allNodes(tree)
      .filter(ts.isThrowStatement)
      .map((node) => node.getText(tree)),
  };
}

const STAGE_THROW = 'throw redactStageFailure(entry.id, failures, secrets);';

function assertRunnerShape(shape) {
  expect(shape.finallyFirst).toBe(
    'if (await finishWhoReactedStage(client, device, failures)) safety.cleanupFailed = true;',
  );
  const positions = [
    'STAGE_RUNNERS[entry.id](context)',
    'assertWhoReactedRecords(entry.id, records)',
    "client.capture('passed')",
  ].map((call) => shape.tryOrder.indexOf(call));
  expect(positions[0]).toBeGreaterThan(-1);
  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(positions[2]).toBeGreaterThan(positions[1]);
  expect(shape.cleanups).toEqual([
    'Scan who-reacted diagnostics',
    'Scrub who-reacted diagnostics',
  ]);
  expect(shape.outerFinally).toBe(
    'if (effectiveSignal.aborted) await revokeOnAbort?.();',
  );
  expect(shape.throws.filter((text) => text === STAGE_THROW)).toHaveLength(1);
  expect(
    shape.throws.filter((text) => /failures|AggregateError/u.test(text)),
  ).toEqual([STAGE_THROW]);
}

describe('Android who-reacted teardown, must-run and redaction guards', () => {
  const RUN = 'runq';
  const READER = {
    userId: '@pd-reader:localhost',
    username: 'pd-reader',
    password: 'reader-Pass-1!',
  };
  const ROOM = { id: '!Who_room:localhost', name: 'Who reacted runq' };
  const EVENT = '$Who_event';

  it('runs close then clear through finishWhoReactedStage, even when close throws', async () => {
    const { finishWhoReactedStage } = await loadJourneys();
    const order = [];
    const client = {
      close: async () => {
        order.push('close');
        throw new Error('close');
      },
    };
    const device = {
      clearApplicationData: async (id) => {
        order.push(`clear:${id}`);
      },
    };
    const failures = [];
    expect(await finishWhoReactedStage(client, device, failures)).toBe(true);
    expect(order).toEqual(['close', 'clear:eu.qwky.trinity']);
    expect(failures).toHaveLength(1);
  });

  it('reports no cleanup failure when both teardown steps succeed', async () => {
    const { finishWhoReactedStage, whoReactedTeardown } = await loadJourneys();
    const failures = [];
    expect(
      await finishWhoReactedStage(
        { close: async () => {} },
        { clearApplicationData: async () => {} },
        failures,
      ),
    ).toBe(false);
    expect(failures).toHaveLength(0);
    expect(
      whoReactedTeardown(
        { close: async () => {} },
        { clearApplicationData: async () => {} },
      ),
    ).toHaveLength(2);
  });

  it('rethrows stage failures to the job log as redacted first lines only', async () => {
    const c = await loadContract();
    const { whoReactedSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = whoReactedSecrets('pill-dialog', {
      accounts: [READER],
      rooms: [ROOM],
      texts: [c.bodyOf(RUN)],
      eventIds: [EVENT],
      transactions: [c.targetTxnOf(RUN)],
    });
    const failure = new AssertionError({
      actual: EVENT,
      expected: '$Who_expected',
      operator: 'strictEqual',
      message: `The row is the proved server event ${EVENT} ${ROOM.id} ${READER.password}`,
    });
    const error = redactStageFailure(
      'pill-dialog',
      [new AggregateError([failure], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error.message).toContain('Android who-reacted pill-dialog failed');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [EVENT, ROOM.id, READER.password, '$Who_expected'])
      expect(error.message).not.toContain(value);
    expect(error.message).not.toContain('actual');
    const [firstLine, ...appended] = failure.message.split('\n');
    expect(error.message.split('\n')).toContain(
      `AssertionError: ${firstLine.replace(EVENT, '[REDACTED]').replace(ROOM.id, '[REDACTED]').replace(READER.password, '[REDACTED]')}`,
    );
    for (const line of appended.map((fragmentLine) => fragmentLine.trim()))
      if (line.length >= 3) expect(error.message).not.toContain(line);
    expect(
      redactCleanupFailure(
        'fixtures',
        Object.assign(new Error(`leave ${ROOM.id}`), { status: 403 }),
      ).message,
    ).toBe('Who-reacted cleanup failed: fixtures (Error HTTP 403)');
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardWhoReactedCleanup } = await loadJourneys();
    const registered = [];
    const state = {
      safety: {
        unsafeSecrets: false,
        cleanupFailed: false,
        scrubFailed: false,
      },
      report: {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      },
      saves: 0,
      async save() {
        this.saves++;
      },
    };
    guardWhoReactedCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    )('Room cleanup', async () => {
      throw new Error(`forget ${ROOM.id}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Who-reacted cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM.id);
    expect(state.saves).toBe(1);
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardWhoReactedCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('keeps every must-run step of the runner in place [rule d]', () => {
    const shape = runnerShape(read(JOURNEYS));
    assertRunnerShape(shape);
    expect(shape.cleanups).toHaveLength(2);
  });

  const FINISH =
    'if (await finishWhoReactedStage(client, device, failures)) safety.cleanupFailed = true;';
  const MUTATIONS = {
    'delete the finishWhoReactedStage statement': (source) =>
      editRunner(source, (found, text, tree) => [
        [found(statementStartingWith(FINISH, tree)), ''],
      ]),
    'move finishWhoReactedStage into the try': (source) =>
      editRunner(source, (found, text, tree) => {
        const finish = found(statementStartingWith(FINISH, tree));
        const stageRun = found(
          statementStartingWith('await STAGE_RUNNERS[entry.id](context)', tree),
        );
        return [
          [finish, ''],
          [stageRun, `${text(stageRun)}\n              ${FINISH}`],
        ];
      }),
    'delete the Scan guardedCleanup registration': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(
            statementStartingWith("guardedCleanup('Scan who-reacted", tree),
          ),
          '',
        ],
      ]),
    'delete the Scrub guardedCleanup registration': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(
            statementStartingWith("guardedCleanup('Scrub who-reacted", tree),
          ),
          '',
        ],
      ]),
    'swap the two guardedCleanup registrations': (source) =>
      editRunner(source, (found, text, tree) => {
        const scan = found(
          statementStartingWith("guardedCleanup('Scan who-reacted", tree),
        );
        const scrub = found(
          statementStartingWith("guardedCleanup('Scrub who-reacted", tree),
        );
        return [
          [scan, text(scrub)],
          [scrub, text(scan)],
        ];
      }),
    'delete the revokeOnAbort line': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(statementStartingWith('if (effectiveSignal.aborted)', tree)),
          '',
        ],
      ]),
    "delete client.capture('passed')": (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(statementStartingWith("await client.capture('passed')", tree)),
          '',
        ],
      ]),
    'delete assertWhoReactedRecords': (source) =>
      editRunner(source, (found, text, tree) => [
        [
          found(
            statementStartingWith(
              'assertWhoReactedRecords(entry.id, records)',
              tree,
            ),
          ),
          '',
        ],
      ]),
    'swap capture with assertWhoReactedRecords': (source) =>
      editRunner(source, (found, text, tree) => {
        const check = found(
          statementStartingWith(
            'assertWhoReactedRecords(entry.id, records)',
            tree,
          ),
        );
        const capture = found(
          statementStartingWith("await client.capture('passed')", tree),
        );
        return [
          [check, text(capture)],
          [capture, text(check)],
        ];
      }),
    'replace the throw line with throw failures[0]': (source) =>
      editRunner(source, (found, text) => [
        [
          found(
            (node) => ts.isThrowStatement(node) && text(node) === STAGE_THROW,
          ),
          'throw failures[0];',
        ],
      ]),
  };
  for (const [name, mutate] of Object.entries(MUTATIONS))
    it(`fails the must-run guard when you ${name}`, () => {
      const source = read(JOURNEYS);
      const mutated = mutate(source);
      expect(mutated).not.toBe(source);
      expect(() => assertRunnerShape(runnerShape(mutated))).toThrow();
    });

  it('keeps every reaction id registered before the next send [rule d]', async () => {
    // Behavioural: the simulated stage snapshots the registration before each send.
    await withSimulatedStage({}, async ({ context, state, runPillDialog }) => {
      await runPillDialog(context);
      expect(state.registeredBeforeSend).toEqual(Array(36).fill(true));
    });
    // Effective mutation: registering the id after its record leaves the next send unregistered.
    const source = read(JOURNEYS);
    const mutated = editRunner(source, (found, text, tree) => {
      const register = found(
        statementStartingWith('protect(context, { eventIds: [id] });', tree),
      );
      return [[register, '']];
    });
    expect(mutated).not.toBe(source);
    await withMutatedJourneys({ journeys: mutated }, (module) =>
      withSimulatedStage(
        { readMs: 4_000 },
        async ({ context, state, runPillDialog }) => {
          await runPillDialog(context).catch(() => undefined);
          expect(state.registeredBeforeSend.includes(false)).toBe(true);
        },
        module,
      ),
    );
  }, 60_000);

  it('registers every pre-UI identifier before the native reset [rule d]', async () => {
    const source = read(JOURNEYS);
    const mutated = editRunner(source, (found, text, tree) => [
      [
        found(
          statementStartingWith(
            'protect(context, { rooms: [{ name: roomName }], texts: [body, longName],',
            tree,
          ),
        ),
        '',
      ],
    ]);
    expect(mutated).not.toBe(source);
    await withMutatedJourneys({ journeys: mutated }, (module) =>
      withSimulatedStage(
        { readMs: 4_000 },
        async ({ context, state, runPillDialog }) => {
          await runPillDialog(context).catch(() => undefined);
          expect(state.secretsAtReset).not.toContain(SIM_BODY);
        },
        module,
      ),
    );
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* Source rules: contract, observer, artifacts and journeys                   */
/* -------------------------------------------------------------------------- */

const BANNED_TOKENS = [
  '.click(',
  '.tap(',
  '.focus(',
  'dispatchEvent',
  '.value =',
  'textContent =',
  '.style.',
  'classList.add',
  'classList.remove',
  'classList.toggle',
  'scrollLeft =',
  'scrollTop =',
  'scrollTo(',
  'scrollBy(',
  'scrollIntoView(',
  'setViewportSize',
  '.resize(',
  'location.',
  'history.',
  '.fill(',
  '.press(',
  'localStorage',
  'Preferences.set',
  'requestSubmit',
  '.submit(',
  'preventDefault',
  'stopPropagation',
  'select(',
  'showReactors',
  'toggleReaction',
  'open$(',
  'new SharedStageAccount(',
  'input_method',
  'dumpsys',
];
/** `view.location.href` is a read-only observation; the bare forms are not. */
const BARE_TOKENS = new Set(['location.', 'history.']);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const tokenPresent = (source, token) =>
  BARE_TOKENS.has(token)
    ? new RegExp(`(^|[^.\\w])${escapeRegExp(token)}`, 'mu').test(source)
    : source.includes(token);

function assertNoBannedTokens(source, name) {
  for (const token of BANNED_TOKENS)
    expect(
      tokenPresent(source, token),
      `${name} must not contain ${token}`,
    ).toBe(false);
}

/** Native input, or a helper that performs one, or a REST send that a window follows. */
const NATIVE_CALLS = new Set([
  'tap',
  'tapCurrent',
  'scrollIntoViewIfNeeded',
  'hideKeyboard',
  'login',
  'reset',
  'runFlow',
  'pressHostBack',
  'swipeDirectory',
  'sendReaction',
  'sendMessage',
  'arrangeStage',
  'openArrangedRoom',
  'enterRoom',
  'sendPacedReactions',
  'revealAndOpenDialog',
]);
const calleeName = (node, tree) =>
  node.expression.getText(tree).split('.').at(-1);
const enclosingFunction = (node) => {
  for (let at = node.parent; at; at = at.parent)
    if (ts.isFunctionDeclaration(at)) return at;
  return undefined;
};
/** Helpers that return the native call's `Date.now()` anchor. */
// `swipeDirectory` returns the swipe count, so its flow is anchored inline by `const swipedAt = Date.now();`.
const ANCHORING_HELPERS = new Set(['tap', 'pressHostBack']);
const DIRECT_NATIVE = ['tapCurrent', 'scrollIntoViewIfNeeded', 'runFlow'];

/**
 * Every direct native tap, scroll or flow either sits in an anchoring helper and is
 * followed by `return Date.now();`, or is followed by `const x = Date.now();` (or by
 * the next anchoring native call, which anchors every later window itself).
 */
function assertTapsAnchorDateNow(source) {
  const tree = treeOf(source);
  let checked = 0;
  for (const node of allNodes(tree)) {
    if (
      !ts.isCallExpression(node) ||
      !DIRECT_NATIVE.includes(calleeName(node, tree))
    )
      continue;
    checked++;
    let statement = node;
    while (statement.parent && !ts.isBlock(statement.parent))
      statement = statement.parent;
    const siblings = statement.parent.statements;
    const next = siblings[siblings.indexOf(statement) + 1];
    const inHelper = ANCHORING_HELPERS.has(
      enclosingFunction(node)?.name?.text ?? '',
    );
    if (inHelper) {
      expect(
        next?.getText(tree),
        `${node.getText(tree)} in its helper is followed by return Date.now()`,
      ).toBe('return Date.now();');
      continue;
    }
    const initializer =
      next && ts.isVariableStatement(next)
        ? next.declarationList.declarations[0].initializer?.getText(tree)
        : undefined;
    expect(
      initializer !== undefined &&
        (initializer === 'Date.now()' ||
          /^await (tap|pressHostBack)\(/u.test(initializer)),
      `${node.getText(tree)} is followed by a Date.now() anchor`,
    ).toBe(true);
  }
  expect(checked, 'the journeys have native calls').toBeGreaterThan(2);
}

/** No window anchor (`left(bound, anchor)`, `server(…, anchor, …)`, `timeoutMs: anchor`) was assigned before a native call it waits on. */
function assertWindowsAnchoredAfterNativeCalls(
  source,
  functionName,
  minimumWindows,
) {
  const tree = treeOf(source);
  const stage = allNodes(tree).find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === functionName,
  );
  expect(stage, `${functionName} is declared`).toBeDefined();
  const inside = allNodes(stage);
  const natives = inside.filter(
    (node) =>
      ts.isCallExpression(node) && NATIVE_CALLS.has(calleeName(node, tree)),
  );
  const declarationOf = (name) =>
    inside.find(
      (node) =>
        ts.isVariableDeclaration(node) && node.name.getText(tree) === name,
    );
  let windows = 0;
  for (const node of inside) {
    const anchors = [];
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'left')
      anchors.push(...allNodes(node.arguments[1]).filter(ts.isIdentifier));
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'proveReactionsArranged'
    )
      anchors.push(...allNodes(node.arguments[2]).filter(ts.isIdentifier));
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'server')
      anchors.push(...allNodes(node.arguments[3]).filter(ts.isIdentifier));
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree) === 'timeoutMs'
    )
      anchors.push(...allNodes(node.initializer).filter(ts.isIdentifier));
    for (const anchor of anchors) {
      const declaration = declarationOf(anchor.text);
      if (!declaration) continue;
      windows++;
      const between = natives.filter(
        (call) =>
          call.getStart(tree) > declaration.getEnd() &&
          call.getEnd() < anchor.getStart(tree),
      );
      expect(
        between.map((call) => call.getText(tree)),
        `the ${anchor.text} anchor is assigned after every native call before its window`,
      ).toEqual([]);
    }
  }
  expect(
    windows,
    `${functionName} has anchored windows`,
  ).toBeGreaterThanOrEqual(minimumWindows);
}

/** Each function that owns windows, with its minimum count of anchored ones. */
const WINDOW_OWNERS = [
  ['runPillDialog', 4],
  ['openArrangedRoom', 1],
  ['enterRoom', 2],
  ['sendPacedReactions', 1],
  ['revealAndOpenDialog', 1],
  ['roundTripAppearance', 5],
  ['swipeDirectory', 1],
  ['runMobileSheet', 5],
];

/** Replace the first `from` inside the named function, so a text repeated in a sibling stage cannot be hit instead. */
function replaceWithin(source, name, from, to) {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0);
  const at = source.indexOf(from, start);
  expect(at, `${from} is inside ${name}`).toBeGreaterThanOrEqual(0);
  return source.slice(0, at) + to + source.slice(at + from.length);
}

describe('Android who-reacted source rules', () => {
  const TARGETS = {
    contract: CONTRACT_PATH,
    observer: OBSERVER_PATH,
    artifacts: 'e2e/android/who-reacted-artifacts.mts',
    journeys: JOURNEYS,
  };

  it('keeps the contract, observer, artifacts and journeys free of every banned token', () => {
    for (const path of Object.values(TARGETS))
      assertNoBannedTokens(read(path), path);
  });

  it('allows the observer read-only view.location.href but not a bare location.', () => {
    expect(read(OBSERVER_PATH)).toContain('view.location.href');
    expect(tokenPresent('const url = view.location.href;', 'location.')).toBe(
      false,
    );
    expect(tokenPresent('  location.assign(x)', 'location.')).toBe(true);
    expect(tokenPresent('(history.back())', 'history.')).toBe(true);
    expect(tokenPresent('window.history.back()', 'history.')).toBe(false);
  });

  it('shows each banned-token rule effective under an in-memory insertion in every source', () => {
    for (const path of Object.values(TARGETS)) {
      const source = read(path);
      for (const token of BANNED_TOKENS)
        expect(
          () => assertNoBannedTokens(`${source}\n${token}`, path),
          `${path} + ${token}`,
        ).toThrow();
    }
  });

  it('anchors every native tap, scroll and flow with a Date.now() capture', () => {
    const journeys = read(JOURNEYS);
    assertTapsAnchorDateNow(journeys);
    const cases = [
      [
        'await client.scrollIntoViewIfNeeded(WHO, TIMELINE, { within });\n  const tappedAt = await tap(context, WHO, { within });',
        'await client.scrollIntoViewIfNeeded(WHO, TIMELINE, { within });\n  await client.hideKeyboard();\n  const tappedAt = await tap(context, WHO, { within });',
      ],
      [
        'await client.scrollIntoViewIfNeeded(WHO, TIMELINE, { within });\n  const tappedAt = await tap(context, WHO, { within });',
        'await client.scrollIntoViewIfNeeded(WHO, TIMELINE, { within });\n  const tappedAt = 0;',
      ],
      [
        'await client.device.runFlow(join(client.workspaceRoot, BACK_FLOW), { APP_ID: APPLICATION_ID });\n  return Date.now();',
        'await client.device.runFlow(join(client.workspaceRoot, BACK_FLOW), { APP_ID: APPLICATION_ID });\n  return 0;',
      ],
      [
        'await context.client.tapCurrent(selector, filter);\n  return Date.now();',
        'await context.client.tapCurrent(selector, filter);\n  return 0;',
      ],
      [
        'await client.device.runFlow(flow, {});\n    const swipedAt = Date.now();',
        'await client.device.runFlow(flow, {});\n    const swipedAt = 0;',
      ],
    ];
    for (const [from, to] of cases) {
      expect(journeys).toContain(from);
      expect(() =>
        assertTapsAnchorDateNow(journeys.replace(from, to)),
      ).toThrow();
    }
    expect(() =>
      assertTapsAnchorDateNow(
        `${journeys}\nasync function sneaky(client: AccountWorkspaceClient): Promise<void> {\n  await client.tapCurrent('x', {});\n}\n`,
      ),
    ).toThrow();
    expect(() =>
      assertTapsAnchorDateNow(
        `${journeys}\nasync function sneaky(client: AccountWorkspaceClient): Promise<void> {\n  await client.device.runFlow('x', {});\n}\n`,
      ),
    ).toThrow();
  });

  it('never anchors a window before a native call or send it waits on', () => {
    const journeys = read(JOURNEYS);
    for (const [name, minimum] of WINDOW_OWNERS)
      assertWindowsAnchoredAfterNativeCalls(journeys, name, minimum);
    const cases = [
      [
        'runPillDialog',
        "const heartAt = await tap(context, KEY, { text: '❤️' });",
        "const heartAt = Date.now();\n  await tap(context, KEY, { text: '❤️' });",
      ],
      [
        'runPillDialog',
        'const backAt = await pressHostBack(context);',
        'const backAt = Date.now();\n  await pressHostBack(context);',
      ],
      [
        'runPillDialog',
        'const lastSentAt = await sendPacedReactions(context, a);',
        'const lastSentAt = Date.now();\n  await sendPacedReactions(context, a);',
      ],
      [
        'runPillDialog',
        'proveReactionsArranged(context, a, lastSentAt)',
        'proveReactionsArranged(context, a, Date.now())',
      ],
      [
        'revealAndOpenDialog',
        'const tappedAt = await tap(context, WHO, { within });',
        'const tappedAt = Date.now();\n  await tap(context, WHO, { within });',
      ],
      [
        'enterRoom',
        "const openedAt = await tap(context, '.channel', { text: a.roomName });",
        "const openedAt = Date.now();\n  await tap(context, '.channel', { text: a.roomName });",
      ],
      [
        'enterRoom',
        'const railAt = await tap(context, RAIL);',
        'const railAt = Date.now();\n  await tap(context, RAIL);',
      ],
      [
        'runMobileSheet',
        'const lastSentAt = await sendPacedReactions(context, a);',
        'const lastSentAt = Date.now();\n  await sendPacedReactions(context, a);',
      ],
      [
        'runMobileSheet',
        'proveReactionsArranged(context, a, lastSentAt)',
        'proveReactionsArranged(context, a, Date.now())',
      ],
      [
        'runMobileSheet',
        'const closeAt = await tap(context, CLOSE);',
        'const closeAt = Date.now();\n  await tap(context, CLOSE);',
      ],
      [
        'runMobileSheet',
        'const lastAt = await tap(context, LAST_KEY);',
        'const lastAt = Date.now();\n  await tap(context, LAST_KEY);',
      ],
      [
        'runMobileSheet',
        'const backAt = await pressHostBack(context);',
        'const backAt = Date.now();\n  await pressHostBack(context);',
      ],
      [
        'roundTripAppearance',
        'const anchor = start.backToRoomsVisible ? await tap(context, \'[data-testid="back-to-rooms"]\') : Date.now();',
        'const anchor = Date.now();\n  if (start.backToRoomsVisible) await tap(context, \'[data-testid="back-to-rooms"]\');',
      ],
      [
        'roundTripAppearance',
        "const sectionsAt = rooms.path.startsWith('/settings') ? Date.now() : await tap(context, '[data-testid=\"open-settings\"]');",
        "const sectionsAt = Date.now();\n  if (!rooms.path.startsWith('/settings')) await tap(context, '[data-testid=\"open-settings\"]');",
      ],
      [
        'roundTripAppearance',
        'await tap(context, \'[data-testid="settings-nav-appearance"]\');\n  const modeAt = await tap(context, `[data-testid="mode-${mode}"]`);',
        'const modeAt = Date.now();\n  await tap(context, \'[data-testid="settings-nav-appearance"]\');\n  await tap(context, `[data-testid="mode-${mode}"]`);',
      ],
      [
        'roundTripAppearance',
        'const modeAt = await tap(context, `[data-testid="mode-${mode}"]`);',
        'const modeAt = Date.now();\n  await tap(context, `[data-testid="mode-${mode}"]`);',
      ],
      [
        'roundTripAppearance',
        'const firstBackAt = await tap(context, SETTINGS_BACK);',
        'const firstBackAt = Date.now();\n  await tap(context, SETTINGS_BACK);',
      ],
      [
        'roundTripAppearance',
        "const restoredAnchor = unwound.path === '/settings' ? await tap(context, SETTINGS_BACK) : Date.now();",
        "const restoredAnchor = Date.now();\n  if (unwound.path === '/settings') await tap(context, SETTINGS_BACK);",
      ],
      [
        'swipeDirectory',
        'await client.device.runFlow(flow, {});\n    const swipedAt = Date.now();',
        'const swipedAt = Date.now();\n    await client.device.runFlow(flow, {});',
      ],
      [
        'openArrangedRoom',
        "await enterRoom(context, a, 'room-open');\n  const readyAt = Date.now();",
        "const readyAt = Date.now();\n  await enterRoom(context, a, 'room-open');",
      ],
      ['sendPacedReactions', '    const sentAt = lastSentAt;\n', ''],
    ];
    for (const [name, from, to] of cases) {
      let mutated = replaceWithin(journeys, name, from, to);
      if (name === 'sendPacedReactions')
        // The gate anchor moves before the group's sends.
        mutated = mutated.replace(
          'for (const entry of plan.slice(start, start + REACTION_GROUP)) {',
          'const sentAt = Date.now();\n    for (const entry of plan.slice(start, start + REACTION_GROUP)) {',
        );
      expect(mutated).not.toBe(journeys);
      const minimum = WINDOW_OWNERS.find(([owner]) => owner === name)[1];
      expect(
        () => assertWindowsAnchoredAfterNativeCalls(mutated, name, minimum),
        `${name}: ${from}`,
      ).toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Hosted wiring, retention and parity ledger                                 */
/* -------------------------------------------------------------------------- */

const WHO_NX_COMMAND =
  '--suite=android.who-reacted --timeout-ms=1500000 --entrypoint=e2e/android/who-reacted-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const WHO_CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'who-reacted-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1800000 -- pnpm exec nx run trinity-e2e-android:who-reacted; fi';
const QUOTE_CI_RUN_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'quote-notification-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:quote-notification; fi';
const WHO_GATE_PATH =
  "-path '*/android.who-reacted/who-reacted/publication-safe'";
const WHO_UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.who-reacted-started == 'true' && steps.who-reacted-artifact-gate.outputs.who-reacted-safe == 'true' }}";

function whoWiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

/** Every hosted wiring rule for who-reacted, as a pure function of the files' text. */
function assertWhoWiring({ project, pkg, workflow }) {
  const target = project.targets['who-reacted'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(WHO_NX_COMMAND);
  expect(pkg.scripts['e2e:android:who-reacted']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:who-reacted',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(WHO_CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  // Shard 3, last: directly after quote-notification's own runner line.
  expect(lines.indexOf(QUOTE_CI_RUN_LINE)).toBeGreaterThan(-1);
  expect(runner).toBe(lines.indexOf(QUOTE_CI_RUN_LINE) + 1);
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:who-reacted')),
  ).toHaveLength(1);
  const gate = workflow
    .split('      - name: Gate Android who-reacted diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: who-reacted-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.who-reacted-started == 'true' }}",
  );
  expect(gate).toContain('WHO_REACTED_DIAGNOSTIC_ROOT');
  expect(gate).toContain(WHO_GATE_PATH);
  expect(gate).toContain('echo \'who-reacted-safe=true\' >> "$GITHUB_OUTPUT"');
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-who-reacted\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${WHO_UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.who-reacted/**',
  );
}

const callsNamed = (source, name) => {
  const tree = ts.createSourceFile(
    'x.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      if (callee === name) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { tree, found };
};

describe('Android who-reacted hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands on shard 3 after quote-notification', async () => {
    assertWhoWiring(whoWiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.who-reacted',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:who-reacted',
      canonicalScript: 'e2e:android:who-reacted',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT_PATH,
      OBSERVER_PATH,
      ARTIFACTS_PATH,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:who-reacted',
      ),
    ).toEqual([
      {
        name: 'e2e:android:who-reacted',
        command: 'nx run trinity-e2e-android:who-reacted',
        kind: 'canonical',
        suiteIds: ['android.who-reacted'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.who-reacted'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:who-reacted',
    );
    const { found } = callsNamed(read(JOURNEYS), 'test');
    expect(found.map((call) => call.getText())).toEqual([
      "test('Android who-reacted journeys', { timeout: 1_500_000 }, runWhoReactedSuite)",
    ]);
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = whoWiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['who-reacted']);
      return inputs;
    };
    const withText = (key, from, to) => {
      const inputs = clone();
      expect(inputs[key]).toContain(from);
      inputs[key] = inputs[key].replace(from, to);
      return inputs;
    };
    for (const mutated of [
      withTarget((target) => (target.cache = true)),
      withTarget((target) => (target.parallelism = true)),
      withTarget((target) => (target.dependsOn = [])),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            ' --resource=synapse',
            '',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            'who-reacted-journeys.mts',
            'quote-notification-journeys.mts',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            '--timeout-ms=1500000',
            '--timeout-ms=150000',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:who-reacted'];
        return inputs;
      })(),
      withText('workflow', WHO_CI_LINE, WHO_CI_LINE.replace('= "3"', '= "4"')),
      withText(
        'workflow',
        WHO_CI_LINE,
        WHO_CI_LINE.replace('1800000', '1200000'),
      ),
      withText('workflow', `${WHO_CI_LINE}\n`, ''),
      withText(
        'workflow',
        WHO_GATE_PATH,
        "-path '*/android.who-reacted/publication-safe'",
      ),
      withText(
        'workflow',
        WHO_UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.who-reacted-started == 'true' }}",
      ),
    ])
      expect(() => assertWhoWiring(mutated)).toThrow();
    // Moved past the shard runner lines: present but wrongly placed.
    const late = clone();
    const lateLines = late.workflow.split('\n');
    const at = lateLines.findIndex((l) => l.trim() === WHO_CI_LINE);
    const [moved] = lateLines.splice(at, 1);
    const retained = lateLines.findIndex((l) =>
      l.includes('pnpm e2e:android --'),
    );
    lateLines.splice(retained + 1, 0, moved);
    late.workflow = lateLines.join('\n');
    expect(() => assertWhoWiring(late)).toThrow();
    // Moved before quote-notification's own runner line: wrongly ordered.
    const before = clone();
    const beforeLines = before.workflow.split('\n');
    const whoAt = beforeLines.findIndex((l) => l.trim() === WHO_CI_LINE);
    const [whoLine] = beforeLines.splice(whoAt, 1);
    const quoteAt = beforeLines.findIndex(
      (l) => l.trim() === QUOTE_CI_RUN_LINE,
    );
    beforeLines.splice(quoteAt, 0, whoLine);
    before.workflow = beforeLines.join('\n');
    expect(() => assertWhoWiring(before)).toThrow();
  });

  it('retires the Android definition and keeps the general one desktop-only', async () => {
    const source = read(PREDECESSOR);
    const tests = callsNamed(source, 'test');
    const skips = callsNamed(source, 'test.skip');
    expect(
      tests.found.map(
        (call) =>
          tests.tree.getLineAndCharacterOfPosition(call.getStart(tests.tree))
            .line + 1,
      ),
    ).toEqual([241, 685]);
    expect(skips.found).toHaveLength(3);
    for (const token of ['test.fixme', 'test.only', 'test.skip(true'])
      expect(source).not.toContain(token);
    expect(source).not.toContain(
      'uses touch selection and native Back to dismiss the reaction sheet',
    );
    expect(source).not.toContain('app.pressBack');
    expect(source).toContain(
      "test.skip(\n      isAndroidE2E,\n      'Android runs this through android.who-reacted (#759).',\n    );",
    );
    expect(source).not.toMatch(/isAndroidE2E\s*\?|if \(isAndroidE2E\)/u);
    expect(source.match(/if \(!isAndroidE2E\)/gu)).toHaveLength(1);
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/reactions-who.spec.mts',
      ),
    ).toHaveLength(1);
    expect(read('e2e/android/playwright.config.mts')).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    const { RETIRED_PREDECESSORS } =
      await import('./retired-playwright-predecessors.mjs');
    expect(
      RETIRED_PREDECESSORS.filter((entry) => entry.path === PREDECESSOR),
    ).toEqual([
      {
        path: PREDECESSOR,
        sha256: SOURCE_SHA256,
        issues: [759],
        deleted: false,
        retired: [
          'uses touch selection and native Back to dismiss the reaction sheet',
        ],
        desktopOnly: [
          'names the reactors on the pill and lists them all in the dialog',
        ],
      },
    ]);
  });

  it('documents the identities, fixture blocks, hashes, redaction sentence and placement prefix', async () => {
    const section = read('e2e/android/MIGRATION.md')
      .split('## Who-reacted journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const c = await loadContract();
    const FIXTURE_HELPERS = new Set(['loginApi', 'joinWithRetry', 'react']);
    const isFixture = (site) =>
      site.kind === 'inherited' &&
      (FIXTURE_HELPERS.has(site.helper) ||
        site.helper === 'seedReactedMessage');
    for (const stage of c.WHO_REACTED_STAGES) {
      const expected = stage.sites
        .filter((site) => !isFixture(site))
        .map((site) => `who-reacted.${stage.id}.${site.suffix}`)
        .sort();
      const documented = [];
      for (const row of section.matchAll(
        /^\| [^|\n]+ \| (pill-dialog|mobile-sheet) \| ([^\n]+) \|$/gmu,
      )) {
        if (row[1] !== stage.id) continue;
        for (const cell of row[2].matchAll(/`(\.?)([^`]+)`/gu))
          documented.push(
            cell[1] ? `who-reacted.${stage.id}.${cell[2]}` : cell[2],
          );
      }
      expect(documented.sort()).toEqual(expected);
    }
    for (const row of [
      '| API logins | `loginApi` 45 via 119 and 130 | `api-login-reader`, `api-login-other-01`–`16` |',
      '| Room | 139 | `room-created` |',
      '| Rate-limited joins | `joinWithRetry` 64 via 142 | `join-other-01`–`16` |',
      '| Target | 149 | `target-sent` |',
      '| Reactions | `react` 169 via 172, 176, 178, 201 | `reaction-01`–`36` |',
    ])
      expect(section).toContain(row);
    const flat = section.replace(/\s+/gu, ' ');
    expect(flat).toContain(
      'The suite records 191 ordered, unique identities: pill-dialog 88 (16 direct + 71 fixture + 1 Room) and mobile-sheet 103 (19 direct + 71 fixture + 3 Room + 10 Settings).',
    );
    expect(section).toContain(SOURCE_SHA256);
    expect(flat).toContain(
      'a failed teardown step is rethrown through `redactStageFailure`, and a failed guarded cleanup is rethrown through `redactCleanupFailure`, never as the raw error.',
    );
    expect(flat).toContain('Shard 3 runs it last, after quote-notification');
    expect(flat).toContain(
      'Predecessor status: retired on 2026-09-30 under [#759](https://github.com/quwisky/trinity-matrix-client/issues/759)',
    );
    expect(section).not.toContain('pnpm exec nx');
  });
});
