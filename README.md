# 🎟️ Eventify — Campus Event Management System

<div align="center">
  <img src="public/logo.png" width="100" height="100" alt="Eventify Logo" style="border-radius: 20px; box-shadow: 0 8px 24px rgba(139,92,246,0.4);" />
  <h3>Modern College Event Discovery, FIFO Waiting List & Attendance Tracking</h3>
  <p>A high-performance full-stack campus event platform built with Node.js, Express, MongoDB Atlas, and Vercel Serverless.</p>
</div>

---

## 🌟 Overview & Core Use Cases

**Eventify** simplifies how campus events, technical symposiums, hackathons, and cultural fests are organized and attended.

### 👥 User Roles & Use Cases

#### 🎓 For Students
* **Discover Events:** Browse upcoming workshops, hackathons, seminars, and fests with real-time seat availability and tag filters.
* **Instant RSVP:** Book confirmed event tickets when seats are available.
* **FIFO Waiting List:** When an event is sold out (`0 seats left`), join an automated first-come, first-served (FIFO) queue with live position tracking (`#1`, `#2`, etc.).
* **Ticket Cancellation & Auto-Promotion:** Cancel confirmed tickets at any time. When cancelled, the next student in the queue is automatically promoted to a confirmed seat.
* **My Passes Dashboard:** Filter and view all currently booked passes and waitlisted positions.
* **Event Hype:** Upvote / star events to show interest and elevate them on the campus leaderboard.

#### 🛡️ For Campus Admins
* **Publish Events:** Create events with custom title, date, time, capacity limit, tag categories, and custom/preset high-resolution poster artwork.
* **Live Attendance Management:** Mark each confirmed attendee as **`✓ Attended`** (Present), **`✕ Absent`**, or reset to **`↺ Unmarked`** with instant real-time statistics.
* **FIFO Queue Monitoring:** View the live ordered queue of waitlisted students with priority position tags and registration timestamps.
* **Event Administration:** Edit or permanently delete events with instant attendee list cleanup.

---

## ⚙️ Business Logic Rules & Constraints

1. **Capacity & Seat Constraints:**
   * Students can only register directly if `current_registrations < seat_limit`.
   * When capacity is reached (`left == 0`), direct registration is disabled and the **"Join Waiting List"** action becomes available.
2. **First-Come, First-Served (FIFO) Queue:**
   * The waiting list strictly preserves arrival order (FIFO).
   * Duplicate entries are blocked (a user cannot be registered and waitlisted simultaneously, or waitlisted multiple times for the same event).
3. **Automated Promotion Engine:**
   * When a confirmed student cancels their pass, the engine immediately takes the head of the queue (`waitlist[0]`), promotes them to confirmed status with `attendance: 'unmarked'`, and advances remaining students in the queue.
4. **Attendance Tracking Constraints:**
   * Admin attendance controls are restricted to confirmed attendees.
   * Status values are strictly validated: `'attended'`, `'absent'`, or `'unmarked'`.
5. **Security & Role-Based Access Control (RBAC):**
   * Admin account creation requires a secure `ADMIN_CODE` server secret.
   * Passwords are encrypted using `bcrypt` (salted hash, minimum 6 characters).
   * Authenticated sessions use signed JSON Web Tokens (`JWT`) with a 7-day expiration.

---

## 🛠️ Tech Stack & Architecture

* **Frontend:** Responsive Single-Page Application (Vanilla JS, CSS3 Obsidian & Ultraviolet Theme, Plus Jakarta Sans & Outfit Typography).
* **Backend:** Express.js REST API with connection-cached serverless database middleware.
* **Database:** MongoDB Atlas (Mongoose ODM).
* **Authentication:** JWT (JSON Web Tokens) & `bcryptjs`.
* **Hosting & Deployment:** Vercel Serverless Functions.

---

## 📋 API Reference

### 🔐 Authentication
* `POST /api/register` — Register new student or admin account (requires `adminCode` for admin).
* `POST /api/login` — Authenticate user and receive signed JWT.

### 📅 Events
* `GET /api/events` — Retrieve event catalogue with occupancy, waitlist counts, and user booking state.
* `POST /api/events` — Publish a new campus event *(Admin only)*.
* `DELETE /api/events/:id` — Delete an event *(Admin only)*.

### 🎟️ Booking & Waiting List
* `POST /api/events/:id/register` — Reserve a confirmed seat *(Student only)*.
* `POST /api/events/:id/waitlist` — Join the FIFO waiting list *(Student only)*.
* `POST /api/events/:id/cancel` — Cancel confirmed seat and auto-promote waitlisted student *(Student only)*.
* `POST /api/events/:id/leave-waitlist` — Remove self from waiting list queue *(Student only)*.
* `POST /api/events/:id/interest` — Toggle hype / star count *(Student only)*.

### 📋 Attendance Management
* `POST /api/events/:id/attendance` — Update student attendance (`attended` / `absent` / `unmarked`) *(Admin only)*.

---

## 🚀 Environment Variables

Configure these environment variables in your `.env` file or Vercel Project Settings:

```env
MONGO_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/eventify?retryWrites=true&w=majority
JWT_SECRET=your_super_secret_jwt_signing_key_here
ADMIN_CODE=ADMIN123
PORT=3000
```

---

## 💻 Local Setup & Development

```bash
# 1. Clone repository
git clone https://github.com/sa-hilll/Eventify.git
cd Eventify

# 2. Install dependencies
npm install

# 3. Start local development server
npm start
# Server runs on http://localhost:3000
```

---

<div align="center">
  <sub>Built with ❤️ for campus communities</sub>
</div>
