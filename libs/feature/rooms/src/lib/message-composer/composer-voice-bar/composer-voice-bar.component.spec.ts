import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { ComposerVoiceBarComponent } from './composer-voice-bar.component';

describe('ComposerVoiceBarComponent', () => {
  it('shows the elapsed time', async () => {
    await render(ComposerVoiceBarComponent, {
      inputs: { timeLabel: '0:07' },
    });

    expect(screen.getByTestId('composer-voice-time').textContent).toContain(
      'Recording 0:07',
    );
  });

  it('cancels and sends through its buttons', async () => {
    const cancel = vi.fn();
    const send = vi.fn();
    await render(ComposerVoiceBarComponent, {
      inputs: { timeLabel: '0:01' },
      on: { cancelRecording: cancel, sendRecording: send },
    });

    screen.getByTestId('composer-voice-cancel').click();
    screen.getByTestId('composer-voice-send').click();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('disables send while sending is blocked', async () => {
    await render(ComposerVoiceBarComponent, {
      inputs: { timeLabel: '0:01', sendBlocked: true },
    });

    expect(
      (screen.getByTestId('composer-voice-send') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('moves focus to cancel on request', async () => {
    const { fixture } = await render(ComposerVoiceBarComponent, {
      inputs: { timeLabel: '0:01' },
    });

    fixture.componentInstance.focusCancel();

    expect(document.activeElement).toBe(
      screen.getByTestId('composer-voice-cancel'),
    );
  });
});
