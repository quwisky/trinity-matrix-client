import { TestBed } from '@angular/core/testing';
import { BUILD_INFO, type BuildInfo } from '@trinity/platform-native';
import {
  PREFERENCE_STORAGE_ADAPTER,
  PreferenceStoreService,
  type PreferenceStorageAdapter,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import { Subject, firstValueFrom, of, throwError, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  type DiagnosticEntry,
} from './diagnostic-entry.model';
import { FLUSH_DELAY_MS } from './diagnostic-log-recorder';
import {
  DIAGNOSTIC_ACCOUNT_SOURCE,
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_LOG_STORE_REMOVER,
  DIAGNOSTIC_SDK_CAPTURE,
} from './diagnostic-log.tokens';
import {
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
  MAX_EARLY_ENTRIES,
} from './diagnostic-log.service';
import type { DiagnosticReportProgress } from './report/prepare-report';
import {
  MemoryLogStore,
  type DiagnosticLogStore,
} from './store/diagnostic-log-store';

const BUILD: BuildInfo = { version: '1.2.3', commit: 'abc1234', builtAt: '' };
/** "Keep a diagnostic log" stored as off, as the preference runtime writes it. */
const KEEP_LOG_OFF = JSON.stringify({ version: 1, value: false });

describe('DiagnosticLogService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let store: MemoryLogStore;
  let storedSetting: string | null;
  let remove: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** The app's switch for SDK debug capture; records every call in order. */
  let setSdkCapture: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;

  /** Installation preference storage holding only "Keep a diagnostic log". */
  function preferenceAdapter(): PreferenceStorageAdapter {
    return {
      read: () =>
        of(
          storedSetting === null
            ? ({ kind: 'missing' } as const)
            : ({ kind: 'found', payload: storedSetting } as const),
        ),
      write: (request) => {
        storedSetting = request.payload;
        return of({ kind: 'completed' } as const);
      },
    };
  }

  function setup(
    openStore: () => Promise<DiagnosticLogStore> = () => Promise.resolve(store),
    adapter: PreferenceStorageAdapter = preferenceAdapter(),
  ): DiagnosticLogService {
    TestBed.configureTestingModule({
      providers: [
        { provide: BUILD_INFO, useValue: BUILD },
        { provide: DIAGNOSTIC_LOG_STORE_FACTORY, useValue: openStore },
        { provide: DIAGNOSTIC_LOG_STORE_REMOVER, useValue: remove },
        { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
        {
          provide: DIAGNOSTIC_SDK_CAPTURE,
          useValue: { setEnabled: setSdkCapture },
        },
      ],
    });
    const service = TestBed.inject(DiagnosticLogService);
    service.start();
    return service;
  }

  /** Preference storage whose read answers only when the test says so. */
  function pendingAdapter(
    reads: Subject<PreferenceStorageReadOutcome>,
  ): PreferenceStorageAdapter {
    return { read: () => reads, write: preferenceAdapter().write };
  }

  /** Neither deleting nor emptying the stored log works. */
  function makeLogUndeletable(): void {
    remove.mockRejectedValue(new Error('delete blocked'));
    vi.spyOn(store, 'clear').mockRejectedValue(new Error('read-only'));
  }

  async function stored(): Promise<readonly DiagnosticEntry[]> {
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    return (await store.read()).entries;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Installed before start() so the capture wraps the spy, and test output stays quiet.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store = new MemoryLogStore();
    storedSetting = null;
    // Deleting the database, emulated on the memory store the factory hands out.
    remove = vi.fn(() => store.clear());
    setSdkCapture = vi.fn();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks the app start with the version and platform', async () => {
    setup();

    const [first] = await stored();

    expect(first).toMatchObject({
      level: 'info',
      source: 'app',
      logger: 'lifecycle',
    });
    expect(first.message).toMatch(
      /^app started: Trinity v1\.2\.3 · abc1234 on /,
    );
  });

  it('stores console warnings, scrubbed, and still prints them', async () => {
    setup();

    console.warn('[trinity] refresh failed', { access_token: 'secret-value' });
    const entries = await stored();

    expect(warn).toHaveBeenCalledWith('[trinity] refresh failed', {
      access_token: 'secret-value',
    });
    expect(entries.at(-1)).toMatchObject({
      level: 'warn',
      source: 'console',
      logger: 'trinity',
      message: '[trinity] refresh failed {"access_token":"<redacted>"}',
    });
  });

  it('stores uncaught errors and unhandled rejections', async () => {
    setup();

    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }),
    );
    const rejection = new Event('unhandledrejection');
    Object.assign(rejection, { reason: new Error('rejected') });
    window.dispatchEvent(rejection);
    const entries = await stored();

    expect(
      entries
        .filter((entry) => entry.source === 'window')
        .map((entry) => [entry.logger, entry.message.split('\n')[0]]),
    ).toEqual([
      ['error', 'Error: boom'],
      ['unhandledrejection', 'Error: rejected'],
    ]);
  });

  it('stores SDK lines under their logger name', async () => {
    const service = setup();

    service.recordSdk({
      method: 'debug',
      logger: 'matrix-[RoomStickyEvents]',
      args: ['Got remote echo', 42],
    });
    const entries = await stored();

    expect(entries.at(-1)).toMatchObject({
      level: 'debug',
      source: 'sdk',
      logger: 'matrix-[RoomStickyEvents]',
      message: 'Got remote echo 42',
    });
  });

  it('stores an SDK warning once even though it is also printed to the console', async () => {
    const service = setup();

    service.recordSdk({ method: 'warn', logger: 'matrix', args: ['sdk warn'] });
    service.withoutConsoleCapture(() => console.warn('sdk warn'));
    const entries = await stored();

    expect(
      entries.filter((entry) => entry.message === 'sdk warn'),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('sdk warn');
  });

  it('writes the buffer when the page is hidden or closed', async () => {
    setup();

    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(async () =>
      expect(
        (await store.read()).entries.map((entry) => entry.message),
      ).toContain('app shutting down (page hidden)'),
    );

    const service = TestBed.inject(DiagnosticLogService);
    service.record({
      level: 'info',
      source: 'app',
      logger: 'test',
      message: 'before hiding',
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(async () =>
        expect(
          (await store.read()).entries.map((entry) => entry.message),
        ).toContain('before hiding'),
      );
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('reports memory-only storage when IndexedDB cannot be used', async () => {
    const service = setup(() => Promise.reject(new Error('private browsing')));
    expect(service.available()).toBe('pending');

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(service.available()).toBe('memory-only');
  });

  it('clears the log', async () => {
    const service = setup();
    await stored();

    await firstValueFrom(service.clear());

    expect((await store.read()).entries).toEqual([]);
  });

  it('gives the console back when the application is destroyed', () => {
    setup();

    TestBed.resetTestingModule();

    expect(console.warn).toBe(warn);
  });

  it('replaces a value it cannot format with <redacted>', async () => {
    setup();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no reading');
        },
      },
    );

    console.warn('[trinity] odd value', hostile);
    const entries = await stored();

    expect(entries.at(-1)?.message).toBe('[trinity] odd value <redacted>');
  });

  it('scrubs before cutting a message to length, so no secret is cut in half and kept', async () => {
    const service = setup();
    // The password value straddles MAX_MESSAGE_LENGTH: cutting first would keep "hunter2hu".
    const padding = 'a '.repeat((MAX_MESSAGE_LENGTH - 22) / 2);

    service.record({
      level: 'warn',
      source: 'console',
      logger: 'trinity',
      message: `${padding}{"password":"hunter2hunter2"}`,
    });
    const entries = await stored();

    expect(entries.at(-1)?.message).not.toContain('hunter');
  });

  it('stores an SDK line as it was logged, even if the SDK reuses the arguments', async () => {
    const service = setup();
    const args: unknown[] = ['Sending to', { room: '!a:b' }];

    service.recordSdk({ method: 'debug', logger: 'matrix', args });
    args[0] = 'password=hunter2';
    (args[1] as { room: string }).room = 'changed';
    args.push('later');
    const entries = await stored();

    expect(entries.at(-1)?.message).toBe('Sending to {"room":"!a:b"}');
  });

  it('scrubs the logger name as well as the message', async () => {
    const service = setup();

    service.recordSdk({
      method: 'debug',
      logger: 'matrix-[/sync?access_token=syt_c2VjcmV0_abcdef]',
      args: ['tick'],
    });
    const entries = await stored();

    expect(entries.at(-1)?.logger).not.toContain('syt_');
  });

  it('holds lines, scrubbed and bounded, until the setting is read', async () => {
    const reads = new Subject<PreferenceStorageReadOutcome>();
    const service = setup(undefined, pendingAdapter(reads));
    for (let index = 0; index < MAX_EARLY_ENTRIES + 10; index += 1) {
      service.record({
        level: 'info',
        source: 'app',
        logger: 'test',
        message: `line ${index} {"password":"secret-${index}"}`,
      });
    }

    expect(await stored()).toEqual([]);

    reads.next({ kind: 'missing' });
    reads.complete();
    const messages = (await stored()).map((entry) => entry.message);

    expect(messages).toHaveLength(MAX_EARLY_ENTRIES);
    expect(messages[0]).toMatch(/^line 10 /);
    expect(messages.join('\n')).not.toContain('secret-');
  });

  describe('Keep a diagnostic log', () => {
    it('records nothing, and deletes the stored log, when the setting is off at start', async () => {
      storedSetting = KEEP_LOG_OFF;
      const service = setup();

      console.warn('[trinity] while off');
      service.recordSdk({
        method: 'debug',
        logger: 'matrix',
        args: ['sdk while off'],
      });
      window.dispatchEvent(new Event('pagehide'));

      expect(service.keepLog()).toBe(false);
      expect(setSdkCapture).toHaveBeenCalledWith(false);
      expect(await stored()).toEqual([]);
      expect(remove).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[trinity] while off');
    });

    it('stops recording at once when turned off: drops the batch, deletes the log, keeps printing', async () => {
      const service = setup();
      expect(await stored()).not.toEqual([]);
      service.record({
        level: 'info',
        source: 'app',
        logger: 'test',
        message: 'pending',
      });

      const turnedOff = firstValueFrom(service.setKeepLog(false));
      // Synchronously, before the store is touched: the SDK is back at the console level.
      expect(setSdkCapture.mock.calls).toEqual([[false]]);
      expect(remove).not.toHaveBeenCalled();
      await turnedOff;
      console.warn('[trinity] after turning off');
      window.dispatchEvent(new Event('pagehide'));

      expect(service.keepLog()).toBe(false);
      expect(await stored()).toEqual([]);
      expect(remove).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[trinity] after turning off');
      expect(storedSetting).toBe(KEEP_LOG_OFF);
    });

    it('starts a fresh log when turned on again', async () => {
      storedSetting = KEEP_LOG_OFF;
      const service = setup();

      const outcome = await firstValueFrom(service.setKeepLog(true));
      const entries = await stored();

      expect(outcome).toEqual({ kind: 'completed' });
      expect(service.keepLog()).toBe(true);
      expect(setSdkCapture.mock.calls).toEqual([[false], [true]]);
      expect(entries.map((entry) => entry.message)).toEqual([
        expect.stringMatching(
          /^diagnostic log turned on: Trinity v1\.2\.3 · abc1234 on /,
        ),
      ]);
    });

    it('records nothing for the session when the setting cannot be read, and keeps the stored log', async () => {
      await store.append(
        [
          {
            ts: Date.now(),
            level: 'info',
            source: 'app',
            logger: 'lifecycle',
            message: 'from an earlier session',
          },
        ],
        Date.now(),
      );
      const service = setup(undefined, {
        read: () =>
          of({
            kind: 'unavailable',
            diagnostic: { code: 'storage-down' },
          } as const),
        write: () => of({ kind: 'completed' } as const),
      });

      service.record({
        level: 'warn',
        source: 'app',
        logger: 'test',
        message: 'after',
      });
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(service.keepLog()).toBe(false);
      expect(setSdkCapture).toHaveBeenCalledWith(false);
      expect((await stored()).map((entry) => entry.message)).toEqual([
        'from an earlier session',
      ]);
    });

    it('knows the setting once a stored "off" is read, though no store is ever opened', async () => {
      storedSetting = KEEP_LOG_OFF;
      const service = setup();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(service.settingKnown()).toBe(true);
      expect(service.keepLog()).toBe(false);
      expect(service.available()).toBe('pending');
    });

    it('knows the setting, as off, when it cannot be read', async () => {
      const service = setup(undefined, {
        read: () =>
          of({
            kind: 'unavailable',
            diagnostic: { code: 'storage-down' },
          } as const),
        write: () => of({ kind: 'completed' } as const),
      });
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(service.settingKnown()).toBe(true);
      expect(service.keepLog()).toBe(false);
      expect(service.available()).toBe('pending');
    });

    it('does not know the setting while it is still being read, until the user chooses', async () => {
      const reads = new Subject<PreferenceStorageReadOutcome>();
      const service = setup(undefined, pendingAdapter(reads));

      expect(service.settingKnown()).toBe(false);
      await firstValueFrom(service.setKeepLog(true));

      expect(service.settingKnown()).toBe(true);
    });

    it('keeps a choice made while the setting is still being read', async () => {
      const reads = new Subject<PreferenceStorageReadOutcome>();
      const service = setup(undefined, pendingAdapter(reads));

      await firstValueFrom(service.setKeepLog(false));
      reads.next({
        kind: 'found',
        payload: JSON.stringify({ version: 1, value: true }),
      });
      reads.complete();
      console.warn('[trinity] after choosing off');

      expect(service.keepLog()).toBe(false);
      expect(await stored()).toEqual([]);
    });

    it('keeps a choice made while the setting is being read, when that read then fails', async () => {
      const hydration = new Subject<never>();
      vi.spyOn(
        PreferenceStoreService.prototype,
        'hydrateDescriptors',
      ).mockReturnValue(hydration);
      const service = setup();

      await firstValueFrom(service.setKeepLog(true));
      hydration.error(new Error('preference storage failed'));
      console.warn('[trinity] after choosing on');

      expect(service.keepLog()).toBe(true);
      expect(setSdkCapture).not.toHaveBeenCalledWith(false);
      expect((await stored()).map((entry) => entry.message)).toContain(
        '[trinity] after choosing on',
      );
    });

    it('saves the choice and stops recording, but reports a log it could not delete', async () => {
      const service = setup();
      const before = await stored();
      makeLogUndeletable();

      await expect(
        firstValueFrom(service.setKeepLog(false)),
      ).rejects.toBeInstanceOf(DiagnosticLogNotDeletedError);
      console.warn('[trinity] after the failed delete');

      expect(storedSetting).toBe(KEEP_LOG_OFF);
      expect(service.keepLog()).toBe(false);
      expect(setSdkCapture.mock.calls).toEqual([[false]]);
      expect(await stored()).toEqual(before);
    });

    it('stays off, without an unhandled rejection, when a stored "off" cannot delete the log', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        storedSetting = KEEP_LOG_OFF;
        makeLogUndeletable();
        const service = setup();

        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        await new Promise((resolve) => setImmediate(resolve));

        expect(remove).toHaveBeenCalled();
        expect(service.keepLog()).toBe(false);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('factory reset', () => {
    it('stops for the session, drops the batch and deletes the log, leaving the setting to the reset', async () => {
      const service = setup();
      expect(await stored()).not.toEqual([]);
      service.record({
        level: 'info',
        source: 'app',
        logger: 'test',
        message: 'pending',
      });

      const discarded = firstValueFrom(service.discard());
      expect(setSdkCapture.mock.calls).toEqual([[false]]);
      await discarded;
      console.warn('[trinity] after the reset');
      window.dispatchEvent(new Event('pagehide'));

      expect(service.keepLog()).toBe(false);
      expect(await stored()).toEqual([]);
      expect(remove).toHaveBeenCalledOnce();
      expect(storedSetting).toBeNull();
    });

    it('settles only after a write already under way, so nothing lands after the delete', async () => {
      let open: (store: DiagnosticLogStore) => void = () => undefined;
      const opened = new Promise<DiagnosticLogStore>((resolve) => {
        open = resolve;
      });
      const service = setup(() => opened);
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      let settled = false;

      const discarded = firstValueFrom(service.discard()).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      open(store);
      await discarded;

      expect((await store.read()).entries).toEqual([]);
      expect(remove).toHaveBeenCalledOnce();
    });

    it('starts a fresh log once the reset has returned the setting to its default, without saving it', async () => {
      storedSetting = KEEP_LOG_OFF;
      const service = setup();
      await firstValueFrom(service.discard());
      // The reset wipes installation preferences: the setting is back to its default.
      storedSetting = null;

      await firstValueFrom(service.resumeAfterReset());
      console.warn('[trinity] after the reset');
      const messages = (await stored()).map((entry) => entry.message);

      expect(service.keepLog()).toBe(true);
      expect(service.settingKnown()).toBe(true);
      expect(setSdkCapture.mock.calls.at(-1)).toEqual([true]);
      expect(messages).toEqual([
        expect.stringMatching(
          /^diagnostic log restarted after a factory reset: /,
        ),
        '[trinity] after the reset',
      ]);
      expect(storedSetting).toBeNull();
    });

    it('stays off after the reset when the setting is still stored off', async () => {
      const service = setup();
      await firstValueFrom(service.discard());
      storedSetting = KEEP_LOG_OFF;

      await firstValueFrom(service.resumeAfterReset());
      console.warn('[trinity] after the reset');

      expect(service.keepLog()).toBe(false);
      expect(await stored()).toEqual([]);
    });

    it('stays off after the reset when the setting cannot be read', async () => {
      let readable = true;
      const service = setup(undefined, {
        read: () =>
          readable
            ? of({ kind: 'missing' } as const)
            : of({
                kind: 'unavailable',
                diagnostic: { code: 'storage-down' },
              } as const),
        write: () => of({ kind: 'completed' } as const),
      });
      await firstValueFrom(service.discard());
      readable = false;

      await firstValueFrom(service.resumeAfterReset());

      expect(service.keepLog()).toBe(false);
      expect(setSdkCapture).not.toHaveBeenCalledWith(true);
    });

    it('stays stopped when the stored setting arrives afterwards', async () => {
      const reads = new Subject<PreferenceStorageReadOutcome>();
      const service = setup(undefined, pendingAdapter(reads));

      await firstValueFrom(service.discard());
      reads.next({
        kind: 'found',
        payload: JSON.stringify({ version: 1, value: true }),
      });
      reads.complete();
      console.warn('[trinity] after the reset');

      expect(service.keepLog()).toBe(false);
      expect(await stored()).toEqual([]);
    });
  });

  describe('export', () => {
    const ALICE_ACCOUNT = {
      userId: '@alice:example.org',
      deviceId: 'QWERTYUIOP',
      homeserverUrl: 'https://matrix.example.org',
      software: { name: 'Synapse', version: '1.140.0' },
    };

    it('exports flushed and unflushed lines with the accounts the app reports', async () => {
      TestBed.configureTestingModule({
        providers: [
          { provide: BUILD_INFO, useValue: BUILD },
          {
            provide: DIAGNOSTIC_LOG_STORE_FACTORY,
            useValue: () => Promise.resolve(store),
          },
          { provide: DIAGNOSTIC_LOG_STORE_REMOVER, useValue: remove },
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: preferenceAdapter(),
          },
          {
            provide: DIAGNOSTIC_ACCOUNT_SOURCE,
            useValue: {
              accounts: () => of([ALICE_ACCOUNT]),
              knownNames: () =>
                of([
                  {
                    roomNames: ['Garden Club'],
                    roomTopics: [],
                    displayNames: ['Alice Liddell'],
                  },
                ]),
            },
          },
        ],
      });
      const service = TestBed.inject(DiagnosticLogService);
      service.start();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      service.record({
        level: 'warn',
        source: 'console',
        logger: 'trinity',
        message:
          'sync stalled for @alice:example.org (Alice Liddell) in Garden Club',
      });

      const bundle = await firstValueFrom(service.export());

      expect(bundle.entryCount).toBe(2);
      expect(bundle.text).toContain('# Account 1 (active): @me:server1');
      expect(bundle.text).toContain(
        'WARN console/trinity sync stalled for @me:server1 (Person 1) in Room 1',
      );
      expect(bundle.text).not.toContain('alice');
      expect(bundle.text).not.toContain('Alice');
      expect(bundle.text).not.toContain('Garden');
      expect(bundle.facts.homeservers).toEqual(['Synapse 1.140.0']);
    });

    it('exports without accounts when the app provides no account source', async () => {
      const service = setup();

      const bundle = await firstValueFrom(service.export());

      expect(bundle.text).toContain('# Accounts signed in: 0');
    });

    it('keeps the names read before the name source failed', async () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: DIAGNOSTIC_LOG_STORE_FACTORY,
            useValue: () => Promise.resolve(store),
          },
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: preferenceAdapter(),
          },
          {
            provide: DIAGNOSTIC_ACCOUNT_SOURCE,
            useValue: {
              accounts: () => of([ALICE_ACCOUNT]),
              knownNames: () =>
                of({
                  *[Symbol.iterator]() {
                    yield {
                      roomNames: ['Garden Club'],
                      roomTopics: [],
                      displayNames: [],
                    };
                    throw new Error('client stopped');
                  },
                }),
            },
          },
        ],
      });
      const service = TestBed.inject(DiagnosticLogService);
      service.start();
      service.record({
        level: 'warn',
        source: 'console',
        logger: 'trinity',
        message: 'sync stalled in Garden Club',
      });

      const bundle = await firstValueFrom(service.export());

      expect(bundle.text).toContain('# Accounts signed in: 1');
      expect(bundle.text).toContain('sync stalled in Room 1');
      expect(bundle.text).toContain('# Some names were not replaced');
    });

    it('still exports when the account source fails', async () => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: DIAGNOSTIC_LOG_STORE_FACTORY,
            useValue: () => Promise.resolve(store),
          },
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: preferenceAdapter(),
          },
          {
            provide: DIAGNOSTIC_ACCOUNT_SOURCE,
            useValue: {
              accounts: () =>
                throwError(() => new Error('registry unreadable')),
              knownNames: () =>
                throwError(() => new Error('engine unreachable')),
            },
          },
        ],
      });
      const service = TestBed.inject(DiagnosticLogService);
      service.start();

      const bundle = await firstValueFrom(service.export());

      expect(bundle.text).toContain('# Accounts signed in: 0');
      expect(bundle.text).toContain('# Some names were not replaced');
    });

    it('exports no entries, and never opens the store, while the log is off', async () => {
      storedSetting = KEEP_LOG_OFF;
      const openStore = vi.fn(() => Promise.resolve(store));
      const service = setup(openStore);

      const bundle = await firstValueFrom(service.export());

      expect(bundle.entryCount).toBe(0);
      expect(bundle.facts.version).toBe('Trinity v1.2.3 · abc1234');
      expect(openStore).not.toHaveBeenCalled();
    });

    it('exports facts only, without waiting, when the setting cannot be read', async () => {
      // Off for the session: the report dialog must still get its facts and offer GitHub.
      const openStore = vi.fn(() => Promise.resolve(store));
      const service = setup(openStore, {
        read: () =>
          of({
            kind: 'unavailable',
            diagnostic: { code: 'storage-down' },
          } as const),
        write: () => of({ kind: 'completed' } as const),
      });

      const bundle = await firstValueFrom(service.export());

      expect(service.keepLog()).toBe(false);
      expect(bundle.entryCount).toBe(0);
      expect(bundle.facts.version).toBe('Trinity v1.2.3 · abc1234');
      expect(openStore).not.toHaveBeenCalled();
    });

    it('waits for the setting to be read before exporting', async () => {
      const setting = new Subject<PreferenceStorageReadOutcome>();
      const service = setup(undefined, {
        read: () => setting,
        write: () => of({ kind: 'completed' } as const),
      });
      let entryCount: number | null = null;
      service.export().subscribe((bundle) => (entryCount = bundle.entryCount));
      await vi.advanceTimersByTimeAsync(0);
      expect(entryCount).toBeNull();

      setting.next({ kind: 'found', payload: KEEP_LOG_OFF });
      setting.complete();
      await vi.advanceTimersByTimeAsync(0);

      expect(entryCount).toBe(0);
    });

    it('reports the facts first, without the setting or the store, then the file, probing once', async () => {
      const reads = new Subject<PreferenceStorageReadOutcome>();
      const accounts = vi.fn(() => of([ALICE_ACCOUNT]));
      TestBed.configureTestingModule({
        providers: [
          { provide: BUILD_INFO, useValue: BUILD },
          {
            provide: DIAGNOSTIC_LOG_STORE_FACTORY,
            useValue: () => Promise.resolve(store),
          },
          { provide: DIAGNOSTIC_LOG_STORE_REMOVER, useValue: remove },
          {
            provide: PREFERENCE_STORAGE_ADAPTER,
            useValue: pendingAdapter(reads),
          },
          { provide: DIAGNOSTIC_ACCOUNT_SOURCE, useValue: { accounts } },
        ],
      });
      const service = TestBed.inject(DiagnosticLogService);
      service.start();
      const progress: DiagnosticReportProgress[] = [];
      const done = new Promise<void>((resolve) =>
        service.prepareReport().subscribe({
          next: (step) => progress.push(step),
          complete: resolve,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(progress).toEqual([
        {
          kind: 'facts',
          signedIn: true,
          facts: {
            version: 'Trinity v1.2.3 · abc1234',
            platform: expect.any(String),
            homeservers: ['Synapse 1.140.0'],
          },
        },
      ]);
      reads.next({ kind: 'missing' });
      reads.complete();
      await done;

      expect(progress.map((step) => step.kind)).toEqual(['facts', 'bundle']);
      expect(accounts).toHaveBeenCalledOnce();
    });

    it('reports nobody signed in when there are no accounts', async () => {
      const service = setup();

      const [first] = await firstValueFrom(
        service.prepareReport().pipe(toArray()),
      );

      expect(first).toMatchObject({ kind: 'facts', signedIn: false });
    });

    it('exports when the user chooses while the setting is still being read', async () => {
      const reads = new Subject<PreferenceStorageReadOutcome>();
      const service = setup(undefined, pendingAdapter(reads));
      let entryCount: number | null = null;
      service.export().subscribe((bundle) => (entryCount = bundle.entryCount));
      await vi.advanceTimersByTimeAsync(0);
      expect(entryCount).toBeNull();

      await firstValueFrom(service.setKeepLog(false));
      await vi.advanceTimersByTimeAsync(0);

      expect(entryCount).toBe(0);
    });
  });
});
