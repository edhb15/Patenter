# Run Patenter on your Mac (without Docker)

`dev/start.js` runs the whole site on your computer: sign-in, Patenter AI,
Find, the Editor and the deadline calculator. It works on older Macs such as
macOS Big Sur, which can't run current Docker versions.

It is for testing only. The real server still uses `docker-compose.yml`.

## One-time setup

1. **Install Node.js 22.** Download the macOS installer (`.pkg`) for version 22
   from <https://nodejs.org/en/download> and run it.

2. **Install Postgres.app** (the database) from <https://postgresapp.com>.
   If the current version doesn't open on your Mac, take an older one from
   <https://postgresapp.com/downloads_legacy.html>. Move it to Applications,
   open it and click **Initialize** (or **Start**).

3. **Get the Patenter code.** On GitHub, open the repository, choose this
   branch, click **Code → Download ZIP**, and unzip it, for example into your
   Documents folder.

4. **Open Terminal** (Applications → Utilities → Terminal) and go to the
   folder. Type `cd ` (with a space), drag the unzipped folder onto the
   Terminal window, and press Enter.

5. **Create the settings file:**

   ```sh
   node dev/start.js
   ```

   The first time, this only creates a file called `.env` and stops. Open it:

   ```sh
   open -e .env
   ```

   Fill in your EPO keys (`CONSUMER_KEY`, `CONSUMER_SECRET`, from
   <https://developers.epo.org>) and your OpenRouter key
   (`OPENROUTER_API_KEY`, from <https://openrouter.ai/keys>), then save.
   The secret key for logins is already filled in for you.

## Start Patenter

Make sure Postgres.app is running, then in Terminal (in the Patenter folder):

```sh
node dev/start.js
```

The first start takes a few minutes while it installs packages. When it
says **Patenter is starting on http://localhost:8080**, open
<http://localhost:8080> in your browser, click **Create account**, and try
everything. Passwords need at least 8 characters.

Press **Ctrl+C** in Terminal to stop it.

## Good to know

- Search and AI use your real EPO and OpenRouter accounts. With `AI_MODELS`
  left empty, the free testing models are used.
- The accounts and documents you create live only on your Mac.
- The Terminal window shows one line per request: `[auth]` is sign-in,
  `[api ]` is search and AI. If something doesn't work, the reason is usually
  there. `POST /auth/refresh → 401 (not signed in yet, normal)` is expected
  before you sign in.
- If you download a newer version of the code, copy your `.env` file into
  the new folder (it's hidden in Finder; in Terminal:
  `cp old-folder/.env new-folder/`).

## Problems

| Message | What to do |
|---|---|
| `PostgreSQL is not running` | Open Postgres.app and click Start. |
| `Fill in ... in .env` | Open the file with `open -e .env` and add the missing keys. |
| `command not found: node` | Install Node.js (step 1), then open a new Terminal window. |
| `address already in use` | Patenter (or another program) is already running. Close the other Terminal window, or restart the Mac. |
| `Validation error: password: Too small` | The password needs at least 8 characters. |
| `→ 429` (too many requests) | Sign-up allows 5 attempts per hour. Press Ctrl+C and start Patenter again to reset it. |
| Database login errors | If your Postgres isn't Postgres.app, add `DATABASE_URL=postgresql://user:password@localhost:5432/patenter` to `.env`. |
