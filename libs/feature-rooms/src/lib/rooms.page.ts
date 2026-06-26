import {
  Component,
  DestroyRef,
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
import { AuthService, MatrixClientService, RoomsService } from '@trinity/core';
import { ServerRailComponent } from './server-rail.component';
import { ChannelSidebarComponent } from './channel-sidebar.component';
import { MemberListComponent } from './member-list.component';

/**
 * Discord-style authenticated shell: server rail + channel sidebar (in a
 * responsive `ion-split-pane`/`ion-menu`), a main column, and a member list.
 * Wired to live synced rooms via `RoomsService`; the timeline is a later milestone.
 */
@Component({
  selector: 'app-rooms',
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
  ],
})
export class RoomsPage implements OnInit {
  readonly rooms = inject(RoomsService);
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

  onSelectSpace(id: string | null): void {
    this.activeSpaceId.set(id);
  }

  onSelectRoom(id: string): void {
    this.activeRoomId.set(id);
    void this.menu.close(); // collapse the drawer on mobile (fire-and-forget)
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
