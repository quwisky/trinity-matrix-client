import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import { type IdentityProfile } from '@trinity/data-access/identity';
import { accountInitial } from '../account-initial';

/**
 * The avatar, name and Matrix ID of an account in an "Accounts in view" row. Shared by
 * the account-picker dialog and the user panel's submenu so both draw one account the same.
 */
@Component({
  selector: 'trn-account-pick-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent],
  templateUrl: './account-pick-label.component.html',
  styleUrl: './account-pick-label.component.scss',
})
export class AccountPickLabelComponent {
  readonly account = input.required<IdentityProfile>();
  /** The account is always included, so the row says so. */
  readonly locked = input(false);
  readonly initial = computed(() => accountInitial(this.account()));
}
