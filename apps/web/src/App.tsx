import { lazy, Suspense } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useSession } from './auth/AuthProvider';
import { AuthPage } from './auth/AuthPage';
import { Shell } from './components/Shell';
import { Setup, Notice, Loading } from './components/UI';
import { supabase } from './lib/client';

const Dashboard = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })));
const JoinRoom = lazy(() => import('./pages/JoinRoom').then((module) => ({ default: module.JoinRoom })));
const Lobby = lazy(() => import('./pages/Lobby').then((module) => ({ default: module.Lobby })));
const TacticalTable = lazy(() => import('./pages/TacticalTable').then((module) => ({ default: module.TacticalTable })));

function Callback() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const error = query.get('error_description') || hash.get('error_description');
  const next = query.get('next') || '/';
  // Only internal, known routes are valid email-confirmation destinations.
  const safeNext = /^\/(?:join\/[a-fA-F0-9]{32}|rooms\/[a-fA-F0-9-]{36}(?:\/table)?)$/.test(next) ? next : '/';
  if (error) return <div className="setup-page"><Notice error>{error}</Notice><Link className="button primary" to={safeNext}>Return to sign in</Link></div>;
  return <Navigate replace to={safeNext} />;
}

function AuthenticatedRoutes() {
  const session = useSession();
  const location = useLocation();
  if (!session) return <AuthPage />;
  const immersive = /^\/rooms\/[a-fA-F0-9-]{36}\/table$/.test(location.pathname);
  return <Shell key={session.user.id} immersive={immersive}><Suspense fallback={<Loading />}><Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/join/:code" element={<JoinRoom />} />
    <Route path="/rooms/:roomId" element={<Lobby />} />
    <Route path="/rooms/:roomId/table" element={<TacticalTable />} />
    <Route path="*" element={<main className="page"><h1>Lost in the wilderness?</h1><p className="muted">That page doesn’t exist.</p><Link className="button primary" to="/">Back to adventures</Link></main>} />
  </Routes></Suspense></Shell>;
}

export function App() {
  return <BrowserRouter>{supabase ? <AuthProvider><Routes>
    <Route path="/auth/callback" element={<Callback />} />
    <Route path="*" element={<AuthenticatedRoutes />} />
  </Routes></AuthProvider> : <Setup />}</BrowserRouter>;
}
