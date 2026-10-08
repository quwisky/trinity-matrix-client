import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

/** The `matrix.to` permalink for an address. */
export function matrixToUrl(alias: string): string {
  return `https://matrix.to/#/${encodeURIComponent(alias)}`;
}

/**
 * One published address: its value, a Primary badge, and Copy / Open link, plus Make primary
 * and Remove when `canEdit`. Presentational: it announces what was pressed and the host does it.
 */
@Component({
  selector: 'trn-room-alias-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-alias-row.component.html',
  host: {
    role: 'listitem',
    class: 'flex min-w-0 flex-col gap-3 rounded-md border border-border p-3',
    'data-testid': 'room-alias',
  },
  imports: [TrnButton],
})
export class RoomAliasRowComponent {
  readonly alias = input.required<string>();
  readonly primary = input.required<boolean>();
  readonly canEdit = input.required<boolean>();
  readonly removing = input.required<boolean>();
  readonly confirming = input.required<boolean>();
  /** The alias being made primary, if any; every row disables Make primary meanwhile. */
  readonly settingPrimary = input<string | null>(null);
  /** The address element, so the host can select it when the Clipboard API fails. */
  readonly copyAddress = output<HTMLElement>();
  readonly setPrimary = output<void>();
  readonly remove = output<void>();

  protected readonly link = computed(() => matrixToUrl(this.alias()));
}
