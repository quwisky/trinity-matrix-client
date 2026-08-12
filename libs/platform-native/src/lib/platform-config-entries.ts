import { inject, type EnvironmentProviders } from '@angular/core';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIME_FORMAT,
  TRINITY_DATE_FORMATS,
  TRINITY_TIME_FORMATS,
  isDateFormat,
  isTimeFormat,
} from '@trinity/util/matrix';
import { provideConfigEntries, type ConfigEntry } from './config-schema';
import { choiceSetting, flagSetting } from './config-validation';
import {
  ComposerSettingsService,
  DEFAULT_SHOW_FORMATTING_TOOLBAR,
} from './composer-settings.service';
import { DateTimeFormatService } from './date-time-format.service';
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
  DEFAULT_TEXT_SCALE,
  DEFAULT_THEME_PREFERENCE,
  TRINITY_CODE_LINE_MODES,
  TRINITY_CODE_SCALES,
  TRINITY_PALETTES,
  TRINITY_TEXT_SCALES,
  TRINITY_THEME_MODES,
  ThemeService,
  isCodeLineMode,
  isCodeScale,
  isPalette,
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
    ...privacyEntries(inject(PrivacySettingsService)),
    ...timelineEntries(inject(SystemLineSettingsService)),
    ...formatEntries(inject(DateTimeFormatService)),
    ...composerEntries(inject(ComposerSettingsService)),
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
      description: 'Whether the message box shows its formatting toolbar.',
      read: () => composer.showFormattingToolbar(),
      reset: () =>
        composer.setShowFormattingToolbar(DEFAULT_SHOW_FORMATTING_TOOLBAR),
      ...flagSetting((on) => composer.setShowFormattingToolbar(on)),
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
