import {
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  VoiceRecorderService,
  type VoiceRecording,
} from '@trinity/platform-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessageComposerComponent — voice recording', () => {
  const track = { stop: vi.fn() };
  let grantMic: () => void;

  beforeEach(() => {
    stubObjectUrls();
    track.stop.mockClear();
    vi.stubGlobal(
      'MediaRecorder',
      class {
        state = 'inactive';
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
        getUserMedia: () =>
          new Promise((resolve) => {
            grantMic = () => resolve({ getTracks: () => [track] });
          }),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const conversation = { accountId: '@a:hs', roomId: '!room:hs' };

  it('records once the microphone opens in the same conversation', async () => {
    const { fixture } = await renderComposer(conversation);
    const cmp = fixture.componentInstance;
    const starting = cmp.startVoiceRecording();
    grantMic();
    await starting;

    expect(cmp['attachments'].recordingVoice()).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('releases the microphone when the account changes on the same room while it opens', async () => {
    const { fixture } = await renderComposer(conversation);
    const cmp = fixture.componentInstance;
    const starting = cmp.startVoiceRecording();
    fixture.componentRef.setInput('accountId', '@b:hs');
    fixture.detectChanges();
    grantMic();
    await starting;

    expect(cmp['attachments'].recordingVoice()).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });

  describe('when the conversation changes while the clip is finished', () => {
    const recording: VoiceRecording = {
      blob: new Blob(['clip'], { type: 'audio/webm' }),
      durationMs: 1000,
      waveform: [],
      mimeType: 'audio/webm',
    };
    let finish: (clip: VoiceRecording) => void;
    const sendVoiceMessage = vi.fn(() => of(undefined));
    const providers = () => [
      MockProvider(VoiceRecorderService, {
        supported: true,
        start: () => Promise.resolve(),
        stop: () =>
          new Promise<VoiceRecording | null>((resolve) => (finish = resolve)),
        cancel: vi.fn(),
      }),
      MockProvider(TimelineActionsService, { sendVoiceMessage }),
    ];

    beforeEach(() => sendVoiceMessage.mockClear());

    it('sends the clip when the conversation stays', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      finish(recording);
      await Promise.resolve();

      expect(sendVoiceMessage).toHaveBeenCalledWith(recording);
    });

    it('does not send the clip as the account switched to', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      fixture.componentRef.setInput('accountId', '@b:hs');
      fixture.detectChanges();
      finish(recording);
      await Promise.resolve();

      expect(sendVoiceMessage).not.toHaveBeenCalled();
    });
  });
});
