import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { HostFileExportService } from '@trinity/runtime/host';

/** How long the "Copied" affordance stays visible after a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * Presents an encoded recovery key for the user to save: a selectable monospace
 * block with copy + download actions. Purely presentational — it takes the key as
 * an input and never touches the crypto layer, so the parent owns the "shown once,
 * confirm saved" gate. File export is host-selected and hidden only when the selected
 * host explicitly reports it unavailable.
 */
@Component({
  selector: 'trn-recovery-key-display',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['recovery-key-display.component.scss'],
  imports: [TrnButton, TrnIconComponent],
  templateUrl: './recovery-key-display.component.html',
})
export class RecoveryKeyDisplayComponent {
  private readonly document = inject(DOCUMENT);
  private readonly files = inject(HostFileExportService);
  private readonly destroyRef = inject(DestroyRef);

  /** The encoded recovery key string to display. */
  readonly recoveryKey = input.required<string>();

  /** Flips to true briefly after a successful copy, for the "Copied" affordance. */
  readonly copied = signal(false);

  /** Set when the clipboard write fails, prompting a manual-copy fallback. */
  readonly copyFailed = signal(false);

  /** Live-region message announcing copy/download outcomes to assistive tech. */
  readonly announcement = signal('');

  private readonly fileSupport = toSignal(this.files.support(), {
    initialValue: { kind: 'unavailable', reason: 'not-implemented' } as const,
  });

  /** Every host decides support through the operation contract, never an identity branch. */
  readonly canDownload = computed(
    () => this.fileSupport().kind === 'supported',
  );

  /** Copy the key to the clipboard, with transient + announced confirmation. */
  copy(): void {
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (!clipboard) {
      // No Clipboard API (insecure context / older WebView): prompt manual copy.
      this.failCopy();
      return;
    }
    void clipboard.writeText(this.recoveryKey()).then(
      () => {
        this.copyFailed.set(false);
        this.copied.set(true);
        this.announcement.set('Recovery key copied to clipboard.');
        setTimeout(() => this.copied.set(false), COPIED_FEEDBACK_MS);
      },
      () => this.failCopy(),
    );
  }

  /** Save the key through the selected cold host operation. */
  download(): void {
    const blob = new Blob([this.recoveryKey()], { type: 'text/plain' });
    this.files
      .save({ bytes: blob, filename: 'trinity-recovery-key.txt' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) =>
          this.announcement.set(
            outcome.kind === 'completed'
              ? 'Recovery key downloaded.'
              : 'Could not download the recovery key.',
          ),
        error: () =>
          this.announcement.set('Could not download the recovery key.'),
      });
  }

  private failCopy(): void {
    this.copied.set(false);
    this.copyFailed.set(true);
    this.announcement.set(
      "Couldn't copy — select the key and copy it manually.",
    );
  }
}
