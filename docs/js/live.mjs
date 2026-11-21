import {
  el,
  runViewTransition,
} from './ui.mjs';
import {
  fetchPublicState,
  generateQrPngDataUrl,
  isSupabaseConfigured,
  subscribeGalaRealtime,
} from './supabase-client.mjs';

const snowLayer = document.getElementById('snow-layer');
const liveEventTitle = document.getElementById('live-event-title');
const liveCounterBadge = document.getElementById('live-counter-badge');
const liveStage = document.getElementById('live-stage');
const toggleFullscreenBtn = document.getElementById('toggle-fullscreen');

let lastRenderSignature = '';
let cachedQrUrl = '';
let cachedQrDataUrl = '';

function buildSnowflakes() {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 24; i += 1) {
    const flake = document.createElement('span');
    flake.className = 'snow-flake';
    const size = 4 + (i % 5) * 1.5;
    flake.style.width = `${size}px`;
    flake.style.height = `${size}px`;
    flake.style.left = `${(i * 4.2 + (i % 3) * 1.7) % 98}%`;
    flake.style.setProperty('--fall-dur', `${11 + (i % 7) * 2.3}s`);
    flake.style.setProperty('--fall-delay', `${-(i % 9) * 1.6}s`);
    flake.style.setProperty('--drift-x', `${(i % 2 === 0 ? 1 : -1) * (14 + (i % 4) * 8)}px`);
    fragment.append(flake);
  }
  snowLayer.append(fragment);
}

function getQuoteSizeClass(text) {
  const len = text.length;
  if (len <= 95) {
    return 'live-quote-text--short';
  }
  if (len <= 195) {
    return 'live-quote-text--medium';
  }
  return 'live-quote-text--long';
}

async function ensureQrDataUrl(targetUrl) {
  if (targetUrl && targetUrl === cachedQrUrl && cachedQrDataUrl) {
    return cachedQrDataUrl;
  }
  cachedQrUrl = targetUrl;
  cachedQrDataUrl = await generateQrPngDataUrl(targetUrl);
  return cachedQrDataUrl;
}

function renderQrHero(state, qrSrc) {
  const settings = state.settings || {};
  const open = Boolean(settings.submissions_open);
  return el(
    'section',
    { className: 'live-qr-hero' },
    el(
      'div',
      {},
      el(
        'span',
        { className: open ? 'badge badge--turquoise' : 'badge badge--crimson' },
        open ? 'Buzón abierto' : 'Buzón en pausa',
      ),
      el(
        'h2',
        { className: 'live-qr-title', style: 'margin-top: 0.9rem' },
        settings.event_title || 'Confesiones Anónimas',
      ),
      el(
        'p',
        { className: 'live-qr-lead' },
        'Escanea el QR con tu celular y manda tu confesión 100% anónima.',
      ),
    ),
    el(
      'div',
      { className: 'live-qr-card' },
      el('img', {
        src: qrSrc,
        alt: 'Código QR para enviar confesiones',
      }),
      el('span', { className: 'live-qr-caption' }, 'Escanea y confiesa'),
      el('span', { className: 'live-qr-url' }, state.effectiveUrl),
    ),
  );
}

function renderFeaturedView(state, qrSrc) {
  const featured = state.featured;
  if (!featured) {
    return renderQrHero(state, qrSrc);
  }

  return el(
    'div',
    { className: 'live-featured-layout' },
    el(
      'article',
      { className: 'live-ngl-card' },
      el(
        'div',
        { className: 'live-ngl-top' },
        el('span', { style: 'font-weight: 800; font-size: 1.1rem' }, 'Alguien confesó...'),
      ),
      el(
        'div',
        { className: 'live-ngl-body' },
        el(
          'p',
          { className: `live-quote-text ${getQuoteSizeClass(featured.message)}` },
          featured.message,
        ),
      ),
    ),
    el(
      'aside',
      { className: 'live-mini-qr', 'aria-label': 'Código QR para participar' },
      el('img', {
        src: qrSrc,
        alt: 'Código QR para enviar tu confesión',
      }),
      el('span', { className: 'live-qr-caption', style: 'font-size: 0.92rem' }, 'Manda la tuya'),
      el('span', { className: 'live-qr-url', style: 'font-size: 0.72rem' }, state.effectiveUrl || ''),
    ),
  );
}

function renderWallView(state, qrSrc) {
  const wallItems = state.wallItems || [];
  if (wallItems.length === 0) {
    return renderQrHero(state, qrSrc);
  }

  const grid = el('div', { className: 'live-wall-grid' });
  const visibleItems = wallItems.slice(0, 5);

  for (const item of visibleItems) {
    grid.append(
      el(
        'article',
        { className: 'live-wall-card' },
        el('div', { className: 'live-wall-top' }, 'Alguien confesó...'),
        el(
          'div',
          { className: 'live-wall-body' },
          el('p', { className: 'live-wall-text' }, item.message),
        ),
      ),
    );
  }

  grid.append(
    el(
      'aside',
      { className: 'live-mini-qr', style: 'justify-self: stretch; align-content: center' },
      el('img', {
        src: qrSrc,
        alt: 'Código QR para enviar confesiones',
      }),
      el('span', { className: 'live-qr-caption' }, 'Escanea y participa'),
      el('span', { className: 'live-qr-url' }, state.effectiveUrl || ''),
    ),
  );

  return grid;
}

function computeSignature(state) {
  const settings = state.settings || {};
  const featured = state.featured;
  const wall = (state.wallItems || []).slice(0, 5);
  return JSON.stringify({
    mode: settings.live_mode || 'qr',
    title: settings.event_title || '',
    open: Boolean(settings.submissions_open),
    url: state.effectiveUrl || '',
    featured: featured ? { id: featured.id, message: featured.message } : null,
    wall: wall.map((item) => ({ id: item.id, message: item.message })),
  });
}

async function applyLiveState(state) {
  if (!state) {
    return;
  }
  const settings = state.settings || {};

  if (settings.event_title) {
    liveEventTitle.textContent = settings.event_title;
    document.title = `En Vivo | ${settings.event_title}`;
  }

  const total = state.totalReceived ?? 0;
  liveCounterBadge.textContent =
    total === 1 ? '1 confesión' : `${total} confesiones`;

  const signature = computeSignature(state);
  if (signature === lastRenderSignature) {
    return;
  }
  lastRenderSignature = signature;

  const qrSrc = await ensureQrDataUrl(state.effectiveUrl);
  const mode = settings.live_mode || 'qr';
  const buildStageNode = () => {
    if (mode === 'featured' && state.featured) {
      return renderFeaturedView(state, qrSrc);
    }
    if (mode === 'wall') {
      return renderWallView(state, qrSrc);
    }
    return renderQrHero(state, qrSrc);
  };

  runViewTransition(() => {
    liveStage.replaceChildren(buildStageNode());
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
}

toggleFullscreenBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
  const isFull = Boolean(document.fullscreenElement);
  toggleFullscreenBtn.setAttribute(
    'aria-label',
    isFull ? 'Salir de pantalla completa' : 'Pantalla completa',
  );
  toggleFullscreenBtn.setAttribute(
    'title',
    isFull ? 'Salir de pantalla completa' : 'Pantalla completa',
  );
});

document.addEventListener('keydown', (event) => {
  if (event.target?.matches?.('input, textarea, select')) {
    return;
  }
  if (event.key === 'f' || event.key === 'F') {
    toggleFullscreen();
  }
});

buildSnowflakes();

if (isSupabaseConfigured()) {
  const refresh = () => {
    fetchPublicState()
      .then((data) => applyLiveState(data))
      .catch(() => {});
  };
  refresh();
  subscribeGalaRealtime(refresh);
}
