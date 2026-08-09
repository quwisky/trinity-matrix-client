import { inject, type EnvironmentProviders } from '@angular/core';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT } from '@trinity/util/matrix';
import {
  provideConfigEntries,
  type ConfigEntry,
  type ConfigValue,
} from './config-schema';
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
  ThemeService,
} from './theme.service';

/**
 * The settings `platform-native` owns, for the config export.
 *
 * Every `read` is a signal getter and every `reset` a public setter, so the document
 * matches what is on screen and a reset moves the app immediately — see {@link ConfigEntry}.
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
      read: () => theme.preference(),
      reset: () => theme.setPreference(DEFAULT_THEME_PREFERENCE),
    },
    {
      path: 'theme.palette',
      key: 'trinity.palette',
      read: () => theme.palette(),
      reset: () => theme.setPalette(DEFAULT_PALETTE),
    },
    {
      path: 'theme.textScale',
      key: 'trinity.text-scale',
      read: () => theme.textScale(),
      reset: () => theme.setTextScale(DEFAULT_TEXT_SCALE),
    },
    {
      path: 'theme.codeScale',
      key: 'trinity.code-scale',
      read: () => theme.codeScale(),
      reset: () => theme.setCodeScale(DEFAULT_CODE_SCALE),
    },
    {
      path: 'theme.codeLineNumbers',
      key: 'trinity.code-lines',
      read: () => theme.codeLines(),
      reset: () => theme.setCodeLines(DEFAULT_CODE_LINE_MODE),
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
      read: () => privacy.sendReadReceipts(),
      reset: () => privacy.setSendReadReceipts(DEFAULT_SEND_READ_RECEIPTS),
    },
    {
      path: 'privacy.linkPreviews',
      key: 'trinity.privacy.link-previews',
      read: () => privacy.linkPreviews(),
      reset: () => privacy.setLinkPreviews(DEFAULT_LINK_PREVIEWS),
    },
    {
      path: 'privacy.linkPreviewsInEncryptedRooms',
      key: 'trinity.privacy.link-previews-encrypted',
      read: () => privacy.linkPreviewsInEncrypted(),
      reset: () =>
        privacy.setLinkPreviewsInEncrypted(DEFAULT_LINK_PREVIEWS_IN_ENCRYPTED),
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
      read: () => lines.showMembership(),
      reset: () => lines.setShowMembership(DEFAULT_SHOW_MEMBERSHIP),
    },
    {
      path: 'timeline.showProfile',
      key: 'trinity.timeline.show-profile',
      read: () => lines.showProfile(),
      reset: () => lines.setShowProfile(DEFAULT_SHOW_PROFILE),
    },
    {
      path: 'timeline.showRoomChanges',
      key: 'trinity.timeline.show-room-changes',
      read: () => lines.showRoomChanges(),
      reset: () => lines.setShowRoomChanges(DEFAULT_SHOW_ROOM_CHANGES),
    },
  ];
}

function formatEntries(format: DateTimeFormatService): readonly ConfigEntry[] {
  return [
    {
      path: 'format.time',
      key: 'trinity.format.time',
      read: () => format.timeFormat(),
      reset: () => format.setTimeFormat(DEFAULT_TIME_FORMAT),
    },
    {
      path: 'format.date',
      key: 'trinity.format.date',
      read: () => format.dateFormat(),
      reset: () => format.setDateFormat(DEFAULT_DATE_FORMAT),
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
      read: () => composer.showFormattingToolbar(),
      reset: () =>
        composer.setShowFormattingToolbar(DEFAULT_SHOW_FORMATTING_TOOLBAR),
    },
  ];
}

function flagEntries(flags: FeatureFlagsService): readonly ConfigEntry[] {
  return [
    {
      path: 'flags.virtualTimeline',
      key: 'trinity.flags.virtual-timeline',
      read: () => flags.virtualTimeline(),
      reset: () => flags.setVirtualTimeline(DEFAULT_VIRTUAL_TIMELINE),
    },
  ];
}

function shortcutEntries(
  shortcuts: KeyboardShortcutsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'shortcuts.overrides',
      key: 'trinity.shortcuts.overrides',
      // Only what the user actually changed: the defaults are the catalog's business and
      // differ by platform, so exporting them would pin one device's desktop bindings into
      // a document another device has to ignore. `null` is a shortcut left unbound after
      // another one stole its chord — a state a missing key cannot express.
      read: () => {
        const overrides: { [id: string]: ConfigValue } = {};
        for (const shortcut of shortcuts.list()) {
          if (shortcut.isDefault) {
            continue;
          }
          overrides[shortcut.id] = shortcut.chord
            ? {
                accel: shortcut.chord.accel,
                alt: shortcut.chord.alt,
                shift: shortcut.chord.shift,
                key: shortcut.chord.key,
              }
            : null;
        }
        return overrides;
      },
      reset: () => shortcuts.resetAll(),
    },
  ];
}
