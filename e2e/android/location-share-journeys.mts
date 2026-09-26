import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceLocationEvent,
} from './account-workspace-fixtures.mts';
import {
  LOCATION_SHARE_ASSERTION_RECORDS,
  LOCATION_SHARE_COORDINATES,
  LOCATION_SHARE_GEO_URI,
  LOCATION_SHARE_LATITUDE,
  LOCATION_SHARE_LONGITUDE,
  LOCATION_SHARE_SOURCES,
  locationShareAssertions as assertions,
} from './location-share-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import {
  openNativeLocationAdapter,
  type NativeLocationAdapter,
} from './native-location-adapter.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const LOCATION_SHARE_BODY = 'Shared location';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const rasterArtifactExtensions = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);
const allAssertionIds = Object.values(assertions);
type LocationShareAssertion = (typeof allAssertionIds)[number];

interface LocationShareCase {
  readonly id: 'location-share';
  readonly source: string;
}

interface LocationShareStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly signal: AbortSignal;
  readonly secrets: Record<string, string>;
  readonly unique: Set<LocationShareAssertion>;
  readonly records: Set<LocationShareAssertion>;
  setLocationAdapter(adapter: NativeLocationAdapter): void;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<LocationShareAssertion>,
  records: Set<LocationShareAssertion>,
  identity: LocationShareAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function scanLocationShareArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const secretValues = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Location-share artifact is a file: ${path}`);
      const extension = extname(path).toLowerCase();
      assert(
        !rasterArtifactExtensions.has(extension),
        `Raster artifact was removed from ${path}`,
      );
      if (!textArtifactExtensions.has(extension)) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of secretValues) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(
        !/\bBearer\s+\S+/u.test(text),
        `Bearer token is absent from ${path}`,
      );
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
      assert(
        !/\bauthorization\b\s*[:=]\s*["']?(?:Bearer|Basic)\s+\S+/iu.test(
          text,
        ) &&
          !/\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*["'][^"']+["']/iu.test(
            text,
          ),
        `Request authentication data is absent from ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

async function waitForExactLocationEcho(
  fixtures: ReturnType<typeof createAccountFixtures>,
  account: NodeWorkspaceAccount,
  roomId: string,
  signal: AbortSignal,
): Promise<WorkspaceLocationEvent> {
  const deadline = performance.now() + 30_000;
  let events: readonly WorkspaceLocationEvent[] = [];
  do {
    events = await fixtures.latestLocationEvents(account, roomId);
    if (events.length > 0) break;
    await delay(500, undefined, { signal });
  } while (performance.now() < deadline);
  assert(events.length === 1, 'Exactly one m.location event reached Synapse');
  const event = events[0]!;
  assert(event.sender === account.userId, 'Location sender is the signed-in user');
  assert(event.msgtype === 'm.location', 'Location event has m.location msgtype');
  assert.equal(event.body, LOCATION_SHARE_BODY);
  assert(event.geoUri === LOCATION_SHARE_GEO_URI, 'Location geo_uri is exact');
  assert(
    event.msc3488Uri === LOCATION_SHARE_GEO_URI,
    'MSC3488 location URI is exact',
  );
  assert(event.assetType === 'm.self', 'MSC3488 asset type is m.self');
  return event;
}

async function runLocationShareStage(
  context: LocationShareStageContext,
): Promise<void> {
  const { client, fixtures, signal, secrets, unique, records } = context;
  const account = await fixtures.account('location-share-owner');
  const room = await fixtures.createRoom(account, {
    name: `Location ${account.username}`,
    preset: 'private_chat',
  });
  secrets['SECRET_USERNAME'] = account.username;
  secrets['SECRET_USER_ID'] = account.userId;
  secrets['SECRET_PASSWORD'] = account.password;
  secrets['SECRET_ROOM_NAME'] = room.name;
  secrets['SECRET_COORDINATES'] = LOCATION_SHARE_COORDINATES;
  secrets['SECRET_LATITUDE'] = String(LOCATION_SHARE_LATITUDE);
  secrets['SECRET_LONGITUDE'] = String(LOCATION_SHARE_LONGITUDE);
  secrets['SECRET_GEO_URI'] = LOCATION_SHARE_GEO_URI;

  const locationAdapter = await openNativeLocationAdapter(
    client.device,
    APPLICATION_ID,
    {
      latitude: LOCATION_SHARE_LATITUDE,
      longitude: LOCATION_SHARE_LONGITUDE,
    },
    signal,
  );
  context.setLocationAdapter(locationAdapter);
  await client.record('native-location-adapter', {
    exactPosition: locationAdapter.proof.position.latitude === LOCATION_SHARE_LATITUDE &&
      locationAdapter.proof.position.longitude === LOCATION_SHARE_LONGITUDE,
    permissionCount: Object.keys(locationAdapter.proof.permissionBaselines).length,
    providerBaselineCaptured:
      typeof locationAdapter.proof.providerBaseline.enabled === 'boolean',
    mockLocationBaselineCaptured: Boolean(
      locationAdapter.proof.mockLocationBaseline,
    ),
    pulseIntervalMs: locationAdapter.proof.pulseIntervalMs,
  });

  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, 60_000);
  await client.tapCurrent('.channel', { text: room.name });
  const composer = await client.visible(
    '[data-testid="composer-input"]',
    {},
    30_000,
  );
  await recordAssertion(client, unique, records, assertions.roomReady, {
    visible: composer.visible,
    privateRoom: true,
  });

  await client.tapCurrent('[data-testid="composer-insert"]');
  await client.visible('[data-testid="insert-location"]');
  await client.tapCurrent('[data-testid="insert-location"]');

  const event = await waitForExactLocationEcho(
    fixtures,
    account,
    room.id,
    signal,
  );
  secrets['SECRET_EVENT_ID'] = event.eventId;
  await recordAssertion(
    client,
    unique,
    records,
    assertions.serverEchoExact,
    {
      exactlyOne: true,
      senderMatches: event.sender === account.userId,
      messageTypeMatches: event.msgtype === 'm.location',
      bodyMatches: event.body === LOCATION_SHARE_BODY,
      geoUriMatches: event.geoUri === LOCATION_SHARE_GEO_URI,
      msc3488UriMatches: event.msc3488Uri === LOCATION_SHARE_GEO_URI,
      assetTypeMatches: event.assetType === 'm.self',
    },
  );

  // Selectors reach the job log, so they never carry the event id: the Room's
  // one location row is found by its card, and read-only observation binds
  // both the card and the long-press row to the exact echoed event.
  const rowSelector =
    '.scroll .msg[data-mid^="$"]:has([data-testid="location-card"])';
  const cardSelector = `${rowSelector} [data-testid="location-card"]`;
  const card = await client.visible(cardSelector, {}, 30_000);
  const binding = await client.eventIdentity(cardSelector, {}, event.eventId);
  assert(
    binding.matches === 1 && binding.exactEvent,
    'Location card belongs to the exact echoed event',
  );
  await recordAssertion(client, unique, records, assertions.cardVisible, {
    visible: card.visible,
    exactEventRow: binding.exactEvent,
    matches: binding.matches,
  });

  const coordinates = await client.visible(
    `${cardSelector} .location__coords`,
    { exactText: LOCATION_SHARE_COORDINATES },
    15_000,
  );
  assert.equal(coordinates.text, LOCATION_SHARE_COORDINATES);
  await recordAssertion(client, unique, records, assertions.exactCoordinates, {
    visible: coordinates.visible,
    exact: true,
  });

  const href = card.attributes['href'];
  assert(href, 'Location card has an href');
  const destination = new URL(href);
  assert.equal(destination.hostname, 'www.openstreetmap.org');
  assert.equal(
    destination.searchParams.get('mlat'),
    String(LOCATION_SHARE_LATITUDE),
  );
  await recordAssertion(client, unique, records, assertions.osmDestination, {
    openStreetMap: true,
    exactLatitude: true,
  });

  const rowBinding = await client.eventIdentity(rowSelector, {}, event.eventId);
  assert(
    rowBinding.matches === 1 && rowBinding.exactEvent,
    'Long-press row is the exact echoed event',
  );
  await client.longPressCurrent(rowSelector);
  const sheet = await client.visible(
    '[data-testid="action-sheet-surface"]',
    {},
    15_000,
  );
  await recordAssertion(client, unique, records, assertions.actionSheetReady, {
    visible: sheet.visible,
    exactEventRow: rowBinding.exactEvent,
  });
  const copyLink = await client.visible(
    '[data-testid="sheet-copy-link"]',
    {},
    15_000,
  );
  await recordAssertion(client, unique, records, assertions.copyLinkVisible, {
    visible: copyLink.visible,
  });
  const editElements = await client.waitElements(
    '[data-testid="sheet-edit"]',
    (elements) => elements.length === 0,
    'location action sheet has no Edit action',
  );
  assert(editElements.length === 0);
  await recordAssertion(client, unique, records, assertions.editAbsent, {
    count: editElements.length,
  });
}

const cases: readonly LocationShareCase[] = [
  {
    id: 'location-share',
    source: `${LOCATION_SHARE_SOURCES.definition}; ${LOCATION_SHARE_SOURCES.geolocation}; ${LOCATION_SHARE_SOURCES.nativeAdapter}; ${LOCATION_SHARE_SOURCES.app}; ${LOCATION_SHARE_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one location-share stage exists');
assert.equal(allAssertionIds.length, LOCATION_SHARE_ASSERTION_RECORDS);

void test(
  'Android location-share journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'location-share',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const fixtures = createAccountFixtures(matrixResources, signal);
        matrixResources.cleanup('Scan location-share diagnostics', () =>
          scanLocationShareArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact location-share diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<LocationShareAssertion>();
        const records = new Set<LocationShareAssertion>();
        const stages: Array<{
          readonly id: LocationShareCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 8;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 1,
                expectedUniqueAssertions: 8,
                expectedAssertionRecords: 8,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: LOCATION_SHARE_SOURCES,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Location-share Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
            APPLICATION_ID,
          );
          let locationAdapter: NativeLocationAdapter | undefined;
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: 8,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[location-share] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runLocationShareStage({
              client,
              fixtures,
              signal,
              secrets,
              unique,
              records,
              setLocationAdapter(value) {
                locationAdapter = value;
              },
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 8);
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            if (locationAdapter) {
              try {
                await locationAdapter.close();
              } catch (error) {
                failures.push(error);
              }
            }
            try {
              await device.clearApplicationData(APPLICATION_ID);
            } catch (error) {
              failures.push(error);
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            await save();
            console.info(
              `[location-share] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Location-share journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 8);
        assert.equal(records.size, LOCATION_SHARE_ASSERTION_RECORDS);
      },
    );
  },
);
