import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { type IdentityProfile } from '@trinity/data-access/identity';
import {
  TrnDropdownMenu,
  TrnDropdownMenuCheckbox,
  TrnDropdownMenuCheckboxIndicatorComponent,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuLabel,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import { initialOf } from '@trinity/util/matrix';
import { unreadBadgeLabel } from '../../shared/unread-badge';
import { TrnIconComponent } from '@trinity/components/foundations';

/** Most avatars drawn in the mixed-account stack before it collapses to a "+N" count. */
const STACK_MAX = 3;

/** One signed-in account in the user-panel switcher: the profile plus its unread total. */
export interface AccountSummary extends IdentityProfile {
  /** Unread notification total for this account (drives the switcher badge). */
  unread: number;
}

/** The navigation shell's bottom user panel: the signed-in user plus account switcher. */
@Component({
  selector: 'trn-sidebar-user-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnTooltip,
    AvatarComponent,
    TrnIconComponent,
    TrnDropdownMenuTrigger,
    TrnDropdownMenu,
    TrnDropdownMenuCheckbox,
    TrnDropdownMenuCheckboxIndicatorComponent,
    TrnDropdownMenuItem,
    TrnDropdownMenuItemSubIndicatorComponent,
    TrnDropdownMenuLabel,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuSub,
    TrnDropdownMenuSubTrigger,
  ],
  templateUrl: './sidebar-user-panel.component.html',
  styleUrl: './sidebar-user-panel.component.scss',
})
export class SidebarUserPanelComponent {
  /** The signed-in user (name + handle + avatar) for the panel trigger. */
  readonly user = input<IdentityProfile>({
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
   * Present the account picker as a dialog rather than a submenu.
   *
   * Set by the host from the layout, not read here: this component stays presentational and
   * injects nothing. Below the `md` breakpoint the sidebar is a full-screen page and this
   * panel is a bar across the bottom of the viewport, so a submenu flying out beside the
   * account menu has nowhere to go and lands back on top of it.
   */
  readonly pickAccountsInDialog = input(false);
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
  /** Avatars actually drawn in the stack — capped so the cluster stays inside the footer's
   * fixed 52px budget; the "+N" text carries the rest. */
  readonly stackAvatars = computed(() =>
    this.mixedAccounts().slice(0, STACK_MAX),
  );
  /** Accessible summary of the mixed state; the stack itself is decorative. */
  readonly accountSummaryLabel = computed(() => {
    const mixed = this.mixedAccounts();
    if (mixed.length < 2) {
      return 'Account menu';
    }
    return `Account menu — ${this.user().displayName}, showing ${mixed.length} accounts`;
  });
  /** Gear — open the settings page. */
  readonly openSettings = output<void>();
  readonly hasSystemStatusProblems = input(false);
  readonly openSystemStatus = output<void>();
  /** Show the account picker as a dialog — raised only when {@link pickAccountsInDialog}. */
  readonly openAccountPicker = output<void>();

  /** The user ticked/unticked an account in the "Accounts in view" picker. */
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

  /** First letter of a signed-out account's Matrix ID for its avatar fallback. */
  initialForUserId(userId: string): string {
    return initialOf(userId);
  }
}
