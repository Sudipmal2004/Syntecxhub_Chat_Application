/* REST API client + session storage. Every network call in the front end goes through here. */

const TOKEN_KEY = 'pulse.token';
let memoryToken = null; // fallback when localStorage is blocked (e.g. strict private modes)

export const session = {
  getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || memoryToken;
    } catch {
      return memoryToken;
    }
  },
  setToken(token) {
    memoryToken = token;
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable: the in-memory copy keeps this tab working */
    }
  },
  clear() {
    memoryToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

export class ApiError extends Error {
  constructor(message, status = 0, errors = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
}

export function redirectToLogin(reason) {
  const page = location.pathname.split('/').pop();
  if (page === 'login.html' || page === 'register.html') return;
  location.replace(`login.html${reason ? `?${reason}=1` : ''}`);
}

const buildQuery = (params = {}) => {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

async function request(path, { method = 'GET', body, form, auth = true } = {}) {
  const headers = {};
  if (auth) {
    const token = session.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (form) {
    payload = form; // the browser sets the multipart boundary itself
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError('Cannot reach the server. Please check your connection and try again.', 0);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON body */
  }

  if (!response.ok) {
    if (response.status === 401 && auth) {
      session.clear();
      redirectToLogin('expired');
    }
    throw new ApiError((data && data.message) || `Request failed (${response.status})`, response.status, (data && data.errors) || []);
  }
  return data;
}

export const api = {
  auth: {
    register: (body) => request('/auth/register', { method: 'POST', body, auth: false }),
    login: (body) => request('/auth/login', { method: 'POST', body, auth: false }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
  },
  users: {
    list: (params) => request(`/users${buildQuery(params)}`),
    search: (q) => request(`/users/search${buildQuery({ q })}`),
    get: (id) => request(`/users/${id}`),
    updateProfile: (form) => request('/users/profile', { method: 'PUT', form }),
  },
  conversations: {
    list: () => request('/conversations'),
    get: (id) => request(`/conversations/${id}`),
    startPrivate: (participantId) => request('/conversations', { method: 'POST', body: { participantId } }),
    createGroup: (body) => request('/conversations/group', { method: 'POST', body }),
    publicRooms: (q) => request(`/conversations/rooms/public${buildQuery({ q })}`),
    join: (id) => request(`/conversations/${id}/join`, { method: 'POST' }),
    leave: (id) => request(`/conversations/${id}/leave`, { method: 'POST' }),
    addMembers: (id, userIds) => request(`/conversations/${id}/members`, { method: 'POST', body: { userIds } }),
  },
  messages: {
    list: (conversationId, params) => request(`/messages/${conversationId}${buildQuery(params)}`),
    send: (body) => request('/messages', { method: 'POST', body }),
    markRead: (id) => request(`/messages/${id}/read`, { method: 'PUT' }),
    remove: (id) => request(`/messages/${id}`, { method: 'DELETE' }),
  },
};
