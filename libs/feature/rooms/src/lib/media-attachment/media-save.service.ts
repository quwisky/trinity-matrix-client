import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Subscription, finalize, switchMap } from 'rxjs';
import { TrnToastService } from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { HostFileExportService } from '@trinity/runtime/host';

/**
 * Saves a timeline attachment to the device: full-resolution bytes (decrypted in encrypted
 * rooms by {@link MediaPipeline}), then the host file saver — the native share sheet on a
 * phone, a browser download elsewhere. The file card, the lightbox and the message menus all
 * save through here.
 *
 * Root-scoped so a save outlives the row or viewer that started it. In-flight state is kept
 * per item: a repeat request for the same item is ignored (a native Share rejects a
 * concurrent invocation), while other items are unaffected, so one hung save cannot block
 * the rest. There is deliberately no timeout, because a large video legitimately takes long;
 * an account change cancels every save instead.
 */
@Injectable({ providedIn: 'root' })
export class MediaSaveService {
  private readonly pipeline = inject(MediaPipeline);
  private readonly fileSave = inject(HostFileExportService);
  private readonly toast = inject(TrnToastService);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly running = new Map<string, Subscription>();
  private readonly savingIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // `undefined` marks the effect's first run, which only records the current account: it
    // fires after the first save has already started and must not cancel it.
    let previous: string | null | undefined;
    effect(() => {
      const account = this.accounts.activeAccountId();
      if (previous === undefined || previous === account) {
        previous = account;
        return;
      }
      previous = account;
      untracked(() => {
        for (const subscription of [...this.running.values()]) {
          subscription.unsubscribe();
        }
        this.running.clear();
        this.savingIds.set(new Set());
      });
    });
  }

  /** Whether this item is being saved right now. */
  isSaving(media: PresentedMediaReference): boolean {
    return this.savingIds().has(media.id);
  }

  save(media: PresentedMediaReference): void {
    const id = media.id;
    if (this.running.has(id)) return;
    this.savingIds.update((ids) => new Set(ids).add(id));
    const fail = () =>
      this.toast.show(`Couldn't save ${media.kind}`, { variant: 'danger' });
    const subscription = this.pipeline
      .downloadMedia(media)
      .pipe(
        // The event's own filename, also in encrypted rooms where the ciphertext has none.
        switchMap(({ blob }) =>
          this.fileSave.save({ bytes: blob, filename: media.filename }),
        ),
        finalize(() => {
          this.running.delete(id);
          this.savingIds.update((ids) => {
            const next = new Set(ids);
            next.delete(id);
            return next;
          });
        }),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') fail();
        },
        error: fail,
      });
    // A synchronous completion has already run finalize; only track what is still live.
    if (!subscription.closed) this.running.set(id, subscription);
  }
}
