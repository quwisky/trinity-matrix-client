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

const root = resolve(import.meta.dirname, '..');
const predecessor =
  'e2e/browser/journeys/conversations/message-receipts.spec.mts';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (path) => sha256(readFileSync(resolve(root, path)));
const loadContract = () =>
  import('../e2e/android/message-receipts-contract.mts');
const loadObserver = () =>
  import('../e2e/android/message-receipts-observer.mts');
const loadArtifacts = () =>
  import('../e2e/android/message-receipts-artifacts.mts');
const loadJourneys = () =>
  import('../e2e/android/message-receipts-journeys.mts');
const loadClient = () => import('../e2e/android/account-workspace-client.mts');

const JOURNEYS = 'e2e/android/message-receipts-journeys.mts';
const OBSERVER = 'e2e/android/message-receipts-observer.mts';
const ARTIFACTS = 'e2e/android/message-receipts-artifacts.mts';
const CONTRACT = 'e2e/android/message-receipts-contract.mts';
const FIXTURES = 'e2e/android/account-workspace-fixtures.mts';

/** The predecessor as the issue pins it; this branch carries it unchanged. */
const PREDECESSOR_SHA256 =
  '5d4d757364c6b5b1a5a0e148c8c17adf173296bb2f435730d2803ed7854baa42';
const SHARED_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
};
const API_TOKEN_SPAN = [19, 38];
const OPEN_ROOM_SPAN = [40, 48];

/** The design's identity table, verbatim. */
const STAGE = {
  id: 'seen-by',
  span: [53, 165],
  title: "shows a reader's avatar on the message they read",
  direct: [122, 123, 164],
  inherited: [[45, 'openRoom', 118]],
  suffixes: ['room-ready', 'cluster-visible', 'seer-named', 'text-clear'],
};
const ALL_IDENTITIES = STAGE.suffixes.map(
  (suffix) => `message-receipts.${STAGE.id}.${suffix}`,
);

const LINE_PINS = {
  17: 'const session = synapseSession();',
  19: 'async function apiToken(',
  20: 'request: APIRequestContext,',
  24: '): Promise<{ userId: string; headers: { Authorization: string } }> {',
  25: 'const json = await request',
  26: '.post(`${hs}/_matrix/client/v3/login`, {',
  28: "type: 'm.login.password',",
  29: "identifier: { type: 'm.id.user', user },",
  36: 'headers: { Authorization: `Bearer ${json.access_token}` },',
  40: 'async function openRoom(page: Page, roomName: string): Promise<void> {',
  41: "await page.getByTestId('rail-rooms').click();",
  42: "const channel = page.locator('.channel', { hasText: roomName });",
  43: "await channel.first().waitFor({ state: 'visible', timeout: 30_000 });",
  44: 'await channel.first().click();',
  45: "await expect(page.getByTestId('composer-input')).toBeVisible({",
  46: 'timeout: 15_000,',
  51: "test.skip(!session.available, 'needs a Synapse homeserver (Docker)');",
  53: 'test("shows a reader\'s avatar on the message they read", async ({',
  57: "const runId = `${testResourceId('run')}s`;",
  60: "await registerUser(request, `rcpt-reader-${runId}`, 'pass-reader');",
  61: "await registerUser(request, `rcpt-author-${runId}`, 'pass-author');",
  62: "await registerUser(request, `rcpt-seer-${runId}`, 'pass-seer');",
  63: 'const reader = await apiToken(',
  69: 'const author = await apiToken(',
  75: "const seer = await apiToken(request, hs, `rcpt-seer-${runId}`, 'pass-seer');",
  77: 'const seerName = `Cara${runId}`;',
  78: 'await request.put(',
  79: '`${hs}/_matrix/client/v3/profile/${encodeURIComponent(seer.userId)}/displayname`,',
  80: '{ headers: seer.headers, data: { displayname: seerName } },',
  83: 'const roomName = `Receipts E2E ${runId}`;',
  84: 'const roomId = await request',
  85: '.post(`${hs}/_matrix/client/v3/createRoom`, {',
  86: 'headers: reader.headers,',
  87: 'data: { name: roomName, invite: [author.userId, seer.userId] },',
  91: 'for (const who of [author, seer]) {',
  92: 'await request.post(',
  93: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,',
  94: '{ headers: who.headers },',
  99: 'const body = `read receipt target ${runId}`;',
  100: 'const eventId = await request',
  102: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/rcpt-${runId}`,',
  103: "{ headers: author.headers, data: { msgtype: 'm.text', body } },",
  107: 'await request.post(',
  108: '`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,',
  109: '{ headers: seer.headers, data: {} },',
  112: 'await login(page, {',
  115: 'user: `rcpt-reader-${runId}`,',
  116: "pass: 'pass-reader',",
  118: 'await openRoom(page, roomName);',
  121: 'const receipts = page.locator(\'.scroll [data-testid="read-receipts"]\');',
  122: 'await expect(receipts.first()).toBeVisible({ timeout: 20_000 });',
  123: 'await expect(receipts.first()).toHaveAttribute(',
  124: "'aria-label',",
  125: 'new RegExp(seerName),',
  143: 'const overlap = await page.evaluate(() => {',
  144: "const bar = document.querySelector('[data-testid=read-receipts]');",
  145: "const row = bar?.closest('.msg');",
  146: "const text = row?.querySelector('.msg__text');",
  150: 'const b = bar.getBoundingClientRect();',
  151: 'const t = text.getBoundingClientRect();',
  153: 'intersects:',
  154: 'b.left < t.right &&',
  155: 'b.right > t.left &&',
  156: 'b.top < t.bottom &&',
  157: 'b.bottom > t.top,',
  161: 'if (!overlap) {',
  162: "throw new Error('expected a row carrying read receipts');",
  164: 'expect(overlap.intersects).toBe(false);',
};

const IMPORTS = `import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';`;

/* ------------------------------------------------------------------------ */
/* Predecessor AST analysis                                                  */
/* ------------------------------------------------------------------------ */

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
const endLineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

function assertionLines(source, start, end, name = predecessor) {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      const line = lineOf(tree, node);
      if (line >= start && line <= end) lines.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return lines;
}

/** Map a relative import specifier of `from` to a repository path. */
const repositoryPath = (from, specifier) =>
  posix.normalize(posix.join(posix.dirname(from), specifier));

/**
 * Resolve every call through the TypeChecker. A call binds to a helper only
 * when its symbol is a named import or a module-level function declaration, so
 * a shadowing local of the same name never expands.
 */
function importedCalls(source, fileName = predecessor) {
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
function helperExpectLines(
  module,
  name,
  source = read(module),
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
  const { calls } = importedCalls(source, module);
  const nested = calls
    .filter((call) => call.line >= start && call.line <= end)
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
  return [...own, ...nested];
}

/**
 * Expand the definition into parity sites: direct `expect` calls and
 * binding-resolved helper calls. The predecessor has no platform branch.
 */
function expandDefinition(source, span) {
  const [from, to] = span;
  const { calls } = importedCalls(source);
  const inherited = calls
    .filter(
      (call) =>
        call.line >= from &&
        call.line <= to &&
        (call.specifier === null ||
          call.specifier.startsWith('../../../support/')),
    )
    .flatMap((call) => {
      const module =
        call.specifier === null
          ? predecessor
          : repositoryPath(predecessor, call.specifier);
      const lines = helperExpectLines(
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

const siteTuple = (site) =>
  site.kind === 'direct'
    ? ['direct', site.line]
    : ['inherited', site.line, site.helper, site.call];
const ledgerTuples = () => {
  const inherited = STAGE.inherited.map(([line, helper, call]) => [
    'inherited',
    line,
    helper,
    call,
  ]);
  const key = (tuple) =>
    tuple[0] === 'direct' ? [tuple[1], 1] : [tuple[3], 0];
  return [...inherited, ...STAGE.direct.map((line) => ['direct', line])].sort(
    (a, b) => {
      const [left, right] = [key(a), key(b)];
      return left[0] - right[0] || left[1] - right[1];
    },
  );
};

const lineAt = (source, line) => source.split('\n')[line - 1]?.trim();

/** Every text-level predecessor pin, independent of the byte hash. */
function assertPredecessorShape(source) {
  expect(source.split('\n')).toHaveLength(167);
  expect(source.split('\n').slice(0, 13).join('\n')).toBe(IMPORTS);
  for (const [line, text] of Object.entries(LINE_PINS))
    expect(lineAt(source, Number(line)), `line ${line}`).toBe(text);
  expect(lineAt(source, API_TOKEN_SPAN[1])).toBe('}');
  expect(lineAt(source, OPEN_ROOM_SPAN[1])).toBe('}');
  expect(assertionLines(source, ...API_TOKEN_SPAN)).toEqual([]);
  expect(assertionLines(source, ...OPEN_ROOM_SPAN)).toEqual([45]);
  expect(assertionLines(source, 1, API_TOKEN_SPAN[0] - 1)).toEqual([]);
  expect(
    assertionLines(source, OPEN_ROOM_SPAN[1] + 1, STAGE.span[0] - 1),
  ).toEqual([]);
  expect(assertionLines(source, STAGE.span[1] + 1, 167)).toEqual([]);
  expect(lineAt(source, STAGE.span[1])).toBe('});');
  const expanded = expandDefinition(source, STAGE.span);
  expect(expanded.map(siteTuple)).toEqual(ledgerTuples());
  expect(
    expanded.filter((site) => site.kind === 'direct').map((s) => s.line),
  ).toEqual(STAGE.direct);
  expect(expanded.filter((site) => site.kind === 'inherited')).toHaveLength(1);
  // The display name is set before the Room exists, and the receipt follows the send.
  const lines = source.split('\n');
  const at = (text) => lines.findIndex((line) => line.trim() === text) + 1;
  expect(at(LINE_PINS[79])).toBeLessThan(at(LINE_PINS[85]));
  expect(at(LINE_PINS[102])).toBeLessThan(at(LINE_PINS[108]));
}

const mutateLine = (source, line, replacement) => {
  const lines = source.split('\n');
  lines[line - 1] = replacement(lines[line - 1]);
  return lines.join('\n');
};

describe('Android message-receipts predecessor pins', () => {
  it('pins the unchanged predecessor and the two shared helper sources by SHA-256', () => {
    expect(digest(predecessor)).toBe(PREDECESSOR_SHA256);
    for (const [path, hash] of Object.entries(SHARED_SHA256))
      expect(digest(path)).toBe(hash);
    const flipped = Buffer.from(readFileSync(resolve(root, predecessor)));
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
    expect(contract.MESSAGE_RECEIPTS_SOURCE).toBe(predecessor);
    expect(contract.MESSAGE_RECEIPTS_SOURCE_SHA256).toBe(PREDECESSOR_SHA256);
    expect(contract.MESSAGE_RECEIPTS_SOURCE_LINES).toBe(166);
    expect(contract.MESSAGE_RECEIPTS_SHARED_SOURCE_SHA256).toEqual(
      SHARED_SHA256,
    );
    const span = ([from, to]) => ({ from, to });
    expect(contract.MESSAGE_RECEIPTS_SPANS).toEqual({
      apiToken: span(API_TOKEN_SPAN),
      openRoom: span(OPEN_ROOM_SPAN),
      definitions: { [STAGE.id]: span(STAGE.span) },
    });
  });

  it('keeps the predecessor enabled in both Playwright inventories', async () => {
    const { BROWSER_JOURNEYS } =
      await import('../e2e/browser/journey-catalog.mts');
    expect(
      BROWSER_JOURNEYS.filter(
        (journey) =>
          journey.path === 'journeys/conversations/message-receipts.spec.mts',
      ),
    ).toHaveLength(1);
    const android = read('e2e/android/playwright.config.mts');
    expect(android).toContain(
      "testMatch: ['browser/journeys/**/*.spec.mts', 'android/**/*.spec.mts']",
    );
    for (const config of [android, read('e2e/browser/playwright.config.mts')]) {
      expect(config).not.toContain('testIgnore');
      expect(config).not.toContain('message-receipts');
    }
    // Both projects run it at the wide desktop shell the suite uses.
    expect(android).toContain('viewport: { width: 1280, height: 720 },');
    expect(android).toContain('hasTouch: false,');
    expect(read('e2e/browser/playwright.config.mts')).toContain(
      "projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],",
    );
    const source = read(predecessor);
    expect(source).not.toMatch(/test\.(?:fixme|only)\(|test\.skip\(true/u);
    expect(source.match(/test\.skip\(/gu)).toHaveLength(1);
    expect(source.match(/^ {2}test\(/gmu)).toHaveLength(1);
    expect(source).not.toMatch(/isAndroidE2E|test\.use\(/u);
  });

  it('maps the exact direct and helper sites with the house AST rule', () => {
    assertPredecessorShape(read(predecessor));
  });

  it('fails every text-level pin under an effective in-memory mutation', () => {
    const source = read(predecessor);
    const mutations = [
      // A role, name, body, transaction, receipt type or locator drifts.
      mutateLine(source, 57, (line) => line.replace('}s`', '}r`')),
      mutateLine(source, 60, (line) => line.replace('rcpt-reader', 'reader')),
      mutateLine(source, 62, (line) => line.replace('rcpt-seer', 'rcpt-see')),
      mutateLine(source, 77, (line) => line.replace('Cara', 'Bob')),
      mutateLine(source, 83, (line) => line.replace('Receipts E2E', 'Rcpt')),
      mutateLine(source, 87, (line) => line.replace(', seer.userId', '')),
      mutateLine(source, 99, (line) => line.replace('target', 'goal')),
      mutateLine(source, 102, (line) => line.replace('/rcpt-', '/r-')),
      mutateLine(source, 108, (line) =>
        line.replace('m.read', 'm.read.private'),
      ),
      mutateLine(source, 108, (line) =>
        line.replace('encodeURIComponent(eventId)', "'$other'"),
      ),
      mutateLine(source, 109, (line) =>
        line.replace('seer.headers', 'author.headers'),
      ),
      mutateLine(source, 121, (line) => line.replace('.scroll ', '')),
      mutateLine(source, 125, (line) => line.replace('seerName', 'roomName')),
      mutateLine(source, 144, (line) =>
        line.replace('read-receipts', 'seen-by'),
      ),
      mutateLine(source, 146, (line) =>
        line.replace('.msg__text', '.msg__body'),
      ),
      mutateLine(source, 154, (line) => line.replace('<', '<=')),
      mutateLine(source, 157, (line) => line.replace('b.bottom', 'b.top')),
      // The display name moves after createRoom.
      (() => {
        const lines = source.split('\n');
        const put = lines.splice(77, 4);
        lines.splice(86, 0, ...put);
        return lines.join('\n');
      })(),
      // A direct site is dropped, added or moved.
      mutateLine(source, 164, () => '    void overlap;'),
      mutateLine(
        source,
        127,
        () => '    await expect(receipts).toHaveCount(1);',
      ),
      mutateLine(source, 120, (line) => `${line}\n`),
      // The helper call changes, or the helper loses its own assertion.
      mutateLine(source, 118, () => '    void roomName;'),
      mutateLine(
        source,
        45,
        () => "  await page.getByTestId('composer-input').waitFor({",
      ),
      // A definition title or import drifts.
      source.replace(
        'test("shows a reader\'s avatar on the message they read"',
        'test("shows the reader\'s avatar"',
      ),
      source.replace(
        'import { registerUser }',
        'import { registerUser as register }',
      ),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(() => assertPredecessorShape(mutated)).toThrow();
    }
  });
});

describe('Android message-receipts helper expansion by binding', () => {
  it('resolves module-local and imported helper calls through the TypeChecker', () => {
    const { calls } = importedCalls(read(predecessor));
    expect(
      calls
        .filter(
          (call) =>
            call.specifier === null ||
            call.specifier.startsWith('../../../support/'),
        )
        .map((call) => [call.name, call.line]),
    ).toEqual([
      // Module level (line 17), outside the owned definition.
      ['synapseSession', 17],
      ['registerUser', 60],
      ['registerUser', 61],
      ['registerUser', 62],
      ['apiToken', 63],
      ['apiToken', 69],
      ['apiToken', 75],
      ['login', 112],
      ['openRoom', 118],
    ]);
  });

  it('follows helper calls and proves registration, API tokens and login add no sites', () => {
    const source = read(predecessor);
    expect(helperExpectLines(predecessor, 'openRoom', source)).toEqual([
      { module: predecessor, line: 45 },
    ]);
    expect(helperExpectLines(predecessor, 'apiToken', source)).toEqual([]);
    expect(helperExpectLines('e2e/support/app.mts', 'login')).toEqual([]);
    expect(
      helperExpectLines('e2e/support/account.mts', 'registerUser'),
    ).toEqual([]);
    // A helper assertion added to apiToken would expand three times.
    const asserted = source.replace(
      '  return {\n    userId: json.user_id as string,',
      '  expect(json.user_id).toBeTruthy();\n  return {\n    userId: json.user_id as string,',
    );
    expect(asserted).not.toBe(source);
    expect(
      expandDefinition(asserted, STAGE.span).filter(
        (site) => site.helper === 'apiToken',
      ),
    ).toHaveLength(3);
  });

  it('excludes a shadowing local helper, against a naive count', () => {
    const source = read(predecessor);
    const shadowed = source.replace(
      '    await openRoom(page, roomName);',
      '    const openRoom = async (_page: Page, _name: string) => {};\n    await openRoom(page, roomName);',
    );
    expect(shadowed).not.toBe(source);
    const { calls, shadowed: locals } = importedCalls(shadowed);
    expect(locals.map((call) => call.name)).toEqual(['openRoom']);
    expect(calls.filter((call) => call.name === 'openRoom')).toHaveLength(0);
    expect(shadowed.match(/\bopenRoom\(/gu)).toHaveLength(2);
    expect(() => assertPredecessorShape(shadowed)).toThrow();
  });

  it('expands exactly 1 Room readiness site, for 3 direct + 1 inherited = 4', () => {
    const expanded = expandDefinition(read(predecessor), STAGE.span);
    expect(expanded.map(siteTuple)).toEqual([
      ['inherited', 45, 'openRoom', 118],
      ['direct', 122],
      ['direct', 123],
      ['direct', 164],
    ]);
  });

  it('matches the contract sites, identities and helper roles exactly', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    const expanded = expandDefinition(source, STAGE.span);
    const [stage] = contract.MESSAGE_RECEIPTS_STAGES;
    expect(stage.sites.map(siteTuple)).toEqual(expanded.map(siteTuple));
    expect(stage.assertions).toEqual(ALL_IDENTITIES);
    expect(stage.sites.map(siteTuple)).not.toEqual(
      expanded.slice(0, -1).map(siteTuple),
    );
    for (const [helper, { module, expectLines }] of Object.entries(
      contract.MESSAGE_RECEIPTS_HELPERS,
    ))
      expect(
        helperExpectLines(
          module,
          helper,
          module === predecessor ? source : undefined,
        ),
      ).toEqual(expectLines.map((line) => ({ module, line })));
    expect(
      Object.fromEntries(
        Object.entries(contract.MESSAGE_RECEIPTS_HELPERS).map(
          ([name, value]) => [name, value.role],
        ),
      ),
    ).toEqual({ openRoom: 'room-readiness' });
  });
});

/* ------------------------------------------------------------------------ */
/* Contract ledger and receipt fields                                        */
/* ------------------------------------------------------------------------ */

/** Every template literal bound to a name inside a span, read from the AST. */
function predecessorTemplates(source, [from, to]) {
  const tree = ts.createSourceFile(
    predecessor,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const templates = {};
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isTemplateExpression(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
      lineOf(tree, node) >= from &&
      lineOf(tree, node) <= to
    )
      templates[node.name.text] = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return templates;
}

describe('Android message-receipts contract ledger', () => {
  it('owns one stage, 3 direct + 1 inherited = 4 unique identities', async () => {
    const contract = await loadContract();
    expect(contract.MESSAGE_RECEIPTS_STAGES.map((entry) => entry.id)).toEqual([
      STAGE.id,
    ]);
    const [stage] = contract.MESSAGE_RECEIPTS_STAGES;
    expect(stage.source).toBe(`${predecessor}:53-165`);
    expect(stage.title).toBe(STAGE.title);
    expect(stage.expectedAssertionRecords).toBe(4);
    expect(contract.MESSAGE_RECEIPTS_ASSERTION_RECORDS).toBe(4);
    expect(contract.MESSAGE_RECEIPTS_DIRECT).toBe(3);
    expect(contract.MESSAGE_RECEIPTS_INHERITED).toBe(1);
    expect(new Set(ALL_IDENTITIES).size).toBe(4);
  });

  it('resolves identities and rejects out-of-order, duplicate, short and long records', async () => {
    const contract = await loadContract();
    expect(() =>
      contract.assertMessageReceiptsRecords(STAGE.id, ALL_IDENTITIES),
    ).not.toThrow();
    for (const invalid of [
      [],
      ALL_IDENTITIES.slice(0, -1),
      [...ALL_IDENTITIES, ALL_IDENTITIES.at(-1)],
      [...ALL_IDENTITIES].reverse(),
      ALL_IDENTITIES.map((identity, index) =>
        index === 1 ? ALL_IDENTITIES[0] : identity,
      ),
    ])
      expect(() =>
        contract.assertMessageReceiptsRecords(STAGE.id, invalid),
      ).toThrow();
    expect(() =>
      contract.messageReceiptsAssertion(STAGE.id, 'not-owned'),
    ).toThrow();
    expect(() =>
      contract.messageReceiptsAssertion('not-a-stage', 'room-ready'),
    ).toThrow();
  });

  it('types exactly the predecessor roles, names, body and transaction', async () => {
    const contract = await loadContract();
    const source = read(predecessor);
    expect(predecessorTemplates(source, STAGE.span)).toMatchObject({
      runId: "`${testResourceId('run')}s`",
      seerName: '`Cara${runId}`',
      roomName: '`Receipts E2E ${runId}`',
      body: '`read receipt target ${runId}`',
    });
    expect(contract.MESSAGE_RECEIPTS_RUN_SUFFIX).toBe('s');
    expect([...contract.MESSAGE_RECEIPTS_ROLES]).toEqual([
      'reader',
      'author',
      'seer',
    ]);
    for (const role of contract.MESSAGE_RECEIPTS_ROLES) {
      expect(contract.receiptsAccountRole(role)).toBe(`rcpt-${role}`);
      expect(source).toContain(`\`rcpt-${role}-\${runId}\``);
    }
    const run = 'trn-r-0a1bs';
    expect(contract.receiptsSeerName(run)).toBe('Caratrn-r-0a1bs');
    expect(contract.receiptsRoomName(run)).toBe('Receipts E2E trn-r-0a1bs');
    expect(contract.receiptsBody(run)).toBe('read receipt target trn-r-0a1bs');
    expect(contract.receiptsTransaction(run)).toBe('rcpt-trn-r-0a1bs');
    expect(contract.SEEN_BY_PREFIX).toBe('Seen by ');
    expect(contract.SEEN_BY_SEPARATOR).toBe(', ');
  });

  it('keeps receipts out of the parity namespace', async () => {
    const { assertMessageReceiptsReceiptName } = await loadContract();
    for (const name of [
      'message-event',
      'seer-membership',
      'receipt-relation',
      'relation-retained',
    ])
      expect(() => assertMessageReceiptsReceiptName(name)).not.toThrow();
    for (const name of [
      'message-receipts.seen-by.room-ready',
      'message-receipts-x',
      'Receipt Relation',
      'a/b',
      '',
    ])
      expect(() => assertMessageReceiptsReceiptName(name)).toThrow();
  });

  it('pins the product receipt cluster, label and sender filter the journey relies on', () => {
    const row = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.html',
    );
    for (const hook of [
      '[attr.data-mid]="r.id"',
      'class="msg msg--event"',
      '<p class="msg__text">{{ r.body }}</p>',
      '@if (r.readReceipts.length) {',
      'class="msg__receipts msg__target"',
      'data-testid="read-receipts"',
      '[attr.aria-label]="seenByLabel(r.readReceipts)"',
      'class="msg__receipt"',
    ])
      expect(row).toContain(hook);
    const cluster = row.slice(row.indexOf('@if (r.readReceipts.length) {'));
    expect(cluster.indexOf('<button')).toBeLessThan(
      cluster.indexOf('data-testid="read-receipts"'),
    );
    const component = read(
      'libs/feature/rooms/src/lib/message-row/message-row.component.ts',
    );
    expect(component).toContain(
      "return `Seen by ${receipts.map((r) => r.name).join(', ')}`;",
    );
    const view = read('libs/util/matrix/src/lib/message-view.ts');
    expect(view).toContain('.filter((id) => id !== selfId)');
    expect(view).toContain('const name = member?.name || userId;');
  });
});

/* ------------------------------------------------------------------------ */
/* Authoritative Matrix state                                                */
/* ------------------------------------------------------------------------ */

const ROOM = '!Receipt_Ab+c/d:localhost';
const READER = '@trn_rcpt_reader_0a1b2c3d4e5f:localhost';
const AUTHOR = '@trn_rcpt_author_0a1b2c3d4e5f:localhost';
const SEER = '@trn_rcpt_seer_0a1b2c3d4e5f:localhost';
const STRANGER = '@stranger:localhost';
const EVENT_ID = '$Target_A+b/C=d';
const OTHER_EVENT = '$Other_E+f/G=h';
const RUN = 'trn-receipts-seen-by-0a1b2cs';
const SEER_NAME = `Cara${RUN}`;
const BODY = `read receipt target ${RUN}`;
const ROOM_NAME = `Receipts E2E ${RUN}`;
const READER_NAME = 'trn_rcpt_reader_0a1b2c3d4e5f';
const AUTHOR_NAME = 'trn_rcpt_author_0a1b2c3d4e5f';

const member = (stateKey, membership, sender, displayname, id) => ({
  type: 'm.room.member',
  event_id: id,
  room_id: ROOM,
  sender,
  state_key: stateKey,
  content: {
    membership,
    ...(displayname === undefined ? {} : { displayname }),
  },
});
const message = (overrides = {}, content = {}) => ({
  type: 'm.room.message',
  event_id: EVENT_ID,
  room_id: ROOM,
  sender: AUTHOR,
  content: { msgtype: 'm.text', body: BODY, ...content },
  ...overrides,
});
/** The production timeline oldest first, as `/messages?dir=b` returns it reversed. */
const timelineEvents = (options = {}) => [
  {
    type: 'm.room.create',
    event_id: '$create',
    room_id: ROOM,
    sender: READER,
    state_key: '',
    content: {},
  },
  member(READER, 'join', READER, READER_NAME, '$j-reader'),
  {
    type: 'm.room.power_levels',
    event_id: '$power',
    room_id: ROOM,
    sender: READER,
    state_key: '',
    content: {},
  },
  {
    type: 'm.room.name',
    event_id: '$name',
    room_id: ROOM,
    sender: READER,
    state_key: '',
    content: { name: ROOM_NAME },
  },
  member(AUTHOR, 'invite', READER, AUTHOR_NAME, '$i-author'),
  member(SEER, 'invite', READER, options.inviteName ?? SEER_NAME, '$i-seer'),
  member(AUTHOR, 'join', AUTHOR, AUTHOR_NAME, '$j-author'),
  member(SEER, 'join', SEER, options.joinName ?? SEER_NAME, '$j-seer'),
  ...(options.extra ?? []),
  message(options.message),
];
const page = (events) => ({
  chunk: [...events].reverse(),
  start: 's',
  end: 'e',
});
const receiptEvent = (content) => [{ type: 'm.receipt', content }];
const seerReceipt = (
  eventId = EVENT_ID,
  user = SEER,
  receipt = { ts: 1_700 },
) => receiptEvent({ [eventId]: { 'm.read': { [user]: receipt } } });
const ROOM_EXPECTATION = {
  roomId: ROOM,
  readerId: READER,
  authorId: AUTHOR,
  seerId: SEER,
  seerName: SEER_NAME,
  body: BODY,
  eventId: EVENT_ID,
};

describe('Android message-receipts authoritative Matrix contract', () => {
  it('reads every event of the page, oldest first, and every m.read entry', async () => {
    const { authoritativeTimeline, authoritativeReadReceipts } =
      await loadContract();
    expect(
      authoritativeTimeline(page(timelineEvents())).map(
        (event) => event.event_id,
      ),
    ).toEqual(timelineEvents().map((event) => event.event_id));
    for (const malformed of [null, {}, { chunk: {} }, { chunk: [null] }])
      expect(() => authoritativeTimeline(malformed)).toThrow();
    expect(
      authoritativeReadReceipts([
        ...seerReceipt(),
        { type: 'm.typing', content: { user_ids: [] } },
        ...receiptEvent({
          [EVENT_ID]: {
            'm.read': { [AUTHOR]: { ts: 2 } },
            'm.read.private': { [READER]: { ts: 3 } },
          },
        }),
      ]),
    ).toEqual([
      { eventId: EVENT_ID, userId: SEER, ts: 1_700, threadId: undefined },
      { eventId: EVENT_ID, userId: AUTHOR, ts: 2, threadId: undefined },
    ]);
    for (const malformed of [null, {}, [null], [{ type: 'm.receipt' }]])
      expect(() => authoritativeReadReceipts(malformed)).toThrow();
  });

  it('requires the exact message and a seer named before any membership activity', async () => {
    const { assertReceiptRoom, authoritativeTimeline } = await loadContract();
    const room = (events, expected = ROOM_EXPECTATION) =>
      assertReceiptRoom(authoritativeTimeline(page(events)), expected);
    expect(room(timelineEvents())).toEqual({
      authorName: AUTHOR_NAME,
      readerName: READER_NAME,
    });
    const failing = [
      // The exact author message.
      timelineEvents({ message: { event_id: OTHER_EVENT } }),
      timelineEvents({ message: { sender: SEER } }),
      timelineEvents({ message: { room_id: '!other:localhost' } }),
      timelineEvents({
        message: { content: { msgtype: 'm.notice', body: BODY } },
      }),
      timelineEvents({
        message: { content: { msgtype: 'm.text', body: `${BODY} ` } },
      }),
      timelineEvents({
        message: {
          content: {
            msgtype: 'm.text',
            body: BODY,
            'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
          },
        },
      }),
      timelineEvents({ extra: [message({ event_id: '$second' })] }),
      timelineEvents().filter((event) => event.type !== 'm.room.message'),
      // The seer's name was set after the invite or after the join.
      timelineEvents({ inviteName: 'trn_rcpt_seer_0a1b2c3d4e5f' }),
      timelineEvents({ joinName: 'trn_rcpt_seer_0a1b2c3d4e5f' }),
      timelineEvents({
        joinName: 'trn_rcpt_seer_0a1b2c3d4e5f',
        extra: [member(SEER, 'join', SEER, SEER_NAME, '$j-seer-again')],
      }),
      timelineEvents({ extra: [member(SEER, 'join', SEER, SEER_NAME, '$j2')] }),
      // A missing, reordered or foreign membership.
      timelineEvents().filter((event) => event.event_id !== '$j-seer'),
      timelineEvents().filter((event) => event.event_id !== '$i-seer'),
      timelineEvents().filter((event) => event.event_id !== '$j-author'),
      timelineEvents({
        extra: [member(STRANGER, 'join', STRANGER, 'Stranger', '$j-stranger')],
      }),
      (() => {
        const events = timelineEvents();
        const invite = events.findIndex(
          (event) => event.event_id === '$i-seer',
        );
        events[invite] = { ...events[invite], sender: AUTHOR };
        return events;
      })(),
      (() => {
        const events = timelineEvents();
        const index = events.findIndex(
          (event) => event.type === 'm.room.message',
        );
        const [moved] = events.splice(index, 1);
        events.splice(6, 0, moved);
        return events;
      })(),
    ];
    for (const events of failing)
      expect(() => room(events), JSON.stringify(events.length)).toThrow();
    expect(() =>
      room(timelineEvents(), { ...ROOM_EXPECTATION, seerName: 'Cara' }),
    ).toThrow();
  });

  it('requires reader, author and seer to be joined now', async () => {
    const { assertJoined } = await loadContract();
    expect(() =>
      assertJoined({ reader: 'join', author: 'join', seer: 'join' }),
    ).not.toThrow();
    for (const role of ['reader', 'author', 'seer'])
      for (const membership of ['invite', 'leave', undefined])
        expect(() =>
          assertJoined({
            reader: 'join',
            author: 'join',
            seer: 'join',
            [role]: membership,
          }),
        ).toThrow();
  });

  it("binds the seer's one unthreaded m.read receipt to exactly the author event", async () => {
    const { assertSeerReceipt, authoritativeReadReceipts } =
      await loadContract();
    const check = (events) =>
      assertSeerReceipt(authoritativeReadReceipts(events), {
        seerId: SEER,
        eventId: EVENT_ID,
      });
    expect(check(seerReceipt()).eventId).toBe(EVENT_ID);
    // Another reader on the same event does not disturb the binding.
    expect(
      check(
        receiptEvent({
          [EVENT_ID]: {
            'm.read': { [SEER]: { ts: 1 }, [AUTHOR]: { ts: 2 } },
          },
        }),
      ).userId,
    ).toBe(SEER);
    for (const events of [
      [],
      seerReceipt(OTHER_EVENT),
      seerReceipt(EVENT_ID, AUTHOR),
      seerReceipt(EVENT_ID, READER),
      seerReceipt(EVENT_ID, SEER, { ts: 1, thread_id: 'main' }),
      seerReceipt(EVENT_ID, SEER, { ts: 1, thread_id: '$root' }),
      seerReceipt(EVENT_ID, SEER, {}),
      seerReceipt(EVENT_ID, SEER, { ts: '1' }),
      receiptEvent({ [EVENT_ID]: { 'm.read.private': { [SEER]: { ts: 1 } } } }),
      receiptEvent({
        [EVENT_ID]: { 'm.read': { [SEER]: { ts: 1 } } },
        [OTHER_EVENT]: { 'm.read': { [SEER]: { ts: 2 } } },
      }),
      [...seerReceipt(), ...seerReceipt(OTHER_EVENT)],
    ])
      expect(() => check(events), JSON.stringify(events)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Simulated installed app: the exact journey against production-shaped DOM  */
/* ------------------------------------------------------------------------ */

const ACCOUNTS = {
  'rcpt-reader': {
    userId: READER,
    username: READER_NAME,
    password: 'reader-pass"word\\token',
    homeserver: 'https://localhost:8448',
  },
  'rcpt-author': {
    userId: AUTHOR,
    username: AUTHOR_NAME,
    password: 'author-pass"word\\token',
    homeserver: 'https://localhost:8448',
  },
  'rcpt-seer': {
    userId: SEER,
    username: 'trn_rcpt_seer_0a1b2c3d4e5f',
    password: 'seer-pass"word\\token',
    homeserver: 'https://localhost:8448',
  },
};
const ROUTE = `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}?account=${encodeURIComponent(READER)}&view=rooms`;
const TEXT_BOX = { left: 420, top: 436, right: 1264, bottom: 460 };
const CLUSTER_BOX = { left: 1220, top: 463, right: 1264, bottom: 507 };
const escapeHtml = (value) =>
  String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
const rect = ({ left, top, right, bottom }) => ({
  x: left,
  y: top,
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

/**
 * A model of the installed app and its Synapse Room. REST fixtures build the
 * authoritative timeline, membership and receipts; the renderer draws the
 * production row shape with the product's `Seen by` cluster, and every
 * observer expression runs against it in jsdom with measured boxes per
 * element. A settled state aborts instead of waiting.
 */
function simulatedReceiptsApp(faults = {}) {
  const controller = new AbortController();
  const state = {
    signedIn: false,
    roomsShown: false,
    roomOpen: false,
    actions: [],
    written: [],
    profiles: {},
    events: [],
    receipts: {},
    reads: 0,
  };
  let lastSignature = '';
  let stale = 0;
  const displayName = (account) =>
    state.profiles[account.userId] ?? account.username;
  const push = (event) => state.events.push({ room_id: ROOM, ...event });
  const clusterNames = () => {
    if (faults.labelAuthorOnly) return [AUTHOR_NAME];
    if (faults.labelReader) return [AUTHOR_NAME, SEER_NAME, READER_NAME];
    if (faults.labelLookalike) return [AUTHOR_NAME, `${SEER_NAME}x`];
    if (faults.labelTwice) return [SEER_NAME, SEER_NAME];
    if (faults.labelStranger) return [SEER_NAME, 'Stranger'];
    if (faults.labelLate && state.reads < 12) return [AUTHOR_NAME];
    return [AUTHOR_NAME, SEER_NAME];
  };
  const clusterHtml = (names, style = '') => {
    const avatars = faults.avatarMismatch ? [...names, 'extra'] : names;
    const label = faults.labelPlain
      ? names.join(', ')
      : `Seen by ${names.join(', ')}`;
    const tag = faults.clusterSpan ? 'span' : 'button';
    return `<${tag} type="button" class="msg__receipts msg__target" data-testid="read-receipts" aria-label="${escapeHtml(label)}"${style}>${avatars
      .map(
        (name) =>
          `<trn-avatar class="msg__receipt" aria-hidden="true"><span>${escapeHtml(name[0].toUpperCase())}</span></trn-avatar>`,
      )
      .join('')}</${tag}>`;
  };
  const receiptsRendered = () =>
    state.reads >= (faults.receiptsIn ?? 3) && !faults.clusterMissing;
  const render = () => {
    const parts = ['<nav>'];
    if (state.signedIn)
      parts.push('<button data-testid="rail-rooms">Rooms</button>');
    parts.push('</nav>');
    if (state.roomsShown)
      parts.push(
        `<aside><div class="channel">${escapeHtml(ROOM_NAME)}</div></aside>`,
      );
    if (state.roomOpen) {
      const names = clusterNames();
      const cluster = receiptsRendered()
        ? clusterHtml(
            names,
            faults.clusterHidden ? ' style="visibility:hidden"' : '',
          )
        : '';
      parts.push(
        '<div class="scroll"><div class="msg msg--event" data-mid="$create"><span class="msg__event-text">created the room</span></div>',
      );
      if (faults.earlierCluster || faults.clusterOnOtherRow)
        parts.push(
          `<div class="msg" data-mid="$Earlier"><div class="msg__body"><div class="msg__content"><p class="msg__text">earlier</p></div>${clusterHtml(names)}</div></div>`,
        );
      const id = faults.pendingEcho ? '~!Receipt:txn1' : EVENT_ID;
      const text = faults.textMissing
        ? `<div class="msg__caption">${escapeHtml(BODY)}</div>`
        : `<p class="msg__text">${escapeHtml(BODY)}</p>`;
      parts.push(
        `<div class="msg" data-mid="${escapeHtml(id)}"><div class="msg__body"><div class="msg__content"><div class="msg__head"><span class="msg__author">${escapeHtml(AUTHOR_NAME)}</span></div>${text}</div>${faults.clusterOnOtherRow ? '' : cluster}</div></div>`,
      );
      parts.push('</div>');
      parts.push(
        `<trn-message-composer><textarea data-testid="composer-input" placeholder="${escapeHtml(`Message #${ROOM_NAME}`)}"></textarea></trn-message-composer>`,
      );
    }
    return parts.join('');
  };
  const clusterBox = () => {
    const shift = faults.overlap;
    const box = { ...CLUSTER_BOX };
    if (shift === 'from-below') box.top = TEXT_BOX.bottom - 4;
    if (shift === 'from-above') {
      box.top = TEXT_BOX.top - 40;
      box.bottom = TEXT_BOX.top + 4;
    }
    if (shift === 'covering') {
      box.top = TEXT_BOX.top + 2;
      box.bottom = TEXT_BOX.bottom - 2;
    }
    if (shift === 'from-left') {
      box.top = TEXT_BOX.top;
      box.bottom = TEXT_BOX.bottom;
      box.left = TEXT_BOX.left - 40;
      box.right = TEXT_BOX.left + 4;
    }
    if (shift === 'zero') box.bottom = box.top;
    if (shift === 'nan') box.left = Number.NaN;
    return box;
  };
  const dom = () => {
    const jsdom = new JSDOM(`<main>${render()}</main>`, {
      url: state.roomOpen ? ROUTE : 'https://localhost/rooms?account=x',
    });
    const { window } = jsdom;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-testid="read-receipts"]'))
        return rect(clusterBox());
      if (this.matches('.msg__text'))
        return rect(
          faults.textZero ? { ...TEXT_BOX, bottom: TEXT_BOX.top } : TEXT_BOX,
        );
      return rect({ left: 0, top: 0, right: 120, bottom: 20 });
    };
    window.matchMedia = () => ({ matches: false });
    window.Capacitor = { getPlatform: () => 'android' };
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => ({
      ...computed(element),
      visibility:
        element.closest('[style*="visibility:hidden"]') !== null
          ? 'hidden'
          : 'visible',
    });
    return window;
  };
  const settle = () => {
    state.reads++;
    const signature = JSON.stringify([
      render(),
      state.events,
      state.receipts,
      state.actions.length,
      state.written.length,
    ]);
    if (signature === lastSignature && ++stale > 6)
      controller.abort(new Error('Simulated app settled'));
    if (signature !== lastSignature) stale = 0;
    lastSignature = signature;
  };
  const matches = (selector, filter = {}) =>
    [...dom().document.querySelectorAll(selector)].filter(
      (element) =>
        (filter.text === undefined ||
          (element.textContent ?? '').includes(filter.text)) &&
        (filter.exactText === undefined ||
          element.textContent?.trim() === filter.exactText),
    );
  const elementsOf = (selector, filter) =>
    matches(selector, filter).map((element) => ({
      text: element.textContent?.trim() ?? '',
      visible: true,
      focused: false,
      disabled: element.matches(':disabled'),
      value: 'value' in element ? element.value : null,
      unobstructedCenter: true,
      rect: { x: 0, y: 0, width: 120, height: 20, bottom: 20, right: 120 },
    }));
  const actionable = (selector, filter) => {
    const found = matches(selector, filter);
    if (found.length !== 1 || found[0].matches(':disabled'))
      throw new Error(`Simulated target is not actionable: ${selector}`);
    return found[0];
  };
  const client = {
    workspaceRoot: root,
    applicationId: 'eu.qwky.trinity',
    signal: controller.signal,
    webview: {
      diagnostics: {
        send: async (_method, { expression }) => {
          settle();
          const window = dom();
          return {
            result: {
              value: JSON.parse(
                JSON.stringify(
                  runInNewContext(expression, { document: window.document }),
                ),
              ),
            },
          };
        },
      },
    },
    async reset(profile) {
      state.actions.push('reset');
      state.profile = profile;
    },
    async login(account) {
      state.actions.push(
        `login:${account === ACCOUNTS['rcpt-reader'] ? 'reader' : 'other'}`,
      );
      state.signedIn = true;
    },
    async hideKeyboard() {
      state.actions.push('hide-keyboard');
    },
    async waitElements(selector, accepts, _description, filter, timeoutMs) {
      assert(Number.isFinite(timeoutMs), 'Simulated waits are bounded');
      for (;;) {
        controller.signal.throwIfAborted();
        settle();
        const values = elementsOf(selector, filter);
        if (accepts(values)) return values;
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
    async tapCurrent(selector, filter = {}) {
      state.actions.push(
        `tap:${selector}${filter.text ? `|${filter.text}` : ''}`,
      );
      const element = actionable(selector, filter);
      if (element.getAttribute('data-testid') === 'rail-rooms')
        state.roomsShown = true;
      else if (element.classList.contains('channel')) state.roomOpen = true;
      else throw new Error(`Unmodelled simulated tap ${selector}`);
    },
    async record(name, value) {
      state.written.push({ name, value });
    },
    async capture(name) {
      state.actions.push(`capture:${name}`);
    },
  };
  const fixtures = {
    async account(role) {
      state.actions.push(`rest-account:${role}`);
      assert(ACCOUNTS[role], `Unknown simulated role ${role}`);
      return ACCOUNTS[role];
    },
    async setDisplayName(account, name) {
      state.actions.push('rest-displayname');
      assert.equal(account, ACCOUNTS['rcpt-seer']);
      if (faults.nameAfterJoin) state.lateName = name;
      else state.profiles[account.userId] = name;
    },
    async createRoom(owner, content) {
      state.actions.push('rest-create-room');
      assert.equal(owner, ACCOUNTS['rcpt-reader']);
      assert.deepEqual(Object.keys(content).sort(), ['invite', 'name']);
      state.roomContent = content;
      push({
        type: 'm.room.create',
        event_id: '$create',
        sender: READER,
        state_key: '',
        content: {},
      });
      push(member(READER, 'join', READER, displayName(owner), '$j-reader'));
      for (const userId of content.invite) {
        const invitee = Object.values(ACCOUNTS).find(
          (a) => a.userId === userId,
        );
        push(
          member(
            userId,
            'invite',
            READER,
            displayName(invitee),
            `$i-${userId}`,
          ),
        );
      }
      return { id: ROOM, name: content.name };
    },
    async join(account, roomId) {
      state.actions.push(
        `rest-join:${account === ACCOUNTS['rcpt-author'] ? 'author' : 'seer'}`,
      );
      assert.equal(roomId, ROOM);
      push(
        member(
          account.userId,
          'join',
          account.userId,
          displayName(account),
          `$j-${account.userId}`,
        ),
      );
      if (account === ACCOUNTS['rcpt-seer'] && state.lateName) {
        state.profiles[account.userId] = state.lateName;
        push(
          member(
            account.userId,
            'join',
            account.userId,
            state.lateName,
            '$j-seer-rename',
          ),
        );
      }
      if (account === ACCOUNTS['rcpt-seer'] && faults.stranger)
        push(member(STRANGER, 'join', STRANGER, 'Stranger', '$j-stranger'));
    },
    async sendMessage(sender, roomId, body, transactionId) {
      state.actions.push(
        `rest-send:${transactionId === `rcpt-${RUN}` ? 'exact' : 'other'}`,
      );
      assert.equal(sender, ACCOUNTS['rcpt-author']);
      assert.equal(roomId, ROOM);
      state.sent = { body, transactionId };
      push(message({}, { body: faults.bodyDrift ? `${body}!` : body }));
      return EVENT_ID;
    },
    async sendReadReceipt(reader, roomId, eventId) {
      state.actions.push('rest-receipt');
      assert.equal(roomId, ROOM);
      const target = faults.receiptWrongEvent ? OTHER_EVENT : eventId;
      const user = faults.receiptOtherUser ? AUTHOR : reader.userId;
      const receipt = faults.receiptThreaded
        ? { ts: 1_700, thread_id: 'main' }
        : { ts: 1_700 };
      state.receipts = { [target]: { 'm.read': { [user]: receipt } } };
    },
    async roomMessages(observer, roomId) {
      assert.equal(observer, ACCOUNTS['rcpt-reader']);
      assert.equal(roomId, ROOM);
      settle();
      return page(state.events);
    },
    async roomMembership(observer, roomId, target) {
      assert.equal(observer, ACCOUNTS['rcpt-reader']);
      assert.equal(roomId, ROOM);
      settle();
      if (faults.seerLeft && target === ACCOUNTS['rcpt-seer']) return 'leave';
      return 'join';
    },
    async roomReceipts(observer, roomId) {
      assert.equal(observer, ACCOUNTS['rcpt-reader']);
      assert.equal(roomId, ROOM);
      settle();
      if (faults.relationMovedAfterRender && state.roomOpen)
        return receiptEvent({
          [OTHER_EVENT]: { 'm.read': { [SEER]: { ts: 1_800 } } },
        });
      return receiptEvent(state.receipts);
    },
  };
  return { client, fixtures, state, controller };
}

async function simulatedStage(faults = {}) {
  const { MESSAGE_RECEIPTS_STAGES } = await loadContract();
  const app = simulatedReceiptsApp(faults);
  const context = {
    entry: MESSAGE_RECEIPTS_STAGES[0],
    records: [],
    identities: new Set(),
    receipts: 0,
    client: app.client,
    fixtures: app.fixtures,
    secrets: {},
    safety: { unsafeSecrets: true, cleanupFailed: false, scrubFailed: false },
    native: false,
    ledger: { run: RUN, accounts: {}, texts: [], eventIds: [] },
  };
  return { ...app, context };
}

const STAGE_ACTIONS = [
  'rest-account:rcpt-reader',
  'rest-account:rcpt-author',
  'rest-account:rcpt-seer',
  'rest-displayname',
  'rest-create-room',
  'rest-join:author',
  'rest-join:seer',
  'rest-send:exact',
  'rest-receipt',
  'reset',
  'login:reader',
  'hide-keyboard',
  'tap:[data-testid="rail-rooms"]',
  `tap:.channel|${ROOM_NAME}`,
];

/** Written evidence carries digests, counts and booleans, never an identifier. */
function assertIdFreeEvidence(state, secrets) {
  const written = JSON.stringify(state.written);
  for (const value of secrets) expect(written).not.toContain(value);
  // Selectors reach the job log: none carries an identifier.
  for (const action of state.actions)
    expect(action.split('|')[0]).not.toMatch(
      /[$!~@][A-Za-z0-9_]|data-mid[*~|^]?=|Cara|trn[-_]/u,
    );
}

describe('Android message-receipts native journey against a simulated installed app', () => {
  it('arranges, proves the relation, then drives the exact native sequence and records all four identities', async () => {
    const { runSeenBy } = await loadJourneys();
    const { DESKTOP_ACCOUNT_PROFILE } = await loadClient();
    const { context, state } = await simulatedStage();
    await runSeenBy(context);
    expect(context.records).toEqual(ALL_IDENTITIES);
    expect(state.actions).toEqual(STAGE_ACTIONS);
    expect(state.profile).toBe(DESKTOP_ACCOUNT_PROFILE);
    expect(state.roomContent).toEqual({
      name: ROOM_NAME,
      invite: [AUTHOR, SEER],
    });
    expect(state.sent).toEqual({ body: BODY, transactionId: `rcpt-${RUN}` });
    expect(state.profiles).toEqual({ [SEER]: SEER_NAME });
    expect(context.ledger.eventIds).toEqual([EVENT_ID]);
    expect(Object.keys(context.ledger.accounts)).toEqual([
      'reader',
      'author',
      'seer',
    ]);
    expect(
      state.written
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('receipt-')),
    ).toEqual([
      'receipt-01-message-event',
      'receipt-02-seer-membership',
      'receipt-03-receipt-relation',
      'receipt-04-relation-retained',
    ]);
    // Every Matrix proof is written before the first native step.
    const names = state.written.map((entry) => entry.name);
    expect(names.indexOf('receipt-03-receipt-relation')).toBeLessThan(
      names.indexOf('profile-applied'),
    );
    const clear = state.written.find(
      (entry) => entry.name === 'message-receipts.seen-by.text-clear',
    );
    expect(clear.value.observation).toMatchObject({
      intersects: false,
      separatedBy: ['below'],
    });
    const named = state.written.find(
      (entry) => entry.name === 'message-receipts.seen-by.seer-named',
    );
    expect(named.value.observation).toEqual({
      seerListed: true,
      names: 2,
      avatars: 2,
      readerListed: false,
    });
    assertIdFreeEvidence(state, [
      ROOM,
      EVENT_ID,
      READER,
      AUTHOR,
      SEER,
      SEER_NAME,
      READER_NAME,
      AUTHOR_NAME,
      ACCOUNTS['rcpt-seer'].password,
      RUN,
    ]);
    const written = JSON.stringify(state.written);
    expect(written).toContain(sha256(EVENT_ID));
    expect(written).toContain(sha256(ROOM));
  });

  it('waits, bounded, for a label that names the seer after the cluster appears', async () => {
    const { runSeenBy } = await loadJourneys();
    const { context } = await simulatedStage({ labelLate: true });
    await runSeenBy(context);
    expect(context.records).toEqual(ALL_IDENTITIES);
  });

  const PRE_LAUNCH = [
    'nameAfterJoin',
    'receiptWrongEvent',
    'receiptOtherUser',
    'receiptThreaded',
    'seerLeft',
    'stranger',
    'bodyDrift',
  ];
  for (const fault of PRE_LAUNCH)
    it(`fails before any native step when ${fault}`, async () => {
      const { runSeenBy } = await loadJourneys();
      const { context, state } = await simulatedStage({ [fault]: true });
      await expect(runSeenBy(context)).rejects.toThrow();
      expect(context.records).toEqual([]);
      expect(state.actions).not.toContain('reset');
    });

  const RENDERED = [
    ['clusterMissing', 'cluster-visible'],
    ['clusterHidden', 'cluster-visible'],
    ['clusterOnOtherRow', 'cluster-visible'],
    ['earlierCluster', 'cluster-visible'],
    ['pendingEcho', 'cluster-visible'],
    ['clusterSpan', 'cluster-visible'],
    ['labelAuthorOnly', 'seer-named'],
    ['labelReader', 'seer-named'],
    ['labelLookalike', 'seer-named'],
    ['labelTwice', 'seer-named'],
    ['labelStranger', 'seer-named'],
    ['labelPlain', 'seer-named'],
    ['avatarMismatch', 'seer-named'],
    [{ overlap: 'from-below' }, 'text-clear'],
    [{ overlap: 'from-above' }, 'text-clear'],
    [{ overlap: 'covering' }, 'text-clear'],
    [{ overlap: 'from-left' }, 'text-clear'],
    // A zero or non-finite cluster box is not a visible cluster at all.
    [{ overlap: 'zero' }, 'cluster-visible'],
    [{ overlap: 'nan' }, 'cluster-visible'],
    // The row is identified by its message text.
    ['textMissing', 'cluster-visible'],
    ['textZero', 'text-clear'],
  ];
  for (const [fault, firstMissing] of RENDERED) {
    const name = typeof fault === 'string' ? fault : `overlap ${fault.overlap}`;
    it(`fails before ${firstMissing} when ${name}`, async () => {
      const { runSeenBy } = await loadJourneys();
      const faults = typeof fault === 'string' ? { [fault]: true } : fault;
      const { context } = await simulatedStage(faults);
      await expect(runSeenBy(context)).rejects.toThrow();
      const index = ALL_IDENTITIES.indexOf(
        `message-receipts.seen-by.${firstMissing}`,
      );
      expect(index).toBeGreaterThan(0);
      expect(context.records).toEqual(ALL_IDENTITIES.slice(0, index));
    });
  }

  it('fails after the rendered records when the relation no longer holds', async () => {
    const { runSeenBy } = await loadJourneys();
    const { context, state } = await simulatedStage({
      relationMovedAfterRender: true,
    });
    await expect(runSeenBy(context)).rejects.toThrow();
    expect(context.records).toEqual(ALL_IDENTITIES);
    expect(
      state.written.some((entry) => entry.name.endsWith('relation-retained')),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Read-only renderer observation (jsdom)                                    */
/* ------------------------------------------------------------------------ */

function evaluateIn(body, expression, boxes = {}) {
  const dom = new JSDOM(`<main>${body}</main>`, { url: ROUTE });
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = /display:\s*none/u.test(this.getAttribute('style') ?? '');
    if (hidden) return rect({ left: 0, top: 0, right: 0, bottom: 0 });
    if (this.matches('[data-testid="read-receipts"]'))
      return rect(boxes.cluster ?? CLUSTER_BOX);
    if (this.matches('.msg__text')) return rect(boxes.text ?? TEXT_BOX);
    return rect({ left: 0, top: 0, right: 120, bottom: 20 });
  };
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => ({
    ...computed(element),
    visibility:
      element.closest('[style*="visibility:hidden"]') !== null
        ? 'hidden'
        : 'visible',
  });
  return JSON.parse(
    JSON.stringify(runInNewContext(expression, { document: window.document })),
  );
}

const avatar = (initial) =>
  `<trn-avatar class="msg__receipt" aria-hidden="true"><hlm-avatar><span>${initial}</span></hlm-avatar></trn-avatar>`;
const clusterMarkup = (
  label = `Seen by ${AUTHOR_NAME}, ${SEER_NAME}`,
  avatars = 2,
  tag = 'button',
) =>
  `<${tag} type="button" class="msg__receipts msg__target" data-testid="read-receipts" aria-label="${label}">${Array.from({ length: avatars }, () => avatar('C')).join('')}</${tag}>`;
const messageRow = (id = EVENT_ID, cluster = clusterMarkup(), text = BODY) =>
  `<div class="msg" data-mid="${id}"><div class="msg__body"><div class="msg__content"><div class="msg__head"><span class="msg__author">${AUTHOR_NAME}</span></div><p class="msg__text">${text}</p></div>${cluster}</div></div>`;
const scroll = (...rows) =>
  `<div class="scroll"><div class="msg msg--event" data-mid="$create">created the room</div>${rows.join('')}</div>`;
const NAMES = {
  seerName: SEER_NAME,
  memberNames: [AUTHOR_NAME, SEER_NAME],
  readerName: READER_NAME,
};

describe('Android message-receipts read-only renderer observation (jsdom)', () => {
  it('observes the exact row, its cluster, label and measured boxes', async () => {
    const contract = await loadContract();
    const { receiptsExpression } = await loadObserver();
    const view = contract.parseReceiptsView(
      evaluateIn(scroll(messageRow()), receiptsExpression()),
    );
    expect(view.clusters).toBe(1);
    const cluster = contract.assertClusterVisible(view, BODY, EVENT_ID);
    expect(cluster).toMatchObject({
      rowId: EVENT_ID,
      firstInRow: true,
      firstInDocument: true,
      tag: 'BUTTON',
      visible: true,
      avatars: 2,
    });
    expect(contract.assertSeerNamed(cluster, NAMES)).toEqual([
      AUTHOR_NAME,
      SEER_NAME,
    ]);
    expect(contract.assertTextClear(cluster, BODY, EVENT_ID)).toEqual({
      intersects: false,
      separatedBy: ['below'],
    });
    // One name for the seer alone is equally exact.
    const alone = contract.parseReceiptsView(
      evaluateIn(
        scroll(messageRow(EVENT_ID, clusterMarkup(`Seen by ${SEER_NAME}`, 1))),
        receiptsExpression(),
      ),
    );
    expect(() =>
      contract.assertSeerNamed(
        contract.assertClusterVisible(alone, BODY, EVENT_ID),
        NAMES,
      ),
    ).not.toThrow();
  });

  it('rejects a cluster elsewhere, a hidden or missing cluster and another row', async () => {
    const contract = await loadContract();
    const { receiptsExpression } = await loadObserver();
    const observe = (body) =>
      contract.parseReceiptsView(evaluateIn(body, receiptsExpression()));
    for (const body of [
      scroll(messageRow(EVENT_ID, '')),
      scroll(
        messageRow(EVENT_ID, '').replace(
          '</div></div></div>',
          `</div></div></div>`,
        ),
        messageRow('$Other', clusterMarkup(), 'other text'),
      ),
      scroll(messageRow('$Earlier', clusterMarkup(), 'earlier'), messageRow()),
      scroll(messageRow('~!pending')),
      scroll(messageRow('$Other')),
      scroll(messageRow(), messageRow('$Two')),
      scroll(
        messageRow(
          EVENT_ID,
          clusterMarkup().replace(
            'data-testid="read-receipts"',
            'data-testid="read-receipts" style="visibility:hidden"',
          ),
        ),
      ),
      scroll(messageRow(EVENT_ID, clusterMarkup(undefined, 2, 'span'))),
      scroll(messageRow(EVENT_ID, clusterMarkup(undefined, 0))),
      // Outside the timeline scroller the predecessor's locator never looks.
      `${scroll(messageRow(EVENT_ID, ''))}${clusterMarkup()}`,
    ])
      expect(() =>
        contract.assertClusterVisible(observe(body), BODY, EVENT_ID),
      ).toThrow();
    // A second cluster in the same row before the receipt one is not its first.
    const doubled = observe(
      scroll(messageRow(EVENT_ID, `${clusterMarkup()}${clusterMarkup()}`)),
    );
    expect(doubled.first.firstInRow).toBe(true);
    // A document-first cluster outside the scroller defeats the geometry target.
    const outside = observe(`${clusterMarkup()}${scroll(messageRow())}`);
    expect(outside.first.firstInDocument).toBe(false);
    expect(() =>
      contract.assertClusterVisible(outside, BODY, EVENT_ID),
    ).toThrow();
  });

  it('rejects every label that does not name exactly the seer among the Room members', async () => {
    const contract = await loadContract();
    const { receiptsExpression } = await loadObserver();
    const named = (label, avatars) =>
      contract.assertSeerNamed(
        contract.assertClusterVisible(
          contract.parseReceiptsView(
            evaluateIn(
              scroll(messageRow(EVENT_ID, clusterMarkup(label, avatars))),
              receiptsExpression(),
            ),
          ),
          BODY,
          EVENT_ID,
        ),
        NAMES,
      );
    expect(named(`Seen by ${SEER_NAME}, ${AUTHOR_NAME}`, 2)).toHaveLength(2);
    for (const [label, avatars] of [
      [`Seen by ${AUTHOR_NAME}`, 1],
      [`Seen by ${AUTHOR_NAME}, ${SEER_NAME}, ${READER_NAME}`, 3],
      [`Seen by ${AUTHOR_NAME}, ${SEER_NAME}x`, 2],
      [`Seen by ${AUTHOR_NAME}, x${SEER_NAME}`, 2],
      [`Seen by ${SEER_NAME}, ${SEER_NAME}`, 2],
      [`Seen by ${SEER_NAME}, Stranger`, 2],
      [`${AUTHOR_NAME}, ${SEER_NAME}`, 2],
      [`Seen by ${AUTHOR_NAME}, ${SEER_NAME}`, 3],
      [`Seen by ${AUTHOR_NAME}, ${SEER_NAME}`, 1],
      [`Seen by ${AUTHOR_NAME},${SEER_NAME}`, 2],
      [`Seen by ${AUTHOR_NAME}, , ${SEER_NAME}`, 2],
    ])
      expect(() => named(label, avatars), label).toThrow();
    const cluster = (label, avatars) =>
      contract.assertClusterVisible(
        contract.parseReceiptsView(
          evaluateIn(
            scroll(messageRow(EVENT_ID, clusterMarkup(label, avatars))),
            receiptsExpression(),
          ),
        ),
        BODY,
        EVENT_ID,
      );
    // An author whose name contains the seer's is not the seer.
    const containing = `${SEER_NAME} fan`;
    expect(() =>
      contract.assertSeerNamed(cluster(`Seen by ${containing}`, 1), {
        ...NAMES,
        memberNames: [containing, SEER_NAME],
      }),
    ).toThrow();
    // The reader is rejected even if a caller listed it among the members.
    expect(() =>
      contract.assertSeerNamed(
        cluster(`Seen by ${SEER_NAME}, ${READER_NAME}`, 2),
        { ...NAMES, memberNames: [...NAMES.memberNames, READER_NAME] },
      ),
    ).toThrow();
    const unlabelled = contract.parseReceiptsView(
      evaluateIn(
        scroll(
          messageRow(
            EVENT_ID,
            clusterMarkup().replace(/ aria-label="[^"]*"/u, ''),
          ),
        ),
        receiptsExpression(),
      ),
    );
    expect(() =>
      contract.assertSeerNamed(
        contract.assertClusterVisible(unlabelled, BODY, EVENT_ID),
        NAMES,
      ),
    ).toThrow();
    expect(contract.seenByNames(`Seen by ${SEER_NAME}`)).toEqual([SEER_NAME]);
    expect(contract.seenByNames('Seen by ')).toBeNull();
    expect(contract.seenByNames(null)).toBeNull();
  });

  it('recomputes the four-edge intersection from measured boxes and rejects each overlap', async () => {
    const contract = await loadContract();
    const { receiptsExpression } = await loadObserver();
    const clear = (cluster, text = TEXT_BOX, body = scroll(messageRow())) =>
      contract.assertTextClear(
        contract.parseReceiptsView(
          evaluateIn(body, receiptsExpression(), { cluster, text }),
        ).first,
        BODY,
        EVENT_ID,
      );
    expect(clear(CLUSTER_BOX).separatedBy).toEqual(['below']);
    expect(
      clear({ left: 1220, top: 400, right: 1264, bottom: 436 }).separatedBy,
    ).toEqual(['above']);
    expect(
      clear({ left: 1270, top: 440, right: 1300, bottom: 456 }).separatedBy,
    ).toEqual(['right']);
    expect(
      clear({ left: 380, top: 440, right: 420, bottom: 456 }).separatedBy,
    ).toEqual(['left']);
    for (const cluster of [
      { left: 1220, top: 456, right: 1264, bottom: 500 },
      { left: 1220, top: 400, right: 1264, bottom: 437 },
      { left: 1263, top: 440, right: 1300, bottom: 456 },
      { left: 380, top: 440, right: 421, bottom: 456 },
      { left: 600, top: 440, right: 700, bottom: 450 },
      { left: 300, top: 400, right: 1400, bottom: 500 },
      { left: 1220, top: 463, right: 1220, bottom: 507 },
      { left: 1220, top: 463, right: 1264, bottom: 463 },
      { left: Number.NaN, top: 463, right: 1264, bottom: 507 },
    ])
      expect(() => clear(cluster), JSON.stringify(cluster)).toThrow();
    // A zero-size text box, or measured text of another message, is not proof.
    expect(() =>
      clear(CLUSTER_BOX, { left: 420, top: 436, right: 420, bottom: 460 }),
    ).toThrow();
    expect(() =>
      clear(
        CLUSTER_BOX,
        TEXT_BOX,
        scroll(messageRow(EVENT_ID, clusterMarkup(), 'other')),
      ),
    ).toThrow();
    expect(contract.separation(CLUSTER_BOX, TEXT_BOX)).toEqual({
      intersects: false,
      separatedBy: ['below'],
    });
    expect(
      contract.separation(
        { ...CLUSTER_BOX, top: TEXT_BOX.bottom - 1 },
        TEXT_BOX,
      ).intersects,
    ).toBe(true);
  });

  it('observes the exact composer and parses only complete observations', async () => {
    const contract = await loadContract();
    const { composerExpression, receiptsExpression } = await loadObserver();
    const composer = contract.parseComposer(
      evaluateIn(
        `<textarea data-testid="composer-input" placeholder="Message #${ROOM_NAME}"></textarea>`,
        composerExpression(),
      ),
    );
    const identity = { name: ROOM_NAME, roomId: ROOM, userId: READER };
    expect(() => contract.assertRoomReady(composer, identity)).not.toThrow();
    for (const other of [
      { ...identity, name: 'Receipts E2E other' },
      { ...identity, roomId: '!other:localhost' },
      { ...identity, userId: AUTHOR },
    ])
      expect(() => contract.assertRoomReady(composer, other)).toThrow();
    const view = evaluateIn(scroll(messageRow()), receiptsExpression());
    for (const malformed of [
      null,
      { ...view, rows: {} },
      { ...view, clusters: -1 },
      { ...view, first: { ...view.first, avatars: 'two' } },
      { ...view, first: { ...view.first, box: { left: 1 } } },
      { ...view, first: { ...view.first, text: { content: BODY } } },
      {
        ...view,
        rows: [
          { id: '$a', event: false, visible: true, texts: [1], clusters: 0 },
        ],
      },
    ])
      expect(() => contract.parseReceiptsView(malformed)).toThrow();
    for (const malformed of [
      null,
      { ...composer, count: -1 },
      { ...composer, href: undefined },
    ])
      expect(() => contract.parseComposer(malformed)).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Diagnostics safety                                                        */
/* ------------------------------------------------------------------------ */

const ARTIFACT_IDS = {
  run: RUN,
  accounts: {
    reader: {
      userId: READER,
      username: READER_NAME,
      password: 'reader-pass"word\\token',
    },
    author: {
      userId: AUTHOR,
      username: AUTHOR_NAME,
      password: 'author-pass"word\\token',
    },
    seer: {
      userId: SEER,
      username: 'trn_rcpt_seer_0a1b2c3d4e5f',
      password: 'seer-pass"word\\token',
    },
  },
  room: { id: ROOM, name: ROOM_NAME },
  texts: [SEER_NAME, BODY, `rcpt-${RUN}`],
  eventIds: [EVENT_ID],
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
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'assert'
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

describe('Android message-receipts diagnostics safety', () => {
  it('gives every record() a proof that asserts, and fails an emptied proof', () => {
    const journey = read(JOURNEYS);
    const current = recordProofViolations(journey);
    expect(current.records).toBe(4);
    expect(current.violations).toEqual([]);
    for (const [from, to] of [
      ['() => assertClusterVisible(shown, body, eventId)', '() => {}'],
      ['() => assertTextClear(cluster, body, eventId)', '() => void cluster'],
      ['() => assertRoomReady(composer, identity)', 'undefined'],
    ]) {
      expect(journey).toContain(from);
      expect(
        recordProofViolations(journey.replace(from, to)).violations,
      ).toHaveLength(1);
    }
  });

  it('cannot emit a duplicate, out-of-order or unproved identity, or a parity-named receipt', async () => {
    const { MESSAGE_RECEIPTS_STAGES } = await loadContract();
    const { record, receipt } = await loadJourneys();
    const written = [];
    const context = {
      entry: MESSAGE_RECEIPTS_STAGES[0],
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
    expect(written[0]).toMatchObject({
      name: 'message-receipts.seen-by.room-ready',
      value: {
        assertion: 'message-receipts.seen-by.room-ready',
        observation: { ready: true },
      },
    });
    await expect(
      record(
        context,
        'cluster-visible',
        () => {
          throw new Error('proof failed');
        },
        {},
      ),
    ).rejects.toThrow('proof failed');
    expect(context.records).toHaveLength(1);
    await expect(record(context, 'room-ready', () => {}, {})).rejects.toThrow();
    await expect(record(context, 'text-clear', () => {}, {})).rejects.toThrow();
    await expect(record(context, 'not-owned', () => {}, {})).rejects.toThrow();
    expect(written).toHaveLength(1);
    await receipt(context, 'receipt-relation', { ok: true });
    expect(written.at(-1).name).toBe('receipt-01-receipt-relation');
    for (const name of ['message-receipts.seen-by.room-ready', 'Start', ''])
      await expect(receipt(context, name, {})).rejects.toThrow();
  });

  it('rethrows stage failures to the job log without identifiers or assertion values', async () => {
    const { messageReceiptsSecrets } = await loadArtifacts();
    const { redactStageFailure, redactCleanupFailure } = await loadJourneys();
    const { AssertionError } = await import('node:assert');
    const secrets = messageReceiptsSecrets(STAGE.id, ARTIFACT_IDS);
    const segment = Buffer.from(ROOM).toString('base64url');
    const failure = new AssertionError({
      actual: `Seen by ${AUTHOR_NAME}`,
      expected: `Seen by ${SEER_NAME}`,
      operator: 'strictEqual',
      message: 'The label names the exact seer exactly once',
    });
    const leaked = new Error(
      `GET /rooms/${encodeURIComponent(ROOM)}/messages for ${READER} at /rooms/${segment} on ${EVENT_ID} by ${SEER} body ${BODY}`,
    );
    const error = redactStageFailure(
      STAGE.id,
      [new AggregateError([failure, leaked], 'Native action failed')],
      secrets,
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toContain('Android message-receipts seen-by failed');
    expect(error.message).toContain(
      'The label names the exact seer exactly once',
    );
    expect(error.message).toContain('[REDACTED]');
    for (const value of [
      ROOM,
      encodeURIComponent(ROOM),
      segment,
      EVENT_ID,
      READER,
      SEER,
      AUTHOR_NAME,
      SEER_NAME,
      RUN,
    ])
      expect(error.message).not.toContain(value);
    const cleanup = redactCleanupFailure(
      'fixtures',
      Object.assign(new Error(`leave ${ROOM}`), { status: 403 }),
    );
    expect(cleanup.message).toBe(
      'Message-receipts cleanup failed: fixtures (Error HTTP 403)',
    );
    const journey = read(JOURNEYS);
    expect(journey).toContain(
      'throw redactStageFailure(entry.id, failures, secrets);',
    );
    expect(journey).not.toMatch(/throw new AggregateError\(failures/u);
    // Removing the redaction leaks the identifiers again.
    expect(redactStageFailure(STAGE.id, [leaked], {}).message).toContain(
      EVENT_ID,
    );
  });

  it('marks a failed guarded cleanup, blocks publication and rethrows an id-free error', async () => {
    const { guardMessageReceiptsCleanup } = await loadJourneys();
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
    const guarded = guardMessageReceiptsCleanup(
      (label, action) => registered.push({ label, action }),
      state,
    );
    guarded('Room cleanup', async () => {
      throw new Error(`forget ${ROOM}`);
    });
    await expect(registered[0].action()).rejects.toThrow(
      'Message-receipts cleanup failed: Room cleanup (Error)',
    );
    expect(state.safety.cleanupFailed).toBe(true);
    expect(state.report.status).toBe('failed');
    expect(state.report.stages[0]).toMatchObject({
      status: 'failed',
      failureCount: 1,
    });
    expect(state.report.stages[0].error).toContain(ROOM);
    expect(state.saves).toBe(1);
    // A cleanup before any stage is kept in the report too.
    const early = { ...state, report: { status: 'running', stages: [] } };
    const later = [];
    guardMessageReceiptsCleanup((label, action) => later.push(action), early)(
      'Device',
      async () => {
        throw new Error('device');
      },
    );
    await expect(later[0]()).rejects.toThrow();
    expect(early.report.cleanupErrors).toHaveLength(1);
  });

  it('registers every identifier form of all three Accounts, never the bare server name', async () => {
    const { messageReceiptsSecrets } = await loadArtifacts();
    const secrets = messageReceiptsSecrets(STAGE.id, ARTIFACT_IDS);
    expect(
      Object.keys(secrets).every((key) =>
        key.startsWith('SECRET_RECEIPTS_SEEN_BY_'),
      ),
    ).toBe(true);
    const values = new Set(Object.values(secrets));
    for (const value of [
      RUN,
      ...Object.values(ARTIFACT_IDS.accounts).flatMap((account) => [
        account.userId,
        encodeURIComponent(account.userId),
        account.username,
        account.password,
      ]),
      ROOM,
      ROOM.slice(1),
      encodeURIComponent(ROOM),
      Buffer.from(ROOM).toString('base64url'),
      ROOM_NAME,
      SEER_NAME,
      BODY,
      encodeURIComponent(BODY),
      `rcpt-${RUN}`,
      EVENT_ID,
      encodeURIComponent(EVENT_ID),
    ])
      expect(values.has(value), value).toBe(true);
    expect(values.has('localhost')).toBe(false);
    expect(
      Object.keys(messageReceiptsSecrets(STAGE.id, { run: 'trn-p' })),
    ).toEqual(['SECRET_RECEIPTS_SEEN_BY_RUN']);
    expect(() => messageReceiptsSecrets('not-a-stage', { run: 'x' })).toThrow();
    expect(() =>
      messageReceiptsSecrets(STAGE.id, { ...ARTIFACT_IDS, run: '' }),
    ).toThrow();
    const journey = read(JOURNEYS);
    for (const step of [
      'protect(context, { room: { name }, texts: [seerName, body, receiptsTransaction(run)] });',
      "protect(context, { account: { role: 'reader', value: reader } });",
      "protect(context, { account: { role: 'author', value: author } });",
      "protect(context, { account: { role: 'seer', value: seer } });",
      'protect(context, { room: { id: room.id } });',
      'protect(context, { eventIds: [eventId] });',
    ])
      expect(journey).toContain(step);
    // Every identifier is registered before the flag clears and before launch.
    const run = functionSource(journey, 'runSeenBy');
    expect(run.indexOf('await arrangeReceipt(context);')).toBeLessThan(
      run.indexOf('context.safety.unsafeSecrets = false;'),
    );
    expect(run.indexOf('context.safety.unsafeSecrets = false;')).toBeLessThan(
      run.indexOf('await startNative(context);'),
    );
  });

  it('rejects every raw, escaped, encoded, sliced and base64url identifier and credential', async () => {
    const { messageReceiptsSecrets, scanMessageReceiptsArtifacts } =
      await loadArtifacts();
    const secrets = messageReceiptsSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-receipts-scan-', async (output) => {
      await mkdir(join(output, STAGE.id));
      const receipt = join(
        output,
        STAGE.id,
        'receipt-01-receipt-relation.json',
      );
      for (const unsafe of [
        `GET /rooms/${ROOM}/messages`,
        JSON.stringify({ password: ARTIFACT_IDS.accounts.seer.password }),
        JSON.stringify({ password: ARTIFACT_IDS.accounts.author.password }),
        `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/receipt/m.read/${mixedCase(encodeURIComponent(EVENT_ID))}`,
        `double=${encodeURIComponent(encodeURIComponent(ROOM))}`,
        `route=/rooms/${Buffer.from(ROOM).toString('base64url')}`,
        `slice=${ROOM.slice(1)}`,
        `selector=.scroll .msg[data-mid="${EVENT_ID}"]`,
        `label=Seen by ${AUTHOR_NAME}`,
        `label=Seen by ${SEER_NAME}`,
        `user=${SEER}`,
        `user=${encodeURIComponent(READER)}`,
        `body=${BODY}`,
        `txn=rcpt-${RUN}`,
        `name=${ROOM_NAME}`,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}`,
        '/_matrix/client/v3/sync?access_token=unregisteredTokenValue',
        '{"access_token":"unregistered_token_value"}',
        'Authorization: Bearer unregistered-token',
        'token=syt_dW5yZWdpc3RlcmVk_abc',
        '<map><string name="CapacitorStorage.trinity">{}</string></map>',
        'pluginId: Preferences, methodName: get, methodData: {"key":"trinity.appearance.mode"}',
      ]) {
        await writeFile(receipt, unsafe);
        await expect(
          scanMessageReceiptsArtifacts(output, secrets),
          unsafe,
        ).rejects.toThrow();
      }
      await writeFile(
        receipt,
        '{"names":2,"server":"localhost","access_token":false,"intersects":false}\n',
      );
      await expect(
        scanMessageReceiptsArtifacts(output, secrets),
      ).resolves.toBeUndefined();
      for (const name of ['capture.png', 'capture.PNG', 'opaque.bin'])
        await withOutput('trinity-receipts-scan-file-', async (other) => {
          await writeFile(join(other, name), 'raster');
          await expect(
            scanMessageReceiptsArtifacts(other, {}),
          ).rejects.toThrow();
        });
    });
  });

  it('scrubs raw and encoded identifiers, deletes rasters and then scans clean', async () => {
    const {
      messageReceiptsSecrets,
      scrubMessageReceiptsArtifacts,
      scanMessageReceiptsArtifacts,
    } = await loadArtifacts();
    const secrets = messageReceiptsSecrets(STAGE.id, ARTIFACT_IDS);
    await withOutput('trinity-receipts-scrub-', async (output) => {
      const stage = join(output, STAGE.id);
      await mkdir(stage);
      const path = join(stage, 'passed-ui.json');
      await writeFile(
        path,
        [
          `GET /rooms/${mixedCase(encodeURIComponent(ROOM))}/messages`,
          `row=.scroll .msg[data-mid=${JSON.stringify(EVENT_ID)}]`,
          `aria-label="Seen by ${AUTHOR_NAME}, ${SEER_NAME}"`,
          `body=${BODY}`,
          JSON.stringify({ password: ARTIFACT_IDS.accounts.reader.password }),
          'unchanged=2 avatars',
        ].join('\n'),
      );
      await writeFile(join(stage, 'passed.png'), 'raster');
      await scrubMessageReceiptsArtifacts(output, secrets);
      const scrubbed = await readFile(path, 'utf8');
      expect(scrubbed.split('\n').at(-1)).toBe('unchanged=2 avatars');
      for (const leaked of [
        ROOM,
        EVENT_ID,
        AUTHOR_NAME,
        SEER_NAME,
        RUN,
        'reader-pass',
      ])
        expect(scrubbed).not.toContain(leaked);
      expect(scrubbed).toContain('[REDACTED]');
      expect(existsSync(join(stage, 'passed.png'))).toBe(false);
      await expect(
        scanMessageReceiptsArtifacts(output, secrets),
      ).resolves.toBeUndefined();
    });
    await withOutput('trinity-receipts-scrub-raster-', async (output) => {
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        await writeFile(join(output, name), 'raster');
      await scrubMessageReceiptsArtifacts(output, {});
      for (const name of ['failed.png', 'failed.PNG', 'capture.webp'])
        expect(existsSync(join(output, name))).toBe(false);
      await expect(
        scanMessageReceiptsArtifacts(output, {}),
      ).resolves.toBeUndefined();
    });
  });

  it('publishes only a complete, clean, unretried one-stage 4-record desktop run', async () => {
    const artifacts = await loadArtifacts();
    const { DESKTOP_ACCOUNT_PROFILE, PIXEL_5_ACCOUNT_PROFILE } =
      await loadClient();
    const report = () => ({
      status: 'passed',
      expectedStages: 1,
      expectedAssertionRecords: 4,
      attempt: 1,
      retries: 0,
      stages: [
        {
          id: STAGE.id,
          status: 'passed',
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: 4,
          assertionRecords: 4,
          assertions: [...ALL_IDENTITIES],
          failureCount: 0,
        },
      ],
    });
    const flags = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    await withOutput('trinity-receipts-gate-', async (output) => {
      const marker = join(output, 'publication-safe');
      const write = (path, value) =>
        writeFile(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
      const provenance = (profile = DESKTOP_ACCOUNT_PROFILE) => ({
        schemaVersion: 1,
        profile: {
          requested: profile,
          digest: sha256(JSON.stringify(profile)),
        },
      });
      const arrange = async (value = report()) => {
        await write('journeys.json', value);
        await write('runtime-provenance.json', provenance());
        await mkdir(join(output, STAGE.id), { recursive: true });
        await write(join(STAGE.id, 'profile-applied.json'), {
          requested: DESKTOP_ACCOUNT_PROFILE,
        });
        for (const name of [
          'passed.json',
          'passed-ui.json',
          'passed-surface.json',
        ])
          await write(join(STAGE.id, name), { ok: true });
      };
      const refused = async (value, options = {}) => {
        await writeFile(marker, 'stale\n');
        await expect(
          artifacts.markMessageReceiptsDiagnosticsSafe(
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
      await artifacts.markMessageReceiptsDiagnosticsSafe(
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
        mutate((value) => (value.stages[0].status = 'failed')),
        mutate((value) => (value.stages[0].retries = 1)),
        mutate((value) => (value.stages[0].failureCount = 1)),
        mutate((value) => {
          value.stages[0].assertions.pop();
          value.stages[0].assertionRecords = 3;
        }),
        mutate((value) => {
          value.stages[0].assertions[3] = value.stages[0].assertions[2];
        }),
        mutate((value) => (value.expectedAssertionRecords = 3)),
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
        join(STAGE.id, 'profile-applied.json'),
        join(STAGE.id, 'passed-ui.json'),
        'runtime-provenance.json',
      ]) {
        await arrange();
        await rm(join(output, missing));
        await refused(report());
      }
      await arrange();
      await write(join(STAGE.id, 'profile-applied.json'), {
        requested: PIXEL_5_ACCOUNT_PROFILE,
      });
      await refused(report());
      await arrange();
      await write(
        'runtime-provenance.json',
        provenance(PIXEL_5_ACCOUNT_PROFILE),
      );
      await refused(report());
      await arrange();
      await write(join(STAGE.id, 'passed-surface.json'), {
        url: `https://localhost/rooms/${Buffer.from(ROOM).toString('base64url')}`,
      });
      await refused(report(), {
        secrets: artifacts.messageReceiptsSecrets(STAGE.id, ARTIFACT_IDS),
      });
      await arrange();
      await writeFile(join(output, STAGE.id, 'passed.png'), 'raster');
      await refused(report());
    });
  });

  it('runs every stage teardown step and revokes publication on abort', async () => {
    const {
      runMessageReceiptsStageCleanup,
      revokeMessageReceiptsPublicationOnAbort,
    } = await loadArtifacts();
    const failures = [];
    const ran = [];
    await runMessageReceiptsStageCleanup(
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
    await withOutput('trinity-receipts-abort-', async (output) => {
      const report = {
        status: 'passed',
        stages: [{ status: 'passed', failureCount: 0 }],
      };
      await writeFile(join(output, 'publication-safe'), 'scanned\n');
      await revokeMessageReceiptsPublicationOnAbort(
        output,
        report,
        new AbortController().signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await revokeMessageReceiptsPublicationOnAbort(
        output,
        report,
        controller.signal,
      );
      expect(existsSync(join(output, 'publication-safe'))).toBe(false);
      expect(report.status).toBe('failed');
      expect(report.stages.at(-1)).toMatchObject({
        status: 'failed',
        failureCount: 1,
        error: 'Cancelled before message-receipts publication',
      });
      expect(
        JSON.parse(await readFile(join(output, 'journeys.json'), 'utf8'))
          .status,
      ).toBe('failed');
    });
  });

  it('tears down all three Accounts and the Room through the shared fixture cleanup', () => {
    const fixtures = read(FIXTURES);
    const cleanup = fixtures.slice(
      fixtures.indexOf(
        "resources.cleanup('cleanup fixture rooms and accounts'",
      ),
      fixtures.indexOf('  function requestSignal('),
    );
    for (const hook of [
      'for (const [roomId, members] of roomMembers) {',
      "for (const action of ['leave', 'forget'] as const) {",
      'AbortSignal.timeout(REQUEST_TIMEOUT_MS),',
      "'/logout',",
      "throw new AggregateError(failures, 'Fixture cleanup failed');",
    ])
      expect(cleanup).toContain(hook);
    // The joins register the author and seer for leave/forget; the creator is the reader.
    expect(fixtures).toContain(
      '    roomMembers.set(id, new Set([owner.userId]));\n    return { id, name: content.name };',
    );
    expect(fixtures).toContain('    members.add(member.userId);');
    const journey = read(JOURNEYS);
    expect(journey).toContain('resources.cleanup = guardedCleanup;');
    expect(journey).toContain(
      '() => device.clearApplicationData(APPLICATION_ID),',
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Hosted wiring and parity ledger                                           */
/* ------------------------------------------------------------------------ */

const NX_COMMAND =
  '--suite=android.message-receipts --timeout-ms=900000 --entrypoint=e2e/android/message-receipts-journeys.mts --platform=android --bundle-manifest --resource=android-avd --resource=synapse';
const CI_LINE =
  'if [ "${{ matrix.shard }}" = "3" ]; then echo \'message-receipts-started=true\' >> "$GITHUB_OUTPUT"; TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 1200000 -- pnpm exec nx run trinity-e2e-android:message-receipts; fi';
const GATE_PATH =
  "-path '*/android.message-receipts/message-receipts/publication-safe'";
const UPLOAD_IF =
  "${{ !cancelled() && steps.android.outputs.message-receipts-started == 'true' && steps.message-receipts-artifact-gate.outputs.message-receipts-safe == 'true' }}";

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
  const target = project.targets['message-receipts'];
  expect(target.cache).toBe(false);
  expect(target.parallelism).toBe(false);
  expect(target.dependsOn).toEqual([
    { projects: ['trinity-android'], target: 'build-prebuilt' },
  ]);
  expect(target.options.command).toContain('web-bundle-manifest.mjs verify');
  expect(target.options.command).toContain(NX_COMMAND);
  expect(pkg.scripts['e2e:android:message-receipts']).toBe(
    'node scripts/nx.mjs run trinity-e2e-android:message-receipts',
  );
  const lines = workflow.split('\n').map((line) => line.trim());
  const runner = lines.indexOf(CI_LINE);
  expect(runner).toBeGreaterThan(-1);
  expect(
    lines.filter((line) =>
      line.includes('trinity-e2e-android:message-receipts'),
    ),
  ).toHaveLength(1);
  expect(lines[runner - 1]).toContain("echo 'member-moderation-started=true'");
  // Only message-source follows it on shard 3.
  const shardThree = lines.filter((line) =>
    line.startsWith('if [ "${{ matrix.shard }}" = "3" ]'),
  );
  expect(shardThree.at(-2)).toBe(CI_LINE);
  expect(shardThree.at(-1)).toContain('trinity-e2e-android:message-source;');
  const gate = workflow
    .split('      - name: Gate Android message-receipts diagnostics\n')[1]
    ?.split('\n      - ')[0];
  expect(gate).toBeDefined();
  expect(gate).toContain('id: message-receipts-artifact-gate');
  expect(gate).toContain(
    "if: ${{ !cancelled() && steps.android.outputs.message-receipts-started == 'true' }}",
  );
  expect(gate).toContain(GATE_PATH);
  expect(gate).toContain(
    'echo \'message-receipts-safe=true\' >> "$GITHUB_OUTPUT"',
  );
  const upload = workflow
    .split('\n      - uses: ./.github/actions/upload-playwright-diagnostics\n')
    .find((step) => step.includes('surface: android-message-receipts\n'));
  expect(upload).toBeDefined();
  expect(upload.split('\n')[0].trim()).toBe(`if: ${UPLOAD_IF}`);
  expect(upload).toContain(
    'report-path: dist/.playwright/trinity-e2e-android/*/android.message-receipts/**',
  );
  // 163 with message-receipts; message-source then adds its own 5 minutes.
  expect(workflow).toContain('shard 2 about 117, shard 3 about 168\n');
  expect(workflow).toContain(
    "# Shard 3's figure adds a provisional 5 minutes for message-receipts.",
  );
  expect(ciSpec).toContain('expect(uploads.length).toBe(78);');
  expect(ciSpec).toContain('expect(lines).toHaveLength(71);');
  expect(ciSpec).toContain("step.with.surface === 'android-message-receipts'");
  expect(ciSpec).toContain(
    'runs message-receipts after member-moderation, followed only by message-source on shard 3',
  );
  expect(ciSpec).toContain(
    'budgets message-receipts in the shard-3 figure of the Android budget comment',
  );
}

describe('Android message-receipts hosted wiring and parity ledger', () => {
  it('registers one serialized uncached target, script, registry suite and commands', async () => {
    assertWiring(wiringInputs());
    const { RUNNER_E2E_SUITES } =
      await import('../e2e/registry/suites/runners.mts');
    const { E2E_PACKAGE_SCRIPTS, E2E_CI_ENTRYPOINTS } =
      await import('../e2e/registry/commands.mts');
    const suites = RUNNER_E2E_SUITES.filter(
      (suite) => suite.id === 'android.message-receipts',
    );
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      environment: 'android',
      runner: 'node-test',
      currentTarget: 'trinity-e2e-android:message-receipts',
      canonicalScript: 'e2e:android:message-receipts',
      availabilityPolicy: 'required',
      ciTier: 'pull-request',
      cachePolicy: 'never',
      serializationKeys: ['android-avd', 'synapse'],
    });
    expect([...suites[0].sourceEntrypoints]).toEqual([
      JOURNEYS,
      CONTRACT,
      OBSERVER,
      ARTIFACTS,
    ]);
    expect(
      E2E_PACKAGE_SCRIPTS.filter(
        (item) => item.name === 'e2e:android:message-receipts',
      ),
    ).toEqual([
      {
        name: 'e2e:android:message-receipts',
        command: 'nx run trinity-e2e-android:message-receipts',
        kind: 'canonical',
        suiteIds: ['android.message-receipts'],
      },
    ]);
    const entrypoints = E2E_CI_ENTRYPOINTS.filter((item) =>
      item.suiteIds.includes('android.message-receipts'),
    );
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0].tier).toBe('pull-request');
    expect(entrypoints[0].command).toContain(
      'if [ "${{ matrix.shard }}" = "3" ]',
    );
    expect(entrypoints[0].command).toContain(
      'pnpm exec nx run trinity-e2e-android:message-receipts',
    );
    expect(read(JOURNEYS)).toContain('timeout: 600_000');
  });

  it('fails the wiring guard for every effective mutation', () => {
    const valid = wiringInputs();
    const clone = () => structuredClone(valid);
    const withTarget = (change) => {
      const inputs = clone();
      change(inputs.project.targets['message-receipts']);
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
            'message-receipts-journeys.mts',
            'message-quote-journeys.mts',
          )),
      ),
      withTarget(
        (target) =>
          (target.options.command = target.options.command.replace(
            '--timeout-ms=900000',
            '--timeout-ms=90000',
          )),
      ),
      (() => {
        const inputs = clone();
        delete inputs.pkg.scripts['e2e:android:message-receipts'];
        return inputs;
      })(),
      withText('workflow', CI_LINE, CI_LINE.replace('= "3"', '= "5"')),
      withText('workflow', CI_LINE, CI_LINE.replace('1200000', '600000')),
      withText('workflow', `${CI_LINE}\n`, ''),
      withText(
        'workflow',
        GATE_PATH,
        "-path '*/android.message-receipts/publication-safe'",
      ),
      withText(
        'workflow',
        UPLOAD_IF,
        "${{ !cancelled() && steps.android.outputs.message-receipts-started == 'true' }}",
      ),
      withText('workflow', 'shard 3 about 168', 'shard 3 about 158'),
      withText(
        'ciSpec',
        'expect(uploads.length).toBe(78);',
        'expect(uploads.length).toBe(77);',
      ),
      withText(
        'ciSpec',
        'expect(lines).toHaveLength(71);',
        'expect(lines).toHaveLength(70);',
      ),
    ])
      expect(() => assertWiring(mutated)).toThrow();
    // The runner moved before member-moderation.
    const inputs = clone();
    const lines = inputs.workflow.split('\n');
    const index = lines.findIndex((line) => line.trim() === CI_LINE);
    const [line] = lines.splice(index, 1);
    lines.splice(index - 1, 0, line);
    inputs.workflow = lines.join('\n');
    expect(() => assertWiring(inputs)).toThrow();
  });

  it('documents exactly the 4 identities with their source lines and the 3/1 prose', () => {
    const migration = read('e2e/android/MIGRATION.md');
    const section = migration
      .split('## Message-receipts journey')[1]
      ?.split('\n## ')[0];
    expect(section).toBeTruthy();
    const rows = [
      ...section.matchAll(
        /^\| `([a-z-]+)` \| ([^|]+) \| (direct|inherited) \| [^\n]+ \| `(message-receipts\.[^`]+)` \|$/gmu,
      ),
    ];
    expect(rows.map((row) => row[4])).toEqual(ALL_IDENTITIES);
    expect(rows.map((row) => row[2].trim())).toEqual(
      ledgerTuples().map((tuple) =>
        tuple[0] === 'direct' ? String(tuple[1]) : `${tuple[1]}@${tuple[3]}`,
      ),
    );
    expect(rows.map((row) => row[1])).toEqual(
      ALL_IDENTITIES.map(() => STAGE.id),
    );
    expect(rows.map((row) => row[3])).toEqual(
      ledgerTuples().map((tuple) => tuple[0]),
    );
    expect(section).toContain('3 direct + 1');
    expect(section).toContain(PREDECESSOR_SHA256);
    for (const hash of Object.values(SHARED_SHA256))
      expect(section).toContain(hash);
    expect(section).toContain('Suite `android.message-receipts`');
    expect(section).toMatch(/remains enabled and untouched/u);
    expect(section).toContain('roomReceipts');
    expect(section).toContain('m.read');
    expect(section).toContain('1280×720');
    expect(section).toContain('acceptance gate for #751');
    expect(section).not.toContain('pnpm exec nx');
    // The next migration's section, and only it, follows this one.
    expect(
      migration.split('## Message-receipts journey')[1].split('\n## ')[1],
    ).toMatch(/^Message-source journey\n/u);
    const design = read(
      'docs/superpowers/specs/2026-09-26-android-read-receipt-maestro-design.md',
    );
    for (const identity of STAGE.suffixes)
      expect(design).toContain(`\`${identity}\``);
    expect(design).toContain(PREDECESSOR_SHA256);
  });
});

/* ------------------------------------------------------------------------ */
/* Source rules: journeys, observer and artifacts                            */
/* ------------------------------------------------------------------------ */

const FORBIDDEN_TOKENS = [
  ['.click(', /\.click\(/u],
  ['.focus(', /\.focus\(/u],
  ['focusFixture', /focusFixture/u],
  ['dispatchEvent', /dispatchEvent/u],
  ['scrollIntoView(', /scrollIntoView\(/u],
  ['.submit(', /\.submit\(|requestSubmit/u],
  ['navigate(', /\bnavigate\(/u],
  ['reload(', /\breload\(/u],
  ['installDocumentScript', /installDocumentScript/u],
  ['execCommand', /execCommand/u],
  ['value write', /\.value\s*=(?!=)|setRangeText|insertText/u],
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
  ['setRoomState', /setRoomState\(/u],
  [
    'CSS or screenshot geometry',
    /getComputedStyle\([^)]*\)\.(?:top|left|bottom|right|position|margin|padding)|\.screenshot\(|toHaveScreenshot|captureScreenshot/u,
  ],
  ['seedPreference', /seedPreference/u],
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
      const called = node.expression.getText(tree).split('.').at(-1);
      if (called === 'waitForNativeShellState' || called === 'waitElements') {
        const bound = node.arguments[4];
        expect(
          bound,
          `${name}: ${node.getText(tree).slice(0, 80)} is bounded`,
        ).toBeDefined();
        expect(bound.getText(tree)).not.toMatch(/Infinity|undefined/u);
      }
      if (['readComposer', 'readReceipts'].includes(called)) {
        const options = node.arguments[1];
        if (options)
          expect(options.getText(tree), `${name}: bounded read`).toMatch(
            /timeoutMs:\s*[A-Z_]+|timeoutMs,/u,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/** The house read-only observer rule, applied to the journeys too. */
function assertReadOnlyObserver(source) {
  expect(source).not.toMatch(
    /\.(?:click|focus|blur|dispatchEvent|scrollIntoView|scrollTo|scrollBy|submit|requestSubmit|select|setSelectionRange)\s*\(/u,
  );
  expect(source).not.toMatch(
    /(?:\.scrollTop|\.scrollLeft|\.value|\.selectionStart|\.selectionEnd|\.innerHTML|\.textContent|\.style\.[\w]+)\s*=(?!=)/u,
  );
  expect(source).not.toMatch(
    /Input\.dispatch|\.goto\s*\(|window\.location\s*=|location\.assign\s*\(|\.style\.(?:setProperty|removeProperty)\s*\(|appendChild|insertBefore|replaceChildren/u,
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

/** The source text of argument `index` of every call to `name`, from the AST. */
function callArguments(source, name, index) {
  const tree = ts.createSourceFile(
    'journeys.mts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node.arguments[index]?.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const recordOf = (suffix) =>
  new RegExp(`\\brecord\\(\\s*\\w+,\\s*'${suffix}'`, 'u');
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

/** The native order and invariants required by the issue. */
function assertJourneyRules(journeys) {
  assertNoForbiddenTokens(journeys, JOURNEYS);
  assertReadOnlyObserver(journeys);
  assertBoundedWaits(journeys, JOURNEYS);
  expect(journeys).not.toMatch(/evaluateNative|webview\./u);
  expect(journeys).not.toMatch(
    /client\.(?:fill|fillFocused|replace|tap|focusCurrent|longPressCurrent|swipeCurrent|key|keyCombination)\(/u,
  );
  // REST arranges exactly one message and one receipt, never after launch.
  expect(journeys.match(/fixtures\.sendMessage\(/gu)).toHaveLength(1);
  expect(journeys.match(/fixtures\.sendReadReceipt\(/gu)).toHaveLength(1);
  expect(journeys.match(/fixtures\.setDisplayName\(/gu)).toHaveLength(1);
  const arrange = functionSource(journeys, 'arrangeReceipt');
  assertOrder(
    arrange,
    [
      /protect\(context, \{ room: \{ name \}, texts: \[seerName, body, receiptsTransaction\(run\)\] \}\)/u,
      /fixtures\.account\(receiptsAccountRole\('reader'\)\)/u,
      /fixtures\.account\(receiptsAccountRole\('author'\)\)/u,
      /fixtures\.account\(receiptsAccountRole\('seer'\)\)/u,
      /fixtures\.setDisplayName\(seer, seerName\)/u,
      /fixtures\.createRoom\(reader, \{\n\s+name,\n\s+invite: \[author\.userId, seer\.userId\],\n\s+\}\)/u,
      /protect\(context, \{ room: \{ id: room\.id \} \}\)/u,
      /fixtures\.join\(author, room\.id\)/u,
      /fixtures\.join\(seer, room\.id\)/u,
      /fixtures\.sendMessage\(author, room\.id, body, receiptsTransaction\(run\)\)/u,
      /protect\(context, \{ eventIds: \[eventId\] \}\)/u,
      /fixtures\.sendReadReceipt\(seer, room\.id, eventId\)/u,
    ],
    'arrangeReceipt',
  );
  const prove = functionSource(journeys, 'proveMatrixState');
  assertOrder(
    prove,
    [
      /fixtures\.roomMessages\(reader, room\.id\)/u,
      /assertReceiptRoom\(events, expected\)/u,
      /receipt\(context, 'message-event'/u,
      /fixtures\.roomMembership\(reader, room\.id, reader\)/u,
      /fixtures\.roomMembership\(reader, room\.id, author\)/u,
      /fixtures\.roomMembership\(reader, room\.id, seer\)/u,
      /receipt\(context, 'seer-membership'/u,
      /seerReceipt\(context, arranged/u,
      /receipt\(context, 'receipt-relation'/u,
    ],
    'proveMatrixState',
  );
  const seer = functionSource(journeys, 'seerReceipt');
  expect(seer).toContain(
    'context.fixtures.roomReceipts(arranged.reader, arranged.room.id)',
  );
  expect(seer).toContain('(value) => assertSeerReceipt(value, expected)');
  const run = functionSource(journeys, 'runSeenBy');
  assertOrder(
    run,
    [
      callOf('arrangeReceipt'),
      /context\.safety\.unsafeSecrets = false/u,
      /proveMatrixState\(context, arranged\)/u,
      callOf('startNative'),
      /client\.login\(reader\)/u,
      /client\.hideKeyboard\(\)/u,
      /openRoom\(context, room, reader\)/u,
      /assertClusterVisible\(value, body, eventId\)/u,
      recordOf('cluster-visible'),
      /assertSeerNamed\(assertClusterVisible\(value, body, eventId\), expectedName\)/u,
      recordOf('seer-named'),
      /assertTextClear\(cluster, body, eventId\)/u,
      recordOf('text-clear'),
      /seerReceipt\(context, arranged, 'retained seer read receipt'\)/u,
      /receipt\(context, 'relation-retained'/u,
    ],
    'runSeenBy',
  );
  // The label accepts only joined non-reader members from Matrix, never a literal.
  expect(run).toContain(
    'memberNames: [names.authorName, seerName],\n    readerName: names.readerName,',
  );
  const openRoom = functionSource(journeys, 'openRoom');
  assertOrder(
    openRoom,
    [
      /client\.tapCurrent\('\[data-testid="rail-rooms"\]'\)/u,
      /client\.tapCurrent\('\.channel', \{ text: room\.name \}\)/u,
      recordOf('room-ready'),
    ],
    'openRoom',
  );
  // Native actions log their selectors to stdout, the published job log and
  // process.log, which the artifact scan does not cover: no selector may carry
  // a Room, event or user identifier, and no wait description interpolates one.
  expect(journeys).not.toMatch(/data-mid(?:[*~|^]?=)|\[data-mid="\$\{/u);
  const calls = [
    ...journeys.matchAll(
      /client\.(?:tapCurrent|visible|waitElements|elements)\(([^;]*?)\);/gsu,
    ),
  ];
  expect(calls).toHaveLength(4);
  for (const call of calls)
    expect(call[1], call[0]).not.toMatch(
      /`|\$\{|Id\b|\.id\b|eventId|userId|seerName|body/u,
    );
  for (const call of journeys.matchAll(/\bdescription: (?!string)([^\n]+)/gu))
    expect(call[1], call[0]).toMatch(/^'[^'$`]+',$/u);
  for (const argument of callArguments(journeys, 'matrixState', 3))
    expect(argument).toMatch(/^(?:'[A-Za-z -]+'|description)$/u);
  for (const call of journeys.matchAll(
    /seerReceipt\(context, arranged, ([^)]*)\)/gu,
  ))
    expect(call[1]).toMatch(/^'[a-z -]+'$/u);
  const runner = functionSource(journeys, 'runMessageReceiptsSuite');
  assertOrder(
    runner,
    [
      /new MatrixTestResources\(/u,
      /createAccountFixtures\(/u,
      /installWithAndroidRuntimeProvenance\(/u,
      /MESSAGE_RECEIPTS_STAGES/u,
      /runMessageReceiptsStageCleanup\(/u,
      /throw redactStageFailure\(entry\.id, failures, secrets\);/u,
    ],
    'runMessageReceiptsSuite',
  );
  for (const required of [
    'expectedStages: 1',
    'expectedAssertionRecords: 4',
    'attempt: 1',
    'retries: 0',
    'markMessageReceiptsDiagnosticsSafe(',
    'scrubMessageReceiptsArtifacts(',
    'revokeMessageReceiptsPublicationOnAbort(',
    "client.capture('passed')",
    "client.capture('failed')",
    'client.reset(DESKTOP_ACCOUNT_PROFILE)',
    'profile: DESKTOP_ACCOUNT_PROFILE',
    'resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
  ])
    expect(journeys).toContain(required);
}

describe('Android message-receipts source rules', () => {
  it('keeps the observer and artifacts read-only, bounded and free of forbidden actions', () => {
    for (const path of [OBSERVER, ARTIFACTS, CONTRACT]) {
      const source = read(path);
      assertNoForbiddenTokens(source, path);
      assertBoundedWaits(source, path);
    }
    const observer = read(OBSERVER);
    assertReadOnlyObserver(observer);
    // Geometry is measured, never read from CSS declarations.
    expect(observer).toContain('const box = element.getBoundingClientRect();');
    expect(observer).not.toMatch(/getComputedStyle\([^)]*\)\.(?!visibility)/u);
    expect(read(ARTIFACTS)).not.toMatch(
      /message-quote-artifacts|message-poll-artifacts/u,
    );
  });

  it('adds one read-only REST receipt fixture to the shared fixtures without exposing its token', () => {
    const fixtures = read(FIXTURES);
    const start = fixtures.indexOf('  async function roomReceipts(');
    expect(start).toBeGreaterThan(-1);
    const body = fixtures.slice(start, fixtures.indexOf('\n  }\n', start));
    for (const hook of [
      '/sync?timeout=0&set_presence=offline&filter=${encodeURIComponent(filter)}',
      'rooms: [roomId],',
      "ephemeral: { types: ['m.receipt'] },",
      'await get(',
      'access(observer),',
    ])
      expect(body).toContain(hook);
    expect(body).not.toMatch(/return[^;]*token|request\(|'POST'|'PUT'/u);
    expect(fixtures).toContain('    roomReceipts,\n');
    expect(fixtures).toContain(
      '  roomReceipts(\n    observer: NodeWorkspaceAccount,\n    roomId: string,\n  ): Promise<readonly Readonly<Record<string, unknown>>[]>;',
    );
    // No other suite calls it.
    expect(
      read('e2e/android/message-quote-journeys.mts').includes('roomReceipts'),
    ).toBe(false);
  });

  it('fails the forbidden-token and read-only rules under each effective mutation', () => {
    const observer = read(OBSERVER);
    for (const mutation of [
      'element.click()',
      'element.focus()',
      'input.value = "x"',
      "document.execCommand('insertText', false, 'x')",
      'element.dispatchEvent(new MouseEvent("click"))',
      'row.classList.add("msg--revealed")',
      'cluster.setAttribute("aria-label", "Seen by Cara")',
      'cluster.style.position = "static"',
      'window.location = "/rooms"',
      'const top = getComputedStyle(cluster).top',
      'await page.screenshot()',
      'const report = { retries: 1 }',
    ])
      expect(() =>
        assertNoForbiddenTokens(`${observer}\n${mutation}`, OBSERVER),
      ).toThrow();
    for (const mutation of [
      'element.click()',
      'input.focus()',
      'row.scrollTo(0, 0)',
      'input.value = "x"',
      'row.appendChild(node)',
    ])
      expect(() =>
        assertReadOnlyObserver(`${observer}\n${mutation}`),
      ).toThrow();
    for (const unbounded of [
      'await waitForNativeShellState(read, accepts, "x", signal);',
      'await client.waitElements(SHEET, accepts, "x");',
    ])
      expect(() =>
        assertBoundedWaits(`${observer}\n${unbounded}`, OBSERVER),
      ).toThrow();
  });

  it('drives every product action natively in source order', () => {
    const journeys = read(JOURNEYS);
    assertJourneyRules(journeys);
    const replace = (from, to) => {
      expect(journeys).toMatch(from);
      return journeys.replace(from, to);
    };
    for (const mutated of [
      // DOM input, a renderer-injected receipt or a REST send after launch.
      `${journeys}\nawait evaluateNative(client.webview, 'x');`,
      `${journeys}\nawait client.fill(COMPOSER, 'x');`,
      `${journeys}\nawait client.tap('[data-testid="read-receipts"]');`,
      `${journeys}\nawait fixtures.sendReadReceipt(reader, room.id, eventId);`,
      `${journeys}\nawait fixtures.sendMessage(author, room.id, body, 'txn');`,
      // The display name is set after the Room exists.
      replace(
        /  await fixtures\.setDisplayName\(seer, seerName\);\n/u,
        '',
      ).replace(
        '  await fixtures.join(seer, room.id);\n',
        '  await fixtures.join(seer, room.id);\n  await fixtures.setDisplayName(seer, seerName);\n',
      ),
      // The receipt is for another event, or from another Account.
      replace(
        /fixtures\.sendReadReceipt\(seer, room\.id, eventId\)/u,
        'fixtures.sendReadReceipt(author, room.id, eventId)',
      ),
      // The Matrix proof is skipped or runs after launch.
      replace(
        /  const names = await proveMatrixState\(context, arranged\);\n/u,
        "  const names = { authorName: '', readerName: '' };\n",
      ),
      replace(/\(value\) => assertSeerReceipt\(value, expected\)/u, '() => {}'),
      // A record without its proof, or a receipt in place of a record.
      replace(
        /record\(context, 'text-clear'/u,
        "receipt(context, 'text-clear'",
      ),
      replace(
        /assertSeerNamed\(assertClusterVisible\(value, body, eventId\), expectedName\);/u,
        'assertClusterVisible(value, body, eventId);',
      ),
      // The label list accepts the reader or any name.
      replace(
        /memberNames: \[names\.authorName, seerName\],/u,
        'memberNames: [names.authorName, seerName, names.readerName],',
      ),
      // A selector or description carries an identifier.
      replace(
        /client\.tapCurrent\('\.channel', \{ text: room\.name \}\)/u,
        'client.tapCurrent(`.channel[title="${room.id}"]`, { text: room.name })',
      ),
      replace(
        /description: 'the exact message row cluster names the seer',/u,
        'description: `cluster for ${eventId}`,',
      ),
      `${journeys}\nawait client.visible(\`.scroll .msg[data-mid="\${eventId}"]\`);`,
      // The relation is not re-read after rendering.
      replace(
        /  const retained = await seerReceipt\(context, arranged, 'retained seer read receipt'\);\n/u,
        '  const retained = { eventId };\n',
      ),
    ])
      expect(() => assertJourneyRules(mutated)).toThrow();
  });
});
