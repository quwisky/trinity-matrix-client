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
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  assertDecodedDmAvatar,
  assertDmPresence,
  assertGroupAvatarFallback,
  assertMembersInitiallyHidden,
  assertMembersPanelVisible,
  assertTimelineVisible,
  assertMemberPresence,
} from './identity-presence-observer.mts';

const PNG_1X1 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
));

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'dm-avatar',
    source: 'e2e/browser/journeys/identity/dm-avatar.spec.mts:148-186',
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('identity-avatar-reader');
      const partner = await fixtures.account('identity-avatar-partner');
      await fixtures.setProfileAvatar(partner, PNG_1X1);
      await fixtures.createDirectRoom(reader, partner);
      const group = await fixtures.createRoom(reader, {
        name: resources.roomName('identity-avatar-control'),
        invite: [partner.userId],
      });
      await fixtures.join(partner, group.id);

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await assertDecodedDmAvatar(client, partner.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await assertGroupAvatarFallback(client, group.name);
    },
  },
  {
    id: 'member-presence',
    source: 'e2e/browser/journeys/identity/presence.spec.mts:153-182 plus openRoomWithMembers:91-108',
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('identity-members-reader');
      const member = await fixtures.account('identity-members-member');
      const room = await fixtures.createRoom(reader, {
        name: resources.roomName('identity-members-presence'),
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await client.visible('.channel', { text: room.name }, 30_000);
      await client.record('members.room-row-visible', { assertion: 'members.room-row-visible', room: room.name });
      await client.tap('.channel', { text: room.name });
      await assertTimelineVisible(client);
      await assertMembersInitiallyHidden(client);
      await client.tap('[data-testid="toggle-members"]');
      await assertMembersPanelVisible(client);
      await assertMemberPresence(client, reader.username, member.username);
    },
  },
  {
    id: 'dm-presence',
    source: 'e2e/browser/journeys/identity/presence.spec.mts:184-202',
    async run({ client, fixtures }) {
      const reader = await fixtures.account('identity-presence-reader');
      const partner = await fixtures.account('identity-presence-partner');
      await fixtures.createDirectRoom(reader, partner);

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await assertDmPresence(client, partner.username);
    },
  },
];

assert.equal(cases.length, 3, 'Exactly three Identity Android stages are required');
assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length);

async function assertExactRoomsRoute(
  client: AccountWorkspaceClient,
  username: string,
): Promise<void> {
  const surface = await waitForNativeShellState(
    () => client.surface(),
    surface => {
      const url = new URL(surface.url);
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

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

export const identityPresenceCases = cases;

void test('Android identity avatar and presence journeys', { timeout: 900_000 }, async context => {
  await withNodeTestResources({ testId: context.name, signal: context.signal }, async ({ matrixResources, signal }) => {
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot, 'dist/.playwright'), 'identity-presence');
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
    matrixResources.cleanup('Redact identity diagnostics', () => redactMaestroArtifacts(output, secrets));
    const device = await openMaestroDevice({ workspaceRoot: session.workspaceRoot, signal, artifactDirectory: output, serial: process.env['TRINITY_ANDROID_SERIAL'] });
    matrixResources.cleanup('Identity Android device', () => device.close());
    let client: AccountWorkspaceClient | undefined;
    matrixResources.cleanup('Identity Android WebView', async () => client?.close());
    await device.install(join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'));

    const stages: Array<{
      readonly id: string;
      readonly source: string;
      status: 'running' | 'passed' | 'failed';
      durationMs: number;
      artifact: string;
      error?: string;
    }> = [];
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
      console.info(`[identity-presence] ${entry.id} start`);
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
        stage.durationMs = performance.now() - started;
        if (failures.length) stage.error = failures.map(describeFailure).join('\n');
        await save();
        console.info(`[identity-presence] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`);
      }
      if (failures.length) throw new AggregateError(failures, `Identity journey ${entry.id} failed`);
    }
    assert.equal(stages.filter(stage => stage.status === 'passed').length, cases.length);
  });
});
