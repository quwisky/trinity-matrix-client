import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  commandLine: { hasSwitch: vi.fn((_name: string) => false) },
  exit: vi.fn(),
}));
const electronDialog = vi.hoisted(() => ({ showErrorBox: vi.fn() }));
vi.mock('electron', () => ({ app: electronApp, dialog: electronDialog }));

import { checkRemoteDebuggingOrExit } from './remote-debugging';

function launch(packaged: boolean, switches: readonly string[]): boolean {
  electronApp.isPackaged = packaged;
  electronApp.commandLine.hasSwitch.mockImplementation((name) =>
    switches.includes(name),
  );
  return checkRemoteDebuggingOrExit();
}

describe('remote debugging in release builds', () => {
  beforeEach(() => {
    electronApp.exit.mockClear();
    electronDialog.showErrorBox.mockClear();
  });

  it.each(['remote-debugging-port', 'remote-debugging-pipe'])(
    'refuses to start a packaged build launched with --%s',
    (name) => {
      expect(launch(true, [name])).toBe(false);
      expect(electronDialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
        'Trinity cannot start',
        'Remote debugging is not available in release builds.',
      );
      expect(electronApp.exit).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it('starts a packaged build without remote debugging switches', () => {
    expect(launch(true, ['remote-allow-origins'])).toBe(true);
    expect(electronDialog.showErrorBox).not.toHaveBeenCalled();
    expect(electronApp.exit).not.toHaveBeenCalled();
  });

  it('lets development runs use remote debugging', () => {
    expect(
      launch(false, ['remote-debugging-port', 'remote-debugging-pipe']),
    ).toBe(true);
    expect(electronDialog.showErrorBox).not.toHaveBeenCalled();
    expect(electronApp.exit).not.toHaveBeenCalled();
  });
});
