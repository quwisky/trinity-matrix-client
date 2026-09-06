import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton, TrnCheckboxComponent } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  AvatarComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
import {
  SpaceContentsService,
  type SpaceChildLink,
  type SpaceContentsItem,
  type SpaceContentsTarget,
  type SpaceChildWriteReceipt,
} from '@trinity/data-access/room-library';
import type { Observable, Subscription } from 'rxjs';

type CurationIntent =
  | {
      readonly kind: 'suggested';
      readonly childId: string;
      readonly suggested: boolean;
    }
  | {
      readonly kind: 'move';
      readonly childId: string;
      readonly direction: 'up' | 'down';
    };

interface CurationFailure {
  readonly intent: CurationIntent;
  readonly message: string;
}

/** Authoritative child rows and immediate shared curation for one immutable target. */
@Component({
  selector: 'trn-space-settings-contents-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    EmptyStateComponent,
    TrnButton,
    TrnCheckboxComponent,
    TrnIconComponent,
  ],
  templateUrl: './space-settings-contents-list.component.html',
  styleUrl: './space-settings-contents-list.component.scss',
})
export class SpaceSettingsContentsListComponent {
  private readonly contents = inject(SpaceContentsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly busyChildState = signal<string | null>(null);
  private readonly echoPendingState = signal(false);
  private readonly pendingSuggestedState = signal<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  private readonly failureState = signal<CurationFailure | null>(null);
  private echoReceipt: SpaceChildWriteReceipt | null = null;
  private activeWrite: Subscription | null = null;
  private previousTargetKey: string | null = null;

  readonly target = input.required<SpaceContentsTarget>();
  readonly items = input.required<readonly SpaceContentsItem[]>();
  readonly links = input.required<readonly SpaceChildLink[]>();
  readonly canManage = input(false);
  readonly externalBusy = input(false);
  readonly removeRequested = output<SpaceContentsItem>();
  readonly busyChange = output<boolean>();
  readonly busyChild = this.busyChildState.asReadonly();
  readonly failure = this.failureState.asReadonly();
  readonly internalLocked = computed(
    () => this.busyChild() !== null || this.echoPendingState(),
  );
  readonly writeLocked = computed(
    () => this.internalLocked() || this.externalBusy() || !this.canManage(),
  );
  readonly visibleItems = computed(() => {
    const pending = this.pendingSuggestedState();
    return this.items().map((item) => ({
      ...item,
      suggested: pending.get(item.id) ?? item.suggested,
    }));
  });
  readonly writeStatus = computed(() =>
    this.echoPendingState()
      ? 'Waiting for the synced Space update…'
      : this.busyChild()
        ? 'Saving for everyone…'
        : null,
  );

  constructor() {
    effect(() => this.busyChange.emit(this.internalLocked()));
    effect(() => {
      const receipt = this.echoReceipt;
      if (this.echoPendingState() && receiptMatches(this.links(), receipt)) {
        this.releaseEchoLock();
      }
    });
    effect(() => {
      const target = this.target();
      const key = `${target.accountId}\u0000${target.spaceId}`;
      const changed =
        this.previousTargetKey !== null && this.previousTargetKey !== key;
      this.previousTargetKey = key;
      if (changed) {
        untracked(() => {
          this.failureState.set(null);
          this.abortWrite();
        });
      } else if (!this.canManage()) {
        untracked(() => this.abortWrite());
      }
    });
    this.destroyRef.onDestroy(() => this.abortWrite());
  }

  isFirst(childId: string): boolean {
    return this.visibleItems()[0]?.id === childId;
  }

  isLast(childId: string): boolean {
    const list = this.visibleItems();
    return list[list.length - 1]?.id === childId;
  }

  toggleSuggested(childId: string, suggested: boolean): void {
    this.runIntent({ kind: 'suggested', childId, suggested });
  }

  move(childId: string, direction: 'up' | 'down'): void {
    this.runIntent({ kind: 'move', childId, direction });
  }

  retry(): void {
    const failure = this.failure();
    if (failure) this.runIntent(failure.intent);
  }

  requestRemove(item: SpaceContentsItem): void {
    if (!this.writeLocked()) this.removeRequested.emit(item);
  }

  private runIntent(intent: CurationIntent): void {
    if (this.writeLocked()) return;
    const item = this.items().find(({ id }) => id === intent.childId);
    if (!item) return;

    let action: Observable<SpaceChildWriteReceipt>;
    if (intent.kind === 'suggested') {
      this.pendingSuggestedState.update((current) =>
        new Map(current).set(intent.childId, intent.suggested),
      );
      action = this.contents.setSuggested(
        this.target(),
        intent.childId,
        intent.suggested,
      );
    } else {
      const before = this.beforeChildId(intent.childId, intent.direction);
      if (before === undefined) return;
      action = this.contents.moveChildBefore(
        this.target(),
        intent.childId,
        before,
      );
    }

    this.failureState.set(null);
    this.busyChildState.set(intent.childId);
    const subscription = action
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (receipt) => {
          this.busyChildState.set(null);
          this.echoReceipt = receipt;
          this.holdUntilEcho();
        },
        error: (error: unknown) => {
          this.busyChildState.set(null);
          this.echoReceipt = null;
          this.dropPendingSuggested(intent.childId);
          this.failureState.set({
            intent,
            message: failureMessage(item.name, intent, error),
          });
        },
        complete: () => {
          this.activeWrite = null;
        },
      });
    this.activeWrite = subscription.closed ? null : subscription;
  }

  /** `null` means append; `undefined` means the move is not permitted. */
  private beforeChildId(
    childId: string,
    direction: 'up' | 'down',
  ): string | null | undefined {
    const list = this.items();
    const index = list.findIndex(({ id }) => id === childId);
    if (index === -1) return undefined;
    const remaining = list.filter(({ id }) => id !== childId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target > remaining.length) return undefined;
    return remaining[target]?.id ?? null;
  }

  private holdUntilEcho(): void {
    this.echoPendingState.set(true);
    if (receiptMatches(this.links(), this.echoReceipt)) {
      this.releaseEchoLock();
    }
  }

  private releaseEchoLock(): void {
    this.echoPendingState.set(false);
    this.echoReceipt = null;
    this.pendingSuggestedState.set(new Map());
  }

  private dropPendingSuggested(childId: string): void {
    this.pendingSuggestedState.update((current) => {
      if (!current.has(childId)) return current;
      const next = new Map(current);
      next.delete(childId);
      return next;
    });
  }

  private abortWrite(): void {
    this.activeWrite?.unsubscribe();
    this.activeWrite = null;
    this.busyChildState.set(null);
    this.releaseEchoLock();
  }
}

function receiptMatches(
  links: readonly SpaceChildLink[],
  receipt: SpaceChildWriteReceipt | null,
): boolean {
  return (
    receipt !== null &&
    receipt.expectedLinks.every((expected) => {
      const link = links.find(({ childId }) => childId === expected.childId);
      return (
        link?.order === expected.order &&
        link.suggested === expected.suggested &&
        sameStrings(link.via, expected.via)
      );
    })
  );
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function failureMessage(
  name: string,
  intent: CurationIntent,
  error: unknown,
): string {
  const action =
    intent.kind === 'suggested'
      ? intent.suggested
        ? 'mark as Suggested'
        : 'remove from Suggested'
      : `move ${intent.direction}`;
  return `${name} could not ${action}: ${messageOf(error)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
