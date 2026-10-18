import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DateTimeFormatService } from '@trinity/platform-native';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnDialogShellComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import {
  EmptyStateComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import {
  EditHistoryService,
  type EditRevisionView,
} from '@trinity/data-access/timeline';
import { annotateRevision } from '@trinity/util/matrix';
import { filter, switchMap, timer } from 'rxjs';
import { runWithBusy } from '@trinity/util/ui';
import { MatrixHtmlDirective } from '../message-presentation/matrix-html.directive';
import {
  type MatrixLinkClick,
  type MatrixLinkClickTarget,
} from '../matrix-link/matrix-link.directive';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';

/** A revision plus the label that orients the reader, and what changed to reach it. */
interface RevisionEntry extends EditRevisionView {
  label: string;
  /** This version's HTML with the edit's changes marked, or null when there is none. */
  diffHtml: string | null;
}

/**
 * Delay before re-reading history after a removal: the homeserver needs a moment to apply
 * the redaction to its relations view, or it can return the removed version.
 */
const REFRESH_DELAY_MS = 600;

/**
 * Dialog listing every version of an edited message, oldest first, each rendered the way
 * the timeline renders it. Fetches its own history so the opening marker responds at once.
 */
@Component({
  selector: 'trn-edit-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './edit-history.component.html',
  styleUrl: './edit-history.component.scss',
  imports: [
    UnencryptedMarkComponent,
    EmptyStateComponent,
    MatrixHtmlDirective,
    TrnButton,
    TrnSpinnerComponent,
    TrnDialogShellComponent,
  ],
})
export class EditHistoryComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  readonly roomId = input.required<string>();
  readonly eventId = input.required<string>();

  private readonly history = inject(EditHistoryService);
  private readonly dialogRef =
    inject<TrnDialogRef<MatrixLinkClickTarget | undefined>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  /** Versions removed in this dialog, so a stale refetch cannot put one back. */
  private readonly removed = new Set<string>();
  /** The message already fetched, so a re-run of the effect can't refetch it. */
  private fetched: string | null = null;

  private readonly revisions = signal<EditRevisionView[]>([]);
  /** True when the message has more versions than we could fetch. */
  readonly truncated = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether to highlight what each edit changed. Off restores the exact as-sent rendering
   * (a deleted run is re-inserted as plain text, so it loses its own formatting).
   */
  readonly showDiff = signal(true);

  /**
   * The versions to render. Only the ends are labelled; a lone entry is the original, never
   * "Current version". Each version is diffed against the one before it; the original has
   * nothing to compare against.
   */
  readonly entries = computed<RevisionEntry[]>(() => {
    const revisions = this.revisions();
    return revisions.map((revision, index) => {
      const previous = revisions[index - 1];
      return {
        ...revision,
        label:
          index === 0
            ? 'Original'
            : index === revisions.length - 1
              ? 'Current version'
              : 'Edited',
        diffHtml: previous ? annotateRevision(previous, revision) : null,
      };
    });
  });

  /** The revision currently being removed, so its row can say so. */
  readonly removing = signal<string | null>(null);

  /** What each row actually renders, once the diff toggle is taken into account. */
  readonly rows = computed(() => {
    const entries = this.entries();
    return entries.map((entry, index) => {
      const html = this.showDiff()
        ? (entry.diffHtml ?? entry.html)
        : entry.html;
      return {
        ...entry,
        html,
        // A diffed plain-text body still needs its line breaks, so it keeps the plain container.
        rich: entry.html !== null,
        /**
         * Any of your own versions can be removed, including the current one, but not the
         * first row: that is the message itself, and removing it is the timeline's Delete.
         * Removing the NEWEST edit needs the repair in {@link refresh}: the SDK
         * re-aggregates the message back to the ORIGINAL and drops the "(edited)" marker.
         */
        removable: entry.isOwn && index > 0,
      };
    });
  });

  constructor() {
    // The dialog service applies inputs with `setInput` after construction, so required
    // inputs are unreadable until change detection runs; hence an effect.
    effect(() => {
      const roomId = this.roomId();
      const eventId = this.eventId();
      const key = `${roomId}|${eventId}`;
      if (this.fetched === key) {
        return;
      }
      this.fetched = key;
      runWithBusy(this.history.revisions(roomId, eventId), {
        busy: this.busy,
        error: this.error,
        destroyRef: this.destroyRef,
      }).subscribe((result) => {
        this.revisions.set(result.revisions);
        this.truncated.set(result.truncated);
      });
    });
  }

  /**
   * Remove one of your own versions: redact the edit that introduced it, drop the row,
   * then re-read the history (see {@link refresh}). The row goes on the server's word, not
   * the refetch: `/relations` can still return a just-redacted edit.
   */
  remove(revisionId: string): void {
    this.alert
      .confirm$({
        header: 'Delete version',
        message: 'Delete this version of your message? This cannot be undone.',
        confirmText: 'Delete',
        variant: 'danger',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => {
          this.removing.set(revisionId);
          return this.history.removeRevision(this.roomId(), revisionId);
        }),
      )
      // Deliberately NOT tied to the dialog's lifetime: the redaction must complete even if
      // the dialog closes mid-flight.
      .subscribe({
        next: () => {
          this.removed.add(revisionId);
          this.revisions.update((all) =>
            all.filter((r) => r.id !== revisionId),
          );
          this.removing.set(null);
          this.refresh();
        },
        // A failure must not blank the list: the error state replaces everything.
        error: () => {
          this.removing.set(null);
          this.toast.show('Could not delete that version.', {
            variant: 'danger',
          });
        },
      });
  }

  /**
   * Re-read the history after a removal, confirming what is left and repairing the
   * message: removing the newest edit leaves matrix-js-sdk aggregating the message back to
   * its ORIGINAL wording, because it filters relations by a timestamp from the original
   * event's stale bundle. Re-reading the relations re-fetches that event with a fresh
   * bundle. The delay is not cosmetic: `/relations` can still return a just-redacted
   * edit if asked immediately; removed versions stay filtered out regardless.
   */
  private refresh(): void {
    // NOT tied to the dialog's lifetime: the re-read repairs the message on the timeline,
    // even when the user closes the dialog right after removing. Writing to a destroyed
    // component's signals is harmless.
    timer(REFRESH_DELAY_MS)
      .pipe(
        switchMap(() => this.history.revisions(this.roomId(), this.eventId())),
      )
      .subscribe({
        next: (result) => {
          this.revisions.set(
            result.revisions.filter((r) => !this.removed.has(r.id)),
          );
          this.truncated.set(result.truncated);
        },
        // The local removal already reflects what the server accepted.
        error: () => undefined,
      });
  }

  /**
   * A permalink inside an old version: close first and hand the target back, so the
   * opener routes it; following it under the dialog would leave a stale history covering it.
   */
  onMatrixLink({ target }: MatrixLinkClick): void {
    // The anchor is dropped on purpose: the element it would pin to is gone once this closes.
    this.dialogRef.close(target);
  }

  close(): void {
    this.dialogRef.close(undefined);
  }
}
