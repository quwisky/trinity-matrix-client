import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const MEMBERSHIP_KEY = 'trinity.timeline.show-membership';
const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';
const ABSENT_FILE = '__TRINITY_TIMELINE_PREFERENCES_ABSENT__';
const RUN_AS = 'run-as';

export interface NativeTimelineMembershipObservation {
  readonly preferenceKeyPresent: boolean;
  readonly effectiveValue: boolean;
}

function decodeXml(value: string): string {
  const decoded = value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  assert(!/&(?:#\d+|#x[\da-f]+|[a-z][\w.-]*);/iu.test(decoded), 'Native Preferences contains no unsupported XML entity');
  return decoded;
}

export function parseNativeTimelineMembershipPreference(
  xml: string,
): NativeTimelineMembershipObservation {
  assert(
    /<map(?:\s[^>]*)?>[\s\S]*<\/map>/u.test(xml),
    'Native Preferences is a complete XML map',
  );
  const values = [
    ...xml.matchAll(/<string\s+name="([^"]*)"\s*>(.*?)<\/string>/gsu),
  ]
    .filter((match) => decodeXml(match[1]!) === MEMBERSHIP_KEY)
    .map((match) => decodeXml(match[2]!));
  assert(
    values.length <= 1,
    `Native Preferences contains at most one ${MEMBERSHIP_KEY} entry`,
  );
  if (values.length === 0) {
    assert(
      !xml.includes(MEMBERSHIP_KEY),
      `${MEMBERSHIP_KEY} is absent rather than malformed`,
    );
    return { preferenceKeyPresent: false, effectiveValue: true };
  }
  const value = values[0];
  assert(
    value === 'true' || value === 'false',
    `${MEMBERSHIP_KEY} is an exact boolean string`,
  );
  return {
    preferenceKeyPresent: true,
    effectiveValue: value === 'true',
  };
}

/** Observe package-owned Preferences without exposing raw XML or mutating state. */
export async function readNativeTimelineMembershipPreference(
  client: AccountWorkspaceClient,
  expectedValue: boolean,
  timeoutMs = 15_000,
): Promise<NativeTimelineMembershipObservation> {
  return waitForNativeShellState(
    async () => {
      const xml = await client.device.adb(
        'shell',
        `${RUN_AS} ${client.applicationId} sh -c 'if [ -f ${PREFERENCE_FILE} ]; then cat ${PREFERENCE_FILE}; else printf %s ${ABSENT_FILE}; fi'`,
      );
      return parseNativeTimelineMembershipPreference(
        xml === ABSENT_FILE ? '<map></map>' : xml,
      );
    },
    (candidate) => candidate.effectiveValue === expectedValue,
    `native ${MEMBERSHIP_KEY}=${String(expectedValue)}`,
    client.signal,
    timeoutMs,
  );
}
