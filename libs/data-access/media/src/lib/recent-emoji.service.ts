import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import {
  projectActiveAccount,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { type EngineResult, unwrapEngineResult } from '@trinity/util/matrix';
import type { AccountDataSnapshot } from './expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
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

const RECENT_EMOJI_TYPES = [
  RECENT_EMOJI_EVENT_TYPE,
  UNSTABLE_RECENT_EMOJI_EVENT_TYPE,
  ELEMENT_RECENT_EMOJI_EVENT_TYPE,
];

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
  private readonly engine = inject(EXPRESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly base = signal<readonly RecentEmojiEntry[]>([]);
  private readonly unsaved = signal<readonly string[]>([]);
  private readonly writes = new Map<string, PendingWrites>();

  private readonly projection = projectActiveAccount<AccountDataSnapshot>({
    id: 'media.recent-emoji',
    subscribe: (accountId) =>
      this.engine.accountData(accountId, RECENT_EMOJI_TYPES),
    rebuild: (snapshot, accountId) => {
      this.base.set(storedEntries(snapshot));
      this.unsaved.set(this.writes.get(accountId)?.picks ?? []);
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
    const accountId =
      this.projection.accountId() ?? untracked(this.session.activeAccountId);
    if (!accountId || !emoji) return;
    const pending = this.pendingFor(accountId);
    pending.picks = [...pending.picks, emoji];
    if (this.projection.accountId() === accountId) {
      this.unsaved.set(pending.picks);
    }
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.save(accountId), WRITE_DELAY_MS);
  }

  private pendingFor(accountId: string): PendingWrites {
    let pending = this.writes.get(accountId);
    if (!pending) {
      pending = { picks: [], timer: null, queue: Promise.resolve() };
      this.writes.set(accountId, pending);
    }
    return pending;
  }

  private save(accountId: string): void {
    const pending = this.pendingFor(accountId);
    pending.timer = null;
    const queue = pending.queue.then(async () => {
      const picks = pending.picks;
      if (picks.length === 0) return;
      try {
        // Account data has no compare-and-set: a write from another device that lands between
        // this read and the write below is overwritten. Reading just before narrows the window.
        const saved = applyPicks(await this.serverEntries(accountId), picks);
        await settled(
          this.engine.setAccountData(
            accountId,
            RECENT_EMOJI_EVENT_TYPE,
            recentEmojiContent(saved),
          ),
        );
        pending.picks = pending.picks.slice(picks.length);
        if (this.projection.accountId() === accountId) {
          this.base.set(saved);
          this.unsaved.set(pending.picks);
        }
      } catch {
        // Left in `picks`: the next burst saves them.
      }
    });
    pending.queue = queue;
    void queue.then(() => {
      // Forget an account with nothing left to save.
      if (
        pending.queue === queue &&
        pending.timer === null &&
        pending.picks.length === 0 &&
        this.writes.get(accountId) === pending
      ) {
        this.writes.delete(accountId);
      }
    });
  }

  /**
   * The server's copy, read just before each write so another device's picks since the last
   * sync are kept. Falls back to the local seeds while the stable type does not exist.
   */
  private async serverEntries(accountId: string): Promise<RecentEmojiEntry[]> {
    const content = await settled(
      this.engine.fetchAccountData(accountId, RECENT_EMOJI_EVENT_TYPE),
    );
    if (content !== null) return parseRecentEmoji(content);
    return storedEntries(
      await firstValueFrom(
        this.engine.accountData(accountId, RECENT_EMOJI_TYPES),
      ),
    );
  }
}

/** A command's value; its failure rejects. */
function settled<T>(command: Observable<EngineResult<T>>): Promise<T> {
  return firstValueFrom(command.pipe(unwrapEngineResult()));
}

/** The local copy: the stable type, else one of the seeds. Only the stable type is written. */
function storedEntries(snapshot: AccountDataSnapshot): RecentEmojiEntry[] {
  const stable = snapshot[RECENT_EMOJI_EVENT_TYPE];
  if (stable != null) return parseRecentEmoji(stable);
  const unstable = snapshot[UNSTABLE_RECENT_EMOJI_EVENT_TYPE];
  if (unstable != null) return parseRecentEmoji(unstable);
  return parseElementRecentEmoji(snapshot[ELEMENT_RECENT_EMOJI_EVENT_TYPE]);
}
