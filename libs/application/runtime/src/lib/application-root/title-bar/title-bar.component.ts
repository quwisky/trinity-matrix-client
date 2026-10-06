import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
} from '@angular/core';
import {
  TitleBarState,
  WORKSPACE_SYSTEM_STATUS,
} from '@trinity/application/workspace';
import { TrnIconButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { getTrinityDesktopBridge } from '@trinity/platform-native';
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
  imports: [TrnIconButton, TrnIconComponent],
  host: {
    class: 'title-bar',
    '[class.title-bar--visible]': 'visible',
    '[class.title-bar--mac]': 'isMac',
  },
})
export class TitleBarComponent {
  private readonly bridge = getTrinityDesktopBridge();

  protected readonly titleBar = inject(TitleBarState);
  protected readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  protected readonly isMac = this.bridge?.platform === 'darwin';
  // The shell passes its launch mode synchronously, so the first render already knows;
  // anything but 'row' keeps the OS bar's assumption: no row.
  protected readonly visible =
    this.bridge?.capabilities.titleBar?.mode === 'row';

  constructor() {
    if (!this.visible) return;
    const root = document.documentElement;
    // Global styles start viewport-fixed layers (overlays, drawers) below the row.
    root.classList.add(TITLE_ROW_CLASS);
    this.titleBar.setActive(true);

    const send = () => this.sendOverlayColors();
    const observer = new MutationObserver(send);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    let destroyed = false;
    inject(DestroyRef).onDestroy(() => {
      destroyed = true;
      observer.disconnect();
      root.classList.remove(TITLE_ROW_CLASS);
      this.titleBar.setActive(false);
    });
    // The overlay operation is granted by startup negotiation; colours sent before it are
    // dropped, so send once it settles. A failed negotiation keeps the default colours.
    firstValueFrom(inject(HostCapabilitiesService).manifest())
      .then(() => !destroyed && send())
      .catch(() => undefined);
  }

  protected openMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.bridge?.capabilities.titleBar.popupMenu({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
  }

  protected showStatus(event: MouseEvent): void {
    const button = event.currentTarget as HTMLElement;
    this.systemStatus.show(() => button.focus());
  }

  private sendOverlayColors(): void {
    const style = getComputedStyle(document.documentElement);
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
