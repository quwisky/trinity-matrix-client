import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const runtimeImplementation =
  'libs/data-access/timeline/src/lib/conversation-runtime.service.ts';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
  )
  .sort();

/**
 * Freeze the production tracer for #304.
 *
 * TimelineService is now a child implementation with one immutable Account-and-Room
 * lifetime. Injecting its root provider would recreate the retargetable singleton this
 * migration removed, while an SDK import in the room feature would skip the child seam.
 */
describe('Conversation Runtime production boundary', () => {
  it('keeps the timeline child implementation private to Conversation Runtime', () => {
    const timelineImport =
      /import\s*{[^}]*\bTimelineService\b[^}]*}\s*from\s*['"]@trinity\/data-access\/timeline['"]/s;
    const directConsumers = productionSources
      .filter((file) => file !== runtimeImplementation)
      .filter((file) => timelineImport.test(source(file)));

    expect(directConsumers).toEqual([]);
  });

  it('keeps the room feature behind data-access instead of the Matrix SDK', () => {
    const sdkConsumers = productionSources
      .filter((file) => file.startsWith('libs/feature/rooms/'))
      .filter((file) => /from ['"]matrix-js-sdk(?:\/|['"])/.test(source(file)));

    expect(sdkConsumers).toEqual([]);
  });

  it('does not expose the raw timeline SDK context through the Conversation capability', () => {
    const runtime = source(runtimeImplementation);
    const roomFeature = productionSources
      .filter((file) => file.startsWith('libs/feature/rooms/'))
      .map(source)
      .join('\n');

    expect(runtime).not.toMatch(/ConversationTimeline[\s\S]*?\| 'openContext'/);
    expect(roomFeature).not.toContain('.openContext()');
  });

  it('focuses the routed room through an Account-and-Room key', () => {
    const navigation = source(
      'libs/feature/rooms/src/lib/rooms/room-shell-navigation.service.ts',
    );

    expect(navigation).toContain(
      'this.conversations.focus({ accountId, roomId });',
    );
    expect(navigation).toContain('this.conversations.blur();');
  });

  it('binds each child to the client for its immutable Account key', () => {
    const runtime = source(runtimeImplementation);

    expect(runtime).toContain('this.matrix.clientFor(key.accountId)');
    expect(runtime).toContain('timeline.open(key.roomId, client);');
  });
});
