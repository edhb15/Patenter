# Deploying Patenter

Everything runs with Docker Compose on one server: Caddy (website and
HTTPS), the auth service, the API and PostgreSQL. Caddy gets the HTTPS
certificate by itself.

## What you need

- A Linux server with [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/)
  (2 CPUs and 4 GB of memory is plenty to start with).
- A domain, with a DNS `A` record (and `AAAA` for IPv6) pointing at the
  server. Ports 80 and 443 must be open.
- [EPO Open Patent Services](https://developers.epo.org) credentials.
- An [OpenRouter](https://openrouter.ai) API key.
- A [Stripe](https://stripe.com) account, for paid plans.

## 1. Configure

```sh
git clone https://github.com/edhb15/Patenter.git
cd Patenter
cp deploy/.env.example .env
chmod 600 .env
```

Fill in `.env`. Leave the Stripe values empty for now.

| Setting | Value |
|---------|-------|
| `DOMAIN` | e.g. `patenter.example` (no `https://`) |
| `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `INTERNAL_API_SECRET` | Three **different** random values: run `openssl rand -base64 48` for each |
| `CONSUMER_KEY`, `CONSUMER_SECRET` | From your EPO OPS app |
| `OPENROUTER_API_KEY` | From OpenRouter |
| `AI_MODELS` | Paid models from providers that don't log or train on prompts (users send unpublished inventions). Turn on zero data retention in OpenRouter. |

## 2. Start

```sh
docker compose up -d --build
docker compose ps          # all four services "Up", db "healthy"
```

Open `https://your-domain` and create an account. The first request can
take a few seconds while Caddy gets the certificate. Database migrations
run automatically whenever the auth service starts.

Without Stripe the site works fully: everyone is on the Free plan, the
upgrade buttons say "Coming soon", and you can move people between plans by
hand (see [Running it](#4-running-it)).

## 3. Payments with Stripe

Do this in Stripe's **test mode** first, then repeat it in live mode.
Stripe keeps test and live data apart, so each mode needs its own setup.

### Test mode

1. In the Stripe dashboard, switch to test mode and copy the secret key
   (**Developers → API keys**, starts with `sk_test_`).
2. Run the setup script. It creates the Pro ($10) and Max ($20) monthly
   prices, the customer portal settings and the webhook, then prints the
   lines for `.env`:

   ```sh
   docker compose run --rm --no-deps -e STRIPE_SECRET_KEY=sk_test_... \
     auth node dist/scripts/stripeSetup.js https://your-domain
   ```

3. Put the printed lines in `.env`, with your `sk_test_` key as
   `STRIPE_SECRET_KEY`, and restart:

   ```sh
   docker compose up -d
   ```

4. Try it: sign in, open **Plan & credits**, click **Upgrade to Pro** and
   pay with card `4242 4242 4242 4242` (any future date, any CVC). You are
   sent back to Patenter and the plan switches within a few seconds. Then
   use **Manage subscription** to switch to Max and to cancel.

   In the Stripe dashboard, **Developers → Webhooks → your endpoint**
   should show the deliveries answered with `200`.

### Going live

1. Finish activating your Stripe account (business details, bank account).
2. **Tax.** Selling subscriptions means VAT (in the EU) or sales tax, and
   how you handle it is a question for your accountant. To have Stripe
   calculate it, set up **Stripe Tax** in the dashboard: your business
   address, where you are registered, and "Software as a service" as the
   default product tax code. Then set `STRIPE_AUTOMATIC_TAX=true`.
   Checkout then asks for the customer's address and VAT number, and adds
   the tax.
3. **Failed payments.** Under **Settings → Billing → Subscriptions**
   ("Manage failed payments"), pick what happens after the last retry:
   cancel the subscription, or mark it unpaid. Either moves the customer
   back to Free. Don't pick "leave the subscription past due", or they
   keep their paid plan without paying.
4. Optionally turn on receipt emails and add links to your terms and
   privacy policy in Stripe's settings.
5. While `.env` still has the **test** key, clear the test purchases:
   customers and subscriptions from test mode don't exist in live mode.
   This moves anyone who had a test subscription back to Free (it refuses
   to run with a live key):

   ```sh
   docker compose exec auth node dist/scripts/resetBilling.js --confirm
   ```

6. Run the setup script again with your live key (`sk_live_...`), replace
   all `STRIPE_` lines in `.env` with the new output, and run
   `docker compose up -d`.

### How billing behaves

- A user's plan follows their Stripe subscription. Each webhook makes the
  auth service fetch the subscription's current state from Stripe, so late
  or repeated webhooks are harmless.
- **Cancelling** keeps the plan until the end of the month paid for, then
  the user moves to Free.
- **Failed payments**: the plan stays while Stripe retries, and the user
  sees a "payment didn't go through" notice with a button to update their
  card.
- **Refunds** are done in the Stripe dashboard. A refund does not cancel
  the subscription; cancel it there too if the user should lose the plan.
- **Changing prices**: edit `auth/src/credits/plans.ts`, rebuild
  (`docker compose up -d --build`), run the setup script again and update
  `.env`. New prices are created. Existing subscribers stay on their old
  price, which the script lists second so they keep their plan.

## 4. Running it

```sh
# Update to the latest version (migrations run on start)
git pull && docker compose up -d --build

# Logs
docker compose logs -f auth backend web

# Give someone a plan by hand (Stripe overrides it if they subscribe)
docker compose exec auth node dist/scripts/setPlan.js user@example.com pro

# Back up the database (schedule this daily and copy it off the server)
docker compose exec -T db pg_dump -U patenter patenter > backup-$(date +%F).sql

# Restore a backup into an empty database
docker compose exec -T db psql -U patenter patenter < backup-2026-10-18.sql
```

## Checklist before launch

- [ ] `.env` has its own random secrets, is `chmod 600` and is not in git
- [ ] `AI_MODELS` uses paid, no-logging models; zero data retention is on in OpenRouter
- [ ] Stripe is set up in live mode; one real purchase and refund were tried
- [ ] Tax settings decided (with Stripe Tax, `STRIPE_AUTOMATIC_TAX=true`)
- [ ] Daily database backups are scheduled and stored off the server
- [ ] The firewall only allows SSH, 80 and 443
