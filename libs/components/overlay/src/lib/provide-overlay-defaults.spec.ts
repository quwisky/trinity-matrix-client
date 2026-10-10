import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TrnDialogService } from './dialog/trn-dialog.service';
import { provideTrnOverlayDefaults } from './provide-overlay-defaults';

@Component({ template: '<p>Verify device</p>' })
class EmptyDialogComponent {}

describe('provideTrnOverlayDefaults', () => {
  const nodes: HTMLElement[] = [];

  afterEach(() => {
    TestBed.inject(TrnDialogService).closeAll();
    for (const node of nodes.splice(0)) node.remove();
  });

  it('sees a press made before any dialog service exists', () => {
    TestBed.configureTestingModule({
      providers: [provideTrnOverlayDefaults()],
    });
    const appRef = TestBed.inject(ApplicationRef);
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    const opener = document.createElement('button');
    nodes.push(heading, opener);
    document.body.append(heading, opener);
    heading.focus();

    // A tap: jsdom's click() moves no focus, as WebKit's does not.
    opener.click();
    const ref = TestBed.inject(TrnDialogService).open(EmptyDialogComponent);
    appRef.tick();
    ref.close();
    appRef.tick();

    expect(document.activeElement).toBe(opener);
  });
});
