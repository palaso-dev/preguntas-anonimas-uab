import {
  closeTopLayer,
  el,
  formatTimeLabel,
  initDialogs,
  initFormValidation,
  openModalDialog,
  showToast,
  statusLabelEs,
} from './ui.mjs';
import {
  fetchAllStateForStaff,
  generateQrPngDataUrl,
  generateQrSvgString,
  getSupabase,
  isSupabaseConfigured,
  setFeaturedConfessionDb,
  subscribeGalaRealtime,
  updateSettingKeys,
} from './supabase-client.mjs';

const setupBanner = document.getElementById('setup-banner');
const mainHeading = document.getElementById('main-content');
const adminSubtitle = document.getElementById('admin-subtitle');
const sseBadge = document.getElementById('sse-badge');
const sseStatusText = document.getElementById('sse-status-text');
const openSettingsBtn = document.getElementById('open-settings-btn');
const logoutBtn = document.getElementById('logout-btn');

const loginSection = document.getElementById('login-section');
const loginForm = document.getElementById('login-form');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');
const loginAlert = document.getElementById('login-alert');
const loginAlertText = document.getElementById('login-alert-text');
const loginSubmitBtn = document.getElementById('login-submit-btn');

const dashboardSection = document.getElementById('dashboard-section');
const toggleSubmissionsBtn = document.getElementById('toggle-submissions-btn');
const toggleSoundBtn = document.getElementById('toggle-sound-btn');
const liveModeSelect = document.getElementById('live-mode-select');
const adminQrImg = document.getElementById('admin-qr-img');
const downloadPngLink = document.getElementById('download-png-link');
const downloadSvgLink = document.getElementById('download-svg-link');
const urlForm = document.getElementById('url-form');
const publicUrlInput = document.getElementById('public-url-input');
const copyGuestLinkBtn = document.getElementById('copy-guest-link-btn');
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
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const clearAllBtn = document.getElementById('clear-all-btn');

const confirmDialog = document.getElementById('confirm-dialog');
const confirmTitle = document.getElementById('confirm-dialog-title');
const confirmMessage = document.getElementById('confirm-dialog-message');
const confirmDangerBtn = document.getElementById('confirm-danger-btn');

let adminState = null;
let activeTab = 'pending';
let soundEnabled = true;
let previousPendingIds = null;
let unsubscribeRealtime = null;
let editingId = null;
let pendingConfirmAction = null;
let lastQrUrl = '';
let lastSvgUrl = '';
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
    [659.25, 880].forEach((freq, idx) => {
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

function updateBadgeStatus(status) {
  const dot = sseBadge.querySelector('.status-dot');
  if (status === 'connected') {
    sseBadge.className = 'badge badge--turquoise';
    dot.className = 'status-dot status-dot--live';
    sseStatusText.textContent = 'En vivo';
  } else {
    sseBadge.className = 'badge';
    dot.className = 'status-dot status-dot--paused';
    sseStatusText.textContent = 'Sin sesión';
  }
}

function showAuthenticatedUi(authenticated) {
  loginSection.hidden = authenticated;
  dashboardSection.hidden = !authenticated;
  openSettingsBtn.hidden = !authenticated;
  logoutBtn.hidden = !authenticated;
}

async function refreshQrPreview(effectiveUrl) {
  if (!effectiveUrl || effectiveUrl === lastQrUrl) {
    return;
  }
  lastQrUrl = effectiveUrl;
  try {
    const [pngDataUrl, svgString] = await Promise.all([
      generateQrPngDataUrl(effectiveUrl),
      generateQrSvgString(effectiveUrl),
    ]);
    adminQrImg.src = pngDataUrl;
    downloadPngLink.href = pngDataUrl;
    if (lastSvgUrl) {
      URL.revokeObjectURL(lastSvgUrl);
    }
    lastSvgUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
    downloadSvgLink.href = lastSvgUrl;
  } catch {
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
    if (term && !item.message.toLowerCase().includes(term)) {
      return false;
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
            onClick: () => updateConfessionRow(item.id, { status: 'approved' }, 'Confesión aprobada.'),
          },
          'Aprobar',
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn--primary btn--sm',
            'aria-label': `Aprobar y proyectar confesión ${item.id}: ${snippet}`,
            onClick: () => featureConfession(item.id, true),
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
              onClick: () => featureConfession(item.id, false),
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
              onClick: () => featureConfession(item.id, true),
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
              onClick: () => updateConfessionRow(item.id, { status: 'read', is_featured: false }, 'Marcada como leída.'),
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
                updateConfessionRow(item.id, { status: 'approved' }, 'Devuelta a aprobadas.'),
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
            onClick: () => updateConfessionRow(item.id, { status: 'rejected', is_featured: false }, 'Movida a descartadas.'),
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
                message: 'Esta acción borrará la confesión permanentemente.',
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
  if (settings.event_subtitle) {
    adminSubtitle.textContent = settings.event_subtitle;
  } else {
    adminSubtitle.textContent = 'Control de confesiones y pantalla en vivo';
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

  refreshQrPreview(data.effectiveUrl);

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

async function refreshAdminState() {
  const data = await fetchAllStateForStaff();
  applyAdminState(data);
}

async function updateConfessionRow(id, patch, toastMessage) {
  try {
    const sb = getSupabase();
    const { error } = await sb
      .from('confessions')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      throw error;
    }
    await refreshAdminState();
    if (toastMessage) {
      showToast(toastMessage);
    }
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar.', 'error');
  }
}

async function featureConfession(id, shouldFeature) {
  try {
    await setFeaturedConfessionDb(shouldFeature ? id : null);
    await refreshAdminState();
    showToast(shouldFeature ? 'Proyectada en /live.' : 'Quitada de pantalla.');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la pantalla.', 'error');
  }
}

async function deleteSingleConfession(id) {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('confessions').delete().eq('id', id);
    if (error) {
      throw error;
    }
    await refreshAdminState();
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
  tab.addEventListener('click', () => activateTab(tab.dataset.status));
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
    await updateSettingKeys({ submissions_open: nextOpen ? 'true' : 'false' });
    await refreshAdminState();
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
    await updateSettingKeys({ live_mode: liveModeSelect.value });
    await refreshAdminState();
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
    const nextUrl = publicUrlInput.value.trim().replace(/\/+$/, '');
    await updateSettingKeys({ public_url: nextUrl });
    await refreshAdminState();
    showToast('URL del QR actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la URL.', 'error');
  }
});

copyGuestLinkBtn.addEventListener('click', async () => {
  const link = adminState?.effectiveUrl || new URL('./', window.location.href).toString();
  try {
    await navigator.clipboard.writeText(link);
    showToast('Link de invitados copiado.');
  } catch {
    showToast(`Enlace: ${link}`, 'info', 7000);
  }
});

clearFeaturedBtn.addEventListener('click', async () => {
  if (adminState?.featured) {
    await featureConfession(adminState.featured.id, false);
  }
});

editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editForm.reportValidity() || !editingId) {
    return;
  }
  await updateConfessionRow(editingId, { message: editMessage.value.trim() }, 'Confesión editada.');
  await closeTopLayer(editDialog, 'save');
});

openSettingsBtn.addEventListener('click', () => {
  if (!adminState) {
    return;
  }
  settingTitle.value = adminState.settings?.event_title || '';
  settingSubtitle.value = adminState.settings?.event_subtitle || '';
  openModalDialog(settingsDialog);
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!settingsForm.reportValidity()) {
    return;
  }
  try {
    await updateSettingKeys({
      event_title: settingTitle.value.trim(),
      event_subtitle: settingSubtitle.value.trim(),
    });
    await closeTopLayer(settingsDialog, 'save');
    await refreshAdminState();
    showToast('Ajustes guardados.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar.', 'error');
  }
});

function downloadTextFile(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportCsvBtn.addEventListener('click', () => {
  const rows = adminState?.confessions || [];
  const escapeCell = (val) => {
    const str = String(val ?? '');
    const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = ['id,fecha_utc,estado,destacada,mensaje'];
  for (const r of rows) {
    lines.push([r.id, r.created_at, r.status, r.is_featured ? 'si' : 'no', r.message].map(escapeCell).join(','));
  }
  downloadTextFile('confesiones-gala.csv', 'text/csv;charset=utf-8', `\uFEFF${lines.join('\r\n')}`);
});

exportJsonBtn.addEventListener('click', () => {
  const rows = adminState?.confessions || [];
  downloadTextFile('confesiones-gala.json', 'application/json;charset=utf-8', JSON.stringify(rows, null, 2));
});

clearAllBtn.addEventListener('click', async () => {
  await closeTopLayer(settingsDialog, '');
  requestConfirm({
    title: 'Vaciar todas las confesiones',
    message: 'Se eliminarán TODAS las confesiones guardadas. Exporta un respaldo CSV primero si deseas conservarlas.',
    confirmLabel: 'Vaciar todo',
    onConfirm: async () => {
      try {
        const sb = getSupabase();
        const { error } = await sb.from('confessions').delete().neq('id', 0);
        if (error) {
          throw error;
        }
        await refreshAdminState();
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
  const sb = getSupabase();
  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData?.session) {
    showAuthenticatedUi(false);
    updateBadgeStatus('unauthenticated');
    return;
  }
  showAuthenticatedUi(true);
  updateBadgeStatus('connected');
  await refreshAdminState();
  unsubscribeRealtime?.();
  unsubscribeRealtime = subscribeGalaRealtime(() => {
    refreshAdminState().catch(() => {});
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
    const sb = getSupabase();
    const { error } = await sb.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });
    if (error) {
      throw error;
    }
    passwordInput.value = '';
    await startAdminSession();
    showToast('Sesión iniciada.');
  } catch (error) {
    loginAlertText.textContent = error.message || 'Credenciales incorrectas.';
    loginAlert.hidden = false;
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  unsubscribeRealtime?.();
  unsubscribeRealtime = null;
  previousPendingIds = null;
  adminState = null;
  try {
    await getSupabase().auth.signOut();
  } catch {
  }
  showAuthenticatedUi(false);
  updateBadgeStatus('unauthenticated');
});

if (!isSupabaseConfigured()) {
  setupBanner.hidden = false;
  loginSubmitBtn.disabled = true;
  updateBadgeStatus('unauthenticated');
} else {
  startAdminSession().catch(() => {
    showAuthenticatedUi(false);
    updateBadgeStatus('unauthenticated');
  });
}
