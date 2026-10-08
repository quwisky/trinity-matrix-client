import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TitleBarState } from '@trinity/application/workspace';
import { AvatarComponent, TrnBadge } from '@trinity/components/generic-content';
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
import { type PresenceState, initialOf } from '@trinity/util/matrix';
import { AccountPickLabelComponent } from '../../shared/account-pick-label/account-pick-label.component';
import { unreadBadgeLabel } from '../../shared/unread-badge';
import { TrnIconComponent } from '@trinity/components/foundations';

/** One signed-in account in the user-panel switcher: the profile plus its unread total. */
export interface AccountSummary extends IdentityProfile {
  /** Unread notification total for this account (drives the switcher badge). */
  unread: number;
}

/** The navigation shell's bottom user panel: the signed-in user plus account switcher. */
const PRESENCE_NAMES = {
  online: 'online',
  unavailable: 'away',
  offline: 'offline',
} satisfies Record<PresenceState, string>;

@Component({
  selector: 'trn-sidebar-user-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AccountPickLabelComponent,
    TrnButton,
    TrnTooltip,
    TrnBadge,
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
  /** The desktop title row carries system status itself, so the panel then drops it. */
  protected readonly titleBar = inject(TitleBarState);

  /** The signed-in user (name + handle + avatar) for the panel trigger. */
  readonly user = input<IdentityProfile>({
    userId: '',
    displayName: '',
    avatarMxc: null,
  });
  /** The signed-in user's presence for the avatar dot; null (unknown) draws no dot. */
  readonly presence = input<PresenceState | null>(null);
  /** First letter of the display name, for the avatar fallback. */
  readonly userInitial = computed(() => initialOf(this.user().displayName));
  /** Every signed-in account, for the switcher list. */
  readonly accounts = input<AccountSummary[]>([]);
  /** The user id of the account currently in view (marked with a check). */
  readonly activeUserId = input<string | null>(null);
  /** User ids of accounts the server signed out that need re-authentication. */
  readonly reauthAccounts = input<readonly string[]>([]);
  /**
   * The accounts the room list currently draws from. Drives the picker's ticks; defaults to empty so the panel renders standalone.
   */
  readonly shownAccountIds = input<ReadonlySet<string>>(new Set());

  /**
   * Present the account picker as a dialog rather than a submenu.
   *
   * Set by the host from the layout, not read here: this component stays presentational
   * (its only injection is the title-bar state). Below the `md` breakpoint the sidebar is a full-screen page and this
   * panel is a bar across the bottom of the viewport, so a submenu flying out beside the
   * account menu has nowhere to go and lands back on top of it.
   */
  readonly pickAccountsInDialog = input(false);
  /** The picker is only meaningful with more than one account signed in. */
  readonly canPickAccounts = computed(() => this.accounts().length > 1);
  /** Signed-in accounts besides the one in view; the "+N" chip shows when above zero. */
  readonly otherAccountCount = computed(() =>
    Math.max(this.accounts().length - 1, 0),
  );
  /** Names the chip with its visible "+N", so the label contains the text. */
  readonly otherAccountsLabel = computed(() => {
    const count = this.otherAccountCount();
    return `${count} more account${count === 1 ? '' : 's'}`;
  });
  /** Starts with the visible name (label in name), then presence and the mixed state. */
  readonly accountSummaryLabel = computed(() => {
    const shown = this.shownAccountIds().size;
    const presence = this.presence();
    return [
      this.user().displayName || 'Account menu',
      presence && PRESENCE_NAMES[presence],
      shown >= 2 && `showing ${shown} accounts`,
    ]
      .filter(Boolean)
      .join(', ');
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
