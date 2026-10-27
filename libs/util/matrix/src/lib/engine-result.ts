import { type OperatorFunction, map } from 'rxjs';
import type { MatrixRequestFailure } from './request-failure';

/** Outcome of an engine command: expected failures are values, faults error the stream. */
export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: MatrixRequestFailure };

export function engineOk<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

export function engineFail(failure: MatrixRequestFailure): EngineResult<never> {
  return { ok: false, failure };
}

export const NOT_SIGNED_IN: MatrixRequestFailure = {
  kind: 'authentication',
  message: 'Not signed in.',
  diagnostic: { kind: 'authentication' },
};

/** Carries an engine failure through code that expects a thrown error. */
export class EngineRequestError extends Error {
  constructor(readonly failure: MatrixRequestFailure) {
    super(failure.message);
    this.name = 'EngineRequestError';
  }
}

export function unwrapEngineResult<T>(): OperatorFunction<EngineResult<T>, T> {
  return map((result) => {
    if (!result.ok) throw new EngineRequestError(result.failure);
    return result.value;
  });
}

/** Throws a TypeError naming the first value that could not cross an engine boundary. */
export function assertPlainData(value: unknown, path = '$'): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (Number.isFinite(value)) return;
      break;
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((item, i) => assertPlainData(item, `${path}[${i}]`));
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        for (const [key, item] of Object.entries(value)) {
          assertPlainData(item, `${path}.${key}`);
        }
        return;
      }
      break;
    }
  }
  throw new TypeError(`Not plain data at ${path}`);
}
