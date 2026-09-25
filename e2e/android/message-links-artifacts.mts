import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DESKTOP_ACCOUNT_PROFILE } from './account-workspace-client.mts';
import {
  MESSAGE_LINKS_ASSERTION_RECORDS,
  MESSAGE_LINKS_STAGE_PROFILES,
  MESSAGE_LINKS_STAGES,
  PORTRAIT_LINK_PROFILE,
} from './message-links-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
// Maestro flow files the native client generates (for example keyboard dismissal)
// are plain YAML and are scanned like every other text diagnostic.
const publishableText = new Set(['.json', '.jsonl', '.log', '.txt', '.xml', '.yaml']);
const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type MessageLinksStageId = (typeof MESSAGE_LINKS_STAGES)[number]['id'];

export interface MessageLinksPublicationSafety {
  unsafeSecrets: boolean;
  cleanupFailed: boolean;
  scrubFailed: boolean;
}

/** A local account (`username`) or a remote one (`localpart`); both carry a user id. */
export interface MessageLinksSecretAccount {
  readonly userId: string;
  readonly username?: string;
  readonly localpart?: string;
  readonly password?: string;
}

/** Any field may be registered before the Room exists; the id is added once known. */
export interface MessageLinksSecretRoom {
  readonly id?: string;
  readonly name?: string;
  readonly topic?: string;
  readonly alias?: string;
  readonly aliasLocalpart?: string;
}

export interface MessageLinksSecretIds {
  readonly run: string;
  readonly local?: MessageLinksSecretAccount;
  readonly remote?: MessageLinksSecretAccount;
  readonly bob?: MessageLinksSecretAccount;
  readonly bobName?: string;
  /** Keyed by a lower-case role such as `source`, `target` or `remote`. */
  readonly rooms?: Readonly<Record<string, MessageLinksSecretRoom>>;
  readonly hrefs?: readonly string[];
  readonly eventIds?: readonly string[];
}

interface AbortReport {
  status: 'running' | 'passed' | 'failed';
  readonly stages: readonly {
    status: 'running' | 'passed' | 'failed';
    failureCount: number;
    error?: string;
  }[];
}

const localpartOf = (id: string): string | undefined => {
  const separator = id.indexOf(':');
  return separator > 1 ? id.slice(1, separator) : undefined;
};

const serverOf = (id: string): string | undefined => {
  const separator = id.indexOf(':');
  return separator > 0 && separator < id.length - 1 ? id.slice(separator + 1) : undefined;
};

/**
 * Register every stage identifier in each form it can reach a diagnostic: raw,
 * `slice(1)`, component-encoded and base64url. Encoded forms are values of their
 * own, so their encoded patterns also cover the double-encoded `%25xx` form.
 * The bare server name is never a secret.
 */
export function messageLinksSecrets(
  stage: MessageLinksStageId,
  ids: MessageLinksSecretIds,
): Record<string, string> {
  assert(MESSAGE_LINKS_STAGES.some((entry) => entry.id === stage),
    'Message-links secrets belong to a contract stage');
  const prefix = `SECRET_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const servers = new Set<string>();
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Message-links secret values are non-empty strings');
    values[`${prefix}_${key}`] = value;
  };
  const addEncoded = (key: string, value: string | undefined): void => {
    add(key, value);
    if (value !== undefined && encodeURIComponent(value) !== value)
      add(`${key}_ENCODED`, encodeURIComponent(value));
  };
  const account = (role: string, value: MessageLinksSecretAccount | undefined): void => {
    if (!value) return;
    addEncoded(`${role}_USER_ID`, value.userId);
    add(`${role}_USERNAME`, value.username);
    add(`${role}_LOCALPART`, value.localpart ?? localpartOf(value.userId));
    add(`${role}_PASSWORD`, value.password);
    const server = serverOf(value.userId);
    if (server) servers.add(server);
  };
  add('RUN', ids.run);
  account('LOCAL', ids.local);
  account('REMOTE', ids.remote);
  account('BOB', ids.bob);
  add('BOB_NAME', ids.bobName);
  for (const [role, room] of Object.entries(ids.rooms ?? {})) {
    assert(/^[a-z][a-z0-9-]*$/u.test(role), 'Message-links Room roles are lower-case slugs');
    const key = `${role.toUpperCase().replaceAll('-', '_')}_ROOM`;
    if (room.id !== undefined) {
      addEncoded(`${key}_ID`, room.id);
      addEncoded(`${key}_ID_SLICE`, room.id.slice(1));
      add(`${key}_ID_B64URL`, Buffer.from(room.id).toString('base64url'));
      const server = serverOf(room.id);
      if (server) servers.add(server);
    }
    add(`${key}_NAME`, room.name);
    add(`${key}_TOPIC`, room.topic);
    addEncoded(`${key}_ALIAS`, room.alias);
    add(`${key}_ALIAS_LOCALPART`,
      room.aliasLocalpart ?? (room.alias === undefined ? undefined : localpartOf(room.alias)));
    if (room.alias !== undefined) {
      const server = serverOf(room.alias);
      if (server) servers.add(server);
    }
  }
  ids.hrefs?.forEach((href, index) => addEncoded(`HREF_${index + 1}`, href));
  ids.eventIds?.forEach((eventId, index) => addEncoded(`EVENT_${index + 1}_ID`, eventId));
  for (const value of Object.values(values))
    assert(!servers.has(value), 'The bare server name is never a message-links secret');
  return values;
}

const hexEscape = (byte: number): string =>
  `%(?:25)*${byte.toString(16).toUpperCase().padStart(2, '0')
    .replace(/[A-F]/gu, (hex) => `[${hex}${hex.toLowerCase()}]`)}`;

/** One character as itself or any single- or multiply-percent-encoded UTF-8 form. */
const characterPattern = (character: string): string => {
  const literal = character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const encoded = [...new TextEncoder().encode(character)].map(hexEscape).join('');
  return character === ' '
    ? `(?:${literal}|\\+|${encoded})`
    : `(?:${literal}|${encoded})`;
};

/**
 * Match each secret in any percent-encoded form, with case-insensitive hex and
 * nested `%25` layers, so strict, component, form and double encodings are all
 * covered without decoding or changing other log text. Longest values first.
 */
export function encodedSecretPatterns(
  secrets: Readonly<Record<string, string>>,
): readonly RegExp[] {
  return [...new Set(Object.values(secrets).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((value) => new RegExp([...value].map(characterPattern).join(''), 'u'));
}

const escapedSecretValues = (secrets: Readonly<Record<string, string>>): readonly string[] =>
  [...new Set(Object.values(secrets).filter(Boolean).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((left, right) => right.length - left.length);

/** Redact every registered secret, raw, JSON-escaped or percent-encoded, from text. */
export function redactSecretText(
  text: string,
  secrets: Readonly<Record<string, string>>,
): string {
  let redacted = text;
  for (const value of escapedSecretValues(secrets))
    redacted = redacted.split(value).join('[REDACTED]');
  for (const pattern of encodedSecretPatterns(secrets))
    redacted = redacted.replace(new RegExp(pattern.source, 'gu'), '[REDACTED]');
  return redacted;
}

/** Remove local raster proof and redact text before the final fail-closed scan. */
export async function scrubMessageLinksArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, true);
  const escaped = escapedSecretValues(secrets);
  const encoded = encodedSecretPatterns(secrets);
  const scrub = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scrub(path);
      else {
        assert(entry.isFile(), 'Message-links diagnostic is a regular file');
        if (raster.has(extname(path).toLowerCase())) await unlink(path);
        else if (publishableText.has(extname(path).toLowerCase())) {
          const value = await readFile(path, 'utf8');
          const literal = escaped.reduce((text, secret) =>
            text.replaceAll(secret, '[REDACTED]'), value);
          const redacted = encoded.reduce((text, pattern) =>
            text.replaceAll(new RegExp(pattern, 'gu'), '[REDACTED]'), literal);
          if (redacted !== value) await writeFile(path, redacted, 'utf8');
        }
      }
    }
  };
  await scrub(output);
}

/** Reject unredacted identifiers, authorization, native storage payloads, and any raster. */
export async function scanMessageLinksArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = escapedSecretValues(secrets);
  const encoded = encodedSecretPatterns(secrets);
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(!raster.has(extname(path).toLowerCase()),
        'No raster proof in message-links diagnostics');
      assert(entry.isFile() &&
        (entry.name === 'publication-safe' ||
          publishableText.has(extname(path).toLowerCase())),
      'Message-links diagnostics contain only recognized text files');
      const value = await readFile(path, 'utf8');
      for (const secret of values)
        assert(!value.includes(secret), 'No raw credential or identifier in message-links diagnostics');
      for (const pattern of encoded)
        assert(!pattern.test(value), 'No URL-encoded credential or identifier in message-links diagnostics');
      assert(!/syt_|\bBearer\s+\S+|\bX-Matrix\b/iu.test(value),
        'Authorization absent from message-links diagnostics');
      assert(!/<(?:map\b|string\b)[^>]*>/iu.test(value),
        'Raw native Preferences XML absent from message-links diagnostics');
      assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
        'Preferences diagnostic data is redacted');
      assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
        'SecureStorage diagnostic data is redacted');
    }
  };
  await scan(output);
}

async function requireTextFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required message-links text capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireTextFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Message-links diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

const requestedProfile = (id: MessageLinksStageId): object =>
  MESSAGE_LINKS_STAGE_PROFILES[id] === 'portrait' ? PORTRAIT_LINK_PROFILE : DESKTOP_ACCOUNT_PROFILE;

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === MESSAGE_LINKS_STAGES.length &&
    report['expectedAssertionRecords'] === MESSAGE_LINKS_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Message-links report has six successful unretried stages');
  assert(Array.isArray(report['stages']) && report['stages'].length === MESSAGE_LINKS_STAGES.length,
    'Message-links report has exactly the contract stages');
  const identities = new Set<unknown>();
  MESSAGE_LINKS_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null, 'Message-links stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Message-links stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Message-links ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, MESSAGE_LINKS_ASSERTION_RECORDS,
    'Message-links parity identities are unique across stages');
}

/** Only a complete, captured, cleaned six-stage run may receive the hosted upload marker. */
export async function markMessageLinksDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<MessageLinksPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks message-links publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted message-links report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Message-links runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: DESKTOP_ACCOUNT_PROFILE,
      digest: digest(JSON.stringify(DESKTOP_ACCOUNT_PROFILE)),
    }, 'Message-links runtime provenance used the desktop profile');
    assert.deepEqual(await readJsonObject(join(output, 'profiles.json')),
      Object.fromEntries(MESSAGE_LINKS_STAGES.map((entry) => {
        const requested = requestedProfile(entry.id);
        return [entry.id, { requested, digest: digest(JSON.stringify(requested)) }];
      })), 'Message-links stage profiles match the contract');
    for (const entry of MESSAGE_LINKS_STAGES) {
      await readJsonObject(join(output, entry.id, 'profile-applied.json'));
      for (const name of PASSED_CAPTURES)
        await requireTextFile(join(output, entry.id, name));
    }
    await scanMessageLinksArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** Run every local teardown step, even after a prior one fails. */
export async function runMessageLinksStageCleanup(
  actions: readonly (() => Promise<void>)[],
  failures: unknown[],
): Promise<void> {
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokeMessageLinksPublicationOnAbort(
  output: string,
  report: AbortReport,
  signal: AbortSignal,
): Promise<void> {
  if (!signal.aborted) return;
  await rm(join(output, 'publication-safe'), { force: true });
  report.status = 'failed';
  const stage = report.stages.at(-1);
  if (stage && stage.status !== 'failed') {
    stage.status = 'failed';
    stage.failureCount++;
  }
  if (stage) stage.error = 'Cancelled before message-links publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
