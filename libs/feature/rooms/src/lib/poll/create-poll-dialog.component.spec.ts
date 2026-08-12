import { DialogRef } from '@trinity/kit/overlay';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { CreatePollDialogComponent } from './create-poll-dialog.component';

async function setup() {
  const close = vi.fn();
  const { fixture } = await render(CreatePollDialogComponent, {
    providers: [{ provide: DialogRef, useValue: { close } }],
  });
  return { cmp: fixture.componentInstance, close };
}

describe('CreatePollDialogComponent', () => {
  it('requires a question and at least two non-empty options', async () => {
    const { cmp } = await setup();
    expect(cmp.valid()).toBe(false);

    cmp.question.set('Best fruit?');
    expect(cmp.valid()).toBe(false); // options still blank

    cmp.options.set(['Apple', 'Pear']);
    expect(cmp.valid()).toBe(true);
  });

  it('closes with the trimmed question and non-empty options on create', async () => {
    const { cmp, close } = await setup();
    cmp.question.set('  Best fruit?  ');
    cmp.options.set(['Apple', '  ', 'Pear']);

    cmp.create();

    expect(close).toHaveBeenCalledWith({
      question: 'Best fruit?',
      options: ['Apple', 'Pear'],
    });
  });

  it('adds an option field', async () => {
    const { cmp } = await setup();
    expect(cmp.options().length).toBe(2);
    cmp.addOption();
    expect(cmp.options().length).toBe(3);
  });

  it('removes an option field but never below the two-option minimum', async () => {
    const { cmp } = await setup();
    cmp.options.set(['Apple', 'Pear', 'Cherry']);

    cmp.removeOption(1);
    expect(cmp.options()).toEqual(['Apple', 'Cherry']);

    // At the minimum, removing is a no-op.
    cmp.removeOption(0);
    expect(cmp.options()).toEqual(['Apple', 'Cherry']);
  });

  it('cancels with null', async () => {
    const { cmp, close } = await setup();
    cmp.cancel();
    expect(close).toHaveBeenCalledWith(null);
  });
});
