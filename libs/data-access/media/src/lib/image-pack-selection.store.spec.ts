import { TestBed } from '@angular/core/testing';
import { effect } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { ImagePackSelectionStore } from './image-pack-selection.store';

describe('ImagePackSelectionStore', () => {
  const a = {} as MatrixClient;
  const b = {} as MatrixClient;
  const flush = () => TestBed.tick();

  it('re-runs a reader of client A when A changes, and not one of client B', () => {
    const store = TestBed.inject(ImagePackSelectionStore);
    const readsA = vi.fn();
    const readsB = vi.fn();
    TestBed.runInInjectionContext(() => {
      effect(() => readsA(store.get(a)));
      effect(() => readsB(store.get(b)));
    });
    flush();
    readsA.mockClear();
    readsB.mockClear();

    store.set(a, { present: true, content: { x: 1 } });
    flush();
    expect(readsA).toHaveBeenCalledWith({ present: true, content: { x: 1 } });
    expect(readsB).not.toHaveBeenCalled();
  });

  it('updates readers on clear', () => {
    const store = TestBed.inject(ImagePackSelectionStore);
    store.set(a, { present: true, content: null });
    const reads = vi.fn();
    TestBed.runInInjectionContext(() => effect(() => reads(store.get(a))));
    flush();
    store.clear(a);
    flush();
    expect(reads).toHaveBeenLastCalledWith(null);
  });

  it('reads an expired optimistic selection as null', () => {
    vi.useFakeTimers();
    const store = TestBed.inject(ImagePackSelectionStore);
    store.set(a, { present: true, content: null });
    vi.advanceTimersByTime(30_001);
    expect(store.get(a)).toBeNull();
    vi.useRealTimers();
  });

  it('has no manual change counter', () => {
    const store = TestBed.inject(ImagePackSelectionStore) as unknown as Record<
      string,
      unknown
    >;
    expect(store['changed']).toBeUndefined();
  });
});
