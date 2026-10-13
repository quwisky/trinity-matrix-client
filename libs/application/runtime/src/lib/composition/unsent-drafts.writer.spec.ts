import { TestBed } from '@angular/core/testing';
import type { PendingTextMessage } from '@trinity/data-access/matrix-client';
import { DraftStoreService } from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { UnsentDraftsWriter, unsentDraftKey } from './unsent-drafts.writer';

const ROOM_DRAFT = 'conversation:["@me:hs","!room:hs"]';

function unsent(
  text: string,
  threadRootId: string | null = null,
): PendingTextMessage {
  return { accountId: '@me:hs', roomId: '!room:hs', threadRootId, text };
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

    expect(unsentDraftKey(unsent('x', '$root'))).toBe('$root');
    expect(drafts.get('$root')).toBe('in the thread');
    expect(drafts.has(ROOM_DRAFT)).toBe(false);
  });

  it('does not add a text the draft already holds, as after a rejected send', async () => {
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

  it('still writes the drafts to storage when every message reached the server', async () => {
    // A draft typed in the last moments before a handover is still waiting for its debounce.
    const { writer, steps } = setup();

    await writer.writeBack([]);

    expect(steps).toEqual(['flush']);
  });
});
