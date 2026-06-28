import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  IonContent,
  ModalController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { close } from 'ionicons/icons';
import { AvatarComponent } from '@trinity/ui';
import { ThreadsService, type ThreadSummary } from '@trinity/core';

/** Most participant avatars shown per row before the "+N" overflow chip. */
const MAX_AVATARS = 4;

/**
 * Threads-list panel: every thread in the active room, newest activity first,
 * each row showing the root preview, reply count, last-activity time, a
 * participant avatar cluster, and an unread badge. Reads the live
 * {@link ThreadsService.threadList} (already projected for the active room by the
 * rooms shell), so it reacts to new threads, replies, and unread changes.
 *
 * Presented as an Ionic modal (desktop side panel / mobile full-screen) by
 * {@link ThreadPanelService}; `roomId` arrives as a signal input. Tapping a row
 * dismisses this modal with the chosen root id, and the panel service re-opens it
 * as a {@link ThreadViewComponent} — keeping this component free of any thread-open
 * dependency (and the two modals from stacking).
 */
@Component({
  selector: 'trn-threads-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    DatePipe,
    AvatarComponent,
  ],
  templateUrl: './threads-list.component.html',
  styleUrl: './threads-list.component.scss',
})
export class ThreadsListComponent {
  private readonly threadsSvc = inject(ThreadsService);
  private readonly modalCtrl = inject(ModalController);

  /** The room whose threads are listed (used by the panel to re-open a thread). */
  readonly roomId = input.required<string>();

  /** The active room's threads, newest activity first. */
  readonly threads = this.threadsSvc.threadList;

  /** Avatars shown per row, capped — the rest collapse into a "+N" chip. */
  readonly maxAvatars = MAX_AVATARS;

  constructor() {
    addIcons({ close });
  }

  /** Dismiss this list, handing the chosen thread root back to the panel service. */
  openThread(rootEventId: string): void {
    void this.modalCtrl.dismiss(rootEventId);
  }

  /** Close the panel without opening a thread. */
  close(): void {
    void this.modalCtrl.dismiss();
  }

  /** Accessible label for a row's unread badge. */
  unreadLabel(summary: ThreadSummary): string {
    return summary.highlight
      ? `${summary.unreadCount} unread mentions`
      : `${summary.unreadCount} unread`;
  }
}
