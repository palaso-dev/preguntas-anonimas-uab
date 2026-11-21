import {
  fetchPublicState,
  generateQrPngDataUrl,
  generateQrSvgString,
  isSupabaseConfigured,
  resolveGuestPageUrl,
  subscribeGalaRealtime,
} from './supabase-client.mjs';

const titleEl = document.getElementById('main-content');
const subtitleEl = document.getElementById('qr-subtitle');
const qrImg = document.getElementById('printable-qr-img');
const activeUrlEl = document.getElementById('qr-active-url');
const printBtn = document.getElementById('print-qr-btn');
const pngLink = document.getElementById('qr-download-png');
const svgLink = document.getElementById('qr-download-svg');

let lastUrl = '';
let lastSvgObjectUrl = '';

async function renderQrForUrl(targetUrl) {
  activeUrlEl.textContent = targetUrl;
  if (targetUrl === lastUrl) {
    return;
  }
  lastUrl = targetUrl;
  const [pngDataUrl, svgString] = await Promise.all([
    generateQrPngDataUrl(targetUrl),
    generateQrSvgString(targetUrl),
  ]);
  qrImg.src = pngDataUrl;
  pngLink.href = pngDataUrl;
  if (lastSvgObjectUrl) {
    URL.revokeObjectURL(lastSvgObjectUrl);
  }
  lastSvgObjectUrl = URL.createObjectURL(
    new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }),
  );
  svgLink.href = lastSvgObjectUrl;
}

function applyQrState(state) {
  if (!state) {
    return;
  }
  const settings = state.settings || {};
  if (settings.event_title) {
    titleEl.textContent = settings.event_title;
    document.title = `Código QR | ${settings.event_title}`;
  }
  if (settings.event_subtitle) {
    subtitleEl.textContent = settings.event_subtitle;
    subtitleEl.hidden = false;
  } else {
    subtitleEl.textContent = '';
    subtitleEl.hidden = true;
  }
  renderQrForUrl(state.effectiveUrl || resolveGuestPageUrl(settings)).catch(() => {});
}

printBtn.addEventListener('click', () => {
  window.print();
});

renderQrForUrl(resolveGuestPageUrl({})).catch(() => {});

if (isSupabaseConfigured()) {
  const refresh = () => {
    fetchPublicState()
      .then((data) => applyQrState(data))
      .catch(() => {});
  };
  refresh();
  subscribeGalaRealtime(refresh);
}
