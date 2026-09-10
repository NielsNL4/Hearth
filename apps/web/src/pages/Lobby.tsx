import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Room, RoomEvent, RoomMember } from '@hearth/domain';
import { subscribeToRoomPresence, type ConnectionStatus } from '@hearth/sync';
import { useSession } from '../auth/AuthProvider';
import { rooms, supabase, errorMessage } from '../lib/client';
import { Crest, Icon } from '../components/Icons';
import { Loading, Notice } from '../components/UI';

export function Lobby() {
  const { roomId = '' } = useParams();
  const session = useSession()!;
  const [room, setRoom] = useState<Room | null>();
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [invite, setInvite] = useState<string>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [online, setOnline] = useState(new Set<string>());
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let refreshAgain = false;
    let unsubscribe: (() => void) | undefined;
    setRoom(undefined); setError(''); setMembers([]); setEvents([]); setInvite(undefined); setOnline(new Set());
    async function refresh() {
      if (!active) return;
      if (inFlight) { refreshAgain = true; return; }
      inFlight = true;
      try {
        const currentRoom = await rooms!.getRoom(roomId);
        if (!active) return;
        if (!currentRoom) { setRoom(null); setError(''); unsubscribe?.(); unsubscribe = undefined; return; }
        const [lobby, currentInvite] = await Promise.all([rooms!.getLobby(roomId), rooms!.getInvite(roomId)]);
        if (!active) return;
        setRoom(currentRoom); setMembers(lobby.members); setEvents(lobby.events); setInvite(currentInvite); setError('');
        if (!unsubscribe) unsubscribe = subscribeToRoomPresence(supabase!, roomId, session.user.id,
          (users) => { if (active) setOnline(users); },
          (next) => { if (active) setStatus(next); }, () => { void refresh(); });
      } catch (failure) { if (active) setError(errorMessage(failure)); }
      finally {
        inFlight = false;
        if (refreshAgain && active) { refreshAgain = false; void refresh(); }
      }
    }
    void refresh();
    // Durable roster/activity snapshots recover missed joins, including users
    // who joined without successfully opening a presence channel.
    const interval = window.setInterval(() => { void refresh(); }, 15_000);
    const onOnline = () => { void refresh(); };
    const onOffline = () => { setStatus('reconnecting'); setOnline(new Set()); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { active = false; clearInterval(interval); unsubscribe?.(); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [roomId, session.user.id, retry]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(''), 2500);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function copy(value: string, kind: string) {
    setCopyError('');
    try { await navigator.clipboard.writeText(value); setCopied(kind); }
    catch { setCopyError('Clipboard access is unavailable. Select and copy the invite below.'); }
  }

  if (room === undefined) return <main className="page">{error ? <Notice error>{error} <button className="inline-button" onClick={() => setRetry((value) => value + 1)}>Retry</button></Notice> : <Loading label="Opening your room…" />}</main>;
  if (room === null) return <main className="page"><section className="join-card panel"><h1>Room unavailable.</h1><p className="muted">This room doesn’t exist or you haven’t joined it. Use your DM’s invite link to get access.</p><Link className="button primary" to="/">Back to adventures</Link></section></main>;

  const me = members.find((member) => member.user_id === session.user.id);
  const isDm = me?.role === 'dm';
  const inviteLink = invite ? `${window.location.origin}/join/${invite}` : '';
  const connectedMembers = members.filter((member) => online.has(member.user_id)).length;
  return <main className="page lobby"><Link className="back-link" to="/">← My adventures</Link>
    <div className="page-heading"><div><span className="eyebrow">THE GATHERING PLACE</span><h1>{room.name}<span className="accent">.</span></h1><p className="muted">Your party’s home between adventures.</p></div><span className={`connection-badge ${status === 'online' ? 'connected' : ''}`} role="status"><span className="live-dot" />{status === 'online' ? 'Live connection' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span></div>
    {error && <Notice error>Couldn’t refresh the room: {error} Your last loaded roster is shown. <button className="inline-button" onClick={() => setRetry((value) => value + 1)}>Retry</button></Notice>}
    {status === 'reconnecting' && <Notice>Live presence is reconnecting. Membership is saved; the roster refreshes automatically.</Notice>}
    <div className="lobby-grid"><div className="lobby-main">
      <section className="panel party-panel"><div className="panel-heading"><div><h2>The party <span className="count-badge">{members.length}</span></h2><p className="muted">{connectedMembers} online · Everyone has a place at the table.</p></div><Icon name="users" /></div>
        <ul className="member-list">{members.map((member) => <li key={member.user_id}><span className={`avatar ${member.role === 'dm' ? 'avatar-dm' : ''}`}>{member.display_name.slice(0, 1).toUpperCase()}<span className={`presence-dot ${online.has(member.user_id) ? 'is-online' : ''}`} /></span><div className="member-name"><strong>{member.display_name} {member.user_id === session.user.id && <span className="you-label">(you)</span>}</strong><span>{online.has(member.user_id) ? 'At the table' : 'Away from the table'}</span></div><span className={`role-badge ${member.role === 'dm' ? 'dm' : ''}`}>{member.role === 'dm' ? 'DUNGEON MASTER' : 'PLAYER'}</span></li>)}</ul>
      </section>
      <section className="table-preview"><div className="cover-grid" /><div className="preview-content"><Crest size={52} /><span className="eyebrow">THE TACTICAL TABLE</span><h2>Bring the encounter to life.</h2><p>Set a map, tune the grid, and gather your party around a shared canvas.</p><Link className="button primary" to={`/rooms/${roomId}/table`}><Icon name="grid" size={16} />Open tactical table</Link></div></section>
      <section className="panel activity-panel"><div className="panel-heading"><h2>Room activity</h2><Icon name="clock" /></div><ul className="activity-list">{events.map((event) => <li key={event.id}><span className="activity-dot" /><div><p><strong>{String(event.payload.display_name ?? 'An adventurer')}</strong> {event.type === 'room.created' ? 'created the room.' : 'joined the party.'}</p><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></div></li>)}</ul></section>
    </div><aside className="lobby-aside">
      {isDm && invite ? <section className="panel invite-panel"><span className="invite-icon"><Icon name="link" size={24} /></span><h2>Gather your party.</h2><p className="muted">Share this invitation with your players. They’ll sign in and join as players.</p><label>Invite link<input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} /></label><button className="button primary full" onClick={() => copy(inviteLink, 'link')}><Icon name={copied === 'link' ? 'check' : 'copy'} size={17} />{copied === 'link' ? 'Link copied' : 'Copy invite link'}</button><div className="invite-divider"><span>or share the code</span></div><label className="sr-only" htmlFor="invite-code">Invite code</label><div className="invite-code"><input id="invite-code" readOnly value={invite} onFocus={(event) => event.currentTarget.select()} /><button className="icon-button" aria-label={copied === 'code' ? 'Code copied' : 'Copy invite code'} onClick={() => copy(invite, 'code')}><Icon name={copied === 'code' ? 'check' : 'copy'} size={17} /></button></div><span className="sr-only" role="status">{copied ? `${copied} copied` : ''}</span>{copyError && <Notice error>{copyError}</Notice>}<p className="field-hint">Anyone with this invitation and an account can join. Share it with your party.</p></section> : <section className="panel invite-panel"><Icon name="users" size={28} /><h2>You’re part of the story.</h2><p className="muted">This room is now in your adventures. Your Dungeon Master manages invitations.</p></section>}
      <section className="room-details"><span className="eyebrow">ROOM DETAILS</span><dl><div><dt>Your role</dt><dd>{isDm ? 'Dungeon Master' : 'Player'}</dd></div><div><dt>Created</dt><dd>{new Date(room.created_at).toLocaleDateString()}</dd></div><div><dt>Persistence</dt><dd className="saved-state"><Icon name="check" size={14} /> Saved</dd></div></dl><p>Close the tab and return whenever you’re ready. Your room and membership will be here.</p></section>
    </aside></div>
  </main>;
}
