import { screen, waitFor } from '@testing-library/angular';
import { desktopBridgeFixture, render } from '@trinity/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemTitleBarBlockComponent } from './system-title-bar-block.component';

type BridgeHost = { trinityDesktop?: unknown };
type SetOutcome =
  { kind: 'completed' } | { kind: 'rejected'; diagnostic: { code: string } };

describe('SystemTitleBarBlockComponent', () => {
  afterEach(() => {
    delete (globalThis as BridgeHost).trinityDesktop;
  });

  async function setup(
    opts: {
      bridge?: boolean;
      saved?: boolean;
      active?: boolean;
      outcome?: SetOutcome;
      getState?: () => Promise<{ saved: boolean; active: boolean }>;
    } = {},
  ) {
    const setSystemTitleBar = vi.fn(
      async (): Promise<SetOutcome> => opts.outcome ?? { kind: 'completed' },
    );
    const relaunch = vi.fn();
    if (opts.bridge !== false) {
      (globalThis as BridgeHost).trinityDesktop = desktopBridgeFixture({
        capabilities: {
          titleBar: {
            getSystemTitleBar:
              opts.getState ??
              (async () => ({
                saved: opts.saved ?? false,
                active: opts.active ?? false,
              })),
            setSystemTitleBar,
            relaunch,
          },
        },
      });
    }
    const view = await render(SystemTitleBarBlockComponent);
    return { ...view, setSystemTitleBar, relaunch };
  }

  const toggle = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>(
      '[data-testid="system-title-bar-toggle"] input[role="switch"]',
    );

  it('renders nothing without the desktop bridge', async () => {
    const { container } = await setup({ bridge: false });
    expect(
      container.querySelector('[data-testid="system-title-bar-toggle"]'),
    ).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('shows the saved value, not the running one', async () => {
    const { container } = await setup({ saved: true, active: false });
    await waitFor(() => expect(toggle(container)).not.toBeNull());
    expect(toggle(container)?.checked).toBe(true);
    expect(screen.queryByText('Restart to apply')).toBeNull();
  });

  it('saves a change, then offers a restart that relaunches', async () => {
    const { container, setSystemTitleBar, relaunch } = await setup();
    await waitFor(() => expect(toggle(container)).not.toBeNull());
    toggle(container)?.click();

    expect(setSystemTitleBar).toHaveBeenCalledWith(true);
    expect(await screen.findByText('Restart to apply')).toBeTruthy();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="system-title-bar-restart"]',
      )
      ?.click();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('hides the prompt when flipped back to the running mode', async () => {
    const { container } = await setup();
    await waitFor(() => expect(toggle(container)).not.toBeNull());
    toggle(container)?.click();
    await screen.findByText('Restart to apply');
    toggle(container)?.click();
    await waitFor(() =>
      expect(screen.queryByText('Restart to apply')).toBeNull(),
    );
  });

  it('reverts the toggle and shows an error when the save is rejected', async () => {
    const { container } = await setup({
      outcome: {
        kind: 'rejected',
        diagnostic: { code: 'window-prefs-write-failed' },
      },
    });
    await waitFor(() => expect(toggle(container)).not.toBeNull());
    const input = toggle(container);
    input?.focus();
    input?.click();

    expect(
      await screen.findByText('This choice could not be saved.'),
    ).toBeTruthy();
    await waitFor(() => expect(input?.checked).toBe(false));
    expect(toggle(container)).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText('Restart to apply')).toBeNull();
  });

  it.each([
    ['never resolves', () => new Promise<never>(() => undefined)],
    ['rejects', () => Promise.reject(new Error('host gone'))],
  ])('stays hidden when the host state %s', async (_name, getState) => {
    const { container, fixture } = await setup({ getState });
    await fixture.whenStable();
    expect(toggle(container)).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });
});
