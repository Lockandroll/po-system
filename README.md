# PO System — Deployment Guide

A simple, self-hosted purchase order system. Built with Node.js, Express, and PostgreSQL.

## Features

- **Requesters** create and submit purchase orders
- **Approvers** review, approve, or reject submitted POs
- **Admins** do everything + manage users
- Email notifications on submit and approval/rejection (via Resend)
- Clean, responsive web interface

---

## Deploy to Railway (Step by Step)

### Step 1 — Push code to GitHub

1. Create a new repository on [github.com](https://github.com)
2. In your terminal (in this folder), run:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

### Step 2 — Create the Railway project

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project**
3. Select **Deploy from GitHub repo** → choose your repo
4. Railway will detect Node.js and start building automatically

### Step 3 — Add PostgreSQL

1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Once it's created, go to the Postgres service → **Variables** tab
3. Copy the `DATABASE_URL` value (you'll need it next)

### Step 4 — Set environment variables

In your Railway project, click on your **web service** → **Variables** tab, then add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | *(auto-linked — Railway may fill this in automatically)* |
| `JWT_SECRET` | A long random string (e.g., run `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |
| `RESEND_API_KEY` | *(optional)* Your key from resend.com |
| `FROM_EMAIL` | *(optional)* e.g. `PO System <onboarding@resend.dev>` |

> **Tip:** Railway often auto-links `DATABASE_URL` when you add a Postgres service to the same project. Check if it's already there before adding it manually.

### Step 5 — Deploy & open

1. Railway will automatically redeploy when variables are saved
2. Click **Settings** → **Networking** → **Generate Domain** to get a public URL
3. Open the URL — you'll see a first-time setup screen to create your admin account

---

## First-Time Setup

1. Open your Railway URL
2. You'll see a **"Create Admin Account"** screen (only appears when the database is empty)
3. Enter your name, email, and password — this creates the admin account
4. Log in and go to **Users** in the sidebar to add your team members

---

## User Roles

| Role | Can Do |
|---|---|
| **Requester** | Create, edit, and submit POs |
| **Approver** | View all POs, approve or reject submitted ones |
| **Admin** | Everything + manage users |

---

## Email Notifications (Optional)

1. Sign up free at [resend.com](https://resend.com)
2. Create an API key
3. Add `RESEND_API_KEY` to your Railway environment variables
4. Emails will be sent from `onboarding@resend.dev` on the free plan
   - To send from your own domain (e.g. `noreply@yourcompany.com`), verify the domain in Resend and update `FROM_EMAIL`

---

## Running Locally (for development)

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your local PostgreSQL connection string and a JWT_SECRET

# Start the server
npm run dev
```
