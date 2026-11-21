import {
  initFormValidation,
  runViewTransition,
  showToast,
} from './ui.mjs';
import {
  fetchPublicState,
  getSupabase,
  isSupabaseConfigured,
  subscribeGalaRealtime,
} from './supabase-client.mjs';

const snowLayer = document.getElementById('snow-layer');
const setupBanner = document.getElementById('setup-banner');
const titleEl = document.getElementById('main-content');
const subtitleEl = document.getElementById('event-subtitle');
const pausedBanner = document.getElementById('paused-banner');
const form = document.getElementById('confession-form');
const successPanel = document.getElementById('guest-success-panel');
const messageInput = document.getElementById('message-input');
const wordCounter = document.getElementById('word-counter');
const submitBtn = document.getElementById('submit-btn');
const submitAlert = document.getElementById('submit-alert');
const submitAlertText = document.getElementById('submit-alert-text');
const sendAnotherBtn = document.getElementById('send-another-btn');
const successHeading = document.getElementById('success-heading');

let submissionsOpen = true;
let lastSubmittedAt = 0;

function buildSnowflakes() {
  if (!snowLayer) {
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 20; i += 1) {
    const flake = document.createElement('span');
    flake.className = 'snow-flake';
    const size = 3.5 + (i % 4) * 1.4;
    flake.style.width = `${size}px`;
    flake.style.height = `${size}px`;
    flake.style.left = `${(i * 5.1 + (i % 3) * 1.4) % 98}%`;
    flake.style.setProperty('--fall-dur', `${10 + (i % 7) * 2.2}s`);
    flake.style.setProperty('--fall-delay', `${-(i % 9) * 1.5}s`);
    flake.style.setProperty('--drift-x', `${(i % 2 === 0 ? 1 : -1) * (12 + (i % 4) * 7)}px`);
    fragment.append(flake);
  }
  snowLayer.append(fragment);
}

buildSnowflakes();
initFormValidation(document);

function applyPublicState(data) {
  if (!data) {
    return;
  }
  const settings = data.settings || {};
  if (settings.event_title) {
    titleEl.textContent = settings.event_title;
    document.title = settings.event_title;
  }
  if (settings.event_subtitle) {
    subtitleEl.textContent = settings.event_subtitle;
    subtitleEl.hidden = false;
  } else {
    subtitleEl.textContent = '';
    subtitleEl.hidden = true;
  }

  submissionsOpen = Boolean(settings.submissions_open);
  pausedBanner.hidden = submissionsOpen;
  submitBtn.disabled = !submissionsOpen;
  messageInput.disabled = !submissionsOpen;
}

function showInlineError(message) {
  submitAlertText.textContent = message;
  submitAlert.hidden = false;
}

function clearInlineError() {
  submitAlert.hidden = true;
  submitAlertText.textContent = '';
}

function updateCounter() {
  if (wordCounter) {
    wordCounter.textContent = `${messageInput.value.length} / 320`;
  }
}

messageInput.addEventListener('input', () => {
  messageInput.setCustomValidity('');
  updateCounter();
  clearInlineError();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearInlineError();

  if (!isSupabaseConfigured()) {
    showInlineError('Falta configurar Supabase en docs/js/supabase-config.mjs.');
    return;
  }

  if (!submissionsOpen) {
    showInlineError('El buzón está en pausa en este momento.');
    return;
  }

  const now = Date.now();
  if (now - lastSubmittedAt < 4000) {
    showInlineError('Espera unos segundos antes de enviar otra confesión.');
    return;
  }

  const trimmedMsg = messageInput.value.trim();
  if (trimmedMsg.length < 5 || trimmedMsg.length > 320) {
    messageInput.setCustomValidity(
      trimmedMsg.length < 5 ? 'Escribe al menos 5 caracteres.' : 'Máximo 320 caracteres.',
    );
  } else {
    messageInput.setCustomValidity('');
  }

  if (!form.reportValidity()) {
    return;
  }

  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = 'Enviando...';

  try {
    const sb = getSupabase();
    const { error } = await sb.from('confessions').insert({
      message: trimmedMsg,
      status: 'pending',
      is_featured: false,
    });
    if (error) {
      throw error;
    }
    lastSubmittedAt = Date.now();

    form.reset();
    updateCounter();

    await runViewTransition(() => {
      form.hidden = true;
      successPanel.hidden = false;
    }, successHeading);

    showToast('Confesión enviada.');
  } catch (error) {
    showInlineError(error.message || 'No se pudo enviar tu confesión.');
    showToast(error.message || 'No se pudo enviar tu confesión.', 'error');
  } finally {
    submitBtn.disabled = !submissionsOpen;
    submitBtn.textContent = originalLabel;
  }
});

sendAnotherBtn.addEventListener('click', async () => {
  clearInlineError();
  await runViewTransition(() => {
    successPanel.hidden = true;
    form.hidden = false;
  }, messageInput);
});

if (!isSupabaseConfigured()) {
  setupBanner.hidden = false;
  submitBtn.disabled = true;
} else {
  const refresh = () => {
    fetchPublicState()
      .then((data) => applyPublicState(data))
      .catch(() => {});
  };
  refresh();
  subscribeGalaRealtime(refresh);
}
