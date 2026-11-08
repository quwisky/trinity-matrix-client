import type { Signal } from '@angular/core';
import { SIGNAL, type ReactiveNode } from '@angular/core/primitives/signals';

/** How many live watchers (effects, `toObservable`) a signal currently feeds. */
export function liveConsumers(source: Signal<unknown>): number {
  let count = 0;
  let link = (source[SIGNAL] as ReactiveNode).consumers;
  for (; link; link = link.nextConsumer) count += 1;
  return count;
}
