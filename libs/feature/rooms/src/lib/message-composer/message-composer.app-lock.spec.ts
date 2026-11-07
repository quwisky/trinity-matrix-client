import {
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { signal } from '@angular/core';
import { MockProvider } from 'ng-mocks';
import { AppLockService } from '@trinity/data-access/app-lock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessageComposerComponent — App lock', () => {
  const locked = signal(false);
  const track = { stop: vi.fn() };

  beforeEach(() => {
    stubObjectUrls();
    locked.set(false);
    track.stop.mockClear();
    vi.stubGlobal(
      'MediaRecorder',
      class {
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: unknown = null;
        onerror: unknown = null;
        start(): void {
          this.state = 'recording';
        }
        stop(): void {
          this.state = 'inactive';
        }
        addEventListener(): void {
          return;
        }
      },
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track] }),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const lockProvider = () =>
    MockProvider(AppLockService, { locked: locked.asReadonly() });

  it('stops a voice recording and releases the mic when the app locks', async () => {
    const { fixture } = await renderComposer({}, [lockProvider()]);
    const cmp = fixture.componentInstance;
    await cmp.startVoiceRecording();
    expect(cmp['attachments'].recordingVoice()).toBe(true);

    locked.set(true);
    fixture.detectChanges();

    expect(cmp['attachments'].recordingVoice()).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });

  it('releases the mic when the app locks while it is being opened', async () => {
    const { fixture } = await renderComposer({}, [lockProvider()]);
    const cmp = fixture.componentInstance;
    const starting = cmp.startVoiceRecording();
    locked.set(true);
    await starting;

    expect(cmp['attachments'].recordingVoice()).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });
});
