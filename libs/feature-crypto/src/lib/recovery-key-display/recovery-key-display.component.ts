import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { DOCUMENT } from '@angular/common';
import { IonIcon } from '@ionic/angular/standalone';
import { HlmButton } from '@trinity/ui-spartan';
import { addIcons } from 'ionicons';
import { checkmarkOutline, copyOutline, downloadOutline } from 'ionicons/icons';

/** How long the "Copied" affordance stays visible after a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * Presents an encoded recovery key for the user to save: a selectable monospace
 * block with copy + download actions. Purely presentational — it takes the key as
 * an input and never touches the crypto layer, so the parent owns the "shown once,
 * confirm saved" gate. Download is web-only (no Capacitor Filesystem plugin); it is
 * hidden on native platforms, where copy is the path.
 */
@Component({
  selector: 'trn-recovery-key-display',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['recovery-key-display.component.scss'],
  imports: [HlmButton, IonIcon],
  template: `
    <!-- No aria-label: the key text itself must be the accessible content so a
         screen reader can read it. Copy/Download are the reliable capture path. -->
    <code class="key" tabindex="0">{{ recoveryKey() }}</code>

    <div class="actions">
      <button hlmBtn variant="outline" size="sm" (click)="copy()">
        <ion-icon
          slot="start"
          [name]="copied() ? 'checkmark-outline' : 'copy-outline'"
          aria-hidden="true"
        />
        {{ copied() ? 'Copied' : 'Copy' }}
      </button>
      @if (canDownload) {
        <button hlmBtn variant="outline" size="sm" (click)="download()">
          <ion-icon slot="start" name="download-outline" aria-hidden="true" />
          Download
        </button>
      }
    </div>

    @if (copyFailed()) {
      <p class="copy-hint">
        Couldn't copy automatically — select the key above and copy it manually.
      </p>
    }

    <!-- Announce copy/download outcomes to assistive tech (visually hidden). -->
    <span class="sr-only" role="status" aria-live="polite">{{
      announcement()
    }}</span>
  `,
})
export class RecoveryKeyDisplayComponent {
  private readonly document = inject(DOCUMENT);

  /** The encoded recovery key string to display. */
  readonly recoveryKey = input.required<string>();

  /** Flips to true briefly after a successful copy, for the "Copied" affordance. */
  readonly copied = signal(false);

  /** Set when the clipboard write fails, prompting a manual-copy fallback. */
  readonly copyFailed = signal(false);

  /** Live-region message announcing copy/download outcomes to assistive tech. */
  readonly announcement = signal('');

  /** Native WebViews lack a reliable file download; offer it on web only. */
  readonly canDownload = !Capacitor.isNativePlatform();

  constructor() {
    addIcons({ checkmarkOutline, copyOutline, downloadOutline });
  }

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

  /** Save the key as a plain-text file (web only). */
  download(): void {
    const view = this.document.defaultView;
    if (!view) {
      return;
    }
    const blob = new Blob([this.recoveryKey()], { type: 'text/plain' });
    const url = view.URL.createObjectURL(blob);
    try {
      const anchor = this.document.createElement('a');
      anchor.href = url;
      anchor.download = 'trinity-recovery-key.txt';
      anchor.click();
      this.announcement.set('Recovery key downloaded.');
    } finally {
      // Always tear down the object URL so the plaintext-key blob can't linger.
      view.URL.revokeObjectURL(url);
    }
  }

  private failCopy(): void {
    this.copied.set(false);
    this.copyFailed.set(true);
    this.announcement.set(
      "Couldn't copy — select the key and copy it manually.",
    );
  }
}
