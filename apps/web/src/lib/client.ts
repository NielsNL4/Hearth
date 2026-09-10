import { createClient } from '@supabase/supabase-js';
import { createRoomRepository } from '@hearth/sync';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function isConfigured(): boolean {
  if (!url || !key || url.includes('YOUR_PROJECT') || key.includes('YOUR_')) return false;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); }
  catch { return false; }
}

export const supabase = isConfigured() ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;
export const rooms = supabase ? createRoomRepository(supabase) : null;

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = error.issues as { message: string }[];
    return issues[0]?.message ?? 'Check the form and try again.';
  }
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'Something went wrong. Please try again.';
}
