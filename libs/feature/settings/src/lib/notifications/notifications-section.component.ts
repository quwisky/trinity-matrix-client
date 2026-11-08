import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NotificationSoundService,
  PushRulesService,
  ReactionNotificationSettingsService,
  type PushRuleToggle,
} from '@trinity/data-access/notifications';
import { InboxSettingsGroupComponent } from './inbox-settings-group.component';
import { KeywordRulesBlockComponent } from './keyword-rules-block.component';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import { Subject, takeUntil } from 'rxjs';

/** How long a written toggle waits for its sync echo before the synced value shows again. */
const SYNC_ECHO_LIMIT_MS = 10_000;

/**
 * Notifications settings sub-page: account-level toggles for which events notify,
 * backed by the homeserver's predefined push rules (via {@link PushRulesService}). Each
 * toggle is optimistic — it flips immediately and reverts with a toast if the write
 * fails. Changes sync to every device on the account.
 */
@Component({
  selector: 'trn-notifications-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './notifications-section.component.html',
  imports: [
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    TrnSwitchComponent,
    KeywordRulesBlockComponent,
    InboxSettingsGroupComponent,
  ],
})
export class NotificationsSectionComponent implements OnInit, OnDestroy {
  private readonly push = inject(PushRulesService);
  private readonly sound = inject(NotificationSoundService);
  private readonly reactions = inject(ReactionNotificationSettingsService);
  private readonly matrix = inject(MatrixClientService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly toggles = this.push.toggles;

  /** The UI on/off state per rule id (optimistic; seeded from the synced rules). */
  private readonly state = signal<ReadonlyMap<string, boolean>>(new Map());
  /** Rule ids whose write is in flight. */
  private readonly pending = signal<ReadonlySet<string>>(new Set());
  /**
   * Written values the synced rules don't show yet, by rule id. The SDK updates its local
   * rules only from the sync echo, so an earlier sync would otherwise flip the toggle back.
   */
  private readonly awaitingSync = new Map<
    string,
    { readonly value: boolean; readonly timer: ReturnType<typeof setTimeout> }
  >();
  private accountId: string | null | undefined;
  /** Emits on an account switch; releases the previous account's writes. */
  private readonly accountSwitches = new Subject<void>();

  /**
   * Key for the sound switch in the same optimistic maps as the rule toggles. Not a rule id:
   * it stands for the `sound` tweak across SEVEN predefined rules at once.
   */
  protected readonly soundKey = 'trinity.notification-sound';
  // Internal pending-map identity; the persisted account-data key belongs to the service.
  protected readonly reactionsKey = 'reaction-notifications';

  constructor() {
    // Re-read the rule toggles on every sync of the account's rules and on a switch; a
    // toggle keeps its written value until the sync carries it.
    effect(() => {
      const accountId = this.matrix.activeUserId();
      this.push.revision();
      untracked(() => {
        const switched =
          this.accountId !== undefined && this.accountId !== accountId;
        if (switched) {
          this.accountSwitches.next();
          this.pending.set(new Set());
          this.forgetAllSyncs();
        }
        this.accountId = accountId;
        this.readToggles(switched);
      });
    });
    this.destroyRef.onDestroy(() => this.forgetAllSyncs());
  }

  ngOnInit(): void {
    this.push.connect();
    // Tracks account data, so a value that arrives after this page has rendered (a cold
    // load, or a change made on another device) still shows.
    this.sound.connect();
    this.reactions.connect();
  }

  ngOnDestroy(): void {
    this.push.disconnect();
    this.sound.disconnect();
    this.reactions.disconnect();
  }

  /**
   * The optimistic value while a write is in flight, otherwise whatever the account says
   * (seeding once isn't enough: on a cold load the page can render before the initial sync).
   */
  soundChecked(): boolean {
    return this.soundPending()
      ? (this.state().get(this.soundKey) ?? this.sound.enabled())
      : this.sound.enabled();
  }

  soundPending(): boolean {
    return this.pending().has(this.soundKey);
  }

  /** Optimistically flip the sound switch and persist it; revert + toast on failure. */
  toggleSound(on: boolean): void {
    if (this.soundPending()) {
      return;
    }
    this.setState(this.soundKey, on);
    this.setPending(this.soundKey, true);
    const accountId = this.matrix.activeUserId();
    this.sound
      .setOn(on)
      .pipe(
        takeUntil(this.accountSwitches),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          if (this.isCurrentAccount(accountId)) {
            this.setPending(this.soundKey, false);
          }
        },
        error: () => {
          if (this.isCurrentAccount(accountId)) {
            this.setState(this.soundKey, !on);
            this.setPending(this.soundKey, false);
            this.toast.show('Could not update your notification settings.', {
              variant: 'danger',
            });
          }
        },
      });
  }

  reactionChecked(): boolean {
    return this.reactionPending()
      ? (this.state().get(this.reactionsKey) ?? this.reactions.enabled())
      : this.reactions.enabled();
  }

  reactionPending(): boolean {
    return this.pending().has(this.reactionsKey);
  }

  toggleReactions(on: boolean): void {
    if (this.reactionPending()) {
      return;
    }
    this.setState(this.reactionsKey, on);
    this.setPending(this.reactionsKey, true);
    const accountId = this.matrix.activeUserId();
    this.reactions
      .setOn(on)
      .pipe(
        takeUntil(this.accountSwitches),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          if (this.isCurrentAccount(accountId)) {
            this.setPending(this.reactionsKey, false);
          }
        },
        error: () => {
          if (this.isCurrentAccount(accountId)) {
            this.setState(this.reactionsKey, !on);
            this.setPending(this.reactionsKey, false);
            this.toast.show('Could not update your notification settings.', {
              variant: 'danger',
            });
          }
        },
      });
  }

  /** The switch effect runs later than the signal changes, so also compare the account. */
  private isCurrentAccount(accountId: string | null): boolean {
    return this.matrix.activeUserId() === accountId;
  }

  checked(toggle: PushRuleToggle): boolean {
    return this.state().get(toggle.id) ?? false;
  }

  isPending(toggle: PushRuleToggle): boolean {
    return this.pending().has(toggle.id);
  }

  /** Optimistically flip a toggle and persist it; revert + toast on failure. */
  toggle(toggle: PushRuleToggle, on: boolean): void {
    if (this.isPending(toggle)) {
      return;
    }
    this.setState(toggle.id, on);
    this.setPending(toggle.id, true);
    const accountId = this.matrix.activeUserId();
    this.push
      .setOn(toggle, on)
      .pipe(
        takeUntil(this.accountSwitches),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          if (this.isCurrentAccount(accountId)) {
            // Unless already synced; an earlier write's echo still due may undo even that.
            if (
              this.awaitingSync.has(toggle.id) ||
              this.push.isOn(toggle) !== on
            ) {
              this.awaitSync(toggle.id, on);
            }
            this.setPending(toggle.id, false);
          }
        },
        error: () => {
          if (this.isCurrentAccount(accountId)) {
            this.setState(toggle.id, !on); // revert the optimistic flip
            this.setPending(toggle.id, false);
            this.toast.show('Could not update your notification settings.', {
              duration: 4000,
              variant: 'danger',
            });
          }
        },
      });
  }

  /** Show each rule toggle as synced, unless it has a write in flight or awaiting its echo. */
  private readToggles(fresh: boolean): void {
    const pending = this.pending();
    const next = new Map(fresh ? [] : this.state());
    for (const toggle of this.toggles) {
      if (pending.has(toggle.id)) continue;
      const synced = this.push.isOn(toggle);
      const written = this.awaitingSync.get(toggle.id);
      if (!written || written.value === synced) {
        this.forgetSync(toggle.id);
        next.set(toggle.id, synced);
      }
    }
    this.state.set(next);
  }

  private awaitSync(id: string, value: boolean): void {
    this.forgetSync(id);
    const timer = setTimeout(() => {
      this.awaitingSync.delete(id);
      this.readToggles(false);
    }, SYNC_ECHO_LIMIT_MS);
    this.awaitingSync.set(id, { value, timer });
  }

  private forgetSync(id: string): void {
    clearTimeout(this.awaitingSync.get(id)?.timer);
    this.awaitingSync.delete(id);
  }

  private forgetAllSyncs(): void {
    for (const id of [...this.awaitingSync.keys()]) this.forgetSync(id);
  }

  private setState(id: string, on: boolean): void {
    this.state.update((current) => new Map(current).set(id, on));
  }

  private setPending(id: string, on: boolean): void {
    this.pending.update((set) => {
      const next = new Set(set);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }
}
