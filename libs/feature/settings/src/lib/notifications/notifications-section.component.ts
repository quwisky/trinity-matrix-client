import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { TrnToastService } from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NotificationSoundService,
  PushRulesService,
  ReactionNotificationSettingsService,
  type PushRuleToggle,
} from '@trinity/data-access/notifications';
import { KeywordRulesBlockComponent } from './keyword-rules-block.component';
import { PushGatewayBlockComponent } from './push-gateway-block.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading/settings-section-heading.component';
import { SettingsToggleRowDirective } from '../shared/settings-toggle-row.directive';

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
    TrnSwitchComponent,
    KeywordRulesBlockComponent,
    PushGatewayBlockComponent,
    SettingsSectionHeadingComponent,
    SettingsToggleRowDirective,
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
  private reactionAccountId: string | null | undefined;
  private reactionWriteGeneration = 0;

  /**
   * Key for the sound switch in the same optimistic state/pending maps as the rule toggles.
   * Not a rule id: it stands for the `sound` tweak across SEVEN predefined rules at once, so
   * it cannot borrow any single one of theirs.
   */
  protected readonly soundKey = 'trinity.notification-sound';
  // Internal pending-map identity; the persisted account-data key belongs to the service.
  protected readonly reactionsKey = 'reaction-notifications';

  constructor() {
    effect(() => {
      const accountId = this.matrix.activeUserId();
      if (
        this.reactionAccountId !== undefined &&
        this.reactionAccountId !== accountId
      ) {
        this.reactionWriteGeneration += 1;
        this.state.update((current) => {
          const next = new Map(current);
          next.delete(this.reactionsKey);
          return next;
        });
        this.pending.update((current) => {
          const next = new Set(current);
          next.delete(this.reactionsKey);
          return next;
        });
      }
      this.reactionAccountId = accountId;
    });
  }

  ngOnInit(): void {
    const seeded = new Map<string, boolean>();
    for (const toggle of this.toggles) {
      seeded.set(toggle.id, this.push.isOn(toggle));
    }
    this.state.set(seeded);
    // Tracks account data, so a value that arrives after this page has rendered (a cold
    // load, or a change made on another device) still shows.
    this.sound.connect();
    this.reactions.connect();
  }

  ngOnDestroy(): void {
    this.sound.disconnect();
    this.reactions.disconnect();
  }

  /**
   * The optimistic value while a write is in flight, otherwise whatever the account says.
   * Seeding once was not enough: on a cold load this page can render before the initial
   * sync delivers account data.
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
    this.sound
      .setOn(on)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.setPending(this.soundKey, false),
        error: () => {
          this.setState(this.soundKey, !on);
          this.setPending(this.soundKey, false);
          this.toast.show('Could not update your notification settings.', {
            variant: 'danger',
          });
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
    const generation = this.reactionWriteGeneration;
    this.reactions
      .setOn(on)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (this.isCurrentReactionWrite(accountId, generation)) {
            this.setPending(this.reactionsKey, false);
          }
        },
        error: () => {
          if (this.isCurrentReactionWrite(accountId, generation)) {
            this.setState(this.reactionsKey, !on);
            this.setPending(this.reactionsKey, false);
            this.toast.show('Could not update your notification settings.', {
              variant: 'danger',
            });
          }
        },
      });
  }

  private isCurrentReactionWrite(
    accountId: string | null,
    generation: number,
  ): boolean {
    return (
      this.reactionWriteGeneration === generation &&
      this.matrix.activeUserId() === accountId
    );
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
    this.push
      .setOn(toggle, on)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.setPending(toggle.id, false),
        error: () => {
          this.setState(toggle.id, !on); // revert the optimistic flip
          this.setPending(toggle.id, false);
          this.toast.show('Could not update your notification settings.', {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
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
