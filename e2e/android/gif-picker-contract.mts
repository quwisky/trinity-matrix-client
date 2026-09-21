import assert from 'node:assert/strict';

export const GIF_PICKER_SOURCES = {
  helpers: 'e2e/browser/journeys/conversations/gif.spec.mts:27-178',
  settingsLifecycle:
    'e2e/browser/journeys/conversations/gif.spec.mts:183-231',
  unconfiguredTray:
    'e2e/browser/journeys/conversations/gif.spec.mts:233-250',
  sendImage: 'e2e/browser/journeys/conversations/gif.spec.mts:252-289',
  activeAccountSend:
    'e2e/browser/journeys/conversations/gif.spec.mts:291-353',
  navigation: 'e2e/support/journeys/navigation.mts',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const gifPickerAssertions = {
  settingsRoomsRouteReady: 'gif-picker.settings.rooms-route-ready',
  settingsSectionsVisible: 'gif-picker.settings.sections-visible',
  settingsDetailReady: 'gif-picker.settings.detail-ready',
  settingsNativePreferenceAbsent:
    'gif-picker.settings.native-preference-absent',
  settingsPreferencePersisted: 'gif-picker.settings.preference-persisted',
  settingsExactConfig: 'gif-picker.settings.exact-config',
  settingsClearVisible: 'gif-picker.settings.clear-visible',
  settingsClearedConfig: 'gif-picker.settings.cleared-config',
  settingsClearHidden: 'gif-picker.settings.clear-hidden',
  settingsGiphyLabelAfterRelaunch:
    'gif-picker.settings.giphy-label-after-relaunch',
  unconfiguredRoomReady: 'gif-picker.unconfigured.room-ready',
  unconfiguredComposerReady: 'gif-picker.unconfigured.composer-ready',
  unconfiguredAttachVisible: 'gif-picker.unconfigured.attach-visible',
  unconfiguredGifAbsent: 'gif-picker.unconfigured.gif-absent',
  sendRoomReady: 'gif-picker.send.room-ready',
  sendSearchVisible: 'gif-picker.send.search-visible',
  sendResultVisible: 'gif-picker.send.result-visible',
  accountAActive: 'gif-picker.account.account-a-active',
  accountAddReady: 'gif-picker.account.add-account-ready',
  accountBActive: 'gif-picker.account.account-b-active',
  accountRoomReady: 'gif-picker.account.room-ready',
  accountGifVisible: 'gif-picker.account.gif-visible',
  accountResultVisible: 'gif-picker.account.result-visible',
  accountExactSenderB: 'gif-picker.account.exact-sender-b',
} as const;

export type GifPickerAssertion =
  (typeof gifPickerAssertions)[keyof typeof gifPickerAssertions];

export const gifPickerStageAssertions = {
  settingsLifecycle: [
    gifPickerAssertions.settingsRoomsRouteReady,
    gifPickerAssertions.settingsSectionsVisible,
    gifPickerAssertions.settingsDetailReady,
    gifPickerAssertions.settingsNativePreferenceAbsent,
    gifPickerAssertions.settingsPreferencePersisted,
    gifPickerAssertions.settingsExactConfig,
    gifPickerAssertions.settingsClearVisible,
    gifPickerAssertions.settingsClearedConfig,
    gifPickerAssertions.settingsClearHidden,
    gifPickerAssertions.settingsGiphyLabelAfterRelaunch,
  ],
  unconfiguredTray: [
    gifPickerAssertions.unconfiguredRoomReady,
    gifPickerAssertions.unconfiguredComposerReady,
    gifPickerAssertions.unconfiguredAttachVisible,
    gifPickerAssertions.unconfiguredGifAbsent,
  ],
  sendImage: [
    gifPickerAssertions.sendRoomReady,
    gifPickerAssertions.sendSearchVisible,
    gifPickerAssertions.sendResultVisible,
  ],
  activeAccountSend: [
    gifPickerAssertions.accountAActive,
    gifPickerAssertions.accountAddReady,
    gifPickerAssertions.accountBActive,
    gifPickerAssertions.accountRoomReady,
    gifPickerAssertions.accountGifVisible,
    gifPickerAssertions.accountResultVisible,
    gifPickerAssertions.accountExactSenderB,
  ],
} as const;

const assertionIds = Object.values(gifPickerAssertions);

export const GIF_PICKER_ASSERTION_RECORDS = assertionIds.length;

assert.equal(gifPickerStageAssertions.settingsLifecycle.length, 10);
assert.equal(gifPickerStageAssertions.unconfiguredTray.length, 4);
assert.equal(gifPickerStageAssertions.sendImage.length, 3);
assert.equal(gifPickerStageAssertions.activeAccountSend.length, 7);
assert.equal(assertionIds.length, 24);
assert.equal(new Set(assertionIds).size, 24);
