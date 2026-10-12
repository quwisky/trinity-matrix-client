import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TrnSwitchComponent } from '@trinity/components/controls';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_LOG_STORE_REMOVER,
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
  MemoryLogStore,
  provideDiagnosticLog,
  type DiagnosticAvailability,
} from '@trinity/data-access/diagnostic-log';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceCommandOutcome,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ReportBugDialogComponent } from '../report-bug/report-bug-dialog.component';
import { DiagnosticsGroupComponent } from './diagnostics-group.component';

interface SetupOptions {
  readonly cleared?: Observable<void>;
  readonly available?: DiagnosticAvailability;
  readonly keepLog?: boolean;
  /** Whether the stored setting has been read; it has unless a test says otherwise. */
  readonly settingKnown?: boolean;
  readonly saved?: PreferenceCommandOutcome;
  readonly setKeepLogResult?: () => Observable<PreferenceCommandOutcome>;
}

async function setup(options: SetupOptions = {}) {
  const open = vi.fn();
  const show = vi.fn();
  const clear = vi.fn(() => options.cleared ?? of(undefined));
  const keepLog = signal(options.keepLog ?? true);
  const setKeepLog = vi.fn((keep: boolean) => {
    keepLog.set(keep);
    return (
      options.setKeepLogResult?.() ??
      of(options.saved ?? ({ kind: 'completed' } as const))
    );
  });
  const available = signal(options.available ?? 'persistent');
  const settingKnown = signal(options.settingKnown ?? true);
  const rendered = await render(DiagnosticsGroupComponent, {
    providers: [
      MockProvider(DiagnosticLogService, {
        clear,
        setKeepLog,
        keepLog: keepLog.asReadonly(),
        available: available.asReadonly(),
        settingKnown: settingKnown.asReadonly(),
      }),
      MockProvider(TrnSurfaceService, { open }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  await rendered.fixture.whenStable();
  rendered.fixture.detectChanges();
  return {
    ...rendered,
    available,
    settingKnown,
    open,
    show,
    clear,
    setKeepLog,
  };
}

/**
 * The group over the real service, started as the app starts it, with installation
 * preferences answering `read` and a log store that is never opened unless written to.
 */
async function setupWithService(
  read: PreferenceStorageReadOutcome,
  storage: {
    readonly openStore?: () => Promise<MemoryLogStore>;
    readonly removeStore?: () => Promise<void>;
  } = {},
) {
  const show = vi.fn();
  const rendered = await render(DiagnosticsGroupComponent, {
    providers: [
      {
        provide: PREFERENCE_STORAGE_ADAPTER,
        useValue: {
          read: () => of(read),
          write: () => of({ kind: 'completed' } as const),
        },
      },
      {
        provide: DIAGNOSTIC_LOG_STORE_FACTORY,
        useValue:
          storage.openStore ?? (() => Promise.resolve(new MemoryLogStore())),
      },
      {
        provide: DIAGNOSTIC_LOG_STORE_REMOVER,
        useValue: storage.removeStore ?? (() => Promise.resolve()),
      },
      provideDiagnosticLog(),
      MockProvider(TrnSurfaceService, { open: vi.fn() }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  await rendered.fixture.whenStable();
  rendered.fixture.detectChanges();
  return { ...rendered, show };
}

function keepLogSwitch(
  fixture: ComponentFixture<DiagnosticsGroupComponent>,
): TrnSwitchComponent {
  return fixture.debugElement.query(By.directive(TrnSwitchComponent))
    .componentInstance as TrnSwitchComponent;
}

describe('DiagnosticsGroupComponent', () => {
  it('opens the report dialog from Report a bug', async () => {
    const { open } = await setup();

    screen.getByRole('button', { name: 'Report a bug' }).click();

    expect(open).toHaveBeenCalledWith(ReportBugDialogComponent, {
      ariaLabel: 'Report a bug',
      autoFocus: '[data-autofocus]',
    });
  });

  it('reflects and toggles Keep a diagnostic log, and says what turning it off does', async () => {
    const { fixture, setKeepLog } = await setup();
    const row = screen.getByTestId('advanced-keep-diagnostic-log');
    const control = keepLogSwitch(fixture);

    expect(row.textContent).toContain('Keep a diagnostic log');
    expect(row.textContent).toContain(
      'Tokens, keys and messages are never stored.',
    );
    expect(row.textContent).toContain('Turning this off deletes the log.');
    expect(control.checked()).toBe(true); // on by default

    control.checkedChange.emit(false);
    fixture.detectChanges();

    expect(setKeepLog).toHaveBeenCalledWith(false);
    expect(control.checked()).toBe(false);
  });

  it('hides Clear diagnostic logs while the log is off, and keeps Report a bug', async () => {
    await setup({ keepLog: false });

    expect(screen.queryByTestId('advanced-clear-diagnostic-logs')).toBeNull();
    expect(screen.getByTestId('advanced-report-bug')).toBeTruthy();
  });

  it('says when the setting could not be saved', async () => {
    const { fixture, show } = await setup({
      saved: {
        kind: 'unavailable',
        recovery: 'retry-storage',
        diagnostic: { code: 'preference-storage-write-failed' },
      },
    });

    keepLogSwitch(fixture).checkedChange.emit(false);

    expect(show).toHaveBeenCalledWith(
      'Couldn’t save this setting. Try again.',
      {
        duration: 4000,
        variant: 'danger',
      },
    );
  });

  it('clears the diagnostic logs and says so', async () => {
    const { clear, show } = await setup();

    screen.getByRole('button', { name: 'Clear diagnostic logs' }).click();

    expect(clear).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith('Diagnostic logs cleared.', {
      duration: 3000,
      variant: 'success',
    });
  });

  it('says when clearing failed', async () => {
    const { show } = await setup({
      cleared: throwError(() => new Error('blocked')),
    });

    screen.getByRole('button', { name: 'Clear diagnostic logs' }).click();

    expect(show).toHaveBeenCalledWith(
      'Couldn’t clear the diagnostic logs. Try again.',
      { duration: 4000, variant: 'danger' },
    );
  });

  describe('Clear diagnostic logs while the database cannot be opened', () => {
    const LOG_ON = { kind: 'missing' } as const;
    const unopenable = () =>
      Promise.reject(new Error('IndexedDB open timed out'));

    it('deletes the database and says the logs were cleared', async () => {
      const removeStore = vi.fn(() => Promise.resolve());
      const { show } = await setupWithService(LOG_ON, {
        openStore: unopenable,
        removeStore,
      });

      screen.getByRole('button', { name: 'Clear diagnostic logs' }).click();

      await vi.waitFor(() =>
        expect(show).toHaveBeenCalledWith('Diagnostic logs cleared.', {
          duration: 3000,
          variant: 'success',
        }),
      );
      expect(removeStore).toHaveBeenCalled();
    });

    it('says clearing failed when the database cannot be deleted either', async () => {
      const { show } = await setupWithService(LOG_ON, {
        openStore: unopenable,
        removeStore: () => Promise.reject(new Error('delete blocked')),
      });

      screen.getByRole('button', { name: 'Clear diagnostic logs' }).click();

      await vi.waitFor(() =>
        expect(show).toHaveBeenCalledWith(
          'Couldn’t clear the diagnostic logs. Try again.',
          { duration: 4000, variant: 'danger' },
        ),
      );
      expect(show).not.toHaveBeenCalledWith(
        'Diagnostic logs cleared.',
        expect.anything(),
      );
    });
  });

  it('says when logs last for this session only', async () => {
    await setup({ available: 'memory-only' });

    expect(
      screen.getByTestId('advanced-diagnostics-memory-only').textContent,
    ).toContain('This device isn’t letting Trinity store logs');
  });

  it('keeps the switch off and says the log was not deleted, when deleting fails', async () => {
    const { fixture, show } = await setup({
      setKeepLogResult: () =>
        throwError(() => new DiagnosticLogNotDeletedError()),
    });

    keepLogSwitch(fixture).checkedChange.emit(false);
    fixture.detectChanges();

    expect(keepLogSwitch(fixture).checked()).toBe(false);
    expect(
      screen.getByTestId('advanced-diagnostics-not-deleted').textContent,
    ).toContain(
      'The log is turned off, but Trinity couldn’t delete it from this device. Use Clear diagnostic logs to try again.',
    );
    expect(screen.getByTestId('advanced-clear-diagnostic-logs')).toBeTruthy();
    expect(show).not.toHaveBeenCalled();
  });

  it('drops the not-deleted message once clearing works', async () => {
    const { fixture } = await setup({
      setKeepLogResult: () =>
        throwError(() => new DiagnosticLogNotDeletedError()),
    });
    keepLogSwitch(fixture).checkedChange.emit(false);
    fixture.detectChanges();

    screen.getByRole('button', { name: 'Clear diagnostic logs' }).click();
    fixture.detectChanges();

    expect(screen.queryByTestId('advanced-diagnostics-not-deleted')).toBeNull();
  });

  it('says when the setting failed for another reason', async () => {
    const { fixture, show } = await setup({
      setKeepLogResult: () => throwError(() => new Error('boom')),
    });

    keepLogSwitch(fixture).checkedChange.emit(false);

    expect(show).toHaveBeenCalledWith(
      'Couldn’t save this setting. Try again.',
      {
        duration: 4000,
        variant: 'danger',
      },
    );
    expect(screen.queryByTestId('advanced-diagnostics-not-deleted')).toBeNull();
  });

  it('disables the switch until the stored setting is known', async () => {
    const { fixture, settingKnown } = await setup({
      settingKnown: false,
      available: 'pending',
    });

    expect(keepLogSwitch(fixture).disabled()).toBe(true);
    expect(
      screen
        .getByTestId('advanced-keep-diagnostic-log')
        .getAttribute('aria-busy'),
    ).toBe('true');

    settingKnown.set(true);
    fixture.detectChanges();

    expect(keepLogSwitch(fixture).disabled()).toBe(false);
  });

  it('enables the switch once the setting is known, before any log is stored', async () => {
    const { fixture } = await setup({ available: 'pending' });

    expect(keepLogSwitch(fixture).disabled()).toBe(false);
  });

  it('leaves the switch enabled and off when the stored setting is off', async () => {
    const { fixture } = await setupWithService({
      kind: 'found',
      payload: JSON.stringify({ version: 1, value: false }),
    });

    expect(keepLogSwitch(fixture).disabled()).toBe(false);
    expect(keepLogSwitch(fixture).checked()).toBe(false);
  });

  it('leaves the switch enabled and off when the setting cannot be read', async () => {
    const { fixture } = await setupWithService({
      kind: 'unavailable',
      diagnostic: { code: 'storage-down' },
    });

    expect(keepLogSwitch(fixture).disabled()).toBe(false);
    expect(keepLogSwitch(fixture).checked()).toBe(false);
  });

  it('does not offer Clear or the memory-only note while the setting is pending', async () => {
    await setup({ settingKnown: false, available: 'memory-only' });

    expect(screen.queryByTestId('advanced-clear-diagnostic-logs')).toBeNull();
    expect(screen.queryByTestId('advanced-diagnostics-memory-only')).toBeNull();
  });
});
