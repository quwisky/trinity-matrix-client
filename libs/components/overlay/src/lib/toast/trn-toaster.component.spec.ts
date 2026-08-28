import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnToasterComponent } from './trn-toaster.component';

describe('TrnToasterComponent', () => {
  it('mounts the public toast viewport over the vendored renderer', async () => {
    const { container } = await render(TrnToasterComponent);

    expect(container.querySelector('brn-sonner-toaster')).not.toBeNull();
  });
});
