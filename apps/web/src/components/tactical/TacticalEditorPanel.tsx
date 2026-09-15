import type { FormEvent } from 'react';
import type { ProjectionStructure as StructureRecord, ProjectionWall as WallRecord } from '../../lib/projectionModel';
type StructureKind = StructureRecord['structureKind'];
type StructureMaterial = StructureRecord['material'];
type WallMaterial = WallRecord['material'];

export interface WallEditValues {
  type: WallRecord['wallKind']; material: WallMaterial; height: number; thickness: number; elevation: number;
  doorState?: 'open' | 'closed' | 'locked'; opening?: { start: number; end: number; bottom: number; height: number };
}
export interface StructureEditValues {
  kind: StructureKind; material: StructureMaterial; width: number; height: number; elevation: number; slabHeight: number; rotation: number;
}

interface TacticalEditorPanelProps {
  wall?: WallRecord;
  structure?: StructureRecord;
  connected: boolean;
  busy: boolean;
  canUpdateWall: boolean;
  canDeleteWall: boolean;
  canUpdateStructure: boolean;
  canDeleteStructure: boolean;
  onApplyWall(values: WallEditValues): void;
  onDeleteWall(): void;
  onApplyStructure(values: StructureEditValues): void;
  onDeleteStructure(): void;
  onClose(): void;
}

const materialOptions = <><option value="default">Default</option><option value="masonry">Masonry</option><option value="wood">Wood</option><option value="metal">Metal</option></>;

export function TacticalEditorPanel({ wall, structure, connected, busy, canUpdateWall, canDeleteWall, canUpdateStructure, canDeleteStructure, onApplyWall, onDeleteWall, onApplyStructure, onDeleteStructure, onClose }: TacticalEditorPanelProps) {
  function submitWall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const type = String(data.get('type')) as WallRecord['wallKind'];
    const start = Number(data.get('openingStart')); const end = Number(data.get('openingEnd'));
    onApplyWall({ type, material: String(data.get('material')) as WallMaterial, height: Number(data.get('height')), thickness: Number(data.get('thickness')), elevation: Number(data.get('elevation')), doorState: type === 'door' ? String(data.get('doorState')) as 'open' | 'closed' | 'locked' : undefined, opening: type !== 'door' && Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end, bottom: Math.max(.1, Number(data.get('openingBottom')) || .1), height: Math.max(.1, Number(data.get('openingHeight')) || 1) } : undefined });
  }
  function submitStructure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    onApplyStructure({ kind: String(data.get('kind')) as StructureKind, material: String(data.get('material')) as StructureMaterial, width: Number(data.get('width')), height: Number(data.get('height')), elevation: Number(data.get('elevation')), slabHeight: Number(data.get('slabHeight')), rotation: Number(data.get('rotation')) });
  }
  if (!wall && !structure) return null;
  return <section className="tactical-editor-panel" aria-label="DM geometry editor">
    <div className="editor-panel-heading"><div><span className="eyebrow">DM EDITOR</span><strong>{wall ? 'Wall inspector' : 'Structure inspector'}</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor">×</button></div>
    {wall && <form className="editor-form" onSubmit={submitWall} key={`${wall.wallId}:${wall.recordRevision}`}>
      <p className="editor-selection">Editing wall <strong>{wall.wallId}</strong></p>
      <label>Type<select name="type" defaultValue={wall.wallKind}><option value="blocking">Blocking</option><option value="terrain">Terrain</option><option value="ethereal">Ethereal</option><option value="door">Door</option></select></label>
      <label>Material<select name="material" defaultValue={wall.material}>{materialOptions}</select></label>
      <div className="field-pair"><label>Height<input name="height" type="number" min="0.1" step="any" defaultValue={wall.height} /></label><label>Thickness<input name="thickness" type="number" min="0.1" step="any" defaultValue={wall.thickness} /></label></div>
      <label>Elevation<input name="elevation" type="number" step="any" defaultValue={wall.elevation} /></label>
      {wall.wallKind === 'door' && <label>Door state<select name="doorState" defaultValue={wall.doorState}><option value="closed">Closed</option><option value="open">Open</option><option value="locked">Locked</option></select></label>}
      {wall.wallKind !== 'door' && <fieldset><legend>Window opening <span>(optional)</span></legend><div className="field-pair"><label>Start<input name="openingStart" type="number" min="0" max="1" step=".01" defaultValue={wall.openings[0]?.start ?? ''} /></label><label>End<input name="openingEnd" type="number" min="0" max="1" step=".01" defaultValue={wall.openings[0]?.end ?? ''} /></label></div><div className="field-pair"><label>Bottom<input name="openingBottom" type="number" min=".1" step="any" defaultValue={wall.openings[0]?.bottom ?? .1} /></label><label>Height<input name="openingHeight" type="number" min=".1" step="any" defaultValue={wall.openings[0]?.height ?? 1} /></label></div></fieldset>}
      <div className="editor-actions"><button type="submit" className="button primary" disabled={!connected || busy || !canUpdateWall}>Apply changes</button><button type="button" className="danger-button" disabled={!connected || busy || !canDeleteWall} onClick={onDeleteWall}>Delete wall</button></div>
    </form>}
    {structure && <form className="editor-form" onSubmit={submitStructure} key={`${structure.structureId}:${structure.recordRevision}`}>
      <p className="editor-selection">Editing structure <strong>{structure.structureId}</strong></p>
      <label>Kind<select name="kind" defaultValue={structure.structureKind}><option value="block">Block</option><option value="floor">Floor</option><option value="roof">Roof</option></select></label>
      <label>Material<select name="material" defaultValue={structure.material}>{materialOptions}</select></label>
      <div className="field-pair"><label>Width<input name="width" type="number" min="1" step="any" defaultValue={structure.size.width} /></label><label>Depth<input name="height" type="number" min="1" step="any" defaultValue={structure.size.height} /></label></div>
      <div className="field-pair"><label>Elevation<input name="elevation" type="number" step="any" defaultValue={structure.baseElevation} /></label><label>Slab height<input name="slabHeight" type="number" min=".1" step="any" defaultValue={structure.slabHeight} /></label></div>
      <label>Rotation<input name="rotation" type="number" step="any" defaultValue={structure.rotation} /></label>
      <div className="editor-actions"><button type="submit" className="button primary" disabled={!connected || busy || !canUpdateStructure}>Apply changes</button><button type="button" className="danger-button" disabled={!connected || busy || !canDeleteStructure} onClick={onDeleteStructure}>Delete structure</button></div>
    </form>}
  </section>;
}
