import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

export interface HomeserverProxy {
  /** `http://127.0.0.1:<port>`: give it to `startTesthostAccount` instead of the homeserver's URL. */
  readonly baseUrl: string;
  /** `POST /_matrix/media/v3/upload` requests forwarded so far (files and thumbnails). */
  uploads(): number;
  /** The next `PUT …/rooms/{room}/send/{type}/{txn}` reaches the server; its answer is lost. One-shot. */
  dropNextSendResponse(): void;
  /** The next such send is answered 502 and not forwarded. One-shot, and wins over the drop. */
  refuseNextSend(): void;
  /** Holds uploads unforwarded and uncounted. The returned release forwards those whose client is still connected. */
  holdUploads(): () => void;
  /** Ends every open request and frees the port. Held uploads are dropped. */
  dispose(): Promise<void>;
}

const UPLOAD_PATH = '/_matrix/media/v3/upload';
const SEND_PATH = /^\/_matrix\/client\/v3\/rooms\/[^/]+\/send\//;
const NOT_FORWARDED = new Set(['host', 'connection', 'keep-alive']);

interface Held {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  gone: boolean;
}

/**
 * Starts a plain-HTTP proxy in front of `target`, so a spec can count uploads, hold them, and
 * refuse or lose a send. TLS to an https `target` follows `NODE_TLS_REJECT_UNAUTHORIZED`.
 * Node only, for tests.
 */
export async function startHomeserverProxy(
  target: string,
): Promise<HomeserverProxy> {
  const open = target.startsWith('https:') ? httpsRequest : httpRequest;
  let uploads = 0;
  let dropNext = false;
  let refuseNext = false;
  let holding = false;
  let held: Held[] = [];

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    body?: Buffer,
    loseAnswer = false,
  ): void {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !NOT_FORWARDED.has(name)),
    );
    const upstream = open(new URL(req.url ?? '/', target), {
      method: req.method,
      headers,
      agent: false,
    });
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else {
        res.statusCode = 502;
        res.end();
      }
    });
    upstream.on('response', (answer) => {
      answer.once('close', () => {
        if (!answer.complete) res.destroy();
      });
      if (loseAnswer) {
        answer.once('end', () => req.socket.destroy());
        answer.resume();
        return;
      }
      const answerHeaders = Object.fromEntries(
        Object.entries(answer.headers).filter(
          ([name]) => !NOT_FORWARDED.has(name),
        ),
      );
      res.writeHead(answer.statusCode ?? 502, answerHeaders);
      answer.pipe(res);
    });
    if (body) upstream.end(body);
    else req.pipe(upstream);
  }

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://proxy.invalid');
    const isUpload = req.method === 'POST' && pathname === UPLOAD_PATH;
    const isSend = req.method === 'PUT' && SEND_PATH.test(pathname);

    if (isSend && refuseNext) {
      refuseNext = false;
      req.resume();
      req.once('end', () => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"errcode":"M_UNKNOWN","error":"refused by the test proxy"}');
      });
    } else if (isUpload && holding) {
      // Read the body now: Node stops reading a socket past the high-water mark and would
      // never see the client hang up.
      const entry: Held = { req, res, body: Buffer.alloc(0), gone: false };
      const chunks: Buffer[] = [];
      res.once('close', () => (entry.gone = true));
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.once('end', () => {
        entry.body = Buffer.concat(chunks);
        held.push(entry);
      });
    } else {
      if (isUpload) uploads++;
      const lose = isSend && dropNext;
      if (lose) dropNext = false;
      forward(req, res, undefined, lose);
    }
  });
  // reqwest reuses idle connections and Node's default closes them at 5 s.
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    uploads: () => uploads,
    dropNextSendResponse: () => void (dropNext = true),
    refuseNextSend: () => void (refuseNext = true),
    holdUploads() {
      holding = true;
      return () => {
        holding = false;
        const released = held;
        held = [];
        for (const { req, res, body, gone } of released) {
          if (gone) continue;
          uploads++;
          forward(req, res, body);
        }
      };
    },
    dispose: () =>
      new Promise<void>((resolve) => {
        held = [];
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
