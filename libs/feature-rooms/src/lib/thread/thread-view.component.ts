import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
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
import { ThreadsService } from '@trinity/core';
import {
  MessageRowComponent,
  type MessageRow,
} from '../message-row/message-row.component';

/** Group consecutive messages from the same sender within this window (Discord-style). */
const GROUP_GAP_MS = 5 * 60 * 1000;

/**
 * Read-only thread view: the root message plus its replies, reusing the shared
 * {@link MessageRowComponent} so a thread renders exactly like the main timeline
 * (avatars, markdown, media, reactions) with the same "unable to decrypt" fallback.
 *
 * Presented as an Ionic modal (a full-height side panel on the wide/desktop layout,
 * full-screen on mobile) via {@link ThreadPanelService}. `roomId`/`rootEventId` are
 * supplied as `componentProps` and land on these signal inputs (the app enables
 * `useSetInputAPI`). View-only for now — no composer; the structure leaves room to
 * add an in-thread composer next.
 */
@Component({
  selector: 'trn-thread-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    MessageRowComponent,
  ],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnInit, OnDestroy {
  private readonly threads = inject(ThreadsService);
  private readonly modalCtrl = inject(ModalController);

  readonly roomId = input.required<string>();
  readonly rootEventId = input.required<string>();
  /** Notifies any @Output-bound host that the view closed (for symmetry/tests). */
  readonly closed = output<void>();

  /** The thread's messages (root first, then replies), grouped for display. */
  readonly rows = computed<MessageRow[]>(() => {
    const msgs = this.threads.threadMessages();
    return msgs.map((m, i) => {
      const prev = msgs[i - 1];
      const showHeader =
        !prev ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GROUP_GAP_MS;
      return { ...m, showHeader };
    });
  });

  constructor() {
    addIcons({ close });
  }

  ngOnInit(): void {
    this.threads.openThread(this.roomId(), this.rootEventId());
  }

  ngOnDestroy(): void {
    this.threads.closeThread();
  }

  /** Dismiss the host modal (Output bindings aren't wired on modal components). */
  close(): void {
    this.closed.emit();
    void this.modalCtrl.dismiss();
  }
}
