import { Injectable, inject, signal } from '@angular/core';
import { finalize, switchMap } from 'rxjs';
import { TrnToastService } from '@trinity/components/overlay';
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
 * Root-scoped on purpose: the guard has to span every entry point, because a native Share
 * rejects a concurrent invocation no matter which surface started it.
 */
@Injectable({ providedIn: 'root' })
export class MediaSaveService {
  private readonly pipeline = inject(MediaPipeline);
  private readonly fileSave = inject(HostFileExportService);
  private readonly toast = inject(TrnToastService);
  private readonly inFlight = signal(false);

  /** Whether a save is running; a second request is ignored until it ends. */
  readonly saving = this.inFlight.asReadonly();

  save(media: PresentedMediaReference): void {
    if (this.inFlight()) return;
    this.inFlight.set(true);
    const fail = () =>
      this.toast.show(`Couldn't save ${media.kind}`, { variant: 'danger' });
    this.pipeline
      .downloadMedia(media)
      .pipe(
        // The event's own filename, also in encrypted rooms where the ciphertext has none.
        switchMap(({ blob }) =>
          this.fileSave.save({ bytes: blob, filename: media.filename }),
        ),
        finalize(() => this.inFlight.set(false)),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') fail();
        },
        error: fail,
      });
  }
}
