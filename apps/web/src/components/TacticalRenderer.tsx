import { Canvas, type ThreeEvent, useLoader, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useState } from 'react';
import { ClampToEdgeWrapping, SRGBColorSpace, TextureLoader } from 'three';
import type { Point, SceneV2, TokenRecord } from '@hearth/scene';
import type { AssetManifest, ManifestOutput } from '../lib/assets';

export interface ViewState { x: number; y: number; zoom: number }
interface SignedAsset { manifest: AssetManifest; urls: Record<string, string> }

function ImagePlane({ url, width, height, position }: { url: string; width: number; height: number; position: [number, number, number] }) {
  const texture = useLoader(TextureLoader, url);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  return <mesh position={position}><planeGeometry args={[width, height]} /><meshBasicMaterial map={texture} transparent toneMapped={false} /></mesh>;
}

function MapTiles({ scene, asset, view, viewport, ensureUrls }: { scene: SceneV2 & { map: NonNullable<SceneV2['map']> }; asset: SignedAsset; view: ViewState; viewport: { width: number; height: number }; ensureUrls(assetId: string, keys: string[]): void }) {
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

function Grid({ scene }: { scene: SceneV2 }) {
  if (!scene.map || !scene.grid.visible) return null;
  const { width, height } = scene.map;
  const { cellSize, offset } = scene.grid;
  const vertices: number[] = [];
  for (let x = ((offset.x % cellSize) + cellSize) % cellSize; x <= width; x += cellSize) vertices.push(x - width / 2, height / 2, 1, x - width / 2, -height / 2, 1);
  for (let y = ((offset.y % cellSize) + cellSize) % cellSize; y <= height; y += cellSize) vertices.push(-width / 2, height / 2 - y, 1, width / 2, height / 2 - y, 1);
  return <lineSegments><bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(vertices), 3]} /></bufferGeometry><lineBasicMaterial color="#b9d8a4" transparent opacity={0.35} /></lineSegments>;
}

function Token({ token, map, asset, selected, movable, onSelect, onDrag, onCommit }: {
  token: TokenRecord; map: NonNullable<SceneV2['map']>; asset?: SignedAsset; selected: boolean; movable: boolean;
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
  </group>;
}

function TokenMaterial({ url }: { url: string }) {
  const texture = useLoader(TextureLoader, url);
  texture.colorSpace = SRGBColorSpace;
  return <meshBasicMaterial map={texture} transparent toneMapped={false} />;
}

function CameraUpdater({ view, mapWidth, mapHeight }: { view: ViewState; mapWidth: number; mapHeight: number }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(view.x - mapWidth / 2, mapHeight / 2 - view.y, 100);
    camera.zoom = view.zoom;
    camera.updateProjectionMatrix();
  }, [camera, mapHeight, mapWidth, view]);
  return null;
}

export function TacticalRenderer({ scene, mapAsset, tokenAssets, view, viewport, selectedId, canMove, onSelect, onMapClick, onTokenDrag, onTokenCommit, ensureUrls }: {
  scene: SceneV2; mapAsset?: SignedAsset; tokenAssets: Record<string, SignedAsset>; view: ViewState; viewport: { width: number; height: number };
  selectedId?: string; canMove(token: TokenRecord): boolean; onSelect(id?: string): void; onMapClick(point: Point): void;
  onTokenDrag(id: string, point: Point, rotation: number): void; onTokenCommit(id: string, point: Point, rotation: number): void;
  ensureUrls(assetId: string, keys: string[]): void;
}) {
  const mapWidth = scene.map?.width ?? 2000;
  const mapHeight = scene.map?.height ?? 1200;
  return <Canvas orthographic dpr={[1, 1.75]} camera={{ position: [view.x - mapWidth / 2, mapHeight / 2 - view.y, 100], zoom: view.zoom, near: 0.1, far: 200 }}
    onPointerMissed={(event) => {
      const bounds = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      onMapClick({ x: view.x + (event.clientX - bounds.left - bounds.width / 2) / view.zoom, y: view.y + (event.clientY - bounds.top - bounds.height / 2) / view.zoom });
      onSelect();
    }}>
    <color attach="background" args={['#0b110e']} />
    <CameraUpdater view={view} mapWidth={mapWidth} mapHeight={mapHeight} />
    <Suspense fallback={null}>{scene.map && mapAsset && <MapTiles scene={scene as SceneV2 & { map: NonNullable<SceneV2['map']> }} asset={mapAsset} view={view} viewport={viewport} ensureUrls={ensureUrls} />}<Grid scene={scene} />
      {scene.map && Object.values(scene.tokens).sort((a, b) => a.z - b.z).map((token) => <Token key={token.id} token={token} map={scene.map!} asset={tokenAssets[token.assetId]}
        selected={selectedId === token.id} movable={canMove(token)} onSelect={onSelect} onDrag={onTokenDrag} onCommit={onTokenCommit} />)}
    </Suspense>
  </Canvas>;
}
