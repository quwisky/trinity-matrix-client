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
  TrnOverlaySurfaceDirective,
  TrnToastService,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { EditHistoryService } from '@trinity/data-access/timeline';
import {
  annotateRevision,
  type MessageRevisionView,
} from '@trinity/util/matrix';
import { filter, switchMap, timer } from 'rxjs';
import { runWithBusy } from '@trinity/util/ui';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import {
  type MatrixLinkClick,
  type MatrixLinkClickTarget,
} from '../matrix-link/matrix-link.directive';
import { MatrixLinkDirective } from '../matrix-link/matrix-link.directive';
import { InlineMxcImagesDirective } from '../inline-mxc-images/inline-mxc-images.directive';

/** A revision plus the label that orients the reader, and what changed to reach it. */
interface RevisionEntry extends MessageRevisionView {
  label: string;
  /** This version's HTML with the edit's changes marked, or null when there is none. */
  diffHtml: string | null;
}

/**
 * How long to wait before re-reading the history after a removal. The homeserver needs a
 * moment to apply the redaction to its relations view; asking straight away can hand back
 * the version that was just removed.
 */
const REFRESH_DELAY_MS = 600;

/**
 * Dialog listing every version of an edited message, oldest first, each rendered the way
 * the timeline renders it. Fetches its own history (rather than being handed it) so the
 * marker that opens it responds immediately and the wait is shown here.
 */
@Component({
  selector: 'trn-edit-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './edit-history.component.html',
  styleUrl: './edit-history.component.scss',
  imports: [
    TrnButton,
    TrnSpinnerComponent,
    TrnOverlaySurfaceDirective,
    SpoilerRevealDirective,
    MatrixLinkDirective,
    InlineMxcImagesDirective,
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

  private readonly revisions = signal<MessageRevisionView[]>([]);
  /** True when the message has more versions than we could fetch. */
  readonly truncated = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether to highlight what each edit changed. On by default — "what changed" is the
   * question the dialog exists to answer — but a reader who came to read an old version
   * rather than compare can turn it off, which also restores the exact as-sent rendering
   * (a deleted run is re-inserted as plain text, so it loses its own formatting).
   */
  readonly showDiff = signal(true);

  /**
   * The versions to render. Only the ends are named — they are what a reader orients by
   * ("what did it say first" / "what does it say now"); the ones between are just edits.
   * A lone entry is the original and nothing else, so it is never "Current version".
   *
   * Each version is annotated against the one before it, so a row reads as "what this
   * edit changed" — matching its label. The original has nothing to compare against.
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
        // A formatted body renders as markdown; a diffed plain-text body still needs its
        // line breaks, so it keeps the plain container's white-space.
        rich: entry.html !== null,
        /**
         * Any of your own versions can be removed — including the current one.
         *
         * Not the first row: that is the message itself rather than a revision, and
         * removing it is the timeline's Delete action wearing a different label (the
         * history then refuses to load at all, by design).
         *
         * Removing the NEWEST edit needs the repair in {@link refresh}: measured against a
         * live server, the SDK re-aggregates the message back to the ORIGINAL instead of
         * the version before it, and drops the "(edited)" marker with it.
         */
        removable: entry.isOwn && index > 0,
      };
    });
  });

  constructor() {
    // The dialog service applies inputs with `setInput` *after* construction, so the
    // required inputs cannot be read until change detection runs — hence an effect
    // rather than a constructor fetch.
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
   * then re-read the history to confirm it and repair the message (see {@link refresh}).
   *
   * The row goes on the server's word rather than on the refetch — `/relations` can still
   * return a just-redacted edit intact, so waiting for it would look like a failure.
   */
  remove(revisionId: string): void {
    this.alert
      .confirm$({
        header: 'Remove version',
        message: 'Remove this version of your message? This cannot be undone.',
        confirmText: 'Remove',
        variant: 'danger',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => {
          this.removing.set(revisionId);
          return this.history.removeRevision(this.roomId(), revisionId);
        }),
      )
      // Deliberately NOT tied to the dialog's lifetime: if it closes mid-flight the
      // redaction still happens, and a failure the user never hears about is worse than a
      // subscription that outlives the component by one request.
      .subscribe({
        next: () => {
          this.removed.add(revisionId);
          this.revisions.update((all) =>
            all.filter((r) => r.id !== revisionId),
          );
          this.removing.set(null);
          this.refresh();
        },
        // A failure must not blank the list — the dialog's error state replaces everything,
        // and one row failing is no reason to lose the history.
        error: () => {
          this.removing.set(null);
          this.toast.show('Could not remove that version.');
        },
      });
  }

  /**
   * Re-read the history from the server after a removal.
   *
   * Two jobs. It confirms what is actually left — and, more importantly, it repairs the
   * message itself: removing the newest edit leaves matrix-js-sdk aggregating the message
   * back to its ORIGINAL wording rather than the version before it, because it filters
   * relations by a timestamp taken from the original event's stale bundle. Re-reading the
   * relations re-fetches that event with a fresh bundle, which is what puts the timeline
   * right.
   *
   * The delay is not cosmetic: `/relations` can still return a just-redacted edit intact
   * if asked immediately. Anything we removed stays filtered out regardless, so a stale
   * answer can never resurrect a row.
   */
  private refresh(): void {
    // NOT tied to the dialog's lifetime, for the same reason as the removal itself: the
    // re-read is what repairs the message on the timeline, and a user who removes a
    // version and immediately closes the dialog is the most likely user of all. Writing
    // to a destroyed component's signals is harmless; leaving the timeline showing the
    // wrong version is not.
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
        // The local removal already reflects what the server accepted; a failed refresh
        // is not worth telling the user about.
        error: () => undefined,
      });
  }

  /**
   * A permalink inside an old version: close first and hand the target back, so the
   * opener routes it. Following it under the dialog would leave the reader on a new
   * message with a stale history still covering it.
   */
  onMatrixLink({ target }: MatrixLinkClick): void {
    // The anchor is dropped on purpose: this closes first, so by the time the opener
    // presents anything the element it would have been pinned to is gone.
    this.dialogRef.close(target);
  }

  close(): void {
    this.dialogRef.close(undefined);
  }
}
