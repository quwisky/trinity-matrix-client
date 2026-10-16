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
  /** The Conversation cannot take a send right now. */
  readonly blocked: Signal<boolean>;
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
 * Turns what is staged into outgoing batches, and reconciles what comes back: the
 * one-at-a-time latch, the in-flight list the progress bar names, and what survives a partial
 * failure. A plain class that never touches the DOM.
 */
export class ComposerBatchSender {
  /**
   * The batch currently going out.
   *
   * The progress bar renders above the rows still staged, so without this it reads as
   * describing them. Written here rather than at the call site because this is the single
   * funnel every upload passes through: a GIF never touches the composer's `submit()`, and
   * naming the last *staged* file while a GIF uploads is worse than naming nothing.
   */
  private readonly sendingItems = signal<readonly BatchItem[]>([]);

  /**
   * A media send has been dispatched and its upload has not finished.
   *
   * Separate from `uploadProgress` and written SYNCHRONOUSLY, which is the whole point:
   * `uploadProgress` is a signal input, written only during the parent's change detection,
   * which zoneless is scheduled on a rAF/timer race. Two `submit()` calls in one task (a held
   * Enter key, while the first send's `encryptAttachment` janks the frame) would both read
   * `null` and both dispatch. A local flag closes in the same statement that opens it, and is
   * released by the outcomes.
   */
  private readonly sending = signal(false);

  /**
   * Identity of the batch allowed to release {@link sending} when it settles.
   *
   * A room change deliberately releases the old room's latch before its upload finishes, so
   * another batch can already own this sender when the old outcomes arrive. The identity lets
   * that stale callback still reconcile its own files and caption without releasing the newer
   * batch; it is not a latest-wins guard.
   */
  private nextBatchGeneration = 0;
  private activeBatchGeneration: number | null = null;

  /** Whether the reported progress belongs to the room/thread this sender now serves. */
  private readonly progressIsForCurrentContext = signal(true);

  /** Progress scoped to the current room/thread rather than the page's previous upload. */
  readonly uploadProgress = computed(() =>
    this.progressIsForCurrentContext() ? this.ports.uploadProgress() : null,
  );

  /** Whether a batch is out and has not reported yet. */
  readonly inFlight = this.sending.asReadonly();

  constructor(private readonly ports: ComposerBatchPorts) {}

  /**
   * Forget an in-flight batch without waiting for its outcomes.
   *
   * For a room change only: the upload belongs to the page and survives the switch, but
   * nothing staged here does, so holding the latch would only mute the next room's composer.
   */
  release(): void {
    this.activeBatchGeneration = null;
    this.progressIsForCurrentContext.set(false);
    this.sending.set(false);
  }

  /**
   * The name of the file currently uploading, taken from the batch's own position so it follows
   * the batch through file 2, 3, … instead of naming whatever was dispatched first.
   */
  readonly uploadLabel = computed(() => {
    const progress = this.uploadProgress();
    return progress
      ? (this.sendingItems()[progress.index - 1]?.file.name ?? null)
      : null;
  });

  /**
   * Whether a media send would be accepted right now: the condition {@link dispatch} enforces,
   * exposed so the send button can SAY it is blocked. `sending` matters here and not just
   * `uploadProgress`: the latch closes synchronously, while the input it mirrors lags by a
   * change-detection tick.
   */
  readonly canSend = computed(
    () =>
      this.uploadProgress() === null &&
      !this.sending() &&
      !this.ports.blocked(),
  );

  /**
   * The single funnel every media send passes through: `submit()` for the staged batch and the
   * attachments service's `sendMedia` hook for a GIF. The in-flight list, send latch and
   * one-at-a-time check live here, so a path that skips `submit()` cannot miss any of them.
   *
   * Returns whether the batch was dispatched, so a caller with cleanup (`submit()` clears the
   * text) can tell a refusal from a send.
   */
  dispatch(
    items: readonly BatchItem[],
    caption: string,
    mentions: readonly Mention[],
  ): boolean {
    if (!items.length) {
      return false;
    }
    // Guarded here, not only on the send button: `onEnter` calls `submit()` directly and never
    // consults `[disabled]`, so key auto-repeat alone can fire it twice. Two batches in flight
    // share one `uploadProgress` and interleave their events.
    if (!this.canSend()) {
      return false;
    }
    this.progressIsForCurrentContext.set(true);
    this.sendingItems.set(items);
    const generation = ++this.nextBatchGeneration;
    this.activeBatchGeneration = generation;
    this.sending.set(true);
    // A batch settles long after it was pressed, by when this composer may show another room.
    const roomAtDispatch = this.ports.roomId();
    this.ports.send({
      items,
      caption,
      onOutcomes: (outcomes) =>
        this.reconcile(outcomes, caption, mentions, roomAtDispatch, generation),
    });
    return true;
  }

  /**
   * What survives a batch: successes leave the strip, failures stay so the next send retries
   * exactly them. A batch caption goes out as its own message afterwards: Matrix has no
   * multi-attachment event, so there is no first image for it to belong to, and repeating it on
   * each would put the same sentence in the room N times. A single file keeps its MSC2530
   * caption, which `sendMediaBatch` decides.
   */
  private reconcile(
    outcomes: readonly BatchOutcome[],
    caption: string,
    mentions: readonly Mention[],
    roomAtDispatch: string | null,
    generation: number,
  ): void {
    // The ONLY release: inferring it from `uploadProgress` returning to null cannot work, as a
    // send that completes synchronously is back to null before a signal input can observe it.
    if (this.activeBatchGeneration === generation) {
      this.activeBatchGeneration = null;
      this.sending.set(false);
    }
    for (const outcome of outcomes) {
      if (!outcome.failed) {
        this.ports.removeStaged(outcome.id);
      }
    }
    // Only this batch's failures: these outcomes say nothing about files that failed in an
    // earlier round and have not been retried yet.
    this.ports.markFailed(
      outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.id),
    );
    if (!caption) {
      return;
    }
    if (this.ports.roomId() !== roomAtDispatch) {
      // The conversation moved on. Posting would put these words in a room they were not
      // written for, and restoring would leave them in that room's composer, the same leak the
      // room-change effect prevents. Park them as the draft of their own room instead.
      if (roomAtDispatch != null && !this.ports.drafts.get(roomAtDispatch)) {
        this.ports.drafts.set(roomAtDispatch, caption);
      }
      return;
    }
    const delivered = outcomes.filter((outcome) => !outcome.failed).length;
    if (delivered && outcomes.length > 1) {
      // Goes out after the files, and only if at least one arrived. On its OWN output: the user
      // may by now be part-way into an edit or a reply, which the ordinary submit path would
      // route this into.
      this.ports.sendCaption({ text: caption, mentions: [...mentions] });
      return;
    }
    if (!delivered && !this.ports.text().trim()) {
      // Nothing carried it: a single file's caption rides its media event (MSC2530) and failed
      // with it, and a batch caption is never sent when nothing was delivered. `submit()` cleared
      // the box on dispatch, so restore it, unless something has been typed since.
      this.ports.text.set(caption);
      this.ports.regrow();
    }
  }
}
