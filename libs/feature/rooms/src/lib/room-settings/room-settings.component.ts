import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import type { RoomWidgetTarget } from '@trinity/data-access/widgets';
import { MembersSettingsComponent } from '../members-settings/members-settings.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import {
  SettingsHubComponent,
  type SettingsHubSection,
} from '../shared/settings-hub/settings-hub.component';
import { SettingsHubController } from '../shared/settings-hub/settings-hub.controller';
import { RoomSettingsAccessComponent } from './room-settings-access.component';
import { RoomSettingsDraftService } from './room-settings-draft.service';
import { RoomSettingsForYouComponent } from './room-settings-for-you/room-settings-for-you.component';
import { RoomSettingsForYouDraftService } from './room-settings-for-you/room-settings-for-you-draft.service';
import { RoomSettingsGeneralComponent } from './room-settings-general.component';
import type { ParentSpace } from './room-settings.models';
import { RoomWidgetsComponent } from './room-widgets.component';

export type { ParentSpace } from './room-settings.models';

type RoomSettingsSection =
  'general' | 'for-you' | 'access' | 'members' | 'addresses' | 'widgets';

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
    description: 'Published Room links',
  },
  {
    value: 'widgets',
    icon: 'square-code',
    group: 'Manage',
    label: 'Widgets',
    description: 'Connected room tools',
  },
];

/** Responsive, exact-Account Room settings hub. */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RoomSettingsDraftService, RoomSettingsForYouDraftService],
  imports: [
    MembersSettingsComponent,
    RoomAliasesComponent,
    RoomSettingsAccessComponent,
    RoomSettingsGeneralComponent,
    RoomSettingsForYouComponent,
    RoomWidgetsComponent,
    SettingsHubComponent,
  ],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  private readonly identities = inject(AccountIdentitiesService);
  private readonly membersSection = viewChild(MembersSettingsComponent);
  private readonly widgetsSection = viewChild(RoomWidgetsComponent);

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
  readonly sections = SECTIONS;
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
}
