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
} from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type UserProfile } from '@trinity/data-access-profile';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuLabel,
  HlmDropdownMenuSeparator,
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
    HlmDropdownMenuItem,
    HlmDropdownMenuLabel,
    HlmDropdownMenuSeparator,
  ],
  viewProviders: [
    provideIcons({ lucideCheck, lucideLogOut, lucideSettings, lucideUserPlus }),
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
  /** Gear — open the settings page. */
  readonly openSettings = output<void>();
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
}
