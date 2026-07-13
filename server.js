// ==========================================================================
// server.js -- مغز اصلی سایت CatChat
// ==========================================================================
// این فایل یک سرور Express هست که هم فایل‌های فرانت‌اند (پوشه‌ی public) رو
// به کاربر نشون میده و هم یه API برای ثبت‌نام، ورود، ارسال پیام، گرفتن
// لیست پیام‌ها و حذف پیام فراهم می‌کنه.
//
// دیتابیس یک پروژه‌ی Postgres روی Supabase هست (رایگان و همیشه‌ماندگار)؛
// یعنی هم موقع تست محلی روی سیستم خودت، هم بعد از پابلیش کردن، هر دو به
// همین یک دیتابیس آنلاین وصل میشن -- پس هیچ‌وقت اطلاعات از بین نمیره.
// ==========================================================================

require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const censoredWords = require('./censoredWords');

const app = express();

// ---------------------------------------------------------------------
// تنظیمات کلی -- این چند خط رو راحت می‌تونی تغییر بدی
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'catchat-dev-secret-CHANGE-ME';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();

const MESSAGE_COOLDOWN_MS = 3000;  // حداقل فاصله‌ی مجاز بین دو پیام (۳ ثانیه)
const MAX_MESSAGE_LENGTH = 500;    // حداکثر تعداد کاراکتر هر پیام
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 20;
const MIN_PASSWORD_LENGTH = 4;

if (!process.env.JWT_SECRET) {
  console.warn(
    '⚠️  هشدار: JWT_SECRET رو توی فایل .env تنظیم نکردی! برای تست محلی مشکلی نیست، ' +
    'ولی قبل از پابلیش کردن سایت حتماً یک مقدار تصادفی و امن براش بذار.'
  );
}
if (!process.env.DATABASE_URL) {
  console.error(
    '❌ خطا: DATABASE_URL توی فایل .env تنظیم نشده. آدرس اتصال پروژه‌ی Supabase‌ت رو ' +
    'از داشبورد بگیر و توی .env بذار (توضیح کامل توی README هست).'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------
// اتصال به دیتابیس Postgres (روی Supabase)
// ---------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // اتصال رمزنگاری‌شده -- برای یه پروژه‌ی کوچیک همین کافیه
  connectionTimeoutMillis: 10000, // اگه ظرف ۱۰ ثانیه وصل نشد، خطای واضح بده به‌جای دقیقه‌ها معطلی
  query_timeout: 15000,           // همین‌طور برای هر کوئری، سقف ۱۵ ثانیه
});

// اگه یه اتصالِ بیکارِ توی pool به مشکل بخوره (مثلاً یه قطعی شبکه‌ی موقت)،
// بدون این خط کل سرور کرش می‌کرد؛ این‌طوری فقط لاگ می‌کنه و کار ادامه پیدا می‌کنه
pool.on('error', (err) => {
  console.error('یه خطای غیرمنتظره روی اتصال دیتابیس:', err.message);
});

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content      TEXT NOT NULL,
      reply_to_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ---------------------------------------------------------------------
// میدلورها (Middleware)
// ---------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// آیا این یوزرنیم همون ادمین سایت (سازنده) هست؟
// عمداً جایی ذخیره نمیشه و هر بار بر اساس متغیر محیطی ADMIN_USERNAME
// محاسبه میشه؛ یعنی هر وقت بخوای می‌تونی این متغیر رو عوض کنی و همون
// لحظه یوزر جدید ادمین میشه (بدون دستکاری دیتابیس).
function isAdminUsername(username) {
  return Boolean(
    ADMIN_USERNAME && username &&
    username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
  );
}

// تابع سانسور کلمات بد؛ از فایل censoredWords.js لیست کلمات رو می‌خونه
function censorText(text) {
  let result = text;
  for (const rawWord of censoredWords) {
    const word = String(rawWord || '').trim();
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    result = result.replace(regex, (match) => '*'.repeat(match.length));
  }
  return result;
}

// تشخیص اینکه خطا به‌خاطر قطعی/کندیِ ارتباط با دیتابیسه یا نه (نه یه باگ
// توی کد)؛ برای این‌جور خطاها به‌جای پیام گنگ، یه پیام «دوباره امتحان کن»
// روشن نشون می‌دیم
function isDbConnectionError(err) {
  const connectionCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', '08006', '08001', '08004', '57P03'];
  return connectionCodes.includes(err.code) || /timeout/i.test(err.message || '');
}

// میدلور بررسی ورود -- روی روت‌هایی که نیاز به لاگین دارن استفاده میشه
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'ابتدا باید وارد حساب کاربری‌ات بشی.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'نشست شما منقضی شده، دوباره وارد شو.' });
  }

  try {
    // مطمئن می‌شیم این کاربر واقعاً هنوز توی دیتابیس فعلی وجود داره؛ اگه یه
    // توکنِ قدیمی (مال قبل از عوض شدن/ریست شدن دیتابیس) باشه، اینجا می‌گیریمش
    const result = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'حساب کاربری‌ات پیدا نشد؛ دوباره وارد شو یا ثبت‌نام کن.' });
    }
  } catch (err) {
    console.error('auth check db error:', err);
    return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
  }

  req.user = {
    id: decoded.id,
    username: decoded.username,
    isAdmin: isAdminUsername(decoded.username),
  };
  next();
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

// ---------------------------------------------------------------------
// روت ثبت‌نام -- POST /api/register  { username, password }
// ---------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'نام کاربری و رمز عبور رو وارد کن.' });
    }
    if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
      return res.status(400).json({
        error: `نام کاربری باید بین ${MIN_USERNAME_LENGTH} تا ${MAX_USERNAME_LENGTH} کاراکتر باشه.`,
      });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `رمز عبور باید حداقل ${MIN_PASSWORD_LENGTH} کاراکتر باشه.` });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده، یکی دیگه انتخاب کن.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const inserted = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash]
    );

    const user = { id: inserted.rows[0].id, username };
    const token = signToken(user);

    return res.json({ token, username: user.username, isAdmin: isAdminUsername(username) });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.error('register error (db connection):', err.message);
      return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
    }
    if (err.code === '23505') { // کد خطای استاندارد Postgres برای نقض محدودیت UNIQUE
      return res.status(409).json({ error: 'این نام کاربری قبلاً گرفته شده، یکی دیگه انتخاب کن.' });
    }
    console.error('register error:', err);
    return res.status(500).json({ error: 'یه خطای غیرمنتظره پیش اومد، دوباره امتحان کن.' });
  }
});

// ---------------------------------------------------------------------
// روت ورود -- POST /api/login  { username, password }
// ---------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'نام کاربری و رمز عبور رو وارد کن.' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباهه.' });
    }

    const token = signToken(user);
    return res.json({ token, username: user.username, isAdmin: isAdminUsername(user.username) });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.error('login error (db connection):', err.message);
      return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
    }
    console.error('login error:', err);
    return res.status(500).json({ error: 'یه خطای غیرمنتظره پیش اومد، دوباره امتحان کن.' });
  }
});

// ---------------------------------------------------------------------
// گرفتن لیست پیام‌ها -- GET /api/messages   (نیاز به لاگین داره)
// ---------------------------------------------------------------------
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id, m.content, m.created_at, m.reply_to_id,
        u.username           AS username,
        ru.username          AS reply_username,
        rm.content           AS reply_content
      FROM messages m
      JOIN users u          ON u.id = m.user_id
      LEFT JOIN messages rm ON rm.id = m.reply_to_id
      LEFT JOIN users ru    ON ru.id = rm.user_id
      ORDER BY m.id ASC
      LIMIT 300
    `);

    return res.json({
      messages: result.rows,
      currentUser: { username: req.user.username, isAdmin: req.user.isAdmin },
    });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.error('fetch messages error (db connection):', err.message);
      return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
    }
    console.error('fetch messages error:', err);
    return res.status(500).json({ error: 'مشکلی توی گرفتن پیام‌ها پیش اومد.' });
  }
});

// ---------------------------------------------------------------------
// ارسال پیام جدید -- POST /api/messages   { content, replyToId? }
// ---------------------------------------------------------------------
app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim();
    const replyToId = req.body?.replyToId || null;

    if (!content) {
      return res.status(400).json({ error: 'متن پیام نمی‌تونه خالی باشه.' });
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `پیام نباید بیشتر از ${MAX_MESSAGE_LENGTH} کاراکتر باشه.` });
    }

    // -- ضدِ اسپم، بخش اول: بررسی فاصله‌ی زمانی از آخرین پیامِ همین کاربر --
    const lastResult = await pool.query(
      'SELECT content, created_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [req.user.id]
    );
    const lastMessage = lastResult.rows[0];

    if (lastMessage) {
      const elapsed = Date.now() - new Date(lastMessage.created_at).getTime();
      if (elapsed < MESSAGE_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((MESSAGE_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({ error: `یکم صبر کن! تا ${waitSeconds} ثانیه‌ی دیگه می‌تونی پیام بعدی رو بفرستی.` });
      }
      // -- ضدِ اسپم، بخش دوم: پیام نباید عیناً مثل «فقط» آخرین پیام خودش باشه --
      if (lastMessage.content === content) {
        return res.status(400).json({ error: 'این پیام دقیقاً مثل پیام قبلی توئه؛ یه چیز دیگه بنویس.' });
      }
    }

    // اگه به پیامی ریپلای زده، بررسی می‌کنیم که واقعاً چنین پیامی وجود داره
    let validReplyToId = null;
    if (replyToId) {
      const replyToIdNum = Number(replyToId);
      if (Number.isInteger(replyToIdNum)) {
        const target = await pool.query('SELECT id FROM messages WHERE id = $1', [replyToIdNum]);
        if (target.rows.length > 0) validReplyToId = target.rows[0].id;
      }
    }

    const finalContent = censorText(content);

    const inserted = await pool.query(
      'INSERT INTO messages (user_id, content, reply_to_id) VALUES ($1, $2, $3) RETURNING id',
      [req.user.id, finalContent, validReplyToId]
    );

    return res.json({ id: inserted.rows[0].id });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.error('send message error (db connection):', err.message);
      return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
    }
    console.error('send message error:', err);
    return res.status(500).json({ error: 'مشکلی توی ارسال پیام پیش اومد.' });
  }
});

// ---------------------------------------------------------------------
// حذف پیام -- DELETE /api/messages/:id
// خود کاربر فقط پیام خودش رو می‌تونه حذف کنه؛ ادمین هر پیامی رو می‌تونه.
// ---------------------------------------------------------------------
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    const message = result.rows[0];

    if (!message) {
      return res.status(404).json({ error: 'پیام مورد نظر پیدا نشد (شاید قبلاً حذف شده).' });
    }

    const isOwner = message.user_id === req.user.id;
    if (!isOwner && !req.user.isAdmin) {
      return res.status(403).json({ error: 'تو فقط می‌تونی پیام‌های خودت رو حذف کنی.' });
    }

    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
    return res.json({ success: true });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.error('delete message error (db connection):', err.message);
      return res.status(503).json({ error: 'اتصال به دیتابیس موقتاً برقرار نشد؛ چند لحظه دیگه دوباره امتحان کن.' });
    }
    console.error('delete message error:', err);
    return res.status(500).json({ error: 'مشکلی توی حذف پیام پیش اومد.' });
  }
});

// ---------------------------------------------------------------------
// روشن کردن سرور -- اول جدول‌های دیتابیس رو (اگه از قبل نبودن) می‌سازیم،
// بعد به درخواست‌ها گوش می‌دیم
// ---------------------------------------------------------------------
setupDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🐱 CatChat روی http://localhost:${PORT} در حال اجراست`);
    });
  })
  .catch((err) => {
    console.error('❌ اتصال به دیتابیس Supabase ناموفق بود:', err.message);
    console.error('   مطمئن شو DATABASE_URL توی .env درست کپی شده و پروژه‌ی Supabase‌ت فعال/بیدار هست.');
    process.exit(1);
  });
