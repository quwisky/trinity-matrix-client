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
import { Subscription } from 'rxjs';
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

/** What the directory resolves when a room/space is joined from it. */
export interface DirectoryJoin {
  roomId: string;
  isSpace: boolean;
}

/**
 * Dialog to browse and join rooms — or Spaces — from the homeserver's public directory.
 * Loads the first page on open, filters on a search term, toggles between Rooms and
 * Spaces, and paginates with "Load more". Joining closes the dialog resolving the joined
 * id + whether it's a space so the host can open it appropriately; closing otherwise
 * resolves null. Presented via {@link TrnDialogService}.
 */
@Component({
  selector: 'trn-room-directory',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-directory.component.html',
  imports: [ReactiveFormsModule, HlmButton, HlmInput, AvatarComponent],
})
export class RoomDirectoryComponent implements OnInit {
  private readonly dialogRef =
    inject<DialogRef<DirectoryJoin | null, RoomDirectoryComponent>>(DialogRef);
  private readonly directory = inject(PublicRoomsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** The in-flight directory request, so a reset can supersede it. */
  private searchSub?: Subscription;

  readonly query = new FormControl('', { nonNullable: true });

  /** Browse normal rooms or Spaces. */
  readonly mode = signal<'rooms' | 'spaces'>('rooms');

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

  /**
   * Handle the search form's native submit. The `<form>` has no Angular form
   * directive (a lone `[formControl]`, no `[formGroup]`), so `ngSubmit` never binds
   * and the browser would otherwise navigate away — prevent that and run the search.
   */
  onSubmit(event: Event): void {
    event.preventDefault();
    this.search();
  }

  /** Run a fresh search from the current query term. */
  search(): void {
    this.runSearch(true);
  }

  /** Switch between browsing rooms and Spaces, re-running the search. */
  setMode(mode: 'rooms' | 'spaces'): void {
    if (this.mode() === mode) {
      return;
    }
    this.mode.set(mode);
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
        next: (roomId) =>
          this.dialogRef.close({ roomId, isSpace: room.isSpace }),
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
      // A reset (new term / Rooms↔Spaces switch) supersedes an in-flight request;
      // a load-more must not stack behind one, so it still bails.
      if (!reset) {
        return;
      }
      this.searchSub?.unsubscribe();
    }
    this.loading.set(true);
    this.error.set(null);
    const since = reset ? undefined : (this.nextBatch() ?? undefined);
    this.searchSub = this.directory
      .search({
        term: this.query.value,
        since,
        spaces: this.mode() === 'spaces',
      })
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
