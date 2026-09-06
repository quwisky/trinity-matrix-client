import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { form } from '@angular/forms/signals';
import { TrnToastService } from '@trinity/components/overlay';
import {
  JoinRule,
  RoomSettingsService,
  type RoomSettingsPermissions,
  type RoomSettingsSnapshot,
  type RoomSettingsTarget,
} from '@trinity/data-access/room-administration';
import { applyRoomBasicsGates } from '../shared/room-basics-form';
import { saveFields, type FieldWrite } from '../shared/save-fields';

interface SpaceSettingsModel {
  name: string;
  topic: string;
  joinRule: JoinRule;
}

interface GeneralBaseline {
  readonly name: string;
  readonly topic: string;
}

export interface SpaceSettingsFeedback {
  readonly tone: 'success' | 'danger';
  readonly message: string;
}

const DENIED_SPACE_SETTINGS: RoomSettingsPermissions = {
  name: { available: false, reason: 'Space settings are unavailable.' },
  topic: { available: false, reason: 'Space settings are unavailable.' },
  avatar: { available: false, reason: 'Space settings are unavailable.' },
  joinRule: { available: false, reason: 'Space settings are unavailable.' },
  history: { available: false, reason: 'Space settings are unavailable.' },
  aliases: { available: false, reason: 'Space settings are unavailable.' },
};

const SPACE_JOIN_RULE_OPTIONS: readonly {
  readonly value: JoinRule;
  readonly label: string;
}[] = [
  { value: JoinRule.Invite, label: 'Invite only' },
  { value: JoinRule.Public, label: 'Anyone can find and join' },
];

const OTHER_RULE_LABELS: Partial<Record<JoinRule, string>> = {
  [JoinRule.Restricted]: 'Members of another space',
  [JoinRule.Knock]: 'Anyone can ask to join',
};

/** Owns exact-Account Space drafts without importing Room-only settings policy. */
@Injectable()
export class SpaceSettingsDraftService {
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly target = signal<RoomSettingsTarget | null>(null);
  private readonly baseline = signal<GeneralBaseline>({ name: '', topic: '' });
  private readonly accessBaseline = signal(JoinRule.Invite);
  private readonly snapshotState = signal<RoomSettingsSnapshot | null>(null);
  private readonly modelState = signal<SpaceSettingsModel>({
    name: '',
    topic: '',
    joinRule: JoinRule.Invite,
  });
  private readonly savingState = signal<'general' | 'access' | null>(null);
  private readonly generalFeedbackState = signal<SpaceSettingsFeedback | null>(
    null,
  );
  private readonly accessFeedbackState = signal<SpaceSettingsFeedback | null>(
    null,
  );
  private started = false;

  readonly snapshot = this.snapshotState.asReadonly();
  readonly model = this.modelState.asReadonly();
  readonly saving = this.savingState.asReadonly();
  readonly generalFeedback = this.generalFeedbackState.asReadonly();
  readonly accessFeedback = this.accessFeedbackState.asReadonly();
  readonly permissions = computed(
    () => this.snapshot()?.permissions ?? DENIED_SPACE_SETTINGS,
  );
  readonly targetAvailable = computed(
    () => this.snapshot()?.availability === 'available',
  );
  readonly openingAccountActive = computed(
    () => this.snapshot()?.openingAccountActive ?? false,
  );
  readonly targetUnavailableReason = computed(() => {
    const availability = this.snapshot()?.availability;
    if (availability === 'account-unavailable') {
      return 'This Account is no longer available. Your unfinished edits are still here.';
    }
    if (availability === 'room-unavailable') {
      return 'This Space is no longer joined for the opening Account. Your unfinished edits are still here.';
    }
    return null;
  });
  readonly mayEditName = computed(
    () => this.targetAvailable() && this.permissions().name.available,
  );
  readonly mayEditTopic = computed(
    () => this.targetAvailable() && this.permissions().topic.available,
  );
  readonly mayEditAvatar = computed(
    () => this.targetAvailable() && this.permissions().avatar.available,
  );
  readonly mayEditJoinRule = computed(
    () => this.targetAvailable() && this.permissions().joinRule.available,
  );

  readonly form = form(this.modelState, (path) =>
    applyRoomBasicsGates(path, {
      canEditName: this.mayEditName,
      canEditTopic: this.mayEditTopic,
      canEditJoinRule: this.mayEditJoinRule,
    }),
  );

  readonly generalDirty = computed(() => {
    const model = this.model();
    const baseline = this.baseline();
    return (
      model.name.trim() !== baseline.name ||
      model.topic.trim() !== baseline.topic
    );
  });
  readonly nameHasPermissionBlockedEdit = computed(
    () =>
      !this.mayEditName() && this.model().name.trim() !== this.baseline().name,
  );
  readonly topicHasPermissionBlockedEdit = computed(
    () =>
      !this.mayEditTopic() &&
      this.model().topic.trim() !== this.baseline().topic,
  );
  readonly accessDirty = computed(
    () => this.model().joinRule !== this.accessBaseline(),
  );
  readonly dirty = computed(() => this.generalDirty() || this.accessDirty());
  readonly nameEmpty = computed(
    () =>
      this.mayEditName() &&
      this.baseline().name.length > 0 &&
      this.model().name.trim().length === 0,
  );
  readonly generalHasWritableChanges = computed(() => {
    const model = this.model();
    const baseline = this.baseline();
    return (
      (this.mayEditName() &&
        model.name.trim().length > 0 &&
        model.name.trim() !== baseline.name) ||
      (this.mayEditTopic() && model.topic.trim() !== baseline.topic)
    );
  });
  readonly generalSaveUnavailableReason = computed(() => {
    if (this.targetUnavailableReason()) return this.targetUnavailableReason();
    if (!this.mayEditName() && !this.mayEditTopic()) {
      return 'Your role cannot change this Space’s name or topic.';
    }
    return null;
  });
  readonly accessSaveUnavailableReason = computed(() => {
    if (this.targetUnavailableReason()) return this.targetUnavailableReason();
    return this.mayEditJoinRule()
      ? null
      : 'Your role cannot change this Space’s access setting.';
  });
  readonly joinRuleOptions = computed(() => {
    const current = this.model().joinRule;
    const options = [...SPACE_JOIN_RULE_OPTIONS];
    if (!options.some(({ value }) => value === current)) {
      options.push({
        value: current,
        label: OTHER_RULE_LABELS[current] ?? `Server value (${current})`,
      });
    }
    return options.map((option) => ({
      ...option,
      testId: `join-rule-${option.value}`,
    }));
  });

  start(target: RoomSettingsTarget): void {
    if (this.started) return;
    this.started = true;
    this.target.set(target);
    this.reconcile(this.settings.snapshot(target));
    this.settings
      .observe(target)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => this.reconcile(snapshot));
  }

  discardGeneral(): void {
    this.modelState.update((current) => ({
      ...current,
      ...this.baseline(),
    }));
    this.generalFeedbackState.set(null);
    this.form().reset();
  }

  discardAccess(): void {
    this.modelState.update((current) => ({
      ...current,
      joinRule: this.accessBaseline(),
    }));
    this.accessFeedbackState.set(null);
  }

  saveGeneral(): void {
    const target = this.target();
    if (!target || !this.generalDirty() || this.nameEmpty()) return;
    const candidate: GeneralBaseline = {
      name: this.model().name.trim(),
      topic: this.model().topic.trim(),
    };
    const baseline = this.baseline();
    const writes: FieldWrite[] = [];
    const blocked: string[] = [];
    if (candidate.name !== baseline.name) {
      if (this.mayEditName()) {
        writes.push({
          field: 'name',
          op: this.settings.setName(target, candidate.name),
        });
      } else {
        blocked.push('name');
      }
    }
    if (candidate.topic !== baseline.topic) {
      if (this.mayEditTopic()) {
        writes.push({
          field: 'topic',
          op: this.settings.setTopic(target, candidate.topic),
        });
      } else {
        blocked.push('topic');
      }
    }
    this.runSave('general', writes, blocked, (saved) =>
      this.commitGeneral(saved, candidate),
    );
  }

  saveAccess(): void {
    const target = this.target();
    const joinRule = this.model().joinRule;
    if (!target || joinRule === this.accessBaseline()) return;
    if (!this.mayEditJoinRule()) {
      this.accessFeedbackState.set({
        tone: 'danger',
        message:
          'Join rule could not be saved with your current permissions. Your edit is still here.',
      });
      return;
    }
    this.runSave(
      'access',
      [{ field: 'join rule', op: this.settings.setJoinRule(target, joinRule) }],
      [],
      (saved) => {
        if (saved.has('join rule')) this.accessBaseline.set(joinRule);
      },
    );
  }

  private runSave(
    section: 'general' | 'access',
    writes: readonly FieldWrite[],
    blocked: readonly string[],
    commit: (saved: ReadonlySet<string>) => void,
  ): void {
    if (writes.length === 0) {
      this.setFeedback(section, {
        tone: 'danger',
        message: `${sentenceList(blocked)} could not be saved with your current permissions. Your edits are still here.`,
      });
      return;
    }
    this.savingState.set(section);
    this.setFeedback(section, null);
    saveFields(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        this.savingState.set(null);
        commit(new Set(saved));
        const remaining = [...failed, ...blocked];
        if (remaining.length === 0) {
          this.setFeedback(section, {
            tone: 'success',
            message: `${sentenceList(saved)} saved.`,
          });
          return;
        }
        const message = saved.length
          ? `${sentenceList(saved)} saved. ${sentenceList(remaining)} ${remaining.length === 1 ? 'is' : 'are'} still unsaved; retry saves only what remains.`
          : `${sentenceList(remaining)} could not be saved. Your edits are still here.`;
        this.setFeedback(section, { tone: 'danger', message });
        this.toast.show(message, { duration: 5000, variant: 'danger' });
      });
  }

  private commitGeneral(
    saved: ReadonlySet<string>,
    candidate: GeneralBaseline,
  ): void {
    const previous = this.baseline();
    this.baseline.set({
      name: saved.has('name') ? candidate.name : previous.name,
      topic: saved.has('topic') ? candidate.topic : previous.topic,
    });
    this.modelState.update((current) => ({
      ...current,
      name:
        saved.has('name') && current.name.trim() === candidate.name
          ? candidate.name
          : current.name,
      topic:
        saved.has('topic') && current.topic.trim() === candidate.topic
          ? candidate.topic
          : current.topic,
    }));
  }

  private setFeedback(
    section: 'general' | 'access',
    feedback: SpaceSettingsFeedback | null,
  ): void {
    (section === 'general'
      ? this.generalFeedbackState
      : this.accessFeedbackState
    ).set(feedback);
  }

  private reconcile(snapshot: RoomSettingsSnapshot): void {
    const hadSnapshot = this.snapshot() !== null;
    const previous = this.baseline();
    const previousAccess = this.accessBaseline();
    const current = this.model();
    const nameWasDirty = current.name.trim() !== previous.name;
    const topicWasDirty = current.topic.trim() !== previous.topic;
    const accessWasDirty = current.joinRule !== previousAccess;
    const previousSnapshot = this.snapshot();
    this.snapshotState.set(
      snapshot.availability !== 'available' && previousSnapshot
        ? {
            ...snapshot,
            identity: previousSnapshot.identity,
            encrypted: previousSnapshot.encrypted,
          }
        : snapshot,
    );
    if (snapshot.availability !== 'available') return;

    const next: GeneralBaseline = {
      name: snapshot.identity.name,
      topic: snapshot.identity.topic,
    };
    this.modelState.set({
      name: hadSnapshot && nameWasDirty ? current.name : next.name,
      topic: hadSnapshot && topicWasDirty ? current.topic : next.topic,
      joinRule:
        hadSnapshot && accessWasDirty
          ? current.joinRule
          : snapshot.access.joinRule,
    });
    this.baseline.set(next);
    this.accessBaseline.set(snapshot.access.joinRule);
  }
}

function sentenceList(fields: readonly string[]): string {
  if (fields.length === 0) return 'Space details';
  const sentence = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    fields,
  );
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
