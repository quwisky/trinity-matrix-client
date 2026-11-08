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
/** Prefixes the draft key of a conversation's record of messages not on the server yet. */
const WAITING = 'waiting:';
/** `conversationDraftKey`'s prefix; a legacy thread composer's key is a bare event id. */
const CONVERSATION = 'conversation:';

/**
 * A message the main composer sent and the homeserver does not have yet, kept by its txn id
 * apart from the draft. `content` is the event as built, absent while its reply target loads.
 */
export interface PendingMessage {
  readonly body: string;
  readonly content?: Record<string, unknown>;
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
    const record = this.waitingRecord(key);
    record.set(txnId, body);
    this.writeRecord(key, record);
    // Written now, with the draft it just left: a reload inside the debounce would otherwise lose
    // the message, or bring its text back in the box.
    void this.flush();
  }

  /** The message went out, was cancelled or was deleted: forget it. */
  releaseWaiting(key: string, txnId: string): void {
    const record = this.waitingRecord(key);
    if (!record.delete(txnId)) return;
    this.writeRecord(key, record);
  }

  /** The messages held for a conversation by txn id, oldest first. */
  pendingMessages(key: string): ReadonlyMap<string, PendingMessage> {
    const pending = new Map<string, PendingMessage>();
    for (const [txnId, held] of this.waitingRecord(key)) {
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
    // Wrapped as in persist(): a `.catch` on a non-promise throws synchronously. The
    // Preferences copy goes too, in case a move to the iOS file never finished.
    for (const store of new Set([this.persistence, preferencesPersistence])) {
      void Promise.resolve(store.remove()).catch(() => undefined);
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

  private waitingRecord(key: string): Map<string, string | PendingMessage> {
    return new Map(parseRecord(this.drafts.get(WAITING + key) ?? null));
  }

  private writeRecord(
    key: string,
    record: ReadonlyMap<string, string | PendingMessage>,
  ): void {
    if (record.size) {
      this.drafts.set(
        WAITING + key,
        JSON.stringify(Object.fromEntries(record)),
      );
    } else {
      this.drafts.delete(WAITING + key);
    }
    this.schedulePersist();
  }

  /**
   * At load nothing is on its way yet, so every record was left by a page that has gone, and
   * its echoes with it. A conversation's messages stay held for its timeline to show again, a
   * bare body an older build kept there included. A thread's bodies are appended to its draft
   * once, and that record dropped.
   */
  private recoverWaiting(): boolean {
    let recovered = false;
    for (const [recordKey, value] of [...this.drafts]) {
      if (!recordKey.startsWith(WAITING)) continue;
      const key = recordKey.slice(WAITING.length);
      const record = parseRecord(value);
      if (key.startsWith(CONVERSATION)) {
        if (record.every(([, held]) => typeof held !== 'string')) continue;
        const upgraded = record.map(([txnId, held]) => [
          txnId,
          typeof held === 'string' ? { body: held } : held,
        ]);
        this.drafts.set(
          recordKey,
          JSON.stringify(Object.fromEntries(upgraded)),
        );
        recovered = true;
        continue;
      }
      let draft = this.get(key).trimEnd();
      for (const [, held] of record) {
        const body = typeof held === 'string' ? held : held.body;
        if (!holdsText(draft, body))
          draft = draft ? `${draft}\n\n${body}` : body;
      }
      this.drafts.delete(recordKey);
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

  /** Resolves whether the write succeeded; never rejects. */
  private persist(): Promise<boolean> {
    const record: Record<string, string> = {};
    for (const [key, text] of [...this.drafts.entries()].slice(-MAX_DRAFTS)) {
      record[key] = text;
    }
    // Promise.resolve wraps the SDK call: a `.catch` straight onto a non-promise throws
    // synchronously out of a timer callback, where nothing can catch it.
    return Promise.resolve(this.persistence.write(JSON.stringify(record))).then(
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
