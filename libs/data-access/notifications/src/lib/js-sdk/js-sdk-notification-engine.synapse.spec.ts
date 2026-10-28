import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type ServerRoomRule,
  defineNotificationEngineContract,
} from '../../contract/notification-engine.contract';
import { JsSdkNotificationEngine } from './js-sdk-notification-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  room,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

interface ServerRule {
  readonly rule_id: string;
  readonly enabled: boolean;
  readonly actions: unknown;
  readonly conditions?: readonly { key?: string; pattern?: string }[];
}

// Runs the notification contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkNotificationEngine against Synapse', () => {
  useSynapseSuite();

  defineNotificationEngineContract(
    async () => {
      const session = await startSession(await register(localpart('alice')));
      const bob = await register(localpart('bob'));
      const tokens = new Map([
        [session.userId, session.accessToken],
        [bob.userId, bob.accessToken],
      ]);
      let txn = 0;
      const put = async (
        sender: string,
        path: string,
        body: object,
      ): Promise<string> => {
        const sent = (await cs(
          tokens.get(sender) as string,
          'PUT',
          `${path}/${Date.now()}-${++txn}`,
          body,
        )) as { event_id: string };
        return sent.event_id;
      };
      return {
        engine: TestBed.inject(JsSdkNotificationEngine),
        alice: session.userId,
        foreignKeywordRule: async (ruleId, pattern, enabled) => {
          const path = `/pushrules/global/content/${encodeURIComponent(ruleId)}`;
          await cs(session.accessToken, 'PUT', path, {
            pattern,
            actions: ['notify'],
          });
          if (!enabled) {
            await cs(session.accessToken, 'PUT', `${path}/enabled`, {
              enabled: false,
            });
          }
        },
        keywordActions: async (ruleId) => {
          const rule = (await cs(
            session.accessToken,
            'GET',
            `/pushrules/global/content/${encodeURIComponent(ruleId)}`,
          )) as { actions?: unknown } | null;
          return rule?.actions;
        },
        foreignRoomRule: async (kind, ruleId, rule, enabled) => {
          const path = `/pushrules/global/${kind}/${encodeURIComponent(ruleId)}`;
          await cs(session.accessToken, 'PUT', path, rule);
          if (!enabled) {
            await cs(session.accessToken, 'PUT', `${path}/enabled`, {
              enabled: false,
            });
          }
        },
        roomRules: async (roomId) => {
          const all = (await cs(session.accessToken, 'GET', '/pushrules/')) as {
            global: Record<string, ServerRule[] | undefined>;
          };
          return (['override', 'room', 'underride'] as const)
            .flatMap((kind) =>
              (all.global[kind] ?? [])
                .filter(
                  (rule) =>
                    rule.rule_id === roomId ||
                    (rule.conditions ?? []).some(
                      (condition) =>
                        condition.key === 'room_id' &&
                        condition.pattern === roomId,
                    ),
                )
                .map((rule): ServerRoomRule => ({
                  kind,
                  ruleId: rule.rule_id,
                  enabled: rule.enabled,
                  actions: rule.actions,
                })),
            )
            .sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) ||
                a.ruleId.localeCompare(b.ruleId),
            );
        },
        foreignAccountData: async (type, content) => {
          await cs(
            session.accessToken,
            'PUT',
            `/user/${encodeURIComponent(session.userId)}/account_data/${type}`,
            content,
          );
        },
        accountData: async (type) =>
          (await cs(
            session.accessToken,
            'GET',
            `/user/${encodeURIComponent(session.userId)}/account_data/${type}`,
          )) ?? undefined,
        bob: bob.userId,
        sharedRoom: async (name, encrypted) => {
          const { room_id: roomId } = (await cs(
            bob.accessToken,
            'POST',
            '/createRoom',
            {
              name,
              preset: 'private_chat',
              invite: [session.userId],
              initial_state: encrypted
                ? [
                    {
                      type: 'm.room.encryption',
                      state_key: '',
                      content: { algorithm: 'm.megolm.v1.aes-sha2' },
                    },
                  ]
                : [],
            },
          )) as { room_id: string };
          await cs(session.accessToken, 'POST', `${room(roomId)}/join`, {});
          // Joined in alice's client too, so what follows arrives as live events.
          const client = TestBed.inject(JS_SDK_CLIENTS).clientFor(
            session.userId,
          );
          await vi.waitFor(
            () => {
              if (client?.getRoom(roomId)?.getMyMembership() !== 'join') {
                throw new Error('Not joined yet');
              }
            },
            { timeout: 30_000, interval: 100 },
          );
          return roomId;
        },
        send: (sender, roomId, body) =>
          put(sender, `${room(roomId)}/send/m.room.message`, {
            msgtype: 'm.text',
            body,
          }),
        react: (roomId, targetEventId, key) =>
          put(bob.userId, `${room(roomId)}/send/m.reaction`, {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: targetEventId,
              key,
            },
          }),
        redact: async (roomId, eventId) => {
          await put(
            bob.userId,
            `${room(roomId)}/redact/${encodeURIComponent(eventId)}`,
            {},
          );
        },
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
