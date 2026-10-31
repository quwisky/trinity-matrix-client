import {
  createServer,
  request,
  Agent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { testhostBinaryAvailable } from './engine-stdio-transport';
import { startHomeserverProxy, type HomeserverProxy } from './homeserver-proxy';
import { startTesthostAccount } from './rust-account';
import { registerSynapseUser } from './synapse-admin';

interface Seen {
  method: string;
  url: string;
  host: string;
  body: Buffer;
}

const SEND = '/_matrix/client/v3/rooms/!r:x/send/m.room.message/t1';
const UPLOAD = '/_matrix/media/v3/upload';

let upstream: Server;
let proxy: HomeserverProxy | undefined;
let seen: Seen[];
let upstreamHost: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Starts the stand-in upstream and a proxy to it; `handler` defaults to a 200 `ok`. */
async function setup(): Promise<{ target: string; proxy: HomeserverProxy }> {
  seen = [];
  handler = (_req, res) => res.end('ok');
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host ?? '',
        body: Buffer.concat(chunks),
      });
      handler(req, res);
    });
  });
  const target = await listen(upstream);
  upstreamHost = new URL(target).host;
  proxy = await startHomeserverProxy(target);
  return { target, proxy };
}

interface Answer {
  status: number;
  body: string;
}

function send(
  url: string,
  init: { method?: string; body?: Buffer | string; agent?: Agent } = {},
): Promise<
  Answer & { headers: IncomingMessage['headers']; reusedSocket: boolean }
> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method ?? 'GET', agent: init.agent ?? false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
            reusedSocket: req.reusedSocket,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

afterEach(async () => {
  await proxy?.dispose();
  proxy = undefined;
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
});

describe('homeserver proxy', () => {
  it('forwards a request and its answer unchanged', async () => {
    const { proxy } = await setup();
    handler = (_req, res) => {
      res.writeHead(201, { 'x-answer': 'yes' });
      res.end('created');
    };

    const answer = await send(`${proxy.baseUrl}/a/b?x=1&y=2`, {
      method: 'PUT',
      body: 'payload',
    });

    expect(answer).toMatchObject({ status: 201, body: 'created' });
    expect(answer.headers['x-answer']).toBe('yes');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'PUT', url: '/a/b?x=1&y=2' });
    expect(seen[0].body.toString()).toBe('payload');
    expect(seen[0].host).toBe(upstreamHost);
  });

  it('streams a response as it arrives', async () => {
    const { proxy } = await setup();
    let finish!: () => void;
    handler = (_req, res) => {
      res.write('first');
      finish = () => res.end();
    };

    const first = await new Promise<string>((resolve, reject) => {
      request(`${proxy.baseUrl}/stream`, { agent: false }, (res) =>
        res.once('data', (chunk: Buffer) => resolve(String(chunk))),
      )
        .on('error', reject)
        .end();
    });

    expect(first).toBe('first');
    finish();
  });

  it('keeps an idle connection past five seconds', async () => {
    const { proxy } = await setup();
    const agent = new Agent({ keepAlive: true });

    try {
      expect((await send(`${proxy.baseUrl}/one`, { agent })).status).toBe(200);
      await sleep(5500);
      const second = await send(`${proxy.baseUrl}/two`, { agent });
      expect(second.status).toBe(200);
      expect(second.reusedSocket).toBe(true);
    } finally {
      agent.destroy();
    }
    expect(seen).toHaveLength(2);
  }, 20_000);

  it('counts forwarded uploads and nothing else', async () => {
    const { proxy } = await setup();

    await send(`${proxy.baseUrl}${UPLOAD}?filename=a`, {
      method: 'POST',
      body: 'x',
    });
    await send(`${proxy.baseUrl}${UPLOAD}`);
    await send(`${proxy.baseUrl}/_matrix/media/v3/other`, {
      method: 'POST',
      body: 'x',
    });

    expect(proxy.uploads()).toBe(1);
    expect(seen).toHaveLength(3);
  });

  it('loses the answer to the next send, once', async () => {
    const { proxy } = await setup();
    proxy.dropNextSendResponse();

    await expect(
      send(`${proxy.baseUrl}${SEND}`, { method: 'PUT', body: '{}' }),
    ).rejects.toThrow();
    expect(seen.map((s) => s.url)).toEqual([SEND]);

    const next = await send(`${proxy.baseUrl}${SEND}`, {
      method: 'PUT',
      body: '{}',
    });
    expect(next).toMatchObject({ status: 200, body: 'ok' });
    expect(seen).toHaveLength(2);
  });

  it('refuses the next send, once, without forwarding it', async () => {
    const { proxy } = await setup();
    proxy.refuseNextSend();

    const refused = await send(`${proxy.baseUrl}${SEND}`, {
      method: 'PUT',
      body: '{}',
    });
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'refused by the test proxy',
    });
    expect(seen).toHaveLength(0);

    expect(
      (await send(`${proxy.baseUrl}${SEND}`, { method: 'PUT', body: '{}' }))
        .status,
    ).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('lets the refusal win over the drop, which stays armed', async () => {
    const { proxy } = await setup();
    proxy.dropNextSendResponse();
    proxy.refuseNextSend();

    const refused = await send(`${proxy.baseUrl}${SEND}`, { method: 'PUT' });
    expect(refused.status).toBe(502);
    expect(seen).toHaveLength(0);

    await expect(
      send(`${proxy.baseUrl}${SEND}`, { method: 'PUT' }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('leaves other requests to the send rules alone', async () => {
    const { proxy } = await setup();
    proxy.dropNextSendResponse();
    proxy.refuseNextSend();

    for (const path of [
      '/_matrix/client/v3/sendToDevice/m.x/t',
      '/_matrix/client/v3/rooms/!r:x/state/m.room.name/',
    ]) {
      expect(
        (await send(`${proxy.baseUrl}${path}`, { method: 'PUT', body: '{}' }))
          .status,
      ).toBe(200);
    }
    expect(seen).toHaveLength(2);

    expect(
      (await send(`${proxy.baseUrl}${SEND}`, { method: 'PUT' })).status,
    ).toBe(502);
    await expect(
      send(`${proxy.baseUrl}${SEND}`, { method: 'PUT' }),
    ).rejects.toThrow();
  });

  it('holds an upload until released', async () => {
    const { proxy } = await setup();
    const body = Buffer.alloc(1024 * 1024, 7);
    const release = proxy.holdUploads();

    const pending = send(`${proxy.baseUrl}${UPLOAD}`, { method: 'POST', body });
    await sleep(300);
    expect(seen).toHaveLength(0);
    expect(proxy.uploads()).toBe(0);

    release();
    const answer = await pending;

    expect(answer).toMatchObject({ status: 200, body: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0].body.equals(body)).toBe(true);
    expect(proxy.uploads()).toBe(1);
  });

  it('drops a held upload whose client hung up', async () => {
    const { proxy } = await setup();
    const release = proxy.holdUploads();
    const gone = request(`${proxy.baseUrl}${UPLOAD}`, {
      method: 'POST',
      agent: false,
    });
    gone.on('error', () => undefined);
    gone.end(Buffer.alloc(1024 * 1024, 7));
    await sleep(300);
    gone.destroy();
    await sleep(300);

    release();
    await sleep(300);
    expect(seen).toHaveLength(0);
    expect(proxy.uploads()).toBe(0);

    expect(
      (await send(`${proxy.baseUrl}${UPLOAD}`, { method: 'POST', body: 'x' }))
        .status,
    ).toBe(200);
    expect(proxy.uploads()).toBe(1);
  });

  it('answers 502 when the upstream refuses', async () => {
    const dead = createServer();
    const target = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    proxy = await startHomeserverProxy(target);
    upstream = dead;

    const answer = await send(`${proxy.baseUrl}/x`);

    expect(answer).toMatchObject({ status: 502, body: '' });
  });

  it('dispose ends open requests and frees the port', async () => {
    const { proxy: started } = await setup();
    handler = () => undefined;
    const port = Number(new URL(started.baseUrl).port);
    started.holdUploads();
    const held = send(`${started.baseUrl}${UPLOAD}`, {
      method: 'POST',
      body: 'x',
    }).catch((error: unknown) => error);
    const poll = send(`${started.baseUrl}/_matrix/client/v3/sync`).catch(
      (error: unknown) => error,
    );
    await sleep(300);

    await started.dispose();
    proxy = undefined;

    expect(await held).toBeInstanceOf(Error);
    expect(await poll).toBeInstanceOf(Error);
    await new Promise<void>((resolve, reject) => {
      connect(port, '127.0.0.1')
        .once('connect', () => reject(new Error('port still open')))
        .once('error', () => resolve());
    });
  });
});

describe.skipIf(
  !process.env['TRINITY_ENGINE_CONTRACT_HS'] || !testhostBinaryAvailable(),
)('homeserver proxy against Synapse', () => {
  it('a Rust account syncs through the proxy', async () => {
    const homeserver = process.env['TRINITY_ENGINE_CONTRACT_HS'] as string;
    const user = await registerSynapseUser(
      homeserver,
      process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] as string,
      `proxy-${Date.now().toString(36)}`,
    );
    const through = await startHomeserverProxy(homeserver);
    try {
      const account = await startTesthostAccount(through.baseUrl, user);
      await account.dispose();
    } finally {
      await through.dispose();
    }
  }, 90_000);
});
