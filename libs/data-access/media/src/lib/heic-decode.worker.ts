import createLibheif from 'libheif-js/libheif-wasm/libheif.js';
import type { HeicDecodeReply, HeicDecodeRequest } from './heic-to-jpeg';

const scope = self as unknown as {
  postMessage(message: HeicDecodeReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<HeicDecodeRequest>) => void) | null;
  onerror: (() => void) | null;
  onunhandledrejection: (() => void) | null;
};

async function decode({
  bytes,
  wasmUrl,
}: HeicDecodeRequest): Promise<HeicDecodeReply> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    return null;
  }
  const wasmBinary = await response.arrayBuffer();
  // The factory hands back the module before the wasm has started.
  let libheif!: ReturnType<typeof createLibheif>;
  await new Promise<void>((ready, failed) => {
    libheif = createLibheif({
      wasmBinary,
      onRuntimeInitialized: ready,
      onAbort: failed,
    });
  });
  // The first image is the primary one; a sequence or burst keeps only it.
  const image = new libheif.HeifDecoder().decode(bytes)[0];
  if (!image) {
    return null;
  }
  const width = image.get_width();
  const height = image.get_height();
  return new Promise<HeicDecodeReply>((resolve) => {
    image.display(
      { data: new Uint8ClampedArray(width * height * 4), width, height },
      (decoded) =>
        resolve(
          decoded
            ? { width, height, rgba: decoded.data.buffer as ArrayBuffer }
            : null,
        ),
    );
  });
}

// A libheif abort or throw after start-up can surface outside the promise chain.
scope.onerror = scope.onunhandledrejection = () => scope.postMessage(null);

scope.onmessage = ({ data }) => {
  decode(data)
    .catch(() => null)
    .then((reply) => scope.postMessage(reply, reply ? [reply.rgba] : []));
};
