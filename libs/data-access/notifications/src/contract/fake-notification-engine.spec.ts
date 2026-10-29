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
      foreignRoomRule: async (kind, ruleId, rule, enabled) =>
        engine.writeRoomRule(kind, ruleId, rule, enabled),
      roomRules: async (roomId) => engine.serverRoomRules(roomId),
      foreignAccountData: async (type, content) =>
        engine.writeAccountData(type, content),
      accountData: async (type) => engine.readAccountData(type),
      bob: engine.bob,
      sharedRoom: async (name, encrypted) =>
        engine.createRoom(name, { encrypted }),
      send: async (sender, roomId, body) => engine.send(sender, roomId, body),
      react: async (roomId, targetEventId, key) =>
        engine.react(engine.bob, roomId, targetEventId, key),
      redact: async (roomId, eventId) => engine.redact(roomId, eventId),
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);
