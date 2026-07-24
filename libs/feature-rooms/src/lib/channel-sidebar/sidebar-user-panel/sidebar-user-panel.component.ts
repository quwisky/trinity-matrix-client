import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideLogOut,
  lucideSettings,
  lucideUserPlus,
  lucideUsers,
} from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type UserProfile } from '@trinity/data-access-profile';
import {
  HlmDropdownMenu,
  HlmDropdownMenuCheckbox,
  HlmDropdownMenuCheckboxIndicator,
  HlmDropdownMenuItem,
  HlmDropdownMenuItemSubIndicator,
  HlmDropdownMenuLabel,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { initialOf } from '@trinity/util-matrix';
import { unreadBadgeLabel } from '../../shared/unread-badge';

/** One signed-in account in the user-panel switcher: the profile plus its unread total. */
export interface AccountSummary extends UserProfile {
  /** Unread notification total for this account (drives the switcher badge). */
  unread: number;
}

/** The channel sidebar's bottom user panel: the signed-in user plus the account switcher. */
@Component({
  selector: 'trn-sidebar-user-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    NgIcon,
    HlmDropdownMenuTrigger,
    HlmDropdownMenu,
    HlmDropdownMenuCheckbox,
    HlmDropdownMenuCheckboxIndicator,
    HlmDropdownMenuItem,
    HlmDropdownMenuItemSubIndicator,
    HlmDropdownMenuLabel,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuSub,
    HlmDropdownMenuSubTrigger,
  ],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideLogOut,
      lucideSettings,
      lucideUserPlus,
      lucideUsers,
    }),
  ],
  templateUrl: './sidebar-user-panel.component.html',
  styleUrl: './sidebar-user-panel.component.scss',
})
export class SidebarUserPanelComponent {
  /** The signed-in user (name + handle + avatar) for the panel trigger. */
  readonly user = input<UserProfile>({
    userId: '',
    displayName: '',
    avatarMxc: null,
  });
  /** First letter of the display name, for the avatar fallback. */
  readonly userInitial = computed(() => initialOf(this.user().displayName));
  /** Every signed-in account, for the switcher list. */
  readonly accounts = input<AccountSummary[]>([]);
  /** The user id of the account currently in view (marked with a check). */
  readonly activeUserId = input<string | null>(null);
  /** User ids of accounts the server signed out that need re-authentication. */
  readonly reauthAccounts = input<readonly string[]>([]);
  /**
   * The accounts the room list currently draws from. Drives the picker's ticks and the
   * stacked-avatar indicator; defaults to empty so the panel renders standalone.
   */
  readonly shownAccountIds = input<ReadonlySet<string>>(new Set());
  /**
   * The accounts being mixed, active account first so it stays the front tile of the stack.
   * Empty unless more than one account is shown — a single account renders the plain avatar.
   */
  readonly mixedAccounts = computed<AccountSummary[]>(() => {
    const shown = this.shownAccountIds();
    if (shown.size < 2) {
      return [];
    }
    const active = this.activeUserId();
    return this.accounts()
      .filter((account) => shown.has(account.userId))
      .sort(
        (a, b) =>
          Number(b.userId === active) - Number(a.userId === active) ||
          a.displayName.localeCompare(b.displayName),
      );
  });
  /** The picker is only meaningful with more than one account signed in. */
  readonly canPickAccounts = computed(() => this.accounts().length > 1);
  /** Gear — open the settings page. */
  readonly openSettings = output<void>();
  /** The user ticked/unticked an account in the "Show accounts" picker. */
  readonly toggleAccountShown = output<string>();
  /** Switch the active account to the given user id (a switcher row that isn't active). */
  readonly switchAccount = output<string>();
  /** Re-authenticate a soft-logged-out account by its user id. */
  readonly reauthAccount = output<string>();
  /** "Add account" — start a login in add mode. */
  readonly addAccount = output<void>();
  /** Sign out the given account (the active one). */
  readonly logout = output<string>();
  /** Cap an unread count for a switcher badge, Discord-style ("99+"). */
  readonly badgeLabel = unreadBadgeLabel;

  /** First letter of an account's display name, for its avatar fallback. */
  initialFor(account: AccountSummary): string {
    return initialOf(account.displayName);
  }
}
