import { describe, expect, it } from 'vitest';
import { parseGeoUri, parseLocationInput } from './geo-uri';

describe('parseGeoUri', () => {
  it('parses lat/lng from a geo URI', () => {
    expect(parseGeoUri('geo:52.51,13.38')).toEqual({ lat: 52.51, lng: 13.38 });
  });

  it('handles negative coordinates and ignores an uncertainty suffix', () => {
    expect(parseGeoUri('geo:-33.86,151.21;u=35')).toEqual({
      lat: -33.86,
      lng: 151.21,
    });
  });

  it('returns null for a non-geo or malformed value', () => {
    expect(parseGeoUri('https://example.com')).toBeNull();
    expect(parseGeoUri('geo:not,coords')).toBeNull();
    expect(parseGeoUri(undefined)).toBeNull();
  });
});

describe('parseLocationInput', () => {
  it('parses a plain "lat, lng" pair (comma or space separated)', () => {
    expect(parseLocationInput('48.8584, 2.2945')).toEqual({
      lat: 48.8584,
      lng: 2.2945,
    });
    expect(parseLocationInput('-33.8568 151.2153')).toEqual({
      lat: -33.8568,
      lng: 151.2153,
    });
  });

  it('parses a geo: URI and rejects an out-of-range one', () => {
    expect(parseLocationInput('geo:52.51,13.38')).toEqual({
      lat: 52.51,
      lng: 13.38,
    });
    // parseGeoUri itself doesn't range-check, so this exercises the range guard
    // on the geo branch specifically.
    expect(parseLocationInput('geo:91,0')).toBeNull();
  });

  it('parses an Apple Maps ?ll= link', () => {
    expect(
      parseLocationInput('https://maps.apple.com/?ll=48.8584,2.2945'),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
  });

  it('parses an OpenStreetMap link (marker params and map fragment)', () => {
    expect(
      parseLocationInput(
        'https://www.openstreetmap.org/?mlat=48.8584&mlon=2.2945#map=16/48.8584/2.2945',
      ),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
    expect(
      parseLocationInput('https://www.openstreetmap.org/#map=5/-33.86/151.21'),
    ).toEqual({ lat: -33.86, lng: 151.21 });
  });

  it('parses a Google Maps link (@lat,lng segment and ?q= query)', () => {
    expect(
      parseLocationInput(
        'https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z',
      ),
    ).toEqual({ lat: 48.8584, lng: 2.2945 });
    expect(
      parseLocationInput('https://maps.google.com/?q=40.7128,-74.006'),
    ).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it('rejects out-of-range, empty, and unrecognised input', () => {
    expect(parseLocationInput('91, 0')).toBeNull();
    expect(parseLocationInput('0, 181')).toBeNull();
    expect(parseLocationInput('not a location')).toBeNull();
    expect(parseLocationInput('https://example.com/no/coords/here')).toBeNull();
    expect(parseLocationInput('   ')).toBeNull();
    expect(parseLocationInput(undefined)).toBeNull();
    expect(parseLocationInput(42)).toBeNull();
  });
});
