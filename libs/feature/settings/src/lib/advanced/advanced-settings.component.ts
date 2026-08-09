import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Capacitor } from '@capacitor/core';
import { HlmButton } from '@trinity/helm/button';
import { HlmLabel } from '@trinity/helm/label';
import { TrnAlertService, TrnToastService } from '@trinity/helm/overlay';
import { HlmTextarea } from '@trinity/helm/textarea';
import {
  AppConfigService,
  CONFIG_EXCLUSION_NOTES,
} from '@trinity/platform-native';
import {
  RESET_CONFIG_MISTYPED_MESSAGE,
  confirmResetConfigIntent,
} from './reset-config';

/** Name of the downloaded file — dated, so two exports don't overwrite each other. */
function exportFileName(now: Date): string {
  return `trinity-settings-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Advanced settings: the whole local preference layer as one pretty-printed JSON document,
 * with Copy, Export to file, and Reset to defaults.
 *
 * Read-only in this pass — editing and importing land next. The document comes from
 * {@link AppConfigService}, which builds it from the registered settings only, so the
 * omissions are structural rather than filtered: accounts, tokens, drafts and anything the
 * server keeps for you cannot reach it. Those omissions are stated on the page
 * ({@link CONFIG_EXCLUSION_NOTES}) rather than left to be discovered, because someone
 * copying this to a new device needs to know it is a preferences transfer, not a sign-in.
 */
@Component({
  selector: 'trn-advanced-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './advanced-settings.component.html',
  styleUrl: './advanced-settings.component.scss',
  imports: [HlmButton, HlmLabel, HlmTextarea],
})
export class AdvancedSettingsComponent {
  private readonly config = inject(AppConfigService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** What the export leaves out and why — the section's copy, not a hardcoded list. */
  readonly exclusions = CONFIG_EXCLUSION_NOTES;

  /**
   * Native WebViews lack a reliable file download, so the file path is web/desktop only —
   * the same reason recorded at `recovery-key-display.component.ts`. Capacitor reports the
   * Electron shell as non-native, which is correct here: it downloads like a browser.
   */
  readonly canExportFile = !Capacitor.isNativePlatform();

  /** True while a reset is in flight, so the button can't be pressed twice. */
  readonly resetting = signal(false);

  /**
   * The document, live: `exportJson()` reads the owning services' signals, so a preference
   * changed elsewhere (or reset here) re-renders this without a reload. Copy and Export send
   * exactly this string, so what is shown and what leaves the app cannot disagree.
   */
  readonly configJson = computed(() => this.config.exportJson());

  /** Copy the document, toasting only once the write resolves — never on a rejection. */
  copy(): void {
    void (
      navigator.clipboard?.writeText(this.configJson()) ?? Promise.reject()
    ).then(
      () => this.toast.show('Settings copied.', { duration: 2000 }),
      () =>
        this.toast.show('Could not copy your settings.', {
          duration: 3000,
          variant: 'destructive',
        }),
    );
  }

  /** Save the document as a file (web + desktop only; see {@link canExportFile}). */
  exportFile(): void {
    const anchor = this.document.createElement('a');
    anchor.href =
      'data:application/json;charset=utf-8,' +
      encodeURIComponent(this.configJson());
    anchor.download = exportFileName(new Date());
    anchor.click();
  }

  /** Put every exported setting back to its default, behind the type-to-confirm gate. */
  async reset(): Promise<void> {
    const intent = await confirmResetConfigIntent(this.alert);
    if (intent === 'cancelled') {
      return;
    }
    if (intent === 'mistyped') {
      this.toast.show(RESET_CONFIG_MISTYPED_MESSAGE, { duration: 4000 });
      return;
    }

    this.resetting.set(true);
    this.config
      .resetToDefaults()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resetting.set(false);
          this.toast.show('Settings reset to defaults.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.resetting.set(false);
          this.toast.show('Could not reset every setting.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }
}
