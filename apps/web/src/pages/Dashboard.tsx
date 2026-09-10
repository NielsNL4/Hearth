import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createRoomSchema, inviteCodeSchema } from '@hearth/domain';
import type { RoomRepository } from '@hearth/sync';
import { useSession } from '../auth/AuthProvider';
import { rooms, errorMessage } from '../lib/client';
import { Icon, Crest } from '../components/Icons';
import { Loading, Notice } from '../components/UI';

type RoomList = Awaited<ReturnType<RoomRepository['listRooms']>>;

export function Dashboard() {
  const session = useSession()!;
  const navigate = useNavigate();
  const [data, setData] = useState<RoomList>();
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [action, setAction] = useState<'create' | 'join' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const command = useRef({ fingerprint: '', id: '' });
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    setLoadError('');
    void rooms!.listRooms().then((result) => { if (active) setData(result); })
      .catch((failure: unknown) => { if (active) setLoadError(errorMessage(failure)); });
    return () => { active = false; };
  }, [retry]);

  useEffect(() => {
    if (action) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [action]);

  function open(next: 'create' | 'join') { setError(''); setAction(next); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      if (action === 'join') {
        const code = inviteCodeSchema.parse(form.get('code'));
        setAction(null);
        navigate(`/join/${code}`);
      } else {
        const input = createRoomSchema.parse({ name: form.get('name'), campaignName: form.get('campaignName') });
        const fingerprint = JSON.stringify(input);
        if (fingerprint !== command.current.fingerprint) command.current = { fingerprint, id: crypto.randomUUID() };
        const roomId = await rooms!.createRoom(input, command.current.id);
        setAction(null);
        navigate(`/rooms/${roomId}`);
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  const dmCount = data?.members.filter((member) => member.user_id === session.user.id && member.role === 'dm').length ?? 0;
  return <main className="page dashboard">
    <div className="page-heading"><div><span className="eyebrow">YOUR STORIES START HERE</span><h1>My adventures<span className="accent">.</span></h1><p className="muted">Gather your party. Pick up where the story left off.</p></div><button className="button primary" onClick={() => open('create')}><Icon name="plus" /> Create a room</button></div>
    <section className="welcome-banner"><div className="banner-copy"><span className="eyebrow">A PLACE FOR YOUR PARTY</span><h2>Big stories.<br />One shared table.</h2><p>Build a home for your campaign and invite<br className="desktop-break" /> your players to the next chapter.</p><button className="text-button" onClick={() => open('create')}>Start an adventure <Icon name="arrow" size={18} /></button></div><div className="banner-art" aria-hidden="true"><div className="map-grid" /><div className="map-path" /><div className="map-tile tile-one" /><div className="map-tile tile-two" /><div className="map-tile tile-three" /><div className="map-token"><Crest size={55} /></div><span className="map-label">THE NEXT CHAPTER AWAITS</span><span className="map-compass">N<br />✧</span></div></section>
    <div className="section-heading"><div><h2>Your rooms <span className="count-badge">{data?.rooms.length ?? '—'}</span></h2><p className="muted">Your campaigns, all in one place.</p></div><button className="button secondary" onClick={() => open('join')}><Icon name="link" size={17} /> Join with a code</button></div>
    {loadError ? <Notice error>{loadError} <button className="inline-button" onClick={() => setRetry((value) => value + 1)}>Retry</button></Notice> : !data ? <Loading /> : data.rooms.length === 0 ? <section className="empty-state"><div className="empty-icon"><Icon name="book" size={32} /></div><h3>A blank page. Endless possibilities.</h3><p>Create your first room as a Dungeon Master,<br />or join a friend’s adventure with an invite code.</p><div className="button-row"><button className="button primary" onClick={() => open('create')}><Icon name="plus" size={18} /> Create your first room</button><button className="button secondary" onClick={() => open('join')}>Join a room <Icon name="arrow" size={17} /></button></div></section> : <div className="room-grid">{data.rooms.map((room, index) => {
      const membership = data.members.find((member) => member.room_id === room.id && member.user_id === session.user.id);
      const campaign = data.campaigns.find((item) => item.id === room.campaign_id);
      const count = data.members.filter((member) => member.room_id === room.id).length;
      return <Link to={`/rooms/${room.id}`} className={`room-card room-color-${index % 3}`} key={room.id}><div className="room-cover"><div className="cover-grid" /><Crest size={62} /><span className={`role-badge ${membership?.role === 'dm' ? 'dm' : ''}`}>{membership?.role === 'dm' ? 'DUNGEON MASTER' : 'PLAYER'}</span></div><div className="room-card-body"><span className="eyebrow">{campaign?.name ?? 'Campaign'}</span><h3>{room.name}</h3><div className="room-card-footer"><span><Icon name="users" size={16} /> {count} {count === 1 ? 'adventurer' : 'adventurers'}</span><span className="room-enter">Open room <Icon name="arrow" size={16} /></span></div></div></Link>;
    })}</div>}
    <div className="dashboard-bottom"><span><Icon name="check" size={16} /> Room memberships and state are saved automatically.</span>{data && data.rooms.length > 0 && <span>{dmCount} led by you · {data.rooms.length - dmCount} joined as player</span>}</div>
    <dialog ref={dialogRef} onCancel={(event) => { if (pending) event.preventDefault(); else setAction(null); }} onClose={() => { if (!pending) setAction(null); }} aria-labelledby="dialog-title">
      <div className="dialog-heading"><span className="eyebrow">{action === 'create' ? 'A NEW CHAPTER' : 'YOUR PARTY IS WAITING'}</span><button className="close-button" aria-label="Close dialog" disabled={pending} onClick={() => setAction(null)}>×</button></div>
      <h2 id="dialog-title">{action === 'create' ? 'Create a room' : 'Join an adventure'}</h2><p className="muted">{action === 'create' ? 'You’ll be the Dungeon Master. Invite your players once your room is ready.' : 'Enter the invite code shared by your Dungeon Master.'}</p>
      {error && <Notice error>{error}</Notice>}
      <form className="form-stack" onSubmit={submit} key={action}>
        {action === 'create' ? <><label>Campaign name<input name="campaignName" placeholder="e.g. Salt & Shadow" required maxLength={80} disabled={pending} /></label><label>Room name<input name="name" placeholder="e.g. The Sunken Keep" required maxLength={80} disabled={pending} /></label><p className="field-hint">Creates a new campaign with its first persistent room.</p></> : <label>Invite code<input name="code" className="code-input" placeholder="32-character invite code" required autoCapitalize="none" spellCheck={false} disabled={pending} /></label>}
        <button className="button primary full" disabled={pending}>{pending ? 'Creating your room…' : action === 'create' ? 'Create room' : 'Continue'}<Icon name="arrow" size={18} /></button>
      </form>
    </dialog>
  </main>;
}
