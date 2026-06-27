import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import {
  IonSplitPane,
  IonMenu,
  IonMenuButton,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonIcon,
  MenuController,
  ToastController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { lockClosed } from 'ionicons/icons';
import {
  AuthService,
  CryptoService,
  MatrixClientService,
  MediaService,
  RoomsService,
  TimelineService,
} from '@trinity/core';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { MessageListComponent } from '../message-list/message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive `ion-split-pane`/`ion-menu`), the read timeline, and a member list.
 * Wired to live synced rooms via `RoomsService` + `TimelineService`.
 */
@Component({
  selector: 'trn-rooms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'rooms.page.html',
  styleUrls: ['rooms.page.scss'],
  imports: [
    IonSplitPane,
    IonMenu,
    IonMenuButton,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonIcon,
    ServerRailComponent,
    ChannelSidebarComponent,
    MemberListComponent,
    MessageListComponent,
    EncryptionBannerComponent,
  ],
})
export class RoomsPage implements OnInit, OnDestroy {
  readonly rooms = inject(RoomsService);
  readonly timeline = inject(TimelineService);
  private readonly media = inject(MediaService);
  private readonly matrix = inject(MatrixClientService);
  private readonly crypto = inject(CryptoService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly menu = inject(MenuController);
  private readonly toast = inject(ToastController);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeSpaceId = signal<string | null>(null);
  readonly activeRoomId = signal<string | null>(null);

  readonly visibleRooms = computed(() =>
    this.rooms.roomsForSpace(this.activeSpaceId()),
  );

  readonly activeSpaceName = computed(() => {
    const id = this.activeSpaceId();
    if (!id) {
      return 'Home';
    }
    return this.rooms.spaces().find((s) => s.id === id)?.name ?? 'Home';
  });

  readonly activeRoom = computed(() => {
    const id = this.activeRoomId();
    return id ? (this.rooms.rooms().find((r) => r.id === id) ?? null) : null;
  });

  readonly members = computed(() => {
    this.rooms.revision();
    return this.rooms.membersOf(this.activeRoomId());
  });

  readonly userId = signal(
    this.matrix.isInitialized ? (this.matrix.instance.getUserId() ?? '') : '',
  );

  readonly userName = computed(() => {
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return uid;
    }
    return this.matrix.instance.getUser(uid)?.displayName ?? uid;
  });

  readonly userInitial = computed(() => {
    const name = this.userName().replace(/^[@#!]+/, '');
    return (name[0] ?? '?').toUpperCase();
  });

  readonly syncLabel = computed(() => {
    const state = String(this.matrix.syncState() ?? '');
    if (state === 'PREPARED' || state === 'SYNCING') {
      return 'Welcome to Trinity';
    }
    if (state === 'ERROR' || state === 'RECONNECTING') {
      return 'Reconnecting…';
    }
    return 'Connecting…';
  });

  constructor() {
    addIcons({ lockClosed });
  }

  ngOnInit(): void {
    this.rooms.connect();
    this.crypto.connect();
  }

  ngOnDestroy(): void {
    this.timeline.close();
    this.media.releaseAll();
  }

  onSelectSpace(id: string | null): void {
    this.activeSpaceId.set(id);
  }

  onSelectRoom(id: string): void {
    // Drop the previous room's resolved media URLs before switching timelines.
    this.media.releaseAll();
    this.activeRoomId.set(id);
    this.timeline.open(id);
    void this.menu.close(); // collapse the drawer on mobile (fire-and-forget)
  }

  loadOlder(): void {
    this.timeline
      .loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSend(text: string): void {
    // The local echo (and its failed/retry state) surfaces the result.
    this.timeline
      .send(text)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSendMedia(file: File): void {
    // The upload phase has no echo, so surface its failure as a toast. Once the
    // event is sent the SDK echo + retry path takes over (like onSend).
    this.runAction(
      this.timeline.sendMedia(file),
      'Could not upload the attachment.',
    );
  }

  // Edit/delete/react have no visible local echo, so a failure would otherwise be
  // silent — surface it as a toast. (Send/reply produce an echo with a retry.)
  onEdit(edit: { id: string; body: string }): void {
    this.runAction(
      this.timeline.edit(edit.id, edit.body),
      'Could not edit the message.',
    );
  }

  onDelete(messageId: string): void {
    this.runAction(
      this.timeline.redact(messageId),
      'Could not delete the message.',
    );
  }

  onReact(reaction: { id: string; key: string }): void {
    this.runAction(
      this.timeline.toggleReaction(reaction.id, reaction.key),
      'Could not update the reaction.',
    );
  }

  onReply(reply: { id: string; body: string }): void {
    this.timeline
      .reply(reply.id, reply.body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Run a fire-and-forget timeline action, surfacing a failure as a toast. */
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

  logout(): void {
    this.auth
      .logout()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      });
  }
}
