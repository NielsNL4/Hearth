import { useRef } from 'react';
import { screenToWorld, worldToScreen, type Point } from '@hearth/scene';
import type { ProjectionStructure as StructureRecord, ProjectionWall as WallRecord } from '../../lib/projectionModel';
import type { ViewState } from '../TacticalRenderer';

export type WallEndpointDraft = { wallId: string; start: Point; end: Point };

interface TacticalEditorOverlayProps {
  scene: { walls: Record<string, WallRecord>; structures: Record<string, StructureRecord> };
  view: ViewState;
  viewport: { width: number; height: number };
  selectedWallId?: string;
  selectedStructureId?: string;
  wallDraft?: { start: Point; end?: Point; snapped?: boolean };
  endpointDraft?: WallEndpointDraft;
  onSelectWall(wallId: string): void;
  onSelectStructure(structureId: string): void;
  onWallEndpointPreview(wallId: string, endpoint: 'start' | 'end', point: Point): void;
  onWallEndpointCommit(wallId: string, endpoint: 'start' | 'end', point: Point): void;
}

function structureCorners(structure: StructureRecord): Point[] {
  const angle = structure.rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [{ x: -structure.size.width / 2, y: -structure.size.height / 2 }, { x: structure.size.width / 2, y: -structure.size.height / 2 }, { x: structure.size.width / 2, y: structure.size.height / 2 }, { x: -structure.size.width / 2, y: structure.size.height / 2 }]
    .map((point) => ({ x: structure.position.x + point.x * cosine - point.y * sine, y: structure.position.y + point.x * sine + point.y * cosine }));
}

function pointString(points: readonly Point[], view: ViewState, viewport: { width: number; height: number }): string {
  return points.map((point) => { const screen = worldToScreen(point, view, viewport); return `${screen.x},${screen.y}`; }).join(' ');
}

export function TacticalEditorOverlay({ scene, view, viewport, selectedWallId, selectedStructureId, wallDraft, endpointDraft, onSelectWall, onSelectStructure, onWallEndpointPreview, onWallEndpointCommit }: TacticalEditorOverlayProps) {
  const drag = useRef<{ wallId: string; endpoint: 'start' | 'end'; pointerId: number } | undefined>(undefined);
  const screenPoint = (event: React.PointerEvent<SVGCircleElement>) => {
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    return screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, view, viewport);
  };
  const endpoint = (wall: WallRecord, side: 'start' | 'end') => endpointDraft?.wallId === wall.wallId ? endpointDraft[side] : wall[side];
  const handleDown = (event: React.PointerEvent<SVGCircleElement>, wallId: string, side: 'start' | 'end') => {
    event.stopPropagation(); drag.current = { wallId, endpoint: side, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleMove = (event: React.PointerEvent<SVGCircleElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.stopPropagation(); onWallEndpointPreview(drag.current.wallId, drag.current.endpoint, screenPoint(event));
  };
  const handleUp = (event: React.PointerEvent<SVGCircleElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.stopPropagation(); const current = drag.current; drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onWallEndpointCommit(current.wallId, current.endpoint, screenPoint(event));
  };
  const handleCancel = (event: React.PointerEvent<SVGCircleElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.stopPropagation(); const current = drag.current; drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const wall = scene.walls[current.wallId];
    if (wall) onWallEndpointPreview(current.wallId, current.endpoint, wall[current.endpoint]);
  };
  return <svg className="tactical-editor-overlay" width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-label="Tactical geometry editor">
    <g className="structure-editor-layer">{Object.values(scene.structures).map((structure) => <polygon key={structure.structureId} points={pointString(structureCorners(structure), view, viewport)} className={selectedStructureId === structure.structureId ? `structure-outline selected ${structure.structureKind}` : `structure-outline ${structure.structureKind}`} tabIndex={0} role="button" aria-label={`Select ${structure.structureKind} ${structure.label || structure.structureId}`} onClick={() => onSelectStructure(structure.structureId)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectStructure(structure.structureId); }} />)}</g>
    <g className="wall-editor-layer">{Object.values(scene.walls).map((wall) => {
      const start = endpoint(wall, 'start'); const end = endpoint(wall, 'end');
      const a = worldToScreen(start, view, viewport); const b = worldToScreen(end, view, viewport);
      return <g key={wall.wallId} className={selectedWallId === wall.wallId ? 'wall-outline selected' : 'wall-outline'}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wall-editor-line" onClick={() => onSelectWall(wall.wallId)} />
        {selectedWallId === wall.wallId && <>{(['start', 'end'] as const).map((side) => { const point = side === 'start' ? start : end; const screen = worldToScreen(point, view, viewport); return <circle key={side} cx={screen.x} cy={screen.y} r="8" className="wall-endpoint" tabIndex={0} role="button" onPointerDown={(event) => handleDown(event, wall.wallId, side)} onPointerMove={handleMove} onPointerUp={handleUp} onPointerCancel={handleCancel} aria-label={`Drag ${side} endpoint`} />; })}</>}
      </g>;
    })}</g>
    {wallDraft && <g className="wall-draft"><line x1={worldToScreen(wallDraft.start, view, viewport).x} y1={worldToScreen(wallDraft.start, view, viewport).y} x2={worldToScreen(wallDraft.end ?? wallDraft.start, view, viewport).x} y2={worldToScreen(wallDraft.end ?? wallDraft.start, view, viewport).y} /><circle cx={worldToScreen(wallDraft.start, view, viewport).x} cy={worldToScreen(wallDraft.start, view, viewport).y} r="6" /><circle cx={worldToScreen(wallDraft.end ?? wallDraft.start, view, viewport).x} cy={worldToScreen(wallDraft.end ?? wallDraft.start, view, viewport).y} r="6" className={wallDraft.snapped ? 'snapped' : ''} /></g>}
  </svg>;
}
