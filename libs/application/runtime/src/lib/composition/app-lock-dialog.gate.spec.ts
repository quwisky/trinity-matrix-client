import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { AppLockDialogGate } from './app-lock-dialog.gate';

function setup(initial: AppLockStatus) {
  const status = signal<AppLockStatus>(initial);
  TestBed.configureTestingModule({
    providers: [MockProvider(AppLockService, { status: status.asReadonly() })],
  });
  return { gate: TestBed.inject(AppLockDialogGate), status };
}

describe('AppLockDialogGate', () => {
  it('lets a dialog open at once while nothing is locked', () => {
    const { gate } = setup('unlocked');
    let opened = false;
    gate.whenClear().subscribe(() => (opened = true));
    expect(gate.clear()).toBe(true);
    expect(opened).toBe(true);
  });

  it('holds while locked, or before the lock state is known', () => {
    const { gate, status } = setup('unknown');
    expect(gate.clear()).toBe(false);
    status.set('locked');
    expect(gate.clear()).toBe(false);
    status.set('off');
    expect(gate.clear()).toBe(true);
  });

  it('releases once unlocked and the lock screen has closed', () => {
    const { gate, status } = setup('locked');
    gate.coverShown(true);
    let opened = 0;
    gate.whenClear().subscribe(() => (opened += 1));
    TestBed.tick();
    expect(opened).toBe(0);
    status.set('unlocked');
    TestBed.tick();
    // The lock screen is still open: its close puts focus back first.
    expect(gate.clear()).toBe(false);
    expect(opened).toBe(0);
    gate.coverShown(false);
    TestBed.tick();
    expect(gate.clear()).toBe(true);
    expect(opened).toBe(1);
  });

  it('keeps holding when the app locks again before the lock screen closes', () => {
    const { gate, status } = setup('locked');
    gate.coverShown(true);
    let opened = 0;
    gate.whenClear().subscribe(() => (opened += 1));
    status.set('unlocked');
    TestBed.tick();
    status.set('locked');
    gate.coverShown(false);
    TestBed.tick();
    expect(opened).toBe(0);
    status.set('unlocked');
    TestBed.tick();
    expect(opened).toBe(1);
  });
});
