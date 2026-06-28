import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import { ThreadViewComponent } from './thread-view.component';
import { ThreadsListComponent } from './threads-list.component';

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

  /**
   * Open the threads-list panel for `roomId` (same modal sizing as the thread
   * view). When a row is tapped the list dismisses with the chosen thread-root id,
   * which is then opened as a thread view — so the two never stack and the list
   * stays free of any thread-open dependency.
   */
  async openList(roomId: string): Promise<void> {
    const modal = await this.modalCtrl.create({
      component: ThreadsListComponent,
      componentProps: { roomId },
      cssClass: MODAL_CSS_CLASS,
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<string | undefined>();
    if (data) {
      await this.open(roomId, data);
    }
  }
}
