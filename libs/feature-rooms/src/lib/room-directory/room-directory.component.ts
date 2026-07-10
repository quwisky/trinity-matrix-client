import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  PublicRoomsService,
  type PublicRoomSummary,
} from '@trinity/data-access-rooms';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util-matrix';

/**
 * Dialog to browse and join rooms from the homeserver's public directory. Loads the
 * first page on open, filters on a search term, and paginates with "Load more". Joining
 * a room closes the dialog resolving the joined room's ID so the host can select it;
 * closing otherwise resolves null. Presented via {@link TrnDialogService}.
 */
@Component({
  selector: 'trn-room-directory',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-directory.component.html',
  imports: [ReactiveFormsModule, HlmButton, HlmInput, AvatarComponent],
})
export class RoomDirectoryComponent implements OnInit {
  private readonly dialogRef =
    inject<DialogRef<string | null, RoomDirectoryComponent>>(DialogRef);
  private readonly directory = inject(PublicRoomsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly query = new FormControl('', { nonNullable: true });

  /** The rooms found so far (accumulated across pages). */
  readonly rooms = signal<readonly PublicRoomSummary[]>([]);
  /** Pagination token for the next page, or null when there are no more. */
  private readonly nextBatch = signal<string | null>(null);
  /** True while a search / load-more request is in flight. */
  readonly loading = signal(false);
  /** Last search failure, or null. */
  readonly error = signal<string | null>(null);
  /** The room ID currently being joined (disables its Join button), or null. */
  readonly joining = signal<string | null>(null);

  readonly hasMore = computed(() => this.nextBatch() !== null);
  readonly isEmpty = computed(
    () => !this.loading() && this.rooms().length === 0,
  );

  ngOnInit(): void {
    this.runSearch(true);
  }

  /** Run a fresh search from the current query term. */
  search(): void {
    this.runSearch(true);
  }

  /** Append the next page of results for the current term. */
  loadMore(): void {
    this.runSearch(false);
  }

  initialFor(room: PublicRoomSummary): string {
    return initialOf(room.name);
  }

  /** Join the room (by alias when it has one, else ID); close resolving its ID. */
  join(room: PublicRoomSummary): void {
    if (this.joining()) {
      return;
    }
    this.joining.set(room.roomId);
    this.directory
      .join(room.alias ?? room.roomId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (roomId) => this.dialogRef.close(roomId),
        error: () => {
          this.joining.set(null);
          this.toast.show(`Could not join ${room.name}.`, {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  close(): void {
    this.dialogRef.close(null);
  }

  private runSearch(reset: boolean): void {
    if (this.loading()) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const since = reset ? undefined : (this.nextBatch() ?? undefined);
    this.directory
      .search({ term: this.query.value, since })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.rooms.update((current) =>
            reset ? page.rooms : [...current, ...page.rooms],
          );
          this.nextBatch.set(page.nextBatch);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.error.set('Could not load the room directory.');
        },
      });
  }
}
