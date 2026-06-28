import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import type { SwitcherSelection } from '@trinity/core';
import { QuickSwitcherComponent } from './quick-switcher.component';

/** Centered card matching the other Trinity dialogs (see global.scss). */
const MODAL_CSS_CLASS = 'quick-switcher-modal';

/**
 * Presents the {@link QuickSwitcherComponent} as an Ionic modal and resolves the
 * chosen {@link SwitcherSelection} (or `null` when cancelled). Wraps `ModalController`
 * so `RoomsPage` stays thin and performs the actual jump with the returned selection
 * — mirroring {@link UserPickerService}.
 *
 * A re-entrancy guard means a repeated Ctrl/Cmd+K while the switcher is already open
 * is a no-op rather than stacking modals.
 */
@Injectable({ providedIn: 'root' })
export class QuickSwitcherService {
  private readonly modalCtrl = inject(ModalController);
  private open = false;

  /** Open the switcher; resolves the chosen selection, or null if cancelled/already open. */
  async pick(): Promise<SwitcherSelection | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      const modal = await this.modalCtrl.create({
        component: QuickSwitcherComponent,
        cssClass: MODAL_CSS_CLASS,
      });
      await modal.present();
      const { data } = await modal.onWillDismiss<SwitcherSelection | null>();
      return data ?? null;
    } finally {
      this.open = false;
    }
  }
}
