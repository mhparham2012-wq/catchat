// ==========================================================================
// script.js -- منطق فرانت‌اند CatChat (توی مرورگر کاربر اجرا میشه)
// ==========================================================================
// این فایل با API سرور (فایل server.js) صحبت می‌کنه: ثبت‌نام/ورود، گرفتن
// لیست پیام‌ها هر چند ثانیه، فرستادن پیام جدید، ریپلای و حذف پیام.
// ==========================================================================

// باید با مقدار MESSAGE_COOLDOWN_MS توی server.js یکی باشه (فقط برای
// نمایش شمارش معکوس روی دکمه‌ی ارسال استفاده میشه؛ چک واقعی سمت سرور انجام میشه)
const MESSAGE_COOLDOWN_MS = 3000;
const POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------
// وضعیت کلی برنامه (State)
// ---------------------------------------------------------------------
let token = localStorage.getItem('catchat_token');
let currentUsername = localStorage.getItem('catchat_username') || '';
let isAdmin = localStorage.getItem('catchat_isAdmin') === 'true';
let replyingTo = null;      // { id, username, content } | null
let messagesMap = {};       // { [id]: {username, content} } -- برای پیدا کردن سریع پیام هنگام ریپلای
let pollTimer = null;
let isFirstRender = true;

// ---------------------------------------------------------------------
// رفرنس‌های عناصر HTML
// ---------------------------------------------------------------------
const authSection   = document.getElementById('auth-section');
const chatSection   = document.getElementById('chat-section');
const userBar       = document.getElementById('user-bar');
const usernameDisplay = document.getElementById('username-display');

const tabLogin    = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const loginForm    = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError    = document.getElementById('login-error');
const registerError = document.getElementById('register-error');

const messagesEl  = document.getElementById('messages');
const emptyState  = document.getElementById('empty-state');
const chatError   = document.getElementById('chat-error');

const replyPreview        = document.getElementById('reply-preview');
const replyPreviewUsername = document.getElementById('reply-preview-username');
const replyPreviewContent  = document.getElementById('reply-preview-content');
const cancelReplyBtn       = document.getElementById('cancel-reply');

const messageForm  = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn      = document.getElementById('send-btn');
const logoutBtn    = document.getElementById('logout-btn');

// ---------------------------------------------------------------------
// توابع کمکی
// ---------------------------------------------------------------------

// جلوگیری از حملات XSS: هر متنی که از کاربر میاد قبل از قرار گرفتن توی
// innerHTML باید از این تابع رد بشه تا کاراکترهای خطرناک HTML بی‌اثر بشن.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function formatTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function isNearBottom() {
  const threshold = 120;
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function authHeaders() {
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// ---------------------------------------------------------------------
// نمایش/پنهان کردن بخش‌ها
// ---------------------------------------------------------------------
function showAuthUI() {
  authSection.classList.remove('hidden');
  chatSection.classList.add('hidden');
  userBar.classList.add('hidden');
}

function showChatUI() {
  authSection.classList.add('hidden');
  chatSection.classList.remove('hidden');
  userBar.classList.remove('hidden');
  usernameDisplay.textContent = (isAdmin ? '👑 ' : '') + currentUsername;

  isFirstRender = true;
  fetchMessages();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchMessages, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------
// احراز هویت: ثبت‌نام / ورود / خروج
// ---------------------------------------------------------------------
function saveSession(data) {
  token = data.token;
  currentUsername = data.username;
  isAdmin = Boolean(data.isAdmin);
  localStorage.setItem('catchat_token', token);
  localStorage.setItem('catchat_username', currentUsername);
  localStorage.setItem('catchat_isAdmin', String(isAdmin));
  showChatUI();
}

function clearSession() {
  token = null;
  currentUsername = '';
  isAdmin = false;
  localStorage.removeItem('catchat_token');
  localStorage.removeItem('catchat_username');
  localStorage.removeItem('catchat_isAdmin');
  if (pollTimer) clearInterval(pollTimer);
  showAuthUI();
}

async function apiPost(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // اگه اصلاً نتونیم به سرور وصل بشیم (مثلاً سرور روشن نیست) به‌جای اینکه
    // بی‌سروصدا هیچ اتفاقی نیفته، یه پیام خطای واضح برمی‌گردونیم
    console.error('apiPost network error:', err);
    return {
      ok: false,
      status: 0,
      data: { error: 'اتصال به سرور برقرار نشد. مطمئن شو سرور روشنه و آدرس درستی رو باز کردی.' },
    };
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  const { ok, data } = await apiPost('/api/login', { username, password });
  if (!ok) {
    loginError.textContent = data.error || 'ورود انجام نشد.';
    return;
  }
  saveSession(data);
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;

  const { ok, data } = await apiPost('/api/register', { username, password });
  if (!ok) {
    registerError.textContent = data.error || 'ثبت‌نام انجام نشد.';
    return;
  }
  saveSession(data);
});

logoutBtn.addEventListener('click', clearSession);

// جابه‌جایی بین تب ورود و ثبت‌نام
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  loginForm.classList.remove('hidden');
  registerForm.classList.add('hidden');
});
tabRegister.addEventListener('click', () => {
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  registerForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
});

// ---------------------------------------------------------------------
// گرفتن و نمایش پیام‌ها
// ---------------------------------------------------------------------
async function fetchMessages() {
  try {
    const res = await fetch('/api/messages', { headers: authHeaders() });
    if (res.status === 401) {
      clearSession();
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    renderMessages(data.messages || []);
  } catch (err) {
    // خطای شبکه‌ی موقت -- نیازی به نمایش پیام خطا به کاربر نیست، پول بعدی دوباره تلاش می‌کنه
    console.error('fetchMessages error:', err);
  }
}

function renderMessages(messages) {
  const wasNearBottom = isFirstRender || isNearBottom();

  messagesMap = {};
  messages.forEach((m) => { messagesMap[m.id] = { username: m.username, content: m.content }; });

  emptyState.classList.toggle('hidden', messages.length > 0);
  messagesEl.querySelectorAll('.message-row').forEach((el) => el.remove());

  const fragment = document.createDocumentFragment();
  messages.forEach((m) => fragment.appendChild(buildMessageRow(m)));
  messagesEl.appendChild(fragment);

  if (wasNearBottom) scrollToBottom();
  isFirstRender = false;
}

function buildMessageRow(m) {
  const isOwn = m.username === currentUsername;
  const canDelete = isOwn || isAdmin;

  const row = document.createElement('div');
  row.className = 'message-row ' + (isOwn ? 'own' : 'other');

  const bubble = document.createElement('div');
  bubble.className = 'message';

  let quoteHtml = '';
  if (m.reply_to_id) {
    const author = m.reply_username ? escapeHtml(m.reply_username) : 'کاربر حذف‌شده';
    const preview = m.reply_content
      ? escapeHtml(m.reply_content).slice(0, 70)
      : 'این پیام حذف شده';
    quoteHtml = `<span class="message-quote"><strong>${author}</strong>: ${preview}</span>`;
  }

  const headerHtml = isOwn
    ? `<div class="message-header"><span class="message-time">${formatTime(m.created_at)}</span></div>`
    : `<div class="message-header"><span class="message-author">${escapeHtml(m.username)}</span><span class="message-time">${formatTime(m.created_at)}</span></div>`;

  bubble.innerHTML = `
    ${quoteHtml}
    ${headerHtml}
    <div class="message-content"></div>
    <div class="message-actions">
      <button type="button" class="reply-btn" data-id="${m.id}">پاسخ</button>
      ${canDelete ? `<button type="button" class="delete-btn" data-id="${m.id}">حذف</button>` : ''}
    </div>
  `;
  // متن پیام رو جدا و با textContent می‌ذاریم (نه innerHTML) که صد در صد امن باشه
  bubble.querySelector('.message-content').textContent = m.content;

  row.appendChild(bubble);
  return row;
}

// دلیگیشن کلیک روی دکمه‌های «پاسخ» و «حذف» -- چون پیام‌ها هر بار از نو
// رندر میشن، به جای بستن Listener روی هر دکمه، یک بار روی کانتینر می‌بندیم
messagesEl.addEventListener('click', async (e) => {
  const replyBtn = e.target.closest('.reply-btn');
  const deleteBtn = e.target.closest('.delete-btn');

  if (replyBtn) {
    const msg = messagesMap[replyBtn.dataset.id];
    if (msg) startReply(replyBtn.dataset.id, msg.username, msg.content);
  }

  if (deleteBtn) {
    const confirmed = confirm('مطمئنی می‌خوای این پیام رو حذف کنی؟');
    if (!confirmed) return;
    await deleteMessage(deleteBtn.dataset.id);
  }
});

// ---------------------------------------------------------------------
// ریپلای
// ---------------------------------------------------------------------
function startReply(id, username, content) {
  replyingTo = { id, username, content };
  replyPreviewUsername.textContent = username;
  replyPreviewContent.textContent = content.slice(0, 60);
  replyPreview.classList.remove('hidden');
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyPreview.classList.add('hidden');
}
cancelReplyBtn.addEventListener('click', cancelReply);

// ---------------------------------------------------------------------
// ارسال پیام
// ---------------------------------------------------------------------
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content) return;

  chatError.textContent = '';
  sendBtn.disabled = true;

  const { ok, data } = await apiPost('/api/messages', {
    content,
    replyToId: replyingTo ? replyingTo.id : null,
  });

  if (!ok) {
    chatError.textContent = data.error || 'پیام ارسال نشد.';
    sendBtn.disabled = false;
    return;
  }

  messageInput.value = '';
  autoResizeTextarea();
  cancelReply();
  await fetchMessages();
  startSendCooldown();
});

function startSendCooldown() {
  let remainingMs = MESSAGE_COOLDOWN_MS;
  sendBtn.disabled = true;
  const step = 250;
  const timer = setInterval(() => {
    remainingMs -= step;
    if (remainingMs <= 0) {
      clearInterval(timer);
      sendBtn.disabled = false;
    }
  }, step);
}

async function deleteMessage(id) {
  try {
    const res = await fetch('/api/messages/' + id, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      chatError.textContent = data.error || 'حذف پیام انجام نشد.';
      return;
    }
    await fetchMessages();
  } catch (err) {
    console.error('deleteMessage network error:', err);
    chatError.textContent = 'اتصال به سرور برقرار نشد.';
  }
}

// بزرگ شدن خودکار جعبه‌ی متن هر چقدر کاربر بیشتر می‌نویسه
function autoResizeTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}
messageInput.addEventListener('input', autoResizeTextarea);

// اینتر بفرسته، شیفت+اینتر خط جدید بزنه
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    messageForm.requestSubmit();
  }
});

// ---------------------------------------------------------------------
// شروع برنامه
// ---------------------------------------------------------------------
if (token && currentUsername) {
  showChatUI();
} else {
  showAuthUI();
}
