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
import { initialOf } from '@trinity/util/matrix';
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

/** Working Account-bound Space destinations; child organisation joins this hub in #524. */
const SECTIONS: readonly (SettingsHubSection & {
  readonly value: SpaceSettingsSection;
})[] = [
  {
    value: 'general',
    label: 'General',
    description: 'Photo, name, and topic',
  },
  {
    value: 'for-you',
    label: 'For you',
    description: 'Your room order on this device',
  },
  {
    value: 'access',
    label: 'Access',
    description: 'Who can join this Space',
  },
  {
    value: 'contents',
    label: 'Rooms & spaces',
    description: 'Linked Rooms and nested Spaces',
  },
  {
    value: 'members',
    label: 'Members',
    description: 'People, roles, invitations, and bans',
  },
  {
    value: 'addresses',
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
  readonly initialSection = input<SpaceSettingsSection>('general');
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
