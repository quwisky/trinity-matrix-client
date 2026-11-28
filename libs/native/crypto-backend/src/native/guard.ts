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

// Absent before ES2026 runtimes; WASM's classes alias it only where it exists, and so does the shim.
const dispose = (Symbol as { readonly dispose?: symbol }).dispose;

/** `using` calls `[Symbol.dispose]`, which WASM aliases to `free`. */
function disposeAsFree(target: object, free: () => void): void {
  if (dispose) Object.defineProperty(target, dispose, { value: free });
}

/**
 * Puts a shim class's prototype on top of the guard of the WASM class it stands in for; its
 * `free` (which must release no wasm memory) also answers `[Symbol.dispose]`.
 */
export function standIn(
  shim: WasmClass<{ free(): void }>,
  real: WasmClass,
): void {
  // The guard replaces the class's prototype chain: members of its own base classes move onto it.
  for (
    let base = Object.getPrototypeOf(shim.prototype) as object | null;
    base && base !== Object.prototype;
    base = Object.getPrototypeOf(base) as object | null
  ) {
    for (const key of Reflect.ownKeys(base)) {
      if (key !== 'constructor' && !Object.hasOwn(shim.prototype, key)) {
        Object.defineProperty(
          shim.prototype,
          key,
          Object.getOwnPropertyDescriptor(base, key)!,
        );
      }
    }
  }
  Object.setPrototypeOf(shim.prototype, guardOf(real));
  disposeAsFree(shim.prototype, function (this: { free(): void }) {
    this.free();
  });
}

/**
 * A value object of a WASM class that JavaScript cannot construct (no public constructor):
 * the given fields as read-only own properties over the class's guard, and a `free` that
 * releases nothing. `secrets` become non-enumerable getters, so `JSON.stringify`, `console.log`
 * and error reporters that walk the object do not print them (WASM's object holds a pointer).
 */
export function wasmValue<T extends object>(
  real: WasmClass<T>,
  fields: object,
  secrets: object = {},
): T {
  const value = Object.create(guardOf(real)) as T;
  const free = (): void => undefined;
  for (const [key, field] of Object.entries({ ...fields, free })) {
    Object.defineProperty(value, key, {
      value: field,
      enumerable: key !== 'free',
    });
  }
  for (const [key, secret] of Object.entries(secrets)) {
    Object.defineProperty(value, key, { get: () => secret });
  }
  disposeAsFree(value, free);
  return Object.freeze(value);
}
