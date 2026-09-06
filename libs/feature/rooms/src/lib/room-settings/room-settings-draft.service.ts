import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { disabled, form } from '@angular/forms/signals';
import { TrnToastService } from '@trinity/components/overlay';
import {
  HistoryVisibility,
  JoinRule,
  RoomSettingsService,
  type RoomSettingsSnapshot,
  type RoomSettingsTarget,
} from '@trinity/data-access/room-administration';
import { saveFields, type FieldWrite } from '../shared/save-fields';
import { applyRoomBasicsGates } from '../shared/room-basics-form';
import {
  type AccessBaseline,
  DENIED_ROOM_SETTINGS,
  type GeneralBaseline,
  JOIN_RULE_OPTIONS,
  ROOM_HISTORY_OPTIONS,
  type RoomSettingsModel,
  sameMembers,
  sentenceList,
  withCurrentHistory,
  withCurrentRule,
} from './room-settings-draft.models';
import type { ParentSpace } from './room-settings.models';

export interface RoomSettingsFeedback {
  readonly tone: 'success' | 'danger';
  readonly message: string;
}

/** Owns Room-settings drafts independently of Workspace and authoritative sync updates. */
@Injectable()
export class RoomSettingsDraftService {
  private readonly settings = inject(RoomSettingsService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly target = signal<RoomSettingsTarget | null>(null);
  private readonly parentSpaces = signal<readonly ParentSpace[]>([]);
  private readonly generalBaseline = signal<GeneralBaseline>({
    name: '',
    topic: '',
  });
  private readonly accessBaseline = signal<AccessBaseline>({
    joinRule: JoinRule.Invite,
    historyVisibility: HistoryVisibility.Shared,
    allowedSpaceIds: [],
  });
  private readonly checkedSpaces = signal<ReadonlySet<string>>(new Set());
  private started = false;

  private readonly snapshotState = signal<RoomSettingsSnapshot | null>(null);
  private readonly modelState = signal<RoomSettingsModel>({
    name: '',
    topic: '',
    joinRule: JoinRule.Invite,
    historyVisibility: HistoryVisibility.Shared,
  });
  private readonly savingState = signal<'general' | 'access' | null>(null);
  private readonly generalFeedbackState = signal<RoomSettingsFeedback | null>(
    null,
  );
  private readonly accessFeedbackState = signal<RoomSettingsFeedback | null>(
    null,
  );

  readonly snapshot = this.snapshotState.asReadonly();
  readonly model = this.modelState.asReadonly();
  readonly saving = this.savingState.asReadonly();
  readonly generalFeedback = this.generalFeedbackState.asReadonly();
  readonly accessFeedback = this.accessFeedbackState.asReadonly();

  readonly permissions = computed(
    () => this.snapshot()?.permissions ?? DENIED_ROOM_SETTINGS,
  );
  readonly targetAvailable = computed(
    () => this.snapshot()?.availability === 'available',
  );
  readonly targetUnavailableReason = computed(
    () => this.snapshot()?.unavailableReason ?? null,
  );
  readonly openingAccountActive = computed(
    () => this.snapshot()?.openingAccountActive ?? false,
  );
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
  readonly mayEditHistory = computed(
    () => this.targetAvailable() && this.permissions().history.available,
  );

  readonly form = form(this.modelState, (path) => {
    applyRoomBasicsGates(path, {
      canEditName: this.mayEditName,
      canEditTopic: this.mayEditTopic,
      canEditJoinRule: this.mayEditJoinRule,
    });
    disabled(path.historyVisibility, { when: () => !this.mayEditHistory() });
  });
  readonly generalDirty = computed(() => {
    const model = this.model();
    const baseline = this.generalBaseline();
    return (
      model.name.trim() !== baseline.name ||
      model.topic.trim() !== baseline.topic
    );
  });
  readonly accessDirty = computed(() => {
    const model = this.model();
    const baseline = this.accessBaseline();
    return (
      this.joinRuleChanged() ||
      model.historyVisibility !== baseline.historyVisibility
    );
  });
  readonly dirty = computed(() => this.generalDirty() || this.accessDirty());
  readonly generalHasWritableChanges = computed(() => {
    const model = this.model();
    const baseline = this.generalBaseline();
    return (
      (this.mayEditName() && model.name.trim() !== baseline.name) ||
      (this.mayEditTopic() && model.topic.trim() !== baseline.topic)
    );
  });
  readonly accessHasWritableChanges = computed(() => {
    const model = this.model();
    const baseline = this.accessBaseline();
    return (
      (this.mayEditJoinRule() && this.joinRuleChanged()) ||
      (this.mayEditHistory() &&
        model.historyVisibility !== baseline.historyVisibility)
    );
  });

  readonly generalSaveUnavailableReason = computed(() => {
    if (this.targetUnavailableReason()) return this.targetUnavailableReason();
    if (!this.mayEditName() && !this.mayEditTopic()) {
      return 'Your role cannot change this Room’s name or topic.';
    }
    return null;
  });
  readonly accessSaveUnavailableReason = computed(() => {
    if (this.targetUnavailableReason()) return this.targetUnavailableReason();
    if (!this.mayEditJoinRule() && !this.mayEditHistory()) {
      return 'Your role cannot change this Room’s access settings.';
    }
    return null;
  });

  readonly joinRuleOptions = computed(() => {
    const spaces = this.parentSpaces();
    const options: { value: JoinRule; label: string }[] = [
      ...JOIN_RULE_OPTIONS,
    ];
    if (spaces.length > 0 && this.snapshot()?.supportsRestricted) {
      options.push({
        value: JoinRule.Restricted,
        label: 'Space members can join',
      });
    }
    return withCurrentRule(options, this.model().joinRule).map((option) => ({
      ...option,
      testId: `join-rule-${option.value}`,
    }));
  });
  readonly historyOptions = computed(() =>
    withCurrentHistory(ROOM_HISTORY_OPTIONS, this.model().historyVisibility),
  );
  readonly showSpaceChoices = computed(
    () =>
      this.model().joinRule === JoinRule.Restricted &&
      this.parentSpaces().length > 0,
  );
  readonly noSpaceChosen = computed(
    () =>
      this.mayEditJoinRule() &&
      this.joinRuleChanged() &&
      this.model().joinRule === JoinRule.Restricted &&
      this.allowToWrite().length === 0,
  );
  readonly unlistedAllowedSpaceCount = computed(() => {
    if (this.model().joinRule !== JoinRule.Restricted) return 0;
    const parentIds = new Set(this.parentSpaces().map(({ id }) => id));
    return this.accessBaseline().allowedSpaceIds.filter(
      (id) => !parentIds.has(id),
    ).length;
  });

  private joinRuleChanged(): boolean {
    const model = this.model();
    const baseline = this.accessBaseline();
    const allow =
      model.joinRule === JoinRule.Restricted ? this.allowToWrite() : [];
    return (
      model.joinRule !== baseline.joinRule ||
      !sameMembers(allow, baseline.allowedSpaceIds)
    );
  }

  start(
    target: RoomSettingsTarget,
    parentSpaces: readonly ParentSpace[],
  ): void {
    if (this.started) return;
    this.started = true;
    this.target.set(target);
    this.parentSpaces.set(parentSpaces);
    this.reconcile(this.settings.snapshot(target));
    this.settings
      .observe(target)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((snapshot) => this.reconcile(snapshot));
  }

  isSpaceChecked(spaceId: string): boolean {
    return this.checkedSpaces().has(spaceId);
  }

  toggleSpace(spaceId: string, checked: boolean): void {
    this.checkedSpaces.update((current) => {
      const next = new Set(current);
      if (checked) next.add(spaceId);
      else next.delete(spaceId);
      return next;
    });
    this.accessFeedbackState.set(null);
  }

  discardGeneral(): void {
    const baseline = this.generalBaseline();
    this.modelState.update((current) => ({ ...current, ...baseline }));
    this.generalFeedbackState.set(null);
    this.form().reset();
  }

  discardAccess(): void {
    const baseline = this.accessBaseline();
    this.modelState.update((current) => ({
      ...current,
      joinRule: baseline.joinRule,
      historyVisibility: baseline.historyVisibility,
    }));
    this.seedCheckedSpaces(baseline);
    this.accessFeedbackState.set(null);
  }

  saveGeneral(): void {
    const target = this.target();
    if (!target || !this.generalDirty()) return;
    const candidate = {
      name: this.model().name.trim(),
      topic: this.model().topic.trim(),
    };
    const baseline = this.generalBaseline();
    const blocked: string[] = [];
    const writes: FieldWrite[] = [];
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
    this.runSave('general', writes, blocked, (saved) => {
      this.commitGeneral(saved, candidate);
    });
  }

  saveAccess(): void {
    const target = this.target();
    if (!target || !this.accessDirty() || this.noSpaceChosen()) return;
    const model = this.model();
    const baseline = this.accessBaseline();
    const allow =
      model.joinRule === JoinRule.Restricted ? this.allowToWrite() : [];
    const blocked: string[] = [];
    const writes: FieldWrite[] = [];
    if (
      model.joinRule !== baseline.joinRule ||
      !sameMembers(allow, baseline.allowedSpaceIds)
    ) {
      if (this.mayEditJoinRule()) {
        writes.push({
          field: 'join rule',
          op: this.settings.setJoinRule(target, model.joinRule, allow),
        });
      } else {
        blocked.push('join rule');
      }
    }
    if (model.historyVisibility !== baseline.historyVisibility) {
      if (this.mayEditHistory()) {
        writes.push({
          field: 'history visibility',
          op: this.settings.setHistoryVisibility(
            target,
            model.historyVisibility,
          ),
        });
      } else {
        blocked.push('history visibility');
      }
    }
    this.runSave('access', writes, blocked, (saved) => {
      this.commitAccess(saved, model, allow);
    });
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

  private setFeedback(
    section: 'general' | 'access',
    feedback: RoomSettingsFeedback | null,
  ): void {
    (section === 'general'
      ? this.generalFeedbackState
      : this.accessFeedbackState
    ).set(feedback);
  }

  private commitGeneral(
    saved: ReadonlySet<string>,
    candidate: GeneralBaseline,
  ): void {
    const previous = this.generalBaseline();
    this.generalBaseline.set({
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

  private commitAccess(
    saved: ReadonlySet<string>,
    candidate: Pick<RoomSettingsModel, 'joinRule' | 'historyVisibility'>,
    allow: readonly string[],
  ): void {
    const previous = this.accessBaseline();
    this.accessBaseline.set({
      joinRule: saved.has('join rule') ? candidate.joinRule : previous.joinRule,
      historyVisibility: saved.has('history visibility')
        ? candidate.historyVisibility
        : previous.historyVisibility,
      allowedSpaceIds: saved.has('join rule')
        ? [...allow]
        : previous.allowedSpaceIds,
    });
  }

  private reconcile(snapshot: RoomSettingsSnapshot): void {
    const hadSnapshot = this.snapshot() !== null;
    const previousGeneral = this.generalBaseline();
    const previousAccess = this.accessBaseline();
    const current = this.model();
    const nameWasDirty = current.name.trim() !== previousGeneral.name;
    const topicWasDirty = current.topic.trim() !== previousGeneral.topic;
    const joinRuleWasDirty =
      current.joinRule !== previousAccess.joinRule ||
      !sameMembers(
        current.joinRule === JoinRule.Restricted ? this.allowToWrite() : [],
        previousAccess.allowedSpaceIds,
      );
    const historyWasDirty =
      current.historyVisibility !== previousAccess.historyVisibility;
    this.snapshotState.set(snapshot);
    if (snapshot.availability !== 'available') return;

    const nextGeneral: GeneralBaseline = {
      name: snapshot.identity.name,
      topic: snapshot.identity.topic,
    };
    const nextAccess: AccessBaseline = {
      joinRule: snapshot.access.joinRule,
      historyVisibility: snapshot.access.historyVisibility,
      allowedSpaceIds: snapshot.access.allowedSpaceIds,
    };
    this.modelState.set({
      name: hadSnapshot && nameWasDirty ? current.name : nextGeneral.name,
      topic: hadSnapshot && topicWasDirty ? current.topic : nextGeneral.topic,
      joinRule:
        hadSnapshot && joinRuleWasDirty
          ? current.joinRule
          : nextAccess.joinRule,
      historyVisibility:
        hadSnapshot && historyWasDirty
          ? current.historyVisibility
          : nextAccess.historyVisibility,
    });
    this.generalBaseline.set(nextGeneral);
    this.accessBaseline.set(nextAccess);
    if (!hadSnapshot || !joinRuleWasDirty) this.seedCheckedSpaces(nextAccess);
  }

  private seedCheckedSpaces(access: AccessBaseline): void {
    const parentIds = this.parentSpaces().map((space) => space.id);
    this.checkedSpaces.set(
      access.joinRule === JoinRule.Restricted
        ? new Set(access.allowedSpaceIds.filter((id) => parentIds.includes(id)))
        : new Set(parentIds),
    );
  }

  private allowToWrite(): string[] {
    const parents = this.parentSpaces();
    const parentIds = new Set(parents.map((space) => space.id));
    const preserved = this.accessBaseline().allowedSpaceIds.filter(
      (id) => !parentIds.has(id),
    );
    const ticked = parents
      .filter((space) => this.checkedSpaces().has(space.id))
      .map((space) => space.id);
    return [...preserved, ...ticked];
  }
}
