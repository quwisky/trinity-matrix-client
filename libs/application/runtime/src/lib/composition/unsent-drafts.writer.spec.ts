import { TestBed } from '@angular/core/testing';
import type { PendingTextMessage } from '@trinity/data-access/matrix-client';
import { threadDraftKey } from '@trinity/data-access/timeline';
import { DraftStoreService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsentDraftsWriter, unsentDraftKey } from './unsent-drafts.writer';

const ROOM_DRAFT = 'conversation:["@me:hs","!room:hs"]';

/** Web storage as one page leaves it to the next. */
const stored = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: ({ key }: { key: string }) =>
      Promise.resolve({ value: stored.get(key) ?? null }),
    set: ({ key, value }: { key: string; value: string }) => {
      stored.set(key, value);
      return Promise.resolve();
    },
    remove: ({ key }: { key: string }) => {
      stored.delete(key);
      return Promise.resolve();
    },
  },
}));

function unsent(
  text: string,
  threadRootId: string | null = null,
  txnId?: string,
): PendingTextMessage {
  return { accountId: '@me:hs', roomId: '!room:hs', threadRootId, text, txnId };
}

function setup(initial: Record<string, string> = {}, initialised = true) {
  const drafts = new Map(Object.entries(initial));
  const steps: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      UnsentDraftsWriter,
      MockProvider(DraftStoreService, {
        isInitialised: () => initialised,
        get: (key: string) => drafts.get(key) ?? '',
        set: (key: string, text: string) => {
          steps.push(`set ${key}`);
          drafts.set(key, text);
        },
        flush: () => {
          steps.push('flush');
          return Promise.resolve();
        },
      }),
    ],
  });
  return { writer: TestBed.inject(UnsentDraftsWriter), drafts, steps };
}

describe('UnsentDraftsWriter', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('puts an unsent text into an empty room draft, then writes the drafts to storage', async () => {
    const { writer, drafts, steps } = setup();

    await writer.writeBack([unsent('see you')]);

    expect(drafts.get(ROOM_DRAFT)).toBe('see you');
    expect(steps).toEqual([`set ${ROOM_DRAFT}`, 'flush']);
  });

  it('leaves the drafts alone while the store has not loaded them yet', async () => {
    const { writer, drafts, steps } = setup({}, false);

    await writer.writeBack([unsent('see you')]);

    expect(drafts.size).toBe(0);
    expect(steps).toEqual([]);
  });

  it('joins an unsent text after an existing draft with a blank line, never overwriting it', async () => {
    const { writer, drafts } = setup({ [ROOM_DRAFT]: 'half typed\n' });

    await writer.writeBack([unsent('see you')]);

    expect(drafts.get(ROOM_DRAFT)).toBe('half typed\n\nsee you');
  });

  it('joins two unsent texts of one room in the order they were sent', async () => {
    const { writer, drafts } = setup();

    await writer.writeBack([unsent('first'), unsent('second')]);

    expect(drafts.get(ROOM_DRAFT)).toBe('first\n\nsecond');
  });

  it('puts a thread reply into its thread draft, keyed by the thread root', async () => {
    const { writer, drafts } = setup();

    await writer.writeBack([unsent('in the thread', '$root')]);

    expect(unsentDraftKey(unsent('x', '$root'))).toBe(threadDraftKey('$root'));
    expect(drafts.get(threadDraftKey('$root'))).toBe('in the thread');
    expect(drafts.has(ROOM_DRAFT)).toBe(false);
  });

  it('does not add a text the draft already holds', async () => {
    const { writer, drafts, steps } = setup({ [ROOM_DRAFT]: 'see you' });

    await writer.writeBack([unsent('see you')]);

    expect(drafts.get(ROOM_DRAFT)).toBe('see you');
    expect(steps).toEqual(['flush']);
  });

  it('keeps a short text that appears inside a longer draft', async () => {
    const { writer, drafts } = setup({
      [ROOM_DRAFT]: 'looks ok to me\n\nsee you',
    });

    await writer.writeBack([unsent('ok'), unsent('see you')]);

    expect(drafts.get(ROOM_DRAFT)).toBe('looks ok to me\n\nsee you\n\nok');
  });

  it('keeps a room message by its txn id, and releases a thread reply it puts in the draft', async () => {
    const { writer, drafts } = setup({ [ROOM_DRAFT]: 'typed' });
    const store = TestBed.inject(DraftStoreService);
    const hold = vi.spyOn(store, 'holdWaiting');
    const release = vi.spyOn(store, 'releaseWaiting');
    vi.spyOn(store, 'pendingMessages').mockReturnValue(new Map());

    await writer.writeBack([
      unsent('see you', null, 'txn-1'),
      unsent('in the thread', '$root', 'txn-2'),
    ]);

    expect(hold.mock.calls).toEqual([
      [ROOM_DRAFT, 'txn-1', { body: 'see you' }],
    ]);
    expect(release.mock.calls).toEqual([[threadDraftKey('$root'), 'txn-2']]);
    expect(drafts.get(ROOM_DRAFT)).toBe('typed');
  });

  it('shows a room message held at send as a held message after a handover and a reload, never in the box', async () => {
    stored.clear();
    const page = new DraftStoreService();
    await page.init();
    const content = { msgtype: 'm.text', body: 'hi ¯\\_(ツ)_/¯' };
    page.holdWaiting(ROOM_DRAFT, 'txn-1', { body: '/shrug hi', content });
    TestBed.configureTestingModule({
      providers: [
        UnsentDraftsWriter,
        { provide: DraftStoreService, useValue: page },
      ],
    });

    await TestBed.inject(UnsentDraftsWriter).writeBack([
      unsent('hi ¯\\_(ツ)_/¯', null, 'txn-1'),
    ]);
    const reloaded = new DraftStoreService();
    await reloaded.init();

    expect(reloaded.get(ROOM_DRAFT)).toBe('');
    expect([...reloaded.pendingMessages(ROOM_DRAFT)]).toEqual([
      ['txn-1', { body: '/shrug hi', content }],
    ]);
  });

  it('still writes the drafts to storage when every message reached the server', async () => {
    // A draft typed in the last moments before a handover is still waiting for its debounce.
    const { writer, steps } = setup();

    await writer.writeBack([]);

    expect(steps).toEqual(['flush']);
  });
});
