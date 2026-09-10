import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, errorMessage } from '../lib/client';
import { Brand, Loading, Notice } from '../components/UI';

const AuthContext = createContext<Session | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const client = supabase!;
    let active = true;
    let authChanged = false;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      authChanged = true;
      setSession(next);
      setLoading(false);
    });
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError(errorMessage(sessionError));
      if (!authChanged) setSession(data.session);
      setLoading(false);
    }).catch((failure: unknown) => {
      if (active) { setError(errorMessage(failure)); setLoading(false); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  if (loading) return <div className="setup-page"><Brand /><Loading label="Opening your table…" /></div>;
  if (error) return <div className="setup-page"><Brand /><Notice error>{error}</Notice><button className="button" onClick={() => window.location.reload()}>Try again</button></div>;
  return <AuthContext value={session}>{children}</AuthContext>;
}

export function useSession() { return useContext(AuthContext); }
