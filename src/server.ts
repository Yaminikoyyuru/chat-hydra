import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import tmi from "tmi.js";
import { config } from "./config.js";

type Settings = {
  bossName: string; bossEmoji: string; maxHP: number;
  damage: { normal: number; bonus: number; attack: number };
  tauntLines: string[];
};
type DamageEvent = { username: string; message: string; timestamp: string; damage: number; currentHP: number; source: string };
type Boss = { name: string; emoji: string; maxHP: number; currentHP: number; phase: "idle" | "fighting" | "defeated"; damageLog: DamageEvent[] };
type Leader = { username: string; damage: number };

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ server });
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const settingsPath = path.join(root, "settings.json");
const port = Number(process.env.PORT || 3000);
const mock = process.env.MOCK?.toLowerCase() === "true";
const defaults: Settings = {
  bossName: config.bossName, bossEmoji: config.bossEmoji, maxHP: config.startingMaxHP,
  damage: { ...config.damage }, tauntLines: [...config.defaultTaunts]
};
let settings: Settings;
try { settings = { ...defaults, ...JSON.parse(readFileSync(settingsPath, "utf8")) }; }
catch { settings = defaults; }

app.use(express.json());
app.use(express.static(path.resolve(here, "../public")));
let boss: Boss = { name: settings.bossName, emoji: settings.bossEmoji, maxHP: settings.maxHP, currentHP: settings.maxHP, phase: "idle", damageLog: [] };
let bossLevel = 1;
let taunt = "";
let tauntUntil = 0;
let stunnedUntil = 0;
let powerUpUntil = 0;
let summary: { lastHit: string; mvp: string; leaderboard: Leader[] } | null = null;
let lastHit = "";
const viewerDamage = new Map<string, number>();
const attackTimes = new Map<string, number>();
let oauthState = "";
let broadcasterId = "";
let broadcasterLogin = "";
let eventSubSocket: WebSocket | null = null;
let eventSubConnected = false;

function send(type: string, payload: Record<string, unknown>) {
  const data = JSON.stringify({ type, ...payload });
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.send(data);
}
function leaders(): Leader[] {
  return [...viewerDamage].map(([username, damage]) => ({ username, damage }))
    .sort((a, b) => b.damage - a.damage).slice(0, 5);
}
function broadcastState() {
  send("state", { state: {
    ...boss, leaderboard: leaders(), lastHit, summary, taunt, tauntUntil, stunnedUntil, powerUpUntil,
    mock, eventSubConnected, streamer: broadcasterLogin
  } });
}
function setTaunt(text: string) {
  taunt = text;
  tauntUntil = Date.now() + config.tauntDurationMs;
  const expected = tauntUntil;
  setTimeout(() => { if (tauntUntil === expected) { taunt = ""; broadcastState(); } }, config.tauntDurationMs);
}
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "state", state: {
    ...boss, leaderboard: leaders(), lastHit, summary, taunt, tauntUntil, stunnedUntil, powerUpUntil,
    mock, eventSubConnected, streamer: broadcasterLogin
  } }));
  send("connections", { count: sockets.clients.size });
  socket.on("close", () => send("connections", { count: sockets.clients.size }));
});

function defeat() {
  boss.phase = "defeated";
  const top = leaders();
  summary = { lastHit: lastHit || "Chat", mvp: top[0]?.username || lastHit || "Chat", leaderboard: top };
  broadcastState();
  setTimeout(() => { summary = null; broadcastState(); }, config.summaryDurationMs);
  setTimeout(() => {
    bossLevel++;
    boss = { name: settings.bossName, emoji: settings.bossEmoji, maxHP: settings.maxHP + (bossLevel - 1) * config.respawnHPIncrease,
      currentHP: settings.maxHP + (bossLevel - 1) * config.respawnHPIncrease, phase: "idle", damageLog: [] };
    viewerDamage.clear();
    lastHit = "";
    broadcastState();
  }, config.respawnDelayMs);
}

function hitBoss(username: string, message: string, amount: number, source = "chat", credit = true, eventTaunt?: string) {
  if (boss.phase === "defeated" || amount <= 0) return;
  const damage = Math.min(amount, boss.currentHP);
  boss.phase = "fighting";
  boss.currentHP = Math.max(0, boss.currentHP - damage);
  lastHit = username;
  if (credit && username !== "Streamer") {
    viewerDamage.set(username, (viewerDamage.get(username) || 0) + damage);
  }
  const event: DamageEvent = { username, message, timestamp: new Date().toISOString(), damage, currentHP: boss.currentHP, source };
  boss.damageLog = [...boss.damageLog, event].slice(-config.damageLogLimit);
  setTaunt(eventTaunt || settings.tauntLines[Math.floor(Math.random() * settings.tauntLines.length)] || "The chat attacks!");
  send("damage", { event });
  if (boss.currentHP === 0) defeat(); else broadcastState();
}

function chatDamage(username: string, message: string, hasEmotes = false) {
  if (boss.phase === "defeated") return;
  const now = Date.now();
  const attack = message.toLowerCase().startsWith("!attack");
  let amount = settings.damage.normal;
  if (attack) {
    const key = username.toLowerCase();
    if (now - (attackTimes.get(key) || 0) < config.attackCooldownMs) return;
    attackTimes.set(key, now);
    amount = settings.damage.attack;
  } else {
    const letters = message.replace(/[^a-z]/gi, "");
    if (hasEmotes || (letters.length > 0 && letters === letters.toUpperCase())) amount = settings.damage.bonus;
  }
  if (now < stunnedUntil) amount *= 2;
  if (now < powerUpUntil) amount *= 2;
  hitBoss(username, message, amount);
}

function streamerAction(action: string) {
  if (boss.phase === "defeated") return;
  if (action === "died") {
    const healed = Math.round(boss.maxHP * config.streamerDeathHeal);
    boss.currentHP = Math.min(boss.maxHP, boss.currentHP + healed);
    boss.phase = "fighting";
    setTaunt("Streamer fell! Boss heals!");
    send("action", { action, amount: healed });
    broadcastState();
  } else if (action === "won") {
    hitBoss("Streamer", "Streamer wins a round", Math.max(1, Math.round(boss.maxHP * config.streamerRoundDamage)), "streamer", false, "Streamer strikes back!");
  } else if (action === "clutch") {
    stunnedUntil = Date.now() + config.clutchDurationMs;
    const expected = stunnedUntil;
    setTaunt("CLUTCH! Boss stunned!");
    send("action", { action, until: stunnedUntil });
    broadcastState();
    setTimeout(() => { if (stunnedUntil === expected) { stunnedUntil = 0; broadcastState(); } }, config.clutchDurationMs);
  }
}

function powerUp(username: string) {
  powerUpUntil = Math.max(powerUpUntil, Date.now()) + config.powerUpDurationMs;
  setTaunt("Power-up! Chat damage doubled!");
  send("effect", { effect: "power-up", username, until: powerUpUntil });
  broadcastState();
  const expected = powerUpUntil;
  setTimeout(() => { if (powerUpUntil === expected) { powerUpUntil = 0; broadcastState(); } }, config.powerUpDurationMs);
}

function twitchEvent(type: string, event: Record<string, any>) {
  if (type === "channel.raid") {
    const viewers = Math.max(1, Number(event.viewers) || 1);
    hitBoss(event.from_broadcaster_user_name || "Raiders", `Raid of ${viewers}`, Math.max(1, Math.round(boss.maxHP * config.raidDamagePerViewer * viewers)), "raid", true, `Mega damage wave! ${viewers} raiders joined!`);
  } else if (type === "channel.subscribe" || type === "channel.subscription.message") {
    powerUp(event.user_name || "New subscriber");
  } else if (type === "channel.subscription.gift") {
    const count = Math.max(1, Number(event.total) || 1);
    hitBoss(event.user_name || "Anonymous gifter", `Gifted ${count} subs`, Math.max(1, Math.round(boss.maxHP * config.giftDamagePerSub * count)), "gift", true, "Meteor strike!");
  } else if (type === "channel.cheer") {
    hitBoss(event.user_name || "Anonymous cheerer", `${event.bits} bits`, Number(event.bits) / config.bitsPerDamage, "cheer", true, `Bit blast! ${event.bits} bits!`);
  }
}

app.get("/api/settings", (_req, res) => res.json(settings));
app.get("/api/status", (_req, res) => res.json({ mock, eventSubConnected, streamer: broadcasterLogin, websocketClients: sockets.clients.size }));
app.put("/api/settings", async (req, res) => {
  const body = req.body || {};
  const maxHP = Math.max(10, Math.min(100_000, Math.round(Number(body.maxHP) || settings.maxHP)));
  const next: Settings = {
    bossName: String(body.bossName || defaults.bossName).slice(0, 50),
    bossEmoji: Array.from(String(body.bossEmoji || defaults.bossEmoji).trim())[0] || defaults.bossEmoji,
    maxHP,
    damage: {
      normal: Math.max(0.1, Number(body.damage?.normal) || defaults.damage.normal),
      bonus: Math.max(0.1, Number(body.damage?.bonus) || defaults.damage.bonus),
      attack: Math.max(0.1, Number(body.damage?.attack) || defaults.damage.attack)
    },
    tauntLines: (Array.isArray(body.tauntLines) ? body.tauntLines : defaults.tauntLines).map(String).map((line: string) => line.trim()).filter(Boolean).slice(0, 20)
  };
  if (!next.tauntLines.length) next.tauntLines = [...defaults.tauntLines];
  const ratio = boss.maxHP ? boss.currentHP / boss.maxHP : 1;
  settings = next;
  boss.name = settings.bossName;
  boss.emoji = settings.bossEmoji;
  if (boss.phase !== "defeated") { boss.maxHP = settings.maxHP; boss.currentHP = Math.round(settings.maxHP * ratio); }
  try { await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`); }
  catch (error) { console.error("Could not save settings:", error); return res.status(500).json({ error: "Could not save settings.json" }); }
  broadcastState();
  res.json(settings);
});
app.post("/api/action", (req, res) => {
  const action = String(req.body?.action || "");
  if (!["died", "won", "clutch"].includes(action)) return res.status(400).json({ error: "Unknown action" });
  streamerAction(action);
  res.json({ ok: true });
});
app.post("/api/mock-command", (req, res) => {
  if (!mock) return res.status(403).json({ error: "Enable MOCK=true to simulate broadcaster chat commands." });
  const action = String(req.body?.action || "");
  if (!["died", "won", "clutch"].includes(action)) return res.status(400).json({ error: "Unknown action" });
  publish("MockStreamer", `!${action}`, false, true);
  res.json({ ok: true });
});
app.post("/api/mock-event", (req, res) => {
  if (!mock) return res.status(403).json({ error: "Enable MOCK=true to simulate Twitch events." });
  const { event, count = 1 } = req.body || {};
  if (event === "raid") twitchEvent("channel.raid", { viewers: count, from_broadcaster_user_name: "MockRaidParty" });
  else if (event === "sub") twitchEvent("channel.subscribe", { user_name: "MockSubscriber" });
  else if (event === "gift") twitchEvent("channel.subscription.gift", { user_name: "MockGifter", total: count });
  else if (event === "bits") twitchEvent("channel.cheer", { user_name: "MockCheerer", bits: count });
  else return res.status(400).json({ error: "Unknown event" });
  res.json({ ok: true });
});

const redirectUri = process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
app.get("/auth/twitch", (_req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (mock) return res.status(400).send("Set MOCK=false to connect Twitch EventSub.");
  if (!clientId || !process.env.TWITCH_CLIENT_SECRET) return res.status(400).send("Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env first.");
  oauthState = randomBytes(18).toString("hex");
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "bits:read channel:read:subscriptions", state: oauthState }).toString();
  res.redirect(url.toString());
});
app.get("/auth/callback", async (req, res) => {
  if (!req.query.code || req.query.state !== oauthState) return res.status(400).send("Twitch sign-in state did not match. Start again from the control panel.");
  try {
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID || "", client_secret: process.env.TWITCH_CLIENT_SECRET || "", code: String(req.query.code), grant_type: "authorization_code", redirect_uri: redirectUri }) });
    const tokenData = await tokenResponse.json() as { access_token?: string; message?: string };
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.message || "Token exchange failed");
    const channel = process.env.TWITCH_CHANNEL?.replace(/^#/, "");
    if (!channel) throw new Error("Set TWITCH_CHANNEL in .env.");
    const validation = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${tokenData.access_token}` } });
    const identity = await validation.json() as { login?: string };
    if (!validation.ok || identity.login?.toLowerCase() !== channel.toLowerCase()) throw new Error("Authorize with the broadcaster account named by TWITCH_CHANNEL.");
    const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`, { headers: { "Client-Id": process.env.TWITCH_CLIENT_ID || "", Authorization: `Bearer ${tokenData.access_token}` } });
    const userData = await userResponse.json() as { data?: Array<{ id: string; login: string }> };
    if (!userResponse.ok || !userData.data?.[0]) throw new Error("Could not find TWITCH_CHANNEL on Twitch.");
    broadcasterId = userData.data[0].id;
    broadcasterLogin = userData.data[0].login;
    void connectEventSub(tokenData.access_token, broadcasterId);
    res.redirect("/control.html?connected=1");
  } catch (error) {
    console.error("Twitch OAuth failed:", error);
    res.status(500).send("Twitch connection failed. Check the terminal and app settings.");
  }
});

async function subscribeEvent(sessionId: string, token: string, type: string, condition: Record<string, string>) {
  const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", { method: "POST", headers: {
    "Client-Id": process.env.TWITCH_CLIENT_ID || "", Authorization: `Bearer ${token}`, "Content-Type": "application/json"
  }, body: JSON.stringify({ type, version: "1", condition, transport: { method: "websocket", session_id: sessionId } }) });
  if (!response.ok) console.error(`EventSub ${type} subscribe failed (${response.status}):`, await response.text());
}
async function connectEventSub(token: string, channelId: string, url = "wss://eventsub.wss.twitch.tv/ws", subscribe = true) {
  const socket = new WebSocket(url);
  eventSubSocket = socket;
  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    const meta = message.metadata || {};
    if (meta.message_type === "session_welcome") {
      eventSubConnected = true;
      broadcastState();
      if (subscribe) {
        const sessionId = message.payload.session.id;
        const condition = { broadcaster_user_id: channelId };
        await Promise.all([
          subscribeEvent(sessionId, token, "channel.subscribe", condition),
          subscribeEvent(sessionId, token, "channel.subscription.message", condition),
          subscribeEvent(sessionId, token, "channel.subscription.gift", condition),
          subscribeEvent(sessionId, token, "channel.cheer", condition),
          subscribeEvent(sessionId, token, "channel.raid", { to_broadcaster_user_id: channelId })
        ]);
      }
    } else if (meta.message_type === "session_reconnect") {
      void connectEventSub(token, channelId, message.payload.session.reconnect_url, false);
    } else if (meta.message_type === "notification") {
      twitchEvent(message.payload.subscription.type, message.payload.event);
    }
  });
  socket.on("close", () => { if (eventSubSocket === socket) { eventSubConnected = false; broadcastState(); } });
  socket.on("error", (error) => console.error("EventSub socket error:", error.message));
}

function publish(username: string, message: string, hasEmotes = false, broadcaster = false) {
  console.log(`[${username}] ${message}`);
  send("chat", { message: { username, message, timestamp: new Date().toISOString() } });
  const command = message.toLowerCase().trim();
  if (broadcaster && ["!died", "!won", "!clutch"].includes(command)) streamerAction(command.slice(1));
  else chatDamage(username, message, hasEmotes);
}

if (mock) {
  const samples = [
    ["PixelPaladin", "bonk!", false], ["MoonMoth", "Kappa attack!", true], ["SnackWizard", "BOSS TAKE THIS", false],
    ["tinyhealer", "shield up", false], ["PixelPaladin", "!attack hydra", false], ["MoonMoth", "HYDRA SMASH", false]
  ] as const;
  let sampleIndex = 0;
  console.log("Mock mode: chat and control panel events are enabled; no Twitch connection needed.");
  setInterval(() => { const [username, message, emotes] = samples[sampleIndex++ % samples.length]; publish(username, message, emotes); }, config.mockIntervalMs);
} else {
  const channel = process.env.TWITCH_CHANNEL?.replace(/^#/, "");
  if (!channel) throw new Error("Set TWITCH_CHANNEL in .env or enable MOCK=true.");
  const chat = new tmi.Client({ channels: [channel] });
  chat.on("message", (_channel, tags, message, self) => {
    if (!self) publish(tags["display-name"] || tags.username || "viewer", message,
      Boolean(tags.emotes && Object.keys(tags.emotes).length), Boolean(tags.badges?.broadcaster) || tags.username?.toLowerCase() === channel.toLowerCase());
  });
  chat.connect().catch((error: unknown) => console.error("Twitch chat connection failed:", error));
}

server.listen(port, () => {
  console.log(`Boss Battle is live at http://localhost:${port}`);
  console.log(`Overlay: http://localhost:${port}/overlay.html | Controls: http://localhost:${port}/control.html`);
});
