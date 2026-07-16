import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { MessageSourceComponent } from './message-source.component';

async function build(source: string) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const { fixture, container } = await render(MessageSourceComponent, {
    inputs: { source },
    providers: [
      MockProvider(DialogRef, { close }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return { cmp: fixture.componentInstance, container, close, toastShow };
}

describe('MessageSourceComponent', () => {
  it('renders the raw JSON source', async () => {
    const { container } = await build('{\n  "type": "m.room.message"\n}');
    const pre = container.querySelector('[data-testid=message-source-json]');
    expect(pre?.textContent).toContain('m.room.message');
  });

  it('copies the source and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build('{"a":1}');

    cmp.copy();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('{"a":1}');
    expect(toastShow).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('closes the dialog', async () => {
    const { cmp } = await build('{}');
    cmp.close();
    expect(TestBed.inject(DialogRef).close).toHaveBeenCalled();
  });
});
