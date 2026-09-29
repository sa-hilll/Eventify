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
const ADMIN_CODE = (process.env.ADMIN_CODE || 'ADMIN123').trim();
const ObjectId = mongoose.Schema.Types.ObjectId;

const User = mongoose.model('User', new mongoose.Schema({
  name: String, email: { type: String, unique: true, lowercase: true }, password: String,
  role: { type: String, enum: ['admin', 'student'] }
}));

const Event = mongoose.model('Event', new mongoose.Schema({
  name: String, date: String, time: String, seats: Number, description: String,
  tags: [String], banner: String,
  registrations: [{
    user: { type: ObjectId, ref: 'User' },
    attendance: { type: String, enum: ['unmarked', 'attended', 'absent'], default: 'unmarked' },
    registeredAt: { type: Date, default: Date.now }
  }],
  waitlist: [{
    user: { type: ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now }
  }],
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

const getUserId = r => String(r?.user?._id || r?.user || r?._id || r);

const view = (e, uid, admin) => {
  const regs = e.registrations || [];
  const wait = e.waitlist || [];
  const ints = e.interested || [];
  
  const regItem = regs.find(r => getUserId(r) === uid);
  const isRegistered = Boolean(regItem);
  const waitIndex = wait.findIndex(w => getUserId(w) === uid);
  const isWaitlisted = waitIndex !== -1;
  const waitlistPos = isWaitlisted ? waitIndex + 1 : null;
  const isInterested = ints.some(r => String(r._id || r) === uid);

  const o = {
    id: e.id || e._id,
    name: e.name,
    date: e.date,
    time: e.time,
    seats: e.seats,
    description: e.description,
    tags: e.tags,
    banner: e.banner,
    taken: regs.length,
    left: Math.max(0, e.seats - regs.length),
    isFull: regs.length >= e.seats,
    waitlistCount: wait.length,
    hype: ints.length,
    registered: isRegistered,
    attendance: regItem ? (regItem.attendance || 'unmarked') : null,
    waitlisted: isWaitlisted,
    waitlistPosition: waitlistPos,
    interested: isInterested
  };

  if (admin) {
    o.attendees = regs.map(r => {
      const u = r.user || {};
      return {
        id: u._id || r.user || r._id,
        name: u.name || 'Student',
        email: u.email || 'N/A',
        attendance: r.attendance || 'unmarked',
        registeredAt: r.registeredAt
      };
    });
    o.waitlistQueue = wait.map((w, idx) => {
      const u = w.user || {};
      return {
        id: u._id || w.user || w._id,
        name: u.name || 'Student',
        email: u.email || 'N/A',
        position: idx + 1,
        joinedAt: w.joinedAt
      };
    });
    o.attendanceStats = {
      attended: regs.filter(r => r.attendance === 'attended').length,
      absent: regs.filter(r => r.attendance === 'absent').length,
      unmarked: regs.filter(r => !r.attendance || r.attendance === 'unmarked').length,
      total: regs.length
    };
  }

  return o;
};

/* ── Auth Routes ── */
app.post('/api/register', wrap(async (q, s) => {
  const { fullname, email, password, role, adminCode } = q.body;
  if (!fullname?.trim() || !email?.trim() || (password || '').length < 6) return fail(s, 400, 'Enter your name, email and a password of 6+ characters');
  if (!['admin', 'student'].includes(role)) return fail(s, 400, 'Choose a role');
  if (role === 'admin' && (adminCode || '').trim() !== ADMIN_CODE) return fail(s, 403, 'Invalid admin code');
  if (await User.findOne({ email: email.toLowerCase() })) return fail(s, 409, 'This email is already registered');
  s.json(session(await User.create({ name: fullname.trim(), email, role, password: await bcrypt.hash(password, 10) })));
}));

app.post('/api/login', wrap(async (q, s) => {
  const { email, password, role } = q.body;
  const u = await User.findOne({ email: (email || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(password || '', u.password))) return fail(s, 401, 'Wrong email or password');
  if (u.role !== role) return fail(s, 403, `This account is a ${u.role} account. Switch role above.`);
  s.json(session(u));
}));

/* ── Events Listing & Creation ── */
app.get('/api/events', auth(), wrap(async (q, s) => {
  const admin = q.user.role === 'admin';
  let query = Event.find();
  if (admin) {
    query = query.populate('registrations.user', 'name email').populate('waitlist.user', 'name email');
  }
  let list = await query.exec();
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
    tags: (tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 6),
    registrations: [],
    waitlist: [],
    interested: []
  });
  s.json(view(e, q.user.id, true));
}));

app.delete('/api/events/:id', auth('admin'), wrap(async (q, s) => {
  await Event.findByIdAndDelete(q.params.id);
  s.json({ ok: true });
}));

/* ── Student: Direct Registration ── */
app.post('/api/events/:id/register', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const isReg = event.registrations.some(r => getUserId(r) === q.user.id);
  if (isReg) return fail(s, 409, 'You are already registered for this event');

  if (event.registrations.length >= event.seats) {
    return fail(s, 409, 'This event is currently full. Join the waiting list!');
  }

  // Remove from waitlist if user was previously waitlisted
  event.waitlist = event.waitlist.filter(w => getUserId(w) !== q.user.id);
  
  // Add to confirmed registrations
  event.registrations.push({
    user: q.user.id,
    attendance: 'unmarked',
    registeredAt: new Date()
  });

  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Student: Join Waiting List (FIFO) ── */
app.post('/api/events/:id/waitlist', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const isReg = event.registrations.some(r => getUserId(r) === q.user.id);
  if (isReg) return fail(s, 400, 'You already have a confirmed seat for this event');

  const isWait = event.waitlist.some(w => getUserId(w) === q.user.id);
  if (isWait) return fail(s, 400, 'You are already on the waiting list');

  // Push to end of array to maintain strict FIFO
  event.waitlist.push({
    user: q.user.id,
    joinedAt: new Date()
  });

  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Student: Cancel Registration (Triggers FIFO Auto-Promotion) ── */
app.post('/api/events/:id/cancel', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const regIndex = event.registrations.findIndex(r => getUserId(r) === q.user.id);
  if (regIndex === -1) return fail(s, 400, 'You are not registered for this event');

  // Remove current user
  event.registrations.splice(regIndex, 1);

  let promotedUser = null;
  // FIFO Promotion: promote first waitlisted student if any
  if (event.waitlist.length > 0 && event.registrations.length < event.seats) {
    const nextInQueue = event.waitlist.shift(); // FIFO order: first in, first out
    event.registrations.push({
      user: nextInQueue.user,
      attendance: 'unmarked',
      registeredAt: new Date()
    });
    promotedUser = nextInQueue.user;
  }

  await event.save();
  const v = view(event, q.user.id);
  if (promotedUser) v.promoted = true;
  s.json(v);
}));

/* ── Student: Leave Waiting List ── */
app.post('/api/events/:id/leave-waitlist', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  event.waitlist = event.waitlist.filter(w => getUserId(w) !== q.user.id);
  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Admin: Attendance Management ── */
app.post('/api/events/:id/attendance', auth('admin'), wrap(async (q, s) => {
  const { userId, status } = q.body;
  if (!userId || !['attended', 'absent', 'unmarked'].includes(status)) {
    return fail(s, 400, 'Valid userId and status (attended, absent, unmarked) are required');
  }

  const event = await Event.findById(q.params.id).populate('registrations.user', 'name email').populate('waitlist.user', 'name email');
  if (!event) return fail(s, 404, 'Event not found');

  const attendee = event.registrations.find(r => getUserId(r) === userId);
  if (!attendee) return fail(s, 404, 'Attendee not found in confirmed registrations');

  attendee.attendance = status;
  await event.save();
  s.json(view(event, q.user.id, true));
}));

/* ── Student: Interest / Hype ── */
app.post('/api/events/:id/interest', auth('student'), wrap(async (q, s) => {
  const e = await Event.findById(q.params.id);
  if (!e) return fail(s, 404, 'Event not found');
  const hasInt = (e.interested || []).some(r => String(r._id || r) === q.user.id);
  await Event.updateOne({ _id: e.id }, hasInt
    ? { $pull: { interested: q.user.id } } : { $addToSet: { interested: q.user.id } });
  s.json({ ok: true });
}));

/* ── Frontend SPA Route Fallback ── */
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
