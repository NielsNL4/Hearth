import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ellipsePolygon, measureGridDistance, rectanglePolygon, screenToWorld, simplifyPolyline, snapPointToCellCenter, zoomViewAtScreenPoint, type DiagonalDistanceRule, type Point } from '@hearth/scene';
import { structureCreateCommandSchema, type ActorProjectionV1, type MultiplayerCommand } from '@hearth/domain';
import type { input as ZodInput } from 'zod';
import { createMultiplayerConnection, getConnectedUserIds, type ColyseusClientLike, type ColyseusRoomLike, type ConnectionStatus, type MapPingEvent, type MultiplayerConnection, type RoomAssetSummary } from '@hearth/sync';
import { useSession } from '../auth/AuthProvider';
import { errorMessage, rooms } from '../lib/client';
import { getDownloadUrls, getManifest, uploadAsset, waitForManifest, type AssetManifest, type AssetReservation } from '../lib/assets';
import { TacticalRenderer, type DrawingDraft, type FogDraft, type RulerDraft, type ViewState } from '../components/TacticalRenderer';
import { Notice } from '../components/UI';
import { loadDevelopmentFixtures } from '../lib/developmentFixtures';
import type { CameraMode } from '../lib/camera';
import type { CameraOrbitAction, CameraProbe } from '../components/tactical/CameraController';
import { TacticalEditorOverlay, type WallEndpointDraft } from '../components/tactical/TacticalEditorOverlay';
import { TacticalEditorPanel, type StructureEditValues, type WallEditValues } from '../components/tactical/TacticalEditorPanel';
import type { StructurePresentation } from '../components/tactical/StructureMeshes';
import { emptyTacticalProjectionModel, projectionIsRestricted, projectionToTacticalModel, type TacticalProjectionModel, type ProjectionStructure as StructureRecord, type ProjectionToken as TokenRecord, type ProjectionWall as WallRecord } from '../lib/projectionModel';
type LoadedAsset = RoomAssetSummary & { manifest?: AssetManifest; urls: Record<string, string>; urlsExpireAt: number };
type FogTool = { kind: 'reveal' | 'conceal'; shape: 'rectangle' | 'polygon' };
type DrawingTool = 'line' | 'rectangle' | 'ellipse' | 'polygon' | 'path';
type AssetTask = {
  kind: 'token' | 'map' | 'development';
  phase: 'preparing' | 'uploading' | 'processing';
  progress?: number;
  item?: number;
  total?: number;
};
const id = () => crypto.randomUUID();

function withoutRevision<T extends { revision: number }>(record: T): Omit<T, 'revision'> {
  const { revision: _revision, ...input } = record;
  return input;
}

type WallCreatePayload = MultiplayerCommand<'wall.create'>['payload'];
type StructureCreatePayload = ZodInput<typeof structureCreateCommandSchema>['payload'];

function wallInput(wall: WallRecord): WallCreatePayload['wall'] {
  const base = { id: wall.wallId, start: wall.start, end: wall.end, height: wall.height, thickness: wall.thickness,
    elevation: wall.elevation, material: wall.material, openings: wall.openings.map((opening) => ({ ...opening, type: 'window' as const })) };
  return wall.wallKind === 'door' ? { ...base, type: 'door', doorState: wall.doorState ?? 'closed' } : { ...base, type: wall.wallKind };
}
function structureInput(structure: StructureRecord): StructureCreatePayload['structure'] {
  return { id: structure.structureId, kind: structure.structureKind, position: structure.position, size: structure.size, rotation: structure.rotation,
    label: structure.label, z: structure.z, material: structure.material, baseElevation: structure.baseElevation, slabHeight: structure.slabHeight };
}
function hitProjectedWall(point: Point, walls: WallRecord[], tolerance: number): WallRecord | undefined {
  return walls.find((wall) => {
    const dx = wall.end.x - wall.start.x; const dy = wall.end.y - wall.start.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / lengthSquared)) : 0;
    return Math.hypot(point.x - (wall.start.x + ratio * dx), point.y - (wall.start.y + ratio * dy)) <= tolerance;
  });
}

declare global {
  interface Window { __HEARTH_E2E__?: { projection: ActorProjectionV1; commands: Array<{ type: string; message: unknown }>; camera?: CameraProbe; connectDelayMs?: number; connectFailures?: number; publishProjection?: (projection: ActorProjectionV1) => void } }
}

function e2eClient(): ColyseusClientLike | undefined {
  const harness = import.meta.env.DEV ? window.__HEARTH_E2E__ : undefined;
  if (!harness) return undefined;
  let reservationSequence = 0;
  return {
    async joinOrCreate() {
      if (harness.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, harness.connectDelayMs));
      if (harness.connectFailures) { harness.connectFailures--; throw new Error('Multiplayer service is unavailable.'); }
      const listeners = new Map<string | number, (message: unknown) => void>();
      let projectionListeners = new Set<(projection: ActorProjectionV1) => void>();
      let room: ColyseusRoomLike;
      const publishProjection = (snapshot: ActorProjectionV1) => {
        harness.projection = snapshot;

        listeners.get('scene.projection.v1')?.(snapshot);
      };
      room = {
        state: { connections: new Map() } as ColyseusRoomLike['state'], reconnectionToken: 'e2e-reconnection', send(type, message) {
          harness.commands.push({ type, message });
          const command = message as { commandId?: string; payload?: { kind?: string } };
          if (command.commandId) queueMicrotask(() => listeners.get('command.result')?.({ type, commandId: command.commandId, ok: true, sceneRevision: 1,
            result: type === 'asset.reserve' ? { id: `00000000-0000-4000-8000-${String(100 + ++reservationSequence).padStart(12, '0')}`, roomId: 'e2e', status: 'reserved' } : undefined }));
        }, leave() { projectionListeners.clear(); listeners.clear(); if (harness.publishProjection === publishProjection) delete harness.publishProjection; }, onStateChange() { return () => undefined; }, onMessage(type, callback) { listeners.set(type, callback); if (type === 'scene.projection.v1') { queueMicrotask(() => (callback as (value: unknown) => void)(harness.projection)); } }, onLeave() {}, onError() {},
      };
      harness.publishProjection = publishProjection;

      return room;
    },
    async reconnect() { throw new Error('No E2E reconnection'); },
  };
}

export function TacticalTable() {
  const { roomId = '' } = useParams();
  const session = useSession()!;
  const connection = useRef<MultiplayerConnection | undefined>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const previewAt = useRef(0);
  const previewSequence = useRef(0);
  const freehandActive = useRef(false);
  const freehandPoints = useRef<Point[]>([]);
  const [scene, setScene] = useState<TacticalProjectionModel>(emptyTacticalProjectionModel);
  const [members, setMembers] = useState<Awaited<ReturnType<NonNullable<typeof rooms>['getLobby']>>['members']>([]);
  const [assets, setAssets] = useState<Record<string, LoadedAsset>>({});
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [reconnectKey, setReconnectKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [assetTask, setAssetTask] = useState<AssetTask>();
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [selectedToken, setSelectedToken] = useState<string>();
  const [fogTool, setFogTool] = useState<FogTool>();
  const [fogPoints, setFogPoints] = useState<Point[]>([]);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>();
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);
  const [drawingColor, setDrawingColor] = useState('#e7ca8b');
  const [drawingWidth, setDrawingWidth] = useState(4);
  const [rulerRule, setRulerRule] = useState<DiagonalDistanceRule>('five-ten-five');
  const [rulerPoints, setRulerPoints] = useState<Point[]>([]);
  const [rulerTool, setRulerTool] = useState(false);
  const [pingTool, setPingTool] = useState(false);
  const [pings, setPings] = useState<MapPingEvent[]>([]);
  const [view, setView] = useState<ViewState>({ x: 1000, y: 600, zoom: 0.5 });
  const [viewport, setViewport] = useState({ width: 900, height: 600 });
  const [cameraMode, setCameraMode] = useState<CameraMode>('tactical');
  const [presentationMode, setPresentationMode] = useState<StructurePresentation>('exterior');
  const [orbitAction, setOrbitAction] = useState<CameraOrbitAction>();
  const cameraActionId = useRef(0);
  const [wallTool, setWallTool] = useState(false);
  const [wallDraft, setWallDraft] = useState<{ start: Point; end?: Point; snapped?: boolean }>();
  const [selectedWallId, setSelectedWallId] = useState<string>();
  const [selectedStructureId, setSelectedStructureId] = useState<string>();
  const [structureTool, setStructureTool] = useState<StructureRecord['structureKind']>();
  const [endpointDraft, setEndpointDraft] = useState<WallEndpointDraft>();

  const token = selectedToken ? scene.tokens[selectedToken] : undefined;
  const tokenControl = token ? scene.controls.tokens.records.find((record) => record.tokenId === token.id) : undefined;
  const canUsePerspective = scene.controls.perspective.canUse && (scene.controls.perspective.enabled || scene.controls.perspective.canSet);
  const selectedWall = selectedWallId ? scene.walls[selectedWallId] : undefined;
  const selectedStructure = selectedStructureId ? scene.structures[selectedStructureId] : undefined;

  function clearProjectionLocalState() {
    setSelectedToken(undefined); setSelectedAsset(undefined);
    setFogTool(undefined); setFogPoints([]); setDrawingTool(undefined); setDrawingPoints([]);
    setRulerTool(false); setRulerPoints([]); setPingTool(false); setPings([]);
    setWallTool(false); setStructureTool(undefined); setWallDraft(undefined); setEndpointDraft(undefined);
    setSelectedWallId(undefined); setSelectedStructureId(undefined);
    setOrbitAction(undefined); setCameraMode('tactical'); setPresentationMode('exterior');
    setView({ x: 1000, y: 600, zoom: 0.5 });
    previewSequence.current = 0; previewAt.current = 0; freehandActive.current = false; freehandPoints.current = [];
  }

  async function refreshAssets() {
    const rows = await rooms!.listRoomAssets(roomId);
    const ready = rows.filter((asset) => asset.status === 'ready');
    const loaded = await Promise.all(ready.map(async (asset) => {
      const prior = assets[asset.id];
      const manifest = prior?.manifest ?? await getManifest(session, asset.id);
      const thumbnail = manifest.outputs.find((output) => output.type === 'thumbnail' || output.type === 'image');
      let urls = prior?.urls ?? {};
      let urlsExpireAt = prior?.urlsExpireAt ?? 0;
      if (thumbnail && (!urls[thumbnail.key] || urlsExpireAt < Date.now() + 30_000)) {
        const signed = await getDownloadUrls(session, asset.id, [thumbnail.key]);
        urls = { ...urls, ...signed.urls }; urlsExpireAt = Date.now() + signed.expiresIn * 900;
      }
      return [asset.id, { ...asset, manifest, urls, urlsExpireAt }] as const;
    }));
    setAssets(Object.fromEntries(loaded));
  }

  useEffect(() => {
    let active = true;
    let next: MultiplayerConnection | undefined;
    void (async () => {
      let room: Awaited<ReturnType<NonNullable<typeof rooms>['getRoom']>>;
      let lobby: Awaited<ReturnType<NonNullable<typeof rooms>['getLobby']>>;
      try {
        [room, lobby] = await Promise.all([rooms!.getRoom(roomId), rooms!.getLobby(roomId)]);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
        return;
      }
      if (!active) return;
      if (!room) { setError('This room is unavailable or you are no longer a member.'); return; }
      setMembers(lobby.members);
      void refreshAssets().catch((cause) => active && setError(errorMessage(cause)));
      const endpoint = String(import.meta.env.VITE_MULTIPLAYER_URL || '');
      if (!endpoint) { setConnectionError('VITE_MULTIPLAYER_URL is not configured.'); setStatus('reconnecting'); return; }
      try {
        next = createMultiplayerConnection({ endpoint, roomId, accessToken: session.access_token, storage: sessionStorage, client: e2eClient(),
          onProjection: (nextProjection) => { if (active) { const nextScene = projectionToTacticalModel(nextProjection); if (nextProjection.streamReset) { clearProjectionLocalState(); queueMicrotask(() => setSelectedToken(undefined)); } else setSelectedToken((current) => current && nextScene.tokens[current] ? current : undefined); setScene(nextScene); setConnectionError(''); } },
          onStatus: (value) => active && setStatus(value), onError: (cause) => active && setConnectionError(cause.message),
          onPing: (ping) => {
            if (!active) return;
            setPings((current) => [...current.filter((candidate) => candidate.id !== ping.id), ping]);
            setTimeout(() => { if (active) setPings((current) => current.filter((candidate) => candidate.id !== ping.id)); }, Math.max(0, ping.expiresAtMs - ping.serverTimeMs));
          },
        });
        connection.current = next;
        await next.connect();
      } catch (cause) {
        if (active) { setStatus('reconnecting'); setConnectionError(errorMessage(cause)); }
      }
    })();
    return () => { active = false; if (next && connection.current === next) connection.current = undefined; if (next) void next.disconnect(); };
  }, [roomId, session.access_token, reconnectKey]);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setWallDraft(undefined); setEndpointDraft(undefined);
    setSelectedWallId((current) => current && scene.walls[current] ? current : undefined);
    setSelectedStructureId((current) => current && scene.structures[current] ? current : undefined);
  }, [scene, cameraMode]);

  useEffect(() => {
    if (!wallTool && !structureTool) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { setWallTool(false); setStructureTool(undefined); setWallDraft(undefined); setEndpointDraft(undefined); } };
    window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel);
  }, [structureTool, wallTool]);

  useEffect(() => {
    if (!canUsePerspective && cameraMode !== 'tactical') {
      setCameraMode('tactical');
      setError('3D view access was turned off. Tactical view is active.');
    }
  }, [cameraMode, canUsePerspective]);

  async function command(type: Parameters<MultiplayerConnection['request']>[0], payload: unknown) {
    if (projectionIsRestricted(scene)) return undefined;
    setPending((value) => value + 1); setError('');
    try {
      const current = connection.current;
      if (!current?.getRoom()) throw new Error('The tactical table is still connecting. Please try again when it is online.');
      return await current.request(type, { commandId: id(), payload });
    }
    catch (cause) { setError(errorMessage(cause)); throw cause; }
    finally { setPending((value) => Math.max(0, value - 1)); }
  }

  async function processAsset(kind: 'map' | 'token', file: File, updateTask: (phase: AssetTask['phase'], progress?: number) => void) {
    const result = await command('asset.reserve', { kind, sourceMetadata: { name: file.name, contentType: file.type, bytes: file.size } });
    const reservation = result!.result as AssetReservation;
    updateTask('uploading', 0);
    await uploadAsset(session, reservation, file, (progress) => updateTask('uploading', progress), () => updateTask('processing'));
    return { reservation, manifest: await waitForManifest(session, reservation.id) };
  }

  async function onUpload(kind: 'map' | 'token', event: ChangeEvent<HTMLInputElement>) {
    if (projectionIsRestricted(scene)) return;
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setAssetTask({ kind, phase: 'preparing' }); setError('');
    try {
      const { reservation, manifest } = await processAsset(kind, file, (phase, progress) => setAssetTask({ kind, phase, progress }));
      await refreshAssets();
      if (kind === 'map') {
        await command('map.set', { map: { assetId: reservation.id, width: manifest.width, height: manifest.height } });
        setView({ x: manifest.width / 2, y: manifest.height / 2, zoom: Math.min(viewport.width / manifest.width, viewport.height / manifest.height) * .9 });
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setAssetTask(undefined); }
  }

  async function loadDevelopmentSet() {
    if (projectionIsRestricted(scene) || !scene.controls.tokens.canCreate) return;
    setAssetTask({ kind: 'development', phase: 'preparing', item: 0, total: 4 }); setError('');
    try {
      const fixtures = await loadDevelopmentFixtures();
      const mapFixture = fixtures.find((fixture) => fixture.kind === 'map')!;
      const updateDevelopmentTask = (item: number) => (phase: AssetTask['phase'], progress?: number) => setAssetTask({ kind: 'development', phase, progress, item, total: fixtures.length });
      const mapResult = await processAsset('map', mapFixture.file, updateDevelopmentTask(1));
      await command('map.set', { map: { assetId: mapResult.reservation.id, width: mapResult.manifest.width, height: mapResult.manifest.height } });
      const developmentGrid = { visible: true, cellSize: 50, offset: { x: 0, y: 0 }, distancePerCell: 5, unit: 'ft' as const, snap: true };
      await command('grid.set', developmentGrid);
      const positions = [{ x: 425, y: 425 }, { x: 575, y: 425 }, { x: 825, y: 575 }];
      for (const [index, fixture] of fixtures.filter((candidate) => candidate.kind === 'token').entries()) {
        const tokenResult = await processAsset('token', fixture.file, updateDevelopmentTask(index + 2));
        await command('token.create', { token: {
          id: id(), assetId: tokenResult.reservation.id, position: snapPointToCellCenter(positions[index]!, developmentGrid.cellSize, developmentGrid.offset),
          size: { width: developmentGrid.cellSize, height: developmentGrid.cellSize }, rotation: 0, label: fixture.label,
          ownerId: session.user.id, hpCurrent: 10, hpMaximum: 10, hpHidden: false, z: Object.keys(scene.tokens).length + index,
        } });
      }
      await refreshAssets();
      setView({ x: mapResult.manifest.width / 2, y: mapResult.manifest.height / 2, zoom: Math.min(viewport.width / mapResult.manifest.width, viewport.height / mapResult.manifest.height) * .9 });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setAssetTask(undefined); }
  }

  async function ensureUrls(assetId: string, keys: string[]) {
    const asset = assets[assetId];
    if (!asset) return;
    const expired = asset.urlsExpireAt < Date.now() + 30_000;
    const missing = expired ? keys : keys.filter((key) => !asset.urls[key]);
    if (!missing.length) return;
    try {
      const signed = await getDownloadUrls(session, assetId, missing);
      setAssets((current) => ({ ...current, [assetId]: { ...current[assetId]!, urls: expired ? signed.urls : { ...current[assetId]!.urls, ...signed.urls }, urlsExpireAt: Date.now() + signed.expiresIn * 900 } }));
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const restricted = projectionIsRestricted(scene);
  useEffect(() => { if (restricted) clearProjectionLocalState(); }, [restricted]);
  const connected = status === 'online' && Boolean(connection.current?.getRoom());
  function canMove(candidate: TokenRecord) {
    if (restricted) return false;
    const control = scene.controls.tokens.records.find((record) => record.tokenId === candidate.id);
    return connected && scene.controls.movement.canMove && Boolean(control?.canTransform);
  }
  function placeToken(point: Point) {
    if (restricted || !selectedAsset || !scene.controls.tokens.canCreate) return;
    const position = scene.grid.snap ? snapPointToCellCenter(point, scene.grid.cellSize, scene.grid.offset) : point;
    const tokenId = id();
    void command('token.create', { token: { id: tokenId, assetId: selectedAsset, position, size: { width: scene.grid.cellSize, height: scene.grid.cellSize }, rotation: 0, label: 'New token', ownerId: session.user.id, hpCurrent: 0, hpMaximum: 0, hpHidden: false, z: Object.keys(scene.tokens).length } }).then(() => { setSelectedAsset(undefined); setSelectedToken(tokenId); }).catch(() => undefined);
  }
  async function commitFog(kind: FogTool['kind'], points: Point[]) {
    if (restricted || !scene.controls.fog.canCommit) return;
    await command('fog.operation.commit', {
      operation: { id: id(), kind, points }, expectedFogRevision: scene.controls.fog.expectedFogRevision,
    });
    setFogPoints([]);
  }
  function useFogTool(next: FogTool) {
    if (restricted) return;
    setFogTool((current) => current?.kind === next.kind && current.shape === next.shape ? undefined : next);
    setFogPoints([]);
    setDrawingTool(undefined); setDrawingPoints([]); setPingTool(false); setRulerTool(false); setRulerPoints([]); setSelectedAsset(undefined);
  }
  async function commitDrawing(kind: 'line' | 'polygon', points: Point[]) {
    if (restricted || !scene.controls.drawings.canCreate) return;
    const normalized = kind === 'line' ? simplifyPolyline(points, Math.max(1, drawingWidth / 2)) : points;
    await command('drawing.create', {
      drawing: { id: id(), kind, points: normalized, color: drawingColor, width: drawingWidth, fill: null, hidden: false, z: Object.keys(scene.drawings).length },
      expectedDrawingRevision: scene.controls.drawings.expectedDrawingRevision,
    });
    setDrawingPoints([]);
  }
  function useDrawingTool(next: DrawingTool) {
    if (restricted) return;
    setDrawingTool((current) => current === next ? undefined : next);
    setDrawingPoints([]); setFogTool(undefined); setFogPoints([]); setPingTool(false); setRulerTool(false); setRulerPoints([]); setSelectedAsset(undefined);
  }
  async function finishDrawing() {
    if (!drawingTool || drawingPoints.length < (drawingTool === 'polygon' ? 3 : 2)) return;
    await commitDrawing(drawingTool === 'polygon' ? 'polygon' : 'line', drawingPoints).catch(() => undefined);
  }
  async function undoDrawing() {
    if (restricted) return;
    if (!scene.controls.drawings.records.some((record) => record.canDelete)) return;
    const drawing = Object.values(scene.drawings).filter((candidate) => scene.controls.drawings.records.some((record) => record.drawingId === candidate.id && record.canDelete)).sort((a, b) => b.z - a.z)[0];
    if (!drawing) return;
    await command('drawing.delete', {
      drawingId: drawing.id, expectedDrawingRevision: scene.controls.drawings.expectedDrawingRevision, expectedRecordRevision: scene.controls.drawings.records.find((record) => record.drawingId === drawing.id)?.expectedRecordRevision,
    }).catch(() => undefined);
  }
  function useRuler() {
    if (restricted) return;
    setRulerTool((current) => !current); setRulerPoints([]); setDrawingTool(undefined); setDrawingPoints([]); setFogTool(undefined); setFogPoints([]); setPingTool(false); setSelectedAsset(undefined);
  }
  function usePing() {
    if (restricted) return;
    setPingTool((current) => !current); setDrawingTool(undefined); setDrawingPoints([]); setFogTool(undefined); setFogPoints([]); setRulerTool(false); setRulerPoints([]); setSelectedAsset(undefined);
  }
  function changeCameraMode(next: CameraMode) {
    if (restricted) return;
    if (next !== 'tactical' && !scene.controls.perspective.canUse) {
      setError('3D view is not enabled for players in this room.');
      return;
    }
    setCameraMode(next);
    if (next === 'overview') setPresentationMode('exterior');
    setWallTool(false); setStructureTool(undefined); setWallDraft(undefined); setEndpointDraft(undefined);
    if (next !== 'tactical') {
      setFogTool(undefined); setFogPoints([]); setDrawingTool(undefined); setDrawingPoints([]);
      setRulerTool(false); setRulerPoints([]); setPingTool(false); setSelectedAsset(undefined);
    }
  }
  function orbitCamera(kind: CameraOrbitAction['kind'], amount: number) {
    if (restricted) return;
    setOrbitAction({ id: ++cameraActionId.current, kind, amount });
  }
  function setPerspectiveAccess(enabled: boolean) {
    if (!scene.controls.perspective.canSet) return;
    void command('permissions.playerPerspectiveView.set', { enabled }).catch(() => undefined);
  }
  function selectAsset(assetId: string) {
    if (restricted) return;
    setSelectedAsset((current) => current === assetId ? undefined : assetId);
    setFogTool(undefined); setFogPoints([]); setDrawingTool(undefined); setDrawingPoints([]); setRulerTool(false); setRulerPoints([]); setPingTool(false);
  }
  function stageWorldPoint(event: ReactPointerEvent<HTMLElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, view, { width: bounds.width, height: bounds.height });
  }
  function beginFreehand(event: ReactPointerEvent<HTMLElement>) {
    if (restricted || drawingTool !== 'path' || !(event.target instanceof HTMLCanvasElement)) return;
    event.stopPropagation();
    freehandActive.current = true;
    freehandPoints.current = [stageWorldPoint(event)];
    setDrawingPoints(freehandPoints.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function continueFreehand(event: ReactPointerEvent<HTMLElement>) {
    if (restricted || !freehandActive.current) return;
    event.stopPropagation();
    const point = stageWorldPoint(event);
    const previous = freehandPoints.current.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(2, drawingWidth / view.zoom)) return;
    freehandPoints.current = [...freehandPoints.current, point];
    setDrawingPoints(freehandPoints.current);
  }
  function endFreehand(event: ReactPointerEvent<HTMLElement>) {
    if (restricted || !freehandActive.current) return;
    event.stopPropagation();
    freehandActive.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const points = freehandPoints.current;
    freehandPoints.current = [];
    if (points.length >= 2) void commitDrawing('line', points).catch(() => undefined);
    else setDrawingPoints([]);
  }
  function snappedWallPoint(point: Point) {
    const bounded = scene.map ? { x: Math.max(0, Math.min(scene.map.width, point.x)), y: Math.max(0, Math.min(scene.map.height, point.y)) } : point;
    const wall = hitProjectedWall(bounded, Object.values(scene.walls), Math.max(8, scene.grid.cellSize * .35 / Math.max(view.zoom, .01)));
    if (!wall) return { point: bounded, wallId: undefined };
    const dx = wall.end.x - wall.start.x; const dy = wall.end.y - wall.start.y; const lengthSquared = dx * dx + dy * dy;
    const ratio = Math.max(0, Math.min(1, ((bounded.x - wall.start.x) * dx + (bounded.y - wall.start.y) * dy) / lengthSquared));
    return { point: { x: wall.start.x + ratio * dx, y: wall.start.y + ratio * dy }, wallId: wall.wallId };
  }
  function hitStructure(point: Point, structure: StructureRecord) {
    const radians = structure.rotation * Math.PI / 180; const dx = point.x - structure.position.x; const dy = point.y - structure.position.y;
    const localX = dx * Math.cos(radians) + dy * Math.sin(radians); const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
    return Math.abs(localX) <= structure.size.width / 2 && Math.abs(localY) <= structure.size.height / 2;
  }
  function toggleWallTool() {
    if (restricted) return;
    setWallTool((current) => !current); setStructureTool(undefined); setWallDraft(undefined); setEndpointDraft(undefined); setSelectedStructureId(undefined);
  }
  function useStructureTool(kind: 'block' | 'floor' | 'roof') {
    if (restricted) return;
    setStructureTool((current: ('block' | 'floor' | 'roof') | undefined) => current === kind ? undefined : kind); setWallTool(false); setWallDraft(undefined); setEndpointDraft(undefined); setSelectedWallId(undefined);
  }
  function createWall(start: Point, end: Point) {
    if (restricted || !connected || !scene.controls.geometry.canCreateWall) return;
    const wall: WallCreatePayload['wall'] = { id: id(), type: 'blocking', start, end, height: Math.max(scene.grid.cellSize * 2, 20), thickness: Math.max(4, scene.grid.cellSize * .12), elevation: 0, material: 'default', openings: [] };
    void command('wall.create', { wall, expectedWallRevision: scene.controls.geometry.expectedWallRevision }).then(() => { setWallDraft(undefined); setWallTool(false); }).catch(() => undefined);
  }
  function createStructure(kind: StructureRecord['structureKind'], point: Point) {
    if (restricted || !connected || !scene.controls.geometry.canCreateStructure) return;
    const cell = scene.grid.cellSize || 50; const position = scene.grid.snap ? snapPointToCellCenter(point, cell, scene.grid.offset) : point;
    const structure: StructureCreatePayload['structure'] = { id: id(), kind, position, size: { width: cell * 2, height: cell * 2 }, rotation: 0, label: kind[0]!.toUpperCase() + kind.slice(1), z: Object.keys(scene.structures).length, material: 'default', baseElevation: 0, slabHeight: Math.max(4, cell * .16) };
    void command('structure.create', { structure, expectedStructureRevision: scene.controls.geometry.expectedStructureRevision }).then(() => { setStructureTool(undefined); }).catch(() => undefined);
  }
  function updateWallEndpoint(wallId: string, endpoint: 'start' | 'end', point: Point, commit: boolean) {
    const wall = scene.walls[wallId]; if (!wall) return;
    if (restricted || !scene.controls.geometry.canUpdateWall) return;
    const snapped = snappedWallPoint(point).point;
    const start = endpoint === 'start' ? snapped : wall.start; const end = endpoint === 'end' ? snapped : wall.end;
    setEndpointDraft({ wallId, start, end });
    if (commit) void command('wall.update', { wall: wallInput({ ...wall, start, end }), expectedWallRevision: scene.controls.geometry.expectedWallRevision, expectedRecordRevision: wall.recordRevision }).then(() => setEndpointDraft(undefined)).catch(() => setEndpointDraft(undefined));
  }
  function applyWall(values: WallEditValues) {
    if (restricted || !selectedWall || !scene.controls.geometry.canUpdateWall) return;
    const openings = values.type === 'door' || !values.opening ? [] : [{ type: 'window' as const, start: Math.max(0, Math.min(1, Math.min(values.opening.start, values.opening.end))), end: Math.min(1, Math.max(0, Math.max(values.opening.start, values.opening.end))), bottom: Math.max(0, values.opening.bottom), height: Math.max(.1, values.opening.height) }];
    const wall = values.type === 'door' ? { ...selectedWall, wallKind: 'door' as const, doorState: values.doorState ?? 'closed', material: values.material, height: values.height, thickness: values.thickness, elevation: values.elevation, openings } : { ...selectedWall, wallKind: values.type, material: values.material, height: values.height, thickness: values.thickness, elevation: values.elevation, openings };
    void command('wall.update', { wall: wallInput(wall), expectedWallRevision: scene.controls.geometry.expectedWallRevision, expectedRecordRevision: selectedWall.recordRevision }).catch(() => undefined);
  }
  function deleteWall() {
    if (restricted || !selectedWall || !scene.controls.geometry.canDeleteWall) return;
    void command('wall.delete', { wallId: selectedWall.wallId, expectedWallRevision: scene.controls.geometry.expectedWallRevision, expectedRecordRevision: selectedWall.recordRevision }).then(() => setSelectedWallId(undefined)).catch(() => undefined);
  }
  function applyStructure(values: StructureEditValues) {
    if (restricted || !selectedStructure || !scene.controls.geometry.canUpdateStructure) return;
    const structure: StructureRecord = { ...selectedStructure, structureKind: values.kind, material: values.material, size: { width: Math.max(1, values.width), height: Math.max(1, values.height) }, baseElevation: values.elevation, slabHeight: Math.max(.1, values.slabHeight), rotation: values.rotation };
    void command('structure.update', { structure: structureInput(structure), expectedStructureRevision: scene.controls.geometry.expectedStructureRevision, expectedRecordRevision: selectedStructure.recordRevision }).catch(() => undefined);
  }
  function deleteStructure() {
    if (restricted || !selectedStructure || !scene.controls.geometry.canDeleteStructure) return;
    void command('structure.delete', { structureId: selectedStructure.structureId, expectedStructureRevision: scene.controls.geometry.expectedStructureRevision, expectedRecordRevision: selectedStructure.recordRevision }).then(() => setSelectedStructureId(undefined)).catch(() => undefined);
  }
  function moveEditorPointer(event: ReactPointerEvent<HTMLElement>) {
    continueFreehand(event);
    if (!wallTool || !wallDraft) return;
    const snap = snappedWallPoint(stageWorldPoint(event));
    setWallDraft((current) => current ? { ...current, end: snap.point, snapped: Boolean(snap.wallId) } : current);
  }
  function handleMapClick(point: Point) {
    if (restricted) return;
    const onMap = scene.map && point.x >= 0 && point.y >= 0 && point.x <= scene.map.width && point.y <= scene.map.height;
    if (!onMap && (fogTool || drawingTool || rulerTool || pingTool)) return;
    if (fogTool && scene.controls.fog.canCommit) {
      if (fogTool.shape === 'polygon') { setFogPoints((current) => [...current, point]); return; }
      if (!fogPoints.length) { setFogPoints([point]); return; }
      void commitFog(fogTool.kind, rectanglePolygon(fogPoints[0]!, point)).catch(() => undefined);
      return;
    }
    if (drawingTool) {
      if (drawingTool === 'polygon') { setDrawingPoints((current) => [...current, point]); return; }
      if (drawingTool === 'path') return;
      if (!drawingPoints.length) { setDrawingPoints([point]); return; }
      const start = drawingPoints[0]!;
      const points = drawingTool === 'rectangle' ? rectanglePolygon(start, point) : drawingTool === 'ellipse' ? ellipsePolygon(start, point) : [start, point];
      void commitDrawing(drawingTool === 'line' ? 'line' : 'polygon', points).catch(() => undefined);
      return;
    }
    if (rulerTool && rulerPoints.length === 1) { setRulerPoints([rulerPoints[0]!, point]); return; }
    if (rulerTool) { setRulerPoints([point]); return; }
    if (pingTool) {
      try { connection.current?.sendPing({ id: id(), position: point }); }
      catch (cause) { setError(errorMessage(cause)); }
      return;
    }
    if (scene.controls.geometry.canCreateWall && wallTool) {
      const snap = snappedWallPoint(point);
      if (!wallDraft) { setWallDraft({ start: snap.point, snapped: Boolean(snap.wallId) }); return; }
      if (Math.hypot(snap.point.x - wallDraft.start.x, snap.point.y - wallDraft.start.y) > .01) createWall(wallDraft.start, snap.point);
      return;
    }
    if (scene.controls.geometry.canCreateStructure && structureTool) { createStructure(structureTool, point); return; }
    if (scene.controls.geometry.canUpdateWall || scene.controls.geometry.canUpdateStructure || scene.controls.geometry.canDeleteWall || scene.controls.geometry.canDeleteStructure) {
      const wallHit = hitProjectedWall(point, Object.values(scene.walls), Math.max(8, scene.grid.cellSize * .3 / Math.max(view.zoom, .01)));
      if (wallHit) { setSelectedWallId(wallHit.wallId); setSelectedStructureId(undefined); setSelectedToken(undefined); return; }
      const structureHit = Object.values(scene.structures).find((candidate) => hitStructure(point, candidate));
      if (structureHit) { setSelectedStructureId(structureHit.structureId); setSelectedWallId(undefined); setSelectedToken(undefined); return; }
    }
    placeToken(point);
  }
  async function finishFogPolygon() {
    if (!fogTool || fogTool.shape !== 'polygon' || fogPoints.length < 3) return;
    await commitFog(fogTool.kind, fogPoints).catch(() => undefined);
  }
  async function undoFog() {
    if (restricted) return;
    const operationId = scene.controls.fog.latestOperationId;
    if (!operationId || !scene.controls.fog.canUndo) return;
    await command('fog.undo', {
      expectedFogRevision: scene.controls.fog.expectedFogRevision, expectedOperationId: operationId,
    }).catch(() => undefined);
  }
  async function clearFog() {
    if (restricted || !scene.controls.fog.canClear) return;
    await command('fog.clear', { expectedFogRevision: scene.controls.fog.expectedFogRevision }).catch(() => undefined);
  }
  function previewToken(tokenId: string, point: Point, rotation: number) {
    if (restricted) return;
    if (!connected || !scene.controls.tokens.records.find((record) => record.tokenId === tokenId)?.canTransform) return;
    setScene((current) => ({ ...current, tokens: { ...current.tokens, [tokenId]: { ...current.tokens[tokenId]!, position: point } } }));
    const current = connection.current;
    if (current?.getRoom() && Date.now() - previewAt.current > 80) {
      previewAt.current = Date.now();
      try { current.send('token.transform.preview', { tokenId, sequence: ++previewSequence.current, position: point, rotation }); }
      catch (cause) { setError(errorMessage(cause)); }
    }
  }
  function commitToken(tokenId: string, point: Point, rotation: number) {
    if (restricted) return;
    const current = scene.tokens[tokenId]; if (!current) return;
    const control = scene.controls.tokens.records.find((record) => record.tokenId === tokenId);
    if (!control?.canTransform) return;
    const position = scene.grid.snap ? snapPointToCellCenter(point, scene.grid.cellSize, scene.grid.offset) : point;
    void command('token.transform.commit', { tokenId, expectedTokenRevision: control.expectedTokenRevision, position, rotation }).catch(() => undefined);
  }
  function fit() {
    const width = scene.map?.width ?? 2000, height = scene.map?.height ?? 1200;
    setView({ x: width / 2, y: height / 2, zoom: Math.max(.02, Math.min(viewport.width / width, viewport.height / height) * .9) });
  }
  async function saveGrid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await command('grid.set', { visible: data.get('visible') === 'on', cellSize: Number(data.get('cellSize')), offset: { x: Number(data.get('offsetX')), y: Number(data.get('offsetY')) }, distancePerCell: Number(data.get('distance')), unit: data.get('unit'), snap: data.get('snap') === 'on' }).catch(() => undefined);
  }
  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (restricted || !token || !tokenControl?.canUpdateDetails) return; const data = new FormData(event.currentTarget);
    const details: Record<string, unknown> = { label: String(data.get('label')), size: { width: Number(data.get('width')), height: Number(data.get('height')) } };
    if (token.hp) { details.hpCurrent = Number(data.get('hpCurrent')); details.hpMaximum = Number(data.get('hpMaximum')); }
    await command('token.details.update', { tokenId: token.id, expectedTokenRevision: tokenControl?.expectedTokenRevision, details }).catch(() => undefined);
    const rotation = Number(data.get('rotation'));
    if (rotation !== token.rotation && tokenControl.canTransform) await command('token.transform.commit', { tokenId: token.id, expectedTokenRevision: tokenControl.expectedTokenRevision, position: token.position, rotation }).catch(() => undefined);
  }
  function deleteToken() {
    if (restricted || !token || !tokenControl || !tokenControl.canDelete) return;
    void command('token.delete', { tokenId: token.id, expectedTokenRevision: tokenControl.expectedTokenRevision }).then(() => setSelectedToken(undefined)).catch(() => undefined);
  }

  async function addSelectedToInitiative() {
    if (restricted || !token || !scene.controls.initiative.canAdd) return;
    await command('initiative.entry.add', {
      entry: { id: id(), tokenId: token.id, label: token.label || 'Token', score: 0, hidden: false },
      expectedInitiativeRevision: scene.controls.initiative.expectedInitiativeRevision,
    }).catch(() => undefined);
  }

  async function updateInitiativeEntry(event: FormEvent<HTMLFormElement>, entryId: string) {
    event.preventDefault();
    if (restricted || !scene.controls.initiative.records.find((record) => record.entryId === entryId)?.canUpdate) return;
    const data = new FormData(event.currentTarget);
    await command('initiative.entry.update', {
      entryId,
      expectedInitiativeRevision: scene.controls.initiative.expectedInitiativeRevision,
      details: { score: Number(data.get('score')) },
    }).catch(() => undefined);
  }

  async function removeInitiativeEntry(entryId: string) {
    if (restricted || !scene.controls.initiative.records.find((record) => record.entryId === entryId)?.canRemove) return;
    await command('initiative.entry.remove', {
      entryId, expectedInitiativeRevision: scene.controls.initiative.expectedInitiativeRevision,
    }).catch(() => undefined);
  }

  async function moveInitiativeEntry(index: number, direction: -1 | 1) {
    if (restricted || !scene.controls.initiative.canReorder) return;
    const target = index + direction;
    if (target < 0 || target >= scene.initiative.entries.length) return;
    const entryIds = scene.initiative.entries.flatMap((entry) => 'id' in entry ? [entry.id] : []);
    [entryIds[index], entryIds[target]] = [entryIds[target]!, entryIds[index]!];
    await command('initiative.reorder', {
      entryIds, expectedInitiativeRevision: scene.controls.initiative.expectedInitiativeRevision,
    }).catch(() => undefined);
  }

  async function initiativeLifecycle(type: 'initiative.start' | 'initiative.advance' | 'initiative.stop') {
    if (restricted) return;
    if ((type === 'initiative.start' && !scene.controls.initiative.canStart) || (type === 'initiative.advance' && !scene.controls.initiative.canAdvance) || (type === 'initiative.stop' && !scene.controls.initiative.canStop)) return;
    await command(type, { expectedInitiativeRevision: scene.controls.initiative.expectedInitiativeRevision }).catch(() => undefined);
  }

  const activeRoom = connection.current?.getRoom();
  const online = activeRoom ? getConnectedUserIds(activeRoom.state) : new Set<string>();
  const candidateMapAsset = scene.map ? assets[scene.map.assetId] : undefined;
  const mapAsset = candidateMapAsset?.manifest ? { manifest: candidateMapAsset.manifest, urls: candidateMapAsset.urls } : undefined;
  const tokenAssets = Object.fromEntries(Object.values(assets).filter((asset) => asset.kind === 'token' && asset.manifest).map((asset) => [asset.id, { manifest: asset.manifest!, urls: asset.urls }]));
  const canDraw = scene.controls.drawings.canCreate;
  const canEditGeometry = scene.controls.geometry.canCreateWall || scene.controls.geometry.canUpdateWall || scene.controls.geometry.canDeleteWall || scene.controls.geometry.canCreateStructure || scene.controls.geometry.canUpdateStructure || scene.controls.geometry.canDeleteStructure;
  const assetBusy = Boolean(assetTask);
  const commandBusy = pending > 0;
  const tokenLibrary = Object.values(assets).filter((asset) => asset.kind === 'token');
  const assetStatus = assetTask ? (() => {
    const target = assetTask.kind === 'development' ? `Development set ${assetTask.item ?? 0}/${assetTask.total ?? 4}` : assetTask.kind === 'map' ? 'Map' : 'Token';
    if (assetTask.phase === 'preparing') return `${target}: preparing`;
    if (assetTask.phase === 'processing') return `${target}: processing`;
    return `${target}: uploading ${assetTask.progress ?? 0}%`;
  })() : '';
  const drawingDraft: DrawingDraft | undefined = drawingTool && drawingPoints.length ? {
    kind: drawingTool === 'polygon' || drawingTool === 'rectangle' || drawingTool === 'ellipse' ? 'polygon' : 'line',
    points: drawingPoints, color: drawingColor, width: drawingWidth, fill: null,
  } : undefined;
  const ruler: RulerDraft | undefined = rulerPoints.length === 2 ? (() => {
    const measured = measureGridDistance(rulerPoints[0]!, rulerPoints[1]!, scene.grid.cellSize, scene.grid.distancePerCell, rulerRule);
    return { start: rulerPoints[0]!, end: rulerPoints[1]!, label: `${Number(measured.distance.toFixed(1))} ${scene.grid.unit}` };
  })() : undefined;
  if (restricted) return <main className="tactical-page"><header className="tactical-header"><Link to={`/rooms/${roomId}`} className="table-back">‹ Lobby</Link><div><span className="eyebrow">LIVE ENCOUNTER</span><strong>Tactical table</strong></div><span className="connection-badge" role="status">{status}</span></header><div className="tactical-shell"><section className="table-stage is-restricted" aria-label="Map concealed" ref={stage}><TacticalRenderer scene={scene} mapAsset={undefined} tokenAssets={{}} view={view} viewport={viewport} selectedId={undefined} canMove={() => false} onSelect={() => undefined} onMapClick={() => undefined} onTokenDrag={() => undefined} onTokenCommit={() => undefined} ensureUrls={() => undefined} /></section></div></main>;
  return <main className="tactical-page">
    <header className="tactical-header"><Link to={`/rooms/${roomId}`} className="table-back">‹ Lobby</Link><div><span className="eyebrow">LIVE ENCOUNTER</span><strong>Tactical table</strong></div><span className={`connection-badge ${status === 'online' ? 'connected' : ''}`} role="status"><span className="live-dot" />{status === 'online' ? `${Math.max(online.size, 1)} online` : status}</span></header>
     {(connectionError || error) && <div className="table-notice"><Notice error>{connectionError || error} {connectionError && <button className="inline-button" onClick={() => { setConnectionError(''); setStatus('connecting'); setReconnectKey((value) => value + 1); }}>Reconnect</button>}</Notice></div>}
     <div className="tactical-shell">
       <aside className="asset-rail" aria-label="Encounter assets"><div className="rail-heading"><h2>Tokens</h2><label className={`upload-control upload-button${!connected || assetBusy ? ' disabled' : ''}${assetTask?.kind === 'token' ? ' is-loading' : ''}`} aria-disabled={!connected || assetBusy}>Upload token<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={!connected || assetBusy} onChange={(event) => onUpload('token', event)} /></label></div>
         <div className="token-palette" aria-label="Token palette">{tokenLibrary.map((asset, index) => { const image = asset.manifest?.outputs.find((output) => output.type === 'thumbnail' || output.type === 'image'); return <button key={asset.id} disabled={!connected || assetBusy} className={selectedAsset === asset.id ? 'active' : ''} onClick={() => selectAsset(asset.id)} aria-label={`Place token ${index + 1}`} aria-pressed={selectedAsset === asset.id}>{image && asset.urls[image.key] ? <img src={asset.urls[image.key]} alt="" /> : <span>?</span>}</button>; })}{!tokenLibrary.length && <p className="asset-empty">No tokens yet</p>}</div>
         <div className="asset-actions" aria-busy={assetBusy}>
           {scene.controls.tokens.canCreate && <label className={`button secondary full upload-control map-upload${!connected || assetBusy ? ' disabled' : ''}${assetTask?.kind === 'map' ? ' is-loading' : ''}`} aria-disabled={!connected || assetBusy}>Upload map<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={!connected || assetBusy} onChange={(event) => onUpload('map', event)} /></label>}
           {import.meta.env.DEV && <button className={`button secondary full${assetTask?.kind === 'development' ? ' is-loading' : ''}`} aria-busy={assetTask?.kind === 'development'} disabled={!connected || assetBusy || !scene.controls.tokens.canCreate} onClick={() => void loadDevelopmentSet()}>{assetTask?.kind === 'development' ? 'Loading set…' : 'Load development set'}</button>}
           {assetTask && <div className="asset-status" role="status"><span>{assetStatus}</span>{assetTask.phase === 'uploading' && <div className="upload-progress" role="progressbar" aria-label={`${assetTask.kind} upload progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={assetTask.progress ?? 0}><i style={{ width: `${assetTask.progress ?? 0}%` }} /></div>}</div>}
         </div>
        <section className="initiative-panel" aria-label="Initiative tracker">
          <div className="initiative-heading"><div><span className="eyebrow">INITIATIVE</span><strong>{scene.initiative.active ? `Round ${scene.initiative.round}` : 'Setup'}</strong></div>{token && !scene.initiative.entries.some((entry) => 'tokenId' in entry && entry.tokenId === token.id) && scene.controls.initiative.canAdd && <button disabled={!connected || commandBusy} onClick={() => void addSelectedToInitiative()}>+ Add</button>}</div>
          <ol className="initiative-list">{scene.initiative.entries.map((entry, index) => { if (!('id' in entry)) return <li key={`hidden-${index}`} className="initiative-placeholder"><span>{String(index + 1).padStart(2, '0')}</span><strong>Hidden turn</strong></li>; const entryToken = scene.tokens[entry.tokenId]; const editable = scene.controls.initiative.records.find((record) => record.entryId === entry.id)?.canUpdate === true; const active = scene.initiative.active && scene.initiative.turnIndex === index; return <li key={entry.id} className={active ? 'active' : ''}><button className="initiative-entry" onClick={() => setSelectedToken(entry.tokenId)}><span>{active ? 'Current' : String(index + 1).padStart(2, '0')}</span><strong>{entry.label}</strong></button><form onSubmit={(event) => void updateInitiativeEntry(event, entry.id)}><input name="score" type="number" defaultValue={entry.score} aria-label={`${entry.label} initiative`} disabled={!editable || !connected} /><button aria-label={`Save ${entry.label} initiative`} disabled={!editable || !connected || Boolean(pending)}>✓</button></form>{scene.controls.initiative.canReorder && <div className="initiative-order"><button aria-label={`Move ${entry.label} up`} disabled={!connected || index === 0} onClick={() => void moveInitiativeEntry(index, -1)}>↑</button><button aria-label={`Move ${entry.label} down`} disabled={!connected || index === scene.initiative.entries.length - 1} onClick={() => void moveInitiativeEntry(index, 1)}>↓</button></div>}{editable && <button className="initiative-remove" aria-label={`Remove ${entry.label}`} disabled={!connected || Boolean(pending)} onClick={() => void removeInitiativeEntry(entry.id)}>×</button>}</li>; })}</ol>
          {!scene.initiative.entries.length && <p>Select a token and add it to the turn order.</p>}
          {(scene.controls.initiative.canStart || scene.controls.initiative.canAdvance || scene.controls.initiative.canStop) && <div className="initiative-actions">{scene.initiative.active ? <><button disabled={!connected || commandBusy} onClick={() => void initiativeLifecycle('initiative.advance')}>Next turn</button><button disabled={!connected || commandBusy} onClick={() => void initiativeLifecycle('initiative.stop')}>Stop</button></> : <button disabled={!connected || commandBusy || !scene.initiative.entries.length} onClick={() => void initiativeLifecycle('initiative.start')}>Start encounter</button>}</div>}
        </section>
      </aside>
      <section className={`table-stage${restricted ? ' is-restricted' : ''}${cameraMode !== 'tactical' ? ' is-perspective' : ''}${fogTool || drawingTool || rulerTool || pingTool || selectedAsset ? ' is-targeting' : ''}`} aria-label={`${cameraMode[0]!.toUpperCase()}${cameraMode.slice(1)} tactical map`} ref={stage} onPointerDownCapture={cameraMode === 'tactical' ? beginFreehand : undefined} onPointerMoveCapture={cameraMode === 'tactical' ? moveEditorPointer : undefined} onPointerUpCapture={cameraMode === 'tactical' ? endFreehand : undefined} onPointerCancel={cameraMode === 'tactical' ? endFreehand : undefined} onWheel={(event) => { if (cameraMode !== 'tactical') return; const bounds = event.currentTarget.getBoundingClientRect(); setView((value) => zoomViewAtScreenPoint(value, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, Math.max(.03, Math.min(8, value.zoom * Math.exp(-event.deltaY * .001))), { width: bounds.width, height: bounds.height })); }}>
        <div className="camera-modes tactical-toolbar" role="toolbar" aria-label="Camera mode"><span>View</span><button className={cameraMode === 'tactical' ? 'active' : ''} aria-pressed={cameraMode === 'tactical'} onClick={() => changeCameraMode('tactical')}>Tactical</button>{canUsePerspective ? <><button className={cameraMode === 'overview' ? 'active' : ''} aria-pressed={cameraMode === 'overview'} onClick={() => changeCameraMode('overview')}>Overview</button><button className={cameraMode === 'follow' ? 'active' : ''} aria-pressed={cameraMode === 'follow'} onClick={() => changeCameraMode('follow')}>Follow</button>{cameraMode === 'overview' && <button className={presentationMode === 'cutaway' ? 'active' : ''} aria-pressed={presentationMode === 'cutaway'} onClick={() => setPresentationMode((current) => current === 'exterior' ? 'cutaway' : 'exterior')}>{presentationMode === 'cutaway' ? 'Exterior' : 'Cutaway'}</button>}{cameraMode !== 'tactical' && <><button onClick={() => orbitCamera('yaw', -.22)} aria-label="Orbit left">↶</button><button onClick={() => orbitCamera('yaw', .22)} aria-label="Orbit right">↷</button><button onClick={() => orbitCamera('pitch', .12)} aria-label="Tilt up">↑</button><button onClick={() => orbitCamera('pitch', -.12)} aria-label="Tilt down">↓</button><button onClick={() => orbitCamera('distance', .82)} aria-label="Zoom in">+</button><button onClick={() => orbitCamera('distance', 1.22)} aria-label="Zoom out">−</button></>}</> : <span className="camera-unavailable" role="status">3D view unavailable</span>}{scene.controls.perspective.canSet && <button className="camera-policy" aria-pressed={scene.controls.perspective.enabled === true} onClick={() => setPerspectiveAccess(scene.controls.perspective.enabled !== true)}>{scene.controls.perspective.enabled === true ? 'Players can view 3D' : 'Allow player 3D'}</button>}</div>
         {!restricted && cameraMode === 'tactical' && canEditGeometry && <div className="editor-tools tactical-toolbar" role="toolbar" aria-label="DM geometry tools"><span>Build</span><button className={wallTool ? 'active' : ''} aria-pressed={wallTool} onClick={toggleWallTool} disabled={!connected || !scene.controls.geometry.canCreateWall}>Wall</button><button className={structureTool === 'block' ? 'active' : ''} aria-pressed={structureTool === 'block'} onClick={() => useStructureTool('block')} disabled={!connected || !scene.controls.geometry.canCreateStructure}>Block</button><button className={structureTool === 'floor' ? 'active' : ''} aria-pressed={structureTool === 'floor'} onClick={() => useStructureTool('floor')} disabled={!connected || !scene.controls.geometry.canCreateStructure}>Floor</button><button className={structureTool === 'roof' ? 'active' : ''} aria-pressed={structureTool === 'roof'} onClick={() => useStructureTool('roof')} disabled={!connected || !scene.controls.geometry.canCreateStructure}>Roof</button>{(wallTool || structureTool) && <button onClick={() => { setWallTool(false); setStructureTool(undefined); setWallDraft(undefined); }}>Cancel</button>}</div>}
    <div className="canvas-tools tactical-toolbar" role="toolbar" aria-label="Map view"><button onClick={() => setView((value) => ({ ...value, x: value.x - 120 / value.zoom }))} aria-label="Pan left">←</button><button onClick={() => setView((value) => ({ ...value, x: value.x + 120 / value.zoom }))} aria-label="Pan right">→</button><button onClick={() => setView((value) => ({ ...value, zoom: Math.min(8, value.zoom * 1.25) }))} aria-label="Zoom in">+</button><button onClick={() => setView((value) => ({ ...value, zoom: Math.max(.03, value.zoom / 1.25) }))} aria-label="Zoom out">−</button><button onClick={fit}>Fit</button><button onClick={() => setView({ x: 1000, y: 600, zoom: .5 })}>Reset</button></div>
        {!restricted && scene.controls.fog.canCommit && <div className="fog-tools tactical-toolbar" role="toolbar" aria-label="Fog tools"><span>Fog</span><button className={fogTool?.kind === 'reveal' && fogTool.shape === 'rectangle' ? 'active' : ''} aria-pressed={fogTool?.kind === 'reveal' && fogTool.shape === 'rectangle'} disabled={!connected || commandBusy} onClick={() => useFogTool({ kind: 'reveal', shape: 'rectangle' })}>Reveal box</button><button className={fogTool?.kind === 'conceal' && fogTool.shape === 'rectangle' ? 'active' : ''} aria-pressed={fogTool?.kind === 'conceal' && fogTool.shape === 'rectangle'} disabled={!connected || commandBusy} onClick={() => useFogTool({ kind: 'conceal', shape: 'rectangle' })}>Hide box</button><button className={fogTool?.kind === 'reveal' && fogTool.shape === 'polygon' ? 'active' : ''} aria-pressed={fogTool?.kind === 'reveal' && fogTool.shape === 'polygon'} disabled={!connected || commandBusy} onClick={() => useFogTool({ kind: 'reveal', shape: 'polygon' })}>Reveal poly</button><button className={fogTool?.kind === 'conceal' && fogTool.shape === 'polygon' ? 'active' : ''} aria-pressed={fogTool?.kind === 'conceal' && fogTool.shape === 'polygon'} disabled={!connected || commandBusy} onClick={() => useFogTool({ kind: 'conceal', shape: 'polygon' })}>Hide poly</button>{fogTool?.shape === 'polygon' && <button disabled={!connected || fogPoints.length < 3 || commandBusy} onClick={() => void finishFogPolygon()}>Finish</button>}<button disabled={!connected || !scene.controls.fog.latestOperationId || !scene.controls.fog.canUndo || commandBusy} onClick={() => void undoFog()}>Undo</button><button disabled={!connected || scene.fog.mode === 'disabled' || !scene.controls.fog.canClear || commandBusy} onClick={() => void clearFog()}>Clear</button>{fogTool && <button onClick={() => { setFogTool(undefined); setFogPoints([]); }}>Cancel</button>}</div>}
        <div className={`annotation-tools tactical-toolbar${scene.controls.fog.canCommit ? ' below-fog' : ''}`} role="toolbar" aria-label="Map tools"><span>Tools</span>{canDraw && <><button className={drawingTool === 'line' ? 'active' : ''} aria-pressed={drawingTool === 'line'} disabled={!connected || commandBusy} onClick={() => useDrawingTool('line')}>Line</button><button className={drawingTool === 'rectangle' ? 'active' : ''} aria-pressed={drawingTool === 'rectangle'} disabled={!connected || commandBusy} onClick={() => useDrawingTool('rectangle')}>Box</button><button className={drawingTool === 'ellipse' ? 'active' : ''} aria-pressed={drawingTool === 'ellipse'} disabled={!connected || commandBusy} onClick={() => useDrawingTool('ellipse')}>Ellipse</button><button className={drawingTool === 'polygon' ? 'active' : ''} aria-pressed={drawingTool === 'polygon'} disabled={!connected || commandBusy} onClick={() => useDrawingTool('polygon')}>Polygon</button><button className={drawingTool === 'path' ? 'active' : ''} aria-pressed={drawingTool === 'path'} disabled={!connected || commandBusy} onClick={() => useDrawingTool('path')}>Freehand</button>{drawingTool === 'polygon' && <button disabled={!connected || drawingPoints.length < 3 || commandBusy} onClick={() => void finishDrawing()}>Finish</button>}<label title="Drawing color"><input aria-label="Drawing color" type="color" value={drawingColor} onChange={(event) => setDrawingColor(event.target.value)} /></label><select aria-label="Drawing width" value={drawingWidth} onChange={(event) => setDrawingWidth(Number(event.target.value))}><option value="2">Thin</option><option value="4">Medium</option><option value="8">Heavy</option></select><button disabled={!connected || !Object.keys(scene.drawings).length || commandBusy} onClick={() => void undoDrawing()}>Undo draw</button></>}<button className={rulerTool ? 'active' : ''} aria-pressed={rulerTool} onClick={useRuler}>Ruler</button><select aria-label="Diagonal distance rule" value={rulerRule} onChange={(event) => setRulerRule(event.target.value as DiagonalDistanceRule)}><option value="five-ten-five">5-10-5</option><option value="euclidean">Euclidean</option><option value="manhattan">Manhattan</option></select><button className={pingTool ? 'active' : ''} aria-pressed={pingTool} disabled={!connected || commandBusy} onClick={usePing}>Ping</button></div>
        {!scene.map && <div className="empty-map"><strong>No map set</strong><span>{scene.controls.tokens.canCreate ? 'Upload a map to begin the encounter.' : 'Your DM is preparing the table.'}</span></div>}
        <TacticalRenderer scene={scene} mapAsset={mapAsset} tokenAssets={tokenAssets} view={view} viewport={viewport} selectedId={selectedToken} canMove={cameraMode === 'tactical' ? canMove : () => false} onSelect={setSelectedToken} onMapClick={handleMapClick} onTokenDrag={previewToken} onTokenCommit={commitToken} ensureUrls={ensureUrls} isDm={scene.controls.geometry.canUpdateWall || scene.controls.geometry.canUpdateStructure} viewerId={session.user.id} fogDraft={cameraMode === 'tactical' && fogTool ? { kind: fogTool.kind, points: fogPoints } satisfies FogDraft : undefined} drawingDraft={cameraMode === 'tactical' ? drawingDraft : undefined} ruler={cameraMode === 'tactical' ? ruler : undefined} pings={cameraMode === 'tactical' ? pings : []} cameraMode={cameraMode} presentationMode={presentationMode} orbitAction={orbitAction} selectedWallId={selectedWallId} selectedStructureId={selectedStructureId} wallDraft={wallDraft} endpointDraft={endpointDraft} onSelectWall={(wallId) => { setSelectedWallId(wallId); setSelectedStructureId(undefined); setSelectedToken(undefined); }} onSelectStructure={(structureId) => { setSelectedStructureId(structureId); setSelectedWallId(undefined); setSelectedToken(undefined); }} onWallEndpointPreview={(wallId, endpoint, point) => updateWallEndpoint(wallId, endpoint, point, false)} onWallEndpointCommit={(wallId, endpoint, point) => updateWallEndpoint(wallId, endpoint, point, true)} />
      </section>
      <aside className="inspector">{(selectedWall || selectedStructure) && <TacticalEditorPanel wall={selectedWall} structure={selectedStructure} connected={connected} busy={commandBusy} canUpdateWall={scene.controls.geometry.canUpdateWall} canDeleteWall={scene.controls.geometry.canDeleteWall} canUpdateStructure={scene.controls.geometry.canUpdateStructure} canDeleteStructure={scene.controls.geometry.canDeleteStructure} onApplyWall={applyWall} onDeleteWall={deleteWall} onApplyStructure={applyStructure} onDeleteStructure={deleteStructure} onClose={() => { setSelectedWallId(undefined); setSelectedStructureId(undefined); }} />}<span className="eyebrow">INSPECTOR</span>{token ? <form key={`${token.id}:${tokenControl?.expectedTokenRevision}`} onSubmit={saveToken} className="inspector-form"><h2>{token.label || 'Token'}</h2><label>Label<input name="label" defaultValue={token.label} /></label>{token.hp && <div className="field-pair"><label>HP<input name="hpCurrent" type="number" min="0" defaultValue={token.hp.current} /></label><label>Maximum<input name="hpMaximum" type="number" min="0" defaultValue={token.hp.maximum} /></label></div>}<div className="field-pair"><label>Width<input name="width" type="number" min="1" defaultValue={token.size.width} /></label><label>Height<input name="height" type="number" min="1" defaultValue={token.size.height} /></label></div><label>Rotation<input name="rotation" type="number" defaultValue={token.rotation} /></label><button className="button primary" disabled={!connected || Boolean(pending) || !tokenControl?.canUpdateDetails}>Save token</button><button type="button" className="button secondary" disabled={!connected || Boolean(pending) || !tokenControl?.canDelete} onClick={deleteToken}>Delete token</button><div className="nudge" aria-label="Move token"><button type="button" disabled={!connected || !tokenControl?.canTransform} onClick={() => commitToken(token.id, { x: token.position.x, y: token.position.y - scene.grid.cellSize }, token.rotation)}>↑</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x - scene.grid.cellSize, y: token.position.y }, token.rotation)}>←</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x + scene.grid.cellSize, y: token.position.y }, token.rotation)}>→</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x, y: token.position.y + scene.grid.cellSize }, token.rotation)}>↓</button></div>{tokenControl?.canUpdateDetails === true && <button type="button" className="danger-button" onClick={() => void command('token.delete', { tokenId: token.id, expectedTokenRevision: tokenControl?.expectedTokenRevision }).then(() => setSelectedToken(undefined)).catch(() => undefined)}>Delete token</button>}</form> : scene.controls.movement.canSetPolicy ? <form className="inspector-form" onSubmit={saveGrid}><h2>Square grid</h2><label className="check-field"><input name="visible" type="checkbox" defaultChecked={scene.grid.visible} />Visible</label><label>Cell size<input name="cellSize" type="number" min="1" defaultValue={scene.grid.cellSize} /></label><div className="field-pair"><label>Offset X<input name="offsetX" type="number" defaultValue={scene.grid.offset.x} /></label><label>Offset Y<input name="offsetY" type="number" defaultValue={scene.grid.offset.y} /></label></div><div className="field-pair"><label>Distance<input name="distance" type="number" min="1" defaultValue={scene.grid.distancePerCell} /></label><label>Unit<select name="unit" defaultValue={scene.grid.unit}><option value="ft">feet</option><option value="m">metres</option></select></label></div><label className="check-field"><input name="snap" type="checkbox" defaultChecked={scene.grid.snap} />Snap tokens</label><button className="button primary" disabled={!connected || Boolean(pending)}>Save grid</button><label className="check-field"><input type="checkbox" checked={scene.controls.movement.policy === 'all'} onChange={(event) => void command('permissions.playerMovement.set', { playerMovement: event.target.checked ? 'all' : 'owned' }).catch(() => undefined)} />Shared movement</label></form> : <div className="inspector-empty"><strong>Select a token</strong><p>Choose one of your tokens on the map to move or edit it.</p></div>}</aside>
    </div>
  </main>;
}
