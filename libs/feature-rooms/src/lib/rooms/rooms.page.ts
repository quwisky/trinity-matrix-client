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
import {
  IonSplitPane,
  IonMenu,
  IonMenuButton,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  MenuController,
} from '@ionic/angular/standalone';
import {
  AuthService,
  MatrixClientService,
  RoomsService,
  TimelineService,
} from '@trinity/core';
import { ServerRailComponent } from '../server-rail/server-rail.component';
import { ChannelSidebarComponent } from '../channel-sidebar/channel-sidebar.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { MessageListComponent } from '../message-list/message-list.component';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive `ion-split-pane`/`ion-menu`), the read timeline, and a member list.
 * Wired to live synced rooms via `RoomsService` + `TimelineService`.
 */
@Component({
  selector: 'app-rooms',
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
    ServerRailComponent,
    ChannelSidebarComponent,
    MemberListComponent,
    MessageListComponent,
  ],
})
export class RoomsPage implements OnInit, OnDestroy {
  readonly rooms = inject(RoomsService);
  readonly timeline = inject(TimelineService);
  private readonly matrix = inject(MatrixClientService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly menu = inject(MenuController);
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

  ngOnInit(): void {
    this.rooms.connect();
  }

  ngOnDestroy(): void {
    this.timeline.close();
  }

  onSelectSpace(id: string | null): void {
    this.activeSpaceId.set(id);
  }

  onSelectRoom(id: string): void {
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

  logout(): void {
    this.auth
      .logout()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      });
  }
}
