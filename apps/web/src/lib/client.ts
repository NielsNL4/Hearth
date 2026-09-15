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
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value.message === 'string' && value.message) {
      const context = [value.details, value.hint].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
      return context ? `${value.message} ${context}` : value.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Something went wrong. Please try again.';
}
