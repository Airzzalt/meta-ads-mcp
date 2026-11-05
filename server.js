// Meta Ads MCP server — read-only.
// Exposes list_ad_accounts, list_campaigns, list_adsets, list_ads, get_insights
// over the MCP streamable HTTP transport at POST /mcp, protected by a Bearer API key.
// The Meta access token never leaves this server.

import express from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------- configuration (all from environment variables) ----------
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const META_API_VERSION = process.env.META_API_VERSION || "v25.0";
const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = Number(process.env.MAX_ROWS || 2000); // safety cap on paginated results

if (!META_ACCESS_TOKEN) console.warn("WARNING: META_ACCESS_TOKEN is not set — Meta calls will fail.");
if (!MCP_API_KEY) console.warn("WARNING: MCP_API_KEY is not set — every request will be rejected.");

// ---------- Meta Graph API helpers ----------
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  url.searchParams.set("access_token", META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(
      `Meta API error${e.code ? ` ${e.code}` : ""}${e.error_subcode ? `/${e.error_subcode}` : ""}: ${e.message || res.statusText}`
    );
  }
  return json;
}

// Follows paging.next until done (or MAX_ROWS reached).
async function graphGetAll(path, params = {}) {
  let json = await graphGet(path, { limit: 200, ...params });
  const rows = [...(json.data || [])];
  let next = json.paging?.next;
  while (next && rows.length < MAX_ROWS) {
    const res = await fetch(next);
    json = await res.json().catch(() => ({}));
    if (json.error) throw new Error(`Meta API error ${json.error.code}: ${json.error.message}`);
    rows.push(...(json.data || []));
    next = json.paging?.next;
  }
  return { rows, truncated: Boolean(next) };
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const money = (minorUnits) => (minorUnits === undefined || minorUnits === null ? null : Number(minorUnits) / 100);
const actId = (id) => (String(id).startsWith("act_") ? String(id) : `act_${id}`);

// Pull a number out of Meta's actions-style arrays, preferring the omni_ version.
function pick(list, ...types) {
  if (!Array.isArray(list)) return null;
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t);
    if (hit && hit.value !== undefined) return Number(hit.value);
  }
  return null;
}

// Extract primary text / headline / thumbnail from the many creative shapes Meta uses.
function creativeSummary(c) {
  if (!c) return { creative_id: null, primary_text: null, headline: null, description: null, thumbnail_url: null, image_url: null, video_id: null };
  const oss = c.object_story_spec || {};
  const link = oss.link_data || {};
  const video = oss.video_data || {};
  const afs = c.asset_feed_spec || {};
  return {
    creative_id: c.id || null,
    creative_name: c.name || null,
    primary_text: c.body || link.message || video.message || afs.bodies?.[0]?.text || null,
    headline: c.title || link.name || video.title || afs.titles?.[0]?.text || null,
    description: link.description || video.link_description || afs.descriptions?.[0]?.text || null,
    call_to_action: link.call_to_action?.type || video.call_to_action?.type || afs.call_to_action_types?.[0] || null,
    thumbnail_url: c.thumbnail_url || null,
    image_url: c.image_url || link.picture || null,
    video_id: video.video_id || afs.videos?.[0]?.video_id || null,
    link_url: link.link || video.call_to_action?.value?.link || afs.link_urls?.[0]?.website_url || null,
  };
}

// ---------- Insights ----------
const INSIGHT_FIELDS = [
  "date_start", "date_stop", "account_id", "account_name", "campaign_id", "campaign_name",
  "adset_id", "adset_name", "ad_id", "ad_name", "objective",
  "spend", "impressions", "reach", "frequency", "cpm",
  "inline_link_clicks", "inline_link_click_ctr", "cost_per_inline_link_click",
  "clicks", "ctr", "cpc",
  "actions", "action_values", "cost_per_action_type", "purchase_roas",
  "video_play_actions", "video_p25_watched_actions", "video_p50_watched_actions",
  "video_p75_watched_actions", "video_p100_watched_actions", "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
].join(",");

function shapeInsightRow(r) {
  const spend = num(r.spend) ?? 0;
  const impressions = num(r.impressions) ?? 0;
  const linkClicks = num(r.inline_link_clicks);
  const purchases = pick(r.actions, "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase");
  const purchaseValue = pick(r.action_values, "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase");
  const costPerPurchase =
    pick(r.cost_per_action_type, "omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase") ??
    (purchases ? spend / purchases : null);
  const roas = pick(r.purchase_roas, "omni_purchase", "purchase") ?? (purchaseValue && spend ? purchaseValue / spend : null);

  const videoPlays = pick(r.video_play_actions, "video_view");
  const views3s = pick(r.actions, "video_view"); // "video_view" in actions = 3-second video views
  const p25 = pick(r.video_p25_watched_actions, "video_view");
  const p50 = pick(r.video_p50_watched_actions, "video_view");
  const p75 = pick(r.video_p75_watched_actions, "video_view");
  const p100 = pick(r.video_p100_watched_actions, "video_view");
  const thruplays = pick(r.video_thruplay_watched_actions, "video_view");
  const avgWatch = pick(r.video_avg_time_watched_actions, "video_view");

  const row = {
    date_start: r.date_start,
    date_stop: r.date_stop,
    account_id: r.account_id ?? null,
    account_name: r.account_name ?? null,
    campaign_id: r.campaign_id ?? null,
    campaign_name: r.campaign_name ?? null,
    adset_id: r.adset_id ?? null,
    adset_name: r.adset_name ?? null,
    ad_id: r.ad_id ?? null,
    ad_name: r.ad_name ?? null,
    objective: r.objective ?? null,

    spend,
    impressions,
    reach: num(r.reach),
    frequency: num(r.frequency),
    cpm: num(r.cpm),

    link_clicks: linkClicks,
    link_ctr_pct: num(r.inline_link_click_ctr),
    link_cpc: num(r.cost_per_inline_link_click),
    all_clicks: num(r.clicks),
    all_ctr_pct: num(r.ctr),

    landing_page_views: pick(r.actions, "omni_landing_page_view", "landing_page_view"),
    add_to_carts: pick(r.actions, "omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"),
    checkouts_initiated: pick(r.actions, "omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"),

    purchases,
    purchase_value: purchaseValue,
    cost_per_purchase: costPerPurchase,
    roas,

    video_plays: videoPlays,
    video_3s_views: views3s,
    video_p25_views: p25,
    video_p50_views: p50,
    video_p75_views: p75,
    video_p100_views: p100,
    thruplays: thruplays,
    video_avg_watch_seconds: avgWatch,
    // Handy ratios for judging a VSL: hook = 3s views / impressions, hold = thruplay / 3s views
    hook_rate_pct: views3s !== null && impressions ? +((views3s / impressions) * 100).toFixed(2) : null,
    hold_rate_pct: views3s && thruplays !== null ? +((thruplays / views3s) * 100).toFixed(2) : null,
    p100_of_plays_pct: videoPlays && p100 !== null ? +((p100 / videoPlays) * 100).toFixed(2) : null,
  };

  // Carry breakdown columns through (age, gender, country, publisher_platform, ...).
  for (const k of ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform", "impression_device"]) {
    if (r[k] !== undefined) row[k] = r[k];
  }
  return row;
}

// ---------- MCP server ----------
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message || err) }] });

function buildServer() {
  const server = new McpServer({ name: "meta-ads-readonly", version: "1.0.0" });

  server.registerTool(
    "list_ad_accounts",
    {
      title: "List ad accounts",
      description: "Lists every Meta ad account the server's token can see: id, name, currency, time zone, status.",
      inputSchema: {},
    },
    async () => {
      try {
        const { rows } = await graphGetAll("me/adaccounts", {
          fields: "id,account_id,name,currency,timezone_name,account_status,amount_spent,business_name",
        });
        const statusNames = { 1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED" };
        return ok(
          rows.map((a) => ({
            id: a.id,
            account_id: a.account_id,
            name: a.name,
            currency: a.currency,
            timezone: a.timezone_name,
            status: statusNames[a.account_status] || a.account_status,
            business_name: a.business_name ?? null,
            lifetime_spend: money(a.amount_spent),
          }))
        );
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "Lists campaigns in an ad account: id, name, status, objective, daily/lifetime budget (in account currency), whether it uses CBO (campaign budget).",
      inputSchema: {
        account_id: z.string().describe("Ad account id, with or without the act_ prefix, e.g. act_123456789"),
        status: z.enum(["ACTIVE", "PAUSED", "ALL"]).optional().describe("Filter by effective status. Default ALL."),
      },
    },
    async ({ account_id, status }) => {
      try {
        const params = {
          fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,buying_type,start_time,stop_time,created_time,updated_time",
        };
        if (status && status !== "ALL") params.effective_status = [status];
        const { rows, truncated } = await graphGetAll(`${actId(account_id)}/campaigns`, params);
        return ok({
          count: rows.length,
          truncated,
          campaigns: rows.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            effective_status: c.effective_status,
            objective: c.objective,
            is_cbo: Boolean(c.daily_budget || c.lifetime_budget),
            daily_budget: money(c.daily_budget),
            lifetime_budget: money(c.lifetime_budget),
            budget_remaining: money(c.budget_remaining),
            bid_strategy: c.bid_strategy ?? null,
            buying_type: c.buying_type ?? null,
            start_time: c.start_time ?? null,
            stop_time: c.stop_time ?? null,
            created_time: c.created_time,
            updated_time: c.updated_time,
          })),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "list_adsets",
    {
      title: "List ad sets",
      description: "Lists ad sets inside a campaign: id, name, status, budget (if not CBO), optimisation goal, schedule.",
      inputSchema: {
        campaign_id: z.string().describe("Campaign id"),
        status: z.enum(["ACTIVE", "PAUSED", "ALL"]).optional().describe("Filter by effective status. Default ALL."),
      },
    },
    async ({ campaign_id, status }) => {
      try {
        const params = {
          fields: "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,start_time,end_time,created_time,updated_time",
        };
        if (status && status !== "ALL") params.effective_status = [status];
        const { rows, truncated } = await graphGetAll(`${campaign_id}/adsets`, params);
        return ok({
          count: rows.length,
          truncated,
          adsets: rows.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            effective_status: s.effective_status,
            daily_budget: money(s.daily_budget),
            lifetime_budget: money(s.lifetime_budget),
            budget_remaining: money(s.budget_remaining),
            optimization_goal: s.optimization_goal ?? null,
            billing_event: s.billing_event ?? null,
            bid_strategy: s.bid_strategy ?? null,
            bid_amount: money(s.bid_amount),
            start_time: s.start_time ?? null,
            end_time: s.end_time ?? null,
            created_time: s.created_time,
            updated_time: s.updated_time,
          })),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "list_ads",
    {
      title: "List ads",
      description: "Lists ads inside an ad set: id, name, status, plus the creative's primary text, headline, thumbnail URL, link.",
      inputSchema: {
        adset_id: z.string().describe("Ad set id"),
        status: z.enum(["ACTIVE", "PAUSED", "ALL"]).optional().describe("Filter by effective status. Default ALL."),
      },
    },
    async ({ adset_id, status }) => {
      try {
        const params = {
          fields: "id,name,status,effective_status,created_time,updated_time,creative{id,name,title,body,thumbnail_url,image_url,object_story_spec,asset_feed_spec}",
        };
        if (status && status !== "ALL") params.effective_status = [status];
        const { rows, truncated } = await graphGetAll(`${adset_id}/ads`, params);
        return ok({
          count: rows.length,
          truncated,
          ads: rows.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            effective_status: a.effective_status,
            created_time: a.created_time,
            updated_time: a.updated_time,
            ...creativeSummary(a.creative),
          })),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "get_insights",
    {
      title: "Get insights (performance metrics)",
      description:
        "Performance metrics for an account, campaign, ad set or ad. Returns one row per object (or per day if daily=true, or per breakdown value). " +
        "Includes spend, impressions, reach, frequency, CPM, link clicks/CTR/CPC, landing page views, add to carts, checkouts, purchases, purchase value, cost per purchase, ROAS, " +
        "video plays, 3-second views, 25/50/75/100% views, ThruPlays, plus hook_rate_pct and hold_rate_pct. " +
        "Use either date_preset OR since+until (YYYY-MM-DD). Money is in the account currency.",
      inputSchema: {
        level: z.enum(["account", "campaign", "adset", "ad"]).describe("Granularity of the rows returned."),
        id: z.string().describe("The object to query: an account id (act_... or bare number), campaign id, adset id or ad id. Rows are returned at `level` within that object — e.g. id=a campaign + level=ad gives every ad in that campaign."),
        date_preset: z
          .enum(["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_week_mon_today", "last_week_mon_sun", "this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year", "maximum"])
          .optional()
          .describe("Preset date range. Ignored if since/until are given. Default last_7d."),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date YYYY-MM-DD (use with until)."),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (use with since)."),
        daily: z.boolean().optional().describe("If true, return one row per day (time_increment=1). Default false = one row for the whole range."),
        breakdown: z
          .enum(["age", "gender", "age,gender", "country", "region", "publisher_platform", "platform_position", "publisher_platform,platform_position", "device_platform", "impression_device"])
          .optional()
          .describe("Optional breakdown. Note: some video and conversion metrics are not available with certain breakdowns."),
        status_filter: z.enum(["ACTIVE", "ALL"]).optional().describe("ACTIVE = only objects currently delivering. Default ALL (anything with data in the range)."),
      },
    },
    async ({ level, id, date_preset, since, until, daily, breakdown, status_filter }) => {
      try {
        // For level=account the id must be an account, so add the act_ prefix if it's missing.
        // For other levels the id can be an account (act_...), a campaign, an ad set or an ad — used as given.
        const target = level === "account" ? actId(id) : String(id);
        const params = { level, fields: INSIGHT_FIELDS, limit: 500 };
        if (since && until) params.time_range = { since, until };
        else params.date_preset = date_preset || "last_7d";
        if (daily) params.time_increment = 1;
        if (breakdown) params.breakdowns = breakdown;
        if (status_filter === "ACTIVE") {
          const fieldByLevel = { account: null, campaign: "campaign.effective_status", adset: "adset.effective_status", ad: "ad.effective_status" };
          if (fieldByLevel[level]) params.filtering = [{ field: fieldByLevel[level], operator: "IN", value: ["ACTIVE"] }];
        }
        const { rows, truncated } = await graphGetAll(`${target}/insights`, params);
        return ok({
          level,
          id: target,
          date_range: since && until ? { since, until } : { date_preset: date_preset || "last_7d" },
          daily: Boolean(daily),
          breakdown: breakdown || null,
          row_count: rows.length,
          truncated,
          rows: rows.map(shapeInsightRow),
        });
      } catch (e) { return fail(e); }
    }
  );

  return server;
}

// ---------- HTTP layer ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

function checkApiKey(req, res, next) {
  const header = req.headers["authorization"] || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(MCP_API_KEY);
  const valid = MCP_API_KEY.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  if (!valid) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid API key" }, id: null });
  }
  next();
}

// Stateless MCP: a fresh server+transport per request, so Render can restart or scale freely.
app.post("/mcp", checkApiKey, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
app.get("/mcp", checkApiKey, (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST for this stateless MCP endpoint" }, id: null }));
app.delete("/mcp", checkApiKey, (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Sessions are not used" }, id: null }));

app.get("/health", (_req, res) => res.json({ ok: true, api_version: META_API_VERSION, token_set: Boolean(META_ACCESS_TOKEN), api_key_set: Boolean(MCP_API_KEY) }));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Meta Ads MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#222}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>Meta Ads MCP server</h1><p>Read-only Meta Ads data over MCP (streamable HTTP).</p>
<p>Endpoint: <code>POST /mcp</code> with header <code>Authorization: Bearer &lt;your key&gt;</code>.</p>
<p>Tools: <code>list_ad_accounts</code>, <code>list_campaigns</code>, <code>list_adsets</code>, <code>list_ads</code>, <code>get_insights</code>.</p>
<p>Status: Meta token ${META_ACCESS_TOKEN ? "set" : "<b>missing</b>"}, API key ${MCP_API_KEY ? "set" : "<b>missing</b>"}, Graph API ${META_API_VERSION}.</p>
</body></html>`);
});

app.listen(PORT, () => console.log(`Meta Ads MCP server listening on port ${PORT} (Graph API ${META_API_VERSION})`));
