import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TrnSwitchComponent } from '@trinity/components/controls';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  DiagnosticLogNotDeletedError,
  DiagnosticLogService,
  type DiagnosticAvailability,
} from '@trinity/data-access/diagnostic-log';
import type { PreferenceCommandOutcome } from '@trinity/runtime/preferences';
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
  const rendered = await render(DiagnosticsGroupComponent, {
    providers: [
      MockProvider(DiagnosticLogService, {
        clear,
        setKeepLog,
        keepLog: keepLog.asReadonly(),
        available: available.asReadonly(),
      }),
      MockProvider(TrnSurfaceService, { open }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  await rendered.fixture.whenStable();
  rendered.fixture.detectChanges();
  return { ...rendered, available, open, show, clear, setKeepLog };
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

  it('says when logs last for this session only', async () => {
    await setup({ available: 'memory-only' });

    expect(screen.getByTestId('advanced-diagnostics-memory-only')).toBeTruthy();
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
      'The log is turned off, but Trinity couldn’t delete it from this device. Try again.',
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
    const { fixture, available } = await setup({ available: 'pending' });

    expect(keepLogSwitch(fixture).disabled()).toBe(true);
    expect(
      screen
        .getByTestId('advanced-keep-diagnostic-log')
        .getAttribute('aria-busy'),
    ).toBe('true');

    available.set('persistent');
    fixture.detectChanges();

    expect(keepLogSwitch(fixture).disabled()).toBe(false);
  });

  it('does not offer Clear or the memory-only note while the setting is pending', async () => {
    await setup({ available: 'pending' });

    expect(screen.queryByTestId('advanced-clear-diagnostic-logs')).toBeNull();
    expect(screen.queryByTestId('advanced-diagnostics-memory-only')).toBeNull();
  });
});
