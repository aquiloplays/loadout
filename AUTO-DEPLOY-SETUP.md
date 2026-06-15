# Auto-deploy setup

After this is set up once, every push to `main` auto-deploys the worker (and applies D1 migrations) without you doing anything else. Forever. Total one-time effort: about 3 minutes.

## What you do once

### Step 1: Get a Cloudflare API token

1. Open https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Pick the "Edit Cloudflare Workers" template
4. Under "Account Resources" leave it as your account
5. Click Continue, then Create Token
6. Copy the token (you only see it once)

### Step 2: Get your Cloudflare account ID

1. Open https://dash.cloudflare.com
2. On the right side of any page you'll see "Account ID" with a copy button. Copy it.

### Step 3: Add both as repo secrets

1. Open https://github.com/aquiloplays/loadout/settings/secrets/actions
2. Click "New repository secret"
3. Name: `CLOUDFLARE_API_TOKEN`, value: the token from Step 1, click Add secret
4. Click "New repository secret" again
5. Name: `CLOUDFLARE_ACCOUNT_ID`, value: the account ID from Step 2, click Add secret

That is the entire setup.

## How it works after that

- Push anything to the `main` branch on Loadout
- GitHub Actions runs `.github/workflows/deploy-worker.yml`
- Applies any new `*-migration.sql` files in `discord-bot/` to your D1 database
- Runs `wrangler deploy`
- Smoke-checks `/api/dock/registry` to confirm the worker is live
- Done

You can also trigger it manually anytime: https://github.com/aquiloplays/loadout/actions/workflows/deploy-worker.yml > Run workflow

## What still needs you (rare)

- `wrangler secret put <NAME>` for new secrets that the worker needs. Add a step to the workflow OR run it locally once when you add a new env var
- New D1 databases or KV namespaces. Add to `wrangler.toml`, the deploy picks it up

## Site (aquilo-site)

Cloudflare Pages already auto-deploys aquilo-site on push to `master`. Nothing to set up.

## Why this is safe

- API token is scoped to Workers only, can't touch your DNS, email, billing
- Token never appears in logs (GitHub masks it automatically)
- Token is revocable from https://dash.cloudflare.com/profile/api-tokens anytime
- Workflow file is version-controlled, you can see exactly what it runs
