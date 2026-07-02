import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Observable, finalize } from 'rxjs';
import {
  ActionSheetController,
  IonSplitPane,
  IonMenu,
  IonMenuButton,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  MenuController,
  ModalController,
} from '@ionic/angular/standalone';
import { TrnAlertService, TrnToastService } from '@trinity/ui-spartan';
import { addIcons } from 'ionicons';
import {
  chatbubblesOutline,
  lockClosed,
  personAddOutline,
  searchCircleOutline,
  searchOutline,
  settingsOutline,
} from 'ionicons/icons';
import {
  AuthService,
  CryptoService,
  InvitesService,
  MatrixClientService,
  MediaService,
  NotificationService,
  PushService,
  RoomsService,
  SpacesService,
  ThreadsService,
  TimelineService,
  type RoomSummary,
  type SpaceChildRoom,
  type SwitcherSelection,
} from '@trinity/core';
import { runWithBusy } from '@trinity/ui';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { MessageListComponent } from '../message-list/message-list.component';
import { EncryptionBannerComponent } from '../encryption-banner/encryption-banner.component';
import { ConnectivityBannerComponent } from '../connectivity-banner/connectivity-banner.component';
import { ThreadPanelService } from '../thread/thread-panel.service';

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
    IonButton,
    IonIcon,
    ServerRailComponent,
    ChannelSidebarComponent,
    MemberListComponent,
    MessageListComponent,
    EncryptionBannerComponent,
    ConnectivityBannerComponent,
  ],
})
export class RoomsPage implements OnInit, OnDestroy {
  readonly rooms = inject(RoomsService);
  readonly spaces = inject(SpacesService);
  readonly invites = inject(InvitesService);
  readonly timeline = inject(TimelineService);
  readonly threads = inject(ThreadsService);
  private readonly threadPanel = inject(ThreadPanelService);
  private readonly userPicker = inject(UserPickerService);
  private readonly switcher = inject(QuickSwitcherService);
  private readonly messageSearch = inject(MessageSearchService);
  private readonly media = inject(MediaService);
  private readonly matrix = inject(MatrixClientService);
  private readonly crypto = inject(CryptoService);
  private readonly push = inject(PushService);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly menu = inject(MenuController);
  private readonly modalCtrl = inject(ModalController);
  private readonly toast = inject(TrnToastService);
  private readonly alert = inject(TrnAlertService);
  private readonly actionSheetCtrl = inject(ActionSheetController);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeSpaceId = signal<string | null>(null);
  readonly activeRoomId = signal<string | null>(null);
  /**
   * Event id the message list should scroll to, set when in-room search resolves a
   * hit. Bound to the list's `jumpToId`; reset to null first so re-selecting the same
   * message re-triggers the jump.
   */
  readonly messageSearchTarget = signal<string | null>(null);
  /** Attachment upload fraction in [0, 1] while a send is uploading, else null. */
  readonly uploadProgress = signal<number | null>(null);

  /** A create-space / create-channel / leave-space action is in flight. */
  readonly spaceBusy = signal(false);
  /** Last space-management failure (surfaced as a toast); null when clear. */
  readonly spaceError = signal<string | null>(null);

  /**
   * Rooms shown in the channel sidebar. Home (`null`) shows every joined room in
   * recency order (as before). A selected space shows only its joined child rooms,
   * in the space's own order (`m.space.child` `order` then name). Both read live
   * signals, so the list reacts to sync, membership, and `m.space.child` changes.
   */
  readonly visibleRooms = computed<RoomSummary[]>(() => {
    const spaceId = this.activeSpaceId();
    const all = this.rooms.rooms();
    if (!spaceId) {
      return all;
    }
    const byId = new Map(all.map((room) => [room.id, room] as const));
    return this.spaces
      .childRoomIds(spaceId)
      .map((id) => byId.get(id))
      .filter((room): room is RoomSummary => room !== undefined);
  });

  readonly activeSpaceName = computed(() => {
    const id = this.activeSpaceId();
    if (!id) {
      return 'Home';
    }
    return this.spaces.spaces().find((s) => s.id === id)?.name ?? 'Home';
  });

  readonly activeRoom = computed(() => {
    const id = this.activeRoomId();
    return id ? (this.rooms.rooms().find((r) => r.id === id) ?? null) : null;
  });

  readonly members = computed(() => {
    // Recompute only when membership actually changes — not on every sync tick or
    // read receipt (those bump `revision`, which the member list doesn't depend on).
    this.rooms.memberRevision();
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

  readonly userAvatarMxc = computed(() => {
    this.rooms.revision(); // re-read once the user's profile hydrates on sync
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return null;
    }
    return this.matrix.instance.getUser(uid)?.avatarUrl ?? null;
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
    addIcons({
      chatbubblesOutline,
      lockClosed,
      personAddOutline,
      searchCircleOutline,
      searchOutline,
      settingsOutline,
    });
    // Space-management failures (create/leave) have no inline echo in the shell, so
    // surface each new error as a danger toast. runWithBusy captures the message
    // into spaceError; this reacts to that signal turning non-null.
    effect(() => {
      const message = this.spaceError();
      if (message) {
        void this.showError(message);
      }
    });
  }

  ngOnInit(): void {
    this.rooms.connect();
    this.spaces.connect();
    this.invites.connect();
    this.crypto.connect();
    // Register for push once the authenticated shell is live (covers both fresh
    // login and a restored session). Best-effort + native-only; no-op elsewhere.
    this.push.register().subscribe({ error: () => undefined });
    // Desktop/web OS notifications from live sync (no-op on native mobile + web
    // without permission). Listener dies with the client on logout/reset.
    this.notifications.connect();
  }

  ngOnDestroy(): void {
    this.timeline.close();
    this.threads.close();
    this.threads.closeThread();
    this.invites.disconnect();
    this.media.releaseAll();
  }

  /**
   * Global quick switcher. `meta` is Cmd (macOS) and `control` is Ctrl (Win/Linux);
   * Angular auto-unbinds both on destroy, and the chord's modifier means plain typing
   * (including in the composer) never triggers it. `preventDefault` stops the
   * browser's own Cmd/Ctrl+K. Re-entrancy is guarded in {@link QuickSwitcherService}.
   */
  // Angular 21 type-checks host listeners; `document:keydown` is typed as the base
  // `Event`, so accept that and just call the shared `preventDefault`.
  @HostListener('document:keydown.meta.k', ['$event'])
  @HostListener('document:keydown.control.k', ['$event'])
  onQuickSwitch(event: Event): void {
    event.preventDefault();
    void this.openSwitcher();
  }

  /**
   * Open the switcher and jump to the selection: room/DM open the room, space selects
   * it in the rail, a directory person opens (or reuses) a DM, an invite runs the
   * page's existing accept path. Also the header search button's handler.
   *
   * Bail when an overlay already owns the screen: the Cmd/Ctrl+K shortcut fires even
   * while a thread/search/verification modal is open (RoomsPage isn't destroyed), so
   * without this it would stack the switcher over that modal — and picking a result
   * runs onSelectRoom() → media.releaseAll(), revoking the open modal's pinned blobs.
   */
  async openSwitcher(): Promise<void> {
    if (await this.modalCtrl.getTop()) {
      return; // an overlay owns the screen — don't stack the switcher over it
    }
    const selection = await this.switcher.pick();
    if (!selection) {
      return; // cancelled / already open
    }
    this.jumpTo(selection);
  }

  private jumpTo(selection: SwitcherSelection): void {
    switch (selection.kind) {
      case 'room':
      case 'dm':
        this.onSelectRoom(selection.id);
        break;
      case 'space':
        this.onSelectSpace(selection.id);
        break;
      case 'user':
        this.spaceError.set(null);
        runWithBusy(this.rooms.createDirectMessage(selection.id), {
          busy: this.spaceBusy,
          error: this.spaceError,
          destroyRef: this.destroyRef,
        }).subscribe((roomId) => this.onSelectRoom(roomId));
        break;
      case 'invite':
        this.onAcceptInvite(selection.id);
        break;
    }
  }

  /**
   * Open in-room message search for the active room and, on a chosen hit, jump the
   * timeline to that event. Resetting the target to null first guarantees the list's
   * jump effect re-fires even when the same message is picked again.
   */
  async openMessageSearch(): Promise<void> {
    const roomId = this.activeRoomId();
    if (!roomId) {
      return;
    }
    const eventId = await this.messageSearch.search(roomId);
    if (!eventId) {
      return; // cancelled / already open
    }
    this.messageSearchTarget.set(null);
    this.messageSearchTarget.set(eventId);
  }

  onSelectSpace(id: string | null): void {
    this.activeSpaceId.set(id);
    // Load (or clear, for Home) the space's full child hierarchy so the sidebar can
    // offer not-yet-joined channels + sub-spaces. The fetch is cancelled/replaced if
    // the selection changes again before it lands.
    this.spaces.openSpace(id);
  }

  /** Rail "+": prompt for a name, create the space, then select it on success. */
  async onCreateSpace(): Promise<void> {
    this.spaceError.set(null); // don't carry a stale error into a fresh action
    const name = await this.alert.prompt({
      header: 'Create a space',
      message: 'A space groups related rooms, like a Discord server.',
      placeholder: 'Space name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateSpace(name);
    }
  }

  /** Sidebar "+": prompt for a name and create a room inside the active space. */
  async onCreateChannel(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return; // the affordance is hidden on Home, but guard regardless
    }
    this.spaceError.set(null);
    const name = await this.alert.prompt({
      header: 'Create a channel',
      message: `New channels are end-to-end encrypted and added to “${this.activeSpaceName()}”.`,
      placeholder: 'Channel name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateChannel(spaceId, name);
    }
  }

  /** Sidebar exit icon: confirm, then leave the active space (back to Home). */
  async onLeaveSpace(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return;
    }
    this.spaceError.set(null);
    if (
      await this.alert.confirm({
        header: 'Leave space',
        message: `Leave “${this.activeSpaceName()}”? Its rooms stay on your account — only the space is left.`,
        confirmText: 'Leave',
        destructive: true,
      })
    ) {
      this.applyLeaveSpace(spaceId);
    }
  }

  private applyCreateSpace(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss the prompt without creating
    }
    runWithBusy(this.spaces.createSpace({ name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((spaceId) => this.onSelectSpace(spaceId));
  }

  private applyCreateChannel(spaceId: string, name: string): void {
    if (!name.trim()) {
      return;
    }
    // The new room surfaces in the sidebar live via Rooms/Spaces sync listeners.
    runWithBusy(this.spaces.createRoomInSpace(spaceId, { name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  private applyLeaveSpace(spaceId: string): void {
    runWithBusy(this.spaces.leaveSpace(spaceId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => this.onSelectSpace(null));
  }

  /** Sidebar "Join" on a not-yet-joined child: join it (via its routing servers). */
  onJoinChild(child: SpaceChildRoom): void {
    this.spaceError.set(null);
    // On success the child lands in the synced read model — a room moves into the
    // joined channel list, a space into the rail — and its `joined` flag flips live,
    // dropping it from the "more channels"/Spaces lists. No manual selection here.
    runWithBusy(this.spaces.joinRoom(child.roomId, child.via), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  /** Sidebar remove icon on a joined channel: confirm, then unlink it from the space. */
  async onRemoveFromSpace(roomId: string): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (!spaceId) {
      return; // the affordance only shows in a space, but guard regardless
    }
    this.spaceError.set(null);
    const name =
      this.rooms.rooms().find((r) => r.id === roomId)?.name ?? 'this channel';
    if (
      await this.alert.confirm({
        header: 'Remove from space',
        message: `Remove “${name}” from “${this.activeSpaceName()}”? You stay in the room — it’s just unlinked from this space.`,
        confirmText: 'Remove',
        destructive: true,
      })
    ) {
      this.applyRemoveFromSpace(spaceId, roomId);
    }
  }

  private applyRemoveFromSpace(spaceId: string, childId: string): void {
    runWithBusy(this.spaces.removeRoomFromSpace(spaceId, childId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  /** Home "+": choose between creating a room and starting a DM. */
  async onNewChat(): Promise<void> {
    const sheet = await this.actionSheetCtrl.create({
      header: 'New message',
      buttons: [
        { text: 'Create a room', handler: () => void this.onCreateRoom() },
        {
          text: 'Start a direct message',
          handler: () => void this.onStartDm(),
        },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  /** Prompt for a name, create a standalone encrypted room, then select it. */
  async onCreateRoom(): Promise<void> {
    this.spaceError.set(null);
    const name = await this.alert.prompt({
      header: 'Create a room',
      message: 'New rooms are end-to-end encrypted.',
      placeholder: 'Room name',
      confirmText: 'Create',
      maxLength: 100,
    });
    if (name !== null) {
      this.applyCreateRoom(name);
    }
  }

  /** Pick a user (MXID or directory), open/reuse a DM with them, then select it. */
  async onStartDm(): Promise<void> {
    this.spaceError.set(null);
    const userId = await this.userPicker.pick({
      title: 'Start a direct message',
      confirmLabel: 'Message',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(this.rooms.createDirectMessage(userId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((roomId) => this.onSelectRoom(roomId));
  }

  /** Open-room header: invite a user to the active room. */
  async onInviteToRoom(): Promise<void> {
    const roomId = this.activeRoomId();
    if (roomId) {
      await this.invitePeople(roomId, this.activeRoom()?.name ?? 'this room');
    }
  }

  /** Space sidebar: invite a user to the active space. */
  async onInviteToSpace(): Promise<void> {
    const spaceId = this.activeSpaceId();
    if (spaceId) {
      await this.invitePeople(spaceId, this.activeSpaceName());
    }
  }

  /** Accept a pending invite (join); select the joined room when it's not a space. */
  onAcceptInvite(roomId: string): void {
    this.spaceError.set(null);
    const invite = this.invites
      .pendingInvites()
      .find((i) => i.roomId === roomId);
    runWithBusy(this.invites.acceptInvite(roomId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => {
      // A joined room/DM lives under Home; surface it by switching there and
      // opening it. A joined space just appears in the rail (no auto-select).
      if (invite && !invite.isSpace) {
        this.onSelectSpace(null);
        this.onSelectRoom(roomId);
      }
    });
  }

  /** Decline a pending invite (leave the invited room/space). */
  onDeclineInvite(roomId: string): void {
    this.spaceError.set(null);
    runWithBusy(this.invites.declineInvite(roomId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  private applyCreateRoom(name: string): void {
    if (!name.trim()) {
      return; // empty name — dismiss without creating
    }
    runWithBusy(this.rooms.createRoom({ name }), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe((roomId) => this.onSelectRoom(roomId));
  }

  /** Shared invite flow for a room or space: pick a user, invite, then toast. */
  private async invitePeople(targetId: string, label: string): Promise<void> {
    this.spaceError.set(null);
    const userId = await this.userPicker.pick({
      title: `Invite to ${label}`,
      confirmLabel: 'Invite',
    });
    if (!userId) {
      return; // cancelled
    }
    runWithBusy(this.rooms.inviteUser(targetId, userId), {
      busy: this.spaceBusy,
      error: this.spaceError,
      destroyRef: this.destroyRef,
    }).subscribe(() => void this.showSuccess(`Invitation sent to ${userId}.`));
  }

  onSelectRoom(id: string): void {
    // Drop the previous room's resolved media URLs before switching timelines.
    this.media.releaseAll();
    this.activeRoomId.set(id);
    this.timeline.open(id);
    this.threads.open(id); // project this room's thread summaries for indicators
    void this.menu.close(); // collapse the drawer on mobile (fire-and-forget)
  }

  /** Open the thread rooted at `rootEventId` (raised by a message's indicator). */
  onOpenThread(rootEventId: string): void {
    const roomId = this.activeRoomId();
    if (roomId) {
      void this.threadPanel.open(roomId, rootEventId);
    }
  }

  /** Open the threads-list panel for the active room (header "Threads" button). */
  openThreadsList(): void {
    const roomId = this.activeRoomId();
    if (roomId) {
      void this.threadPanel.openList(roomId);
    }
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
    // The upload phase has no echo, so drive a determinate progress bar from the
    // upload fraction and surface a failure as a toast. Once the event is sent the
    // SDK echo + retry path takes over (like onSend). finalize() clears the bar on
    // success, error, or unsubscribe — runAction has no such hook, so subscribe here.
    this.uploadProgress.set(0);
    this.timeline
      .sendMedia(file, (fraction) => this.uploadProgress.set(fraction))
      .pipe(
        finalize(() => this.uploadProgress.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => void this.showError('Could not upload the attachment.'),
      });
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

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }

  private showSuccess(message: string): void {
    this.toast.show(message, { duration: 3000, variant: 'success' });
  }

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
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
