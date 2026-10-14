import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { HostSystemUiService } from './host-system-ui.service';

describe('HostSystemUiService', () => {
  function service(): HostSystemUiService {
    TestBed.configureTestingModule({ providers: [HostSystemUiService] });
    return TestBed.inject(HostSystemUiService);
  }

  it('is active from subscription until the work settles', async () => {
    const ui = service();
    const done = new Subject<string>();
    const tracked = ui.track(done);
    expect(ui.active()).toBe(false);
    const result = firstValueFrom(tracked);
    expect(ui.active()).toBe(true);
    done.next('picked');
    done.complete();
    await expect(result).resolves.toBe('picked');
    expect(ui.active()).toBe(false);
  });

  it('stays active while two pieces of system UI overlap', () => {
    const ui = service();
    const first = new Subject<void>();
    const second = new Subject<void>();
    const a = ui.track(first).subscribe();
    const b = ui.track(second).subscribe();
    first.complete();
    expect(ui.active()).toBe(true);
    second.complete();
    expect(ui.active()).toBe(false);
    a.unsubscribe();
    b.unsubscribe();
  });

  it('ends on error and on unsubscribe', async () => {
    const ui = service();
    await expect(
      firstValueFrom(ui.track(throwError(() => new Error('denied')))),
    ).rejects.toThrow('denied');
    expect(ui.active()).toBe(false);
    const open = ui.track(new Subject<void>()).subscribe();
    expect(ui.active()).toBe(true);
    open.unsubscribe();
    expect(ui.active()).toBe(false);
    await firstValueFrom(ui.track(of(1)));
    expect(ui.active()).toBe(false);
  });
});
