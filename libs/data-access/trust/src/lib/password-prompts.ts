import { EMPTY, type Observable, concatMap, defer, of, throwError } from 'rxjs';
import {
  EngineRequestError,
  type EngineResult,
  type PasswordPrompt,
} from '@trinity/util/matrix';
import type { InteractiveUpdate, TrustEngine } from './trust-engine';

/**
 * Runs an interactive engine command, answering each password prompt from `prompt`, and
 * emits its one result. Unsubscribing stops the command, which cancels an open prompt.
 */
export function answerPasswordPrompts<T>(
  engine: Pick<TrustEngine, 'answerPrompt'>,
  accountId: string,
  updates: Observable<InteractiveUpdate<T>>,
  prompt: PasswordPrompt,
): Observable<EngineResult<T>> {
  return updates.pipe(
    concatMap((update) =>
      update.kind === 'done'
        ? of(update.result)
        : defer(() => prompt()).pipe(
            concatMap((password) =>
              engine.answerPrompt(accountId, update.promptId, password),
            ),
            concatMap((answered) =>
              answered.ok
                ? EMPTY
                : throwError(() => new EngineRequestError(answered.failure)),
            ),
          ),
    ),
  );
}
