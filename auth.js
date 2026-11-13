/* Login + registration pages. */

import { api, session, ApiError } from './api.js';
import { $, $$, hydrateIcons, setButtonLoading } from './utils.js';

hydrateIcons();

const loginForm = $('#loginForm');
const registerForm = $('#registerForm');
const form = loginForm || registerForm;
const alertBox = $('#formAlert');
const submitBtn = $('#submitBtn');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,30}$/;

/* ---------------------------------------------------------- field helpers */

function showFieldError(name, message) {
  const input = $(`#${name}`);
  const error = $(`#${name}Error`);
  if (!input || !error) return;
  input.setAttribute('aria-invalid', 'true');
  error.textContent = message;
  error.hidden = false;
}

function clearFieldError(name) {
  const input = $(`#${name}`);
  const error = $(`#${name}Error`);
  if (input) input.removeAttribute('aria-invalid');
  if (error) {
    error.textContent = '';
    error.hidden = true;
  }
}

function showAlert(message, type = 'error') {
  alertBox.className = `alert alert--${type}`;
  alertBox.textContent = message;
  alertBox.hidden = false;
}

const clearAlert = () => {
  alertBox.hidden = true;
  alertBox.textContent = '';
};

function passwordProblem(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

/* ------------------------------------------------------------- validation */

function validate(values) {
  const errors = {};
  if (registerForm) {
    if (!USERNAME_RE.test(values.username)) errors.username = 'Use 3-30 letters, numbers, underscores or dots';
    if (values.password !== values.confirmPassword) errors.confirmPassword = 'Passwords do not match';
  }
  if (!EMAIL_RE.test(values.email)) errors.email = 'Please enter a valid email address';
  if (registerForm) {
    const problem = passwordProblem(values.password);
    if (problem) errors.password = problem;
  } else if (!values.password) {
    errors.password = 'Password is required';
  }
  return errors;
}

function readValues() {
  const get = (id) => ($(`#${id}`) ? $(`#${id}`).value : '');
  return {
    username: get('username').trim(),
    email: get('email').trim(),
    password: get('password'),
    confirmPassword: get('confirmPassword'),
  };
}

/* --------------------------------------------------------------- behaviour */

async function submit(event) {
  event.preventDefault();
  clearAlert();
  ['username', 'email', 'password', 'confirmPassword'].forEach(clearFieldError);

  const values = readValues();
  const errors = validate(values);
  const failing = Object.keys(errors);
  if (failing.length) {
    failing.forEach((name) => showFieldError(name, errors[name]));
    $(`#${failing[0]}`).focus();
    return;
  }

  setButtonLoading(submitBtn, true, loginForm ? 'Logging in...' : 'Creating account...');
  try {
    const { username, email, password } = values;
    const result = loginForm ? await api.auth.login({ email, password }) : await api.auth.register({ username, email, password });
    session.setToken(result.token);
    location.replace('chat.html');
  } catch (err) {
    setButtonLoading(submitBtn, false);
    if (err instanceof ApiError && err.errors.length) {
      err.errors.forEach(({ field, message }) => showFieldError(field, message));
      showAlert(err.message);
    } else if (err instanceof ApiError && err.status === 409) {
      showAlert(err.message);
    } else {
      showAlert(err.message || 'Something went wrong. Please try again.');
    }
  }
}

function setupPasswordToggle() {
  const toggle = $('#togglePassword');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const input = $('#password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

function setupPasswordRules() {
  const rules = $('#passwordRules');
  if (!rules) return;
  const checks = {
    length: (v) => v.length >= 8,
    letter: (v) => /[A-Za-z]/.test(v),
    number: (v) => /\d/.test(v),
  };
  $('#password').addEventListener('input', (event) => {
    $$('li', rules).forEach((li) => li.classList.toggle('is-met', checks[li.dataset.rule](event.target.value)));
  });
}

async function redirectIfSignedIn() {
  if (!session.getToken()) return;
  try {
    await api.auth.me();
    location.replace('chat.html');
  } catch {
    session.clear(); // stale or revoked token: stay on the form
  }
}

function showContextMessage() {
  const params = new URLSearchParams(location.search);
  if (params.has('expired')) showAlert('Your session has ended. Please log in again.', 'info');
  if (params.has('loggedout')) showAlert('You have been logged out securely.', 'success');
}

if (form) {
  form.addEventListener('submit', submit);
  form.addEventListener('input', (event) => clearFieldError(event.target.id));
  setupPasswordToggle();
  setupPasswordRules();
  showContextMessage();
  redirectIfSignedIn();
}
