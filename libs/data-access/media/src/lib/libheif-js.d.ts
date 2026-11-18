declare module 'libheif-js/wasm-bundle' {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (decoded: { data: Uint8ClampedArray } | null) => void,
    ): void;
  }

  const libheif: {
    HeifDecoder: new () => { decode(data: ArrayBuffer): HeifImage[] };
  };
  export default libheif;
}
