import { defineTrustEngineContract } from './trust-engine.contract';
import { FakeTrustEngine } from './fake-trust-engine';

defineTrustEngineContract(
  async () => {
    const engine = new FakeTrustEngine();
    return {
      engine,
      alice: engine.alice,
      publishIdentity: async () => engine.publishIdentity(engine.alice),
      setServerDefaultKey: async (keyId) =>
        engine.setServerDefaultKey(engine.alice, keyId),
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);
