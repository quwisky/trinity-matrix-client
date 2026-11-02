import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  KEEP_MENTION_RECORD_PREFERENCE,
  MentionIndexService,
  MentionInboxPreferences,
  SHOW_INBOX_PREFERENCE,
  provideMentionInboxPreferences,
} from '@trinity/data-access/notifications';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  NEVER,
  Observable,
  Subject,
  firstValueFrom,
  of,
  throwError,
} from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { InboxSettingsGroupComponent } from './inbox-settings-group.component';

const SHOW = SHOW_INBOX_PREFERENCE.persistence.key;
const KEEP = KEEP_MENTION_RECORD_PREFERENCE.persistence.key;
const DELETE_FAILED = "Couldn't delete the record. Try again.";
const SAVE_FAILED = 'Couldn’t save this setting. Try again.';

interface Options {
  readonly stored?: Record<string, boolean>;
  readonly count?: Observable<number>;
  readonly confirmed?: Observable<boolean>;
  readonly writesFail?: boolean;
  readonly deleteFails?: boolean;
  /** Holds every preference read, leaving the stored setting unknown. */
  readonly readsHeld?: boolean;
}

async function setup(options: Options = {}) {
  const stored = { ...options.stored };
  const adapter: PreferenceStorageAdapter = {
    read: ({ key }) =>
      options.readsHeld
        ? NEVER
        : of<PreferenceStorageReadOutcome>(
            key in stored
              ? {
                  kind: 'found',
                  payload: JSON.stringify({ version: 1, value: stored[key] }),
                }
              : { kind: 'missing' },
          ),
    write: () =>
      of(
        options.writesFail
          ? ({
              kind: 'unavailable',
              diagnostic: { code: 'preference-storage-write-failed' },
            } as never)
          : ({ kind: 'completed' } as const),
      ),
  };
  const deleteFails = signal(options.deleteFails ?? false);
  const deleteFailed = signal(false);
  const order: string[] = [];
  const count = vi.fn((_accountId?: string) => options.count ?? of(3));
  const deleteAll = vi.fn(() => {
    order.push('deleteAll');
    deleteFailed.set(deleteFails());
    return deleteFails()
      ? throwError(() => new Error('blocked'))
      : of(undefined);
  });
  const confirm$ = vi.fn(() => options.confirmed ?? of(true));
  const show = vi.fn();
  const rendered = await render(InboxSettingsGroupComponent, {
    providers: [
      provideMentionInboxPreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      MockProvider(MentionIndexService, {
        count,
        deleteAll,
        deleteFailed: deleteFailed.asReadonly(),
      }),
      MockProvider(TrnAlertService, { confirm$ }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  const prefs = TestBed.inject(MentionInboxPreferences);
  if (!options.readsHeld) {
    await firstValueFrom(prefs.init());
  }
  const setKeepRecord = vi.spyOn(prefs, 'setKeepRecord');
  const setShowInbox = vi.spyOn(prefs, 'setShowInbox');
  const settle = async (): Promise<void> => {
    await rendered.fixture.whenStable();
    rendered.fixture.detectChanges();
  };
  await settle();
  return {
    ...rendered,
    prefs,
    count,
    deleteAll,
    deleteFails,
    deleteFailed,
    confirm$,
    show,
    order,
    setKeepRecord,
    setShowInbox,
    settle,
  };
}

const showSwitch = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', { name: 'Show the inbox' });
const recordSwitch = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', {
    name: 'Keep a record of mentions on this device',
  });
const message = (confirm$: { mock: { calls: unknown[][] } }): string =>
  (confirm$.mock.calls[0]?.[0] as { message: string }).message;

describe('InboxSettingsGroupComponent', () => {
  let scrollIntoView: Mock<Element['scrollIntoView']>;

  beforeEach(() => {
    // jsdom has no layout, so it leaves this out.
    scrollIntoView = vi.fn<Element['scrollIntoView']>();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('On, on: full inbox; both switches on by default', async () => {
    const { prefs } = await setup();

    expect(showSwitch().checked).toBe(true);
    expect(recordSwitch().checked).toBe(true);
    expect(recordSwitch().disabled).toBe(false);
    expect(prefs.recordAllowed()).toBe(true);
    expect(screen.getByText('Show the inbox')).toBeTruthy();
    expect(
      screen.getByText(
        'Adds an Inbox button for catching up on mentions and notifications.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId('notif-keep-mention-record').textContent,
    ).toContain(
      'Lets the inbox show older mentions and mentions in encrypted rooms. Stores which messages mentioned you, not what they said. Keeps your newest 2,000 mentions.',
    );
    expect(
      screen.getByText('These apply to every account on this device.'),
    ).toBeTruthy();
  });

  it('On, off: inbox stays, Mentions note shows', async () => {
    const { prefs } = await setup({ stored: { [KEEP]: false } });

    expect(showSwitch().checked).toBe(true);
    expect(recordSwitch().checked).toBe(false);
    expect(recordSwitch().disabled).toBe(false);
    // The inbox reads these: the button stays, and without recording the note shows.
    expect(prefs.showInbox()).toBe(true);
    expect(prefs.recordAllowed()).toBe(false);
  });

  it('Inbox off: record switch disabled and reads off; no button, nothing fetched, nothing recorded', async () => {
    const { prefs } = await setup({ stored: { [SHOW]: false } });

    expect(showSwitch().checked).toBe(false);
    expect(recordSwitch().checked).toBe(false);
    expect(recordSwitch().disabled).toBe(true);
    // The stored choice survives, so turning the inbox back on keeps it.
    expect(prefs.keepRecord()).toBe(true);
    expect(prefs.showInbox()).toBe(false);
    expect(prefs.recordAllowed()).toBe(false);
  });

  it('asks only when the record holds mentions', async () => {
    const { confirm$, setKeepRecord, settle } = await setup({ count: of(0) });

    recordSwitch().click();
    await settle();

    expect(confirm$).not.toHaveBeenCalled();
    expect(setKeepRecord).toHaveBeenCalledExactlyOnceWith(false);
    expect(recordSwitch().checked).toBe(false);
  });

  it('asks before turning off the whole inbox too, and leaves the stored record choice alone', async () => {
    const { confirm$, setShowInbox, setKeepRecord, prefs, deleteAll, settle } =
      await setup();

    showSwitch().click();
    await settle();

    expect(confirm$).toHaveBeenCalledOnce();
    expect(setShowInbox).toHaveBeenCalledExactlyOnceWith(false);
    expect(setKeepRecord).not.toHaveBeenCalled();
    expect(deleteAll).toHaveBeenCalledOnce();
    expect(prefs.keepRecord()).toBe(true);
    expect(showSwitch().checked).toBe(false);
    expect(recordSwitch().checked).toBe(false);
  });

  it('the question counts every account', async () => {
    const { confirm$, count, settle } = await setup({ count: of(214) });

    recordSwitch().click();
    await settle();

    expect(count).toHaveBeenCalledExactlyOnceWith();
    expect(confirm$).toHaveBeenCalledExactlyOnceWith({
      header: "Delete this device's mention history?",
      message:
        "Trinity will delete its record of 214 mentions on this device. You can't get it back. Older mentions in encrypted rooms, and those from rooms set to mentions only, won't appear in the inbox again. Your messages themselves aren't deleted.",
      confirmText: 'Delete and turn off',
      cancelText: 'Cancel',
      variant: 'danger',
    });
  });

  it('says "1 mention" for one', async () => {
    const { confirm$, settle } = await setup({ count: of(1) });

    recordSwitch().click();
    await settle();

    expect(message(confirm$)).toContain('its record of 1 mention on this');
  });

  it('Cancel leaves the switch on and changes nothing', async () => {
    const { deleteAll, setKeepRecord, settle } = await setup({
      confirmed: of(false),
    });

    recordSwitch().click();
    await settle();

    expect(setKeepRecord).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
    expect(recordSwitch().checked).toBe(true);
  });

  it('holds the switch on while the question is open, and declines further changes', async () => {
    const confirmed = new Subject<boolean>();
    const { confirm$, settle } = await setup({ confirmed });

    recordSwitch().click();
    await settle();
    expect(recordSwitch().checked).toBe(true);
    expect(recordSwitch().getAttribute('aria-disabled')).toBe('true');

    recordSwitch().click();
    showSwitch().click();
    await settle();
    expect(confirm$).toHaveBeenCalledOnce();

    confirmed.next(false);
    confirmed.complete();
    await settle();
    expect(recordSwitch().getAttribute('aria-disabled')).toBeNull();
  });

  it('confirming turns off first, then deletes for every account', async () => {
    const { deleteAll, order, setKeepRecord, settle, show } = await setup();
    setKeepRecord.mockImplementationOnce(() => {
      order.push('set');
      return of({ kind: 'completed' } as const);
    });

    recordSwitch().click();
    await settle();

    expect(order).toEqual(['set', 'deleteAll']);
    expect(deleteAll).toHaveBeenCalledExactlyOnceWith();
    expect(show).not.toHaveBeenCalled();
  });

  it('a decision made before leaving the page is still carried out', async () => {
    const write = new Subject<{ kind: 'completed' }>();
    const { deleteAll, fixture, setKeepRecord, settle } = await setup();
    setKeepRecord.mockImplementationOnce(() => write);

    recordSwitch().click();
    await settle();
    fixture.destroy();
    write.next({ kind: 'completed' });

    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it('a question still open when the page goes is treated as unanswered', async () => {
    const confirmed = new Subject<boolean>();
    const { deleteAll, fixture, setKeepRecord, settle } = await setup({
      confirmed,
    });

    recordSwitch().click();
    await settle();
    fixture.destroy();
    confirmed.next(true);

    expect(setKeepRecord).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('a failed delete leaves the switch off, says so, and offers Try again', async () => {
    const { settle, show } = await setup({ deleteFails: true });

    recordSwitch().click();
    await settle();

    expect(recordSwitch().checked).toBe(false);
    const failure = screen.getByTestId('notif-mention-delete-failed');
    expect(failure.textContent?.trim()).toBe(DELETE_FAILED);
    expect(failure.getAttribute('role')).toBe('alert');
    expect(
      screen.getByTestId('notif-mention-delete-retry').textContent?.trim(),
    ).toBe('Try again');
    expect(show).not.toHaveBeenCalled();
  });

  it('brings the error into view', async () => {
    const { settle } = await setup({ deleteFails: true });
    expect(scrollIntoView).not.toHaveBeenCalled();

    recordSwitch().click();
    await settle();

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: 'nearest',
    });
  });

  it('Try again deletes, and clears the error', async () => {
    const { deleteAll, deleteFails, settle } = await setup({
      deleteFails: true,
    });
    recordSwitch().click();
    await settle();

    screen.getByTestId('notif-mention-delete-retry').click();
    await settle();
    expect(deleteAll).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('notif-mention-delete-failed')).toBeTruthy();

    deleteFails.set(false);
    screen.getByTestId('notif-mention-delete-retry').click();
    await settle();

    expect(deleteAll).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('notif-mention-delete-failed')).toBeNull();
    expect(screen.queryByTestId('notif-mention-delete-retry')).toBeNull();
    expect(recordSwitch().checked).toBe(false);
  });

  it('keeps keyboard focus in the group when Try again succeeds and goes away', async () => {
    const { deleteFails, settle } = await setup({ deleteFails: true });
    recordSwitch().click();
    await settle();

    deleteFails.set(false);
    const retry = screen.getByTestId('notif-mention-delete-retry');
    retry.focus();
    retry.click();
    await settle();

    expect(document.activeElement).toBe(showSwitch());
  });

  it('leaves focus on Try again while it keeps failing', async () => {
    const { settle } = await setup({ deleteFails: true });
    recordSwitch().click();
    await settle();

    const retry = screen.getByTestId('notif-mention-delete-retry');
    retry.focus();
    retry.click();
    await settle();

    expect(document.activeElement).toBe(retry);
  });

  it('takes one Try again at a time', async () => {
    const { deleteAll, settle } = await setup({ deleteFails: true });
    recordSwitch().click();
    await settle();
    deleteAll.mockClear();
    deleteAll.mockReturnValueOnce(NEVER);

    const retry = screen.getByTestId('notif-mention-delete-retry');
    retry.click();
    await settle();
    expect(retry.getAttribute('aria-busy')).toBe('true');
    retry.click();

    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it('a failed save keeps the switch on and deletes nothing', async () => {
    const { deleteAll, settle, show } = await setup({ writesFail: true });

    recordSwitch().click();
    await settle();

    expect(recordSwitch().checked).toBe(true);
    expect(deleteAll).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledExactlyOnceWith(SAVE_FAILED, {
      duration: 4000,
      variant: 'danger',
    });
  });

  it('a save that throws reads the same as one that fails', async () => {
    const { deleteAll, setKeepRecord, settle, show } = await setup();
    setKeepRecord.mockImplementationOnce(() =>
      throwError(() => new Error('write broke')),
    );

    recordSwitch().click();
    await settle();

    expect(recordSwitch().checked).toBe(true);
    expect(deleteAll).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
  });

  it('asks without a number when the count cannot be read', async () => {
    const { confirm$, settle } = await setup({
      count: throwError(() => new Error('read failed')),
    });

    recordSwitch().click();
    await settle();

    expect(message(confirm$)).toContain(
      "Trinity will delete its record of mentions on this device. You can't get it back.",
    );
  });

  it('asks without a number when the count never answers', async () => {
    const { confirm$ } = await setup({ count: NEVER });
    vi.useFakeTimers();

    recordSwitch().click();
    await vi.advanceTimersByTimeAsync(999);
    expect(confirm$).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(message(confirm$)).toContain('its record of mentions on this');
  });

  it('turning on after a failed delete retries it before recording', async () => {
    const { deleteAll, deleteFails, order, setKeepRecord, settle } =
      await setup({ deleteFails: true });
    recordSwitch().click();
    await settle();
    expect(deleteAll).toHaveBeenCalledOnce();
    setKeepRecord.mockClear();

    // Still failing: stays off.
    recordSwitch().click();
    await settle();
    expect(deleteAll).toHaveBeenCalledTimes(2);
    expect(setKeepRecord).not.toHaveBeenCalled();
    expect(recordSwitch().checked).toBe(false);
    expect(screen.getByTestId('notif-mention-delete-failed')).toBeTruthy();

    deleteFails.set(false);
    setKeepRecord.mockImplementationOnce(() => {
      order.push('set');
      return of({ kind: 'completed' } as const);
    });
    order.length = 0;
    recordSwitch().click();
    await settle();
    expect(order).toEqual(['deleteAll', 'set']);
    expect(screen.queryByTestId('notif-mention-delete-failed')).toBeNull();
  });

  it('turning the inbox on retries only when that would start recording', async () => {
    const declined = await setup({
      stored: { [KEEP]: false },
      deleteFails: true,
    });
    showSwitch().click();
    await declined.settle();
    expect(declined.deleteAll).toHaveBeenCalledOnce();
    expect(showSwitch().checked).toBe(false);

    // The record stays off, so a delete still failing has no reason to hold the inbox back.
    declined.deleteAll.mockClear();
    showSwitch().click();
    await declined.settle();
    expect(declined.deleteAll).not.toHaveBeenCalled();
    expect(showSwitch().checked).toBe(true);
    expect(screen.getByTestId('notif-mention-delete-failed')).toBeTruthy();
  });

  it('turning the inbox on with the record kept retries a failed delete first', async () => {
    const { deleteAll, settle, setShowInbox } = await setup({
      deleteFails: true,
    });
    showSwitch().click();
    await settle();
    setShowInbox.mockClear();
    deleteAll.mockClear();

    showSwitch().click();
    await settle();

    expect(deleteAll).toHaveBeenCalledOnce();
    expect(setShowInbox).not.toHaveBeenCalled();
    expect(showSwitch().checked).toBe(false);
  });

  it('turning on starts empty', async () => {
    const { confirm$, deleteAll, setKeepRecord, settle } = await setup({
      stored: { [KEEP]: false },
    });

    recordSwitch().click();
    await settle();

    expect(confirm$).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
    expect(setKeepRecord).toHaveBeenCalledExactlyOnceWith(true);
    expect(recordSwitch().checked).toBe(true);
  });

  it('holds the switches while the stored setting is unknown', async () => {
    const { prefs } = await setup({ readsHeld: true });

    expect(prefs.recordAllowed()).toBe(false);
    expect(prefs.recordDeclined()).toBe(false);
    expect(showSwitch().disabled).toBe(true);
    expect(recordSwitch().disabled).toBe(true);
    expect(
      screen.getByTestId('notif-show-inbox').getAttribute('aria-busy'),
    ).toBe('true');
  });
});
