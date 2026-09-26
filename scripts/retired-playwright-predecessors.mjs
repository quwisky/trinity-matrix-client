/**
 * Browser and Android-WebView Playwright definitions retired on 2026-09-26 (#839) after
 * their accepted Android Maestro suites replaced them. The retired sources stay verifiable
 * as Git objects at RETIRED_PREDECESSOR_COMMIT, the head of the migration branch when they
 * were retired (also reachable as refs/pull/677/head), so every migration guard keeps
 * pinning the exact predecessor bytes its parity mapping was accepted against.
 *
 * Each entry records one predecessor file at that commit:
 * - `retired`: definitions removed from the working tree.
 * - `desktopOnly`: definitions kept for their desktop-only branches or assertions, now
 *   skipped on Android because the Android suite owns their Android execution.
 * - `deleted`: the file itself is gone because no definition remained.
 *
 * Run `node scripts/retired-playwright-predecessors.mjs fetch` in a clone that lacks the
 * commit (for example a shallow CI checkout) before running the guards.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RETIRED_PREDECESSOR_COMMIT =
  'dd0cb53c0227f5d218d32e80cd6839aa7b0bcbaf';

const workspaceRoot = resolve(import.meta.dirname, '..');

const git = (args, options = {}) =>
  execFileSync('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

/** Whether this clone holds the commit the retired predecessors are pinned at. */
export function hasRetiredPredecessorCommit() {
  try {
    git(['cat-file', '-e', `${RETIRED_PREDECESSOR_COMMIT}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the exact bytes of a retired predecessor file at the pinned commit. The path is
 * repository-relative, for example `e2e/browser/journeys/room-library/room-list.spec.mts`.
 */
export function readRetiredPredecessor(path) {
  try {
    return git(['cat-file', 'blob', `${RETIRED_PREDECESSOR_COMMIT}:${path}`]);
  } catch (error) {
    throw new Error(
      `${path} is unreadable at retired-predecessor commit ${RETIRED_PREDECESSOR_COMMIT}; ` +
        'run `node scripts/retired-playwright-predecessors.mjs fetch` first',
      { cause: error },
    );
  }
}

/** Fetches the pinned commit when this clone lacks it, without deepening a full clone. */
export function fetchRetiredPredecessorCommit() {
  if (hasRetiredPredecessorCommit()) return false;
  const shallow =
    git(['rev-parse', '--is-shallow-repository'], {
      encoding: 'utf8',
    }).trim() === 'true';
  git(
    [
      'fetch',
      '--no-tags',
      ...(shallow ? ['--depth=1'] : []),
      'origin',
      RETIRED_PREDECESSOR_COMMIT,
    ],
    { stdio: 'inherit' },
  );
  return true;
}

export const RETIRED_PREDECESSORS = Object.freeze([
  {
    path: 'e2e/android/app-shell.spec.mts',
    sha256: '03a5478807ffec6c91a999eb1e9cccaa510994b91b5b8484dbfdf620c622bf59',
    issues: [670],
    deleted: true,
    retired: [
      'renders login and protects authenticated routes in the installed app',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/android/navigation.spec.mts',
    sha256: '026f50c0546ab34e5c64f4c59623fc2872a53fcbe67f351ff1f1c519d11bfffb',
    issues: [670],
    deleted: true,
    retired: [
      '@renderer-smoke logs in, opens settings by touch, and handles hardware Back',
      'restores the authenticated route after a native process restart',
      'drills into a section and restores its directory link on hardware Back',
      'dismisses the native keyboard before opening a bounded sheet and handles hardware Back',
      'dismisses members before the compact Conversation on hardware Back',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/android/appearance.spec.mts',
    sha256: 'cec2c6d9ec9d0b5adba05b765abf9d0b1c46371cd91a29f1d43e7d1372b6c8aa',
    issues: [670],
    deleted: true,
    retired: [
      'projects Appearance into the installed WebView and native chrome @native-appearance',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/android/composer-format-native.spec.mts',
    sha256: 'ff53f52a39b66cc029a7f3cdf4961758158da25b4a75117290d15660a6e5f1c2',
    issues: [670],
    deleted: true,
    retired: [
      'formats a selected word through Aa, restores the keyboard, and dismisses on Back',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/accounts/account-lifecycle.spec.mts',
    sha256: '901eef0b1de1c69c63055deb6783be6e51c1321d3a6f9921082eabf59a3cf457',
    issues: [672],
    deleted: false,
    retired: [
      'adds a second account and switches the active account between them',
      'keeps the Workspace coherent through repeated and consecutive switches',
      'signs one account out while the other keeps running',
      're-adds a signed-out account without a crypto-store mismatch',
      'signs the only account out and back in without a crypto-store mismatch',
      'cancels adding an account and returns to the app',
      're-authenticates an account from the /login?reauth prefill',
    ],
    desktopOnly: [
      'the app badge sums unread across accounts, invariant to which is active',
    ],
  },
  {
    path: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts',
    sha256: '0a6df5b48f6f88e0156fe8e9b50084787c5b457b22c347d131f1b754e293556d',
    issues: [672],
    deleted: true,
    retired: [
      'mixed view shows both accounts’ rooms, badged, and opening one switches account',
      'mixed view shows both accounts’ space pills, badged, and opening one switches account',
      'the account mix persists across a reload, locks the active account, and can be turned off',
      'narrow layout picks accounts in a dialog rather than a submenu',
      'the quick switcher finds a mixed-in account’s room and switches to it',
      'shows a mixed-in account’s invite and names the acting identity in the header',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/identity/dm-avatar.spec.mts',
    sha256: '8465e40e4feaefd51b2f676e46a4cc85811f3aeb8436ebc6d0b9012c57123748',
    issues: [674],
    deleted: true,
    retired: ["a DM row shows the other person's picture, not an initial"],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/identity/presence.spec.mts',
    sha256: '2b319c955d7607b987d2de4a028b0f930a21f3e6aeb108a88122f8b56d2f36b6',
    issues: [674],
    deleted: false,
    retired: [
      'shows known presence on member avatars in the member list',
      'shows the other person’s presence on a direct-message row',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/sidebar-filter.spec.mts',
    sha256: '5cbfb4021803a9d1fa2b58d7a093ed6ce8f0195d703e043f8dcc83ca2e1ae1e4',
    issues: [676],
    deleted: true,
    retired: [
      'filters the room list in place, folds accents, and restores on clear',
      'Escape clears the filter without closing anything behind it',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/sidebar-touch.spec.mts',
    sha256: '8b09cba85b29db3e4819462e45b0f074f516198dca8f1733c195722c492f6ebb',
    issues: [687],
    deleted: true,
    retired: [
      'keeps the rail, room, menu and identity-dock controls touch-sized',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/favourite-rooms.spec.mts',
    sha256: '35b1ba6d96033782dfb66e31a67821cb97a81c7bf98d4d729cbab5fd3313a228',
    issues: [688],
    deleted: true,
    retired: [
      'favouriting a room surfaces a Favourites section and moves it to the top; unfavouriting reverses it',
      'demoting a room sinks it under a Low priority section, and favouriting it there pulls it back to the top',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/mark-read.spec.mts',
    sha256: '38d3d95524dcb03cbc36ba0891031e52014ed66a8ff7416df374aa7f2256828b',
    issues: [689],
    deleted: true,
    retired: ['mark all as read clears the unread indicator'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/mark-unread.spec.mts',
    sha256: '43165d7f4fc936d214d54e5410d7876d174e6e61c0c477ed6fa8d398e70963b6',
    issues: [689],
    deleted: true,
    retired: [
      'flags a read room, and opening it clears the flag',
      'a flag set elsewhere arrives, survives a reload, and Mark as read clears it',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/room-list.spec.mts',
    sha256: '122c617df290018bd59fcb57a08ad962e78dbba1230ae87d16d9d3c684112654',
    issues: [690],
    deleted: true,
    retired: [
      'a room row shows avatar, name, and last-message preview instead of a hash',
      'an unread room row shows a muted badge with the unread count, and it clears once opened',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/unread-badges.spec.mts',
    sha256: '88717c4e01c304025b951a359b1cda79a775e92015be2f294639b39490adfae0',
    issues: [691],
    deleted: false,
    retired: ['server-rail Rooms pill shows the aggregated unread count'],
    desktopOnly: ['the platform badge mirrors the unread total'],
  },
  {
    path: 'e2e/browser/journeys/room-library/leave-room.spec.mts',
    sha256: '3ff3a9e93bc430044062948c4e8e6bac67578f5588d68691ac540f46e41b390c',
    issues: [692],
    deleted: false,
    retired: ['leaving a room removes it from the list while others stay'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/recent-activity.spec.mts',
    sha256: 'c2b12540c8b45ace5a7d3e2111c3f00a61ba69555522b5b6212636cb0fc9243c',
    issues: [693],
    deleted: true,
    retired: [
      'is the default view and mixes DMs with rooms; Home and Rooms stay scoped',
      'groups favourites above the rest of the mixed list',
      'includes a space-owned room, which the flat Rooms view excludes',
      'shows the unread total on the Recent pill',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-library/room-filter-spaceless.spec.mts',
    sha256: '0f5d42072c018ef27e6e1c6276f72b209d43b927666149c8e7574c2bc4aefadc',
    issues: [694],
    deleted: false,
    retired: [],
    desktopOnly: [
      'a spaceless room stays in the flat Rooms list; a space child moves under its space pill',
    ],
  },
  {
    path: 'e2e/browser/journeys/room-library/space-curation.spec.mts',
    sha256: '35a2dd1726eef56c03288c64c23885703f3f1d06927870d4eeabac7bf3a51c7b',
    issues: [695],
    deleted: false,
    retired: [
      'an admin creates a space inside a space',
      'a child moves out of More Channels the moment you join it',
    ],
    desktopOnly: ['an admin adds an existing room to a space'],
  },
  {
    path: 'e2e/browser/journeys/room-library/space-room-order.spec.mts',
    sha256: 'b26ae29366d8d470a1f813da9bf9e6b501ec4f49d77d432f1ba7e77606c96705',
    issues: [696],
    deleted: false,
    retired: ['re-orders as a message arrives, without reopening the space'],
    desktopOnly: [
      'defaults to recent activity, and a per-space choice beats the account default',
    ],
  },
  {
    path: 'e2e/browser/journeys/room-library/room-http-error-recovery.spec.mts',
    sha256: 'a9fd9a2f48a03061ceed67a94a2e81104472144683e65650099dba6074042fe6',
    issues: [697],
    deleted: true,
    retired: [
      'retries an outbound room invite after an HTTP failure',
      'retries accepting a room invite after an HTTP failure',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-settings-for-you-mobile.spec.mts',
    sha256: '749dc05f43e01cfcc972bf639b8f83241ed3054220a32d8f32eb5be197cf62c0',
    issues: [698],
    deleted: true,
    retired: [
      'lets an ordinary member stage, protect, and save personal preferences',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-settings-general-mobile.spec.mts',
    sha256: 'aec529aaa1769eddfa28f9f423d93825bb46ebd689e448036b1c168b5db3c310',
    issues: [698],
    deleted: true,
    retired: [
      'opens the directory before General and protects drafts on the full-screen flow',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/space-settings-mobile.spec.mts',
    sha256: 'fd8dcdd0305cdc1ffa2412cf61779c7775cfe7583563be801ba5be5342fdaaf4',
    issues: [699],
    deleted: true,
    retired: [
      'opens the directory before General and protects drafts on the full-screen flow',
      'opens the Members shortcut directly and returns to the directory',
      'keeps a member’s Space General readable without writable controls',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/space-settings-resilience.spec.mts',
    sha256: '97bf56cb47ac1f74911fa73df01d582f1cec4c37f8547e4d609f168fbb9a3091',
    issues: [700],
    deleted: true,
    retired: [
      'retains a partial General failure and retries only the unsaved field',
      'keeps late and subsequent writes on the opening Account after an Account switch',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/space-settings.spec.mts',
    sha256: '662f0fc7c62ba206aa1bd344c1d9ecf913162424c486b97059d252ff7ea30a3a',
    issues: [701],
    deleted: true,
    retired: [
      'an admin renames a space, sets its topic and publishes it',
      'the dialog seeds from the space’s current values',
      'an admin adds, creates, recovers and unlinks exact Space contents',
      'a member without permission sees plain General values without actions',
      'keeps a dirty General edit visible and readonly after permission is lost',
      'an admin publishes an address for the space',
      'Space settings names the creator Owner and an equal-power member Admin',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/space-leave.spec.mts',
    sha256: 'a895c51a4a586f80d1399c31d1a3780d0c20c42534c926e9e53cf41f3fe8ed54',
    issues: [706],
    deleted: true,
    retired: [
      'names the exact Account, cancels safely, and leaves child Room membership intact',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/tombstone.spec.mts',
    sha256: 'ca5563f9d5a4f84db23d7fb7a889da28682fffabf3dedd3b42b2f529d936472b',
    issues: [707],
    deleted: true,
    retired: ['shows the upgrade banner and moves to the successor room'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/report-message.spec.mts',
    sha256: '3f8e9051936b66e5b6ab1112d52f29f95826866bc4277e7ba6d5bdd9ca312b7c',
    issues: [708],
    deleted: false,
    retired: [],
    desktopOnly: ['reports a message to the server admins'],
  },
  {
    path: 'e2e/browser/journeys/room-administration/redact-others.spec.mts',
    sha256: 'b7bb891ccdde3bb829044b6378247971555be539a6a8cd190f7ace323fa78b57',
    issues: [708],
    deleted: false,
    retired: [],
    desktopOnly: ['a room admin can delete another member’s message'],
  },
  {
    path: 'e2e/browser/journeys/room-administration/block-member.spec.mts',
    sha256: '792a6e1d021c5e09661c5847e4fb577044cab1635673151cefd026cf57acfa84',
    issues: [709],
    deleted: true,
    retired: ['blocking a member flips the action to Unblock'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/kick-member.spec.mts',
    sha256: 'e7ab22e420abf9f545c7ad1bb9b637b435cbc9a754759167070ebb38550d2a86',
    issues: [709],
    deleted: false,
    retired: [
      'an admin ${moderation.label} a lower-power member from the visible roster',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/member-info.spec.mts',
    sha256: 'cca86e8d3c5925ff2358e6efbcf229ca4f32095379385d9539698dedd1c2200d',
    issues: [710],
    deleted: true,
    retired: ['clicking a member opens their info panel'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/promote-member.spec.mts',
    sha256: '649c05090a92bf48036530ea3738c55ad40f0ebc06a0200745e48b3b6903f7c3',
    issues: [710],
    deleted: true,
    retired: ['an admin promotes a member to moderator'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/member-roles.spec.mts',
    sha256: '58f0cacf00feb7a2587545b8261164632af83b24e0b839cc4be889af6a52b20f',
    issues: [711, 712],
    deleted: true,
    retired: [
      'groups members under Owner / Moderator / Member headers',
      'a direct message has no owner — both people are equals',
      'the member info panel calls the creator the owner',
      'separates the creator from an admin they promoted',
      're-partitions live when a member is promoted to moderator',
      'disables member actions live when the viewer loses power',
      'shows plain General values after remote demotion',
      'explains a blocked member action after a touch tap',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts',
    sha256: 'f306f5bfffca9f7a476966d7d2ff678a227fa7b2fae6e2f4934fb46c6c218ff5',
    issues: [713, 714, 715],
    deleted: false,
    retired: [
      'an admin unbans a member from the banned list',
      'keeps Room roster, member detail, role changes and live authority in one destination',
      'an admin adds a room address and makes it the main one',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-access-settings.spec.mts',
    sha256: '3ae190d7814f8e3e2fda6640bcbfb77e089b1da8605b11645b7e79c2df0bcb6c',
    issues: [716],
    deleted: true,
    retired: [
      'an admin changes who can join and read history',
      'an admin lets a space’s members join the room',
      'an admin revokes a space’s access by unticking it',
      'a member reads Room policy without a disabled Save footer',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-profile-settings.spec.mts',
    sha256: 'f6ab33a1fc7160efb206c66f064ab158cea1c3969ad6ee5a55b8eb39299d1f96',
    issues: [717],
    deleted: true,
    retired: [
      'an admin renames a room from the settings dialog',
      'an admin changes the room photo',
      'retains a partial General failure and retries only the unsaved field',
      'keeps late and subsequent General writes on the opening Account after a shared-Room switch',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-settings-for-you.spec.mts',
    sha256: '923fe4053badf040b9deaf9beba7da74bc27bf19277af4bb570462fed2c24f88',
    issues: [718],
    deleted: true,
    retired: [
      'shows a failed preference read and retries into the editable form',
      'isolates staged preferences to the opening Account and retries only a failed field',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-settings-widgets-mobile.spec.mts',
    sha256: '41344fee6b5ed35b7f34ae332696fd7be4e25237b923319d5259360721975337',
    issues: [719],
    deleted: true,
    retired: ['keeps every widget and the modal actions reachable'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/room-administration/room-widget-settings.spec.mts',
    sha256: '2047179526d88e7673b846782dd04fa04de1c4385d2f4fd283b89b259cd6bc6e',
    issues: [719],
    deleted: true,
    retired: [
      'embeds a real room widget through a restricted Widget API bridge',
      'the opening admin adds and removes an exact generic widget after an Account switch',
      'widget management follows live power grants and revocations',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/accounts/change-password.spec.mts',
    sha256: 'bc3d99b6a65fd59bd5b0641d94768127692df14f757b7c787c982e466b47b98f',
    issues: [720],
    deleted: true,
    retired: ['rejects a wrong current password, then changes it'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/accounts/clear-all-data.spec.mts',
    sha256: '271c63f2e49f27d7c99d4d0d75c7b844d466d70afe69afda71d1335bcc0b1e9c',
    issues: [721],
    deleted: false,
    retired: ['erases a signed-out install whose settings are wedged'],
    desktopOnly: [
      'erases a signed-in install and restarts into an empty app',
      'stays a legible danger red on ${theme.id}',
    ],
  },
  {
    path: 'e2e/browser/journeys/accounts/registration.spec.mts',
    sha256: 'a22f58f703c185645987ad471c2f8637d2741344be365d5063c8f0b1c37f2dbd',
    issues: [722],
    deleted: true,
    retired: [
      'creates a password account through UIA and enters encryption setup',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/accounts/sso-login.spec.mts',
    sha256: '04bf21437efd4da47398e93df607bf35dbcd8aba00159607a9a95f96ca6e9b12',
    issues: [723],
    deleted: true,
    retired: [
      'signs in through the provider and keeps the session',
      'refuses a callback it cannot verify, and does not spend the token',
      'ignores a forged callback mid-sign-in without breaking the real one',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/accounts/oidc-login.spec.mts',
    sha256: 'e9a0dadad15f155a3c69b49e06d8b4539ea7d7f446fd08cfaa565fa3ba6ecb8a',
    issues: [724],
    deleted: true,
    retired: [
      'offers the provider Continue + Create account and hides password/SSO',
      'builds a PKCE authorize request and surfaces a provider error on the callback',
      'redeems the code with the stashed PKCE verifier',
      'a non-OIDC homeserver still shows the password form',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/trust/security-settings.spec.mts',
    sha256: '7da77f2e6b8d2091709ca6565bd54a08ed97115cce71e887ad1c46b6f5767fd9',
    issues: [725],
    deleted: false,
    retired: ['shows the encryption posture and launches recovery setup'],
    desktopOnly: ['keeps verification nested in the narrow settings surface'],
  },
  {
    path: 'e2e/browser/journeys/trust/recovery-reset.spec.mts',
    sha256: 'fad6cee0f80c92770978a672129c66a1ab22c9a7504a1068970673cbca08b848',
    issues: [726],
    deleted: true,
    retired: [
      'mints a new recovery key for someone who lost theirs',
      'a cancelled password costs the account nothing',
      'leaves the original recovery key working after a cancelled reset',
      'Settings offers the escape hatch to someone who cannot unlock',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/trust/sso-recovery-reset.spec.mts',
    sha256: '4d4a15f2518a40a1845dfa965d03757697be9d9613030d757b2c74004441ed0b',
    issues: [727],
    deleted: true,
    retired: ['refuses the reset and points at the identity provider'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/trust/message-shield.spec.mts',
    sha256: '2ab9ceaa07b78d77aea844127b26ba16c7d9475322a7430a8f422186bafa9c9c',
    issues: [728],
    deleted: true,
    retired: [
      'a message in a plaintext room shows no shield',
      'a shielded message explains itself in a tooltip',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/trust/verify-user.spec.mts',
    sha256: '4d5ddb20adfc9f661abb05f081057894ec6e4120a35ddb5f067dc4158dab6ebd',
    issues: [729],
    deleted: true,
    retired: [
      'starts cross-user verification from the member panel',
      'starts cross-user verification with a delayed counterpart identity',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/composer-drafts.spec.mts',
    sha256: '16088cad5e1ecc4a6933c905b3963b6c46fa5cf5ffe9be82439269b22a0730cd',
    issues: [730],
    deleted: true,
    retired: ['keeps a per-room draft across room switches and a reload'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/composer-formatting.spec.mts',
    sha256: '3e346da10d6b38c10928a824333f050916009fddffd3215331d4bcf723672b8c',
    issues: [731],
    deleted: false,
    retired: [
      'uses a bounded touch action sheet and applies selected text',
      'cancels and previews on mobile without losing the selected text',
      'keeps Format and Send reachable at compact width with larger text',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/composer-mentions.spec.mts',
    sha256: '4fff4a23bbabe797ca87e8ed8b2fdda537e4af1adb4c5396cbb3d0feccd4eb39',
    issues: [732],
    deleted: true,
    retired: [
      'autocompletes a member and sends a pinging mention',
      'accepts a mention with the keyboard',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/composer-reactions.spec.mts',
    sha256: '00f7444b5646cc445139b8911fb6c39f59abd3a0a42552a7fd1482ab9f25ed6a',
    issues: [733],
    deleted: false,
    retired: ['opens and closes the composer’s own picker from its button'],
    desktopOnly: ['reacts with an emoji chosen from the full picker'],
  },
  {
    path: 'e2e/browser/journeys/conversations/composer-typing.spec.mts',
    sha256: '721a2dd22902ad0683c95b95e819ec3519c22b9d362b3c58a9893e60ec229f8f',
    issues: [734],
    deleted: true,
    retired: [
      "shows and clears another member's typing",
      'reserves the typing row space whether or not anyone is typing',
      'holds one line when the name is too long for the row',
      'the dots are actually animating',
      'reduced motion rests the dots at full opacity',
      'shows the typist in the room list',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/gif.spec.mts',
    sha256: 'c2196e638e21cedec16ae04d45823d9893d1586d7597ec41b1665f32062ac3ad',
    issues: [735],
    deleted: true,
    retired: [
      'configures a GIF provider + API key in Settings and can clear it',
      'omits GIF from the tray until a provider is configured',
      'searches GIFs and sends the chosen one as an image message',
      'sends a GIF as the active account after an account switch',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/hide-system-messages.spec.mts',
    sha256: 'f1f88eb542b48cfa461132a730b7fea1120977d771ade96565d0ae5fb64329c0',
    issues: [736],
    deleted: true,
    retired: ['hiding joins removes the system line but keeps the messages'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/jump-to-date.spec.mts',
    sha256: '99a1ae1ec8873d2a45795003604d9c83c162d5d33c5415899e41581e97d4fd04',
    issues: [737],
    deleted: false,
    retired: ['pages history back to reach a message that was not loaded'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/jump-to-latest.spec.mts',
    sha256: '1ecfdf0aad6c13326b81b0103bc7f9793f4754438a77bc8098060910c01e3209',
    issues: [738],
    deleted: false,
    retired: [],
    desktopOnly: [
      'offers a jump-to-latest pill after scrolling up and returns to the bottom',
    ],
  },
  {
    path: 'e2e/browser/journeys/conversations/link-preview.spec.mts',
    sha256: '08282733e2a496677fda5b9c03738b571714f838d49a93a36fbaf16eb38e7da4',
    issues: [739],
    deleted: true,
    retired: ['shows an Open-Graph card for a link in an unencrypted room'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/location-share.spec.mts',
    sha256: '86e673e5bd86e014a6f5ee4b4eb1da11eb979013b6629a452153367405e76244',
    issues: [740],
    deleted: false,
    retired: [],
    desktopOnly: ['shares the current location as a map card'],
  },
  {
    path: 'e2e/browser/journeys/conversations/media-retention.spec.mts',
    sha256: '8de218b97b33dbd0513e9b93d21812120d3afa0ecc10e37e530fe265f6f18fc6',
    issues: [741],
    deleted: true,
    retired: [
      'reloads plaintext and encrypted images after A to B to A navigation',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-action-sheet.spec.mts',
    sha256: 'df1d0bdb6a3ea0e2b16227d26b00b5b8138485cfba27b8ee4782945c22cb91aa',
    issues: [742],
    deleted: true,
    retired: [
      'a long press opens a sheet, and picking Reply starts a reply',
      'reacting from the sheet puts the reaction on the message',
      'tapping outside closes the sheet without acting',
      'keeps a windowed target connected and restores the latest state on close',
      'keeps the acted-on thread reply above the same sheet',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-edit-history.spec.mts',
    sha256: '66b251c72f0939a9913fb31641107f500d22cf627ff7b566740e15e744c37153',
    issues: [743],
    deleted: false,
    retired: [
      'shows every version of an edited message, oldest first',
      'renders the history as a fullscreen, touch-sized surface',
    ],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-forward.spec.mts',
    sha256: '4776cbb08bea3b92eb5d0e2203b50b77261e4e3191acad94595b5db2f190fcd3',
    issues: [744],
    deleted: false,
    retired: [],
    desktopOnly: ['forwards a message to another room'],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-grouping.spec.mts',
    sha256: '9cdd8dcd5722dabe4783b9f045bcff56ab4c50adfce51f2ce9ba8e33884dd05f',
    issues: [745],
    deleted: false,
    retired: [],
    desktopOnly: ['grouped messages line up with the first of their group'],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-linkify.spec.mts',
    sha256: 'dd48aadd26ab1d960077d71ad68cd4ee8bf9b836706b4beb4620a34e7f7551a3',
    issues: [746],
    deleted: true,
    retired: ['renders a bare URL in a message as a clickable link'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-links.spec.mts',
    sha256: '513b7f01b026991d316479edf06caef9754e70cc0df157a37436a67982aeb400',
    issues: [747],
    deleted: false,
    retired: [
      'a joined room previews before an explicit Open',
      'previews and joins a public room across real federation',
      'shows a useful unavailable state for an inaccessible remote room',
      'keeps a rejected federated Join open and retryable',
      'keeps the sheet and its action footer reachable',
    ],
    desktopOnly: ['clicking a mention shows a user card, not an empty room'],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-markdown.spec.mts',
    sha256: '128f6ae2660c02a9f6e0d64726999ead4960454b66cb369306f9f27b3bb0baa8',
    issues: [748],
    deleted: false,
    retired: [
      'renders formatting, keeps line breaks, and only sends HTML when it means something',
      'renders a task list as glyphs rather than dropping it',
    ],
    desktopOnly: ['keeps the language caption clear of the hover toolbar'],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-poll.spec.mts',
    sha256: 'e23c045d237ba9fde15eb5a39d24479dfc2019e07579142c9193a8dc05ea1674',
    issues: [749],
    deleted: true,
    retired: ['creates a poll, votes, and ends it'],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-quote.spec.mts',
    sha256: '50b0e8a42aa1d61ee59b1c5dce97664365977aef7bc8b36aa3502e23e731064f',
    issues: [750],
    deleted: false,
    retired: [],
    desktopOnly: [
      'pulls a message into the composer as a > block and sends it as a blockquote',
      'offers no Quote for a message with no text to bring',
    ],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-receipts.spec.mts',
    sha256: '5d4d757364c6b5b1a5a0e148c8c17adf173296bb2f435730d2803ed7854baa42',
    issues: [751],
    deleted: true,
    retired: ["shows a reader's avatar on the message they read"],
    desktopOnly: [],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-source.spec.mts',
    sha256: '1a18b0772645d8d1a9cfeb38c8f620f53f37c818543d32b044a7c48be0151ca6',
    issues: [752],
    deleted: false,
    retired: [],
    desktopOnly: ['shows an event’s raw JSON in the view-source dialog'],
  },
  {
    path: 'e2e/browser/journeys/conversations/message-spoiler.spec.mts',
    sha256: 'd89c5751a43ac54b44329e2d65b9e7b0db2974118f6198d2fff1d6f0d050f673',
    issues: [753],
    deleted: true,
    retired: ['conceals a spoiler and reveals it on click'],
    desktopOnly: [],
  },
]);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] !== 'fetch') {
    console.error(
      'usage: node scripts/retired-playwright-predecessors.mjs fetch',
    );
    process.exit(2);
  }
  fetchRetiredPredecessorCommit();
}
