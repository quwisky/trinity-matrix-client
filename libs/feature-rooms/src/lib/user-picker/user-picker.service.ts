import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular/standalone';
import { UserPickerComponent } from './user-picker.component';

/** Heading / labels for a {@link UserPickerService.pick} presentation. */
export interface UserPickerOptions {
  title: string;
  confirmLabel: string;
  placeholder?: string;
}

/** Centered auto-height card matching the other Trinity dialogs (see global.scss). */
const MODAL_CSS_CLASS = 'user-picker-modal';

/**
 * Presents the {@link UserPickerComponent} as an Ionic modal and resolves the chosen
 * Matrix ID (or `null` when cancelled). Wraps `ModalController` so the rooms page
 * stays thin and the presentation can be retargeted later — mirroring
 * {@link ThreadPanelService}. The page performs the actual create/invite with the
 * returned id, so this service owns presentation only.
 */
@Injectable({ providedIn: 'root' })
export class UserPickerService {
  private readonly modalCtrl = inject(ModalController);

  /** Open the picker; resolves the selected MXID, or null if cancelled/dismissed. */
  async pick(options: UserPickerOptions): Promise<string | null> {
    const modal = await this.modalCtrl.create({
      component: UserPickerComponent,
      // Signal inputs are populated from componentProps (app sets useSetInputAPI).
      componentProps: {
        title: options.title,
        confirmLabel: options.confirmLabel,
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      },
      cssClass: MODAL_CSS_CLASS,
    });
    await modal.present();
    const { data } = await modal.onWillDismiss<string | null>();
    return data ?? null;
  }
}
