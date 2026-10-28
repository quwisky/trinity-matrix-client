import {
  ErrorHandler,
  Injectable,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import {
  SESSION_ENGINE,
  type SessionAccountStatus,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import type { NotificationSettings } from './notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';

interface Feed {
  readonly generation: number;
  readonly subscription: Subscription;
  settings: NotificationSettings;
}

const NONE: readonly SessionAccountStatus[] = [];

const UNLOADED: NotificationSettings = {
  loaded: false,
  defaultRules: [],
  keywords: [],
};

/**
 * Each live account's {@link NotificationSettings}, one engine subscription per account and
 * session generation while {@link run} is retained. Reads are synchronous and reactive; each
 * reconciles with the session snapshot first, so an engine that emits on subscribe has filled
 * an account by the time the read that saw it go live returns.
 */
@Injectable({ providedIn: 'root' })
export class NotificationSettingsStore {
  private readonly engine = inject(NOTIFICATION_ENGINE);
  private readonly sessionEngine = inject(SESSION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly errors = inject(ErrorHandler);
  private readonly feeds = new Map<string, Feed>();
  /** Bumped by emissions after the first, which arrive outside any reactive read. */
  private readonly version = signal(0);
  private reconciledFor: readonly SessionAccountStatus[] | null = null;
  private owners = 0;
  private opening = false;

  /** Cold lifetime: keeps every live account's settings until the final unsubscribe. */
  run(): Observable<never> {
    return new Observable<never>(() => {
      this.owners += 1;
      // Readers that saw the store idle read again.
      this.version.update((v) => v + 1);
      // Also closes the feeds of accounts that left while nothing reads the store.
      const follow = this.sessionEngine
        .session()
        .subscribe(() =>
          untracked(() => this.reconcile(this.session.snapshot().accounts)),
        );
      return () => {
        follow.unsubscribe();
        this.owners -= 1;
        if (this.owners > 0) return;
        this.reconcile(NONE);
        this.version.update((v) => v + 1);
      };
    });
  }

  /** The account's settings; unloaded and empty while it is not live or nothing runs the store. */
  settings(accountId: string): NotificationSettings {
    const accounts = this.session.snapshot().accounts;
    this.version();
    untracked(() => this.reconcile(accounts));
    return this.feeds.get(accountId)?.settings ?? UNLOADED;
  }

  private reconcile(accounts: readonly SessionAccountStatus[]): void {
    const live = this.owners > 0 ? accounts : NONE;
    if (live === this.reconciledFor) return;
    this.reconciledFor = live;
    const generations = new Map(live.map((a) => [a.accountId, a.generation]));
    for (const [accountId, feed] of this.feeds) {
      if (generations.get(accountId) === feed.generation) continue;
      feed.subscription.unsubscribe();
      this.feeds.delete(accountId);
    }
    this.opening = true;
    try {
      for (const [accountId, generation] of generations) {
        if (!this.feeds.has(accountId)) this.open(accountId, generation);
      }
    } finally {
      this.opening = false;
    }
  }

  private open(accountId: string, generation: number): void {
    const feed: Feed = {
      generation,
      subscription: new Subscription(),
      settings: UNLOADED,
    };
    this.feeds.set(accountId, feed);
    feed.subscription.add(
      this.engine.settings(accountId).subscribe({
        next: (settings) => {
          feed.settings = settings;
          this.changed();
        },
        // A fault ends the feed; drop it rather than serve its last settings as current.
        error: (error: unknown) => {
          this.errors.handleError(error);
          // Reopened on the next session change: reconcile is keyed by the accounts reference.
          if (this.feeds.get(accountId) === feed) this.feeds.delete(accountId);
          this.changed();
        },
      }),
    );
  }

  private changed(): void {
    if (!this.opening) this.version.update((v) => v + 1);
  }
}
