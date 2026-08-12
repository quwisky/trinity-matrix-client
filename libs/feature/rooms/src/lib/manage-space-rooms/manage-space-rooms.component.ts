import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  RoomsService,
  SpaceChildrenService,
  SpacesService,
  compareOrder,
} from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util/matrix';
import { TrnIconComponent } from '@trinity/helm/icon';

/**
 * How long the write lock survives without an echo. Long enough for a healthy round trip
 * plus the sync that carries it back, short enough that a write which changes nothing does
 * not strand the dialog.
 */
const ECHO_TIMEOUT_MS = 5000;

/** One child row: its link state plus whatever we can resolve about the room itself. */
export interface ManagedChild {
  childId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
  suggested: boolean;
}

/**
 * Dialog to curate a space's child list — which rooms are **suggested**, and the **order**
 * everyone sees them in.
 *
 * Both fields were readable and unwritable before this. The order gap is the one worth
 * naming: #36 shipped space room ordering, but that is a per-account preference that
 * changes what *you* see. The `order` field on `m.space.child` is how an admin arranges
 * the space for *everyone*, and nothing wrote it — so a space owner could curate their own
 * view and had no way to curate the space.
 *
 * The list is driven from synced state via {@link SpaceChildrenService.linksFor}, so what is
 * on screen is what the server has, whoever changed it — a move or a remote edit re-renders
 * from the echo. The single exception is an in-flight `suggested` write, which is overlaid
 * until it settles; {@link pendingSuggested} explains why the checkbox leaves no choice.
 * Names come from the open space's hierarchy where available, since a child the viewer has
 * not joined has no local room to read a name off.
 */
@Component({
  selector: 'trn-manage-space-rooms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, HlmCheckbox, AvatarComponent, TrnIconComponent],
  templateUrl: './manage-space-rooms.component.html',
  styleUrl: './manage-space-rooms.component.scss',
})
export class ManageSpaceRoomsComponent {
  readonly spaceId = input.required<string>();
  readonly spaceName = input('this space');

  private readonly dialogRef =
    inject<DialogRef<boolean, ManageSpaceRoomsComponent>>(DialogRef);
  private readonly children = inject(SpaceChildrenService);
  private readonly rooms = inject(RoomsService);
  private readonly spaces = inject(SpacesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // The lock's safety timer outlives the dialog otherwise — closing mid-write would
    // leave it to fire against a destroyed component.
    this.destroyRef.onDestroy(() => this.releaseEchoLock());
  }

  /** The child currently being written, so its row can show as busy. */
  readonly busyChildId = signal<string | null>(null);

  /** A write the server accepted whose echo has not been projected yet. */
  private readonly echoPending = signal(false);
  private echoTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Dialog-wide write lock: no second curation write until the first one's echo lands.
   *
   * Every curation write is a read-modify-write against live room state, and
   * `sendStateEvent` is a bare PUT with no local echo — so a write issued before the echo
   * reads the PRE-write link and re-sends it. Suggesting a room and immediately moving it
   * silently dropped the suggestion: `writeLink` omits `suggested` when falsy, so the
   * reorder re-sent the link without it and the server took that as the truth.
   *
   * `busyChildId` alone could not gate this — it clears when the PUT resolves, which is a
   * round trip before the state a second write would read catches up — and it is per-row,
   * while the hazard is per-space: any two writes to the same space race, not just two to
   * the same child.
   */
  readonly writeLocked = computed(
    () => this.busyChildId() !== null || this.echoPending(),
  );

  /**
   * `suggested` writes overlaid on the projected links, from the click until the echo.
   *
   * The one place this dialog is deliberately optimistic, and only because the checkbox
   * gives it no choice. `HlmCheckbox.checked` is a `linkedSignal` over the `checked` input
   * which its own click handler sets locally, so it re-derives only when that INPUT
   * changes value. A rejected write leaves the link at `suggested: false` — the same value
   * the input already had — so nothing re-derives and the box stays ticked for a change
   * the server refused. Rolling the overlay back drives the input false→true→false, and
   * that transition is what un-ticks it.
   *
   * **The gap, since it is not obvious:** this only works when the optimistic value was
   * rendered before the rollback, which needs a paint between the two. A server refusal is
   * a network round trip away, so that always holds. `rewriteLink` also has two guards that
   * reject SYNCHRONOUSLY — signed out, and the link having gone — and on those the overlay
   * is set and cleared inside one turn, the input re-binds `false` over `false`, and the
   * box stays ticked. Both need the dialog to outlive its own preconditions; neither is
   * worth an `afterNextRender` dance here, but do not read the rollback as unconditional.
   *
   * `settled` marks a write the server accepted but whose echo has not arrived.
   */
  private readonly pendingSuggested = signal<
    ReadonlyMap<string, { value: boolean; settled: boolean }>
  >(new Map());

  readonly childList = computed<ManagedChild[]>(() => {
    const spaceId = this.spaceId();
    const names = this.nameLookup();
    const pending = this.pendingSuggested();
    const nameFor = (childId: string): string =>
      names.get(childId)?.name ?? childId;
    return (
      this.children
        .linksFor(spaceId)()
        // Copy first: the array belongs to the projection's signal, and sort mutates.
        .slice()
        // The service tiebreaks on child id because it reads `m.space.child` alone —
        // a child the viewer has not joined has no local room to take a name from.
        // Names only exist here, so the tiebreak the sidebar uses is applied here too,
        // or an admin arranges the space in an order nobody else reads it in.
        .sort(
          (a, b) =>
            compareOrder(a.order, b.order) ||
            nameFor(a.childId).localeCompare(nameFor(b.childId)),
        )
        .map((link) => {
          const known = names.get(link.childId);
          const name = nameFor(link.childId);
          return {
            childId: link.childId,
            name,
            initial: known?.initial ?? initialOf(name),
            avatarMxc: known?.avatarMxc ?? null,
            suggested: pending.get(link.childId)?.value ?? link.suggested,
          };
        })
    );
  });

  /**
   * Names for the children, best-effort. The hierarchy fetch is consulted first because it
   * covers children the viewer has NOT joined, which have no local room at all; joined
   * rooms and spaces fill in the rest.
   */
  private readonly nameLookup = computed(() => {
    const lookup = new Map<
      string,
      { name: string; initial: string; avatarMxc: string | null }
    >();
    for (const child of this.spaces.openSpaceChildren()) {
      lookup.set(child.roomId, {
        name: child.name,
        initial: child.initial,
        avatarMxc: child.avatarMxc,
      });
    }
    for (const room of this.rooms.rooms()) {
      lookup.set(room.id, {
        name: room.name,
        initial: room.initial,
        avatarMxc: room.avatarMxc,
      });
    }
    for (const space of this.spaces.spaces()) {
      lookup.set(space.id, {
        name: space.name,
        initial: space.initial,
        avatarMxc: space.avatarMxc,
      });
    }
    return lookup;
  });

  isFirst(childId: string): boolean {
    return this.childList()[0]?.childId === childId;
  }

  isLast(childId: string): boolean {
    const list = this.childList();
    return list[list.length - 1]?.childId === childId;
  }

  /**
   * Drop an accepted overlay on the first projection tick after the write settled.
   *
   * Not done in the write callback: the write resolving only means the server took it, and
   * the echo is a sync away. Clearing there would drive the checkbox true→false→true — a
   * visible flicker on the happy path.
   *
   * Deliberately NOT "drop it when the projection agrees". The echo does not always carry
   * the value we wrote: toggle a room suggested and immediately move it, and the reorder
   * is a read-modify-write against state that still holds the pre-write link, so it
   * re-sends without `suggested` and the server genuinely reverts the tick. Both events
   * coalesce into one rebuild, so the value we wrote is never projected — and an overlay
   * waiting to see it would sit there beating the projection until the two happened to
   * coincide. Any tick after the server has answered is enough.
   */
  private readonly pruneSettled = effect(() => {
    this.children.linksFor(this.spaceId())();
    const pending = this.pendingSuggested();
    if (![...pending.values()].some((entry) => entry.settled)) {
      return;
    }
    this.pendingSuggested.update((current) => {
      const next = new Map(current);
      for (const [childId, entry] of current) {
        if (entry.settled) {
          next.delete(childId);
        }
      }
      return next;
    });
  });

  /** Flag a child as suggested — a hint to members about where to start. */
  toggleSuggested(childId: string, suggested: boolean): void {
    if (this.writeLocked()) {
      return;
    }
    this.pendingSuggested.update((current) =>
      new Map(current).set(childId, { value: suggested, settled: false }),
    );
    this.run(
      childId,
      this.children.setSuggested(this.spaceId(), childId, suggested),
      'Could not update that room.',
      // Accepted: hold the overlay until a projection tick, so the tick does not flicker
      // off and back on while the echo is in flight.
      () => this.markSettled(childId),
      // Refused: drop it now. That transition is what un-ticks the box.
      () => this.dropPending(childId),
    );
  }

  private markSettled(childId: string): void {
    this.pendingSuggested.update((current) => {
      const entry = current.get(childId);
      return entry
        ? new Map(current).set(childId, { ...entry, settled: true })
        : current;
    });
  }

  private dropPending(childId: string): void {
    this.pendingSuggested.update((current) => {
      if (!current.has(childId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(childId);
      return next;
    });
  }

  move(childId: string, direction: 'up' | 'down'): void {
    if (this.writeLocked()) {
      return;
    }
    const list = this.childList();
    const index = list.findIndex((child) => child.childId === childId);
    if (index === -1) {
      return;
    }
    // Positions are computed against the list WITHOUT the moving child, because that is
    // the list it is being re-inserted into — using the original indices would move it
    // two places in one direction and none in the other.
    const remaining = list.filter((child) => child.childId !== childId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target > remaining.length) {
      return;
    }
    const before = remaining[target]?.childId ?? null;
    this.run(
      childId,
      this.children.moveChildBefore(this.spaceId(), childId, before),
      'Could not reorder that room.',
    );
  }

  close(): void {
    this.dialogRef.close(true);
  }

  /**
   * Hold the lock from the server's answer until the projection catches up.
   *
   * Released by {@link releaseOnEcho} on the next projection tick — or by the timer, which
   * is the safety valve: a write the server answers without changing state (re-suggesting
   * an already-suggested room, or a reorder that mints the key the child already had)
   * produces no echo at all, and a lock nothing can release would be worse than the race
   * it prevents.
   */
  private holdUntilEcho(): void {
    this.echoPending.set(true);
    if (this.echoTimer !== null) {
      clearTimeout(this.echoTimer);
    }
    this.echoTimer = setTimeout(() => this.releaseEchoLock(), ECHO_TIMEOUT_MS);
  }

  private releaseEchoLock(): void {
    if (this.echoTimer !== null) {
      clearTimeout(this.echoTimer);
      this.echoTimer = null;
    }
    this.echoPending.set(false);
  }

  /**
   * The projection moved, so whatever we were waiting for has landed. Reads `echoPending`
   * untracked: this effect must depend on the links alone, or clearing the flag would
   * re-enter it.
   */
  private readonly releaseOnEcho = effect(() => {
    this.children.linksFor(this.spaceId())();
    if (untracked(() => this.echoPending())) {
      this.releaseEchoLock();
    }
  });

  private run(
    childId: string,
    action: ReturnType<SpaceChildrenService['setSuggested']>,
    failureMessage: string,
    accepted?: () => void,
    rejected?: () => void,
  ): void {
    this.busyChildId.set(childId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        // Nothing to nudge: the list follows the sync echo. A post-write bump could never
        // have worked anyway — `sendStateEvent` is a bare PUT with no local echo, so at
        // this instant the room state still holds the PRE-write content.
        this.busyChildId.set(null);
        this.holdUntilEcho();
        accepted?.();
      },
      error: () => {
        this.busyChildId.set(null);
        this.releaseEchoLock();
        rejected?.();
        this.toast.show(failureMessage, {
          duration: 4000,
          variant: 'destructive',
        });
      },
    });
  }
}
