/** Parse a `geo:lat,lng` URI (ignoring any `;u=` uncertainty / altitude) into coords. */
export function parseGeoUri(
  geoUri: unknown,
): { lat: number; lng: number } | null {
  if (typeof geoUri !== 'string') {
    return null;
  }
  const match = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(geoUri.trim());
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Whether a coordinate pair is a finite point inside WGS84 bounds. */
function inGeoRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/** Parse a bare `lat,lng` (map-query style, e.g. a `?q=` value), else null. */
function parseCoordPair(
  value: string | null,
): { lat: number; lng: number } | null {
  if (!value) {
    return null;
  }
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(value);
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return inGeoRange(lat, lng) ? { lat, lng } : null;
}

/** Pull the first recognised coordinate pair out of a map-service URL, else null. */
function coordsFromMapUrl(text: string): { lat: number; lng: number } | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // OpenStreetMap marker params (`?mlat=&mlon=`).
  const mlat = url.searchParams.get('mlat');
  const mlon = url.searchParams.get('mlon');
  if (mlat !== null && mlon !== null) {
    const lat = Number(mlat);
    const lng = Number(mlon);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  // Google / Apple Maps query params carrying a `lat,lng` (`?q=`, `?query=`, `?ll=`).
  for (const key of ['q', 'query', 'll']) {
    const pair = parseCoordPair(url.searchParams.get(key));
    if (pair) {
      return pair;
    }
  }

  // Google's `@lat,lng,zoom` path segment.
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  // OpenStreetMap `#map=zoom/lat/lng` fragment.
  const map = /map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(
    url.hash,
  );
  if (map) {
    const lat = Number(map[1]);
    const lng = Number(map[2]);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  return null;
}

/**
 * Parse a human-entered location into coordinates: a `geo:` URI, a plain `lat, lng`, an
 * OpenStreetMap link, or a Google / Apple Maps link. Returns null when no in-range coordinate
 * can be extracted. Backs the desktop manual-location dialog, where Chromium can't resolve a
 * real device position.
 */
export function parseLocationInput(
  input: unknown,
): { lat: number; lng: number } | null {
  if (typeof input !== 'string') {
    return null;
  }
  const text = input.trim();
  if (text === '') {
    return null;
  }

  const geo = parseGeoUri(text);
  if (geo) {
    return inGeoRange(geo.lat, geo.lng) ? geo : null;
  }

  const plain = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (plain) {
    const lat = Number(plain[1]);
    const lng = Number(plain[2]);
    return inGeoRange(lat, lng) ? { lat, lng } : null;
  }

  return coordsFromMapUrl(text);
}
