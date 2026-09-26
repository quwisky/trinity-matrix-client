import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseNativeComposerDraft(
  xml: string,
  key: string,
  conversationKey: string,
): string | null {
  const values = [...xml.matchAll(/<string\s+name="([^"]*)">(.*?)<\/string>/gsu)]
    .filter((match) => decodeXml(match[1]!) === key)
    .map((match) => decodeXml(match[2]!));
  assert(
    values.length <= 1,
    `Native Preferences contains at most one ${key} entry`,
  );
  const serialized = values[0];
  if (serialized === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const draft = (parsed as Record<string, unknown>)[conversationKey];
  return typeof draft === 'string' ? draft : null;
}

export interface NativeComposerDraftObservation {
  readonly preferenceKeyPresent: true;
  readonly conversationKeyPresent: true;
  readonly exactDraft: true;
  readonly valueLength: number;
}

/** Observe the durable Android Preferences backend without exposing its value. */
export async function readNativeComposerDraft(
  client: AccountWorkspaceClient,
  key: string,
  conversationKey: string,
  expectedDraft: string,
  timeoutMs = 15_000,
): Promise<NativeComposerDraftObservation> {
  const value = await waitForNativeShellState(
    async () => {
      const xml = await client.device.adb(
        'shell',
        'run-as',
        client.applicationId,
        'cat',
        PREFERENCE_FILE,
      );
      return parseNativeComposerDraft(xml, key, conversationKey);
    },
    (candidate) => candidate === expectedDraft,
    'durable native composer draft preference',
    client.signal,
    timeoutMs,
  );
  assert(value !== null, 'Native composer draft preference is present');
  return {
    preferenceKeyPresent: true,
    conversationKeyPresent: true,
    exactDraft: true,
    valueLength: value.length,
  };
}
