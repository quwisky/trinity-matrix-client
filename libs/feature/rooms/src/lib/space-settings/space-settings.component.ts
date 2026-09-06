import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
} from '@angular/core';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { initialOf } from '@trinity/util/matrix';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import {
  SettingsHubComponent,
  type SettingsHubSection,
} from '../shared/settings-hub/settings-hub.component';
import { SettingsHubController } from '../shared/settings-hub/settings-hub.controller';
import { SpaceSettingsAccessComponent } from './space-settings-access.component';
import { SpaceSettingsDraftService } from './space-settings-draft.service';
import { SpaceSettingsGeneralComponent } from './space-settings-general.component';

type SpaceSettingsSection = 'general' | 'access' | 'addresses' | 'bans';

/**
 * Only working destinations are listed during migration. For you, Members and Rooms & spaces
 * join the final inventory in #519, #522 and #524; Bans remains reachable until Members owns it.
 */
const SECTIONS: readonly (SettingsHubSection & {
  readonly value: SpaceSettingsSection;
})[] = [
  {
    value: 'general',
    label: 'General',
    description: 'Photo, name, and topic',
  },
  {
    value: 'access',
    label: 'Access',
    description: 'Who can join this Space',
  },
  {
    value: 'addresses',
    label: 'Addresses',
    description: 'Published Space links',
  },
  {
    value: 'bans',
    label: 'Bans',
    description: 'People barred from this Space',
  },
];

/** Responsive settings hub pinned to one opening Account and Space. */
@Component({
  selector: 'trn-space-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SpaceSettingsDraftService],
  imports: [
    BannedMembersComponent,
    RoomAliasesComponent,
    SettingsHubComponent,
    SpaceSettingsAccessComponent,
    SpaceSettingsGeneralComponent,
  ],
  templateUrl: './space-settings.component.html',
  styleUrl: './space-settings.component.scss',
})
export class SpaceSettingsComponent implements OnInit {
  readonly accountId = input.required<string>();
  readonly spaceId = input.required<string>();
  readonly spaceDisplayName = input('Space');

  private readonly identities = inject(AccountIdentitiesService);

  readonly draft = inject(SpaceSettingsDraftService);
  readonly hub = new SettingsHubController({
    sections: SECTIONS,
    noun: 'Space',
    testIdPrefix: 'space-settings',
    accountId: () => this.accountId(),
    targetId: () => this.spaceId(),
    dirty: () => this.draft.dirty(),
    discard: () => {
      this.draft.discardGeneral();
      this.draft.discardAccess();
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
  readonly accountInitial = computed(() =>
    initialOf(this.account().displayName),
  );
  readonly spaceInitial = computed(() =>
    initialOf(this.draft.model().name || this.spaceDisplayName()),
  );
  readonly sectionTitle = computed(
    () =>
      SECTIONS.find(({ value }) => value === this.selectedSection())?.label ??
      'General',
  );
  readonly legacyUnavailableReason = computed(() => {
    if (this.draft.targetUnavailableReason()) {
      return this.draft.targetUnavailableReason();
    }
    return this.draft.openingAccountActive()
      ? null
      : 'Switch back to the opening Account to manage this section. General and Access remain attached to the opening Account.';
  });

  ngOnInit(): void {
    this.draft.start({
      accountId: this.accountId(),
      roomId: this.spaceId(),
    });
    this.hub.activate();
  }

  selectSection(value: string): void {
    this.hub.selectSection(value);
  }

  showDirectory(): void {
    this.hub.showDirectory();
  }

  requestExternalDismiss(): boolean {
    return this.hub.requestExternalDismiss();
  }

  close(): void {
    this.hub.close();
  }
}
