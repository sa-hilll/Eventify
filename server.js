try {
  require('dns').setServers(['8.8.8.8', '8.8.4.4']); // router blocks SRV lookups; use Google DNS
} catch (e) {
  // DNS override not supported in some serverless environments
}

const path = require('path');
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const app = express();
app.use(express.json({ limit: '10mb' }));
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
  name: String, email: { type: String, unique: true, lowercase: true, trim: true }, password: String,
  role: { type: String, enum: ['admin', 'student'] }
}));

const Event = mongoose.model('Event', new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  seats: { type: Number, required: true, min: 1 },
  description: { type: String, default: '' },
  tags: { type: [String], default: [] },
  banner: { type: String, default: '' },
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
  catch { return fail(s, 401, 'Session expired. Please log in again'); }
  if (role && q.user.role !== role) return fail(s, 403, 'Unauthorized access for your role');
  n();
};

const session = u => ({
  token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' }),
  user: { name: u.name, role: u.role }
});

const getUserId = r => String(r?.user?._id || r?.user || r?._id || r);

const view = (e, uid, admin) => {
  const regs = (e.registrations || []).filter(r => r && (r.user || r._id));
  const wait = (e.waitlist || []).filter(w => w && (w.user || w._id));
  const ints = e.interested || [];
  
  const regItem = regs.find(r => getUserId(r) === uid);
  const isRegistered = Boolean(regItem);
  const waitIndex = wait.findIndex(w => getUserId(w) === uid);
  const isWaitlisted = waitIndex !== -1;
  const waitlistPos = isWaitlisted ? waitIndex + 1 : null;
  const isInterested = ints.some(r => String(r._id || r) === uid);

  const o = {
    id: String(e.id || e._id),
    name: e.name,
    date: e.date,
    time: e.time,
    seats: e.seats,
    description: e.description || '',
    tags: e.tags || [],
    banner: e.banner || '',
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
      const u = (r.user && typeof r.user === 'object') ? r.user : {};
      return {
        id: String(u._id || r.user || r._id),
        name: u.name || 'Registered Student',
        email: u.email || 'N/A',
        attendance: r.attendance || 'unmarked',
        registeredAt: r.registeredAt || new Date()
      };
    });
    o.waitlistQueue = wait.map((w, idx) => {
      const u = (w.user && typeof w.user === 'object') ? w.user : {};
      return {
        id: String(u._id || w.user || w._id),
        name: u.name || 'Waitlisted Student',
        email: u.email || 'N/A',
        position: idx + 1,
        joinedAt: w.joinedAt || new Date()
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

/* ── Auth Endpoints ── */
app.post('/api/register', wrap(async (q, s) => {
  const { fullname, email, password, role, adminCode } = q.body;
  if (!fullname?.trim() || !email?.trim() || (password || '').length < 6) {
    return fail(s, 400, 'Please provide your name, valid email and a password (min 6 chars)');
  }
  if (!['admin', 'student'].includes(role)) return fail(s, 400, 'Please choose a valid role');
  if (role === 'admin' && (adminCode || '').trim() !== ADMIN_CODE) {
    return fail(s, 403, 'Invalid admin passcode — check ADMIN_CODE environment variable');
  }
  const cleanEmail = email.toLowerCase().trim();
  if (await User.findOne({ email: cleanEmail })) {
    return fail(s, 409, 'An account with this email already exists. Please log in.');
  }
  const newUser = await User.create({
    name: fullname.trim(),
    email: cleanEmail,
    role,
    password: await bcrypt.hash(password, 10)
  });
  s.json(session(newUser));
}));

app.post('/api/login', wrap(async (q, s) => {
  const { email, password, role } = q.body;
  const cleanEmail = (email || '').toLowerCase().trim();
  const u = await User.findOne({ email: cleanEmail });
  if (!u || !(await bcrypt.compare(password || '', u.password))) {
    return fail(s, 401, 'Invalid email or password');
  }
  if (u.role !== role) {
    return fail(s, 403, `This account is registered as a ${u.role}. Switch the role tab above.`);
  }
  s.json(session(u));
}));

/* ── Events Endpoints ── */
app.get('/api/events', auth(), wrap(async (q, s) => {
  const admin = q.user.role === 'admin';
  let query = Event.find();
  query = query.populate('registrations.user', 'name email').populate('waitlist.user', 'name email');
  let list = await query.exec();
  
  s.json(list.map(e => view(e, q.user.id, admin))
    .sort((a, b) => (b.hype - a.hype) || (a.date + a.time).localeCompare(b.date + b.time)));
}));

app.post('/api/events', auth('admin'), wrap(async (q, s) => {
  const { name, date, time, seats, description, tags, banner } = q.body;
  const n = parseInt(seats, 10);
  if (!name?.trim() || !date || !time || isNaN(n) || n < 1) {
    return fail(s, 400, 'Event name, date, time and a positive seat limit (at least 1) are required');
  }
  const e = await Event.create({
    name: name.trim(),
    date,
    time,
    seats: n,
    description: (description || '').trim(),
    banner: banner || '',
    tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6) : [],
    registrations: [],
    waitlist: [],
    interested: []
  });
  s.json(view(e, q.user.id, true));
}));

app.delete('/api/events/:id', auth('admin'), wrap(async (q, s) => {
  const e = await Event.findByIdAndDelete(q.params.id);
  if (!e) return fail(s, 404, 'Event not found');
  s.json({ ok: true, message: 'Event successfully removed' });
}));

/* ── Student Direct Registration ── */
app.post('/api/events/:id/register', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const isReg = event.registrations.some(r => getUserId(r) === q.user.id);
  if (isReg) return fail(s, 409, 'You already have a confirmed seat for this event');

  if (event.registrations.length >= event.seats) {
    return fail(s, 409, 'This event is full. Join the waiting list!');
  }

  event.waitlist = event.waitlist.filter(w => getUserId(w) !== q.user.id);
  event.registrations.push({
    user: q.user.id,
    attendance: 'unmarked',
    registeredAt: new Date()
  });

  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Student Join FIFO Waitlist ── */
app.post('/api/events/:id/waitlist', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const isReg = event.registrations.some(r => getUserId(r) === q.user.id);
  if (isReg) return fail(s, 400, 'You already hold a confirmed ticket for this event');

  const isWait = event.waitlist.some(w => getUserId(w) === q.user.id);
  if (isWait) return fail(s, 400, 'You are already on the waiting list');

  event.waitlist.push({
    user: q.user.id,
    joinedAt: new Date()
  });

  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Student Cancel Pass (FIFO Auto-Promotion) ── */
app.post('/api/events/:id/cancel', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  const regIndex = event.registrations.findIndex(r => getUserId(r) === q.user.id);
  if (regIndex === -1) return fail(s, 400, 'You do not have a confirmed reservation for this event');

  event.registrations.splice(regIndex, 1);

  let promotedUser = null;
  // FIFO: promote first waitlisted student
  if (event.waitlist.length > 0 && event.registrations.length < event.seats) {
    const nextInQueue = event.waitlist.shift();
    if (nextInQueue && nextInQueue.user) {
      event.registrations.push({
        user: nextInQueue.user,
        attendance: 'unmarked',
        registeredAt: new Date()
      });
      promotedUser = nextInQueue.user;
    }
  }

  await event.save();
  const resView = view(event, q.user.id);
  if (promotedUser) resView.promoted = true;
  s.json(resView);
}));

/* ── Student Leave Waitlist ── */
app.post('/api/events/:id/leave-waitlist', auth('student'), wrap(async (q, s) => {
  const event = await Event.findById(q.params.id);
  if (!event) return fail(s, 404, 'Event not found');

  event.waitlist = event.waitlist.filter(w => getUserId(w) !== q.user.id);
  await event.save();
  s.json(view(event, q.user.id));
}));

/* ── Admin Attendance Management ── */
app.post('/api/events/:id/attendance', auth('admin'), wrap(async (q, s) => {
  const { userId, status } = q.body;
  if (!userId || !['attended', 'absent', 'unmarked'].includes(status)) {
    return fail(s, 400, 'Valid userId and status (attended, absent, unmarked) are required');
  }

  const event = await Event.findById(q.params.id).populate('registrations.user', 'name email').populate('waitlist.user', 'name email');
  if (!event) return fail(s, 404, 'Event not found');

  const attendee = event.registrations.find(r => getUserId(r) === userId);
  if (!attendee) return fail(s, 404, 'Student is not in the confirmed attendees list');

  attendee.attendance = status;
  await event.save();
  s.json(view(event, q.user.id, true));
}));

/* ── Student Hype / Interest ── */
app.post('/api/events/:id/interest', auth('student'), wrap(async (q, s) => {
  const e = await Event.findById(q.params.id);
  if (!e) return fail(s, 404, 'Event not found');
  const hasInt = (e.interested || []).some(r => String(r._id || r) === q.user.id);
  await Event.updateOne({ _id: e.id }, hasInt
    ? { $pull: { interested: q.user.id } } : { $addToSet: { interested: q.user.id } });
  s.json({ ok: true });
}));

/* ── Single Page Application Fallback ── */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API Endpoint not found' });
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
