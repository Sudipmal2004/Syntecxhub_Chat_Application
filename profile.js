/* Profile page: edit username, bio, avatar and password. */

import { api, session } from './api.js';
import { $, hydrateIcons, createAvatar, toast, setButtonLoading, formatMemberSince } from './utils.js';

hydrateIcons();

const alertBox = $('#formAlert');
const profileForm = $('#profileForm');
const passwordForm = $('#passwordForm');
const avatarInput = $('#avatarInput');
const removeBtn = $('#removeAvatarBtn');

const MAX_AVATAR = 2 * 1024 * 1024;
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,30}$/;

let me = null;
let pendingFile = null;
let removeAvatar = false;
let previewUrl = null;

function showAlert(message, type = 'error') {
  alertBox.className = `alert alert--${type}`;
  alertBox.textContent = message;
  alertBox.hidden = false;
  alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setFieldError(name, message) {
  const input = $(`#${name}`);
  const error = $(`#${name}Error`);
  if (!error) return;
  if (input) message ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
  error.textContent = message || '';
  error.hidden = !message;
}

function clearErrors(...names) {
  alertBox.hidden = true;
  names.forEach((name) => setFieldError(name, ''));
}

function applyServerErrors(err) {
  const fields = new Set(['username', 'bio', 'avatar', 'currentPassword', 'newPassword']);
  let shown = false;
  (err.errors || []).forEach((e) => {
    if (fields.has(e.field)) {
      setFieldError(e.field, e.message);
      shown = true;
    }
  });
  if (!shown) showAlert(err.message);
}

function renderAvatar() {
  const subject = removeAvatar ? { ...me, profilePicture: '' } : previewUrl ? { ...me, profilePicture: previewUrl } : me;
  $('#avatarPreview').replaceChildren(createAvatar(subject, { size: 'xl' }));
  removeBtn.hidden = !(pendingFile || (me.profilePicture && !removeAvatar));
}

function fillForm() {
  $('#username').value = me.username;
  $('#email').value = me.email;
  $('#bio').value = me.bio || '';
  $('#bioCount').textContent = String(($('#bio').value || '').length);
  $('#emailText').textContent = me.email;
  $('#sinceText').textContent = `Member since ${formatMemberSince(me.createdAt)}`;
  renderAvatar();
}

avatarInput.addEventListener('change', () => {
  clearErrors('avatar');
  const file = avatarInput.files[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    avatarInput.value = '';
    return setFieldError('avatar', 'Please choose a JPEG, PNG, WebP or GIF image.');
  }
  if (file.size > MAX_AVATAR) {
    avatarInput.value = '';
    return setFieldError('avatar', 'That image is larger than 2 MB.');
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  pendingFile = file;
  removeAvatar = false;
  previewUrl = URL.createObjectURL(file);
  renderAvatar();
  return undefined;
});

removeBtn.addEventListener('click', () => {
  pendingFile = null;
  avatarInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  removeAvatar = Boolean(me.profilePicture);
  renderAvatar();
});

$('#bio').addEventListener('input', (e) => {
  $('#bioCount').textContent = String(e.target.value.length);
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors('username', 'bio', 'avatar');

  const username = $('#username').value.trim();
  if (!USERNAME_RE.test(username)) return setFieldError('username', 'Use 3-30 letters, numbers, underscores or dots');

  const form = new FormData();
  form.append('username', username);
  form.append('bio', $('#bio').value);
  if (pendingFile) form.append('avatar', pendingFile);
  else if (removeAvatar) form.append('removeAvatar', 'true');

  const button = $('#saveBtn');
  setButtonLoading(button, true, 'Saving...');
  try {
    const { user } = await api.users.updateProfile(form);
    me = user;
    pendingFile = null;
    removeAvatar = false;
    avatarInput.value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    fillForm();
    toast('Profile updated', 'success');
  } catch (err) {
    applyServerErrors(err);
  } finally {
    setButtonLoading(button, false);
  }
  return undefined;
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors('currentPassword', 'newPassword');
  const currentPassword = $('#currentPassword').value;
  const newPassword = $('#newPassword').value;

  if (!currentPassword) return setFieldError('currentPassword', 'Enter your current password');
  if (newPassword.length < 8) return setFieldError('newPassword', 'Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return setFieldError('newPassword', 'Password must contain at least one letter and one number');

  const form = new FormData();
  form.append('currentPassword', currentPassword);
  form.append('newPassword', newPassword);

  const button = $('#passwordBtn');
  setButtonLoading(button, true, 'Updating...');
  try {
    const { token } = await api.users.updateProfile(form);
    if (token) session.setToken(token); // the old token was revoked, keep this device signed in
    passwordForm.reset();
    toast('Password updated. Other devices were signed out.', 'success');
  } catch (err) {
    applyServerErrors(err);
  } finally {
    setButtonLoading(button, false);
  }
  return undefined;
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api.auth.logout();
  } catch {
    /* clear the local session regardless */
  }
  session.clear();
  location.replace('login.html');
});

(async function init() {
  if (!session.getToken()) return location.replace('login.html');
  try {
    me = (await api.auth.me()).user;
    fillForm();
  } catch (err) {
    if (err.status !== 401) showAlert(err.message);
  }
  return undefined;
})();
