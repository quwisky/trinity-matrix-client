// A wasm-bindgen class's members read `this.__wbg_ptr`; a shim object owns no wasm memory, so an
// inherited member would hand wasm an empty pointer. Every shim object therefore inherits from a
// guard of its class instead: the real prototype below it (so `instanceof` holds), and above it
// a stand-in for each member that throws, which the shim's own members shadow.

/** A WASM class by its prototype: many have a private constructor. */
export interface WasmClass<T extends object = object> {
  readonly prototype: T;
  readonly name: string;
}

const guards = new WeakMap<WasmClass, object>();

export class NotOnNativeError extends Error {
  public constructor(member: string) {
    super(`${member} is not implemented on native crypto`);
    this.name = 'NotOnNativeError';
  }
}

export function guardOf(real: WasmClass): object {
  const known = guards.get(real);
  if (known) return known;
  const guard = Object.create(real.prototype) as object;
  for (const key of Reflect.ownKeys(real.prototype)) {
    if (key === 'constructor') continue;
    const member = `${real.name}.${String(key)}`;
    const fail = (): never => {
      throw new NotOnNativeError(member);
    };
    const descriptor = Object.getOwnPropertyDescriptor(real.prototype, key);
    Object.defineProperty(
      guard,
      key,
      descriptor && 'value' in descriptor
        ? { value: fail, configurable: true }
        : { get: fail, set: fail, configurable: true },
    );
  }
  guards.set(real, guard);
  return guard;
}

/** Puts a shim class's prototype on top of the guard of the WASM class it stands in for. */
export function standIn(shim: WasmClass, real: WasmClass): void {
  Object.setPrototypeOf(shim.prototype, guardOf(real));
}

/**
 * A value object of a WASM class that JavaScript cannot construct (no public constructor):
 * the given fields as read-only own properties over the class's guard, and a `free` that
 * releases nothing.
 */
export function wasmValue<T extends object>(
  real: WasmClass<T>,
  fields: object,
): T {
  const value = Object.create(guardOf(real)) as T;
  const free = (): void => undefined;
  for (const [key, field] of Object.entries({ ...fields, free })) {
    Object.defineProperty(value, key, {
      value: field,
      enumerable: key !== 'free',
    });
  }
  return Object.freeze(value);
}
