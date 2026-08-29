import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

async function build(media = voiceMedia()) {
  const resolveMedia = vi.fn(() => of('blob:clip'));
  const { container, fixture } = await render(VoiceMessageComponent, {
    inputs: { media },
    providers: [MockProvider(MediaPipeline, { resolveMedia })],
  });
  return { container, fixture, resolveMedia };
}

describe('VoiceMessageComponent', () => {
  beforeEach(() => {
    // jsdom doesn't implement media playback; stub it so toggle() works.
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  it('resolves the clip and renders the play control, waveform and duration', async () => {
    const { container, resolveMedia } = await build();

    expect(resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'presented-media-voice' }),
      'full',
    );
    expect(
      container.querySelector('[data-testid=voice-message]'),
    ).not.toBeNull();
    // One bar per waveform sample.
    expect(container.querySelectorAll('.voice__bar')).toHaveLength(4);
    // 65s → "1:05".
    expect(
      container.querySelector('[data-testid=voice-time]')?.textContent?.trim(),
    ).toBe('1:05');
  });

  it('toggles playback when the play button is clicked', async () => {
    const { container } = await build();
    const audio = container.querySelector('audio') as HTMLAudioElement;
    const play = vi.spyOn(audio, 'play');
    Object.defineProperty(audio, 'paused', { value: true, configurable: true });

    (container.querySelector('.voice__play') as HTMLButtonElement).click();

    expect(play).toHaveBeenCalled();
  });

  it('renders a flat placeholder when there is no waveform', async () => {
    const { container } = await build(voiceMedia({ waveform: [] }));
    expect(container.querySelector('.voice__bar')).toBeNull();
    expect(container.querySelector('.voice__wave--empty')).not.toBeNull();
  });
});
