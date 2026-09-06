import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  RoomMembersService,
  type MemberSummary,
  type RoomAdministrationAvailability,
  type RoomMembersSnapshot,
  type RoomSettingsTarget,
} from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { filter, map, switchMap } from 'rxjs';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { MemberInfoComponent } from '../member-info/member-info.component';
import { MemberListComponent } from '../member-list/member-list.component';
import { UserPickerService } from '../user-picker/user-picker.service';

type MembersDestination = 'current' | 'banned';

/** Exact-target Room or Space member administration inside the shared settings hub. */
@Component({
  selector: 'trn-members-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BannedMembersComponent,
    MemberInfoComponent,
    MemberListComponent,
    TrnButton,
  ],
  templateUrl: './members-settings.component.html',
  styleUrl: './members-settings.component.scss',
})
export class MembersSettingsComponent implements OnInit {
  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly targetName = input.required<string>();
  readonly noun = input.required<'Room' | 'Space'>();
  readonly showUnavailableReason = input(true);
  readonly direct = input(false);

  private readonly members = inject(RoomMembersService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly picker = inject(UserPickerService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly destination = signal<MembersDestination>('current');
  readonly selectedMember = signal<MemberSummary | null>(null);
  readonly snapshot = signal<RoomMembersSnapshot | null>(null);
  readonly authorityRevision = signal(0);
  readonly inviting = signal(false);
  readonly target = computed<RoomSettingsTarget>(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
  }));
  readonly availability = computed<RoomAdministrationAvailability>(() =>
    this.snapshot()?.availability === 'available' ? 'coherent' : 'unavailable',
  );
  readonly invitePermission = computed(() => {
    this.authorityRevision();
    return this.permissions.roomFor(this.target()).invite;
  });

  ngOnInit(): void {
    const target = this.target();
    this.members
      .observe(target)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => {
        this.snapshot.update((previous) =>
          snapshot.availability === 'available' || !previous
            ? snapshot
            : {
                ...snapshot,
                members: previous.members,
                banned: previous.banned,
              },
        );
        this.authorityRevision.update((revision) => revision + 1);
      });
  }

  selectDestination(destination: MembersDestination): void {
    this.destination.set(destination);
    this.selectedMember.set(null);
  }

  selectMember(member: MemberSummary): void {
    this.selectedMember.set(member);
  }

  dismissMember(): void {
    this.selectedMember.set(null);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>('[data-testid="member-filter"]')
          ?.focus(),
      { injector: this.injector },
    );
  }

  /** Allow the settings dialog's Back owner to retreat to the roster first. */
  dismissNestedSurface(): boolean {
    if (!this.selectedMember()) return false;
    this.dismissMember();
    return true;
  }

  invite(): void {
    if (this.inviting() || !this.invitePermission().available) return;
    const target = this.target();
    const targetName = this.targetName();
    this.picker
      .pick$({
        title: `Invite to ${targetName}`,
        confirmLabel: 'Invite',
      })
      .pipe(
        filter((userId): userId is string => Boolean(userId)),
        switchMap((userId) => {
          this.inviting.set(true);
          return this.rooms.inviteUser(target, userId).pipe(map(() => userId));
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (userId) => {
          this.inviting.set(false);
          this.toast.show(`Invited ${userId} to ${targetName}.`, {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.inviting.set(false);
          this.toast.show(`Could not invite this person to ${targetName}.`, {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  message(userId: string): void {
    this.workspace
      .navigate({
        kind: 'person',
        accountId: this.accountId(),
        userId,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'ready') this.dialogRef.close(false);
        },
        error: () =>
          this.toast.show('Could not open a direct message.', {
            duration: 4000,
            variant: 'danger',
          }),
      });
  }
}
