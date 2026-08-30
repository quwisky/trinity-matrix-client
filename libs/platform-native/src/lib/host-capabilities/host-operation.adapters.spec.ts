import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapacitorHostOperationAdapter } from './host-operation.adapters';

const app = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  minimizeApp: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({ App: app }));

describe('CapacitorHostOperationAdapter event streams', () => {
  beforeEach(() => {
    app.addListener.mockReset();
    app.getLaunchUrl.mockReset();
    app.minimizeApp.mockReset();
    app.getLaunchUrl.mockResolvedValue(null);
  });

  it('routes rejected deep-link listener setup through the Observable error channel', async () => {
    const failure = new Error('listener setup failed');
    app.addListener.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('routes rejected launch URL reads through the Observable error channel', async () => {
    const failure = new Error('launch URL failed');
    app.addListener.mockImplementation(() => new Promise(() => undefined));
    app.getLaunchUrl.mockRejectedValue(failure);

    await expect(
      firstValueFrom(new CapacitorHostOperationAdapter().received),
    ).rejects.toBe(failure);
  });

  it('removes a Back listener that resolves after teardown', async () => {
    let resolveListener!: (value: { remove: () => Promise<void> }) => void;
    const remove = vi.fn(() => Promise.resolve());
    app.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListener = resolve;
        }),
    );
    const subscription =
      new CapacitorHostOperationAdapter().intents.subscribe();

    subscription.unsubscribe();
    resolveListener({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
