import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
  type Signal,
} from '@angular/core';
import type { Observable } from 'rxjs';
import {
  ClientEvent,
  MatrixError,
  Method,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import {
  applyPicks,
  ELEMENT_RECENT_EMOJI_EVENT_TYPE,
  parseElementRecentEmoji,
  parseRecentEmoji,
  RECENT_EMOJI_EVENT_TYPE,
  recentEmojiContent,
  shownRecentEmoji,
  UNSTABLE_RECENT_EMOJI_EVENT_TYPE,
  type RecentEmojiEntry,
} from './recent-emoji.model';

export * from './recent-emoji.model';

/** A burst of picks is written once, this long after the last. */
const WRITE_DELAY_MS = 2_000;

const RECENT_EMOJI_TYPES = new Set([
  RECENT_EMOJI_EVENT_TYPE,
  UNSTABLE_RECENT_EMOJI_EVENT_TYPE,
  ELEMENT_RECENT_EMOJI_EVENT_TYPE,
]);

interface PendingWrites {
  /** Picks not yet saved, oldest first. */
  picks: readonly string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** The write in flight; the next one starts after it. */
  queue: Promise<void>;
}

/**
 * The Active Account's recently used emoji, synced across devices through MSC4356's
 * `m.recent_emoji` account data. A pick shows at once; picks are saved together a moment later.
 */
@Injectable({ providedIn: 'root' })
export class RecentEmojiService {
  private readonly matrix = inject(MatrixClientService);
  private readonly base = signal<readonly RecentEmojiEntry[]>([]);
  private readonly unsaved = signal<readonly string[]>([]);
  private readonly writes = new Map<MatrixClient, PendingWrites>();

  private readonly onAccountData = (event: MatrixEvent): void => {
    if (RECENT_EMOJI_TYPES.has(event.getType())) {
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    id: 'media.recent-emoji',
    matrix: this.matrix,
    bind: (client) => client.on(ClientEvent.AccountData, this.onAccountData),
    unbind: (client) => client.off(ClientEvent.AccountData, this.onAccountData),
    rebuild: (client) => {
      this.base.set(storedEntries(client));
      this.unsaved.set(this.writes.get(client)?.picks ?? []);
    },
    reset: () => {
      this.base.set([]);
      this.unsaved.set([]);
    },
  });

  /** Unicode emoji, most used first among the most recent. */
  readonly recent: Signal<readonly string[]> = computed(() =>
    shownRecentEmoji(applyPicks(this.base(), this.unsaved())),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const pending of this.writes.values()) {
        if (pending.timer !== null) clearTimeout(pending.timer);
      }
    });
  }

  /** Cold lifetime: keeps the projection attached until the last unsubscribe. */
  run(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Records a picked emoji for the Active Account. Works with nothing keeping the projection
   * open, as a toolbar's quick reaction does: the save reads the server copy first anyway.
   */
  record(emoji: string): void {
    const client =
      this.projection.client() ??
      (this.matrix.isInitialized ? this.matrix.instance : null);
    if (!client || !emoji) return;
    const pending = this.pendingFor(client);
    pending.picks = [...pending.picks, emoji];
    if (this.projection.client() === client) this.unsaved.set(pending.picks);
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.save(client), WRITE_DELAY_MS);
  }

  private pendingFor(client: MatrixClient): PendingWrites {
    let pending = this.writes.get(client);
    if (!pending) {
      pending = { picks: [], timer: null, queue: Promise.resolve() };
      this.writes.set(client, pending);
    }
    return pending;
  }

  private save(client: MatrixClient): void {
    const pending = this.pendingFor(client);
    pending.timer = null;
    const queue = pending.queue.then(async () => {
      const picks = pending.picks;
      if (picks.length === 0) return;
      try {
        // Account data has no compare-and-set: a write from another device that lands between
        // this read and the write below is overwritten. Reading just before narrows the window.
        const saved = applyPicks(await serverEntries(client), picks);
        await accountData(client).setAccountDataRaw(
          RECENT_EMOJI_EVENT_TYPE,
          recentEmojiContent(saved),
        );
        pending.picks = pending.picks.slice(picks.length);
        if (this.projection.client() === client) {
          this.base.set(saved);
          this.unsaved.set(pending.picks);
        }
      } catch {
        // Left in `picks`: the next burst saves them.
      }
    });
    pending.queue = queue;
    void queue.then(() => {
      // Forget a client with nothing left to save, so a signed-out one is not kept alive.
      if (
        pending.queue === queue &&
        pending.timer === null &&
        pending.picks.length === 0 &&
        this.writes.get(client) === pending
      ) {
        this.writes.delete(client);
      }
    });
  }
}

/** The SDK types account data by known event types, and the two seed types are not among them. */
interface AccountDataClient {
  getAccountData(type: string): MatrixEvent | undefined;
  setAccountDataRaw(type: string, content: object): Promise<unknown>;
}

function accountData(client: MatrixClient): AccountDataClient {
  return client as unknown as AccountDataClient;
}

/** The local copy: the stable type, else one of the seeds. Only the stable type is written. */
function storedEntries(client: MatrixClient): RecentEmojiEntry[] {
  const stored = (type: string): unknown =>
    accountData(client).getAccountData(type)?.getContent();
  const stable = stored(RECENT_EMOJI_EVENT_TYPE);
  if (stable !== undefined) return parseRecentEmoji(stable);
  const unstable = stored(UNSTABLE_RECENT_EMOJI_EVENT_TYPE);
  if (unstable !== undefined) return parseRecentEmoji(unstable);
  return parseElementRecentEmoji(stored(ELEMENT_RECENT_EMOJI_EVENT_TYPE));
}

/**
 * The server's copy, read just before each write so another device's picks since the last
 * sync are kept. Falls back to the local seeds while the stable type does not exist.
 */
async function serverEntries(
  client: MatrixClient,
): Promise<RecentEmojiEntry[]> {
  const userId = client.getUserId();
  if (!userId) throw new Error('recent emoji: not signed in');
  try {
    const content = await client.http.authedRequest<unknown>(
      Method.Get,
      `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(RECENT_EMOJI_EVENT_TYPE)}`,
    );
    return parseRecentEmoji(content);
  } catch (error) {
    if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
      return storedEntries(client);
    }
    throw error;
  }
}
