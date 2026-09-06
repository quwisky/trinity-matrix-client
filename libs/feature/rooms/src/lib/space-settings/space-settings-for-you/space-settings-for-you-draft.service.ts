import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { disabled, form } from '@angular/forms/signals';
import type { TrnRadioOption } from '@trinity/components/controls';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type SpaceRoomOrderSnapshot,
} from '@trinity/data-access/room-library';
import { SpaceSettingsDraftService } from '../space-settings-draft.service';

export type SpaceOrderSelection = 'default' | RoomSortMode;
export type SpaceOrderLoadState =
  'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';

interface SpaceOrderModel {
  readonly mode: SpaceOrderSelection;
}

interface SpaceOrderTarget {
  readonly accountId: string;
  readonly spaceId: string;
}

export interface SpaceOrderFeedback {
  readonly tone: 'pending' | 'success' | 'danger';
  readonly message: string;
}

const EMPTY_MODEL: SpaceOrderModel = { mode: 'default' };

/** Stages one device-local Space ordering choice for an immutable Account and Space. */
@Injectable()
export class SpaceSettingsForYouDraftService {
  private readonly order = inject(SpaceRoomOrderService);
  private readonly space = inject(SpaceSettingsDraftService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly targetState = signal<SpaceOrderTarget | null>(null);
  private readonly loadStateState = signal<SpaceOrderLoadState>('idle');
  private readonly baselineState = signal<SpaceOrderModel>(EMPTY_MODEL);
  private readonly modelState = signal<SpaceOrderModel>(EMPTY_MODEL);
  private readonly savingState = signal(false);
  private readonly feedbackState = signal<SpaceOrderFeedback | null>(null);

  readonly loadState = this.loadStateState.asReadonly();
  readonly model = this.modelState.asReadonly();
  readonly saving = this.savingState.asReadonly();
  readonly feedback = this.feedbackState.asReadonly();
  readonly form = form(this.modelState, (path) => {
    disabled(path.mode, {
      when: () =>
        this.savingState() ||
        this.loadStateState() !== 'ready' ||
        !this.space.targetAvailable(),
    });
  });
  readonly dirty = computed(
    () =>
      this.loadState() === 'ready' &&
      this.model().mode !== this.baselineState().mode,
  );
  readonly options = computed<readonly TrnRadioOption<SpaceOrderSelection>[]>(
    () => {
      const target = this.targetState();
      const snapshot = target
        ? this.order.snapshotFor(target.accountId, target.spaceId)
        : null;
      const defaultLabel = labelFor(snapshot?.defaultMode ?? 'recent');
      return [
        {
          value: 'default',
          label: 'Use my default',
          description: `Follow ${defaultLabel} now and any later change to this Account’s default.`,
          testId: 'space-settings-order-default',
        },
        ...TRINITY_ROOM_SORTS.map((mode) => ({
          value: mode.id,
          label: mode.label,
          description: mode.description,
          testId: `space-settings-order-${mode.id}`,
        })),
      ];
    },
  );

  start(target: SpaceOrderTarget): void {
    if (this.targetState()) return;
    this.targetState.set(target);
    this.load();
  }

  retryLoad(): void {
    if (this.loadState() === 'loading' || this.saving()) return;
    this.load();
  }

  setMode(mode: SpaceOrderSelection): void {
    this.modelState.set({ mode });
    this.feedbackState.set(null);
  }

  discard(): void {
    if (this.loadState() !== 'ready' || this.saving()) return;
    this.modelState.set(this.baselineState());
    this.feedbackState.set(null);
    this.form().reset();
  }

  save(): void {
    const target = this.targetState();
    if (
      !target ||
      this.loadState() !== 'ready' ||
      this.saving() ||
      !this.space.targetAvailable() ||
      !this.dirty()
    ) {
      return;
    }

    const candidate = this.model();
    const command =
      candidate.mode === 'default'
        ? this.order.clearForAccountSpace(target.accountId, target.spaceId)
        : this.order.setForAccountSpace(
            target.accountId,
            target.spaceId,
            candidate.mode,
          );
    this.savingState.set(true);
    this.feedbackState.set({
      tone: 'pending',
      message: 'Saving this Account’s device preference…',
    });
    command.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.baselineState.set(candidate);
        this.savingState.set(false);
        this.feedbackState.set({
          tone: 'success',
          message: 'Room order saved for this Account on this device.',
        });
      },
      error: () => {
        this.savingState.set(false);
        this.feedbackState.set({
          tone: 'danger',
          message:
            'Room order could not be saved. Your selection is still here; try again.',
        });
      },
    });
  }

  private load(): void {
    const target = this.targetState();
    if (!target) return;
    if (!this.space.targetAvailable()) {
      this.loadStateState.set('unavailable');
      return;
    }

    this.loadStateState.set('loading');
    this.feedbackState.set(null);
    this.order
      .retryHydration(target.accountId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((settlement) => {
        if (settlement.kind === 'not-applicable') {
          this.loadStateState.set('unavailable');
          return;
        }
        if (settlement.kind === 'defaulted') {
          this.loadStateState.set('failed');
          return;
        }
        this.adopt(this.order.snapshotFor(target.accountId, target.spaceId));
      });
  }

  private adopt(snapshot: SpaceRoomOrderSnapshot): void {
    const model: SpaceOrderModel = {
      mode: snapshot.overrideMode ?? 'default',
    };
    this.baselineState.set(model);
    this.modelState.set(model);
    this.loadStateState.set('ready');
    this.form().reset();
  }
}

function labelFor(mode: RoomSortMode): string {
  return TRINITY_ROOM_SORTS.find((option) => option.id === mode)?.label ?? mode;
}
