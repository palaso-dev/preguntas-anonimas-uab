import {
  el,
  formatTimeLabel,
  initFormValidation,
  showToast,
} from './ui.mjs';
import {
  fetchAllStateForStaff,
  getSupabase,
  isSupabaseConfigured,
  setFeaturedConfessionDb,
  subscribeGalaRealtime,
} from './supabase-client.mjs';

const mainHeading = document.getElementById('main-content');
const presenterSubtitle = document.getElementById('presenter-subtitle');
const sseBadge = document.getElementById('presenter-sse-badge');
const sseText = document.getElementById('presenter-sse-text');
const unreadBadge = document.getElementById('unread-badge');

const loginSection = document.getElementById('presenter-login-section');
const loginForm = document.getElementById('presenter-login-form');
const emailInput = document.getElementById('presenter-email-input');
const pinInput = document.getElementById('presenter-pin-input');
const loginAlert = document.getElementById('presenter-login-alert');
const loginAlertText = document.getElementById('presenter-login-alert-text');
const loginBtn = document.getElementById('presenter-login-btn');

const stageSection = document.getElementById('presenter-stage-section');
const featuredBanner = document.getElementById('presenter-featured-banner');
const featuredText = document.getElementById('presenter-featured-text');
const clearFeaturedBtn = document.getElementById('presenter-clear-featured-btn');
const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
const sortToggleBtn = document.getElementById('sort-toggle-btn');
const newItemsPillWrap = document.getElementById('new-items-pill-wrap');
const newItemsPillBtn = document.getElementById('new-items-pill-btn');
const presenterEmpty = document.getElementById('presenter-empty');
const presenterEmptyText = document.getElementById('presenter-empty-text');
const presenterList = document.getElementById('presenter-list');

let presenterState = null;
let deferredState = null;
let activeFilter = 'approved';
let newestFirst = false;
let unsubscribeRealtime = null;

initFormValidation(document);

function updateBadgeStatus(status) {
  const dot = sseBadge.querySelector('.status-dot');
  if (status === 'connected') {
    sseBadge.className = 'badge badge--turquoise';
    dot.className = 'status-dot status-dot--live';
    sseText.textContent = 'En vivo';
  } else {
    sseBadge.className = 'badge';
    dot.className = 'status-dot status-dot--paused';
    sseText.textContent = 'Sin acceso';
  }
}

function showStageUi(authenticated) {
  loginSection.hidden = authenticated;
  stageSection.hidden = !authenticated;
  unreadBadge.hidden = !authenticated;
}

function renderConfessionList() {
  if (!presenterState) {
    return;
  }
  const sourceItems = presenterState.approvedAndRead || [];
  let items = sourceItems.filter((item) => {
    if (activeFilter === 'approved') {
      return item.status === 'approved';
    }
    if (activeFilter === 'read') {
      return item.status === 'read';
    }
    return true;
  });

  if (newestFirst) {
    items = [...items].reverse();
  }

  presenterList.replaceChildren();
  if (items.length === 0) {
    presenterEmpty.hidden = false;
    presenterEmptyText.textContent =
      activeFilter === 'approved'
        ? 'No hay confesiones pendientes por leer en este momento.'
        : activeFilter === 'read'
          ? 'Aún no has marcado ninguna confesión como leída.'
          : 'Aún no hay confesiones aprobadas.';
    return;
  }

  presenterEmpty.hidden = true;
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const snippet = item.message.slice(0, 32).replace(/\s+/g, ' ');
    const isRead = item.status === 'read';
    const card = el('li', {
      className: `confession-card${item.is_featured ? ' confession-card--featured' : ''}${isRead ? ' confession-card--read' : ''}`,
    });

    const metaLeft = el(
      'div',
      { className: 'confession-meta-left' },
      el('span', { className: 'badge' }, `#${item.id}`),
      isRead ? el('span', { className: 'badge' }, 'Leída') : null,
      item.is_featured
        ? el('span', { className: 'badge badge--solid-crimson' }, 'En pantalla ahora')
        : null,
    );

    const meta = el(
      'div',
      { className: 'confession-meta' },
      metaLeft,
      el('span', {}, formatTimeLabel(item.created_at)),
    );

    const body = el('p', { className: 'confession-body confession-body--stage' }, item.message);

    const actions = el(
      'div',
      { className: 'confession-actions' },
      el(
        'button',
        {
          type: 'button',
          className: item.is_featured ? 'btn btn--ghost btn--lg' : 'btn btn--primary btn--lg',
          'aria-label': item.is_featured
            ? `Quitar de pantalla confesión ${item.id}: ${snippet}`
            : `Proyectar en pantalla confesión ${item.id}: ${snippet}`,
          onClick: () => toggleFeature(item.id, !item.is_featured),
        },
        item.is_featured ? 'En pantalla ahora (Quitar)' : 'Proyectar en pantalla',
      ),
      el(
        'button',
        {
          type: 'button',
          className: isRead ? 'btn btn--ghost btn--lg' : 'btn btn--turquoise btn--lg',
          'aria-label': isRead
            ? `Devolver a por leer confesión ${item.id}: ${snippet}`
            : `Marcar leída confesión ${item.id}: ${snippet}`,
          onClick: () => toggleRead(item.id, !isRead),
        },
        isRead ? 'Devolver a por leer' : 'Marcar como leída',
      ),
    );

    card.append(meta, body, actions);
    fragment.append(card);
  }

  presenterList.append(fragment);
}

function applyPresenterState(nextState, forceRenderList = false) {
  if (!nextState) {
    return;
  }
  const settings = nextState.settings || {};
  if (settings.event_title) {
    mainHeading.textContent = settings.event_title;
    document.title = `Presentadores | ${settings.event_title}`;
  }
  if (settings.event_subtitle) {
    presenterSubtitle.textContent = settings.event_subtitle;
  }

  const unreadCount = nextState.counts?.approved ?? 0;
  unreadBadge.textContent = `${unreadCount} por leer`;

  if (nextState.featured) {
    featuredBanner.hidden = false;
    featuredText.textContent = `“${nextState.featured.message}”`;
  } else {
    featuredBanner.hidden = true;
    featuredText.textContent = '';
  }

  const prevCount = (presenterState?.approvedAndRead || []).length;
  const nextCount = (nextState.approvedAndRead || []).length;
  const isScrolledDown = window.scrollY > 180;

  if (!forceRenderList && presenterState && isScrolledDown && nextCount > prevCount) {
    deferredState = nextState;
    const diff = nextCount - prevCount;
    newItemsPillBtn.textContent =
      diff === 1
        ? '1 nueva confesión · Actualizar lista'
        : `${diff} nuevas confesiones · Actualizar lista`;
    newItemsPillWrap.hidden = false;
    return;
  }

  deferredState = null;
  newItemsPillWrap.hidden = true;
  presenterState = nextState;
  renderConfessionList();
}

async function refreshPresenterState(force = false) {
  const data = await fetchAllStateForStaff();
  applyPresenterState(data, force);
}

async function toggleRead(id, markAsRead) {
  try {
    const sb = getSupabase();
    const patch = {
      status: markAsRead ? 'read' : 'approved',
      updated_at: new Date().toISOString(),
    };
    if (markAsRead) {
      patch.is_featured = false;
    }
    const { error } = await sb.from('confessions').update(patch).eq('id', id);
    if (error) {
      throw error;
    }
    await refreshPresenterState(true);
    showToast(markAsRead ? 'Marcada como leída.' : 'Devuelta a por leer.');
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar.', 'error');
  }
}

async function toggleFeature(id, shouldFeature) {
  try {
    await setFeaturedConfessionDb(shouldFeature ? id : null);
    await refreshPresenterState(true);
    showToast(shouldFeature ? 'Proyectada en pantalla.' : 'Quitada de pantalla.');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la pantalla.', 'error');
  }
}

clearFeaturedBtn.addEventListener('click', () => {
  const featured = presenterState?.featured;
  if (featured) {
    toggleFeature(featured.id, false);
  }
});

for (const btn of filterButtons) {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    for (const item of filterButtons) {
      item.setAttribute('aria-pressed', String(item === btn));
    }
    if (deferredState) {
      applyPresenterState(deferredState, true);
    } else {
      renderConfessionList();
    }
  });
}

sortToggleBtn.addEventListener('click', () => {
  newestFirst = !newestFirst;
  sortToggleBtn.textContent = newestFirst
    ? 'Orden: Más nuevas primero'
    : 'Orden: Orden de llegada';
  renderConfessionList();
});

newItemsPillBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (deferredState) {
    applyPresenterState(deferredState, true);
  }
});

window.addEventListener('scroll', () => {
  if (deferredState && window.scrollY <= 40) {
    applyPresenterState(deferredState, true);
  }
});

async function startPresenterSession() {
  const sb = getSupabase();
  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData?.session) {
    showStageUi(false);
    updateBadgeStatus('unauthenticated');
    return;
  }
  showStageUi(true);
  updateBadgeStatus('connected');
  await refreshPresenterState(true);
  unsubscribeRealtime?.();
  unsubscribeRealtime = subscribeGalaRealtime(() => {
    refreshPresenterState(false).catch(() => {});
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginAlert.hidden = true;
  if (!loginForm.reportValidity()) {
    return;
  }
  loginBtn.disabled = true;
  try {
    const sb = getSupabase();
    const { error } = await sb.auth.signInWithPassword({
      email: emailInput.value.trim(),
      password: pinInput.value,
    });
    if (error) {
      throw error;
    }
    pinInput.value = '';
    await startPresenterSession();
    showToast('Acceso concedido.');
  } catch (error) {
    loginAlertText.textContent = error.message || 'Credenciales incorrectas.';
    loginAlert.hidden = false;
  } finally {
    loginBtn.disabled = false;
  }
});

if (!isSupabaseConfigured()) {
  showStageUi(false);
  updateBadgeStatus('unauthenticated');
  loginBtn.disabled = true;
} else {
  startPresenterSession().catch(() => {
    showStageUi(false);
    updateBadgeStatus('unauthenticated');
  });
}
