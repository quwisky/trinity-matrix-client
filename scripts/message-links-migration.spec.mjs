import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SECONDARY_HTTP, SYNAPSE_HTTP } from '../e2e/support/synapse/start.mjs';

const root = resolve(import.meta.dirname, '..');
const predecessor = 'e2e/browser/journeys/conversations/message-links.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () => import('../e2e/android/message-links-contract.mts');
const loadFixtures = () => import('../e2e/android/message-links-fixtures.mts');
const loadObserver = () => import('../e2e/android/message-links-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-links-artifacts.mts');
const loadJourneys = () => import('../e2e/android/message-links-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-links-journeys.mts';
const OBSERVER = 'e2e/android/message-links-observer.mts';
const FIXTURES = 'e2e/android/message-links-fixtures.mts';
const ARTIFACTS = 'e2e/android/message-links-artifacts.mts';
const CONTRACT = 'e2e/android/message-links-contract.mts';
const CLIENT = 'e2e/android/account-workspace-client.mts';

const PREDECESSOR_SHA256 =
  '513b7f01b026991d316479edf06caef9754e70cc0df157a37436a67982aeb400';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/browser/support/contrast.mts':
    '5c5561a7cd599679a95735fe82cbe14b95faf93c359f3f4ef7e85aa386b2b7f3',
  'e2e/fixtures.mts':
    '7358d2f7ddcac9c9b6bec9531cef12cc1d097ac7a6199897a21dc524978b8396',
  'e2e/support/navigation.mts':
    '6ee2fc9fb014bf39d92fe88ffb7c0afafccbed3219575a480da404efe1f93c15',
};

const HELPER_SPAN = [22, 147];
const HELPER_SITES = [37, 58, 76, 100, 129];
const WEB_TAIL = [588, 604];
const WEB_TAIL_SITES = [591, 595, 596, 597, 598, 600];

/** Source-ordered stage ledger: the design's identity table, verbatim. */
const STAGES = [
  {
    id: 'joined-preview',
    span: [156, 230],
    title: 'a joined room previews before an explicit Open',
    profile: 'desktop',
    direct: [214, 215, 217, 218, 225],
    inherited: [[129, 'openRoom', 206]],
    suffixes: [
      'room-open',
      'preview-visible',
      'target-name',
      'open-action',
      'source-still-active',
      'target-opened',
    ],
  },
  {
    id: 'federated-join',
    span: [232, 321],
    title: 'previews and joins a public room across real federation',
    profile: 'desktop',
    direct: [274, 277, 280, 283, 291, 295, 296, 304, 308, 316],
    inherited: [
      [37, 'loginApi', 237, 118],
      [76, 'createRoom', 237, 120],
      [58, 'registerRemote', 239],
      [76, 'createRoom', 248],
      [100, 'sendRoomLink', 255],
      [129, 'openRoom', 270],
    ],
    suffixes: [
      'api-login',
      'source-room-created',
      'remote-registered',
      'remote-room-created',
      'link-sent',
      'room-open',
      'remote-name',
      'remote-topic',
      'join-action',
      'source-still-active',
      'joined-notice',
      'open-action',
      'open-focused',
      'light-contrast',
      'dark-contrast',
      'remote-opened',
    ],
  },
  {
    id: 'remote-unavailable',
    span: [323, 362],
    title: 'shows a useful unavailable state for an inaccessible remote room',
    profile: 'desktop',
    direct: [359, 360, 361],
    inherited: [
      [37, 'loginApi', 328, 118],
      [76, 'createRoom', 328, 120],
      [58, 'registerRemote', 329],
      [76, 'createRoom', 334],
      [100, 'sendRoomLink', 338],
      [129, 'openRoom', 353],
    ],
    suffixes: [
      'api-login',
      'source-room-created',
      'remote-registered',
      'remote-room-created',
      'link-sent',
      'room-open',
      'load-error-visible',
      'load-error-guidance',
      'no-primary-action',
    ],
  },
  {
    id: 'rejected-join',
    span: [364, 424],
    title: 'keeps a rejected federated Join open and retryable',
    profile: 'desktop',
    direct: [399, 413, 418, 421, 422, 423],
    inherited: [
      [37, 'loginApi', 369, 118],
      [76, 'createRoom', 369, 120],
      [58, 'registerRemote', 370],
      [76, 'createRoom', 375],
      [100, 'sendRoomLink', 379],
      [129, 'openRoom', 394],
    ],
    suffixes: [
      'api-login',
      'source-room-created',
      'remote-registered',
      'remote-room-created',
      'link-sent',
      'room-open',
      'join-action',
      'join-rule-invite',
      'action-error',
      'join-retained',
      'join-focused',
      'preview-retained',
    ],
  },
  {
    id: 'portrait-sheet',
    span: [433, 504],
    title: 'keeps the sheet and its action footer reachable',
    profile: 'portrait',
    direct: [465, 466, 469, 492, 493, 494, 497, 500, 501],
    inherited: [
      [37, 'loginApi', 439, 118],
      [76, 'createRoom', 439, 120],
      [76, 'createRoom', 441],
      [100, 'sendRoomLink', 444],
      [129, 'openRoom', 459],
    ],
    suffixes: [
      'api-login',
      'source-room-created',
      'target-room-created',
      'link-sent',
      'room-open',
      'preview-visible',
      'sheet-class',
      'open-action',
      'portrait',
      'left-edge',
      'right-edge',
      'bottom-edge',
      'footer-top',
      'footer-bottom',
    ],
  },
  {
    id: 'mention-user-card',
    span: [507, 587],
    title: 'clicking a mention shows a user card, not an empty room',
    profile: 'desktop',
    direct: [573, 574, 579, 582, 583],
    inherited: [[129, 'openRoom', 566]],
    suffixes: [
      'room-open',
      'card-visible',
      'card-name',
      'no-anchored-popover',
      'dialog-name',
      'room-retained',
    ],
  },
];
const identities = (stage) =>
  stage.suffixes.map((suffix) => `message-links.${stage.id}.${suffix}`);
const ALL_IDENTITIES = STAGES.flatMap(identities);

const HELPER_CALLS = {
  loginApi: [118],
  localScenario: [237, 328, 369, 439],
  registerRemote: [239, 329, 370],
  createRoom: [120, 248, 334, 375, 441],
  sendRoomLink: [255, 338, 379, 444],
  openRoom: [206, 270, 353, 394, 459, 566],
  activateRoomLinkPrimary: [223, 315],
};
const SHADOWED_CALLS = {
  createRoom: [[183, 184], 178],
  token: [[529, 530], 519],
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { AA_NORMAL_TEXT, measureContrast } from '../../support/contrast.mts';`;

const DESCRIBE_SKIPS = `  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.skip(
    !session.secondary,
    'needs the federated secondary Synapse from the current harness',
  );`;

const LINE_PINS = {
  578: 'if (isAndroidE2E) {',
  587: 'return;',
  437: "test.skip(!isAndroidE2E, 'Android WebView geometry only');",
};

const LINK_TEMPLATES = {
  195: 'formatted_body: `open <a href="https://matrix.to/#/${targetId}">the target room</a>`,',
  260: '`https://matrix.to/#/${encodeURIComponent(remoteAlias)}`,',
  343: '`https://matrix.to/#/${remoteId}?via=${encodeURIComponent(session.secondary!.serverName)}`,',
  384: '`matrix:roomid/${remoteId.slice(1)}?via=${encodeURIComponent(session.secondary!.serverName)}`,',
  449: '`https://matrix.to/#/${targetId}`,',
  560: 'formatted_body: `hey <a href="https://matrix.to/#/${bobId}">${bobName}</a>`,',
};

const REPLACED_WORKAROUNDS = {
  134: 'async function activateRoomLinkPrimary(',
  138: 'if (isAndroidE2E) {',
  141: 'await primary.focus();',
  142: "await page.keyboard.press('Enter');",
  146: 'await primary.click();',
  289: 'await primary.focus();',
  290: "await page.keyboard.press('Enter');",
  298: 'const initiallyDark = await page.evaluate(() =>',
  299: "document.documentElement.classList.contains('dark'),",
  302: "document.documentElement.classList.remove('dark'),",
  307: "await page.evaluate(() => document.documentElement.classList.add('dark'));",
  312: "document.documentElement.classList.toggle('dark', restoreDark);",
  313: '}, initiallyDark);',
  416: 'await primary.focus();',
  417: "await page.keyboard.press('Enter');",
};

function assertionLines(source, start, end) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      const line =
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      if (line >= start && line <= end) lines.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

/** Resolve every identifier call through the TypeChecker, not by spelling. */
function helperBindings(source, span = HELPER_SPAN) {
  const fileName = '/virtual/message-links.spec.mts';
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = {
    getSourceFile: (name) => (name === fileName ? file : undefined),
    getDefaultLibFileName: () => '/virtual/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/virtual',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  };
  const program = ts.createProgram({
    rootNames: [fileName],
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
  const tree = program.getSourceFile(fileName);
  const lineOf = (node) =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const helpers = {};
  const declarations = {};
  const shadowed = {};
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)
        ?.declarations?.[0];
      const name = node.expression.text;
      if (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.parent === tree &&
        lineOf(declaration) >= span[0] &&
        lineOf(declaration) <= span[1]
      ) {
        (helpers[name] ??= []).push(lineOf(node));
        declarations[name] = {
          start: lineOf(declaration),
          end:
            tree.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1,
        };
      } else if (declaration && ts.isVariableDeclaration(declaration)) {
        (shadowed[name] ??= {
          calls: [],
          declaration: lineOf(declaration),
        }).calls.push(lineOf(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { helpers, declarations, shadowed };
}

/** Count helper calls by spelling alone; the control proves binding matters. */
function naiveHelperCalls(source, names) {
  const tree = ts.createSourceFile(
    'naive.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const calls = {};
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.includes(node.expression.text)
    )
      (calls[node.expression.text] ??= []).push(
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      );
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return calls;
}

/**
 * Expand each stage's helper calls into inherited assertion sites, recursing
 * through helper-internal helper calls (localScenario -> loginApi/createRoom).
 */
function expandStages(source) {
  const { helpers, declarations } = helperBindings(source);
  const calls = Object.entries(helpers).flatMap(([helper, lines]) =>
    lines.map((line) => ({ helper, line })),
  );
  const expand = (helper) => {
    const { start, end } = declarations[helper];
    const own = assertionLines(source, start, end).map((line) => ({
      line,
      helper,
    }));
    const nested = calls
      .filter((call) => call.line >= start && call.line <= end)
      .flatMap((call) =>
        expand(call.helper).map((site) => ({ ...site, via: call.line })),
      );
    return [...own, ...nested].sort(
      (a, b) => (a.via ?? a.line) - (b.via ?? b.line),
    );
  };
  return STAGES.map((stage) => {
    const [from, to] = stage.span;
    const inherited = calls
      .filter((call) => call.line >= from && call.line <= to)
      .sort((a, b) => a.line - b.line)
      .flatMap((call) =>
        expand(call.helper).map((site) => ({
          kind: 'inherited',
          line: site.line,
          helper: site.helper,
          call: call.line,
          ...(site.via === undefined ? {} : { via: site.via }),
        })),
      );
    const direct = assertionLines(source, from, to).map((line) => ({
      kind: 'direct',
      line,
    }));
    const order = (site) => (site.kind === 'direct' ? site.line : site.call);
    return [...inherited, ...direct].sort((a, b) => order(a) - order(b));
  });
}

const siteTuple = (site) =>
  site.kind === 'direct'
    ? ['direct', site.line]
    : [
        'inherited',
        site.line,
        site.helper,
        site.call,
        ...(site.via === undefined ? [] : [site.via]),
      ];
const ledgerTuples = (stage) =>
  [
    ...stage.inherited.map(([line, helper, call, via]) => [
      'inherited',
      line,
      helper,
      call,
      ...(via === undefined ? [] : [via]),
    ]),
    ...stage.direct.map((line) => ['direct', line]),
  ].sort(
    (a, b) =>
      (a[0] === 'direct' ? a[1] : a[3]) - (b[0] === 'direct' ? b[1] : b[3]),
  );

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source, { androidSpan = STAGES[5].span } = {}) {
  expect(source.split('\n')).toHaveLength(606);
  expect(source.split('\n').slice(0, 16).join('\n')).toBe(IMPORTS);
  expect(source.split('\n').slice(149, 154).join('\n')).toBe(DESCRIBE_SKIPS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line))).toBe(text);
  expect(source.split('\n')[577].trim()).toBe('if (isAndroidE2E) {');
  expect(source.split('\n')[586].trim()).toBe('return;');
  for (const stage of STAGES) {
    const title = source.split('\n')[stage.span[0] - 1];
    expect(title).toContain(`test('${stage.title}'`);
  }
  for (const [line, text] of Object.entries(LINK_TEMPLATES))
    expect(lineAt(source, Number(line))).toBe(text);
  for (const [line, text] of Object.entries(REPLACED_WORKAROUNDS))
    expect(lineAt(source, Number(line))).toBe(text);
  expect(assertionLines(source, ...HELPER_SPAN)).toEqual(HELPER_SITES);
  expect(assertionLines(source, ...WEB_TAIL)).toEqual(WEB_TAIL_SITES);
  const spans = STAGES.map((stage, index) =>
    index === 5 ? androidSpan : stage.span,
  );
  const direct = spans.map((span) => assertionLines(source, ...span));
  expect(direct).toEqual(STAGES.map((stage) => stage.direct));
  expect(direct.flat()).toHaveLength(38);
  const expanded = expandStages(source);
  expect(expanded.map((sites) => sites.map(siteTuple))).toEqual(
    STAGES.map(ledgerTuples),
  );
  expect(
    expanded.map(
      (sites) => sites.filter((site) => site.kind === 'inherited').length,
    ),
  ).toEqual([1, 6, 6, 6, 5, 1]);
  expect(expanded.flat()).toHaveLength(63);
}

function parseTestUse(source) {
  const tree = ts.createSourceFile(
    'use.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const uses = [];
  const literal = (node) => {
    if (ts.isObjectLiteralExpression(node))
      return Object.fromEntries(
        node.properties.map((property) => {
          expect(ts.isPropertyAssignment(property)).toBe(true);
          return [property.name.getText(tree), literal(property.initializer)];
        }),
      );
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isStringLiteral(node)) return node.text;
    throw new Error(`Unsupported test.use value: ${node.getText(tree)}`);
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'test.use'
    )
      uses.push({
        start: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        end: tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        value: literal(node.arguments[0]),
      });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return uses;
}

/** Portrait profile must equal the predecessor's test.use plus the implicit DPR 1. */
function assertPortraitParity(source, profile) {
  const uses = parseTestUse(source);
  expect(uses).toHaveLength(1);
  expect(uses[0].start).toBe(427);
  expect(uses[0].end).toBe(431);
  const { viewport, hasTouch, isMobile, ...rest } = uses[0].value;
  expect(rest).toEqual({});
  expect(profile).toEqual({
    width: viewport.width,
    height: viewport.height,
    isMobile,
    hasTouch,
    deviceScaleFactor: 1,
  });
  expect(Object.hasOwn(profile, 'userAgent')).toBe(false);
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-links predecessor pins', () => {
  it('pins the unchanged predecessor and five shared sources by SHA-256', () => {
    expect(existsSync(resolve(root, predecessor))).toBe(true);
    expect(digest(predecessor)).toBe(PREDECESSOR_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const bytes = readFileSync(resolve(root, predecessor));
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 2] ^= 1;
    expect(sha256(flipped)).not.toBe(PREDECESSOR_SHA256);
    for (const path of Object.keys(SHARED_SHA256)) {
      const shared = Buffer.from(readFileSync(resolve(root, path)));
      shared[0] ^= 1;
      expect(sha256(shared)).not.toBe(SHARED_SHA256[path]);
    }
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-links.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-links');
    }
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(3);
  });

  it('maps the exact direct and helper assertion sites with the house AST rule', () => {
    const source = read(predecessor);
    assertPredecessorShape(source);
    expect(assertionLines(source, 588, 604)).toEqual(WEB_TAIL_SITES);
    for (const stage of STAGES)
      expect(assertionLines(source, ...stage.span)).toEqual(stage.direct);
  });

  it('rejects the issue span 507-604 because it counts the web-only tail (11 sites, 44 total)', () => {
    const source = read(predecessor);
    expect(assertionLines(source, 507, 604)).toHaveLength(11);
    const total = [...STAGES.slice(0, 5).map((stage) => stage.span), [507, 604]]
      .map((span) => assertionLines(source, ...span).length)
      .reduce((sum, count) => sum + count, 0);
    expect(total).toBe(44);
    expect(() =>
      assertPredecessorShape(source, { androidSpan: [507, 604] }),
    ).toThrow();
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // Line 587 or 578 moves.
      mutateLine(source, 577, (line) => `\n${line}`),
      mutateLine(source, 587, () => '      void 0;'),
      mutateLine(source, 578, () => '    if (!isAndroidE2E) {'),
      // A web-tail site is counted as Android.
      mutateLine(source, 587, () => '      expect(1).toBe(1);'),
      // A helper assertion line is dropped.
      mutateLine(source, 58, () => '  void response;'),
      mutateLine(source, 129, () => '  void page;'),
      // A definition title, import, describe skip or test.use drifts.
      source.replace(
        "test('keeps a rejected federated Join",
        "test('keeps a failed federated Join",
      ),
      source.replace(
        'import { registerUser }',
        'import { registerUser as register }',
      ),
      source.replace(
        "'needs a Synapse homeserver (Docker)'",
        "'needs Synapse'",
      ),
      mutateLine(
        source,
        437,
        () => "      test.skip(false, 'Android WebView geometry only');",
      ),
      // Href templates drift.
      mutateLine(source, 260, (line) =>
        line.replace('encodeURIComponent(remoteAlias)', 'remoteAlias'),
      ),
      mutateLine(source, 384, (line) => line.replace('.slice(1)', '')),
      mutateLine(source, 343, (line) =>
        line.replace(
          '?via=${encodeURIComponent(session.secondary!.serverName)}',
          '',
        ),
      ),
      mutateLine(source, 560, (line) => line.replace('${bobId}', '${bobName}')),
      // Replaced workarounds shift.
      mutateLine(source, 142, () => "    await page.keyboard.press('Space');"),
      mutateLine(
        source,
        302,
        () => "      document.documentElement.classList.add('dark'),",
      ),
      // A shadowed local helper call is re-bound to the module helper.
      source.replace(
        'const createRoom = (name: string) =>',
        'const createRoomLocal = (name: string) =>',
      ),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });

  it('parses the portrait test.use and the Android-only skip', async () => {
    const source = read(predecessor);
    expect(parseTestUse(source)).toEqual([
      {
        start: 427,
        end: 431,
        value: {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
        },
      },
    ]);
    const { PORTRAIT_LINK_PROFILE } = await loadContract();
    assertPortraitParity(source, PORTRAIT_LINK_PROFILE);
    for (const profile of [
      { ...PORTRAIT_LINK_PROFILE, height: 843 },
      { ...PORTRAIT_LINK_PROFILE, width: 393 },
      { ...PORTRAIT_LINK_PROFILE, isMobile: false },
      { ...PORTRAIT_LINK_PROFILE, hasTouch: false },
      { ...PORTRAIT_LINK_PROFILE, deviceScaleFactor: 2.75 },
      {
        ...PORTRAIT_LINK_PROFILE,
        userAgent: 'Mozilla/5.0 (Linux; Android 11)',
      },
    ])
      expect(() => assertPortraitParity(source, profile)).toThrow();
    expect(() =>
      assertPortraitParity(
        source.replace('width: 390, height: 844', 'width: 393, height: 727'),
        PORTRAIT_LINK_PROFILE,
      ),
    ).toThrow();
  });
});

describe('Android message-links helper expansion by binding', () => {
  it('resolves module helper calls through the TypeChecker and excludes shadowed locals', () => {
    const source = read(predecessor);
    const { helpers, shadowed } = helperBindings(source);
    expect(helpers).toEqual(HELPER_CALLS);
    expect(shadowed.createRoom).toEqual({
      calls: SHADOWED_CALLS.createRoom[0],
      declaration: SHADOWED_CALLS.createRoom[1],
    });
    expect(shadowed.token).toEqual({
      calls: SHADOWED_CALLS.token[0],
      declaration: SHADOWED_CALLS.token[1],
    });
  });

  it('proves the resolver matters with a naive identifier-count control', () => {
    const source = read(predecessor);
    const naive = naiveHelperCalls(source, Object.keys(HELPER_CALLS));
    expect(naive.createRoom).toEqual([120, 183, 184, 248, 334, 375, 441]);
    expect(naive.createRoom).not.toEqual(HELPER_CALLS.createRoom);
    const naiveCreations = naive.createRoom.length + naive.localScenario.length;
    expect(naiveCreations).toBe(11);
    expect(
      HELPER_CALLS.createRoom.length - 1 + HELPER_CALLS.localScenario.length,
    ).toBe(8);
  });

  it('expands 4 logins + 3 registrations + 8 Rooms + 4 sends + 6 opens = 25', () => {
    const expanded = expandStages(read(predecessor)).flat();
    const inherited = expanded.filter((site) => site.kind === 'inherited');
    const byHelper = (helper) =>
      inherited.filter((site) => site.helper === helper).length;
    expect([
      byHelper('loginApi'),
      byHelper('registerRemote'),
      byHelper('createRoom'),
      byHelper('sendRoomLink'),
      byHelper('openRoom'),
    ]).toEqual([4, 3, 8, 4, 6]);
    expect(inherited).toHaveLength(25);
    expect(byHelper('activateRoomLinkPrimary')).toBe(0);
    expect(expanded.filter((site) => site.kind === 'direct')).toHaveLength(38);
  });

  it('matches the contract sites, including each call and via line', async () => {
    const { MESSAGE_LINKS_STAGES } = await loadContract();
    const expanded = expandStages(read(predecessor));
    expect(
      MESSAGE_LINKS_STAGES.map((entry) => entry.sites.map(siteTuple)),
    ).toEqual(expanded.map((sites) => sites.map(siteTuple)));
    for (const [index, entry] of MESSAGE_LINKS_STAGES.entries())
      expect(entry.sites.map((site) => site.suffix)).toEqual(
        STAGES[index].suffixes,
      );
    const dropped = expanded.map((sites, index) =>
      index === 1 ? sites.slice(1) : sites,
    );
    expect(
      MESSAGE_LINKS_STAGES.map((entry) => entry.sites.map(siteTuple)),
    ).not.toEqual(dropped.map((sites) => sites.map(siteTuple)));
  });
});

/* ------------------------------------------------------------------------ */
/* Two-server fixture with an injected fetch                                 */
/* ------------------------------------------------------------------------ */

const REMOTE_SERVER = 'remote.test';
const SECONDARY = { hs: SECONDARY_HTTP, serverName: REMOTE_SERVER };
const localAccount = (role) => ({
  username: `ml-${role}`,
  userId: `@ml-${role}:localhost`,
  password: `password-${role}`,
  homeserver: SYNAPSE_HTTP,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * A fake primary + secondary Matrix pair. Every request is logged with its
 * decoded path, server, method, body and whether its signal was already aborted.
 */
function twoServers(options = {}) {
  const log = [];
  const rooms = new Map();
  const aliases = new Map();
  const events = new Map();
  let serial = 0;
  const probes = {
    alias: [...(options.aliasProbe ?? [200])],
    profile: [...(options.profileProbe ?? [200])],
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const server =
      origin === SYNAPSE_HTTP
        ? 'primary'
        : origin === SECONDARY_HTTP
          ? 'secondary'
          : 'other';
    const path = decodeURIComponent(
      parsed.pathname.replace('/_matrix/client/v3', ''),
    );
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const entry = {
      server,
      method,
      path,
      body,
      url: String(url),
      aborted: Boolean(init.signal?.aborted),
      authorization: init.headers?.Authorization,
    };
    log.push(entry);
    const failure = options.fail?.(entry);
    if (failure)
      return json({ errcode: failure.errcode ?? 'M_UNKNOWN' }, failure.status);
    if (server === 'other') return json({ errcode: 'M_NOT_FOUND' }, 404);
    if (server === 'primary') {
      if (path === '/login')
        return json({
          user_id: options.loginUserId ?? `@${body.identifier.user}:localhost`,
          access_token: `syt_primary_${++serial}`,
        });
      if (path === '/logout') return json({});
      if (
        path.startsWith('/rooms/') &&
        path.includes('/send/m.room.message/')
      ) {
        const eventId = `$event-${++serial}`;
        events.set(eventId, body);
        return json({ event_id: eventId });
      }
      if (path.startsWith('/rooms/') && path.includes('/event/')) {
        const eventId = path.split('/event/')[1];
        return json({ type: 'm.room.message', content: events.get(eventId) });
      }
      if (path.startsWith('/directory/room/')) {
        const status =
          probes.alias.length > 1 ? probes.alias.shift() : probes.alias[0];
        if (status !== 200) return json({ errcode: 'M_UNKNOWN' }, status);
        return json({
          room_id:
            options.aliasRoomId ??
            aliases.get(path.slice('/directory/room/'.length)),
        });
      }
      if (path.startsWith('/profile/') && path.endsWith('/displayname'))
        return options.displayName === undefined
          ? json({ errcode: 'M_NOT_FOUND' }, 404)
          : json({ displayname: options.displayName });
      if (path.startsWith('/profile/')) {
        const status =
          probes.profile.length > 1
            ? probes.profile.shift()
            : probes.profile[0];
        return status === 200
          ? json({})
          : json(
              { errcode: status === 429 ? 'M_LIMIT_EXCEEDED' : 'M_FORBIDDEN' },
              status,
            );
      }
      if (path === '/joined_rooms')
        return json({ joined_rooms: options.primaryJoined?.() ?? [] });
      if (path.endsWith('/leave') || path.endsWith('/forget')) return json({});
      return json({ errcode: 'M_UNRECOGNIZED' }, 400);
    }
    if (path === '/register')
      return json({
        user_id:
          options.registeredUserId ?? `@${body.username}:${REMOTE_SERVER}`,
        access_token: `syt_remote_${++serial}`,
      });
    if (path === '/logout') return json({});
    if (path === '/createRoom') {
      const id = `!remote-${++serial}:${REMOTE_SERVER}`;
      const room = {
        name: body.name,
        topic: body.topic,
        joinRule: body.preset === 'public_chat' ? 'public' : 'invite',
        visibility: body.visibility ?? 'private',
        members: new Map(),
      };
      rooms.set(id, room);
      if (body.room_alias_name)
        aliases.set(`#${body.room_alias_name}:${REMOTE_SERVER}`, id);
      // The secondary committed the Room, but its response never arrives.
      if (options.loseCreateResponse)
        throw new DOMException('The operation timed out.', 'TimeoutError');
      return json({ room_id: id });
    }
    if (path === '/joined_rooms')
      return json({ joined_rooms: [...rooms.keys()] });
    const state = /^\/rooms\/([^/]+)\/state\/([^/]+)\/?(.*)$/u.exec(path);
    if (state) {
      const room = rooms.get(state[1]);
      if (method === 'PUT' && state[2] === 'm.room.join_rules') {
        room.joinRule = options.ignoreJoinRuleChange
          ? room.joinRule
          : body.join_rule;
        return json({ event_id: `$state-${++serial}` });
      }
      if (state[2] === 'm.room.name')
        return json({ name: options.readBackName ?? room.name });
      if (state[2] === 'm.room.topic')
        return json({ topic: options.readBackTopic ?? room.topic });
      if (state[2] === 'm.room.join_rules')
        return json({ join_rule: options.readBackJoinRule ?? room.joinRule });
      if (state[2] === 'm.room.member') {
        const membership = options.membership?.(state[3]);
        return membership === undefined
          ? json({ errcode: 'M_NOT_FOUND' }, 404)
          : json({ membership });
      }
    }
    if (path.startsWith('/directory/room/')) {
      if (method === 'DELETE') return json({ errcode: 'M_NOT_FOUND' }, 404);
      const alias = path.slice('/directory/room/'.length);
      return json({ room_id: options.remoteAliasRoomId ?? aliases.get(alias) });
    }
    if (path.startsWith('/directory/list/room/')) {
      if (method === 'PUT') return json({});
      const room = rooms.get(path.slice('/directory/list/room/'.length));
      return json({
        visibility: options.readBackVisibility ?? room.visibility,
      });
    }
    if (path.endsWith('/leave') || path.endsWith('/forget')) return json({});
    return json({ errcode: 'M_UNRECOGNIZED' }, 400);
  };
  return { fetchImpl, log };
}

function fakeResources() {
  const cleanups = [];
  return {
    cleanups,
    resources: {
      cleanup: (label, operation) => cleanups.push({ label, operation }),
      aliasLocalpart: (purpose) => `trn-${purpose}`,
    },
  };
}

async function fixtureFor(options = {}) {
  const { createMessageLinksFixtures } = await loadFixtures();
  const server = twoServers(options);
  const { resources, cleanups } = fakeResources();
  const controller = new AbortController();
  const links = createMessageLinksFixtures({
    resources,
    signal: controller.signal,
    secondary: SECONDARY,
    fetchImpl: server.fetchImpl,
  });
  return { links, server, cleanups, controller };
}

/**
 * The real base account fixtures against the fake primary, through a stubbed global
 * fetch and a temporary session descriptor, sharing one namespace with the
 * two-server fixture exactly as the runner registers them.
 */
async function withBaseFixtures(options, operation) {
  const { createAccountFixtures } =
    await import('../e2e/android/account-workspace-fixtures.mts');
  const { createMessageLinksFixtures } = await loadFixtures();
  const { createTestResourceNamespace } =
    await import('../e2e/support/namespace.mts');
  const { MatrixTestResources } =
    await import('../e2e/support/test-resources.mts');
  const { writeSession } = await import('../e2e/support/session.mts');
  const directory = await mkdtemp(join(tmpdir(), 'message-links-base-'));
  const sessionFile = join(directory, 'session.json');
  writeSession(sessionFile, {
    version: 1,
    id: 'message-links-guard',
    workspaceRoot: root,
    owner: {
      pid: process.pid,
      nonce: 'guard-nonce',
      createdAt: new Date(0).toISOString(),
    },
    resources: ['synapse'],
    endpoints: {
      application: 'http://127.0.0.1:4200/',
      storybook: 'http://127.0.0.1:6006/',
      report: 'http://127.0.0.1:9323/',
    },
    artifactsRoot: directory,
    synapse: {
      available: true,
      hs: SYNAPSE_HTTP,
      user: 'guard',
      pass: 'guard',
    },
  });
  const server = twoServers({
    ...options,
    membership: options.membership
      ? (user) => options.membership(user, options)
      : undefined,
    primaryJoined: options.primaryJoined
      ? () => options.primaryJoined(options)
      : undefined,
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/_synapse/admin/v1/register')
      return server.fetchImpl(url, init);
    return init.method === 'POST'
      ? json({ user_id: `@${JSON.parse(init.body).username}:localhost` })
      : json({ nonce: 'guard-nonce' });
  };
  vi.stubEnv('TRINITY_E2E_SESSION_FILE', sessionFile);
  vi.stubGlobal('fetch', fetchImpl);
  try {
    const namespace = createTestResourceNamespace({
      sessionId: 'guard',
      suiteId: 'android.message-links',
      workerIndex: 0,
      testId: 'join-cleanup',
      retry: 0,
    });
    const matrixResources = new MatrixTestResources(namespace);
    const signal = new AbortController().signal;
    const links = createMessageLinksFixtures({
      resources: matrixResources,
      signal,
      secondary: SECONDARY,
      fetchImpl,
    });
    const createBase = (resources = matrixResources) =>
      createAccountFixtures(resources, signal);
    return await operation({
      base: options.lazyBase ? undefined : createBase(),
      createBase,
      links,
      namespace,
      matrixResources,
      MatrixTestResources,
      server,
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

const PUBLIC_ROOM = {
  name: 'Federated Room run-f',
  topic: `Served by ${REMOTE_SERVER}`,
  preset: 'public_chat',
  visibility: 'public',
  aliasLocalpart: 'federated-run-f',
};

describe('Android message-links two-server fixture', () => {
  it('reads a fail-closed secondary descriptor from the session', async () => {
    const { readSecondary, createMessageLinksFixtures } = await loadFixtures();
    const session = (secondary, available = true) => ({
      synapse: { available, secondary },
    });
    const valid = {
      hs: SECONDARY_HTTP,
      serverName: REMOTE_SERVER,
      registrationSecret: 'registration-secret',
    };
    expect(readSecondary(session(valid))).toEqual({
      hs: SECONDARY_HTTP,
      serverName: REMOTE_SERVER,
    });
    for (const invalid of [
      session(undefined),
      session(valid, false),
      session({ ...valid, serverName: '' }),
      session({ ...valid, hs: SYNAPSE_HTTP }),
      session({ ...valid, hs: '' }),
      session({ ...valid, registrationSecret: '' }),
    ])
      expect(() => readSecondary(invalid)).toThrow();
    expect(SECONDARY_HTTP).not.toBe(SYNAPSE_HTTP);
    const { resources } = fakeResources();
    expect(() =>
      createMessageLinksFixtures({
        resources,
        signal: new AbortController().signal,
        secondary: { hs: SYNAPSE_HTTP, serverName: REMOTE_SERVER },
        fetchImpl: twoServers().fetchImpl,
      }),
    ).toThrow();
  });

  it('logs in on the primary only and requires the exact returned user', async () => {
    const { links, server } = await fixtureFor();
    const local = localAccount('federated');
    await expect(links.apiLogin(local)).resolves.toEqual({
      userId: local.userId,
    });
    expect(
      server.log.map(({ server: name, method, path }) => [name, method, path]),
    ).toEqual([['primary', 'POST', '/login']]);
    const wrong = await fixtureFor({ loginUserId: '@other:localhost' });
    await expect(wrong.links.apiLogin(local)).rejects.toThrow();
  });

  it('registers remote accounts on the secondary and rejects a primary-server user id', async () => {
    const { links, server } = await fixtureFor();
    await expect(links.registerRemote('remote-run-f')).resolves.toEqual({
      userId: `@remote-run-f:${REMOTE_SERVER}`,
      localpart: 'remote-run-f',
    });
    expect(server.log).toHaveLength(1);
    expect(server.log[0]).toMatchObject({
      server: 'secondary',
      method: 'POST',
      path: '/register',
    });
    expect(server.log[0].url.startsWith(`${SECONDARY_HTTP}/`)).toBe(true);
    expect(server.log[0].url.startsWith(`${SYNAPSE_HTTP}/`)).toBe(false);
    expect(server.log[0].body).toMatchObject({
      auth: { type: 'm.login.dummy' },
      username: 'remote-run-f',
    });
    const localhost = await fixtureFor({
      registeredUserId: '@remote-run-f:localhost',
    });
    await expect(
      localhost.links.registerRemote('remote-run-f'),
    ).rejects.toThrow();
  });

  it('reads back name, topic, join rule, alias and directory for a created remote Room', async () => {
    const { links, server } = await fixtureFor();
    const remote = await links.registerRemote('remote-run-f');
    const room = await links.createRemoteRoom(remote, PUBLIC_ROOM);
    expect(room).toMatchObject({
      alias: `#federated-run-f:${REMOTE_SERVER}`,
      joinRule: 'public',
      name: PUBLIC_ROOM.name,
      topic: PUBLIC_ROOM.topic,
      published: true,
    });
    const reads = server.log
      .filter((entry) => entry.method === 'GET')
      .map((entry) => [entry.server, entry.path]);
    expect(reads).toEqual([
      ['secondary', `/rooms/${room.id}/state/m.room.name`],
      ['secondary', `/rooms/${room.id}/state/m.room.topic`],
      ['secondary', `/rooms/${room.id}/state/m.room.join_rules`],
      ['secondary', `/directory/room/#federated-run-f:${REMOTE_SERVER}`],
      ['secondary', `/directory/list/room/${room.id}`],
    ]);
    const privateRoom = await fixtureFor();
    const owner = await privateRoom.links.registerRemote('private-run-x');
    await expect(
      privateRoom.links.createRemoteRoom(owner, {
        name: 'Private run-x',
        preset: 'private_chat',
      }),
    ).resolves.toMatchObject({ joinRule: 'invite', published: false });
    for (const change of [
      { readBackName: 'Federated Room run-g' },
      { readBackTopic: 'Served by localhost' },
      { readBackJoinRule: 'invite' },
      { remoteAliasRoomId: '!other:remote.test' },
      { readBackVisibility: 'private' },
    ]) {
      const broken = await fixtureFor(change);
      const owner = await broken.links.registerRemote('remote-run-f');
      await expect(
        broken.links.createRemoteRoom(owner, PUBLIC_ROOM),
      ).rejects.toThrow();
    }
  });

  it('sends exact formatted links only through an apiLogin session', async () => {
    const { links, server } = await fixtureFor();
    const local = localAccount('federated');
    const href = `https://matrix.to/#/${encodeURIComponent(`#federated-run-f:${REMOTE_SERVER}`)}`;
    await expect(
      links.sendRoomLink(
        local,
        '!source:localhost',
        href,
        'open the federated room',
        'link-run-f',
      ),
    ).rejects.toThrow();
    await links.apiLogin(local);
    const { eventId } = await links.sendRoomLink(
      local,
      '!source:localhost',
      href,
      'open the federated room',
      'link-run-f',
    );
    const send = server.log.find((entry) => entry.method === 'PUT');
    expect(send).toMatchObject({
      server: 'primary',
      path: '/rooms/!source:localhost/send/m.room.message/link-run-f',
      body: {
        msgtype: 'm.text',
        body: 'open the federated room',
        format: 'org.matrix.custom.html',
        formatted_body: `<a href="${href}">open the federated room</a>`,
      },
    });
    await expect(
      links.event(local, '!source:localhost', eventId),
    ).resolves.toEqual({
      body: 'open the federated room',
      format: 'org.matrix.custom.html',
      formattedBody: `<a href="${href}">open the federated room</a>`,
    });
  });

  it('bounds federation probes and tolerates only 404/502/503/504', async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.MESSAGE_LINKS_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(fixtures.MESSAGE_LINKS_PROBE_INTERVAL_MS).toBe(1_000);
    expect(fixtures.MESSAGE_LINKS_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect([...fixtures.MESSAGE_LINKS_PROBE_TOLERATED_STATUSES]).toEqual([
      404, 502, 503, 504,
    ]);
    const local = localAccount('federated');
    const alias = `#federated-run-f:${REMOTE_SERVER}`;
    const warm = await fixtureFor({
      aliasProbe: [502, 200],
      aliasRoomId: '!remote-1:remote.test',
    });
    await warm.links.apiLogin(local);
    await expect(
      warm.links.awaitAliasFederation(local, alias, '!remote-1:remote.test'),
    ).resolves.toMatchObject({ polls: 2 });
    const wrongRoom = await fixtureFor({ aliasRoomId: '!other:remote.test' });
    await wrongRoom.links.apiLogin(local);
    await expect(
      wrongRoom.links.awaitAliasFederation(
        local,
        alias,
        '!remote-1:remote.test',
      ),
    ).rejects.toThrow();
    for (const status of [403, 500, 429]) {
      const failing = await fixtureFor({ profileProbe: [status] });
      await failing.links.apiLogin(local);
      const started = Date.now();
      const failure = await failing.links
        .awaitProfileFederation(local, `@remote-run-x:${REMOTE_SERVER}`)
        .then(
          () => undefined,
          (error) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain(`HTTP ${status}`);
      if (status === 429) expect(failure.message).toContain('M_LIMIT_EXCEEDED');
      expect(failure.message).not.toContain('remote-run-x');
      expect(Date.now() - started).toBeLessThan(900);
      expect(
        failing.server.log.filter((entry) =>
          entry.path.startsWith('/profile/'),
        ),
      ).toHaveLength(1);
    }
  });

  it('changes the join rule with a read-back and reports memberships per server', async () => {
    const { links } = await fixtureFor({
      membership: (userId) =>
        userId === '@ml-federated:localhost' ? 'join' : undefined,
    });
    const remote = await links.registerRemote('retry-run-r');
    const room = await links.createRemoteRoom(remote, {
      name: 'Join Retry run-r',
      preset: 'public_chat',
    });
    expect(room).toMatchObject({ joinRule: 'public', published: false });
    await expect(
      links.setRemoteJoinRule(remote, room.id, 'invite'),
    ).resolves.toMatchObject({ readBack: 'invite' });
    await expect(links.remoteJoinRule(remote, room.id)).resolves.toBe('invite');
    await expect(
      links.remoteMembership(remote, room.id, '@ml-federated:localhost'),
    ).resolves.toBe('join');
    await expect(
      links.remoteMembership(remote, room.id, '@ml-other:localhost'),
    ).resolves.toBe('absent');
    const ignored = await fixtureFor({ ignoreJoinRuleChange: true });
    const owner = await ignored.links.registerRemote('retry-run-r');
    const unchanged = await ignored.links.createRemoteRoom(owner, {
      name: 'Join Retry run-r',
      preset: 'public_chat',
    });
    await expect(
      ignored.links.setRemoteJoinRule(owner, unchanged.id, 'invite'),
    ).rejects.toThrow();
  });

  it('reads the primary display-name receipt used before the S6 UI steps', async () => {
    const named = await fixtureFor({ displayName: 'Bobbyrun-u' });
    await expect(
      named.links.displayName(localAccount('owner'), '@ml-bob:localhost'),
    ).resolves.toBe('Bobbyrun-u');
    expect(named.server.log.at(-1)).toMatchObject({
      server: 'primary',
      path: '/profile/@ml-bob:localhost/displayname',
    });
    const missing = await fixtureFor();
    await expect(
      missing.links.displayName(localAccount('owner'), '@ml-bob:localhost'),
    ).resolves.toBeUndefined();
  });
});

describe('Android message-links two-server cleanup', () => {
  it('runs after the base cleanup, then primary logout, remote Rooms in reverse and remote logout', async () => {
    const { createMessageLinksFixtures } = await loadFixtures();
    const { createTestResourceNamespace } =
      await import('../e2e/support/namespace.mts');
    const { MatrixTestResources } =
      await import('../e2e/support/test-resources.mts');
    const namespace = createTestResourceNamespace({
      sessionId: 'guard',
      suiteId: 'android.message-links',
      workerIndex: 0,
      testId: 'cleanup-order',
      retry: 0,
    });
    const resources = new MatrixTestResources(namespace);
    const server = twoServers();
    const controller = new AbortController();
    const order = [];
    const links = createMessageLinksFixtures({
      resources,
      signal: controller.signal,
      secondary: SECONDARY,
      fetchImpl: server.fetchImpl,
    });
    // Stands in for createAccountFixtures(resources, signal), registered after.
    resources.cleanup('Account workspace fixtures', async () => {
      order.push('base');
    });
    const local = localAccount('federated');
    await links.apiLogin(local);
    const remote = await links.registerRemote('remote-run-f');
    const first = await links.createRemoteRoom(remote, PUBLIC_ROOM);
    const second = await links.createRemoteRoom(remote, {
      name: 'Join Retry run-r',
      preset: 'public_chat',
    });
    const before = server.log.length;
    controller.abort(new Error('test signal aborted'));
    const push = server.log.push.bind(server.log);
    server.log.push = (...entries) => {
      if (!order.includes('base')) order.push('links-before-base');
      return push(...entries);
    };
    await namespace.cleanup();
    expect(order[0]).toBe('base');
    expect(order).not.toContain('links-before-base');
    const cleanup = server.log.slice(before);
    expect(cleanup.every((entry) => entry.aborted === false)).toBe(true);
    expect(
      cleanup.map(({ server: name, method, path }) => [name, method, path]),
    ).toEqual([
      ['primary', 'POST', '/logout'],
      ['secondary', 'PUT', `/directory/list/room/${second.id}`],
      ['secondary', 'POST', `/rooms/${second.id}/leave`],
      ['secondary', 'POST', `/rooms/${second.id}/forget`],
      ['secondary', 'DELETE', `/directory/room/${first.alias}`],
      ['secondary', 'PUT', `/directory/list/room/${first.id}`],
      ['secondary', 'POST', `/rooms/${first.id}/leave`],
      ['secondary', 'POST', `/rooms/${first.id}/forget`],
      ['secondary', 'POST', '/logout'],
    ]);
    expect(cleanup[1].body).toEqual({ visibility: 'private' });
    expect(cleanup[5].body).toEqual({ visibility: 'private' });
  });

  it('runs every step after a failure and aggregates, including after partial setup', async () => {
    const failing = (entry) =>
      entry.method === 'PUT' && entry.path.startsWith('/directory/list/room/')
        ? { status: 500 }
        : entry.method === 'POST' &&
            entry.path === '/logout' &&
            entry.server === 'primary'
          ? { status: 500 }
          : undefined;
    let armed = false;
    const { links, server, cleanups, controller } = await fixtureFor({
      readBackName: 'A different name',
      fail: (entry) => (armed ? failing(entry) : undefined),
    });
    await links.apiLogin(localAccount('federated'));
    const remote = await links.registerRemote('remote-run-f');
    // The read-back fails after createRoom: the Room must still be cleaned up.
    await expect(links.createRemoteRoom(remote, PUBLIC_ROOM)).rejects.toThrow();
    expect(cleanups).toHaveLength(1);
    armed = true;
    controller.abort();
    const before = server.log.length;
    const failure = await cleanups[0].operation().then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    const steps = server.log
      .slice(before)
      .map(({ server: name, method, path }) => [
        name,
        method,
        path.replace(/![^/]+/u, '!room'),
      ]);
    expect(steps).toEqual([
      ['primary', 'POST', '/logout'],
      [
        'secondary',
        'DELETE',
        `/directory/room/#federated-run-f:${REMOTE_SERVER}`,
      ],
      ['secondary', 'PUT', '/directory/list/room/!room'],
      ['secondary', 'POST', '/rooms/!room/leave'],
      ['secondary', 'POST', '/rooms/!room/forget'],
      ['secondary', 'POST', '/logout'],
    ]);
    expect(server.log.slice(before).every((entry) => !entry.aborted)).toBe(
      true,
    );
    for (const error of failure.errors) {
      expect(String(error.message)).not.toMatch(
        /syt_|!remote|@ml-|remote-run-f/u,
      );
    }
  });

  it('cleans up a remote Room whose create response was lost, from its alias or its owner', async () => {
    // S2 shape: the alias resolves the committed Room, then every step runs.
    const lost = await fixtureFor({ loseCreateResponse: true });
    const aliased = await lost.links.registerRemote('remote-run-f');
    await expect(
      lost.links.createRemoteRoom(aliased, PUBLIC_ROOM),
    ).rejects.toThrow(/did not complete \(TimeoutError\)/u);
    let before = lost.server.log.length;
    await lost.cleanups[0].operation();
    const alias = `#federated-run-f:${REMOTE_SERVER}`;
    const steps = (log, from) =>
      log
        .slice(from)
        .map(({ server: name, method, path }) => [
          name,
          method,
          path.replace(/![^/]+/u, '!room'),
        ]);
    expect(steps(lost.server.log, before)).toEqual([
      ['secondary', 'GET', `/directory/room/${alias}`],
      ['secondary', 'DELETE', `/directory/room/${alias}`],
      ['secondary', 'PUT', '/directory/list/room/!room'],
      ['secondary', 'POST', '/rooms/!room/leave'],
      ['secondary', 'POST', '/rooms/!room/forget'],
      ['secondary', 'POST', '/logout'],
    ]);

    // S4 shape: no alias, so the fresh owner's joined Rooms name it, once.
    const unnamed = await fixtureFor({ loseCreateResponse: true });
    const owner = await unnamed.links.registerRemote('retry-run-r');
    await expect(
      unnamed.links.createRemoteRoom(owner, {
        name: 'Join Retry run-r',
        preset: 'public_chat',
      }),
    ).rejects.toThrow(/did not complete/u);
    before = unnamed.server.log.length;
    await unnamed.cleanups[0].operation();
    expect(steps(unnamed.server.log, before)).toEqual([
      ['secondary', 'GET', '/joined_rooms'],
      ['secondary', 'PUT', '/directory/list/room/!room'],
      ['secondary', 'POST', '/rooms/!room/leave'],
      ['secondary', 'POST', '/rooms/!room/forget'],
      ['secondary', 'POST', '/logout'],
    ]);

    // An HTTP error means nothing was created: never touch an alias it did not make.
    const refused = await fixtureFor({
      fail: (entry) =>
        entry.path === '/createRoom'
          ? { status: 400, errcode: 'M_ROOM_IN_USE' }
          : undefined,
    });
    const refusedOwner = await refused.links.registerRemote('remote-run-f');
    await expect(
      refused.links.createRemoteRoom(refusedOwner, PUBLIC_ROOM),
    ).rejects.toThrow(/HTTP 400 M_ROOM_IN_USE/u);
    before = refused.server.log.length;
    await refused.cleanups[0].operation();
    expect(steps(refused.server.log, before)).toEqual([
      ['secondary', 'POST', '/logout'],
    ]);

    // The Room is recorded before its create request, never after the response.
    const fixtures = read(FIXTURES);
    const create = fixtures.slice(
      fixtures.indexOf('async function createRemoteRoom('),
    );
    expect(create.indexOf('remoteRooms.push(')).toBeGreaterThan(-1);
    expect(create.indexOf('remoteRooms.push(')).toBeLessThan(
      create.indexOf("'/createRoom'"),
    );
  });

  it('hands a Join that landed before membership proof #1 to the base cleanup', async () => {
    const { afterJoinTap } = await loadJourneys();
    const scenario = async (landing, tap) =>
      withBaseFixtures(landing, async ({ base, links, namespace, server }) => {
        const local = await base.account('ml-federated');
        const remote = await links.registerRemote('remote-run-f');
        const room = await links.createRemoteRoom(remote, PUBLIC_ROOM);
        landing.local = local.userId;
        landing.roomId = room.id;
        const outcome = await tap(
          { base, links },
          { local, remote, roomId: room.id },
        ).then(
          () => undefined,
          (error) => error,
        );
        const before = server.log.length;
        await namespace.cleanup().catch(() => undefined);
        const primary = server.log
          .slice(before)
          .filter((entry) => entry.server === 'primary')
          .map(({ method, path }) => `${method} ${path}`);
        return { outcome, primary, roomId: room.id };
      });
    // The stage fails between the native Join tap and membership proof #1.
    const failAfterTap = (context, join) =>
      afterJoinTap(context, join, async () => {
        throw new Error('joined-notice failed');
      });
    const joined = () => ({
      membership: (user, landing) =>
        user === landing.local ? 'join' : undefined,
      primaryJoined: (landing) => [landing.roomId],
    });

    const landed = await scenario(joined(), failAfterTap);
    expect(landed.outcome.message).toBe('joined-notice failed');
    expect(landed.primary).toEqual(
      expect.arrayContaining([
        `POST /rooms/${landed.roomId}/leave`,
        `POST /rooms/${landed.roomId}/forget`,
      ]),
    );

    // The secondary saw the Join before the primary did: still left.
    const secondaryOnly = await scenario(
      { ...joined(), primaryJoined: () => [] },
      failAfterTap,
    );
    expect(secondaryOnly.primary).toContain(
      `POST /rooms/${secondaryOnly.roomId}/leave`,
    );

    // Neither read can run: the Room is still handed over, and the failure says so.
    const unread = await scenario(
      {
        fail: (entry) =>
          entry.path === '/joined_rooms' || entry.path.includes('m.room.member')
            ? { status: 500 }
            : undefined,
      },
      failAfterTap,
    );
    expect(unread.outcome).toBeInstanceOf(AggregateError);
    expect(unread.outcome.errors[0].message).toBe('joined-notice failed');
    expect(unread.primary).toContain(`POST /rooms/${unread.roomId}/leave`);

    // The Join never landed: the Room is never tracked, so nothing leaves it.
    const rejected = await scenario({ primaryJoined: () => [] }, failAfterTap);
    expect(rejected.outcome.message).toBe('joined-notice failed');
    expect(
      rejected.primary.some((line) => line.includes(rejected.roomId)),
    ).toBe(false);

    // A passing window never tracks the Room.
    const passed = await scenario(joined(), (context, join) =>
      afterJoinTap(context, join, async () => 'membership-1'),
    );
    expect(passed.outcome).toBeUndefined();
    expect(passed.primary.some((line) => line.includes(passed.roomId))).toBe(
      false,
    );

    // Negative control: the same failure without the handover leaks the Room.
    const leaked = await scenario(joined(), async () => {
      throw new Error('joined-notice failed');
    });
    expect(leaked.primary.some((line) => line.includes(leaked.roomId))).toBe(
      false,
    );
  });

  it('keeps Room ids out of the rethrown base cleanup failure and in the report', async () => {
    const { guardMessageLinksCleanup, redactCleanupFailure } =
      await loadJourneys();
    const { inspect } = await import('node:util');
    const run = async (guarded) =>
      withBaseFixtures(
        {
          lazyBase: true,
          fail: (entry) =>
            entry.server === 'primary' && entry.path.endsWith('/forget')
              ? { status: 400 }
              : undefined,
        },
        async ({
          matrixResources,
          MatrixTestResources,
          namespace,
          links,
          createBase,
        }) => {
          const safety = {
            unsafeSecrets: false,
            cleanupFailed: false,
            scrubFailed: false,
          };
          const stage = { status: 'running', failureCount: 0 };
          const report = { status: 'running', stages: [stage] };
          let saves = 0;
          const resources = new MatrixTestResources(namespace);
          if (guarded)
            resources.cleanup = guardMessageLinksCleanup(
              (label, action) => matrixResources.cleanup(label, action),
              { safety, report, save: async () => void saves++ },
            );
          const base = createBase(resources);
          const local = await base.account('ml-federated');
          const remote = await links.registerRemote('remote-run-f');
          const room = await links.createRemoteRoom(remote, PUBLIC_ROOM);
          base.trackRoomMembership(local, room.id);
          base.allowEndedMembershipCleanup(local, room.id);
          const error = await namespace.cleanup().then(
            () => undefined,
            (failure) => failure,
          );
          return {
            printed: inspect(error, { depth: null, colors: false }),
            report,
            safety,
            saves,
            roomId: room.id,
          };
        },
      );
    const guarded = await run(true);
    const forms = (roomId) => [
      roomId,
      encodeURIComponent(roomId),
      roomId.slice(1),
      encodeURIComponent(roomId.slice(1)),
    ];
    for (const form of forms(guarded.roomId))
      expect(guarded.printed).not.toContain(form);
    expect(guarded.printed).toContain(
      'Message-links cleanup failed: cleanup fixture rooms and accounts (MatrixFixtureHttpError HTTP 400)',
    );
    expect(guarded.safety.cleanupFailed).toBe(true);
    expect(guarded.report.status).toBe('failed');
    expect(guarded.report.stages[0].status).toBe('failed');
    expect(guarded.report.stages[0].error).toContain(
      `/rooms/${encodeURIComponent(guarded.roomId)}/forget failed with HTTP 400`,
    );
    expect(guarded.saves).toBeGreaterThan(0);

    // Negative control: the unguarded rethrow prints the encoded Room id.
    const unguarded = await run(false);
    expect(unguarded.printed).toContain(encodeURIComponent(unguarded.roomId));

    // Fixture HTTP errors are templated and keep their text; other text is dropped.
    const { MessageLinksHttpError } = await loadFixtures();
    const redacted = redactCleanupFailure(
      'Message-links two-server REST cleanup',
      new AggregateError([
        new MessageLinksHttpError(
          'secondary',
          'POST',
          '/rooms/{roomId}/forget',
          500,
          'M_UNKNOWN',
        ),
        new Error('leave /rooms/!secret:remote.test failed'),
        Object.assign(new Error('POST /rooms/%21secret failed'), {
          status: 403,
        }),
      ]),
    );
    expect(redacted.message).toBe(
      'Message-links cleanup failed: Message-links two-server REST cleanup (Message-links secondary POST /rooms/{roomId}/forget failed with HTTP 500 M_UNKNOWN; Error; Error HTTP 403)',
    );
    expect(redacted.cause).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/* Contract: ledger, profiles and pure asserters                             */
/* ------------------------------------------------------------------------ */

/** Independent ledger check applied to the contract and to mutated copies. */
function assertLedger(stages) {
  expect(stages.map((entry) => entry.id)).toEqual(
    STAGES.map((stage) => stage.id),
  );
  expect(stages.map((entry) => entry.sites.length)).toEqual([
    6, 16, 9, 12, 14, 6,
  ]);
  expect(
    stages.map(
      (entry) => entry.sites.filter((site) => site.kind === 'direct').length,
    ),
  ).toEqual([5, 10, 3, 6, 9, 5]);
  expect(
    stages.map(
      (entry) => entry.sites.filter((site) => site.kind === 'inherited').length,
    ),
  ).toEqual([1, 6, 6, 6, 5, 1]);
  const all = stages.flatMap((entry) => entry.assertions);
  expect(all).toHaveLength(63);
  expect(new Set(all).size).toBe(63);
  expect(all).toEqual(ALL_IDENTITIES);
  for (const [index, entry] of stages.entries()) {
    const stage = STAGES[index];
    expect(entry.expectedAssertionRecords).toBe(stage.suffixes.length);
    expect(entry.assertions).toEqual(identities(stage));
    expect(entry.source).toBe(
      `${predecessor}:${stage.span[0]}-${stage.span[1]}`,
    );
    expect(entry.title).toBe(stage.title);
  }
}

const sourceRoute = (roomId, userId = '@ml-l:localhost') =>
  `https://localhost/rooms/${Buffer.from(roomId).toString('base64url')}?account=${encodeURIComponent(userId)}&view=rooms`;

/** Evaluate a pinned predecessor template literal with concrete values. */
function predecessorTemplate(line, values) {
  const text = LINK_TEMPLATES[line]
    .replace(/^formatted_body: /u, '')
    .replace(/,$/u, '')
    .replaceAll('!.', '.');
  return new Function(...Object.keys(values), `return ${text};`)(
    ...Object.values(values),
  );
}

/** Grey level whose contrast against `background` sits just under AA. */
function justBelowAa(contrastRatio, background, fromDark) {
  for (let level = 0; level <= 255; level++) {
    const grey = fromDark ? level : 255 - level;
    const colour = { r: grey, g: grey, b: grey };
    const ratio = contrastRatio(colour, background);
    if (ratio < 4.5 && ratio >= 4.3) return colour;
  }
  throw new Error('No sub-AA grey found');
}

describe('Android message-links contract ledger', () => {
  it('pins the predecessor, spans and shared sources exactly as the guard does', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_LINKS_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_LINKS_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_LINKS_SOURCE_LINES).toBe(605);
    expect({ ...contract.MESSAGE_LINKS_SHARED_SOURCE_SHA256 }).toEqual(
      SHARED_SHA256,
    );
    expect(contract.MESSAGE_LINKS_SPANS).toEqual({
      helpers: { from: 22, to: 147 },
      definitions: Object.fromEntries(
        STAGES.map((stage) => [
          stage.id,
          { from: stage.span[0], to: stage.span[1] },
        ]),
      ),
      portraitUse: { from: 427, to: 431 },
      portraitSkipLine: 437,
      androidBranchLine: 578,
      androidReturnLine: 587,
      excludedTail: { from: 588, to: 604 },
    });
    expect([...contract.MESSAGE_LINKS_EXCLUDED_TAIL_SITES]).toEqual(
      WEB_TAIL_SITES,
    );
    expect(
      contract.MESSAGE_LINKS_SPANS.definitions['mention-user-card'].to,
    ).not.toBe(604);
  });

  it('owns six ordered stages, 38 direct + 25 inherited = 63 unique identities', async () => {
    const contract = await loadContract();
    assertLedger(contract.MESSAGE_LINKS_STAGES);
    expect(contract.MESSAGE_LINKS_ASSERTION_RECORDS).toBe(63);
    expect(contract.MESSAGE_LINKS_DIRECT).toBe(38);
    expect(contract.MESSAGE_LINKS_INHERITED).toBe(25);
    const stages = contract.MESSAGE_LINKS_STAGES;
    const withSites = (index, sites) =>
      stages.map((entry, at) =>
        at === index
          ? {
              ...entry,
              sites,
              assertions: sites.map(
                (site) => `message-links.${entry.id}.${site.suffix}`,
              ),
              expectedAssertionRecords: sites.length,
            }
          : entry,
      );
    for (const mutated of [
      withSites(1, stages[1].sites.slice(0, 15)),
      withSites(0, stages[0].sites.slice(1)),
      withSites(0, [
        ...stages[0].sites,
        { line: 591, suffix: 'web-tail', kind: 'direct' },
      ]),
      withSites(1, [...stages[1].sites.slice(0, 15), stages[1].sites[0]]),
      [stages[1], stages[0], ...stages.slice(2)],
      stages.map((entry, index) =>
        index === 5 ? { ...entry, source: `${predecessor}:507-604` } : entry,
      ),
    ])
      expect(() => assertLedger(mutated)).toThrow();
  });

  it('maps five desktop stages and the portrait test.use profile', async () => {
    const contract = await loadContract();
    const { DESKTOP_ACCOUNT_PROFILE } = await loadClient();
    expect({ ...contract.MESSAGE_LINKS_STAGE_PROFILES }).toEqual(
      Object.fromEntries(STAGES.map((stage) => [stage.id, stage.profile])),
    );
    for (const entry of contract.MESSAGE_LINKS_STAGES)
      expect(entry.profile).toEqual(
        contract.MESSAGE_LINKS_STAGE_PROFILES[entry.id] === 'portrait'
          ? contract.PORTRAIT_LINK_PROFILE
          : DESKTOP_ACCOUNT_PROFILE,
      );
    expect(DESKTOP_ACCOUNT_PROFILE).toEqual({
      width: 1280,
      height: 720,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    });
    assertPortraitParity(read(predecessor), contract.PORTRAIT_LINK_PROFILE);
    const profiles = contract.messageLinksProfiles();
    for (const entry of contract.MESSAGE_LINKS_STAGES)
      expect(profiles[entry.id]).toEqual({
        requested: entry.profile,
        digest: sha256(JSON.stringify(entry.profile)),
      });
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    for (const stage of STAGES) {
      const ids = identities(stage);
      expect(contract.messageLinksAssertion(stage.id, stage.suffixes[0])).toBe(
        ids[0],
      );
      expect(() =>
        contract.messageLinksAssertion(stage.id, 'not-owned'),
      ).toThrow();
      expect(() =>
        contract.assertMessageLinksRecords(stage.id, ids),
      ).not.toThrow();
      for (const invalid of [
        ids.slice(1),
        [...ids, ids[0]],
        [ids[1], ids[0], ...ids.slice(2)],
        [...ids.slice(0, -1), ids[0]],
      ])
        expect(() =>
          contract.assertMessageLinksRecords(stage.id, invalid),
        ).toThrow();
    }
    expect(() =>
      contract.assertMessageLinksReceiptName('membership-1'),
    ).not.toThrow();
    for (const name of [
      'message-links.joined-preview.room-open',
      'Leave Sync',
      'a/b',
      '',
    ])
      expect(() => contract.assertMessageLinksReceiptName(name)).toThrow();
  });

  it('accepts exactly the renderer rewrite of the line-384 matrix: link in S4', async () => {
    const { messageLinksHrefs, parseLinkHref } = await loadContract();
    const { matrixToPermalink, parseMatrixLink } =
      await import('../libs/util/matrix/src/lib/matrix-to.ts');
    // The renderer rewrites every matrix: href through matrixToPermalink.
    const view = read('libs/util/matrix/src/lib/message-view.ts');
    const normalise = view.slice(
      view.indexOf('function normaliseMatrixUris('),
      view.indexOf('function normaliseCustomEmotes('),
    );
    expect(normalise).toMatch(
      /if \(!\/\^matrix:\/i\.test\(href\)\) continue;/u,
    );
    expect(normalise).toContain('const target = parseMatrixLink(href);');
    expect(normalise).toMatch(/target\s*\?\s*matrixToPermalink\(target\)/u);
    const rendered = (href) => matrixToPermalink(parseMatrixLink(href));
    const serverName = 'caddy:9448';
    const v10 = `!AbCdEfGhIj:${serverName}`;
    const v12 = '!Uw3sPq8aZ_xYz-0123456789abcdefghijklmnopqrs';
    for (const roomId of [v10, v12]) {
      const sent = messageLinksHrefs.rejectedJoin(roomId, serverName);
      const accepted = [
        sent,
        messageLinksHrefs.rejectedJoinRendered(roomId, serverName),
      ];
      expect(accepted).toContain(rendered(sent));
      expect(parseLinkHref(rendered(sent))).toEqual({
        kind: 'room',
        target: roomId,
        via: [serverName],
      });
    }
    // Negative control: the unencoded matrix.to form is never what renders.
    expect(rendered(messageLinksHrefs.rejectedJoin(v10, serverName))).not.toBe(
      messageLinksHrefs.privateRemote(v10, serverName),
    );
    // S4 accepts the rendered form, never the unencoded one.
    const s4 = functionSource(read(JOURNEYS), 'runRejectedJoin');
    expect(s4).toMatch(/messageLinksHrefs\.rejectedJoinRendered\(/u);
    expect(s4).not.toMatch(/messageLinksHrefs\.privateRemote\(/u);
    expect(s4).toMatch(/hrefs:\s*\[href,\s*rewritten\]/u);
  });

  it('reproduces every pinned predecessor href and message template', async () => {
    const {
      messageLinksHrefs,
      joinedPreviewMessage,
      mentionMessage,
      roomLinkMessage,
    } = await loadContract();
    const serverName = 'remote.test:8448';
    const session = { secondary: { serverName } };
    const remoteAlias = `#federated-run-f:${serverName}`;
    const roomId = `!Remote_Ab+c/d:${serverName}`;
    expect(
      joinedPreviewMessage('Link Target run-l', roomId).formattedBody,
    ).toBe(predecessorTemplate(195, { targetId: roomId }));
    expect(messageLinksHrefs.federatedAlias(remoteAlias)).toBe(
      predecessorTemplate(260, { remoteAlias }),
    );
    expect(messageLinksHrefs.privateRemote(roomId, serverName)).toBe(
      predecessorTemplate(343, { remoteId: roomId, session }),
    );
    expect(messageLinksHrefs.rejectedJoin(roomId, serverName)).toBe(
      predecessorTemplate(384, { remoteId: roomId, session }),
    );
    expect(messageLinksHrefs.portraitTarget(roomId)).toBe(
      predecessorTemplate(449, { targetId: roomId }),
    );
    expect(
      mentionMessage('Bobbyrun-u', '@ml-bob:localhost').formattedBody,
    ).toBe(
      predecessorTemplate(560, {
        bobId: '@ml-bob:localhost',
        bobName: 'Bobbyrun-u',
      }),
    );
    expect(roomLinkMessage('https://matrix.to/#/!a:b', 'open it')).toEqual({
      body: 'open it',
      formattedBody: '<a href="https://matrix.to/#/!a:b">open it</a>',
    });
    expect(mentionMessage('Bobbyrun-u', '@ml-bob:localhost').body).toBe(
      'hey Bobbyrun-u',
    );
    expect(joinedPreviewMessage('Link Target run-l', roomId).body).toBe(
      'open Link Target run-l',
    );
  });
});

/* ------------------------------------------------------------------------ */
/* jsdom: the shipped observer expressions against production-shaped markup  */
/* ------------------------------------------------------------------------ */

const LOCAL_USER = '@ml-l:localhost';

/** A detached 2D context that parses, composites and reads back sRGB(A). */
function fakeCanvasContext() {
  let pixel = [0, 0, 0, 0];
  let fill = '#000000';
  const parse = (colour) => {
    const value = String(colour).trim();
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
    if (hex) return [...hex.slice(1).map((part) => parseInt(part, 16)), 1];
    const rgb = /^rgba?\(([^)]+)\)$/iu.exec(value);
    if (rgb) {
      const parts = rgb[1]
        .split(/[\s,/]+/u)
        .filter(Boolean)
        .map(Number);
      if (parts.length < 3 || parts.some((part) => !Number.isFinite(part)))
        return null;
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    return value === 'transparent' ? [0, 0, 0, 0] : null;
  };
  return {
    get fillStyle() {
      return fill;
    },
    set fillStyle(value) {
      if (parse(value)) fill = String(value).trim();
    },
    fillRect() {
      const [r, g, b, a] = parse(fill);
      const under = pixel[3] / 255;
      const alpha = a + under * (1 - a);
      pixel =
        alpha === 0
          ? [0, 0, 0, 0]
          : [
              ...[r, g, b].map((channel, index) =>
                Math.round(
                  (channel * a + pixel[index] * under * (1 - a)) / alpha,
                ),
              ),
              Math.round(alpha * 255),
            ];
    },
    clearRect() {
      pixel = [0, 0, 0, 0];
    },
    getImageData() {
      return { data: Uint8ClampedArray.from(pixel) };
    },
  };
}

/**
 * jsdom has no layout, media queries, Capacitor or canvas. Only those inputs are
 * supplied; selectors, attributes, text, focus and CSS visibility stay real.
 */
function renderDom(
  body,
  {
    url = sourceRoute('!source:localhost', LOCAL_USER),
    width = 1280,
    height = 720,
    coarse = true,
    platform = 'android',
    htmlAttributes = '',
    touchPoints = 5,
  } = {},
) {
  const dom = new JSDOM(
    `<!doctype html><html ${htmlAttributes}><head></head><body>${body}</body></html>`,
    { url, runScripts: 'outside-only' },
  );
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
  });
  Object.defineProperty(window, 'devicePixelRatio', {
    value: 1,
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: touchPoints,
    configurable: true,
  });
  window.matchMedia = (query) => ({
    media: query,
    matches:
      query === '(pointer: coarse)'
        ? coarse
        : query === '(orientation: portrait)'
          ? height >= width
          : false,
  });
  if (platform) window.Capacitor = { getPlatform: () => platform };
  const rectOf = (element) => {
    const [x, y, w, h] = (element.getAttribute('data-rect') ?? '0,0,100,20')
      .split(',')
      .map(Number);
    return {
      x,
      y,
      width: w,
      height: h,
      left: x,
      top: y,
      right: x + w,
      bottom: y + h,
    };
  };
  window.Element.prototype.getBoundingClientRect = function () {
    return rectOf(this);
  };
  window.document.elementFromPoint = (x, y) => {
    let hit = null;
    for (const element of window.document.querySelectorAll('[data-rect]')) {
      const rect = rectOf(element);
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        x >= rect.left &&
        x < rect.right &&
        y >= rect.top &&
        y < rect.bottom
      )
        hit = element;
    }
    return hit ?? window.document.body;
  };
  window.HTMLCanvasElement.prototype.getContext = function () {
    return fakeCanvasContext();
  };
  return dom;
}

/** Run one shipped expression and prove it changed nothing observable. */
function observeIn(dom, expression) {
  const { window } = dom;
  const snapshot = () => ({
    html: window.document.documentElement.outerHTML,
    href: window.location.href,
    history: window.history.length,
    active: window.document.activeElement?.outerHTML ?? null,
  });
  const before = snapshot();
  const value = window.eval(expression);
  expect(snapshot()).toEqual(before);
  return JSON.parse(JSON.stringify(value));
}

function previewMarkup({
  name = 'Federated Room run-f',
  topic = `Served by ${REMOTE_SERVER}`,
  address = `#federated-run-f:${REMOTE_SERVER}`,
  primary = 'Join room',
  ariaDisabled = 'false',
  success = null,
  successStyle = 'color: rgb(22, 101, 52); background-color: rgba(0, 0, 0, 0)',
  sectionStyle = 'background-color: rgb(240, 253, 244)',
  actionError = null,
  actionErrorStyle = '',
  loadError = null,
  loadErrorStyle = '',
  retry = false,
  unavailable = null,
  sheet = false,
  footer = true,
  sectionRect = '445,160,390,400',
  footerRect = '445,500,390,60',
  primaryRect = '690,512,130,36',
  closeRect = '560,512,120,36',
} = {}) {
  const identity = loadError
    ? `<div class="room-preview__status" role="alert" data-testid="room-link-load-error" style="${loadErrorStyle}">
         <h3>${loadError.title}</h3><p>${loadError.message}</p>
         ${retry ? '<button type="button">Retry</button>' : ''}
       </div>`
    : `<div class="room-preview__identity"><div class="room-preview__identity-copy">
         <h3 data-testid="room-link-name">${name}</h3>
         ${address ? `<p data-testid="room-link-address">${address}</p>` : ''}
       </div></div>
       ${topic ? `<p class="room-preview__topic" data-testid="room-link-topic">\n  ${topic}\n</p>` : ''}
       ${success ? `<p class="room-preview__notice room-preview__notice--success" role="status" data-testid="room-link-success" style="${successStyle}"> ${success} </p>` : ''}
       ${actionError ? `<p class="room-preview__notice room-preview__notice--error" role="alert" data-testid="room-link-action-error" style="${actionErrorStyle}">${actionError}</p>` : ''}
       ${unavailable ? `<p class="room-preview__notice" data-testid="room-link-unavailable">${unavailable}</p>` : ''}`;
  const actions =
    footer && !loadError
      ? `<footer class="room-preview__actions" data-rect="${footerRect}" style="padding-bottom: 12px">
           <button type="button" data-rect="${closeRect}">Close</button>
           ${primary === null ? '' : `<button type="button" aria-disabled="${ariaDisabled}" data-testid="room-link-primary" data-rect="${primaryRect}"> ${primary} </button>`}
         </footer>`
      : '';
  return `<trn-room-link-preview class="room-link-preview ${sheet ? 'room-link-preview--sheet' : 'room-link-preview--dialog'}">
      <section class="room-preview flex flex-col" data-testid="room-link-preview" data-rect="${sectionRect}" style="${sectionStyle}">
        <header class="room-preview__header"><h2 class="room-preview__title">Room information</h2>
          <button type="button" aria-label="Close room information" data-testid="room-link-close">x</button></header>
        <div class="room-preview__content">${identity}</div>
        ${actions}
      </section>
    </trn-room-link-preview>`;
}

const composerMarkup = (roomName) =>
  `<div class="composer"><textarea data-testid="composer-input" placeholder="Message #${roomName}" data-rect="300,660,900,40"></textarea></div>`;

/** Contract and observer, loaded once so the jsdom readers can stay synchronous. */
const loaded = {};
async function loadObservation() {
  loaded.contract ??= await loadContract();
  loaded.observer ??= await loadObserver();
  return loaded;
}

function readPreview(body, options) {
  return loaded.contract.parseRoomLinkPreview(
    observeIn(renderDom(body, options), loaded.observer.previewExpression()),
  );
}

function readPlaceholder(body, options) {
  return loaded.contract.parseComposerPlaceholder(
    observeIn(
      renderDom(body, options),
      loaded.observer.composerPlaceholderExpression(),
    ),
  );
}

describe('Android message-links observer negative controls (jsdom)', () => {
  beforeAll(loadObservation);

  it('B: gates the joined preview before an explicit Open', async () => {
    const c = await loadContract();
    const source = {
      name: 'Link Source run-l',
      roomId: '!source:localhost',
      userId: LOCAL_USER,
    };
    const target = {
      name: 'Link Target run-l',
      roomId: '!target:localhost',
      userId: LOCAL_USER,
    };
    const joined = (change = {}) =>
      previewMarkup({
        name: target.name,
        topic: null,
        address: null,
        primary: 'Open room',
        ...change,
      });
    const before = readPlaceholder(composerMarkup(source.name));
    const during = readPlaceholder(`${composerMarkup(source.name)}${joined()}`);
    expect(() =>
      c.assertSourceStillActive(before, during, source),
    ).not.toThrow();
    for (const after of [
      readPlaceholder(`${composerMarkup(target.name)}${joined()}`),
      readPlaceholder(`${composerMarkup(source.name)}${joined()}`, {
        url: sourceRoute(target.roomId),
      }),
      readPlaceholder(
        `${composerMarkup(source.name)}${composerMarkup(source.name)}`,
      ),
    ])
      expect(() => c.assertSourceStillActive(before, after, source)).toThrow();

    const preview = readPreview(joined());
    expect(() => c.assertPreviewVisible(preview)).not.toThrow();
    expect(() =>
      c.assertRoomLinkPreview(preview, {
        name: target.name,
        primary: 'Open room',
      }),
    ).not.toThrow();
    for (const [markup, name] of [
      [joined({ primary: 'Join room' }), target.name],
      [joined(), 'Link Target run-L'],
      [joined({ sectionStyle: 'visibility: hidden' }), target.name],
      [joined({ sectionRect: '0,0,0,0' }), target.name],
      [`${joined()}${joined()}`, target.name],
    ])
      expect(() =>
        c.assertRoomLinkPreview(readPreview(markup), {
          name,
          primary: 'Open room',
        }),
      ).toThrow();

    // 225: the target opens only with the exact route change and a closed preview.
    const opened = readPlaceholder(composerMarkup(target.name), {
      url: sourceRoute(target.roomId),
    });
    expect(() => c.assertActiveRoom(opened, target)).not.toThrow();
    expect(() =>
      c.assertPreviewClosed(readPreview(composerMarkup(target.name))),
    ).not.toThrow();
    for (const after of [
      readPlaceholder(composerMarkup(target.name)),
      readPlaceholder(composerMarkup(source.name), {
        url: sourceRoute(target.roomId),
      }),
    ])
      expect(() => c.assertActiveRoom(after, target)).toThrow();
    expect(() => c.assertPreviewClosed(preview)).toThrow();
  });

  it('C: requires exact federated identity, topic, link encoding and anchor', async () => {
    const c = await loadContract();
    const { linkAnchorsExpression } = await loadObserver();
    const serverName = 'remote.test:8448';
    const alias = `#federated-run-f:${serverName}`;
    const expected = {
      name: 'Federated Room run-f',
      topic: `Served by ${serverName}`,
      address: alias,
      primary: 'Join room',
    };
    const federated = (change = {}) =>
      previewMarkup({ topic: expected.topic, address: alias, ...change });
    expect(() =>
      c.assertRoomLinkPreview(readPreview(federated()), expected),
    ).not.toThrow();
    for (const markup of [
      federated({ name: 'Federated Room run-g' }),
      federated({ topic: 'Served by localhost' }),
      federated({ name: expected.topic, topic: expected.name }),
      federated({ address: `#federated-run-f:localhost` }),
      federated({ address: null }),
      federated({ primary: 'Open room' }),
      federated({ primary: 'Joining…', ariaDisabled: 'true' }),
    ])
      expect(() =>
        c.assertRoomLinkPreview(readPreview(markup), expected),
      ).toThrow();

    const roomId = `!Remote_Ab:${serverName}`;
    const cases = [
      [
        c.messageLinksHrefs.federatedAlias(alias),
        'open the federated room',
        { kind: 'room', target: alias, via: [] },
      ],
      [
        c.messageLinksHrefs.privateRemote(roomId, serverName),
        'open a private remote room',
        { kind: 'room', target: roomId, via: [serverName] },
      ],
      [
        c.messageLinksHrefs.rejectedJoin(roomId, serverName),
        'open a room whose join will fail',
        { kind: 'room', target: roomId, via: [serverName] },
      ],
      [
        c.messageLinksHrefs.mentionUser('@ml-bob:localhost'),
        'Bobbyrun-u',
        { kind: 'user', target: '@ml-bob:localhost', via: [] },
      ],
    ];
    const anchors = (html, label) =>
      c.parseLinkAnchors(
        observeIn(renderDom(html), linkAnchorsExpression(label)),
      );
    const message = (href, label, extra = '') =>
      `<div class="scroll"><div class="msg" data-rect="0,100,900,40"><div class="msg__text msg__text--html">open <a href="${href}" data-rect="40,110,160,24"${extra}>${label}</a></div></div></div>`;
    for (const [href, label, targetLink] of cases) {
      expect(c.parseLinkHref(href)).toEqual(targetLink);
      expect(() =>
        c.assertSingleLinkAnchor(anchors(message(href, label), label), label, {
          ...targetLink,
          href,
        }),
      ).not.toThrow();
    }
    const drifted = [
      [`https://matrix.to/#/${alias}`, 0],
      [
        `https://matrix.to/#/${encodeURIComponent(encodeURIComponent(alias))}`,
        0,
      ],
      [`https://matrix.to/#/${roomId}`, 1],
      [`https://matrix.to/#/${roomId}?via=${serverName}`, 1],
      [`matrix:roomid/${roomId}?via=${encodeURIComponent(serverName)}`, 2],
      [`matrix:roomid/${roomId.slice(1)}`, 2],
      [`https://matrix.to/#/@ml-other:localhost`, 3],
    ];
    for (const [href, index] of drifted) {
      const [canonical, label, targetLink] = cases[index];
      expect(href).not.toBe(canonical);
      expect(() =>
        c.assertSingleLinkAnchor(anchors(message(href, label), label), label, {
          ...targetLink,
          href: canonical,
        }),
      ).toThrow();
    }
    const [href, label, targetLink] = cases[0];
    for (const html of [
      `${message(href, label)}${message(href, label)}`,
      message(href, label, ' style="visibility: hidden"'),
      `${message(href, label)}<div class="overlay" data-rect="0,0,1280,720"></div>`,
      message(href, `${label} now`),
    ])
      expect(() =>
        c.assertSingleLinkAnchor(anchors(html, label), label, {
          ...targetLink,
          href,
        }),
      ).toThrow();

    // Membership comes from both servers, never the UI text alone.
    const joinedBoth = { secondary: 'join', primaryJoined: [roomId] };
    expect(() => c.assertJoinedMembership(joinedBoth, roomId)).not.toThrow();
    for (const membership of [
      { secondary: 'leave', primaryJoined: [roomId] },
      { secondary: 'absent', primaryJoined: [roomId] },
      { secondary: 'join', primaryJoined: [] },
    ])
      expect(() => c.assertJoinedMembership(membership, roomId)).toThrow();
    const joinedNotice = readPreview(
      federated({ success: c.SUCCESS_TEXT, primary: 'Open room' }),
    );
    expect(() => c.assertJoinSuccess(joinedNotice, true)).not.toThrow();
    expect(() =>
      c.assertJoinedMembership(
        { secondary: 'absent', primaryJoined: [] },
        roomId,
      ),
    ).toThrow();
    expect(() =>
      c.assertLeftMembership(
        { secondary: 'leave', primaryJoined: [] },
        roomId,
        0,
      ),
    ).not.toThrow();
    for (const [membership, rows] of [
      [{ secondary: 'join', primaryJoined: [] }, 0],
      [{ secondary: 'leave', primaryJoined: [roomId] }, 0],
      [{ secondary: 'leave', primaryJoined: [] }, 1],
    ])
      expect(() => c.assertLeftMembership(membership, roomId, rows)).toThrow();
    expect(() =>
      c.assertRemoteUserId(
        `@remote-run-f:${serverName}`,
        'remote-run-f',
        serverName,
      ),
    ).not.toThrow();
    expect(() =>
      c.assertRemoteUserId(
        '@remote-run-f:localhost',
        'remote-run-f',
        serverName,
      ),
    ).toThrow();
    // 316 must land on the remote Room, never the source or a local Room.
    const remote = { name: expected.name, roomId, userId: LOCAL_USER };
    const opened = readPlaceholder(composerMarkup(remote.name), {
      url: sourceRoute(roomId),
    });
    expect(() => c.assertActiveRoom(opened, remote)).not.toThrow();
    for (const [name, id] of [
      ['Link Source run-f', '!source:localhost'],
      [expected.name, '!local:localhost'],
    ])
      expect(() =>
        c.assertActiveRoom(
          readPlaceholder(composerMarkup(name), { url: sourceRoute(id) }),
          remote,
        ),
      ).toThrow();
  });

  it('D: requires visible exact unavailable guidance, no Retry and no primary action', async () => {
    const c = await loadContract();
    const [notFound, unavailable] = c.UNAVAILABLE_COPY;
    const failed = (change = {}) =>
      previewMarkup({ loadError: notFound, ...change });
    for (const copy of [notFound, unavailable]) {
      const preview = readPreview(failed({ loadError: copy }));
      expect(() => c.assertLoadErrorVisible(preview)).not.toThrow();
      expect(() => c.assertUnavailableGuidance(preview)).not.toThrow();
      expect(() => c.assertNoPrimaryAction(preview)).not.toThrow();
    }
    expect(() =>
      c.assertLoadErrorVisible(
        readPreview(failed({ loadErrorStyle: 'visibility: hidden' })),
      ),
    ).toThrow();
    for (const markup of [
      failed({ loadErrorStyle: 'visibility: hidden' }),
      failed({
        loadError: { title: 'Could not preview room', message: 'Try again.' },
      }),
      failed({
        loadError: { title: notFound.title, message: unavailable.message },
      }),
      failed({ retry: true }),
    ])
      expect(() => c.assertUnavailableGuidance(readPreview(markup))).toThrow();
    expect(() =>
      c.assertNoPrimaryAction(
        readPreview(previewMarkup({ primary: 'Join room' })),
      ),
    ).toThrow();
    // Record 361 is scoped to the one open unavailable preview: a closed or
    // duplicated preview, a hidden error or a primary elsewhere must not pass.
    for (const markup of [
      '<main></main>',
      failed() + failed(),
      failed({ loadErrorStyle: 'visibility: hidden' }),
      failed() +
        '<button type="button" data-testid="room-link-primary">Join room</button>',
    ])
      expect(() => c.assertNoPrimaryAction(readPreview(markup))).toThrow();
  });

  it('E: keeps the rejected Join open, focused and retryable after the invite race', async () => {
    const c = await loadContract();
    const roomId = '!retry:remote.test';
    const rejected = (change = {}, focus = true) => {
      const dom = renderDom(
        previewMarkup({
          name: 'Join Retry run-r',
          topic: null,
          address: null,
          actionError: 'Could not join this room.',
          ...change,
        }),
      );
      // Test setup only: the device must produce focus natively (D11).
      if (focus)
        dom.window.document
          .querySelector('[data-testid="room-link-primary"]')
          ?.focus();
      return c.parseRoomLinkPreview(
        observeIn(dom, loaded.observer.previewExpression()),
      );
    };
    const valid = {
      preview: rejected(),
      name: 'Join Retry run-r',
      roomId,
      membership: { secondary: 'absent', primaryJoined: [] },
      joinRule: 'invite',
      tracked: false,
    };
    expect(() => c.assertRejectedJoinState(valid)).not.toThrow();
    expect(() =>
      c.assertJoinRuleInvite({ status: 200, readBack: 'invite' }),
    ).not.toThrow();
    expect(() =>
      c.assertJoinRuleInvite({ status: 200, readBack: 'public' }),
    ).toThrow();
    for (const change of [
      { preview: rejected({ actionError: null }) },
      { preview: rejected({ actionErrorStyle: 'visibility: hidden' }) },
      { preview: rejected({ primary: 'Joining…', ariaDisabled: 'true' }) },
      { preview: rejected({ primary: 'Open room' }) },
      { preview: rejected({ ariaDisabled: 'true' }) },
      { preview: rejected({}, false) },
      { preview: rejected({ sectionRect: '0,0,0,0' }) },
      { preview: rejected({ name: 'Join Retry run-s' }) },
      { membership: { secondary: 'join', primaryJoined: [] } },
      { membership: { secondary: 'absent', primaryJoined: [roomId] } },
      { joinRule: 'public' },
      { tracked: true },
    ])
      expect(() =>
        c.assertRejectedJoinState({ ...valid, ...change }),
      ).toThrow();
    const empty = renderDom(composerMarkup('Link Source run-r'));
    const { previewExpression } = await loadObserver();
    expect(() =>
      c.assertRejectedJoinState({
        ...valid,
        preview: c.parseRoomLinkPreview(observeIn(empty, previewExpression())),
      }),
    ).toThrow();
  });

  it('F: measures AA success contrast on room-link-success under the applied mode only', async () => {
    const c = await loadContract();
    const observer = await loadObserver();
    const reference = await import('../e2e/browser/support/contrast.mts');
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(c.contrastRatio(black, white)).toBe(21);
    expect(c.contrastRatio(white, white)).toBe(1);
    for (const [left, right] of [
      [{ r: 118, g: 118, b: 118 }, white],
      [
        { r: 22, g: 101, b: 52 },
        { r: 240, g: 253, b: 244 },
      ],
      [
        { r: 134, g: 239, b: 172 },
        { r: 5, g: 46, b: 22 },
      ],
      [
        { r: 10, g: 10, b: 10 },
        { r: 9, g: 9, b: 9 },
      ],
    ])
      expect(c.contrastRatio(left, right)).toBe(
        reference.contrastRatio(left, right),
      );
    expect(c.AA_NORMAL_TEXT).toBe(reference.AA_NORMAL_TEXT);

    const rgb = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
    const modeColours = {
      light: { fg: { r: 22, g: 101, b: 52 }, bg: { r: 240, g: 253, b: 244 } },
      dark: { fg: { r: 134, g: 239, b: 172 }, bg: { r: 5, g: 46, b: 22 } },
    };
    const measure = (
      mode,
      {
        fg = modeColours[mode].fg,
        dark = mode === 'dark',
        text = c.SUCCESS_TEXT,
        testId = 'room-link-success',
        style = '',
      } = {},
    ) => {
      const markup = previewMarkup({
        primary: 'Open room',
        success: text,
        successStyle: `color: ${rgb(fg)}; background-color: rgba(0, 0, 0, 0); ${style}`,
        sectionStyle: `background-color: ${rgb(modeColours[mode].bg)}`,
      }).replace('data-testid="room-link-success"', `data-testid="${testId}"`);
      const dom = renderDom(markup, {
        htmlAttributes: dark ? 'class="dark"' : '',
      });
      return c.parseSuccessContrast(
        observeIn(dom, observer.successContrastExpression()),
      );
    };
    for (const mode of ['light', 'dark']) {
      const observation = measure(mode);
      expect(observation.foreground).toEqual(modeColours[mode].fg);
      expect(observation.background).toEqual(modeColours[mode].bg);
      expect(
        c.assertAaSuccessContrast(observation, mode, mode),
      ).toBeGreaterThanOrEqual(4.5);
      const failing = justBelowAa(
        c.contrastRatio,
        modeColours[mode].bg,
        mode === 'light',
      );
      for (const [bad, selected] of [
        [measure(mode, { fg: failing }), mode],
        [measure(mode, { dark: mode !== 'dark' }), mode],
        [observation, mode === 'dark' ? 'light' : 'dark'],
        [observation, 'system'],
        [measure(mode, { text: 'Room joined.' }), mode],
      ])
        expect(() => c.assertAaSuccessContrast(bad, mode, selected)).toThrow();
      // Both measurements in one mode cannot satisfy the other mode.
      expect(() =>
        c.assertAaSuccessContrast(
          observation,
          mode === 'dark' ? 'light' : 'dark',
          mode === 'dark' ? 'light' : 'dark',
        ),
      ).toThrow();
      for (const options of [
        { testId: 'room-link-action-error' },
        { style: 'visibility: hidden' },
      ])
        expect(() => measure(mode, options)).toThrow();
    }

    const settings = ({
      checked = 'system',
      attributes = 'data-theme="default" data-density="cosy"',
      disabled = false,
    } = {}) =>
      renderDom(
        `<div data-testid="settings-detail">${['system', 'light', 'dark']
          .map(
            (mode) =>
              `<label data-testid="mode-${mode}"><input type="radio" name="mode" value="${mode}"${mode === checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>${mode}</label>`,
          )
          .join('')}</div>`,
        {
          url: 'https://localhost/settings/appearance',
          htmlAttributes: attributes,
        },
      );
    const applied = (dom) =>
      c.parseAppliedMode(observeIn(dom, observer.appliedModeExpression()));
    const baseline = applied(settings());
    expect(baseline).toMatchObject({
      htmlDark: false,
      checkedMode: 'system',
      checkedCount: 1,
      pathname: '/settings/appearance',
    });
    const selected = applied(
      settings({
        checked: 'dark',
        attributes: 'class="dark" data-theme="default" data-density="cosy"',
      }),
    );
    expect(() =>
      c.assertModeOnlyChange(baseline, selected, 'dark'),
    ).not.toThrow();
    for (const attributes of [
      'class="dark" data-theme="contrast" data-density="cosy"',
      'class="dark" data-theme="default" data-density="compact"',
      'class="dark" data-theme="default" data-density="cosy" data-code-lines="wrap"',
      'class="dark" data-theme="default" data-density="cosy" style="font-size: 18px"',
      'class="dark" data-theme="default" data-density="cosy" style="--trinity-code-scale: 1.2"',
      'data-theme="default" data-density="cosy"',
    ])
      expect(() =>
        c.assertModeOnlyChange(
          baseline,
          applied(settings({ checked: 'dark', attributes })),
          'dark',
        ),
      ).toThrow();
    expect(() =>
      c.assertModeOnlyChange(
        baseline,
        applied(
          settings({
            checked: 'light',
            attributes: 'class="dark" data-theme="default" data-density="cosy"',
          }),
        ),
        'dark',
      ),
    ).toThrow();

    let flip = 0;
    await expect(
      observer.stableSample(async () => ({ ratio: ++flip % 2 }), {
        intervalMs: 5,
        timeoutMs: 40,
      }),
    ).rejects.toThrow();
    let steady = 0;
    await expect(
      observer.stableSample(async () => ({ ratio: Math.min(++steady, 2) }), {
        intervalMs: 5,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ratio: 2 });
    await expect(
      observer.stableSample(async () => 1, {
        intervalMs: 5,
        timeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow();
  });

  it('G: measures the portrait sheet, exact containment, fit and physical reach', async () => {
    const c = await loadContract();
    const observer = await loadObserver();
    const portrait = (change = {}, options = {}) => {
      const dom = renderDom(
        previewMarkup({
          sheet: true,
          primary: 'Open room',
          topic: null,
          address: null,
          sectionRect: '0,444,390,400',
          footerRect: '0,772,390,72',
          primaryRect: '200,784,174,44',
          closeRect: '16,784,174,44',
          ...change,
        }),
        { width: 390, height: 844, ...options },
      );
      return c.parsePortraitGeometry(
        observeIn(dom, observer.portraitGeometryExpression()),
      );
    };
    const geometry = portrait();
    expect(geometry).toMatchObject({
      previewCount: 1,
      portrait: true,
      surface: { left: 0, right: 390, bottom: 844 },
      footer: { top: 772, bottom: 844 },
      viewportBottom: 844,
      viewportWidth: 390,
      primaryHit: 'self',
      closeHit: 'self',
      footerPaddingBottom: '12px',
    });
    expect(() => c.assertPortraitSheetGeometry(geometry)).not.toThrow();
    expect(Object.keys(c.PORTRAIT_GEOMETRY_CHECKS)).toEqual([
      'portrait',
      'left-edge',
      'right-edge',
      'bottom-edge',
      'footer-top',
      'footer-bottom',
    ]);
    for (const [check, change, options] of [
      ['portrait', {}, { width: 844, height: 390 }],
      ['left-edge', { sectionRect: '1.5,444,388.5,400' }],
      ['right-edge', { sectionRect: '0,444,392,400' }],
      ['bottom-edge', { sectionRect: '0,444,390,398' }],
      ['footer-top', { footerRect: '0,-1,390,72' }],
      ['footer-bottom', { footerRect: '0,774,390,72' }],
    ]) {
      const drifted = portrait(change, options);
      expect(() => c.PORTRAIT_GEOMETRY_CHECKS[check](geometry)).not.toThrow();
      expect(() => c.PORTRAIT_GEOMETRY_CHECKS[check](drifted)).toThrow();
    }
    const sheet = readPreview(
      previewMarkup({ sheet: true, primary: 'Open room' }),
    );
    expect(() => c.assertSheetClass(sheet)).not.toThrow();
    expect(() =>
      c.assertSheetClass(readPreview(previewMarkup({ primary: 'Open room' }))),
    ).toThrow();

    const profile = (width, height, touchPoints = 5) =>
      c.parseAppliedProfile(
        observeIn(
          renderDom('', { width, height, touchPoints }),
          observer.appliedProfileExpression(),
        ),
      );
    const applied = profile(390, 844);
    expect(applied).toMatchObject({
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 1,
      coarsePointer: true,
      maxTouchPoints: 5,
      platform: 'android',
      orientationPortrait: true,
    });
    const { client, calls } = await injectedClient();
    const fullRect = await client.nativeRect({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    });
    const fit = { ...applied, nativeRect: fullRect };
    expect(() => c.assertViewportFit(fit)).not.toThrow();
    // Chromium reports an emulated factor of 1 as a float.
    expect(() =>
      c.assertViewportFit({ ...fit, devicePixelRatio: 1.0000000186264515 }),
    ).not.toThrow();
    for (const change of [
      { ...profile(390, 843), nativeRect: fullRect },
      { ...profile(393, 844), nativeRect: fullRect },
      { ...profile(844, 390), nativeRect: fullRect },
      { ...applied, devicePixelRatio: 2.75, nativeRect: fullRect },
      { ...applied, devicePixelRatio: 1.001, nativeRect: fullRect },
      { ...applied, nativeRect: undefined },
    ])
      expect(() => c.assertViewportFit(change)).toThrow();
    expect(calls.at(-2)).toEqual({ x: 0.5, y: 0.5 });
    expect(calls.at(-1)).toEqual({ x: 389.5, y: 843.5 });

    const wm = 'Physical size: 1080x2400\n';
    const nav = (top) =>
      `      InsetsSource id=1 type=navigationBars frame=[0,${top}][1080,2400] visible=true`;
    const dumpsys = [
      'WINDOW MANAGER WINDOWS (dumpsys window windows)',
      nav(2337),
      '      InsetsSource id=2 type=navigationBars frame=[0,0][0,0] visible=false',
      nav(2337),
    ].join('\n');
    const navigationBar = c.parseNavigationBarFrame(dumpsys, wm);
    expect(navigationBar).toEqual({
      left: 0,
      top: 2337,
      right: 1080,
      bottom: 2400,
    });
    for (const [text, size] of [
      [`${dumpsys}\n${nav(2274)}`, wm],
      ['WINDOW MANAGER WINDOWS (dumpsys window windows)', wm],
      [nav(2337).replace('[1080,2400]', '[1080,2300]'), wm],
      [dumpsys, 'Physical size: 1080x2400\nPhysical size: 1080x2340\n'],
      [dumpsys, ''],
    ])
      expect(() => c.parseNavigationBarFrame(text, size)).toThrow();

    const rect = (value) => client.nativeRect(value);
    const receipt = {
      navigationBar,
      footer: await rect(geometry.rects.footer),
      primary: await rect(geometry.rects.primary),
      close: await rect(geometry.rects.close),
      primaryHit: geometry.primaryHit,
      closeHit: geometry.closeHit,
    };
    expect(() => c.assertPhysicalFooterReach(receipt)).not.toThrow();
    const obstructed = c.parsePortraitGeometry(
      observeIn(
        renderDom(
          `${previewMarkup({ sheet: true, primary: 'Open room', sectionRect: '0,444,390,400', footerRect: '0,772,390,72', primaryRect: '200,784,174,44', closeRect: '16,784,174,44' })}<div class="ime" data-rect="0,700,390,144"></div>`,
          { width: 390, height: 844 },
        ),
        observer.portraitGeometryExpression(),
      ),
    );
    for (const change of [
      {
        primary: {
          ...receipt.primary,
          bottomRight: { x: receipt.primary.bottomRight.x, y: 2338 },
        },
      },
      {
        close: {
          ...receipt.close,
          bottomRight: { x: receipt.close.bottomRight.x, y: 2338 },
        },
      },
      { primaryHit: obstructed.primaryHit },
      { closeHit: obstructed.closeHit },
      { navigationBar: { ...navigationBar, top: 2000 } },
    ])
      expect(() =>
        c.assertPhysicalFooterReach({ ...receipt, ...change }),
      ).toThrow();
  });

  it('H: requires the Android user dialog model without navigation', async () => {
    const c = await loadContract();
    const observer = await loadObserver();
    const card = (name = 'Bobbyrun-u') =>
      `<trn-user-card data-testid="user-card"><h2 data-testid="user-card-name">${name}</h2><p>@ml-bob:localhost</p></trn-user-card>`;
    const overlay = ({
      wrapper = 'cdk-global-overlay-wrapper',
      backdrop = 'cdk-overlay-dark-backdrop',
      label = 'User',
      modal = ' aria-modal="false"',
      content = card(),
      extra = '',
    } = {}) =>
      `${composerMarkup('Mention Room run-u')}<div class="cdk-overlay-container">
        <div class="cdk-overlay-backdrop ${backdrop}" data-rect="0,0,1280,720"></div>
        <div class="${wrapper}"><div class="cdk-overlay-pane">
          <div role="dialog" aria-label="${label}"${modal} data-rect="440,160,400,400">${content}</div>
        </div></div>${extra}
      </div>`;
    const read = (body, options) =>
      c.parseUserCardDialog(
        observeIn(
          renderDom(body, options),
          observer.userCardDialogExpression('Bobbyrun-u'),
        ),
      );
    const model = read(overlay());
    expect(() =>
      c.assertAndroidUserCardDialog(model, 'Bobbyrun-u'),
    ).not.toThrow();
    expect(() => c.assertNoAnchoredPopover(model)).not.toThrow();
    expect(() => c.assertCoarseAndroidPointer(model)).not.toThrow();
    for (const drifted of [
      read(overlay({ wrapper: 'cdk-overlay-connected-position-bounding-box' })),
      read(
        overlay({
          extra:
            '<div class="cdk-overlay-connected-position-bounding-box"></div>',
        }),
      ),
      read(overlay({ backdrop: 'cdk-overlay-transparent-backdrop' })),
      read(
        overlay({
          extra:
            '<div class="cdk-overlay-backdrop cdk-overlay-transparent-backdrop"></div>',
        }),
      ),
      read(overlay({ wrapper: 'cdk-overlay-pane-host' })),
      read(overlay({ label: 'Profile' })),
      read(overlay({ extra: overlay() })),
      read(overlay({ content: '<p>Bobbyrun-u</p>' })),
      read(overlay({ content: card('@ml-bob:localhost') })),
      read(overlay(), { coarse: false }),
      read(overlay(), { platform: 'web' }),
      read(overlay(), { platform: null }),
    ])
      expect(() =>
        c.assertAndroidUserCardDialog(drifted, 'Bobbyrun-u'),
      ).toThrow();
    // CDK's default aria-modal is recorded but not part of the parity model.
    for (const modal of ['', ' aria-modal="true"'])
      expect(() =>
        c.assertAndroidUserCardDialog(read(overlay({ modal })), 'Bobbyrun-u'),
      ).not.toThrow();
    expect(() =>
      c.assertNoAnchoredPopover(
        read(
          overlay({
            extra:
              '<div class="cdk-overlay-connected-position-bounding-box"></div>',
          }),
        ),
      ),
    ).toThrow();
    for (const options of [{ coarse: false }, { platform: 'web' }])
      expect(() =>
        c.assertCoarseAndroidPointer(read(overlay(), options)),
      ).toThrow();

    const dom = renderDom(overlay());
    const marker = () =>
      c.parseNavigationMarker(
        observeIn(dom, observer.navigationMarkerExpression()),
      );
    const before = marker();
    expect(() => c.assertNoNavigation(before, marker())).not.toThrow();
    // Test setup only: simulate a navigation the product must never perform.
    dom.window.history.pushState({}, '', sourceRoute('!mention:localhost'));
    expect(() => c.assertNoNavigation(before, marker())).toThrow();
    const replaced = renderDom(overlay());
    const beforeReplace = c.parseNavigationMarker(
      observeIn(replaced, observer.navigationMarkerExpression()),
    );
    replaced.window.history.replaceState(
      {},
      '',
      sourceRoute('!other:localhost'),
    );
    expect(() =>
      c.assertNoNavigation(
        beforeReplace,
        c.parseNavigationMarker(
          observeIn(replaced, observer.navigationMarkerExpression()),
        ),
      ),
    ).toThrow();
    expect(() =>
      c.assertNoNavigation(before, {
        ...before,
        timeOrigin: before.timeOrigin + 1,
      }),
    ).toThrow();

    const room = readPlaceholder(composerMarkup('Mention Room run-u'));
    expect(() =>
      c.assertExactPlaceholder(room, 'Mention Room run-u'),
    ).not.toThrow();
    expect(() =>
      c.assertExactPlaceholder(
        readPlaceholder(composerMarkup('Link Source run-u')),
        'Mention Room run-u',
      ),
    ).toThrow();
    // The profile receipt must exist and name bobName; an MXID fallback fails.
    expect(() => c.assertDisplayName('Bobbyrun-u', 'Bobbyrun-u')).not.toThrow();
    expect(() => c.assertDisplayName(undefined, 'Bobbyrun-u')).toThrow();
    expect(() =>
      c.assertDisplayName('@ml-bob:localhost', 'Bobbyrun-u'),
    ).toThrow();
    expect(() =>
      c.assertUserCardName(
        read(overlay({ content: card('@ml-bob:localhost') })),
        'Bobbyrun-u',
      ),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* nativeRect with an injected viewport owner                                */
/* ------------------------------------------------------------------------ */

/** A client whose private viewport owner maps like pixel_6 at scale 1. */
async function injectedClient({
  width = 390,
  height = 844,
  top = 132,
  factor = 1080 / 411.43,
} = {}) {
  const { AccountWorkspaceClient } = await loadClient();
  const calls = [];
  const flows = [];
  const client = new AccountWorkspaceClient(
    { runFlow: async (...args) => flows.push(args), adb: async () => '' },
    root,
    tmpdir(),
    new AbortController().signal,
  );
  const bounds = { x: 0, y: top, width: 1080, height: 2215 };
  client.viewport = {
    apply: async () => {},
    nativePoint: async (point) => {
      calls.push(point);
      if (!(
        point.x >= 0 &&
        point.x <= width &&
        point.y >= 0 &&
        point.y <= height
      ))
        throw new Error('Native point is outside the requested viewport');
      const mapped = {
        x: Math.round(bounds.x + point.x * factor),
        y: Math.round(bounds.y + point.y * factor),
      };
      if (
        mapped.x > bounds.x + bounds.width ||
        mapped.y > bounds.y + bounds.height
      )
        throw new Error('Native point is outside the attached WebView bounds');
      return mapped;
    },
    installDocumentScript: async () => {
      throw new Error('nativeRect must not install document scripts');
    },
    close: async () => {},
  };
  return { client, calls, flows };
}

describe('Android message-links nativeRect', () => {
  it('maps inset corners through the owner and fails when a corner is outside the WebView', async () => {
    const { client, calls, flows } = await injectedClient();
    const mapped = await client.nativeRect({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
    expect(calls).toEqual([
      { x: 10.5, y: 20.5 },
      { x: 109.5, y: 59.5 },
    ]);
    expect(mapped.topLeft.y).toBeLessThan(mapped.bottomRight.y);
    expect(flows).toHaveLength(0);
    const short = await injectedClient({ height: 900 });
    await expect(
      short.client.nativeRect({ x: 0, y: 0, width: 390, height: 900 }),
    ).rejects.toThrow(/outside/u);
    await expect(
      client.nativeRect({ x: 0, y: 0, width: 391, height: 844 }),
    ).rejects.toThrow(/outside/u);
    await expect(
      client.nativeRect({ x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow();
    await expect(
      client.nativeRect({ x: 0, y: Number.NaN, width: 20, height: 20 }),
    ).rejects.toThrow();
  });

  it('stays read-only: no flow, no evaluation, no input and no DOM write', () => {
    const tree = ts.createSourceFile(
      CLIENT,
      read(CLIENT),
      ts.ScriptTarget.Latest,
      true,
    );
    let body;
    const visit = (node) => {
      if (
        ts.isMethodDeclaration(node) &&
        node.name.getText(tree) === 'nativeRect'
      )
        body = node.getText(tree);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(body).toBeDefined();
    expect(body).toContain('this.owner.apply()');
    expect(body.match(/this\.owner\.nativePoint\(/gu)).toHaveLength(2);
    expect(body).toContain('+ 0.5');
    expect(body).toContain('- 0.5');
    for (const forbidden of [
      'runFlow',
      'evaluateNative',
      'installDocumentScript',
      'nativeAction',
      'adb(',
      'keyevent',
      'record(',
      'writeFile',
    ])
      expect(body).not.toContain(forbidden);
  });
});

/* ------------------------------------------------------------------------ */
/* Artifacts: secrets, scan, scrub, publication gate and abort               */
/* ------------------------------------------------------------------------ */

const ARTIFACT_ROOM = `!Remote_Ab+c/d:${REMOTE_SERVER}`;
const ARTIFACT_ALIAS = `#federated-run-f:${REMOTE_SERVER}`;
const ARTIFACT_IDS = {
  run: 'trn-ml-federated-join-f',
  local: {
    userId: '@trn_ml_federated_0a1b2c:localhost',
    username: 'trn_ml_federated_0a1b2c',
    password: 'local-pass"word\\token',
  },
  remote: {
    userId: `@remote-trn-ml-f:${REMOTE_SERVER}`,
    localpart: 'remote-trn-ml-f',
    password: 'remote-secret-password',
  },
  bob: {
    userId: '@trn_ml_bob_9f8e7d:localhost',
    username: 'trn_ml_bob_9f8e7d',
    password: 'bob-secret-password',
  },
  bobName: 'Bobbytrn-ml-u',
  rooms: {
    source: { id: '!Source_Xy:localhost', name: 'Link Source trn-ml-f' },
    remote: {
      id: ARTIFACT_ROOM,
      name: 'Federated Room trn-ml-f',
      topic: `Served by ${REMOTE_SERVER} for trn-ml-f`,
      alias: ARTIFACT_ALIAS,
      aliasLocalpart: 'federated-run-f',
    },
  },
  hrefs: [`https://matrix.to/#/${encodeURIComponent(ARTIFACT_ALIAS)}`],
  eventIds: ['$Event_A+b/C=d'],
};

async function withOutput(prefix, operation) {
  const output = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

const mixedCase = (value) =>
  value.replace(
    /%([0-9A-F]{2})/gu,
    (_match, hex, offset) => `%${offset % 2 ? hex.toLowerCase() : hex}`,
  );

/** Every record() proof must be an inline function that makes an assertion call. */
function recordProofViolations(source) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
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
        else if (
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          ts.isIdentifier(callee.expression) &&
          ['assert', 'PORTRAIT_GEOMETRY_CHECKS'].includes(
            callee.expression.text,
          )
        )
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
      const line =
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      if (
        !(ts.isArrowFunction(proof) || ts.isFunctionExpression(proof)) ||
        !asserts(proof.body)
      )
        violations.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { records, violations };
}

describe('Android message-links diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read('e2e/android/message-links-journeys.mts');
    const current = recordProofViolations(journey);
    expect(current.records).toBeGreaterThanOrEqual(40);
    expect(current.violations).toEqual([]);
    const emptied = journey.replace(
      '() => assertApiLogin(login, local.userId)',
      '() => {}',
    );
    expect(emptied).not.toBe(journey);
    expect(recordProofViolations(emptied).violations).toHaveLength(1);
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageLinksSecrets } = await loadArtifacts();
    const { redactStageFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageLinksSecrets('federated-join', ARTIFACT_IDS);
    const roomId = ARTIFACT_IDS.rooms.source.id;
    const segment = Buffer.from(roomId).toString('base64url');
    const failure = new AssertionError({
      actual: `/rooms/${segment}?account=${encodeURIComponent(ARTIFACT_IDS.local.userId)}`,
      expected: `/rooms/${roomId}`,
      operator: 'strictEqual',
      message: 'Native navigation reached the exact Room',
    });
    const leaked = new Error(`Timed out waiting for ${roomId} in ${segment}`);
    const error = redactStageFailure(
      'federated-join',
      [new AggregateError([failure, leaked], 'Native account action failed')],
      secrets,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain(
      'Android message-links federated-join failed',
    );
    expect(error.message).toContain('Native navigation reached the exact Room');
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      roomId,
      segment,
      encodeURIComponent(roomId),
      ARTIFACT_IDS.local.userId,
      encodeURIComponent(ARTIFACT_IDS.local.userId),
    ])
      expect(error.message).not.toContain(value);
    const journey = read('e2e/android/message-links-journeys.mts');
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toContain(
      'throw new AggregateError(failures, `Android message-links',
    );
  });

  it('registers every identifier form per stage, never the bare server name', async () => {
    const { messageLinksSecrets } = await loadArtifacts();
    const secrets = messageLinksSecrets('federated-join', ARTIFACT_IDS);
    const keys = Object.keys(secrets);
    expect(keys.every((key) => key.startsWith('SECRET_FEDERATED_JOIN_'))).toBe(
      true,
    );
    const values = new Set(Object.values(secrets));
    for (const value of [
      ARTIFACT_IDS.run,
      ARTIFACT_IDS.local.userId,
      encodeURIComponent(ARTIFACT_IDS.local.userId),
      ARTIFACT_IDS.local.username,
      ARTIFACT_IDS.local.password,
      ARTIFACT_IDS.remote.userId,
      ARTIFACT_IDS.remote.localpart,
      ARTIFACT_IDS.remote.password,
      ARTIFACT_IDS.bob.userId,
      ARTIFACT_IDS.bobName,
      ARTIFACT_ROOM,
      ARTIFACT_ROOM.slice(1),
      encodeURIComponent(ARTIFACT_ROOM),
      encodeURIComponent(ARTIFACT_ROOM.slice(1)),
      Buffer.from(ARTIFACT_ROOM).toString('base64url'),
      ARTIFACT_IDS.rooms.remote.name,
      ARTIFACT_IDS.rooms.remote.topic,
      ARTIFACT_ALIAS,
      encodeURIComponent(ARTIFACT_ALIAS),
      'federated-run-f',
      ARTIFACT_IDS.hrefs[0],
      ARTIFACT_IDS.eventIds[0],
      encodeURIComponent(ARTIFACT_IDS.eventIds[0]),
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has(REMOTE_SERVER)).toBe(false);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(
        messageLinksSecrets('mention-user-card', { run: 'trn-ml-u' }),
      ),
    ).toEqual(['SECRET_MENTION_USER_CARD_RUN']);
    expect(() => messageLinksSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageLinksSecrets('federated-join', {
        ...ARTIFACT_IDS,
        bobName: REMOTE_SERVER,
      }),
    ).toThrow();
    expect(() =>
      messageLinksSecrets('federated-join', { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
  });

  it('rejects every raw, escaped, encoded, double-encoded, sliced and base64url form', async () => {
    const { messageLinksSecrets, scanMessageLinksArtifacts } =
      await loadArtifacts();
    const secrets = messageLinksSecrets('federated-join', ARTIFACT_IDS);
    await withOutput('trinity-links-scan-', async (output) => {
      const receipt = join(
        output,
        'federated-join',
        'receipt-01-membership-1.json',
      );
      await mkdir(join(output, 'federated-join'));
      for (const unsafe of [
        `GET /rooms/${ARTIFACT_ROOM}/state`,
        JSON.stringify({ password: ARTIFACT_IDS.local.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_ROOM))}/state`,
        `GET /directory/room/${mixedCase(encodeURIComponent(ARTIFACT_ALIAS))}`,
        `GET /profile/${mixedCase(encodeURIComponent(ARTIFACT_IDS.local.userId))}`,
        `href=${encodeURIComponent(ARTIFACT_IDS.hrefs[0])}`,
        `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_ALIAS))}`,
        `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_ROOM))}`,
        `matrix:roomid/${ARTIFACT_ROOM.slice(1)}?via=${REMOTE_SERVER}`,
        `/rooms/${Buffer.from(ARTIFACT_ROOM).toString('base64url')}?view=rooms`,
        `topic=${ARTIFACT_IDS.rooms.remote.topic}`,
        `card=${ARTIFACT_IDS.bobName}`,
        `register ${ARTIFACT_IDS.remote.password}`,
        `run=${ARTIFACT_IDS.run}`,
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        'Authorization: X-Matrix origin=remote.test,key="ed25519:a",sig="b"',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanMessageLinksArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        receipt,
        `{"server":"${REMOTE_SERVER}","status":"passed","note":"Served by"}\n`,
      );
      await expect(
        scanMessageLinksArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of ['capture.png', 'capture.PNG', 'opaque.bin'])
        await withOutput('trinity-links-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(scanMessageLinksArtifacts(other, {})).rejects.toThrow();
        });
    });
  });

  it('scrubs raw and encoded identifiers, deletes rasters and then scans clean', async () => {
    const {
      messageLinksSecrets,
      scrubMessageLinksArtifacts,
      scanMessageLinksArtifacts,
    } = await loadArtifacts();
    const secrets = messageLinksSecrets('federated-join', ARTIFACT_IDS);
    await withOutput('trinity-links-scrub-', async (output) => {
      const stage = join(output, 'federated-join');
      await mkdir(stage);
      const path = join(stage, 'device.log');
      await writeFile(
        path,
        [
          `GET /rooms/${mixedCase(encodeURIComponent(ARTIFACT_ROOM))}/state/m.room.member`,
          `double=${encodeURIComponent(encodeURIComponent(ARTIFACT_ALIAS))}`,
          `raw=${ARTIFACT_ROOM} ${ARTIFACT_IDS.bobName}`,
          JSON.stringify({ password: ARTIFACT_IDS.local.password }),
          `route=/rooms/${Buffer.from(ARTIFACT_ROOM).toString('base64url')}`,
          `unchanged=${REMOTE_SERVER} %2Fpublic`,
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed.png'), 'raster');
      await scrubMessageLinksArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe(
        `unchanged=${REMOTE_SERVER} %2Fpublic`,
      );
      for (const leaked of [
        ARTIFACT_ROOM,
        ARTIFACT_IDS.bobName,
        'remote-secret',
        'local-pass',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('[REDACTED]');
      expect(existsSync(join(stage, 'passed.png'))).toBe(false);
      await expect(
        scanMessageLinksArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried six-stage 63-record run', async () => {
    const artifacts = await loadArtifacts();
    const { MESSAGE_LINKS_STAGES, messageLinksProfiles } = await loadContract();
    const { DESKTOP_ACCOUNT_PROFILE } = await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 6,
      expectedAssertionRecords: 63,
      attempt: 1,
      retries: 0,
      stages: MESSAGE_LINKS_STAGES.map((entry) => ({
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
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    await withOutput('trinity-links-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const provenance = {
        schemaVersion: 1,
        profile: {
          requested: DESKTOP_ACCOUNT_PROFILE,
          digest: sha256(JSON.stringify(DESKTOP_ACCOUNT_PROFILE)),
        },
      };
      const arrange = async (value = report()) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance);
        await write('profiles.json', messageLinksProfiles());
        for (const entry of MESSAGE_LINKS_STAGES) {
          await mkdir(join(output, entry.id), { recursive: true });
          await write(join(entry.id, 'profile-applied.json'), {
            innerWidth: entry.profile.width,
          });
          for (const name of [
            'passed.json',
            'passed-ui.json',
            'passed-surface.json',
          ])
            await write(join(entry.id, name), { ok: true });
        }
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessageLinksDiagnosticsSafe(
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
      await artifacts.markMessageLinksDiagnosticsSafe(
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
        mutate((value) => (value.attempt = 2)),
        mutate((value) => (value.retries = 1)),
        mutate((value) => value.stages.pop()),
        mutate((value) => (value.stages[1].status = 'failed')),
        mutate((value) => (value.stages[1].retries = 1)),
        mutate((value) => (value.stages[1].failureCount = 1)),
        mutate((value) => {
          value.stages[1].assertions.pop();
          value.stages[1].assertionRecords = 15;
        }),
        mutate((value) => {
          value.stages[1].assertions[15] = value.stages[1].assertions[14];
        }),
        mutate((value) => value.stages.reverse()),
      ]) {
        await arrange(invalid);
        await refused(invalid);
      }
      await arrange();
      await refused(mutate((value) => (value.stages[0].status = 'failed')));
      for (const unsafe of [
        { ...flags, unsafeSecrets: true },
        { ...flags, cleanupFailed: true },
        { ...flags, scrubFailed: true },
      ])
        await refused(report(), { flags: unsafe });
      const aborted = new AbortController();
      aborted.abort();
      await refused(report(), { signal: aborted.signal });

      for (const missing of [
        join('portrait-sheet', 'profile-applied.json'),
        join('mention-user-card', 'passed-ui.json'),
        'profiles.json',
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      const swapped = messageLinksProfiles();
      await write('profiles.json', {
        ...swapped,
        'portrait-sheet': swapped['joined-preview'],
      });
      await refused(report());
      await arrange();
      await write('runtime-provenance.json', {
        ...provenance,
        profile: {
          requested: { ...DESKTOP_ACCOUNT_PROFILE, width: 390 },
          digest: provenance.profile.digest,
        },
      });
      await refused(report());
      await arrange();
      await write(join('federated-join', 'passed-surface.json'), {
        url: `https://localhost/rooms/${Buffer.from(ARTIFACT_ROOM).toString('base64url')}`,
      });
      await refused(report(), {
        secrets: artifacts.messageLinksSecrets('federated-join', ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, 'federated-join', 'passed.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageLinksStageCleanup,
      revokeMessageLinksPublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageLinksStageCleanup(
      [
        async () => {
          ran.push('close');
          throw new Error('client close failed');
        },
        async () => {
          ran.push('clear');
        },
      ],
      failures,
    );
    expect(ran).toEqual(['close', 'clear']);
    expect(failures).toHaveLength(1);
    await withOutput('trinity-links-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [
          { status: 'passed', failureCount: 0 },
          { status: 'passed', failureCount: 0 },
        ],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageLinksPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageLinksPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-links --timeout-ms=3000000 --entrypoint=e2e/android/message-links-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "4" ]; then echo \'message-links-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 3300000 -- pnpm exec nx run trinity-e2e-android:message-links; fi';
const GATE_PATH =
  "-path '*/android.message-links/message-links/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-links-started == 'true' && steps.message-links-artifact-gate.outputs.message-links-safe == 'true' }}";

function wiringInputs() {
  return {
    project: JSON.parse(read('e2e/android/project.json')),
    pkg: JSON.parse(read('package.json')),
    workflow: read('.github/workflows/ci.yml'),
    ciSpec: read('scripts/ci-workflow.spec.mjs'),
  };
}

/** Every hosted wiring rule, as a pure function of the files' text. */
function assertWiring({ project, pkg, workflow, ciSpec }) {
  const target = project.targets['message-links'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-links']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-links',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) => line.includes('trinity-e2e-android:message-links')),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'security-settings-started=true'");
  expect(lines[runner - 1]).toContain(
    'trinity-e2e-android:security-settings; fi',
  );
  expect(lines[runner + 1]).toBe('echo \'started=true\' >> "$GITHUB_OUTPUT"');
  expect(lines[runner + 2]).toContain('pnpm e2e:android --');
  const gate = workflow
    .split('      - name: Gate Android message-links diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-links-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-links-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-links-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-links\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-links/**',
  );
  expect(
    workflow.indexOf('Gate Android message-links diagnostics'),
  ).toBeGreaterThan(
    workflow.indexOf('Gate Android message-linkify diagnostics'),
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(79);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(72);');
  expect(ciSpec).toContain(
    'runs message-links after security-settings and before retained Playwright on shard 4',
  );
  expect(ciSpec).toContain("step.with.surface === 'android-message-links'");
}

describe('Android message-links hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-links',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-links',
      canonicalScript: 'e2e:android:message-links',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT,
      FIXTURES,
      OBSERVER,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-links',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-links',
        command: 'nx run trinity-e2e-android:message-links',
        kind: 'canonical',
        suiteIds: ['android.message-links'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-links'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "4" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-links',
    );
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-links']);
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
            '--timeout-ms=3000000',
            '--timeout-ms=1200000',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            'message-links-journeys.mts',
            'message-linkify-journeys.mts',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-links'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "4"', '= "2"')),
      withText('workflow', CI_LINE, CI_LINE.replace('3300000', '1200000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-links/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-links-started == 'true' }}",
      ),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(79);',
        'expect(uploads.length).toBe(78);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(72);',
        'expect(lines).toHaveLength(71);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved to the wrong line: before security-settings.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 63 identities with their source lines and the 38/25 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Matrix-link journeys')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-links\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    const ledgerCell = (stage) =>
      ledgerTuples(stage).map((tuple) =>
        tuple[0] === 'direct'
          ? String(tuple[1])
          : tuple[4] === undefined
            ? `${tuple[1]}@${tuple[3]}`
            : `${tuple[1]}@${tuple[4]}←${tuple[3]}`,
      );
    expect(rows.map((row) => row[2].trim())).toEqual(
      STAGES.flatMap(ledgerCell),
    );
    expect(rows.map((row) => row[1])).toEqual(
      STAGES.flatMap((stage) => stage.suffixes.map(() => stage.id)),
    );
    expect(rows.map((row) => row[3])).toEqual(
      STAGES.flatMap((stage) => ledgerTuples(stage).map((tuple) => tuple[0])),
    );
    expect(section).toContain('38 direct + 25');
    expect(section).toContain('6/16/9/12/14/6');
    expect(section).toContain(PREDECESSOR_SHA256);
    expect(section).toContain('Suite `android.message-links`');
    expect(section).toMatch(/remains enabled and untouched/u);
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules: journeys, observer, fixtures and artifacts                  */
/* ------------------------------------------------------------------------ */

const FORBIDDEN_TOKENS = [
  ['.focus(', /\.focus\(/u],
  ['focusFixture', /focusFixture/u],
  ['focusCurrent', /focusCurrent/u],
  ['client.key(', /client\.key\(/u],
  ['pressAndroidKeyboardKey', /pressAndroidKeyboardKey/u],
  ['keyevent', /keyevent/iu],
  ["'enter'", /['"`]enter['"`]/iu],
  ['.click(', /\.click\(/u],
  ['dispatchEvent', /dispatchEvent/u],
  ['scrollIntoView(', /scrollIntoView\(/u],
  ['.submit(', /\.submit\(/u],
  ['navigate(', /navigate\(/u],
  ['reload(', /reload\(/u],
  ['installDocumentScript', /installDocumentScript/u],
  [
    'classList mutation',
    /classList\.(?:add|remove|toggle|replace)\(|className\s*=(?!=)/u,
  ],
  ['setAttribute', /setAttribute|removeAttribute|toggleAttribute/u],
  [
    '.style. write',
    /\.style\.[\w-]+\s*=(?!=)|\.style\.(?:setProperty|removeProperty)\(|\.style\s*=(?!=)/u,
  ],
  ['location =', /location\s*=(?!=)|location\.href\s*=(?!=)/u],
  ['location.assign', /location\.(?:assign|replace)\(/u],
  ['Input.dispatch', /Input\.dispatch/u],
  ['seedPreference', /seedPreference/u],
  ['Preferences.set', /Preferences\.set/u],
  ['emulateMedia', /emulateMedia|Emulation\.setEmulatedMedia/u],
  ['uimode', /uimode/iu],
  [
    'native-shell-appearance-(light|dark)',
    /native-shell-appearance-(?:light|dark)/u,
  ],
  ['native-shell-back.yaml', /native-shell-back\.yaml/u],
  ['reverse ports 8009/9448', /\b(?:8009|9448)\b/u],
  ['caddy:9448', /caddy:9448/u],
  ['localhost:9448', /localhost:9448/u],
  ['localhost:8008', /localhost:8008/u],
  ['trinity-e2e-shared-secret', /trinity-e2e-shared-secret/u],
  ['non-zero retries', /retries:(?!\s*0\b)/u],
];

function assertNoForbiddenTokens(source, name) {
  for (const [token, pattern] of FORBIDDEN_TOKENS)
    expect(pattern.test(source), `${name} must not contain ${token}`).toBe(
      false,
    );
}

/** Every polling wait carries an explicit finite bound argument. */
function assertBoundedWaits(source, name) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      const called = callee.split('.').at(-1);
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

/** The house read-only observer rule (edit-history-migration.spec.mjs). */
function assertReadOnlyObserver(source) {
  expect(source).not.toMatch(
    /\.(?:click|focus|dispatchEvent|scrollIntoView|scrollTo|scrollBy|submit|requestSubmit)\s*\(/u,
  );
  expect(source).not.toMatch(
    /(?:\.scrollTop|\.scrollLeft|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatchTouchEvent|\.goto\s*\(|window\.location\s*=|window\.location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(/u,
  );
}

function functionSource(source, name) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
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
  new RegExp(`\\brecord\\(\\s*\\w+,\\s*'${suffix}'`, 'u');
const receiptOf = (name) =>
  new RegExp(`\\breceipt\\(\\s*\\w+,\\s*'${name}'`, 'u');
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

const STAGE_FUNCTIONS = [
  'runJoinedPreview',
  'runFederatedJoin',
  'runRemoteUnavailable',
  'runRejectedJoin',
  'runPortraitSheet',
  'runMentionUserCard',
];

/** The per-stage native order and invariants required by the design. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertBoundedWaits(journeys, JOURNEYS);
  const stage = Object.fromEntries(
    STAGE_FUNCTIONS.map((name) => [name, functionSource(journeys, name)]),
  );
  for (const name of STAGE_FUNCTIONS) {
    expect(stage[name]).not.toMatch(
      /tapCurrent\([^)]*(?:text|exactText):\s*['"`](?:Light|Dark|System)/u,
    );
    expect(stage[name]).not.toMatch(
      /\bfocused\(\s*[^)]*\)\s*;?\s*\n?\s*await\s+client\.focus/u,
    );
  }
  assertOrder(
    stage.runJoinedPreview,
    [
      callOf('tapMessageLink'),
      recordOf('open-action'),
      callOf('tapPreviewPrimary'),
      recordOf('target-opened'),
    ],
    'runJoinedPreview',
  );
  assertOrder(
    stage.runFederatedJoin,
    [
      /selectAppearanceMode\([^;]*'light'/u,
      callOf('tapMessageLink'),
      callOf('tapPreviewPrimary'),
      recordOf('light-contrast'),
      callOf('closePreview'),
      callOf('leaveLocal'),
      receiptOf('leave-sync'),
      /selectAppearanceMode\([^;]*'dark'/u,
      callOf('tapMessageLink'),
      callOf('tapPreviewPrimary'),
      recordOf('dark-contrast'),
      callOf('tapPreviewPrimary'),
      recordOf('remote-opened'),
    ],
    'runFederatedJoin',
  );
  expect(stage.runFederatedJoin.match(/createRemoteRoom\(/gu)).toHaveLength(1);
  expect(stage.runFederatedJoin.match(/\bregisterRemote\(/gu)).toHaveLength(1);
  expect(
    stage.runFederatedJoin.match(/'light'/gu)?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    stage.runFederatedJoin.match(/'dark'/gu)?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(stage.runFederatedJoin).toContain('trackRoomMembership(');
  expect(stage.runFederatedJoin).toContain('allowEndedMembershipCleanup(');
  expect(stage.runFederatedJoin).toContain('awaitAliasFederation(');
  assertOrder(
    stage.runRemoteUnavailable,
    [
      callOf('awaitProfileFederation'),
      callOf('tapMessageLink'),
      recordOf('load-error-visible'),
      recordOf('load-error-guidance'),
      recordOf('no-primary-action'),
    ],
    'runRemoteUnavailable',
  );
  assertOrder(
    stage.runRejectedJoin,
    [
      callOf('awaitProfileFederation'),
      recordOf('join-action'),
      callOf('setRemoteJoinRule'),
      recordOf('join-rule-invite'),
      callOf('tapPreviewPrimary'),
      recordOf('action-error'),
    ],
    'runRejectedJoin',
  );
  expect(stage.runRejectedJoin).not.toContain('trackRoomMembership(');
  // Every native Join tap runs inside the landed-Join handover (D1).
  assertOrder(
    stage.runFederatedJoin,
    [
      callOf('afterJoinTap'),
      /tapPreviewPrimary\(context, JOIN_ROOM_LABEL\)/u,
      recordOf('joined-notice'),
      /'first federated join on both servers'\);\s*\}\);/u,
      callOf('base\\.trackRoomMembership'),
    ],
    'runFederatedJoin handover',
  );
  expect(
    stage.runFederatedJoin.indexOf(
      'tapPreviewPrimary(context, JOIN_ROOM_LABEL)',
    ),
  ).toBeGreaterThan(stage.runFederatedJoin.indexOf('afterJoinTap('));
  assertOrder(
    stage.runRejectedJoin,
    [
      callOf('setRemoteJoinRule'),
      callOf('afterJoinTap'),
      callOf('tapPreviewPrimary'),
      recordOf('action-error'),
      receiptOf('rejected-join-state'),
    ],
    'runRejectedJoin handover',
  );
  expect(stage.runRejectedJoin.match(/\btapPreviewPrimary\(/gu)).toHaveLength(
    1,
  );
  const handover = functionSource(journeys, 'afterJoinTap');
  assertOrder(
    handover,
    [
      /try\s*\{\s*return await \w+\(\);\s*\}\s*catch/u,
      /AbortSignal\.timeout\(/u,
      callOf('trackRoomMembership'),
      callOf('allowEndedMembershipCleanup'),
      /throw error;/u,
    ],
    'afterJoinTap',
  );
  expect(handover.match(/trackRoomMembership\(/gu)).toHaveLength(1);
  expect(stage.runPortraitSheet).not.toMatch(
    /tapPreviewPrimary\(|room-link-primary"\]'\)\s*\)|tapCurrent\(\s*['"`]\[data-testid="room-link-primary"\]/u,
  );
  assertOrder(
    stage.runPortraitSheet,
    [
      callOf('tapMessageLink'),
      /client\.hideKeyboard\(\)/u,
      recordOf('footer-top'),
      recordOf('footer-bottom'),
    ],
    'runPortraitSheet',
  );
  expect(stage.runPortraitSheet).toContain('nativeRect(');
  expect(stage.runPortraitSheet).toContain('parseNavigationBarFrame(');
  assertOrder(
    stage.runMentionUserCard,
    [
      callOf('displayName'),
      /client\.login\(/u,
      /coarse|Pointer|pointer/u,
      /tapCurrent\(\s*'\.scroll a'/u,
      recordOf('card-visible'),
      recordOf('room-retained'),
    ],
    'runMentionUserCard',
  );
  for (const selector of [
    '[data-testid="open-settings"]',
    '[data-testid="settings-nav-appearance"]',
    'trn-page-header button[aria-label="Back"]',
  ])
    expect(journeys).toContain(`tapCurrent('${selector}'`);
  expect(journeys).toMatch(
    /tapCurrent\(\s*`\[data-testid="mode-\$\{mode\}"\]`|tapCurrent\('\[data-testid="mode-(?:light|dark)"\]'/u,
  );
  const select = functionSource(journeys, 'selectAppearanceMode');
  assertOrder(
    select,
    [
      /readAppliedMode\(/u,
      /tapCurrent\('\[data-testid="open-settings"\]'/u,
      /tapCurrent\('\[data-testid="settings-nav-appearance"\]'/u,
      /scrollIntoViewIfNeeded\(/u,
      /tapCurrent\(\s*`\[data-testid="mode-\$\{mode\}"\]`/u,
      /assertModeOnlyChange\(/u,
      /tapCurrent\('trn-page-header button\[aria-label="Back"\]'/u,
      /\.url\s*===\s*\w+|\w+\s*===\s*[\w.]+\.url/u,
    ],
    'selectAppearanceMode',
  );
  const runner = functionSource(journeys, 'runMessageLinksSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createMessageLinksFixtures\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_LINKS_STAGES/u,
    ],
    'runMessageLinksSuite',
  );
  for (const required of [
    'expectedStages: 6',
    'expectedAssertionRecords: 63',
    'attempt: 1',
    'retries: 0',
    'runMessageLinksStageCleanup(',
    'markMessageLinksDiagnosticsSafe(',
    'scrubMessageLinksArtifacts(',
    'revokeMessageLinksPublicationOnAbort(',
    'guardedCleanup',
  ])
    expect(journeys).toContain(required);
  expect(journeys).toContain('timeout: 2_700_000');
  expect(journeys).toContain(
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  );
  expect(journeys).not.toMatch(
    /Emulation\.|setDeviceMetricsOverride|addEventListener\(\s*['"`]click/u,
  );
}

describe('Android message-links source rules', () => {
  it('keeps the observer, fixtures and artifacts free of forbidden actions and literals', () => {
    for (const path of [OBSERVER, FIXTURES, ARTIFACTS]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    const observer = read(OBSERVER);
    assertReadOnlyObserver(observer);
    // The journeys module evaluates its own renderer expression (the
    // primary-actionability receipt); it is held to the same read-only rule.
    const journeySource = read('e2e/android/message-links-journeys.mts');
    assertReadOnlyObserver(journeySource);
    expect(() =>
      assertReadOnlyObserver(
        journeySource.replace(
          'const buttons = [',
          'document.scrollingElement.scrollTo(0, 0); const buttons = [',
        ),
      ),
    ).toThrow();
    // Allow-listed: the detached contrast canvas is created and never attached.
    expect(observer).toContain("document.createElement('canvas')");
    expect(observer).not.toMatch(
      /appendChild|\.append\(|insertBefore|insertAdjacent|replaceChildren/u,
    );
    expect(observer).not.toContain('seedPreference');
    expect(read(FIXTURES)).toContain("from '../support/synapse/start.mjs'");
    expect(read(ARTIFACTS)).not.toContain('message-linkify-artifacts');
    // Allow-listed: the client's own capture-phase click listener and viewport owner.
    const client = read(CLIENT);
    expect(client).toContain('private async nativeAction(');
    expect(client).toContain('async reset(profile = DESKTOP_ACCOUNT_PROFILE)');
    expect(client).toContain('async resize(width: number, height: number)');
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'document.documentElement.classList.remove("dark")',
      'root.style.fontSize = "24px"',
      'root.setAttribute("data-theme", "dark")',
      'window.location = "/rooms"',
      'window.location.assign("/rooms")',
      "await client.key('enter')",
      'await client.focusCurrent(PRIMARY)',
      'await pressAndroidKeyboardKey(device, "enter")',
      'element.dispatchEvent(new Event("click"))',
      'element.scrollIntoView()',
      "await seedPreference(client, 'mode', 'dark')",
      "await Preferences.set({ key: 'mode', value: 'dark' })",
      "await device.adb('shell', 'cmd', 'uimode', 'night', 'yes')",
      "'e2e/android/flows/native-shell-appearance-dark.yaml'",
      "'e2e/android/flows/native-shell-back.yaml'",
      "await device.adb('reverse', 'tcp:8009', 'tcp:8009')",
      "const hs = 'http://localhost:8008'",
      "const secret = 'trinity-e2e-shared-secret'",
      'const report = { retries: 1 }',
      'await client.navigate("/settings")',
      'await Input.dispatchTouchEvent({})',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'root.style.fontSize = "24px"',
      'window.location = "/"',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(SELECTOR, accepts, "x");',
    ])
      expect(() =>
        assertBoundedWaits(`${observer}\n${unbounded}`, OBSERVER),
      ).toThrow();
  });

  it('drives every product action natively in source order in each stage', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      `${journeys}\nawait client.key('enter');`,
      `${journeys}\nconst primary = element; primary.focus();`,
      `${journeys}\nawait seedPreference(client, 'mode', 'dark');`,
      `${journeys}\nconst report = { retries: 1 };`,
      replace(
        /tapCurrent\('\[data-testid="open-settings"\]'/u,
        'tapCurrent(\'[data-testid="open-menu"]\'',
      ),
      replace(
        /tapCurrent\('trn-page-header button\[aria-label="Back"\]'/u,
        'tapCurrent(\'[data-testid="back"]\'',
      ),
      replace(/receipt\(\s*(\w+),\s*'leave-sync'/u, "receipt($1, 'leave-done'"),
      replace(
        /record\(\s*(\w+),\s*'join-rule-invite'/u,
        "record($1, 'join-rule-changed'",
      ),
      replace(
        /await afterJoinTap\(context, \{ local, remote, roomId: remoteRoom\.id \}, async \(\) => \{/u,
        'await (async () => {',
      ),
      replace(
        /const firstMembership = await afterJoinTap\(context, join, async \(\) => \{/u,
        'const firstMembership = await (async () => {',
      ),
      replace(
        /if \(landed \|\| unread\.length\) \{\n\s*context\.base\.trackRoomMembership/u,
        'if (landed || unread.length) {\n      void context.base.joinedRoomIds',
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_LINKS_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_LINKS_STAGES[0],
      records: [],
      identities: new Set(),
      receipts: 0,
      client: {
        async record(name, value) {
          written.push({ name, value });
        },
      },
    };
    await record(context, 'room-open', () => {}, { ready: true });
    expect(context.records).toEqual(['message-links.joined-preview.room-open']);
    expect(written.map((entry) => entry.name)).toEqual([
      'message-links.joined-preview.room-open',
    ]);
    expect(written[0].value).toMatchObject({
      assertion: 'message-links.joined-preview.room-open',
      observation: { ready: true },
    });
    await expect(
      record(
        context,
        'preview-visible',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    expect(written).toHaveLength(1);
    await expect(record(context, 'room-open', () => {}, {})).rejects.toThrow();
    await expect(
      record(context, 'target-name', () => {}, {}),
    ).rejects.toThrow();
    await expect(record(context, 'not-owned', () => {}, {})).rejects.toThrow();
    expect(context.records).toHaveLength(1);

    await receipt(context, 'membership-1', { secondary: 'join' });
    const receiptName = written.at(-1).name;
    expect(receiptName).toMatch(/^receipt-\d{2}-membership-1$/u);
    for (const name of [
      'message-links.joined-preview.room-open',
      'Leave Sync',
      'a/b',
      '',
    ])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });
});
