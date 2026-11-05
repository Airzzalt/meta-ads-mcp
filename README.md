# Meta Ads MCP server (read-only)

A tiny website that lets a bot read your Meta Ads data through MCP.
Your Meta token stays on the server. The bot only gets a URL and an API key.

Tools: `list_ad_accounts`, `list_campaigns`, `list_adsets`, `list_ads`, `get_insights`.

---

## Setup (about 15 minutes)

### Step 1 — Get a Meta System User token (read-only)

1. Go to **business.facebook.com** → click the gear **Business settings** (bottom left).
2. Left menu: **Users → System users** → **Add**.
3. Name it `mcp-readonly`, role **Employee** → **Create system user**.
4. Click the new user → **Add assets** → **Ad accounts** → tick each ad account you want the bot to see → turn on **View performance** only → **Save changes**.
5. Still on that user → **Generate new token**:
   - **App:** pick your Facebook app.
   - **Token expiration:** **Never**.
   - **Permissions:** tick **ads_read** only.
   - Click **Generate token** and **copy it somewhere safe**. You will not see it again.

### Step 2 — Make up an API key

This is the password the bot will use to talk to your server. Anything long and random works.
Easiest: go to a password generator, make a 40-character password with letters and numbers, copy it.
Call it `MCP_API_KEY`.

### Step 3 — Put these files on GitHub

Render needs the code in a GitHub repo.

1. Go to **github.com** (make a free account if you don't have one).
2. Top right **+** → **New repository** → name `meta-ads-mcp` → **Private** → **Create repository**.
3. On the empty repo page click **uploading an existing file**.
4. Drag in these files (NOT the `node_modules` folder):
   `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`, `README.md`
5. Click **Commit changes**.

### Step 4 — Deploy on Render

1. Go to **dashboard.render.com** → **New +** → **Blueprint**.
2. Connect your GitHub account if asked, then pick the `meta-ads-mcp` repo → **Connect**.
3. Render reads `render.yaml` and asks for two values:
   - `META_ACCESS_TOKEN` → paste the token from Step 1.
   - `MCP_API_KEY` → paste the key from Step 2.
4. Click **Apply** / **Deploy**. Wait 1–2 minutes until it says **Live**.
5. Open the service → the URL at the top looks like `https://meta-ads-mcp-xxxx.onrender.com`.
   Open it in your browser — you should see a page saying *Meta token set, API key set*.

### Step 5 — Connect your bot

Give the bot:

- **URL:** `https://meta-ads-mcp-xxxx.onrender.com/mcp`
- **Transport:** streamable HTTP
- **Header:** `Authorization: Bearer <your MCP_API_KEY>`

Then ask it to call `list_ad_accounts` as a test.

---

## Things to know

- **Free plan sleeps.** Render's free plan turns the server off after 15 minutes of no traffic; the first request afterwards takes ~30–60 s to wake up. If the bot times out, upgrade the service to **Starter** (Render → the service → Settings → Instance Type), which stays on.
- **Rotate the key.** To change the API key: Render → your service → **Environment** → edit `MCP_API_KEY` → Save (it redeploys automatically). Same for a new Meta token.
- **Money fields** (budgets, spend, purchase value) are in the ad account's currency.
- **Video metrics:** `video_3s_views` is Meta's "3-second video plays", `thruplays` is 15 s or full play. `hook_rate_pct` = 3s views ÷ impressions, `hold_rate_pct` = ThruPlays ÷ 3s views.
- **API version** is pinned in `render.yaml` (`META_API_VERSION`). When Meta retires it, just change the value there — no code change.

## Tool reference

| Tool | Inputs | Returns |
|---|---|---|
| `list_ad_accounts` | – | id, name, currency, timezone, status |
| `list_campaigns` | `account_id`, `status?` (ACTIVE/PAUSED/ALL) | id, name, status, objective, daily_budget, lifetime_budget, is_cbo |
| `list_adsets` | `campaign_id`, `status?` | id, name, status, budget, optimization_goal, dates |
| `list_ads` | `adset_id`, `status?` | id, name, status, primary_text, headline, thumbnail_url, image_url, link_url |
| `get_insights` | `level` (account/campaign/adset/ad), `id`, `date_preset?` or `since`+`until`, `daily?`, `breakdown?`, `status_filter?` | one row per object/day/breakdown with spend, impressions, reach, frequency, CPM, link clicks/CTR/CPC, landing page views, add to carts, checkouts, purchases, purchase value, cost per purchase, ROAS, video plays, 3s/25/50/75/100% views, ThruPlays, hook & hold rate |

Example: `get_insights(level="ad", id="act_123456789", date_preset="last_7d", daily=true)` → every ad in the account, one row per day.
