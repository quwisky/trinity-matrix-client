import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { QrCodeData } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  ClientEvent,
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
import type { MasAccount } from './mas.mts';

const exec = promisify(execFile);

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

/**
 * A signed-in, cross-signed device driven by matrix-js-sdk in Node: the "existing device"
 * of an MSC4108 sign-in, until the app can play that part itself. Its token is a MAS
 * compatibility token, issued through the CLI the way the stack seeds accounts. Nothing it
 * holds is logged.
 */
export class ExistingDevice {
  private constructor(
    readonly client: MatrixClient,
    readonly userId: string,
  ) {}

  /** Sign `account` in on a new Node device and give it a cross-signing identity. */
  static async signIn(account: MasAccount): Promise<ExistingDevice> {
    silenceSdkLogs();
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
    const whoami = createClient({ baseUrl: account.hs, accessToken });
    const { user_id: userId, device_id: deviceId } = await whoami.whoami();
    const client = createClient({
      baseUrl: account.hs,
      accessToken,
      userId,
      deviceId,
    });
    await client.initRustCrypto({ useIndexedDB: false });
    const prepared = new Promise<void>((resolve) => {
      client.on(ClientEvent.Sync, (state) => {
        if (state === SyncState.Prepared) resolve();
      });
    });
    await client.startClient({ initialSyncLimit: 1 });
    await prepared;
    // A fresh account's first identity needs no user-interactive auth.
    await client.getCrypto()!.bootstrapCrossSigning({
      setupNewCrossSigning: true,
      authUploadDeviceSigningKeys: (makeRequest) => makeRequest(null),
    });
    return new ExistingDevice(client, userId);
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

  /** Whether this device sees `deviceId` as signed by the account's cross-signing key. */
  async trusts(deviceId: string): Promise<boolean> {
    const crypto = this.client.getCrypto()!;
    await crypto.getUserDeviceInfo([this.userId], true);
    const status = await crypto.getDeviceVerificationStatus(
      this.userId,
      deviceId,
    );
    return status?.crossSigningVerified ?? false;
  }

  stop(): void {
    this.client.stopClient();
  }
}
