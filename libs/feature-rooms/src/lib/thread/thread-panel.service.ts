import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import { ThreadViewComponent } from './thread-view.component';

/** Card class sizing the thread modal as a full-height side panel on desktop. */
const MODAL_CSS_CLASS = 'thread-modal';

/**
 * Presents the {@link ThreadViewComponent} (root, replies, and an in-thread
 * composer) as an Ionic modal — a full-height right-side panel on the wide/desktop
 * split-pane layout and a
 * full-screen sheet on mobile (the modal default; the desktop sizing comes from
 * {@link MODAL_CSS_CLASS} in global.scss). Centralized here so the rooms page stays
 * thin and the presentation can be retargeted (e.g. an inline side panel) later.
 *
 * Unlike `EncryptionDialogService` (which lives in `ui` to avoid a feature→feature
 * dependency), the thread view is owned by this feature, so it is presented
 * directly without a loader token.
 */
@Injectable({ providedIn: 'root' })
export class ThreadPanelService {
  private readonly modalCtrl = inject(ModalController);

  /** Open the thread rooted at `rootEventId` in `roomId`. */
  async open(roomId: string, rootEventId: string): Promise<void> {
    const modal = await this.modalCtrl.create({
      component: ThreadViewComponent,
      // Signal inputs are populated from componentProps (app sets useSetInputAPI).
      componentProps: { roomId, rootEventId },
      cssClass: MODAL_CSS_CLASS,
    });
    await modal.present();
  }
}
