import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { withSpaceSettingsVisualFixture } from '../e2e/android/space-settings-visual-fixture.mts';

function documentRoot({ fontSize, dark, theme }) {
  const attributes = new Map(theme === null ? [] : [['data-theme', theme]]);
  const classes = new Set(dark ? ['dark'] : []);
  const root = {
    style: { fontSize },
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
  };
  return { document: { documentElement: root }, root };
}

function client(document) {
  return {
    webview: {
      diagnostics: {
        async send(_method, { expression }) {
          return {
            result: { value: runInNewContext(expression, { document }) },
          };
        },
      },
    },
  };
}

function rootState(root) {
  return {
    fontSize: root.style.fontSize,
    dark: root.classList.contains('dark'),
    theme: root.getAttribute('data-theme'),
  };
}

describe('Space Settings visual fixture', () => {
  it('removes an existing data-theme for a null fixture and restores it', async () => {
    const fixture = documentRoot({
      fontSize: '100%',
      dark: true,
      theme: 'onyx',
    });

    await withSpaceSettingsVisualFixture(
      client(fixture.document),
      { theme: null },
      async () => {
        expect(fixture.root.getAttribute('data-theme')).toBeNull();
      },
    );

    expect(rootState(fixture.root)).toEqual({
      fontSize: '100%',
      dark: true,
      theme: 'onyx',
    });
  });

  it('restores root fixture values when a null-theme operation throws', async () => {
    const fixture = documentRoot({
      fontSize: '100%',
      dark: false,
      theme: 'onyx',
    });
    const failure = new Error('capture failed');

    await expect(
      withSpaceSettingsVisualFixture(
        client(fixture.document),
        { fontSize: '125%', dark: true, theme: null },
        async () => {
          expect(rootState(fixture.root)).toEqual({
            fontSize: '125%',
            dark: true,
            theme: null,
          });
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(rootState(fixture.root)).toEqual({
      fontSize: '100%',
      dark: false,
      theme: 'onyx',
    });
  });
});
