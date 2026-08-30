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
import { FormField, form } from '@angular/forms/signals';
import { TrnButton } from '@trinity/components/controls';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnCheckboxComponent } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  RoomLibraryService,
  SpaceChildrenService,
  SpacesService,
} from '@trinity/data-access/room-library';
import {
  AvatarComponent,
  type AvatarShape,
} from '@trinity/components/generic-content';
import { saveFields, type FieldWrite } from '../shared/save-fields';

/** A room or space offered for adding, flattened so one list can hold both. */
export interface AddCandidate {
  id: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
  isSpace: boolean;
  shape: AvatarShape;
}

/**
 * Dialog to add rooms you are already in to a space.
 *
 * Until this existed a room could only join a space by being *created* in it
 * (`SpacesService.createRoomInSpace`), so an existing conversation could never be
 * organised into one — the gap `removeRoomFromSpace` has had a counterpart for since the
 * beginning.
 *
 * Spaces are offered alongside rooms, because nesting an existing space is the same
 * write: an `m.space.child` link whose target happens to be a space. That covers the
 * "nest a subspace" half of the hierarchy work without a second surface, and the list
 * labels which is which so the choice is never accidental.
 *
 * Multi-select rather than add-on-click: organising a space is a batch job, and each
 * link is its own state event, so committing them together lets one failure be reported
 * against the room it belongs to instead of collapsing into "something went wrong".
 */
@Component({
  selector: 'trn-add-to-space',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    FormField,
    TrnButton,
    TrnCheckboxComponent,
    TrnInput,
    AvatarComponent,
  ],
  templateUrl: './add-to-space.component.html',
  styleUrl: './add-to-space.component.scss',
})
export class AddToSpaceComponent {
  /** The space being added to. */
  readonly spaceId = input.required<string>();
  readonly spaceName = input('this space');

  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly rooms = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);
  private readonly children = inject(SpaceChildrenService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The search box. `form` treats the model signal as its source of truth rather than
   * copying it, so `searchModel()` IS the live value — no `valueChanges` to project.
   */
  private readonly searchModel = signal({ query: '' });
  readonly search = form(this.searchModel);

  /** True while the add writes are in flight. */
  readonly adding = signal(false);
  private readonly selected = signal<ReadonlySet<string>>(new Set());

  /**
   * Everything the user could add: their joined rooms and spaces, minus the target space
   * itself and anything already linked into it.
   *
   * Reading the space's links rather than the hierarchy fetch is deliberate — they come
   * from synced state, so a room added in this dialog disappears from the list as soon as
   * the write echoes back, without a round trip. `linksFor` is what makes that a declared
   * dependency: the plain `childLinks()` read this used to do is a snapshot, and the list
   * only refreshed because `rooms()` happened to tick in the same turn.
   */
  readonly candidates = computed<AddCandidate[]>(() => {
    const spaceId = this.spaceId();
    const existing = new Set(
      this.children
        .linksFor(spaceId)()
        .map((link) => link.childId),
    );
    const rooms: AddCandidate[] = this.rooms
      .rooms()
      .filter((room) => !existing.has(room.id))
      .map((room) => ({
        id: room.id,
        name: room.name,
        initial: room.initial,
        avatarMxc: room.avatarMxc,
        isSpace: false,
        shape: room.directUserId ? 'person' : 'place',
      }));
    const spaces: AddCandidate[] = this.spaces
      .spaces()
      // A space cannot contain itself, and offering it invites a link the server would
      // take and no client could render sensibly.
      .filter((space) => space.id !== spaceId && !existing.has(space.id))
      .map((space) => ({
        id: space.id,
        name: space.name,
        initial: space.initial,
        avatarMxc: space.avatarMxc,
        isSpace: true,
        shape: 'place',
      }));
    return [...rooms, ...spaces].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** {@link candidates} narrowed by the search box. */
  readonly visible = computed(() => {
    const term = this.searchModel().query.trim().toLowerCase();
    if (!term) {
      return this.candidates();
    }
    return this.candidates().filter((candidate) =>
      candidate.name.toLowerCase().includes(term),
    );
  });

  readonly selectedCount = computed(() => this.selected().size);

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string, checked: boolean): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  /** Link every selected room into the space, reporting what did and didn't land. */
  add(): void {
    const spaceId = this.spaceId();
    const chosen = this.candidates().filter((candidate) =>
      this.selected().has(candidate.id),
    );
    if (chosen.length === 0) {
      this.dialogRef.close(false);
      return;
    }
    const writes: FieldWrite[] = chosen.map((candidate) => ({
      field: candidate.name,
      op: this.children.addExistingRoom(spaceId, candidate.id),
    }));
    this.adding.set(true);
    saveFields(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        if (failed.length === 0) {
          this.toast.show(
            saved.length === 1
              ? `Added ${saved[0]} to ${this.spaceName()}.`
              : `Added ${saved.length} rooms to ${this.spaceName()}.`,
            { duration: 3000, variant: 'success' },
          );
          this.dialogRef.close(true);
          return;
        }
        this.adding.set(false);
        this.toast.show(
          saved.length
            ? `Added ${saved.join(' and ')}, but couldn’t add ${failed.join(' and ')}.`
            : `Could not add ${failed.join(' and ')}.`,
          { duration: 4000, variant: 'destructive' },
        );
      });
  }

  close(): void {
    this.dialogRef.close(false);
  }
}
