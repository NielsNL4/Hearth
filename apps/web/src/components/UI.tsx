import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Crest, Icon } from './Icons';

export function Brand() {
  return <Link className="brand" to="/" aria-label="Hearth home"><Crest /><span>hearth<span className="brand-dot">.</span></span></Link>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

export function Loading({ label = 'Gathering your adventures…' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" />{label}</div>;
}

export function Setup() {
  return <div className="setup-page"><Brand /><main className="setup-card panel">
    <span className="eyebrow">WELCOME TO HEARTH</span>
    <h1>A home for your<br />next adventure.</h1>
    <p className="muted">Your table is almost ready. Connect a Supabase project to enable accounts and persistent rooms.</p>
    <ol className="setup-steps">
      <li>Copy <code>apps/web/.env.example</code> to <code>apps/web/.env</code>.</li>
      <li>Add your Supabase URL and publishable key.</li>
      <li>Apply the migration in <code>supabase/migrations/</code>.</li>
      <li>Configure Auth redirects and restart <code>npm run dev</code>.</li>
    </ol>
    <div className="notice"><Icon name="book" /> Full local and hosted setup instructions are in <strong>README.md</strong>.</div>
    <div className="setup-foot">MILESTONE 01 <span>Accounts · Rooms · Presence</span></div>
  </main></div>;
}
