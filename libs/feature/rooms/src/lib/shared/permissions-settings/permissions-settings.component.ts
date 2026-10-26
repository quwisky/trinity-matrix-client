import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of, switchMap } from 'rxjs';
import {
  TrnButton,
  TrnInput,
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';
import {
  MAX_POWER_LEVEL,
  RoomPermissionsService,
  type PermissionRowView,
  type PermissionTargetKind,
} from '@trinity/data-access/room-administration';
import { settingsActionFailure } from '../../room-settings/settings-action-failure';

type Choice = number | 'custom' | 'mixed';

const STANDARD: readonly TrnSelectOption<Choice>[] = [
  { value: 0, label: 'Member' },
  { value: 50, label: 'Moderator' },
  { value: 100, label: 'Admin' },
  { value: 'custom', label: 'Custom' },
];

/** "Roles and permissions" editor for one room or space; the hub guards closing via `dirty()`. */
@Component({
  selector: 'trn-permissions-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnInput,
    TrnSelectComponent,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
  ],
  templateUrl: './permissions-settings.component.html',
  styleUrl: './permissions-settings.component.scss',
})
export class PermissionsSettingsComponent {
  private readonly service = inject(RoomPermissionsService);
  private readonly alerts = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly kind = input.required<PermissionTargetKind>();

  protected readonly changes = signal<ReadonlyMap<string, number>>(new Map());
  protected readonly customText = signal<ReadonlyMap<string, string>>(
    new Map(),
  );
  // Saved levels shown until the SDK applies them on the next sync.
  private readonly saved = signal<ReadonlyMap<string, number>>(new Map());
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly view = computed(() =>
    this.service.view(
      { accountId: this.accountId(), roomId: this.roomId() },
      this.kind(),
    ),
  );
  protected readonly groups = computed(() => {
    const groups = new Map<string, PermissionRowView[]>();
    for (const row of this.view().rows) {
      groups.set(row.row.group, [...(groups.get(row.row.group) ?? []), row]);
    }
    return [...groups].map(([title, rows]) => ({ title, rows }));
  });
  private readonly cap = computed(() => {
    const power = this.view().myPower;
    return Number.isFinite(power) ? power : null;
  });
  protected readonly customError = computed(() => {
    const cap = this.cap();
    return cap === null
      ? 'Enter a whole number.'
      : `Enter a whole number up to ${cap}.`;
  });
  protected readonly invalidIds = computed(() => {
    const invalid = new Set<string>();
    for (const [id, text] of this.customText()) {
      if (this.parse(text) === null) invalid.add(id);
    }
    return invalid;
  });
  protected readonly canSave = computed(
    () =>
      this.view().editable &&
      this.changes().size > 0 &&
      this.invalidIds().size === 0 &&
      !this.saving(),
  );

  constructor() {
    effect(() => {
      const levels = new Map(
        this.view().rows.map((item) => [item.row.id, item.level]),
      );
      const saved = untracked(this.saved);
      const pending = [...saved].filter(
        ([id, level]) => levels.get(id) !== level,
      );
      if (pending.length < saved.size) this.saved.set(new Map(pending));
    });
  }

  dirty(): boolean {
    return this.changes().size > 0 || this.customText().size > 0;
  }

  discard(): void {
    this.changes.set(new Map());
    this.customText.set(new Map());
    this.error.set(null);
  }

  protected optionsFor(item: PermissionRowView): TrnSelectOption<Choice>[] {
    const cap = this.cap();
    const options = STANDARD.map((option) =>
      typeof option.value === 'number' && cap !== null && option.value > cap
        ? { ...option, disabled: true }
        : option,
    );
    const level = this.changes().get(item.row.id) ?? this.baseline(item);
    if (level === 'mixed') {
      return [{ value: 'mixed', label: 'Mixed', disabled: true }, ...options];
    }
    if (
      typeof level === 'number' &&
      this.choiceOf(item) === 'custom' &&
      this.customText().get(item.row.id) === undefined
    ) {
      return options.map((o) =>
        o.value === 'custom' ? { ...o, label: `Custom (${level})` } : o,
      );
    }
    return options;
  }

  protected choiceOf(item: PermissionRowView): Choice {
    const id = item.row.id;
    if (this.customText().has(id)) return 'custom';
    const level = this.changes().get(id) ?? this.baseline(item);
    if (level === 'mixed') return 'mixed';
    return level === 0 || level === 50 || level === 100 ? level : 'custom';
  }

  protected choose(item: PermissionRowView, choice: Choice | null): void {
    if (choice === null || choice === 'mixed') return;
    const id = item.row.id;
    this.error.set(null);
    if (choice === 'custom') {
      const level = this.changes().get(id) ?? this.baseline(item);
      this.customText.update((m) =>
        new Map(m).set(id, typeof level === 'number' ? String(level) : ''),
      );
      return;
    }
    this.customText.update((m) => without(m, id));
    this.setChange(item, choice);
  }

  protected typeCustom(item: PermissionRowView, text: string): void {
    const id = item.row.id;
    this.error.set(null);
    this.customText.update((m) => new Map(m).set(id, text));
    const level = this.parse(text);
    if (level === null) {
      this.changes.update((m) => without(m, id));
    } else {
      this.setChange(item, level);
    }
  }

  protected save(): void {
    if (!this.canSave()) return;
    const view = this.view();
    const changes = this.changes();
    const next = changes.get('users-default');
    const locksOut =
      view.powerFromDefault &&
      next !== undefined &&
      next < view.permissionsLevel;
    this.saving.set(true);
    this.error.set(null);
    (locksOut
      ? this.alerts.confirm$({
          header: 'Lose permission to edit permissions?',
          message:
            "Your role comes from “New members start as”. After this change you won't be able to change permissions here.",
          confirmText: 'Save anyway',
        })
      : of(true)
    )
      .pipe(
        switchMap((go) =>
          go
            ? this.service.save(
                { accountId: this.accountId(), roomId: this.roomId() },
                this.kind(),
                changes,
              )
            : of(null),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (done) => {
          this.saving.set(false);
          if (done === null) return;
          this.saved.update((m) => new Map([...m, ...changes]));
          this.discard();
        },
        error: (err: unknown) => {
          this.saving.set(false);
          this.error.set(
            settingsActionFailure(err, 'Could not save permissions.'),
          );
        },
      });
  }

  private setChange(item: PermissionRowView, level: number): void {
    this.changes.update((m) =>
      level === this.baseline(item)
        ? without(m, item.row.id)
        : new Map(m).set(item.row.id, level),
    );
  }

  private baseline(item: PermissionRowView): PermissionRowView['level'] {
    return this.saved().get(item.row.id) ?? item.level;
  }

  private parse(text: string): number | null {
    if (!/^-?\d+$/.test(text.trim())) return null;
    const n = Number(text);
    const cap = this.cap() ?? MAX_POWER_LEVEL;
    return Number.isSafeInteger(n) && n <= cap && n >= -MAX_POWER_LEVEL
      ? n
      : null;
  }
}

function without<V>(map: ReadonlyMap<string, V>, id: string): Map<string, V> {
  const next = new Map(map);
  next.delete(id);
  return next;
}
