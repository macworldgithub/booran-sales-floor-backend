const { createHash, randomBytes } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { verifyPassword, hashPassword } = require('./password');
const COOKIE = 'booran_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const dummyHash = hashPassword(randomBytes(32).toString('hex'));
const cookieOptions = () => ({ httpOnly: true, secure: Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
const publicUser = (user) => ({ id: user._id.toString(), email: user.email, name: user.name, role: user.role, site: user.site, allowedSites: user.role === 'super_admin' ? ['*'] : [user.site], avatar: user.role === 'super_admin' ? 'SA' : 'SM' });
const validUser = (user) => user && typeof user.email === 'string' && Boolean(user.email.trim()) && typeof user.name === 'string' && Boolean(user.name.trim()) && typeof user.site === 'string' &&
  ['super_admin', 'manager'].includes(user.role) && (user.role === 'super_admin' || Boolean(user.site.trim()));

function sessionToken(req) {
  const part = (req.headers.cookie || '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${COOKIE}=`));
  const token = part?.slice(COOKIE.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function installAuth(router, getDb) {
  router.post('/auth/login', async (req, res) => {
    try {
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!email || !password || password.length > 256) return res.status(400).json({ success: false, error: 'Enter your email and password.' });
      const db = await getDb();
      // Shared, durable throttling works across Vercel instances. Block per-account and per-IP.
      const window = Math.floor(Date.now() / (15 * 60 * 1000));
      const ip = req.ip || 'unknown';
      const keys = [digest(`email:${email}:${window}`), digest(`ip:${ip}:${window}`)];
      const attempts = await Promise.all(keys.map((_id) => db.collection('login_attempts').findOneAndUpdate(
        { _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + 30 * 60 * 1000) } }, { upsert: true, returnDocument: 'after' },
      )));
      if (attempts[0].count > 10 || attempts[1].count > 50) {
        res.set('Retry-After', '900');
        return res.status(429).json({ success: false, error: 'Too many sign-in attempts. Try again in 15 minutes.' });
      }
      const user = await db.collection('users').findOne({ email, active: true });
      const valid = await verifyPassword(password, user?.passwordHash || await dummyHash);
      if (!user || !valid) return res.status(401).json({ success: false, error: 'Incorrect email or password.' });
      if (!validUser(user)) return res.status(403).json({ success: false, error: 'Account access is not configured.' });
      const token = randomBytes(32).toString('hex');
      const previous = sessionToken(req);
      await db.collection('sessions').insertOne({ _id: digest(token), userId: user._id, expiresAt: new Date(Date.now() + SESSION_MS), createdAt: new Date() });
      if (previous) await db.collection('sessions').deleteOne({ _id: digest(previous) });
      res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MS });
      res.json({ success: true, data: { user: publicUser(user) } });
    } catch (error) {
      console.error('Sign-in failed:', error.message);
      res.status(503).json({ success: false, error: 'Sign-in is temporarily unavailable. Please retry.' });
    }
  });
  router.post('/auth/logout', async (req, res) => {
    try {
      const token = sessionToken(req);
      if (token) await (await getDb()).collection('sessions').deleteOne({ _id: digest(token) });
      res.clearCookie(COOKIE, cookieOptions());
      res.json({ success: true });
    } catch {
      res.status(503).json({ success: false, error: 'Sign-out could not be completed. Please retry.' });
    }
  });
  // Every route mounted after this middleware requires a verified, unexpired session.
  router.use(async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (!token) return res.status(401).json({ success: false, error: 'Please sign in to continue.' });
      const db = await getDb();
      const session = await db.collection('sessions').findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
      const user = session && ObjectId.isValid(session.userId) && await db.collection('users').findOne({ _id: new ObjectId(session.userId), active: true });
      if (!validUser(user)) {
        res.clearCookie(COOKIE, cookieOptions());
        return res.status(401).json({ success: false, error: 'Your session expired. Please sign in again.' });
      }
      req.user = publicUser(user);
      next();
    } catch (error) {
      console.error('Session verification failed:', error.message);
      res.status(503).json({ success: false, error: 'Unable to verify your session. Please retry.' });
    }
  });
  router.get('/auth/me', (req, res) => res.json({ success: true, data: req.user }));
}
module.exports = { installAuth, sessionToken };
