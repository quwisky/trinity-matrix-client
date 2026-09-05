import {
  Observable,
  ReplaySubject,
  Subscription,
  map,
  race,
  take,
  timer,
} from 'rxjs';

/** One finite source whose ownership outlives any bounded observer. */
export class RetainedFirstResult<Key, Result> {
  readonly completion = new ReplaySubject<Result>(1);
  readonly owner = new Subscription();
  private started = false;

  constructor(readonly key: Key) {}

  start(
    source: Observable<Result>,
    onSettled: (
      result: Result,
      attempt: RetainedFirstResult<Key, Result>,
    ) => void,
  ): void {
    if (this.started) throw new Error('Retained attempt already started.');
    this.started = true;
    this.owner.add(
      source.pipe(take(1)).subscribe((result) => {
        if (this.owner.closed) return;
        onSettled(result, this);
        this.completion.next(result);
        this.completion.complete();
        this.owner.unsubscribe();
      }),
    );
  }

  observe(budgetMs: number, onDeadline: () => Result): Observable<Result> {
    return race(this.completion, timer(budgetMs).pipe(map(onDeadline))).pipe(
      take(1),
    );
  }
}
