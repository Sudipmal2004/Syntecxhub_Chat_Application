/* Socket.IO client wrapper. The global `io` comes from /socket.io/socket.io.js (served by the backend). */

import { session } from './api.js';

let socket = null;

/** Opens (once) an authenticated connection with automatic reconnection. */
export function connectSocket() {
  if (socket) return socket;
  socket = window.io({
    // A function is re-evaluated on every (re)connection attempt, so a refreshed token is always used.
    auth: (callback) => callback({ token: session.getToken() }),
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });
  return socket;
}

export const getSocket = () => socket;

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/**
 * Emits an event and resolves with the server's acknowledgement. Rejects if the server answers
 * with an error or does not respond in time (for example while offline).
 */
export function emitAck(event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Not connected to the server'));
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) {
        reject(new Error('The server did not respond in time'));
      } else if (!response || !response.ok) {
        const error = new Error((response && response.error) || 'Request failed');
        error.status = response && response.status;
        reject(error);
      } else {
        resolve(response);
      }
    });
  });
}
