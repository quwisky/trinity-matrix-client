import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { defineNotificationEngineContract } from '../../contract/notification-engine.contract';
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
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
