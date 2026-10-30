/** `T` without `readonly` at any depth, to compare a generated type with a hand-written one. */
export type DeepWritable<T> = T extends (...args: never[]) => unknown
  ? T
  : { -readonly [K in keyof T]: DeepWritable<T[K]> };
