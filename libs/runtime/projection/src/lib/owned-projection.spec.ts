import { describe, expect, it, vi } from 'vitest';
import { ownedProjection } from './owned-projection';

describe('ownedProjection', () => {
  it('is cold and releases exactly once on unsubscribe', () => {
    const attach = vi.fn();
    const release = vi.fn();
    const source = ownedProjection(attach, release);

    expect(attach).not.toHaveBeenCalled();
    const lifetime = source.subscribe();
    expect(attach).toHaveBeenCalledOnce();

    lifetime.unsubscribe();
    lifetime.unsubscribe();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases partial attachment before reporting a failure', () => {
    const attachmentFailure = new Error('broken attachment');
    const release = vi.fn();
    const error = vi.fn();

    ownedProjection(() => {
      throw attachmentFailure;
    }, release).subscribe({ error });

    expect(release).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(attachmentFailure);
  });

  it('reports attachment and cleanup failures together', () => {
    const attachmentFailure = new Error('broken attachment');
    const cleanupFailure = new Error('broken cleanup');
    const error = vi.fn();

    ownedProjection(
      () => {
        throw attachmentFailure;
      },
      () => {
        throw cleanupFailure;
      },
    ).subscribe({ error });

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toBeInstanceOf(AggregateError);
    expect((error.mock.calls[0][0] as AggregateError).errors).toEqual([
      attachmentFailure,
      cleanupFailure,
    ]);
  });
});
