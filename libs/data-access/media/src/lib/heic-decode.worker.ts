import libheif from 'libheif-js/wasm-bundle';
import type { HeicDecodeReply } from './heic-to-jpeg';

const scope = self as unknown as {
  postMessage(message: HeicDecodeReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
};

scope.onmessage = ({ data }) => {
  // The first image is the primary one; a sequence or burst keeps only it.
  const image = new libheif.HeifDecoder().decode(data)[0];
  if (!image) {
    scope.postMessage(null);
    return;
  }
  const width = image.get_width();
  const height = image.get_height();
  image.display(
    { data: new Uint8ClampedArray(width * height * 4), width, height },
    (decoded) => {
      if (!decoded) {
        scope.postMessage(null);
        return;
      }
      const rgba = decoded.data.buffer as ArrayBuffer;
      scope.postMessage({ width, height, rgba }, [rgba]);
    },
  );
};
