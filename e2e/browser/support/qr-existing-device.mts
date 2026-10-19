import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { QrCodeData } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  ClientEvent,
  Method,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk/lib/index.js';
import {
  MSC4108RendezvousSession,
  MSC4108SecureChannel,
  MSC4108SignInWithQR,
} from 'matrix-js-sdk/lib/rendezvous/index.js';
import decodeQr from 'qr/decode.js';
import type { Locator } from '../../fixtures.mts';

const exec = promisify(execFile);

/** Resolve once `check` holds, checking twice a second for 30 s. */
async function poll(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Loglevel {
  methodFactory: () => () => void;
  getLoggers(): Record<string, Loglevel>;
  rebuild(): void;
}

/**
 * Silence the SDK in the test runner: its loggers, the crypto's among them, write to the
 * console at debug level. They are loglevel loggers, and each child copies its parent's
 * factory, so replacing the factory everywhere silences the ones created later too.
 */
function silenceSdkLogs(): void {
  const loglevel = createRequire(import.meta.resolve('matrix-js-sdk'))(
    'loglevel',
  ) as Loglevel;
  const silent = () => () => undefined;
  loglevel.methodFactory = silent;
  for (const child of Object.values(loglevel.getLoggers())) {
    child.methodFactory = silent;
    child.rebuild();
  }
}

/** The pixels of a rendered QR code, read back from the page that shows it. */
export async function readQrBytes(image: Locator): Promise<Uint8Array> {
  const frame = await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas');
    context.drawImage(img, 0, 0);
    const { data, width, height } = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return { data: Array.from(data), width, height };
  });
  const segments: Uint8Array[] = [];
  decodeQr(
    {
      data: Uint8Array.from(frame.data),
      width: frame.width,
      height: frame.height,
    },
    {
      textDecoder: (bytes: Uint8Array) => {
        segments.push(Uint8Array.from(bytes));
        return '';
      },
    },
  );
  return Uint8Array.from(segments.flatMap((segment) => [...segment]));
}

/** A QR sign-in server the journeys run on, and the account they sign in with there. */
export type QrServerKind = 'mas' | 'tuwunel-oauth';
export interface QrAccount {
  readonly hs: string;
  readonly user: string;
  readonly pass: string;
}

/** An access token for a new device of `account`, without the app's sign-in. */
async function accessTokenFor(
  account: QrAccount,
  server: QrServerKind,
): Promise<string> {
  if (server === 'tuwunel-oauth') {
    // Tuwunel keeps password login on the API beside its OAuth server.
    const { access_token } = await createClient({
      baseUrl: account.hs,
    }).loginRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.user },
      password: account.pass,
    });
    return access_token;
  }
  // MAS turns password login off; its CLI issues a compatibility token, the way the stack
  // seeds accounts.
  const { stdout, stderr } = await exec('docker', [
    'exec',
    'trinity-e2e-mas',
    'mas-cli',
    'manage',
    'issue-compatibility-token',
    account.user,
  ]);
  const accessToken = /mct_[A-Za-z0-9_]+/.exec(`${stdout}\n${stderr}`)?.[0];
  if (!accessToken) throw new Error('MAS issued no compatibility token');
  return accessToken;
}

/**
 * A signed-in, cross-signed device with a key backup, driven by matrix-js-sdk in Node: the
 * first device of a journey's account, which links the app's first device. Nothing it holds
 * is logged.
 */
export class ExistingDevice {
  private constructor(
    readonly client: MatrixClient,
    readonly userId: string,
  ) {}

  /** Sign `account` in on a new Node device and give it an identity and a key backup. */
  static async signIn(
    account: QrAccount,
    server: QrServerKind,
  ): Promise<ExistingDevice> {
    silenceSdkLogs();
    const accessToken = await accessTokenFor(account, server);
    const whoami = createClient({ baseUrl: account.hs, accessToken });
    const { user_id: userId, device_id: deviceId } = await whoami.whoami();
    const client = createClient({
      baseUrl: account.hs,
      accessToken,
      userId,
      deviceId,
    });
    try {
      await client.initRustCrypto({ useIndexedDB: false });
      const prepared = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the first sync did not finish in 30 s')),
          30_000,
        );
        client.on(ClientEvent.Sync, (state) => {
          if (state === SyncState.Prepared) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      await client.startClient({ initialSyncLimit: 1 });
      await prepared;
      const crypto = client.getCrypto()!;
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        // Synapse lets a fresh account publish its first identity without asking; Tuwunel
        // asks for the password.
        authUploadDeviceSigningKeys: async (makeRequest) => {
          try {
            await makeRequest(null);
          } catch (error) {
            const session = (error as { data?: { session?: string } }).data
              ?.session;
            if (!session) throw error;
            await makeRequest({
              type: 'm.login.password',
              identifier: { type: 'm.id.user', user: account.user },
              password: account.pass,
              session,
            });
          }
        },
      });
      // The backup key travels with the identity, so a linked device can read history.
      await crypto.resetKeyBackup();
    } catch (error) {
      client.stopClient();
      throw error;
    }
    return new ExistingDevice(client, userId);
  }

  /** Send `body` to a new encrypted room named `name`, and wait until its key is backed up. */
  async sendEncrypted(name: string, body: string): Promise<void> {
    const { room_id: roomId } = await this.client.createRoom({
      name,
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    });
    const crypto = this.client.getCrypto()!;
    await poll('the room to be encrypted on this device', () =>
      crypto.isEncryptionEnabledInRoom(roomId),
    );
    await this.client.sendTextMessage(roomId, body);
    const version = await crypto.getActiveSessionBackupVersion();
    if (!version) throw new Error('the key backup is not active');
    await poll('the room key to reach the backup', async () => {
      const keys = await this.client.http
        .authedRequest<{ sessions?: Record<string, unknown> }>(
          Method.Get,
          `/room_keys/keys/${encodeURIComponent(roomId)}`,
          { version },
        )
        .catch(() => ({ sessions: {} }));
      return Object.keys(keys.sessions ?? {}).length > 0;
    });
  }

  /** Scan the new device's code; resolves with the flow once the channel is up. */
  async scan(qrBytes: Uint8Array): Promise<MSC4108SignInWithQR> {
    const qr = QrCodeData.fromBytes(qrBytes);
    const session = new MSC4108RendezvousSession({ url: qr.rendezvousUrl! });
    const channel = new MSC4108SecureChannel(session, qr.publicKey);
    const flow = new MSC4108SignInWithQR(channel, true, this.client);
    await flow.negotiateProtocols();
    return flow;
  }

  /**
   * Whether the server holds a signature of `deviceId` by the account's self-signing key.
   * Asked of the server, because this device's own view waited past 30 s on Tuwunel for the
   * device-list change that refreshes it.
   */
  async crossSigned(deviceId: string): Promise<boolean> {
    const keys = await this.client.http.authedRequest<{
      self_signing_keys?: Record<string, { keys: Record<string, string> }>;
      device_keys?: Record<
        string,
        Record<string, { signatures?: Record<string, Record<string, string>> }>
      >;
    }>(Method.Post, '/keys/query', undefined, {
      device_keys: { [this.userId]: [] },
    });
    const selfSigning = Object.keys(
      keys.self_signing_keys?.[this.userId]?.keys ?? {},
    );
    const signatures =
      keys.device_keys?.[this.userId]?.[deviceId]?.signatures?.[this.userId] ??
      {};
    return selfSigning.some((keyId) => keyId in signatures);
  }

  stop(): void {
    this.client.stopClient();
  }
}
