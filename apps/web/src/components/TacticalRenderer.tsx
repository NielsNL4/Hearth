import { Canvas, type ThreeEvent, useLoader, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useState } from 'react';
import { ClampToEdgeWrapping, SRGBColorSpace, TextureLoader } from 'three';
import { screenToWorld, worldToScreen, type Point } from '@hearth/scene';
import type { AssetManifest, ManifestOutput } from '../lib/assets';
import type { CameraMode } from '../lib/camera';
import { CameraController, type CameraOrbitAction } from './tactical/CameraController';
import { StructureMeshes, type StructurePresentation } from './tactical/StructureMeshes';
import type { TacticalProjectionModel, ProjectionToken as TokenRecord } from '../lib/projectionModel';
import { projectionIsRestricted } from '../lib/projectionModel';
import { TacticalEditorOverlay, type WallEndpointDraft } from './tactical/TacticalEditorOverlay';

export interface ViewState { x: number; y: number; zoom: number }
interface SignedAsset { manifest: AssetManifest; urls: Record<string, string> }
export interface FogDraft { kind: 'reveal' | 'conceal'; points: Point[] }
export interface DrawingDraft { kind: 'line' | 'polygon'; points: Point[]; color: string; width: number; fill: string | null }
export interface RulerDraft { start: Point; end: Point; label: string }
export interface PingMarker { id: string; position: Point; color: string; displayName: string }

function TacticalOverlay({ scene, view, viewport, isDm, viewerId, fogDraft, drawingDraft, ruler, pings }: {
  scene: TacticalProjectionModel; view: ViewState; viewport: { width: number; height: number }; isDm: boolean; viewerId: string; fogDraft?: FogDraft;
  drawingDraft?: DrawingDraft; ruler?: RulerDraft; pings: PingMarker[];
}) {
  if (!scene.map) return null;
  const screen = (point: Point) => worldToScreen(point, view, viewport);
  const polygon = (points: readonly Point[]) => points.map((point) => { const value = screen(point); return `${value.x},${value.y}`; }).join(' ');
  const drawings = Object.values(scene.drawings).sort((a, b) => a.z - b.z);
  return <svg className="tactical-overlay" data-sight-mode={scene.sight.mode} data-sight-region-count={scene.sight.mode === 'restricted' ? scene.sight.polygons.length : 'unrestricted'} width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true">
    <g className="drawing-layer">{drawings.map((drawing) => drawing.kind === 'polygon'
      ? <polygon key={drawing.id} points={polygon(drawing.points)} fill={drawing.fill ?? 'none'} stroke={drawing.color} strokeWidth={drawing.width * view.zoom} strokeLinejoin="round" />
      : <polyline key={drawing.id} points={polygon(drawing.points)} fill="none" stroke={drawing.color} strokeWidth={drawing.width * view.zoom} strokeLinecap="round" strokeLinejoin="round" />)}</g>
    {fogDraft && fogDraft.points.length >= 2 && <polyline points={polygon(fogDraft.points)} fill={fogDraft.points.length >= 3 ? (fogDraft.kind === 'reveal' ? '#6bd89a33' : '#d0776733') : 'none'} stroke={fogDraft.kind === 'reveal' ? '#75e6a4' : '#e08f7d'} strokeWidth="2" strokeDasharray="6 4" />}
    {fogDraft?.points.map((point, index) => { const value = screen(point); return <circle key={index} cx={value.x} cy={value.y} r="4" fill={fogDraft.kind === 'reveal' ? '#75e6a4' : '#e08f7d'} />; })}
    {drawingDraft && drawingDraft.points.length >= 2 && (drawingDraft.kind === 'polygon'
      ? <polygon points={polygon(drawingDraft.points)} fill={drawingDraft.fill ?? 'none'} stroke={drawingDraft.color} strokeWidth={drawingDraft.width * view.zoom} strokeDasharray="6 4" />
      : <polyline points={polygon(drawingDraft.points)} fill="none" stroke={drawingDraft.color} strokeWidth={drawingDraft.width * view.zoom} strokeDasharray="6 4" />)}
    {ruler && <g className="ruler-layer"><line x1={screen(ruler.start).x} y1={screen(ruler.start).y} x2={screen(ruler.end).x} y2={screen(ruler.end).y} stroke="#f1d58d" strokeWidth="2" strokeDasharray="8 5" /><text x={screen(ruler.end).x + 8} y={screen(ruler.end).y - 8}>{ruler.label}</text></g>}
    {pings.map((ping) => { const value = screen(ping.position); return <g key={ping.id} className="ping-marker" transform={`translate(${value.x} ${value.y})`}><circle r="9" fill="none" stroke={ping.color} strokeWidth="3" /><circle r="3" fill={ping.color} /><text x="13" y="4">{ping.displayName}</text></g>; })}
  </svg>;
}

function ImagePlane({ url, width, height, position }: { url: string; width: number; height: number; position: [number, number, number] }) {
  const texture = useLoader(TextureLoader, url);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  return <mesh position={position}><planeGeometry args={[width, height]} /><meshBasicMaterial map={texture} transparent toneMapped={false} /></mesh>;
}

function MapTiles({ scene, asset, view, viewport, ensureUrls }: { scene: TacticalProjectionModel & { map: NonNullable<TacticalProjectionModel['map']> }; asset: SignedAsset; view: ViewState; viewport: { width: number; height: number }; ensureUrls(assetId: string, keys: string[]): void }) {
  const tiles = asset.manifest.outputs.filter((output) => output.type === 'tile' && output.z !== undefined);
  const maxZ = Math.max(0, ...tiles.map((tile) => tile.z!));
  const desiredZ = Math.max(0, Math.min(maxZ, Math.round(maxZ + Math.log2(view.zoom))));
  const level = tiles.filter((tile) => tile.z === desiredZ);
  const scale = 2 ** (maxZ - desiredZ);
  const halfW = viewport.width / (2 * view.zoom);
  const halfH = viewport.height / (2 * view.zoom);
  const bounds = { left: view.x - halfW, right: view.x + halfW, top: view.y - halfH, bottom: view.y + halfH };
  const visible = level.filter((tile) => {
    const x = tile.x! * 512 * scale;
    const y = tile.y! * 512 * scale;
    return x + tile.width * scale >= bounds.left && x <= bounds.right && y + tile.height * scale >= bounds.top && y <= bounds.bottom;
  });
  const missing = visible.filter((tile) => !asset.urls[tile.key]).map((tile) => tile.key);
  useEffect(() => { if (missing.length) ensureUrls(asset.manifest.assetId, missing); }, [asset.manifest.assetId, ensureUrls, missing.join('|')]);
  return <>{visible.map((tile) => {
    const width = tile.width * scale;
    const height = tile.height * scale;
    const x = tile.x! * 512 * scale;
    const y = tile.y! * 512 * scale;
    const url = asset.urls[tile.key];
    return url && <ImagePlane key={tile.key} url={url} width={width} height={height}
      position={[x + width / 2 - scene.map.width / 2, scene.map.height / 2 - y - height / 2, 0]} />;
  })}</>;
}

function Grid({ scene }: { scene: TacticalProjectionModel }) {
  if (!scene.map || !scene.grid.visible) return null;
  const { width, height } = scene.map;
  const { cellSize, offset } = scene.grid;
  const vertices: number[] = [];
  for (let x = ((offset.x % cellSize) + cellSize) % cellSize; x <= width; x += cellSize) vertices.push(x - width / 2, height / 2, 1, x - width / 2, -height / 2, 1);
  for (let y = ((offset.y % cellSize) + cellSize) % cellSize; y <= height; y += cellSize) vertices.push(-width / 2, height / 2 - y, 1, width / 2, height / 2 - y, 1);
  return <lineSegments><bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(vertices), 3]} /></bufferGeometry><lineBasicMaterial color="#b9d8a4" transparent opacity={0.35} /></lineSegments>;
}

function Token({ token, map, asset, selected, active, movable, onSelect, onDrag, onCommit }: {
  token: TokenRecord; map: NonNullable<TacticalProjectionModel['map']>; asset?: SignedAsset; selected: boolean; active: boolean; movable: boolean;
  onSelect(id: string): void; onDrag(id: string, point: Point, rotation: number): void; onCommit(id: string, point: Point, rotation: number): void;
}) {
  const image = asset?.manifest.outputs.find((output) => output.type === 'image');
  const url = image && asset?.urls[image.key];
  const point = (event: ThreeEvent<PointerEvent>) => ({ x: event.point.x + map.width / 2, y: map.height / 2 - event.point.y });
  return <group position={[token.position.x - map.width / 2, map.height / 2 - token.position.y, 4]} rotation={[0, 0, -token.rotation * Math.PI / 180]}>
    <mesh onPointerDown={(event) => { event.stopPropagation(); onSelect(token.id); if (movable) (event.nativeEvent.target as Element).setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { const target = event.nativeEvent.target as Element; if (movable && target.hasPointerCapture(event.pointerId)) { event.stopPropagation(); onDrag(token.id, point(event), token.rotation); } }}
      onPointerUp={(event) => { const target = event.nativeEvent.target as Element; if (movable && target.hasPointerCapture(event.pointerId)) { event.stopPropagation(); target.releasePointerCapture(event.pointerId); onCommit(token.id, point(event), token.rotation); } }}>
      <circleGeometry args={[Math.max(token.size.width, token.size.height) / 2, 48]} />
      {url ? <TokenMaterial url={url} /> : <meshBasicMaterial color="#6f835f" />}
    </mesh>
    {selected && <mesh position={[0, 0, -0.1]}><ringGeometry args={[Math.max(token.size.width, token.size.height) / 2 + 3, Math.max(token.size.width, token.size.height) / 2 + 6, 48]} /><meshBasicMaterial color="#e7ca8b" /></mesh>}
    {active && <mesh position={[0, 0, -0.2]}><ringGeometry args={[Math.max(token.size.width, token.size.height) / 2 + 8, Math.max(token.size.width, token.size.height) / 2 + 12, 48]} /><meshBasicMaterial color="#75e6a4" /></mesh>}
  </group>;
}

function TokenMaterial({ url }: { url: string }) {
  const texture = useLoader(TextureLoader, url);
  texture.colorSpace = SRGBColorSpace;
  return <meshBasicMaterial map={texture} transparent toneMapped={false} />;
}

function CameraUpdater({ view, mapWidth, mapHeight, mode }: { view: ViewState; mapWidth: number; mapHeight: number; mode: CameraMode }) {
  const { get } = useThree();
  useEffect(() => {
    const camera = get().camera;
    camera.position.set(view.x - mapWidth / 2, mapHeight / 2 - view.y, 100);
    camera.zoom = view.zoom;
    camera.updateProjectionMatrix();
  }, [get, mapHeight, mapWidth, mode, view]);
  return null;
}

function PerspectiveLighting() {
  return <>
    <hemisphereLight args={['#d8e7d3', '#14231a', 1.35]} />
    <directionalLight castShadow position={[-360, 280, 620]} intensity={2.2} color="#f2dfb1" shadow-mapSize={[1024, 1024]} />
  </>;
}

export function TacticalRenderer({ scene, mapAsset, tokenAssets, view, viewport, selectedId, canMove, onSelect, onMapClick, onTokenDrag, onTokenCommit, ensureUrls, isDm = false, viewerId = '', fogDraft, drawingDraft, ruler, pings = [], cameraMode = 'tactical', presentationMode = 'exterior', orbitAction, selectedWallId, selectedStructureId, wallDraft, endpointDraft, onSelectWall, onSelectStructure, onWallEndpointPreview, onWallEndpointCommit }: {
  scene: TacticalProjectionModel; mapAsset?: SignedAsset; tokenAssets: Record<string, SignedAsset>; view: ViewState; viewport: { width: number; height: number };
  selectedId?: string; canMove(token: TokenRecord): boolean; onSelect(id?: string): void; onMapClick(point: Point): void;
  onTokenDrag(id: string, point: Point, rotation: number): void; onTokenCommit(id: string, point: Point, rotation: number): void;
  ensureUrls(assetId: string, keys: string[]): void;
  isDm?: boolean; viewerId?: string; fogDraft?: FogDraft; drawingDraft?: DrawingDraft; ruler?: RulerDraft; pings?: PingMarker[];
  cameraMode?: CameraMode; presentationMode?: StructurePresentation; orbitAction?: CameraOrbitAction;
  selectedWallId?: string; selectedStructureId?: string; wallDraft?: { start: Point; end?: Point; snapped?: boolean }; endpointDraft?: WallEndpointDraft;
  onSelectWall?(wallId: string): void; onSelectStructure?(structureId: string): void;
  onWallEndpointPreview?(wallId: string, endpoint: 'start' | 'end', point: Point): void; onWallEndpointCommit?(wallId: string, endpoint: 'start' | 'end', point: Point): void;
}) {
  if (projectionIsRestricted(scene)) {
    return <div className="concealment-surface" data-sight-mode={scene.sight.mode} data-fog-mode={scene.fog.mode} aria-label="Map concealed" />;
  }
  const mapWidth = scene.map?.width ?? 2000;
  const mapHeight = scene.map?.height ?? 1200;
  const activeTokenId = scene.initiative.active && scene.initiative.turnIndex !== null
    ? ('tokenId' in (scene.initiative.entries[scene.initiative.turnIndex] ?? {}) ? (scene.initiative.entries[scene.initiative.turnIndex] as { tokenId?: string } | undefined)?.tokenId : undefined)
    : undefined;
  return <><Canvas orthographic dpr={[1, 1.75]} camera={{ position: [view.x - mapWidth / 2, mapHeight / 2 - view.y, 100], zoom: view.zoom, near: 0.1, far: 100_000 }}
    onPointerMissed={cameraMode === 'tactical' ? (event) => {
      const bounds = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      onMapClick(screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, view, { width: bounds.width, height: bounds.height }));
      onSelect();
    } : undefined}>
    <color attach="background" args={['#0b110e']} />
    <CameraController mode={cameraMode} map={{ width: mapWidth, height: mapHeight }} viewport={viewport} scene={{ map: scene.map, tokens: scene.tokens, initiative: { turnIndex: scene.initiative.turnIndex, entries: scene.initiative.entries.filter((entry): entry is { id: string; tokenId: string; label: string; score: number } => 'tokenId' in entry) } }} selectedTokenId={selectedId} orbitAction={orbitAction} />
    {cameraMode === 'tactical' && <CameraUpdater view={view} mapWidth={mapWidth} mapHeight={mapHeight} mode={cameraMode} />}
    {cameraMode !== 'tactical' && <PerspectiveLighting />}
    <Suspense fallback={null}>{scene.map && mapAsset && <MapTiles scene={scene as TacticalProjectionModel & { map: NonNullable<TacticalProjectionModel['map']> }} asset={mapAsset} view={view} viewport={viewport} ensureUrls={ensureUrls} />}<Grid scene={scene} />
      {cameraMode !== 'tactical' && <StructureMeshes scene={scene} mapWidth={mapWidth} mapHeight={mapHeight} mode={cameraMode === 'overview' ? presentationMode : cameraMode} />}
      {scene.map && Object.values(scene.tokens).sort((a, b) => a.z - b.z).map((token) => <Token key={token.id} token={token} map={scene.map!} asset={tokenAssets[token.assetId]}
        selected={selectedId === token.id} active={activeTokenId === token.id} movable={canMove(token)} onSelect={onSelect} onDrag={onTokenDrag} onCommit={onTokenCommit} />)}
    </Suspense>
  </Canvas>{cameraMode === 'tactical' && <TacticalOverlay scene={scene} view={view} viewport={viewport} isDm={isDm} viewerId={viewerId} fogDraft={fogDraft} drawingDraft={drawingDraft} ruler={ruler} pings={pings} />}{cameraMode === 'tactical' && isDm && onSelectWall && onSelectStructure && onWallEndpointPreview && onWallEndpointCommit && <TacticalEditorOverlay scene={scene} view={view} viewport={viewport} selectedWallId={selectedWallId} selectedStructureId={selectedStructureId} wallDraft={wallDraft} endpointDraft={endpointDraft} onSelectWall={onSelectWall} onSelectStructure={onSelectStructure} onWallEndpointPreview={onWallEndpointPreview} onWallEndpointCommit={onWallEndpointCommit} />}</>;
}
