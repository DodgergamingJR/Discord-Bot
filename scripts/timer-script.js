const fs = require("fs");
const path = require("path");
const discord = require("discord.js");
const Client = discord.Client ?? discord.default?.Client;

const GatewayIntentBits = discord.GatewayIntentBits ?? null;
const IntentsFlags = discord.Intents && discord.Intents.FLAGS ? discord.Intents.FLAGS : null;
const ActivityType = discord.ActivityType ?? null;

const MESSAGE_CONTENT_BIT = (GatewayIntentBits && GatewayIntentBits.MessageContent) ?? (IntentsFlags && IntentsFlags.MESSAGE_CONTENT) ?? (1 << 15);
const GUILDS_BIT = (GatewayIntentBits && GatewayIntentBits.Guilds) ?? (IntentsFlags && IntentsFlags.GUILDS) ?? (1 << 0);
const GUILD_MESSAGES_BIT = (GatewayIntentBits && GatewayIntentBits.GuildMessages) ?? (IntentsFlags && IntentsFlags.GUILD_MESSAGES) ?? (1 << 9);

const partialChannel = (discord.Partials && discord.Partials.Channel) || 'CHANNEL';
const WATCHING_ACTIVITY = (ActivityType && ActivityType.Watching) || "WATCHING";

const intentsArray = [
  GUILDS_BIT,
  GUILD_MESSAGES_BIT,
  MESSAGE_CONTENT_BIT
].filter(Boolean);

require("dotenv").config();

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!timer";
const STATE_FILE = path.join(__dirname, "..", "timer-state.json");

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
      timerName: null,
    };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    return {
      running: Boolean(state.running),
      startedAtMs: typeof state.startedAtMs === "number" ? state.startedAtMs : null,
      accumulatedMs: Number.isFinite(state.accumulatedMs) ? state.accumulatedMs : 0,
      timerName: typeof state.timerName === "string" && state.timerName.trim() ? state.timerName.trim() : null,
    };
  } catch {
    return {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
      timerName: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getElapsedMs(state) {
  if (!state.running || state.startedAtMs === null) {
    return Math.max(0, state.accumulatedMs);
  }
  return Math.max(0, state.accumulatedMs + (Date.now() - state.startedAtMs));
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  return `${hh}:${mm}:${ss}`;
}

function parseDurationToMs(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const normalized = input.trim().toLowerCase();
  const regex = /(\d+)\s*(d|h|m|s)/g;
  let match;
  let total = 0;
  let found = false;

  while ((match = regex.exec(normalized)) !== null) {
    found = true;
    const value = Number(match[1]);
    const unit = match[2];
    if (unit === "d") total += value * 24 * 60 * 60 * 1000;
    if (unit === "h") total += value * 60 * 60 * 1000;
    if (unit === "m") total += value * 60 * 1000;
    if (unit === "s") total += value * 1000;
  }

  // Ensure the whole string was valid duration tokens only.
  const cleaned = normalized.replace(regex, "").trim();
  if (!found || cleaned.length > 0) {
    return null;
  }

  return total;
}

function parseDateToMs(input) {
  const normalized = String(input || "").trim();

  // Supports: DD-MM-YYYY, DD/MM/YYYY, with optional HH:mm[:ss]
  const dmyMatch = normalized.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    const hour = dmyMatch[4] ? Number(dmyMatch[4]) : 0;
    const minute = dmyMatch[5] ? Number(dmyMatch[5]) : 0;
    const second = dmyMatch[6] ? Number(dmyMatch[6]) : 0;

    if (
      month < 1 || month > 12 ||
      day < 1 || day > 31 ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 ||
      second < 0 || second > 59
    ) {
      return null;
    }

    const date = new Date(year, month - 1, day, hour, minute, second);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute ||
      date.getSeconds() !== second
    ) {
      return null;
    }

    return date.getTime();
  }

  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}

function formatDateDMY(ms) {
  const date = new Date(ms);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss}`;
}

function sanitizeTimerName(input) {
  const value = String(input || "").trim();
  if (!value) {
    return null;
  }

  return value.slice(0, 60);
}

function getTimerDisplayName() {
  return state.timerName || "Timer";
}

const client = new Client({
  intents: intentsArray,
  partials: [partialChannel]
});

let state = loadState();
let presenceInterval = null;

async function updateTimerPresence() {
  if (!client.user) {
    return;
  }

  const timerLabel = getTimerDisplayName();
  const presenceText = state.running
    ? `${timerLabel} ${formatElapsed(getElapsedMs(state))}`
    : `${timerLabel} stopped`;

  try {
    await client.user.setPresence({
      activities: [{ name: presenceText, type: WATCHING_ACTIVITY }],
      status: "online",
    });
  } catch (error) {
    console.error("Failed to update timer presence:", error?.message || error);
  }
}

function startPresenceUpdates() {
  void updateTimerPresence();

  if (presenceInterval) {
    clearInterval(presenceInterval);
  }

  presenceInterval = setInterval(() => {
    void updateTimerPresence();
  }, 1000);

  if (typeof presenceInterval.unref === "function") {
    presenceInterval.unref();
  }
}

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  startPresenceUpdates();
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith(PREFIX)) return;

  const args = content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const command = (args.shift() || "status").toLowerCase();

  if (command === "help") {
    await message.reply([
      "**Timer commands**",
      "`!timer` or `!timer status` - show elapsed time",
      "`!timer name <map name>` - set timer/map name",
      "`!timer clearname` - clear timer/map name",
      "`!timer start` - start from 00:00:00",
      "`!timer start 2d4h30m` - start as if it began that long ago",
      "`!timer startat 25-06-2026 12:00:00` - start from a specific past time",
      "`!timer startat 25-06-2026 12:00:00 Origins` - startat and set name",
      "`!timer stop` - pause timer",
      "`!timer resume` - continue after stop",
      "`!timer reset` - reset to 00:00:00 and stop",
    ].join("\n"));
    return;
  }

  if (command === "status") {
    const elapsed = getElapsedMs(state);
    await message.reply(`${getTimerDisplayName()}: **${formatElapsed(elapsed)}** (${state.running ? "running" : "stopped"})`);
    return;
  }

  if (command === "name") {
    const newName = sanitizeTimerName(args.join(" "));
    if (!newName) {
      await message.reply("Provide a name. Example: `!timer name Kino Der Toten`");
      return;
    }

    state.timerName = newName;
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Timer name set to **${state.timerName}**.`);
    return;
  }

  if (command === "clearname") {
    state.timerName = null;
    saveState(state);
    await updateTimerPresence();

    await message.reply("Timer name cleared.");
    return;
  }

  if (command === "start") {
    const maybeDuration = args.join("");
    let initialMs = 0;

    if (maybeDuration) {
      const parsed = parseDurationToMs(maybeDuration);
      if (parsed === null) {
        await message.reply("Invalid duration. Example: `!timer start 2d4h30m10s`");
        return;
      }
      initialMs = parsed;
    }

    state = {
      running: true,
      startedAtMs: Date.now(),
      accumulatedMs: initialMs,
      timerName: state.timerName || null,
    };
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Started **${getTimerDisplayName()}** at **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "startat") {
    if (args.length === 0) {
      await message.reply("Provide a date/time. Example: `!timer startat 25-06-2026 12:00:00`");
      return;
    }

    const dateToken = args[0] || "";
    const maybeTimeToken = args[1] || "";
    const hasSeparateTimeToken = /^\d{1,2}:\d{1,2}(?::\d{1,2})?$/.test(maybeTimeToken);

    const input = hasSeparateTimeToken ? `${dateToken} ${maybeTimeToken}` : dateToken;
    const providedName = sanitizeTimerName(args.slice(hasSeparateTimeToken ? 2 : 1).join(" "));

    const startMs = parseDateToMs(input);
    if (startMs === null) {
      await message.reply("Could not parse that date/time. Use `DD-MM-YYYY` with optional `HH:mm:ss`.");
      return;
    }

    const now = Date.now();
    const elapsed = Math.max(0, now - startMs);

    state = {
      running: true,
      startedAtMs: now,
      accumulatedMs: elapsed,
      timerName: providedName || state.timerName || null,
    };
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Started **${getTimerDisplayName()}** as if it began at **${formatDateDMY(startMs)}**. Current: **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "stop") {
    if (!state.running || state.startedAtMs === null) {
      await message.reply("Timer is already stopped.");
      return;
    }

    state.accumulatedMs = getElapsedMs(state);
    state.running = false;
    state.startedAtMs = null;
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Stopped **${getTimerDisplayName()}** at **${formatElapsed(state.accumulatedMs)}**.`);
    return;
  }

  if (command === "resume") {
    if (state.running) {
      await message.reply("Timer is already running.");
      return;
    }

    state.running = true;
    state.startedAtMs = Date.now();
    saveState(state);
    await updateTimerPresence();

    await message.reply(`Resumed **${getTimerDisplayName()}** at **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "reset") {
    state = {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
      timerName: state.timerName || null,
    };
    saveState(state);
    await updateTimerPresence();

    await message.reply(`${getTimerDisplayName()} reset to **00:00:00** (stopped).`);
    return;
  }

  await message.reply("Unknown command. Use `!timer help`.");
});

client.login(TOKEN);
