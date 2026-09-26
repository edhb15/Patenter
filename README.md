# Patenter
Patenter is a software for making patents and doing other patent related stuff with ai
## Functions
Patenter has a set of helpful and smart functions for making patents 
### Patenter AI
Patenter ai is a smart and helpful ai bot that can make patent drafts, help you brainstorm, Create Technical Summaries, Develop Inventions and much more!
### Patenter find
Patenter find is a software that helps you find patents, you can search worldwide patents with the service for free! 
### Patenter text editor 
Patenter text editor is our own text editor! Specifically designed for creating patents, say goodbye to boring styles, you can ask Patenter ai to make the styles!


## Running locally

Patenter has three parts:

| Part | Folder | Default address |
| --- | --- | --- |
| Auth service (accounts, sign-in) | `auth/` | http://localhost:3000 |
| Search + AI backend | `backend/` | http://localhost:3001 |
| Website (static pages) | repo root | http://localhost:5500 |

You need Node.js 22+ and PostgreSQL.

1. **Auth service**
   ```sh
   cd auth
   cp .env.example .env    # fill in DATABASE_URL and JWT_ACCESS_SECRET
   npm install
   npx prisma migrate deploy
   npm run dev
   ```
   Optional: create a first account with
   `SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run seed`.

2. **Search + AI backend**
   ```sh
   cd backend
   cp .env.example .env    # EPO + OpenRouter keys, same JWT_ACCESS_SECRET as auth
   npm install
   npm start
   ```

3. **Website**: serve the repo root on port 5500, e.g. `npx serve -l 5500 .`
   or VS Code Live Server, then open http://localhost:5500.

Open the site with the same host name the APIs use (`localhost` or
`127.0.0.1`, not a mix). Otherwise the browser won't send the sign-in cookie.

For deployment, set `window.PATENTER_CONFIG = { authUrl, apiUrl }` before
`shared/auth-client.js` loads. Also update `ALLOWED_ORIGINS` in both `.env`
files and the `connect-src` Content-Security-Policy in each page.

## Tests

```sh
cd auth && npm test       # needs DATABASE_URL pointing at a test database
cd backend && npm test    # no network or real keys needed
```
