import { session } from './api.js';
import { hydrateIcons } from './utils.js';

hydrateIcons();

// Signed-in visitors get a shortcut straight into the app instead of the sign-up buttons.
if (session.getToken()) {
  const actions = document.querySelector('.landing__nav-actions');
  if (actions) {
    actions.replaceChildren();
    const open = document.createElement('a');
    open.className = 'btn btn--primary btn--sm';
    open.href = 'chat.html';
    open.textContent = 'Open chat';
    actions.append(open);
  }
}
