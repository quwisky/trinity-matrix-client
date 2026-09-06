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
import { initialOf } from '@trinity/util/matrix';
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
    label: 'General',
    description: 'Photo, name, topic, and encryption',
  },
  {
    value: 'for-you',
    label: 'For you',
    description: 'Notifications and organisation',
  },
  {
    value: 'access',
    label: 'Access',
    description: 'Who can join and read history',
  },
  {
    value: 'members',
    label: 'Members',
    description: 'People, roles, invitations, and bans',
  },
  {
    value: 'addresses',
    label: 'Addresses',
    description: 'Published Room links',
  },
  {
    value: 'widgets',
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
  readonly initialSection = input<RoomSettingsSection>('general');

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
  readonly mobileHost = this.hub.mobileHost;
  readonly sections = SECTIONS;
  readonly selectedSection = this.hub.selectedSection;
  readonly directoryVisible = this.hub.directoryVisible;
  readonly compactNavigation = this.hub.compactNavigation;
  readonly account = computed(() =>
    this.identities.identityOf(this.accountId()),
  );
  readonly widgetTarget = computed<RoomWidgetTarget>(() => ({
    accountId: this.accountId(),
    roomId: this.roomId(),
  }));
  readonly accountInitial = computed(() =>
    initialOf(this.account().displayName),
  );
  readonly roomInitial = computed(() =>
    initialOf(this.draft.model().name || this.roomDisplayName()),
  );
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
    this.hub.selectSection(this.initialSection());
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
