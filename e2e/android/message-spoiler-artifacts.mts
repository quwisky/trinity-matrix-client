import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import {
  DESKTOP_ACCOUNT_PROFILE,
  type AccountWorkspaceClient,
} from './account-workspace-client.mts';
import {
  MESSAGE_SPOILER_ASSERTION_RECORDS,
  MESSAGE_SPOILER_STAGES,
  assertRasterMatchesNative,
  nativeCrop,
  pngDimensions,
  type MessageSpoilerStageId,
  type NativeClip,
  type SpoilerCaptureState,
  type SpoilerClip,
} from './message-spoiler-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const raster = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
// Maestro flow files the native client generates are plain YAML and are
// scanned like every other text diagnostic.
const publishableText = new Set(['.json', '.jsonl', '.log', '.txt', '.xml', '.yaml']);
const PASSED_CAPTURES = ['passed.json', 'passed-ui.json', 'passed-surface.json'] as const;
/** The only rasters this suite publishes: the one spoiler leaf, per state. */
export const SPOILER_CAPTURE_NAMES = {
  concealed: 'spoiler-concealed',
  revealed: 'spoiler-revealed',
  failed: 'spoiler-failed',
} as const satisfies Readonly<Record<SpoilerCaptureState, string>>;
const PASSED_RASTERS = [SPOILER_CAPTURE_NAMES.concealed, SPOILER_CAPTURE_NAMES.revealed] as const;
/** PNG chunks that could carry text; a scoped capture never has one. */
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);
const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
/**
 * A room-version 3+ Matrix event id (`$` and 43 URL-safe base64 characters),
 * raw or percent-encoded. The SDK logs the Room's state-event ids to logcat
 * ("Event $… already in timeline"); none is registered, so every event-id
 * shape is redacted and rejected.
 */
const EVENT_ID_SHAPE = /(?:\$|%24)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/giu;

export interface MessageSpoilerPublicationSafety {
  unsafeSecrets: boolean;
  cleanupFailed: boolean;
  scrubFailed: boolean;
}

/** Every identifier one stage creates; each is registered before any UI step. */
export interface MessageSpoilerSecretIds {
  readonly run: string;
  readonly account?: {
    readonly userId: string;
    readonly username: string;
    readonly password: string;
  };
  readonly room?: { readonly id?: string; readonly name?: string };
  /** Run-scoped texts: the body, the secret and the transaction id. */
  readonly texts?: readonly string[];
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

/**
 * Register every stage identifier in each form it can reach a diagnostic: raw,
 * `slice(1)`, component-encoded and the base64url Room route segment. Encoded
 * forms are values of their own, so their patterns also cover `%25xx` nesting.
 */
export function messageSpoilerSecrets(
  stage: MessageSpoilerStageId,
  ids: MessageSpoilerSecretIds,
): Record<string, string> {
  assert(MESSAGE_SPOILER_STAGES.some((entry) => entry.id === stage),
    'Message-spoiler secrets belong to a contract stage');
  const prefix = `SECRET_SPOILER_${stage.toUpperCase().replaceAll('-', '_')}`;
  const values: Record<string, string> = {};
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    assert(typeof value === 'string' && value.length > 0,
      'Message-spoiler secret values are non-empty strings');
    values[`${prefix}_${key}`] = value;
  };
  const addEncoded = (key: string, value: string | undefined): void => {
    add(key, value);
    if (value !== undefined && encodeURIComponent(value) !== value)
      add(`${key}_ENCODED`, encodeURIComponent(value));
  };
  add('RUN', ids.run);
  if (ids.account) {
    addEncoded('USER_ID', ids.account.userId);
    add('USERNAME', ids.account.username);
    add('PASSWORD', ids.account.password);
  }
  if (ids.room?.id !== undefined) {
    addEncoded('ROOM_ID', ids.room.id);
    addEncoded('ROOM_ID_SLICE', ids.room.id.slice(1));
    add('ROOM_ID_B64URL', Buffer.from(ids.room.id).toString('base64url'));
  }
  add('ROOM_NAME', ids.room?.name);
  ids.texts?.forEach((text, index) => addEncoded(`TEXT_${index + 1}`, text));
  ids.eventIds?.forEach((eventId, index) => addEncoded(`EVENT_${index + 1}_ID`, eventId));
  for (const value of Object.values(values))
    assert(value !== 'localhost', 'The bare server name is never a message-spoiler secret');
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

/** Match each secret in any percent-encoded form with case-insensitive hex. */
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

/** Redact every registered secret and every Matrix event-id shape from text. */
export function redactDiagnosticText(
  text: string,
  secrets: Readonly<Record<string, string>>,
): string {
  return redactSecretText(text, secrets).replace(EVENT_ID_SHAPE, '[REDACTED]');
}

// Leaf-scoped rasters.

/** The metadata written beside each scoped raster. */
export interface SpoilerCaptureMetadata {
  readonly schemaVersion: 1;
  readonly scope: 'spoiler-leaf';
  readonly source: 'device-screencap';
  readonly state: SpoilerCaptureState;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  /** The leaf box in viewport CSS pixels. */
  readonly clip: SpoilerClip;
  /** The same box in device pixels, mapped exactly as native taps are. */
  readonly native: NativeClip;
  /** Mean relative luminance (0–255) of the crop: evidence only, never an oracle. */
  readonly meanLuminance: number;
  readonly color: string;
  readonly backgroundColor: string;
}

/** PNG chunks in file order; a malformed PNG throws. */
function pngChunks(png: Uint8Array): readonly { readonly type: string; readonly data: Buffer }[] {
  pngDimensions(png);
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert(offset + 12 <= bytes.length, 'The PNG chunk is complete');
    const length = bytes.readUInt32BE(offset);
    assert(offset + 12 + length <= bytes.length, 'The PNG chunk data is complete');
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.equal(chunks.at(-1)?.type, 'IEND', 'The PNG ends with its end chunk');
  return chunks;
}

/** PNG chunk types in file order; a malformed PNG throws. */
export function pngChunkTypes(png: Uint8Array): readonly string[] {
  return pngChunks(png).map(({ type }) => type);
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly colorType: 2 | 6;
  /** Unfiltered rows, `width * channels` bytes each. */
  readonly pixels: Buffer;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG, as `screencap -p` writes. */
export function decodePng(png: Uint8Array): DecodedPng {
  const { width, height } = pngDimensions(png);
  const chunks = pngChunks(png);
  const header = chunks[0]!.data;
  const [depth, colorType, compression, filter, interlace] = [...header.subarray(8, 13)];
  assert(depth === 8 && (colorType === 2 || colorType === 6) &&
    compression === 0 && filter === 0 && interlace === 0,
  'The device capture is an 8-bit non-interlaced RGB or RGBA PNG');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks.filter(({ type }) => type === 'IDAT')
    .map(({ data }) => data)));
  const stride = width * channels;
  assert.equal(raw.length, height * (stride + 1), 'The device capture holds every row');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const kind = raw[y * (stride + 1)]!;
    assert(kind <= 4, 'The device capture uses a known row filter');
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels]! : 0;
      const b = y > 0 ? pixels[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels]! : 0;
      const value = raw[line + x]!;
      const predicted = kind === 0 ? 0 : kind === 1 ? a : kind === 2 ? b
        : kind === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, colorType, pixels };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode unfiltered rows as a minimal PNG: IHDR, one IDAT and IEND, no text. */
export function encodePng(image: DecodedPng): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, image.colorType, 0, 0, 0], 8);
  const stride = image.width * image.channels;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++)
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Crop a decoded image to a device-pixel rectangle that must lie inside it. */
export function cropPng(
  image: DecodedPng,
  crop: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): DecodedPng {
  assert(crop.left >= 0 && crop.top >= 0 &&
    crop.left + crop.width <= image.width && crop.top + crop.height <= image.height,
  'The leaf crop lies inside the device capture');
  const stride = image.width * image.channels;
  const width = crop.width * image.channels;
  const pixels = Buffer.alloc(crop.height * width);
  for (let y = 0; y < crop.height; y++) {
    const from = (crop.top + y) * stride + crop.left * image.channels;
    image.pixels.copy(pixels, y * width, from, from + width);
  }
  return { ...image, width: crop.width, height: crop.height, pixels };
}

function meanLuminance(image: DecodedPng): number {
  let total = 0;
  for (let offset = 0; offset < image.pixels.length; offset += image.channels)
    total += 0.2126 * image.pixels[offset]! + 0.7152 * image.pixels[offset + 1]! +
      0.0722 * image.pixels[offset + 2]!;
  return Math.round(total / (image.width * image.height));
}

/**
 * Capture exactly the measured spoiler leaf as the device shows it. The leaf
 * box (viewport CSS pixels, proved by the contract's scope checks) is mapped to
 * device pixels with the client's read-only `nativeRect`, the mapping native
 * taps use; the device screen is read with `screencap` and cropped in memory,
 * so only the leaf's pixels are ever written. Evidence only, never an oracle.
 */
export async function captureSpoilerLeaf(
  client: Pick<AccountWorkspaceClient, 'device' | 'nativeRect' | 'output'>,
  state: SpoilerCaptureState,
  clip: SpoilerClip,
  paint: { readonly color: string; readonly backgroundColor: string },
): Promise<SpoilerCaptureMetadata> {
  const native = await client.nativeRect(clip);
  const crop = nativeCrop(native);
  const screen = decodePng(Buffer.from(await client.device.adb(
    'exec-out', 'sh', '-c', 'screencap -p | base64 -w 0'), 'base64'));
  const leaf = cropPng(screen, crop);
  const png = encodePng(leaf);
  const dimensions = pngDimensions(png);
  assertRasterMatchesNative(dimensions, native);
  assert(!pngChunkTypes(png).some((type) => TEXT_CHUNKS.has(type)),
    'The scoped capture carries no text chunk');
  const name = SPOILER_CAPTURE_NAMES[state];
  const metadata: SpoilerCaptureMetadata = {
    schemaVersion: 1,
    scope: 'spoiler-leaf',
    source: 'device-screencap',
    state,
    sha256: digest(png),
    width: dimensions.width,
    height: dimensions.height,
    clip,
    native: { topLeft: native.topLeft, bottomRight: native.bottomRight },
    meanLuminance: meanLuminance(leaf),
    color: paint.color,
    backgroundColor: paint.backgroundColor,
  };
  await writeFile(join(client.output, `${name}.png`), png);
  await writeFile(join(client.output, `${name}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

const allowedRaster = (output: string, path: string): SpoilerCaptureState | null => {
  const parts = relative(output, path).split(sep);
  if (parts.length !== 2) return null;
  const [stage, file] = parts as [string, string];
  if (!MESSAGE_SPOILER_STAGES.some((entry) => entry.id === stage)) return null;
  const state = (Object.keys(SPOILER_CAPTURE_NAMES) as SpoilerCaptureState[])
    .find((key) => `${SPOILER_CAPTURE_NAMES[key]}.png` === file);
  return state ?? null;
};

/** A scoped raster is valid only with its matching metadata beside it. */
async function assertScopedRaster(path: string, state: SpoilerCaptureState): Promise<void> {
  const png = await readFile(path);
  const metadata = await readJsonObject(path.replace(/\.png$/u, '.json'));
  const dimensions = pngDimensions(png);
  assert(metadata['schemaVersion'] === 1 && metadata['scope'] === 'spoiler-leaf' &&
    metadata['state'] === state, 'Scoped raster metadata names its leaf state');
  assert.equal(metadata['sha256'], digest(png), 'Scoped raster metadata matches its bytes');
  assert(metadata['width'] === dimensions.width && metadata['height'] === dimensions.height,
    'Scoped raster metadata matches its dimensions');
  assert(metadata['source'] === 'device-screencap',
    'Scoped raster metadata names its device source');
  const native = metadata['native'] as NativeClip | undefined;
  assert(native && typeof native === 'object' && native.topLeft && native.bottomRight,
    'Scoped raster metadata records its native clip');
  assertRasterMatchesNative(dimensions, native);
  assert(!pngChunkTypes(png).some((type) => TEXT_CHUNKS.has(type)),
    'Scoped raster carries no text chunk');
}

/**
 * Redact text and remove every raster except a valid leaf-scoped capture
 * before the final fail-closed scan. Maestro's own image removal is off so
 * the scoped captures survive; this walk owns raster removal instead.
 */
export async function scrubMessageSpoilerArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  await redactMaestroArtifacts(output, secrets, false);
  const scrub = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scrub(path);
      else {
        assert(entry.isFile(), 'Message-spoiler diagnostic is a regular file');
        const extension = extname(path).toLowerCase();
        if (publishableText.has(extension)) {
          const value = await readFile(path, 'utf8');
          const redacted = redactDiagnosticText(value, secrets);
          if (redacted !== value) await writeFile(path, redacted, 'utf8');
        }
      }
    }
  };
  await scrub(output);
  const rasters = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rasters(path);
        continue;
      }
      if (!raster.has(extname(path).toLowerCase())) continue;
      const state = extname(path) === '.png' ? allowedRaster(output, path) : null;
      let keep = false;
      if (state) {
        try {
          await assertScopedRaster(path, state);
          keep = true;
        } catch {
          keep = false;
        }
      }
      if (!keep) await unlink(path);
    }
  };
  await rasters(output);
}

/** Reject unredacted identifiers, authorization, native storage payloads and unscoped rasters. */
export async function scanMessageSpoilerArtifacts(
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
      assert(entry.isFile(), 'Message-spoiler diagnostic is a regular file');
      if (raster.has(extname(path).toLowerCase())) {
        const state = extname(path) === '.png' ? allowedRaster(output, path) : null;
        assert(state, 'Only leaf-scoped spoiler rasters in message-spoiler diagnostics');
        await assertScopedRaster(path, state);
        continue;
      }
      assert(entry.name === 'publication-safe' ||
        publishableText.has(extname(path).toLowerCase()),
      'Message-spoiler diagnostics contain only recognized text files');
      const value = await readFile(path, 'utf8');
      for (const secret of values)
        assert(!value.includes(secret), 'No raw credential or identifier in message-spoiler diagnostics');
      for (const pattern of encoded)
        assert(!pattern.test(value), 'No URL-encoded credential or identifier in message-spoiler diagnostics');
      assert(!/syt_|\bBearer\s+\S+/iu.test(value),
        'Authorization absent from message-spoiler diagnostics');
      assert(!/access_token["']?\s*[:=]\s*["']?[\w.~-]{8,}/iu.test(value),
        'Query-string and JSON access tokens absent from message-spoiler diagnostics');
      assert(!new RegExp(EVENT_ID_SHAPE.source, 'iu').test(value),
        'No Matrix event id in message-spoiler diagnostics');
      assert(!/<(?:map\b|string\b)[^>]*>/iu.test(value),
        'Raw native Preferences XML absent from message-spoiler diagnostics');
      assert(nativeStorageMethodDataIsRedacted(value, 'Preferences'),
        'Preferences diagnostic data is redacted');
      assert(nativeStorageMethodDataIsRedacted(value, 'SecureStorage'),
        'SecureStorage diagnostic data is redacted');
    }
  };
  await scan(output);
}

async function requireFile(path: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size > 0,
    'Required message-spoiler capture or provenance exists');
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  await requireFile(path);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(typeof value === 'object' && value !== null && !Array.isArray(value),
    'Message-spoiler diagnostic JSON is an object');
  return value as Record<string, unknown>;
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function assertPassedReport(report: Record<string, unknown>): void {
  assert(report['status'] === 'passed' &&
    report['expectedStages'] === MESSAGE_SPOILER_STAGES.length &&
    report['expectedAssertionRecords'] === MESSAGE_SPOILER_ASSERTION_RECORDS &&
    report['attempt'] === 1 && report['retries'] === 0,
  'Message-spoiler report has every successful unretried stage');
  assert(Array.isArray(report['stages']) &&
    report['stages'].length === MESSAGE_SPOILER_STAGES.length,
  'Message-spoiler report has exactly the contract stages');
  const identities = new Set<unknown>();
  MESSAGE_SPOILER_STAGES.forEach((entry, index) => {
    const stage = (report['stages'] as unknown[])[index] as Record<string, unknown>;
    assert(typeof stage === 'object' && stage !== null,
      'Message-spoiler stage report is an object');
    assert(stage['id'] === entry.id && stage['status'] === 'passed' &&
      stage['attempt'] === 1 && stage['retries'] === 0 &&
      stage['expectedAssertionRecords'] === entry.expectedAssertionRecords &&
      stage['assertionRecords'] === entry.assertions.length &&
      stage['failureCount'] === 0,
    `Message-spoiler stage ${index + 1} is ${entry.id} with every record passed`);
    assert.deepEqual(stage['assertions'], [...entry.assertions],
      `Message-spoiler ${entry.id} parity identities are complete and source ordered`);
    for (const identity of entry.assertions) identities.add(identity);
  });
  assert.equal(identities.size, MESSAGE_SPOILER_ASSERTION_RECORDS,
    'Message-spoiler parity identities are unique across stages');
}

/** Only a complete, captured, cleaned one-stage run may receive the hosted upload marker. */
export async function markMessageSpoilerDiagnosticsSafe(
  output: string,
  secrets: Readonly<Record<string, string>>,
  flags: Readonly<MessageSpoilerPublicationSafety>,
  signal: AbortSignal | undefined,
  report: object,
): Promise<void> {
  const marker = join(output, 'publication-safe');
  try {
    signal?.throwIfAborted();
    assert(!flags.unsafeSecrets && !flags.cleanupFailed && !flags.scrubFailed,
      'Incomplete secrets, cleanup or scrub blocks message-spoiler publication');
    const current = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assertPassedReport(current);
    assert.deepEqual(await readJsonObject(join(output, 'journeys.json')), current,
      'Persisted message-spoiler report matches the run');
    const provenance = await readJsonObject(join(output, 'runtime-provenance.json'));
    const installed = provenance['profile'] as Record<string, unknown> | undefined;
    assert(provenance['schemaVersion'] === 1 && typeof installed === 'object' && installed !== null,
      'Message-spoiler runtime provenance records its profile');
    assert.deepEqual(installed, {
      requested: DESKTOP_ACCOUNT_PROFILE,
      digest: digest(JSON.stringify(DESKTOP_ACCOUNT_PROFILE)),
    }, 'Message-spoiler runtime provenance used the desktop profile');
    for (const entry of MESSAGE_SPOILER_STAGES) {
      const directory = join(output, entry.id);
      const applied = await readJsonObject(join(directory, 'profile-applied.json'));
      assert.deepEqual(applied['requested'], DESKTOP_ACCOUNT_PROFILE,
        `Message-spoiler ${entry.id} applied the desktop profile`);
      for (const name of PASSED_CAPTURES)
        await requireFile(join(directory, name));
      for (const name of PASSED_RASTERS) {
        await requireFile(join(directory, `${name}.png`));
        await requireFile(join(directory, `${name}.json`));
      }
      assert(await absent(join(directory, `${SPOILER_CAPTURE_NAMES.failed}.png`)),
        'A passing run carries no failure capture');
    }
    await scanMessageSpoilerArtifacts(output, secrets);
    signal?.throwIfAborted();
    await writeFile(marker, 'scanned\n', { signal });
    signal?.throwIfAborted();
  } catch (error) {
    await rm(marker, { force: true });
    throw error;
  }
}

/** Run every local teardown step, even after a prior one fails. */
export async function runMessageSpoilerStageCleanup(
  actions: readonly (() => Promise<void>)[],
  failures: unknown[],
): Promise<void> {
  for (const action of actions) {
    try { await action(); }
    catch (error) { failures.push(error); }
  }
}

/** A late abort must not retain a success report or publication marker. */
export async function revokeMessageSpoilerPublicationOnAbort(
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
  if (stage) stage.error = 'Cancelled before message-spoiler publication';
  await writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
}
