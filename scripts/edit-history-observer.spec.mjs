import { describe, expect, it } from 'vitest';

const original = {
  label: 'Original',
  text: 'first draft run',
  inserted: [],
  deleted: [],
  strongInserted: [],
  strongDeleted: [],
  outsideStrongInserted: [],
  outsideStrongDeleted: [],
  strongText: [],
  removeCount: 0,
};
const middle = {
  ...original,
  label: 'Edited',
  text: 'second draft run',
  removeCount: 1,
};
const current = {
  ...original,
  label: 'Current version',
  text: 'final wording run',
  inserted: ['final'],
  deleted: ['second'],
  removeCount: 1,
};
const history = {
  visible: true,
  rows: [original, middle, current],
  togglePressed: 'true',
  errorCount: 0,
  truncatedCount: 0,
};
const formatted = {
  ...current,
  text: 'deploy on FriMonday run',
  inserted: ['Mon'],
  deleted: ['Fri'],
  strongInserted: ['Mon'],
  strongDeleted: ['Fri'],
  outsideStrongInserted: [],
  outsideStrongDeleted: [],
  strongText: ['FriMonday'],
};
const pixel = {
  width: 393,
  height: 727,
  dpr: 2.75,
  rootPx: 16,
  inlineRootSize: '',
  dialogWidth: 393,
  dialogHeight: 727,
  closeVisible: true,
  closeWidth: 44,
  closeHeight: 44,
  dialogScrollWidth: 393,
  dialogClientWidth: 393,
  revisionsVisible: true,
  revisionsScrollWidth: 361,
  revisionsClientWidth: 361,
  toggleVisible: true,
  removeLeft: 305,
  removeTop: 610,
  removeRight: 385,
  removeBottom: 654,
  removeUnobstructed: true,
};
const nativeTarget = {
  visible: true,
  unobstructedCenter: true,
  disabled: false,
  rect: { width: 44, height: 44 },
};

describe('Android edit-history read-only observer predicates', () => {
  it('normalizes only trailing timeline whitespace and uses an exposed native marker point', async () => {
    const { matchesTimelineText, openHistoryMarker } =
      await import('../e2e/android/edit-history-journeys.mts');
    expect(
      matchesTimelineText(
        'final wording long content',
        'final wording long content ',
      ),
    ).toBe(true);
    expect(
      matchesTimelineText('final wording', 'final wording long content '),
    ).toBe(false);
    const actions = [];
    let marker = {
      visible: true,
      rect: { x: 367, y: 390, width: 44, height: 44, right: 411, bottom: 434 },
    };
    const client = {
      async waitElements() {
        return [marker];
      },
      async visible() {
        return { rect: { y: 216, bottom: 632 } };
      },
      async swipeCurrent(_selector, options) {
        actions.push(options.direction);
        marker = { ...marker, rect: { ...marker.rect, y: 390, bottom: 434 } };
        return {
          beforeScrollTop: 100,
          afterScrollTop: options.direction === 'decrease-scroll-top' ? 0 : 200,
        };
      },
      async tapCurrentExposed(selector, filter) {
        expect({ selector, filter }).toEqual({
          selector: target.selector,
          filter: target.filter,
        });
        actions.push('exposed-native-tap');
      },
      async eventIdentity(selector, filter, eventId) {
        expect({ selector, filter, eventId }).toEqual(target);
        return { matches: 1, exactEvent: exact };
      },
    };
    let exact = true;
    const target = {
      selector: '.msg[data-mid^="$"] [data-testid="msg-edited"]',
      filter: { within: { selector: '.msg', text: 'final wording' } },
      eventId: '$original',
    };
    await openHistoryMarker(client, target);
    expect(actions).toEqual(['exposed-native-tap']);
    marker = {
      ...marker,
      rect: { x: 367, y: 680, width: 44, height: 44, right: 411, bottom: 724 },
    };
    await openHistoryMarker(client, target);
    expect(actions).toEqual([
      'exposed-native-tap',
      'increase-scroll-top',
      'exposed-native-tap',
    ]);
    marker = {
      ...marker,
      rect: { x: 373, y: 46, width: 44, height: 44, right: 417, bottom: 90 },
    };
    await openHistoryMarker(client, target);
    expect(actions.slice(-2)).toEqual([
      'decrease-scroll-top',
      'exposed-native-tap',
    ]);
    marker = { ...marker, rect: { ...marker.rect, y: 46, bottom: 90 } };
    await expect(
      openHistoryMarker(
        {
          ...client,
          async swipeCurrent() {
            return { beforeScrollTop: 0, afterScrollTop: 0 };
          },
        },
        target,
      ),
    ).rejects.toThrow();
    // A marker a read-only observation cannot bind to the exact event is never tapped.
    marker = { ...marker, rect: { ...marker.rect, y: 390, bottom: 434 } };
    exact = false;
    const taps = actions.length;
    await expect(openHistoryMarker(client, target)).rejects.toThrow(
      'Edited marker belongs to the exact seeded event',
    );
    expect(actions).toHaveLength(taps);
  });

  it('requires the exact oldest-first labels and visible, complete plain diff', async () => {
    const { assertHistoryOrder, assertPlainDiff } =
      await import('../e2e/android/edit-history-observer.mts');
    expect(() =>
      assertHistoryOrder(history.rows.map((row) => row.label)),
    ).not.toThrow();
    expect(() => assertPlainDiff(history)).not.toThrow();
    expect(() =>
      assertHistoryOrder(['Original', 'Current version', 'Edited']),
    ).toThrow();
    expect(() =>
      assertPlainDiff({ ...history, rows: [current, middle, original] }),
    ).toThrow();
    expect(() =>
      assertPlainDiff({
        ...history,
        rows: [original, middle, { ...current, inserted: [] }],
      }),
    ).toThrow();
    expect(() =>
      assertPlainDiff({
        ...history,
        rows: [original, middle, { ...current, deleted: ['first'] }],
      }),
    ).toThrow();
    expect(() =>
      assertPlainDiff({
        ...history,
        rows: [{ ...original, inserted: ['first'] }, middle, current],
      }),
    ).toThrow();
    expect(() =>
      assertPlainDiff({ ...history, togglePressed: 'false' }),
    ).toThrow();
    expect(() => assertPlainDiff({ ...history, errorCount: 1 })).toThrow();
    expect(() => assertPlainDiff({ ...history, truncatedCount: 1 })).toThrow();
  });

  it('keeps formatted insertion and deletion inside the strong run', async () => {
    const { assertFormattedDiff } =
      await import('../e2e/android/edit-history-observer.mts');
    expect(() => assertFormattedDiff(formatted)).not.toThrow();
    expect(() =>
      assertFormattedDiff({
        ...formatted,
        strongInserted: [],
        outsideStrongInserted: ['Mon'],
      }),
    ).toThrow();
    expect(() =>
      assertFormattedDiff({
        ...formatted,
        strongDeleted: [],
        outsideStrongDeleted: ['Fri'],
      }),
    ).toThrow();
    expect(() =>
      assertFormattedDiff({ ...formatted, strongText: ['FriMon'] }),
    ).toThrow();
    const off = {
      ...formatted,
      text: 'deploy on Monday run',
      inserted: [],
      deleted: [],
      strongInserted: [],
      strongDeleted: [],
      strongText: ['Monday'],
    };
    expect(() => assertFormattedDiff(off, 'off')).not.toThrow();
    expect(() =>
      assertFormattedDiff({ ...off, text: 'deploy on Fri Monday run' }, 'off'),
    ).toThrow();
    expect(() =>
      assertFormattedDiff({ ...off, strongText: ['FriMonday'] }, 'off'),
    ).toThrow();
    expect(() =>
      assertFormattedDiff({ ...off, deleted: ['Fri'] }, 'off'),
    ).toThrow();
  });

  it('rejects clipped, covered, or horizontally overflowing Pixel 5 controls', async () => {
    const {
      assertPixelBaselineGeometry,
      assertPixelGeometry,
      assertScaledReading,
    } = await import('../e2e/android/edit-history-observer.mts');
    expect(() => assertPixelBaselineGeometry(pixel)).not.toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, dpr: 2.750000149011612 }),
    ).not.toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, dpr: 2.7501 }),
    ).toThrow();
    expect(() => assertPixelGeometry(pixel)).not.toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, width: 392 }),
    ).toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, height: 726 }),
    ).toThrow();
    expect(() => assertPixelBaselineGeometry({ ...pixel, dpr: 2 })).toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, inlineRootSize: '16px' }),
    ).toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, closeWidth: 43.9 }),
    ).toThrow();
    expect(() =>
      assertPixelBaselineGeometry({ ...pixel, dialogScrollWidth: 394 }),
    ).toThrow();
    expect(() =>
      assertPixelGeometry({ ...pixel, removeRight: 393.1 }),
    ).toThrow();
    expect(() =>
      assertPixelGeometry({ ...pixel, removeBottom: 727.1 }),
    ).toThrow();
    expect(() =>
      assertPixelGeometry({ ...pixel, removeUnobstructed: false }),
    ).toThrow();
    expect(() =>
      assertPixelGeometry({ ...pixel, revisionsScrollWidth: 362 }),
    ).toThrow();
    const large = { ...pixel, rootPx: 24 };
    expect(() => assertScaledReading(pixel, large)).not.toThrow();
    expect(() =>
      assertScaledReading(pixel, { ...large, rootPx: 16 }),
    ).toThrow();
    expect(() =>
      assertScaledReading(pixel, { ...large, inlineRootSize: '24px' }),
    ).toThrow();
    expect(() =>
      assertScaledReading(pixel, { ...large, width: 392 }),
    ).toThrow();
    expect(() =>
      assertScaledReading(pixel, { ...large, revisionsScrollWidth: 362 }),
    ).toThrow();
  });

  it('reaches trailing Remove only through advancing native swipes', async () => {
    const { reachPixelRemove } =
      await import('../e2e/android/edit-history-journeys.mts');
    const covered = { ...pixel, removeUnobstructed: false };
    const swipes = [];
    const client = {
      async swipeCurrent(selector, options) {
        swipes.push({ selector, options });
        return { beforeScrollTop: 0, afterScrollTop: 100 };
      },
    };
    expect(await reachPixelRemove(client, covered, async () => pixel)).toEqual(
      pixel,
    );
    expect(swipes).toEqual([
      {
        selector: '.revisions',
        options: { direction: 'increase-scroll-top' },
      },
    ]);
    await expect(
      reachPixelRemove(
        {
          async swipeCurrent() {
            return { beforeScrollTop: 0, afterScrollTop: 0 };
          },
        },
        covered,
        async () => pixel,
      ),
    ).rejects.toThrow();
    await expect(
      reachPixelRemove(client, covered, async () => covered),
    ).rejects.toThrow();
    const clipped = { ...pixel, removeRight: 393.1 };
    await expect(
      reachPixelRemove(client, clipped, async () => clipped),
    ).rejects.toThrow();
  });

  it('requires one real, enabled, exposed native target', async () => {
    const { assertNativeTarget } =
      await import('../e2e/android/edit-history-observer.mts');
    expect(assertNativeTarget([nativeTarget])).toBe(nativeTarget);
    expect(() => assertNativeTarget([])).toThrow();
    expect(() => assertNativeTarget([nativeTarget, nativeTarget])).toThrow();
    expect(() =>
      assertNativeTarget([{ ...nativeTarget, unobstructedCenter: false }]),
    ).toThrow();
    expect(() =>
      assertNativeTarget([{ ...nativeTarget, rect: { width: 0, height: 44 } }]),
    ).toThrow();
  });

  it('fails closed when native readings omit geometry or a required history row', async () => {
    const { readEditHistory, readFontProfile, readPixelGeometry } =
      await import('../e2e/android/edit-history-observer.mts');
    const client = (value) => ({
      webview: {
        diagnostics: {
          async send() {
            return { result: { value } };
          },
        },
      },
    });
    await expect(
      readEditHistory(client({ ...history, rows: null })),
    ).rejects.toThrow();
    await expect(
      readFontProfile(client({ ...pixel, rootPx: null })),
    ).rejects.toThrow();
    await expect(
      readPixelGeometry(client({ ...pixel, removeRight: null })),
    ).rejects.toThrow();
  });
});
