import { expect, test, type Page } from '@playwright/test';

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

async function mockBackend(page: Page, { role = 'dm', joined = false, failFirstCreation = false }: { role?: 'dm' | 'player'; joined?: boolean; failFirstCreation?: boolean } = {}) {
  const state = { joined, createCalls: [] as Record<string, string>[], signupRedirect: '', assets: [] as Array<Record<string, unknown>> };
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

async function mockTacticalBoundary(page: Page, state: Awaited<ReturnType<typeof mockBackend>>) {
  await page.addInitScript(() => {
    window.__HEARTH_E2E__ = { commands: [], scene: {
      version: 2, coordinateSystem: { origin: 'top-left', axes: 'x-right-y-down', worldUnit: 'map-pixel' }, map: null,
      grid: { type: 'square', visible: true, cellSize: 50, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft', snap: true },
      permissions: { playerMovement: 'owned' }, tokens: {}, walls: {}, fog: { version: 1, mode: 'shared', operations: [] },
      initiative: { version: 1, active: false, round: 0, turnIndex: null, entries: [] }, drawings: {}, structures: {}, lights: {}, effects: {}, extensions: {},
    } };
  });
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
      state.assets = [{ id: assetId, room_id: roomId, created_by: userId, kind, status: 'ready', width: kind === 'map' ? 512 : 256, height: kind === 'map' ? 512 : 256, updated_at: timestamp }];
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
  await mockTacticalBoundary(page, state);
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.getByText('Tactical table', { exact: true })).toBeVisible();
  await page.getByLabel('Cell size').fill('64');
  await page.getByRole('button', { name: 'Save grid' }).click();
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'grid.set'))).toBe(true);

  await page.locator('.map-upload input').setInputFiles({ name: 'keep.png', mimeType: 'image/png', buffer: Buffer.from('map') });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'map.set'))).toBe(true);
  state.assets = [];
  await page.locator('.upload-button input').setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from('token') });
  await expect(page.getByRole('button', { name: 'Place token image' })).toBeVisible();
  await page.getByRole('button', { name: 'Place token image' }).click();
  await page.locator('.table-stage canvas').click({ position: { x: 300, y: 220 } });
  await expect.poll(() => page.evaluate(() => window.__HEARTH_E2E__?.commands.some((command) => command.type === 'token.create'))).toBe(true);
});

test('tactical table has no horizontal overflow on mobile', async ({ page }) => {
  const state = await mockBackend(page, { joined: true });
  await mockTacticalBoundary(page, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rooms/${roomId}/table`);
  await signIn(page);
  await expect(page.getByText('No map set')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
