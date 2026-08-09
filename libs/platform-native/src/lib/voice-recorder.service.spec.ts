import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorderService } from './voice-recorder.service';

/** A minimal MediaRecorder stand-in driving the service's data/stop flow. */
class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  static instances: FakeMediaRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(
    public stream: unknown,
    public options?: { mimeType?: string },
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  start(): void {
    this.state = 'recording';
    this.ondataavailable?.({
      data: new Blob(['chunk'], { type: 'audio/webm' }),
    });
  }

  stop(): void {
    // Per the MediaStream Recording spec — stopping an inactive recorder throws.
    if (this.state === 'inactive') {
      throw new DOMException('already inactive', 'InvalidStateError');
    }
    this.state = 'inactive';
    (this.listeners.get('stop') ?? []).forEach((cb) => cb());
  }
}

const trackStop = vi.fn();
const getUserMedia = vi.fn(async () => ({
  getTracks: () => [{ stop: trackStop }],
}));

class FakeAudioContext {
  decodeAudioData = vi.fn(async () => ({
    getChannelData: () => new Float32Array([0.1, -0.9, 0.5, 0.2]),
  }));
  close = vi.fn(async () => undefined);
}

describe('VoiceRecorderService', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // jsdom's Blob lacks arrayBuffer() (browsers have it); shim it for decoding.
    if (!Blob.prototype.arrayBuffer) {
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        value: () => Promise.resolve(new ArrayBuffer(8)),
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    getUserMedia.mockClear();
    trackStop.mockClear();
    FakeMediaRecorder.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function make(): VoiceRecorderService {
    TestBed.configureTestingModule({ providers: [VoiceRecorderService] });
    return TestBed.inject(VoiceRecorderService);
  }

  it('reports support when the platform APIs are present', () => {
    expect(make().supported).toBe(true);
  });

  it('start() opens the mic and begins recording', async () => {
    const svc = make();
    await svc.start();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(svc.recording).toBe(true);
  });

  it('stop() resolves the clip with a duration and waveform, releasing the mic', async () => {
    const svc = make();
    await svc.start();

    const recording = await svc.stop();

    expect(recording).not.toBeNull();
    expect(recording?.mimeType).toContain('audio/webm');
    expect(recording?.blob.size).toBeGreaterThan(0);
    expect(recording?.durationMs).toBeGreaterThanOrEqual(0);
    expect(recording?.waveform).toHaveLength(60);
    expect(trackStop).toHaveBeenCalled(); // mic released
    expect(svc.recording).toBe(false);
  });

  it('stop() returns null when nothing is recording', async () => {
    expect(await make().stop()).toBeNull();
  });

  it('cancel() stops the recorder and releases the mic', async () => {
    const svc = make();
    await svc.start();

    svc.cancel();

    expect(trackStop).toHaveBeenCalled();
    expect(svc.recording).toBe(false);
  });

  // The tracks can end under us (permission revoked mid-record, the device grabbed by
  // another app). stop() used to reject there, stranding the mic and — because start()
  // no-ops while a recorder handle is held — killing voice messaging for the session.
  it('stop() resolves from the captured chunks when the recorder already went inactive', async () => {
    const svc = make();
    await svc.start();
    FakeMediaRecorder.instances[0].state = 'inactive';

    const recording = await svc.stop();

    expect(recording).not.toBeNull();
    expect(recording?.blob.size).toBeGreaterThan(0);
    expect(trackStop).toHaveBeenCalled(); // mic released
    expect(svc.recording).toBe(false);
  });

  it('start() re-acquires the mic after stop() found the recorder inactive', async () => {
    const svc = make();
    await svc.start();
    FakeMediaRecorder.instances[0].state = 'inactive';
    await svc.stop();

    await svc.start();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(svc.recording).toBe(true);
  });

  it('a recorder error releases the mic so the next start() is not a no-op', async () => {
    const svc = make();
    await svc.start();

    FakeMediaRecorder.instances[0].onerror?.();

    expect(trackStop).toHaveBeenCalled();
    expect(svc.recording).toBe(false);

    await svc.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('start() rejects when recording is unsupported', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    await expect(make().start()).rejects.toThrow(/available/i);
  });

  it('stop() closes the AudioContext and yields an empty waveform on decode failure', async () => {
    const close = vi.fn(async () => undefined);
    class FailingAudioContext {
      decodeAudioData = vi.fn(async () => {
        throw new Error('bad codec');
      });
      close = close;
    }
    vi.stubGlobal('AudioContext', FailingAudioContext);
    const svc = make();
    await svc.start();

    const recording = await svc.stop();

    expect(recording?.waveform).toEqual([]); // decode failure never breaks the send
    expect(close).toHaveBeenCalled(); // context released regardless
  });
});
