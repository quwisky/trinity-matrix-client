import { provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideArrowDownWideNarrow,
  lucideArrowLeft,
  lucideBell,
  lucideBellOff,
  lucideBold,
  lucideBraces,
  lucideCalendarSearch,
  lucideCamera,
  lucideCheck,
  lucideCheckCheck,
  lucideChevronDown,
  lucideChevronRight,
  lucideChevronUp,
  lucideCircleDot,
  lucideCircleMinus,
  lucideClock,
  lucideCloudOff,
  lucideCode,
  lucideCommand,
  lucideCopy,
  lucideCrown,
  lucideDoorOpen,
  lucideDownload,
  lucideEllipsis,
  lucideEllipsisVertical,
  lucideEye,
  lucideEyeOff,
  lucideFlag,
  lucideFlaskConical,
  lucideFolderPlus,
  lucideForward,
  lucideHouse,
  lucideImage,
  lucideImagePlay,
  lucideItalic,
  lucideKeyRound,
  lucideKeyboard,
  lucideLayers,
  lucideLink,
  lucideList,
  lucideListOrdered,
  lucideListTodo,
  lucideLoaderCircle,
  lucideLocateFixed,
  lucideLock,
  lucideLogOut,
  lucideMail,
  lucideMailOpen,
  lucideMapPin,
  lucideMessageSquare,
  lucideMessagesSquare,
  lucideMic,
  lucideMonitorSmartphone,
  lucidePalette,
  lucidePaperclip,
  lucidePause,
  lucidePencil,
  lucidePin,
  lucidePinOff,
  lucidePlay,
  lucidePlus,
  lucideQuote,
  lucideReply,
  lucideRotateCcw,
  lucideSearch,
  lucideSend,
  lucideServer,
  lucideSettings,
  lucideShield,
  lucideShieldAlert,
  lucideShieldCheck,
  lucideShieldQuestion,
  lucideSmile,
  lucideSquareCode,
  lucideStar,
  lucideStrikethrough,
  lucideTextQuote,
  lucideTrash2,
  lucideUser,
  lucideUserPlus,
  lucideUsers,
  lucideVote,
  lucideX,
} from '@ng-icons/lucide';
import type { TrnIconName } from './trn-icon-name';

/**
 * The one place Trinity names a vendor icon.
 *
 * Typed `Record<TrnIconName, string>` on purpose: a name added to the union without a
 * mapping is a compile error, and a mapping without a name is too, so the two cannot drift.
 * This file and the component beside it are the only importers of `@ng-icons/*` outside the
 * vendored kit — `eslint.config.mjs` enforces that, and `lint-invariants.spec.mjs` proves
 * the rule is still applied.
 */
export const TRN_ICONS: Record<TrnIconName, string> = {
  archive: lucideArchive,
  'arrow-down-wide-narrow': lucideArrowDownWideNarrow,
  'arrow-left': lucideArrowLeft,
  bell: lucideBell,
  'bell-off': lucideBellOff,
  bold: lucideBold,
  braces: lucideBraces,
  'calendar-search': lucideCalendarSearch,
  camera: lucideCamera,
  check: lucideCheck,
  'check-check': lucideCheckCheck,
  'chevron-down': lucideChevronDown,
  'chevron-right': lucideChevronRight,
  'chevron-up': lucideChevronUp,
  'circle-dot': lucideCircleDot,
  'circle-minus': lucideCircleMinus,
  clock: lucideClock,
  'cloud-off': lucideCloudOff,
  code: lucideCode,
  command: lucideCommand,
  copy: lucideCopy,
  crown: lucideCrown,
  'door-open': lucideDoorOpen,
  download: lucideDownload,
  ellipsis: lucideEllipsis,
  'ellipsis-vertical': lucideEllipsisVertical,
  eye: lucideEye,
  'eye-off': lucideEyeOff,
  flag: lucideFlag,
  'flask-conical': lucideFlaskConical,
  'folder-plus': lucideFolderPlus,
  forward: lucideForward,
  house: lucideHouse,
  image: lucideImage,
  'image-play': lucideImagePlay,
  italic: lucideItalic,
  'key-round': lucideKeyRound,
  keyboard: lucideKeyboard,
  layers: lucideLayers,
  link: lucideLink,
  list: lucideList,
  'list-ordered': lucideListOrdered,
  'list-todo': lucideListTodo,
  'loader-circle': lucideLoaderCircle,
  'locate-fixed': lucideLocateFixed,
  lock: lucideLock,
  'log-out': lucideLogOut,
  mail: lucideMail,
  'mail-open': lucideMailOpen,
  'map-pin': lucideMapPin,
  'message-square': lucideMessageSquare,
  'messages-square': lucideMessagesSquare,
  mic: lucideMic,
  'monitor-smartphone': lucideMonitorSmartphone,
  palette: lucidePalette,
  paperclip: lucidePaperclip,
  pause: lucidePause,
  pencil: lucidePencil,
  pin: lucidePin,
  'pin-off': lucidePinOff,
  play: lucidePlay,
  plus: lucidePlus,
  quote: lucideQuote,
  reply: lucideReply,
  'rotate-ccw': lucideRotateCcw,
  search: lucideSearch,
  send: lucideSend,
  server: lucideServer,
  settings: lucideSettings,
  shield: lucideShield,
  'shield-alert': lucideShieldAlert,
  'shield-check': lucideShieldCheck,
  'shield-question': lucideShieldQuestion,
  smile: lucideSmile,
  'square-code': lucideSquareCode,
  star: lucideStar,
  strikethrough: lucideStrikethrough,
  'text-quote': lucideTextQuote,
  'trash-2': lucideTrash2,
  user: lucideUser,
  'user-plus': lucideUserPlus,
  users: lucideUsers,
  vote: lucideVote,
  x: lucideX,
};

/**
 * Registers every Trinity icon once, at the app root.
 *
 * Replaces 32 per-component `provideIcons({…})` calls, each of which re-declared the subset
 * its own component happened to use — so an icon rendered fine in one component and silently
 * nowhere in another. Measured before this change: all icons already resolved into the eager
 * `main` chunk, so central registration is size-neutral rather than a regression.
 */
export function provideTrnIcons(): ReturnType<typeof provideIcons> {
  // Registered under camelCase keys, deliberately, even though our vocabulary is kebab.
  //
  // NgIcon does NOT look up the name it was given: it runs it through `toPropertyName()`
  // first (kebab/any-separator -> lowerCamelCase, ng-icons-core.mjs:333) and looks up
  // *that*. So a literal 'shield-alert' key is searched for as 'shieldAlert' and misses —
  // silently. The icon renders nothing, no error is thrown, and only a console line says
  // so. Registering pre-normalised keys is what makes the kebab vocabulary work at all.
  return provideIcons(
    Object.fromEntries(
      Object.entries(TRN_ICONS).map(([name, svg]) => [
        toPropertyName(name),
        svg,
      ]),
    ),
  );
}

/**
 * Mirrors NgIcon's own name normalisation (`ng-icons-core.mjs:333`). Duplicated rather
 * than imported because the vendor does not export it; `trn-icon.component.spec.ts`
 * renders a hyphenated icon and asserts an actual `<svg>` appears, so the two cannot
 * drift apart without a test failing.
 */
function toPropertyName(name: string): string {
  return name
    .replace(/([^a-zA-Z0-9])+(.)?/g, (_, __, chr: string | undefined) =>
      chr ? chr.toUpperCase() : '',
    )
    .replace(/[^a-zA-Z\d]/g, '')
    .replace(/^([A-Z])/, (m) => m.toLowerCase());
}
