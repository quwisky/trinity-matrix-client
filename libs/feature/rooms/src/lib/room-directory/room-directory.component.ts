import { type PublicRoomSummary } from '@trinity/data-access/discovery';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, finalize } from 'rxjs';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import { PublicRoomsService } from '@trinity/data-access/discovery';
import {
  AvatarComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
import {
  describeMatrixRequestFailure,
  initialOf,
  matrixRequestErrorHandling,
  reportMatrixRequestFailure,
} from '@trinity/util/matrix';

/** What the directory resolves when a room/space is joined from it. */
export interface DirectoryJoin {
  readonly accountId: string;
  readonly roomId: string;
  readonly isSpace: boolean;
}

/**
 * Dialog to browse and join rooms or Spaces from the homeserver's public directory, with a
 * search term, a Rooms/Spaces toggle and "Load more" pagination. Joining closes it, resolving
 * the joined id and whether it is a space; closing otherwise resolves null. Presented via
 * {@link TrnSurfaceService}.
 */
@Component({
  selector: 'trn-room-directory',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-directory.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnInput,
    AvatarComponent,
    EmptyStateComponent,
    TrnDialogActions,
    TrnDialogShellComponent,
  ],
})
export class RoomDirectoryComponent implements OnInit {
  private readonly dialogRef =
    inject<TrnDialogRef<DirectoryJoin | null>>(TrnDialogRef);
  private readonly directory = inject(PublicRoomsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** The in-flight directory request, so a reset can supersede it. */
  private searchSub?: Subscription;
  private readonly searchModel = signal({ query: '' });
  private readonly nextBatch = signal<string | null>(null);

  readonly accountId = input.required<string>();
  readonly searchForm = form(this.searchModel);

  readonly mode = signal<'rooms' | 'spaces'>('rooms');

  readonly rooms = signal<readonly PublicRoomSummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly joining = signal<string | null>(null);

  readonly hasMore = computed(() => this.nextBatch() !== null);
  readonly isEmpty = computed(
    () => !this.loading() && !this.error() && this.rooms().length === 0,
  );

  ngOnInit(): void {
    this.runSearch(true);
  }

  search(): void {
    this.runSearch(true);
  }

  setMode(mode: 'rooms' | 'spaces'): void {
    if (this.mode() === mode) {
      return;
    }
    this.mode.set(mode);
    this.runSearch(true);
  }

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
      .join(this.accountId(), room.alias ?? room.roomId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.joining.set(null)),
      )
      .subscribe({
        next: (roomId) =>
          this.dialogRef.close({
            accountId: this.accountId(),
            roomId,
            isSpace: room.isSpace,
          }),
        error: (error: unknown) => {
          const handling = matrixRequestErrorHandling(
            'join room from directory',
            `Could not join ${room.name}. Try again.`,
          );
          handling.reportError(error);
          this.toast.show(handling.formatError(error), {
            duration: 4000,
            variant: 'danger',
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
      .search(this.accountId(), {
        term: this.searchModel().query,
        since,
        spaces: this.mode() === 'spaces',
      })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (page) => {
          this.rooms.update((current) =>
            reset ? page.rooms : [...current, ...page.rooms],
          );
          this.nextBatch.set(page.nextBatch);
        },
        error: (error: unknown) => {
          reportMatrixRequestFailure('load room directory', error);
          const failure = describeMatrixRequestFailure(
            error,
            'Could not load the room directory. Try again.',
          );
          this.error.set(
            failure.kind === 'unexpected'
              ? 'Could not load the room directory.'
              : failure.message,
          );
          // On a failed RESET (new term or rooms/spaces switch) drop the previous results and
          // token: stale room hits would render under "Explore spaces" and "Load more" would
          // page the spaces directory with the rooms token. A failed load-MORE keeps them;
          // the existing page is still valid.
          if (reset) {
            this.rooms.set([]);
            this.nextBatch.set(null);
          }
        },
      });
  }
}
