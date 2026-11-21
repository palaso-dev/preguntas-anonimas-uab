import {
  apiJson,
  closeTopLayer,
  connectSse,
  el,
  formatTimeLabel,
  initDialogs,
  initFormValidation,
  openModalDialog,
  showToast,
  statusLabelEs,
} from './ui.mjs';

const mainHeading = document.getElementById('main-content');
const adminSubtitle = document.getElementById('admin-subtitle');
const sseBadge = document.getElementById('sse-badge');
const sseStatusText = document.getElementById('sse-status-text');
const openSettingsBtn = document.getElementById('open-settings-btn');
const logoutBtn = document.getElementById('logout-btn');

const loginSection = document.getElementById('login-section');
const loginForm = document.getElementById('login-form');
const pinInput = document.getElementById('pin-input');
const loginAlert = document.getElementById('login-alert');
const loginAlertText = document.getElementById('login-alert-text');
const loginSubmitBtn = document.getElementById('login-submit-btn');

const dashboardSection = document.getElementById('dashboard-section');
const toggleSubmissionsBtn = document.getElementById('toggle-submissions-btn');
const toggleSoundBtn = document.getElementById('toggle-sound-btn');
const liveModeSelect = document.getElementById('live-mode-select');
const adminQrImg = document.getElementById('admin-qr-img');
const urlForm = document.getElementById('url-form');
const publicUrlInput = document.getElementById('public-url-input');
const copyGuestLinkBtn = document.getElementById('copy-guest-link-btn');
const copyPresenterLinkBtn = document.getElementById('copy-presenter-link-btn');
const featuredBanner = document.getElementById('featured-banner');
const featuredBannerText = document.getElementById('featured-banner-text');
const clearFeaturedBtn = document.getElementById('clear-featured-btn');

const tabButtons = Array.from(document.querySelectorAll('[role="tab"]'));
const countEls = {
  pending: document.getElementById('count-pending'),
  approved: document.getElementById('count-approved'),
  read: document.getElementById('count-read'),
  rejected: document.getElementById('count-rejected'),
};

const searchInput = document.getElementById('search-input');
const confessionsEmpty = document.getElementById('confessions-empty');
const confessionsEmptyText = document.getElementById('confessions-empty-text');
const confessionsList = document.getElementById('confessions-list');

const editDialog = document.getElementById('edit-dialog');
const editForm = document.getElementById('edit-form');
const editMessage = document.getElementById('edit-message');

const settingsDialog = document.getElementById('settings-dialog');
const settingsForm = document.getElementById('settings-form');
const settingTitle = document.getElementById('setting-title');
const settingSubtitle = document.getElementById('setting-subtitle');
const settingNewPin = document.getElementById('setting-new-pin');
const clearAllBtn = document.getElementById('clear-all-btn');

const confirmDialog = document.getElementById('confirm-dialog');
const confirmTitle = document.getElementById('confirm-dialog-title');
const confirmMessage = document.getElementById('confirm-dialog-message');
const confirmDangerBtn = document.getElementById('confirm-danger-btn');

let adminState = null;
let activeTab = 'pending';
let soundEnabled = true;
let previousPendingIds = null;
let disconnectSse = null;
let editingId = null;
let pendingConfirmAction = null;
let lastQrKey = '';
let audioCtx = null;

initFormValidation(document);
initDialogs(document);

function playChime() {
  if (!soundEnabled) {
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  try {
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const now = audioCtx.currentTime;
    const notes = [659.25, 880];
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      gain.gain.setValueAtTime(0.001, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.08, now + idx * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.35);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.36);
    });
  } catch {
  }
}

function updateSseBadge(status) {
  const dot = sseBadge.querySelector('.status-dot');
  if (status === 'connected') {
    sseBadge.className = 'badge badge--turquoise';
    dot.className = 'status-dot status-dot--live';
    sseStatusText.textContent = 'En vivo';
  } else if (status === 'unauthenticated') {
    sseBadge.className = 'badge';
    dot.className = 'status-dot status-dot--paused';
    sseStatusText.textContent = 'Sin sesión';
  } else {
    sseBadge.className = 'badge badge--crimson';
    dot.className = 'status-dot status-dot--paused';
    sseStatusText.textContent = 'Reconectando...';
  }
}

function showAuthenticatedUi(authenticated) {
  loginSection.hidden = authenticated;
  dashboardSection.hidden = !authenticated;
  openSettingsBtn.hidden = !authenticated;
  logoutBtn.hidden = !authenticated;
}

function refreshQrImage(effectiveUrl) {
  const nextKey = effectiveUrl || 'default';
  if (nextKey !== lastQrKey) {
    lastQrKey = nextKey;
    adminQrImg.src = `/api/qr.svg?t=${Date.now()}`;
  }
}

function renderConfessions() {
  if (!adminState) {
    return;
  }
  const term = searchInput.value.trim().toLowerCase();

  const filtered = (adminState.confessions || []).filter((item) => {
    if (item.status !== activeTab) {
      return false;
    }
    if (term) {
      if (!item.message.toLowerCase().includes(term)) {
        return false;
      }
    }
    return true;
  });

  confessionsList.replaceChildren();
  if (filtered.length === 0) {
    confessionsEmpty.hidden = false;
    confessionsEmptyText.textContent = term
      ? 'No hay confesiones que coincidan con esa búsqueda.'
      : `No hay confesiones en "${statusLabelEs(activeTab)}".`;
    return;
  }

  confessionsEmpty.hidden = true;
  const fragment = document.createDocumentFragment();

  for (const item of filtered) {
    const snippet = item.message.slice(0, 32).replace(/\s+/g, ' ');
    const card = el('li', {
      className: `confession-card${item.is_featured ? ' confession-card--featured' : ''}`,
    });

    const metaLeft = el(
      'div',
      { className: 'confession-meta-left' },
      el('span', { className: 'badge' }, `#${item.id}`),
      item.is_featured
        ? el('span', { className: 'badge badge--solid-crimson' }, 'En pantalla')
        : null,
    );

    const meta = el(
      'div',
      { className: 'confession-meta' },
      metaLeft,
      el('span', {}, formatTimeLabel(item.created_at)),
    );

    const body = el('p', { className: 'confession-body' }, item.message);
    const actions = el('div', { className: 'confession-actions' });

    if (item.status === 'pending' || item.status === 'rejected') {
      actions.append(
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn--turquoise btn--sm',
            'aria-label': `Aprobar confesión ${item.id}: ${snippet}`,
            onClick: () => patchConfession(item.id, { status: 'approved' }, 'Confesión aprobada.'),
          },
          'Aprobar',
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn--primary btn--sm',
            'aria-label': `Aprobar y proyectar confesión ${item.id}: ${snippet}`,
            onClick: () => approveAndFeature(item.id),
          },
          'Aprobar y proyectar',
        ),
      );
    }

    if (item.status === 'approved' || item.status === 'read') {
      if (item.is_featured) {
        actions.append(
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn--ghost btn--sm',
              'aria-label': `Quitar de pantalla confesión ${item.id}: ${snippet}`,
              onClick: () => patchConfession(item.id, { feature: false }, 'Quitada de pantalla.'),
            },
            'Quitar de pantalla',
          ),
        );
      } else {
        actions.append(
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn--primary btn--sm',
              'aria-label': `Proyectar confesión ${item.id}: ${snippet}`,
              onClick: () => patchConfession(item.id, { feature: true }, 'Proyectada en /live.'),
            },
            'Proyectar en vivo',
          ),
        );
      }

      if (item.status === 'approved') {
        actions.append(
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn--teal btn--sm',
              'aria-label': `Marcar leída confesión ${item.id}: ${snippet}`,
              onClick: () => patchConfession(item.id, { status: 'read' }, 'Marcada como leída.'),
            },
            'Marcar leída',
          ),
        );
      } else {
        actions.append(
          el(
            'button',
            {
              type: 'button',
              className: 'btn btn--ghost btn--sm',
              'aria-label': `Devolver a aprobadas confesión ${item.id}: ${snippet}`,
              onClick: () =>
                patchConfession(item.id, { status: 'approved' }, 'Devuelta a aprobadas.'),
            },
            'Devolver a aprobadas',
          ),
        );
      }
    }

    actions.append(
      el(
        'button',
        {
          type: 'button',
          className: 'btn btn--ghost btn--sm',
          'aria-label': `Editar confesión ${item.id}: ${snippet}`,
          onClick: () => openEditModal(item),
        },
        'Editar',
      ),
    );

    if (item.status !== 'rejected') {
      actions.append(
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn--ghost btn--sm',
            'aria-label': `Descartar confesión ${item.id}: ${snippet}`,
            onClick: () => patchConfession(item.id, { status: 'rejected' }, 'Movida a descartadas.'),
          },
          'Descartar',
        ),
      );
    } else {
      actions.append(
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn--danger btn--sm',
            'aria-label': `Eliminar definitivamente confesión ${item.id}: ${snippet}`,
            onClick: () =>
              requestConfirm({
                title: 'Eliminar confesión',
                message: 'Esta acción borrará la confesión permanentemente de la base de datos.',
                confirmLabel: 'Eliminar',
                onConfirm: () => deleteSingleConfession(item.id),
              }),
          },
          'Eliminar',
        ),
      );
    }

    card.append(meta, body, actions);
    fragment.append(card);
  }

  confessionsList.append(fragment);
}

function applyAdminState(data) {
  if (!data) {
    return;
  }
  const incomingPendingIds = new Set(
    (data.confessions || []).filter((c) => c.status === 'pending').map((c) => c.id),
  );
  if (previousPendingIds !== null) {
    for (const id of incomingPendingIds) {
      if (!previousPendingIds.has(id)) {
        playChime();
        break;
      }
    }
  }
  previousPendingIds = incomingPendingIds;

  adminState = data;
  const settings = data.settings || {};

  if (settings.event_title) {
    mainHeading.textContent = settings.event_title;
    document.title = `Control | ${settings.event_title}`;
  }
  if (settings.event_subtitle !== undefined) {
    adminSubtitle.textContent = settings.event_subtitle;
  }

  const open = Boolean(settings.submissions_open);
  toggleSubmissionsBtn.textContent = open ? 'Buzón abierto (Pausar)' : 'Buzón pausado (Reabrir)';
  toggleSubmissionsBtn.className = open ? 'btn btn--turquoise btn--sm' : 'btn btn--primary btn--sm';

  if (document.activeElement !== liveModeSelect) {
    liveModeSelect.value = settings.live_mode || 'qr';
  }
  if (document.activeElement !== publicUrlInput) {
    publicUrlInput.value = settings.public_url || data.effectiveUrl || '';
  }

  refreshQrImage(data.effectiveUrl);

  const counts = data.counts || {};
  for (const [status, elCount] of Object.entries(countEls)) {
    if (elCount) {
      elCount.textContent = String(counts[status] || 0);
    }
  }

  if (data.featured) {
    featuredBanner.hidden = false;
    featuredBannerText.textContent = `“${data.featured.message}”`;
  } else {
    featuredBanner.hidden = true;
    featuredBannerText.textContent = '';
  }

  renderConfessions();
}

async function patchConfession(id, payload, toastMessage) {
  try {
    await apiJson(`/api/admin/confessions/${id}`, {
      method: 'PATCH',
      body: payload,
    });
    if (toastMessage) {
      showToast(toastMessage);
    }
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar.', 'error');
  }
}

async function approveAndFeature(id) {
  try {
    await apiJson(`/api/admin/confessions/${id}/approve-and-feature`, {
      method: 'POST',
    });
    showToast('Aprobada y proyectada en /live.');
  } catch (error) {
    showToast(error.message || 'No se pudo proyectar.', 'error');
  }
}

async function deleteSingleConfession(id) {
  try {
    await apiJson(`/api/admin/confessions/${id}`, { method: 'DELETE' });
    showToast('Confesión eliminada.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar.', 'error');
  }
}

function openEditModal(item) {
  editingId = item.id;
  editMessage.value = item.message;
  openModalDialog(editDialog);
}

function requestConfirm({ title, message, confirmLabel, onConfirm }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmDangerBtn.textContent = confirmLabel || 'Confirmar';
  pendingConfirmAction = onConfirm;
  openModalDialog(confirmDialog);
}

function activateTab(status) {
  activeTab = status;
  for (const tab of tabButtons) {
    const isSelected = tab.dataset.status === status;
    tab.setAttribute('aria-selected', String(isSelected));
    tab.setAttribute('tabindex', isSelected ? '0' : '-1');
  }
  renderConfessions();
}

for (const tab of tabButtons) {
  tab.addEventListener('click', () => {
    activateTab(tab.dataset.status);
  });
  tab.addEventListener('keydown', (event) => {
    const index = tabButtons.indexOf(tab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % tabButtons.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabButtons.length - 1;
    }
    if (nextIndex >= 0) {
      event.preventDefault();
      const targetTab = tabButtons[nextIndex];
      activateTab(targetTab.dataset.status);
      targetTab.focus();
    }
  });
}

searchInput.addEventListener('input', renderConfessions);

toggleSubmissionsBtn.addEventListener('click', async () => {
  if (!adminState) {
    return;
  }
  const nextOpen = !adminState.settings?.submissions_open;
  try {
    await apiJson('/api/admin/settings', {
      method: 'PATCH',
      body: { submissions_open: nextOpen },
    });
    showToast(nextOpen ? 'Buzón reabierto.' : 'Buzón pausado.');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar el estado.', 'error');
  }
});

toggleSoundBtn.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  toggleSoundBtn.textContent = soundEnabled
    ? 'Sonido avisos: Activado'
    : 'Sonido avisos: Silenciado';
  if (soundEnabled) {
    playChime();
  }
});

liveModeSelect.addEventListener('change', async () => {
  try {
    await apiJson('/api/admin/settings', {
      method: 'PATCH',
      body: { live_mode: liveModeSelect.value },
    });
    showToast('Pantalla /live actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar el modo.', 'error');
  }
});

urlForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!urlForm.reportValidity()) {
    return;
  }
  try {
    await apiJson('/api/admin/settings', {
      method: 'PATCH',
      body: { public_url: publicUrlInput.value.trim() },
    });
    showToast('URL del QR actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la URL.', 'error');
  }
});

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copiado.`);
  } catch {
    showToast(`Enlace: ${text}`, 'info', 7000);
  }
}

copyGuestLinkBtn.addEventListener('click', () => {
  const baseUrl = (adminState?.effectiveUrl || window.location.origin).replace(/\/+$/, '');
  copyText(`${baseUrl}/`, 'Link de invitados');
});

copyPresenterLinkBtn.addEventListener('click', () => {
  const baseUrl = (adminState?.effectiveUrl || window.location.origin).replace(/\/+$/, '');
  const token = adminState?.settings?.presenter_token || '';
  copyText(`${baseUrl}/presentadores?k=${encodeURIComponent(token)}`, 'Link de presentadores');
});

clearFeaturedBtn.addEventListener('click', async () => {
  if (!adminState?.featured) {
    return;
  }
  await patchConfession(adminState.featured.id, { feature: false }, 'Quitada de pantalla.');
});

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editForm.reportValidity() || !editingId) {
    return;
  }
  try {
    await apiJson(`/api/admin/confessions/${editingId}`, {
      method: 'PATCH',
      body: {
        message: editMessage.value.trim(),
      },
    });
    await closeTopLayer(editDialog, 'save');
    showToast('Confesión editada.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar.', 'error');
  }
});

openSettingsBtn.addEventListener('click', () => {
  if (!adminState) {
    return;
  }
  settingTitle.value = adminState.settings?.event_title || '';
  settingSubtitle.value = adminState.settings?.event_subtitle || '';
  settingNewPin.value = '';
  openModalDialog(settingsDialog);
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!settingsForm.reportValidity()) {
    return;
  }
  const payload = {
    event_title: settingTitle.value.trim(),
    event_subtitle: settingSubtitle.value.trim(),
  };
  if (settingNewPin.value.trim()) {
    payload.new_pin = settingNewPin.value.trim();
  }
  try {
    await apiJson('/api/admin/settings', {
      method: 'PATCH',
      body: payload,
    });
    await closeTopLayer(settingsDialog, 'save');
    showToast('Ajustes guardados.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar los ajustes.', 'error');
  }
});

clearAllBtn.addEventListener('click', async () => {
  await closeTopLayer(settingsDialog, '');
  requestConfirm({
    title: 'Vaciar todas las confesiones',
    message:
      'Se eliminarán TODAS las confesiones guardadas en SQLite. Exporta un respaldo CSV primero si deseas conservarlas.',
    confirmLabel: 'Vaciar todo',
    onConfirm: async () => {
      try {
        await apiJson('/api/admin/confessions', { method: 'DELETE' });
        showToast('Bandeja vaciada.');
      } catch (error) {
        showToast(error.message || 'No se pudo vaciar.', 'error');
      }
    },
  });
});

confirmDangerBtn.addEventListener('click', async () => {
  const action = pendingConfirmAction;
  pendingConfirmAction = null;
  await closeTopLayer(confirmDialog, 'confirm');
  if (action) {
    await action();
  }
});

confirmDialog.addEventListener('close', () => {
  if (confirmDialog.returnValue !== 'confirm') {
    pendingConfirmAction = null;
  }
});

async function startAdminSession() {
  const data = await apiJson('/api/admin/state');
  showAuthenticatedUi(true);
  applyAdminState(data);
  disconnectSse?.();
  disconnectSse = connectSse('admin', {
    onState: (next) => applyAdminState(next),
    onStatus: (status) => updateSseBadge(status),
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginAlert.hidden = true;
  if (!loginForm.reportValidity()) {
    return;
  }
  loginSubmitBtn.disabled = true;
  try {
    await apiJson('/api/admin/login', {
      method: 'POST',
      body: { pin: pinInput.value.trim() },
    });
    pinInput.value = '';
    await startAdminSession();
    showToast('Sesión iniciada.');
  } catch (error) {
    loginAlertText.textContent = error.message || 'PIN incorrecto.';
    loginAlert.hidden = false;
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  disconnectSse?.();
  disconnectSse = null;
  previousPendingIds = null;
  adminState = null;
  await apiJson('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showAuthenticatedUi(false);
  updateSseBadge('unauthenticated');
});

startAdminSession().catch(() => {
  showAuthenticatedUi(false);
  updateSseBadge('unauthenticated');
});
