import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  TitleBarState,
  WORKSPACE_SYSTEM_STATUS,
} from '@trinity/application/workspace';
import { TrnIconButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { getTrinityDesktopBridge } from '@trinity/platform-native';
import { cssColorToHex } from './overlay-colors';

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
    '[class.title-bar--visible]': 'visible()',
    '[class.title-bar--mac]': 'isMac',
  },
})
export class TitleBarComponent {
  private readonly bridge = getTrinityDesktopBridge();
  private readonly systemTitleBar = signal<boolean | null>(null);

  protected readonly titleBar = inject(TitleBarState);
  protected readonly systemStatus = inject(WORKSPACE_SYSTEM_STATUS);
  protected readonly isMac = this.bridge?.platform === 'darwin';
  protected readonly visible = computed(
    () => !!this.bridge && this.systemTitleBar() === false,
  );

  constructor() {
    const titleBar = this.bridge?.capabilities.titleBar;
    if (!titleBar) return;
    const destroyRef = inject(DestroyRef);
    let destroyed = false;
    destroyRef.onDestroy(() => (destroyed = true));
    titleBar
      .getSystemTitleBar()
      .then(({ active }) => !destroyed && this.systemTitleBar.set(active))
      // An unanswerable host keeps the OS bar's assumption: no row.
      .catch(() => undefined);

    effect(() => this.titleBar.setActive(this.visible()));
    effect((onCleanup) => {
      if (!this.visible()) return;
      const send = () => this.sendOverlayColors();
      send();
      const observer = new MutationObserver(send);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });
      onCleanup(() => observer.disconnect());
    });
    destroyRef.onDestroy(() => this.titleBar.setActive(false));
  }

  protected openMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.bridge?.capabilities.titleBar.popupMenu({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
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
