import { inject, type EnvironmentProviders } from '@angular/core';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_MAX_HIGHLIGHT_LINES,
  DEFAULT_TIME_FORMAT,
  TRINITY_DATE_FORMATS,
  TRINITY_TIME_FORMATS,
  isDateFormat,
  isTimeFormat,
} from '@trinity/util/matrix';
import {
  CodeHighlightSettingsService,
  MAX_HIGHLIGHT_LINES_CEILING,
  isMaxHighlightLines,
} from './code-highlight-settings.service';
import { provideConfigEntries, type ConfigEntry } from './config-schema';
import {
  boundedNumberSetting,
  choiceSetting,
  flagSetting,
  numberSetting,
} from './config-validation';
import {
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  RIGHT_PANEL_WIDTH_BOUNDS,
  SIDEBAR_WIDTH_BOUNDS,
  ShellLayoutService,
} from './shell-layout.service';
import {
  ComposerSettingsService,
  DEFAULT_FORMAT_ON_SELECTION,
  DEFAULT_SHOW_FORMATTING_TOOLBAR,
} from './composer-settings.service';
import { DateTimeFormatService } from './date-time-format.service';
import {
  DEFAULT_SWIPE_ACTION,
  MessageGestureSettingsService,
  TRINITY_SWIPE_ACTIONS,
  isSwipeAction,
} from './message-gesture-settings.service';
import {
  DEFAULT_VIRTUAL_TIMELINE,
  FeatureFlagsService,
} from './feature-flags.service';
import {
  DEFAULT_LINK_PREVIEWS,
  DEFAULT_LINK_PREVIEWS_IN_ENCRYPTED,
  DEFAULT_SEND_READ_RECEIPTS,
  PrivacySettingsService,
} from './privacy-settings.service';
import { KeyboardShortcutsService } from './shortcuts/keyboard-shortcuts.service';
import { shortcutOverridesEntry } from './shortcuts/shortcut-overrides-config';
import {
  DEFAULT_SHOW_MEMBERSHIP,
  DEFAULT_SHOW_PROFILE,
  DEFAULT_SHOW_ROOM_CHANGES,
  SystemLineSettingsService,
} from './system-line-settings.service';
import {
  DEFAULT_CODE_LINE_MODE,
  DEFAULT_CODE_SCALE,
  DEFAULT_PALETTE,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SCALE,
  DEFAULT_THEME_PREFERENCE,
  TRINITY_CODE_LINE_MODES,
  TRINITY_CODE_SCALES,
  TRINITY_PALETTES,
  TRINITY_DENSITIES,
  TRINITY_TEXT_SCALES,
  TRINITY_THEME_MODES,
  ThemeService,
  isCodeLineMode,
  isCodeScale,
  isPalette,
  isDensity,
  isTextScale,
  isThemePreference,
} from './theme.service';

/** The offered ids of a catalogue, for the "expected …" half of a rejection. */
function idsOf(options: readonly { readonly id: string }[]): readonly string[] {
  return options.map((option) => option.id);
}

/**
 * The settings `platform-native` owns, for the config export.
 *
 * Every `read` is a signal getter and every `reset`/`write` a public setter, so the document
 * matches what is on screen and applying one moves the app immediately — see
 * {@link ConfigEntry}. Every `validate` is built from the guard the owning service already
 * uses on the way in from storage, so a pasted value is held to exactly that standard.
 */
export function providePlatformConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => [
    ...themeEntries(inject(ThemeService)),
    ...shellEntries(inject(ShellLayoutService)),
    ...codeHighlightEntries(inject(CodeHighlightSettingsService)),
    ...privacyEntries(inject(PrivacySettingsService)),
    ...timelineEntries(inject(SystemLineSettingsService)),
    ...formatEntries(inject(DateTimeFormatService)),
    ...composerEntries(inject(ComposerSettingsService)),
    ...gestureEntries(inject(MessageGestureSettingsService)),
    ...flagEntries(inject(FeatureFlagsService)),
    ...shortcutEntries(inject(KeyboardShortcutsService)),
  ]);
}

function themeEntries(theme: ThemeService): readonly ConfigEntry[] {
  return [
    {
      path: 'theme.mode',
      key: 'trinity.theme',
      description:
        'Whether the app follows your system theme, or is always light or always dark.',
      read: () => theme.preference(),
      reset: () => theme.setPreference(DEFAULT_THEME_PREFERENCE),
      ...choiceSetting({
        isValid: isThemePreference,
        options: TRINITY_THEME_MODES,
        noun: 'a theme mode',
        set: (value) => theme.setPreference(value),
      }),
    },
    {
      path: 'theme.palette',
      key: 'trinity.palette',
      description: 'The accent colour the whole app is themed from.',
      read: () => theme.palette(),
      reset: () => theme.setPalette(DEFAULT_PALETTE),
      ...choiceSetting({
        isValid: isPalette,
        options: idsOf(TRINITY_PALETTES),
        noun: 'a known palette',
        set: (value) => theme.setPalette(value),
      }),
    },
    {
      path: 'theme.textScale',
      key: 'trinity.text-scale',
      description: 'How large text is throughout the app.',
      read: () => theme.textScale(),
      reset: () => theme.setTextScale(DEFAULT_TEXT_SCALE),
      ...choiceSetting({
        isValid: isTextScale,
        options: idsOf(TRINITY_TEXT_SCALES),
        noun: 'a text size',
        set: (value) => theme.setTextScale(value),
      }),
    },
    {
      path: 'theme.density',
      key: 'trinity.density',
      description: 'How much room the app leaves around things.',
      read: () => theme.density(),
      reset: () => theme.setDensity(DEFAULT_DENSITY),
      ...choiceSetting({
        isValid: isDensity,
        options: idsOf(TRINITY_DENSITIES),
        noun: 'a density',
        set: (value) => theme.setDensity(value),
      }),
    },
    {
      path: 'theme.codeScale',
      key: 'trinity.code-scale',
      description:
        'How large text is inside code blocks, set separately from the rest.',
      read: () => theme.codeScale(),
      reset: () => theme.setCodeScale(DEFAULT_CODE_SCALE),
      ...choiceSetting({
        isValid: isCodeScale,
        options: idsOf(TRINITY_CODE_SCALES),
        noun: 'a code size',
        set: (value) => theme.setCodeScale(value),
      }),
    },
    {
      path: 'theme.codeLineNumbers',
      key: 'trinity.code-lines',
      description: 'When code blocks show line numbers down the side.',
      read: () => theme.codeLines(),
      reset: () => theme.setCodeLines(DEFAULT_CODE_LINE_MODE),
      ...choiceSetting({
        isValid: isCodeLineMode,
        options: idsOf(TRINITY_CODE_LINE_MODES),
        noun: 'a line-number mode',
        set: (value) => theme.setCodeLines(value),
      }),
    },
  ];
}

/** The rooms shell's draggable pane widths. */
function shellEntries(shell: ShellLayoutService): readonly ConfigEntry[] {
  return [
    {
      path: 'shell.sidebarWidth',
      key: 'trinity.shell.sidebar-width',
      description:
        'Width of the rail and room-list column, in pixels. Drag its edge in the app.',
      read: () => shell.sidebarWidth(),
      reset: () => shell.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH),
      ...boundedNumberSetting({
        ...SIDEBAR_WIDTH_BOUNDS,
        noun: `a width between ${SIDEBAR_WIDTH_BOUNDS.min} and ${SIDEBAR_WIDTH_BOUNDS.max} pixels`,
        set: (value) => shell.setSidebarWidth(value),
      }),
    },
    {
      path: 'shell.rightPanelWidth',
      key: 'trinity.shell.right-panel-width',
      description:
        'Width of the right-hand panel — threads, pinned messages, search — in pixels.',
      read: () => shell.rightPanelWidth(),
      reset: () => shell.setRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH),
      ...boundedNumberSetting({
        ...RIGHT_PANEL_WIDTH_BOUNDS,
        noun: `a width between ${RIGHT_PANEL_WIDTH_BOUNDS.min} and ${RIGHT_PANEL_WIDTH_BOUNDS.max} pixels`,
        set: (value) => shell.setRightPanelWidth(value),
      }),
    },
  ];
}

/**
 * Grouped under `theme.` with the other two code settings even though a different service
 * owns it: the exported document is read by a person, and the three belong together on the
 * page they are set on.
 */
function codeHighlightEntries(
  code: CodeHighlightSettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'theme.codeHighlightLines',
      key: 'trinity.code-highlight-lines',
      description:
        'The most lines of code in one message Trinity will colour, or 0 for no limit.',
      read: () => code.maxHighlightLines(),
      reset: () => code.setMaxHighlightLines(DEFAULT_MAX_HIGHLIGHT_LINES),
      ...numberSetting({
        isValid: isMaxHighlightLines,
        noun: 'a highlighting limit',
        expected: `a whole number of lines from 0 to ${MAX_HIGHLIGHT_LINES_CEILING}, where 0 means no limit`,
        set: (value) => code.setMaxHighlightLines(value),
      }),
    },
  ];
}

function privacyEntries(
  privacy: PrivacySettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'privacy.sendReadReceipts',
      key: 'trinity.privacy.send-read-receipts',
      description: 'Whether reading a message tells the room that you read it.',
      read: () => privacy.sendReadReceipts(),
      reset: () => privacy.setSendReadReceipts(DEFAULT_SEND_READ_RECEIPTS),
      ...flagSetting((on) => privacy.setSendReadReceipts(on)),
    },
    {
      path: 'privacy.linkPreviews',
      key: 'trinity.privacy.link-previews',
      description:
        'Whether links in messages are expanded into previews fetched by your homeserver.',
      read: () => privacy.linkPreviews(),
      reset: () => privacy.setLinkPreviews(DEFAULT_LINK_PREVIEWS),
      ...flagSetting((on) => privacy.setLinkPreviews(on)),
    },
    {
      path: 'privacy.linkPreviewsInEncryptedRooms',
      key: 'trinity.privacy.link-previews-encrypted',
      description:
        'Whether link previews are fetched in encrypted rooms too, where asking for one tells your homeserver a link was sent.',
      read: () => privacy.linkPreviewsInEncrypted(),
      reset: () =>
        privacy.setLinkPreviewsInEncrypted(DEFAULT_LINK_PREVIEWS_IN_ENCRYPTED),
      ...flagSetting((on) => privacy.setLinkPreviewsInEncrypted(on)),
    },
  ];
}

function timelineEntries(
  lines: SystemLineSettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'timeline.showMembership',
      key: 'trinity.timeline.show-membership',
      description:
        'Whether joins, leaves, invites and kicks appear as lines in the timeline.',
      read: () => lines.showMembership(),
      reset: () => lines.setShowMembership(DEFAULT_SHOW_MEMBERSHIP),
      ...flagSetting((on) => lines.setShowMembership(on)),
    },
    {
      path: 'timeline.showProfile',
      key: 'trinity.timeline.show-profile',
      description:
        'Whether display-name and avatar changes appear as lines in the timeline.',
      read: () => lines.showProfile(),
      reset: () => lines.setShowProfile(DEFAULT_SHOW_PROFILE),
      ...flagSetting((on) => lines.setShowProfile(on)),
    },
    {
      path: 'timeline.showRoomChanges',
      key: 'trinity.timeline.show-room-changes',
      description:
        'Whether room name, topic and avatar changes appear as lines in the timeline.',
      read: () => lines.showRoomChanges(),
      reset: () => lines.setShowRoomChanges(DEFAULT_SHOW_ROOM_CHANGES),
      ...flagSetting((on) => lines.setShowRoomChanges(on)),
    },
  ];
}

function formatEntries(format: DateTimeFormatService): readonly ConfigEntry[] {
  return [
    {
      path: 'format.time',
      key: 'trinity.format.time',
      description: 'How times of day are written.',
      read: () => format.timeFormat(),
      reset: () => format.setTimeFormat(DEFAULT_TIME_FORMAT),
      ...choiceSetting({
        isValid: isTimeFormat,
        options: idsOf(TRINITY_TIME_FORMATS),
        noun: 'a clock format',
        set: (value) => format.setTimeFormat(value),
      }),
    },
    {
      path: 'format.date',
      key: 'trinity.format.date',
      description: 'How dates are written.',
      read: () => format.dateFormat(),
      reset: () => format.setDateFormat(DEFAULT_DATE_FORMAT),
      ...choiceSetting({
        isValid: isDateFormat,
        options: idsOf(TRINITY_DATE_FORMATS),
        noun: 'a date format',
        set: (value) => format.setDateFormat(value),
      }),
    },
  ];
}

function composerEntries(
  composer: ComposerSettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'composer.showFormattingToolbar',
      key: 'trinity.composer.show-toolbar',
      // Reworded, because the behaviour it names changed: the bar can now also appear on
      // demand, so "shows its formatting toolbar" would no longer say which of the two this
      // is. The key and the path are unchanged, so an exported config keeps working.
      description:
        'Whether the message box keeps its formatting toolbar pinned open.',
      read: () => composer.showFormattingToolbar(),
      reset: () =>
        composer.setShowFormattingToolbar(DEFAULT_SHOW_FORMATTING_TOOLBAR),
      ...flagSetting((on) => composer.setShowFormattingToolbar(on)),
    },
    {
      path: 'composer.formatOnSelection',
      key: 'trinity.composer.format-on-selection',
      description:
        'Whether selecting text raises the formatting toolbar while it is unpinned.',
      read: () => composer.formatOnSelection(),
      reset: () => composer.setFormatOnSelection(DEFAULT_FORMAT_ON_SELECTION),
      ...flagSetting((on) => composer.setFormatOnSelection(on)),
    },
  ];
}

/**
 * A top-level `gestures` group, which is new to the exported document.
 *
 * It is not filed under `composer` or `theme` because it is neither: this describes how the
 * app reads a touch, and the next such preference (a pull-to-refresh, a two-finger anything)
 * belongs beside it rather than wherever it happened to be implemented.
 */
function gestureEntries(
  gestures: MessageGestureSettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'gestures.messageSwipe',
      key: 'trinity.message-swipe',
      description:
        'Which way a message is dragged to edit or reply to it, or off.',
      read: () => gestures.messageSwipe(),
      reset: () => gestures.setMessageSwipe(DEFAULT_SWIPE_ACTION),
      ...choiceSetting({
        isValid: isSwipeAction,
        options: idsOf(TRINITY_SWIPE_ACTIONS),
        noun: 'a swipe direction',
        set: (value) => gestures.setMessageSwipe(value),
      }),
    },
  ];
}

function flagEntries(flags: FeatureFlagsService): readonly ConfigEntry[] {
  return [
    {
      path: 'flags.virtualTimeline',
      key: 'trinity.flags.virtual-timeline',
      description:
        'Whether long timelines render only the rows on screen, keeping big rooms fast.',
      read: () => flags.virtualTimeline(),
      reset: () => flags.setVirtualTimeline(DEFAULT_VIRTUAL_TIMELINE),
      ...flagSetting((on) => flags.setVirtualTimeline(on)),
    },
  ];
}

/**
 * The shortcut overrides, whose read, checks and write live beside the service that owns
 * them — the only setting here whose value is a map the user writes freely, and the one the
 * issue singles out as reaching `resolve` unchecked.
 */
function shortcutEntries(
  shortcuts: KeyboardShortcutsService,
): readonly ConfigEntry[] {
  return [shortcutOverridesEntry(shortcuts)];
}
