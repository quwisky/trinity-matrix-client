import { Injectable, type OnDestroy } from '@angular/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { isNativeIos } from './mobile-os';

const DRAFTS_KEY = 'trinity.composer.drafts';
const DRAFTS_FILE = {
  path: 'composer-drafts.json',
  directory: Directory.LibraryNoCloud,
} as const;
/** Coalesce a burst of keystrokes into one persist (ms). */
const PERSIST_DEBOUNCE_MS = 400;
/** Bound the stored set so stale drafts can't grow without limit. */
const MAX_DRAFTS = 200;
/** Prefixes the draft key of a record of bare bodies waiting to send: a thread's, or an older build's. */
const WAITING = 'waiting:';
/**
 * Prefixes the draft key of a conversation's {@link PendingMessage} record. Not {@link WAITING}:
 * an older build reads that record as bodies only and deletes it, but leaves this one alone.
 */
const PENDING = 'pending:';
/** `conversationDraftKey`'s prefix; a legacy thread composer's key is a bare event id. */
const CONVERSATION = 'conversation:';
/** A key that is a message id (`~` local echo, `$` event), not the txn id a resend can reuse. */
const MESSAGE_ID = /^[~$]/;

/**
 * A message the main composer sent and the homeserver does not have yet, kept by its txn id
 * apart from the draft. `content` is the event as built, absent while its reply target loads;
 * `replyTo` and `mentions` rebuild it then.
 */
export interface PendingMessage {
  readonly body: string;
  readonly content?: Record<string, unknown>;
  readonly replyTo?: string;
  readonly mentions?: readonly {
    readonly userId: string;
    readonly display: string;
  }[];
}

/** Where the drafts map is persisted, as one JSON string. */
interface DraftPersistence {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

const preferencesPersistence: DraftPersistence = {
  read: async () => (await Preferences.get({ key: DRAFTS_KEY })).value ?? null,
  write: (value) => Preferences.set({ key: DRAFTS_KEY, value }),
  remove: () => Preferences.remove({ key: DRAFTS_KEY }),
};

/**
 * iOS backs Preferences (UserDefaults) up to iCloud and computers, and a draft is the
 * plaintext of a message to an encrypted room, so there drafts live in `Library/NoCloud`,
 * which is excluded from backup.
 */
const backupExcludedFile: DraftPersistence = {
  async read() {
    try {
      const { data } = await Filesystem.readFile({
        ...DRAFTS_FILE,
        encoding: Encoding.UTF8,
      });
      return typeof data === 'string' ? data : null;
    } catch {
      return null; // no file yet
    }
  },
  async write(data) {
    await Filesystem.writeFile({
      ...DRAFTS_FILE,
      encoding: Encoding.UTF8,
      recursive: true,
      data,
    });
  },
  remove: () => Filesystem.deleteFile(DRAFTS_FILE),
};

/** The string-valued entries of a stored drafts map; nothing for absent or corrupt data. */
function parseDrafts(value: string | null): [string, string][] {
  if (!value) return [];
  try {
    return Object.entries(JSON.parse(value) as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
  } catch {
    return [];
  }
}

/** A record's entries: a body string (thread or legacy) or a {@link PendingMessage}. */
function parseRecord(
  value: string | null,
): [string, string | PendingMessage][] {
  if (!value) return [];
  try {
    return Object.entries(JSON.parse(value) as Record<string, unknown>).filter(
      (entry): entry is [string, string | PendingMessage] =>
        typeof entry[1] === 'string' ||
        (typeof entry[1] === 'object' &&
          entry[1] !== null &&
          typeof (entry[1] as { body?: unknown }).body === 'string'),
    );
  } catch {
    return [];
  }
}

/**
 * Whether `draft` already is `text`, or holds it as one of its blank-line-separated paragraphs.
 * Not a substring test: an unsent "ok" must still come back after a draft that says "looks ok".
 */
export function holdsText(draft: string, text: string): boolean {
  const wanted = text.trim();
  return (
    draft.trim() === wanted ||
    draft.split(/\n\s*\n/).some((paragraph) => paragraph.trim() === wanted)
  );
}

/**
 * Per-conversation composer drafts, persisted across launches under an opaque conversation
 * key (an Account-and-Room key for the main composer, the root event id for the legacy
 * thread composer). Like the theme and feature flags these are non-secret UI state, so
 * they live in Capacitor `Preferences` (localStorage on web, native KV on Android), never
 * secure storage; on iOS in a file excluded from backup.
 *
 * Read synchronously from memory; {@link init} must load the saved map before any
 * composer mounts. Writes are debounced.
 */
@Injectable({ providedIn: 'root' })
export class DraftStoreService implements OnDestroy {
  private drafts = new Map<string, string>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private initialised = false;
  private readonly persistence = isNativeIos()
    ? backupExcludedFile
    : preferencesPersistence;
  /** Drafts still in Preferences that the iOS file has not taken over yet. */
  private legacyCopy = false;
  /** The last write queued, while one is; the next one waits for it. */
  private writing: Promise<boolean> | null = null;

  /**
   * Drop a pending write when the injector goes away: under test a late write lands after
   * the module is torn down, where `Preferences.set` is no longer a promise, and the run
   * fails on an uncaught TypeError with every test passing.
   *
   * `ngOnDestroy` rather than `inject(DestroyRef)` so a test can still build an instance
   * with `new` to pre-seed it.
   */
  ngOnDestroy(): void {
    this.cancelPending();
  }

  /** Load persisted drafts. Call once at app startup, before the composer renders. */
  async init(): Promise<void> {
    // Absent or corrupt: start empty.
    const stored = await this.persistence.read().catch(() => null);
    const legacy =
      this.persistence === preferencesPersistence
        ? null
        : await preferencesPersistence.read().catch(() => null);
    this.drafts = new Map([...parseDrafts(legacy), ...parseDrafts(stored)]);
    this.initialised = true;
    const recovered = this.recoverWaiting();
    if (legacy !== null) this.legacyCopy = true;
    if (legacy !== null || recovered) await this.persist();
  }

  /** Whether {@link init} has loaded the stored drafts; before that the map is empty. */
  isInitialised(): boolean {
    return this.initialised;
  }

  /** The saved draft for a conversation, or '' when none. */
  get(key: string): string {
    return this.drafts.get(key) ?? '';
  }

  /** Save the draft for a conversation; a blank draft drops the entry. */
  set(key: string, text: string): void {
    if (text.trim().length > 0) {
      this.drafts.set(key, text);
    } else {
      this.drafts.delete(key);
    }
    this.schedulePersist();
  }

  /** Drop a conversation's draft (e.g. after its message is sent). */
  clear(key: string): void {
    if (this.drafts.delete(key)) {
      this.schedulePersist();
    }
  }

  /**
   * Keep a message the homeserver does not have yet until {@link releaseWaiting}, keyed by its
   * txn id. The composer never shows it: the message is in the timeline. A {@link PendingMessage}
   * outlives a reload, which drops the SDK's echo, so the timeline can show it again; a plain
   * body (the legacy thread composer) goes back into its draft at the next {@link init}.
   */
  holdWaiting(key: string, txnId: string, body: string | PendingMessage): void {
    const prefix = typeof body === 'string' ? WAITING : PENDING;
    const record = this.record(prefix, key);
    record.set(txnId, body);
    this.writeRecord(prefix, key, record);
    // Written now, with the draft it just left: a reload inside the debounce would otherwise lose
    // the message, or bring its text back in the box.
    void this.flush();
  }

  /** The message went out, was cancelled or was deleted: forget it. */
  releaseWaiting(key: string, txnId: string): void {
    let released = false;
    for (const prefix of [WAITING, PENDING]) {
      const record = this.record(prefix, key);
      if (!record.delete(txnId)) continue;
      this.writeRecord(prefix, key, record);
      released = true;
    }
    // Now too: a reload inside the debounce would show a message that went out as failed.
    if (released) void this.flush();
  }

  /** The messages held for a conversation by txn id, oldest first. */
  pendingMessages(key: string): ReadonlyMap<string, PendingMessage> {
    const pending = new Map<string, PendingMessage>();
    for (const [txnId, held] of this.record(PENDING, key)) {
      if (typeof held !== 'string') pending.set(txnId, held);
    }
    return pending;
  }

  /**
   * Drop every draft, in memory and on disk, for sign-out.
   *
   * A draft is the plaintext of a message destined for an encrypted room, so it must not
   * outlive the session that wrote it; on web/Electron the store is localStorage, readable
   * by whoever next uses the browser profile. The pending write is cancelled first, or it
   * would re-persist the map 400ms after the wipe.
   *
   * All drafts share one persisted collection and legacy thread keys carry no Account, so
   * signing one of several accounts out clears all drafts. Losing a draft is recoverable;
   * leaking one is not.
   */
  clearAll(): void {
    this.cancelPending();
    this.drafts = new Map();
    // A write already on its way could land after the removal and put the drafts back,
    // so the removal waits for it. With none, it stays synchronous for a page about to go.
    const inFlight = this.writing;
    // Wrapped as in persist(): a `.catch` on a non-promise throws synchronously. The
    // Preferences copy goes too, in case a move to the iOS file never finished.
    for (const store of new Set([this.persistence, preferencesPersistence])) {
      void (
        inFlight
          ? inFlight.then(() => store.remove())
          : Promise.resolve(store.remove())
      ).catch(() => undefined);
    }
  }

  /**
   * Write the drafts now, for a page about to restart: a debounced write would be lost
   * with the page. Never rejects. Before {@link init} has loaded them it writes nothing,
   * since the empty map would erase the stored drafts.
   */
  flush(): Promise<void> {
    if (!this.initialised) return Promise.resolve();
    this.cancelPending();
    return this.persist().then(() => undefined);
  }

  private record(
    prefix: string,
    key: string,
  ): Map<string, string | PendingMessage> {
    return new Map(parseRecord(this.drafts.get(prefix + key) ?? null));
  }

  private writeRecord(
    prefix: string,
    key: string,
    record: ReadonlyMap<string, string | PendingMessage>,
  ): void {
    if (record.size) {
      this.drafts.set(prefix + key, JSON.stringify(Object.fromEntries(record)));
    } else {
      this.drafts.delete(prefix + key);
    }
    this.schedulePersist();
  }

  /**
   * At load nothing is on its way yet, so every record was left by a page that has gone, and
   * its echoes with it. {@link PENDING} records stay for the timeline to show again. A bare body
   * an older build kept for a conversation joins them, unless it is keyed by a message id rather
   * than a txn id: resent under that id it could go out twice, so it goes back into the draft,
   * as a thread's bodies do.
   */
  private recoverWaiting(): boolean {
    let recovered = false;
    for (const [recordKey, value] of [...this.drafts]) {
      if (!recordKey.startsWith(WAITING)) continue;
      const key = recordKey.slice(WAITING.length);
      const pending = this.record(PENDING, key);
      let draft = this.get(key).trimEnd();
      for (const [txnId, held] of parseRecord(value)) {
        const body = typeof held === 'string' ? held : held.body;
        if (key.startsWith(CONVERSATION) && !MESSAGE_ID.test(txnId)) {
          if (!pending.has(txnId)) pending.set(txnId, { body });
        } else if (!holdsText(draft, body)) {
          draft = draft ? `${draft}\n\n${body}` : body;
        }
      }
      this.drafts.delete(recordKey);
      if (pending.size) {
        this.drafts.set(
          PENDING + key,
          JSON.stringify(Object.fromEntries(pending)),
        );
      }
      // Newest last, so the cap in persist() trims older drafts before this one.
      this.drafts.delete(key);
      if (draft) this.drafts.set(key, draft);
      recovered = true;
    }
    return recovered;
  }

  private schedulePersist(): void {
    if (this.pending !== null) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private cancelPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  /**
   * Resolves whether the write succeeded; never rejects. Writes run one after another, each
   * taking the map as it is when it starts: two in flight at once may land out of order (iOS
   * Filesystem), leaving the older map on disk.
   */
  private persist(): Promise<boolean> {
    const next = this.writing
      ? this.writing.then(() => this.write())
      : this.write();
    this.writing = next;
    void next.then(() => {
      if (this.writing === next) this.writing = null;
    });
    return next;
  }

  private write(): Promise<boolean> {
    const record: Record<string, string> = {};
    for (const [key, text] of [...this.drafts.entries()].slice(-MAX_DRAFTS)) {
      record[key] = text;
    }
    // A synchronous throw, or a `.catch` straight onto a non-promise, would escape a timer
    // callback, or reject the queue every later write waits on.
    let written: Promise<void>;
    try {
      written = Promise.resolve(this.persistence.write(JSON.stringify(record)));
    } catch {
      return Promise.resolve(false);
    }
    return written.then(
      () => {
        // The Preferences copy goes only once the file holds the drafts, and then at the
        // first write that succeeds, or a draft cleared since would come back next launch.
        if (this.legacyCopy) {
          this.legacyCopy = false;
          void Promise.resolve(preferencesPersistence.remove()).catch(() => {
            this.legacyCopy = true;
          });
        }
        return true;
      },
      () => false,
    );
  }
}
