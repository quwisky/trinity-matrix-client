import type { MatrixClient } from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

/** What a homeserver must advertise in `/versions`; either one is enough. */
export interface ServerSupportQuery {
  /** The spec version that brought the feature, such as `v1.18`; later versions count. */
  readonly version?: `v${number}.${number}`;
  readonly unstableFeature?: string;
}

/**
 * Whether `client`'s homeserver advertises `query`: true, false, or null when `/versions`
 * could not be read. Cold; the SDK memoises `/versions` per client and forgets a failure, so
 * a later subscribe after null asks the server again.
 */
export function serverAdvertises(
  client: MatrixClient,
  query: ServerSupportQuery,
): Observable<boolean | null> {
  return defer(() => from(client.getVersions())).pipe(
    map((response): boolean | null => {
      const versions: readonly unknown[] = Array.isArray(response?.versions)
        ? response.versions
        : [];
      const features: Readonly<Record<string, unknown>> =
        response?.unstable_features ?? {};
      return (
        (query.version !== undefined &&
          versions.some((v) => atLeast(v, query.version as string))) ||
        (query.unstableFeature !== undefined &&
          features[query.unstableFeature] === true)
      );
    }),
    catchError(() => of(null)),
  );
}

function atLeast(advertised: unknown, minimum: string): boolean {
  const have = parseVersion(advertised);
  const want = parseVersion(minimum);
  if (!have || !want) return false;
  return have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]);
}

function parseVersion(value: unknown): [number, number] | null {
  const match =
    typeof value === 'string' ? /^v(\d+)\.(\d+)$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2])] : null;
}
