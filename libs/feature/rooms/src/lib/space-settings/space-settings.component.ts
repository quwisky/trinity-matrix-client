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
import {
  WorkspaceBackService,
  type WorkspaceSurface,
} from '@trinity/application/workspace';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnDialogService,
} from '@trinity/components/overlay';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { isMobileOs } from '@trinity/platform-native';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { initialOf } from '@trinity/util/matrix';
import { Observable, defer, of, take } from 'rxjs';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import {
  SettingsHubComponent,
  type SettingsHubSection,
} from '../shared/settings-hub/settings-hub.component';
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

  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly dialog = inject(TrnDialogService);
  private readonly alert = inject(TrnAlertService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly compact = mediaQuerySignal(
    BELOW_MD_QUERY,
    inject(DestroyRef),
  );
  private readonly confirmingDiscard = signal(false);
  private readonly backActive = signal(false);

  readonly draft = inject(SpaceSettingsDraftService);
  readonly mobileHost = isMobileOs();
  readonly sections = SECTIONS;
  readonly selectedSection = signal<SpaceSettingsSection>('general');
  readonly directoryVisible = signal(false);
  readonly compactNavigation = this.compact;
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

  constructor() {
    const unregister = inject(WorkspaceBackService).register({
      surface: () =>
        this.backActive()
          ? {
              layer: 'room',
              surface: {
                kind: 'settings',
                accountId: this.accountId(),
                roomId: this.spaceId(),
              },
            }
          : null,
      dismiss: (surface) => this.dismissFromWorkspace(surface),
      ownsTopmostOverlay: () => this.dialog.isTopmost(this.dialogRef),
    });
    inject(DestroyRef).onDestroy(unregister);
  }

  ngOnInit(): void {
    this.draft.start({
      accountId: this.accountId(),
      roomId: this.spaceId(),
    });
    this.backActive.set(true);
  }

  selectSection(value: string): void {
    const section = SECTIONS.find(
      (candidate) => candidate.value === value,
    )?.value;
    if (!section) return;
    if (section === this.selectedSection() && !this.directoryVisible()) return;
    this.guardUnsavedNavigation(() => {
      this.selectedSection.set(section);
      this.directoryVisible.set(false);
      this.focusAfterRender('[data-testid="space-settings-section-heading"]');
    });
  }

  showDirectory(): void {
    this.guardUnsavedNavigation(() => {
      this.directoryVisible.set(true);
      this.focusAfterRender(
        `[data-testid="space-settings-tab-${this.selectedSection()}"]`,
      );
    });
  }

  /** Called synchronously by the dialog stack for Escape, backdrop and host Back. */
  requestExternalDismiss(): boolean {
    if (this.compact() && !this.directoryVisible()) {
      this.showDirectory();
      return false;
    }
    if (!this.draft.dirty()) return true;
    this.confirmDiscard(() => this.dialogRef.close(false));
    return false;
  }

  close(): void {
    if (this.draft.dirty()) {
      this.confirmDiscard(() => this.dialogRef.close(false));
      return;
    }
    this.dialogRef.close(false);
  }

  private dismissFromWorkspace(
    surface: WorkspaceSurface,
  ): Observable<'dismissed' | 'blocked'> {
    return defer(() => {
      if (
        surface.layer !== 'room' ||
        surface.surface.kind !== 'settings' ||
        surface.surface.accountId !== this.accountId() ||
        surface.surface.roomId !== this.spaceId()
      ) {
        return of('blocked' as const);
      }
      if (!this.requestExternalDismiss()) return of('blocked' as const);
      this.dialogRef.close(false);
      return of('dismissed' as const);
    });
  }

  private guardUnsavedNavigation(navigate: () => void): void {
    if (!this.draft.dirty()) {
      navigate();
      return;
    }
    this.confirmDiscard(() => {
      this.draft.discardGeneral();
      this.draft.discardAccess();
      navigate();
    });
  }

  private confirmDiscard(onDiscard: () => void): void {
    if (this.confirmingDiscard()) return;
    this.confirmingDiscard.set(true);
    this.alert
      .confirm$({
        header: 'Discard Space settings changes?',
        message:
          'Your unsaved Space details will be discarded. Changes already saved, including a photo update, stay applied.',
        confirmText: 'Discard changes',
        cancelText: 'Keep editing',
        variant: 'danger',
        closeOnNavigation: false,
      })
      .pipe(take(1))
      .subscribe((discard) => {
        this.confirmingDiscard.set(false);
        if (discard) onDiscard();
      });
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
