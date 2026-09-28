import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readRetiredPredecessor } from './retired-playwright-predecessors.mjs';

const root = resolve(import.meta.dirname, '..');
const predecessor = 'e2e/browser/journeys/conversations/message-swipe.spec.mts';
const NAVIGATION = 'e2e/support/journeys/navigation.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
/**
 * The predecessor's exact bytes at the retired-predecessor commit, which holds
 * the same blob as this branch (the issue's pin), so the pin survives the
 * predecessor's own retirement from the working tree.
 */
const readPredecessor = () =>
  readRetiredPredecessor(predecessor).toString('utf8');
const loadContract = () => import('../e2e/android/message-swipe-contract.mts');
const loadObserver = () => import('../e2e/android/message-swipe-observer.mts');
const loadMotion = () => import('../e2e/android/message-swipe-motion.mts');
const loadPreference = () =>
  import('../e2e/android/message-swipe-preference.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-swipe-artifacts.mts');
const loadJourneys = () => import('../e2e/android/message-swipe-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-swipe-journeys.mts';
const OBSERVER = 'e2e/android/message-swipe-observer.mts';
const MOTION = 'e2e/android/message-swipe-motion.mts';
const PREFERENCE = 'e2e/android/message-swipe-preference.mts';
const ARTIFACTS = 'e2e/android/message-swipe-artifacts.mts';
const CONTRACT = 'e2e/android/message-swipe-contract.mts';

const PREDECESSOR_SHA256 =
  '435f360188e627c7942e29988f62dd4654955317eb23f0980adabea23fd7bdb4';
const SHARED_SHA256 = {
  'e2e/support/journeys/navigation.mts':
    '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
  'e2e/support/touch-platform.mts':
    '8bbf71ffc3e83010599c30ed5c2c347972f5a7b559daa6394613e33af2c43ee1',
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const OPEN_ROOM_SPAN = [41, 156];
const LONG_ROOM_SPAN = [122, 141];
const SWIPE_ROW_SPAN = [158, 172];

/**
 * The design's identity table, verbatim: definition span, the predecessor's
 * `openRoom` arguments (tag, direction, filler), and every record in order as
 * [kind, line, helper?, call?, suffix].
 */
const R = (call, long = false) => [
  ['inherited', 112, 'openRoom', call, 'room-ready'],
  ['inherited', 118, 'openRoom', call, 'encryption-banner'],
  ...(long ? [['inherited', 127, 'openRoom', call, 'history-loaded']] : []),
];
const D = (line, suffix) => ['direct', line, null, null, suffix];
const DRAWER_LOOP = [
  ...R(545),
  D(555, 'drawer-initially-hidden'),
  D(561, 'drawer-opened'),
  D(564, 'drawer-closed'),
];
const STAGES = [
  ['edit-own', [180, 191], ['e', 'right', 0], [...R(184), D(188, 'editing')]],
  [
    'reply-other',
    [193, 205],
    ['r', 'right', 0],
    [...R(197), D(201, 'replying')],
  ],
  [
    'partial-affordance',
    [207, 243],
    ['a', 'right', 0],
    [
      ...R(211),
      D(234, 'own-affordance-visible'),
      D(238, 'own-edit-affordance'),
      D(242, 'other-reply-affordance'),
    ],
  ],
  [
    'progressive-feedback',
    [245, 326],
    ['p', 'right', 0],
    [
      ...R(253),
      D(309, 'partial-opacity-positive'),
      D(311, 'partial-opacity-below-one'),
      D(314, 'armed-opacity-one'),
      D(317, 'armed-scale-changed'),
      D(318, 'armed-colour-changed'),
    ],
  ],
  [
    'off-inert',
    [328, 339],
    ['o', null, 0],
    [...R(333), D(335, 'no-affordance'), D(338, 'no-banner')],
  ],
  [
    'left-direction',
    [341, 365],
    ['l', 'left', 0],
    [...R(345), D(349, 'right-drag-rejected'), D(361, 'left-drag-replying')],
  ],
  [
    'left-strip-geometry',
    [367, 420],
    ['g', 'left', 0],
    [
      ...R(377),
      D(411, 'icon-past-row-end'),
      D(412, 'icon-inside-original-row'),
    ],
  ],
  [
    'vertical-abandon',
    [422, 446],
    ['v', 'right', 30],
    [...R(426, true), D(440, 'no-banner'), D(441, 'no-drag-style')],
  ],
  [
    'vertical-scroll',
    [448, 490],
    ['s', 'right', 30],
    [...R(459, true), D(488, 'timeline-moved'), D(489, 'no-banner')],
  ],
  [
    'edge-dead-zones',
    [492, 535],
    ['d', 'right', 0],
    [
      ...R(500),
      D(508, 'left-edge-no-banner'),
      D(516, 'inset-control-replying'),
      D(523, 'right-edge-drawer-hidden'),
      D(532, 'inset-drawer-visible'),
    ],
  ],
  ['drawer-left', [537, 566], ['l', 'left', 0], DRAWER_LOOP],
  ['drawer-off', [537, 566], ['o', null, 0], DRAWER_LOOP],
  [
    'drawer-right',
    [568, 591],
    ['w', 'right', 0],
    [
      ...R(572),
      D(575, 'drawer-initially-hidden'),
      D(583, 'drawer-opened'),
      D(587, 'row-swipe-suppressed'),
      D(590, 'drawer-closed'),
    ],
  ],
  [
    'live-setting',
    [593, 624],
    ['c', null, 0],
    [
      ...R(599),
      D(600, 'initially-no-affordance'),
      ['inherited', 19, 'openSettingsSection', 605, 'settings-rooms-route'],
      [
        'inherited',
        32,
        'openSettingsSection',
        605,
        'settings-sections-visible',
      ],
      ['inherited', 59, 'openSettingsSection', 605, 'settings-detail-ready'],
      ['inherited', 69, 'closeSettings', 612, 'settings-section-unwound'],
      ['inherited', 84, 'closeSettings', 612, 'rooms-route-restored'],
      ['inherited', 99, 'closeSettings', 612, 'settings-detached'],
      D(613, 'settings-dialog-hidden'),
      D(614, 'no-settings-path'),
      D(621, 'affordance-live'),
    ],
  ],
].map(([id, span, [tag, seed, filler], records]) => ({
  id,
  span,
  tag,
  seed,
  filler,
  records,
  identities: records.map((record) => `message-swipe.${id}.${record[4]}`),
}));
const ALL_IDENTITIES = STAGES.flatMap((stage) => stage.identities);
const STAGE_RECORDS = [3, 3, 5, 7, 4, 4, 4, 5, 5, 6, 5, 5, 6, 12];
const TITLES = {
  'edit-own': 'swiping your own message opens the editor for it',
  'reply-other': "swiping someone else's message starts a reply to it",
  'partial-affordance':
    'shows which action it will take, part-way through the drag',
  'progressive-feedback':
    'the action fades and grows in as the drag approaches committing',
  'off-inert': 'does nothing at all while the setting is off',
  'left-direction': 'follows the direction it was set to, and only that one',
  'left-strip-geometry': 'the affordance waits in the strip the row uncovers',
  'vertical-abandon': 'a drag that turns vertical abandons the action',
  'vertical-scroll': 'a vertical drag still scrolls the timeline',
  'edge-dead-zones': 'refuses to start from either screen edge',
  'drawer-left': 'leaves the drawer gesture working with the setting left',
  'drawer-off': 'leaves the drawer gesture working with the setting off',
  'drawer-right': 'leaves the drawer gesture working',
  'live-setting': 'takes effect as soon as it is changed, with no reload',
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  seedPreference,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsSection,
} from '../../../support/journeys/navigation.mts';
import { cdpSwipe as swipe } from '../../../support/touch-platform.mts';`;

const LINE_PINS = {
  37: "const SWIPE_KEY = 'trinity.message-swipe';",
  38: 'const DRAWER_OPEN_FROM_RIGHT_PX = 44;',
  50: "const runId = `${testResourceId('run')}${tag}`;",
  51: 'const user = `swipeact-${runId}`;',
  53: 'const friend = `swipefr-${runId}`;',
  54: 'const roomName = `Swipe ${runId}`;',
  76: 'data: { name: roomName, invite: [`@${friend}:localhost`] },',
  86: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/o-${runId}`,',
  89: "data: { msgtype: 'm.text', body: `theirs ${runId}` },",
  93: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/m-${runId}`,',
  94: "{ headers: auth, data: { msgtype: 'm.text', body: `mine ${runId}` } },",
  98: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/f-${runId}-${i}`,',
  99: "{ headers: auth, data: { msgtype: 'm.text', body: `filler ${i}` } },",
  104: 'await seedPreference(page, SWIPE_KEY, direction);',
  108: "await page.getByTestId('rail-rooms').click();",
  109: "const channel = page.locator('.channel', { hasText: roomName });",
  111: 'await channel.first().click();',
  112: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  113: 'timeout: 20_000,',
  119: "page.locator('trn-banner').getByText('Set up encryption'),",
  120: ').toBeVisible();',
  122: 'if (filler > 0) {',
  127: 'await expect',
  131: ".locator('.msg[data-mid]', { hasText: `mine ${runId}` })",
  147: "const row = page.locator('.msg[data-mid]', { hasText: body }).last();",
  164: 'await row.scrollIntoViewIfNeeded();',
  169: '{ x: box.x + box.width * 0.35, y },',
  170: '{ x: box.x + box.width * 0.95, y },',
  174: "test.use({ ...devices['Pixel 5'] });",
  184: "const { own } = await openRoom(page, request, 'e', 'right');",
  186: 'await swipeRow(page, own);',
  188: "await expect(page.locator('.composer__banner')).toContainText('Editing', {",
  197: "const { other } = await openRoom(page, request, 'r', 'right');",
  201: "await expect(page.locator('.composer__banner')).toContainText(",
  211: "const { own, other } = await openRoom(page, request, 'a', 'right');",
  227: '{ x: box.x + box.width * 0.4, y },',
  228: '{ x: box.x + box.width * 0.5, y },',
  232: 'await halfway(own);',
  233: 'const ownIcon = page.locator(`${own} .msg__swipe`);',
  234: 'await expect(ownIcon).toBeVisible();',
  238: "await expect(ownIcon).toHaveAttribute('data-swipe-action', 'edit');",
  240: 'await halfway(other);',
  241: 'const otherIcon = page.locator(`${other} .msg__swipe`);',
  242: "await expect(otherIcon).toHaveAttribute('data-swipe-action', 'reply');",
  253: "const { other } = await openRoom(page, request, 'p', 'right');",
  269: 'let currentX = box.x + box.width * 0.35;',
  308: 'await at(box.x + box.width * 0.55);',
  309: 'await expect.poll(async () => (await shown()).opacity).toBeGreaterThan(0);',
  311: 'expect(partly.opacity).toBeLessThan(1);',
  313: 'await at(box.x + box.width * 0.95);',
  314: 'await expect.poll(async () => (await shown()).opacity).toBe(1);',
  317: 'expect(committed.scale).not.toBe(partly.scale);',
  318: 'expect(committed.colour).not.toBe(partly.colour);',
  333: "const { own } = await openRoom(page, request, 'o', null);",
  335: 'await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(0);',
  336: 'await swipeRow(page, own);',
  338: "await expect(page.locator('.composer__banner')).toHaveCount(0);",
  345: "const { other } = await openRoom(page, request, 'l', 'left');",
  348: 'await swipeRow(page, other);',
  349: "await expect(page.locator('.composer__banner')).toHaveCount(0);",
  357: '{ x: box.x + box.width * 0.8, y },',
  358: '{ x: box.x + box.width * 0.1, y },',
  361: "await expect(page.locator('.composer__banner')).toContainText(",
  377: "const { other } = await openRoom(page, request, 'g', 'left');",
  386: 'touchPoints: [{ x: before.x + before.width * 0.8, y, id: 1 }],',
  388: 'const fromX = before.x + before.width * 0.8;',
  389: 'const toX = before.x + before.width * 0.5;',
  405: 'const icon = (await page',
  406: '.locator(`${other} .msg__swipe trn-icon`)',
  411: 'expect(iconCentre).toBeGreaterThan(moved.x + moved.width);',
  412: 'expect(iconCentre).toBeLessThan(before.x + before.width);',
  426: "const { other } = await openRoom(page, request, 'v', 'right', 30);",
  436: '{ x: box.x + box.width * 0.35, y: box.y + box.height / 2 },',
  437: '{ x: box.x + box.width * 0.95, y: box.y + box.height / 2 - 150 },',
  440: "await expect(page.locator('.composer__banner')).toHaveCount(0);",
  444: ".evaluate((el) => el.style.getPropertyValue('--swipe-drag')),",
  454: 'isAndroidE2E,',
  459: "const { other } = await openRoom(page, request, 's', 'right', 30);",
  477: 'const distance = before > 1 ? 100 : -100;',
  481: '{ x: box.x + box.width * 0.5, y: box.y + box.height / 2 },',
  484: 'y: box.y + box.height / 2 + distance,',
  488: 'await expect.poll(scrollTop, { timeout: 5_000 }).not.toBe(before);',
  489: "await expect(page.locator('.composer__banner')).toHaveCount(0);",
  500: "const { other } = await openRoom(page, request, 'd', 'right');",
  507: 'await swipe(page, { x: 4, y }, { x: size.width * 0.8, y });',
  508: "await expect(page.locator('.composer__banner')).toHaveCount(0);",
  515: 'await swipe(page, { x: 80, y }, { x: size.width * 0.85, y });',
  516: "await expect(page.locator('.composer__banner')).toContainText(",
  522: 'await swipe(page, { x: size.width - 4, y }, { x: size.width * 0.2, y });',
  523: "await expect(page.locator('.chat-members')).toBeHidden();",
  529: '{ x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },',
  532: "await expect(page.locator('.chat-members')).toBeVisible({",
  537: "for (const setting of ['left', 'off'] as const) {",
  545: 'await openRoom(',
  548: 'setting[0],',
  549: "setting === 'off' ? null : setting,",
  553: 'const y = size.height / 2;',
  555: 'await expect(members).toBeHidden();',
  558: '{ x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },',
  559: '{ x: size.width * 0.3, y },',
  561: 'await expect(members).toBeVisible({ timeout: 10_000 });',
  563: 'await swipe(page, { x: size.width * 0.4, y }, { x: size.width - 4, y });',
  564: 'await expect(members).toBeHidden({ timeout: 10_000 });',
  572: "const { other } = await openRoom(page, request, 'w', 'right');",
  575: 'await expect(members).toBeHidden();',
  580: '{ x: size.width - DRAWER_OPEN_FROM_RIGHT_PX, y },',
  581: '{ x: size.width * 0.3, y },',
  583: 'await expect(members).toBeVisible({ timeout: 10_000 });',
  587: 'await expect(page.locator(`${other} .msg__swipe`)).toHaveCount(0);',
  589: 'await swipe(page, { x: size.width * 0.4, y }, { x: size.width - 4, y });',
  590: 'await expect(members).toBeHidden({ timeout: 10_000 });',
  599: "const { own, roomName } = await openRoom(page, request, 'c', null);",
  600: 'await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(0);',
  604: "await page.getByTestId('back-to-rooms').click();",
  605: "await openSettingsSection(page, 'appearance');",
  606: "await page.getByTestId('message-swipe-select').locator('button').click();",
  607: "await page.getByTestId('message-swipe-right').click();",
  612: 'await closeSettings(page);',
  613: "await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();",
  614: 'expect(new URL(page.url()).pathname).not.toMatch(/\\/settings/);',
  616: "await page.getByTestId('rail-rooms').click();",
  617: "const channel = page.locator('.channel', { hasText: roomName });",
  619: 'await channel.first().click();',
  621: 'await expect(page.locator(`${own} .msg__swipe`)).toHaveCount(1, {',
};

/* ------------------------------------------------------------------------ */
/* Predecessor AST analysis                                                  */
/* ------------------------------------------------------------------------ */

const parse = (source, name = predecessor) =>
  ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const endLineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

/** `expect(…)` and `expect.poll(…)` are both assertion sites. */
const isAssertion = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text === 'expect') ||
    (ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'expect' &&
      node.expression.name.text === 'poll'));

function assertionLines(source, start, end, name = predecessor) {
  const tree = parse(source, name);
  const lines = [];
  const visit = (node) => {
    if (isAssertion(node)) {
      const line = lineOf(tree, node);
      if (line >= start && line <= end) lines.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

/**
 * The desktop spans of every `if (isAndroidE2E)` in a range, read from the
 * AST: an `else` block, or, after an Android block that ends in `return`, the
 * rest of its enclosing block.
 */
function desktopSpans(source, [from, to], name = predecessor) {
  const tree = parse(source, name);
  const spans = [];
  const visit = (node) => {
    if (
      ts.isIfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'isAndroidE2E' &&
      lineOf(tree, node) >= from &&
      lineOf(tree, node) <= to
    ) {
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
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return spans;
}

/** Lines inside `if (filler > 0)`: reached only by a long-Room call. */
function conditionalSpans(source, [from, to], name = predecessor) {
  const tree = parse(source, name);
  const spans = [];
  const visit = (node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(tree) === 'filler > 0' &&
      lineOf(tree, node) >= from &&
      lineOf(tree, node) <= to
    )
      spans.push([lineOf(tree, node), endLineOf(tree, node)]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return spans;
}

const repositoryPath = (from, specifier) =>
  posix.normalize(posix.join(posix.dirname(from), specifier));

/**
 * Resolve every call through the TypeChecker. A call binds to a helper only
 * when its symbol is a named import or a module-level function declaration, so
 * a shadowing local of the same name never expands.
 */
function boundCalls(source, fileName = predecessor) {
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
      const call = {
        name: node.expression.text,
        line: lineOf(tree, node),
        args: node.arguments.map((argument) => argument.getText(tree)),
      };
      if (declaration && ts.isImportSpecifier(declaration))
        calls.push({
          ...call,
          name: (declaration.propertyName ?? declaration.name).text,
          specifier: declaration.parent.parent.parent.moduleSpecifier.text,
        });
      else if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        ts.isSourceFile(declaration.parent)
      )
        calls.push({ ...call, specifier: null });
      else if (declaration) shadowed.push(call);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { calls, shadowed };
}

const inside = (line, spans) =>
  spans.some(([from, to]) => line >= from && line <= to);

/**
 * Every assertion line a helper reaches along its Android path, following
 * module-local and relative-import calls; `conditional` marks a long-Room line.
 */
function helperExpectLines(
  module,
  name,
  source = module === predecessor ? readPredecessor() : read(module),
  seen = new Set(),
) {
  const key = `${module}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const tree = parse(source, module);
  const declaration = tree.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) return [];
  const span = [lineOf(tree, declaration), endLineOf(tree, declaration)];
  const desktop = desktopSpans(source, span, module);
  const conditional = conditionalSpans(source, span, module);
  const own = assertionLines(source, ...span, module)
    .filter((line) => !inside(line, desktop))
    .map((line) => ({ module, line, conditional: inside(line, conditional) }));
  const nested = boundCalls(source, module)
    .calls.filter(
      (call) =>
        call.line >= span[0] &&
        call.line <= span[1] &&
        !inside(call.line, desktop),
    )
    .flatMap((call) =>
      call.specifier === null
        ? helperExpectLines(module, call.name, source, seen)
        : call.specifier.startsWith('.')
          ? helperExpectLines(
              repositoryPath(module, call.specifier),
              call.name,
              undefined,
              seen,
            )
          : [],
    );
  return [...own, ...nested].sort((a, b) => a.line - b.line);
}

/** A literal filler argument above zero selects the long-Room lines. */
const longRoomCall = (call) => Number(call.args[4] ?? 0) > 0;

/**
 * Expand one definition's Android path into parity sites: direct assertions
 * and binding-resolved helper calls, with every desktop span excluded.
 */
function expandDefinition(source, span) {
  const [from, to] = span;
  const desktop = desktopSpans(source, span);
  const inherited = boundCalls(source)
    .calls.filter(
      (call) =>
        call.line >= from &&
        call.line <= to &&
        !inside(call.line, desktop) &&
        (call.specifier === null ||
          call.specifier.startsWith('../../../support/')),
    )
    .flatMap((call) =>
      helperExpectLines(
        call.specifier === null
          ? predecessor
          : repositoryPath(predecessor, call.specifier),
        call.name,
        call.specifier === null ? source : undefined,
      )
        .filter((site) => !site.conditional || longRoomCall(call))
        .map(({ line }) => ['inherited', line, call.name, call.line]),
    );
  const direct = assertionLines(source, from, to)
    .filter((line) => !inside(line, desktop))
    .map((line) => ['direct', line, null, null]);
  const key = (site) =>
    site[0] === 'direct' ? [site[1], 1, 0] : [site[3], 0, site[1]];
  return [...inherited, ...direct].sort((a, b) => {
    const [left, right] = [key(a), key(b)];
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
}

const ledger = (stage) => stage.records.map((record) => record.slice(0, 4));
const contractTuple = (site) =>
  site.kind === 'direct'
    ? ['direct', site.line, null, null]
    : ['inherited', site.line, site.helper, site.call];
const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(626);
  expect(source.split('\n').slice(0, 21).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  for (const stage of STAGES)
    if (stage.id === 'drawer-left' || stage.id === 'drawer-off')
      expect(lineAt(source, stage.span[0] + 1)).toBe(
        'test(`leaves the drawer gesture working with the setting ${setting}`, async ({',
      );
    else
      expect(
        lineAt(source, stage.span[0]).match(/^test\((['"])(.+)\1, async/u)?.[2],
        stage.id,
      ).toBe(TITLES[stage.id]);
  expect(source.match(/^ {2}test\(/gmu)).toHaveLength(12);
  expect(source.match(/^ {4}test\(/gmu)).toHaveLength(1);
  // Outside the definitions and the Room helper, nothing asserts.
  expect(assertionLines(source, 1, OPEN_ROOM_SPAN[0] - 1)).toEqual([]);
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([112, 118, 127]);
  expect(assertionLines(source, ...SWIPE_ROW_SPAN)).toEqual([]);
  expect(conditionalSpans(source, OPEN_ROOM_SPAN)).toEqual([LONG_ROOM_SPAN]);
  // The only platform branch is the compositor definition's Android skip.
  expect(desktopSpans(source, [1, 626])).toEqual([]);
  expect(lineAt(source, 453)).toBe('test.skip(');
  for (const stage of STAGES) {
    expect(expandDefinition(source, stage.span), stage.id).toEqual(
      ledger(stage),
    );
    const call = boundCalls(source).calls.find(
      (entry) =>
        entry.name === 'openRoom' &&
        entry.line >= stage.span[0] &&
        entry.line <= stage.span[1],
    );
    expect(call, stage.id).toBeDefined();
    const [tag, seed, filler = '0'] = call.args
      .slice(2)
      .map((arg) => arg.trim());
    if (stage.id === 'drawer-left' || stage.id === 'drawer-off') {
      expect([tag, seed]).toEqual([
        'setting[0]',
        "setting === 'off' ? null : setting",
      ]);
    } else {
      expect(tag).toBe(`'${stage.tag}'`);
      expect(seed).toBe(stage.seed === null ? 'null' : `'${stage.seed}'`);
    }
    expect(Number(filler)).toBe(stage.filler);
  }
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-swipe predecessor pins', () => {
  it('pins the predecessor and the four shared helper sources by SHA-256', () => {
    expect(sha256(readRetiredPredecessor(predecessor))).toBe(
      PREDECESSOR_SHA256,
    );
    // The branch copy is the same pinned blob until the coordinator retires it.
    if (
      existsSync(resolve(root, predecessor)) &&
      read(predecessor).includes(
        "test('a vertical drag still scrolls the timeline'",
      )
    )
      expect(digest(predecessor)).toBe(PREDECESSOR_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path), path).toBe(hash);
    const flipped = Buffer.from(readRetiredPredecessor(predecessor));
    flipped[flipped.length - 2] ^= 1;
    expect(sha256(flipped)).not.toBe(PREDECESSOR_SHA256);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('pins the same sources and spans in the contract', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_SWIPE_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_SWIPE_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_SWIPE_SOURCE_LINES).toBe(626);
    expect(contract.MESSAGE_SWIPE_SHARED_SOURCE_SHA256).toEqual(SHARED_SHA256);
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_SWIPE_SPANS).toEqual({
      constants: span([35, 38]),
      openRoom: span(OPEN_ROOM_SPAN),
      longRoom: span(LONG_ROOM_SPAN),
      swipeRow: span(SWIPE_ROW_SPAN),
      definitions: Object.fromEntries(
        STAGES.map((stage) => [stage.id, span(stage.span)]),
      ),
    });
    expect(contract.SWIPE_PREFERENCE_KEY).toBe('trinity.message-swipe');
    expect(contract.DRAWER_OPEN_FROM_RIGHT_PX).toBe(44);
    expect(contract.LONG_ROOM_FILLER).toBe(30);
    // The product dead zone the edge stage is about.
    expect(
      read('libs/feature/rooms/src/lib/message-row/message-row.component.ts'),
    ).toContain(
      `export const SWIPE_DEAD_ZONE_PX = ${contract.SWIPE_DEAD_ZONE_PX};`,
    );
    expect(contract.SWIPE_DEAD_ZONE_PX).toBe(56);
    // D8: the right-edge start stays inside the dead zone, 8 px of margin at least.
    expect(contract.RIGHT_EDGE_START_INSET_PX).toBe(24);
    expect(contract.RIGHT_EDGE_START_INSET_PX).toBeLessThanOrEqual(
      contract.SWIPE_DEAD_ZONE_PX - 8,
    );
    const run = 'trn-x-e';
    expect([
      contract.swipeRoomName(run),
      contract.ownBody(run),
      contract.otherBody(run),
      contract.fillerBody(3),
      contract.otherTransaction(run),
      contract.ownTransaction(run),
      contract.fillerTransaction(run, 3),
    ]).toEqual([
      `Swipe ${run}`,
      `mine ${run}`,
      `theirs ${run}`,
      'filler 3',
      `o-${run}`,
      `m-${run}`,
      `f-${run}-3`,
    ]);
  });

  it('keeps the predecessor enabled and unchanged in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-swipe.spec.mts',
      ),
    ).toHaveLength(1);
  });

  it('maps every Android-path direct and helper site of the fourteen definitions', () => {
    assertPredecessorShape(readPredecessor());
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = readPredecessor();
    const mutations = [
      // A predecessor field or template drifts.
      mutateLine(source, 37, (line) => line.replace('message-swipe', 'swipe')),
      mutateLine(source, 38, (line) => line.replace('44', '40')),
      mutateLine(source, 54, (line) => line.replace('Swipe ', 'Swipes ')),
      mutateLine(source, 89, (line) => line.replace('theirs', 'their')),
      mutateLine(source, 94, (line) => line.replace('mine', 'my')),
      mutateLine(source, 170, (line) => line.replace('0.95', '0.9')),
      mutateLine(source, 228, (line) => line.replace('0.5', '0.6')),
      mutateLine(source, 308, (line) => line.replace('0.55', '0.6')),
      mutateLine(source, 389, (line) => line.replace('0.5', '0.4')),
      mutateLine(source, 437, (line) => line.replace('150', '50')),
      mutateLine(source, 507, (line) => line.replace('x: 4,', 'x: 60,')),
      mutateLine(source, 515, (line) => line.replace('80', '60')),
      // An arrangement changes: seed, tag or filler.
      mutateLine(source, 184, (line) => line.replace("'right'", "'left'")),
      mutateLine(source, 333, (line) => line.replace('null', "'off'")),
      mutateLine(source, 426, (line) => line.replace(', 30)', ')')),
      mutateLine(source, 197, (line) => line.replace("'r'", "'x'")),
      // A direct site is dropped, added or moved.
      mutateLine(source, 318, () => '      void committed;'),
      mutateLine(
        source,
        339,
        (line) => `${line}\n    await expect(page).toHaveTitle('x');`,
      ),
      mutateLine(source, 334, (line) => `${line}\n`),
      // The long-Room condition, the Room helper or a navigation helper drifts.
      mutateLine(source, 122, () => '  if (filler >= 0) {'),
      mutateLine(
        source,
        118,
        () => '  await page.locator("trn-banner").waitFor();',
      ),
      mutateLine(source, 612, () => '    await page.goBack();'),
      source.replace(
        "test('a vertical drag still scrolls the timeline'",
        "test('a vertical drag scrolls'",
      ),
      source.replace(
        "import { cdpSwipe as swipe } from '../../../support/touch-platform.mts';",
        "import { cdpSwipe as swipe, touchSwipe } from '../../../support/touch-platform.mts';",
      ),
    ];
    for (const [index, mutated] of mutations.entries()) {
      expect(mutated, `mutation ${index}`).not.toBe(source);
      expect(
        () => assertPredecessorShape(mutated),
        `mutation ${index}`,
      ).toThrow();
    }
  });
});

describe('Android message-swipe helper expansion by binding', () => {
  it('resolves module-local and imported helper calls through the TypeChecker', () => {
    const calls = boundCalls(readPredecessor()).calls.filter(
      (call) =>
        call.specifier === null ||
        call.specifier.startsWith('../../../support/'),
    );
    const names = [...new Set(calls.map((call) => call.name))].sort();
    expect(names).toEqual([
      'cdpSwipe',
      'closeSettings',
      'login',
      'openRoom',
      'openSettingsSection',
      'registerUser',
      'seedPreference',
      'swipeRow',
      'synapseSession',
    ]);
    expect(
      calls.filter((call) => call.name === 'openRoom').map((call) => call.line),
    ).toEqual([
      184, 197, 211, 253, 333, 345, 377, 426, 459, 500, 545, 572, 599,
    ]);
  });

  it('follows helpers along their Android branch and proves the non-asserting helpers add no sites', () => {
    const source = readPredecessor();
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 112, conditional: false },
      { module: predecessor, line: 118, conditional: false },
      { module: predecessor, line: 127, conditional: true },
    ]);
    expect(
      helperExpectLines(NAVIGATION, 'openSettingsSection').map(
        (site) => site.line,
      ),
    ).toEqual([19, 32, 59]);
    expect(
      helperExpectLines(NAVIGATION, 'closeSettings').map((site) => site.line),
    ).toEqual([69, 84, 99]);
    for (const [module, name] of [
      [predecessor, 'swipeRow'],
      ['e2e/support/app.mts', 'login'],
      ['e2e/support/app.mts', 'seedPreference'],
      ['e2e/support/account.mts', 'registerUser'],
      ['e2e/support/touch-platform.mts', 'cdpSwipe'],
    ])
      expect(
        helperExpectLines(
          module,
          name,
          module === predecessor ? source : undefined,
        ),
        name,
      ).toEqual([]);
    // The desktop path of each navigation helper holds sites of its own.
    const navigation = read(NAVIGATION);
    expect(desktopSpans(navigation, [11, 45], NAVIGATION)).toEqual([[37, 44]]);
    expect(desktopSpans(navigation, [63, 106], NAVIGATION)).toEqual([
      [104, 105],
    ]);
    expect(assertionLines(navigation, 37, 44, NAVIGATION)).toEqual([41, 44]);
    expect(assertionLines(navigation, 104, 105, NAVIGATION)).toEqual([105]);
  });

  it('excludes a shadowing local helper, the desktop branch and a short Room, against a naive count', () => {
    const source = readPredecessor();
    const span = STAGES.find((stage) => stage.id === 'edit-own').span;
    const shadowed = source.replace(
      "    const { own } = await openRoom(page, request, 'e', 'right');",
      "    const openRoom = async (..._args: unknown[]) => ({ own: '' });\n    const { own } = await openRoom(page, request, 'e', 'right');",
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = boundCalls(shadowed);
    expect(locals.filter((call) => call.name === 'openRoom')).toHaveLength(1);
    expect(
      calls.filter((call) => call.name === 'openRoom' && call.line <= 192),
    ).toHaveLength(0);
    expect(expandDefinition(shadowed, [span[0], span[1] + 1])).toEqual([
      ['direct', 189, null, null],
    ]);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
    // Without branch selection the desktop navigation adds three sites.
    expect(assertionLines(read(NAVIGATION), 11, 106, NAVIGATION)).toEqual([
      19, 32, 41, 44, 59, 69, 84, 99, 105,
    ]);
    expect(expandDefinition(source, STAGES.at(-1).span)).toHaveLength(12);
    // Without the long-Room condition every Room call would add line 127.
    const unconditional = STAGES.flatMap((stage) =>
      helperExpectLines(predecessor, 'openRoom', source).map(() => stage.id),
    );
    expect(unconditional).toHaveLength(42);
    expect(
      STAGES.flatMap((stage) => expandDefinition(source, stage.span)).filter(
        (site) => site[2] === 'openRoom',
      ),
    ).toHaveLength(30);
  });

  it('matches the contract sites, identities, arrangements and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = readPredecessor();
    expect(contract.MESSAGE_SWIPE_STAGES.map((stage) => stage.id)).toEqual(
      STAGES.map((stage) => stage.id),
    );
    for (const [index, stage] of STAGES.entries()) {
      const entry = contract.MESSAGE_SWIPE_STAGES[index];
      expect(entry.sites.map(contractTuple), stage.id).toEqual(
        expandDefinition(source, stage.span),
      );
      expect(entry.sites.map(contractTuple), stage.id).toEqual(ledger(stage));
      expect(entry.assertions).toEqual(stage.identities);
      expect(entry.expectedAssertionRecords).toBe(STAGE_RECORDS[index]);
      expect(entry.title).toBe(TITLES[stage.id]);
      expect(entry.source).toBe(
        `${predecessor}:${stage.span[0]}-${stage.span[1]}`,
      );
      expect(entry.arrangement).toEqual({
        tag: stage.tag,
        seed: stage.seed,
        filler: stage.filler,
      });
    }
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_SWIPE_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ).map((site) => site.line),
      ).toEqual(expectLines);
    expect(
      Object.fromEntries(
        Object.entries(contract.MESSAGE_SWIPE_HELPERS).map(([name, value]) => [
          name,
          value.role,
        ]),
      ),
    ).toEqual({
      openRoom: 'room-readiness',
      openSettingsSection: 'native-settings-open',
      closeSettings: 'native-settings-close',
    });
  });
});

describe('Android message-swipe contract ledger', () => {
  it('owns fourteen stages, 38 direct + 36 inherited = 74 unique identities', async () => {
    const contract = await loadContract();
    const sites = contract.MESSAGE_SWIPE_STAGES.flatMap((stage) => stage.sites);
    expect(sites).toHaveLength(74);
    expect(sites.filter((site) => site.kind === 'direct')).toHaveLength(38);
    expect(sites.filter((site) => site.kind === 'inherited')).toHaveLength(36);
    expect(
      contract.MESSAGE_SWIPE_STAGES.map((stage) => stage.assertions.length),
    ).toEqual(STAGE_RECORDS);
    expect(STAGE_RECORDS.reduce((sum, count) => sum + count, 0)).toBe(74);
    expect(new Set(ALL_IDENTITIES).size).toBe(74);
    expect(
      contract.MESSAGE_SWIPE_STAGES.flatMap((stage) => stage.assertions),
    ).toEqual(ALL_IDENTITIES);
    expect(contract.MESSAGE_SWIPE_HELPER_COUNTS).toEqual({
      openRoom: 30,
      openSettingsSection: 3,
      closeSettings: 3,
    });
  });

  it('resolves identities and rejects out-of-order, foreign and parity-named receipts', async () => {
    const contract = await loadContract();
    expect(contract.messageSwipeAssertion('edit-own', 'editing')).toBe(
      'message-swipe.edit-own.editing',
    );
    expect(() =>
      contract.messageSwipeAssertion('edit-own', 'replying'),
    ).toThrow();
    expect(() =>
      contract.assertMessageSwipeRecords(
        'edit-own',
        STAGES[0].identities.slice(0, 2),
      ),
    ).toThrow();
    expect(() =>
      contract.assertMessageSwipeRecords(
        'edit-own',
        [...STAGES[0].identities].reverse(),
      ),
    ).toThrow();
    contract.assertMessageSwipeRecords('edit-own', STAGES[0].identities);
    for (const name of ['message-swipe-x', 'Room', 'a_b', ''])
      expect(() => contract.assertMessageSwipeReceiptName(name)).toThrow();
    contract.assertMessageSwipeReceiptName('arranged-room');
  });
});

/* ------------------------------------------------------------------------ */
/* Pure record proofs and their negative controls                            */
/* ------------------------------------------------------------------------ */

const ROOM = '!Swipe_Ab+c/d:localhost';
const SENDER = '@trn_swipe_actor_0a1b2c:localhost';
const FRIEND = '@trn_swipe_friend_0a1b2c:localhost';
const OWN_ID = '$Own_A+b/C=d';
const OTHER_ID = '$Other_E+f/G=h';
const RUN = 'trn-swipe-edit-own-0a1b2ce';
const OWN = `mine ${RUN}`;
const OTHER = `theirs ${RUN}`;
const ROOM_NAME = `Swipe ${RUN}`;
const box = (left, top, right, bottom) => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});
const affordance = (overrides = {}) => ({
  count: 0,
  action: null,
  end: false,
  visible: false,
  opacity: null,
  color: null,
  scale: null,
  icon: null,
  ...overrides,
});
const row = (body, overrides = {}) => ({
  body,
  matches: 1,
  exactEvent: true,
  reconciled: true,
  visible: true,
  box: box(0, 300, 393, 360),
  drag: '',
  progress: '',
  swiping: false,
  armed: false,
  affordance: affordance(),
  ...overrides,
});
const view = (overrides = {}) => ({
  href: `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}`,
  timeOrigin: 1000,
  innerWidth: 393,
  innerHeight: 727,
  rows: [row(OWN), row(OTHER)],
  banners: [],
  composer: {
    count: 1,
    visible: true,
    value: '',
    placeholder: `Message #${ROOM_NAME}`,
  },
  encryptionBanners: 1,
  drawer: { count: 1, visible: false, box: null },
  scroll: {
    count: 1,
    scrollTop: 164,
    scrollHeight: 2000,
    clientHeight: 500,
    box: box(0, 56, 393, 640),
  },
  settings: {
    hosts: 0,
    dialogs: 0,
    sectionsVisible: false,
    detailNonEmpty: false,
    backButtons: 0,
  },
  ...overrides,
});
const withRow = (body, overrides, base = view()) => ({
  ...base,
  rows: base.rows.map((entry) =>
    entry.body === body ? { ...entry, ...overrides } : entry,
  ),
});
const pointer = (type, x, y, overrides = {}) => ({
  type,
  trusted: true,
  pointerType: 'touch',
  pointerId: 7,
  clientX: x,
  clientY: y,
  timeStamp: 10,
  ...overrides,
});
const PLAN = { from: { x: 137.55, y: 330 }, to: { x: 373.35, y: 330 } };
const path = (count = 10) =>
  Array.from({ length: count }, (_, index) =>
    pointer(
      'pointermove',
      PLAN.from.x + ((PLAN.to.x - PLAN.from.x) * (index + 1)) / count,
      330,
      {
        timeStamp: 20 + index,
      },
    ),
  );
const gesture = (ending = 'pointerup') => [
  pointer('pointerdown', 138, 330),
  ...path(),
  ...(ending ? [pointer(ending, 373, 330, { timeStamp: 40 })] : []),
];

describe('Android message-swipe record proofs (negative controls)', () => {
  it('proves native gesture ownership and rejects every renderer, mouse, off-plan, pathless or released form', async () => {
    const { assertNativeGesture } = await loadContract();
    expect(assertNativeGesture(gesture(), PLAN, 'up')).toMatchObject({
      moves: 10,
      durationMs: 30,
    });
    assertNativeGesture(gesture(null), PLAN, 'held');
    assertNativeGesture(gesture('pointercancel'), PLAN, 'cancel');
    assertNativeGesture(gesture('pointercancel'), PLAN, 'up-or-cancel');
    for (const [events, ending] of [
      [gesture().map((event) => ({ ...event, trusted: false })), 'up'],
      [
        gesture().map((event, index) =>
          index === 3 ? { ...event, trusted: false } : event,
        ),
        'up',
      ],
      [gesture().map((event) => ({ ...event, pointerType: 'mouse' })), 'up'],
      [
        gesture().map((event, index) =>
          index === 0 ? { ...event, clientX: 150 } : event,
        ),
        'up',
      ],
      [
        [pointer('pointerdown', 138, 330), pointer('pointerup', 373, 330)],
        'up',
      ],
      [
        [
          pointer('pointerdown', 138, 330),
          ...path(10).slice(0, 3),
          pointer('pointerup', 200, 330),
        ],
        'up',
      ],
      [gesture(), 'held'],
      [gesture('pointercancel'), 'up'],
      [gesture(null), 'up'],
      [[...gesture(), pointer('pointerdown', 138, 330)], 'up'],
      [
        gesture().map((event, index) =>
          index === 4 ? { ...event, pointerId: 8 } : event,
        ),
        'up',
      ],
      [[], 'up'],
    ])
      expect(() => assertNativeGesture(events, PLAN, ending)).toThrow();
  });

  it('keeps every gesture inside the product long-press window, proves a held pan and pins the applied profile', async () => {
    const c = await loadContract();
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.ts',
    );
    expect(row).toContain(`const LONG_PRESS_MS = ${c.LONG_PRESS_MS};`);
    expect(row).toContain(
      `const LONG_PRESS_SLOP_PX = ${c.LONG_PRESS_SLOP_PX};`,
    );
    expect(c.assertNativeGesture(gesture(), PLAN, 'up').windowMs).toBe(10);
    // The first move past the slop lands after the long press would fire.
    const late = gesture().map((event, index) =>
      index === 0 ? event : { ...event, timeStamp: event.timeStamp + 600 },
    );
    expect(() => c.assertNativeGesture(late, PLAN, 'up')).toThrow(
      /long-press/u,
    );
    // A creeping held path that never leaves the slop.
    const creep = [
      pointer('pointerdown', 138, 330),
      pointer('pointermove', 140, 330, { timeStamp: 20 }),
      pointer('pointermove', 142, 330, { timeStamp: 30 }),
    ];
    expect(() =>
      c.assertNativeGesture(
        creep,
        { from: PLAN.from, to: { x: 142, y: 330 } },
        'held',
      ),
    ).toThrow(/long-press/u);
    // A held pan: the platform takes the pointer while the finger stays down.
    const pan = [
      pointer('pointerdown', 138, 330),
      ...path(3),
      pointer('pointercancel', 208, 330, { timeStamp: 40 }),
    ];
    expect(c.assertNativeGesture(pan, PLAN, 'held-pan').moves).toBe(3);
    c.assertNativeGesture(gesture(null), PLAN, 'held-pan');
    // Chromium cancels the pointer the moment it takes the pan, so one
    // trusted move before the cancel is enough to prove the native stream.
    const onemovePan = [
      pointer('pointerdown', 138, 330),
      ...path(1),
      pointer('pointercancel', 373, 330, { timeStamp: 40 }),
    ];
    expect(c.assertNativeGesture(onemovePan, PLAN, 'held-pan').moves).toBe(1);
    // A cancelled or either-ended gesture still needs a path of moves.
    const pathless = [
      pointer('pointerdown', 138, 330),
      pointer('pointercancel', 138, 330, { timeStamp: 40 }),
    ];
    expect(() => c.assertNativeGesture(pathless, PLAN, 'cancel')).toThrow();
    expect(() =>
      c.assertNativeGesture(pathless, PLAN, 'up-or-cancel'),
    ).toThrow();
    for (const events of [
      pathless, // a held-pan stream with no move at all before the cancel
      [...pan.slice(0, -1), pointer('pointerup', 208, 330, { timeStamp: 40 })],
      [...pan, pointer('pointermove', 220, 330, { timeStamp: 50 })],
    ])
      expect(() => c.assertNativeGesture(events, PLAN, 'held-pan')).toThrow();
    // The held (unpanned) ending still needs an interpolated path of two moves.
    expect(() =>
      c.assertNativeGesture(
        [pointer('pointerdown', 138, 330), ...path(1)],
        PLAN,
        'held',
      ),
    ).toThrow();
    // The stage runs at Pixel 5 metrics on the Android platform.
    const applied = {
      innerWidth: 393,
      innerHeight: 727,
      devicePixelRatio: 2.750000149011612,
      coarsePointer: true,
      hoverNone: true,
      platform: 'android',
    };
    c.assertAppliedProfile(applied);
    for (const drift of [
      { innerWidth: 1280 },
      { innerHeight: 720 },
      { devicePixelRatio: 1 },
      { coarsePointer: false },
      { hoverNone: false },
      { platform: 'web' },
    ])
      expect(() => c.assertAppliedProfile({ ...applied, ...drift })).toThrow();
    expect(() => c.assertAppliedProfile(null)).toThrow();
  });

  it('binds Edit to our own body and Reply to the other Account, with an empty composer', async () => {
    const { assertEditing, assertReplying } = await loadContract();
    const editing = view({
      banners: [{ text: 'Editing message', strong: null }],
      composer: { ...view().composer, value: OWN },
    });
    assertEditing(editing, OWN);
    const replying = view({
      banners: [{ text: 'Replying to swipefr', strong: 'swipefr' }],
    });
    assertReplying(replying, 'swipefr');
    for (const wrong of [
      view({
        banners: [{ text: 'Editing message', strong: null }],
        composer: { ...view().composer, value: OTHER },
      }),
      view({ banners: [{ text: 'Editing message', strong: null }] }),
      view({
        banners: [{ text: 'Replying to swipefr', strong: 'swipefr' }],
        composer: { ...view().composer, value: OWN },
      }),
      { ...editing, banners: [...editing.banners, ...editing.banners] },
    ])
      expect(() => assertEditing(wrong, OWN)).toThrow();
    for (const wrong of [
      view({ banners: [{ text: 'Replying to swipeact', strong: 'swipeact' }] }),
      view({
        banners: [{ text: 'Replying to swipefr', strong: 'swipefr' }],
        composer: { ...view().composer, value: OWN },
      }),
      view({ banners: [{ text: 'Editing message', strong: null }] }),
      view(),
    ])
      expect(() => assertReplying(wrong, 'swipefr')).toThrow();
  });

  it('proves partial and progressive feedback while the pointer is down, and rejects 0 or 1 part-way, unarmed, unchanged scale or colour', async () => {
    const c = await loadContract();
    const partly = affordance({
      count: 1,
      action: 'reply',
      visible: true,
      opacity: 0.799,
      color: 'oklch(0.43 0.018 265)',
      scale: '0.93166',
    });
    const armed = affordance({
      count: 1,
      action: 'reply',
      visible: true,
      opacity: 1,
      color: 'oklch(0.47 0.19 275)',
      scale: '1',
    });
    const held = withRow(OTHER, {
      drag: '77px',
      progress: '0.799',
      swiping: true,
      affordance: partly,
    });
    expect(c.assertHeldPartial(held, OTHER, 1)).toBe(77);
    expect(c.assertPartialOpacityPositive(held, OTHER)).toBe(0.799);
    expect(c.assertPartialOpacityBelowOne(held, OTHER)).toBe(0.799);
    c.assertArmedOpacityOne(
      withRow(OTHER, { swiping: true, armed: true, affordance: armed }),
      OTHER,
    );
    c.assertScaleChanged(partly, armed);
    c.assertColourChanged(partly, armed);
    expect(() =>
      c.assertPartialOpacityPositive(
        withRow(OTHER, { affordance: { ...partly, opacity: 0 } }),
        OTHER,
      ),
    ).toThrow();
    expect(() =>
      c.assertPartialOpacityBelowOne(
        withRow(OTHER, { affordance: { ...partly, opacity: 1 } }),
        OTHER,
      ),
    ).toThrow();
    expect(() =>
      c.assertArmedOpacityOne(
        withRow(OTHER, { armed: false, affordance: armed }),
        OTHER,
      ),
    ).toThrow();
    expect(() =>
      c.assertArmedOpacityOne(
        withRow(OTHER, { armed: true, affordance: partly }),
        OTHER,
      ),
    ).toThrow();
    expect(() =>
      c.assertScaleChanged(partly, { ...armed, scale: partly.scale }),
    ).toThrow();
    expect(() =>
      c.assertColourChanged(partly, { ...armed, color: partly.color }),
    ).toThrow();
    // A released pointer carries no drag: the held proofs reject it.
    expect(() =>
      c.assertHeldPartial(withRow(OTHER, { affordance: partly }), OTHER, 1),
    ).toThrow();
    expect(() =>
      c.assertHeldPartial(
        withRow(OTHER, { drag: '-77px', swiping: true, affordance: partly }),
        OTHER,
        1,
      ),
    ).toThrow();
    expect(() =>
      c.assertHeldPartial(
        withRow(OTHER, {
          drag: '77px',
          swiping: true,
          armed: true,
          affordance: partly,
        }),
        OTHER,
        1,
      ),
    ).toThrow();
    const own = withRow(OWN, {
      affordance: affordance({
        count: 1,
        action: 'edit',
        visible: true,
        opacity: 0.2,
      }),
    });
    c.assertAffordanceVisible(own, OWN);
    c.assertAffordanceAction(own, OWN, 'edit');
    expect(() => c.assertAffordanceAction(own, OWN, 'reply')).toThrow();
    expect(() =>
      c.assertAffordanceVisible(
        withRow(OWN, { affordance: affordance({ count: 1 }) }),
        OWN,
      ),
    ).toThrow();
  });

  it('proves Off, Left, the trailing strip and abandonment, and rejects each loss', async () => {
    const c = await loadContract();
    c.assertNoAffordance(view(), OWN);
    expect(() =>
      c.assertNoAffordance(
        withRow(OWN, { affordance: affordance({ count: 1 }) }),
        OWN,
      ),
    ).toThrow();
    c.assertNoBanner(view());
    expect(() =>
      c.assertNoBanner(
        view({ banners: [{ text: 'Replying to x', strong: 'x' }] }),
      ),
    ).toThrow();
    // The trailing strip: the row moved left; the icon sits right of its end, inside the original row.
    const before = box(0, 300, 393, 360);
    const strip = withRow(OTHER, {
      drag: '-118px',
      swiping: true,
      box: box(-118, 300, 275, 360),
      affordance: affordance({
        count: 1,
        end: true,
        visible: true,
        icon: box(330, 318, 354, 342),
      }),
    });
    expect(c.assertIconPastRowEnd(strip, OTHER)).toBe(342);
    expect(c.assertIconInsideOriginal(strip, OTHER, before)).toBe(342);
    expect(c.assertHeldPartial(strip, OTHER, -1)).toBe(-118);
    const atStart = withRow(OTHER, {
      box: box(-118, 300, 275, 360),
      affordance: affordance({
        count: 1,
        end: false,
        icon: box(8, 318, 32, 342),
      }),
    });
    expect(() => c.assertIconPastRowEnd(atStart, OTHER)).toThrow();
    const outside = withRow(OTHER, {
      box: box(-118, 300, 275, 360),
      affordance: affordance({
        count: 1,
        end: true,
        icon: box(390, 318, 414, 342),
      }),
    });
    expect(() => c.assertIconInsideOriginal(outside, OTHER, before)).toThrow();
    const notEnd = withRow(OTHER, {
      box: box(-118, 300, 275, 360),
      affordance: affordance({
        count: 1,
        end: false,
        icon: box(330, 318, 354, 342),
      }),
    });
    expect(() => c.assertIconInsideOriginal(notEnd, OTHER, before)).toThrow();
    c.assertNoDragStyle(view(), OTHER);
    c.assertRowSettled(view(), OTHER);
    expect(() =>
      c.assertNoDragStyle(withRow(OTHER, { drag: '12px' }), OTHER),
    ).toThrow();
    expect(() =>
      c.assertRowSettled(withRow(OTHER, { swiping: true }), OTHER),
    ).toThrow();
  });

  it('proves real vertical movement and rejects an unchanged offset', async () => {
    const c = await loadContract();
    expect(
      c.assertTimelineMoved(
        view({ scroll: { ...view().scroll, scrollTop: 595 } }),
        164,
      ),
    ).toBe(595);
    expect(() => c.assertTimelineMoved(view(), 164)).toThrow();
    expect(() =>
      c.assertTimelineMoved(
        view({ scroll: { ...view().scroll, scrollTop: null } }),
        164,
      ),
    ).toThrow();
  });

  it('proves the drawer opens and closes, and the row gesture stays off over it', async () => {
    const c = await loadContract();
    c.assertDrawerHidden(view());
    const open = view({
      drawer: { count: 1, visible: true, box: box(100, 0, 393, 727) },
    });
    c.assertDrawerVisible(open);
    expect(() => c.assertDrawerHidden(open)).toThrow();
    expect(() => c.assertDrawerVisible(view())).toThrow();
    expect(() =>
      c.assertDrawerVisible(
        view({ drawer: { count: 2, visible: true, box: null } }),
      ),
    ).toThrow();
    c.assertNoAffordance(open, OTHER);
    expect(() =>
      c.assertNoAffordance(
        withRow(OTHER, { affordance: affordance({ count: 1 }) }, open),
        OTHER,
      ),
    ).toThrow();
  });

  it('proves the live update without reload and rejects a changed document or a missing affordance', async () => {
    const c = await loadContract();
    const live = withRow(OWN, {
      affordance: affordance({ count: 1, action: 'edit' }),
    });
    c.assertAffordanceLive(live, OWN);
    c.assertSameDocument(live, 1000);
    expect(() =>
      c.assertSameDocument({ ...live, timeOrigin: 2000 }, 1000),
    ).toThrow();
    expect(() => c.assertAffordanceLive(view(), OWN)).toThrow();
    expect(() =>
      c.assertAffordanceLive(
        withRow(OWN, {
          exactEvent: false,
          affordance: affordance({ count: 1 }),
        }),
        OWN,
      ),
    ).toThrow();
    c.assertSeededPreference(
      { present: true, value: 'right', effective: 'right' },
      'right',
    );
    c.assertSeededPreference(
      { present: false, value: null, effective: 'off' },
      null,
    );
    for (const [observation, seed] of [
      [{ present: true, value: 'left', effective: 'left' }, 'right'],
      [{ present: false, value: null, effective: 'off' }, 'right'],
      [{ present: true, value: 'right', effective: 'right' }, null],
      [{ present: true, value: null, effective: 'invalid' }, 'right'],
    ])
      expect(() => c.assertSeededPreference(observation, seed)).toThrow();
    const settings = view({
      href: 'https://localhost/settings/appearance',
      settings: {
        hosts: 1,
        dialogs: 0,
        sectionsVisible: true,
        detailNonEmpty: true,
        backButtons: 1,
      },
    });
    c.assertSettingsSections(settings);
    c.assertSettingsDetail(settings, 'appearance');
    expect(() => c.assertSettingsDetached(settings)).toThrow();
    expect(() => c.assertNoSettingsPath(settings)).toThrow();
    expect(() => c.assertSettingsDetail(settings, 'notifications')).toThrow();
    c.assertNoSettingsPath(view());
    c.assertSettingsDetached(view());
    c.assertSettingsDialogHidden(view());
    c.assertAccountRooms(view().href, SENDER);
    expect(() =>
      c.assertAccountRooms('https://localhost/rooms', SENDER),
    ).toThrow();
  });

  it('proves the exact Room, route and rows before any gesture', async () => {
    const c = await loadContract();
    const identity = { name: ROOM_NAME, roomId: ROOM, userId: SENDER };
    c.assertRoomReady(view(), identity);
    c.assertEncryptionBanner(view());
    c.assertTargetRows(view(), [OWN, OTHER]);
    c.assertHistoryLoaded(view(), OWN);
    for (const wrong of [
      view({ composer: { ...view().composer, placeholder: 'Message #Other' } }),
      view({ href: view().href.replace('account=', 'account=x') }),
      view({ composer: { ...view().composer, count: 2 } }),
    ])
      expect(() => c.assertRoomReady(wrong, identity)).toThrow();
    expect(() =>
      c.assertEncryptionBanner(view({ encryptionBanners: 0 })),
    ).toThrow();
    expect(() =>
      c.assertHistoryLoaded(withRow(OWN, { matches: 0 }), OWN),
    ).toThrow();
    for (const overrides of [
      { exactEvent: false },
      { reconciled: false },
      { visible: false },
      { matches: 0 },
    ])
      expect(() =>
        c.assertTargetRows(withRow(OTHER, overrides), [OWN, OTHER]),
      ).toThrow();
    expect(() => c.parseSwipeView({ ...view(), rows: 'x' })).toThrow();
    expect(() =>
      c.parseSwipeView({
        ...view(),
        composer: { ...view().composer, count: -1 },
      }),
    ).toThrow();
    expect(c.parseSwipeView(JSON.parse(JSON.stringify(view())))).toEqual(
      view(),
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Native motion, Preference and the read-only observer                     */
/* ------------------------------------------------------------------------ */

/** A fake client whose device records every adb call. */
function fakeMotionClient() {
  const calls = [];
  return {
    calls,
    signal: new AbortController().signal,
    device: {
      async adb(...args) {
        calls.push(args);
        return '';
      },
    },
  };
}
const RECT = { x: 0, y: 56, width: 393, height: 584 };
const NATIVE = { topLeft: { x: 1, y: 155 }, bottomRight: { x: 1079, y: 1759 } };

describe('Android message-swipe native motion', () => {
  it('maps CSS points with a uniform measured transform and refuses points outside the timeline', async () => {
    const { deviceMapFrom } = await loadMotion();
    const map = deviceMapFrom(RECT, NATIVE);
    expect(map.toDevice({ x: 0.5, y: 56.5 })).toEqual({ x: 1, y: 155 });
    expect(map.toDevice({ x: 392.5, y: 639.5 })).toEqual({ x: 1079, y: 1759 });
    expect(map.factorX).toBeCloseTo(2.75, 2);
    for (const point of [
      { x: -1, y: 300 },
      { x: 394, y: 300 },
      { x: 100, y: 20 },
      { x: Number.NaN, y: 300 },
    ])
      expect(() => map.toDevice(point)).toThrow();
    expect(() =>
      deviceMapFrom(RECT, { ...NATIVE, bottomRight: { x: 1079, y: 1300 } }),
    ).toThrow();
    expect(() =>
      deviceMapFrom(RECT, { ...NATIVE, bottomRight: { x: 0, y: 0 } }),
    ).toThrow();
  });

  it('builds one device command of Android input motionevents with the predecessor ten-step path', async () => {
    const { linearPath, motionCommand } = await loadMotion();
    const steps = linearPath({ x: 0, y: 10 }, { x: 100, y: 10 });
    expect(steps).toHaveLength(10);
    expect(steps[0]).toEqual({ x: 10, y: 10 });
    expect(steps.at(-1)).toEqual({ x: 100, y: 10 });
    expect(
      motionCommand([
        { phase: 'down', css: { x: 0, y: 0 }, device: { x: 10, y: 20 } },
        { phase: 'move', css: { x: 1, y: 0 }, device: { x: 13, y: 20 } },
        { phase: 'up', css: { x: 1, y: 0 }, device: { x: 13, y: 20 } },
      ]),
    ).toBe(
      'input motionevent DOWN 10 20; input motionevent MOVE 13 20; input motionevent UP 13 20',
    );
    expect(() =>
      motionCommand([
        { phase: 'down', css: { x: 0, y: 0 }, device: { x: 1.5, y: 2 } },
      ]),
    ).toThrow();
    expect(() => motionCommand([])).toThrow();
    expect(() => linearPath({ x: 0, y: 0 }, { x: 1, y: 1 }, 1)).toThrow();
  });

  it('holds, moves and releases one pointer, and cancels a still-held pointer on dispose', async () => {
    const { NativeTouch, deviceMapFrom } = await loadMotion();
    const client = fakeMotionClient();
    const touch = new NativeTouch(client, deviceMapFrom(RECT, NATIVE));
    await touch.press({ x: 100, y: 300 }, { x: 200, y: 300 });
    expect(touch.held).toBe(true);
    const [shell, pressed] = client.calls[0];
    expect(shell).toBe('shell');
    expect(pressed.split('; ')).toHaveLength(11);
    expect(pressed).toMatch(
      /^input motionevent DOWN \d+ \d+; input motionevent MOVE/u,
    );
    expect(pressed).not.toMatch(/UP|CANCEL/u);
    await expect(
      touch.press({ x: 1, y: 300 }, { x: 2, y: 300 }),
    ).rejects.toThrow();
    await touch.moveTo({ x: 350, y: 300 });
    expect(client.calls[1][1]).not.toMatch(/DOWN|UP|CANCEL/u);
    await touch.release();
    expect(client.calls[2][1]).toMatch(/^input motionevent UP \d+ \d+$/u);
    expect(touch.held).toBe(false);
    await touch.dispose();
    expect(client.calls).toHaveLength(3);
    await touch.swipe({ x: 100, y: 300 }, { x: 350, y: 300 });
    expect(client.calls[3][1].split('; ')).toHaveLength(12);
    expect(client.calls[3][1]).toMatch(/UP \d+ \d+$/u);
    await touch.press({ x: 100, y: 300 }, { x: 120, y: 300 });
    await touch.dispose();
    expect(client.calls.at(-1)[1]).toMatch(
      /^input motionevent CANCEL \d+ \d+$/u,
    );
    expect(touch.held).toBe(false);
    // press, move, release, swipe, press; the cancel bypasses the log.
    expect(touch.log).toHaveLength(5);
  });
});

const PREFERENCES = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="trinity.appearance.mode">dark</string>
    <boolean name="flag" value="true" />
    <string name="trinity.message-swipe">left</string>
</map>
`;

describe('Android message-swipe native Preference', () => {
  it('reads the stored direction strictly and treats an absent entry as the product default Off', async () => {
    const { parseNativeSwipePreference } = await loadPreference();
    expect(parseNativeSwipePreference(PREFERENCES)).toEqual({
      present: true,
      value: 'left',
      effective: 'left',
    });
    expect(
      parseNativeSwipePreference("<?xml version='1.0' ?>\n<map />\n"),
    ).toEqual({
      present: false,
      value: null,
      effective: 'off',
    });
    expect(
      parseNativeSwipePreference(PREFERENCES.replace('>left<', '>sideways<')),
    ).toEqual({
      present: true,
      value: null,
      effective: 'invalid',
    });
    for (const unsafe of [
      PREFERENCES.replace('<map>', '<!DOCTYPE map [<!ENTITY x "y">]>\n<map>'),
      PREFERENCES.replace('</map>', ''),
      PREFERENCES.replace(
        '<boolean name="flag" value="true" />',
        '<boolean name="trinity.message-swipe" value="true" />',
      ),
      PREFERENCES.replace(
        '</map>',
        '    <string name="trinity.message-swipe">right</string>\n</map>',
      ),
      PREFERENCES.replace('<map>', '<other>').replace('</map>', '</other>'),
    ])
      expect(() => parseNativeSwipePreference(unsafe)).toThrow();
    // A parse failure never echoes the document.
    try {
      parseNativeSwipePreference(
        PREFERENCES.replace('</map>', '<string name="x">syt_secret'),
      );
    } catch (error) {
      expect(String(error.message)).not.toContain('syt_secret');
    }
  });

  it('rewrites exactly the swipe entry and keeps every other entry byte for byte', async () => {
    const { parseNativeSwipePreference, withSwipePreference } =
      await loadPreference();
    const right = withSwipePreference(PREFERENCES, 'right');
    expect(parseNativeSwipePreference(right).value).toBe('right');
    expect(
      right
        .replace('>right<', '>left<')
        .replace(
          /\n {4}<string name="trinity\.message-swipe">left<\/string>/u,
          '',
        ),
    ).toBe(
      PREFERENCES.replace(
        /\n {4}<string name="trinity\.message-swipe">left<\/string>/u,
        '',
      ),
    );
    expect(right).toContain(
      '<string name="trinity.appearance.mode">dark</string>',
    );
    const removed = withSwipePreference(PREFERENCES, null);
    expect(parseNativeSwipePreference(removed)).toEqual({
      present: false,
      value: null,
      effective: 'off',
    });
    expect(removed).not.toContain('trinity.message-swipe');
    expect(
      parseNativeSwipePreference(
        withSwipePreference("<?xml version='1.0' ?>\n<map />\n", 'left'),
      ).value,
    ).toBe('left');
  });

  it('seeds only with the app stopped, never passes the document as an argument, and reads it back', async () => {
    const { seedNativeSwipePreference } = await loadPreference();
    const calls = [];
    let stored = PREFERENCES;
    let pushed;
    const device = {
      async adb(...args) {
        calls.push(args);
        if (args[0] === 'push') pushed = readFileSync(args[1], 'utf8');
        if (args[0] === 'shell' && /mv shared_prefs/u.test(args[1] ?? ''))
          stored = pushed;
        if (
          args[0] === 'shell' &&
          /cat shared_prefs\/CapacitorStorage\.xml;/u.test(args[1] ?? '')
        )
          return stored;
        return '';
      },
    };
    const observed = await seedNativeSwipePreference(
      device,
      'eu.qwky.trinity',
      'right',
    );
    expect(observed).toEqual({
      present: true,
      value: 'right',
      effective: 'right',
    });
    expect(calls[0]).toEqual(['shell', 'am', 'force-stop', 'eu.qwky.trinity']);
    expect(calls.findIndex((call) => call[0] === 'push')).toBeGreaterThan(0);
    for (const call of calls)
      for (const argument of call)
        expect(String(argument)).not.toContain('<map');
    expect(calls.some((call) => call.includes('rm'))).toBe(true);
    const source = read(PREFERENCE);
    expect(source).not.toMatch(
      /console\.|JSON\.stringify\(xml|\$\{xml\}|\$\{next\}/u,
    );
  });
});

/** A jsdom conversation with measured boxes and computed styles. */
function swipeWindow(options = {}) {
  const rowHtml = (id, body, extra = '') =>
    `<div class="msg" data-mid="${id}" style="${extra}"><p>${body}</p>${
      options.affordance === id
        ? `<span class="msg__swipe${options.end ? ' msg__swipe--end' : ''}" data-swipe-action="reply"><trn-icon></trn-icon></span>`
        : ''
    }</div>`;
  const html = `<main><div class="scroll">
    <div class="msg msg--event" data-mid="$state"><p>${OWN} created</p></div>
    ${rowHtml(options.ownId ?? OWN_ID, OWN)}
    ${rowHtml(OTHER_ID, OTHER, options.drag ? `--swipe-drag: ${options.drag}` : '')}
  </div>
  <textarea data-testid="composer-input" placeholder="Message #${ROOM_NAME}"></textarea>
  ${options.banner ? `<div class="composer__banner">Replying to <strong>swipefr</strong></div>` : ''}
  <trn-banner>Set up encryption</trn-banner>
  <aside class="chat-members" ${options.drawer ? '' : 'style="display:none"'}></aside></main>`;
  const { window } = new JSDOM(html, {
    url: 'https://localhost/rooms/x?account=y',
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (/display:\s*none/u.test(this.getAttribute('style') ?? ''))
      return { ...box(0, 0, 0, 0), x: 0, y: 0 };
    if (this.matches('.scroll'))
      return { ...box(0, 56, 393, 640), x: 0, y: 56 };
    return { ...box(0, 300, 393, 360), x: 0, y: 300 };
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => ({
    ...computed(element),
    visibility: 'visible',
    display: /display:\s*none/u.test(element.getAttribute('style') ?? '')
      ? 'none'
      : 'block',
    opacity: element.matches('.msg__swipe') ? '0.5' : '1',
    color: 'oklch(0.43 0.018 265)',
    scale: element.matches('trn-icon') ? '0.93' : 'none',
  });
  return window;
}

describe('Android message-swipe read-only observer (jsdom)', () => {
  it('observes the exact rows by body and in-page event comparison, skipping system lines', async () => {
    const { swipeViewExpression } = await loadObserver();
    const { parseSwipeView } = await loadContract();
    const targets = [
      { body: OWN, eventId: OWN_ID },
      { body: OTHER, eventId: OTHER_ID },
    ];
    const window = swipeWindow({
      affordance: OTHER_ID,
      drag: '77px',
      end: true,
      banner: true,
      drawer: true,
    });
    const observed = parseSwipeView(
      JSON.parse(
        JSON.stringify(
          runInNewContext(swipeViewExpression(targets), {
            document: window.document,
          }),
        ),
      ),
    );
    const own = observed.rows[0];
    expect(own).toMatchObject({
      matches: 1,
      exactEvent: true,
      reconciled: true,
      visible: true,
      drag: '',
    });
    expect(own.affordance.count).toBe(0);
    const other = observed.rows[1];
    expect(other).toMatchObject({ drag: '77px', exactEvent: true });
    expect(other.affordance).toMatchObject({
      count: 1,
      action: 'reply',
      end: true,
      opacity: 0.5,
      scale: '0.93',
    });
    expect(observed.banners).toEqual([
      { text: 'Replying to swipefr', strong: 'swipefr' },
    ]);
    expect(observed.composer).toMatchObject({
      count: 1,
      value: '',
      placeholder: `Message #${ROOM_NAME}`,
    });
    expect(observed.encryptionBanners).toBe(1);
    expect(observed.drawer.visible).toBe(true);
    // Another event with the same body is not the arranged one.
    const moved = swipeWindow({ ownId: '$Elsewhere' });
    const other2 = parseSwipeView(
      JSON.parse(
        JSON.stringify(
          runInNewContext(swipeViewExpression(targets), {
            document: moved.document,
          }),
        ),
      ),
    );
    expect(other2.rows[0].exactEvent).toBe(false);
    expect(
      parseSwipeView(
        JSON.parse(
          JSON.stringify(
            runInNewContext(swipeViewExpression(targets), {
              document: swipeWindow().document,
            }),
          ),
        ),
      ).drawer.visible,
    ).toBe(false);
  });

  it('records trusted pointer fields passively and never dispatches or prevents', async () => {
    const { pointerRecorderExpression, pointerEventsExpression } =
      await loadObserver();
    const { window } = new JSDOM('<main></main>', {
      url: 'https://localhost/',
    });
    runInNewContext(pointerRecorderExpression(), { document: window.document });
    // Re-installing replaces the listeners, never doubles them.
    runInNewContext(pointerRecorderExpression(), { document: window.document });
    const event = new window.Event('pointerdown', { cancelable: true });
    Object.assign(event, {
      pointerType: 'touch',
      pointerId: 3,
      clientX: 5,
      clientY: 6,
    });
    window.document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const events = runInNewContext(pointerEventsExpression(), {
      document: window.document,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'pointerdown',
      trusted: false,
      pointerType: 'touch',
      pointerId: 3,
    });
    const observer = read(OBSERVER);
    expect(observer).toContain(
      'document.addEventListener(type, listener, { capture: true, passive: true });',
    );
    expect(observer).not.toMatch(
      /preventDefault|stopPropagation|stopImmediatePropagation|dispatchEvent/u,
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ACTOR = {
  userId: SENDER,
  username: 'trn_swipe_actor_0a1b2c',
  password: 'swipe-actor-pass',
};
const FRIEND_ACCOUNT = {
  userId: FRIEND,
  username: 'trn_swipe_friend_0a1b2c',
  password: 'swipe-friend-pass',
};
const ARTIFACT_IDS = {
  run: RUN,
  account: ACTOR,
  friend: FRIEND_ACCOUNT,
  room: { id: ROOM, name: ROOM_NAME },
  texts: [OWN, OTHER, `o-${RUN}`, `m-${RUN}`],
  eventIds: [OTHER_ID, OWN_ID],
};

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

/** Every record() proof must be an inline function that makes an assertion call. */
function recordProofViolations(source) {
  const tree = parse(source, 'journeys.mts');
  const violations = [];
  let records = 0;
  const asserts = (node) => {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        if (ts.isIdentifier(callee) && /^assert/u.test(callee.text))
          found = true;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'record' &&
      node.arguments.length === 4
    ) {
      records += 1;
      const proof = node.arguments[2];
      if (
        !(ts.isArrowFunction(proof) || ts.isFunctionExpression(proof)) ||
        !asserts(proof.body)
      )
        violations.push(lineOf(tree, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { records, violations };
}

describe('Android message-swipe diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertEditing(editing, arranged.own.body)', '() => {}'],
      ['() => assertDrawerVisible(opened)', '() => void opened'],
      ['() => { assertTimelineMoved(moved, before); }', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_SWIPE_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_SWIPE_STAGES[0],
      records: [],
      identities: new Set(),
      receipts: 0,
      client: {
        async record(name, value) {
          written.push({ name, value });
        },
      },
    };
    await record(context, 'room-ready', () => {}, { ready: true });
    expect(written[0]).toEqual({
      name: 'message-swipe.edit-own.room-ready',
      value: {
        assertion: 'message-swipe.edit-own.room-ready',
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'encryption-banner',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(record(context, 'editing', () => {}, {})).rejects.toThrow();
    await expect(record(context, 'not-owned', () => {}, {})).rejects.toThrow();
    // A suite-wide duplicate is refused even from another stage context.
    const other = { ...context, entry: MESSAGE_SWIPE_STAGES[0], records: [] };
    await expect(record(other, 'room-ready', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'arranged-room', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-arranged-room');
    for (const name of ['message-swipe.edit-own.editing', 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('leaves one unmet-observation.json for every failed view() wait', async () => {
    const { view: observeView } = await loadJourneys();
    const written = [];
    const observation = view();
    const client = {
      signal: new AbortController().signal,
      webview: {
        diagnostics: {
          async send() {
            return { result: { value: observation } };
          },
        },
      },
      async record(name, value) {
        written.push({ name, value });
      },
    };
    await expect(
      observeView(
        { client },
        [],
        () => {
          throw new Error('never satisfied');
        },
        'never satisfied',
        30,
      ),
    ).rejects.toThrow(/Timed out waiting for never satisfied/);
    expect(written).toEqual([
      { name: 'unmet-observation', value: observation },
    ]);
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageSwipeSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageSwipeSecrets('edit-own', ARTIFACT_IDS);
    const segment = Buffer.from(ROOM).toString('base64url');
    const failure = new AssertionError({
      actual: OWN,
      expected: OTHER,
      operator: 'strictEqual',
      message: 'The composer holds the exact own message',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM)} for ${SENDER} and ${FRIEND} at /rooms/${segment} on ${OWN_ID} body ${OTHER} pass ${FRIEND_ACCOUNT.password}`,
    );
    const error = redactStageFailure(
      'edit-own',
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error.message).toContain('Android message-swipe edit-own failed');
    expect(error.message).toContain('The composer holds the exact own message');
    for (const value of [
      ROOM,
      encodeURIComponent(ROOM),
      segment,
      OWN_ID,
      SENDER,
      FRIEND,
      OWN,
      OTHER,
      RUN,
      FRIEND_ACCOUNT.password,
    ])
      expect(error.message).not.toContain(value);
    const unregistered = '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4';
    expect(
      redactStageFailure(
        'edit-own',
        [new Error(`Event ${unregistered} already in timeline`)],
        {},
      ).message,
    ).toBe(
      'Android message-swipe edit-own failed\nError: Event [REDACTED] already in timeline',
    );
    expect(
      redactCleanupFailure(
        'fixtures',
        Object.assign(new Error(`leave ${ROOM}`), { status: 403 }),
      ).message,
    ).toBe('Message-swipe cleanup failed: fixtures (Error HTTP 403)');
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    expect(redactStageFailure('edit-own', [leaked], {}).message).toContain(
      OWN_ID,
    );
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessageSwipeCleanup } = await loadJourneys();
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
    guardMessageSwipeCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    )('Room cleanup', async () => {
      throw new Error(`forget ${ROOM}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-swipe cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.saves).toBe(1);
  });

  it('registers both Accounts, the Room, every body, transaction and event id, never the bare server name', async () => {
    const { messageSwipeSecrets } = await loadArtifacts();
    const secrets = messageSwipeSecrets('edit-own', ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_SWIPE_EDIT_OWN_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      RUN,
      SENDER,
      encodeURIComponent(SENDER),
      ACTOR.username,
      ACTOR.password,
      FRIEND,
      encodeURIComponent(FRIEND),
      FRIEND_ACCOUNT.username,
      FRIEND_ACCOUNT.password,
      ROOM,
      ROOM.slice(1),
      encodeURIComponent(ROOM),
      Buffer.from(ROOM).toString('base64url'),
      ROOM_NAME,
      OWN,
      OTHER,
      encodeURIComponent(OWN),
      `o-${RUN}`,
      `m-${RUN}`,
      OWN_ID,
      OTHER_ID,
      encodeURIComponent(OWN_ID),
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(() => messageSwipeSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageSwipeSecrets('edit-own', { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    const arrange = functionSource(journey, 'arrangeRoom');
    assertOrder(
      arrange,
      [
        /protect\(context, \{\n\s+room: \{ name \},\n\s+texts: \[own, other, otherTransaction\(run\), ownTransaction\(run\),/u,
        /context\.suite\.shared\.get\(fixtures\)/u,
        /protect\(context, \{ account \}\)/u,
        /fixtures\.account\(/u,
        /protect\(context, \{ friend \}\)/u,
        /fixtures\.createRoom\(/u,
        /protect\(context, \{ room: \{ id: room\.id \} \}\)/u,
        /fixtures\.sendMessage\(friend, room\.id, other, otherTransaction\(run\)\)/u,
        /protect\(context, \{ eventIds: \[otherId\] \}\)/u,
        /fixtures\.sendMessage\(account, room\.id, own, ownTransaction\(run\)\)/u,
        /protect\(context, \{ eventIds: \[ownId\] \}\)/u,
        /protect\(context, \{ eventIds: \[id\] \}\)/u,
        /assertArrangedRoom\(events, expected\)/u,
      ],
      'arrangeRoom',
    );
    const start = functionSource(journey, 'stageStart');
    assertOrder(
      start,
      [
        /await arrangeRoom\(context\)/u,
        /context\.safety\.unsafeSecrets = false/u,
        /await launch\(context/u,
        /await openRoom\(context/u,
      ],
      'stageStart',
    );
    expect(functionSource(journey, 'launch')).toContain(
      "assert(!context.safety.unsafeSecrets, 'Every stage identifier is registered before any UI step');",
    );
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier, credential, Preferences XML and raster', async () => {
    const { messageSwipeSecrets, scanMessageSwipeArtifacts } =
      await loadArtifacts();
    const secrets = messageSwipeSecrets('edit-own', ARTIFACT_IDS);
    await withOutput('trinity-swipe-scan-', async (output) => {
      await mkdir(join(output, 'edit-own'));
      const capture = join(output, 'edit-own', 'passed.json');
      for (const unsafe of [
        `GET /rooms/${ROOM}/messages`,
        JSON.stringify({ password: FRIEND_ACCOUNT.password }),
        `double=${encodeURIComponent(encodeURIComponent(ROOM))}`,
        `route=/rooms/${Buffer.from(ROOM).toString('base64url')}`,
        `slice=${ROOM.slice(1)}`,
        `user=${FRIEND}`,
        `body=${OTHER}`,
        `txn=m-${RUN}`,
        `event=${OWN_ID}`,
        'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
        '{"room_id": "!unregistered:localhost"}',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        'Authorization: Bearer unregistered-token',
        PREFERENCES,
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.message-swipe"}',
      ]) {
        await writeFile(capture, unsafe);
        await expect(
          scanMessageSwipeArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        capture,
        '{"roomDigest":"ab","drag":"77px","opacity":0.799,"server":"localhost"}\n',
      );
      await expect(
        scanMessageSwipeArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of [
        'passed-webview.png',
        'failed-device.PNG',
        'opaque.bin',
      ])
        await withOutput('trinity-swipe-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessageSwipeArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs identifiers, deletes rasters and then scans clean', async () => {
    const {
      messageSwipeSecrets,
      scrubMessageSwipeArtifacts,
      scanMessageSwipeArtifacts,
    } = await loadArtifacts();
    const secrets = messageSwipeSecrets('edit-own', ARTIFACT_IDS);
    await withOutput('trinity-swipe-scrub-', async (output) => {
      const stage = join(output, 'edit-own');
      await mkdir(stage);
      const path = join(stage, 'passed-surface.json');
      await writeFile(
        path,
        [
          JSON.stringify({
            url: `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(SENDER)}`,
          }),
          `rows ${OWN} ${OTHER} by ${FRIEND_ACCOUNT.username}`,
          'Msg: Event $SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4 already in timeline',
          'unchanged=1 swipe',
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed-webview.png'), 'raster');
      await scrubMessageSwipeArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=1 swipe');
      for (const leaked of [
        ROOM,
        SENDER,
        OWN,
        OTHER,
        RUN,
        FRIEND_ACCOUNT.username,
        '$SJXdpxxWrrm9mq1XxwAx1Kq-JhfVCWzpxntFokS4Ox4',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(existsSync(join(stage, 'passed-webview.png'))).toBe(false);
      await expect(
        scanMessageSwipeArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried fourteen-stage 74-record Pixel 5 run with a feasible gate', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 14,
      expectedAssertionRecords: 74,
      attempt: 1,
      retries: 0,
      stages: STAGES.map((stage) => ({
        id: stage.id,
        status: 'passed',
        attempt: 1,
        retries: 0,
        expectedAssertionRecords: stage.identities.length,
        assertionRecords: stage.identities.length,
        assertions: [...stage.identities],
        failureCount: 0,
      })),
    });
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    const gate = {
      feasible: true,
      nativePanStream: true,
      compositorPanning: true,
      moves: 11,
      scrollDelta: 431,
    };
    await withOutput('trinity-swipe-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const arrange = async (value = report(), feasibility = gate) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', {
          schemaVersion: 1,
          profile: {
            requested: PIXEL_5_ACCOUNT_PROFILE,
            digest: sha256(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
          },
        });
        for (const stage of STAGES) {
          await mkdir(join(output, stage.id), { recursive: true });
          await write(join(stage.id, 'profile-applied.json'), {
            requested: PIXEL_5_ACCOUNT_PROFILE,
          });
          for (const name of [
            'passed.json',
            'passed-ui.json',
            'passed-surface.json',
          ])
            await write(join(stage.id, name), { ok: true });
        }
        await write(join('vertical-scroll', 'feasibility.json'), feasibility);
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessageSwipeDiagnosticsSafe(
            output,
            options.secrets ?? {},
            options.flags ?? flags,
            options.signal,
            value,
          ),
        ).rejects.toThrow();
        expect(existsSync(marker)).toBe(false);
      };
      await arrange();
      await artifacts.markMessageSwipeDiagnosticsSafe(
        output,
        {},
        flags,
        undefined,
        report(),
      );
      expect(await readFile(marker, 'utf8')).toBe('scanned\n');
      const mutate = (change) => {
        const value = report();
        change(value);
        return value;
      };
      for (const invalid of [
        mutate((value) => (value.status = 'failed')),
        mutate((value) => (value.retries = 1)),
        mutate((value) => value.stages.pop()),
        mutate((value) => (value.stages[8].status = 'failed')),
        mutate((value) => (value.stages[13].attempt = 2)),
        mutate((value) => {
          value.stages[13].assertions.pop();
          value.stages[13].assertionRecords = 11;
        }),
        mutate(
          (value) =>
            ([value.stages[0], value.stages[1]] = [
              value.stages[1],
              value.stages[0],
            ]),
        ),
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }
      // A failed or missing feasibility gate blocks publication.
      for (const feasibility of [
        { ...gate, feasible: false },
        { ...gate, compositorPanning: false },
        { ...gate, nativePanStream: false },
      ]) {
        await arrange(report(), feasibility);
        await refused(report());
      }
      await arrange();
      await rm(join(output, 'vertical-scroll', 'feasibility.json'));
      await refused(report());
      for (const unsafe of [
        { ...flags, unsafeSecrets: true },
        { ...flags, cleanupFailed: true },
        { ...flags, scrubFailed: true },
      ]) {
        await arrange();
        await refused(report(), { flags: unsafe });
      }
      const aborted = new AbortController();
      aborted.abort();
      await arrange();
      await refused(report(), { signal: aborted.signal });
      await arrange();
      await rm(join(output, 'live-setting', 'passed-ui.json'));
      await refused(report());
      await arrange();
      await write(join('drawer-off', 'profile-applied.json'), {
        requested: DESKTOP_ACCOUNT_PROFILE,
      });
      await refused(report());
      await arrange();
      await writeFile(join(output, 'edit-own', 'passed.json'), `rows ${OWN}`);
      await refused(report(), {
        secrets: artifacts.messageSwipeSecrets('edit-own', ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, 'edit-own', 'passed-webview.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step, restores navigation, cancels a held pointer and revokes publication on abort', async () => {
    const {
      runMessageSwipeStageCleanup,
      revokeMessageSwipePublicationOnAbort,
    } = await loadArtifacts();
    const { stageTeardown } = await loadJourneys();
    const ran = [];
    const context = {
      touch: {
        async dispose() {
          ran.push('cancel');
        },
      },
      navigationRestore: async () => {
        ran.push('restore');
        throw new Error('overlay');
      },
      client: {
        async close() {
          ran.push('close');
        },
      },
    };
    const failures = [];
    await runMessageSwipeStageCleanup(
      stageTeardown(
        context,
        async () => {
          ran.push('clear');
        },
        false,
      ),
      failures,
    );
    expect(ran).toEqual(['cancel', 'close', 'restore', 'clear']);
    expect(failures).toHaveLength(1);
    expect(context.touch).toBeNull();
    ran.length = 0;
    await runMessageSwipeStageCleanup(
      stageTeardown(
        { touch: null, navigationRestore: null, client: context.client },
        async () => {
          ran.push('clear');
        },
        true,
      ),
      [],
    );
    expect(ran).toEqual(['close']);
    ran.length = 0;
    const closeFails = [];
    await runMessageSwipeStageCleanup(
      stageTeardown(
        {
          touch: null,
          navigationRestore: async () => {
            ran.push('restore');
          },
          client: {
            async close() {
              ran.push('close');
              throw new Error('devtools');
            },
          },
        },
        async () => {
          ran.push('clear');
        },
        true,
      ),
      closeFails,
    );
    expect(ran).toEqual(['close', 'restore']);
    expect(closeFails).toHaveLength(1);
    await withOutput('trinity-swipe-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageSwipePublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageSwipePublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-swipe publication',
      });
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-swipe --timeout-ms=2100000 --entrypoint=e2e/android/message-swipe-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "6" ]; then echo \'message-swipe-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 2400000 -- pnpm exec nx run trinity-e2e-android:message-swipe; fi';
const GATE_PATH =
  "-path '*/android.message-swipe/message-swipe/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-swipe-started == 'true' && steps.message-swipe-artifact-gate.outputs.message-swipe-safe == 'true' }}";

function wiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
  };
}

function assertWiring({ project, pkg, workflow }) {
  const target = project.targets['message-swipe'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-swipe']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-swipe',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  // Last on shard 6, and before the retained Playwright command.
  expect(runner).toBeGreaterThan(
    lines.findIndex((line) =>
      line.includes('trinity-e2e-android:message-quote;'),
    ),
  );
  expect(runner).toBeLessThan(
    lines.findIndex((line) => line.includes('pnpm e2e:android --')),
  );
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-swipe')),
  ).toHaveLength(1);
  const gate = workflow
    .split('      - name: Gate Android message-swipe diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-swipe-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-swipe-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-swipe-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-swipe\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-swipe/**',
  );
}

describe('Android message-swipe hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands on shard 6', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-swipe',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-swipe',
      canonicalScript: 'e2e:android:message-swipe',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT,
      OBSERVER,
      MOTION,
      PREFERENCE,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-swipe',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-swipe',
        command: 'nx run trinity-e2e-android:message-swipe',
        kind: 'canonical',
        suiteIds: ['android.message-swipe'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-swipe'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "6" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-swipe',
    );
    expect(read(JOURNEYS)).toContain('timeout: 1_800_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-swipe']);
      return inputs;
    };
    const withText = (key, from, to) => {
      const inputs = clone();
      expect(inputs[key]).toContain(from);
      inputs[key] = inputs[key].replace(from, to);
      return inputs;
    };
    const command = (from, to) =>
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(from, to)),
      );
    for (const mutated of [
      withTarget((target) => (target.cache = true)),
      withTarget((target) => (target.parallelism = true)),
      withTarget((target) => (target.dependsOn = [])),
      command(' --resource=synapse', ''),
      command('message-swipe-journeys.mts', 'message-source-journeys.mts'),
      command('--timeout-ms=2100000', '--timeout-ms=90000'),
      command(
        'web-bundle-manifest.mjs verify',
        'web-bundle-manifest.mjs write',
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-swipe'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "6"', '= "3"')),
      withText('workflow', CI_LINE, CI_LINE.replace('2400000', '600000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-swipe/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-swipe-started == 'true' }}",
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const [line] = lines.splice(
      lines.findIndex((entry) => entry.trim() === CI_LINE),
      1,
    );
    lines.splice(
      lines.findIndex((entry) => entry.includes('pnpm e2e:android --')) + 1,
      0,
      line,
    );
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 74 identities with their source lines and the 38/36 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-swipe journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^|\n]+ \| `(message-swipe\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[1])).toEqual(
      STAGES.flatMap((stage) => stage.identities.map(() => stage.id)),
    );
    expect(rows.map((row) => row[2].trim())).toEqual(
      STAGES.flatMap((stage) =>
        stage.records.map(([kind, line, , call]) =>
          kind === 'direct' ? String(line) : `${line}@${call}`,
        ),
      ),
    );
    expect(rows.map((row) => row[3])).toEqual(
      STAGES.flatMap((stage) => stage.records.map(([kind]) => kind)),
    );
    expect(section).toContain('38 direct + 36');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-swipe`');
    expect(section).toContain('393×727');
    expect(section).toContain('input motionevent');
    expect(section).toContain('feasibility');
    expect(section).toContain('three-button navigation');
    expect(section).toContain('Predecessor status: enabled');
    expect(section).not.toContain('pnpm exec nx');
    const design = read(
      'docs/superpowers/specs/2026-09-27-android-message-swipe-maestro-design.md',
    );
    for (const stage of STAGES)
      for (const [, , , , suffix] of stage.records)
        expect(design).toContain(`\`${suffix}\``);
    expect(design).toContain(PREDECESSOR_SHA256);
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules                                                              */
/* ------------------------------------------------------------------------ */

const FORBIDDEN_TOKENS = [
  ['.click(', /\.click\(/u],
  ['.focus(', /\.focus\(/u],
  ['dispatchEvent', /dispatchEvent/u],
  [
    'renderer scroll',
    /scrollIntoView\(|scrollTo\(|scrollBy\(|scrollTop\s*=(?!=)/u,
  ],
  [
    'Input.dispatch',
    /Input\.dispatch|dispatchTouchEvent|dispatchMouseEvent|synthesizeScrollGesture/u,
  ],
  ['Maestro or adb swipe', /swipeCurrent|input swipe|input touchscreen swipe/u],
  ['navigate(', /\bnavigate\(|\breload\(/u],
  ['installDocumentScript', /installDocumentScript/u],
  ['value write', /\.value\s*=(?!=)|setRangeText|insertText|execCommand/u],
  [
    'classList mutation',
    /classList\.(?:add|remove|toggle|replace)\(|className\s*=(?!=)/u,
  ],
  ['setAttribute', /setAttribute|removeAttribute|toggleAttribute/u],
  [
    '.style. write',
    /\.style\.[\w-]+\s*=(?!=)|\.style\.(?:setProperty|removeProperty)\(/u,
  ],
  [
    'location write',
    /location\s*=(?!=)|location\.href\s*=(?!=)|location\.(?:assign|replace)\(/u,
  ],
  ['web Preference seed', /seedPreference|localStorage/u],
  ['raster capture', /\.screenshot\(|toHaveScreenshot|captureScreenshot/u],
  ['trinity-e2e-shared-secret', /trinity-e2e-shared-secret/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
];

function assertNoForbiddenTokens(source, name) {
  for (const [token, pattern] of FORBIDDEN_TOKENS)
    expect(pattern.test(source), `${name} must not contain ${token}`).toBe(
      false,
    );
}

function assertBoundedWaits(source, name) {
  const tree = parse(source, name);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText(tree).split('.').at(-1);
      if (called === 'waitForNativeShellState' || called === 'waitElements') {
        const bound = node.arguments[4];
        expect(
          bound,
          `${name}: ${node.getText(tree).slice(0, 80)} is bounded`,
        ).toBeDefined();
        expect(bound.getText(tree)).not.toMatch(/Infinity|undefined/u);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

function functionSource(source, name) {
  const tree = parse(source, 'journeys.mts');
  let match;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      match = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(match, `${name} must be declared`).toBeDefined();
  return match.getText(tree);
}

const recordOf = (suffix) =>
  new RegExp(`\\brecord\\(\\s*context,\\s*'${suffix}'`, 'u');
const callOf = (name) => new RegExp(`\\b${name}\\(`, 'u');

function assertOrder(body, steps, name) {
  let at = -1;
  for (const step of steps) {
    const pattern = new RegExp(step.source, 'gu');
    pattern.lastIndex = at + 1;
    const found = pattern.exec(body);
    expect(found, `${name}: ${step} after offset ${at}`).not.toBeNull();
    at = found.index;
  }
}

/** A negative claim is read over the settle window, never sampled once. */
const SETTLED_RECORDS = {
  runOffInert: ['no-banner'],
  runLeftDirection: ['right-drag-rejected'],
  runVerticalAbandon: ['no-banner', 'no-drag-style'],
  runVerticalScroll: ['no-banner'],
  runEdgeDeadZones: ['left-edge-no-banner', 'right-edge-drawer-hidden'],
};

/** The native order and invariants required by the design. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertBoundedWaits(journeys, JOURNEYS);
  expect(journeys).not.toMatch(/evaluateNative|webview\./u);
  expect(journeys).not.toMatch(
    /client\.(?:fill|fillFocused|replace|tap|longPressCurrent)\(/u,
  );
  // Every gesture is a native touch; no stage ever holds two.
  expect(journeys).toContain(
    "assert.equal(context.touch, null, 'No native touch is held between gestures');",
  );
  const nativeSwipe = functionSource(journeys, 'nativeSwipe');
  assertOrder(
    nativeSwipe,
    [
      callOf('freshTouch'),
      /installPointerRecorder\(context\.client\)/u,
      /touch\.swipe\(from, to\)/u,
      /readPointerEvents\(context\.client\)/u,
      /proveGesture\(context, events, plan, ending\)/u,
    ],
    'nativeSwipe',
  );
  const nativePress = functionSource(journeys, 'nativePress');
  assertOrder(
    nativePress,
    [
      /installPointerRecorder\(context\.client\)/u,
      /context\.touch = touch/u,
      /touch\.press\(from, to\)/u,
      /proveGesture\(context, events, \{ from, to \}, 'held'\)/u,
    ],
    'nativePress',
  );
  expect(functionSource(journeys, 'nativeMoveHeld')).toContain(
    "proveGesture(context, events, { from, to }, 'held')",
  );
  // A failed gesture proof is as diagnosable as a failed view() wait.
  expect(functionSource(journeys, 'proveGesture')).toContain(
    "await context.client.record('unmet-gesture', { plan, ending, events });",
  );
  expect(functionSource(journeys, 'nativeRelease')).toContain(
    "assert.equal(events.at(-1)!.type, 'pointerup', 'The held pointer was released');",
  );
  assertOrder(
    functionSource(journeys, 'probeCompositorPanning'),
    [
      callOf('freshTouch'),
      /installPointerRecorder\(context\.client\)/u,
      /context\.touch = touch/u,
      /touch\.press\(from, to\)/u,
      /readPointerEvents\(context\.client\)/u,
      /touch\.release\(\)/u,
      /assertNativeGesture\(events, \{ from, to \}, 'held-pan'\)/u,
      /context\.client\.record\('feasibility'/u,
    ],
    'probeCompositorPanning',
  );
  assertOrder(
    functionSource(journeys, 'dragTimeline'),
    [
      callOf('freshTouch'),
      /installPointerRecorder\(context\.client\)/u,
      /context\.touch = touch/u,
      /touch\.press\(from, to, steps\)/u,
      /touch\.release\(\)/u,
      /readPointerEvents\(context\.client\)/u,
      /proveGesture\(context, events, \{ from, to \}, 'up-or-cancel'\)/u,
    ],
    'dragTimeline',
  );
  expect(journeys).toContain(
    'const steps = Math.min(20, Math.max(2, Math.floor(travel / 12)));',
  );
  expect(functionSource(journeys, 'launch')).toContain(
    'assertAppliedProfile(applied);',
  );
  // The feasibility gate is feasible only when both controls held.
  expect(functionSource(journeys, 'probeCompositorPanning')).toContain(
    'feasible: nativePanStream && compositorPanning,',
  );
  // Held observations happen before the release.
  for (const [name, steps] of [
    [
      'runProgressiveFeedback',
      [
        /nativePress\(context, 'progress-partial'/u,
        /assertHeldPartial\(value, body, 1\)/u,
        recordOf('partial-opacity-positive'),
        recordOf('partial-opacity-below-one'),
        /nativeMoveHeld\(context, touch/u,
        recordOf('armed-opacity-one'),
        recordOf('armed-scale-changed'),
        recordOf('armed-colour-changed'),
        /nativeRelease\(context, touch/u,
      ],
    ],
    [
      'runLeftStripGeometry',
      [
        /nativePress\(context, 'leftward'/u,
        /assertHeldDrag\(value, body, -1\)/u,
        recordOf('icon-past-row-end'),
        recordOf('icon-inside-original-row'),
        /nativeRelease\(context, touch/u,
      ],
    ],
    [
      'runVerticalScroll',
      [
        /probeCompositorPanning\(context, targets\)/u,
        /assert\(gate\.feasible, /u,
        /nativeSwipe\(context, 'vertical'/u,
        /assertTimelineMoved\(value, before\)/u,
        recordOf('timeline-moved'),
        recordOf('no-banner'),
      ],
    ],
    [
      'runEdgeDeadZones',
      [
        /assert\(context\.navigationRestore, /u,
        /nativePress\(context, 'left-edge', leftFrom, leftTo\)/u,
        /assertRowSettled\(value, arranged\.other\.body\)/u,
        /nativeRelease\(context, held/u,
        recordOf('left-edge-no-banner'),
        /nativeSwipe\(context, 'inset-control', \{ x: 80, y \}/u,
        recordOf('inset-control-replying'),
        // The reply banner changed the timeline's height: the row position
        // is re-measured before the remaining gestures reuse it.
        /box = rowFor\(current, arranged\.other\.body\)\.box!;\n\s+y = rowCentre\(box\);/u,
        /nativeSwipe\(context, 'right-edge', \{ x: width - RIGHT_EDGE_START_INSET_PX, y \}/u,
        recordOf('right-edge-drawer-hidden'),
        /nativeSwipe\(context, 'drawer-inset', \{ x: width - DRAWER_OPEN_FROM_RIGHT_PX, y \}/u,
        recordOf('inset-drawer-visible'),
      ],
    ],
    [
      'runLiveSetting',
      [
        recordOf('initially-no-affordance'),
        /client\.tapCurrent\('\[data-testid="back-to-rooms"\]'\)/u,
        recordOf('settings-rooms-route'),
        /client\.tapCurrent\('\[data-testid="open-settings"\]'\)/u,
        recordOf('settings-sections-visible'),
        /client\.tapCurrent\('\[data-testid="settings-nav-appearance"\]'\)/u,
        recordOf('settings-detail-ready'),
        /client\.tapCurrent\('\[data-testid="message-swipe-right"\]'\)/u,
        /assertSeededPreference\(value, 'right'\)/u,
        recordOf('settings-section-unwound'),
        recordOf('rooms-route-restored'),
        recordOf('settings-detached'),
        recordOf('settings-dialog-hidden'),
        recordOf('no-settings-path'),
        /assertSameDocument\(value, opened\.timeOrigin\)/u,
        recordOf('affordance-live'),
      ],
    ],
  ])
    assertOrder(functionSource(journeys, name), steps, name);
  // Negative claims are held over the settle window.
  expect(journeys).toMatch(/const SETTLE_MS = 2_000;/u);
  for (const [name, suffixes] of Object.entries(SETTLED_RECORDS)) {
    const body = functionSource(journeys, name);
    for (const suffix of suffixes) {
      const match = body.match(
        new RegExp(
          `record\\(context, '${suffix}', \\(\\) => \\w+\\((\\w+)`,
          'u',
        ),
      );
      expect(match, `${name} ${suffix}`).not.toBeNull();
      expect(body, `${name} ${suffix} observed over the settle window`).toMatch(
        new RegExp(
          `(?:const|let|^\\s*)\\s*${match[1]}\\b[^;]*= await settled\\(`,
          'mu',
        ),
      );
    }
  }
  // Three-button navigation: only the edge stage, set with the app stopped, always restored.
  const launch = functionSource(journeys, 'launch');
  assertOrder(
    launch,
    [
      /seedNativeSwipePreference\(client\.device, APPLICATION_ID, seed\)/u,
      /assertSeededPreference\(seeded, seed\)/u,
      /if \(options\.threeButtonNavigation\) await useThreeButtonNavigation\(context\)/u,
      /suite\.shared\.enter\(client, PIXEL_5_ACCOUNT_PROFILE\)/u,
      /readNativeSwipePreference\(client\.device, APPLICATION_ID\)/u,
      /assertSeededPreference\(live, seed\)/u,
    ],
    'launch',
  );
  expect(launch).toContain(
    "assert.equal(seed, null, 'A fresh-app stage is unseeded');",
  );
  const navigation = functionSource(journeys, 'useThreeButtonNavigation');
  assertOrder(
    navigation,
    [
      /'am', 'force-stop', APPLICATION_ID/u,
      /context\.navigationRestore = async \(\) => \{/u,
      /'am', 'force-stop', APPLICATION_ID/u,
      /await setMode\(original\)/u,
      /await setMode\('0'\)/u,
    ],
    'useThreeButtonNavigation',
  );
  const start = functionSource(journeys, 'stageStart');
  expect(start).toContain("freshApp: context.entry.id === 'live-setting',");
  expect(start).toContain(
    "threeButtonNavigation: context.entry.id === 'edge-dead-zones',",
  );
  const teardown = functionSource(journeys, 'stageTeardown');
  assertOrder(
    teardown,
    [
      /touch\?\.dispose\(\)/u,
      /context\.client\.close\(\)/u,
      /context\.navigationRestore\?\.\(\)/u,
      /if \(!keepApp\) await clear\(\)/u,
    ],
    'stageTeardown',
  );
  // One shared Account for stages 1–13; a fresh app for the live stage.
  expect(journeys).toContain("new SharedStageAccount('swipe-actor')");
  // Selectors never carry an identifier; descriptions interpolate nothing.
  expect(journeys).not.toMatch(/data-mid(?:[*~|^]?=)|\[data-mid="\$\{/u);
  const calls = [
    ...journeys.matchAll(
      /client\.(?:tapCurrent|visible|waitElements|elements|scrollIntoViewIfNeeded)\(([^;]*?)\);/gsu,
    ),
  ];
  expect(calls.length).toBeGreaterThanOrEqual(8);
  for (const call of calls)
    expect(call[1], call[0]).not.toMatch(
      /`|\$\{|Id\b|\.id\b|eventId|userId|roomId/u,
    );
  expect(journeys).not.toMatch(
    /console\.\w+\([^)]*\$\{(?!entry\.id|stage\.status)/u,
  );
  const runner = functionSource(journeys, 'runMessageSwipeSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /resources\.cleanup = guardedCleanup;/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /for \(const entry of MESSAGE_SWIPE_STAGES\)/u,
      /safety\.unsafeSecrets = true;/u,
      /assertMessageSwipeRecords\(entry\.id, records\)/u,
      /client\.capture\('passed'\)/u,
      /runMessageSwipeStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageSwipeSuite',
  );
  for (const required of [
    'expectedStages: 14',
    'expectedAssertionRecords: 74',
    'attempt: 1',
    'retries: 0',
    'markMessageSwipeDiagnosticsSafe(',
    'scrubMessageSwipeArtifacts(',
    'revokeMessageSwipePublicationOnAbort(',
    "client.capture('failed')",
    'profile: PIXEL_5_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-swipe source rules', () => {
  it('keeps the observer, motion, Preference, artifacts and contract free of forbidden actions and bounded', () => {
    for (const path of [OBSERVER, MOTION, PREFERENCE, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    const motion = read(MOTION);
    expect(motion).toContain(
      'return `input motionevent ${phase.toUpperCase()} ${device.x} ${device.y}`;',
    );
    expect(motion).toContain(
      "await this.client.device.adb('shell', motionCommand(phases));",
    );
  });

  it('adds no shared fixture or client method', () => {
    for (const path of [
      'e2e/android/account-workspace-client.mts',
      'e2e/android/account-workspace-fixtures.mts',
    ])
      expect(read(path)).not.toMatch(/message-swipe|swipe-actor/u);
  });

  it('fails the forbidden-token rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'row.dispatchEvent(new PointerEvent("pointerdown"))',
      'scroller.scrollTo({ top: 0 })',
      'scroller.scrollTop = 0',
      "await cdp.send('Input.dispatchTouchEvent', {})",
      "await client.swipeCurrent('.scroll', {})",
      "await device.adb('shell', 'input swipe 1 2 3 4')",
      'row.style.setProperty("--swipe-drag", "10px")',
      'row.classList.add("msg--swipe-armed")',
      "await seedPreference(page, 'trinity.message-swipe', 'right')",
      "localStorage.setItem('x', 'y')",
      'const report = { retries: 1 }',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    expect(() =>
      assertBoundedWaits(
        `${observer}\nawait waitForNativeShellState(read, accepts, "x", signal);`,
        OBSERVER,
      ),
    ).toThrow();
  });

  it('drives every gesture natively, observes held and negative claims correctly, and restores the device', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      // A renderer dispatch or scroll substitutes for the device.
      `${journeys}\nawait evaluateNative(client.webview, 'document.querySelector(".scroll").scrollTop = 0');`,
      `${journeys}\nawait client.swipeCurrent('.scroll', { direction: 'increase-scroll-top' });`,
      // The gesture is no longer proven as trusted native input.
      replace(
        /const \{ moves, durationMs \} = await proveGesture\(context, events, plan, ending\);/u,
        'const { moves, durationMs } = { moves: 0, durationMs: 0 };',
      ),
      replace(
        /const \{ moves \} = await proveGesture\(context, events, \{ from, to \}, 'held'\);/u,
        'const moves = 0;',
      ),
      // A failed gesture proof leaves no diagnosable unmet-gesture artifact.
      replace(
        /await context\.client\.record\('unmet-gesture', \{ plan, ending, events \}\);\n\s+throw error;\n/u,
        'throw error;\n',
      ),
      // A held observation is read after release.
      replace(
        /await nativePress\(context, 'progress-partial', start, partlyAt\);/u,
        "await nativeSwipe(context, 'progress-partial', start, partlyAt, 'up');",
      ),
      replace(/  await nativeRelease\(context, touch, 'leftward'\);\n/u, ''),
      // The feasibility gate is skipped or no longer fails closed.
      replace(/  assert\(gate\.feasible, [^\n]+\n/u, ''),
      replace(
        /feasible: nativePanStream && compositorPanning,/u,
        'feasible: true,',
      ),
      replace(/\{ from, to \}, 'held-pan'\)/u, "{ from, to }, 'held')"),
      replace(
        /const steps = Math\.min\(20, Math\.max\(2, Math\.floor\(travel \/ 12\)\)\);/u,
        'const steps = 20;',
      ),
      replace(/  assertAppliedProfile\(applied\);\n/u, ''),
      replace(
        /\{ from, to \}, 'up-or-cancel'\);\n  await receipt\(context, `timeline-drag/u,
        "{ from, to }, 'up');\n  await receipt(context, `timeline-drag",
      ),
      // A negative claim is sampled once.
      replace(
        /const quiet = await settled\(context, targets, \(value\) => \{\n\s+assertNoBanner\(value\);\n\s+assertRowSettled/u,
        'const quiet = await view(context, targets, (value) => {\n    assertNoBanner(value);\n    assertRowSettled',
      ),
      replace(/const SETTLE_MS = 2_000;/u, 'const SETTLE_MS = 0;'),
      // The edge stage reuses a row position measured before the reply
      // banner changed the timeline's height.
      replace(
        /\n  \/\/ The reply banner just armed above the composer, changing the timeline's\n  \/\/ measured height: the row position is re-measured before it is reused\.\n  current = await placeRows\(context, targets\);\n  box = rowFor\(current, arranged\.other\.body\)\.box!;\n  y = rowCentre\(box\);\n/u,
        '\n',
      ),
      // D8: the predecessor's exact width - 4 right-edge start no longer
      // reaches the page as a trusted pointerdown on the installed WebView.
      replace(
        /nativeSwipe\(context, 'right-edge', \{ x: width - RIGHT_EDGE_START_INSET_PX, y \}/u,
        "nativeSwipe(context, 'right-edge', { x: width - 4, y }",
      ),
      // Three-button navigation is never restored, or set with the app running.
      replace(
        /  context\.navigationRestore = async \(\) => \{[\s\S]*?\n  \};\n/u,
        '',
      ),
      replace(
        /    async \(\) => \{ await context\.navigationRestore\?\.\(\); \},\n/u,
        '',
      ),
      // The live stage is seeded, or the native choice is not proven Right.
      replace(
        /freshApp: context\.entry\.id === 'live-setting',/u,
        'freshApp: false,',
      ),
      replace(
        /passes\(\(value\) => assertSeededPreference\(value, 'right'\)\)/u,
        'passes(() => undefined)',
      ),
      replace(
        /\n\s+assertSameDocument\(value, opened\.timeOrigin\);\n\s+\}, 'the affordance is live/u,
        "\n  }, 'the affordance is live",
      ),
      // A row is targeted by its event id, or a description leaks one.
      replace(
        /client\.tapCurrent\('\.channel', \{ text: arranged\.room\.name \}\)/u,
        'client.tapCurrent(`.scroll .msg[data-mid="${arranged.own.eventId}"]`)',
      ),
      // A stage failure is rethrown unredacted.
      replace(
        /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
        "throw new AggregateError(failures, 'failed');",
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
