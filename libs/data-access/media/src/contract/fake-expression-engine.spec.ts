import { IMAGE_PACK_EVENT_TYPE } from '../lib/image-pack.model';
import { defineExpressionEngineContract } from './expression-engine.contract';
import { FakeExpressionEngine } from './fake-expression-engine';

let rooms = 0;

defineExpressionEngineContract(
  async () => {
    const engine = new FakeExpressionEngine();
    return {
      engine,
      alice: engine.alice,
      ownRoom: async () => engine.addRoom(),
      foreignPackRoom: async (name, pack) => {
        const alias = `#pack${++rooms}:fake`;
        const roomId = engine.addRoom({
          name,
          alias,
          joined: false,
          writable: false,
          state: [
            { type: IMAGE_PACK_EVENT_TYPE, state_key: '', content: pack },
          ],
        });
        return { roomId, alias };
      },
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);
