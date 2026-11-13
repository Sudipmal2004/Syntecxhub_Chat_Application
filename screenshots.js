/* End-to-end browser test + screenshot capture.
 *
 * Drives the REAL running application in headless Chromium with several independent browser
 * sessions (so real-time delivery, typing indicators and presence are exercised for real) and
 * saves screenshots to ./screenshots. Every screenshot is a capture of the live UI.
 *
 * Usage:
 *   npm run seed               # demo data (once)
 *   npm run dev                # in another terminal
 *   npm run screenshots        # BASE_URL defaults to http://localhost:3000
 */

const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('playwright-core'));
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
const PASSWORD = 'Demo@1234';
const DESKTOP = { width: 1440, height: 900 };

const results = [];
const browserProblems = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? ` - ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, err.message.split('\n')[0]);
  }
}

function watch(page, label) {
  page.on('pageerror', (err) => browserProblems.push(`[${label}] page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The deliberate wrong-password step makes the browser log the API's 401; that one is expected.
    if (label === 'anon' && /status of 401/.test(msg.text())) return;
    browserProblems.push(`[${label}] console error: ${msg.text()}`);
  });
}

async function newSession(browser, label, options = {}) {
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  watch(page, label);
  return { context, page };
}

async function login(page, email, password = PASSWORD) {
  await page.goto(`${BASE}/login.html`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await Promise.all([page.waitForURL('**/chat.html'), page.click('#submitBtn')]);
  await page.waitForSelector('#listBody .conv, #listBody .empty', { timeout: 10000 });
}

const shot = (page, name, options = {}) => page.screenshot({ path: path.join(OUT, name), ...options });
// Match on the row's NAME element so a name quoted in another row's message preview cannot match.
const conv = (page, name) => page.locator('.conv').filter({ has: page.locator('.conv__name', { hasText: new RegExp(`^${name}$`) }) });
const bubbleTexts = (page) => page.locator('#messages .bubble__text');
const waitForBubble = (page, text, timeout = 8000) => page.locator('#messages .bubble__text', { hasText: text }).first().waitFor({ timeout });

async function sendMessage(page, text) {
  await page.fill('#messageInput', text);
  await page.press('#messageInput', 'Enter');
}

async function main() {
  const browser = await chromium.launch();
  const stamp = Date.now().toString(36);

  try {
    /* ------------------------------------------------ public pages */
    const anon = await newSession(browser, 'anon');

    await step('Login page renders', async () => {
      await anon.page.goto(`${BASE}/login.html`);
      await anon.page.waitForSelector('#loginForm');
      await shot(anon.page, 'login-page.png');
    });

    await step('Login rejects wrong credentials with an error message', async () => {
      await anon.page.fill('#email', 'alex@example.com');
      await anon.page.fill('#password', 'WrongPassword1');
      await anon.page.click('#submitBtn');
      await anon.page.locator('#formAlert', { hasText: /invalid email or password/i }).waitFor({ timeout: 6000 });
    });

    await step('Login form validates empty/invalid input client-side', async () => {
      await anon.page.fill('#email', 'not-an-email');
      await anon.page.fill('#password', '');
      await anon.page.click('#submitBtn');
      await anon.page.locator('#emailError').waitFor({ state: 'visible', timeout: 3000 });
    });

    await step('Registration page renders', async () => {
      await anon.page.goto(`${BASE}/register.html`);
      await anon.page.waitForSelector('#registerForm');
      await shot(anon.page, 'register-page.png');
    });

    await step('Registration validates weak passwords and mismatches', async () => {
      await anon.page.fill('#username', `tester_${stamp}`);
      await anon.page.fill('#email', `tester_${stamp}@example.com`);
      await anon.page.fill('#password', 'short');
      await anon.page.fill('#confirmPassword', 'different');
      await anon.page.click('#submitBtn');
      await anon.page.locator('#passwordError').waitFor({ state: 'visible', timeout: 3000 });
      await anon.page.locator('#confirmPasswordError').waitFor({ state: 'visible', timeout: 3000 });
    });

    await step('New user can register through the UI and lands on an empty dashboard', async () => {
      await anon.page.fill('#password', 'Tester#2026');
      await anon.page.fill('#confirmPassword', 'Tester#2026');
      await Promise.all([anon.page.waitForURL('**/chat.html'), anon.page.click('#submitBtn')]);
      await anon.page.locator('#listBody .empty', { hasText: 'No conversations yet' }).waitFor({ timeout: 8000 });
    });

    await step('Registered user can find another user by search and start a chat', async () => {
      await anon.page.fill('#userSearch', 'priya');
      await anon.page.locator('.person', { hasText: 'priya_sharma' }).click();
      await anon.page.locator('#chatTitle', { hasText: 'priya_sharma' }).waitFor({ timeout: 6000 });
      await anon.page.locator('.chat-empty-state', { hasText: 'Start your conversation' }).waitFor({ timeout: 6000 });
    });

    await step('Logout ends the session and returns to the login page', async () => {
      await Promise.all([anon.page.waitForURL('**/login.html?loggedout=1'), anon.page.click('#logoutBtn')]);
      await anon.page.locator('#formAlert', { hasText: /logged out/i }).waitFor({ timeout: 4000 });
      await anon.page.goto(`${BASE}/chat.html`);
      await anon.page.waitForURL('**/login.html**', { timeout: 6000 });
    });
    await anon.context.close();

    /* ------------------------------------------ two live sessions */
    const priya = await newSession(browser, 'priya');
    const alex = await newSession(browser, 'alex');

    await step('Priya logs in (becomes online)', () => login(priya.page, 'priya@example.com'));
    await step('Alex logs in and sees seeded conversations with an unread badge', async () => {
      await login(alex.page, 'alex@example.com');
      await conv(alex.page, 'ananya_iyer').locator('.badge').waitFor({ timeout: 8000 });
      await conv(alex.page, 'Project Phoenix').waitFor();
    });

    await step('Online indicator: Priya shows online in Alex\'s conversation list', async () => {
      await conv(alex.page, 'priya_sharma').locator('.avatar__status.is-online').waitFor({ timeout: 8000 });
      await alex.page.waitForTimeout(600);
      await shot(alex.page, 'dashboard.png');
    });

    /* ---------------------------------------------- private chat */
    await step('Opening a private chat loads stored history from MongoDB', async () => {
      await conv(alex.page, 'priya_sharma').click();
      await waitForBubble(alex.page, 'design review this afternoon');
      await alex.page.locator('.day', { hasText: 'Yesterday' }).waitFor({ timeout: 3000 });
      await alex.page.locator('#chatSubtitle.is-online').waitFor({ timeout: 6000 });
    });

    const liveText = 'Sounds good - I will bring the updated mockups.';
    await step('Alex sends a message: it is delivered to Priya in real time (unread badge, no reload)', async () => {
      await sendMessage(alex.page, liveText);
      await waitForBubble(alex.page, liveText);
      await conv(priya.page, 'alex_morgan').locator('.badge').waitFor({ timeout: 8000 });
    });

    await step('Priya opens the chat and sees the message; Alex\'s message turns to "read" ticks', async () => {
      await conv(priya.page, 'alex_morgan').click();
      await waitForBubble(priya.page, liveText);
      await alex.page.locator('.msg--mine .ticks.is-read').last().waitFor({ timeout: 8000 });
    });

    const replyDraft = 'Perfect, I just finished the dark-mode variant too';
    await step('Typing indicator: Alex sees Priya typing live', async () => {
      await priya.page.click('#messageInput');
      await priya.page.keyboard.type(replyDraft, { delay: 12 });
      await alex.page.locator('#chatSubtitle.is-typing').waitFor({ timeout: 6000 });
      await alex.page.locator('#typingRow').waitFor({ timeout: 3000 });
      await alex.page.waitForTimeout(250);
      await shot(alex.page, 'private-chat.png');
    });

    await step('Priya sends the reply and Alex receives it instantly', async () => {
      await priya.page.press('#messageInput', 'Enter');
      await waitForBubble(alex.page, replyDraft);
      await alex.page.locator('#typingRow').waitFor({ state: 'detached', timeout: 4000 });
    });

    await step('Messages with HTML are shown as text (XSS-safe)', async () => {
      await sendMessage(alex.page, '<img src=x onerror="window.__xss=1"> <b>bold?</b>');
      await waitForBubble(priya.page, '<img src=x');
      const hacked = await priya.page.evaluate(() => window.__xss === 1);
      if (hacked) throw new Error('script executed');
    });

    await step('Alex can delete his own message; Priya sees it disappear', async () => {
      const mine = alex.page.locator('.msg--mine', { hasText: '<img src=x' });
      await mine.hover();
      await mine.locator('.msg__delete').click();
      await alex.page.locator('.modal .btn--danger').click();
      await priya.page.locator('.msg.is-deleted').first().waitFor({ timeout: 6000 });
    });

    /* --------------------------------------- presence + info panel */
    await step('Details panel shows the contact as online', async () => {
      await alex.page.click('#infoBtn');
      await alex.page.locator('.info__status.is-online').waitFor({ timeout: 4000 });
      await alex.page.waitForTimeout(500);
      await shot(alex.page, 'online-status.png');
      await alex.page.click('#infoBtn');
    });

    /* ------------------------------------------------- group chat */
    await step('Group chat: history loads and a system message is shown', async () => {
      await conv(alex.page, 'Project Phoenix').click();
      await waitForBubble(alex.page, 'Release candidate goes out tomorrow');
      await alex.page.locator('.sys', { hasText: 'created the room' }).waitFor({ timeout: 3000 });
      await alex.page.locator('#chatSubtitle', { hasText: 'members' }).waitFor();
    });

    const groupText = 'Release notes are ready for review - please add comments by 5 PM.';
    await step('Group message reaches another member live', async () => {
      await conv(priya.page, 'Project Phoenix').click();
      await waitForBubble(priya.page, 'Pizza on me');
      await sendMessage(alex.page, groupText);
      await waitForBubble(priya.page, groupText);
    });

    await step('Group reply and typing indicator are shown to Alex', async () => {
      await priya.page.click('#messageInput');
      await priya.page.keyboard.type('On it, reading them now', { delay: 12 });
      await alex.page.locator('#chatSubtitle.is-typing').waitFor({ timeout: 6000 });
      await priya.page.press('#messageInput', 'Enter');
      await waitForBubble(alex.page, 'On it, reading them now');
      await alex.page.click('#infoBtn');
      await alex.page.locator('.info .member', { hasText: 'priya_sharma' }).waitFor({ timeout: 4000 });
      await alex.page.waitForTimeout(500);
      await shot(alex.page, 'group-chat.png');
      await alex.page.click('#infoBtn');
    });

    /* ----------------------------------- rooms: create + discover */
    await step('Discover rooms: join a public room and land in it', async () => {
      await alex.page.click('#tabRooms');
      await alex.page.locator('.room', { hasText: 'Weekend Hikers' }).waitFor({ timeout: 6000 });
      await shot(alex.page, 'discover-rooms.png');
      await alex.page.locator('.room', { hasText: 'Weekend Hikers' }).getByRole('button', { name: /join/i }).click();
      await alex.page.locator('#chatTitle', { hasText: 'Weekend Hikers' }).waitFor({ timeout: 6000 });
      await alex.page.locator('.sys', { hasText: 'joined the room' }).waitFor({ timeout: 6000 });
    });

    await step('Create a new room through the dialog', async () => {
      await alex.page.click('#newRoomBtn');
      await alex.page.fill('#roomName', `Study Circle ${stamp}`);
      await alex.page.fill('#pickerSearch', 'rahul');
      await alex.page.locator('.picker__row', { hasText: 'rahul_verma' }).click();
      await alex.page.locator('.modal .btn--primary').click();
      await alex.page.locator('#chatTitle', { hasText: 'Study Circle' }).waitFor({ timeout: 6000 });
    });

    await step('Leaving a room removes it from the list', async () => {
      await alex.page.click('#infoBtn');
      await alex.page.locator('.info .btn--danger-soft').click();
      await alex.page.locator('.modal .btn--danger').click();
      await alex.page.locator('.conv', { hasText: 'Study Circle' }).waitFor({ state: 'detached', timeout: 6000 });
    });

    /* ----------------------------------------------------- profile */
    await step('Profile page loads and saves changes', async () => {
      await alex.page.goto(`${BASE}/profile.html`);
      await alex.page.waitForFunction(() => document.querySelector('#username').value === 'alex_morgan', null, { timeout: 6000 });
      await alex.page.fill('#bio', 'Product designer. Coffee first, Figma second.');
      await alex.page.click('#saveBtn');
      await alex.page.locator('.toast', { hasText: 'Profile updated' }).waitFor({ timeout: 6000 });
      await shot(alex.page, 'profile-page.png');
    });

    /* ----------------------------------------------- mobile layout */
    const mobile = await newSession(browser, 'mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await step('Mobile layout: conversation list with bottom navigation', async () => {
      await login(mobile.page, 'alex@example.com');
      await conv(mobile.page, 'priya_sharma').waitFor();
      await mobile.page.waitForTimeout(500);
      await shot(mobile.page, 'mobile-responsive.png');
      const noHScroll = await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      if (!noHScroll) throw new Error('horizontal scroll on mobile');
    });
    await step('Mobile layout: opening a chat shows the chat view with a back button', async () => {
      await conv(mobile.page, 'priya_sharma').tap();
      await mobile.page.locator('#backBtn').waitFor({ state: 'visible', timeout: 4000 });
      await waitForBubble(mobile.page, 'updated mockups');
      await shot(mobile.page, 'mobile-chat.png');
      await mobile.page.locator('#backBtn').tap();
      await mobile.page.locator('#sidebar').waitFor({ state: 'visible', timeout: 4000 });
    });

    /* ------------------------------- offline status + reconnection */
    await step('Offline status: Priya closes her browser and Alex sees her go offline', async () => {
      await alex.page.goto(`${BASE}/chat.html`); // Alex was on the profile page
      await conv(alex.page, 'priya_sharma').locator('.avatar__status.is-online').waitFor({ timeout: 8000 });
      await conv(alex.page, 'priya_sharma').click();
      await priya.context.close();
      await alex.page.waitForFunction(() => /Last seen/.test(document.querySelector('#chatSubtitle').textContent), null, { timeout: 12000 });
    });

    await step('Reconnection: a dropped connection is detected, retried, and missed messages are restored', async () => {
      await conv(alex.page, 'Project Phoenix').click();
      await alex.page.locator('#chatTitle', { hasText: 'Project Phoenix' }).waitFor();
      // Drop the live connection exactly like a network failure would: close the transport, and slow the
      // retry down so another user can post while Alex is genuinely disconnected.
      await alex.page.evaluate(async () => {
        const { getSocket } = await import('/js/socket.js'); // the same module instance the app uses
        const manager = getSocket().io;
        manager.reconnectionDelay(5000);
        manager.reconnectionDelayMax(5000);
        manager.engine.close();
      });
      await alex.page.locator('#connectionBanner', { hasText: /reconnecting/i }).waitFor({ state: 'visible', timeout: 5000 });
      await shot(alex.page, 'reconnecting.png');

      const rahul = await newSession(browser, 'rahul');
      await login(rahul.page, 'rahul@example.com');
      await conv(rahul.page, 'Project Phoenix').click();
      await sendMessage(rahul.page, `Sent while you were offline (${stamp})`);
      await rahul.page.locator('.msg--mine .ticks').first().waitFor({ timeout: 6000 });
      const leaked = await alex.page.locator('#messages .bubble__text', { hasText: `Sent while you were offline (${stamp})` }).count();
      if (leaked) throw new Error('message arrived while disconnected - the drop was not simulated');

      await waitForBubble(alex.page, `Sent while you were offline (${stamp})`, 20000); // restored by the reconnect sync
      await alex.page.locator('#connectionBanner').waitFor({ state: 'hidden', timeout: 10000 });
      await rahul.context.close();
    });

    await mobile.context.close();
    await alex.context.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  const unique = [...new Set(browserProblems)];
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (unique.length) {
    console.log(`\nBrowser console/page errors (${unique.length}):`);
    unique.forEach((line) => console.log(`  ${line}`));
  } else {
    console.log('No browser console errors or CSP violations.');
  }
  process.exit(failed.length || unique.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
