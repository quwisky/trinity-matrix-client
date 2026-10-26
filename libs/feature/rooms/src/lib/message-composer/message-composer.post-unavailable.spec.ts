import {
  renderComposer,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { MockProvider } from 'ng-mocks';
import { VoiceRecorderService } from '@trinity/platform-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MessageComposerComponent — postUnavailableReason', () => {
  beforeEach(() => stubObjectUrls());

  const query = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('shows the notice and no send controls when posting is unavailable', async () => {
    const { fixture } = await renderComposer({
      postUnavailableReason: 'No posting here.',
    });
    const el = fixture.nativeElement as HTMLElement;

    const notice = query(el, 'composer-post-unavailable');
    expect(notice?.textContent).toContain('No posting here.');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(query(el, 'composer-input')).toBeNull();
    expect(query(el, 'composer-send')).toBeNull();
  });

  it('keeps the typed draft and restores it when posting comes back', async () => {
    const { fixture } = await renderComposer();
    const el = fixture.nativeElement as HTMLElement;
    const input = query(el, 'composer-input') as HTMLTextAreaElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    fixture.componentRef.setInput('postUnavailableReason', 'No posting here.');
    fixture.detectChanges();
    expect(query(el, 'composer-input')).toBeNull();
    fixture.componentInstance.submit();

    fixture.componentRef.setInput('postUnavailableReason', null);
    fixture.detectChanges();
    expect((query(el, 'composer-input') as HTMLTextAreaElement).value).toBe(
      'hello',
    );
  });

  it('sendBlocked alone still shows the text field', async () => {
    const { fixture } = await renderComposer({ sendBlocked: true });
    const el = fixture.nativeElement as HTMLElement;

    expect(query(el, 'composer-input')).not.toBeNull();
    expect(query(el, 'composer-post-unavailable')).toBeNull();
  });

  it('stops an open voice recording when posting becomes unavailable', async () => {
    const cancel = vi.fn();
    const { fixture } = await renderComposer({}, [
      MockProvider(VoiceRecorderService, {
        supported: true,
        start: () => Promise.resolve(),
        cancel,
      }),
    ]);
    const cmp = fixture.componentInstance;
    await cmp.startVoiceRecording();
    expect(cmp['attachments'].recordingVoice()).toBe(true);

    fixture.componentRef.setInput('postUnavailableReason', 'No posting here.');
    fixture.detectChanges();

    expect(cancel).toHaveBeenCalled();
    expect(cmp['attachments'].recordingVoice()).toBe(false);
  });
});
