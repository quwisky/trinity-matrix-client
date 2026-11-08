import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { liveConsumers } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { signalChanges } from './signal-changes';

describe('signalChanges', () => {
  it('emits each value and stops watching once unsubscribed', () => {
    const source = signal(1);
    const seen: number[] = [];
    const subscription = signalChanges(
      source,
      TestBed.inject(Injector),
    ).subscribe((value) => seen.push(value));
    TestBed.tick();
    source.set(2);
    TestBed.tick();

    expect(seen).toEqual([1, 2]);
    expect(liveConsumers(source)).toBe(1);

    subscription.unsubscribe();
    source.set(3);
    TestBed.tick();

    expect(seen).toEqual([1, 2]);
    expect(liveConsumers(source)).toBe(0);
  });
});
