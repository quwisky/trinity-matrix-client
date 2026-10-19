import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
    // A native radio stays where the user moved it, but the role only changes once the
    // caller's confirmed write lands, so show the current role until then.
    const current = this.options().findIndex(
      ({ level }) => level === this.current(),
    );
    this.host.nativeElement
      .querySelectorAll<HTMLInputElement>('input[type="radio"]')
      .forEach((radio, index) => (radio.checked = index === current));
    if (
      option.level === this.current() ||
      !this.permissionFor()(option.level).available
    ) {
      return;
    }
    this.choose.emit(option);
  }
}
