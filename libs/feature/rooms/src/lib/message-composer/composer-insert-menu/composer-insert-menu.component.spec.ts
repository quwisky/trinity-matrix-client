import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerInsertMenuComponent } from './composer-insert-menu.component';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

/** Open the tray and return the items CDK rendered at the document root. */
function trayItems(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[hlmdropdownmenuitem][data-testid^=insert-]',
    ),
  ];
}

function sheetItems(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid^=insert-]'),
  ].filter((item) => item.closest('trn-action-sheet'));
}

describe('ComposerInsertMenuComponent', () => {
  it('stays a plain attach button when there is nothing to collect in a tray', async () => {
    // The thread composer with no GIF provider: a one-item menu is pure friction.
    const { container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: false },
    });

    expect(
      container.querySelector('[data-testid=composer-insert-attach]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid=composer-insert]')).toBeNull();
  });

  it('emits attach from the plain button', async () => {
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: false },
    });
    let attached = 0;
    fixture.componentInstance.attachFile.subscribe(() => attached++);

    container
      .querySelector<HTMLElement>('[data-testid=composer-insert-attach]')
      ?.click();

    expect(attached).toBe(1);
  });

  it('blocks the plain button while editing, but not while uploading', async () => {
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: false },
    });
    const button = () =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid=composer-insert-attach]',
      );
    expect(button()?.disabled).toBe(false);

    fixture.componentRef.setInput('editing', true);
    fixture.detectChanges();
    expect(button()?.disabled).toBe(true);

    // Attaching during an upload is fine now: a send takes the whole staged batch, so the
    // file waits for the next press rather than colliding with the one going out.
    fixture.componentRef.setInput('editing', false);
    fixture.componentRef.setInput('uploading', true);
    fixture.detectChanges();
    expect(button()?.disabled).toBe(false);
  });

  it('offers every configured action in the tray, in order', async () => {
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        hasMenu: true,
        gifEnabled: true,
        richActions: true,
        voiceSupported: true,
        stickerEnabled: true,
      },
    });

    container
      .querySelector<HTMLElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();

    expect(trayItems().map((el) => el.getAttribute('data-testid'))).toEqual([
      'insert-attach',
      'insert-gif',
      'insert-sticker',
      'insert-poll',
      'insert-location',
      'insert-voice',
    ]);
  });

  it('withholds the actions their configuration does not support', async () => {
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        hasMenu: true,
        gifEnabled: false,
        richActions: true,
        voiceSupported: true,
        recording: true, // already recording — no second start
      },
    });

    container
      .querySelector<HTMLElement>('[data-testid=composer-insert]')
      ?.click();
    await fixture.whenStable();

    expect(trayItems().map((el) => el.getAttribute('data-testid'))).toEqual([
      'insert-attach',
      'insert-poll',
      'insert-location',
    ]);
  });

  it('lets an upload in flight block the actions that send immediately, and only those', async () => {
    // GIF and voice go straight out and would collide with the upload; attaching only stages,
    // and a poll or a location has nothing to do with it. The trigger deliberately does not
    // carry the union of the items' disabled states.
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        hasMenu: true,
        gifEnabled: true,
        richActions: true,
        voiceSupported: true,
        stickerEnabled: true,
        uploading: true,
      },
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-insert]',
    );
    expect(trigger?.disabled).toBe(false);
    trigger?.click();
    await fixture.whenStable();

    const disabled = Object.fromEntries(
      trayItems().map((el) => [el.getAttribute('data-testid'), el.disabled]),
    );
    expect(disabled).toEqual({
      'insert-attach': false,
      'insert-gif': true,
      'insert-sticker': false,
      'insert-poll': false,
      'insert-location': false,
      'insert-voice': true,
    });
  });

  it('disables the whole tray while editing — an edit cannot become an attachment', async () => {
    const { container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: true, editing: true },
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid=composer-insert]',
      )?.disabled,
    ).toBe(true);
  });

  it('shows a spinner on the trigger while a GIF or a location is resolving', async () => {
    const { container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: true, gifDownloading: true },
    });

    expect(container.querySelector('trn-spinner')).not.toBeNull();
  });

  it('emits the action each tray item stands for', async () => {
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        hasMenu: true,
        gifEnabled: true,
        richActions: true,
        voiceSupported: true,
        stickerEnabled: true,
      },
    });
    const fired: string[] = [];
    fixture.componentInstance.attachFile.subscribe(() => fired.push('attach'));
    fixture.componentInstance.pickGif.subscribe(() => fired.push('gif'));
    fixture.componentInstance.createPoll.subscribe(() => fired.push('poll'));
    fixture.componentInstance.pickSticker.subscribe(() =>
      fired.push('sticker'),
    );
    fixture.componentInstance.shareLocation.subscribe(() =>
      fired.push('location'),
    );
    fixture.componentInstance.recordVoice.subscribe(() => fired.push('voice'));

    // Choosing an item closes the tray, so each one needs its own open.
    for (const testid of [
      'insert-attach',
      'insert-gif',
      'insert-sticker',
      'insert-poll',
      'insert-location',
      'insert-voice',
    ]) {
      container
        .querySelector<HTMLElement>('[data-testid=composer-insert]')
        ?.click();
      await fixture.whenStable();
      trayItems()
        .find((el) => el.getAttribute('data-testid') === testid)
        ?.click();
      await fixture.whenStable();
    }

    expect(fired).toEqual([
      'attach',
      'gif',
      'sticker',
      'poll',
      'location',
      'voice',
    ]);
  });

  it('uses the complete ordered action sheet on the iOS/Android interaction model', async () => {
    platform.mobile = true;
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        contextKey: '!room:example.org',
        hasMenu: true,
        gifEnabled: true,
        richActions: true,
        voiceSupported: true,
        stickerEnabled: true,
        uploading: true,
      },
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-insert]',
    );
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    trigger?.click();
    await fixture.whenStable();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(
      sheetItems().map((item) => item.getAttribute('data-testid')),
    ).toEqual([
      'insert-attach',
      'insert-gif',
      'insert-sticker',
      'insert-poll',
      'insert-location',
      'insert-voice',
    ]);
    expect(
      Object.fromEntries(
        sheetItems().map((item) => [
          item.getAttribute('data-testid'),
          item.disabled,
        ]),
      ),
    ).toEqual({
      'insert-attach': false,
      'insert-gif': true,
      'insert-sticker': false,
      'insert-poll': false,
      'insert-location': false,
      'insert-voice': true,
    });
  });

  it('dismisses a stale mobile sheet when its room context changes', async () => {
    platform.mobile = true;
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: {
        contextKey: '!first:example.org',
        hasMenu: true,
        richActions: true,
      },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-insert]',
    );
    trigger?.click();
    await fixture.whenStable();
    expect(document.querySelector('trn-action-sheet')).not.toBeNull();

    fixture.componentRef.setInput('contextKey', '!second:example.org');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.querySelector('trn-action-sheet')).toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('restores the mobile trigger after dismissal but not after an action launches another surface', async () => {
    platform.mobile = true;
    const { fixture, container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: true, richActions: true },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid=composer-insert]',
    );

    trigger?.click();
    await fixture.whenStable();
    document.querySelector<HTMLButtonElement>('.cdk-overlay-backdrop')?.click();
    await fixture.whenStable();
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);

    const downstream = document.createElement('button');
    document.body.append(downstream);
    fixture.componentInstance.createPoll.subscribe(() => downstream.focus());
    trigger?.click();
    await fixture.whenStable();
    sheetItems()
      .find((item) => item.dataset['testid'] === 'insert-poll')
      ?.click();
    await fixture.whenStable();
    await Promise.resolve();

    expect(document.activeElement).toBe(downstream);
    downstream.remove();
  });

  it('names the trigger for screen readers', async () => {
    const { container } = await render(ComposerInsertMenuComponent, {
      inputs: { hasMenu: true },
    });

    expect(
      container
        .querySelector('[data-testid=composer-insert]')
        ?.getAttribute('aria-label'),
    ).toBe('Add to message');
  });

  afterEach(() => {
    platform.mobile = false;
    TestBed.resetTestingModule();
  });
});
