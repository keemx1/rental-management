# Rental Messaging System

WhatsApp rent reminders and collection dashboard for property managers.  
**Separate from ISP Messaging Sys** — own port, WhatsApp session, and data.

## Quick start (local — JSON storage until Supabase)

```powershell
cd C:\Users\DGX\Downloads\rental_messaging
npm install
copy .env.example .env
npm start
```

Open **http://localhost:3001**  
Login: **admin** / **admin123** (change via `npm run reset:admin`)

## Features

- Admin login
- Dashboard: tenants, overdue, revenue MTD, pending payments, due in 7 days
- WhatsApp QR link + reset (admin)
- Houses CRUD (house code, house number, notes)
- Tenants/clients CRUD linked to their house numbers
- Payments: record pending → approve → WhatsApp confirmation
- Auto reminders: **7 days** and **1 day** before rent due (8:00 AM, `CRON_TZ`)
- Broadcast center: send to all houses or a single house
- Custom broadcast templates (with placeholders for client + house fields)

## Storage

Until Supabase is connected, data lives in **`data/*.json`** (auto-created).  
Set **`DATABASE_URL`** later and run `schema.sql` — Postgres adapter can be wired in `backend/config/database.js`.

## Deploy on same VPS as ISP app

| | ISP app | Rental app |
|--|---------|------------|
| Folder | `messaging_bot` | `rental_messaging` |
| Port | 3000 | **3001** |
| WhatsApp session | `session-isp-billing-engine` | **`session-rental-messaging`** |
| PM2 name | `messaging-sys` | `rental-sys` |

Caddy block:

```text
rent.clientdomain.com {
    reverse_proxy 127.0.0.1:3001
}
```

## Default demo data

Two sample tenants are seeded on first run. Set `SEED_DEMO_TENANTS=false` in `.env` to skip.
