import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PackImageComponent } from './pack-image.component';

describe('PackImageComponent', () => {
  it('resolves again with the account that becomes active', async () => {
    const resolveMedia = vi.fn(() => of('blob:fox'));
    const activeAccountId = signal<string | null>('@alice:hs');
    const { fixture } = await render(PackImageComponent, {
      inputs: {
        entry: { shortcode: 'fox', url: 'mxc://hs/fox', usage: ['emoticon'] },
      },
      providers: [
        MockProvider(SessionStateService, { activeAccountId }),
        MockProvider(MediaService, {
          resolveMedia,
          pin: vi.fn(),
          unpin: vi.fn(),
        }),
      ],
    });
    expect(resolveMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ mxc: 'mxc://hs/fox' }),
      'thumbnail',
      '@alice:hs',
    );

    activeAccountId.set('@bob:hs');
    fixture.detectChanges();

    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(resolveMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ mxc: 'mxc://hs/fox' }),
      'thumbnail',
      '@bob:hs',
    );
  });
});
