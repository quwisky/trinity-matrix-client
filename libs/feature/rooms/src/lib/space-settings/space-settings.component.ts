import { RoomSettingsService } from '@trinity/data-access/room-administration';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import { TrnActionAvailability, TrnButton } from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnSelectComponent } from '@trinity/components/select';
import {
  TrnTabPanelComponent,
  TrnTabsComponent,
  type TrnTabOption,
} from '@trinity/components/tabs';
import { TrnInput } from '@trinity/components/input';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import { JoinRule } from '@trinity/data-access/room-administration';
import { RoomActionPermissionsService } from '@trinity/data-access/room-administration';
import { initialOf } from '@trinity/util/matrix';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import { AvatarFieldComponent } from '../shared/avatar-field/avatar-field.component';
import { saveFields, type FieldWrite } from '../shared/save-fields';
import {
  applyRoomBasicsGates,
  type RoomBasics,
} from '../shared/room-basics-form';

/**
 * The join-rule choices offered for a SPACE. Deliberately not the room dialog's list: "Anyone
 * can join" is about a conversation, whereas a public space is one people can find and browse.
 * `restricted` is absent on purpose — a space gated on membership of another space is a shape
 * this client can neither create nor navigate.
 */
const JOIN_RULE_OPTIONS = [
  { value: JoinRule.Invite, label: 'Invite only' },
  { value: JoinRule.Public, label: 'Anyone can find and join' },
] as const;

/** How a rule this dialog does not offer is described when a space already has one. */
// Deliberately not exhaustive: JoinRule.Private is deprecated in the SDK, and an
// unrecognised rule from a future spec has no label we could invent. Both fall through to
// the raw value, which at least shows the room's real setting instead of nothing.
const OTHER_RULE_LABELS: Partial<Record<JoinRule, string>> = {
  [JoinRule.Restricted]: 'Members of another space',
  [JoinRule.Knock]: 'Anyone can ask to join',
};

/**
 * Dialog to edit a space's name, topic, avatar and join rule.
 *
 * A sibling of {@link RoomSettingsComponent} rather than the same component behind a flag: the
 * wording differs throughout, the join-rule options mean different things, and history
 * visibility is meaningless here because no space timeline is ever rendered (`room-library.service.ts`
 * filters spaces out of the room projection). The two share what actually is shared — the
 * services, {@link AvatarFieldComponent} and {@link saveFields} — and keep their own testids so
 * each is independently drivable.
 *
 * The opener seeds current values and per-field permissions; fields the viewer's power level
 * doesn't allow render disabled. Save writes only what changed.
 */
@Component({
  selector: 'trn-space-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnSelectComponent,
    TrnTabsComponent,
    TrnTabPanelComponent,
    FormField,
    FormRoot,
    TrnButton,
    TrnActionAvailability,
    TrnTooltip,
    TrnInput,
    AvatarFieldComponent,
    BannedMembersComponent,
    RoomAliasesComponent,
  ],
  templateUrl: './space-settings.component.html',
  styleUrl: './space-settings.component.scss',
})
export class SpaceSettingsComponent implements OnInit {
  /** A space is a room, so every service call here takes its room id. */
  readonly spaceId = input.required<string>();
  readonly name = input('');
  readonly topic = input('');
  readonly avatarMxc = input<string | null>(null);
  readonly joinRule = input<JoinRule>(JoinRule.Invite);
  readonly canEditName = input(false);
  readonly canEditTopic = input(false);
  readonly canEditAvatar = input(false);
  readonly canEditJoinRule = input(false);
  /** Whether the viewer may manage this space's published addresses. */
  readonly canManageAliases = input(false);

  private readonly dialogRef = inject<TrnDialogRef<boolean>>(TrnDialogRef);
  private readonly settings = inject(RoomSettingsService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** True while the save writes are in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** First letter of the space name, for the avatar fallback. */
  readonly avatarInitial = computed(() => initialOf(this.name()));

  private readonly livePermissions = computed(() =>
    this.permissions.settings(this.spaceId()),
  );
  readonly mayEditName = computed(() => this.livePermissions().name.available);
  readonly mayEditTopic = computed(
    () => this.livePermissions().topic.available,
  );
  readonly mayEditAvatar = computed(
    () => this.livePermissions().avatar.available,
  );
  readonly mayEditJoinRule = computed(
    () => this.livePermissions().joinRule.available,
  );
  readonly saveUnavailableReason = computed(() =>
    this.canSave() ? null : 'Your role cannot change these space settings.',
  );

  /**
   * Whether Save applies to anything the viewer can change. Note this does NOT include
   * `canEditHistory` — the room dialog's does, and copying it here would light up Save for a
   * field this dialog doesn't have.
   */
  readonly canSave = computed(
    () => this.mayEditName() || this.mayEditTopic() || this.mayEditJoinRule(),
  );

  /** Bans remain readable; each Unban action owns its live permission explanation. */
  readonly settingsTabs = computed<TrnTabOption[]>(() => [
    {
      value: 'general',
      label: 'General',
      testId: 'space-settings-tab-general',
    },
    { value: 'access', label: 'Access', testId: 'space-settings-tab-access' },
    { value: 'bans', label: 'Bans', testId: 'space-settings-tab-bans' },
  ]);

  /**
   * The two space rules, plus whatever this space is ACTUALLY set to if that is neither.
   * A `trn-select` seeded with a value it has no option for shows its placeholder — showing no
   * setting at all for a space that has one, and turning any pick into a silent change of
   * who can join. A space created elsewhere can carry `knock` or `restricted`.
   */
  readonly joinRuleOptions = computed<
    { value: JoinRule; label: string; testId: string }[]
  >(() => {
    const options: { value: JoinRule; label: string }[] = [
      ...JOIN_RULE_OPTIONS,
    ];
    const current = this.joinRule();
    // `testId` derived from the value, the convention every other `trn-select` call site
    // follows: the options render in a portal now, so an e2e reaches them by id rather
    // than by `selectOption`, which only ever drove a native `<select>`.
    const withTestIds = (list: { value: JoinRule; label: string }[]) =>
      list.map((option) => ({
        ...option,
        testId: `join-rule-${option.value}`,
      }));
    if (options.some((option) => option.value === current)) {
      return withTestIds(options);
    }
    return withTestIds([
      ...options,
      { value: current, label: OTHER_RULE_LABELS[current] ?? current },
    ]);
  });

  private readonly model = signal<RoomBasics>({
    name: '',
    topic: '',
    joinRule: JoinRule.Invite,
  });

  readonly form = form(this.model, (path) =>
    applyRoomBasicsGates(path, {
      canEditName: this.mayEditName,
      canEditTopic: this.mayEditTopic,
      canEditJoinRule: this.mayEditJoinRule,
    }),
  );

  /**
   * Seeded once, deliberately. A `linkedSignal` over the inputs would re-seed whenever the
   * synced state changes — so a name edit arriving from another device while this dialog is
   * open would wipe what the user is typing.
   */
  ngOnInit(): void {
    this.model.set({
      name: this.name(),
      topic: this.topic(),
      joinRule: this.joinRule(),
    });
  }

  /**
   * Persist each changed, editable field independently and report the real outcome: close on
   * full success; on failure keep the dialog open with a toast naming what did and didn't save.
   */
  save(): void {
    const spaceId = this.spaceId();
    const { name: rawName, topic: rawTopic, joinRule } = this.model();
    const name = rawName.trim();
    const topic = rawTopic.trim();
    const writes: FieldWrite[] = [];
    // A space shouldn't be blanked from here — only write a non-empty change.
    if (this.mayEditName() && name && name !== this.name().trim()) {
      writes.push({ field: 'name', op: this.settings.setName(spaceId, name) });
    }
    if (this.mayEditTopic() && topic !== this.topic().trim()) {
      writes.push({
        field: 'topic',
        op: this.settings.setTopic(spaceId, topic),
      });
    }
    if (this.mayEditJoinRule() && joinRule !== this.joinRule()) {
      writes.push({
        field: 'join rule',
        op: this.settings.setJoinRule(spaceId, joinRule),
      });
    }
    if (writes.length === 0) {
      this.dialogRef.close(false);
      return;
    }
    this.saving.set(true);
    saveFields(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        if (failed.length === 0) {
          this.dialogRef.close(true);
          return;
        }
        this.saving.set(false);
        this.toast.show(
          saved.length
            ? `Saved the ${saved.join(' and ')}, but couldn't update the ${failed.join(' and ')}.`
            : 'Could not save space settings.',
          { duration: 4000, variant: 'destructive' },
        );
      });
  }

  close(): void {
    this.dialogRef.close(false);
  }
}
