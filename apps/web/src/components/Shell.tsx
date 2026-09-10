import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../auth/AuthProvider';
import { supabase, errorMessage } from '../lib/client';
import { Brand, Notice } from './UI';
import { Icon } from './Icons';

export function Shell({ children, immersive = false }: { children: ReactNode; immersive?: boolean }) {
  const session = useSession()!;
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const name = String(session.user.user_metadata.display_name || 'Adventurer');
  async function signOut() {
    setPending(true); setError('');
    try {
      const { error: failure } = await supabase!.auth.signOut({ scope: 'local' });
      if (failure) throw failure;
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <div className={`app-layout ${immersive ? 'immersive-layout' : ''}`}>
    <aside className="sidebar">
      <Brand />
      <span className="nav-caption">YOUR WORKSPACE</span>
      <nav><NavLink to="/" end><Icon name="book" /> My adventures <span className="nav-mark">⌘</span></NavLink></nav>
      <div className="sidebar-note"><span className="mini-crest">✦</span><strong>The best part is the party.</strong><p>Create a room, share an invite, and gather your adventurers.</p></div>
      <div className="profile"><span className="avatar">{name.slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><span>Adventurer</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={signOut} disabled={pending}><Icon name="door" /></button></div>
    </aside>
    <div className="workspace"><header className="topbar"><span><span className="muted">Workspace</span><span className="separator">/</span> Adventures</span><span className="version-badge">DEVELOPMENT · 01</span></header>
      {error && <div className="shell-error"><Notice error>{error}</Notice></div>}
      {children}
      <footer className="workspace-footer"><span>Made for imagination.</span><span>HEARTH · A SHARED TABLETOP</span></footer>
    </div>
  </div>;
}
