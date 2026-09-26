import assert from 'node:assert/strict';

export const LOCATION_SHARE_SOURCES = {
  geolocation:
    'e2e/browser/journeys/conversations/location-share.spec.mts:19-33',
  definition:
    'e2e/browser/journeys/conversations/location-share.spec.mts:38-97',
  nativeAdapter: 'e2e/android/fixtures.mts:289-297,502-617',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const LOCATION_SHARE_LATITUDE = 40.7128;
export const LOCATION_SHARE_LONGITUDE = -74.006;
export const LOCATION_SHARE_COORDINATES = '40.71280, -74.00600';
export const LOCATION_SHARE_GEO_URI = 'geo:40.7128,-74.006';

export const locationShareAssertions = {
  roomReady: 'location-share.room-ready',
  serverEchoExact: 'location-share.server-echo-exact',
  cardVisible: 'location-share.card-visible',
  exactCoordinates: 'location-share.exact-coordinates',
  osmDestination: 'location-share.osm-destination',
  actionSheetReady: 'location-share.action-sheet-ready',
  copyLinkVisible: 'location-share.copy-link-visible',
  editAbsent: 'location-share.edit-absent',
} as const;

export const LOCATION_SHARE_ASSERTION_RECORDS = 8;

const assertionIds = Object.values(locationShareAssertions);
assert.equal(assertionIds.length, LOCATION_SHARE_ASSERTION_RECORDS);
assert.equal(new Set(assertionIds).size, LOCATION_SHARE_ASSERTION_RECORDS);
