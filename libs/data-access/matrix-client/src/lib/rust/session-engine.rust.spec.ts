import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom } from 'rxjs';
import { beforeAll, describe } from 'vitest';
import { StdioTransport, testhostBinaryAvailable } from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineSessionEngineContract } from '../../contract/session-engine.contract';
import { sessionSynapseFixture } from '../../contract/session-synapse-fixture';
import type { SessionEngine } from '../session-engine';

// Runs the session engine contract against the Rust test host and a live Synapse; skipped
// unless TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust SessionEngine against Synapse',
  () => {
    const synapse = sessionSynapseFixture(baseUrl, secret);
    beforeAll(() => synapse.waitForBackgroundUpdates(), 120_000);

    defineSessionEngineContract(
      async () => {
        // A host per test, each with its own stores and key.
        const dir = await mkdtemp(join(tmpdir(), 'trinity-engine-'));
        const transport = StdioTransport.start({
          env: {
            ...process.env,
            TRINITY_ENGINE_DATA_DIR: dir,
            TRINITY_ENGINE_STORE_KEY: randomBytes(32).toString('hex'),
          },
        });
        return {
          engine: proxyEngine<SessionEngine>('session', transport),
          newSession: synapse.newSession,
          tokenAccepted: synapse.tokenAccepted,
          softLogout: async (session) => {
            await firstValueFrom(
              transport.open('testhost.serverLogout', [session.userId, true]),
            );
          },
          revokeToken: synapse.revokeToken,
          passwordFor: synapse.passwordFor,
          signInAgain: synapse.signInAgain,
          dispose: async () => {
            await transport.dispose();
            await rm(dir, { recursive: true, force: true });
          },
        };
      },
      { syncTimeoutMs: 90_000, testTimeoutMs: 180_000 },
    );
  },
);
