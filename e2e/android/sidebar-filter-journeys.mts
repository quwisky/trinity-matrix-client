import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountWorkspaceCase,
  type AccountElement,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { ANDROID_KEYCODES } from './maestro-keyboard.mts';

const FILTER = '[data-testid="sidebar-filter"]';
const CLEAR = '[data-testid="sidebar-filter-clear"]';
const source = {
  accent: 'e2e/browser/journeys/room-library/sidebar-filter.spec.mts:103-162',
  escape: 'e2e/browser/journeys/room-library/sidebar-filter.spec.mts:164-196',
} as const;

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function assertRoomsRoute(client: AccountWorkspaceClient, username: string): Promise<void> {
  const surface = await waitForNativeShellState(
    () => client.surface(),
    value => {
      const url = new URL(value.url);
      return url.pathname === '/rooms' && url.searchParams.get('account') === `@${username}:localhost`;
    },
    'exact account-qualified /rooms pathname',
    client.signal,
    60_000,
  );
  await client.record('login.rooms-route', {
    assertion: 'login.rooms-route',
    pathname: new URL(surface.url).pathname,
    account: new URL(surface.url).searchParams.get('account'),
  });
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  timeoutMs = 15_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(selector, accepts, assertion, {}, timeoutMs);
    await client.record(assertion, { assertion, observation: elements });
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: readonly AccountElement[] | null = null;
    try { observation = await client.elements(selector); } catch (diagnosticError) { failures.push(diagnosticError); }
    try { await client.record(assertion, { assertion, observation, error: describeFailure(error) }); } catch (diagnosticError) { failures.push(diagnosticError); }
    throw new AggregateError(failures, `${assertion}: ${describeFailure(error)}`);
  }
}

async function rowCount(client: AccountWorkspaceClient, assertion: string, expected: number, timeoutMs: number): Promise<void> {
  await observedElements(client, assertion, '.channel', elements => elements.length === expected, timeoutMs);
}

async function exactNames(client: AccountWorkspaceClient, assertion: string, expected: readonly string[], sorted = false): Promise<void> {
  const names = (await client.elements('.channel__name')).map(element => element.text);
  await client.record(assertion, { assertion, observation: names });
  assert.deepEqual(sorted ? [...names].sort() : names, sorted ? [...expected].sort() : expected, assertion);
}

async function filterValue(client: AccountWorkspaceClient, assertion: string, expected: string): Promise<void> {
  await observedElements(client, assertion, FILTER, elements => elements.length === 1 && elements[0]!.value === expected);
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'filter-accent-clear',
    source: source.accent,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('sidebar-filter-clear-reader');
      const suffix = resources.roomName('sidebar-filter-clear');
      const cafeName = `Cafétéria ${suffix}`;
      const warehouseName = `Warehouse ${suffix}`;
      await fixtures.createRoom(reader, { name: cafeName, preset: 'private_chat' });
      await fixtures.createRoom(reader, { name: warehouseName, preset: 'private_chat' });
      await client.login(reader);
      await assertRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await observedElements(client, 'setup.seeded-rooms-visible', '.channel', elements =>
        [cafeName, warehouseName].every(name => elements.some(element => element.visible && element.text.includes(name))), 30_000);

      await observedElements(client, 'clear.initially-absent', CLEAR, elements => elements.length === 0);

      await client.fill(FILTER, 'cafeteria');
      await rowCount(client, 'accent.one-row', 1, 10_000);
      await exactNames(client, 'accent.exact-name', [cafeName]);
      await filterValue(client, 'accent.query-retained', 'cafeteria');

      await client.fill(FILTER, 'zzzz');
      await rowCount(client, 'no-match.zero-rows', 0, 10_000);
      await observedElements(client, 'no-match.copy', '[data-testid="room-list-empty"]', elements =>
        elements.length === 1 && /No rooms match/u.test(elements[0]!.text));

      await client.tapCurrent(CLEAR);
      await filterValue(client, 'clear.empty-value', '');
      await rowCount(client, 'clear.two-rows', 2, 10_000);
      await exactNames(client, 'clear.exact-names', [cafeName, warehouseName], true);
    },
  },
  {
    id: 'filter-escape',
    source: source.escape,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('sidebar-filter-escape-reader');
      const suffix = resources.roomName('sidebar-filter-escape');
      const cafeName = `Cafétéria ${suffix}`;
      const warehouseName = `Warehouse ${suffix}`;
      await fixtures.createRoom(reader, { name: cafeName, preset: 'private_chat' });
      await fixtures.createRoom(reader, { name: warehouseName, preset: 'private_chat' });
      await client.login(reader);
      await assertRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await rowCount(client, 'escape.initial-two-rows', 2, 30_000);

      await client.fill(FILTER, 'warehouse');
      await rowCount(client, 'escape.one-row', 1, 10_000);
      await exactNames(client, 'escape.exact-name', [warehouseName]);

      const beforeKey = await client.elements(FILTER);
      if (beforeKey.length !== 1 || !beforeKey[0]!.focused) await client.tapCurrent(FILTER);
      await client.focused(FILTER);
      await client.record('escape.focused-precondition', { assertion: 'escape.focused-precondition', observation: await client.elements(FILTER) });
      await client.key('escape');
      await client.record('escape.native-dispatch', { assertion: 'escape.native-dispatch', key: 'escape', keycode: ANDROID_KEYCODES.escape, completed: true });
      await filterValue(client, 'escape.empty-value', '');
      await rowCount(client, 'escape.two-rows', 2, 10_000);
      await exactNames(client, 'escape.exact-names-restored', [cafeName, warehouseName], true);
      await observedElements(client, 'escape.filter-visible', FILTER, elements => elements.length === 1 && elements[0]!.visible);
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two sidebar filter stages are required');
assert.deepEqual(cases.map(entry => entry.source), [source.accent, source.escape]);

void test('Android sidebar filter journeys', { timeout: 900_000 }, async context => {
  await withNodeTestResources({ testId: context.name, signal: context.signal }, async ({ matrixResources, signal }) => {
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot, 'dist/.playwright'), 'sidebar-filter');
    await mkdir(output, { recursive: true });
    const secrets: Record<string, string> = {};
    const baseFixtures = createAccountFixtures(matrixResources, signal);
    const fixtures: typeof baseFixtures = {
      ...baseFixtures,
      account: async (...args) => {
        const account = await baseFixtures.account(...args);
        secrets[`PASSWORD_${account.username}`] = account.password;
        return account;
      },
    };
    matrixResources.cleanup('Redact sidebar filter diagnostics', () => redactMaestroArtifacts(output, secrets));
    const device = await openMaestroDevice({ workspaceRoot: session.workspaceRoot, signal, artifactDirectory: output, serial: process.env['TRINITY_ANDROID_SERIAL'] });
    matrixResources.cleanup('Sidebar filter Android device', () => device.close());
    let client: AccountWorkspaceClient | undefined;
    matrixResources.cleanup('Sidebar filter Android WebView', async () => client?.close());
    await device.install(join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'));

    const stages: Array<{ id: string; source: string; status: 'running' | 'passed' | 'failed'; durationMs: number; artifact: string; failureCount?: number; error?: string }> = [];
    const save = async (): Promise<void> => writeFile(join(output, 'journeys.json'), `${JSON.stringify({ expectedStages: cases.length, stages }, null, 2)}\n`);
    for (const entry of cases) {
      const directory = join(output, entry.id);
      await mkdir(directory, { recursive: true });
      client = new AccountWorkspaceClient(device, session.workspaceRoot, directory, signal);
      const stage: (typeof stages)[number] = { id: entry.id, source: entry.source, status: 'running', durationMs: 0, artifact: `${entry.id}/*` };
      stages.push(stage);
      await save();
      const started = performance.now();
      const failures: unknown[] = [];
      try {
        await client.reset(DESKTOP_ACCOUNT_PROFILE);
        await entry.run({ client, fixtures, resources: matrixResources, signal });
        await client.capture('passed');
      } catch (error) {
        failures.push(error);
        try { await client.capture('failed'); } catch (diagnosticError) { failures.push(diagnosticError); }
      } finally {
        try { await client.close(); } catch (error) { failures.push(error); }
        stage.status = failures.length ? 'failed' : 'passed';
        stage.failureCount = failures.length;
        stage.durationMs = performance.now() - started;
        if (failures.length) stage.error = failures.map(describeFailure).join('\n');
        await save();
      }
      if (failures.length) throw new AggregateError(failures, `Sidebar filter journey ${entry.id} failed`);
    }
    assert.equal(stages.filter(stage => stage.status === 'passed').length, cases.length);
  });
});
