# Patenter

Patenter is a web application for drafting, searching and managing patents
with the help of AI. It is built for patent attorneys and inventors, from
individual inventors and start-ups to large enterprises.

## Features

### Patenter AI
An AI assistant for patent work: brainstorm and develop inventions, write
claims, create technical summaries and draft complete patent applications.
Conversations keep their context, so follow-ups such as "make claim 2
narrower" work. Drafts open directly in the Patenter editor.

### Patenter Find
Search worldwide patent publications through the European Patent Office's
Open Patent Services by keywords, applicant, inventor, CPC class,
publication number and publication date. The most relevant results come with
bibliographic data and an AI-written summary, plus a link to the full
document on Espacenet.

- **Compare a claim**: finds the closest documents for a claim and has
  Patenter AI compare them feature by feature (✓ / ~ / ✗ table) with notes
  on novelty and inventive step.
- **Watchlist**: save a search (for example a competitor or a CPC class) and
  check it later for publications that are new since you last looked.

### Patenter Editor
A text editor designed for patent applications, with a document library for
drafts and uploaded files.

- **Claims check**: finds numbering gaps and duplicates, references to
  missing or later claims, missing antecedent basis ("said lever" without
  "a lever"), claims that aren't one sentence, and EPO/USPTO excess-claims
  fees.
- **Numbering**: renumber claims (references such as "claim 3" are updated
  too) and add or remove `[0001]`-style paragraph numbers.
- **AI actions**: select text to broaden or narrow a claim, write dependent
  claims, improve clarity, rewrite in EP two-part form or US style, or
  explain it in plain language.

### Deadline calculator
Key dates for a first filing, a PCT application or a European application:
priority year, publication, Article 19 and Chapter II, PCT national and
regional phase, EP examination and renewal fees (with grace periods). Dates
on weekends move to the next working day, and the list can be exported to a
calendar (.ics).

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

## Testing locally

To try the whole site on your own computer without Docker (for example on
an older Mac), see [`dev/README.md`](dev/README.md).

## License

Copyright © 2026 Patenter. All rights reserved.
