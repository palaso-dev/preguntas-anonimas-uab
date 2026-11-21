let popoverPolyfillPromise = null;
let supportsDisplayTransitionCache;

function ensurePopoverPolyfill() {
  if (Object.hasOwn(HTMLElement.prototype, 'popover')) {
    return Promise.resolve();
  }
  if (!popoverPolyfillPromise) {
    popoverPolyfillPromise = import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(
      () => {},
    );
  }
  return popoverPolyfillPromise;
}

function canTransitionDisplay() {
  if (supportsDisplayTransitionCache !== undefined) {
    return supportsDisplayTransitionCache;
  }
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransitionCache = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransitionCache;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
}

export async function closeTopLayer(dialog, returnValue = '') {
  if (!dialog || !dialog.open) {
    return;
  }
  if (returnValue !== undefined && returnValue !== null) {
    dialog.returnValue = returnValue;
  }
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((anim) => anim.finished)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) {
      return;
    }
    dialog.removeAttribute('data-closing');
  }
  dialog.close(dialog.returnValue);
}

export function openModalDialog(dialog) {
  if (!dialog || dialog.open) {
    return;
  }
  dialog.removeAttribute('data-closing');
  dialog.returnValue = '';
  dialog.showModal();
}

export function initDialogs(root = document) {
  const dialogs = root.querySelectorAll('dialog');
  const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;

  for (const dialog of dialogs) {
    if (dialog.dataset.dialogInitialized === 'true') {
      continue;
    }
    dialog.dataset.dialogInitialized = 'true';

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (dialog.getAttribute('closedby') === 'none') {
        return;
      }
      closeTopLayer(dialog, '');
    });

    dialog.addEventListener('close', () => {
      queueMicrotask(() => {
        dialog.returnValue = '';
      });
    });

    for (const closeBtn of dialog.querySelectorAll('[data-close-dialog]')) {
      closeBtn.addEventListener('click', () => {
        closeTopLayer(dialog, closeBtn.getAttribute('value') || '');
      });
    }

    if (!supportsClosedBy && dialog.getAttribute('closedby') === 'any') {
      const outside = (event) => {
        const rect = dialog.getBoundingClientRect();
        return (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        );
      };
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (event) => {
        pressedOutside = outside(event);
      });
      dialog.addEventListener('pointerup', (event) => {
        if (pressedOutside && outside(event)) {
          closeTopLayer(dialog, '');
        }
        pressedOutside = false;
      });
    }
  }
}

let validationAnnouncer = null;
let announceTimer = null;
let announcedField = null;
const dirtyFallbackState = new WeakMap();
const flaggedFields = new WeakSet();
const announcedFields = new WeakSet();

function getValidationAnnouncer() {
  if (validationAnnouncer && document.body.contains(validationAnnouncer)) {
    return validationAnnouncer;
  }
  validationAnnouncer = document.createElement('div');
  validationAnnouncer.setAttribute('aria-live', 'polite');
  validationAnnouncer.classList.add('visually-hidden');
  document.body.append(validationAnnouncer);
  return validationAnnouncer;
}

function linkError(el, shown) {
  const errorId = el.dataset.error;
  if (!errorId) {
    return;
  }
  const ids = (el.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (shown) {
    ids.push(errorId);
  }
  if (ids.length > 0) {
    el.setAttribute('aria-describedby', ids.join(' '));
  } else {
    el.removeAttribute('aria-describedby');
  }
}

function spokenText(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  copy.querySelectorAll('[role="img"][aria-label]').forEach((n) => {
    n.replaceWith(`${n.getAttribute('aria-label')}: `);
  });
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

function announceError(el) {
  const error = document.getElementById(el.dataset.error);
  if (!error) {
    return;
  }
  const announcer = getValidationAnnouncer();
  const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
  clearTimeout(announceTimer);
  announcer.textContent = '';
  announcedField = el;
  announceTimer = setTimeout(() => {
    announcer.textContent = label + spokenText(error);
  }, 500);
}

function syncValidationState(el, announce = false) {
  if (!el?.matches?.('input, select, textarea')) {
    return;
  }
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const invalid = supportsUserInvalid
    ? el.matches(':user-invalid')
    : el.classList.contains('user-invalid-fallback');

  if (invalid) {
    if (announce && !announcedFields.has(el)) {
      announceError(el);
      announcedFields.add(el);
    }
    el.setAttribute('aria-invalid', 'true');
    linkError(el, true);
    flaggedFields.add(el);
  } else if (flaggedFields.has(el) || el.getAttribute('aria-invalid') !== 'true') {
    el.setAttribute('aria-invalid', 'false');
    linkError(el, false);
    flaggedFields.delete(el);
    announcedFields.delete(el);
    if (announcedField === el) {
      clearTimeout(announceTimer);
      if (validationAnnouncer) {
        validationAnnouncer.textContent = '';
      }
    }
  }
}

export function initFormValidation(root = document) {
  getValidationAnnouncer();
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');

  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!el.hasAttribute('aria-invalid')) {
      el.setAttribute('aria-invalid', 'false');
    }
    syncValidationState(el, false);
  });

  if (root === document && document.documentElement.dataset.validationWired === 'true') {
    return;
  }
  if (root === document) {
    document.documentElement.dataset.validationWired = 'true';
  }

  root.addEventListener(
    'blur',
    (event) => {
      const target = event.target;
      if (!supportsUserInvalid && target?.matches?.('input, select, textarea')) {
        const state = dirtyFallbackState.get(target) || { hasInteracted: false, hasBlurred: false };
        state.hasBlurred = true;
        dirtyFallbackState.set(target, state);
        if (state.hasInteracted) {
          const valid = target.validity.valid;
          target.classList.toggle('user-invalid-fallback', !valid);
          target.classList.toggle('user-valid-fallback', valid);
        }
      }
      syncValidationState(target, true);
    },
    true,
  );

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!supportsUserInvalid && target?.matches?.('input, select, textarea')) {
      const state = dirtyFallbackState.get(target) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyFallbackState.set(target, state);
      if (state.hasBlurred) {
        const valid = target.validity.valid;
        target.classList.toggle('user-invalid-fallback', !valid);
        target.classList.toggle('user-valid-fallback', valid);
      }
    }
    if (target?.hasAttribute?.('aria-invalid')) {
      syncValidationState(target, false);
    }
  });

  root.addEventListener(
    'change',
    (event) => {
      const target = event.target;
      if (!supportsUserInvalid && target?.matches?.('input, select, textarea')) {
        const state = dirtyFallbackState.get(target) || { hasInteracted: false, hasBlurred: false };
        state.hasInteracted = true;
        dirtyFallbackState.set(target, state);
        if (state.hasBlurred) {
          const valid = target.validity.valid;
          target.classList.toggle('user-invalid-fallback', !valid);
          target.classList.toggle('user-valid-fallback', valid);
        }
      }
      syncValidationState(target, true);
    },
    true,
  );

  root.addEventListener(
    'invalid',
    (event) => {
      const target = event.target;
      announcedFields.add(target);
      if (!supportsUserInvalid && target?.matches?.('input, select, textarea')) {
        dirtyFallbackState.set(target, { hasInteracted: true, hasBlurred: true });
        target.classList.add('user-invalid-fallback');
        target.classList.remove('user-valid-fallback');
      }
      syncValidationState(target, false);
    },
    true,
  );

  root.addEventListener(
    'reset',
    (event) => {
      const form = event.target;
      setTimeout(() => {
        for (const control of form.elements || []) {
          dirtyFallbackState.delete(control);
          control.classList?.remove('user-invalid-fallback', 'user-valid-fallback');
          flaggedFields.delete(control);
          announcedFields.delete(control);
          if (control.matches?.('input, select, textarea')) {
            control.setAttribute('aria-invalid', 'false');
            linkError(control, false);
          }
        }
      });
    },
    true,
  );
}

let toastRegion = null;
let toastLiveFallback = null;
let toastCounter = 0;

function ensureToastContainers() {
  if (!toastLiveFallback || !document.body.contains(toastLiveFallback)) {
    toastLiveFallback = document.createElement('div');
    toastLiveFallback.id = 'toast-aria-announcer';
    toastLiveFallback.className = 'visually-hidden';
    toastLiveFallback.setAttribute('aria-live', 'polite');
    document.body.append(toastLiveFallback);
  }
  if (!toastRegion || !document.body.contains(toastRegion)) {
    toastRegion = document.querySelector('.toast-region');
    if (!toastRegion) {
      toastRegion = document.createElement('div');
      toastRegion.className = 'toast-region';
      toastRegion.setAttribute('role', 'region');
      toastRegion.setAttribute('aria-label', 'Notificaciones');
      document.body.append(toastRegion);
    }
  }
}

function announceToastMessage(text) {
  if (typeof document.ariaNotify === 'function') {
    document.ariaNotify(text);
    return;
  }
  if (toastLiveFallback) {
    toastLiveFallback.textContent = '';
    requestAnimationFrame(() => {
      if (toastLiveFallback) {
        toastLiveFallback.textContent = text;
      }
    });
  }
}

export async function showToast(message, variant = 'info', durationMs = 4500) {
  if (document.querySelector('dialog[open]')) {
    return;
  }
  await ensurePopoverPolyfill();
  ensureToastContainers();

  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const toastId = `gala-toast-${++toastCounter}`;
  const toast = document.createElement('div');
  toast.id = toastId;
  toast.className = 'toast';
  toast.dataset.variant = variant;
  toast.setAttribute('popover', 'manual');

  const textSpan = document.createElement('span');
  textSpan.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Cerrar notificación');
  closeBtn.setAttribute('popovertarget', toastId);
  closeBtn.setAttribute('popovertargetaction', 'hide');
  closeBtn.textContent = '×';

  toast.append(textSpan, closeBtn);
  toastRegion.append(toast);

  let timerId = null;
  let removed = false;

  const removeToast = (restoreFocus = false) => {
    if (removed) {
      return;
    }
    removed = true;
    clearTimeout(timerId);
    const wasFocused = toast.contains(document.activeElement);
    try {
      toast.hidePopover?.();
    } catch {
    }
    toast.remove();
    if (restoreFocus && wasFocused) {
      const nextToastBtn = toastRegion.querySelector('.toast .toast-close');
      if (nextToastBtn instanceof HTMLElement) {
        nextToastBtn.focus();
      } else if (priorFocus && priorFocus.isConnected) {
        priorFocus.focus();
      }
    }
  };

  const startTimer = () => {
    clearTimeout(timerId);
    if (durationMs > 0) {
      timerId = setTimeout(() => {
        if (!toast.contains(document.activeElement)) {
          removeToast(false);
        }
      }, durationMs);
    }
  };

  toast.addEventListener('focusin', () => clearTimeout(timerId));
  toast.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!toast.contains(document.activeElement)) {
        startTimer();
      }
    });
  });

  closeBtn.addEventListener('click', () => removeToast(true));

  try {
    toast.showPopover();
  } catch {
    toast.classList.add(':popover-open');
  }

  announceToastMessage(message);
  startTimer();
}

export function runViewTransition(updateDomFn, focusTarget = null) {
  if (!document.startViewTransition) {
    updateDomFn();
    focusTarget?.focus?.();
    return Promise.resolve();
  }
  const transition = document.startViewTransition(() => {
    updateDomFn();
  });
  return transition.finished.finally(() => {
    focusTarget?.focus?.();
  });
}

export async function apiJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
    body:
      options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)
        ? JSON.stringify(options.body)
        : options.body,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || 'No se pudo completar la operación.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function connectSse(channel, { onState, onStatus } = {}) {
  let source = null;
  let closedManually = false;

  const open = () => {
    if (closedManually) {
      return;
    }
    source = new EventSource(`/api/events?channel=${encodeURIComponent(channel)}`);
    source.addEventListener('open', () => {
      onStatus?.('connected');
    });
    source.addEventListener('state', (event) => {
      onStatus?.('connected');
      try {
        const data = JSON.parse(event.data);
        onState?.(data);
      } catch {
      }
    });
    source.addEventListener('error', () => {
      if (closedManually) {
        return;
      }
      onStatus?.('reconnecting');
    });
  };

  open();

  return () => {
    closedManually = true;
    source?.close();
  };
}

export function formatTimeLabel(isoString) {
  if (!isoString) {
    return '';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diffSeconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSeconds < 45) {
    return 'Hace un momento';
  }
  if (diffSeconds < 3600) {
    const mins = Math.max(1, Math.floor(diffSeconds / 60));
    return `Hace ${mins} min`;
  }
  return date.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'className') {
      node.className = value;
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dataKey, dataVal] of Object.entries(value)) {
        node.dataset[dataKey] = String(dataVal);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      node.append(document.createTextNode(String(child)));
    } else {
      node.append(child);
    }
  }
  return node;
}

export function statusLabelEs(status) {
  switch (status) {
    case 'pending':
      return 'Pendiente';
    case 'approved':
      return 'Aprobada';
    case 'read':
      return 'Leída';
    case 'rejected':
      return 'Descartada';
    default:
      return status;
  }
}
