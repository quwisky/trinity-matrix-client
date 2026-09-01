import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineStyleSheets } from './inline-styles.mjs';

/**
 * Trinity styles components two ways, and the redesign wants one.
 *
 * Dozens of components own a `.scss` file and templates also reach for Tailwind utilities. Both
 * are legitimate today, and the redesign's direction is to shrink the first set as components
 * move onto tokens and utilities — but a spec asserting that end state would fail sixty times
 * on the day it landed and be deleted the first time it cried wolf.
 *
 * So this is a **frozen ledger**: the set of stylesheet-owning components is recorded, and the
 * assertion is that it does not GROW. `cascade-layer-contract.spec.mjs` reads the same ledger
 * and classifies every source that has not adopted `@layer` as a temporary exception. Migrating
 * one leaves its ownership entry here but removes it from that derived exception set. Adding a
 * stylesheet still means adding an explicit ledger entry, which is a conversation.
 *
 * It lives in `scripts` for the same reason `confirmation-words.spec.mjs` does: the files span
 * libraries that the Nx module boundaries stop any single project from importing.
 *
 * There is a THIRD idiom, and it was counted by nothing: an inline `styles: [...]` array on
 * the component. Ten wrapper components use it, so it is ledgered here on the same terms —
 * the set may shrink, and growing it is a visible line in a shared file rather than an
 * invisible default. Without this, a rule could be added anywhere in `libs/components`
 * without any styling guard in the tree reading it.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Shared partials are not component stylesheets; they are the mixins those files `@use`. */
const SHARED_PARTIALS = [
  'libs/feature/auth/src/lib/styles/_auth-form.scss',
  'libs/feature/crypto/src/lib/styles/_mixins.scss',
  'libs/feature/rooms/src/lib/message-list/_message-list-shared.scss',
  'libs/feature/rooms/src/lib/styles/_mixins.scss',
];

const stylesheets = globSync(['libs/**/*.scss', 'apps/**/*.scss'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.includes('node_modules'))
  .sort();

/** A component stylesheet: one a component names with `styleUrl`. */
const componentStylesheets = stylesheets.filter(
  (file) => file.endsWith('.component.scss') || file.endsWith('.page.scss'),
);

/**
 * The ledger. Every entry is a component that owns a stylesheet TODAY.
 *
 * Written out rather than derived, because deriving it from the same glob it is checked
 * against compares a value to itself and can never fail — which is what this list replaced.
 *
 * It may shrink: migrating a component to tokens and utilities deletes a line, which is the
 * diff this phase wants to see. It may not grow without a deliberate edit here, so the cost of
 * a sixty-second stylesheet is a visible line in a shared file rather than an invisible default.
 */
const COMPONENT_STYLESHEET_LEDGER = [
  'libs/application/runtime/src/lib/application-root/application-root.component.scss',
  'libs/components/controls/src/lib/emoji-picker/trn-emoji-picker/trn-emoji-picker.component.scss',
  'libs/components/controls/src/lib/field/field-label/trn-field-label.component.scss',
  'libs/components/controls/src/lib/field/field/trn-field.component.scss',
  'libs/components/controls/src/lib/qr-scanner/qr-scanner/qr-scanner.component.scss',
  'libs/components/foundations/src/lib/icon/trn-icon/trn-icon.component.scss',
  'libs/components/generic-content/src/lib/banner/banner.component.scss',
  'libs/feature/auth/src/lib/auth-card/auth-card.component.scss',
  'libs/feature/auth/src/lib/login/login.page.scss',
  'libs/feature/auth/src/lib/registration/registration.page.scss',
  'libs/feature/crypto/src/lib/encryption-setup/encryption-setup.page.scss',
  'libs/feature/crypto/src/lib/encryption-unlock/encryption-unlock.page.scss',
  'libs/feature/crypto/src/lib/recovery-key-display/recovery-key-display.component.scss',
  'libs/feature/crypto/src/lib/recovery-key-save/recovery-key-save.component.scss',
  'libs/feature/crypto/src/lib/verification/device-verification.page.scss',
  'libs/feature/crypto/src/lib/verification/sas-compare.component.scss',
  'libs/feature/rooms/src/lib/account-picker/account-picker.component.scss',
  'libs/feature/rooms/src/lib/add-to-space/add-to-space.component.scss',
  'libs/feature/rooms/src/lib/channel-sidebar/channel-sidebar.component.scss',
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-room-list/sidebar-room-list.component.scss',
  'libs/feature/rooms/src/lib/channel-sidebar/sidebar-user-panel/sidebar-user-panel.component.scss',
  'libs/feature/rooms/src/lib/edit-history/edit-history.component.scss',
  'libs/feature/rooms/src/lib/encryption-banner/encryption-banner.component.scss',
  'libs/feature/rooms/src/lib/gif-picker/gif-picker.component.scss',
  'libs/feature/rooms/src/lib/gif-picker/gif-thumb.component.scss',
  'libs/feature/rooms/src/lib/jump-to-date/jump-to-date.component.scss',
  'libs/feature/rooms/src/lib/link-preview/link-preview.component.scss',
  'libs/feature/rooms/src/lib/location-share/location.component.scss',
  'libs/feature/rooms/src/lib/manage-space-rooms/manage-space-rooms.component.scss',
  'libs/feature/rooms/src/lib/media-attachment/lightbox/lightbox.component.scss',
  'libs/feature/rooms/src/lib/media-bubble/media-bubble.component.scss',
  'libs/feature/rooms/src/lib/member-info/member-info.component.scss',
  'libs/feature/rooms/src/lib/member-list/member-list.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-attachment-strip/composer-attachment-strip.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-suggestions/composer-suggestions.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-toolbar/composer-toolbar.component.scss',
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.scss',
  'libs/feature/rooms/src/lib/message-list/drop-overlay/drop-overlay.component.scss',
  'libs/feature/rooms/src/lib/message-list/simple-message-list/simple-message-list.component.scss',
  'libs/feature/rooms/src/lib/message-list/timeline-divider/timeline-divider.component.scss',
  'libs/feature/rooms/src/lib/message-list/typing-indicator/typing-indicator.component.scss',
  'libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.scss',
  'libs/feature/rooms/src/lib/message-reactions/message-reactions.component.scss',
  'libs/feature/rooms/src/lib/message-reply-preview/message-reply-preview.component.scss',
  'libs/feature/rooms/src/lib/message-row/message-row.component.scss',
  'libs/feature/rooms/src/lib/message-search/message-search.component.scss',
  'libs/feature/rooms/src/lib/message-thread-summary/message-thread-summary.component.scss',
  'libs/feature/rooms/src/lib/message-toolbar/message-toolbar.component.scss',
  'libs/feature/rooms/src/lib/pinned/pinned-messages-panel.component.scss',
  'libs/feature/rooms/src/lib/poll/poll.component.scss',
  'libs/feature/rooms/src/lib/quick-switcher/quick-switcher.component.scss',
  'libs/feature/rooms/src/lib/reaction-picker/reaction-picker.component.scss',
  'libs/feature/rooms/src/lib/reactions-dialog/reactions-dialog.component.scss',
  'libs/feature/rooms/src/lib/room-link-preview/room-link-preview.component.scss',
  'libs/feature/rooms/src/lib/room-settings/room-settings.component.scss',
  'libs/feature/rooms/src/lib/room-settings/room-widget-create/room-widget-create.component.scss',
  'libs/feature/rooms/src/lib/room-settings/room-widget-frame/room-widget-frame.component.scss',
  'libs/feature/rooms/src/lib/room-settings/room-widgets.component.scss',
  'libs/feature/rooms/src/lib/rooms/rooms.page.scss',
  'libs/feature/rooms/src/lib/server-rail/server-rail.component.scss',
  'libs/feature/rooms/src/lib/shared/avatar-field/avatar-field.component.scss',
  'libs/feature/rooms/src/lib/space-members/space-members.component.scss',
  'libs/feature/rooms/src/lib/space-settings/space-settings.component.scss',
  'libs/feature/rooms/src/lib/sticker-image/sticker-image.component.scss',
  'libs/feature/rooms/src/lib/sticker-picker/sticker-picker.component.scss',
  'libs/feature/rooms/src/lib/thread/thread-view.component.scss',
  'libs/feature/rooms/src/lib/thread/threads-list.component.scss',
  'libs/feature/rooms/src/lib/user-card/user-card.component.scss',
  'libs/feature/rooms/src/lib/user-picker/user-picker.component.scss',
  'libs/feature/rooms/src/lib/voice-message/voice-message.component.scss',
  'libs/feature/settings/src/lib/advanced/config-editor/config-editor.component.scss',
  'libs/feature/settings/src/lib/appearance/appearance-preference-field/appearance-preference-field.component.scss',
  'libs/feature/settings/src/lib/appearance/appearance-preview.component.scss',
  'libs/feature/settings/src/lib/image-packs/image-packs-section.component.scss',
  'libs/feature/settings/src/lib/server/homeserver-block.component.scss',
  'libs/feature/settings/src/lib/settings-dialog/settings-dialog.component.scss',
  'libs/feature/settings/src/lib/settings/settings.page.scss',
];

/**
 * The ledger's counterpart for the inline idiom: components declaring `styles: [...]`.
 *
 * Every entry is in `libs/components` by construction — the wrapper tier ships one-rule
 * escapes from a kit default, which is the case inline styles are actually good for. A
 * feature component appearing here would be the thing worth a conversation.
 */
const INLINE_STYLE_LEDGER = [
  'libs/components/controls/src/lib/checkbox/trn-checkbox.component.ts',
  'libs/components/controls/src/lib/radio-group/trn-radio-group.component.ts',
  'libs/components/controls/src/lib/select/trn-select.component.ts',
  'libs/components/controls/src/lib/switch/trn-switch.component.ts',
  'libs/components/foundations/src/lib/icon/trn-icon/trn-icon.component.ts',
  'libs/components/generic-content/src/lib/avatar/avatar.component.ts',
  'libs/components/generic-content/src/lib/progress/trn-progress.component.ts',
  'libs/components/generic-content/src/lib/spinner/trn-spinner.component.ts',
  'libs/components/navigation-layout/src/lib/tabs/trn-tab-panel.component.ts',
  'libs/components/overlay/src/lib/action-sheet/trn-action-sheet.component.ts',
];

const inlineStyled = inlineStyleSheets();

describe('styling idiom', () => {
  it('reads the tree at all, so an empty sweep cannot pass as a clean one', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
  });

  it('has a ledger that still describes the tree', () => {
    // Equality both ways. A stylesheet that is deleted must leave the ledger too, or the
    // ledger stops being a description and becomes a wish.
    expect(componentStylesheets).toEqual(COMPONENT_STYLESHEET_LEDGER);
  });

  it('accounts for every shared partial by name', () => {
    // Partials are the exception to "a stylesheet belongs to a component", so they are named
    // rather than pattern-matched — a fourth one appearing should be a decision.
    const partials = stylesheets.filter((file) =>
      file.split('/').at(-1)?.startsWith('_'),
    );

    expect(partials).toEqual(SHARED_PARTIALS);
  });

  it('keeps every stylesheet attached to a component that names it', () => {
    // An orphan is dead weight that still costs a build step, and nothing else would notice:
    // deleting a component's `styleUrl` leaves its .scss sitting there, silently unused.
    //
    // Matched against the values components actually DECLARE rather than a substring of the
    // whole source, so a stylesheet mentioned only in a comment does not count as used. Both
    // spellings are in the tree — `styleUrl: './x.scss'` and `styleUrls: ['x.scss']` — so the
    // leading `./` is optional; requiring it invented seven orphans that were fine.
    const declared = new Set();
    for (const file of globSync(['libs/**/*.ts', 'apps/**/*.ts'], {
      cwd: workspaceRoot,
    }).filter((f) => !f.includes('node_modules'))) {
      const source = readFileSync(join(workspaceRoot, file), 'utf8');
      for (const [, value] of source.matchAll(
        /styleUrls?\s*:\s*\[?\s*'([^']+\.scss)'/g,
      )) {
        declared.add(value.replace(/^\.\//, ''));
      }
    }

    const orphans = componentStylesheets.filter(
      (file) => !declared.has(file.split('/').at(-1) ?? ''),
    );

    expect(orphans).toEqual([]);
  });

  it('has a ledger for the inline idiom too, and it still describes the tree', () => {
    expect(inlineStyled.map(({ file }) => file)).toEqual(INLINE_STYLE_LEDGER);
  });

  it('actually extracts the CSS, so an empty parse cannot pass as an empty idiom', () => {
    // The failure this catches is the quiet one: a parser that stops matching reports every
    // component as having no inline CSS, and both this ledger and `shorthand-overrides`
    // then sweep nothing while staying green.
    const css = inlineStyled.map(({ css }) => css).join('\n');
    expect(css).toContain('safe-area-inset-bottom');
    expect(css.match(/\{/g)?.length ?? 0).toBeGreaterThan(10);

    // OVER-capture is the failure the checks above cannot see, and the one the tree was
    // actually in: an apostrophe in a `//` comment opened a string that never closed, the
    // array's `]` was swallowed, and the scan returned 412 characters of class names and
    // markup as "CSS". Balanced braces do NOT catch it — the soup was 1-open/1-close — so
    // what is asserted is that nothing outside a declaration block looks like anything but
    // a selector.
    for (const { file, css: block } of inlineStyled) {
      // Template markup is never valid at CSS top level; the soup carried `<ng-icon>`.
      expect(`${file}: ${/<[a-zA-Z]/.test(block)}`).toBe(`${file}: false`);

      // Every line outside braces must be a selector — it may not be a bare utility token.
      const outside = block.replace(/\{[^{}]*\}/g, '');
      const stray = outside
        .split('\n')
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !/[{},]$/.test(line) &&
            !/^[.#:[&@*]/.test(line) &&
            !/^[a-z-]+\s*[.#:[]/.test(line),
        );
      expect(`${file}: ${stray.slice(0, 3).join(' | ')}`).toBe(`${file}: `);
    }
  });
});
