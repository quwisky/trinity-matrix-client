import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripMarkupComments } from './source-style-blocks.mjs';

/**
 * Each site here once re-implemented a public recipe in feature SCSS (#930 K5/E1). Every
 * assertion names one site, so a regression points at the file that drifted. No totals:
 * a new site is added as its own assertion, never by bumping a count.
 */
const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

/** The one opening tag carrying `marker` (a testid, class or attribute), comments stripped. */
function openingTag(file, marker) {
  const html = stripMarkupComments(read(file));
  const found = (html.match(/<[a-z][\w-]*\b[^>]*>/giu) ?? []).filter((tag) =>
    tag.includes(marker),
  );
  expect(found, `${file}: ${marker}`).toHaveLength(1);
  return found[0];
}

/**
 * Declarations of the leaf rule whose selector list contains `selector`, or null when no
 * such rule exists. `toMatch` on null throws, so a check on a removed rule fails loudly
 * instead of passing on an empty string.
 */
function styleRule(file, selector) {
  const scss = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
  for (const match of scss.matchAll(/([^{};]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1].split(',').map((part) => part.trim());
    if (selectors.includes(selector)) return match[2];
  }
  return null;
}

const surface = /\b(?:background|border|border-radius|box-shadow|padding)\s*:/u;

describe('card recipe adoption', () => {
  const packs =
    'libs/feature/settings/src/lib/image-packs/image-packs-section.component';

  it('renders installed and available image packs as muted cards', () => {
    for (const testid of ['installed-image-pack', 'available-image-pack']) {
      const tag = openingTag(`${packs}.html`, `data-testid="${testid}"`);
      expect(tag).toMatch(/\btrnCard\b/u);
      expect(tag).toMatch(/\bvariant="muted"/u);
      expect(tag).toMatch(/\bclass="pack-card"/u);
    }
    // The recipe owns the card surface, so no rule for the bare card remains.
    expect(styleRule(`${packs}.scss`, '.pack-card')).toBeNull();
  });

  it('gives the encryption pages the card recipe instead of a surface mixin', () => {
    expect(read('libs/feature/crypto/src/lib/styles/_mixins.scss')).not.toMatch(
      /@mixin surface\b/u,
    );
    for (const page of [
      'encryption-setup/encryption-setup.page',
      'encryption-unlock/encryption-unlock.page',
      'verification/device-verification.page',
    ]) {
      const file = `libs/feature/crypto/src/lib/${page}`;
      const tag = openingTag(`${file}.html`, 'class="crypto-surface"');
      expect(tag).toMatch(/\btrnCard\b/u);
      expect(tag).toMatch(/\bvariant="muted"/u);
      expect(tag).toMatch(/\bsize="md"/u);
      expect(read(`${file}.scss`)).not.toMatch(/@include surface\b/u);
      const rule = styleRule(`${file}.scss`, '.crypto-surface');
      expect(rule, `${file}: width cap`).toMatch(
        /\bwidth:\s*min\(100%,\s*640px\)/u,
      );
      expect(rule, `${file}: centred`).toMatch(/\bmargin-inline:\s*auto/u);
    }
  });

  it('draws a poll as a muted card', () => {
    const file = 'libs/feature/rooms/src/lib/poll/poll.component';
    const tag = openingTag(`${file}.html`, 'data-testid="poll"');
    expect(tag).toMatch(/\btrnCard\b/u);
    expect(tag).toMatch(/\bvariant="muted"/u);
    expect(styleRule(`${file}.scss`, '.poll')).not.toMatch(surface);
  });
});

describe('banner recipe adoption', () => {
  it('shows the message-search notes as neutral banners', () => {
    const file =
      'libs/feature/rooms/src/lib/message-search/message-search.component';
    const note = openingTag(`${file}.html`, 'data-testid="e2ee-note"');
    expect(note).toMatch(/^<trn-banner\b/u);
    expect(note).toMatch(/\bvariant="neutral"/u);
  });

  it('shows the third-party widget notice as a neutral banner', () => {
    const file =
      'libs/feature/rooms/src/lib/room-settings/room-widget-frame/room-widget-frame.component';
    const notice = openingTag(`${file}.html`, 'widget-frame__notice');
    expect(notice).toMatch(/^<trn-banner\b/u);
    expect(notice).toMatch(/\bvariant="neutral"/u);
    expect(styleRule(`${file}.scss`, '.widget-frame__notice')).not.toMatch(
      /\bborder-bottom\s*:/u,
    );
  });
});

describe('empty-state recipe adoption: pickers and dialog states', () => {
  const rooms = 'libs/feature/rooms/src/lib';

  it('retires the picker-status mixin', () => {
    expect(read(`${rooms}/styles/_mixins.scss`)).not.toMatch(
      /@mixin picker-status\b/u,
    );
    for (const file of [
      'gif-picker/gif-picker.component.scss',
      'sticker-picker/sticker-picker.component.scss',
      'user-picker/user-picker.component.scss',
    ]) {
      expect(read(`${rooms}/${file}`), file).not.toMatch(
        /@include picker-status\b/u,
      );
    }
  });

  it('shows picker loading and no-result states as line empty states', () => {
    for (const [file, text] of [
      ['gif-picker/gif-picker.component.html', 'No GIFs found.'],
      ['gif-picker/gif-picker.component.html', 'Loading…'],
      ['sticker-picker/sticker-picker.component.html', 'No stickers found.'],
    ]) {
      const tag = openingTag(`${rooms}/${file}`, `body="${text}"`);
      expect(tag, file).toMatch(/^<trn-empty-state\b/u);
      expect(tag, file).toMatch(/\blayout="line"/u);
    }
    const userPicker = read(`${rooms}/user-picker/user-picker.component.html`);
    expect(userPicker).not.toMatch(/class="picker-status"/u);
    expect(userPicker).toMatch(
      /<trn-empty-state\b[^>]*layout="line"[^>]*>\s*<trn-spinner\b/u,
    );
  });

  it('gives edit history and the room preview panel states', () => {
    const history = `${rooms}/edit-history/edit-history.component`;
    expect(read(`${history}.html`)).not.toMatch(/class="center"/u);
    const historyError = openingTag(
      `${history}.html`,
      'data-testid="edit-history-error"',
    );
    expect(historyError).toMatch(/^<trn-empty-state\b/u);
    expect(historyError).toMatch(/\bvariant="danger"/u);

    const preview = `${rooms}/room-link-preview/room-link-preview.component`;
    const loadError = openingTag(
      `${preview}.html`,
      'data-testid="room-link-load-error"',
    );
    expect(loadError).toMatch(/^<trn-empty-state\b/u);
    expect(loadError).toMatch(/\bvariant="danger"/u);
    expect(styleRule(`${preview}.scss`, '.room-preview__status')).not.toMatch(
      /\b(?:color|text-align|gap)\s*:/u,
    );
  });
});

describe('empty-state recipe adoption: lists', () => {
  const lineSites = [
    [
      'libs/feature/rooms/src/lib/room-directory/room-directory.component.html',
      'data-testid="directory-empty"',
    ],
    [
      'libs/feature/rooms/src/lib/room-directory/room-directory.component.html',
      'data-testid="directory-loading"',
    ],
    [
      'libs/feature/rooms/src/lib/room-settings/room-widgets.component.html',
      'data-testid="room-settings-widgets-empty"',
    ],
    [
      'libs/feature/rooms/src/lib/banned-members/banned-members.component.html',
      'data-testid="banned-members-empty"',
    ],
    [
      'libs/feature/rooms/src/lib/room-state-viewer/room-state-viewer.component.html',
      'data-testid="state-viewer-empty"',
    ],
    [
      'libs/feature/settings/src/lib/image-packs/image-packs-section.component.html',
      'data-testid="no-installed-image-packs"',
    ],
    [
      'libs/feature/settings/src/lib/notifications/keyword-rules-block.component.html',
      'data-testid="keyword-empty"',
    ],
    [
      'libs/feature/settings/src/lib/notifications/keyword-rules-block.component.html',
      'data-testid="keyword-loading"',
    ],
    [
      'libs/feature/settings/src/lib/shared/settings-directory-search/settings-directory-search.component.html',
      'body="No sections found."',
    ],
  ];

  it.each(lineSites)('%s shows %s as a line empty state', (file, marker) => {
    const tag = openingTag(file, marker);
    expect(tag).toMatch(/^<trn-empty-state\b/u);
    expect(tag).toMatch(/\blayout="line"/u);
  });

  it('gives System Status its all-clear as a titled panel', () => {
    const tag = openingTag(
      'libs/application/runtime/src/lib/application-root/system-status/system-status.component.html',
      'data-testid="system-status-all-working"',
    );
    expect(tag).toMatch(/^<trn-empty-state\b/u);
    expect(tag).toMatch(/\btitleAs="h2"/u);
  });

  it('marks the pinned and threads panels with an icon', () => {
    expect(
      openingTag(
        'libs/feature/rooms/src/lib/pinned/pinned-messages-panel.component.html',
        'data-testid="pinned-empty"',
      ),
    ).toMatch(/\bicon="pin"/u);
    expect(
      openingTag(
        'libs/feature/rooms/src/lib/thread/threads-list.component.html',
        'body="No threads in this room yet."',
      ),
    ).toMatch(/\bicon="messages-square"/u);
  });
});
