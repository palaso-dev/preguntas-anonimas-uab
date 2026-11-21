import { apiJson, connectSse } from './ui.mjs';

const titleEl = document.getElementById('main-content');
const subtitleEl = document.getElementById('qr-subtitle');
const qrImg = document.getElementById('printable-qr-img');
const activeUrlEl = document.getElementById('qr-active-url');
const printBtn = document.getElementById('print-qr-btn');

let lastUrl = '';

function applyQrState(state) {
  if (!state) {
    return;
  }
  const settings = state.publicSettings || state.settings || {};
  if (settings.event_title) {
    titleEl.textContent = settings.event_title;
    document.title = `Código QR Imprimible | ${settings.event_title}`;
  }
  if (settings.event_subtitle !== undefined) {
    subtitleEl.textContent = settings.event_subtitle;
  }
  const nextUrl = state.effectiveUrl || window.location.origin;
  activeUrlEl.textContent = nextUrl;
  if (nextUrl !== lastUrl) {
    lastUrl = nextUrl;
    qrImg.src = `/api/qr.svg?t=${Date.now()}`;
  }
}

printBtn.addEventListener('click', () => {
  window.print();
});

apiJson('/api/public/state')
  .then((data) => applyQrState(data))
  .catch(() => {});

connectSse('live', {
  onState: (data) => applyQrState(data),
});
