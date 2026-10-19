import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import {
  TrnButton,
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import {
  type ActionAvailability,
  type AssignableMemberRole,
} from '@trinity/data-access/room-administration';

/**
 * One radio per role, the current one checked; a role the viewer cannot assign says why.
 * Choosing only moves the selection (arrow keys fire `change` on every step); the
 * "Change role" button commits it.
 */
@Component({
  selector: 'trn-member-role-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnRadioGroupComponent],
  templateUrl: './member-role-picker.component.html',
  host: { class: 'flex flex-col gap-2' },
})
export class MemberRolePickerComponent {
  readonly options = input.required<readonly AssignableMemberRole[]>();
  readonly current = input.required<number>();
  readonly permissionFor =
    input.required<(level: number) => ActionAvailability>();
  readonly targetName = input.required<string>();

  readonly choose = output<AssignableMemberRole>();

  protected readonly radios = computed(() =>
    this.options().map((option): TrnRadioOption<AssignableMemberRole> => {
      const permission = this.permissionFor()(option.level);
      return {
        value: option,
        label: option.label,
        description: permission.available
          ? undefined
          : (permission.reason ?? undefined),
        disabled: !permission.available,
        testId: `member-info-role-${option.level}`,
      };
    }),
  );

  /** The checked role; resets to the current one whenever the real role changes. */
  protected readonly pending = linkedSignal(
    () =>
      this.options().find((option) => option.level === this.current()) ?? null,
  );

  protected readonly unchanged = computed(
    () => (this.pending()?.level ?? this.current()) === this.current(),
  );

  protected pick(option: AssignableMemberRole): void {
    this.pending.set(option);
  }

  protected apply(): void {
    const option = this.pending();
    if (
      !option ||
      option.level === this.current() ||
      !this.permissionFor()(option.level).available
    ) {
      return;
    }
    this.choose.emit(option);
  }
}
