import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { AppearanceEffects } from '@trinity/application/appearance';
import {
  TitleBarState,
  WORKSPACE_SYSTEM_STATUS,
} from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import {
  BUG_REPORT_LAUNCHER,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import { HostCapabilitiesService } from '@trinity/runtime/host';
import { firstValueFrom } from 'rxjs';
import { cssColorToHex } from './overlay-colors';

const TITLE_ROW_CLASS = 'trn-title-row';

/**
 * The 32px desktop title row. It renders only in the Electron shell, and only while this
 * session's window is frameless (the "use system title bar" opt-out keeps the OS bar).
 */
@Component({
  selector: 'trn-title-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './title-bar.component.html',
  styleUrl: './title-bar.component.scss',
  imports: [TrnButton, TrnIconComponent],
  host: {
    class: 'title-bar',
    '[class.title-bar--visible]': 'visible',
    '[class.title-bar--mac]': 'isMac',
  },
})
export class TitleBarComponent {
  private readonly body = inject(DOCUMENT).body;
  private readonly bridge = getTrinityDesktopBridge();
  private readonly diagnosticLog = inject(DiagnosticLogService);
  private readonly bugReport = inject(BUG_REPORT_LAUNCHER, { optional: true });

  protected readonly titleBar = inject(TitleBarState);
  protected readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  protected readonly isMac = this.bridge?.platform === 'darwin';
  // The shell passes its launch mode synchronously, so the first render already knows;
  // anything but 'row' keeps the OS bar's assumption: no row.
  protected readonly visible =
    this.bridge?.capabilities.titleBar?.mode === 'row';
  /**
   * Report a bug, while "Keep a diagnostic log" is known to be on: a log is being kept, so
   * there is something worth sending. Hidden while the setting is still being read.
   */
  protected readonly canReportBug = computed(
    () =>
      this.bugReport !== null &&
      this.diagnosticLog.settingKnown() &&
      this.diagnosticLog.keepLog(),
  );

  constructor() {
    if (!this.visible) return;
    // Global styles start viewport-fixed layers (overlays, drawers) below the row. The
    // class lives on <body>, not <html>: Appearance's adapter owns the document root.
    const body = this.body;
    body.classList.add(TITLE_ROW_CLASS);
    this.titleBar.setActive(true);

    // A new resolved Appearance re-themes the surface; re-read the colours afterwards.
    const appearance = inject(AppearanceEffects);
    effect(() => {
      // Undefined before Appearance first runs; negotiation sends the first colours.
      if (appearance.resolved()) this.sendOverlayColors();
    });
    let destroyed = false;
    inject(DestroyRef).onDestroy(() => {
      destroyed = true;
      body.classList.remove(TITLE_ROW_CLASS);
      this.titleBar.setActive(false);
    });
    // The overlay operation is granted by startup negotiation; colours sent before it are
    // dropped, so send once it settles. A failed negotiation keeps the default colours.
    firstValueFrom(inject(HostCapabilitiesService).manifest())
      .then(() => !destroyed && this.sendOverlayColors())
      .catch(() => undefined);
  }

  protected openMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.bridge?.capabilities.titleBar.popupMenu({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
  }

  protected reportBug(): void {
    this.bugReport?.open();
  }

  protected showStatus(): void {
    this.systemStatus.show();
  }

  private sendOverlayColors(): void {
    const style = getComputedStyle(this.body);
    const color = cssColorToHex(
      style.getPropertyValue('--trinity-surface-app'),
    );
    const symbolColor = cssColorToHex(style.getPropertyValue('--trinity-text'));
    if (color && symbolColor) {
      this.bridge?.capabilities.titleBar.setOverlayColors({
        color,
        symbolColor,
      });
    }
  }
}
