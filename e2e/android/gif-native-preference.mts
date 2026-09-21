import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import type { MaestroDevice } from './maestro-session.mts';

const GIF_CONFIG_KEY = 'trinity.gif.config';
const PREFERENCE_FILE = 'shared_prefs/CapacitorStorage.xml';

export interface GifConfig {
  readonly provider: 'giphy' | 'klipy';
  readonly apiKey: string;
}

export interface NativeGifPreferenceObservation {
  readonly present: boolean;
  readonly providerMatches: boolean;
  readonly apiKeyMatches: boolean;
  readonly apiKeyLength: number;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function encodeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function absentObservation(): NativeGifPreferenceObservation {
  return {
    present: false,
    providerMatches: false,
    apiKeyMatches: false,
    apiKeyLength: 0,
  };
}

export function parseNativeGifPreference(
  xml: string,
  expectedProvider: GifConfig['provider'],
  expectedApiKey: string,
): NativeGifPreferenceObservation {
  const values = [
    ...xml.matchAll(/<string\s+name="([^"]*)">(.*?)<\/string>/gsu),
  ]
    .filter((match) => decodeXml(match[1]!) === GIF_CONFIG_KEY)
    .map((match) => decodeXml(match[2]!));
  assert(
    values.length <= 1,
    'Native Preferences contains at most one GIF config',
  );
  const serialized = values[0];
  if (serialized === undefined) return absentObservation();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return absentObservation();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return absentObservation();
  }
  const config = value as Readonly<Record<string, unknown>>;
  const provider = config['provider'];
  const apiKey = config['apiKey'];
  return {
    present: true,
    providerMatches: provider === expectedProvider,
    apiKeyMatches: apiKey === expectedApiKey,
    apiKeyLength: typeof apiKey === 'string' ? apiKey.length : 0,
  };
}

function preferenceXml(config: GifConfig): string {
  const key = encodeXml(GIF_CONFIG_KEY);
  const value = encodeXml(JSON.stringify(config));
  return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="${key}">${value}</string>\n</map>\n`;
}

/** Seed package-owned Preferences without exposing the key in adb arguments. */
export async function seedNativeGifPreference(
  device: MaestroDevice,
  applicationId: 'eu.qwky.trinity',
  config: GifConfig,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'trinity-gif-preference-'));
  const local = join(directory, 'CapacitorStorage.xml');
  const remote = `/data/local/tmp/trinity-gif-${randomUUID()}.xml`;
  try {
    await writeFile(local, preferenceXml(config), { mode: 0o600 });
    await device.adb('shell', 'am', 'force-stop', applicationId);
    await device.adb('push', local, remote);
    await device.adb(
      'shell',
      `run-as ${applicationId} sh -c 'mkdir -p shared_prefs && cat ${remote} > ${PREFERENCE_FILE}.tmp && chmod 600 ${PREFERENCE_FILE}.tmp && mv ${PREFERENCE_FILE}.tmp ${PREFERENCE_FILE}'`,
    );
  } finally {
    await device.adb('shell', 'rm', '-f', remote).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Observe exact durable Preferences while returning no secret value. */
export async function readNativeGifPreference(
  client: AccountWorkspaceClient,
  expectedProvider: GifConfig['provider'],
  expectedApiKey: string,
): Promise<NativeGifPreferenceObservation> {
  const xml = await client.device
    .adb(
      'shell',
      'run-as',
      client.applicationId,
      'cat',
      PREFERENCE_FILE,
    )
    .catch(() => '');
  return parseNativeGifPreference(xml, expectedProvider, expectedApiKey);
}
