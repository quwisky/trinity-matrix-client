import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NotificationSoundService } from '@trinity/data-access/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RingToneService } from './ring-tone.service';

const refusalHandlers: ((error: unknown) => void)[] = [];

function fakeContext(resumeRejects = false) {
  return {
    currentTime: 0,
    destination: {},
    close: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() =>
      resumeRejects
        ? {
            catch: (handler: (error: unknown) => void) => {
              refusalHandlers.push(handler);
              return Promise.resolve();
            },
          }
        : Promise.resolve(),
    ),
    createOscillator: vi.fn(() => ({
      type: '',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        value: 0,
      },
      connect: vi.fn(),
    })),
  };
}

describe('RingToneService', () => {
  const enabled = signal(true);
  let contexts: ReturnType<typeof fakeContext>[];
  let resumeRejects = false;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    enabled.set(true);
    resumeRejects = false;
    refusalHandlers.length = 0;
    contexts = [];
    create = vi.fn(function () {
      const context = fakeContext(resumeRejects);
      contexts.push(context);
      return context;
    });
    vi.stubGlobal('AudioContext', create);
    TestBed.configureTestingModule({
      providers: [{ provide: NotificationSoundService, useValue: { enabled } }],
    });
  });

  afterEach(() => {
    TestBed.inject(RingToneService).stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('creates no context while sound is off', () => {
    enabled.set(false);
    TestBed.inject(RingToneService).start();
    expect(create).not.toHaveBeenCalled();
  });

  it('survives a missing or throwing AudioContext', () => {
    create.mockImplementation(function () {
      throw new Error('blocked');
    });
    expect(() => TestBed.inject(RingToneService).start()).not.toThrow();
    vi.stubGlobal('AudioContext', undefined);
    expect(() => TestBed.inject(RingToneService).start()).not.toThrow();
  });

  it('creates one context for a double start and closes it on stop', () => {
    const tone = TestBed.inject(RingToneService);
    tone.start();
    tone.start();
    expect(create).toHaveBeenCalledTimes(1);
    tone.stop();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it('resumes a suspended context', () => {
    TestBed.inject(RingToneService).start();
    expect(contexts[0].resume).toHaveBeenCalled();
  });

  it('ignores a refused resume', () => {
    resumeRejects = true;
    expect(() => TestBed.inject(RingToneService).start()).not.toThrow();
    // The fake's refusal carries a handler slot; the service must have filled it.
    expect(refusalHandlers).toHaveLength(1);
    expect(refusalHandlers[0](new Error('no gesture'))).toBeUndefined();
  });

  it('bursts again every three seconds at a low gain', () => {
    const tone = TestBed.inject(RingToneService);
    tone.start();
    const first = contexts[0].createOscillator.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    vi.advanceTimersByTime(3000);
    expect(contexts[0].createOscillator.mock.calls.length).toBe(first * 2);
    const gains = contexts[0].createGain.mock.results.flatMap(
      (r) => r.value.gain.linearRampToValueAtTime.mock.calls,
    );
    expect(
      Math.max(...gains.map(([value]) => value as number)),
    ).toBeLessThanOrEqual(0.15);
  });
});
