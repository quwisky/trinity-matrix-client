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
import {
  boundedNumberSetting,
  choiceSetting,
  flagSetting,
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
import { PrivacySettingsService } from './privacy-settings.service';
import { KeyboardShortcutsService } from './shortcuts/keyboard-shortcuts.service';
import { shortcutOverridesEntry } from './shortcuts/shortcut-overrides-config';
import {
  DEFAULT_SHOW_MEMBERSHIP,
  DEFAULT_SHOW_PROFILE,
  DEFAULT_SHOW_ROOM_CHANGES,
  SystemLineSettingsService,
} from './system-line-settings.service';

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
    ...shellEntries(inject(ShellLayoutService)),
    ...privacyEntries(inject(PrivacySettingsService)),
    ...timelineEntries(inject(SystemLineSettingsService)),
    ...formatEntries(inject(DateTimeFormatService)),
    ...composerEntries(inject(ComposerSettingsService)),
    ...gestureEntries(inject(MessageGestureSettingsService)),
    ...flagEntries(inject(FeatureFlagsService)),
    ...shortcutEntries(inject(KeyboardShortcutsService)),
  ]);
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

function privacyEntries(
  privacy: PrivacySettingsService,
): readonly ConfigEntry[] {
  return [
    {
      path: 'privacy.sendReadReceipts',
      key: 'trinity.privacy.send-read-receipts',
      description: 'Whether reading a message tells the room that you read it.',
      read: () => privacy.sendReadReceipts(),
      reset: () => privacy.resetSendReadReceipts(),
      ...flagSetting((on) => privacy.setSendReadReceipts(on)),
    },
    {
      path: 'privacy.linkPreviews',
      key: 'trinity.privacy.link-previews',
      description:
        'Whether links in messages are expanded into previews fetched by your homeserver.',
      read: () => privacy.linkPreviews(),
      reset: () => privacy.resetLinkPreviews(),
      ...flagSetting((on) => privacy.setLinkPreviews(on)),
    },
    {
      path: 'privacy.linkPreviewsInEncryptedRooms',
      key: 'trinity.privacy.link-previews-encrypted',
      description:
        'Whether link previews are fetched in encrypted rooms too, where asking for one tells your homeserver a link was sent.',
      read: () => privacy.linkPreviewsInEncrypted(),
      reset: () => privacy.resetLinkPreviewsInEncrypted(),
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
