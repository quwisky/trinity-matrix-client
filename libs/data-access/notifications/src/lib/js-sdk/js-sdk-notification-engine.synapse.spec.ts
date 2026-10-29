import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
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
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
