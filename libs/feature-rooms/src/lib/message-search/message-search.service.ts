import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import { MessageSearchComponent } from './message-search.component';

/** Same full-height side-panel sizing as the thread modal (see global.scss). */
const MODAL_CSS_CLASS = 'message-search-modal';

/**
 * Presents the {@link MessageSearchComponent} as an Ionic modal scoped to a room and
 * resolves the chosen event id (or `null` when cancelled). Wraps `ModalController` so
 * `RoomsPage` stays thin and performs the timeline jump with the returned id —
 * mirroring {@link ThreadPanelService} / {@link QuickSwitcherService}.
 *
 * A re-entrancy guard means re-triggering search while it's already open is a no-op
 * rather than stacking modals.
 */
@Injectable({ providedIn: 'root' })
export class MessageSearchService {
  private readonly modalCtrl = inject(ModalController);
  private open = false;

  /** Open in-room search for `roomId`; resolves the chosen event id, or null. */
  async search(roomId: string): Promise<string | null> {
    if (this.open) {
      return null; // already showing — ignore the repeat trigger
    }
    this.open = true;
    try {
      const modal = await this.modalCtrl.create({
        component: MessageSearchComponent,
        // Signal inputs are populated from componentProps (app sets useSetInputAPI).
        componentProps: { roomId },
        cssClass: MODAL_CSS_CLASS,
      });
      await modal.present();
      const { data } = await modal.onWillDismiss<string | null>();
      return data ?? null;
    } finally {
      this.open = false;
    }
  }
}
