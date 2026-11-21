export const SUPABASE_URL = 'https://cbrjbjendvxurzjftiqk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_m4lrdAbjKEuApSgV9iG-zQ_KfwEKhzH';

export function isSupabaseConfigured() {
  return (
    typeof SUPABASE_URL === 'string' &&
    SUPABASE_URL.startsWith('https://') &&
    typeof SUPABASE_ANON_KEY === 'string' &&
    SUPABASE_ANON_KEY.length > 20 &&
    !SUPABASE_ANON_KEY.includes('PEGA_AQUI')
  );
}
