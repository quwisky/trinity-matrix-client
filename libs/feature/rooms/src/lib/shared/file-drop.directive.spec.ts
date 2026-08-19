import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnFileDropDirective } from './file-drop.directive';

@Component({
  selector: 'trn-drop-host',
  template: '<p>timeline</p>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [
    { directive: TrnFileDropDirective, inputs: [], outputs: [] },
  ],
})
class DropHostComponent {
  readonly drop = inject(TrnFileDropDirective);
  readonly dropped: File[][] = [];

  constructor() {
    this.drop.filesDropped.subscribe((files) => this.dropped.push([...files]));
  }
}

const png = (name: string) => new File(['x'], name, { type: 'image/png' });

/**
 * jsdom implements neither `DragEvent` nor `DataTransfer`, so a real `Event` carries a
 * duck-typed `dataTransfer` — the same trick the composer spec uses for `ClipboardEvent`,
 * except dispatched for real so the directive's own `host` bindings are what run. Calling the
 * handlers directly would leave a deleted binding undetectable.
 */
function drag(name: string, opts: { types?: string[]; files?: File[] } = {}) {
  const dataTransfer = {
    types: opts.types ?? ['Files'],
    files: opts.files ?? [],
    dropEffect: 'none',
  };
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return { event, dataTransfer };
}

async function setup() {
  const { fixture } = await render(DropHostComponent);
  const host = fixture.nativeElement as HTMLElement;
  /** Dispatch a drag event on the host and report whether the default was prevented. */
  const fire = (name: string, opts?: { types?: string[]; files?: File[] }) => {
    const { event, dataTransfer } = drag(name, opts);
    host.dispatchEvent(event);
    return { prevented: event.defaultPrevented, dataTransfer };
  };
  return { fixture, cmp: fixture.componentInstance, host, fire };
}

describe('TrnFileDropDirective', () => {
  it('prevents the default on dragover, which is what makes a drop possible at all', async () => {
    // Not ceremony: the default action for dragover is "reject this drag", and without
    // preventing it the browser never fires `drop`. The whole feature hangs off this line.
    const { fire } = await setup();

    const { prevented, dataTransfer } = fire('dragover');

    expect(prevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy'); // a copy cursor, not a move
  });

  it('ignores a drag that is not carrying files', async () => {
    // Dragging selected text across the timeline must not raise the overlay, and must not
    // swallow the browser's own default handling of it.
    const { cmp, fire } = await setup();
    const text = { types: ['text/plain'] };

    fire('dragenter', text);
    const { prevented } = fire('dragover', text);

    expect(cmp.drop.active()).toBe(false);
    expect(prevented).toBe(false);
  });

  it('stays active while the pointer crosses child elements', async () => {
    // The reason this counts rather than toggles: moving onto a child fires `dragleave` on
    // the parent BEFORE `dragenter` on the child, so a boolean flickers off for every
    // message row crossed — and the overlay strobes its way across the conversation.
    const { cmp, fire } = await setup();

    fire('dragenter'); // onto the list
    expect(cmp.drop.active()).toBe(true);

    fire('dragenter'); // onto a row inside it
    fire('dragleave'); // ...leaving the list, in that order
    expect(cmp.drop.active()).toBe(true);

    fire('dragleave'); // and finally out of the row
    expect(cmp.drop.active()).toBe(false);
  });

  it('does not need two enters to reactivate after an unmatched leave', async () => {
    // A drag begun outside can leave without ever having entered. Left unfloored the depth
    // goes negative and the overlay stays hidden through the next drag.
    const { cmp, fire } = await setup();

    fire('dragleave');
    fire('dragenter');

    expect(cmp.drop.active()).toBe(true);
  });

  it('emits the dropped files and stands down', async () => {
    const { cmp, fire } = await setup();
    fire('dragenter');

    const { prevented } = fire('drop', {
      files: [png('one.png'), png('two.png')],
    });

    expect(cmp.dropped[0]?.map((f) => f.name)).toEqual(['one.png', 'two.png']);
    expect(prevented).toBe(true); // or the browser navigates to the file
    expect(cmp.drop.active()).toBe(false);
  });

  it('emits nothing for a drop carrying no files, and still stands down', async () => {
    const { cmp, fire } = await setup();
    fire('dragenter');

    fire('drop', { types: ['text/plain'] });

    expect(cmp.dropped).toEqual([]);
    // Cleared even on a drag this directive wants nothing to do with — otherwise the overlay
    // is left covering the room until the next drag happens to end on it.
    expect(cmp.drop.active()).toBe(false);
  });
});
