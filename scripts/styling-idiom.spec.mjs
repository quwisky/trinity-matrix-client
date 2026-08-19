import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Trinity styles components two ways, and the redesign wants one.
 *
 * Sixty components own a `.scss` file; forty-six templates reach for Tailwind utilities. Both
 * are legitimate today, and the redesign's direction is to shrink the first set as components
 * move onto tokens and utilities — but a spec asserting that end state would fail sixty times
 * on the day it landed and be deleted the first time it cried wolf.
 *
 * So this is a **frozen ledger**: the set of stylesheet-owning components is recorded, and the
 * assertion is that it does not GROW. Migrating one means deleting its entry, which is a
 * one-line diff in the right direction. Adding a sixty-first stylesheet means adding an entry,
 * which is a conversation.
 *
 * It lives in `scripts` for the same reason `confirmation-words.spec.mjs` does: the files span
 * libraries that the Nx module boundaries stop any single project from importing.
 */

const workspaceRoot = join(import.meta.dirname, '..');

/** Shared partials are not component stylesheets; they are the mixins those files `@use`. */
const SHARED_PARTIALS = [
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
 * a sixty-first stylesheet is a visible line in a shared file rather than an invisible default.
 */
const LEDGER = [
  'libs/components/banner/src/lib/banner.component.scss',
  'libs/components/emoji-picker/src/lib/trn-emoji-picker/trn-emoji-picker.component.scss',
  'libs/components/media-bubble/src/lib/media-bubble.component.scss',
  'libs/components/message-toolbar/src/lib/message-toolbar.component.scss',
  'libs/feature/auth/src/lib/login/login.page.scss',
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
  'libs/feature/rooms/src/lib/member-info/member-info.component.scss',
  'libs/feature/rooms/src/lib/member-list/member-list.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-attachment-strip/composer-attachment-strip.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-insert-menu/composer-insert-menu.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-suggestions/composer-suggestions.component.scss',
  'libs/feature/rooms/src/lib/message-composer/composer-toolbar/composer-toolbar.component.scss',
  'libs/feature/rooms/src/lib/message-composer/message-composer.component.scss',
  'libs/feature/rooms/src/lib/message-list/drop-overlay/drop-overlay.component.scss',
  'libs/feature/rooms/src/lib/message-list/simple-message-list/simple-message-list.component.scss',
  'libs/feature/rooms/src/lib/message-list/virtual-message-list/virtual-message-list.component.scss',
  'libs/feature/rooms/src/lib/message-reactions/message-reactions.component.scss',
  'libs/feature/rooms/src/lib/message-row/message-row.component.scss',
  'libs/feature/rooms/src/lib/message-search/message-search.component.scss',
  'libs/feature/rooms/src/lib/pinned/pinned-messages-panel.component.scss',
  'libs/feature/rooms/src/lib/poll/poll.component.scss',
  'libs/feature/rooms/src/lib/quick-switcher/quick-switcher.component.scss',
  'libs/feature/rooms/src/lib/reaction-picker/reaction-picker.component.scss',
  'libs/feature/rooms/src/lib/reactions-dialog/reactions-dialog.component.scss',
  'libs/feature/rooms/src/lib/room-settings/room-settings.component.scss',
  'libs/feature/rooms/src/lib/rooms/rooms.page.scss',
  'libs/feature/rooms/src/lib/server-rail/server-rail.component.scss',
  'libs/feature/rooms/src/lib/shared/avatar-field/avatar-field.component.scss',
  'libs/feature/rooms/src/lib/space-members/space-members.component.scss',
  'libs/feature/rooms/src/lib/space-settings/space-settings.component.scss',
  'libs/feature/rooms/src/lib/thread/thread-view.component.scss',
  'libs/feature/rooms/src/lib/thread/threads-list.component.scss',
  'libs/feature/rooms/src/lib/user-card/user-card.component.scss',
  'libs/feature/rooms/src/lib/user-picker/user-picker.component.scss',
  'libs/feature/rooms/src/lib/voice-message/voice-message.component.scss',
  'libs/feature/settings/src/lib/advanced/advanced-settings.component.scss',
  'libs/feature/settings/src/lib/advanced/config-editor/config-editor.component.scss',
  'libs/feature/settings/src/lib/devices/devices-section.component.scss',
  'libs/feature/settings/src/lib/gifs/gifs-section.component.scss',
  'libs/feature/settings/src/lib/server/homeserver-block.component.scss',
  'libs/feature/settings/src/lib/settings/settings.page.scss',
  'libs/feature/settings/src/lib/shortcuts/shortcuts-section.component.scss',
];

describe('styling idiom', () => {
  it('reads the tree at all, so an empty sweep cannot pass as a clean one', () => {
    expect(stylesheets.length).toBeGreaterThan(50);
  });

  it('has a ledger that still describes the tree', () => {
    // Equality both ways. A stylesheet that is deleted must leave the ledger too, or the
    // ledger stops being a description and becomes a wish.
    expect(componentStylesheets).toEqual(LEDGER);
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
});
