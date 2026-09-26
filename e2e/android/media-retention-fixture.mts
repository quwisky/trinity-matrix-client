import assert from 'node:assert/strict';
import { randomUUID, webcrypto as crypto } from 'node:crypto';
import { createNodeAccount } from '../support/node-account.mts';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  MEDIA_RETENTION_ENCRYPTED_FILENAME,
  MEDIA_RETENTION_PLAIN_FILENAME,
  MEDIA_RETENTION_PNG_BASE64,
  type MediaRetentionAttachmentKind,
} from './media-retention-contract.mts';

type MediaRetentionAccount = Awaited<ReturnType<typeof createNodeAccount>>;
type MatrixRecord = Record<string, unknown>;

export interface MediaRetentionRoomReceipt {
  readonly id: string;
  readonly name: string;
}

export interface MediaRetentionAttachmentReceipt {
  readonly kind: MediaRetentionAttachmentKind;
  readonly filename: string;
  readonly eventId: string;
  readonly byteLength: number;
}

export interface MediaRetentionFixtureProof {
  readonly plaintextEventReady: true;
  readonly encryptedEventReady: true;
  readonly distinctContentUris: true;
  readonly distinctEventIds: true;
  readonly encryptedBytesDiffer: true;
  readonly aesCtr256: true;
  readonly lowerCounterHalfZero: true;
  readonly ciphertextHashVerified: true;
}

export interface MediaRetentionFixture {
  readonly account: MediaRetentionAccount;
  readonly roomA: MediaRetentionRoomReceipt;
  readonly roomB: MediaRetentionRoomReceipt;
  readonly attachments: readonly [
    MediaRetentionAttachmentReceipt,
    MediaRetentionAttachmentReceipt,
  ];
  readonly proof: MediaRetentionFixtureProof;
  close(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;

function matrixRecord(value: unknown, description: string): MatrixRecord {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    description,
  );
  return value as MatrixRecord;
}

function stringField(
  value: MatrixRecord,
  field: string,
  description: string,
): string {
  const fieldValue = value[field];
  assert(typeof fieldValue === 'string' && fieldValue, description);
  return fieldValue;
}

function encodeUnpaddedBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/u, '');
}

function boundedSignal(parent?: AbortSignal): AbortSignal {
  return parent
    ? AbortSignal.any([parent, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/**
 * Arrange the exact retained-media server state. Attachment secrets never
 * leave this closure; callers receive only event-scoped, non-secret receipts.
 */
export async function openMediaRetentionFixture(
  resources: MatrixTestResources,
  signal: AbortSignal,
): Promise<MediaRetentionFixture> {
  const account = await createNodeAccount(
    resources,
    signal,
    'media-retention',
  );
  let token: string | undefined;
  let plaintext = Uint8Array.from(
    Buffer.from(MEDIA_RETENTION_PNG_BASE64, 'base64'),
  );
  let ciphertext = new Uint8Array();
  let iv = new Uint8Array(16);
  let ciphertextHash = new Uint8Array();
  let exportedKey: JsonWebKey | undefined;
  let roomIds: string[] = [];
  let closed = false;

  async function jsonRequest(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
    parentSignal: AbortSignal = signal,
  ): Promise<MatrixRecord> {
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: boundedSignal(parentSignal),
    });
    assert.equal(
      response.status,
      200,
      `Media-retention fixture ${method} ${path.split('?')[0]}`,
    );
    return matrixRecord(
      await response.json(),
      `Media-retention fixture ${method} response`,
    );
  }

  async function upload(
    filename: string,
    bytes: Uint8Array,
    contentType: 'image/png' | 'application/octet-stream',
  ): Promise<string> {
    assert(token, 'Media-retention fixture upload session');
    const response = await fetch(
      `${SYNAPSE_HTTP}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body: new Blob([Uint8Array.from(bytes).buffer], { type: contentType }),
        signal: boundedSignal(signal),
      },
    );
    assert.equal(response.status, 200, `Upload ${filename}`);
    const responseBody = matrixRecord(
      await response.json(),
      `Upload ${filename} response`,
    );
    const contentUri = stringField(
      responseBody,
      'content_uri',
      `Upload ${filename} content URI`,
    );
    assert(contentUri.startsWith('mxc://'), `Upload ${filename} MXC URI`);
    return contentUri;
  }

  async function sendImage(
    roomId: string,
    filename: string,
    content: MatrixRecord,
  ): Promise<string> {
    const transactionId = randomUUID();
    const response = await jsonRequest(
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT',
      content,
    );
    const eventId = stringField(
      response,
      'event_id',
      `Send ${filename} event id`,
    );
    const event = await jsonRequest(
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
      'GET',
    );
    assert.equal(event['type'], 'm.room.message', `${filename} event type`);
    assert.equal(event['sender'], account.userId, `${filename} sender`);
    const eventContent = matrixRecord(
      event['content'],
      `${filename} event content`,
    );
    assert.equal(eventContent['msgtype'], 'm.image', `${filename} msgtype`);
    assert.equal(eventContent['body'], filename, `${filename} body`);
    return eventId;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    const cleanupToken = token;
    if (cleanupToken) {
      for (const roomId of roomIds) {
        for (const action of ['leave', 'forget'] as const) {
          try {
            await jsonRequest(
              `/rooms/${encodeURIComponent(roomId)}/${action}`,
              'POST',
              {},
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await jsonRequest(
          '/logout',
          'POST',
          {},
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    token = undefined;
    roomIds = [];
    plaintext.fill(0);
    ciphertext.fill(0);
    iv.fill(0);
    ciphertextHash.fill(0);
    plaintext = new Uint8Array();
    ciphertext = new Uint8Array();
    iv = new Uint8Array();
    ciphertextHash = new Uint8Array();
    exportedKey = undefined;
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Media-retention fixture cleanup failed',
      );
    }
  }

  resources.cleanup('Media-retention fixture', close);

  const login = await jsonRequest('/login', 'POST', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: account.username },
    password: account.password,
    initial_device_display_name: 'Media retention fixture',
  });
  assert.equal(login['user_id'], account.userId, 'Fixture login identity');
  token = stringField(login, 'access_token', 'Fixture access token');

  const roomAName = resources.roomName('media-retention-a');
  const roomBName = resources.roomName('media-retention-b');
  const roomAResponse = await jsonRequest('/createRoom', 'POST', {
    name: roomAName,
    preset: 'private_chat',
  });
  const roomBResponse = await jsonRequest('/createRoom', 'POST', {
    name: roomBName,
    preset: 'private_chat',
  });
  const roomA = {
    id: stringField(roomAResponse, 'room_id', 'Room A id'),
    name: roomAName,
  };
  const roomB = {
    id: stringField(roomBResponse, 'room_id', 'Room B id'),
    name: roomBName,
  };
  roomIds = [roomA.id, roomB.id];

  assert(plaintext.length > 0, 'Pinned PNG decoded to bytes');
  const plainContentUri = await upload(
    MEDIA_RETENTION_PLAIN_FILENAME,
    plaintext,
    'image/png',
  );
  const plainEventId = await sendImage(
    roomA.id,
    MEDIA_RETENTION_PLAIN_FILENAME,
    {
      msgtype: 'm.image',
      body: MEDIA_RETENTION_PLAIN_FILENAME,
      url: plainContentUri,
      info: {
        mimetype: 'image/png',
        size: plaintext.byteLength,
        w: 1,
        h: 1,
      },
    },
  );

  crypto.getRandomValues(iv.subarray(0, 8));
  assert(
    iv.subarray(0, 8).some((byte) => byte !== 0),
    'AES-CTR IV random half is non-zero',
  );
  assert(
    iv.subarray(8).every((byte) => byte === 0),
    'AES-CTR lower counter half is zero',
  );
  const encryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  exportedKey = await crypto.subtle.exportKey('jwk', encryptionKey);
  assert.equal(exportedKey.kty, 'oct', 'Encrypted attachment JWK type');
  assert.equal(exportedKey.alg, 'A256CTR', 'Encrypted attachment JWK algorithm');
  assert.equal(exportedKey.ext, true, 'Encrypted attachment JWK extractable');
  assert.deepEqual(
    exportedKey.key_ops,
    ['encrypt', 'decrypt'],
    'Encrypted attachment JWK operations',
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    encryptionKey,
    plaintext,
  );
  ciphertext = new Uint8Array(encrypted);
  assert.equal(
    ciphertext.byteLength,
    plaintext.byteLength,
    'AES-CTR preserves byte length',
  );
  assert.notDeepEqual(
    ciphertext,
    plaintext,
    'Encrypted bytes differ from plaintext',
  );
  ciphertextHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', ciphertext),
  );
  assert.equal(ciphertextHash.byteLength, 32, 'Ciphertext SHA-256 length');
  const encryptedContentUri = await upload(
    MEDIA_RETENTION_ENCRYPTED_FILENAME,
    ciphertext,
    'application/octet-stream',
  );
  const encryptedEventId = await sendImage(
    roomA.id,
    MEDIA_RETENTION_ENCRYPTED_FILENAME,
    {
      msgtype: 'm.image',
      body: MEDIA_RETENTION_ENCRYPTED_FILENAME,
      file: {
        url: encryptedContentUri,
        v: 'v2',
        key: exportedKey,
        iv: encodeUnpaddedBase64(iv),
        hashes: { sha256: encodeUnpaddedBase64(ciphertextHash) },
      },
      info: {
        mimetype: 'image/png',
        size: plaintext.byteLength,
        w: 1,
        h: 1,
      },
    },
  );

  assert(
    plainContentUri !== encryptedContentUri,
    'Plaintext and encrypted content URIs are distinct',
  );
  assert(
    plainEventId !== encryptedEventId,
    'Plaintext and encrypted event ids are distinct',
  );

  return {
    account,
    roomA,
    roomB,
    attachments: [
      {
        kind: 'plain',
        filename: MEDIA_RETENTION_PLAIN_FILENAME,
        eventId: plainEventId,
        byteLength: plaintext.byteLength,
      },
      {
        kind: 'encrypted',
        filename: MEDIA_RETENTION_ENCRYPTED_FILENAME,
        eventId: encryptedEventId,
        byteLength: ciphertext.byteLength,
      },
    ],
    proof: {
      plaintextEventReady: true,
      encryptedEventReady: true,
      distinctContentUris: true,
      distinctEventIds: true,
      encryptedBytesDiffer: true,
      aesCtr256: true,
      lowerCounterHalfZero: true,
      ciphertextHashVerified: true,
    },
    close,
  };
}
