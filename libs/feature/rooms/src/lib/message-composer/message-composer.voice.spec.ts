import {
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { MockProvider } from 'ng-mocks';
import { from, map, tap, throwError } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { TrnToastService } from '@trinity/components/overlay';
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

  describe('after Stop, while the clip is encoded', () => {
    const recording: VoiceRecording = {
      blob: new Blob(['clip'], { type: 'audio/webm' }),
      durationMs: 1000,
      waveform: [],
      mimeType: 'audio/webm',
    };
    let finish: (clip: VoiceRecording) => void;
    let fail: (error: Error) => void;
    const delivered = vi.fn();
    // Delivers once the clip is in, as the real send does; unsubscribing stops it.
    const sendVoiceMessage = vi.fn((clip: PromiseLike<VoiceRecording | null>) =>
      from(clip).pipe(
        tap((resolved) => resolved && delivered(resolved)),
        map(() => undefined),
      ),
    );
    const providers = () => [
      MockProvider(VoiceRecorderService, {
        supported: true,
        start: () => Promise.resolve(),
        stop: () =>
          new Promise<VoiceRecording | null>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
        cancel: vi.fn(),
      }),
      MockProvider(TimelineActionsService, { sendVoiceMessage }),
    ];
    const settle = () => new Promise((resolve) => setTimeout(resolve));
    const dangerToasts = (text: string) =>
      vi
        .mocked(TestBed.inject(TrnToastService).show)
        .mock.calls.filter(([message]) => message === text).length;

    beforeEach(() => {
      sendVoiceMessage.mockClear();
      delivered.mockClear();
    });

    it('sends the clip when the conversation stays', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      finish(recording);
      await settle();

      expect(delivered).toHaveBeenCalledExactlyOnceWith(recording);
    });

    it('still sends the clip to the conversation it was recorded in after an account switch', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      // The send resolves its conversation on subscribe, so it must be under way before the switch.
      expect(sendVoiceMessage).toHaveBeenCalledTimes(1);

      fixture.componentRef.setInput('accountId', '@b:hs');
      fixture.detectChanges();
      finish(recording);
      await settle();

      expect(sendVoiceMessage).toHaveBeenCalledTimes(1);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(recording);
    });

    it('ends the reply of the recorded conversation at Stop, not one started after a switch', async () => {
      const { fixture } = await renderComposer(
        { ...conversation, replyingTo: 'Alice' },
        providers(),
      );
      const cmp = fixture.componentInstance;
      const cancelReply = vi.fn();
      cmp.cancelReply.subscribe(cancelReply);
      await cmp.startVoiceRecording();

      cmp.stopVoiceRecording();
      expect(cancelReply).toHaveBeenCalledTimes(1);

      fixture.componentRef.setInput('accountId', '@b:hs');
      fixture.componentRef.setInput('replyingTo', 'Bob');
      fixture.detectChanges();
      finish(recording);
      await settle();

      expect(cancelReply).toHaveBeenCalledTimes(1);
    });

    it('toasts once and sends nothing when the clip cannot be encoded', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      fail(new Error('encoder'));
      await settle();

      expect(dangerToasts('Could not finish that voice recording.')).toBe(1);
      expect(dangerToasts('Could not send that voice message.')).toBe(0);
      expect(delivered).not.toHaveBeenCalled();
    });

    it('toasts once when the send fails', async () => {
      sendVoiceMessage.mockImplementationOnce(() =>
        throwError(() => new Error('upload')),
      );
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      finish(recording);
      await settle();

      expect(dangerToasts('Could not send that voice message.')).toBe(1);
      expect(dangerToasts('Could not finish that voice recording.')).toBe(0);
    });

    it('sends nothing when the composer is destroyed mid-encode', async () => {
      const { fixture } = await renderComposer(conversation, providers());
      const cmp = fixture.componentInstance;
      await cmp.startVoiceRecording();
      cmp.stopVoiceRecording();
      fixture.destroy();
      finish(recording);
      await settle();

      expect(delivered).not.toHaveBeenCalled();
    });
  });
});
