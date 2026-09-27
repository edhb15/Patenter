# Patenter

Patenter is a web application for drafting, searching and managing patents
with the help of AI. It is built for patent attorneys and inventors, from
individual inventors and start-ups to large enterprises.

## Features

### Patenter AI
An AI assistant for patent work: brainstorm and develop inventions, write
claims, create technical summaries and draft complete patent applications.
Drafts open directly in the Patenter editor.

### Patenter Find
Search worldwide patent publications through the European Patent Office's
Open Patent Services. The most relevant results come with bibliographic data
and an AI-written summary, plus a link to the full document on Espacenet.

### Patenter Editor
A text editor designed for patent applications, with a document library for
drafts and uploaded files.

> Patenter AI can make mistakes and does not give legal advice. Drafts should
> be reviewed by a patent attorney before filing.

## Architecture

Everything is served from a single domain:

| Path       | Service                | Source      |
|------------|------------------------|-------------|
| `/`        | Website (static pages) | `index.html`, `login.html`, `app/`, `shared/` |
| `/auth/*`  | Accounts and sign-in (TypeScript, Express, PostgreSQL via Prisma) | `auth/` |
| `/api/*`   | Patent search and Patenter AI (Node.js, Express) | `backend/` |

[Caddy](https://caddyserver.com) sits in front of the services, serves the
website, routes `/auth` and `/api`, and obtains HTTPS certificates
automatically (`deploy/Caddyfile`).

**Security.** Sign-in uses short-lived access tokens kept in memory plus a
rotating refresh token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
Passwords are hashed with Argon2, all API endpoints require sign-in and are
rate limited, and the pages use a strict Content Security Policy. Third-party
API keys (EPO, OpenRouter) stay on the server.

## License

Copyright © 2026 Patenter. All rights reserved.
