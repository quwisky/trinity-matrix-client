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
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { JoinRule, RoomSettingsService } from '@trinity/data-access/rooms';
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
 * visibility is meaningless here because no space timeline is ever rendered (`rooms.service.ts`
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
    FormField,
    FormRoot,
    HlmButton,
    HlmInput,
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
  /** Whether the viewer may manage (view + lift) this space's bans. */
  readonly canManageBans = input(false);
  /** Whether the viewer may manage this space's published addresses. */
  readonly canManageAliases = input(false);

  private readonly dialogRef =
    inject<DialogRef<boolean, SpaceSettingsComponent>>(DialogRef);
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** True while the save writes are in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** First letter of the space name, for the avatar fallback. */
  readonly avatarInitial = computed(() => initialOf(this.name()));

  /**
   * Whether Save applies to anything the viewer can change. Note this does NOT include
   * `canEditHistory` — the room dialog's does, and copying it here would light up Save for a
   * field this dialog doesn't have.
   */
  readonly canSave = computed(
    () => this.canEditName() || this.canEditTopic() || this.canEditJoinRule(),
  );

  /**
   * The two space rules, plus whatever this space is ACTUALLY set to if that is neither.
   * A `<select>` seeded with a value it has no option for renders blank — showing no
   * setting at all for a space that has one, and turning any pick into a silent change of
   * who can join. A space created elsewhere can carry `knock` or `restricted`.
   */
  readonly joinRuleOptions = computed<{ value: JoinRule; label: string }[]>(
    () => {
      const options: { value: JoinRule; label: string }[] = [
        ...JOIN_RULE_OPTIONS,
      ];
      const current = this.joinRule();
      if (options.some((option) => option.value === current)) {
        return options;
      }
      return [
        ...options,
        { value: current, label: OTHER_RULE_LABELS[current] ?? current },
      ];
    },
  );

  private readonly model = signal<RoomBasics>({
    name: '',
    topic: '',
    joinRule: JoinRule.Invite,
  });

  readonly form = form(this.model, (path) =>
    applyRoomBasicsGates(path, {
      canEditName: this.canEditName,
      canEditTopic: this.canEditTopic,
      canEditJoinRule: this.canEditJoinRule,
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
    if (this.canEditName() && name && name !== this.name().trim()) {
      writes.push({ field: 'name', op: this.settings.setName(spaceId, name) });
    }
    if (this.canEditTopic() && topic !== this.topic().trim()) {
      writes.push({
        field: 'topic',
        op: this.settings.setTopic(spaceId, topic),
      });
    }
    if (this.canEditJoinRule() && joinRule !== this.joinRule()) {
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
