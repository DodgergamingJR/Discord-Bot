const fs = require("fs");
const path = require("path");
const discord = require("discord.js");
const Client = discord.Client ?? discord.default?.Client;

const GatewayIntentBits = discord.GatewayIntentBits ?? null;
const IntentsFlags = discord.Intents && discord.Intents.FLAGS ? discord.Intents.FLAGS : null;

const MESSAGE_CONTENT_BIT = (GatewayIntentBits && GatewayIntentBits.MessageContent) ?? (IntentsFlags && IntentsFlags.MESSAGE_CONTENT) ?? (1 << 15);
const GUILDS_BIT = (GatewayIntentBits && GatewayIntentBits.Guilds) ?? (IntentsFlags && IntentsFlags.GUILDS) ?? (1 << 0);
const GUILD_MESSAGES_BIT = (GatewayIntentBits && GatewayIntentBits.GuildMessages) ?? (IntentsFlags && IntentsFlags.GUILD_MESSAGES) ?? (1 << 9);

const partialChannel = (discord.Partials && discord.Partials.Channel) || 'CHANNEL';

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
    };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    return {
      running: Boolean(state.running),
      startedAtMs: typeof state.startedAtMs === "number" ? state.startedAtMs : null,
      accumulatedMs: Number.isFinite(state.accumulatedMs) ? state.accumulatedMs : 0,
    };
  } catch {
    return {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
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
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (days > 0) {
    return `${days}d ${hh}:${mm}:${ss}`;
  }
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
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}

const client = new Client({
  intents: intentsArray,
  partials: [partialChannel]
});

let state = loadState();

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
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
      "`!timer start` - start from 00:00:00",
      "`!timer start 2d4h30m` - start as if it began that long ago",
      "`!timer startat 2026-06-25T12:00:00Z` - start from a specific past time",
      "`!timer stop` - pause timer",
      "`!timer resume` - continue after stop",
      "`!timer reset` - reset to 00:00:00 and stop",
    ].join("\n"));
    return;
  }

  if (command === "status") {
    const elapsed = getElapsedMs(state);
    await message.reply(`Timer: **${formatElapsed(elapsed)}** (${state.running ? "running" : "stopped"})`);
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
    };
    saveState(state);

    await message.reply(`Started timer at **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "startat") {
    const input = args.join(" ");
    if (!input) {
      await message.reply("Provide a date/time. Example: `!timer startat 2026-06-25T12:00:00Z`");
      return;
    }

    const startMs = parseDateToMs(input);
    if (startMs === null) {
      await message.reply("Could not parse that date/time. Use ISO format if possible.");
      return;
    }

    const now = Date.now();
    const elapsed = Math.max(0, now - startMs);

    state = {
      running: true,
      startedAtMs: now,
      accumulatedMs: elapsed,
    };
    saveState(state);

    await message.reply(`Started timer as if it began at **${new Date(startMs).toISOString()}**. Current: **${formatElapsed(getElapsedMs(state))}**.`);
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

    await message.reply(`Stopped at **${formatElapsed(state.accumulatedMs)}**.`);
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

    await message.reply(`Resumed at **${formatElapsed(getElapsedMs(state))}**.`);
    return;
  }

  if (command === "reset") {
    state = {
      running: false,
      startedAtMs: null,
      accumulatedMs: 0,
    };
    saveState(state);

    await message.reply("Timer reset to **00:00:00** (stopped).");
    return;
  }

  await message.reply("Unknown command. Use `!timer help`.");
});

client.login(TOKEN);
