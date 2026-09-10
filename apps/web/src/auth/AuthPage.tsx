import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { displayNameSchema } from '@hearth/domain';
import { supabase, errorMessage } from '../lib/client';
import { Brand, Notice } from '../components/UI';
import { Crest, Icon } from '../components/Icons';

export function AuthPage() {
  const location = useLocation();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const isInvite = location.pathname.startsWith('/join/');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true); setError(''); setMessage('');
    try {
      const email = String(data.get('email')).trim();
      const password = String(data.get('password'));
      if (mode === 'signup') {
        const displayName = displayNameSchema.parse(data.get('displayName'));
        const next = location.pathname + location.search;
        const { data: result, error: failure } = await supabase!.auth.signUp({
          email, password,
          options: {
            data: { display_name: displayName },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (failure) throw failure;
        if (!result.session) setMessage('Check your email to confirm your account, then return here to sign in. Your invite link will still work.');
      } else {
        const { error: failure } = await supabase!.auth.signInWithPassword({ email, password });
        if (failure) throw failure;
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <div className="auth-layout">
    <aside className="auth-story">
      <Brand />
      <div className="story-copy"><span className="eyebrow">LESS SETUP. MORE STORY.</span>
        <h1>Every great adventure<br />starts at a table.</h1>
        <p>A shared space for your party, your world, and whatever happens next.</p>
        <div className="story-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><Crest size={150} /><span className="art-star star-one">✦</span><span className="art-star star-two">✦</span><span className="art-coordinates">YOUR WORLD. TOGETHER.</span></div>
      </div>
      <div className="story-bottom"><span className="live-dot" /> A little less admin. A lot more adventure.</div>
    </aside>
    <main className="auth-main">
      <div className="auth-form-wrap">
        <span className="eyebrow">PULL UP A CHAIR</span>
        <h2>{mode === 'signin' ? 'Welcome back.' : 'Find your place.'}</h2>
        <p className="muted">{isInvite ? 'Sign in or create an account to accept your room invitation.' : mode === 'signin' ? 'Your next session is waiting for you.' : 'Create an account and bring your stories to life.'}</p>
        <div className="auth-tabs" aria-label="Account action">
          <button type="button" className={mode === 'signin' ? 'active' : ''} aria-pressed={mode === 'signin'} disabled={pending} onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>Sign in</button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} aria-pressed={mode === 'signup'} disabled={pending} onClick={() => { setMode('signup'); setError(''); setMessage(''); }}>Create account</button>
        </div>
        {error && <Notice error>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        <form onSubmit={submit} className="form-stack">
          {mode === 'signup' && <label>Display name<input name="displayName" autoComplete="nickname" placeholder="What should your party call you?" required maxLength={40} disabled={pending} /></label>}
          <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} /></label>
          <label>Password<input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} minLength={mode === 'signup' ? 8 : 1} required disabled={pending} /></label>
          <button className="button primary full" disabled={pending}>{pending ? 'One moment…' : mode === 'signin' ? 'Return to your table' : 'Create your account'}<Icon name="arrow" /></button>
        </form>
        <p className="auth-note"><Icon name="users" size={16} /> One account. A whole party of possibilities.</p>
      </div>
      <footer className="auth-footer">HEARTH <span>Built for the stories you tell together.</span></footer>
    </main>
  </div>;
}
