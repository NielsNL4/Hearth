import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inviteCodeSchema } from '@hearth/domain';
import { rooms, errorMessage } from '../lib/client';
import { Icon } from '../components/Icons';
import { Notice } from '../components/UI';

export function JoinRoom() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const commandId = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const valid = inviteCodeSchema.safeParse(code).success;
  async function join() {
    setPending(true); setError('');
    try { navigate(`/rooms/${await rooms!.joinRoom(code, commandId.current)}`, { replace: true }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <main className="page"><Link className="back-link" to="/">← My adventures</Link><section className="join-card panel"><div className="empty-icon"><Icon name="users" size={32} /></div><span className="eyebrow">THERE’S A SEAT FOR YOU</span><h1>{valid ? 'Join the adventure.' : 'This invite looks incomplete.'}</h1><p className="muted">{valid ? 'Accept your invitation to join this room as a player. It will be saved to your adventures.' : 'Ask your Dungeon Master for a fresh link or the full 32-character invite code.'}</p>{error && <Notice error>{error}</Notice>}{valid && <button className="button primary" disabled={pending} onClick={join}>{pending ? 'Joining your party…' : 'Accept invitation'}<Icon name="arrow" /></button>}<Link className="back-link" to="/">Back to my adventures</Link></section></main>;
}
