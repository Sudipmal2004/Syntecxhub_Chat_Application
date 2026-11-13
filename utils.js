/* Small, dependency-free helpers shared by every page.
   All DOM is built with createElement/textContent (never innerHTML with user data),
   which - together with the strict CSP - closes the door on XSS. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Hyperscript-style element builder: h('div', { class: 'x', onClick }, child, 'text'). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'value' || key === 'checked' || key === 'disabled') el[key] = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/* ------------------------------------------------------------------ icons */

const ICONS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checks: '<polyline points="1 13 6 18 17 7"/><polyline points="9 15 12 18 23 7"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>',
};

/** Returns an inline SVG icon. Markup comes from the static table above, never from user input. */
export function icon(name, className = 'icon') {
  const template = document.createElement('template');
  template.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return template.content.firstElementChild;
}

/** Replaces <span data-icon="send"></span> placeholders with real icons. */
export function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => {
    if (!el.querySelector(':scope > svg.icon')) el.prepend(icon(el.dataset.icon));
  });
}

/* ------------------------------------------------------------ misc helpers */

let counter = 0;
export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${(counter += 1)}`;

export function debounce(fn, wait = 300) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

const initialsOf = (name = '?') => {
  const clean = String(name).replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
  const parts = clean.split(/[ ._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
};

/**
 * Avatar element. `status` can be 'online' | 'offline' to show a presence dot; omit it for no dot.
 * Use `group: true` for group conversations.
 */
export function createAvatar(subject, { size = 'md', status = null, group = false } = {}) {
  const name = (subject && (subject.username || subject.groupName)) || '?';
  const el = h('span', { class: `avatar avatar--${size}${group ? ' avatar--group' : ''}`, 'aria-hidden': 'true' });

  if (group) {
    el.append(icon('users'));
  } else if (subject && subject.profilePicture) {
    el.append(h('img', { src: subject.profilePicture, alt: '', loading: 'lazy' }));
  } else {
    const hue = hashString(name) % 360;
    el.textContent = initialsOf(name);
    el.style.background = `linear-gradient(135deg, hsl(${hue} 68% 62%), hsl(${(hue + 38) % 360} 66% 52%))`;
  }
  if (status !== null) el.append(h('span', { class: `avatar__status${status === 'online' ? ' is-online' : ''}`, 'data-presence': subject && subject.id }));
  return el;
}

/* ------------------------------------------------------------ date + time */

const sameDay = (a, b) => a.toDateString() === b.toDateString();

export const formatTime = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function formatDayLabel(value) {
  const date = new Date(value);
  const now = new Date();
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

/** Compact timestamp for the conversation list. */
export function formatListTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  if (sameDay(date, now)) return formatTime(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  if (now - date < 6 * 24 * 3600 * 1000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatLastSeen(value) {
  if (!value) return 'Offline';
  const date = new Date(value);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Last seen just now';
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  if (sameDay(date, new Date())) return `Last seen today at ${formatTime(date)}`;
  return `Last seen ${formatDayLabel(date).toLowerCase()} at ${formatTime(date)}`;
}

export const formatMemberSince = (value) => new Date(value).toLocaleDateString([], { month: 'long', year: 'numeric' });

/* ----------------------------------------------------------------- toasts */

export function toast(message, type = 'info', duration = 4200) {
  let stack = $('#toastStack');
  if (!stack) {
    stack = h('div', { id: 'toastStack', class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  const el = h('div', { class: `toast toast--${type}` }, h('span', { text: message }));
  stack.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  }, duration);
}

/* ----------------------------------------------------------------- modals */

/**
 * Accessible modal dialog. Actions: [{ label, variant, onClick }]. An action's onClick may be async;
 * the dialog closes afterwards unless the handler returns false.
 */
export function openModal({ title, description, content, actions = [], onClose } = {}) {
  const previouslyFocused = document.activeElement;
  const titleId = `modal-title-${uid()}`;

  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close dialog', onClick: () => close() });
  closeBtn.append(icon('close'));

  const footer = h('div', { class: 'modal__footer' });
  const dialog = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal__header' }, h('h2', { class: 'modal__title', id: titleId, text: title }), closeBtn),
    description ? h('p', { class: 'modal__desc', text: description }) : null,
    h('div', { class: 'modal__body' }, content),
    actions.length ? footer : null
  );
  const backdrop = h('div', { class: 'modal-backdrop', onMouseDown: (e) => e.target === backdrop && close() }, dialog);

  function close() {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    if (onClose) onClose();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const focusable = $$('button:not([disabled]), input:not([disabled]), textarea, a[href], [tabindex]:not([tabindex="-1"])', dialog);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  actions.forEach((action) => {
    const button = h('button', { class: `btn btn--sm btn--${action.variant || 'ghost'}`, type: 'button', text: action.label });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await (action.onClick ? action.onClick({ close, button }) : undefined);
        if (result !== false) close();
      } catch (err) {
        toast(err.message || 'Something went wrong', 'error');
      } finally {
        button.disabled = false;
      }
    });
    footer.append(button);
  });

  document.addEventListener('keydown', onKeyDown);
  (document.getElementById('modalRoot') || document.body).append(backdrop);
  const firstField = $('input, textarea', dialog) || $('.modal__footer .btn:last-child', dialog) || closeBtn;
  firstField.focus();
  return { close, dialog };
}

/** Promise-based confirm dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    openModal({
      title,
      content: h('p', { text: message }),
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => done(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => done(true) },
      ],
      onClose: () => done(false),
    });
  });
}

export function setButtonLoading(button, loading, label) {
  const labelEl = $('.btn__label', button) || button;
  if (loading) {
    button.dataset.label = labelEl.textContent;
    labelEl.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), label || 'Please wait...');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    labelEl.textContent = button.dataset.label || label || labelEl.textContent;
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}
