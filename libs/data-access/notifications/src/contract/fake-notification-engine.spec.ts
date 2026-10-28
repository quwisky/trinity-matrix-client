import { defineNotificationEngineContract } from './notification-engine.contract';
import { FakeNotificationEngine } from './fake-notification-engine';

defineNotificationEngineContract(
  async () => {
    const engine = new FakeNotificationEngine();
    return {
      engine,
      alice: engine.alice,
      foreignKeywordRule: async (ruleId, pattern, enabled) =>
        engine.writeKeywordRule(ruleId, pattern, enabled),
      keywordActions: async (ruleId) => engine.keywordActions(ruleId),
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);
