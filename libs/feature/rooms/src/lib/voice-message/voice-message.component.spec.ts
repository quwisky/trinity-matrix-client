import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { VoiceMessageComponent } from './voice-message.component';

function voiceMedia(
  over: Partial<PresentedMediaReference> = {},
): PresentedMediaReference {
  return {
    id: 'presented-media-voice',
    kind: 'audio',
    filename: 'Voice message',
    mimeType: 'audio/webm',
    durationMs: 65_000,
    isVoice: true,
    waveform: [0, 256, 512, 1024],
    ...over,
  } as PresentedMediaReference;
}

async function build(
  media = voiceMedia(),
  resolved: () => Observable<string> = () => of('blob:clip'),
) {
  const pipeline = {
    resolveMedia: vi.fn(resolved),
    pin: vi.fn(),
    unpin: vi.fn(),
    drop: vi.fn(),
  };
  const { container, fixture } = await render(VoiceMessageComponent, {
    inputs: { media },
    providers: [MockProvider(MediaPipeline, pipeline)],
  });
  const button = () =>
    container.querySelector('.voice__play') as HTMLButtonElement;
  const audio = () => container.querySelector('audio');
  /** Press play/pause and let the view catch up. */
  const press = () => {
    button().click();
    TestBed.tick();
  };
  return { container, fixture, pipeline, button, audio, press };
}

describe('VoiceMessageComponent', () => {
  let play: Mock;

  beforeEach(() => {
    // jsdom doesn't implement media playback; stub it so the player can drive it.
    play = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  it('renders the waveform and duration from the event without fetching the clip', async () => {
    const { container, pipeline, button, audio } = await build();

    // Scrolling past a voice message must not download, decrypt and hold it.
    expect(pipeline.resolveMedia).not.toHaveBeenCalled();
    expect(pipeline.pin).not.toHaveBeenCalled();
    expect(audio()).toBeNull();
    // One bar per waveform sample.
    expect(container.querySelectorAll('.voice__bar')).toHaveLength(4);
    // 65s → "1:05".
    expect(
      container.querySelector('[data-testid=voice-time]')?.textContent?.trim(),
    ).toBe('1:05');
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('aria-label')).toBe('Play voice message');
  });

  it('fetches the clip on the first press of play and plays it once it can', async () => {
    const media = voiceMedia();
    const { pipeline, audio, press } = await build(media);

    press();

    expect(pipeline.resolveMedia).toHaveBeenCalledExactlyOnceWith(
      media,
      'full',
    );
    expect(pipeline.pin).toHaveBeenCalledWith('blob:clip');
    expect(audio()?.getAttribute('src')).toBe('blob:clip');
    audio()!.dispatchEvent(new Event('loadedmetadata'));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('shows that the clip is loading and ignores presses meanwhile', async () => {
    const clip = new Subject<string>();
    const { pipeline, button, press } = await build(voiceMedia(), () =>
      clip.asObservable(),
    );

    press();
    press();

    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(1);
    expect(button().getAttribute('aria-label')).toBe('Loading voice message');
    expect(button().getAttribute('aria-busy')).toBe('true');
  });

  it('lets a later press retry a clip that failed to load', async () => {
    const { pipeline, button, press } = await build(voiceMedia(), () =>
      throwError(() => new Error('offline')),
    );

    press();
    press();

    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(2);
    expect(button().getAttribute('aria-label')).toBe('Play voice message');
  });

  it('says the clip could not be loaded, and lets Play try again', async () => {
    let fail = true;
    const { container, pipeline, button, press } = await build(
      voiceMedia(),
      () => (fail ? throwError(() => new Error('offline')) : of('blob:clip')),
    );
    const error = () => container.querySelector('[data-testid=voice-error]');

    press();

    expect(error()?.textContent?.trim()).toBe(
      'Couldn’t load this voice message. Try again.',
    );
    expect(error()?.getAttribute('role')).toBe('status');
    expect(button().disabled).toBe(false);

    fail = false;
    press();

    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(2);
    expect(error()).toBeNull();
  });

  it('does not leave a rejected play unhandled when the host refuses to start', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // A plain function, not vi.fn: a mock observes the promises it returns, which would
      // count as handling the rejection.
      let starts = 0;
      HTMLMediaElement.prototype.play = () => {
        starts++;
        return Promise.reject(new DOMException('autoplay', 'NotAllowedError'));
      };
      const { audio, press } = await build();
      press(); // fetches, then starts once loaded
      audio()!.dispatchEvent(new Event('loadedmetadata'));
      Object.defineProperty(audio()!, 'paused', {
        value: true,
        configurable: true,
      });
      press(); // the reader tries again by hand
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(starts).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('pauses and resumes a loaded clip without fetching it again', async () => {
    const { pipeline, audio, press } = await build();
    press();
    const el = audio()!;
    Object.defineProperty(el, 'paused', { value: false, configurable: true });

    press();

    expect(el.pause).toHaveBeenCalled();
    Object.defineProperty(el, 'paused', { value: true, configurable: true });
    play.mockClear();
    press();
    expect(play).toHaveBeenCalledTimes(1);
    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(1);
  });

  it('drops the clip when it plays to the end, and fetches it again on the next play', async () => {
    const media = voiceMedia();
    const { fixture, pipeline, audio, press, container } = await build(media);
    press();

    audio()!.dispatchEvent(new Event('ended'));
    TestBed.tick();

    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(
      media,
      'full',
      'blob:clip',
    );
    expect(audio()).toBeNull();
    expect(fixture.componentInstance.playing()).toBe(false);
    expect(
      container.querySelector('[data-testid=voice-time]')?.textContent?.trim(),
    ).toBe('1:05');

    press();
    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(2);
  });

  it('drops the played clip when destroyed', async () => {
    const media = voiceMedia();
    const { fixture, pipeline, press } = await build(media);
    press();

    fixture.destroy();

    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(
      media,
      'full',
      'blob:clip',
    );
    expect(pipeline.unpin).not.toHaveBeenCalledWith('blob:clip');
  });

  it('cancels a clip still loading when destroyed', async () => {
    const clip = new Subject<string>();
    const media = voiceMedia();
    const { fixture, pipeline, press } = await build(media, () =>
      clip.asObservable(),
    );
    press();

    fixture.destroy();

    expect(clip.observed).toBe(false);
    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(media, 'full', null);
  });

  it('drops the clip of the previous message when the row is reused', async () => {
    const media = voiceMedia();
    const { fixture, pipeline, press, audio } = await build(media);
    press();

    fixture.componentRef.setInput('media', voiceMedia({ id: 'other' }));
    TestBed.tick();

    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(
      media,
      'full',
      'blob:clip',
    );
    expect(audio()).toBeNull();
    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(1);
  });

  it('renders a flat placeholder when there is no waveform', async () => {
    const { container } = await build(voiceMedia({ waveform: [] }));
    expect(container.querySelector('.voice__bar')).toBeNull();
    expect(container.querySelector('.voice__wave--empty')).not.toBeNull();
  });
});
