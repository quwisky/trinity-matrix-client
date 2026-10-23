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
/** Prefixes the draft key of a conversation's record of texts waiting to send offline. */
const WAITING = 'waiting:';

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

/**
 * Whether `draft` already is `text`, or holds it as one of its blank-line-separated
 * paragraphs, as a session handover may have put it there.
 */
function holdsText(draft: string, text: string): boolean {
  return draft
    .split(/\n\s*\n/)
    .some((paragraph) => paragraph.trim() === text.trim());
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
   * Keep the text of a message waiting to send offline until {@link releaseWaiting}. The
   * composer does not show it: the message is already in the timeline. Only after a reload,
   * which drops the SDK's unsent echo, does {@link init} put it back into the draft.
   */
  holdWaiting(key: string, txnId: string, body: string): void {
    const record = this.waitingRecord(key);
    record.set(txnId, body);
    this.drafts.set(WAITING + key, JSON.stringify(Object.fromEntries(record)));
    this.schedulePersist();
  }

  /** The waiting message went out, was cancelled or was refused: forget its text. */
  releaseWaiting(key: string, txnId: string): void {
    const record = this.waitingRecord(key);
    if (!record.delete(txnId)) return;
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

  private waitingRecord(key: string): Map<string, string> {
    return new Map(parseDrafts(this.drafts.get(WAITING + key) ?? null));
  }

  /**
   * At load nothing can be waiting yet, so every stored record was left by a page that has
   * gone, and its echo with it. Append each text to its draft once, then drop the record.
   */
  private recoverWaiting(): boolean {
    let recovered = false;
    for (const [recordKey, value] of [...this.drafts]) {
      if (!recordKey.startsWith(WAITING)) continue;
      const key = recordKey.slice(WAITING.length);
      let draft = this.get(key).trimEnd();
      for (const [, body] of parseDrafts(value)) {
        if (!holdsText(draft, body))
          draft = draft ? `${draft}\n\n${body}` : body;
      }
      this.drafts.delete(recordKey);
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
