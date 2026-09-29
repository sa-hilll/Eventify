try {
  require('dns').setServers(['8.8.8.8', '8.8.4.4']); // router blocks SRV lookups; use Google DNS
} catch (e) {
  // DNS override not supported in some serverless environments
}

const path = require('path');
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let dbConnection = null;
async function connectDB() {
  if (dbConnection && mongoose.connection.readyState === 1) return dbConnection;
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/college_events';
  const opts = process.env.MONGO_URI ? { tls: true, tlsInsecure: true } : {};
  dbConnection = await mongoose.connect(uri, opts);
  return dbConnection;
}

app.use(async (req, res, next) => {
  if (req.path.startsWith('/api')) {
    try {
      await connectDB();
    } catch (err) {
      return res.status(500).json({ error: 'Database connection failed: ' + err.message });
    }
  }
  next();
});

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_CODE = (process.env.ADMIN_CODE || 'ADMIN123').trim(); // needed to sign up as admin
const ObjectId = mongoose.Schema.Types.ObjectId;

const User = mongoose.model('User', new mongoose.Schema({
  name: String, email: { type: String, unique: true, lowercase: true }, password: String,
  role: { type: String, enum: ['admin', 'student'] }
}));
const Event = mongoose.model('Event', new mongoose.Schema({
  name: String, date: String, time: String, seats: Number, description: String,
  tags: [String], banner: String,
  registrations: [{ type: ObjectId, ref: 'User' }],
  interested: [{ type: ObjectId, ref: 'User' }]
}, { timestamps: true }));

const wrap = f => (q, s) => f(q, s).catch(e => s.status(500).json({ error: e.message }));
const fail = (s, c, m) => s.status(c).json({ error: m });
const auth = role => (q, s, n) => {
  try { q.user = jwt.verify((q.headers.authorization || '').slice(7), SECRET); }
  catch { return fail(s, 401, 'Please log in again'); }
  if (role && q.user.role !== role) return fail(s, 403, 'Not allowed');
  n();
};
const session = u => ({
  token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' }),
  user: { name: u.name, role: u.role }
});
const has = (arr, id) => arr.some(r => String(r._id || r) === id);
const view = (e, uid, admin) => {
  const o = {
    id: e.id, name: e.name, date: e.date, time: e.time, seats: e.seats, description: e.description,
    tags: e.tags, banner: e.banner, taken: e.registrations.length, left: e.seats - e.registrations.length,
    hype: e.interested.length, registered: has(e.registrations, uid), interested: has(e.interested, uid)
  };
  if (admin) o.attendees = e.registrations.map(u => ({ name: u.name, email: u.email }));
  return o;
};

app.post('/api/register', wrap(async (q, s) => {
  const { fullname, email, password, role, adminCode } = q.body;
  if (!fullname?.trim() || !email?.trim() || (password || '').length < 6) return fail(s, 400, 'Enter your name, email and a password of 6+ characters');
  if (!['admin', 'student'].includes(role)) return fail(s, 400, 'Choose a role');
  if (role === 'admin' && (adminCode || '').trim() !== ADMIN_CODE) return fail(s, 403, 'Invalid admin code — check your terminal for the code');
  if (await User.findOne({ email: email.toLowerCase() })) return fail(s, 409, 'This email is already registered');
  s.json(session(await User.create({ name: fullname.trim(), email, role, password: await bcrypt.hash(password, 10) })));
}));

app.post('/api/login', wrap(async (q, s) => {
  const { email, password, role } = q.body;
  const u = await User.findOne({ email: (email || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(password || '', u.password))) return fail(s, 401, 'Wrong email or password');
  if (u.role !== role) return fail(s, 403, `This account is a ${u.role} account. Switch the role above.`);
  s.json(session(u));
}));

app.get('/api/events', auth(), wrap(async (q, s) => {
  const admin = q.user.role === 'admin';
  let list = await (admin ? Event.find().populate('registrations', 'name email') : Event.find());
  const today = new Date().toLocaleDateString('en-CA');
  if (!admin) list = list.filter(e => e.date >= today);
  s.json(list.map(e => view(e, q.user.id, admin))
    .sort((a, b) => b.hype - a.hype || (a.date + a.time).localeCompare(b.date + b.time)));
}));

app.post('/api/events', auth('admin'), wrap(async (q, s) => {
  const { name, date, time, seats, description, tags, banner } = q.body, n = parseInt(seats);
  if (!name?.trim() || !date || !time || !(n > 0)) return fail(s, 400, 'Name, date, time and seats (at least 1) are required');
  const e = await Event.create({
    name: name.trim(), date, time, seats: n, description, banner,
    tags: (tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 6)
  });
  s.json(view(e, q.user.id, true));
}));

app.delete('/api/events/:id', auth('admin'), wrap(async (q, s) => {
  await Event.findByIdAndDelete(q.params.id); s.json({ ok: true });
}));

// Atomic: only pushes if the student isn't in the list AND seats remain
app.post('/api/events/:id/register', auth('student'), wrap(async (q, s) => {
  const e = await Event.findOneAndUpdate(
    { _id: q.params.id, registrations: { $ne: q.user.id }, $expr: { $lt: [{ $size: '$registrations' }, '$seats'] } },
    { $push: { registrations: q.user.id } }, { new: true });
  if (e) return s.json(view(e, q.user.id));
  const ex = await Event.findById(q.params.id);
  if (!ex) return fail(s, 404, 'Event not found');
  fail(s, 409, has(ex.registrations, q.user.id) ? 'You are already registered for this event' : 'This event is full');
}));

app.post('/api/events/:id/interest', auth('student'), wrap(async (q, s) => {
  const e = await Event.findById(q.params.id);
  if (!e) return fail(s, 404, 'Event not found');
  await Event.updateOne({ _id: e.id }, has(e.interested, q.user.id)
    ? { $pull: { interested: q.user.id } } : { $addToSet: { interested: q.user.id } });
  s.json({ ok: true });
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  connectDB()
    .then(() => app.listen(PORT, () => {
      console.log(`Running on http://localhost:${PORT}`);
      console.log('Admin code:', ADMIN_CODE);
    }))
    .catch(e => console.error('MongoDB connection failed:', e.message));
}

module.exports = app;
