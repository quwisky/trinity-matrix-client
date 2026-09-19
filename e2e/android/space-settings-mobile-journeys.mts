import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';

const openingSource =
  'e2e/browser/journeys/room-administration/space-settings-mobile.spec.mts:105-433';
const membersSource =
  'e2e/browser/journeys/room-administration/space-settings-mobile.spec.mts:435-471';
const readonlySource =
  'e2e/browser/journeys/room-administration/space-settings-mobile.spec.mts:473-536';

const assertions = {
  openingComposerVisible: 'opening.composer-visible',
  settingsVisible: 'settings.visible',
  settingsFullWidth: 'settings.full-width',
  settingsFullHeight: 'settings.full-height',
  directoryVisible: 'directory.visible',
  generalInitiallyHidden: 'general.initially-hidden',
  generalPanelVisible: 'general.panel-visible',
  generalHeadingFocused: 'general.heading-focused',
  generalAccountContained: 'general.account-contained',
  generalPristineActionsHidden: 'general.pristine-actions-hidden',
  generalDraftActionsVisible: 'general.draft-actions-visible',
  generalActionsSticky: 'general.actions-sticky',
  generalDiscardVisible: 'general.discard-visible',
  generalSaveVisible: 'general.save-visible',
  generalDraftRetained: 'general.draft-retained',
  generalDiscardDirectoryVisible: 'general.discard-directory-visible',
  directorySpaceNameContained: 'directory.space-name-contained',
  generalTabTouchTarget: 'general-tab.touch-target',
  forYouTabTouchTarget: 'for-you-tab.touch-target',
  forYouPanelVisible: 'for-you.panel-visible',
  forYouHeadingFocused: 'for-you.heading-focused',
  forYouAlphabeticalTouchTarget: 'for-you.alphabetical-touch-target',
  forYouAlphabeticalRetained: 'for-you.alphabetical-retained',
  forYouBackDirectoryVisible: 'for-you.back-directory-visible',
  accessTabTouchTarget: 'access-tab.touch-target',
  accessPanelVisible: 'access.panel-visible',
  accessHeadingFocused: 'access.heading-focused',
  accessExplainerVisible: 'access.explainer-visible',
  accessActionsHidden: 'access.actions-hidden',
  accessBackDirectoryVisible: 'access.back-directory-visible',
  contentsTabTouchTarget: 'contents-tab.touch-target',
  contentsHeadingFocused: 'contents.heading-focused',
  contentsRoomVisible: 'contents.room-visible',
  contentsCreateRoomTouchTarget: 'contents.create-room-touch-target',
  contentsCreateRoomContained: 'contents.create-room-contained',
  contentsSuggestedTouchTarget: 'contents.suggested-touch-target',
  contentsSuggestedChecked: 'contents.suggested-checked',
  contentsMoveUpTouchTarget: 'contents.move-up-touch-target',
  contentsMoveUpDisabled: 'contents.move-up-disabled',
  contentsMoveDownDisabled: 'contents.move-down-disabled',
  contentsSuggestedCleared: 'contents.suggested-cleared',
  contentsCandidatePickVisible: 'contents.candidate-pick-visible',
  contentsAddSelectedEnabled: 'contents.add-selected-enabled',
  contentsCandidateVisible: 'contents.candidate-visible',
  contentsCandidateLinkCreated: 'contents.candidate-link-created',
  contentsCreateCancelled: 'contents.create-cancelled',
  contentsRemoveCancelRetained: 'contents.remove-cancel-retained',
  contentsCandidateLinkRemoved: 'contents.candidate-link-removed',
  contentsCandidateMembershipRetained: 'contents.candidate-membership-retained',
  contentsBackDirectoryVisible: 'contents.back-directory-visible',
  generalReopenedVisible: 'general.reopened-visible',
  settingsClosed: 'settings.closed',
  spacePillVisible: 'space-pill.visible',
  roomComposerVisible: 'room.composer-visible',
  roomHeadingNamed: 'room.heading-named',
  membersPanelVisible: 'members.panel-visible',
  membersDirectoryHidden: 'members.directory-hidden',
  membersHeadingNamed: 'members.heading-named',
  membersBackVisible: 'members.back-visible',
  membersDirectoryTabVisible: 'members.directory-tab-visible',
  membersDirectoryTabFocused: 'members.directory-tab-focused',
  readonlyNameVisible: 'readonly.name-visible',
  readonlyTopicVisible: 'readonly.topic-visible',
  readonlyNameParagraph: 'readonly.name-paragraph',
  readonlyTopicParagraph: 'readonly.topic-paragraph',
  readonlyActionsHidden: 'readonly.actions-hidden',
  readonlySurfaceVisible: 'readonly.surface-visible',
} as const;

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(selector, accepts, assertion, filter, timeoutMs);
    await client.record(assertion, { assertion, observation: elements });
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: readonly AccountElement[] | null = null;
    try { observation = await client.elements(selector, filter); } catch (diagnosticError) { failures.push(diagnosticError); }
    try {
      await client.record(assertion, { assertion, observation, error: describeFailure(error) });
    } catch (diagnosticError) { failures.push(diagnosticError); }
    throw new AggregateError(failures, `${assertion}: ${describeFailure(error)}`);
  }
}

async function observedValue(
  client: AccountWorkspaceClient,
  assertion: string,
  expression: string,
  accepts: (value: unknown) => boolean,
  timeoutMs = 30_000,
): Promise<unknown> {
  try {
    const value = await waitForNativeShellState(
      () => evaluateNative(client.webview, expression),
      accepts,
      assertion,
      client.signal,
      timeoutMs,
    );
    await client.record(assertion, { assertion, observation: value });
    return value;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: unknown = null;
    try { observation = await evaluateNative(client.webview, expression); } catch (diagnosticError) { failures.push(diagnosticError); }
    try {
      await client.record(assertion, { assertion, observation, error: describeFailure(error) });
    } catch (diagnosticError) { failures.push(diagnosticError); }
    throw new AggregateError(failures, `${assertion}: ${describeFailure(error)}`);
  }
}

async function observedServerValue(
  client: AccountWorkspaceClient,
  assertion: string,
  read: () => Promise<unknown>,
  accepts: (value: unknown) => boolean,
): Promise<void> {
  const value = await waitForNativeShellState(read, accepts, assertion, client.signal, 30_000);
  await client.record(assertion, { assertion, observation: value });
}

async function recordReadOnlyWebviewSession(client: AccountWorkspaceClient): Promise<void> {
  const connection = await client.webview.openSession();
  try {
    const title = await connection.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    await client.record('readonly-webview-session', title);
  } finally {
    connection.close();
  }
}

async function selectSpace(client: AccountWorkspaceClient, name: string): Promise<void> {
  const selector = `button[aria-label=${JSON.stringify(name)}]`;
  await client.visible(selector, {}, 30_000);
  await client.tapCurrent(selector);
  await client.visible('[data-testid="space-actions-overflow"]', {}, 30_000);
}

async function openSpaceSettings(
  client: AccountWorkspaceClient,
  name: string,
  roomName?: string,
): Promise<void> {
  await selectSpace(client, name);
  if (roomName) {
    await client.tapCurrent('.channel', { text: roomName });
    await observedElements(
      client,
      assertions.openingComposerVisible,
      '[data-testid="composer-input"]',
      (elements) => elements.length === 1 && elements[0]!.visible,
    );
    await client.tapCurrent('button[aria-label="Back to rooms"]');
    await selectSpace(client, name);
  }
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.tapCurrent('[data-testid="open-space-settings"]');
}

const visibleOne = (elements: readonly AccountElement[]) =>
  elements.length === 1 && elements[0]!.visible;
const hiddenOne = (elements: readonly AccountElement[]) =>
  elements.length === 1 && !elements[0]!.visible;
const absent = (elements: readonly AccountElement[]) => elements.length === 0;
const focusedOne = (elements: readonly AccountElement[]) =>
  elements.length === 1 && elements[0]!.focused;
const touchTarget = (elements: readonly AccountElement[]) =>
  elements.length === 1 && elements[0]!.visible && elements[0]!.rect.height >= 44;

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'directory-drafts-and-contents',
    source: openingSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('space-settings-owner');
      const suffix = resources.roomName('space-settings-mobile');
      const space = await fixtures.createRoom(owner, {
        name: `Mobile space ${suffix}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const room = await fixtures.createRoom(owner, { name: `Mobile room ${suffix}`, preset: 'private_chat' });
      const candidate = await fixtures.createRoom(owner, { name: `Mobile candidate ${suffix}`, preset: 'private_chat' });
      await fixtures.setSpaceChild(owner, space.id, room.id, { suggested: true });

      await client.login(owner);
      await recordReadOnlyWebviewSession(client);
      await openSpaceSettings(client, space.name, room.name);
      await observedElements(client, assertions.settingsVisible, '[data-testid="space-settings"]', visibleOne);
      const surfaceGeometry = `(() => {
        const element = document.querySelector('[data-testid="space-settings"]');
        const viewport = window.visualViewport;
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return { surface:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom}, viewport:{width:viewport?.width ?? innerWidth,height:viewport?.height ?? innerHeight} };
      })()`;
      await observedValue(client, assertions.settingsFullWidth, surfaceGeometry, (value) => {
        const g = value as { surface?: { width?: number }; viewport?: { width?: number } } | null;
        return typeof g?.surface?.width === 'number' && typeof g.viewport?.width === 'number' && g.surface.width >= g.viewport.width - 1;
      });
      await observedValue(client, assertions.settingsFullHeight, surfaceGeometry, (value) => {
        const g = value as { surface?: { height?: number }; viewport?: { height?: number } } | null;
        return typeof g?.surface?.height === 'number' && typeof g.viewport?.height === 'number' && g.surface.height >= g.viewport.height - 1;
      });
      await observedElements(client, assertions.directoryVisible, '[data-testid="space-settings-directory"]', visibleOne);
      await observedElements(client, assertions.generalInitiallyHidden, '[data-testid="space-settings-panel-general"]', hiddenOne);
      await client.tapCurrent('[data-testid="space-settings-tab-general"]');
      await observedElements(client, assertions.generalPanelVisible, '[data-testid="space-settings-panel-general"]', visibleOne);
      await observedElements(client, assertions.generalHeadingFocused, '[data-testid="space-settings-section-heading"]', focusedOne);
      await observedValue(client, assertions.generalAccountContained, `(() => {
        const surface=document.querySelector('[data-testid="space-settings"]')?.getBoundingClientRect();
        const account=document.querySelector('[data-testid="space-settings-account"]')?.getBoundingClientRect();
        return surface&&account ? {surfaceRight:surface.right,accountRight:account.right}:null;
      })()`, (value) => {
        const g=value as {surfaceRight?:number;accountRight?:number}|null;
        return typeof g?.surfaceRight==='number'&&typeof g.accountRight==='number'&&g.accountRight<=g.surfaceRight;
      });
      await observedElements(client, assertions.generalPristineActionsHidden, '[data-testid="space-settings-general-actions"]', absent);
      await client.fill('[data-testid="space-settings-topic"]', 'A mobile draft');
      await observedElements(client, assertions.generalDraftActionsVisible, '[data-testid="space-settings-general-actions"]', visibleOne);
      await observedValue(client, assertions.generalActionsSticky, `(() => { const e=document.querySelector('[data-testid="space-settings-general-actions"]'); return e instanceof HTMLElement && getComputedStyle(e).position === 'sticky'; })()`, (value) => value === true);
      await observedElements(client, assertions.generalDiscardVisible, '[data-testid="space-settings-discard"]', visibleOne);
      await observedElements(client, assertions.generalSaveVisible, '[data-testid="space-settings-save"]', visibleOne);
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedValue(client, assertions.generalDraftRetained, `document.querySelector('[data-testid="space-settings-topic"]')?.value`, (value) => value === 'A mobile draft');
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await client.tapCurrent('[data-testid="alert-confirm"]');
      await observedElements(client, assertions.generalDiscardDirectoryVisible, '[data-testid="space-settings-directory"]', visibleOne);
      await observedValue(client, assertions.directorySpaceNameContained, `(() => {
        const surface=document.querySelector('[data-testid="space-settings"]')?.getBoundingClientRect();
        const name=document.querySelector('[data-testid="space-settings-space-name"]')?.getBoundingClientRect();
        return surface&&name ? {surfaceRight:surface.right,nameRight:name.right}:null;
      })()`, (value) => {
        const g=value as {surfaceRight?:number;nameRight?:number}|null;
        return typeof g?.surfaceRight==='number'&&typeof g.nameRight==='number'&&g.nameRight<=g.surfaceRight;
      });
      await observedElements(client, assertions.generalTabTouchTarget, '[data-testid="space-settings-tab-general"]', touchTarget);
      await observedElements(client, assertions.forYouTabTouchTarget, '[data-testid="space-settings-tab-for-you"]', touchTarget);
      await client.tapCurrent('[data-testid="space-settings-tab-for-you"]');
      await observedElements(client, assertions.forYouPanelVisible, '[data-testid="space-settings-panel-for-you"]', visibleOne);
      await observedElements(client, assertions.forYouHeadingFocused, '[data-testid="space-settings-section-heading"]', focusedOne);
      await observedElements(client, assertions.forYouAlphabeticalTouchTarget, '[data-testid="space-settings-order-alphabetical"]', touchTarget);
      await client.tapCurrent('[data-testid="space-settings-order-alphabetical"]');
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedValue(client, assertions.forYouAlphabeticalRetained, `document.querySelector('[data-testid="space-settings-order-alphabetical"] input')?.checked === true`, (value) => value === true);
      await client.tapCurrent('[data-testid="space-settings-for-you-discard"]');
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await observedElements(client, assertions.forYouBackDirectoryVisible, '[data-testid="space-settings-directory"]', visibleOne);
      await observedElements(client, assertions.accessTabTouchTarget, '[data-testid="space-settings-tab-access"]', touchTarget);
      await client.tapCurrent('[data-testid="space-settings-tab-access"]');
      await observedElements(client, assertions.accessPanelVisible, '[data-testid="space-settings-panel-access"]', visibleOne);
      await observedElements(client, assertions.accessHeadingFocused, '[data-testid="space-settings-section-heading"]', focusedOne);
      await observedElements(client, assertions.accessExplainerVisible, '[data-testid="space-settings-panel-access"]', (elements) => visibleOne(elements) && elements[0]!.text.includes('Rooms inside it keep their own access'));
      await observedElements(client, assertions.accessActionsHidden, '[data-testid="space-settings-access-actions"]', absent);
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await observedElements(client, assertions.accessBackDirectoryVisible, '[data-testid="space-settings-directory"]', visibleOne);
      await observedElements(client, assertions.contentsTabTouchTarget, '[data-testid="space-settings-tab-contents"]', touchTarget);
      await client.tapCurrent('[data-testid="space-settings-tab-contents"]');
      await observedElements(client, assertions.contentsHeadingFocused, '[data-testid="space-settings-section-heading"]', focusedOne);
      await observedElements(client, assertions.contentsRoomVisible, `[data-testid="space-content-${room.id}"]`, visibleOne, {}, 30_000);
      await observedElements(client, assertions.contentsCreateRoomTouchTarget, '[data-testid="space-settings-panel-contents"] button', touchTarget, { exactText: 'Create Room' });
      await observedValue(client, assertions.contentsCreateRoomContained, `(() => {
        const panel=document.querySelector('[data-testid="space-settings-panel-contents"]')?.getBoundingClientRect();
        const button=[...document.querySelectorAll('[data-testid="space-settings-panel-contents"] button')].find(e=>e.textContent?.trim()==='Create Room')?.getBoundingClientRect();
        return panel&&button ? {panelRight:panel.right,buttonRight:button.right}:null;
      })()`, (value) => {
        const g=value as {panelRight?:number;buttonRight?:number}|null;
        return typeof g?.panelRight==='number'&&typeof g.buttonRight==='number'&&g.buttonRight<=g.panelRight;
      });
      const suggest=`[data-testid="space-content-suggest-control-${room.id}"]`;
      await observedElements(client, assertions.contentsSuggestedTouchTarget, suggest, touchTarget);
      await observedValue(client, assertions.contentsSuggestedChecked, `document.querySelector(${JSON.stringify(suggest)})?.querySelector('input')?.checked === true`, (value) => value === true);
      await observedElements(client, assertions.contentsMoveUpTouchTarget, `[data-testid="space-content-move-up-${room.id}"]`, touchTarget);
      await observedElements(client, assertions.contentsMoveUpDisabled, `[data-testid="space-content-move-up-${room.id}"]`, (elements) => elements.length===1&&elements[0]!.disabled);
      await observedElements(client, assertions.contentsMoveDownDisabled, `[data-testid="space-content-move-down-${room.id}"]`, (elements) => elements.length===1&&elements[0]!.disabled);
      await client.tapCurrent(suggest);
      await observedServerValue(client, assertions.contentsSuggestedCleared, () => fixtures.spaceChild(owner, space.id, room.id), (value) => (value as {suggested?:unknown}|undefined)?.suggested !== true);
      await client.tapCurrent('[data-testid="space-contents-add-existing"]');
      await client.fill('[data-testid="space-contents-search"]', candidate.name);
      const candidatePick=`[data-testid="space-contents-pick-${candidate.id}"]`;
      await observedElements(client, assertions.contentsCandidatePickVisible, candidatePick, visibleOne, {}, 30_000);
      await client.tapCurrent(candidatePick);
      await observedElements(client, assertions.contentsAddSelectedEnabled, '[data-testid="space-contents-add-confirm"]', (elements) => elements.length===1&&elements[0]!.visible&&!elements[0]!.disabled);
      await client.scrollIntoViewIfNeeded('[data-testid="space-contents-add-confirm"]', '[data-testid="space-settings-detail"]');
      await client.tapCurrent('[data-testid="space-contents-add-confirm"]');
      const candidateRow=`[data-testid="space-content-${candidate.id}"]`;
      await observedElements(client, assertions.contentsCandidateVisible, candidateRow, visibleOne, {}, 30_000);
      await observedServerValue(client, assertions.contentsCandidateLinkCreated, () => fixtures.spaceChild(owner, space.id, candidate.id), (value) => Array.isArray((value as {via?:unknown}|undefined)?.via));
      await client.scrollIntoViewIfNeeded('[data-testid="space-contents-create-room"]', '[data-testid="space-settings-detail"]');
      await client.tapCurrent('[data-testid="space-contents-create-room"]');
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedElements(client, assertions.contentsCreateCancelled, '[data-testid="alert-surface"]', absent);
      const candidateUnlink=`[data-testid="space-content-unlink-${candidate.id}"]`;
      await client.scrollIntoViewIfNeeded(candidateUnlink, '[data-testid="space-settings-detail"]');
      await client.tapCurrent(candidateUnlink);
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedElements(client, assertions.contentsRemoveCancelRetained, candidateRow, visibleOne);
      await client.tapCurrent(candidateUnlink);
      await client.tapCurrent('[data-testid="alert-confirm"]');
      await observedServerValue(client, assertions.contentsCandidateLinkRemoved, () => fixtures.spaceChild(owner, space.id, candidate.id), (value) => value !== undefined && Object.keys(value as object).length===0);
      await observedServerValue(client, assertions.contentsCandidateMembershipRetained, () => fixtures.roomMembership(owner, candidate.id, owner), (value) => value==='join');
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await observedElements(client, assertions.contentsBackDirectoryVisible, '[data-testid="space-settings-directory"]', visibleOne);
      await client.tapCurrent('[data-testid="space-settings-tab-general"]');
      await observedElements(client, assertions.generalReopenedVisible, '[data-testid="space-settings-panel-general"]', visibleOne);
      await client.tapCurrent('[data-testid="space-settings-cancel"]');
      await observedElements(client, assertions.settingsClosed, '[data-testid="space-settings"]', absent);
      await observedElements(client, assertions.spacePillVisible, `button[aria-label=${JSON.stringify(space.name)}]`, visibleOne);
      await client.tapCurrent('.channel', { text:room.name });
      await observedElements(client, assertions.roomComposerVisible, '[data-testid="composer-input"]', visibleOne);
      await observedElements(client, assertions.roomHeadingNamed, 'h1', (elements) => elements.length===1&&elements[0]!.visible&&elements[0]!.text.includes(room.name));
    },
  },
  {
    id: 'members-shortcut',
    source: membersSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner=await fixtures.account('space-members-owner');
      const space=await fixtures.createRoom(owner,{name:`Members shortcut ${resources.roomName('space-members')}`,preset:'private_chat',creation_content:{type:'m.space'}});
      await client.login(owner);
      await recordReadOnlyWebviewSession(client);
      await selectSpace(client,space.name);
      await client.tapCurrent('[data-testid="space-actions-overflow"]');
      await client.tapCurrent('[data-testid="open-space-members"]');
      await observedElements(client,assertions.membersPanelVisible,'[data-testid="space-settings-panel-members"]',visibleOne);
      await observedElements(client,assertions.membersDirectoryHidden,'[data-testid="space-settings-directory"]',hiddenOne);
      await observedElements(client,assertions.membersHeadingNamed,'[data-testid="space-settings-section-heading"]',(elements)=>visibleOne(elements)&&elements[0]!.text==='Members');
      await observedElements(client,assertions.membersBackVisible,'[data-testid="space-settings-mobile-back"]',visibleOne);
      await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
      await observedElements(client,assertions.membersDirectoryTabVisible,'[data-testid="space-settings-tab-members"]',visibleOne);
      await observedElements(client,assertions.membersDirectoryTabFocused,'[data-testid="space-settings-tab-members"]',focusedOne);
    },
  },
  {
    id: 'readonly-member',
    source: readonlySource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner=await fixtures.account('space-readonly-owner');
      const member=await fixtures.account('space-readonly-member');
      const space=await fixtures.createRoom(owner,{name:`Phone read only ${resources.roomName('space-readonly')}`,preset:'private_chat',creation_content:{type:'m.space'}});
      await fixtures.invite(owner,space.id,member);
      await fixtures.join(member,space.id);
      await client.login(member);
      await recordReadOnlyWebviewSession(client);
      await openSpaceSettings(client,space.name);
      await client.tapCurrent('[data-testid="space-settings-tab-general"]');
      await observedElements(client,assertions.readonlyNameVisible,'[data-testid="space-settings-name"]',(elements)=>visibleOne(elements)&&elements[0]!.text===space.name);
      await observedElements(client,assertions.readonlyTopicVisible,'[data-testid="space-settings-topic"]',(elements)=>visibleOne(elements)&&elements[0]!.text==='No topic set.');
      await observedValue(client,assertions.readonlyNameParagraph,`document.querySelector('[data-testid="space-settings-name"]')?.tagName`,(value)=>value==='P');
      await observedValue(client,assertions.readonlyTopicParagraph,`document.querySelector('[data-testid="space-settings-topic"]')?.tagName`,(value)=>value==='P');
      await observedElements(client,assertions.readonlyActionsHidden,'[data-testid="space-settings-general-actions"]',absent);
      await observedElements(client,assertions.readonlySurfaceVisible,'[data-testid="space-settings"]',(elements)=>visibleOne(elements)&&elements[0]!.rect.width>0);
    },
  },
];

assert.equal(cases.length, 3, 'Exactly three mobile Space Settings stages are required');
assert.equal(Object.keys(assertions).length, 67, 'Exactly sixty-seven direct assertions are required');

void test('Android mobile Space Settings journeys', { timeout: 1_080_000 }, async (context) => {
  await withNodeTestResources(
    { testId: context.name, signal: context.signal },
    async ({ matrixResources, signal }) => {
      const session=readSession();
      const output=join(process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot,'dist/.playwright'),'space-settings-mobile');
      await mkdir(output,{recursive:true});
      const secrets:Record<string,string>={};
      const baseFixtures=createAccountFixtures(matrixResources,signal);
      const fixtures:typeof baseFixtures={...baseFixtures,account:async(...args)=>{const account=await baseFixtures.account(...args);secrets[`PASSWORD_${account.username}`]=account.password;return account;}};
      matrixResources.cleanup('Redact mobile Space Settings diagnostics',()=>redactMaestroArtifacts(output,secrets));
      const device=await openMaestroDevice({workspaceRoot:session.workspaceRoot,signal,artifactDirectory:output,serial:process.env['TRINITY_ANDROID_SERIAL']});
      matrixResources.cleanup('Mobile Space Settings Android device',()=>device.close());
      let client:AccountWorkspaceClient|undefined;
      matrixResources.cleanup('Mobile Space Settings Android WebView',async()=>client?.close());
      await device.install(join(session.workspaceRoot,'android/app/build/outputs/apk/debug/app-debug.apk'));
      const stages:Array<{id:string;source:string;status:'running'|'passed'|'failed';durationMs:number;artifact:string;failureCount?:number;error?:string}>=[];
      const save=()=>writeFile(join(output,'journeys.json'),`${JSON.stringify({expectedStages:cases.length,stages},null,2)}\n`);
      for(const entry of cases){
        const directory=join(output,entry.id);await mkdir(directory,{recursive:true});
        client=new AccountWorkspaceClient(device,session.workspaceRoot,directory,signal);
        const stage:{id:string;source:string;status:'running'|'passed'|'failed';durationMs:number;artifact:string;failureCount?:number;error?:string}={id:entry.id,source:entry.source,status:'running',durationMs:0,artifact:`${entry.id}/*`};
        stages.push(stage);await save();const started=performance.now();const failures:unknown[]=[];
        console.info(`[space-settings-mobile] ${entry.id} start`);
        try{await client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE);await entry.run({client,fixtures,resources:matrixResources,signal});await client.capture('passed');}
        catch(error){failures.push(error);try{await client.capture('failed');}catch(captureError){failures.push(captureError);}}
        finally{try{await client.close();}catch(error){failures.push(error);}client=undefined;}
        stage.durationMs=performance.now()-started;stage.failureCount=failures.length;
        if(failures.length){stage.status='failed';stage.error=failures.map(describeFailure).join('\n');}else stage.status='passed';
        await save();console.info(`[space-settings-mobile] ${entry.id} end ${stage.status} ${Math.round(stage.durationMs)}ms`);
        if(failures.length)throw new AggregateError(failures,`${entry.id} failed`);
      }
    },
  );
});
