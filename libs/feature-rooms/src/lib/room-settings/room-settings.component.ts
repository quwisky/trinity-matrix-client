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
import { FormField, FormRoot, disabled, form } from '@angular/forms/signals';
import { HlmButton } from '@trinity/helm/button';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmInput } from '@trinity/helm/input';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import {
  HistoryVisibility,
  JoinRule,
  RoomSettingsService,
} from '@trinity/data-access/rooms';
import { initialOf } from '@trinity/util-matrix';
import { BannedMembersComponent } from '../banned-members/banned-members.component';
import { RoomAliasesComponent } from '../room-aliases/room-aliases.component';
import { AvatarFieldComponent } from '../shared/avatar-field/avatar-field.component';
import { saveFields, type FieldWrite } from '../shared/save-fields';
import {
  applyRoomBasicsGates,
  type RoomBasics,
} from '../shared/room-basics-form';

/** The room dialog's model: the shared three, plus the one only a room has. */
interface RoomSettingsModel extends RoomBasics {
  historyVisibility: HistoryVisibility;
}

/** A space this room sits in, offered as a `restricted` join-rule target. */
export interface ParentSpace {
  id: string;
  name: string;
}

/** The join-rule choices always offered (a practical subset of the spec's options). */
const JOIN_RULE_OPTIONS = [
  { value: JoinRule.Invite, label: 'Invite only' },
  { value: JoinRule.Public, label: 'Anyone can join' },
] as const;

/** The history-visibility choices offered, from most to least open. */
const HISTORY_OPTIONS = [
  { value: HistoryVisibility.Shared, label: 'Members — all history' },
  {
    value: HistoryVisibility.Invited,
    label: 'Members — since they were invited',
  },
  { value: HistoryVisibility.Joined, label: 'Members — since they joined' },
  {
    value: HistoryVisibility.WorldReadable,
    label: 'Anyone, even without joining',
  },
] as const;

/**
 * Dialog to edit a room's identity (name/topic/avatar) and access controls (join rule +
 * history visibility). The opener seeds the current values and which fields the viewer's
 * power level lets them change; fields they can't edit render read-only. Save writes only
 * the fields that changed and closes resolving `true` (so the host can refresh/toast);
 * errors keep the dialog open with a toast. Viewers who can ban also see the room's banned
 * members (with an Unban action) via {@link BannedMembersComponent}. Presented via
 * {@link TrnDialogService}.
 */
@Component({
  selector: 'trn-room-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    FormRoot,
    HlmButton,
    HlmCheckbox,
    HlmInput,
    AvatarFieldComponent,
    BannedMembersComponent,
    RoomAliasesComponent,
  ],
  templateUrl: './room-settings.component.html',
  styleUrl: './room-settings.component.scss',
})
export class RoomSettingsComponent implements OnInit {
  readonly roomId = input.required<string>();
  readonly name = input('');
  readonly topic = input('');
  readonly avatarMxc = input<string | null>(null);
  readonly joinRule = input<JoinRule>(JoinRule.Invite);
  readonly historyVisibility = input<HistoryVisibility>(
    HistoryVisibility.Shared,
  );
  readonly canEditName = input(false);
  readonly canEditTopic = input(false);
  readonly canEditAvatar = input(false);
  readonly canEditJoinRule = input(false);
  readonly canEditHistory = input(false);
  /**
   * The spaces already in this room's `allow` list. Carried through a save untouched, so
   * re-saving never silently revokes an entry naming a space the viewer has left or that
   * another client added.
   */
  readonly allowedSpaceIds = input<readonly string[]>([]);
  /** The spaces that directly contain this room — the `restricted` option's targets. */
  readonly parentSpaces = input<readonly ParentSpace[]>([]);
  /** Whether this room's version can enforce a `restricted` rule at all (v8+). */
  readonly supportsRestricted = input(false);
  /** Whether the viewer may manage (view + lift) this room's bans. */
  readonly canManageBans = input(false);
  /** Whether the viewer may manage this room's published addresses. */
  readonly canManageAliases = input(false);

  private readonly dialogRef =
    inject<DialogRef<boolean, RoomSettingsComponent>>(DialogRef);
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** True while the save writes are in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** First letter of the room name, for the avatar fallback. */
  readonly avatarInitial = computed(() => initialOf(this.name()));

  /** Whether the Save button applies to anything the viewer can change. */
  readonly canSave = computed(
    () =>
      this.canEditName() ||
      this.canEditTopic() ||
      this.canEditJoinRule() ||
      this.canEditHistory(),
  );

  /**
   * `restricted` is offered ONLY when it can actually work: the room must sit in at least
   * one space, and its version must enforce the rule. Restricting a room with nothing
   * allowed is a room nobody can join, and an older room takes the rule and enforces
   * nothing — so in both cases the option would promise access it cannot deliver.
   */
  readonly joinRuleOptions = computed(() => {
    const spaces = this.parentSpaces();
    const options: { value: JoinRule; label: string }[] = [
      ...JOIN_RULE_OPTIONS,
    ];
    if (spaces.length > 0 && this.supportsRestricted()) {
      options.push({
        value: JoinRule.Restricted,
        // Deliberately does NOT name the spaces. The label is fixed text while the allow
        // list is editable state, so naming them here would state access the server may
        // not grant. The checkboxes below say which spaces, and they cannot drift.
        label: 'Space members can join',
      });
    }
    return withCurrentRule(options, this.joinRule());
  });

  readonly historyOptions = HISTORY_OPTIONS;

  /**
   * Which parent spaces are ticked. Seeded in `ngOnInit`: the spaces already in `allow`
   * when the room is restricted, otherwise all of them, so picking "Space members can
   * join" is immediately valid rather than an empty list the service would refuse.
   */
  private readonly checkedSpaces = signal<ReadonlySet<string>>(new Set());

  /** Show the per-space choices only where they mean something. */
  readonly showSpaceChoices = computed(
    () =>
      this.selectedRule() === JoinRule.Restricted &&
      this.parentSpaces().length > 0,
  );

  /**
   * Restricted with nothing ticked is a room nobody can join. The service refuses to write
   * it; Save is disabled before the user can get there.
   */
  readonly noSpaceChosen = computed(
    () => this.showSpaceChoices() && this.allowToWrite().length === 0,
  );

  isSpaceChecked(spaceId: string): boolean {
    return this.checkedSpaces().has(spaceId);
  }

  toggleSpace(spaceId: string, checked: boolean): void {
    this.checkedSpaces.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(spaceId);
      } else {
        next.delete(spaceId);
      }
      return next;
    });
  }

  /**
   * The allow list a restricted save would write: the ticked parent spaces, plus every
   * seeded entry that is NOT a parent space we can see.
   *
   * Those extras are carried through untouched and are not offered as checkboxes, because
   * `parentSpaceIds` only sees spaces this user has JOINED — an entry we cannot name may
   * still be a space the room legitimately belongs to, and dropping it would revoke its
   * members' access as a side effect of an unrelated edit.
   */
  private allowToWrite(): string[] {
    const parents = this.parentSpaces();
    const parentIds = new Set(parents.map((space) => space.id));
    const preserved = this.allowedSpaceIds().filter((id) => !parentIds.has(id));
    const ticked = parents
      .filter((space) => this.checkedSpaces().has(space.id))
      .map((space) => space.id);
    return [...preserved, ...ticked];
  }

  private readonly model = signal<RoomSettingsModel>({
    name: '',
    topic: '',
    joinRule: JoinRule.Invite,
    historyVisibility: HistoryVisibility.Shared,
  });

  readonly form = form(this.model, (path) => {
    applyRoomBasicsGates(path, {
      canEditName: this.canEditName,
      canEditTopic: this.canEditTopic,
      canEditJoinRule: this.canEditJoinRule,
    });
    disabled(path.historyVisibility, { when: () => !this.canEditHistory() });
  });

  // Was a toSignal over joinRule.valueChanges. The model IS a signal, so the projection
  // that existed only to make the control readable from a computed is gone.
  private readonly selectedRule = computed(() => this.model().joinRule);

  ngOnInit(): void {
    // Seeded once, deliberately: a linkedSignal over the inputs would re-seed on any synced
    // state change and wipe what the user is typing.
    this.model.set({
      name: this.name(),
      topic: this.topic(),
      joinRule: this.joinRule(),
      historyVisibility: this.historyVisibility(),
    });
    const parentIds = this.parentSpaces().map((space) => space.id);
    this.checkedSpaces.set(
      this.joinRule() === JoinRule.Restricted
        ? new Set(this.allowedSpaceIds().filter((id) => parentIds.includes(id)))
        : new Set(parentIds),
    );
  }

  /**
   * Persist each changed, editable field independently and report the real outcome:
   * close on full success; on failure keep the dialog open with a toast that names what
   * did and didn't save (each write is its own state event, so a partial failure is
   * possible and must not claim "nothing saved"). Re-Saving is idempotent.
   */
  save(): void {
    const roomId = this.roomId();
    const {
      name: rawName,
      topic: rawTopic,
      joinRule,
      historyVisibility,
    } = this.model();
    const name = rawName.trim();
    const topic = rawTopic.trim();
    const writes: FieldWrite[] = [];
    // A room name shouldn't be blanked from here — only write a non-empty change.
    if (this.canEditName() && name && name !== this.name().trim()) {
      writes.push({ field: 'name', op: this.settings.setName(roomId, name) });
    }
    if (this.canEditTopic() && topic !== this.topic().trim()) {
      writes.push({
        field: 'topic',
        op: this.settings.setTopic(roomId, topic),
      });
    }
    const allow = joinRule === JoinRule.Restricted ? this.allowToWrite() : [];
    // Restricted → restricted with a changed allow list is a real change, so this cannot
    // be `joinRule !== seeded` alone or ticking a space would silently do nothing. It also
    // cannot widen on its own: with nothing touched, the ticks reproduce the seeded list
    // exactly, so an unrelated topic edit writes no join rule at all.
    const accessChanged =
      joinRule !== this.joinRule() ||
      !sameMembers(allow, this.allowedSpaceIds());
    if (this.canEditJoinRule() && accessChanged) {
      writes.push({
        field: 'join rule',
        op: this.settings.setJoinRule(roomId, joinRule, allow),
      });
    }
    if (
      this.canEditHistory() &&
      historyVisibility !== this.historyVisibility()
    ) {
      writes.push({
        field: 'history visibility',
        op: this.settings.setHistoryVisibility(roomId, historyVisibility),
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
            : 'Could not save room settings.',
          { duration: 4000, variant: 'destructive' },
        );
      });
  }

  close(): void {
    this.dialogRef.close(false);
  }
}

/**
 * Whether two id lists hold the same set. Compared as sets, not by length: the written
 * list is rebuilt from the ticks and the seeded one comes from arbitrary room state, so
 * neither is a superset of the other and equal sizes prove nothing.
 */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b);
  return a.length === set.size && a.every((id) => set.has(id));
}

/** How a join rule this dialog does not otherwise offer is described if a room has one. */
// Deliberately not exhaustive: JoinRule.Private is deprecated in the SDK, and an
// unrecognised rule from a future spec has no label we could invent. Both fall through to
// the raw value, which at least shows the room's real setting instead of nothing.
const OTHER_RULE_LABELS: Partial<Record<JoinRule, string>> = {
  [JoinRule.Restricted]: 'Space members',
  [JoinRule.Knock]: 'Anyone can ask to join',
};

/**
 * Guarantee the room's CURRENT rule is among the choices, even when this dialog would not
 * otherwise offer it.
 *
 * Without this, a `<select>` seeded with an absent value renders blank — the control shows
 * no setting at all, which misrepresents the room, and any pick silently changes access.
 * It happens for real: `restricted` is dropped when the room has no parent space, and
 * `parentSpaceIds` only sees spaces this user has JOINED, so an admin who is not in the
 * allowed space sees a restricted room as blank. `knock` and `private` can arrive from any
 * other client. Shown, and never silently rewritten — but the user can still move off it.
 */
function withCurrentRule(
  options: { value: JoinRule; label: string }[],
  current: JoinRule,
): { value: JoinRule; label: string }[] {
  if (options.some((option) => option.value === current)) {
    return options;
  }
  return [
    ...options,
    { value: current, label: OTHER_RULE_LABELS[current] ?? current },
  ];
}
