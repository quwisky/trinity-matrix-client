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
    // The visible text is not a live region of its own: that would announce it twice.
    expect(error()?.getAttribute('role')).toBeNull();
    expect(button().disabled).toBe(false);

    fail = false;
    press();

    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(2);
    expect(error()).toBeNull();
  });

  it('announces a failed load through a live region present from the start', async () => {
    const { container, press } = await build(voiceMedia(), () =>
      throwError(() => new Error('offline')),
    );
    const status = () => container.querySelector('[data-testid=voice-status]');
    const before = status();

    expect(before?.getAttribute('role')).toBe('status');
    expect(before?.textContent?.trim()).toBe('');

    press();

    // The same element, so assistive technology already watches it when the text arrives.
    expect(status()).toBe(before);
    expect(status()?.textContent?.trim()).toBe(
      'Couldn’t load this voice message. Try again.',
    );
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

  describe('fitting the waveform to the space it has', () => {
    interface TestObserver {
      readonly observed: Set<Element>;
      emit(entries: ResizeObserverEntry[]): void;
    }
    const observers = () =>
      (ResizeObserver as unknown as { instances: TestObserver[] }).instances;
    // Eight samples whose peaks, two at a time, are 100, 1024, 60 and 512.
    const samples = [0, 100, 1024, 200, 50, 60, 512, 10];

    beforeEach(() => {
      observers().length = 0;
    });

    /** Report the wave's measured width, as the browser would after layout. */
    function resizeWave(container: Element, width: number): void {
      const wave = container.querySelector('.voice__wave')!;
      const observer = observers().find((o) => o.observed.has(wave));
      expect(observer).toBeDefined();
      observer!.emit([{ contentRect: { width } } as ResizeObserverEntry]);
      TestBed.tick();
    }
    const bars = (container: Element) => [
      ...container.querySelectorAll<HTMLElement>('.voice__bar'),
    ];
    const played = (container: Element) =>
      container.querySelectorAll('.voice__bar--played').length;
    /** Play the clip and report `seconds` of playback. */
    function playTo(
      audio: () => HTMLAudioElement | null,
      press: () => void,
      seconds: number,
    ): void {
      press();
      const el = audio()!;
      el.dispatchEvent(new Event('play'));
      Object.defineProperty(el, 'currentTime', {
        value: seconds,
        configurable: true,
      });
      el.dispatchEvent(new Event('timeupdate'));
      TestBed.tick();
    }

    it('sizes the wave for its whole waveform, so a wide bubble keeps its width', async () => {
      const { container } = await build(voiceMedia({ waveform: samples }));
      // 2px bars with 2px gaps: 8 × 2 + 7 × 2.
      expect(
        container.querySelector<HTMLElement>('.voice__wave')?.style.width,
      ).toBe('30px');
    });

    it('keeps every bar while they all fit', async () => {
      const { container } = await build(voiceMedia({ waveform: samples }));
      expect(bars(container)).toHaveLength(8);

      resizeWave(container, 30);

      expect(bars(container)).toHaveLength(8);
    });

    it('samples the waveform down to the bars that fit, keeping each span’s peak', async () => {
      const { container } = await build(voiceMedia({ waveform: samples }));

      // Room for four 2px bars and their gaps, not five.
      resizeWave(container, 17);

      expect(bars(container).map((bar) => bar.style.height)).toEqual([
        '12%', // 100/1024 is under the minimum bar height
        '100%',
        '12%',
        '50%',
      ]);

      // Wider again: the full waveform comes back.
      resizeWave(container, 200);
      expect(bars(container)).toHaveLength(8);
    });

    it('fills the played share of the sampled bars in step with playback', async () => {
      const { container, audio, press } = await build(
        voiceMedia({ waveform: samples, durationMs: 8_000 }),
      );
      resizeWave(container, 14);

      playTo(audio, press, 2);
      expect(bars(container)).toHaveLength(4);
      // A quarter of the clip played: one of four bars, as two of eight would have been.
      expect(played(container)).toBe(1);

      playTo(audio, press, 6);
      expect(played(container)).toBe(3);

      resizeWave(container, 200);
      expect(played(container)).toBe(6);
    });

    it('keeps the same bars while a resize fits the same number of them', async () => {
      const { container, fixture } = await build(
        voiceMedia({ waveform: samples }),
      );
      resizeWave(container, 14);
      const before = fixture.componentInstance.bars();
      const nodes = bars(container);

      // Wider, but still room for only four bars.
      resizeWave(container, 17);

      expect(fixture.componentInstance.bars()).toBe(before);
      expect(bars(container)).toEqual(nodes);
    });

    it('stops measuring when destroyed', async () => {
      const { container, fixture } = await build(
        voiceMedia({ waveform: samples }),
      );
      const wave = container.querySelector('.voice__wave')!;
      const observer = observers().find((o) => o.observed.has(wave))!;

      fixture.destroy();

      expect(observer.observed.size).toBe(0);
    });

    it('measures the new wave once a failed load recovers', async () => {
      let fail = true;
      const { container, press } = await build(
        voiceMedia({ waveform: samples }),
        () => (fail ? throwError(() => new Error('offline')) : of('blob:clip')),
      );
      const first = observers().find((o) =>
        o.observed.has(container.querySelector('.voice__wave')!),
      )!;

      press();
      expect(container.querySelector('.voice__wave')).toBeNull();
      expect(first.observed.size).toBe(0);

      fail = false;
      press();
      TestBed.tick();

      resizeWave(container, 14);
      expect(bars(container)).toHaveLength(4);
    });

    it('never samples below one bar', async () => {
      const { container } = await build(voiceMedia({ waveform: samples }));

      resizeWave(container, 1);

      expect(bars(container).map((bar) => bar.style.height)).toEqual(['100%']);
    });
  });

  it('renders a flat placeholder when there is no waveform', async () => {
    const { container } = await build(voiceMedia({ waveform: [] }));
    expect(container.querySelector('.voice__bar')).toBeNull();
    expect(container.querySelector('.voice__wave--empty')).not.toBeNull();
  });
});
