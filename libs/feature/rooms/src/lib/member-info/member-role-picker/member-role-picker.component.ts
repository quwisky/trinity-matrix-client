import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import {
  type ActionAvailability,
  type AssignableMemberRole,
} from '@trinity/data-access/room-administration';

/** One radio per role, the current one checked; a role the viewer cannot assign says why. */
@Component({
  selector: 'trn-member-role-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnRadioGroupComponent],
  templateUrl: './member-role-picker.component.html',
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

  protected readonly selected = computed(
    () =>
      this.options().find((option) => option.level === this.current()) ?? null,
  );

  protected pick(option: AssignableMemberRole): void {
    if (
      option.level === this.current() ||
      !this.permissionFor()(option.level).available
    ) {
      return;
    }
    this.choose.emit(option);
  }
}
