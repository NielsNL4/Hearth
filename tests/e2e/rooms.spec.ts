import { expect, test, type Page } from '@playwright/test';
import type { ActorProjectionV1 } from '@hearth/domain';

// UI contract tests stub the network boundary. Database authorization is tested
// separately against real PostgreSQL in database.test.ts, not emulated here.
const roomId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';
const campaignId = '00000000-0000-4000-8000-000000000020';
const code = 'abcdef1234567890abcdef1234567890';
const timestamp = '2026-09-10T10:00:00Z';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'dm@example.com', app_metadata: { provider: 'email' }, user_metadata: { display_name: 'River' }, created_at: timestamp };
const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${payload}.test-signature`;
const session = { access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
type CameraProbeSnapshot = {
  sequence: number;
  mode: 'tactical' | 'overview' | 'follow';
  isCanvasCamera: boolean;
  camera: { type: string; projection: 'orthographic' | 'perspective' | 'unknown'; zoom?: number; left?: number; right?: number; top?: number; bottom?: number };
  orbit?: { target: { x: number; y: number; z: number }; yaw: number; pitch: number; distance: number };
};
type E2ECommand = { type: string; message: unknown };
type E2EHarness = {
  commands: E2ECommand[];
  projection: ActorProjectionV1;
  camera?: CameraProbeSnapshot;
  publishProjection?: (projection: unknown) => void;
  connectDelayMs?: number;
  connectFailures?: number;
};
declare global {
  interface Window { __HEARTH_E2E__?: E2EHarness; }
}
async function mockBackend(page: Page, { role = 'dm', joined = false, failFirstCreation = false }: { role?: 'dm' | 'player'; joined?: boolean; failFirstCreation?: boolean } = {}) {
  const state = { joined, role, createCalls: [] as Record<string, string>[], signupRedirect: '', assets: [] as Array<Record<string, unknown>> };
  await page.routeWebSocket('ws://127.0.0.1:59999/**', () => {});
  await page.route('http://127.0.0.1:59999/**', async (route) => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/auth/v1/token') return respond(session);
    if (url.pathname === '/auth/v1/user') return respond(user);
    if (url.pathname === '/auth/v1/logout') return respond({});
    if (url.pathname === '/auth/v1/signup') { state.signupRedirect = url.searchParams.get('redirect_to') ?? ''; return respond({ ...user, identities: [{ id: userId }] }); }
    if (url.pathname === '/rest/v1/rpc/create_room') {
      state.createCalls.push(route.request().postDataJSON());
      state.joined = true;
      if (failFirstCreation && state.createCalls.length === 1) return respond({ message: 'Response lost. Please retry.' }, 500);
      return respond({ room_id: roomId });
    }
    if (url.pathname === '/rest/v1/rpc/join_room') { state.joined = true; return respond({ room_id: roomId }); }
    if (url.pathname === '/rest/v1/rooms') {
      const room = { id: roomId, campaign_id: campaignId, name: 'The Sunken Keep', created_by: userId, revision: 0, created_at: timestamp };
      const single = route.request().headers().accept?.includes('vnd.pgrst.object');
      return respond(single ? state.joined ? room : null : state.joined ? [room] : []);
    }
    if (url.pathname === '/rest/v1/campaigns') return respond(state.joined ? [{ id: campaignId, name: 'Salt & Shadow', owner_id: userId }] : []);
    if (url.pathname === '/rest/v1/room_members') return respond(state.joined ? [{ room_id: roomId, user_id: userId, role, display_name: 'River', joined_at: timestamp }] : []);
    if (url.pathname === '/rest/v1/room_invites') {
      const result = role === 'dm' && state.joined ? { code } : null;
      const single = route.request().headers().accept?.includes('vnd.pgrst.object');
      return respond(single ? result : result ? [result] : []);
    }
    if (url.pathname === '/rest/v1/room_events') return respond(state.joined ? [{ id: 1, room_id: roomId, actor_id: userId, type: 'room.created', payload: { display_name: 'River' }, created_at: timestamp }] : []);
    if (url.pathname === '/rest/v1/room_assets') return respond(state.assets);
    throw new Error(`Unexpected backend request: ${url.pathname}`);
  });
  return state;
}

async function mockTacticalBoundary(page: Page, state: Awaited<ReturnType<typeof mockBackend>>, connectDelayMs = 0, seedInitiative = false, seedFog = false, connectFailures = 0, processDelayMs = 0, seedGeometry = false, hideGrid = false, perspectiveEnabled = false) {
  const role = state.role;
  await page.addInitScript(({ delay, seed, fog, failures, geometry, noGrid, perspective, role }) => {
    const tokens: ActorProjectionV1['scene']['tokens'] = seed ? [
      { id: 'hero', assetId: 'hero-asset', position: { x: 75, y: 75 }, size: { width: 50, height: 50 }, rotation: 0, label: 'Vanguard', z: 0, hp: { current: 10, maximum: 10 } },
      { id: 'mage', assetId: 'mage-asset', position: { x: 125, y: 75 }, size: { width: 50, height: 50 }, rotation: 0, label: 'Arcanist', z: 1, hp: { current: 8, maximum: 8 } },
    ] : [];
    const editableGeometry: NonNullable<ActorProjectionV1['controls']['geometry']['editableGeometry']> = {
      walls: [{ wallId: 'seed-wall', wallKind: 'blocking', start: { x: 500, y: 400 }, end: { x: 700, y: 400 }, height: 100, thickness: 8, elevation: 0, material: 'masonry', openings: [], recordRevision: 3 }],
      structures: [{ structureId: 'seed-structure', structureKind: 'floor', position: { x: 1100, y: 700 }, size: { width: 100, height: 100 }, rotation: 0, label: 'Courtyard floor', z: 0, material: 'default', baseElevation: 0, slabHeight: 8, recordRevision: 4 }],
    };
    const projection: ActorProjectionV1 = {
      protocolVersion: 1, kind: 'full', streamId: '00000000-0000-4000-8000-000000000099', sceneRevision: 0, projectionRevision: 0, streamReset: { kind: 'initial' },
      scene: { map: fog || geometry ? { assetId: 'fog-map', width: 2000, height: 1200 } : null, grid: { type: 'square', visible: !noGrid, cellSize: 50, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
        tokens, drawings: [], initiative: seed ? { active: false, round: 0, turnIndex: null, entries: [{ id: 'hero-turn', tokenId: 'hero', label: 'Vanguard', score: 18 }, { id: 'mage-turn', tokenId: 'mage', label: 'Arcanist', score: 14 }] } : { active: false, round: 0, turnIndex: null, entries: [] } },
      sight: { mode: 'unrestricted' }, fog: fog ? { mode: 'concealed-regions', polygons: [{ points: [{ x: 700, y: 400 }, { x: 900, y: 400 }, { x: 900, y: 600 }] }] } : { mode: 'disabled' },
      wallMesh: { segments: role === 'dm' && geometry ? [{ id: 'mesh-wall', start: { x: 500, y: 400 }, end: { x: 700, y: 400 }, height: 100, thickness: 8, elevation: 0, material: 'masonry', openings: [] }] : [] }, lights: [],
      controls: { movement: { canMove: role === 'dm' || tokens.length > 0, canSetPolicy: role === 'dm', policy: 'owned', expectedNavigationRevision: 0 }, tokens: { canCreate: true, records: tokens.map((token) => ({ tokenId: token.id, canTransform: true, canUpdateDetails: true, canDelete: true, expectedTokenRevision: 0, expectedMovementRevision: 0 })) }, drawings: { canCreate: true, canSetPolicy: role === 'dm', policy: 'all', expectedDrawingRevision: 0, records: [] }, initiative: { canAdd: role === 'dm' || tokens.length > 0, canReorder: role === 'dm', canStart: role === 'dm', canAdvance: role === 'dm', canStop: role === 'dm', expectedInitiativeRevision: 0, records: (seed ? ['hero-turn', 'mage-turn'] : []).map((entryId) => ({ entryId, canUpdate: true, canRemove: true })) }, fog: { canCommit: role === 'dm', canUndo: role === 'dm', canClear: role === 'dm', expectedFogRevision: fog ? 1 : 0, latestOperationId: role === 'dm' && fog ? 'seed-reveal' : null }, geometry: { canCreateWall: role === 'dm', canUpdateWall: role === 'dm', canDeleteWall: role === 'dm', canCreateStructure: role === 'dm', canUpdateStructure: role === 'dm', canDeleteStructure: role === 'dm', expectedWallRevision: geometry ? 7 : 0, expectedStructureRevision: geometry ? 5 : 0, editableGeometry: role === 'dm' && geometry ? editableGeometry : undefined }, perspective: { canUse: role === 'dm' || perspective, canSet: role === 'dm', enabled: perspective } }
    };
    window.__HEARTH_E2E__ = { commands: [], projection, connectDelayMs: delay, connectFailures: failures };
  }, { delay: connectDelayMs, seed: seedInitiative, fog: seedFog, failures: connectFailures, geometry: seedGeometry, noGrid: hideGrid, perspective: perspectiveEnabled, role });
  await page.route('http://127.0.0.1:59998/**', async (route) => {
    const url = new URL(route.request().url());
    const assetId = url.pathname.split('/')[3] ?? '';
    const kind = assetId.endsWith('101') ? 'map' : 'token';
    const outputs = kind === 'map'
      ? [{ key: `rooms/test/${assetId}/tiles/0/0_0.webp`, type: 'tile', width: 512, height: 512, z: 0, x: 0, y: 0 }]
      : [{ key: `rooms/test/${assetId}/thumbnail.webp`, type: 'thumbnail', width: 128, height: 128 }, { key: `rooms/test/${assetId}/image.webp`, type: 'image', width: 256, height: 256 }];
    if (url.pathname === '/upload') return route.fulfill({ status: 204, body: '' });
    if (url.pathname.endsWith('/upload')) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ url: 'http://127.0.0.1:59998/upload', fields: {} }) });
    if (url.pathname.endsWith('/process')) {
      if (processDelayMs) await new Promise((resolve) => setTimeout(resolve, processDelayMs));
      state.assets = [...state.assets.filter((asset) => asset.id !== assetId), { id: assetId, room_id: roomId, created_by: userId, kind, status: 'ready', width: kind === 'map' ? 512 : 256, height: kind === 'map' ? 512 : 256, updated_at: timestamp }];
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: assetId, status: 'queued' }) });
    }
    if (url.pathname.endsWith('/manifest')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, assetId, kind, width: kind === 'map' ? 512 : 256, height: kind === 'map' ? 512 : 256, outputs }) });
    if (url.pathname.endsWith('/download-urls')) {
      const keys = (route.request().postDataJSON() as { keys: string[] }).keys;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ expiresIn: 300, urls: Object.fromEntries(keys.map((key) => [key, `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#92a878"/></svg>')}`])) }) });
    }
    throw new Error(`Unexpected asset request: ${url.pathname}`);
  });
}

async function signIn(page: Page) {
  await page.getByLabel('Email address').fill('dm@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Return to your table' }).click();
}

async function capturedCommand(page: Page, type: string) {
  return page.evaluate((wanted) => {
    const harness = window.__HEARTH_E2E__;
    return harness?.commands.find((command) => command.type === wanted);
  }, type);
}

test('DM creates a room, sees the invite, and resumes it after reload and sign-in', async ({ page }, testInfo) => {
  const state = await mockBackend(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'My adventures.' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create your first room' }).click();
  await page.getByLabel('Campaign name').fill('Salt & Shadow');
  await page.getByLabel('Room name').fill('The Sunken Keep');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page).toHaveURL(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { name: 'The Sunken Keep.' })).toBeVisible();
  await expect(page.getByLabel('Invite code', { exact: true })).toHaveValue(code);
  await page.screenshot({ path: testInfo.outputPath('lobby.png'), fullPage: true });
  expect(state.createCalls).toHaveLength(1);
  expect(state.createCalls[0].p_command_id).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The Sunken Keep.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The Sunken Keep.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('creation retries reuse the command ID after an ambiguous failure', async ({ page }) => {
  const state = await mockBackend(page, { failFirstCreation: true });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Create your first room' }).click();
  await page.getByLabel('Campaign name').fill('Salt & Shadow');
  await page.getByLabel('Room name').fill('The Sunken Keep');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Response lost');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The Sunken Keep.' })).toBeVisible();
  expect(state.createCalls).toHaveLength(2);
  expect(state.createCalls[0]).toEqual(state.createCalls[1]);
});

test('invite survives signup and login, and players cannot see DM invitation controls', async ({ page }) => {
  const state = await mockBackend(page, { role: 'player' });
  await page.goto(`/join/${code}`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Display name').fill('River');
  await page.getByLabel('Email address').fill('player@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Create your account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const redirect = new URL(state.signupRedirect);
  expect(redirect.pathname).toBe('/auth/callback');
  expect(redirect.searchParams.get('next')).toBe(`/join/${code}`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Join the adventure.' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { name: 'The Sunken Keep.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy invite link' })).toHaveCount(0);
  await expect(page.getByText('Your Dungeon Master manages invitations.', { exact: false })).toBeVisible();
});

test('nonmember room URL shows an access message and mobile layout stays within viewport', async ({ page }) => {
  await mockBackend(page, { role: 'player' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rooms/${roomId}`);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Room unavailable.' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to adventures', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My adventures.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Invite code', { exact: true }).fill('bad-code');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('32-character');
});

test('confirmation callback preserves invitations and rejects external redirects', async ({ page }) => {
  await mockBackend(page);
  await page.goto(`/auth/callback?next=${encodeURIComponent(`/join/${code}`)}`);
  await expect(page).toHaveURL(`/join/${code}`);
  await expect(page.getByText('Sign in or create an account to accept your room invitation.')).toBeVisible();
  await page.goto('/auth/callback?next=https%3A%2F%2Fexample.com');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
});

test('tactical table persists grid settings and completes map and token workflows', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, false, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.locator('.table-stage canvas')).toBeVisible();
  await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  await expect(page.getByText('Tactical table', { exact: true })).toBeVisible();
  await page.getByLabel('Cell size').fill('64');
  await expect(page.getByRole('button', { name: 'Save grid' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save grid' }).click();
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'grid.set'))).toBe(true);

  await page.locator('.map-upload input').setInputFiles({ name: 'keep.png', mimeType: 'image/png', buffer: Buffer.from('map') });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'map.set'))).toBe(true);
  state.assets = [];
  await page.locator('.upload-button input').setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from('token') });
  const tokenAsset = page.getByRole('button', { name: 'Place token 1' });
  await expect(tokenAsset).toBeVisible();
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tokenAsset.click();
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.table-stage canvas').click({ position: { x: 300, y: 220 } });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'token.create'))).toBe(true);
});

test('DM can start the synchronized initiative tracker from the tactical table', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  await expect(page.getByLabel('Initiative tracker')).toContainText('Vanguard');
  await expect(page.getByLabel('Initiative tracker')).toContainText('Arcanist');
  await page.getByRole('button', { name: 'Start encounter' }).click();
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.find((command) => command.type === 'initiative.start'))).toMatchObject({
    type: 'initiative.start', message: { payload: { expectedInitiativeRevision: 0 } },
  });
});

test('camera modes preserve token selection without mutating the scene', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, true, false);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  const tactical = camera.getByRole('button', { name: 'Tactical', exact: true });
  const overview = camera.getByRole('button', { name: 'Overview', exact: true });
  const follow = camera.getByRole('button', { name: 'Follow', exact: true });
  const inspector = page.locator('.inspector');
  const orbitControlLabels = ['Orbit left', 'Orbit right', 'Tilt up', 'Tilt down', 'Zoom in', 'Zoom out'];
  const readCameraProbe = () => page.evaluate(() => (window as Window & { __HEARTH_E2E__?: { camera?: CameraProbeSnapshot } }).__HEARTH_E2E__?.camera);

  await expect.poll(async () => (await readCameraProbe())?.mode).toBe('tactical');
  const originalTactical = await readCameraProbe();
  expect(originalTactical).toMatchObject({ mode: 'tactical', isCanvasCamera: true, camera: { type: 'OrthographicCamera', projection: 'orthographic' } });
  expect(originalTactical?.camera.zoom).toEqual(expect.any(Number));
  expect(originalTactical?.camera.left).toEqual(expect.any(Number));
  expect(originalTactical?.camera.right).toEqual(expect.any(Number));
  expect(originalTactical?.camera.top).toEqual(expect.any(Number));
  expect(originalTactical?.camera.bottom).toEqual(expect.any(Number));
  expect((originalTactical?.camera.right ?? 0) - (originalTactical?.camera.left ?? 0)).toBeGreaterThan(100);
  expect((originalTactical?.camera.top ?? 0) - (originalTactical?.camera.bottom ?? 0)).toBeGreaterThan(100);

  await expect(tactical).toHaveAttribute('aria-pressed', 'true');
  await expect(overview).toHaveAttribute('aria-pressed', 'false');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  for (const label of orbitControlLabels) await expect(camera.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await expect(page.locator('.table-stage canvas')).toBeVisible();

  await page.getByLabel('Initiative tracker').getByRole('button', { name: '01 Vanguard', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await expect(inspector.getByLabel('Label')).toHaveValue('Vanguard');

  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const commandsBeforeCameraSwitch = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);

  await overview.click();
  await expect(overview).toHaveAttribute('aria-pressed', 'true');
  await expect(tactical).toHaveAttribute('aria-pressed', 'false');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await readCameraProbe())?.mode).toBe('overview');
  const overviewProbe = await readCameraProbe();
  expect(overviewProbe).toMatchObject({ mode: 'overview', isCanvasCamera: false, camera: { type: 'PerspectiveCamera', projection: 'perspective' } });
  await expect(page.locator('.table-stage')).toHaveClass(/is-perspective/);
  for (const label of orbitControlLabels) await expect(camera.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(page.locator('.tactical-overlay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await expect(inspector.getByLabel('Label')).toHaveValue('Vanguard');

  await tactical.click();
  await expect(tactical).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await readCameraProbe())?.mode).toBe('tactical');
  const restoredTactical = await readCameraProbe();
  expect(restoredTactical).toMatchObject({ mode: 'tactical', isCanvasCamera: true, camera: { type: 'OrthographicCamera', projection: 'orthographic' } });
  expect(restoredTactical?.camera.zoom).toBe(originalTactical?.camera.zoom);
  expect(restoredTactical?.camera.left).toBe(originalTactical?.camera.left);
  expect(restoredTactical?.camera.right).toBe(originalTactical?.camera.right);
  expect(restoredTactical?.camera.top).toBe(originalTactical?.camera.top);
  expect(restoredTactical?.camera.bottom).toBe(originalTactical?.camera.bottom);
  expect((restoredTactical?.camera.right ?? 0) - (restoredTactical?.camera.left ?? 0)).toBeGreaterThan(100);
  expect((restoredTactical?.camera.top ?? 0) - (restoredTactical?.camera.bottom ?? 0)).toBeGreaterThan(100);
  await expect(page.locator('.table-stage canvas')).toBeVisible();
  for (const label of orbitControlLabels) await expect(camera.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();

  await overview.click();
  await expect.poll(async () => (await readCameraProbe())?.mode).toBe('overview');

  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await expect(tactical).toHaveAttribute('aria-pressed', 'false');
  await expect(overview).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await readCameraProbe())?.mode).toBe('follow');
  const followProbe = await readCameraProbe();
  expect(followProbe).toMatchObject({ mode: 'follow', isCanvasCamera: false, camera: { type: 'PerspectiveCamera', projection: 'perspective' } });
  for (const label of orbitControlLabels) await expect(camera.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(page.locator('.tactical-overlay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await expect(inspector.getByLabel('Label')).toHaveValue('Vanguard');

  const orbitBeforeActions = (await readCameraProbe())!.orbit!;
  const orbitLeft = camera.getByRole('button', { name: 'Orbit left', exact: true });
  await orbitLeft.click();
  await expect.poll(async () => (await readCameraProbe())?.orbit?.yaw).not.toBe(orbitBeforeActions.yaw);
  const orbitAfterFirstAction = (await readCameraProbe())!.orbit!;
  await orbitLeft.click();
  await expect.poll(async () => (await readCameraProbe())?.orbit?.yaw).not.toBe(orbitAfterFirstAction.yaw);
  const orbitAfterSecondAction = (await readCameraProbe())!.orbit!;
  expect(orbitAfterSecondAction.yaw - orbitAfterFirstAction.yaw).toBeCloseTo(orbitAfterFirstAction.yaw - orbitBeforeActions.yaw, 8);
  const sequenceBeforeSelection = (await readCameraProbe())!.sequence;

  await page.getByLabel('Initiative tracker').getByRole('button', { name: '02 Arcanist', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Arcanist', exact: true })).toBeVisible();
  await expect.poll(async () => (await readCameraProbe())?.sequence).toBeGreaterThan(sequenceBeforeSelection);
  expect((await readCameraProbe())?.orbit).toEqual(orbitAfterSecondAction);

  const commandsAfterCameraSwitch = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commandsAfterCameraSwitch).toEqual(commandsBeforeCameraSwitch);
});

test('players without perspective permission stay in tactical view', async ({ page }) => {
  const state = await mockBackend(page, { role: 'player', joined: true });
  await mockTacticalBoundary(page, state);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  await expect(camera.getByRole('button', { name: 'Tactical', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(camera.getByRole('button', { name: 'Overview', exact: true })).toHaveCount(0);
  await expect(camera.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0);
  await expect(camera.getByText('3D view unavailable', { exact: true })).toBeVisible();
  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands.filter((type) => type.startsWith('camera.') || type.startsWith('token.transform.'))).toEqual([]);
});

test('DM can change player perspective policy with the exact command payload only', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  await camera.getByRole('button', { name: 'Allow player 3D', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'permissions.playerPerspectiveView.set')).toMatchObject({
    type: 'permissions.playerPerspectiveView.set',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { enabled: true } },
  });
  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands).toEqual(['permissions.playerPerspectiveView.set']);
});

test('players with perspective permission can use overview and follow with public presentation affordances', async ({ page }) => {
  const state = await mockBackend(page, { role: 'player', joined: true });
  await mockTacticalBoundary(page, state, 0, true, false, 0, 0, true, false, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  const inspector = page.locator('.inspector');
  await page.getByLabel('Initiative tracker').getByRole('button', { name: '01 Vanguard', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await camera.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(camera.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.table-stage')).toHaveClass(/is-perspective/);
  await expect(camera.getByRole('button', { name: 'Cutaway', exact: true })).toBeVisible();
  await camera.getByRole('button', { name: 'Cutaway', exact: true }).click();
  await expect(camera.getByRole('button', { name: 'Exterior', exact: true })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await camera.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(camera.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(camera.getByRole('button', { name: 'Cutaway', exact: true })).toHaveCount(0);
  await expect(camera.getByRole('button', { name: 'Exterior', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands.filter((type) => type.startsWith('camera.') || type.startsWith('token.transform.'))).toEqual([]);
});

test('published perspective revocation returns players to tactical view and retains selection', async ({ page }) => {
  const state = await mockBackend(page, { role: 'player', joined: true });
  await mockTacticalBoundary(page, state, 0, true, false, 0, 0, true, false, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  const inspector = page.locator('.inspector');
  await page.getByLabel('Initiative tracker').getByRole('button', { name: '01 Vanguard', exact: true }).click();
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  await camera.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.table-stage')).toHaveClass(/is-perspective/);
  await page.evaluate(() => {
    const harness = window.__HEARTH_E2E__;
    if (!harness?.publishProjection) throw new Error('E2E snapshot publisher is unavailable.');
    const replacement = JSON.parse(JSON.stringify(harness.projection));
    replacement.controls.perspective.enabled = false;
    replacement.projectionRevision = 1;
    replacement.sceneRevision = 1;
    delete replacement.streamReset;
    harness.publishProjection?.(replacement);
  });
  await expect(camera.getByRole('button', { name: 'Tactical', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('3D view access was turned off. Tactical view is active.', { exact: true })).toBeVisible();
  await expect(camera.getByRole('button', { name: 'Overview', exact: true })).toHaveCount(0);
  await expect(camera.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'Vanguard', exact: true })).toBeVisible();
  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands.filter((type) => type.startsWith('camera.') || type.startsWith('token.transform.'))).toEqual([]);
});

test('perspective camera and policy controls are reachable in portrait and landscape without overflow', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, false, false, true);
  for (const [index, viewport] of [{ width: 390, height: 844 }, { width: 844, height: 390 }].entries()) {
    await page.setViewportSize(viewport);
    await page.goto(`/rooms/${roomId}/table`);
    if (index === 0) await signIn(page);
    const camera = page.getByRole('toolbar', { name: 'Camera mode' });
    const overview = camera.getByRole('button', { name: 'Overview', exact: true });
    const policy = camera.getByRole('button', { name: 'Players can view 3D', exact: true });
    await expect(camera).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Tactical', exact: true })).toBeVisible();
    await expect(overview).toBeVisible();
    await expect(policy).toBeVisible();
    await overview.scrollIntoViewIfNeeded();
    await policy.scrollIntoViewIfNeeded();
    await overview.click();
    await expect(overview).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('DM can create walls and roofs with complete revision-aware commands', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const camera = page.getByRole('toolbar', { name: 'Camera mode' });
  await expect(camera.getByRole('button', { name: 'Tactical', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const tools = page.getByRole('toolbar', { name: 'DM geometry tools' });
  const stage = page.locator('.table-stage canvas');
  await expect(tools).toBeVisible();

  const wallButton = tools.getByRole('button', { name: 'Wall', exact: true });
  await wallButton.click();
  await expect(wallButton).toHaveAttribute('aria-pressed', 'true');
  await stage.click({ position: { x: 320, y: 220 } });
  await expect(page.locator('.wall-draft')).toBeVisible();
  await stage.click({ position: { x: 470, y: 320 } });
  await expect.poll(() => capturedCommand(page, 'wall.create')).toMatchObject({
    type: 'wall.create',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { expectedWallRevision: 0, wall: {
      id: expect.any(String), type: 'blocking', start: { x: expect.any(Number), y: expect.any(Number) }, end: { x: expect.any(Number), y: expect.any(Number) },
      height: expect.any(Number), thickness: expect.any(Number), elevation: 0, material: 'default', openings: [],
    } } },
  });
  const wallCreate = await capturedCommand(page, 'wall.create') as { message: { payload: { wall: Record<string, unknown> } } };
  expect(Object.keys(wallCreate.message.payload.wall).sort()).toEqual(['end', 'elevation', 'height', 'id', 'material', 'openings', 'start', 'thickness', 'type'].sort());
  await expect(wallButton).toHaveAttribute('aria-pressed', 'false');

  const roofButton = tools.getByRole('button', { name: 'Roof', exact: true });
  await roofButton.click();
  await expect(roofButton).toHaveAttribute('aria-pressed', 'true');
  await stage.click({ position: { x: 600, y: 180 } });
  await expect.poll(() => capturedCommand(page, 'structure.create')).toMatchObject({
    type: 'structure.create',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { expectedStructureRevision: 0, structure: {
      id: expect.any(String), kind: 'roof', position: { x: expect.any(Number), y: expect.any(Number) }, size: { width: 100, height: 100 }, rotation: 0,
      label: 'Roof', z: 0, material: 'default', baseElevation: 0, slabHeight: 8,
    } } },
  });
  const structureCreate = await capturedCommand(page, 'structure.create') as { message: { payload: { structure: Record<string, unknown> } } };
  expect(Object.keys(structureCreate.message.payload.structure).sort()).toEqual(['baseElevation', 'id', 'kind', 'label', 'material', 'position', 'rotation', 'size', 'slabHeight', 'z'].sort());

  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands).toEqual(['wall.create', 'structure.create']);
});

test('DM can edit and delete seeded walls and structures with revision-aware envelopes', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  const editor = page.getByRole('region', { name: 'DM geometry editor' });
  await page.locator('.wall-editor-line').first().click({ force: true });
  await expect(editor).toContainText('Editing wall seed-wall');
  await editor.getByLabel('Material').selectOption('metal');
  await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'wall.update')).toMatchObject({
    type: 'wall.update',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { expectedWallRevision: 7, expectedRecordRevision: 3, wall: {
      id: 'seed-wall', type: 'blocking', start: { x: 500, y: 400 }, end: { x: 700, y: 400 }, height: 100, thickness: 8, elevation: 0,
      material: 'metal', openings: [],
    } } },
  });
  const wallUpdate = await capturedCommand(page, 'wall.update') as { message: { payload: { wall: Record<string, unknown> } } };
  expect(Object.keys(wallUpdate.message.payload.wall).sort()).toEqual(['end', 'elevation', 'height', 'id', 'material', 'openings', 'start', 'thickness', 'type'].sort());
  await editor.getByRole('button', { name: 'Delete wall', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'wall.delete')).toMatchObject({
    type: 'wall.delete',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { wallId: 'seed-wall', expectedWallRevision: 7, expectedRecordRevision: 3 } },
  });
  await expect(editor).toHaveCount(0);

  await page.getByRole('button', { name: 'Select floor Courtyard floor', exact: true }).click();
  await expect(editor).toContainText('Editing structure seed-structure');
  await editor.getByLabel('Material').selectOption('metal');
  await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'structure.update')).toMatchObject({
    type: 'structure.update',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { expectedStructureRevision: 5, expectedRecordRevision: 4, structure: {
      id: 'seed-structure', kind: 'floor', position: { x: 1100, y: 700 }, size: { width: 100, height: 100 }, rotation: 0,
      label: 'Courtyard floor', z: 0, material: 'metal', baseElevation: 0, slabHeight: 8,
    } } },
  });
  const structureUpdate = await capturedCommand(page, 'structure.update') as { message: { payload: { structure: Record<string, unknown> } } };
  expect(Object.keys(structureUpdate.message.payload.structure).sort()).toEqual(['baseElevation', 'id', 'kind', 'label', 'material', 'position', 'rotation', 'size', 'slabHeight', 'z'].sort());
  await editor.getByRole('button', { name: 'Delete structure', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'structure.delete')).toMatchObject({
    type: 'structure.delete',
    message: { commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), payload: { structureId: 'seed-structure', expectedStructureRevision: 5, expectedRecordRevision: 4 } },
  });
  await expect(editor).toHaveCount(0);

  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands).toEqual(['wall.update', 'wall.delete', 'structure.update', 'structure.delete']);
});

test('DM wall inspector preserves a canonical positive window opening', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  await page.locator('.wall-editor-line').first().click({ force: true });
  const editor = page.getByRole('region', { name: 'DM geometry editor' });
  await expect(editor).toContainText('Editing wall seed-wall');
  await editor.getByLabel('Start', { exact: true }).fill('0.2');
  await editor.getByLabel('End', { exact: true }).fill('0.6');
  await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(() => capturedCommand(page, 'wall.update')).toMatchObject({
    type: 'wall.update',
    message: { payload: { expectedWallRevision: 7, expectedRecordRevision: 3, wall: {
      id: 'seed-wall', type: 'blocking', start: { x: 500, y: 400 }, end: { x: 700, y: 400 }, height: 100, thickness: 8, elevation: 0,
      material: 'masonry', openings: [{ type: 'window', start: 0.2, end: 0.6, bottom: expect.any(Number), height: expect.any(Number) }],
    } } },
  });
  const command = await capturedCommand(page, 'wall.update') as { message: { payload: { wall: { revision?: number; openings: Array<{ type: string; start: number; end: number; bottom: number; height: number }> } } } };
  const wall = command.message.payload.wall;
  expect(wall.revision).toBeUndefined();
  expect(wall.openings).toHaveLength(1);
  expect(wall.openings[0]).toEqual(expect.objectContaining({ type: 'window', start: 0.2, end: 0.6 }));
  expect(wall.openings[0]!.bottom).toBeGreaterThan(0);
  expect(wall.openings[0]!.height).toBeGreaterThan(0);
});

test('DM wall endpoint cancellation discards local preview without committing', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  await page.locator('.wall-editor-line').first().click({ force: true });
  const editor = page.getByRole('region', { name: 'DM geometry editor' });
  const endpoint = page.getByRole('button', { name: 'Drag start endpoint' });
  await expect(endpoint).toBeVisible();
  const originalX = await endpoint.getAttribute('cx');
  const originalY = await endpoint.getAttribute('cy');
  const bounds = await endpoint.boundingBox();
  if (!bounds) throw new Error('Wall endpoint bounds are unavailable.');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 120, bounds.y + bounds.height / 2 + 60);
  await expect.poll(() => endpoint.getAttribute('cx')).not.toBe(originalX);
  await endpoint.dispatchEvent('pointercancel', { bubbles: true, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await expect.poll(() => endpoint.getAttribute('cx')).toBe(originalX);
  await expect.poll(() => endpoint.getAttribute('cy')).toBe(originalY);
  await expect.poll(() => capturedCommand(page, 'wall.update')).toBeUndefined();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Apply changes', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Delete wall', exact: true })).toBeVisible();
});

test('non-DMs cannot see or use DM geometry editing controls', async ({ page }) => {
  const state = await mockBackend(page, { role: 'player', joined: true });
  await mockTacticalBoundary(page, state, 0, false, true, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);

  await expect(page.getByRole('toolbar', { name: 'DM geometry tools' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Wall', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Block', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Floor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Roof', exact: true })).toHaveCount(0);
  await expect(page.locator('.tactical-editor-overlay')).toHaveCount(0);
  const commands = await page.evaluate(() => window.__HEARTH_E2E__?.commands.map((command) => command.type) ?? []);
  expect(commands.filter((type) => type.startsWith('wall.') || type.startsWith('structure.') || type.startsWith('token.transform.') || type.startsWith('camera.'))).toEqual([]);
});

test('DM fog tools render the mask and commit rectangle geometry', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.locator('.table-stage canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal box' }).click();
  const canvas = page.locator('.table-stage canvas');
  await canvas.click({ position: { x: 300, y: 180 } });
  await canvas.click({ position: { x: 480, y: 340 } });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.find((command) => command.type === 'fog.operation.commit'))).toMatchObject({
    type: 'fog.operation.commit', message: { payload: { operation: { kind: 'reveal', points: [{}, {}, {}, {}] }, expectedFogRevision: 0 } },
  });
});

test('drawing, ruler, and ping tools use their durable and ephemeral channels', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  const canvas = page.locator('.table-stage canvas');
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await canvas.click({ position: { x: 320, y: 220 } });
  await canvas.click({ position: { x: 470, y: 320 } });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.find((command) => command.type === 'drawing.create'))).toMatchObject({
    type: 'drawing.create', message: { payload: { drawing: { kind: 'line' }, expectedDrawingRevision: 0 } },
  });
  await page.getByRole('button', { name: 'Ruler', exact: true }).click();
  await canvas.click({ position: { x: 320, y: 220 } });
  await canvas.click({ position: { x: 420, y: 320 } });
  await expect(page.locator('.ruler-layer')).toBeVisible();
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  await canvas.click({ position: { x: 380, y: 260 } });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.find((command) => command.type === 'map.ping'))).toMatchObject({
    type: 'map.ping', message: { position: {} },
  });
});

test('tactical table has no horizontal overflow on mobile', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.getByText('No map set')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByLabel('Encounter assets')).toHaveCSS('flex-direction', 'row');
});

test('development placeholders use the authorized asset and room command flow', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.getByRole('button', { name: 'Load development set' }).click();
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.filter((command) => command.type === 'asset.reserve').length), { timeout: 15_000 }).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.filter((command) => command.type === 'token.create').length), { timeout: 15_000 }).toBe(3);
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'map.set'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'grid.set'))).toBe(true);
});

test('tactical commands stay disabled until the multiplayer room is connected', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 1_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  const developmentSet = page.getByRole('button', { name: 'Load development set' });
  await expect(developmentSet).toBeDisabled();
  expect(await developmentSet.evaluate((element) => getComputedStyle(element).cursor)).toBe('not-allowed');
  await expect(developmentSet).toBeEnabled({ timeout: 5_000 });
  expect(errors).toEqual([]);
});

test('failed multiplayer connection shows a retry and recovers', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 1);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.getByRole('alert')).toContainText('Multiplayer service is unavailable.');
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'online' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load development set' })).toBeEnabled();
});

test('asset processing has explicit busy feedback', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false, 0, 500);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.locator('.upload-button input').setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from('token') });
  await expect(page.getByText('Token: processing')).toBeVisible();
  await expect(page.locator('.asset-actions')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.map-upload input')).toBeDisabled();
  await expect(page.locator('.asset-actions')).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
  await expect(page.getByText('Token: processing')).toHaveCount(0);
});

test('restricted empty sight remains fail-closed', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, true, false, 0, 0, true, false, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  for (const mode of ['tactical', 'overview', 'follow'] as const) {
    if (mode !== 'tactical') await page.getByRole('button', { name: mode[0]!.toUpperCase() + mode.slice(1), exact: true }).click();
    if (mode === 'tactical') {
      await page.getByRole('button', { name: 'Line', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    if (mode === 'tactical') {
      await page.locator('.wall-editor-line').first().click({ force: true });
      await expect(page.getByRole('region', { name: 'DM geometry editor' })).toBeVisible();
    }
    await expect(page.locator('.table-stage')).toHaveClass(mode === 'tactical' ? /(?<!is-perspective)/ : /is-perspective/);
    await page.evaluate(() => {
      const harness = window.__HEARTH_E2E__!;
      const replacement = JSON.parse(JSON.stringify(harness.projection)) as typeof harness.projection;
      replacement.sight = { mode: 'restricted', polygons: [] };
      replacement.projectionRevision += 1;
      replacement.sceneRevision += 1;
      delete replacement.streamReset;
      harness.publishProjection?.(replacement);
    });
    const overlay = page.locator('.concealment-surface');
    await expect(overlay).toBeVisible();
    const shellBox = await page.locator('.tactical-shell').boundingBox();
    const overlayBox = await overlay.boundingBox();
    expect(shellBox).not.toBeNull();
    expect(overlayBox).toMatchObject({ x: shellBox!.x, y: shellBox!.y, width: shellBox!.width, height: shellBox!.height });
    const coveredSamples = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('.tactical-shell');
      const box = shell?.getBoundingClientRect();
      if (!box) return [];
      return [
        [box.left + 1, box.top + 1], [box.right - 1, box.top + 1],
        [box.left + 1, box.bottom - 1], [box.right - 1, box.bottom - 1],
        [box.left + box.width / 2, box.top + box.height / 2],
      ].map(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element?.closest('.tactical-shell') !== null;
      });
    });
    expect(coveredSamples).toEqual([true, true, true, true, true]);
    await expect(overlay).toHaveAttribute('data-sight-mode', 'restricted');
    await expect(overlay).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('.tactical-overlay')).toHaveCount(0);
    await expect(overlay).toHaveCSS('opacity', '1');
    await expect(page.locator('.table-stage canvas')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'DM geometry editor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveCount(0);
    const commandsBeforeHiddenClick = await page.evaluate(() => window.__HEARTH_E2E__?.commands.length ?? 0);
    await page.locator('.table-stage').click({ position: { x: 240, y: 160 }, force: true });
    await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.length ?? 0)).toBe(commandsBeforeHiddenClick);
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0);
    if (mode !== 'follow') await expect(page.locator('.table-stage')).toHaveClass(/is-restricted/);
    if (mode !== 'follow') await page.reload();
    if (mode !== 'follow') await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  }
});

test('fog-only projections fail closed for empty and non-empty regions, while disabled fog stays unrestricted', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, false, false);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  const polygons: Array<Array<{ points: Array<{ x: number; y: number }> }>> = [[], [{ points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }] }]];
  for (const mode of ['visible-regions', 'concealed-regions'] as const) {
    for (const regions of polygons) {
      await page.evaluate(({ mode, regions }) => {
        const harness = window.__HEARTH_E2E__!;
        const replacement = JSON.parse(JSON.stringify(harness.projection)) as typeof harness.projection;
        replacement.fog = { mode, polygons: regions };
        replacement.projectionRevision += 1;
        replacement.sceneRevision += 1;
        delete replacement.streamReset;
        harness.publishProjection?.(replacement);
      }, { mode, regions });
      await expect(page.locator('.concealment-surface')).toBeVisible();
      await expect(page.locator('.table-stage canvas')).toHaveCount(0);
    }
  }
  await page.evaluate(() => {
    const harness = window.__HEARTH_E2E__!;
    const replacement = JSON.parse(JSON.stringify(harness.projection)) as typeof harness.projection;
    replacement.fog = { mode: 'disabled' };
    replacement.sight = { mode: 'unrestricted' };
    replacement.projectionRevision += 1;
    replacement.sceneRevision += 1;
    delete replacement.streamReset;
    harness.publishProjection?.(replacement);
  });
  await expect(page.locator('.concealment-surface')).toHaveCount(0);
  await expect(page.locator('.table-stage canvas')).toBeVisible();
});

test('projection stream reset clears tactical local state', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state, 0, true, false, 0, 0, true);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await page.waitForFunction(() => typeof window.__HEARTH_E2E__?.publishProjection === 'function');
  await page.getByLabel('Initiative tracker').getByRole('button', { name: '01 Vanguard', exact: true }).click();
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Ping', exact: true }).click();
  await page.locator('.table-stage canvas').click({ position: { x: 260, y: 180 } });
  await page.locator('.wall-editor-line').first().click({ force: true });
  await expect(page.getByRole('region', { name: 'DM geometry editor' })).toBeVisible();
  await page.evaluate(() => {
    const harness = window.__HEARTH_E2E__!;
    const replacement = JSON.parse(JSON.stringify(harness.projection));
    replacement.streamId = '00000000-0000-4000-8000-000000000098';
    replacement.projectionRevision = 0;
    replacement.sceneRevision = 0;
    replacement.streamReset = { kind: 'initial' };
    harness.publishProjection?.(replacement);
  });
  await expect(page.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Ping', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'DM geometry editor' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Vanguard', exact: true })).toHaveCount(0);
  await expect(page.locator('.wall-editor-line')).toHaveCount(1);
});
