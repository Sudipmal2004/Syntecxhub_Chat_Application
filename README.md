# Pulse Chat - Real-Time Chat Application

A full-stack, real-time messaging app: private chats, group rooms, live presence, typing indicators and delivery/read receipts, with all history stored in MongoDB.

Built with **plain HTML/CSS/JavaScript** on the front end and **Node.js, Express, MongoDB (Mongoose) and Socket.IO** on the back end. No front-end frameworks, no TypeScript.

![Dashboard](screenshots/dashboard.png)

## Features

- **Accounts** - register, log in, log out (logout revokes the token server-side), profile page with avatar upload, bio and password change.
- **Find people** - debounced username search; start a private chat in one click.
- **Private chat** - instant delivery, timestamps, day separators, sent / delivered / read ticks, delete your own messages.
- **Group rooms** - create public or private rooms, discover and join public rooms, admin can add members, leave rooms, system messages ("X joined the room").
- **Presence** - online/offline dots, "last seen", with a grace period so a page refresh never flashes "offline".
- **Typing indicators** in private and group chats.
- **History** - everything saved in MongoDB; cursor pagination ("Load earlier messages"); unread badges.
- **Resilient connection** - automatic reconnection, a "Reconnecting..." banner, messages missed while offline are fetched on reconnect, failed sends can be retried, retries never create duplicates.
- **Responsive UI** - desktop three-pane layout, mobile layout with bottom navigation; keyboard accessible, labelled forms, ARIA live regions, empty states and loading skeletons.

## Screenshots

All screenshots are captured from the running application by `npm run screenshots` (real browser sessions, real data).

| | |
|---|---|
| ![Login](screenshots/login-page.png) **Login** | ![Register](screenshots/register-page.png) **Register** |
| ![Private chat](screenshots/private-chat.png) **Private chat** (live typing indicator, read ticks) | ![Group chat](screenshots/group-chat.png) **Group chat** with member list |
| ![Online status](screenshots/online-status.png) **Online status** | ![Mobile](screenshots/mobile-responsive.png) **Mobile layout** |
| ![Discover rooms](screenshots/discover-rooms.png) **Discover rooms** | ![Profile](screenshots/profile-page.png) **Profile** |
| ![Mobile chat](screenshots/mobile-chat.png) **Mobile chat** | ![Reconnecting](screenshots/reconnecting.png) **Connection lost banner** |

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules) |
| Backend | Node.js 18+, Express 5 |
| Database | MongoDB, Mongoose |
| Real time | Socket.IO |
| Auth & security | JWT, bcrypt, helmet (strict CSP), cors, express-rate-limit |
| Uploads | multer (avatars, verified by file signature) |
| Dev / test | nodemon, `node:test`, socket.io-client, Playwright, Postman |

## Project structure

```
chat-application/
├── config/            db.js (connection) and env.js (validated settings)
├── controllers/       auth, user, conversation, message request handlers
├── middleware/        auth (JWT), errors, rate limiters, upload, id validation
├── models/            User, Conversation, Message (Mongoose schemas + indexes)
├── routes/            auth, user, conversation, message routers
├── services/          chatService.js - business rules shared by REST and sockets
├── sockets/           socketHandler.js - Socket.IO auth, rooms, presence, events
├── utils/             validators, serializers (response allow-lists), token, errors
├── public/            index, login, register, chat, profile pages
│   ├── css/           style.css (design system), auth.css, chat.css, profile.css
│   ├── js/            api.js, socket.js, auth.js, chat.js, profile.js, utils.js
│   └── assets/
├── scripts/           seed.js, screenshots.js (E2E + screenshots), build-postman.js
├── tests/             API, Socket.IO and rate-limit tests
├── postman/           importable Postman collection
├── screenshots/
├── app.js             Express app (middleware, routes)
├── server.js          HTTP server + Socket.IO bootstrap
├── .env.example
└── package.json
```

## Installation

**Prerequisites:** Node.js 18+ and a running MongoDB.

```bash
git clone <your-repo-url> chat-application
cd chat-application
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Generate a JWT secret and paste it into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### MongoDB configuration

Default connection string: `mongodb://127.0.0.1:27017/chat_application`.

- **Local install:** start the service (`mongod`, or the "MongoDB Server" Windows service).
- **Docker:** `docker run -d -p 27017:27017 --name mongo mongo:7`
- **Atlas:** put your `mongodb+srv://...` string in `MONGO_URI`.

Collections and indexes are created automatically on first start.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/chat_application` | Database connection |
| `JWT_SECRET` | - | Token signing secret (32+ chars; **required** in production) |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `CLIENT_ORIGIN` | `http://localhost:3000` | Comma-separated allowed CORS origins |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Failed logins per window per IP |
| `REGISTER_RATE_LIMIT_MAX` | `20` | Registrations per window per IP |
| `API_RATE_LIMIT_MAX` | `600` | API requests per minute per IP |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window for auth endpoints |
| `PRESENCE_GRACE_MS` | `3000` | Delay before a dropped user is shown offline |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |

## Running

```bash
npm run dev      # development, auto-restarts with nodemon
npm start        # production
npm run seed     # optional demo data (password for every demo user: Demo@1234)
```

Open **http://localhost:3000**. To see real-time behaviour, log in as two different users in two browsers (or one normal and one private window). After `npm run seed` you can use `alex@example.com` and `priya@example.com`.

## REST API

All endpoints are JSON. Except register/login, send `Authorization: Bearer <token>`. Errors look like `{ "success": false, "message": "...", "errors": [{ "field", "message" }] }`.

| Method | Endpoint | Description | Success |
|---|---|---|---|
| POST | `/api/auth/register` | Create account `{username, email, password}` -> token + user | 201 |
| POST | `/api/auth/login` | `{email, password}` -> token + user | 200 |
| POST | `/api/auth/logout` | Revoke all tokens of the user, close their sockets | 200 |
| GET | `/api/auth/me` | Current user | 200 |
| GET | `/api/users?page=&limit=` | Other users (paginated) | 200 |
| GET | `/api/users/search?q=` | Case-insensitive username search | 200 |
| GET | `/api/users/:id` | Public profile | 200 |
| PUT | `/api/users/profile` | `username`, `bio`, `avatar` (multipart), `removeAvatar`, `currentPassword` + `newPassword` | 200 |
| POST | `/api/conversations` | Get or create private chat `{participantId}` | 201 / 200 |
| GET | `/api/conversations` | My conversations with last message + unread count | 200 |
| GET | `/api/conversations/:id` | One conversation (participants only) | 200 |
| POST | `/api/conversations/group` | `{groupName, participantIds, isPublic}` | 201 |
| GET | `/api/conversations/rooms/public?q=` | Discover public rooms | 200 |
| POST | `/api/conversations/:id/join` | Join a public room | 200 |
| POST | `/api/conversations/:id/leave` | Leave a room | 200 |
| POST | `/api/conversations/:id/members` | Admin adds `{userIds}` | 200 |
| POST | `/api/messages` | `{conversationId, content, clientId?}` | 201 |
| GET | `/api/messages/:conversationId?limit=&before=&after=` | History, oldest-first; `before` pages back, `after` catches up | 200 |
| PUT | `/api/messages/:id/read` | Mark as read | 200 |
| DELETE | `/api/messages/:id` | Delete own message (soft delete) | 200 |
| GET | `/api/health` | Liveness + DB state | 200 |

Status codes used: 400 validation, 401 unauthenticated, 403 not allowed, 404 not found, 409 conflict, 413 body too large, 429 rate limited.

## Socket.IO

The client connects with `io({ auth: { token } })`. The handshake is rejected unless the JWT is valid and not revoked. Each user joins `user:<id>` (all their tabs) and `conv:<id>` for every conversation they belong to.

**Client -> server** (every event supports an acknowledgement callback `{ ok, ...data }` or `{ ok:false, status, error }`)

| Event | Payload | Notes |
|---|---|---|
| `message:send` | `{conversationId, content, clientId}` | Saved to MongoDB **before** the ack and broadcast; duplicate `clientId` returns the original |
| `message:read` | `{conversationId}` | Marks everything read |
| `typing:start` / `typing:stop` | `{conversationId}` | |
| `room:join` / `room:leave` | `{conversationId}` | Public rooms |

**Server -> client:** `message:new`, `message:delivered`, `message:read`, `message:deleted`, `typing`, `presence:snapshot`, `presence:update`, `conversation:new`, `room:member_joined`, `room:member_left`, `room:members_added`, `user:updated`.

Message sending is rate limited per socket (20 per 10 s). Non-members can neither send to nor receive from a conversation.

## Database design

- **User** - `username`, `email`, `password` (bcrypt hash, never selected by default), `profilePicture`, `status`, `createdAt` (+ `bio`, `lastSeen`, `tokenVersion`). Unique indexes on email and lower-cased username.
- **Conversation** - `participants[]` (refs User), `conversationType` (`private`/`group`), `groupName`, `groupAdmin`, `createdAt` (+ `isPublic`, `lastMessage`, `updatedAt`). A unique sparse `participantsKey` index guarantees two users can never have duplicate private chats, even under concurrent requests.
- **Message** - `sender`, `conversation`, `content`, `messageType`, `createdAt`, `readBy[]` (+ `deliveredTo[]`, soft-delete flags, `clientId`/`clientKey` for idempotent retries). Indexed on `{conversation, _id}` for fast history pagination.

## Security

bcrypt password hashing; JWT with server-side revocation (logout / password change); explicit response allow-lists (secrets cannot leak); validation of every input including type checks that block NoSQL operator injection; regex-escaped search; authorization on every conversation/message operation; strict Content-Security-Policy (no inline scripts or styles) and the UI renders all user content with `textContent`; CORS allow-list; login brute-force limiter, registration limiter, global API limiter; uploads verified by magic bytes, size-capped, stored under random names; generic error messages in production.

## Testing

```bash
npm test               # 71 automated tests (REST, Socket.IO, rate limiting) on an isolated database
npm run seed && npm run dev      # then, in another terminal:
npm run screenshots              # 30 browser end-to-end checks + regenerates screenshots/
```

`npm test` uses the database `chat_application_test` (dropped on each run) - it never touches your real data.

### Postman

1. Import `postman/chat-application.postman_collection.json`.
2. Start the server (`npm run dev`).
3. Run the collection (Collection Runner, or `npx newman run postman/chat-application.postman_collection.json`). Folders run in order: Authentication -> Users -> Conversations -> Messages -> Logout. Tests store the tokens and ids in collection variables automatically; the `baseUrl` variable defaults to `http://localhost:3000`.

Manual example:

```bash
curl -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d '{"username":"demo_user","email":"demo@example.com","password":"Passw0rd!x"}'
```

## Future improvements

Image/file messages, message editing and reactions, read-receipt lists per member in groups, push/browser notifications, full-text message search, end-to-end encryption, Redis adapter for scaling Socket.IO across several servers, refresh-token rotation, email verification and password reset, dark mode.

## License

MIT
