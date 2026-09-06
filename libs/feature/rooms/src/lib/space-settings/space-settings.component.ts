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
import type { SpaceContentsTarget } from '@trinity/data-access/room-library';
import { MembersSettingsComponent } from '../members-settings/members-settings.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import {
  SettingsHubComponent,
  type SettingsHubSection,
} from '../shared/settings-hub/settings-hub.component';
import { SettingsHubController } from '../shared/settings-hub/settings-hub.controller';
import { SpaceSettingsAccessComponent } from './space-settings-access.component';
import { SpaceSettingsContentsComponent } from './space-settings-contents.component';
import { SpaceSettingsDraftService } from './space-settings-draft.service';
import { SpaceSettingsForYouDraftService } from './space-settings-for-you/space-settings-for-you-draft.service';
import { SpaceSettingsForYouComponent } from './space-settings-for-you/space-settings-for-you.component';
import { SpaceSettingsGeneralComponent } from './space-settings-general.component';

type SpaceSettingsSection =
  'general' | 'for-you' | 'access' | 'contents' | 'members' | 'addresses';

/** Account-bound Space settings destinations, including authoritative child curation. */
const SECTIONS: readonly (SettingsHubSection & {
  readonly value: SpaceSettingsSection;
})[] = [
  {
    value: 'general',
    icon: 'settings',
    group: 'Overview',
    label: 'General',
    description: 'Photo, name, and topic',
  },
  {
    value: 'for-you',
    icon: 'user',
    group: 'Personal',
    label: 'For you',
    description: 'Your room order on this device',
  },
  {
    value: 'access',
    icon: 'lock',
    group: 'Manage',
    label: 'Access',
    description: 'Who can join this Space',
  },
  {
    value: 'contents',
    icon: 'layers',
    group: 'Manage',
    label: 'Rooms & spaces',
    description: 'Linked Rooms and nested Spaces',
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
    description: 'Published Space links',
  },
];

/** Responsive settings hub pinned to one opening Account and Space. */
@Component({
  selector: 'trn-space-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SpaceSettingsDraftService, SpaceSettingsForYouDraftService],
  imports: [
    MembersSettingsComponent,
    RoomAliasesComponent,
    SettingsHubComponent,
    SpaceSettingsAccessComponent,
    SpaceSettingsContentsComponent,
    SpaceSettingsForYouComponent,
    SpaceSettingsGeneralComponent,
  ],
  templateUrl: './space-settings.component.html',
  styleUrl: './space-settings.component.scss',
})
export class SpaceSettingsComponent implements OnInit {
  private readonly identities = inject(AccountIdentitiesService);
  private readonly membersSection = viewChild(MembersSettingsComponent);

  readonly accountId = input.required<string>();
  readonly spaceId = input.required<string>();
  readonly spaceDisplayName = input('Space');
  readonly initialSection = input<SpaceSettingsSection>();
  readonly draft = inject(SpaceSettingsDraftService);
  readonly forYou = inject(SpaceSettingsForYouDraftService);
  readonly hub = new SettingsHubController({
    sections: SECTIONS,
    noun: 'Space',
    testIdPrefix: 'space-settings',
    accountId: () => this.accountId(),
    targetId: () => this.spaceId(),
    dirty: () => this.draft.dirty() || this.forYou.dirty(),
    discard: () => {
      this.draft.discardGeneral();
      this.draft.discardAccess();
      this.forYou.discard();
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
  readonly contentsTarget = computed<SpaceContentsTarget>(() => ({
    accountId: this.accountId(),
    spaceId: this.spaceId(),
  }));
  readonly sectionTitle = computed(
    () =>
      SECTIONS.find(({ value }) => value === this.selectedSection())?.label ??
      'General',
  );
  ngOnInit(): void {
    this.draft.start({
      accountId: this.accountId(),
      roomId: this.spaceId(),
    });
    this.forYou.start({
      accountId: this.accountId(),
      spaceId: this.spaceId(),
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
