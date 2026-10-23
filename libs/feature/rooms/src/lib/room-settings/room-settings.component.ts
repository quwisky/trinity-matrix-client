import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import {
  TrnDialogRef,
  TrnSettingsGroupComponent,
} from '@trinity/components/overlay';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import type { RoomWidgetTarget } from '@trinity/data-access/widgets';
import { MembersSettingsComponent } from '../members-settings/members-settings.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import {
  SettingsHubComponent,
  type SettingsHubSection,
} from '../shared/settings-hub/settings-hub.component';
import { PlaceGeneralSettingsComponent } from '../shared/place-general-settings/place-general-settings.component';
import { SettingsHubController } from '../shared/settings-hub/settings-hub.controller';
import { RoomSettingsAccessComponent } from './room-settings-access.component';
import { RoomSettingsAdvancedComponent } from './room-settings-advanced.component';
import { RoomSettingsDirectoryComponent } from './room-settings-directory/room-settings-directory.component';
import { RoomSettingsDraftService } from './room-settings-draft.service';
import { RoomSettingsEmojiComponent } from './room-settings-emoji/room-settings-emoji.component';
import { RoomSettingsEncryptionComponent } from './room-settings-encryption/room-settings-encryption.component';
import { RoomSettingsForYouComponent } from './room-settings-for-you/room-settings-for-you.component';
import { RoomSettingsForYouDraftService } from './room-settings-for-you/room-settings-for-you-draft.service';
import type { ParentSpace, RoomSettingsResult } from './room-settings.models';
import { RoomWidgetsComponent } from './room-widgets.component';

type RoomSettingsSection =
  | 'general'
  | 'for-you'
  | 'access'
  | 'members'
  | 'addresses'
  | 'widgets'
  | 'emoji'
  | 'advanced';

const SECTIONS: readonly (SettingsHubSection & {
  readonly value: RoomSettingsSection;
})[] = [
  {
    value: 'general',
    icon: 'settings',
    group: 'Overview',
    label: 'General',
    description: 'Photo, name, topic, and encryption',
  },
  {
    value: 'for-you',
    icon: 'user',
    group: 'Personal',
    label: 'For you',
    description: 'Notifications and organisation',
  },
  {
    value: 'access',
    icon: 'lock',
    group: 'Manage',
    label: 'Access',
    description: 'Who can join and read history',
  },
  {
    value: 'members',
    icon: 'users',
    group: 'Manage',
    label: 'Members',
    description: 'People, roles, invitations, and bans',
  },
  {
    value: 'addresses',
    icon: 'link',
    group: 'Manage',
    label: 'Addresses',
    description: 'Published room links',
  },
  {
    value: 'widgets',
    icon: 'square-code',
    group: 'Manage',
    label: 'Widgets',
    description: 'Connected room tools',
  },
  {
    value: 'emoji',
    icon: 'smile',
    group: 'Manage',
    label: 'Emoji',
    description: 'Custom emoji and stickers',
  },
  {
    value: 'advanced',
    icon: 'braces',
    group: 'Developer',
    label: 'Advanced',
    description: 'Room ID, version, and room state',
  },
];

/** Responsive, exact-Account Room settings hub. */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RoomSettingsDraftService, RoomSettingsForYouDraftService],
  imports: [
    MembersSettingsComponent,
    PlaceGeneralSettingsComponent,
    RoomAliasesComponent,
    RoomSettingsAccessComponent,
    RoomSettingsAdvancedComponent,
    RoomSettingsDirectoryComponent,
    RoomSettingsEmojiComponent,
    RoomSettingsEncryptionComponent,
    RoomSettingsForYouComponent,
    RoomWidgetsComponent,
    SettingsHubComponent,
    TrnSettingsGroupComponent,
  ],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  private readonly identities = inject(AccountIdentitiesService);
  private readonly membersSection = viewChild(MembersSettingsComponent);
  private readonly widgetsSection = viewChild(RoomWidgetsComponent);
  private readonly dialogRef =
    inject<TrnDialogRef<RoomSettingsResult>>(TrnDialogRef);

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly roomDisplayName = input('Room');
  readonly parentSpaces = input<readonly ParentSpace[]>([]);
  readonly direct = input(false);
  readonly initialSection = input<RoomSettingsSection>();

  readonly draft = inject(RoomSettingsDraftService);
  readonly forYouDraft = inject(RoomSettingsForYouDraftService);
  readonly hub = new SettingsHubController({
    sections: SECTIONS,
    noun: 'Room',
    testIdPrefix: 'room-settings',
    accountId: () => this.accountId(),
    targetId: () => this.roomId(),
    dirty: () =>
      this.draft.dirty() ||
      this.forYouDraft.dirty() ||
      (this.widgetsSection()?.hasCreationDraft() ?? false),
    discard: () => {
      this.draft.discardGeneral();
      this.draft.discardAccess();
      this.forYouDraft.discard();
      this.widgetsSection()?.discardCreationDraft();
    },
  });
  /** Emoji only for members who may change the room's pack. */
  readonly sections = computed(() =>
    this.draft.permissions().imagePack.available
      ? SECTIONS
      : SECTIONS.filter(({ value }) => value !== 'emoji'),
  );
  readonly selectedSection = this.hub.selectedSection;
  readonly directoryVisible = this.hub.directoryVisible;
  readonly compactNavigation = this.hub.compactNavigation;
  readonly account = computed(() =>
    this.identities.identityOf(this.accountId()),
  );

  readonly accountLabel = computed(() => {
    const { displayName, userId } = this.account();
    return displayName === userId ? userId : `${displayName} (${userId})`;
  });
  readonly widgetTarget = computed<RoomWidgetTarget>(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
  }));
  readonly sectionTitle = computed(
    () =>
      SECTIONS.find(({ value }) => value === this.selectedSection())?.label ??
      'General',
  );
  constructor() {
    effect(() => {
      if (
        this.selectedSection() === 'emoji' &&
        !this.draft.permissions().imagePack.available
      ) {
        this.selectedSection.set('general');
      }
    });
  }

  ngOnInit(): void {
    this.draft.start(
      { accountId: this.accountId(), roomId: this.roomId() },
      this.parentSpaces(),
    );
    this.forYouDraft.start({
      accountId: this.accountId(),
      roomId: this.roomId(),
    });
    const initialSection = this.initialSection();
    if (initialSection) this.hub.selectSection(initialSection);
    this.hub.activate();
  }

  selectSection(value: string): void {
    this.hub.selectSection(value);
  }

  showDirectory(): void {
    this.hub.showDirectory();
  }

  requestExternalDismiss(): boolean {
    if (this.membersSection()?.dismissNestedSurface()) return false;
    return this.hub.requestExternalDismiss();
  }

  close(): void {
    this.hub.close();
  }

  /**
   * Advanced › Open room: close and hand the room to the opener, which joins and opens it
   * for this exact Account. Advanced holds no draft — entering it already passed the
   * unsaved-changes guard — so closing with a result loses nothing.
   */
  openRoom(roomId: string): void {
    this.dialogRef.close({ accountId: this.accountId(), roomId });
  }
}
