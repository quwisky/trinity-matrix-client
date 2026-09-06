import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { disabled, form } from '@angular/forms/signals';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { saveFields, type FieldWrite } from '../../shared/save-fields';
import { sentenceList } from '../room-settings-draft.models';
import { RoomSettingsDraftService } from '../room-settings-draft.service';

export type RoomForYouLoadState =
  'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';

export interface RoomForYouModel {
  readonly notificationMode: RoomNotifyMode;
  readonly favourite: boolean;
  readonly lowPriority: boolean;
}

export interface RoomForYouFeedback {
  readonly tone: 'pending' | 'success' | 'danger';
  readonly message: string;
}

interface RoomForYouTarget {
  readonly accountId: string;
  readonly roomId: string;
}

const EMPTY_MODEL: RoomForYouModel = {
  notificationMode: 'all',
  favourite: false,
  lowPriority: false,
};

/** Staged, exact-Account personal Room preferences for the For you section. */
@Injectable()
export class RoomSettingsForYouDraftService {
  private readonly notifications = inject(RoomNotificationsService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomDraft = inject(RoomSettingsDraftService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly target = signal<RoomForYouTarget | null>(null);
  private readonly loadStateState = signal<RoomForYouLoadState>('idle');
  private readonly baselineState = signal<RoomForYouModel>(EMPTY_MODEL);
  private readonly modelState = signal<RoomForYouModel>(EMPTY_MODEL);
  private readonly savingState = signal(false);
  private readonly feedbackState = signal<RoomForYouFeedback | null>(null);

  readonly loadState = this.loadStateState.asReadonly();
  readonly model = this.modelState.asReadonly();
  readonly saving = this.savingState.asReadonly();
  readonly feedback = this.feedbackState.asReadonly();
  readonly form = form(this.modelState, (path) => {
    const whenUnavailableOrSaving = () =>
      this.savingState() || !this.roomDraft.targetAvailable();
    disabled(path.notificationMode, { when: whenUnavailableOrSaving });
    disabled(path.favourite, { when: whenUnavailableOrSaving });
    disabled(path.lowPriority, { when: whenUnavailableOrSaving });
  });
  readonly dirty = computed(() => {
    if (this.loadState() !== 'ready') return false;
    const model = this.model();
    const baseline = this.baselineState();
    return (
      model.notificationMode !== baseline.notificationMode ||
      model.favourite !== baseline.favourite ||
      model.lowPriority !== baseline.lowPriority
    );
  });

  start(target: RoomForYouTarget): void {
    if (this.target()) return;
    this.target.set(target);
    this.load();
  }

  retryLoad(): void {
    if (this.loadState() === 'loading' || this.saving()) return;
    this.load();
  }

  setNotificationMode(notificationMode: RoomNotifyMode): void {
    this.modelState.update((current) => ({ ...current, notificationMode }));
    this.feedbackState.set(null);
  }

  setFavourite(favourite: boolean): void {
    this.modelState.update((current) => ({ ...current, favourite }));
    this.feedbackState.set(null);
  }

  setLowPriority(lowPriority: boolean): void {
    this.modelState.update((current) => ({ ...current, lowPriority }));
    this.feedbackState.set(null);
  }

  discard(): void {
    if (this.loadState() !== 'ready') return;
    this.modelState.set(this.baselineState());
    this.feedbackState.set(null);
  }

  save(): void {
    const target = this.target();
    if (
      !target ||
      this.loadState() !== 'ready' ||
      this.saving() ||
      !this.dirty()
    ) {
      return;
    }

    const candidate = this.model();
    const baseline = this.baselineState();
    const writes: FieldWrite[] = [];
    if (candidate.notificationMode !== baseline.notificationMode) {
      writes.push({
        field: 'notifications',
        op: this.notifications.setMode(
          target.roomId,
          candidate.notificationMode,
          target.accountId,
        ),
      });
    }
    if (candidate.favourite !== baseline.favourite) {
      writes.push({
        field: 'favourite',
        op: this.rooms.setFavourite(
          target.roomId,
          candidate.favourite,
          target.accountId,
        ),
      });
    }
    if (candidate.lowPriority !== baseline.lowPriority) {
      writes.push({
        field: 'low priority',
        op: this.rooms.setLowPriority(
          target.roomId,
          candidate.lowPriority,
          target.accountId,
        ),
      });
    }

    this.savingState.set(true);
    this.feedbackState.set({
      tone: 'pending',
      message: 'Saving preferences for the opening Account…',
    });
    saveFields(writes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ saved, failed }) => {
        this.savingState.set(false);
        this.commit(new Set(saved), candidate);
        if (failed.length === 0) {
          this.feedbackState.set({
            tone: 'success',
            message: `${sentenceList(saved)} saved for the opening Account.`,
          });
          return;
        }
        const message = saved.length
          ? `${sentenceList(saved)} saved. ${sentenceList(failed)} ${failed.length === 1 ? 'is' : 'are'} still unsaved; retry saves only what remains.`
          : `${sentenceList(failed)} could not be saved. Your changes are still here.`;
        this.feedbackState.set({ tone: 'danger', message });
      });
  }

  private load(): void {
    const target = this.target();
    if (!target) return;
    this.loadStateState.set('loading');
    this.feedbackState.set(null);

    const organisation = this.rooms.organisationFor(
      target.accountId,
      target.roomId,
    );
    if (!organisation) {
      this.loadStateState.set('unavailable');
      return;
    }

    this.notifications
      .readMode(target.roomId, target.accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (notificationMode) => {
          const model = { notificationMode, ...organisation };
          this.baselineState.set(model);
          this.modelState.set(model);
          this.loadStateState.set('ready');
        },
        error: () => this.loadStateState.set('failed'),
      });
  }

  private commit(saved: ReadonlySet<string>, candidate: RoomForYouModel): void {
    const previous = this.baselineState();
    this.baselineState.set({
      notificationMode: saved.has('notifications')
        ? candidate.notificationMode
        : previous.notificationMode,
      favourite: saved.has('favourite')
        ? candidate.favourite
        : previous.favourite,
      lowPriority: saved.has('low priority')
        ? candidate.lowPriority
        : previous.lowPriority,
    });
  }
}
