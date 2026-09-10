import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createEmptyScene, snapPoint, type Point, type SceneV2, type TokenRecord } from '@hearth/scene';
import { createMultiplayerConnection, getConnectedUserIds, roomSchemaToScene, sceneToRoomSchema, type ColyseusClientLike, type ColyseusRoomLike, type ConnectionStatus, type MultiplayerConnection, type RoomAssetSummary } from '@hearth/sync';
import { useSession } from '../auth/AuthProvider';
import { rooms } from '../lib/client';
import { getDownloadUrls, getManifest, uploadAsset, waitForManifest, type AssetManifest, type AssetReservation } from '../lib/assets';
import { TacticalRenderer, type ViewState } from '../components/TacticalRenderer';
import { Notice } from '../components/UI';

type LoadedAsset = RoomAssetSummary & { manifest?: AssetManifest; urls: Record<string, string>; urlsExpireAt: number };
const id = () => crypto.randomUUID();

declare global {
  interface Window { __HEARTH_E2E__?: { scene: SceneV2; commands: Array<{ type: string; message: unknown }> } }
}

function e2eClient(): ColyseusClientLike | undefined {
  const harness = import.meta.env.DEV ? window.__HEARTH_E2E__ : undefined;
  if (!harness) return undefined;
  return {
    async joinOrCreate() {
      const listeners = new Map<string | number, (message: unknown) => void>();
      const room: ColyseusRoomLike = {
        state: sceneToRoomSchema(harness.scene), reconnectionToken: 'e2e-reconnection', send(type, message) {
          harness.commands.push({ type, message });
          const command = message as { commandId?: string; payload?: { kind?: string } };
          if (command.commandId) queueMicrotask(() => listeners.get('command.result')?.({ type, commandId: command.commandId, ok: true, sceneRevision: 1,
            result: type === 'asset.reserve' ? { id: command.payload?.kind === 'map' ? '00000000-0000-4000-8000-000000000101' : '00000000-0000-4000-8000-000000000102', roomId: 'e2e', status: 'reserved' } : undefined }));
        }, leave() {}, onStateChange() {}, onMessage(type, callback) { listeners.set(type, callback); }, onLeave() {}, onError() {},
      };
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
  const [scene, setScene] = useState<SceneV2>(createEmptyScene);
  const [members, setMembers] = useState<Awaited<ReturnType<NonNullable<typeof rooms>['getLobby']>>['members']>([]);
  const [assets, setAssets] = useState<Record<string, LoadedAsset>>({});
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [selectedToken, setSelectedToken] = useState<string>();
  const [view, setView] = useState<ViewState>({ x: 1000, y: 600, zoom: 0.5 });
  const [viewport, setViewport] = useState({ width: 900, height: 600 });

  const me = members.find((member) => member.user_id === session.user.id);
  const isDm = me?.role === 'dm';
  const token = selectedToken ? scene.tokens[selectedToken] : undefined;

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
    void rooms!.getLobby(roomId).then((lobby) => active && setMembers(lobby.members)).catch((cause) => active && setError(String(cause)));
    void refreshAssets().catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    const endpoint = String(import.meta.env.VITE_MULTIPLAYER_URL || '');
    if (!endpoint) { setError('VITE_MULTIPLAYER_URL is not configured.'); return () => { active = false; }; }
    const next = createMultiplayerConnection({ endpoint, roomId, accessToken: session.access_token, storage: sessionStorage, client: e2eClient(),
      onState: (state) => { if (active) { try { setScene(roomSchemaToScene(state)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } } },
      onStatus: (value) => active && setStatus(value), onError: (cause) => active && setError(cause.message),
    });
    connection.current = next;
    void next.connect().catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; connection.current = undefined; void next.disconnect(); };
  }, [roomId, session.access_token]);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);

  async function command(type: Parameters<MultiplayerConnection['request']>[0], payload: unknown) {
    setPending(type); setError('');
    try { return await connection.current!.request(type, { commandId: id(), payload }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setPending(''); }
  }

  async function onUpload(kind: 'map' | 'token', event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setUploadProgress(0); setError('');
    try {
      const result = await command('asset.reserve', { kind, sourceMetadata: { name: file.name, contentType: file.type, bytes: file.size } });
      const reservation = result!.result as AssetReservation;
      await uploadAsset(session, reservation, file, setUploadProgress);
      const manifest = await waitForManifest(session, reservation.id);
      await refreshAssets();
      if (kind === 'map') {
        await command('map.set', { map: { assetId: reservation.id, width: manifest.width, height: manifest.height } });
        setView({ x: manifest.width / 2, y: manifest.height / 2, zoom: Math.min(viewport.width / manifest.width, viewport.height / manifest.height) * .9 });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploadProgress(undefined); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function canMove(candidate: TokenRecord) { return Boolean(isDm || candidate.ownerId === session.user.id || scene.permissions.playerMovement === 'all'); }
  function placeToken(point: Point) {
    if (!selectedAsset) return;
    const position = scene.grid.snap ? snapPoint(point, scene.grid.cellSize, scene.grid.offset) : point;
    const tokenId = id();
    void command('token.create', { token: { id: tokenId, assetId: selectedAsset, position, size: { width: scene.grid.cellSize, height: scene.grid.cellSize }, rotation: 0, label: 'New token', ownerId: session.user.id, hpCurrent: 0, hpMaximum: 0, hpHidden: false, z: Object.keys(scene.tokens).length } }).then(() => { setSelectedAsset(undefined); setSelectedToken(tokenId); }).catch(() => undefined);
  }
  function previewToken(tokenId: string, point: Point, rotation: number) {
    setScene((current) => ({ ...current, tokens: { ...current.tokens, [tokenId]: { ...current.tokens[tokenId]!, position: point } } }));
    if (Date.now() - previewAt.current > 80) { previewAt.current = Date.now(); connection.current?.send('token.transform.preview', { tokenId, sequence: ++previewSequence.current, position: point, rotation }); }
  }
  function commitToken(tokenId: string, point: Point, rotation: number) {
    const current = scene.tokens[tokenId]; if (!current) return;
    const position = scene.grid.snap ? snapPoint(point, scene.grid.cellSize, scene.grid.offset) : point;
    void command('token.transform.commit', { tokenId, expectedTokenRevision: current.revision, position, rotation }).catch(() => undefined);
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
    event.preventDefault(); if (!token) return; const data = new FormData(event.currentTarget);
    await command('token.details.update', { tokenId: token.id, expectedTokenRevision: token.revision, details: { label: String(data.get('label')), ownerId: String(data.get('ownerId')), hpCurrent: Number(data.get('hpCurrent')), hpMaximum: Number(data.get('hpMaximum')), hpHidden: data.get('hpHidden') === 'on', size: { width: Number(data.get('width')), height: Number(data.get('height')) } } }).catch(() => undefined);
    const rotation = Number(data.get('rotation'));
    if (rotation !== token.rotation) await command('token.transform.commit', { tokenId: token.id, expectedTokenRevision: token.revision + 1, position: token.position, rotation }).catch(() => undefined);
  }

  const online = connection.current?.getRoom() ? getConnectedUserIds(connection.current.getRoom()!.state) : new Set<string>();
  const candidateMapAsset = scene.map ? assets[scene.map.assetId] : undefined;
  const mapAsset = candidateMapAsset?.manifest ? { manifest: candidateMapAsset.manifest, urls: candidateMapAsset.urls } : undefined;
  const tokenAssets = Object.fromEntries(Object.values(assets).filter((asset) => asset.kind === 'token' && asset.manifest).map((asset) => [asset.id, { manifest: asset.manifest!, urls: asset.urls }]));
  return <main className="tactical-page">
    <header className="tactical-header"><Link to={`/rooms/${roomId}`} className="table-back">‹ Lobby</Link><div><span className="eyebrow">LIVE ENCOUNTER</span><strong>Tactical table</strong></div><span className={`connection-badge ${status === 'online' ? 'connected' : ''}`} role="status"><span className="live-dot" />{status === 'online' ? `${Math.max(online.size, 1)} online` : status}</span></header>
    {error && <div className="table-notice"><Notice error>{error} <button className="inline-button" onClick={() => window.location.reload()}>Reconnect</button></Notice></div>}
    <div className="tactical-shell">
      <aside className="asset-rail"><div className="rail-heading"><span>Tokens</span><label className="upload-button">+ Upload<input className="sr-only" type="file" accept="image/*" onChange={(event) => onUpload('token', event)} /></label></div>
        <div className="token-palette" aria-label="Token palette">{Object.values(assets).filter((asset) => asset.kind === 'token').map((asset) => { const image = asset.manifest?.outputs.find((output) => output.type === 'thumbnail' || output.type === 'image'); return <button key={asset.id} className={selectedAsset === asset.id ? 'active' : ''} onClick={() => setSelectedAsset(asset.id)} aria-label="Place token image">{image && asset.urls[image.key] ? <img src={asset.urls[image.key]} alt="" /> : <span>?</span>}</button>; })}</div>
        {isDm && <label className="button secondary full map-upload">Upload map<input className="sr-only" type="file" accept="image/*" onChange={(event) => onUpload('map', event)} /></label>}
        {uploadProgress !== undefined && <div className="upload-progress" role="progressbar" aria-valuenow={uploadProgress}><i style={{ width: `${uploadProgress}%` }} /><span>{uploadProgress}%</span></div>}
      </aside>
      <section className="table-stage" ref={stage} onWheel={(event) => { event.preventDefault(); setView((value) => ({ ...value, zoom: Math.max(.03, Math.min(8, value.zoom * Math.exp(-event.deltaY * .001))) })); }}>
        <div className="canvas-tools"><button onClick={() => setView((value) => ({ ...value, x: value.x - 120 / value.zoom }))} aria-label="Pan left">←</button><button onClick={() => setView((value) => ({ ...value, x: value.x + 120 / value.zoom }))} aria-label="Pan right">→</button><button onClick={() => setView((value) => ({ ...value, zoom: Math.min(8, value.zoom * 1.25) }))} aria-label="Zoom in">+</button><button onClick={() => setView((value) => ({ ...value, zoom: Math.max(.03, value.zoom / 1.25) }))} aria-label="Zoom out">−</button><button onClick={fit}>Fit</button><button onClick={() => setView({ x: 1000, y: 600, zoom: .5 })}>Reset</button></div>
        {!scene.map && <div className="empty-map"><strong>No map set</strong><span>{isDm ? 'Upload a map to begin the encounter.' : 'Your DM is preparing the table.'}</span></div>}
        <TacticalRenderer scene={scene} mapAsset={mapAsset} tokenAssets={tokenAssets} view={view} viewport={viewport} selectedId={selectedToken} canMove={canMove} onSelect={setSelectedToken} onMapClick={placeToken} onTokenDrag={previewToken} onTokenCommit={commitToken} ensureUrls={ensureUrls} />
      </section>
      <aside className="inspector"><span className="eyebrow">INSPECTOR</span>{token ? <form key={`${token.id}:${token.revision}`} onSubmit={saveToken} className="inspector-form"><h2>{token.label || 'Token'}</h2><label>Label<input name="label" defaultValue={token.label} /></label><label>Owner<select name="ownerId" defaultValue={token.ownerId}>{members.map((member) => <option value={member.user_id} key={member.user_id}>{member.display_name}</option>)}</select></label><div className="field-pair"><label>HP<input name="hpCurrent" type="number" min="0" defaultValue={token.hpCurrent} /></label><label>Maximum<input name="hpMaximum" type="number" min="0" defaultValue={token.hpMaximum} /></label></div><div className="field-pair"><label>Width<input name="width" type="number" min="1" defaultValue={token.size.width} /></label><label>Height<input name="height" type="number" min="1" defaultValue={token.size.height} /></label></div><label>Rotation<input name="rotation" type="number" defaultValue={token.rotation} /></label><label className="check-field"><input name="hpHidden" type="checkbox" defaultChecked={token.hpHidden} />Hide HP</label><button className="button primary" disabled={Boolean(pending)}>Save token</button><div className="nudge" aria-label="Move token"><button type="button" onClick={() => commitToken(token.id, { x: token.position.x, y: token.position.y - scene.grid.cellSize }, token.rotation)}>↑</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x - scene.grid.cellSize, y: token.position.y }, token.rotation)}>←</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x + scene.grid.cellSize, y: token.position.y }, token.rotation)}>→</button><button type="button" onClick={() => commitToken(token.id, { x: token.position.x, y: token.position.y + scene.grid.cellSize }, token.rotation)}>↓</button></div>{(isDm || token.ownerId === session.user.id) && <button type="button" className="danger-button" onClick={() => void command('token.delete', { tokenId: token.id, expectedTokenRevision: token.revision }).then(() => setSelectedToken(undefined)).catch(() => undefined)}>Delete token</button>}</form> : isDm ? <form className="inspector-form" onSubmit={saveGrid}><h2>Square grid</h2><label className="check-field"><input name="visible" type="checkbox" defaultChecked={scene.grid.visible} />Visible</label><label>Cell size<input name="cellSize" type="number" min="1" defaultValue={scene.grid.cellSize} /></label><div className="field-pair"><label>Offset X<input name="offsetX" type="number" defaultValue={scene.grid.offset.x} /></label><label>Offset Y<input name="offsetY" type="number" defaultValue={scene.grid.offset.y} /></label></div><div className="field-pair"><label>Distance<input name="distance" type="number" min="1" defaultValue={scene.grid.distancePerCell} /></label><label>Unit<select name="unit" defaultValue={scene.grid.unit}><option value="ft">feet</option><option value="m">metres</option></select></label></div><label className="check-field"><input name="snap" type="checkbox" defaultChecked={scene.grid.snap} />Snap tokens</label><button className="button primary" disabled={Boolean(pending)}>Save grid</button><label className="check-field"><input type="checkbox" checked={scene.permissions.playerMovement === 'all'} onChange={(event) => void command('permissions.playerMovement.set', { playerMovement: event.target.checked ? 'all' : 'owned' }).catch(() => undefined)} />Shared movement</label></form> : <div className="inspector-empty"><strong>Select a token</strong><p>Choose one of your tokens on the map to move or edit it.</p></div>}</aside>
    </div>
  </main>;
}
