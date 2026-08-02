import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronUp } from '@ng-icons/lucide';
import { HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  RoomsService,
  SpaceChildrenService,
  SpacesService,
} from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util-matrix';

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
 * The list is driven from synced state via {@link SpaceChildrenService.childLinks}, so a
 * move or a toggle re-renders from the echo rather than from optimistic local edits: what
 * is on screen is what the server has. Names come from the open space's hierarchy where
 * available, since a child the viewer has not joined has no local room to read a name off.
 */
@Component({
  selector: 'trn-manage-space-rooms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, HlmCheckbox, AvatarComponent, NgIcon],
  providers: [provideIcons({ lucideChevronUp, lucideChevronDown })],
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

  /** Bumped after every write so the state-derived list re-reads. */
  private readonly revision = signal(0);
  /** The child currently being written, so its row can show as busy. */
  readonly busyChildId = signal<string | null>(null);

  readonly childList = computed<ManagedChild[]>(() => {
    this.revision();
    const spaceId = this.spaceId();
    const names = this.nameLookup();
    return this.children.childLinks(spaceId).map((link) => {
      const known = names.get(link.childId);
      const name = known?.name ?? link.childId;
      return {
        childId: link.childId,
        name,
        initial: known?.initial ?? initialOf(name),
        avatarMxc: known?.avatarMxc ?? null,
        suggested: link.suggested,
      };
    });
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

  /** Flag a child as suggested — a hint to members about where to start. */
  toggleSuggested(childId: string, suggested: boolean): void {
    this.run(
      childId,
      this.children.setSuggested(this.spaceId(), childId, suggested),
      'Could not update that room.',
    );
  }

  move(childId: string, direction: 'up' | 'down'): void {
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

  private run(
    childId: string,
    action: ReturnType<SpaceChildrenService['setSuggested']>,
    failureMessage: string,
  ): void {
    this.busyChildId.set(childId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busyChildId.set(null);
        // The write has landed but the state echo is a sync away, so nudge the read.
        this.revision.update((value) => value + 1);
      },
      error: () => {
        this.busyChildId.set(null);
        this.toast.show(failureMessage, {
          duration: 4000,
          variant: 'destructive',
        });
      },
    });
  }
}
