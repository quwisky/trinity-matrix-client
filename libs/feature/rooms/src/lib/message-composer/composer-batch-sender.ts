import {
  computed,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { type Mention } from '@trinity/util/matrix';
import {
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';

/** What the sender needs from the composer around it. */
export interface ComposerBatchPorts {
  /** Upload fraction while an attachment uploads, else null — a signal input, so it lags. */
  readonly uploadProgress: Signal<BatchProgress | null>;
  /** The conversation this composer is showing right now. */
  readonly roomId: Signal<string | null>;
  /** The composer's text, which a send empties and a lost caption restores. */
  readonly text: WritableSignal<string>;
  /** Hand a batch to the owner, which performs the upload. */
  readonly send: (event: {
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }) => void;
  /** Post a batch caption as its own message. */
  readonly sendCaption: (event: { text: string; mentions: Mention[] }) => void;
  /** Take a delivered file out of the strip. */
  readonly removeStaged: (id: string) => void;
  /** Mark exactly these staged rows as failed. */
  readonly markFailed: (ids: readonly string[]) => void;
  /** Per-room draft storage, for a caption whose room is no longer open. */
  readonly drafts: {
    get(roomId: string): string;
    set(roomId: string, text: string): void;
  };
  /** Re-measure the input after the DOM catches up with a text write. */
  readonly regrow: () => void;
}

/**
 * Turns what is staged into outgoing batches, and reconciles what comes back.
 *
 * Pulled out of the component because it is a whole job on its own — the one-at-a-time latch,
 * the in-flight list the progress bar names, and the rules for what survives a partial
 * failure — and none of it touches the DOM or the template. A plain class, like the
 * autocomplete engines and {@link ComposerTextField} beside it.
 */
export class ComposerBatchSender {
  /**
   * The batch currently going out.
   *
   * The progress bar renders above the rows that are still staged, and without this it reads
   * as though it describes them — it describes the one that just left the list. Written here
   * rather than at the call site, because this is the single funnel every upload passes
   * through: a GIF goes straight to it and never touches the composer's `submit()`, and
   * naming the last *staged* file while a GIF uploads is worse than not naming anything.
   */
  private readonly sendingItems = signal<readonly BatchItem[]>([]);

  /**
   * A media send has been dispatched and its upload has not finished.
   *
   * Separate from `uploadProgress` and written SYNCHRONOUSLY, which is the whole point:
   * `uploadProgress` is a signal input fed from two component layers up, and a signal input
   * is only written during the parent's change detection — which, zoneless, is scheduled on a
   * rAF/timer race. Two `submit()` calls in one task (a held Enter key, while the first send's
   * `encryptAttachment` janks the frame) would both read `null` and both dispatch. A local
   * flag closes in the same statement that opens it, and is released by the outcomes.
   */
  private readonly sending = signal(false);

  /** Whether a batch is out and has not reported yet. */
  readonly inFlight = this.sending.asReadonly();

  constructor(private readonly ports: ComposerBatchPorts) {}

  /**
   * Forget an in-flight batch without waiting for its outcomes.
   *
   * For a room change only: the upload itself belongs to the page, not to this composer, and
   * survives the switch — but nothing staged here does, so holding the latch would only mute
   * the next room's composer.
   */
  release(): void {
    this.sending.set(false);
  }

  /**
   * The name of the file currently uploading, taken from the batch's own position rather than
   * remembered separately — so it follows the batch through file 2, 3, … instead of naming
   * whatever was dispatched first.
   */
  readonly uploadLabel = computed(() => {
    const progress = this.ports.uploadProgress();
    return progress
      ? (this.sendingItems()[progress.index - 1]?.file.name ?? null)
      : null;
  });

  /**
   * Whether a media send would be accepted right now — the same condition {@link dispatch}
   * enforces, exposed so the send button can SAY it is blocked rather than silently doing
   * nothing. `sending` matters here and not just `uploadProgress`: the latch closes
   * synchronously, while the input it mirrors lags by a change-detection tick.
   */
  readonly canSend = computed(
    () => this.ports.uploadProgress() === null && !this.sending(),
  );

  /**
   * The single funnel every media send passes through: the composer's `submit()` for the
   * staged batch, and the attachments service's `sendMedia` hook for a GIF. The in-flight
   * list, the send latch and the one-at-a-time check all live here, so a path that does not
   * go through `submit()` cannot miss any of them.
   *
   * Returns whether the batch was dispatched, so a caller with cleanup to do — `submit()`
   * clears the text — can tell a refusal from a send.
   */
  dispatch(
    items: readonly BatchItem[],
    caption: string,
    mentions: readonly Mention[],
  ): boolean {
    if (!items.length) {
      return false;
    }
    // Guarded here rather than only on the send button, because `onEnter` calls `submit()`
    // directly and never consults `[disabled]` — key auto-repeat alone is enough to fire it
    // twice. Two batches in flight share one `uploadProgress` and interleave their events, so
    // neither arrives in the order it was staged.
    if (!this.canSend()) {
      return false;
    }
    this.sendingItems.set(items);
    this.sending.set(true);
    // Stamped with the room, like the files themselves are by the owner: a batch settles long
    // after it was pressed, and by then this composer may be showing a different conversation.
    const roomAtDispatch = this.ports.roomId();
    this.ports.send({
      items,
      caption,
      onOutcomes: (outcomes) =>
        this.reconcile(outcomes, caption, mentions, roomAtDispatch),
    });
    return true;
  }

  /**
   * What survives a batch: successes leave the strip, failures stay in it so the next send
   * retries exactly them. A caption typed for a batch goes out as its own message afterwards
   * — Matrix has no multi-attachment event, so there is no first image for it to belong to,
   * and repeating it on each would put the same sentence in the room N times. A single file
   * keeps its MSC2530 caption, which is what `sendMediaBatch` decides.
   */
  private reconcile(
    outcomes: readonly BatchOutcome[],
    caption: string,
    mentions: readonly Mention[],
    roomAtDispatch: string | null,
  ): void {
    // The batch is over the moment its outcomes land, and this is the ONLY release: inferring
    // it from `uploadProgress` returning to null cannot work, because a send that completes
    // synchronously is back to null before a signal input can ever observe it move.
    this.sending.set(false);
    for (const outcome of outcomes) {
      if (!outcome.failed) {
        this.ports.removeStaged(outcome.id);
      }
    }
    // A staged file and a failed one look identical in the strip, so mark them rather than
    // leaving the user to guess. Only this batch's failures — these outcomes say nothing
    // about files that failed in an earlier round and have not been retried yet.
    this.ports.markFailed(
      outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.id),
    );
    if (!caption) {
      return;
    }
    if (this.ports.roomId() !== roomAtDispatch) {
      // The conversation moved on. Posting would put these words in a room they were not
      // written for, and restoring would leave them in that room's composer — the same leak
      // the composer's room-change effect exists to prevent. Parked as the draft of the room
      // they belong to instead, so they are neither misdelivered nor destroyed.
      if (roomAtDispatch != null && !this.ports.drafts.get(roomAtDispatch)) {
        this.ports.drafts.set(roomAtDispatch, caption);
      }
      return;
    }
    const delivered = outcomes.filter((outcome) => !outcome.failed).length;
    if (delivered && outcomes.length > 1) {
      // No file for a batch caption to belong to, so it goes out on its own — after the
      // files, and only if at least one of them actually arrived. On its OWN output: by now
      // the user may be part-way into an edit or a reply, and the ordinary submit path would
      // route this into it.
      this.ports.sendCaption({ text: caption, mentions: [...mentions] });
      return;
    }
    if (!delivered && !this.ports.text().trim()) {
      // Nothing carried it: a single file's caption rides its media event (MSC2530) and went
      // down with it, and a batch caption is never sent when the batch delivered nothing.
      // `submit()` cleared the box on dispatch, so without this the words are simply gone.
      // Skipped when something has been typed since — restoring is for what was lost, not
      // for overwriting what replaced it.
      this.ports.text.set(caption);
      this.ports.regrow();
    }
  }
}
