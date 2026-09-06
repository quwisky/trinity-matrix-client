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
  'general' | 'for-you' | 'access' | 'widgets' | 'bans';

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
    description: 'Joining, history, and addresses',
  },
  {
    value: 'widgets',
    label: 'Widgets',
    description: 'Connected room tools',
  },
  {
    value: 'bans',
    label: 'Bans',
    description: 'People barred from this Room',
  },
];

/** Responsive, exact-Account Room settings hub. */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RoomSettingsDraftService, RoomSettingsForYouDraftService],
  imports: [
    BannedMembersComponent,
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
  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly roomDisplayName = input('Room');
  readonly parentSpaces = input<readonly ParentSpace[]>([]);

  private readonly identities = inject(AccountIdentitiesService);

  readonly draft = inject(RoomSettingsDraftService);
  readonly forYouDraft = inject(RoomSettingsForYouDraftService);
  readonly hub = new SettingsHubController({
    sections: SECTIONS,
    noun: 'Room',
    testIdPrefix: 'room-settings',
    accountId: () => this.accountId(),
    targetId: () => this.roomId(),
    dirty: () => this.draft.dirty() || this.forYouDraft.dirty(),
    discard: () => {
      this.draft.discardGeneral();
      this.draft.discardAccess();
      this.forYouDraft.discard();
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
  readonly roomInitial = computed(() =>
    initialOf(this.draft.model().name || this.roomDisplayName()),
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
      : 'Switch back to the opening Account to manage this section. General remains attached to the opening Account.';
  });

  ngOnInit(): void {
    this.draft.start(
      { accountId: this.accountId(), roomId: this.roomId() },
      this.parentSpaces(),
    );
    this.forYouDraft.start({
      accountId: this.accountId(),
      roomId: this.roomId(),
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
