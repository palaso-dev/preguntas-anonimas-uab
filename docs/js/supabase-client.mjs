import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import QRCode from 'https://esm.sh/qrcode@1.5.4';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './supabase-config.mjs';

let clientInstance = null;

export function getSupabase() {
  if (!isSupabaseConfigured()) {
    throw new Error('Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en js/supabase-config.mjs.');
  }
  if (!clientInstance) {
    clientInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return clientInstance;
}

export { isSupabaseConfigured };

export function resolveGuestPageUrl(settings) {
  const customUrl = typeof settings?.public_url === 'string' ? settings.public_url.trim() : '';
  if (customUrl && /^https?:\/\//i.test(customUrl)) {
    return customUrl.replace(/\/+$/, '');
  }
  return new URL('./', window.location.href).toString().replace(/\/+$/, '');
}

function mapSettingsRows(rows) {
  const map = {};
  for (const row of rows || []) {
    map[row.key] = row.value;
  }
  return {
    event_title: map.event_title || 'Confesiones Anónimas',
    event_subtitle: map.event_subtitle || '',
    submissions_open: (map.submissions_open ?? 'true') === 'true',
    live_mode: ['qr', 'featured', 'wall'].includes(map.live_mode) ? map.live_mode : 'qr',
    public_url: map.public_url || '',
  };
}

export async function fetchPublicState() {
  const sb = getSupabase();
  const [{ data: settingsRows, error: settingsErr }, { data: wallRows, error: wallErr }] =
    await Promise.all([
      sb.from('settings').select('key, value'),
      sb
        .from('confessions')
        .select('*')
        .in('status', ['approved', 'read'])
        .order('id', { ascending: false })
        .limit(12),
    ]);

  if (settingsErr) {
    throw settingsErr;
  }
  if (wallErr) {
    throw wallErr;
  }

  const settings = mapSettingsRows(settingsRows);
  const items = wallRows || [];
  const featured = items.find((item) => item.is_featured) || null;
  const effectiveUrl = resolveGuestPageUrl(settings);

  return {
    settings,
    publicSettings: settings,
    effectiveUrl,
    featured,
    wallItems: items.slice(0, 8),
    wall: items.slice(0, 8),
    totalReceived: items.length,
    counts: {
      total: items.length,
      approved: items.length,
    },
  };
}

export async function fetchAllStateForStaff() {
  const sb = getSupabase();
  const [{ data: settingsRows, error: settingsErr }, { data: rows, error: rowsErr }] =
    await Promise.all([
      sb.from('settings').select('key, value'),
      sb.from('confessions').select('*').order('id', { ascending: false }),
    ]);

  if (settingsErr) {
    throw settingsErr;
  }
  if (rowsErr) {
    throw rowsErr;
  }

  const settings = mapSettingsRows(settingsRows);
  const confessions = rows || [];
  const counts = {
    pending: 0,
    approved: 0,
    read: 0,
    rejected: 0,
    total: confessions.length,
  };
  for (const item of confessions) {
    if (item.status in counts) {
      counts[item.status] += 1;
    }
  }
  const featured = confessions.find((item) => item.is_featured) || null;
  const approvedAndRead = confessions
    .filter((item) => item.status === 'approved' || item.status === 'read')
    .slice()
    .reverse();

  return {
    settings,
    publicSettings: settings,
    effectiveUrl: resolveGuestPageUrl(settings),
    confessions,
    approvedAndRead,
    featured,
    counts,
  };
}

export function subscribeGalaRealtime(onUpdate) {
  const sb = getSupabase();
  const channel = sb
    .channel(`gala-realtime-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'confessions' }, () => {
      onUpdate();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => {
      onUpdate();
    })
    .subscribe();

  return () => {
    sb.removeChannel(channel);
  };
}

export async function updateSettingKeys(entries) {
  const sb = getSupabase();
  const rows = Object.entries(entries).map(([key, value]) => ({
    key,
    value: String(value),
  }));
  const { error } = await sb.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) {
    throw error;
  }
}

export async function setFeaturedConfessionDb(idOrNull) {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { error: clearErr } = await sb
    .from('confessions')
    .update({ is_featured: false, updated_at: now })
    .eq('is_featured', true);
  if (clearErr) {
    throw clearErr;
  }
  if (idOrNull === null || idOrNull === undefined) {
    return;
  }
  const { data: current, error: getErr } = await sb
    .from('confessions')
    .select('status')
    .eq('id', idOrNull)
    .single();
  if (getErr) {
    throw getErr;
  }
  const nextStatus =
    current.status === 'pending' || current.status === 'rejected' ? 'approved' : current.status;
  const { error: setErr } = await sb
    .from('confessions')
    .update({ is_featured: true, status: nextStatus, updated_at: now })
    .eq('id', idOrNull);
  if (setErr) {
    throw setErr;
  }
  await updateSettingKeys({ live_mode: 'featured' });
}

export async function generateQrSvgString(url) {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: {
      dark: '#061326',
      light: '#ffffff',
    },
  });
}

export async function generateQrPngDataUrl(url) {
  return QRCode.toDataURL(url, {
    width: 1024,
    errorCorrectionLevel: 'M',
    margin: 2,
    color: {
      dark: '#061326',
      light: '#ffffff',
    },
  });
}
