import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const DENSITY_KEY = 'trinity.appearance.density';
const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';
const ABSENT_FILE = '__TRINITY_DENSITY_PREFERENCES_ABSENT__';

export interface NativeAppearanceDensityObservation {
  readonly present: boolean;
  readonly version: 1 | null;
  readonly value: 'cosy' | 'compact';
}

function decodeXml(value: string): string {
  const decoded = value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  assert(!/&(?:#\d+|#x[\da-f]+|[a-z][\w.-]*);/iu.test(decoded),
    'Native density Preferences contains no unsupported XML entity');
  return decoded;
}

/** Decode only the density entry; never return or embed raw XML in errors. */
export function parseNativeAppearanceDensityPreference(
  xml: string,
): NativeAppearanceDensityObservation {
  const document = xml.trim().replace(/^<\?xml\s[^>]*\?>\s*/u, '');
  const empty = /^<map\s*\/>$/u.test(document);
  const map = document.match(/^<map(?:\s[^>]*)?>([\s\S]*)<\/map>$/u);
  assert(empty || map, 'Native density Preferences is a complete XML map');
  const content = map?.[1] ?? '';
  const entries = [...content.matchAll(/<string\s+name="([^"]*)"\s*>([\s\S]*?)<\/string>/gu)]
    .filter((entry) => entry[1] === DENSITY_KEY);
  const mentions = content.split(DENSITY_KEY).length - 1;
  assert(entries.length === mentions,
    'Native density Preferences has no malformed named entry');
  assert(entries.length <= 1,
    'Native density Preferences has at most one density entry');
  if (entries.length === 0) {
    return { present: false, version: null, value: 'cosy' };
  }

  const decoded = decodeXml(entries[0]![2]!);
  let stored: unknown;
  try {
    stored = JSON.parse(decoded) as unknown;
  } catch {
    assert.fail('Native density Preferences has a JSON envelope');
  }
  assert(stored !== null && typeof stored === 'object' && !Array.isArray(stored),
    'Native density Preferences envelope is an object');
  const envelope = stored as Record<string, unknown>;
  assert(Object.keys(envelope).length === 2 &&
    Object.hasOwn(envelope, 'version') && Object.hasOwn(envelope, 'value'),
  'Native density Preferences envelope has exact keys');
  assert(envelope['version'] === 1,
    'Native density Preferences envelope is version 1');
  assert(envelope['value'] === 'cosy' || envelope['value'] === 'compact',
    'Native density Preferences value is Cosy or Compact');
  return { present: true, version: 1, value: envelope['value'] };
}

/** Observe package-owned Capacitor Preferences without mutating them. */
export async function readNativeAppearanceDensityPreference(
  client: AccountWorkspaceClient,
  expected: 'cosy' | 'compact',
  timeoutMs = 15_000,
): Promise<NativeAppearanceDensityObservation> {
  return waitForNativeShellState(
    async () => {
      const xml = await client.device.adb(
        'shell',
        `run-as ${client.applicationId} sh -c 'if [ -f ${PREFERENCE_FILE} ]; then cat ${PREFERENCE_FILE}; else printf %s ${ABSENT_FILE}; fi'`,
      );
      return parseNativeAppearanceDensityPreference(
        xml === ABSENT_FILE ? '<map/>' : xml,
      );
    },
    (value) => value.value === expected &&
      (expected === 'cosy' || value.present),
    `native ${DENSITY_KEY}=${expected}`,
    client.signal,
    timeoutMs,
  );
}
