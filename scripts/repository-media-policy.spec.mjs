import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const trackedFiles = execFileSync('git', ['ls-files'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((file) => file && existsSync(join(workspaceRoot, file)));

const PRODUCT_MEDIA_ROOTS = [
  'android/app/src/main/res/',
  'apps/trinity/src/assets/',
  'electron/build/',
  'ios/App/App/Assets.xcassets/',
];
const RASTER_MEDIA = /\.(?:gif|jpe?g|png|webp)$/i;
const DESIGN_ARTIFACT_PATH =
  /(^|[\/._-])(?:mockups?|prototypes?)(?=$|[\/._-])/i;
const REVIEW_MEDIA_MARKER =
  /(^|[\/._-])(?:baselines?|evidence|proof|screenshots?)(?=$|[\/._-])/i;
const MANAGED_PROTOTYPE_SKILL_FILES = new Set([
  '.agents/skills/prototype/LOGIC.md',
  '.agents/skills/prototype/SKILL.md',
  '.agents/skills/prototype/UI.md',
  '.agents/skills/prototype/agents/openai.yaml',
]);

const isReviewArtifactPath = (file) =>
  !MANAGED_PROTOTYPE_SKILL_FILES.has(file) &&
  (DESIGN_ARTIFACT_PATH.test(file) ||
    file.startsWith('docs/evidence/') ||
    (file.includes('-snapshots/') && RASTER_MEDIA.test(file)) ||
    (RASTER_MEDIA.test(file) && REVIEW_MEDIA_MARKER.test(file)));

describe('repository review-media policy', () => {
  it('keeps prototypes and review evidence out of tracked source', () => {
    const forbidden = trackedFiles.filter((file) => isReviewArtifactPath(file));

    expect(forbidden).toEqual([]);
  });

  it('recognises review artifacts even outside the old dedicated directories', () => {
    expect(isReviewArtifactPath('docs/modern-ui-prototype.html')).toBe(true);
    expect(isReviewArtifactPath('docs/design-mockup.md')).toBe(true);
    expect(
      isReviewArtifactPath('apps/trinity/src/assets/screenshots/proof.png'),
    ).toBe(true);
    expect(isReviewArtifactPath('docs/accessibility-evidence.md')).toBe(false);
    expect(isReviewArtifactPath('libs/crypto/key-proof.ts')).toBe(false);
    expect(isReviewArtifactPath('e2e/performance-baseline.spec.mts')).toBe(
      false,
    );
    expect(
      isReviewArtifactPath('apps/trinity/src/assets/icon/icon-512.png'),
    ).toBe(false);
  });

  it('allows only the managed prototype skill instructions', () => {
    for (const file of MANAGED_PROTOTYPE_SKILL_FILES) {
      expect(isReviewArtifactPath(file)).toBe(false);
    }

    expect(isReviewArtifactPath('.agents/skills/prototype/mockup.html')).toBe(
      true,
    );
    expect(isReviewArtifactPath('.agents/skills/prototype/preview.png')).toBe(
      true,
    );
    expect(
      isReviewArtifactPath('.agents/skills/prototype/review-proof.png'),
    ).toBe(true);
    expect(isReviewArtifactPath('.agents/skills/prototype/README.md')).toBe(
      true,
    );
    expect(isReviewArtifactPath('docs/evidence/review-notes.md')).toBe(true);
  });

  it('tracks raster media only when it is a shipping application asset', () => {
    const forbidden = trackedFiles.filter(
      (file) =>
        RASTER_MEDIA.test(file) &&
        !PRODUCT_MEDIA_ROOTS.some((root) => file.startsWith(root)),
    );

    expect(forbidden).toEqual([]);
  });
});
