import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase browser client, or `null` when the project isn't configured.
 *
 * Auth is deliberately optional: with the env vars unset the whole app still
 * works, every caller is anonymous, and the sign-in UI hides itself. That keeps
 * local development and the demo path running without a Supabase project.
 */
const url = import.meta.env.VITE_SUPABASE_URL || "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const supabaseEnabled = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(url, anonKey, {
      auth: {
        // Keep the user signed in across reloads and refresh tokens silently.
        persistSession: true,
        autoRefreshToken: true,
        // The OAuth redirect comes back with the session in the URL fragment.
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    })
  : null;
