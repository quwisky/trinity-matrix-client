import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const runtimeImplementation =
  'libs/data-access/timeline/src/lib/conversation-runtime.service.ts';
const composeImplementation =
  'libs/data-access/timeline/src/lib/conversation-compose.ts';
const timelineEntrypoint = 'libs/data-access/timeline/src/index.ts';
const messageAdapterImplementation =
  'libs/data-access/timeline/src/lib/conversation-message-adapter.service.ts';
const timelineImplementation =
  'libs/data-access/timeline/src/lib/timeline.service.ts';
const legacyActionsImplementation =
  'libs/data-access/timeline/src/lib/timeline-actions.service.ts';
const threadsImplementation =
  'libs/data-access/timeline/src/lib/threads.service.ts';
const threadChildrenImplementation =
  'libs/data-access/timeline/src/lib/conversation-thread-children.ts';

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

    const entrypoint = source(timelineEntrypoint);
    expect(entrypoint).not.toContain("export * from './lib/timeline.service'");
    expect(entrypoint).not.toContain(
      "export * from './lib/conversation-runtime.service'",
    );
    expect(entrypoint).not.toMatch(/\bTimeline(?:Service|Context)\b/);
    expect(entrypoint).not.toMatch(
      /\bConversationTimeline(?:Controller|Factory)\b|\bCONVERSATION_(?:TIMELINE_FACTORY|RETENTION_LIMIT)\b/,
    );
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

  it('focuses the committed Workspace room through an Account-and-Room key', () => {
    const navigation = source(
      'libs/feature/rooms/src/lib/rooms/room-shell-navigation.service.ts',
    );
    const workspace = source(
      'libs/feature/rooms/src/lib/rooms/workspace.service.ts',
    );

    expect(workspace).toContain(
      'this.conversations.focus({\n      accountId: view.accountId,\n      roomId: view.roomId,\n    });',
    );
    expect(workspace).toContain('this.conversations.blur();');
    expect(navigation).toContain('.open(destination, { source, history })');
  });

  it('binds each child to the client for its immutable Account key', () => {
    const runtime = source(runtimeImplementation);

    expect(runtime).toContain('this.matrix.clientFor(key.accountId)');
    expect(runtime).toContain('timeline.open(key.roomId, client);');
  });

  it('owns message relations, actions and receipts behind the exact Conversation handle', () => {
    const runtime = source(runtimeImplementation);
    const compose = source(composeImplementation);
    const entrypoint = source(timelineEntrypoint);
    const adapter = source(messageAdapterImplementation);
    const timeline = source(timelineImplementation);
    const legacyActions = source(legacyActionsImplementation);
    const roomFeature = productionSources
      .filter((file) => file.startsWith('libs/feature/rooms/'))
      .map(source)
      .join('\n');

    expect(runtime).toContain('readonly messages: ConversationMessages;');
    expect(runtime).toContain('this.messageAdapter.toggleReaction({');
    const composeContract = compose.match(
      /export interface ConversationCompose \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(composeContract).not.toMatch(/\bbegin(?:Reply|Edit)\s*\(/);
    expect(entrypoint).not.toContain('CONVERSATION_MESSAGE_ADAPTER');
    expect(entrypoint).not.toContain('ConversationMessageAdapter');
    expect(adapter).toContain('this.matrix.clientFor(request.key.accountId)');
    expect(adapter).toContain('myReactionId(');
    expect(adapter).toContain('this.policy.authorizeRedaction(request)');
    expect(adapter).not.toMatch(/\b(?:signal|Subject|BehaviorSubject)\s*[<(]/);
    expect(timeline).not.toContain('.sendReadReceipt(');
    expect(timeline).not.toContain('.setRoomReadMarkers(');
    expect(legacyActions).not.toMatch(
      /\b(?:retry|redact|toggleReaction)\s*\(messageId:/,
    );
    expect(roomFeature).not.toContain('timelineActions.redact(');
    expect(roomFeature).not.toContain('timelineActions.toggleReaction(');
    expect(roomFeature).not.toContain('timelineActions.retry(');
  });

  it('binds Room Administration governance at the application composition root', () => {
    const main = source('apps/trinity/src/main.ts');
    const governance = source(
      'libs/data-access/room-administration/src/lib/room-message-governance.service.ts',
    );

    expect(main).toContain('provide: CONVERSATION_MESSAGE_POLICY');
    expect(main).toContain('inject(RoomMessageGovernanceService)');
    expect(governance).toContain('maySendRedactionForEvent');
    expect(governance).toContain('this.matrix.clientFor(key.accountId)');
  });

  it('owns keyed thread and pin children without legacy public facades', () => {
    const runtime = source(runtimeImplementation);
    const threadChildren = source(threadChildrenImplementation);
    const entrypoint = source(timelineEntrypoint);
    const threadAdapter = source(threadsImplementation);
    const main = source('apps/trinity/src/main.ts');
    const roomFeature = productionSources
      .filter((file) => file.startsWith('libs/feature/rooms/'))
      .map(source)
      .join('\n');

    expect(runtime).toContain('readonly threads: ConversationThreads;');
    expect(runtime).toContain('readonly pins: ConversationPins;');
    expect(threadChildren).toContain('forRoot: (rootEventId: string)');
    expect(threadChildren).toContain('threadRootId: rootEventId');
    expect(entrypoint).not.toContain("export * from './lib/threads.service'");
    expect(entrypoint).not.toMatch(
      /\b(?:ThreadsService|PinnedMessagesService)\b/,
    );
    expect(roomFeature).not.toMatch(
      /\b(?:ThreadsService|PinnedMessagesService)\b/,
    );
    expect(roomFeature).not.toContain('@trinity/data-access/pinned');
    expect(
      existsSync(join(workspaceRoot, 'libs/data-access/pinned/project.json')),
    ).toBe(false);
    expect(main).toContain('provide: CONVERSATION_PIN_POLICY');
    expect(main).toContain('inject(RoomPinGovernanceService)');
    expect(threadAdapter).not.toMatch(
      /^\s{2}(?:open|openThread|sendMediaToThread|toggleReactionInThread|redactInThread|retryInThread)\s*\(/m,
    );
    expect(threadAdapter).not.toContain('.sendReadReceipt(');
  });
});
