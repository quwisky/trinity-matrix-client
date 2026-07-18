import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { CryptoSpikeService } from '@trinity/data-access-crypto';
import { HomePage } from './home.page';

describe('HomePage', () => {
  it('should create', async () => {
    const { fixture } = await render(HomePage, {
      providers: [MockProvider(CryptoSpikeService)],
    });

    expect(fixture.componentInstance).toBeTruthy();
  });
});
