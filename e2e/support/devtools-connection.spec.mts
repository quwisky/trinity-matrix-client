import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDevtoolsConnection } from './devtools-connection.mts';

const sockets = new Set<Socket>();

function websocketAccept(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

async function listenUnresponsivePeer(respondToHandshake = true): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly url: string;
}> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString();
      if (!request.includes('\r\n\r\n')) return;
      const key = /^Sec-WebSocket-Key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
      if (!key || !respondToHandshake) return;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      socket.removeAllListeners('data');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
});

describe('DevTools connection', () => {
  it('terminates when an unresponsive peer ignores the close handshake', async () => {
    const { server, url } = await listenUnresponsivePeer();
    const modulePath = fileURLToPath(
      new URL('./devtools-connection.mts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const { openDevtoolsConnection } = await import(${JSON.stringify(modulePath)}); const connection = await openDevtoolsConnection(${JSON.stringify(url)}, { timeoutMs: 1_000 }); connection.close(new Error('test close'));`,
      ],
      { stdio: 'ignore' },
    );
    try {
      expect(await waitForExit(child)).toBe(true);
      expect(child.exitCode).toBe(0);
    } finally {
      server.close();
    }
  }, 10_000);

  it('cancels while the websocket handshake is still pending', async () => {
    const { server, url } = await listenUnresponsivePeer(false);
    const controller = new AbortController();
    try {
      const connection = openDevtoolsConnection(url, {
        signal: controller.signal,
        timeoutMs: 1_000,
      });
      setTimeout(() => controller.abort(new Error('handshake cancelled')), 25);
      await expect(connection).rejects.toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  });
});
