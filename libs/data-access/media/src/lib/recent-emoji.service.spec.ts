import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SESSION_SNAPSHOT } from '@trinity/data-access/matrix-client';
import { engineFail, engineOk } from '@trinity/util/matrix';
import { from, of, switchMap } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExpressionEngine } from '../contract/fake-expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import { sessionWith } from './media.spec-harness';
import {
  ELEMENT_RECENT_EMOJI_EVENT_TYPE,
  RECENT_EMOJI_EVENT_TYPE,
  RecentEmojiService,
  UNSTABLE_RECENT_EMOJI_EVENT_TYPE,
} from './recent-emoji.service';

type Content = Record<string, unknown>;

function setup(
  local: Record<string, Content> = {},
  { connected = true }: { connected?: boolean } = {},
) {
  const engine = new FakeExpressionEngine();
  const alice = engine.alice;
  // Bound before the spy, so another device's writes are not counted as this one's.
  const remote = engine.setAccountData.bind(engine);
  for (const [type, content] of Object.entries(local)) {
    remote(alice, type, structuredClone(content)).subscribe();
  }
  const write = vi.spyOn(engine, 'setAccountData');
  const fetch = vi.spyOn(engine, 'fetchAccountData');
  const session = signal(sessionWith(alice, [alice, '@bob:fake']));
  TestBed.configureTestingModule({
    providers: [
      { provide: EXPRESSION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const service = TestBed.inject(RecentEmojiService);
  const lifetime = connected ? service.run().subscribe() : null;
  TestBed.tick();
  /** The account's copy of `type`, as the server holds it. */
  const server = (type: string): Content | undefined => {
    let content: unknown = null;
    engine
      .accountData(alice, [type])
      .subscribe((snapshot) => (content = snapshot[type]))
      .unsubscribe();
    return (content ?? undefined) as Content | undefined;
  };
  /** Another device's write, as sync delivers it. */
  const sync = async (type: string, content: Content) => {
    remote(alice, type, content).subscribe();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  };
  /** Hold the next write until the returned function lets it run. */
  const holdWrite = (): (() => void) => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    write.mockImplementationOnce((accountId, type, content) =>
      from(gate).pipe(switchMap(() => remote(accountId, type, content))),
    );
    return () => open();
  };
  return {
    service,
    engine,
    alice,
    session,
    write,
    fetch,
    server,
    sync,
    holdWrite,
    lifetime,
  };
}

const stable = (...entries: [string, number][]) => ({
  recent_emoji: entries.map(([emoji, total]) => ({ emoji, total })),
});

const parseRecent = (content: Content | undefined) =>
  ((content?.['recent_emoji'] ?? []) as { emoji: string; total: number }[]).map(
    ({ emoji }) => emoji,
  );

async function settle(ms = 2_000) {
  await vi.advanceTimersByTimeAsync(ms);
  TestBed.tick();
}

describe('RecentEmojiService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is empty without recent emoji account data', () => {
    const { service } = setup();

    expect(service.recent()).toEqual([]);
  });

  it('shows the 24 most recent emoji, stably sorted by how often each was used', () => {
    const entries: [string, number][] = [
      ['😀', 1],
      ['🎉', 3],
      ['👍', 1],
      ['❤️', 3],
    ];
    for (let index = 0; index < 30; index += 1) {
      entries.push([String.fromCodePoint(0x1f400 + index), 9]);
    }
    const { service } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(...entries),
    });

    const recent = service.recent();
    expect(recent).toHaveLength(24);
    expect(recent.slice(0, 20)).toEqual(
      entries.slice(4, 24).map(([emoji]) => emoji),
    );
    expect(recent.slice(20)).toEqual(['🎉', '❤️', '😀', '👍']);
  });

  it('leaves out entries it cannot show and entries that are not valid', () => {
    const { service } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: {
        recent_emoji: [
          { emoji: 'mxc://hs/party', total: 5 },
          { emoji: '', total: 1 },
          { emoji: '😀', total: 0 },
          { emoji: '🎉', total: 1.5 },
          { emoji: 42, total: 1 },
          'nope',
          { emoji: '👍', total: 2 },
        ],
      },
    });

    expect(service.recent()).toEqual(['👍']);
  });

  it('starts from the unstable type when the stable one is absent', () => {
    const { service } = setup({
      [UNSTABLE_RECENT_EMOJI_EVENT_TYPE]: stable(['🙂', 1]),
      [ELEMENT_RECENT_EMOJI_EVENT_TYPE]: { recent_emoji: [['😀', 1]] },
    });

    expect(service.recent()).toEqual(['🙂']);
  });

  it("starts from Element's recent emoji when neither MSC type is present", () => {
    const { service } = setup({
      [ELEMENT_RECENT_EMOJI_EVENT_TYPE]: {
        recent_emoji: [['😀', 2], ['🎉', 5], ['bad']],
      },
    });

    expect(service.recent()).toEqual(['🎉', '😀']);
  });

  it('prefers the stable type over both seeds', () => {
    const { service } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1]),
      [UNSTABLE_RECENT_EMOJI_EVENT_TYPE]: stable(['🙂', 1]),
      [ELEMENT_RECENT_EMOJI_EVENT_TYPE]: { recent_emoji: [['😀', 1]] },
    });

    expect(service.recent()).toEqual(['👍']);
  });

  it('saves a pick made while nothing keeps the projection open', async () => {
    const { service, write, alice } = setup(
      { [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1]) },
      { connected: false },
    );

    service.record('🎉');
    await settle();

    expect(write).toHaveBeenCalledWith(
      alice,
      RECENT_EMOJI_EVENT_TYPE,
      stable(['🎉', 1], ['👍', 1]),
    );
  });

  it('puts a pick first at once, counting it', () => {
    const { service } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1], ['🎉', 1]),
    });

    service.record('🎉');
    service.record('😀');

    expect(service.recent()).toEqual(['🎉', '😀', '👍']);
  });

  it('writes a burst of picks once, about two seconds after the last', async () => {
    const { service, write, alice } = setup();

    service.record('😀');
    await settle(1_500);
    service.record('🎉');
    await settle(1_500);
    expect(write).not.toHaveBeenCalled();

    await settle(500);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      alice,
      RECENT_EMOJI_EVENT_TYPE,
      stable(['🎉', 1], ['😀', 1]),
    );
  });

  it("merges into the server's copy, keeping custom emoji and dropping invalid entries", async () => {
    const { service, server, fetch } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1]),
    });
    // Another device wrote since the last sync.
    fetch.mockReturnValueOnce(
      of(
        engineOk({
          recent_emoji: [
            { emoji: 'mxc://hs/party', total: 4 },
            { emoji: '😀', total: 2 },
            { emoji: '', total: 1 },
            { emoji: '👍', total: 1 },
          ],
        }),
      ),
    );

    service.record('😀');
    await settle();

    expect(server(RECENT_EMOJI_EVENT_TYPE)).toEqual(
      stable(['😀', 3], ['mxc://hs/party', 4], ['👍', 1]),
    );
  });

  it('writes only the stable type when it starts from a seed', async () => {
    const { service, write, alice } = setup({
      [ELEMENT_RECENT_EMOJI_EVENT_TYPE]: { recent_emoji: [['😀', 2]] },
    });

    service.record('🎉');
    await settle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      alice,
      RECENT_EMOJI_EVENT_TYPE,
      stable(['🎉', 1], ['😀', 2]),
    );
  });

  it('keeps at most 100 entries', async () => {
    const entries: [string, number][] = Array.from({ length: 100 }, (_, i) => [
      String.fromCodePoint(0x1f400 + i),
      1,
    ]);
    const { service, server } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(...entries),
    });

    service.record('😀');
    await settle();

    const written = server(RECENT_EMOJI_EVENT_TYPE)?.['recent_emoji'];
    expect(written).toHaveLength(100);
    expect(written).toContainEqual({ emoji: '😀', total: 1 });
    expect(written).not.toContainEqual({
      emoji: String.fromCodePoint(0x1f400 + 99),
      total: 1,
    });
  });

  it('keeps picks that failed to save and writes them with the next burst', async () => {
    const { service, write, server } = setup();
    write.mockReturnValueOnce(
      of(
        engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        }),
      ),
    );

    service.record('😀');
    await settle();
    expect(service.recent()).toEqual(['😀']);

    service.record('🎉');
    await settle();

    expect(server(RECENT_EMOJI_EVENT_TYPE)).toEqual(
      stable(['🎉', 1], ['😀', 1]),
    );
  });

  it('waits for a write in flight, then writes on top of it', async () => {
    const { service, write, alice, holdWrite } = setup();
    const release = holdWrite();

    service.record('😀');
    await settle();
    service.record('🎉');
    await settle();
    expect(write).toHaveBeenCalledTimes(1);

    release();
    await settle(0);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      alice,
      RECENT_EMOJI_EVENT_TYPE,
      stable(['🎉', 1], ['😀', 1]),
    );
  });

  it('shows a sync that lands while a write is in flight, then what the server holds', async () => {
    const { service, server, sync, holdWrite } = setup();
    const release = holdWrite();
    service.record('😀');
    await settle();

    await sync(RECENT_EMOJI_EVENT_TYPE, stable(['👋', 1]));
    expect(service.recent()).toEqual(['😀', '👋']);

    release();
    await settle(0);

    // Account data has no compare-and-set: the write read the server before the other
    // device's, so its pick is overwritten there, and this device follows the server.
    expect(service.recent()).toEqual(
      parseRecent(server(RECENT_EMOJI_EVENT_TYPE)),
    );
  });

  it('gives no slot to text that is not an emoji', () => {
    const { service } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(
        ['hello', 9],
        ['👍', 1],
        ['🇫🇷', 1],
        ['1️⃣', 1],
      ),
    });

    expect(service.recent()).toEqual(['👍', '🇫🇷', '1️⃣']);
  });

  it("follows another device's picks as they sync", async () => {
    const { service, sync } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1]),
    });

    await sync(RECENT_EMOJI_EVENT_TYPE, stable(['🎉', 1], ['👍', 1]));

    expect(service.recent()).toEqual(['🎉', '👍']);
  });

  it('follows the active account, and saves a pick on the account it was made on', async () => {
    const { service, write, alice, session } = setup({
      [RECENT_EMOJI_EVENT_TYPE]: stable(['👍', 1]),
    });

    service.record('🎉');
    session.set(sessionWith('@bob:fake', [alice, '@bob:fake']));
    await settle(0);
    expect(service.recent()).toEqual([]);

    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      alice,
      RECENT_EMOJI_EVENT_TYPE,
      stable(['🎉', 1], ['👍', 1]),
    );
  });
});
