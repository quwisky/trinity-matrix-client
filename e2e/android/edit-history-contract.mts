import assert from 'node:assert/strict';

const coreSites = [
  [232, 'room-ready'],
  [237, 'latest-text'],
  [244, 'marker-visible'],
  [248, 'dialog-visible'],
  [249, 'three-revisions'],
  [253, 'oldest-first-labels'],
  [263, 'insertion-visible'],
  [270, 'inserted-final'],
  [271, 'deleted-second'],
  [273, 'original-no-diff'],
  [279, 'toggle-default-on'],
  [281, 'toggle-off'],
  [282, 'no-insertions-off'],
  [283, 'exact-versions-off'],
  [286, 'insertions-restored'],
  [287, 'no-error'],
  [289, 'not-truncated'],
  [292, 'closed-first'],
  [299, 'formatted-dialog'],
  [301, 'bold-insert-mon'],
  [305, 'bold-delete-fri'],
  [306, 'bold-retain-day'],
  [311, 'bold-monday-off'],
  [312, 'formatted-no-diff-off'],
  [313, 'formatted-no-old-word'],
  [316, 'formatted-closed'],
  [321, 'plain-reopened'],
  [322, 'plain-reopened-three'],
  [323, 'two-remove-actions'],
  [324, 'original-not-removable'],
  [339, 'two-after-current-remove'],
  [342, 'final-absent-after-remove'],
  [344, 'no-error-after-remove'],
  [346, 'closed-after-current-remove'],
  [350, 'timeline-second-draft'],
  [353, 'marker-remains'],
  [358, 'reopened-two'],
  [361, 'removed-final-still-absent'],
  [362, 'second-still-present'],
  [373, 'one-after-last-remove'],
  [377, 'closed-after-last-remove'],
  [379, 'timeline-original'],
  [382, 'marker-absent'],
  [393, 'deleted-row-visible'],
  [394, 'deleted-marker-absent'],
  [395, 'deleted-body-absent'],
] as const;

const pixelSites = [
  [108, 'room-ready'],
  [111, 'latest-text'],
  [116, 'dialog-visible'],
  [511, 'dialog-box-present'],
  [512, 'fullscreen-width'],
  [513, 'fullscreen-height'],
  [514, 'close-visible'],
  [521, 'close-width-44'],
  [522, 'close-height-44'],
  [523, 'dialog-no-overflow'],
  [526, 'toggle-visible'],
  [527, 'revisions-visible'],
  [535, 'reading-no-overflow'],
  [542, 'remove-in-viewport'],
  [544, 'remove-left-inside'],
  [545, 'remove-right-inside'],
] as const;

export const EDIT_HISTORY_ASSERTION_RECORDS = 62 as const;

export const editHistoryCases = [
  {
    id: 'revision-lifecycle',
    source:
      'e2e/browser/journeys/conversations/message-edit-history.spec.mts:123-396',
    sites: coreSites,
    expectedAssertionRecords: 46,
    assertions: coreSites.map(
      ([, suffix]) => `edit-history.revision-lifecycle.${suffix}`,
    ),
  },
  {
    id: 'pixel5-large-text',
    source:
      'e2e/browser/journeys/conversations/message-edit-history.spec.mts:500-552',
    sites: pixelSites,
    expectedAssertionRecords: 16,
    assertions: pixelSites.map(
      ([, suffix]) => `edit-history.pixel5-large-text.${suffix}`,
    ),
  },
] as const;

export type EditHistoryCase = (typeof editHistoryCases)[number];
export type EditHistoryStage = EditHistoryCase['id'];
export type EditHistoryAssertion = EditHistoryCase['assertions'][number];

function entryFor(stage: EditHistoryStage): EditHistoryCase {
  const entry = editHistoryCases.find((item) => item.id === stage);
  assert(entry, `Unknown edit-history stage ${stage}`);
  return entry;
}

export function editHistoryAssertion(
  stage: EditHistoryStage,
  suffix: string,
): EditHistoryAssertion {
  const entry = entryFor(stage);
  const identity = `edit-history.${stage}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertEditHistoryRecords(
  stage: EditHistoryStage,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stage).assertions);
}
