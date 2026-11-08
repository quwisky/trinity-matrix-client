import { TestBed } from '@angular/core/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem } from '@capacitor/filesystem';
import { DraftStoreService } from './draft-store.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { LibraryNoCloud: 'LIBRARY_NO_CLOUD' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { readFile: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;
const remove = Preferences.remove as unknown as Mock;
const KEY = 'trinity.composer.drafts';

describe('DraftStoreService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  function service(): DraftStoreService {
    TestBed.configureTestingModule({ providers: [DraftStoreService] });
    return TestBed.inject(DraftStoreService);
  }

  describe('on iOS', () => {
    const readFile = Filesystem.readFile as unknown as Mock;
    const writeFile = Filesystem.writeFile as unknown as Mock;
    const deleteFile = Filesystem.deleteFile as unknown as Mock;
    const FILE = {
      path: 'composer-drafts.json',
      directory: 'LIBRARY_NO_CLOUD',
      encoding: 'utf8',
    };

    beforeEach(() => {
      vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
      readFile.mockReset().mockRejectedValue(new Error('File does not exist'));
      writeFile.mockReset().mockResolvedValue({ uri: 'file://drafts' });
      deleteFile.mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('keeps drafts in a file left out of backups, not in Preferences', async () => {
      const svc = service();
      await svc.init();
      svc.set('!a:hs', 'secret plans');
      await vi.advanceTimersByTimeAsync(400);

      expect(writeFile).toHaveBeenCalledWith({
        ...FILE,
        recursive: true,
        data: JSON.stringify({ '!a:hs': 'secret plans' }),
      });
      expect(set).not.toHaveBeenCalled();
    });

    it('reads the drafts back from that file', async () => {
      readFile.mockResolvedValue({ data: JSON.stringify({ '!a:hs': 'kept' }) });
      const svc = service();
      await svc.init();

      expect(readFile).toHaveBeenCalledWith(FILE);
      expect(svc.get('!a:hs')).toBe('kept');
    });

    it('moves drafts saved in Preferences into the file once, then removes them there', async () => {
      get.mockResolvedValue({
        value: JSON.stringify({ '!a:hs': 'old', '!b:hs': 'only here' }),
      });
      readFile.mockResolvedValue({
        data: JSON.stringify({ '!a:hs': 'newer' }),
      });
      const svc = service();
      await svc.init();

      expect(svc.get('!a:hs')).toBe('newer');
      expect(svc.get('!b:hs')).toBe('only here');
      expect(writeFile).toHaveBeenCalledWith({
        ...FILE,
        recursive: true,
        data: JSON.stringify({ '!a:hs': 'newer', '!b:hs': 'only here' }),
      });
      expect(remove).toHaveBeenCalledWith({ key: KEY });
    });

    it('keeps the Preferences drafts when the file cannot be written', async () => {
      get.mockResolvedValue({ value: JSON.stringify({ '!a:hs': 'old' }) });
      writeFile.mockRejectedValue(new Error('disk full'));
      const svc = service();
      await svc.init();

      expect(svc.get('!a:hs')).toBe('old');
      expect(remove).not.toHaveBeenCalled();
    });

    it('drops the Preferences copy at the first later write, so a sent draft stays gone', async () => {
      get.mockResolvedValue({ value: JSON.stringify({ '!a:hs': 'old' }) });
      writeFile.mockRejectedValueOnce(new Error('disk full'));
      const svc = service();
      await svc.init();
      expect(remove).not.toHaveBeenCalled();

      svc.clear('!a:hs'); // sent
      await vi.advanceTimersByTimeAsync(400);

      expect(writeFile).toHaveBeenLastCalledWith({
        ...FILE,
        recursive: true,
        data: '{}',
      });
      expect(remove).toHaveBeenCalledWith({ key: KEY });
    });

    it('deletes the file, and any drafts left in Preferences, on sign-out', async () => {
      const svc = service();
      await svc.init();
      svc.clearAll();
      await vi.advanceTimersByTimeAsync(0);

      expect(deleteFile).toHaveBeenCalledWith({
        path: FILE.path,
        directory: FILE.directory,
      });
      expect(remove).toHaveBeenCalledWith({ key: KEY });
    });
  });

  it('returns an empty draft for an unknown conversation', () => {
    expect(service().get('!a:hs')).toBe('');
  });

  it('stores and reads back a draft', () => {
    const svc = service();
    svc.set('!a:hs', 'half a message');
    expect(svc.get('!a:hs')).toBe('half a message');
    expect(svc.get('!b:hs')).toBe(''); // isolated per conversation
  });

  it('drops the draft when set to blank', () => {
    const svc = service();
    svc.set('!a:hs', 'text');
    svc.set('!a:hs', '   ');
    expect(svc.get('!a:hs')).toBe('');
  });

  it('clears a draft', () => {
    const svc = service();
    svc.set('!a:hs', 'text');
    svc.clear('!a:hs');
    expect(svc.get('!a:hs')).toBe('');
  });

  // L1: drafts are plaintext for E2EE rooms, so sign-out must not leave them behind.
  describe('clearAll', () => {
    it('empties the map and removes the persisted key', () => {
      const svc = service();
      svc.set('!a:hs', 'half a message');

      svc.clearAll();

      expect(svc.get('!a:hs')).toBe('');
      expect(remove).toHaveBeenCalledWith({ key: KEY });
    });

    it('cancels the pending write, so nothing is re-persisted after the wipe', () => {
      const svc = service();
      svc.set('!a:hs', 'half a message'); // arms the 400ms debounce

      svc.clearAll();
      vi.advanceTimersByTime(1000);

      expect(set).not.toHaveBeenCalled();
    });

    it('survives a Preferences.remove that does not return a promise', () => {
      remove.mockReturnValue(undefined); // a torn-down module hands this back
      const svc = service();

      expect(() => svc.clearAll()).not.toThrow();
    });
  });

  describe('a message the homeserver does not have yet', () => {
    const ROOM = 'conversation:a';
    const THREAD = '$thread-root';

    /** What this store wrote last, handed to a new store as a reloaded page reads it. */
    async function reload(): Promise<DraftStoreService> {
      await vi.advanceTimersByTimeAsync(400);
      get.mockResolvedValue({ value: set.mock.lastCall?.[0].value ?? null });
      const next = new DraftStoreService();
      await next.init();
      return next;
    }

    it('keeps a conversation message by txn id, never in the draft, across a reload', async () => {
      const svc = service();
      await svc.init();
      svc.set(ROOM, 'typed since');
      const content = { msgtype: 'm.text', body: 'sent' };

      svc.holdWaiting(ROOM, 'txn-1', { body: 'sent', content });
      expect(svc.get(ROOM)).toBe('typed since');

      const reloaded = await reload();
      expect(reloaded.get(ROOM)).toBe('typed since');
      expect([...reloaded.pendingMessages(ROOM)]).toEqual([
        ['txn-1', { body: 'sent', content }],
      ]);
    });

    /** The map the store wrote last. */
    const lastWrite = () =>
      JSON.parse(set.mock.lastCall?.[0].value) as Record<string, string>;

    it('writes a held message and its cleared draft at once, not after the debounce', async () => {
      const svc = service();
      await svc.init();
      svc.set(ROOM, 'sent at once');
      svc.set(ROOM, '');
      set.mockClear();

      svc.holdWaiting(ROOM, 'txn-1', { body: 'sent at once' });
      await vi.advanceTimersByTimeAsync(0);

      expect(lastWrite()[ROOM]).toBeUndefined();
      expect(JSON.parse(lastWrite()[`pending:${ROOM}`])).toEqual({
        'txn-1': { body: 'sent at once' },
      });
    });

    it('writes a release at once, so a reload right after the send shows nothing failed', async () => {
      const svc = service();
      await svc.init();
      svc.holdWaiting(ROOM, 'txn-1', { body: 'went out' });
      await vi.advanceTimersByTimeAsync(0);
      set.mockClear();

      svc.releaseWaiting(ROOM, 'txn-1');
      await vi.advanceTimersByTimeAsync(0);

      expect(set).toHaveBeenCalled();
      expect(lastWrite()[`pending:${ROOM}`]).toBeUndefined();
    });

    it('stores held messages under a key an older build leaves alone', async () => {
      const svc = service();
      await svc.init();

      svc.holdWaiting(ROOM, 'txn-1', { body: 'kept' });
      await vi.advanceTimersByTimeAsync(0);

      expect(lastWrite()[`waiting:${ROOM}`]).toBeUndefined();
      expect(typeof lastWrite()[`pending:${ROOM}`]).toBe('string');
    });

    it('writes one map at a time, each after the one before has landed', async () => {
      const svc = service();
      await svc.init();
      let land!: () => void;
      set.mockImplementationOnce(
        () => new Promise<void>((resolve) => (land = resolve)),
      );

      svc.holdWaiting(ROOM, 'txn-1', { body: 'first' });
      svc.holdWaiting(ROOM, 'txn-2', { body: 'second' });
      await vi.advanceTimersByTimeAsync(0);
      expect(set).toHaveBeenCalledOnce();

      land();
      await vi.advanceTimersByTimeAsync(0);
      expect(set).toHaveBeenCalledTimes(2);
      expect(Object.keys(JSON.parse(lastWrite()[`pending:${ROOM}`]))).toEqual([
        'txn-1',
        'txn-2',
      ]);
    });

    it('keeps writing after one write throws synchronously', async () => {
      const svc = service();
      await svc.init();
      let land!: () => void;
      set
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => (land = resolve)),
        )
        .mockImplementationOnce(() => {
          throw new Error('disk gone for a moment');
        });

      expect(() => {
        svc.holdWaiting(ROOM, 'txn-1', { body: 'first' });
        svc.holdWaiting(ROOM, 'txn-2', { body: 'second' });
        svc.holdWaiting(ROOM, 'txn-3', { body: 'third' });
      }).not.toThrow();
      land();
      await vi.advanceTimersByTimeAsync(0);

      expect(set).toHaveBeenCalledTimes(3);
      expect(Object.keys(JSON.parse(lastWrite()[`pending:${ROOM}`]))).toEqual([
        'txn-1',
        'txn-2',
        'txn-3',
      ]);
    });

    it('survives a write that throws synchronously when none is in flight', async () => {
      const svc = service();
      await svc.init();
      set.mockImplementationOnce(() => {
        throw new Error('disk gone for a moment');
      });

      expect(() =>
        svc.holdWaiting(ROOM, 'txn-1', { body: 'first' }),
      ).not.toThrow();
      svc.holdWaiting(ROOM, 'txn-2', { body: 'second' });
      await vi.advanceTimersByTimeAsync(0);

      expect(Object.keys(JSON.parse(lastWrite()[`pending:${ROOM}`]))).toEqual([
        'txn-1',
        'txn-2',
      ]);
    });

    it('keeps messages apart per conversation', async () => {
      const svc = service();
      await svc.init();
      svc.holdWaiting(ROOM, 'txn-1', { body: 'mine' });

      expect(svc.pendingMessages('conversation:b').size).toBe(0);
    });

    it('migrates a body an older build kept for a conversation into a held message, leaving the draft alone', async () => {
      get.mockResolvedValue({
        value: JSON.stringify({
          [ROOM]: 'typed before the upgrade',
          [`waiting:${ROOM}`]: JSON.stringify({ 'txn-1': 'sent offline' }),
        }),
      });
      const svc = service();

      await svc.init();

      expect(svc.get(ROOM)).toBe('typed before the upgrade');
      expect([...svc.pendingMessages(ROOM)]).toEqual([
        ['txn-1', { body: 'sent offline' }],
      ]);
      expect(lastWrite()[`waiting:${ROOM}`]).toBeUndefined();
      expect(JSON.parse(lastWrite()[`pending:${ROOM}`])).toEqual({
        'txn-1': { body: 'sent offline' },
      });
    });

    it('puts a body an older build kept by message id back into the draft, never as a held message', async () => {
      get.mockResolvedValue({
        value: JSON.stringify({
          [ROOM]: 'typed',
          [`waiting:${ROOM}`]: JSON.stringify({
            '~!room:hs:m1.0': 'retried by echo id',
            $event: 'retried by event id',
          }),
        }),
      });
      const svc = service();

      await svc.init();

      expect(svc.pendingMessages(ROOM).size).toBe(0);
      expect(svc.get(ROOM)).toBe(
        'typed\n\nretried by echo id\n\nretried by event id',
      );
    });

    it('keeps a thread text out of the draft while the page lives', async () => {
      const svc = service();
      await svc.init();

      svc.holdWaiting(THREAD, 'txn-1', 'sent offline');

      expect(svc.get(THREAD)).toBe('');
    });

    it('puts a thread text back in its draft once after a reload, and drops the record', async () => {
      const svc = service();
      await svc.init();
      svc.holdWaiting(THREAD, 'txn-1', 'sent offline');

      const reloaded = await reload();
      expect(reloaded.get(THREAD)).toBe('sent offline');

      const again = await reload();
      expect(again.get(THREAD)).toBe('sent offline');
    });

    it('appends the recovered text after a draft the composer already holds', async () => {
      const svc = service();
      await svc.init();
      svc.set(THREAD, 'typed since');
      svc.holdWaiting(THREAD, 'txn-1', 'first');
      svc.holdWaiting(THREAD, 'txn-2', 'second');

      const reloaded = await reload();

      expect(reloaded.get(THREAD)).toBe('typed since\n\nfirst\n\nsecond');
    });

    it('does not add a text of several paragraphs that the draft already is', async () => {
      const svc = service();
      await svc.init();
      svc.set(THREAD, 'first part\n\nsecond part');
      svc.holdWaiting(THREAD, 'txn-1', 'first part\n\nsecond part');

      const reloaded = await reload();

      expect(reloaded.get(THREAD)).toBe('first part\n\nsecond part');
    });

    it('keeps a recovered draft when the stored drafts are over the cap, trimming older ones', async () => {
      const older = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `conversation:${i}`,
          `draft ${i}`,
        ]),
      );
      get.mockResolvedValue({
        value: JSON.stringify({
          [THREAD]: 'typed long ago',
          ...older,
          [`waiting:${THREAD}`]: JSON.stringify({ 'txn-1': 'sent offline' }),
        }),
      });
      const svc = service();

      await svc.init();

      const written = JSON.parse(set.mock.lastCall?.[0].value) as Record<
        string,
        string
      >;
      expect(written[THREAD]).toBe('typed long ago\n\nsent offline');
      expect(written['conversation:0']).toBeUndefined();
    });

    it('forgets a released message, so a reload brings nothing back', async () => {
      const svc = service();
      await svc.init();
      svc.holdWaiting(ROOM, 'txn-1', { body: 'went out' });
      svc.holdWaiting(ROOM, 'txn-2', { body: 'still waiting' });

      svc.releaseWaiting(ROOM, 'txn-1');
      const reloaded = await reload();

      expect([...reloaded.pendingMessages(ROOM).keys()]).toEqual(['txn-2']);
    });
  });

  it('loads persisted drafts on init', async () => {
    get.mockResolvedValue({
      value: JSON.stringify({ '!a:hs': 'saved draft', bad: 42 }),
    });
    const svc = service();

    await svc.init();

    expect(svc.get('!a:hs')).toBe('saved draft');
    expect(svc.get('bad')).toBe(''); // non-string entry ignored
  });

  it('starts empty when nothing (or corrupt data) is stored', async () => {
    get.mockResolvedValue({ value: 'not json' });
    const svc = service();

    await svc.init();

    expect(svc.get('!a:hs')).toBe('');
  });

  it('debounces persistence into a single coalesced write', () => {
    const svc = service();
    svc.set('!a:hs', 'a');
    svc.set('!a:hs', 'ab');
    svc.set('!b:hs', 'c');
    expect(set).not.toHaveBeenCalled(); // nothing written yet

    vi.advanceTimersByTime(400);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      key: KEY,
      value: JSON.stringify({ '!a:hs': 'ab', '!b:hs': 'c' }),
    });
  });

  // Issue #31. Both of these are about a debounced write outliving whatever asked for it.
  // Together they turned a green suite into a non-zero exit: the timer fired after the test
  // file's module was torn down, `Preferences.set` was no longer a promise, and `.catch` on
  // undefined threw out of a timer callback where nothing could catch it.
  describe('a pending write that outlives its caller', () => {
    it('does not fire after the injector is destroyed', () => {
      const svc = service();
      svc.set('!a:hs', 'half a message');

      TestBed.resetTestingModule(); // destroys the injector -> ngOnDestroy
      vi.advanceTimersByTime(1000);

      expect(set).not.toHaveBeenCalled();
    });

    it('survives a Preferences.set that does not return a promise', () => {
      // Exactly what a torn-down module hands back — and what used to crash the run.
      set.mockReturnValue(undefined);
      const svc = service();
      svc.set('!a:hs', 'half a message');

      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(set).toHaveBeenCalled();
    });

    it('still coalesces and writes normally when nothing is torn down', () => {
      const svc = service();
      svc.set('!a:hs', 'one');
      svc.set('!b:hs', 'two');
      vi.advanceTimersByTime(1000);

      expect(set).toHaveBeenCalledTimes(1);
      expect(JSON.parse(set.mock.calls[0][0].value)).toEqual({
        '!a:hs': 'one',
        '!b:hs': 'two',
      });
    });
  });

  it('writes the drafts at once on flush, without a second write after the debounce', async () => {
    const svc = service();
    await svc.init();
    svc.set('!a:hs', 'unsent');

    await svc.flush();

    expect(set).toHaveBeenCalledExactlyOnceWith({
      key: KEY,
      value: JSON.stringify({ '!a:hs': 'unsent' }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(set).toHaveBeenCalledOnce();
  });

  it('resolves flush even when storage refuses the write', async () => {
    set.mockRejectedValueOnce(new Error('quota'));
    const svc = service();
    await svc.init();
    svc.set('!a:hs', 'unsent');

    await expect(svc.flush()).resolves.toBeUndefined();
  });

  // A handover can land while startup is still loading the drafts (#1267).
  describe('before init has loaded the stored drafts', () => {
    it('does not write the empty map over them on flush', async () => {
      get.mockReturnValue(new Promise(() => undefined));
      const svc = service();
      void svc.init();

      await svc.flush();

      expect(set).not.toHaveBeenCalled();
      expect(svc.isInitialised()).toBe(false);
    });

    it('flushes once init has settled, even when nothing was stored', async () => {
      const svc = service();
      expect(svc.isInitialised()).toBe(false);

      await svc.init();
      await svc.flush();

      expect(svc.isInitialised()).toBe(true);
      expect(set).toHaveBeenCalledOnce();
    });
  });
});
