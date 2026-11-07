import { DestroyRef } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LazyPanelOpener } from './lazy-panel-opener';

function setup() {
  let destroy = () => undefined as void;
  const destroyRef = {
    onDestroy: (fn: () => void) => {
      destroy = fn;
      return () => undefined;
    },
  } as unknown as DestroyRef;
  const onFailure = vi.fn();
  const show = vi.fn();
  const opener = new LazyPanelOpener(destroyRef, onFailure);
  return { opener, onFailure, show, destroy: () => destroy() };
}

describe('LazyPanelOpener', () => {
  it('shows the loaded panel when the context is still current', async () => {
    const { opener, show } = setup();
    await opener.open(
      () => Promise.resolve('panel'),
      'x',
      () => true,
      show,
    );
    expect(show).toHaveBeenCalledExactlyOnceWith('panel');
  });

  it('reports its own message when the chunk fails to load', async () => {
    const { opener, onFailure, show } = setup();
    await opener.open(
      () => Promise.reject(new Error('chunk')),
      'Could not open room settings.',
      () => true,
      show,
    );
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      'Could not open room settings.',
    );
    expect(show).not.toHaveBeenCalled();
  });

  it('skips the open when the context changed during the load', async () => {
    const { opener, show, onFailure } = setup();
    let current = true;
    const loading = opener.open(
      () => Promise.resolve('panel').then((p) => ((current = false), p)),
      'x',
      () => current,
      show,
    );
    await loading;
    expect(show).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('drops a second request while one is loading, then accepts the next', async () => {
    const { opener, show } = setup();
    let release!: () => void;
    const first = opener.open(
      () => new Promise<string>((r) => (release = () => r('panel'))),
      'x',
      () => true,
      show,
    );
    const load = vi.fn(() => Promise.resolve('second'));
    await opener.open(load, 'x', () => true, show);
    expect(load).not.toHaveBeenCalled();
    release();
    await first;
    await opener.open(load, 'x', () => true, show);
    expect(show.mock.calls).toEqual([['panel'], ['second']]);
  });

  it('does nothing when the owner is destroyed during the load', async () => {
    const { opener, show, onFailure, destroy } = setup();
    const loading = opener.open(
      () => Promise.resolve('panel').then((p) => (destroy(), p)),
      'x',
      () => true,
      show,
    );
    await loading;
    expect(show).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
