import {
  Injectable,
  computed,
  inject,
  type Signal,
  type Type,
} from '@angular/core';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  ADD_TO_IMAGE_PACK_DIALOG,
  ImagePackEditorService,
  type AddInput,
  type PackEntry,
} from '@trinity/data-access/media';
import {
  EMPTY,
  concatMap,
  defer,
  finalize,
  from,
  switchMap,
  type Observable,
} from 'rxjs';

/** The part of the settings dialog an opener may know without importing it. */
interface AddDialog {
  canDismiss(): boolean;
}

/**
 * Rooms' entry to "Add to your emoji": opens the lazily loaded dialog from feature-settings.
 * Nothing is offered until someone subscribes {@link run}: the rooms page does, for its lifetime.
 * Signed out, the pack is unknown and nothing is offered either.
 */
@Injectable({ providedIn: 'root' })
export class AddToMyEmojiService {
  private readonly load = inject(ADD_TO_IMAGE_PACK_DIALOG, { optional: true });
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly toast = inject(TrnToastService);
  /** A dialog is open or queued; another request is dropped rather than stacked. */
  private busy = false;
  // Only where the dialog exists, so hosts and specs without it never build the editor.
  private readonly editor = this.load ? inject(ImagePackEditorService) : null;

  /** The mxc URLs already in the personal pack, or null when nothing can be added. */
  readonly owned: Signal<ReadonlySet<string> | null> = computed(() => {
    const entries = this.editor?.personal();
    return entries ? new Set(entries.map((entry) => entry.url)) : null;
  });

  /** Whether images can be added here at all. */
  readonly available = computed(() => this.owned() !== null);

  /** Keeps {@link owned} live for the subscriber's lifetime; nothing to run without the dialog. */
  run(): Observable<void> {
    return this.editor?.run() ?? EMPTY;
  }

  /** Whether `mxc` can be added: the pack is known and does not have it yet. */
  canAdd(mxc: string): boolean {
    return this.owned()?.has(mxc) === false;
  }

  /**
   * Opens the dialog for `input`. Subscribed here, not by the caller: the dialog must outlive the
   * menu, picker or message row that asked for it. It closes itself on an account switch.
   */
  add(input: AddInput, suggestedName: string): void {
    this.start(this.open$(input, suggestedName));
  }

  /** Opens the dialog for each file in turn, like Settings' Add images. */
  addFiles(files: readonly File[]): void {
    this.start(
      from(files).pipe(
        concatMap((file) => this.open$({ kind: 'file', file }, file.name)),
      ),
    );
  }

  private start(work: Observable<unknown>): void {
    if (this.busy) return;
    this.busy = true;
    work.pipe(finalize(() => (this.busy = false))).subscribe({
      // The dialog shows its own add errors; this is the chunk failing to load.
      error: () =>
        this.toast.show('Couldn’t open Add to your emoji. Try again.', {
          variant: 'danger',
        }),
    });
  }

  private open$(
    input: AddInput,
    suggestedName: string,
  ): Observable<PackEntry | null> {
    const load = this.load;
    if (!load) return EMPTY;
    return defer(load).pipe(
      switchMap((component) =>
        this.surfaces.openAndWait$<PackEntry, AddDialog>(
          component as Type<AddDialog>,
          {
            inputs: { input, suggestedName },
            autoFocus: '[data-autofocus]',
            dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
          },
        ),
      ),
    );
  }
}
