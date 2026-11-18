declare module 'libheif-js/libheif-wasm/libheif.js' {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (decoded: { data: Uint8ClampedArray } | null) => void,
    ): void;
  }

  interface Libheif {
    HeifDecoder: new () => { decode(data: ArrayBuffer): HeifImage[] };
  }

  const createLibheif: (options: {
    wasmBinary: ArrayBuffer;
    onRuntimeInitialized: () => void;
    onAbort: (reason: unknown) => void;
  }) => Libheif;
  export default createLibheif;
}
