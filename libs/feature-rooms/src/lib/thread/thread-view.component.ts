import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize, type Observable } from 'rxjs';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  IonContent,
  IonFooter,
  AlertController,
  ModalController,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { close } from 'ionicons/icons';
import {
  ThreadsService,
  isEditableMessage,
  type MessageView,
} from '@trinity/core';
import {
  MessageRowComponent,
  type MessageRow,
} from '../message-row/message-row.component';
import { MessageComposerComponent } from '../message-composer/message-composer.component';

/** Group consecutive messages from the same sender within this window (Discord-style). */
const GROUP_GAP_MS = 5 * 60 * 1000;

/**
 * Thread view: the root message plus its replies, with an in-thread composer.
 * Reuses the shared {@link MessageRowComponent} so a thread renders exactly like
 * the main timeline (avatars, markdown, media, reactions, the hover toolbar) and
 * the shared {@link MessageComposerComponent} so composing behaves identically
 * (Enter sends, edit/reply banners, emoji, attachments).
 *
 * Orchestration mirrors {@link MessageListComponent} but routes every action
 * through {@link ThreadsService}'s thread-scoped methods, which carry the thread
 * relation so sends/edits/replies stay in the thread. Presented as an Ionic modal
 * (a full-height side panel on desktop, full-screen on mobile) via
 * {@link ThreadPanelService}; `roomId`/`rootEventId` arrive as signal inputs.
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
    IonFooter,
    MessageRowComponent,
    MessageComposerComponent,
  ],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnInit, OnDestroy {
  private readonly threads = inject(ThreadsService);
  private readonly modalCtrl = inject(ModalController);
  private readonly alertCtrl = inject(AlertController);
  private readonly toast = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  readonly roomId = input.required<string>();
  readonly rootEventId = input.required<string>();
  /** Notifies any @Output-bound host that the view closed (for symmetry/tests). */
  readonly closed = output<void>();

  /** Id of the thread message being edited, or null. */
  readonly editingId = signal<string | null>(null);
  /** Id of the thread message being replied to, or null. */
  readonly replyingToId = signal<string | null>(null);
  /** Attachment upload fraction in [0, 1] while a send uploads, else null (idle). */
  readonly uploadProgress = signal<number | null>(null);

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

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

  readonly editingDraft = computed(
    () =>
      this.threads.threadMessages().find((m) => m.id === this.editingId())
        ?.body ?? '',
  );

  readonly replyingToName = computed(
    () =>
      this.threads.threadMessages().find((m) => m.id === this.replyingToId())
        ?.senderName ?? '',
  );

  /** Whether older thread replies remain to be paged in. */
  readonly canLoadOlder = this.threads.canPaginateThread;
  /** Whether an older-replies page is currently loading. */
  readonly loadingOlder = this.threads.loadingOlderThread;

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

  /** Page in older replies for this thread (mirrors the timeline's load-older). */
  loadOlder(): void {
    this.threads
      .paginateOpenThread()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Composer submit — routes to an edit or reply when active, else a new send. */
  onSubmit(text: string): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editingId.set(null);
      this.runAction(
        this.threads.editInThread(editId, text),
        'Could not edit the message.',
      );
    } else if (replyId) {
      this.replyingToId.set(null);
      // The reply's local echo (and its failed/retry state) surfaces the result.
      this.threads
        .replyInThread(replyId, text)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    } else {
      this.threads
        .sendToThread(text)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  onSendMedia(file: File): void {
    this.uploadProgress.set(0);
    this.threads
      .sendMediaToThread(file, (fraction) => this.uploadProgress.set(fraction))
      .pipe(
        finalize(() => this.uploadProgress.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => void this.showError('Could not upload the attachment.'),
      });
  }

  startEdit(row: MessageRow): void {
    this.replyingToId.set(null);
    this.editingId.set(row.id);
  }

  startReply(row: MessageRow): void {
    this.editingId.set(null);
    this.replyingToId.set(row.id);
  }

  /** A thread message the current user can still edit (own, confirmed, text). */
  isEditable(m: MessageView): boolean {
    return isEditableMessage(m);
  }

  /** Edit the most recent editable own message in the thread (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.threads.threadMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (this.isEditable(msgs[i])) {
        this.editingId.set(msgs[i].id);
        return;
      }
    }
  }

  onCopy(row: MessageRow): void {
    void navigator.clipboard?.writeText(row.body);
  }

  onReact(messageId: string, key: string): void {
    this.runAction(
      this.threads.toggleReactionInThread(messageId, key),
      'Could not update the reaction.',
    );
  }

  onRetry(messageId: string): void {
    this.threads.retryInThread(messageId);
  }

  async onDelete(row: MessageRow): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () =>
            this.runAction(
              this.threads.redactInThread(row.id),
              'Could not delete the message.',
            ),
        },
      ],
    });
    await alert.present();
  }

  /** Scroll the original message into view when its reply preview is clicked. */
  jumpTo(messageId: string): void {
    this.scrollEl()
      ?.nativeElement.querySelector(`[data-mid="${messageId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Run a fire-and-forget thread action, surfacing a failure as a toast. */
  private runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => void this.showError(failureMessage),
    });
  }

  private async showError(message: string): Promise<void> {
    const toast = await this.toast.create({
      message,
      duration: 4000,
      color: 'danger',
      position: 'bottom',
    });
    await toast.present();
  }
}
