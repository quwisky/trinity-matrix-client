import { map, type OperatorFunction } from 'rxjs';
import { type EngineResult, unwrapEngineResult } from '@trinity/util/matrix';

/** {@link unwrapEngineResult}, with an Account that stopped being live failing as the guards do. */
export function unwrapOwned<T>(
  notLive = 'Not signed in.',
): OperatorFunction<EngineResult<T>, T> {
  return (source) =>
    source.pipe(
      map((result) => {
        if (!result.ok && result.failure.code === 'account-not-live') {
          throw new Error(notLive);
        }
        return result;
      }),
      unwrapEngineResult<T>(),
    );
}
