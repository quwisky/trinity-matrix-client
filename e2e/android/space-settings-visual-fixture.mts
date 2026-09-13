import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative } from './native-shell-client.mts';

export interface SpaceSettingsVisualFixtureOptions {
  readonly fontSize?: string;
  readonly dark?: boolean;
  readonly theme?: string;
}

interface DocumentRootFixtureState {
  readonly fontSize: string;
  readonly dark: boolean;
  readonly theme: string | null;
}

/** Apply a document-root-only capture fixture and restore it after the capture. */
export async function withSpaceSettingsVisualFixture(
  client: AccountWorkspaceClient,
  options: SpaceSettingsVisualFixtureOptions,
  operation: () => Promise<void>,
): Promise<void> {
  const original = (await evaluateNative(
    client.webview,
    `(() => ({
      fontSize: document.documentElement.style.fontSize,
      dark: document.documentElement.classList.contains('dark'),
      theme: document.documentElement.getAttribute('data-theme'),
    }))()`,
  )) as DocumentRootFixtureState;
  const fixture = JSON.stringify(options);

  await evaluateNative(
    client.webview,
    `(() => {
      const fixture = ${fixture};
      const root = document.documentElement;
      if (fixture.fontSize !== undefined) root.style.fontSize = fixture.fontSize;
      if (fixture.dark !== undefined) root.classList.toggle('dark', fixture.dark);
      if (fixture.theme !== undefined) root.setAttribute('data-theme', fixture.theme);
      return true;
    })()`,
  );

  try {
    await operation();
  } finally {
    await evaluateNative(
      client.webview,
      `(() => {
        const original = ${JSON.stringify(original)};
        const fixture = ${fixture};
        const root = document.documentElement;
        if (fixture.fontSize !== undefined) root.style.fontSize = original.fontSize;
        if (fixture.dark !== undefined) root.classList.toggle('dark', original.dark);
        if (fixture.theme !== undefined) {
          if (original.theme === null) root.removeAttribute('data-theme');
          else root.setAttribute('data-theme', original.theme);
        }
        return true;
      })()`,
    );
  }
}
