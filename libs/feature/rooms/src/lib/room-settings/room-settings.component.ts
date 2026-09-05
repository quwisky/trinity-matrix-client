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
import { FormField, FormRoot } from '@angular/forms/signals';
import {
  TrnActionAvailability,
  TrnButton,
  TrnCheckboxComponent,
  TrnInput,
  TrnSelectComponent,
  TrnTextarea,
} from '@trinity/components/controls';
import {
  AvatarComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { isMobileOs } from '@trinity/platform-native';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { initialOf } from '@trinity/util/matrix';
import { take } from 'rxjs';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import { AvatarFieldComponent } from '../shared/avatar-field/avatar-field.component';
import { RoomSettingsDraftService } from './room-settings-draft.service';
import type { ParentSpace } from './room-settings.models';
import { RoomWidgetsComponent } from './room-widgets.component';

export type { ParentSpace } from './room-settings.models';

type RoomSettingsSection = 'general' | 'access' | 'widgets' | 'bans';

interface RoomSettingsSectionOption {
  readonly value: RoomSettingsSection;
  readonly label: string;
  readonly description: string;
}

const SECTIONS: readonly RoomSettingsSectionOption[] = [
  {
    value: 'general',
    label: 'General',
    description: 'Photo, name, topic, and encryption',
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
  providers: [RoomSettingsDraftService],
  imports: [
    AvatarComponent,
    AvatarFieldComponent,
    BannedMembersComponent,
    FormField,
    FormRoot,
    RoomAliasesComponent,
    RoomWidgetsComponent,
    TrnActionAvailability,
    TrnButton,
    TrnCheckboxComponent,
    TrnInput,
    TrnOverlaySurfaceDirective,
    TrnSelectComponent,
    TrnTextarea,
    TrnTooltip,
  ],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly roomDisplayName = input('Room');
  readonly parentSpaces = input<readonly ParentSpace[]>([]);

  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly alert = inject(TrnAlertService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly compact = mediaQuerySignal(
    BELOW_MD_QUERY,
    inject(DestroyRef),
  );
  private readonly confirmingDiscard = signal(false);

  readonly draft = inject(RoomSettingsDraftService);
  readonly mobileHost = isMobileOs();
  readonly sections = SECTIONS;
  readonly selectedSection = signal<RoomSettingsSection>('general');
  readonly directoryVisible = signal(false);
  readonly compactNavigation = this.compact;
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
  readonly encryptionStatus = computed(() => {
    const encrypted = this.draft.snapshot()?.encrypted;
    if (encrypted === null || encrypted === undefined) {
      return 'Encryption status is unavailable.';
    }
    return encrypted
      ? 'Messages in this Room are end-to-end encrypted.'
      : 'Messages in this Room are not end-to-end encrypted.';
  });
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
  }

  selectSection(section: RoomSettingsSection): void {
    if (section === this.selectedSection() && !this.directoryVisible()) {
      return;
    }
    this.guardUnsavedNavigation(() => {
      this.selectedSection.set(section);
      this.directoryVisible.set(false);
      this.focusAfterRender('[data-testid="room-settings-section-heading"]');
    });
  }

  showDirectory(): void {
    this.guardUnsavedNavigation(() => {
      this.directoryVisible.set(true);
      this.focusAfterRender(
        `[data-testid="room-settings-tab-${this.selectedSection()}"]`,
      );
    });
  }

  /** Called synchronously by the dialog stack for Escape, backdrop, and Host Back. */
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
        header: 'Discard Room settings changes?',
        message:
          'Your unsaved Room details will be discarded. Changes already saved, including a photo update, stay applied.',
        confirmText: 'Discard changes',
        cancelText: 'Keep editing',
        variant: 'danger',
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
