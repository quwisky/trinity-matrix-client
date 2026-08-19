import { Observable, firstValueFrom, of, throwError, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { describe, expect, it, vi } from 'vitest';
import {
  sendMediaBatch,
  type BatchItem,
  type BatchProgress,
} from './send-media-batch';

const item = (name: string): BatchItem => ({
  id: `id-${name}`,
  file: new File(['x'], name, { type: 'image/png' }),
});

/** A sender whose per-file duration is scripted, so ordering can actually be observed. */
function scriptedSender(durations: Record<string, number>) {
  const started: string[] = [];
  const finished: string[] = [];
  const send = vi.fn((file: File): Observable<void> => {
    started.push(file.name);
    return timer(durations[file.name] ?? 0).pipe(
      map(() => {
        finished.push(file.name);
      }),
    );
  });
  return { send, started, finished };
}

describe('sendMediaBatch', () => {
  it('sends in the order given, even when a later file uploads faster', async () => {
    // The whole reason this is `concatMap`. With concurrent uploads the SDK still orders the
    // `sendMessage` CALLS — but each call only happens after its own upload resolves, so the
    // small file's event would land first and the SDK would faithfully preserve that.
    const { send, started, finished } = scriptedSender({
      'big.png': 30,
      'small.png': 1,
    });

    await firstValueFrom(
      sendMediaBatch(
        [item('big.png'), item('small.png')],
        '',
        send,
        () => undefined,
      ),
    );

    expect(started).toEqual(['big.png', 'small.png']);
    expect(finished).toEqual(['big.png', 'small.png']);
  });

  it('never has two uploads in flight at once', async () => {
    // Depth 1 is what stops one hard failure taking already-uploaded siblings with it: the
    // SDK's scheduler rejects every event queued behind a failing one, not just that one.
    let inFlight = 0;
    let peak = 0;
    const send = vi.fn((): Observable<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return timer(2).pipe(
        map(() => {
          inFlight--;
        }),
      );
    });

    await firstValueFrom(
      sendMediaBatch(
        [item('a.png'), item('b.png'), item('c.png')],
        '',
        send,
        () => undefined,
      ),
    );

    expect(peak).toBe(1);
  });

  it('keeps going when one file fails, and says which', async () => {
    const send = vi.fn((file: File): Observable<void> =>
      file.name === 'bad.png'
        ? throwError(() => new Error('upload exploded'))
        : of(undefined),
    );

    const outcomes = await firstValueFrom(
      sendMediaBatch(
        [item('a.png'), item('bad.png'), item('c.png')],
        '',
        send,
        () => undefined,
      ),
    );

    expect(send).toHaveBeenCalledTimes(3); // the failure did not cancel the third
    expect(outcomes).toEqual([
      { id: 'id-a.png', failed: false },
      { id: 'id-bad.png', failed: true },
      { id: 'id-c.png', failed: false },
    ]);
  });

  it('never rejects, whatever the sender does', async () => {
    const send = vi.fn(() =>
      throwError(() => new Error('everything is broken')),
    );

    await expect(
      firstValueFrom(
        sendMediaBatch(
          [item('a.png'), item('b.png')],
          '',
          send,
          () => undefined,
        ),
      ),
    ).resolves.toEqual([
      { id: 'id-a.png', failed: true },
      { id: 'id-b.png', failed: true },
    ]);
  });

  it('reports which file of how many, and clears when the batch ends', async () => {
    const seen: (BatchProgress | null)[] = [];
    const send = vi.fn(
      (_file: File, _caption: string, progress?: (f: number) => void) => {
        progress?.(0.5);
        return of(undefined);
      },
    );

    await firstValueFrom(
      sendMediaBatch([item('a.png'), item('b.png')], '', send, (p) =>
        seen.push(p),
      ),
    );

    expect(seen).toEqual([
      { index: 1, total: 2, fraction: 0 },
      { index: 1, total: 2, fraction: 0.5 },
      { index: 2, total: 2, fraction: 0 },
      { index: 2, total: 2, fraction: 0.5 },
      null, // cleared, so the bar goes away rather than sticking at 100%
    ]);
  });

  it('gives the caption to the media event only when there is exactly one file', async () => {
    // The batch case sends the text as its own message afterwards, which is the caller's job.
    const single = vi.fn((_file: File, _caption: string) => of(undefined));
    await firstValueFrom(
      sendMediaBatch([item('a.png')], 'hello', single, () => undefined),
    );
    expect(single.mock.calls[0][1]).toBe('hello');

    const many = vi.fn((_file: File, _caption: string) => of(undefined));
    await firstValueFrom(
      sendMediaBatch(
        [item('a.png'), item('b.png')],
        'hello',
        many,
        () => undefined,
      ),
    );
    expect(many.mock.calls.map((call) => call[1])).toEqual(['', '']);
  });

  it('does nothing at all for an empty batch', async () => {
    const send = vi.fn(() => of(undefined));
    const seen: (BatchProgress | null)[] = [];

    await expect(
      firstValueFrom(sendMediaBatch([], 'hello', send, (p) => seen.push(p))),
    ).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(seen).toEqual([null]); // still clears, so a stale bar cannot survive
  });

  it('issues nothing until it is subscribed', async () => {
    // Cold, like every other one-shot action in this workspace: building the batch must not
    // start uploading it.
    const send = vi.fn(() => of(undefined));

    const batch = sendMediaBatch([item('a.png')], '', send, () => undefined);
    expect(send).not.toHaveBeenCalled();

    await firstValueFrom(batch);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
